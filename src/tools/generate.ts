/**
 * `pixmart_generate`（文生图）与 `pixmart_edit`（图生图 / 风格复刻 / 白底图）。
 *
 * 主链路（技术方案 §7.9 / §5.1）：
 *   拼提示词 → 校验尺寸 → 解析密钥 → 读参考图 → 建项目
 *   → 调厂商（降级链 + 重试）→ 字节落盘 → 附件服务 → 工具卡片可见
 *
 * 供应商失败**不抛异常**：返回结构化 error，让 Agent 能读懂并自行改正。
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { findProvider, resolveApiKey, type ApiMode, type PixmartConfig } from '../config.js'
import { buildPrompt } from '../prompts/build.js'
import { getModule } from '../prompts/modules.js'
import { checkSize } from '../sizes.js'
import { generateImages, sniffImageMediaType, type VendorReference } from '../vendor/openai-compat.js'
import { exportImages } from './export-output.js'
import type { ProjectItem, StoredImage } from '../store/project-store.js'
import type { ToolContentBlock, ToolDefinitionLike, ToolRunContext } from '../host-types.js'
import {
  MAX_REFERENCE_BYTES,
  TOOL_FOOTER,
  failure,
  fromException,
  getAttachments,
  getFs,
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

function pickStringArray(source: unknown, key: string): string[] {
  if (typeof source !== 'object' || source === null) return []
  const value = (source as Record<string, unknown>)[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
}

function pickRecord(source: unknown, key: string): Record<string, string> | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source as Record<string, unknown>)[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v
  return out
}

function resolveTarget(
  config: PixmartConfig,
  providerId: string | undefined,
  model: string | undefined,
): { ok: true; providerId: string; model: string; apiMode: ApiMode } | { ok: false; message: string } {
  const provider = findProvider(config, providerId)
  if (provider === undefined) {
    const known = config.providers.map((item) => item.id).join(', ')
    return { ok: false, message: `找不到厂商 "${providerId ?? config.defaults.provider}"；已配置：${known || '（无）'}` }
  }
  const resolvedModel = model ?? config.defaults.model ?? provider.models[0] ?? ''
  if (resolvedModel === '') return { ok: false, message: `厂商「${provider.label}」没有可用模型` }

  const geminiImage = /gemini.*image|imagen|nano[- ]?banana/i.test(resolvedModel)
  const apiMode: ApiMode =
    geminiImage && provider.dialect === 'ofox' && provider.geminiNativeBaseUrl.trim() !== ''
      ? 'gemini-native'
      : provider.apiMode

  return { ok: true, providerId: provider.id, model: resolvedModel, apiMode }
}

/** 读取一张参考图。优先用 `ctx.fs`（能解析会话工作目录），否则退回本进程 fs。 */
async function readReference(
  runtime: ToolRuntime,
  exec: ToolRunContext,
  path: string,
): Promise<{ ok: true; reference: VendorReference } | { ok: false; message: string }> {
  const fs = getFs(runtime.ctx)
  let resolved: { bytes: Uint8Array; displayPath: string }

  if (fs !== undefined) {
    try {
      const target = await fs.resolve(path, { signal: exec.signal })
      const data = await fs.readBytes(target, exec.signal, MAX_REFERENCE_BYTES)
      resolved = { bytes: data, displayPath: fs.processPath(target) }
    } catch (error) {
      return {
        ok: false,
        message: `读取参考图失败：${path}（${error instanceof Error ? error.message : String(error)}）`,
      }
    }
  } else {
    const absolute = isAbsolute(path) ? path : resolvePath(process.cwd(), path)
    if (!existsSync(absolute)) return { ok: false, message: `参考图不存在：${absolute}` }
    resolved = { bytes: readFileSync(absolute), displayPath: absolute }
  }

  const { bytes, displayPath } = resolved
  if (bytes.length === 0) return { ok: false, message: `参考图为空：${displayPath}` }
  if (bytes.length > MAX_REFERENCE_BYTES) {
    return { ok: false, message: `参考图过大（${bytes.length} 字节，上限 ${MAX_REFERENCE_BYTES}）：${displayPath}` }
  }

  const mediaType = sniffImageMediaType(bytes)
  if (mediaType === undefined) {
    return { ok: false, message: `参考图不是 PNG/JPEG/WebP/GIF：${displayPath}` }
  }

  const name = displayPath.replace(/\\/g, '/').split('/').pop() ?? 'reference'
  return { ok: true, reference: { data: bytes, name, mediaType } }
}

