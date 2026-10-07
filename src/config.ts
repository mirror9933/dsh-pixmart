/**
 * 插件配置的类型、默认值与**容错解析**。
 *
 * 两个来源：
 *   - cordis.yml 的 `config:` 段（`dataDir` 等，随 profile 走）
 *   - `<dataDir>/config.json`（厂商、密钥、默认值、限制；**不进 patch 层**）
 *
 * 解析一律容错：字段缺失/类型不对 → 记 warning 并用默认值，**绝不因配置脏而拒绝启动**。
 * 用户总得能进设置页把配置改回来。
 */

import { isAbsolute } from 'node:path'

// `sizes.js` 对 `config.js` 只有 `import type`（编译后不留依赖），所以这条运行时
// 依赖是单向的，不会形成环。
import { DEFAULT_IMAGE_RATIOS, sizeOptionsFor, type SizeOption } from './sizes.js'

/** 四种调用形态。`gemini-native` 是 Ofox 的 Gemini 图像模型唯一可用路径。 */
export type ApiMode = 'images-generations' | 'images-edits' | 'chat-image' | 'gemini-native'
/**
 * 方言 = **字段名与字段位置的差异**，同一套 `apiMode` 下各家仍可能不同。
 *
 *   - `standard`：`image` + `response_format`（顶层）；
 *   - `ofox`：`input_images` + `output_format`；
 *   - `agnes`：`extra_body.image` + `extra_body.response_format`，尺寸走「档位 + 比例」
 *     （`size: '1K'` + `ratio: '16:9'`）。
 *
 * `agnes` 单列而不是复用 `standard`：官方文档明文**「不要把 `response_format` 放在
 * 顶层」**，放错位置不是被忽略而是报错；参考图同理必须在 `extra_body.image` 里。
 * 字段写错会被服务端**静默忽略/直接报错**，所以由配置决定，绝不靠内容嗅探。
 */
export type Dialect = 'standard' | 'ofox' | 'agnes'
export type SizeMode = 'whitelist' | 'exact' | 'free'
/**
 * 厂商分组。
 *
 * `custom` 是设置页「自定义接入」（用户自填 baseUrl 的那种，目录里 `custom` 那条就是），
 * 与 `official`（「官方 API 接入」）/ `aggregator`（「聚合接入」）并列。
 * 它是**配置层**的分组；`src/catalog.ts` 的 `CatalogGroup` 是同一套取值。
 */
export type ProviderGroup = 'official' | 'aggregator' | 'custom'

export interface ProviderConfig {
  readonly id: string
  readonly label: string
  readonly group: ProviderGroup
  /** OpenAI 兼容端点，如 `https://api.ofox.io/v1`。 */
  readonly baseUrl: string
  /** 仅 `gemini-native` 使用，如 `https://api.ofox.io/gemini/v1beta`。 */
  readonly geminiNativeBaseUrl: string
  readonly dialect: Dialect
  readonly apiMode: ApiMode
  /** 密钥来源优先级最高：环境变量名。 */
  readonly apiKeyEnv: string
  /** 落盘密钥。**永不回传前端、永不进日志**。 */
  readonly apiKey: string
  readonly models: readonly string[]
  readonly allowedSizes: readonly string[]
  readonly sizeMode: SizeMode
  readonly extraHeaders: Readonly<Record<string, string>>
  readonly timeoutMs: number
}

export interface DefaultsConfig {
  readonly provider: string
  readonly model: string
  readonly size: string
  readonly n: number
}

export interface LimitsConfig {
  readonly maxConcurrency: number
  readonly maxBatchItems: number
  readonly maxRetries: number
  /** 0 = 不自动清理。 */
  readonly retentionDays: number
}

