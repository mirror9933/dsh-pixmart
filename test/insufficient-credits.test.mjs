/**
 * 「余额不足不得自行兜底」的回归锁（见 contract-notes §18）。
 *
 * 实测事件：厂商余额为负时 `pixmart_edit` 收到 HTTP 402 + `insufficient_credits`，
 * 但适配器把它归进了泛化的 `bad_request`。于是发生了两件坏事：
 *   1. `bad_request` 会触发**降级链**——同一个注定被拒的请求被换着参数再花 5 次钱；
 *   2. 工具返回只有一句"该错误重试无意义"，Agent 于是**未经询问**写了 PIL 脚本
 *      把商品图自己拼出来，当作交付物（伪造，而不是生成）。
 *
 * 这里钉住三件事：
 *   - 402 / `insufficient_credits` 有**专用错误码**，且原始 message（含余额数值）不丢；
 *   - hint 是**指令级**的（充值 / 问用户 / 禁止合成），并被渲染进工具卡片文本；
 *   - 其余失败码（5xx 等）**不会**被误标成余额不足。
 *
 * 全程 stub fetch（本地 mock 端点），零真实网络、零花费。
 */
import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateImages } from '../lib/vendor/openai-compat.js'
import { defaultOfoxProvider } from '../lib/config.js'
import {
  INSUFFICIENT_CREDITS_HINT,
  createRuntime,
  vendorFailureHint,
} from '../lib/tools/runtime.js'
import { createGenerateTools } from '../lib/tools/generate.js'
import { createBatchTool } from '../lib/tools/batch.js'
import { GUIDANCE_TEXT } from '../lib/guidance.js'

/** 1x1 PNG（IHDR 声明 1x1），用作参考图。 */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const PNG = Buffer.from(PNG_B64, 'base64')

/** 事件原文：负余额必须在返回里原样可读。 */
const BALANCE_MESSAGE = 'Insufficient credits. Current balance: $-0.138427.'
const BALANCE_AMOUNT = '$-0.138427'

const stubContext = {
  tools: { register: () => () => {}, schemas: () => [] },
  get: () => undefined,
  effect: () => {},
  on: () => () => {},
}

const stubExec = {
  callId: 'test',
  signal: new AbortController().signal,
  deferContext: () => {},
  concludeTurn: () => {},
}

let server
let port
let behavior
let hits

before(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      hits += 1
      const json = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      if (behavior === 'insufficient') {
        // 与实测事件逐字一致：HTTP 402 + type/code + 负余额 message。
        return json(402, {
          error: { message: BALANCE_MESSAGE, type: 'insufficient_credits', code: 402 },
        })
      }
      if (behavior === 'insufficient-as-400') {
        // 有些网关把余额不足塞在 400 里，只认 type 不认状态码。
        return json(400, {
          error: { message: BALANCE_MESSAGE, type: 'insufficient_credits' },
        })
      }
      if (behavior === 'insufficient-wrapped-200') {
        // 也有网关用 200 包一层错误。
        return json(200, { error: { message: BALANCE_MESSAGE, type: 'insufficient_credits' } })
      }
      if (behavior === 'server-error') {
        return json(500, { error: { message: 'boom' } })
      }
      return json(200, { data: [{ b64_json: PNG_B64 }] })
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
  hits = 0
})

function provider(overrides = {}) {
  return {
    ...defaultOfoxProvider(),
    baseUrl: `http://127.0.0.1:${port}/v1`,
    geminiNativeBaseUrl: '',
    dialect: 'standard',
    apiMode: 'images-generations',
    ...overrides,
  }
}

function request(overrides = {}) {
  return {
    provider: provider(),
    apiKey: 'test-key',
    model: 'test-image-model',
    prompt: 'a product photo',
    n: 1,
    references: [],
    maxRetries: 2,
    ...overrides,
  }
}

