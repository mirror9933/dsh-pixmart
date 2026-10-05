/**
 * jsdom lane：client 半的**渲染 + 轮询时序 + 浮层状态机**测试。
 *
 * 与 `client.test.mjs` 的分工：
 *   - `client.test.mjs` 只跑契约层（装载协议 / 插槽注册 / 静态约束），**不启动渲染器**，
 *     它文件头列出的「已知未覆盖项」正是本文件要补的；
 *   - 本文件用真实 jsdom + React 18 + `act()` + `node:test` mock timers，把
 *     `shell.overlay` 那张卡真的挂起来，按毫秒推进时间，看它怎么请求、怎么展开、怎么收。
 *
 * 假环境沿用 `client.test.mjs` 的思路（受控全局 + `window.__ModuleLoader__` +
 * `factory(require)`），只把「假 document」换成 jsdom、「假 React」换成真 React；
 * `fetch` 依旧自己 stub —— **零真实网络、零真实定时器**。
 *
 * 行为规格：`docs/dsh-pixmart-技术方案.md` §8.5（尤其 8.5.4 轮询红线 / 8.5.5 交互细节）。
 */
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

const SRC = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

const BASE_URL = 'http://127.0.0.1:19387/'
const PAGE = '<!doctype html><html><head></head><body></body></html>'
/**
 * jsdom 默认 `document.visibilityState === 'prerender'`（即 `document.hidden === true`），
 * 而 preview 轮询在页面不可见时**故意不发请求**（§8.5.4）。所以必须 pretendToBeVisual，
 * 否则测的就不是轮询节奏而是「隐藏页不发请求」这条正交规则了。
 */
const JSDOM_OPTIONS = { url: BASE_URL, pretendToBeVisual: true }
/** 与 client.js 里的 SESSION_KEY 一致：本标签页第一次开始观察的时刻。 */
const SESSION_KEY = 'dsh-pixmart:seen-runs'

/** 需要被 bundle（跑在 Node realm）看到的 DOM 全局。 */
const DOM_GLOBALS = [
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'getComputedStyle',
]

/**
 * 安装一组全局并返回还原函数。用属性描述符保存/还原：Node 24 的 `navigator`
 * 只有 getter，直接赋值会抛（`client.test.mjs` 已经踩过一次）。
 */
function installGlobals(entries) {
  const saved = new Map()
  for (const [key, value] of Object.entries(entries)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key) ?? null)
    if (value === undefined) continue
    try {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
    } catch {
      /* 装不上就用宿主自带的，不影响被测逻辑 */
    }
  }
  return () => {
    for (const [key, descriptor] of saved) {
      try {
        if (descriptor === null) delete globalThis[key]
        else Object.defineProperty(globalThis, key, descriptor)
      } catch {
        /* 恢复失败不影响测试结论 */
      }
    }
  }
}

function domEntries(win) {
  const entries = { window: win, document: win.document }
  for (const key of DOM_GLOBALS) if (win[key] !== undefined) entries[key] = win[key]
  return entries
}

// react-dom 在 import 时会做一次 DOM 能力探测（canUseDOM），所以先垫一个 jsdom 再 import；
// 之后每个用例各自换自己的 jsdom，React 按 `container.ownerDocument` 渲染，互不干扰。
const bootstrap = new JSDOM(PAGE, JSDOM_OPTIONS)
installGlobals(domEntries(bootstrap.window))
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = (await import('react')).default
const ReactDOMClient = await import('react-dom/client')
const ReactDOMTestUtils = await import('react-dom/test-utils')
const createRoot = ReactDOMClient.createRoot ?? ReactDOMClient.default?.createRoot
/**
 * React 18 的 `act`：18.0–18.2 只从 `react-dom/test-utils` 拿；18.3 起 `react` 也导出
 * 同一个实现，而 test-utils 那份每次调用都会打一条 deprecation 警告。
 * 两个都在，优先用不吵的那个，`react-dom/test-utils` 作为回落。
 */
const act = React.act ?? ReactDOMTestUtils.act
const h = React.createElement

// ── 厂商响应的小工具（fetch 全 stub，永不触网） ───────────────────────────────

