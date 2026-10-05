/**
 * dsh-pixmart host 入口。
 *
 * 设计约束（P0 取证结论见 docs/contract-notes.md）：
 * - 运行时零 `@deepseek-ai` import：`@deepseek-ai/dsh-tools` 依赖图里有未发布的
 *   包，第三方插件装不上；而它只是「DSL → JSON Schema」的编译糖，产物是普通对象。
 * - 必需依赖只有 `tools`；其余服务在各自工具内按需 `ctx.get()` 探测，缺失即降级。
 * - 所有注册都归当前 fiber：`ctx.effect(() => disposer, label)`。
 */
import type { DshPixmartConfig, HostContext } from './host-types.js'
import { writeSmokeMarker } from './smoke-marker.js'
import { createPingTool } from './tools/ping.js'
import { PLUGIN_NAME } from './version.js'

export const name = PLUGIN_NAME

/** 数组形式 = 必需服务（本 cordis 的对象形式是拦截配置，不是 required/optional）。 */
export const inject = ['tools']

/**
 * 注册 dsh-pixmart 的宿主能力。
 * @param ctx - 宿主上下文。
 * @param config - cordis.yml 中本行的 `config:` 段。
 */
export function apply(ctx: HostContext, config: DshPixmartConfig = {}): void {
  ctx.effect(
    () => ctx.tools.register(createPingTool(ctx, config.dataDir)),
    'dsh-pixmart: tools',
  )
  writeSmokeMarker(ctx)
}

export type { DshPixmartConfig } from './host-types.js'
