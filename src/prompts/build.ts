/**
 * 提示词拼装 —— **纯函数**，同入参必得同输出（技术方案 §7.5）。
 *
 * 因此它可以单测、可以重放，也让「先看后花钱」的 `pixmart_prompt` 有意义：
 * 用户/Agent 看到的就是真正会发出去的文本。
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
}

export interface BuiltPrompt {
  readonly prompt: string
  readonly negative?: string
  readonly size: string
  /** 实际参与拼装的片段，便于 dry run 展示与排查。 */
  readonly parts: readonly { readonly key: string; readonly text: string; readonly source: string }[]
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
 * @param input - 模块、变量、覆盖与补充指令。
 */
export function buildPrompt(input: BuildPromptInput): BuiltPrompt {
  const { module } = input
  const vars = input.vars ?? {}
  const overrides = input.overrides ?? {}

  const parts: { key: string; text: string; source: string }[] = []
  for (const key of FRAGMENT_ORDER) {
    const { text, source } = fragmentText(module, key, overrides)
    if (text === '') continue
    const substituted = substituteVars(text, vars).trim()
    if (substituted === '') continue
    parts.push({ key, text: substituted, source })
  }

  const userPrompt = input.userPrompt?.trim() ?? ''
  if (userPrompt !== '') {
    parts.push({ key: 'userPrompt', text: userPrompt, source: 'user' })
  }

  const negativeRaw = overrides[`${module.id}.negative`] ?? module.negativeHints ?? ''
  const negative = negativeRaw.trim()

  return {
    prompt: parts.map((part) => part.text).join('\n\n'),
    ...(negative === '' ? {} : { negative }),
    size: module.defaultSize,
    parts,
  }
}
