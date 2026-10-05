/**
 * 用量审计：`<dataDir>/usage.jsonl`，每次厂商请求追加一行。
 *
 * 为什么是**硬计数**而不是估算：用户的后台账单和插件里的账必须能对上。
 * 之前一次性诊断失控花了 25 次调用（可避免 16 次），根因之一就是调用方
 * 没有一个地方能立刻看到"已经发了多少次"。这个文件就是那个地方。
 *
 * 追加式写入：崩溃只会撕掉最后一行，读取时跳过不完整行即可，不做全量重写。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertContained } from '../store/paths.js'

export interface UsageRecord {
  readonly ts: number
  readonly provider: string
  readonly model: string
  readonly apiMode: string
  readonly size: string
  /** 请求张数。 */
  readonly n: number
  /** 实际落盘张数。 */
  readonly images: number
  readonly ok: boolean
  readonly ms: number
  readonly runId?: string
  readonly projectId?: string
  readonly degraded?: readonly string[]
  readonly errorCode?: string
}

export interface UsageSummary {
  /** 厂商请求总次数（= 计费次数的上界，按请求而非按张）。 */
  readonly requests: number
  readonly ok: number
  readonly failed: number
  /** 实际产出图片总数。 */
  readonly images: number
  /** 按 `provider/model` 聚合的请求数。 */
  readonly byModel: Readonly<Record<string, number>>
}

export class UsageLog {
  readonly file: string

  constructor(dataDir: string) {
    this.file = assertContained(dataDir, join(dataDir, 'usage.jsonl'))
  }

  /**
   * 追加一条记录。**永不抛错**——审计失败不该让一次成功的生图失败。
   * @param record - 一次厂商请求的结果。
   */
  append(record: UsageRecord): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8')
    } catch {
      // 审计是旁路，不是主链路
    }
  }

  /**
   * 读取记录（新→旧）。半截行与损坏行一律跳过。
   * @param limit - 最多返回多少条。
   */
  read(limit = 200): readonly UsageRecord[] {
    if (!existsSync(this.file)) return []

    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return []
    }

    const records: UsageRecord[] = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const parsed = JSON.parse(trimmed) as UsageRecord
        if (typeof parsed?.ts === 'number') records.push(parsed)
      } catch {
        // 撕裂的尾行或损坏行：跳过
      }
    }

    return records.reverse().slice(0, limit)
  }

  /** 汇总：请求数、成功/失败、产出张数、按模型分布。 */
  summary(limit = 10_000): UsageSummary {
    const records = this.read(limit)
    const byModel: Record<string, number> = {}
    let ok = 0
    let images = 0

    for (const record of records) {
      if (record.ok) ok += 1
      images += typeof record.images === 'number' ? record.images : 0
      const key = `${record.provider}/${record.model}`
      byModel[key] = (byModel[key] ?? 0) + 1
    }

    return {
      requests: records.length,
      ok,
      failed: records.length - ok,
      images,
      byModel,
    }
  }
}
