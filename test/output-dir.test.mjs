/**
 * 「产物保存路径」（`outputDir`）的契约测试。
 *
 * 背景（决定了本文件测什么）：实测发现用户跑测试时，产物与参考图被写进了**插件仓库
 * 目录**——追查确认那**不是插件写的**（插件从 P0 起就是 `exportToWorkspace: false`，
 * 只写数据目录），而是会话里的 agent 自己用 `pwsh` 手动拷进去的。这个功能就是为了
 * 消除那次手动拷贝：插件把每张成功的图**另存**一份到用户指定的绝对路径。
 *
 * 覆盖：
 *   1. 配置容错：默认空串；非绝对路径 → warning + 当作未设置（不抛）；
 *   2. 路由：`POST /settings/output-dir` 写入/清除、非绝对路径 400
 *      `invalid_output_dir`、GET 405、`GET /api/providers` 带 `outputDir`；
 *   3. 生图：`outputDir` 为空 → **不产生任何复制**；设置后 → 目标目录自动创建、
 *      文件名内容寻址不互相覆盖、**原件仍在数据目录**；
 *   4. 降级：目标不可写 → 生图仍 `ok:true`，只追加可读 warning；
 *   5. 批量：逐项另存并汇总完整路径；
 *   6. `pixmart_providers` 工具回传 `outputDir`。
 *
 * **零真实网络 / 零真实厂商调用**：厂商侧一律 stub `globalThis.fetch`（连 socket 都
 * 不建），路由侧用假 webServer 直接喂 handler。
 */
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultConfig, parseConfig } from '../lib/config.js'
import { ConfigStore } from '../lib/store/config-store.js'
import { createRuntime } from '../lib/tools/runtime.js'
import { createGenerateTools } from '../lib/tools/generate.js'
import { createBatchTool } from '../lib/tools/batch.js'
import { createMetaTools } from '../lib/tools/meta.js'
import { registerRoutes } from '../lib/routes.js'

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const PNG = Buffer.from(PNG_B64, 'base64')

const stubExec = {
  callId: 'test',
  signal: { aborted: false, addEventListener: () => {} },
  deferContext: () => {},
  concludeTurn: () => {},
}

const stubContext = {
  tools: { register: () => () => {}, schemas: () => [] },
  get: () => undefined,
  effect: () => {},
  on: () => () => {},
}

const savedFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = savedFetch
})

// ── 夹具 ─────────────────────────────────────────────────────────────────────

/** 造一个临时工作区：`<root>/data` 是插件数据目录，`<root>/out` 是默认的另存目录。 */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'pixmart-out-'))
  const dataDir = join(root, 'data')
  const outDir = join(root, 'out')
  mkdirSync(dataDir, { recursive: true })

  const config = {
    version: 1,
    providers: [
      {
        id: 'mock',
        label: 'Mock',
        group: 'aggregator',
        baseUrl: 'https://vendor.test/v1',
        geminiNativeBaseUrl: '',
        dialect: 'standard',
        apiMode: 'images-generations',
        apiKeyEnv: '',
        apiKey: 'test-key',
        models: ['test-image-model'],
        allowedSizes: ['1:1', '3:4', '4:3'],
        sizeMode: 'whitelist',
        extraHeaders: {},
        timeoutMs: 5_000,
      },
    ],
    defaults: { provider: 'mock', model: 'test-image-model', size: '1:1', n: 1 },
    limits: { maxConcurrency: 2, maxBatchItems: 20, maxRetries: 0, retentionDays: 0 },
    promptOverrides: {},
    exportToWorkspace: false,
    attachmentInConversation: false,
    outputDir: '',
  }
  writeFileSync(join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`)
  return { root, dataDir, outDir, config }
}

/** 把 `outputDir` 直接写进 config.json（等价于设置页保存后的状态）。 */
function setOutputDir(dataDir, value) {
  const configPath = join(dataDir, 'config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  config.outputDir = value
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
}

function makeRuntime(dataDir) {
  return createRuntime(stubContext, { dataDir })
}

/**
 * stub 厂商端点：每次返回**不同字节**（IEND 后追加唯一标记），否则内容寻址会把
 * 多次产出折叠成同一个文件，就测不到"文件名不互相覆盖"了。
 */
function stubVendorFeed(unique = true) {
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    const bytes = unique
      ? Buffer.concat([PNG, Buffer.from(`\n<!-- #${calls} -->`)])
      : PNG
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      text: async () => JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }),
      json: async () => ({}),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    }
  }
  return { calls: () => calls }
}

