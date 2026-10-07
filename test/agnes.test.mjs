/**
 * Agnes AI 厂商（`dialect: 'agnes'`）的**离线**契约测试。
 *
 * 硬前提：**我们没有 Agnes 的 API Key**。所以这里能验、也只验四件不需要网络与凭据的事——
 *   1. **预设**：出厂清单为空（`defaultConfig().providers === []`、`defaults` 为空串），
 *      而内置默认 `defaultAgnesProvider()` 仍导出且字段齐全、`apiKey` 为空；
 *   2. **请求构造**：端点 / 鉴权头 / `extra_body.response_format` / `extra_body.image` /
 *      「档位 + 比例」的尺寸（对着取证到的形状断言，不是对着我们的实现断言）；
 *   3. **响应解析**：URL 与 Base64 两种形状都能取出图片字节与尺寸；
 *   4. **错误分支**：鉴权失败、无 `/models`、缺 size，都必须给出**可读**的结构化错误。
 *
 * 取证出处（契约来源，见 docs/contract-notes.md §25）：
 *   - 官方《Agnes Image 2.1 Flash》：`POST {base}/images/generations`、
 *     `Authorization: Bearer`、`extra_body.response_format`、`extra_body.image`、
 *     `size` 档位 + `ratio`、响应 `data[].url` / `data[].b64_json`；
 *   - 参考项目 `pixmart-ai`（只读）：`src/main/services/openai.ts:552-560`（agnes 分支）、
 *     `src/renderer/src/types/model.ts:142-146`（baseUrl）。
 *
 * **零真实网络**：唯一的 fetch 打向本文件起的本地 http 服务器。
 * 全部针对 `lib/`（编译产物）运行——测的就是真正会被宿主加载的那份代码。
 */
import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { generateImages, resolvePlan } from '../lib/vendor/openai-compat.js'
import { fetchProviderModels } from '../lib/vendor/models.js'
import { checkSize, sizeOptionsFor } from '../lib/sizes.js'
import {
  defaultAgnesProvider,
  defaultConfig,
  defaultOfoxProvider,
  parseConfig,
  resolveApiKey,
  toProviderView,
} from '../lib/config.js'

/** 1x1 PNG（IHDR 声明 1x1）。 */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_B64, 'base64')

let server
let port
let behavior
let seen

before(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body })
      const json = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      // 产物下载：agnes 的 url 模式返回的是远程 URL，适配器必须立刻取回字节。
      if (req.url === '/generated/agnes-1.png') {
        res.writeHead(200, { 'content-type': 'image/png' })
        return res.end(PNG_BYTES)
      }

      if (req.url === '/v1/images/generations') {
        if (behavior === 'auth') return json(401, { error: { message: 'invalid api key' } })
        if (behavior === 'bad-request') return json(400, { error: { message: 'unknown parameter' } })
        // 国内站实测形状：模型没开通时不是 404，而是 **503 + model_not_found**。
        if (behavior === 'model-unavailable') {
          return json(503, {
            error: {
              message: '分组 default 下模型 agnes-image-2.0-flash 无可用渠道（distributor）',
              type: 'model_not_found',
              code: 'model_not_found',
            },
          })
        }
        if (behavior === 'empty') return json(200, { created: 1780000000, data: [] })
        if (behavior === 'url') {
          return json(200, {
            created: 1780000000,
            data: [{ url: `http://127.0.0.1:${port}/generated/agnes-1.png`, b64_json: null, revised_prompt: null }],
          })
        }
        // 官方 Base64 形状：url 为 null，图片在 b64_json
        return json(200, {
          created: 1780000000,
          data: [{ url: null, b64_json: PNG_B64, revised_prompt: null }],
        })
      }

      // Agnes 没有文档化的 /models（这里刻意返回 404，用于"拉取模型"的可读失败）
      return json(404, { error: { message: 'not found' } })
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

beforeEach(() => {
  behavior = 'ok'
  seen = []
})