const jsonOk = (body) => ({ ok: true, status: 200, json: async () => body })
const never = () => new Promise(() => {})

const isListUrl = (url) => url.includes('/api/runs?limit=')
const isDetailUrl = (url, runId) => url.endsWith('/api/runs/' + runId)
const isCancelUrl = (url, runId) => url.endsWith('/api/runs/' + runId + '/cancel')

/** 列表摘要是没有 items 的（§8.5.3：items 只在详情里）。 */
const summary = (run) => {
  const { items, ...rest } = run
  return rest
}

/** 一条「本页面加载之后新开始」的运行（默认 startedAt 晚于本页面基线）。 */
function runningRun(over = {}) {
  const now = Date.now()
  return {
    runId: 'run-1',
    sessionId: 'sess-1',
    tool: 'batch',
    provider: 'ofox',
    model: 'gpt-image-1',
    size: '1:1',
    status: 'running',
    total: 8,
    completed: 3,
    failed: 0,
    currentLabel: '白底主图',
    projectId: 'proj-1',
    projectName: '陶瓷马克杯',
    startedAt: now + 1000,
    updatedAt: now,
    items: [
      { index: 0, module: 'main.white-bg', label: '白底主图', status: 'done', file: 'images/0.png', width: 1024, height: 1024 },
      { index: 1, module: 'detail.hero', label: '详情首屏', status: 'running' },
    ],
    ...over,
  }
}

/** 「列表给摘要、详情给全文」的常规路由。 */
const routeFor = (run) => (url) =>
  isListUrl(url) ? jsonOk({ ok: true, runs: [summary(run)], count: 1 }) : jsonOk({ ok: true, run })

function findButton(lane, text) {
  return [...lane.container.querySelectorAll('button')].find((node) => node.textContent.trim() === text)
}

/**
 * 断言「这里不该有节点」。
 *
 * 必须写成布尔断言：`assert.equal(node, null)` 在**失败**时会把 DOM 节点交给
 * `util.inspect` 生成 diff，而 jsdom 节点的对象图（node → ownerDocument → defaultView
 * → document → …）会让它长时间打转（实测把整个测试进程卡死十几分钟，CPU 满载）。
 * 断言失败必须是**便宜**的，否则一次真正的回归会表现为「测试挂住」而不是「测试红了」。
 */
function assertAbsent(node, message) {
  assert.equal(node === null, true, message)
}

// ── lane：一个「受控页面」 ────────────────────────────────────────────────────

const openLanes = new Set()

/**
 * 起一个新页面：fresh jsdom + fresh bundle 求值（于是 store / 轮询器 / 页面基线都是新的）。
 */
