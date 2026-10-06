/**
 * 「生成图自动落到会话工作区 `pixmart-out/`」的契约测试。
 *
 * 背景（决定了本文件测什么）：DSH 官方内嵌写法 `![说明](<路径>)` **只能渲染会话
 * 工作区之内**的路径——客户端把工作区内的路径转成 `session` 作用域的
 * `dsh-resource://` 地址，工作区之外的绝对路径保留绝对地址，界面上就是「图片无法
 * 预览」。插件产物落在数据目录（`$DSH_HOME/pixmart`，在工作区之外），所以每张成功
 * 落盘的图都要**复制**一份到 `<工作区>/pixmart-out/<项目 id>/`。
 *
 * 会话工作区取自 `exec.agent.session.header.cwd`（取证见 src/tools/workspace-copy.ts
 * 顶部：官方 dsh-tool-fs 的 sessionCwd / dsh-tool-present 读的都是它，dsh-agent-loop
 * 把整个 Agent 对象放进执行输入）。
 *
 * 覆盖：
 *   A. 已知工作区：generate / edit / batch 都产出副本，原件仍在；
 *   B. 内容寻址：`<sha8>-<原名>`，同内容复用、同名不同内容不互相覆盖；
 *   C. 复制失败降级：目标父级是文件 → 仍 `ok: true`、有警告、原件没丢、文本里有警告；
 *   D. 拿不到工作区 / 工作区是相对路径 → 不复制、不报错、结果里没有 workspaceOut；
 *   E. `.gitignore` 用 `git check-ignore` 实测命中，且规则锚定到仓库根；
 *   F. 工具结果**文本**里列出副本的完整路径（Agent 才有稳定路径可用）；
 *   G. 与 `exportDir`（用户点「导出」用的路径）并存互不干扰。
 *
 * **零真实网络 / 零真实厂商调用**：厂商侧一律 stub `globalThis.fetch`。
 */
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createRuntime } from '../lib/tools/runtime.js'
import { createGenerateTools } from '../lib/tools/generate.js'
import { createBatchTool } from '../lib/tools/batch.js'
import {
  WORKSPACE_OUT_DIR,
  copyImagesToWorkspace,
  sessionWorkspace,
} from '../lib/tools/workspace-copy.js'

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const PNG = Buffer.from(PNG_B64, 'base64')

/** 仓库根：本文件在 `test/` 下，因此上两级就是根。 */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const stubContext = {
  tools: { register: () => () => {}, schemas: () => [] },
  get: () => undefined,
  effect: () => {},
  on: () => () => {},
}

/** 无 agent 的执行上下文（= 拿不到会话工作区的那种调用）。 */
const bareExec = {
  callId: 'test',
  signal: { aborted: false, addEventListener: () => {} },
  deferContext: () => {},
  concludeTurn: () => {},
}

/** 带会话工作区的执行上下文：形状与宿主一致（`agent.session.header.cwd`）。 */
function execIn(workspace) {
  return { ...bareExec, agent: { id: 'agent-test', session: { header: { cwd: workspace } } } }
}

const savedFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = savedFetch
})

// ── 夹具 ─────────────────────────────────────────────────────────────────────

/**
 * 造一个临时世界：`<root>/data` 是插件数据目录，`<root>/ws` 是**会话工作区**。
 * 两者刻意分开，这样"副本进了工作区、原件还在数据目录"是可断言的。
 */
