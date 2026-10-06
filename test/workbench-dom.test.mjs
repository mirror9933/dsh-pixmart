/**
 * jsdom lane：作品库（第 1 批信息可见性 + 第 2 批软删/回收站/复制提示词）。
 *
 * 与 `workbench.test.mjs` 的分工：
 *   - `workbench.test.mjs` 锁**宿主**契约（路由、磁盘、回收站、导出）；
 *   - 本文件把 `__test__.WorkbenchPanel` 真的挂进 jsdom，验证**客户端**那一半：
 *     提示词/模型/耗时/失败原因真的渲染出来了、复制按钮存在且失败会降级、
 *     删除要二次确认、回收站能列出并恢复、请求中按钮禁用、失败不白屏。
 *
 * **零真实网络**：`fetch` 全部 stub；`navigator.clipboard` 按用例注入。
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

// ── 夹具 ────────────────────────────────────────────────────────────────────

const CREATED_AT = Date.UTC(2026, 9, 5, 12, 0, 0)
const PROJECT_ID = '2026-10-05-工作台'
const PROMPT = '纯白背景，柔和阴影，陶瓷马克杯'
const FAIL_REASON = '厂商拒绝：HTTP 400 invalid size'

const projectSummary = {
  id: PROJECT_ID,
  name: '工作台',
  createdAt: CREATED_AT,
  provider: 'ofox',
  model: 'gpt-image-1',
  imageCount: 1,
  cover: PROJECT_ID + '/images/ab12cd34-white-bg.png',
}

const projectDetail = {
  ok: true,
  project: {
    id: PROJECT_ID,
    name: '工作台',
    createdAt: CREATED_AT,
    provider: 'ofox',
    model: 'gpt-image-1',
    items: [
      {
        module: 'main.white-bg',
        label: '白底主图',
        status: 'ok',
        size: '1:1',
        apiMode: 'images-generations',
        images: ['images/ab12cd34-white-bg.png'],
        width: 1024,
        height: 1024,
        prompt: PROMPT,
        model: 'gpt-image-1',
        ms: 12345,
        createdAt: Date.UTC(2026, 9, 5, 12, 1, 0),
        degraded: ['openai-compat → gemini-native 回退'],
      },
      {
        module: 'detail.hero',
        label: '详情首屏',
        status: 'failed',
        size: '3:4',
        apiMode: 'images-edits',
        images: [],
        prompt: '详情首屏，暖光',
        model: 'gpt-image-1',
        ms: 812,
        createdAt: Date.UTC(2026, 9, 5, 12, 2, 0),
        degraded: [],
        error: FAIL_REASON,
      },
    ],
  },
}

const trashPayload = {
  ok: true,
  count: 1,
  trash: [
    {
      id: '2026-10-04-旧项目',
      projectId: '2026-10-04-旧项目',
      name: '旧项目',
      createdAt: Date.UTC(2026, 9, 4, 8, 0, 0),
      deletedAt: Date.UTC(2026, 9, 5, 9, 30, 0),
      imageCount: 3,
      provider: 'ofox',
      model: 'gpt-image-1',
    },
  ],
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

/**
 * 默认路由：列表 + 详情 + 回收站 + 配置（导出路径），写操作按需覆盖。
 *
 * `exportDir` 给一个绝对路径：导出按钮把它当作 `dir` 发出去。
 * 未配置时**客户端预检即拦下**（`checkExportDir`，详情页与批量导出共用），
 * 不发那次注定失败的请求；宿主的 `no_export_dir` 仍保留为权威兜底。
 */
const EXPORT_DIR = 'D:/PixMartExport'

function providersPayload(over = {}) {
  return {
    ok: true,
    dataDir: 'D:/pixmart',
    dataDirNotes: [],
    warnings: [],
    defaults: { provider: 'ofox', model: 'gpt-image-1', size: '1:1', n: 1 },
    limits: { maxConcurrency: 2, maxBatchItems: 20, maxRetries: 3, retentionDays: 0 },
    exportDir: EXPORT_DIR,
    providers: [],
    ...over,
  }
}

function defaultRespond(url, init = {}) {
  const method = String(init.method ?? 'GET').toUpperCase()
  if (method === 'GET') {
    if (url.includes('/api/trash')) return jsonResponse(trashPayload)
    if (url.includes('/api/providers')) return jsonResponse(providersPayload())
    if (url.includes('/api/projects?limit=')) {
      return jsonResponse({ ok: true, count: 1, projects: [projectSummary] })
    }
    if (url.includes('/api/projects/')) return jsonResponse(projectDetail)
  }
  return jsonResponse({ ok: true })
}

// ── 批次 C 的夹具 ──────────────────────────────────────────────────────────

/** 造 n 个可区分的项目摘要（名字 / 时间 / 张数都不同）。 */
function makeProjects(n) {
  const out = []
  for (let i = 1; i <= n; i += 1) {
    const id = 'P' + String(i).padStart(2, '0')
    out.push({
      id,
      name: 'Project-' + String(i).padStart(2, '0'),
      createdAt: CREATED_AT + i * 60000,
      provider: 'ofox',
      model: 'gpt-image-1',
      imageCount: i,
      cover: id + '/images/cover-' + String(i) + '.png',
    })
  }
  return out
}

/**
 * 会真的按 `q` / `sort` / `limit` / `offset` 分页的假宿主。
 *
 * 关键在于它**报 total / hasMore**：界面「加载更多（还有 N 个）」按钮出不出现、
 * 剩余条数写多少，全靠这两个字段。用固定的单页响应测不出分页行为
 * （旧缺陷正是"永远只有一页"）。
 *
 * 2026-10-10：原来的「显示 N / 共 M」计数行按用户要求移除（工具条压成一行），
 * 这个假宿主报的 `total` 现在只剩「加载更多」按钮一个消费方。
 */
function pagedRespond(all) {
  return (url, init = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase()
    if (method === 'GET' && url.includes('/api/projects?limit=')) {
      const parsed = new URL(url, BASE_URL)
      const limit = Number(parsed.searchParams.get('limit')) || 24
      const offset = Number(parsed.searchParams.get('offset')) || 0
      const q = (parsed.searchParams.get('q') ?? '').toLowerCase()
      const sort = parsed.searchParams.get('sort') ?? 'createdAt:desc'
      let items = all.slice()
      if (q !== '') items = items.filter((item) => String(item.name).toLowerCase().includes(q))
      if (sort === 'name:asc') items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      else if (sort === 'createdAt:asc') items.sort((a, b) => a.createdAt - b.createdAt)
      else if (sort === 'images:desc') items.sort((a, b) => b.imageCount - a.imageCount)
      else items.sort((a, b) => b.createdAt - a.createdAt)
      const page = items.slice(offset, offset + limit)
      return jsonResponse({
        ok: true,
        count: page.length,
        total: items.length,
        hasMore: offset + page.length < items.length,
        offset,
        limit,
        projects: page,
      })
    }
    return defaultRespond(url, init)
  }
}

/** 同一模块 2 张 + 另一个模块 1 张：摊平后 3 张，用于查看器/对比的用例。 */
const detailMultiImage = {
  ok: true,
  project: {
    id: PROJECT_ID,
    name: '工作台',
    createdAt: CREATED_AT,
    provider: 'ofox',
    model: 'gpt-image-1',
    items: [
      {
        module: 'main.white-bg',
        label: '白底主图',
        status: 'ok',
        size: '1:1',
        apiMode: 'images-generations',
        images: ['images/aa-white-bg.png', 'images/bb-white-bg.png'],
        width: 1024,
        height: 1024,
        prompt: PROMPT,
        model: 'gpt-image-1',
        ms: 12345,
        createdAt: CREATED_AT,
        degraded: [],
      },
      {
        module: 'detail.hero',
        label: '详情首屏',
        status: 'ok',
        size: '3:4',
        apiMode: 'images-edits',
        images: ['images/cc-hero.png'],
        width: 896,
        height: 1200,
        prompt: '详情首屏，暖光',
        model: 'gpt-image-1',
        ms: 800,
        createdAt: CREATED_AT,
        degraded: [],
      },
    ],
  },
}

// ── lane ────────────────────────────────────────────────────────────────────

const openLanes = new Set()

