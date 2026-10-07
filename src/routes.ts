/**
 * 宿主 HTTP API —— client 半边与宿主之间的**唯一通道**（技术方案 §7.10 / §7.11）。
 *
 * 为什么是 HTTP 而不是 `host.call`：P0 取证确认包式 client 半的
 * `factory(require)` **只收到 `require`**，`host.call` 属于动态 client 半
 * （见 contract-notes §3.2）。工作参照是 dshmarket 的 `/dsh-market/*`。
 *
 * 安全/健壮性约定：
 *   1. **只接受环回来源**：这是本机能力，不做鉴权但也不对外暴露（`guard`）。
 *   2. **路径严格限定在数据目录内**：图片路由只服务 `projects/<id>/images/`。
 *   3. **任何异常都转成明确的 4xx/5xx**：不留未处理的 rejection。
 *   4. **只有 POST 能写**：GET 一律只读，命中写路由直接 405。
 *      注意"写路由"是按**语义**分的：`POST /providers/<id>/refresh-models` 虽然
 *      是 POST（要带密钥去探测），但**不写配置**——拉取与选择是两件事，见该函数的注释。
 *   5. **任何响应体都不含 apiKey**：厂商一律回脱敏后的 `ProviderView`。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import {
  defaultConfig,
  findProvider,
  toProviderView,
  type PixmartConfig,
  type ProviderConfig,
} from './config.js'
import {
  PROVIDER_CATALOG,
  catalogView,
  findCatalogEntry,
  providerFromCatalog,
  providerFromCustom,
} from './catalog.js'
import { historicalTotals } from './store/historical.js'
import { assertContained } from './store/paths.js'
import { TrashError, type ProjectSummaryWithModules } from './store/project-store.js'
import { exportImages, planProjectExport, resolveExportRoot } from './tools/export-output.js'
import { fetchProviderModels, type ModelProbeCode } from './vendor/models.js'
import type { HostContext, HttpResponseLike, HttpRequestLike, WebServerLike } from './host-types.js'
import type { ToolRuntime } from './tools/runtime.js'

const API_PREFIX = '/pixmart/api'
const FILE_PREFIX = '/pixmart/file'

/** 只允许本机来源。 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** 写请求体上限：设置页只发小 JSON，64KB 已经绰绰有余。 */
const MAX_BODY_BYTES = 64 * 1024

function isLoopback(request: HttpRequestLike): boolean {
  const address = request.socket?.remoteAddress ?? ''
  return LOOPBACK.has(address)
}

function sendJson(response: HttpResponseLike, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body, 'utf8')),
  })
  response.end(body)
}

function sendEmpty(response: HttpResponseLike, status: number): void {
  response.writeHead(status, { 'cache-control': 'no-store' })
  response.end()
}

function fail(
  response: HttpResponseLike,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(response, status, { ok: false, error: { code, message } })
}

// ───────────────────────────────────────────────────────── 请求体

/** 读体失败：带 HTTP 状态码，交给 guard 直接回给客户端。 */
class BodyError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function chunkToText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8')
  return ''
}

/**
 * 读完整请求体并解析为 JSON。
 *
 * - 超过 64KB → 413（不继续累积，避免内存被慢慢填满）；
 * - 不是合法 JSON → 400；
 * - 空体 → `{}`（`POST /cancel` 这类无参写操作不必带 body）。
 */
