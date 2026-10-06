/**
 * 真实浏览器 lane（Playwright + 系统已装的 Edge/Chrome）。
 *
 * ## 它补的是 jsdom 的哪一块空白
 *
 * jsdom 没有排版引擎：`scrollHeight` / `getBoundingClientRect()` / `scrollTop` 全是常量 0，
 * 所以「滚不动」「顶栏被滚走」「压在标题栏下面」「窄屏横向溢出」「标签与值被换行拆散」
 * 这几类缺陷在 jsdom lane 里**原理上就测不出来**（`test/client.test.mjs` 文件头已列明）。
 * 这里用真排版引擎按**几何**断言：
 *   - `getBoundingClientRect()`：元素到底在哪、有没有被拆到两行、有没有被谁盖住；
 *   - `scrollTop` / `scrollHeight` vs `clientHeight`：到底有没有可滚的盒子；
 *   - `scrollWidth` vs `clientWidth`：内容有没有被横向裁掉；
 *   - `page.mouse.wheel()`：真的滚一下（不是 `element.scrollTop = X` 这种自证）；
 *   - `elementFromPoint()`：那个点上的**最上层**到底是谁（标题栏带会挡在这里）。
 *
 * ## 运行
 *
 *   pnpm test:browser        # 用系统 Edge，其次 Chrome；不下载浏览器
 *
 * 前置：本机装有 Microsoft Edge 或 Google Chrome。没有可用浏览器时**整轮不会假装通过**：
 * 会打印醒目 SKIP 横幅并以非零码结束（除非显式 `PXM_LANE_ALLOW_SKIP=1`）。
 *
 * 与 `pnpm test`（node:test 269 项）的分工见 docs/dsh-pixmart-技术方案.md §13.7。
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  artifactSha256,
  launchLaneBrowser,
  startLaneServer,
} from './lane-server.mjs'

// ── 夹具 ────────────────────────────────────────────────────────────────────

const PROJECT_ID = '2026-10-05-工作台'
const CREATED_AT = Date.UTC(2026, 9, 5, 12, 0, 0)
/** 无可断行点的长串：`word-break: normal` 下只能溢出，除非靠 overflow-wrap。 */
const HASH_TOKEN = 'd41d8cd98f00b204e9800998ecf8427e'.repeat(3)
const LONG_PROMPT =
  'ultra detailed e-commerce product photograph, matte ceramic mug on a seamless white background, ' +
  'soft studio light from the upper left, subtle contact shadow, 85mm lens at f/8, catalog quality, ' +
  'no text, no watermark, no logo — asset id ' +
  HASH_TOKEN

const projectSummary = (over = {}) => ({
  id: PROJECT_ID,
  name: '工作台',
  createdAt: CREATED_AT,
  provider: 'ofox',
  model: 'gpt-image-1',
  imageCount: 2,
  cover: PROJECT_ID + '/images/cover.png',
  ...over,
})

/** 生成 n 个可区分的项目摘要；第 1 个可以带一个超长、不可断行的名字（窄屏用）。 */
function projects(n, firstOver = {}) {
  const out = []
  for (let i = 1; i <= n; i += 1) {
    out.push(
      projectSummary({
        id: 'P' + String(i).padStart(2, '0'),
        name: 'Project-' + String(i).padStart(2, '0'),
        createdAt: CREATED_AT + i * 60000,
        imageCount: i,
        cover: 'P' + String(i).padStart(2, '0') + '/images/cover.png',
        ...(i === 1 ? firstOver : {}),
      }),
    )
  }
  return out
}

function itemFixture(index, over = {}) {
  return {
    module: 'main.white-bg',
    label: '白底主图 ' + String(index),
    status: 'ok',
    size: '1:1',
    apiMode: 'images-generations',
    images: ['images/' + String(index) + '-a.png', 'images/' + String(index) + '-b.png'],
    width: 1024,
    height: 1024,
    prompt: LONG_PROMPT,
    model: 'gpt-image-1',
    ms: 12345,
    createdAt: CREATED_AT,
    degraded: [],
    ...over,
  }
}

const providersFixture = {
  ok: true,
  dataDir: 'D:/pixmart',
  exportDir: 'D:/PixMartExport',
  defaults: { provider: 'ofox', model: 'gpt-image-1', size: '1:1', n: 1 },
  usage: { requests: 3, ok: 2, failed: 1, images: 4 },
  historical: { images: 0, projects: 0, note: '' },
  providers: [
    {
      id: 'ofox',
      label: 'Ofox',
      group: 'openai',
      apiMode: 'images-generations',
      hasApiKey: true,
      apiKeySource: 'config',
      baseUrl: 'https://api.ofox.ai/v1',
      models: ['gpt-image-1', 'flux-pro-1.1'],
      allowedSizes: ['1:1', '3:4', '16:9'],
    },
  ],
}

/** 详情页夹具：`items` 条模块，每条 2 张图 + 长提示词 → 一定长出可滚内容。 */
function detailFixture(items = 6, itemOver = {}) {
  return {
    ok: true,
    project: {
      id: PROJECT_ID,
      name: '工作台',
      createdAt: CREATED_AT,
      provider: 'ofox',
      model: 'gpt-image-1',
      items: Array.from({ length: items }, (_, i) => itemFixture(i, itemOver)),
    },
  }
}

