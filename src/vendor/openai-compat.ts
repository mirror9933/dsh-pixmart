/**
 * 厂商适配器 —— 只有 OpenAI 兼容端点 + Ofox 的 Gemini 原生端点（技术方案 §7.4 / §7.4.1）。
 *
 * 四条硬规则，全部来自 P0 取证：
 *   1. **方言只改字段名，不改路径**：`ofox` 方言用 `input_images` + `output_format`；
 *      标准语义用 `image` + `response_format`。字段写错会被服务端**静默忽略**，
 *      因此由配置决定，绝不靠内容嗅探。
 *   2. **鉴权按 apiMode 分叉**：兼容路径 `Authorization: Bearer`；
 *      `gemini-native` 用 `x-goog-api-key`。
 *   3. **降级链**逐级去掉可能不兼容的参数，并把去掉的东西记进 `degraded`——
 *      "成功但没按预期保真"必须留痕，不能悄悄降级。
 *   4. **安全类错误不重试也不降级**：重试只会重复被拒。
 *   5. **余额不足（402 / `insufficient_credits`）同样是终态**：它有独立错误码，
 *      既不重试也**不降级**——降级链的每一档都会真实计费，余额为负时刷 5 档
 *      等于再被拒 5 次（contract-notes §18）。
 */
import type { ApiMode, Dialect, ProviderConfig } from '../config.js'
import type { AbortSignalLike } from '../host-types.js'
import { pixelToRatio } from '../sizes.js'

export interface VendorReference {
  readonly data: Uint8Array
  readonly name: string
  readonly mediaType: string
}

export interface VendorRequest {
  readonly provider: ProviderConfig
  readonly apiKey: string
  readonly model: string
  readonly prompt: string
  readonly negative?: string
  /** 已由 `checkSize` 归一化到该 apiMode 需要的格式。 */
  readonly size?: string
  readonly n: number
  readonly seed?: number
  readonly references: readonly VendorReference[]
  readonly signal?: AbortSignalLike
  readonly maxRetries: number
  /** 显式指定调用形态；省略时走模型路由表。 */
  readonly apiMode?: ApiMode
}

export interface VendorImage {
  readonly data: Uint8Array
  readonly mediaType: string
}

export interface VendorError {
  readonly code:
    | 'auth'
    /**
     * **账户余额不足**（HTTP 402 / 显式的 `insufficient_credits`）。
     *
     * 必须与 `bad_request` 分开：`bad_request` 的语义是"这次请求的参数写错了"，
     * 处理方式是**降级到下一档重发**；而余额不足是账户状态问题，降级只会把同一个
     * 请求再花一次钱并再被拒一次（见 contract-notes §18 的实测事件）。
     */
    | 'insufficient_credits'
    | 'rate_limit'
    | 'server'
    | 'moderation'
    | 'bad_request'
    | 'bad_response'
    | 'network'
    | 'timeout'
    | 'aborted'
    | 'config'
  readonly message: string
  readonly retryable: boolean
  readonly status?: number
}

/** 降级维度：出现即表示该参数被去掉了。 */
export type DegradedFlag = 'size' | 'quality' | 'output_format' | 'references'

export interface VendorSuccess {
  readonly ok: true
  readonly apiMode: ApiMode
  readonly planReason: string
  readonly images: readonly VendorImage[]
  readonly degraded: readonly DegradedFlag[]
  readonly attempts: number
  readonly ms: number
  readonly raw?: unknown
}

export interface VendorFailure {
  readonly ok: false
  readonly apiMode: ApiMode
  readonly planReason: string
  readonly error: VendorError
  readonly degraded: readonly DegradedFlag[]
  readonly attempts: number
  readonly ms: number
}

export type VendorResult = VendorSuccess | VendorFailure

// ─────────────────────────────────────────────────────────── 路由表

const GEMINI_IMAGE = /gemini.*image|imagen|nano[- ]?banana/i
const GPT_IMAGE = /gpt-image/i

/**
 * 决定调用形态。配置里的 `apiMode` 是**默认形态**；只有能明确识别模型族时才覆盖它。
 * @returns 形态与判定理由（理由会回传给工具，便于排查"为什么走了这条路"）。
 */