/** 把预设指向本地服务器；其余字段保持出厂值，确保测的是**真实预设**。 */
function agnes(overrides = {}) {
  return {
    ...defaultAgnesProvider(),
    baseUrl: `http://127.0.0.1:${port}/v1`,
    ...overrides,
  }
}

function request(overrides = {}) {
  return {
    provider: agnes(),
    apiKey: 'agnes-test-key',
    model: 'agnes-image-2.1-flash',
    prompt: 'a product photo on a white background',
    size: '1:1',
    n: 1,
    references: [],
    maxRetries: 0,
    ...overrides,
  }
}

// ── 1. 预设 ──────────────────────────────────────────────────────────────────

describe('Agnes 厂商预设', () => {
  it('出厂配置不带任何厂商（defaults 为空串）；agnes 的内置默认字段齐全', () => {
    const config = defaultConfig()
    const ids = config.providers.map((provider) => provider.id)

    // 用户决策：安装后不预设厂商，全部由用户从「添加模型提供商」里挑。
    assert.deepEqual(ids, [], '出厂清单为空，不得再自动带上 ofox / agnes')
    assert.equal(config.defaults.provider, '', '出厂没有默认厂商（空串 = 尚未选择）')
    assert.equal(config.defaults.model, '', '出厂没有默认模型')
    assert.equal(config.defaults.size, '1:1')
    assert.equal(config.defaults.n, 1)

    // `defaultAgnesProvider()` 仍然导出并保持取证到的字段（目录/夹具/将来重新放出厂预设都用它）
    const agnesProvider = defaultAgnesProvider()
    assert.ok(agnesProvider, '内置默认必须仍然可导出')
    assert.equal(agnesProvider.id, 'agnes')
    assert.equal(agnesProvider.label, 'Agnes AI')
    assert.equal(agnesProvider.dialect, 'agnes')
    assert.equal(agnesProvider.apiMode, 'images-generations')
    assert.equal(agnesProvider.group, 'official')
    assert.equal(agnesProvider.baseUrl, 'https://api.agnes-ai.cn/v1')
    assert.equal(agnesProvider.geminiNativeBaseUrl, '', 'agnes 没有 Gemini 原生端点')
    assert.equal(agnesProvider.apiKey, '', '内置默认不带密钥')
    assert.equal(agnesProvider.apiKeyEnv, 'AGNES_API_KEY')
    assert.ok(agnesProvider.models.length > 0)
    assert.ok(agnesProvider.allowedSizes.length > 0)
    assert.equal(agnesProvider.sizeMode, 'whitelist')
    assert.equal(agnesProvider.timeoutMs, 180_000)
  })

  it('鉴权方式为 Bearer，所以 apiKeyEnv 是唯一密钥来源（默认无密钥）', () => {
    const provider = defaultAgnesProvider()
    assert.equal(resolveApiKey(provider, {}).ok, false)
    // 环境变量优先
    assert.deepEqual(resolveApiKey(provider, { AGNES_API_KEY: 'from-env' }), {
      ok: true,
      key: 'from-env',
      source: 'env',
    })
    assert.equal(toProviderView(provider, { AGNES_API_KEY: 'from-env' }).hasApiKey, true)
    assert.equal(toProviderView(provider, {}).hasApiKey, false)
  })

  it('落盘配置里的 agnes 能被解析回来（dialect 是合法的枚举值）', () => {
    const result = parseConfig({
      version: 1,
      providers: [
        {
          id: 'agnes',
          label: 'Agnes AI',
          group: 'official',
          baseUrl: 'https://api.agnes-ai.cn/v1',
          dialect: 'agnes',
          apiMode: 'images-generations',
          models: ['agnes-image-2.1-flash'],
          allowedSizes: ['1:1'],
          sizeMode: 'whitelist',
        },
      ],
      defaults: { provider: 'agnes' },
    })
    assert.deepEqual(result.warnings, [], `不该有 warning：${result.warnings.join(' / ')}`)
    assert.equal(result.config.providers[0].dialect, 'agnes')
  })

  it('路由表把 agnes 模型映射到 images-generations（带参考图也不改道）', () => {
    const plan = resolvePlan({
      model: 'agnes-image-2.1-flash',
      hasReferences: true,
      provider: agnes(),
    })
    assert.equal(plan.apiMode, 'images-generations')
  })

  it('尺寸归一化：比例保留比例，精确像素**保留像素**（档位不能被丢掉）', () => {
    const provider = agnes()

    const fromRatio = checkSize({ model: 'agnes-image-2.1-flash', size: '3:4', apiMode: 'images-generations', provider })
    assert.equal(fromRatio.supported, true)
    assert.equal(fromRatio.normalized, '3:4', 'agnes 方言下必须保留比例，不能转成 960x1280')

    // 这一条是回归断言：曾经把 2048x2048 一律塌缩成 `1:1`，于是"要 2K"在到达适配器
    // 之前就丢了档位，用户静默拿到 1K。像素是档位的唯一载体，必须原样带下去。
    const fromPixel = checkSize({ model: 'agnes-image-2.1-flash', size: '2048x2048', apiMode: 'images-generations', provider })
    assert.equal(fromPixel.supported, true)
    assert.equal(fromPixel.normalized, '2048x2048', '精确像素必须保真，塌缩成比例就等于丢档位')

    // 表外像素按纵横比就近**吸附到官方尺寸**（1280x960 不是官方 4:3 的 1K 尺寸，
    // 官方 4:3 1K 是 1152x864），而不是折算成比例后自由发挥。
    const fromDims = checkSize({ model: 'agnes-image-2.1-flash', size: '1280x960', apiMode: 'images-generations', provider })
    assert.equal(fromDims.supported, true)
    assert.equal(fromDims.normalized, '1152x864')

    // 比例仍按官方支持的 8 种判定，5:4 不在其中，给最近邻而不是静默通过。
    const unsupported = checkSize({ model: 'agnes-image-2.1-flash', size: '1280x1024', apiMode: 'images-generations', provider })
    assert.equal(unsupported.supported, false)

    // 超出该比例最大档位（1:1 最大 4096）的像素请求必须被挡住，不能静默吸附成 4K。
    const tooLarge = checkSize({ model: 'agnes-image-2.1-flash', size: '9999x9999', apiMode: 'images-generations', provider })
    assert.equal(tooLarge.supported, false)
    assert.deepEqual([...tooLarge.nearest].slice(0, 1), ['4096x4096'], '最近邻应先给同比例的最大档位')

    // 同一份输入在 standard 方言下仍是像素（方言确实改变了归一化格式）
    const pixelDialect = checkSize({
      model: 'test-image-model',
      size: '3:4',
      apiMode: 'images-generations',
      provider: { ...defaultOfoxProvider(), dialect: 'standard' },
    })
    assert.equal(pixelDialect.normalized, '960x1280')
  })

  it('agnes 的内置尺寸能力不依赖 config 里的 allowedSizes（老配置也生效）', () => {
    // 出厂预设的 allowedSizes 只有 8 个比例；32 个精确像素尺寸来自 sizes.ts 的内置能力表。
    // 这样"代码改了、用户的老配置不生效"这个坑就不会再来一次。
    const provider = { ...agnes(), allowedSizes: ['1:1'] }
    const result = checkSize({ model: 'agnes-image-2.5-flash', size: '2624x1472', apiMode: 'images-generations', provider })
    assert.equal(result.supported, true)
    assert.equal(result.normalized, '2624x1472')
  })

  it('设置页的尺寸候选：agnes 出 40 项、像素带「档位 · 比例」标签（UI 能选档位的前提）', () => {
    // 档位只有官方表知道，所以**候选由宿主出**：客户端不该自己拼词表，否则
    // "UI 能选的"与"checkSize 认的"会各说各话（这正是本次要修的那类缺陷）。
    const options = sizeOptionsFor({
      model: 'agnes-image-2.1-flash',
      apiMode: 'images-generations',
      provider: { ...agnes(), allowedSizes: ['1:1'] },
    })
    assert.equal(options.length, 40)
    assert.deepEqual(
      options.filter((entry) => entry.label.includes('2K')).map((entry) => entry.label),
      ['2K · 1:1', '2K · 3:4', '2K · 4:3', '2K · 16:9', '2K · 9:16', '2K · 2:3', '2K · 3:2', '2K · 21:9'],
      '每个比例都该有 2K 档，标签是「档位 · 比例」',
    )
    // 比例项的标签就是它自己（没有档位信息）
    assert.deepEqual(options.filter((entry) => entry.value === '3:4'), [{ value: '3:4', label: '3:4' }])
  })

  it('只给档位（`2K`）时拒绝并给出可用像素，而不是替用户默认一个比例', () => {
    const result = checkSize({
      model: 'agnes-image-2.1-flash',
      size: '2K',
      apiMode: 'images-generations',
      provider: agnes(),
    })
    assert.equal(result.supported, false)
    assert.match(result.reason, /不能单独给档位/)
    assert.ok(result.nearest.includes('2048x2048'), `提示里要出现 2K 对应的像素，实际：${JSON.stringify(result.nearest)}`)
  })

  it('不支持的比例给出最近邻而不是静默通过', () => {
    const result = checkSize({
      model: 'agnes-image-2.1-flash',
      size: '5:4',
      apiMode: 'images-generations',
      provider: agnes(),
    })
    assert.equal(result.supported, false)
    assert.ok(result.nearest.length > 0)
  })
})

