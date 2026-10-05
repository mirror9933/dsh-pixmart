/**
 * 设置页可写 —— 5 个 POST 路由的契约测试（走**真实** `registerRoutes` 分发）。
 *
 * 覆盖范围与判据：
 *   1. `POST /providers/<id>/credentials`：只写出现的字段 / 空串清除 /
 *      **响应体字符串里不含密钥**；
 *   2. `POST /providers/<id>/refresh-models`：三种响应形状都能解析、
 *      **不写配置**（写前后深比较 + 磁盘字节一致）、无密钥 → `no_api_key`、401 → `auth`；
 *   3. `POST /providers/<id>/models`：保存选中子集 → 落盘、去重保序、
 *      `invalid_models` / `empty_models` / `too_many_models` / `unknown_provider`、**不含密钥**；
 *   4. `POST /providers/<id>/test`：成功（含 latencyMs / modelCount）与失败，**不写配置**；
 *   5. `POST /defaults`：只写出现的字段、n 限 1–4、未知模型被拒（不静默接受拼错的名字）；
 *   6. 安全/健壮性：GET 打写路由 → 405、非法 JSON → 400、超 64KB → 413、
 *      非环回来源 → 403；
 *   7. **写后重取**：`GET api/providers` 必须立刻反映刚写入的值（用真实 runtime，
 *      钉住"config() 吃首次读盘快照"这个实测缺陷）。
 *
 * **零真实网络**：探测用的 `fetch` 全部是本地 stub（见 `stubFetch`），
 * 且每个用例后还原 `globalThis.fetch`。假 runtime 沿用 `historical.test.mjs` 的写法，
 * 只是这里额外需要一个**真的** `ConfigStore`（指向临时目录），因为写路由的
 * 契约就是「经 `ConfigStore.update()` 原子落盘」。
 */
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConfigStore } from '../lib/store/config-store.js'
import { createRuntime } from '../lib/tools/runtime.js'
import { registerRoutes } from '../lib/routes.js'

const SECRET = 'sk-super-secret-value-987654321'

// ── 假环境 ───────────────────────────────────────────────────────────────────

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

/** 只提供路由需要的那几个面的假运行时；`config` 与 `configStore` 共享同一份内存配置。 */
function makeFakeRuntime(configStore) {
  return {
    ctx: undefined,
    dataDir: configStore.dataDir,
    dataDirNotes: [],
    configStore,
    projectStore: {
      list: () => [],
      read: () => {
        throw new Error('不在本用例范围')
      },
      imagesDir: () => join(configStore.dataDir, 'projects', 'x', 'images'),
      has: () => false,
      projectsRoot: join(configStore.dataDir, 'projects'),
    },
    runStore: {
      list: () => [],
      read: () => {
        throw new Error('not found')
      },
      cancel: () => false,
    },
    usage: {
      file: join(configStore.dataDir, 'usage.jsonl'),
      summary: () => ({ requests: 0, ok: 0, failed: 0, images: 0, byModel: {} }),
      read: () => [],
      append: () => {},
    },
    config: async () => configStore.get(),
    configWarnings: () => [],
  }
}