export function resolvePlan(input: {
  readonly model: string
  readonly hasReferences: boolean
  readonly provider: ProviderConfig
}): { readonly apiMode: ApiMode; readonly reason: string } {
  const { model, hasReferences, provider } = input

  if (
    GEMINI_IMAGE.test(model) &&
    provider.dialect === 'ofox' &&
    provider.geminiNativeBaseUrl.trim() !== ''
  ) {
    return {
      apiMode: 'gemini-native',
      reason: 'Gemini 图像模型在 Ofox 上的参考图/编辑只在 Gemini 原生端点可用',
    }
  }

  if (GPT_IMAGE.test(model) && hasReferences && provider.baseUrl.trim() !== '') {
    return { apiMode: 'images-edits', reason: 'gpt-image 系列带参考图时走 /images/edits' }
  }

  return { apiMode: provider.apiMode, reason: '使用厂商配置的默认调用形态' }
}

// ─────────────────────────────────────────────────────────── 字节工具

/** 按魔数识别图片类型，识别不出返回 undefined。 */
export function sniffImageMediaType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8) {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    if (png.every((byte, index) => bytes[index] === byte)) return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif'
  }
  return undefined
}

function decodeBase64(data: string): Uint8Array {
  return Buffer.from(data, 'base64')
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function toDataUri(reference: VendorReference): string {
  return `data:${reference.mediaType};base64,${encodeBase64(reference.data)}`
}

/** 从 data URI 或 http(s) URL 取图片字节。 */
async function bytesFromUrl(
  url: string,
  signal: AbortSignalLike | undefined,
): Promise<VendorImage> {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',')
    const header = url.slice(5, comma)
    const mediaType = header.split(';')[0] ?? 'image/png'
    return { data: decodeBase64(url.slice(comma + 1)), mediaType }
  }

  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`下载厂商产物失败：HTTP ${response.status}`)
  const buffer = await response.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const declared = response.headers.get('content-type')?.split(';')[0]?.trim()
  const sniffed = sniffImageMediaType(bytes)
  const mediaType = sniffed ?? declared ?? 'image/png'
  return { data: bytes, mediaType }
}

// ─────────────────────────────────────────────────────────── 降级链

interface Variant {
  readonly label: string
  readonly includeSize: boolean
  readonly includeQuality: boolean
  readonly includeFormat: boolean
  readonly includeReferences: boolean
}

function variantChain(
  apiMode: ApiMode,
  hasReferences: boolean,
  dialect: Dialect,
): readonly Variant[] {
  if (apiMode === 'gemini-native') {
    return [
      { label: 'native:full', includeSize: true, includeQuality: false, includeFormat: false, includeReferences: true },
      { label: 'native:no-aspect', includeSize: false, includeQuality: false, includeFormat: false, includeReferences: true },
    ]
  }

  if (apiMode === 'images-edits') {
    return [
      { label: 'edits:full', includeSize: true, includeQuality: true, includeFormat: true, includeReferences: true },
      { label: 'edits:no-quality', includeSize: true, includeQuality: false, includeFormat: true, includeReferences: true },
      { label: 'edits:no-size', includeSize: false, includeQuality: false, includeFormat: true, includeReferences: true },
    ]
  }

  const raw: Variant[] = [
    { label: 'full', includeSize: true, includeQuality: true, includeFormat: true, includeReferences: hasReferences },
    { label: 'no-quality', includeSize: true, includeQuality: false, includeFormat: true, includeReferences: hasReferences },
    { label: 'no-format', includeSize: true, includeQuality: false, includeFormat: false, includeReferences: hasReferences },
    { label: 'no-references', includeSize: true, includeQuality: false, includeFormat: false, includeReferences: false },
    { label: 'text-only', includeSize: false, includeQuality: false, includeFormat: false, includeReferences: false },
  ]

  // chat-image 不使用 quality / response_format；agnes **额外**不使用 quality 且
  // **不能去掉 size**（官方文档把 size 标为必填，去掉它只是白花一次请求的钱）。
  const seen = new Set<string>()
  return raw.filter((variant) => {
    if (dialect === 'agnes' && (variant.includeQuality || !variant.includeSize)) return false
    const signature =
      apiMode === 'chat-image'
        ? `${variant.includeSize}|${variant.includeReferences}`
        : `${variant.includeSize}|${variant.includeQuality}|${variant.includeFormat}|${variant.includeReferences}`
    if (seen.has(signature)) return false
    seen.add(signature)
    return true
  })
}

