/**
 * 真实浏览器 lane 的**尺寸对齐**一侧：证明 PixMart 客户端的控件几何
 * （高度 / 内边距 / 字号 / 行高 / 圆角）**等于 DSH 官方同语义控件的尺寸**。
 *
 * ## 它补的是哪一块空白
 *
 * `layout.test.mjs` 管"排得下、滚得动"（几何缺陷），`theme.test.mjs` 管"颜色真的走
 * `--dsw-*` token"。两块都不管"**这个按钮有多高**"：把 28px 的按钮写成 40px，页面照样
 * 排得下、颜色也照样对，没有任何用例会红。本文件只做这一件事。
 *
 * ## 官方尺寸是怎么表达的（这决定了断言的写法）
 *
 * 2026-10-08 核对了 `app.asar` 里的官方 CSS，结论是**分两半**：
 *
 *   1. **圆角有变量**：`@deepseek-ai/dsh-client-ui-theme` 的 base CSS `:root{…}` 声明了
 *      `--dsw-radius-xs:4px / -sm:8px / -md:12px / -lg:16px / -xl:20px / -panel:28px`，
 *      以及 `--dsw-focus-ring-width:2px`。官方 `Button.module.css` / `Input.module.css` /
 *      `Menu.module.css` / `Modal.module.css` 的 `border-radius` **全部**写的是
 *      `var(--dsw-radius-*)`。
 *      → 本插件的 `borderRadius` 也走这两个变量，断言就写成
 *      **"计算值 == `var(--dsw-radius-sm)` 在本页的解析值"**（`resolveSize` 探针现场解析，
 *      而不是测试自己抄一个 `8px`——抄一份两边就会各自漂移）。
 *
 *   2. **高度 / 内边距 / 字号没有变量**：官方不存在 `--dsw-size-*` / `--dsw-space-*` /
 *      `--dsw-control-*`；`--dsw-font-*-{font-size,line-height}` 虽然存在，但官方**控件规则
 *      自己并不消费**（`settings-form/fields.module.css` 的 `.input`、`Button.module.css`
 *      的 `.sm` 写的都是裸 px）。
 *      → 这些只能**照抄 px**，集中在本插件 `client/client.js` 的 `S` 常量表里，每条注明
 *      `文件:行` 来源；本文件的 `OFFICIAL` 是它的**独立复述**（同源不同处），
 *      两边任何一处漂移都会让下面的断言变红。
 *      **风险写在这里**：照抄的 px **不会**随官方升级自动跟随，只有本用例会红。
 *
 * ## 覆盖范围与"无官方对应物"的部分
 *
 * 三个面板各至少一组断言：
 *   - **设置页**（`settings.section`）——官方对照物最全：`fields.module.css` 的 `.input`、
 *     `Tag.module.css` 的 `.tag`、`settings-models` 的行内动作按钮；
 *   - **作品库**（`main`）——搜索框 / 排序下拉（同一枚表单控件）、工具条按钮（`Button.sm`）、
 *     回收站列表项卡片（`settings-models` 的 `._3nPmjq_rowCard`）；
 *   - **实时预览**（`shell.overlay`）——徽标胶囊（`Pill.module.css` 的 `.pill`）。
 *
 * **作品库网格卡片（`.pxm-tile`）故意不在覆盖范围内**：官方没有任何"项目网格"，
 * 那张卡片（`minmax(180px,1fr)` + 4:3 封面 + 名称/张数/时间三行）没有同语义对照物，
 * 因此**不强行套官方尺寸**，保持它自身的几何协调（`16px` 内边距 / `16px` 圆角）。
 * 这一段是**已知的"未对齐"**，不是漏测。
 *
 * 运行与跳过纪律同其它 lane：没有可用浏览器时**不假装通过**。
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  artifactSha256,
  launchLaneBrowser,
  startLaneServer,
} from './lane-server.mjs'

// ── 官方尺寸（本文件独立复述一遍；每条都带出处） ─────────────────────────────

/** 官方设置页**表单值控件**：`primitives/lib/settings-form/fields.module.css` 的 `.input`。 */
const OFFICIAL_FIELD = {
  /** `.input{height:34px}` —— fields.module.css:108 */
  height: '34px',
  /** `.input{padding:0 12px}` —— fields.module.css:109 */
  paddingTop: '0px',
  paddingRight: '12px',
  paddingBottom: '0px',
  paddingLeft: '12px',
  /** `.input{font-size:13px}` —— fields.module.css:114 */
  fontSize: '13px',
  /** `.input{line-height:1.5}` —— fields.module.css:115（正文 13px × 1.5 = 19.5px） */
  lineHeight: '19.5px',
  /** `.input{border-radius:var(--dsw-radius-md)}` —— fields.module.css:110 */
  radiusVar: '--dsw-radius-md',
  /** `.input{border:.5px solid var(--dsw-alias-border-l4)}` —— fields.module.css:111 */
  expectBorderTopWidth: '0.5px',
}

