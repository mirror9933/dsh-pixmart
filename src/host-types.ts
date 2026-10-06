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

/**
 * 会话 header 的结构子集。
 *
 * `cwd` 是**该会话的工作区根**（绝对路径）。它同时决定：
 *   - `read` / `write` / `edit` / `pwsh` 这类工具解析相对路径的基准（官方
 *     `@deepseek-ai/dsh-tool-fs` 的 `sessionCwd()` 读的就是这个字段）；
 *   - 客户端消息渲染把哪些路径当作**会话内地址**（可内嵌预览）——
 *     工作区之外的绝对路径保留绝对地址，因而 `![说明](<路径>)` 渲染不出来。
 */
export interface AgentSessionHeaderLike {
  readonly cwd?: string
}

/** 会话的结构子集（只声明本插件用到的 `header`）。 */
export interface AgentSessionLike {
  readonly header?: AgentSessionHeaderLike
}

/**
 * 工具执行上下文（宿主 ToolRunContext 的结构子集）。
 *
 * `agent` 在真实宿主里是**整个 Agent 对象**（`dsh-agent-loop` 的
 * `executeToolCalls` 把 `agent` 原样塞进执行输入），因此除 `id` 外还能读到
 * `session.header.cwd`。官方 `dsh-tool-present` 正是用 `exec.agent.session`
 * 定位交付物所属会话。
 */
export interface ToolRunContext {
  readonly callId: string
  readonly signal: AbortSignalLike
  readonly agent?: {
    readonly id: string
    readonly session?: AgentSessionLike
  }
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

/** 宿主 HTTP 请求/响应的结构子集（只声明我们用到的面）。 */
export interface HttpRequestLike {
  readonly method?: string
  readonly url?: string
  readonly socket?: { readonly remoteAddress?: string }
  /**
   * 读请求体的事件面（Node `IncomingMessage`）。
   *
   * 设置页可写之后，`POST /pixmart/api/...` 要解析 JSON body，因此必须能订阅
   * `data` / `end`；`error` 用于连接中断时把读体 promise reject 掉，
   * 否则它会永远挂着。这里只声明这三个事件，保持"最小面"的既有风格。
   */
  on(event: 'data' | 'end' | 'error', listener: (chunk?: unknown) => void): unknown
}

export interface HttpResponseLike {
  writeHead(status: number, headers?: Record<string, string>): void
  end(data?: string | Uint8Array): void
}

/**
 * `ctx.webServer` 的结构子集。
 *
 * 包式 client 半的 `factory(require)` 只收到 `require`（拿不到 `host.call`），
 * 因此 client ↔ host 的唯一通道就是这里注册的 HTTP 路由（contract-notes §3.2）。
 */
export interface WebServerLike {
  register(route: {
    readonly kind: 'exact' | 'prefix'
    readonly path: string
    readonly handler: (request: HttpRequestLike, response: HttpResponseLike) => void | Promise<void>
  }): () => void
}

/** `ctx.systemPrompt.section()` 的入参（宿主 PromptSection 的结构子集）。 */
export interface PromptSectionLike {
  readonly name: string
  readonly order: number
  readonly text: string
}

/**
 * `ctx.systemPrompt` 的结构子集。
 *
 * 用来把插件的使用说明送进系统提示，让模型知道**该在什么时候**用这些工具——
 * 否则它只能靠工具描述自己推断，而且计费约束全靠自觉。
 */
export interface SystemPromptLike {
  section(section: PromptSectionLike): () => void
}
