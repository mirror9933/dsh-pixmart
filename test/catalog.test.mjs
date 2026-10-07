/**
 * 厂商目录（`src/catalog.ts`）的**纯数据**契约测试 —— 零网络、零写盘、零临时目录。
 *
 * 这份目录是"设置页「添加模型提供商」"的候选清单，数据**逐条转录**自参考项目
 * `E:\Programs\trae\project\pixmart-ai\src\renderer\src\types\model.ts` 的
 * `VENDOR_INFO`（第 40–197 行，`model.ts:<行号>` 见 `src/catalog.ts` 的注释）。
 *
 * **当前是 13 条**（全部具名厂商，**没有 `custom`**）：两次收敛 ——
 *   1. 只保留 13 家具名供应商：`mimo` / `kimi` / `minimax` / `zhipu` / `deepseek` / `sharellm`
 *      六条被删（**`sharellm-intl` 保留**）；
 *   2. 「提供商」下拉里不再出现「自定义」（设置页有独立的「自定义模型 API」tab，
 *      下拉里再放一条就是重复入口）→ `custom` 条目也不再转录。
 * 本文件同时钉住"被删的 id 不在目录里"；**目录变小与"用户配置里已有它们"是两件事**，
 * 后者不归这个文件管。而"删了 `custom` 条目 ≠ 功能没了"由 `providerFromCustom` 那组断言钉住。
 *
 * 因此这里的断言分四类：
 *   1. **转录保真**：条数、id 集合与顺序、`baseUrl` 逐字符（抽 3 条硬断言 + "每条都非空 https"）；
 *   2. **纪律**：`imageCapable` 只能是有据可依的 9 家，其余 `note` 必须写明"生图能力未取证"；
 *      3 个 `threed-*` 不进目录（PixMart 只做 2D）；被删的条目也必须不在；
 *   3. **视图**：`catalogView` 的 7 个字段 + `added`；
 *   4. **草稿**：`providerFromCatalog` / `providerFromCustom` 的
 *      "空 models / **统一默认尺寸** / 不预填密钥"三条。
 *
 * 注意：测试**不读**参考项目那个路径——把机器相关的绝对路径塞进断言会让用例不可移植；
 * "与参考项目一致"这句话由 `src/catalog.ts` 里的 `model.ts:<行号>` 注释 + 这里的硬断言共同保证。
 * 统一默认尺寸那 10 个比例的**字面量与顺序**钉在 `test/vendor.test.mjs`（尺寸契约的归属地），
 * 这里只断言"草稿填的就是 `sizes.ts` 的那份清单"，避免两处字面量各自漂移。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  PROVIDER_CATALOG,
  catalogView,
  findCatalogEntry,
  providerFromCatalog,
  providerFromCustom,
} from '../lib/catalog.js'
import { DEFAULT_IMAGE_RATIOS } from '../lib/sizes.js'

/** 期望的 13 个 id（顺序 = 目录顺序 = 参考项目声明顺序；3D 与两次删掉的条目已剔除）。 */
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
  'agnes',
  'ofox',
  'sharellm-intl',
  'sensenova',
]

/** 用户要求**不再进目录**的 6 家（顺序照参考项目声明顺序）。 */
const REMOVED_IDS = ['mimo', 'kimi', 'minimax', 'zhipu', 'deepseek', 'sharellm']

/** 已取证能出图的 9 家（其余是"保守标注"，见 src/catalog.ts 文件头纪律）。
 *  顺序 = **目录顺序**（下面那条 `assert.deepEqual` 是按顺序比对的）。 */
const IMAGE_CAPABLE_IDS = [
  'openai',
  'google',
  'aihubmix',
  'siliconflow',
  'volcengine',
  'bailian',
  'agnes',
  'ofox',
  'sensenova',
]

