/**
 * 宿主 HTTP API —— client 半边与宿主之间的**唯一通道**（技术方案 §7.10 / §7.11）。
 *
 * 为什么是 HTTP 而不是 `host.call`：P0 取证确认包式 client 半的
 * `factory(require)` **只收到 `require`**，`host.call` 属于动态 client 半
 * （见 contract-notes §3.2）。工作参照是 dshmarket 的 `/dsh-market/*`。
 *
 * 三条安全/健壮性约定：
 *   1. **只接受环回来源**：这是本机能力，不做鉴权但也不对外暴露。
 *   2. **路径严格限定在数据目录内**：图片路由只服务 `projects/<id>/images/`。
 *   3. **任何异常都转成明确的 4xx/5xx**：不留未处理的 rejection。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { toProviderView } from './config.js'
import { historicalTotals } from './store/historical.js'
import { assertContained } from './store/paths.js'
import type { HostContext, HttpResponseLike, HttpRequestLike, WebServerLike } from './host-types.js'
import type { ToolRuntime } from './tools/runtime.js'

const API_PREFIX = '/pixmart/api'
const FILE_PREFIX = '/pixmart/file'

/** 只允许本机来源。 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

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

async function handleApi(
  runtime: ToolRuntime,
  pathname: string,
  method: string,
  query: URLSearchParams,
  response: HttpResponseLike,
): Promise<void> {
  const route = pathname.slice(API_PREFIX.length) || '/'

  if (method !== 'GET' && method !== 'POST') {
    sendJson(response, 405, { ok: false, error: { code: 'method_not_allowed', message: method } })
    return
  }

  // GET /pixmart/api/runs
  if ((route === '/runs' || route === '/runs/') && method === 'GET') {
    sendJson(response, 200, { ok: true, runs: runtime.runStore.list(readLimit(query, 10)) })
    return
  }

  // GET /pixmart/api/runs/<id>  ·  POST /pixmart/api/runs/<id>/cancel
  const runMatch = /^\/runs\/([^/]+)(\/cancel)?$/.exec(route)
  if (runMatch !== null) {
    const runId = decodeURIComponent(runMatch[1] as string)
    if (!SAFE_SEGMENT.test(runId)) {
      sendJson(response, 400, { ok: false, error: { code: 'bad_id', message: '非法的运行 id' } })
      return
    }

    if (runMatch[2] === '/cancel') {
      if (method !== 'POST') {
        sendJson(response, 405, { ok: false, error: { code: 'method_not_allowed', message: method } })
        return
      }
      sendJson(response, 200, { ok: true, cancelled: runtime.runStore.cancel(runId) })
      return
    }

    try {
      sendJson(response, 200, { ok: true, run: runtime.runStore.read(runId) })
    } catch (error) {
      sendJson(response, 404, {
        ok: false,
        error: { code: 'not_found', message: error instanceof Error ? error.message : String(error) },
      })
    }
    return
  }

  // GET /pixmart/api/projects
  if ((route === '/projects' || route === '/projects/') && method === 'GET') {
    const projects = runtime.projectStore.list().slice(0, readLimit(query, 50))
    sendJson(response, 200, { ok: true, count: projects.length, projects })
    return
  }

  // GET /pixmart/api/projects/<id>
  const projectMatch = /^\/projects\/([^/]+)$/.exec(route)
  if (projectMatch !== null && method === 'GET') {
    const projectId = decodeURIComponent(projectMatch[1] as string)
    if (!SAFE_SEGMENT.test(projectId)) {
      sendJson(response, 400, { ok: false, error: { code: 'bad_id', message: '非法的项目 id' } })
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
      sendJson(response, 404, {
        ok: false,
        error: { code: 'not_found', message: error instanceof Error ? error.message : String(error) },
      })
    }
    return
  }

  // GET /pixmart/api/usage
  if ((route === '/usage' || route === '/usage/') && method === 'GET') {
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
  if ((route === '/providers' || route === '/providers/') && method === 'GET') {
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

  sendJson(response, 404, { ok: false, error: { code: 'unknown_route', message: route } })
}

function handleFile(
  runtime: ToolRuntime,
  pathname: string,
  method: string,
  response: HttpResponseLike,
): void {
  if (method !== 'GET') {
    sendJson(response, 405, { ok: false, error: { code: 'method_not_allowed', message: method } })
    return
  }

  const rest = pathname.slice(FILE_PREFIX.length).replace(/^\/+/, '')
  const slash = rest.indexOf('/')
  if (slash <= 0) {
    sendJson(response, 400, { ok: false, error: { code: 'bad_path', message: '需要 <projectId>/<name>' } })
    return
  }

  const projectId = decodeURIComponent(rest.slice(0, slash))
  const name = decodeURIComponent(rest.slice(slash + 1))
  if (!SAFE_SEGMENT.test(projectId) || !SAFE_SEGMENT.test(name)) {
    sendJson(response, 400, { ok: false, error: { code: 'bad_path', message: '非法字符' } })
    return
  }

  // imagesDir 已由 ProjectStore 做过包含校验；这里再做一次兜底。
  const imagesDir = runtime.projectStore.imagesDir(projectId)
  let absolute: string
  try {
    absolute = assertContained(imagesDir, join(imagesDir, name))
  } catch {
    sendJson(response, 400, { ok: false, error: { code: 'path_escape', message: '路径越界' } })
    return
  }

  if (!existsSync(absolute)) {
    sendJson(response, 404, { ok: false, error: { code: 'not_found', message: name } })
    return
  }

  try {
    if (!statSync(absolute).isFile()) {
      sendJson(response, 404, { ok: false, error: { code: 'not_found', message: name } })
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
    sendJson(response, 500, {
      ok: false,
      error: { code: 'read_failed', message: error instanceof Error ? error.message : String(error) },
    })
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
    handle: (pathname: string, method: string, query: URLSearchParams) => void | Promise<void>,
  ): Promise<void> => {
    try {
      if (!isLoopback(request)) {
        sendJson(response, 403, { ok: false, error: { code: 'forbidden', message: '仅接受本机请求' } })
        return
      }
      const raw = request.url ?? '/'
      const parsed = new URL(raw, 'http://127.0.0.1')
      const method = (request.method ?? 'GET').toUpperCase()
      await handle(parsed.pathname, method, parsed.searchParams)
    } catch (error) {
      // 任何未预期的异常都转成 500，绝不留未处理的 rejection。
      try {
        sendJson(response, 500, {
          ok: false,
          error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
        })
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
        guard(request, response, (pathname, method, query) =>
          handleApi(runtime, pathname, method, query, response),
        ),
    }),
  )

  disposers.push(
    webServer.register({
      kind: 'prefix',
      path: FILE_PREFIX,
      handler: (request, response) =>
        guard(request, response, (pathname, method) => handleFile(runtime, pathname, method, response)),
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
