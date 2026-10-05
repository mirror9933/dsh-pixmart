/**
 * 结构化契约类型：宿主注入真实 Cordis Context，本文件只声明 dsh-pixmart 实际
 * 用到的那一面。
 *
 * 为什么不用 `@deepseek-ai/dsh-tools` 的类型：该包的依赖图里有未发布到 npm 的
 * 包（`@deepseek-ai/dsh-type-meta` 404），第三方插件无法把它装成依赖。而
 * `defineTool` 经取证只是「把 value-schema DSL 编译成原始 JSON Schema + 包一层
 * 参数校验」的薄包装，其产物就是一个普通对象。因此本插件手写等价的
 * ToolDefinition，运行时零 `@deepseek-ai` import。
 */

/** 工具返回给模型的内容块。图片块的 `attachment` 形状见 contract-notes S3。 */
export interface ToolContentBlock {
  readonly type: string
  readonly [key: string]: unknown
}

/** `output.render` 收到的规范化结果（本插件自产生，故按自定形状读取）。 */
export interface ToolOutputValue {
  readonly [key: string]: unknown
}

/**
 * 取消信号的最小面。用自有接口而不是 `AbortSignal`：本插件的 tsconfig 不带
 * DOM / @types/node，保持零类型依赖。
 */
export interface AbortSignalLike {
  readonly aborted: boolean
  addEventListener(type: 'abort', listener: () => void): void
}

/** 工具执行上下文（宿主 ToolRunContext 的结构子集）。 */
export interface ToolRunContext {
  readonly callId: string
  readonly signal: AbortSignalLike
  readonly agent?: { readonly id: string }
  deferContext(context: unknown): void
  concludeTurn(): void
}

/** 注册进 `ctx.tools` 的工具定义（宿主 ToolDefinition 的结构子集）。 */
export interface ToolDefinitionLike {
  name: string
  description: string
  /** 原始 JSON Schema（`{ type: 'object', properties, required? }`）。 */
  parameters: Record<string, unknown>
  output: {
    /** 原始 JSON Schema；宿主会用 assertSupportedJsonSchema 校验。 */
    schema: Record<string, unknown>
    render(args: unknown, value: ToolOutputValue): ToolContentBlock[]
    presentationMeta?(args: unknown, value: ToolOutputValue): unknown
  }
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  isConcurrencySafe?(args: unknown): boolean
  timeoutMs?: number
}

/** 工具 schema 的投影形状（即模型看到的那一面）。 */
export interface ProjectedToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** `ctx.tools` 服务。 */
export interface ToolRegistryService {
  register(definition: ToolDefinitionLike): () => void
  /** 投影可见工具的模型面 schema。P0 自检用它把「注册成功」证成「schema 正确投影」。 */
  schemas?(scope?: unknown): ProjectedToolSchema[]
}

/**
 * 本插件 `apply()` 收到的宿主 Context 的结构子集。
 *
 * `inject = ['tools']` 保证 `tools` 一定存在；其余服务一律通过 `get()` 探测，
 * 缺失时降级而不是让整个插件激活失败。
 */
export interface HostContext {
  readonly tools: ToolRegistryService
  get(name: string): unknown
  effect(
    callback: () => (() => void) | void | Promise<void>,
    label?: string,
  ): void
  on(event: string, listener: (...args: unknown[]) => void): () => void
}

/** cordis.yml 里本行 `config:` 的形状。 */
export interface DshPixmartConfig {
  /** 插件数据目录。留空 = `$DSH_HOME/pixmart`。 */
  readonly dataDir?: string
}

/** `ctx.attachments.saveImages` 返回的持久图片引用（见 contract-notes §2）。 */
export interface ImageAttachmentRefLike {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

/** `ctx.attachments` 的结构子集。 */
export interface AttachmentsLike {
  saveImages(
    inputs: readonly { readonly data: Uint8Array; readonly mediaType: string; readonly name?: string }[],
  ): Promise<readonly ImageAttachmentRefLike[]>
}

/** `ctx.fs` 的结构子集。 */
export interface FsTargetLike {
  readonly [key: string]: unknown
}

export interface FsServiceLike {
  resolve(path: string, opts?: { readonly cwd?: string; readonly signal?: unknown }): Promise<FsTargetLike>
  processPath(target: FsTargetLike): string
  readBytes(target: FsTargetLike, signal: unknown, maxBytes: number): Promise<Uint8Array>
}
