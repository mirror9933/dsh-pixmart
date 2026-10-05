/**
 * 厂商「模型列表」探测 —— 设置页的「拉取模型」与「测试连接」（技术方案 §7.11 的
 * `testProvider` / 设置页可写）。
 *
 * 为什么独立成文件而不塞进 `openai-compat.ts`：那里是**生图请求**的构造与降级链，
 * 逻辑已经很长；这里只做一件事——对 `{baseUrl}/models` 发一次 GET 并把三种常见
 * 响应形状归一化成 `string[]`。独立之后可以纯单测（stub fetch，零真实网络）。
 *
 * 三条约定：
 *   1. **鉴权与生图同源**：OpenAI 兼容路径 `Authorization: Bearer <key>`；
 *      `gemini-native` 走 `x-goog-api-key`（与 openai-compat 的分叉一致）。
 *   2. **超时必设**：`min(provider.timeoutMs, 15s)`，避免设置页按钮永远转圈。
 *   3. **错误结构化且不泄露密钥**：错误消息里只有状态码与响应摘录，
 *      响应摘录来自厂商而非我们回显请求头。
 */
import type { ProviderConfig } from '../config.js'

/** 探测超时上限：设置页是交互式操作，不该等生图那种长超时。 */
export const PROBE_TIMEOUT_MS = 15_000

/** 响应摘录上限：够定位问题，又不至于把整个 HTML 错误页塞进错误消息。 */
const EXCERPT_LIMIT = 200

export type ModelProbeCode =
  | 'no_api_key'
  | 'auth'
  | 'timeout'
  | 'network'
  | 'bad_response'
  | 'aborted'

export interface ModelProbeError {
  readonly code: ModelProbeCode
  readonly message: string
  /** HTTP 状态码（有的话）。 */
  readonly status?: number
}

export type ModelProbeResult =
  | {
      readonly ok: true
      /** 归一化后的模型 id 列表。 */
      readonly models: readonly string[]
      readonly shape: string
      readonly ms: number
      readonly status: number
    }
  | { readonly ok: false; readonly error: ModelProbeError; readonly ms: number; readonly status?: number }

export interface ModelProbeOptions {
  /** 已解析出的明文密钥。**绝不进任何返回结构。** */
  readonly apiKey: string
  /** 注入以便单测；默认取全局 fetch。 */
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

/** 去掉末尾斜杠再拼 `/models`（baseUrl 可能写成 `https://x/v1/` 或 `https://x/v1//`）。 */
export function modelsEndpoint(provider: ProviderConfig): string {
  const native =
    provider.apiMode === 'gemini-native' && provider.geminiNativeBaseUrl.trim() !== ''
  const base = (native ? provider.geminiNativeBaseUrl : provider.baseUrl).replace(/[/\\]+$/, '')
  return `${base}/models`
}

/** 探测请求的头：方言决定字段名，apiMode 决定鉴权头（与厂商适配器同一分叉）。 */
function probeHeaders(provider: ProviderConfig, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json', ...provider.extraHeaders }
  if (provider.apiMode === 'gemini-native') headers['x-goog-api-key'] = apiKey
  else headers['Authorization'] = `Bearer ${apiKey}`
  return headers
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * 把条目归一化成模型 id。
 * 元素既可能是字符串，也可能是 `{ id }`（有些网关给 `{ model }` / `{ name }`）。
 */
function entryToId(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim()
  const record = asRecord(value)
  if (record === undefined) return undefined
  for (const key of ['id', 'model', 'name']) {
    const raw = record[key]
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  }
  return undefined
}

function dedupe(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * 解析厂商 `/models` 响应。兼容三种形状：
 *   - `{ data: [{ id }] }`（OpenAI 规范）
 *   - `{ models: [...] }`（Gemini / 部分聚合商）
 *   - 纯数组（元素为字符串或 `{ id }`）
 * @returns 命中的形状名与 id 列表；都无法识别时返回 `undefined`。
 */
export function parseModelsResponse(
  payload: unknown,
): { readonly shape: string; readonly models: readonly string[] } | undefined {
  if (Array.isArray(payload)) {
    const ids = dedupe(payload.map(entryToId).filter((id): id is string => id !== undefined))
    return { shape: 'array', models: ids }
  }

  const root = asRecord(payload)
  if (root === undefined) return undefined

  for (const key of ['data', 'models'] as const) {
    const value = root[key]
    if (!Array.isArray(value)) continue
    const ids = dedupe(value.map(entryToId).filter((id): id is string => id !== undefined))
    return { shape: key, models: ids }
  }

  return undefined
}

/** 单次探测的落点。 */
interface ProbeOutcome {
  readonly status?: number
  readonly bodyText?: string
  readonly error?: ModelProbeError
}

function probeTimeoutMs(provider: ProviderConfig, override?: number): number {
  const requested = override ?? provider.timeoutMs
  if (!Number.isFinite(requested) || requested <= 0) return PROBE_TIMEOUT_MS
  // 上限 15s：设置页是交互式操作，不该等生图那种长超时。
  return Math.min(Math.floor(requested), PROBE_TIMEOUT_MS)
}

async function probeOnce(
  provider: ProviderConfig,
  options: ModelProbeOptions,
): Promise<ProbeOutcome> {
  const doFetch = options.fetchImpl ?? fetch
  const budget = probeTimeoutMs(provider, options.timeoutMs)
  const controller = new AbortController()

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      controller.abort()
    } catch {
      // abort 失败不该掩盖超时这个事实
    }
  }, budget)