/**
 * 官方**行内动作按钮**：`primitives/lib/Button.module.css` 的 `.sm`
 * （`settings-models/lib/client.js:58` 的 `._3nPmjq_rowActions ._3nPmjq_secondaryButton`
 * / `._3nPmjq_dangerButton` 就是这一档：28px + `radius-sm` + `0 10px` + 12px/18px）。
 */
const OFFICIAL_BUTTON = {
  /** `.sm{height:28px}` —— Button.module.css:29 */
  height: '28px',
  /** `.sm{padding:0 10px}` —— Button.module.css:32 */
  paddingTop: '0px',
  paddingRight: '10px',
  paddingBottom: '0px',
  paddingLeft: '10px',
  /** `.sm{font-size:12px}` —— Button.module.css:30 */
  fontSize: '12px',
  /** `.sm{line-height:18px}` —— Button.module.css:31 */
  lineHeight: '18px',
  /** `.sm{border-radius:var(--dsw-radius-sm)}` —— Button.module.css:33 */
  radiusVar: '--dsw-radius-sm',
}

/** 官方**胶囊标签**：`primitives/lib/Tag.module.css` 的 `.tag`。 */
const OFFICIAL_TAG = {
  /** `.tag{padding:1px 8px}` —— Tag.module.css:9 */
  paddingTop: '1px',
  paddingRight: '8px',
  paddingBottom: '1px',
  paddingLeft: '8px',
  /** `.tag{font-size:11px}` —— Tag.module.css:10 */
  fontSize: '11px',
  /** `.tag{line-height:17px}` —— Tag.module.css:11 */
  lineHeight: '17px',
  /** `.tag{border-radius:999px}` —— Tag.module.css:7 */
  borderRadius: '999px',
}

/** 官方 `Pill`：`primitives/lib/Pill.module.css` 的 `.pill`。 */
const OFFICIAL_PILL = {
  /** `.pill{height:24px}` —— Pill.module.css:5 */
  height: '24px',
  /** `.pill{padding:0 8px}` —— Pill.module.css:6 */
  paddingTop: '0px',
  paddingRight: '8px',
  paddingBottom: '0px',
  paddingLeft: '8px',
  /** `.pill{font-size:12px}` —— Pill.module.css:10 */
  fontSize: '12px',
  /** `.pill{line-height:18px}` —— Pill.module.css:11 */
  lineHeight: '18px',
  /** `.pill{border-radius:999px}` —— Pill.module.css:8 */
  borderRadius: '999px',
}

/**
 * 官方设置**卡片**：`dsh-client-ui-settings-models/lib/client.js:58` 的 `._3nPmjq_rowCard`
 * → `border:.5px solid …; border-radius:var(--dsw-radius-xl); gap:12px; padding:12px 14px`。
 *
 * 本插件取 `--dsw-radius-lg`（16px）而不是 `xl`（20px）：同一份官方 CSS 里
 * `._3nPmjq_editor` / `._3nPmjq_addCard` / `._3nPmjq_setupCard` 这些**内容卡片**用的
 * 就是 `lg`，而本插件的卡片是内容卡片。两条都在 `rowCard` 那一处附近，取哪一条
 * 是**明确的选择**而不是默写。
 */
