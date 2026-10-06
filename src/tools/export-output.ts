/**
 * 产物**复制**助手：把已落盘的图复制一份到调用方指定的目标目录。
 *
 * 语义变更（历史）：本文件以前是「生成时自动另存到用户配置的 `outputDir`」的助手，
 * 那条路径已**取消**（用户配置的保存路径只在显式导出时生效）。现在的两个调用方是：
 *   1. **用户显式触发的作品库导出**（`POST /pixmart/api/projects/<id>/export`）；
 *   2. **自动副本到会话工作区** `<工作区>/pixmart-out/<projectId>/`
 *      （见 tools/workspace-copy.ts）——它存在的理由不是"帮用户留文件"，而是
 *      DSH 官方内嵌写法只渲染会话工作区内的路径。
 *
 * 两处的落点不同（用户配的导出路径 vs 会话工作区），但共用同一套复制语义与命名，
 * 因此互不干扰：`exportDir` 仍是"点导出时用"的那一个。
 *
 * 三条不变量（与自动另存时期一致，仍然成立）：
 *   1. **只复制**，绝不移动/删除原件——数据目录里的项目文件是作品库的数据源。
 *   2. **失败不上抛**：失败只收敛成一句可读 warning（路由把它回给界面），
 *      且不得破坏原项目。
 *   3. **文件名内容寻址**（`<sha8>-<原名>`）：不同内容绝不同名，同内容天然复用，
 *      因此重复导出、并发导出、跨项目都不会互相覆盖。
 */
import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface ExportSource {
  /** 数据目录里的绝对路径（原件）。 */
  readonly absolutePath: string
  /** 内容哈希；用于生成目标文件名。 */
  readonly sha256: string
}

export interface ExportOutcome {
  /** 目标目录里的完整路径（含"同内容副本已存在、直接复用"的情况）。 */
  readonly exported: readonly string[]
  /** 每条都是可读的失败说明；空数组表示全部成功。 */
  readonly warnings: readonly string[]
}

/**
 * 目标文件名：内容寻址前缀 + 原名。
 *
 * 原名本身常常已经是 `<sha8>-<slug>.<ext>`（见 ProjectStore.saveImage），
 * 那种情况下直接复用，避免出现 `ab12cd34-ab12cd34-x.png` 这样的双前缀。
 */
export function exportFileName(sha256: string, sourcePath: string): string {
  const prefix = sha256.slice(0, 8)
  const name = basename(sourcePath) || 'image'
  if (prefix === '') return name
  if (name.startsWith(`${prefix}-`) || name.startsWith(`${prefix}.`)) return name
  return `${prefix}-${name}`
}

/**
 * 把一组图复制到 `targetDir`。
 * @param targetDir - 目标目录（绝对路径）；空串表示不导出，直接返回空结果。
 * @param sources - 待复制的原件（绝对路径 + 内容哈希）。
 */
export function exportImages(
  targetDir: string,
  sources: readonly ExportSource[],
): ExportOutcome {
  const dir = targetDir.trim()
  if (dir === '' || sources.length === 0) return { exported: [], warnings: [] }

  const exported: string[] = []
  const warnings: string[] = []
  /** 建目录只试一次：失败原因对同一次调用里的每一张都一样，不必逐张重试。 */
  let dirProblem: string | undefined

  for (const source of sources) {
    const target = join(dir, exportFileName(source.sha256, source.absolutePath))
    if (dirProblem !== undefined) {
      warnings.push(`产物复制失败：${dirProblem}；原件仍在 ${source.absolutePath}`)
      continue
    }
    try {
      mkdirSync(dir, { recursive: true })
    } catch (error) {
      dirProblem = error instanceof Error ? error.message : String(error)
      warnings.push(`产物复制失败：${dirProblem}；原件仍在 ${source.absolutePath}`)
      continue
    }
    try {
      // 同内容同名字的副本已经在（目标目录恰好就是数据目录时也是这一支）→ 不再写。
      // 只有"存在但字节数不对"（半截副本）才重写一次，把坏副本修好。
      if (!isCompleteCopy(target, source.absolutePath)) {
        copyFileSync(source.absolutePath, target)
      }
      exported.push(target)
    } catch (error) {
      // 竞态：并发下另一个 worker 可能刚好把同内容副本放好——那算成功。
      if (isCompleteCopy(target, source.absolutePath)) {
        exported.push(target)
        continue
      }
      const reason = error instanceof Error ? error.message : String(error)
      warnings.push(`产物复制失败：${reason}；原件仍在 ${source.absolutePath}`)
    }
  }

  return { exported, warnings }
}

/** 目标已存在时，用**字节数一致**近似判断它是一份完整副本；任何取不到都算"不完整"。 */
function isCompleteCopy(target: string, source: string): boolean {
  try {
    return statSync(target).size === statSync(source).size
  } catch {
    return false
  }
}
