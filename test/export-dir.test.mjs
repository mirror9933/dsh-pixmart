/**
 * 「作品库导出路径」（`exportDir`）的契约测试。
 *
 * 背景（决定了本文件测什么）：本文件的前身是 `output-dir.test.mjs`，测的是
 * 「产物保存路径」`outputDir`——配好之后**每张成功的图都会被自动复制**一份过去。
 * 那次语义变更把它改掉了：
 *
 *   1. **取消自动复制**：生成（generate / edit / batch）只写插件数据目录。
 *      生成不该有未经请求的副作用；要不要文件形式的副本、放哪，由用户在作品库
 *      显式点「导出」时决定。
 *   2. `outputDir` → `exportDir`：新字段只在导出时被使用；旧字段保留在 schema 里
 *      仅为兼容旧 config.json，**不再有任何行为**。
 *   3. **迁移**：读配置时若 `exportDir` 未设置（缺键）而旧 `outputDir` 有值，
 *      把旧值搬过来并在 warning 里说明"已从 outputDir 迁移"，避免用户已填的路径凭空消失。
 *
 * 覆盖：
 *   A. 配置容错：默认空串；非绝对路径 → warning + 当作未设置（不抛）；
 *   B. 迁移：只有 `outputDir` → `exportDir` 得到该值；两者都有 → 以 `exportDir` 为准；
 *      显式清空过 → 旧值不复活；
 *   C. 路由：`POST /settings/export-dir` 写入/清除、非绝对路径 400 `invalid_export_dir`、
 *      缺字段 400 `bad_field`、GET 405、`GET /api/providers` 带 `exportDir`（且不带 `outputDir`）；
 *   D. 生成：配了旧 `outputDir` 也**不产生任何复制**（哨兵：数据目录之外没有新增任何东西）；
 *   E. 导出：`dir` 覆盖 > `exportDir` 回退 > 两者皆无 400 `no_export_dir`；
 *      落点是 `<目标>/<项目 id>/`；原件仍在（只复制不移动）；
 *   F. `pixmart_providers` 工具回传 `exportDir`。
 *
 * **零真实网络 / 零真实厂商调用**：厂商侧一律 stub `globalThis.fetch`（连 socket 都
 * 不建），路由侧用假 webServer 直接喂 handler。
 */
import { afterEach, describe, it } from 'node:test'
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
import { ProjectStore } from '../lib/store/project-store.js'
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

