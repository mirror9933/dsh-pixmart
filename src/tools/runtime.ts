/**
 * 工具层的共享运行时。
 *
 * 关键点：**服务只能在 `execute()` 时探测**（P0 实测，见 contract-notes §1.3）——
 * `attachments` / `fs` 在 `apply()` 时刻可能还没就绪。因此运行时只持有 ctx 与
 * store，服务一律在调用点用 `ctx.get()` 取。
 *
 * 配置同样是**惰性加载**：`apply()` 是同步的，而读盘是异步的。
 */
import { ConfigStore } from '../store/config-store.js'
import { ProjectStore } from '../store/project-store.js'
import { RunStore } from '../store/run-store.js'
import { UsageLog } from '../log/usage.js'
import { resolveDataDir } from '../store/paths.js'
import type { PixmartConfig } from '../config.js'
import type {
  AttachmentsLike,
  DshPixmartConfig,
  FsServiceLike,
  HostContext,
  ToolContentBlock,
  ToolDefinitionLike,
} from '../host-types.js'

export interface ToolRuntime {
  readonly ctx: HostContext
  readonly dataDir: string
  /** 数据目录的降级说明（`DSH_HOME` 未设置等）。 */
  readonly dataDirNotes: readonly string[]
  readonly configStore: ConfigStore
  readonly projectStore: ProjectStore
  /** 运行注册表：实时预览的 host 半边（§8.5.3）。 */
  readonly runStore: RunStore
  /** 用量审计：每次厂商请求一行，硬计数。 */
  readonly usage: UsageLog
  /** 惰性加载配置；并发调用共享同一次读盘。 */
  config(): Promise<PixmartConfig>
  /** 首次加载产生的 warning（含配置损坏隔离）。 */
  configWarnings(): readonly string[]
}

/** 参考图单张的字节上限：防止把巨型文件塞进请求体。 */
export const MAX_REFERENCE_BYTES = 20 * 1024 * 1024

export function createRuntime(ctx: HostContext, config: DshPixmartConfig): ToolRuntime {
  const resolved = resolveDataDir(config.dataDir)
  const configStore = new ConfigStore(resolved.dataDir)
  const projectStore = new ProjectStore(resolved.dataDir)
  const runStore = new RunStore(resolved.dataDir)
  const usage = new UsageLog(resolved.dataDir)

  // 上一次进程留下的 running 记录改判为 interrupted：**绝不假装还在跑**（§8.5.3）。
  void runStore.markInterruptedOnBoot().catch(() => undefined)

  /**
   * 首次读盘只做一次（并发调用共享同一次 I/O）。
   *
   * 它**不缓存配置内容**——这一点是实测缺陷的修复：早先这里把首次读盘的结果
   * 当作 `config()` 的永久返回值，于是写路由（`ConfigStore.update()`）虽然更新了
   * store 的内存副本与 config.json，之后的 `GET api/providers` 仍然回首次读盘的
   * 快照。用户看到的就是"提示已拉取 150 个模型，可模型那一行还是旧的 3 个默认值"。
   */
  let loaded: Promise<void> | undefined
  let warnings: readonly string[] = []

  return {
    ctx,
    dataDir: resolved.dataDir,
    dataDirNotes: resolved.degraded,
    configStore,
    projectStore,
    runStore,
    usage,
    config(): Promise<PixmartConfig> {
      if (loaded === undefined) {
        loaded = configStore.load().then((result) => {
          warnings = result.warnings
        })
      }
      // 读盘之后一律取 store 的**当前**配置：写路由只经 `ConfigStore.update()`
      // 改内存副本，这里若回首次读盘的结果就永远看不到写后的值。
      return loaded.then(() => configStore.get())
    },
    configWarnings(): readonly string[] {
      return warnings
    },
  }
}

/** 文本内容块。 */
export function textBlock(text: string): ToolContentBlock {
  return { type: 'text', text }
}

