/**
 * 系统提示贡献 —— 让插件"被发现"。
 *
 * 没有这一段时，模型只能靠工具描述推断"用户说帮我做张主图 时该用 pixmart_*"。
 * 能 work，但不可靠：口语化表达、会话里工具一多就可能想不到。而且**成本约束
 * 完全靠模型自觉**——它可能直接连调三次 generate 而不先做免费的 dry run。
 *
 * 放置位置取 **3050**：查 `dsh-system-prompt` 的中央顺序表，
 * 官方布局是「-1000 身份 / 0 人格 / 500–900 策略 / 1000–3000 各工具说明 / 3100 MCP」。
 * 我们属于工具说明带，于是取"最后一个官方工具（3000）之后、MCP（3100）之前"，
 * 两侧都留了余量，不用极端值抢位。
 */
import type { HostContext, SystemPromptLike } from './host-types.js'

/** 区段名。与插件同名，便于在 `system-prompt/change` 日志里辨认。 */
export const GUIDANCE_SECTION = 'dsh-pixmart'

/**
 * 区段序号。含义见文件头：官方工具说明带走 1000–3000，MCP 在 3100。
 */
export const GUIDANCE_ORDER = 3050

/** 交给模型的说明正文。刻意写得短——系统提示的预算要花在高信号规则上。 */
export const GUIDANCE_TEXT = [
  '## PixMart 电商生图（插件 dsh-pixmart）',
  '',
  '用户要做电商商品图（主图 / 详情图 / 广告图）、风格复刻或白底图时，用 `pixmart_*` 工具，',
  '不要自己拼图像提示词去猜厂商参数。',
  '',
  '**计费与省钱顺序**：`pixmart_prompt` 与 `pixmart_check_size` **不产生任何费用**；',
  '`pixmart_generate` / `pixmart_edit` / `pixmart_batch` **每次都会真实调用厂商并计费**。',
  '所以顺序是：`pixmart_prompt` 定稿提示词 → `pixmart_check_size` 校验尺寸 → 最后才生图。',
  '批量前**必须**把「项数 × 每项张数」报给用户确认，不要自行放大规模。',
  '',
  '**模块**：共 24 个（主图 5 / 详情图 14 / 广告 3 / 工具 2）。',
  '不确定选哪个模块时，先用 `pixmart_prompt` 的 `listModules: true` 取全量清单再决定。',
  '常见意图 → 模块（实战中曾误用 `main.white-bg` 去做"基于参考图的白底图"）：',
  '- 有参考图做纯白底 → `tool.white-bg`（专为参考图设计）。',
  '  `main.white-bg` 是**无参考图的白底首图**，其文本面向带印刷包装的商品，',
  '  拿它做玩偶/软体产品会不对口。',
  '- 学爆款设计风格做迁移 → `tool.style-replica`',
  '- 详情页首屏 → `detail.hero`；效果对比 → `detail.comparison`；工艺材质 → `detail.craft`',
  '需要保持产品外观一致（保真、风格复刻、白底图）时必须用 `pixmart_edit` 并传参考图，',
  '文生图无法保证主体一致。',
  '',
  '**耗时预期**：单张生图/编辑实测可达 **1–3 分钟**（曾观测到 106 秒）。',
  '等待期间**不要重复调用**同一个工具——那会重复计费并留下多个项目。',
  '`pixmart_batch` 单项更多，超时上限已放宽到 15 分钟。',
  '',
  '**没有可用密钥时不要反复重试**：直接告诉用户去「设置 → PixMart」填写 API Key 并点「测试连接」。',
  '',
  '产物会落盘到插件数据目录，并出现在侧边栏「PixMart → 作品库」中；',
  '历史记录与累计用量用 `pixmart_projects` 查询。',
].join('\n')

function isSystemPromptLike(value: unknown): value is SystemPromptLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<SystemPromptLike>).section === 'function'
  )
}

/**
 * 注册系统提示区段。
 *
 * **必须经 `ctx.inject(['systemPrompt'], …)` 调用**：服务在 `apply()` 时刻可能尚未就绪，
 * 直接 `ctx.get()` 会静默拿到 undefined 并永久跳过注册——这正是路由那次 404 的成因。
 *
 * @param host - 已注入 `systemPrompt` 的上下文。
 * @returns 是否真的注册成功（供测试与自检断言）。
 */
export function installGuidance(host: HostContext): boolean {
  const service = host.get('systemPrompt')
  if (!isSystemPromptLike(service)) return false

  service.section({
    name: GUIDANCE_SECTION,
    order: GUIDANCE_ORDER,
    text: GUIDANCE_TEXT,
  })
  return true
}