/** 相邻两档之间被去掉的参数。 */
function droppedFlags(from: Variant, to: Variant): DegradedFlag[] {
  const dropped: DegradedFlag[] = []
  if (from.includeSize && !to.includeSize) dropped.push('size')
  if (from.includeQuality && !to.includeQuality) dropped.push('quality')
  if (from.includeFormat && !to.includeFormat) dropped.push('output_format')
  if (from.includeReferences && !to.includeReferences) dropped.push('references')
  return dropped
}

// ─────────────────────────────────────────────────────────── 请求构造

interface DialectFields {
  readonly references: string
  readonly format: string
  readonly formatValue: string
}

function dialectFields(dialect: Dialect): DialectFields {
  if (dialect === 'ofox') return { references: 'input_images', format: 'output_format', formatValue: 'png' }
  // agnes 由 `buildRequest` 单独分叉（字段嵌在 extra_body 内），这两个值不会被用到，
  // 但保持与官方文档一致的语义，避免被误读成"顶层 response_format"。
  if (dialect === 'agnes') return { references: 'extra_body.image', format: 'extra_body.response_format', formatValue: 'url' }
  return { references: 'image', format: 'response_format', formatValue: 'b64_json' }
}

/**
 * Agnes 的 32 个**官方精确尺寸**（8 比例 × 4 档位），用于把像素输入反解成档位。
 *
 * 出处：官方文档「Output Dimension Reference」（agnes-image-2.5-flash 页；
 * 2.1-flash 同表，2.5 明言"request 与 size 与 2.1 完全一致"）。
 * 有了它，用户/Agent 说 `2048x2048` 才能真的拿到 2K（此前一律回落 1K）。
 */
const AGNES_SIZE_TABLE: readonly (readonly [string, string])[] = [
  ['1024x1024', '1K'], ['2048x2048', '2K'], ['3072x3072', '3K'], ['4096x4096', '4K'],
  ['864x1152', '1K'], ['1728x2304', '2K'], ['2592x3456', '3K'], ['3456x4608', '4K'],
  ['1152x864', '1K'], ['2304x1728', '2K'], ['3456x2592', '3K'], ['4608x3456', '4K'],
  ['1312x736', '1K'], ['2624x1472', '2K'], ['3936x2208', '3K'], ['5248x2944', '4K'],
  ['736x1312', '1K'], ['1472x2624', '2K'], ['2208x3936', '3K'], ['2944x5248', '4K'],
  ['832x1248', '1K'], ['1664x2496', '2K'], ['2496x3744', '3K'], ['3328x4992', '4K'],
  ['1248x832', '1K'], ['2496x1664', '2K'], ['3744x2496', '3K'], ['4992x3328', '4K'],
  ['1568x672', '1K'], ['3136x1344', '2K'], ['4704x2016', '3K'], ['6272x2688', '4K'],
]

function agnesSizeTier(size: string): string {
  const tier = /^\s*([1-4])K\s*$/i.exec(size)
  if (tier !== null) return `${tier[1]}K`

  const trimmed = size.trim()
  for (const entry of AGNES_SIZE_TABLE) {
    if (entry[0] === trimmed) return entry[1]
  }

  // 表外像素：按**最长边**就近归档位。官方原文："If you request an unsupported exact
  // size … the service may map it to the nearest supported tier and aspect ratio."
  const pixel = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(trimmed)
  if (pixel !== null) {
    const longest = Math.max(Number(pixel[1]), Number(pixel[2]))
    if (longest <= 1024) return '1K'
    if (longest <= 2048) return '2K'
    if (longest <= 3072) return '3K'
    return '4K'
  }

  return '1K'
}

/** Agnes 支持的 8 种比例；不在表内时退回 `1:1`（官方文档：默认 `1:1`）。 */
const AGNES_RATIOS: readonly string[] = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9']

