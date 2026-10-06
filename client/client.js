/**
 * dsh-pixmart client 半 —— 作品库 / 设置页 / 生图实时预览。
 *
 * 装载契约（见 docs/contract-notes.md §3.1）：
 *   - 产物是 `window.__ModuleLoader__.load({ id:'dsh-pixmart', factory })`；
 *   - `factory(require)` **只收到 require**，没有 `host.call`。
 *     因此与宿主通信**只能**走本插件自己的 HTTP 路由（§3.2 的 RPC 机制修正）。
 *
 * 三处落点（技术方案 §8.2）：
 *   ① settings.section    → 设置面板左导航多一项「PixMart」：厂商/默认值/数据目录/累计用量
 *   ② sidebar.panellist   → 侧边栏面板图标排多一个图标（id 'pixmart'）
 *      main (keyed)       → 中央主面板作品库（key 'pixmart'，与上面 id 一一对应）
 *   ③ shell.overlay       → 右下角实时预览卡（§8.5）：进度 3/8 + 逐格点亮 + 取消 + 收起徽标
 *
 * 硬约束：
 *   - 手写 JS，无构建步骤；只用 `require('react')` + `React.createElement`，没有 JSX。
 *   - 所有副作用（slot 注册 / 定时器 / 监听 / DOM / <style>）都包在 `ctx.effect` 里，
 *     随 apply 的 disposer 清理。
 *   - 任何插槽注册失败只让该功能缺失：一律 try/catch，绝不冒泡到设置面板。
 *   - HTTP 基址相对挂载点解析（`new URL('pixmart/', document.baseURI)`），
 *     不写死 `/pixmart/...` 根绝对路径，以支持路径前缀部署。
 */
