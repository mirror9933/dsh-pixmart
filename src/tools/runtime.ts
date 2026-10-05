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

/** 把未知异常收敛成失败返回，不让它冒泡成未处理异常。 */
export function fromException(error: unknown, code = 'internal'): ToolFailure {
  return failure(code, error instanceof Error ? error.message : String(error))
}

/** 供所有工具复用的描述尾注：统一副作用与失败语义。 */
export const TOOL_FOOTER =
  '副作用：写入插件数据目录（`$DSH_HOME/pixmart`）。失败语义：返回结构化 error，不抛异常。'

export type { ToolDefinitionLike }
