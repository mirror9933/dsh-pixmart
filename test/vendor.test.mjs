/**
 * P1 验收测试（A2–A4 的可在无凭据环境下验证的部分）。
 *
 * 用 Node 内置 test runner，不引入任何依赖：`node --test test/`。
 * 全部针对 `lib/`（编译产物）运行——测的就是真正会被宿主加载的那份代码。
 *
 * 覆盖：
 *   - 方言：ofox 用 input_images/output_format，standard 用 image/response_format
 *   - Gemini 原生：端点、x-goog-api-key、aspectRatio、inlineData 解析
 *   - 重试：429 后成功
 *   - 不重试：内容审核拒绝
 *   - 重试耗尽：5xx
 *   - 降级链：quality 被拒 → 去掉后成功，并回报 degraded
 *   - 尺寸：比例/像素归一化、不支持时的最近邻
 *   - 配置：脏数据容错
 *   - 提示词：确定性 + 占位符替换
 *   - 项目库：内容寻址去重 + 列表
 */
import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateImages, resolvePlan, sniffImageMediaType } from '../lib/vendor/openai-compat.js'
import { checkSize } from '../lib/sizes.js'
import { parseConfig, defaultOfoxProvider, resolveApiKey } from '../lib/config.js'
import { buildPrompt, substituteVars } from '../lib/prompts/build.js'
import { getModule, MODULES } from '../lib/prompts/modules.js'
import { ProjectStore } from '../lib/store/project-store.js'
import { ConfigStore } from '../lib/store/config-store.js'
import { imageInfo } from '../lib/image-info.js'

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

      if (req.url.startsWith('/gemini/v1beta/models/')) {
        return json(200, {
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } }],
        })
      }

      if (req.url === '/v1/images/generations') {
        const parsed = JSON.parse(body)
        const hits = seen.filter((entry) => entry.url === '/v1/images/generations').length
        if (behavior === 'rate-limit-once' && hits === 1) {
          res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: { message: 'slow down' } }))
        }
        if (behavior === 'moderation') return json(400, { error: { message: 'blocked by safety policy' } })
        if (behavior === 'server-error') return json(500, { error: { message: 'boom' } })
        if (behavior === 'reject-quality' && parsed.quality !== undefined) {
          return json(400, { error: { message: 'unknown parameter: quality' } })
        }
        return json(200, { data: [{ b64_json: PNG_B64 }] })
      }

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

function provider(overrides = {}) {
  return {
    ...defaultOfoxProvider(),
    baseUrl: `http://127.0.0.1:${port}/v1`,
    geminiNativeBaseUrl: `http://127.0.0.1:${port}/gemini/v1beta`,
    ...overrides,
  }
}

function request(overrides = {}) {
  return {
    provider: provider(),
    apiKey: 'test-key',
    model: 'gpt-image-1',
    prompt: 'a product photo',
    n: 1,
    references: [],
    maxRetries: 2,
    ...overrides,
  }
}

