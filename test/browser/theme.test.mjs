/**
 * 真实浏览器 lane 的**主题 token** 一侧：证明 PixMart 客户端的配色**真的**走
 * DSH 官方主题变量（`--dsw-*`），而不是"颜色碰巧长得像"。
 *
 * ## 它补的是静态扫描的哪一块空白
 *
 * `test/client-tokens.test.mjs` 只看源码：没有硬编码 hex、没有系统色关键字、确实写了
 * `var(--dsw-…)`。但"写了 `var(--dsw-…)`"和"浏览器把它解析成了主题色"是两件事——token
 * 名字拼错、变量没被任何主题定义、或者某个父级把 `color` 覆盖掉，静态扫描全都看不出来
 * （拼错的 token 只会**退化**成继承色，不会报错，这正是官方说的
 * "a renamed token degrades appearance but never breaks rendering"）。
 *
 * 所以这里按**计算样式**断言（`getComputedStyle`，不是 `element.style` 的内联字符串）：
 *   - 元素某个属性的计算值 == 该 token 在当前页面里的**解析值**。解析值由浏览器现场算
 *     （`__pxmLane.resolveCss`，且按**目标属性本身**解析），不是测试自己把 hex 换算成 rgb：
 *     两边用同一个解析器，比较才有意义；
 *   - 把同一批 token 换成**官方深色值**（`shell.html` 里声明的是浅色值），同一批元素的颜色
 *     必须**跟着变**，且仍然等于新的解析值。
 *
 * 第二条是"能与官方深浅色主题一致"的硬证据：只断言浅色下相等，可能是硬编码巧合同色
 * （`--dsw-alias-state-success-primary` 的官方浅色就是 `#22c55e`，与历史硬编码一模一样）；
 * 换一组 token 之后还相等，才排除掉"碰巧"。
 *
 * ## 为什么分「列表态」与「详情/查看器态」两组
 *
 * `.pxm-tile` 只在点开项目**之前**存在（点开后面板内容换成项目详情），
 * `.pxm-item-error` / `.pxm-copy-btn` / `.pxm-viewer` 只在点开之后存在。所以两组各自在
 * **同一个页面里**完成「浅色量一遍 → 换深色 token → 再量一遍」：光源是唯一变量。
 *
 * ## 判据里刻意避开的坑
 *
 * 官方 token 里 `state-success-primary` / `state-warn-primary` 的**浅色与深色取值相同**，
 * 所以它们**不能**用来证明"跟随主题"。用来证明跟随主题的全是浅/深确实不同的 token
 * （bg / border / label / error / idle）——8.5 用例专门把这件事钉住。
 *
 * 另一处语义锚点是 8.7：官方 `StateDot` 的 `ongoing` 用 `--dsw-alias-label-tertiary`
 * （`StateDot.module.css` 的 `.spinner`），而 `--dsw-alias-brand-primary` 是**主按钮填充**
 * （浅色近黑）。所以"进行中/进度"三处必须量到 tertiary 的解析值，且深浅跟着变。
 *
 * ## 运行
 *
 *   pnpm test:browser        # 用系统 Edge，其次 Chrome；不下载浏览器
 *
 * 前置与跳过纪律同 `layout.test.mjs`：没有可用浏览器时**不假装通过**，打印醒目 SKIP 横幅
 * 并以非零码结束（除非显式 `PXM_LANE_ALLOW_SKIP=1`）。
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  artifactSha256,
  launchLaneBrowser,
  startLaneServer,
} from './lane-server.mjs'

// ── token 清单与两套取值 ────────────────────────────────────────────────────

/** 插件用到的那份官方 token 清单（与 `client/client.js` 的 `T`、静态用例里的清单同源）。 */
const TOKENS = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-module-platform',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l4',
  '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
]

/**
 * 官方**浅色**取值：必须与 `shell.html` 的 `:root` 逐字一致（8.0 有专门一条用例守着）。
 * 来源 = `@deepseek-ai/dsh-client-ui-theme` 里 `body{…}` 那一段，经 `--dsw-static-*` 逐层解析。
 *
 * `bg-layer-3` / `bg-module-platform` 是**表面映射对照物**（8.5 / 8.8 用）：它们证明
 * "面板底色挂的是 layer-1、官方内容表面挂的是 layer-2"——两者**在深色下色值不同**
 * （#232324 vs #2c2c2e），所以"换成另一个"能被断言抓到，而不是靠同名巧合。
 */
const LIGHT = {
  '--dsw-alias-bg-base': '#fff',
  '--dsw-alias-bg-layer-1': '#fff',
  '--dsw-alias-bg-layer-2': '#fff',
  '--dsw-alias-bg-layer-3': '#fff',
  '--dsw-alias-bg-module-platform': '#f5f6f7',
  '--dsw-alias-bg-overlay': '#e9ecf2',
  '--dsw-alias-border-l1': '#0000000a',
  '--dsw-alias-border-l2': '#0000001a',
  '--dsw-alias-border-l4': '#00000029',
  '--dsw-alias-brand-primary': '#0f1115',
  '--dsw-alias-label-primary': '#0f1115',
  '--dsw-alias-label-secondary': '#61666b',
  '--dsw-alias-label-tertiary': '#81858c',
  '--dsw-alias-state-error-primary': '#ec1313',
  '--dsw-alias-state-idle-primary': '#d4d4d4',
  '--dsw-alias-state-success-primary': '#22c55e',
  '--dsw-alias-state-warn-primary': '#f59e0b',
}

/**
 * 官方**深色**取值（同上，来源 = `body[data-ds-dark-theme]{…}`）。
 *
 * 注意 `state-success-primary` / `state-warn-primary` 两项与浅色**完全相同**——这不是笔误，
 * 是官方主题本来的取值；它们因此不能作为"跟随主题"的证据。
 */
const DARK = {
  '--dsw-alias-bg-base': '#151517',
  '--dsw-alias-bg-layer-1': '#232324',
  '--dsw-alias-bg-layer-2': '#2c2c2e',
  '--dsw-alias-bg-layer-3': '#353638',
  '--dsw-alias-bg-module-platform': '#353638',
  '--dsw-alias-bg-overlay': '#61666b',
  '--dsw-alias-border-l1': '#ffffff0f',
  '--dsw-alias-border-l2': '#ffffff1f',
  '--dsw-alias-border-l3': '#ffffff29',
  '--dsw-alias-border-l4': '#fff3',
  '--dsw-alias-brand-primary': '#f9fafb',
  /*
   * 官方主按钮（「保存」）的两枚。`button-primary-fill` 是 `brand-primary` 的别名，
   * 所以深色下随它变成 `#f9fafb`；前景色官方是 `bluish-1000` = `#0f1115`
   * —— 两枚一起换才说明"按钮随主题走"，只换 fill 会留下看不清的浅字。
   */
  '--dsw-alias-button-primary-fill': '#f9fafb',
  '--dsw-alias-label-primary-foreground': '#0f1115',
  '--dsw-alias-label-primary': '#f9fafb',
  '--dsw-alias-label-secondary': '#cfd3d6',
  '--dsw-alias-label-tertiary': '#adb2b8',
  '--dsw-alias-state-error-primary': '#f25a5a',
  '--dsw-alias-state-idle-primary': '#545557',
  '--dsw-alias-state-success-primary': '#22c55e',
  '--dsw-alias-state-warn-primary': '#f59e0b',
}

