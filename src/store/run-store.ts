/**
 * 运行注册表（技术方案 §8.5.3）—— 实时预览的 host 半边。
 *
 * 「实时」的本质不是轮询有多快，而是**每张图字节落盘后立刻更新运行记录**：
 * 文件先于工具返回就存在，客户端据此逐格点亮。轮询只是取数的通道。
 *
 * 三条硬语义：
 *   1. **进程重启后不假装还在跑**：boot 时把 `running` 改判为 `interrupted`。
 *   2. **取消保留已落盘的图**：撤销只中止在途请求，不回收已完成的产出。
 *   3. **有界保留**：只留最近 N 条，避免 runs 目录无限增长。
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile, writeFileAtomic } from './atomic.js'
import { createKeyedMutex, type KeyedMutex } from './mutex.js'
import { assertContained } from './paths.js'

export type RunStatus =
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'awaiting-confirm'

export type RunItemStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped'

export interface RunItem {
  index: number
  module: string
  label: string
  status: RunItemStatus
  file?: string
  width?: number
  height?: number
  error?: { code: string; message: string }
  ms?: number
}

export interface RunState {
  readonly version: 1
  readonly runId: string
  readonly tool: 'generate' | 'edit' | 'batch'
  readonly provider: string
  readonly model: string
  readonly apiMode: string
  readonly size: string
  readonly status: RunStatus
  readonly total: number
  readonly completed: number
  readonly failed: number
  readonly currentLabel?: string
  readonly startedAt: number
  readonly updatedAt: number
  readonly finishedAt?: number
  readonly projectId?: string
  readonly projectName?: string
  readonly items: readonly RunItem[]
}

export interface RunSummary {
  readonly runId: string
  readonly tool: string
  readonly status: RunStatus
  readonly total: number
  readonly completed: number
  readonly failed: number
  readonly projectName?: string
  readonly provider: string
  readonly model: string
  readonly startedAt: number
  readonly finishedAt?: number
}

/** 只保留最近这么多条运行记录。 */
export const MAX_KEPT_RUNS = 20

export interface CreateRunInput {
  readonly tool: RunState['tool']
  readonly provider: string
  readonly model: string
  readonly apiMode: string
  readonly size: string
  readonly total: number
  readonly projectId?: string
  readonly projectName?: string
  readonly items: readonly { module: string; label: string }[]
}

function newRunId(now: number): string {
  const suffix = Math.random().toString(36).slice(2, 6)
  return `run-${now}-${suffix}`
}

export class RunStore {
  readonly dir: string
  private readonly mutex: KeyedMutex
  private readonly controllers = new Map<string, AbortController>()

  constructor(dataDir: string) {
    this.dir = assertContained(dataDir, join(dataDir, 'runs'))
    this.mutex = createKeyedMutex()
  }

  private file(runId: string): string {
    return assertContained(this.dir, join(this.dir, `${runId}.json`))
  }

  /** 新建一次运行，并登记它的取消控制器。 */
  async create(input: CreateRunInput): Promise<RunState> {
    const now = Date.now()
    const runId = newRunId(now)
    const state: RunState = {
      version: 1,
      runId,
      tool: input.tool,
      provider: input.provider,
      model: input.model,
      apiMode: input.apiMode,
      size: input.size,
      status: 'running',
      total: input.total,
      completed: 0,
      failed: 0,
      startedAt: now,
      updatedAt: now,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.projectName === undefined ? {} : { projectName: input.projectName }),
      items: input.items.map((item, index) => ({
        index,
        module: item.module,
        label: item.label,
        status: 'queued' as RunItemStatus,
      })),
    }