describe('厂商适配器', () => {
  it('ofox 方言使用 input_images / output_format', async () => {
    const result = await generateImages(request())
    assert.equal(result.ok, true)
    assert.equal(result.images.length, 1)
    assert.deepEqual(result.degraded, [])

    const body = JSON.parse(seen[0].body)
    assert.equal(body.output_format, 'png')
    assert.equal(body.response_format, undefined)
    assert.equal(body.input_images, undefined) // 未传参考图
    assert.equal(seen[0].headers.authorization, 'Bearer test-key')
  })

  it('ofox 方言下参考图走 input_images', async () => {
    const result = await generateImages(
      request({
        // 非 gpt-image 模型：避免被路由到 images-edits，这条测的是兼容端点的方言
        model: 'test-image-model',
        references: [{ data: PNG_BYTES, name: 'a.png', mediaType: 'image/png' }],
      }),
    )
    assert.equal(result.ok, true)
    const body = JSON.parse(seen[0].body)
    assert.ok(Array.isArray(body.input_images))
    assert.match(body.input_images[0], /^data:image\/png;base64,/)
    assert.equal(body.image, undefined)
  })

  it('standard 方言使用 image / response_format', async () => {
    await generateImages(
      request({
        provider: provider({ dialect: 'standard' }),
        // 非 gpt-image 模型，避免被路由到 images-edits（multipart）
        model: 'test-image-model',
        references: [{ data: PNG_BYTES, name: 'a.png', mediaType: 'image/png' }],
      }),
    )
    const body = JSON.parse(seen[0].body)
    assert.equal(body.response_format, 'b64_json')
    assert.ok(Array.isArray(body.image))
    assert.equal(body.input_images, undefined)
    assert.equal(body.output_format, undefined)
  })

  it('Gemini 图像模型路由到原生端点，用 x-goog-api-key 且传 aspectRatio', async () => {
    const plan = resolvePlan({
      model: 'google/gemini-3.1-flash-lite-image',
      hasReferences: true,
      provider: provider(),
    })
    assert.equal(plan.apiMode, 'gemini-native')

    const result = await generateImages(
      request({
        model: 'google/gemini-3.1-flash-lite-image',
        size: '3:4',
        references: [{ data: PNG_BYTES, name: 'a.png', mediaType: 'image/png' }],
      }),
    )
    assert.equal(result.ok, true)
    assert.equal(result.apiMode, 'gemini-native')

    const call = seen[0]
    assert.match(call.url, /^\/gemini\/v1beta\/models\/.+:generateContent$/)
    assert.equal(call.headers['x-goog-api-key'], 'test-key')
    assert.equal(call.headers.authorization, undefined)

    const body = JSON.parse(call.body)
    assert.equal(body.generationConfig.imageConfig.aspectRatio, '3:4')
    assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'image/png')
  })

  it('429 后重试并成功', async () => {
    behavior = 'rate-limit-once'
    const result = await generateImages(request())
    assert.equal(result.ok, true)
    assert.ok(result.attempts >= 2, `期望至少 2 次尝试，实际 ${result.attempts}`)
  })

  it('内容审核拒绝不重试', async () => {
    behavior = 'moderation'
    const result = await generateImages(request())
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'moderation')
    assert.equal(result.error.retryable, false)
    assert.equal(result.attempts, 1)
  })

  it('5xx 重试到耗尽后失败', async () => {
    behavior = 'server-error'
    const result = await generateImages(request({ maxRetries: 1 }))
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'server')
    assert.equal(result.attempts, 2)
  })

  it('参数被拒时降级（去掉 quality）并回报 degraded', async () => {
    behavior = 'reject-quality'
    const result = await generateImages(request())
    assert.equal(result.ok, true)
    assert.ok(result.degraded.includes('quality'), `degraded=${JSON.stringify(result.degraded)}`)
    assert.equal(result.attempts, 2)

    const successful = seen.at(-1)
    assert.equal(JSON.parse(successful.body).quality, undefined)
  })
})

describe('尺寸能力', () => {
  const ofox = defaultOfoxProvider()

  it('比例与像素按 apiMode 归一化', () => {
    const asPixel = checkSize({
      model: 'gpt-image-1',
      size: '1:1',
      apiMode: 'images-generations',
      provider: ofox,
    })
    assert.equal(asPixel.supported, true)
    assert.equal(asPixel.normalized, '1024x1024')

    const asRatio = checkSize({
      model: 'google/gemini-3.1-flash-lite-image',
      size: '1024x1024',
      apiMode: 'gemini-native',
      provider: ofox,
    })
    assert.equal(asRatio.supported, true)
    assert.equal(asRatio.normalized, '1:1')
  })

  it('不支持的尺寸给出最近邻而不是发请求', () => {
    const result = checkSize({
      model: 'gpt-image-1',
      size: '3000x1000',
      apiMode: 'images-generations',
      provider: ofox,
    })
    assert.equal(result.supported, false)
    assert.ok(result.nearest.length > 0)
    assert.ok(result.nearest.length <= 3)
  })
})