export interface PixmartConfig {
  readonly version: number
  readonly providers: readonly ProviderConfig[]
  /**
   * **用户显式删掉的出厂预设 id**（`POST /providers/<id>/delete` 写，见 `src/routes.ts`）。
   *
   * 机制（**保留**，为将来可能的出厂预设）：`applyFactoryPresets` 每次 `load()` 会把出厂
   * 预设里缺的厂商补回来；这份清单里的 id 会被跳过，删除才是**持久**的（它当初修掉的
   * 是 docs/contract-notes.md §26.4 那条老限制："删了的厂商下次启动又回来"）。
   *
   * **当前出厂清单为空**（`defaultConfig().providers === []`，厂商全部由用户从目录添加），
   * 于是没有任何 id 会落进这份清单——正常流程根本用不到它，`[]` 就是常态；
   * 只有将来重新放出厂预设时它才真正起作用。字段与删除路由里的记账逻辑因此**不删**：
   * 删掉它等于把那条路事先堵死，将来要恢复就得同时改两处。
   *
   * 只记**出厂预设**的 id（用户自己添加的厂商删掉就是删掉，不需要记账）；
   * 用户从目录重新添加同一 id 时，路由会把它从这份清单里移除（不阻挡重新添加）。
   * 默认 `[]`；解析容错（非数组/含非字符串项都按容错规则处理），写盘原样保留。
   */
  readonly removedProviders: readonly string[]
  readonly defaults: DefaultsConfig
  readonly limits: LimitsConfig
  /** `<moduleId>` 或 `<moduleId>.<fragment>` → 覆盖文本（见 prompts/build.ts）。 */
  readonly promptOverrides: Readonly<Record<string, string>>
  readonly attachmentInConversation: boolean
  /**
   * **作品库导出路径**：用户在作品库点「导出」时，项目图片被**复制**到
   * `<exportDir>/<projectId>/`（原件始终留在数据目录）。
   *
   * 语义变更（本次）：生图**不再**往这里自动复制任何文件。生成只有一处副作用——
   * 写插件数据目录；要不要副本、副本放哪，由用户在作品库显式导出时决定。
   *
   * 空串 = 未配置（导出按钮会提示先去设置里填）；非空时必须是绝对路径。
   */
  readonly exportDir: string
  /**
   * **已废弃**：旧的「产物保存路径」。字段保留只为兼容磁盘上已有的 config.json，
   * **解析后不再有任何行为**（不读、不写、不生效）。
   *
   * 迁移见 `pickExportDir`：只在 `exportDir` 无可用值时把旧值搬过去一次，
   * 以免用户已经填好的路径凭空消失。
   */
  readonly outputDir?: string
}

export const CONFIG_VERSION = 1

/** Ofox 的内置默认（P0 从参考项目只读取证，见 contract-notes §7.4.1 / 方案 §7.4.1）。 */
export function defaultOfoxProvider(): ProviderConfig {
  return {
    id: 'ofox',
    label: 'Ofox',
    group: 'aggregator',
    baseUrl: 'https://api.ofox.io/v1',
    geminiNativeBaseUrl: 'https://api.ofox.io/gemini/v1beta',
    dialect: 'ofox',
    apiMode: 'images-generations',
    apiKeyEnv: 'OFOX_API_KEY',
    apiKey: '',
    models: [
      'google/gemini-3.1-flash-lite-image',
      'google/gemini-3.1-pro-preview',
      'openai/gpt-5.5',
    ],
    // 临时统一的默认出图尺寸（10 个比例，见 `sizes.ts` 的 `DEFAULT_IMAGE_RATIOS`）。
    // 注意：**判定用的能力表不是这一份** —— 非 agnes 且无内置命中的厂商一律按那 10 个
    // 比例校验（`capabilityFor` 有意覆盖配置里的 allowedSizes）。这里同步写全，是为了
    // 让读配置的人/客户端看到"它默认能出这 10 个"，而不是以为"没配尺寸"。
    allowedSizes: DEFAULT_IMAGE_RATIOS,
    sizeMode: 'whitelist',
    extraHeaders: {},
    timeoutMs: 180_000,
  }
}

/**
 * Agnes AI 的内置默认（P0 取证见 contract-notes §25；**无 API Key，未做真实出图验证**）。
 *
 * 取证要点（两条独立来源，冲突处见 §25.2）：
 *   - 端点：`POST {baseUrl}/images/generations`，`Authorization: Bearer`；**图生图同端点**
 *     （不走 `/images/edits`）。
 *   - `size` 用**档位**（`1K`/`2K`/`3K`/`4K`）+ `ratio`（支持的 8 种比例，见 `allowedSizes`），
 *     不是像素；因此 `sizeMode: 'whitelist'` 且取值是**比例**。
 *   - `response_format` 与参考图都必须嵌在 `extra_body` 内。
 *   - baseUrl **默认用国内站 `api.agnes-ai.cn/v1`**（2026-10-12 按实际部署改）：
 *     国际站文档给的是 `apihub.agnes-ai.com/v1`，但**两站密钥不通用**——国内站密钥打到
 *     国际站会 401 Invalid token（已实测）。国内站入口取证自参考项目 pixmart-ai 的
 *     `src/renderer/src/types/model.ts:144` 的 defaultBaseUrl。
 *     用国际站密钥的人，在设置页把 baseUrl 改成 `https://apihub.agnes-ai.com/v1` 即可。
 *     （冲突未解决，见 §25.2 第 1 条）。
 */