const OFFICIAL_CARD = {
  /** `._3nPmjq_rowCard{padding:12px 14px}` —— settings-models/lib/client.js:58 */
  paddingTop: '12px',
  paddingRight: '14px',
  paddingBottom: '12px',
  paddingLeft: '14px',
  /** 本插件选择 `--dsw-radius-lg`（官方 editor / addCard 那一档） */
  radiusVar: '--dsw-radius-lg',
  /** `._3nPmjq_rowCard{border:.5px solid …}` —— 同上（同样只能断言内联声明值） */
  expectBorderTopWidth: '0.5px',
}

/** 官方文字层级：节标题 16px/24px/500（`._3nPmjq_title`）、次文字 12px/18px（`._3nPmjq_intro`）。 */
const OFFICIAL_TITLE = { fontSize: '16px', lineHeight: '24px', fontWeight: '500' }
const OFFICIAL_MUTED = { fontSize: '12px', lineHeight: '18px' }

// ── lane 启动 ───────────────────────────────────────────────────────────────

const server = await startLaneServer()
const launched = await launchLaneBrowser()
const ALLOW_SKIP = process.env.PXM_LANE_ALLOW_SKIP === '1'

const SKIP_BANNER = [
  '',
  '='.repeat(78),
  '  ⚠  浏览器 lane 已跳过 → 控件尺寸未经验证（"按钮多高 / 输入框多高 / 字号多大"这类',
  '     事实必须由真实排版引擎给出，jsdom 量不到）',
  '  ⚠  原因：本机没有可用的 Microsoft Edge / Google Chrome（playwright-core 不下载浏览器）',
  '     尝试过的 channel：' + (launched.failures.length === 0 ? '（无）' : launched.failures.join(' | ')),
  '  ⚠  修法：装 Edge/Chrome 后重跑；确实要在无浏览器机器上放行，用 PXM_LANE_ALLOW_SKIP=1',
  '='.repeat(78),
  '',
].join('\n')