/** 官方浅/深同色的 token：不能用来证明"跟随主题"。 */
const THEME_INVARIANT = ['--dsw-alias-state-success-primary', '--dsw-alias-state-warn-primary']

/**
 * 被断言的「元素 × 属性 × 它应该挂哪个 token 表达式」。
 *
 * `expect` 一律用 token 写、`prop` 是**目标属性本身**，交给浏览器现场解析——这就是
 * "真的挂在这个 token 上"的判据。`state` 决定它在哪一态量（见文件头）。
 */
const TARGETS = [
  {
    key: 'panel.background',
    state: 'list',
    selector: '.pxm-workbench',
    prop: 'backgroundColor',
    expect: 'var(--dsw-alias-bg-layer-1)',
  },
  {
    key: 'panel.color',
    state: 'list',
    selector: '.pxm-workbench',
    prop: 'color',
    expect: 'var(--dsw-alias-label-primary)',
  },
  {
    key: 'tile.background',
    state: 'list',
    selector: '.pxm-tile',
    prop: 'backgroundColor',
    expect: 'var(--dsw-alias-bg-layer-2)',
  },
  {
    key: 'tile.border',
    state: 'list',
    selector: '.pxm-tile',
    prop: 'borderTopColor',
    expect: 'var(--dsw-alias-border-l1)',
  },
  {
    key: 'button.border',
    state: 'detail',
    selector: '.pxm-copy-btn',
    prop: 'borderTopColor',
    expect: 'var(--dsw-alias-border-l2)',
  },
  {
    key: 'button.color',
    state: 'detail',
    selector: '.pxm-copy-btn',
    prop: 'color',
    expect: 'var(--dsw-alias-label-primary)',
  },
  {
    key: 'button.background',
    state: 'detail',
    selector: '.pxm-copy-btn',
    prop: 'backgroundColor',
    expect: 'color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)',
  },
  {
    key: 'error.color',
    state: 'detail',
    selector: '.pxm-item-error',
    prop: 'color',
    expect: 'var(--dsw-alias-state-error-primary)',
  },
  {
    key: 'viewer.background',
    state: 'detail',
    selector: '.pxm-viewer',
    prop: 'backgroundColor',
    expect: 'color-mix(in srgb, var(--dsw-alias-bg-overlay) 92%, transparent)',
  },
]

const LIST_TARGETS = TARGETS.filter((target) => target.state === 'list')
const DETAIL_TARGETS = TARGETS.filter((target) => target.state === 'detail')

/**
 * 「进行中 / 进度」那几处（8.7），全部在 `.pxm-card`（运行中自动展开的预览卡）里：
 *   - `.pxm-chip-running`：那一格**正在跑**，边框走状态色 `COLORS.run`；
 *   - `.pxm-chip-running .pxm-ring`：它的进度环（`Colors.run` + 18% 半透明轨道）。
 *
 * 两处都应挂 `--dsw-alias-label-tertiary`——官方 `StateDot` 的 `ongoing` 用的就是它
 * （`StateDot.module.css` 的 `.spinner{color:var(--dsw-alias-label-tertiary)}`）。
 * 早先版本误用了 `--dsw-alias-brand-primary`（**主按钮填充**，浅色 #0f1115 近黑），
 * 浅色主题下那一格会呈现近黑色边框，看起来像一枚按钮而不是"正在跑"。
 *
 * **预览卡头部那枚 36px 的 `ProgressRing` 不在这里**：它只画「已完成（success）/
 * 失败（error）/ 剩余槽（idle）」三段，本来就没有"进行中"这一段要上色（已逐处核对过
 * `brand-primary` 的用法：只有状态色映射与选中描边/focus ring 三处，前者与这里的缩略图
 * 边框、进度环是同一处 `COLORS.run`）。
 */
const OVERLAY_TARGETS = [
  {
    key: 'chip.running.border',
    selector: '.pxm-chip-running',
    prop: 'borderTopColor',
    expect: 'var(--dsw-alias-label-tertiary)',
  },
  {
    key: 'chip.running.ringColor',
    selector: '.pxm-chip-running .pxm-ring',
    prop: 'backgroundImage',
    expect: 'conic-gradient(var(--dsw-alias-label-tertiary) 0deg 120deg, color-mix(in srgb, var(--dsw-alias-label-tertiary) 18%, transparent) 120deg 360deg)',
  },
]

/** 历史硬编码值里最典型的一个：改造前的失败文字 `#ef4444`。留着做"不是碰巧同色"的反证。 */
const LEGACY_ERROR_COLOR = 'rgb(239, 68, 68)'

// ── 夹具 ────────────────────────────────────────────────────────────────────

const PROJECT_ID = '2026-10-05-主题对齐'
const CREATED_AT = Date.UTC(2026, 9, 5, 12, 0, 0)
const FAILED_REASON = '模型返回 400：内容策略拒绝（policy）'

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
    prompt:
      'matte ceramic mug on a seamless white background, soft studio light, catalog quality — ' +
      String(index),
    model: 'gpt-image-1',
    ms: 12345,
    createdAt: CREATED_AT,
    degraded: [],
    ...over,
  }
}

/**
 * 夹具里**必须**有一条失败项：`.pxm-item-error` 只在 `item.error` 是非空字符串时才渲染，
 * 没有它，"失败文字走 error token"这条断言就是空转。
 */
function detailFixture() {
  return {
    ok: true,
    project: {
      id: PROJECT_ID,
      name: '主题对齐',
      createdAt: CREATED_AT,
      provider: 'ofox',
      model: 'gpt-image-1',
      items: [itemFixture(0), itemFixture(1, { status: 'failed', error: FAILED_REASON })],
    },
  }
}

function projectsFixture(n = 4) {
  const out = []
  for (let i = 1; i <= n; i += 1) {
    const id = 'P' + String(i).padStart(2, '0')
    out.push({
      id,
      name: 'Project-' + String(i).padStart(2, '0'),
      createdAt: CREATED_AT + i * 60000,
      provider: 'ofox',
      model: 'gpt-image-1',
      imageCount: 2,
      cover: id + '/images/cover.png',
    })
  }
  return out
}

/**
 * 8.7 用的运行夹具：一条**正在跑**的运行，`items` 里恰好一条 `status:'running'`
 * （那枚缩略图才会渲染 `.pxm-chip-running` 与它的进度环），另一条已完成。
 *
 * `startedAt` 必须**晚于本页面的挂载基线**，预览卡才会自动展开（§8.5.5）——
 * 而基线是 `client.js` 求值那一刻、由 Node 侧夹具无法预知的时刻，所以这里取一个
 * 明确的将来时刻（`Date.now() + 60s`）：它一定晚于基线。这不是"伪造数据"，
 * 只是把「本页面加载之后才开始的运行」这一态确定下来；另外几个时间字段与它保持一致。
 */