export function defaultAgnesProvider(): ProviderConfig {
  return {
    id: 'agnes',
    label: 'Agnes AI',
    group: 'official',
    baseUrl: 'https://api.agnes-ai.cn/v1',
    // Agnes 生图只有 OpenAI 兼容一套路径，无 Gemini 原生端点。
    geminiNativeBaseUrl: '',
    dialect: 'agnes',
    apiMode: 'images-generations',
    apiKeyEnv: 'AGNES_API_KEY',
    apiKey: '',
    models: [
      'agnes-image-2.1-flash',
      'agnes-image-2.5-flash',
      'agnes-image-2.0-flash',
      'agnes-3.0-flash',
    ],
    // 官方「Size and Ratio」表里 ratio 支持的全部取值（21:9 在档位表内有）。
    // 注意：**校验用的清单不是这一份**——agnes 走 `sizes.ts` 的内置能力表
    // （`AGNES_ALLOWED_SIZES`：这 8 个比例 + 32 个精确像素尺寸）。这里只保留比例，
    // 是因为它同时喂给设置页的「默认尺寸」下拉框（40 项会把控件撑得很难用），
    // 而比例是不挑厂商的通用写法。要改能力就改内置表，见 docs/contract-notes.md §27。
    allowedSizes: ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'],
    sizeMode: 'whitelist',
    extraHeaders: {},
    // 官方建议客户端超时 60–360s。
    timeoutMs: 180_000,
  }
}

/**
 * 出厂配置：**一个厂商都不带**（用户决策：安装后由用户自己从「添加模型提供商」里挑）。
 *
 * `providers: []`、`defaults.provider === ''`、`defaults.model === ''`。空串的语义是
 * **"还没有选"**，不是"某家厂商"——`findProvider()` 因此返回 `undefined`，工具会给出
 * 可操作指引（`NO_PROVIDER_GUIDANCE` / `providerNotFoundMessage()`），而不是猜一家。
 *
 * `defaultOfoxProvider()` / `defaultAgnesProvider()` **仍然保留并导出**：它们是内置
 * 默认值的单一来源（测试夹具、`sizes.ts` 的能力表、将来重新放出厂预设都拿它们当输入），
 * 只是不再自动出现在出厂配置里。
 *
 * `providers` 同时是 `applyFactoryPresets` 的**出厂预设清单**：现在为空 ⇒ 该函数是
 * no-op（见该函数）。将来若要"出厂就带某家"，往这里加即可，机制原样可用。
 */
export function defaultConfig(): PixmartConfig {
  return {
    version: CONFIG_VERSION,
    providers: [],
    // 出厂配置里没有"被用户删掉"的厂商——这份清单只由删除路由写入（且当前无出厂预设可记）。
    removedProviders: [],
    defaults: {
      provider: '',
      model: '',
      size: '1:1',
      n: 1,
    },
    limits: { maxConcurrency: 2, maxBatchItems: 20, maxRetries: 3, retentionDays: 0 },
    promptOverrides: {},
    attachmentInConversation: true,
    exportDir: '',
  }
}

// ------------------------------------------------------------ 出厂预设补齐

export interface FactoryPresetMerge {
  readonly config: PixmartConfig
  /** 本次被补入的厂商 id（按出厂顺序）；空数组 = 一个字段都没动。 */
  readonly added: readonly string[]
}

