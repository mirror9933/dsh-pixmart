/**
 * 尺寸能力表与校验（技术方案 §7.6）。
 *
 * 关键约束：**取值格式随 apiMode/方言变化** —— `gemini-native` 用比例（`1:1`）、
 * OpenAI 兼容路径（standard/ofox）用像素（`1024x1024`）、**agnes 两种都能携带**
 * （`ratio` 是官方主参数，精确像素用来指定档位）。因此 `checkSize` 必须知道
 * 「请求体能携带哪些格式」，不能只按模型名判断。
 *
 * 校验**在发请求之前**执行：不支持的尺寸直接返回最近可用建议，不花用户的钱。
 *
 * 保真原则（2026-10-12 修）：归一化**不得**把请求里携带得了的信息丢掉。
 * 反例是 agnes —— 曾经把 `2048x2048` 一律塌缩成比例 `1:1`，档位（2K）在到达
 * 适配器之前就丢了，用户要 2K 静默拿到 1K。所以现在是**同格式优先**：
 * 输入是什么格式，就在该格式的声明值里比对；只有该格式请求体携带不了时才折算。
 */
import type { ApiMode, Dialect, ProviderConfig, SizeMode } from './config.js'

/** 请求体里尺寸能用的两种写法。 */
export type SizeForm = 'ratio' | 'pixel'