function runningFixture() {
  const now = Date.now()
  const startedAt = now + 60000
  const run = {
    runId: 'run-theme',
    sessionId: 'sess-theme',
    tool: 'batch',
    provider: 'ofox',
    model: 'gpt-image-1',
    size: '1:1',
    status: 'running',
    total: 2,
    completed: 1,
    failed: 0,
    currentLabel: '白底主图',
    projectId: PROJECT_ID,
    projectName: '主题对齐',
    startedAt,
    updatedAt: startedAt,
    items: [
      {
        index: 0,
        module: 'main.white-bg',
        label: '白底主图',
        status: 'done',
        file: 'images/0.png',
        width: 1024,
        height: 1024,
      },
      { index: 1, module: 'detail.hero', label: '详情首屏', status: 'running' },
    ],
  }
  const { items, ...summary } = run
  // 列表摘要与详情必须**同一份时间戳**：服务端采纳的是摘要（`startedAt` 决定自动展开），
  // 两份不一致时 8.7 会测到"卡片没展开"。
  return { run, summary }
}

function providersFixture() {
  return {
    ok: true,
    dataDir: 'D:/pixmart',
    exportDir: 'D:/PixMartExport',
    defaults: { provider: 'ofox', model: 'gpt-image-1', size: '1:1', n: 1 },
    usage: { requests: 1, ok: 1, failed: 0, images: 2 },
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
  }
}

const fixture = (over = {}) => ({
  projects: projectsFixture(),
  detail: detailFixture(),
  runs: [],
  providers: providersFixture(),
  ...over,
})

// ── lane 启动 ───────────────────────────────────────────────────────────────

const server = await startLaneServer()
const launched = await launchLaneBrowser()
const ALLOW_SKIP = process.env.PXM_LANE_ALLOW_SKIP === '1'

const SKIP_BANNER = [
  '',
  '='.repeat(78),
  '  ⚠  浏览器 lane 已跳过 → 客户端配色**没有**在真排版引擎里验证过',
  '  ⚠  原因：本机没有可用的 Microsoft Edge / Google Chrome（playwright-core 不下载浏览器）',
  '     尝试过的 channel：' + (launched.failures.length === 0 ? '（无）' : launched.failures.join(' | ')),
  '  ⚠  修法：装 Edge/Chrome 后重跑；确实要在无浏览器机器上放行，用 PXM_LANE_ALLOW_SKIP=1',
  '='.repeat(78),
  '',
].join('\n')

