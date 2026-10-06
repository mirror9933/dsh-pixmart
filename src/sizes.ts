/**
 * 尺寸能力表与校验（技术方案 §7.6）。
 *
 * 关键约束：**取值格式随 apiMode 变化** —— `gemini-native` 用比例（`1:1`），
 * OpenAI 兼容路径用像素（`1024x1024`）。因此 `checkSize` 必须同时接收 apiMode，
 * 不能只按模型名判断。
 *
 * 校验**在发请求之前**执行：不支持的尺寸直接返回最近可用建议，不花用户的钱。
 */
import type { ApiMode, Dialect, ProviderConfig, SizeMode } from './config.js'

/** 一个内置能力条目。模型名越具体的规则排越前。 */
export interface SizeCapability {
  readonly match: RegExp
  readonly label: string
  readonly mode: SizeMode
  /** whitelist / exact 模式下的允许取值（比例或像素，取决于 `kind`）。 */
  readonly sizes: readonly string[]
  readonly kind: 'ratio' | 'pixel'
}

/** Gemini 图像系官方支持的 10 种比例（P0 从参考项目只读取证，方案 §7.4.1）。 */
export const GEMINI_IMAGE_RATIOS: readonly string[] = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
]

/** gpt-image 系列的 3 种像素 + auto。 */
const GPT_IMAGE_SIZES: readonly string[] = ['1024x1024', '1536x1024', '1024x1536']

/** DALL·E 3 的 3 种像素。 */
const DALLE3_SIZES: readonly string[] = ['1024x1024', '1792x1024', '1024x1792']

/** 比例 ↔ 标准像素的规范化表（比例 → 该比例的标准输出像素）。 */
const RATIO_PIXELS: Readonly<Record<string, readonly [number, number]>> = {
  '1:1': [1024, 1024],
  '2:3': [832, 1248],
  '3:2': [1248, 832],
  '3:4': [960, 1280],
  '4:3': [1280, 960],
  '4:5': [896, 1120],
  '5:4': [1120, 896],
  '9:16': [864, 1536],
  '16:9': [1536, 864],
  '21:9': [1792, 768],
}

/** 内置能力表：按顺序取第一个命中。 */
export const SIZE_CAPABILITIES: readonly SizeCapability[] = [
  {
    match: /gemini.*image|imagen|nano[- ]?banana/i,
    label: 'Gemini 图像模型',
    mode: 'whitelist',
    sizes: GEMINI_IMAGE_RATIOS,
    kind: 'ratio',
  },
  {
    match: /gpt-image/i,
    label: 'gpt-image 系列',
    mode: 'whitelist',
    sizes: GPT_IMAGE_SIZES,
    kind: 'pixel',
  },
  {
    match: /dall-e-3/i,
    label: 'DALL·E 3',
    mode: 'whitelist',
    sizes: DALLE3_SIZES,
    kind: 'pixel',
  },
]

export interface SizeCheckInput {
  readonly model: string
  /** 用户/Agent 给的尺寸，比例或像素都可以。 */
  readonly size: string
  readonly apiMode: ApiMode
  readonly provider: ProviderConfig
}

export type SizeCheckResult =
  | {
      readonly supported: true
      /** 归一化为该 apiMode 需要的格式。 */
      readonly normalized: string
      readonly capability: string
    }
  | {
      readonly supported: false
      readonly reason: string
      /** 最近可用的取值（最多 3 个），格式与 apiMode 一致。 */
      readonly nearest: readonly string[]
      readonly capability: string
    }

const PIXEL_PATTERN = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i
const RATIO_PATTERN = /^(\d{1,3})\s*:\s*(\d{1,3})$/

function gcd(a: number, b: number): number {
  let x = a
  let y = b
  while (y !== 0) {
    const t = x % y
    x = y
    y = t
  }
  return x === 0 ? 1 : x
}

/** 像素 → 最简比例；无法解析返回 undefined。 */
export function pixelToRatio(size: string): string | undefined {
  const match = PIXEL_PATTERN.exec(size.trim())
  if (match === null) return undefined
  const w = Number(match[1])
  const h = Number(match[2])
  if (w <= 0 || h <= 0) return undefined
  const divisor = gcd(w, h)
  return `${w / divisor}:${h / divisor}`
}

/** 比例 → 标准像素；不在表内时按长边 1024 计算并取 8 的倍数。 */
export function ratioToPixels(ratio: string): string | undefined {
  const key = ratio.trim()
  const known = RATIO_PIXELS[key]
  if (known !== undefined) return `${known[0]}x${known[1]}`

  const match = RATIO_PATTERN.exec(key)
  if (match === null) return undefined
  const w = Number(match[1])
  const h = Number(match[2])
  if (w <= 0 || h <= 0) return undefined

  const scale = 1024 / Math.max(w, h)
  const round8 = (value: number): number => Math.max(8, Math.round((value * scale) / 8) * 8)
  return `${round8(w)}x${round8(h)}`
}