/** 把归一化后的尺寸（比例或像素）转成 Agnes 的 `ratio` 取值。 */
function agnesRatio(size: string): string {
  const trimmed = size.trim()
  if (AGNES_RATIOS.includes(trimmed)) return trimmed

  const pixel = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(trimmed)
  if (pixel !== null) {
    const ratio = pixelToRatio(`${pixel[1]}x${pixel[2]}`)
    if (ratio !== undefined && AGNES_RATIOS.includes(ratio)) return ratio
  }

  return '1:1'
}

interface PreparedRequest {
  readonly url: string
  readonly headers: Record<string, string>
  readonly init: { method: string; headers: Record<string, string>; body: unknown; signal?: unknown }
}

function endpoint(provider: ProviderConfig, apiMode: ApiMode, model: string): string {
  const base = provider.baseUrl.replace(/[\\/]+$/, '')
  if (apiMode === 'gemini-native') {
    const native = provider.geminiNativeBaseUrl.replace(/[\\/]+$/, '')
    return `${native}/models/${encodeURIComponent(model)}:generateContent`
  }
  if (apiMode === 'images-edits') return `${base}/images/edits`
  if (apiMode === 'chat-image') return `${base}/chat/completions`
  return `${base}/images/generations`
}

function buildRequest(
  request: VendorRequest,
  apiMode: ApiMode,
  variant: Variant,
): PreparedRequest {
  const { provider, model, prompt, n } = request
  const fields = dialectFields(provider.dialect)
  const url = endpoint(provider, apiMode, model)
  const references = variant.includeReferences ? request.references : []

  const headers: Record<string, string> = { ...provider.extraHeaders }
  if (apiMode === 'gemini-native') headers['x-goog-api-key'] = request.apiKey
  else headers['Authorization'] = `Bearer ${request.apiKey}`

  if (apiMode === 'gemini-native') {
    const parts: unknown[] = [{ text: prompt }]
    for (const reference of references) {
      parts.push({ inlineData: { mimeType: reference.mediaType, data: encodeBase64(reference.data) } })
    }
    // `responseModalities` 是**必需**的，不是可选装饰：
    // 实测（tools/probe-aspect.mjs，2026-10-05）缺它时端点会**整体忽略 generationConfig**，
    // 输出回落到模型默认比例（1408x768），`aspectRatio` 形同虚设；
    // 带上它之后 1:1 / 3:4 / 16:9 才真正生效。
    const generationConfig: Record<string, unknown> = { responseModalities: ['TEXT', 'IMAGE'] }
    if (variant.includeSize && request.size !== undefined) {
      generationConfig.imageConfig = { aspectRatio: request.size }
    }
    const body: Record<string, unknown> = { contents: [{ parts }], generationConfig }
    headers['Content-Type'] = 'application/json'
    return { url, headers, init: { method: 'POST', headers, body: JSON.stringify(body), signal: request.signal } }
  }

  if (apiMode === 'images-edits') {
    const form = new FormData()
    form.append('model', model)
    form.append('prompt', prompt)
    form.append('n', String(n))
    if (variant.includeSize && request.size !== undefined) form.append('size', request.size)
    if (variant.includeQuality) form.append('quality', 'high')
    if (variant.includeFormat) form.append(fields.format, fields.formatValue)
    for (const reference of references) {
      form.append('image', new Blob([reference.data], { type: reference.mediaType }), reference.name)
    }
    // multipart 的 Content-Type 必须由 fetch 自行带上 boundary，这里不设置。
    return { url, headers, init: { method: 'POST', headers, body: form, signal: request.signal } }
  }

  if (apiMode === 'chat-image') {
    const content: unknown[] = [{ type: 'text', text: prompt }]
    for (const reference of references) {
      content.push({ type: 'image_url', image_url: { url: toDataUri(reference) } })
    }
    const body: Record<string, unknown> = {
      model,
      modalities: ['image', 'text'],
      messages: [{ role: 'user', content }],
    }
    if (variant.includeSize && request.size !== undefined) body.size = request.size
    headers['Content-Type'] = 'application/json'
    return { url, headers, init: { method: 'POST', headers, body: JSON.stringify(body), signal: request.signal } }
  }

  // Agnes：请求体形状与 standard 差三处，任一处写错都不是"降级"而是失败——
  //   1. `response_format` 必须嵌在 `extra_body` 内（官方明文：放顶层会报错）；
  //   2. 参考图必须在 `extra_body.image` 里（顶层 `image` 会不被采用）；
  //   3. 尺寸是「档位 + 比例」：`size: '1K'` + `ratio: '3:4'`，不是 `1024x768` 那种像素。
  // 另外**不发 `n`**：官方请求参数表里没有它（发了可能被拒或影响请求形状），
  // 多张输出靠多次调用（与 `pixmart_generate` 的 n 语义一致）。
  // size 缺失由 `generateImages` 的前置检查挡下（返回结构化 config 错误），到这里必然有值。
  if (provider.dialect === 'agnes') {
    const body: Record<string, unknown> = { model, prompt }
    const extraBody: Record<string, unknown> = {}
    if (variant.includeSize && request.size !== undefined) {
      body.size = agnesSizeTier(request.size)
      body.ratio = agnesRatio(request.size)
    }
    if (references.length > 0) extraBody.image = references.map(toDataUri)
    if (variant.includeFormat) extraBody.response_format = fields.formatValue
    if (Object.keys(extraBody).length > 0) body.extra_body = extraBody
    if (request.seed !== undefined) body.seed = request.seed
    headers['Content-Type'] = 'application/json'
    return { url, headers, init: { method: 'POST', headers, body: JSON.stringify(body), signal: request.signal } }
  }

  const body: Record<string, unknown> = { model, prompt, n }
  if (variant.includeSize && request.size !== undefined) body.size = request.size
  if (variant.includeQuality) body.quality = 'high'
  if (variant.includeFormat) body[fields.format] = fields.formatValue
  if (references.length > 0) body[fields.references] = references.map(toDataUri)
  if (request.seed !== undefined) body.seed = request.seed
  headers['Content-Type'] = 'application/json'
  return { url, headers, init: { method: 'POST', headers, body: JSON.stringify(body), signal: request.signal } }
}

