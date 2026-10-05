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
 * `exportDir` 给一个绝对路径：导出按钮把它当作 `dir` 发出去（未配置时界面不猜路径，
 * 由宿主回 `no_export_dir`）。
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
 * 关键在于它**报 total / hasMore**：界面要显示的「显示 N / 共 M」和「加载更多」
 * 全靠这两个字段。用固定的单页响应测不出分页行为（旧缺陷正是"永远只有一页"）。
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

    /** 在 document 上派发一次键盘事件（查看器把 Esc / ← → 挂在 document 上）。 */
    async key(key) {
      await act(async () => {
        win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true }))
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

  it('未配置导出路径 → 400 no_export_dir：界面给出可读提示并引导去设置（不静默失败）', async () => {
    const lane = await createLane({
      respond(url, init = {}) {
        const method = String(init.method ?? 'GET').toUpperCase()
        if (method === 'GET' && url.includes('/api/providers')) {
          return jsonResponse(providersPayload({ exportDir: '' }))
        }
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

    // 未配置时不该猜任何默认路径
    assert.deepEqual(JSON.parse(String(lane.posts('/export')[0].body)), {})
    assert.ok(lane.text().includes('还没有配置「作品库导出路径」'), '必须给出可读提示')
    assert.ok(lane.text().includes('设置'), '必须引导用户去设置页')
    assert.ok(lane.text().includes('no_export_dir') || lane.text().includes('导出路径'), '要能看出原因')
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

  it('懒加载：封面一张、带 loading=lazy + decoding=async，且显示「显示 N / 共 M」', async () => {
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
    assert.ok(lane.text().includes('显示 3 / 共 3'), '要有「显示 N / 共 M」')
    assert.equal(lane.byClass('pxm-load-more'), null, '没有更多时不该出现加载更多')
  })

  it('加载更多是**追加**，且排序变化重置回第一页', async () => {
    const lane = await createLane({ respond: pagedRespond(makeProjects(30)) })
    await lane.render()

    const pageSize = lane.bag.PROJECT_PAGE_SIZE
    assert.equal(pageSize, 24, '每页 24 条（宿主 limit 上限 200，客户端不越权）')
    assert.equal(lane.container.querySelectorAll('.pxm-tile').length, 24)
    assert.ok(lane.text().includes('显示 24 / 共 30'))

    await lane.click(lane.byClass('pxm-load-more'))
    assert.equal(lane.container.querySelectorAll('.pxm-tile').length, 30, '加载更多必须追加而不是替换')
    assert.ok(lane.text().includes('显示 30 / 共 30'))
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
    assert.ok(lane.text().includes('显示 24 / 共 30'))
    assert.ok(lane.byClass('pxm-load-more'), '只给 total 也要能推出"还有更多"，否则 6 个项目等于凭空消失')
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
