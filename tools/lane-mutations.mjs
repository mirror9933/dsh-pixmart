#!/usr/bin/env node
/**
 * 浏览器 lane 的**反向变异验证**：证明每条断言不是空跑。
 *
 * 做法：把 `client/client.js` 里对应的实现改坏（**只在内存里改，写到一个临时文件**），
 * 让 lane 去加载那份临时产物（`PXM_LANE_CLIENT=<临时文件>`），跑一遍浏览器 lane，
 * 看**对应用例是否真的失败**，然后丢掉临时文件。
 *
 * 三条纪律：
 *   1. 仓库里的 `client/client.js` **一个字节都不动**：脚本开头结尾各算一次 sha256 并比对；
 *      改写只发生在 `os.tmpdir()` 里的副本上。
 *   2. 每处 `find` 必须**恰好命中一次**：命中 0 次（实现漂移了）或多次（改错地方了）
 *      都当场报错退出 —— 否则"变异没生效"会被误读成"断言太弱"。
 *   3. 没达到预期（该失败的用例没失败）时，脚本**以非零码结束**，并逐条列出实际失败的用例名。
 *
 * 用法：
 *   node tools/lane-mutations.mjs                 # 跑全部
 *   node tools/lane-mutations.mjs M3 M4           # 只跑指定 id（前缀匹配）
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { REPO_ROOT } from '../test/browser/lane-server.mjs'

const CLIENT = path.join(REPO_ROOT, 'client', 'client.js')
/**
 * 变异跑哪些 lane 文件。
 *
 * 四条 lane 各有分工：`layout.test.mjs` 管几何（滚不动 / 顶栏被盖 / 横向溢出 …），
 * `theme.test.mjs` 管配色（计算样式是否等于官方 `--dsw-*` 的解析值、深浅色是否跟随），
 * `sizes.test.mjs` 管**控件尺寸**（高度 / 内边距 / 字号 / 行高 / 圆角是否等于官方同语义值），
 * `controls.test.mjs` 管**控件形态与可用性**（chevron / 弹层 / ✓ / 前置图标 / 行式布局 /
 * 键盘与关闭）。变异只让**对应用例**变红，所以四个都要跑：
 * 几何变异不该惊动配色与尺寸用例，反之亦然。
 */
const TEST_FILES = [
  'test/browser/layout.test.mjs',
  'test/browser/theme.test.mjs',
  'test/browser/sizes.test.mjs',
  'test/browser/controls.test.mjs',
  'test/browser/vendors.test.mjs',
]

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

/**
 * 每条变异：把某处实现退回**缺陷形态**，并声明"应该由哪条用例抓住它"。
 * `expect` 里是用例名的片段（够唯一即可）。
 */