/**
 * 造一个临时工作区：`<root>/data` 是插件数据目录，`<root>/out` 是"用户可能会配的
 * 导出目录"。**`out` 一开始不存在**——它可以当哨兵：只要它在跑完之后仍然不存在，
 * 就说明没有任何东西往那儿写过。
 */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'pixmart-export-'))
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
    exportDir: '',
  }
  writeFileSync(join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`)
  return { root, dataDir, outDir, config }
}

/** 直接改 config.json 的顶层字段（等价于设置页保存后的状态）。 */
function patchConfigFile(dataDir, patch) {
  const configPath = join(dataDir, 'config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  Object.assign(config, patch)
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
}

function makeRuntime(dataDir) {
  return createRuntime(stubContext, { dataDir })
}

/**
 * stub 厂商端点：每次返回**不同字节**（IEND 后追加唯一标记），否则内容寻址会把
 * 多次产出折叠成同一个文件。
 */
function stubVendorFeed(unique = true) {
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    const bytes = unique ? Buffer.concat([PNG, Buffer.from(`\n<!-- #${calls} -->`)]) : PNG
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

// ── A. 配置容错 ──────────────────────────────────────────────────────────────

describe('配置解析：exportDir', () => {
  it('出厂默认是空串（= 未配置；导出按钮会提示先去设置里填）', () => {
    assert.equal(defaultConfig().exportDir, '')
  })

  it('缺失字段不报警、按空串处理', () => {
    const parsed = parseConfig({ version: 1, providers: [] })
    assert.equal(parsed.config.exportDir, '')
    assert.deepEqual(
      parsed.warnings.filter((line) => line.includes('exportDir')),
      [],
    )
  })

  it('非绝对路径 → 记一条 warning 并当作未设置（**不抛**）', () => {
    const parsed = parseConfig({ version: 1, providers: [], exportDir: 'relative/out' })
    assert.equal(parsed.config.exportDir, '', '相对路径必须被当作未设置')
    assert.ok(
      parsed.warnings.some((line) => line.includes('exportDir') && line.includes('不是绝对路径')),
      `应记录相对路径的 warning，实际：${JSON.stringify(parsed.warnings)}`,
    )
  })

  it('类型不对同样只记 warning', () => {
    const parsed = parseConfig({ version: 1, providers: [], exportDir: 42 })
    assert.equal(parsed.config.exportDir, '')
    assert.ok(parsed.warnings.some((line) => line.includes('exportDir')))
  })

  it('绝对路径被保留（首尾空白被裁掉）', () => {
    const absolute = join(tmpdir(), 'pixmart-export-absolute')
    const parsed = parseConfig({ version: 1, providers: [], exportDir: `  ${absolute}  ` })
    assert.equal(parsed.config.exportDir, absolute)
  })
})

// ── B. 旧 outputDir 的迁移 ───────────────────────────────────────────────────

describe('旧 outputDir → exportDir 的迁移', () => {
  const legacy = join(tmpdir(), 'pixmart-legacy-export')
  const newer = join(tmpdir(), 'pixmart-newer-export')

  it('只有 outputDir 时：值被搬到 exportDir，并记一条说明"已从 outputDir 迁移"的 warning', () => {
    const parsed = parseConfig({ version: 1, providers: [], outputDir: legacy })
    assert.equal(parsed.config.exportDir, legacy, '旧值必须跟过来，不能凭空消失')
    assert.ok(
      parsed.warnings.some(
        (line) =>
          line.includes('outputDir') && line.includes('迁移') && line.includes('废弃'),
      ),
      `应记录迁移 warning，实际：${JSON.stringify(parsed.warnings)}`,
    )
  })

  it('两者都有且都是绝对路径 → 以 exportDir 为准，旧值不生效', () => {
    const parsed = parseConfig({ version: 1, providers: [], exportDir: newer, outputDir: legacy })
    assert.equal(parsed.config.exportDir, newer)
    assert.equal(
      parsed.warnings.some((line) => line.includes('迁移')),
      false,
      'exportDir 已可用时不该发生迁移',
    )
  })

  it('exportDir 显式空串（用户清除过）→ 旧 outputDir **不复活**', () => {
    const parsed = parseConfig({ version: 1, providers: [], exportDir: '', outputDir: legacy })
    assert.equal(parsed.config.exportDir, '')
  })

  it('exportDir 写坏了（相对路径）→ 记 warning 且**不**回填旧值', () => {
    const parsed = parseConfig({ version: 1, providers: [], exportDir: 'bad/rel', outputDir: legacy })
    assert.equal(parsed.config.exportDir, '')
    assert.ok(parsed.warnings.some((line) => line.includes('exportDir') && line.includes('不是绝对路径')))
  })

  it('旧 outputDir 自己写坏时：记一条"已按未设置处理"的 warning，exportDir 保持空串', () => {
    const parsed = parseConfig({ version: 1, providers: [], outputDir: 'relative/legacy' })
    assert.equal(parsed.config.exportDir, '')
    assert.ok(
      parsed.warnings.some((line) => line.includes('outputDir') && line.includes('不是绝对路径')),
      `实际：${JSON.stringify(parsed.warnings)}`,
    )
  })

  it('迁移后的值跑一次 generate **不产生任何复制**（旧字段真的没有行为了）', async () => {
    const { root, dataDir, outDir } = makeWorkspace()
    // 把 outDir 当作"旧 outputDir"，模拟"用户升级前已经配好的产物保存路径"。
    patchConfigFile(dataDir, { outputDir: outDir, exportDir: undefined })
    try {
      assert.equal(existsSync(outDir), false, '开始前导出目录不该存在')
      stubVendorFeed()
      const runtime = makeRuntime(dataDir)
      assert.equal((await runtime.config()).exportDir, outDir, '配置里应看到迁移后的值')

      const result = await runGenerate(runtime)
      assert.equal(result.ok, true)
      assert.equal(existsSync(outDir), false, '生成**不得**再往旧 outputDir 复制任何东西')
      assert.deepEqual(readdirSync(root), ['data'], '数据目录之外不得有任何新增')
      // 工具结果里也不该再出现任何导出路径字段
      assert.equal('exported' in result, false)
      assert.equal('exportWarnings' in result, false)
      assert.equal('outputDir' in result, false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── C. 路由 ──────────────────────────────────────────────────────────────────

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

describe('POST /pixmart/api/settings/export-dir', () => {
  it('GET → 405（写路由只接受 POST）', async () => {
    const { dataDir, root } = makeWorkspace()
    try {
      const store = new ConfigStore(dataDir)
      await store.load()
      const result = await call(
        makeFakeWebServer(),
        makeFakeRuntime(store),
        'GET',
        '/pixmart/api/settings/export-dir',
      )
      assert.equal(result.status, 405)
      assert.equal(result.json.error.code, 'method_not_allowed')
      assert.equal(store.get().exportDir, '')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('旧的 POST /settings/output-dir 已不存在 → 404（不再有任何行为）', async () => {
    const { dataDir, root } = makeWorkspace()
    try {
      const store = new ConfigStore(dataDir)
      await store.load()
      const result = await call(
        makeFakeWebServer(),
        makeFakeRuntime(store),
        'POST',
        '/pixmart/api/settings/output-dir',
        { body: { outputDir: join(root, 'out') } },
      )
      assert.equal(result.status, 404)
      assert.equal(result.json.error.code, 'unknown_route')
      assert.equal(store.get().exportDir, '')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('写入绝对路径 → 200，且真的落盘；顺手把废弃的 outputDir 从盘上抹掉', async () => {
    const { dataDir, outDir, root } = makeWorkspace()
    patchConfigFile(dataDir, { outputDir: join(root, 'legacy') })
    try {
      const store = new ConfigStore(dataDir)
      await store.load()
      const runtime = makeFakeRuntime(store)

      const result = await call(
        makeFakeWebServer(),
        runtime,
        'POST',
        '/pixmart/api/settings/export-dir',
        { body: { exportDir: outDir } },
      )

      assert.equal(result.status, 200)
      assert.equal(result.json.ok, true)
      assert.equal(result.json.exportDir, outDir)
      assert.equal(store.get().exportDir, outDir)
      // 重新读盘：证明写的是 config.json，不只是内存副本
      const fresh = new ConfigStore(dataDir)
      await fresh.load()
      assert.equal(fresh.get().exportDir, outDir)
      const onDisk = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))
      assert.equal(onDisk.exportDir, outDir)
      assert.equal(onDisk.outputDir, '', '废弃字段应被清掉，避免后来的人以为它还有用')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('空字符串 = 清除（回到"未配置"）', async () => {
    const { dataDir, outDir, root } = makeWorkspace()
    patchConfigFile(dataDir, { exportDir: outDir })
    try {
      const store = new ConfigStore(dataDir)
      await store.load()
      assert.equal(store.get().exportDir, outDir)

      const result = await call(
        makeFakeWebServer(),
        makeFakeRuntime(store),
        'POST',
        '/pixmart/api/settings/export-dir',
        { body: { exportDir: '' } },
      )

      assert.equal(result.status, 200)
      assert.equal(result.json.exportDir, '')
      const fresh = new ConfigStore(dataDir)
      await fresh.load()
      assert.equal(fresh.get().exportDir, '', '清除必须落盘')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('非绝对路径 → 400 invalid_export_dir，且不落盘', async () => {
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
          '/pixmart/api/settings/export-dir',
          { body: { exportDir: bad } },
        )
        assert.equal(result.status, 400, `${bad} 应被拒`)
        assert.equal(result.json.ok, false)
        assert.equal(result.json.error.code, 'invalid_export_dir')
      }

      assert.equal(store.get().exportDir, '')
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
        '/pixmart/api/settings/export-dir',
        { body: {} },
      )
      assert.equal(missing.status, 400)
      assert.equal(missing.json.error.code, 'bad_field')

      const wrongType = await call(
        makeFakeWebServer(),
        runtime,
        'POST',
        '/pixmart/api/settings/export-dir',
        { body: { exportDir: 7 } },
      )
      assert.equal(wrongType.status, 400)
      assert.equal(wrongType.json.error.code, 'bad_field')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('GET /pixmart/api/providers 回 exportDir（设置页与导出按钮的数据源），不回 outputDir', async () => {
    const { dataDir, outDir, root } = makeWorkspace()
    patchConfigFile(dataDir, { exportDir: outDir })
    try {
      const store = new ConfigStore(dataDir)
      await store.load()
      const runtime = makeFakeRuntime(store)

      const before = await call(makeFakeWebServer(), runtime, 'GET', '/pixmart/api/providers')
      assert.equal(before.status, 200)
      assert.equal(before.json.exportDir, outDir)
      assert.equal('outputDir' in before.json, false, '废弃字段不该再出现在响应里')

      await call(makeFakeWebServer(), runtime, 'POST', '/pixmart/api/settings/export-dir', {
        body: { exportDir: '' },
      })
      const after = await call(makeFakeWebServer(), runtime, 'GET', '/pixmart/api/providers')
      assert.equal(after.json.exportDir, '', '写后重取必须看到清空后的值')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── D. 生成：不再有任何自动复制 ──────────────────────────────────────────────

/** 跑一次 `pixmart_generate`。 */
async function runGenerate(runtime, args = {}) {
  const tools = createGenerateTools(runtime)
  const generate = tools.find((tool) => tool.name === 'pixmart_generate')
  assert.ok(generate, '必须注册 pixmart_generate')
  return generate.execute({ module: 'main.white-bg', project: 'EXP', ...args }, stubExec)
}

describe('生成只写数据目录（没有任何自动复制）', () => {
  it('配了导出路径也不复制：哨兵目录仍为空，工作区里只有 data/', async () => {
    const { root, dataDir, outDir } = makeWorkspace()
    patchConfigFile(dataDir, { exportDir: outDir })
    try {
      const feed = stubVendorFeed()
      const runtime = makeRuntime(dataDir)
      const result = await runGenerate(runtime)

      assert.equal(result.ok, true)
      assert.equal(feed.calls(), 1)
      assert.equal(result.images.length, 1)
      // ① 原件落在数据目录里
      assert.equal(existsSync(result.images[0].path), true)
      assert.equal(result.images[0].path.startsWith(dataDir), true, '图片必须落在数据目录内')
      // ② 导出目录**一个字节都没被碰**（连目录都没被创建）
      assert.equal(existsSync(outDir), false, '生成不得碰导出目录')
      // ③ 整个临时工作区里除了 data/ 之外什么都没被创建
      assert.deepEqual(readdirSync(root), ['data'], '生成只许写数据目录')
      // ④ 工具结果里不再有导出路径相关字段
      assert.deepEqual(Object.keys(result).filter((key) => /export|outputDir/i.test(key)), [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('未配置时同样如此；且**数据目录内的字节确实写下去了**（不是"什么都没写"）', async () => {
    const { root, dataDir, outDir } = makeWorkspace()
    try {
      stubVendorFeed()
      const runtime = makeRuntime(dataDir)
      const result = await runGenerate(runtime)

      assert.equal(result.ok, true)
      assert.equal(existsSync(outDir), false)
      // 反面对照：数据目录里必须真有 project.json 与图片，否则上面那条断言毫无意义
      const projectDir = join(dataDir, 'projects', result.projectId)
      assert.equal(existsSync(join(projectDir, 'project.json')), true)
      assert.equal(existsSync(join(projectDir, 'images')), true)
      assert.ok(readdirSync(join(projectDir, 'images')).length >= 1)
      assert.deepEqual(readdirSync(root), ['data'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('pixmart_edit（图生图）同样不复制；参考图放在数据目录之外也不会被搬动', async () => {
    const { root, dataDir, outDir } = makeWorkspace()
    patchConfigFile(dataDir, { exportDir: outDir })
    try {
      stubVendorFeed()
      const runtime = makeRuntime(dataDir)
      const reference = join(root, 'ref.png')
      writeFileSync(reference, PNG)
      const before = readFileSync(reference)

      const edit = createGenerateTools(runtime).find((tool) => tool.name === 'pixmart_edit')
      assert.ok(edit, '必须注册 pixmart_edit')
      const result = await edit.execute(
        { module: 'main.white-bg', project: 'EEXP', referencePaths: [reference] },
        stubExec,
      )

      assert.equal(result.ok, true)
      assert.equal(existsSync(outDir), false)
      assert.equal(readFileSync(reference).equals(before), true, '参考图不得被移动或改写')
      // 工作区里多了一个 ref.png（用例自己写的），除此之外只该有 data/
      assert.deepEqual(readdirSync(root).sort(), ['data', 'ref.png'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('批量（pixmart_batch）也只写数据目录', async () => {
    const { dataDir, outDir, root } = makeWorkspace()
    patchConfigFile(dataDir, { exportDir: outDir })
    try {
      stubVendorFeed()
      const runtime = makeRuntime(dataDir)
      const tool = createBatchTool(runtime)

      const result = await tool.execute(
        { items: [{ module: 'main.white-bg' }, { module: 'main.scene' }], project: 'BEXP', concurrency: 1 },
        stubExec,
      )

      assert.equal(result.ok, true)
      assert.equal(result.completed, 2)
      assert.equal(existsSync(outDir), false, '批量同样不得碰导出目录')
      assert.deepEqual(readdirSync(root), ['data'])
      assert.deepEqual(Object.keys(result).filter((key) => /export|outputDir/i.test(key)), [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── E. 导出（用户显式触发） ──────────────────────────────────────────────────

/** 直接用生成的产物造一个项目，供导出用例使用。 */
async function seedProject(dataDir) {
  const runtime = makeRuntime(dataDir)
  stubVendorFeed()
  const result = await runGenerate(runtime)
  assert.equal(result.ok, true)
  return { runtime, id: result.projectId, sourcePath: result.images[0].path }
}

describe('导出项目：dir 覆盖 > exportDir 回退 > 400', () => {
  it('未带 dir → 用配置里的 exportDir，落点是 <exportDir>/<项目 id>/，原件仍在', async () => {
    const { dataDir, outDir, root } = makeWorkspace()
    patchConfigFile(dataDir, { exportDir: outDir })
    try {
      const { runtime, id, sourcePath } = await seedProject(dataDir)
      const bytesBefore = readFileSync(sourcePath)
      // 真实 runtime 才有 configStore 之外的完整面；这里继续用它跑路由
      const realRuntime = makeRuntime(dataDir)
      assert.equal((await realRuntime.config()).exportDir, outDir)

      const result = await call(
        makeFakeWebServer(),
        realRuntime,
        'POST',
        `/pixmart/api/projects/${id}/export`,
        { body: {} },
      )

      assert.equal(result.status, 200)
      assert.equal(result.json.count, 1)
      assert.equal(result.json.dir, join(outDir, id), '落点必须是 <导出路径>/<项目 id>')
      assert.equal(result.json.files[0].startsWith(join(outDir, id)), true)
      assert.equal(existsSync(result.json.files[0]), true)
      assert.equal(readFileSync(result.json.files[0]).equals(bytesBefore), true, '导出的是同一份字节')
      assert.deepEqual(result.json.warnings, [])
      // 只复制、不移动
      assert.equal(existsSync(sourcePath), true, '原件必须仍在数据目录')
      assert.equal(readFileSync(sourcePath).equals(bytesBefore), true)

      // 同一个项目再导一次：同名内容寻址副本复用，不会写坏
      const again = await call(makeFakeWebServer(), realRuntime, 'POST', `/pixmart/api/projects/${id}/export`, {
        body: {},
      })
      assert.equal(again.status, 200)
      assert.equal(again.json.count, 1)
      assert.equal(readdirSync(join(outDir, id)).length, 1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('带 dir → 覆盖配置（配置里的目录不被创建）', async () => {
    const { dataDir, outDir, root } = makeWorkspace()
    const override = join(root, 'override')
    patchConfigFile(dataDir, { exportDir: outDir })
    try {
      const { id, sourcePath } = await seedProject(dataDir)

      const result = await call(
        makeFakeWebServer(),
        makeRuntime(dataDir),
        'POST',
        `/pixmart/api/projects/${id}/export`,
        { body: { dir: override } },
      )

      assert.equal(result.status, 200)
      assert.equal(result.json.dir, join(override, id))
      assert.equal(existsSync(result.json.files[0]), true)
      assert.equal(existsSync(sourcePath), true)
      assert.equal(existsSync(outDir), false, '被覆盖的配置目录不该被创建')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('两者皆无 → 400 no_export_dir，message 明确指向设置页；且不产生任何目录', async () => {
    const { dataDir, root } = makeWorkspace()
    try {
      const { id } = await seedProject(dataDir)

      const result = await call(
        makeFakeWebServer(),
        makeRuntime(dataDir),
        'POST',
        `/pixmart/api/projects/${id}/export`,
        { body: {} },
      )

      assert.equal(result.status, 400)
      assert.equal(result.json.error.code, 'no_export_dir')
      assert.match(result.json.error.message, /设置/)
      assert.match(result.json.error.message, /导出路径/)
      assert.deepEqual(readdirSync(root), ['data'], '没配目录时不许凭空造目录')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('相对路径的 dir → 400 invalid_export_dir（落点取决于进程 cwd，不可预期）', async () => {
    const { dataDir, outDir, root } = makeWorkspace()
    patchConfigFile(dataDir, { exportDir: outDir })
    try {
      const { id } = await seedProject(dataDir)
      const result = await call(
        makeFakeWebServer(),
        makeRuntime(dataDir),
        'POST',
        `/pixmart/api/projects/${id}/export`,
        { body: { dir: 'exports/relative' } },
      )
      assert.equal(result.status, 400)
      assert.equal(result.json.error.code, 'invalid_export_dir')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('不存在的项目 → 404（不会凭空造目录）', async () => {
    const { dataDir, outDir, root } = makeWorkspace()
    patchConfigFile(dataDir, { exportDir: outDir })
    try {
      const result = await call(
        makeFakeWebServer(),
        makeRuntime(dataDir),
        'POST',
        '/pixmart/api/projects/nope/export',
        { body: {} },
      )
      assert.equal(result.status, 404)
      assert.equal(result.json.error.code, 'not_found')
      assert.equal(existsSync(join(outDir, 'nope')), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('导出的目标目录不可写 → 200 + warnings，**原件一个字节都没丢**', async () => {
    const { dataDir, root } = makeWorkspace()
    // 父级是文件：mkdirSync 一定失败（跨平台都抛）
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const badDir = join(blocker, 'out')
    patchConfigFile(dataDir, { exportDir: badDir })
    try {
      const { id, sourcePath } = await seedProject(dataDir)
      const result = await call(
        makeFakeWebServer(),
        makeRuntime(dataDir),
        'POST',
        `/pixmart/api/projects/${id}/export`,
        { body: {} },
      )

      assert.equal(result.status, 200, '复制失败不该把接口变成 500')
      assert.equal(result.json.count, 0)
      assert.equal(result.json.warnings.length, 1, '每张失败都应有可读警告')
      assert.match(result.json.warnings[0], /产物复制失败：/)
      assert.match(result.json.warnings[0], /原件仍在/)
      assert.equal(existsSync(sourcePath), true, '导出失败不得破坏原项目')
      assert.equal(existsSync(join(dataDir, 'projects', id, 'project.json')), true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('项目图片落点挡目录穿越：记录里被写脏的文件名被跳过，不写出目标目录', async () => {
    const { dataDir, outDir, root } = makeWorkspace()
    patchConfigFile(dataDir, { exportDir: outDir })
    try {
      const { id, sourcePath } = await seedProject(dataDir)
      // 手工把 project.json 里的文件名改成越界路径，模拟记录被写脏
      const projectJson = join(dataDir, 'projects', id, 'project.json')
      const record = JSON.parse(readFileSync(projectJson, 'utf8'))
      record.items[0].images[0].file = '../escape.png'
      writeFileSync(projectJson, JSON.stringify(record, null, 2))

      const result = await call(
        makeFakeWebServer(),
        makeRuntime(dataDir),
        'POST',
        `/pixmart/api/projects/${id}/export`,
        { body: {} },
      )

      // 越界的那一张被跳过（不是让整个导出 500 / 400），且没有文件被写到目标之外
      assert.equal(result.status, 200)
      assert.equal(result.json.count, 0, '越界文件名应被跳掉，而不是被复制出去')
      assert.equal(existsSync(join(outDir, 'escape.png')), false)
      assert.equal(existsSync(join(dataDir, 'projects', 'escape.png')), false)
      assert.equal(existsSync(sourcePath), true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── F. 只读工具回传 ──────────────────────────────────────────────────────────

describe('pixmart_providers 回传 exportDir', () => {
  it('已配置时回完整路径，并在文本里说明它只在导出时生效', async () => {
    const { dataDir, outDir, root } = makeWorkspace()
    patchConfigFile(dataDir, { exportDir: outDir })
    try {
      const runtime = makeRuntime(dataDir)
      const tool = createMetaTools(runtime).find((entry) => entry.name === 'pixmart_providers')
      const value = await tool.execute({}, stubExec)

      assert.equal(value.ok, true)
      assert.equal(value.exportDir, outDir)
      const text = tool.output
        .render({}, value)
        .map((block) => String(block.text ?? ''))
        .join('\n')
      assert.ok(text.includes(outDir), '文本里应给出导出路径')
      assert.match(text, /导出/)
      assert.equal(/每张成功的图会另存一份/.test(text), false, '不得再宣称生成时会自动复制')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('未配置时明确说明"图片只在数据目录、要副本去作品库导出"', async () => {
    const { dataDir, root } = makeWorkspace()
    try {
      const runtime = makeRuntime(dataDir)
      const tool = createMetaTools(runtime).find((entry) => entry.name === 'pixmart_providers')
      const value = await tool.execute({}, stubExec)

      assert.equal(value.exportDir, '')
      const text = tool.output
        .render({}, value)
        .map((block) => String(block.text ?? ''))
        .join('\n')
      assert.match(text, /作品库导出路径：未配置/)
      assert.match(text, /作品库/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── G. 迁移在真实 store 上的一次端到端 ───────────────────────────────────────

describe('ConfigStore 上的一次真实迁移', () => {
  it('旧 config.json（只有 outputDir）→ 加载后 exportDir 拿到该值，且不写坏配置', async () => {
    const { dataDir, outDir, root } = makeWorkspace()
    patchConfigFile(dataDir, { outputDir: outDir, exportDir: undefined })
    try {
      const configPath = join(dataDir, 'config.json')
      const textBefore = readFileSync(configPath, 'utf8')
      const before = JSON.parse(textBefore)
      assert.equal(before.outputDir, outDir)
      assert.equal(before.exportDir, undefined, '这份配置必须是"升级上来的旧文件"')

      const store = new ConfigStore(dataDir)
      const loaded = await store.load()
      assert.equal(loaded.config.exportDir, outDir)
      assert.ok(loaded.warnings.some((line) => line.includes('迁移')))
      // load() 是纯读：不该顺手改写用户的配置文件（逐字节比较）
      assert.equal(readFileSync(configPath, 'utf8'), textBefore)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('真实 ProjectStore 上导出：只复制、不移动', async () => {
    const { dataDir, outDir, root } = makeWorkspace()
    patchConfigFile(dataDir, { exportDir: outDir })
    try {
      const store = new ProjectStore(dataDir)
      const record = await store.create('迁移用例', 'mock', 'test-image-model')
      const saved = await store.saveImage(record.id, new Uint8Array(PNG), 'image/png', 'white-bg')
      const { absolutePath, ...image } = saved
      await store.appendItem(record.id, {
        module: 'main.white-bg',
        label: '白底主图',
        prompt: 'p',
        size: '1:1',
        provider: 'mock',
        model: 'test-image-model',
        apiMode: 'images-generations',
        status: 'ok',
        images: [image],
        degraded: [],
        ms: 1,
        createdAt: Date.now(),
      })

      const result = await call(
        makeFakeWebServer(),
        makeRuntime(dataDir),
        'POST',
        `/pixmart/api/projects/${record.id}/export`,
        { body: {} },
      )
      assert.equal(result.status, 200)
      assert.equal(result.json.count, 1)
      assert.equal(existsSync(absolutePath), true, '导出是复制，不是移动')
      assert.equal(existsSync(join(outDir, record.id, image.file.split('/').pop())), true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