/** 把图片附件引用渲染成图片内容块（形状由 P0 取证）。 */
export function imageBlocks(
  refs: readonly { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string }[],
): ToolContentBlock[] {
  return refs.map((ref) => ({
    type: 'image',
    attachment: {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
    },
  }))
}

/** 组合文本与图片块：文本在前，图片随后。 */
export function renderWithImages(text: string, refs: unknown): ToolContentBlock[] {
  if (!Array.isArray(refs) || refs.length === 0) return [textBlock(text)]
  const valid = refs.filter(
    (ref): ref is { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string } =>
      typeof ref === 'object' && ref !== null && typeof (ref as { attachmentId?: unknown }).attachmentId === 'string',
  )
  return [textBlock(text), ...imageBlocks(valid)]
}

/** 取可选服务（在 execute 时调用）。 */
export function getAttachments(ctx: HostContext): AttachmentsLike | undefined {
  const value = ctx.get('attachments')
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<AttachmentsLike>
  return typeof candidate.saveImages === 'function' ? (candidate as AttachmentsLike) : undefined
}

export function getFs(ctx: HostContext): FsServiceLike | undefined {
  const value = ctx.get('fs')
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<FsServiceLike>
  if (
    typeof candidate.resolve === 'function' &&
    typeof candidate.processPath === 'function' &&
    typeof candidate.readBytes === 'function'
  ) {
    return candidate as FsServiceLike
  }
  return undefined
}

/** 统一的失败返回形状。 */
export interface ToolFailure {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string; readonly hint?: string }
}

export function failure(code: string, message: string, hint?: string): ToolFailure {
  return { ok: false, error: { code, message, ...(hint === undefined ? {} : { hint }) } }
}

/**
 * 余额不足时的提示文案。
 *
 * 它是**给模型看的指令**，不是给用户看的散文——所以要短、要可执行、要堵住退路。
 * 三层意思缺一不可：
 *   1. 这是账户状态问题，重试无用（去充值）；
 *   2. **先 `ask_user_question` 问用户**，不要自作主张选一条路；
 *   3. **严禁**用脚本/绘图库自己合成"交付物"——那是伪造，不是生成。
 *
 * 第 3 条来自一起实测事件（contract-notes §18）：厂商回 402 余额为负之后，
 * Agent 未经询问就写了 PIL 脚本把图拼出来当成品交付。插件**无法**拦截宿主的
 * `pwsh` / `write`，也没有强制弹窗的能力，所以这里只能把工具返回写成指令级文案，
 * 并在 guidance 里立硬规则——这是能力边界，不是已完成的技术拦截。
 */
export const INSUFFICIENT_CREDITS_HINT =
  '账户余额不足，重试无用——请用户去厂商后台充值。' +
  '必须先调用 ask_user_question 询问用户：停下来去充值，还是按用户指示改用别的方式；不要自行降级。' +
  '严禁用脚本或绘图库（PIL / ImageMagick / canvas 等）自行合成或伪造图片充当交付物。'

/**
 * 把厂商错误映射成给模型的提示。
 * @param error - 厂商错误的 `code` / `retryable` 两个字段（其余不参与判断）。
 */
export function vendorFailureHint(error: {
  readonly code: string
  readonly retryable: boolean
}): string {
  if (error.code === 'insufficient_credits') return INSUFFICIENT_CREDITS_HINT
  return error.retryable ? '该错误可重试；可直接再次调用本工具' : '该错误重试无意义，请先修正配置或提示词'
}

/** 把未知异常收敛成失败返回，不让它冒泡成未处理异常。 */
export function fromException(error: unknown, code = 'internal'): ToolFailure {
  return failure(code, error instanceof Error ? error.message : String(error))
}

/** 供所有工具复用的描述尾注：统一副作用与失败语义。 */
export const TOOL_FOOTER =
  '副作用：写入插件数据目录（`$DSH_HOME/pixmart`）。失败语义：返回结构化 error，不抛异常。'

export type { ToolDefinitionLike }