const fixture = (over = {}) => ({
  projects: projects(6),
  detail: detailFixture(),
  providers: providersFixture,
  ...over,
})

/**
 * 查看器用例的夹具：查看器内部（`.pxm-viewer-scroll`）必须真的长出滚动条，
 * 否则"顶栏不跟着滚"是空转。图片被 `max-height:62vh` 压住，能撑高的只有提示词那一块。
 */
const viewerFixture = () =>
  fixture({
    detail: detailFixture(6, { prompt: [LONG_PROMPT, LONG_PROMPT, LONG_PROMPT].join('\n\n') }),
  })

// ── lane 启动 ───────────────────────────────────────────────────────────────

const server = await startLaneServer()
const launched = await launchLaneBrowser()
const ALLOW_SKIP = process.env.PXM_LANE_ALLOW_SKIP === '1'

const SKIP_BANNER = [
  '',
  '='.repeat(78),
  '  ⚠  浏览器 lane 已跳过 → 排版类问题未经验证（滚不动 / 顶栏被滚走 / 压在标题栏下 /',
  '     窄屏横向溢出 / 标签与值被拆散 —— 这几类 jsdom 原理上测不出来）',
  '  ⚠  原因：本机没有可用的 Microsoft Edge / Google Chrome（playwright-core 不下载浏览器）',
  '     尝试过的 channel：' + (launched.failures.length === 0 ? '（无）' : launched.failures.join(' | ')),
  '  ⚠  修法：装 Edge/Chrome 后重跑；确实要在无浏览器机器上放行，用 PXM_LANE_ALLOW_SKIP=1',
  '='.repeat(78),
  '',
].join('\n')