/**
 * 把出厂预设里**文件里没有的**厂商补进配置（机制保留；当前出厂清单为空 ⇒ no-op）。
 *
 * 历史缺口：`parseConfig` 以文件为准，于是**新增的厂商预设对已有安装永远不可见**——
 * 实测就是这样，用户磁盘上的 `config.json` 建于只有 ofox 的年代，代码里后加的 agnes
 * 因此一直没出现在设置页。这个函数就是为那条路写的。
 *
 * **现状（用户决策）**：`defaultConfig().providers` 是**空数组**，出厂预设一家都没有，
 * 于是 `factory.providers` 为空 ⇒ `missing` 恒为空 ⇒ 本函数**不补任何人**，原样返回
 * 入参（`added: []`）。机制保留是为了将来若再决定"出厂带某家"时只改 `defaultConfig()`
 * 一处就能重新生效，不必把这套"只追加/不覆盖/跳过墓碑/不写盘"的性质重写一遍。
 *
 * 规则（顺序即优先级）：
 *   1. **文件为准**：已存在的 id 一个字段都不碰——用户填的 baseUrl / apiKey / models
 *      必须逐字节保持原样，哪怕它和出厂预设已经不一样（那正是用户自己的选择）；
 *   2. **只追加缺的**：`factory.providers` 里文件没有的 id 追加到**末尾**，用出厂预设、
 *      `apiKey` 为空（"尚未配置"状态）。追加在末尾，文件里的厂商顺序与 `providers[0]` 不变；
 *   3. **跳过用户删掉的**：`config.removedProviders` 里的 id 即使文件里没有也**不补**
 *      （墓碑机制，见 `PixmartConfig.removedProviders` 的说明）。当前出厂清单为空，
 *      这一条同样不会生效，但逻辑照旧保留；
 *   4. **defaults / limits / 其它字段完全不动**：它们来自文件，包括 `defaults.provider`。
 *      补齐厂商**不会**顺带改默认厂商——用户原来用某家，就还是那家；
 *   5. **不改写磁盘**：本函数是纯函数，`ConfigStore.load()` 只在内存里用它；文件只会在
 *      用户后续显式保存（设置页）时才落盘。
 *
 * @param config - 已解析的落盘配置（用户为准）。
 * @param factory - 出厂预设，默认 `defaultConfig()`（当前是空清单）。
 */
export function applyFactoryPresets(
  config: PixmartConfig,
  factory: PixmartConfig = defaultConfig(),
): FactoryPresetMerge {
  const present = new Set(config.providers.map((provider) => provider.id))
  const removed = new Set(config.removedProviders)
  const missing = factory.providers.filter(
    (provider) => !present.has(provider.id) && !removed.has(provider.id),
  )
  if (missing.length === 0) return { config, added: [] }

  return {
    // 只动 `providers`：`defaults` / `limits` / `promptOverrides` / `exportDir` 原样引用。
    config: { ...config, providers: [...config.providers, ...missing] },
    added: missing.map((provider) => provider.id),
  }
}

/**
 * 补齐告警文案。`load()` 把它塞进既有的 `warnings` 通道（`configWarnings()` →
 * `GET api/providers` 与 `pixmart_providers` 工具都会显示），**不静默**补厂商。
 *
 * 注意：当前出厂清单为空 ⇒ `applyFactoryPresets` 恒返回 `added: []` ⇒ 这段话在正常
 * 流程里不会出现。函数与调用点保留，是给"将来重新放出厂预设"用的，不是死代码清理对象。
 */
export function factoryPresetWarning(added: readonly string[]): string {
  return `已从出厂预设补入厂商：${added.join('、')}（尚未配置密钥）`
}

// ---------------------------------------------------------------- 容错解析

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pickString(
  source: Record<string, unknown>,
  key: string,
  fallback: string,
  warnings: string[],
  trail: string,
): string {
  const value = source[key]
  if (value === undefined) return fallback
  if (typeof value === 'string') return value
  warnings.push(`${trail}.${key} 应为字符串，已用默认值`)
  return fallback
}

function pickNumber(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  warnings: string[],
  trail: string,
  range: { min: number; max: number },
): number {
  const value = source[key]
  if (value === undefined) return fallback
  if (typeof value === 'number' && Number.isFinite(value) && value >= range.min && value <= range.max) {
    return value
  }
  warnings.push(`${trail}.${key} 应为 ${range.min}–${range.max} 的数字，已用默认值`)
  return fallback
}

function pickBool(
  source: Record<string, unknown>,
  key: string,
  fallback: boolean,
  warnings: string[],
  trail: string,
): boolean {
  const value = source[key]
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  warnings.push(`${trail}.${key} 应为布尔值，已用默认值`)
  return fallback
}

