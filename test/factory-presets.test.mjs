/**
 * 出厂清单为空 + 补齐机制保留（用户决策：安装后一个厂商都不带）。
 *
 * **老语义（已废）**：出厂预设是 `[ofox, agnes]`，`load()` 把文件里没有的补进来——
 * 于是"文件里只有 ofox"会变成"内存里有 ofox + agnes"。
 *
 * **新语义（本文件钉住的）**：出厂配置 `providers: []`、`defaults.provider === ''`，
 * 厂商全部由用户从设置页「添加模型提供商」里挑。`applyFactoryPresets` 的出厂清单为空
 * ⇒ 它是 no-op ⇒ `ConfigStore.load()` **任何情况下都不会自动补入厂商**，也不再产生
 * "已从出厂预设补入厂商"的告警：
 *   1. 文件里只有 ofox → load 后仍然只有 ofox，且 ofox 字段**逐字节未变**；
 *   2. 文件里的 `defaults` / `limits` 以文件为准；
 *   3. **幂等**：load 两次，厂商集合不变；
 *   4. **无补齐告警**（反向断言）；
 *   5. **盘上文件未被改写**：load 前后字节级一致；
 *   6. 文件里已有用户自己加的 agnes → 字段不被覆盖；
 *   7. 空文件 / `providers: []` / 全删光（带墓碑）→ 都是 0 家，不补任何人；
 *   8. 补齐**机制本身**仍然可用、性质不变：用**显式** factory 参数喂非空清单时，
 *      只追加缺的、不覆盖已有、跳过 `removedProviders`、不改写磁盘（末尾三条例外断言）。
 *      机制保留是为了将来若再决定"出厂带某家"，改一处 `defaultConfig()` 就能重新生效。
 *
 * 全部走**真实** `ConfigStore` + 真实临时目录，针对 `lib/` 编译产物运行
 * （测的就是宿主会加载的那份代码）。**零网络**：只碰临时目录里的 config.json。
 */
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConfigStore } from '../lib/store/config-store.js'
import {
  applyFactoryPresets,
  defaultAgnesProvider,
  defaultConfig,
  defaultOfoxProvider,
  parseConfig,
} from '../lib/config.js'

/** 哨兵密钥：既证明"密钥从不覆盖"，也让断言失败时能一眼看出哪来的值。 */
const OFOX_SECRET = 'sk-ofox-existing-sentinel-0001'

/**
 * 一份**只有 ofox** 的落盘配置（形状就是实测的用户文件：自定 models、
 * `apiKeyEnv` 被用户清空、limits 也被用户改过）。写完返回路径与字节快照。
 */