async function createLane(options = {}) {
  const dom = new JSDOM(PAGE, JSDOM_OPTIONS)
  const win = dom.window
  const calls = []
  let respond = options.respond ?? defaultRespond

  const fetchImpl = (input, init) => {
    const url = String(input)
    const method = String(init?.method ?? 'GET').toUpperCase()
    const call = { url, method, body: init?.body }
    calls.push(call)
    let out
    try {
      out = respond(url, init)
    } catch (err) {
      out = Promise.reject(err)
    }
    return Promise.resolve(out)
  }

  const globals = { ...domEntries(win), fetch: fetchImpl }
  if (options.navigator !== undefined) globals.navigator = options.navigator
  const restoreGlobals = installGlobals(globals)

  let loaded = null
  win.__ModuleLoader__ = { load: (entry) => (loaded = entry) }
  new Function(SRC)()
  assert.ok(loaded !== null, 'bundle 必须通过 window.__ModuleLoader__.load 注册自己')

  const exported = loaded.factory((name) => {
    if (name === 'react') return React
    throw new Error('未预期的 require("' + String(name) + '")')
  })
  const bag = exported.__test__ ?? {}
  assert.equal(typeof bag.WorkbenchPanel, 'function', 'client.js 必须导出 __test__.WorkbenchPanel')

  const container = win.document.createElement('div')
  win.document.body.appendChild(container)
  const root = createRoot(container)
  const settle = async () => {
    // fetch → json → setState → effect 这条链要多排几轮微任务/宏任务才稳定。
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve))
  }

  const lane = {
    window: win,
    container,
    calls,
    bag,
    setRespond(next) {
      respond = next
    },
    text: () => container.textContent ?? '',
    buttons: () => [...container.querySelectorAll('button')],
    button(label) {
      return lane.buttons().find((node) => node.textContent.trim() === label) ?? null
    },
    byClass(className) {
      return container.querySelector('.' + className)
    },
    posts: (suffix) => calls.filter((call) => call.method === 'POST' && call.url.endsWith(suffix)),

    async render() {
      await act(async () => {
        root.render(h(bag.WorkbenchPanel, null))
      })
      await settle()
    },

    async click(node) {
      const target = typeof node === 'string' ? lane.button(node) : node
      assert.ok(target, `要点击的元素必须存在：${String(typeof node === 'string' ? node : node?.className)}`)
      await act(async () => {
        target.click()
      })
      await settle()
    },

    /** 只统计"取项目列表"的请求（详情、回收站、配置都不算）。 */
    listCalls() {
      return calls.filter((call) => call.url.includes('/api/projects?limit='))
    },

    /** 真实等一段时间（防抖是 250ms 的真定时器，不是可以 setImmediate 糊弄过去的）。 */
    async wait(ms) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms))
      })
      await settle()
    },

    /** 往受控 input 里敲字：必须走原生 setter + input 事件，React 才认。 */
    async type(input, value) {
      assert.ok(input, '要输入的 input 必须存在')
      const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')?.set
      await act(async () => {
        setter.call(input, value)
        input.dispatchEvent(new win.Event('input', { bubbles: true }))
      })
    },

    /** 改受控 select 的值。 */
    async choose(select, value) {
      assert.ok(select, '要选择的 select 必须存在')
      const setter = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value')?.set
      await act(async () => {
        setter.call(select, value)
        select.dispatchEvent(new win.Event('change', { bubbles: true }))
      })
      await settle()
    },

    /** 在 document 上派发一次键盘事件（查看器把 Esc / ← → / Tab 挂在 document 上）。 */
    async key(key, init = {}) {
      await act(async () => {
        win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, ...init }))
      })
      await settle()
    },

    async unmount() {
      await act(async () => root.unmount())
      await settle()
    },

    async dispose() {
      try {
        await lane.unmount()
      } catch {
        /* 卸载失败不改变断言 */
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

/** 进入某个项目的详情。 */
async function openDetail(lane) {
  const tile = lane.byClass('pxm-tile')
  assert.ok(tile, '项目卡片必须渲染出来')
  await lane.click(tile)
  assert.ok(lane.text().includes('白底主图'), '详情应加载出来')
}

// ── 用例 ────────────────────────────────────────────────────────────────────

describe('jsdom lane：作品库列表', () => {
  it('卡片上显示创建时间', async () => {
    const lane = await createLane()
    await lane.render()
    assert.ok(lane.text().includes('工作台'))
    assert.ok(lane.text().includes('2026-10-05'), '项目卡片必须补上创建时间')
  })
})

describe('jsdom lane：详情 = 生产记录', () => {
  it('渲染出提示词 / 模型 / 耗时 / 时间 / 降级标记 / apiMode', async () => {
    const lane = await createLane()
    await lane.render()
    await openDetail(lane)

    const text = lane.text()
    assert.ok(text.includes(PROMPT), '提示词必须显示出来')
    assert.ok(text.includes('gpt-image-1'), '模型必须显示出来')
    assert.ok(text.includes('12.3 s'), '耗时必须显示出来（12345ms → 12.3 s）')
    assert.ok(text.includes('812 ms'), '毫秒级耗时不四舍五入到秒')
    assert.ok(text.includes('2026-10-05'), '每项的时间必须显示出来')
    assert.ok(text.includes('降级'), 'degraded 非空时必须有降级标记')
    assert.ok(text.includes('gemini-native'), '降级链路要能看出具体走了什么')
    assert.ok(text.includes('images-generations'), 'apiMode 必须渲染出来')
    assert.ok(text.includes('images-edits'))
  })

  it('失败项显示失败原因原文', async () => {
    const lane = await createLane()
    await lane.render()
    await openDetail(lane)

    const node = lane.container.querySelector('.pxm-item-error')
    assert.ok(node, '失败项必须有失败原因节点')
    assert.ok(node.textContent.includes(FAIL_REASON), '失败原因要显示原文，而不是一句"生成失败"')
  })

  it('每个模块都有复制提示词按钮；成功后按钮变「已复制」', async () => {
    const written = []
    const lane = await createLane({
      navigator: {
        clipboard: {
          writeText: async (value) => {
            written.push(value)
          },
        },
      },
    })
    await lane.render()
    await openDetail(lane)

    const copyButtons = lane.container.querySelectorAll('.pxm-copy-btn')
    assert.equal(copyButtons.length, 2, '两个模块各有一个复制按钮（失败项也有提示词）')

    await lane.click(copyButtons[0])
    assert.deepEqual(written, [PROMPT], '写进剪贴板的必须是这条提示词的原文')
    assert.ok(lane.text().includes('已复制'))
    assert.equal(lane.byClass('pxm-copy-fallback') === null, true, '成功时不该展开降级文本')
  })

  it('剪贴板不可用时不静默失败：降级为可选中文本 + 显示原因', async () => {
    const lane = await createLane({
      navigator: {
        clipboard: {
          writeText: async () => {
            throw new Error('NotAllowedError: 剪贴板被拒绝')
          },
        },
      },
    })
    await lane.render()
    await openDetail(lane)
    await lane.click(lane.byClass('pxm-copy-btn'))

    assert.ok(lane.text().includes('复制失败'), '失败必须显示出来')
    assert.ok(lane.text().includes('NotAllowedError'), '失败原因要可读')
    const fallback = lane.byClass('pxm-copy-fallback')
    assert.ok(fallback, '降级成 textarea，用户能手动选中复制')
    assert.equal(fallback.value, PROMPT)
    assert.equal(fallback.readOnly, true)
  })
})

describe('jsdom lane：删除必须二次确认', () => {
  it('点「删除项目」不会立刻发请求；确认后才 POST confirm:true', async () => {
    const lane = await createLane()
    await lane.render()
    await openDetail(lane)

    await lane.click('删除项目')
    assert.equal(lane.posts('/delete').length, 0, '第一次点击只展开确认，不得直接删除')
    assert.ok(lane.text().includes('确认删除这个项目？'), '必须出现二次确认')

    // 取消 → 依然不发请求
    await lane.click('取消')
    assert.equal(lane.posts('/delete').length, 0)

    await lane.click('删除项目')
    await lane.click('确认删除')

    const deletes = lane.posts('/delete')
    assert.equal(deletes.length, 1)
    assert.equal(deletes[0].url.endsWith('/api/projects/' + encodeURIComponent(PROJECT_ID) + '/delete'), true)
    assert.deepEqual(JSON.parse(String(deletes[0].body)), { confirm: true }, '服务端二次校验要的 confirm 必须发出去')
    assert.ok(lane.text().includes('移入回收站'), '删除成功要有明确反馈')
    assert.equal(lane.byClass('pxm-tile') !== null, true, '删除后回到列表并重新取数')
  })

  it('删除请求在途中按钮禁用（防连点）', async () => {
    let release = null
    const lane = await createLane({
      respond(url, init = {}) {
        if (String(init.method ?? 'GET').toUpperCase() === 'POST' && url.endsWith('/delete')) {
          return new Promise((resolve) => {
            release = () => resolve(jsonResponse({ ok: true, trashed: true, trashId: PROJECT_ID }))
          })
        }
        return defaultRespond(url, init)
      },
    })
    await lane.render()
    await openDetail(lane)
    await lane.click('删除项目')
    await lane.click('确认删除')

    const confirmBtn = lane.byClass('pxm-confirm-delete')
    assert.ok(confirmBtn, '确认按钮还在（请求未回）')
    assert.equal(confirmBtn.disabled, true, '请求中按钮必须禁用')
    assert.ok(confirmBtn.textContent.includes('删除中'), '按钮文案要反映在途状态')

    await act(async () => {
      release()
    })
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve))
  })

  it('删除失败在界面内显示可读原因，不白屏', async () => {
    const lane = await createLane({
      respond(url, init = {}) {
        if (String(init.method ?? 'GET').toUpperCase() === 'POST' && url.endsWith('/delete')) {
          return jsonResponse({ ok: false, error: { code: 'confirm_required', message: '需要 confirm: true' } }, 400)
        }
        return defaultRespond(url, init)
      },
    })
    await lane.render()
    await openDetail(lane)
    await lane.click('删除项目')
    await lane.click('确认删除')

    assert.ok(lane.text().includes('需要 confirm: true'), '失败原因必须显示在界面里')
    assert.equal(lane.container.querySelectorAll('*').length > 0, true, '不得白屏')
  })
})

