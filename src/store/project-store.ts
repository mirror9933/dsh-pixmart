/**
 * 项目库：`<dataDir>/projects/<projectId>/`。
 *
 * 三个刻意的设计选择：
 *   1. **不维护单独的索引文件** —— 列表由扫描目录得出。方案 §7.8 原本有
 *      `index.json`，但"扫描即可重建"是它的超集：没有需要修复的索引，
 *      A6（索引损坏后仍能恢复）变成结构性成立而不是靠恢复逻辑。
 *   2. **文件名内容寻址** `<sha8>-<slug>.<ext>` —— 同内容同哈希天然去重，
 *      也让只读路由可以安全地长缓存。
 *   3. **软删用目录改名而不是删除** —— 删除 = 把 `projects/<id>` 移进
 *      `projects/.trash/<id>`（跨设备时才回退成复制 + 删）。项目目录是唯一真相，
 *      工具与文件路由都依赖它，误删后没有回收站就找不回来（作品库优化方案 §4 决定①）。
 *      `.trash` 是 `projects/` 下的**隐藏目录**：`list()` 显式跳过一切以点开头的条目，
 *      所以它既不会被当成项目，也不会被详情/文件路由读到。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { imageInfo } from '../image-info.js'
import { readJsonFile, writeFileAtomic } from './atomic.js'
import { createKeyedMutex, type KeyedMutex } from './mutex.js'
import { assertContained } from './paths.js'

const PROJECT_FILE = 'project.json'
const IMAGES_DIR = 'images'
/** 回收站目录名。以点开头 → 被 `list()` 跳过，且不会与真实项目 id 撞车。 */
const TRASH_DIR = '.trash'

/**
 * 项目 / 回收站条目的 id 形状：
 *   - 白名单字符（含中文）；
 *   - **不得以点开头** —— 挡 `..`、`.`，也保证 `.trash` 自己永远不能被当成条目操作。
 */
const SAFE_ID = /^[\p{L}\p{N}_-][\p{L}\p{N}._-]*$/u

/** 软删/恢复这一类操作的失败：调用方（HTTP 层）据此给出 404 / 409 / 400。 */
export class TrashError extends Error {
  readonly code: 'not_found' | 'conflict' | 'invalid_id'
  constructor(code: 'not_found' | 'conflict' | 'invalid_id', message: string) {
    super(message)
    this.code = code
  }
}

function assertSafeId(value: string, what: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || value.startsWith('.')) {
    throw new TrashError('invalid_id', `非法的${what}：${String(value)}`)
  }
  return value
}

/** 改名/复制的可注入点（测试用来强制走跨设备回退分支）。 */
export interface MoveHooks {
  readonly rename?: (from: string, to: string) => void
  readonly copy?: (from: string, to: string) => void
  readonly remove?: (target: string) => void
}

/**
 * 移动一个目录：**先试 `rename`（同一个文件系统上是一次原子改名）**，
 * 失败（典型是跨设备的 `EXDEV`）才回退成「递归复制 + 删原件」。
 *
 * 三条不变量：
 *   1. 回退路径里复制失败 → 目标清干净、**源目录一个字节都不动**；
 *   2. 复制成功但删源失败 → 目标回滚，同样保持"要么全都过去了、要么什么都没发生"；
 *   3. 返回实际走的分支，便于路由/日志说明这次是改名还是复制。
 *
 * @throws Error 两条路径都失败时，原目录仍在原处。
 */
export function moveDir(from: string, to: string, hooks: MoveHooks = {}): 'rename' | 'copy' {
  const doRename = hooks.rename ?? renameSync
  const doCopy = hooks.copy ?? ((src: string, dest: string) => cpSync(src, dest, { recursive: true }))
  const doRemove = hooks.remove ?? ((target: string) => rmSync(target, { recursive: true, force: true }))

  try {
    doRename(from, to)
    return 'rename'
  } catch {
    // 落到回退分支：跨设备（EXDEV）、权限差异、Windows 上目标已存在等都可能走到这里。
  }

  try {
    doCopy(from, to)
  } catch (copyError) {
    try {
      doRemove(to)
    } catch {
      // 清理半截副本失败也不能掩盖原始错误；源目录仍在，数据没丢。
    }
    throw new Error(
      `移动失败（复制阶段）：${copyError instanceof Error ? copyError.message : String(copyError)}`,
    )
  }

  try {
    doRemove(from)
  } catch (removeError) {
    try {
      doRemove(to)
    } catch {
      // 回滚失败：目标成了多余副本，但源目录完整，最坏情况是多占一份磁盘。
    }
    throw new Error(
      `移动失败（删除原目录阶段）：${removeError instanceof Error ? removeError.message : String(removeError)}`,
    )
  }

  return 'copy'
}

