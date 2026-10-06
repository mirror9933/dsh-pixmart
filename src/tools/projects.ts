/**
 * `pixmart_projects` —— 项目库与用量审计的统一入口。
 *
 * 设计原则：**破坏性操作必须显式确认**。`delete` 要求 `confirm: true`，
 * 且只操作自己 projects 目录下解析得到的路径（经 `assertContained` 校验）。
 *
 * 设计原则之二（2026-10-06 收敛）：**Agent 没有任何写文件的落点**。
 * 本工具只会写插件数据目录（软删 = 移进回收站）；它**不再**有 `export` action——
 * 导出是"用户刻意挑选、要长期留存"的动作，只留在用户点界面的那条 HTTP 路径上
 * （`POST /pixmart/api/projects/<id>/export`，写用户配置的「作品库导出路径」）。
 * Agent 需要"给用户文件"时，用 `action=get` 报出的**会话暂存副本目录**
 * （工作区内的 `pixmart-out/<项目 id>`，生成时自动留下的那一份）——
 * 那是**已经存在**的副本，不需要新写任何东西。
 *
 * `delete` 的语义与 HTTP 路径（`POST /pixmart/api/projects/<id>/delete`）**一致**：
 * 默认是**软删**（`moveToTrash` → `projects/.trash/<id>`，可恢复），
 * 只有显式 `permanent: true` 才是真删。为什么 Agent 这条路也必须能恢复：
 * 用户一句"把那些测试项目删掉"是最容易触发删除的入口，若这里只能硬删，
 * 模型一旦理解错，磁盘上的字节就永久没了——而 UI 那条路是能救回来的。
 * 因此补齐对称的 `restore` action：Agent 删错了可以自己救回来，不必让用户去界面点
 * （作品库优化方案 §4 决定①、§6.1；contract-notes §16.4、§16.6）。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { historicalTotals } from '../store/historical.js'
import type { ToolContentBlock, ToolDefinitionLike, ToolRunContext } from '../host-types.js'
import { workspaceStagingDir } from './workspace-copy.js'
import { failure, fromException, type ToolRuntime } from './runtime.js'

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
      '访问已生成的项目与用量记录：list / get / delete / restore / usage。',
      '调用时机：想知道"以前生成过什么""用了多少次""某个项目的图在哪""删错了要恢复"。',
      'get：给出项目详情；**能取到会话工作区时**还会给出该项目在会话工作区内的暂存副本目录',
      '（`<工作区>/pixmart-out/<项目 id>`，附 exists 标志）——图片原件始终在插件数据目录（作品库可浏览），',
      '要用某个路径内嵌图片，就用这个已经存在的副本目录。',
      '本工具不把图片复制到用户的设置目录或任何其它落点：Agent 侧没有这个能力，只碰插件数据目录（软删 / 恢复）。',
      'delete 默认是**软删**：项目被移入回收站（可恢复、磁盘上的字节一个都没丢），仍需显式传 confirm: true。',
      '只有再传 permanent: true 才是**永久删除、不可恢复**——用户没明确说要永久删就用默认的软删。',
      'delete 之后可以用 restore（ids = 被删的 id，或 list 里报出的回收站条目 id）恢复。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'delete', 'restore', 'usage'],
          description: '要执行的操作。',
        },
        id: { type: 'string', description: '项目 id（get 用）。' },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            '项目 id 列表（delete 用）；restore 也用它，元素可以是回收站条目 id 或原项目 id。',
        },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'list / usage 的条数上限。' },
        confirm: { type: 'boolean', description: 'delete 必须为 true 才执行（软删与永久删都要求）。' },
        permanent: {
          type: 'boolean',
          description:
            'delete 用：默认 false = 软删（移入回收站，可用 restore 恢复）；true = 永久删除，不可恢复。',
        },
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
    async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
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
            // 账本自 P2 起才有；此前的产出自项目记录汇总，分开报（见 store/historical.ts）。
            historical: historicalTotals(runtime.projectStore.list()),
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
          // 回收站**单独报**（`trashCount` / `trash`），绝不混进 `projects`：
          // 混进去会让 Agent 把已删除的项目当成还在的项目，进而对不存在的 id 调用 get。
          const trash = runtime.projectStore.listTrash()
          return {
            ok: true,
            action,
            count: projects.length,
            projects,
            trashCount: trash.length,
            trash: trash.map((entry) => ({
              // id 是**回收站条目 id**（restore 直接吃它）；projectId 是记录里的原 id。
              id: entry.id,
              projectId: entry.projectId,
              name: entry.name,
              deletedAt: entry.deletedAt,
              imageCount: entry.imageCount,
            })),
          }
        }

        if (action === 'get') {
          const id = pickString(args, 'id')
          if (id === undefined) return failure('invalid_args', 'get 需要 id')
          const record = runtime.projectStore.read(id)
          // 会话暂存目录：Agent 侧唯一的"文件在哪"来源（本工具不导出、不复制）。
          // 拿不到工作区时 `staging` 是 undefined → 字段**缺省**，绝不编造路径。
          const staging = workspaceStagingDir(exec, record.id)
          return {
            ok: true,
            action,
            dataDir: runtime.dataDir,
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
            ...(staging === undefined ? {} : { workspaceOut: staging }),
          }
        }

        if (action === 'delete') {
          // 先判确认再碰磁盘：缺 confirm 时不得有任何副作用（软删与永久删同一口径）。
          const permanent = pickBool(args, 'permanent')
          if (!pickBool(args, 'confirm')) {
            return failure(
              'confirm_required',
              permanent
                ? 'delete permanent: true 会永久删除、不可恢复，需要 confirm: true'
                : 'delete 会把项目移入回收站（可恢复），需要 confirm: true',
              permanent
                ? '如果只是想清理列表，去掉 permanent 用默认的软删；真要永久删再带 confirm: true'
                : '先用 action=get 确认要删的项目，再带 confirm: true 调用；误删可用 action=restore 恢复',
            )
          }
          const ids = pickStringArray(args, 'ids')
          if (ids.length === 0) return failure('invalid_args', 'delete 需要 ids')

          const deleted: string[] = []
          const skipped: { id: string; reason: string }[] = []
          // 软删成功时把「原 id → 回收站条目 id」一并报出来，方便紧接着 restore。
          const trashed: { id: string; trashId: string }[] = []
          for (const id of ids) {
            try {
              if (!runtime.projectStore.has(id)) {
                skipped.push({ id, reason: '项目不存在' })
                continue
              }
              if (permanent) {
                // 路径已由 has() 内部的 assertContained 校验过（越界 id 在上一步就抛了），
                // 这里只按 id 删。**唯一**的真删路径。
                rmSync(join(runtime.projectStore.projectsRoot, id), { recursive: true, force: true })
              } else {
                // 软删：与 HTTP 路径同一个 store 方法（同名语义、同一套失败不变量）。
                // moveToTrash 失败时原目录仍在原位（见 moveDir 的三条不变量）。
                const outcome = await runtime.projectStore.moveToTrash(id)
                trashed.push({ id: outcome.id, trashId: outcome.trashId })
              }
              deleted.push(id)
            } catch (error) {
              skipped.push({ id, reason: error instanceof Error ? error.message : String(error) })
            }
          }
          return {
            ok: true,
            action,
            deleted,
            skipped,
            permanent,
            ...(permanent ? {} : { trashed }),
          }
        }

        if (action === 'restore') {
          const ids = pickStringArray(args, 'ids')
          if (ids.length === 0) {
            return failure('invalid_args', 'restore 需要 ids（回收站条目 id 或原项目 id）')
          }
          // 恢复是**非破坏性**的（冲突时 store 会拒绝而不是覆盖），所以不要求 confirm。
          const trash = runtime.projectStore.listTrash()
          const restored: string[] = []
          const skipped: { id: string; reason: string }[] = []
          for (const id of ids) {
            // 两种写法都收：回收站条目 id（list 报出的）与原项目 id（Agent 手上通常只有它）。
            const entry =
              trash.find((item) => item.id === id) ?? trash.find((item) => item.projectId === id)
            if (entry === undefined) {
              skipped.push({ id, reason: '回收站里没有这个项目（可能已被恢复或永久删除）' })
              continue
            }
            try {
              const outcome = await runtime.projectStore.restoreFromTrash(entry.id)
              restored.push(outcome.id)
            } catch (error) {
              skipped.push({ id, reason: error instanceof Error ? error.message : String(error) })
            }
          }
          return { ok: true, action, restored, skipped }
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
      `用量（账本，自 P2 起）：${String(summary.requests)} 次厂商请求，成功 ${String(summary.ok)}，失败 ${String(summary.failed)}，产出 ${String(summary.images)} 张`,
    )
    const byModel = (summary.byModel ?? {}) as Record<string, number>
    for (const [key, count] of Object.entries(byModel)) lines.push(`  ${key}: ${count} 次`)
    // 历史产出另列：否则"账本 0"会和用户可见的项目并对不上。
    const historical = (value.historical ?? {}) as Record<string, unknown>
    if (Number(historical.images) > 0) {
      lines.push(
        `历史产出（账本之前）：${String(historical.images)} 张 / ${String(historical.projects)} 个项目 —— ${String(historical.note ?? '')}`,
      )
    }
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
    // 回收站的存在必须被说出来（否则"列表里没有"会被读成"从来没生成过"），
    // 但它**不在**上面的项目列表里——分开列，且直接给出 restore 要用的 id。
    const trash = Array.isArray(value.trash) ? value.trash : []
    if (trash.length > 0) {
      lines.push(`回收站另有 ${String(value.trashCount ?? trash.length)} 个项目（不在上面的列表里）：`)
      for (const entry of trash) {
        const record = entry as Record<string, unknown>
        lines.push(`- ${String(record.id)}（原名 ${String(record.name)}）`)
      }
      lines.push('用 action=restore + ids 可以把它们恢复到项目列表里')
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }

  if (action === 'get') {
    return [{ type: 'text', text: renderProjectDetail(value) }]
  }

  if (action === 'delete') {
    const deleted = Array.isArray(value.deleted) ? value.deleted : []
    const skipped = Array.isArray(value.skipped) ? value.skipped : []
    const ids = deleted.map((entry) => String(entry)).join('、')
    if (deleted.length === 0) {
      lines.push('没有项目被删除')
    } else if (value.permanent === true) {
      lines.push(`已永久删除 ${deleted.length} 个项目：${ids}（不可恢复）`)
    } else {
      lines.push(
        `已移入回收站 ${deleted.length} 个项目：${ids}（可用 pixmart_projects action=restore 恢复；permanent: true 才是永久删除）`,
      )
    }
    for (const entry of skipped) {
      const record = entry as Record<string, unknown>
      lines.push(`跳过 ${String(record.id)}：${String(record.reason)}`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }

  if (action === 'restore') {
    const restored = Array.isArray(value.restored) ? value.restored : []
    const skipped = Array.isArray(value.skipped) ? value.skipped : []
    if (restored.length === 0) {
      lines.push('没有项目被恢复')
    } else {
      lines.push(`已从回收站恢复 ${restored.length} 个项目：${restored.map((entry) => String(entry)).join('、')}`)
    }
    for (const entry of skipped) {
      const record = entry as Record<string, unknown>
      lines.push(`跳过 ${String(record.id)}：${String(record.reason)}`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }

  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * `action=get` 的渲染文本。
 *
 * 三件事必须说清楚，否则 Agent 只有一串路径可猜：
 *   1. **原件**在插件数据目录（作品库浏览的就是它，本工具不复制不移动）；
 *   2. **会话暂存副本**在工作区内的 `pixmart-out/<项目 id>`——这是唯一能被客户端
 *      渲染成可预览会话地址的路径，可直接内嵌 / `present`；顺带报"在不在"，
 *      免得它去 present 一个还不存在的目录；
 *   3. 本工具**不会**导出到用户的设置目录（Agent 侧没有写文件的落点）。
 *
 * 拿不到工作区时字段缺省，文本也必须**说出来**（"没有可给出的路径"），
 * 而不是让模型把缺失读成"路径是空的"。
 */
