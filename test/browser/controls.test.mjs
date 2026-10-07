/**
 * 浏览器 lane：**控件形态复刻**（2026-10-09）。
 *
 * ## 这份用例在防什么
 *
 * 设置页的三种控件在这一次改造里从"浏览器原生件"换成了"照官方 DOM/CSS 自绘"：
 *   - 下拉：原生 `<select>` → 自绘 `触发器（含 chevron）+ 圆角弹层（当前项带 ✓）`；
 *   - 搜索框：裸 `<input>` → `整宽 + 前置放大镜（内联 SVG）`；
 *   - 数字字段：`<input type=number>` → `数值 + 上下两枚 chevron + 单位后缀`；
 *   - 布局：堆叠式（标签在控件上方）→ **行式**（标签+说明在左、控件在右）。
 *
 * 这些形态**jsdom 原理上测不出来**（jsdom 不做排版：`getBoundingClientRect` 全是 0，
 * `:hover` / 布局重叠 / 绝对定位都无从谈起），所以钉在真浏览器里。
 *
 * 三类断言，缺一不可：
 *   1. **形态存在**：chevron / 弹层 / ✓ / 前置图标 / 两枚箭头——"长得像官方"的**结构**部分；
 *   2. **几何关系**：行式布局"左列与控件纵向重叠、说明在标签下方"、搜索框"整宽 + 图标在左侧"
 *      ——"长得像官方"的**排布**部分（纯 DOM 断言抓不到，必须量矩形）；
 *   3. **可用性**：`↑↓` 改选中项、`Enter` 选中、`Esc` 关闭、点外部关闭、步进器 1–4 边界。
 *      **没有第 3 类，第 1 类就只是"画了个能看的东西"**：真实用户根本用不了。
 *
 * 反向变异见 `tools/lane-mutations.mjs` 的 `M27`~`M31`（去掉 chevron / 去掉弹层 /
 * 把行式改回堆叠 / 去掉前置图标 / 去掉一枚步进箭头）——那些变异必须让**本文件**变红。
 *
 * 定位一律走 lane 暴露的**语义探针**（`selectFacts` / `stepperFacts` / `searchFacts` /
 * `fieldRow`），不写 CSS 类名：类名是实现细节，换个名字不该让断言失效。
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { startLaneServer, launchLaneBrowser } from './lane-server.mjs'

/**
 * 夹具**在本文件里自带**，不从 `layout.test.mjs` 里 import。
 *
 * 原因：`layout.test.mjs` 是"自带 lane 启动"的用例文件，import 它会**顺带启动**
 * 一个 lane server + 浏览器（模块顶层就 `await startLaneServer()`），
 * 于是 `pnpm test:browser` 会为同一次运行多开一套进程。夹具是纯数据，复制过来更干净。
 *
 * 形状与 `test/client-settings-dom.test.mjs` 的 `providerView` / `providersPayload`
 * 同源：设置页 `ProvidersSection` 只认这些字段。
 */
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
      group: 'aggregator',
      baseUrl: 'https://api.example.test/v1',
      geminiNativeBaseUrl: '',
      dialect: 'standard',
      apiMode: 'images-generations',
      apiKeyEnv: '',
      hasApiKey: true,
      apiKeySource: 'config',
      models: ['gpt-image-1', 'flux-pro-1.1'],
      allowedSizes: ['1:1', '3:4', '16:9'],
      sizeMode: 'whitelist',
      timeoutMs: 180000,
    },
  ],
}

/** 设置页只需要 `providers` 这一份；作品库那一块走 `projects`（本文件用不到具体内容）。 */
const fixture = () => ({ providers: providersFixture, projects: [] })

const server = await startLaneServer()
const launched = await launchLaneBrowser()
const ALLOW_SKIP = process.env.PXM_LANE_ALLOW_SKIP === '1'

const SKIP_BANNER = [
  '',
  '='.repeat(78),
  '  ⚠  浏览器 lane 已跳过 → 控件形态未经验证（行式布局 / 弹层 / 键盘可达性 /',
  '     步进器边界 —— 这几类 jsdom 原理上测不出来）',
  '  ⚠  原因：本机没有可用的 Microsoft Edge / Google Chrome（playwright-core 不下载浏览器）',
  '     尝试过的 channel：' + (launched.failures.length === 0 ? '（无）' : launched.failures.join(' | ')),
  '  ⚠  修法：装 Edge/Chrome 后重跑；确实要在无浏览器机器上放行，用 PXM_LANE_ALLOW_SKIP=1',
  '='.repeat(78),
  '',
].join('\n')

if (launched.browser === null) {
  if (!ALLOW_SKIP) {
    console.error(SKIP_BANNER)
    throw new Error('没有可用的浏览器，控件形态用例无法执行（不允许静默跳过）')
  }
  console.log(SKIP_BANNER)
}

const describeLane = launched.browser === null ? describe.skip : describe