describe('jsdom lane：导出', () => {
  it('导出成功后显示导出目录，且按钮在途中禁用', async () => {
    const lane = await createLane({
      respond(url, init = {}) {
        if (String(init.method ?? 'GET').toUpperCase() === 'POST' && url.endsWith('/export')) {
          return jsonResponse({
            ok: true,
            count: 1,
            dir: EXPORT_DIR + '/' + PROJECT_ID,
            files: [EXPORT_DIR + '/x.png'],
            warnings: [],
          })
        }
        return defaultRespond(url, init)
      },
    })
    await lane.render()
    await openDetail(lane)
    await lane.click('导出图片')

    const posts = lane.posts('/export')
    assert.equal(posts.length, 1)
    // 语义变更：导出目录来自设置里的「作品库导出路径」，客户端把它作为 dir 传上去
    assert.deepEqual(JSON.parse(String(posts[0].body)), { dir: EXPORT_DIR })
    assert.ok(lane.text().includes('已导出 1 个文件到'), '要给用户导出落点')
    assert.ok(lane.text().includes(EXPORT_DIR))
  })

  it('未配置导出路径 → 客户端预检即拦下：给可读提示、引导去设置、**不发那次注定失败的请求**', async () => {
    const lane = await createLane({
      respond(url, init = {}) {
        const method = String(init.method ?? 'GET').toUpperCase()
        if (method === 'GET' && url.includes('/api/providers')) {
          return jsonResponse(providersPayload({ exportDir: '' }))
        }
        // 仍备一个 400 兜底：万一实现退回"发出去看宿主"，用例要能明确报出来
        if (method === 'POST' && url.endsWith('/export')) {
          return jsonResponse(
            {
              ok: false,
              error: {
                code: 'no_export_dir',
                message: '没有可用的导出目录：请先在设置里配置作品库导出路径',
              },
            },
            400,
          )
        }
        return defaultRespond(url, init)
      },
    })
    await lane.render()
    await openDetail(lane)
    await lane.click('导出图片')

    // 判定已收敛到 `checkExportDir`，详情页与批量导出共用同一处。
    // 这条比旧断言**更强**：旧版只验证"发出去后被宿主拒、再显示文案"，
    // 现在要求根本不发那次注定失败的请求。宿主的 400 仍保留为权威兜底。
    assert.equal(lane.posts('/export').length, 0, '未配置导出路径时不得发出导出请求')
    assert.ok(lane.text().includes('还没有配置「作品库导出路径」'), '必须给出可读提示')
    assert.ok(lane.text().includes('设置'), '必须引导用户去设置页')
    assert.equal(lane.container.querySelectorAll('*').length > 0, true, '不得白屏')
  })
})

describe('jsdom lane：回收站', () => {
  it('列出回收站项目并带「恢复」按钮；恢复后重新取数', async () => {
    const lane = await createLane({
      respond(url, init = {}) {
        if (String(init.method ?? 'GET').toUpperCase() === 'POST') {
          if (url.endsWith('/restore')) return jsonResponse({ ok: true, restored: true, id: '2026-10-04-旧项目' })
          if (url.endsWith('/purge')) return jsonResponse({ ok: true, purged: 1 })
        }
        return defaultRespond(url, init)
      },
    })
    await lane.render()
    await lane.click('回收站')

    const item = lane.byClass('pxm-trash-item')
    assert.ok(item, '回收站要列出条目')
    assert.ok(item.textContent.includes('旧项目'))
    assert.ok(item.textContent.includes('3 张'), '条目要显示张数')
    assert.ok(item.textContent.includes('删除于'), '条目要显示删除时间')

    const restore = lane.byClass('pxm-restore-btn')
    assert.ok(restore, '每条都要有恢复按钮')
    await lane.click(restore)

    const restores = lane.posts('/restore')
    assert.equal(restores.length, 1)
    assert.equal(restores[0].url.endsWith('/api/trash/' + encodeURIComponent('2026-10-04-旧项目') + '/restore'), true)
    assert.ok(lane.text().includes('已恢复'), '恢复要有反馈')
    // 恢复后重新取回收站与列表
    assert.equal(lane.calls.filter((call) => call.url.includes('/api/trash')).length >= 2, true)
  })

  it('清空回收站也要二次确认，且带上 confirm:true', async () => {
    const lane = await createLane({
      respond(url, init = {}) {
        if (String(init.method ?? 'GET').toUpperCase() === 'POST' && url.endsWith('/purge')) {
          return jsonResponse({ ok: true, purged: 1 })
        }
        return defaultRespond(url, init)
      },
    })
    await lane.render()
    await lane.click('回收站')

    await lane.click('清空回收站')
    assert.equal(lane.posts('/purge').length, 0, '第一次点击只展开确认')
    assert.ok(lane.text().includes('清空后不可恢复'), '要说明不可恢复')

    await lane.click('确认清空')
    const purges = lane.posts('/purge')
    assert.equal(purges.length, 1)
    assert.deepEqual(JSON.parse(String(purges[0].body)), { confirm: true })
    assert.ok(lane.text().includes('已清空'))
  })

  it('回收站读取失败只在面板内报错，不抛异常', async () => {
    const lane = await createLane({
      respond(url, init = {}) {
        if (url.includes('/api/trash')) {
          return jsonResponse({ ok: false, error: { code: 'internal', message: '磁盘读不了' } }, 500)
        }
        return defaultRespond(url, init)
      },
    })
    await lane.render()
    await lane.click('回收站')
    assert.ok(lane.text().includes('读取回收站失败'))
    assert.ok(lane.text().includes('磁盘读不了'))
  })
})

// ── 批次 C：搜索 / 排序 / 懒加载 / 分页 ────────────────────────────────────

