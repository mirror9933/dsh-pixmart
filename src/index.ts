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
import { registerRoutes } from './routes.js'
import { writeSmokeMarker } from './smoke-marker.js'
import { createRuntime, createToolsFromRuntime } from './tools/index.js'
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
  // 运行时只建一次：工具与 HTTP 路由必须共享同一套 store 与取消控制器。
  const runtime = createRuntime(ctx, config)
  const tools = createToolsFromRuntime(runtime)

  ctx.effect(() => {
    const disposers = tools.map((tool) => ctx.tools.register(tool))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-pixmart: tools')

  // client 半 ↔ host 的唯一通道（包式 client 拿不到 host.call）。
  //
  // **必须惰性挂载，不能在 apply 里 ctx.get('webServer')**：P0 实测
  // （contract-notes §1.3）可选服务在 apply 时刻尚未就绪，webServer 同样如此。
  // 早先那版正是在 apply 里探测 → 拿到 undefined → 静默跳过注册 → 客户端 UI 一直 404。
  // dshmarket 的写法也是 `ctx.inject(['webServer', 'loader'], hostCtx => …)`。
  const lazy = ctx as unknown as {
    inject?: (services: readonly string[], callback: (child: HostContext) => void) => void
  }

  /** 注册形状与 dshmarket 的 RouteDefinition 对齐：{ kind, path, handler(request, response) }。 */
  const mount = (host: HostContext): void => {
    try {
      registerRoutes(host, runtime)
    } catch {
      // 注册失败只让客户端 UI 拿不到数据，绝不带走工具。
    }
  }

  if (typeof lazy.inject === 'function') {
    lazy.inject(['webServer'], mount)
  } else {
    // 极旧宿主没有 inject：退回立即尝试，至少不崩。
    mount(ctx)
  }

  writeSmokeMarker(ctx)
}

export type { DshPixmartConfig } from './host-types.js'
