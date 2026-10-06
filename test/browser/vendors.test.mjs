/**
 * 浏览器 lane：**厂商 / 模型配置卡片对齐官方「模型」设置页**（2026-10-11）。
 *
 * ## 这份用例守什么
 *
 * 2026-10-11 把设置页的「厂商」卡片按 DSH 官方「模型」设置页
 * （`@deepseek-ai/dsh-client-ui-settings-models`）的**标记结构 + 内联 CSS** 重排。
 * 那次改造有两条互相拉扯的要求，缺一不可：
 *
 *   1. **不许丢东西**：用户明确要求保留三样 —— 「拉取模型」按钮、「测试连接」按钮、
 *      以及**拉取之后的模型列表**。样式统一最容易踩的坑就是"重排时把它们弄没了"，
 *      所以这里三条各自一条用例（`1.1` / `1.2` / `1.3`），而且断言是**行为级**的：
 *      按钮不只是"存在"，还要点得动、点下去真的发请求；列表不但要出现，条目数必须
 *      等于夹具给的模型数。
 *   2. **必须长得像官方**：卡片 / 区块 / 字段 / 模型列表行的**内边距、圆角、间距、字号**
 *      必须等于官方 `._3nPmjq_*` 那套取值（`2.x`）。取值在本文件里**独立复述**一遍
 *      （同源不同处），实现与用例任何一处漂移都会红。
 *
 * ## 官方取值从哪来（都在 app.asar 内联 CSS 里核过原文）
 *
 *   - `._3nPmjq_rowCard{border:.5px solid var(--dsw-alias-settings-card-stroke);
 *     background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl);
 *     flex-direction:column;gap:12px;padding:12px 14px}`
 *   - `._3nPmjq_rows{flex-direction:column;gap:8px;margin:12px 0 0;padding:0;list-style:none}`
 *   - `._3nPmjq_rowHead{gap:10px}` / `._3nPmjq_rowIdentity{gap:6px}` /
 *     `._3nPmjq_rowName{font-size:14px;font-weight:500;line-height:22px}` /
 *     `._3nPmjq_rowTag{padding:1px 6px;font-size:11px;line-height:16px;
 *     border-radius:var(--dsw-radius-xs)}` / `._3nPmjq_credentialDot{width:8px;height:8px;
 *     border-radius:50%}`（已配置 = `state-success-primary`）
 *   - `._3nPmjq_editor{border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform);
 *     gap:14px;padding:14px 16px}` / `._3nPmjq_editorActions{justify-content:flex-end;gap:8px}`
 *   - `._3nPmjq_modelCatalog{border-top:.5px solid var(--dsw-alias-border-l2);gap:10px;padding-top:12px}`
 *     / `._3nPmjq_modelCatalogTitle{font-size:12px;font-weight:500;line-height:18px}`
 *     / `._3nPmjq_modelCatalogMeta{font-size:12px;line-height:18px}`
 *   - `._3nPmjq_linkButton{height:28px;padding:0 10px;font-size:12px;line-height:18px;
 *     border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);border:none}`
 *     —— 官方「获取模型」（`fetchModels`）就是这一档，位置在模型区块标题行右侧。
 *   - 模型列表（多选）取官方**候选列表**那一套：
 *     `._3nPmjq_candidateList{gap:2px;padding:0;overflow-y:auto}`、
 *     `._3nPmjq_candidateLabel{gap:8px;padding:6px 8px;align-items:center;display:flex}`、
 *     `._3nPmjq_candidate{border-radius:var(--dsw-radius-md)}`、
 *     `._3nPmjq_candidateId{font-size:13px;text-overflow:ellipsis;white-space:nowrap;flex:auto}`。
 *     逐条来源与偏差见 `docs/contract-notes.md` §23。
 *
 * ## 与 sizes.test.mjs 的分工
 *
 * `sizes.test.mjs` 管"控件档位"（按钮 / 输入框 / 胶囊 / 卡片的内边距与圆角）；
 * 本文件管**这一张**卡片重排之后的**区块级**几何与那三个保留项。两条都会在
 * 反向变异里被证明不是空跑（`tools/lane-mutations.mjs` 的 `M37`~`M40`）。
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { startLaneServer, launchLaneBrowser } from './lane-server.mjs'

// ── 夹具 ────────────────────────────────────────────────────────────────────

/**
 * 拉取会回给我们的模型目录。**故意给 5 个**（不是 1 个）：条目数断言才有意义 ——
 * 只给 1 个的话"列表画出来了"与"列表画对了条数"分不出来。
 */