/** 造一份落盘配置并返回 store（先 save 再 load，确保 store 里就是这份配置）。 */
function makeStore(providerOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pixmart-api-'))
  const config = {
    version: 1,
    providers: [
      {
        id: 'ofox',
        label: 'Ofox',
        group: 'aggregator',
        baseUrl: 'https://api.example.test/v1/',
        geminiNativeBaseUrl: '',
        dialect: 'standard',
        apiMode: 'images-generations',
        apiKeyEnv: '',
        apiKey: '',
        models: [],
        allowedSizes: ['1:1', '3:4'],
        sizeMode: 'whitelist',
        extraHeaders: {},
        timeoutMs: 5_000,
        ...providerOverrides,
      },
    ],
    defaults: { provider: 'ofox', model: '', size: '1:1', n: 1 },
    limits: { maxConcurrency: 2, maxBatchItems: 20, maxRetries: 1, retentionDays: 0 },
    promptOverrides: {},
    exportToWorkspace: false,
    attachmentInConversation: true,
  }
  // 先写 config.json、再 load 进 store：这条路径与生产完全一致
  // （读盘 → parseConfig），也避免为了"让内存副本是这份配置"而 await 一个 mutex。
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`)
  const store = new ConfigStore(dir)
  store.load()
  return { dir, store }
}

/** 重新读盘造一个 store：证明写入**真的落到了 config.json**，而不只是内存副本。 */
function reloadStore(dir) {
  const fresh = new ConfigStore(dir)
  return fresh.load().then(() => fresh)
}

/**
 * 极简假请求：`on('data'|'end')` 立即回放给定的 body（下一个微任务里触发 end）。
 * @param options - `body` 传字符串则原样发（用于造非法 JSON），传对象则序列化。
 */
function makeFakeRequest(method, url, options = {}) {
  const listeners = { data: [], end: [], error: [] }
  const raw =
    options.body === undefined
      ? undefined
      : typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body)

  return {
    method,
    url,
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    on(event, listener) {
      if (listeners[event] !== undefined) listeners[event].push(listener)
      return this
    },
    /** 测试自己驱动：模拟 Node 先 data 后 end。 */
    flush() {
      if (raw !== undefined) for (const fn of listeners.data) fn(raw)
      for (const fn of listeners.end) fn()
    },
    /** 模拟连接中断：走 `error` 事件，读体必须 reject 而不是永远挂着。 */
    abort(error) {
      for (const fn of listeners.error) fn(error)
    },
  }
}

/**
 * 走一次真实路由。
 * @param options - `body` 为请求体；`bodyText` 可为巨型串（413 用）。
 */
async function call(webServer, runtime, method, path, options = {}) {
  registerRoutes({ get: (name) => (name === 'webServer' ? webServer : undefined) }, runtime)
  const route = webServer.routes.find((entry) => path.startsWith(entry.path))
  assert.ok(route, `没有匹配 ${path} 的路由`)

  let status = 0
  let body = ''
  let ended = false
  const request = makeFakeRequest(method, path, {
    ...options,
    ...(options.bodyText === undefined ? {} : { body: options.bodyText }),
  })

  const handled = Promise.resolve(
    route.handler(request, {
      writeHead(code) {
        status = code
      },
      end(data) {
        if (typeof data === 'string') body = data
        else if (data instanceof Uint8Array) body = Buffer.from(data).toString('utf8')
        ended = true
      },
    }),
  ).catch((error) => {
    // guard 自己会把异常转成响应；这里只兜底防止 harness 静默挂起。
    if (!ended) throw error
  })

  // 先让 handler 跑到「订阅 data/end」那一步：路由的 `readBody()` 是在
  // 若干次 await（配置读取等）之后才调用的，所以必须让出一轮微任务再喂 body。
  await new Promise((resolve) => setImmediate(resolve))
  request.flush()
  if (typeof options.afterFeed === 'function') options.afterFeed()
  // 等到响应回来：多数用例一两跳微任务就够；带真实定时器的用例（探测超时）
  // 需要让出真实时间，所以这里按**墙钟**给一个上限，而不是只数 setImmediate。
  const deadline = Date.now() + (options.waitMs ?? 2_000)
  while (!ended && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve))
  await handled
  assert.equal(ended, true, `${method} ${path} 没有回响应（status=${String(status)}）`)

  return { status, body, json: body === '' ? null : JSON.parse(body) }
}

/** 记录调用的 fetch stub。 */
function stubFetch(handler) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    const result = handler(url, init)
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      headers: { get: () => null },
      text: async () => result.bodyText ?? '',
      json: async () => JSON.parse(result.bodyText ?? 'null'),
    }
  }
  return calls
}

function jsonResponse(payload, status = 200) {
  return { status, bodyText: JSON.stringify(payload) }
}

let savedFetch

beforeEach(() => {
  savedFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = savedFetch
})

// ── credentials ──────────────────────────────────────────────────────────────

describe('POST /pixmart/api/providers/<id>/credentials', () => {
  it('写入密钥后：响应体字符串里不含密钥，只回脱敏视图', async () => {
    const { dir, store } = makeStore()
    try {
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const result = await call(webServer, runtime, 'POST', '/pixmart/api/providers/ofox/credentials', {
        body: { apiKey: SECRET, baseUrl: 'https://api.example.test/v1' },
      })

      assert.equal(result.status, 200)
      assert.equal(result.json.ok, true)
      assert.equal(result.json.provider.hasApiKey, true)
      assert.equal(result.json.provider.apiKeySource, 'config')
      assert.equal(result.json.provider.baseUrl, 'https://api.example.test/v1')
      // 红线 1：HTTP 响应体**字符串**里绝不能出现密钥本体，也不能出现 `"apiKey":` 这样的字段
      assert.equal(result.body.includes(SECRET), false, '响应体泄露了密钥')
      assert.equal(/"apiKey"\s*:/.test(result.body), false, '响应体出现了 apiKey 字段')
      // 但确实落盘了（证明"没回传"不是因为"没写入"）
      assert.equal(readFileSync(join(dir, 'config.json'), 'utf8').includes(SECRET), true)
      // 重新读盘也证明落盘生效（不只是内存副本）
      const reloaded = await reloadStore(dir)
      assert.equal(reloaded.get().providers[0].apiKey, SECRET)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('apiKey 传空字符串 = 清除', async () => {
    const { dir, store } = makeStore({ apiKey: SECRET })
    try {
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const before = await call(webServer, runtime, 'GET', '/pixmart/api/providers')
      assert.equal(before.json.providers[0].hasApiKey, true)

      const cleared = await call(
        webServer,
        runtime,
        'POST',
        '/pixmart/api/providers/ofox/credentials',
        { body: { apiKey: '' } },
      )

      assert.equal(cleared.json.ok, true)
      assert.equal(cleared.json.provider.hasApiKey, false)
      assert.equal(cleared.json.provider.apiKeySource, 'none')
      assert.equal(readFileSync(join(dir, 'config.json'), 'utf8').includes(SECRET), false)
      const reloaded = await reloadStore(dir)
      assert.equal(reloaded.get().providers[0].apiKey, '')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('只写请求里出现的字段（没提的字段保持原值）', async () => {
    const { dir, store } = makeStore({ apiKey: SECRET, apiKeyEnv: 'OFOX_API_KEY' })
    try {
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const result = await call(
        webServer,
        runtime,
        'POST',
        '/pixmart/api/providers/ofox/credentials',
        { body: { baseUrl: 'https://changed.test/v1' } },
      )

      assert.equal(result.status, 200)
      assert.equal(result.json.provider.baseUrl, 'https://changed.test/v1')
      // apiKey 与 apiKeyEnv 未出现在请求里 → 原值保留
      assert.equal(result.json.provider.apiKeyEnv, 'OFOX_API_KEY')
      assert.equal(readFileSync(join(dir, 'config.json'), 'utf8').includes(SECRET), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('未知厂商 → 404 unknown_provider', async () => {
    const { dir, store } = makeStore()
    try {
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const result = await call(webServer, runtime, 'POST', '/pixmart/api/providers/nope/credentials', {
        body: { apiKey: SECRET },
      })

      assert.equal(result.status, 404)
      assert.equal(result.json.ok, false)
      assert.equal(result.json.error.code, 'unknown_provider')
      assert.equal(result.body.includes(SECRET), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('baseUrl 形状不对 → 400 bad_url，且不落盘', async () => {
    const { dir, store } = makeStore()
    try {
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      for (const bad of ['api.example.test/v1', 'ftp://api.example.test', 'https://user:pw@h/v1']) {
        const result = await call(
          webServer,
          runtime,
          'POST',
          '/pixmart/api/providers/ofox/credentials',
          { body: { baseUrl: bad } },
        )
        assert.equal(result.status, 400, `${bad} 应被拒`)
        assert.equal(result.json.error.code, 'bad_url')
      }
      // 被拒的写入绝不落盘：baseUrl 仍是夹具里的原值（注意夹具故意带尾部斜杠）
      assert.equal(store.get().providers[0].baseUrl, 'https://api.example.test/v1/')

      // 清空是合法的
      const cleared = await call(
        webServer,
        runtime,
        'POST',
        '/pixmart/api/providers/ofox/credentials',
        { body: { baseUrl: '' } },
      )
      assert.equal(cleared.status, 200)
      assert.equal(cleared.json.provider.baseUrl, '')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── refresh-models ───────────────────────────────────────────────────────────

describe('POST /pixmart/api/providers/<id>/refresh-models', () => {
  const cases = [
    { name: 'OpenAI 形状 { data: [{ id }] }', payload: { data: [{ id: 'm-a' }, { id: 'm-b' }] }, expected: ['m-a', 'm-b'] },
    { name: 'Gemini 形状 { models: [...] }', payload: { models: [{ id: 'g-1' }, { id: 'g-2' }] }, expected: ['g-1', 'g-2'] },
    { name: '纯数组（元素为字符串）', payload: ['s-1', 's-2'], expected: ['s-1', 's-2'] },
    { name: '纯数组（元素为 { id }）', payload: [{ id: 'o-1' }], expected: ['o-1'] },
  ]

  for (const item of cases) {
    it(`能解析 ${item.name}，且**不修改配置**`, async () => {
      const { dir, store } = makeStore({ apiKey: SECRET, models: ['keep-me'] })
      try {
        const calls = stubFetch(() => jsonResponse(item.payload))
        const webServer = makeFakeWebServer()
        const runtime = makeFakeRuntime(store)
        const snapshot = structuredClone(store.get())
        const before = readFileSync(join(dir, 'config.json'), 'utf8')

        const result = await call(
          webServer,
          runtime,
          'POST',
          '/pixmart/api/providers/ofox/refresh-models',
        )

        assert.equal(result.status, 200)
        assert.equal(result.json.ok, true)
        assert.deepEqual(result.json.models, item.expected)
        assert.equal(result.json.count, item.expected.length)
        // 拉取是**只读**：回的是探测结果，而 provider 视图仍是配置里的旧值
        assert.deepEqual(result.json.provider.models, ['keep-me'])
        assert.equal(result.body.includes(SECRET), false, '响应体泄露了密钥')

        // 端点拼接：baseUrl 末尾斜杠先去掉再拼 /models
        assert.equal(calls.length, 1)
        assert.equal(calls[0].url, 'https://api.example.test/v1/models')
        // OpenAI 兼容路径用 Bearer
        assert.equal(calls[0].init.headers.Authorization, `Bearer ${SECRET}`)

        // 配置确实没被碰：内存深比较 + 磁盘字节一致
        assert.deepEqual(store.get(), snapshot)
        assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), before)
        assert.deepEqual(store.get().providers[0].models, ['keep-me'])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  it('不写配置：写前后深比较相等（内存与磁盘都不动）', async () => {
    const { dir, store } = makeStore({ apiKey: SECRET, models: ['before'] })
    try {
      stubFetch(() => jsonResponse({ data: [{ id: 'pulled-a' }, { id: 'pulled-b' }] }))
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const snapshot = structuredClone(store.get())
      const onDiskBefore = readFileSync(join(dir, 'config.json'), 'utf8')

      const result = await call(
        webServer,
        runtime,
        'POST',
        '/pixmart/api/providers/ofox/refresh-models',
      )
      assert.equal(result.status, 200)
      assert.deepEqual(result.json.models, ['pulled-a', 'pulled-b'])

      assert.deepEqual(store.get(), snapshot, 'refresh-models 不该改内存配置')
      assert.equal(
        readFileSync(join(dir, 'config.json'), 'utf8'),
        onDiskBefore,
        'refresh-models 不该改 config.json',
      )
      const reloaded = await reloadStore(dir)
      assert.deepEqual(reloaded.get().providers[0].models, ['before'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gemini-native 用 x-goog-api-key 与原生 baseUrl，不发 Bearer', async () => {
    const { dir, store } = makeStore({
      apiKey: SECRET,
      apiMode: 'gemini-native',
      geminiNativeBaseUrl: 'https://native.example.test/v1beta/',
    })
    try {
      const calls = stubFetch(() => jsonResponse({ models: [{ id: 'gemini-x' }] }))
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const result = await call(
        webServer,
        runtime,
        'POST',
        '/pixmart/api/providers/ofox/refresh-models',
      )

      assert.equal(result.status, 200)
      assert.equal(calls[0].url, 'https://native.example.test/v1beta/models')
      assert.equal(calls[0].init.headers['x-goog-api-key'], SECRET)
      assert.equal(calls[0].init.headers.Authorization, undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('没配密钥 → 400 no_api_key，且不发任何请求', async () => {
    const { dir, store } = makeStore({ apiKeyEnv: '', apiKey: '' })
    try {
      const calls = stubFetch(() => jsonResponse({ data: [] }))
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const result = await call(
        webServer,
        runtime,
        'POST',
        '/pixmart/api/providers/ofox/refresh-models',
      )

      assert.equal(result.status, 400)
      assert.equal(result.json.ok, false)
      assert.equal(result.json.error.code, 'no_api_key')
      assert.equal(calls.length, 0, '无密钥不该发出探测请求')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('HTTP 401 → code auth，消息里只有状态、没有密钥', async () => {
    const { dir, store } = makeStore({ apiKey: SECRET })
    try {
      stubFetch(() => jsonResponse({ error: { message: `bad key ${SECRET}` } }, 401))
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const result = await call(
        webServer,
        runtime,
        'POST',
        '/pixmart/api/providers/ofox/refresh-models',
      )

      assert.equal(result.status, 401)
      assert.equal(result.json.error.code, 'auth')
      assert.equal(result.body.includes(SECRET), false, '错误消息回显了密钥')
      assert.match(result.json.error.message, /密钥被拒/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('HTTP 500 → bad_response，且模型列表不被写坏', async () => {
    const { dir, store } = makeStore({ apiKey: SECRET, models: ['keep-me'] })
    try {
      stubFetch(() => ({ status: 500, bodyText: 'boom' }))
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const result = await call(
        webServer,
        runtime,
        'POST',
        '/pixmart/api/providers/ofox/refresh-models',
      )

      assert.equal(result.status, 502)
      assert.equal(result.json.error.code, 'bad_response')
      assert.deepEqual(store.get().providers[0].models, ['keep-me'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('形状无法识别 → bad_response', async () => {
    const { dir, store } = makeStore({ apiKey: SECRET })
    try {
      stubFetch(() => jsonResponse({ unexpected: true }))
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const result = await call(
        webServer,
        runtime,
        'POST',
        '/pixmart/api/providers/ofox/refresh-models',
      )

      assert.equal(result.status, 502)
      assert.equal(result.json.error.code, 'bad_response')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('超时 → 结构化 timeout，不挂起', async () => {
    // 注意两点：
    //   - `parseConfig` 的 timeoutMs 下限是 1_000ms（见 src/config.ts），所以本用例
    //     用 1000ms 这个"合法的最小值"；`models.ts` 里的 15s 上限是常量
    //     `PROBE_TIMEOUT_MS`，不在这里再花 15 秒去实测它。
    const { dir, store } = makeStore({ apiKey: SECRET, timeoutMs: 1_000 })
    try {
      // 一个"永远不回"的 fetch：只挂 abort 监听，由探测自己的超时驱动。
      let aborting
      globalThis.fetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborting = true
            reject(new Error('aborted'))
          })
        })
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const result = await call(
        webServer,
        runtime,
        'POST',
        '/pixmart/api/providers/ofox/refresh-models',
        { waitMs: 3_000 },
      )

      assert.equal(aborting, true, '探测没有触发 abort（超时机制没生效）')
      assert.equal(result.status, 504)
      assert.equal(result.json.error.code, 'timeout')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── models（保存选中子集） ───────────────────────────────────────────────────

describe('POST /pixmart/api/providers/<id>/models', () => {
  it('写入选中子集：落盘、count 与视图一致，且响应体不含密钥', async () => {
    const { dir, store } = makeStore({ apiKey: SECRET, models: ['old-a', 'old-b', 'old-c'] })
    try {
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const result = await call(webServer, runtime, 'POST', '/pixmart/api/providers/ofox/models', {
        body: { models: ['google/gemini-3.1-flash-image', 'openai/gpt-image-1'] },
      })

      assert.equal(result.status, 200)
      assert.equal(result.json.ok, true)
      assert.equal(result.json.count, 2)
      assert.deepEqual(result.json.provider.models, [
        'google/gemini-3.1-flash-image',
        'openai/gpt-image-1',
      ])
      // 红线：响应体字符串里既没有密钥本体，也没有 apiKey 字段
      assert.equal(result.body.includes(SECRET), false, '响应体泄露了密钥')
      assert.equal(/"apiKey"\s*:/.test(result.body), false, '响应体出现了 apiKey 字段')

      // 磁盘确实变了（不只是内存副本）：直接读文件 + 重新读盘
      const onDisk = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
      assert.deepEqual(onDisk.providers[0].models, [
        'google/gemini-3.1-flash-image',
        'openai/gpt-image-1',
      ])
      const reloaded = await reloadStore(dir)
      assert.deepEqual(reloaded.get().providers[0].models, [
        'google/gemini-3.1-flash-image',
        'openai/gpt-image-1',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('去重且保持首次出现的顺序', async () => {
    const { dir, store } = makeStore({ models: ['old'] })
    try {
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const result = await call(webServer, runtime, 'POST', '/pixmart/api/providers/ofox/models', {
        body: { models: ['b', 'a', 'b', 'c', 'a', 'b'] },
      })

      assert.equal(result.status, 200)
      assert.deepEqual(result.json.provider.models, ['b', 'a', 'c'])
      assert.equal(result.json.count, 3)
      const onDisk = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
      assert.deepEqual(onDisk.providers[0].models, ['b', 'a', 'c'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('空数组 → 400 empty_models，且不落盘', async () => {
    const { dir, store } = makeStore({ models: ['keep'] })
    try {
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const result = await call(webServer, runtime, 'POST', '/pixmart/api/providers/ofox/models', {
        body: { models: [] },
      })

      assert.equal(result.status, 400)
      assert.equal(result.json.ok, false)
      assert.equal(result.json.error.code, 'empty_models')
      assert.deepEqual(store.get().providers[0].models, ['keep'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非数组 / 元素不是非空字符串 → 400 invalid_models', async () => {
    const { dir, store } = makeStore({ models: ['keep'] })
    try {
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const badBodies = [
        { models: 'm-a' },
        { models: 42 },
        { models: null },
        {},
        { models: [1, 2] },
        { models: ['ok', null] },
        { models: [{ id: 'm-a' }] },
        { models: [''] },
        { models: ['   '] },
      ]
      for (const body of badBodies) {
        const result = await call(webServer, runtime, 'POST', '/pixmart/api/providers/ofox/models', {
          body,
        })
        assert.equal(result.status, 400, `${JSON.stringify(body)} 应被拒`)
        assert.equal(result.json.error.code, 'invalid_models')
      }
      assert.deepEqual(store.get().providers[0].models, ['keep'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('超过 500 → 400 too_many_models，且不落盘', async () => {
    const { dir, store } = makeStore({ models: ['keep'] })
    try {
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const many = Array.from({ length: 501 }, (_, index) => `m-${String(index)}`)
      const result = await call(webServer, runtime, 'POST', '/pixmart/api/providers/ofox/models', {
        body: { models: many },
      })

      assert.equal(result.status, 400)
      assert.equal(result.json.error.code, 'too_many_models')
      assert.deepEqual(store.get().providers[0].models, ['keep'])

      // 500 是允许的（上限本身不能也被拒）
      const atLimit = await call(
        webServer,
        runtime,
        'POST',
        '/pixmart/api/providers/ofox/models',
        { body: { models: many.slice(0, 500) } },
      )
      assert.equal(atLimit.status, 200)
      assert.equal(atLimit.json.count, 500)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('未知厂商 → 404 unknown_provider，且不落盘', async () => {
    const { dir, store } = makeStore({ models: ['keep'] })
    try {
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const result = await call(webServer, runtime, 'POST', '/pixmart/api/providers/ghost/models', {
        body: { models: ['m-a'] },
      })

      assert.equal(result.status, 404)
      assert.equal(result.json.error.code, 'unknown_provider')
      assert.deepEqual(store.get().providers[0].models, ['keep'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('写后重取 api/providers 必须看到新值（真实 runtime 不吃首次读盘快照）', async () => {
    const { dir, store } = makeStore({ apiKey: SECRET, models: ['stale-default'] })
    try {
      stubFetch(() => jsonResponse({ data: [{ id: 'pulled-a' }, { id: 'pulled-b' }] }))
      const webServer = makeFakeWebServer()
      // 用**真实** createRuntime：它的 config() 之前会永远返回首次读盘的快照，
      // 于是"写入成功但界面那行还是旧值"。这里就是那条缺陷的回归测试。
      const real = createRuntime({ get: () => undefined }, { dataDir: dir })
      const runtime = {
        ...makeFakeRuntime(store),
        configStore: real.configStore,
        config: () => real.config(),
        configWarnings: () => real.configWarnings(),
      }

      const before = await call(webServer, runtime, 'GET', '/pixmart/api/providers')
      assert.deepEqual(before.json.providers[0].models, ['stale-default'])

      const saved = await call(webServer, runtime, 'POST', '/pixmart/api/providers/ofox/models', {
        body: { models: ['picked-image-model'] },
      })
      assert.equal(saved.status, 200)

      const after = await call(webServer, runtime, 'GET', '/pixmart/api/providers')
      assert.deepEqual(
        after.json.providers[0].models,
        ['picked-image-model'],
        '写成功后 GET api/providers 必须反映最新配置',
      )
      const onDisk = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
      assert.deepEqual(onDisk.providers[0].models, ['picked-image-model'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── test ─────────────────────────────────────────────────────────────────────

describe('POST /pixmart/api/providers/<id>/test', () => {
  it('成功：200 + latencyMs + modelCount，且不写配置', async () => {
    const { dir, store } = makeStore({ apiKey: SECRET, models: ['before'] })
    try {
      stubFetch(() => jsonResponse({ data: [{ id: 'a' }, { id: 'b' }] }))
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const result = await call(webServer, runtime, 'POST', '/pixmart/api/providers/ofox/test')

      assert.equal(result.status, 200)
      assert.equal(result.json.ok, true)
      assert.equal(result.json.modelCount, 2)
      assert.equal(typeof result.json.latencyMs, 'number')
      assert.ok(result.json.latencyMs >= 0)
      assert.deepEqual(store.get().providers[0].models, ['before'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('失败：仍是 200，但 ok:false + 结构化 error', async () => {
    const { dir, store } = makeStore({ apiKey: SECRET })
    try {
      stubFetch(() => jsonResponse({}, 403))
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const result = await call(webServer, runtime, 'POST', '/pixmart/api/providers/ofox/test')

      assert.equal(result.status, 200)
      assert.equal(result.json.ok, false)
      assert.equal(result.json.error.code, 'auth')
      assert.equal(typeof result.json.latencyMs, 'number')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('无密钥：ok:false + no_api_key（不发请求）', async () => {
    const { dir, store } = makeStore()
    try {
      const calls = stubFetch(() => jsonResponse({ data: [] }))
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const result = await call(webServer, runtime, 'POST', '/pixmart/api/providers/ofox/test')

      assert.equal(result.status, 200)
      assert.equal(result.json.ok, false)
      assert.equal(result.json.error.code, 'no_api_key')
      assert.equal(calls.length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── defaults ─────────────────────────────────────────────────────────────────

describe('POST /pixmart/api/defaults', () => {
  it('只写出现的字段', async () => {
    const { dir, store } = makeStore()
    try {
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const result = await call(webServer, runtime, 'POST', '/pixmart/api/defaults', {
        body: { size: '3:4' },
      })

      assert.equal(result.status, 200)
      assert.equal(result.json.ok, true)
      assert.equal(result.json.defaults.size, '3:4')
      // 没提 provider / model / n → 保持原值
      assert.equal(result.json.defaults.provider, 'ofox')
      assert.equal(result.json.defaults.n, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('n 超出 1–4 → 400 bad_field', async () => {
    const { dir, store } = makeStore()
    try {
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      for (const bad of [0, 5, 2.5]) {
        const result = await call(webServer, runtime, 'POST', '/pixmart/api/defaults', {
          body: { n: bad },
        })
        assert.equal(result.status, 400, `n=${String(bad)} 应被拒`)
        assert.equal(result.json.error.code, 'bad_field')
      }

      const good = await call(webServer, runtime, 'POST', '/pixmart/api/defaults', { body: { n: 3 } })
      assert.equal(good.json.defaults.n, 3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('模型不在该厂商列表里 → 400 unknown_model（不静默接受拼错的名字）', async () => {
    const { dir, store } = makeStore({ models: ['good-model'] })
    try {
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const result = await call(webServer, runtime, 'POST', '/pixmart/api/defaults', {
        body: { provider: 'ofox', model: 'god-model' },
      })

      assert.equal(result.status, 400)
      assert.equal(result.json.ok, false)
      assert.equal(result.json.error.code, 'unknown_model')
      // 被拒的写入绝不落盘：模型仍是原来的（parseConfig 把空 model 解析成首个模型）
      assert.equal(store.get().defaults.model, 'good-model')

      const ok = await call(webServer, runtime, 'POST', '/pixmart/api/defaults', {
        body: { provider: 'ofox', model: 'good-model' },
      })
      assert.equal(ok.status, 200)
      assert.equal(ok.json.defaults.model, 'good-model')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('未知厂商 → 400 unknown_provider', async () => {
    const { dir, store } = makeStore()
    try {
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const result = await call(webServer, runtime, 'POST', '/pixmart/api/defaults', {
        body: { provider: 'ghost' },
      })

      assert.equal(result.status, 400)
      assert.equal(result.json.error.code, 'unknown_provider')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── 方法与请求体红线 ─────────────────────────────────────────────────────────

describe('写路由的方法与请求体约束', () => {
  const writeRoutes = [
    '/pixmart/api/providers/ofox/credentials',
    '/pixmart/api/providers/ofox/refresh-models',
    '/pixmart/api/providers/ofox/models',
    '/pixmart/api/providers/ofox/test',
    '/pixmart/api/defaults',
    '/pixmart/api/settings/export-dir',
  ]

  for (const path of writeRoutes) {
    it(`GET ${path} → 405（GET 一律只读）`, async () => {
      const { dir, store } = makeStore({ apiKey: SECRET })
      try {
        const calls = stubFetch(() => jsonResponse({ data: [] }))
        const webServer = makeFakeWebServer()
        const runtime = makeFakeRuntime(store)

        const result = await call(webServer, runtime, 'GET', path)

        assert.equal(result.status, 405)
        assert.equal(result.json.error.code, 'method_not_allowed')
        assert.equal(calls.length, 0, 'GET 打写路由不该产生任何探测请求')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  it('非法 JSON → 400', async () => {
    const { dir, store } = makeStore()
    try {
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const result = await call(webServer, runtime, 'POST', '/pixmart/api/defaults', {
        body: '{not json',
      })

      assert.equal(result.status, 400)
      assert.equal(result.json.error.code, 'bad_json')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('请求体超过 64KB → 413，且不落盘', async () => {
    const { dir, store } = makeStore()
    try {
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const result = await call(webServer, runtime, 'POST', '/pixmart/api/defaults', {
        bodyText: JSON.stringify({ pad: 'x'.repeat(80 * 1024) }),
      })

      assert.equal(result.status, 413)
      assert.equal(result.json.error.code, 'body_too_large')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非环回来源 → 403（写路由同样受 guard 约束）', async () => {
    const { dir, store } = makeStore()
    try {
      const webServer = makeFakeWebServer()
      const runtime = makeFakeRuntime(store)

      const result = await call(webServer, runtime, 'POST', '/pixmart/api/defaults', {
        body: { size: '3:4' },
        remoteAddress: '10.0.0.7',
      })

      assert.equal(result.status, 403)
      assert.equal(result.json.error.code, 'forbidden')
      assert.equal(store.get().defaults.size, '1:1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
