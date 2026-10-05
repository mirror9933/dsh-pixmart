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

/** 四种调用形态。`gemini-native` 是 Ofox 的 Gemini 图像模型唯一可用路径。 */
export type ApiMode = 'images-generations' | 'images-edits' | 'chat-image' | 'gemini-native'
export type Dialect = 'standard' | 'ofox'
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
  readonly exportToWorkspace: boolean
  readonly attachmentInConversation: boolean
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

/** 出厂配置：一个未填密钥的 Ofox，方便用户直接进设置页填。 */
export function defaultConfig(): PixmartConfig {
  const provider = defaultOfoxProvider()
  return {
    version: CONFIG_VERSION,
    providers: [provider],
    defaults: {
      provider: provider.id,
      model: provider.models[0] ?? '',
      size: '1:1',
      n: 1,
    },
    limits: { maxConcurrency: 2, maxBatchItems: 20, maxRetries: 3, retentionDays: 0 },
    promptOverrides: {},
    exportToWorkspace: false,
    attachmentInConversation: true,
  }
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

const API_MODES: readonly ApiMode[] = [
  'images-generations',
  'images-edits',
  'chat-image',
  'gemini-native',
]
const DIALECTS: readonly Dialect[] = ['standard', 'ofox']
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
      exportToWorkspace: pickBool(raw, 'exportToWorkspace', false, warnings, 'config'),
      attachmentInConversation: pickBool(raw, 'attachmentInConversation', true, warnings, 'config'),
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