describe('厂商目录：转录保真', () => {
  it('13 条（全部具名，没有 custom）、id 集合与顺序与保留清单一致', () => {
    assert.equal(PROVIDER_CATALOG.length, 13)
    // 目录里**不再有任何** custom 分组的条目（「自定义」走独立 tab）
    assert.equal(
      PROVIDER_CATALOG.some((entry) => entry.group === 'custom'),
      false,
      '目录里不该再有 group=custom 的条目',
    )
    assert.deepEqual(
      PROVIDER_CATALOG.map((entry) => entry.id),
      EXPECTED_IDS,
    )
    // 3 个 threed-* 只做 3D，PixMart 不做 3D → 一个都不能进目录
    assert.equal(
      PROVIDER_CATALOG.some((entry) => entry.id.startsWith('threed')),
      false,
    )
    // 「自定义」**不在**目录里：它由设置页独立的「自定义模型 API」tab 负责
    assert.equal(
      findCatalogEntry('custom'),
      undefined,
      '「自定义」不再进目录（走独立 tab，重复入口已移除）',
    )
  })

  it('被删的 6 家不在目录里，而 sharellm-intl 必须留下（只删 sharellm，不删国际站）', () => {
    for (const id of REMOVED_IDS) {
      assert.equal(findCatalogEntry(id), undefined, `${id} 不该再出现在目录里`)
    }
    // 反向断言：不能把"删 6 家"做成"删掉 sharellm 那一对"
    assert.ok(findCatalogEntry('sharellm-intl'), 'sharellm-intl 必须保留')
    assert.equal(findCatalogEntry('sharellm-intl').baseUrl, 'https://sharellm.net/v1')
    // 剩下的也不该被误删
    for (const id of EXPECTED_IDS) assert.ok(findCatalogEntry(id), `${id} 不该被删`)
  })

  it('「自定义」不在目录里，但 providerFromCustom 照旧能建（删的是目录条目，不是功能）', () => {
    assert.equal(findCatalogEntry('custom'), undefined)
    assert.equal(
      PROVIDER_CATALOG.some((entry) => entry.id === 'custom'),
      false,
      '目录里连 id=custom 都不该有',
    )
    // 自建路径**不查目录**：它只吃用户填的三个字段，group 固定 'custom'
    const draft = providerFromCustom({
      id: 'my-relay',
      label: '我的中转',
      baseUrl: 'https://my-relay.example/v1',
    })
    assert.equal(draft.id, 'my-relay')
    assert.equal(draft.group, 'custom')
    assert.equal(draft.baseUrl, 'https://my-relay.example/v1')
    assert.equal(draft.dialect, 'standard')
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

  it('每条 baseUrl 都非空、https、且没有尾斜杠（目录里已没有 custom 那种空串条目）', () => {
    for (const entry of PROVIDER_CATALOG) {
      assert.notEqual(entry.baseUrl, '', `${entry.id} 的 baseUrl 不能为空`)
      assert.match(entry.baseUrl, /^https:\/\//, `${entry.id} 的 baseUrl 必须是 https://`)
      assert.equal(
        entry.baseUrl.endsWith('/'),
        false,
        `${entry.id} 的 baseUrl 不该有尾斜杠（与参考项目逐字符一致）`,
      )
    }
  })

  it('分组：official 8 / aggregator 5 / custom 0', () => {
    const counts = { official: 0, aggregator: 0, custom: 0 }
    for (const entry of PROVIDER_CATALOG) {
      assert.ok(
        entry.group === 'official' || entry.group === 'aggregator' || entry.group === 'custom',
        `${entry.id} 的 group 非法：${String(entry.group)}`,
      )
      counts[entry.group] += 1
    }
    assert.deepEqual(counts, { official: 8, aggregator: 5, custom: 0 })
    // 「自定义」不再是目录条目，所以没有一行是 custom 分组
    assert.equal(PROVIDER_CATALOG.some((entry) => entry.group === 'custom'), false)
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
  it('只有已取证的 9 家是 true，其余全是 false（被删的 minimax 不再是任何清单的一员）', () => {
    const capable = PROVIDER_CATALOG.filter((entry) => entry.imageCapable).map(
      (entry) => entry.id,
    )
    assert.deepEqual(capable, IMAGE_CAPABLE_IDS)
    // 反面：被删的 6 家一个都不在 capable 清单里（minimax 原本是 true）
    for (const id of REMOVED_IDS) {
      assert.equal(IMAGE_CAPABLE_IDS.includes(id), false, `${id} 已删，不该还留在 imageCapable 清单里`)
    }

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
  it('catalogView：13 条、字段正好 7 个、added 按传入的 id 集合算', () => {
    const view = catalogView(['ofox', 'agnes'])
    assert.equal(view.length, 13)
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

  it('findCatalogEntry：命中 / 去除首尾空白 / 未命中（含「自定义」）返回 undefined', () => {
    assert.equal(findCatalogEntry('bailian').label, '阿里云百炼')
    assert.equal(findCatalogEntry('  bailian  ').id, 'bailian')
    assert.equal(findCatalogEntry('nope'), undefined)
    assert.equal(findCatalogEntry(''), undefined)
    assert.equal(findCatalogEntry('OpenAI'), undefined, 'id 区分大小写')
    // 本次的关键反向断言：「自定义」在目录里**找不到**
    assert.equal(findCatalogEntry('custom'), undefined, '「自定义」已从目录移除（走独立 tab）')
  })
})

describe('providerFromCatalog：新增厂商的草稿', () => {
  it('转录目录的身份字段，models 留空、allowedSizes 是统一默认词表，不预填任何密钥', () => {
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
      allowedSizes: DEFAULT_IMAGE_RATIOS,
      sizeMode: 'whitelist',
      extraHeaders: {},
      timeoutMs: 180_000,
    })
  })

  it('dialect 跟着目录走：ofox → ofox、agnes → agnes，其余 → standard', () => {
    assert.equal(providerFromCatalog(findCatalogEntry('ofox')).dialect, 'ofox')
    assert.equal(providerFromCatalog(findCatalogEntry('agnes')).dialect, 'agnes')
    // 目录里已经没有 custom 那条了；不携带 dialect 的具名条目一律落到 standard
    assert.equal(providerFromCatalog(findCatalogEntry('bailian')).dialect, 'standard')
    assert.equal(providerFromCatalog(findCatalogEntry('openai')).dialect, 'standard')
  })

  it('目录里没有模型名；尺寸一律是那 10 个统一比例（不再留空 allowedSizes）', () => {
    for (const entry of PROVIDER_CATALOG) {
      const draft = providerFromCatalog(entry)
      assert.deepEqual(draft.models, [], `${entry.id} 不该带默认模型`)
      // 与 `sizes.ts` 的同一份清单（字面量与顺序钉在 test/vendor.test.mjs）
      assert.deepEqual(
        draft.allowedSizes,
        DEFAULT_IMAGE_RATIOS,
        `${entry.id} 的 allowedSizes 应是统一默认词表`,
      )
      assert.equal(draft.allowedSizes.includes('4:5'), true, '统一词表含 4:5')
      assert.equal(draft.allowedSizes.includes('5:4'), true, '统一词表含 5:4')
      assert.equal(draft.apiKey, '', `${entry.id} 不该预填密钥`)
      assert.equal(draft.apiKeyEnv, '', `${entry.id} 不该预填环境变量名`)
    }
  })
})

describe('providerFromCustom：自定义厂商的草稿', () => {
  it('身份字段来自用户输入，其余与目录草稿同形状（group=custom / standard / 空 models / 统一尺寸）', () => {
    assert.deepEqual(
      providerFromCustom({
        id: 'my-relay',
        label: '我的中转',
        baseUrl: 'https://my-relay.example/v1',
      }),
      {
        id: 'my-relay',
        label: '我的中转',
        group: 'custom',
        baseUrl: 'https://my-relay.example/v1',
        geminiNativeBaseUrl: '',
        dialect: 'standard',
        apiMode: 'images-generations',
        apiKeyEnv: '',
        apiKey: '',
        models: [],
        allowedSizes: DEFAULT_IMAGE_RATIOS,
        sizeMode: 'whitelist',
        extraHeaders: {},
        timeoutMs: 180_000,
      },
    )
    // 与目录草稿落盘后是同一个形状：除身份字段（id/label/baseUrl）与 `group` 外逐字段一致。
    // `group` 是**有意不同**的——自建厂商固定 `custom`，而目录条目各是自己的 official / aggregator
    // （目录里已经没有 `custom` 那条了，所以这里拿 `bailian` 当目录侧的代表）。
    const fromCatalog = providerFromCatalog(findCatalogEntry('bailian'))
    const fromCustom = providerFromCustom({ id: 'x', label: 'y', baseUrl: 'https://e.test/v1' })
    assert.equal(fromCustom.group, 'custom')
    assert.equal(fromCatalog.group, 'official')
    const identity = ['id', 'label', 'baseUrl', 'group']
    for (const key of Object.keys(fromCatalog)) {
      if (identity.includes(key)) continue
      assert.deepEqual(fromCustom[key], fromCatalog[key], `字段 ${key} 应与目录草稿一致`)
    }
  })

  it('apiKey 只在显式给出时落进 apiKey 字段；apiKeyEnv 一律空串', () => {
    const withoutKey = providerFromCustom({ id: 'a', label: 'a', baseUrl: 'https://e.test/v1' })
    assert.equal(withoutKey.apiKey, '')
    assert.equal(withoutKey.apiKeyEnv, '')

    const withKey = providerFromCustom({
      id: 'a',
      label: 'a',
      baseUrl: 'https://e.test/v1',
      apiKey: 'sk-secret',
    })
    assert.equal(withKey.apiKey, 'sk-secret')
    // 网页显式填的密钥必须压过环境变量 → 不指任何环境变量
    assert.equal(withKey.apiKeyEnv, '')
  })
})
