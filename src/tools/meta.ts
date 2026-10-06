/**
 * 三个**不发网络**的工具：`pixmart_providers` / `pixmart_check_size` / `pixmart_prompt`。
 *
 * 它们共同构成"先看后花钱"的护栏：Agent 可以在真正调用厂商之前看清配置、
 * 校验尺寸、并把最终提示词原样打出来。
 */
import { findProvider, toProviderView, type PixmartConfig } from '../config.js'
import { MODULES, getModule } from '../prompts/modules.js'
import { buildPrompt } from '../prompts/build.js'
import { checkSize } from '../sizes.js'
import type { ApiMode } from '../config.js'
import type { ToolDefinitionLike } from '../host-types.js'
import { TOOL_FOOTER, failure, fromException, textBlock, type ToolRuntime } from './runtime.js'

function pickString(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function pickRecord(source: unknown, key: string): Record<string, string> | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source as Record<string, unknown>)[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v
  return out
}

/** 解决"用哪个厂商/模型的 apiMode"这一步，供尺寸校验使用。 */
function resolveTarget(
  config: PixmartConfig,
  providerId: string | undefined,
  model: string | undefined,
  apiModeOverride: string | undefined,
): { ok: true; provider: ReturnType<typeof findProvider>; model: string; apiMode: ApiMode } | { ok: false; message: string } {
  const provider = findProvider(config, providerId)
  if (provider === undefined) {
    const known = config.providers.map((item) => item.id).join(', ')
    return { ok: false, message: `找不到厂商 "${providerId ?? config.defaults.provider}"；已配置：${known || '（无）'}` }
  }
  const resolvedModel = model ?? config.defaults.model ?? provider.models[0] ?? ''
  if (resolvedModel === '') return { ok: false, message: `厂商「${provider.label}」没有可用模型，请先在设置页配置` }

  const geminiImage = /gemini.*image|imagen|nano[- ]?banana/i.test(resolvedModel)
  const apiMode: ApiMode =
    (apiModeOverride as ApiMode | undefined) ??
    (geminiImage && provider.dialect === 'ofox' && provider.geminiNativeBaseUrl.trim() !== ''
      ? 'gemini-native'
      : provider.apiMode)

  return { ok: true, provider, model: resolvedModel, apiMode }
}

/**
 * 注册三个只读工具。
 * @param runtime - 工具运行时。
 * @returns 注册函数数组。
 */
