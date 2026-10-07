/**
 * 出厂配置为空（0 家厂商）＋「没有厂商可用」时的可操作指引。
 *
 * 用户决策：插件安装后**不预设任何厂商**，全部由用户从设置页「添加模型提供商」里挑。
 * 于是 `defaultConfig()` 是 `providers: []`、`defaults.provider === ''`，而"一家都没配"
 * 成了首次使用最常撞上的失败路径。这个文件钉住两件事：
 *
 *   A. **配置层**：出厂 0 家、`parseConfig` 能吃下 0 家 + 空默认厂商（不崩、不编造厂商）、
 *      `ConfigStore.load()` 不会自动补人、内置默认 `defaultOfoxProvider()` /
 *      `defaultAgnesProvider()` 仍然导出（夹具与目录都靠它们）；
 *   B. **工具层**：四个失败点（check_size / generate·edit / batch）在 0 家时给出**同一句**
 *      可操作指引（含"设置"与"添加模型提供商"），而 `pixmart_providers` / `pixmart_ping`
 *      在 0 家时照常工作（列空清单，不报错）。
 *
 * **零网络**：四个工具都在"解析厂商"这一步就失败，压根走不到厂商请求；`pixmart_ping`
 * 本来就无副作用。全部针对 `lib/` 编译产物运行。
 */
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  NO_PROVIDER_GUIDANCE,
  defaultAgnesProvider,
  defaultConfig,
  defaultOfoxProvider,
  findProvider,
  parseConfig,
  providerNotFoundMessage,
} from '../lib/config.js'
import { ConfigStore } from '../lib/store/config-store.js'
import { catalogView } from '../lib/catalog.js'
import { createBatchTool } from '../lib/tools/batch.js'
import { createGenerateTools } from '../lib/tools/generate.js'
import { createMetaTools } from '../lib/tools/meta.js'
import { createPingTool } from '../lib/tools/ping.js'

// ── 假环境（只提供"解析厂商"之前会用到的那几个面） ─────────────────────────────

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

/** 0 家厂商的运行时：`config()` 直接回传给定配置，不碰磁盘。 */
function makeRuntime(config) {
  return {
    ctx: stubContext,
    dataDir: join(tmpdir(), 'pixmart-empty-factory'),
    dataDirNotes: [],
    projectStore: {
      list: () => [],
      read: () => {
        throw new Error('不该走到这里：0 家厂商应在解析阶段就失败')
      },
      imagesDir: () => join(tmpdir(), 'pixmart-empty-factory', 'projects', 'x', 'images'),
      has: () => false,
      projectsRoot: join(tmpdir(), 'pixmart-empty-factory', 'projects'),
    },
    runStore: {
      list: () => [],
      read: () => {
        throw new Error('not found')
      },
      cancel: () => false,
    },
    usage: {
      file: join(tmpdir(), 'pixmart-empty-factory', 'usage.jsonl'),
      summary: () => ({ requests: 0, ok: 0, failed: 0, images: 0, byModel: {} }),
      read: () => [],
      append: () => {},
    },
    config: async () => config,
    configWarnings: () => [],
  }
}

function toolNamed(runtime, name) {
  const tools = [
    ...createMetaTools(runtime),
    ...createGenerateTools(runtime),
    createBatchTool(runtime),
  ]
  const tool = tools.find((entry) => entry.name === name)
  assert.ok(tool, `必须注册 ${name}`)
  return tool
}

/** 断言一条失败返回带上了"去哪、做什么"的指引。 */
function assertGuidance(value, label) {
  assert.equal(value.ok, false, `${label} 必须失败（0 家厂商）`)
  const message = String(value.error?.message ?? '')
  assert.equal(message, NO_PROVIDER_GUIDANCE, `${label} 的文案应是统一指引，实际：${message}`)
  assert.ok(message.includes('添加模型提供商'), `${label} 的文案必须点明「添加模型提供商」`)
  assert.ok(message.includes('设置'), `${label} 的文案必须点明「设置」`)
  assert.ok(message.includes('厂商'), `${label} 的文案必须点明「厂商」`)
  assert.equal(message.includes('解析失败'), false, `${label} 不能只说"解析失败"`)
}

let dir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pixmart-empty-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ── A. 配置层 ────────────────────────────────────────────────────────────────

