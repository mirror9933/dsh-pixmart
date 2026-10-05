/**
 * F1 / F2 / F3 的回归锁 —— 这三条都是 A2 真实生图才暴露出来的，
 * 因此每条都要有一个断言把成因钉住，避免"修好了又悄悄退回去"。
 *
 * 另外补上 §10.4 的教训：宿主对工具返回值做 schema 校验，
 * 声明 `additionalProperties: false` 而返回未声明字段会让调用**直接失败**。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { buildPrompt } from '../lib/prompts/build.js'
import { getModule } from '../lib/prompts/modules.js'
import { createTools } from '../lib/tools/index.js'

const stubContext = {
  tools: { register: () => () => {}, schemas: () => [] },
  get: () => undefined,
  effect: () => {},
  on: () => () => {},
}

const stubExec = {
  callId: 'test',
  signal: { aborted: false, addEventListener: () => {} },
  deferContext: () => {},
  concludeTurn: () => {},
}

describe('F2 —— 无参考图时剔除依赖参考图的描述', () => {
  it('文生图（默认）不含 reference 措辞；有参考图时保留', () => {
    const module = getModule('main.white-bg')
    assert.ok(module)

    const noRef = buildPrompt({ module })
    assert.equal(/reference/i.test(noRef.prompt), false, '无参考图时不应出现 reference')
    assert.ok(noRef.notes.some((note) => note.includes('F2')), '应记录剔除动作')

    const withRef = buildPrompt({ module, hasReferences: true })
    assert.equal(/reference/i.test(withRef.prompt), true, '有参考图时应保留原描述')
    assert.equal(withRef.notes.some((note) => note.includes('F2')), false)
  })

  it('剔除是按句进行的，不会留下残句', () => {
    const module = getModule('detail.detail')
    assert.ok(module)
    const built = buildPrompt({ module, hasReferences: false })
    // 不应出现连续空格（片段之间用空行分隔是正常的，所以只查空格）
    assert.equal(/ {2,}/.test(built.prompt), false)
    assert.equal(/^\s*[,;]/.test(built.prompt), false)
    assert.ok(built.prompt.length > 40)
  })
})

describe('F3 —— 无产品描述时不编造真实品牌', () => {
  it('缺 vars.product 时注入无品牌主体 + 品牌禁令', () => {
    const module = getModule('main.white-bg')
    const built = buildPrompt({ module })

    assert.equal(/unbranded/i.test(built.prompt), true, '应注入 unbranded 主体')
    assert.equal(/no real-world counterpart/i.test(built.prompt), true)
    assert.equal(/trademark/i.test(built.negative ?? ''), true, '负向提示应含品牌禁令')
    assert.ok(built.notes.some((note) => note.includes('F3')))
  })

  it('给了 vars.product 就不再注入（尊重用户描述）', () => {
    const module = getModule('main.white-bg')
    const built = buildPrompt({ module, vars: { product: 'a matte ceramic mug' } })

    // 用 F3 保护语特有的措辞判断，避免误伤模块文本里本就存在的词
    assert.equal(/no real-world counterpart/i.test(built.prompt), false)
    assert.equal(/trademark/i.test(built.negative ?? ''), false)
    assert.equal(built.prompt.includes('a matte ceramic mug'), true)
  })

  it('整模块覆盖时既不注入保护语也不剔除句子（用户接管）', () => {
    const module = getModule('main.white-bg')
    const built = buildPrompt({ module, overrides: { 'main.white-bg': 'KEEP reference stuff intact.' } })
    assert.equal(built.prompt, 'KEEP reference stuff intact.')
    assert.deepEqual([...built.notes], [])
  })

  it('有参考图时不注入（产品来自参考图）', () => {
    const module = getModule('tool.white-bg')
    const built = buildPrompt({ module, hasReferences: true })
    assert.equal(/unbranded/i.test(built.prompt), false)
  })
})

describe('F1 —— gemini-native 必须带 responseModalities', () => {
  it('缺它会整体忽略 generationConfig（实测 1408x768 vs 1024x1024）', async () => {
    const seen = []
    const server = await import('node:http').then(({ createServer }) =>
      createServer((req, res) => {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
          seen.push(JSON.parse(body))
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        inlineData: {
                          mimeType: 'image/png',
                          data:
                            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
                        },
                      },
                    ],
                  },
                },
              ],
            }),
          )
        })
      }),
    )

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    try {
      const { generateImages } = await import('../lib/vendor/openai-compat.js')
      const { defaultOfoxProvider } = await import('../lib/config.js')

      const provider = {
        ...defaultOfoxProvider(),
        baseUrl: `http://127.0.0.1:${port}/v1`,
        geminiNativeBaseUrl: `http://127.0.0.1:${port}/gemini/v1beta`,
      }

      const result = await generateImages({
        provider,
        apiKey: 'k',
        model: 'google/gemini-3.1-flash-lite-image',
        prompt: 'x',
        size: '3:4',
        n: 1,
        references: [],
        maxRetries: 0,
      })

      assert.equal(result.ok, true)
      const generationConfig = seen[0].generationConfig
      assert.ok(generationConfig, '必须带 generationConfig')
      assert.deepEqual(generationConfig.responseModalities, ['TEXT', 'IMAGE'])
      assert.equal(generationConfig.imageConfig.aspectRatio, '3:4')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

describe('§10.4 —— 工具返回值必须能通过宿主的 schema 校验', () => {
  const tools = createTools(stubContext, {})

  it('声明了 additionalProperties:false 的工具，其返回字段必须全部已声明', async () => {
    for (const tool of tools) {
      if (tool.output.schema.additionalProperties !== false) continue
      // 这类工具必须能被调用来取真实返回；ping 是唯一无副作用、无依赖的
      assert.equal(tool.name, 'pixmart_ping', `${tool.name} 用了 additionalProperties:false`)
      const value = await tool.execute({ echo: 'x' }, stubExec)
      const declared = new Set(Object.keys(tool.output.schema.properties ?? {}))
      for (const key of Object.keys(value)) {
        assert.ok(declared.has(key), `${tool.name} 返回了未声明字段 "${key}"`)
      }
    }
  })

  it('开放型 schema 不得写成 additionalProperties:false', () => {
    // 六个工具里除 ping 外都返回动态字段或 error 对象，必须是开放型。
    const closed = tools
      .filter((tool) => tool.output.schema.additionalProperties === false)
      .map((tool) => tool.name)
    assert.deepEqual(closed, ['pixmart_ping'])
  })

  it('每个工具都有描述与 params schema（注册的前置条件）', () => {
    assert.equal(tools.length, 6)
    for (const tool of tools) {
      assert.ok(tool.name.startsWith('pixmart_'), tool.name)
      assert.ok(tool.description.length > 40, `${tool.name} 描述过短`)
      assert.equal(typeof tool.parameters, 'object')
    }
  })
})