describe('配置容错', () => {
  it('脏数据不阻断启动，返回 warning 与默认值', () => {
    const result = parseConfig({
      version: 'x',
      providers: [{ id: 'ofox', baseUrl: 42 }, { id: 'ofox' }, 'not-an-object'],
      defaults: { provider: 'missing', n: 99 },
      limits: { maxConcurrency: 'many' },
    })
    assert.ok(result.warnings.length > 0)
    assert.equal(result.config.providers.length, 1) // 重复 id 去重
    // 纠正只看**文件里**的厂商：出厂清单为空也照样纠正到文件里的第一家（不编造厂商）
    assert.equal(result.config.defaults.provider, 'ofox') // 不存在的默认厂商被纠正
    assert.equal(result.config.defaults.n, 1)
    assert.equal(result.config.limits.maxConcurrency, 2)
  })

  it('密钥解析：环境变量优先于落盘值', () => {
    const withKey = { ...defaultOfoxProvider(), apiKey: 'from-file', apiKeyEnv: 'OFOX_API_KEY' }
    assert.deepEqual(resolveApiKey(withKey, { OFOX_API_KEY: 'from-env' }), {
      ok: true,
      key: 'from-env',
      source: 'env',
    })
    assert.deepEqual(resolveApiKey(withKey, {}), { ok: true, key: 'from-file', source: 'config' })

    const none = { ...defaultOfoxProvider(), apiKey: '', apiKeyEnv: '' }
    assert.equal(resolveApiKey(none, {}).ok, false)
  })
})

describe('提示词', () => {
  it('24 个模块且拼装确定', () => {
    assert.equal(MODULES.length, 24)
    const module = getModule('main.white-bg')
    assert.ok(module)

    const a = buildPrompt({ module })
    const b = buildPrompt({ module })
    assert.equal(a.prompt, b.prompt)
    assert.ok(a.prompt.length > 80)
    assert.ok(a.parts.length >= 4)
  })

  it('占位符被替换，不留字面量', () => {
    assert.equal(substituteVars('shoot {product} for {brand}', { product: 'a mug' }), 'shoot a mug for the brand')
    // 未知占位符被清空而不是保留花括号
    assert.equal(substituteVars('x {unknownVar} y'), 'x  y')
  })

  it('整模块覆盖生效', () => {
    const module = getModule('main.white-bg')
    const built = buildPrompt({ module, overrides: { 'main.white-bg': 'ONLY THIS' } })
    assert.equal(built.prompt, 'ONLY THIS')
    assert.equal(built.parts.length, 1)
  })
})

describe('项目库与图片元信息', () => {
  it('内容寻址去重且能列出项目', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pixmart-'))
    try {
      const store = new ProjectStore(dir)
      const project = await store.create('白底主图', 'ofox', 'gpt-image-1')

      const first = await store.saveImage(project.id, PNG_BYTES, 'image/png', 'main-white-bg-01')
      const second = await store.saveImage(project.id, PNG_BYTES, 'image/png', 'main-white-bg-02')

      // 同内容 → 同哈希 → 同一个文件
      assert.equal(first.absolutePath, second.absolutePath)
      assert.equal(first.sha256, second.sha256)
      assert.equal(imageInfo(PNG_BYTES, 'image/png').width, 1)

      await store.appendItem(project.id, {
        module: 'main.white-bg',
        label: '白底首图',
        prompt: 'p',
        size: '1024x1024',
        provider: 'ofox',
        model: 'gpt-image-1',
        apiMode: 'images-generations',
        status: 'ok',
        images: [first],
        ms: 12,
        createdAt: Date.now(),
      })

      const list = store.list()
      assert.equal(list.length, 1)
      assert.equal(list[0].imageCount, 1)
      assert.ok(list[0].cover)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('损坏的 config.json 被隔离且不阻断启动', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pixmart-'))
    try {
      const store = new ConfigStore(dir)
      const initial = await store.load()
      assert.equal(initial.warnings.length, 0)

      const { writeFileSync } = await import('node:fs')
      writeFileSync(store.configPath, '{ not json')

      const recovered = await store.load()
      assert.ok(recovered.warnings.length > 0)
      assert.ok(recovered.quarantined)
      assert.ok(existsSync(recovered.quarantined))
      // 损坏恢复走的是出厂配置：现在是 0 家（原先这里与 `defaultConfig()` 比，语义上是恒真）
      assert.equal(recovered.config.providers.length, 0, '恢复后的出厂配置不带任何厂商')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('PNG 魔数可嗅探', () => {
    assert.equal(sniffImageMediaType(PNG_BYTES), 'image/png')
    assert.equal(sniffImageMediaType(new Uint8Array([1, 2, 3])), undefined)
  })
})