async function createLane(options = {}) {
  const dom = new JSDOM(PAGE, JSDOM_OPTIONS)
  const win = dom.window

  const fetches = []
  let concurrent = 0
  let maxConcurrent = 0
  let respond = options.respond ?? (() => jsonOk({ ok: true, runs: [], count: 0 }))

  const fetchImpl = (input, init) => {
    const url = String(input)
    const method = String(init?.method ?? 'GET').toUpperCase()
    fetches.push({ url, method })
    concurrent += 1
    if (concurrent > maxConcurrent) maxConcurrent = concurrent
    let out
    try {
      out = respond(url, init)
    } catch (err) {
      out = Promise.reject(err)
    }
    return Promise.resolve(out).then(
      (response) => {
        concurrent -= 1
        return response
      },
      (err) => {
        concurrent -= 1
        throw err
      },
    )
  }

  const restoreGlobals = installGlobals({ ...domEntries(win), fetch: fetchImpl })

  // 预置「本标签页第一次开始观察的时刻」＝模拟「刷新后恢复」的页面。
  if (typeof options.mountedAt === 'number') {
    win.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ mountedAt: options.mountedAt }))
  }

  let loaded = null
  win.__ModuleLoader__ = {
    load(entry) {
      loaded = entry
    },
  }
  new Function(SRC)()
  assert.ok(loaded !== null, 'bundle 必须通过 window.__ModuleLoader__.load 注册自己')

  const exported = loaded.factory((name) => {
    if (name === 'react') return React
    throw new Error('未预期的 require("' + String(name) + '")')
  })
  const bag = exported.__test__ ?? {}
  assert.equal(typeof bag.PreviewOverlay, 'function', 'client.js 必须导出 __test__.PreviewOverlay 供 jsdom lane 使用')
  assert.equal(typeof bag.runPoller?.snapshot, 'function', 'client.js 必须导出 __test__.runPoller')

  const container = win.document.createElement('div')
  win.document.body.appendChild(container)
  const root = createRoot(container)

  /** 排空微任务队列：让 fetch → json → setState 这条 await 链走完。 */
  const settle = () => new Promise((resolve) => setImmediate(resolve))

  const lane = {
    window: win,
    document: win.document,
    container,
    exported,
    fetches,
    unmounted: false,
    get maxConcurrent() {
      return maxConcurrent
    },
    setRespond(next) {
      respond = next
    },
    snapshot: () => bag.runPoller.snapshot(),
    test: bag,
    card: () => container.querySelector('.pxm-card'),
    badge: () => container.querySelector('.pxm-badge'),
    overlay: () => container.querySelector('.pxm-overlay'),
    elements: () => container.querySelectorAll('*').length,

    async render() {
      await act(async () => {
        root.render(h(bag.PreviewOverlay, null))
      })
      await settle()
    },

    /** 推进 mock 时钟，并把这一轮里异步链的后续做完（都在 act 内，避免 act 警告）。 */
    async advance(ms = 1000) {
      await act(async () => {
        mock.timers.tick(ms)
        await settle()
      })
    },

    async click(element) {
      assert.ok(element, '要点击的元素必须存在')
      await act(async () => {
        element.click()
        await settle()
      })
    },

    async pressEscape() {
      await act(async () => {
        win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }))
        await settle()
      })
    },

    async visibilityChange() {
      await act(async () => {
        win.document.dispatchEvent(new win.Event('visibilitychange'))
        await settle()
      })
    },

    async unmount() {
      if (lane.unmounted) return
      lane.unmounted = true
      await act(async () => {
        root.unmount()
      })
      await settle()
    },

    async dispose() {
      try {
        await lane.unmount()
      } catch {
        /* 卸载本身失败不掩盖真正的断言 */
      }
      openLanes.delete(lane)
      restoreGlobals()
      try {
        win.close()
      } catch {
        /* jsdom 已关就无所谓 */
      }
    },
  }

  openLanes.add(lane)
  return lane
}

// ── 用例 ──────────────────────────────────────────────────────────────────────

