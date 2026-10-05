/**
 * `historical` 汇总的返回形状锁。
 *
 * 为什么单独锁这个：`usage.jsonl` 自 P2 才引入，此前生成的产出不在账本里。
 * 若 UI 只显示账本数字，"累计用量 0"就会和两个可见项目并排出现，看起来像 bug。
 * 修法是**账本保持真实、历史另列** —— 因此 `historical` 的字段名与口径
 * 成了 client 依赖的线上契约，必须有测试钉住，不能随手改名。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { historicalTotals, HISTORICAL_NOTE } from '../lib/store/historical.js'
import { registerRoutes } from '../lib/routes.js'

describe('historicalTotals', () => {
  it('空列表为 0，不返回 undefined', () => {
    assert.deepEqual(historicalTotals([]), { projects: 0, images: 0, note: HISTORICAL_NOTE })
  })

  it('按项目汇总张数', () => {
    const result = historicalTotals([{ imageCount: 1 }, { imageCount: 3 }, { imageCount: 0 }])
    assert.equal(result.projects, 3)
    assert.equal(result.images, 4)
  })

  it('容忍脏数据（负数 / 非数字）而不污染总数', () => {
    const result = historicalTotals([{ imageCount: 2 }, { imageCount: -5 }, { imageCount: Number.NaN }])
    assert.equal(result.images, 2)
    assert.equal(result.projects, 3)
  })

  it('字段名固定为 projects / images / note', () => {
    assert.deepEqual(Object.keys(historicalTotals([])).sort(), ['images', 'note', 'projects'])
  })
})

/** 捕获 handler 的假 webServer。 */
function makeFakeWebServer() {
  const routes = []
  return {
    routes,
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
}

/** 只提供路由需要的那几个面的假运行时。 */
function makeFakeRuntime(projectList) {
  return {
    ctx: undefined,
    dataDir: 'D:/pixmart',
    dataDirNotes: [],
    configStore: {},
    projectStore: {
      list: () => projectList,
      read: () => {
        throw new Error('不在本用例范围')
      },
      imagesDir: () => 'D:/pixmart/projects/x/images',
      has: () => false,
      projectsRoot: 'D:/pixmart/projects',
    },
    runStore: {
      list: () => [],
      read: () => {
        throw new Error('not found')
      },
      cancel: () => false,
    },
    usage: {
      file: 'D:/pixmart/usage.jsonl',
      summary: () => ({ requests: 0, ok: 0, failed: 0, images: 0, byModel: {} }),
      read: () => [],
      append: () => {},
    },
    config: async () => ({ providers: [], defaults: {}, limits: {} }),
    configWarnings: () => [],
  }
}

/** 走一次真实路由，把响应体解析出来。 */
async function call(webServer, runtime, path) {
  registerRoutes({ get: (name) => (name === 'webServer' ? webServer : undefined) }, runtime)
  const route = webServer.routes.find((entry) => path.startsWith(entry.path))
  assert.ok(route, `没有匹配 ${path} 的路由`)

  let status = 0
  let body = ''
  await route.handler(
    { method: 'GET', url: path, socket: { remoteAddress: '127.0.0.1' } },
    {
      writeHead(code) {
        status = code
      },
      end(data) {
        if (typeof data === 'string') body = data
      },
    },
  )
  return { status, json: body === '' ? null : JSON.parse(body) }
}

describe('HTTP 契约：historical 必须出现在两个读口', () => {
  it('GET /pixmart/api/providers 带 historical，且与项目记录一致', async () => {
    const webServer = makeFakeWebServer()
    const runtime = makeFakeRuntime([{ imageCount: 1 }, { imageCount: 1 }])

    const { status, json } = await call(webServer, runtime, '/pixmart/api/providers')

    assert.equal(status, 200)
    assert.equal(json.ok, true)
    // 账本口径保持不变（本用例里是 0）
    assert.equal(json.usage.requests, 0)
    // 历史口径另列，且能与用户看到的 2 个项目对上
    assert.deepEqual(json.historical, {
      projects: 2,
      images: 2,
      note: HISTORICAL_NOTE,
    })
  })

  it('GET /pixmart/api/usage 同样带 historical', async () => {
    const webServer = makeFakeWebServer()
    const runtime = makeFakeRuntime([{ imageCount: 5 }])

    const { status, json } = await call(webServer, runtime, '/pixmart/api/usage')

    assert.equal(status, 200)
    assert.equal(json.summary.requests, 0)
    assert.equal(json.historical.images, 5)
    assert.equal(json.historical.projects, 1)
  })
})