// ─────────────────────────────────────────────────────────── 响应解析

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 从响应 JSON 中提取图片条目（data URI / b64 / 远程 URL）。 */
function extractImageHandles(
  apiMode: ApiMode,
  payload: unknown,
): { inline: { data: string; mediaType?: string }[]; remote: string[] } {
  const inline: { data: string; mediaType?: string }[] = []
  const remote: string[] = []
  const root = asRecord(payload)
  if (root === undefined) return { inline, remote }

  if (apiMode === 'gemini-native') {
    for (const candidate of asArray(root.candidates)) {
      const parts = asArray(asRecord(asRecord(candidate)?.content)?.parts)
      for (const part of parts) {
        const inlineData = asRecord(asRecord(part)?.inlineData)
        const data = inlineData?.data
        if (typeof data === 'string' && data !== '') {
          const mimeType = inlineData?.mimeType
          inline.push({ data, ...(typeof mimeType === 'string' ? { mediaType: mimeType } : {}) })
        }
      }
    }
    return { inline, remote }
  }

  if (apiMode === 'chat-image') {
    for (const choice of asArray(root.choices)) {
      const content = asRecord(choice)?.message
      const parts = asArray(asRecord(content)?.content)
      for (const part of parts) {
        const imageUrl = asRecord(asRecord(part)?.image_url)?.url
        if (typeof imageUrl === 'string' && imageUrl !== '') {
          if (imageUrl.startsWith('data:')) {
            const comma = imageUrl.indexOf(',')
            inline.push({ data: imageUrl.slice(comma + 1), mediaType: imageUrl.slice(5, comma).split(';')[0] })
          } else {
            remote.push(imageUrl)
          }
        }
      }
    }
    return { inline, remote }
  }

  for (const item of asArray(root.data)) {
    const record = asRecord(item)
    if (record === undefined) continue
    const b64 = record.b64_json ?? record.b64Json
    if (typeof b64 === 'string' && b64 !== '') {
      inline.push({ data: b64 })
      continue
    }
    const url = record.url
    if (typeof url === 'string' && url !== '') remote.push(url)
  }
  return { inline, remote }
}

