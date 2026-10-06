/**
 * 自动副本：把每张成功落盘的图复制一份到**会话工作区**内的 `pixmart-out/`。
 *
 * ## 为什么必须落在工作区里
 *
 * DSH 官方内嵌写法 `![说明](<路径>)` 只渲染**会话工作区之内**的路径：客户端把这种
 * 路径转成 `session` 作用域的 `dsh-resource://` 地址（见 `dsh-client-ui-chat` 的
 * `fileAddressFor`），而工作区之外的绝对路径保留绝对地址，界面上就是「图片无法预览」。
 * 插件产物落在数据目录（`$DSH_HOME/pixmart`，见 store/paths.ts），那在工作区之外——
 * 所以要靠这份副本进工作区，官方写法才会自然生效。
 *
 * ## 会话工作区怎么拿到（取证，不是猜的）
 *
 * `exec.agent.session.header.cwd`：
 *   - 官方 `@deepseek-ai/dsh-tool-fs` 的 `sessionCwd(exec)` 逐字读这个字段，并写明
 *     「每个会话的 read/write/edit 作用在自己的工作区，而不是服务进程的启动目录」；
 *   - 官方 `dsh-tool-present` 用它校验交付物，取不到时直接报
 *     `present requires a workspace`——说明**没有工作区是正常状态**，不是异常；
 *   - `dsh-agent-loop` 的 `executeToolCalls` 把**整个 Agent 对象**放进执行输入
 *     （`{ callId, name, arguments, agent, signal }`），registry 的 `createExecution`
 *     再把它原样透传给工具，所以 `agent.session.header` 在 execute 时可读；
 *   - 本机会话存档（`.dsh/sessions/` 下的 `session.v4.jsonl.zstd`）的 header 就是
 *     `{"id":"session-…","cwd":"E:\\Programs\\agent\\dsh-pixmart",…}`。
 *
 * 明确**不用** `process.cwd()` 之类近似值：GUI 启动的宿主进程 cwd 是 profile 目录，
 * 拿它当工作区会把文件写到用户完全预期不到的地方。
 *
 * ## 三条不变量
 *
 *   1. **只复制**，绝不移动/删除原件——数据目录是唯一真相（`ProjectStore` 与只读
 *      路由都依赖它）。
 *   2. **复制失败不能让生图失败**：图已经生成、已经付费。任何失败（含本函数内部的
 *      意外异常）都只收敛成一句可读 warning，工具仍返回 `ok: true`。
 *   3. 副本的**完整路径**回给工具结果文本，Agent 才有稳定路径可内嵌 / `present`。
 *
 * 除复制之外，本文件还对外提供**只读**的 `workspaceStagingDir()`：`pixmart_projects`
 * 的 `get` 用它回答"这个项目的会话暂存副本在哪、在不在"。Agent 侧没有任何写文件的
 * 落点（导出能力只在用户点界面的那条 HTTP 路径上），所以这条只读探测就是它拿路径的
 * 唯一来源。
 */
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { assertContained } from '../store/paths.js'
import { exportImages, type ExportSource } from './export-output.js'
import type { ToolRunContext } from '../host-types.js'

/** 工作区内承载副本的目录名（固定在会话工作区根，便于整目录忽略 / 清理）。 */
export const WORKSPACE_OUT_DIR = 'pixmart-out'

export interface WorkspaceCopyOutcome {
  /** 会话工作区根（绝对路径）。 */
  readonly workspace: string
  /** 本次副本的落点 `<工作区>/pixmart-out/<projectId>`；无法拼出时是空串。 */
  readonly dir: string
  /** 目标目录里的完整路径（含"同内容副本已存在、直接复用"的那些）。 */
  readonly files: readonly string[]
  /** 每条都是可读的失败说明（含原因与**原件路径**）；空数组表示全部成功。 */
  readonly warnings: readonly string[]
}

/**
 * 本次调用的会话工作区，取不到时 `undefined`。
 *
 * 三重把关，任一不满足都当作「没有工作区」而不是硬凑一个：
 *   1. 字段必须存在（非 agent 直接调用 `ctx.tools.execute()` 时就没有）；
 *   2. 必须是非空字符串；
 *   3. 必须是**绝对路径**——相对值的落点取决于宿主进程 cwd，不可预期，宁可放弃复制。
 */
export function sessionWorkspace(exec: ToolRunContext): string | undefined {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd !== 'string') return undefined
  const trimmed = cwd.trim()
  if (trimmed === '') return undefined
  return isAbsolute(trimmed) ? trimmed : undefined
}

/**
 * 某个项目在会话工作区里的**暂存目录**（`pixmart-out/<projectId>`）的只读探测结果。
 *
 * 它回答两个问题：**在哪**（`workspace` / `dir`）与**在不在**（`exists`）。
 * 之所以还要 `exists`：Agent 据此决定"能不能拿这个路径去 `present`"——
 * 目录不存在时内嵌一个不存在的路径只会渲染成坏图，不如先去生图。
 */
export interface WorkspaceStaging {
  /** 会话工作区根（绝对路径）。 */
  readonly workspace: string
  /** `<工作区>/pixmart-out/<projectId>`（绝对路径）。 */
  readonly dir: string
  /** 该目录此刻是否已存在（有副本）。 */
  readonly exists: boolean
}

