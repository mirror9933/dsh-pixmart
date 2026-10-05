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
 *   5. **任何响应体都不含 apiKey**：厂商一律回脱敏后的 `ProviderView`。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { findProvider, toProviderView, type PixmartConfig, type ProviderConfig } from './config.js'
import { historicalTotals } from './store/historical.js'
import { assertContained } from './store/paths.js'
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

function readLimit(query: URLSearchParams, fallback: number, max = 200): number {
  const raw = Number(query.get('limit'))
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return Math.min(Math.floor(raw), max)
}

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

  // GET /pixmart/api/projects
  if ((route === '/projects' || route === '/projects/') && isGet) {
    const projects = runtime.projectStore.list().slice(0, readLimit(query, 50))
    sendJson(response, 200, { ok: true, count: projects.length, projects })
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
      providers: config.providers.map((provider) => toProviderView(provider)),
      usage: runtime.usage.summary(),
      historical: historicalTotals(runtime.projectStore.list()),
    })
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

/** 拉取模型列表并写回 `config.json` 的 `provider.models`。 */
async function handleRefreshModels(
  runtime: ToolRuntime,
  rawId: string,
  response: HttpResponseLike,
): Promise<void> {
  const id = decodeProviderId(rawId)
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

  const updated = await runtime.configStore.update((current) => ({
    ...current,
    providers: current.providers.map((provider) =>
      provider.id === id ? { ...provider, models: [...probe.models] } : provider,
    ),
  }))
  const provider = updated.providers.find((item) => item.id === id) ?? found.provider
  const models = [...probe.models]
  sendJson(response, 200, {
    ok: true,
    models,
    count: models.length,
    provider: toProviderView(provider),
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