interface GenerationArgs {
  readonly prompt?: string
  readonly moduleId?: string
  readonly vars?: Record<string, string>
  readonly userPrompt?: string
  readonly size?: string
  readonly providerId?: string
  readonly model?: string
  readonly n?: number
  readonly projectName?: string
  readonly referencePaths: readonly string[]
}

async function runGeneration(
  runtime: ToolRuntime,
  exec: ToolRunContext,
  args: unknown,
  mode: 'generate' | 'edit',
): Promise<unknown> {
  const config = await runtime.config()

  const input: GenerationArgs = {
    prompt: pickString(args, 'prompt'),
    moduleId: pickString(args, 'module'),
    vars: pickRecord(args, 'vars'),
    userPrompt: pickString(args, 'userPrompt'),
    size: pickString(args, 'size'),
    providerId: pickString(args, 'provider'),
    model: pickString(args, 'model'),
    n: pickNumber(args, 'n'),
    projectName: pickString(args, 'project'),
    referencePaths: pickStringArray(args, 'referencePaths'),
  }

  if (input.prompt === undefined && input.moduleId === undefined) {
    return failure('invalid_args', '必须给出 prompt 或 module 之一')
  }

  // 1) 提示词
  let finalPrompt = input.prompt ?? ''
  let size = input.size ?? config.defaults.size
  let moduleLabel = '自定义提示词'
  let negative: string | undefined

  if (input.moduleId !== undefined) {
    const module = getModule(input.moduleId)
    if (module === undefined) {
      return failure('unknown_module', `未知模块 "${input.moduleId}"`)
    }
    const built = buildPrompt({
      module,
      vars: input.vars ?? {},
      overrides: config.promptOverrides,
      userPrompt: [input.prompt, input.userPrompt].filter((v): v is string => v !== undefined).join('\n\n'),
      // F2/F3：模块片段是按"有参考图"的场景写的；无参考图时必须按句剔除相关描述，
      // 并在缺少产品描述时注入"通用无品牌"主体（见 prompts/build.ts 顶部说明）。
      hasReferences: mode === 'edit' || input.referencePaths.length > 0,
    })
    finalPrompt = built.prompt
    negative = built.negative
    moduleLabel = module.label
    if (input.size === undefined) size = built.size
  } else if (input.userPrompt !== undefined) {
    finalPrompt = `${finalPrompt}\n\n${input.userPrompt}`
  }

  if (finalPrompt.trim() === '') return failure('invalid_args', '提示词为空')

  // 2) 厂商与尺寸
  const target = resolveTarget(config, input.providerId, input.model)
  if (!target.ok) return failure('config', target.message)
  const provider = findProvider(config, target.providerId)
  if (provider === undefined) return failure('config', `找不到厂商 ${target.providerId}`)

  const sizeResult = checkSize({ model: target.model, size, apiMode: target.apiMode, provider })
  if (!sizeResult.supported) {
    return failure('size_unsupported', sizeResult.reason, `最近可用尺寸：${sizeResult.nearest.join('、')}`)
  }

  // 3) 密钥
  const key = resolveApiKey(provider)
  if (!key.ok) return failure('no_api_key', key.reason, '可在 设置 → 电商生图 中填写，或设置 apiKeyEnv 指向的环境变量')

  // 4) 参考图
  const references: VendorReference[] = []
  for (const path of input.referencePaths) {
    const read = await readReference(runtime, exec, path)
    if (!read.ok) return failure('reference_unreadable', read.message)
    references.push(read.reference)
  }
  if (mode === 'edit' && references.length === 0) {
    return failure('invalid_args', 'pixmart_edit 需要至少一张参考图（referencePaths）')
  }

  // 5) 项目
  const projectName = input.projectName ?? `${moduleLabel}-${new Date().toISOString().slice(0, 10)}`
  const project = await runtime.projectStore.create(projectName, provider.id, target.model)

  // 6) 调厂商
  const n = Math.min(Math.max(input.n ?? config.defaults.n, 1), 4)
  const result = await generateImages({
    provider,
    apiKey: key.key,
    model: target.model,
    prompt: finalPrompt,
    ...(negative === undefined ? {} : { negative }),
    size: sizeResult.normalized,
    n,
    references,
    signal: exec.signal,
    maxRetries: config.limits.maxRetries,
  })

  if (!result.ok) {
    await runtime.projectStore.appendItem(project.id, {
      module: input.moduleId ?? 'custom',
      label: moduleLabel,
      prompt: finalPrompt,
      size: sizeResult.normalized,
      provider: provider.id,
      model: target.model,
      apiMode: result.apiMode,
      status: 'failed',
      images: [],
      degraded: [...result.degraded],
      error: `${result.error.code}: ${result.error.message}`,
      ms: result.ms,
      createdAt: Date.now(),
    })

    // 记账：**每一次付费调用都必须留痕，失败也要**（失败同样消耗了配额/可能已计费）。
    // 早先这里与成功路径都漏了 append，导致 generate/edit 从不写账本，
    // 「累计用量」长期为 0。账本**低报**比不报更危险——它看起来像"没花钱"。
    runtime.usage.append({
      ts: Date.now(),
      provider: provider.id,
      model: target.model,
      apiMode: result.apiMode,
      size: sizeResult.normalized,
      n,
      images: 0,
      ok: false,
      ms: result.ms,
      projectId: project.id,
      errorCode: result.error.code,
    })

    return failure(
      result.error.code,
      result.error.message,
      result.error.retryable ? '该错误可重试；可直接再次调用本工具' : '该错误重试无意义，请先修正配置或提示词',
    )
  }

  // 7) 落盘 + 项目记录
  const saved: (StoredImage & { absolutePath: string })[] = []
  for (let index = 0; index < result.images.length; index += 1) {
    const image = result.images[index]
    if (image === undefined) continue
    saved.push(
      await runtime.projectStore.saveImage(
        project.id,
        image.data,
        image.mediaType,
        `${input.moduleId ?? 'custom'}-${String(index + 1).padStart(2, '0')}`,
      ),
    )
  }

  const item: ProjectItem = {
    module: input.moduleId ?? 'custom',
    label: moduleLabel,
    prompt: finalPrompt,
    size: sizeResult.normalized,
    provider: provider.id,
    model: target.model,
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
  await runtime.projectStore.appendItem(project.id, item)

  // 记账：成功路径同样必须留痕（见失败路径处的说明）。
  runtime.usage.append({
    ts: Date.now(),
    provider: provider.id,
    model: target.model,
    apiMode: result.apiMode,
    size: sizeResult.normalized,
    n,
    images: saved.length,
    ok: true,
    ms: result.ms,
    projectId: project.id,
  })

  // 7.5) 产物另存：配了「产物保存路径」就**复制**一份过去。
  // 原件必须留在数据目录（作品库靠它），复制失败只记 warning，不改判成功/失败。
  const exportOutcome = exportImages(config.outputDir, saved)

  // 8) 对话内可见（附件服务可用时）
  let attachments: unknown[] = []
  let attachmentNote: string | undefined
  const attachmentService = getAttachments(runtime.ctx)
  if (!config.attachmentInConversation) {
    attachmentNote = '配置关闭了对话内嵌图，图片只落盘'
  } else if (attachmentService === undefined) {
    attachmentNote = '宿主未提供 attachments 服务，图片只落盘（工具卡片不显示）'
  } else {
    try {
      const refs = await attachmentService.saveImages(
        result.images.map((image, index) => ({
          data: image.data,
          mediaType: image.mediaType,
          name: saved[index]?.file.split('/').pop() ?? `image-${index + 1}`,
        })),
      )
      attachments = refs.map((ref) => ({ ...ref }))
    } catch (error) {
      attachmentNote = `附件服务拒绝：${error instanceof Error ? error.message : String(error)}`
    }
  }

  // 产出尺寸核对：F1 的教训是端点可能**静默忽略**尺寸参数。
  // 与其相信请求已被遵守，不如在落盘后核对实际像素并如实回报。
  const requestedAspect = (() => {
    const pixel = /^(\d+)x(\d+)$/i.exec(sizeResult.normalized)
    if (pixel !== null) return Number(pixel[1]) / Number(pixel[2])
    const ratio = /^(\d+):(\d+)$/.exec(sizeResult.normalized)
    return ratio === null ? 0 : Number(ratio[1]) / Number(ratio[2])
  })()

  const sizeMismatch: string[] = []
  for (const image of saved) {
    if (requestedAspect <= 0 || image.height === 0) continue
    const actual = image.width / image.height
    if (Math.abs(actual - requestedAspect) / requestedAspect > 0.02) {
      sizeMismatch.push(
        `${image.file}: 请求 ${sizeResult.normalized}（比例 ${requestedAspect.toFixed(3)}），实际 ${image.width}x${image.height}（比例 ${actual.toFixed(3)}）`,
      )
    }
  }

  return {
    ok: true,
    projectId: project.id,
    projectName: project.name,
    provider: provider.id,
    model: target.model,
    apiMode: result.apiMode,
    planReason: result.planReason,
    size: sizeResult.normalized,
    sizeMismatch,
    images: saved.map((image) => ({
      path: image.absolutePath,
      relative: `${project.id}/${image.file}`,
      bytes: image.bytes,
      width: image.width,
      height: image.height,
      sha256: image.sha256,
      mediaType: image.mediaType,
    })),
    attachments,
    degraded: [...result.degraded],
    attempts: result.attempts,
    ms: result.ms,
    outputDir: config.outputDir,
    exported: [...exportOutcome.exported],
    exportWarnings: [...exportOutcome.warnings],
    ...(attachmentNote === undefined ? {} : { attachmentNote }),
    ...(runtime.dataDirNotes.length === 0 ? {} : { dataDirNotes: [...runtime.dataDirNotes] }),
  }
}

function renderGeneration(value: Record<string, unknown>): ToolContentBlock[] {
  if (value.ok !== true) {
    return []
  }
  const images = Array.isArray(value.images) ? value.images : []
  const lines = [
    `已生成 ${images.length} 张 → 项目「${String(value.projectName)}」(${String(value.projectId)})`,
    `模型：${String(value.provider)} / ${String(value.model)} · 形态：${String(value.apiMode)} · 尺寸：${String(value.size)}`,
    `耗时 ${String(value.ms)}ms，请求 ${String(value.attempts)} 次`,
  ]
  if (Array.isArray(value.degraded) && value.degraded.length > 0) {
    lines.push(`⚠ 已降级（这些参数被厂商拒绝后去除）：${value.degraded.join('、')}`)
  }
  if (Array.isArray(value.sizeMismatch) && value.sizeMismatch.length > 0) {
    lines.push(`⚠ 尺寸未被厂商遵守：${value.sizeMismatch.join('；')}`)
  }
  if (typeof value.attachmentNote === 'string') lines.push(`注意：${value.attachmentNote}`)
  for (const image of images) {
    const record = image as Record<string, unknown>
    lines.push(`- ${String(record.path)} (${String(record.width)}x${String(record.height)}, ${String(record.bytes)} 字节)`)
  }
  // 另存副本的**完整路径**必须打出来：Agent 直接 `present` 这些路径，
  // 不必再自己用 pwsh 往工作区里拷一份。
  if (Array.isArray(value.exported) && value.exported.length > 0) {
    lines.push(`已另存 ${value.exported.length} 张到「产物保存路径」（原件仍在数据目录）：`)
    for (const target of value.exported) lines.push(`- ${String(target)}`)
  }
  if (Array.isArray(value.exportWarnings) && value.exportWarnings.length > 0) {
    for (const warning of value.exportWarnings) lines.push(`⚠ ${String(warning)}`)
  }
  return renderWithImages(lines.join('\n'), value.attachments)
}

const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: '提示词；有 module 时作为追加指令。' },
    module: { type: 'string', description: '模块 id，如 main.white-bg、detail.hero。' },
    vars: { type: 'object', additionalProperties: true, description: '模块占位符取值。' },
    userPrompt: { type: 'string', description: '追加在提示词末尾的补充指令。' },
    size: { type: 'string', description: '目标尺寸（比例或像素）；省略用模块默认值。' },
    model: { type: 'string', description: '模型名；省略用默认模型。' },
    provider: { type: 'string', description: '厂商 id；省略用默认厂商。' },
    n: { type: 'integer', minimum: 1, maximum: 4, description: '生成张数，默认 1。' },
    project: { type: 'string', description: '项目名；省略按模块与日期自动命名。' },
    referencePaths: {
      type: 'array',
      items: { type: 'string' },
      description: '参考图路径（产品主体图 / 风格参考图），按顺序传入。',
    },
  },
}

