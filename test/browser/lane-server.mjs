/**
 * 真实浏览器 lane 的 **Node 侧支撑**：静态服务器 + 浏览器解析/启动。
 *
 * 分工：
 *   - 本文件（Node）：起一个只读静态服务，把 `shell.html` / `lane.js` / React UMD /
 *     **仓库里的原产物 `client/client.js`** 喂给浏览器；并按 `playwright-core` +
 *     系统已安装的 Edge/Chrome 启动浏览器。
 *   - `lane.js`（页面内）：搭 shell 骨架、装载原 bundle、注册插槽、挂载面板、量几何。
 *   - `layout.test.mjs`：断言。
 *
 * 为什么不用 `page.setContent`：`client.js` 的 API 基址是
 * `new URL('pixmart/', document.baseURI)`，`about:blank` 下解析失败、整个面板会走
 * "无法解析插件基址"的错误分支。真实 HTTP 源才给得出和 GUI 一致的 `document.baseURI`。
 *
 * 三条硬约束（对应 docs/dsh-pixmart-技术方案.md §13.7）：
 *   1. 静态服务**只**服务白名单路径 + 读取原产物，不复制、不改写、不转译 `client.js`；
 *      并记下它的 sha256，测试里会与仓库里的文件逐字节比对（证明 lane 不是空跑）。
 *   2. `playwright-core` **不下载浏览器**：走 `channel: 'msedge' | 'chrome'`，
 *      用系统已安装的 Edge/Chrome。
 *   3. 没有可用浏览器时返回 `{ browser: null }`，由调用方**醒目地**报 SKIP / 失败，
 *      绝不静默通过。
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright-core'

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const LANE_DIR = fileURLToPath(new URL('.', import.meta.url))

/** 优先顺序：Edge（Windows 桌面外壳同款内核）→ Chrome。 */
export const BROWSER_CHANNELS = ['msedge', 'chrome']

/**
 * 解析一个包的**真实文件**路径（pnpm 下是软链，`realpath` 后仍在 store 里，
 * 但 `readFile` 走软链没问题）。
 */
function packageFile(spec, relative) {
  const direct = path.join(REPO_ROOT, 'node_modules', spec, relative)
  try {
    const pkgUrl = import.meta.resolve(spec + '/package.json')
    return path.join(path.dirname(fileURLToPath(pkgUrl)), relative)
  } catch {
    return direct
  }
}

const REACT_UMD = packageFile('react', path.join('umd', 'react.development.js'))
const REACT_DOM_UMD = packageFile('react-dom', path.join('umd', 'react-dom.development.js'))

/** 只服务这些路径；其余一律 404（不做出任意文件读取的口子）。 */
const STATIC_ROUTES = new Map([
  ['/shell.html', { file: path.join(LANE_DIR, 'shell.html'), type: 'text/html; charset=utf-8' }],
  ['/', { file: path.join(LANE_DIR, 'shell.html'), type: 'text/html; charset=utf-8' }],
  ['/test/browser/lane.js', { file: path.join(LANE_DIR, 'lane.js'), type: 'text/javascript; charset=utf-8' }],
  ['/node_modules/react/umd/react.development.js', { file: REACT_UMD, type: 'text/javascript; charset=utf-8' }],
  [
    '/node_modules/react-dom/umd/react-dom.development.js',
    { file: REACT_DOM_UMD, type: 'text/javascript; charset=utf-8' },
  ],
])

// ── 一张真的能被解码的 PNG（8×8 渐变）：作品库/查看器的 <img> 不该是坏图 ────────

function crc32(buf) {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (~c) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed), 0)
  return Buffer.concat([length, typed, crc])
}

/**
 * 800×800 RGBA 图（浅灰底 + 深色边框）。不用任何图像库：IHDR + IDAT(zlib) + IEND。
 *
 * **尺寸必须够大**：查看器里的图按**固有尺寸**排版（只有 `max-width/max-height` 上限），
 * 给一张 8×8 的图会让查看器内部根本没有可滚内容，"顶栏不随内容滚"就成了空转。
 * 生产里是 1024×1024，这里 800 足够触发 `max-height: 62vh` 那条上限。
 */
function makeTilePng(size = 800) {
  const raw = []
  for (let y = 0; y < size; y += 1) {
    raw.push(0) // filter: none
    for (let x = 0; x < size; x += 1) {
      const border = x < 4 || y < 4 || x >= size - 4 || y >= size - 4
      if (border) raw.push(120, 126, 140, 255)
      else raw.push(232, 234, 240, 255)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.from(raw))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

export const TILE_PNG = makeTilePng()

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * 起 lane 的静态服务。
 *
 * @param options.clientPath - 要服务的 `client.js`。默认 = 仓库原产物
 *   `client/client.js`；只有 `tools/lane-mutations.mjs`（变异验证）会传一个临时改写过的
 *   副本，用 `PXM_LANE_CLIENT` 环境变量传进来。**默认路径永不改写产物**。
 */
export async function startLaneServer(options = {}) {
  const clientPath =
    options.clientPath ?? process.env.PXM_LANE_CLIENT ?? path.join(REPO_ROOT, 'client', 'client.js')
  const served = { clientPath, clientBytes: 0, clientSha256: null, clientRequests: 0 }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/client/client.js') {
        const bytes = await readFile(clientPath)
        served.clientRequests += 1
        served.clientBytes = bytes.length
        served.clientSha256 = createHash('sha256').update(bytes).digest('hex')
        return send(res, 200, 'text/javascript; charset=utf-8', bytes)
      }
      const route = STATIC_ROUTES.get(url.pathname)
      if (route !== undefined) return send(res, 200, route.type, await readFile(route.file))
      // 图片路由：面板里的 <img> 指向 `/pixmart/file/<id>/<name>`，给一张真图。
      if (url.pathname.startsWith('/pixmart/file/')) return send(res, 200, 'image/png', TILE_PNG)
      return send(res, 404, 'text/plain; charset=utf-8', 'lane 404: ' + url.pathname)
    } catch (err) {
      return send(res, 500, 'text/plain; charset=utf-8', String(err && err.message ? err.message : err))
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()

  return {
    origin: 'http://127.0.0.1:' + String(port),
    served,
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** 仓库原产物 `client/client.js` 的 sha256（用来证明 lane 加载的是它，没被改过）。 */
export async function artifactSha256(file = path.join(REPO_ROOT, 'client', 'client.js')) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

/**
 * 按顺序尝试系统浏览器。全部失败时返回 `{ browser: null, failures }`，
 * **不抛异常**——由调用方决定怎么"醒目地"报（约束 4：不许静默跳过）。
 */
export async function launchLaneBrowser() {
  const failures = []
  for (const channel of BROWSER_CHANNELS) {
    try {
      const browser = await chromium.launch({ channel, headless: true })
      return { browser, channel, failures }
    } catch (err) {
      failures.push(channel + ': ' + String(err && err.message ? err.message : err).split('\n')[0])
    }
  }
  return { browser: null, channel: null, failures }
}