// ── 2. 请求构造 ──────────────────────────────────────────────────────────────

describe('Agnes 请求构造', () => {
  it('文生图：POST {baseUrl}/images/generations + Bearer + 档位/比例 + extra_body.response_format', async () => {
    const result = await generateImages(request({ size: '3:4' }))
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.apiMode, 'images-generations')

    const call = seen.at(-1)
    assert.equal(call.url, '/v1/images/generations')
    assert.equal(call.headers.authorization, 'Bearer agnes-test-key')

    const body = JSON.parse(call.body)
    assert.equal(body.model, 'agnes-image-2.1-flash')
    assert.equal(body.prompt, 'a product photo on a white background')
    // 尺寸 = 档位 + 比例
    assert.equal(body.size, '1K')
    assert.equal(body.ratio, '3:4')
    // response_format 必须嵌在 extra_body 内（官方明文：放顶层会报错）
    assert.equal(body.extra_body.response_format, 'url')
    assert.equal(body.response_format, undefined, '顶层 response_format 会让 Agnes 报错')
    // 官方请求参数表里没有 n
    assert.equal(body.n, undefined)
    assert.equal(body.quality, undefined)
  })

  it('图生图走同一端点，参考图在 extra_body.image（data URI）且顶层无 image', async () => {
    const result = await generateImages(
      request({ references: [{ data: PNG_BYTES, name: 'a.png', mediaType: 'image/png' }] }),
    )
    assert.equal(result.ok, true, JSON.stringify(result))

    const call = seen.at(-1)
    assert.equal(call.url, '/v1/images/generations', 'agnes 图生图不走 /images/edits')

    const body = JSON.parse(call.body)
    assert.ok(Array.isArray(body.extra_body.image))
    assert.match(body.extra_body.image[0], /^data:image\/png;base64,/)
    assert.equal(body.image, undefined, '顶层 image 不会被 Agnes 采用')
    assert.equal(body.extra_body.response_format, 'url')
  })

  it('多张参考图按传入顺序全部放进 extra_body.image（多图合成）', async () => {
    await generateImages(
      request({
        references: [
          { data: PNG_BYTES, name: 'a.png', mediaType: 'image/png' },
          { data: PNG_BYTES, name: 'b.png', mediaType: 'image/png' },
        ],
      }),
    )
    const body = JSON.parse(seen.at(-1).body)
    assert.equal(body.extra_body.image.length, 2)
  })

  it('像素尺寸经过调用方时被折算成受支持的比例（不发官方不认的像素桶）', async () => {
    await generateImages(request({ size: '1024x768' }))
    const body = JSON.parse(seen.at(-1).body)
    assert.equal(body.size, '1K')
    assert.equal(body.ratio, '4:3', '1024x768 归一到 4:3（agnes 支持的 8 种比例之一）')
  })

  it('档位由精确像素尺寸决定：2048x2048 → 2K，2624x1472 → 2K + 16:9', async () => {
    await generateImages(request({ size: '2048x2048' }))
    const square = JSON.parse(seen.at(-1).body)
    assert.equal(square.size, '2K', '要 2K 就必须发 2K，不能回落 1K')
    assert.equal(square.ratio, '1:1')

    // 16:9 的官方像素不是精确 16:9（1312x736 化简是 41:23），所以只能查表得出比例；
    // 靠"化简比例是否等于 16:9"会得到 1:1 —— 那正是之前的 bug。
    await generateImages(request({ size: '2624x1472' }))
    const wide = JSON.parse(seen.at(-1).body)
    assert.equal(wide.size, '2K')
    assert.equal(wide.ratio, '16:9')

    // 直接给档位也认（官方默认比例 1:1）。
    await generateImages(request({ size: '3K' }))
    const tiered = JSON.parse(seen.at(-1).body)
    assert.equal(tiered.size, '3K')
    assert.equal(tiered.ratio, '1:1')
  })

  it('standard 方言**没有**被 agnes 分支影响（字段仍在顶层）', async () => {
    await generateImages(
      request({
        provider: { ...defaultOfoxProvider(), baseUrl: `http://127.0.0.1:${port}/v1`, dialect: 'standard' },
        model: 'test-image-model',
        size: '1024x1024',
        references: [{ data: PNG_BYTES, name: 'a.png', mediaType: 'image/png' }],
      }),
    )
    const body = JSON.parse(seen.at(-1).body)
    assert.equal(body.response_format, 'b64_json')
    assert.ok(Array.isArray(body.image))
    assert.equal(body.extra_body, undefined, 'standard 方言不该出现 extra_body')
    assert.equal(body.ratio, undefined)
  })
})