if (launched.browser === null) {
  console.error(SKIP_BANNER)
  if (ALLOW_SKIP) {
    describe('浏览器 lane 前置（尺寸）', () => {
      it('SKIP：没有可用浏览器 → 控件尺寸未经验证', (t) => {
        t.skip('没有可用的 Edge/Chrome（PXM_LANE_ALLOW_SKIP=1 已显式放行）')
      })
    })
  } else {
    describe('浏览器 lane 前置（尺寸）', () => {
      it('必须有可用的系统 Edge/Chrome', () => {
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

  /** 单参探针 / 多参探针（lane 的探针签名是位置参数）。 */
  const probe = (page, name, arg = null) =>
    page.evaluate(([fn, value]) => window.__pxmLane[fn](value), [name, arg])
  const probeArgs = (page, name, args) =>
    page.evaluate(([fn, list]) => window.__pxmLane[fn].apply(null, list), [name, args])

  /**
   * 开一个尺寸 lane：真 HTTP 源 + 真 shell 骨架 + 真 React UMD + 原产物 client.js。
   *
   * `slot` 决定挂哪个面板。
   */
  async function openSizeLane(options = {}) {
    const context = await browser.newContext({
      viewport: { width: options.width ?? 1280, height: options.height ?? 900 },
      deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const problems = []
    page.on('pageerror', (err) => problems.push('pageerror: ' + err.message))
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push('console.error: ' + msg.text())
    })
    await page.goto(server.origin + '/shell.html', { waitUntil: 'load' })
    const data = typeof options.fixture === 'function' ? options.fixture(page) : options.fixture ?? fixture()
    await page.evaluate((payload) => window.__pxmLane.install(payload), data)
    await page.evaluate((slot) => window.__pxmLane.mount(slot), options.slot ?? 'main')
    return { page, context, problems }
  }

  /**
   * 按**语义角色**量一遍：lane 侧把角色映射到本插件当前的类名，Node 侧只认角色。
   *
   * 可以传多个探针名（结果合并成一袋角色）；同一页面里多个探针互不冲突。
   * 元素缺失时该角色为 `null`（由断言报出来，不静默跳过）。
   */
  async function measureRoles(page, slotsProbes) {
    const names = Array.isArray(slotsProbes) ? slotsProbes : [slotsProbes]
    const out = {}
    for (const name of names) {
      const slots = await probe(page, name)
      if (slots === null) continue
      for (const slot of slots) {
        out[slot.role] = await probeArgs(page, 'boxMetrics', ['[data-pxm-role="' + slot.role + '"]'])
      }
    }
    return Object.keys(out).length === 0 ? null : out
  }

  /**
   * 表单值控件的断言集：文本框 / 密码框用全部；`<select>` 去掉 `lineHeight`。
   *
   * 为什么 `<select>` 单独处理：**平台行为**——Chromium 对 `<select>` 不把内联
   * `line-height` 落到计算样式上（实测同一个 `inputStyle` 下 `input` 是 `19.5px`、
   * `select` 是 `normal`），而官方 `.input` 规则**本身是给 `<input>` 写的**，官方 client
   * 侧也没有原生 `<select>`（它的下拉是一个 div + background-image，见
   * `settings-models/lib/client.js:58` 的 `._3nPmjq_selectInput`）。
   * 所以 `<select>` 能对齐的是 height / padding / fontSize / radius / 描边这几项，
   * `lineHeight` 在这里是"平台不表达"的量，断言它就是永远红——如实记下这个限制。
   */
  const fieldExpectation = (role) => {
    const omit =
      role === 'select' || role === 'sortSelect'
        ? new Set(['lineHeight'])
        : new Set()
    const out = {}
    for (const key of Object.keys(OFFICIAL_FIELD)) {
      if (omit.has(key)) continue
      out[key] = OFFICIAL_FIELD[key]
    }
    return out
  }

  /** 让浏览器把 `var(--dsw-radius-*)` 现场解析成具体像素（而不是测试自己抄 8px）。 */
  async function resolveRadius(page, varNames) {
    return probeArgs(page, 'resolveSize', [
      varNames.map((name) => ({ key: name, prop: 'width', value: 'var(' + name + ')' })),
    ])
  }

  /**
   * 一组"尺寸必须等于官方"的字段 → 逐条 diff（失败信息里带实测值，便于定位）。
   *
   * 只比**计算样式**：`radiusVar` / `borderRadius` / `expectBorderTopWidth` 这类不由
   * 计算样式承担（或已由专门断言处理）的键要显式排除，否则会拿 `measure` 里不存在的键去比。
   */
  const NOT_COMPUTED = new Set(['radiusVar', 'borderRadius', 'expectBorderTopWidth'])

  const isObject = (value) => value !== null && typeof value === 'object'

  function sizeDiff(measured, expect, where) {
    const bad = []
    for (const [prop, want] of Object.entries(expect)) {
      if (NOT_COMPUTED.has(prop)) continue
      const got = measured[prop]
      if (got !== want) bad.push(where + ' 的 ' + prop + '：实测 ' + String(got) + '，官方 ' + String(want))
    }
    return bad
  }

  /** 圆角：计算值必须等于 `var(--dsw-radius-*)` 在本页的**解析值**（不是测试自己抄的 px）。 */
  function radiusDiff(measured, expect, resolved, where) {
    const parsed = resolved[expect.radiusVar]
    if (measured.borderRadius === parsed) return []
    return [
      where + ' 的 borderRadius：实测 ' + String(measured.borderRadius) +
        '，官方 var(' + expect.radiusVar + ') 的解析值 ' + String(parsed),
    ]
  }

  /**
   * 边框宽度：断言**内联声明值**，不是计算样式。
   *
   * 官方那根发丝线是 `0.5px`（`fields.module.css:111` 的 `.input`、
   * `settings-models` 的 `._3nPmjq_rowCard`），但 Chromium DPR=1 下
   * `border:.5px` 的**计算值就是 `1px`**（亚像素被量化）——计算样式里 0.5px 与 1px
   * 完全同值，断言它等于 0.5px 会永远红，断言它等于 1px 又证明不了"我们抄的是官方那一根"。
   * 所以这一条只能落在声明值上：**证据强度弱于其它尺寸断言**，如实记在这里。
   */
  function borderDiff(measured, expect, where) {
    const want = expect.expectBorderTopWidth
    const declared = isObject(measured.declared) ? measured.declared : {}
    const gotLonghand = declared.borderTopWidth
    const gotShorthand = declared.border
    // `style.border` 写入后，浏览器把值分派到长属性上（`style.border` 本身读回空串），
    // 所以两种形态都认：只要值就是官方那一根 0.5px 即可。
    const ok =
      gotLonghand === want || (typeof gotShorthand === 'string' && gotShorthand.indexOf(want) === 0)
    if (ok) return []
    return [
      where + ' 声明的边框宽度：实测 ' + String(gotLonghand ?? gotShorthand) + '，官方 ' + String(want) +
        '（计算样式里两者都会被量化成 1px，所以只能断言声明值）',
    ]
  }

  // ── 夹具 ──────────────────────────────────────────────────────────────────

  const PROJECT_ID = '2026-10-05-尺寸对齐'
  /**
   * 夹具时间戳：**相对当下**取「一周前」，而不是写死一个日期。
   *
   * 为什么不能写死：`PreviewOverlay` 判"本页加载之后新开始"用的是
   * `startedAt >= sessionStorage 里的挂载基线`。写死的日期一旦落到"当下之后"
   * （哪怕是同月同日），判据就被误判为真（这条用例实测踩过：写死 2026-10-05 时
   * `startedAt` 反而比基线晚 53 小时，于是量到的是展开的卡片而不是徽标）。
   * 相对当下取"一周前"就与两个时钟的先后无关了。
   */
  const CREATED_AT = Date.now() - 7 * 24 * 60 * 60 * 1000

  function itemFixture(index) {
    return {
      module: 'main.white-bg',
      label: '白底主图 ' + String(index),
      status: 'ok',
      size: '1:1',
      images: ['images/' + String(index) + '-a.png'],
      width: 1024,
      height: 1024,
      prompt: 'matte ceramic mug on a seamless white background, soft studio light',
      model: 'gpt-image-1',
      ms: 1234,
      createdAt: CREATED_AT,
      degraded: [],
    }
  }

  /**
   * 基线夹具。
   *
   * **必须接 `over` 并展开**：3.1 要靠 `fixture({ runs, runDetail })` 注入一条运行，
   * 不接的话那两项会被**静默丢掉**（实测踩过：徽标永远不出现，用例以 30s 超时失败，
   * 而报错里看不出夹具被吃了）。
   */
  const fixture = (over = {}) => ({
    projects: [
      {
        id: PROJECT_ID,
        name: '尺寸对齐',
        createdAt: CREATED_AT,
        provider: 'ofox',
        model: 'gpt-image-1',
        imageCount: 2,
        cover: PROJECT_ID + '/images/cover.png',
      },
    ],
    detail: {
      ok: true,
      project: {
        id: PROJECT_ID,
        name: '尺寸对齐',
        createdAt: CREATED_AT,
        provider: 'ofox',
        model: 'gpt-image-1',
        items: [itemFixture(0), itemFixture(1)],
      },
    },
    providers: {
      ok: true,
      dataDir: 'D:/pixmart',
      exportDir: '',
      defaults: { provider: 'ofox', model: 'gpt-image-1', size: '1:1', n: 1 },
      usage: { requests: 1, ok: 1, failed: 0, images: 1 },
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
          models: ['gpt-image-1'],
          allowedSizes: ['1:1'],
        },
      ],
    },
    trash: {
      ok: true,
      count: 1,
      trash: [
        {
          id: PROJECT_ID,
          name: '尺寸对齐',
          imageCount: 2,
          provider: 'ofox',
          deletedAt: CREATED_AT,
        },
      ],
    },
    ...over,
  })

  // ── 0. lane 自证 ──────────────────────────────────────────────────────────

  describe('0. lane 自证（尺寸侧）', () => {
    it('加载的是仓库原产物 client.js，且尺寸探针可用', async () => {
      const { page, context } = await openSizeLane({ slot: 'settings.section' })
      try {
        assert.ok(server.served.clientRequests >= 1, '浏览器必须真的请求过 /client/client.js')
        assert.equal(server.served.clientSha256, artifact, 'lane 服务的必须是仓库原产物，逐字节一致')
        assert.equal(
          await page.evaluate(() => typeof window.__pxmLane.boxMetrics),
          'function',
          'lane 必须导出尺寸探针 boxMetrics（否则下面的用例量不到东西）',
        )
        assert.equal(
          await page.evaluate(() => typeof window.__pxmLane.resolveSize),
          'function',
          'lane 必须导出非颜色值解析探针 resolveSize（圆角断言靠它取官方解析值）',
        )
      } finally {
        await context.close()
      }
    })
  })

  // ── 1. 设置页 ─────────────────────────────────────────────────────────────

  describe('1. 尺寸对齐 · 设置页（settings.section）', () => {
    it('1.1 输入框 / 下拉 = 官方设置页表单控件（34px / 0 12px / 13px / radius-md / 0.5px 描边）', async () => {
      const { page, context, problems } = await openSizeLane({ slot: 'settings.section' })
      try {
        /*
         * 设置页的控件是**取数之后**才渲染的（各家卡片先 `apiGet('api/providers')`、
         * 拿到数据才画 `input` / `select` / 按钮）。不等这一句就会量到"元素缺失"
         * ——这是实测踩过的坑，不是防御性代码。
         */
        await page.waitForSelector('.pxm-settings input[type="text"]', { timeout: 15000 })
        // 角色来源：设置页 + 预览徽标（`.pxm-badge` 在别的页面里正是"第一枚 .pxm-pill"，
        // 所以设置页的 `tag` 必须由 `settingsSlots` 在 `.pxm-settings` 内定位）。
        const roles = await measureRoles(page, ['settingsSlots', 'overlaySlots'])
        assert.ok(roles !== null, '必须能挂上设置页（.pxm-settings）')

        const radius = await resolveRadius(page, [OFFICIAL_FIELD.radiusVar])
        assert.equal(
          await page.evaluate(
            (name) => window.getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
            OFFICIAL_FIELD.radiusVar,
          ),
          '12px',
          'shell 骨架必须发布官方 --dsw-radius-md 的取值（否则圆角断言是空转）',
        )

        for (const role of ['textInput', 'passwordInput', 'select']) {
          const measured = roles[role]
          assert.ok(measured !== null && measured !== undefined, '设置页必须有 ' + role)
          const expected = fieldExpectation(role)
          const bad = sizeDiff(measured, expected, role)
            .concat(radiusDiff(measured, expected, radius, role))
            .concat(borderDiff(measured, expected, role))
          assert.deepEqual(bad, [], '设置页 ' + role + ' 的尺寸与官方表单控件不一致：\n' + bad.join('\n'))
        }
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })

    it('1.2 按钮 = 官方 Button.sm（28px / 0 10px / 12px / radius-sm），Tag = 官方 .tag', async () => {
      const { page, context, problems } = await openSizeLane({ slot: 'settings.section' })
      try {
        // 同 1.1：设置页的控件要等取数回来才渲染。
        await page.waitForSelector('.pxm-settings button.pxm-btn', { timeout: 15000 })
        const roles = await measureRoles(page, ['settingsSlots', 'overlaySlots'])
        assert.ok(roles !== null, '必须能挂上设置页（.pxm-settings）')

        const radius = await resolveRadius(page, [OFFICIAL_BUTTON.radiusVar])

        // 按钮：与官方 `.sm` 逐项相等（几何高度也一起量：有高度时应当真的画成 28px）。
        const button = roles.button
        assert.ok(button !== null && button !== undefined, '设置页必须有按钮')
        const bad = sizeDiff(button, OFFICIAL_BUTTON, '按钮').concat(
          radiusDiff(button, OFFICIAL_BUTTON, radius, '按钮'),
        )
        if (Math.abs(button.rect.height - 28) > 0.51) {
          bad.push('按钮的真实几何高度：实测 ' + String(button.rect.height) + 'px，官方 .sm 是 28px')
        }
        assert.deepEqual(bad, [], '设置页按钮的尺寸与官方 Button.sm 不一致：\n' + bad.join('\n'))

        // Tag：与官方 `.tag` 逐项相等。
        const tag = roles.tag
        assert.ok(tag !== null && tag !== undefined, '设置页必须有胶囊标签（.pxm-pill）')
        assert.deepEqual(
          sizeDiff(tag, OFFICIAL_TAG, 'Tag'),
          [],
          '设置页 Tag 的尺寸与官方 Tag.module.css 的 .tag 不一致',
        )

        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })

    it('1.3 标题 / 正文 = 官方文字层级（16px / 24px / 500，次文字 12px / 18px）', async () => {
      const { page, context, problems } = await openSizeLane({ slot: 'settings.section' })
      try {
        // 标题在首帧就有；次文字 `p` 也是首帧的（不依赖取数）。
        await page.waitForSelector('.pxm-settings h2', { timeout: 15000 })
        const roles = await measureRoles(page, 'settingsSlots')
        assert.ok(roles !== null, '必须能挂上设置页（.pxm-settings）')

        const title = roles.pageTitle
        assert.ok(title !== null && title !== undefined, '设置页必须有节标题（h2）')
        assert.deepEqual(
          sizeDiff(title, OFFICIAL_TITLE, '设置页标题'),
          [],
          '设置页标题的字号/行高/字重与官方 ._3nPmjq_title 不一致',
        )

        const muted = await probeArgs(page, 'boxMetrics', ['.pxm-settings p'])
        assert.ok(muted !== null, '设置页必须有说明性正文（p）')
        assert.deepEqual(
          sizeDiff(muted, OFFICIAL_MUTED, '设置页次文字'),
          [],
          '设置页次文字的字号/行高与官方 ._3nPmjq_intro 那一档不一致',
        )
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })
  })

  // ── 2. 作品库 ─────────────────────────────────────────────────────────────

  describe('2. 尺寸对齐 · 作品库（main）', () => {
    it('2.1 工具条按钮 = Button.sm；搜索框 / 排序下拉 = 官方表单控件', async () => {
      const { page, context, problems } = await openSizeLane()
      try {
        await page.waitForSelector('.pxm-tile')
        const roles = await measureRoles(page, 'workbenchSlots')
        assert.ok(roles !== null, '必须能挂上作品库面板（.pxm-workbench）')

        const button = roles.toolbarButton
        assert.ok(button !== null && button !== undefined, '作品库工具条必须有按钮（回收站）')
        const bad = sizeDiff(button, OFFICIAL_BUTTON, '工具条按钮')
        if (Math.abs(button.rect.height - 28) > 0.51) {
          bad.push('工具条按钮的真实几何高度：实测 ' + String(button.rect.height) + 'px，官方 .sm 是 28px')
        }
        assert.deepEqual(bad, [], '作品库工具条按钮与官方 Button.sm 不一致：\n' + bad.join('\n'))

        for (const role of ['searchInput', 'sortSelect']) {
          const measured = roles[role]
          assert.ok(measured !== null && measured !== undefined, '作品库必须有 ' + role)
          const expected = fieldExpectation(role)
          assert.deepEqual(
            sizeDiff(measured, expected, role).concat(borderDiff(measured, expected, role)),
            [],
            '作品库 ' + role + ' 与官方表单控件尺寸不一致',
          )
        }
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })

    it('2.2 回收站列表项 = 官方设置卡片（12px 14px / radius-lg / 0.5px 描边）', async () => {
      const { page, context, problems } = await openSizeLane()
      try {
        await page.waitForSelector('.pxm-tile')
        // 进回收站：列表项卡片才会出现。
        await page.click('.pxm-trash-toggle')
        await page.waitForSelector('.pxm-trash-item')

        const roles = await measureRoles(page, 'workbenchSlots')
        const card = roles === null ? null : roles.card
        assert.ok(card !== null && card !== undefined, '回收站必须有列表项卡片（.pxm-trash-item）')

        const radius = await resolveRadius(page, [OFFICIAL_CARD.radiusVar])
        const bad = sizeDiff(card, OFFICIAL_CARD, '回收站列表项')
          .concat(radiusDiff(card, OFFICIAL_CARD, radius, '回收站列表项'))
          .concat(borderDiff(card, OFFICIAL_CARD, '回收站列表项'))
        assert.deepEqual(bad, [], '回收站列表项与官方设置卡片尺寸不一致：\n' + bad.join('\n'))
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })
  })

  // ── 3. 查看器 ─────────────────────────────────────────────────────────────

  describe('3. 尺寸对齐 · 大图查看器（作品库面板内的模态层）', () => {
    it('3.1 关闭 / 翻页按钮 = Button.sm；信息卡 = 官方设置卡片', async () => {
      const { page, context, problems } = await openSizeLane()
      try {
        await page.waitForSelector('.pxm-tile')
        await page.click('.pxm-tile')
        await page.waitForSelector('.pxm-thumb')
        await page.click('.pxm-thumb')
        await page.waitForSelector('.pxm-viewer')

        const roles = await measureRoles(page, 'viewerSlots')
        assert.ok(roles !== null, '查看器必须挂上（.pxm-viewer）')

        const radius = await resolveRadius(page, [OFFICIAL_BUTTON.radiusVar])
        const button = roles.viewerButton
        assert.ok(button !== null && button !== undefined, '查看器必须有「关闭」按钮')
        const bad = sizeDiff(button, OFFICIAL_BUTTON, '查看器关闭按钮')
          .concat(radiusDiff(button, OFFICIAL_BUTTON, radius, '查看器关闭按钮'))
        if (Math.abs(button.rect.height - 28) > 0.51) {
          bad.push('查看器关闭按钮的真实几何高度：实测 ' + String(button.rect.height) + 'px，官方 .sm 是 28px')
        }
        assert.deepEqual(bad, [], '查看器按钮与官方 Button.sm 不一致：\n' + bad.join('\n'))

        const card = roles.viewerCard
        assert.ok(card !== null && card !== undefined, '查看器必须有信息卡（.pxm-viewer-scroll 的最后一个子节点）')
        const cardRadius = await resolveRadius(page, [OFFICIAL_CARD.radiusVar])
        assert.deepEqual(
          sizeDiff(card, OFFICIAL_CARD, '查看器信息卡')
            .concat(radiusDiff(card, OFFICIAL_CARD, cardRadius, '查看器信息卡'))
            .concat(borderDiff(card, OFFICIAL_CARD, '查看器信息卡')),
          [],
          '查看器信息卡与官方设置卡片尺寸不一致',
        )
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })
  })

  // ── 4. 实时预览（shell.overlay）─────────────────────────────────────────────

  describe('4. 尺寸对齐 · 实时预览徽标（shell.overlay）', () => {
    it('4.1 徽标胶囊 = 官方 Pill（24px / 0 8px / 12px / 18px / 999px）', async () => {
      /*
       * 徽标是**折叠态**的那一枚（`.pxm-badge`）；展开态是卡片（`.pxm-card`）。
       *
       * 夹具给一条 `startedAt` **早于**本页加载基线的 active 运行：`PreviewOverlay` 的
       * `autoExpanded = startedAfterLoad && isActive(status)` 因此为假 → 首屏就是折叠态，
       * 直接渲染徽标。这样这条用例**不依赖任何时序**：判据里的"本页加载基线"是从
       * `sessionStorage` 读的，跨用例可能比 Node 侧的 `Date.now()` 还晚，
       * 所以"让 startedAt 比基线大"这种写法会变成碰运气（实测就会偶发地量到卡片）。
       * 给空夹具则 `run === null` 会直接 `return null`，量到的就是"元素缺失"。
       */
      const run = {
        runId: 'run-size-1',
        projectId: PROJECT_ID,
        projectName: '尺寸对齐',
        status: 'awaiting-confirm',
        startedAt: CREATED_AT,
        total: 2,
        completed: 2,
        failed: 0,
        currentLabel: null,
        items: [itemFixture(0), itemFixture(1)],
      }
      const { page, context, problems } = await openSizeLane({
        slot: 'shell.overlay',
        fixture: fixture({
          runs: [
            {
              runId: run.runId,
              projectId: run.projectId,
              projectName: run.projectName,
              status: run.status,
              startedAt: run.startedAt,
              total: run.total,
              completed: run.completed,
              failed: run.failed,
            },
          ],
          runDetail: run,
        }),
      })
      try {
        await page.waitForSelector('.pxm-badge')
        const roles = await measureRoles(page, 'overlaySlots')
        const measured = roles === null ? null : roles.badge
        assert.ok(measured !== null && measured !== undefined, '折叠态必须有预览徽标（.pxm-badge）')
        const bad = sizeDiff(measured, OFFICIAL_PILL, '预览徽标')
        if (Math.abs(measured.rect.height - 24) > 0.51) {
          bad.push('预览徽标的真实几何高度：实测 ' + String(measured.rect.height) + 'px，官方 Pill 是 24px')
        }
        assert.deepEqual(bad, [], '预览徽标与官方 Pill 尺寸不一致：\n' + bad.join('\n'))
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })
  })
}