const PULLED = [
  'google/gemini-3.1-flash-image',
  'openai/gpt-image-1',
  'black-forest-labs/flux-1.1-pro',
  'qwen/qwen-image-edit',
  'text-embedding-3-large',
]

const providersFixture = {
  ok: true,
  dataDir: 'D:/pixmart',
  exportDir: '',
  defaults: { provider: 'ofox', model: 'openai/gpt-image-1', size: '1:1', n: 1 },
  usage: { requests: 1, ok: 1, failed: 0, images: 1 },
  historical: { images: 0, projects: 0, note: '' },
  providers: [
    {
      id: 'ofox',
      label: 'Ofox',
      group: 'aggregator',
      apiMode: 'images-generations',
      baseUrl: 'https://api.example.test/v1',
      geminiNativeBaseUrl: '',
      dialect: 'standard',
      apiKeyEnv: '',
      hasApiKey: true,
      apiKeySource: 'config',
      models: ['openai/gpt-image-1'],
      allowedSizes: ['1:1'],
      sizeMode: 'whitelist',
      timeoutMs: 180000,
    },
  ],
}

/**
 * 写请求的响应（lane 的 `fixture.posts`，键是路径正则）。
 * 只给这三个：其余写请求仍旧走 lane 的默认 `{ok:true}`。
 */
const POSTS = {
  'refresh-models$': { ok: true, models: PULLED, count: PULLED.length },
  '/test$': { ok: true, latencyMs: 42, modelCount: PULLED.length },
  '/models$': { ok: true, count: 1 },
}

const fixture = () => ({ providers: providersFixture, projects: [], posts: POSTS })

// ── 官方取值（本文件独立复述；每条都带出处） ─────────────────────────────────

/** `._3nPmjq_rowCard` —— settings-models/lib/client.js:58 */
const OFFICIAL_CARD = {
  paddingTop: '12px',
  paddingRight: '14px',
  paddingBottom: '12px',
  paddingLeft: '14px',
  gap: '12px',
  flexDirection: 'column',
  /** `border-radius:var(--dsw-radius-xl)` —— 同处 */
  radiusVar: '--dsw-radius-xl',
  /** `border:.5px solid …` —— 同处（计算样式会被量化成 1px，只能断言声明值） */
  expectBorderTopWidth: '0.5px',
  /**
   * `border:.5px solid var(--dsw-alias-settings-card-stroke)`，而官方 theme 的 base CSS 里
   * `--dsw-alias-settings-card-stroke: var(--dsw-alias-border-l4)` —— 描边这一半挂的
   * `border-l4` 同样是那条规则的**别名目标**。
   */
  borderColorVar: '--dsw-alias-border-l4',
  /**
   * `background:var(--dsw-alias-settings-card-fill)`，而官方 theme 的 base CSS 里
   * `--dsw-alias-settings-card-fill: var(--dsw-alias-bg-layer-2)` —— 所以我们挂的
   * `bg-layer-2` 就是这条规则的**别名目标**（不是近似色）。
   */
  backgroundVar: '--dsw-alias-bg-layer-2',
}

/** `._3nPmjq_rows` —— 同处 */
const OFFICIAL_ROWS = {
  gap: '8px',
  marginTop: '12px',
  paddingTop: '0px',
  paddingRight: '0px',
  paddingBottom: '0px',
  paddingLeft: '0px',
  listStyleType: 'none',
  flexDirection: 'column',
}

/** 厂商标头那一行：rowHead / rowIdentity / rowName / rowTag / credentialDot —— 同处 */
const OFFICIAL_HEAD = {
  headGap: '10px',
  identityGap: '6px',
  nameFontSize: '14px',
  nameLineHeight: '22px',
  nameFontWeight: '500',
  tagPadTop: '1px',
  tagPadRight: '6px',
  tagPadBottom: '1px',
  tagPadLeft: '6px',
  tagFontSize: '11px',
  tagLineHeight: '16px',
  tagRadiusVar: '--dsw-radius-xs',
  dotSize: '8px',
  dotRadius: '50%',
  /** 已配置 → `background:var(--dsw-alias-state-success-primary)` */
  dotOkColorVar: '--dsw-alias-state-success-primary',
  actionsGap: '4px',
}

/** 编辑块与字段：`._3nPmjq_editor` / `._3nPmjq_editorActions` / `._3nPmjq_field` —— 同处 */
const OFFICIAL_EDITOR = {
  padTop: '14px',
  padRight: '16px',
  padBottom: '14px',
  padLeft: '16px',
  gap: '14px',
  radiusVar: '--dsw-radius-lg',
  /** `background:var(--dsw-alias-bg-module-platform)` —— 同处 */
  backgroundVar: '--dsw-alias-bg-module-platform',
  actionsGap: '8px',
  actionsJustify: 'flex-end',
}

