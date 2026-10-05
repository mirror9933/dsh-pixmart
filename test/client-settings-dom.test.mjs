/**
 * jsdom lane：设置页「可写」的渲染测试。
 *
 * 与 `providers-api.test.mjs` 的分工：
 *   - `providers-api.test.mjs` 锁**宿主**契约（路由、请求体、写盘、脱敏）；
 *   - 本文件把 `__test__.ProvidersSection` 真的挂进 jsdom，验证**客户端**那一半：
 *     表单能把值发出去（POST body 正确）、成功后重新拉 `api/providers`、
 *     失败在卡片内显示可读原因而**不抛异常/不白屏**、请求中按钮禁用。
 *
 * **零真实网络**：`fetch` 全部 stub，断言只看 stub 收到的请求与 DOM 文本。
 */
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

const SRC = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

const BASE_URL = 'http://127.0.0.1:19387/'
const PAGE = '<!doctype html><html><head></head><body></body></html>'
const JSDOM_OPTIONS = { url: BASE_URL, pretendToBeVisual: true }

const DOM_GLOBALS = ['HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle']

function installGlobals(entries) {
  const saved = new Map()
  for (const [key, value] of Object.entries(entries)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key) ?? null)
    if (value === undefined) continue
    try {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
    } catch {
      /* 装不上就用宿主自带的 */
    }
  }
  return () => {
    for (const [key, descriptor] of saved) {
      try {
        if (descriptor === null) delete globalThis[key]
        else Object.defineProperty(globalThis, key, descriptor)
      } catch {
        /* 恢复失败不影响结论 */
      }
    }
  }
}

function domEntries(win) {
  const entries = { window: win, document: win.document }
  for (const key of DOM_GLOBALS) if (win[key] !== undefined) entries[key] = win[key]
  return entries
}

// react-dom 在 import 时会探测 DOM 能力，先垫一个 jsdom。
const bootstrap = new JSDOM(PAGE, JSDOM_OPTIONS)
installGlobals(domEntries(bootstrap.window))
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = (await import('react')).default
const ReactDOMClient = await import('react-dom/client')
const ReactDOMTestUtils = await import('react-dom/test-utils')
const createRoot = ReactDOMClient.createRoot ?? ReactDOMClient.default?.createRoot
const act = React.act ?? ReactDOMTestUtils.act
const h = React.createElement

// ── 夹具数据 ────────────────────────────────────────────────────────────────

const SECRET = 'sk-client-secret-abcdef123456'

function providerView(over = {}) {
  return {
    id: 'ofox',
    label: 'Ofox',
    group: 'aggregator',
    baseUrl: 'https://api.example.test/v1',
    geminiNativeBaseUrl: '',
    dialect: 'standard',
    apiMode: 'images-generations',
    apiKeyEnv: '',
    hasApiKey: false,
    apiKeySource: 'none',
    models: [],
    allowedSizes: ['1:1', '3:4'],
    sizeMode: 'whitelist',
    timeoutMs: 180000,
    ...over,
  }
}