function pickEnum<T extends string>(
  source: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
  warnings: string[],
  trail: string,
): T {
  const value = source[key]
  if (value === undefined) return fallback
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  warnings.push(`${trail}.${key} 取值非法（允许：${allowed.join(' / ')}），已用默认值`)
  return fallback
}

function pickStringArray(
  source: Record<string, unknown>,
  key: string,
  fallback: readonly string[],
  warnings: string[],
  trail: string,
): readonly string[] {
  const value = source[key]
  if (value === undefined) return fallback
  if (!Array.isArray(value)) {
    warnings.push(`${trail}.${key} 应为字符串数组，已用默认值`)
    return fallback
  }
  const kept = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  if (kept.length !== value.length) warnings.push(`${trail}.${key} 中的非字符串项已丢弃`)
  return kept
}

function pickStringRecord(
  source: Record<string, unknown>,
  key: string,
  fallback: Readonly<Record<string, string>>,
  warnings: string[],
  trail: string,
): Readonly<Record<string, string>> {
  const value = source[key]
  if (value === undefined) return fallback
  if (!isRecord(value)) {
    warnings.push(`${trail}.${key} 应为对象，已用默认值`)
    return fallback
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = v
    else warnings.push(`${trail}.${key}.${k} 不是字符串，已丢弃`)
  }
  return out
}

/**
 * 从原始配置里读一个路径字段：返回**可用的绝对路径**，并说明为什么为空。
 *
 * 相对路径的落点取决于宿主进程的工作目录（GUI 启动时那还是 profile 目录），
 * 用户根本无法预期，因此宁可记一条 warning 当作「未设置」——**不能抛**：
 * 配置脏不该让插件拒绝启动，用户总得能进设置页改回来。
 */
function readPathField(
  source: Record<string, unknown>,
  key: string,
  warnings: string[],
  trail: string,
):
  | { readonly value: string; readonly reason?: undefined }
  | { readonly value: ''; readonly reason: 'missing' | 'empty' | 'relative' | 'invalid-type' } {
  const raw = source[key]
  if (raw === undefined) return { value: '', reason: 'missing' }
  if (typeof raw !== 'string') {
    warnings.push(`${trail}.${key} 应为字符串路径（收到 ${typeof raw}），已按未设置处理`)
    return { value: '', reason: 'invalid-type' }
  }

  const text = raw.trim()
  if (text === '') return { value: '', reason: 'empty' }
  if (!isAbsolute(text)) {
    warnings.push(`${trail}.${key} "${text}" 不是绝对路径，已按未设置处理`)
    return { value: '', reason: 'relative' }
  }
  return { value: text }
}

/**
 * 解析 `exportDir`（作品库导出路径），并把旧的 `outputDir` **迁移**过来。
 *
 * 迁移规则（顺序即优先级）：
 *   1. `exportDir` 有可用的绝对路径 → 用它，`outputDir` 彻底不再被读；
 *   2. `exportDir` 写坏了（非字符串 / 相对路径）→ 当作「需要用户自己修」，
 *      **不从旧字段回填**（静默改用另一个路径比"未设置"更让人意外）；
 *   3. `exportDir` **缺键**（升级上来的旧配置，或写回时已被规范化）且旧 `outputDir`
 *      有可用的绝对路径 → 搬到 `exportDir`，并记一条 warning 说明"已从 outputDir
 *      迁移"（**不能静默丢**：用户已经填好的路径必须跟过来）；
 *   4. 其余（含显式空串 = 用户清除过）→ 空串（未配置）。
 *
 * 只有"缺键"才会迁移，因此写回配置时可以放心把 `exportDir: ''` 落盘——
 * 用户显式清除过的值绝不会被旧 `outputDir` 复活。
 */
