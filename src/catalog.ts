/**
 * 厂商目录（Provider catalog）—— 设置页「添加模型提供商」的**数据源**。
 *
 * ## 出处（**只读转录，绝不修改参考项目**）
 *
 * 全部 20 条逐条转录自参考项目
 * `E:\Programs\trae\project\pixmart-ai\src\renderer\src\types\model.ts`
 * 的 `VENDOR_INFO`（第 40–197 行）。每条 `baseUrl` / `label` / `group` 都**逐字符**
 * 与那里一致，并在注释里标了 `model.ts:<行号>` 作为可复核的出处。
 *
 * 与参考项目的**两处有意差异**（都不是发明，是任务规格明确要求的）：
 *   1. `custom` 的 group 在参考项目里是 `aggregator`（model.ts:174-178），
 *      在本目录里是 `custom`（= 设置页的「自定义接入」分组）；
 *   2. 参考项目里 3 个 `threed-*`（模型 3D，model.ts:179-196）**不进目录**——
 *      PixMart 只做 2D 生图。因此 23 - 3 = **20 条**。
 *
 * ## 纪律
 *
 *   - **不列默认模型**：目录不带 `models`，新增后走设置页既有的「拉取模型」流程；
 *   - `imageCapable` **只在有据可依时为 true**。判据只有两类，`note` 里必须写明属于哪一类：
 *       (a) **参考项目注释明写**该端点有生图/改图能力；
 *       (b) **本插件的内置能力表覆盖**该家族的图像模型（`src/sizes.ts` 的
 *           gpt-image / DALL·E 3 / Gemini 图像系），或**本插件真的实测过**这条直连端点。
 *     ⚠️ 注意 (b) 的第二半句：**只有真的调用过那条直连端点才能写"已实测"**。
 *     `openai` / `google` 属于 (b) 的前半句（内置能力表有、直连未实测），
 *     `ofox` / `agnes` 才是真被测过（contract-notes §7.4.1 / §25 / §29）。
 *     其余一律 `false` + `note` 写明「生图能力未取证」——**保守标注，不是断言它不能**；
 *   - 本文件是纯数据 + 纯函数：不读盘、不写盘、不发网络、不 import 任何运行时模块
 *     （只有 `import type`），因此 `test/catalog.test.mjs` 可以零副作用地钉住它。
 */
import type { Dialect, ProviderConfig } from './config.js'

/** 目录分组：official→「官方 API 接入」/ aggregator→「聚合接入」/ custom→「自定义接入」。 */
export type CatalogGroup = 'official' | 'aggregator' | 'custom'

export interface CatalogEntry {
  /** 厂商 id，如 'bailian'；新增后就是 `ProviderConfig.id`。 */
  readonly id: string
  /** 显示名，如 '阿里云百炼'。 */
  readonly label: string
  /** 厂商默认接入地址；`custom` 是空串（由用户自填）。 */
  readonly baseUrl: string
  readonly group: CatalogGroup
  /** 省略 = 'standard'；ofox 用 'ofox'、agnes 用 'agnes'。 */
  readonly dialect?: Dialect
  /** 是否**已取证**能出图（见文件头纪律）。 */
  readonly imageCapable: boolean
  /** 一句话说明；未取证生图能力的必须写明「生图能力未取证」。 */
  readonly note: string
}

/**
 * 20 家可直接添加的厂商。顺序 = 参考项目 `VENDOR_INFO` 的声明顺序（3D 已剔除）。
 *
 * 新增厂商进这份清单时**同步**加 `applyFactoryPresets` 的出厂预设（`src/config.ts`）
 * 是本仓库的另一条路径；两者互不影响：目录是"用户主动添加"，出厂预设是"默认就有"。
 */