export interface StoredImage {
  readonly file: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly sha256: string
  readonly mediaType: string
}

export interface ProjectItem {
  readonly module: string
  readonly label: string
  readonly prompt: string
  readonly size: string
  readonly provider: string
  readonly model: string
  readonly apiMode: string
  readonly status: 'ok' | 'failed'
  readonly images: readonly StoredImage[]
  readonly degraded?: readonly string[]
  readonly error?: string
  readonly ms: number
  readonly createdAt: number
}

export interface ProjectRecord {
  readonly version: number
  readonly id: string
  readonly name: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly provider: string
  readonly model: string
  readonly items: readonly ProjectItem[]
}

export interface ProjectSummary {
  readonly id: string
  readonly name: string
  readonly createdAt: number
  readonly imageCount: number
  readonly cover?: string
  readonly provider: string
  readonly model: string
}

/** 回收站条目。`id` 是**回收站目录名**（恢复/清空都按它定位），`projectId` 是记录里的原 id。 */
export interface TrashedProjectSummary {
  readonly id: string
  readonly projectId: string
  readonly name: string
  readonly createdAt: number
  /** 删除时刻（近似：取回收站目录的 mtime；改名不改 mtime，跨设备复制则是复制时刻）。 */
  readonly deletedAt: number
  readonly imageCount: number
  readonly provider: string
  readonly model: string
}

/** 软删/恢复的结果：`mode` 说明走的是改名还是复制回退。 */
export interface MoveOutcome {
  readonly trashId: string
  readonly id: string
  readonly mode: 'rename' | 'copy'
}

/** 文件名/目录名安全化：去掉路径分隔符与控制字符，保留中文。 */
export function slugify(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 40)
  return cleaned === '' ? fallback : cleaned
}