describe('jsdom lane：搜索 / 排序 / 分页', () => {
  it('搜索要防抖：连敲三次只合并成一次请求，且带上 q', async () => {
    const lane = await createLane({ respond: pagedRespond(makeProjects(3)) })
    await lane.render()
    assert.equal(lane.listCalls().length, 1, '首屏只取一页')

    const debounceMs = lane.bag.SEARCH_DEBOUNCE_MS
    assert.equal(typeof debounceMs, 'number', '__test__ 必须暴露 SEARCH_DEBOUNCE_MS')

    const input = lane.byClass('pxm-search')
    assert.ok(input, '必须有搜索框')
    await lane.type(input, 'P')
    await lane.type(input, 'Pr')
    await lane.type(input, 'Pro')
    assert.equal(lane.listCalls().length, 1, '防抖窗口内一个字都不该发请求')

    await lane.wait(debounceMs + 120)
    const after = lane.listCalls()
    assert.equal(after.length, 2, '三次输入只合成一次请求')
    assert.ok(after[1].url.includes('q=Pro'), '请求要带上最终的搜索词')

    // 清空按钮：清掉之后回到全量
    await lane.click(lane.byClass('pxm-search-clear'))
    await lane.wait(debounceMs + 120)
    const cleared = lane.listCalls()
    assert.equal(cleared.length, 3)
    assert.equal(cleared[2].url.includes('q='), false, '清空后不得再带 q')
  })

  it('懒加载：封面一张、带 loading=lazy + decoding=async，且已加载条数 == 渲染出的卡片数', async () => {
    const lane = await createLane({ respond: pagedRespond(makeProjects(3)) })
    await lane.render()

    const tiles = lane.container.querySelectorAll('.pxm-tile')
    assert.equal(tiles.length, 3)
    // 每个项目**只加载封面一张**（详情才有多图）
    assert.equal(lane.container.querySelectorAll('.pxm-tile img').length, 3)
    for (const img of lane.container.querySelectorAll('.pxm-tile img')) {
      assert.equal(img.getAttribute('loading'), 'lazy')
      assert.equal(img.getAttribute('decoding'), 'async')
    }
    /*
     * 2026-10-10 布局改动：原来这里断言界面上有「显示 3 / 共 3」。
     * 按用户要求工具条压成一行、「显示 N / 共 M」被移除，所以锚点换成
     * **已渲染的卡片数**——它才是那个计数串的**事实来源**（`shown = projects.length`）。
     * 强度不降反升：原来断言的是 `shown` 被格式化成一段文字，现在直接钉住
     * "3 条已加载就渲染 3 张卡片"，中间那层格式化被删掉之后依然成立。
     * 见 `test/workbench-dom.test.mjs` 文件内多处同批改动，以及
     * `client/client.js` 工具条上方那条「刻意回归」注释。
     */
    assert.equal(
      lane.container.querySelectorAll('.pxm-tile').length,
      3,
      '已加载 3 条就要渲染 3 张卡片（「显示 N / 共 M」已按用户要求移除，锚点改为已渲染卡片数）',
    )
    assert.equal(lane.byClass('pxm-load-more'), null, '没有更多时不该出现加载更多')
    // total == shown ⇒「加载更多」必须消失；**hasMore 现在只剩这一处可见**（见 client.js 注释）。
    assert.equal(
      lane.text().includes('加载更多'),
      false,
      '取完了就不该再有「加载更多」——它是现在唯一体现 hasMore 的载体',
    )
  })

  it('加载更多是**追加**，且排序变化重置回第一页', async () => {
    const lane = await createLane({ respond: pagedRespond(makeProjects(30)) })
    await lane.render()

    const pageSize = lane.bag.PROJECT_PAGE_SIZE
    assert.equal(pageSize, 24, '每页 24 条（宿主 limit 上限 200，客户端不越权）')
    assert.equal(lane.container.querySelectorAll('.pxm-tile').length, 24)
    /*
     * 2026-10-10：原来的 `显示 24 / 共 30` 断言随「显示 N / 共 M」一起改锚。
     * 换上来的是两条**更靠近事实**的断言：
     *   ① 已渲染卡片数 == 首页大小（24）；
     *   ② 「加载更多」按钮把自己的**剩余条数**写出来（`total - shown` = 30 - 24 = 6）
     *      —— 这恰好是 `hasMore` 现在**唯一**的可见载体，比原来只断言一段计数文字
     *      更能证明"宿主报的 total 真的被界面用上了"。
     */
    const loadMoreBefore = lane.byClass('pxm-load-more')
    assert.ok(loadMoreBefore, '30 条只加载了 24 条 ⇒ 必须有「加载更多」')
    assert.equal(
      loadMoreBefore.textContent.includes('还有 6 个'),
      true,
      '「加载更多」要写出剩余条数（30 - 24 = 6）：实测 ' + String(loadMoreBefore.textContent),
    )

    await lane.click(lane.byClass('pxm-load-more'))
    assert.equal(lane.container.querySelectorAll('.pxm-tile').length, 30, '加载更多必须追加而不是替换')
    assert.equal(lane.byClass('pxm-load-more'), null, '没有更多了就不再显示按钮')
    assert.equal(lane.listCalls()[1].url.includes('offset=24'), true, '第二页从 offset=24 取')

    // 排序变化 → 回到第一页（替换，不是在被追加了 30 条的列表后面再接一页）
    await lane.choose(lane.byClass('pxm-sort'), 'name:asc')
    assert.equal(lane.container.querySelectorAll('.pxm-tile').length, 24, '排序变化必须重置分页')
    const reset = lane.listCalls()[lane.listCalls().length - 1]
    assert.ok(reset.url.includes('offset=0'), '重置要回到第一页')
    assert.ok(reset.url.includes('sort=name%3Aasc'), '排序要传给宿主')
  })

  it('宿主只回 total 没回 hasMore 时也能推出「还有更多」（不出现自相矛盾的计数）', async () => {
    const page = makeProjects(30).slice(0, 24)
    const lane = await createLane({
      respond(url, init = {}) {
        const method = String(init.method ?? 'GET').toUpperCase()
        if (method === 'GET' && url.includes('/api/projects?limit=')) {
          return jsonResponse({ ok: true, count: page.length, projects: page, total: 30 })
        }
        return defaultRespond(url, init)
      },
    })
    await lane.render()
    /*
     * 2026-10-10：原来这里断言 `显示 24 / 共 30`。那串文字已按用户要求移除，
     * 改锚到**推论本身**：宿主没回 `hasMore`，界面只能靠 `total(30) > shown(24)`
     * 推出"还有更多"。这个推论现在唯一的表现就是「加载更多」按钮**存在**，
     * 所以断言它存在 + 写出剩余 6 个 —— 与本用例的意图（6 个项目不能凭空消失）
     * 完全一致，强度不低于原来那条文字断言。
     */
    const loadMore = lane.byClass('pxm-load-more')
    assert.ok(loadMore, '只给 total 也要能推出"还有更多"，否则 6 个项目等于凭空消失')
    assert.equal(
      loadMore.textContent.includes('还有 6 个'),
      true,
      '剩余条数 = total(30) - shown(24) = 6：实测 ' + String(loadMore.textContent),
    )
    assert.equal(lane.container.querySelectorAll('.pxm-tile').length, 24, '首页仍只渲染 24 张卡片')
  })

  it('取数失败时保留已加载的项目并给出可读原因（不白屏）', async () => {
    const many = makeProjects(30)
    const lane = await createLane({
      respond(url, init = {}) {
        if (String(init.method ?? 'GET').toUpperCase() === 'GET' && url.includes('offset=24')) {
          return jsonResponse({ ok: false, error: { code: 'internal', message: '磁盘读不了' } }, 500)
        }
        return pagedRespond(many)(url, init)
      },
    })
    await lane.render()
    await lane.click(lane.byClass('pxm-load-more'))

    assert.ok(lane.text().includes('读取作品库失败'))
    assert.ok(lane.text().includes('磁盘读不了'))
    assert.equal(lane.container.querySelectorAll('.pxm-tile').length, 24, '一次失败不该清空已加载的列表')
  })
})

// ── 批次 C：查看器 / 对比 ──────────────────────────────────────────────────

