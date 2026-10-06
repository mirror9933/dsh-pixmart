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
export type ProviderGroup = 'official' | 'aggregator'

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
    allowedSizes: ['1:1', '3:4', '4:3', '9:16', '16:9'],
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
 *   - baseUrl 用官方文档的 `apihub.agnes-ai.com`，**不是**参考项目的 `api.agnes-ai.cn`
 *     （冲突未解决，见 §25.2 第 1 条）。
 */
export function defaultAgnesProvider(): ProviderConfig {
  return {
    id: 'agnes',
    label: 'Agnes AI',
    group: 'official',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
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
    allowedSizes: ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'],
    sizeMode: 'whitelist',
    extraHeaders: {},
    // 官方建议客户端超时 60–360s。
    timeoutMs: 180_000,
  }
}

/**
 * 出厂配置：一个未填密钥的 Ofox，方便用户直接进设置页填。
 *
 * `providers` 是**出厂预设清单**：这里每加一个厂商，`applyFactoryPresets` 就会在
 * 下一次 `ConfigStore.load()` 时把它补进已有配置（见该函数）。
 */
export function defaultConfig(): PixmartConfig {
  const provider = defaultOfoxProvider()
  return {
    version: CONFIG_VERSION,
    providers: [provider, defaultAgnesProvider()],
    defaults: {
      provider: provider.id,
      model: provider.models[0] ?? '',
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
 * 把出厂预设里**文件里没有的**厂商补进配置（设计缺口修复，2026-10-12）。
 *
 * 为什么需要它：`parseConfig` 以文件为准，于是**新增的厂商预设对已有安装永远不可见**——
 * 实测就是这样，用户磁盘上的 `config.json` 建于只有 ofox 的年代，代码里后加的 agnes
 * 因此一直没出现在设置页。这不是 agnes 的特例，以后每加一个厂商都会重现。
 *
 * 规则（顺序即优先级）：
 *   1. **文件为准**：已存在的 id 一个字段都不碰——用户填的 baseUrl / apiKey / models
 *      必须逐字节保持原样，哪怕它和出厂预设已经不一样（那正是用户自己的选择）；
 *   2. **只追加缺的**：`factory.providers` 里文件没有的 id 追加到**末尾**，用出厂预设、
 *      `apiKey` 为空（"尚未配置"状态）。追加在末尾，文件里的厂商顺序与 `providers[0]` 不变；
 *   3. **defaults / limits / 其它字段完全不动**：它们来自文件，包括 `defaults.provider`。
 *      补齐厂商**不会**顺带改默认厂商——用户原来用 ofox，就还是 ofox；
 *   4. **不改写磁盘**：本函数是纯函数，`ConfigStore.load()` 只在内存里用它；文件只会在
 *      用户后续显式保存（设置页）时才落盘。
 *
 * 取舍（**明说，不粉饰**）：因为出厂预设每次 load 都补齐，用户在文件里删掉某个厂商后
 * 它下次 load 会被**补回来**。要"彻底移除"需要"禁用列表"或"添加厂商"UI——**本次不做**，
 * 记在 `docs/contract-notes.md` §26.4 的已知限制里。好处是：补齐只发生在内存，
 * 用户没保存之前磁盘上的文件一个字节都没变，"删掉"这个动作仍然保留着最后可能。
 *
 * @param config - 已解析的落盘配置（用户为准）。
 * @param factory - 出厂预设，默认 `defaultConfig()`。
 */
export function applyFactoryPresets(
  config: PixmartConfig,
  factory: PixmartConfig = defaultConfig(),
): FactoryPresetMerge {
  const present = new Set(config.providers.map((provider) => provider.id))
  const missing = factory.providers.filter((provider) => !present.has(provider.id))
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
const GROUPS: readonly ProviderGroup[] = ['official', 'aggregator']

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
    warnings.push('providers 缺失，沿用出厂厂商')
  } else if (!Array.isArray(providersRaw)) {
    providers = [...fallback.providers]
    warnings.push('providers 不是数组，沿用出厂厂商')
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
    warnings.push(`defaults.provider "${providerId}" 不存在，已改用 "${resolvedProvider}"`)
  }

  const model = pickString(defaultsRaw, 'model', '', warnings, 'defaults').trim()
  const providerModels = providers.find((p) => p.id === resolvedProvider)?.models ?? []
  const resolvedModel = model !== '' ? model : (providerModels[0] ?? '')

  const limitsRaw = isRecord(raw.limits) ? raw.limits : {}

  return {
    config: {
      version: pickNumber(raw, 'version', CONFIG_VERSION, warnings, 'config', { min: 1, max: 1_000 }),
      providers,
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
    timeoutMs: provider.timeoutMs,
  }
}
