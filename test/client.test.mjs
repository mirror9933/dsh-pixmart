/**
 * client 半的契约测试。
 *
 * ## 能测什么、不能测什么（先读这段）
 *
 * `client/client.js` 是浏览器 bundle，交互行为住在 React 组件里（`useEffect` 驱动的
 * 轮询、浮层的展开/收起状态机）。**本文件不启动 React 渲染器**，因此以下内容
 * 明确**未覆盖**：
 *   - 轮询节奏与 in-flight guard 的真实时序
 *   - 首屏恢复「只出徽标不自动展开」
 *   - 结束后收徽标、Escape 收起、reduced-motion
 *   - 缩略图实际能否加载
 * 要覆盖这些需要 jsdom + 真实 React 渲染（即 Skill 说的 jsdom lane），
 * 属**已知未补齐项**，见 P3 收尾说明。
 *
 * 本文件覆盖的是**不需要渲染就能验证、且退化了会直接坏事**的契约层：
 *   1. bundle 装载协议：`window.__ModuleLoader__.load({ id, factory })`，factory 只吃 require
 *   2. `apply` 注册了三处插槽，且 metadata（id / order / label / key）正确
 *   3. 注册发生在 `ctx.effect` 内 —— 这是可卸载/HMR 安全的前提
 *   4. **某个插槽缺失时，其余插槽仍照常注册，且不抛异常**（否则设置面板会白屏）
 *   5. `apply` 期间**不发任何网络请求**（初始加载必须是惰性的）
 *   6. 静态契约：无 JSX、无 `host.call` 调用、无写死根绝对路径
 */
import { after, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

/** 极简 document：只够模块加载与 styles 注入用。 */
function makeDocument() {
  const head = {
    children: [],
    appendChild(node) {
      this.children.push(node)
      node.parentNode = this
      return node
    },
    removeChild(node) {
      const index = this.children.indexOf(node)
      if (index >= 0) this.children.splice(index, 1)
      node.parentNode = null
      return node
    },
  }

  const document = {
    head,
    body: { children: [], appendChild(node) { this.children.push(node); return node }, removeChild() {} },
    baseURI: 'http://127.0.0.1:19387/',
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        attributes: {},
        style: {},
        children: [],
        textContent: '',
        setAttribute(name, value) {
          this.attributes[name] = String(value)
        },
        getAttribute(name) {
          return this.attributes[name] ?? null
        },
        appendChild(node) {
          this.children.push(node)
          return node
        },
        removeChild(node) {
          const index = this.children.indexOf(node)
          if (index >= 0) this.children.splice(index, 1)
          return node
        },
        remove() {
          if (this.parentNode) this.parentNode.removeChild(this)
        },
        addEventListener() {},
        removeEventListener() {},
      }
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null
    },
    documentElement: { style: {}, setAttribute() {}, removeAttribute() {} },
  }
  return document
}

/** 记录调用、可注入缺口的 slots 假实现。 */
function makeSlots(options = {}) {
  const missing = new Set(options.missing ?? [])
  const registrations = []
  const injections = []

  return {
    registrations,
    injections,
    inject(key, callback) {
      injections.push(key)
      if (missing.has(key)) return () => {}
      const effect = callback()
      return typeof effect === 'function' ? effect : () => {}
    },
    register(meta, component) {
      registrations.push({ meta, component })
      Object.defineProperty(registrations[registrations.length - 1], 'slotName', {
        value: meta?.name ?? null,
      })
      return () => {}
    },
  }
}

/**
 * 在受控全局下执行 bundle，返回它的模块导出与假 ctx。
 * @param options - `missing` 指定"宿主没有这些插槽"；`onFetch` 记录网络请求。
 */
function loadBundle(options = {}) {
  const slots = makeSlots(options)
  const effects = []
  const fetches = []

  const ctx = {
    slots,
    effect(callback, label) {
      const dispose = callback()
      effects.push({ label, dispose: typeof dispose === 'function' ? dispose : () => {} })
      return () => {}
    },
    on() {
      return () => {}
    },
    get(name) {
      return name === 'slots' ? slots : undefined
    },
  }

  const document = makeDocument()
  let loaded = null

  const window = {
    __ModuleLoader__: {
      load(entry) {
        loaded = entry
      },
    },
    document,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    location: { href: 'http://127.0.0.1:19387/' },
  }

  const globals = {
    window,
    document,
    fetch: async (input, init) => {
      fetches.push({ url: String(input), init })
      if (options.onFetch) return options.onFetch(String(input), init)
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, runs: [], count: 0, projects: [], providers: [] }),
      }
    },
    requestAnimationFrame: (cb) => globalThis.setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id) => globalThis.clearTimeout(id),
  }

  const saved = {}
  for (const [key, value] of Object.entries(globals)) {
    saved[key] = { had: key in globalThis, value: globalThis[key] }
    try {
      // 用 defineProperty：某些全局（Node 24 的 navigator）只有 getter，直接赋值会抛。
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
    } catch {
      // 定义不了就用宿主自带的，不影响被测逻辑
    }
  }

  try {
    // bundle 是 IIFE 形态，用 Function 求值让它引用我们安装的全局。
    new Function(SRC)()
  } finally {
    for (const [key, entry] of Object.entries(saved)) {
      try {
        if (entry.had) {
          Object.defineProperty(globalThis, key, { value: entry.value, configurable: true, writable: true })
        } else {
          delete globalThis[key]
        }
      } catch {
        // 恢复失败不影响测试结论
      }
    }
  }

  assert.ok(loaded !== null, 'bundle 必须通过 window.__ModuleLoader__.load 注册自己')
  const exported = loaded.factory((name) => {
    if (name === 'react') return makeReact()
    throw new Error(`未预期的 require("${name}")`)
  })

  return { entry: loaded, exported, ctx, slots, effects, fetches, document }
}