// ─────────────────────────────────────────────────────────── 错误分类

const SAFETY_PATTERN =
  /safety|moderation|blocked|blocklist|policy|prohibited|violat|content[_ ]?filter|敏感|违规|审核/i

/**
 * 余额不足的识别特征。
 *
 * 各家网关的说法不统一，所以既认 OpenAI 风格的错误类型 `insufficient_credits`，
 * 也认常见的等义说法（`insufficient quota` / `credit balance` / 中文"余额不足"）。
 * 判定刻意保守：只在 HTTP 层面能确认是"付费被拒"时才用（见 `isInsufficientCredits`），
 * 避免把 5xx 之类的服务端故障误标成账户问题。
 */
const INSUFFICIENT_CREDITS_PATTERN =
  /insufficient[_ ]?(credits?|quota|balance|funds)|credit[_ ]?balance|余额不足|余额不够|额度不足|欠费/i

/** 该响应是否应判定为"账户余额不足"。 */
function isInsufficientCredits(status: number, bodyText: string): boolean {
  // 402 Payment Required 本身就是"要钱"。
  if (status === 402) return true
  // 429 / 5xx 一律按限流或服务端故障处理：它们**不**代表账户余额状态，
  // 且都需要重试而不是让用户去充值。
  if (status === 429 || status >= 500) return false
  return INSUFFICIENT_CREDITS_PATTERN.test(bodyText)
}

function insufficientCreditsError(status: number | undefined, bodyText: string): VendorError {
  const excerpt = bodyText.slice(0, 400)
  return {
    code: 'insufficient_credits',
    retryable: false,
    ...(status === undefined ? {} : { status }),
    // 原始 message **原样保留**：余额数值（如 `Current balance: $-0.138427`）是用户
    // 判断"差多少钱"的唯一依据，截断或改写它都会让排查变难。
    message:
      status === undefined ? `账户余额不足：${excerpt}` : `账户余额不足（HTTP ${status}）：${excerpt}`,
  }
}

function classify(status: number, bodyText: string): VendorError {
  const excerpt = bodyText.slice(0, 400)
  // 先于泛化的 bad_request 判定：402 属于典型 bad_request 区间，一旦漏到这里就会被
  // 当成"参数写错"而去走降级链——那正是要修的行为问题。
  if (isInsufficientCredits(status, bodyText)) return insufficientCreditsError(status, bodyText)
  if (status === 401 || status === 403) {
    return { code: 'auth', retryable: false, status, message: `鉴权失败（HTTP ${status}）：${excerpt}` }
  }
  if (status === 404) {
    return { code: 'config', retryable: false, status, message: `端点或模型不存在（HTTP 404）：${excerpt}` }
  }
  if (status === 429) {
    return { code: 'rate_limit', retryable: true, status, message: `被限流（HTTP 429）：${excerpt}` }
  }
  if (status >= 500) {
    return { code: 'server', retryable: true, status, message: `厂商服务端错误（HTTP ${status}）：${excerpt}` }
  }
  if (SAFETY_PATTERN.test(bodyText)) {
    return { code: 'moderation', retryable: false, status, message: `内容被拒绝：${excerpt}` }
  }
  if (status >= 400) {
    return { code: 'bad_request', retryable: false, status, message: `请求被拒绝（HTTP ${status}）：${excerpt}` }
  }
  return { code: 'bad_response', retryable: false, status, message: `无法解析厂商响应：${excerpt}` }
}

function isAbortError(error: unknown): boolean {
  const name = (error as { name?: string } | undefined)?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

// ─────────────────────────────────────────────────────────── 重试与退避

function sleep(ms: number, signal?: AbortSignalLike): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const handle = setTimeout(() => resolve(), ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(handle)
      reject(new Error('aborted'))
    })
  })
}

function retryAfterMs(headers: { get(name: string): string | null }): number | undefined {
  const raw = headers.get('retry-after')
  if (raw === null) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000)
  return undefined
}