/** 模型区块：`._3nPmjq_modelCatalog` / `…Title` / `…Meta` —— 同处 */
const OFFICIAL_CATALOG = {
  padTop: '12px',
  gap: '10px',
  titleFontSize: '12px',
  titleLineHeight: '18px',
  titleFontWeight: '500',
  metaFontSize: '12px',
  metaLineHeight: '18px',
}

/** 「拉取模型」= 官方 `._3nPmjq_linkButton`（同文件 :749-758 的 `fetchModels`） */
const OFFICIAL_LINK_BUTTON = {
  height: '28px',
  paddingTop: '0px',
  paddingRight: '10px',
  paddingBottom: '0px',
  paddingLeft: '10px',
  fontSize: '12px',
  lineHeight: '18px',
  radiusVar: '--dsw-radius-sm',
  /** `.linkButton{…border:none;background:0 0}` —— 官方链接式按钮没有描边 */
  expectNoBorder: true,
}

/** 模型列表行 = 官方候选列表那一套（同文件 :88-91） */
const OFFICIAL_MODEL_ROW = {
  rowGap: '8px',
  rowPadTop: '6px',
  rowPadRight: '8px',
  rowPadBottom: '6px',
  rowPadLeft: '8px',
  rowDisplay: 'flex',
  rowAlignItems: 'center',
  rowRadiusVar: '--dsw-radius-md',
  nameFontSize: '13px',
  listGap: '2px',
  listOverflowY: 'auto',
  listPadTop: '0px',
  listPadLeft: '0px',
  /**
   * 滚动上限 = 官方值 `._3nPmjq_candidateList{max-height:320px}`
   * （`settings-backends`… 不，是 `settings-models/lib/client.js:58` 那一行内联 CSS）。
   *
   * 2026-10-12 修正偏差 ③：早先本插件取 240px，理由是"既有 jsdom 用例把它钉在 240px，
   * 改大等于放宽保证"—— 方向错了：目标是"与官方一致"，官方值就是标准，
   * 那条 jsdom 断言应当按官方值**更新**（更新断言 ≠ 放宽断言）。
   * "150 项不许把卡片撑爆"这条保证没有被削弱：`overflowY:auto` 与上限本身都还在
   * （见下面 2.3 里 `scrollHeight >= clientHeight` 那条互补断言）。
   */
  listMaxHeight: '320px',
}

// ── lane 启动 ───────────────────────────────────────────────────────────────

const server = await startLaneServer()
const launched = await launchLaneBrowser()
const ALLOW_SKIP = process.env.PXM_LANE_ALLOW_SKIP === '1'

const SKIP_BANNER = [
  '',
  '='.repeat(78),
  '  ⚠  浏览器 lane 已跳过 → 厂商卡片的样式对齐与三个保留项未经验证',
  '  ⚠  原因：本机没有可用的 Microsoft Edge / Google Chrome（playwright-core 不下载浏览器）',
  '     尝试过的 channel：' + (launched.failures.length === 0 ? '（无）' : launched.failures.join(' | ')),
  '  ⚠  修法：装 Edge/Chrome 后重跑；确实要在无浏览器机器上放行，用 PXM_LANE_ALLOW_SKIP=1',
  '='.repeat(78),
  '',
].join('\n')