function seedOfoxOnlyConfig(dir) {
  const configPath = join(dir, 'config.json')
  const config = {
    version: 1,
    providers: [
      {
        id: 'ofox',
        label: 'Ofox',
        group: 'aggregator',
        baseUrl: 'https://api.ofox.io/v1',
        geminiNativeBaseUrl: 'https://api.ofox.io/gemini/v1beta',
        dialect: 'ofox',
        apiMode: 'images-generations',
        apiKeyEnv: '',
        apiKey: OFOX_SECRET,
        models: ['openai/gpt-image-2', 'google/gemini-3-pro-image'],
        allowedSizes: ['1:1', '3:4', '4:3', '9:16', '16:9'],
        sizeMode: 'whitelist',
        extraHeaders: { 'x-user-note': '用户自己加的' },
        timeoutMs: 123_456,
      },
    ],
    defaults: { provider: 'ofox', model: 'openai/gpt-image-2', size: '1:1', n: 1 },
    limits: { maxConcurrency: 3, maxBatchItems: 7, maxRetries: 0, retentionDays: 30 },
    promptOverrides: {},
    attachmentInConversation: true,
    exportDir: '',
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  return { configPath, seeded: config, before: readFileSync(configPath, 'utf8') }
}

/** 写任意一份落盘配置，返回路径与字节快照。 */
function seedConfig(dir, config) {
  const configPath = join(dir, 'config.json')
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  return { configPath, before: readFileSync(configPath, 'utf8') }
}

let dir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pixmart-presets-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('出厂清单为空：load() 不补任何厂商', () => {
  it('只有 ofox 的文件 → load 后仍然只有 ofox（不再补出 agnes），ofox 字段逐字节未变', async () => {
    const { seeded } = seedOfoxOnlyConfig(dir)
    const store = new ConfigStore(dir)

    const result = await store.load()
    const ids = result.config.providers.map((provider) => provider.id)

    // 1. 一家都不补：出厂清单为空，`load()` 不是"补齐"的入口
    assert.deepEqual(
      ids,
      ['ofox'],
      `出厂清单为空，load 不得补入任何厂商，实际：${JSON.stringify(ids)}`,
    )
    assert.equal(result.config.providers.length, 1)

    // 2. **绝不覆盖**：文件里已有的 ofox 与种下的那份逐字节相同
    const ofox = result.config.providers.find((provider) => provider.id === 'ofox')
    assert.equal(
      JSON.stringify(ofox),
      JSON.stringify(seeded.providers[0]),
      '已有厂商的任何字段都不得被默认值改写',
    )
    assert.equal(ofox.apiKey, OFOX_SECRET)
    assert.equal(ofox.apiKeyEnv, '', '用户清空过的 apiKeyEnv 不得被出厂值复活')
    assert.deepEqual(ofox.models, ['openai/gpt-image-2', 'google/gemini-3-pro-image'])
    assert.equal(ofox.timeoutMs, 123_456, '用户改过的超时也不得被动')
    assert.deepEqual(ofox.extraHeaders, { 'x-user-note': '用户自己加的' })

    // 3. 顺序就是文件里的顺序
    assert.equal(result.config.providers[0].id, 'ofox')
  })

  it('文件里的 defaults 与 limits 以文件为准（未被出厂值改写）', async () => {
    const { seeded } = seedOfoxOnlyConfig(dir)
    const store = new ConfigStore(dir)

    const result = await store.load()

    assert.deepEqual(result.config.defaults, seeded.defaults)
    assert.equal(result.config.defaults.provider, 'ofox')
    assert.equal(result.config.defaults.model, 'openai/gpt-image-2')
    assert.deepEqual(result.config.limits, seeded.limits)
    assert.equal(result.config.limits.maxConcurrency, 3)
    assert.equal(result.config.limits.retentionDays, 30)
    // 其余顶层字段也以文件为准
    assert.equal(result.config.exportDir, '')
    assert.equal(result.config.attachmentInConversation, true)
  })

  it('幂等：load 两次，厂商集合都是 [ofox]', async () => {
    seedOfoxOnlyConfig(dir)
    const store = new ConfigStore(dir)

    const first = await store.load()
    const afterFirst = first.config.providers.map((provider) => provider.id)
    const second = await store.load()
    const afterSecond = second.config.providers.map((provider) => provider.id)

    assert.deepEqual(afterFirst, ['ofox'])
    assert.deepEqual(afterSecond, afterFirst, '第二次 load 不该改变厂商集合')
    assert.equal(second.config.providers.length, 1)
  })

  it('不出现「已从出厂预设补入厂商」告警（没有补，就不该报）', async () => {
    seedOfoxOnlyConfig(dir)
    const store = new ConfigStore(dir)

    const result = await store.load()

    assert.equal(
      result.warnings.some((warning) => warning.includes('补入厂商')),
      false,
      `出厂清单为空时不得有补齐告警，实际：${JSON.stringify(result.warnings)}`,
    )
    assert.ok(
      result.warnings.every((warning) => typeof warning === 'string' && warning !== ''),
      '告警必须都是可读的非空字符串',
    )
  })

  it('盘上文件未被改写：load 前后字节级一致（补齐只发生在内存）', async () => {
    const { configPath, before } = seedOfoxOnlyConfig(dir)
    const store = new ConfigStore(dir)

    await store.load()
    await store.load()

    assert.equal(
      readFileSync(configPath, 'utf8'),
      before,
      'load 是纯读：不得顺手补写用户的 config.json',
    )
    // 盘上也确实没有 agnes
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.deepEqual(
      onDisk.providers.map((provider) => provider.id),
      ['ofox'],
    )
  })

  it('文件里已有 agnes（用户自己加的）→ 字段不被覆盖、也不产生补齐告警', async () => {
    const { configPath } = seedOfoxOnlyConfig(dir)
    const seeded = JSON.parse(readFileSync(configPath, 'utf8'))
    seeded.providers.push({ ...seeded.providers[0], id: 'agnes', label: 'Agnes AI', apiKey: 'sk-agnes-own' })
    writeFileSync(configPath, `${JSON.stringify(seeded, null, 2)}\n`)

    const store = new ConfigStore(dir)
    const result = await store.load()

    assert.deepEqual(result.config.providers.map((provider) => provider.id), ['ofox', 'agnes'])
    assert.equal(
      result.config.providers.find((provider) => provider.id === 'agnes').apiKey,
      'sk-agnes-own',
      '用户自己填的 agnes 密钥不得被任何默认值清掉',
    )
    assert.equal(
      result.warnings.some((warning) => warning.includes('补入厂商')),
      false,
      '没有缺的厂商就不该有补齐告警',
    )
  })

  it('配置文件缺失 → 0 家厂商、无告警（缺文件是"从零开始"）', async () => {
    const store = new ConfigStore(dir)

    const result = await store.load()

    assert.equal(result.warnings.length, 0, '缺文件是"从零开始"，不该告警')
    assert.deepEqual(result.config.providers, [], '出厂配置不带任何厂商')
    assert.equal(result.config.defaults.provider, '', '出厂没有默认厂商')
    assert.equal(result.config.defaults.model, '')
  })

  it('文件里 `providers: []` → load 后仍是 0 家（不会补回任何默认厂商）', async () => {
    seedConfig(dir, {
      version: 1,
      providers: [],
      defaults: { provider: '', model: '', size: '1:1', n: 1 },
      limits: { maxConcurrency: 2, maxBatchItems: 20, maxRetries: 3, retentionDays: 0 },
    })

    const store = new ConfigStore(dir)
    const result = await store.load()

    assert.deepEqual(result.config.providers, [])
    assert.equal(result.config.defaults.provider, '')
    assert.equal(
      result.warnings.some((warning) => warning.includes('补入厂商')),
      false,
    )
  })

  it('删光了一个不剩（带墓碑）→ 重新 load 仍 0 家、不崩、不补齐', async () => {
    seedConfig(dir, {
      version: 1,
      providers: [],
      removedProviders: ['ofox', 'agnes'],
      defaults: { provider: '', model: '', size: '1:1', n: 1 },
      limits: { maxConcurrency: 2, maxBatchItems: 20, maxRetries: 3, retentionDays: 0 },
    })

    const store = new ConfigStore(dir)
    const result = await store.load()

    assert.deepEqual(result.config.providers, [], '一家都不许补回来')
    assert.equal(result.config.defaults.provider, '')
    assert.deepEqual(result.config.removedProviders, ['ofox', 'agnes'], '墓碑原样保留')
    assert.equal(
      result.warnings.some((warning) => warning.includes('补入厂商')),
      false,
    )
  })
})

// ── 机制保留：`applyFactoryPresets` 本身仍是"只追加 / 不覆盖 / 跳过墓碑 / 不写盘" ──

/** 显式构造一份**非空**出厂清单：模拟"将来重新放出厂预设"时的情形。 */
function factoryWithBoth() {
  return {
    ...defaultConfig(),
    providers: [defaultOfoxProvider(), defaultAgnesProvider()],
    defaults: { provider: 'ofox', model: defaultOfoxProvider().models[0], size: '1:1', n: 1 },
  }
}

describe('补齐机制保留（显式喂非空出厂清单时，性质与从前一致）', () => {
  it('文件缺的追加到末尾、apiKey 为空；已有厂商与 defaults / limits 一个字段都不动', () => {
    const { config: fileConfig } = parseConfig({
      version: 1,
      providers: [
        { ...defaultOfoxProvider(), apiKey: OFOX_SECRET, baseUrl: 'https://user.example/v1' },
      ],
      defaults: { provider: 'ofox', model: 'user-model', size: '3:4', n: 2 },
      limits: { maxConcurrency: 3, maxBatchItems: 7, maxRetries: 0, retentionDays: 30 },
    })

    const merged = applyFactoryPresets(fileConfig, factoryWithBoth())

    assert.deepEqual(merged.added, ['agnes'], '只补文件里缺的那家')
    assert.deepEqual(merged.config.providers.map((provider) => provider.id), ['ofox', 'agnes'])
    assert.equal(merged.config.providers[0].apiKey, OFOX_SECRET)
    assert.equal(merged.config.providers[0].baseUrl, 'https://user.example/v1')
    assert.equal(merged.config.providers[1].apiKey, '', '补入的厂商是"尚未配置密钥"状态')
    assert.deepEqual(merged.config.defaults, fileConfig.defaults, 'defaults 以文件为准')
    assert.deepEqual(merged.config.limits, fileConfig.limits, 'limits 以文件为准')

    // 纯函数：入参没被改（只返回新对象）
    assert.deepEqual(fileConfig.providers.map((provider) => provider.id), ['ofox'])
    assert.equal(fileConfig.defaults.provider, 'ofox')
  })

  it('removedProviders 里的 id 不补（墓碑机制）', () => {
    const { config } = parseConfig({
      version: 1,
      providers: [defaultOfoxProvider()],
      removedProviders: ['agnes'],
    })

    const merged = applyFactoryPresets(config, factoryWithBoth())

    assert.deepEqual(merged.added, [], '记了墓碑的 id 不许复活')
    assert.deepEqual(merged.config.providers.map((provider) => provider.id), ['ofox'])
  })

  it('出厂清单为空时恒为 no-op：added 为空、config 原样返回（当前生产语义）', () => {
    const { config } = parseConfig({ version: 1, providers: [defaultOfoxProvider()] })

    const merged = applyFactoryPresets(config)

    assert.deepEqual(merged.added, [])
    assert.equal(merged.config, config, '没有缺的厂商时必须原样返回入参（引用相等）')
  })
})
