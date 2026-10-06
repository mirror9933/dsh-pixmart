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
 *
 * 本文件还是**导出目标与落点布局的唯一实现**：HTTP 路由
 * （`POST /pixmart/api/projects/<id>/export`）与 `pixmart_projects action=export`
 * 都调 `resolveExportRoot` + `planProjectExport`。两个入口曾经各写一遍——
 * 结果就是同一句"导出"落到两个不同的地方（配置里的 `exportDir` vs 数据目录下的
 * 隐式 `exports/`），用户根本分不清"导出到底去哪"。现在只保留用户显式配置的那一个：
 * **没有可用目标就失败**，不再有任何插件自作的落点。
 */
import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { assertContained } from '../store/paths.js'

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

// ─────────────────────────────────── 导出目标与落点（HTTP 与工具共用的唯一实现）

/**
 * 「一个可用的导出目录都没有」的**唯一文案**。
 *
 * HTTP 路由（`400 no_export_dir`）与 `pixmart_projects action=export` 共用这一条字符串：
 * 两个入口说的是同一件事，就没有理由让用户读到两种说法。**必须指向设置页**——
 * 失败而不告诉人去哪儿配，等于把人卡在原地。
 */
export const NO_EXPORT_DIR_MESSAGE =
  '没有可用的导出目录：请先在设置里配置作品库导出路径（设置 → PixMart → 作品库导出路径），或显式指定目标目录（绝对路径）'

/** 导出目标解析结果：失败时带 HTTP 同款错误码，两个入口据此回 400 / 结构化失败。 */
export type ExportRootResolution =
  | { readonly ok: true; readonly root: string }
  | {
      readonly ok: false
      readonly code: 'no_export_dir' | 'invalid_export_dir'
      readonly message: string
    }

/**
 * 解析导出目标根：**入参 `dir`（显式覆盖）> 配置里的 `exportDir` > 失败**。
 *
 * 没有第三条分支：插件**不再**自作主张给一个默认落点（曾经是 `<dataDir>/exports/`，
 * 结果是"导出"有两个去处，用户看到的文件和他配的路径对不上）。
 *
 * 相对路径一律拒绝：它的落点取决于宿主进程的工作目录（GUI 启动时那还是 profile 目录），
 * 用户无法预期，宁可失败也不静默接受。
 *
 * @param overrideDir - 调用方显式给的目标目录（空串/`undefined` = 没给）。
 * @param configuredExportDir - 配置里的「作品库导出路径」（空串 = 未配置）。
 */
export function resolveExportRoot(
  overrideDir: string | undefined,
  configuredExportDir: string,
): ExportRootResolution {
  if (overrideDir !== undefined && overrideDir !== '') {
    if (!isAbsolute(overrideDir)) {
      return {
        ok: false,
        code: 'invalid_export_dir',
        message: `导出目录必须是绝对路径："${overrideDir}"`,
      }
    }
    return { ok: true, root: resolve(overrideDir) }
  }

  const configured = configuredExportDir.trim()
  if (configured === '') {
    return { ok: false, code: 'no_export_dir', message: NO_EXPORT_DIR_MESSAGE }
  }
  if (!isAbsolute(configured)) {
    return {
      ok: false,
      code: 'invalid_export_dir',
      message: `配置里的作品库导出路径不是绝对路径："${configured}"`,
    }
  }
  return { ok: true, root: resolve(configured) }
}

/** 项目记录里的一张图：只用得上"记录里的相对路径"与内容哈希。 */
export interface ExportImageRef {
  readonly file: string
  readonly sha256: string
}

/** 项目记录里的一项（一项可含多张图）。 */
export interface ExportItemRef {
  readonly images: readonly ExportImageRef[]
}

/** 导出计划：落点 + 待复制的原件。 */
export type ProjectExportPlan =
  | { readonly ok: true; readonly target: string; readonly sources: readonly ExportSource[] }
  | { readonly ok: false; readonly code: 'bad_export_dir'; readonly message: string }

/**
 * 规划一次项目导出：落点固定是 **`<目标根>/<projectId>/`**（不同项目各占一格，
 * 重复导出不会互相覆盖），源码与落点**两条路径都过 `assertContained`**——
 * 文件名来自 `project.json`，不能假设它一定干净。
 *
 * 记录里越界的那一张**只跳过它自己**，不让整个导出失败（与复制失败收敛成
 * `warnings` 的口径一致）。项目 id 越界（被喂了 `..`）则是整个计划失败。
 */
export function planProjectExport(
  root: string,
  projectId: string,
  imagesDir: string,
  items: readonly ExportItemRef[],
): ProjectExportPlan {
  let target: string
  try {
    target = assertContained(root, join(root, projectId))
  } catch {
    return { ok: false, code: 'bad_export_dir', message: `导出落点越界：${join(root, projectId)}` }
  }

  const sources: ExportSource[] = []
  for (const item of items) {
    for (const image of item.images) {
      const name = lastSegment(image.file)
      if (name === '') continue
      try {
        const absolutePath = assertContained(imagesDir, join(imagesDir, name))
        assertContained(target, join(target, exportFileName(image.sha256, name)))
        sources.push({ absolutePath, sha256: image.sha256 })
      } catch {
        // 记录被手改脏 → 跳过这一张（`assertContained` 在这里就是边界闸门）。
      }
    }
  }

  return { ok: true, target, sources }
}

/** `images/<name>` → `<name>`；只用最后一段，天然挡掉记录里被写脏的路径。 */
function lastSegment(file: string): string {
  const parts = file.split(/[\\/]/).filter((part) => part !== '')
  return parts.length === 0 ? '' : (parts[parts.length - 1] as string)
}
