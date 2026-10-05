/**
 * 数据目录解析与路径安全。
 *
 * 数据目录优先级（P0 在真实 desktop 宿主上实测后确定，见 contract-notes §1.5）：
 *   1. 插件配置里的显式 `dataDir`
 *   2. 环境变量 `DSH_HOME`
 *   3. `<用户主目录>/.dsh`
 *
 * 第 3 级不是保险丝而是**必需**：由桌面 GUI 启动的宿主进程不设置 `DSH_HOME`，
 * 少了这一级就会退化成 `process.cwd()/pixmart`——而 cwd 是 profile 目录，
 * 属于「用 cwd 散落用户数据」的明确反模式。
 */
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'

/** `process.platform` 的替代：路径分隔符即可判定（避免再多一个运行时面）。 */
const CASE_INSENSITIVE_FS = sep === '\\'

export interface DataDirResolution {
  /** 绝对路径；不保证已存在（写入时按需创建）。 */
  readonly dataDir: string
  /** 降级说明；非空表示走了回落而不是用户显式配置。 */
  readonly degraded: readonly string[]
}

/** 去掉结尾的分隔符，保留根（如 `C:\`）。 */
function stripTrailingSeparators(value: string): string {
  let end = value.length
  while (end > 1 && (value[end - 1] === '\\' || value[end - 1] === '/')) end -= 1
  return value.slice(0, end)
}

/**
 * 解析插件数据目录。
 * @param configured - 插件配置中的 `dataDir`；空串/空白视为未配置。
 */
export function resolveDataDir(configured?: string): DataDirResolution {
  const degraded: string[] = []

  const explicit = typeof configured === 'string' ? configured.trim() : ''
  if (explicit !== '') return { dataDir: resolve(explicit), degraded }

  const fromEnv = process.env.DSH_HOME?.trim()
  if (fromEnv !== undefined && fromEnv !== '') {
    return { dataDir: resolve(stripTrailingSeparators(fromEnv), 'pixmart'), degraded }
  }

  degraded.push('DSH_HOME 未设置（GUI 启动的宿主即如此），按约定回落到 <用户主目录>/.dsh')
  try {
    const userHome = homedir()
    if (userHome !== '') {
      return {
        dataDir: resolve(stripTrailingSeparators(userHome), '.dsh', 'pixmart'),
        degraded,
      }
    }
  } catch {
    // 落到最后一级
  }

  degraded.push('DSH_HOME 与用户主目录都取不到，数据目录退化为进程工作目录下的 pixmart（临时）')
  return { dataDir: resolve(process.cwd(), 'pixmart'), degraded }
}

/** 归一化用于包含判断：绝对化 + Windows 下大小写不敏感。 */
function normalizeForCompare(value: string): string {
  const absolute = resolve(value)
  return CASE_INSENSITIVE_FS ? absolute.toLowerCase() : absolute
}

/**
 * `candidate` 是否位于 `parent` 之内（含相等）。
 * 用于挡住路径穿越：所有由外部输入拼出的路径都要先过这一关。
 */
export function isContained(parent: string, candidate: string): boolean {
  const base = normalizeForCompare(parent)
  const target = normalizeForCompare(candidate)
  if (target === base) return true
  const prefix = base.endsWith(sep) ? base : base + sep
  return target.startsWith(prefix)
}

/**
 * 校验并返回绝对路径；越界即抛。
 * @throws Error 当 `candidate` 落在 `parent` 之外。
 */
export function assertContained(parent: string, candidate: string): string {
  const absolute = resolve(candidate)
  if (!isContained(parent, absolute)) {
    throw new Error(`路径越界：${absolute} 不在 ${resolve(parent)} 之内`)
  }
  return absolute
}
