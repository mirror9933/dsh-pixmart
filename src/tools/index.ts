/**
 * 工具注册总装。
 *
 * 每个工具自己负责"服务在 execute 时探测"（见 runtime.ts 的说明）；
 * 这里只负责把运行时建好、把工具一次性注册进当前 fiber。
 */
import type { DshPixmartConfig, HostContext, ToolDefinitionLike } from '../host-types.js'
import { createBatchTool } from './batch.js'
import { createGenerateTools } from './generate.js'
import { createMetaTools } from './meta.js'
import { createPingTool } from './ping.js'
import { createProjectsTool } from './projects.js'
import { createRuntime, type ToolRuntime } from './runtime.js'

/**
 * 构造本插件的全部工具定义（给定一个已建好的运行时）。
 *
 * 与 `createTools` 分开：宿主入口需要用**同一个运行时**去注册 HTTP 路由——
 * 建两个运行时会得到两套取消控制器，`cancelRun` 就失效了。
 * @param runtime - 工具运行时。
 */
export function createToolsFromRuntime(runtime: ToolRuntime): ToolDefinitionLike[] {
  return [
    // P0 留下的自检工具：确认插件已加载并列出宿主可用服务，无副作用。
    createPingTool(runtime.ctx, runtime.dataDir),
    ...createMetaTools(runtime),
    ...createGenerateTools(runtime),
    createBatchTool(runtime),
    createProjectsTool(runtime),
  ]
}

/**
 * 构造本插件的全部工具定义。
 * @param ctx - 宿主上下文。
 * @param config - cordis.yml 中本行的 `config:` 段。
 */
export function createTools(ctx: HostContext, config: DshPixmartConfig): ToolDefinitionLike[] {
  return createToolsFromRuntime(createRuntime(ctx, config))
}

export { createRuntime, type ToolRuntime } from './runtime.js'