/**
 * 创建 generate / edit 两个工具。
 * @param runtime - 工具运行时。
 */
export function createGenerateTools(runtime: ToolRuntime): ToolDefinitionLike[] {
  const generate: ToolDefinitionLike = {
    name: 'pixmart_generate',
    description: [
      '生成电商商品图（文生图）。',
      '调用前建议先用 pixmart_check_size 校验尺寸、用 pixmart_prompt 预览提示词（两者都不发请求）。',
      '典型用法：module="main.white-bg" 生成白底首图；module="detail.hero" 生成详情首屏。',
      '计费：每次调用会真实调用厂商并产生费用，张数由 n 决定。',
      TOOL_FOOTER,
    ].join('\n'),
    parameters: PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' }, projectId: { type: 'string' } },
        required: ['ok'],
      },
      render: (args, value) =>
        value.ok === true ? renderGeneration(value) : renderFailure(value),
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      try {
        return await runGeneration(runtime, exec, args, 'generate')
      } catch (error) {
        return fromException(error, 'generate')
      }
    },
  }

  const edit: ToolDefinitionLike = {
    name: 'pixmart_edit',
    description: [
      '基于参考图生成/编辑商品图（图生图、风格复刻、白底图）。',
      '必须提供至少一张 referencePaths；参考图会随请求发给厂商。',
      '典型用法：module="tool.white-bg" + 产品图 → 白底主图；module="tool.style-replica" + 爆款设计图与产品图 → 风格迁移。',
      '计费：每次调用会真实调用厂商并产生费用。',
      TOOL_FOOTER,
    ].join('\n'),
    parameters: {
      ...PARAMETERS,
      properties: {
        ...(PARAMETERS.properties as Record<string, unknown>),
      },
      required: ['referencePaths'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' }, projectId: { type: 'string' } },
        required: ['ok'],
      },
      render: (args, value) =>
        value.ok === true ? renderGeneration(value) : renderFailure(value),
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      try {
        return await runGeneration(runtime, exec, args, 'edit')
      } catch (error) {
        return fromException(error, 'edit')
      }
    },
  }

  return [generate, edit]
}

/** 失败渲染：把 code/message/hint 摊平给模型看。 */
function renderFailure(value: Record<string, unknown>): ToolContentBlock[] {
  const error = value.error
  if (typeof error !== 'object' || error === null) return []
  const record = error as Record<string, unknown>
  const hint = typeof record.hint === 'string' ? `\n提示：${record.hint}` : ''
  return [
    { type: 'text', text: `失败 [${String(record.code)}]：${String(record.message)}${hint}` },
  ]
}
