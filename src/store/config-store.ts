/**
 * 配置存储：`<dataDir>/config.json` 的加载、原子保存与容错。
 *
 * 密钥在这里，**不在** cordis patch 层——patch 层是可读明文且会被整段覆盖。
 * 损坏的配置不阻断启动：隔离成 `.corrupt-<ts>` 后以默认值继续，用户仍能进设置页改回来。
 */
import { join } from 'node:path'
import {
  applyFactoryPresets,
  defaultConfig,
  factoryPresetWarning,
  parseConfig,
  type PixmartConfig,
} from '../config.js'
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

  /**
   * 读取落盘配置；缺失或损坏都返回可用配置而不是抛错。
   *
   * 读盘的最后一步仍走 `applyFactoryPresets`（出厂预设补齐机制**保留**），但
   * **出厂清单当前为空**（`defaultConfig().providers === []`，厂商全部由用户从
   * 「添加模型提供商」里加），所以这一步是 no-op：`load()` **不会**自动补入任何厂商，
   * 也不会产生"已从出厂预设补入厂商"的告警。将来若重新放出厂预设，这段逻辑原样生效。
   *
   * 四条边界（都有测试钉着，见 test/factory-presets.test.mjs 与
   * test/config-empty-factory.test.mjs）：
   *   - **不补人**：空文件 / 只有 1 家 / 用户删光了，`load()` 后厂商集合与文件一致；
   *   - 已存在的厂商**一个字段都不覆盖**（用户填的 baseUrl / apiKey / models 逐字节不变）；
   *   - `defaults` / `limits` 完全以文件为准（尤其 `defaults.provider`，含空串 = 尚未选择）；
   *   - **只改内存、不碰磁盘**：补齐不做任何写盘，文件只在用户显式保存时才落盘。
   *
   * `removedProviders`（删除厂商时的墓碑）与删除路由的记账逻辑也一并保留：当前没有
   * 出厂预设可记，所以正常流程不会用到它，`[]` 是常态（见 `PixmartConfig.removedProviders`）。
   *
   * 幂等：每次 load 都从文件重新解析再补，所以连续两次 load 的厂商集合完全一致。
   * 缺失/损坏分支**不需要**补齐：那两条路径本来就返回 `defaultConfig()`。
   */
  async load(): Promise<ConfigLoadResult> {
    const read = readJsonFile<unknown>(this.configPath)

    if (read.ok) {
      const parsed = parseConfig(read.value)
      const merged = applyFactoryPresets(parsed.config)
      this.current = merged.config
      return {
        config: merged.config,
        warnings:
          merged.added.length === 0
            ? parsed.warnings
            : [...parsed.warnings, factoryPresetWarning(merged.added)],
      }
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