function pickExportDir(
  source: Record<string, unknown>,
  fallback: string,
  warnings: string[],
): string {
  const current = readPathField(source, 'exportDir', warnings, 'config')
  if (current.value !== '') return current.value
  // 只有"缺键"才迁移。显式空串（用户清除过）与写坏的值都**不**回填旧值：
  // 前者会让"清除"永远清不掉，后者会让用户当前填错的值被另一个路径顶替——
  // 两者都比"未设置"更让人意外（设置页会以"未设置"如实显示）。
  if (
    current.reason === 'empty' ||
    current.reason === 'relative' ||
    current.reason === 'invalid-type'
  ) {
    return ''
  }

  const legacy = readPathField(source, 'outputDir', warnings, 'config')
  if (legacy.value !== '') {
    warnings.push(
      `config.outputDir 已废弃（不再有任何行为），其值 "${legacy.value}" 已从 outputDir 迁移到 config.exportDir（作品库导出路径）`,
    )
    return legacy.value
  }

  return fallback
}

const API_MODES: readonly ApiMode[] = [
  'images-generations',
  'images-edits',
  'chat-image',
  'gemini-native',
]
const DIALECTS: readonly Dialect[] = ['standard', 'ofox', 'agnes']
const SIZE_MODES: readonly SizeMode[] = ['whitelist', 'exact', 'free']
const GROUPS: readonly ProviderGroup[] = ['official', 'aggregator', 'custom']

function parseProvider(
  raw: unknown,
  index: number,
  warnings: string[],
): ProviderConfig | undefined {
  const trail = `providers[${index}]`
  if (!isRecord(raw)) {
    warnings.push(`${trail} 不是对象，已跳过`)
    return undefined
  }

  const id = pickString(raw, 'id', '', warnings, trail).trim()
  if (id === '') {
    warnings.push(`${trail}.id 缺失，已跳过该厂商`)
    return undefined
  }

  const baseUrl = pickString(raw, 'baseUrl', '', warnings, trail).trim()
  if (baseUrl === '') warnings.push(`${trail}.baseUrl 为空，该厂商在补齐前不可用`)

  return {
    id,
    label: pickString(raw, 'label', id, warnings, trail),
    group: pickEnum<ProviderGroup>(raw, 'group', GROUPS, 'aggregator', warnings, trail),
    baseUrl,
    geminiNativeBaseUrl: pickString(raw, 'geminiNativeBaseUrl', '', warnings, trail).trim(),
    dialect: pickEnum<Dialect>(raw, 'dialect', DIALECTS, 'standard', warnings, trail),
    apiMode: pickEnum<ApiMode>(raw, 'apiMode', API_MODES, 'images-generations', warnings, trail),
    apiKeyEnv: pickString(raw, 'apiKeyEnv', '', warnings, trail).trim(),
    apiKey: pickString(raw, 'apiKey', '', warnings, trail),
    models: pickStringArray(raw, 'models', [], warnings, trail),
    allowedSizes: pickStringArray(raw, 'allowedSizes', [], warnings, trail),
    sizeMode: pickEnum<SizeMode>(raw, 'sizeMode', SIZE_MODES, 'whitelist', warnings, trail),
    extraHeaders: pickStringRecord(raw, 'extraHeaders', {}, warnings, trail),
    timeoutMs: pickNumber(raw, 'timeoutMs', 180_000, warnings, trail, { min: 1_000, max: 3_600_000 }),
  }
}

export interface ParseConfigResult {
  readonly config: PixmartConfig
  readonly warnings: readonly string[]
}

/**
 * 容错解析一份落盘配置。
 * @param raw - 已 JSON.parse 的内容；可以是任何东西。
 * @param fallback - 起点配置，默认出厂配置。
 */