const MUTATIONS = [
  {
    id: 'M1-panel-height',
    bug: '作品库面板根退回无高度约束（去掉 height:100% 与 minHeight:0）—— 面板被长内容顶高，整条链上没有可滚的盒子（c56b518 的根因）',
    expect: ['滚轮让详情页真的滚动'],
    edits: [
      {
        find: "        height: '100%',\n        minHeight: 0,\n        flex: '1 1 auto',",
        replace: "        flex: '1 1 auto',",
      },
    ],
  },
  {
    id: 'M2-scroll-hidden',
    bug: '面板唯一滚动容器不再可滚（overflowY auto → hidden）—— 滚轮没有任何可滚的盒子',
    expect: ['滚轮让详情页真的滚动', '40 个项目时列表滚轮可滚'],
    edits: [
      {
        find: "        flex: '1 1 auto',\n        minHeight: 0,\n        overflowY: 'auto',\n        overflowX: 'hidden',",
        replace: "        flex: '1 1 auto',\n        minHeight: 0,\n        overflowY: 'hidden',\n        overflowX: 'hidden',",
      },
    ],
  },
  {
    id: 'M3-viewer-top-zero',
    bug: '查看器 top 从 var(--dsh-frame-chrome-top) 退回 0 —— 顶栏落进 40px 窗口标题栏带（680b7d4 的根因之一）',
    expect: ['顶栏 top ≥ 40px'],
    edits: [
      {
        find: "            top: 'var(--dsh-frame-chrome-top, 0px)',",
        replace: "            top: '0px',",
      },
    ],
  },
  {
    id: 'M4-viewer-root-scrolls',
    bug: '查看器退回"整块一个 overflow:auto"的形态 —— 根自己成了滚动容器，顶栏跟着内容滚走（680b7d4 的另一半）',
    expect: ['在 .pxm-viewer-scroll 内滚'],
    edits: [
      {
        find: "            // 滚动只发生在 .pxm-viewer-scroll 里；根盒子自己不滚，顶栏才不会被滚走。\n            overflow: 'hidden',",
        replace: "            overflow: 'auto',",
      },
      {
        find: "            flex: '1 1 auto',\n            minHeight: 0,\n            overflowY: 'auto',\n            overflowX: 'hidden',\n            overscrollBehavior: 'contain',",
        replace: "            flex: '1 1 auto',\n            minHeight: 0,\n            overflowY: 'visible',\n            overflowX: 'visible',\n            overscrollBehavior: 'contain',",
      },
    ],
  },
  {
    id: 'M5-no-background-lock',
    bug: '查看器打开时不锁背景滚动（lockBackgroundScroll 不再生效）',
    expect: ['滚轮只滚查看器内部'],
    edits: [
      {
        find: '        const locks = lockBackgroundScroll(targets)',
        replace: '        const locks = []',
      },
    ],
  },
  {
    id: 'M6-no-lock-restore',
    bug: '关闭查看器/卸载面板时不还原背景滚动（cleanup 丢掉了）',
    expect: ['滚轮只滚查看器内部'],
    edits: [
      {
        find: '        const locks = lockBackgroundScroll(targets)\n        return () => {\n          restoreBackgroundScroll(locks)\n        }',
        replace: '        const locks = lockBackgroundScroll(targets)\n        return () => {}',
      },
    ],
  },
  {
    id: 'M7-prompt-unbreakable',
    bug: '详情页提示词同时去掉 overflowWrap:anywhere 与 wordBreak:break-word —— 长英文串完全不可断行',
    expect: ['详情页（长英文提示词 + 长模型名）'],
    edits: [
      {
        find: "                              overflowWrap: 'anywhere',\n                              padding: '6px 8px',",
        replace: "                              overflowWrap: 'normal',\n                              padding: '6px 8px',",
      },
      {
        find: "                              whiteSpace: 'pre-wrap',\n                              wordBreak: 'break-word',",
        replace: "                              whiteSpace: 'pre-wrap',\n                              wordBreak: 'normal',",
      },
    ],
  },
  {
    id: 'M8-metarow-no-wrap-anywhere',
    bug: '详情页「标签 + 值」的元信息行去掉 overflowWrap:anywhere 与 wordBreak —— 长 token 撑破这一行',
    expect: ['详情页（长英文提示词 + 长模型名）'],
    edits: [
      {
        find: "        h('span', { style: { wordBreak: 'break-word', overflowWrap: 'anywhere', opacity: 0.86 } }, props.children),",
        replace: "        h('span', { style: { overflowWrap: 'normal', wordBreak: 'normal', opacity: 0.86 } }, props.children),",
      },
    ],
  },
  {
    id: 'M9-tile-name-no-wrap-anywhere',
    bug: '项目卡片的名字去掉 overflowWrap:anywhere —— 超长项目名把网格撑宽',
    expect: ['列表页（超长项目名）'],
    edits: [
      {
        find: "h('span', { style: { fontSize: '13px', fontWeight: 600, overflowWrap: 'anywhere' } }, name),",
        replace: "h('span', { style: { fontSize: '13px', fontWeight: 600 } }, name),",
      },
    ],
  },
  {
    id: 'M10-field-row',
    /**
     * 设置页 `Field` 的**列方向**被去掉（`flex-direction` 从 `row` 退回默认的 `row`？
     * 不——这里改的是"控件在左列内部堆叠"的那一层）。
     *
     * 2026-10-09 控件形态复刻后，`Field` 是行式（`display:flex` + `align-items:center`），
     * 旧形态（`flexDirection:column` + `gap:3px`）已经不存在，所以这条变异改成
     * **把左列（`data-pxm-field-text`）的列方向去掉**：标签与说明从"上下两行"变成
     * 并排一行 —— 那正是官方 `.rowText{flex-direction:column}` 被写坏的形态。
     */
    bug: '设置页 Field 的左列（标签 + 说明）去掉列方向 —— 标签与说明并排而不是上下两行',
    expect: ['2.1 标签与控件在同一行'],
    edits: [
      {
        find: "            'data-pxm-field-text': '1',\n            style: {\n              display: 'flex',\n              flexDirection: 'column',",
        replace: "            'data-pxm-field-text': '1',\n            style: {\n              display: 'flex',\n              flexDirection: 'row',",
      },
    ],
  },
  {
    id: 'M11-field-ungrouped',
    bug: '「标签 + 值」不再成组（退回修复前的两个独立 flex 子项）—— 换行时从中间断开（97083a9 的根因）',
    expect: ['成组的「标签 + 值」'],
    edits: [
      {
        find: [
          '      const field = (label, value) =>',
          '        h(',
          "          'span',",
          '          {',
          '            style: {',
          "              display: 'inline-flex',",
          "              alignItems: 'baseline',",
          "              gap: '6px',",
          "              maxWidth: '100%',",
          '              minWidth: 0,',
          '            },',
          '          },',
          "          h('span', { style: { ...skin.key, whiteSpace: 'nowrap', flexShrink: 0 } }, label),",
          '          h(',
          "            'code',",
          "            { style: { ...skin.code, wordBreak: 'normal', minWidth: 0, overflowWrap: 'anywhere' } },",
          '            value,',
          '          ),',
          '        )',
        ].join('\n'),
        replace: [
          '      const field = (label, value) => [',
          "        h('span', { key: 'k', style: { ...skin.key, whiteSpace: 'nowrap', flexShrink: 0 } }, label),",
          "        h('code', { key: 'v', style: { ...skin.code, wordBreak: 'normal', minWidth: 0, overflowWrap: 'anywhere' } }, value),",
          '      ]',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'M12-no-overscroll-contain',
    /**
     * 信息性变异：**只**去掉查看器滚动层的 `overscroll-behavior: contain`（背景锁保持生效）。
     *
     * 预期：没有任何用例能抓住它。原因是拓扑——查看器是 `position: fixed` 的**兄弟**覆盖层，
     * `.pxm-scroll` 不在它的事件链上，"滚轮链式滚动到背景"在这套 DOM 结构下根本无法发生。
     * 这条结论写进了 docs §13.7「覆盖不到什么」：`overscroll-behavior` 在这里是**兜底护栏**，
     * 不是可观测契约；而"背景被锁"的**可证伪**证据是计算后的 overflow 与关闭后的还原（见 T5）。
     */
    informational: true,
    expect: [],
    bug: '查看器滚动层去掉 overscrollBehavior:contain（其余不动）—— 信息性：看是否有用例能抓住',
    edits: [
      {
        find: "            overflowY: 'auto',\n            overflowX: 'hidden',\n            overscrollBehavior: 'contain',",
        replace: "            overflowY: 'auto',\n            overflowX: 'hidden',",
      },
    ],
  },
  {
    id: 'M13-field-group-nowrap',
    bug: '「标签 + 值」的组重新拿回 whiteSpace:nowrap（上一版为修 bug 1 加在整组上的对策）—— 长路径一个断点都没有，组的 min-content = 整条路径宽度，520px 的设置弹窗被撑出横向滚动条（本次 lane 报的 687 > 520）',
    expect: ['两条 87 字符的长路径'],
    edits: [
      {
        find: [
          "              display: 'inline-flex',",
          "              alignItems: 'baseline',",
          "              gap: '6px',",
          "              maxWidth: '100%',",
          '              minWidth: 0,',
        ].join('\n'),
        replace: [
          "              display: 'inline-flex',",
          "              alignItems: 'baseline',",
          "              gap: '6px',",
          "              maxWidth: '100%',",
          '              minWidth: 0,',
          "              whiteSpace: 'nowrap',",
        ].join('\n'),
      },
    ],
  },
  {
    id: 'M14-field-value-unbreakable',
    bug: '值的断行能力被去掉（overflowWrap:anywhere 撤回）—— 值虽然能靠 minWidth:0 收窄，但长路径在它**内部**一个断点都没有，只能溢出',
    expect: ['两条 87 字符的长路径'],
    edits: [
      {
        find: "            { style: { ...skin.code, wordBreak: 'normal', minWidth: 0, overflowWrap: 'anywhere' } },",
        replace: "            { style: { ...skin.code, wordBreak: 'normal', minWidth: 0 } },",
      },
    ],
  },
  {
    id: 'M15-field-group-flex-wrap',
    /**
     * 信息性**之外**的变异：按"推荐做法"给组加 `flexWrap: 'wrap'`。
     *
     * 这条记录的是一个**实测反例**：flex 的行划分用的是子项的假设主轴尺寸
     * （值的 max-content 574px），于是 wrap 会把值整体推到第二行 ——
     * 那正是"标签与值被拆散"。既有用例 7b 与本次新用例同时抓住它，
     * 所以实现里**故意没有**加 flexWrap（见 client.js 该处注释）。
     */
    bug: '给「标签 + 值」的组加上 flexWrap:wrap（"推荐做法"）—— 长值被整行推到标签下面（拆散回归）',
    expect: ['成组的「标签 + 值」', '两条 87 字符的长路径'],
    edits: [
      {
        find: [
          "              display: 'inline-flex',",
          "              alignItems: 'baseline',",
          "              gap: '6px',",
          "              maxWidth: '100%',",
          '              minWidth: 0,',
        ].join('\n'),
        replace: [
          "              display: 'inline-flex',",
          "              flexWrap: 'wrap',",
          "              alignItems: 'baseline',",
          "              gap: '6px',",
          "              maxWidth: '100%',",
          '              minWidth: 0,',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'M16-color-hardcoded-hex',
    /**
     * 配色侧的变异：把面板底色从 token 换回**硬编码 hex**。
     *
     * 预期被两条用例同时抓住（两条各自独立，互不代偿）：
     *   - 「8.1 列表态：浅色下计算样式 == 对应 --dsw-* 的解析值」—— 面板底色不再等于
     *     `bg-layer-1` 的解析值；
     *   - 「8.2 列表态：换成官方深色 token 后同一批元素跟着变」—— 硬编码之后换 token 它一动不动。
     * 第二条正是"能与官方深浅色主题一致"的判据：浅色下相等可能是巧合同色，跟着变才是真的。
     * （`pnpm test` 里的静态用例 `test/client-tokens.test.mjs` 也会因这处 hex 变红，
     * 但它不在本脚本跑的 lane 文件里，这里只记录浏览器侧的捕获。）
     */
    bug: "面板底色从 token 退回硬编码 hex（`background: T.bgLayer1` → `'#f4f4f5'`）—— 配色不再跟随官方主题",
    expect: ['8.1 列表态：浅色下计算样式 == 对应 --dsw-* 的解析值', '8.2 列表态：换成官方深色 token 后同一批元素跟着变'],
    edits: [
      {
        // 锚点必须**唯一**：`background: T.bgLayer1,` 在文件里出现过两次
        // （作品库面板 + 设置页的模型选择盒），所以带上紧随其后的那行注释来定位。
        find: "        background: T.bgLayer1,\n        color: T.label,\n        // **故意不给 max-width**",
        replace: "        background: '#f4f4f5',\n        color: T.label,\n        // **故意不给 max-width**",
      },
    ],
  },
  {
    id: 'M17-progress-color-is-brand',
    /**
     * 语义侧的变异：把「进行中 / 进度」的状态色从**官方 `StateDot` ongoing 的那一枚**
     * （`--dsw-alias-label-tertiary`）退回 `--dsw-alias-brand-primary`。
     *
     * 这正是 d03a4a4 里那处**错误的**语义映射：`brand-primary` 是**主按钮填充**色
     * （官方 `--dsw-alias-button-primary-fill: var(--dsw-alias-brand-primary)`），
     * 浅色下近黑（`#0f1115`）、深色下近白。挂在"正在跑"的那一格上，浅色主题里它看起来
     * 像一枚按钮而不是状态点——与本插件"和官方一致"的目标相反。
     *
     * 预期被 **8.7** 抓住（浏览器侧量的是**计算样式**，所以换 token 与换硬编码 hex 都会被它抓住：前者
     * 等于 brand 的解析值，后者干脆不跟着主题变）。
     * 另外 `pnpm test` 里的静态用例 `test/client-tokens.test.mjs`（"token 表与清单一一对应"与
     * "进行中/进度用的是 label-tertiary"两条）也会因这处变红——但它不在本脚本跑的 lane 文件里。
     */
    bug: '「进行中/进度」的状态色从 label-tertiary 退回 brand-primary（主按钮填充色，浅色近黑）—— 进度点长得像按钮',
    expect: ['8.7 运行中缩略图的边框与它的进度环：浅色等于 tertiary 解析值，深色跟着变'],
    edits: [
      // T 表里补回 brand（变异体必须仍然可运行，才谈得上"被断言抓住"而不是"崩了"）
      {
        find: "      labelTertiary: 'var(--dsw-alias-label-tertiary)',",
        replace:
          "      brand: 'var(--dsw-alias-brand-primary)',\n      labelTertiary: 'var(--dsw-alias-label-tertiary)',",
      },
      // 状态色映射退回 brand
      {
        find: 'run: T.labelTertiary,',
        replace: 'run: T.brand,',
      },
    ],
  },
  {
    id: 'M18-settings-surface-is-bg-base',
    /**
     * 表面映射侧的变异（问题①的缺陷形态）：把设置页 section 的底色写成
     * **应用最底层** `--dsw-alias-bg-base`。
     *
     * 这正是用户实测"我们比官方「通用设置」暗一大截 / 看着是纯黑"的成因：官方设置页的
     * section（`.wCInkW_options`）**自己不画表面**，显示的是弹窗面板那一层
     * `--dsw-alias-bg-layer-2`（深色 `#2c2c2e`）；而 `bg-base` 是深色 `#151517`，明显更暗。
     *
     * 预期被 **8.8** 抓住。注意判据的构造：浅色下 `bg-base` / `layer-1` / `layer-2` 官方
     * **就是同一个 `#fff`**（实测），所以 8.8 只在**深色**那一次断定"等于哪一层"——
     * 这也是这条变异必须让深色那半边先跑的原因。
     */
    bug: '设置页 section 的底色从"不画表面（继承弹窗面板 bg-layer-2）"退回应用底色 bg-base（深色下更暗的"纯黑"）',
    expect: ['8.8 `.pxm-settings` 的表面 == 官方弹窗面板那一层（bg-layer-2），且不是应用底色 bg-base'],
    edits: [
      {
        // 锚点：`skin.wrap` 里那段说明性注释的结尾 + 紧随其后的 `color`。必须唯一。
        find: '        color: T.label,\n      },\n      /**\n       * 作品库面板',
        replace: '        background: T.bgBase,\n        color: T.label,\n      },\n      /**\n       * 作品库面板',
      },
    ],
  },
  {
    id: 'M19-panel-max-width-880',
    /**
     * 宽屏布局侧的变异（问题②的缺陷形态）：给作品库面板加回 `maxWidth: '880px'`。
     *
     * 那条上限是抄"聊天的阅读宽度"来的（git c6b342c）。1280px 视口下看不出问题；
     * 2560px 全屏下中栏有 2340px，面板只吃 880px —— 右边 1460px 全是空白，
     * 就是用户截图里"内容挤在左侧、右边一大片空白色块"。
     *
     * 预期被 **8.**（`layout.test.mjs` 的宽屏用例，1600 与 2560 两档）抓住：
     * 两档都会报"面板右边界必须贴住中栏右边界"。
     */
    bug: '作品库面板加回 maxWidth:880px（抄聊天的阅读宽度）—— 宽屏下右边留一大片空白',
    expect: ['8. 1600/2560 宽视口下：面板右边界贴住中栏右边界，内容区占满且仍在内部滚动'],
    edits: [
      {
        find: "        padding: '18px',\n        boxSizing: 'border-box',\n        height: '100%',",
        replace: "        padding: '18px',\n        boxSizing: 'border-box',\n        maxWidth: '880px',\n        height: '100%',",
      },
    ],
  },
  {
    id: 'M20-input-surface-is-bg-base',
    /**
     * 输入控件侧的变异（19.5 的缺陷形态）：把输入控件的底色从**官方那一层**
     * 退回 `--dsw-alias-bg-base`（**应用最底层**，深色 `#151517`）。
     *
     * 这正是用户肉眼确认的那处偏差：输入框嵌在设置面板（`bg-layer-2`，深色 `#2c2c2e`）里
     * 却比面板本身还暗一层，观感是"输入框塌进去了"。
     *
     * **2026-10-12 起锚点是 `modelsPageInputStyle`**（模型页本页那一类控件）：
     * 设置页的文本框 / 密码框 / 自绘下拉触发器已从 `inputStyle`（`bg-layer-3`）改挂
     * `modelsPageInputStyle`（`bg-layer-1`），而 8.9 的判据现在是"按控件分类判层" ——
     * 只有动**这一类**的底色，才会走到"最近色必须命中 `bg-layer-1`"那条断言上。
     * 动 `inputStyle` 只会打到 `input.exportDir` / `textarea.prompt` 那一组（浅色下
     * 官方四层同色、判不出"等于哪一层"，深色那一轮才判），那是**另一类**控件。
     *
     * 预期被 **8.9** 抓住：变异体报的是「底色是 bg-base —— 那是误差形态」，
     * 而不是笼统的"颜色不等"。
     *
     * 注：变异体只把**内联样式**退回 bg-base，`T.bgLayer1` / `T.bgLayer3` 键仍在
     * （别处仍在引用），所以变异产物照样能跑起来 —— 这是"被断言抓住"而不是"崩了"的前提。
     */
    bug: '输入控件底色从官方那一层退回应用最底层 bg-base（深色下比设置面板还暗，"输入框塌进去"）',
    expect: ['8.9 input / password / 自绘下拉触发器 == 官方「模型」页那层 bg-layer-1'],
    edits: [
      {
        // 锚点：`modelsPageInputStyle` 里 `background: T.bgLayer1,` 与紧随其后的边框注释
        // 一起出现，在文件里**只此一处**（弹层 / 触发器那两处都没有这行注释）。
        find: '      background: T.bgLayer1,\n      // 描边与 `inputStyle` 同一枚',
        replace: '      background: T.bgBase,\n      // 描边与 `inputStyle` 同一枚',
      },
    ],
  },
  {
    id: 'M21-input-surface-is-bg-layer-2',
    /**
     * 输入控件侧的第二形态：把同一处的底色退回**设置面板自己那一层**
     * `--dsw-alias-bg-layer-2`。
     *
     * 这一条的存在意义是证明 8.9 里那句"**不等于** `bg-layer-2`"**不是空转**：
     * `bg-layer-2` 与 `bg-layer-1` 只差一档（深色 `#2c2c2e` vs `#232324`），肉眼几乎看不出，
     * 但"输入框与它所在的卡片同色"就意味着控件边界只剩一根描边 —— 官方不是这么画的。
     * 若删掉那条 notEqual，这条变异就不会红。
     */
    bug: '输入控件底色退回设置面板那一层 bg-layer-2（与卡片同色，控件只剩描边、看不出是输入面）',
    expect: ['8.9 input / password / 自绘下拉触发器 == 官方「模型」页那层 bg-layer-1'],
    edits: [
      {
        find: '      background: T.bgLayer1,\n      // 描边与 `inputStyle` 同一枚',
        replace: '      background: T.bgLayer2,\n      // 描边与 `inputStyle` 同一枚',
      },
    ],
  },
  {
    id: 'M22-input-height-old',
    /**
     * 尺寸对齐（2026-10-08）的第一形态：把表单值控件的高度退回**改造前**的 28px。
     *
     * 官方是 34px（`fields.module.css:108` 的 `.input{height:34px}`）。改的是
     * `S.fieldHeight`（`inputStyle` 唯一的取值来源）。
     *
     * **2026-10-12 起这条变异盯的对象变了**：设置页的文本框 / 密码框 / 自绘下拉触发器
     * 已改挂 `modelsPageInputStyle`（32px，走 `S.modelsInputHeight`）—— 那是**另一类**
     * 官方控件，所以 `S.fieldHeight` 现在只剩两处消费方：作品库工具条的**排序下拉**
     * （原生 `<select>`）与各处 `inputStyle` 派生。相应地 `expect` 从
     * `sizes 1.1`（设置页）改成 **`2.1`（作品库）** —— 断言一字未改，是**被它覆盖的对象**
     * 变了；`1.1` 现在由 `M43` 盯着。搜索框的 36px 在 `S.searchHeight` 上，本变异不影响
     * 它（这正好说明"搜索框 ≠ 表单值字段"这两套尺寸是分开钉住的）。
     */
    bug: '表单值控件高度从官方的 34px 退回改造前的 28px（S.fieldHeight）',
    expect: ['2.1 工具条按钮 = Button.sm；搜索框 / 排序下拉 = 官方表单控件'],
    edits: [
      {
        find: "      fieldHeight: '34px',",
        replace: "      fieldHeight: '28px',",
      },
    ],
  },
  {
    id: 'M23-button-padding-old',
    /**
     * 尺寸对齐的第二形态：行内按钮的内边距退回改造前的 `4px 10px`（官方 `.sm` 是 `0 10px`）。
     *
     * 只改内边距、不改高度：按钮的**几何高度**仍然是 28px（`height` 是显式的），
     * 所以能抓住它的只有"内边距等于官方"那几条断言 —— 这正是要证明它们有效的地方。
     */
    bug: '按钮内边距从官方 Button.sm 的 `0 10px` 退回改造前的 `6px 10px`（S.buttonPad）',
    expect: ['1.2 按钮 = 官方 Button.sm', '2.1 工具条按钮'],
    edits: [
      {
        find: "      buttonPad: '0 10px',",
        replace: "      buttonPad: '6px 10px',",
      },
    ],
  },
  {
    id: 'M24-title-size-old',
    /** 尺寸对齐的第三形态：节标题退回改造前的 15px/600（官方 `._3nPmjq_title` 是 16px/24px/500）。 */
    bug: '设置页节标题从官方的 16px/24px/500 退回改造前的 15px/600（S.titleFontSize）',
    expect: ['1.3 标题 / 正文 = 官方文字层级'],
    edits: [
      {
        find: "      titleFontSize: '16px',",
        replace: "      titleFontSize: '15px',",
      },
    ],
  },
  {
    id: 'M25-tag-padding-old',
    /** 尺寸对齐的第四形态：胶囊标签内边距退回改造前的 `1px 6px`（官方 `.tag` 是 `1px 8px`）。 */
    bug: '胶囊标签内边距从官方 Tag 的 `1px 8px` 退回改造前的 `1px 6px`（S.tagPad）',
    expect: ['1.2 按钮 = 官方 Button.sm', 'Tag = 官方 .tag'],
    edits: [
      {
        find: "      tagPad: '1px 8px',",
        replace: "      tagPad: '1px 6px',",
      },
    ],
  },
  {
    id: 'M26-radius-hardcoded',
    /**
     * 尺寸对齐的第五形态：卡片圆角**不再走官方变量**，退回一个硬编码的 10px
     * （改造前 `skin.card` 就是 `borderRadius: '10px'`）。
     *
     * 这一条与 M22~M25 性质不同：前四条改的是"照抄的 px"，这一条改的是"**本该跟随官方**的
     * 那一半"。它证明 `sizes.test.mjs` 里那句"计算值 == `var(--dsw-radius-lg)` 的解析值"
     * 真的在比变量解析值 —— 若断言写成硬编码的 16px，这条变异仍然会被抓住（10 ≠ 16），
     * 但 1.2 那条 `radius-sm` 的断言就说明了两者的区别：官方改半径时**只有**走变量的写法
     * 才不需要改代码。
     */
    bug: '卡片圆角不走官方变量，硬编码回改造前的 10px（S.radiusLg → 字面量）',
    expect: ['2.2 回收站列表项 = 官方设置卡片'],
    edits: [
      {
        /**
         * 锚点带上上一行的 `background: T.bgLayer2`（设置卡片自己的填充）：
         * 2026-10-09 起自绘下拉弹层也用 `borderRadius: S.radiusLg`，
         * 只按圆角那一行找会命中 2 次（脚本要求恰好 1 次）。
         * 2026-10-12 起弹层改成"两条边定位"，那块里已经没有 `S.radiusLg` —— 但仍然保留
         * 这行锚点：它是"只改卡片圆角、不动别处"的语义说明。
         */
        find: "        background: T.bgLayer2,\n        borderRadius: S.radiusLg,",
        replace: "        background: T.bgLayer2,\n        borderRadius: '10px',",
      },
    ],
  },
  // ── 控件形态复刻（2026-10-09）：三种自绘控件 + 行式布局 ───────────────────────
  {
    id: 'M27-no-select-chevron',
    /**
     * 形态复刻的第一形态：自绘下拉**去掉 chevron**（触发器只剩一段文字）。
     *
     * 官方触发器（`PermissionRow.module.css` 的 `.selector`）是"标签 + chevron"，
     * chevron 是"这是个下拉、不是一段静态文字"的唯一视觉信号。去掉它之后，控件在
     * 观感上退化成标签，用户不知道能点。
     *
     * 期望由 `test/browser/controls.test.mjs` 的 1.1 抓住（`hasChevron`）。
     */
    bug: '自绘下拉触发器去掉 chevron（触发器退化成一段看起来静态的文字）',
    expect: ['1.1 下拉：触发器是 button、带 chevron'],
    edits: [
      {
        find: "          h(Icon, {\n            name: 'chevronDown',\n            className: 'pxm-select-chevron',",
        replace: "          false ? h(Icon, {\n            name: 'chevronDown',\n            className: 'pxm-select-chevron',",
      },
      {
        /**
         * 第二处收尾：2026-10-12 起 chevron 之后紧跟的是 `),` + `// 弹层…` 注释
         * （弹层从内联三元改成 `const popup`），所以锚点跟着改成那一行注释。
         */
        find: "              transform: open ? 'rotate(180deg)' : 'none',\n            },\n          }),\n        ),\n        // 弹层（位置/上限由 `place` 给，见上面的定位注释）。",
        replace: "              transform: open ? 'rotate(180deg)' : 'none',\n            },\n          }) : null,\n        ),\n        // 弹层（位置/上限由 `place` 给，见上面的定位注释）。",
      },
    ],
  },
  {
    id: 'M28-no-select-list',
    /**
     * 形态复刻的第二形态：点击触发器**不再渲染弹层**（`open ? popup : null` 恒为 null）。
     *
     * 这是"自绘下拉"最容易被写坏的一半：触发器长得对、点下去什么都没有。
     * 期望由 `controls.test.mjs` 的 1.1 / 3.1 / 3.2 / 3.3 一起抓住
     * （探针里 `listRole` 与 `aria-expanded` 同时对不上）。
     */
    bug: '自绘下拉永远不渲染弹层（触发器可点但没有菜单）',
    expect: [
      '1.1 下拉：触发器是 button、带 chevron',
      '3.1 ↑↓ 改变选中项',
      '3.2 Esc 关闭弹层并把焦点交回触发器',
      '3.3 点击外部关闭弹层',
    ],
    edits: [
      {
        find: '        // 弹层（位置/上限由 `place` 给，见上面的定位注释）。\n        open ? popup : null,',
        replace: '        // 弹层（位置/上限由 `place` 给，见上面的定位注释）。\n        null,',
      },
    ],
  },
  {
    id: 'M29-field-row-to-stack',
    /**
     * 形态复刻的第三形态：设置页 `Field` **退回堆叠式**（标签在上、控件在下）。
     *
     * 这一条同时证明两件事：
     *   1. `controls.test.mjs` 2.1（行式布局）不是空转——退回堆叠后控件跑到标签下方、
     *      纵向不再重叠；
     *   2. `layout.test.mjs` 7a（2026-10-09 起方向已改成"必须行式"）也不是空转。
     *
     * 注意与 `M10` 的区别：M10 是"把行式改坏的另一种写法"（去掉列方向），
     * 这一条是"整行退回改造前的旧形态"。两条都必须被抓住，否则"行式"这条契约只有一半证据。
     */
    bug: '设置页字段从行式退回堆叠式（标签在上、控件在下）',
    expect: ['2.1 标签与控件在同一行', '「默认值」卡片：每个字段是行式'],
    edits: [
      {
        find: "          'data-pxm-field': '1',\n          style: {\n            display: 'flex',\n            alignItems: 'center',",
        replace: "          'data-pxm-field': '1',\n          style: {\n            display: 'flex',\n            flexDirection: 'column',\n            alignItems: 'stretch',",
      },
    ],
  },
  {
    id: 'M30-no-search-icon',
    /**
     * 形态复刻的第四形态：搜索框**去掉前置放大镜**（退回裸 `<input>`）。
     *
     * 官方 `RotMhW_search` 的图标是"这是搜索、不是普通输入框"的信号，
     * 且它的 `left:12px` 与输入框的 `padding-left:36px` 是配套的（去掉图标后
     * 那 36px 就变成一段莫名其妙的空白）。
     * 期望由 `controls.test.mjs` 的 1.2 抓住。
     */
    bug: '搜索框去掉前置放大镜图标（退回裸输入框）',
    expect: ['1.2 搜索框：整宽、前置放大镜图标'],
    edits: [
      {
        find: "        h(Icon, {\n          name: 'search',\n          className: 'pxm-search-icon',",
        replace: "        false ? h(Icon, {\n          name: 'search',\n          className: 'pxm-search-icon',",
      },
      {
        find: "          style: {\n            position: 'absolute',\n            left: S.searchIconLeft,\n            pointerEvents: 'none',\n          },\n        }),",
        replace: "          style: {\n            position: 'absolute',\n            left: S.searchIconLeft,\n            pointerEvents: 'none',\n          },\n        }) : null,",
      },
    ],
  },
  {
    id: 'M31-stepper-one-arrow',
    /**
     * 形态复刻的第五形态：数字步进器**只留一枚箭头**（去掉向上那一枚）。
     *
     * 官方 `FontSizeRow` 的 `.arrows` 是"上下两枚"，只留一枚时用户只能单向调值；
     * 而"到边界时另一枚禁用"这条（1–4 边界）也就无从谈起了。
     * 期望由 `controls.test.mjs` 的 1.3 抓住（`upChevron` / `upRect`）。
     */
    bug: '数字步进器只剩一枚向上箭头（去掉向下那一枚）',
    expect: ['1.3 数字步进器：容器内有数值 + 上下两枚 chevron 按钮'],
    edits: [
      {
        find: "          h(\n            'button',\n            {\n              type: 'button',\n              className: 'pxm-stepper-down',",
        replace: "          false ? h(\n            'button',\n            {\n              type: 'button',\n              className: 'pxm-stepper-down',",
      },
      {
        find: "            h(Icon, { name: 'chevronDown', size: 9, testId: 'stepper-down', color: downEdge ? T.labelTertiary : T.label }),\n          ),",
        replace: "            h(Icon, { name: 'chevronDown', size: 9, testId: 'stepper-down', color: downEdge ? T.labelTertiary : T.label }),\n          ) : null,",
      },
    ],
  },
  {
    id: 'M32-search-to-left',
    /**
     * 作品库单行工具条（2026-10-10）：把**搜索框挪回左边**。
     *
     * 用户的要求是"排序 / 全选 / 取消全选在左、搜索在右"。搜索框靠
     * `marginLeft:'auto'` 被推到行尾；去掉它之后搜索框紧跟在「取消全选」后面，
     * 落进行**左半**。
     *
     * 期望由 `layout.test.mjs` 的 9.1 抓住（"搜索框必须落在工具条行的**右半**"）。
     */
    bug: '搜索框从右对齐退回排在左侧控件后面（「搜索放右边」被改坏）',
    expect: ['9.1 四枚控件在同一行'],
    edits: [
      {
        find: "                marginLeft: 'auto',\n                flex: '0 1 220px',",
        replace: "                flex: '0 1 220px',",
      },
    ],
  },
  {
    id: 'M33-toolbar-nowrap',
    /**
     * 作品库单行工具条（2026-10-10）：**禁止换行**（`flexWrap: wrap → nowrap`）。
     *
     * 用户的要求是"单行放不下时**允许换行**（搜索框可折到第二行），但必须无横向滚动条"。
     * 375px 下左侧三枚控件已经占掉 339px 可用宽度里的 320px，而搜索框的 flex 基准是
     * 220px —— `nowrap` 时它退无可退，整行必然横向溢出。
     *
     * 期望由 `layout.test.mjs` 的 9.2 抓住（"工具条行不得横向溢出" +
     * "文档不得被撑出横向滚动"）。与 M32 互补：M32 证明"左 / 右位置"这条不是空跑，
     * M33 证明"窄屏不溢出"这条不是空跑。
     */
    bug: '工具条行禁止换行（375px 下被硬塞成一行 → 横向溢出）',
    expect: ['9.2 375px 窄屏：工具条不横向溢出'],
    edits: [
      {
        find: "            className: 'pxm-list-bar',\n            style: { ...skin.row },",
        replace: "            className: 'pxm-list-bar',\n            style: { ...skin.row, flexWrap: 'nowrap' },",
      },
    ],
  },
  {
    id: 'M34-search-rigid-overflow',
    /**
     * 作品库单行工具条（2026-10-10）：搜索框**变成不可压缩的定宽**（`0 1 220px → 0 0 400px`）。
     *
     * 这一条专门钉"窄屏无横向溢出"这条断言**自身**：搜索框既不能缩（`flexShrink:0`）
     * 又比 375px 下的可用宽度（339px）还宽，于是它整块溢出到行外 ——
     * `[data-pxm-toolbar].scrollWidth 400 > clientWidth 339`。
     *
     * 与 `M33` 的分工：M33（禁止换行）会先撞上别的断言（行内三枚控件被挤散），
     * 溢出那条**轮不到报**；M34 让左侧三枚控件照旧整齐，只把溢出这一条单独逼出来，
     * 从而证明 `9.2` 里那句 `scrollWidth <= clientWidth + 1` 不是空跑。
     */
    bug: '搜索框改成不可压缩的定宽 400px（375px 下整块溢出工具条行）',
    expect: ['9.2 375px 窄屏：工具条不横向溢出'],
    edits: [
      {
        find: "                marginLeft: 'auto',\n                flex: '0 1 220px',",
        replace: "                marginLeft: 'auto',\n                flex: '0 0 400px',",
      },
    ],
  },
  {
    id: 'M35-label-back',
    /**
     * 作品库单行工具条（2026-10-10）：把**被删掉的左侧标签加回来**
     * （`[data-pxm-field-label]`、文案「搜索（项目名 / 模块名）」）。
     *
     * 用户明确要求删掉那一列标签与说明。这一条证明 `layout.test.mjs` 的 9.1
     * 里"工具条行里不该再有字段标签 / 说明"与"整页文本里那几段文字一个字都不许剩"
     * 不是空跑 —— **两处都加**，因为那两条断言分别查的是 DOM 锚点与整页文本，
     * 只加一处的话另一条仍然是空跑。
     */
    bug: '把删掉的左侧字段标签加回工具条（「搜索（项目名 / 模块名）」）',
    expect: ['9.1 四枚控件在同一行'],
    edits: [
      {
        find: "            'data-pxm-toolbar': '1',\n            // `skin.row` 自带",
        replace: "            'data-pxm-toolbar': '1',\n            'data-pxm-field-label': '1',\n            'aria-label': '搜索（项目名 / 模块名）',\n            // `skin.row` 自带",
      },
      {
        find: "              // 原来靠左侧标签解释\"搜什么\"，标签删了 → **必须由 placeholder 交代**。\n              // 措辞与排序下拉的选项名（项目名 / 创建时间 / 图片张数）同一套词。\n              placeholder: '搜索项目名 / 模块名',",
        replace: "              placeholder: '搜索项目名 / 模块名',",
      },
      {
        find: "                marginLeft: 'auto',\n                flex: '0 1 220px',\n                minWidth: 0,\n              },\n            },\n            h(SearchInput, {",
        replace: "                marginLeft: 'auto',\n                flex: '0 1 220px',\n                minWidth: 0,\n              },\n            },\n            h('div', { 'data-pxm-field-desc': '1' }, '输入即筛，300ms 防抖'),\n            h('div', { 'data-pxm-field-label': '1' }, '搜索（项目名 / 模块名）'),\n            h(SearchInput, {",
      },
    ],
  },
  {
    id: 'M36-placeholder-vague',
    /**
     * 作品库单行工具条（2026-10-10）：placeholder **退回不含字段名的泛泛说法**
     * （`搜索项目名 / 模块名` → `搜索`）。
     *
     * 左侧标签被删掉之后，placeholder 是**唯一**交代"这个搜索框搜什么"的地方。
     * 退回一个光秃秃的「搜索」之后，用户不知道能按项目名还是模块名搜 ——
     * 而这正是"标签删了必须在 placeholder 里交代"这条要求的实质。
     *
     * 期望由 `layout.test.mjs` 的 9.1 抓住（那里的断言是**逐字相等**，
     * 不是"非空即可"，所以这条变异必然命中）。
     */
    bug: '搜索框 placeholder 退回泛泛的「搜索」（不再交代搜项目名 / 模块名）',
    expect: ['9.1 四枚控件在同一行'],
    edits: [
      {
        find: "              placeholder: '搜索项目名 / 模块名',",
        replace: "              placeholder: '搜索',",
      },
    ],
  },
  // ── 厂商标卡片对齐官方「模型」页（2026-10-11）：三个保留项 + 样式档位 ─────────
  {
    id: 'M37-no-fetch-models-button',
    /**
     * 样式统一（2026-10-11）的第一形态：**把「拉取模型」按钮删掉**。
     *
     * 这正是"改样式时把保留项弄没"的典型事故：卡片按官方结构重排之后，
     * 那一枚 `linkButton` 很容易在搬家的过程中被落下。用户把它列为硬性保留项，
     * 所以 `vendors.test.mjs` 的 1.1 是按**行为**写的（存在 + 可点 + 点下去真的发
     * `POST …/refresh-models`），删掉按钮之后它在第一句就红。
     *
     * 期望同时看到 1.3 变红（没有按钮就拉不出列表）—— 那不是"多余的失败"，
     * 而正是保留项之间的依赖关系被如实报出来。
     */
    bug: '把「拉取模型」按钮从卡片上删掉（保留项丢失）',
    expect: ['1.1 「拉取模型」按钮存在、可点'],
    edits: [
      {
        find: [
          '              h(',
          '                LinkButton,',
          '                {',
          "                  role: 'fetch-models',",
          "                  className: 'pxm-fetch-models',",
          '                  disabled: models.busy,',
          '                  onClick: onRefresh,',
          "                  title: 'GET {baseUrl}/models：只拉取，不写配置（写入要显式保存选择）',",
          '                },',
          "                models.busy ? '拉取中…' : '拉取模型',",
          '              ),',
        ].join('\n'),
        replace: '              null,',
      },
    ],
  },
  {
    id: 'M38-no-test-connection-button',
    /**
     * 样式统一的第二形态：**把「测试连接」按钮删掉**（另一个硬性保留项）。
     *
     * 2026-10-12 结构适配：这一枚随"点「编辑」展开"的同构改造从**行尾动作**挪进了
     * **展开后的模型区标题行**，并且和「拉取模型」一样改用官方的 `linkButton`
     * （`LinkButton` 而不是 `Btn`）—— 所以锚点跟着实现搬家，`bug` / `expect` 一个字不改。
     */
    bug: '把「测试连接」按钮从卡片上删掉（保留项丢失）',
    expect: ['1.2 「测试连接」按钮存在、可点'],
    edits: [
      {
        find: [
          '              h(',
          '                LinkButton,',
          '                {',
          "                  role: 'test-connection',",
          "                  className: 'pxm-test-connection',",
          '                  disabled: probe.busy,',
          '                  onClick: onTest,',
          "                  title: '发一次探测请求，不写配置',",
          '                },',
          "                probe.busy ? '测试中…' : '测试连接',",
          '              ),',
        ].join('\n'),
        replace: '              null,',
      },
    ],
  },
  {
    id: 'M39-vendor-card-style-old',
    /**
     * 样式统一的第三形态：**把卡片的内边距 / 圆角 / 描边退回改造前的值**。
     *
     * 官方的 `._3nPmjq_rowCard` 是 `padding:12px 14px` + `border-radius:var(--dsw-radius-xl)`
     * + `border:.5px solid var(--dsw-alias-settings-card-stroke)`（= `border-l4`）；
     * 改造前那一版厂商卡片根本不是卡片（只有一条 `border-top` 分隔线），所以"退回去"
     * 在这里写成"回到本插件别处卡片那一档"（`10px 12px` + `radius-lg` + `border-l1`）。
     *
     * 期望由 `vendors.test.mjs` 的 2.1 抓住 —— 内边距、圆角解析值、描边色三处都对不上。
     * 它证明那条断言不是"照着实现抄一遍"：改实现必须让它红。
     */
    bug: '厂商卡片的内边距 / 圆角 / 描边退回改造前那一档（10px 12px + radius-lg + border-l1）',
    expect: ['2.1 厂商卡片 = 官方 ._3nPmjq_rowCard'],
    edits: [
      {
        find: [
          '        gap: S.cardGap,',
          '        padding: S.cardPad,',
          "        border: '0.5px solid ' + T.borderL4,",
          '        background: T.bgLayer2,',
          '        borderRadius: S.radiusXl,',
        ].join('\n'),
        replace: [
          '        gap: S.cardGap,',
          "        padding: '10px 12px',",
          "        border: '0.5px solid ' + T.borderL1,",
          '        background: T.bgLayer2,',
          '        borderRadius: S.radiusLg,',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'M40-model-list-style-old',
    /**
     * 样式统一的第四形态：**把模型列表退回旧样式**。
     *
     * 官方的候选行（`._3nPmjq_candidateLabel`）是 `gap:8px;padding:6px 8px`，
     * 外层 `._3nPmjq_candidate{border-radius:var(--dsw-radius-md)}`；
     * 改造前那一版是"12px 字、行高 1.8、没有内边距也没有圆角"的一行文字。
     *
     * 期望由 `vendors.test.mjs` 的 2.3 抓住（行内边距 / 圆角 / 由内边距决定的真实行高）。
     */
    bug: '模型列表行退回旧样式（无内边距 / 无圆角 / 12px 文字）',
    expect: ['2.3 模型列表 = 官方候选列表'],
    edits: [
      {
        find: [
          '                    style: {',
          "                      display: 'flex',",
          "                      alignItems: 'center',",
          '                      gap: S.modelRowGap,',
          '                      padding: S.modelRowPad,',
          '                      borderRadius: S.radiusMd,',
          '                      minWidth: 0,',
          "                      cursor: busy ? 'not-allowed' : 'pointer',",
          '                    },',
        ].join('\n'),
        replace: [
          '                    style: {',
          "                      display: 'flex',",
          "                      alignItems: 'center',",
          "                      gap: '6px',",
          "                      fontSize: '12px',",
          '                      lineHeight: 1.8,',
          '                      minWidth: 0,',
          "                      cursor: busy ? 'not-allowed' : 'pointer',",
          '                    },',
        ].join('\n'),
      },
    ],
  },
  // ── 可搜索下拉 + 弹层不被裁 + 模型页输入档（2026-10-12）─────────────────────
  {
    id: 'M41-no-select-search',
    /**
     * 可搜索下拉（2026-10-12）的第一形态：**去掉搜索框**。
     *
     * 这正是用户反馈那件事的"退回原状"：模型有 16 个，弹层只能一屏一屏翻。
     * 改法：把搜索框那一整块的渲染条件从 `enableSearch` 改成 `false`（能力开关还在，
     * 只是永远不画搜索框），弹层退化成"纯 ↑↓ 的长列表"。
     *
     * 期望由 `controls.test.mjs` 的 **4.1 / 4.2 / 4.4** 一起抓住：
     * 4.1 直接断言"16 项的长列表必须有搜索框"；4.2 / 4.4 靠
     * `page.fill('[data-pxm-select-search]')` 找不到元素而失败。三条各自独立。
     */
    bug: '长列表弹层去掉搜索框（16 个模型只能一屏一屏翻，用户反馈的那件事原样回来）',
    expect: [
      '4.1 长列表（16 项）的弹层里有搜索框；短列表（3 项）没有',
      '4.2 输入即过滤（大小写不敏感子串）',
      '4.4 直接在列表容器上打字符就开始搜',
    ],
    edits: [
      {
        // 锚点 = 搜索框那一块的渲染条件（唯一）。
        find: "        enableSearch\n          ? h(\n              'div',\n              {\n                className: 'pxm-select-search',",
        replace: "        false\n          ? h(\n              'div',\n              {\n                className: 'pxm-select-search',",
      },
    ],
  },
  {
    id: 'M42-select-list-clipped',
    /**
     * 第二形态：**让弹层重新被裁**（退回 `position: absolute` + `left: 0`，
     * 也就是 2026-10-12 之前那个形态）。
     *
     * 这条专门钉"弹层完整可见"那条断言**自身**：绝对定位的弹层是"设置弹窗"
     * （`#settingsDialog{overflow:auto}`，真实 shell 是 `SettingsRoot` 的
     * `.wCInkW_options{overflow-y:auto}`）的内容，触发器靠近它下边界时会被切掉。
     * 注意**不动** `max-height`：这不是"把上限调小就算修好"那种改法 ——
     * 变异体的高度上限仍由定位逻辑给（320），被裁是**位置**的问题。
     */
    bug: '弹层退回 position:absolute（重新被设置弹窗的 overflow 裁掉）—— 去掉翻转/夹取',
    expect: [
      '4.5 弹层必须完整落在视口内且贴着触发器',
      '4.6 长列表 + 矮窗口',
    ],
    edits: [
      {
        // 锚点要**唯一**：`position: 'fixed'` 在文件里出现过三次（作品库面板 / 实时预览卡 /
        // 这里），所以带上紧随其后的那行注释来定位弹层这一处。
        find: "            position: 'fixed',\n            // 贴住触发器的**那一条边**",
        replace: "            position: 'absolute',\n            // 贴住触发器的**那一条边**",
      },
      {
        // 绝对定位下 `bottom` 是相对**包含块**（`position:relative` 的 `.pxm-select`）算的，
        // 语义完全不同 —— 所以连它一起退回旧形态（`top: calc(100% + 4px)` + `left: 0`）。
        find: [
          '            ...(place.up',
          "              ? { bottom: String(place.anchor) + 'px' }",
          "              : { top: String(place.anchor) + 'px' }),",
          "            left: String(place.left) + 'px',",
        ].join('\n'),
        replace: ["            top: 'calc(100% + ' + S.menuOffset + ')',", '            left: 0,'].join('\n'),
      },
      {
        // 宽度也别再跟触发器夹取（旧形态是 `minWidth:100%` + `maxWidth: menuMaxWidth`）。
        find: [
          '            // 宽度跟触发器一致；`maxWidth` 再挡一层（面板比视口还宽时不让它溢出右边）。',
          "            width: String(place.width) + 'px',",
          "            maxWidth: String(place.width) + 'px',",
        ].join('\n'),
        replace: [
          '            // 旧形态：跟触发器对齐 + 官方 Menu 的宽度上限。',
          "            minWidth: '100%',",
          '            maxWidth: S.menuMaxWidth,',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'M43-models-input-old-34px',
    /**
     * 第三形态：**把模型页的输入控件退回 34px / `bg-layer-3`**
     * （`settings-form` 那一档，2026-10-12 之前的形态）。
     *
     * 只改 `modelsPageInputStyle` 的高度与底色：两处一起改才对应"退回旧档"，
     * 而两处分别由**两条不同的用例**钉着（尺寸那条在 `sizes.test.mjs`、
     * 底色那条在 `theme.test.mjs`）—— 一条变异同时证明两条断言都不是空跑。
     */
    bug: '模型页输入控件退回 34px / bg-layer-3（settings-form 那一档，而不是本页私有的 32px / bg-layer-1）',
    expect: [
      '1.1 输入框 / 自绘下拉触发器 = 官方「模型」页本页的 `._3nPmjq_input`',
      '8.9 input / password / 自绘下拉触发器 == 官方「模型」页那层 bg-layer-1',
    ],
    edits: [
      {
        find: "      modelsInputHeight: '32px',",
        replace: "      modelsInputHeight: '34px',",
      },
      {
        // `modelsPageInputStyle` 里那一处（`background: T.bgLayer1,` 紧跟 `color: T.label,`，
        // 且下一行是那句注释）—— 锚点必须唯一。
        find: "      color: T.label,\n      background: T.bgLayer1,\n      // 描边与 `inputStyle` 同一枚",
        replace: "      color: T.label,\n      background: T.bgLayer3,\n      // 描边与 `inputStyle` 同一枚",
      },
    ],
  },
  // ── 厂商卡片重构（2026-10-12）：点「编辑」展开 / 自定义设置 / 虚线添加 ──────────
  {
    id: 'M44-editor-surface-is-bg-base',
    /**
     * 重构后新增的**折叠编辑器**最容易退成的那一档：底色写回**应用最底层**
     * `--dsw-alias-bg-base`。
     *
     * 官方 `._3nPmjq_editor{border-radius:var(--dsw-radius-lg);
     * background:var(--dsw-alias-bg-module-platform);gap:14px;padding:14px 16px}`
     * （`.probe/models-css-pretty.txt:27`）—— 编辑器要与卡片（`settings-card-fill`
     * = `bg-layer-2`）**分层**；`bg-base` 在深色下是 `#151517`（比弹窗面板更暗），
     * 编辑器会与卡片糊成一片。
     *
     * 期望由 `vendors.test.mjs` 的 **2.2** 抓住：那一条既断"等于 bg-module-platform
     * 的解析值"，又断"不得等于 bg-base / bg-layer-1"（后两条是为这条变异写的反向判据）。
     */
    bug: '编辑块底色从官方 `bg-module-platform` 退回应用底色 `bg-base`（编辑器与卡片糊成一片）',
    expect: ['2.2 标头 / 编辑块 / 模型区块'],
    edits: [
      {
        // 锚点 = editor 样式里那一行（`background: T.bgModulePlatform,` 全文件唯一）。
        find: '                  background: T.bgModulePlatform,',
        replace: '                  background: T.bgBase,',
      },
    ],
  },
  {
    id: 'M45-add-button-solid',
    /**
     * 重构新增的虚线按钮退回实线：官方有**两条**规则都命中 `._3nPmjq_addButton` ——
     * `:19` 的 `.secondaryButton,.addButton{border:.5px solid …}` 与 `:39` 的
     * `.addButton{border:1px dashed var(--dsw-alias-border-l3);…min-width:180px;height:44px}`
     * （同优先级、后者在后 → 实到 `1px dashed`）。把 `dashed` 改回 `solid`，
     * "这一枚是虚线"这条形态信息就没了。
     *
     * 期望由 `vendors.test.mjs` 的 **3.6** 抓住（`borderTopStyle` 与声明值都断）。
     */
    bug: '虚线「添加模型提供商」退回实线（`1px dashed` → `1px solid`），官方 addButton 的虚线形态丢失',
    expect: ['3.6 虚线「添加模型提供商」'],
    edits: [
      {
        // 锚点 = `AddVendorButton` 的边框那一行（`dashed + T.borderL3` 全文件唯一；
        // 另一处 `1px dashed` 挂的是 `T.borderL2`，命不中）。
        find: "            border: '1px dashed ' + T.borderL3,",
        replace: "            border: '1px solid ' + T.borderL3,",
      },
    ],
  },
  {
    id: 'M46-add-card-editor-surface',
    /**
     * 「添加模型提供商」add-card 里**复用的编辑器**被挂上自己的表面底色 ——
     * 也就是官方 `.addCard .editor{background:0 0;padding:0}`
     * （`.probe/models-css-pretty.txt:44`）明确要消掉的那一层。
     *
     * 病态：add-card 自己已经是 `bg-module-platform`，编辑器再挂同一层，视觉上就是
     * "卡里套卡"的两层底（用户第一时间会当成渲染 bug）。
     *
     * 期望由 `vendors.test.mjs` 的 **3.7** 抓住：那一条遍历
     * `[data-pxm-add-card] [data-pxm-editor]`，要求它**声明值里没有 background**，
     * 且计算底色不得等于 add-card 的底色。
     */
    bug: 'add-card 里的编辑器挂回自己的底色 `bg-module-platform`（"卡中卡"两层底），官方 `.addCard .editor{background:0 0}` 被破坏',
    expect: ['3.7 点虚线按钮'],
    edits: [
      {
        // 锚点 = add-card 里编辑器外层（`[data-pxm-add-editor]`）那份 style 的开头。
        // 该组合（类名 + data-pxm-add-editor + style gap）全文件唯一。
        find: [
          "            'data-pxm-add-editor': '1',",
          "            className: 'pxm-add-editor',",
          '            style: {',
          '              display:',
        ].join('\n'),
        replace: [
          "            'data-pxm-add-editor': '1',",
          "            className: 'pxm-add-editor',",
          '            style: {',
          '              background: T.bgModulePlatform,',
          '              display:',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'M47-add-on-select-posts',
    /**
     * 「添加模型提供商」的**保存**被短路：在下拉里**选中一家就立刻**发
     * `POST api/providers`，把"编辑器里填密钥 → 点保存"这一步整个跳过。
     *
     * 病态有两层：
     *   1. 用户只是想看看这一家的编辑器（选一下），请求已经发出去了 —— 配好一家厂商
     *      这种**有副作用**的动作不该发生在"浏览"上；
     *   2. 编辑器（API 密钥 / API 地址）形同虚设，用户填的值永远没机会进 body。
     *
     * 正确形态是：`onChange` 只换草稿（`props.onPick`），`POST` 只在「保存」那一下发生
     * （官方同样如此：选中只 `setEditing`，`.probe/models-client.js:2292-2297`）。
     *
     * 期望由 `vendors.test.mjs` 的 **3.7b** 抓住：那一条选一家厂商后先断"零 POST"，
     * 再点保存断"恰好 1 次、body 恰为 {catalogId, apiKey}"。
     */
    bug: '选中厂商就立刻发 POST api/providers（跳过编辑器与「保存」，浏览即写）',
    expect: ['3.7b 页内 add-card'],
    edits: [
      {
        // 锚点 = 那个 `<select>` 的 onChange（`props.onPick` 只在这里被调用，唯一）。
        find: "                  onChange: (event) => props.onPick(String(event.target.value)),",
        replace: [
          '                  onChange: (event) => {',
          '                    const id = String(event.target.value)',
          '                    props.onPick(id)',
          "                    apiPost('api/providers', { catalogId: id })",
          '                  },',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'M48-remove-one-step',
    /**
     * 「删除厂商」的**两步确认**退回一步直发。
     *
     * 正确形态：第一次点只把文案换成「确认删除」（一个请求都不发），第二次点才
     * `POST api/providers/<id>/delete`。把 `if (!confirmRemove) { … return }` 那段删掉，
     * 第一次点就会**立刻删掉一家厂商** —— 误点一下就没有第二次机会了。
     * 行尾那一枚的文案逐字用官方 `remove` = 「删除」（`.probe/models-client.js:2967`）。
     *
     * 期望由 `vendors.test.mjs` 的 **3.8** 抓住（真浏览器行为：第一次点零请求、
     * 第二次点恰好 1 次 POST）—— 这一条**不能**只靠 jsdom lane，因为
     * `tools/lane-mutations.mjs` 只跑 `test/browser/*`。
     */
    bug: '「删除厂商」的两步确认退回一步直发（第一次点就发 POST …/delete，误点即删）',
    expect: ['3.8 「删除」两步确认'],
    edits: [
      {
        // 锚点 = 「删除」按钮 onClick 里的两段式分支（`confirmRemove` 只在这里被置真，
        // 全文件唯一）。
        find: [
          '                  if (!confirmRemove) {',
          '                    setConfirmRemove(true)',
          '                    return',
          '                  }',
          '                  setConfirmRemove(false)',
        ].join('\n'),
        replace: '                  setConfirmRemove(false)',
      },
    ],
  },
]

function applyMutation(source, mutation) {
  let out = source
  mutation.edits.forEach((edit, index) => {
    const hits = out.split(edit.find).length - 1
    if (hits !== 1) {
      throw new Error(
        '变异 ' + mutation.id + ' 的第 ' + String(index + 1) + ' 处 find 命中 ' + String(hits) + ' 次（必须恰好 1 次）：\n' + edit.find,
      )
    }
    out = out.replace(edit.find, edit.replace)
  })
  if (out === source) throw new Error('变异 ' + mutation.id + ' 没有改变任何字节')
  return out
}

function runLane(clientFile) {
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', ...TEST_FILES],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, PXM_LANE_CLIENT: clientFile },
      encoding: 'utf8',
      timeout: 300000,
    },
  )
  const stdout = (result.stdout ?? '') + (result.stderr ?? '')
  const records = []
  let current = null
  let expectErrorValue = false
  stdout.split(/\r?\n/).forEach((raw) => {
    const line = raw.trim()
    const head = /^not ok \d+ - (.*)$/.exec(line)
    if (head !== null) {
      current = { name: head[1], error: null }
      records.push(current)
      expectErrorValue = false
      return
    }
    if (current === null) return
    if (/^error:/.test(line)) {
      const value = line.slice('error:'.length).trim()
      if (value === '' || value === '|-' || value === '|') {
        expectErrorValue = true
      } else {
        current.error = value.replace(/^['"]|['"]$/g, '')
        expectErrorValue = false
      }
      return
    }
    if (expectErrorValue && line !== '' && current.error === null) {
      current.error = line
      expectErrorValue = false
    }
  })
  const passed = Number((/# pass (\d+)/.exec(stdout) ?? [])[1] ?? NaN)
  const failedCount = Number((/# fail (\d+)/.exec(stdout) ?? [])[1] ?? NaN)
  return { status: result.status, records, passed, failedCount, stdout }
}

/**
 * `0. lane 自证` 在变异运行里**必然**失败（它断言"服务的就是仓库原产物"）。
 * 那不是断言的漏洞而是它该干的事，所以从"被抓住的用例"里剔除、单独记一笔。
 */
const SELF_PROOF = /自证|仓库原产物/

function partition(records) {
  const selfProof = records.filter((record) => SELF_PROOF.test(record.name))
  const rest = records.filter((record) => !SELF_PROOF.test(record.name))
  return { selfProof, rest }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

const filters = process.argv.slice(2)
const selected = MUTATIONS.filter(
  (mutation) => filters.length === 0 || filters.some((prefix) => mutation.id.startsWith(prefix)),
)
if (selected.length === 0) {
  console.error('没有匹配的变异 id；可用：' + MUTATIONS.map((m) => m.id).join(', '))
  process.exit(2)
}

const pristine = readFileSync(CLIENT)
const pristineSha = sha(pristine)

// 基线：原产物必须全绿（否则后面的"失败"就说不清是谁造成的）
console.log('基线：原产物 client.js（sha256 ' + pristineSha.slice(0, 12) + '）')
const baseline = runLane(CLIENT)
console.log(
  '  原产物：pass=' + String(baseline.passed) + ' fail=' + String(baseline.failedCount) +
    (baseline.records.length === 0 ? '（全绿）' : '（失败：' + baseline.records.map((r) => r.name).join(' | ') + '）'),
)
if (baseline.records.length !== 0) {
  console.error('基线不是全绿，变异验证没有意义。先修 lane。')
  process.exit(1)
}

const rows = []
let unexpected = 0
for (const mutation of selected) {
  const mutated = applyMutation(pristine.toString('utf8'), mutation)
  const file = path.join(tmpdir(), 'pxm-lane-mutation-' + mutation.id + '.js')
  writeFileSync(file, mutated, 'utf8')
  const run = runLane(file)
  const { selfProof, rest } = partition(run.records)
  const caught = mutation.expect.filter((fragment) =>
    rest.some((record) => record.name.indexOf(fragment) >= 0),
  )
  // `informational: true` 的变异**不参与**通过判定：它用来记录"这里其实测不到"的盲区。
  const ok = mutation.informational === true || (caught.length === mutation.expect.length && rest.length > 0)
  if (!ok) unexpected += 1
  rows.push({ mutation, run, rest, selfProof, caught, ok })
  console.log(
    (mutation.informational === true ? '○ ' : ok ? '✔ ' : '✖ ') +
      mutation.id +
      (mutation.informational === true ? '（信息性）' : '') +
      ' → 对应用例失败 ' +
      String(rest.length) +
      ' 条：' +
      (rest.length === 0 ? '（没有用例失败）' : rest.map((r) => r.name).join(' | ')) +
      (selfProof.length > 0 ? '（另有自证用例按预期失败：加载的不是原产物）' : ''),
  )
}

console.log('')
console.log('| 变异 | 改坏的实现 | 失败的用例（首条断言消息） | 预期命中 |')
console.log('|---|---|---|---|')
rows.forEach(({ mutation, rest, ok }) => {
  console.log(
    '| `' + mutation.id + '`' + (mutation.informational === true ? '（信息性）' : '') + ' | ' + mutation.bug + ' | ' +
      (rest.length === 0
        ? '**（无 → 断言太弱 / 测不到）**'
        : rest
            .map((r) => '`' + r.name + '`' + (r.error === null ? '' : '：' + r.error.replace(/\|/g, '\\|').slice(0, 200)))
            .join('<br>')) +
      ' | ' + (mutation.informational === true ? '—（信息性）' : ok ? '✔' : '✖ 未命中 ' + mutation.expect.join(' / ')) + ' |',
  )
})

const after = readFileSync(CLIENT)
if (sha(after) !== pristineSha) {
  console.error('client/client.js 被改动了！变异脚本必须只动临时副本。')
  process.exit(1)
}
const informative = rows.filter((row) => row.mutation.informational === true)
const strict = rows.filter((row) => row.mutation.informational !== true)
console.log('')
console.log('仓库原产物未被改动（sha256 ' + pristineSha.slice(0, 12) + ' 前后一致）。')
strict.forEach((row) => {
  console.log(
    '  ' + (row.ok ? '✔' : '✖') + ' ' + row.mutation.id + ' → 抓住它的用例：' +
      row.rest.map((r) => r.name).join(' / '),
  )
})
informative.forEach((row) => {
  console.log(
    '  ○ ' + row.mutation.id + '（信息性，不参与判定）→ ' +
      (row.rest.length === 0 ? '没有用例能抓住（已知盲区，写进 §13.7）' : '意外被抓住：' + row.rest.map((r) => r.name).join(' / ')),
  )
})
if (unexpected > 0) {
  console.error(String(unexpected) + ' 条变异没有让对应用例失败 —— 那些断言是空跑。')
  process.exit(1)
}
console.log(
  '严格变异 ' + String(strict.length) + ' 条全部被对应用例抓住；信息性变异 ' + String(informative.length) + ' 条（已知盲区，见 §13.7）。',
)