    this.controllers.set(runId, new AbortController())
    await this.write(state)
    return state
  }

  /** 该运行的取消信号（交给厂商请求）。 */
  signalFor(runId: string): AbortController['signal'] | undefined {
    return this.controllers.get(runId)?.signal
  }

  /** 读取运行记录；不存在或损坏则抛错。 */
  read(runId: string): RunState {
    const result = readJsonFile<RunState>(this.file(runId))
    if (!result.ok) {
      throw new Error(
        result.reason === 'missing' ? `运行不存在：${runId}` : `运行记录无法解析：${runId}`,
      )
    }
    return result.value
  }

  /** 原子地改写运行记录。 */
  async patch(runId: string, mutate: (current: RunState) => RunState): Promise<RunState> {
    return this.mutex.run(runId, async () => {
      const next = mutate(this.read(runId))
      await this.write({ ...next, updatedAt: Date.now() })
      return next
    })
  }

  /** 标记某一条产出的结果。 */
  async setItem(runId: string, index: number, patch: Partial<RunItem>): Promise<void> {
    await this.patch(runId, (current) => {
      const items = current.items.map((item, i) => (i === index ? { ...item, ...patch } : item))
      return {
        ...current,
        items,
        currentLabel: patch.status === 'running' ? items[index]?.label : current.currentLabel,
      }
    })
  }

  /** 结束一次运行，并汇总计数。 */
  async finish(runId: string, status: RunStatus): Promise<RunState> {
    const finished = await this.patch(runId, (current) => ({
      ...current,
      status,
      finishedAt: Date.now(),
      completed: current.items.filter((item) => item.status === 'done').length,
      failed: current.items.filter((item) => item.status === 'failed').length,
    }))
    this.controllers.delete(runId)
    return finished
  }

  /**
   * 取消一次运行：中止在途请求，**已落盘的产出保留**。
   * @returns 是否确实取消了一个仍在跑的运行。
   */
  cancel(runId: string): boolean {
    const controller = this.controllers.get(runId)
    if (controller === undefined) return false
    controller.abort('cancelled by user')
    return true
  }

  /** 最近的运行摘要（按开始时间倒序）。 */
  list(limit = 10): readonly RunSummary[] {
    if (!existsSync(this.dir)) return []

    const runs: RunSummary[] = []
    for (const entry of readdirSync(this.dir)) {
      if (!entry.endsWith('.json')) continue
      const result = readJsonFile<RunState>(join(this.dir, entry))
      if (!result.ok) continue
      const state = result.value
      runs.push({
        runId: state.runId,
        tool: state.tool,
        status: state.status,
        total: state.total,
        completed: state.completed,
        failed: state.failed,
        ...(state.projectName === undefined ? {} : { projectName: state.projectName }),
        provider: state.provider,
        model: state.model,
        startedAt: state.startedAt,
        ...(state.finishedAt === undefined ? {} : { finishedAt: state.finishedAt }),
      })
    }

    return runs.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
  }

  /**
   * 进程启动时调用：把上次遗留的 `running` 记录改判为 `interrupted`。
   * @returns 被改判的 runId 列表。
   */
  async markInterruptedOnBoot(): Promise<readonly string[]> {
    if (!existsSync(this.dir)) return []

    const touched: string[] = []
    for (const entry of readdirSync(this.dir)) {
      if (!entry.endsWith('.json')) continue
      const result = readJsonFile<RunState>(join(this.dir, entry))
      if (!result.ok) continue
      if (result.value.status !== 'running') continue

      const runId = result.value.runId
      await this.patch(runId, (current) => ({
        ...current,
        status: 'interrupted',
        finishedAt: Date.now(),
      }))
      touched.push(runId)
    }
    return touched
  }

  /**
   * 清理超出保留量的旧记录。
   * @returns 删除条数。
   */
  async prune(keep = MAX_KEPT_RUNS): Promise<number> {
    if (!existsSync(this.dir)) return 0

    const files = readdirSync(this.dir)
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => {
        const path = join(this.dir, entry)
        let mtime = 0
        try {
          mtime = statSync(path).mtimeMs
        } catch {
          // 读不到时间戳就当作最旧
        }
        return { path, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)

    let removed = 0
    for (const file of files.slice(keep)) {
      try {
        unlinkSync(file.path)
        removed += 1
      } catch {
        // 删不掉就留着，不影响功能
      }
    }
    return removed
  }

  /** 确保目录存在（懒创建，避免无运行时在磁盘上留空目录）。 */
  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true })
  }

  private async write(state: RunState): Promise<void> {
    this.ensureDir()
    writeFileAtomic(this.file(state.runId), `${JSON.stringify(state, null, 2)}\n`)
  }
}