export function createMetaTools(runtime: ToolRuntime): ToolDefinitionLike[] {
  const { ctx } = runtime

  const providers: ToolDefinitionLike = {
    name: 'pixmart_providers',
    description: [
      '列出 dsh-pixmart 已配置的厂商、模型、默认值与限制，并说明密钥是否就位。',
      '调用时机：生图前确认用哪家、哪个模型；或排查"为什么报没有密钥"。',
      '不返回任何密钥内容，只返回是否存在。',
      TOOL_FOOTER,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: '只看某个厂商 id；省略则全部列出。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          dataDir: { type: 'string' },
          defaultProvider: { type: 'string' },
          defaultModel: { type: 'string' },
          defaultSize: { type: 'string' },
          exportDir: { type: 'string' },
          providerIds: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        // 实际值还带 dataDirNotes / limits / 动态的 `provider:<id>`，因此必须开放。
        additionalProperties: true,
        required: ['ok'],
      },
      render: (_args, value) => {
        const lines: string[] = [`厂商配置（数据目录：${String(value.dataDir)}）`]
        const ids = Array.isArray(value.providerIds) ? value.providerIds : []
        for (const id of ids) {
          const detail = value[`provider:${String(id)}`]
          lines.push(`- ${String(detail ?? id)}`)
        }
        lines.push(
          `默认：${String(value.defaultProvider)} / ${String(value.defaultModel)} / ${String(value.defaultSize)}`,
        )
        // 作品库导出路径：Agent 可以据此告诉用户"导出会落在哪"。
        // 生成**不会**往这里写任何东西（语义变更），所以措辞里必须说清"导出时"；
        // 而导出**只有用户点界面那一个入口**（`POST /pixmart/api/projects/<id>/export`，
        // 目标 = `dir` > 这条配置 > 失败）——Agent 工具侧已无导出能力（contract-notes §16.6），
        // 所以这里不能再写"Agent 调 pixmart_projects action=export"。
        const exportDir = typeof value.exportDir === 'string' ? value.exportDir : ''
        lines.push(
          exportDir === ''
            ? '作品库导出路径：未配置（图片只在数据目录，经作品库浏览；要文件形式的副本，请先在设置里配置该路径，再到作品库点「导出」）'
            : `作品库导出路径：${exportDir}（用户在作品库点「导出」时的落点 ${exportDir}/<项目 id>/；生成时不复制，Agent 工具也不写这里）`,
        )
        if (Array.isArray(value.warnings) && value.warnings.length > 0) {
          lines.push(`注意：${value.warnings.join('；')}`)
        }
        return [textBlock(lines.join('\n'))]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: unknown): Promise<unknown> {
      try {
        const config = await runtime.config()
        const wanted = pickString(args, 'provider')
        const selected =
          wanted === undefined ? config.providers : config.providers.filter((p) => p.id === wanted)

        const value: Record<string, unknown> = {
          ok: true,
          dataDir: runtime.dataDir,
          dataDirNotes: [...runtime.dataDirNotes],
          warnings: [...runtime.configWarnings()],
          defaultProvider: config.defaults.provider,
          defaultModel: config.defaults.model,
          defaultSize: config.defaults.size,
          exportDir: config.exportDir,
          limits: { ...config.limits },
          providerIds: selected.map((p) => p.id),
        }
        for (const provider of selected) {
          const view = toProviderView(provider)
          value[`provider:${provider.id}`] =
            `${view.label} [${view.id}] ${view.group} · ${view.apiMode}/${view.dialect} · ` +
            `密钥 ${view.hasApiKey ? `已就位(${view.apiKeySource})` : '缺失'} · ` +
            `模型 ${view.models.join(' / ') || '（未配置）'}`
        }
        return value
      } catch (error) {
        return fromException(error, 'providers')
      }
    },
  }

  const checkSizeTool: ToolDefinitionLike = {
    name: 'pixmart_check_size',
    description: [
      '校验某个模型是否支持目标尺寸，并给出最近可用的替代尺寸。',
      '调用时机：**生图之前**。不支持的尺寸会在这里被挡住，不会产生任何厂商请求。',
      '尺寸可以用比例（1:1、3:4）或像素（1024x1024）；适配器会按调用形态自动归一化。',
      TOOL_FOOTER,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        size: { type: 'string', description: '目标尺寸，如 1:1 或 1024x1024。' },
        model: { type: 'string', description: '模型名；省略用默认模型。' },
        provider: { type: 'string', description: '厂商 id；省略用默认厂商。' },
        apiMode: {
          type: 'string',
          enum: ['images-generations', 'images-edits', 'chat-image', 'gemini-native'],
          description: '强制调用形态；省略则按模型路由表推断。',
        },
      },
      required: ['size'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          supported: { type: 'boolean' },
          normalized: { type: 'string' },
          nearest: { type: 'array', items: { type: 'string' } },
          capability: { type: 'string' },
          reason: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
          apiMode: { type: 'string' },
        },
        // 失败路径返回 { ok:false, error:{ code, message, hint? } }，同样要放行。
        additionalProperties: true,
        required: ['ok', 'supported'],
      },
      render: (_args, value) => {
        if (value.ok !== true) {
          return [textBlock(`尺寸校验未能完成：${String(value.reason ?? '未知原因')}`)]
        }
        if (value.supported === true) {
          return [
            textBlock(
              `尺寸可用：${String(value.normalized)}（${String(value.capability)}，${String(value.apiMode)}）`,
            ),
          ]
        }
        const nearest = Array.isArray(value.nearest) ? value.nearest.join('、') : ''
        return [
          textBlock(
            `尺寸不可用：${String(value.reason)}\n最近可用：${nearest || '（无候选）'}`,
          ),
        ]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: unknown): Promise<unknown> {
      try {
        const size = pickString(args, 'size')
        if (size === undefined) return failure('invalid_args', '缺少 size 参数')

        const config = await runtime.config()
        const target = resolveTarget(
          config,
          pickString(args, 'provider'),
          pickString(args, 'model'),
          pickString(args, 'apiMode'),
        )
        if (!target.ok) return failure('config', target.message)
        const provider = target.provider
        if (provider === undefined) return failure('config', '厂商解析失败')

        const result = checkSize({ model: target.model, size, apiMode: target.apiMode, provider })
        const base = {
          ok: true,
          provider: provider.id,
          model: target.model,
          apiMode: target.apiMode,
          capability: result.capability,
        }
        return result.supported
          ? { ...base, supported: true, normalized: result.normalized }
          : { ...base, supported: false, reason: result.reason, nearest: [...result.nearest] }
      } catch (error) {
        return fromException(error, 'check_size')
      }
    },
  }

  const promptTool: ToolDefinitionLike = {
    name: 'pixmart_prompt',
    description: [
      '按模块拼装最终提示词并打印出来，**不发起任何厂商请求**（dry run）。',
      '调用时机：生图前想让用户确认提示词、或想调整 vars / 覆盖文本时。',
      `可用模块共 ${MODULES.length} 个，用 pixmart_providers 之外的方式可省略 module 直接用 prompt。`,
      TOOL_FOOTER,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        module: { type: 'string', description: '模块 id，如 main.white-bg、detail.hero。' },
        vars: {
          type: 'object',
          additionalProperties: true,
          description: '模块占位符取值，如 {"product":"陶瓷马克杯"}。',
        },
        userPrompt: { type: 'string', description: '追加在末尾的补充指令。' },
        size: { type: 'string', description: '目标尺寸；省略用模块默认尺寸。' },
        model: { type: 'string' },
        provider: { type: 'string' },
        listModules: { type: 'boolean', description: '为 true 时只列出模块清单。' },
        hasReference: {
          type: 'boolean',
          description:
            '本次是否会带参考图。默认 false（文生图）——无参考图时拼装会剔除依赖参考图的句子，并在缺少 vars.product 时注入"通用无品牌"主体。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          prompt: { type: 'string' },
          negative: { type: 'string' },
          size: { type: 'string' },
          module: { type: 'string' },
          label: { type: 'string' },
          sizeSupported: { type: 'boolean' },
          sizeHint: { type: 'string' },
          moduleIds: { type: 'array', items: { type: 'string' } },
        },
        // 失败路径返回 { ok:false, error:{…} }，同样要放行。
        additionalProperties: true,
        required: ['ok'],
      },
      render: (_args, value) => {
        if (value.ok !== true) return [textBlock(String(value.prompt ?? '提示词拼装失败'))]
        if (Array.isArray(value.moduleIds)) {
          return [textBlock(`可用模块（${value.moduleIds.length}）：\n${value.moduleIds.join('\n')}`)]
        }
        const lines = [`模块：${String(value.label)}（${String(value.module)}）`, `尺寸：${String(value.size)}`]
        if (value.sizeSupported === false) lines.push(`⚠ ${String(value.sizeHint)}`)
        if (Array.isArray(value.notes) && value.notes.length > 0) {
          lines.push('', `拼装调整：${value.notes.join('；')}`)
        }
        lines.push('', '提示词：', String(value.prompt))
        if (typeof value.negative === 'string' && value.negative !== '') {
          lines.push('', `负向提示：${value.negative}`)
        }
        return [textBlock(lines.join('\n'))]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: unknown): Promise<unknown> {
      try {
        const config = await runtime.config()

        const wantList =
          (typeof args === 'object' && args !== null && (args as Record<string, unknown>).listModules === true) ||
          pickString(args, 'listModules') === 'true'

        if (wantList) {
          return { ok: true, moduleIds: MODULES.map((module) => `${module.id}  ${module.label}`) }
        }

        const moduleId = pickString(args, 'module')
        if (moduleId === undefined) {
          return failure(
            'invalid_args',
            '缺少 module 参数',
            `可用模块：${MODULES.map((m) => m.id).join(', ')}`,
          )
        }
        const module = getModule(moduleId)
        if (module === undefined) {
          return failure(
            'unknown_module',
            `未知模块 "${moduleId}"`,
            `可用模块：${MODULES.map((m) => m.id).join(', ')}`,
          )
        }

        const built = buildPrompt({
          module,
          vars: pickRecord(args, 'vars') ?? {},
          overrides: config.promptOverrides,
          userPrompt: pickString(args, 'userPrompt'),
          hasReferences:
            typeof args === 'object' &&
            args !== null &&
            (args as Record<string, unknown>).hasReference === true,
        })

        const size = pickString(args, 'size') ?? built.size
        const target = resolveTarget(
          config,
          pickString(args, 'provider'),
          pickString(args, 'model'),
          undefined,
        )
        const sizeResult = target.ok && target.provider !== undefined
          ? checkSize({ model: target.model, size, apiMode: target.apiMode, provider: target.provider })
          : undefined

        return {
          ok: true,
          module: module.id,
          label: module.label,
          prompt: built.prompt,
          ...(built.negative === undefined ? {} : { negative: built.negative }),
          size,
          sizeSupported: sizeResult?.supported ?? true,
          notes: [...built.notes],
          ...(sizeResult !== undefined && !sizeResult.supported
            ? { sizeHint: `${sizeResult.reason}；最近可用：${sizeResult.nearest.join('、')}` }
            : {}),
        }
      } catch (error) {
        return fromException(error, 'prompt')
      }
    },
  }

  void ctx
  return [providers, checkSizeTool, promptTool]
}