export const PROVIDER_CATALOG: readonly CatalogEntry[] = [
  // ── 官方厂商：直接使用各家官方 API 接入 ─────────────────────────────────────
  {
    id: 'openai', // model.ts:42-46
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    group: 'official',
    imageCapable: true,
    note: '内置能力表覆盖 gpt-image / DALL·E 3（src/sizes.ts）；**这条直连端点本插件未实测**（实测过的是聚合路径 ofox）',
  },
  {
    id: 'anthropic', // model.ts:47-51
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    group: 'official',
    imageCapable: false,
    note: 'Anthropic 原生 Messages API；生图能力未取证（参考项目 PROTOCOL_INFO:25 注明该协议不支持图片生成）',
  },
  {
    id: 'google', // model.ts:52-56
    label: 'Google AI',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    group: 'official',
    imageCapable: true,
    note: 'Gemini 经 Google 官方 OpenAI 兼容端点；内置能力表覆盖 Gemini 图像系（src/sizes.ts 的 10 种比例），**这条直连端点本插件未实测**',
  },
  // ── 聚合厂商：通过中转站统一接入多模型 ──────────────────────────────────────
  {
    id: 'openrouter', // model.ts:58-62
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    group: 'aggregator',
    imageCapable: false,
    note: 'OpenRouter 聚合中转（OpenAI 兼容 /v1）；生图能力未取证',
  },
  {
    id: 'aihubmix', // model.ts:66-70
    label: 'AIHubMix',
    baseUrl: 'https://aihubmix.com/v1',
    group: 'aggregator',
    imageCapable: true,
    note: '参考项目注释（model.ts:63-65）：图片生成/编辑走 /v1/images/generations + /v1/images/edits，支持 model=auto 智能路由',
  },
  {
    id: 'siliconflow', // model.ts:74-78
    label: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    group: 'aggregator',
    imageCapable: true,
    note: '参考项目注释（model.ts:71-73）：图片生成走 /v1/images/generations（参数用 image_size 像素值）',
  },
  {
    id: 'volcengine', // model.ts:83-87
    label: '火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    group: 'official',
    imageCapable: true,
    note: '参考项目注释（model.ts:79-82）：图片生成走 /api/v3/images/generations（Seedream 系列）',
  },
  {
    id: 'bailian', // model.ts:91-95
    label: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    group: 'official',
    imageCapable: true,
    note: '参考项目注释（model.ts:88-90）：图片生成（qwen-image/wan 系列）走 DashScope 原生接口 /api/v1/services/aigc/multimodal-generation/generation',
  },
  {
    id: 'tencent', // model.ts:97-101
    label: '腾讯云',
    baseUrl: 'https://tokenhub.tencentmaas.com/v1',
    group: 'official',
    imageCapable: false,
    note: '腾讯云 TokenHub（OpenAI 兼容）；生图能力未取证',
  },
  {
    id: 'mimo', // model.ts:105-109
    label: '小米 MiMo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    group: 'official',
    imageCapable: false,
    note: '小米 MiMo（OpenAI + Anthropic 双协议；mimo-v2.5 支持图像理解）；生图能力未取证',
  },
  {
    id: 'kimi', // model.ts:113-117
    label: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    group: 'official',
    imageCapable: false,
    note: 'Kimi（kimi-k3/k2.6/k2.7-code 支持视觉理解）；生图能力未取证',
  },
  {
    id: 'minimax', // model.ts:121-125
    label: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    group: 'official',
    imageCapable: true,
    note: '参考项目注释（model.ts:118-120）：图片生成 image-01 走 /v1/image_generation（aspect_ratio）；本插件未实测',
  },
  {
    id: 'zhipu', // model.ts:129-133
    label: '智谱 AI',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    group: 'official',
    imageCapable: false,
    note: '智谱 AI / BigModel（GLM 系列走 chat，支持图像理解）；生图能力未取证',
  },
  {
    id: 'deepseek', // model.ts:137-141
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    group: 'official',
    imageCapable: false,
    note: 'DeepSeek（文本 + 实验性图像理解）；生图能力未取证',
  },
  {
    id: 'agnes', // model.ts:142-146
    label: 'Agnes AI',
    baseUrl: 'https://api.agnes-ai.cn/v1',
    group: 'official',
    dialect: 'agnes',
    imageCapable: true,
    note: 'PixMart 出厂预设之一，已实测出图；尺寸走「档位 + 比例」，response_format 与参考图必须嵌在 extra_body 内',
  },
  {
    id: 'ofox', // model.ts:147-151
    label: 'Ofox',
    baseUrl: 'https://api.ofox.io/v1',
    group: 'aggregator',
    dialect: 'ofox',
    imageCapable: true,
    note: 'PixMart 出厂预设之一，已实测出图；Gemini 图像模型有 gemini-native 原生路径',
  },
  {
    id: 'sharellm', // model.ts:154-158
    label: 'ShareLLM',
    baseUrl: 'https://sharellm.cn/v1',
    group: 'aggregator',
    imageCapable: false,
    note: 'ShareLLM 共享模型（OpenAI 兼容端点，需创建密钥并充值）；生图能力未取证',
  },
  {
    id: 'sharellm-intl', // model.ts:161-165
    label: 'ShareLLM 国际',
    baseUrl: 'https://sharellm.net/v1',
    group: 'aggregator',
    imageCapable: false,
    note: 'ShareLLM 国际站（同一平台国际版端点，与国内站密钥不通用）；生图能力未取证',
  },
  {
    id: 'sensenova', // model.ts:169-173
    label: '商汤 SenseNova',
    baseUrl: 'https://token.sensenova.cn/v1',
    group: 'official',
    imageCapable: true,
    note: '参考项目注释（model.ts:166-168）：chat/多模态/生图路由均实测存在（models、chat/completions、images/generations；401=需有效 Key）',
  },
  {
    id: 'custom', // model.ts:174-178（参考项目 group 为 aggregator，本目录按规格改为 custom）
    label: '自定义',
    baseUrl: '',
    group: 'custom',
    imageCapable: false,
    note: '自定义接入：baseUrl 由用户自填（目录里是空串）；生图能力未取证',
  },
]