function readJsonBody(request: HttpRequestLike): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = []
    let bytes = 0
    let settled = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }

    try {
      request.on('data', (chunk?: unknown) => {
        if (settled) return
        const piece = chunkToText(chunk)
        bytes += Buffer.byteLength(piece, 'utf8')
        // 先判上限再入队：不把超限的内容留在内存里。
        if (bytes > MAX_BODY_BYTES) {
          finish(() =>
            reject(new BodyError(413, 'body_too_large', `请求体超过 ${String(MAX_BODY_BYTES)} 字节`)),
          )
          return
        }
        chunks.push(piece)
      })

      request.on('end', () => {
        finish(() => {
          const trimmed = chunks.join('').trim()
          if (trimmed === '') {
            resolve({})
            return
          }
          let parsed: unknown
          try {
            parsed = JSON.parse(trimmed)
          } catch {
            reject(new BodyError(400, 'bad_json', '请求体不是合法 JSON'))
            return
          }
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            reject(new BodyError(400, 'bad_json', '请求体必须是 JSON 对象'))
            return
          }
          resolve(parsed as Record<string, unknown>)
        })
      })

      // 连接中断 / 客户端提前断开：没有这个监听，promise 会永远挂着。
      request.on('error', (error?: unknown) => {
        finish(() =>
          reject(
            new BodyError(
              400,
              'body_aborted',
              `读取请求体失败：${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        )
      })
    } catch (error) {
      finish(() =>
        reject(
          new BodyError(
            400,
            'bad_request',
            `无法读取请求体：${error instanceof Error ? error.message : String(error)}`,
          ),
        ),
      )
    }
  })
}

/** 写路由统一走这里读体：GET 不带体，直接给空对象。 */
type BodyReader = () => Promise<Record<string, unknown>>

const noBody: BodyReader = async () => ({})

// ───────────────────────────────────────────────────────── 小工具

function contentTypeFor(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return 'application/octet-stream'
}

/** 安全的字符白名单：项目 id 与文件名都来自我们自己的命名规则。 */
const SAFE_SEGMENT = /^[\p{L}\p{N}._-]+$/u

/**
 * 项目 / 回收站条目的 id 白名单（新增的写路由用）。
 *
 * 比 `SAFE_SEGMENT` 多一条：**不得以点开头**。理由是回收站目录叫 `.trash`，
 * 它自己绝不能当"项目"或"回收站条目"被删/恢复；`..` 也在这一条里被挡住。
 */
const SAFE_ID = /^[\p{L}\p{N}_-][\p{L}\p{N}._-]*$/u

function isSafeId(value: string): boolean {
  return SAFE_ID.test(value) && !value.startsWith('.')
}

function readLimit(query: URLSearchParams, fallback: number, max = 200): number {
  const raw = Number(query.get('limit'))
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return Math.min(Math.floor(raw), max)
}

/** 分页起点：非法/缺省/负数一律当 0（不是错误，只是"第一页"）。 */
function readOffset(query: URLSearchParams): number {
  const raw = Number(query.get('offset'))
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.floor(raw)
}

/** 项目名排序用的比较器。显式给 locale，避免随进程 locale 变。 */
const projectNameCollator = new Intl.Collator(['zh-Hans-CN', 'zh', 'en'], {
  numeric: true,
  sensitivity: 'base',
})

/**
 * 作品库列表的四种排序。
 *
 * 每一种都带**并列时的兜底**（先按创建时间倒序，再按 id）：没有兜底的话，
 * 同分项目的相对顺序取决于 `Array.sort` 的稳定性与目录扫描顺序，
 * 分页时同一条记录可能在两页里各出现一次、也可能一次都不出现。
 */
const PROJECT_SORTS: Record<
  string,
  (a: ProjectSummaryWithModules, b: ProjectSummaryWithModules) => number
> = {
  'createdAt:desc': (a, b) => b.createdAt - a.createdAt || compareId(a, b),
  'createdAt:asc': (a, b) => a.createdAt - b.createdAt || compareId(a, b),
  'name:asc': (a, b) =>
    projectNameCollator.compare(a.name, b.name) || b.createdAt - a.createdAt || compareId(a, b),
  'images:desc': (a, b) =>
    b.imageCount - a.imageCount || b.createdAt - a.createdAt || compareId(a, b),
}

const DEFAULT_PROJECT_SORT = 'createdAt:desc'

function compareId(a: ProjectSummaryWithModules, b: ProjectSummaryWithModules): number {
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

const PROJECT_SORT_KEYS = Object.keys(PROJECT_SORTS).join(' / ')

/**
 * 搜索命中：**项目名 或 模块名**，大小写不敏感的子串。
 *
 * 模块名同时含标识（`main.white-bg`）与显示名（`白底主图`）——用户的两种说法都要能搜到。
 */
function matchesProjectQuery(project: ProjectSummaryWithModules, keyword: string): boolean {
  if (keyword === '') return true
  if (project.name.toLowerCase().includes(keyword)) return true
  return project.modules.some((name) => name.toLowerCase().includes(keyword))
}

/** 项目显示名上限：60 个字符（中英文同口径，按 UTF-16 码元计）。 */
const MAX_PROJECT_NAME = 60

type NamePick =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly message: string }

/**
 * 校验重命名请求体里的 `name`。
 *
 * 三种拒绝理由（都是 400 `invalid_name`）：空（含只含空白）、超长、**含路径分隔符**。
 * 最后一条不是洁癖：项目名会出现在导出目录名与日志里，允许 `/` 或 `\` 就等于让
 * 一个"显示名"具备路径含义。至于目录本身——本项目**根本不会因为改名而移动目录**。
 */
function pickProjectName(body: Record<string, unknown>): NamePick {
  const raw = body.name
  if (typeof raw !== 'string') return { ok: false, message: 'name 应为字符串' }
  const name = raw.trim()
  if (name === '') return { ok: false, message: '项目名不能为空' }
  if (name.length > MAX_PROJECT_NAME) {
    return {
      ok: false,
      message: `项目名最长 ${String(MAX_PROJECT_NAME)} 个字符（收到 ${String(name.length)} 个）`,
    }
  }
  if (/[\\/]/.test(name)) return { ok: false, message: '项目名不能包含路径分隔符（/ 或 \\）' }
  if (/[\u0000-\u001f]/.test(name)) return { ok: false, message: '项目名不能包含控制字符' }
  return { ok: true, name }
}

/** 破坏性操作的显式确认：只认布尔 `true`（字符串 "true" 不算，避免脚本误传）。 */
function isConfirmed(body: Record<string, unknown>): boolean {
  return body.confirm === true
}

const CONFIRM_REQUIRED = '这是破坏性操作，需要显式 confirm: true'

/** 把 `projects/<id>/project.json` 转成客户端需要的形状（不回传完整提示词）。 */
function projectSummaryOf(record: {
  id: string
  name: string
  createdAt: number
  provider: string
  model: string
  items: readonly { images: readonly unknown[] }[]
}): Record<string, unknown> {
  const imageCount = record.items.reduce((total, item) => total + item.images.length, 0)
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    provider: record.provider,
    model: record.model,
    imageCount,
  }
}

/** 只要请求里**出现**的字符串字段才写；空字符串表示清除。 */
function pickStringField(
  body: Record<string, unknown>,
  key: string,
): { readonly present: boolean; readonly value: string } {
  if (!(key in body)) return { present: false, value: '' }
  const raw = body[key]
  if (typeof raw !== 'string') {
    throw new BodyError(400, 'bad_field', `${key} 应为字符串`)
  }
  return { present: true, value: raw.trim() }
}

function toModelProbeStatus(code: ModelProbeCode): number {
  if (code === 'no_api_key') return 400
  if (code === 'auth') return 401
  if (code === 'timeout') return 504
  if (code === 'aborted') return 499
  if (code === 'network') return 502
  return 502
}

// ───────────────────────────────────────────────────────── 路由分发

async function handleApi(
  runtime: ToolRuntime,
  pathname: string,
  method: string,
  query: URLSearchParams,
  response: HttpResponseLike,
  readBody: BodyReader,
): Promise<void> {
  const route = pathname.slice(API_PREFIX.length) || '/'
  const isGet = method === 'GET'
  const isPost = method === 'POST'

  if (!isGet && !isPost) {
    fail(response, 405, 'method_not_allowed', method)
    return
  }

  /**
   * 命中写路由时：GET 必须 405（技术方案：GET 一律只读，绝不因方法而落回读逻辑）。
   * @returns true 表示已经回过响应。
   */
  const requirePost = (): boolean => {
    if (isPost) return false
    fail(response, 405, 'method_not_allowed', `${method} 不允许：该路由只接受 POST`)
    return true
  }

  // GET /pixmart/api/runs
  if ((route === '/runs' || route === '/runs/') && isGet) {
    sendJson(response, 200, { ok: true, runs: runtime.runStore.list(readLimit(query, 10)) })
    return
  }

  // GET /pixmart/api/runs/<id>  ·  POST /pixmart/api/runs/<id>/cancel
  const runMatch = /^\/runs\/([^/]+)(\/cancel)?$/.exec(route)
  if (runMatch !== null) {
    const runId = decodeURIComponent(runMatch[1] as string)
    if (!SAFE_SEGMENT.test(runId)) {
      fail(response, 400, 'bad_id', '非法的运行 id')
      return
    }

    if (runMatch[2] === '/cancel') {
      if (requirePost()) return
      sendJson(response, 200, { ok: true, cancelled: runtime.runStore.cancel(runId) })
      return
    }

    if (!isGet) {
      fail(response, 405, 'method_not_allowed', method)
      return
    }
    try {
      sendJson(response, 200, { ok: true, run: runtime.runStore.read(runId) })
    } catch (error) {
      fail(response, 404, 'not_found', error instanceof Error ? error.message : String(error))
    }
    return
  }

  // GET /pixmart/api/projects?q=&sort=&limit=&offset=
  if ((route === '/projects' || route === '/projects/') && isGet) {
    const sortKey = (query.get('sort') ?? '').trim() || DEFAULT_PROJECT_SORT
    const compare = PROJECT_SORTS[sortKey]
    if (compare === undefined) {
      fail(response, 400, 'bad_sort', `不支持的排序 "${sortKey}"，可用：${PROJECT_SORT_KEYS}`)
      return
    }

    // 过滤先于分页：`total` 报的必须是**过滤后**的总数，否则搜索框旁边那个分母是假的。
    const keyword = (query.get('q') ?? '').trim().toLowerCase()
    const matched = runtime.projectStore
      .listWithModules()
      .filter((project) => matchesProjectQuery(project, keyword))

    const ordered = [...matched].sort(compare)
    const limit = readLimit(query, 50)
    const offset = readOffset(query)
    const page = ordered.slice(offset, offset + limit)

    sendJson(response, 200, {
      ok: true,
      count: page.length,
      // 之前这里写的是 `list().slice(0, limit)`：**超过 limit 的项目被静默隐藏**，
      // 界面上没有任何提示（用户会以为"我只有 50 个项目"）。现在把过滤后的真实总数
      // 与"还有更多"一并报出来，界面据此显示「显示 N / 共 M」+「加载更多」。
      total: ordered.length,
      hasMore: offset + page.length < ordered.length,
      offset,
      limit,
      projects: page,
    })
    return
  }

  // POST /pixmart/api/projects/<id>/delete  ·  /export  ·  /rename
  // （放在详情路由之前：`<id>/delete` 这类路径不该落到"项目不存在"的 404 上）
  const projectActionMatch = /^\/projects\/([^/]+)\/(delete|export|rename)$/.exec(route)
  if (projectActionMatch !== null) {
    if (requirePost()) return
    const projectId = decodeURIComponent(projectActionMatch[1] as string)
    if (!isSafeId(projectId)) {
      fail(response, 400, 'bad_id', '非法的项目 id')
      return
    }
    if (projectActionMatch[2] === 'delete') {
      await handleDeleteProject(runtime, projectId, response, readBody)
    } else if (projectActionMatch[2] === 'rename') {
      await handleRenameProject(runtime, projectId, response, readBody)
    } else {
      await handleExportProject(runtime, projectId, response, readBody)
    }
    return
  }

  // GET /pixmart/api/projects/<id>
  const projectMatch = /^\/projects\/([^/]+)$/.exec(route)
  if (projectMatch !== null && isGet) {
    const projectId = decodeURIComponent(projectMatch[1] as string)
    if (!SAFE_SEGMENT.test(projectId)) {
      fail(response, 400, 'bad_id', '非法的项目 id')
      return
    }
    try {
      const record = runtime.projectStore.read(projectId)
      sendJson(response, 200, {
        ok: true,
        project: {
          id: record.id,
          name: record.name,
          createdAt: record.createdAt,
          provider: record.provider,
          model: record.model,
          items: record.items.map((item) => ({
            module: item.module,
            label: item.label,
            status: item.status,
            size: item.size,
            apiMode: item.apiMode,
            images: item.images.map((image) => image.file),
            // ── 以下 6 个字段是"把已丢弃的信息显示出来"（作品库优化方案 §1.2）：
            //    磁盘上一直有、HTTP 层以前丢掉，纯读、无副作用，且**只新增不改名**。
            prompt: item.prompt,
            model: item.model,
            ms: item.ms,
            createdAt: item.createdAt,
            // 降级链路恒定给数组：客户端不必再判 null；空数组就是"没降级"。
            degraded: [...(item.degraded ?? [])],
            ...(item.error === undefined || item.error === '' ? {} : { error: item.error }),
            ...(item.images[0] === undefined
              ? {}
              : { width: item.images[0].width, height: item.images[0].height }),
          })),
        },
      })
    } catch (error) {
      fail(response, 404, 'not_found', error instanceof Error ? error.message : String(error))
    }
    return
  }

  // GET /pixmart/api/trash —— 回收站列表（只读）
  if (route === '/trash' || route === '/trash/') {
    if (!isGet) {
      fail(response, 405, 'method_not_allowed', `${method} 不允许：该路由只接受 GET`)
      return
    }
    const trash = runtime.projectStore.listTrash()
    sendJson(response, 200, { ok: true, count: trash.length, trash })
    return
  }

  // POST /pixmart/api/trash/purge —— 清空回收站（不可恢复，必须确认）
  if (route === '/trash/purge' || route === '/trash/purge/') {
    if (requirePost()) return
    await handlePurgeTrash(runtime, response, readBody)
    return
  }

  // POST /pixmart/api/trash/<id>/restore
  const restoreMatch = /^\/trash\/([^/]+)\/restore$/.exec(route)
  if (restoreMatch !== null) {
    if (requirePost()) return
    await handleRestore(runtime, decodeURIComponent(restoreMatch[1] as string), response)
    return
  }

  // GET /pixmart/api/usage
  if ((route === '/usage' || route === '/usage/') && isGet) {
    sendJson(response, 200, {
      ok: true,
      summary: runtime.usage.summary(),
      // 账本（usage.jsonl）自 P2 起才有；此前的产出自项目记录汇总，**分开报**。
      // 否则"累计用量 0"会和用户看到的项目并排出现、数字对不上（见 store/historical.ts）。
      historical: historicalTotals(runtime.projectStore.list()),
      recent: runtime.usage.read(readLimit(query, 50)),
    })
    return
  }

  // GET /pixmart/api/providers
  if ((route === '/providers' || route === '/providers/') && isGet) {
    const config = await runtime.config()
    sendJson(response, 200, {
      ok: true,
      dataDir: runtime.dataDir,
      dataDirNotes: runtime.dataDirNotes,
      warnings: runtime.configWarnings(),
      defaults: config.defaults,
      limits: config.limits,
      // 设置页「作品库导出路径」卡片 + 作品库「导出」按钮的数据源：空串 = 未配置。
      // 注意**不再**回传已废弃的 `outputDir`（它已无任何行为）。
      exportDir: config.exportDir,
      providers: config.providers.map((provider) => toProviderView(provider)),
      // 厂商目录（`src/catalog.ts`）：13 家可直接添加的厂商 + 各自的 `added`。
      // 只读：设置页「添加模型提供商」用它列出候选，`added: true` 的项不重复给"添加"。
      catalog: catalogView(config.providers.map((provider) => provider.id)),
      usage: runtime.usage.summary(),
      historical: historicalTotals(runtime.projectStore.list()),
    })
    return
  }

  // POST /pixmart/api/providers —— 新增一个（写配置）：目录 `catalogId` 或自定义 `custom`，二选一
  if (route === '/providers' || route === '/providers/') {
    if (requirePost()) return
    await handleAddProvider(runtime, response, readBody)
    return
  }

  // POST /pixmart/api/providers/probe —— 草稿探测（测试连接 / 拉取模型），**不写配置**
  if (route === '/providers/probe' || route === '/providers/probe/') {
    if (requirePost()) return
    await handleProbeProvider(response, readBody)
    return
  }

  // POST /pixmart/api/providers/<id>/delete —— 从配置里移除一个（写配置）
  // 注意：本仓库的路由层**只接受 GET/POST**（见文件头约定 4），所以"删除"是 POST。
  const providerDeleteMatch = /^\/providers\/([^/]+)\/delete$/.exec(route)
  if (providerDeleteMatch !== null) {
    if (requirePost()) return
    await handleDeleteProvider(runtime, providerDeleteMatch[1] as string, response)
    return
  }

  // POST /pixmart/api/providers/<id>/credentials
  const credentialsMatch = /^\/providers\/([^/]+)\/credentials$/.exec(route)
  if (credentialsMatch !== null) {
    if (requirePost()) return
    await handleCredentials(runtime, credentialsMatch[1] as string, response, readBody)
    return
  }

  // POST /pixmart/api/providers/<id>/refresh-models
  const refreshMatch = /^\/providers\/([^/]+)\/refresh-models$/.exec(route)
  if (refreshMatch !== null) {
    if (requirePost()) return
    await handleRefreshModels(runtime, refreshMatch[1] as string, response)
    return
  }

  // POST /pixmart/api/providers/<id>/models —— 显式保存用户**选中的**模型子集
  const modelsMatch = /^\/providers\/([^/]+)\/models$/.exec(route)
  if (modelsMatch !== null) {
    if (requirePost()) return
    await handleSaveModels(runtime, modelsMatch[1] as string, response, readBody)
    return
  }

  // POST /pixmart/api/providers/<id>/test
  const testMatch = /^\/providers\/([^/]+)\/test$/.exec(route)
  if (testMatch !== null) {
    if (requirePost()) return
    await handleTestProvider(runtime, testMatch[1] as string, response)
    return
  }

  // POST /pixmart/api/defaults
  if (route === '/defaults' || route === '/defaults/') {
    if (requirePost()) return
    await handleDefaults(runtime, response, readBody)
    return
  }

  // POST /pixmart/api/settings/export-dir
  if (route === '/settings/export-dir' || route === '/settings/export-dir/') {
    if (requirePost()) return
    await handleExportDir(runtime, response, readBody)
    return
  }

  fail(response, 404, 'unknown_route', route)
}

function decodeProviderId(raw: string): string {
  return decodeURIComponent(raw)
}

/** 找出厂商；id 非法或找不到时**已经回过响应**，返回 undefined。 */
async function requireProvider(
  runtime: ToolRuntime,
  rawId: string,
  response: HttpResponseLike,
): Promise<{ readonly config: PixmartConfig; readonly provider: ProviderConfig } | undefined> {
  const id = decodeProviderId(rawId)
  if (!SAFE_SEGMENT.test(id)) {
    fail(response, 400, 'bad_id', '非法的厂商 id')
    return undefined
  }
  const config = await runtime.config()
  const provider = config.providers.find((item) => item.id === id)
  if (provider === undefined) {
    fail(response, 404, 'unknown_provider', `没有 id 为 "${id}" 的厂商`)
    return undefined
  }
  return { config, provider }
}

/** 自定义厂商（模式 B）的 id 形状：1–32 位，小写字母/数字开头，其余只允许小写字母、数字、连字符。 */
const CUSTOM_PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/

/** 自定义厂商显示名上限（字符数，按去空白后的值算）。 */
const MAX_CUSTOM_LABEL = 40

/**
 * 新增厂商时 `baseUrl` 的形状校验 —— 与 `endpointProblem` 的差别只有一点：
 * **空串不合法**。`endpointProblem('')` 表示"清除地址"（credentials 路由的语义），
 * 而新建的厂商地址空着就发不出任何请求，不如当场拒掉。
 */
function newProviderBaseUrlProblem(value: string): string | undefined {
  if (value === '') return '不能为空'
  if (!/^https?:\/\//i.test(value)) return '必须以 http:// 或 https:// 开头'
  return undefined
}

/** `pickCustomProvider` 的结果：要么给出干净的身份字段，要么给出一条能读懂的拒绝理由。 */
type CustomPick =
  | { readonly ok: true; readonly id: string; readonly label: string; readonly baseUrl: string }
  | { readonly ok: false; readonly message: string }

/**
 * 校验模式 B 的 `custom`：`{ id, label, baseUrl }` 三个字段都必填、都要合法。
 *
 * 逐条规则（都是 400 `bad_field`，理由随 `message` 回去，方便设置页直接显示）：
 *   1. `custom` 必须是对象（数组 / null / 字符串都不算）；
 *   2. `id` 必须匹配 `^[a-z0-9][a-z0-9-]{0,31}$`（**不去空白**：形状是逐字符的契约，
 *      带空格就是写错了）；
 *   3. `label` 去空白后非空、且 ≤ 40 字符（空白的 label 算空）；
 *   4. `baseUrl` 去空白后非空且是 http(s) 地址。
 */
function pickCustomProvider(raw: unknown): CustomPick {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: 'custom 应为对象：{ id, label, baseUrl }' }
  }
  const custom = raw as Record<string, unknown>

  const id = custom.id
  if (typeof id !== 'string' || !CUSTOM_PROVIDER_ID.test(id)) {
    return {
      ok: false,
      message:
        'custom.id 必须匹配 ^[a-z0-9][a-z0-9-]{0,31}$：小写字母或数字开头，1–32 位，只含小写字母、数字、连字符',
    }
  }

  if (typeof custom.label !== 'string') {
    return { ok: false, message: 'custom.label 应为字符串' }
  }
  const label = custom.label.trim()
  if (label === '') return { ok: false, message: 'custom.label 不能为空' }
  if (label.length > MAX_CUSTOM_LABEL) {
    return {
      ok: false,
      message: `custom.label 最长 ${String(MAX_CUSTOM_LABEL)} 个字符（收到 ${String(label.length)} 个）`,
    }
  }

  if (typeof custom.baseUrl !== 'string') {
    return { ok: false, message: 'custom.baseUrl 应为字符串' }
  }
  const baseUrl = custom.baseUrl.trim()
  const problem = newProviderBaseUrlProblem(baseUrl)
  if (problem !== undefined) {
    return { ok: false, message: `custom.baseUrl 不是可用地址：${problem}` }
  }

  return { ok: true, id, label, baseUrl }
}

/** 「添加厂商」身份字段的解析结果：要么给出可直接落盘的草稿，要么给出一条拒绝（带状态码）。 */
type DraftPick =
  | { readonly ok: true; readonly draft: ProviderConfig }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string }

/**
 * 解析「添加厂商」请求体的身份字段 —— `POST /providers`（**创建**）与
 * `POST /providers/probe`（**草稿探测**）**共用同一套规则**，两处不再各写一份。
 *
 * 规则（模式二选一 + baseUrl + apiKey，逐条对应契约）：
 *   1. `catalogId` 与 `custom` **二选一**（都有或都没有 → 400 `bad_field`）；
 *   2. 模式 A：`catalogId` 不在目录 → 400 `unknown_catalog_id`（保持现状）；
 *      出现 `baseUrl` 时必须是**非空** http(s) 地址（可选覆盖目录默认值）；
 *   3. 模式 B：`custom.{id,label,baseUrl}` 三个字段都必填、都要合法（见 `pickCustomProvider`）；
 *   4. `apiKey`：非空则写进草稿并把 `apiKeyEnv` 置 `''`（页面显式填的密钥压过环境变量）；
 *      空串 / 缺失 = 本次不带密钥（**探测**由调用方另行要求它必填）。
 *
 * 字段类型不对时由 `pickStringField` 抛 `BodyError(400 bad_field)`，与其余写路由同一套。
 */
function pickProviderDraft(body: Record<string, unknown>): DraftPick {
  // 模式二选一：用"键出现"判定，`catalogId: ''` 仍算模式 A（随后按 unknown_catalog_id 拒）。
  const catalogId = pickStringField(body, 'catalogId')
  const hasCustom = 'custom' in body
  if (catalogId.present === hasCustom) {
    return {
      ok: false,
      status: 400,
      code: 'bad_field',
      message: catalogId.present
        ? 'catalogId 与 custom 必须二选一，不能同时给'
        : 'catalogId 与 custom 必须二选一：目录新增给 catalogId，自定义新增给 custom',
    }
  }

  // 非字符串 → BodyError(400 bad_field)，由 guard 统一回给客户端（与其余写路由同）。
  const apiKey = pickStringField(body, 'apiKey')
  // 空串 = "本次不带密钥"（不清除、不写空值），与 credentials 路由的"出现即写"语义区分开。
  const keyFields =
    apiKey.present && apiKey.value !== '' ? { apiKey: apiKey.value, apiKeyEnv: '' } : {}

  if (hasCustom) {
    const custom = pickCustomProvider(body.custom)
    if (!custom.ok) {
      return { ok: false, status: 400, code: 'bad_field', message: custom.message }
    }
    return {
      ok: true,
      draft: providerFromCustom({
        id: custom.id,
        label: custom.label,
        baseUrl: custom.baseUrl,
        apiKey: apiKey.value,
      }),
    }
  }

  const entry = findCatalogEntry(catalogId.value)
  if (entry === undefined) {
    const known = PROVIDER_CATALOG.map((item) => item.id).join(', ')
    return {
      ok: false,
      status: 400,
      code: 'unknown_catalog_id',
      message: catalogId.present
        ? `厂商目录里没有 "${catalogId.value}"；可用：${known}`
        : `catalogId 缺失；可用：${known}`,
    }
  }
  // 模式 A 的 `baseUrl` 是**可选覆盖**：出现即必须合法（空串也不合法——地址空着的
  // 新厂商发不出任何请求，宁可当场拒掉）。
  const baseUrlOverride = pickStringField(body, 'baseUrl')
  if (baseUrlOverride.present) {
    const problem = newProviderBaseUrlProblem(baseUrlOverride.value)
    if (problem !== undefined) {
      return {
        ok: false,
        status: 400,
        code: 'bad_field',
        message: `baseUrl 不是可用地址：${problem}`,
      }
    }
  }
  return {
    ok: true,
    draft: {
      ...providerFromCatalog(entry),
      ...(baseUrlOverride.present ? { baseUrl: baseUrlOverride.value } : {}),
      ...keyFields,
    },
  }
}

/** 「创建时可选 models」的解析结果；`undefined` = 请求体里没这个字段（等同不传）。 */
type NewModelsPick =
  | { readonly ok: true; readonly models: readonly string[] }
  | { readonly ok: false; readonly message: string }

/**
 * 解析创建请求里**可选**的 `models` —— 添加时刚拉到的列表可以直接带上，
 * 不必先保存厂商再走一次「保存选择」。
 *
 * 规则（与 `/providers/<id>/models` 的 `invalid_models` 有意不同，这里的错误码统一 `bad_field`）：
 *   1. 必须是数组，且元素必须都是**字符串**（不是字符串 → 400 `bad_field`）；
 *   2. 逐项 `trim()`，丢掉 trim 后为空的项；
 *   3. 去重且**保持首次出现的顺序**；
 *   4. 结果为空数组 = 等同"不传"（落盘仍是 `models: []`）。
 */
function pickNewModelsField(body: Record<string, unknown>): NewModelsPick | undefined {
  if (!('models' in body)) return undefined
  const raw = body.models
  if (!Array.isArray(raw)) return { ok: false, message: 'models 应为字符串数组' }
  if (raw.some((item) => typeof item !== 'string')) {
    return { ok: false, message: 'models 的每个元素都必须是字符串' }
  }
  const models: string[] = []
  for (const item of raw as string[]) {
    const name = item.trim()
    if (name === '') continue
    if (!models.includes(name)) models.push(name)
  }
  return { ok: true, models }
}

/**
 * `POST /pixmart/api/providers/probe` —— **草稿探测**（测试连接 / 拉取模型）。
 *
 * 为什么需要它：设置页 add-card 里厂商**还没保存**，而
 * `POST /providers/<id>/test` 与 `/refresh-models` 都是**按 id 从配置里**取端点与密钥——
 * 草稿阶段根本拿不到。本路由直接用请求体里的草稿探测，**不读配置、不写配置**。
 *
 * body = 创建接口那套身份字段 + `action`：
 *   - `{ action: 'test' | 'models', catalogId, baseUrl?, apiKey }`
 *   - `{ action: 'test' | 'models', custom: { id, label, baseUrl }, apiKey }`
 *
 * 解析与校验复用 `pickProviderDraft`（与创建路径同一套规则）；`apiKey` **必填且非空**——
 * 草稿场景就是要用刚输入的那个，**不去翻配置里存的密钥、也不认 `apiKeyEnv`**。
 *
 * 返回形状与已保存厂商的两个接口逐字段一致：
 *   - `models` → 成功 200 `{ ok, models, count }`；失败沿用 `toModelProbeStatus` 的状态码 + 错误码；
 *   - `test`   → 成功 200 `{ ok, latencyMs, modelCount }`；失败仍是 200 + 结构化 error。
 * （两者都不回 `provider` 视图：草稿还没有"保存后的样子"，回一个未落盘的视图只会误导客户端。）
 */
async function handleProbeProvider(
  response: HttpResponseLike,
  readBody: BodyReader,
): Promise<void> {
  const body = await readBody()

  const action = pickStringField(body, 'action')
  if (!action.present || (action.value !== 'test' && action.value !== 'models')) {
    fail(
      response,
      400,
      'bad_field',
      action.present
        ? `action 只能是 "test" 或 "models"（收到 "${action.value}"）`
        : 'action 缺失：应为 "test"（测试连接）或 "models"（拉取模型）',
    )
    return
  }

  const picked = pickProviderDraft(body)
  if (!picked.ok) {
    fail(response, picked.status, picked.code, picked.message)
    return
  }
  const apiKey = picked.draft.apiKey.trim()
  if (apiKey === '') {
    fail(response, 400, 'bad_field', '请先填入 API 密钥，再测试连接 / 拉取模型')
    return
  }

  const probe = await fetchProviderModels(picked.draft, { apiKey })

  if (action.value === 'models') {
    if (!probe.ok) {
      fail(response, toModelProbeStatus(probe.error.code), probe.error.code, probe.error.message)
      return
    }
    const models = [...probe.models]
    sendJson(response, 200, { ok: true, models, count: models.length })
    return
  }

  if (probe.ok) {
    sendJson(response, 200, {
      ok: true,
      latencyMs: probe.ms,
      modelCount: probe.models.length,
    })
    return
  }
  sendJson(response, 200, {
    ok: false,
    latencyMs: probe.ms,
    error: { code: probe.error.code, message: probe.error.message },
  })
}

/**
 * `POST /pixmart/api/providers` —— **新增**一家厂商（写配置）。
 *
 * 一次调用完成设置页 add-card 的三件事：**选目录厂商或自定义厂商** + **可选覆盖地址** +
 * **可选带密钥**。两种模式**二选一**（都有或都没有 → 400 `bad_field`）：
 *
 *   - 模式 A（目录）：`{ catalogId, baseUrl?, apiKey? }` —— `catalogId` 是
 *     `src/catalog.ts` 的条目 id（如 `bailian`），`baseUrl` 给了就覆盖目录默认值
 *     （换成中转站时用）；不给则原样用目录的 `baseUrl`（`custom` 那条是空串）。
 *   - 模式 B（自定义）：`{ custom: { id, label, baseUrl }, apiKey? }` —— 三个字段都必填，
 *     校验规则见 `pickCustomProvider`。
 *
 * 两种模式新增出来的厂商都是**空壳但是可用的起点**：`models` / `allowedSizes` 都留空
 * （见 `providerFromCatalog` / `providerFromCustom`），用户接着在设置页填密钥、点「拉取模型」。
 * 这里**不发明**任何模型名，也不抄任何厂商的尺寸表——尺寸由 `sizes.ts` 兜底。
 *
 * `apiKey`（可选，两种模式通用）：非空字符串则**直接写进新建的 provider**，同时把
 * `apiKeyEnv` 置 `''` —— 与 `POST /providers/<id>/credentials` 的既有语义一致
 * （页面显式填的密钥必须压过环境变量）。响应只回 `toProviderView()` 的脱敏视图，
 * **绝不回显密钥本体**。
 *
 * 错误码：`catalogId` 有值但不在目录里 → 400 `unknown_catalog_id`（保持现状）；
 * 模式二选一不成立 / `baseUrl` / `custom` 任一字段非法 → 400 `bad_field`；
 * 目标 id 已在配置里 → 409 `already_exists`（不覆盖用户已填的字段）。
 * 写盘走 `ConfigStore.update()`（原子写 + 串行读改写），与其余写路由一致。
 */
async function handleAddProvider(
  runtime: ToolRuntime,
  response: HttpResponseLike,
  readBody: BodyReader,
): Promise<void> {
  const body = await readBody()

  // 身份字段的解析与校验与 `POST /providers/probe` **共用** `pickProviderDraft`
  // （模式二选一 / id 正则 / label / baseUrl / apiKey 只有一份实现）。
  const picked = pickProviderDraft(body)
  if (!picked.ok) {
    fail(response, picked.status, picked.code, picked.message)
    return
  }

  // 可选 `models`：添加时刚拉到的列表可以直接带上（省一次「保存选择」）。
  const listed = pickNewModelsField(body)
  if (listed !== undefined && !listed.ok) {
    fail(response, 400, 'bad_field', listed.message)
    return
  }
  const draft =
    listed !== undefined && listed.ok && listed.models.length > 0
      ? { ...picked.draft, models: listed.models }
      : picked.draft

  const id = draft.id
  // 预检：早失败、少写一次盘。真正的判重在 mutate 里再做一次（见下）。
  const config = await runtime.config()
  if (config.providers.some((provider) => provider.id === id)) {
    fail(response, 409, 'already_exists', `厂商 "${id}" 已在配置里，未做任何修改`)
    return
  }

  // `update()` 的 mutate 是串行的读改写：两个并发添加同一家厂商时，
  // 后到的那个会在这里看到已存在并原样返回（不写第二份、不覆盖用户刚填的字段）。
  let conflicted = false
  const updated = await runtime.configStore.update((current) => {
    if (current.providers.some((provider) => provider.id === id)) {
      conflicted = true
      return current
    }
    return {
      ...current,
      providers: [...current.providers, draft],
      // 重新添加一个被删过的出厂预设时，把它从"已删除"清单里摘掉：
      // 留着它不会影响本次结果（present 优先），但会让人以为"删除记录还在"。
      removedProviders: current.removedProviders.filter((item) => item !== id),
    }
  })
  if (conflicted) {
    fail(response, 409, 'already_exists', `厂商 "${id}" 已在配置里，未做任何修改`)
    return
  }

  const added = updated.providers.find((provider) => provider.id === id)
  if (added === undefined) {
    fail(response, 500, 'internal', `新增厂商 "${id}" 后未在配置里找到`)
    return
  }
  sendJson(response, 200, {
    ok: true,
    provider: toProviderView(added),
    providers: updated.providers.map((provider) => toProviderView(provider)),
    defaults: updated.defaults,
    catalog: catalogView(updated.providers.map((provider) => provider.id)),
  })
}

/**
 * `POST /pixmart/api/providers/<id>/delete` —— **从配置里**移除一家厂商。
 *
 * 本仓库的路由层只接受 GET/POST（见文件头约定 4），所以"删除"是 POST。
 *
 * 三条语义：
 *   1. 只是从 `providers` 里去掉这一项，**不动**它的数据目录（厂商没有数据目录）；
 *      用户随时可以从目录再加回来；
 *   2. 删的正是 `defaults.provider` 时，默认厂商改成剩余里的**第一个**（一个不剩则 `''`），
 *      同时把 `defaults.model` 换成新默认厂商的第一个模型——旧模型名属于已删掉的厂商，
 *      留着它下一次生图就会拿一个不存在的模型去打另一家；
 *   3. **出厂预设（`defaultConfig().providers` 的 id，即 ofox / agnes）记进
 *      `removedProviders`**：`applyFactoryPresets` 下次 `load()` 会跳过它，
 *      删除才是持久的（这条同时修掉了 docs/contract-notes.md §26.4 的老限制）。
 *      用户自己添加的厂商不需要记账。
 *
 * 错误码：id 非法 → 400 `bad_id`；配置里没有 → 404 `unknown_provider`。
 */
async function handleDeleteProvider(
  runtime: ToolRuntime,
  rawId: string,
  response: HttpResponseLike,
): Promise<void> {
  const id = decodeProviderId(rawId)
  if (!SAFE_SEGMENT.test(id)) {
    fail(response, 400, 'bad_id', '非法的厂商 id')
    return
  }

  const config = await runtime.config()
  if (!config.providers.some((provider) => provider.id === id)) {
    fail(response, 404, 'unknown_provider', `没有 id 为 "${id}" 的厂商`)
    return
  }

  const factoryIds = new Set(defaultConfig().providers.map((provider) => provider.id))

  const updated = await runtime.configStore.update((current) => {
    const providers = current.providers.filter((provider) => provider.id !== id)
    const fallback = providers[0]
    return {
      ...current,
      providers,
      defaults:
        current.defaults.provider === id
          ? {
              ...current.defaults,
              provider: fallback?.id ?? '',
              model: fallback?.models[0] ?? '',
            }
          : current.defaults,
      removedProviders:
        factoryIds.has(id) && !current.removedProviders.includes(id)
          ? [...current.removedProviders, id]
          : current.removedProviders,
    }
  })

  sendJson(response, 200, {
    ok: true,
    // 被删掉的厂商 id（字符串）。客户端只需要 `ok`，这里给 id 是为了可核对。
    removed: id,
    providers: updated.providers.map((provider) => toProviderView(provider)),
    defaults: updated.defaults,
    catalog: catalogView(updated.providers.map((provider) => provider.id)),
  })
}

/**
 * 端点地址的形状校验。
 *
 * `''` 表示清除（放行）；否则只接受 `http(s)://host…`。
 * 这里**不做**联通性判断（那是「测试连接」的事），只挡住明显写错的值。
 */
function endpointProblem(value: string): string | undefined {
  if (value === '') return undefined
  if (!/^https?:\/\//i.test(value)) return '必须以 http:// 或 https:// 开头'
  const rest = value.replace(/^https?:\/\//i, '')
  const host = rest.split(/[/?#]/)[0] ?? ''
  if (host === '') return '缺少主机名'
  if (host.includes('@')) return '不要在地址里内嵌用户名/密码'
  return undefined
}

/**
 * 写厂商凭据。
 *
 * 只写请求里出现的字段；`apiKey` 传空字符串表示**清除**。
 * 响应只回脱敏视图（`hasApiKey` / `apiKeySource`），**绝不回密钥本体**。
 */
async function handleCredentials(
  runtime: ToolRuntime,
  rawId: string,
  response: HttpResponseLike,
  readBody: BodyReader,
): Promise<void> {
  const id = decodeProviderId(rawId)
  const found = await requireProvider(runtime, rawId, response)
  if (found === undefined) return

  const body = await readBody()
  const apiKey = pickStringField(body, 'apiKey')
  const apiKeyEnv = pickStringField(body, 'apiKeyEnv')
  const baseUrl = pickStringField(body, 'baseUrl')
  const geminiNativeBaseUrl = pickStringField(body, 'geminiNativeBaseUrl')

  for (const [field, value] of [
    ['baseUrl', baseUrl.value],
    ['geminiNativeBaseUrl', geminiNativeBaseUrl.value],
  ] as const) {
    const problem = endpointProblem(value)
    if (problem !== undefined) {
      fail(response, 400, 'bad_url', `${field} 不是可用地址：${problem}`)
      return
    }
  }

  // 走 ConfigStore.update()：原子写 + 按 configPath 串行读改写。
  // **绝不直接写文件**——那会绕过这两条保证。
  const updated = await runtime.configStore.update((current) => ({
    ...current,
    providers: current.providers.map((provider) =>
      provider.id === id
        ? {
            ...provider,
            ...(apiKey.present ? { apiKey: apiKey.value } : {}),
            ...(apiKeyEnv.present ? { apiKeyEnv: apiKeyEnv.value } : {}),
            ...(baseUrl.present ? { baseUrl: baseUrl.value } : {}),
            ...(geminiNativeBaseUrl.present
              ? { geminiNativeBaseUrl: geminiNativeBaseUrl.value }
              : {}),
          }
        : provider,
    ),
  }))

  const provider = updated.providers.find((item) => item.id === id)
  if (provider === undefined) {
    fail(response, 404, 'unknown_provider', `没有 id 为 "${id}" 的厂商`)
    return
  }
  sendJson(response, 200, { ok: true, provider: toProviderView(provider) })
}

/** 单个厂商可保存的模型数上限：聚合商（Ofox 等）量级在百，500 是宽松的上限。 */
const MAX_MODELS = 500

/**
 * 拉取模型列表 —— **纯读，不写配置**。
 *
 * 为什么把写回拆出去（实测驱动的契约变更）：厂商返回的是**全量**模型目录，
 * 实测 Ofox 一次返回 150 个，其中绝大多数是纯文本模型。自动全量写回等于把筛选
 * 负担推给用户——默认模型下拉框会被 150 项淹没，而这 150 项里可能只有个位数能生图。
 * 因此语义拆成两步：**拉取 = 只读**（本路由，只回结果）；**选择 = 显式写入**
 * （`POST /providers/<id>/models`，见 `handleSaveModels`）。
 *
 * 副作用：只对厂商发一次 `GET {baseUrl}/models`；`config.json` 不被触碰
 * （测试用写前后深比较 + 磁盘字节比较钉住）。
 */
async function handleRefreshModels(
  runtime: ToolRuntime,
  rawId: string,
  response: HttpResponseLike,
): Promise<void> {
  const found = await requireProvider(runtime, rawId, response)
  if (found === undefined) return

  const probe = await fetchProviderModels(found.provider, {
    apiKey: resolveKeyForProbe(found.provider),
  })
  if (!probe.ok) {
    fail(
      response,
      toModelProbeStatus(probe.error.code),
      probe.error.code,
      probe.error.message,
    )
    return
  }

  const models = [...probe.models]
  sendJson(response, 200, {
    ok: true,
    models,
    count: models.length,
    provider: toProviderView(found.provider),
  })
}

/** 校验结果：要么给出干净的模型列表，要么给出契约里的错误码。 */
type ModelsFieldResult =
  | { readonly ok: true; readonly models: string[] }
  | { readonly ok: false; readonly code: string; readonly message: string }

/**
 * 校验 `body.models`。
 *
 * 规则（逐条对应契约）：
 *   1. 必须是数组，且元素都是**非空字符串**（只含空白的也拒）→ 否则 `invalid_models`；
 *   2. 数量上限 500（按请求体**原始长度**判定，先挡再干活）→ 否则 `too_many_models`；
 *   3. 去重**保持首次出现的顺序** → 去重后为空 → `empty_models`。
 *
 * 判空与去重键都用 trim 后的值（模型 id 不该带首尾空白），落盘同理。
 */
function pickModelsField(body: Record<string, unknown>): ModelsFieldResult {
  const raw = body.models
  if (!Array.isArray(raw)) {
    return { ok: false, code: 'invalid_models', message: 'models 应为字符串数组' }
  }
  if (raw.some((item) => typeof item !== 'string' || item.trim() === '')) {
    return { ok: false, code: 'invalid_models', message: 'models 的每个元素都必须是非空字符串' }
  }
  if (raw.length > MAX_MODELS) {
    return {
      ok: false,
      code: 'too_many_models',
      message: `模型数量超过上限 ${String(MAX_MODELS)}（收到 ${String(raw.length)} 个）`,
    }
  }

  const seen = new Set<string>()
  const models: string[] = []
  for (const item of raw as string[]) {
    const id = item.trim()
    if (seen.has(id)) continue
    seen.add(id)
    models.push(id)
  }
  if (models.length === 0) {
    return { ok: false, code: 'empty_models', message: 'models 去重后为空，至少要保留一个模型' }
  }
  return { ok: true, models }
}

/**
 * 保存用户选中的模型子集（拉取面板的「保存选择」走这里）。
 *
 * 与 `credentials` 同一套写法：走 `ConfigStore.update()` 原子写 + 串行读改写，
 * 响应只回脱敏的 `ProviderView`（**不含 apiKey**）。
 */
async function handleSaveModels(
  runtime: ToolRuntime,
  rawId: string,
  response: HttpResponseLike,
  readBody: BodyReader,
): Promise<void> {
  const id = decodeProviderId(rawId)
  const found = await requireProvider(runtime, rawId, response)
  if (found === undefined) return

  const body = await readBody()
  const picked = pickModelsField(body)
  if (!picked.ok) {
    fail(response, 400, picked.code, picked.message)
    return
  }

  const updated = await runtime.configStore.update((current) => ({
    ...current,
    providers: current.providers.map((provider) =>
      provider.id === id ? { ...provider, models: [...picked.models] } : provider,
    ),
  }))
  const provider = updated.providers.find((item) => item.id === id)
  if (provider === undefined) {
    fail(response, 404, 'unknown_provider', `没有 id 为 "${id}" 的厂商`)
    return
  }
  sendJson(response, 200, {
    ok: true,
    provider: toProviderView(provider),
    count: provider.models.length,
  })
}

/** 轻量探测，**不写任何配置**；成败都是 200 + `ok` 字段。 */
async function handleTestProvider(
  runtime: ToolRuntime,
  rawId: string,
  response: HttpResponseLike,
): Promise<void> {
  const found = await requireProvider(runtime, rawId, response)
  if (found === undefined) return

  const probe = await fetchProviderModels(found.provider, {
    apiKey: resolveKeyForProbe(found.provider),
  })
  if (probe.ok) {
    sendJson(response, 200, {
      ok: true,
      latencyMs: probe.ms,
      modelCount: probe.models.length,
    })
    return
  }
  sendJson(response, 200, {
    ok: false,
    latencyMs: probe.ms,
    error: { code: probe.error.code, message: probe.error.message },
  })
}

/** 写默认值；`model` 必须在已知模型列表里（非空时），不静默接受拼错的名字。 */
async function handleDefaults(
  runtime: ToolRuntime,
  response: HttpResponseLike,
  readBody: BodyReader,
): Promise<void> {
  const body = await readBody()
  const providerId = pickStringField(body, 'provider')
  const model = pickStringField(body, 'model')
  const size = pickStringField(body, 'size')

  let n: number | undefined
  if ('n' in body) {
    const raw = body.n
    // 只接受 1–4 的整数：2.5 这种"差不多"的值宁可报错，也不要静默取整。
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 4) {
      fail(response, 400, 'bad_field', 'n 应为 1–4 的整数')
      return
    }
    n = raw
  }

  const config = await runtime.config()

  if (providerId.present && providerId.value !== '') {
    if (findProvider(config, providerId.value) === undefined) {
      fail(response, 400, 'unknown_provider', `没有 id 为 "${providerId.value}" 的厂商`)
      return
    }
  }

  const targetProvider = providerId.present
    ? findProvider(config, providerId.value)
    : findProvider(config)

  if (model.present && model.value !== '') {
    const known = targetProvider?.models ?? []
    if (known.length > 0 && !known.includes(model.value)) {
      fail(response, 400, 'unknown_model', `该厂商的模型列表里没有 "${model.value}"，请先拉取模型`)
      return
    }
  }

  const updated = await runtime.configStore.update((current) => ({
    ...current,
    defaults: {
      ...current.defaults,
      ...(providerId.present ? { provider: providerId.value } : {}),
      ...(model.present ? { model: model.value } : {}),
      ...(size.present ? { size: size.value } : {}),
      ...(n === undefined ? {} : { n }),
    },
  }))

  sendJson(response, 200, { ok: true, defaults: updated.defaults })
}

/**
 * 写「作品库导出路径」（`exportDir`）。
 *
 * 语义：空串 = **清除**（回到"未配置"，导出按钮会提示先去设置里填）；
 * 非空时**必须是绝对路径**——相对路径的落点取决于宿主进程的工作目录
 * （GUI 启动时那还是 profile 目录），用户无法预期，所以宁可 400 也不静默接受。
 *
 * 与语义变更前的一个重要差别：这里**不再**有任何"生成时自动复制"的含义。
 * 该路径只在用户点作品库的「导出」时才被使用。
 *
 * 走 `ConfigStore.update()`：原子写 + 按 configPath 串行读改写（与其余写路由一致）。
 */
async function handleExportDir(
  runtime: ToolRuntime,
  response: HttpResponseLike,
  readBody: BodyReader,
): Promise<void> {
  const body = await readBody()
  const field = pickStringField(body, 'exportDir')
  if (!field.present) {
    fail(response, 400, 'bad_field', 'exportDir 缺失')
    return
  }
  if (field.value !== '' && !isAbsolute(field.value)) {
    fail(response, 400, 'invalid_export_dir', `作品库导出路径必须是绝对路径："${field.value}"`)
    return
  }

  const updated = await runtime.configStore.update((current) => ({
    ...current,
    exportDir: field.value,
    // 顺手把已废弃的旧字段从盘上抹掉：`outputDir` 已无任何行为，
    // 留着只会让后来的人以为它还有用（也不会再触发迁移 warning 刷屏）。
    outputDir: '',
  }))
  sendJson(response, 200, { ok: true, exportDir: updated.exportDir })
}

/**
 * 取明文密钥用于探测。
 *
 * 与 `resolveApiKey` 同一优先级（环境变量 > 落盘），但**只在本模块内传给探测函数**：
 * 它不进任何返回结构、不进任何错误消息、不进日志。
 */
function resolveKeyForProbe(provider: ProviderConfig): string {
  const envName = provider.apiKeyEnv.trim()
  if (envName !== '') {
    const fromEnv = process.env[envName]?.trim()
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  }
  return provider.apiKey.trim()
}

// ───────────────────────────────────────────────── 作品库写路由（软删 / 回收站 / 导出）

/** 把 store 抛出的软删类错误映射成 HTTP 状态码；其余算 500。 */
function failTrash(response: HttpResponseLike, error: unknown, what: string): void {
  if (error instanceof TrashError) {
    if (error.code === 'not_found') {
      fail(response, 404, 'not_found', error.message)
      return
    }
    if (error.code === 'conflict') {
      fail(response, 409, 'already_exists', error.message)
      return
    }
    fail(response, 400, 'bad_id', error.message)
    return
  }
  fail(
    response,
    500,
    'trash_failed',
    `${what}：${error instanceof Error ? error.message : String(error)}`,
  )
}

/**
 * `POST /pixmart/api/projects/<id>/rename` —— 改**显示名**。
 *
 * ★ 关键约束：**只改 `project.json` 里的 `name`，绝不移动/重命名项目目录**。
 * 目录名就是项目 id，`GET /pixmart/file/<id>/<name>`、`cover` 字段、
 * `pixmart_projects action=get` 全都按它定位；改目录会让已经能看的图立刻 404。
 * 因此路由层只做三件事：校验名字 → 写记录 → 回更新后的摘要；
 * 唯一被触碰的字节是 `projects/<id>/project.json`。
 *
 * 失败码：`400 invalid_name`（空 / 超长 / 含路径分隔符 / 非字符串）·
 * `404 not_found`（项目不存在）· `405`（非 POST，见调用点）。
 */
async function handleRenameProject(
  runtime: ToolRuntime,
  projectId: string,
  response: HttpResponseLike,
  readBody: BodyReader,
): Promise<void> {
  const body = await readBody()
  const picked = pickProjectName(body)
  if (!picked.ok) {
    fail(response, 400, 'invalid_name', picked.message)
    return
  }
  // 先判存在：否则 store 抛出的 "项目不存在" 会在 catch 里被当成别的失败。
  if (!runtime.projectStore.has(projectId)) {
    fail(response, 404, 'not_found', `项目不存在：${projectId}`)
    return
  }

  try {
    const record = await runtime.projectStore.rename(projectId, picked.name)
    sendJson(response, 200, { ok: true, id: record.id, project: projectSummaryOf(record) })
  } catch (error) {
    fail(response, 500, 'rename_failed', error instanceof Error ? error.message : String(error))
  }
}

/**
 * `POST /pixmart/api/projects/<id>/delete` —— **软删**。
 *
 * 删除 = 把 `projects/<id>` 移到 `projects/.trash/<id>`（可恢复），
 * 因此列表立刻少一项、`GET /pixmart/file/<id>/<name>` 立刻 404，
 * 但磁盘上的字节一个都没丢。清空回收站才是真删（见 `handlePurgeTrash`）。
 *
 * 缺 `confirm: true` → 400，**先判确认再碰磁盘**。
 */
async function handleDeleteProject(
  runtime: ToolRuntime,
  projectId: string,
  response: HttpResponseLike,
  readBody: BodyReader,
): Promise<void> {
  const body = await readBody()
  if (!isConfirmed(body)) {
    fail(response, 400, 'confirm_required', `删除会移入回收站（可恢复），${CONFIRM_REQUIRED}`)
    return
  }
  if (!runtime.projectStore.has(projectId)) {
    fail(response, 404, 'not_found', `项目不存在：${projectId}`)
    return
  }

  try {
    const result = await runtime.projectStore.moveToTrash(projectId)
    sendJson(response, 200, {
      ok: true,
      id: result.id,
      trashId: result.trashId,
      trashed: true,
      // rename = 同盘改名；copy = 跨设备回退成了复制 + 删。
      mode: result.mode,
    })
  } catch (error) {
    failTrash(response, error, '删除失败')
  }
}

/**
 * `GET /pixmart/api/trash` 用不到写体；`restore` / `purge` 各自处理。
 *
 * `POST /pixmart/api/trash/<id>/restore` —— 移回 `projects/<原 id>`。
 */
async function handleRestore(
  runtime: ToolRuntime,
  trashId: string,
  response: HttpResponseLike,
): Promise<void> {
  if (!isSafeId(trashId)) {
    fail(response, 400, 'bad_id', '非法的回收站 id')
    return
  }
  try {
    const result = await runtime.projectStore.restoreFromTrash(trashId)
    sendJson(response, 200, {
      ok: true,
      id: result.id,
      trashId: result.trashId,
      restored: true,
      mode: result.mode,
    })
  } catch (error) {
    failTrash(response, error, '恢复失败')
  }
}

/**
 * `POST /pixmart/api/trash/purge` —— 真删，不可恢复，因此**必须** `confirm: true`。
 */
async function handlePurgeTrash(
  runtime: ToolRuntime,
  response: HttpResponseLike,
  readBody: BodyReader,
): Promise<void> {
  const body = await readBody()
  if (!isConfirmed(body)) {
    fail(response, 400, 'confirm_required', `清空回收站不可恢复，${CONFIRM_REQUIRED}`)
    return
  }
  try {
    const purged = runtime.projectStore.purgeTrash()
    sendJson(response, 200, { ok: true, purged })
  } catch (error) {
    failTrash(response, error, '清空回收站失败')
  }
}

/**
 * `POST /pixmart/api/projects/<id>/export` —— 把项目图片**复制**到目标目录。
 *
 * 这是**唯一**往数据目录之外写用户文件的路径（且只由用户点界面触发）：
 * 生成（generate / edit / batch）不自动复制任何东西，Agent 侧的 `pixmart_projects`
 * 也**没有**导出能力（contract-notes §16.6）——两个演员写同一个用户目录会把用户
 * 精心管理的文件夹灌满临时产物。
 *
 * 目标目录的优先级（顺序即优先级）：
 *   1. 请求体里的 `dir`（绝对路径，覆盖配置）；
 *   2. 配置里的 `exportDir`（设置页「作品库导出路径」）；
 *   3. 都没有 → **400 `no_export_dir`**，message 直接告诉用户去哪儿配。
 *
 * 实际落点是 `<目标目录>/<projectId>/`：不同项目各占一格，重复导出不会互相覆盖。
 *
 * 目标解析与落点规划都在 `tools/export-output.ts`（`resolveExportRoot` /
 * `planProjectExport`）——历史上它们还被 Agent 工具入口共用，那条入口已删除；
 * 实现留在原处，因为"用户显式导出"这一条路径仍然只用它。
 *
 * 复用 `tools/export-output.ts` 的三条不变量：只复制（原件是数据源，绝不移动）、
 * 失败不上抛（收敛成 `warnings`，原项目不受影响）、文件名内容寻址。
 */
async function handleExportProject(
  runtime: ToolRuntime,
  projectId: string,
  response: HttpResponseLike,
  readBody: BodyReader,
): Promise<void> {
  const body = await readBody()
  const override = pickStringField(body, 'dir')
  const config = await runtime.config()

  // 目标根：请求体覆盖 > 配置 > 未配置（400）。用户显式点「导出」时的唯一入口。
  const resolved = resolveExportRoot(override.present ? override.value : undefined, config.exportDir)
  if (!resolved.ok) {
    fail(response, 400, resolved.code, resolved.message)
    return
  }

  // 项目必须先存在：否则"不存在的项目"会在盘上凭空造出一个空目录。
  let record
  try {
    record = runtime.projectStore.read(projectId)
  } catch (error) {
    fail(response, 404, 'not_found', error instanceof Error ? error.message : String(error))
    return
  }

  // 落点固定在目标根之下的项目子目录里；越界（例如被喂了 `..`）直接 400。
  const plan = planProjectExport(
    resolved.root,
    projectId,
    runtime.projectStore.imagesDir(projectId),
    record.items,
  )
  if (!plan.ok) {
    fail(response, 400, plan.code, plan.message)
    return
  }

  const outcome = exportImages(plan.target, plan.sources)
  sendJson(response, 200, {
    ok: true,
    id: projectId,
    dir: plan.target,
    count: outcome.exported.length,
    files: outcome.exported,
    warnings: outcome.warnings,
  })
}

function handleFile(
  runtime: ToolRuntime,
  pathname: string,
  method: string,
  response: HttpResponseLike,
): void {
  if (method !== 'GET') {
    fail(response, 405, 'method_not_allowed', method)
    return
  }

  const rest = pathname.slice(FILE_PREFIX.length).replace(/^\/+/, '')
  const slash = rest.indexOf('/')
  if (slash <= 0) {
    fail(response, 400, 'bad_path', '需要 <projectId>/<name>')
    return
  }

  const projectId = decodeURIComponent(rest.slice(0, slash))
  const name = decodeURIComponent(rest.slice(slash + 1))
  if (!SAFE_SEGMENT.test(projectId) || !SAFE_SEGMENT.test(name)) {
    fail(response, 400, 'bad_path', '非法字符')
    return
  }

  // imagesDir 已由 ProjectStore 做过包含校验；这里再做一次兜底。
  const imagesDir = runtime.projectStore.imagesDir(projectId)
  let absolute: string
  try {
    absolute = assertContained(imagesDir, join(imagesDir, name))
  } catch {
    fail(response, 400, 'path_escape', '路径越界')
    return
  }

  if (!existsSync(absolute)) {
    fail(response, 404, 'not_found', name)
    return
  }

  try {
    if (!statSync(absolute).isFile()) {
      fail(response, 404, 'not_found', name)
      return
    }
    const bytes = readFileSync(absolute)
    response.writeHead(200, {
      'content-type': contentTypeFor(name),
      'content-length': String(bytes.length),
      // 文件名是内容寻址的（<sha8>-<slug>.<ext>），因此可以安全长缓存。
      'cache-control': 'private, max-age=31536000, immutable',
    })
    response.end(bytes)
  } catch (error) {
    fail(response, 500, 'read_failed', error instanceof Error ? error.message : String(error))
  }
}

/**
 * 注册本插件的 HTTP 路由。
 *
 * `webServer` 是可选服务（scratch profile 里可能没有），缺失时静默降级——
 * 工具仍然可用，只是客户端 UI 拿不到数据。
 * @returns disposer；未注册时为 no-op。
 */
export function registerRoutes(ctx: HostContext, runtime: ToolRuntime): () => void {
  const server = ctx.get('webServer')
  if (typeof server !== 'object' || server === null) return () => {}
  const webServer = server as WebServerLike
  if (typeof webServer.register !== 'function') return () => {}

  const guard = async (
    request: HttpRequestLike,
    response: HttpResponseLike,
    handle: (
      pathname: string,
      method: string,
      query: URLSearchParams,
      readBody: BodyReader,
    ) => void | Promise<void>,
  ): Promise<void> => {
    try {
      if (!isLoopback(request)) {
        fail(response, 403, 'forbidden', '仅接受本机请求')
        return
      }
      const raw = request.url ?? '/'
      const parsed = new URL(raw, 'http://127.0.0.1')
      const method = (request.method ?? 'GET').toUpperCase()
      // 读体是**惰性**的：只有真正需要 body 的写路由才会 await 它。
      const readBody: BodyReader = () => readJsonBody(request)
      await handle(parsed.pathname, method, parsed.searchParams, readBody)
    } catch (error) {
      // 读体失败带上自己的状态码；其余未预期异常一律 500，绝不留未处理的 rejection。
      if (error instanceof BodyError) {
        try {
          fail(response, error.status, error.code, error.message)
          return
        } catch {
          sendEmpty(response, error.status)
          return
        }
      }
      try {
        fail(response, 500, 'internal', error instanceof Error ? error.message : String(error))
      } catch {
        sendEmpty(response, 500)
      }
    }
  }

  const disposers: (() => void)[] = []

  disposers.push(
    webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (request, response) =>
        guard(request, response, (pathname, method, query, readBody) =>
          handleApi(runtime, pathname, method, query, response, readBody),
        ),
    }),
  )

  disposers.push(
    webServer.register({
      kind: 'prefix',
      path: FILE_PREFIX,
      handler: (request, response) =>
        guard(request, response, (pathname, method) =>
          handleFile(runtime, pathname, method, response),
        ),
    }),
  )

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 卸载路径不该再抛
      }
    }
  }
}