describe('jsdom lane：大图查看器与并排对比', () => {
  function multiImageRespond(url, init = {}) {
    const method = String(init.method ?? 'GET').toUpperCase()
    if (method === 'GET' && url.includes('/api/projects/')) return jsonResponse(detailMultiImage)
    return pagedRespond([projectSummary])(url, init)
  }

  it('点图打开查看器：显示模块名/尺寸/模型/提示词，多张时显示「1 / 3」', async () => {
    const lane = await createLane({ respond: multiImageRespond })
    await lane.render()
    await openDetail(lane)

    const thumbs = [...lane.container.querySelectorAll('.pxm-thumb')]
    assert.equal(thumbs.length, 3, '摊平后应是 2 + 1 张')
    assert.equal(lane.byClass('pxm-viewer'), null, '没点之前不该有查看器')

    await lane.click(thumbs[0])
    const viewer = lane.byClass('pxm-viewer')
    assert.ok(viewer, '点图必须打开全屏覆盖层')
    // 覆盖层是 position:fixed 的，**不是 shell.overlay**
    assert.equal(viewer.style.position, 'fixed')

    const text = viewer.textContent
    assert.ok(text.includes('白底主图'), '要显示模块名')
    assert.ok(text.includes('1:1'), '要显示尺寸')
    assert.ok(text.includes('gpt-image-1'), '要显示模型')
    assert.ok(text.includes(PROMPT), '要显示提示词')
    assert.ok(text.includes('1 / 3'), '多张时要显示位置')
    assert.ok(viewer.querySelector('.pxm-copy-btn'), '提示词要可复制')
  })

  it('Esc 关闭并还原焦点；← → 只在项目内的图片之间切换', async () => {
    const lane = await createLane({ respond: multiImageRespond })
    await lane.render()
    await openDetail(lane)

    const thumbs = [...lane.container.querySelectorAll('.pxm-thumb')]
    await lane.click(thumbs[0])
    assert.ok(lane.byClass('pxm-viewer').textContent.includes('1 / 3'))

    await lane.key('ArrowRight')
    assert.ok(lane.byClass('pxm-viewer').textContent.includes('2 / 3'), '→ 到第 2 张')
    await lane.key('ArrowRight')
    assert.ok(lane.byClass('pxm-viewer').textContent.includes('3 / 3'), '→ 越过模块边界（详情首屏那张）')
    await lane.key('ArrowRight')
    assert.ok(lane.byClass('pxm-viewer').textContent.includes('1 / 3'), '到底后回绕')
    await lane.key('ArrowLeft')
    assert.ok(lane.byClass('pxm-viewer').textContent.includes('3 / 3'), '← 往回')

    await lane.key('Escape')
    assert.equal(lane.byClass('pxm-viewer'), null, 'Esc 必须关掉查看器')
    const active = lane.window.document.activeElement
    assert.ok(active, '关闭后必须有焦点落点')
    assert.ok(
      String(active.className ?? '').includes('pxm-thumb'),
      '焦点要还给打开它的那张缩略图，而不是丢到 body 上（实际：' + String(active.className) + '）',
    )

    // 关掉之后键盘不再影响界面（监听器要解绑）
    const before = lane.text()
    await lane.key('ArrowRight')
    assert.equal(lane.byClass('pxm-viewer'), null)
    assert.equal(lane.text(), before, '关闭后方向键不应再改变任何东西')
  })

  it('并排对比开关只在当前模块有多张时出现；打开后是 2-up', async () => {
    const lane = await createLane({ respond: multiImageRespond })
    await lane.render()
    await openDetail(lane)

    const thumbs = [...lane.container.querySelectorAll('.pxm-thumb')]
    // 第 1、2 张属于同一个模块（2 张）→ 有对比开关
    await lane.click(thumbs[0])
    assert.ok(lane.byClass('pxm-compare-toggle'), '同模块有多张时必须提供对比开关')
    assert.equal(lane.byClass('pxm-compare-pair'), null, '开关默认关着')

    const box = lane.byClass('pxm-compare-toggle').querySelector('input')
    await lane.click(box)
    assert.ok(lane.byClass('pxm-compare-pair'), '打开后必须是并排两张')
    assert.equal(lane.byClass('pxm-compare-pair').querySelectorAll('img').length, 2, '2-up：两张图')

    // 切到"详情首屏"（该模块只有 1 张）→ 开关必须消失
    await lane.key('ArrowRight')
    await lane.key('ArrowRight')
    assert.ok(lane.byClass('pxm-viewer').textContent.includes('3 / 3'))
    assert.equal(lane.byClass('pxm-compare-toggle'), null, '只有 1 张时不该出现对比开关')
    assert.equal(lane.byClass('pxm-compare-pair'), null)
  })

  it('关闭查看器不残留覆盖层；卸载后落地的响应不再 setState', async () => {
    const lane = await createLane({ respond: multiImageRespond })
    await lane.render()
    await openDetail(lane)
    await lane.click(lane.container.querySelectorAll('.pxm-thumb')[0])
    await lane.key('Escape')
    assert.equal(lane.byClass('pxm-viewer'), null)
    await lane.unmount()
    assert.equal(lane.container.innerHTML, '', '卸载后容器必须是空的（没有异常重建）')
  })

  it('关闭查看器把滚动位置放回打开前的原处', async () => {
    const lane = await createLane({ respond: multiImageRespond })
    await lane.render()
    await openDetail(lane)

    // jsdom 没有布局，`window.scrollY` 恒为 0 —— 这里替一个值来代表"打开前页面滚过"，
    // 并替换 `scrollTo` 成一个记录调用的替身（jsdom 自带的那个是"未实现"）。
    const scrolls = []
    lane.window.scrollTo = (x, y) => {
      scrolls.push([x, y])
    }
    Object.defineProperty(lane.window, 'scrollY', { value: 480, configurable: true })

    await lane.click(lane.container.querySelectorAll('.pxm-thumb')[0])
    assert.ok(lane.byClass('pxm-viewer'), '查看器要开着')

    // 查看器打开期间页面被滚回了顶部（真实浏览器里聚焦/锚点都可能造成这件事）
    Object.defineProperty(lane.window, 'scrollY', { value: 0, configurable: true })
    await lane.key('Escape')

    assert.deepEqual(scrolls, [[0, 480]], '关闭后必须把滚动位置复原到打开前的值')
  })
})

// ── 批次 C：多选 / 批量导出 / 批量删除 ─────────────────────────────────────

describe('jsdom lane：多选与批量操作', () => {
  it('全选只作用于当前筛选结果（被过滤掉的项目不会被选中）', async () => {
    const all = makeProjects(3)
    const lane = await createLane({ respond: pagedRespond(all) })
    await lane.render()
    assert.equal(lane.container.querySelectorAll('.pxm-tile').length, 3)

    // 筛选到只剩 1 个
    await lane.type(lane.byClass('pxm-search'), 'Project-02')
    await lane.wait(lane.bag.SEARCH_DEBOUNCE_MS + 120)
    assert.equal(lane.container.querySelectorAll('.pxm-tile').length, 1)

    const selectAll = lane.byClass('pxm-select-all')
    assert.ok(selectAll, '必须有全选按钮')
    assert.equal(selectAll.textContent.includes('当前 1 个'), true, '按钮文案要写明作用范围')

    await lane.click(selectAll)
    assert.ok(lane.text().includes('已选 1'), '只选中筛选结果里的那一个')

    await lane.click('删除选中')
    await lane.click('确认删除选中')

    const deletes = lane.posts('/delete')
    assert.equal(deletes.length, 1, '只删筛选结果里的那一个')
    assert.ok(deletes[0].url.includes(encodeURIComponent('P02')))
    assert.equal(
      deletes.some((call) => call.url.includes(encodeURIComponent('P01')) || call.url.includes(encodeURIComponent('P03'))),
      false,
      '被过滤掉的项目绝不能出现在删除请求里',
    )
  })

  it('批量删除必须二次确认，文案写明"移入回收站、可恢复"', async () => {
    const lane = await createLane({ respond: pagedRespond(makeProjects(2)) })
    await lane.render()

    // 用卡片上的复选框选中一个
    const box = lane.container.querySelectorAll('.pxm-select-box')[0]
    assert.ok(box, '项目卡片必须有复选框')
    await lane.click(box)
    assert.ok(lane.text().includes('已选 1'), '选中后出现「已选 N」')
    assert.equal(lane.posts('/delete').length, 0)

    await lane.click('删除选中')
    assert.equal(lane.posts('/delete').length, 0, '第一次点击只展开确认，不得直接删除')
    assert.ok(lane.text().includes('确认删除选中的 1 个项目？'))
    assert.ok(lane.text().includes('移入回收站'), '要写明是软删')
    assert.ok(lane.text().includes('可恢复'), '要写明可恢复')

    await lane.click('取消')
    assert.equal(lane.posts('/delete').length, 0, '取消之后依然不发请求')

    await lane.click('删除选中')
    await lane.click('确认删除选中')
    const deletes = lane.posts('/delete')
    assert.equal(deletes.length, 1)
    assert.deepEqual(JSON.parse(String(deletes[0].body)), { confirm: true }, '服务端二次校验要的 confirm 必须发出去')
    assert.ok(lane.text().includes('移入回收站') && lane.text().includes('已把 1 个项目'), '要有明确反馈')
  })

  it('取消全选把选中集清空；工具条随之收起', async () => {
    const lane = await createLane({ respond: pagedRespond(makeProjects(3)) })
    await lane.render()

    assert.equal(lane.byClass('pxm-select-toolbar'), null, '没选中时不该有「已选 N」工具条')
    await lane.click(lane.byClass('pxm-select-all'))
    assert.ok(lane.byClass('pxm-select-toolbar'), '选中后必须出现工具条')
    assert.ok(lane.text().includes('已选 3'))
    await lane.click('取消全选')
    assert.equal(lane.text().includes('已选'), false, '取消全选后不该还显示已选 N')
    assert.equal(lane.byClass('pxm-select-toolbar'), null, '没有选中项时工具条要收起')
    assert.equal(lane.byClass('pxm-batch-delete'), null, '没有选中项时不该出现批量删除')
  })

  it('批量导出用配置里的 exportDir，逐个 POST；未配置时提示去设置且不发请求', async () => {
    const lane = await createLane({
      respond(url, init = {}) {
        const method = String(init.method ?? 'GET').toUpperCase()
        if (method === 'POST' && url.endsWith('/export')) {
          return jsonResponse({ ok: true, count: 2, dir: EXPORT_DIR + '/x', files: [], warnings: [] })
        }
        return pagedRespond(makeProjects(2))(url, init)
      },
    })
    await lane.render()
    await lane.click(lane.byClass('pxm-select-all'))
    await lane.click('导出选中')

    const exports = lane.posts('/export')
    assert.equal(exports.length, 2, '每个选中的项目各发一次导出')
    assert.deepEqual(JSON.parse(String(exports[0].body)), { dir: EXPORT_DIR })
    assert.ok(lane.text().includes('已导出 2 个项目'))
    assert.ok(lane.text().includes(EXPORT_DIR), '要显示导出落点')

    // 未配置导出路径：**不发那一串注定失败的请求**，直接给出可行动提示
    const bare = await createLane({
      respond(url, init = {}) {
        const method = String(init.method ?? 'GET').toUpperCase()
        if (method === 'GET' && url.includes('/api/providers')) {
          return jsonResponse(providersPayload({ exportDir: '' }))
        }
        return pagedRespond(makeProjects(2))(url, init)
      },
    })
    await bare.render()
    await bare.click(bare.byClass('pxm-select-all'))
    await bare.click('导出选中')
    assert.equal(bare.posts('/export').length, 0, '未配置时不该发请求')
    assert.ok(bare.text().includes('还没有配置「作品库导出路径」'), '必须给出可读提示')
    assert.ok(bare.text().includes('设置'), '必须引导用户去设置页')
    assert.equal(bare.container.querySelectorAll('*').length > 0, true, '不得白屏')
  })

  it('批量删除里某一项失败时逐条报出原因，其余项照常删掉', async () => {
    const lane = await createLane({
      respond(url, init = {}) {
        const method = String(init.method ?? 'GET').toUpperCase()
        if (method === 'POST' && url.endsWith('/delete')) {
          if (url.includes(encodeURIComponent('P02'))) {
            return jsonResponse({ ok: false, error: { code: 'not_found', message: '项目不存在：P02' } }, 404)
          }
          return jsonResponse({ ok: true, trashed: true, trashId: 'x' })
        }
        return pagedRespond(makeProjects(2))(url, init)
      },
    })
    await lane.render()
    await lane.click(lane.byClass('pxm-select-all'))
    await lane.click('删除选中')
    await lane.click('确认删除选中')

    assert.equal(lane.posts('/delete').length, 2, '两项都尝试了')
    assert.ok(lane.text().includes('有 1 个项目没能移入回收站'), '失败的要有明确说明')
    assert.ok(lane.text().includes('项目不存在：P02'), '失败原因要可读')
    assert.equal(lane.container.querySelectorAll('*').length > 0, true, '不得白屏')
  })
})

