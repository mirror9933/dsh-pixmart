/**
 * 配置存储：`<dataDir>/config.json` 的加载、原子保存与容错。
 *
 * 密钥在这里，**不在** cordis patch 层——patch 层是可读明文且会被整段覆盖。
 * 损坏的配置不阻断启动：隔离成 `.corrupt-<ts>` 后以默认值继续，用户仍能进设置页改回来。
 */
import { join } from 'node:path'
import { defaultConfig, parseConfig, type PixmartConfig } from '../config.js'
import { quarantineFile, readJsonFile, writeFileAtomic } from './atomic.js'
import { createKeyedMutex, type KeyedMutex } from './mutex.js'
import { assertContained } from './paths.js'

const CONFIG_FILE = 'config.json'

/**
 * 写盘前抹掉**已废弃**的字段。
 *
 * `exportToWorkspace` 曾出现在配置 schema 里（默认 `false`），但**没有任何代码读它**——
 * "工作区副本"早已是无条件自动的（见 tools/workspace-copy.ts）。一个像开关却不是开关的
 * 字段只会误导人，所以它从类型、默认值与解析里都被删掉了；这里在**每次写盘**时顺手把
 * 磁盘上的残留键抹掉（与写路由把废弃 `outputDir` 清成 `''` 同一立场：不让后来的人以为
 * 它还有用）。读盘时不报错、不警告——旧 `config.json` 必须照常能用。
 */
function withoutDeprecatedKeys(config: PixmartConfig): PixmartConfig {
  const next: Record<string, unknown> = { ...config }
  delete next.exportToWorkspace
  return next as unknown as PixmartConfig
}

export interface ConfigLoadResult {
  readonly config: PixmartConfig
  readonly warnings: readonly string[]
  /** 损坏文件被隔离后的路径。 */
  readonly quarantined?: string
}

export class ConfigStore {
  readonly dataDir: string
  readonly configPath: string
  private readonly mutex: KeyedMutex
  private current: PixmartConfig

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.configPath = assertContained(dataDir, join(dataDir, CONFIG_FILE))
    this.mutex = createKeyedMutex()
    this.current = defaultConfig()
  }

  /** 读取落盘配置；缺失或损坏都返回可用配置而不是抛错。 */
  async load(): Promise<ConfigLoadResult> {
    const read = readJsonFile<unknown>(this.configPath)

    if (read.ok) {
      const parsed = parseConfig(read.value)
      this.current = parsed.config
      return { config: parsed.config, warnings: parsed.warnings }
    }

    if (read.reason === 'missing') {
      this.current = defaultConfig()
      return { config: this.current, warnings: [] }
    }

    const quarantined = quarantineFile(this.configPath)
    this.current = defaultConfig()
    return {
      config: this.current,
      warnings: [`配置无法解析（${read.error}），已使用默认值`],
      ...(quarantined === undefined ? {} : { quarantined }),
    }
  }

  /** 当前内存中的配置。 */
  get(): PixmartConfig {
    return this.current
  }

  /** 原子保存并更新内存副本。 */
  async save(next: PixmartConfig): Promise<void> {
    await this.mutex.run(this.configPath, async () => {
      const clean = withoutDeprecatedKeys(next)
      writeFileAtomic(this.configPath, `${JSON.stringify(clean, null, 2)}\n`)
      this.current = clean
    })
  }

  /**
   * 串行化读改写。
   * @param mutate - 基于当前配置产生新配置的纯函数。
   */
  async update(mutate: (current: PixmartConfig) => PixmartConfig): Promise<PixmartConfig> {
    return this.mutex.run(this.configPath, async () => {
      const next = withoutDeprecatedKeys(mutate(this.current))
      writeFileAtomic(this.configPath, `${JSON.stringify(next, null, 2)}\n`)
      this.current = next
      return next
    })
  }
}