// ── 1. 配置容错 ──────────────────────────────────────────────────────────────

describe('配置解析：outputDir', () => {
  it('出厂默认是空串（= 不导出，与 P0 起的行为一致）', () => {
    assert.equal(defaultConfig().outputDir, '')
  })

  it('缺失字段不报警、按空串处理', () => {
    const parsed = parseConfig({ version: 1, providers: [] })
    assert.equal(parsed.config.outputDir, '')
    assert.deepEqual(
      parsed.warnings.filter((line) => line.includes('outputDir')),
      [],
    )
  })

  it('非绝对路径 → 记一条 warning 并当作未设置（**不抛**）', () => {
    const parsed = parseConfig({ version: 1, providers: [], outputDir: 'relative/out' })
    assert.equal(parsed.config.outputDir, '', '相对路径必须被当作未设置')
    assert.ok(
      parsed.warnings.some((line) => line.includes('outputDir') && line.includes('不是绝对路径')),
      `应记录相对路径的 warning，实际：${JSON.stringify(parsed.warnings)}`,
    )
  })

  it('类型不对同样只记 warning', () => {
    const parsed = parseConfig({ version: 1, providers: [], outputDir: 42 })
    assert.equal(parsed.config.outputDir, '')
    assert.ok(parsed.warnings.some((line) => line.includes('outputDir')))
  })

  it('绝对路径被保留（首尾空白被裁掉）', () => {
    const absolute = join(tmpdir(), 'pixmart-out-absolute')
    const parsed = parseConfig({ version: 1, providers: [], outputDir: `  ${absolute}  ` })
    assert.equal(parsed.config.outputDir, absolute)
  })
})

// ── 2. 路由 ──────────────────────────────────────────────────────────────────

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

function makeFakeRuntime(store) {
  return {
    ctx: stubContext,
    dataDir: store.dataDir,
    dataDirNotes: [],
    configStore: store,
    projectStore: {
      list: () => [],
      read: () => {
        throw new Error('不在本用例范围')
      },
      imagesDir: () => join(store.dataDir, 'projects', 'x', 'images'),
      has: () => false,
      projectsRoot: join(store.dataDir, 'projects'),
    },
    runStore: {
      list: () => [],
      read: () => {
        throw new Error('not found')
      },
      cancel: () => false,
    },
    usage: {
      file: join(store.dataDir, 'usage.jsonl'),
      summary: () => ({ requests: 0, ok: 0, failed: 0, images: 0, byModel: {} }),
      read: () => [],
      append: () => {},
    },
    config: async () => store.get(),
    configWarnings: () => [],
  }
}

function makeFakeRequest(method, url, options = {}) {
  const listeners = { data: [], end: [], error: [] }
  const raw = options.body === undefined ? undefined : JSON.stringify(options.body)
  return {
    method,
    url,
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    on(event, listener) {
      if (listeners[event] !== undefined) listeners[event].push(listener)
      return this
    },
    flush() {
      if (raw !== undefined) for (const fn of listeners.data) fn(raw)
      for (const fn of listeners.end) fn()
    },
  }
}