if (launched.browser === null) {
  console.error(SKIP_BANNER)
  if (ALLOW_SKIP) {
    describe('浏览器 lane 前置（主题）', () => {
      it('SKIP：没有可用浏览器 → 配色未经验证', (t) => {
        t.skip('没有可用的 Edge/Chrome（PXM_LANE_ALLOW_SKIP=1 已显式放行）')
      })
    })
  } else {
    describe('浏览器 lane 前置（主题）', () => {
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

  /** 单参探针。 */
  const probe = (page, name, arg = null) =>
    page.evaluate(([fn, value]) => window.__pxmLane[fn](value), [name, arg])

  /** 多参探针（lane 的探针签名是位置参数，这里按数组展开）。 */
  const probeArgs = (page, name, args) =>
    page.evaluate(([fn, list]) => window.__pxmLane[fn].apply(null, list), [name, args])

  /**
   * 开一个主题 lane：真实 HTTP 源 + 真实 shell 骨架 + 真 React UMD + 原产物 client.js。
   *
   * `options` 可以指定 `width` / `height`（宽屏用例需要）、`data`（夹具覆盖）与
   * `mountSlot`（`main` / `shell.overlay` / `settings.section`）。
   */
  async function openThemedLane(options = {}) {
    const data = options.data ?? fixture()
    const mountSlot = options.mountSlot ?? 'main'
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
    await page.evaluate((payload) => window.__pxmLane.install(payload), data)
    await page.evaluate((slot) => window.__pxmLane.mount(slot), mountSlot)
    return { page, context, problems }
  }

  /**
   * 起一个带**在跑的运行**的页面，并把 `shell.overlay` 实时预览卡挂上。
   *
   * 8.7 的那两个元素（`.pxm-chip-running` 与它的进度环）只在
   * 「运行中 → 卡片自动展开」这一态里存在，所以这里必须先等到 `.pxm-chip-running`
   * 真的出现，再开始量——否则量到的是 `null`，断言会以"元素缺失"报错而不是静默通过。
   */
  async function openOverlayLane() {
    const { run, summary } = runningFixture()
    const { page, context, problems } = await openThemedLane({
      data: fixture({ runs: [summary], runDetail: run }),
    })
    await page.evaluate((slot) => window.__pxmLane.mount(slot), 'shell.overlay')
    await page.waitForSelector('.pxm-chip-running', { timeout: 15000 })
    assert.ok(
      (await page.$('.pxm-card')) !== null,
      '运行中必须展开预览卡（否则量到的不是卡片里的缩略图）',
    )
    assert.ok(
      (await page.$('.pxm-chip-running .pxm-ring')) !== null,
      '运行中的缩略图必须带进度环（否则那条"进度环颜色"的断言是空转）',
    )
    return { page, context, problems }
  }

  /** 量一组目标元素的**计算样式**；元素缺失记 null（由断言报出来，不静默跳过）。 */
  async function readComputed(page, targets) {
    const out = {}
    for (const target of targets) {
      const values = await probeArgs(page, 'computed', [target.selector, [target.prop]])
      out[target.key] = values === null ? null : values[target.prop]
    }
    return out
  }

  /** 让浏览器把每条 `expect` 按**目标属性**、按**当前** token 现场解析一遍。 */
  async function resolveExpectations(page, targets) {
    return probe(
      page,
      'resolveCss',
      targets.map((target) => ({ key: target.key, prop: target.prop, value: target.expect })),
    )
  }

  /** 一次「浅 → 深」对照测量的完整结果。 */
  async function measureBothThemes(page, targets) {
    const lightVars = await probe(page, 'tokenVar', TOKENS)
    const lightComputed = await readComputed(page, targets)
    const lightResolved = await resolveExpectations(page, targets)

    const darkVars = await probe(page, 'setTokens', DARK)
    // 等一帧，确保新的自定义属性已经作用到计算样式上。
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))

    const darkComputed = await readComputed(page, targets)
    const darkResolved = await resolveExpectations(page, targets)
    return { lightVars, lightComputed, lightResolved, darkVars, darkComputed, darkResolved }
  }

  /** 「光源真的换了」：:root 上的声明值必须整批变成深色那一份。 */
  function assertThemeSwitched(lightVars, darkVars) {
    for (const token of TOKENS) {
      assert.equal(darkVars[token], DARK[token], '换 token 失败：' + token)
      if (THEME_INVARIANT.indexOf(token) >= 0) {
        assert.equal(lightVars[token], darkVars[token], token + ' 官方浅深同色')
      } else {
        assert.notEqual(lightVars[token], darkVars[token], token + ' 的声明值没有变')
      }
    }
  }

  /** 浅色：每个目标的计算样式 == 它挂的 token 的解析值。 */
  function assertLightMatches(m, targets) {
    const bad = targets
      .filter((target) => m.lightComputed[target.key] !== m.lightResolved[target.key])
      .map((target) => ({
        key: target.key,
        selector: target.selector,
        prop: target.prop,
        computed: m.lightComputed[target.key],
        tokenResolvesTo: m.lightResolved[target.key],
        expect: target.expect,
      }))
    assert.deepEqual(
      bad,
      [],
      '这些元素的颜色不是它挂的那个 token 的解析值（var(...) 没生效，或 token 名字写错了）',
    )
  }

  /** 深色：颜色必须**跟着变**，且等于新的解析值。 */
  function assertFollowedTheme(m, targets) {
    const unchanged = targets
      .filter((target) => m.darkComputed[target.key] === m.lightComputed[target.key])
      .map((target) => ({ key: target.key, value: m.lightComputed[target.key], expect: target.expect }))
    assert.deepEqual(
      unchanged,
      [],
      '这些元素在深色 token 下颜色没变 —— 说明它其实没挂在 token 上（或挂了同色 token）',
    )

    const mismatched = targets
      .filter((target) => m.darkComputed[target.key] !== m.darkResolved[target.key])
      .map((target) => ({
        key: target.key,
        computed: m.darkComputed[target.key],
        tokenResolvesTo: m.darkResolved[target.key],
      }))
    assert.deepEqual(mismatched, [], '深色下计算样式不等于深色 token 的解析值')

    const sameResolution = targets
      .filter((target) => m.lightResolved[target.key] === m.darkResolved[target.key])
      .map((target) => target.key)
    assert.deepEqual(sameResolution, [], '这些 token 表达式在深浅两套值下解析结果相同（证据无效）')
  }

  // ── 8.0 token 表自证 ─────────────────────────────────────────────────────

  describe('8.0 token 表自证：shell 骨架发布的确实是官方 token 与浅色取值', () => {
    it('16 个 --dsw-* 都能在 :root 上读到，且等于官方浅色取值', async () => {
      const { page, context, problems } = await openThemedLane()
      try {
        const declared = await probe(page, 'tokenVar', TOKENS)
        for (const token of TOKENS) {
          assert.equal(
            declared[token],
            LIGHT[token],
            'shell 骨架里的 ' + token + ' 必须等于官方浅色值（否则后面的比对全无意义）',
          )
        }
        assertThemeSwitched(declared, DARK)
        assert.deepEqual(problems, [], '页面不该有 console.error / 未捕获异常')
      } finally {
        await context.close()
      }
    })
  })

  // ── 8.1 / 8.2 列表态 ─────────────────────────────────────────────────────

  describe('8.1 列表态：浅色下计算样式 == 对应 --dsw-* 的解析值', () => {
    it('8.1 列表态：面板底色 / 主文字 / 卡片底色 / 卡片边框逐个等于 token 解析值', async () => {
      const { page, context, problems } = await openThemedLane()
      try {
        await page.waitForSelector('.pxm-tile')
        const m = await measureBothThemes(page, LIST_TARGETS)

        assertThemeSwitched(m.lightVars, m.darkVars)
        assertLightMatches(m, LIST_TARGETS)
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })
  })

  describe('8.2 列表态：换成官方深色 token 后同一批元素跟着变', () => {
    it('8.2 列表态：换成官方深色 token → 这几个颜色逐个跟着变', async () => {
      const { page, context, problems } = await openThemedLane()
      try {
        await page.waitForSelector('.pxm-tile')
        const m = await measureBothThemes(page, LIST_TARGETS)

        assertThemeSwitched(m.lightVars, m.darkVars)
        assertFollowedTheme(m, LIST_TARGETS)
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })
  })

  // ── 8.3 / 8.4 详情 / 查看器态 ────────────────────────────────────────────

  /**
   * 走完整条链：项目卡片 → 详情（失败项 + 复制按钮）→ 打开查看器（浮层）。
   *
   * `.pxm-item-error` 只在 `item.error` 是非空字符串时渲染，`.pxm-viewer` 只在查看器打开时
   * 存在，所以这里必须真的把查看器点开——否则那两条断言是空转。
   */
  async function walkToViewer(page) {
    await page.waitForSelector('.pxm-tile')
    await page.click('.pxm-tile')
    await page.waitForSelector('.pxm-item-error')
    await page.waitForSelector('.pxm-copy-btn')

    // 点一张**当前完全可见**的缩略图：用鼠标坐标点，避免 Playwright 自动滚动改变几何。
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
    await page.waitForTimeout(250) // 等入场动画（.16s）结束
  }

  describe('8.3 详情/查看器态：浅色下计算样式 == 对应 --dsw-* 的解析值', () => {
    it('8.3 详情/查看器态：控件边框与填充 / 失败状态色 / 浮层底色逐个等于 token 解析值', async () => {
      const { page, context, problems } = await openThemedLane()
      try {
        await walkToViewer(page)
        const m = await measureBothThemes(page, DETAIL_TARGETS)

        assertThemeSwitched(m.lightVars, m.darkVars)
        assertLightMatches(m, DETAIL_TARGETS)

        // "不是碰巧合"的反证：失败文字的浅色取值必须**不等于**历史硬编码 #ef4444。
        assert.equal(
          m.lightResolved['error.color'],
          'rgb(236, 19, 19)',
          'error token 的浅色解析值应当就是官方 #ec1313（rgb(236,19,19)）',
        )
        assert.notEqual(
          m.lightComputed['error.color'],
          LEGACY_ERROR_COLOR,
          '失败文字若等于历史硬编码色，这条断言就退回成"碰巧同色"，证明不了走的是 token',
        )
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })
  })

  describe('8.4 详情/查看器态：换成官方深色 token 后同一批元素跟着变', () => {
    it('8.4 详情/查看器态：换成官方深色 token → 这几个颜色逐个跟着变', async () => {
      const { page, context, problems } = await openThemedLane()
      try {
        await walkToViewer(page)
        const m = await measureBothThemes(page, DETAIL_TARGETS)

        assertThemeSwitched(m.lightVars, m.darkVars)
        assertFollowedTheme(m, DETAIL_TARGETS)
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })
  })

  // ── 8.5 哪些 token 不能当"跟随主题"的证据 ────────────────────────────────

  describe('8.5 官方 token 里浅/深同色的那几个：记录清楚，免得被当成跟随主题的证据', () => {
    it('8.5 success / warn 浅深同色；bg / border / label / error / idle / tertiary 确实不同色', async () => {
      const { page, context, problems } = await openThemedLane()
      try {
        const items = TOKENS.map((token) => ({ key: token, prop: 'color', value: 'var(' + token + ')' }))
        const light = await probe(page, 'resolveCss', items)
        await probe(page, 'setTokens', DARK)
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))
        const dark = await probe(page, 'resolveCss', items)

        for (const token of THEME_INVARIANT) {
          assert.equal(
            light[token],
            dark[token],
            token + ' 官方浅深同色（' + light[token] + '）：它不能作为"跟随主题"的证据',
          )
        }
        for (const token of [
          '--dsw-alias-bg-layer-1',
          '--dsw-alias-bg-layer-2',
          '--dsw-alias-bg-layer-3',
          '--dsw-alias-border-l2',
          '--dsw-alias-label-secondary',
          // 「进行中/进度」挂的就是它：浅 #81858c / 深 #adb2b8 确实不同，
          // 因此它**可以**作为"跟随主题"的证据（8.7 正是在用它）。
          '--dsw-alias-label-tertiary',
          '--dsw-alias-state-error-primary',
          '--dsw-alias-state-idle-primary',
          '--dsw-alias-brand-primary',
        ]) {
          assert.notEqual(light[token], dark[token], token + ' 的浅深解析值应当不同')
        }

        /*
         * 表面映射的**可区分性**：深色下这四个表面必须两两不同色。
         *
         * 这条不是凑数——它是 8.8 成立的前提：如果 `bg-base` / `bg-layer-1` /
         * `bg-layer-2` 解析成同一个颜色，"面板底色挂错了一层"就**抓不出来**
         * （浅色下三者都是 #fff，正是这种情形，所以 8.8 必须两套主题都量）。
         */
        const surfaces = ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2']
        for (let i = 0; i < surfaces.length; i += 1) {
          for (let j = i + 1; j < surfaces.length; j += 1) {
            assert.notEqual(
              dark[surfaces[i]],
              dark[surfaces[j]],
              '深色下 ' + surfaces[i] + ' 与 ' + surfaces[j] + ' 必须不同色（否则"挂错一层"抓不出来）',
            )
          }
        }
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })
  })

  // ── 8.6 自证：lane 加载的是仓库原产物 ─────────────────────────────────────

  describe('8.6 lane 自证（主题侧）：加载的是仓库原产物 client.js', () => {
    it('8.6 sha256 一致，且主题探针可用', async () => {
      const { page, context } = await openThemedLane()
      try {
        assert.ok(server.served.clientRequests >= 1, '浏览器必须真的请求过 /client/client.js')
        assert.equal(server.served.clientSha256, artifact, 'lane 服务的必须是仓库原产物，逐字节一致')
        for (const name of ['computed', 'resolveCss', 'tokenVar', 'setTokens', 'officialSurfaces']) {
          assert.equal(
            await page.evaluate((fn) => typeof window.__pxmLane[fn], name),
            'function',
            '主题探针 ' + name + ' 必须存在',
          )
        }
      } finally {
        await context.close()
      }
    })
  })

  // ── 8.7 「进行中 / 进度」的语义色 ─────────────────────────────────────────

  describe('8.7 运行中的预览卡：进度相关的颜色挂 label-tertiary，而不是主按钮填充 brand-primary', () => {
    it('8.7 运行中缩略图的边框与它的进度环：浅色等于 tertiary 解析值，深色跟着变', async () => {
      const { page, context, problems } = await openOverlayLane()
      try {
        const m = await measureBothThemes(page, OVERLAY_TARGETS)

        assertThemeSwitched(m.lightVars, m.darkVars)
        assertLightMatches(m, OVERLAY_TARGETS)
        assertFollowedTheme(m, OVERLAY_TARGETS)

        // 反证：这两处若退回**主按钮填充色** brand-primary，浅色下会是近黑 #0f1115。
        // 逐个断言它们**不**等于"同样的表达式、但把 token 换成 brand"的解析值 ——
        // 表达式逐字对齐（含 color-mix 轨道与角度），否则比的是两种不同的序列化，
        // 断言会因为"字符串本来就不同"而恒真，等于没测。
        const asBrand = (expect) =>
          expect.replace(/var\(--dsw-alias-label-tertiary\)/g, 'var(--dsw-alias-brand-primary)')
        const brandResolved = await resolveExpectations(
          page,
          OVERLAY_TARGETS.map((target) => ({
            key: target.key,
            prop: target.prop,
            expect: asBrand(target.expect),
          })),
        )
        for (const target of OVERLAY_TARGETS) {
          assert.notEqual(
            m.lightComputed[target.key],
            brandResolved[target.key],
            '这处进度色等于 brand-primary（主按钮填充色，浅色近黑）——那是被修掉的缺陷形态：' +
              target.key,
          )
        }
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })
  })

  // ── 8.8 表面映射：挂的是哪一层，必须与官方同语义表面对齐 ──────────────────

  /**
   * 「官方对应物 → 我们对应物」的逐个对照（每个都在 asar 里核过原文）：
   *
   * | 位置 | 官方 | 我们 |
   * |---|---|---|
   * | 应用/窗口底 | `AppFrame.frame`、`body`、`schedule.S0jZwq_page` → `bg-base` | `body`（shell 提供） |
   * | `main` 槽里的面板 | `chat` turn-preview、`deliverables` 卡片 → `bg-layer-1` | `.pxm-workbench` ← **本用例钉住** |
   * | 设置页内容表面 | `settings-general` 的 `.wCInkW_options` **不画表面**（继承弹窗的 `bg-layer-2`） | `.pxm-settings` ← **本用例钉住** |
   * | 设置卡片 | `--dsw-alias-settings-card-fill` = `bg-layer-2` | `skin.card` |
   * | 输入控件 | `fields.module.css` 的 `.input` → `bg-layer-3` | （见交付回报：仍为 `bg-base`，未改） |
   *
   * 判据分两层：
   *   1. **语义层**：`.pxm-settings` 的背景色必须等于官方"弹窗面板那一层"（`bg-layer-2`）
   *      的解析值。浅色下三个 bg token 都是 #fff，**只有深色能区分**，所以两套都量。
   *   2. **反证层**：它必须**不等于**应用底色 `bg-base` 的解析值 —— 这正是被修掉的缺陷形态
   *      （深色 #151517 比官方面板 #2c2c2e 更暗，用户看到的就是"纯黑"）。
   *
   * 附带一条"官方三个表面在深色下两两不同色"的前提断言：没有它，
   * "挂错一层"在数值上就无法与"挂对了"区分开。
   */
  describe('8.8 表面映射：设置页 section 的表面色 == 官方弹窗面板那一层，且不是应用底色', () => {
    it('8.8 `.pxm-settings` 的表面 == 官方弹窗面板那一层（bg-layer-2），且不是应用底色 bg-base', async () => {
      const { page, context, problems } = await openThemedLane({ mountSlot: 'settings.section' })
      try {
        await page.waitForSelector('.pxm-settings', { timeout: 15000 })

        const surfaces = [
          '--dsw-alias-bg-base',
          '--dsw-alias-bg-layer-1',
          '--dsw-alias-bg-layer-2',
          '--dsw-alias-bg-layer-3',
        ]

        /**
         * 在浏览器里量一次（两套主题各一次）。
         *
         * `backgroundColor` 拿的是**真实盒子**的值——它可能是 `rgba(0,0,0,0)`，
         * 那正是我们要的形态：官方 `.wCInkW_options` 也不画自己的表面，继承弹窗面板。
         * 所以判定不能只看它，还要用同一个 token 表达式在**同一套主题下**解析出一个
         * 不透明的比色值（`resolveCss` 里给 `<span>` 加 1px 边框 + `borderTopColor`，
         * 浏览器返回 `rgb(r,g,b)` 而不是 `color(srgb …)`）。
         */
        const readOnce = () =>
          page.evaluate((tokenNames) => {
            const nodes = document.querySelectorAll('.pxm-settings')
            const section = nodes[nodes.length - 1]
            if (section === undefined) return null
            const style = window.getComputedStyle(section)
            const items = tokenNames.map((name) => ({
              key: name,
              prop: 'borderTopColor',
              value: 'var(' + name + ')',
            }))
            return {
              count: nodes.length,
              sectionBg: style.backgroundColor,
              official: window.__pxmLane.resolveCss(items),
            }
          }, surfaces)

        const rgbParts = (value) => {
          const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(String(value))
          if (m === null) return null
          if (m[4] !== undefined && Number(m[4]) !== 1) return null
          return [Number(m[1]), Number(m[2]), Number(m[3])]
        }
        const nearest = (value, candidates) => {
          const a = rgbParts(value)
          if (a === null) return { key: null, distance: Number.POSITIVE_INFINITY }
          let best = { key: null, distance: Number.POSITIVE_INFINITY }
          for (const key of Object.keys(candidates)) {
            const b = rgbParts(candidates[key])
            if (b === null) continue
            const distance = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
            if (distance < best.distance) best = { key, distance }
          }
          return best
        }

        /**
         * @param expectDistinct 官方各表面在这一套主题下是否两两不同色。
         *   浅色下官方 bg-base / layer-1 / layer-2 **就是同一个 #fff**（在 asar 里核过取值），
         *   所以"挂错一层"只有深色能区分——深色那一次才断定"等于哪一层"。
         */
        const check = (reading, label, expectDistinct) => {
          assert.ok(reading !== null, label + '：必须能取到 `.pxm-settings`')
          assert.equal(reading.count, 1, label + '：设置 section 的根节点应当只有 1 个 `.pxm-settings`')

          const distinct = surfaces.map((name) => reading.official[name])
          if (expectDistinct) {
            assert.equal(
              new Set(distinct).size,
              distinct.length,
              label + '：官方 bg-base / layer-1 / layer-2 / layer-3 必须两两不同色（否则判据无效）：' +
                JSON.stringify(reading.official),
            )
          } else {
            assert.equal(
              new Set(distinct).size,
              1,
              label + '：浅色下官方这几个表面官方本就同色（本 lane 的已核前提）：' +
                JSON.stringify(reading.official),
            )
          }

          // 语义：**现在真正显示出来的那一层表面**必须等于官方弹窗面板那一层。
          //
          // 先判这一条、再判"自己不该有底色"的形态条，而且**只在深色下**判"等于哪一层"：
          //   - 浅色下官方 bg-base / layer-1 / layer-2 **就是同一个 #fff**，写哪一层都同色，
          //     所以浅色那次只核对"官方确实同色"这条前提（上面 else 分支）；
          //   - 深色下三者互不相同（#151517 / #232324 / #2c2c2e），这时才真正能区分
          //     "挂错了一层"与"挂对了"。
          if (expectDistinct) {
            assert.ok(
              rgbParts(reading.official['--dsw-alias-bg-layer-2']) !== null,
              label + '：bg-layer-2 的解析值必须能解析成 rgb()：' + reading.official['--dsw-alias-bg-layer-2'],
            )

            const perceivedSurface =
              reading.sectionBg === 'rgba(0, 0, 0, 0)'
                ? reading.official['--dsw-alias-bg-layer-2']
                : reading.sectionBg
            const hit = nearest(perceivedSurface, reading.official)
            assert.equal(
              hit.key,
              '--dsw-alias-bg-layer-2',
              label +
                '：`.pxm-settings` 现在显示的表面是 ' +
                String(hit.key) +
                '（' +
                perceivedSurface +
                '），官方设置页内容表面用的应是弹窗面板那一层 `--dsw-alias-bg-layer-2`：' +
                JSON.stringify(reading),
            )
            assert.notEqual(
              nearest(perceivedSurface, { base: reading.official['--dsw-alias-bg-base'] }).distance,
              0,
              label + '：`.pxm-settings` 的表面又等于应用底色 bg-base —— 那正是被修掉的缺陷形态：' +
                JSON.stringify(reading),
            )

            // 形态：官方 section 自己不画表面（`.wCInkW_options` 里没有 background），
            // 所以我们的 section 也不该自己画一层 —— 自己画一层是"比官方面板更暗"的成因。
            assert.equal(
              reading.sectionBg,
              'rgba(0, 0, 0, 0)',
              label +
                '：`.pxm-settings` 自己不该画底色（官方 `.wCInkW_options` 也没有 background）。实测=' +
                reading.sectionBg,
            )
          }
        }

        check(await readOnce(), '浅色', false)

        await probe(page, 'setTokens', DARK)
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))
        check(await readOnce(), '深色', true)

        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })
  })

  // ── 8.9 输入控件的底色 / 描边：与官方表单控件同层 ─────────────────────────

  /**
   * 「官方输入控件 → 我们输入控件」的对照（每一处在 app.asar 里核过原文，
   * 逐条证据见 `docs/contract-notes.md` 19.5 与 §24.2）：
   *
   * | 控件 | 官方 | 我们 |
   * |---|---|---|
   * | 模型页文本字段（Base URL） | `settings-models/lib/client.js:58` 的 `._3nPmjq_input` → **`bg-layer-1`** + `border-l4` | `modelsPageInputStyle`（`TextInput` + 显式 style）← **本用例钉住** |
   * | 模型页密钥字段（API Key） | 同一枚 `._3nPmjq_input`（32px / `bg-layer-1`） | 同上（`TextInput` + `type:'password'`） |
   * | 模型页下拉（厂商 / 模型 / 尺寸） | 同一页的 `<select className="input selectInput">` → 也是 `bg-layer-1` | `SelectField` 的触发器（`bg-layer-1`；**无描边**，与官方自绘触发器一致） |
   * | 非模型页的其它文本字段 | `settings-form/fields.module.css` 的 `.input` → `bg-layer-3` + `border-l4` | `inputStyle`（作品库导出路径文本框） |
   * | 大段文本 | 官方 client 侧**没有** `<textarea>` | 提示词降级文本域 `.pxm-copy-fallback`（走 `bg-layer-3`，与 `inputStyle` 同层） |
   *
   * 判据与 8.8 同构，分两组：
   *   1. **模型页那一组**（`input.text` / `input.password` / `select`）：深色下底色必须等于
   *      `bg-layer-1` 的解析值，且**不等于** `bg-base` / `bg-layer-2` / `bg-layer-3`
   *      （"模型页字段挂成别处的层"正是这次要挡的形态）。
   *   2. **非模型页那一组**（导出路径文本框 / 提示词文本域）：仍是 `bg-layer-3`，
   *      且不等于 `bg-base` / `bg-layer-2` / `bg-layer-1`。
   *   浅色下官方四层表面都是 `#fff`，写哪一层都同色 ⇒ 浅色那次不判"等于哪一层"，
   *   只断言"官方确实同色"（与 8.8 完全一致的纪律，不是放宽）。
   *
   * 描边那一半（`border-l4`）浅深都可判：浅色 `#00000029`、深色 `#fff3`，与 `border-l1`
   * （发丝分隔线）不同色，所以两套主题都断言"== border-l4 且 != border-l1"。
   * 自绘下拉触发器**不判描边**：它没有描边（与官方 `.selector{border:none}` 一致）。
   */
  describe('8.9 输入控件：模型页字段 == bg-layer-1，其余表单字段 == bg-layer-3；描边 == border-l4', () => {
    it('8.9 input / password / 自绘下拉触发器 == 官方「模型」页那层 bg-layer-1；导出路径 / 提示词文本域 == bg-layer-3', async () => {
      const { page, context, problems } = await openThemedLane({ mountSlot: 'settings.section' })
      try {
        await page.waitForSelector('.pxm-settings [data-pxm-role="select"]', { timeout: 15000 })
        /*
         * 2026-10-12 结构变化（**只做结构性适配，期望值一个都不动**）：
         * 厂商卡片默认收起，`#pxm-provider-base-url` / `#pxm-provider-api-key` 只在点
         * 「编辑」展开后才渲染；Base URL 还住在「自定义设置」折叠区里，所以再点开它。
         * 两个 id 已冻结为不变，这里仍然按原 id 取（不写容错选择器）。
         */
        await page.click('[data-pxm-vendor-edit]')
        await page.waitForSelector('[data-pxm-editor]', { timeout: 10000 })
        await page.click('[data-pxm-vendor-customized] summary')

        /**
         * 三类控件的选择器 + 它们在源码里挂的那个**内联样式键**。
         *
         * `expect` 用 token 表达式、`prop` 是目标属性本身，交给浏览器现场解析（同 8.1/8.3），
         * 而不是测试自己把 hex 换算成 rgb。
         */
        const CONTROLS = [
          {
            key: 'input.text',
            // **钉住具体那一枚**（厂商卡片的 Base URL）：`.pxm-settings input[type="text"]`
            // 会命中页面里最后一枚文本框（导出路径那一枚，属另一类），选谁就成了实现顺序的偶然。
            selector: '#pxm-provider-base-url',
            bgKey: 'modelsPageInputStyle.background',
            borderKey: 'modelsPageInputStyle.border',
            layer: 'bg-layer-1',
          },
          {
            key: 'input.password',
            selector: '#pxm-provider-api-key',
            bgKey: 'modelsPageInputStyle.background',
            borderKey: 'modelsPageInputStyle.border',
            layer: 'bg-layer-1',
          },
          {
            key: 'select',
            /**
             * 2026-10-09：设置页下拉换成**自绘触发器**；2026-10-12 起底色改为官方「模型」页
             * 本页那一层 `bg-layer-1`（官方同页的 `<select className="input selectInput">`
             * 就是它）。仍然**不声明 `borderKey`**：触发器是 `.selector{border:none}`，
             * 它没有描边，拿 `border-l4` 去量是比错模板。
             */
            selector: '#pxm-defaults-provider',
            bgKey: 'selectTrigger.background',
            layer: 'bg-layer-1',
          },
          {
            key: 'input.exportDir',
            // 非「模型」页的表单字段：仍是 `settings-form` 的 `.input`（34px / bg-layer-3）。
            selector: '#pxm-export-dir',
            bgKey: 'inputStyle.background',
            borderKey: 'inputStyle.border',
            layer: 'bg-layer-3',
          },
          {
            key: 'textarea.prompt',
            selector: '.pxm-copy-fallback',
            bgKey: 'copyFallback.background',
            borderKey: 'copyFallback.border',
            layer: 'bg-layer-3',
            state: 'detail',
          },
        ]

        /** 官方表面 / 描边的解析值（按属性本身解析）。 */
        const OFFICIAL = [
          { key: 'bgBase', prop: 'backgroundColor', value: 'var(--dsw-alias-bg-base)' },
          { key: 'bgLayer1', prop: 'backgroundColor', value: 'var(--dsw-alias-bg-layer-1)' },
          { key: 'bgLayer2', prop: 'backgroundColor', value: 'var(--dsw-alias-bg-layer-2)' },
          { key: 'bgLayer3', prop: 'backgroundColor', value: 'var(--dsw-alias-bg-layer-3)' },
          { key: 'borderL1', prop: 'borderTopColor', value: 'var(--dsw-alias-border-l1)' },
          { key: 'borderL4', prop: 'borderTopColor', value: 'var(--dsw-alias-border-l4)' },
        ]

        const targets = CONTROLS.filter((control) => control.state !== 'detail')

        /** 量一次：这些控件的计算背景/描边 + 官方各 token 的解析值。 */
        const readOnce = async () =>
          page.evaluate(
            ({ controlList, officialList }) => {
              const root = document.querySelector('.pxm-settings')
              const read = (selector) => {
                const nodes = document.querySelectorAll(selector)
                const element = nodes[nodes.length - 1]
                if (element === undefined) return null
                const style = window.getComputedStyle(element)
                return { background: style.backgroundColor, border: style.borderTopColor }
              }
              const measured = {}
              controlList.forEach((control) => {
                measured[control.key] = read(control.selector)
              })
              return { measured, official: window.__pxmLane.resolveCss(officialList) }
            },
            { controlList: CONTROLS, officialList: OFFICIAL },
          )

        const rgbParts = (value) => {
          const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(String(value))
          if (m === null) return null
          if (m[4] !== undefined && Number(m[4]) !== 1) return null
          return [Number(m[1]), Number(m[2]), Number(m[3])]
        }
        const nearest = (value, candidates) => {
          const a = rgbParts(value)
          if (a === null) return { key: null, distance: Number.POSITIVE_INFINITY }
          let best = { key: null, distance: Number.POSITIVE_INFINITY }
          for (const key of Object.keys(candidates)) {
            const b = rgbParts(candidates[key])
            if (b === null) continue
            const distance = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
            if (distance < best.distance) best = { key, distance }
          }
          return best
        }

        const controlsOf = (list) => list.filter((control) => control.state !== 'detail')

        /**
         * @param reading  上面 `readOnce` 的结果。
         * @param label    '浅色' / '深色'，进失败信息。
         * @param list     这一轮要判的控件（详情态那一条只在深色那一轮之后另量）。
         * @param distinct 官方这几层表面在**这一套主题**下是否两两不同色（浅色为 false）。
         */
        const check = (reading, label, list, distinct) => {
          const backgroundSurfaces = {
            'bg-base': reading.official.bgBase,
            'bg-layer-1': reading.official.bgLayer1,
            'bg-layer-2': reading.official.bgLayer2,
            'bg-layer-3': reading.official.bgLayer3,
          }

          // 前提：没有"四层互不相同"这条前提，"挂错一层"在数值上就抓不出来。
          if (distinct) {
            assert.equal(
              new Set(Object.values(backgroundSurfaces)).size,
              4,
              label +
                '：官方 bg-base / bg-layer-1 / bg-layer-2 / bg-layer-3 必须两两不同色（否则判据无效）：' +
                JSON.stringify(reading.official),
            )
            assert.notEqual(
              reading.official.borderL4,
              reading.official.borderL1,
              label + '：官方 border-l4 与 border-l1 必须不同色（否则"描边挂错"抓不出来）',
            )
          } else {
            // 浅色下的**已核前提**（与 8.8 同一条纪律）：官方这几层表面本来就是同一个色，
            // 所以浅色那一次**不判**"等于哪一层"——不是放宽判据，而是那一层信息在这种
            // 主题下根本不存在。这里把这个前提也钉住，免得将来有人以为浅色漏测了。
            assert.equal(
              new Set(Object.values(backgroundSurfaces)).size,
              1,
              label +
                '：浅色下官方这几个表面本就同色（本 lane 的已核前提）：' +
                JSON.stringify(reading.official),
            )
          }

          for (const control of list) {
            const got = reading.measured[control.key]
            assert.ok(got !== null, label + '：必须能取到 ' + control.key + '（' + control.selector + '）')

            const hit = nearest(got.background, backgroundSurfaces)
            if (distinct) {
              /*
               * 语义：现在显示的那一层必须就是**这一类官方控件**用的那一层 ——
               * 模型页的字段 / 下拉是 `bg-layer-1`（`._3nPmjq_input`），
               * 其余表单字段是 `bg-layer-3`（`settings-form` 的 `.input`）。
               * 期望层写在每条 CONTROLS 的 `layer` 上，不在这里按 key 猜。
               */
              assert.equal(
                hit.key,
                control.layer,
                label +
                  '：' +
                  control.key +
                  ' 的底色是 ' +
                  String(hit.key) +
                  '（' +
                  got.background +
                  '，源码挂在 `' +
                  control.bgKey +
                  '`）。官方同类控件用的是 `--dsw-alias-' +
                  control.layer +
                  '`：' +
                  JSON.stringify({ measured: got, official: reading.official }),
              )
              // 反证：三处被修掉的缺陷形态（"输入框塌进应用底色" / "与卡片同层、看不出是控件" /
              // "挂成相邻那一层" —— 后两条在 `bg-layer-1` 与 `bg-layer-3` 之间只差一档，
              // 肉眼几乎看不出，所以必须逐层都不等）。
              for (const [name, wrongKey] of [
                ['bg-base', 'bgBase'],
                ['bg-layer-1', 'bgLayer1'],
                ['bg-layer-2', 'bgLayer2'],
                ['bg-layer-3', 'bgLayer3'],
              ]) {
                if (name === control.layer) continue
                assert.notEqual(
                  nearest(got.background, { wrong: reading.official[wrongKey] }).distance,
                  0,
                  label +
                    '：' +
                    control.key +
                    ' 的底色等于 ' +
                    name +
                    ' —— 那是误差形态（官方同类控件是 ' +
                    control.layer +
                    '）：' +
                    JSON.stringify(got),
                )
              }
            }

            // 描边：浅深都可判（border-l4 与 border-l1 两套主题都不同色）。
            //
            // 2026-10-09 起这一半**只判有描边的控件**：官方的下拉触发器是
            // `.selector{border:none}`（`PermissionRow.module.css`），它本来就没有描边，
            // 硬套 `border-l4` 会把"官方确实没有描边"误判成缺陷。声明 `borderKey` 的控件
            // 才走这条断言——判据强度不变，只是不再拿错模板去量。
            if (control.borderKey === undefined) continue
            assert.equal(
              got.border,
              reading.official.borderL4,
              label +
                '：' +
                control.key +
                ' 的描边应当是官方控件描边 `--dsw-alias-border-l4`（源码挂在 `' +
                control.borderKey +
                '`）：实测 ' +
                got.border +
                ' / 官方解析值 ' +
                reading.official.borderL4,
            )
            assert.notEqual(
              got.border,
              reading.official.borderL1,
              label + '：' + control.key + ' 的描边不该退化成分隔线 border-l1：' + JSON.stringify(got),
            )
          }
        }

        // ── 浅色：官方四层同色，"等于哪一层"判不了，只核前提 + 描边 ──────────────
        check(await readOnce(), '浅色', targets, false)

        // ── 深色：这一轮才判"挂的是哪一层"（四层互不相同） ──────────────────────
        await probe(page, 'setTokens', DARK)
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))
        check(await readOnce(), '深色', targets, true)

        // ── 详情页的提示词 `<textarea>`（只在"复制失败"的降级分支里渲染） ────────
        //
        // 这里**不是**造 DOM：把 `navigator.clipboard.writeText` 换成一个必然 reject 的
        // Promise，正是 `CopyPromptButton` 那条真实降级路径（复制失败 → 展开可选中文本）。
        // 不这么做就量不到 `<textarea>`，那条断言就是空转。
        const detailPage = await context.newPage()
        try {
          await detailPage.addInitScript(() => {
            Object.defineProperty(navigator, 'clipboard', {
              configurable: true,
              value: {
                writeText: () => Promise.reject(new Error('lane：剪贴板被显式拒绝（用例注入）')),
              },
            })
          })
          await detailPage.goto(server.origin + '/shell.html', { waitUntil: 'load' })
          await detailPage.evaluate((payload) => window.__pxmLane.install(payload), fixture())
          await detailPage.evaluate((slot) => window.__pxmLane.mount(slot), 'main')
          await detailPage.waitForSelector('.pxm-tile')
          await detailPage.click('.pxm-tile')
          await detailPage.waitForSelector('.pxm-copy-btn')
          await detailPage.click('.pxm-copy-btn')
          await detailPage.waitForSelector('.pxm-copy-fallback', { timeout: 15000 })

          const readTextarea = () =>
            detailPage.evaluate(
              ({ officialList }) => {
                const nodes = document.querySelectorAll('.pxm-copy-fallback')
                const element = nodes[nodes.length - 1]
                if (element === undefined) return null
                const style = window.getComputedStyle(element)
                return {
                  measured: {
                    'textarea.prompt': {
                      background: style.backgroundColor,
                      border: style.borderTopColor,
                    },
                  },
                  official: window.__pxmLane.resolveCss(officialList),
                }
              },
              { officialList: OFFICIAL },
            )

          const textareaControls = CONTROLS.filter(
            (control) => control.key === 'textarea.prompt',
          )
          assert.equal(textareaControls.length, 1, 'CONTROLS 里应当有且只有一条 textarea.prompt')

          check(await readTextarea(), '浅色', textareaControls, false)
          await probe(detailPage, 'setTokens', DARK)
          await detailPage.evaluate(
            () => new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
          )
          check(await readTextarea(), '深色', textareaControls, true)
        } finally {
          await detailPage.close()
        }

        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })
  })
}