// ── 批次 C：重命名 ────────────────────────────────────────────────────────

describe('jsdom lane：项目重命名', () => {
  it('详情里能重命名：POST {name}，成功后收起编辑框并刷新', async () => {
    const lane = await createLane({
      respond(url, init = {}) {
        const method = String(init.method ?? 'GET').toUpperCase()
        if (method === 'POST' && url.endsWith('/rename')) {
          return jsonResponse({ ok: true, id: PROJECT_ID, project: { ...projectSummary, name: '秋季主图' } })
        }
        return defaultRespond(url, init)
      },
    })
    await lane.render()
    await openDetail(lane)

    assert.equal(lane.byClass('pxm-rename-row'), null, '默认是只读的，不该一上来就是输入框')
    await lane.click('重命名')

    const input = lane.container.querySelector('.pxm-rename-row input')
    assert.ok(input, '点「重命名」后要出现输入框')
    assert.equal(input.value, '工作台', '输入框预填当前名字')

    // 空名字：按钮禁用，绝不发请求
    await lane.type(input, '   ')
    assert.equal(lane.byClass('pxm-rename-save').disabled, true, '空名字时保存按钮必须禁用')
    assert.equal(lane.posts('/rename').length, 0)

    await lane.type(input, '秋季主图')
    await lane.click('保存')

    const posts = lane.posts('/rename')
    assert.equal(posts.length, 1)
    assert.equal(posts[0].url.endsWith('/api/projects/' + encodeURIComponent(PROJECT_ID) + '/rename'), true)
    assert.deepEqual(JSON.parse(String(posts[0].body)), { name: '秋季主图' })
    assert.ok(lane.text().includes('已重命名为'), '成功要有反馈')
    assert.equal(lane.byClass('pxm-rename-row'), null, '成功后收起编辑框')
    // 详情与列表都要重取
    assert.ok(lane.calls.filter((call) => call.url.includes(encodeURIComponent(PROJECT_ID))).length >= 2)
  })

  it('重命名被拒时显示服务端原文，不白屏；编辑框保留以便改回', async () => {
    const lane = await createLane({
      respond(url, init = {}) {
        const method = String(init.method ?? 'GET').toUpperCase()
        if (method === 'POST' && url.endsWith('/rename')) {
          return jsonResponse(
            {
              ok: false,
              error: { code: 'invalid_name', message: '项目名不能包含路径分隔符（/ 或 \\）' },
            },
            400,
          )
        }
        return defaultRespond(url, init)
      },
    })
    await lane.render()
    await openDetail(lane)
    await lane.click('重命名')
    await lane.type(lane.container.querySelector('.pxm-rename-row input'), 'a/b')
    await lane.click('保存')

    assert.ok(lane.text().includes('项目名不能包含路径分隔符'), '失败原因要显示服务端原文')
    assert.ok(lane.byClass('pxm-rename-row'), '失败后编辑框还在，用户能改一个合法的名字')
    assert.equal(lane.container.querySelectorAll('*').length > 0, true, '不得白屏')
  })

  it('请求在途时按钮禁用（防连点重复改名）', async () => {
    let release = null
    const lane = await createLane({
      respond(url, init = {}) {
        const method = String(init.method ?? 'GET').toUpperCase()
        if (method === 'POST' && url.endsWith('/rename')) {
          return new Promise((resolve) => {
            release = () => resolve(jsonResponse({ ok: true, id: PROJECT_ID, project: projectSummary }))
          })
        }
        return defaultRespond(url, init)
      },
    })
    await lane.render()
    await openDetail(lane)
    await lane.click('重命名')
    await lane.type(lane.container.querySelector('.pxm-rename-row input'), '在途中')
    await lane.click('保存')

    const save = lane.byClass('pxm-rename-save')
    assert.ok(save, '保存按钮还在（请求未回）')
    assert.equal(save.disabled, true, '请求中必须禁用')
    assert.ok(save.textContent.includes('保存中'), '按钮文案要反映在途状态')

    await act(async () => {
      release()
    })
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve))
  })
})

// ── 滚动契约（结构断言） ────────────────────────────────────────────────────

/**
 * 面板骨架的**结构契约**断言。
 *
 * 说清楚这条轨道能证明什么、不能证明什么：
 *   - **不能**证明"滚轮真的能滚"——jsdom 没有排版引擎，`scrollHeight` / `clientHeight`
 *     恒为 0，`overflow-y:auto` 在这里跟 `visible` 没有可观测区别；
 *   - **能**证明的是：滚动容器还在、它的 `minHeight:0` 还在、固定层没被塞进滚动容器里。
 *     也就是"有人把修复删掉"时会立刻红，而不是回归到"详情页滚不动"还没人发现。
 *
 * 契约来源（宿主侧，不是我们的代码）：`@deepseek-ai/dsh-client-ui-layout` 的 AppFrame
 * 中栏 `.centerCol` 是 `display:flex; flex-direction:column; overflow:hidden`，
 * 高度由 `grid-template-rows:100%` 锁死——**座位自己不给滚动**，插件必须自带。
 */