export function parseConfig(raw: unknown, fallback: PixmartConfig = defaultConfig()): ParseConfigResult {
  const warnings: string[] = []

  if (raw === undefined || raw === null) {
    return { config: fallback, warnings: ['配置为空，使用出厂默认值'] }
  }
  if (!isRecord(raw)) {
    return { config: fallback, warnings: ['配置根不是对象，使用出厂默认值'] }
  }

  const providersRaw = raw.providers
  let providers: ProviderConfig[] = []
  if (providersRaw === undefined) {
    providers = [...fallback.providers]
    warnings.push('providers 缺失，沿用默认配置的厂商')
  } else if (!Array.isArray(providersRaw)) {
    providers = [...fallback.providers]
    warnings.push('providers 不是数组，沿用默认配置的厂商')
  } else {
    providers = providersRaw
      .map((item, index) => parseProvider(item, index, warnings))
      .filter((item): item is ProviderConfig => item !== undefined)

    const seen = new Set<string>()
    providers = providers.filter((item) => {
      if (seen.has(item.id)) {
        warnings.push(`厂商 id 重复：${item.id}，已保留首个`)
        return false
      }
      seen.add(item.id)
      return true
    })
  }

  const defaultsRaw = isRecord(raw.defaults) ? raw.defaults : {}
  const providerIds = providers.map((p) => p.id)
  const firstProvider = providers[0]

  const providerId = pickString(defaultsRaw, 'provider', '', warnings, 'defaults').trim()
  const resolvedProvider =
    providerId !== '' && providerIds.includes(providerId)
      ? providerId
      : (firstProvider?.id ?? '')
  if (providerId !== '' && !providerIds.includes(providerId)) {
    // 两种情形分开说：一家都没配（首次使用）→ 只能清空；有厂商但 id 写错 → 落到第一家。
    // 两种都**不编造**厂商：`resolvedProvider` 只会是 "" 或文件里真实存在的 id。
    warnings.push(
      resolvedProvider === ''
        ? `defaults.provider "${providerId}" 不存在（当前没有任何已配置厂商），已清空`
        : `defaults.provider "${providerId}" 不存在，已改用 "${resolvedProvider}"`,
    )
  }

  const model = pickString(defaultsRaw, 'model', '', warnings, 'defaults').trim()
  const providerModels = providers.find((p) => p.id === resolvedProvider)?.models ?? []
  const resolvedModel = model !== '' ? model : (providerModels[0] ?? '')

  const limitsRaw = isRecord(raw.limits) ? raw.limits : {}

  return {
    config: {
      version: pickNumber(raw, 'version', CONFIG_VERSION, warnings, 'config', { min: 1, max: 1_000 }),
      providers,
      // 用户显式删掉的出厂预设 id（`POST /providers/<id>/delete` 写）。
      // 容错：非数组/含空串按 `pickStringArray` 的既有规则处理；缺键用 `fallback` 的值。
      removedProviders: pickStringArray(
        raw,
        'removedProviders',
        fallback.removedProviders,
        warnings,
        'config',
      ),
      defaults: {
        provider: resolvedProvider,
        model: resolvedModel,
        size: pickString(defaultsRaw, 'size', '1:1', warnings, 'defaults').trim() || '1:1',
        n: pickNumber(defaultsRaw, 'n', 1, warnings, 'defaults', { min: 1, max: 4 }),
      },
      limits: {
        maxConcurrency: pickNumber(limitsRaw, 'maxConcurrency', 2, warnings, 'limits', { min: 1, max: 8 }),
        maxBatchItems: pickNumber(limitsRaw, 'maxBatchItems', 20, warnings, 'limits', { min: 1, max: 64 }),
        maxRetries: pickNumber(limitsRaw, 'maxRetries', 3, warnings, 'limits', { min: 0, max: 8 }),
        retentionDays: pickNumber(limitsRaw, 'retentionDays', 0, warnings, 'limits', { min: 0, max: 3_650 }),
      },
      promptOverrides: pickStringRecord(raw, 'promptOverrides', {}, warnings, 'config'),
      attachmentInConversation: pickBool(raw, 'attachmentInConversation', true, warnings, 'config'),
      exportDir: pickExportDir(raw, fallback.exportDir, warnings),
    },
    warnings,
  }
}

/**
 * 「一个厂商都没配」时的**唯一**可操作指引。
 *
 * 出厂清单为空，所以这是首次使用最常撞上的失败路径：文案必须说清**去哪、做什么**。
 * 只说"厂商解析失败"等于把人留在原地——用户看不到工具实现，也无从知道下一步。
 *
 * 四个失败点统一用它：`pixmart_check_size`（meta.ts）、`pixmart_generate` /
 * `pixmart_edit`（generate.ts）、`pixmart_batch`（batch.ts）。
 */
export const NO_PROVIDER_GUIDANCE =
  '还没有配置任何厂商：打开「设置 → PixMart → 厂商」，点「添加模型提供商」选一家并填入 API Key'