function dateStamp(now: number): string {
  const date = new Date(now)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function extensionFor(mediaType: string): string {
  if (mediaType === 'image/jpeg') return 'jpg'
  if (mediaType === 'image/webp') return 'webp'
  if (mediaType === 'image/gif') return 'gif'
  return 'png'
}

export class ProjectStore {
  readonly dataDir: string
  readonly projectsRoot: string
  /** 回收站根：`projects/.trash`。同样过 `assertContained`，防目录穿越。 */
  readonly trashRoot: string
  private readonly mutex: KeyedMutex

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.projectsRoot = assertContained(dataDir, join(dataDir, 'projects'))
    this.trashRoot = assertContained(this.projectsRoot, join(this.projectsRoot, TRASH_DIR))
    this.mutex = createKeyedMutex()
  }

  private projectDir(projectId: string): string {
    return assertContained(this.projectsRoot, join(this.projectsRoot, projectId))
  }

  private projectFile(projectId: string): string {
    return join(this.projectDir(projectId), PROJECT_FILE)
  }

  /** 回收站条目的目录；id 先过形状校验，再过包含校验（防穿越 + 防 `.trash` 自指）。 */
  private trashDir(trashId: string): string {
    const id = assertSafeId(trashId, '回收站 id')
    return assertContained(this.trashRoot, join(this.trashRoot, id))
  }

  /** 图片目录的绝对路径（只读路由要用）。 */
  imagesDir(projectId: string): string {
    return assertContained(this.projectsRoot, join(this.projectDir(projectId), IMAGES_DIR))
  }

  /** 项目是否存在。 */
  has(projectId: string): boolean {
    return existsSync(this.projectFile(projectId))
  }

  /**
   * 创建项目（已存在则直接返回）。
   * @param name - 项目显示名。
   * @param provider - 厂商 id。
   * @param model - 模型名。
   * @param now - 时间戳（注入以便测试）。
   */
  async create(name: string, provider: string, model: string, now = Date.now()): Promise<ProjectRecord> {
    const base = `${dateStamp(now)}-${slugify(name, 'project')}`

    return this.mutex.run(this.projectsRoot, async () => {
      let id = base
      let seq = 1
      while (existsSync(this.projectFile(id))) {
        seq += 1
        id = `${base}-${seq}`
      }

      const dir = this.projectDir(id)
      mkdirSync(join(dir, IMAGES_DIR), { recursive: true })

      const record: ProjectRecord = {
        version: 1,
        id,
        name,
        createdAt: now,
        updatedAt: now,
        provider,
        model,
        items: [],
      }
      writeFileAtomic(this.projectFile(id), `${JSON.stringify(record, null, 2)}\n`)
      return record
    })
  }

  /**
   * 落盘一张图（内容寻址）。
   * @returns 记录与绝对路径。
   */
  async saveImage(
    projectId: string,
    bytes: Uint8Array,
    mediaType: string,
    slug: string,
  ): Promise<StoredImage & { readonly absolutePath: string }> {
    const info = imageInfo(bytes, mediaType)

    return this.mutex.run(projectId, async () => {
      const dir = this.imagesDir(projectId)
      mkdirSync(dir, { recursive: true })

      // 内容寻址：同哈希已存在就复用，**忽略 slug 差异**——
      // 同一张图被两次生成（不同模块后缀）时不该占两份磁盘。
      const prefix = info.sha256.slice(0, 8)
      const extension = extensionFor(mediaType)
      let fileName = `${prefix}-${slugify(slug, 'image')}.${extension}`
      try {
        const existing = readdirSync(dir).find(
          (entry) => entry.startsWith(`${prefix}-`) || entry.startsWith(`${prefix}.`),
        )
        if (existing !== undefined) fileName = existing
      } catch {
        // 目录刚建出来时读不到就算了，按新名字写
      }

      const absolutePath = assertContained(dir, join(dir, fileName))
      if (!existsSync(absolutePath)) writeFileSync(absolutePath, bytes)

      const record: StoredImage = {
        file: `${IMAGES_DIR}/${fileName}`,
        bytes: bytes.length,
        width: info.width,
        height: info.height,
        sha256: info.sha256,
        mediaType,
      }
      return { ...record, absolutePath }
    })
  }

  /** 追加一条模块产出并更新 `updatedAt`。 */
  async appendItem(projectId: string, item: ProjectItem): Promise<ProjectRecord> {
    return this.mutex.run(projectId, async () => {
      const existing = this.read(projectId)
      const record: ProjectRecord = {
        ...existing,
        updatedAt: Date.now(),
        items: [...existing.items, item],
      }
      writeFileAtomic(this.projectFile(projectId), `${JSON.stringify(record, null, 2)}\n`)
      return record
    })
  }

  /** 读取项目记录；缺失或损坏返回抛错前的明确失败。 */
  read(projectId: string): ProjectRecord {
    const result = readJsonFile<ProjectRecord>(this.projectFile(projectId))
    if (!result.ok) {
      throw new Error(
        result.reason === 'missing'
          ? `项目不存在：${projectId}`
          : `项目记录无法解析：${projectId}（${result.error}）`,
      )
    }
    return result.value
  }

  /** 列表——由扫描目录得出，不依赖任何索引文件。 */
  list(): readonly ProjectSummary[] {
    if (!existsSync(this.projectsRoot)) return []

    const summaries: ProjectSummary[] = []
    for (const entry of readdirSync(this.projectsRoot)) {
      // **隐藏目录一律不是项目**：回收站 `.trash`、原子写的临时残骸等都走这一条。
      // 旧实现是"读不到 project.json 就跳过"，也恰好漏掉 `.trash`；但那种排除是
      // 巧合（`projects/.trash/project.json` 不存在），一旦将来给回收站写了索引就失效，
      // 所以这里显式钉住（有测试断言）。
      if (entry.startsWith('.')) continue

      const dir = join(this.projectsRoot, entry)
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch {
        continue
      }

      const result = readJsonFile<ProjectRecord>(join(dir, PROJECT_FILE))
      // 单个项目损坏不影响整体列表——跳过并继续。
      if (!result.ok) continue

      const record = result.value
      const withImage = record.items.find((item) => item.images.length > 0)
      const cover = withImage?.images[0]
      summaries.push({
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        imageCount: record.items.reduce((total, item) => total + item.images.length, 0),
        ...(cover === undefined ? {} : { cover: `${record.id}/${cover.file}` }),
        provider: record.provider,
        model: record.model,
      })
    }

    return summaries.sort((a, b) => b.createdAt - a.createdAt)
  }

  // ───────────────────────────────────────────────────── 软删 / 回收站

  /**
   * 软删项目：把整个 `projects/<id>` 目录**移动**到 `projects/.trash/<trashId>`。
   *
   * 为什么是移动而不是先复制再删原件：目录改名是一次元数据操作，
   * 没有"复制到一半"的中间态，用户点删除后立刻就能看到列表少了它。
   * 只有跨设备（`EXDEV`）时才回退成复制 + 删（见 `moveDir`）。
   *
   * @returns `trashId`（回收站里的目录名）与实际走的分支。
   * @throws TrashError 项目不存在（`not_found`）或 id 非法（`invalid_id`）。
   */
  async moveToTrash(projectId: string): Promise<MoveOutcome> {
    const id = assertSafeId(projectId, '项目 id')
    const source = this.projectDir(id)
    if (!existsSync(join(source, PROJECT_FILE))) {
      throw new TrashError('not_found', `项目不存在：${id}`)
    }

    return this.mutex.run(this.projectsRoot, async () => {
      mkdirSync(this.trashRoot, { recursive: true })
      const trashId = this.freeTrashId(id)
      const mode = moveDir(source, this.trashDir(trashId))
      return { trashId, id, mode }
    })
  }

  /** 回收站列表（时间倒序）。**只读**。 */
  listTrash(): readonly TrashedProjectSummary[] {
    if (!existsSync(this.trashRoot)) return []

    const summaries: TrashedProjectSummary[] = []
    for (const entry of readdirSync(this.trashRoot)) {
      if (entry.startsWith('.')) continue
      const dir = join(this.trashRoot, entry)
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      const result = readJsonFile<ProjectRecord>(join(dir, PROJECT_FILE))
      if (!result.ok) continue

      const record = result.value
      let deletedAt = 0
      try {
        deletedAt = statSync(dir).mtimeMs
      } catch {
        // 取不到 mtime 就报 0（客户端显示"—"），不因为一个时间戳丢掉整条记录。
      }
      summaries.push({
        id: entry,
        projectId: record.id,
        name: record.name,
        createdAt: record.createdAt,
        deletedAt,
        imageCount: record.items.reduce((total, item) => total + item.images.length, 0),
        provider: record.provider,
        model: record.model,
      })
    }

    return summaries.sort((a, b) => b.deletedAt - a.deletedAt)
  }

  /**
   * 从回收站恢复：移回 `projects/<原 id>`。
   *
   * 恢复目标取 **`project.json` 里记录的原 id**（而不是回收站目录名），
   * 这样"删了 → 又建了同名项目 → 再删"这种碰撞也不会把身份搞混。
   *
   * @throws TrashError 条目不存在（`not_found`）或原 id 已被占用（`conflict`）。
   */
  async restoreFromTrash(trashId: string): Promise<{ readonly id: string; readonly trashId: string; readonly mode: 'rename' | 'copy' }> {
    const source = this.trashDir(trashId)
    const result = readJsonFile<ProjectRecord>(join(source, PROJECT_FILE))
    if (!result.ok) {
      throw new TrashError(
        'not_found',
        result.reason === 'missing'
          ? `回收站里没有 ${trashId}`
          : `回收站记录无法解析：${trashId}（${result.error}）`,
      )
    }

    const id = assertSafeId(String(result.value.id ?? ''), '项目 id')
    const target = this.projectDir(id)

    return this.mutex.run(this.projectsRoot, async () => {
      if (existsSync(join(target, PROJECT_FILE))) {
        throw new TrashError('conflict', `projects/ 下已有项目 ${id}，请先重命名或删除它再恢复`)
      }
      const mode = moveDir(source, target)
      return { id, trashId: assertSafeId(trashId, '回收站 id'), mode }
    })
  }

  /**
   * 清空回收站。
   * @returns 被清掉的条目数（保留空的 `.trash` 目录，让"清空后回收站为空"可断言）。
   */
  purgeTrash(): number {
    if (!existsSync(this.trashRoot)) return 0
    let count = 0
    for (const entry of readdirSync(this.trashRoot)) {
      if (entry.startsWith('.')) continue
      count += 1
    }
    rmSync(this.trashRoot, { recursive: true, force: true })
    mkdirSync(this.trashRoot, { recursive: true })
    return count
  }

  /** 回收站目录名去重：同名项目删两次时后者退避成 `<id>-2`，绝不覆盖前一份。 */
  private freeTrashId(base: string): string {
    if (!existsSync(join(this.trashRoot, base))) return base
    for (let seq = 2; seq < 1000; seq += 1) {
      const candidate = `${base}-${String(seq)}`
      if (!existsSync(join(this.trashRoot, candidate))) return candidate
    }
    return `${base}-${String(Date.now())}`
  }
}