function assertPanelSkeleton(lane) {
  const root = lane.byClass('pxm-workbench')
  assert.ok(root, '面板根必须存在（.pxm-workbench）')
  assert.equal(root.style.display, 'flex')
  assert.equal(root.style.flexDirection, 'column')
  assert.equal(root.style.height, '100%', '面板根必须锁 height:100%（否则内容顶出中栏被裁掉）')
  assert.equal(
    root.style.minHeight,
    '0px',
    '面板根必须有 min-height:0（flex 子项默认 min-height:auto = 内容高度）',
  )
  assert.equal(root.style.boxSizing, 'border-box', 'height:100% + padding 必须 border-box，否则溢出 36px')

  const bar = lane.byClass('pxm-workbench-bar')
  const scroller = lane.byClass('pxm-workbench-scroll')
  assert.ok(bar, '固定层必须存在（.pxm-workbench-bar）')
  assert.ok(scroller, '滚动容器必须存在（.pxm-workbench-scroll）')

  assert.equal(scroller.style.overflowY, 'auto', '内容区必须 overflow-y:auto')
  assert.equal(scroller.style.overflowX, 'hidden', '内容区不得出现横向滚动')
  assert.equal(scroller.style.minHeight, '0px', '滚动容器要有 min-height:0 才能在 flex 链里被压缩')
  assert.equal(scroller.style.flex, '1 1 auto', '滚动容器必须 flex:1 1 auto 吃掉剩余高度')

  assert.equal(scroller.contains(bar), false, '固定层必须在滚动容器之外（不跟着滚走）')
  assert.equal(bar.contains(scroller), false)

  const kids = [...root.children]
  assert.ok(kids.length >= 2, '面板根至少要有固定层与滚动区两个子节点')
  assert.equal(kids[0], bar, '固定层在前')
  assert.equal(kids[1], scroller, '滚动区在后')
  return { root, bar, scroller }
}

describe('jsdom lane：面板滚动契约（结构断言，不能证明真的能滚）', () => {
  it('列表页：项目网格是唯一滚动区，搜索 / 工具条固定在滚动区之外', async () => {
    const lane = await createLane({ respond: pagedRespond(makeProjects(30)) })
    await lane.render()

    const { bar, scroller } = assertPanelSkeleton(lane)
    assert.equal(scroller.querySelectorAll('.pxm-tile').length, 24, '卡片网格在滚动区里')
    assert.ok(bar.querySelector('.pxm-search'), '搜索框属于固定层，滚列表时不该跑掉')
    assert.ok(bar.querySelector('.pxm-list-bar'), '排序 / 全选 / 取消全选 / 搜索都属于固定层（单行工具条）')
    assert.ok(scroller.contains(lane.byClass('pxm-load-more')), '「加载更多」跟着内容滚')

    // 选中后的批量工具条也在固定层（否则滚下去就点不到删除）
    await lane.click(lane.container.querySelector('.pxm-select-box'))
    assert.ok(bar.querySelector('.pxm-select-toolbar'), '批量工具条必须在固定层里')
    assert.equal(scroller.contains(lane.byClass('pxm-select-toolbar')), false)
  })

  it('详情页：长提示词与图片在滚动区里，表头固定在滚动区之外', async () => {
    const lane = await createLane()
    await lane.render()
    await openDetail(lane)

    const { bar, scroller } = assertPanelSkeleton(lane)
    assert.ok(scroller.querySelector('.pxm-prompt'), '提示词必须在滚动区里（它就是被截断的那段）')
    assert.ok(scroller.textContent.includes('白底主图'), '模块卡片在滚动区里')
    assert.ok(scroller.querySelector('.pxm-thumb'), '图片也在滚动区里')
    assert.ok(bar.querySelector('.pxm-trash-toggle'), '表头按钮不跟着内容滚走')
    assert.equal(scroller.querySelector('.pxm-viewer'), null, '查看器不放进滚动区')
  })

  it('详情页：查看器打开后仍在面板内，但不属于滚动区（position:fixed 与本修无关）', async () => {
    const lane = await createLane()
    await lane.render()
    await openDetail(lane)

    const { root, scroller } = assertPanelSkeleton(lane)
    await lane.click(lane.byClass('pxm-thumb'))
    const viewer = lane.byClass('pxm-viewer')
    assert.ok(viewer, '点图必须打开查看器')
    assert.equal(viewer.style.position, 'fixed', '查看器仍是 position:fixed')
    assert.equal(root.contains(viewer), true, '查看器仍挂在面板根下（不新增 shell.overlay 座位）')
    assert.equal(scroller.contains(viewer), false, '查看器不在滚动区里')
  })

  it('回收站视图：同样是「固定表头 + 滚动内容」', async () => {
    const lane = await createLane()
    await lane.render()
    await lane.click(lane.byClass('pxm-trash-toggle'))
    assert.ok(lane.text().includes('旧项目'), '回收站要列出来')

    const { bar, scroller } = assertPanelSkeleton(lane)
    assert.ok(scroller.querySelector('.pxm-restore-btn'), '条目列表在滚动区里')
    assert.ok(bar.querySelector('.pxm-trash-toggle'), '「返回作品库」固定在表头')
  })

  it('长提示词段落带 word-break / overflow-wrap（长英文单词不撑破容器）', async () => {
    const longToken = 'A'.repeat(200)
    const lane = await createLane({
      respond(url, init = {}) {
        const method = String(init.method ?? 'GET').toUpperCase()
        if (method === 'GET' && url.includes('/api/projects/')) {
          return jsonResponse({
            ok: true,
            project: {
              ...projectDetail.project,
              items: [{ ...projectDetail.project.items[0], prompt: longToken }],
            },
          })
        }
        return defaultRespond(url, init)
      },
    })
    await lane.render()
    await openDetail(lane)

    const prompt = lane.byClass('pxm-prompt')
    assert.ok(prompt, '提示词段落必须存在')
    assert.equal(prompt.textContent, longToken, '长提示词要原样显示')
    assert.equal(prompt.style.whiteSpace, 'pre-wrap')
    assert.equal(prompt.style.wordBreak, 'break-word')
    assert.equal(prompt.style.overflowWrap, 'anywhere', '超长单词必须有 overflow-wrap 兜底')
  })
})

// ── 用户实测 bug：① 背景滚动锁 ② 顶栏锚定 ──────────────────────────────────
//
// **这些断言证不了什么**（诚实记录，别当成修好了的证明）：
//   - jsdom 没有排版引擎：`overflow-y: hidden` 写进内联样式 ≠ 真的滚不动了；
//     "背景没动"只能在真实浏览器里目视（滚轮 / 触控板）。
//   - `top: var(--dsh-frame-chrome-top, 0px)` 只是把锚定意图写进内联样式；
//     变量在真实外壳里解析成多少、查看器顶栏有没有真的避开标题栏与原生窗口按钮，
//     同样测不到——jsdom 里 `var()` 就是个字符串，也不会算布局。
//   - 焦点陷阱能测"按 Tab 之后 activeElement 落在谁身上"（事件是我自己派的），
//     但测不到浏览器的默认 Tab 行为、也测不到"视觉上焦点框有没有被裁"。

