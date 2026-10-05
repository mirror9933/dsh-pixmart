/**
 * `pixmart_projects` —— 项目库与用量审计的统一入口。
 *
 * 设计原则：**破坏性操作必须显式确认**。`delete` 要求 `confirm: true`，
 * 且只删自己 projects 目录下解析得到的路径（经 `assertContained` 校验）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolContentBlock, ToolDefinitionLike } from '../host-types.js'
import { TOOL_FOOTER, failure, fromException, type ToolRuntime } from './runtime.js'

function pickString(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function pickBool(source: unknown, key: string): boolean {
  return typeof source === 'object' && source !== null && (source as Record<string, unknown>)[key] === true
}

function pickStringArray(source: unknown, key: string): string[] {
  if (typeof source !== 'object' || source === null) return []
  const value = (source as Record<string, unknown>)[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
}

export function createProjectsTool(runtime: ToolRuntime): ToolDefinitionLike {
  return {
    name: 'pixmart_projects',
    description: [
      '访问已生成的项目与用量记录：list / get / export / delete / usage。',
      '调用时机：想知道"以前生成过什么""用了多少次""把某个项目的图导出来"。',
      'delete 是破坏性操作，必须显式传 confirm: true。',
      '副作剧：export 会写文件到数据目录的 exports/ 下；delete 会删除项目目录。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'export', 'delete', 'usage'],
          description: '要执行的操作。',
        },
        id: { type: 'string', description: '项目 id（get / export 用）。' },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: '项目 id 列表（delete 用）。',
        },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'list / usage 的条数上限。' },
        confirm: { type: 'boolean', description: 'delete 必须为 true 才执行。' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      },
      render: (_args, value) => renderProjects(value),
    },
    isConcurrencySafe: () => true,
    async execute(args: unknown): Promise<unknown> {
      try {
        const action = pickString(args, 'action') ?? 'list'
        const limit = Math.min(Math.max(Number(pickNumberOr(args, 'limit', 20)), 1), 200)

        if (action === 'usage') {
          const summary = runtime.usage.summary()
          const records = runtime.usage.read(limit)
          return {
            ok: true,
            action,
            dataDir: runtime.dataDir,
            usageFile: runtime.usage.file,
            summary,
            recent: records.map((record) => ({
              ts: record.ts,
              provider: record.provider,
              model: record.model,
              ok: record.ok,
              images: record.images,
              ms: record.ms,
              ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
            })),
          }
        }

        if (action === 'list') {
          const projects = runtime.projectStore.list().slice(0, limit)
          return { ok: true, action, count: projects.length, projects }
        }

        if (action === 'get') {
          const id = pickString(args, 'id')
          if (id === undefined) return failure('invalid_args', 'get 需要 id')
          const record = runtime.projectStore.read(id)
          return {
            ok: true,
            action,
            project: {
              id: record.id,
              name: record.name,
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
              provider: record.provider,
              model: record.model,
              items: record.items.map((item) => ({
                module: item.module,
                label: item.label,
                status: item.status,
                size: item.size,
                apiMode: item.apiMode,
                images: item.images.map((image) => image.file),
                ...(item.degraded === undefined || item.degraded.length === 0
                  ? {}
                  : { degraded: item.degraded }),
                ...(item.error === undefined ? {} : { error: item.error }),
              })),
            },
          }
        }

        if (action === 'export') {
          const id = pickString(args, 'id')
          if (id === undefined) return failure('invalid_args', 'export 需要 id')
          const record = runtime.projectStore.read(id)
          const imagesDir = runtime.projectStore.imagesDir(id)
          const targetDir = join(runtime.dataDir, 'exports', id)
          mkdirSync(targetDir, { recursive: true })

          const copied: string[] = []
          for (const item of record.items) {
            for (const image of item.images) {
              const name = image.file.split('/').pop() ?? ''
              if (name === '') continue
              const from = join(imagesDir, name)
              if (!existsSync(from)) continue
              const to = join(targetDir, name)
              writeFileSync(to, readFileSync(from))
              copied.push(to)
            }
          }
          return { ok: true, action, id, count: copied.length, exportDir: targetDir, files: copied }
        }

        if (action === 'delete') {
          if (!pickBool(args, 'confirm')) {
            return failure(
              'confirm_required',
              'delete 是破坏性操作，需要 confirm: true',
              '先用 action=get 确认要删的项目，再带 confirm: true 调用',
            )
          }
          const ids = pickStringArray(args, 'ids')
          if (ids.length === 0) return failure('invalid_args', 'delete 需要 ids')

          const deleted: string[] = []
          const skipped: { id: string; reason: string }[] = []
          for (const id of ids) {
            try {
              if (!runtime.projectStore.has(id)) {
                skipped.push({ id, reason: '项目不存在' })
                continue
              }
              // 路径已由 ProjectStore 内部的 assertContained 校验，这里只按 id 删除。
              rmSync(join(runtime.projectStore.projectsRoot, id), { recursive: true, force: true })
              deleted.push(id)
            } catch (error) {
              skipped.push({ id, reason: error instanceof Error ? error.message : String(error) })
            }
          }
          return { ok: true, action, deleted, skipped }
        }

        return failure('invalid_args', `未知 action "${action}"`)
      } catch (error) {
        return fromException(error, 'projects')
      }
    },
  }
}

function pickNumberOr(source: unknown, key: string, fallback: number): number {
  if (typeof source !== 'object' || source === null) return fallback
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function renderProjects(value: Record<string, unknown>): ToolContentBlock[] {
  const lines: string[] = []
  const action = String(value.action ?? '')

  if (value.ok !== true) {
    const error = (value.error ?? {}) as Record<string, unknown>
    return [{ type: 'text', text: `失败 [${String(error.code)}]：${String(error.message)}` }]
  }

  if (action === 'usage') {
    const summary = (value.summary ?? {}) as Record<string, unknown>
    lines.push(
      `用量（累计）：${String(summary.requests)} 次厂商请求，成功 ${String(summary.ok)}，失败 ${String(summary.failed)}，产出 ${String(summary.images)} 张`,
    )
    const byModel = (summary.byModel ?? {}) as Record<string, number>
    for (const [key, count] of Object.entries(byModel)) lines.push(`  ${key}: ${count} 次`)
    lines.push(`明细文件：${String(value.usageFile)}`)
    return [{ type: 'text', text: lines.join('\n') }]
  }

  if (action === 'list') {
    const projects = Array.isArray(value.projects) ? value.projects : []
    lines.push(`项目 ${String(value.count)} 个：`)
    for (const entry of projects) {
      const record = entry as Record<string, unknown>
      lines.push(
        `- ${String(record.id)}（${String(record.imageCount)} 张，${String(record.provider)}/${String(record.model)}）`,
      )
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }

  if (action === 'export') {
    lines.push(`已导出 ${String(value.count)} 个文件到 ${String(value.exportDir)}`)
    return [{ type: 'text', text: lines.join('\n') }]
  }

  if (action === 'delete') {
    const deleted = Array.isArray(value.deleted) ? value.deleted : []
    const skipped = Array.isArray(value.skipped) ? value.skipped : []
    lines.push(`已删除 ${deleted.length} 个项目`)
    for (const entry of skipped) {
      const record = entry as Record<string, unknown>
      lines.push(`跳过 ${String(record.id)}：${String(record.reason)}`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }

  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

void TOOL_FOOTER
