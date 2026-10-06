/**
 * 客户端配色的**静态契约**：`client/client.js` 只允许走 DSH 官方主题 token（`--dsw-*`），
 * 源码里不得再出现任何写死的颜色。
 *
 * ## 为什么要有这一层（而不是只靠浏览器 lane）
 *
 * 浏览器 lane 能证明"某个元素的**计算样式**等于某个 token 的解析值"，但它只覆盖**被挂载的
 * 那几个组件**。配色是"全文件性质"的约束：只要有一处漏网（一个 `#ef4444`、一个系统色关键字、
 * 一个 `rgb()`），那个元素在深色主题下就会**一直不对**，而且不容易被注意到——因为别的断言
 * 都盯着别的地方。所以这里做一次**全文件扫描**，把"还有没有漏网的硬编码颜色"变成一条会红的用例。
 *
 * ## 判据（都是字面量扫描，不做语义推断）
 *
 * 1. 没有十六进制颜色字面量（3/4/6/8 位）；
 * 2. 没有 CSS 系统色关键字（`Canvas` / `Field` / `WindowText` …）——它们不跟随官方主题，
 *    正是"看起来能跑、但和官方深浅色不一致"的典型；
 * 3. 没有 `rgb()` / `rgba()` / `hsl()` / `hsla()` 写死的颜色；
 * 4. **没有** CSS 的「当前颜色」关键字：半透明色必须挂在 token 上
 *    （`color-mix(in srgb, var(--dsw-…) X%, transparent)`），否则颜色跟着最近一层的
 *    `color` 走，语义说不清、也拿不到"主题换了颜色就跟着换"这条可断言的事实；
 * 5. 前 4 条是**反向**的（不许有什么），这条是**正向**的：文件里必须**真的用到**官方 token，
 *    且下面清单里的每一个都要以 `var(<token>)` 的形态出现 —— 只写在注释里不算数。
 *
 * 第 4、5 条合起来堵掉"退化成硬编码也能过"的空子：删掉 token 第 5 条红，
 * 换回硬编码 hex 第 1 条红；浏览器 lane 里另有一层等价断言（`test/browser/theme.test.mjs`）。
 *
 * 分工：这里证明"源码里没有硬编码、且确实消费了 token"；那边证明"浏览器真的按 token 渲染、
 * 且深浅色会跟着变"。
 *
 * ## 为什么先剥注释
 *
 * 本文件的注释里**会提到**这些被禁的写法（"不许写死 `#abc`""不要用系统色关键字"），
 * 直接全文正则会把说明文字当成违规。所以先把字符串/注释状态机走一遍，只对**代码**做扫描；
 * 判据 5 的 token 计数也只看代码（注释里写十个 token 名字不算"用到了"）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT_PATH = join(REPO_ROOT, 'client', 'client.js')
const source = readFileSync(CLIENT_PATH, 'utf8')

/**
 * 本插件用到的那一份官方 token 清单（**颜色 + 尺寸两族**）。
 *
 * 色 token 的每个名字都由 client Theme 的 `listTokens` 确证存在，且**都带浅/深两套值**
 * （`requiresLightAndDark: true`）—— 这正是"配色能自动与官方主题一致"的前提。
 * 加/减 token 时要显式改这里，避免悄悄漂移。
 *
 * 清单**是 19 项**。历史沿革：
 *   - 早先版本误把「进行中/进度」映射到 `--dsw-alias-brand-primary`（那是主按钮填充色），
 *     换成官方的 `--dsw-alias-label-tertiary`（`StateDot` 的 `ongoing` 用的就是它），
 *     一进一出后仍不用 brand-primary（13 项）；
 *   - 2026-10-07 输入控件对齐官方（`docs/contract-notes.md` 19.5）再进三枚：
 *     `--dsw-alias-bg-layer-3`（官方设置页表单字段 `.input` 的底色）、
 *     `--dsw-alias-border-l4`（同一处的描边：`.input{border:.5px solid var(--dsw-alias-border-l4)}`），
 *     以及**保留**的 `--dsw-alias-border-l2`（输入控件不再用它，但按钮描边仍在用，
 *     所以它**不是**"只声明没引用"的僵尸键）。13 + 3 = 16。
 *   - 2026-10-08 组件尺寸对齐再进四枚 `--dsw-radius-{sm,md,lg,xl}`。
 *     它们与色 token **性质不同**：不随深浅色变（`listTokens` 里没有它们），
 *     是官方 base CSS 里 `:root` 的**尺寸变量**。仍然收进本清单，因为本文件真正守着的是
 *     "**代码里出现的 `--dsw-*` 种类 == 清单**"这条不漂移的性质，颜色只不过是目前最大的一族；
 *     下面另有一条用例钉住"半径不能混进 `T`（颜色表）"。
 *
 * 注意：`client/client.js` 里另有一份 `OFFICIAL_SURFACES` 清单（官方表面层的 token 名与
 * 官方用法，含本插件**尚未使用**的 `bg-module-platform`）。它是**合同文本**、
 * 不是取色来源，本文件因此**不**把它算进 `REQUIRED_TOKENS` ——
 * 这份清单只收"源码里真的画出来的那些 token 的 var(...)"，混进合同文本会让
 * 下面那条「代码里出现的 token 种类 == 清单」的断言失去意义。
 */