describe('jsdom lane：查看器的滚动锁与顶栏锚定（结构断言）', () => {
  it('lockBackgroundScroll 精确还原内联值：原来 auto 回 auto、原来没有就回到没有', async () => {
    const lane = await createLane()
    const { lockBackgroundScroll, restoreBackgroundScroll } = lane.bag
    assert.equal(typeof lockBackgroundScroll, 'function', '__test__ 必须暴露 lockBackgroundScroll')
    assert.equal(typeof restoreBackgroundScroll, 'function', '__test__ 必须暴露 restoreBackgroundScroll')

    const doc = lane.window.document
    const fromAuto = doc.createElement('div')
    fromAuto.style.overflowY = 'auto'
    fromAuto.style.overflowX = 'hidden'
    const fromStyleSheet = doc.createElement('div')
    // 模拟"真的有经典滚动条"：jsdom 量不到排版，所以显式给一组盒尺寸。
    const withScrollbar = doc.createElement('div')
    withScrollbar.style.overflowY = 'auto'
    Object.defineProperty(withScrollbar, 'offsetWidth', { value: 800, configurable: true })
    Object.defineProperty(withScrollbar, 'clientWidth', { value: 790, configurable: true })

    const locks = lockBackgroundScroll([fromAuto, fromStyleSheet, withScrollbar, fromAuto, null])
    assert.equal(locks.length, 3, '同一个元素只锁一次；null / undefined 不进锁表')
    assert.equal(fromAuto.style.overflowY, 'hidden')
    assert.equal(fromAuto.style.overflowX, 'hidden', '这把锁只碰 overflow-y，overflow-x 是滚动层自己的契约')
    assert.equal(fromStyleSheet.style.overflowY, 'hidden')
    assert.equal(
      fromAuto.style.scrollbarGutter,
      '',
      '量不到滚动条宽度（jsdom / overlay 滚动条）就不占位：占了反而会横移那么多',
    )
    assert.equal(withScrollbar.style.scrollbarGutter, 'stable', '真有经典滚动条时才留住它的占位')

    restoreBackgroundScroll(locks)
    assert.equal(fromAuto.style.overflowY, 'auto', '原来是 auto 就必须回到 auto（不写死一个值）')
    assert.equal(withScrollbar.style.scrollbarGutter, '', 'scrollbar-gutter 也要一起还原')
    assert.equal(fromStyleSheet.style.overflowY, '', '原来没有内联值 → 还原后也不能有')
  })

  it('打开查看器时锁住面板滚动层，Esc 关闭后精确还原（滚动位置与 overflow 都不丢）', async () => {
    const lane = await createLane()
    await lane.render()
    await openDetail(lane)

    const scroller = lane.byClass('pxm-workbench-scroll')
    assert.ok(scroller, '面板滚动层必须存在')
    assert.equal(scroller.style.overflowY, 'auto', '没开查看器之前是它自己的契约值')
    assert.equal(scroller.style.scrollbarGutter, '', '没开之前不该有 gutter')
    // 详情页在真实窗口里基本都是内容超长（有滚动条）的状态：给它一组盒尺寸来模拟。
    Object.defineProperty(scroller, 'offsetWidth', { value: 800, configurable: true })
    Object.defineProperty(scroller, 'clientWidth', { value: 790, configurable: true })

    await lane.click(lane.byClass('pxm-thumb'))
    assert.ok(lane.byClass('pxm-viewer'), '查看器要打开')
    assert.equal(scroller.style.overflowY, 'hidden', '打开时必须把背景滚动容器锁住')
    assert.equal(scroller.style.scrollbarGutter, 'stable', '锁的同时要留住滚动条占位，否则背景会横移一条滚动条')
    assert.equal(scroller.style.overflowX, 'hidden', '锁不该改动 overflow-x')
    assert.equal(scroller.querySelector('.pxm-viewer'), null, '查看器仍然不在滚动区里（不跟着内容滚）')

    await lane.key('Escape')
    assert.equal(lane.byClass('pxm-viewer'), null, 'Esc 仍要能关掉查看器')
    assert.equal(scroller.style.overflowY, 'auto', '关闭后必须精确还原成原值')
    assert.equal(scroller.style.scrollbarGutter, '', '关闭后不能留下 gutter')
  })

  it('查看器开着时卸载面板：锁不残留（卸载路径同样走还原）', async () => {
    const lane = await createLane()
    await lane.render()
    await openDetail(lane)

    const scroller = lane.byClass('pxm-workbench-scroll')
    Object.defineProperty(scroller, 'offsetWidth', { value: 800, configurable: true })
    Object.defineProperty(scroller, 'clientWidth', { value: 790, configurable: true })
    await lane.click(lane.byClass('pxm-thumb'))
    assert.equal(scroller.style.overflowY, 'hidden', '前提：这会儿是锁着的')
    assert.equal(scroller.style.scrollbarGutter, 'stable', '前提：占位也写上了')

    await lane.unmount()
    // 元素虽然已经脱离文档，但"有没有残留内联锁"这件事仍然可断言。
    assert.equal(scroller.style.overflowY, 'auto', '卸载时必须还原，不能把锁留在 DOM 上')
    assert.equal(scroller.style.scrollbarGutter, '', '卸载后也不许剩 gutter')
    assert.equal(lane.byClass('pxm-viewer'), null, '卸载后查看器不该还在')
  })

  it('顶栏锚定：top 取 shell 的 chrome 变量（不写死像素），滚动只发生在查看器内部', async () => {
    const lane = await createLane()
    await lane.render()
    await openDetail(lane)

    await lane.click(lane.byClass('pxm-thumb'))
    const viewer = lane.byClass('pxm-viewer')
    assert.ok(viewer, '查看器要打开')
    assert.equal(viewer.style.position, 'fixed', '仍是 fixed 覆盖层（不改用 shell.overlay）')

    // 依据：桌面 preload 把「应用 / 编辑」菜单挂成 position:fixed; top:0; z-index:1100 的宿主，
    // Electron 的 titleBarOverlay(height 40) 又把原生窗口按钮画在 web 内容之上；
    // shell 为模态层发布的就是 --dsh-frame-chrome-top。
    assert.equal(viewer.style.top, 'var(--dsh-frame-chrome-top, 0px)', '顶栏要从内容区起点算起')
    assert.equal(/^[0-9]/.test(viewer.style.top), false, '不许写死像素高度（40px 是运行时变量）')
    assert.equal(viewer.style.right, '0px')
    assert.equal(viewer.style.bottom, '0px')
    assert.equal(viewer.style.left, '0px')
    assert.equal(viewer.style.overscrollBehavior, 'contain', '查看器自身要挡住滚轮链')
    assert.equal(Number(viewer.style.zIndex) < 1100, true, 'z-index 必须低于标题栏菜单宿主的 1100：查看器永不盖窗口 chrome')

    const bar = viewer.querySelector('.pxm-viewer-bar')
    const body = viewer.querySelector('.pxm-viewer-scroll')
    assert.ok(bar, '固定顶栏必须存在（.pxm-viewer-bar）')
    assert.ok(body, '查看器内的滚动区必须存在（.pxm-viewer-scroll）')
    assert.equal(body.contains(bar), false, '顶栏必须在滚动区之外，否则一滚就没了')
    assert.equal(body.style.overflowY, 'auto', '查看器的内容由内部滚动区负责')
    assert.equal(body.style.minHeight, '0px', '滚动区要有 min-height:0 才能在 flex 链里被压缩')
    assert.equal(body.style.overscrollBehavior, 'contain')
    assert.equal(viewer.style.overflow, 'hidden', '根盒子自己不滚，滚动只发生在内部滚动区')

    // 顶栏的左右两端都得在顶栏里（左侧标签 / 位置计数，右侧关闭）：
    // **只看 DOM 归属，证不了真的没被窗口按钮盖住**。
    assert.ok(bar.textContent.includes('白底主图'), '模块标签在顶栏')
    assert.equal(bar.querySelector('.pxm-viewer-close'), lane.byClass('pxm-viewer-close'), '关闭按钮在顶栏')
    assert.ok(body.querySelector('.pxm-viewer-prompt'), '提示词在滚动区里（它才是会被截断的那段）')
  })

  it('打开后焦点收进查看器；Tab / Shift+Tab 只在查看器内循环，不落到背景', async () => {
    const lane = await createLane()
    await lane.render()
    await openDetail(lane)

    await lane.click(lane.byClass('pxm-thumb'))
    const viewer = lane.byClass('pxm-viewer')
    const doc = lane.window.document
    // 身份比较一律用 `assert.ok(a === b)`：失败时 node:assert 不会去 inspect 整个
    // jsdom 元素（那会让"本该秒失败"的用例拖成几分钟）。
    assert.ok(doc.activeElement === viewer, '打开时焦点要收进查看器（不许留在背后的缩略图上）')

    const closeBtn = viewer.querySelector('.pxm-viewer-close')
    const copyBtn = viewer.querySelector('.pxm-copy-btn')
    assert.ok(closeBtn && copyBtn, '顶栏的关闭与滚动区里的复制按钮都要在')

    await lane.key('Tab')
    assert.ok(doc.activeElement === closeBtn, 'Tab → 顶栏第一个可聚焦元素')
    await lane.key('Tab')
    assert.ok(doc.activeElement === copyBtn, 'Tab → 下一个')
    await lane.key('Tab')
    assert.ok(doc.activeElement === closeBtn, '最后一个再 Tab → 回绕到第一个，绝不外溢')
    await lane.key('Tab', { shiftKey: true })
    assert.ok(doc.activeElement === copyBtn, 'Shift+Tab 从第一个 → 回绕到最后一个')

    assert.equal(viewer.contains(doc.activeElement), true, '焦点始终在查看器内')
    assert.equal(doc.activeElement === doc.body, false, '焦点不许掉到背景的 body 上')

    await lane.key('Escape')
    assert.equal(lane.byClass('pxm-viewer'), null)
    assert.ok(
      String(doc.activeElement?.className ?? '').includes('pxm-thumb'),
      '关掉后焦点仍要还给缩略图（新加的陷阱不许抢走还原流程）',
    )
  })
})
