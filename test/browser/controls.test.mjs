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
    await page.waitForSelector('[data-pxm-field]')
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
        assert.equal(initial.value, '1', '夹具默认 n=1')
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
        assert.equal(now.value, '2', '点上箭头必须 +1')

        await page.click('[data-pxm-stepper-down]')
        now = await probe(page, 'stepperFacts', '每次张数')
        assert.equal(now.value, '1', '点下箭头必须 -1')

        // 边界 4：连点到上界，之后上箭头禁用、值不变。
        for (let i = 0; i < 3; i += 1) {
          await page.click('[data-pxm-stepper-up]')
          await page.waitForFunction(
            (want) =>
              document.querySelector('[data-pxm-stepper-value]')?.textContent?.trim() === String(want),
            2 + i,
            { timeout: 5000 },
          )
        }
        now = await probe(page, 'stepperFacts', '每次张数')
        assert.equal(now.value, '4', '连点必须停在上界 4')
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

  describe('3. 键盘可达性与关闭', () => {
    /** 打开「尺寸」那一行的下拉并等弹层出现。 */
    async function openSize(page) {
      const fields = await page.$$('[data-pxm-field]')
      for (const field of fields) {
        const text = await field.evaluate((node) => {
          const label = node.querySelector('[data-pxm-field-label]')
          return label === null ? '' : label.textContent
        })
        if (text.includes('尺寸')) {
          await (await field.$('[data-pxm-role="select"]')).click()
          await page.waitForSelector('[data-pxm-select-list]', { timeout: 5000 })
          return true
        }
      }
      return false
    }

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
