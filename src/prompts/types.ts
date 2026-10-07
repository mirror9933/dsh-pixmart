/**
 * 提示词模块的契约。
 *
 * 设计目标（见技术方案 §7.5）：把「电商生图要什么」沉淀成**数据**而不是代码分支。
 * 每个模块 = 一组片段；`buildPrompt()` 是纯函数，负责拼装 —— 因此拼装可单测、
 * 可重放，模块文本可被用户覆盖。
 *
 * 文本全部为本仓库原创，按「模块 → 片段」组织。
 */

/** 模块分组。 */
export type ModuleGroup = 'main' | 'detail' | 'ad' | 'tool'

/**
 * 一个模块的提示词片段。
 *
 * 全部为英文提示词 —— 目标模型（Gemini / gpt-image 系）对英文指令的遵循度更稳，
 * 而模块的 `label` 用中文供界面展示。
 */
export interface ModuleFragments {
  /** 主体呈现：产品本身怎么被刻画。 */
  readonly subject: string
  /** 场景与背景。 */
  readonly scene: string
  /** 光影与氛围。 */
  readonly lighting: string
  /** 构图与镜头。 */
  readonly composition: string
  /** 材质质感与输出质量（可选）。 */
  readonly finish?: string
  /** 广告类文案的视觉规范（可选）。 */
  readonly copyStyle?: string
}

/** 一个生成模块。 */
export interface ModuleDef {
  /** 稳定标识，如 `main.white-bg`。同时是 `buildPrompt` 的入参与覆盖键。 */
  readonly id: string
  readonly group: ModuleGroup
  /** 界面展示名（中文）。 */
  readonly label: string
  /**
   * 默认尺寸。
   * - Gemini 图像系用**比例**：`1:1` / `3:4` / `4:3` / `9:16` / `16:9`
   * - OpenAI 兼容端点用**像素**：`1024x1024` 等
   * 适配器会按 apiMode 归一化，因此这里写哪种都可以（见技术方案 §7.4）。
   */
  readonly defaultSize: string
  /** 必须带参考图才有意义（如风格复刻、细节特写）。 */
  readonly requiresReference?: boolean
  readonly fragments: ModuleFragments
  /** 负向提示：明确不要出现的东西。 */
  readonly negativeHints?: string
  /**
   * 本模块片段中可被 `vars` 替换的占位符名（不含花括号）。
   * 未提供对应 `vars` 时该占位符被替换为中性描述，而不是留下 `{xxx}` 字面量。
   */
  readonly variables?: readonly string[]
}