const REQUIRED_TOKENS = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  /*
   * 2026-10-11 厂商卡片复刻官方「模型」设置页时进的一枚：官方那一页的**编辑块**
   * （Base URL / API Key 那一段）底槽就是它 ——
   * `._3nPmjq_editor{background:var(--dsw-alias-bg-module-platform)}`
   * （`@deepseek-ai/dsh-client-ui-settings-models/lib/client.js:58`）。
   * 它与 `bg-layer-3` 深色同值（`#353638`）、**浅色不同值**（`#f5f6f7` vs `#fff`），
   * 所以不是"随便挑一层"，也不能用 `bg-layer-3` 顶替。
   */
  '--dsw-alias-bg-module-platform',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l4',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  /*
   * 2026-10-08 组件尺寸对齐再进四枚：**官方尺寸里唯一做成变量的那一族**
   * （`--dsw-radius-{xs,sm,md,lg,xl,panel}`，见 `dsh-client-ui-theme` 的 base CSS `:root{…}`）。
   * `client/client.js` 的圆角一律写 `var(--dsw-radius-*)`，于是官方改圆角时本插件自动跟随
   * ——与色 token 同理。它们**不在** `T` 那张表里（`T` 只收颜色），而在 `S`（尺寸表）里，
   * 所以本清单是"**T 的颜色 token ∪ S 的尺寸 token**"，与下面那条"代码里出现的 token 种类
   * == 清单"一一对应。
   * 2026-10-11 再进 `--dsw-radius-xs`：官方**厂商标头那一枚 rowTag** 的圆角就是它
   * （`._3nPmjq_rowTag{border-radius:var(--dsw-radius-xs)}`）——4px 与 `-sm` 的 8px
   * 在一枚 11px 小标签上是看得出来的差别，所以不复用 `-sm`。
   * `--dsw-radius-panel`（28px）官方有定义但本插件没用，故不在清单内。
   */
  '--dsw-radius-xs',
  '--dsw-radius-sm',
  '--dsw-radius-md',
  '--dsw-radius-lg',
  '--dsw-radius-xl',
]

/** 阈值：清单长度就是下界（每个 token 至少以 `var(...)` 出现一次）。 */
const MIN_TOKEN_MENTIONS = REQUIRED_TOKENS.length

/**
 * 逐字符走一遍源码，把注释丢掉、把字符串**原样保留**（颜色都藏在字符串里）。
 *
 * 不能简单地按行删 `//`：源码里有 `'https://api.example.com/v1'` 这种带 `//` 的字面量。
 */