  try {
    const response = await doFetch(modelsEndpoint(provider), {
      method: 'GET',
      headers: probeHeaders(provider, options.apiKey),
      signal: controller.signal,
    })
    const bodyText = await response.text().catch(() => '')
    return { status: response.status, bodyText }
  } catch (error) {
    if (timedOut) {
      return {
        error: {
          code: 'timeout',
          message: `探测超时（超过 ${String(Math.max(1, Math.round(budget / 1000)))} 秒未响应）`,
        },
      }
    }
    return {
      error: {
        code: 'network',
        message: `无法连接厂商端点：${error instanceof Error ? error.message : String(error)}`,
      },
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 拉取厂商模型列表（不写任何配置）。
 * @param provider - 厂商配置。
 * @param options - 明文密钥与可注入的 fetch / 超时。
 */
export async function fetchProviderModels(
  provider: ProviderConfig,
  options: ModelProbeOptions,
): Promise<ModelProbeResult> {
  const started = Date.now()
  const key = options.apiKey.trim()
  if (key === '') {
    return {
      ok: false,
      ms: 0,
      error: {
        code: 'no_api_key',
        message:
          provider.apiKeyEnv.trim() === ''
            ? `厂商「${provider.label}」还没有密钥：请在设置页填写`
            : `厂商「${provider.label}」没有可用密钥：环境变量 ${provider.apiKeyEnv} 为空，且设置页未填写`,
      },
    }
  }

  const outcome = await probeOnce(provider, options)
  const ms = Date.now() - started

  if (outcome.error !== undefined) {
    return { ok: false, error: outcome.error, ms }
  }

  const status = outcome.status ?? 0
  const bodyText = outcome.bodyText ?? ''
  const excerpt = bodyText.slice(0, EXCERPT_LIMIT)

  if (status === 401 || status === 403) {
    // 只报"密钥被拒"，绝不回显密钥，也不把厂商响应原文当密钥泄漏面。
    return {
      ok: false,
      ms,
      status,
      error: { code: 'auth', status, message: `密钥被拒（HTTP ${String(status)}）` },
    }
  }

  if (status < 200 || status >= 300) {
    return {
      ok: false,
      ms,
      status,
      error: {
        code: 'bad_response',
        status,
        message: `厂商返回 HTTP ${String(status)}${excerpt === '' ? '' : `：${excerpt}`}`,
      },
    }
  }

  let payload: unknown
  try {
    payload = bodyText === '' ? undefined : JSON.parse(bodyText)
  } catch {
    return {
      ok: false,
      ms,
      status,
      error: {
        code: 'bad_response',
        status,
        message: `响应不是 JSON：${excerpt}`,
      },
    }
  }

  const parsed = parseModelsResponse(payload)
  if (parsed === undefined) {
    return {
      ok: false,
      ms,
      status,
      error: {
        code: 'bad_response',
        status,
        message: `无法识别的模型列表形状（期望 data[] / models[] / 数组）：${excerpt}`,
      },
    }
  }

  return { ok: true, models: parsed.models, shape: parsed.shape, ms, status }
}