function backoffMs(attempt: number, hint?: number): number {
  if (hint !== undefined) return hint
  const base = 800 * 2 ** Math.max(0, attempt - 1)
  return Math.min(base + Math.floor(Math.random() * 250), 15_000)
}

// ─────────────────────────────────────────────────────────── 单次尝试

interface AttemptOutcome {
  readonly kind: 'success' | 'retryable' | 'fatal'
  readonly images?: readonly VendorImage[]
  readonly raw?: unknown
  readonly error?: VendorError
  readonly retryAfter?: number
}

async function sendOnce(
  request: VendorRequest,
  apiMode: ApiMode,
  variant: Variant,
): Promise<AttemptOutcome> {
  const prepared = buildRequest(request, apiMode, variant)

  let response: PixmartFetchResponse
  try {
    response = await fetch(prepared.url, prepared.init)
  } catch (error) {
    if (isAbortError(error) || request.signal?.aborted === true) {
      return { kind: 'fatal', error: { code: 'aborted', retryable: false, message: '请求已取消' } }
    }
    return {
      kind: 'retryable',
      error: {
        code: 'network',
        retryable: true,
        message: `网络错误：${error instanceof Error ? error.message : String(error)}`,
      },
    }
  }

  const bodyText = await response.text().catch(() => '')

  if (!response.ok) {
    const error = classify(response.status, bodyText)
    // 429 / 5xx 才值得退避重试；4xx 其余一律终止该厂商的尝试。
    return error.retryable
      ? { kind: 'retryable', error, retryAfter: retryAfterMs(response.headers) }
      : { kind: 'fatal', error }
  }

  let payload: unknown
  try {
    payload = bodyText === '' ? undefined : JSON.parse(bodyText)
  } catch {
    return {
      kind: 'fatal',
      error: { code: 'bad_response', retryable: false, message: `响应不是 JSON：${bodyText.slice(0, 200)}` },
    }
  }

  // 有些网关用 200 包一层错误。
  const root = asRecord(payload)
  const innerError = root?.error
  if (innerError !== undefined && asArray(root?.data).length === 0) {
    const text = JSON.stringify(innerError).slice(0, 400)
    // 200 + insufficient_credits 也按余额不足处理（same 语义，只是状态码撒谎）。
    if (INSUFFICIENT_CREDITS_PATTERN.test(text)) {
      return { kind: 'fatal', error: insufficientCreditsError(undefined, text) }
    }
    return SAFETY_PATTERN.test(text)
      ? { kind: 'fatal', error: { code: 'moderation', retryable: false, message: `内容被拒绝：${text}` } }
      : { kind: 'fatal', error: { code: 'bad_response', retryable: false, message: `厂商返回错误：${text}` } }
  }

  const handles = extractImageHandles(apiMode, payload)
  if (handles.inline.length === 0 && handles.remote.length === 0) {
    return {
      kind: 'fatal',
      error: {
        code: 'bad_response',
        retryable: false,
        message: `响应中没有图片：${bodyText.slice(0, 200)}`,
      },
    }
  }

  const images: VendorImage[] = []
  try {
    for (const handle of handles.inline) {
      const data = decodeBase64(handle.data)
      images.push({ data, mediaType: sniffImageMediaType(data) ?? handle.mediaType ?? 'image/png' })
    }
    // url 模式的链接是短期签名，必须立刻下载。
    for (const remote of handles.remote) {
      images.push(await bytesFromUrl(remote, request.signal))
    }
  } catch (error) {
    return {
      kind: 'retryable',
      error: {
        code: 'bad_response',
        retryable: true,
        message: `取回产物字节失败：${error instanceof Error ? error.message : String(error)}`,
      },
    }
  }

  const empty = images.find((image) => image.data.length === 0)
  if (empty !== undefined || images.length === 0) {
    return {
      kind: 'retryable',
      error: { code: 'bad_response', retryable: true, message: '厂商返回了空图片字节' },
    }
  }

  return { kind: 'success', images, raw: payload }
}

// ─────────────────────────────────────────────────────────── 主入口

/**
 * 发起一次生图/编辑请求，内置降级链与重试。
 * @param request - 已解析密钥与归一化尺寸的请求。
 */
