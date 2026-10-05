/**
 * P0 自检落盘（安装验收用，默认关闭）。
 *
 * 设置环境变量 `PIXMART_P0_MARKER=<绝对路径>` 后，`apply()` 会在真实 Loader
 * 组合里写一份 JSON，内容包括：
 *   - 本插件确实被装载（apply 跑到了）；
 *   - `ctx.tools.register()` 没有抛异常；
 *   - 注册表**投影出来的模型面 schema**——也就是模型真正会看到的那一份，
 *     用来证明手写的原始 JSON Schema 被宿主原样接受。
 *
 * 写两次：`apply` 阶段立刻写一次，`settled` 阶段再覆盖一次。
 * 这个两段式来自 P0 的实测发现：**服务可用性必须按阶段看**——在 apply() 时刻
 * 探测会把「稍后由 Service.init 就绪」的服务误判为缺失（实测 `fs` 即如此）。
 * 因此工具内部一律在 **execute 时**探测，而这里把两个阶段都记下来。
 *
 * 这条路径不需要模型凭据，因此可以在 scratch profile 上独立验证。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { HostContext } from './host-types.js'
import { PING_TOOL_NAME } from './tools/ping.js'
import { PLUGIN_NAME, VERSION } from './version.js'

/** 可能存在的宿主服务（用于记录降级分支的实际走向）。 */
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

/** 结算态探测的等待时长：足够让 Service.init 完成。 */
const SETTLE_DELAY_MS = 3000

function probe(ctx: HostContext): { present: string[]; absent: string[] } {
  const present: string[] = []
  const absent: string[] = []
  for (const service of PROBED_SERVICES) {
    if (ctx.get(service) === undefined) absent.push(service)
    else present.push(service)
  }
  return { present, absent }
}

function schemaOf(ctx: HostContext): {
  schemas: unknown
  schemasError: string
} {
  try {
    const projected = ctx.tools.schemas?.()
    return {
      schemas: projected?.find((entry) => entry.name === PING_TOOL_NAME) ?? null,
      schemasError: '',
    }
  } catch (error) {
    return { schemas: null, schemasError: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 若设置了 `PIXMART_P0_MARKER` 就写自检文件；任何失败都不影响插件运行。
 * @param ctx - 宿主上下文。
 */
export function writeSmokeMarker(ctx: HostContext): void {
  const path = process.env.PIXMART_P0_MARKER?.trim()
  if (path === undefined || path === '') return

  const profileFlag = (() => {
    const i = process.argv.indexOf('--profile')
    return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : '<none>'
  })()

  const write = (phase: string): void => {
    const { present, absent } = probe(ctx)
    const payload = {
      at: new Date().toISOString(),
      phase,
      plugin: PLUGIN_NAME,
      version: VERSION,
      profileFlag,
      profileEnv: process.env.DSH_PROFILE ?? '',
      node: process.version,
      cwd: process.cwd(),
      dshHome: process.env.DSH_HOME ?? '',
      registered: [PING_TOOL_NAME],
      ...schemaOf(ctx),
      present,
      absent,
    }
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    } catch {
      // 自检写盘失败不该让插件激活失败：这是诊断钩子，不是功能。
    }
  }

  write('apply')
  try {
    setTimeout(() => { write('settled') }, SETTLE_DELAY_MS)
  } catch {
    // 无定时器时保留 apply 阶段的结果即可。
  }
}