/** 按 id 取目录条目；没有则 `undefined`（路由据此回 400 `unknown_catalog_id`）。 */
export function findCatalogEntry(id: string): CatalogEntry | undefined {
  const wanted = id.trim()
  return PROVIDER_CATALOG.find((entry) => entry.id === wanted)
}

/**
 * 目录条目 + `added`（当前配置里是否已有这个 id）——`GET /providers` 与
 * `pixmart_providers` 工具共用的**只读**视图。字段就是规格里那 7 个。
 */
export interface CatalogEntryView {
  readonly id: string
  readonly label: string
  readonly baseUrl: string
  readonly group: CatalogGroup
  readonly imageCapable: boolean
  readonly note: string
  readonly added: boolean
}

/**
 * 组装目录视图。
 * @param presentIds - 当前配置里的厂商 id（顺序无关；重复也无害）。
 */
export function catalogView(presentIds: readonly string[]): readonly CatalogEntryView[] {
  const present = new Set(presentIds)
  return PROVIDER_CATALOG.map((entry) => ({
    id: entry.id,
    label: entry.label,
    baseUrl: entry.baseUrl,
    group: entry.group,
    imageCapable: entry.imageCapable,
    note: entry.note,
    added: present.has(entry.id),
  }))
}

/**
 * 用目录条目造一个**可直接落盘**的 `ProviderConfig`（`POST /providers` 的 payload）。
 *
 * 三条刻意的取值：
 *   1. `models` / `allowedSizes` **留空**——不把任何厂商的模型名或尺寸表抄进目录，
 *      用户走设置页既有的「拉取模型」流程；尺寸由 `sizes.ts` 的内置能力表兜底；
 *   2. `apiMode: 'images-generations'` + `dialect: entry.dialect ?? 'standard'`：
 *      本插件只做生图，这一组是最通用的起点（用户仍可在设置页改）；
 *   3. `apiKey` / `apiKeyEnv` 都是空串 = "尚未配置"，绝不预填任何密钥或环境变量名。
 */
export function providerFromCatalog(entry: CatalogEntry): ProviderConfig {
  return {
    id: entry.id,
    label: entry.label,
    group: entry.group,
    baseUrl: entry.baseUrl,
    geminiNativeBaseUrl: '',
    dialect: entry.dialect ?? 'standard',
    apiMode: 'images-generations',
    apiKeyEnv: '',
    apiKey: '',
    models: [],
    allowedSizes: [],
    sizeMode: 'whitelist',
    extraHeaders: {},
    timeoutMs: 180_000,
  }
}