describe('jsdom lane：实时预览卡（shell.overlay）', () => {
  beforeEach(() => {
    // 只接管 setTimeout：轮询全靠它；setImmediate / microtask / MessageChannel 保持真实，
    // 后者是 React 调度器要用的。
    mock.timers.enable({ apis: ['setTimeout'] })
  })

  afterEach(async () => {
    for (const lane of [...openLanes].reverse()) {
      try {
        await lane.dispose()
      } catch {
        /* 清理失败不改变用例结论 */
      }
    }
    mock.timers.reset()
  })

  it('① 空闲不渲染 DOM：没有运行记录时容器里一个元素都没有', async () => {
    const lane = await createLane({ respond: () => jsonOk({ ok: true, runs: [], count: 0 }) })
    await lane.render()
    assert.equal(lane.container.childNodes.length, 0, '首个请求还没回来时就不该有 DOM')
    await lane.advance(1000)
    assert.equal(lane.fetches.length, 1, '只应有首轮列表查询')
    assert.equal(lane.container.innerHTML, '', '空闲态必须不渲染任何 DOM')
    assertAbsent(lane.overlay(), '空闲态连浮层容器都不该有')
  })

  it('② 空闲不发请求：首轮查询后没有 running，推进 30s 也不再多一次 fetch', async () => {
    const lane = await createLane({ respond: () => jsonOk({ ok: true, runs: [], count: 0 }) })
    await lane.render()
    await lane.advance(1000)
    const afterFirstQuery = lane.fetches.length
    assert.equal(afterFirstQuery, 1)
    for (let i = 0; i < 30; i += 1) await lane.advance(1000)
    assert.equal(lane.fetches.length, afterFirstQuery, '空闲即停表：不得有任何后续请求')
  })

  it('③ 运行中轮询：按 1s 节奏拉 api/runs/<id>，显示 3/8 与当前模块名', async () => {
    const lane = await createLane()
    const run = runningRun()
    lane.setRespond(routeFor(run))

    await lane.render()
    await lane.advance(1000) // t=0：首轮列表 → 采纳运行
    assert.ok(lane.card(), '运行中应自动展开卡片')

    const detailCalls = () => lane.fetches.filter((call) => isDetailUrl(call.url, run.runId))
    assert.equal(detailCalls().length, 0, '首轮只查列表，不查详情')
    await lane.advance(500)
    assert.equal(detailCalls().length, 0, '差 500ms 不应提前拉详情')
    await lane.advance(500)
    assert.equal(detailCalls().length, 1, '满 1s 拉一次运行详情')
    await lane.advance(1000)
    assert.equal(detailCalls().length, 2, '再满 1s 再拉一次')
    await lane.advance(1000)
    assert.equal(detailCalls().length, 3)
    assert.equal(
      detailCalls().every((call) => call.method === 'GET'),
      true,
      '详情必须是 GET',
    )

    const text = ' ' + lane.card().textContent + ' '
    assert.match(text, /生成中 · 3\/8 · 白底主图/, '卡片要同时给出进度与当前模块名：' + text)
    assert.ok(text.includes('3/8'), '必须有形如 3/8 的计数')
  })

  it('④ in-flight guard：响应悬挂时推进多个周期，并发请求数始终为 1', async () => {
    const lane = await createLane()
    const run = runningRun()
    let hang = false
    const hangingReplies = []

    lane.setRespond((url) => {
      if (isDetailUrl(url, run.runId)) {
        if (hang) {
          let resolve
          const pending = new Promise((r) => {
            resolve = r
          })
          hangingReplies.push(resolve)
          return pending
        }
        return jsonOk({ ok: true, run })
      }
      return jsonOk({ ok: true, runs: [summary(run)], count: 1 })
    })

    await lane.render()
    await lane.advance(1000) // 采纳运行
    hang = true
    await lane.advance(1000) // 详情在途，悬挂
    const whileInFlight = lane.fetches.length
    assert.equal(hangingReplies.length, 1)
    assert.equal(lane.maxConcurrent, 1)

    for (let i = 0; i < 5; i += 1) {
      // 可见性变化 → refresh()：在途时仍会排一次 tick —— 这正是 guard 要在的地方
      await lane.visibilityChange()
      await lane.advance(1000)
      assert.equal(lane.fetches.length, whileInFlight, '在途时不得再发任何请求（第 ' + String(i + 1) + ' 轮）')
      assert.equal(lane.maxConcurrent, 1, '并发请求数必须始终为 1')
    }

    // 悬挂解除后轮询恢复：反过来证明上面几轮 tick 真的跑到了 guard 分支，而不是压根没跑
    for (const resolve of hangingReplies) resolve(jsonOk({ ok: true, run }))
    await lane.advance(1000)
    assert.ok(lane.fetches.length > whileInFlight, '悬挂解除后应立即恢复轮询')
    assert.equal(lane.maxConcurrent, 1)
  })

  it('⑤ 首屏恢复只出徽标不自动展开；本页面加载后新开始的运行才自动展开', async () => {
    // (a) 恢复：startedAt 早于本页面加载基线
    const recovered = await createLane()
    const oldRun = runningRun({ runId: 'run-old', startedAt: Date.now() - 60_000 })
    recovered.setRespond(routeFor(oldRun))
    await recovered.render()
    await recovered.advance(1000)
    assert.ok(recovered.badge(), '首屏已在跑的运行必须出现徽标')
    assertAbsent(recovered.card(), '首屏恢复的运行不得自动展开（避免首轮请求后大幅位移）')
    await recovered.click(recovered.badge())
    assert.ok(recovered.card(), '点徽标应能手动展开（自动策略不等于禁止展开）')
    await recovered.dispose()

    // (b) 新开始：startedAt 晚于本页面加载基线
    const fresh = await createLane()
    const newRun = runningRun({ runId: 'run-new' })
    fresh.setRespond(routeFor(newRun))
    await fresh.render()
    await fresh.advance(1000)
    assert.ok(fresh.card(), '本页面加载之后新开始的运行应自动展开')
    assertAbsent(fresh.badge(), '展开态不应同时留徽标')
  })

  it('⑥ 运行中转 done：收起为徽标且 DOM 不撑大（尺寸声明与元素数快照）', async () => {
    const lane = await createLane()
    const live = runningRun()
    const finished = { ...live, status: 'done', completed: 8, failed: 0, currentLabel: undefined }
    let phase = 'live'
    lane.setRespond((url) => {
      const run = phase === 'live' ? live : finished
      return isListUrl(url) ? jsonOk({ ok: true, runs: [summary(run)], count: 1 }) : jsonOk({ ok: true, run })
    })

    await lane.render()
    await lane.advance(1000)
    assert.ok(lane.card(), '运行中应展开')
    const expandedElements = lane.elements()
    const expandedOverlayStyle = lane.overlay().getAttribute('style')
    const cardWidth = lane.card().style.width

    phase = 'done'
    await lane.advance(1000)

    assertAbsent(lane.card(), '结束后卡片必须收起')
    assert.ok(lane.badge(), '结束后应留下徽标（保留，而不是消失）')
    // 徽标可见文本只有 ✓8/8；「已完成」这件事挂在 aria-label / title 上（无障碍轨道）
    const badgeLabel = lane.badge().getAttribute('aria-label')
    assert.match(String(badgeLabel), /生图已完成/, '徽标要表达已结束：' + String(badgeLabel))
    assert.match(' ' + lane.badge().textContent + ' ', /8\/8/, '徽标要带最终计数')
    assert.ok(lane.elements() < expandedElements, '收起后 DOM 规模必须小于展开时')

    // jsdom 没有排版引擎（所有 rect 都是 0），所以「高度快照」退化为：
    // ① 外层 overlay 的内联尺寸声明前后必须一模一样；② 徽标子树里不得残留卡片的尺寸声明。
    assert.equal(lane.overlay().getAttribute('style'), expandedOverlayStyle, 'overlay 自身不得因收起而改变尺寸声明')
    assert.equal(/height|width/.test(expandedOverlayStyle), false, 'overlay 定位层本就不该声明宽高')
    for (const node of [lane.badge(), ...lane.badge().querySelectorAll('*')]) {
      assert.notEqual(node.style.width, cardWidth, '徽标子树不得残留卡片宽度')
      assert.equal(node.style.maxHeight, '', '徽标子树不得残留卡片高度上限')
    }

    // (b) 用户手动展开＝固定展开：结束后不得被自动收起覆盖（§8.5.5「用户可固定展开」）
    const pinned = await createLane()
    const live2 = runningRun({ runId: 'run-pin' })
    const done2 = { ...live2, status: 'done', completed: 8, currentLabel: undefined }
    let phase2 = 'live'
    pinned.setRespond((url) => {
      const run = phase2 === 'live' ? live2 : done2
      return isListUrl(url) ? jsonOk({ ok: true, runs: [summary(run)], count: 1 }) : jsonOk({ ok: true, run })
    })
    await pinned.render()
    await pinned.advance(1000)
    await pinned.click(findButton(pinned, '收起'))
    assert.ok(pinned.badge(), '「收起」按钮应把卡片收成徽标')
    await pinned.click(pinned.badge())
    assert.ok(pinned.card(), '点徽标应重新展开')
    phase2 = 'done'
    await pinned.advance(1000)
    assert.ok(pinned.card(), '用户手动展开＝固定展开，结束后应保持展开')
  })

  it('⑦ Escape 收起', async () => {
    const lane = await createLane()
    const run = runningRun()
    lane.setRespond(routeFor(run))
    await lane.render()
    await lane.advance(1000)
    assert.ok(lane.card())

    await lane.pressEscape()
    assertAbsent(lane.card(), 'Escape 应把卡片收成徽标')
    assert.ok(lane.badge())

    await lane.click(lane.badge())
    assert.ok(lane.card(), 'Escape 只是收起，不是永久禁用展开')
  })

  it('⑧ 取消按钮对 api/runs/<id>/cancel 发 POST', async () => {
    const lane = await createLane()
    const run = runningRun()
    const cancels = []
    lane.setRespond((url, init) => {
      if (isCancelUrl(url, run.runId)) {
        cancels.push({ url, init })
        return jsonOk({ ok: true, cancelled: true, kept: 0 })
      }
      return isListUrl(url) ? jsonOk({ ok: true, runs: [summary(run)], count: 1 }) : jsonOk({ ok: true, run })
    })

    await lane.render()
    await lane.advance(1000)
    const button = findButton(lane, '取消')
    assert.ok(button, '运行中必须有取消按钮')

    await lane.click(button)
    assert.equal(cancels.length, 1, '点击取消必须恰好发一次取消请求')
    assert.equal(String(cancels[0].init.method).toUpperCase(), 'POST', '取消必须是 POST')
    assert.ok(cancels[0].url.endsWith('/api/runs/' + run.runId + '/cancel'), '取消要打对 runId：' + cancels[0].url)
    assert.equal(
      lane.fetches.filter((call) => call.method === 'POST').length,
      1,
      '整轮测试只应有这一次 POST',
    )
    assert.equal(
      lane.fetches.filter((call) => call.url.includes('/cancel') && call.method !== 'POST').length,
      0,
      '取消不得退化成 GET',
    )
  })

  it('⑨ 卸载即停：unmount 后推进时间不再有新请求', async () => {
    const lane = await createLane()
    const run = runningRun()
    lane.setRespond(routeFor(run))
    await lane.render()
    await lane.advance(1000)
    await lane.advance(1000)
    const beforeUnmount = lane.fetches.length
    assert.ok(beforeUnmount >= 3, '卸载前应已在轮询')

    await lane.unmount()
    assert.equal(lane.container.innerHTML, '', '卸载后浮层 DOM 必须清空')

    for (let i = 0; i < 20; i += 1) await lane.advance(1000)
    assert.equal(lane.fetches.length, beforeUnmount, 'unmount 后 timer 必须已停：不得再有任何请求')

    await lane.visibilityChange()
    await lane.advance(1000)
    assert.equal(lane.fetches.length, beforeUnmount, '可见性事件也不得再唤醒轮询')
  })

  it('⑩ 响应形状异常不抛异常，且保留上一次成功快照（stale）', async () => {
    const lane = await createLane()
    const run = runningRun()
    let malformed = false
    lane.setRespond((url) => {
      if (malformed) return jsonOk({ ok: true }) // {ok:true} 但 runs / run 不是数组或对象
      return isListUrl(url) ? jsonOk({ ok: true, runs: [summary(run)], count: 1 }) : jsonOk({ ok: true, run })
    })

    await lane.render()
    await lane.advance(1000)
    await lane.advance(1000)
    assert.ok(lane.card(), '先拿到一次成功快照')

    malformed = true
    await assert.doesNotReject(async () => {
      await lane.advance(1000)
    }, '形状异常时轮询不得抛异常')
    await assert.doesNotReject(async () => {
      await lane.advance(1000)
    })

    const snapshot = lane.snapshot()
    assert.equal(snapshot.stale, true, '刷新失败必须标记 stale')
    assert.match(String(snapshot.error), /形状/, '错误信息要说明响应形状不符合预期')
    assert.equal(snapshot.run.total, 8, '必须保留上一次成功快照（total）')
    assert.equal(snapshot.run.completed, 3, '必须保留上一次成功快照（completed）')
    assert.equal(snapshot.run.status, 'running', '不得把失败当成运行状态变化')

    const text = ' ' + lane.card().textContent + ' '
    assert.match(text, /3\/8/, '界面仍显示上一次成功快照')
    assert.match(text, /数据可能过期/, '并提示数据可能过期')
  })
})
