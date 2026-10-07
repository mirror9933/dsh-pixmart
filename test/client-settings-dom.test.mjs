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
    // 宿主 `GET api/providers` 的**厂商目录**（task-4 §1 冻结形状）：20 条。
    catalog: catalogFixture(),
    usage: { requests: 0, ok: 0, failed: 0, images: 0 },
    historical: { projects: 0, images: 0, note: '' },
    ...over,
  }
}

/**
 * 目录条目（宿主 `catalog[]` 的一项）：`{id,label,baseUrl,group,imageCapable,note,added}`。
 * 三组各至少一条、`imageCapable:false` 至少一条、`added:true` 至少两条 ——
 * 六条断言要的每一种形态都在夹具里**真的存在**，否则断言会退化成"没数据也绿"。
 */
function catalogEntry(over = {}) {
  return {
    id: 'unknown',
    label: 'Unknown',
    baseUrl: 'https://api.example.test/v1',
    group: 'official',
    imageCapable: true,
    note: '',
    added: false,
    ...over,
  }
}

/** 20 条目录：8 official + 9 aggregator + 3 custom（条数与宿主契约一致）。 */
function catalogFixture() {
  return [
    catalogEntry({ id: 'openai', label: 'OpenAI' }),
    catalogEntry({ id: 'anthropic', label: 'Anthropic', imageCapable: false }),
    catalogEntry({ id: 'google', label: 'Google', added: true }),
    catalogEntry({ id: 'azure', label: 'Azure OpenAI' }),
    catalogEntry({ id: 'mistral', label: 'Mistral' }),
    catalogEntry({ id: 'cohere', label: 'Cohere' }),
    catalogEntry({ id: 'xai', label: 'xAI' }),
    catalogEntry({ id: 'deepseek', label: 'DeepSeek' }),
    catalogEntry({ id: 'ofox', label: 'Ofox', group: 'aggregator', added: true }),
    catalogEntry({ id: 'siliconflow', label: 'SiliconFlow', group: 'aggregator' }),
    catalogEntry({ id: 'openrouter', label: 'OpenRouter', group: 'aggregator' }),
    catalogEntry({ id: 'together', label: 'Together', group: 'aggregator' }),
    catalogEntry({ id: 'fireworks', label: 'Fireworks', group: 'aggregator' }),
    catalogEntry({ id: 'replicate', label: 'Replicate', group: 'aggregator' }),
    catalogEntry({ id: 'fal', label: 'Fal', group: 'aggregator' }),
    catalogEntry({ id: 'novita', label: 'Novita', group: 'aggregator' }),
    catalogEntry({ id: 'dashscope', label: 'DashScope', group: 'aggregator' }),
    catalogEntry({ id: 'custom', label: '自定义', group: 'custom' }),
    catalogEntry({ id: 'custom-openai', label: '自定义（OpenAI 兼容）', group: 'custom' }),
    catalogEntry({ id: 'selfhost', label: '自建端点', group: 'custom', imageCapable: false }),
  ]
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

// ── 厂商卡片：点「编辑」在卡片内展开（2026-10-12 重构）───────────────────────
//
// 结构照官方「模型」设置页（`.probe/models-client.js:2160-2232`）：`ul.rows` 里每家一个
// `li.rowCard`，卡片**默认只显示** 厂商名 + 凭据圆点 + 「编辑」按钮；点「编辑」才在
// **同一张卡内**插入编辑器（同文件 `:2220-2230` 的 `open ? renderProviderEditor(...) : null`）。
//
// 下面这些定位函数只认**冻结的语义锚点**（task-1 契约）与**必要的结构事实**，
// 不认类名：类名是实现细节，换个名字不该让行为断言失效。

/** 卡片集合（锚点：`[data-pxm-vendor-card]`）。 */
function vendorCards(lane) {
  const cards = [...lane.container.querySelectorAll('[data-pxm-vendor-card]')]
  assert.ok(cards.length > 0, '设置页必须渲染出厂商卡片（[data-pxm-vendor-card]）')
  return cards
}

const firstCard = (lane) => vendorCards(lane)[0]

/**
 * 卡片内那一枚「编辑」= 官方 `rowActions .secondaryButton`（小号形态）。
 * 锚点 `[data-pxm-vendor-edit]`，退路是卡内文案为「编辑」的按钮。
 */
function editButtonOf(card) {
  return (
    card.querySelector('[data-pxm-vendor-edit]') ??
    [...card.querySelectorAll('button')].find((node) => node.textContent.trim() === '编辑') ??
    null
  )
}

/** 卡片内的编辑器（收起时**不存在** —— 官方也是条件渲染，不是隐藏）。 */
const editorOf = (card) => card.querySelector('[data-pxm-editor]')

/** 密钥输入框：契约冻结的 id 优先，退路是编辑器里的 password 框。 */
function keyInputOf(card) {
  return (
    card.querySelector('#pxm-provider-key') ??
    card.querySelector('#pxm-provider-api-key') ??
    card.querySelector('[data-pxm-editor] input[type="password"]') ??
    null
  )
}

/** Base URL 输入框（契约冻结 id `pxm-provider-base-url`）。 */
const baseUrlInputOf = (card) => card.querySelector('#pxm-provider-base-url')

/** 「自定义设置」那一枚 `<details>`（官方 `._3nPmjq_customized`）。 */
function customizedOf(card) {
  return (
    card.querySelector('[data-pxm-vendor-customized]') ??
    card.querySelector('[data-pxm-editor] details') ??
    null
  )
}

function customizedSummaryOf(card) {
  const details = customizedOf(card)
  return details === null
    ? null
    : (details.querySelector('[data-pxm-vendor-customized-summary]') ??
        details.querySelector('summary') ??
        null)
}

/** 卡内动作按钮：锚点优先，退路是卡内同文案的按钮（忙碌时文案会变，所以锚点更重要）。 */
function cardButtonOf(card, anchor, label) {
  return (
    card.querySelector(anchor) ??
    [...card.querySelectorAll('button')].find((node) => node.textContent.trim() === label) ??
    null
  )
}

const saveButtonOf = (card) => cardButtonOf(card, '[data-pxm-vendor-save]', '保存')
const cancelButtonOf = (card) => cardButtonOf(card, '[data-pxm-vendor-cancel]', '取消')

/** 展开某张卡（幂等）：点「编辑」→ 断言编辑器真的出现。 */
async function openVendorCard(lane, card) {
  if (editorOf(card) === null) {
    const button = editButtonOf(card)
    assert.ok(button, '卡片上必须有「编辑」按钮（[data-pxm-vendor-edit]）')
    await act(async () => {
      button.click()
    })
    await settleAll()
  }
  assert.ok(editorOf(card), '点「编辑」后卡片内必须出现编辑器（[data-pxm-editor]）')
  return card
}

/** 展开卡片内那枚 `<details>`（自定义设置）。jsdom 30 已实现 summary 激活 → 切 open。 */
async function openCustomized(lane, card) {
  const details = customizedOf(card)
  assert.ok(details, '编辑器里必须有「自定义设置」details（[data-pxm-vendor-customized]）')
  if (details.open !== true) {
    const summary = customizedSummaryOf(card)
    assert.ok(summary, '「自定义设置」必须有 summary')
    await act(async () => {
      summary.click()
    })
    await settleAll()
  }
  assert.equal(details.open, true, '点 summary 后 details.open 必须为真')
  return details
}

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

    // 结构变了：卡片默认收起，密钥输入框要先点「编辑」才存在。
    const card = await openVendorCard(lane, firstCard(lane))
    const keyInput = keyInputOf(card)
    assert.ok(keyInput, '展开编辑器后应有一个密钥输入框')
    assert.equal(keyInput.getAttribute('type'), 'password', '密钥输入框必须是 password')

    await lane.type(keyInput, SECRET)
    await lane.click(saveButtonOf(card))
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
    await openVendorCard(lane, firstCard(lane))

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
    await openVendorCard(lane, firstCard(lane))

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
    const card = await openVendorCard(lane, firstCard(lane))

    await lane.type(keyInputOf(card), SECRET)
    await lane.click(saveButtonOf(card))

    assert.ok(lane.text().includes('没有 id'), '应显示宿主返回的可读原因')
    assert.ok(lane.text().includes('unknown_provider'), '应带上错误 code')
    // 表单仍在（没有白屏）
    assert.ok(saveButtonOf(card), '失败后表单仍应存在')
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
    const card = await openVendorCard(lane, firstCard(lane))

    await lane.type(keyInputOf(card), SECRET)
    const saveButton = saveButtonOf(card)
    // 不 await：让请求停在途中
    await act(async () => {
      saveButton.click()
    })

    const during = cardButtonOf(card, '[data-pxm-vendor-save]', '保存中…')
    assert.ok(during, '请求中按钮文案应变为「保存中…」')
    assert.equal(during.textContent.trim(), '保存中…', '请求中按钮文案应变为「保存中…」')
    assert.equal(during.disabled, true, '请求中按钮必须禁用')

    await act(async () => {
      release()
    })
    await settleAll()
    assert.ok(saveButtonOf(card), '请求结束后按钮应恢复')
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

// ── 厂商卡片：默认收起 / 取消丢弃 / 保存只写改动 / Gemini 字段消失 ──────────────

describe('jsdom lane：厂商卡片 = 官方「模型」页同构', () => {
  /** 两家厂商的页面：用来证明「同时只展开一张」。 */
  const twoProviders = () =>
    providersPayload({
      providers: [
        providerView(),
        providerView({ id: 'agnes', label: 'Agnes AI', dialect: 'agnes', models: ['a-1'] }),
      ],
    })

  /** React 的 onBlur 挂在 `focusout` 上（与作品库导出路径那条用例同一处理）。 */
  const focusOut = (lane, element) =>
    act(async () => {
      element.dispatchEvent(new lane.window.FocusEvent('focusout', { bubbles: true }))
    })

  it('A1 默认收起；点「编辑」只展开被点的那一张，再点收起', async () => {
    const lane = await createLane({ respond: () => jsonResponse(twoProviders()) })
    await lane.render()

    const cards = vendorCards(lane)
    assert.equal(cards.length, 2, '夹具给了两家厂商，必须有两张卡片')
    const [first, second] = cards

    // 默认收起：卡里既没有编辑器，也没有密钥输入框 / Base URL 输入框。
    assert.equal(editorOf(first), null, '默认收起：卡片里不该有编辑器')
    assert.equal(keyInputOf(first), null, '默认收起：卡片里看不到 API 密钥输入框')
    assert.equal(baseUrlInputOf(first), null, '默认收起：卡片里看不到 Base URL 输入框')
    assert.equal(saveButtonOf(first), null, '默认收起：不该有「保存」')
    // 收起时仍然看得见的是：厂商名 + 凭据圆点 + 「编辑」按钮（官方 rowHead 那一行）。
    assert.ok((first.textContent ?? '').includes('Ofox'), '收起态必须显示厂商名')
    assert.ok(first.querySelector('[data-pxm-credential-dot]'), '收起态必须显示凭据圆点')
    assert.ok(editButtonOf(first), '收起态必须有「编辑」按钮')

    await openVendorCard(lane, first)
    assert.ok(keyInputOf(first), '点「编辑」后必须出现密钥输入框')

    // 只展开被点的那一张（官方同一时刻只有一张卡带 editor）。
    assert.equal(editorOf(second), null, '另一张必须仍然收起')

    // 点第二张的「编辑」→ 第一张收起（同时只允许一张展开）。
    await openVendorCard(lane, second)
    assert.ok(editorOf(second), '第二张应展开')
    assert.equal(editorOf(first), null, '展开第二张时第一张必须收起')

    // 再点同一张的「编辑」→ 收起。
    await act(async () => {
      editButtonOf(second).click()
    })
    await settleAll()
    assert.equal(editorOf(second), null, '再点「编辑」应收起')
    assert.equal(keyInputOf(second), null, '收起后密钥输入框必须消失')
  })

  it('A2 「取消」丢弃改动：零 POST、收起、重新展开后回到配置里的原值', async () => {
    const ORIGINAL_BASE = 'https://api.example.test/v1'
    const lane = await createLane({ respond: () => jsonResponse(providersPayload()) })
    await lane.render()
    const card = await openVendorCard(lane, firstCard(lane))

    // 改密钥 + 改 Base URL（Base URL 在「自定义设置」里）。
    await lane.type(keyInputOf(card), SECRET)
    await openCustomized(lane, card)
    const baseUrl = baseUrlInputOf(card)
    assert.ok(baseUrl, '「自定义设置」里必须有 Base URL 输入框')
    await lane.type(baseUrl, 'https://changed.example.test/v1')

    /*
     * 真实浏览器里点「取消」之前会先失焦（mousedown 让输入框 blur，然后才 click）。
     * 所以这里显式把 focusout 也发出去：实现若还留着"失焦即写"，这一步就该被抓。
     */
    await focusOut(lane, baseUrl)
    await focusOut(lane, keyInputOf(card))

    const cancel = cancelButtonOf(card)
    assert.ok(cancel, '编辑器底部必须有「取消」')
    await act(async () => {
      cancel.click()
    })
    await settleAll()

    assert.equal(lane.postCalls().length, 0, '「取消」不得发任何写请求')
    assert.equal(editorOf(card), null, '「取消」后卡片应收起')

    await openVendorCard(lane, card)
    assert.equal(
      baseUrlInputOf(card).value,
      ORIGINAL_BASE,
      '重新展开后 Base URL 必须回到配置里的原值（本地改动被丢弃）',
    )
    assert.equal(keyInputOf(card).value, '', '重新展开后密钥框必须为空（不回显、不残留改动）')
    assert.equal(lane.postCalls().length, 0, '整个过程一次写请求都不该发生')
  })

  it('A3 「保存」才写：恰好 1 次 credentials，且只带改动过的字段', async () => {
    const lane = await createLane({
      respond: (url, init) => {
        if (String(init?.method).toUpperCase() === 'POST') {
          return jsonResponse({ ok: true, provider: providerView() })
        }
        return jsonResponse(providersPayload())
      },
    })
    await lane.render()
    const card = await openVendorCard(lane, firstCard(lane))

    // 只改 Base URL：不得带 apiKey（用户这次没碰密钥）。
    await openCustomized(lane, card)
    await lane.type(baseUrlInputOf(card), 'https://moved.example.test/v1')
    await act(async () => {
      saveButtonOf(card).click()
    })
    await settleAll()

    const firstPosts = lane.postCalls()
    assert.equal(firstPosts.length, 1, `「保存」应当恰好写 1 次，实际 ${firstPosts.length}`)
    assert.match(firstPosts[0].url, /\/api\/providers\/ofox\/credentials$/)
    const sentBaseUrl = JSON.parse(String(firstPosts[0].body))
    assert.equal(sentBaseUrl.baseUrl, 'https://moved.example.test/v1', '改动过的 Base URL 必须发出去')
    assert.equal('apiKey' in sentBaseUrl, false, '没改密钥时不得带 apiKey 字段')
    assert.ok(lane.text().includes('已保存'), '保存成功应给出提示')

    // 反过来：只改密钥 → 不得带 baseUrl。
    await openVendorCard(lane, card)
    await lane.type(keyInputOf(card), SECRET)
    await act(async () => {
      saveButtonOf(card).click()
    })
    await settleAll()

    const posts = lane.postCalls()
    assert.equal(posts.length, 2, `第二次保存也应当恰好 1 次，实际共 ${posts.length}`)
    const sentKey = JSON.parse(String(posts[1].body))
    assert.equal(sentKey.apiKey, SECRET, '改动过的密钥必须发出去')
    assert.equal('baseUrl' in sentKey, false, '没改 Base URL 时不得带 baseUrl 字段')
  })

  it('A4 「Gemini 原生 Base URL」按厂商条件渲染：agnes 那张没有它，ofox 那张有且值正确', async () => {
    /*
     * 判据（Lead 2026-10-12 修正）：这一项**按厂商条件渲染** —— `provider.geminiNativeBaseUrl`
     * 非空才在「自定义设置」里出现。全平台删除会让 ofox 的原生端点从界面上再也改不了
     * （只能手改 config.json），那是能力净损失；要的是"agnes 那张卡干净"。
     * 所以两侧都断言，比"整页一刀切不存在"更有鉴别力。
     */
    const OFOX_NATIVE = 'https://api.ofox.io/gemini/v1beta'
    const lane = await createLane({
      respond: () =>
        jsonResponse(
          providersPayload({
            providers: [
              providerView({ geminiNativeBaseUrl: OFOX_NATIVE }),
              providerView({ id: 'agnes', label: 'Agnes AI', dialect: 'agnes', models: ['a-1'] }),
            ],
          }),
        ),
    })
    await lane.render()

    const [ofox, agnes] = vendorCards(lane)
    assert.ok(ofox && agnes, '夹具给了两家厂商，必须有两张卡片')

    // ① ofox（夹具里 geminiNativeBaseUrl 非空）→ 该项存在，且值是夹具里那个 URL。
    await openVendorCard(lane, ofox)
    await openCustomized(lane, ofox)
    const native = ofox.querySelector('#pxm-provider-native-url')
    assert.ok(native, 'geminiNativeBaseUrl 非空时，卡片里必须有 #pxm-provider-native-url')
    assert.equal(native.value, OFOX_NATIVE, '该输入框必须回显配置里的 geminiNativeBaseUrl')

    // ② agnes（夹具里 geminiNativeBaseUrl 为空）→ 这张卡上根本没有它，也没有那行文案。
    await openVendorCard(lane, agnes)
    await openCustomized(lane, agnes)
    assert.equal(
      agnes.querySelector('#pxm-provider-native-url'),
      null,
      'geminiNativeBaseUrl 为空时，这张卡不得出现 #pxm-provider-native-url',
    )
    assert.equal(
      (agnes.textContent ?? '').includes('Gemini 原生'),
      false,
      'geminiNativeBaseUrl 为空时，这张卡的文本不得出现「Gemini 原生」',
    )
    assert.equal(editorOf(ofox), null, '展开 agnes 时 ofox 必须收起')
  })

  it('A5 「自定义设置」= 可展开的 details：初始无 open，点 summary 后为真，Base URL 在它内部', async () => {
    const lane = await createLane()
    await lane.render()
    const card = await openVendorCard(lane, firstCard(lane))

    const details = customizedOf(card)
    assert.ok(details, '编辑器里必须有 details[data-pxm-vendor-customized]')
    assert.equal(details.open, false, '「自定义设置」初始必须是收起的（不带 open）')

    const summary = customizedSummaryOf(card)
    assert.ok(summary, '「自定义设置」必须有 summary（点它开合）')
    assert.ok(
      (summary.textContent ?? '').includes('自定义设置'),
      `summary 文案应为「自定义设置」，实际「${String(summary.textContent)}」`,
    )

    const baseUrl = baseUrlInputOf(card)
    assert.ok(baseUrl, 'Base URL 输入框必须存在')
    assert.equal(details.contains(baseUrl), true, 'Base URL 必须落在 details 的内容区里')

    await act(async () => {
      summary.click()
    })
    await settleAll()
    assert.equal(details.open, true, '点 summary 后 details.open 必须为真')
  })

  it('A6 既有行为不丢：展开后「拉取模型」发 refresh-models、「测试连接」发 /test、列表条目数 == 夹具', async () => {
    const PULLED = ['model-a', 'model-b', 'model-c']
    let models = []
    const lane = await createLane({
      respond: (url, init) => {
        const target = String(url)
        const method = String(init?.method ?? 'GET').toUpperCase()
        if (method === 'POST' && /refresh-models$/.test(target)) {
          models = PULLED
          return jsonResponse({ ok: true, models, count: models.length, provider: providerView({ models }) })
        }
        if (method === 'POST' && /\/test$/.test(target)) {
          return jsonResponse({ ok: true, latencyMs: 7, modelCount: models.length })
        }
        return jsonResponse(providersPayload({ providers: [providerView({ models })] }))
      },
    })
    await lane.render()
    // 结构变了：这三样都在编辑器里，必须先点「编辑」。
    const card = await openVendorCard(lane, firstCard(lane))

    const fetchButton = card.querySelector('[data-pxm-role="fetch-models"]')
    const testButton = card.querySelector('[data-pxm-role="test-connection"]')
    assert.ok(fetchButton, '卡片上必须有「拉取模型」按钮')
    assert.ok(testButton, '卡片上必须有「测试连接」按钮')
    assert.equal(fetchButton.disabled, false, '「拉取模型」默认必须可点')
    assert.equal(testButton.disabled, false, '「测试连接」默认必须可点')

    await act(async () => {
      fetchButton.click()
    })
    await settleAll()

    const posts = lane.postCalls()
    assert.equal(posts.length, 1, `点「拉取模型」应恰好发 1 次 POST，实际 ${posts.length}`)
    assert.match(posts[0].url, /refresh-models$/)
    assert.equal(String(posts[0].body), '{}', '拉取是纯读：body 必须是 {}')
    assert.equal(
      card.querySelectorAll('[data-pxm-model-row]').length,
      PULLED.length,
      `模型列表条目数必须等于夹具给的 ${PULLED.length}`,
    )

    await act(async () => {
      testButton.click()
    })
    await settleAll()
    const after = lane.postCalls()
    assert.equal(after.length, 2, `点「测试连接」应再发 1 次 POST，实际 ${after.length}`)
    assert.match(after[1].url, /\/test$/)
    assert.ok(lane.text().includes('连接正常'), '测试连接成功后应显示结果')
  })
})

// ── 「添加模型提供商」页内 add-card + 目录下拉 + 「删除」两步确认（2026-10-12）──
//
// 形态照 **DSH 官方**「模型」设置页（不是参考项目的弹窗）：
//   `.probe/models-client.js:2235-2340` 的 `addBlock`（`addOpen ? addCard : addButton`）、
//   `.probe/models-css-pretty.txt:37-44` 的 `addBlock` / `addModes` / `addPanel` / `addCard`
//   + `:44` 的 `.addCard .editor{background:0 0;padding:0}`；文案逐字见
//   `.probe/models-client.js:2966-3005`。
//
// 宿主接口（task-6 冻结）：
//   - `GET api/providers` 多一份 `catalog`（20 条，形状见 `catalogEntry`）；
//   - `POST api/providers {catalogId, baseUrl?, apiKey?}` 从目录新增一家；
//   - `POST api/providers {custom:{id,label,baseUrl}, apiKey?}` 自定义新增一家；
//   - `POST api/providers/<id>/delete` 删除一家（**没有 DELETE 方法**，本仓库只支持 GET/POST）。
//
// 定位只认锚点（`data-pxm-add-*` / `data-pxm-vendor-remove`），不认类名、不认文案排布 ——
// "面板怎么排"是实现细节，"点了发不发请求、发几次、body 恰是什么"才是行为。

/** add-card 根（`addOpen === false` 时**不存在**，不是隐藏 —— 官方也是条件渲染）。 */
const addCard = (lane) => lane.container.querySelector('[data-pxm-add-card]')
/** 虚线「添加模型提供商」。 */
const addButton = (lane) => lane.container.querySelector('[data-pxm-add-vendor]')
/** 提供商下拉（原生 `<select>`，官方就是 `select.input.selectInput`）。 */
const providerSelect = (lane) => lane.container.querySelector('[data-pxm-add-provider]')
/** 两个 tab（`data-pxm-add-tab="catalog|custom"`）。 */
const addTab = (lane, value) =>
  lane.container.querySelector('[data-pxm-add-tab="' + String(value) + '"]')
/** 两个面板（`data-pxm-add-panel="catalog|custom"`）。 */
const addPanel = (lane, value) =>
  lane.container.querySelector('[data-pxm-add-panel="' + String(value) + '"]')
/** 提示那一行（`data-pxm-add-hint`）。 */
const addHint = (lane) => lane.container.querySelector('[data-pxm-add-hint]')
const addSave = (lane) => lane.container.querySelector('[data-pxm-add-save]')
const addCancel = (lane) => lane.container.querySelector('[data-pxm-add-cancel]')
const addError = (lane) => lane.container.querySelector('[data-pxm-add-error]')
const addKeyInput = (lane) => lane.container.querySelector('#pxm-add-key')
const addBaseUrlInput = (lane) => lane.container.querySelector('#pxm-add-base-url')

/**
 * 2026-10-12（task-10）：add-card 里的两枚**草稿探测**动作。
 * 它们与已保存厂商卡片里的「测试连接 / 拉取模型」是同一枚 `LinkButton`
 * （官方 `._3nPmjq_linkButton`），只是打的是**草稿**：`POST api/providers/probe`。
 */
const probeTest = (lane) => lane.container.querySelector('[data-pxm-add-probe-test]')
const probeModels = (lane) => lane.container.querySelector('[data-pxm-add-probe-models]')
/** 探测结果那一行（成功 / 失败都在里面；**没有结果时锚点不存在**）。 */
const probeResult = (lane) => lane.container.querySelector('[data-pxm-add-probe-result]')
/** 拉到的模型列表（没拉过时不存在）。 */
const pulledList = (lane) => lane.container.querySelector('[data-pxm-add-model-list]')
const pulledRows = (lane) => [...lane.container.querySelectorAll('[data-pxm-add-model-row]')]
const pulledNames = (lane) =>
  pulledRows(lane).map((node) => (node.querySelector('[data-pxm-add-model-name]')?.textContent ?? '').trim())

/** 探测请求（`POST api/providers/probe`，**只读**：不写配置、也不新增厂商）。 */
const probePosts = (lane) =>
  lane.fetches.filter((call) => call.method === 'POST' && /\/api\/providers\/probe$/.test(call.url))

/** 勾选 / 取消勾选某一行模型（点 checkbox 的真实路径）。 */
async function toggleModelRow(lane, name, explicit) {
  const row = pulledRows(lane).find(
    (node) => (node.querySelector('[data-pxm-add-model-name]')?.textContent ?? '').trim() === name,
  )
  assert.ok(row, '拉到的列表里必须有模型 ' + name)
  const box = row.querySelector('input[type="checkbox"]')
  assert.ok(box, '每一行必须有勾选框')
  if (explicit !== undefined) assert.equal(box.checked, explicit, name + ' 的初始勾选态必须是 ' + String(explicit))
  await act(async () => {
    box.click()
  })
  await settleAll()
}

/**
 * 夹具给「拉取模型」回的模型目录。**故意给 3 个**（2 个图像模型 + 1 个纯文本）：
 * 这样"列表条数"与"只勾 2 条"两件事都验得出来。
 */
const PROBE_MODELS = [
  'openai/gpt-image-1',
  'google/gemini-3.1-flash-image',
  'text-embedding-3-large',
]

/**
 * 造一个"provider-host 的 probe 路由"：按 `action` 回不同形状
 * （`test` → `{ok,latencyMs,modelCount}`；`models` → `{ok,models,count}`），
 * 并把收到的 body 逐条记进 `seen`。**形状来自 task-10 的冻结契约。**
 */
function probeResponder(seen, over = {}) {
  return (url, init) => {
    const method = String(init?.method ?? 'GET').toUpperCase()
    const target = String(url)
    if (method === 'POST' && /\/api\/providers\/probe$/.test(target)) {
      const body = JSON.parse(String(init?.body ?? '{}'))
      seen.push(body)
      if (over.fail === true) {
        /*
         * 失败形状**按 action 不同**（provider-host task-9 的确认）：
         *   - `test`   → **HTTP 200** + `{ok:false, latencyMs, error:{code,message}}`
         *                （与已保存厂商的 `/test` 同形）；
         *   - `models` → **HTTP 401** + `{ok:false, error:{code,message}}`
         *                （与 `/refresh-models` 同）。
         * 两条的形状不同，所以夹具也必须分开造 —— 只造一条会漏掉另一条路径。
         */
        const failure = { code: 'auth', message: '密钥被拒（HTTP 401）' }
        if (body.action === 'models') return jsonResponse({ ok: false, error: failure }, 401)
        return jsonResponse({ ok: false, latencyMs: 12, error: failure })
      }
      if (body.action === 'models') {
        return jsonResponse({ ok: true, models: PROBE_MODELS, count: PROBE_MODELS.length })
      }
      return jsonResponse({ ok: true, latencyMs: 42, modelCount: PROBE_MODELS.length })
    }
    if (method === 'POST' && /\/api\/providers$/.test(target)) {
      const body = JSON.parse(String(init?.body ?? '{}'))
      seen.push(body)
      return jsonResponse({ ok: true, provider: providerView({ id: 'anthropic', label: 'Anthropic' }) })
    }
    return jsonResponse(providersPayload())
  }
}

/** 点虚线按钮展开 add-card，并先断"它现在真的可点 + 卡真的出来了"。 */
async function openAddCard(lane) {
  const button = addButton(lane)
  assert.ok(button, '设置页必须有虚线「添加模型提供商」按钮（[data-pxm-add-vendor]）')
  assert.equal(button.disabled, false, '「添加模型提供商」必须可点（点它在页内展开 add-card）')
  await lane.click(button)
  const card = addCard(lane)
  assert.ok(card, '点虚线按钮后必须出现**页内** add-card（[data-pxm-add-card]）')
  return card
}

/** 切到另一个 tab（点 tab 的真实路径，不直接改 state）。 */
async function switchAddMode(lane, value) {
  const tab = addTab(lane, value)
  assert.ok(tab, 'add-card 里必须有 data-pxm-add-tab="' + String(value) + '" 那一枚 tab')
  assert.equal(tab.disabled, false, 'tab「' + String(value) + '」必须可点')
  await lane.click(tab)
}

/**
 * 「提供商」下拉的选项值，按 DOM 顺序。
 *
 * task-8 起：下拉**列出全部目录条目**（不再只列未添加的），顺序规则不变 ——
 * `localeCompare(..., 'zh-Hans-CN')` 升序 + `custom` 那一组固定排最后
 * （与我们 `sortCatalog` 的稳定规则一致）。这里**独立复述**一遍，实现漂移就红。
 */
const EXPECTED_OPTION_ORDER = [
  'anthropic',
  'azure',
  'cohere',
  'dashscope',
  'deepseek',
  'fal',
  'fireworks',
  'google',
  'mistral',
  'novita',
  'ofox',
  'openai',
  'openrouter',
  'replicate',
  'siliconflow',
  'together',
  'xai',
  'custom',
  'custom-openai',
  'selfhost',
]
/** 夹具里已添加的两家（`catalogFixture()` 的 google / ofox）。 */
const ALREADY_ADDED = ['google', 'ofox']
/** 全部条目数（= 宿主 catalog 的条数；`EXPECTED_OPTION_ORDER` 反过来就是它）。 */
const EXPECTED_ALL_COUNT = EXPECTED_OPTION_ORDER.length
/** 默认选中项 = 顺序里**第一个未添加**的。 */
const EXPECTED_FIRST_ADDABLE =
  EXPECTED_OPTION_ORDER.find((id) => !ALREADY_ADDED.includes(id)) ?? ''
/** 选项文案：宿主给的可读名（与 id 不同，故意有出入的名字才验得出"用的是 label"）。 */
const EXPECTED_LABEL = {
  anthropic: 'Anthropic',
  azure: 'Azure OpenAI',
  cohere: 'Cohere',
  dashscope: 'DashScope',
  deepseek: 'DeepSeek',
  fal: 'Fal',
  fireworks: 'Fireworks',
  google: 'Google',
  mistral: 'Mistral',
  novita: 'Novita',
  ofox: 'Ofox',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  replicate: 'Replicate',
  siliconflow: 'SiliconFlow',
  together: 'Together',
  xai: 'xAI',
  custom: '自定义',
  'custom-openai': '自定义（OpenAI 兼容）',
  selfhost: '自建端点',
}

describe('jsdom lane：「添加模型提供商」add-card 与「删除」两步确认', () => {
  it('A1 点虚线按钮 → 页内出现 add-card、虚线按钮消失；两个 tab 的文案逐字对齐官方', async () => {
    const lane = await createLane()
    await lane.render()

    assert.equal(addCard(lane), null, '默认态不该有 add-card（官方是条件渲染，不是隐藏）')
    assert.ok(addButton(lane), '默认态必须有虚线「添加模型提供商」')

    const card = await openAddCard(lane)
    // 官方 `addOpen ? addCard : addButton`：展开后虚线按钮**不在 DOM 里**。
    assert.equal(addButton(lane), null, '展开后虚线按钮必须消失（官方 addOpen ? addCard : addButton）')

    // 两个 tab 的文案逐字是官方 `addCatalog` / `addCustom`（:2976-2977）。
    assert.equal(addTab(lane, 'catalog').textContent.trim(), '第三方模型提供商')
    assert.equal(addTab(lane, 'custom').textContent.trim(), '自定义模型 API')
    // 在页内（不是弹窗）：没有遮罩、没有 role="dialog"。
    assert.equal(card.getAttribute('role'), null, 'add-card 不是对话框（官方没有 overlay / dialog）')
    assert.equal(
      lane.container.querySelector('[data-pxm-catalog]'),
      null,
      '旧的目录弹窗必须删干净（[data-pxm-catalog] 不该再存在）',
    )
  })

  it('A2 两个 tab 切换：hint 与面板跟着换，文案逐字对齐官方', async () => {
    const lane = await createLane()
    await lane.render()
    await openAddCard(lane)

    // 默认是 catalog：hint = 官方 `addCatalogHint`（:2978）。
    assert.equal(addTab(lane, 'catalog').getAttribute('aria-selected'), 'true')
    assert.equal(
      addHint(lane).textContent,
      '从内置目录中选择 OpenAI、Anthropic、Kimi 等提供商，填入其 API 密钥即可使用。',
    )
    assert.equal(addPanel(lane, 'catalog').hidden, false, 'catalog tab 下 catalog 面板必须可见')
    assert.equal(addPanel(lane, 'custom').hidden, true, 'catalog tab 下 custom 面板必须隐藏')

    await switchAddMode(lane, 'custom')
    assert.equal(addTab(lane, 'custom').getAttribute('aria-selected'), 'true')
    assert.equal(addTab(lane, 'catalog').getAttribute('aria-selected'), 'false')
    assert.equal(
      addHint(lane).textContent,
      '连接中转站、自部署服务或其他兼容 OpenAI / Anthropic 协议的接口，需填写 API 地址、协议和模型。',
    )
    assert.equal(addPanel(lane, 'custom').hidden, false, 'custom tab 下 custom 面板必须可见')
    assert.equal(addPanel(lane, 'catalog').hidden, true, 'custom tab 下 catalog 面板必须隐藏')

    // 切 tab 一个请求都不发（"保存才算数"）。
    assert.deepEqual(lane.postCalls(), [], '切 tab 不得发任何请求')

    await switchAddMode(lane, 'catalog')
    assert.equal(addPanel(lane, 'custom').hidden, true, '切回 catalog 后 custom 面板必须再隐藏')
  })

  it('A3 「提供商」下拉是一个原生 select：20 条全列、已添加的 disabled 且标注「（已添加）」', async () => {
    const lane = await createLane()
    await lane.render()
    await openAddCard(lane)

    const select = providerSelect(lane)
    assert.ok(select, 'catalog 面板必须有 [data-pxm-add-provider]')
    assert.equal(select.tagName, 'SELECT', '官方就是原生 <select class="input selectInput"]，不是自绘下拉')

    /*
     * task-8：**20 条全列**（以前只列未添加的，用户在自己已有 ofox / agnes 时只看到 18 条，
     * 会以为"目录里少了厂商"）。已添加的那些仍然在，只是 `disabled` + 后缀「（已添加）」。
     */
    const values = [...select.options].map((option) => option.value)
    assert.deepEqual(
      values,
      EXPECTED_OPTION_ORDER,
      'select 的选项必须 = 目录全部条目（20 条）、顺序不变；实测 ' + JSON.stringify(values),
    )
    assert.equal(values.length, EXPECTED_ALL_COUNT, '下拉必须列出全部 ' + String(EXPECTED_ALL_COUNT) + ' 家')

    // 已添加的：disabled + 文案带「（已添加）」后缀；未添加的：可选、文案就是厂商名。
    for (const option of [...select.options]) {
      const already = ALREADY_ADDED.includes(option.value)
      assert.equal(
        option.disabled,
        already,
        'id="' + option.value + '" 的 disabled 状态必须 === ' + String(already),
      )
      const text = option.textContent.trim()
      if (already) {
        assert.ok(
          text.includes('（已添加）'),
          '已添加的 ' + option.value + ' 必须标注「（已添加）」，实测 ' + JSON.stringify(text),
        )
        assert.equal(
          text,
          EXPECTED_LABEL[option.value] + '（已添加）',
          '后缀必须紧跟在厂商名之后，实测 ' + JSON.stringify(text),
        )
      } else {
        assert.equal(
          text.includes('（已添加）'),
          false,
          '未添加的 ' + option.value + ' 不得带「（已添加）」',
        )
        assert.equal(text, EXPECTED_LABEL[option.value], '未添加的选项文案 = 厂商可读名')
      }
    }

    // 默认选中项 = **第一个未添加**的（不是 DOM 里第一个 —— 那是 anthropic，恰好也未添加，
    // 所以这里额外把"选中的一定不是 disabled"这条独立断出来，顺序变了也不会误过）。
    assert.equal(select.value, EXPECTED_FIRST_ADDABLE, '默认选中第一个**未添加**的厂商')
    const selected = [...select.options].find((option) => option.value === select.value)
    assert.ok(selected, '选中的值必须在选项里')
    assert.equal(selected.disabled, false, '默认选中项必须**不是**已添加（否则用户以为能选）')
  })

  it('A4 选厂商 + 填密钥 + 保存 → 恰好 1 次 POST api/providers，body 恰为 {catalogId, apiKey}', async () => {
    const posted = []
    const lane = await createLane({
      respond: (url, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase()
        if (method === 'POST' && /\/api\/providers$/.test(String(url))) {
          posted.push(JSON.parse(String(init?.body ?? '{}')))
          return jsonResponse({ ok: true, provider: providerView({ id: 'anthropic', label: 'Anthropic' }) })
        }
        return jsonResponse(providersPayload())
      },
    })
    await lane.render()
    await openAddCard(lane)

    // 选一家（**不发请求**）。
    await lane.select(providerSelect(lane), 'anthropic')
    assert.deepEqual(lane.postCalls(), [], '选厂商不得发请求（要等「保存」）')

    await lane.type(addKeyInput(lane), SECRET)
    await lane.click(addSave(lane))

    const posts = lane.postCalls()
    assert.equal(posts.length, 1, `保存必须恰好发 1 次 POST，实际 ${posts.length}`)
    assert.match(posts[0].url, /\/api\/providers$/, 'POST 的目标必须是 api/providers')
    assert.deepEqual(
      posted,
      [{ catalogId: 'anthropic', apiKey: SECRET }],
      'body 必须恰为 {catalogId, apiKey}（**没有多余字段**：API 地址没填就不许出现 baseUrl）',
    )
    // 密钥不许出现在界面文本里。
    assert.equal(lane.text().includes(SECRET), false, '界面文本泄露了密钥')
  })

  it('A4b 目录里「自定义设置 → API 地址」填了才发 baseUrl，留空不发；与提供商默认相同也不发', async () => {
    const posted = []
    const lane = await createLane({
      respond: (url, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase()
        if (method === 'POST' && /\/api\/providers$/.test(String(url))) {
          posted.push(JSON.parse(String(init?.body ?? '{}')))
          return jsonResponse({ ok: true, provider: providerView({ id: 'anthropic' }) })
        }
        return jsonResponse(providersPayload())
      },
    })
    await lane.render()
    await openAddCard(lane)
    await lane.select(providerSelect(lane), 'anthropic')

    /*
     * ① 填一个**与「提供商默认」不同**的地址 → 必须进 body。
     *    夹具里每条的 `baseUrl` 都是 `https://api.example.test/v1`。
     */
    await lane.type(addBaseUrlInput(lane), 'https://relay.example.test/v1')
    await lane.click(addSave(lane))
    assert.deepEqual(
      posted,
      [{ catalogId: 'anthropic', baseUrl: 'https://relay.example.test/v1' }],
      '填了 API 地址就必须作为 baseUrl 覆盖发出去',
    )

    /*
     * ② 留空 → **不许**发 `baseUrl: ''`：宿主对空串返回 400 bad_field
     *    （空串的语义是"覆盖成空"）。少发一个字段 ≠ 少一个断言。
     */
    const laneB = await createLane({
      respond: (url, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase()
        if (method === 'POST' && /\/api\/providers$/.test(String(url))) {
          posted.push(JSON.parse(String(init?.body ?? '{}')))
          return jsonResponse({ ok: true, provider: providerView({ id: 'anthropic' }) })
        }
        return jsonResponse(providersPayload())
      },
    })
    await laneB.render()
    await openAddCard(laneB)
    await laneB.select(providerSelect(laneB), 'anthropic')
    await laneB.click(addSave(laneB))
    assert.equal(posted.length, 2, '第二次保存也要发出去')
    assert.deepEqual(
      posted[1],
      { catalogId: 'anthropic' },
      'API 地址留空时必须**完全不出现** baseUrl 字段（发空串会被宿主判 400 bad_field）',
    )

    /*
     * ③ 填一个**与提供商默认相同**的值 → 也没必要发（等价于不覆盖）。
     */
    const laneC = await createLane({
      respond: (url, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase()
        if (method === 'POST' && /\/api\/providers$/.test(String(url))) {
          posted.push(JSON.parse(String(init?.body ?? '{}')))
          return jsonResponse({ ok: true, provider: providerView({ id: 'anthropic' }) })
        }
        return jsonResponse(providersPayload())
      },
    })
    await laneC.render()
    await openAddCard(laneC)
    await laneC.select(providerSelect(laneC), 'anthropic')
    await lane.type(addBaseUrlInput(laneC), 'https://api.example.test/v1')
    await laneC.click(addSave(laneC))
    assert.deepEqual(
      posted[2],
      { catalogId: 'anthropic' },
      '与「提供商默认」相同的地址不该当成覆盖发出去',
    )
  })

  it('A5 「取消」→ 零请求，并回到虚线按钮态（add-card 从 DOM 里消失）', async () => {
    const lane = await createLane()
    await lane.render()
    await openAddCard(lane)
    await lane.type(addKeyInput(lane), SECRET)

    await lane.click(addCancel(lane))
    assert.deepEqual(lane.postCalls(), [], '「取消」必须零请求')
    assert.equal(addCard(lane), null, '「取消」后 add-card 必须消失')
    assert.ok(addButton(lane), '「取消」后必须回到虚线按钮态')
    // 草稿也不该残留（再展开是干净的：密钥框空）。
    await openAddCard(lane)
    assert.equal(addKeyInput(lane).value, '', '取消后草稿必须清空（再展开时密钥框是空的）')
  })

  it('A6 custom 面板保存 → body 恰为 {custom:{id,label,baseUrl}, apiKey}', async () => {
    const posted = []
    const lane = await createLane({
      respond: (url, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase()
        if (method === 'POST' && /\/api\/providers$/.test(String(url))) {
          posted.push(JSON.parse(String(init?.body ?? '{}')))
          return jsonResponse({ ok: true, provider: providerView({ id: 'my-relay' }) })
        }
        return jsonResponse(providersPayload())
      },
    })
    await lane.render()
    await openAddCard(lane)
    await switchAddMode(lane, 'custom')

    // 地址为空时「保存」必须被**客户端先拦**（不许把注定 400 的请求发出去）。
    await lane.type(lane.container.querySelector('[data-pxm-add-custom-id="1"]'), 'my-relay')
    assert.equal(addSave(lane).disabled, true, 'API 地址为空时「保存」必须禁用（宿主对空串返回 400）')
    await lane.type(
      lane.container.querySelector('[data-pxm-add-custom-label="1"]'),
      '我的中转',
    )
    await lane.type(
      lane.container.querySelector('[data-pxm-add-custom-baseurl="1"]'),
      'https://relay.example.test/v1',
    )
    assert.equal(addSave(lane).disabled, false, '三格齐了「保存」必须可点')
    await lane.type(addKeyInput(lane), SECRET)
    await lane.click(addSave(lane))

    assert.equal(posted.length, 1, `custom 保存必须恰好 1 次 POST，实际 ${posted.length}`)
    assert.deepEqual(
      posted[0],
      {
        custom: {
          id: 'my-relay',
          label: '我的中转',
          baseUrl: 'https://relay.example.test/v1',
        },
        apiKey: SECRET,
      },
      'custom 的 body 必须恰为 {custom:{id,label,baseUrl}, apiKey}',
    )
  })

  it('A7 目录全添加完 → 显示「目录中的提供商都已添加。」，且自动切到自定义 tab', async () => {
    const all = catalogFixture().map((entry) => ({ ...entry, added: true }))
    const lane = await createLane({
      respond: () => jsonResponse(providersPayload({ catalog: all })),
    })
    await lane.render()
    await openAddCard(lane)

    const exhausted = lane.container.querySelector('[data-pxm-add-exhausted]')
    assert.ok(exhausted, '全添加完必须有 [data-pxm-add-exhausted]')
    assert.equal(
      exhausted.textContent.trim(),
      '目录中的提供商都已添加。',
      '文案必须逐字是官方 addCatalogExhausted（:2980）',
    )
    assert.equal(providerSelect(lane), null, '没有可新增的厂商时不该再画那个 <select>')
    // 目录没了可选项 → 自动落到自定义 tab（否则用户看到的是一个空面板）。
    assert.equal(addTab(lane, 'catalog').disabled, true, '目录 tab 在全添加完时必须禁用')
    assert.equal(addTab(lane, 'custom').getAttribute('aria-selected'), 'true')
    assert.equal(addPanel(lane, 'custom').hidden, false)
  })

  it('A8 「删除」两步确认：第一次只改文案（零请求）、点别处复原；第二次才 POST …/delete', async () => {
    const deleted = []
    const lane = await createLane({
      respond: (url, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase()
        if (method === 'POST' && /\/delete$/.test(String(url))) {
          deleted.push(String(url))
          return jsonResponse({ ok: true, removed: 'ofox', providers: [], defaults: { provider: '' } })
        }
        return jsonResponse(providersPayload())
      },
    })
    await lane.render()

    const removeButton = () => lane.container.querySelector('[data-pxm-vendor-remove]')
    assert.ok(removeButton(), '厂商卡片行动作里必须有「删除」（[data-pxm-vendor-remove]）')
    // 文案逐字用官方 `remove` = 「删除」（`:2967`）。
    assert.equal(removeButton().textContent.trim(), '删除')

    // 第一次点：只改文案，一个请求都不发
    await lane.click(removeButton())
    assert.equal(removeButton().textContent.trim(), '确认删除', '第一次点只把文案改成「确认删除」')
    assert.deepEqual(lane.postCalls(), [], '第一次点不得发任何请求（两步确认的第一半）')

    // 点别处 → 复原（仍然零请求）
    await act(async () => {
      lane.window.document.body.dispatchEvent(new lane.window.Event('pointerdown', { bubbles: true }))
    })
    await settleAll()
    assert.equal(removeButton().textContent.trim(), '删除', '点别处必须把文案复原')
    assert.deepEqual(lane.postCalls(), [], '复原过程不得发任何请求')

    // 再来一次：第一次 → 第二次，这一下才真的删
    await lane.click(removeButton())
    assert.equal(removeButton().textContent.trim(), '确认删除')
    assert.deepEqual(lane.postCalls(), [], '第二次点之前仍然不得发请求')
    await lane.click(removeButton())

    assert.equal(deleted.length, 1, `第二次点必须恰好发 1 次 POST，实际 ${deleted.length}`)
    assert.match(deleted[0], /\/api\/providers\/ofox\/delete$/, '目标必须是 POST api/providers/<id>/delete')
    const posts = lane.postCalls()
    assert.equal(posts.length, 1)
    assert.equal(posts[0].method, 'POST', '本仓库只支持 GET/POST：删除也走 POST，不是 DELETE')
  })

  // ── task-10：在 add-card 里就能「测试连接 / 拉取模型」（打草稿）────────────────
  //
  // 冻结的宿主接口：`POST api/providers/probe`
  //   `{action:'test'|'models', catalogId, baseUrl?, apiKey}`（目录模式）
  //   `{action:'test'|'models', custom:{id,label,baseUrl}, apiKey}`（自定义模式）
  //   → test  `{ok,latencyMs?,modelCount?}`；models `{ok,models,count}`；空 apiKey → 400。
  // 「保存」新增可选 `models`（勾选结果随新增一起落盘）。

  it('A9 未填密钥时两枚探测按钮不可点，点它零请求（不许发注定 400 的请求）', async () => {
    const seen = []
    const lane = await createLane({ respond: probeResponder(seen) })
    await lane.render()
    await openAddCard(lane)

    assert.ok(probeTest(lane), 'add-card 里必须有「测试连接」（[data-pxm-add-probe-test]）')
    assert.ok(probeModels(lane), 'add-card 里必须有「拉取模型」（[data-pxm-add-probe-models]）')
    assert.equal(probeTest(lane).textContent.trim(), '测试连接', '文案沿用既有那一枚')
    assert.equal(probeModels(lane).textContent.trim(), '拉取模型', '文案沿用既有那一枚')
    assert.equal(probeTest(lane).disabled, true, '没填密钥时「测试连接」必须不可点')
    assert.equal(probeModels(lane).disabled, true, '没填密钥时「拉取模型」必须不可点')

    // 真点一下（不是"没点所以没请求"）：禁用元素的 click 不派发，handler 不会跑。
    await lane.click(probeTest(lane))
    await lane.click(probeModels(lane))
    assert.deepEqual(probePosts(lane), [], '未填密钥时点探测按钮必须零请求')
    assert.deepEqual(lane.postCalls(), [], '未填密钥时点探测按钮必须一个请求都不发')

    // 填上密钥之后两枚必须恢复可点（否则上面那两条就是"永远点不动"的假绿）。
    await lane.type(addKeyInput(lane), SECRET)
    assert.equal(probeTest(lane).disabled, false, '填了密钥后「测试连接」必须可点')
    assert.equal(probeModels(lane).disabled, false, '填了密钥后「拉取模型」必须可点')
    assert.deepEqual(probePosts(lane), [], '只是填密钥不该发任何请求')
  })

  it('A10 点「测试连接」→ 恰好 1 次 POST api/providers/probe，body 恰为 {action,catalogId,apiKey}，就地上结果', async () => {
    const seen = []
    const lane = await createLane({ respond: probeResponder(seen) })
    await lane.render()
    await openAddCard(lane)
    // 默认选中第一个未添加的厂商（夹具 = anthropic）；密钥是唯一的必填项。
    await lane.type(addKeyInput(lane), SECRET)

    await lane.click(probeTest(lane))

    assert.equal(seen.length, 1, '「测试连接」必须恰好发 1 次探测，实际 ' + String(seen.length))
    assert.deepEqual(
      seen[0],
      { action: 'test', catalogId: 'anthropic', apiKey: SECRET },
      'body 必须恰为 {action,catalogId,apiKey}（API 地址没填就**不许**出现 baseUrl）',
    )
    // 注意不能用 `lane.fetches[0]`：那一条是首屏的 `GET api/providers` —— 目标要看**探测**自身。
    assert.equal(probePosts(lane).length, 1, '探测请求必须恰好 1 条')
    assert.match(
      probePosts(lane)[0].url,
      /\/api\/providers\/probe$/,
      '探测的目标必须是 api/providers/probe',
    )
    // 就地结果（不是 alert、不是弹窗）。
    assert.ok(probeResult(lane), '成功时必须就地显示探测结果（[data-pxm-add-probe-result]）')
    assert.ok(
      (probeResult(lane).textContent ?? '').includes('连接正常'),
      '成功文案沿用既有的「连接正常」，实测 ' + JSON.stringify(probeResult(lane).textContent),
    )
    assert.ok(addCard(lane), '探测不改变 add-card 的展开状态')
  })

  it('A11 点「拉取模型」→ body 恰为 {action:models,catalogId,apiKey}，列表就地渲染出夹具的 N 条', async () => {
    const seen = []
    const lane = await createLane({ respond: probeResponder(seen) })
    await lane.render()
    await openAddCard(lane)
    await lane.type(addKeyInput(lane), SECRET)

    assert.equal(pulledList(lane), null, '还没拉取时不该有列表')
    await lane.click(probeModels(lane))

    const probes = seen.filter((body) => body.action === 'models')
    assert.equal(probes.length, 1, '「拉取模型」必须恰好发 1 次探测，实际 ' + String(probes.length))
    assert.deepEqual(
      probes[0],
      { action: 'models', catalogId: 'anthropic', apiKey: SECRET },
      'body 必须恰为 {action,catalogId,apiKey}',
    )
    assert.ok(pulledList(lane), '拉取后必须就地出现列表（[data-pxm-add-model-list]）')
    assert.deepEqual(
      pulledNames(lane),
      PROBE_MODELS,
      '列表必须逐条等于探测返回的模型（保序）',
    )
    assert.equal(pulledRows(lane).length, PROBE_MODELS.length)
    // 默认一条都不勾：勾选是用户的显式动作（"加的时候就拉"不该替用户做决定）。
    for (const row of pulledRows(lane)) {
      assert.equal(row.querySelector('input[type="checkbox"]').checked, false)
    }
  })

  it('A12 勾选 2 条 + 保存 → POST api/providers 的 body 恰为 {catalogId, apiKey, models:[…2条…]}', async () => {
    const seen = []
    const lane = await createLane({ respond: probeResponder(seen) })
    await lane.render()
    await openAddCard(lane)
    await lane.type(addKeyInput(lane), SECRET)
    await lane.click(probeModels(lane))

    // 全选 / 全不选这两枚也要真能用（否则列表只有'点单行'一条路）。
    await lane.click(lane.container.querySelector('[data-pxm-add-model-select-all]'))
    assert.deepEqual(
      pulledRows(lane)
        .filter((row) => row.querySelector('input[type="checkbox"]').checked)
        .map((row) => (row.querySelector('[data-pxm-add-model-name]')?.textContent ?? '').trim()),
      PROBE_MODELS,
      '「全选」必须勾上拉到的每一条',
    )
    await lane.click(lane.container.querySelector('[data-pxm-add-model-clear]'))
    assert.equal(
      pulledRows(lane).every((row) => row.querySelector('input[type="checkbox"]').checked === false),
      true,
      '「全不选」必须把勾选清空',
    )

    /*
     * **故意倒着勾**（第 2 条 → 第 1 条）：提交出来的 `models` 仍必须是**拉取列表的顺序**，
     * 与已保存厂商卡片里的「保存选择」同一做法 —— 否则"点的先后"会决定落盘顺序。
     */
    await toggleModelRow(lane, PROBE_MODELS[1], false)
    await toggleModelRow(lane, PROBE_MODELS[0], false)

    await lane.click(addSave(lane))

    const adds = seen.filter((body) => body.action === undefined)
    assert.equal(adds.length, 1, '「保存」必须恰好发 1 次 POST api/providers，实际 ' + String(adds.length))
    assert.deepEqual(
      adds[0],
      { catalogId: 'anthropic', apiKey: SECRET, models: [PROBE_MODELS[0], PROBE_MODELS[1]] },
      'body 必须恰为 {catalogId, apiKey, models:[勾选的那 2 条，按拉取顺序]}',
    )
    // 凑齐一整套：探测 2 次（1 test / 1 models 之外的 pull）+ 新增 1 次 = 3 次 POST。
    assert.equal(lane.postCalls().length, 2, '总 POST 数 = 1 次拉取 + 1 次新增')
  })

  it('A13 自定义 tab 下同样两条：探测 body 用 custom，保存时 models 一起走 custom', async () => {
    const seen = []
    const lane = await createLane({ respond: probeResponder(seen) })
    await lane.render()
    await openAddCard(lane)
    await switchAddMode(lane, 'custom')

    const CUSTOM = { id: 'my-relay', label: '我的中转', baseUrl: 'https://relay.example.test/v1' }
    /*
     * custom 面板还没填全（ID / API 地址空）时两枚探测按钮必须拦着：那种 body 缺字段，
     * 宿主一定判 400 —— 注定失败的请求一个都不许发。
     */
    await lane.type(addKeyInput(lane), SECRET)
    assert.equal(probeTest(lane).disabled, true, 'custom 字段没填全时「测试连接」必须不可点')
    assert.equal(probeModels(lane).disabled, true, 'custom 字段没填全时「拉取模型」必须不可点')
    await lane.click(probeTest(lane))
    await lane.click(probeModels(lane))
    assert.equal(seen.length, 0, 'custom 字段没填全时不许发探测')

    await lane.type(lane.container.querySelector('[data-pxm-add-custom-id="1"]'), CUSTOM.id)
    await lane.type(lane.container.querySelector('[data-pxm-add-custom-label="1"]'), CUSTOM.label)
    await lane.type(lane.container.querySelector('[data-pxm-add-custom-baseurl="1"]'), CUSTOM.baseUrl)
    assert.equal(probeTest(lane).disabled, false, 'custom 填全后「测试连接」必须可点')

    await lane.click(probeModels(lane))
    assert.equal(seen.length, 1, 'custom 模式的拉取必须发出去')
    assert.deepEqual(
      seen[0],
      { action: 'models', custom: CUSTOM, apiKey: SECRET },
      'custom 模式的探测 body 必须恰为 {action, custom:{id,label,baseUrl}, apiKey}',
    )

    await lane.click(probeTest(lane))
    assert.equal(seen.length, 2, 'custom 模式的测试连接必须发出去')
    assert.deepEqual(
      seen[1],
      { action: 'test', custom: CUSTOM, apiKey: SECRET },
      'custom 模式的测试 body 同样精确',
    )

    await lane.click(lane.container.querySelector('[data-pxm-add-model-select-all]'))
    await lane.click(addSave(lane))
    const adds = seen.filter((body) => body.action === undefined)
    assert.equal(adds.length, 1)
    assert.deepEqual(
      adds[0],
      { custom: CUSTOM, apiKey: SECRET, models: PROBE_MODELS },
      'custom 新增的 body 必须恰为 {custom, apiKey, models}',
    )
  })

  it('A14 「取消」必须零请求，且拉到的列表 / 勾选 / 结果一起消失（草稿丢弃）', async () => {
    const seen = []
    const lane = await createLane({ respond: probeResponder(seen) })
    await lane.render()
    await openAddCard(lane)
    await lane.type(addKeyInput(lane), SECRET)
    await lane.click(probeModels(lane))
    await toggleModelRow(lane, PROBE_MODELS[0])
    const before = lane.postCalls().length
    assert.equal(before, 1, '拉取那一次是唯一的 POST')

    await lane.click(addCancel(lane))
    assert.ok(addCard(lane) === null, '「取消」后 add-card 必须消失')
    assert.ok(addButton(lane), '「取消」后必须回到虚线按钮态')
    assert.equal(lane.postCalls().length, before, '「取消」不得新增任何请求')

    // 再展开：列表、勾选、探测结果、密钥**全部**应该是干净的。
    await openAddCard(lane)
    assert.equal(pulledList(lane), null, '取消后拉到的列表必须消失（草稿丢弃）')
    assert.equal(probeResult(lane), null, '取消后探测结果必须消失')
    assert.equal(addKeyInput(lane).value, '', '取消后密钥框必须清空')
    assert.equal(probeTest(lane).disabled, true, '取消后（密钥为空）探测按钮必须回到不可点')
  })

  it('A15 探测失败 → 就地显示结构化错误（code + message），add-card 不关闭、不新增厂商', async () => {
    /*
     * 两条失败路径的形状**不同**（provider-host task-9）：
     *   「测试连接」= HTTP 200 + `{ok:false, latencyMs, error}`；
     *   「拉取模型」= HTTP 401 + `{ok:false, error}`。
     * 两个都要就地渲染，且都不许把 add-card 关掉 / 顺手新增。
     */
    for (const [where, click, fallback] of [
      ['测试连接', (lane) => probeTest(lane), '测试中…'],
      ['拉取模型', (lane) => probeModels(lane), '拉取中…'],
    ]) {
      const seen = []
      const lane = await createLane({ respond: probeResponder(seen, { fail: true }) })
      await lane.render()
      await openAddCard(lane)
      await lane.type(addKeyInput(lane), SECRET)

      await lane.click(click(lane))
      // 等待异步落地（`probe.run` 里两次 await）。
      await settleAll()
      await settleAll()

      assert.equal(
        probePosts(lane).length,
        1,
        where + ' 失败路径也要把那一次探测发出去（只 1 次）',
      )
      const result = probeResult(lane)
      assert.ok(result, where + ' 失败时也必须就地给结果（[data-pxm-add-probe-result]）')
      const text = result.textContent ?? ''
      assert.ok(
        text.includes('密钥被拒（HTTP 401）'),
        where + ' 必须显示宿主给的可读 message，实测 ' + JSON.stringify(text),
      )
      assert.ok(
        text.includes('auth'),
        where + ' 必须带上结构化 code（沿用 postResult 的 `message（code）` 形态）',
      )
      assert.ok(addCard(lane), where + ' 失败**不许**关闭 add-card')
      assert.ok(result.querySelector('[role="alert"]'), where + ' 失败结果必须是 role="alert"')
      // 失败后按钮必须回到可点（不能卡在"测试中…"）。
      assert.equal(click(lane).textContent.trim(), fallback === '测试中…' ? '测试连接' : '拉取模型')
      assert.deepEqual(
        seen.filter((body) => body.action === undefined),
        [],
        where + ' 失败不得顺手发一次新增',
      )
      await lane.dispose()
    }
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
  // 结构变了：模型区在编辑器里，「拉取模型」要先点「编辑」才存在。
  await openVendorCard(lane, firstCard(lane))
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
    await openVendorCard(lane, firstCard(lane))
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
    /*
     * 结构变了（2026-10-12）：卡片里的模型区在**编辑器内部**，而且「编辑」开合由
     * `ProvidersSection` 持有，直接挂 `ProviderCard` 再点「编辑」已经不再等价于用户路径。
     * 所以改成挂**整个 section**，把"卸载后还去重取 api/providers"这件事按
     * **fetch 次数**数出来（比 spy 更贴近真实副作用：重取就是一次网络请求）。
     */
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
      let providerGets = 0
      const fetchImpl = (input, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase()
        const target = String(input)
        if (method === 'GET' && /\/api\/providers$/.test(target)) {
          providerGets += 1
          return Promise.resolve(jsonResponse(providersPayload()))
        }
        if (method === 'POST' && /refresh-models$/.test(target)) {
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

      const container = win.document.createElement('div')
      win.document.body.appendChild(container)
      root = createRoot(container)
      await act(async () => {
        root.render(h(exported.__test__.ProvidersSection, {}))
      })
      await settleAll()

      // 先展开编辑器，再点「拉取模型」（结构变了：模型区在编辑器里）。
      const card = container.querySelector('[data-pxm-vendor-card]')
      assert.ok(card, '必须渲染出厂商卡片')
      const editButton = card.querySelector('[data-pxm-vendor-edit]')
      assert.ok(editButton, '卡片上必须有「编辑」按钮')
      await act(async () => {
        editButton.click()
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
      const settledGets = providerGets

      await act(async () => {
        release()
      })
      await settleAll()

      assert.equal(providerGets, settledGets, '卸载后不得再重取 api/providers（那是往已卸载组件 setState）')
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
