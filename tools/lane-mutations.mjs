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
 * 三条 lane 各有分工：`layout.test.mjs` 管几何（滚不动 / 顶栏被盖 / 横向溢出 …），
 * `theme.test.mjs` 管配色（计算样式是否等于官方 `--dsw-*` 的解析值、深浅色是否跟随），
 * `sizes.test.mjs` 管**控件尺寸**（高度 / 内边距 / 字号 / 行高 / 圆角是否等于官方同语义值）。
 * 变异只让**对应用例**变红，所以三个都要跑：几何变异不该惊动配色与尺寸用例，反之亦然。
 */
const TEST_FILES = [
  'test/browser/layout.test.mjs',
  'test/browser/theme.test.mjs',
  'test/browser/sizes.test.mjs',
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
    bug: '设置页 Field 去掉 flexDirection:column —— 标签与它的值并排（bug 1 的另一形态）',
    expect: ['「默认值」卡片'],
    edits: [
      {
        find: "            flexDirection: 'column',\n            gap: '3px',\n            fontSize: '12px',\n            flex: '1 1 180px',",
        replace: "            gap: '3px',\n            fontSize: '12px',\n            flex: '1 1 180px',",
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
     * 输入控件侧的变异（19.5 的缺陷形态）：把 `inputStyle` 的底色从**官方表单控件那一层**
     * `--dsw-alias-bg-layer-3` 退回 `--dsw-alias-bg-base`（**应用最底层**，深色 `#151517`）。
     *
     * 这正是用户肉眼确认的那处偏差：`TextInput` / `Select` 共用 `inputStyle`，嵌在设置面板
     * （`bg-layer-2`，深色 `#2c2c2e`）里却比面板本身还暗一层，观感是"输入框塌进去了"。
     * 官方设置页的表单控件（`primitives` 的 `settings-form/fields.module.css` 的 `.input`，
     * `SettingsValueField` 与 `SettingsSecretField` **同一个类**）用的是 `bg-layer-3`。
     *
     * 预期被 **8.9** 抓住：判据是"最近色必须命中 `bg-layer-3`"，所以变异体报的是
     * 「底色是 bg-base —— 那是误差形态」，而不是笼统的"颜色不等"。注意 8.9 只在**深色**
     * 那一次判"等于哪一层"（浅色下官方四层表面都是 `#fff`，写哪层都同色），与 8.8 同纪律。
     *
     * 注：变异体只把**内联样式**退回 bg-base，`T.bgLayer3` 键仍在（仍被 textarea 引用），
     * 所以变异产物照样能跑起来 —— 这是"被断言抓住"而不是"崩了"的前提。
     */
    bug: '输入控件底色从官方表单控件那一层 bg-layer-3 退回应用最底层 bg-base（深色下比设置面板还暗，"输入框塌进去"）',
    expect: ['8.9 input / password / select 的底色与描边逐个等于官方解析值'],
    edits: [
      {
        // 锚点：`inputStyle` 里 `background: T.bgLayer3` 与紧随其后的边框注释一起出现，
        // 在文件里**只此一处**（textarea 那处的 bg 行紧跟 `color: T.label,`，不匹配）。
        find: '      background: T.bgLayer3,\n      // 边框同样照抄官方表单控件那一处',
        replace: '      background: T.bgBase,\n      // 边框同样照抄官方表单控件那一处',
      },
    ],
  },
  {
    id: 'M21-input-surface-is-bg-layer-2',
    /**
     * 输入控件侧的第二形态：把 `inputStyle` 的底色退回**设置面板自己那一层**
     * `--dsw-alias-bg-layer-2`。
     *
     * 这一条的存在意义是证明 8.9 里那句"**不等于** `bg-layer-2`"**不是空转**：
     * `bg-layer-2` 与 `bg-layer-3` 只差一档（深色 `#2c2c2e` vs `#353638`），肉眼几乎看不出，
     * 但"输入框与它所在的卡片同色"就意味着控件边界只剩一根描边 —— 官方不是这么画的
     * （官方表单控件比它所在的设置面板**亮一档**）。若删掉那条 notEqual，这条变异就不会红。
     */
    bug: '输入控件底色退回设置面板那一层 bg-layer-2（与卡片同色，控件只剩描边、看不出是输入面）',
    expect: ['8.9 input / password / select 的底色与描边逐个等于官方解析值'],
    edits: [
      {
        find: '      background: T.bgLayer3,\n      // 边框同样照抄官方表单控件那一处',
        replace: '      background: T.bgLayer2,\n      // 边框同样照抄官方表单控件那一处',
      },
    ],
  },
  {
    id: 'M22-input-height-old',
    /**
     * 尺寸对齐（2026-10-08）的第一形态：把表单值控件的高度退回**改造前**的 28px。
     *
     * 官方是 34px（`fields.module.css:108` 的 `.input{height:34px}`）。这一条证的是
     * `sizes.test.mjs` 的 1.1 / 2.1 **不是空转**：高度写错时那两条必须红。
     * 改的是 `S.fieldHeight`（唯一的取值来源），所以设置页与作品库的搜索框会**同时**错。
     */
    bug: '输入控件高度从官方的 34px 退回改造前的 28px（S.fieldHeight）',
    expect: ['1.1 输入框 / 下拉 = 官方设置页表单控件', '2.1 工具条按钮'],
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
        find: "        borderRadius: S.radiusLg,",
        replace: "        borderRadius: '10px',",
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