export async function generateImages(request: VendorRequest): Promise<VendorResult> {
  const started = Date.now()
  const plan =
    request.apiMode !== undefined
      ? { apiMode: request.apiMode, reason: '调用方显式指定' }
      : resolvePlan({
          model: request.model,
          hasReferences: request.references.length > 0,
          provider: request.provider,
        })

  if (request.signal?.aborted === true) {
    return {
      ok: false,
      apiMode: plan.apiMode,
      planReason: plan.reason,
      error: { code: 'aborted', retryable: false, message: '请求已取消' },
      degraded: [],
      attempts: 0,
      ms: Date.now() - started,
    }
  }

  // Agnes 的 `size` 是**必填**（官方请求参数表）。缺它时不构造任何请求：
  // 发出去只会拿到一个 400，再来一次降级也只是重复一次同样的 400。
  if (request.provider.dialect === 'agnes' && (request.size ?? '').trim() === '') {
    return {
      ok: false,
      apiMode: plan.apiMode,
      planReason: plan.reason,
      error: {
        code: 'config',
        retryable: false,
        message:
          '厂商「Agnes AI」要求显式尺寸（官方文档把 size 标为必填）：请先经 pixmart_check_size 归一化出比例（如 1:1、3:4）再发起生图',
      },
      degraded: [],
      attempts: 0,
      ms: Date.now() - started,
    }
  }

  const chain = variantChain(plan.apiMode, request.references.length > 0, request.provider.dialect)
  const degraded: DegradedFlag[] = []
  let attempts = 0
  let lastError: VendorError = { code: 'bad_response', retryable: false, message: '没有可用的尝试档位' }

  for (let index = 0; index < chain.length; index += 1) {
    const variant = chain[index] as Variant
    if (index > 0) {
      degraded.push(...droppedFlags(chain[index - 1] as Variant, variant))
    }

    // 只有"参数被服务端拒绝"才值得换档位。5xx / 429 / 网络错误换档位毫无意义——
    // 那只会把同一个请求再花一次钱、再等一轮。所以这里区分：
    //   bad_request  → 降级到下一档
    //   其他可重试错误 → 重试耗尽后直接失败
    let shouldDegrade = false

    for (let attempt = 1; attempt <= request.maxRetries + 1; attempt += 1) {
      attempts += 1
      const outcome = await sendOnce(request, plan.apiMode, variant)

      if (outcome.kind === 'success') {
        return {
          ok: true,
          apiMode: plan.apiMode,
          planReason: plan.reason,
          images: outcome.images ?? [],
          degraded,
          attempts,
          ms: Date.now() - started,
          ...(outcome.raw === undefined ? {} : { raw: outcome.raw }),
        }
      }

      lastError = outcome.error ?? lastError

      if (outcome.kind === 'fatal') {
        if (lastError.code === 'bad_request') {
          shouldDegrade = true
          break
        }
        // 鉴权 / 审核 / 配置错误：换档位也没有意义，立刻返回。
        return {
          ok: false,
          apiMode: plan.apiMode,
          planReason: plan.reason,
          error: lastError,
          degraded,
          attempts,
          ms: Date.now() - started,
        }
      }

      if (attempt <= request.maxRetries) {
        try {
          await sleep(backoffMs(attempt, outcome.retryAfter), request.signal)
        } catch {
          return {
            ok: false,
            apiMode: plan.apiMode,
            planReason: plan.reason,
            error: { code: 'aborted', retryable: false, message: '请求已取消' },
            degraded,
            attempts,
            ms: Date.now() - started,
          }
        }
      }
    }

    if (!shouldDegrade) {
      // 可重试错误已耗尽重试，且不是参数问题 → 不降级。
      return {
        ok: false,
        apiMode: plan.apiMode,
        planReason: plan.reason,
        error: lastError,
        degraded,
        attempts,
        ms: Date.now() - started,
      }
    }
  }

  return {
    ok: false,
    apiMode: plan.apiMode,
    planReason: plan.reason,
    error: lastError,
    degraded,
    attempts,
    ms: Date.now() - started,
  }
}