/** 造一个指向 mock 端点的数据目录 + 运行时（与 p2 验收同一套写法）。 */
function makeRuntime() {
  const dir = mkdtempSync(join(tmpdir(), 'pixmart-credits-'))
  const config = {
    version: 1,
    providers: [
      {
        id: 'mock',
        label: 'Mock',
        group: 'aggregator',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        geminiNativeBaseUrl: '',
        dialect: 'standard',
        apiMode: 'images-generations',
        apiKeyEnv: '',
        apiKey: 'test-key',
        models: ['test-image-model'],
        allowedSizes: ['1:1', '3:4', '4:3', '9:16', '16:9', '4:5'],
        sizeMode: 'whitelist',
        extraHeaders: {},
        timeoutMs: 30_000,
      },
    ],
    defaults: { provider: 'mock', model: 'test-image-model', size: '1:1', n: 1 },
    limits: { maxConcurrency: 2, maxBatchItems: 20, maxRetries: 0, retentionDays: 0 },
    promptOverrides: {},
    attachmentInConversation: false,
  }
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2))
  return { dir, runtime: createRuntime(stubContext, { dataDir: dir }) }
}

/** 渲染一次工具卡片，把模型真正看到的文本取出来。 */
function renderedText(tool, value) {
  return tool.output.render({}, value).map((block) => String(block.text ?? '')).join('\n')
}

describe('厂商适配器：余额不足走专用错误码', () => {
  it('HTTP 402 + insufficient_credits → insufficient_credits，保留负余额原文', async () => {
    behavior = 'insufficient'
    const result = await generateImages(request())

    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'insufficient_credits')
    assert.notEqual(result.error.code, 'bad_request')
    assert.equal(result.error.retryable, false)
    assert.equal(result.error.status, 402)
    // 余额数值是用户判断"差多少钱"的唯一依据，不能被改写或截断。
    assert.match(result.error.message, /\$-0\.138427/)
    assert.match(result.error.message, /HTTP 402/)
    assert.match(result.error.message, /余额不足/)
  })

  it('402 不再触发降级链：只发一次请求（不重复计费）', async () => {
    behavior = 'insufficient'
    const result = await generateImages(request({ maxRetries: 2 }))

    assert.equal(result.ok, false)
    // 降级链有 5 档；归进 bad_request 时每一档都会被真实计费一次。
    assert.equal(hits, 1, `402 只应产生 1 次请求，实际 ${hits} 次`)
    assert.equal(result.attempts, 1)
    assert.deepEqual(result.degraded, [])
  })

  it('400 上显式的 insufficient_credits 同样识别（各家状态码不统一）', async () => {
    behavior = 'insufficient-as-400'
    const result = await generateImages(request())
    assert.equal(result.error.code, 'insufficient_credits')
    assert.match(result.error.message, /\$-0\.138427/)
  })

  it('200 包一层错误时也识别', async () => {
    behavior = 'insufficient-wrapped-200'
    const result = await generateImages(request())
    assert.equal(result.error.code, 'insufficient_credits')
    assert.match(result.error.message, /\$-0\.138427/)
  })

  it('5xx 不得被误标成余额不足（服务端故障 ≠ 账户没钱）', async () => {
    behavior = 'server-error'
    const result = await generateImages(request({ maxRetries: 1 }))

    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'server')
    assert.equal(result.error.message.includes('余额不足'), false)
    assert.equal(result.error.message.includes('insufficient'), false)
  })
})

describe('hint 是指令级的，不是散文', () => {
  it('余额不足的 hint 覆盖三层意思（充值 / 问用户 / 禁止自行合成）', () => {
    const hint = vendorFailureHint({ code: 'insufficient_credits', retryable: false })
    assert.equal(hint, INSUFFICIENT_CREDITS_HINT)
    // 1) 账户问题，重试无用，去充值
    assert.match(hint, /余额不足/)
    assert.match(hint, /充值/)
    assert.match(hint, /重试无用/)
    // 2) 必须先问用户
    assert.match(hint, /必须/)
    assert.match(hint, /ask_user_question/)
    assert.match(hint, /询问用户/)
    // 3) 严禁脚本合成 / 伪造
    assert.match(hint, /严禁/)
    assert.match(hint, /合成|伪造/)
    assert.match(hint, /PIL/)
  })

  it('其他错误码的 hint 保持原样，不夹带"问用户/禁止合成"', () => {
    assert.equal(vendorFailureHint({ code: 'server', retryable: true }), '该错误可重试；可直接再次调用本工具')
    assert.equal(
      vendorFailureHint({ code: 'auth', retryable: false }),
      '该错误重试无意义，请先修正配置或提示词',
    )
    assert.equal(vendorFailureHint({ code: 'bad_request', retryable: false }).includes('ask_user_question'), false)
  })
})

