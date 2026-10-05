/**
 * 提示词拼装 —— **纯函数**，同入参必得同输出（技术方案 §7.5）。
 *
 * 因此它可以单测、可以重放，也让「先看后花钱」的 `pixmart_prompt` 有意义：
 * 用户/Agent 看到的就是真正会发出去的文本。
 *
 * F2/F3 修正（A2 真实生图暴露，见 contract-notes §10.2）：
 *   - **F2**：模块片段是由「有参考图」的场景写成的（含 "of the reference image" 之类）。
 *     文生图没有参考图时这些话是错的，会误导模型。因此拼装必须知道 `hasReferences`，
 *     并在无参考图时**按句剔除**依赖参考图的句子。
 *   - **F3**：无产品描述时模型会自己编一个**真实品牌**（实测生成了 Clorox 包装）。
 *     因此无 `product` 取值时注入「通用无品牌」主体，并在负向提示里明确禁止真实品牌与商标。
 */
import type { ModuleDef } from './types.js'

/** 覆盖表的键：`<moduleId>` 覆盖整段，`<moduleId>.<fragment>` 覆盖单个片段。 */
export type PromptOverrides = Readonly<Record<string, string>>

export interface BuildPromptInput {
  readonly module: ModuleDef
  /** 占位符取值；未提供的占位符用中性描述填充，绝不留 `{xxx}` 字面量。 */
  readonly vars?: Readonly<Record<string, string>>
  readonly overrides?: PromptOverrides
  /** 用户/Agent 的补充指令，**追加**在末尾，不破坏模块骨架。 */
  readonly userPrompt?: string
  /**
   * 本次请求是否带参考图。**默认 false**（文生图）——
   * 保守假设「没有参考图」比假设「有」更安全：前者最多删掉几句描述，
   * 后者会让模型去"保持"一张并不存在的图。
   */
  readonly hasReferences?: boolean
}

export interface BuiltPrompt {
  readonly prompt: string
  readonly negative?: string
  readonly size: string
  /** 实际参与拼装的片段，便于 dry run 展示与排查。 */
  readonly parts: readonly { readonly key: string; readonly text: string; readonly source: string }[]
  /** 拼装期做的调整，例如"剔除了 N 句参考图描述""注入了无品牌主体"。 */
  readonly notes: readonly string[]
}

/** 片段顺序即提示词顺序：主体 → 场景 → 光影 → 构图 → 质感 → 文案。 */
const FRAGMENT_ORDER = ['subject', 'scene', 'lighting', 'composition', 'finish', 'copyStyle'] as const

/** 未提供取值时的中性填充。用英文以匹配片段语言。 */
const NEUTRAL_VAR_TEXT: Readonly<Record<string, string>> = {
  product: 'the product',
  brand: 'the brand',
  slogan: '',
  background: 'a clean complementary background',
  audience: 'the target customer',
}

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g

/** 句子只要提到 reference，就说明它假设了参考图的存在。 */
const REFERENCE_SENTENCE = /\breference\b/iu

/** F3：无产品描述时使用的中性主体，明确"虚构且无品牌"。 */
const UNBRANDED_SUBJECT =
  'A generic, unbranded product invented for this shot, matching the description below. ' +
  'It has no real-world counterpart: no existing brand identity, no trademarked packaging design, ' +
  'no recognisable logo, and no real company name anywhere in the image.'

/** F3：无产品描述时追加的品牌禁令。 */
const BRAND_NEGATIVE =
  "no real-world brand names, no trademarks, no third-party logos, no counterfeit packaging of an existing product"

/**
 * 把片段里的 `{name}` 替换为取值。
 * @param text - 原始片段。
 * @param vars - 取值表。
 */
export function substituteVars(
  text: string,
  vars: Readonly<Record<string, string>> = {},
): string {
  return text.replace(PLACEHOLDER, (_match, name: string) => {
    const provided = vars[name]
    if (typeof provided === 'string') return provided
    return NEUTRAL_VAR_TEXT[name] ?? ''
  })
}

/**
 * 按句剔除依赖参考图的描述（仅在无参考图时调用）。
 *
 * 按句而不是按词：句子是自洽的语义单位，删词会留下残句；删句最多丢一句描述。
 * @param text - 片段文本。
 */
export function stripReferenceSentences(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !REFERENCE_SENTENCE.test(sentence))
    .join(' ')
    .trim()
}

