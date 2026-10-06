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
    /**
     * 设置页的自绘下拉触发器（`SelectField`）。
     *
     * 2026-10-09 控件形态复刻：设置页不再有原生 `<select>`（官方 client 侧也没有），
     * 下拉 = `<button class="pxm-select-trigger">` + `role="menu"` 弹层。定位锚点是
     * `data-pxm-role="select"`（语义角色），不是类名。
     */
    selectTriggers: () => [...container.querySelectorAll('[data-pxm-role="select"]')],
    selectTriggerByLabel(label) {
      const field = [...container.querySelectorAll('[data-pxm-field]')].find((node) =>
        (node.querySelector('[data-pxm-field-label]')?.textContent ?? '').includes(label),
      )
      return field?.querySelector('[data-pxm-role="select"]') ?? null
    },
    /** 弹层（只在展开时存在）。 */
    selectList: () => container.querySelector('[data-pxm-select-list]'),
    /** 触发器上显示的当前值文本。 */
    selectValue: (trigger) => (trigger?.querySelector('span')?.textContent ?? '').trim(),
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

    /**
     * 走**自绘下拉**选一项：点触发器展开（断言弹层真的出现）→ 点目标 `menuitem`。
     *
     * 这条路径同时覆盖了原生 `<select>` 换掉之后必须仍然成立的可用性：
     * 触发器是 `<button>`（Tab 可达、Enter/Space 原生激活）、弹层是 `role="menu"`、
     * 选项是 `role="menuitem"`。键盘路径另见 `test/browser/controls.test.mjs`。
     */
    async pick(trigger, optionValue) {
      assert.ok(trigger, '要操作的下拉触发器必须存在')
      await act(async () => {
        trigger.click()
      })
      await settle()
      const list = lane.selectList()
      assert.ok(list, '点开下拉后必须出现 role="menu" 弹层')
      const option = list.querySelector('[data-pxm-option="' + String(optionValue) + '"]')
      assert.ok(option, `弹层里必须有一项 value="${String(optionValue)}"`)
      await act(async () => {
        option.click()
      })
      await settle()
      await settle()
    },

    /**
     * 按 `--dsw-*` token 的**解析值**比色：证明某个元素的描边/底色真的挂在 token 上，
     * 而不是"源码里写了 var(...)、浏览器没解析到"。
     */
    resolvedToken(token) {
      return win.getComputedStyle(win.document.documentElement).getPropertyValue(token).trim()
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
    // 保存时必须同时清空 apiKeyEnv：环境变量**优先于**本页填写的密钥，
    // 只留字段会变成"哪天环境变量被设上，这里的 key 就静默失效且无从察觉"。
    assert.equal(sent.apiKeyEnv, '', '保存时应显式清空 apiKeyEnv，避免环境变量静默覆盖')

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

  it('默认值卡片：三个字段是自绘下拉，模型选项来自当前厂商', async () => {
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

    /*
     * 2026-10-09 起设置页下拉是**自绘**的（官方 client 侧没有原生 `<select>`）：
     * 断言随之从"读 `<option>` 的 value"改成"展开弹层读 `data-pxm-option`"——
     * 强度没有降低（仍然逐个证明该厂商/该尺寸真的在选项里），只是换了定位方式。
     */
    const triggers = lane.selectTriggers()
    assert.ok(triggers.length >= 3, `应有至少 3 个自绘下拉（厂商/模型/尺寸），实际 ${triggers.length}`)
    const settleOnce = () => new Promise((resolve) => setImmediate(resolve))
    const values = []
    for (const trigger of triggers) {
      await act(async () => {
        trigger.click()
      })
      await settleOnce()
      const list = lane.selectList()
      assert.ok(list, '展开后必须有弹层')
      values.push(
        ...[...list.querySelectorAll('[data-pxm-option]')].map((node) =>
          node.getAttribute('data-pxm-option'),
        ),
      )
      await act(async () => {
        trigger.click()
      })
      await settleOnce()
    }
    assert.ok(values.includes('ofox'), '厂商下拉应含当前厂商')
    assert.ok(values.includes('m-1') && values.includes('m-2'), '模型下拉应含该厂商的模型')
    assert.ok(values.includes('3:4'), '尺寸下拉应含厂商允许的尺寸')
    // 默认模型在列表里时不得出现警告
    assert.equal(
      lane.text().includes('不在当前厂商的模型列表里'),
      false,
      '默认模型在列表里时不应出现警告',
    )
  })

  it('默认值卡片：默认模型不在厂商列表里时给出显式警告（不只在展开下拉后才可见）', async () => {
    const lane = await createLane({
      respond: () =>
        jsonResponse(
          providersPayload({
            // 场景：拉取后把模型列表窄化成 m-1/m-2，而默认值仍指向旧的 m-9
            providers: [providerView({ models: ['m-1', 'm-2'] })],
            defaults: { provider: 'ofox', model: 'm-9', size: '1:1', n: 1 },
          }),
        ),
    })
    await lane.render()

    assert.ok(
      lane.text().includes('不在当前厂商的模型列表里'),
      '应给出可读的警告，而不是只把问题藏在展开后的下拉选项里',
    )
    // 仍然不抛异常、界面照常可用（这是"提示"不是"阻断"）
    assert.ok(lane.button('保存默认值'), '警告不应阻断保存')
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

    // 下拉的顺序：厂商 / 模型 / 尺寸
    const triggers = lane.selectTriggers()
    assert.ok(triggers.length >= 3, `应有至少 3 个自绘下拉，实际 ${triggers.length}`)
    await lane.pick(triggers[1], 'm-1')
    await lane.pick(triggers[2], '3:4')
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

  it('默认值卡片：尺寸候选用宿主给的 sizeOptions（值是像素、标签是「档位 · 比例」）', async () => {
    // 这是"设置页能选 1K–4K"的接线点：**词表由宿主出**（sizes.ts 的官方表），
    // 客户端只渲染。所以这里钉住两件事：显示的是 label、存下去的是 value。
    const lane = await createLane({
      respond: (url, init) => {
        if (String(init?.method).toUpperCase() === 'POST' && /\/api\/defaults$/.test(String(url))) {
          return jsonResponse({
            ok: true,
            defaults: { provider: 'agnes', model: 'a-1', size: '2048x2048', n: 1 },
          })
        }
        return jsonResponse(
          providersPayload({
            providers: [
              providerView({
                id: 'agnes',
                label: 'Agnes AI',
                dialect: 'agnes',
                models: ['a-1'],
                allowedSizes: ['1:1', '3:4'],
                sizeOptions: [
                  { value: '1024x1024', label: '1K · 1:1' },
                  { value: '2048x2048', label: '2K · 1:1' },
                  { value: '2624x1472', label: '2K · 16:9' },
                ],
              }),
            ],
            defaults: { provider: 'agnes', model: 'a-1', size: '1024x1024', n: 1 },
          }),
        )
      },
    })
    await lane.render()

    const triggers = lane.selectTriggers()
    const sizeTrigger = triggers[2] // 下拉顺序：厂商 / 模型 / 尺寸
    assert.equal(
      lane.selectValue(sizeTrigger),
      '1K · 1:1',
      '默认值 1024x1024 在界面上应显示为「1K · 1:1」——这就是档位可见的证据',
    )
    await lane.pick(sizeTrigger, '2048x2048')
    assert.equal(lane.selectValue(sizeTrigger), '2K · 1:1', '选完应显示 2K')
    await lane.click('保存默认值')

    const posts = lane.postCalls()
    assert.equal(posts.length, 1, `应只有 1 次 POST，实际 ${posts.length}`)
    const sent = JSON.parse(String(posts[0].body))
    assert.equal(sent.size, '2048x2048', '存下去的必须是原始像素写法，不是给人看的标签')
  })

  it('默认值卡片：换厂商时把"上一个厂商专属"的尺寸换掉（不留无效默认值）', async () => {
    // agnes 的档位要落到精确像素（2048x2048），这个写法对 ofox 无效。
    // 切厂商时若当前值不在新候选里，必须自动退回新厂商的第一项。
    const lane = await createLane({
      respond: () =>
        jsonResponse(
          providersPayload({
            providers: [
              providerView({
                id: 'agnes',
                label: 'Agnes AI',
                dialect: 'agnes',
                models: ['a-1'],
                sizeOptions: [{ value: '2048x2048', label: '2K · 1:1' }],
              }),
              providerView({ id: 'ofox', label: 'Ofox', models: ['o-1'], allowedSizes: ['1:1', '3:4'] }),
            ],
            defaults: { provider: 'agnes', model: 'a-1', size: '2048x2048', n: 1 },
          }),
        ),
    })
    await lane.render()

    const triggers = lane.selectTriggers()
    assert.equal(lane.selectValue(triggers[2]), '2K · 1:1', '初始是 agnes 的 2K')
    await lane.pick(triggers[0], 'ofox') // 厂商
    await lane.click('保存默认值')

    const posts = lane.postCalls()
    assert.equal(posts.length, 1, `应只有 1 次 POST，实际 ${posts.length}`)
    const sent = JSON.parse(String(posts[0].body))
    assert.equal(sent.provider, 'ofox')
    assert.equal(sent.size, '1:1', 'agnes 的 2048x2048 不能带到 ofox 名下')
  })
})

// ── 模型选择面板：拉取 = 只读，选择 = 显式保存 ────────────────────────────────

/**
 * 拉取回来的"厂商模型目录"：故意混入纯文本模型，用来验证搜索 / 全选的作用域
 * 与「只选图像模型」的启发式（命中的是 gemini.*image / gpt-image / flux / qwen.*image）。
 */
const PULLED_MODELS = [
  'google/gemini-3.1-flash-image',
  'openai/gpt-image-1',
  'openai/gpt-4o-mini',
  'black-forest-labs/flux-1.1-pro',
  'anthropic/claude-3-opus',
  'qwen/qwen-image-edit',
  'text-embedding-3-large',
]

const IMAGE_MODELS = [
  'google/gemini-3.1-flash-image',
  'openai/gpt-image-1',
  'black-forest-labs/flux-1.1-pro',
  'qwen/qwen-image-edit',
]

/** 名字里含 `image` 子串的三个（`flux` 不含，用来证明搜索与启发式是两件事）。 */
const IMAGE_BY_NAME = [
  'google/gemini-3.1-flash-image',
  'openai/gpt-image-1',
  'qwen/qwen-image-edit',
]

/** 面板里某一行（label）的复选框。 */
function checkboxFor(lane, name) {
  const rows = [...lane.container.querySelectorAll('label')]
  const row = rows.find((node) => (node.textContent ?? '').includes(name)) ?? null
  assert.ok(row, `模型行「${name}」必须存在`)
  return row.querySelector('input[type="checkbox"]')
}

const checkboxes = (lane) => [...lane.container.querySelectorAll('input[type="checkbox"]')]
const checkedNames = (lane) =>
  checkboxes(lane)
    .filter((node) => node.checked === true)
    .map((node) => (node.parentNode?.textContent ?? '').replace('图像', ''))

function buttonContaining(lane, text) {
  return lane.buttons().find((node) => (node.textContent ?? '').includes(text)) ?? null
}

/**
 * 「作品库导出路径」卡片本身（含该标题、且是 flex-column 的最内层容器）。
 *
 * 2026-10-09 控件形态复刻后，卡片内部的字段改成**行式** `Field`（左列标签/说明 +
 * 右列控件），标题文字不再直接住在卡片容器里，所以这里**不能**再靠
 * `textContent.includes(...)` 收集候选（那样会连外层 `.pxm-settings` 一起收进来，
 * 末尾那个候选不再是卡片）。改成按卡片自身的样式特征定位：`flex-direction:column`
 * + `padding:12px 14px`（官方 `_3nPmjq_rowCard` 那一档，见 client.js `skin.card`）。
 * 卡片里也有一个文案为「保存」的按钮，与厂商卡片的重名，所以断言必须限定在卡内。
 */
function exportDirCard(lane) {
  const candidates = [...lane.container.querySelectorAll('div')].filter(
    (node) =>
      (node.textContent ?? '').includes('作品库导出路径') &&
      node.style.display === 'flex' &&
      node.style.flexDirection === 'column' &&
      node.style.padding === '12px 14px',
  )
  const card = candidates[candidates.length - 1] ?? null
  assert.ok(card, '必须渲染出「作品库导出路径」卡片')
  return card
}

const exportDirInput = (lane) => exportDirCard(lane).querySelector('input')
const exportDirButton = (lane, label) =>
  [...exportDirCard(lane).querySelectorAll('button')].find(
    (node) => node.textContent.trim() === label,
  ) ?? null

/**
 * 起一个"已拉取过模型"的场景并点掉「拉取模型」按钮。
 * @param options - `savedModels` 是保存后配置里的模型；`saveError` 让保存失败。
 */
async function createPullLane(options = {}) {
  const saved = { models: options.savedModels ?? [] }
  const lane = await createLane({
    respond: (url, init) => {
      const method = String(init?.method ?? 'GET').toUpperCase()
      const target = String(url)
      if (method === 'POST' && /refresh-models$/.test(target)) {
        return jsonResponse({
          ok: true,
          models: PULLED_MODELS,
          count: PULLED_MODELS.length,
          provider: providerView({ models: saved.models }),
        })
      }
      if (method === 'POST' && /\/models$/.test(target)) {
        if (options.saveError) return jsonResponse({ ok: false, error: options.saveError }, 400)
        saved.models = JSON.parse(String(init?.body ?? '{}')).models ?? []
        return jsonResponse({
          ok: true,
          provider: providerView({ models: saved.models }),
          count: saved.models.length,
        })
      }
      return jsonResponse(providersPayload({ providers: [providerView({ models: saved.models })] }))
    },
  })
  await lane.render()
  await lane.click('拉取模型')
  return lane
}

describe('jsdom lane：模型选择面板', () => {
  it('拉取后面板展开：每个模型一行（内部滚动），搜索按子串过滤且大小写不敏感', async () => {
    const lane = await createPullLane()

    assert.equal(checkboxes(lane).length, PULLED_MODELS.length, '每个模型一行复选框')

    // 150 项不能把卡片撑爆：必须有一个 max-height 320px 的内部滚动容器
    // （320 = 官方 `._3nPmjq_candidateList{max-height:320px}`；2026-10-12 由 240px 改到官方值，
    // 见 docs/contract-notes.md §24.4 —— 更新断言到官方值，不是放宽：上限与内部滚动都还在）
    const scroller = [...lane.container.querySelectorAll('div')].find(
      (node) => node.style.maxHeight === '320px',
    )
    assert.ok(scroller, '列表必须放在 max-height: 320px 的滚动容器里')
    assert.equal(scroller.style.overflowY, 'auto')

    const search = lane.inputByPlaceholder('搜索模型…')
    assert.ok(search, '面板必须有搜索框')

    await lane.type(search, 'GEMINI') // 大小写不敏感
    assert.equal(checkboxes(lane).length, 1, '搜索后只应剩匹配的行')
    assert.ok(lane.text().includes('google/gemini-3.1-flash-image'))

    await lane.type(search, 'image')
    assert.equal(checkboxes(lane).length, IMAGE_BY_NAME.length, "'image' 应命中三个模型")

    await lane.type(search, '')
    assert.equal(checkboxes(lane).length, PULLED_MODELS.length, '清空搜索后应恢复全部行')
  })

  it('「全选（当前 N 个）」只选中筛选结果；保存 POST 的是已选子集', async () => {
    const lane = await createPullLane()

    await lane.type(lane.inputByPlaceholder('搜索模型…'), 'image')
    const selectAll = buttonContaining(lane, '全选（当前')
    assert.ok(selectAll, '必须有写明"当前 N 个"的全选按钮')
    assert.ok(
      selectAll.textContent.includes('全选（当前 3 个）'),
      `按钮文案要写明作用域，实际「${String(selectAll.textContent)}」`,
    )
    await lane.click(selectAll)

    assert.ok(lane.text().includes('已选 3 / 共 7'), '应显示「已选 N / 共 M」')
    assert.deepEqual(checkedNames(lane).sort(), [...IMAGE_BY_NAME].sort(), '只应选中当前筛选结果')
    assert.equal(checkedNames(lane).includes('anthropic/claude-3-opus'), false, '未被筛选的行不该被选中')

    // 再选一个不在筛选结果里的行：选择是累积的
    await lane.type(lane.inputByPlaceholder('搜索模型…'), 'claude')
    await lane.click(checkboxFor(lane, 'anthropic/claude-3-opus'))
    await lane.type(lane.inputByPlaceholder('搜索模型…'), '')

    await lane.click('保存选择')

    const posts = lane.postCalls().filter((call) => /\/models$/.test(call.url))
    assert.equal(posts.length, 1, `应只有 1 次 POST .../models，实际 ${posts.length}`)
    const sent = JSON.parse(String(posts[0].body))
    // 只提交**已选子集**，且保持拉取列表的顺序
    assert.deepEqual(sent.models, [
      'google/gemini-3.1-flash-image',
      'openai/gpt-image-1',
      'anthropic/claude-3-opus',
      'qwen/qwen-image-edit',
    ])
    assert.equal(lane.text().includes('anthropic/claude-3-opus'), true)
  })

  it('「全不选（当前 N 个）」只取消筛选结果；「只选图像模型」按启发式命中并加「图像」标记', async () => {
    const lane = await createPullLane()

    // 「图像」标记只出现在命中的行上
    const marked = [...lane.container.querySelectorAll('label')].filter((node) =>
      (node.textContent ?? '').includes('图像'),
    )
    assert.equal(marked.length, IMAGE_MODELS.length, '命中的行应带「图像」标记')

    await lane.click(buttonContaining(lane, '只选图像模型'))
    assert.deepEqual(checkedNames(lane).sort(), [...IMAGE_MODELS].sort())
    assert.ok(lane.text().includes('已选 4 / 共 7'))

    // 全不选只作用于筛选结果：先筛 'openai'（2 行），取消后其余选择应保留
    await lane.type(lane.inputByPlaceholder('搜索模型…'), 'openai')
    await lane.click(buttonContaining(lane, '全不选（当前 2 个）'))
    // 被筛掉的行不渲染，所以要先清空搜索再看剩下的选择
    await lane.type(lane.inputByPlaceholder('搜索模型…'), '')
    assert.deepEqual(checkedNames(lane).sort(), [
      'black-forest-labs/flux-1.1-pro',
      'google/gemini-3.1-flash-image',
      'qwen/qwen-image-edit',
    ])
    assert.ok(lane.text().includes('已选 3 / 共 7'), '计数要跟得上：被筛掉的选择仍然算数')
  })

  it('保存成功 → 重取 api/providers、收起面板、给出成功提示，「模型」行反映最新配置', async () => {
    const lane = await createPullLane()

    await lane.click(checkboxFor(lane, 'openai/gpt-image-1'))
    await lane.click('保存选择')

    const postIndex = lane.fetches.findIndex(
      (call) => call.method === 'POST' && /\/models$/.test(call.url),
    )
    assert.ok(postIndex >= 0, '必须发出 POST .../models')
    const refreshed = lane.fetches
      .slice(postIndex + 1)
      .filter((call) => call.method === 'GET' && /\/api\/providers$/.test(call.url))
    assert.ok(refreshed.length >= 1, '写成功后必须重新取 api/providers')

    assert.equal(checkboxes(lane).length, 0, '保存后面板应收起')
    assert.ok(lane.text().includes('已保存 1 个模型'), '应给出成功提示')
    assert.ok(lane.text().includes('模型：openai/gpt-image-1'), '「模型」行必须反映最新配置')
  })

  it('保存失败：错误显示在面板内（只取 code/message），面板不消失、按钮恢复、不白屏', async () => {
    const lane = await createPullLane({
      saveError: { code: 'too_many_models', message: '模型数量超过上限 500（收到 501 个）' },
    })

    await lane.click(checkboxFor(lane, 'openai/gpt-image-1'))
    await lane.click('保存选择')

    assert.ok(lane.text().includes('模型数量超过上限 500'), '应显示宿主返回的可读原因')
    assert.ok(lane.text().includes('too_many_models'), '应带上结构化 code')
    assert.equal(checkboxes(lane).length, PULLED_MODELS.length, '失败后面板仍在（没白屏）')
    assert.ok(lane.button('保存选择'), '失败后按钮应恢复可用')
    assert.ok(lane.button('取消'), '失败后仍能取消')
  })

  it('「取消」收起面板且不写入；之后能重新打开接着选（不必再拉一次）', async () => {
    const lane = await createPullLane({ savedModels: ['openai/gpt-image-1'] })

    // 初始选择 = 当前配置里仍存在于拉取结果中的模型
    assert.deepEqual(checkedNames(lane), ['openai/gpt-image-1'])
    assert.ok(lane.text().includes('已选 1 / 共 7'))

    await lane.click('取消')
    assert.equal(checkboxes(lane).length, 0, '取消后面板应收起')
    assert.equal(
      lane.postCalls().filter((call) => /\/models$/.test(call.url)).length,
      0,
      '取消不得写配置',
    )
    assert.equal(
      lane.postCalls().filter((call) => /refresh-models$/.test(call.url)).length,
      1,
      '取消不该重新拉取',
    )

    const reopen = buttonContaining(lane, '选择模型（7 个）')
    assert.ok(reopen, '收起后应能重新打开面板')
    await lane.click(reopen)
    assert.equal(checkboxes(lane).length, PULLED_MODELS.length)
    assert.deepEqual(checkedNames(lane), ['openai/gpt-image-1'], '重开后仍按当前配置预选')
  })

  it('保存进行中：按钮禁用并显示「保存中…」', async () => {
    let release
    const pending = new Promise((resolve) => {
      release = () =>
        resolve(
          jsonResponse({
            ok: true,
            provider: providerView({ models: ['openai/gpt-image-1'] }),
            count: 1,
          }),
        )
    })
    const lane = await createLane({
      respond: (url, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase()
        const target = String(url)
        if (method === 'POST' && /refresh-models$/.test(target)) {
          return jsonResponse({
            ok: true,
            models: PULLED_MODELS,
            count: PULLED_MODELS.length,
            provider: providerView(),
          })
        }
        if (method === 'POST' && /\/models$/.test(target)) return pending
        return jsonResponse(providersPayload())
      },
    })
    await lane.render()
    await lane.click('拉取模型')
    await lane.click(checkboxFor(lane, 'openai/gpt-image-1'))

    // 不 await：让请求停在途中
    await act(async () => {
      lane.button('保存选择').click()
    })

    const during = lane.button('保存中…')
    assert.ok(during, '请求中按钮文案应变为「保存中…」')
    assert.equal(during.disabled, true, '请求中「保存选择」必须禁用')
    assert.equal(lane.button('取消').disabled, true, '请求中「取消」也必须禁用')

    await act(async () => {
      release()
    })
    await settleAll()
    assert.equal(checkboxes(lane).length, 0, '保存成功后应收起面板')
    assert.ok(lane.text().includes('已保存 1 个模型'), '保存成功后应给提示')
  })

  it('卸载后落地的响应不再有副作用：不重取 api/providers、不抛异常、不刷警告', async () => {
    // 直接挂 `ProviderCard`（而不是整个设置页），这样 `reload` 是可数的 spy：
    // 卸载后如果还跑 `props.reload()`，就等于对已卸载的父组件 setState。
    const warnings = []
    const savedConsoleError = console.error
    console.error = (...args) => {
      warnings.push(args.map((item) => String(item)).join(' '))
    }
    const dom = new JSDOM(PAGE, JSDOM_OPTIONS)
    const win = dom.window
    let restore = () => {}
    let root = null
    try {
      let release
      const pending = new Promise((resolve) => {
        release = () =>
          resolve(
            jsonResponse({
              ok: true,
              models: PULLED_MODELS,
              count: PULLED_MODELS.length,
              provider: providerView({ models: PULLED_MODELS }),
            }),
          )
      })
      const fetchImpl = (input, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase()
        if (method === 'POST' && /refresh-models$/.test(String(input))) {
          return Promise.resolve(pending)
        }
        return Promise.resolve(jsonResponse(providersPayload()))
      }
      restore = installGlobals({ ...domEntries(win), fetch: fetchImpl })

      let loaded = null
      win.__ModuleLoader__ = { load: (entry) => (loaded = entry) }
      new Function(SRC)()
      const exported = loaded.factory((name) => {
        if (name === 'react') return React
        throw new Error('未预期的 require("' + String(name) + '")')
      })

      let reloads = 0
      const container = win.document.createElement('div')
      win.document.body.appendChild(container)
      root = createRoot(container)
      await act(async () => {
        root.render(
          h(exported.__test__.ProviderCard, {
            provider: providerView(),
            index: 0,
            reload: () => {
              reloads += 1
            },
          }),
        )
      })
      await settleAll()

      const refresh = [...container.querySelectorAll('button')].find(
        (node) => node.textContent.trim() === '拉取模型',
      )
      assert.ok(refresh, '卡片上必须有「拉取模型」按钮')

      // 让请求停在途中，然后卸载
      await act(async () => {
        refresh.click()
      })
      await act(async () => {
        root.unmount()
      })
      root = null
      const settled = reloads

      await act(async () => {
        release()
      })
      await settleAll()

      assert.equal(reloads, settled, '卸载后不得再触发重取（那是往已卸载组件 setState）')
      assert.deepEqual(warnings, [], '卸载后不应有 setState / act 警告')
    } finally {
      if (root !== null) {
        try {
          await act(async () => root.unmount())
        } catch {
          /* 清理失败不改变结论 */
        }
      }
      console.error = savedConsoleError
      restore()
      try {
        win.close()
      } catch {
        /* 已关就算了 */
      }
    }
  })
})

// ── 作品库导出路径 ───────────────────────────────────────────────────────────

describe('jsdom lane：作品库导出路径卡片', () => {
  it('渲染当前值与"生成时不再自动复制"的说明；未设置时提示"未设置"', async () => {
    const lane = await createLane({
      respond: () => jsonResponse(providersPayload({ exportDir: 'D:/PixMartExport' })),
    })
    await lane.render()

    const input = exportDirInput(lane)
    assert.ok(input, '卡片里应有输入框')
    assert.equal(input.value, 'D:/PixMartExport', '输入框应显示当前 exportDir')
    // 语义变更的核心说明必须写清：生成不再自动复制，只有点「导出」才会复制
    assert.ok(lane.text().includes('生成时不再自动复制任何文件'), '必须写明生成时不再自动复制')
    assert.ok(lane.text().includes('只有你在作品库点「导出」时'), '必须写明只有导出时才复制')
    assert.ok(lane.text().includes('作品库'), '说明里应指出查看入口')
    assert.equal(lane.text().includes('未设置'), false, '已设置时不该显示"未设置"')

    // 未设置（宿主回空串）时：输入框为空，标记为未设置
    const empty = await createLane({
      respond: () => jsonResponse(providersPayload({ exportDir: '' })),
    })
    await empty.render()
    assert.equal(exportDirInput(empty).value, '')
    assert.ok(empty.text().includes('未设置'))
    assert.ok(empty.text().includes('导出按钮会提示你先来这里填'), '未配置时要说明导出按钮的行为')
  })

  it('点「保存」→ POST settings/export-dir 带 exportDir，成功后重取 api/providers', async () => {
    const posted = []
    let current = 'D:/PixMartExport'
    const lane = await createLane({
      respond: (url, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase()
        if (method === 'POST' && /\/api\/settings\/export-dir$/.test(String(url))) {
          const body = JSON.parse(String(init?.body ?? '{}'))
          posted.push(body)
          current = body.exportDir
          return jsonResponse({ ok: true, exportDir: current })
        }
        return jsonResponse(providersPayload({ exportDir: current }))
      },
    })
    await lane.render()

    await lane.type(exportDirInput(lane), 'E:/pixmart-export')
    await lane.click(exportDirButton(lane, '保存'))

    assert.equal(posted.length, 1, `应只有 1 次 POST，实际 ${posted.length}`)
    assert.deepEqual(posted[0], { exportDir: 'E:/pixmart-export' }, 'POST body 必须只带 exportDir')
    // 成功后重取
    const gets = lane.fetches.filter((call) => call.method === 'GET' && /\/api\/providers$/.test(call.url))
    assert.ok(gets.length >= 2, `写成功后应重新取 api/providers，实际 GET ${gets.length} 次`)
    assert.ok(lane.text().includes('已保存'), '应给出成功提示')
    assert.equal(exportDirInput(lane).value, 'E:/pixmart-export', '界面应反映保存后的值')
  })

  it('点「清除」→ POST exportDir:""（回到未配置）', async () => {
    const posted = []
    let current = 'D:/PixMartExport'
    const lane = await createLane({
      respond: (url, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase()
        if (method === 'POST' && /\/api\/settings\/export-dir$/.test(String(url))) {
          const body = JSON.parse(String(init?.body ?? '{}'))
          posted.push(body)
          current = body.exportDir
          return jsonResponse({ ok: true, exportDir: current })
        }
        return jsonResponse(providersPayload({ exportDir: current }))
      },
    })
    await lane.render()

    await lane.click(exportDirButton(lane, '清除'))

    assert.deepEqual(posted, [{ exportDir: '' }], '清除必须发空串')
    assert.ok(lane.text().includes('已清除'), '应给出清除提示')
    assert.equal(exportDirInput(lane).value, '')
    assert.ok(lane.text().includes('未设置'))
  })

  it('失败 → 卡片内显示可读原因与 code，不抛异常、按钮恢复、不白屏', async () => {
    const lane = await createLane({
      respond: (url, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase()
        if (method === 'POST' && /\/api\/settings\/export-dir$/.test(String(url))) {
          return jsonResponse(
            {
              ok: false,
              error: { code: 'invalid_export_dir', message: '作品库导出路径必须是绝对路径："out"' },
            },
            400,
          )
        }
        return jsonResponse(providersPayload({ exportDir: '' }))
      },
    })
    await lane.render()

    await lane.type(exportDirInput(lane), 'out')
    await lane.click(exportDirButton(lane, '保存'))

    assert.ok(lane.text().includes('必须是绝对路径'), '应显示宿主返回的可读原因')
    assert.ok(lane.text().includes('invalid_export_dir'), '应带上结构化 code')
    const again = exportDirButton(lane, '保存')
    assert.ok(again, '失败后卡片仍在（没白屏）')
    assert.equal(again.disabled, false, '失败后按钮应恢复可用')
  })

  it('输入框失焦即保存；且「清除」压过这次失焦（不会把新输入当保存）', async () => {
    const posted = []
    let current = 'D:/PixMartExport'
    const lane = await createLane({
      respond: (url, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase()
        if (method === 'POST' && /\/api\/settings\/export-dir$/.test(String(url))) {
          const body = JSON.parse(String(init?.body ?? '{}'))
          posted.push(body)
          current = body.exportDir
          return jsonResponse({ ok: true, exportDir: current })
        }
        return jsonResponse(providersPayload({ exportDir: current }))
      },
    })
    await lane.render()

    // React 的 onBlur 挂在 focusout 上
    const focusOut = (element) =>
      act(async () => {
        element.dispatchEvent(new lane.window.FocusEvent('focusout', { bubbles: true }))
      })

    await lane.type(exportDirInput(lane), 'E:/by-blur')
    await focusOut(exportDirInput(lane))
    await settleAll()
    assert.deepEqual(posted, [{ exportDir: 'E:/by-blur' }], '失焦应与点「保存」等价')

    // 再输入一个不同的值，然后直接点「清除」：真实浏览器里 blur 先于 click，
    // 显式的清除必须赢，而不是把刚输入的值保存下去。
    await lane.type(exportDirInput(lane), 'E:/should-not-be-saved')
    await act(async () => {
      const clear = exportDirButton(lane, '清除')
      clear.dispatchEvent(new lane.window.MouseEvent('mousedown', { bubbles: true }))
      exportDirInput(lane).dispatchEvent(new lane.window.FocusEvent('focusout', { bubbles: true }))
      clear.click()
    })
    await settleAll()

    assert.equal(posted.length, 2, `「清除」这一步不该额外发一次保存，实际 ${posted.length} 次`)
    assert.deepEqual(posted[1], { exportDir: '' }, '「清除」必须发空串')
    assert.equal(posted.some((body) => body.exportDir === 'E:/should-not-be-saved'), false)
    assert.equal(exportDirInput(lane).value, '')
  })

  it('请求进行中按钮禁用（防重复提交）', async () => {
    let release
    const pending = new Promise((resolve) => {
      release = () => resolve(jsonResponse({ ok: true, exportDir: 'E:/out' }))
    })
    const lane = await createLane({
      respond: (url, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase()
        if (method === 'POST' && /\/api\/settings\/export-dir$/.test(String(url))) return pending
        return jsonResponse(providersPayload({ exportDir: '' }))
      },
    })
    await lane.render()

    await lane.type(exportDirInput(lane), 'E:/out')
    await act(async () => {
      exportDirButton(lane, '保存').click()
    })

    const during = exportDirButton(lane, '保存中…')
    assert.ok(during, '请求中按钮文案应变为「保存中…」')
    assert.equal(during.disabled, true, '请求中「保存」必须禁用')
    assert.equal(exportDirButton(lane, '清除').disabled, true, '请求中「清除」也必须禁用')

    await act(async () => {
      release()
    })
    await settleAll()
    assert.ok(exportDirButton(lane, '保存'), '请求结束后按钮应恢复')
  })
})

async function settleAll() {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve))
}
