/**
 * 厂商目录（`src/catalog.ts`）的**纯数据**契约测试 —— 零网络、零写盘、零临时目录。
 *
 * 这份目录是"设置页「添加模型提供商」"的候选清单，数据**逐条转录**自参考项目
 * `E:\Programs\trae\project\pixmart-ai\src\renderer\src\types\model.ts` 的
 * `VENDOR_INFO`（第 40–197 行，`model.ts:<行号>` 见 `src/catalog.ts` 的注释）。
 *
 * 因此这里的断言分三类：
 *   1. **转录保真**：条数、id 集合、`baseUrl` 逐字符（抽 3 条硬断言 + "除 custom 外全非空 https"）；
 *   2. **纪律**：`imageCapable` 只能是有据可依的 9 家，其余 `note` 必须写明"生图能力未取证"；
 *      3 个 `threed-*` 不进目录（PixMart 只做 2D）；
 *   3. **视图与草稿**：`catalogView` 的 7 个字段 + `added`；`providerFromCatalog` 的
 *      "空 models / 空 allowedSizes / 不预填密钥"三条。
 *
 * 注意：测试**不读**参考项目那个路径——把机器相关的绝对路径塞进断言会让用例不可移植；
 * "与参考项目一致"这句话由 `src/catalog.ts` 里的 `model.ts:<行号>` 注释 + 这里的硬断言共同保证。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  PROVIDER_CATALOG,
  catalogView,
  findCatalogEntry,
  providerFromCatalog,
} from '../lib/catalog.js'

/** 期望的 20 个 id（顺序 = 目录顺序 = 参考项目声明顺序，3D 已剔除）。 */
const EXPECTED_IDS = [
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'aihubmix',
  'siliconflow',
  'volcengine',
  'bailian',
  'tencent',
  'mimo',
  'kimi',
  'minimax',
  'zhipu',
  'deepseek',
  'agnes',
  'ofox',
  'sharellm',
  'sharellm-intl',
  'sensenova',
  'custom',
]

/** 已取证能出图的 10 家（其余是"保守标注"，见 src/catalog.ts 文件头纪律）。
 *  顺序 = **目录顺序**（下面那条 `assert.deepEqual` 是按顺序比对的）。 */
const IMAGE_CAPABLE_IDS = [
  'openai',
  'google',
  'aihubmix',
  'siliconflow',
  'volcengine',
  'bailian',
  'minimax',
  'agnes',
  'ofox',
  'sensenova',
]