function renderProjectDetail(value: Record<string, unknown>): string {
  const project = (value.project ?? {}) as Record<string, unknown>
  const items = Array.isArray(project.items) ? project.items : []
  const projectId = String(project.id ?? '')
  const lines: string[] = []

  let images = 0
  for (const entry of items) {
    const item = entry as Record<string, unknown>
    const count = Array.isArray(item.images) ? item.images.length : 0
    images += count
    lines.push(
      `- ${String(item.module)} ${String(item.label)}：${count} 张（${String(item.status)}，${String(item.size)}）`,
    )
  }
  lines.unshift(`项目 ${projectId}（${String(project.name)}）：${items.length} 项 / ${images} 张图`)

  // ① 原件：数据目录是唯一真相。
  const dataDir = typeof value.dataDir === 'string' ? value.dataDir : ''
  lines.push(
    dataDir === ''
      ? '原件在插件数据目录（作品库可浏览）——本工具只读，不复制也不移动它们。'
      : `原件在插件数据目录：${join(dataDir, 'projects', projectId, 'images')}（作品库可浏览）——本工具只读，不复制也不移动它们。`,
  )

  // ② 会话暂存副本：Agent 能拿到手的路径就是它。
  const staging = value.workspaceOut
  if (typeof staging === 'object' && staging !== null) {
    const dir = String((staging as Record<string, unknown>).dir ?? '')
    const exists = (staging as Record<string, unknown>).exists === true
    lines.push(
      `会话暂存副本：${dir}（当前${exists ? '已存在，可直接用这个路径内嵌图片或 present' : '还不存在——本会话尚未生成过这个项目的图；生成时会自动留一份到这里'}）`,
    )
    lines.push('（工作区内的路径才会被客户端渲染成可预览的会话地址）')
  } else {
    lines.push('会话暂存副本：本次调用拿不到会话工作区，因此没有可给出的工作区路径（这不是错误）。')
  }

  // ③ 边界：本工具不写用户的目录。
  lines.push('本工具不会把图片导出到设置里的「作品库导出路径」，也不会往任何其它落点写文件。')
  return lines.join('\n')
}