/**
 * 探测 `<工作区>/pixmart-out/<projectId>`：**只看不写**，绝不创建目录。
 *
 * 拿不到工作区（无 agent 上下文 / cwd 是相对路径）或项目 id 拼出越界路径时返回
 * `undefined`——调用方据此让字段**缺省**，而不是编一个假路径出来。
 *
 * 这是 Agent 侧"知道文件在哪"的**唯一**来源：导出能力已从工具层移除（Agent 不再有
 * 任何写文件的落点），要内嵌 / `present` 图片就用这里给出的、**已经存在**的会话暂存副本。
 */
export function workspaceStagingDir(
  exec: ToolRunContext,
  projectId: string,
): WorkspaceStaging | undefined {
  try {
    const workspace = sessionWorkspace(exec)
    if (workspace === undefined) return undefined
    const dir = assertContained(workspace, join(workspace, WORKSPACE_OUT_DIR, projectId))
    return { workspace, dir, exists: existsSync(dir) }
  } catch {
    // 越界 id 等异常一律当作"没有可给出的暂存目录"，不抛、也不编路径。
    return undefined
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 失败说明里必须点明原件还在——否则读到警告的人会以为图丢了。 */
function originalNote(sources: readonly ExportSource[]): string {
  return `原件仍在 ${sources.map((source) => source.absolutePath).join('、')}`
}

/**
 * 把一组已落盘的图复制到 `<工作区>/pixmart-out/<projectId>/`。
 *
 * **绝不抛异常**：拿不到工作区或没有图时返回 `undefined`（调用方据此决定结果里
 * 不出这个字段）；复制失败时返回带 `warnings` 的结果。
 *
 * 整个函数体都在同一个 `try` 里——包括"读工作区"和"拼落点"。这不是形式主义：
 * 本函数的调用点位于**付费生图之后**，任何逃逸的异常都会让工具报失败，而图其实
 * 已经生成好了。第二道不变量就是"复制失败不能让生图失败"，所以宁可多包一层。
 *
 * @param exec - 工具执行上下文（工作区从 `exec.agent.session.header.cwd` 读）。
 * @param projectId - 项目 id（按项目分子目录 = 归纳产物）。
 * @param sources - 待复制的原件（数据目录里的绝对路径 + 内容哈希）。
 */
export function copyImagesToWorkspace(
  exec: ToolRunContext,
  projectId: string,
  sources: readonly ExportSource[],
): WorkspaceCopyOutcome | undefined {
  let workspace: string | undefined
  let dir = ''
  try {
    workspace = sessionWorkspace(exec)
    if (workspace === undefined || sources.length === 0) return undefined

    // 项目 id 正常时只是一次拼接；万一上游写脏，这里会抛 → 下面的 catch 收敛成警告，
    // 绝不把副本写到工作区之外。
    dir = assertContained(workspace, join(workspace, WORKSPACE_OUT_DIR, projectId))

    const outcome = exportImages(dir, sources)
    return { workspace, dir, files: outcome.exported, warnings: outcome.warnings }
  } catch (error) {
    // 拿不到工作区 = "本来就没有副本"，不是失败（也不该在结果里冒出警告）。
    if (workspace === undefined) return undefined
    // exportImages 已把可预期失败（建目录、复制）收敛成 warning；这里兜的是意外异常。
    // 图已生成且已付费，副本出任何问题都只能降级成一句话。
    return {
      workspace,
      dir,
      files: [],
      warnings: [`产物复制失败：${reasonOf(error)}；${originalNote(sources)}`],
    }
  }
}

/**
 * 把副本结果拼成给模型看的行；没有副本时返回空数组。
 *
 * 入参按 `unknown` 收：工具结果的 `render` 拿到的是规范化后的普通对象
 * （`Record<string, unknown>`），所以在这里一次性做窄化，避免两个工具各写一遍。
 *
 * 只陈述**事实**（副本落在会话工作区内的完整路径、以及失败原因），不写任何
 * "该怎么展示"的规则——官方约定已经足够，规则该由系统提示决定（见 guidance.ts）。
 * 末尾那句"该目录是会话暂存、可能混有 Agent 自造产物"同样是**事实披露**（用户明确
 * 要求告知"这里可能不只有插件的自动副本"），不是展示规则。
 */
export function workspaceCopyLines(outcome: unknown): string[] {
  if (typeof outcome !== 'object' || outcome === null) return []
  const record = outcome as Record<string, unknown>
  const files = Array.isArray(record.files)
    ? record.files.filter((file): file is string => typeof file === 'string')
    : []
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.filter((warning): warning is string => typeof warning === 'string')
    : []

  const lines: string[] = []
  if (files.length > 0) {
    // 这一行只是**陈述环境事实**（官方内嵌写法只渲染工作区内的路径），
    // 用来把"数据目录原件"与"工作区副本"两串路径区分开；它不规定该怎么展示，
    // 也没有把任何规则塞进系统提示。
    lines.push('副本（在会话工作区内；官方 `![说明](<路径>)` 只渲染工作区内的路径）：')
    for (const file of files) lines.push(`- ${file}`)
    // 这个目录**不是插件独占**的：Agent 自己加工的产物也可能落在这里（用户已接受，
    // 但要求必须明确告知）。同样是陈述事实，不是展示规则。
    lines.push(
      `⚠ \`${WORKSPACE_OUT_DIR}/\` 是会话暂存目录，可能同时含有 Agent 自己加工的产物；`,
    )
    lines.push('插件不会清理它，可随时整体删除（生成的原件始终在插件数据目录，不受影响）。')
  }
  for (const warning of warnings) lines.push(`⚠ ${warning}`)
  return lines
}
