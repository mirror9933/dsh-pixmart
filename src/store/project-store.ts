/**
 * 项目库：`<dataDir>/projects/<projectId>/`。
 *
 * 两个刻意的设计选择：
 *   1. **不维护单独的索引文件** —— 列表由扫描目录得出。方案 §7.8 原本有
 *      `index.json`，但"扫描即可重建"是它的超集：没有需要修复的索引，
 *      A6（索引损坏后仍能恢复）变成结构性成立而不是靠恢复逻辑。
 *   2. **文件名内容寻址** `<sha8>-<slug>.<ext>` —— 同内容同哈希天然去重，
 *      也让只读路由可以安全地长缓存。
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { imageInfo } from '../image-info.js'
import { readJsonFile, writeFileAtomic } from './atomic.js'
import { createKeyedMutex, type KeyedMutex } from './mutex.js'
import { assertContained } from './paths.js'

const PROJECT_FILE = 'project.json'
const IMAGES_DIR = 'images'

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
  private readonly mutex: KeyedMutex

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.projectsRoot = assertContained(dataDir, join(dataDir, 'projects'))
    this.mutex = createKeyedMutex()
  }

  private projectDir(projectId: string): string {
    return assertContained(this.projectsRoot, join(this.projectsRoot, projectId))
  }

  private projectFile(projectId: string): string {
    return join(this.projectDir(projectId), PROJECT_FILE)
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
}
