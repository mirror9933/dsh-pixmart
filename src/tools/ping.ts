/**
 * `pixmart_ping`：P0 契约自检工具。
 *
 * 存在的意义是证明三件事在**真实 profile 组合**里成立：
 *   1. host 半被 Loader 装载，且 `ctx.tools.register` 生效（模型能看到并调用）；
 *   2. 手写的原始 JSON Schema 定义被宿主接受（无需 `@deepseek-ai/dsh-tools`）；
 *   3. 可选服务的实际可用性——这决定 P1 的降级分支怎么排。
 *
 * 无副作用：不写文件、不发网络请求。
 */
import { resolveDataDir } from '../store/paths.js'
import type {
  HostContext,
  ToolDefinitionLike,
  ToolOutputValue,
  ToolRunContext,
} from '../host-types.js'
import { PLUGIN_NAME, VERSION } from '../version.js'

export const PING_TOOL_NAME = 'pixmart_ping'

/** P1 会用到、因此现在就要摸清可用性的宿主服务。 */
const PROBED_SERVICES = [
  'tools',
  'attachments',
  'webServer',
  'fs',
  'timer',
  'storage',
  'credentials',
  'commands',
  'systemPrompt',
  'web',
] as const

/** 原始 JSON Schema（宿主模型面直接消费这一形状，见 contract-notes S1）。 */
const PING_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    echo: {
      type: 'string',
      description: '原样回显的字符串，用于确认参数传递链路。',
    },
  },
}

/** 原始 JSON Schema。根 `required` 为数组形式——官方工具表实测即此形状。 */
const PING_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    plugin: { type: 'string' },
    version: { type: 'string' },
    echo: { type: 'string' },
    present: { type: 'array', items: { type: 'string' } },
    absent: { type: 'array', items: { type: 'string' } },
    node: { type: 'string' },
    cwd: { type: 'string' },
    dshHome: { type: 'string' },
    dataDir: { type: 'string' },
    degraded: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'plugin', 'version'],
}

function renderPing(value: ToolOutputValue): { type: string; text: string }[] {
  const line = (label: string, v: unknown): string =>
    `${label}: ${v === undefined || v === '' ? '(空)' : String(v)}`
  return [
    {
      type: 'text',
      text: [
        `pixmart_ping ok=${String(value.ok)} ${String(value.plugin)}@${String(value.version)}`,
        line('node', value.node),
        line('cwd', value.cwd),
        line('dataDir', value.dataDir),
        line('可用服务', Array.isArray(value.present) ? value.present.join(', ') : ''),
        line('缺失服务', Array.isArray(value.absent) ? value.absent.join(', ') : ''),
        line('降级', Array.isArray(value.degraded) ? value.degraded.join('; ') : ''),
      ].join('\n'),
    },
  ]
}

/**
 * 构造 `pixmart_ping` 的工具定义。
 * @param ctx - 宿主上下文，用于探测可选服务。
 * @param configDataDir - cordis.yml 传入的 dataDir 配置。
 */
export function createPingTool(
  ctx: HostContext,
  configDataDir: string | undefined,
): ToolDefinitionLike {
  const { dataDir, degraded } = resolveDataDir(configDataDir)

  return {
    name: PING_TOOL_NAME,
    description: [
      'dsh-pixmart 契约自检工具。',
      '用途：确认插件已在宿主加载、工具注册链路可用，并列出当前宿主暴露的服务。',
      '调用时机：安装或升级本插件后自检一次即可，日常生图不需要它。',
      '副作用：无（不写文件、不发网络请求）。',
      '失败语义：不抛异常；始终返回结构化结果。',
    ].join('\n'),
    parameters: PING_PARAMETERS,
    output: {
      schema: PING_OUTPUT_SCHEMA,
      render: (_args, value) => renderPing(value),
      presentationMeta: (_args, value) => ({ plugin: value.plugin, version: value.version }),
    },
    isConcurrencySafe: () => true,
    async execute(args: unknown, _exec: ToolRunContext): Promise<unknown> {
      const input = (args ?? {}) as { echo?: unknown }
      const present: string[] = []
      const absent: string[] = []
      for (const service of PROBED_SERVICES) {
        if (ctx.get(service) === undefined) absent.push(service)
        else present.push(service)
      }
      return {
        ok: true,
        plugin: PLUGIN_NAME,
        version: VERSION,
        echo: typeof input.echo === 'string' ? input.echo : '',
        present,
        absent,
        node: process.version,
        cwd: process.cwd(),
        dshHome: process.env.DSH_HOME ?? '',
        dataDir,
        degraded,
      }
    },
  }
}