describe('厂商目录：转录保真', () => {
  it('20 条、id 集合与顺序与参考项目 VENDOR_INFO 一致（3D 已剔除）', () => {
    assert.equal(PROVIDER_CATALOG.length, 20)
    assert.deepEqual(
      PROVIDER_CATALOG.map((entry) => entry.id),
      EXPECTED_IDS,
    )
    // 3 个 threed-* 只做 3D，PixMart 不做 3D → 一个都不能进目录
    assert.equal(
      PROVIDER_CATALOG.some((entry) => entry.id.startsWith('threed')),
      false,
    )
    // custom（自定义接入）必须**在**目录里
    assert.ok(findCatalogEntry('custom'))
  })

  it('id 不重复，label / note 都是非空字符串', () => {
    const ids = PROVIDER_CATALOG.map((entry) => entry.id)
    assert.equal(new Set(ids).size, ids.length, 'id 必须唯一')
    for (const entry of PROVIDER_CATALOG) {
      assert.equal(typeof entry.label, 'string')
      assert.notEqual(entry.label.trim(), '', `${entry.id} 的 label 不能为空`)
      assert.equal(typeof entry.note, 'string')
      assert.notEqual(entry.note.trim(), '', `${entry.id} 的 note 不能为空`)
    }
  })

  it('baseUrl 抽 3 条硬断言（逐字符，含 model.ts 出处）', () => {
    // model.ts:42-46
    assert.equal(findCatalogEntry('openai').baseUrl, 'https://api.openai.com/v1')
    // model.ts:91-95
    assert.equal(
      findCatalogEntry('bailian').baseUrl,
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    )
    // model.ts:169-173
    assert.equal(findCatalogEntry('sensenova').baseUrl, 'https://token.sensenova.cn/v1')
  })

  it('除 custom 外每条 baseUrl 都非空、https、且没有尾斜杠；custom 是空串', () => {
    for (const entry of PROVIDER_CATALOG) {
      if (entry.id === 'custom') {
        assert.equal(entry.baseUrl, '', 'custom 的 baseUrl 必须是空串（由用户自填）')
        continue
      }
      assert.notEqual(entry.baseUrl, '', `${entry.id} 的 baseUrl 不能为空`)
      assert.match(entry.baseUrl, /^https:\/\//, `${entry.id} 的 baseUrl 必须是 https://`)
      assert.equal(
        entry.baseUrl.endsWith('/'),
        false,
        `${entry.id} 的 baseUrl 不该有尾斜杠（与参考项目逐字符一致）`,
      )
    }
  })

  it('分组：official 13 / aggregator 6 / custom 1，且 custom 那条就是「自定义接入」', () => {
    const counts = { official: 0, aggregator: 0, custom: 0 }
    for (const entry of PROVIDER_CATALOG) {
      assert.ok(
        entry.group === 'official' || entry.group === 'aggregator' || entry.group === 'custom',
        `${entry.id} 的 group 非法：${String(entry.group)}`,
      )
      counts[entry.group] += 1
    }
    assert.deepEqual(counts, { official: 13, aggregator: 6, custom: 1 })
    assert.equal(findCatalogEntry('custom').group, 'custom')
  })

  it('dialect：ofox → ofox、agnes → agnes，其余省略（= standard）', () => {
    assert.equal(findCatalogEntry('ofox').dialect, 'ofox')
    assert.equal(findCatalogEntry('agnes').dialect, 'agnes')
    for (const entry of PROVIDER_CATALOG) {
      if (entry.id === 'ofox' || entry.id === 'agnes') continue
      assert.equal(entry.dialect, undefined, `${entry.id} 不该带 dialect`)
    }
  })
})

describe('厂商目录：imageCapable 的纪律', () => {
  it('只有已取证的 10 家是 true，其余全是 false', () => {
    const capable = PROVIDER_CATALOG.filter((entry) => entry.imageCapable).map(
      (entry) => entry.id,
    )
    assert.deepEqual(capable, IMAGE_CAPABLE_IDS)

    const notCapable = PROVIDER_CATALOG.filter((entry) => !entry.imageCapable).map(
      (entry) => entry.id,
    )
    assert.deepEqual(
      notCapable,
      EXPECTED_IDS.filter((id) => !IMAGE_CAPABLE_IDS.includes(id)),
    )
  })

  it('每条 false 的 note 都写明「生图能力未取证」（保守标注，不是断言不能）', () => {
    for (const entry of PROVIDER_CATALOG) {
      if (entry.imageCapable) continue
      assert.ok(
        entry.note.includes('生图能力未取证'),
        `${entry.id} 未取证但没有写明：${entry.note}`,
      )
    }
  })
})

describe('catalogView / findCatalogEntry', () => {
  it('catalogView：20 条、字段正好 7 个、added 按传入的 id 集合算', () => {
    const view = catalogView(['ofox', 'agnes'])
    assert.equal(view.length, 20)
    for (const entry of view) {
      assert.deepEqual(Object.keys(entry).sort(), [
        'added',
        'baseUrl',
        'group',
        'id',
        'imageCapable',
        'label',
        'note',
      ])
    }
    assert.deepEqual(
      view.filter((entry) => entry.added).map((entry) => entry.id),
      ['agnes', 'ofox'],
    )
    // 顺序与目录一致，不是按 added 重排
    assert.deepEqual(
      view.map((entry) => entry.id),
      EXPECTED_IDS,
    )
    // 空配置：全部 added:false（不抛、不崩）
    assert.equal(
      catalogView([]).filter((entry) => entry.added).length,
      0,
    )
  })

  it('findCatalogEntry：命中 / 去除首尾空白 / 未命中返回 undefined', () => {
    assert.equal(findCatalogEntry('bailian').label, '阿里云百炼')
    assert.equal(findCatalogEntry('  bailian  ').id, 'bailian')
    assert.equal(findCatalogEntry('nope'), undefined)
    assert.equal(findCatalogEntry(''), undefined)
    assert.equal(findCatalogEntry('OpenAI'), undefined, 'id 区分大小写')
  })
})

describe('providerFromCatalog：新增厂商的草稿', () => {
  it('转录目录的身份字段，models / allowedSizes 留空，不预填任何密钥', () => {
    const entry = findCatalogEntry('bailian')
    const draft = providerFromCatalog(entry)

    assert.deepEqual(draft, {
      id: 'bailian',
      label: '阿里云百炼',
      group: 'official',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      geminiNativeBaseUrl: '',
      dialect: 'standard',
      apiMode: 'images-generations',
      apiKeyEnv: '',
      apiKey: '',
      models: [],
      allowedSizes: [],
      sizeMode: 'whitelist',
      extraHeaders: {},
      timeoutMs: 180_000,
    })
  })

  it('dialect 跟着目录走：ofox / agnes 各自带方言，custom 的 baseUrl 为空串', () => {
    assert.equal(providerFromCatalog(findCatalogEntry('ofox')).dialect, 'ofox')
    assert.equal(providerFromCatalog(findCatalogEntry('agnes')).dialect, 'agnes')
    const custom = providerFromCatalog(findCatalogEntry('custom'))
    assert.equal(custom.baseUrl, '')
    assert.equal(custom.group, 'custom')
    assert.equal(custom.dialect, 'standard')
  })

  it('目录里没有模型名 / 不抄任何厂商尺寸表：每个草稿的 models 与 allowedSizes 都是空数组', () => {
    for (const entry of PROVIDER_CATALOG) {
      const draft = providerFromCatalog(entry)
      assert.deepEqual(draft.models, [], `${entry.id} 不该带默认模型`)
      assert.deepEqual(draft.allowedSizes, [], `${entry.id} 不该带默认尺寸表`)
      assert.equal(draft.apiKey, '', `${entry.id} 不该预填密钥`)
      assert.equal(draft.apiKeyEnv, '', `${entry.id} 不该预填环境变量名`)
    }
  })
})