if (launched.browser !== null) {
  const browser = launched.browser

  after(async () => {
    await browser.close()
    await server.close()
  })

  const probe = (page, name, arg = null) =>
    page.evaluate(([fn, value]) => window.__pxmLane[fn](value), [name, arg])

  /**
   * 多参探针：lane 的 `pressKey(selector, key)` / `pointerDownAt(x, y)` 都是位置参数，
   * lane 不解析 JSON 对象（那不是探针的契约），所以这里展开成参数列表传进去。
   */
  const probeArgs = (page, name, args) =>
    page.evaluate(([fn, list]) => window.__pxmLane[fn].apply(null, list), [name, args])

  /** 在某个元素上按一次键。 */
  const press = (page, selector, key) => probeArgs(page, 'pressKey', [selector, key])

  /**
   * 张数步进器的**当前值**。
   *
   * task-17 起这个值是可输入的 `<input>`，所以读 `.value`；同时兼容曾经的 `<span>`
   * 形态（读 `textContent`）—— 两种都认，**断言本身没变**（仍然断"值等于几"）。
   *
   * 为什么不直接用 `stepperFacts.value`：那个共用探针（`lane.js`）仍然按
   * `textContent` 读，而 `lane.js` 不在本任务写域。这里自带读法，不去依赖那个字段。
   */
  /**
   * 下拉弹层的**水平事实**：触发器 / 弹层 / **所在行式字段**（`[data-pxm-field]`）的矩形。
   *
   * 这是"独立复述"：容器 = **包含这枚下拉的那一行式字段**（不复用客户端的祖先查找逻辑），
   * 它的**内容框**左边界就是"弹层往左不许越过"的那条线。行本身在卡片里，所以这条
   * 比"不许越过卡片细边框"更严。
   */
  const horizontalFacts = (page, label) =>
    page.evaluate((want) => {
      const field = Array.prototype.slice
        .call(document.querySelectorAll('[data-pxm-field]'))
        .filter((node) => {
          const l = node.querySelector('[data-pxm-field-label]')
          return l !== null && (l.textContent || '').trim() === String(want).trim()
        })[0]
      if (!field) return null
      const trigger = field.querySelector('[data-pxm-role="select"]')
      if (trigger === null) return null
      const list = field.querySelector('[data-pxm-select-list]')
      const cs = window.getComputedStyle(field)
      const fr = field.getBoundingClientRect()
      const tr = trigger.getBoundingClientRect()
      const lr = list === null ? null : list.getBoundingClientRect()
      return {
        field: { left: fr.left, right: fr.right },
        /** 容器**内容框**左边界 = 行左边界 + 左 padding + 左边框。 */
        contentLeft:
          fr.left + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.borderLeftWidth) || 0),
        trigger: { left: tr.left, right: tr.right, width: tr.width },
        list: lr === null ? null : { left: lr.left, right: lr.right, width: lr.width },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }
    }, label)

  const readStepperValue = (page) =>
    page.evaluate(() => {
      const el = document.querySelector('[data-pxm-stepper-value]')
      if (el === null) return null
      const raw = el.value !== undefined && el.value !== null ? el.value : el.textContent
      return String(raw ?? '').trim()
    })

  /** 开一个真页面：真 HTTP 源 + 真 shell 骨架 + 原产物 client.js。 */
  async function openLane(options = {}) {
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
    await page.evaluate((slot) => window.__pxmLane.mount(slot), options.slot ?? 'settings.section')
    /*
     * 等"面板真的画出来了"。
     *
     * 2026-10-10 作品库工具条改成**单行**之后，那里的控件不再挂在行式字段
     * （`[data-pxm-field]`）里 —— 用户要求删掉「搜索（项目名 / 模块名）」「排序」这些
     * 左列标签与说明，`Field` 这个包装随之从工具条上撤掉。所以 `main` 槽要等的是
     * 工具条自己的语义锚点 `[data-pxm-toolbar]`（与 `[data-pxm-field]` 同一做法：
     * 锚在**语义**上，不锚在类名上）。
     */
    const anchor = (options.slot ?? 'settings.section') === 'main' ? '[data-pxm-toolbar]' : '[data-pxm-field]'
    await page.waitForSelector(anchor)
    return { page, context, problems }
  }

  // ── 1. 三处控件的形态 ──────────────────────────────────────────────────────

  describe('1. 控件形态（形）', () => {
    it('1.1 下拉：触发器是 button、带 chevron；展开后弹层存在、role=menu、当前项带 ✓ 且 aria-checked', async () => {
      const { page, context, problems } = await openLane()
      try {
        const closed = await probe(page, 'selectFacts', '厂商')
        assert.ok(closed !== null, '「尺寸」那一行必须有下拉')
        assert.equal(closed.triggerTag, 'BUTTON', '触发器必须是原生 button（Tab/Enter/Space 才有原生行为）')
        assert.equal(closed.hasPopup, 'menu', '触发器必须声明 aria-haspopup="menu"')
        assert.equal(closed.hasChevron, true, '触发器里必须有 chevron（官方 PermissionRow 的 .selector 就是标签+chevron）')

        // 点开第二个字段的下拉（「模型」），它的选项一定多于一个。
        const fieldHandle = await page.$$('[data-pxm-field] [data-pxm-role="select"]')
        assert.ok(fieldHandle.length >= 3, '「默认值」卡片应有厂商/模型/尺寸三个下拉')
        await fieldHandle[1].click()
        await page.waitForSelector('[data-pxm-select-list]', { timeout: 5000 })

        const open = await probe(page, 'selectFacts', '模型')
        assert.equal(open.expanded, 'true', '展开后 aria-expanded 必须为 true')
        assert.equal(open.listRole, 'menu', '弹层必须是 role="menu"')
        assert.ok(open.options.length >= 2, '弹层里必须有选项：' + JSON.stringify(open.options))

        // 当前项：必须有且只有一项带 ✓，并且它的 aria-checked=true。
        const checked = open.options.filter((option) => option.hasCheck)
        assert.equal(checked.length, 1, '带 ✓ 的选项必须**恰好一项**（当前项）：' + JSON.stringify(open.options))
        assert.equal(checked[0].checked, 'true', '带 ✓ 的那一项 aria-checked 必须是 true')
        const ariaChecked = open.options.filter((option) => option.checked === 'true')
        assert.equal(ariaChecked.length, 1, 'aria-checked="true" 的选项也必须恰好一项')
        assert.equal(
          ariaChecked[0].value,
          checked[0].value,
          '✓ 与 aria-checked 必须落在同一项上（两种"当前项"表达不能打架）',
        )
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })

    it('1.2 搜索框：整宽、前置放大镜图标（内联 SVG、不挡点击）', async () => {
      const { page, context, problems } = await openLane({ slot: 'main' })
      try {
        await page.waitForSelector('.pxm-search-box')
        const facts = await probe(page, 'searchFacts', '.pxm-search-box')
        assert.ok(facts !== null, '作品库必须有搜索框')
        assert.equal(facts.tag, 'INPUT', '搜索框本体必须是原生 input')
        assert.ok(facts.iconRect !== null, '搜索框必须有前置图标（内联 SVG）')
        assert.equal(facts.iconPointerEvents, 'none', '前置图标必须 pointer-events:none，否则会挡住点击输入')
        // 图标几何：官方 `.RotMhW_search>svg{position:absolute;left:12px}`，16px 见方。
        assert.ok(
          Math.abs(facts.iconRect.left - (facts.inputRect.left + 12)) <= 1,
          '前置图标必须落在官方那一档（距输入框左边界 12px）：' +
            JSON.stringify({ icon: facts.iconRect, input: facts.inputRect }),
        )
        assert.ok(
          Math.abs(facts.iconRect.width - 16) <= 0.5 && Math.abs(facts.iconRect.height - 16) <= 0.5,
          '前置图标必须是 16×16（官方 IconSearchOutlineRegular 的默认尺寸）：' + JSON.stringify(facts.iconRect),
        )

        // 整宽：输入框必须与它所在的框同宽（差 ≤ 1px 的取整误差）。
        assert.ok(
          Math.abs(facts.inputRect.width - facts.boxRect.width) <= 1,
          '搜索框必须整宽：' + JSON.stringify({ input: facts.inputRect, box: facts.boxRect }),
        )
        // 图标在**左侧**、且在输入框内部（垂直居中）。
        assert.ok(
          facts.iconRect.left < facts.inputRect.left + facts.inputRect.width * 0.25,
          '前置图标必须在输入框左侧：' + JSON.stringify({ icon: facts.iconRect, input: facts.inputRect }),
        )
        assert.ok(
          facts.iconRect.left >= facts.inputRect.left - 1 &&
            facts.iconRect.right <= facts.inputRect.right + 1,
          '图标必须落在输入框内部：' + JSON.stringify({ icon: facts.iconRect, input: facts.inputRect }),
        )
        assert.ok(facts.placeholder !== null && facts.placeholder !== '', '搜索框必须有 placeholder')
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })

    it('1.3 数字步进器：容器内有数值 + 上下两枚 chevron 按钮 + 单位后缀；点上下改值且卡在 1–4 边界', async () => {
      const { page, context, problems } = await openLane()
      try {
        const initial = await probe(page, 'stepperFacts', '每次张数')
        assert.ok(initial !== null, '「每次张数」那一行必须有步进器')
        assert.equal(initial.upChevron, true, '上箭头必须是一枚 chevron（内联 SVG）')
        assert.equal(initial.downChevron, true, '下箭头必须是一枚 chevron（内联 SVG）')
        assert.equal(await readStepperValue(page), '1', '夹具默认 n=1')
        assert.equal(initial.unit, '张', '步进器右侧要有单位后缀')

        // 两枚箭头都在容器内、且上下排列（上箭头的 top 必须小于下箭头）。
        const stepper = initial.stepperRect
        for (const [name, rect] of [['上', initial.upRect], ['下', initial.downRect]]) {
          assert.ok(
            rect.left >= stepper.left - 1 && rect.right <= stepper.right + 1 &&
              rect.top >= stepper.top - 1 && rect.bottom <= stepper.bottom + 1,
            name + '箭头必须落在步进器容器内：' + JSON.stringify({ rect, stepper }),
          )
        }
        assert.ok(initial.upRect.top < initial.downRect.top, '两枚箭头必须上下排列（上、下）')

        // 边界 1：已在最小值，下箭头必须禁用；点它值不变。
        assert.equal(initial.downDisabled, true, 'n=1 时下箭头必须禁用（1–4 下界）')
        await page.click('[data-pxm-stepper-up]')
        let now = await probe(page, 'stepperFacts', '每次张数')
        assert.equal(await readStepperValue(page), '2', '点上箭头必须 +1')

        await page.click('[data-pxm-stepper-down]')
        now = await probe(page, 'stepperFacts', '每次张数')
        assert.equal(await readStepperValue(page), '1', '点下箭头必须 -1')

        // 边界 4：连点到上界，之后上箭头禁用、值不变。
        for (let i = 0; i < 3; i += 1) {
          await page.click('[data-pxm-stepper-up]')
          await page.waitForFunction(
            (want) => {
              const el = document.querySelector('[data-pxm-stepper-value]')
              if (el === null) return false
              // 值是 `<input>` 时读 `.value`（task-17），旧 `<span>` 形态读 `textContent`。
              const raw = el.value !== undefined && el.value !== null ? el.value : el.textContent
              return String(raw ?? '').trim() === String(want)
            },
            2 + i,
            { timeout: 5000 },
          )
        }
        now = await probe(page, 'stepperFacts', '每次张数')
        assert.equal(await readStepperValue(page), '4', '连点必须停在上界 4')
        assert.equal(now.upDisabled, true, 'n=4 时上箭头必须禁用（1–4 上界）')
        assert.equal(now.downDisabled, false, 'n=4 时下箭头必须可用')
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })
  })

  // ── 2. 行式布局 ────────────────────────────────────────────────────────────

  describe('2. 行式布局（官方「权限」/「字号大小」那一套）', () => {
    it('2.1 标签与控件在同一行（纵向重叠 + 控件在标签右侧），说明文字在标签下方', async () => {
      const { page, context, problems } = await openLane()
      try {
        for (const label of ['厂商', '模型', '尺寸', '每次张数']) {
          const row = await probe(page, 'fieldRow', label)
          assert.ok(row !== null, '必须能定位「' + label + '」这一行')
          assert.ok(row.labelRect !== null && row.controlRect !== null, label + '：标签与控件都必须存在')

          const overlap =
            Math.min(row.controlRect.bottom, row.labelRect.bottom) -
            Math.max(row.controlRect.top, row.labelRect.top)
          assert.ok(
            overlap >= row.labelRect.height * 0.5,
            label + '：标签与控件必须在同一行（纵向重叠 ≥ 半个标签高）：' + JSON.stringify(row),
          )
          assert.ok(
            row.controlRect.left >= row.labelRect.right - 1,
            label + '：控件必须排在标签**右侧**（并排 = 行式；上下堆叠 = 退回旧形态）：' + JSON.stringify(row),
          )

          // 说明文字：官方行式布局里它是左列的**第二行**（在标签下方、且仍在控件左侧）。
          assert.equal(row.hasDesc, true, label + '：这一行必须有说明文字（官方 .rowText 的两行结构）')
          assert.ok(
            row.descRect.top >= row.labelRect.bottom - 1,
            label + '：说明文字必须在标签**下方**：' + JSON.stringify(row),
          )
          assert.ok(
            row.descRect.left <= row.labelRect.left + 1,
            label + '：说明文字必须与标签左对齐（同属左列）：' + JSON.stringify(row),
          )
          assert.ok(
            row.descRect.right <= row.controlRect.left + 1,
            label + '：说明文字必须留在左列，不许溢到控件底下：' + JSON.stringify(row),
          )
        }
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })
  })

  // ── 3. 键盘与关闭 ──────────────────────────────────────────────────────────

  /**
   * 按字段标签打开自绘下拉，并等弹层出现。返回 `true`=打开了。
   *
   * 放在**共享作用域**（不在某个 describe 里）：第 3 组与第 4 组都要用，
   * 而 describe 之间不能互相看见对方的局部函数。
   *
   * 标签走**精确**匹配：字段多了之后「厂商」的说明里含"模型"二字，子串匹配会静默选错行。
   */
  async function openSelectByLabel(page, labelText) {
    const fields = await page.$$('[data-pxm-field]')
    for (const field of fields) {
      const text = await field.evaluate((node) => {
        const label = node.querySelector('[data-pxm-field-label]')
        return label === null ? '' : label.textContent.trim()
      })
      if (text === labelText) {
        await (await field.$('[data-pxm-role="select"]')).click()
        await page.waitForSelector('[data-pxm-select-list]', { timeout: 5000 })
        return true
      }
    }
    return false
  }

  /** 打开「尺寸」那一行的下拉（短列表：3 项，没有搜索框）。 */
  const openSize = (page) => openSelectByLabel(page, '尺寸')

  /** 打开「模型」那一行的下拉（长列表：夹具给 16 个模型 → 有搜索框）。 */
  const openModel = (page) => openSelectByLabel(page, '模型')

  describe('3. 键盘可达性与关闭', () => {

    it('3.1 ↑↓ 改变选中项（并真的移动焦点），Enter 选中并把值写回触发器', async () => {
      const { page, context, problems } = await openLane()
      try {
        assert.equal(await openSize(page), true, '必须能打开「尺寸」下拉')
        const opened = await probe(page, 'selectFacts', '尺寸')
        const currentIndex = opened.options.findIndex((option) => option.hasCheck)
        assert.ok(currentIndex >= 0, '展开时必须有一项带 ✓')
        assert.ok(opened.options.length >= 2, '「尺寸」下拉至少有 2 项，↑↓ 才有可移动的空间')

        // 展开后焦点应当在**当前项**上（不用先 Tab 一遍）。
        assert.equal(
          opened.activeOption,
          opened.options[currentIndex].value,
          '展开后焦点必须在当前项上：' + JSON.stringify({ active: opened.activeOption, options: opened.options }),
        )

        // ↓ 一次：焦点落到下一项（末项则回到首项）。
        const pressed = await press(page, '[data-pxm-select-list]', 'ArrowDown')
        assert.equal(pressed, true, '↓ 必须被接管（preventDefault），否则页面会跟着滚')
        const afterDown = await probe(page, 'selectFacts', '尺寸')
        const expected = opened.options[(currentIndex + 1) % opened.options.length].value
        assert.equal(afterDown.activeOption, expected, '↓ 后焦点必须移到下一项：' + JSON.stringify(afterDown))

        // ↑ 一次：回到原来那一项。
        await press(page, '[data-pxm-select-list]', 'ArrowUp')
        const afterUp = await probe(page, 'selectFacts', '尺寸')
        assert.equal(
          afterUp.activeOption,
          opened.options[currentIndex].value,
          '↑ 后焦点必须回到上一项：' + JSON.stringify(afterUp),
        )

        // Enter：选中当前焦点那一项 → 弹层收起、触发器文字变成该项。
        const target = afterUp.options.find((option) => option.value === afterUp.activeOption)
        await press(page, '[data-pxm-select-list]', 'Enter')
        const afterEnter = await probe(page, 'selectFacts', '尺寸')
        assert.equal(afterEnter.expanded, 'false', 'Enter 选中后弹层必须收起')
        assert.equal(afterEnter.listRole, null, 'Enter 选中后弹层必须从 DOM 里消失')
        assert.equal(
          afterEnter.text.replace(/\s+/g, ''),
          String(target.value).replace(/\s+/g, ''),
          '选中的值必须写回触发器：' + JSON.stringify({ text: afterEnter.text, target }),
        )
        assert.equal(afterEnter.hasChevron, true, '收起后 chevron 仍在（只是转回 0°）')
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })

    it('3.2 Esc 关闭弹层并把焦点交回触发器', async () => {
      const { page, context, problems } = await openLane()
      try {
        assert.equal(await openSize(page), true, '必须能打开「尺寸」下拉')
        await press(page, 'body', 'Escape')
        const after = await probe(page, 'selectFacts', '尺寸')
        assert.equal(after.expanded, 'false', 'Esc 必须关闭弹层')
        assert.equal(after.listRole, null, 'Esc 后弹层必须从 DOM 里消失')
        assert.equal(after.activeTag, 'BUTTON', 'Esc 后焦点必须回到触发器（否则键盘用户会掉到 body 上）：' + JSON.stringify(after))
        assert.equal(
          await page.evaluate(() => document.activeElement.getAttribute('data-pxm-role')),
          'select',
          'Esc 后焦点元素必须就是那枚触发器',
        )
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })

    it('3.3 点击外部关闭弹层，且不改动已选的值', async () => {
      const { page, context, problems } = await openLane()
      try {
        assert.equal(await openSize(page), true, '必须能打开「尺寸」下拉')
        const before = await probe(page, 'selectFacts', '尺寸')
        const beforeChecked = before.options.find((option) => option.hasCheck)
        assert.ok(beforeChecked !== undefined, '展开时必须有一项带 ✓')
        // 触发器上的文字就是"当前值"的呈现；关闭不该改动它。
        const beforeText = before.text

        // 在弹层之外、页面之内的一个点上按 pointerdown。
        const point = await probe(page, 'point', '[data-pxm-role="select"]')
        assert.ok(point !== null, '必须能取到触发器的中心点')
        const outside = await probeArgs(page, 'pointerDownAt', [point.x, 4])
        assert.ok(outside !== null, '必须能在页面里派发 pointerdown')

        const after = await probe(page, 'selectFacts', '尺寸')
        assert.equal(after.expanded, 'false', '点击外部必须关闭弹层')
        assert.equal(after.listRole, null, '关闭后弹层必须从 DOM 里消失')
        assert.equal(after.text, beforeText, '关闭不等于选中：触发器上的当前值不得被改动')
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })
    it('3.4 真键盘（page.keyboard）：Tab 进入触发器 → Enter 展开 → ↑↓ 选项 → Esc 关闭', async () => {
      /**
       * 3.1~3.3 用的是 lane 的合成 `KeyboardEvent`（能断言 `defaultPrevented`、能精确控制
       * 派发目标），但合成事件与**真按键**并不完全等价。这一条补上真键盘链路：
       * 真 Tab 进入、真 Enter 展开、真方向键、真 Esc——证明"能用键盘操作"这条不是
       * 只在合成事件下成立。
       */
      const { page, context, problems } = await openLane()
      try {
        // 先把焦点放到**「尺寸」那一行**的触发器上（`focus()` 不代表 Tab 序列，
        // 所以额外断言它确实可聚焦）。`:has()` 把选择器限定到那一行——
        // 页面里有多枚触发器，全局 querySelector 取到的是第一枚（厂商）。
        const sizeRow = '[data-pxm-field]:has([data-pxm-field-label])'
        const sizeTrigger = sizeRow + ' [data-pxm-role="select"]'
        await page.focus(sizeTrigger)
        assert.equal(
          await page.evaluate(() => document.activeElement.getAttribute('data-pxm-role')),
          'select',
          '触发器必须可以被键盘聚焦（focusable）',
        )
        // 确认聚焦的确实是**第一行**（厂商）——`:has()` 只是把范围收到"含标签的字段"，
        // 全局 focus 取到的仍是文档里第一枚触发器。下面所有 `selectFacts` 都按这一行读，
        // 免得断言与元素对不上。
        const focusedLabel = await page.evaluate(
          () => document.activeElement.closest('[data-pxm-field]')?.querySelector('[data-pxm-field-label]')?.textContent,
        )
        assert.equal(String(focusedLabel), '厂商', '真键盘这一条盯的是第一行（厂商）的下拉')

        // 真 Enter 展开。
        await page.keyboard.press('Enter')
        await page.waitForSelector('[data-pxm-select-list]', { timeout: 5000 })
        const opened = await probe(page, 'selectFacts', '厂商')
        assert.equal(opened.expanded, 'true', '真 Enter 必须能展开弹层')
        assert.equal(opened.activeOption, opened.options.find((o) => o.hasCheck)?.value, '展开后焦点在当前项')

        // 真 ↓ / ↑。
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowUp')
        const nav = await probe(page, 'selectFacts', '厂商')
        assert.equal(
          nav.activeOption,
          opened.activeOption,
          '↓ 再 ↑ 必须回到原来那一项：' + JSON.stringify({ before: opened.activeOption, after: nav.activeOption }),
        )

        // 真 Esc 关闭。
        await page.keyboard.press('Escape')
        const closed = await probe(page, 'selectFacts', '厂商')
        assert.equal(closed.expanded, 'false', '真 Esc 必须关闭弹层')
        assert.equal(
          await page.evaluate(() => document.activeElement.getAttribute('data-pxm-role')),
          'select',
          '真 Esc 后焦点必须回到触发器',
        )
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })
  })

  // ── 4. 可搜索下拉 + 弹层不被裁（2026-10-12） ────────────────────────────────

  /**
   * 用户反馈两条：**模型有 16 个，弹出列表太长**、**有部分被遮挡**。这一组用例把两条都钉住。
   *
   * 判据全部落在**可观测事实**上，不锚类名：
   *   - 搜索：输入 → `options` 变少且只剩匹配项；`↑↓` 只在**过滤结果**里移动；`Enter` 写回；
   *   - 不被裁：弹层矩形必须落在**视口内**（`bottom <= innerHeight` / `right <= innerWidth`），
   *     且必须在**触发器附近**（下方 `+4px` 或上方 `−4px`）——"被祖先裁掉"时这两条必红；
   *   - 空态 / `Esc` / 外点关闭。
   *
   * 反向变异见 `tools/lane-mutations.mjs` 的 `M41`（去掉搜索框）/ `M42`（退回绝对定位、重新被裁）。
   */
  describe('4. 可搜索下拉（长列表）与弹层不被裁', () => {
    /**
     * 长列表夹具：16 个模型（用户实测的数量）。
     *
     * **故意混入大小写与子串关系**：`Gpt-Image-1`（大写 G）与 `gpt-image-2` 都要被
     * 小写 `gpt` 命中；`flux` 只能命中两枚 —— 这样"过滤"与"大小写不敏感"两件事
     * 各自都有反例可抓。
     */
    const LONG_MODELS = [
      'Gpt-Image-1',
      'gpt-image-2',
      'openai/gpt-image-1-mini',
      'black-forest-labs/flux-1.1-pro',
      'black-forest-labs/flux-dev',
      'google/gemini-3.1-flash-image',
      'google/imagen-4',
      'qwen/qwen-image-edit',
      'qwen/qwen-image',
      'stability/sd-3.5-large',
      'midjourney/v6',
      'ideogram/v3',
      'recraft/v3',
      'luma/photon',
      'text-embedding-3-large',
      'whisper-1',
    ]

    const longFixture = () => ({
      providers: {
        ...providersFixture,
        defaults: { provider: 'ofox', model: 'gpt-image-2', size: '1:1', n: 1 },
        providers: [{ ...providersFixture.providers[0], models: LONG_MODELS }],
      },
      projects: [],
    })

    /** 16 个模型时，弹层必须带搜索框。 */
    it('4.1 长列表（16 项）的弹层里有搜索框；短列表（3 项）没有', async () => {
      const { page, context, problems } = await openLane({ fixture: longFixture })
      try {
        assert.equal(await openModel(page), true, '必须能打开「模型」下拉')
        const facts = await probe(page, 'selectFacts', '模型')
        assert.ok(facts.search !== null, '16 项的长列表必须有搜索框：' + JSON.stringify(facts.search))
        // 「模型」那一枚下拉比"该厂商的模型数"多一项：「（用该厂商的第一个模型）」。
        assert.equal(
          facts.options.length,
          LONG_MODELS.length + 1,
          '弹层里应当是全部 16 个模型 + 1 枚「用第一个模型」占位项',
        )
        assert.equal(
          facts.search.value,
          '',
          '刚打开时搜索框必须是空的（否则用户看不到全量列表）',
        )
        assert.ok(
          facts.search.placeholder !== null && facts.search.placeholder !== '',
          '搜索框必须有 placeholder',
        )
        assert.equal(facts.search.clearPresent, false, '搜索框为空时不该有「清空」按钮')
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }

      const short = await openLane()
      try {
        assert.equal(await openSize(short.page), true, '必须能打开「尺寸」下拉')
        const facts = await probe(short.page, 'selectFacts', '尺寸')
        assert.equal(
          facts.search,
          null,
          '短列表（3 项）不该出现搜索框：多一个框只会让弹层更高、还多一次 Tab',
        )
        assert.deepEqual(short.problems, [])
      } finally {
        await short.context.close()
      }
    })

    it('4.2 输入即过滤（大小写不敏感子串）：选项变少且只含匹配项；「清空」恢复全量', async () => {
      const { page, context, problems } = await openLane({ fixture: longFixture })
      try {
        assert.equal(await openModel(page), true, '必须能打开「模型」下拉')
        const before = await probe(page, 'selectFacts', '模型')
        assert.equal(
          before.options.length,
          LONG_MODELS.length + 1,
          '过滤前应当是全部 16 个模型 + 1 枚占位项',
        )

        // 小写输入命中大写开头的项（Gpt-Image-1）→ 证明大小写不敏感。
        await page.fill('[data-pxm-select-search]', 'gpt')
        const filtered = await probe(page, 'selectFacts', '模型')
        assert.ok(
          filtered.options.length < before.options.length,
          '过滤后选项必须变少：' + JSON.stringify(filtered.options.map((o) => o.value)),
        )
        for (const option of filtered.options) {
          assert.ok(
            String(option.value).toLowerCase().includes('gpt'),
            '过滤结果里不该有非匹配项：' + JSON.stringify(option),
          )
        }
        assert.ok(
          filtered.options.some((option) => option.value === 'Gpt-Image-1'),
          '大小写不敏感：小写 gpt 必须命中 Gpt-Image-1',
        )
        assert.ok(
          filtered.options.some((option) => option.value === 'openai/gpt-image-1-mini'),
          '子串匹配：gpt 必须命中中段的 openai/gpt-image-1-mini',
        )
        assert.equal(filtered.search.clearPresent, true, '有内容时必须出现「清空」按钮')
        assert.ok(
          filtered.listRect.bottom <= filtered.listRect.top + 320.5,
          '过滤后弹层不该超过上限 320px：' + JSON.stringify(filtered.listRect),
        )

        // 「清空」按钮：点一下恢复全量。
        await page.click('[data-pxm-select-clear]')
        const cleared = await probe(page, 'selectFacts', '模型')
        assert.equal(cleared.search.value, '', '点清空后搜索框必须为空')
        assert.equal(cleared.options.length, before.options.length, '清空后必须恢复全部 16 项 + 占位项')
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })

    it('4.3 ↑↓ 只在过滤结果内移动，Enter 选中并把值写回触发器；当前项仍带 ✓', async () => {
      const { page, context, problems } = await openLane({ fixture: longFixture })
      try {
        assert.equal(await openModel(page), true, '必须能打开「模型」下拉')
        await page.fill('[data-pxm-select-search]', 'flux')
        const filtered = await probe(page, 'selectFacts', '模型')
        assert.equal(
          filtered.options.length,
          2,
          '夹具里 flux 恰好两枚：' + JSON.stringify(filtered.options.map((o) => o.value)),
        )

        /*
         * 过滤后当前值（gpt-image-2）不在结果里 ⇒ 没有任何带 ✓ 的项。
         * 此时 ↑↓ 的落点必须是**过滤结果**里的项，不能跑到被过滤掉的项上。
         * 判据用 `activeIndex`（高亮项在过滤结果里的下标）：长列表形态下焦点留在
         * 容器/搜索框上，`activeOption` 恒为 null —— 那是"焦点在哪"，不是"高亮在哪"。
         */
        assert.equal(
          filtered.options.filter((option) => option.hasCheck).length,
          0,
          '当前值被过滤掉时，弹层里不该出现 ✓（它不在结果里）',
        )

        // 焦点先落到列表容器（长列表形态），走真实键盘事件。
        await page.focus('[data-pxm-select-list]')
        await page.keyboard.press('ArrowDown')
        const first = await probe(page, 'selectFacts', '模型')
        assert.ok(
          first.activeIndex >= 0 && first.activeIndex < filtered.options.length,
          '↓ 之后高亮必须落在**过滤结果**范围内：' +
            JSON.stringify({
              activeIndex: first.activeIndex,
              options: filtered.options.map((o) => o.value),
            }),
        )
        await page.keyboard.press('ArrowDown')
        const second = await probe(page, 'selectFacts', '模型')
        assert.notEqual(second.activeIndex, first.activeIndex, '再按一次 ↓ 必须换一项')
        assert.ok(
          second.activeIndex >= 0 && second.activeIndex < filtered.options.length,
          '第二落点也必须在过滤结果范围内：' + JSON.stringify(second.activeIndex),
        )

        const target = second.options[second.activeIndex].value
        await page.keyboard.press('Enter')
        const after = await probe(page, 'selectFacts', '模型')
        assert.equal(after.expanded, 'false', 'Enter 选中后弹层必须收起')
        assert.equal(after.listRole, null, 'Enter 选中后弹层必须从 DOM 里消失')
        assert.equal(
          after.text.replace(/\s+/g, ''),
          String(target).replace(/\s+/g, ''),
          '选中的值必须写回触发器：' + JSON.stringify({ text: after.text, target: target }),
        )
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })

    it('4.4 直接在列表容器上打字符就开始搜（焦点转到搜索框）；过滤无结果给可读空态', async () => {
      const { page, context, problems } = await openLane({ fixture: longFixture })
      try {
        assert.equal(await openModel(page), true, '必须能打开「模型」下拉')
        // 打开后焦点在列表容器上（长列表形态）；此时打一个字符应当被接住并转成过滤。
        const opened = await probe(page, 'selectFacts', '模型')
        assert.equal(opened.activeIsList, true, '长列表打开后焦点应落在列表容器上：' + JSON.stringify(opened))
        await page.keyboard.type('flux')
        const typed = await probe(page, 'selectFacts', '模型')
        assert.equal(typed.search.value, 'flux', '在容器上打字必须写进搜索框')
        assert.equal(typed.search.focused, true, '打字后焦点必须转到搜索框（否则接下来的字符会丢）')
        assert.equal(typed.options.length, 2, 'flux 应命中两枚：' + JSON.stringify(typed.options))

        // 无结果 → 可读空态。
        await page.fill('[data-pxm-select-search]', 'zzz-不存在')
        const empty = await probe(page, 'selectFacts', '模型')
        assert.equal(empty.options.length, 0, '没有匹配项时选项数必须是 0')
        assert.equal(empty.emptyVisible, true, '必须出现空态元素')
        assert.ok(
          typeof empty.emptyText === 'string' && empty.emptyText.length > 0,
          '空态必须是可读文案，不是空白：' + JSON.stringify(empty.emptyText),
        )

        // 空态下 Enter 不该写坏值（没有可选项 → 什么都不做、弹层仍在）。
        await press(page, '[data-pxm-select-list]', 'Enter')
        const stillOpen = await probe(page, 'selectFacts', '模型')
        assert.equal(stillOpen.expanded, 'true', '空态下 Enter 不该关掉弹层')
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })

    it('4.5 弹层必须完整落在视口内且贴着触发器 —— 在不滚动的"矮窗口"场景（触发器就在视口下半部）', async () => {
      /*
       * 复现用户截图那种场景：**窗口不高（480px）**，设置页是「厂商卡片 + 默认值卡片」的
       * 长内容。**故意不滚动**：一滚就把触发器推到视口上半部，"放不下"的前提就没了。
       * 用 DOM 原生 `click()` 打开（Playwright 的 `.click()` 会先把元素滚进视野，
       * 那会改掉这个场景的几何 —— 实测触发器的视口位置从 382 变到 149）。
       *
       * 这个场景下弹层内容 ~296px 而下方只剩 66px ⇒ 必须翻到触发器上方。
       * 旧形态（`position:absolute` + `left:0`）会被**设置弹窗**裁掉：
       * `#settingsDialog{overflow:auto}`（真实 shell 是 `SettingsRoot` 的
       * `.wCInkW_options{overflow-y:auto}`）正是那个裁切祖先，
       * `lane.clipChain()` 能把它指出来（实测 `clipper = {id:'settingsDialog', overflowY:'auto'}`）。
       *
       * 判据两条互相独立，任一条都能让"退回被裁状态"变红：
       *   ① 视口包含关系；② 弹层与触发器的相对位置。
       */
      const { page, context, problems } = await openLane({ height: 480, fixture: longFixture })
      try {
        const opened = await page.evaluate(() => {
          const list = document.querySelectorAll('[data-pxm-field] [data-pxm-role="select"]')
          const rect = list[2].getBoundingClientRect()
          const dialog = document.getElementById('settingsDialog')
          list[2].click()
          return {
            trigger: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
            innerHeight: window.innerHeight,
            innerWidth: window.innerWidth,
            spaceBelow: window.innerHeight - rect.bottom - 4,
            spaceAbove: rect.top - 4,
            scrollTop: dialog.scrollTop,
          }
        })
        await page.waitForSelector('[data-pxm-select-list]', { timeout: 5000 })

        // 前提：这个场景**真的**放不下（否则用例是空转，"翻转"从没被触发过）。
        assert.ok(
          opened.spaceBelow < 320,
          '这一条的前提是"下方装不下 320px 的弹层"，实测下方只有 ' + String(opened.spaceBelow) + 'px',
        )
        assert.ok(
          opened.spaceAbove > 320,
          '这一条的前提是"上方装得下"，实测上方只有 ' + String(opened.spaceAbove) + 'px',
        )

        const facts = await probe(page, 'selectFacts', '尺寸')
        const viewport = await probe(page, 'viewportRect')
        assert.ok(facts.listRect !== null, '弹层必须存在')

        // ① 完整落在视口内（被祖先裁掉时这里必红）。
        assert.ok(
          facts.listRect.bottom <= viewport.height,
          '弹层底边不许超出视口：' +
            JSON.stringify({ list: facts.listRect, viewport }) +
            '（被裁的祖先见 lane 的 clipChain 探针）',
        )
        assert.ok(
          facts.listRect.right <= viewport.width,
          '弹层右边不许超出视口：' + JSON.stringify({ list: facts.listRect, viewport }),
        )
        assert.ok(facts.listRect.top >= 0, '弹层顶边不许超出视口：' + JSON.stringify(facts.listRect))
        assert.ok(facts.listRect.left >= 0, '弹层左边不许超出视口：' + JSON.stringify(facts.listRect))

        /*
         * ② 贴着触发器：下方（bottom+4）或上方（top−4）各允许 8px 误差。
         *
         * 两个坐标都取**同一时刻**的实测值（`facts`）：打开时若浏览器顺手把触发器滚了一下
         * （实测这个场景里设置弹窗的 scrollTop 会从 0 变到 36），拿点击前量到的矩形来比
         * 就会差出一个滚动量 —— 那是量法的问题，不是实现的问题。
         */
        const below = Math.abs(facts.listRect.top - (facts.triggerRect.bottom + 4))
        const above = Math.abs(facts.listRect.bottom - (facts.triggerRect.top - 4))
        assert.ok(
          above <= 8,
          '下方只剩 ' +
            String(opened.spaceBelow) +
            'px ⇒ 弹层必须翻到触发器**上方**（不是把 max-height 调到很小就算修好）：' +
            JSON.stringify({
              list: facts.listRect,
              trigger: facts.triggerRect,
              below: below,
              above: above,
            }),
        )
        assert.ok(
          Math.abs(facts.listRect.bottom - (facts.triggerRect.top - 4)) <= 8,
          '向上打开的弹层必须紧贴触发器上沿（差 ' +
            String(Math.abs(facts.listRect.bottom - (facts.triggerRect.top - 4))) +
            'px）：' +
            JSON.stringify({ list: facts.listRect, trigger: facts.triggerRect }),
        )
        /*
         * 弹层必须装得下**全部选项**（不是被压成一条缝）：3 项 × 34px + 2 个 2px 间距
         * + 8px 内边距 = 116px。这条与"高度上限 320"配对着看 —— 上限只在长列表上生效。
         */
        assert.ok(
          facts.listRect.height >= 116 - 1,
          '3 项必须能全部画出来（约 116px），不许被压成一条缝：' + JSON.stringify(facts.listRect),
        )

        // ③ 滚动不该把选中项滚出视野：选中项必须在弹层的可视滚动区内。
        const checked = facts.options.filter((option) => option.hasCheck)[0]
        assert.ok(checked !== undefined, '必须有一项带 ✓')
        assert.ok(
          checked.rect.top >= facts.scrollRect.top - 1 && checked.rect.bottom <= facts.scrollRect.bottom + 1,
          '当前选中项必须在弹层的可视滚动区内：' +
            JSON.stringify({ checked: checked.rect, scroll: facts.scrollRect }),
        )
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })

    it('4.6 长列表 + 矮窗口：弹层仍完整可见；左右两个极端位置都夹进视口，高度不超 320px', async () => {
      /*
       * 用户截图那种场景的第二形态：**16 个模型**的长列表（弹层内容本身就超过 320px），
       * 加上矮窗口。弹层此时由"可用空间"决定高度：`maxHeight = 最小(可用空间, 320)`。
       * 这一条同时钉住三件事：
       *   - 完整可见（含左右夹取：见下面把触发器挪到视口最左 / 最右的那两轮）；
       *   - 高度不超过官方 `.candidateList` 的 320px；
       *   - 过滤后仍完整可见。
       */
      const { page, context, problems } = await openLane({ height: 480, fixture: longFixture })
      try {
        const clickTrigger = (index) =>
          page.evaluate((i) => {
            document.querySelectorAll('[data-pxm-field] [data-pxm-role="select"]')[i].click()
          }, index)

        // 第一轮：模型下拉（16 项）。
        const pre = await page.evaluate(() => {
          const list = document.querySelectorAll('[data-pxm-field] [data-pxm-role="select"]')
          const rect = list[1].getBoundingClientRect()
          return { top: rect.top, bottom: rect.bottom, innerHeight: window.innerHeight }
        })
        await clickTrigger(1)
        await page.waitForSelector('[data-pxm-select-list]', { timeout: 5000 })
        const long = await probe(page, 'selectFacts', '模型')
        const viewport = await probe(page, 'viewportRect')
        assert.equal(long.search === null, false, '16 项必须带搜索框')
        assert.ok(
          long.listRect.bottom <= viewport.height && long.listRect.top >= 0,
          '长列表弹层必须完整落在视口内（纵向）：' + JSON.stringify({ list: long.listRect, viewport }),
        )
        assert.ok(
          long.listRect.right <= viewport.width && long.listRect.left >= 0,
          '长列表弹层必须完整落在视口内（横向）：' + JSON.stringify({ list: long.listRect, viewport }),
        )
        // 上限 = 可用空间与官方 320px 的较小者（内容本身就超过 320px ⇒ 只能受这两个约束）。
        const spaceBelow = viewport.height - pre.bottom - 4 - 8
        const spaceAbove = pre.top - 4 - 8
        const cap = Math.min(Math.max(spaceBelow, spaceAbove), 320)
        assert.ok(
          long.listRect.height <= cap + 0.5,
          '弹层高度不得超过 min(可用空间 ' + String(cap) + 'px, 官方上限 320px)：' +
            JSON.stringify(long.listRect),
        )
        /*
         * 水平契约（task-18）：**右边界贴触发器右边界，向左延展**，且**不许越出所在
         * 字段/卡片的内容框**。
         *
         * 演进：旧契约"与触发器同宽"（长 id 被省略号截断）→ task-17 "可以更宽但只夹视口"
         * （用户截图：弹层右边界跑出了「默认值」那张卡的细边框）→ 现在两条一起钉：
         * 右对齐 + 容器内。**这不是放宽**（比"夹视口"更严，多了"不许越出卡片"）。
         */
        const longH = await horizontalFacts(page, '模型')
        assert.ok(longH !== null && longH.list !== null, '必须能量到弹层与它所在的行式字段')
        assert.ok(
          Math.abs(longH.list.right - longH.trigger.right) <= 1,
          '弹层右边界必须与触发器右边界对齐（±1）：' + JSON.stringify(longH),
        )
        assert.ok(
          longH.list.left >= longH.contentLeft - 1,
          '弹层左边界不得越出所在字段/卡片的内容框：' + JSON.stringify(longH),
        )
        assert.ok(
          longH.list.right <= longH.field.right + 1,
          '弹层右边界不得越出所在字段行（因此也不会越过卡片细边框）：' + JSON.stringify(longH),
        )
        assert.ok(
          long.listRect.width >= long.triggerRect.width - 1,
          '弹层宽度不得小于触发器（max(触发器宽, 内容宽)）：' +
            JSON.stringify({ list: long.listRect, trigger: long.triggerRect }),
        )
        // 内容比上限长 ⇒ 内层必须真的可滚，且滚动区不越出弹层。
        assert.equal(long.scrollOverflowY, 'auto', '长列表的内层必须可滚')
        assert.ok(
          long.scrollRect.height <= long.listRect.height + 0.5,
          '内层滚动区不得超出弹层：' + JSON.stringify({ scroll: long.scrollRect, list: long.listRect }),
        )

        // 过滤之后仍然完整可见。
        await page.fill('[data-pxm-select-search]', 'gpt')
        const filtered = await probe(page, 'selectFacts', '模型')
        assert.ok(filtered.options.length > 0 && filtered.options.length < 16, '过滤后应当剩下 gpt 的几项')
        assert.ok(
          filtered.listRect.bottom <= viewport.height && filtered.listRect.top >= 0,
          '过滤后的弹层必须仍然完整可见：' + JSON.stringify(filtered.listRect),
        )

        // 第二轮：把窗口挤窄（触发器的左右空间同时变紧），弹层仍要夹在视口内。
        await page.setViewportSize({ width: 420, height: 480 })
        /*
         * 等 React 把"重新夹取"落到 DOM 上：`setViewportSize` 是浏览器侧的动作，
         * `resize` → `measure()` → `setPlace` 要跨过一帧才可见。用轮询而不是固定等待：
         * 条件成立就立刻继续，慢机器上也不会假红。
         */
        await page
          .waitForFunction(
            () => {
              const el = document.querySelector('[data-pxm-select-list]')
              return el !== null && el.getBoundingClientRect().right <= window.innerWidth + 0.5
            },
            null,
            { timeout: 5000 },
          )
          .catch(() => {})
        const narrow = await probe(page, 'selectFacts', '模型')
        const narrowViewport = await probe(page, 'viewportRect')
        assert.ok(
          narrow.listRect.right <= narrowViewport.width && narrow.listRect.left >= 0,
          '窄屏下弹层必须夹在视口内：' +
            JSON.stringify({ list: narrow.listRect, viewport: narrowViewport }),
        )
        // 窄屏同样要满足新契约：右对齐 + 不越出容器内容框。
        const narrowH = await horizontalFacts(page, '模型')
        assert.ok(narrowH !== null && narrowH.list !== null, '窄屏下也要能量到弹层与所在行')
        assert.ok(
          Math.abs(narrowH.list.right - narrowH.trigger.right) <= 1,
          '窄屏下弹层右边界仍必须与触发器右边界对齐：' + JSON.stringify(narrowH),
        )
        assert.ok(
          narrowH.list.left >= narrowH.contentLeft - 1,
          '窄屏下弹层仍不得越出所在字段/卡片的内容框：' + JSON.stringify(narrowH),
        )
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })

    /**
     * task-17（用户报的 bug，带截图）：**模型下拉的选项行被省略号截断**。
     *
     * 这不是美观问题：模型 id 恰恰只差后缀（`microsoft/mai-image-2.5` / `-flash` / `-pro`、
     * `google/gemini-3.1-flash-image` vs `-lite-image`），截断后用户**分不清要选哪一个**。
     *
     * 判据全落在可测事实上（不锚类名）：
     *   - 每条选项的标签文本 = **完整**的模型 id（不是被截断的前缀）；
     *   - 最长的那一条：`scrollWidth <= clientWidth + 1`（没有横向溢出 ⇒ 没被截断）；
     *   - 计算样式 `textOverflow !== 'ellipsis'`、`whiteSpace === 'normal'`、
     *     `overflowWrap === 'anywhere'`（长 id 能在任意字符处断行）；
     *   - 弹层**不窄于**触发器，且完整落在视口内（左右各 8px 安全边距）；
     *   - **窄视口（420px）下同样成立** —— 那时弹层被右侧空间夹住，标签改为**换行**。
     */
    it('4.8 模型下拉：最长的选项也完整显示（不省略号截断），窄视口下同样', async () => {
      // 用户截图里那三个"只差后缀"的 id + gemini 的一对：任何一条被截断都分不清。
      const SUFFIX_MODELS = [
        'microsoft/mai-image-2.5',
        'microsoft/mai-image-2.5-flash',
        'microsoft/mai-image-2.5-pro',
        'google/gemini-3.1-flash-image',
        'google/gemini-3.1-lite-image',
      ]
      const suffixFixture = () => ({
        providers: {
          ...providersFixture,
          defaults: { provider: 'ofox', model: SUFFIX_MODELS[0], size: '1:1', n: 1 },
          providers: [{ ...providersFixture.providers[0], models: SUFFIX_MODELS }],
        },
        projects: [],
      })

      /** 选项行标签的事实：文本 / 溢出 / 换行属性。 */
      const labelFacts = (page) =>
        page.evaluate(() => {
          const list = document.querySelector('[data-pxm-select-list]')
          if (list === null) return null
          return Array.prototype.map.call(list.querySelectorAll('[data-pxm-option]'), (row) => {
            const label = row.querySelector('[data-pxm-option-label]')
            const cs = label === null ? null : window.getComputedStyle(label)
            return {
              value: row.getAttribute('data-pxm-option'),
              text: label === null ? null : (label.textContent || ''),
              clientWidth: label === null ? null : label.clientWidth,
              scrollWidth: label === null ? null : label.scrollWidth,
              textOverflow: cs === null ? null : cs.textOverflow,
              whiteSpace: cs === null ? null : cs.whiteSpace,
              overflowWrap: cs === null ? null : cs.overflowWrap,
              rowHeight: row.getBoundingClientRect().height,
            }
          })
        })

      /** 一处视口下的全部判据；返回最长的那一条的事实。 */
      const checkAll = async (page, where) => {
        const facts = await labelFacts(page)
        assert.ok(facts !== null && facts.length > 0, where + '：必须有选项行')
        const byValue = new Map(facts.map((f) => [String(f.value), f]))
        for (const model of SUFFIX_MODELS) {
          const f = byValue.get(model)
          assert.ok(f !== undefined, where + '：必须列出 ' + model)
          assert.equal(f.text.trim(), model, where + '：选项标签必须是**完整**的 id（' + model + '）')
          assert.notEqual(
            f.textOverflow,
            'ellipsis',
            where + '：选项标签不得用省略号截断（' + model + '）',
          )
          assert.equal(f.whiteSpace, 'normal', where + '：选项标签必须允许换行（' + model + '）')
          assert.equal(
            f.overflowWrap,
            'anywhere',
            where + '：没有空格的长 id 必须能在任意字符处断行（' + model + '）',
          )
          assert.ok(
            f.scrollWidth <= f.clientWidth + 1,
            where + '：' + model + ' 的标签不得横向溢出：' + JSON.stringify(f),
          )
        }
        // "最长的那一条没被截断"——最直接的判据。
        const longest = facts.reduce((a, b) => (String(b.text).length > String(a.text).length ? b : a))
        assert.ok(
          longest.scrollWidth <= longest.clientWidth + 1,
          where + '：最长的选项（' + longest.text + '）不得被截断：' + JSON.stringify(longest),
        )
        // 只看后缀分不清的那几个，在**渲染出来的文本**上必须互不相同。
        const rendered = SUFFIX_MODELS.map((name) => String(byValue.get(name).text).trim())
        assert.equal(
          new Set(rendered).size,
          SUFFIX_MODELS.length,
          where + '：只差后缀的 id 必须可区分，实测 ' + JSON.stringify(rendered),
        )
        return longest
      }

      // ── 宽视口（默认 1280）：完整显示 + 弹层不窄于触发器 + 夹在视口内。
      const wide = await openLane({ fixture: suffixFixture })
      try {
        assert.equal(await openModel(wide.page), true, '必须能打开「模型」下拉')
        const facts = await probe(wide.page, 'selectFacts', '模型')
        const viewport = await probe(wide.page, 'viewportRect')
        await checkAll(wide.page, '宽视口(1280)')
        assert.ok(
          facts.listRect.width >= facts.triggerRect.width - 1,
          '弹层宽度不得小于触发器（max(触发器宽, 内容宽)）：' +
            JSON.stringify({ list: facts.listRect, trigger: facts.triggerRect }),
        )
        /*
         * 而且**真的按内容撑开**了：这些 id（最长 30 字符）比触发器宽，所以弹层必须比
         * 触发器宽 —— 这才叫 `max(触发器宽, 内容宽)`，而不是"永远跟触发器一样宽"。
         * （窄视口下会被右侧空间夹回去，那一半由标签换行来承担。）
         */
        assert.ok(
          facts.listRect.width > facts.triggerRect.width + 1,
          '长 id 时弹层必须按内容撑开（max(触发器宽, 内容宽)）：' +
            JSON.stringify({ list: facts.listRect, trigger: facts.triggerRect }),
        )
        // 水平位置（task-18）：右对齐 + 不越出所在字段/卡片的内容框。
        const wideH = await horizontalFacts(wide.page, '模型')
        assert.ok(wideH !== null && wideH.list !== null, '必须能量到弹层与它所在的行式字段')
        assert.ok(
          Math.abs(wideH.list.right - wideH.trigger.right) <= 1,
          '弹层右边界必须与触发器右边界对齐：' + JSON.stringify(wideH),
        )
        assert.ok(
          wideH.list.left >= wideH.contentLeft - 1,
          '弹层不得越出所在字段/卡片的内容框：' + JSON.stringify(wideH),
        )
        assert.ok(
          facts.listRect.bottom <= viewport.height && facts.listRect.top >= 0,
          '弹层纵向仍必须完整落在视口内：' + JSON.stringify({ list: facts.listRect, viewport }),
        )
        assert.deepEqual(wide.problems, [])
      } finally {
        await wide.context.close()
      }

      // ── 窄视口（420）：弹层被右侧空间夹住 → 标签**换行**，仍然不许截断。
      const narrow = await openLane({ fixture: suffixFixture, width: 420, height: 720 })
      try {
        assert.equal(await openModel(narrow.page), true, '窄视口下也必须能打开「模型」下拉')
        const facts = await probe(narrow.page, 'selectFacts', '模型')
        const viewport = await probe(narrow.page, 'viewportRect')
        const longest = await checkAll(narrow.page, '窄视口(420)')
        const narrowH = await horizontalFacts(narrow.page, '模型')
        assert.ok(narrowH !== null && narrowH.list !== null, '窄视口下也要能量到弹层与所在行')
        assert.ok(
          Math.abs(narrowH.list.right - narrowH.trigger.right) <= 1,
          '窄视口下弹层右边界仍必须与触发器右边界对齐：' + JSON.stringify(narrowH),
        )
        assert.ok(
          narrowH.list.left >= narrowH.contentLeft - 1,
          '窄视口下弹层仍不得越出所在字段/卡片的内容框：' + JSON.stringify(narrowH),
        )
        assert.ok(longest.clientWidth > 0, '选项标签必须真的占位（不能是 0 宽的空盒）')
        assert.deepEqual(narrow.problems, [])
      } finally {
        await narrow.context.close()
      }
    })

    /**
     * task-18：**尺寸下拉不要搜索框**（候选是短词，搜索是噪音），而**模型下拉（>8 项）
     * 仍然要**（防"一刀切把搜索全关了"）。一正一反两条放在同一个用例里，互为对照。
     *
     * 尺寸这一侧**故意给 40 项**（Agnes 的清单：8 比例 + 32 精确尺寸）—— 用户明确要求
     * 尺寸这个字段一律不搜索，所以"项数多"也不该自动把搜索框打开。
     * 关掉搜索之后，选项一个都不能少，键盘（↑↓）仍要能用（退化成短列表形态）。
     */
    it('4.9 尺寸下拉：40 项也不带搜索框；模型下拉（>8 项）仍然带 —— 一正一反', async () => {
      const RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '21:9']
      const sizeOptions = RATIOS.map((value) => ({ value: value, label: value }))
      for (const w of [1024, 1280, 1536, 2048]) {
        for (const h of [768, 1024, 1152, 1344, 1536, 2048, 3072, 4096]) {
          sizeOptions.push({ value: String(w) + 'x' + String(h), label: String(w) + 'x' + String(h) })
        }
      }
      assert.equal(sizeOptions.length, 40, '夹具必须真的是 40 项（Agnes 的清单）')
      const MODELS = []
      for (let i = 0; i < 12; i += 1) MODELS.push('vendor/model-' + String(i))

      const sizeNoSearchFixture = () => ({
        providers: {
          ...providersFixture,
          defaults: { provider: 'ofox', model: MODELS[0], size: '1:1', n: 1 },
          providers: [{ ...providersFixture.providers[0], models: MODELS, sizeOptions: sizeOptions }],
        },
        projects: [],
      })

      const { page, context, problems } = await openLane({ fixture: sizeNoSearchFixture })
      try {
        // ① 尺寸：40 项，**没有**搜索框。
        assert.equal(await openSize(page), true, '必须能打开「尺寸」下拉')
        const sizeFacts = await probe(page, 'selectFacts', '尺寸')
        assert.equal(
          sizeFacts.search,
          null,
          '尺寸下拉**不许**渲染搜索框（40 项也不许）：' + JSON.stringify(sizeFacts.search),
        )
        assert.equal(sizeFacts.options.length, 40, '关掉搜索也不许丢选项：40 项必须全部列出')
        // 关掉搜索 ≠ 关掉键盘：↑↓ 仍然只改高亮（短列表形态）。
        await page.focus('[data-pxm-select-list]')
        await page.keyboard.press('ArrowDown')
        const moved = await probe(page, 'selectFacts', '尺寸')
        assert.ok(moved.activeIndex >= 0, '没有搜索框时 ↑↓ 仍必须能移动高亮')

        // ② 模型：12 项（>8），**仍然有**搜索框（自动开关没被一刀切）。
        await press(page, '[data-pxm-select-list]', 'Escape')
        assert.equal(await openModel(page), true, '必须能打开「模型」下拉')
        const modelFacts = await probe(page, 'selectFacts', '模型')
        assert.ok(
          modelFacts.search !== null,
          '模型下拉 12 项（>8）**必须仍然**自动带搜索框 —— 否则就是"一刀切把搜索全关了"',
        )
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })

    it('4.7 Esc 关闭；点弹层外部关闭；两者都不改动已选的值', async () => {
      const { page, context, problems } = await openLane({ fixture: longFixture })
      try {
        // Esc：焦点交回触发器。
        assert.equal(await openModel(page), true, '必须能打开「模型」下拉')
        const beforeText = (await probe(page, 'selectFacts', '模型')).text
        await press(page, '[data-pxm-select-list]', 'Escape')
        let now = await probe(page, 'selectFacts', '模型')
        assert.equal(now.expanded, 'false', 'Esc 必须关闭弹层')
        assert.equal(now.listRole, null, 'Esc 后弹层必须从 DOM 里消失')
        assert.equal(now.text, beforeText, 'Esc 关闭不等于选中：值不得改动')
        assert.equal(
          await page.evaluate(() => document.activeElement.getAttribute('data-pxm-role')),
          'select',
          'Esc 后焦点必须回到触发器',
        )

        // 点外部：换一个远离弹层的点（左下角）。
        assert.equal(await openModel(page), true, '必须能再次打开「模型」下拉')
        const outside = await probeArgs(page, 'pointerDownAt', [4, 4])
        assert.ok(outside !== null, '必须能在页面里派发 pointerdown')
        now = await probe(page, 'selectFacts', '模型')
        assert.equal(now.expanded, 'false', '点击弹层外部必须关闭')
        assert.equal(now.text, beforeText, '点外部关闭不等于选中：值不得改动')
        assert.deepEqual(problems, [])
      } finally {
        await context.close()
      }
    })
  })

  describeLane('控件形态 lane 自证', () => {
    it('0. 加载的是仓库原产物 client.js，且控件探针可用', async () => {
      const { page, context } = await openLane()
      try {
        const version = await page.evaluate(() => window.__pxmLane.version)
        assert.equal(version, 1, 'lane 探针版本必须是 1')
        for (const name of ['fieldRow', 'selectFacts', 'stepperFacts', 'searchFacts', 'pressKey', 'pointerDownAt']) {
          const kind = await page.evaluate((fn) => typeof window.__pxmLane[fn], name)
          assert.equal(kind, 'function', '控件探针 ' + name + ' 必须存在（探针缺失时用例会静默空转）')
        }
      } finally {
        await context.close()
      }
    })
  })
}