describe('出厂配置：0 家厂商', () => {
  it('defaultConfig()：providers 为空、defaults.provider / model 是空串', () => {
    const config = defaultConfig()

    assert.equal(config.providers.length, 0, '出厂不得预设任何厂商')
    assert.deepEqual(config.providers, [])
    assert.equal(config.defaults.provider, '', '空串 = 尚未选择（不是某家厂商）')
    assert.equal(config.defaults.model, '')
    assert.equal(config.defaults.size, '1:1', '尺寸默认值不变')
    assert.equal(config.defaults.n, 1, '张数默认值不变')
    assert.deepEqual(config.removedProviders, [])
  })

  it('内置默认仍然导出（测试夹具 / 目录 / 将来重新放出厂预设都用它）', () => {
    const ofox = defaultOfoxProvider()
    const agnes = defaultAgnesProvider()

    assert.equal(ofox.id, 'ofox')
    assert.equal(agnes.id, 'agnes')
    assert.ok(ofox.models.length > 0)
    assert.ok(agnes.models.length > 0)
    assert.equal(ofox.apiKey, '')
    assert.equal(agnes.apiKey, '')
  })

  it('findProvider 在 0 家时返回 undefined（不猜、不编造）', () => {
    const config = defaultConfig()

    assert.equal(findProvider(config), undefined, '默认厂商是空串 → 取不到')
    assert.equal(findProvider(config, 'ofox'), undefined, '没配就是没配')
  })

  it('parseConfig({})：0 家、空默认厂商、不崩', () => {
    const result = parseConfig({})

    assert.equal(result.config.providers.length, 0)
    assert.equal(result.config.defaults.provider, '')
    assert.equal(result.config.defaults.model, '')
    assert.ok(result.warnings.some((warning) => warning.includes('providers 缺失')))
  })

  it('parseConfig({ providers: [] })：0 家、空默认厂商、无告警', () => {
    const result = parseConfig({ providers: [] })

    assert.deepEqual(result.config.providers, [])
    assert.equal(result.config.defaults.provider, '')
    assert.equal(result.config.defaults.model, '')
    assert.deepEqual(result.warnings, [], '显式空清单是合法配置，不该告警')
  })

  it('parseConfig：0 家但 defaults.provider 指向某家 → 清空并告警，**不编造**厂商', () => {
    const result = parseConfig({ providers: [], defaults: { provider: 'ofox' } })

    assert.deepEqual(result.config.providers, [], '不许凭空造出 ofox')
    assert.equal(result.config.defaults.provider, '')
    assert.equal(result.config.defaults.model, '')
    assert.ok(
      result.warnings.some(
        (warning) => warning.includes('defaults.provider') && warning.includes('已清空'),
      ),
      `应有"已清空"的告警，实际：${JSON.stringify(result.warnings)}`,
    )
  })

  it('parseConfig：有厂商但默认厂商 id 不存在 → 仍纠正到文件里的第一家（信息型告警）', () => {
    const result = parseConfig({
      providers: [{ id: 'ofox', baseUrl: 'https://api.example.test/v1' }],
      defaults: { provider: 'ghost' },
    })

    assert.deepEqual(result.config.providers.map((provider) => provider.id), ['ofox'])
    assert.equal(result.config.defaults.provider, 'ofox')
    assert.ok(result.warnings.some((warning) => warning.includes('已改用 "ofox"')))
  })

  it('ConfigStore.load() 不会自动补人：空文件 / 只有 1 家 / 删光了 都是文件说了算', async () => {
    // 1) 空文件
    writeFileSync(join(dir, 'config.json'), `${JSON.stringify({ version: 1, providers: [] })}\n`)
    const empty = new ConfigStore(dir)
    const emptyResult = await empty.load()
    assert.deepEqual(emptyResult.config.providers, [], '空清单 load 后仍是空')

    // 2) 只有 1 家
    writeFileSync(
      join(dir, 'config.json'),
      `${JSON.stringify({ version: 1, providers: [defaultOfoxProvider()], defaults: { provider: 'ofox' } })}\n`,
    )
    const one = new ConfigStore(dir)
    const oneResult = await one.load()
    assert.deepEqual(oneResult.config.providers.map((provider) => provider.id), ['ofox'])

    // 3) 删光了（带墓碑）
    writeFileSync(
      join(dir, 'config.json'),
      `${JSON.stringify({
        version: 1,
        providers: [],
        removedProviders: ['ofox', 'agnes'],
        defaults: { provider: '', model: '' },
      })}\n`,
    )
    const none = new ConfigStore(dir)
    const noneResult = await none.load()
    assert.deepEqual(noneResult.config.providers, [], '删光了不许复活')
    for (const result of [emptyResult, oneResult, noneResult]) {
      assert.equal(
        result.warnings.some((warning) => warning.includes('补入厂商')),
        false,
        `不该有补齐告警，实际：${JSON.stringify(result.warnings)}`,
      )
    }
  })
})

// ── B. 「找不到厂商」文案 ────────────────────────────────────────────────────