/** 取宽高（比例或像素都可以）。 */
function dimensions(size: string): { w: number; h: number } | undefined {
  const pixel = PIXEL_PATTERN.exec(size.trim())
  if (pixel !== null) return { w: Number(pixel[1]), h: Number(pixel[2]) }
  const ratio = RATIO_PATTERN.exec(size.trim())
  if (ratio !== null) return { w: Number(ratio[1]), h: Number(ratio[2]) }
  return undefined
}

/** 按长宽比接近程度排序（对数距离，比例 1:1 与 2:1 的距离对称）。 */
function byAspectDistance(target: string, candidates: readonly string[]): readonly string[] {
  const base = dimensions(target)
  if (base === undefined) return [...candidates].slice(0, 3)

  const baseAspect = base.w / base.h
  return [...candidates]
    .map((candidate) => {
      const dim = dimensions(candidate)
      const aspect = dim === undefined ? 1 : dim.w / dim.h
      return { candidate, distance: Math.abs(Math.log(aspect) - Math.log(baseAspect)) }
    })
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, 3)
    .map((entry) => entry.candidate)
}

/**
 * 该 apiMode/方言需要的取值格式。
 *
 * `gemini-native` 用比例；OpenAI 兼容路径通常用像素，但 **agnes 方言是例外**——
 * 它的 `size` 是档位（`1K`/`2K`/…），比例另走 `ratio`，所以归一化结果应当是
 * **比例**（如 `3:4`），由适配器拼成 `size: '1K'` + `ratio: '3:4'`。
 */
function requiredKind(apiMode: ApiMode, dialect?: Dialect): 'ratio' | 'pixel' {
  if (apiMode === 'gemini-native') return 'ratio'
  if (dialect === 'agnes') return 'ratio'
  return 'pixel'
}

/** 把任意格式的尺寸归一化到目标格式。 */
function normalizeTo(size: string, kind: 'ratio' | 'pixel'): string | undefined {
  const trimmed = size.trim()
  const isPixel = PIXEL_PATTERN.test(trimmed)
  const isRatio = RATIO_PATTERN.test(trimmed)

  if (kind === 'ratio') {
    if (isRatio) return trimmed
    if (isPixel) return pixelToRatio(trimmed)
    return undefined
  }

  if (isPixel) return trimmed
  if (isRatio) return ratioToPixels(trimmed)
  return undefined
}

/** 选出适用于该模型/厂商的能力条目（内置优先，其次厂商配置）。 */
function capabilityFor(input: SizeCheckInput): SizeCapability {
  const builtin = SIZE_CAPABILITIES.find((entry) => entry.match.test(input.model))
  if (builtin !== undefined) return builtin

  const { provider } = input
  return {
    match: /.*/,
    label: `${provider.label} 配置`,
    mode: provider.sizeMode,
    sizes: provider.allowedSizes,
    kind: requiredKind(input.apiMode, provider.dialect),
  }
}

/**
 * 校验尺寸并给出归一化结果或最近可用建议。
 * @param input - 模型、目标尺寸、apiMode 与厂商配置。
 */
export function checkSize(input: SizeCheckInput): SizeCheckResult {
  const kind = requiredKind(input.apiMode, input.provider.dialect)
  const capability = capabilityFor(input)

  const normalized = normalizeTo(input.size, kind)
  if (normalized === undefined) {
    return {
      supported: false,
      reason: `尺寸 "${input.size}" 无法解析；请给出${kind === 'ratio' ? '比例（如 1:1）' : '像素（如 1024x1024）'}`,
      nearest: capability.sizes.slice(0, 3),
      capability: capability.label,
    }
  }

  // free 模式：只做格式与边界校验，不猜白名单。
  if (capability.mode === 'free') {
    if (kind === 'pixel') {
      const dim = dimensions(normalized)
      if (dim === undefined || dim.w > 4096 || dim.h > 4096) {
        return {
          supported: false,
          reason: `像素尺寸 "${normalized}" 超出 4096 上限或格式非法`,
          nearest: capability.sizes.slice(0, 3),
          capability: capability.label,
        }
      }
    }
    return { supported: true, normalized, capability: capability.label }
  }

  if (capability.sizes.length === 0) {
    return {
      supported: false,
      reason: `模型 "${input.model}" 没有可用的尺寸清单：厂商「${input.provider.label}」未配置 allowedSizes`,
      nearest: [],
      capability: capability.label,
    }
  }

  // 白名单比较统一在「同一格式」下进行。
  const candidates = capability.sizes
    .map((size) => normalizeTo(size, kind))
    .filter((size): size is string => size !== undefined)

  if (candidates.includes(normalized)) {
    return { supported: true, normalized, capability: capability.label }
  }

  return {
    supported: false,
    reason: `模型 "${input.model}" 不支持尺寸 "${normalized}"（${capability.label}）`,
    nearest: byAspectDistance(normalized, candidates),
    capability: capability.label,
  }
}