function providersPayload(over = {}) {
  return {
    ok: true,
    dataDir: 'D:/pixmart',
    dataDirNotes: [],
    warnings: [],
    defaults: { provider: 'ofox', model: '', size: '1:1', n: 1 },
    limits: { maxConcurrency: 2, maxBatchItems: 20, maxRetries: 3, retentionDays: 0 },
    providers: [providerView()],
    usage: { requests: 0, ok: 0, failed: 0, images: 0 },
    historical: { projects: 0, images: 0, note: '' },
    ...over,
  }
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

// ── lane ────────────────────────────────────────────────────────────────────

const openLanes = new Set()

/**
 * 起一个新页面并挂载 `ProvidersSection`。
 * @param options - `respond(url, init)` 决定每个请求的响应。
 */
async function createLane(options = {}) {
  const dom = new JSDOM(PAGE, JSDOM_OPTIONS)
  const win = dom.window
  const fetches = []
  let respond = options.respond ?? (() => jsonResponse(providersPayload()))

  const fetchImpl = (input, init) => {
    const url = String(input)
    const method = String(init?.method ?? 'GET').toUpperCase()
    fetches.push({ url, method, body: init?.body })
    let out
    try {
      out = respond(url, init)
    } catch (err) {
      out = Promise.reject(err)
    }
    return Promise.resolve(out)
  }

  const restoreGlobals = installGlobals({ ...domEntries(win), fetch: fetchImpl })

  let loaded = null
  win.__ModuleLoader__ = { load: (entry) => (loaded = entry) }
  new Function(SRC)()
  assert.ok(loaded !== null, 'bundle 必须通过 window.__ModuleLoader__.load 注册自己')

  const exported = loaded.factory((name) => {
    if (name === 'react') return React
    throw new Error('未预期的 require("' + String(name) + '")')
  })
  const bag = exported.__test__ ?? {}
  assert.equal(typeof bag.ProvidersSection, 'function', 'client.js 必须导出 __test__.ProvidersSection')

  const container = win.document.createElement('div')
  win.document.body.appendChild(container)
  const root = createRoot(container)
  const settle = () => new Promise((resolve) => setImmediate(resolve))

  const lane = {
    window: win,
    container,
    fetches,
    setRespond(next) {
      respond = next
    },
    text: () => container.textContent ?? '',
    buttons: () => [...container.querySelectorAll('button')],
    button(label) {
      return lane.buttons().find((node) => node.textContent.trim() === label) ?? null
    },
    inputs: () => [...container.querySelectorAll('input')],
    inputByPlaceholder(placeholder) {
      return lane.inputs().find((node) => node.getAttribute('placeholder') === placeholder) ?? null
    },
    selects: () => [...container.querySelectorAll('select')],
    postCalls: () => fetches.filter((call) => call.method === 'POST'),

    async render() {
      await act(async () => {
        root.render(h(bag.ProvidersSection, {}))
      })
      await settle()
      await settle()
    },

    async click(label) {
      const node = typeof label === 'string' ? lane.button(label) : label
      assert.ok(node, `按钮「${String(label)}」必须存在`)
      await act(async () => {
        node.click()
      })
      await settle()
      await settle()
    },

    async type(element, value) {
      assert.ok(element, '要输入的元素必须存在')
      const proto = win.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      await act(async () => {
        if (setter) setter.call(element, value)
        else element.value = value
        element.dispatchEvent(new win.Event('input', { bubbles: true }))
      })
      await settle()
    },

    async blur(element) {
      await act(async () => {
        element.dispatchEvent(new win.Event('blur', { bubbles: true }))
      })
      await settle()
      await settle()
    },

    /** 改 `<select>`：React 对 select 监听 change（也接受 input），两个都发。 */
    async select(element, value) {
      assert.ok(element, '要选择的下拉必须存在')
      const proto = win.HTMLSelectElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      await act(async () => {
        if (setter) setter.call(element, value)
        else element.value = value
        element.dispatchEvent(new win.Event('input', { bubbles: true }))
        element.dispatchEvent(new win.Event('change', { bubbles: true }))
      })
      await settle()
    },

    async dispose() {
      try {
        await act(async () => root.unmount())
      } catch {
        /* 卸载失败不改变用例结论 */
      }
      openLanes.delete(lane)
      restoreGlobals()
      try {
        win.close()
      } catch {
        /* 已关就算了 */
      }
    },
  }

  openLanes.add(lane)
  return lane
}

afterEach(async () => {
  for (const lane of [...openLanes].reverse()) {
    try {
      await lane.dispose()
    } catch {
      /* 清理失败不改变结论 */
    }
  }
})

// ── 用例 ────────────────────────────────────────────────────────────────────

describe('jsdom lane：设置页可写', () => {
  it('填密钥点保存 → POST credentials 带 apiKey，成功后自动重取 api/providers', async () => {
    const lane = await createLane({
      respond: (url, init) => {
        if (String(init?.method).toUpperCase() === 'POST') {
          return jsonResponse({ ok: true, provider: providerView({ hasApiKey: true, apiKeySource: 'config' }) })
        }
        return jsonResponse(providersPayload())
      },
    })
    await lane.render()

    const keyInput = lane.inputByPlaceholder('粘贴密钥')
    assert.ok(keyInput, '应有一个密钥输入框')
    assert.equal(keyInput.getAttribute('type'), 'password', '密钥输入框必须是 password')

    await lane.type(keyInput, SECRET)
    await lane.click('保存')
    await lane.click('刷新') // 触发一次显式 GET，便于数请求

    const posts = lane.postCalls()
    assert.equal(posts.length, 1, `应只有 1 次 POST，实际 ${posts.length}`)
    assert.match(posts[0].url, /\/providers\/ofox\/credentials$/)
    const sent = JSON.parse(String(posts[0].body))
    assert.equal(sent.apiKey, SECRET, 'POST 应把用户填的密钥发出去')

    // 写成功后要重新拉 api/providers：GET 至少 2 次（首屏 + 写后 + 手动刷新）
    const gets = lane.fetches.filter((call) => call.method === 'GET' && /\/api\/providers$/.test(call.url))
    assert.ok(gets.length >= 3, `写成功后应重新拉 providers，实际 GET ${gets.length} 次`)

    // 界面上不得出现密钥文本
    assert.equal(lane.text().includes(SECRET), false, '界面文本泄露了密钥')
    assert.ok(lane.text().includes('已保存'), '应给出成功提示')
  })

  it('点「拉取模型」→ POST refresh-models，提示拉到几个并刷新模型列表', async () => {
    let models = []
    const lane = await createLane({
      respond: (url, init) => {
        if (String(init?.method).toUpperCase() === 'POST' && /refresh-models$/.test(String(url))) {
          models = ['model-a', 'model-b']
          return jsonResponse({
            ok: true,
            models,
            count: models.length,
            provider: providerView({ models }),
          })
        }
        return jsonResponse(providersPayload({ providers: [providerView({ models })] }))
      },
    })
    await lane.render()

    await lane.click('拉取模型')

    const posts = lane.postCalls()
    assert.equal(posts.length, 1)
    assert.match(posts[0].url, /refresh-models$/)
    assert.equal(String(posts[0].body), '{}')
    assert.ok(lane.text().includes('已拉取 2 个模型'), '应提示拉到了几个模型')
    assert.ok(lane.text().includes('model-a'), '刷新后界面应显示新模型')
  })

  it('测试连接：成功显示耗时与模型数，失败显示可读原因且不抛异常', async () => {
    let mode = 'ok'
    const lane = await createLane({
      respond: (url, init) => {
        if (String(init?.method).toUpperCase() === 'POST' && /\/test$/.test(String(url))) {
          if (mode === 'ok') return jsonResponse({ ok: true, latencyMs: 42, modelCount: 3 })
          return jsonResponse({
            ok: false,
            latencyMs: 12,
            error: { code: 'auth', message: '密钥被拒（HTTP 401）' },
          })
        }
        return jsonResponse(providersPayload())
      },
    })
    await lane.render()

    await lane.click('测试连接')
    assert.ok(lane.text().includes('连接正常'), '成功应显示结果')

    mode = 'fail'
    await lane.click('测试连接')
    assert.ok(lane.text().includes('密钥被拒'), '失败应显示可读原因')
    assert.ok(lane.text().includes('auth'), '失败应带上结构化 code')
  })

  it('写失败：错误显示在卡片内，不抛异常、页面不白屏', async () => {
    const lane = await createLane({
      respond: (url, init) => {
        if (String(init?.method).toUpperCase() === 'POST') {
          return jsonResponse(
            { ok: false, error: { code: 'unknown_provider', message: '没有 id 为 "ofox" 的厂商' } },
            404,
          )
        }
        return jsonResponse(providersPayload())
      },
    })
    await lane.render()

    await lane.type(lane.inputByPlaceholder('粘贴密钥'), SECRET)
    await lane.click('保存')

    assert.ok(lane.text().includes('没有 id'), '应显示宿主返回的可读原因')
    assert.ok(lane.text().includes('unknown_provider'), '应带上错误 code')
    // 表单仍在（没有白屏）
    assert.ok(lane.button('保存'), '失败后表单仍应存在')
    assert.equal(lane.text().includes(SECRET), false, '错误提示里不得出现密钥')
  })

  it('请求进行中按钮禁用（防重复提交）', async () => {
    let release
    const pending = new Promise((resolve) => {
      release = () => resolve(jsonResponse({ ok: true, provider: providerView({ hasApiKey: true }) }))
    })
    const lane = await createLane({
      respond: (url, init) => {
        if (String(init?.method).toUpperCase() === 'POST') return pending
        return jsonResponse(providersPayload())
      },
    })
    await lane.render()

    await lane.type(lane.inputByPlaceholder('粘贴密钥'), SECRET)
    const saveButton = lane.button('保存')
    // 不 await：让请求停在途中
    await act(async () => {
      saveButton.click()
    })

    const during = lane.button('保存中…')
    assert.ok(during, '请求中按钮文案应变为「保存中…」')
    assert.equal(during.disabled, true, '请求中按钮必须禁用')

    await act(async () => {
      release()
    })
    await settleAll()
    assert.ok(lane.button('保存'), '请求结束后按钮应恢复')
  })

  it('默认值卡片：三个字段是可选的 select，模型选项来自当前厂商', async () => {
    const lane = await createLane({
      respond: () =>
        jsonResponse(
          providersPayload({
            providers: [providerView({ models: ['m-1', 'm-2'] })],
            defaults: { provider: 'ofox', model: 'm-2', size: '3:4', n: 1 },
          }),
        ),
    })
    await lane.render()

    const selects = lane.selects()
    assert.ok(selects.length >= 3, `应有至少 3 个 select（厂商/模型/尺寸），实际 ${selects.length}`)
    const options = selects.flatMap((node) => [...node.options].map((option) => option.value))
    assert.ok(options.includes('ofox'), '厂商 select 应含当前厂商')
    assert.ok(options.includes('m-1') && options.includes('m-2'), '模型 select 应含该厂商的模型')
    assert.ok(options.includes('3:4'), '尺寸 select 应含厂商允许的尺寸')
  })

  it('默认值卡片：选模型 + 保存 → POST defaults 带 provider/model/size', async () => {
    const lane = await createLane({
      respond: (url, init) => {
        if (String(init?.method).toUpperCase() === 'POST' && /\/api\/defaults$/.test(String(url))) {
          return jsonResponse({
            ok: true,
            defaults: { provider: 'ofox', model: 'm-1', size: '3:4', n: 2 },
          })
        }
        return jsonResponse(
          providersPayload({
            providers: [providerView({ models: ['m-1', 'm-2'] })],
            defaults: { provider: 'ofox', model: 'm-2', size: '1:1', n: 1 },
          }),
        )
      },
    })
    await lane.render()

    // select 的顺序：厂商 / 模型 / 尺寸
    const selects = lane.selects()
    await lane.select(selects[1], 'm-1')
    await lane.select(selects[2], '3:4')
    await lane.click('保存默认值')

    const posts = lane.postCalls()
    assert.equal(posts.length, 1, `应只有 1 次 POST，实际 ${posts.length}`)
    assert.match(posts[0].url, /\/api\/defaults$/)
    const sent = JSON.parse(String(posts[0].body))
    assert.equal(sent.provider, 'ofox')
    assert.equal(sent.model, 'm-1')
    assert.equal(sent.size, '3:4')
    assert.ok(lane.text().includes('已保存'), '保存成功应给出提示')
  })
})

async function settleAll() {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve))
}