describe('providerNotFoundMessage：0 家用指引，有厂商用信息型文案', () => {
  it('0 家 → 可操作指引（去哪、做什么）', () => {
    const message = providerNotFoundMessage(defaultConfig())

    assert.equal(message, NO_PROVIDER_GUIDANCE)
    assert.ok(message.includes('设置'))
    assert.ok(message.includes('添加模型提供商'))
  })

  it('有厂商但 id 不存在 → 保留"已配置：…"的信息型文案', () => {
    const config = parseConfig({
      providers: [defaultOfoxProvider()],
      defaults: { provider: 'ofox' },
    }).config

    const message = providerNotFoundMessage(config, 'ghost')

    assert.equal(message, '找不到厂商 "ghost"；已配置：ofox')
    assert.equal(message.includes('添加模型提供商'), false, '这种情况不需要"去添加"的指引')
  })
})

// ── C. 四个失败点：0 家时给出同一句指引 ──────────────────────────────────────

describe('0 家厂商时四个工具的失败文案', () => {
  it('pixmart_check_size → 指引', async () => {
    const runtime = makeRuntime(defaultConfig())
    const tool = toolNamed(runtime, 'pixmart_check_size')

    const value = await tool.execute({ size: '1:1' }, stubExec)
    assertGuidance(value, 'pixmart_check_size')
  })

  it('pixmart_generate → 指引', async () => {
    const runtime = makeRuntime(defaultConfig())
    const tool = toolNamed(runtime, 'pixmart_generate')

    const value = await tool.execute({ module: 'main.white-bg' }, stubExec)
    assertGuidance(value, 'pixmart_generate')
  })

  it('pixmart_edit → 指引（先过参考图空断言之外：显式给 provider）', async () => {
    const runtime = makeRuntime(defaultConfig())
    const tool = toolNamed(runtime, 'pixmart_edit')

    // edit 需要参考图，但"厂商解析"发生在读参考图之前失败点上；这里给一个不存在的路径
    // 也无妨——0 家厂商必须在更早的一步就被挡下。
    const value = await tool.execute(
      { module: 'tool.white-bg', referencePaths: ['D:/nope/never.png'] },
      stubExec,
    )
    assertGuidance(value, 'pixmart_edit')
  })

  it('pixmart_batch → 指引', async () => {
    const runtime = makeRuntime(defaultConfig())
    const tool = toolNamed(runtime, 'pixmart_batch')

    const value = await tool.execute({ items: [{ module: 'detail.hero' }] }, stubExec)
    assertGuidance(value, 'pixmart_batch')
  })
})

// ── D. 0 家时仍要照常工作的两个工具 ─────────────────────────────────────────

describe('0 家厂商时 pixmart_providers / pixmart_ping 照常工作', () => {
  it('pixmart_providers：ok、空清单、目录全未添加、不报错', async () => {
    const runtime = makeRuntime(defaultConfig())
    const tool = toolNamed(runtime, 'pixmart_providers')

    const value = await tool.execute({}, stubExec)
    // 目录条数不写死（`src/catalog.ts` 的清单本身由 catalog.test.mjs 钉住），只钉"一家都没加"
    const catalogSize = catalogView([]).length

    assert.equal(value.ok, true, '0 家是正常状态，不是错误')
    assert.deepEqual(value.providerIds, [])
    assert.equal(value.defaultProvider, '')
    assert.equal(value.defaultModel, '')
    assert.equal(value.catalog.length, catalogSize)
    assert.equal(
      value.catalog.filter((entry) => entry.added).length,
      0,
      '一家都没加，catalog 的 added 必须全为 false',
    )
    // 渲染出来也要能读（模型看的是这段文本）
    const [block] = tool.output.render({}, value)
    assert.ok(block.text.includes('厂商配置'))
    assert.ok(block.text.includes(`未添加 ${catalogSize} 家`))
  })

  it('pixmart_providers（只查某一家）：0 家时也是空清单，不报错', async () => {
    const runtime = makeRuntime(defaultConfig())
    const tool = toolNamed(runtime, 'pixmart_providers')

    const value = await tool.execute({ provider: 'ofox' }, stubExec)

    assert.equal(value.ok, true)
    assert.deepEqual(value.providerIds, [])
  })

  it('pixmart_ping：与厂商配置无关，0 家时照常返回 ok', async () => {
    const tool = createPingTool(stubContext, join(tmpdir(), 'pixmart-empty-factory'))

    const value = await tool.execute({ echo: 'hi' }, stubExec)

    assert.equal(value.ok, true)
    assert.equal(value.echo, 'hi')
    assert.equal(typeof value.version, 'string')
  })
})