if (launched.browser === null) {
  console.error(SKIP_BANNER)
  if (ALLOW_SKIP) {
    describe('浏览器 lane 前置', () => {
      it('SKIP：没有可用浏览器 → 排版类问题未经验证', (t) => {
        t.skip('没有可用的 Edge/Chrome（PXM_LANE_ALLOW_SKIP=1 已显式放行）')
      })
    })
  } else {
    describe('浏览器 lane 前置', () => {
      it('必须有可用的系统 Edge/Chrome', () => {
        // 失败而不是跳过：这一轮**没有验证**，不能看起来像通过了。
        assert.fail(SKIP_BANNER)
      })
    })
  }
  await server.close()
} else {
  const browser = launched.browser
  const artifact = await artifactSha256()

  after(async () => {
    await browser.close()
    await server.close()
  })

  /**
   * 开一个 lane 页面：真实 HTTP 源 + 真实 shell 骨架 + 真 React UMD + 原产物 client.js。
   * 页面内的 `console.error` / 未捕获异常都会被收集，随用例一起断言（避免"悄悄报错但通过"）。
   */
  async function openLane(options = {}) {
    const context = await browser.newContext({
      viewport: { width: options.width ?? 1280, height: options.height ?? 800 },
      deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const problems = []
    page.on('pageerror', (err) => problems.push('pageerror: ' + err.message))
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push('console.error: ' + msg.text())
    })
    await page.goto(server.origin + '/shell.html', { waitUntil: 'load' })
    await page.evaluate((data) => window.__pxmLane.install(data), options.fixture ?? fixture())
    await page.evaluate((slot) => window.__pxmLane.mount(slot), options.slot ?? 'main')
    return { page, context, problems }
  }

  /** 调 lane 的探针（只有事实，判断在断言里）。 */
  const probe = (page, name, arg = null) =>
    page.evaluate(([fn, value]) => window.__pxmLane[fn](value), [name, arg])

  async function scrollTopOf(page, selector) {
    return page.evaluate((sel) => {
      const el = document.querySelector(sel)
      return el === null ? -1 : el.scrollTop
    }, selector)
  }

  /** 把鼠标移到元素中心再滚 —— 滚轮事件必须真的落在那个盒子上。 */
  async function wheelOver(page, selector, { deltaY = 800, times = 1 } = {}) {
    const point = await probe(page, 'point', selector)
    assert.ok(point !== null, '要滚动的元素必须存在：' + selector)
    await page.mouse.move(point.x, point.y)
    for (let i = 0; i < times; i += 1) {
      await page.mouse.wheel(0, deltaY)
      await page.waitForTimeout(40)
    }
  }

  /** 一直滚到 scrollTop 不再变化（真滚轮，不是赋值）。 */
  async function wheelToBottom(page, selector, maxRounds = 40) {
    let previous = -1
    for (let i = 0; i < maxRounds; i += 1) {
      const current = await scrollTopOf(page, selector)
      if (current === previous) return current
      previous = current
      await wheelOver(page, selector, { deltaY: 1200 })
    }
    return scrollTopOf(page, selector)
  }

  /** 点一个**当前完全可见**的缩略图：用鼠标坐标点，避免 Playwright 自动滚动改变背景位置。 */
  async function clickVisibleThumb(page) {
    const point = await page.evaluate(() => {
      const area = document.querySelector('.pxm-scroll')
      if (area === null) return null
      const outer = area.getBoundingClientRect()
      const thumbs = Array.from(document.querySelectorAll('.pxm-thumb'))
      const visible = thumbs.find((el) => {
        const r = el.getBoundingClientRect()
        return r.top >= outer.top + 4 && r.bottom <= outer.bottom - 4 && r.width > 0
      })
      if (visible === undefined) return null
      const r = visible.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    assert.ok(point !== null, '详情页里必须有一张完全可见的缩略图可点')
    await page.mouse.click(point.x, point.y)
    await page.waitForSelector('.pxm-viewer')
    await page.waitForTimeout(250) // 等入场动画（.16s）结束，几何才稳定
  }

  // ── 0. lane 自证：不是空跑 ────────────────────────────────────────────────

  describe('0. lane 自证', () => {
    it('加载的是仓库原产物 client.js（sha256 一致）、真 React UMD、真图片解码', async () => {
      const { page, context } = await openLane({ fixture: fixture() })
      try {
        assert.ok(server.served.clientRequests >= 1, '浏览器必须真的请求过 /client/client.js')
        assert.equal(server.served.clientSha256, artifact, 'lane 服务的必须是仓库原产物，逐字节一致')
        assert.equal(
          await probe(page, 'chromeTopVar'),
          '40px',
          'shell 骨架必须发布 --dsh-frame-chrome-top（查看器依赖它）',
        )
        // 真注册路径：apply(ctx) 注册了四处插槽
        assert.deepEqual(
          (await probe(page, 'slots')).map((slot) => slot.name),
          ['settings.section', 'sidebar.panellist', 'main', 'shell.overlay'],
        )
        // 真 React UMD（不是替身）
        assert.equal(await page.evaluate(() => typeof window.React.useState), 'function')
        assert.equal(await page.evaluate(() => typeof window.ReactDOM.createRoot), 'function')
        // 真图片解码：图片路由返回的是真 PNG，不是坏图
        await page.waitForSelector('.pxm-tile img')
        await page.waitForFunction(() => {
          const img = document.querySelector('.pxm-tile img')
          return img !== null && img.complete && img.naturalWidth > 0
        })
        const images = await probe(page, 'imageProbe')
        assert.ok(images.length > 0 && images[0].naturalWidth > 0, '封面必须真的解码出来')
      } finally {
        await context.close()
      }
    })
  })

  // ── 1. 详情页能滚 ─────────────────────────────────────────────────────────

  describe('1. 作品库详情页：滚轮能滚、能滚到底', () => {
    it('滚轮让详情页真的滚动；滚到底时最后一张图完整可见', async () => {
      const { page, context, problems } = await openLane({ fixture: fixture() })
      try {
        await page.waitForSelector('.pxm-tile')
        await page.click('.pxm-tile')
        await page.waitForSelector('.pxm-thumb')

        const before = await probe(page, 'box', '.pxm-scroll')
        assert.ok(
          before.scrollHeight > before.clientHeight + 1,
          '这个夹具必须真的长出可滚内容（否则"能滚"是空跑）：' +
            JSON.stringify({ scrollHeight: before.scrollHeight, clientHeight: before.clientHeight }),
        )
        assert.equal(before.scrollTop, 0, '初始应在顶部')

        await wheelOver(page, '.pxm-scroll', { deltaY: 700 })
        const afterWheel = await scrollTopOf(page, '.pxm-scroll')
        assert.ok(afterWheel > 0, '详情页必须能滚：滚轮之后 scrollTop 仍为 ' + String(afterWheel))

        await wheelToBottom(page, '.pxm-scroll')
        const box = await probe(page, 'box', '.pxm-scroll')
        const thumbs = await probe(page, 'rects', '.pxm-thumb')
        assert.ok(thumbs.length > 1, '夹具应有多张缩略图')
        const last = thumbs[thumbs.length - 1].rect
        assert.ok(
          box.scrollTop > 0,
          '滚到底之后 scrollTop 必须大于 0（有可滚的盒子）：' + String(box.scrollTop),
        )
        assert.ok(
          last.top >= box.rect.top - 1 && last.bottom <= box.rect.bottom + 1,
          '滚到底时最后一张图必须完整可见：' +
            JSON.stringify({ last, box: box.rect, scrollTop: box.scrollTop }),
        )
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })
  })

  // ── 2. 列表页能滚 ─────────────────────────────────────────────────────────

  describe('2. 作品库列表页：滚轮能滚', () => {
    it('40 个项目时列表滚轮可滚', async () => {
      const { page, context, problems } = await openLane({
        fixture: fixture({ projects: projects(40) }),
      })
      try {
        await page.waitForSelector('.pxm-tile')
        const before = await probe(page, 'box', '.pxm-scroll')
        assert.ok(before.scrollHeight > before.clientHeight + 1, '列表必须比容器高')
        assert.equal(before.scrollTop, 0)

        await wheelOver(page, '.pxm-scroll', { deltaY: 600 })
        const afterWheel = await scrollTopOf(page, '.pxm-scroll')
        assert.ok(afterWheel > 0, '列表页必须能滚：滚轮之后 scrollTop 仍为 ' + String(afterWheel))

        await wheelToBottom(page, '.pxm-scroll')
        const box = await probe(page, 'box', '.pxm-scroll')
        const tiles = await probe(page, 'rects', '.pxm-tile')
        const last = tiles[tiles.length - 1].rect
        assert.ok(
          last.top < box.rect.bottom && last.bottom > box.rect.top,
          '滚到底时最后一个项目卡片必须进入可视区：' + JSON.stringify({ last, box: box.rect }),
        )
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })
  })

  // ── 3. 查看器顶栏不被窗口标题栏遮 ────────────────────────────────────────

  describe('3. 查看器顶栏：不落在窗口标题栏带里', () => {
    it('顶栏 top ≥ 40px（--dsh-frame-chrome-top），关闭按钮完整在视口内且可命中', async () => {
      const { page, context, problems } = await openLane({ fixture: fixture() })
      try {
        await page.waitForSelector('.pxm-tile')
        await page.click('.pxm-tile')
        await page.waitForSelector('.pxm-thumb')
        await clickVisibleThumb(page)

        const viewer = await probe(page, 'viewer')
        const band = await probe(page, 'titlebarTop')
        assert.ok(band !== null && band.height === 40, '标题栏带应为 40px：' + JSON.stringify(band))
        assert.ok(
          viewer.bar.top >= band.height - 0.5,
          '查看器顶栏不能被窗口标题栏盖住：bar.top=' +
            String(viewer.bar.top) +
            ' 标题栏带高=' +
            String(band.height),
        )
        const metrics = await probe(page, 'metrics')
        assert.ok(
          viewer.close.left >= 0 && viewer.close.right <= metrics.innerWidth + 1,
          '关闭按钮必须完整在视口内（横向）：' + JSON.stringify({ close: viewer.close, ...metrics }),
        )
        assert.ok(
          viewer.close.top >= band.height - 0.5 && viewer.close.bottom <= metrics.innerHeight + 1,
          '关闭按钮必须完整在视口内（纵向，且在标题栏带下方）：' +
            JSON.stringify({ close: viewer.close, band: band.height }),
        )
        assert.equal(
          viewer.closeHit.hitInsideSelf,
          true,
          '关闭按钮中心点的最上层元素必须是它自己（被标题栏带/别的东西盖住就会是别的）：' +
            JSON.stringify(viewer.closeHit),
        )
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })
  })

  // ── 4. 查看器顶栏不随内容滚 ───────────────────────────────────────────────

  describe('4. 查看器顶栏：内容滚动时不动', () => {
    it('在 .pxm-viewer-scroll 内滚 → 顶栏与根盒子的 top 不变', async () => {
      const { page, context, problems } = await openLane({ fixture: viewerFixture() })
      try {
        await page.waitForSelector('.pxm-tile')
        await page.click('.pxm-tile')
        await page.waitForSelector('.pxm-thumb')
        await clickVisibleThumb(page)

        const before = await probe(page, 'viewer')
        assert.ok(
          before.inner.scrollHeight > before.inner.clientHeight + 1,
          '查看器内部必须真的能滚（长提示词 + 大图）：' +
            JSON.stringify({ scrollHeight: before.inner.scrollHeight, clientHeight: before.inner.clientHeight }),
        )

        await wheelOver(page, '.pxm-viewer-scroll', { deltaY: 700 })
        const after = await probe(page, 'viewer')
        assert.ok(
          after.inner.scrollTop > 0 || after.root.scrollTop > 0,
          '滚轮必须真的滚了查看器（否则"顶栏没动"是空转）：' +
            JSON.stringify({ inner: after.inner.scrollTop, root: after.root.scrollTop }),
        )
        assert.equal(
          after.bar.top,
          before.bar.top,
          '顶栏不能跟着内容滚走：' + String(before.bar.top) + ' → ' + String(after.bar.top),
        )
        assert.equal(
          after.root.scrollTop,
          0,
          '查看器根盒子自己不该是滚动容器：root.scrollTop=' + String(after.root.scrollTop),
        )
        assert.equal(after.root.rect.top, before.root.rect.top, '查看器根盒子的位置不能变')
        assert.ok(after.inner.scrollTop > 0, '滚动的应该是内部那层')
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })
  })

  // ── 5. 背景滚动被锁 ───────────────────────────────────────────────────────

  describe('5. 打开查看器时：背景滚动被锁住、关闭后精确还原', () => {
    /**
     * 这一条的**可证伪证据**（见 §13.7「覆盖不到什么」）是两条：
     *   ① `.pxm-scroll` 的计算后 `overflow-y` 在打开后是 hidden、关闭后回到 auto
     *      ——"锁住"这件事本身在 CSS 里就是 overflow；headless 下滚动条是 overlay 型
     *      （实测 `offsetWidth - clientWidth === 0`），所以没有"内容横移"这类几何副作用可量；
     *   ② 关闭后背景的 `scrollTop` 必须回到打开前的位置。
     * 轮询式的"滚轮滚不出背景"是**不变量护栏**：查看器是 `position: fixed` 的兄弟覆盖层，
     * `.pxm-scroll` 不在它的事件链上，所以这条护栏在本拓扑下不可能单独失败
     * （信息性变异 `M12-no-overscroll-contain` 已证实这一点），留着是为了防止将来
     * 有人把查看器挪进滚动区里、把链式滚动接回去。
     */
    it('滚轮只滚查看器内部；背景 .pxm-scroll 的 scrollTop 不变、被锁成 hidden，关闭后还原', async () => {
      const { page, context, problems } = await openLane({ fixture: viewerFixture() })
      try {
        await page.waitForSelector('.pxm-tile')
        await page.click('.pxm-tile')
        await page.waitForSelector('.pxm-thumb')

        // 先把背景滚到一个非零位置，这样"没变"才有意义
        await wheelOver(page, '.pxm-scroll', { deltaY: 500 })
        const opened = await probe(page, 'panelScroll')
        assert.ok(opened.scrollTop > 0, '背景先要滚起来：scrollTop=' + String(opened.scrollTop))
        assert.equal(opened.computedOverflowY, 'auto', '未打开查看器时背景是可滚的')

        await clickVisibleThumb(page)
        // 锁是在 useLayoutEffect 里、画第一帧之前写上的，这里已经生效
        const locked = await probe(page, 'panelScroll')
        assert.equal(
          locked.computedOverflowY,
          'hidden',
          '查看器打开时背景滚动容器必须被锁住（overflow-y: hidden）',
        )

        // 滚轮打在查看器内部：查看器自己滚，背景一动不动
        await wheelOver(page, '.pxm-viewer-scroll', { deltaY: 900, times: 3 })
        const viewerScrolled = await scrollTopOf(page, '.pxm-viewer-scroll')
        assert.ok(viewerScrolled > 0, '查看器内部必须真的滚了（否则这条断言是空转）')
        const afterWheel = await probe(page, 'panelScroll')
        assert.equal(
          afterWheel.scrollTop,
          opened.scrollTop,
          '滚轮不能带动背景：' + String(opened.scrollTop) + ' → ' + String(afterWheel.scrollTop),
        )

        // 关闭 → 精确还原（原来是什么就回什么，且滚动位置放回原处）
        await page.click('.pxm-viewer-close')
        await page.waitForSelector('.pxm-viewer', { state: 'detached' })
        const restored = await probe(page, 'panelScroll')
        assert.equal(restored.computedOverflowY, 'auto', '关闭后必须把背景的 overflow-y 还原')
        assert.equal(
          restored.scrollTop,
          opened.scrollTop,
          '关闭后背景的滚动位置要放回原处：' +
            String(opened.scrollTop) +
            ' → ' +
            String(restored.scrollTop),
        )
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })
  })

  // ── 6. 窄屏无横向溢出 ─────────────────────────────────────────────────────

  describe('6. 窄屏 375px：不横向溢出、内容不被裁', () => {
    it('详情页（长英文提示词 + 长模型名）', async () => {
      const { page, context, problems } = await openLane({
        width: 375,
        height: 720,
        fixture: fixture({ detail: detailFixture(4, { model: 'gptimage' + HASH_TOKEN }) }),
      })
      try {
        await page.waitForSelector('.pxm-tile')
        await page.click('.pxm-tile')
        await page.waitForSelector('.pxm-prompt')

        const metrics = await probe(page, 'metrics')
        assert.ok(
          metrics.docScrollWidth <= metrics.docClientWidth + 1,
          '文档不该被撑出横向滚动：' + JSON.stringify(metrics),
        )
        const holders = await probe(page, 'textOverflow', HASH_TOKEN)
        const bad = holders.filter((entry) => entry.clipped)
        assert.ok(holders.length >= 2, '长串应出现在提示词与模型名两处：' + JSON.stringify(holders))
        assert.deepEqual(
          bad,
          [],
          '长提示词/长模型名不该被 overflow-x:hidden 裁掉：' + JSON.stringify(bad),
        )
        const area = await probe(page, 'box', '.pxm-scroll')
        assert.ok(
          area.scrollWidth <= area.clientWidth + 1,
          '滚动区自己也不该出现横向溢出（长 token 把 flex 行撑宽时会这样）：' +
            JSON.stringify({ scrollWidth: area.scrollWidth, clientWidth: area.clientWidth }),
        )
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })

    it('列表页（超长项目名）', async () => {
      const longName = '秋款陶瓷马克杯' + HASH_TOKEN
      const { page, context, problems } = await openLane({
        width: 375,
        height: 720,
        fixture: fixture({ projects: projects(12, { name: longName }) }),
      })
      try {
        await page.waitForSelector('.pxm-tile')
        const metrics = await probe(page, 'metrics')
        assert.ok(
          metrics.docScrollWidth <= metrics.docClientWidth + 1,
          '文档不该被撑出横向滚动：' + JSON.stringify(metrics),
        )
        const holders = await probe(page, 'textOverflow', HASH_TOKEN)
        const bad = holders.filter((entry) => entry.clipped)
        assert.ok(holders.length >= 1, '超长项目名必须真的渲染出来了：' + JSON.stringify(holders))
        assert.deepEqual(
          bad,
          [],
          '超长项目名不该被 overflow-x:hidden 裁掉：' + JSON.stringify(bad),
        )
        const area = await probe(page, 'box', '.pxm-scroll')
        assert.ok(
          area.scrollWidth <= area.clientWidth + 1,
          '滚动区自己也不该出现横向溢出：' +
            JSON.stringify({ scrollWidth: area.scrollWidth, clientWidth: area.clientWidth }),
        )
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })
  })

  // ── 7. 标签与值不被拆散 ───────────────────────────────────────────────────

  describe('7. 设置页：标签与它的值不被拆散', () => {
    it('「默认值」卡片：每个字段的标签与控件同列（控件在标签下方、左边界对齐）', async () => {
      const { page, context, problems } = await openLane({
        width: 520,
        height: 900,
        slot: 'settings.section',
        fixture: fixture(),
      })
      try {
        await page.waitForSelector('select')
        const fields = await probe(page, 'defaultsFields')
        assert.ok(Array.isArray(fields) && fields.length >= 4, '「默认值」卡片应有 4 个字段：' + JSON.stringify(fields))
        const broken = fields.filter(
          (field) =>
            field.controlRect === null ||
            field.labelRect === null ||
            Math.abs(field.controlRect.left - field.labelRect.left) > 1 ||
            field.controlRect.top < field.labelRect.top + field.labelRect.height * 0.5,
        )
        assert.deepEqual(
          broken,
          [],
          '标签与它的值必须同列堆叠（并排 = 被拆散）：' + JSON.stringify(broken),
        )
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })

    it('成组的「标签 + 值」（数据目录）在窄屏下仍留在同一行', async () => {
      /**
       * 这一对是 bug 1（标签与值被 flex 拆散）在现产物里**仅存**的成组形态：
       * 标签（`white-space:nowrap` + `flex-shrink:0`）与值被 `display:inline-flex`
       * 包成一个 flex 子项。用一个真实长度的数据目录把这一行压到临界：成组时整对留在
       * 同一行（长值在**自己内部**换行），退回"两个独立 flex 子项"时值会被换到下一行。
       *
       * 注意：**不要**给这一组加 `flexWrap:wrap`——flex 按子项的假设主轴尺寸划行，
       * 长值会被整行推到标签下面，本条断言会立刻变红（`M15-field-group-flex-wrap`）。
       */
      const longDir = 'C:/Users/Someone/Documents/PixMart/exports/2026-autumn-ceramic-mug-campaign/final-hires'
      const { page, context, problems } = await openLane({
        width: 520,
        height: 900,
        slot: 'settings.section',
        fixture: fixture({ providers: { ...providersFixture, dataDir: longDir } }),
      })
      try {
        await page.waitForSelector('select')
        const pair = await probe(page, 'groupedPair', '数据目录')
        assert.ok(pair !== null, '设置页里应有「数据目录」这一对标签 + 值')
        assert.ok(
          Math.abs(pair.labelRect.top - pair.valueRect.top) <= 2,
          '标签与它的值必须在同一行（被换行拆开时 top 差值会到一个行高以上）：' +
            JSON.stringify(pair),
        )
        assert.ok(
          pair.valueRect.right > pair.labelRect.right,
          '值必须真的排在标签右边：' + JSON.stringify(pair),
        )
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })

    it('两条 87 字符的长路径在 520px / 375px 下都不得把设置弹窗撑出横向滚动条', async () => {
      /**
       * lane 实测：`#settingsDialog.scrollWidth 687 > clientWidth 520`（窗口 520px）。
       *
       * 逐元素量下来的结论：撑破弹窗的是**「数据目录」那一对**（`field()` 组），
       * 不是一个笼统的"设置页太宽"。因果链是
       * `field()` 组上的 `whiteSpace: 'nowrap'`（为修 bug 1「标签与值被 flex 拆散」
       * 而给**整组**加的对策）→ 组里那条长路径一个断点都没有 →
       * 组的 min-content 宽度 = 整条路径的宽度（实测 652px）→ 组的父级 flex 行
       * （`skin.row`）被顶宽到 652px → `skin.wrap` 到 687px → 520px 的弹窗出现横向滚动条。
       * 对短值（`1:1` / `ofox`）而言这条 nowrap 是对的，只有长值会踩到。
       *
       * 「作品库导出路径」的长值走 `<input>`：长文本收在输入框内部自滚
       * （`scrollWidth > clientWidth` 是 `<input>` 的正常行为），**不会**撑破排版。
       * 两条路径在这里都设成 87 字符：断言的是「设置页整体没有横向溢出」，
       * 哪一个元素撑破都会被抓住，而不是只盯住某一个元素。
       */
      const longDataDir =
        'C:\\Users\\Someone\\.dsh\\pixmart\\projects\\2026-autumn-ceramic-mug-campaign\\images-hires-v2'
      const longExportDir =
        'C:\\Users\\Someone\\.dsh\\pixmart\\exports\\2026-autumn-ceramic-mug-campaign\\final-hires-2026'
      assert.equal(longDataDir.length, 87, '夹具必须与 lane 实测的长度一致（87 字符）')
      assert.equal(longExportDir.length, 87, '夹具必须与 lane 实测的长度一致（87 字符）')

      // 375px 是「窄屏」那条既有用例的宽度；520px 是 lane 报出 687/520 的那一档。
      for (const width of [520, 375]) {
        const { page, context, problems } = await openLane({
          width,
          height: 900,
          slot: 'settings.section',
          fixture: fixture({
            providers: { ...providersFixture, dataDir: longDataDir, exportDir: longExportDir },
          }),
        })
        try {
          await page.waitForSelector('select')
          const dialog = await probe(page, 'box', '#settingsDialog')
          assert.ok(
            dialog.scrollWidth <= dialog.clientWidth + 1,
            String(width) + 'px 下设置弹窗必须是横向不溢出的：' +
              JSON.stringify({ scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth }),
          )

          // 目标 1 不能回归，且修复不能是"把溢出的东西裁掉"：
          // 值要在**自己内部**换行（scrollWidth 不超 clientWidth），标签仍在同一行。
          const pair = await probe(page, 'groupedPair', '数据目录')
          assert.ok(pair !== null, '设置页里应有「数据目录」这一对标签 + 值')
          assert.ok(
            pair.valueScrollWidth <= pair.valueClientWidth + 1,
            String(width) + 'px 下长路径必须在值内部换行，而不是被裁掉：' + JSON.stringify(pair),
          )
          assert.ok(
            Math.abs(pair.labelRect.top - pair.valueRect.top) <= 2,
            String(width) + 'px 下标签与它的值仍必须在同一行（原 bug 不能回归）：' + JSON.stringify(pair),
          )
          assert.ok(
            pair.valueRect.right > pair.labelRect.right,
            String(width) + 'px 下值必须真的排在标签右边：' + JSON.stringify(pair),
          )
          assert.ok(
            pair.groupRect.right <= dialog.rect.left + dialog.clientWidth + 1,
            String(width) + 'px 下这一对不得超出弹窗内容区：' + JSON.stringify(pair),
          )

          // 导出路径输入框必须随容器收窄，不得自己撑破弹窗。
          const input = await probe(page, 'rect', 'input')
          assert.ok(input !== null, '设置页里应有导出路径输入框')
          assert.ok(
            input.right <= dialog.rect.left + dialog.clientWidth + 1,
            String(width) + 'px 下导出路径输入框不得超出弹窗内容区：' +
              JSON.stringify({ input, dialog: dialog.rect, clientWidth: dialog.clientWidth }),
          )
          assert.deepEqual(problems, [])
        } finally {
          await context.close()
        }
      }
    })
  })

  // ── 8. 宽屏 / 全屏：面板必须占满中栏，右边不留空白块 ───────────────────────

  /**
   * 用户实测（2560×1390 全屏）：侧栏之后，作品库内容**挤在左侧**，右边一大片空白。
   *
   * ## 根因（证据在 asar 里，两边都读过原文）
   *
   * **不是** shell 的中栏宽度限制 —— `ui-layout` 的 AppFrame（asar:
   * `@deepseek-ai/dsh-client-ui-layout/lib/client.js` 里那段内联 CSS）里，
   * 中栏只有这一条规则：
   *
   *     .BynINW_centerCol{flex-direction:column;min-width:0;display:flex;overflow:hidden}
   *
   * 没有 `max-width`、没有 `width`、没有 `margin:auto`。`main` 槽的宿主是
   * `display:contents` 的槽锚点，所以面板就是中栏的直接 flex 子项；中栏
   * `flex-direction:column` ⇒ 子项横向被 stretch ⇒ 座位本来就是"占满可用宽度"。
   * （lane 实测 2560px：中栏 `left 220 / right 2560 / width 2340`。）
   *
   * 真正的原因在**我们自己**：`skin.panel` 上写着 `maxWidth: 880px`（"抄聊天的阅读宽度"
   * 那条，见 git c6b342c），面板因此只吃 880px —— lane 实测 2560px 下面板
   * `left 220 / right 1100 / width 880`，右边界距中栏右边界 **1460px**。
   *
   * ## 判据
   *
   * 1. 面板右边界 == 中栏右边界（`<= 1px`）：右边不再有空白块；
   * 2. 面板宽度 == 中栏可用宽度（`<= 1px`）：占满；
   * 3. 面板内唯一的滚动容器（`.pxm-scroll`）的**内容区**左右边界 == 面板内容区边界
   *    （只差面板自己的 `padding:18px`）——这条是把"占满"钉在**内容**上，
   *    而不是"外层盒子被拉宽、里面还是一个窄柱"；
   * 4. 面板仍锁死在中栏高度里、滚动仍在 `.pxm-scroll` 上（"滚不动"那条缺陷不能回归）。
   *
   * 1600×900 与 2560×900 两个宽度都量，避免只对某一档成立。
   */
  describe('8. 宽屏 / 全屏：作品库面板占满中栏的可用宽度', () => {
    it('8. 1600/2560 宽视口下：面板右边界贴住中栏右边界，内容区占满且仍在内部滚动', async () => {
      /** 与 `client/client.js` 的 `skin.panel` 同源的固定 18px 内边距。 */
      const PANEL_PADDING = 18

      for (const width of [1600, 2560]) {
        const { page, context, problems } = await openLane({
          width,
          height: 900,
          fixture: fixture({ projects: projects(6) }),
        })
        try {
          await page.waitForSelector('.pxm-tile')

          const geometry = await page.evaluate(() => {
            const round = (n) => Math.round(n * 100) / 100
            const box = (el) => {
              const r = el.getBoundingClientRect()
              const cs = window.getComputedStyle(el)
              return {
                left: round(r.left),
                right: round(r.right),
                width: round(r.width),
                maxWidth: cs.maxWidth,
                marginLeft: cs.marginLeft,
                marginRight: cs.marginRight,
                overflowY: cs.overflowY,
                display: cs.display,
                scrollTop: el.scrollTop,
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
                paddingLeft: round(parseFloat(cs.paddingLeft)),
                paddingRight: round(parseFloat(cs.paddingRight)),
              }
            }
            const panel = document.querySelector('.pxm-workbench[data-pxm-slot="main"]')
            const scroll = document.querySelector('.pxm-scroll')
            /**
             * 中栏 = 面板沿祖先链往上、**跳过所有 `display:contents` 的槽锚点**之后
             * 第一个真正参与布局的盒子。
             *
             * 不能用 `offsetParent`：本骨架里 `#frame` 是 `position:absolute`，
             * 它会先被返回。`display:contents` 的元素不建立包含块，跳过它们即可，
             * 这也正是"面板就是中栏的直接 flex 子项"这条契约的可执行表述。
             */
            const containingBlock = (el) => {
              let node = el.parentElement
              while (node !== null && node !== document.body) {
                if (window.getComputedStyle(node).display !== 'contents') return node
                node = node.parentElement
              }
              return node
            }
            const centerCol = containingBlock(panel)
            return {
              viewport: { width: window.innerWidth, height: window.innerHeight },
              panel: box(panel),
              panelParent: box(panel.parentElement),
              centerCol: box(centerCol),
              centerColClass: centerCol.className,
              scroll: box(scroll),
              docScrollWidth: document.documentElement.scrollWidth,
              docClientWidth: document.documentElement.clientWidth,
            }
          })

          const where = String(width) + 'px 宽视口：'

          // 前提自证：中栏自己不给宽度上限（否则"占满"的判据就说不清了）。
          assert.ok(
            /centerCol/.test(String(geometry.centerColClass)),
            where + '量到的必须是中栏（.centerCol）：' + JSON.stringify(geometry),
          )
          assert.equal(
            geometry.centerCol.maxWidth,
            'none',
            where + '中栏不该有 max-width：' + JSON.stringify(geometry.centerCol),
          )
          assert.ok(
            geometry.centerCol.width > 1200,
            where + '中栏必须真的变宽（夹具/骨架没生效的话本用例空转）：' +
              JSON.stringify(geometry.centerCol),
          )
          assert.equal(
            geometry.panelParent.width,
            0,
            where + '面板的直接父元素应当是 display:contents 的槽锚点（不产生盒子）：' +
              JSON.stringify(geometry.panelParent),
          )

          // 1 + 2：占满中栏可用宽度，右边不留空白块。
          assert.ok(
            Math.abs(geometry.panel.right - geometry.centerCol.right) <= 1,
            where +
              '面板右边界必须贴住中栏右边界（右边不留空白块）：' +
              JSON.stringify({ panel: geometry.panel, centerCol: geometry.centerCol }),
          )
          assert.ok(
            Math.abs(geometry.panel.width - geometry.centerCol.width) <= 1,
            where +
              '面板必须占满中栏的可用宽度（早先的 maxWidth:880px 就是"右边一大片空白"的根因）：' +
              JSON.stringify({ panel: geometry.panel, centerCol: geometry.centerCol }),
          )
          assert.ok(
            geometry.panel.width > 880 + 200,
            where +
              '面板宽度必须**超过**被修掉的 880px 上限（否则这条断言对本次修复不敏感）：' +
              String(geometry.panel.width),
          )
          assert.equal(geometry.panel.maxWidth, 'none', where + '面板不该再挂 max-width')
          assert.equal(geometry.panel.marginLeft, '0px', where + '面板不该靠 margin 居中（它就该占满）')

          // 3：滚动容器的**内容区**也要贴着面板内容区（不是"外层拉宽、里面还是窄柱"）。
          assert.ok(
            Math.abs(geometry.scroll.left - (geometry.panel.left + PANEL_PADDING)) <= 1,
            where + '滚动容器左边界应等于面板内容区左边界：' + JSON.stringify(geometry),
          )
          assert.ok(
            Math.abs(geometry.scroll.right - (geometry.panel.right - PANEL_PADDING)) <= 1,
            where + '滚动容器右边界应等于面板内容区右边界：' + JSON.stringify(geometry),
          )

          // 4：几何不能靠"撑出文档"换来；滚动仍锁在内部。
          assert.ok(
            geometry.docScrollWidth <= geometry.docClientWidth + 1,
            where + '不得出现横向溢出：' + JSON.stringify(geometry),
          )
          assert.equal(
            geometry.panel.overflowY,
            'visible',
            where + '面板根不滚（固定层契约）：' + JSON.stringify(geometry.panel),
          )
          assert.equal(
            geometry.scroll.overflowY,
            'auto',
            where + '唯一的滚动容器仍是 .pxm-scroll：' + JSON.stringify(geometry.scroll),
          )
          assert.ok(
            geometry.scroll.clientHeight > 0 && geometry.scroll.clientHeight <= geometry.panel.clientHeight,
            where + '滚动容器必须被锁在面板高度里（否则"滚不动"会回归）：' + JSON.stringify(geometry),
          )

          assert.deepEqual(problems, [], where + '页面不该有 console.error / 未捕获异常')
        } finally {
          await context.close()
        }
      }
    })
  })
}
