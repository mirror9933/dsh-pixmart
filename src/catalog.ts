/**
 * 厂商目录（Provider catalog）—— 设置页「添加模型提供商」的**数据源**。
 *
 * ## 出处（**只读转录，绝不修改参考项目**）
 *
 * 各条 `baseUrl` / `label` / `group` 逐字符转录自参考项目
 * `E:\Programs\trae\project\pixmart-ai\src\renderer\src\types\model.ts`
 * 的 `VENDOR_INFO`（第 40–197 行），每条注释里标了 `model.ts:<行号>` 作为可复核的出处。
 *
 * ## 当前条数：**14 条**（13 家具名厂商 + `custom`）
 *
 * 用户决定只保留 13 家具名供应商，本文件据此**删掉 6 条**：`mimo`、`kimi`、`minimax`、
 * `zhipu`、`deepseek`、`sharellm`（注意 **`sharellm-intl` 保留**）。删除处有就地注释。
 * 参考项目那 3 个 `threed-*`（3D，model.ts:179-196）同样**不进目录**——PixMart 只做 2D 生图。
 * 所以参考项目的 23 条 = 13（保留）+ 6（本次删）+ 3（3D）+ 1（`custom` 保留）= 23。
 *
 * **目录变小 ≠ 删配置**：用户配置里若已经有被删掉的厂商，本文件/路由都不会去动它，
 * 只是它不再出现在「添加模型提供商」的候选清单里（`catalogView` 只反映目录）。
 *
 * 与参考项目的**一处有意差异**：`custom` 的 group 在参考项目里是 `aggregator`
 * （model.ts:174-178），在本目录里是 `custom`（= 设置页的「自定义接入」分组）。
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
 *   - 本文件是纯数据 + 纯函数：不读盘、不写盘、不发网络。
 *     唯一的运行时 import 是 `sizes.ts` 的 `DEFAULT_IMAGE_RATIOS`（统一的默认尺寸词表，
 *     一份清单，绝不在这里复制第二份），`sizes.ts` 对 `config.ts` 只有 `import type`，
 *     所以没有环、也没有副作用；`test/catalog.test.mjs` 仍可零副作用地钉住它。
 */
import { DEFAULT_IMAGE_RATIOS } from './sizes.js'
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
 * 14 家可直接添加的厂商（13 具名 + `custom`）。顺序 = 参考项目 `VENDOR_INFO` 的声明顺序
 * （3D 与本次删掉的 6 条已剔除），所以"同名的两家谁的注释来自哪一行"一眼可查。
 *
 * 出厂预设（`defaultConfig().providers`）当前是**空数组**，与这份目录是两条独立路径：
 * 目录 = "用户主动添加"，出厂预设 = "默认就有"。往这里加条目不等于出厂就带那家。
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
  // ── 以下 6 家按用户要求**不再进目录**（2026-10 变更，逐条对应参考项目
  //    model.ts:105-109 / 113-117 / 121-125 / 129-133 / 137-141 / 154-158）：
  //      mimo（小米 MiMo）、kimi（Kimi）、minimax（MiniMax）、zhipu（智谱 AI）、
  //      deepseek（DeepSeek）、sharellm（ShareLLM，**国内站**；国际站 sharellm-intl 保留）。
  //    它们仍在参考项目的 VENDOR_INFO 里，只是 PixMart 的「添加模型提供商」不再列出。
  //    **用户配置里若已有它们，一个字节都不动**（目录变小 ≠ 删配置）。
  //    将来要恢复某家：把那条按 `model.ts:<行号>` 重新转录回这里即可。
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
    id: 'sharellm-intl', // model.ts:161-165（保留：同平台的国际站端点）
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
 *   1. `models` **留空**——不把任何厂商的模型名抄进目录，用户走设置页既有的
 *      「拉取模型」流程；`allowedSizes` 填**统一的默认词表**
 *      （`sizes.ts` 的 `DEFAULT_IMAGE_RATIOS`，10 个比例；临时统一，见那里的注释），
 *      不再留 `[]`——否则读配置的人会以为"这家没配尺寸"；
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
    allowedSizes: DEFAULT_IMAGE_RATIOS,
    sizeMode: 'whitelist',
    extraHeaders: {},
    timeoutMs: 180_000,
  }
}

/**
 * `providerFromCustom` 的输入 —— 设置页 add-card「自定义厂商」tab 里用户填的三样东西。
 * 取值校验（id 形状 / label 长度 / baseUrl 形状）在路由层做，这里只负责拼装。
 */
export interface CustomProviderInput {
  /** 用户填的厂商 id（路由已按 `^[a-z0-9][a-z0-9-]{0,31}$` 校验过）。 */
  readonly id: string
  /** 显示名（路由已去空白并校验非空 / ≤ 40 字符）。 */
  readonly label: string
  /** 接入地址（路由已去空白并校验非空 http(s)）。 */
  readonly baseUrl: string
  /** 网页这次显式填的密钥；省略或空串 = 本次不带密钥。 */
  readonly apiKey?: string
}

/**
 * 用「自定义厂商」的三个字段造一个**可直接落盘**的 `ProviderConfig`。
 *
 * 与 `providerFromCatalog` 的差别**只有身份字段的来源**（用户填 vs 目录转录）：
 * 分组固定 `custom`、方言固定 `standard`、`models` 留空、`allowedSizes` 填统一的默认
 * 词表（`sizes.ts` 的 `DEFAULT_IMAGE_RATIOS`，与目录新增同一个值）、
 * `geminiNativeBaseUrl` 空串、`timeoutMs` 默认值——这样"自定义接入"和
 * "目录里 custom 那条"落盘后是同一个形状，后续路由/工具不需要区分来源。
 *
 * `apiKeyEnv` **一律空串**：网页显式填的密钥是唯一来源，不指向任何环境变量
 * （与 `POST /providers/<id>/credentials` 的既有语义一致）。
 */
export function providerFromCustom(input: CustomProviderInput): ProviderConfig {
  return {
    id: input.id,
    label: input.label,
    group: 'custom',
    baseUrl: input.baseUrl,
    geminiNativeBaseUrl: '',
    dialect: 'standard',
    apiMode: 'images-generations',
    apiKeyEnv: '',
    apiKey: input.apiKey ?? '',
    models: [],
    allowedSizes: DEFAULT_IMAGE_RATIOS,
    sizeMode: 'whitelist',
    extraHeaders: {},
    timeoutMs: 180_000,
  }
}