/**
 * 「找不到厂商」的统一失败文案，分两种情形：
 *   - **一家都没配**（`providers` 为空）→ `NO_PROVIDER_GUIDANCE`（可操作指引）；
 *   - **有厂商、但请求的 id 不存在** → 信息型文案，附上已配置的 id（排查拼写错误用）。
 *
 * 两种都**不猜**厂商：不会退回"第一家"或出厂预设（出厂清单本就是空的）。
 *
 * @param config - 当前配置。
 * @param id - 请求的厂商 id；省略用 `config.defaults.provider`（可能是空串 = 尚未选择）。
 */
export function providerNotFoundMessage(config: PixmartConfig, id?: string): string {
  if (config.providers.length === 0) return NO_PROVIDER_GUIDANCE
  const wanted = (id ?? config.defaults.provider).trim()
  const known = config.providers.map((provider) => provider.id).join(', ')
  return `找不到厂商 "${wanted}"；已配置：${known}`
}

/** 按 id 取厂商；`id` 为空时取默认厂商。 */
export function findProvider(
  config: PixmartConfig,
  id?: string,
): ProviderConfig | undefined {
  const wanted = (id ?? config.defaults.provider).trim()
  return config.providers.find((provider) => provider.id === wanted)
}

export type ApiKeyResolution =
  | { readonly ok: true; readonly key: string; readonly source: 'env' | 'config' }
  | { readonly ok: false; readonly reason: string }

/**
 * 解析密钥：环境变量 > 落盘配置。
 * @param provider - 厂商配置。
 * @param env - 环境变量表（注入以便测试）。
 */
export function resolveApiKey(
  provider: ProviderConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ApiKeyResolution {
  const envName = provider.apiKeyEnv.trim()
  if (envName !== '') {
    const fromEnv = env[envName]?.trim()
    if (fromEnv !== undefined && fromEnv !== '') {
      return { ok: true, key: fromEnv, source: 'env' }
    }
  }

  const stored = provider.apiKey.trim()
  if (stored !== '') return { ok: true, key: stored, source: 'config' }

  return {
    ok: false,
    reason:
      envName !== ''
        ? `厂商「${provider.label}」没有密钥：环境变量 ${envName} 为空，且未在设置页填写`
        : `厂商「${provider.label}」没有密钥：请在 设置 → 电商生图 中填写`,
  }
}

/** 供 RPC 回传的脱敏视图：**只暴露是否存在**，不回传密钥。 */
export interface ProviderView {
  readonly id: string
  readonly label: string
  readonly group: ProviderGroup
  readonly baseUrl: string
  readonly geminiNativeBaseUrl: string
  readonly dialect: Dialect
  readonly apiMode: ApiMode
  readonly apiKeyEnv: string
  readonly hasApiKey: boolean
  readonly apiKeySource: 'env' | 'config' | 'none'
  readonly models: readonly string[]
  readonly allowedSizes: readonly string[]
  readonly sizeMode: SizeMode
  /**
   * 设置页「默认尺寸」下拉的候选（`{value,label}`）。
   *
   * **值的词表由 `sizes.ts` 出**（内置能力优先），所以 UI 能选的 == `checkSize` 认的。
   * 用厂商的**第一个模型**当代表来定位能力：agnes 的官方表对全部 agnes 模型都一样，
   * 而 `models` 为空时退回厂商配置（`allowedSizes`）。客户端在没有这个字段时
   * 仍会退回 `allowedSizes`，保证老宿主可用。
   */
  readonly sizeOptions: readonly SizeOption[]
  readonly timeoutMs: number
}

/**
 * 生成脱敏视图。
 * @param provider - 厂商配置。
 * @param env - 环境变量表。
 */
export function toProviderView(
  provider: ProviderConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProviderView {
  const resolved = resolveApiKey(provider, env)
  return {
    id: provider.id,
    label: provider.label,
    group: provider.group,
    baseUrl: provider.baseUrl,
    geminiNativeBaseUrl: provider.geminiNativeBaseUrl,
    dialect: provider.dialect,
    apiMode: provider.apiMode,
    apiKeyEnv: provider.apiKeyEnv,
    hasApiKey: resolved.ok,
    apiKeySource: resolved.ok ? resolved.source : 'none',
    models: provider.models,
    allowedSizes: provider.allowedSizes,
    sizeMode: provider.sizeMode,
    sizeOptions: sizeOptionsFor({
      model: provider.models[0] ?? '',
      apiMode: provider.apiMode,
      provider,
    }),
    timeoutMs: provider.timeoutMs,
  }
}