function makeWorld({ withWorkspace = true } = {}) {
  // 前缀刻意**不含** `pixmart-out`：夹具路径本身不该让"文本里出现过该字符串"的断言变假。
  const root = mkdtempSync(join(tmpdir(), 'pixmart-wsout-'))
  const dataDir = join(root, 'data')
  const workspace = join(root, 'ws')
  mkdirSync(dataDir, { recursive: true })
  if (withWorkspace) mkdirSync(workspace, { recursive: true })

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
    attachmentInConversation: false,
    exportDir: '',
  }
  writeFileSync(join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`)
  return { root, dataDir, workspace, config }
}

function patchConfigFile(dataDir, patch) {
  const configPath = join(dataDir, 'config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  Object.assign(config, patch)
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
}

function makeRuntime(dataDir) {
  return createRuntime(stubContext, { dataDir })
}

/** stub 厂商端点：每帧 PNG 后追加唯一标记，避免内容寻址把多次产出折叠成同一文件。 */
function stubVendorFeed() {
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    const bytes = Buffer.concat([PNG, Buffer.from(`\n<!-- #${calls} -->`)])
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

function toolNamed(runtime, name) {
  const tools = [...createGenerateTools(runtime), createBatchTool(runtime)]
  const tool = tools.find((entry) => entry.name === name)
  assert.ok(tool, `必须注册 ${name}`)
  return tool
}

/** 工具结果渲染出的纯文本（第 6 项要求：文本里要有副本路径）。 */
function renderedText(tool, value) {
  return tool.output
    .render({}, value)
    .map((block) => String(block.text ?? ''))
    .join('\n')
}

function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

// ── 0. 会话工作区的来源本身 ──────────────────────────────────────────────────

describe('sessionWorkspace：只认绝对路径的会话工作区', () => {
  it('读 `exec.agent.session.header.cwd`', () => {
    assert.equal(sessionWorkspace(execIn('C:\\ws\\demo')), 'C:\\ws\\demo')
  })

  it('非 agent 调用（无 agent 字段）→ undefined', () => {
    assert.equal(sessionWorkspace(bareExec), undefined)
    assert.equal(sessionWorkspace({ ...bareExec, agent: {} }), undefined)
    assert.equal(sessionWorkspace({ ...bareExec, agent: { id: 'a', session: {} } }), undefined)
    assert.equal(sessionWorkspace({ ...bareExec, agent: { id: 'a', session: { header: {} } } }), undefined)
  })

  it('空串 / 纯空白 / 类型不对 → undefined', () => {
    assert.equal(sessionWorkspace(execIn('')), undefined)
    assert.equal(sessionWorkspace(execIn('   ')), undefined)
    assert.equal(sessionWorkspace(execIn(42)), undefined)
  })

  it('相对路径 → undefined（落点取决于宿主进程 cwd，不可预期，宁可不复制）', () => {
    assert.equal(sessionWorkspace(execIn('relative/ws')), undefined)
    assert.equal(sessionWorkspace(execIn('.')), undefined)
  })
})

// ── A. 已知工作区：副本产生，原件仍在 ────────────────────────────────────────

describe('A. 已知会话工作区时自动复制', () => {
  it('generate → 副本在 <ws>/pixmart-out/<projectId>/，原件仍在数据目录', async () => {
    const { root, dataDir, workspace } = makeWorld()
    try {
      stubVendorFeed()
      const runtime = makeRuntime(dataDir)
      const tool = toolNamed(runtime, 'pixmart_generate')
      const result = await tool.execute({ module: 'main.white-bg', project: 'WS' }, execIn(workspace))

      assert.equal(result.ok, true)
      assert.equal(result.images.length, 1)

      // ① 原件：仍在数据目录内，且字节可读
      const source = result.images[0].path
      assert.equal(source.startsWith(dataDir), true, '原件必须留在数据目录')
      const originalBytes = readFileSync(source)

      // ② 副本：落在工作区内的 pixmart-out/<项目 id>/
      assert.ok(result.workspaceOut, '结果里必须带副本信息')
      assert.equal(result.workspaceOut.workspace, workspace)
      assert.equal(result.workspaceOut.dir, join(workspace, WORKSPACE_OUT_DIR, result.projectId))
      assert.deepEqual(result.workspaceOut.warnings, [])
      assert.equal(result.workspaceOut.files.length, 1)

      const copy = result.workspaceOut.files[0]
      assert.equal(copy.startsWith(join(workspace, WORKSPACE_OUT_DIR, result.projectId)), true)
      assert.equal(existsSync(copy), true)
      assert.equal(readFileSync(copy).equals(originalBytes), true, '副本必须是同一份字节')

      // ③ 目标目录里只有这一份，且文件名是 <sha8>-<原名>
      assert.deepEqual(readdirSync(join(workspace, WORKSPACE_OUT_DIR, result.projectId)), [
        copy.split(/[\\/]/).pop(),
      ])
      assert.match(copy.split(/[\\/]/).pop(), /^[0-9a-f]{8}-/)

      // ④ 原件一个字节都没少 / 没被搬走
      assert.equal(existsSync(source), true, '只复制，绝不移动原件')
      assert.equal(readFileSync(source).equals(originalBytes), true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('pixmart_edit（图生图）同样复制，参考图不被搬动', async () => {
    const { root, dataDir, workspace } = makeWorld()
    try {
      stubVendorFeed()
      const runtime = makeRuntime(dataDir)
      const reference = join(workspace, 'ref.png')
      writeFileSync(reference, PNG)
      const before = readFileSync(reference)

      const tool = toolNamed(runtime, 'pixmart_edit')
      const result = await tool.execute(
        { module: 'main.white-bg', project: 'WSE', referencePaths: [reference] },
        execIn(workspace),
      )

      assert.equal(result.ok, true)
      assert.equal(result.workspaceOut.files.length, 1)
      assert.equal(existsSync(result.workspaceOut.files[0]), true)
      assert.equal(readFileSync(reference).equals(before), true, '参考图不得被移动或改写')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('pixmart_batch：每项都留下副本，聚合结果列出全部路径', async () => {
    const { root, dataDir, workspace } = makeWorld()
    try {
      stubVendorFeed()
      const runtime = makeRuntime(dataDir)
      const tool = toolNamed(runtime, 'pixmart_batch')
      const result = await tool.execute(
        {
          items: [{ module: 'main.white-bg' }, { module: 'main.scene' }],
          project: 'WSB',
          concurrency: 1,
        },
        execIn(workspace),
      )

      assert.equal(result.ok, true)
      assert.equal(result.completed, 2)
      assert.equal(result.workspaceOut.dir, join(workspace, WORKSPACE_OUT_DIR, result.projectId))
      assert.equal(result.workspaceOut.files.length, 2)
      for (const file of result.workspaceOut.files) assert.equal(existsSync(file), true)
      assert.equal(readdirSync(result.workspaceOut.dir).length, 2)

      // 原件仍在数据目录里（两件产出）
      const imagesDir = runtime.projectStore.imagesDir(result.projectId)
      assert.equal(readdirSync(imagesDir).length, 2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── B. 内容寻址 ──────────────────────────────────────────────────────────────

describe('B. 副本命名内容寻址：同名不互相覆盖', () => {
  it('同内容重复复制 → 复用同一份，不再多写一个文件', () => {
    const { root, dataDir, workspace } = makeWorld()
    try {
      const sourceDir = join(dataDir, 'src')
      mkdirSync(sourceDir, { recursive: true })
      const source = join(sourceDir, 'white-bg.png')
      writeFileSync(source, PNG)

      const sources = [{ absolutePath: source, sha256: sha256Of(PNG) }]
      const first = copyImagesToWorkspace(execIn(workspace), 'P1', sources)
      const second = copyImagesToWorkspace(execIn(workspace), 'P1', sources)

      assert.equal(first.files.length, 1)
      assert.equal(second.files.length, 1)
      assert.equal(second.files[0], first.files[0], '同内容应复用同一路径')
      assert.equal(readdirSync(join(workspace, WORKSPACE_OUT_DIR, 'P1')).length, 1)
      assert.equal(readFileSync(first.files[0]).equals(PNG), true)
      assert.equal(existsSync(source), true, '复制不改动源文件')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('同名但内容不同 → 两个文件，谁都不覆盖谁（<sha8> 前缀区分）', () => {
    const { root, dataDir, workspace } = makeWorld()
    try {
      const a = Buffer.concat([PNG, Buffer.from('\n<!-- a -->')])
      const b = Buffer.concat([PNG, Buffer.from('\n<!-- b -->')])
      const dirA = join(dataDir, 'a')
      const dirB = join(dataDir, 'b')
      mkdirSync(dirA, { recursive: true })
      mkdirSync(dirB, { recursive: true })
      const fileA = join(dirA, 'x.png')
      const fileB = join(dirB, 'x.png')
      writeFileSync(fileA, a)
      writeFileSync(fileB, b)

      const outcome = copyImagesToWorkspace(execIn(workspace), 'P2', [
        { absolutePath: fileA, sha256: sha256Of(a) },
        { absolutePath: fileB, sha256: sha256Of(b) },
      ])

      assert.equal(outcome.files.length, 2)
      assert.equal(new Set(outcome.files).size, 2, '同名不同内容必须落成两个不同文件名')
      assert.equal(readdirSync(join(workspace, WORKSPACE_OUT_DIR, 'P2')).length, 2)
      assert.equal(readFileSync(outcome.files[0]).equals(a), true)
      assert.equal(readFileSync(outcome.files[1]).equals(b), true)
      // 内容寻址前缀 = 各自 sha256 的前 8 位
      assert.equal(outcome.files[0].split(/[\\/]/).pop(), `${sha256Of(a).slice(0, 8)}-x.png`)
      assert.equal(outcome.files[1].split(/[\\/]/).pop(), `${sha256Of(b).slice(0, 8)}-x.png`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('未匹配到同名哈希前缀时也只会加一层前缀（不出现双 <sha8>-<sha8>-）', async () => {
    const { root, dataDir, workspace } = makeWorld()
    try {
      stubVendorFeed()
      const runtime = makeRuntime(dataDir)
      const result = await toolNamed(runtime, 'pixmart_generate').execute(
        { module: 'main.white-bg', project: 'WSD' },
        execIn(workspace),
      )
      const name = result.workspaceOut.files[0].split(/[\\/]/).pop()
      assert.equal(/^[0-9a-f]{8}-[0-9a-f]{8}-/.test(name), false, `不该出现双前缀：${name}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── C. 复制失败降级 ──────────────────────────────────────────────────────────

describe('C. 复制失败不能让生图失败', () => {
  it('pixmart-out 的父级是文件 → 仍 ok:true、有警告（含原件路径）、原件仍在', async () => {
    const { root, dataDir, workspace } = makeWorld()
    try {
      // 把 `<ws>/pixmart-out` 造成一个**文件**：mkdirSync(<ws>/pixmart-out/<id>) 必然失败。
      writeFileSync(join(workspace, WORKSPACE_OUT_DIR), 'not a directory')

      stubVendorFeed()
      const runtime = makeRuntime(dataDir)
      const tool = toolNamed(runtime, 'pixmart_generate')
      const result = await tool.execute({ module: 'main.white-bg', project: 'WSF' }, execIn(workspace))

      assert.equal(result.ok, true, '副本失败绝不能把生图判成失败（图已生成且已付费）')
      assert.deepEqual(result.workspaceOut.files, [])
      assert.equal(result.workspaceOut.warnings.length, 1)
      assert.match(result.workspaceOut.warnings[0], /产物复制失败/)
      assert.match(result.workspaceOut.warnings[0], /原件仍在/)

      // 原件必须完好
      const source = result.images[0].path
      assert.equal(existsSync(source), true, '复制失败不得破坏原件')
      assert.equal(readFileSync(source).length > 0, true)

      // 文本里要能看到这条警告（否则 Agent 以为副本好了）
      const text = renderedText(tool, result)
      assert.match(text, /产物复制失败/)
      assert.equal(existsSync(join(workspace, WORKSPACE_OUT_DIR)), true)
      assert.equal(readFileSync(join(workspace, WORKSPACE_OUT_DIR), 'utf8'), 'not a directory')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('目标目录建不出来（父级是文件）→ 批量同样不失败、原件仍在', async () => {
    const { root, dataDir, workspace } = makeWorld()
    try {
      writeFileSync(join(workspace, WORKSPACE_OUT_DIR), 'blocker')
      stubVendorFeed()
      const runtime = makeRuntime(dataDir)
      const result = await toolNamed(runtime, 'pixmart_batch').execute(
        { items: [{ module: 'main.white-bg' }], project: 'WSFB' },
        execIn(workspace),
      )

      assert.equal(result.ok, true)
      assert.equal(result.completed, 1)
      assert.equal(result.workspaceOut.warnings.length, 1)
      assert.match(result.workspaceOut.warnings[0], /原件仍在/)
      // 原件照旧在数据目录里（副本失败与它无关）
      const imagesDir = runtime.projectStore.imagesDir(result.projectId)
      assert.equal(readdirSync(imagesDir).length, 1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── D. 拿不到工作区 ──────────────────────────────────────────────────────────

describe('D. 拿不到会话工作区时：不复制、不报错', () => {
  it('无 agent → 工具正常返回，结果里没有 workspaceOut，磁盘上也没有 pixmart-out', async () => {
    const { root, dataDir } = makeWorld({ withWorkspace: false })
    try {
      stubVendorFeed()
      const runtime = makeRuntime(dataDir)
      const tool = toolNamed(runtime, 'pixmart_generate')
      const result = await tool.execute({ module: 'main.white-bg', project: 'NOW' }, bareExec)

      assert.equal(result.ok, true)
      assert.equal('workspaceOut' in result, false, '没有工作区就不该出现这个字段')
      assert.equal(existsSync(result.images[0].path), true, '原件照旧落盘')
      assert.deepEqual(readdirSync(root), ['data'], '拿不到工作区时不许往任何别处写')
      // 文本里不应出现任何副本路径
      assert.equal(/pixmart-out/.test(renderedText(tool, result)), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('工作区是相对路径 → 同样当作"没有工作区"（绝不退化成 process.cwd()）', async () => {
    const { root, dataDir } = makeWorld({ withWorkspace: false })
    try {
      stubVendorFeed()
      const result = await toolNamed(makeRuntime(dataDir), 'pixmart_generate').execute(
        { module: 'main.white-bg', project: 'REL' },
        execIn('relative/ws'),
      )
      assert.equal(result.ok, true)
      assert.equal('workspaceOut' in result, false)
      assert.deepEqual(readdirSync(root), ['data'], '相对工作区不许被当成可写目标')
      // 真正的反面对照：如果实现退化成 `resolve(process.cwd(), 'relative/ws')`，
      // 这里就会多出一个 <进程 cwd>/relative/ 目录。
      assert.equal(existsSync(join(process.cwd(), 'relative')), false, '绝不许退化成 process.cwd()')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('批量同样：无工作区时正常返回、无副本字段', async () => {
    const { root, dataDir } = makeWorld({ withWorkspace: false })
    try {
      stubVendorFeed()
      const result = await toolNamed(makeRuntime(dataDir), 'pixmart_batch').execute(
        { items: [{ module: 'main.white-bg' }], project: 'NOWB' },
        bareExec,
      )
      assert.equal(result.ok, true)
      assert.equal('workspaceOut' in result, false)
      assert.deepEqual(readdirSync(root), ['data'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('copyImagesToWorkspace 直接调用：无工作区 / 无图 → undefined（不抛）', () => {
    assert.equal(copyImagesToWorkspace(bareExec, 'P', [{ absolutePath: 'x', sha256: 'a' }]), undefined)
    assert.equal(copyImagesToWorkspace(execIn('C:\\ws'), 'P', []), undefined)
  })
})

describe('C2. 项目 id 写脏也不许写到工作区之外', () => {
  it('越界项目 id → 收敛成警告，工作区外一个字节都没写', () => {
    const { root, dataDir, workspace } = makeWorld()
    try {
      const sourceDir = join(dataDir, 'src')
      mkdirSync(sourceDir, { recursive: true })
      const source = join(sourceDir, 'x.png')
      writeFileSync(source, PNG)

      const outcome = copyImagesToWorkspace(execIn(workspace), '../../escape', [
        { absolutePath: source, sha256: sha256Of(PNG) },
      ])

      assert.equal(outcome.files.length, 0)
      assert.equal(outcome.warnings.length, 1)
      assert.match(outcome.warnings[0], /产物复制失败/)
      assert.match(outcome.warnings[0], /原件仍在/)
      assert.equal(existsSync(join(root, 'escape')), false, '不许把副本写到工作区之外')
      assert.equal(existsSync(source), true, '原件不得被动到')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── E. .gitignore ────────────────────────────────────────────────────────────

describe('E. `.gitignore` 必须挡住工作区里的 pixmart-out/', () => {
  it('`git check-ignore -v` 命中 /pixmart-out/（否则每次生图都污染仓库）', () => {
    const probe = `${WORKSPACE_OUT_DIR}/2026-01-01-白底主图/ab12cd34-white-bg.png`
    const result = spawnSync('git', ['check-ignore', '-v', probe], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    assert.equal(result.error, undefined, `git 不可用：${String(result.error)}`)
    assert.equal(result.status, 0, `应被忽略，实际 status=${result.status}：${result.stdout}`)
    assert.match(result.stdout, /\/pixmart-out\//)
  })

  it('规则锚定仓库根：嵌套的同名目录不受影响（避免误伤源码/夹具）', () => {
    const result = spawnSync('git', ['check-ignore', '-v', 'src/pixmart-out/probe.png'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    assert.equal(result.status, 1, '嵌套同名目录不该被忽略——规则必须写成 /pixmart-out/')
    assert.equal(result.stdout.trim(), '')
  })
})

// ── F. 工具结果文本里给出副本完整路径 ────────────────────────────────────────

describe('F. 工具结果文本列出副本路径', () => {
  it('generate 文本里逐条列出副本的完整路径', async () => {
    const { root, dataDir, workspace } = makeWorld()
    try {
      stubVendorFeed()
      const tool = toolNamed(makeRuntime(dataDir), 'pixmart_generate')
      const result = await tool.execute({ module: 'main.white-bg', project: 'TXT' }, execIn(workspace))
      const text = renderedText(tool, result)

      assert.equal(text.includes(result.workspaceOut.files[0]), true, '必须给出副本的完整路径')
      assert.match(text, /副本/)
      // 原件路径也还在（数据目录是唯一真相，两条路径都要能看见）
      assert.equal(text.includes(result.images[0].path), true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('批量文本里列出每一张副本', async () => {
    const { root, dataDir, workspace } = makeWorld()
    try {
      stubVendorFeed()
      const tool = toolNamed(makeRuntime(dataDir), 'pixmart_batch')
      const result = await tool.execute(
        { items: [{ module: 'main.white-bg' }, { module: 'main.scene' }], project: 'TXTB', concurrency: 1 },
        execIn(workspace),
      )
      const text = renderedText(tool, result)
      for (const file of result.workspaceOut.files) {
        assert.equal(text.includes(file), true, `文本里缺少副本路径：${file}`)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── G. 与 exportDir 并存互不干扰 ─────────────────────────────────────────────

describe('G. 自动副本与 exportDir（手动导出路径）并存', () => {
  it('配了 exportDir 也不影响自动副本；反过来自动副本不碰 exportDir', async () => {
    const { root, dataDir, workspace } = makeWorld()
    const exportDir = join(root, 'manual-export')
    try {
      patchConfigFile(dataDir, { exportDir })
      stubVendorFeed()
      const runtime = makeRuntime(dataDir)
      const result = await toolNamed(runtime, 'pixmart_generate').execute(
        { module: 'main.white-bg', project: 'BOTH' },
        execIn(workspace),
      )

      assert.equal(result.ok, true)
      // 自动副本照旧进工作区
      assert.equal(result.workspaceOut.files.length, 1)
      assert.equal(existsSync(result.workspaceOut.files[0]), true)
      // 手动导出路径**一个字节都没被碰**（导出只在用户点「导出」时发生）
      assert.equal(existsSync(exportDir), false)
      // 结果里也不该出现任何导出字段（导出是路由的事，不是生成的事）
      assert.deepEqual(
        Object.keys(result).filter((key) => /export|outputDir/i.test(key)),
        [],
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
