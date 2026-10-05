/**
 * `pixmart_batch` —— 一次调用产出一套图（技术方案 §7.7 / A5）。
 *
 * 三条设计要点：
 *   1. **并发有界**：默认取配置 `limits.maxConcurrency`，避免一次把厂商打爆。
 *   2. **逐项状态**：每一项独立记 `done` / `failed`，一项失败不影响其余——
 *      批量生图最糟的体验是"跑完才发现全废了"。
 *   3. **过程可观测**：每项完成即写运行注册表，客户端据此逐格点亮（§8.5）。
 *
 * 代价：单张链路的逻辑与 `generate.ts` 有重复（构建提示词 → 校验尺寸 → 调厂商 → 落盘）。
 * P3 会把两者收敛到一个共享的单张执行器；现在优先保证批量这条链路独立可测。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findProvider, resolveApiKey } from '../config.js'
import { buildPrompt } from '../prompts/build.js'
import { getModule } from '../prompts/modules.js'
import { checkSize } from '../sizes.js'
import { generateImages } from '../vendor/openai-compat.js'
import type { ProjectItem } from '../store/project-store.js'
import type { ToolContentBlock, ToolDefinitionLike, ToolRunContext } from '../host-types.js'
import {
  TOOL_FOOTER,
  failure,
  fromException,
  getAttachments,
  renderWithImages,
  type ToolRuntime,
} from './runtime.js'

function pickString(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function pickNumber(source: unknown, key: string): number | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

interface BatchItemInput {
  readonly module: string
  readonly vars?: Record<string, string>
  readonly prompt?: string
}

function pickItems(source: unknown): BatchItemInput[] {
  if (typeof source !== 'object' || source === null) return []
  const raw = (source as Record<string, unknown>).items
  if (!Array.isArray(raw)) return []

  const items: BatchItemInput[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const module = typeof record.module === 'string' ? record.module.trim() : ''
    if (module === '') continue

    const vars: Record<string, string> = {}
    if (typeof record.vars === 'object' && record.vars !== null && !Array.isArray(record.vars)) {
      for (const [k, v] of Object.entries(record.vars as Record<string, unknown>)) {
        if (typeof v === 'string') vars[k] = v
      }
    }
    items.push({
      module,
      vars,
      ...(typeof record.prompt === 'string' && record.prompt.trim() !== ''
        ? { prompt: record.prompt.trim() }
        : {}),
    })
  }
  return items
}

/** 有界并发地跑完所有任务，保持结果顺序与输入一致。 */
async function pool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index] as T, index)
    }
  })

  await Promise.all(runners)
  return results
}