window.__ModuleLoader__.load({
  id: 'dsh-pixmart',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PLUGIN = 'dsh-pixmart'
    const VERSION = '0.0.1'
    /**
     * 两处插槽共用的显示名：设置面板左导航的一项 + 左侧栏面板图标那一项。
     * 用产品名 `PixMart`（与页面标题、包名一致）。若要两处叫不同名字，拆成两个常量即可。
     */
    const SLOT_LABEL = 'PixMart'
    const PANEL_KEY = 'pixmart'
    const SETTINGS_ID = 'pixmart'
    const OVERLAY_ID = 'pixmart-preview'
    const STYLE_ID = 'dsh-pixmart-style'

    /** 轮询周期：有运行在跑 1s；空闲重发现 10s；页面隐藏时不发请求（§8.5.4）。 */
    const POLL_ACTIVE_MS = 1000
    const POLL_IDLE_MS = 10000
    const RUN_LIST_LIMIT = 5
    /**
     * 作品库每页条数（批次 C 的分页）。
     *
     * 取 24 而不是宿主的默认 50：网格是 `minmax(180px,1fr)`，24 张刚好是常见宽度的
     * 三到四屏，既不会让首屏一次拉 200 个项目，也让「加载更多」在真实数据量下够得着
     * （50 条一页时，用户往往要攒到 50 个以上才第一次看到这个按钮）。
     * 宿主侧 `limit` 上限仍是 200，客户端不越权。
     */
    const PROJECT_PAGE_SIZE = 24
    /**
     * 搜索防抖：输入即过滤，但**不是每敲一个字就发一次请求**。
     * 250ms 是"打字停顿"与"像卡住了"之间的常见折中。
     */
    const SEARCH_DEBOUNCE_MS = 250

    /** 列表排序的可选项（值必须与宿主 `PROJECT_SORTS` 的键一一对应）。 */
    const PROJECT_SORT_OPTIONS = [
      { value: 'createdAt:desc', label: '最新优先' },
      { value: 'createdAt:asc', label: '最早优先' },
      { value: 'name:asc', label: '名称 A→Z' },
      { value: 'images:desc', label: '图片最多' },
    ]
    const DEFAULT_PROJECT_SORT = 'createdAt:desc'

    /** 相对挂载点解析基址，绝不写死根绝对路径。 */
    const BASE = (() => {
      try {
        return new URL('pixmart/', document.baseURI)
      } catch {
        return null
      }
    })()

    const ACTIVE_STATUSES = ['running', 'awaiting-confirm']
    const TERMINAL_STATUSES = ['done', 'failed', 'cancelled', 'interrupted']
    const RUN_STATUS_LABEL = {
      running: '生成中',
      'awaiting-confirm': '待确认',
      done: '已完成',
      failed: '失败',
      cancelled: '已取消',
      interrupted: '已中断',
    }
    const ITEM_STATUS_LABEL = {
      queued: '排队中',
      running: '生成中',
      done: '已完成',
      failed: '失败',
      skipped: '已跳过',
    }
    /**
     * 视觉 token：客户端配色**只走 DSH 官方主题变量**（`--dsw-*`），因此深浅色主题自动一致，
     * 插件侧不写死任何颜色（没有十六进制色值 / rgb 函数 / 系统色关键字）。
     *
     * **不用 `--dsw-alias-brand-primary`**：那个 token 是**主按钮填充**（浅色 `#0f1115`、
     * 深色 `#f9fafb`，见官方 `--dsw-alias-button-primary-fill: var(--dsw-alias-brand-primary)`）。
     * 「进行中 / 进度」若挂上它，浅色主题下会呈现**近黑色**——看起来像一枚按钮而不是状态。
     * 官方 `StateDot` 的 `ongoing` 用的是 `--dsw-alias-label-tertiary`
     * （`StateDot.module.css` 的 `.spinner{color:var(--dsw-alias-label-tertiary)}`），本插件照抄那一处语义。
     *
     * 为什么**不** require 官方组件包（`@deepseek-ai/dsh-client-ui-primitives`）：
     *   - 官方明文禁止 —— `dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:35`；
     *   - 该包是**未打包 ESM + 38 个相对 `.module.css`**，而本插件是手写 JS、没有构建步骤，
     *     loader 解析不了那些相对导入：换组件会把整个面板打挂，而不是"只变丑"。
     * 官方认可的最低风险做法就是**照抄 token**（同文件 practices.md:34：
     * "a renamed token degrades appearance but never breaks rendering"）。
     *
     * 下面这些 token 都由 client Theme 的 `listTokens` 确证存在，且**都有浅/深两套值**
     * （`requiresLightAndDark: true`）；shell 里另有更多 `--dsw-*`，这里只用能确证的。
     *
     * **表面层到底挂哪一个 token，是 2026-10-06 那次修正的核心**：光名字对不算对，
     * 语义对才算对。完整清单（含官方用法）见下面的 `OFFICIAL_SURFACES`，共 6 层；
     * 本插件实际画出来的是其中 5 层：
     *   - `bg-base`（深色 `#151517`）＝ **应用最底层**。官方用于 `ui-layout` 的
     *     `AppFrame.frame` / `centerCol` / `rightbarCol`、`body`，以及整页级面板
     *     （`schedule` 的 `S0jZwq_page`）。**不是**面板/弹窗的底色。
     *   - `bg-layer-1`（深色 `#232324`）＝ **抬起的表面**。官方用于聊天里的浮层预览
     *     （`chat` 的 turn-preview，带 `elevation-panel`）、`deliverables` 的输出块/卡片、
     *     `primitives` 的 HoverCard。作品库面板（`main` 槽里的面板）用它。
     *   - `bg-layer-2`（深色 `#2c2c2e`）＝ **弹窗/嵌套表面**。官方用于
     *     `settings-general` 的 `.wCInkW_panel`（设置弹窗那一块）、`primitives` 的 Modal、
     *     以及 `--dsw-alias-settings-card-fill`（设置卡片填充）。**设置页 section 显示的就是它**
     *     ——官方 section 自己不画表面（`.wCInkW_options` 没有 `background`），继承弹窗那一层。
     *   - `bg-layer-3`（深色 `#353638`）＝ **输入控件层**。官方设置页的表单控件用它
     *     （`fields.module.css` 的 `.input`，见下）。输入框 / 下拉 / 提示词大段文本都用它。
     *   - `bg-overlay`（深色 `#61666b`）＝ 浮层/弹出层底（tooltip 类）。
     * 这几个值在深色下互不相同（#151517 / #232324 / #2c2c2e / #353638 / #61666b），因此
     * "挂错一个"是可以用色彩断言抓出来的（`test/browser/theme.test.mjs` 8.5、8.8 与 8.9）。
     */
    /**
     * 官方**表面层**清单：每层表面的 token 名 + 它在官方那侧的用途。
     *
     * 这是**合同文本**，不是取色来源（取色一律用下面 `T` 里的 `var(...)`）：
     * 它记下"官方一共这几层表面、各自用在哪"，好让"我们这一处该挂哪一层"有据可查。
     * 浏览器 lane 的 8.5 用**官方实际解析值**断言 `bg-base` / `layer-1` / `layer-2` / `layer-3`
     * 在深色下两两不同色（浅色下官方这几层同为 `#fff`，区分不出来），8.8 / 8.9 再用这些解析值
     * 判断设置页 section 显示的是哪一层、以及输入控件挂的是哪一层。色值**故意不写在这里**：
     * 本文件有"不得出现任何十六进制色值"的静态红线（`test/client-tokens.test.mjs`），
     * 要色值就去 lane 里量。
     *
     * 已核对的官方用法（原文都在 app.asar 里）：
     *   - `bg-base`      `ui-layout` 的 AppFrame.frame / centerCol / rightbarCol、`body`、
     *                    整页级面板（`schedule` 的 `S0jZwq_page`）→ **应用最底层**
     *   - `bg-layer-1`   聊天里的 turn-preview（带 elevation-panel）、`deliverables` 的卡片、
     *                    `primitives` 的 HoverCard → **抬起的表面**
     *   - `bg-layer-2`   `settings-general` 的 `.wCInkW_panel`（设置弹窗）、`Modal`、
     *                    `--dsw-alias-settings-card-fill` → **弹窗/嵌套表面**
     *   - `bg-layer-3`   **输入控件层**。官方设置页的表单控件就是它：
     *                    `primitives` 的 `settings-form/fields.module.css` 里
     *                    `.input{background:var(--dsw-alias-bg-layer-3)}` —— 该文件是
     *                    `SettingsValueField`（`<input type="text">`）与 `SettingsSecretField`
     *                    （`<input type="password">`）唯一的样式来源，两者**同一个类**；
     *                    `settings-plugin-inventory` 的 `.RotMhW_search input`、
     *                    `plugin-manager` 的 `.fO69Vq_installField input[type=text]` 也都是它。
     *                    本插件的输入类控件（`inputStyle` → `TextInput` / `Select`、提示词
     *                    `<textarea>`）自 2026-10-07 起挂这一层，见 docs/contract-notes.md 19.5。
     *                    （注意**别**把它与 `primitives/Input.module.css` 的 `.input` 混起来：
     *                    那是原子 `<Input>` 的**内层**无背景输入，它外层 `.wrap` 挂的是
     *                    `bg-layer-1`；README 的 "Input 没有设计源" 一条说的就是它，
     *                    与设置页表单控件不是同一处。）
     *   - `bg-module-platform` 分段控件/胶囊的底槽（`SegmentedControl`）—— 未使用
     *   - `bg-overlay`   tooltip 一类浮层底
     */
    const OFFICIAL_SURFACES = Object.freeze({
      bgBase: { token: '--dsw-alias-bg-base', officialUse: '应用最底层 / 窗口底 / body / 整页级面板' },
      bgLayer1: { token: '--dsw-alias-bg-layer-1', officialUse: '抬起的表面（浮层预览、卡片、HoverCard）' },
      bgLayer2: { token: '--dsw-alias-bg-layer-2', officialUse: '弹窗面板（设置弹窗）与设置卡片填充' },
      bgLayer3: { token: '--dsw-alias-bg-layer-3', officialUse: '输入控件（设置页表单字段 / 搜索框 / 安装字段）' },
      bgOverlay: { token: '--dsw-alias-bg-overlay', officialUse: '浮层 / 弹出层底（tooltip 类）' },
    })

    const T = {
      bgBase: 'var(--dsw-alias-bg-base)',
      bgLayer1: 'var(--dsw-alias-bg-layer-1)',
      bgLayer2: 'var(--dsw-alias-bg-layer-2)',
      bgLayer3: 'var(--dsw-alias-bg-layer-3)',
      bgOverlay: 'var(--dsw-alias-bg-overlay)',
      // **模块底槽**：官方厂商卡片里的「编辑块」就是它 ——
      // `._3nPmjq_editor{background:var(--dsw-alias-bg-module-platform)}`
      // （`@deepseek-ai/dsh-client-ui-settings-models/lib/client.js:58`）。
      // 2026-10-11 厂商卡片复刻官方「模型」页时引入（浅色 `#f5f6f7`、深色 `#353638`，
      // 与 `bg-layer-3` 深色同值、浅色不同值 —— 所以它不是"随便挑一层"）。
      bgModulePlatform: 'var(--dsw-alias-bg-module-platform)',
      borderL1: 'var(--dsw-alias-border-l1)',
      borderL2: 'var(--dsw-alias-border-l2)',
      borderL4: 'var(--dsw-alias-border-l4)',
      label: 'var(--dsw-alias-label-primary)',
      labelSecondary: 'var(--dsw-alias-label-secondary)',
      labelTertiary: 'var(--dsw-alias-label-tertiary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    }
    /**
     * 官方**尺寸**：控件高度 / 内边距 / 字号 / 圆角。
     *
     * 与颜色不同，DSH 官方**没有**把尺寸做成 token。2026-10-08 核对了 app.asar 里的官方 CSS：
     *   - **有**尺寸变量：`--dsw-radius-{xs,sm,md,lg,xl,panel}`
     *     （`@deepseek-ai/dsh-client-ui-theme` 的 base CSS `:root{…}`：
     *     `--dsw-radius-xs:4px;--dsw-radius-sm:8px;--dsw-radius-md:12px;--dsw-radius-lg:16px;`
     *     `--dsw-radius-xl:20px;--dsw-radius-panel:28px`），
     *     以及 `--dsw-focus-ring-width:2px`。
     *     官方 Button / Input / Menu / Modal 的圆角全部走 `var(--dsw-radius-*)`。
     *   - **没有**尺寸变量：不存在 `--dsw-size-*` / `--dsw-space-*` / `--dsw-control-*`；
     *     `--dsw-font-*-{font-size,line-height}` 虽然存在（`--dsw-font-xs-13-font-size:13px` 等），
     *     但官方**控件规则本身并不消费它们**（`settings-form/fields.module.css` 的
     *     `.input` 与 `Button.module.css` 都写的是裸 `font-size:13px/14px`）。
     *
     * 所以这里分成两半，做法不同：
     *   1. **圆角走官方变量**（`var(--dsw-radius-*)`）——与颜色 token 同理，
     *      官方改了圆角，本插件自动跟随；
     *   2. **高度 / 内边距 / 字号/行高照抄官方的 px**，集中在这一张表里，每条注明
     *      `文件:行` 来源。这是**照抄、不是 token**：官方改了这些数，本插件**不会**自动跟随，
     *      只能靠浏览器 lane 的 `test/browser/sizes.test.mjs`（按官方同语义值断言）变红来提醒。
     *
     * 取值语义（都在设置页那一侧，因为设置页是本插件唯一有官方对照物的面板）：
     *   - `field`：**表单值控件**。官方
     *     `@deepseek-ai/dsh-client-ui-primitives/lib/settings-form/fields.module.css:107-118`
     *     的 `.input` → `height:34px`（:108）`padding:0 12px`（:109）
     *     `border-radius:var(--dsw-radius-md)`（:110）
     *     `border:.5px solid var(--dsw-alias-border-l4)`（:111）`font-size:13px`（:114）
     *     `line-height:1.5`（:115）。
     *     该文件是 `SettingsValueField`（text）与 `SettingsSecretField`（password）**唯一**的
     *     样式来源，两者同一个类，所以文本框 / 密码框 / 搜索框都挂它。
     *   - `select`：**2026-10-09 控件形态复刻**后，设置页不再用原生 `<select>`：
     *     官方 client 侧本来就没有原生 `<select>`，它的下拉是「自绘触发器 + 弹层」。
     *     触发器取值来自官方「权限」那一行
     *     `@deepseek-ai/dsh-client-ui-permission-presets/lib/client.js:438`
     *     的 `PermissionRow.module.css` → `.selector{border-radius:var(--dsw-radius-md);
     *     background:var(--dsw-alias-bg-module-platform);height:36px;color:var(--dsw-alias-label-primary);
     *     cursor:pointer;border:none;align-items:center;gap:12px;padding:0 14px;font-size:14px;
     *     line-height:22px;display:inline-flex}`；弹层取值来自
     *     `primitives/lib/Menu.module.css`（`.list{padding:4px;min-width:144px;max-width:360px}`
     *     :11/:29/:33-34；`.item{min-height:34px;padding:6px 8px;border-radius:var(--dsw-radius-md);
     *     font-size:13px;line-height:20px}` :95-110；`.item:hover{background:var(--dsw-alias-interactive-bg-hover)}`
     *     :112-114；`.selected` :216-218；`.check{width:14px;height:14px}` :178-182/:209-212）。
     *   - `search`：官方「搜索插件」的搜索框（`dsh-client-ui-settings-plugin-inventory/lib/client.js:57`
     *     的 `RotMhW_search`）→ `input{height:36px;padding:0 34px 0 36px;font-size:13px;
     *     border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l4);
     *     background:var(--dsw-alias-bg-layer-1)}`、`>svg{position:absolute;left:12px}`。
     *     它与表单值字段（`field`）**不是同一个组件**：官方搜索框是"label 包 icon + input"，
     *     高 36 / 底 `bg-layer-1`；表单值字段是裸 `<input class=.input>`，高 34 / 底 `bg-layer-3`。
     *     逐项差异记在 `test/browser/sizes.test.mjs` 的 `OFFICIAL_SEARCH`。
     *   - `stepper`：官方「字号大小」步进器（`dsh-client-ui-theme/lib/client.js:1013`
     *     的 `FontSizeRow.module.css`）→ `.stepper{border-radius:var(--dsw-radius-md);
     *     background:var(--dsw-alias-bg-module-platform);min-width:72px;height:36px}`、
     *     `.value{font-variant-numeric:tabular-nums;min-width:18px;font-size:14px;line-height:22px}`、
     *     `.unit{color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}`、
     *     `.arrows{flex-direction:column;gap:2px;position:absolute;right:8px}`、
     *     `.arrow{width:17px;height:12px;border-radius:var(--dsw-radius-xs)}`。
     *     官方靠 hover/focus-within 才把箭头显形；本插件**常显**（键盘可达性优先，见该处注释）。
     *   - `row`：官方设置页的**行式**布局（`PermissionRow.module.css:438` 的 `.row` 与
     *     `FontSizeRow.module.css:1013` 的 `.row` 是同一套：
     *     `{align-items:center;gap:8px;padding:16px 0;display:flex;border-bottom:.5px solid
     *     var(--dsw-alias-border-l2)}`；左列 `.rowText{flex-direction:column;flex:1;gap:4px;
     *     min-width:0;padding-right:48px;display:flex}`；标题 `.title{font-size:14px;font-weight:400;
     *     line-height:22px}`；说明 `.desc{color:var(--dsw-alias-label-tertiary);font-size:12px;
     *     line-height:18px}`）。注意：官方**表单值字段**（`SettingsValueField`）反而是"标签在
     *     输入框上方"的堆叠式——行式与堆叠式在官方是**两类**设置项，本插件设置页统一取行式。
     *   - `button`：官方 `primitives/lib/Button.module.css:27-33` 的 `.sm`
     *     → `height:28px`（:29）`font-size:12px`（:30）`line-height:18px`（:31）
     *     `padding:0 10px`（:32）`border-radius:var(--dsw-radius-sm)`（:33），
     *     也是设置页里**行内动作按钮**的实际尺寸（`settings-models/lib/client.js:58` 的
     *     `._3nPmjq_rowActions ._3nPmjq_secondaryButton` / `._3nPmjq_dangerButton`
     *     就是 28px + `radius-sm` + `0 10px` + 12px/18px）。
     *     本插件的按钮全是行内动作（刷新 / 回收站 / 全选 / 导出 / 删除 / 查看器翻页），
     *     所以照 `.sm` 这一档，而不是 36px 的默认档（`.md`，同文件 :24）。
     *   - `tag`：官方 `primitives/lib/Tag.module.css:5-13` 的 `.tag`
     *     → `padding:1px 8px`（:9）`font-size:11px`（:10）`line-height:17px`（:11）
     *     `border-radius:999px`（:7）（胶囊几何固定，只有配色随 tone 变）。
     *   - `pill`：官方 `primitives/lib/Pill.module.css:1-13` 的 `.pill`
     *     → `height:24px`（:5）`padding:0 8px`（:6）`border-radius:999px`（:8）
     *     `font-size:12px`（:10）`line-height:18px`（:11）。
     *   - `card`：官方设置卡片，`dsh-client-ui-settings-models/lib/client.js:58` 的
     *     `._3nPmjq_rowCard` → `border:.5px solid var(--dsw-alias-settings-card-stroke);
     *     background:var(--dsw-alias-settings-card-fill); border-radius:var(--dsw-radius-xl);
     *     gap:12px; padding:12px 14px`（同文件 `._3nPmjq_editor` / `._3nPmjq_addCard` 是
     *     `border-radius:var(--dsw-radius-lg); padding:14px 16px`；本插件取前者：卡片 + 12px 间距）。
     *   - 文字层级：节标题 16px/24px/500 = `settings-models/lib/client.js:58` 的
     *     `._3nPmjq_title`（`font-size:16px; font-weight:500; line-height:24px`）；
     *     次文字 12px/18px = 同文件的 `._3nPmjq_intro` / `_3nPmjq_advancedHint` /
     *     `_3nPmjq_modelCatalogMeta`；次级标题 13px/20px/500 =
     *     `primitives/lib/settings-form/fields.module.css:20-26` 的 `.label`
     *     （`font-size:13px`（:23）`font-weight:500`（:24）`line-height:1.5`（:25））。
     *
     * **颜色不进这张表**：颜色一律走上面的 `T`（`--dsw-*` 色 token）。
     */
    const S = Object.freeze({
      // 官方圆角变量（会跟随官方主题）
      // `--dsw-radius-xs` 是 2026-10-11 随厂商卡片引入的：官方厂商标头上的 `._3nPmjq_rowTag`
      // 就是 `border-radius:var(--dsw-radius-xs)`（`settings-models/lib/client.js:58`）。
      radiusXs: 'var(--dsw-radius-xs)',
      radiusSm: 'var(--dsw-radius-sm)',
      radiusMd: 'var(--dsw-radius-md)',
      radiusLg: 'var(--dsw-radius-lg)',
      radiusXl: 'var(--dsw-radius-xl)',
      // 表单值控件（fields.module.css .input）
      fieldHeight: '34px',
      fieldPad: '0 12px',
      fieldFontSize: '13px',
      fieldLineHeight: '1.5',
      /*
       * ── 官方「模型」设置页**本页**的输入控件（2026-10-12 修正偏差 ②）──────
       *
       * 与上面的 `field*` 是**两个不同的类**，官方同一页里并存：
       *   - `field*` = `primitives` 的 `settings-form/fields.module.css` 的 `.input`
       *     （34px / `0 12px` / 13px / `bg-layer-3`）—— 跨页面共享的表单值控件；
       *   - `modelsInput*` = `settings-models` 本页私有的 `._3nPmjq_input`
       *     （32px / `0 10px` / 14px/22px / `bg-layer-1`）—— 官方**厂商卡片编辑器里
       *     那三个字段**（Base URL / Gemini 原生 URL / API Key）与页内原生 `<select>`
       *     用的就是它；官方那一页的**拉取弹层搜索框**也复用它
       *     （`:843` 的 `className = input + candidateSearch`）。
       *
       * 出处 = `@deepseek-ai/dsh-client-ui-settings-models/lib/client.js:58` 那一行内联 CSS：
       *   `._3nPmjq_input{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);
       *    border-radius:var(--dsw-radius-md);width:100%;height:32px;font:inherit;
       *    background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
       *    padding:0 10px;font-size:14px;line-height:22px}`
       * 标记结构 = 同文件 `:1295` / `:1319` / `:1336`（`.field` 里的三枚 `<input>`）。
       * 行高按官方那一行的显式 `line-height:22px` 照抄（不是从 32px 反推的比例）。
       */
      modelsInputHeight: '32px',
      modelsInputPad: '0 10px',
      modelsInputFontSize: '14px',
      modelsInputLineHeight: '22px',
      /*
       * 自绘下拉触发器：**2026-10-12 起取「官方模型页本页」那一档**
       * （`._3nPmjq_input` = 32px / `0 10px` / 14px-22px），与页内三枚输入字段同高同档。
       *
       * 为什么从 `.selector`（`PermissionRow.module.css:438`，36px / `0 14px` /
       * `bg-module-platform`）换过来：本插件设置页的「厂商 / 模型 / 尺寸」下拉，语义上就是
       * 官方「模型」页 `:2288` 那枚 `<select className="input selectInput">` ——
       * **官方同语义控件就是 `._3nPmjq_input`（32px / `bg-layer-1`）**，而不是「权限」那一行的
       * `.selector`。原先取 `.selector` 是因为"官方 client 侧没有 `<select>`"，
       * 现在查明官方模型页**确实有** `<select>`（只是 `selectInput` 只加了箭头底图），
       * 所以同语义对照物换成这一枚。首次引入 `select` 时记的偏差见 `docs/contract-notes.md` §21.7。
       *
       * 保留 `.selector` 的两项：`gap:12px`（标签与 chevron 之间）与 `border:none`
       * （官方 `._3nPmjq_input` 有 0.5px 描边，但**我们这枚是触发器不是文本输入**，
       * 描边那一半仍按自绘触发器的形态走，`theme.test.mjs` 8.9 钉着"无描边"）。
       */
      selectHeight: '32px',
      selectPad: '0 10px',
      selectFontSize: '14px',
      selectLineHeight: '22px',
      selectGap: '12px',
      // 搜索框（settings-plugin-inventory/lib/client.js:57 的 RotMhW_search）
      searchHeight: '36px',
      searchPad: '0 34px 0 36px',
      searchFontSize: '13px',
      searchLineHeight: '1.5',
      searchIconLeft: '12px',
      searchIconSize: '16px',
      // 数字步进器（FontSizeRow.module.css，theme/lib/client.js:1013）
      stepperHeight: '36px',
      stepperMinWidth: '72px',
      stepperValueMinWidth: '18px',
      stepperFontSize: '14px',
      stepperLineHeight: '22px',
      stepperArrowWidth: '17px',
      stepperArrowHeight: '12px',
      stepperArrowGap: '2px',
      stepperArrowRight: '8px',
      // 设置页行式布局（PermissionRow / FontSizeRow 的 .row + .rowText）
      rowGap: '8px',
      rowPad: '16px 0',
      rowTextGap: '4px',
      rowTextPadRight: '48px',
      rowTitleFontSize: '14px',
      rowTitleLineHeight: '22px',
      rowDescFontSize: '12px',
      rowDescLineHeight: '18px',
      // 菜单弹层（Menu.module.css）
      menuPad: '4px',
      menuMinWidth: '144px',
      menuMaxWidth: '360px',
      menuItemHeight: '34px',
      menuItemPad: '6px 8px',
      menuItemFontSize: '13px',
      menuItemLineHeight: '20px',
      menuIconSize: '14px',
      menuOffset: '4px',
      /*
       * 弹层自身的**高度上限**与**最小可用高度**（2026-10-12，可搜索下拉 + 不被裁）。
       *
       * 320 = 官方候选列表的上限（`._3nPmjq_candidateList{max-height:320px}`，
       * `settings-models/lib/client.js:58`）—— 列表本身不小于这个约束。
       * 44 = 大约"一行选项 + 上下内边距"：可用空间再紧也不能给出一个完全看不见内容的盒子。
       * 注意它**可能**让弹层略微超出视口（例如极端矮窗口下两侧都只剩 10px）——
       * 那时"完整可见"与"看得见内容"是一对冲突目标，本插件选后者（见 §24.6，不粉饰）。
       */
      menuMaxHeightPx: '320px',
      menuMinHeightPx: '44px',
      /*
       * 带搜索框时不设 320 的内容上限：搜索框那一行（约 32 + 4 间距）是"外壳"，
       * 真正该受 320 约束的是**列表本身**（官方 `.candidateList{max-height:320px}`）。
       * 所以带搜索框的弹层总高上限 = 320 + 外壳，列表内部仍然按 320 收。
       * 两者都不越出视口：可用空间更小时取可用空间（见定位逻辑里的 `cap`）。
       */
      menuSearchMaxHeightPx: '360px',
      /*
       * 弹层内搜索框的左内边距：放大镜图标落在 `searchIconLeft:12px`（16px 见方），
       * 所以文字要从 12 + 16 + 2 = 30px 开始，图标才不压字。
       */
      searchPadLeft: '30px',
      // 行内动作按钮（Button.module.css .sm）
      buttonHeight: '28px',
      buttonPad: '0 10px',
      buttonFontSize: '12px',
      buttonLineHeight: '18px',
      // Tag / Pill
      tagPad: '1px 8px',
      tagFontSize: '11px',
      tagLineHeight: '17px',
      pillPad: '0 8px',
      pillHeight: '24px',
      pillFontSize: '12px',
      pillLineHeight: '18px',
      // 卡片
      cardPad: '12px 14px',
      cardGap: '12px',
      // 文字层级
      titleFontSize: '16px',
      titleLineHeight: '24px',
      subheadFontSize: '13px',
      subheadLineHeight: '20px',
      mutedFontSize: '12px',
      mutedLineHeight: '18px',

      /*
       * ── 厂商卡片：对齐官方「模型」设置页（2026-10-11）────────────────────────
       *
       * 全部出处 = `@deepseek-ai/dsh-client-ui-settings-models/lib/client.js:58` 那一行
       * 内联 CSS 里的 `._3nPmjq_*` 规则（标记结构在同文件 :2102-2234 / :454-519 / :725-884）。
       * 逐条对照与偏差记在 `docs/contract-notes.md` §23。
       */
      // ._3nPmjq_rows{gap:8px}
      vendorRowsGap: '8px',
      // ._3nPmjq_rowHead{gap:10px} / ._3nPmjq_rowIdentity{gap:6px}
      rowHeadGap: '10px',
      rowIdentityGap: '6px',
      // ._3nPmjq_rowName{font-size:14px;font-weight:500;line-height:22px}
      rowNameFontSize: '14px',
      rowNameLineHeight: '22px',
      // ._3nPmjq_rowTag{padding:1px 6px;font-size:11px;line-height:16px}
      rowTagPad: '1px 6px',
      rowTagFontSize: '11px',
      rowTagLineHeight: '16px',
      // ._3nPmjq_credentialDot{width:8px;height:8px}
      credentialDotSize: '8px',
      // ._3nPmjq_rowActions{gap:4px}
      rowActionsGap: '4px',
      // ._3nPmjq_editor{padding:14px 16px;gap:14px;border-radius:var(--dsw-radius-lg)}
      editorPad: '14px 16px',
      editorGap: '14px',
      // ._3nPmjq_editorHeader{gap:8px} + ._3nPmjq_editorTitle{14px/22px}
      editorHeaderGap: '8px',
      editorTitleFontSize: '14px',
      editorTitleLineHeight: '22px',
      // ._3nPmjq_editorRoute{12px/18px}
      editorRouteFontSize: '12px',
      editorRouteLineHeight: '18px',
      // ._3nPmjq_field{gap:6px} + ._3nPmjq_fieldLabel{12px/18px;font-weight:500}
      stackFieldGap: '6px',
      stackLabelFontSize: '12px',
      stackLabelLineHeight: '18px',
      // ._3nPmjq_editorActions{gap:8px}
      actionsGap: '8px',
      // ._3nPmjq_modelCatalog{gap:10px;padding-top:12px}
      catalogGap: '10px',
      catalogPadTop: '12px',
      // ._3nPmjq_modelCatalogTitle{12px/18px;font-weight:500} / …Meta{12px/18px}
      catalogTitleFontSize: '12px',
      catalogTitleLineHeight: '18px',
      catalogMetaFontSize: '12px',
      catalogMetaLineHeight: '18px',
      // ._3nPmjq_modelListHead{gap:12px}
      catalogHeadGap: '12px',
      /*
       * 模型列表（多选）取官方**候选列表**那一套 —— 我们这一块是"选择要保留哪些模型"，
       * 官方同语义的列表是拉取弹层里的 `.candidateList` / `.candidateLabel` / `.candidateId`
       * （同文件 :88-91），不是卡片里的可编辑 `.modelList` / `.modelEntry`。
       *   ._3nPmjq_candidateList{gap:2px} / ._3nPmjq_candidateLabel{padding:6px 8px;gap:8px}
       *   ._3nPmjq_candidate{border-radius:var(--dsw-radius-md)} / ._3nPmjq_candidateId{font-size:13px}
       */
      modelListGap: '2px',
      modelRowPad: '6px 8px',
      modelRowGap: '8px',
      modelRowFontSize: '13px',
      /*
       * 官方 `.candidateList{max-height:320px}`（`settings-models/lib/client.js:58`）。
       *
       * 2026-10-12：**改成与官方同值 320px**（此前是 240px，记在 §23.5-③ 的偏差）。
       * 早先不改的理由是"既有 jsdom 用例把它钉在 240px，改大等于放宽" —— 方向错了：
       * 目标是"与官方一致"，官方值就是标准，那条断言应当**按官方值更新**（更新断言 ≠ 放宽）。
       * "150 项不许把卡片撑爆"这条保证没有被削弱：`overflowY:auto` 与上限本身都在，
       * 只是上限从 240 挪到官方的 320 —— 断言仍然写着"必须有上限 + 内部滚动"。
       */
      modelScrollMaxHeight: '320px',
      // ._3nPmjq_modelEmpty{padding:12px;border-radius:var(--dsw-radius-lg);border:1px dashed …}
      emptyPad: '12px',
    })

    /**
     * token 的**半透明**变体：颜色仍然是 token 派生的
     * （`color-mix(in srgb, var(--dsw-…) X%, transparent)`），所以深浅色一起跟着变。
     *
     * 特意不用 CSS 的「当前颜色」关键字凑色：那样颜色跟着最近一层的 `color` 走，语义说不清，
     * 也拿不到"主题换了颜色就跟着换"这条可断言的事实。
     */
    const tint = (token, percent) =>
      'color-mix(in srgb, ' + token + ' ' + String(percent) + '%, transparent)'
    /** 浮层阴影：同样由 token 派生，避免写死黑色半透明阴影（深色主题下黑影是错的）。 */
    const shadow = (y, blur, percent) =>
      '0 ' + String(y) + 'px ' + String(blur) + 'px ' + tint(T.label, percent)

    /**
     * 状态色：状态徽标 / 进度环 / 缩略图边框共用一套语义（对齐官方 `StateDot`）。
     *
     * `run` 用 `labelTertiary` 而不是任何「品牌」色：官方 `StateDot` 的 `ongoing`
     * （唯一非圆点的状态：呼吸弧 + 旋转环）就是 `--dsw-alias-label-tertiary`。
     */
    const COLORS = { ok: T.success, fail: T.error, run: T.labelTertiary, track: T.idle }

    const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
    const isArray = Array.isArray
    const isString = (v) => typeof v === 'string'
    const isNumber = (v) => typeof v === 'number' && Number.isFinite(v)
    /** 把 px 字符串解析成数字；解析不出来给 0（而不是 NaN —— NaN 会让整条内联样式失效）。 */
    const px = (v) => {
      const n = Number.parseFloat(String(v))
      return Number.isFinite(n) ? n : 0
    }
    /** 夹取到 `[lo, hi]`；`hi < lo` 时以 `lo` 为准（极端窄屏下宁可略溢出也不给空盒子）。 */
    const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), Math.max(lo, hi))

    // ── URL 与取数 ──────────────────────────────────────────────────────────

    /** `file/<projectId>/<name>` 的完整 URL；name 取 `images/x.png` 的最后一段。 */
    function fileUrl(projectId, name) {
      if (BASE === null) return null
      if (!isString(projectId) || projectId === '') return null
      if (!isString(name) || name === '') return null
      const last = name.split('/').filter(Boolean).pop()
      if (last === undefined || last === '') return null
      try {
        return new URL(
          'file/' + encodeURIComponent(projectId) + '/' + encodeURIComponent(last),
          BASE,
        ).href
      } catch {
        return null
      }
    }

    function relativeUrl(path) {
      if (BASE === null) return null
      try {
        return new URL(path, BASE).href
      } catch {
        return null
      }
    }

    /**
     * 把宿主的内部错误翻译成**用户能据以行动**的提示。
     *
     * 背景：DSH 的两半不对称——客户端刷新即生效，宿主必须重启。宿主还是旧代码时，
     * 新接口会落到路由兜底并回 `unknown_route`，而它的 message 是内部路由片段
     * （如 `/providers/ofox/test`）。那条文案看起来像客户端拼错了 URL，
     * 实际是"宿主没重启"。这个歧义已经让用户白测过一轮，这里翻译掉。
     */
    const HOST_STALE_HINT = '宿主未加载此接口，请重启 DeepSeek Harness 后重试'

    function explainHostError(code, message) {
      if (code === 'unknown_route') return HOST_STALE_HINT
      return message
    }

    /**
     * 作品库写动作（导出 / 删除）失败时的**可行动**提示。
     *
     * 入参直接用 `apiPost` 返回的 `{ error, code }`（error 已经是可读文案）。
     *
     * `no_export_dir` 是语义变更后新增的一条：生图不再自动复制，导出必须由用户
     * 显式触发，因此"没配导出路径"是**正常分支**而不是异常。这里把它翻成一句
     * 指向设置页的话——**绝不静默失败**（方案里对复制提示词按钮的同一条红线）。
     */
    function explainProjectActionError(code, message) {
      const text = isString(message) ? message : ''
      if (code === 'no_export_dir') {
        return (
          '还没有配置「作品库导出路径」：请到 设置 → PixMart → 作品库导出路径 填一个绝对路径，再回来点「导出图片」。' +
          (text === '' ? '' : '（宿主原话：' + text + '）')
        )
      }
      return text === '' ? '操作失败' : text
    }

    /**
     * 导出前的**统一判定**：没配「作品库导出路径」就不要发那串注定失败的请求。
     *
     * 为什么要有这个 helper：导出有两个入口（详情页单个 / 多选工具条批量），
     * 此前**批量在客户端预检、详情页发出去靠宿主回 400** —— 用户看到的文案一致
     * （都过 `explainProjectActionError`），但**规则写在两处**。将来宿主改了错误码
     * 或校验口径，很可能只改一处，另一个入口就悄悄不一致了。
     *
     * 现在两个入口共用这一处判定；宿主的 400 仍然保留为**权威兜底**
     * （客户端手里的配置快照可能过时，那时预检会放行，由宿主拦下）。
     *
     * @param exportDir - 配置里的导出路径（可能为空串）。
     * @returns 通过时给出 trim 后的路径，否则给出可读原因。
     */
    function checkExportDir(exportDir) {
      const dir = isString(exportDir) ? exportDir.trim() : ''
      if (dir === '') {
        return { ok: false, error: explainProjectActionError('no_export_dir', '') }
      }
      return { ok: true, dir }
    }

    /** 取数助手：no-store + 形状校验 + 不抛异常。 */
    async function apiGet(path, validate) {
      if (BASE === null) return { ok: false, error: '无法解析插件基址' }
      const url = relativeUrl(path)
      if (url === null) return { ok: false, error: '无法解析请求地址' }
      try {
        const response = await fetch(url, { cache: 'no-store' })
        if (!response.ok) {
          // 失败响应里也可能带结构化 error（例如 unknown_route），先试着读出来，
          // 否则 GET 只会给一个干巴巴的 "HTTP 404"。
          const payload = await response.json().catch(() => null)
          const detail = isObject(payload) && isObject(payload.error) ? payload.error : {}
          const code = isString(detail.code) ? detail.code : 'http_' + String(response.status)
          const raw = isString(detail.message)
            ? detail.message
            : 'HTTP ' + String(response.status)
          return { ok: false, error: explainHostError(code, raw), code, status: response.status }
        }
        const body = await response.json().catch(() => null)
        if (typeof validate === 'function' && !validate(body)) {
          return { ok: false, error: '响应形状不符合预期' }
        }
        return { ok: true, data: body }
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : '请求失败' }
      }
    }

    /** 写请求：把宿主结构化 error 的 code/message 提出来，便于在卡片里显示可读原因。 */
    async function apiPost(path, body, validate) {
      if (BASE === null) return { ok: false, error: '无法解析插件基址' }
      const url = relativeUrl(path)
      if (url === null) return { ok: false, error: '无法解析请求地址' }
      try {
        const response = await fetch(url, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body === undefined ? {} : body),
        })
        const payload = await response.json().catch(() => null)
        if (!isObject(payload)) {
          return { ok: false, error: 'HTTP ' + String(response.status) + '：响应不是 JSON' }
        }
        if (payload.ok !== true) {
          const detail = isObject(payload.error) ? payload.error : {}
          const code = isString(detail.code) ? detail.code : 'http_' + String(response.status)
          // 把宿主的结构化 error 提到顶层，调用方不必再解一层。这里只搬
          // `code` / `message` 两个字符串，**绝不把整个 payload 当文案**。
          const message = isString(detail.message)
            ? detail.message
            : 'HTTP ' + String(response.status) + '：请求失败'
          return {
            ok: false,
            error: explainHostError(code, message),
            code,
            status: response.status,
            data: payload,
          }
        }
        if (typeof validate === 'function' && !validate(payload)) {
          return { ok: false, error: '响应形状不符合预期', status: response.status }
        }
        return { ok: true, data: payload, status: response.status }
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : '请求失败' }
      }
    }

    const isRunList = (v) => isObject(v) && v.ok === true && isArray(v.runs)
    const isRunDetail = (v) => isObject(v) && v.ok === true && isObject(v.run) && isArray(v.run.items)
    const isProjectList = (v) => isObject(v) && v.ok === true && isArray(v.projects)
    const isProjectDetail = (v) => isObject(v) && v.ok === true && isObject(v.project)
    const isTrashList = (v) => isObject(v) && v.ok === true && isArray(v.trash)
    const isProviders = (v) => isObject(v) && v.ok === true && isArray(v.providers)

    const isActive = (status) => ACTIVE_STATUSES.indexOf(status) >= 0
    const isTerminal = (status) => TERMINAL_STATUSES.indexOf(status) >= 0

    // ── 极简订阅 store（不引入状态库，也不跨插件 import 值） ─────────────────

    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          if (next === value) return
          value = next
          listeners.forEach((fn) => {
            try {
              fn(value)
            } catch {
              /* 单个订阅者出错不影响其他 */
            }
          })
        },
        subscribe(fn) {
          listeners.add(fn)
          return () => {
            listeners.delete(fn)
          }
        },
      }
    }

    const selectedProject = createStore(null)
    /** 预览状态的初值必须是对象：空闲与否统一由 `run === null` 表达。 */
    const previewEmptyState = () => ({
      run: null,
      activeRuns: [],
      stale: false,
      error: null,
      /** 当前显示的运行「首次被本页面看到」的时刻；用于区分「首屏恢复」与「新开始」。 */
      firstSeenAt: null,
    })
    const previewState = createStore(previewEmptyState())

    function useStore(store) {
      const [value, setValue] = React.useState(() => store.get())
      React.useEffect(() => store.subscribe(setValue), [store])
      return value
    }

    // ── 运行轮询（§8.5.4）：in-flight guard + 形状校验 + stale 快照 ──────────

    const SESSION_KEY = 'dsh-pixmart:seen-runs'

    /**
     * 首屏恢复基线：`sessionStorage` 记住「本标签页第一次开始观察的时刻」。
     * 刷新页面后它保持不变，于是仍在跑的运行会被识别为「恢复」→ 只显示徽标（§8.5.5）；
     * 之后新开始的运行（`startedAt` 晚于该时刻）才自动展开。
     */
    function readMountBaseline() {
      try {
        const raw = window.sessionStorage.getItem(SESSION_KEY)
        const parsed = raw === null ? null : JSON.parse(raw)
        if (isObject(parsed) && isNumber(parsed.mountedAt)) return parsed.mountedAt
      } catch {
        /* 忽略，退化为「本次观察即基线」 */
      }
      const mountedAt = Date.now()
      try {
        window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ mountedAt }))
      } catch {
        /* sessionStorage 不可用：退化为内存判断 */
      }
      return mountedAt
    }

    const baseline = { mountedAt: readMountBaseline() }

    /**
     * 本页面期间亲眼看它「在跑」过的运行 id。
     *
     * 结束态的徽标**只在这次页面期间真的跑过**时才出现：
     * 否则刷新页面后会把很久以前完成的历史运行当徽标长期挂在右下角（既非 §8.5.5 的
     * 「空闲即无 DOM」，也不是用户关心的内容）。进程内单例，跨 overlay 重挂保持。
     */
    const observedActive = new Set()

    /** 单例轮询器：`shell.overlay` 可能挂多处，但只允许有一条轮询链。 */
    const runPoller = (() => {
      let subscribers = 0
      let timer = null
      let inFlight = false
      /** 正在取增量详情的运行 id；null 表示只靠列表摘要。 */
      let watchRunId = null
      /** `state.run` 是否已经是「带 items 的详情」，而不是列表摘要。 */
      let runIsDetail = false
      /**
       * 「这一轮观察」的代际号。卸载后自增，用来丢弃已作废的异步响应；
       * 同时保证 client fiber 重建（HMR 重挂）后轮询能重新启动，而不是永久停摆。
       */
      let generation = 0
      let state = previewEmptyState()

      function emit() {
        previewState.set({ ...state })
      }

      function schedule(delay) {
        if (subscribers === 0) return
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(tick, delay)
      }

      function stopTimers() {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
      }

      /**
       * 采纳一条运行记录。
       * `startedAt` 早于本页面加载基线 → 首屏恢复（只显示徽标）；
       * 晚于基线 → 本页面加载之后新开始（自动展开）。
       */
      function adoptRun(run, isDetail) {
        state.run = run
        state.firstSeenAt = isNumber(run.startedAt) ? run.startedAt : Date.now()
        runIsDetail = isDetail === true
        watchRunId = isDetail === true || isActive(run.status) ? run.runId : null
        if (isActive(run.status)) observedActive.add(run.runId)
      }

      async function tick() {
        timer = null
        const current = generation
        if (subscribers === 0) return
        if (typeof document !== 'undefined' && document.hidden) {
          // 页面不可见时不发请求；回到可见时由 visibilitychange 立刻补一次
          schedule(POLL_IDLE_MS)
          return
        }
        if (inFlight) {
          schedule(POLL_ACTIVE_MS)
          return
        }
        inFlight = true
        try {
          // 1) 有正在观察的运行 → 取它的增量详情（列表摘要没有 items）
          if (watchRunId !== null) {
            const detail = await apiGet('api/runs/' + encodeURIComponent(watchRunId), isRunDetail)
            if (current !== generation || subscribers === 0) return
            if (detail.ok) {
              state.run = detail.data.run
              state.error = null
              state.stale = false
              runIsDetail = true
              if (!isActive(state.run.status)) watchRunId = null
            } else {
              state.error = detail.error
              if (state.run !== null) state.stale = true
              watchRunId = null
              runIsDetail = false
            }
            emit()
          }

          // 2) 列表：判断有没有活 / 发现新运行
          const list = await apiGet('api/runs?limit=' + String(RUN_LIST_LIMIT), isRunList)
          if (current !== generation || subscribers === 0) return
          if (!list.ok) {
            state.error = list.error
            if (state.run !== null) state.stale = true
            emit()
            schedule(state.run === null ? POLL_IDLE_MS : POLL_ACTIVE_MS)
            return
          }

          const runs = list.data.runs.filter(isObject)
          state.error = null
          state.stale = false
          state.activeRuns = runs.filter((run) => isActive(run.status))

          if (state.run === null) {
            // 空闲态：优先接住正在跑的；其次只在「本页面期间真的跑过」时保留终结徽标
            const running = state.activeRuns[0] ?? null
            const candidate =
              running ?? runs.find((run) => observedActive.has(run.runId)) ?? null
            if (candidate !== null) adoptRun(candidate, false)
          } else if (!runIsDetail) {
            // 还没有详情：用列表里的最新摘要（items 缺失，下一轮会被详情覆盖）
            const latest = runs.find((run) => run.runId === state.run.runId)
            if (latest !== undefined) state.run = latest
          }

          if (state.run === null) {
            // 真的空闲：停止轮询（§8.5.5「空闲时不渲染任何 DOM，并停止轮询」）
            stopTimers()
            emit()
            return
          }

          emit()
          schedule(isActive(state.run.status) ? POLL_ACTIVE_MS : POLL_IDLE_MS)
        } finally {
          inFlight = false
        }
      }

      function wake() {
        if (subscribers === 0) return
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(tick, 0)
      }

      return {
        start() {
          subscribers += 1
          if (subscribers === 1) wake()
        },
        stop() {
          subscribers = Math.max(0, subscribers - 1)
          if (subscribers === 0) stopTimers()
        },
        /**
         * client fiber 卸载：停表、清空快照、作废在途响应。
         * 不是「永久销毁」——fiber 重建后 overlay 重新 start()，轮询照常可用。
         */
        halt() {
          generation += 1
          stopTimers()
          subscribers = 0
          inFlight = false
          watchRunId = null
          runIsDetail = false
          state = previewEmptyState()
          previewState.set({ ...state })
        },
        /** 页面重新可见 / 用户操作后立刻同步一次。 */
        refresh: wake,
        /** 多任务切换：切到列表里的另一条运行（摘要，随后由详情补齐）。 */
        selectRun(run) {
          if (!isObject(run) || !isString(run.runId)) return
          adoptRun(run, false)
          emit()
          wake()
        },
        async cancel(runId) {
          if (!isString(runId)) return { ok: false, error: '缺少 runId' }
          const result = await apiPost('api/runs/' + encodeURIComponent(runId) + '/cancel')
          wake()
          return result
        },
        snapshot: () => ({ ...state }),
      }
    })()

    // ── 共享视觉原子 ────────────────────────────────────────────────────────

    const skin = {
      // 设置页（`settings.section`）用：那一层的滚动由设置弹窗自己负责，这里只管排版。
      wrap: {
        padding: '18px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        // 设置页的阅读宽度上限由**官方 section 自己**定的（官方各页 720~760px，
        // 见 `_3nPmjq_section` / `RotMhW_section`），这里照同一惯例，别再自己另起一套。
        maxWidth: '760px',
        // **不设底色**：官方设置页的 section 一律不画自己的表面
        // （`SettingsRoot.module.css` 里只有 `.wCInkW_panel{background:var(--dsw-alias-bg-layer-2)}`
        // 和 `.wCInkW_options{…overflow-y:auto}`，`options` 没有任何 background）。
        // 这一层的表面＝弹窗面板的 `bg-layer-2`，继承下来即可。
        //
        // 早先这里写的是 `T.bgBase`，那是**应用最底层**（深色 #151517），比弹窗面板
        // （`bg-layer-2` 深色 #2c2c2e）**更暗** —— 用户实测截图对比官方「通用设置」时
        // 看到的就是这块"纯黑"。错在把「应用底色」当成了「内容表面」。
        // 浏览器 lane 的 8.8 用官方同语义表面（`bg-layer-2`）的实际色值钉住这一点。
        color: T.label,
      },
      /**
       * 作品库面板（`main` 插槽）的根。
       *
       * 契约在 shell 那一侧：`ui-layout` 的 AppFrame 中栏是
       * `display:flex; flex-direction:column; overflow:hidden`，高度由网格行锁死
       * （`grid-template-rows:100%`）——**座位自己不给滚动**。所以面板必须自带滚动：
       * 根锁住高度，只有内容区滚。
       *
       * `minHeight: 0` 是关键：flex 子项默认 `min-height:auto`（= 内容高度），
       * 不解除这一条，根会被长提示词顶到内容那么高，超出中栏后被 `overflow:hidden`
       * 裁掉——滚轮没有任何可滚的盒子。
       * `boxSizing:'border-box'` 让 `height:100%` 把 padding 算在里面（否则超出 36px）。
       */
      panel: {
        padding: '18px',
        boxSizing: 'border-box',
        height: '100%',
        minHeight: 0,
        flex: '1 1 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        // 面板 = 页面之上的一层表面（DSH 的 `bg-layer-1`），文字用主题的主文字色。
        background: T.bgLayer1,
        color: T.label,
        // **故意不给 max-width**（早先是 `880px`，为可读性设的）。
        //
        // ui-layout 的 AppFrame 中栏（`.BynINW_centerCol`，见 asar 里的
        // AppFrame.module.css）只有 `flex-direction:column; min-width:0; display:flex;
        // overflow:hidden` —— **它自己不给任何宽度上限**，座位应当占满。
        // 先前那条 880px 是抄"聊天的阅读宽度"来的：1280px 视口下看不出问题，
        // 2560px 全屏下中栏有 2100px+，面板只吃 880px，右边就留出一大片空白
        // （用户实测截图即此）。
        //
        // 官方对 main 槽里的**面板**页（不是表单页）的惯例同样是占满宽度：
        // `settings-general` 的 `kh1pJG_page` 是 `width:100%`，
        // `schedule` 的 `S0jZwq_page` 是 `width:100%; height:100%`。
        // 长文本的可读性由内层容器各自决定，不该由"面板占位"来兜。
        // 浏览器 lane 的 `layout.test.mjs` 8 号用例在 1600×900 与 2560×900 下钉住
        // "内容区右边界 == 中栏右边界"。
      },
      /** 固定不滚的一层（表头 / 搜索 / 工具条）：滚动内容时它不动。 */
      bar: { flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: '14px' },
      /** 唯一滚动容器；`minHeight: 0` 是它在 flex 链里真能被压缩的前提。 */
      scroll: {
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
      },
      title: {
        margin: 0,
        fontSize: S.titleFontSize,
        lineHeight: S.titleLineHeight,
        fontWeight: 500,
      },
      /** 次要文字：用官方次文字 token，而不是"主文字降不透明度"这种本地近似。 */
      muted: { margin: 0, fontSize: S.mutedFontSize, lineHeight: S.mutedLineHeight, color: T.labelSecondary },
      /**
       * 卡片：嵌在面板里的一层，所以用 `bg-layer-2`（嵌套层）+ 一级边框。
       *
       * 尺寸照抄官方设置卡片 `._3nPmjq_rowCard`（`settings-models/lib/client.js:58`）：
       * `padding:12px 14px`，圆角取官方的 16px 那一档（`--dsw-radius-lg`，官方 `editor` /
       * `addCard` 用的就是它），描边取官方那一处的 0.5px 发丝线。
       * 逐项来源见上面 `S` 的表头注释。
       */
      card: {
        border: '0.5px solid ' + T.borderL1,
        background: T.bgLayer2,
        borderRadius: S.radiusLg,
        padding: S.cardPad,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: S.mutedFontSize,
        wordBreak: 'break-all',
      },
      key: { fontSize: S.mutedFontSize, color: T.labelSecondary, minWidth: '72px' },
    }

    /**
     * 胶囊小标签。几何照抄官方 `Tag.module.css` 的 `.tag`
     * （`padding:1px 8px; font-size:11px; line-height:17px; border-radius:999px`）。
     *
     * 类名 `pxm-pill` 只作测试/样式挂钩：尺寸对齐用例要在设置页里按**语义角色**找到它。
     */
    function Pill(props) {
      return h(
        'span',
        {
          className: 'pxm-pill',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            fontSize: S.tagFontSize,
            lineHeight: S.tagLineHeight,
            padding: S.tagPad,
            borderRadius: '999px',
            border: '1px solid ' + T.borderL2,
            background: tint(T.label, 8),
            whiteSpace: 'nowrap',
          },
        },
        props.children,
      )
    }

    function Notice(props) {
      return h(
        'div',
        {
          role: props.role ?? 'status',
          style: {
            ...skin.card,
            borderColor: T.borderL2,
            background: T.bgLayer2,
          },
        },
        h('strong', { style: { fontSize: S.subheadFontSize, lineHeight: S.subheadLineHeight } }, props.title),
        props.detail === undefined || props.detail === null
          ? null
          : h('p', { style: skin.muted }, String(props.detail)),
        props.children ?? null,
      )
    }

    function Spinner(props) {
      return h('span', {
        className: 'pxm-spin',
        role: 'progressbar',
        'aria-label': props.label ?? '加载中',
        style: {
          width: '13px',
          height: '13px',
          borderRadius: '50%',
          display: 'inline-block',
          flex: '0 0 auto',
          border: '2px solid ' + tint(T.labelSecondary, 40),
          borderTopColor: T.label,
        },
      })
    }

    /**
     * 行内动作按钮：尺寸照抄官方 `Button.module.css` 的 `.sm`（28px / 12px / 18px / 0 10px /
     * `--dsw-radius-sm`），也就是官方设置页里行内动作按钮实际用的那一档。
     * `boxSizing:'border-box'` 与官方 `.button` 一致：有高度时那 1px 描边算在 28px 里。
     * 逐项来源见上面 `S` 的表头注释。
     *
     * `data-pxm-role` 由调用方通过 `props.role` 传入：浏览器 lane 按**语义角色**定位
     * 控件而不是按类名（与 `Select` 同一做法，见 `test/browser/lane.js` 的 `toolbarRow`）。
     */
    function Btn(props) {
      const disabled = props.disabled === true
      return h(
        'button',
        {
          type: 'button',
          className: isString(props.className) ? 'pxm-btn ' + props.className : 'pxm-btn',
          ...(isString(props.role) && props.role !== '' ? { 'data-pxm-role': props.role } : {}),
          onClick: props.onClick,
          disabled,
          title: props.title,
          style: {
            font: 'inherit',
            boxSizing: 'border-box',
            fontSize: S.buttonFontSize,
            lineHeight: S.buttonLineHeight,
            height: S.buttonHeight,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: S.buttonPad,
            borderRadius: S.radiusSm,
            color: T.label,
            border: '1px solid ' + T.borderL2,
            background: tint(T.label, 8),
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            whiteSpace: 'nowrap',
          },
        },
        props.children,
      )
    }

    function LoadingRow(props) {
      return h(
        'div',
        { style: { ...skin.row, ...skin.muted } },
        h(Spinner, null),
        h('span', null, props.text),
      )
    }

    // ── ① settings.section：厂商（可写）/ 默认值（可写）/ 数据目录 / 累计用量 ──

    /** 「结果」小字：成功一行、失败一行；**绝不把任何密钥值放进来**。 */
    function Msg(props) {
      if (!isObject(props.result)) return null
      const failed = props.result.ok !== true
      return h(
        'span',
        {
          role: failed ? 'alert' : 'status',
          style: {
            fontSize: '12px',
            lineHeight: 1.6,
            color: failed ? T.error : T.success,
            wordBreak: 'break-word',
          },
        },
        String(props.result.text ?? ''),
      )
    }

    /**
     * 设置页字段：**行式**布局（标签 + 说明在左、控件右对齐）。
     *
     * 官方出处（两个包各有一份，取值完全一致，所以只抄一套）：
     *   - `@deepseek-ai/dsh-client-ui-permission-presets/lib/client.js:438`（「权限」那一行）
     *     的 `PermissionRow.module.css` → `.row{border-bottom:.5px solid var(--dsw-alias-border-l2);
     *     align-items:center;gap:8px;padding:16px 0;display:flex}`、
     *     `.rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}`、
     *     `.title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}`、
     *     `.desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}`。
     *   - `@deepseek-ai/dsh-client-ui-theme/lib/client.js:1013`（「字号大小」那一行）的
     *     `FontSizeRow.module.css` 是**逐字同一套**。
     *
     * 注意与官方**表单值字段**的分工：`primitives/lib/settings-form/fields.module.css`
     * 的 `.field`（:3-8）是 `flex-direction:column` 的**堆叠式**（`SettingsValueField`
     * 就是它）——官方设置页同时存在这两类设置项。本插件设置页统一取**行式**。
     *
     * 说明文字（`desc`）只有传了 `description` 才渲染；没有说明的行就是"单行标题 + 控件"，
     * 与官方「权限」以外的多数行一致。
     *
     * `htmlFor` / `controlId` 用来把 `<label>` 与右侧控件显式关联（原生 `<select>` 换成
     * 自绘触发器之后，`<label>` 包不住那个 `<button>`——包住会让点击弹层里的选项也命中 label）。
     */
    function Field(props) {
      const controlId = isString(props.controlId) ? props.controlId : undefined
      const labelId = isString(props.labelId)
        ? props.labelId
        : controlId === undefined
          ? undefined
          : controlId + '-label'
      const describedBy = isString(props.describedBy) ? props.describedBy : undefined
      return h(
        'div',
        {
          // `data-pxm-field` = 行式字段的**语义锚点**：浏览器 lane 靠它找"行"及其左列/右列，
          // 而不是靠类名（类名是实现细节，换个名字不该让断言失效）。
          'data-pxm-field': '1',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: S.rowGap,
            padding: S.rowPad,
            // 行与行之间的发丝分隔线：官方 `.row{border-bottom:.5px solid
            // var(--dsw-alias-border-l2)}`（`border-l2` 在官方那边正是行分隔线）。
            borderBottom: '0.5px solid ' + T.borderL2,
            minWidth: 0,
            ...(isObject(props.style) ? props.style : {}),
          },
        },
        h(
          'div',
          {
            'data-pxm-field-text': '1',
            style: {
              display: 'flex',
              flexDirection: 'column',
              flex: '1 1 auto',
              gap: S.rowTextGap,
              minWidth: 0,
              // 官方 `.rowText{padding-right:48px}`：左列与右列之间留出呼吸位。
              paddingRight: S.rowTextPadRight,
            },
          },
          h(
            'label',
            {
              'data-pxm-field-label': '1',
              ...(controlId === undefined ? {} : { htmlFor: controlId }),
              ...(labelId === undefined ? {} : { id: labelId }),
              style: {
                color: T.label,
                fontSize: S.rowTitleFontSize,
                fontWeight: 400,
                lineHeight: S.rowTitleLineHeight,
              },
            },
            props.label,
          ),
          props.description === undefined || props.description === null
            ? null
            : h(
                'span',
                {
                  'data-pxm-field-desc': '1',
                  ...(describedBy === undefined ? {} : { id: describedBy }),
                  style: {
                    color: T.labelTertiary,
                    fontSize: S.rowDescFontSize,
                    fontWeight: 400,
                    lineHeight: S.rowDescLineHeight,
                  },
                },
                props.description,
              ),
        ),
        // 右列：控件。`flexShrink: 0` 让控件保持自己的尺寸，长标签在左列内部换行。
        h(
          'div',
          {
            'data-pxm-field-control': '1',
            style: { display: 'flex', alignItems: 'center', flexShrink: 0, minWidth: 0 },
          },
          props.children,
        ),
      )
    }

    /**
     * **堆叠式**字段：官方 `._3nPmjq_field` / `._3nPmjq_fieldLabel`
     * （`settings-models/lib/client.js:58`，标记结构见同文件 :1289-1305）——
     * `{flex-direction:column;gap:6px}` + 标签
     * `{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}`，
     * **标签在上、控件在下**。
     *
     * 为什么设置页里同时存在行式 `Field` 与这个堆叠式：官方本身就是**两类**设置项 ——
     * 「权限」「字号大小」是行式（`.row` + `.rowText`），而**厂商卡片编辑器里的输入字段**
     * 是堆叠式（`.field` + `.fieldLabel`，Base URL / API Key 就在里面）。
     * 2026-10-11 复刻时按官方分工各自取用，不是"两套随便挑"。
     *
     * 锚点是 `data-pxm-editor-field` / `-label` / `-control`（语义锚点，浏览器 lane 按它定位），
     * **刻意不复用** `data-pxm-field`：那个锚点属于行式 `Field`，混用会让
     * `test/browser/layout.test.mjs` 7.1 的"行式"几何断言把这里的堆叠字段也算进去。
     */
    function EditorField(props) {
      const controlId = isString(props.controlId) ? props.controlId : undefined
      const describedBy = isString(props.describedBy) ? props.describedBy : undefined
      return h(
        'div',
        {
          'data-pxm-editor-field': '1',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: S.stackFieldGap,
            minWidth: 0,
            ...(isObject(props.style) ? props.style : {}),
          },
        },
        h(
          'label',
          {
            'data-pxm-editor-field-label': '1',
            ...(controlId === undefined ? {} : { htmlFor: controlId }),
            ...(describedBy === undefined ? {} : { id: describedBy }),
            style: {
              color: T.labelSecondary,
              fontSize: S.stackLabelFontSize,
              fontWeight: 500,
              lineHeight: S.stackLabelLineHeight,
            },
          },
          props.label,
        ),
        h(
          'div',
          {
            'data-pxm-editor-field-control': '1',
            style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
          },
          props.children,
        ),
      )
    }

    /**
     * 厂商标头上的**小标签**：官方 `._3nPmjq_rowTag`
     * （`settings-models/lib/client.js:58`）——
     * `{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);
     * color:var(--dsw-alias-label-secondary);padding:1px 6px;font-size:11px;line-height:16px}`。
     *
     * 与 `Pill` 的分工：`Pill` 是官方 `Tag`（胶囊、999px 圆角、1px 8px、11/17），
     * 用于页面级标签；rowTag 是**厂商标头行**里那一枚方角小标签。官方是两枚不同的类，
     * 本插件也保持两枚不同的组件。
     *
     * 描边用 `T.borderL2`（官方 `--dsw-alias-border-l3` 在浅色 `#0000001f`、深色 `#ffffff29`，
     * 与 `border-l2` 的 `#0000001a` / `#ffffff1f` 只差 5/255 的 alpha；本插件 token 清单里
     * 没有 l3，本次不为它扩容 —— 偏差记在 `docs/contract-notes.md` §23）。
     */
    function RowTag(props) {
      return h(
        'span',
        {
          className: 'pxm-row-tag',
          // 语义锚点：浏览器 lane 按它量这一枚小标签的几何（不按类名）。
          'data-pxm-row-tag': '1',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            flex: 'none',
            padding: S.rowTagPad,
            border: '0.5px solid ' + T.borderL2,
            borderRadius: S.radiusXs,
            color: T.labelSecondary,
            fontSize: S.rowTagFontSize,
            lineHeight: S.rowTagLineHeight,
            whiteSpace: 'nowrap',
          },
        },
        props.children,
      )
    }

    /**
     * 凭据状态点：官方 `._3nPmjq_credentialDot` + `…Configured` / `…Missing`
     * （`settings-models/lib/client.js:58`，标记结构见同文件 :2176-2186）——
     * 8px 圆点，已配置 = `state-success-primary`、缺失 = `state-error-primary`。
     *
     * 状态**不只靠颜色**：官方给的是 `role="img"` + `aria-label` + `title`，本插件照抄
     * （读屏与悬停都能拿到"密钥已就位 / 密钥缺失"这句原话）。
     */
    function CredentialDot(props) {
      const ok = props.ok === true
      const label = String(ok ? props.onLabel : props.offLabel)
      return h('span', {
        className: 'pxm-credential-dot',
        'data-pxm-credential-dot': '1',
        role: 'img',
        'aria-label': label,
        title: label,
        style: {
          display: 'inline-block',
          flex: 'none',
          boxSizing: 'border-box',
          width: S.credentialDotSize,
          height: S.credentialDotSize,
          borderRadius: '50%',
          background: ok ? T.success : T.error,
        },
      })
    }

    /**
     * **链接式**动作按钮：官方 `._3nPmjq_linkButton`
     * （`settings-models/lib/client.js:58`）——
     * `{border-radius:var(--dsw-radius-sm);height:28px;padding:0 10px;font-size:12px;
     * line-height:18px;color:var(--dsw-alias-label-tertiary);background:0 0;border:none}`。
     *
     * 官方用它承载「获取模型」（同文件 :749-758 的 `fetchModels`）与「全选 / 全不选」
     * （`primitives` 的 `Button variant="ghost" size="sm"`，同文件 :851-857）——
     * 位置与档位都照抄：模型区块标题行右侧那一枚、以及候选列表工具条里那几枚。
     *
     * hover 与 focus 环：官方是 `background:var(--dsw-alias-interactive-bg-hover)` +
     * `box-shadow:0 0 0 2px var(--dsw-focus-ring-color,…)`。那两个 token 不在本插件清单里，
     * 所以走既有约定（同 `SelectField` 的处理）：hover = `label-tertiary` 派生的 12% 半透明，
     * focus = `label-tertiary` 的 2px 外描边 —— 颜色仍然只来自 token。
     * 两条伪类规则在文件末的 `CSS` 里（内联样式写不了 `:hover`）。
     */
    function LinkButton(props) {
      const disabled = props.disabled === true
      return h(
        'button',
        {
          type: 'button',
          className: 'pxm-link-btn',
          ...(isString(props.role) && props.role !== '' ? { 'data-pxm-role': props.role } : {}),
          onClick: props.onClick,
          disabled,
          title: props.title,
          style: {
            font: 'inherit',
            boxSizing: 'border-box',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: S.buttonHeight,
            padding: S.buttonPad,
            border: 'none',
            background: 'transparent',
            borderRadius: S.radiusSm,
            color: T.labelTertiary,
            fontSize: S.buttonFontSize,
            lineHeight: S.buttonLineHeight,
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.4 : 1,
            whiteSpace: 'nowrap',
          },
        },
        props.children,
      )
    }

    /**
     * 官方图标画法（**手写内联 SVG，不引任何图标库**）。
     *
     * 每条路径逐字抄自官方 primitives 里同一枚图标的 artwork（`size` 默认 16、
     * `viewBox:"0 0 16 16"`、`fill:"none"`、`strokeWidth` 1、`aria-hidden:"true"`）：
     *   - `search`：`primitives/lib/index.js:266-279` 的两条 path
     *   - `check` ：`primitives/lib/index.js:425-429`
     *   - `chevronDown`：`primitives/lib/index.js:491-495`
     *   - `chevronUp`  ：`primitives/lib/index.js:587-591`
     *
     * **与官方的一处有意偏离**：官方 artwork 写的是 `stroke:"currentColor"`，由外层
     * `color` 决定描边色。本插件改成**显式传 token**（`props.color`），因为
     * `test/client-tokens.test.mjs` 有一条"不许用当前颜色关键字凑色"的静态红线：
     * 半透明/跟随色必须显式挂在 token 上，否则"主题换了颜色就跟着换"这条事实
     * 就没有可断言的载体。调用方一律传 `T.*`，画出来的颜色与官方一致。
     */
    const ICON_PATHS = Object.freeze({
      search: [
        'M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z',
        'M10.2991 10.3933L14.7783 14.8725',
      ],
      check: ['M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4'],
      chevronDown: ['M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6'],
      chevronUp: ['M12 10L8.70711 6.70711C8.31658 6.31658 7.68342 6.31658 7.29289 6.70711L4 10'],
      // 2026-10-12（可搜索下拉的「清空」按钮）：官方 `IconCloseOutlineRegular`
      // （`primitives/lib/index.js`，与 `search` / `check` 同一处 artwork 集）。
      close: ['M4 4L12 12', 'M12 4L4 12'],
    })

    function Icon(props) {
      const paths = ICON_PATHS[props.name]
      if (!isArray(paths)) return null
      const size = props.size === undefined ? 16 : props.size
      return h(
        'svg',
        {
          className: props.className,
          width: String(size),
          height: String(size),
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          strokeWidth: 1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          style: props.style,
          ...(props.testId === undefined ? {} : { 'data-pxm-icon': props.testId }),
        },
        paths.map((d, index) =>
          h('path', { key: 'p' + String(index), d: d, stroke: props.color }),
        ),
      )
    }

    /**
     * 表单值控件的**尺寸**：照抄官方 `settings-form/fields.module.css` 的 `.input`
     * （34px 高 / `0 12px` / 13px / `--dsw-radius-md`）。逐项来源见上面 `S` 的表头注释。
     *
     * 这里**只动尺寸**：底色（`bg-layer-3`）与描边（`border-l4`）两条仍然照旧，
     * 它们的官方出处见下面各自的注释（8.9 用例钉着）。
     */
    const inputStyle = {
      font: 'inherit',
      boxSizing: 'border-box',
      height: S.fieldHeight,
      fontSize: S.fieldFontSize,
      lineHeight: S.fieldLineHeight,
      padding: S.fieldPad,
      borderRadius: S.radiusMd,
      color: T.label,
      // **输入控件层**：官方设置页的表单字段（`primitives` 的
      // `settings-form/fields.module.css` 里 `.input`）挂的是 `--dsw-alias-bg-layer-3`；
      // 那是 `SettingsValueField`（text）与 `SettingsSecretField`（password）**同一个类**，
      // `TextInput` / `Select` 因此一起挂这一层（下拉没有官方对应物：官方 client 侧
      // 没有任何 `<select>`，语义上它是"同一枚表单控件"，所以用同一层）。
      //
      // 早先这里是 `T.bgBase`（深色 #151517）—— 那是**应用最底层**（窗口底 / body），
      // 嵌在设置面板里比面板本身还暗，观感是"输入框塌进去了"。深色下四层互不相同
      // （bg-base / layer-1 / layer-2 / layer-3），浏览器 lane 的 8.9 用**官方解析值**
      // 钉住这一点，并断言它既不是 bg-base 也不是 bg-layer-2。
      background: T.bgLayer3,
      // 边框同样照抄官方表单控件那一处：`.input{border:0.5px solid var(--dsw-alias-border-l4)}`
      // （`primitives/Input.module.css` 的 `.wrap`、`settings-plugin-inventory` 的搜索框
      // 也都是 `border-l4`；`border-l1/l2` 在官方那边是分隔线与卡片描边，不是控件描边）。
      // 宽度是官方的 **0.5px 发丝线**（`.input{border:.5px solid …}`，fields.module.css:111）。
      border: '0.5px solid ' + T.borderL4,
      width: '100%',
      // `width:100%` 只是"想占满"，真正让它随容器**收窄**的是 minWidth:0：
      // 否则长值（绝对路径）会把输入框顶到自己的固有宽度上。
      minWidth: 0,
      boxSizing: 'border-box',
    }

    /**
     * **官方「模型」设置页本页**那一枚输入控件的样式（2026-10-12 修正偏差 ②）。
     *
     * 与上面的 `inputStyle` 是**同一页里两个并存的官方类**，不是"两种口味随便挑"：
     *   - `inputStyle` → `primitives` 的 `settings-form/fields.module.css` 的 `.input`
     *     （34px / `0 12px` / 13px / `bg-layer-3`）：官方**跨页面共享**的表单值控件。
     *     本插件设置页里**不属于官方「模型」页**的表单字段（「作品库导出路径」那枚
     *     文本框、作品库工具条的排序下拉、提示词降级文本域）仍旧用它 —— 它们没有
     *     "官方模型页本页"这一层对照物。
     *   - `modelsPageInputStyle`（本对象）→ `settings-models` **本页私有**的 `._3nPmjq_input`
     *     （32px / `0 10px` / 14px-22px / `bg-layer-1`）：官方那一页的**编辑块三字段**
     *     （Base URL / Gemini 原生 URL / API Key）与页内 `<select>` 都是它。
     *
     * 出处见上面 `S` 里 `modelsInput*` 那一段（`settings-models/lib/client.js:58` 的规则原文）。
     * 底色是 `bg-layer-1`（官方原文 `background:var(--dsw-alias-bg-layer-1)`）。
     */
    const modelsPageInputStyle = {
      font: 'inherit',
      boxSizing: 'border-box',
      height: S.modelsInputHeight,
      padding: S.modelsInputPad,
      fontSize: S.modelsInputFontSize,
      lineHeight: S.modelsInputLineHeight,
      borderRadius: S.radiusMd,
      color: T.label,
      background: T.bgLayer1,
      // 描边与 `inputStyle` 同一枚（官方两个类都写 `border:.5px solid var(--dsw-alias-border-l4)`）。
      border: '0.5px solid ' + T.borderL4,
      width: '100%',
      minWidth: 0,
    }

    function TextInput(props) {
      return h('input', {
        type: props.type ?? 'text',
        // 类名只用于测试/样式挂钩，不影响行为
        ...(isString(props.className) && props.className !== '' ? { className: props.className } : {}),
        ...(isString(props.id) ? { id: props.id } : {}),
        style: { ...inputStyle, ...(isObject(props.style) ? props.style : {}) },
        value: props.value ?? '',
        placeholder: props.placeholder,
        disabled: props.disabled === true,
        autoComplete: props.autoComplete ?? 'off',
        spellCheck: false,
        onChange: props.onChange,
        onBlur: props.onBlur,
      })
    }

    /**
     * 原生 `<select>`。**只留给作品库工具条的「排序」**：官方的排序控件在
     * `SettingsRoot` 那一侧没有对应形态，作品库里也没有官方对照物，所以保持原生
     * （语义天然可访问、平台行为稳定）。设置页一律用下面的 `SelectField`。
     *
     * `data-pxm-role` 由调用方通过 `props.role` 传入（浏览器 lane 按**语义角色**定位
     * 控件，不按类名 —— 见 `test/browser/lane.js` 的 `toolbarRow`）。
     */
    function Select(props) {
      const options = isArray(props.options) ? props.options : []
      return h(
        'select',
        {
          ...(isString(props.className) && props.className !== '' ? { className: props.className } : {}),
          ...(isString(props.role) && props.role !== '' ? { 'data-pxm-role': props.role } : {}),
          style: { ...inputStyle, ...(isObject(props.style) ? props.style : {}) },
          value: props.value ?? '',
          disabled: props.disabled === true,
          onChange: props.onChange,
        },
        ...options.map((option, index) =>
          h('option', { key: 'o' + String(index), value: option.value }, option.label),
        ),
      )
    }

    /**
     * 自绘下拉：**触发器 + 可搜索弹层**。
     *
     * 官方的两处对照物各管一半（2026-10-12 复核后分工如下）：
     *   - **触发器**取官方「模型」设置页**本页**那一枚 ——
     *     `._3nPmjq_input{height:32px;padding:0 10px;font-size:14px;line-height:22px;
     *     background:var(--dsw-alias-bg-layer-1)}` +
     *     `select._3nPmjq_input{cursor:pointer}`（`settings-models/lib/client.js:58`，
     *     标记结构见同文件 `:2288` 的 `<select className="input selectInput">`）。
     *     也就是说：官方这一页**确实有** `<select>`，它用的就是本页私有的输入类。
     *     `gap:12px`（标签与 chevron 之间）与"无描边"仍沿用官方自绘触发器的形态
     *     （`PermissionRow.module.css` 的 `.selector`：`gap:12px; border:none`）。
     *     展开时 `aria-expanded=true`，chevron 旋转 180°（官方 `.chevronOpen`）。
     *   - **弹层**是 `Menu` 的卡片：`padding:4px` + `radius-lg` + 阴影，行是
     *     `role="menuitem"` 的按钮（34px 高 / `6px 8px` / `radius-md` / 13px-20px），
     *     hover 与键盘焦点都是 `--dsw-alias-interactive-bg-hover`，
     *     **当前项在行尾带一枚 ✓**（官方 `Menu` 的 `selected && selection === 'check'`
     *     渲染 `IconCheckOutlineRegular`，index.js:4198 + `Menu.module.css:209-212`）。
     *     宽度跟触发器一致（原生 `<select>` 的弹层也是这个宽），高度上限取官方候选列表的
     *     `._3nPmjq_candidateList{max-height:320px}`。
     *
     * 可用性按需求**不弱于**原生 `<select>`：
     *   - `Tab` 能进触发器（原生 `<button>`）；`Enter` / `Space` 展开（`<button>` 原生的
     *     激活行为就是 keydown Enter/Space → click，不用自己接管）；
     *   - 展开后 `↑↓` 在选项间移动真实焦点（照官方 `Menu` 的"箭头走真焦点"做法），
     *     `Home` / `End` 到首尾；`Esc` 关闭并把焦点交回触发器；
     *   - 点外部关闭；`aria-haspopup="menu"` / `aria-expanded` / `role="menu"` /
     *     `role="menuitem"` / `aria-checked` 齐备；焦点可见用 `--dsw-*` 色的 focus 环。
     *   - **长列表可搜索**（2026-10-12，用户反馈"16 个模型弹出列表太长"）：
     *     选项数 > 8 时弹层顶部多一个搜索框（大小写不敏感子串过滤 + 清空按钮），
     *     `↑↓` 只在过滤结果内移动、`Enter` 选中、无结果给可读空态；
     *     焦点在列表容器上时直接打字符会自动转进搜索框。见 `SEARCH_MIN_OPTIONS` 的注释。
     *
     * 弹层的定位（2026-10-12 修正偏差 ③）：
     *
     * 早先弹层是 `position: absolute` + `top: calc(100% + 4px)`，挂在触发器外面那层
     * `position: relative` 上。**这条路径会被祖先裁掉**：真实 shell 里设置弹窗
     * （`SettingsRoot.module.css` 的 `.wCInkW_options{overflow-y:auto}`，本 lane 的
     * `shell.html` 用 `#settingsDialog{overflow:auto}` 复刻同一条链）就是滚动/裁切容器，
     * 触发器靠近它下边界时弹层被切掉一半。
     *
     * 现在改成 `position: fixed` + **自身翻转 / 夹取**：打开时量一次触发器，
     * 空间够就向下、不够就翻到上方、两侧都不够就按可用空间收 `maxHeight`，
     * 左右再夹进视口。**位置与上限都在内联样式里**（`top` / `left` / `maxHeight`），
     * 所以浏览器 lane 能直接断言"弹层完整落在视口内"。
     *
     * 为什么不用 portal（`document.body` + 手工 append）：React 18 的合成事件走
     * **根容器委托**，手工 append 到 body 的节点不在根容器里 ⇒ 选项上的 `onClick`
     * 会失效（要靠额外监听器打补丁，反而更脆）；而 `position: fixed` 同样脱离祖先
     * 裁切（唯一例外是祖先带 `transform`/`filter`/`contain`，那会为 fixed 建立包含块
     * —— 本插件与官方 shell 都不这么写）。代价：弹层仍挂在字段的 DOM 子树里（对
     * 探针与"点外部关闭"是好事，见下面 `onPointerDown`），需要自己跟一次滚动/尺寸变化。
     */
    function SelectField(props) {
      const options = isArray(props.options) ? props.options : []
      const value = props.value ?? ''
      const disabled = props.disabled === true
      const [open, setOpen] = React.useState(false)
      const [activeIndex, setActiveIndex] = React.useState(0)
      const [keyword, setKeyword] = React.useState('')
      const triggerRef = React.useRef(null)
      const listRef = React.useRef(null)
      const searchRef = React.useRef(null)
      /**
       * 弹层的位置与高度上限。初值 = "向下、跟触发器同左、不超过视口高"，打开后
       * 由 `useLayoutEffect` 量真实触发器纠正 —— 所以**没有"先画错再跳"的闪烁**。
       */
      const [place, setPlace] = React.useState(() => ({
        up: false,
        anchor: 0,
        left: 0,
        width: 0,
        // 初值只是"打开那一帧"的占位：真正的值在 useLayoutEffect 里量到触发器后写入，
        // 所以取同一枚上限常量（`S.menuMaxHeightPx`）而不是另一处硬编码的 px。
        maxHeight: Number.parseFloat(String(S.menuMaxHeightPx)),
      }))
      const selectedIndex = options.findIndex((option) => String(option.value) === String(value))
      const current = selectedIndex >= 0 ? options[selectedIndex] : null
      const currentLabel = current === null ? '' : String(current.label ?? current.value ?? '')

      /*
       * 搜索框只在长列表上出现，阈值 8。依据：官方给候选列表配搜索框的那一页
       * （`settings-models` 的拉取弹层）列表动辄几十上百项；而本插件其它两枚下拉
       * （厂商 1~3 家、尺寸 3~8 个）在 8 项以内一屏就能看全 —— 多一个搜索框只会让弹层
       * 更高、还多一次 Tab。所以**不是**全站统一启用能力：短列表保持"纯 ↑↓"的原形态。
       */
      const SEARCH_MIN_OPTIONS = 8
      /**
       * 能力开关：判定用**选项总数**（`options.length`），不用可见项数 ——
       * 用可见项数的话，"打开 16 项 → 打 `flux` → 结果只剩 2 项"会把搜索框自己抽掉，
       * 用户刚输入的内容连同输入框一起消失（实测过这个形态）。
       * 过滤结果为空时仍然画着搜索框（用户要能改关键字）。
       */
      const enableSearch = props.searchable === true || options.length > SEARCH_MIN_OPTIONS

      const trimmedKeyword = keyword.trim().toLowerCase()
      /**
       * 过滤后的选项**连同它们在原数组里的下标**：`activeIndex` 始终是原数组下标，
       * 这样 ↑↓ / Enter / `aria-checked` / ✓ 全都不用改口径。
       */
      const filtered = options
        .map((option, index) => ({ option: option, index: index }))
        .filter((item) => {
          if (trimmedKeyword === '') return true
          const label = String(item.option.label ?? item.option.value ?? '').toLowerCase()
          const raw = String(item.option.value ?? '').toLowerCase()
          return label.indexOf(trimmedKeyword) >= 0 || raw.indexOf(trimmedKeyword) >= 0
        })
      const visibleOptions = filtered.map((item) => item.option)
      const filteredIndex = filtered.findIndex((item) => item.index === activeIndex)
      /** 兜底用的"两条边距"：与官方 `.list{top:calc(100% + 4px)}` 同一档。 */
      const menuGap = px(S.menuOffset)

      /**
       * 量一次触发器 → 决定向下还是向上、上下留多少、左右夹到哪。
       *
       * 依赖 `[open, options.length, enableSearch]`：内容长度会改变弹层高度，
       * 高度又决定"翻不翻"，所以这三者任一变化都重算一次。
       */
      React.useLayoutEffect(() => {
        if (!open) return undefined
        const measure = () => {
          const trigger = triggerRef.current
          if (trigger === null) return
          const rect = trigger.getBoundingClientRect()
          const viewportWidth = window.innerWidth
          const viewportHeight = window.innerHeight
          const margin = 8
          const spaceBelow = viewportHeight - rect.bottom - menuGap - margin
          const spaceAbove = rect.top - menuGap - margin
          const listMax = px(S.menuMaxHeightPx)
          const contentMax = enableSearch ? px(S.menuSearchMaxHeightPx) : listMax
          const capUp = Math.min(spaceAbove, contentMax)
          const capDown = Math.min(spaceBelow, contentMax)
          // 向下优先；下方装得下的比上方多才翻上去（装得下时"多"不再是理由，
          // 因为 cap 已被 contentMax 夹住 —— 所以翻转只发生在"下方真的不够"时）。
          const goUp = capDown < capUp
          const cap = clamp(goUp ? capUp : capDown, px(S.menuMinHeightPx), contentMax)
          const left = Math.max(margin, Math.min(rect.left, viewportWidth - rect.width - margin))
          setPlace({
            /**
             * 用**两条边**定位，而不是"算好高度 + top = triggerTop − 4 − maxHeight"。
             *
             * 后者在**内容比上限矮**时会错：`maxHeight` 只封顶、不会把盒子撑到那么高
             * （3 项的弹层自然高 116px，而算出来的 `top = 346 − 4 − 320 = 22`，
             * 于是一头栽到视口顶部 —— 实测就是这个形态）。
             * 钉住"贴着触发器"的那条边（向上时钉 `bottom`），内容多高就多高：
             * 矮内容紧贴触发器，高内容在 `maxHeight` 处封顶并内部滚动。
             */
            // `position: fixed` 的 bottom 是"距视口底边的距离"，所以在这里换算好，
            // 渲染时不再读 `window.innerHeight`（那是渲染期的外部可变值）。
            up: goUp,
            anchor: goUp
              ? Math.max(margin, viewportHeight - Math.max(margin, rect.top - menuGap))
              : rect.bottom + menuGap,
            left: left,
            width: rect.width,
            maxHeight: cap,
          })
        }
        measure()
        window.addEventListener('resize', measure)
        // `capture: true` 才收得到**任意**滚动容器（面板内的滚动不冒泡到 window）。
        window.addEventListener('scroll', measure, true)
        /*
         * 再量一次（下一帧）。
         *
         * 为什么需要：`focus()` 会让浏览器把"最近的可滚祖先"scrolled-into-view，
         * 而这次由聚焦引起的滚动**不一定**派发 `scroll` 事件（实测这个场景里设置弹窗的
         * `scrollTop` 从 0 变到 36，而弹层还停在按滚动前的位置 —— 差的就是那 36px）。
         * 下一帧重算一次，位置就与触发器对齐了。用 rAF 而不是固定延时：不引入可感知的延迟。
         */
        const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(measure) : 0
        return () => {
          if (raf !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
          window.removeEventListener('resize', measure)
          window.removeEventListener('scroll', measure, true)
        }
      }, [open, options.length, enableSearch])

      React.useEffect(() => {
        if (!open) return () => {}
        setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
        setKeyword('')
        const onPointerDown = (event) => {
          const target = event.target
          if (triggerRef.current !== null && triggerRef.current.contains(target)) return
          if (listRef.current !== null && listRef.current.contains(target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            setOpen(false)
            if (triggerRef.current !== null) triggerRef.current.focus()
          }
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open, selectedIndex])

      /**
       * 两个 ref：**只记录元素**的（给"点外部关闭"用）与**记录并聚焦**的。
       *
       * 为什么要拆开：React 的 ref 附着顺序是"子先于父"，所以弹层容器与它里面被克隆出
       * `ref` 的那一项会**先后**被聚焦 —— 后一个（容器）会盖掉前一个。焦点落在哪必须由
       * 分支决定（见下面 `popup`），不能靠"谁后附着"这种偶然顺序。
       */
      const attachListRef = React.useCallback((node) => {
        listRef.current = node
      }, [])

      /**
       * 打开后把焦点交给**当前项**（键盘用户下一步就是 ↑↓，不必先 Tab 一遍）。
       *
       * 2026-10-12（可搜索下拉）分两种形态，各自都有明确理由：
       *   - **没有搜索框**（短列表）：焦点落在**当前那一项**上 —— 与改造前完全一致
       *     （既有 `controls.test.mjs` 3.1 / 3.4 钉着"展开后焦点在当前项"）。
       *   - **有搜索框**（长列表）：焦点落在**列表容器**上。原因是 button 会吞掉字符键，
       *     焦点在选项上时"打一个字就开始过滤"根本收不到事件；焦点在容器上则由
       *     下面的 `onListKeyDown` 接住再转发给搜索框（`focusSearch`）。
       *     容器仍然是一个落点（`tabIndex` / `focus()`），方向键照旧走真焦点。
       */
      const focusOnMount = React.useCallback((node) => {
        if (node === null) return
        if (typeof node.focus === 'function') node.focus()
      }, [])

      /**
       * 焦点落点（短列表形态）：让**当前高亮项**拿到真焦点。
       *
       * 为什么不能只依赖"挂一个稳定的 `ref`"：`↑↓` 只改 `activeIndex`，被高亮的那枚
       * `<button>` 元素本身并没有换人（同一个 key / 同一个类型），React 因此**不会**
       * 重跑一个**引用不变**的 ref 回调 —— 实测"按 ↓ 之后 `document.activeElement`
       * 仍停在上一个项上"。所以回调按 `activeIndex` 重新创建（依赖数组里有它）：
       * 高亮项一变，React 先摘旧 ref（此时 `activeIndex` 已是新值 ⇒ 旧回调判 false、
       * 不动焦点）再挂新 ref ⇒ 新项被聚焦；`scrollIntoView` 顺带把长列表里的它带进视野。
       *
       * 长列表（有搜索框）**不这么做**：那里焦点先留在容器/搜索框上，否则用户打一个字
       * 焦点就被拽回选项、第二个字就丢了（`focusOnMount` 的注释里有完整说明）。
       */
      const focusIfNotInside = React.useCallback(
        (node) => {
          if (node === null) return
          if (node.contains(document.activeElement)) return
          if (typeof node.focus === 'function') node.focus()
          // 长列表里高亮项可能在滚动区之外：把它带进视野（官方 `Menu` 也做这件事）。
          if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
        },
        [],
      )
      /**
       * 选项的 ref 回调工厂：**每一项**都拿一个回调，回调自己判断"是不是当前高亮项"。
       *
       * 为什么要挂在每一项上、而不是只挂当前项：React 只在 ref 的**引用**变化时才重跑它。
       * 只给"当前高亮项"挂一个稳定引用的话，`↑↓` 改变 `activeIndex` 时新旧回调是同一个
       * 函数对象，React 不会重跑 —— 实测焦点留在上一项。这里每次渲染都给**全部**选项造
       * 新回调（引用天然不同，工厂本身不缓存），React 依序摘旧挂新；`upToDateRef` 里记着
       * 本次渲染的 `activeIndex`，所以只有新高亮项那一枚会真的聚焦。
       */
      const upToDateRef = { current: activeIndex }
      const optionRef = (index) => (node) => {
        if (index !== upToDateRef.current) return
        focusIfNotInside(node)
      }

      /** 长列表形态下弹层容器的 ref：既要记住元素（点外部关闭要 `contains`），又要聚焦。 */
      const attachAndFocus = React.useCallback(
        (node) => {
          attachListRef(node)
          focusOnMount(node)
        },
        [attachListRef, focusOnMount],
      )

      const commit = (option) => {
        setOpen(false)
        setKeyword('')
        if (triggerRef.current !== null) triggerRef.current.focus()
        if (String(option.value) === String(value)) return
        // 与原生 `<select>` 的 onChange 同形：调用方读 `event.target.value`，
        // 所以这里**造一个同样形状的事件对象**，调用点一行都不用改。
        if (typeof props.onChange === 'function') {
          props.onChange({ target: { value: String(option.value) } })
        }
      }

      /** 把焦点挪到搜索框（列表容器上打出的第一个字符走这条路）。 */
      const focusSearch = () => {
        const input = searchRef.current
        if (input === null || typeof input.focus !== 'function') return false
        input.focus()
        return true
      }

      const onListKeyDown = (event) => {
        // 方向键用的是**过滤后**的下标，但落点换算回原数组下标（`filtered` 带 index）。
        const last = filtered.length - 1
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          if (last < 0) return
          setActiveIndex(filteredIndex < 0 ? filtered[0].index : filtered[(filteredIndex + 1) % filtered.length].index)
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          if (last < 0) return
          setActiveIndex(
            filteredIndex < 0
              ? filtered[last].index
              : filtered[(filteredIndex <= 0 ? last : filteredIndex - 1)].index,
          )
          return
        }
        if (event.key === 'Home') {
          event.preventDefault()
          setActiveIndex(last < 0 ? 0 : filtered[0].index)
          return
        }
        if (event.key === 'End') {
          event.preventDefault()
          setActiveIndex(last < 0 ? 0 : filtered[last].index)
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          const target = filtered.find((item) => item.index === activeIndex)
          const option = target === undefined ? undefined : target.option
          if (option === undefined) return
          event.preventDefault()
          commit(option)
          return
        }
        /*
         * **打一个字就开始搜**：焦点在列表容器（不是搜索框）时，可打印字符与退格
         * 转发给搜索框。不这么做的话，键盘用户必须先 Tab 一次才够得着搜索框。
         * 只认"单个字符、无修饰键"的 key，方向键 / Enter / Esc / Tab 一概不拦。
         */
        if (enableSearch && event.key.length === 1 && event.ctrlKey !== true && event.metaKey !== true) {
          if (focusSearch()) {
            event.preventDefault()
            setKeyword((prev) => prev + event.key)
          }
          return
        }
        if (enableSearch && event.key === 'Backspace' && keyword !== '' && focusSearch()) {
          event.preventDefault()
          setKeyword((prev) => prev.slice(0, -1))
        }
      }

      const optionNodes = filtered.map((item) => {
        const option = item.option
        const index = item.index
        return h(
          'button',
          {
            key: 'o' + String(index),
            type: 'button',
            role: 'menuitem',
            'data-pxm-option': String(option.value),
            // 高亮项（roving tabindex / 键盘落点）—— 探针靠它读"高亮在第几项"，
            // 因为长列表形态下焦点在容器上、`document.activeElement` 看不出高亮位置。
            'data-pxm-state': index === activeIndex ? 'active' : 'idle',
            // 当前项 = `aria-checked` + 行尾 ✓（官方 Menu 的 `selection='check'`）。
            'aria-checked': String(option.value) === String(value) ? 'true' : 'false',
            // Tab 序：只有**当前高亮项**可 Tab（照官方 `Menu` 的 roving tabindex）。
            // 高亮项被搜索过滤掉时，退回列表容器（它自己 tabIndex=0）。
            tabIndex: index === activeIndex ? 0 : -1,
            // 焦点落点：短列表挂在**当前高亮项**上（见 `optionRef`）；
            // 长列表由弹层容器接管（`attachAndFocus`）。
            ref: enableSearch ? undefined : optionRef(index),
            className: 'pxm-select-option',
            disabled: option.disabled === true,
            onClick: () => commit(option),
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              width: '100%',
              minHeight: S.menuItemHeight,
              padding: S.menuItemPad,
              border: 'none',
              borderRadius: S.radiusMd,
              background: 'transparent',
              cursor: option.disabled === true ? 'not-allowed' : 'pointer',
              font: 'inherit',
              fontSize: S.menuItemFontSize,
              lineHeight: S.menuItemLineHeight,
              color: T.label,
              textAlign: 'left',
              opacity: option.disabled === true ? 0.4 : 1,
            },
          },
          h(
            'span',
            { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            String(option.label ?? option.value ?? ''),
          ),
          String(option.value) === String(value)
            ? h(Icon, {
                name: 'check',
                className: 'pxm-select-check',
                size: 14,
                testId: 'check',
                color: T.label,
                style: { flex: 'none' },
              })
            : null,
        )
      })

      /**
       * 高亮项被搜索过滤掉了吗？是的话给容器 `tabIndex=0`，键盘仍有落点
       * （否则"打开 → 打字过滤 → 当前项被滤掉"会让焦点掉到 body 上）。
       */
      const activeVisible = filteredIndex >= 0

      /** 弹层：搜索框（长列表才有）+ 可滚列表。位置/上限全在内联样式里（见上面的定位注释）。 */
      const popup = h(
        'div',
        {
          // 焦点落在哪由分支决定：短列表给"当前项"，长列表给容器（见 `focusOnMount`）。
          ref: enableSearch ? attachAndFocus : attachListRef,
          className: 'pxm-select-list',
          'data-pxm-select-list': '1',
          role: 'menu',
          tabIndex: activeVisible ? -1 : 0,
          ...(isString(props.labelledBy) ? { 'aria-labelledby': props.labelledBy } : {}),
          onKeyDown: onListKeyDown,
          style: {
            position: 'fixed',
            // 贴住触发器的**那一条边**（向上时钉 bottom、向下时钉 top），见 `place` 的注释。
            ...(place.up
              ? { bottom: String(place.anchor) + 'px' }
              : { top: String(place.anchor) + 'px' }),
            left: String(place.left) + 'px',
            // 宽度跟触发器一致；`maxWidth` 再挡一层（面板比视口还宽时不让它溢出右边）。
            width: String(place.width) + 'px',
            maxWidth: String(place.width) + 'px',
            zIndex: 100,
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            padding: S.menuPad,
            // 官方卡片圆角/描边/阴影：`MenuSurface.module.css`（radius-lg）+ `Menu.module.css`
            // 的 `.list{box-shadow:var(--dsw-elevation-prominent)}`。本插件不引入
            // 新 token，用 token 派生的浮层底 + 一级描边（`borderL1`，官方卡片描边那一档）
            // 与 `shadow()`（由 `label` token 派生的半透明阴影，深浅色都跟随）。
            background: T.bgOverlay,
            border: '0.5px solid ' + T.borderL1,
            borderRadius: S.radiusLg,
            boxShadow: shadow(4, 16, 18),
            // 高度上限由定位逻辑给（可用空间/内容/视口三者取最小）。
            maxHeight: String(place.maxHeight) + 'px',
            overflow: 'hidden',
          },
        },
        enableSearch
          ? h(
              'div',
              {
                className: 'pxm-select-search',
                style: { position: 'relative', display: 'flex', alignItems: 'center', flex: '0 0 auto' },
              },
              h(Icon, {
                name: 'search',
                className: 'pxm-select-search-icon',
                size: S.searchIconSize,
                testId: 'select-search',
                color: T.labelTertiary,
                style: { position: 'absolute', left: S.searchIconLeft, pointerEvents: 'none' },
              }),
              h('input', {
                ref: searchRef,
                type: 'text',
                className: 'pxm-select-search-input',
                'data-pxm-select-search': '1',
                'aria-label': isString(props.label) ? '搜索：' + props.label : '搜索选项',
                placeholder: '搜索…',
                autoComplete: 'off',
                spellCheck: false,
                value: keyword,
                onChange: (event) => {
                  setKeyword(event.target.value)
                  setActiveIndex(0)
                },
                style: {
                  ...inputStyle,
                  height: S.modelsInputHeight,
                  padding: '0 30px 0 ' + S.searchPadLeft,
                  fontSize: S.fieldFontSize,
                },
              }),
              keyword === ''
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'pxm-select-search-clear',
                      'data-pxm-select-clear': '1',
                      'aria-label': '清空搜索',
                      onClick: () => {
                        setKeyword('')
                        setActiveIndex(0)
                        if (searchRef.current !== null) searchRef.current.focus()
                      },
                      style: {
                        position: 'absolute',
                        right: '4px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '22px',
                        height: '22px',
                        padding: 0,
                        border: 'none',
                        borderRadius: S.radiusSm,
                        background: 'transparent',
                        cursor: 'pointer',
                      },
                    },
                    h(Icon, {
                      name: 'close',
                      className: 'pxm-select-search-clear-icon',
                      size: 12,
                      testId: 'select-search-clear',
                      color: T.labelTertiary,
                    }),
                  ),
            )
          : null,
        // 内层滚动容器：滚动**只发生在这里**，所以搜索框不会被滚走；
        // `minHeight: 0` 是它在 flex 列里真能被压缩（从而真的滚）的前提。
        h(
          'div',
          {
            className: 'pxm-select-scroll',
            'data-pxm-select-scroll': '1',
            style: {
              flex: '1 1 auto',
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: '2px',
              overflowY: 'auto',
              overflowX: 'hidden',
              // 列表本身的官方上限 320（`.candidateList`）；可用空间更小时由外层 maxHeight 夹住。
              maxHeight: px(S.menuMaxHeightPx),
            },
          },
          visibleOptions.length === 0
            ? h(
                'div',
                {
                  className: 'pxm-select-empty',
                  'data-pxm-select-empty': '1',
                  style: {
                    padding: '10px 8px',
                    textAlign: 'center',
                    color: T.labelSecondary,
                    fontSize: S.menuItemFontSize,
                    lineHeight: S.menuItemLineHeight,
                  },
                },
                '没有匹配的选项',
              )
            : /*
               * 短列表：焦点落点挂在**当前高亮项**上（`focusIfNotInside`，见那里的注释）；
               * 长列表（有搜索框）：焦点落在**容器**上，好让字符键被容器接住再转发给搜索框。
               */
              optionNodes,
        ),
      )

      return h(
        'span',
        {
          className: 'pxm-select',
          // 自绘下拉作为一个整体占满右列宽度（原生 `<select>` 也是整宽）。
          style: { position: 'relative', display: 'inline-flex', width: '100%', minWidth: 0 },
        },
        h(
          'button',
          {
            type: 'button',
            ref: triggerRef,
            id: isString(props.id) ? props.id : undefined,
            className: 'pxm-select-trigger',
            'data-pxm-role': 'select',
            'aria-haspopup': 'menu',
            'aria-expanded': open ? 'true' : 'false',
            ...(isString(props.labelledBy) ? { 'aria-labelledby': props.labelledBy } : {}),
            ...(isString(props.describedBy) ? { 'aria-describedby': props.describedBy } : {}),
            disabled: disabled,
            onClick: (event) => {
              // 触发器在 `<label>` 之外（Field 用的是 `htmlFor` 显式关联），
              // 但仍挡一层冒泡：避免将来把控件挪回 label 内时，点击既开又立刻关。
              event.stopPropagation()
              setOpen(!open)
            },
            style: {
              font: 'inherit',
              boxSizing: 'border-box',
              display: 'inline-flex',
              alignItems: 'center',
              gap: S.selectGap,
              width: '100%',
              minWidth: 0,
              height: S.selectHeight,
              padding: S.selectPad,
              border: 'none',
              borderRadius: S.radiusMd,
              // 官方「模型」页**本页**的输入/下拉底槽：`._3nPmjq_input` 与
              // `select._3nPmjq_input` 都是 `background:var(--dsw-alias-bg-layer-1)`
              // （`settings-models/lib/client.js:58`）。2026-10-12 起与页内三枚输入字段同层。
              background: T.bgLayer1,
              color: T.label,
              fontSize: S.selectFontSize,
              lineHeight: S.selectLineHeight,
              textAlign: 'left',
              cursor: disabled ? 'default' : 'pointer',
            },
          },
          h(
            'span',
            {
              style: {
                flex: '1 1 auto',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            currentLabel,
          ),
          h(Icon, {
            name: 'chevronDown',
            className: 'pxm-select-chevron',
            size: 16,
            testId: 'chevron',
            color: T.labelTertiary,
            style: {
              flex: 'none',
              transition: 'transform .12s',
              // 官方 `PermissionSelect` 的 `.chevronOpen{transform:rotate(180deg)}`。
              transform: open ? 'rotate(180deg)' : 'none',
            },
          }),
        ),
        // 弹层（位置/上限由 `place` 给，见上面的定位注释）。
        open ? popup : null,
      )
    }

    /**
     * 数字步进器：容器内「数值 + 上下两枚 chevron」，右侧单位后缀。
     *
     * 官方对照物是「字号大小」那一行（`@deepseek-ai/dsh-client-ui-theme/lib/client.js:1012`
     * 的 `FontSizeRow`）：
     *   - `.stepper{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);
     *     min-width:72px;height:36px;justify-content:center;align-items:center;display:inline-flex;
     *     position:relative}`；
     *   - `.value{font-variant-numeric:tabular-nums;min-width:18px;font-size:14px;line-height:22px}`；
     *   - `.arrows{flex-direction:column;gap:2px;position:absolute;right:8px}` +
     *     `.arrow{width:17px;height:12px;border-radius:var(--dsw-radius-xs)}`，
     *     两枚按钮是 `<button type=button aria-label=增大/减小字号>`，到边界时 `disabled`
     *     （官方 10..22，本插件 1..4）；
     *   - `.unit{color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}`。
     *
     * **与官方的一处有意偏离**：官方 `.arrows{opacity:0}`，只在 `:hover` / `:focus-within`
     * 时显形。本插件改成**常显**——需求把"两个 chevron 按钮可点、可键盘"当验收项，
     * 而一个默认不可见的箭头列在触屏/键盘用户那里等于不存在。几何照抄不变。
     */
    function NumberStepper(props) {
      const min = isNumber(props.min) ? props.min : 1
      const max = isNumber(props.max) ? props.max : 4
      const value = isNumber(props.value) ? props.value : min
      const disabled = props.disabled === true
      const step = (delta) => {
        if (disabled) return
        const next = Math.min(max, Math.max(min, value + delta))
        if (next === value) return
        if (typeof props.onChange === 'function') props.onChange(next)
      }
      const arrowStyle = (atEdge) => ({
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: S.stepperArrowWidth,
        height: S.stepperArrowHeight,
        padding: 0,
        border: 'none',
        borderRadius: S.radiusSm,
        background: 'transparent',
        color: atEdge || disabled ? T.labelTertiary : T.label,
        cursor: atEdge || disabled ? 'default' : 'pointer',
      })
      const upEdge = disabled || value >= max
      const downEdge = disabled || value <= min
      return h(
        'span',
        {
          className: 'pxm-stepper',
          'data-pxm-role': 'stepper',
          style: {
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            minWidth: S.stepperMinWidth,
            height: S.stepperHeight,
            padding: '0 30px 0 12px',
            boxSizing: 'border-box',
            borderRadius: S.radiusMd,
            // 官方 `.stepper` 的底槽是 `bg-module-platform`；同 SelectField 的理由，
            // 取输入控件层 `bg-layer-3`（同族、随主题）。
            background: T.bgLayer3,
          },
        },
        h(
          'span',
          {
            'data-pxm-stepper-value': '1',
            style: {
              textAlign: 'center',
              fontVariantNumeric: 'tabular-nums',
              minWidth: S.stepperValueMinWidth,
              color: T.label,
              fontSize: S.stepperFontSize,
              lineHeight: S.stepperLineHeight,
            },
          },
          String(value),
        ),
        props.unit === undefined || props.unit === null
          ? null
          : h(
              'span',
              {
                'data-pxm-stepper-unit': '1',
                style: {
                  color: T.labelSecondary,
                  fontSize: S.stepperFontSize,
                  lineHeight: S.stepperLineHeight,
                },
              },
              String(props.unit),
            ),
        h(
          'span',
          {
            style: {
              position: 'absolute',
              right: S.stepperArrowRight,
              display: 'flex',
              flexDirection: 'column',
              gap: S.stepperArrowGap,
            },
          },
          h(
            'button',
            {
              type: 'button',
              className: 'pxm-stepper-up',
              'data-pxm-stepper-up': '1',
              'aria-label': props.increaseLabel ?? '增大',
              disabled: upEdge,
              onClick: () => step(1),
              style: arrowStyle(upEdge),
            },
            h(Icon, { name: 'chevronUp', size: 9, testId: 'stepper-up', color: upEdge ? T.labelTertiary : T.label }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'pxm-stepper-down',
              'data-pxm-stepper-down': '1',
              'aria-label': props.decreaseLabel ?? '减小',
              disabled: downEdge,
              onClick: () => step(-1),
              style: arrowStyle(downEdge),
            },
            h(Icon, { name: 'chevronDown', size: 9, testId: 'stepper-down', color: downEdge ? T.labelTertiary : T.label }),
          ),
        ),
      )
    }

    /**
     * 搜索框：**整宽 + 前置图标**，照官方「搜索插件」那一处。
     *
     * 官方出处：`@deepseek-ai/dsh-client-ui-settings-plugin-inventory/lib/client.js:57`
     * （`RotMhW_search`）——`{width:100%;color:label-tertiary;align-items:center;display:flex;
     * position:relative}`，子节点顺序是 **icon → (视觉隐藏的 label 文本) → input**，
     * `>svg{pointer-events:none;position:absolute;left:12px}`，
     * `input{width:100%;height:36px;padding:0 34px 0 36px;font-size:13px;
     * border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);
     * background:var(--dsw-alias-bg-layer-1)}`，`input::placeholder{color:label-tertiary}`。
     *
     * 注意这与官方**表单值字段**不是同一个组件（那个是 34px / `bg-layer-3` / 无图标），
     * 两者在 `test/browser/sizes.test.mjs` 里分别有 `OFFICIAL_FIELD` 与 `OFFICIAL_SEARCH`。
     *
     * 图标是**内联 SVG**（`Icon name="search"`），`pointer-events:none` 让它不挡点击。
     */
    function SearchInput(props) {
      const disabled = props.disabled === true
      return h(
        'span',
        {
          className: 'pxm-search-box',
          style: {
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            width: '100%',
            minWidth: 0,
            color: T.labelTertiary,
          },
        },
        h(Icon, {
          name: 'search',
          className: 'pxm-search-icon',
          size: 16,
          testId: 'search',
          color: T.labelTertiary,
          style: {
            position: 'absolute',
            left: S.searchIconLeft,
            pointerEvents: 'none',
          },
        }),
        h('input', {
          className: isString(props.className) && props.className !== '' ? props.className : undefined,
          'data-pxm-role': 'search',
          ...(isString(props.id) ? { id: props.id } : {}),
          'aria-label': props.ariaLabel ?? props.placeholder,
          type: props.type ?? 'text',
          style: {
            font: 'inherit',
            boxSizing: 'border-box',
            width: '100%',
            minWidth: 0,
            height: S.searchHeight,
            padding: S.searchPad,
            fontSize: S.searchFontSize,
            lineHeight: S.searchLineHeight,
            borderRadius: S.radiusMd,
            border: '0.5px solid ' + T.borderL4,
            background: T.bgLayer1,
            color: T.label,
          },
          value: props.value ?? '',
          placeholder: props.placeholder,
          disabled: disabled,
          autoComplete: 'off',
          spellCheck: false,
          onChange: props.onChange,
        }),
      )
    }

    /**
     * 一次写操作的公共状态：`busy`（按钮禁用，防重复提交）+ `result`（卡片内提示）。
     * 组件卸载后落地的响应直接丢弃，避免对已卸载组件 setState。
     */
    function useMutation() {
      const [busy, setBusy] = React.useState(false)
      const [result, setResult] = React.useState(null)
      const alive = React.useRef(true)
      React.useEffect(
        () => () => {
          alive.current = false
        },
        [],
      )
      const run = React.useCallback(async (fn) => {
        setBusy(true)
        setResult(null)
        let outcome
        try {
          outcome = await fn()
        } catch (err) {
          // 任何意外都收敛成卡片内提示，绝不冒泡成白屏
          outcome = { ok: false, error: err && err.message ? err.message : '请求失败' }
        }
        if (!alive.current) return outcome
        setBusy(false)
        if (isObject(outcome)) setResult(outcome)
        return outcome
      }, [])
      return { busy, result, run }
    }

    /**
     * 组件卸载标志。异步落地时先问一句，**卸载后不再 setState**。
     *
     * `useMutation` 里那份 `alive` 只覆盖"它自己发起的写操作"；作品库列表/查看器
     * 的请求是散在 effect 与事件处理器里的，所以单独抽一个钩子复用。
     */
    function useAlive() {
      const alive = React.useRef(true)
      React.useEffect(
        () => () => {
          alive.current = false
        },
        [],
      )
      return alive
    }

    /** 把 `apiPost` 的返回统一成 `{ok, text}`。 */
    function postResult(outcome, okText) {
      if (isObject(outcome) && outcome.ok === true) return { ok: true, text: okText }
      const detail = isObject(outcome) && isString(outcome.error) ? outcome.error : '请求失败'
      const code = isObject(outcome) && isString(outcome.code) ? '（' + outcome.code + '）' : ''
      return { ok: false, text: detail + code }
    }

    /**
     * 图像模型名的**启发式**判据（纯客户端本地判断，不依赖厂商元数据）。
     *
     * 为什么必须靠名字猜：聚合商的模型目录里没有任何"能不能生图"的字段，而实测
     * Ofox 一次返回 150 个模型、其中绝大多数是纯文本模型。用户真正想要的往往是
     * 其中个位数的图像模型，所以这里给一个「只选图像模型」的快捷判据。
     * 覆盖主流命名：gemini.*image / imagen / nano-banana / gpt-image / dall-e /
     * qwen.*image / seedream / wan.*image / flux / stable-diffusion / kolors。
     * 它是**启发式**——漏判只让那一行少一个「图像」标记，不会丢模型。
     */
    const IMAGE_MODEL_PATTERNS = [
      /gemini.*image/i,
      /imagen/i,
      /nano-?banana/i,
      /gpt-image/i,
      /dall-?e/i,
      /qwen.*image/i,
      /seedream/i,
      /wan.*image/i,
      /flux/i,
      /stable-?diffusion/i,
      /kolors/i,
    ]

    /** 模型名是否像图像模型。 */
    function isImageModel(name) {
      const text = String(name)
      return IMAGE_MODEL_PATTERNS.some((pattern) => pattern.test(text))
    }

    /** 「模型」行：超过 8 个只列前 8 个（全量在拉取面板里看），避免一行被 150 项撑爆。 */
    function describeModels(raw) {
      const list = isArray(raw) ? raw.map(String) : []
      if (list.length === 0) return '未声明（可点「拉取模型」）'
      const head = list.slice(0, 8)
      return (
        head.join(' / ') +
        (list.length > head.length ? ' …（共 ' + String(list.length) + ' 个）' : '')
      )
    }

    /**
     * 模型选择面板：拉取结果只读展示 + 复选 + 显式保存。
     *
     * 三处「作用域」必须写在界面上，否则 150 行的列表很容易让人以为选的是全部：
     *   - 搜索框：按**子串**过滤（大小写不敏感）；
     *   - 「全选 / 全不选」：只作用于**当前筛选结果**，按钮文案带数量；
     *   - 「只选图像模型」：按上面的启发式**重设**选择（不是追加），命中的行带「图像」标记。
     *
     * 列表内部滚动（`max-height: 320px`，官方 `.candidateList` 同值）：150 项不能把卡片撑爆。
     * 本组件自己**不发请求**：保存交给父级的 mutation，失败原因也在面板内显示。
     *
     * **2026-10-11 形态对齐官方**（`settings-models/lib/client.js:58` 的 CSS + 同文件
     * :840-881 的标记结构）：这一块在官方那边就是拉取结果的选择器 ——
     *   - 工具条 `.candidateToolbar{align-items:center;gap:8px}`，搜索框 `.candidateSearch{flex:240px}`；
     *   - 列表 `.candidateList{gap:2px;max-height:320px;padding:0;overflow-y:auto}`；
     *   - 行 `.candidateLabel{cursor:pointer;align-items:center;gap:8px;padding:6px 8px;display:flex}`
     *     （外层 `.candidate{border-radius:var(--dsw-radius-md)}`），模型名 `.candidateId`
     *     `{font-size:13px;text-overflow:ellipsis;white-space:nowrap;flex:auto;overflow:hidden}`。
     * 所以这里从"带边框的小盒子 + 12px 行"改成官方的**行式列表**：每行 = 复选控件 + 等宽模型名
     * （本插件的多选能力就落在每行的 checkbox 上）。
     *
     * **与官方的一处有意偏差**：官方把候选列表放在 `Modal`（`.fetchDialog{max-width:520px}`）里，
     * 我们保留"卡片内联展开"的形态（既有 jsdom 用例钉住面板在卡片内展开 / 收起的行为与
     * 320px 滚动容器）；列表本身的几何按官方取值。记在 `docs/contract-notes.md` §23 / §24。
     */
    function ModelPickerPanel(props) {
      const list = isArray(props.models) ? props.models.map(String) : []
      const initial = isArray(props.initial) ? props.initial.map(String) : []
      const [search, setSearch] = React.useState('')
      const [selected, setSelected] = React.useState(() =>
        initial.filter((name) => list.indexOf(name) >= 0),
      )

      const keyword = search.trim().toLowerCase()
      const visible =
        keyword === '' ? list : list.filter((name) => name.toLowerCase().indexOf(keyword) >= 0)
      const chosen = new Set(selected)
      const imageCount = list.filter(isImageModel).length
      const busy = props.busy === true

      const toggle = (name) =>
        setSelected((prev) =>
          prev.indexOf(name) >= 0 ? prev.filter((item) => item !== name) : prev.concat([name]),
        )

      /** 只加不减：不动筛选结果之外的选择。 */
      const selectAllVisible = () =>
        setSelected((prev) => {
          const next = prev.slice()
          for (const name of visible) if (next.indexOf(name) < 0) next.push(name)
          return next
        })

      /** 只减不加：同样只作用于当前筛选结果。 */
      const clearVisible = () =>
        setSelected((prev) => prev.filter((name) => visible.indexOf(name) < 0))

      const onlyImage = () => setSelected(list.filter(isImageModel))

      return h(
        'div',
        {
          className: 'pxm-model-picker',
          style: { display: 'flex', flexDirection: 'column', gap: S.catalogGap, minWidth: 0 },
        },
        // 头部：面板自己的小标题 + 已选计数（官方 `.modelCatalogHeading` 的 12px 两行结构）。
        h(
          'div',
          { style: { ...skin.row, gap: '8px' } },
          h(
            'span',
            {
              style: {
                color: T.labelSecondary,
                fontSize: S.catalogTitleFontSize,
                fontWeight: 500,
                lineHeight: S.catalogTitleLineHeight,
              },
            },
            '选择要保留的模型',
          ),
          h(
            'span',
            {
              style: {
                color: T.labelTertiary,
                fontSize: S.catalogMetaFontSize,
                lineHeight: S.catalogMetaLineHeight,
              },
            },
            '已选 ' + String(selected.length) + ' / 共 ' + String(list.length) +
              (keyword === '' ? '' : '（筛选后 ' + String(visible.length) + ' 项）'),
          ),
        ),
        // 工具条：官方 `.candidateToolbar`（gap 8px）+ `.candidateSearch`（flex:240px）。
        // 三枚动作按钮是官方 `Button variant="ghost" size="sm"`（同文件 :851-857）→ `LinkButton`。
        h(
          'div',
          {
            className: 'pxm-picker-toolbar',
            style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' },
          },
          h(
            'div',
            { style: { flex: '240px', minWidth: 0 } },
            h(TextInput, {
              value: search,
              disabled: busy,
              placeholder: '搜索模型…',
              onChange: (event) => setSearch(event.target.value),
            }),
          ),
          h(
            LinkButton,
            {
              disabled: busy || visible.length === 0,
              onClick: selectAllVisible,
              title: '只选中当前搜索结果里的模型，不影响其他行',
            },
            '全选（当前 ' + String(visible.length) + ' 个）',
          ),
          h(
            LinkButton,
            {
              disabled: busy || visible.length === 0,
              onClick: clearVisible,
              title: '只取消当前搜索结果里的模型，不影响其他行',
            },
            '全不选（当前 ' + String(visible.length) + ' 个）',
          ),
          h(
            LinkButton,
            {
              disabled: busy || imageCount === 0,
              onClick: onlyImage,
              title: '按模型名启发式选中全部图像模型（会替换当前选择）',
            },
            '只选图像模型（' + String(imageCount) + ' 个）',
          ),
        ),
        // 列表：官方 `.candidateList`（gap 2px / padding 0 / 内部滚动）。
        h(
          'div',
          {
            'data-pxm-model-list': '1',
            className: 'pxm-model-list',
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: S.modelListGap,
              maxHeight: S.modelScrollMaxHeight,
              overflowY: 'auto',
              padding: 0,
              margin: 0,
              minWidth: 0,
            },
          },
          visible.length === 0
            ? h(
                'p',
                {
                  style: {
                    margin: 0,
                    color: T.labelSecondary,
                    fontSize: S.catalogMetaFontSize,
                    lineHeight: S.catalogMetaLineHeight,
                    textAlign: 'center',
                  },
                },
                '没有匹配的模型',
              )
            : visible.map((name) =>
                h(
                  'label',
                  {
                    key: name,
                    // 语义锚点：浏览器 lane 按它数"列表里有几行 / 行的几何"，不按类名。
                    'data-pxm-model-row': '1',
                    className: 'pxm-model-row',
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: S.modelRowGap,
                      padding: S.modelRowPad,
                      borderRadius: S.radiusMd,
                      minWidth: 0,
                      cursor: busy ? 'not-allowed' : 'pointer',
                    },
                  },
                  h('input', {
                    type: 'checkbox',
                    checked: chosen.has(name),
                    disabled: busy,
                    onChange: () => toggle(name),
                  }),
                  h(
                    'span',
                    {
                      className: 'pxm-model-id',
                      // 语义锚点：浏览器 lane 按它量模型名的字号（不按类名）。
                      'data-pxm-model-name': '1',
                      title: name,
                      style: {
                        flex: 'auto',
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontFamily: skin.code.fontFamily,
                        fontSize: S.modelRowFontSize,
                        color: T.label,
                      },
                    },
                    name,
                  ),
                  isImageModel(name) ? h(RowTag, null, '图像') : null,
                ),
              ),
        ),
        // 动作行：官方 `.editorActions{justify-content:flex-end;gap:8px}`。
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'flex-end', gap: S.actionsGap, alignItems: 'center' } },
          busy ? h(Spinner, { label: '保存中' }) : null,
          h(
            Btn,
            {
              disabled: busy || selected.length === 0,
              onClick: () => props.onSave(list.filter((name) => chosen.has(name))),
              title: '只把已选中的模型写进 config.json（拉取本身不写配置）',
            },
            busy ? '保存中…' : '保存选择',
          ),
          h(Btn, { disabled: busy, onClick: () => props.onCancel() }, '取消'),
        ),
        h(Msg, { result: props.result }),
      )
    }

    /** 单个厂商的凭据表单：baseUrl / apiKey / 拉取模型 / 选择模型 / 测试连接。 */
    function ProviderCard(props) {
      const provider = props.provider
      const id = isString(provider.id) ? provider.id : ''
      const hasKey = provider.hasApiKey === true
      const keyFromEnv = provider.apiKeySource === 'env'

      const [baseUrl, setBaseUrl] = React.useState(String(provider.baseUrl ?? ''))
      const [nativeUrl, setNativeUrl] = React.useState(String(provider.geminiNativeBaseUrl ?? ''))
      // 不再暴露 `apiKeyEnv`：环境变量会**优先于**本页填写的密钥，只留字段却藏掉输入框
      // 会变成"哪天环境变量被设上，界面里的 key 就静默失效且无从察觉"。
      // 因此保存凭据时显式清空它（见 writeCredentials 的调用点）。
      const [keyValue, setKeyValue] = React.useState('')
      const creds = useMutation()
      const models = useMutation()
      const probe = useMutation()
      const picker = useMutation()

      /**
       * 拉取结果与面板开合是**两件事**：取消只收起面板，不必再向厂商拉一次。
       * `seq` 每拉一次 +1，用作面板的 key —— 让面板重新挂载、选择状态从最新配置重算。
       */
      const [pull, setPull] = React.useState(null)
      const [pickerOpen, setPickerOpen] = React.useState(false)
      const pullSeq = React.useRef(0)

      /** 卸载后不再 setState：await 之后的 `setPull` / `setPickerOpen` 都要过这一关。 */
      const mounted = React.useRef(true)
      React.useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
        }
      }, [])

      // 宿主的视图变了（例如拉取模型后重取成功）→ 同步输入框的初值
      React.useEffect(() => {
        setBaseUrl(String(provider.baseUrl ?? ''))
        setNativeUrl(String(provider.geminiNativeBaseUrl ?? ''))
      }, [provider.id, provider.baseUrl, provider.geminiNativeBaseUrl])

      const endpoint = 'api/providers/' + encodeURIComponent(id) + '/'

      const writeCredentials = (payload) =>
        creds.run(async () => {
          const outcome = await apiPost(endpoint + 'credentials', payload)
          if (outcome.ok !== true) return postResult(outcome, '')
          setKeyValue('')
          return postResult(outcome, '已保存')
        }).then((outcome) => {
          if (outcome.ok === true) props.reload()
          return outcome
        })

      /**
       * 拉取模型 —— **只读**。
       *
       * 宿主侧 `refresh-models` 已改为纯读（不写配置），所以这里拿到结果后只做两件事：
       * 展开选择面板、重取 `api/providers` 让「模型」行与配置保持一致。
       * 真正落盘要等用户点面板里的「保存选择」。
       */
      const onRefresh = () =>
        models.run(async () => {
          const outcome = await apiPost(endpoint + 'refresh-models', {})
          if (outcome.ok !== true) return postResult(outcome, '')
          const list = isArray(outcome.data.models) ? outcome.data.models.map(String) : []
          return {
            ok: true,
            text: '已拉取 ' + String(list.length) + ' 个模型',
            models: list,
          }
        }).then((outcome) => {
          if (!mounted.current) return outcome
          if (outcome.ok === true && isArray(outcome.models)) {
            setPull({ models: outcome.models, seq: (pullSeq.current += 1) })
            setPickerOpen(true)
            props.reload()
          }
          return outcome
        })

      /**
       * 保存选择 —— 唯一会写 `provider.models` 的入口。
       * 只提交**已选子集**（面板按拉取列表顺序给出），成功后重取、收起面板、给成功提示。
       */
      const onSaveModels = (chosen) =>
        picker.run(async () => {
          const outcome = await apiPost(endpoint + 'models', { models: chosen })
          if (outcome.ok !== true) return postResult(outcome, '')
          return postResult(outcome, '已保存 ' + String(chosen.length) + ' 个模型')
        }).then((outcome) => {
          if (!mounted.current) return outcome
          if (outcome.ok === true) {
            setPickerOpen(false)
            props.reload()
          }
          return outcome
        })

      const onTest = () =>
        probe.run(async () => {
          const outcome = await apiPost(endpoint + 'test', {})
          if (isObject(outcome) && outcome.ok === true && isObject(outcome.data)) {
            return postResult(outcome, '连接正常')
          }
          const data = isObject(outcome) ? outcome.data : null
          const failure = isObject(data) && isObject(data.error) ? data.error : null
          const message = failure !== null && isString(failure.message) ? failure.message : '连接失败'
          const code = failure !== null && isString(failure.code) ? '（' + failure.code + '）' : ''
          return { ok: false, text: message + code }
        })

      const disableCredentials = creds.busy || id === ''

      /*
       * 卡片几何 = 官方 `._3nPmjq_rowCard`（`settings-models/lib/client.js:58`，标记结构见
       * 同文件 :2160-2232）：
       *   `{border:.5px solid var(--dsw-alias-settings-card-stroke);
       *     background:var(--dsw-alias-settings-card-fill);
       *     border-radius:var(--dsw-radius-xl);flex-direction:column;gap:12px;padding:12px 14px}`
       *
       * 两个别名 token 的**取值**在官方 theme 的 base CSS 里就是本插件已有那两枚
       * （`--dsw-alias-settings-card-stroke: var(--dsw-alias-border-l4)`、
       * `--dsw-alias-settings-card-fill: var(--dsw-alias-bg-layer-2)`，见
       * `@deepseek-ai/dsh-client-ui-theme/lib/client.js`），所以这里直接用 `T.borderL4`
       * / `T.bgLayer2` —— 是同一个变量的别名目标，不是"近似色"。
       *
       * 圆角取 `xl`（20px）：这是官方 **rowCard** 自己的取值；本插件其它卡片
       * （`skin.card`：默认值 / 导出路径 / 回收站列表项 / 查看器信息卡）仍是 `lg`（16px），
       * 因为官方 `._3nPmjq_editor` / `_addCard` / `_setupCard` 这些**内容卡片**用的是 `lg`
       * （那条选择有既有尺寸用例钉着，见 sizes.test.mjs 的 OFFICIAL_CARD）。
       */
      const rowCardStyle = {
        display: 'flex',
        flexDirection: 'column',
        gap: S.cardGap,
        padding: S.cardPad,
        border: '0.5px solid ' + T.borderL4,
        background: T.bgLayer2,
        borderRadius: S.radiusXl,
        minWidth: 0,
      }

      const modelCount = isArray(provider.models) ? provider.models.length : 0
      const routeText =
        [String(provider.group ?? ''), String(provider.apiMode ?? '')]
          .filter((part) => part !== '')
          .join(' · ') || '—'

      return h(
        'li',
        {
          // 语义锚点：浏览器 lane 按它量这张卡片的几何（不按类名）。
          'data-pxm-vendor-card': '1',
          className: 'pxm-vendor-card',
          style: rowCardStyle,
        },
        // ── ① 标头行：官方 `.rowHead`（gap:10px）+ `.rowIdentity`（gap:6px）
        h(
          'div',
          {
            'data-pxm-vendor-head': '1',
            style: { display: 'flex', alignItems: 'center', gap: S.rowHeadGap, minWidth: 0 },
          },
          h(
            'span',
            {
              'data-pxm-vendor-identity': '1',
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: S.rowIdentityGap,
                minWidth: 0,
                overflow: 'hidden',
              },
            },
            h(
              'span',
              {
                'data-pxm-vendor-name': '1',
                style: {
                  color: T.label,
                  fontSize: S.rowNameFontSize,
                  fontWeight: 500,
                  lineHeight: S.rowNameLineHeight,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              String(provider.label ?? id ?? '未命名'),
            ),
            // 官方 rowTag（`._3nPmjq_rowTag`）：厂商标识那一枚方角小标签。
            h(RowTag, null, String(provider.id ?? '—')),
            // 凭据状态点（官方 `._3nPmjq_credentialDot`）：8px，成功/失败两色 + aria-label。
            h(CredentialDot, {
              ok: hasKey,
              onLabel: '密钥已就位' + (provider.apiKeySource ? '（' + String(provider.apiKeySource) + '）' : ''),
              offLabel: '密钥缺失',
            }),
          ),
          // 行尾动作：官方 `.rowActions{margin-left:auto;gap:4px}`，按钮是 `Button.sm`（28px）。
          // 「测试连接」没有官方对应物（官方不做连接探测），落在官方**行尾动作**那一档里。
          h(
            'span',
            {
              'data-pxm-vendor-actions': '1',
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: S.rowActionsGap,
                marginLeft: 'auto',
                flexShrink: 0,
              },
            },
            h(
              Btn,
              {
                role: 'test-connection',
                className: 'pxm-test-connection',
                disabled: probe.busy,
                onClick: onTest,
                title: '发一次探测请求，不写配置',
              },
              probe.busy ? '测试中…' : '测试连接',
            ),
          ),
        ),
        // ── ② 编辑块：官方 `.editor`（radius-lg / padding 14px 16px / gap 14px /
        //      background:bg-module-platform），字段用官方堆叠式 `.field`。
        h(
          'div',
          {
            'data-pxm-editor': '1',
            className: 'pxm-vendor-editor',
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: S.editorGap,
              padding: S.editorPad,
              borderRadius: S.radiusLg,
              background: T.bgModulePlatform,
              minWidth: 0,
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: S.editorHeaderGap, flexWrap: 'wrap' } },
            h(
              'span',
              {
                style: {
                  color: T.label,
                  fontSize: S.editorTitleFontSize,
                  fontWeight: 500,
                  lineHeight: S.editorTitleLineHeight,
                },
              },
              '凭据与端点',
            ),
            // 官方 `.editorRoute`：把"这一条走哪个协议/路由"写成标题旁边的小字。
            // 我们的 `group` / `apiMode` 正是这个语义（官方没有 group 这一项）。
            h(
              'span',
              {
                'data-pxm-vendor-route': '1',
                style: {
                  color: T.labelTertiary,
                  fontSize: S.editorRouteFontSize,
                  lineHeight: S.editorRouteLineHeight,
                },
              },
              routeText,
            ),
          ),
          h(
            EditorField,
            { label: 'Base URL', controlId: 'pxm-provider-base-url' },
            h(TextInput, {
              id: 'pxm-provider-base-url',
              value: baseUrl,
              disabled: creds.busy,
              // 官方「模型」页本页的输入控件那一档（32px / `bg-layer-1`，见 `modelsPageInputStyle`）。
              style: modelsPageInputStyle,
              placeholder: 'https://api.example.com/v1',
              onChange: (event) => setBaseUrl(event.target.value),
              onBlur: () => {
                const next = baseUrl.trim()
                if (next !== String(provider.baseUrl ?? '')) writeCredentials({ baseUrl: next })
              },
            }),
            h(
              'span',
              {
                style: {
                  color: T.labelTertiary,
                  fontSize: S.catalogMetaFontSize,
                  lineHeight: S.catalogMetaLineHeight,
                },
              },
              'OpenAI 兼容的 /v1 根地址',
            ),
          ),
          h(
            EditorField,
            { label: 'Gemini 原生 Base URL（可选）', controlId: 'pxm-provider-native-url' },
            h(TextInput, {
              id: 'pxm-provider-native-url',
              value: nativeUrl,
              disabled: creds.busy,
              // 同 Base URL：官方本页私有的 `._3nPmjq_input` 那一档。
              style: modelsPageInputStyle,
              placeholder: 'https://api.example.com/gemini/v1beta',
              onChange: (event) => setNativeUrl(event.target.value),
              onBlur: () => {
                const next = nativeUrl.trim()
                if (next !== String(provider.geminiNativeBaseUrl ?? '')) {
                  writeCredentials({ geminiNativeBaseUrl: next })
                }
              },
            }),
            h(
              'span',
              {
                style: {
                  color: T.labelTertiary,
                  fontSize: S.catalogMetaFontSize,
                  lineHeight: S.catalogMetaLineHeight,
                },
              },
              '只有走 Gemini 原生接口时才需要',
            ),
          ),
          h(
            EditorField,
            { label: 'API Key', controlId: 'pxm-provider-api-key' },
            h(TextInput, {
              id: 'pxm-provider-api-key',
              type: 'password',
              value: keyValue,
              disabled: creds.busy,
              // 官方 `SettingsSecretField` 里的密钥框在同一页用的是**本页私有**那枚
              // `._3nPmjq_input`（32px / `bg-layer-1`），与上面两个 URL 字段同一个类。
              style: modelsPageInputStyle,
              placeholder: hasKey ? '已就位，留空不改动' : '粘贴密钥',
              autoComplete: 'new-password',
              onChange: (event) => setKeyValue(event.target.value),
            }),
            h(
              'span',
              {
                style: {
                  color: T.labelTertiary,
                  fontSize: S.catalogMetaFontSize,
                  lineHeight: S.catalogMetaLineHeight,
                },
              },
              keyFromEnv
                ? '留空表示不修改；当前密钥来自环境变量，清除本页填写不会生效'
                : '留空表示不修改',
            ),
          ),
          // 动作行：官方 `.editorActions{justify-content:flex-end;gap:8px}`。
          h(
            'div',
            {
              'data-pxm-editor-actions': '1',
              style: {
                display: 'flex',
                justifyContent: 'flex-end',
                alignItems: 'center',
                gap: S.actionsGap,
                flexWrap: 'wrap',
              },
            },
            creds.busy ? h(Spinner, { label: '保存中' }) : null,
            h(
              Btn,
              {
                disabled: disableCredentials || keyValue === '',
                // 同时清空 apiKeyEnv：环境变量优先级高于本页填写的密钥，
                // 只留字段会变成"哪天环境变量被设上，这里的 key 就静默失效"。
                onClick: () => writeCredentials({ apiKey: keyValue, apiKeyEnv: '' }),
                title: '把上面填写的密钥写入本机配置；同时清空配置里的环境变量名，避免它静默覆盖',
              },
              creds.busy ? '保存中…' : '保存',
            ),
            h(
              Btn,
              {
                disabled: disableCredentials,
                onClick: () => writeCredentials({ apiKey: '', apiKeyEnv: '' }),
                title: '清除本机配置里的密钥与环境变量名',
              },
              '清除密钥',
            ),
          ),
          h(Msg, { result: creds.result }),
        ),
        // ── ③ 模型区块：官方 `section.modelCatalog`
        //      （`{border-top:.5px solid var(--dsw-alias-border-l2);gap:10px;padding-top:12px}`）
        h(
          'section',
          {
            'data-pxm-model-catalog': '1',
            className: 'pxm-model-catalog',
            'aria-label': '模型',
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: S.catalogGap,
              borderTop: '0.5px solid ' + T.borderL2,
              paddingTop: S.catalogPadTop,
              minWidth: 0,
            },
          },
          h(
            'div',
            {
              'data-pxm-model-head': '1',
              style: {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: S.catalogHeadGap,
                flexWrap: 'wrap',
                minWidth: 0,
              },
            },
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
              h(
                'span',
                {
                  // 语义锚点：浏览器 lane 按它量"模型"这个小标题的字号（不按类名）。
                  'data-pxm-model-title': '1',
                  style: {
                    color: T.labelSecondary,
                    fontSize: S.catalogTitleFontSize,
                    fontWeight: 500,
                    lineHeight: S.catalogTitleLineHeight,
                  },
                },
                '模型',
              ),
              h(
                'span',
                {
                  'data-pxm-model-meta': '1',
                  style: {
                    color: T.labelTertiary,
                    fontSize: S.catalogMetaFontSize,
                    lineHeight: S.catalogMetaLineHeight,
                  },
                },
                pull !== null && pickerOpen
                  ? '已拉取 ' + String(pull.models.length) + ' 个候选：勾选后点「保存选择」'
                  : modelCount === 0
                    ? '未声明（拉取或手选后保存）'
                    : '已配置 ' + String(modelCount) + ' 个',
              ),
            ),
            // 模型区块标题行右侧的动作：官方这里就是「获取模型」那一枚 `linkButton`
            // （`settings-models/lib/client.js:749-758`），档位 28px / radius-sm / 0 10px / 12px。
            h(
              'span',
              {
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: S.rowActionsGap,
                  flexShrink: 0,
                  flexWrap: 'wrap',
                },
              },
              // 取消过面板后还能回来接着选，不必再向厂商拉一次。
              pull !== null && !pickerOpen
                ? h(
                    LinkButton,
                    { disabled: picker.busy, onClick: () => setPickerOpen(true) },
                    '选择模型（' + String(pull.models.length) + ' 个）',
                  )
                : null,
              h(
                LinkButton,
                {
                  role: 'fetch-models',
                  className: 'pxm-fetch-models',
                  disabled: models.busy,
                  onClick: onRefresh,
                  title: 'GET {baseUrl}/models：只拉取，不写配置（写入要显式保存选择）',
                },
                models.busy ? '拉取中…' : '拉取模型',
              ),
            ),
          ),
          h(Msg, { result: models.result }),
          h(Msg, { result: probe.result }),
          pull !== null && pickerOpen
            ? h(ModelPickerPanel, {
                key: 'pick-' + String(pull.seq),
                models: pull.models,
                initial: (isArray(provider.models) ? provider.models.map(String) : []).filter(
                  (name) => pull.models.indexOf(name) >= 0,
                ),
                busy: picker.busy,
                result: picker.result,
                onSave: onSaveModels,
                onCancel: () => setPickerOpen(false),
              })
            : null,
          // 已保存模型的摘要行（保留既有文案「模型：…」，也是"卡片里的模型清单"那一半）。
          h(
            'p',
            {
              'data-pxm-model-summary': '1',
              style: {
                margin: 0,
                color: T.labelTertiary,
                fontSize: S.catalogMetaFontSize,
                lineHeight: S.catalogMetaLineHeight,
                wordBreak: 'break-word',
              },
            },
            '模型：' + describeModels(provider.models),
          ),
          pull === null && modelCount === 0
            ? h(
                'p',
                {
                  style: {
                    margin: 0,
                    padding: S.emptyPad,
                    border: '1px dashed ' + T.borderL2,
                    borderRadius: S.radiusLg,
                    color: T.labelTertiary,
                    fontSize: S.catalogMetaFontSize,
                    lineHeight: S.catalogMetaLineHeight,
                    textAlign: 'center',
                  },
                },
                '这一家还没有模型：点上面的「拉取模型」从厂商拉取，再勾选保存。',
              )
            : null,
        ),
        h(Msg, { result: picker.result }),
      )
    }

    /** 默认值卡片：provider / model / size 为可选下拉，保存后回传解析过的默认值。 */
    function DefaultsCard(props) {
      const providers = props.providers
      const defaults = props.defaults
      const [provider, setProvider] = React.useState(String(defaults.provider ?? ''))
      const [model, setModel] = React.useState(String(defaults.model ?? ''))
      const [size, setSize] = React.useState(String(defaults.size ?? '1:1'))
      const [n, setN] = React.useState(String(defaults.n ?? 1))
      const save = useMutation()

      React.useEffect(() => {
        setProvider(String(defaults.provider ?? ''))
        setModel(String(defaults.model ?? ''))
        setSize(String(defaults.size ?? '1:1'))
        setN(String(defaults.n ?? 1))
      }, [defaults.provider, defaults.model, defaults.size, defaults.n])

      const current = providers.find((item) => isObject(item) && item.id === provider)
      const models = isObject(current) && isArray(current.models) ? current.models : []
      // 尺寸候选**由宿主给词表**（`sizeOptions`：{value,label}），客户端不自己拼——
      // 否则"UI 能选的"与"后端认的"会各说各话（agnes 的档位只有官方表知道）。
      // 宿主较老、没有该字段时退回 `allowedSizes`（值即标签）。
      const sizeOptionsOf = (item) => {
        if (isObject(item) && isArray(item.sizeOptions) && item.sizeOptions.length > 0) {
          return item.sizeOptions
            .filter(isObject)
            .map((entry) => ({ value: String(entry.value), label: String(entry.label ?? entry.value) }))
        }
        const list =
          isObject(item) && isArray(item.allowedSizes) && item.allowedSizes.length > 0
            ? item.allowedSizes.map(String)
            : ['1:1', '3:4', '4:3', '9:16', '16:9']
        return list.map((name) => ({ value: name, label: name }))
      }
      const sizes = sizeOptionsOf(current)

      const onProvider = (next) => {
        setProvider(next)
        // 换厂商时若当前模型不在新厂商列表里，就退回该厂商的第一个模型，
        // 避免直接撞上「unknown_model」的 400。
        const target = providers.find((item) => isObject(item) && item.id === next)
        const list = isObject(target) && isArray(target.models) ? target.models.map(String) : []
        if (list.length > 0 && list.indexOf(model) < 0) setModel(list[0])
        // 尺寸同理：当前值可能是**上一个厂商专属**的写法（如 agnes 的 `2048x2048`），
        // 带到新厂商会存下一个对后者无效的默认值。新候选里没有它就退回第一项。
        const nextSizes = sizeOptionsOf(target)
        if (nextSizes.length > 0 && !nextSizes.some((entry) => entry.value === size)) {
          setSize(nextSizes[0].value)
        }
      }

      const nValue = Number(n)
      const nValid = Number.isInteger(nValue) && nValue >= 1 && nValue <= 4

      const onSave = () =>
        save.run(async () => {
          const payload = { provider, size }
          if (model !== '') payload.model = model
          if (nValid) payload.n = nValue
          const outcome = await apiPost('api/defaults', payload, (payloadShape) =>
            isObject(payloadShape.defaults),
          )
          if (outcome.ok !== true) return postResult(outcome, '')
          return postResult(outcome, '已保存')
        }).then((outcome) => {
          if (outcome.ok === true) props.reload()
          return outcome
        })

      return h(
        'div',
        { style: skin.card },
        h(
          'div',
          { style: skin.row },
          h('strong', { style: { fontSize: S.subheadFontSize } }, '默认值'),
          h(Pill, null, '生图不带参数时用这一套'),
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column' } },
          h(
            Field,
            { label: '厂商', description: '生图请求走哪一家适配器' },
            h(SelectField, {
              id: 'pxm-defaults-provider',
              // 弹层里的搜索框用 `aria-label='搜索：厂商'` —— 名字来自这里的字段名，
              // 而不是另抄一份文案（抄一份就会与标签漂移）。
              label: '厂商',
              value: provider,
              disabled: save.busy,
              options: providers.map((item) => ({
                value: String(item.id ?? ''),
                label: String(item.label ?? item.id ?? '—'),
              })),
              onChange: (event) => onProvider(event.target.value),
            }),
          ),
          h(
            Field,
            { label: '模型', description: '留空则用该厂商的第一个模型' },
            h(SelectField, {
              id: 'pxm-defaults-model',
              label: '模型',
              value: model,
              disabled: save.busy,
              options: [
                { value: '', label: '（用该厂商的第一个模型）' },
                ...models.map((name) => ({ value: String(name), label: String(name) })),
                // 当前默认模型不在列表里时也显示出来，避免界面与配置不一致
                ...(model !== '' && models.indexOf(model) < 0
                  ? [{ value: model, label: model + '（不在列表里）' }]
                  : []),
              ],
              onChange: (event) => setModel(event.target.value),
            }),
            // 光靠下拉里的「（不在列表里）」不够：那要展开才看得到。
            // 拉取后窄化模型列表就会落到这个状态，所以这里显式提示一句。
            model !== '' && models.indexOf(model) < 0
              ? h(
                  'span',
                  // Tag 化的小字：几何照官方 `Tag.module.css` 的 `.tag`（只有配色是本地的 warn）。
                  { style: { fontSize: S.tagFontSize, color: T.warn, lineHeight: S.tagLineHeight } },
                  '该模型不在当前厂商的模型列表里（拉取后窄化列表会这样），建议重新选择',
                )
              : null,
          ),
          h(
            Field,
            { label: '尺寸', description: '默认出图尺寸（Agnes 的档位 1K–4K 由精确像素决定）' },
            h(SelectField, {
              id: 'pxm-defaults-size',
              label: '尺寸',
              value: size,
              disabled: save.busy,
              options: sizes,
              onChange: (event) => setSize(event.target.value),
            }),
          ),
          h(
            Field,
            { label: '每次张数', description: '单次生图张数（1–4）' },
            h(NumberStepper, {
              value: nValue,
              min: 1,
              max: 4,
              unit: '张',
              disabled: save.busy,
              increaseLabel: '增加每次张数',
              decreaseLabel: '减少每次张数',
              onChange: (next) => setN(String(next)),
            }),
          ),
        ),
        h(
          'div',
          { style: skin.row },
          h(
            Btn,
            { disabled: save.busy || !nValid, onClick: onSave, title: '写入 config.json 的 defaults' },
            save.busy ? '保存中…' : '保存默认值',
          ),
          nValid ? null : h('span', { style: { fontSize: '12px', color: T.error } }, '张数应为 1–4 的整数'),
        ),
        h(Msg, { result: save.result }),
      )
    }

    /**
     * 「作品库导出路径」卡片：配置 `exportDir`。
     *
     * 语义变更：这里以前是「产物保存」——配好后每张成功的图都会被**自动复制**一份过去。
     * 那条自动复制已经**取消**（生成不该有未经请求的副作用：图片只落数据目录）。
     * 现在这个路径唯一的用途是：用户在作品库点「导出」时，把该项目的图片复制到
     * `<该路径>/<项目 id>/`。
     *
     * 语义：**留空 = 未配置**（导出按钮会提示先去这里填）；非空必须是绝对路径
     * （宿主侧也会校验并回 `invalid_export_dir`）。失焦与点「保存」等价，
     * 成功后重取 `api/providers`。
     */
    function ExportDirCard(props) {
      const current = isString(props.exportDir) ? props.exportDir : ''
      const [value, setValue] = React.useState(current)
      const save = useMutation()
      /**
       * 「清除」要压过「失焦即保存」。
       *
       * 真实浏览器里点按钮会先让输入框失焦（blur 先于 click），于是"输入了新路径
       * 再点清除"会变成"把新路径保存了"。这里在按钮的 mousedown 上打个标记，
       * 让紧随其后的 blur 让位给显式的清除动作。
       */
      const skipBlur = React.useRef(false)

      // 宿主的视图变了（保存/清除成功后的重取）→ 同步输入框
      React.useEffect(() => {
        setValue(current)
      }, [current])

      const submit = (next) =>
        save.run(async () => {
          const outcome = await apiPost('api/settings/export-dir', { exportDir: next }, (payload) =>
            isString(payload.exportDir),
          )
          if (outcome.ok !== true) return postResult(outcome, '')
          return postResult(outcome, next === '' ? '已清除，导出前需要重新配置' : '已保存')
        }).then((outcome) => {
          if (isObject(outcome) && outcome.ok === true && typeof props.reload === 'function') {
            props.reload()
          }
          return outcome
        })

      const trimmed = value.trim()
      const dirty = trimmed !== current

      return h(
        'div',
        { style: skin.card },
        h(
          'div',
          { style: skin.row },
          h('strong', { style: { fontSize: S.subheadFontSize } }, '作品库导出路径'),
          h(Pill, null, current === '' ? '未设置' : '已设置'),
        ),
        h(
          'p',
          { style: skin.muted },
          '生成时不再自动复制任何文件：图片只写在插件数据目录，从侧边栏「PixMart → 作品库」查看。' +
            '只有你在作品库点「导出」时，才会把该项目的图片复制到 该路径/<项目 id>/（原件始终保留）。' +
            '留空 = 未配置，导出按钮会提示你先来这里填。',
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column' } },
          h(
            Field,
            {
              label: '作品库导出路径（须为绝对路径）',
              description: '留空 = 未配置；导出时才复制到 <该路径>/<项目 id>/',
            },
            h(TextInput, {
              id: 'pxm-export-dir',
              value,
              disabled: save.busy,
              placeholder: '绝对路径，如 D:/PixMartExport（留空 = 未配置）',
              onChange: (event) => setValue(event.target.value),
              onBlur: () => {
                if (skipBlur.current) {
                  skipBlur.current = false
                  return
                }
                if (trimmed !== current) submit(trimmed)
              },
            }),
          ),
        ),
        h(
          'div',
          { style: skin.row },
          h(
            Btn,
            {
              disabled: save.busy || !dirty,
              onClick: () => submit(trimmed),
              title: '写入 config.json 的 exportDir；只在作品库点「导出」时使用',
            },
            save.busy ? '保存中…' : '保存',
          ),
          // 包一层只为接 mousedown（见 skipBlur 的说明），不改变按钮本身的样子。
          h(
            'span',
            {
              style: { display: 'inline-flex' },
              onMouseDown: () => {
                skipBlur.current = true
              },
            },
            h(
              Btn,
              {
                disabled: save.busy || current === '',
                onClick: () => submit(''),
                title: '清空该设置：回到"未配置"，导出前需要重新填写',
              },
              '清除',
            ),
          ),
          save.busy ? h(Spinner, { label: '保存中' }) : null,
        ),
        h(Msg, { result: save.result }),
      )
    }

    function ProvidersSection(props) {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null })

      /** 卸载后不再 setState（`reload` 会被卡片在 await 之后调用）。 */
      const alive = React.useRef(true)
      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const reload = React.useCallback(
        () =>
          apiGet('api/providers', isProviders).then((result) => {
            if (!alive.current) return
            if (result.ok) setState({ phase: 'ready', data: result.data, error: null })
            else setState({ phase: 'error', data: null, error: result.error })
          }),
        [],
      )

      React.useEffect(() => {
        let alive = true
        apiGet('api/providers', isProviders).then((result) => {
          if (!alive) return
          if (result.ok) setState({ phase: 'ready', data: result.data, error: null })
          else setState({ phase: 'error', data: null, error: result.error })
        })
        return () => {
          alive = false
        }
      }, [])

      // 不再自带「关闭」按钮：shell 已在设置面板右上角提供 X（与「打开配置文件」并列），
      // 页面内再放一个重复且占位。`props.close` 仍然保留可用，留给"跳出设置去开会话"那类流程。
      const header = h('div', { style: skin.row }, h('h2', { style: skin.title }, 'PixMart 电商生图'))

      if (state.phase === 'loading') {
        return h(
          'div',
          { className: 'pxm-settings', style: skin.wrap },
          header,
          h(LoadingRow, { text: '正在读取厂商与用量…' }),
        )
      }
      if (state.phase === 'error') {
        return h(
          'div',
          { className: 'pxm-settings', style: skin.wrap },
          header,
          h(
            Notice,
            { role: 'alert', title: '读取失败', detail: state.error },
            h(
              'div',
              { style: skin.row },
              h(Btn, { onClick: () => reload() }, '重试'),
              h('p', { style: skin.muted }, '宿主路由可能尚未就绪，或插件未加载到当前 profile。'),
            ),
          ),
        )
      }

      const data = state.data
      const defaults = isObject(data.defaults) ? data.defaults : {}
      const usage = isObject(data.usage) ? data.usage : {}
      // 历史产出：账本（usage.jsonl）自 P2 起才有，此前的产出由项目记录汇总。
      // 不单列的话，"累计用量 0"会和用户可见的项目并排出现、数字对不上。
      const historical = isObject(data.historical) ? data.historical : {}

      /**
       * 把「标签 + 值」包成一个**成组的** flex 项，同时守住两个目标：
       *
       *   1. **不拆散**（bug 1，97083a9）：标签 `whiteSpace: 'nowrap'` + `flexShrink: 0`，
       *      值就永远紧跟在同一行的标签右边；换行只会发生在**组的外侧**
       *      （外层 `skin.row` 的 wrap），整对一起走。
       *   2. **不撑破**（本 bug）：组上那条 `whiteSpace: 'nowrap'` 已经去掉，值拿
       *      `minWidth: 0` + `overflowWrap: 'anywhere'` —— 长路径在**自己内部**换行
       *      （`1:1` / `ofox` / `D:/pixmart` 这类短值的外观不变）。
       *
       * 这里**故意不给组加 `flexWrap: 'wrap'`**：实测（520px + 87 字符路径）下，
       * flex 的行划分用的是每个子项的**假设主轴尺寸**（= 值的 max-content 574px），
       * 所以 wrap 会把值整体推到第二行 —— 那正是"标签与值被拆散"本身，
       * 既有用例 7b 立刻变红（labelRect.top 700.9 vs valueRect.top 724.9）。
       * 正确做法是 nowrap + 让值可收缩：值一收窄就在自己内部换行。
       *
       * `overflowWrap: 'anywhere'`（而不是 `break-word`）还额外把值的
       * **min-content 宽度**压到一个字符，所以组总是能收窄进容器；断行能力只留这一处
       * （`word-break` 影响不到 min-content 宽度，留着反而会掩盖"值不可收缩"的回归）。
       */
      const field = (label, value) =>
        h(
          'span',
          {
            style: {
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: '6px',
              maxWidth: '100%',
              minWidth: 0,
            },
          },
          h('span', { style: { ...skin.key, whiteSpace: 'nowrap', flexShrink: 0 } }, label),
          h(
            'code',
            { style: { ...skin.code, wordBreak: 'normal', minWidth: 0, overflowWrap: 'anywhere' } },
            value,
          ),
        )

      const providers = data.providers.filter(isObject)

      return h(
        'div',
        { className: 'pxm-settings', style: skin.wrap },
        header,
        h(
          'p',
          { style: skin.muted },
          '在此填写密钥与端点、拉取模型、测试连接，并选定默认生图模型。' +
            '密钥只以「是否就位」的形式回显，任何时候都不会显示内容。',
        ),

        h(DefaultsCard, {
          providers,
          defaults,
          reload,
        }),

        /*
         * 厂商区块 = 官方「模型」设置页的 `._3nPmjq_section` + `._3nPmjq_rows`
         * （`settings-models/lib/client.js:58`；标记结构见同文件 :2102-2234）：
         *   - 区块 `{flex-direction:column;gap:12px}`（这里 12px 由 `vendorRows` 承担，
         *     外层 `skin.wrap` 已经是列方向 + 14px 间距）；
         *   - 列表 `ul.rows{flex-direction:column;gap:8px;margin:12px 0 0;padding:0;list-style:none}`，
         *     每一家厂商 = 一个 `li.rowCard`（见 `ProviderCard` 的 `rowCardStyle`）。
         * 这里**不再**用 `skin.card` 套一层壳：官方没有"卡片套卡片"，厂商卡片本身就是卡片。
         */
        h(
          'div',
          { className: 'pxm-vendors', style: { display: 'flex', flexDirection: 'column', gap: S.catalogGap } },
          h(
            'div',
            { style: skin.row },
            h('strong', { style: { fontSize: S.subheadFontSize } }, '厂商'),
            h(Pill, null, providers.length + ' 个'),
            h(Btn, { onClick: () => reload(), title: '重新读取厂商与模型' }, '刷新'),
          ),
          providers.length === 0
            ? h('p', { style: skin.muted }, '未配置任何厂商。可在插件配置中补充 provider 条目。')
            : h(
                'ul',
                {
                  className: 'pxm-vendor-rows',
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: S.vendorRowsGap,
                    margin: '12px 0 0',
                    padding: 0,
                    listStyle: 'none',
                    minWidth: 0,
                  },
                },
                providers.map((provider, index) =>
                  h(ProviderCard, {
                    key: isString(provider.id) ? provider.id : 'p' + String(index),
                    provider,
                    index,
                    reload,
                  }),
                ),
              ),
        ),

        h(
          'div',
          { style: skin.card },
          h('strong', { style: { fontSize: S.subheadFontSize } }, '累计用量'),
          h(
            'div',
            { style: skin.row },
            h(Pill, null, '请求 ' + String(usage.requests ?? 0)),
            h(Pill, null, '成功 ' + String(usage.ok ?? 0)),
            h(Pill, null, '失败 ' + String(usage.failed ?? 0)),
            h(Pill, null, '出图 ' + String(usage.images ?? 0)),
          ),
          Number(historical.images ?? 0) > 0
            ? h(
                'div',
                { style: { fontSize: '12px', opacity: 0.7, lineHeight: 1.6 } },
                '历史产出（账本之前）：' +
                  String(historical.images) +
                  ' 张 / ' +
                  String(historical.projects ?? 0) +
                  ' 个项目 —— ' +
                  String(historical.note ?? ''),
              )
            : null,
          h('div', { style: skin.row }, field('数据目录', String(data.dataDir ?? '—'))),
        ),

        // 放在最后：厂商卡片里已有按钮文案为「保存」，这里再出现一个「保存」
        // 不该改变既有卡片在 DOM 中的先后（设置页的自动化测试按文案取按钮）。
        h(ExportDirCard, { exportDir: data.exportDir, reload }),

        h('p', { style: skin.muted }, '插件 ' + PLUGIN + '@' + VERSION + ' · 设置页插槽 settings.section'),
      )
    }

    // ── ② sidebar.panellist 图标 + main(key 'pixmart') 作品库 ───────────────

    function PanelIcon(props) {
      const size = isNumber(props?.size) ? props.size : 18
      const active = props?.active === true
      return h(
        'span',
        {
          'aria-hidden': 'true',
          style: {
            width: size + 'px',
            height: size + 'px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: Math.max(9, Math.round(size * 0.55)) + 'px',
            fontWeight: 700,
            letterSpacing: '-0.5px',
            borderRadius: '4px',
            background: active ? tint(T.label, 18) : 'transparent',
          },
        },
        'PM',
      )
    }

    // ── 作品库：时间格式 + 生产记录（第 1 批） + 软删/回收站/导出（第 2 批无费用部分） ──

    function pad2(value) {
      const text = String(value)
      return text.length >= 2 ? text : '0' + text
    }

    /**
     * 时间戳 → `YYYY-MM-DD HH:mm`（本地时区）。
     *
     * 特意不用 `toLocaleString`：它随浏览器语言与时区变，既让用户看到的格式不可预期，
     * 也让测试写不出稳定断言。取不到就显示 `—`，**绝不显示 "Invalid Date"**。
     */
    function formatDateTime(ms) {
      if (!isNumber(ms) || ms <= 0) return '—'
      const date = new Date(ms)
      if (!isNumber(date.getTime())) return '—'
      return (
        String(date.getFullYear()) +
        '-' +
        pad2(date.getMonth() + 1) +
        '-' +
        pad2(date.getDate()) +
        ' ' +
        pad2(date.getHours()) +
        ':' +
        pad2(date.getMinutes())
      )
    }

    /** 耗时：<1s 用毫秒，否则一位小数的秒。 */
    function formatDuration(ms) {
      if (!isNumber(ms) || ms < 0) return '—'
      if (ms < 1000) return String(Math.round(ms)) + ' ms'
      return (ms / 1000).toFixed(1) + ' s'
    }

    /**
     * 「复制提示词」。
     *
     * 红线（作品库优化方案 §第 1 批）：复制失败**不能静默**——降级成一段可选中文本，
     * 并把失败原因显示出来。`navigator.clipboard` 在非安全上下文（非 https / 非 localhost）
     * 与老浏览器上根本不存在，这不是异常情况，而是必须处理的正常分支。
     */
    function CopyPromptButton(props) {
      const prompt = isString(props.prompt) ? props.prompt : ''
      const [result, setResult] = React.useState(null)
      const alive = useAlive()

      if (prompt === '') return null

      const onCopy = () => {
        const clipboard =
          typeof navigator === 'undefined' || navigator === null ? null : navigator.clipboard
        let pending = null
        try {
          pending =
            clipboard !== null && typeof clipboard === 'object' && typeof clipboard.writeText === 'function'
              ? clipboard.writeText(prompt)
              : null
        } catch (err) {
          setResult({ ok: false, error: err && err.message ? err.message : '剪贴板调用失败' })
          return
        }
        if (pending === null || typeof pending.then !== 'function') {
          setResult({ ok: false, error: '当前环境不支持剪贴板 API' })
          return
        }
        pending.then(
          () => {
            if (alive.current) setResult({ ok: true, error: null })
          },
          (err) => {
            if (!alive.current) return
            setResult({ ok: false, error: err && err.message ? err.message : '复制被拒绝' })
          },
        )
      }

      const failed = result !== null && result.ok !== true

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h(
          'div',
          { style: skin.row },
          h(
            Btn,
            { className: 'pxm-copy-btn', onClick: onCopy, title: '复制这条提示词，便于复用同参数' },
            result !== null && result.ok === true ? '已复制' : '复制提示词',
          ),
        ),
        failed
          ? h(
              'div',
              { role: 'alert', style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              h(
                'span',
                { style: { fontSize: '12px', lineHeight: 1.6, color: T.error, wordBreak: 'break-word' } },
                '复制失败：' + String(result.error) + '（已展开为可选中文本，请手动复制）',
              ),
              h('textarea', {
                readOnly: true,
                className: 'pxm-copy-fallback',
                'aria-label': '提示词（可手动复制）',
                value: prompt,
                onFocus: (event) => {
                  try {
                    event.target.select()
                  } catch {
                    /* 选择失败不影响文本可选 */
                  }
                },
                style: {
                  width: '100%',
                  minHeight: '64px',
                  font: 'inherit',
                  fontSize: '12px',
                  lineHeight: 1.6,
                  padding: '6px 8px',
                  borderRadius: '6px',
                  color: T.label,
                  // 大段文本（提示词）是**输入类控件**，与上面的 `inputStyle` 同层同边框：
                  // 官方 `.input` 就是 `bg-layer-3` + `0.5px border-l4`（见 `inputStyle` 的注释）。
                  background: T.bgLayer3,
                  border: '0.5px solid ' + T.borderL4,
                },
              }),
            )
          : null,
      )
    }

    /** 「标签：值」的一行元信息。 */
    function MetaRow(props) {
      return h(
        'div',
        { style: { display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '12px' } },
        h('span', { style: { ...skin.key, minWidth: '60px', flex: '0 0 auto' } }, props.label),
        h('span', { style: { wordBreak: 'break-word', overflowWrap: 'anywhere', opacity: 0.86 } }, props.children),
      )
    }

    /**
     * 项目卡片。
     *
     * 结构上是「外层定位容器 + 内层真按钮 + 右上角复选框」：
     *   - 复选框**不能**放进按钮里（嵌套交互元素在 HTML 里非法，点击语义也会打架），
     *     所以它是按钮的兄弟节点，点它不会顺带打开项目详情；
     *   - 封面只加载**一张**（`cover`），并带 `loading="lazy"` + `decoding="async"`，
     *     50+ 项目时首屏只为可视区域内的卡片取图。
     */
    function ProjectCard(props) {
      const project = props.project
      const cover = fileUrl(project.id, project.cover)
      const id = isString(project.id) ? project.id : ''
      const name = String(project.name ?? project.id ?? '项目')
      const selected = props.selected === true
      return h(
        'div',
        { className: 'pxm-tile-wrap', style: { position: 'relative' } },
        h(
          'button',
          {
            type: 'button',
            className: selected ? 'pxm-tile pxm-tile-selected' : 'pxm-tile',
            onClick: () => props.onOpen(id),
            style: {
              font: 'inherit',
              color: T.label,
              textAlign: 'left',
              cursor: 'pointer',
              padding: '8px',
              borderRadius: '10px',
              // 选中态用官方**三级文字色**描边。**不**用 `brand-primary`：那是主按钮填充色
              // （浅色近黑 / 深色近白），选中描边会变成"像按钮"的假象；此处要的是中性强调。
              border: selected ? '1px solid ' + T.labelTertiary : '1px solid ' + T.borderL1,
              background: selected ? tint(T.labelTertiary, 6) : T.bgLayer2,
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              width: '100%',
              boxSizing: 'border-box',
            },
          },
          h(
            'div',
            {
              style: {
                aspectRatio: '4 / 3',
                borderRadius: '6px',
                overflow: 'hidden',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: T.bgBase,
                fontSize: '12px',
                opacity: 0.85,
              },
            },
            cover === null
              ? h('span', null, '无封面')
              : h('img', {
                  src: cover,
                  alt: name + ' 的封面',
                  loading: 'lazy',
                  decoding: 'async',
                  style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
                }),
          ),
          h('span', { style: { fontSize: '13px', fontWeight: 600, overflowWrap: 'anywhere' } }, name),
          h(
            'span',
            { style: { fontSize: '12px', opacity: 0.7 } },
            String(project.imageCount ?? 0) + ' 张 · ' + String(project.provider ?? '—'),
          ),
          // 创建时间（第 1 批：卡片上补时间）
          h(
            'span',
            { className: 'pxm-tile-time', style: { fontSize: '12px', opacity: 0.6 } },
            formatDateTime(project.createdAt),
          ),
        ),
        h(
          'span',
          {
            style: {
              position: 'absolute',
              top: '12px',
              right: '12px',
              display: 'flex',
              padding: '2px',
              borderRadius: '6px',
              background: tint(T.label, 10),
            },
          },
          h('input', {
            type: 'checkbox',
            className: 'pxm-select-box',
            checked: selected,
            disabled: id === '',
            'aria-label': '选择项目 ' + name,
            title: '选中后可批量导出 / 删除',
            onChange: () => {
              if (typeof props.onToggleSelect === 'function') props.onToggleSelect(id)
            },
            style: { margin: 0, cursor: 'pointer' },
          }),
        ),
      )
    }

    /**
     * 把详情里的 `items` 摊平成"一张图一条"的序列，供查看器左右切换。
     *
     * 为什么按**项目内全部图片**而不是按模块：用户点开一张图后按 → ，期待的是
     * "看下一张"，而不是"卡在这个模块里出不去"。每个条目自带模块上下文
     * （模块名 / 尺寸 / 模型 / 提示词），所以切到哪一张都说得清它是谁。
     */
    function buildViewerEntries(items) {
      const entries = []
      if (!isArray(items)) return entries
      items.forEach((item, itemIndex) => {
        const images = isArray(item?.images) ? item.images.filter(isString) : []
        images.forEach((image, k) => {
          entries.push({
            itemIndex,
            itemImageIndex: k,
            itemImageCount: images.length,
            image,
            label: isString(item?.label) ? item.label : '',
            module: isString(item?.module) ? item.module : '',
            size: isString(item?.size) ? item.size : '',
            model: isString(item?.model) ? item.model : '',
            prompt: isString(item?.prompt) ? item.prompt : '',
          })
        })
      })
      return entries
    }

    /** 查看器里两张对比图之间的箭头。 */
    const compareArrowStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '18px',
      opacity: 0.6,
      flex: '0 0 auto',
    }

    /**
     * 查看器里可聚焦的元素（Tab 陷阱用）。
     *
     * `:not([disabled])` 是必要的：`← 上一张 / 下一张 →` 在只有一张图时是 disabled，
     * 浏览器会跳过它们，但 `querySelectorAll` 不会——不排除就会把焦点"交给"一个
     * 根本聚焦不了的按钮，Tab 看起来像卡住了。
     */
    const VIEWER_FOCUSABLE =
      'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

    /**
     * 把 `Tab` / `Shift+Tab` 关在查看器内部（模态层的焦点不该游到背后的滚动列表里）。
     *
     * 接管**全部** Tab 并自己挑落点：`preventDefault` 之后浏览器不会再移动焦点，落点就
     * 完全由这里决定——顺序取自 `querySelectorAll` 的文档顺序，正是浏览器默认顺序；
     * 好处是末尾回绕、焦点已在查看器之外的两种情况都只有一份实现，且在任何宿主里
     * 结果一致（有些宿主根本没有 Tab 的默认焦点移动）。
     * 查看器里只有按钮与复选框，没有需要浏览器特判的 `<label>` / shadow 组合。
     */
    function trapTabKey(event, scope) {
      if (!isObject(scope) || typeof scope.querySelectorAll !== 'function') return
      if (isObject(event) && typeof event.preventDefault === 'function') event.preventDefault()
      const doc = scope.ownerDocument
      const active = doc === null || doc === undefined ? null : doc.activeElement
      const inside = active !== null && active !== undefined && scope.contains(active)
      const nodes = Array.from(scope.querySelectorAll(VIEWER_FOCUSABLE))
      const back = isObject(event) && event.shiftKey === true
      if (nodes.length === 0) {
        // 一个可聚焦元素都没有：焦点钉在查看器根上，绝不还给背景。
        if (typeof scope.focus === 'function') scope.focus({ preventScroll: true })
        return
      }
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (!inside) {
        ;(back ? last : first).focus()
        return
      }
      if (back && (active === first || active === scope)) {
        last.focus()
        return
      }
      if (!back && active === last) {
        first.focus()
        return
      }
      // 中间位置：上面已经 preventDefault 了，得自己往前/往后挪一格。
      const at = nodes.indexOf(active)
      const next = at < 0 ? (back ? last : first) : nodes[back ? at - 1 : at + 1]
      if (next !== undefined) next.focus()
    }

    /**
     * 大图查看器（`position: fixed` 覆盖层，**不使用 `shell.overlay`**）。
     *
     * 为什么不用 `shell.overlay`：那个全局座位已经被「实时预览卡」占用，一个插件同一
     * 座位注册两次会互相覆盖。查看器是作品库面板**内部**的模态层，用 fixed 定位即可。
     *
     * **顶栏锚定**：`top` 取 shell 发布的 `--dsh-frame-chrome-top`，不是 `0`。
     * 在 Windows 桌面外壳里，视口顶部那条带（40px）属于窗口 chrome：Electron 用
     * `titleBarOverlay: { height: 40 }` 把原生最小化/最大化/关闭按钮画在 **web 内容之上**，
     * 桌面 preload 又把「应用 / 编辑」菜单挂成 `position: fixed; top: 0; z-index: 1100`
     * 的宿主；而 `ui-layout` 的 AppFrame 用 `padding-top: var(--dsh-windows-titlebar-height)`
     * 把三栏整体压到这条带下面。查看器若从 0 起画，自己的顶栏（模块标签 / 关闭）就会压到
     * 标题栏上、或被原生按钮盖住。shell 为模态层发布的正是 `--dsh-frame-chrome-top`
     * （Windows = 标题栏高度，原生全屏归零；普通浏览器文档不发布 → 回退 `0px`，与从前一致）。
     * **不写死像素高度**：那 40px 是运行时由 preload 写进 `--dsh-windows-titlebar-height` 的。
     *
     * **顶栏不跟着内容滚**：查看器内部分成"固定顶栏 + 唯一滚动区"两层（与作品库面板同一
     * 骨架）。顶栏（标签 / 位置计数 / 并排对比 / 关闭）永远在视口里，滚的只有图片与文案。
     *
     * 交互：`Esc` 关闭、`←` `→` 在项目内的图片之间切换、多张时显示「3 / 8」。
     * 「并排对比」只在**当前这张图所在模块有多张**时出现（只有 1 张时没有可对比的对象，
     * 出现一个点了没反应的开关比不出现更糟）。
     * 打开时锁定背景滚动（`WorkbenchPanel` 的 effect 负责，见 `lockBackgroundScroll`）、
     * 把焦点收进查看器并用 Tab 陷阱关住；关闭后把焦点还给打开它的那张缩略图，
     * 并把滚动位置放回原处。
     */
    function ImageViewer(props) {
      const entries = isArray(props.entries) ? props.entries : []
      const projectId = isString(props.projectId) ? props.projectId : ''
      const index = isNumber(props.index) ? props.index : 0
      const entry = entries[index]
      const canCompare = isObject(entry) && entry.itemImageCount > 1
      const compare = props.compare === true && canCompare
      /** 查看器根：Tab 陷阱的边界 + 打开时的焦点落点。 */
      const rootRef = React.useRef(null)

      React.useEffect(() => {
        const doc = typeof document === 'undefined' ? null : document
        if (doc === null) return undefined
        const onKey = (event) => {
          const key = event && event.key
          if (key === 'Escape') {
            event.preventDefault()
            props.onClose()
            return
          }
          if (key === 'ArrowLeft') {
            event.preventDefault()
            props.onStep(-1)
            return
          }
          if (key === 'ArrowRight') {
            event.preventDefault()
            props.onStep(1)
            return
          }
          if (key === 'Tab') trapTabKey(event, rootRef.current)
        }
        doc.addEventListener('keydown', onKey)
        return () => doc.removeEventListener('keydown', onKey)
      })

      /**
       * 打开时把焦点收进查看器（只跑一次：切上一张/下一张不该把焦点抢回来）。
       *
       * `preventScroll` 很关键：聚焦本身会触发"滚动到可见"，而查看器是 fixed 的，
       * 不带这个选项就可能把背后的滚动容器拉一下——正是要避免的"背景动了"。
       */
      React.useEffect(() => {
        const node = rootRef.current
        if (node === null || node === undefined || typeof node.focus !== 'function') return
        try {
          node.focus({ preventScroll: true })
        } catch {
          try {
            node.focus()
          } catch {
            /* 聚焦失败不影响查看器打开 */
          }
        }
      }, [])

      if (!isObject(entry)) return null

      const url = fileUrl(projectId, entry.image)
      // 对比对象：先看同一模块的下一张，没有了就退回上一张（"同一模块出现多张"的唯一场景）。
      const itemEntries = entries.filter((other) => other.itemIndex === entry.itemIndex)
      const pairIndex = entry.itemImageIndex + 1 < itemEntries.length
        ? entry.itemImageIndex + 1
        : entry.itemImageIndex - 1
      const pair = compare ? itemEntries[pairIndex] : null
      const pairUrl = isObject(pair) ? fileUrl(projectId, pair.image) : null

      const stage = (source, altText) =>
        source === null
          ? h('span', { style: skin.muted }, '这张图取不到地址')
          : h('img', {
              src: source,
              alt: altText,
              decoding: 'async',
              className: 'pxm-viewer-img',
              style: {
                maxWidth: '100%',
                maxHeight: '62vh',
                objectFit: 'contain',
                display: 'block',
                borderRadius: '8px',
                background: T.bgLayer2,
              },
            })

      /**
       * 固定顶栏：模块标签 / 位置计数 / 并排对比 / 关闭。
       *
       * 它在滚动区**外面**——"顶栏必须完整可见"这条不能只靠锚定位置，还得保证它不会
       * 被自己的内容滚走（原来整块查看器是一个 `overflow: auto`，滚一下顶栏就没了）。
       */
      const viewerBar = h(
        'div',
        {
          className: 'pxm-viewer-bar',
          style: { ...skin.row, justifyContent: 'space-between', flex: '0 0 auto' },
        },
        h(
          'div',
          { style: skin.row },
          h('strong', { style: { fontSize: S.subheadFontSize } }, entry.label || entry.module || '产出图'),
          isString(entry.module) && entry.module !== '' ? h('code', { style: skin.code }, entry.module) : null,
          entries.length > 1
            ? h(Pill, { key: 'pos' }, String(index + 1) + ' / ' + String(entries.length))
            : null,
        ),
        h(
          'div',
          { style: skin.row },
          canCompare
            ? h(
                'label',
                {
                  className: 'pxm-compare-toggle',
                  style: { ...skin.row, gap: '4px', fontSize: '12px', cursor: 'pointer' },
                },
                h('input', {
                  type: 'checkbox',
                  checked: compare,
                  onChange: () => props.onToggleCompare(!compare),
                  style: { margin: 0, cursor: 'pointer' },
                }),
                '并排对比',
              )
            : null,
          h(Btn, { className: 'pxm-viewer-close', onClick: props.onClose }, '关闭'),
        ),
      )

      /**
       * 唯一滚动区：图片 + 元信息卡（`minHeight:0` 是它在 flex 链里真能被压缩的前提）。
       *
       * `overscrollBehavior: 'contain'` 把滚轮的链式滚动挡在查看器里：滚到底之后不再
       * 往背后的滚动容器上传（"背景跟着滚"的那条路）。
       */
      const viewerBody = h(
        'div',
        {
          className: 'pxm-viewer-scroll',
          style: {
            flex: '1 1 auto',
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            overscrollBehavior: 'contain',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              gap: '10px',
              alignItems: 'center',
              justifyContent: 'center',
              flexWrap: 'wrap',
            },
          },
          h(Btn, { className: 'pxm-viewer-prev', onClick: () => props.onStep(-1), disabled: entries.length < 2 }, '← 上一张'),
          pair === null
            ? stage(url, entry.label || '产出图')
            : h(
                'div',
                {
                  className: 'pxm-compare-pair',
                  style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' },
                },
                stage(url, entry.label || '产出图'),
                h('span', { style: compareArrowStyle }, '↔'),
                stage(pairUrl, entry.label || '对比图'),
              ),
          h(Btn, { className: 'pxm-viewer-next', onClick: () => props.onStep(1), disabled: entries.length < 2 }, '下一张 →'),
        ),
        h(
          'div',
          { style: { ...skin.card, maxWidth: '760px', margin: '0 auto', width: '100%', boxSizing: 'border-box' } },
          h(MetaRow, { label: '尺寸' }, entry.size === '' ? '—' : entry.size),
          h(MetaRow, { label: '模型' }, entry.model === '' ? '—' : entry.model),
          h(MetaRow, { label: '模块' }, entry.module === '' ? '—' : entry.module),
          h('span', { style: skin.key }, '提示词'),
          entry.prompt === ''
            ? h('p', { style: skin.muted }, '这个模块没有留下提示词。')
            : h(
                'p',
                {
                  className: 'pxm-viewer-prompt',
                  style: {
                    margin: 0,
                    fontSize: '12px',
                    lineHeight: 1.7,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    padding: '6px 8px',
                    borderRadius: '6px',
                    background: tint(T.label, 6),
                  },
                },
                entry.prompt,
              ),
          h(CopyPromptButton, { prompt: entry.prompt }),
        ),
      )

      return h(
        'div',
        {
          className: 'pxm-viewer',
          ref: rootRef,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '图片查看器',
          // 可聚焦（`tabIndex:-1`）只是为了"打开时把焦点收进来"和 Tab 陷阱有个边界，
          // 不会被 Tab 顺序选中（陷阱的选择器排除了 `[tabindex="-1"]`）。
          tabIndex: -1,
          style: {
            position: 'fixed',
            // 顶栏带（Windows 标题栏 / 原生窗口按钮）不归查看器画：见函数头注释。
            // 用 shell 的变量而不是 40px 这种写死的数：全屏时它归零，普通浏览器里回退 0。
            top: 'var(--dsh-frame-chrome-top, 0px)',
            right: '0px',
            bottom: '0px',
            left: '0px',
            // 60 < 标题栏菜单宿主的 1100：查看器永不盖住窗口 chrome。
            zIndex: 60,
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            padding: '16px',
            boxSizing: 'border-box',
            // 滚动只发生在 .pxm-viewer-scroll 里；根盒子自己不滚，顶栏才不会被滚走。
            overflow: 'hidden',
            overscrollBehavior: 'contain',
            outline: 'none',
            color: T.label,
            // 查看器是**浮层**：底色用 bg-overlay 的 92% 半透明（保留原来的毛玻璃观感）。
            background: tint(T.bgOverlay, 92),
            backdropFilter: 'blur(2px)',
          },
        },
        viewerBar,
        viewerBody,
      )
    }

    /**
     * 项目详情 = **生产记录**。
     *
     * 每个模块都显示：提示词（可复制）· 模型 · 耗时 · 时间 · 降级标记 · 失败原因。
     * 这些都是 `project.json` 里一直有、以前被 HTTP 层丢掉的信息（优化方案 §1.2）。
     *
     * 破坏性动作（删除）一律**二次确认**；导出只复制、不动原件。
     */
    function ProjectDetail(props) {
      const state = props.state
      const project = state.data
      const items = isObject(project) && isArray(project.items) ? project.items : []
      const projectId = isObject(project) && isString(project.id) ? project.id : ''
      const [action, setAction] = React.useState({ busy: null, error: null, note: null })
      const [confirming, setConfirming] = React.useState(false)
      /** 重命名的内联编辑：`null` = 没在改名。 */
      const [nameDraft, setNameDraft] = React.useState(null)
      const alive = useAlive()

      const busy = action.busy
      const exportDir = isString(props.exportDir) ? props.exportDir : ''

      /**
       * 每个模块的第一张图在"项目内图片序列"里的下标。
       * 与查看器用的 `buildViewerEntries` 同一口径（按 items 顺序、跳过非字符串）。
       */
      const itemImageOffsets = []
      let flatCount = 0
      items.forEach((item) => {
        itemImageOffsets.push(flatCount)
        flatCount += isArray(item?.images) ? item.images.filter(isString).length : 0
      })

      const onExport = () => {
        if (projectId === '' || busy !== null) return
        // 与批量导出共用同一处判定：未配置就不发那串注定失败的请求。
        // （宿主侧仍会校验一遍，作为客户端配置快照过时时的权威兜底。）
        const guard = checkExportDir(exportDir)
        if (guard.ok !== true) {
          setAction({ busy: null, error: guard.error, note: null })
          return
        }
        setAction({ busy: 'export', error: null, note: null })
        const body = { dir: guard.dir }
        apiPost('api/projects/' + encodeURIComponent(projectId) + '/export', body).then((result) => {
          if (result.ok !== true) {
            setAction({
              busy: null,
              error: explainProjectActionError(result.code, result.error),
              note: null,
            })
            return
          }
          const data = isObject(result.data) ? result.data : {}
          const warnings = isArray(data.warnings) ? data.warnings.length : 0
          setAction({
            busy: null,
            error: null,
            note:
              '已导出 ' +
              String(data.count ?? 0) +
              ' 个文件到 ' +
              String(data.dir ?? '') +
              (warnings > 0 ? '（' + String(warnings) + ' 张失败，原件未受影响）' : ''),
          })
        })
      }

      const onDelete = () => {
        if (projectId === '' || busy !== null) return
        setAction({ busy: 'delete', error: null, note: null })
        apiPost('api/projects/' + encodeURIComponent(projectId) + '/delete', { confirm: true }).then(
          (result) => {
            if (!alive.current) return
            if (result.ok !== true) {
              setAction({ busy: null, error: result.error, note: null })
              return
            }
            setConfirming(false)
            setAction({ busy: null, error: null, note: null })
            if (typeof props.onDeleted === 'function') props.onDeleted(projectId)
          },
        )
      }

      /**
       * 重命名：只改**显示名**。
       *
       * 目录名（= 项目 id）不动——这是宿主侧的硬约束，客户端这边表现为
       * "改完之后图片还看得见"（因为 `/pixmart/file/<id>/<name>` 里的 id 没变）。
       * 成功后重取详情与列表，让新名字立刻出现在两处。
       */
      const onRename = () => {
        if (projectId === '' || busy !== null || nameDraft === null) return
        const name = nameDraft.trim()
        if (name === '') return
        setAction({ busy: 'rename', error: null, note: null })
        apiPost('api/projects/' + encodeURIComponent(projectId) + '/rename', { name }).then((result) => {
          if (!alive.current) return
          if (result.ok !== true) {
            setAction({ busy: null, error: explainProjectActionError(result.code, result.error), note: null })
            return
          }
          setNameDraft(null)
          setAction({ busy: null, error: null, note: '已重命名为「' + name + '」' })
          if (typeof props.onRenamed === 'function') props.onRenamed(projectId)
        })
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h(
          'div',
          { style: skin.row },
          h(Btn, { onClick: props.onBack }, '← 返回'),
          h('h2', { style: skin.title }, String(project?.name ?? project?.id ?? '项目')),
          state.phase === 'ready' ? h(Pill, null, items.length + ' 个模块') : null,
        ),
        state.phase === 'ready'
          ? h(
              'div',
              { style: { ...skin.row, fontSize: '12px', opacity: 0.72 } },
              h('span', null, '创建于 ' + formatDateTime(project?.createdAt)),
              h('span', null, '·'),
              h('span', null, String(project?.provider ?? '—') + ' / ' + String(project?.model ?? '—')),
            )
          : null,
        state.phase === 'ready'
          ? h(
              'div',
              { style: skin.row },
              h(
                Btn,
                {
                  className: 'pxm-export-btn',
                  onClick: onExport,
                  disabled: busy !== null || projectId === '',
                  title:
                    exportDir === ''
                      ? '把项目图片复制到「作品库导出路径」（尚未配置，请先到设置里填）'
                      : '把项目图片复制到 ' + exportDir + '/<项目 id>/，原件不动',
                },
                busy === 'export' ? '导出中…' : '导出图片',
              ),
              h(
                Btn,
                {
                  className: 'pxm-rename-btn',
                  onClick: () => {
                    setNameDraft(isString(project?.name) ? project.name : '')
                    setAction({ busy: null, error: null, note: null })
                  },
                  disabled: busy !== null || projectId === '' || nameDraft !== null || confirming,
                  title: '只改显示名；项目目录（= 项目 id）不动，图片链接因此不会失效',
                },
                '重命名',
              ),
              h(
                Btn,
                {
                  className: 'pxm-delete-btn',
                  onClick: () => setConfirming(true),
                  disabled: busy !== null || projectId === '' || confirming || nameDraft !== null,
                  title: '移入回收站，可恢复',
                },
                '删除项目',
              ),
            )
          : null,
        state.phase === 'ready' && nameDraft !== null
          ? h(
              'div',
              { className: 'pxm-rename-row', style: { ...skin.row, alignItems: 'flex-end' } },
              h(
                Field,
                { label: '项目名', description: '只改显示名，不移动目录', style: { borderBottom: 'none', padding: 0 } },
                h(TextInput, {
                  className: 'pxm-rename-input',
                  value: nameDraft,
                  onChange: (event) => setNameDraft(event.target.value),
                  disabled: busy !== null,
                  placeholder: '例如：2026 秋季主图',
                }),
              ),
              h(
                Btn,
                {
                  className: 'pxm-rename-save',
                  onClick: onRename,
                  disabled: busy !== null || nameDraft.trim() === '',
                },
                busy === 'rename' ? '保存中…' : '保存',
              ),
              h(Btn, { onClick: () => setNameDraft(null), disabled: busy !== null }, '取消'),
            )
          : null,
        state.phase === 'ready' && confirming
          ? h(
              Notice,
              {
                role: 'alert',
                title: '确认删除这个项目？',
                detail: '会移入回收站（projects/.trash），之后仍可恢复；清空回收站才会真正删除。',
              },
              h(
                'div',
                { style: skin.row },
                h(
                  Btn,
                  {
                    className: 'pxm-confirm-delete',
                    onClick: onDelete,
                    disabled: busy !== null,
                  },
                  busy === 'delete' ? '删除中…' : '确认删除',
                ),
                h(Btn, { onClick: () => setConfirming(false), disabled: busy !== null }, '取消'),
              ),
            )
          : null,
        action.error !== null && action.error !== undefined
          ? h(Notice, { role: 'alert', title: '操作失败', detail: action.error })
          : null,
        action.note !== null && action.note !== undefined
          ? h(Notice, { role: 'status', title: '已完成', detail: action.note })
          : null,
        state.phase === 'loading' ? h(LoadingRow, { text: '正在读取项目…' }) : null,
        state.phase === 'error' ? h(Notice, { role: 'alert', title: '读取失败', detail: state.error }) : null,
        state.phase === 'ready' && items.length === 0
          ? h(Notice, { title: '这个项目还没有产出', detail: '生图完成后图片会出现在这里。' })
          : null,
        state.phase === 'ready'
          ? items.map((item, index) => {
              const prompt = isString(item?.prompt) ? item.prompt : ''
              const degraded = isArray(item?.degraded) ? item.degraded.filter(isString) : []
              const error = isString(item?.error) && item.error !== '' ? item.error : null
              const images = isArray(item?.images) ? item.images.filter(isString) : []
              return h(
                'div',
                { key: String(item?.module ?? index) + '-' + String(index), style: skin.card },
                h(
                  'div',
                  { style: skin.row },
                  h(
                    'strong',
                    { style: { fontSize: S.subheadFontSize } },
                    String(item?.label ?? item?.module ?? '未命名模块'),
                  ),
                  h(Pill, null, String(ITEM_STATUS_LABEL[item?.status] ?? item?.status ?? '—')),
                  isString(item?.size) ? h('code', { style: skin.code }, item.size) : null,
                  isString(item?.apiMode) && item.apiMode !== ''
                    ? h(Pill, { key: 'api' }, item.apiMode)
                    : null,
                ),
                // 失败原因放在最前面：这是用户最需要知道、以前完全看不到的东西。
                error === null
                  ? null
                  : h(
                      'p',
                      {
                        role: 'alert',
                        className: 'pxm-item-error',
                        style: { margin: 0, fontSize: '12px', lineHeight: 1.6, color: T.error, wordBreak: 'break-word' },
                      },
                      '失败原因：' + error,
                    ),
                degraded.length > 0
                  ? h(
                      'div',
                      { className: 'pxm-item-degraded', style: skin.row },
                      h(Pill, null, '降级'),
                      h(
                        'span',
                        { style: { fontSize: '12px', opacity: 0.86, wordBreak: 'break-word' } },
                        degraded.join(' · '),
                      ),
                    )
                  : null,
                h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                  h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                    h('span', { style: skin.key }, '提示词'),
                    prompt === ''
                      ? h('p', { style: skin.muted }, '这个模块没有留下提示词。')
                      : h(
                          'p',
                          {
                            className: 'pxm-prompt',
                            style: {
                              margin: 0,
                              fontSize: '12px',
                              lineHeight: 1.7,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              // 提示词里常有超长英文单词 / URL：只靠 break-word 会撑宽容器，
                              // 在窄屏上顶出横向溢出（滚动区是 overflow-x:hidden，撑出去就被切掉）。
                              overflowWrap: 'anywhere',
                              padding: '6px 8px',
                              borderRadius: '6px',
                              background: tint(T.label, 6),
                            },
                          },
                          prompt,
                        ),
                    h(CopyPromptButton, { prompt }),
                  ),
                  h(MetaRow, { label: '模型' }, String(item?.model ?? project?.model ?? '—')),
                  h(MetaRow, { label: '耗时' }, formatDuration(item?.ms)),
                  h(MetaRow, { label: '时间' }, formatDateTime(item?.createdAt)),
                ),
                images.length > 0
                  ? h(
                      'div',
                      {
                        style: {
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                          gap: '8px',
                        },
                      },
                      images.map((imageName, ii) => {
                        const url = fileUrl(projectId, imageName)
                        // 摊平下标：查看器在**项目内所有图片**之间左右切换，
                        // 所以这里要把"第几个模块的第几张"换算成全局序号。
                        const flatIndex = itemImageOffsets[index] + ii
                        return url === null
                          ? null
                          : h(
                              'button',
                              {
                                key: 'i' + String(ii),
                                type: 'button',
                                className: 'pxm-thumb',
                                title: '点开看原图（Esc 关闭，← → 切换）',
                                onClick: (event) => {
                                  if (typeof props.onOpenImage === 'function') {
                                    props.onOpenImage(flatIndex, event.currentTarget)
                                  }
                                },
                                style: {
                                  padding: 0,
                                  border: 'none',
                                  background: 'transparent',
                                  cursor: 'zoom-in',
                                  display: 'block',
                                  width: '100%',
                                },
                              },
                              h('img', {
                                src: url,
                                alt: String(item?.label ?? '产出图'),
                                loading: 'lazy',
                                decoding: 'async',
                                style: {
                                  width: '100%',
                                  aspectRatio: '1 / 1',
                                  objectFit: 'cover',
                                  borderRadius: '6px',
                                  display: 'block',
                                  background: T.bgLayer2,
                                },
                              }),
                            )
                      }),
                    )
                  : h('p', { style: skin.muted }, '这个模块没有产出图片。'),
              )
            })
          : null,
      )
    }

    /**
     * 回收站面板：列出、逐个恢复、整体清空。
     *
     * 「清空回收站」不可恢复，所以和删除一样走**二次确认**；
     * 任何一步失败都只在面板内显示可读原因（不抛异常、不白屏）。
     */
    function TrashPanel(props) {
      const state = props.state
      const [action, setAction] = React.useState({ busy: null, error: null, note: null })
      const [confirming, setConfirming] = React.useState(false)
      const alive = useAlive()
      const entries =
        state.phase === 'ready' && isObject(state.data) && isArray(state.data.trash)
          ? state.data.trash.filter(isObject)
          : []
      const busy = action.busy

      const onRestore = (id) => {
        if (busy !== null) return
        setAction({ busy: id, error: null, note: null })
        apiPost('api/trash/' + encodeURIComponent(id) + '/restore', {}).then((result) => {
          if (!alive.current) return
          if (result.ok !== true) {
            setAction({ busy: null, error: result.error, note: null })
            return
          }
          setAction({ busy: null, error: null, note: '已恢复 ' + id })
          if (typeof props.onChanged === 'function') props.onChanged()
        })
      }

      const onPurge = () => {
        if (busy !== null) return
        setAction({ busy: 'purge', error: null, note: null })
        apiPost('api/trash/purge', { confirm: true }).then((result) => {
          if (!alive.current) return
          if (result.ok !== true) {
            setAction({ busy: null, error: result.error, note: null })
            return
          }
          const data = isObject(result.data) ? result.data : {}
          setConfirming(false)
          setAction({ busy: null, error: null, note: '已清空 ' + String(data.purged ?? 0) + ' 个项目' })
          if (typeof props.onChanged === 'function') props.onChanged()
        })
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h(
          'div',
          { style: skin.row },
          h(Btn, { onClick: props.onBack }, '← 作品库'),
          h('h2', { style: skin.title }, '回收站'),
          state.phase === 'ready' ? h(Pill, null, entries.length + ' 个项目') : null,
        ),
        h('p', { style: skin.muted }, '删除的项目先移到这里，可随时恢复；清空之后才真正从磁盘删除。'),
        state.phase === 'loading' ? h(LoadingRow, { text: '正在读取回收站…' }) : null,
        state.phase === 'error'
          ? h(
              Notice,
              { role: 'alert', title: '读取回收站失败', detail: state.error },
              h(Btn, { onClick: props.onReload }, '重试'),
            )
          : null,
        state.phase === 'ready' && entries.length === 0
          ? h(Notice, { title: '回收站是空的', detail: '在项目详情里删除的项目会出现在这里。' })
          : null,
        state.phase === 'ready' && entries.length > 0
          ? h(
              'div',
              { style: skin.row },
              confirming
                ? h(
                    'span',
                    { style: skin.row },
                    h('span', { style: { fontSize: '12px', color: T.error } }, '清空后不可恢复，确认？'),
                    h(
                      Btn,
                      {
                        className: 'pxm-confirm-purge',
                        onClick: onPurge,
                        disabled: busy !== null,
                      },
                      busy === 'purge' ? '清空中…' : '确认清空',
                    ),
                    h(Btn, { onClick: () => setConfirming(false), disabled: busy !== null }, '取消'),
                  )
                : h(
                    Btn,
                    {
                      className: 'pxm-purge-btn',
                      onClick: () => setConfirming(true),
                      disabled: busy !== null,
                    },
                    '清空回收站',
                  ),
            )
          : null,
        action.error !== null && action.error !== undefined
          ? h(Notice, { role: 'alert', title: '操作失败', detail: action.error })
          : null,
        action.note !== null && action.note !== undefined
          ? h(Notice, { role: 'status', title: '已完成', detail: action.note })
          : null,
        state.phase === 'ready'
          ? entries.map((entry, index) =>
              h(
                'div',
                {
                  key: String(entry?.id ?? index),
                  className: 'pxm-trash-item',
                  style: { ...skin.card, gap: S.cardGap },
                },
                h(
                  'div',
                  { style: { ...skin.row, justifyContent: 'space-between' } },
                  h(
                    'strong',
                    { style: { fontSize: S.subheadFontSize } },
                    String(entry?.name ?? entry?.id ?? '未命名项目'),
                  ),
                  h(
                    Btn,
                    {
                      className: 'pxm-restore-btn',
                      onClick: () => onRestore(String(entry?.id ?? '')),
                      disabled: busy !== null || !isString(entry?.id),
                    },
                    busy === entry?.id ? '恢复中…' : '恢复',
                  ),
                ),
                h(
                  'span',
                  { style: { fontSize: '12px', opacity: 0.72 } },
                  String(entry?.imageCount ?? 0) +
                    ' 张 · ' +
                    String(entry?.provider ?? '—') +
                    ' · 删除于 ' +
                    formatDateTime(entry?.deletedAt),
                ),
              ),
            )
          : null,
      )
    }

    /**
     * 「还有更多吗」。
     *
     * 以宿主的 `hasMore` 为准；老宿主只回了 `total`（或者根本没回）时**按 total 推算**，
     * 免得界面上出现"显示 24 / 共 55 却没有加载更多"这种自相矛盾的状态。
     */
    function hasMoreOf(data, offset, pageLength) {
      if (data.hasMore === true) return true
      if (data.hasMore === false) return false
      return isNumber(data.total) ? offset + pageLength < data.total : false
    }

    /**
     * 从某个元素往上找第一个"真的能滚"的祖先（查看器关闭时要把滚动位置放回去）。
     *
     * 覆盖层是 `position: fixed`，不锁 body 滚动，所以这里只是把打开前的
     * 滚动偏移记下来、关闭时复原；找不到滚动祖先就只复原 window 的滚动。
     */
    function scrollParentOf(element) {
      let node = isObject(element) ? element.parentElement : null
      while (node !== null && node !== undefined) {
        if (node.scrollHeight > node.clientHeight && node.clientHeight > 0) return node
        node = node.parentElement
      }
      return null
    }

    /**
     * 作品库面板的骨架：**固定层 + 唯一滚动层（+ 面板内的模态层）**。
     *
     * 为什么必须自己滚：面板坐在 shell 的 `main` 插槽座位里，而那个座位的容器
     * （`ui-layout` AppFrame 的 `.centerCol`）是 `display:flex; flex-direction:column;
     * overflow:hidden` 且高度等于窗口——它**不滚**。面板内容一旦超长，超出部分被裁掉，
     * 滚轮找不到任何可滚动的祖先，表现就是"详情页滚不动"。
     *
     * `bars` / `content` / `overlays` 都是子节点列表，用展开传参（而不是把数组当
     * 子节点）以避免 React 对"数组子节点缺 key"的警告。
     * 查看器是 `position: fixed` 的模态层，放在滚动区**外面**，不跟着内容滚。
     *
     * `scrollRef` 是给**滚动层自己**的 ref：查看器打开时要拿它去锁背景滚动
     * （`lockBackgroundScroll`）。不靠 `scrollParentOf` 现找——jsdom 里量不到
     * `scrollHeight`，而且"面板的滚动层"本来就是确定的那个元素。
     */
    function workbenchFrame(bars, content, overlays, scrollRef) {
      return h(
        'div',
        {
          className: 'pxm-workbench',
          style: skin.panel,
          // `main` 插槽的**槽位标记**：浏览器 lane 靠它把"面板"这个盒子认出来，
          // 而不是靠猜类名（见 `test/browser/layout.test.mjs` 8 号用例）。
          'data-pxm-slot': 'main',
        },
        h('div', { className: 'pxm-workbench-bar', style: skin.bar }, ...bars),
        h(
          'div',
          { ref: isObject(scrollRef) ? scrollRef : null, className: 'pxm-scroll pxm-workbench-scroll', style: skin.scroll },
          ...content,
        ),
        ...(isArray(overlays) ? overlays : []),
      )
    }

    /**
     * 背景滚动锁：把"背后真的能滚的那个容器"的 `overflow-y` 换成 `hidden`。
     *
     * 记的是**每个元素的原内联值**（而不是一个"锁过了"的布尔量）：关闭时要**精确还原**
     * ——原来是 `auto` 就回到 `auto`，原来没有内联值（`''`）就回到没有，绝不写死一个值。
     *
     * 只写 `overflow-y` 长属性，不写 `overflow` 简属性：简属性会连 `overflow-x` 一起改，
     * 而滚动层的 `overflow-x: hidden` 是它自己的契约（测试有断言），不该被这把锁碰。
     *
     * `scrollbar-gutter: stable` 与 `overflow-y` 同一批写入，但**只在量到真的有经典滚动条时**
     * （`offsetWidth - clientWidth > 0`）：不这么做，锁上的那一瞬间滚动条消失，背后内容会
     * 横移一条滚动条的宽度——那本身也是一种"背景动了"；反过来，本来就没有滚动条的容器
     * 去占位，一样会横移那么宽。这个探测同时把 overlay 滚动条（macOS 默认，不占宽度）
     * 排除在外：量到 0 就不占位，正好。
     *
     * 返回的 `locks` 必须交给 `restoreBackgroundScroll`，**包括组件卸载那条路径**。
     */
    function lockBackgroundScroll(targets) {
      const list = isArray(targets) ? targets : [targets]
      const seen = new Set()
      const locks = []
      list.forEach((element) => {
        if (!isObject(element) || !isObject(element.style) || seen.has(element)) return
        seen.add(element)
        const scrollbarWidth = Number(element.offsetWidth) - Number(element.clientWidth)
        const lock = {
          element,
          overflowY: element.style.overflowY,
          scrollbarGutter: element.style.scrollbarGutter,
        }
        locks.push(lock)
        try {
          if (scrollbarWidth > 0) element.style.scrollbarGutter = 'stable'
          element.style.overflowY = 'hidden'
        } catch {
          /* 写不进去（只读样式表之类）就当没锁住：还原时同样不会乱写 */
        }
      })
      return locks
    }

    /** 精确还原 `lockBackgroundScroll` 改过的内联值（卸载与关闭共用这一条路径）。 */
    function restoreBackgroundScroll(locks) {
      ;(isArray(locks) ? locks : []).forEach((lock) => {
        const element = isObject(lock) ? lock.element : null
        if (!isObject(element) || !isObject(element.style)) return
        try {
          element.style.overflowY = isString(lock.overflowY) ? lock.overflowY : ''
          element.style.scrollbarGutter = isString(lock.scrollbarGutter) ? lock.scrollbarGutter : ''
        } catch {
          /* 还原失败不该让"关闭查看器"这个动作失败 */
        }
      })
    }

    function WorkbenchPanel() {
      const selected = useStore(selectedProject)
      /**
       * 列表状态。批次 C 起带分页：`projects` 是**已加载**的累计列表，
       * `total` 是宿主报的过滤后总数，`hasMore` 决定「加载更多」出不出现。
       */
      const [list, setList] = React.useState({
        phase: 'loading',
        projects: [],
        total: 0,
        hasMore: false,
        error: null,
      })
      /** 搜索框里的原始输入（每敲一个字都变）与防抖后的实际查询词。 */
      const [query, setQuery] = React.useState('')
      const [debounced, setDebounced] = React.useState('')
      const [sort, setSort] = React.useState(DEFAULT_PROJECT_SORT)
      /** 多选：数组（而非 Set）以便稳定顺序与直接渲染计数。 */
      const [selectedIds, setSelectedIds] = React.useState([])
      const [batch, setBatch] = React.useState({ busy: null, error: null, note: null })
      const [confirmingBatch, setConfirmingBatch] = React.useState(false)
      const [detail, setDetail] = React.useState({ phase: 'idle', data: null, error: null })
      /** 详情重取令牌：重命名成功后要强制刷新详情（`selected` 没变，effect 不会自己跑）。 */
      const [detailToken, setDetailToken] = React.useState(0)
      const [trash, setTrash] = React.useState({ phase: 'idle', data: null, error: null })
      const [showTrash, setShowTrash] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      /** 配置里的作品库导出路径；空串 = 未配置（导出时宿主会回 400 并给出指引）。 */
      const [exportDir, setExportDir] = React.useState('')
      /** 查看器：`null` = 关着；`{index, compare}` = 开着第 index 张（0 基）。 */
      const [viewer, setViewer] = React.useState(null)

      const alive = useAlive()
      const listRef = React.useRef(list)
      React.useEffect(() => {
        listRef.current = list
      }, [list])
      /** 请求序号：搜索/排序连打时，只有最新那次的结果允许落地（旧响应直接丢）。 */
      const requestSeq = React.useRef(0)
      /** 打开查看器前的现场（滚动位置 + 焦点元素），关闭时复原。 */
      const viewerReturn = React.useRef(null)
      /** 面板的滚动层（`workbenchFrame` 挂上来的）；查看器打开时要锁住它。 */
      const scrollRef = React.useRef(null)

      const loadTrash = React.useCallback(
        () =>
          apiGet('api/trash', isTrashList).then((result) => {
            if (!alive.current) return
            if (result.ok) setTrash({ phase: 'ready', data: result.data, error: null })
            else setTrash({ phase: 'error', data: null, error: result.error })
          }),
        [alive],
      )

      /**
       * 取一页项目。
       *
       * `append` 为真时**追加**（「加载更多」），否则**替换**（搜索/排序/刷新/删除后）。
       * URL 里始终带 `sort`，搜索词非空时带 `q`；`offset` 取已加载条数
       * ——不用另一份计数器，避免"显示的条数"和"请求的偏移"两处各说各话。
       */
      const loadProjects = React.useCallback(
        (append) => {
          const offset = append ? listRef.current.projects.length : 0
          const seq = requestSeq.current + 1
          requestSeq.current = seq
          setList((prev) =>
            append
              ? { ...prev, phase: 'loading-more', error: null }
              : { phase: 'loading', projects: [], total: 0, hasMore: false, error: null },
          )
          const url =
            'api/projects?limit=' +
            String(PROJECT_PAGE_SIZE) +
            '&offset=' +
            String(offset) +
            '&sort=' +
            encodeURIComponent(sort) +
            (debounced === '' ? '' : '&q=' + encodeURIComponent(debounced))
          return apiGet(url, isProjectList).then((result) => {
            if (!alive.current || seq !== requestSeq.current) return
            if (!result.ok) {
              // 失败时**保留**已加载的项目：一次"加载更多"失败不该把整页清空。
              setList((prev) => ({ ...prev, phase: 'error', error: result.error }))
              return
            }
            const data = isObject(result.data) ? result.data : {}
            const page = isArray(data.projects) ? data.projects.filter(isObject) : []
            setList((prev) => ({
              phase: 'ready',
              projects: append ? [...prev.projects, ...page] : page,
              // 宿主没报 total 时的退化口径：就当这一页就是全部（不谎报更多）。
              total: isNumber(data.total) ? data.total : page.length,
              hasMore: hasMoreOf(data, offset, page.length),
              error: null,
            }))
          })
        },
        [alive, debounced, sort],
      )

      /**
       * 搜索防抖：输入即过滤，但**不是每敲一个字就发一次请求**。
       * 清空按钮走同一条路（等 250ms），免得"清空"和"打字"两套时序互相打架。
       */
      React.useEffect(() => {
        if (query === debounced) return undefined
        const timer = setTimeout(() => setDebounced(query), SEARCH_DEBOUNCE_MS)
        return () => clearTimeout(timer)
      }, [query, debounced])

      /**
       * 搜索词或排序变化 → **回到第一页**并清空多选。
       *
       * 为什么必须清多选：选中集是"当时看到的那一批"。换了筛选条件还留着上一批的选中项，
       * 「已选 3」里可能有两个已经不在屏幕上了——用户接下来点的「删除选中」会删掉他
       * 根本看不见的东西，这是最危险的一类界面状态。
       */
      React.useEffect(() => {
        setSelectedIds([])
        setConfirmingBatch(false)
        setViewer(null)
        loadProjects(false)
      }, [loadProjects])

      /**
       * 详情里要显示"导出会落到哪"，因此顺手把配置里的「作品库导出路径」取回来。
       *
       * 取不到不是错误：导出请求照样会发出去，由宿主给出**可读的** 400 提示
       * （`no_export_dir`），界面再把它翻成"先去设置里配"。界面**不猜**任何默认路径。
       */
      React.useEffect(() => {
        let live = true
        apiGet('api/providers', isProviders).then((result) => {
          if (!live || !result.ok) return
          setExportDir(isString(result.data.exportDir) ? result.data.exportDir : '')
        })
        return () => {
          live = false
        }
      }, [])

      React.useEffect(() => {
        if (selected === null) {
          setDetail({ phase: 'idle', data: null, error: null })
          return undefined
        }
        let live = true
        setDetail({ phase: 'loading', data: null, error: null })
        apiGet('api/projects/' + encodeURIComponent(selected), isProjectDetail).then((result) => {
          if (!live) return
          if (result.ok) setDetail({ phase: 'ready', data: result.data.project, error: null })
          else setDetail({ phase: 'error', data: null, error: result.error })
        })
        return () => {
          live = false
        }
      }, [selected, detailToken])

      // ── 查看器 ────────────────────────────────────────────────────────────

      /** 摊平项目内的图片；`detail` 一变就重算。 */
      const viewerEntries = React.useMemo(
        () => buildViewerEntries(isObject(detail.data) && isArray(detail.data.items) ? detail.data.items : []),
        [detail],
      )

      const openViewer = (index, element) => {
        const doc = typeof document === 'undefined' ? null : document
        const container = scrollParentOf(element)
        viewerReturn.current = {
          element: element ?? null,
          focus: doc === null ? null : doc.activeElement,
          scrollX: typeof window === 'undefined' ? 0 : window.scrollX,
          scrollY: typeof window === 'undefined' ? 0 : window.scrollY,
          container: container === null ? null : container,
          top: container === null ? 0 : container.scrollTop,
        }
        setViewer({ index, compare: false })
      }

      /**
       * 关闭查看器：撤掉覆盖层，再把滚动位置与焦点**放回原处**。
       * 复原用 try/catch 包住——某些环境里 `window.scrollTo` 会抛，
       * 那不该让"关闭"这个动作本身失败。
       */
      const closeViewer = () => {
        setViewer(null)
        const saved = viewerReturn.current
        viewerReturn.current = null
        if (saved === null) return
        try {
          if (saved.container !== null) saved.container.scrollTop = saved.top
          // 只在真的动过的时候才调：jsdom 里 `scrollTo` 是"未实现"的（会刷一条噪声），
          // 而真实浏览器里 0 位移也本来就没什么可复原的。
          if (
            typeof window !== 'undefined' &&
            typeof window.scrollTo === 'function' &&
            (saved.scrollX !== window.scrollX || saved.scrollY !== window.scrollY)
          ) {
            window.scrollTo(saved.scrollX, saved.scrollY)
          }
          const target = saved.element ?? saved.focus
          if (target !== null && target !== undefined && typeof target.focus === 'function') {
            target.focus()
          }
        } catch {
          /* 恢复现场失败不影响"已经关掉"这个事实 */
        }
      }

      /** 在一个项目内的图片之间循环切换（越界回绕，看最后一张时按 → 回到第一张）。 */
      const stepViewer = (delta) => {
        const count = viewerEntries.length
        if (count === 0) return
        setViewer((prev) => {
          if (prev === null) return prev
          const next = (prev.index + delta + count) % count
          return { ...prev, index: next }
        })
      }

      /**
       * 查看器开着的时候锁住背景滚动，关掉或**卸载**时精确还原。
       *
       * 依赖只看"开着没开着"（`viewer !== null` 这个布尔量）：切上一张/下一张、开关
       * 「并排对比」都只是 `viewer` 对象换了个字段，不会重新锁一遍（也无从漏还原）。
       *
       * 用 `useLayoutEffect` 而不是 `useEffect`：锁要在**这一帧画出来之前**生效，否则
       * 会出现"查看器已经打开、背景还能滚"的一帧（滚动条也跟着闪一下）。
       *
       * 卸载路径由这个 effect 的 cleanup 兜住：面板被换掉（切视图 / 插件卸载）时，
       * 那把锁必须跟着消失，不能留在 DOM 上——`scrollRef` 指向的滚动层若是被别人复用，
       * 残留的 `overflow: hidden` 就成了"再也滚不动"的新 bug。
       */
      const viewerOpen = viewer !== null
      React.useLayoutEffect(() => {
        if (!viewerOpen) return undefined
        const doc = typeof document === 'undefined' ? null : document
        const targets = [scrollRef.current]
        if (isObject(viewerReturn.current) && viewerReturn.current.container !== null) {
          targets.push(viewerReturn.current.container)
        }
        // 文档本身真的能滚时才锁它（普通浏览器里窗口很矮就可能）：不成立时连写都不写，
        // 免得把 `html` 的内联样式改脏、还原时又和别人抢同一个属性。
        const scrolling = doc === null ? null : doc.scrollingElement
        if (isObject(scrolling) && scrolling.scrollHeight > scrolling.clientHeight) {
          targets.push(scrolling)
        }
        const locks = lockBackgroundScroll(targets)
        return () => {
          restoreBackgroundScroll(locks)
        }
      }, [viewerOpen])

      // ── 多选批量操作 ──────────────────────────────────────────────────────

      const toggleSelect = (id) => {
        if (id === '') return
        setSelectedIds((prev) =>
          prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
        )
      }

      /**
       * 批量删除：逐个走**软删**路由（`POST /projects/<id>/delete` + `confirm: true`）。
       * 一项失败不影响其余项，失败的 id 与原因在面板里逐条显示。
       */
      const runBatchDelete = () => {
        const ids = selectedIds.slice()
        if (ids.length === 0 || batch.busy !== null) return
        setBatch({ busy: 'delete', error: null, note: null })
        const run = async () => {
          const failures = []
          for (const id of ids) {
            const result = await apiPost('api/projects/' + encodeURIComponent(id) + '/delete', {
              confirm: true,
            })
            if (result.ok !== true) failures.push(id + '：' + String(result.error ?? '删除失败'))
          }
          if (!alive.current) return
          setConfirmingBatch(false)
          setSelectedIds([])
          if (failures.length > 0) {
            setBatch({
              busy: null,
              error: '有 ' + String(failures.length) + ' 个项目没能移入回收站：' + failures.join('；'),
              note: null,
            })
          } else {
            setBatch({
              busy: null,
              error: null,
              note: '已把 ' + String(ids.length) + ' 个项目移入回收站，可在「回收站」里恢复。',
            })
          }
          loadProjects(false)
        }
        run()
      }

      /**
       * 批量导出：落点用配置里的「作品库导出路径」。
       *
       * 没配置时**不发那一串注定失败的请求**，直接把"先去设置里填"显示出来
       * ——这正是"不静默失败"的要求（发 N 个 400 再把同样的文案显示 N 次
       * 只是把同一件事说得更吵）。
       */
      const runBatchExport = () => {
        const ids = selectedIds.slice()
        if (ids.length === 0 || batch.busy !== null) return
        const guard = checkExportDir(exportDir)
        if (guard.ok !== true) {
          setBatch({ busy: null, error: guard.error, note: null })
          return
        }
        setBatch({ busy: 'export', error: null, note: null })
        const run = async () => {
          const failures = []
          let files = 0
          for (const id of ids) {
            const result = await apiPost('api/projects/' + encodeURIComponent(id) + '/export', {
              dir: guard.dir,
            })
            if (result.ok !== true) {
              failures.push(id + '：' + explainProjectActionError(result.code, result.error))
              continue
            }
            const data = isObject(result.data) ? result.data : {}
            files += isNumber(data.count) ? data.count : 0
          }
          if (!alive.current) return
          if (failures.length > 0) {
            setBatch({
              busy: null,
              error: '有 ' + String(failures.length) + ' 个项目没导出成功：' + failures.join('；'),
              note: null,
            })
          } else {
            setBatch({
              busy: null,
              error: null,
              note:
                '已导出 ' +
                String(ids.length) +
                ' 个项目（' +
                String(files) +
                ' 个文件）到 ' +
                exportDir,
            })
          }
        }
        run()
      }

      const header = h(
        'div',
        { style: { ...skin.row, justifyContent: 'space-between' } },
        h('h2', { style: skin.title }, showTrash ? '回收站' : '作品库'),
        h(
          'div',
          { style: skin.row },
          h(
            Btn,
            {
              className: 'pxm-trash-toggle',
              onClick: () => {
                setNotice(null)
                if (showTrash) {
                  setShowTrash(false)
                  loadProjects(false)
                } else {
                  selectedProject.set(null)
                  setViewer(null)
                  setShowTrash(true)
                  setTrash({ phase: 'loading', data: null, error: null })
                  loadTrash()
                }
              },
            },
            showTrash ? '返回作品库' : '回收站',
          ),
          h(
            Btn,
            {
              onClick: () => {
                setNotice(null)
                if (showTrash) loadTrash()
                else loadProjects(false)
              },
            },
            '刷新',
          ),
        ),
      )

      if (showTrash) {
        return workbenchFrame(
          [header],
          [
            h(TrashPanel, {
              state: trash,
              onBack: () => {
                setShowTrash(false)
                loadProjects(false)
              },
              onReload: loadTrash,
              onChanged: () => {
                loadTrash()
                loadProjects(false)
              },
            }),
          ],
          scrollRef,
        )
      }

      if (selected !== null) {
        return workbenchFrame(
          [header],
          [
            h(ProjectDetail, {
              state: detail,
              exportDir,
              onBack: () => {
                setViewer(null)
                selectedProject.set(null)
              },
              onOpenImage: openViewer,
              onRenamed: () => {
                // 显示名变了：详情要重取，列表也要重取（搜索按名字匹配，改名会影响命中）。
                setDetailToken((token) => token + 1)
                loadProjects(false)
              },
              onDeleted: (id) => {
                setViewer(null)
                selectedProject.set(null)
                setNotice('已把「' + id + '」移入回收站，可在「回收站」里恢复。')
                loadProjects(false)
              },
            }),
          ],
          [
            viewer === null
              ? null
              : h(ImageViewer, {
                  entries: viewerEntries,
                  index: viewer.index,
                  compare: viewer.compare === true,
                  projectId: isObject(detail.data) && isString(detail.data.id) ? detail.data.id : '',
                  onClose: closeViewer,
                  onStep: stepViewer,
                  onToggleCompare: (next) =>
                    setViewer((prev) => (prev === null ? prev : { ...prev, compare: next })),
                }),
          ],
          scrollRef,
        )
      }

      const projects = list.projects
      const selectedSet = new Set(selectedIds)
      const selectedCount = projects.filter((project) => selectedSet.has(String(project.id))).length
      const shown = projects.length
      const total = isNumber(list.total) ? list.total : shown

      /**
       * 固定不滚的一层：表头 + 提示条 + 搜索 / 排序 + 计数 + 批量工具条。
       * 项目一多，滚的是下面的卡片网格，不是这一层。
       */
      const bars = [
        header,
        notice === null ? null : h(Notice, { role: 'status', title: '已删除', detail: notice }),
        /*
         * ⚠ **刻意回归（2026-10-10，按用户要求）**：原来这一层有一行
         * `显示 <shown> / 共 <total>`（`.pxm-count`），它是**唯一**把
         * "宿主那边还有多少条被 limit 静默截掉"摆在界面上的地方。用户要求
         * 删掉"左边部分"、把工具条压成一行，这一项随之被移除。
         *
         * 后果如实记在这里，不粉饰：**`hasMore` 现在只剩「加载更多」按钮体现**
         * （它在下面的滚动区里，文案是「加载更多（还有 N 个）」——N 是
         * `total - shown`）。也就是说：
         *   - "还有更多"仍然看得见（按钮在 = 还有；按钮没了 = 取完了）；
         *   - 但"已加载 N 条 / 共 M 条"这个**绝对计数**在界面上不再存在，
         *     用户无法一眼看出当前只加载了 24 / 共 150。
         * 这是**可见信息量的净减少**，不是等价替换。恢复办法见
         * `docs/contract-notes.md` §22.2 的同一处记录（把那行加回 `bars` 即可）。
         * `test/workbench-dom.test.mjs` 里原来按这段文字做的三条断言已逐条
         * 改锚到"已渲染卡片数"与「加载更多」按钮上（见该文件批次 C 的注释）。
         */
        // ── 单行工具条：左「排序 / 全选 / 取消全选」+ 右「搜索」（2026-10-10） ──
        //
        // **用户明确要求**（截图对照）：删掉原来的三行「左标签+说明 / 右控件」形态
        // ——「搜索（项目名 / 模块名）」「输入即筛，300ms 防抖」「排序」
        // 「只影响列表顺序，不改任何文件」这些标签与说明**全部移除**，
        // 「显示 N / 共 M」这一项也一并移除（见下面「刻意回归」那条注释）。
        // 现在是**一行**：左边三枚控件、右边搜索框。
        //
        // 左侧标签删掉后，"这个搜索框搜什么"就只能由 placeholder 交代 —— 见下面
        // `SearchInput` 的 `placeholder`（`搜索项目名 / 模块名`，与排序下拉的选项名同一套词）。
        //
        // 窄屏：沿用 `skin.row` 的 `flexWrap:'wrap'`，一行放不下时**搜索框折到第二行**，
        // 绝不横向溢出（375px 由 `layout.test.mjs` 的 9 号用例按 scrollWidth 断言）。
        h(
          'div',
          {
            // `data-pxm-toolbar` = 这一行的**语义锚点**：浏览器 lane 靠它定位"工具条行"，
            // 而不是靠类名（类名是实现细节，换个名字不该让断言失效）——与 `Field` 的
            // `data-pxm-field` 同一做法。
            'data-pxm-toolbar': '1',
            // `skin.row` 自带 `{display:flex;alignItems:center;gap:8px;flexWrap:wrap}`。
            // `.pxm-list-bar` 这个类名保留（它一直是"这一层工具条"的锚点，见
            // `test/workbench-dom.test.mjs` 的固定层用例）。
            className: 'pxm-list-bar',
            style: { ...skin.row },
          },
          // ① 排序。**按内容宽度、不伸不屈、但可压缩**。
          //
          // 两个坑，都实测过：
          //   - `flex:'0 1 auto'` 的 `flex-grow` 默认是 1，`<select>` 会一口吃满整行、
          //     把「全选 / 取消全选 / 搜索」全挤到第二行去；
          //   - `flexBasis:'auto'` + `flexGrow:0` 也不行：`auto` 取的是元素的 `width`
          //     属性，而块级 `<select>` 的 `width:auto` 在 flex 项目里解析成
          //     **填满可用宽度**（`fill-available`），于是它照样占满 1024px。
          //     必须显式写 `flexBasis:'content'`（= `max-content`）它才回到固有宽度。
          // `minWidth:0` 是留给窄屏的退路：`<select>` 的固有宽度由最长选项撑开、
          // `min-width:auto` 时在 flex 行里**不肯让位**，375px 下会把整行顶出横向滚动。
          h(Select, {
            className: 'pxm-sort',
            role: 'sort',
            value: sort,
            options: PROJECT_SORT_OPTIONS,
            onChange: (event) => setSort(event.target.value),
            style: { minWidth: 0, flexGrow: 0, flexShrink: 1, flexBasis: 'content' },
          }),
          // ② 全选（限定当前筛选结果）；③ 取消全选。文案保持不变：写明「当前 N 个」，
          //    否则用户会以为选的是**全部**（宿主那边被 limit 截掉的看不到）。
          projects.length === 0
            ? null
            : h(
                'div',
                { className: 'pxm-select-range', style: skin.row },
                h(
                  Btn,
                  {
                    className: 'pxm-select-all',
                    role: 'select-all',
                    onClick: () => setSelectedIds(projects.map((project) => String(project.id))),
                    disabled: batch.busy !== null,
                    title: '只作用于当前筛选结果里已加载的项目',
                  },
                  // 这里必须用 `total` 之外的口径：**已加载**的项目数。
                  '全选（当前 ' + String(shown) + ' 个）',
                ),
                h(
                  Btn,
                  {
                    className: 'pxm-select-none',
                    role: 'select-none',
                    onClick: () => {
                      setSelectedIds([])
                      setConfirmingBatch(false)
                    },
                    disabled: batch.busy !== null || selectedCount === 0,
                  },
                  '取消全选',
                ),
              ),
          /*
           * ④ 搜索框，**右对齐**：`marginLeft:'auto'` 吃掉左侧控件之后的全部剩余空间，
           *    于是它永远贴在这一行的右端（换行到第二行时则是那一行的右端）。
           *
           * `flex:'0 1 220px'`：桌面视口取 220px 基准宽（够放得下 placeholder），
           * 空间不够时**先缩再折行**——`minWidth:0` 是 `SearchInput` 自己给的，
           * 所以缩到再小也只是 input 内部滚动，不会把父级撑宽。
           */
          h(
            'div',
            {
              className: 'pxm-search-wrap',
              style: {
                display: 'flex',
                gap: '6px',
                alignItems: 'center',
                marginLeft: 'auto',
                flex: '0 1 220px',
                minWidth: 0,
              },
            },
            h(SearchInput, {
              className: 'pxm-search',
              value: query,
              // 原来靠左侧标签解释"搜什么"，标签删了 → **必须由 placeholder 交代**。
              // 措辞与排序下拉的选项名（项目名 / 创建时间 / 图片张数）同一套词。
              placeholder: '搜索项目名 / 模块名',
              onChange: (event) => setQuery(event.target.value),
            }),
            query === ''
              ? null
              : h(
                  Btn,
                  {
                    className: 'pxm-search-clear',
                    onClick: () => {
                      setQuery('')
                      setDebounced('')
                    },
                    title: '清空搜索',
                  },
                  '清空',
                ),
          ),
        ),
        // ── 选中后才出现的工具条 ─────────────────────────────────────────────
        selectedCount === 0
          ? null
          : h(
              'div',
              { className: 'pxm-select-toolbar', style: skin.row },
              h('span', { className: 'pxm-selected-count', style: { fontSize: '12px' } }, '已选 ' + String(selectedCount)),
              h(
                'span',
                { className: 'pxm-batch-actions', style: skin.row },
                h(
                  Btn,
                  {
                    className: 'pxm-batch-export',
                    onClick: runBatchExport,
                    disabled: batch.busy !== null,
                    title:
                      exportDir === ''
                        ? '尚未配置「作品库导出路径」，请先到设置里填'
                        : '复制到 ' + exportDir + '/<项目 id>/，原件不动',
                  },
                  batch.busy === 'export' ? '导出中…' : '导出选中',
                ),
                h(
                  Btn,
                  {
                    className: 'pxm-batch-delete',
                    onClick: () => setConfirmingBatch(true),
                    disabled: batch.busy !== null || confirmingBatch,
                    title: '移入回收站，可恢复',
                  },
                  '删除选中',
                ),
              ),
            ),
        confirmingBatch
          ? h(
              Notice,
              {
                role: 'alert',
                title: '确认删除选中的 ' + String(selectedCount) + ' 个项目？',
                detail:
                  '这些项目会**移入回收站**（projects/.trash），之后仍可恢复；' +
                  '清空回收站才会真正从磁盘删除。',
              },
              h(
                'div',
                { style: skin.row },
                h(
                  Btn,
                  {
                    className: 'pxm-confirm-batch-delete',
                    onClick: runBatchDelete,
                    disabled: batch.busy !== null,
                  },
                  batch.busy === 'delete' ? '删除中…' : '确认删除选中',
                ),
                h(Btn, { onClick: () => setConfirmingBatch(false), disabled: batch.busy !== null }, '取消'),
              ),
            )
          : null,
        batch.error !== null && batch.error !== undefined
          ? h(Notice, { role: 'alert', title: '批量操作失败', detail: batch.error })
          : null,
        batch.note !== null && batch.note !== undefined
          ? h(Notice, { role: 'status', title: '已完成', detail: batch.note })
          : null,
      ]

      /** 唯一滚动区：项目卡片网格 + 加载更多 + 加载 / 失败 / 空状态。 */
      const content = [
        list.phase === 'loading' ? h(LoadingRow, { text: '正在读取项目列表…' }) : null,
        list.phase === 'error'
          ? h(
              Notice,
              { role: 'alert', title: '读取作品库失败', detail: list.error },
              h(Btn, { onClick: () => loadProjects(false) }, '重试'),
            )
          : null,
        list.phase === 'ready' && shown === 0
          ? h(Notice, {
              title: query === '' ? '还没有作品' : '没有匹配的项目',
              detail:
                query === ''
                  ? '用 pixmart_generate / pixmart_batch 生成后会出现在这里。'
                  : '换个关键词试试；搜索匹配项目名与模块名（不区分大小写）。',
            })
          : null,
        projects.length > 0
          ? h(
              'div',
              {
                style: {
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                  gap: '12px',
                },
              },
              projects.map((project) =>
                h(ProjectCard, {
                  key: String(project.id),
                  project,
                  selected: selectedSet.has(String(project.id)),
                  onToggleSelect: toggleSelect,
                  onOpen: (id) => {
                    setNotice(null)
                    setBatch({ busy: null, error: null, note: null })
                    selectedProject.set(id)
                  },
                }),
              ),
            )
          : null,
        list.hasMore === true
          ? h(
              'div',
              { style: { display: 'flex', justifyContent: 'center' } },
              h(
                Btn,
                {
                  className: 'pxm-load-more',
                  onClick: () => loadProjects(true),
                  disabled: list.phase === 'loading-more',
                },
                list.phase === 'loading-more'
                  ? '加载中…'
                  : '加载更多（还有 ' + String(Math.max(0, total - shown)) + ' 个）',
              ),
            )
          : null,
      ]

      return workbenchFrame(bars, content, null, scrollRef)
    }

    // ── ③ shell.overlay 实时预览卡（§8.5） ──────────────────────────────────

    function ProgressRing(props) {
      const total = props.total > 0 ? props.total : 1
      const done = Math.max(0, Math.min(total, props.completed))
      const failed = Math.max(0, Math.min(total - done, props.failed))
      const doneDeg = (done / total) * 360
      const failDeg = (failed / total) * 360
      const background =
        failed > 0
          ? 'conic-gradient(' +
            COLORS.ok + ' 0deg ' + doneDeg + 'deg, ' +
            COLORS.fail + ' ' + doneDeg + 'deg ' + (doneDeg + failDeg) + 'deg, ' +
            COLORS.track + ' ' + (doneDeg + failDeg) + 'deg 360deg)'
          : 'conic-gradient(' +
            COLORS.ok + ' 0deg ' + doneDeg + 'deg, ' +
            COLORS.track + ' ' + doneDeg + 'deg 360deg)'
      return h(
        'span',
        {
          'aria-hidden': 'true',
          className: 'pxm-ring',
          style: {
            position: 'relative',
            width: '36px',
            height: '36px',
            borderRadius: '50%',
            display: 'inline-flex',
            flex: '0 0 auto',
            background,
          },
        },
        h(
          'span',
          {
            style: {
              position: 'absolute',
              inset: '3px',
              borderRadius: '50%',
              background: T.bgOverlay,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '10px',
              fontWeight: 700,
            },
          },
          String(done) + '/' + String(total),
        ),
      )
    }

    function ItemChip(props) {
      const run = props.run
      const item = props.item
      const status = isString(item.status) ? item.status : 'queued'
      const label = String(item.label ?? item.module ?? '模块')
      const url = status === 'done' ? fileUrl(run.projectId, item.file) : null
      const borderColor =
        status === 'done' ? COLORS.ok : status === 'failed' ? COLORS.fail : status === 'running' ? COLORS.run : COLORS.track
      const title =
        label +
        ' · ' +
        String(ITEM_STATUS_LABEL[status] ?? status) +
        (isNumber(item.width) && isNumber(item.height) ? ' · ' + item.width + '×' + item.height : '') +
        (status === 'failed' && isObject(item.error) && isString(item.error.message)
          ? ' · ' + item.error.message
          : '')

      const runningDeg = status === 'running' ? 120 : 0

      return h(
        'div',
        {
          title,
          className: 'pxm-chip' + (status === 'running' ? ' pxm-chip-running' : ''),
          style: {
            position: 'relative',
            flex: '0 0 auto',
            width: '56px',
            height: '56px',
            borderRadius: '8px',
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            fontSize: '9px',
            lineHeight: 1.2,
            padding: '2px',
            border: '2px solid ' + borderColor,
            background: tint(T.label, 6),
            opacity: status === 'queued' || status === 'skipped' ? 0.5 : 1,
          },
        },
        url !== null
          ? h('img', {
              src: url,
              alt: label,
              loading: 'lazy',
              style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
            })
          : h(
              'span',
              {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '3px',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '100%',
                  height: '100%',
                },
              },
              status === 'running'
                ? h('span', {
                    className: 'pxm-ring',
                    style: {
                      position: 'relative',
                      width: '18px',
                      height: '18px',
                      borderRadius: '50%',
                      background:
                        // 「这一格正在跑」的进度环：官方 `StateDot` ongoing 的同一枚 token
                        // （轨道用它的 18% 半透明变体，而不是另一枚颜色）。
                        'conic-gradient(' + COLORS.run + ' 0deg ' +
                        String(runningDeg) +
                        'deg, ' + tint(COLORS.run, 18) + ' ' +
                        String(runningDeg) +
                        'deg 360deg)',
                    },
                  })
                : null,
              h(
                'span',
                { style: { maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                label.length > 10 ? label.slice(0, 10) + '…' : label,
              ),
              h('span', { style: { opacity: 0.62 } }, String(ITEM_STATUS_LABEL[status] ?? status)),
            ),
      )
    }

    function PreviewBadge(props) {
      const run = props.run
      const total = isNumber(run.total) ? run.total : 0
      const done = isNumber(run.completed) ? run.completed : 0
      const failed = isNumber(run.failed) ? run.failed : 0
      const active = isActive(run.status)
      const label =
        (active ? '生图进行中 ' : '生图' + String(RUN_STATUS_LABEL[run.status] ?? run.status) + ' ') +
        String(done) +
        '/' +
        String(total)

      return h(
        'button',
        {
          type: 'button',
          className: 'pxm-btn pxm-badge',
          onClick: props.onExpand,
          'aria-label': label + '，点击展开预览',
          title: label,
          style: {
            font: 'inherit',
            // 徽标 = 官方 `Pill` 的胶囊几何（24px / `0 8px` / 12px / 18px / 999px）：
            // 它是"点一下展开"的胶囊，与官方 Pill 同语义。来源见上面 `S` 的表头注释。
            boxSizing: 'border-box',
            fontSize: S.pillFontSize,
            lineHeight: S.pillLineHeight,
            height: S.pillHeight,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: S.pillPad,
            borderRadius: '999px',
            cursor: 'pointer',
            color: T.label,
            background: T.bgOverlay,
            border: '1px solid ' + T.borderL2,
            boxShadow: shadow(6, 20, 22),
          },
        },
        active ? h(Spinner, null) : h('span', { 'aria-hidden': 'true' }, failed > 0 ? '!' : '✓'),
        h('span', null, String(done) + '/' + String(total)),
        failed > 0 ? h(Pill, null, '失败 ' + String(failed)) : null,
      )
    }

    function PreviewCard(props) {
      const run = props.run
      const total = isNumber(run.total) ? run.total : 0
      const done = isNumber(run.completed) ? run.completed : 0
      const failed = isNumber(run.failed) ? run.failed : 0
      const items = isArray(run.items) ? run.items.filter(isObject) : []
      const active = isActive(run.status)
      const others = isArray(props.activeRuns)
        ? props.activeRuns.filter((other) => isObject(other) && other.runId !== run.runId)
        : []
      const [cancelling, setCancelling] = React.useState(false)

      const live =
        '生图进度 ' +
        String(done) +
        ' / ' +
        String(total) +
        (failed > 0 ? '，失败 ' + String(failed) : '') +
        (active ? '，当前 ' + String(run.currentLabel ?? '—') : '') +
        '，状态 ' +
        String(RUN_STATUS_LABEL[run.status] ?? run.status)

      const onCancel = () => {
        setCancelling(true)
        Promise.resolve(props.onCancel(run.runId)).then(
          () => setCancelling(false),
          () => setCancelling(false),
        )
      }

      return h(
        'div',
        {
          className: 'pxm-card',
          'aria-label': 'PixMart 生图预览',
          style: {
            width: 'min(320px, calc(100vw - 24px))',
            maxHeight: '40vh',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            borderRadius: '12px',
            border: '1px solid ' + T.borderL2,
            background: T.bgOverlay,
            boxShadow: shadow(10, 30, 28),
            fontSize: '12px',
          },
        },

        // 头部：计数 + 当前模块 + 取消 / 收起
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 10px',
              borderBottom: '1px solid ' + T.borderL1,
            },
          },
          h(ProgressRing, { completed: done, failed, total }),
          h(
            'div',
            { style: { flex: '1 1 auto', minWidth: 0 } },
            h(
              'div',
              {
                style: {
                  fontWeight: 600,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              String(run.projectName ?? 'PixMart 生图'),
            ),
            h(
              'div',
              {
                style: {
                  opacity: 0.7,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              String(RUN_STATUS_LABEL[run.status] ?? run.status) +
                ' · ' +
                String(done) +
                '/' +
                String(total) +
                (active && isString(run.currentLabel) ? ' · ' + run.currentLabel : ''),
            ),
          ),
          active
            ? h(
                Btn,
                { onClick: onCancel, disabled: cancelling, title: '取消这次运行（已产出的图保留）' },
                cancelling ? '取消中…' : '取消',
              )
            : h('span', { style: { opacity: 0.7, whiteSpace: 'nowrap' } }, isTerminal(run.status) ? '已结束' : ''),
          h(Btn, { onClick: props.onCollapse, title: '收起为徽标（Esc）' }, '收起'),
        ),

        // stale 徽标：刷新失败时保留最后一次成功快照
        props.stale === true
          ? h(
              'div',
              {
                role: 'status',
                style: {
                  padding: '4px 10px',
                  background: tint(T.warn, 18),
                  borderBottom: '1px solid ' + T.borderL1,
                },
              },
              '数据可能过期：最近一次刷新失败，显示最后一次成功快照。',
            )
          : null,

        // 多任务：同会话最多 1 张卡 + +N 计数，点击切换
        others.length > 0
          ? h(
              'div',
              { style: { padding: '6px 10px 0', display: 'flex', gap: '6px', flexWrap: 'wrap' } },
              h('span', { style: { opacity: 0.7 } }, '+' + String(others.length) + ' 进行中：'),
              others.map((other) =>
                h(
                  'button',
                  {
                    key: String(other.runId),
                    type: 'button',
                    className: 'pxm-btn',
                    onClick: () => props.onSelect(other),
                    title: String(other.projectName ?? other.runId),
                    style: {
                      font: 'inherit',
                      // 多任务小胶囊：几何照官方 `Tag.module.css` 的 `.tag`。
                      boxSizing: 'border-box',
                      fontSize: S.tagFontSize,
                      lineHeight: S.tagLineHeight,
                      padding: S.tagPad,
                      borderRadius: '999px',
                      color: T.label,
                      cursor: 'pointer',
                      border: '1px solid ' + T.borderL2,
                      background: tint(T.label, 8),
                    },
                  },
                  String(other.completed ?? 0) + '/' + String(other.total ?? 0),
                ),
              ),
            )
          : null,

        // 内容区：内部滚动，逐格点亮缩略图
        h(
          'div',
          {
            className: 'pxm-scroll',
            style: {
              display: 'flex',
              gap: '6px',
              padding: '8px 10px',
              overflow: 'auto',
              minHeight: 0,
              flex: '1 1 auto',
            },
          },
          items.length === 0
            ? h('span', { style: { opacity: 0.7 } }, '正在准备任务…')
            : items.map((item, index) => h(ItemChip, { key: String(item.index ?? index), run, item })),
        ),

        h(
          'div',
          {
            style: {
              padding: '6px 10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
              borderTop: '1px solid ' + T.borderL1,
            },
          },
          h(
            'span',
            {
              style: {
                opacity: 0.7,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            String(run.provider ?? '') + ' · ' + String(run.model ?? '') + ' · ' + String(run.size ?? ''),
          ),
          h(
            'span',
            { className: 'pxm-visually-hidden', 'aria-live': 'polite', 'aria-atomic': 'true' },
            live,
          ),
        ),
      )
    }

    /**
     * `shell.overlay` 贡献者。
     *
     * - 空闲（宿主里没有运行记录）时**不渲染任何 DOM**，且轮询停表。
     * - 有运行在跑：展开卡片，1s 轮询；结束收成徽标并保留（不自动消失、不撑大）。
     * - 首屏恢复不自动展开：由「运行开始时刻 vs 本页面加载基线」判定（§8.5.5），
     *   只有本页面加载之后新开始的运行才自动展开；用户的展开/收起手动覆盖优先。
     * - 点击穿透：外层容器 `pointer-events:none`，只有卡片/徽标自己 `auto`。
     */
    function PreviewOverlay() {
      const state = useStore(previewState)
      const run = state.run

      /**
       * 手动覆盖：`{ runId, expanded }`。
       * runId 不匹配当前运行即视为过期，回到自动策略。
       */
      const [override, setOverride] = React.useState(null)
      const [escaped, setEscaped] = React.useState(false)

      React.useEffect(() => {
        runPoller.start()
        const onVisible = () => {
          if (document.hidden !== true) runPoller.refresh()
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          document.removeEventListener('visibilitychange', onVisible)
          runPoller.stop()
        }
      }, [])

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') setEscaped(true)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [])

      if (run === null || run === undefined) return null

      // 自动策略（§8.5.5 / D12「运行中展开；结束后收成徽标并保留，用户可固定展开」）：
      //   - 本页面加载之后新开始 **且仍在跑** → 自动展开；
      //   - 首屏已存在的运行（恢复）→ 只显示徽标，避免首轮请求回来时大幅位移；
      //   - 结束（done / failed / cancelled / interrupted）→ 收回徽标，不留在展开态。
      // 手动覆盖（override）优先于自动策略，所以「用户手动展开 = 固定展开」。
      const startedAfterLoad =
        isNumber(state.firstSeenAt) && isNumber(baseline.mountedAt)
          ? state.firstSeenAt >= baseline.mountedAt
          : false
      const autoExpanded = startedAfterLoad && isActive(run.status) && !escaped
      const expanded =
        override !== null && override.runId === run.runId ? override.expanded : autoExpanded

      const setExpanded = (next) => {
        setEscaped(false)
        setOverride({ runId: run.runId, expanded: next })
      }

      return h(
        'div',
        {
          className: 'pxm-overlay',
          'data-plugin': PLUGIN,
          style: {
            position: 'fixed',
            right: '16px',
            bottom: '16px',
            zIndex: 60,
            pointerEvents: 'none',
            display: 'flex',
            justifyContent: 'flex-end',
          },
        },
        expanded
          ? h(PreviewCard, {
              run,
              stale: state.stale,
              activeRuns: state.activeRuns,
              onCollapse: () => setExpanded(false),
              onCancel: (runId) => runPoller.cancel(runId),
              onSelect: (other) => runPoller.selectRun(other),
            })
          : h(PreviewBadge, {
              run,
              onExpand: () => setExpanded(true),
            }),
      )
    }

    // ── 样式：自建 <style data-plugin="dsh-pixmart">，随 disposer 移除 ───────

    const CSS = [
      '.pxm-overlay>div,.pxm-overlay>button{pointer-events:auto;}',
      '.pxm-card{animation:pxm-in .16s ease-out;}',
      '@keyframes pxm-in{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}',
      '.pxm-spin{animation:pxm-turn 1s linear infinite;}',
      '@keyframes pxm-turn{to{transform:rotate(360deg);}}',
      '.pxm-chip-running{animation:pxm-pulse 1.4s ease-in-out infinite;}',
      '@keyframes pxm-pulse{0%,100%{opacity:1;}50%{opacity:.62;}}',
      '.pxm-scroll{scrollbar-width:thin;}',
      /* 查看器是本插件在作品库面板内的模态层（position:fixed），入场动画随 reduced-motion 关闭 */
      '.pxm-viewer{animation:pxm-in .16s ease-out;}',
      '.pxm-link-btn:focus-visible,.pxm-btn:focus-visible,.pxm-tile:focus-visible,.pxm-badge:focus-visible,.pxm-thumb:focus-visible{outline:2px solid ' +
        T.labelTertiary +
        ';outline-offset:2px;}',
      /*
       * 链接式按钮（LinkButton）的 hover：官方 `._3nPmjq_linkButton:hover:not(:disabled)`
       * 是 `{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}`
       * （`settings-models/lib/client.js:58`）。`interactive-bg-hover` 不在本插件清单里，
       * 所以与 `.pxm-select-option` 同一约定：hover 填充 = `label-tertiary` 派生的 12% 半透明，
       * 文字色仍走 `label-secondary`（这一枚在清单里）。颜色只来自 token。
       */
      '.pxm-link-btn:hover:not(:disabled){background:' +
        tint(T.labelTertiary, 12) +
        ';color:' +
        T.labelSecondary +
        ';}',
      /*
       * 自绘下拉（SelectField）与步进器（NumberStepper）的交互态。
       *
       * 这些是官方 CSS 规则里**必须靠伪类**才能表达的部分（内联样式写不了 `:hover` /
       * `:focus-visible`），所以走 `<style>`。取值逐条对应官方：
       *   - `.pxm-select-option:hover` / `:focus-visible` → 官方 `Menu.module.css:112-114`
       *     与 :119-122 的 `background:var(--dsw-alias-interactive-bg-hover)`，
       *     且 hover 与键盘焦点**同一填充**（官方注释：箭头导航走真焦点，填充就是焦点指示，
       *     再加浏览器默认环会双重提示）。该 token 不在本插件已用清单里，故用同一处**语义**
       *     的 `label-tertiary` 派生一层 8% 半透明填充——颜色仍然只来自 token。
       *   - `.pxm-select-option:focus-visible{outline:none}` → 同官方 :121 的 `outline:none`。
       *   - 触发器的可见焦点环与既有按钮同一套（`labelTertiary` + 2px + offset 2）。
       */
      '.pxm-select-option:hover:not(:disabled),.pxm-select-option:focus-visible:not(:disabled){background:' +
        tint(T.labelTertiary, 12) +
        ';}',
      '.pxm-select-option:focus-visible{outline:none;}',
      /*
       * 弹层里的搜索框（2026-10-12）：
       *   - 焦点环与页内其它控件同一套（`labelTertiary` + 2px + offset 1）；
       *   - 「清空」按钮只在有内容时出现（实现里按 `keyword !== ''` 条件渲染），
       *     它的 hover 填充与 `.pxm-select-option` 同一个 token 派生层。
       */
      '.pxm-select-search-input:focus-visible{outline:2px solid ' +
        T.labelTertiary +
        ';outline-offset:1px;}',
      '.pxm-select-search-clear:hover{background:' + tint(T.labelTertiary, 12) + ';}',
      '.pxm-select-search-clear:focus-visible{outline:2px solid ' +
        T.labelTertiary +
        ';outline-offset:1px;}',
      '.pxm-select-trigger:focus-visible,.pxm-stepper button:focus-visible{outline:2px solid ' +
        T.labelTertiary +
        ';outline-offset:1px;}',
      '.pxm-visually-hidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;}',
      /* 窄屏（<640px）：退化为底部整宽 + 另设更小高度上限 */
      '@media (max-width:640px){',
      '.pxm-overlay{left:0;right:0;bottom:0;justify-content:center;align-items:flex-end;padding:0 8px 8px;}',
      '.pxm-card{width:100%!important;max-width:none!important;max-height:32vh!important;border-radius:12px 12px 0 0;}',
      '}',
      '@media (prefers-reduced-motion:reduce){',
      '.pxm-card{animation:none!important;}',
      '.pxm-spin{animation:none!important;}',
      '.pxm-chip-running{animation:none!important;}',
      '.pxm-viewer{animation:none!important;}',
      '}',
    ].join('\n')

    function mountStyle() {
      if (typeof document === 'undefined' || document.head === null) return () => {}
      const existing = document.getElementById(STYLE_ID)
      if (existing !== null) existing.remove()
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.setAttribute('data-plugin', PLUGIN)
      style.textContent = CSS
      document.head.appendChild(style)
      return () => {
        style.remove()
      }
    }

    // ── 注册 ────────────────────────────────────────────────────────────────

    const name = PLUGIN
    const inject = ['slots']

    function warn(where, err) {
      const detail = err && err.message ? err.message : String(err)
      try {
        console.warn('[dsh-pixmart] ' + where + ' 失败：' + detail)
      } catch {
        /* 控制台不可用也无所谓 */
      }
    }

    /**
     * 每个插槽独立注册、独立 try/catch：
     * 宿主版本旧、插槽不存在或注册签名变化时，**只让该功能缺失**，绝不冒泡到设置面板。
     */
    function registerSlot(ctx, slotName, params, Component, effectLabel) {
      ctx.effect(() => {
        let dispose = null
        try {
          dispose = ctx.slots.inject(slotName, () => {
            try {
              return ctx.slots.register(params, Component)
            } catch (err) {
              warn('register ' + slotName, err)
              return undefined
            }
          })
        } catch (err) {
          warn('inject ' + slotName, err)
          return undefined
        }
        return () => {
          if (typeof dispose === 'function') {
            try {
              dispose()
            } catch (err) {
              warn('dispose ' + slotName, err)
            }
          }
        }
      }, effectLabel)
    }

    function apply(ctx) {
      // 样式随 fiber 清理
      ctx.effect(() => mountStyle(), 'dsh-pixmart: styles')

      // ① 设置页：settings.section
      registerSlot(
        ctx,
        'settings.section',
        { name: 'settings.section', id: SETTINGS_ID, order: 30, label: SLOT_LABEL },
        ProvidersSection,
        'dsh-pixmart: settings section',
      )

      // ② 侧边栏图标（id 与 main 的 key 一一对应）
      registerSlot(
        ctx,
        'sidebar.panellist',
        { name: 'sidebar.panellist', id: PANEL_KEY, order: 10, label: SLOT_LABEL },
        PanelIcon,
        'dsh-pixmart: sidebar panel icon',
      )

      // ② 中央主面板作品库
      registerSlot(
        ctx,
        'main',
        { name: 'main', key: PANEL_KEY },
        WorkbenchPanel,
        'dsh-pixmart: main panel',
      )

      // ③ 实时预览浮层
      registerSlot(
        ctx,
        'shell.overlay',
        { name: 'shell.overlay', id: OVERLAY_ID, order: 50 },
        PreviewOverlay,
        'dsh-pixmart: run preview overlay',
      )

      // 轮询器随 fiber 彻底停表（fiber 重建后可重新 start）
      ctx.effect(
        () => () => {
          runPoller.halt()
        },
        'dsh-pixmart: run poller',
      )
    }

    /**
     * 测试入口（jsdom lane 专用）。
     *
     * `test/client-dom.test.mjs` 要真的把组件挂进 jsdom、按毫秒推进 mock timer，
     * 再检查轮询节奏与浮层状态机，因此这里把组件与状态机内部件一并挂出来。
     * **生产路径只读 `name` / `inject` / `apply` 三个键，永远不会碰这个 `__test__`**，
     * 所以多挂一个键对宿主是安全的；它不参与任何注册、也不在被测逻辑里被读取。
     */
    const __test__ = {
      // 组件
      PreviewOverlay,
      PreviewCard,
      PreviewBadge,
      ProvidersSection,
      ProviderCard,
      DefaultsCard,
      OutputDirCard: ExportDirCard,
      // 语义变更后仍在 `__test__` 里保留旧键（指向同一个组件），
      // 免得只为改名而动无关的测试。
      ExportDirCard,
      WorkbenchPanel,
      ProjectCard,
      ProjectDetail,
      TrashPanel,
      CopyPromptButton,
      // 批次 C 新增：查看器（jsdom lane 直接把它挂起来验交互）
      ImageViewer,
      PanelIcon,
      // 状态机 / 轮询器：jsdom lane 用来读快照、推进一次同步
      runPoller,
      previewState,
      selectedProject,
      previewEmptyState,
      // 纯函数与常量
      fileUrl,
      relativeUrl,
      isActive,
      isTerminal,
      explainHostError,
      explainProjectActionError,
      formatDateTime,
      formatDuration,
      buildViewerEntries,
      scrollParentOf,
      lockBackgroundScroll,
      restoreBackgroundScroll,
      trapTabKey,
      HOST_STALE_HINT,
      POLL_ACTIVE_MS,
      POLL_IDLE_MS,
      PROJECT_PAGE_SIZE,
      SEARCH_DEBOUNCE_MS,
      PROJECT_SORT_OPTIONS,
      DEFAULT_PROJECT_SORT,
    }

    return { name, inject, apply, __test__ }
  },
})