/** 取一个片段的最终文本：先看片段级覆盖，再看整模块覆盖。 */
function fragmentText(
  module: ModuleDef,
  key: string,
  overrides: PromptOverrides,
): { text: string; source: string } {
  const whole = overrides[module.id]
  if (typeof whole === 'string' && whole.trim() !== '') {
    // 整模块覆盖：以 `subject` 片段承载，其余片段不再参与。
    return key === 'subject'
      ? { text: whole.trim(), source: `override:${module.id}` }
      : { text: '', source: '' }
  }

  const perFragment = overrides[`${module.id}.${key}`]
  if (typeof perFragment === 'string' && perFragment.trim() !== '') {
    return { text: perFragment.trim(), source: `override:${module.id}.${key}` }
  }

  const base = (module.fragments as unknown as Record<string, string | undefined>)[key]
  return typeof base === 'string' && base.trim() !== ''
    ? { text: base.trim(), source: 'module' }
    : { text: '', source: '' }
}

/**
 * 拼装最终提示词。
 * @param input - 模块、变量、覆盖、补充指令与"是否有参考图"。
 */
export function buildPrompt(input: BuildPromptInput): BuiltPrompt {
  const { module } = input
  const vars = input.vars ?? {}
  const overrides = input.overrides ?? {}
  const hasReferences = input.hasReferences ?? false
  const notes: string[] = []

  const parts: { key: string; text: string; source: string }[] = []

  // 整模块覆盖 = 用户显式接管该模块：此时不再注入保护语、也不剔除句子。
  // 尊重"我说了算"，比"我们更懂"更重要——否则用户永远无法写出一条完全自定义的提示词。
  const wholeOverride = overrides[module.id]
  const userTookOver = typeof wholeOverride === 'string' && wholeOverride.trim() !== ''

  // F3：文生图且没有产品描述 → 先用一句话钉死"虚构无品牌"。
  const productGiven = typeof vars.product === 'string' && vars.product.trim() !== ''
  const needsUnbranded = !userTookOver && !hasReferences && !productGiven

  // 大多数模块的片段里**没有** `{product}` 占位符（它们按"有参考图"的场景写）。
  // 因此调用方给了产品描述时，必须显式补一行，否则用户的描述会被静默丢弃——
  // 文生图就会退化成"模型自己编一个产品"。
  const moduleUsesProduct = FRAGMENT_ORDER.some((key) => {
    const text = (module.fragments as unknown as Record<string, string | undefined>)[key]
    return typeof text === 'string' && text.includes('{product}')
  })
  const needsProductLine = !userTookOver && !hasReferences && productGiven && !moduleUsesProduct

  if (needsUnbranded) {
    parts.push({ key: 'subjectUnbranded', text: UNBRANDED_SUBJECT, source: 'guard' })
    notes.push('无产品描述：已注入"通用无品牌"主体，并追加品牌禁令（F3）')
  } else if (needsProductLine) {
    parts.push({
      key: 'subjectProduct',
      text: `The product to depict: ${String(vars.product).trim()}. Keep this description authoritative — do not substitute a different or existing product.`,
      source: 'guard',
    })
    notes.push('模块未引用 {product}：已把产品描述补为独立主体句')
  }

  let strippedSentences = 0
  for (const key of FRAGMENT_ORDER) {
    const { text, source } = fragmentText(module, key, overrides)
    if (text === '') continue

    const substituted = substituteVars(text, vars).trim()
    if (substituted === '') continue

    let final = substituted
    if (!hasReferences && !userTookOver) {
      const before = final
      final = stripReferenceSentences(final)
      if (final !== before) strippedSentences += 1
      if (final === '') continue
    }

    parts.push({ key, text: final, source })
  }

  if (strippedSentences > 0) {
    notes.push(`无参考图：剔除了 ${strippedSentences} 个片段中依赖参考图的句子（F2）`)
  }

  const userPrompt = input.userPrompt?.trim() ?? ''
  if (userPrompt !== '') {
    parts.push({ key: 'userPrompt', text: userPrompt, source: 'user' })
  }

  const negativeRaw = overrides[`${module.id}.negative`] ?? module.negativeHints ?? ''
  const negativeBase = negativeRaw.trim()
  const negative = needsUnbranded
    ? negativeBase === ''
      ? BRAND_NEGATIVE
      : `${negativeBase}, ${BRAND_NEGATIVE}`
    : negativeBase

  return {
    prompt: parts.map((part) => part.text).join('\n\n'),
    ...(negative === '' ? {} : { negative }),
    size: module.defaultSize,
    parts,
    notes,
  }
}