describe('工具层：错误码与 hint 原样传给模型', () => {
  it('pixmart_edit 失败返回 insufficient_credits + 指令级 hint（含余额）', async () => {
    behavior = 'insufficient'
    const { dir, runtime } = makeRuntime()
    try {
      const reference = join(dir, 'ref.png')
      writeFileSync(reference, PNG)

      const edit = createGenerateTools(runtime).find((tool) => tool.name === 'pixmart_edit')
      const result = await edit.execute(
        { module: 'tool.white-bg', size: '1:1', referencePaths: [reference] },
        stubExec,
      )

      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'insufficient_credits')
      assert.match(result.error.message, /\$-0\.138427/)
      assert.match(result.error.hint, /充值/)
      assert.match(result.error.hint, /ask_user_question/)
      assert.match(result.error.hint, /严禁/)

      // 模型读的是渲染后的卡片文本，hint 必须在里面。
      const text = renderedText(edit, result)
      assert.match(text, /失败 \[insufficient_credits\]/)
      assert.match(text, /ask_user_question/)
      assert.match(text, /严禁/)

      // 一次付费调用就是一次，不能因为降级链多花 5 次。
      assert.equal(hits, 1, `应只发 1 次厂商请求，实际 ${hits} 次`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('pixmart_batch 全项余额不足时给出同一条指令级提示', async () => {
    behavior = 'insufficient'
    const { dir, runtime } = makeRuntime()
    try {
      const batch = createBatchTool(runtime)
      const result = await batch.execute(
        {
          items: [{ module: 'main.white-bg' }, { module: 'main.scene' }],
          size: '1:1',
          concurrency: 1,
          project: 'credits',
        },
        stubExec,
      )

      assert.equal(result.ok, true) // 批量本身跑完了，只是每项都失败
      assert.equal(result.completed, 0)
      assert.equal(result.failed, 2)
      assert.equal(result.hint, INSUFFICIENT_CREDITS_HINT)
      assert.match(result.hint, /ask_user_question/)
      assert.equal(hits, 2, `两项各一次，实际 ${hits} 次`)

      const text = renderedText(batch, result)
      assert.match(text, /提示：/)
      assert.match(text, /严禁/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('成功路径不受影响（同一条链路仍能正常出图）', async () => {
    const { dir, runtime } = makeRuntime()
    try {
      const generate = createGenerateTools(runtime).find((tool) => tool.name === 'pixmart_generate')
      const result = await generate.execute({ module: 'main.white-bg', size: '1:1' }, stubExec)
      assert.equal(result.ok, true)
      assert.equal(result.images.length, 1)
      assert.equal(result.error, undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('guidance 硬规则', () => {
  it('付费失败要先问用户，且严禁脚本合成交付物', () => {
    assert.match(GUIDANCE_TEXT, /先停下/)
    assert.match(GUIDANCE_TEXT, /ask_user_question/)
    assert.match(GUIDANCE_TEXT, /不要自行降级/)
    assert.match(GUIDANCE_TEXT, /严禁/)
    assert.match(GUIDANCE_TEXT, /合成或伪造图片充当交付物/)
    assert.match(GUIDANCE_TEXT, /402/)
  })

  it('正文仍在 36 行以内（新增规则靠压缩既有句子，不抬上限）', () => {
    const lines = GUIDANCE_TEXT.split('\n').length
    assert.ok(lines <= 36, `说明不应超过 36 行，实际 ${lines} 行`)
  })

  it('不得夹带图片展示 / present 规则（ab6dad8 已整段删除）', () => {
    assert.equal(/present/.test(GUIDANCE_TEXT), false)
  })
})