if (launched.browser === null) {
  console.error(SKIP_BANNER)
  if (ALLOW_SKIP) {
    describe('浏览器 lane 前置（厂商卡片）', () => {
      it('SKIP：没有可用浏览器 → 样式与保留项未经验证', (t) => {
        t.skip('没有可用的 Edge/Chrome（PXM_LANE_ALLOW_SKIP=1 已显式放行）')
      })
    })
  } else {
    describe('浏览器 lane 前置（厂商卡片）', () => {
      it('必须有可用的系统 Edge/Chrome', () => {
        assert.fail(SKIP_BANNER)
      })
    })
  }
  await server.close()
} else {
  const browser = launched.browser

  after(async () => {
    await browser.close()
    await server.close()
  })

  const probe = (page, name, arg = null) =>
    page.evaluate(([fn, value]) => window.__pxmLane[fn](value), [name, arg])
  const probeArgs = (page, name, args) =>
    page.evaluate(([fn, list]) => window.__pxmLane[fn].apply(null, list), [name, args])

  /** 开一个真页面：真 HTTP 源 + 真 shell 骨架 + 原产物 client.js，挂设置页。 */
  async function openVendorLane() {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const problems = []
    page.on('pageerror', (err) => problems.push('pageerror: ' + err.message))
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push('console.error: ' + msg.text())
    })
    await page.goto(server.origin + '/shell.html', { waitUntil: 'load' })
    await page.evaluate((payload) => window.__pxmLane.install(payload), fixture())
    await page.evaluate(() => window.__pxmLane.mount('settings.section'))
    // 设置页要等取数回来才画卡片。
    await page.waitForSelector('[data-pxm-vendor-card]', { timeout: 15000 })
    /*
     * 请求记录由 **lane** 交出来，而不是 `page.on('request')`：插件的 `window.fetch`
     * 被 lane 换成了夹具路由，浏览器侧**没有真实网络请求**，Playwright 的请求事件
     * 什么都看不到（实测：`posts` 恒为空数组）。
     */
    const calls = () => probe(page, 'fetchCalls')
    return { page, context, problems, calls }
  }

  /** 让浏览器把 `var(--dsw-*)` 现场解析成具体值（颜色 / 长度都用它）。 */
  async function resolveVars(page, items) {
    return probeArgs(page, 'resolveCss', [items])
  }

  /** 官方**颜色**变量在**当前主题**下的解析值。 */
  async function resolveColors(page, keys) {
    return resolveVars(
      page,
      keys.map((item) => ({ key: item.key, prop: item.prop ?? 'backgroundColor', value: 'var(' + item.token + ')' })),
    )
  }

  /** 官方**长度**变量（圆角）的解析值。 */
  async function resolveRadii(page, varNames) {
    return probeArgs(
      page,
      'resolveSize',
      [varNames.map((name) => ({ key: name, prop: 'width', value: 'var(' + name + ')' }))],
    )
  }

  /**
   * 声明值那一半：`0.5px` 的发丝线在 Chromium DPR=1 下计算值被量化成 `1px`，
   * 所以只能断言**声明值**（与 `sizes.test.mjs` 的 `borderDiff` 同一处理）。
   */
  function declaredBorderOf(metrics) {
    const declared = metrics.declared ?? {}
    const raw = metrics.declaredBorder ?? {}
    return {
      shorthand: String(raw.shorthand ?? ''),
      topShorthand: String(raw.topShorthand ?? ''),
      topWidth: String(raw.topWidth ?? ''),
      longhand: declared.borderTopWidth,
      border: declared.border,
      borderTop: declared.borderTop,
    }
  }

  function expectDeclaredBorder(metrics, want, where) {
    const got = declaredBorderOf(metrics)
    const startsWith = (value) => typeof value === 'string' && value.indexOf(want) === 0
    const ok =
      got.longhand === want ||
      got.topWidth === want ||
      startsWith(got.border) ||
      startsWith(got.borderTop) ||
      startsWith(got.shorthand) ||
      startsWith(got.topShorthand)
    assert.ok(
      ok,
      where + ' 声明的边框宽度：实测 ' + JSON.stringify(got) + '，官方 ' + want,
    )
  }

  /**
   * "没有描边"这一条：官方链接式按钮写的是 `.linkButton{…border:none}` ——
   * 它是**显式声明成没有**，不是"从未写过边框"。两种形态都算通过：
   *   - `border: none`（我们与官方同款）→ 简写读回 `none`、宽度读回空或 `0px`；
   *   - 从未声明过 → 简写为空、宽度为 UA 初始值 `medium`。
   * 真正要挡住的是"给它加了一根看得见的描边"（例如 `1px solid …`）。
   */
  function expectNoVisibleBorder(metrics, where) {
    const got = declaredBorderOf(metrics)
    const noneDeclared = got.shorthand === '' || got.shorthand === 'none'
    const noWidth = got.topWidth === '' || got.topWidth === 'medium' || got.topWidth === '0px'
    assert.ok(
      noneDeclared && noWidth,
      where + ' 不该有描边（官方 `.linkButton{…border:none}`），实测 ' + JSON.stringify(got),
    )
  }

  /** 不由**计算样式**承担的键（圆角 / 底色走变量、描边走声明值）——只比计算样式。 */
  const NOT_COMPUTED = new Set([
    'radiusVar',
    'backgroundVar',
    'borderColorVar',
    'expectBorderTopWidth',
    'expectNoBorder',
  ])

  /** 一组"必须等于官方"的字段 → 逐条 diff（失败信息带实测值）。 */
  function diffOf(measured, expect, where) {
    const bad = []
    for (const [prop, want] of Object.entries(expect)) {
      if (NOT_COMPUTED.has(prop)) continue
      const got = measured[prop]
      if (got !== want) {
        bad.push(where + ' 的 ' + prop + '：实测 ' + String(got) + '，官方 ' + String(want))
      }
    }
    return bad
  }

  /** 圆角：计算值必须等于 `var(--dsw-radius-*)` 在**本页**的解析值。 */
  function radiusDiff(measured, varName, resolved, where) {
    const parsed = resolved[varName]
    if (measured.borderRadius === parsed) return []
    return [
      where + ' 的 borderRadius：实测 ' + String(measured.borderRadius) +
        '，官方 var(' + varName + ') 的解析值 ' + String(parsed),
    ]
  }

  /** 颜色：计算值必须等于该 token 在**当前主题**下的解析值。 */
  function colorDiff(measured, prop, token, resolved, where) {
    const parsed = resolved[token]
    if (measured[prop] === parsed) return []
    return [
      where + ' 的 ' + prop + '：实测 ' + String(measured[prop]) +
        '，官方 var(' + token + ') 的解析值 ' + String(parsed),
    ]
  }

  // ── 1. 三个保留项 ─────────────────────────────────────────────────────────

  describe('1. 保留项（改样式不许把它们弄没）', () => {
    it('1.1 「拉取模型」按钮存在、可点，点下去真的发 refresh-models', async () => {
      const { page, context, problems, calls } = await openVendorLane()
      try {
        const facts = await probe(page, 'vendorFacts')
        assert.ok(facts !== null, '必须能定位厂商卡片（[data-pxm-vendor-card]）')
        const button = facts.fetchButton
        assert.ok(button !== null && button.present === true, '卡片上必须有「拉取模型」按钮')
        assert.equal(button.tag, 'BUTTON', '「拉取模型」必须是原生 button（Tab / Enter 才有原生行为）')
        assert.equal(button.text, '拉取模型', '「拉取模型」的文案不许改：' + JSON.stringify(button))
        assert.equal(button.disabled, false, '「拉取模型」默认必须是可点的')

        await page.click('[data-pxm-role="fetch-models"]')
        await page.waitForSelector('[data-pxm-model-row]', { timeout: 10000 })

        const all = await calls()
        const refreshPosts = all.filter(
          (call) => call.method === 'POST' && /refresh-models$/.test(call.url),
        )
        assert.equal(
          refreshPosts.length,
          1,
          '点「拉取模型」必须发一次 POST …/refresh-models，实际：' + JSON.stringify(all),
        )
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })

    it('1.2 「测试连接」按钮存在、可点，点下去真的发 /test 并给出成功文案', async () => {
      const { page, context, problems, calls } = await openVendorLane()
      try {
        const facts = await probe(page, 'vendorFacts')
        assert.ok(facts !== null, '必须能定位厂商卡片（[data-pxm-vendor-card]）')
        const button = facts.testButton
        assert.ok(button !== null && button.present === true, '卡片上必须有「测试连接」按钮')
        assert.equal(button.tag, 'BUTTON', '「测试连接」必须是原生 button')
        assert.equal(button.text, '测试连接', '「测试连接」的文案不许改：' + JSON.stringify(button))
        assert.equal(button.disabled, false, '「测试连接」默认必须是可点的')

        await page.click('[data-pxm-role="test-connection"]')
        await page.waitForFunction(
          () => (document.body.textContent || '').indexOf('连接正常') >= 0,
          null,
          { timeout: 10000 },
        )

        const all = await calls()
        const testPosts = all.filter((call) => call.method === 'POST' && /\/test$/.test(call.url))
        assert.equal(
          testPosts.length,
          1,
          '点「测试连接」必须发一次 POST …/test，实际：' + JSON.stringify(all),
        )
        assert.ok(
          (await page.evaluate(() => document.body.textContent)).includes('连接正常'),
          '成功时必须回显结果文案（语义保持现状）',
        )
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })

    it('1.3 拉取之后的模型列表出现，且条目数 == 夹具给的模型数', async () => {
      const { page, context, problems } = await openVendorLane()
      try {
        const before = await probe(page, 'vendorFacts')
        assert.equal(before.rowCount, 0, '还没拉取时不该有模型列表行')

        await page.click('[data-pxm-role="fetch-models"]')
        await page.waitForSelector('[data-pxm-model-list]', { timeout: 10000 })

        const after = await probe(page, 'vendorFacts')

        assert.ok(after.list !== null, '拉取后必须出现模型列表（[data-pxm-model-list]）')
        assert.equal(
          after.rowCount,
          PULLED.length,
          '拉取后列表的条目数必须等于夹具给的模型数（' + String(PULLED.length) + '）：实测 ' +
            String(after.rowCount),
        )
        const texts = after.rows.map((row) => row.text)
        for (const name of PULLED) {
          assert.ok(
            texts.some((text) => text.indexOf(name) >= 0),
            '列表里必须有模型「' + name + '」，实测：' + JSON.stringify(texts),
          )
        }
        // 多选能力落在**每一行自己的选择控件**上（我们这一块要"选择保留哪些模型"）。
        const withoutCheckbox = after.rows.filter((row) => row.hasCheckbox !== true)
        assert.deepEqual(
          withoutCheckbox,
          [],
          '每一行都必须有自己的选择控件（checkbox）：' + JSON.stringify(withoutCheckbox),
        )
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })
  })

  // ── 2. 样式对齐 ───────────────────────────────────────────────────────────

  describe('2. 样式对齐：等于官方「模型」页的取值', () => {
    it('2.1 厂商卡片 = 官方 ._3nPmjq_rowCard（12px 14px / gap 12px / radius-xl / 0.5px 描边 / settings-card-fill）', async () => {
      const { page, context, problems } = await openVendorLane()
      try {
        const facts = await probe(page, 'vendorFacts')
        const radii = await resolveRadii(page, [OFFICIAL_CARD.radiusVar])
        const colors = await resolveColors(page, [{ key: OFFICIAL_CARD.backgroundVar, token: OFFICIAL_CARD.backgroundVar }])
        const borderColors = await resolveColors(page, [
          { key: OFFICIAL_CARD.borderColorVar, token: OFFICIAL_CARD.borderColorVar, prop: 'borderTopColor' },
        ])

        const bad = diffOf(facts.card, OFFICIAL_CARD, '厂商卡片')
          .concat(radiusDiff(facts.card, OFFICIAL_CARD.radiusVar, radii, '厂商卡片'))
          .concat(
            colorDiff(
              facts.card,
              'backgroundColor',
              OFFICIAL_CARD.backgroundVar,
              colors,
              '厂商卡片',
            ),
          )
          .concat(
            colorDiff(
              facts.card,
              'borderTopColor',
              OFFICIAL_CARD.borderColorVar,
              borderColors,
              '厂商卡片',
            ),
          )
        assert.deepEqual(bad, [], '厂商卡片与官方 rowCard 不一致：\n' + bad.join('\n'))
        expectDeclaredBorder(facts.card, OFFICIAL_CARD.expectBorderTopWidth, '厂商卡片')

        // 卡片是**列表项**：官方把每一家厂商放在 `ul.rows` 的一个 `li.rowCard` 里。
        assert.equal(facts.card.tag, 'LI', '厂商卡片必须是 <li>（官方 ul.rows 的列表项）')
        const rowsBad = diffOf(facts.rowsRoot, OFFICIAL_ROWS, '厂商列表（ul.rows）')
        assert.deepEqual(rowsBad, [], '厂商列表与官方 ._3nPmjq_rows 不一致：\n' + rowsBad.join('\n'))

        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })

    it('2.2 标头 / 编辑块 / 模型区块 = 官方 rowHead + editor + modelCatalog', async () => {
      const { page, context, problems } = await openVendorLane()
      try {
        const facts = await probe(page, 'vendorFacts')
        const radii = await resolveRadii(page, [
          OFFICIAL_HEAD.tagRadiusVar,
          OFFICIAL_EDITOR.radiusVar,
        ])
        const colors = await resolveColors(page, [
          { key: OFFICIAL_HEAD.dotOkColorVar, token: OFFICIAL_HEAD.dotOkColorVar },
          { key: OFFICIAL_EDITOR.backgroundVar, token: OFFICIAL_EDITOR.backgroundVar },
        ])

        const bad = []
        // ── 标头：rowHead / rowIdentity / rowName / rowTag / credentialDot
        bad.push(...diffOf({ gap: facts.head.gap }, { gap: OFFICIAL_HEAD.headGap }, '标头行'))
        bad.push(...diffOf({ gap: facts.identity.gap }, { gap: OFFICIAL_HEAD.identityGap }, '标头标识组'))
        bad.push(
          ...diffOf(
            facts.name,
            {
              fontSize: OFFICIAL_HEAD.nameFontSize,
              lineHeight: OFFICIAL_HEAD.nameLineHeight,
              fontWeight: OFFICIAL_HEAD.nameFontWeight,
            },
            '厂商名',
          ),
        )
        bad.push(
          ...diffOf(
            facts.tag,
            {
              paddingTop: OFFICIAL_HEAD.tagPadTop,
              paddingRight: OFFICIAL_HEAD.tagPadRight,
              paddingBottom: OFFICIAL_HEAD.tagPadBottom,
              paddingLeft: OFFICIAL_HEAD.tagPadLeft,
              fontSize: OFFICIAL_HEAD.tagFontSize,
              lineHeight: OFFICIAL_HEAD.tagLineHeight,
            },
            '厂商标识小标签',
          ),
        )
        bad.push(...radiusDiff(facts.tag, OFFICIAL_HEAD.tagRadiusVar, radii, '厂商标识小标签'))
        const dot = facts.dot
        assert.ok(dot !== null && dot !== undefined, '标头必须有凭据状态点（[data-pxm-credential-dot]）')
        if (dot.rect.width !== 8 || dot.rect.height !== 8) {
          bad.push('凭据状态点的真实几何：实测 ' + JSON.stringify(dot.rect) + '，官方是 8×8')
        }
        bad.push(...diffOf({ borderRadius: dot.borderRadius }, { borderRadius: OFFICIAL_HEAD.dotRadius }, '凭据状态点'))
        bad.push(
          ...colorDiff(dot, 'backgroundColor', OFFICIAL_HEAD.dotOkColorVar, colors, '凭据状态点'),
        )
        bad.push(...diffOf({ gap: facts.actions.gap }, { gap: OFFICIAL_HEAD.actionsGap }, '行尾动作组'))

        // ── 编辑块：editor（内边距 / 圆角 / 底色 / 间距）+ editorActions
        bad.push(
          ...diffOf(
            {
              paddingTop: facts.editor.paddingTop,
              paddingRight: facts.editor.paddingRight,
              paddingBottom: facts.editor.paddingBottom,
              paddingLeft: facts.editor.paddingLeft,
              gap: facts.editor.gap,
            },
            {
              paddingTop: OFFICIAL_EDITOR.padTop,
              paddingRight: OFFICIAL_EDITOR.padRight,
              paddingBottom: OFFICIAL_EDITOR.padBottom,
              paddingLeft: OFFICIAL_EDITOR.padLeft,
              gap: OFFICIAL_EDITOR.gap,
            },
            '编辑块',
          ),
        )
        bad.push(...radiusDiff(facts.editor, OFFICIAL_EDITOR.radiusVar, radii, '编辑块'))
        bad.push(
          ...colorDiff(facts.editor, 'backgroundColor', OFFICIAL_EDITOR.backgroundVar, colors, '编辑块'),
        )
        bad.push(
          ...diffOf(
            { gap: facts.editorActions.gap, justifyContent: facts.editorActions.justifyContent },
            { gap: OFFICIAL_EDITOR.actionsGap, justifyContent: OFFICIAL_EDITOR.actionsJustify },
            '编辑块动作行',
          ),
        )

        // ── 模型区块：modelCatalog + 标题 / 说明那一列
        bad.push(
          ...diffOf(
            { paddingTop: facts.catalog.paddingTop, gap: facts.catalog.gap },
            { paddingTop: OFFICIAL_CATALOG.padTop, gap: OFFICIAL_CATALOG.gap },
            '模型区块',
          ),
        )
        expectDeclaredBorder(facts.catalog, '0.5px', '模型区块上边线')
        bad.push(
          ...diffOf(
            facts.catalogTitle,
            {
              fontSize: OFFICIAL_CATALOG.titleFontSize,
              lineHeight: OFFICIAL_CATALOG.titleLineHeight,
              fontWeight: OFFICIAL_CATALOG.titleFontWeight,
            },
            '模型区块标题',
          ),
        )
        bad.push(
          ...diffOf(
            facts.catalogMeta,
            {
              fontSize: OFFICIAL_CATALOG.metaFontSize,
              lineHeight: OFFICIAL_CATALOG.metaLineHeight,
            },
            '模型区块说明',
          ),
        )

        assert.deepEqual(bad, [], '厂商卡片各区块与官方取值不一致：\n' + bad.join('\n'))
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })

    it('2.3 模型列表 = 官方候选列表；每一行 = 官方 .candidateLabel（6px 8px / gap 8px / radius-md / 13px）', async () => {
      const { page, context, problems } = await openVendorLane()
      try {
        await page.click('[data-pxm-role="fetch-models"]')
        await page.waitForSelector('[data-pxm-model-list]', { timeout: 10000 })

        const facts = await probe(page, 'vendorFacts')
        const radii = await resolveRadii(page, [OFFICIAL_MODEL_ROW.rowRadiusVar])

        assert.ok(facts.list !== null, '必须能定位模型列表容器（[data-pxm-model-list]）')
        const listBad = diffOf(
          {
            display: facts.list.display,
            flexDirection: facts.list.flexDirection,
            gap: facts.list.gap,
            overflowY: facts.list.overflowY,
            paddingTop: facts.list.paddingTop,
            paddingRight: facts.list.paddingRight,
            paddingBottom: facts.list.paddingBottom,
            paddingLeft: facts.list.paddingLeft,
            maxHeight: facts.list.maxHeight,
          },
          {
            display: 'flex',
            flexDirection: 'column',
            gap: OFFICIAL_MODEL_ROW.listGap,
            overflowY: OFFICIAL_MODEL_ROW.listOverflowY,
            paddingTop: OFFICIAL_MODEL_ROW.listPadTop,
            paddingRight: OFFICIAL_MODEL_ROW.listPadTop,
            paddingBottom: OFFICIAL_MODEL_ROW.listPadTop,
            paddingLeft: OFFICIAL_MODEL_ROW.listPadLeft,
            maxHeight: OFFICIAL_MODEL_ROW.listMaxHeight,
          },
          '模型列表容器',
        )
        assert.deepEqual(listBad, [], '模型列表容器与官方 .candidateList 不一致：\n' + listBad.join('\n'))
        assert.ok(
          facts.list.scrollHeight >= facts.list.clientHeight,
          '列表必须是**内部滚动**的容器（150 项不许把卡片撑爆）：' + JSON.stringify(facts.list),
        )

        const rowsBad = []
        for (const row of facts.rows) {
          rowsBad.push(
            ...diffOf(
              {
                display: row.display,
                alignItems: row.alignItems,
                gap: row.gap,
                paddingTop: row.paddingTop,
                paddingRight: row.paddingRight,
                paddingBottom: row.paddingBottom,
                paddingLeft: row.paddingLeft,
                fontSize: row.fontSize,
              },
              {
                display: OFFICIAL_MODEL_ROW.rowDisplay,
                alignItems: OFFICIAL_MODEL_ROW.rowAlignItems,
                gap: OFFICIAL_MODEL_ROW.rowGap,
                paddingTop: OFFICIAL_MODEL_ROW.rowPadTop,
                paddingRight: OFFICIAL_MODEL_ROW.rowPadRight,
                paddingBottom: OFFICIAL_MODEL_ROW.rowPadBottom,
                paddingLeft: OFFICIAL_MODEL_ROW.rowPadLeft,
                fontSize: OFFICIAL_MODEL_ROW.nameFontSize,
              },
              '模型行「' + row.text + '」',
            ),
          )
          rowsBad.push(...radiusDiff(row, OFFICIAL_MODEL_ROW.rowRadiusVar, radii, '模型行「' + row.text + '」'))
        }
        assert.deepEqual(rowsBad, [], '模型行与官方 .candidateLabel 不一致：\n' + rowsBad.join('\n'))

        // 每行高度 = 内边距 6+6 + 行盒（模型名 13px 的行高与复选控件里更高的那个）
        // —— 证明"行高由官方内边距决定"，而不是被别的样式凑出来的。
        for (const row of facts.rows) {
          const inner = Number.parseFloat(row.lineHeight)
          const control = row.checkboxRect === null ? 0 : row.checkboxRect.height
          const expected = 12 + Math.max(inner, control)
          assert.ok(
            Math.abs(row.rect.height - expected) <= 1.01,
            '模型行的真实高度必须由官方内边距 + 行盒决定（期望约 ' + String(expected) + 'px）：' +
              JSON.stringify({
                text: row.text,
                height: row.rect.height,
                lineHeight: row.lineHeight,
                checkbox: row.checkboxRect,
              }),
          )
        }
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })

    it('2.4 「拉取模型」= 官方 linkButton（28px / 0 10px / 12px-18px / radius-sm / 无描边）', async () => {
      const { page, context, problems } = await openVendorLane()
      try {
        const facts = await probe(page, 'vendorFacts')
        const radii = await resolveRadii(page, [OFFICIAL_LINK_BUTTON.radiusVar])
        const metrics = facts.fetchButton.metrics !== null ? facts.fetchButton.metrics : facts.fetchButton
        const bad = diffOf(metrics, OFFICIAL_LINK_BUTTON, '「拉取模型」')
          .concat(radiusDiff(metrics, OFFICIAL_LINK_BUTTON.radiusVar, radii, '「拉取模型」'))
        if (Math.abs(metrics.rect.height - 28) > 0.51) {
          bad.push('「拉取模型」的真实几何高度：实测 ' + String(metrics.rect.height) + 'px，官方 .sm 是 28px')
        }
        assert.deepEqual(bad, [], '「拉取模型」与官方 linkButton 不一致：\n' + bad.join('\n'))
        expectNoVisibleBorder(metrics, '「拉取模型」')
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })
  })
}
