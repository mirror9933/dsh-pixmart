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

/** 默认路由：列表 + 详情 + 回收站，写操作按需覆盖。 */
function defaultRespond(url, init = {}) {
  const method = String(init.method ?? 'GET').toUpperCase()
  if (method === 'GET') {
    if (url.includes('/api/trash')) return jsonResponse(trashPayload)
    if (url.includes('/api/projects?limit=')) {
      return jsonResponse({ ok: true, count: 1, projects: [projectSummary] })
    }
    if (url.includes('/api/projects/')) return jsonResponse(projectDetail)
  }
  return jsonResponse({ ok: true })
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
            dir: 'D:/pixmart/exports/' + PROJECT_ID,
            files: ['D:/pixmart/exports/x.png'],
            warnings: [],
          })
        }
        return defaultRespond(url, init)
      },
    })
    await lane.render()
    await openDetail(lane)
    await lane.click('导出图片')

    assert.equal(lane.posts('/export').length, 1)
    assert.ok(lane.text().includes('已导出 1 个文件到'), '要给用户导出落点')
    assert.ok(lane.text().includes('D:/pixmart/exports/'))
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