// ── 3. 响应解析 ──────────────────────────────────────────────────────────────

describe('Agnes 响应解析', () => {
  it('url 形状：立刻下载远程产物，字节与魔数都对', async () => {
    behavior = 'url'
    const result = await generateImages(request())
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.images.length, 1)
    assert.deepEqual(Buffer.from(result.images[0].data), PNG_BYTES)
    assert.equal(result.images[0].mediaType, 'image/png')
    // 下载确实发生过（url 是短期签名，必须当场取回）
    assert.ok(seen.some((entry) => entry.url === '/generated/agnes-1.png'))
  })

  it('Base64 形状：b64_json 直接解出字节（url 为 null 不影响判定）', async () => {
    const result = await generateImages(request())
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.images.length, 1)
    assert.deepEqual(Buffer.from(result.images[0].data), PNG_BYTES)
    assert.equal(result.images[0].mediaType, 'image/png')
    // 没有发生任何下载（只有一次生图请求）
    assert.equal(seen.length, 1)
  })

  it('响应里没有图片时是结构化 bad_response，不是静默成功', async () => {
    behavior = 'empty'
    const result = await generateImages(request())
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'bad_response')
    assert.equal(result.error.retryable, false)
  })
})

// ── 4. 错误分支 ──────────────────────────────────────────────────────────────