/** 极简 React：够 `apply` 与组件定义求值，不承担渲染。 */
function makeReact() {
  const createElement = (type, props, ...children) => ({ type, props, children })
  return {
    createElement,
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
  }
}

describe('client bundle 装载协议', () => {
  it('id 是包名，factory 只依赖 require', () => {
    const { entry, exported } = loadBundle()
    assert.equal(entry.id, 'dsh-pixmart')
    assert.equal(typeof entry.factory, 'function')
    assert.equal(exported.name, 'dsh-pixmart')
    assert.equal(typeof exported.apply, 'function')
    assert.ok(Array.isArray(exported.inject) && exported.inject.includes('slots'))
  })
})

describe('apply 注册三处插槽', () => {
  let bundle

  beforeEach(() => {
    bundle = loadBundle()
    bundle.exported.apply(bundle.ctx)
  })

  it('注册了 settings.section 且 metadata 正确', () => {
    const found = bundle.slots.registrations.find((r) => r.meta?.name === 'settings.section')
    assert.ok(found, '必须注册 settings.section')
    assert.equal(found.meta.id, 'pixmart')
    assert.equal(found.meta.order, 30)
    assert.equal(typeof found.meta.label === 'function' ? found.meta.label() : found.meta.label, '电商生图')
  })

  it('注册了 sidebar.panellist 与配套的 main(keyed)', () => {
    const icon = bundle.slots.registrations.find((r) => r.meta?.name === 'sidebar.panellist')
    assert.ok(icon, '必须注册 sidebar.panellist')
    assert.equal(icon.meta.id, 'pixmart')
    assert.equal(icon.meta.order, 10)

    const panel = bundle.slots.registrations.find((r) => r.meta?.name === 'main')
    assert.ok(panel, '必须注册 main')
    // panellist 的 id 必须等于 main 的 key —— 这是 R3 验证过的对应关系
    assert.equal(panel.meta.key, icon.meta.id)
  })

  it('注册了 shell.overlay 实时预览卡', () => {
    const overlay = bundle.slots.registrations.find((r) => r.meta?.name === 'shell.overlay')
    assert.ok(overlay, '必须注册 shell.overlay')
    assert.equal(overlay.meta.id, 'pixmart-preview')
    assert.equal(overlay.meta.order, 50)
  })

  it('每个插槽都在 ctx.effect 内注册（可卸载 / HMR 安全）', () => {
    assert.ok(bundle.effects.length >= 3, `期望至少 3 个 effect，实际 ${bundle.effects.length}`)
    for (const effect of bundle.effects) {
      assert.equal(typeof effect.dispose, 'function', `effect "${effect.label}" 必须返回 disposer`)
    }
  })

  it('卸载时不抛异常', () => {
    for (const effect of bundle.effects) {
      assert.doesNotThrow(() => effect.dispose())
    }
  })

  it('apply 期间不发网络请求（初始加载必须惰性）', () => {
    assert.equal(bundle.fetches.length, 0, `apply 期间不应请求：${JSON.stringify(bundle.fetches)}`)
  })
})

describe('宿主插槽缺失时的降级', () => {
  it('某个插槽不存在时，其余插槽仍注册且不抛异常', () => {
    const bundle = loadBundle({ missing: ['sidebar.panellist'] })
    assert.doesNotThrow(() => bundle.exported.apply(bundle.ctx))

    const names = bundle.slots.registrations.map((r) => r.meta?.name)
    assert.ok(names.includes('settings.section'), 'settings.section 应仍被注册')
    assert.ok(names.includes('shell.overlay'), 'shell.overlay 应仍被注册')
    assert.equal(names.includes('sidebar.panellist'), false, '缺失的插槽本就不该注册')
  })

  it('全部插槽缺失时 apply 仍不抛异常', () => {
    const bundle = loadBundle({
      missing: ['settings.section', 'sidebar.panellist', 'main', 'shell.overlay'],
    })
    assert.doesNotThrow(() => bundle.exported.apply(bundle.ctx))
    assert.equal(bundle.slots.registrations.length, 0)
  })
})

describe('静态契约', () => {
  /**
   * 去掉注释后再做静态检查：文件头大量"不要用 X"的说明本身就是文档，
   * 不排除注释会把这些正确的约束误判成违规（第一版就误报了两处）。
   */
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('没有 JSX（无构建步骤，必须是 createElement）', () => {
    assert.equal(/React\.createElement\([^)]*</.test(CODE), false)
    assert.equal(/^\s*</m.test(CODE), false)
  })

  it('没有调用 host.call（包式 client 半拿不到它）', () => {
    assert.equal(/\bhost\.call\s*\(/.test(CODE), false)
  })

  it('没有写死根绝对路径（前缀部署下会失效）', () => {
    assert.equal(/['"`]\/pixmart\//.test(CODE), false)
  })

  it('API 基址相对 document.baseURI 解析', () => {
    assert.ok(CODE.includes('document.baseURI'), '应从 document.baseURI 解析基址')
  })
})
