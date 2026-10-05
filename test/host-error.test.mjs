/**
 * 宿主错误文案的翻译锁。
 *
 * 为什么值得单独测：DSH 的两半不对称——**客户端刷新即生效，宿主必须重启**。
 * 宿主还是旧代码时，新接口落到路由兜底并回 `unknown_route`，而它的 message 是
 * 内部路由片段（如 `/providers/ofox/test`）。那条文案看起来像客户端拼错了 URL，
 * 实际含义是"宿主没重启"——这个歧义已经让用户白测过一轮。
 *
 * 所以这条翻译是**面向用户的可执行提示**，不是装修：改坏了用户又会去查客户端。
 *
 * 本文件自带一个最小装载器（只够跑纯函数），不依赖 jsdom —— 翻译是纯函数，
 * 不该为了测它去启动渲染环境。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

/** 极简 React：本用例不会渲染，只要求 factory 求值时不炸。 */
function stubReact() {
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

function loadClientBundle() {
  let loaded = null
  const document = {
    baseURI: 'http://127.0.0.1:19387/',
    head: { appendChild() {}, removeChild() {} },
    createElement: () => ({
      style: {},
      attributes: {},
      children: [],
      setAttribute() {},
      appendChild() {},
      removeChild() {},
      remove() {},
      addEventListener() {},
    }),
    addEventListener() {},
    removeEventListener() {},
  }

  const globals = {
    window: {
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
    },
    document,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
  }

  const saved = {}
  for (const [key, value] of Object.entries(globals)) {
    saved[key] = { had: key in globalThis, value: globalThis[key] }
    try {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
    } catch {
      // navigator 之类的 getter-only 全局跳过，用宿主自带的
    }
  }

  try {
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
        // 恢复失败不影响结论
      }
    }
  }

  assert.ok(loaded !== null, 'bundle 必须通过 window.__ModuleLoader__.load 注册自己')
  return { entry: loaded, exported: loaded.factory((name) => {
    if (name === 'react') return stubReact()
    throw new Error(`未预期的 require("${name}")`)
  }) }
}

const { exported } = loadClientBundle()
const { explainHostError, HOST_STALE_HINT } = exported.__test__

describe('explainHostError', () => {
  it('unknown_route 翻译成"去重启宿主"，而不是回显内部路由', () => {
    const raw = '/providers/ofox/refresh-models'
    const message = explainHostError('unknown_route', raw)

    assert.equal(message, HOST_STALE_HINT)
    assert.equal(message.includes('/providers/'), false, '不得回显内部路由片段')
    assert.match(message, /重启/)
    assert.match(message, /DeepSeek Harness/)
  })

  it('其他错误码原样透传（不吞掉宿主的真实原因）', () => {
    assert.equal(explainHostError('auth', '密钥被拒（HTTP 401）'), '密钥被拒（HTTP 401）')
    assert.equal(explainHostError('no_api_key', '未配置密钥'), '未配置密钥')
    assert.equal(explainHostError('bad_url', 'baseUrl 必须是 http(s)'), 'baseUrl 必须是 http(s)')
  })

  it('错误码缺失时也不误报成"宿主过旧"', () => {
    assert.equal(explainHostError(undefined, 'HTTP 500'), 'HTTP 500')
    assert.equal(explainHostError('', 'HTTP 500'), 'HTTP 500')
  })
})