export function createBatchTool(runtime: ToolRuntime): ToolDefinitionLike {
  return {
    name: 'pixmart_batch',
    description: [
      '一次生成一组商品图（如详情图 14 屏）。每项独立成败，一项失败不影响其余。',
      '调用时机：需要成套产出时用它，而不是重复调用 pixmart_generate。',
      '并发默认取配置（通常 2），项目内单项数量上限见配置 maxBatchItems。',
      '计费：**每项都会真实调用厂商**，总次数 = items 数量 × n。调用前请先确认 items 与张数。',
      TOOL_FOOTER,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '要生成的项。每项至少给 module，可选 vars 覆盖占位符。',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              module: { type: 'string', description: '模块 id，如 detail.hero。' },
              vars: { type: 'object', additionalProperties: true, description: '占位符取值。' },
              prompt: { type: 'string', description: '该项目的追加指令。' },
            },
            required: ['module'],
          },
        },
        size: { type: 'string', description: '统一尺寸（比例或像素）；省略用各模块默认值。' },
        model: { type: 'string' },
        provider: { type: 'string' },
        project: { type: 'string', description: '项目名；省略按日期自动命名。' },
        concurrency: { type: 'integer', minimum: 1, maximum: 8, description: '并发数，默认取配置。' },
        n: { type: 'integer', minimum: 1, maximum: 4, description: '每项生成张数，默认 1。' },
      },
      required: ['items'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      },
      render: (_args, value) => {
        const lines: string[] = []
        if (value.ok !== true) {
          const error = (value.error ?? {}) as Record<string, unknown>
          return [
            {
              type: 'text',
              text: `批量生成失败 [${String(error.code)}]：${String(error.message)}`,
            },
          ]
        }
        lines.push(
          `批量完成：成功 ${String(value.completed)} / ${String(value.total)}，失败 ${String(value.failed)}`,
          `项目「${String(value.projectName)}」(${String(value.projectId)}) · 运行 ${String(value.runId)}`,
          `模型：${String(value.provider)} / ${String(value.model)} · 尺寸：${String(value.size)}`,
          `共 ${String(value.requests)} 次厂商请求，耗时 ${String(value.ms)}ms`,
        )
        const items = Array.isArray(value.items) ? value.items : []
        for (const entry of items) {
          const record = entry as Record<string, unknown>
          const mark = record.status === 'done' ? '✓' : '✗'
          const tail = record.error === undefined ? '' : ` — ${String(record.error)}`
          lines.push(`${mark} ${String(record.label)}（${String(record.module)}）${tail}`)
        }
        // 刻意**不**列任何"另存副本"路径：批量也只写数据目录。
        return renderWithImages(lines.join('\n'), value.attachments)
      },
    },
    timeoutMs: 900_000,
    async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      const started = Date.now()
      try {
        const config = await runtime.config()
        const items = pickItems(args)
        if (items.length === 0) {
          return failure('invalid_args', 'items 为空：至少给一项 { module }')
        }
        if (items.length > config.limits.maxBatchItems) {
          return failure(
            'too_many_items',
            `items 数量 ${items.length} 超过上限 ${config.limits.maxBatchItems}`,
            '请拆成多批，或调高配置 limits.maxBatchItems',
          )
        }

        const provider = findProvider(config, pickString(args, 'provider'))
        if (provider === undefined) return failure('config', '找不到厂商')
        const model = pickString(args, 'model') ?? config.defaults.model ?? provider.models[0] ?? ''
        if (model === '') return failure('config', '没有可用模型')

        const key = resolveApiKey(provider)
        if (!key.ok) return failure('no_api_key', key.reason)

        const geminiImage = /gemini.*image|imagen|nano[- ]?banana/i.test(model)
        const apiMode =
          geminiImage && provider.dialect === 'ofox' && provider.geminiNativeBaseUrl.trim() !== ''
            ? ('gemini-native' as const)
            : provider.apiMode

        const sizeOverride = pickString(args, 'size')
        const n = Math.min(Math.max(pickNumber(args, 'n') ?? 1, 1), 4)
        const concurrency = Math.min(
          Math.max(pickNumber(args, 'concurrency') ?? config.limits.maxConcurrency, 1),
          8,
        )

        // 尺寸先按第一项定调：批量通常统一尺寸，提前拦截比跑一半再失败好。
        const firstModule = getModule(items[0]?.module ?? '')
        if (firstModule === undefined) {
          return failure('unknown_module', `未知模块 "${items[0]?.module}"`)
        }
        const probeSize = sizeOverride ?? firstModule.defaultSize
        const probe = checkSize({ model, size: probeSize, apiMode, provider })
        if (!probe.supported) {
          return failure('size_unsupported', probe.reason, `最近可用尺寸：${probe.nearest.join('、')}`)
        }

        const projectName =
          pickString(args, 'project') ?? `批量-${new Date().toISOString().slice(0, 10)}`
        const project = await runtime.projectStore.create(projectName, provider.id, model)

        const run = await runtime.runStore.create({
          tool: 'batch',
          provider: provider.id,
          model,
          apiMode,
          size: probe.normalized,
          total: items.length,
          projectId: project.id,
          projectName: project.name,
          items: items.map((item) => ({
            module: item.module,
            label: getModule(item.module)?.label ?? item.module,
          })),
        })

        // 把工具级取消接到运行的取消信号上：任一来源中止都能停掉在途请求。
        exec.signal.addEventListener('abort', () => {
          runtime.runStore.cancel(run.runId)
        })

        const outcome = await pool(items, concurrency, async (item, index) => {
          const module = getModule(item.module)
          const label = module?.label ?? item.module

          if (module === undefined) {
            await runtime.runStore.setItem(run.runId, index, { status: 'failed', error: { code: 'unknown_module', message: `未知模块 ${item.module}` } })
            return { module: item.module, label, status: 'failed' as const, error: `未知模块 ${item.module}` }
          }

          await runtime.runStore.setItem(run.runId, index, { status: 'running' })

          const built = buildPrompt({
            module,
            vars: item.vars ?? {},
            overrides: config.promptOverrides,
            userPrompt: item.prompt,
            hasReferences: false,
          })
          const size = sizeOverride ?? built.size
          const sizeResult = checkSize({ model, size, apiMode, provider })
          if (!sizeResult.supported) {
            await runtime.runStore.setItem(run.runId, index, {
              status: 'failed',
              error: { code: 'size_unsupported', message: sizeResult.reason },
            })
            return { module: item.module, label, status: 'failed' as const, error: sizeResult.reason }
          }

          const result = await generateImages({
            provider,
            apiKey: key.key,
            model,
            prompt: built.prompt,
            ...(built.negative === undefined ? {} : { negative: built.negative }),
            size: sizeResult.normalized,
            n,
            references: [],
            signal: runtime.runStore.signalFor(run.runId) ?? exec.signal,
            maxRetries: config.limits.maxRetries,
          })

          if (!result.ok) {
            runtime.usage.append({
              ts: Date.now(),
              provider: provider.id,
              model,
              apiMode: result.apiMode,
              size: sizeResult.normalized,
              n,
              images: 0,
              ok: false,
              ms: result.ms,
              runId: run.runId,
              projectId: project.id,
              errorCode: result.error.code,
            })
            await runtime.runStore.setItem(run.runId, index, {
              status: 'failed',
              error: { code: result.error.code, message: result.error.message },
              ms: result.ms,
            })
            return {
              module: item.module,
              label,
              status: 'failed' as const,
              error: `${result.error.code}: ${result.error.message}`,
            }
          }

          const saved = []
          for (let i = 0; i < result.images.length; i += 1) {
            const image = result.images[i]
            if (image === undefined) continue
            saved.push(
              await runtime.projectStore.saveImage(
                project.id,
                image.data,
                image.mediaType,
                `${item.module}-${String(i + 1).padStart(2, '0')}`,
              ),
            )
          }

          // 落盘即结束：生成**只**写数据目录。用户要文件形式的副本，
          // 走作品库的「导出」（不再有生成时自动复制）。
          const first = saved[0]
          await runtime.runStore.setItem(run.runId, index, {
            status: 'done',
            ...(first === undefined ? {} : { file: first.file, width: first.width, height: first.height }),
            ms: result.ms,
          })

          runtime.usage.append({
            ts: Date.now(),
            provider: provider.id,
            model,
            apiMode: result.apiMode,
            size: sizeResult.normalized,
            n,
            images: saved.length,
            ok: true,
            ms: result.ms,
            runId: run.runId,
            projectId: project.id,
            ...(result.degraded.length === 0 ? {} : { degraded: [...result.degraded] }),
          })

          const itemRecord: ProjectItem = {
            module: item.module,
            label,
            prompt: built.prompt,
            size: sizeResult.normalized,
            provider: provider.id,
            model,
            apiMode: result.apiMode,
            status: 'ok',
            images: saved.map((image) => ({
              file: image.file,
              bytes: image.bytes,
              width: image.width,
              height: image.height,
              sha256: image.sha256,
              mediaType: image.mediaType,
            })),
            degraded: [...result.degraded],
            ms: result.ms,
            createdAt: Date.now(),
          }
          await runtime.projectStore.appendItem(project.id, itemRecord)

          return {
            module: item.module,
            label,
            status: 'done' as const,
            files: saved.length,
          }
        })

        const completed = outcome.filter((entry) => entry.status === 'done').length
        const failed = outcome.length - completed
        await runtime.runStore.finish(run.runId, failed === 0 ? 'done' : completed === 0 ? 'failed' : 'done')
        await runtime.runStore.prune()

        // 收集全部产出用于对话内嵌图
        const record = runtime.projectStore.read(project.id)
        const attachmentService = getAttachments(runtime.ctx)
        let attachments: unknown[] = []
        let attachmentNote: string | undefined
        if (!config.attachmentInConversation) {
          attachmentNote = '配置关闭了对话内嵌图，图片只落盘'
        } else if (attachmentService === undefined) {
          attachmentNote = '宿主未提供 attachments 服务，图片只落盘'
        } else if (completed > 0) {
          try {
            const files = record.items.flatMap((item) => item.images)
            const inputs = files.slice(0, 12).map((image) => ({
              data: readProjectFile(runtime, project.id, image.file),
              mediaType: image.mediaType,
              name: image.file.split('/').pop() ?? 'image',
            }))
            const refs = await attachmentService.saveImages(inputs)
            attachments = refs.map((ref) => ({ ...ref }))
            if (files.length > 12) {
              attachmentNote = `对话内只嵌入前 12 张，其余 ${files.length - 12} 张在磁盘上`
            }
          } catch (error) {
            attachmentNote = `附件服务拒绝：${error instanceof Error ? error.message : String(error)}`
          }
        }

        return {
          ok: true,
          runId: run.runId,
          projectId: project.id,
          projectName: project.name,
          provider: provider.id,
          model,
          apiMode,
          size: probe.normalized,
          total: items.length,
          completed,
          failed,
          requests: completed + failed,
          items: outcome,
          attachments,
          ms: Date.now() - started,
          ...(attachmentNote === undefined ? {} : { attachmentNote }),
        }
      } catch (error) {
        return fromException(error, 'batch')
      }
    },
  }
}

/** 读取项目内一张图的字节（用于附件服务）。 */
function readProjectFile(runtime: ToolRuntime, projectId: string, relative: string): Uint8Array {
  const imagesDir = runtime.projectStore.imagesDir(projectId)
  const name = relative.split('/').pop() ?? ''
  return readFileSync(join(imagesDir, name))
}