/** 一个内置能力条目。模型名越具体的规则排越前。 */
export interface SizeCapability {
  readonly match: RegExp
  /** 只对该方言生效；省略表示不限方言。 */
  readonly dialect?: Dialect
  readonly label: string
  readonly mode: SizeMode
  /** 声明的允许取值（比例与像素可以混排，各按各的格式比对）。 */
  readonly sizes: readonly string[]
  /**
   * 请求体**能**携带的格式，首个是首选（也是非得折算时的目标格式）。
   *
   * agnes 是唯一两种都能携带的方言：`ratio` 是官方主参数、也是默认，
   * 像素则用来把档位（1K–4K）精确表达出来。
   */
  readonly forms: readonly SizeForm[]
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

/**
 * Agnes 官方尺寸表：**8 比例 × 4 档位 = 32 个精确尺寸**，条目为 `[像素, 档位, 比例]`。
 *
 * 出处：官方文档「Output Dimension Reference」（agnes-image-2.5-flash 页；
 * 2.1-flash 与之同表）。表的用途是**档位的唯一来源**——官方 `size` 只接受
 * `1K`/`2K`/`3K`/`4K`，比例另走 `ratio`；想同时指定「2K + 16:9」就只能落到
 * 表里的 `2624x1472`。注意官方像素是按 32 对齐的近似值（16:9 实际是 41:23），
 * 所以**不能用"化简比例是否等于 16:9"来判断**，必须查这张表。
 */
export const AGNES_SIZE_TABLE: readonly (readonly [string, string, string])[] = [
  ['1024x1024', '1K', '1:1'], ['2048x2048', '2K', '1:1'], ['3072x3072', '3K', '1:1'], ['4096x4096', '4K', '1:1'],
  ['864x1152', '1K', '3:4'], ['1728x2304', '2K', '3:4'], ['2592x3456', '3K', '3:4'], ['3456x4608', '4K', '3:4'],
  ['1152x864', '1K', '4:3'], ['2304x1728', '2K', '4:3'], ['3456x2592', '3K', '4:3'], ['4608x3456', '4K', '4:3'],
  ['1312x736', '1K', '16:9'], ['2624x1472', '2K', '16:9'], ['3936x2208', '3K', '16:9'], ['5248x2944', '4K', '16:9'],
  ['736x1312', '1K', '9:16'], ['1472x2624', '2K', '9:16'], ['2208x3936', '3K', '9:16'], ['2944x5248', '4K', '9:16'],
  ['832x1248', '1K', '2:3'], ['1664x2496', '2K', '2:3'], ['2496x3744', '3K', '2:3'], ['3328x4992', '4K', '2:3'],
  ['1248x832', '1K', '3:2'], ['2496x1664', '2K', '3:2'], ['3744x2496', '3K', '3:2'], ['4992x3328', '4K', '3:2'],
  ['1568x672', '1K', '21:9'], ['3136x1344', '2K', '21:9'], ['4704x2016', '3K', '21:9'], ['6272x2688', '4K', '21:9'],
]

/** Agnes 的 4 个档位（清晰度）。 */
export const AGNES_TIERS: readonly string[] = ['1K', '2K', '3K', '4K']

/** Agnes 官方 `ratio` 支持的全部 8 种比例。 */
export const AGNES_RATIOS: readonly string[] = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9']

/** 32 个精确像素尺寸（档位由它决定）。 */
export const AGNES_PIXEL_SIZES: readonly string[] = AGNES_SIZE_TABLE.map((entry) => entry[0])

/**
 * Agnes 的完整允许清单。**档位（像素）排在前**：无法解析的输入会把前几个当作
 * 提示返回，先看到 `1024x1024/2048x2048/3072x3072` 比先看到比例更有用。
 */
export const AGNES_ALLOWED_SIZES: readonly string[] = [...AGNES_PIXEL_SIZES, ...AGNES_RATIOS]

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

/** 内置能力表：按顺序取第一个命中（还要满足 `dialect` 限定，若有）。 */
export const SIZE_CAPABILITIES: readonly SizeCapability[] = [
  {
    match: /gemini.*image|imagen|nano[- ]?banana/i,
    label: 'Gemini 图像模型',
    mode: 'whitelist',
    sizes: GEMINI_IMAGE_RATIOS,
    forms: ['ratio'],
  },
  {
    match: /gpt-image/i,
    label: 'gpt-image 系列',
    mode: 'whitelist',
    sizes: GPT_IMAGE_SIZES,
    forms: ['pixel'],
  },
  {
    match: /dall-e-3/i,
    label: 'DALL·E 3',
    mode: 'whitelist',
    sizes: DALLE3_SIZES,
    forms: ['pixel'],
  },
  {
    // agnes 的尺寸能力**不依赖 config.json 里的 allowedSizes**：出厂预设后来才加上
    // 像素表时，老配置不会自动更新（`applyFactoryPresets` 只补厂商、不改字段），
    // 结果就是"代码改了、用户那边不生效"。官方表放内置能力里，谁的配置都算数。
    match: /agnes/i,
    dialect: 'agnes',
    label: 'Agnes 官方尺寸表',
    mode: 'whitelist',
    sizes: AGNES_ALLOWED_SIZES,
    forms: ['ratio', 'pixel'],
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
      /** 归一化为该 apiMode/方言需要的格式（同格式精确命中时**原样保留**）。 */
      readonly normalized: string
      readonly capability: string
      /** 该能力声明的全部允许取值（原样）。供工具按需展示完整清单。 */
      readonly declaredSizes: readonly string[]
    }
  | {
      readonly supported: false
      readonly reason: string
      /** 最近可用的取值（最多 3 个）。 */
      readonly nearest: readonly string[]
      readonly capability: string
      readonly declaredSizes: readonly string[]
    }

const PIXEL_PATTERN = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i
const RATIO_PATTERN = /^(\d{1,3})\s*:\s*(\d{1,3})$/

/** 超过这个对数纵横比偏差就认为"不是同一个比例"（约 3%）。 */
const ASPECT_TOLERANCE = 0.03

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

/** 判断输入是哪种格式；都不是则 undefined。 */
function formOf(size: string): SizeForm | undefined {
  const trimmed = size.trim()
  if (PIXEL_PATTERN.test(trimmed)) return 'pixel'
  if (RATIO_PATTERN.test(trimmed)) return 'ratio'
  return undefined
}

/** 比较用的规范形：大小写、`×`/`*`/空格都不影响相等判断。 */
function canon(size: string): string {
  return size.trim().toLowerCase().replace(/[×*]/g, 'x').replace(/\s+/g, '')
}

/** 对数纵横比距离（1:1 与 2:1 的距离对称）。 */
function aspectDistance(a: number, b: number): number {
  return Math.abs(Math.log(a / b))
}

function aspectOf(size: string): number | undefined {
  const dim = dimensions(size)
  return dim === undefined ? undefined : dim.w / dim.h
}

/** 最长边；无法解析返回 undefined。 */
function longestSide(size: string): number | undefined {
  const dim = dimensions(size)
  return dim === undefined ? undefined : Math.max(dim.w, dim.h)
}

/**
 * 按纵横比接近程度排序（最近的最多 3 个）。
 *
 * 纵横比相同时用**最长边差距**做次序：agnes 的 1:1 有 1024/2048/3072/4096 四个，
 * 要 `9999x9999` 时应该先提示 `4096x4096`，而不是字典序最小的那个。
 */
function byAspectDistance(target: string, candidates: readonly string[]): readonly string[] {
  const base = dimensions(target)
  if (base === undefined) return [...candidates].slice(0, 3)

  const baseAspect = base.w / base.h
  const baseSpan = Math.max(base.w, base.h)
  return [...candidates]
    .map((candidate) => {
      const dim = dimensions(candidate)
      const aspect = dim === undefined ? 1 : dim.w / dim.h
      const span = dim === undefined ? 0 : Math.max(dim.w, dim.h)
      return {
        candidate,
        distance: aspectDistance(aspect, baseAspect),
        spanGap: Math.abs(span - baseSpan),
      }
    })
    .sort(
      (a, b) =>
        a.distance - b.distance || a.spanGap - b.spanGap || a.candidate.localeCompare(b.candidate),
    )
    .slice(0, 3)
    .map((entry) => entry.candidate)
}

/**
 * 该 apiMode/方言下请求体**能**携带的格式，首个是首选。
 *
 * `gemini-native` 用比例；agnes 两种都能携带（比例是官方主参数，像素用来定档位）；
 * 其余 OpenAI 兼容路径用像素。
 */
export function acceptedForms(apiMode: ApiMode, dialect?: Dialect): readonly SizeForm[] {
  if (apiMode === 'gemini-native') return ['ratio']
  if (dialect === 'agnes') return ['ratio', 'pixel']
  return ['pixel']
}

/** 把任意格式的尺寸折算到目标格式。 */
function normalizeTo(size: string, form: SizeForm): string | undefined {
  const trimmed = size.trim()
  const isPixel = PIXEL_PATTERN.test(trimmed)
  const isRatio = RATIO_PATTERN.test(trimmed)

  if (form === 'ratio') {
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
  const builtin = SIZE_CAPABILITIES.find(
    (entry) =>
      entry.match.test(input.model) &&
      (entry.dialect === undefined || entry.dialect === input.provider.dialect),
  )
  if (builtin !== undefined) return builtin

  const { provider } = input
  return {
    match: /.*/,
    label: `${provider.label} 配置`,
    mode: provider.sizeMode,
    sizes: provider.allowedSizes,
    forms: acceptedForms(input.apiMode, provider.dialect),
  }
}

/**
 * 在**同一格式**的声明值里就近吸附。
 *
 * - 比例输入：只按纵横比选最近的一个；偏差超过 `ASPECT_TOLERANCE` 视为不支持
 *   （整数比例很稀疏，`5:4` 对 agnes 就该被挡住，而不是悄悄给 `4:3`）。
 * - 像素输入：先在"纵横比在容差内"的同族里选最长边最接近的声明尺寸；若请求比
 *   该族的**最大**声明尺寸还大，视为超出能力（返回 undefined），避免把
 *   `9999x9999` 静默吸附成某个小尺寸。
 *
 * @param size - 用户/Agent 给的尺寸。
 * @param pool - 同一格式的声明值。
 * @returns 吸附到的声明值；无法吸附返回 undefined。
 */
function snapWithin(size: string, pool: readonly string[]): string | undefined {
  const dim = dimensions(size)
  if (dim === undefined) return undefined
  const targetAspect = dim.w / dim.h
  const targetSpan = Math.max(dim.w, dim.h)
  const pixelInput = PIXEL_PATTERN.test(size.trim())

  let best: string | undefined
  let bestAspect = Number.POSITIVE_INFINITY
  let bestSpanGap = Number.POSITIVE_INFINITY
  let familyMaxSpan = 0

  for (const entry of pool) {
    const entryDim = dimensions(entry)
    if (entryDim === undefined) continue
    const distance = aspectDistance(entryDim.w / entryDim.h, targetAspect)
    if (distance > ASPECT_TOLERANCE) continue
    if (pixelInput) familyMaxSpan = Math.max(familyMaxSpan, Math.max(entryDim.w, entryDim.h))

    const spanGap = Math.abs(Math.max(entryDim.w, entryDim.h) - targetSpan)
    if (distance < bestAspect - 1e-9 || (Math.abs(distance - bestAspect) <= 1e-9 && spanGap < bestSpanGap)) {
      best = entry
      bestAspect = distance
      bestSpanGap = spanGap
    }
  }

  if (best === undefined) return undefined
  if (pixelInput && targetSpan > familyMaxSpan) return undefined
  return best
}

/** 把输入折算到首选格式后，与声明值（同样折算）比对。 */
function convertedHit(
  input: SizeCheckInput,
  declared: readonly string[],
  preferred: SizeForm,
): { converted: string; hit: string } | undefined {
  const converted = normalizeTo(input.size, preferred)
  if (converted === undefined) return undefined
  const hit = declared.find(
    (entry) => formOf(entry) === preferred && canon(entry) === canon(converted),
  )
  // 声明的格式与首选格式不一致时（如 ofox 只声明比例、请求要像素），把声明值也折算过去。
  if (hit !== undefined) return { converted, hit }
  const folded = declared.find((entry) => {
    const foldedEntry = normalizeTo(entry, preferred)
    return foldedEntry !== undefined && canon(foldedEntry) === canon(converted)
  })
  return folded === undefined ? undefined : { converted, hit: folded }
}

/**
 * 校验尺寸并给出归一化结果或最近可用建议。
 * @param input - 模型、目标尺寸、apiMode 与厂商配置。
 */
export function checkSize(input: SizeCheckInput): SizeCheckResult {
  const capability = capabilityFor(input)
  const declared = capability.sizes
  const forms = capability.forms
  const preferred = forms[0] ?? 'pixel'
  const inputForm = formOf(input.size)

  const fail = (reason: string, pool: readonly string[]): SizeCheckResult => ({
    supported: false,
    reason,
    nearest: byAspectDistance(input.size, pool.length > 0 ? pool : declared),
    capability: capability.label,
    declaredSizes: declared,
  })

  const pick = (normalized: string): SizeCheckResult => ({
    supported: true,
    normalized,
    capability: capability.label,
    declaredSizes: declared,
  })

  if (inputForm === undefined) {
    // 只给档位（`2K`）时不能默认一个比例——那就成了"静默替用户做选择"。
    // 但也不能只回一句"无法解析"：档位是官方参数名，用户/Agent 很容易这么写，
    // 所以这里直接给出用精确像素表达「档位 + 比例」的例子。
    const tierLike = /^\s*[1-4]\s*K\s*$/i.test(input.size)
    const pixelExamples = declared.filter((entry) => formOf(entry) === 'pixel')
    if (tierLike && pixelExamples.length > 0) {
      const examples = pixelExamples.slice(0, 4)
      return fail(
        `尺寸 "${input.size}" 不能单独给档位：请用精确像素尺寸表达「档位 + 比例」，如 ${examples.join('、')}`,
        examples,
      )
    }
    return fail(
      `尺寸 "${input.size}" 无法解析；请给出${
        preferred === 'ratio' ? '比例（如 1:1）' : '像素（如 1024x1024）'
      }`,
      declared.slice(0, 3),
    )
  }

  // free 模式：只做格式与边界校验，不猜白名单。
  if (capability.mode === 'free') {
    const normalized = normalizeTo(input.size, preferred)
    if (normalized === undefined) {
      return fail(`尺寸 "${input.size}" 无法折算到${preferred === 'ratio' ? '比例' : '像素'}`, declared)
    }
    if (preferred === 'pixel') {
      const dim = dimensions(normalized)
      if (dim === undefined || dim.w > 4096 || dim.h > 4096) {
        return fail(`像素尺寸 "${normalized}" 超出 4096 上限或格式非法`, declared)
      }
    }
    return pick(normalized)
  }

  if (declared.length === 0) {
    return {
      supported: false,
      reason: `模型 "${input.model}" 没有可用的尺寸清单：厂商「${input.provider.label}」未配置 allowedSizes`,
      nearest: [],
      capability: capability.label,
      declaredSizes: [],
    }
  }

  // 该格式请求体携带得了，就以**这个格式**为准：精确命中原样返回（保真），
  // 否则在同一格式的声明值里就近吸附。
  if (forms.includes(inputForm)) {
    const hit = declared.find(
      (entry) => formOf(entry) === inputForm && canon(entry) === canon(input.size),
    )
    if (hit !== undefined) return pick(hit)

    const pool = declared.filter((entry) => formOf(entry) === inputForm)
    if (pool.length > 0) {
      const snapped = snapWithin(input.size, pool)
      if (snapped !== undefined) return pick(snapped)
      return fail(`模型 "${input.model}" 不支持尺寸 "${input.size}"（${capability.label}）`, pool)
    }
  }

  // 该格式请求体携带不了（如 ofox 只认像素、却给了比例）→ 折算到首选格式再比对。
  const converted = convertedHit(input, declared, preferred)
  if (converted !== undefined) return pick(converted.converted)

  const pool = declared.filter((entry) => formOf(entry) === preferred)
  return fail(
    `模型 "${input.model}" 不支持尺寸 "${input.size}"（${capability.label}）`,
    pool.length > 0 ? pool : declared,
  )
}

// ─────────────────────────────────────────────────────────── Agnes 档位/比例

/** Agnes 里与目标纵横比最接近的官方比例。 */
export function agnesNearestRatio(size: string): string {
  const target = aspectOf(size)
  if (target === undefined) return '1:1'

  let best = AGNES_RATIOS[0] ?? '1:1'
  let bestDistance = Number.POSITIVE_INFINITY
  for (const ratio of AGNES_RATIOS) {
    const ratioAspect = aspectOf(ratio)
    if (ratioAspect === undefined) continue
    const distance = aspectDistance(ratioAspect, target)
    // 严格小于：并列时取列表里靠前的（1:1 优先），结果确定。
    if (distance < bestDistance) {
      bestDistance = distance
      best = ratio
    }
  }
  return best
}

/** 给定比例下，按最长边就近归档位。 */
function agnesNearestTier(ratio: string, w: number, h: number): string {
  const span = Math.max(w, h)
  let best: readonly [string, string, string] | undefined
  for (const entry of AGNES_SIZE_TABLE) {
    if (entry[2] !== ratio) continue
    if (best === undefined) {
      best = entry
      continue
    }
    const entrySpan = longestSide(entry[0]) ?? 0
    const bestSpan = longestSide(best[0]) ?? 0
    if (Math.abs(entrySpan - span) < Math.abs(bestSpan - span)) best = entry
  }
  return best?.[1] ?? '1K'
}

/**
 * 把任意尺寸写法解成 Agnes 的 `size`（档位）+ `ratio`。
 *
 * - `2K` 这类档位输入 → 档位 + 官方默认比例 `1:1`；
 * - 表内精确像素 → 表里记的档位与比例（`2624x1472` → `2K` + `16:9`，
 *   注意**不能**靠化简比例得到 16:9，41:23 会漏）；
 * - 表外像素 → 最近官方比例 + 该比例下最长边最近的档位；
 * - 比例输入 → 该比例 + 官方默认档位 `1K`（比例本身不带清晰度信息）。
 *
 * @param size - 已归一化的尺寸（比例或像素）。
 */
export function agnesSizeSpec(size: string): { tier: string; ratio: string } {
  const trimmed = size.trim()

  const tierInput = /^([1-4])\s*K$/i.exec(trimmed)
  if (tierInput !== null) return { tier: `${tierInput[1]}K`, ratio: '1:1' }

  for (const entry of AGNES_SIZE_TABLE) {
    if (entry[0] === trimmed) return { tier: entry[1], ratio: entry[2] }
  }

  const dim = dimensions(trimmed)
  if (dim === undefined) return { tier: '1K', ratio: '1:1' }

  const ratio = agnesNearestRatio(trimmed)
  if (RATIO_PATTERN.test(trimmed)) return { tier: '1K', ratio }
  return { tier: agnesNearestTier(ratio, dim.w, dim.h), ratio }
}
