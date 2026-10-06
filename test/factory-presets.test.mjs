/**
 * 出厂厂商预设对**已有配置**的补齐（设计缺口修复，2026-10-12）。
 *
 * 缺口是什么（实测，不是推测）：用户磁盘上的 `config.json` 建于只有 ofox 的年代，
 * 而 `ConfigStore.load()` 原本"文件解析成功即完全采用文件内容"，于是代码里后加的
 * agnes 对已有安装**永远不可见**。这不是 agnes 的特例——以后每加一个厂商都会重现。
 *
 * 本文件钉住修复后的六条边界（全部走**真实** `ConfigStore` + 真实临时目录，
 * 针对 `lib/` 编译产物运行，测的就是宿主会加载的那份代码）：
 *   1. 文件里只有 ofox → load 后内存里出现 agnes（`apiKey` 为空 = 未配置），
 *      且 ofox 的字段**逐字节未变**；
 *   2. 文件里的 `defaults` / `limits` 未被改动（`defaults.provider` 仍是 ofox）；
 *   3. **幂等**：load 两次，providers 数量不增；
 *   4. **告警可见**：出现「补入厂商」的可读提示（既有 warnings 通道）；
 *   5. **盘上文件未被改写**：load 前后字节级一致；
 *   6. 反面：文件里已有 agnes 时**不重复补**，也不产生补齐告警。
 *
 * **零网络**：只碰临时目录里的 config.json。
 */
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConfigStore } from '../lib/store/config-store.js'

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

let dir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pixmart-presets-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('出厂预设补齐：已有配置缺厂商', () => {
  it('只有 ofox 的文件 → 内存里补出 agnes（apiKey 为空），ofox 字段逐字节未变', async () => {
    const { seeded } = seedOfoxOnlyConfig(dir)
    const store = new ConfigStore(dir)

    const result = await store.load()
    const ids = result.config.providers.map((provider) => provider.id)

    // 1. 补齐发生了，且补的是出厂预设里的 agnes
    assert.ok(ids.includes('agnes'), `load 后应出现 agnes，实际：${JSON.stringify(ids)}`)
    const agnes = result.config.providers.find((provider) => provider.id === 'agnes')
    assert.equal(agnes.apiKey, '', '补入的厂商必须是"尚未配置密钥"状态')
    assert.equal(agnes.label, 'Agnes AI')
    assert.equal(agnes.dialect, 'agnes')
    assert.equal(agnes.baseUrl, 'https://apihub.agnes-ai.com/v1')
    assert.ok(agnes.models.length > 0, '出厂预设必须自带模型清单')

    // 2. **绝不覆盖**：文件里已有的 ofox 与种下的那份逐字节相同
    const ofox = result.config.providers.find((provider) => provider.id === 'ofox')
    assert.equal(
      JSON.stringify(ofox),
      JSON.stringify(seeded.providers[0]),
      '已有厂商的任何字段都不得被出厂预设改写',
    )
    assert.equal(ofox.apiKey, OFOX_SECRET)
    assert.equal(ofox.apiKeyEnv, '', '用户清空过的 apiKeyEnv 不得被出厂值复活')
    assert.deepEqual(ofox.models, ['openai/gpt-image-2', 'google/gemini-3-pro-image'])
    assert.equal(ofox.timeoutMs, 123_456, '用户改过的超时也不得被动')
    assert.deepEqual(ofox.extraHeaders, { 'x-user-note': '用户自己加的' })

    // 3. 追加在末尾：文件里的顺序与 providers[0] 不变
    assert.equal(result.config.providers[0].id, 'ofox')
  })

  it('文件里的 defaults 与 limits 未被改动（defaults.provider 仍是 ofox）', async () => {
    const { seeded } = seedOfoxOnlyConfig(dir)
    const store = new ConfigStore(dir)

    const result = await store.load()

    // 补齐的是厂商，**不是**默认值：用户原来用 ofox 就还是 ofox
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

  it('幂等：load 两次，providers 数量不增、agnes 不重复', async () => {
    seedOfoxOnlyConfig(dir)
    const store = new ConfigStore(dir)

    const first = await store.load()
    const afterFirst = first.config.providers.map((provider) => provider.id)
    const second = await store.load()
    const afterSecond = second.config.providers.map((provider) => provider.id)

    assert.deepEqual(afterSecond, afterFirst, '第二次 load 不该改变厂商集合')
    assert.equal(
      second.config.providers.filter((provider) => provider.id === 'agnes').length,
      1,
      'agnes 不得被补两次',
    )
    assert.equal(first.config.providers.length, 2, 'ofox + agnes')
  })

  it('告警可见：出现「已从出厂预设补入厂商：agnes（尚未配置密钥）」', async () => {
    seedOfoxOnlyConfig(dir)
    const store = new ConfigStore(dir)

    const result = await store.load()
    const line = result.warnings.find((warning) => warning.includes('补入厂商'))

    assert.ok(line, `应有可读的补齐告警，实际：${JSON.stringify(result.warnings)}`)
    assert.equal(line, '已从出厂预设补入厂商：agnes（尚未配置密钥）')
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
    // 盘上也确实没有 agnes——补齐只在内存里
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.deepEqual(
      onDisk.providers.map((provider) => provider.id),
      ['ofox'],
    )
  })

  it('反面：文件里已有 agnes → 不重复补、也不产生补齐告警', async () => {
    const { configPath } = seedOfoxOnlyConfig(dir)
    const seeded = JSON.parse(readFileSync(configPath, 'utf8'))
    seeded.providers.push({ ...seeded.providers[0], id: 'agnes', label: 'Agnes AI', apiKey: 'sk-agnes-own' })
    writeFileSync(configPath, `${JSON.stringify(seeded, null, 2)}\n`)

    const store = new ConfigStore(dir)
    const result = await store.load()

    assert.equal(result.config.providers.length, 2)
    assert.equal(
      result.config.providers.find((provider) => provider.id === 'agnes').apiKey,
      'sk-agnes-own',
      '用户自己填的 agnes 密钥不得被出厂预设清掉',
    )
    assert.equal(
      result.warnings.some((warning) => warning.includes('补入厂商')),
      false,
      '没有缺的厂商就不该有补齐告警',
    )
  })

  it('反面：配置文件缺失时不报"补入"（那条路径本来就返回出厂配置）', async () => {
    const store = new ConfigStore(dir)

    const result = await store.load()

    assert.equal(result.warnings.length, 0, '缺文件是"从零开始"，不该告警')
    assert.deepEqual(
      result.config.providers.map((provider) => provider.id),
      ['ofox', 'agnes'],
    )
  })
})
