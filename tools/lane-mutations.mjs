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
 * 两条 lane 各有分工：`layout.test.mjs` 管几何（滚不动 / 顶栏被盖 / 横向溢出 …），
 * `theme.test.mjs` 管配色（计算样式是否等于官方 `--dsw-*` 的解析值、深浅色是否跟随）。
 * 变异只让**对应用例**变红，所以两边都要跑：几何变异不该惊动配色用例，反之亦然。
 */
const TEST_FILES = ['test/browser/layout.test.mjs', 'test/browser/theme.test.mjs']

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
        find: "        background: T.bgLayer1,\n        color: T.label,",
        replace: "        background: '#f4f4f5',\n        color: T.label,",
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
