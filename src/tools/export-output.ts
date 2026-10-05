/**
 * 产物「另存」：把已落盘的图**复制**一份到用户配置的 `outputDir`。
 *
 * 三条不变量（对应实测反馈：用户跑测试时是**会话里的 agent 用 pwsh 手动**把产物
 * 拷进仓库目录的，那既不稳定也没必要）：
 *   1. **只复制**，绝不移动/删除原件——数据目录里的项目文件是作品库的数据源。
 *   2. **失败不上抛**：图已经在数据目录里了，少一份便利副本不该把一次成功的生图
 *      变成失败；失败只收敛成一句可读 warning。
 *   3. **文件名内容寻址**（`<sha8>-<原名>`）：不同内容绝不同名，同内容天然复用，
 *      因此重复生成、并发批量、跨项目都不会互相覆盖。
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
 * 把一组图复制到 `outputDir`。
 * @param outputDir - 目标目录（绝对路径）；空串表示不导出，直接返回空结果。
 * @param sources - 待复制的原件（绝对路径 + 内容哈希）。
 */
export function exportImages(
  outputDir: string,
  sources: readonly ExportSource[],
): ExportOutcome {
  const dir = outputDir.trim()
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
      // 同内容同名字的副本已经在（`outputDir` 恰好就是数据目录时也是这一支）→ 不再写。
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