function stripComments(text) {
  let out = ''
  let i = 0
  let quote = null
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (quote !== null) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') out += '\n'
        i += 1
      }
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

const code = stripComments(source)

/** 命中时把行号一并报出来，失败信息才能直接定位。 */
function linesMatching(text, re) {
  const probe = new RegExp(re.source, re.flags.replace('g', ''))
  const out = []
  text.split('\n').forEach((line, index) => {
    if (probe.test(line)) out.push(String(index + 1) + ': ' + line.trim())
  })
  return out
}

const HEX_COLOR = /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z])/g
/** 前面不允许是标识符字符：`color-mix(in srgb, …)` 里的 `srgb` 不算 `rgb()`。 */
const RGB_FUNC = /(?:^|[^-\w])(?:rgba?|hsla?)\s*\(/g
const CURRENT_COLOR = /currentColor/g
const SYSTEM_COLOR = /\b(?:Canvas|CanvasText|ButtonFace|ButtonText|ButtonBorder|WindowText|Window|Field|FieldText|Highlight|HighlightText|GrayText|AccentColor|LinkText|VisitedText|ActiveText|Mark|MarkText|InfoBackground|Scrollbar)\b/

/** 代码里所有单/双引号字面量的内容（系统色关键字只可能出现在这里）。 */
function quotedLiterals(text) {
  const out = []
  const re = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g
  let match
  while ((match = re.exec(text)) !== null) out.push(match[0])
  return out
}

/**
 * 从源码里**读出** token 表（`const T = { key: 'var(--dsw-…)' }`），而不是在测试里再抄一份。
 *
 * 抄一份的话，两边会各自漂移；读出来才能断言"表与清单一一对应"，并在某个键只声明、
 * 没被任何样式引用时（典型场景就是被换回硬编码）报出来。
 */
function tokenTable(text) {
  const at = text.indexOf('const T = {')
  if (at < 0) return null
  const end = text.indexOf('\n    }', at)
  if (end < 0) return null
  const body = text.slice(at, end)
  const entries = []
  const re = /([A-Za-z][A-Za-z0-9]*): 'var\((--dsw-[a-z0-9-]+)\)'/g
  let match
  while ((match = re.exec(body)) !== null) entries.push({ key: match[1], token: match[2] })
  return entries
}

describe('客户端配色：只走官方 --dsw-* token（静态契约）', () => {
  it('源码里没有任何十六进制颜色字面量', () => {
    const hits = linesMatching(code, HEX_COLOR)
    assert.deepEqual(hits, [], '配色必须走 --dsw-* token，不许写死十六进制色值：\n' + hits.join('\n'))
  })

  it('源码里没有 CSS 系统色关键字（Canvas / Field / WindowText …）', () => {
    const hits = quotedLiterals(code).filter((literal) => SYSTEM_COLOR.test(literal))
    assert.deepEqual(hits, [], '系统色关键字不跟随官方主题（深色下必然不一致）：' + hits.join(' | '))
  })

  it('源码里没有 rgb()/rgba()/hsl()/hsla() 写死的颜色', () => {
    const hits = linesMatching(code, RGB_FUNC)
    assert.deepEqual(
      hits,
      [],
      '不许用颜色函数写死颜色（半透明请用基于 token 的 color-mix）：\n' + hits.join('\n'),
    )
  })

  it('源码里没有「当前颜色」关键字：半透明色必须挂在 token 上', () => {
    const hits = linesMatching(code, CURRENT_COLOR)
    assert.deepEqual(
      hits,
      [],
      '半透明色要用 color-mix(in srgb, var(--dsw-…) X%, transparent)，不能用当前颜色凑：\n' +
        hits.join('\n'),
    )
  })

  it('真的用到了 --dsw-* token，次数不低于清单长度（阈值 ' + String(MIN_TOKEN_MENTIONS) + '）', () => {
    const mentions = code.match(/--dsw-[a-z0-9-]+/g) ?? []
    assert.ok(
      mentions.length >= MIN_TOKEN_MENTIONS,
      '代码里用到 --dsw-* 的次数是 ' +
        String(mentions.length) +
        '，低于阈值 ' +
        String(MIN_TOKEN_MENTIONS) +
        '：配色锚点被削弱了',
    )
    assert.equal(
      new Set(mentions).size,
      MIN_TOKEN_MENTIONS,
      '代码里出现的 token 种类与清单不一致：' + Array.from(new Set(mentions)).sort().join(', '),
    )
  })

  it('清单里的每个 token 都以 var(<token>) 的形态被真正消费（只写在注释里不算）', () => {
    const missing = REQUIRED_TOKENS.filter((token) => !code.includes('var(' + token + ')'))
    assert.deepEqual(missing, [], '这些 token 没有以 var(...) 的形态出现在样式里：' + missing.join(', '))
  })

  it('清单本身没有写错名字（命名合法、无重复）', () => {
    const bad = REQUIRED_TOKENS.filter((token) => !/^--dsw-[a-z0-9-]+$/.test(token))
    assert.deepEqual(bad, [], 'token 名不合法：' + bad.join(', '))
    assert.equal(new Set(REQUIRED_TOKENS).size, REQUIRED_TOKENS.length, 'token 清单里有重复项')
  })

  it('源码里的 token 表与清单一一对应，且每个 token 键都真的被样式引用过', () => {
    const table = tokenTable(code)
    assert.ok(table !== null, '源码里找不到 token 表 `const T = { … }`（结构变了就同步本用例）')

    /*
     * `T` 是**颜色表**，尺寸 token（`--dsw-radius-*`）在 `client.js` 的 `S` 里，
     * 所以这里比的是"颜色那一族"，而清单是"颜色 ∪ 尺寸"。
     */
    assert.deepEqual(
      table.map((entry) => entry.token).sort(),
      REQUIRED_TOKENS.filter((token) => !token.startsWith('--dsw-radius-')).sort(),
      'token 表里的颜色 token 与静态清单里的颜色项必须一一对应（加/换 token 时两边一起改）',
    )

    // 只声明、没被任何样式引用的键 = 那处样式要么漏了、要么被换回了硬编码。
    const unused = table
      .filter((entry) => (code.match(new RegExp('(?<![\\w$])T\\.' + entry.key + '\\b', 'g')) ?? []).length === 0)
      .map((entry) => entry.key)
    assert.deepEqual(
      unused,
      [],
      '这些 token 键只声明没被引用（某处样式可能退回成硬编码了）：' + unused.join(', '),
    )
  })

  /**
   * 颜色与尺寸的**分界**（2026-10-08 尺寸对齐引入）：
   *   - 色 token 进 `T`、尺寸 token 进 `S`，两族不混；
   *   - 尺寸 token 也必须以 `var(...)` 的形态真的被消费（只写常量名不算）。
   *
   * 为什么值得一条用例：把 `--dsw-radius-md` 顺手塞进 `T` 是"看起来更整齐"的做法，
   * 但那会让"`T` 里每一项都随主题深浅色变"这条隐含前提失效（半径不随主题变），
   * 也会让 `theme.test.mjs` 那份颜色对照清单失去意义。这里把它钉住。
   */
  it('颜色表 T 里不含尺寸 token；四个圆角 token 都以 var(...) 形态被消费', () => {
    const table = tokenTable(code)
    assert.ok(table !== null, '源码里找不到 token 表 `const T = { … }`')

    const colorOnly = table
      .filter((entry) => !entry.token.startsWith('--dsw-alias-'))
      .map((entry) => entry.key + ' → ' + entry.token)
    assert.deepEqual(colorOnly, [], '颜色表 T 里混进了非颜色 token：' + colorOnly.join(', '))

    const radiusTokens = [
      '--dsw-radius-xs',
      '--dsw-radius-sm',
      '--dsw-radius-md',
      '--dsw-radius-lg',
      '--dsw-radius-xl',
    ]
    const notConsumed = radiusTokens.filter((token) => !code.includes('var(' + token + ')'))
    assert.deepEqual(
      notConsumed,
      [],
      '这些官方尺寸变量没有以 var(...) 的形态出现在样式里（圆角退回硬编码了？）：' + notConsumed.join(', '),
    )
  })

  /**
   * 语义锚点：「进行中 / 正在跑 / 进度」= `label-tertiary`，**不是** `brand-primary`。
   *
   * 为什么需要它（而且不能只靠上面那条"键被引用过"）：`brand-primary` 是官方**主按钮填充**色
   * （浅色 `#0f1115`、深色 `#f9fafb`），把它挂到进行中上，浅色主题下会呈现近黑色——看起来像
   * 一枚按钮而不是状态点。官方 `StateDot` 的 `ongoing` 用的是 `--dsw-alias-label-tertiary`
   * （`StateDot.module.css` 的 `.spinner`），这里把**同一处语义**钉在源码上：
   * 「进行中/进度」的载体（状态色映射 `COLORS.run` → 运行中缩略图边框 + 它的进度环）
   * 以及同一枚 token 的另两处用途（选中态描边 / focus ring），一旦换回 `brand-primary`
   * 或硬编码 hex，本用例直接变红。
   */
  it('「进行中 / 进度」用的是 label-tertiary，不是主按钮填充色 brand-primary', () => {
    const table = tokenTable(code)
    assert.ok(table !== null, '源码里找不到 token 表 `const T = { … }`（结构变了就同步本用例）')

    const tokens = Object.fromEntries(table.map((entry) => [entry.key, entry.token]))
    assert.equal(
      tokens.labelTertiary,
      '--dsw-alias-label-tertiary',
      'token 表里必须有 labelTertiary → --dsw-alias-label-tertiary',
    )

    // 「进行中/进度」的载体各自断言（不是只查全文件的"没出现过 brand"，
    // 那样一处漏改、别处仍有引用时会被放过）。
    const COLORS_LINE = 'const COLORS = { ok: T.success, fail: T.error, run: T.'
    const runColor = new RegExp(COLORS_LINE + '([A-Za-z]+), track: T\\.idle \\}').exec(code)
    assert.ok(runColor !== null, '找不到状态色映射 `const COLORS = { … }`（结构变了就同步本用例）')
    assert.equal(
      runColor[1],
      'labelTertiary',
      '「进行中」的状态色必须映射到 labelTertiary（换成 brand 就是"进度点长得像主按钮"）',
    )

    const chipBorder = /status === 'running' \? COLORS\.([A-Za-z]+)/.exec(code)
    assert.ok(chipBorder !== null, '找不到运行中缩略图的边框色表达式（结构变了就同步本用例）')
    assert.equal(chipBorder[1], 'run', '运行中缩略图边框必须走 COLORS.run')

    const runningRing = /'conic-gradient\(' \+ COLORS\.([A-Za-z]+) \+ ' 0deg '/.exec(code)
    assert.ok(runningRing !== null, '找不到运行中的进度环表达式（结构变了就同步本用例）')
    assert.equal(runningRing[1], 'run', '运行中的进度环必须走 COLORS.run')

    const tileSelected = /border: selected \? '1px solid ' \+ T\.([A-Za-z]+)/.exec(code)
    assert.ok(tileSelected !== null, '找不到选中态描边表达式（结构变了就同步本用例）')
    assert.equal(tileSelected[1], 'labelTertiary', '选中态描边必须走 labelTertiary')

    const focusRing = /\.pxm-badge:focus-visible,\.pxm-thumb:focus-visible\{outline:2px solid ' \+\s*\n?\s*T\.([A-Za-z]+)/.exec(code)
    assert.ok(focusRing !== null, '找不到 focus ring 表达式（结构变了就同步本用例）')
    assert.equal(focusRing[1], 'labelTertiary', 'focus ring 必须走 labelTertiary')
  })
})