/** 走一次真实路由分发。 */
async function call(webServer, runtime, method, path, options = {}) {
  registerRoutes({ get: (name) => (name === 'webServer' ? webServer : undefined) }, runtime)
  const route = webServer.routes.find((entry) => path.startsWith(entry.path))
  assert.ok(route, `没有匹配 ${path} 的路由`)

  let status = 0
  let body = ''
  let ended = false
  const request = makeFakeRequest(method, path, options)
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
    if (!ended) throw error
  })

  await new Promise((resolve) => setImmediate(resolve))
  request.flush()
  const deadline = Date.now() + 2_000
  while (!ended && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve))
  await handled
  assert.equal(ended, true, `${method} ${path} 没有回响应（status=${String(status)}）`)
  return { status, body, json: body === '' ? null : JSON.parse(body) }
}

describe('POST /pixmart/api/settings/output-dir', () => {
  it('GET → 405（写路由只接受 POST）', async () => {
    const { dataDir, root } = makeWorkspace()
    try {
      const store = new ConfigStore(dataDir)
      await store.load()
      const result = await call(
        makeFakeWebServer(),
        makeFakeRuntime(store),
        'GET',
        '/pixmart/api/settings/output-dir',
      )
      assert.equal(result.status, 405)
      assert.equal(result.json.error.code, 'method_not_allowed')
      assert.equal(store.get().outputDir, '')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('写入绝对路径 → 200，且真的落盘', async () => {
    const { dataDir, outDir, root } = makeWorkspace()
    setOutputDir(dataDir, outDir)
    try {
      const store = new ConfigStore(dataDir)
      await store.load()
      const runtime = makeFakeRuntime(store)

      const result = await call(
        makeFakeWebServer(),
        runtime,
        'POST',
        '/pixmart/api/settings/output-dir',
        { body: { outputDir: outDir } },
      )

      assert.equal(result.status, 200)
      assert.equal(result.json.ok, true)
      assert.equal(result.json.outputDir, outDir)
      assert.equal(store.get().outputDir, outDir)
      // 重新读盘：证明写的是 config.json，不只是内存副本
      const fresh = new ConfigStore(dataDir)
      await fresh.load()
      assert.equal(fresh.get().outputDir, outDir)
      assert.equal(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')).outputDir, outDir)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('空字符串 = 清除（回到"不导出"）', async () => {
    const { dataDir, outDir, root } = makeWorkspace()
    setOutputDir(dataDir, outDir)
    try {
      const store = new ConfigStore(dataDir)
      await store.load()
      assert.equal(store.get().outputDir, outDir)

      const result = await call(
        makeFakeWebServer(),
        makeFakeRuntime(store),
        'POST',
        '/pixmart/api/settings/output-dir',
        { body: { outputDir: '' } },
      )

      assert.equal(result.status, 200)
      assert.equal(result.json.outputDir, '')
      const fresh = new ConfigStore(dataDir)
      await fresh.load()
      assert.equal(fresh.get().outputDir, '', '清除必须落盘')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('非绝对路径 → 400 invalid_output_dir，且不落盘', async () => {
    const { dataDir, root } = makeWorkspace()
    try {
      const store = new ConfigStore(dataDir)
      await store.load()
      const onDiskBefore = readFileSync(join(dataDir, 'config.json'), 'utf8')

      for (const bad of ['relative/out', './out', 'out']) {
        const result = await call(
          makeFakeWebServer(),
          makeFakeRuntime(store),
          'POST',
          '/pixmart/api/settings/output-dir',
          { body: { outputDir: bad } },
        )
        assert.equal(result.status, 400, `${bad} 应被拒`)
        assert.equal(result.json.ok, false)
        assert.equal(result.json.error.code, 'invalid_output_dir')
      }

      assert.equal(store.get().outputDir, '')
      assert.equal(readFileSync(join(dataDir, 'config.json'), 'utf8'), onDiskBefore)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('缺字段 / 非字符串 → 400 bad_field', async () => {
    const { dataDir, root } = makeWorkspace()
    try {
      const store = new ConfigStore(dataDir)
      await store.load()
      const runtime = makeFakeRuntime(store)

      const missing = await call(
        makeFakeWebServer(),
        runtime,
        'POST',
        '/pixmart/api/settings/output-dir',
        { body: {} },
      )
      assert.equal(missing.status, 400)
      assert.equal(missing.json.error.code, 'bad_field')

      const wrongType = await call(
        makeFakeWebServer(),
        runtime,
        'POST',
        '/pixmart/api/settings/output-dir',
        { body: { outputDir: 7 } },
      )
      assert.equal(wrongType.status, 400)
      assert.equal(wrongType.json.error.code, 'bad_field')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('GET /pixmart/api/providers 的响应带 outputDir（设置页的数据源）', async () => {
    const { dataDir, outDir, root } = makeWorkspace()
    setOutputDir(dataDir, outDir)
    try {
      const store = new ConfigStore(dataDir)
      await store.load()
      const runtime = makeFakeRuntime(store)

      const before = await call(makeFakeWebServer(), runtime, 'GET', '/pixmart/api/providers')
      assert.equal(before.status, 200)
      assert.equal(before.json.outputDir, outDir)

      await call(makeFakeWebServer(), runtime, 'POST', '/pixmart/api/settings/output-dir', {
        body: { outputDir: '' },
      })
      const after = await call(makeFakeWebServer(), runtime, 'GET', '/pixmart/api/providers')
      assert.equal(after.json.outputDir, '', '写后重取必须看到清空后的值')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── 3. 生图：另存 ────────────────────────────────────────────────────────────

/** 跑一次 `pixmart_generate`。 */
async function runGenerate(runtime, args = {}) {
  const tools = createGenerateTools(runtime)
  const generate = tools.find((tool) => tool.name === 'pixmart_generate')
  assert.ok(generate, '必须注册 pixmart_generate')
  return generate.execute({ module: 'main.white-bg', project: 'OUT', ...args }, stubExec)
}

describe('生图产物另存到 outputDir', () => {
  it('未配置（空串）→ 不产生任何复制：数据目录之外没有新增任何东西', async () => {
    const { root, dataDir } = makeWorkspace()
    try {
      const feed = stubVendorFeed()
      const runtime = makeRuntime(dataDir)
      const result = await runGenerate(runtime)

      assert.equal(result.ok, true)
      assert.equal(feed.calls(), 1)
      assert.equal(result.outputDir, '')
      assert.deepEqual([...result.exported], [], '未配置时不该有导出路径')
      assert.deepEqual([...result.exportWarnings], [])
      // 强断言：整个临时工作区里除了 data/ 之外什么都没被创建
      assert.deepEqual(readdirSync(root), ['data'], '未配置 outputDir 时不该往任何别处写文件')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('配置后 → 目标目录自动创建、文件落在那里、**原件仍在数据目录**', async () => {
    const { root, dataDir, outDir } = makeWorkspace()
    try {
      // 先把 outputDir 写进配置，模拟"设置页已保存"的状态
      setOutputDir(dataDir, outDir)
      assert.equal(existsSync(outDir), false, '开始前目标目录不该存在（用来验证自动创建）')

      stubVendorFeed()
      const runtime = makeRuntime(dataDir)
      const result = await runGenerate(runtime)

      assert.equal(result.ok, true)
      assert.equal(existsSync(outDir), true, '目标目录应被自动创建')
      assert.equal(result.outputDir, outDir)
      assert.equal(result.exported.length, result.images.length)
      assert.deepEqual([...result.exportWarnings], [])

      for (const target of result.exported) {
        assert.equal(existsSync(target), true, `另存副本必须存在：${target}`)
        assert.equal(target.startsWith(outDir), true, '另存路径必须落在 outputDir 内')
        // 内容寻址前缀：不同内容绝不同名
        assert.match(target.slice(outDir.length + 1), /^[0-9a-f]{8}-/)
      }
      // 原件仍在数据目录（只复制，绝不移动/删除）
      for (const image of result.images) {
        assert.equal(existsSync(image.path), true, `原件必须仍在数据目录：${image.path}`)
      }
      assert.equal(readdirSync(outDir).length, result.images.length)

      // 工具文本也要给出完整路径
      const generate = createGenerateTools(runtime).find((tool) => tool.name === 'pixmart_generate')
      const text = generate.output
        .render({}, result)
        .map((block) => String(block.text ?? ''))
        .join('\n')
      for (const target of result.exported) assert.ok(text.includes(target))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('同一模块多次生成不同内容 → 两个文件都在，不互相覆盖', async () => {
    const { dataDir, outDir, root } = makeWorkspace()
    setOutputDir(dataDir, outDir)
    try {
      stubVendorFeed()
      const runtime = makeRuntime(dataDir)

      const first = await runGenerate(runtime)
      const second = await runGenerate(runtime)

      assert.equal(first.ok, true)
      assert.equal(second.ok, true)
      assert.equal(first.exported.length, 1)
      assert.equal(second.exported.length, 1)
      assert.notEqual(first.exported[0], second.exported[0], '不同内容必须落到不同文件名')
      assert.equal(existsSync(first.exported[0]), true)
      assert.equal(existsSync(second.exported[0]), true)
      assert.equal(readdirSync(outDir).length, 2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('同内容重复生成 → 只留一份副本，且不报错', async () => {
    const { dataDir, outDir, root } = makeWorkspace()
    setOutputDir(dataDir, outDir)
    try {
      stubVendorFeed(false) // 每次同一字节 → 同一 sha256
      const runtime = makeRuntime(dataDir)

      const first = await runGenerate(runtime)
      const second = await runGenerate(runtime)

      assert.equal(second.ok, true)
      assert.deepEqual([...second.exportWarnings], [], '同内容复用不该报失败')
      assert.equal(first.exported[0], second.exported[0])
      assert.equal(readdirSync(outDir).length, 1, '同内容只应留一份')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('目标不可写 → 生图仍成功，只追加可读警告，原件仍在', async () => {
    const { dataDir, root } = makeWorkspace()
    try {
      // 造一个"父级是文件"的路径：mkdirSync 一定失败（跨平台都抛）
      const blocker = join(root, 'blocker')
      writeFileSync(blocker, 'not a directory')
      const badDir = join(blocker, 'out')

      const configPath = join(dataDir, 'config.json')
      setOutputDir(dataDir, badDir)
      assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).outputDir, badDir)

      stubVendorFeed()
      const runtime = makeRuntime(dataDir)
      const result = await runGenerate(runtime)

      assert.equal(result.ok, true, '复制失败**不能**让生图失败')
      assert.deepEqual([...result.exported], [])
      assert.equal(result.exportWarnings.length, result.images.length, '每张失败都应有可读警告')
      for (const warning of result.exportWarnings) {
        assert.match(warning, /产物复制失败：/)
        assert.match(warning, /原件仍在/)
      }
      assert.match(result.exportWarnings[0], /原件仍在/)
      // 原件必须仍在
      for (const image of result.images) {
        assert.equal(existsSync(image.path), true)
      }
      // 渲染出的工具文本里也要带上这条警告（模型读得到）
      const generate = createGenerateTools(runtime).find((tool) => tool.name === 'pixmart_generate')
      const blocks = generate.output.render({}, result)
      const text = blocks.map((block) => String(block.text ?? '')).join('\n')
      assert.match(text, /产物复制失败：/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('pixmart_edit（图生图）走同一条另存路径', async () => {
    const { dataDir, outDir, root } = makeWorkspace()
    setOutputDir(dataDir, outDir)
    try {
      stubVendorFeed()
      const runtime = makeRuntime(dataDir)
      const reference = join(root, 'ref.png')
      writeFileSync(reference, PNG)

      const edit = createGenerateTools(runtime).find((tool) => tool.name === 'pixmart_edit')
      assert.ok(edit, '必须注册 pixmart_edit')
      const result = await edit.execute(
        { module: 'main.white-bg', project: 'EOUT', referencePaths: [reference] },
        stubExec,
      )

      assert.equal(result.ok, true)
      assert.equal(result.exported.length, result.images.length)
      for (const target of result.exported) assert.equal(existsSync(target), true)
      for (const image of result.images) assert.equal(existsSync(image.path), true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('工具结果文本列出导出后的完整路径（Agent 可以直接 present）', async () => {
    const { dataDir, outDir, root } = makeWorkspace()
    setOutputDir(dataDir, outDir)
    try {
      stubVendorFeed()
      const runtime = makeRuntime(dataDir)
      const result = await runGenerate(runtime)

      const generate = createGenerateTools(runtime).find((tool) => tool.name === 'pixmart_generate')
      const blocks = generate.output.render({}, result)
      const text = blocks.map((block) => String(block.text ?? '')).join('\n')

      assert.match(text, /产物保存路径/)
      for (const target of result.exported) {
        assert.ok(text.includes(target), `工具文本必须列出完整导出路径：${target}`)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── 4. 批量 ──────────────────────────────────────────────────────────────────

describe('批量生图同样另存', () => {
  it('每项都另存，结果里列出全部完整路径', async () => {
    const { dataDir, outDir, root } = makeWorkspace()
    setOutputDir(dataDir, outDir)
    try {
      stubVendorFeed()
      const runtime = makeRuntime(dataDir)
      const tool = createBatchTool(runtime)

      const result = await tool.execute(
        {
          items: [{ module: 'main.white-bg' }, { module: 'main.scene' }],
          project: 'BOUT',
          concurrency: 1,
        },
        stubExec,
      )

      assert.equal(result.ok, true)
      assert.equal(result.completed, 2)
      assert.deepEqual([...result.exportWarnings], [])
      assert.equal(result.exported.length, 2)
      assert.equal(readdirSync(outDir).length, 2)
      for (const target of result.exported) assert.equal(existsSync(target), true)

      const blocks = tool.output.render({}, result)
      const text = blocks.map((block) => String(block.text ?? '')).join('\n')
      for (const target of result.exported) {
        assert.ok(text.includes(target), `批量结果文本必须列出完整导出路径：${target}`)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('批量未配置 outputDir → 不导出，且批量结果照旧成功', async () => {
    const { dataDir, root } = makeWorkspace()
    try {
      stubVendorFeed()
      const runtime = makeRuntime(dataDir)
      const tool = createBatchTool(runtime)

      const result = await tool.execute(
        { items: [{ module: 'main.white-bg' }], project: 'BOFF' },
        stubExec,
      )

      assert.equal(result.ok, true)
      assert.deepEqual([...result.exported], [])
      assert.deepEqual(readdirSync(root), ['data'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── 5. 只读工具回传 ──────────────────────────────────────────────────────────

describe('pixmart_providers 回传 outputDir', () => {
  it('已设置时回完整路径并在文本里说明', async () => {
    const { dataDir, outDir, root } = makeWorkspace()
    setOutputDir(dataDir, outDir)
    try {
      const runtime = makeRuntime(dataDir)
      const tool = createMetaTools(runtime).find((entry) => entry.name === 'pixmart_providers')
      const value = await tool.execute({}, stubExec)

      assert.equal(value.ok, true)
      assert.equal(value.outputDir, outDir)
      const text = tool.output
        .render({}, value)
        .map((block) => String(block.text ?? ''))
        .join('\n')
      assert.ok(text.includes(outDir), '文本里应给出保存路径')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('未设置时明确说明"产物只写数据目录"', async () => {
    const { dataDir, root } = makeWorkspace()
    try {
      const runtime = makeRuntime(dataDir)
      const tool = createMetaTools(runtime).find((entry) => entry.name === 'pixmart_providers')
      const value = await tool.execute({}, stubExec)

      assert.equal(value.outputDir, '')
      const text = tool.output
        .render({}, value)
        .map((block) => String(block.text ?? ''))
        .join('\n')
      assert.match(text, /产物保存路径：未设置/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