describe('Agnes 错误分支', () => {
  it('鉴权失败（401）→ code auth，不重试、不降级', async () => {
    behavior = 'auth'
    const result = await generateImages(request({ maxRetries: 2 }))
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'auth')
    assert.equal(result.error.retryable, false)
    assert.equal(result.attempts, 1, '401 换档位毫无意义，只该发一次')
    assert.deepEqual(result.degraded, [])
    assert.match(result.error.message, /鉴权失败/)
  })

  it('模型没渠道（503 + model_not_found）→ 终态 model_unavailable，且只发一次', async () => {
    // 503 通常被当成服务端瞬时故障（可重试）。agnes 国内站在模型未开通时用的就是
    // 503 + `model_not_found`：重试一万次也一样，顺降级链重发更是白花钱。
    behavior = 'model-unavailable'
    const result = await generateImages(request({ maxRetries: 2 }))
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'model_unavailable')
    assert.equal(result.error.retryable, false)
    assert.equal(seen.length, 1, '不能重试，也不能顺降级链重发')
    assert.deepEqual(result.degraded, [])
    assert.match(result.error.message, /不可用/)
    // 原始正文必须保留：模型名与"分组"是用户找客服时报的依据。
    assert.match(result.error.message, /无可用渠道/)
  })

  it('缺少 size → 结构化 config 错误，且**一个请求都不发**', async () => {
    const result = await generateImages(request({ size: undefined }))
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'config')
    assert.equal(result.attempts, 0)
    assert.equal(seen.length, 0, '缺必填参数不该把请求发出去换一个 400')
    assert.match(result.error.message, /Agnes/)
    assert.match(result.error.message, /size/)
  })

  it('参数被拒（400）时按档位降级；agnes 链上不出现 quality、也不去掉 size', async () => {
    behavior = 'bad-request'
    const result = await generateImages(
      request({
        maxRetries: 0,
        references: [{ data: PNG_BYTES, name: 'a.png', mediaType: 'image/png' }],
      }),
    )
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'bad_request')

    // 带参考图时 agnes 的降级链恰好三档：full → 去掉 response_format → 再去掉参考图。
    // 不含 quality 档（不发厂商不认的参数），也不含去掉 size 的档（size 是必填，
    // 去掉它只是白花一次请求的钱）。
    assert.equal(seen.length, 3, `期望 3 档，实际 ${seen.length}`)
    const bodies = seen.map((entry) => JSON.parse(entry.body))
    assert.deepEqual(
      bodies.map((body) => body.extra_body?.response_format ?? null),
      ['url', null, null],
    )
    assert.deepEqual(
      bodies.map((body) => Array.isArray(body.extra_body?.image)),
      [true, true, false],
      '降级顺序：先去掉 response_format，最后才去掉参考图',
    )

    for (const [index, entry] of seen.entries()) {
      assert.equal(entry.url, '/v1/images/generations')
      assert.equal(entry.headers.authorization, 'Bearer agnes-test-key')
      assert.equal(bodies[index].quality, undefined, 'agnes 链上任何一档都不该出现 quality')
      assert.equal(bodies[index].size, '1K', 'agnes 链上任何一档都必须带 size')
      assert.equal(bodies[index].ratio, '1:1')
    }
  })

  it('无 /models：拉取模型给出可读的结构化失败（HTTP 404），而不是假装成功', async () => {
    const result = await fetchProviderModels(agnes(), { apiKey: 'agnes-test-key' })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'bad_response')
    assert.equal(result.status, 404)
    assert.match(result.error.message, /HTTP 404/)
    // 探测打的就是 {baseUrl}/models，且带 Bearer
    assert.equal(seen.at(-1).url, '/v1/models')
    assert.equal(seen.at(-1).headers.authorization, 'Bearer agnes-test-key')
  })

  it('无密钥时拉取模型：no_api_key，且不发任何请求', async () => {
    const result = await fetchProviderModels(agnes(), { apiKey: '' })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'no_api_key')
    assert.match(result.error.message, /AGNES_API_KEY/)
    assert.equal(seen.length, 0)
  })
})
