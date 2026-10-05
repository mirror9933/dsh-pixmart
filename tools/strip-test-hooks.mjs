/**
 * 打包步骤：从 client bundle 里**剥离 `__test__` 测试钩子**，产出 `dist/client.js`。
 *
 * ## 为什么需要它
 *
 * `client/client.js` 是手写产物、没有构建阶段，jsdom lane 需要从 bundle 里取出组件与
 * 状态机内部件，所以 `factory` 返回值上多挂了一个 `__test__`。宿主只读
 * `name` / `inject` / `apply`（见 `client/client.js` 里那段注释），多一个键对宿主无害，
 * 但**生产包不该带测试入口**（P4 待办第 1 条，来源提交 `3ec6cd2`）。
 *
 * ## 为什么不删源码里的 `__test__`
 *
 * 五套 node:test + 浏览器 lane **全都**从 bundle 的 `__test__` 里取组件。删源码等于一次性
 * 打断所有测试，也就无法验证"剥离"本身。因此：**源码保留，打包时产出剥离版**。
 *
 * ## 剥离后的 exports 指向（重要）
 *
 * `package.json` 的 `exports["./client"]` **仍然指向 `./client/client.js`**，没有切到
 * `dist/client.js`。原因：开发期 profile 是指向本仓库的 symlink，`client.js` 还在频繁改；
 * 一旦切到 `dist/`，刷新页面看到的是**过期产物**，比现状更容易误判。
 * 切换 exports 是 P4 打包的**最后一步**，等停止迭代后再做
 * （见 docs/dsh-pixmart-技术方案.md §11.5 / §12.2）。
 *
 * ## 它保证"只改了该改的"
 *
 * 1. **按锚点定位**，不靠正则猜：找到唯一锚句 → 回退到它的 JSDoc 起始行 →
 *    找到 `const __test__ = {` → 花括号配平找到对象结尾 → 断言下一行正是
 *    `return { name, inject, apply, __test__ }`。任何一步对不上就**直接报错退出**，
 *    绝不"尽力而为"地改一刀。
 * 2. **逐行比对自证**：产物的第 0..a-1 行、最后 b 行必须与源码**逐字节相同**，
 *    差异区间必须完全落在被删块的行号范围内；且该区间在产物里**恰好等于**新的
 *    `return { name, inject, apply }`。行数账也要对得上。
 * 3. 产物产物里不得出现 `__test__`；且必须能被 `node --check` 解析。
 *
 * 脚本直接 `node tools/strip-test-hooks.mjs` 运行，**不引入任何打包器**。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(HERE, '..')
export const SOURCE_PATH = join(REPO_ROOT, 'client', 'client.js')
export const DIST_PATH = join(REPO_ROOT, 'dist', 'client.js')

/** 被删块的唯一锚句：它的 JSDoc 第一行。 */
const ANCHOR = '测试入口（jsdom lane 专用）'
/** 被删块结束后的那一行（要替换成不带 `__test__` 的版本）。 */
const RETURN_WITH_HOOKS = '    return { name, inject, apply, __test__ }'
/** 替换后的那一行。 */
const RETURN_PROD = '    return { name, inject, apply }'

/** 剥离失败（锚点/结构对不上）时抛这个，消息面向"改坏了 client.js"的人。 */
export class StripError extends Error {}

/**
 * 从 `const __test__ = {` 所在行起做花括号配平，返回对象结尾所在行号。
 *
 * 跳过字符串与注释里的花括号——块内目前没有，但将来加了也不能算错。
 */
function findObjectEnd(lines, start) {
  let depth = 0
  let seenOpen = false

  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]
    let inString = null
    let inBlockComment = false

    for (let j = 0; j < line.length; j += 1) {
      const ch = line[j]
      const next = line[j + 1]

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false
          j += 1
        }
        continue
      }
      if (inString !== null) {
        if (ch === '\\') {
          j += 1
          continue
        }
        if (ch === inString) inString = null
        continue
      }
      if (ch === '/' && next === '/') break
      if (ch === '/' && next === '*') {
        inBlockComment = true
        j += 1
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        inString = ch
        continue
      }
      if (ch === '{') {
        depth += 1
        seenOpen = true
        continue
      }
      if (ch === '}') {
        depth -= 1
        if (seenOpen && depth === 0) return i
        if (depth < 0) {
          throw new StripError(
            `第 ${i + 1} 行出现多余的 '}'：__test__ 对象没有正常闭合，拒绝剥离`,
          )
        }
      }
    }
  }

  throw new StripError('__test__ 对象没有闭合的 ' + "'}'" + '，拒绝剥离')
}

/**
 * 对一段源码文本做剥离，返回产物文本与自证信息（**纯函数，不碰磁盘**）。
 *
 * 测试直接 import 这个函数来验"当前源码剥离后应得的产物"，因此它必须是纯的。
 * @param {string} source - `client/client.js` 的文本内容。
 */
export function stripTestHooks(source) {
  if (!source.endsWith('\n')) {
    throw new StripError('源码末尾没有换行——按行处理会丢字节，拒绝剥离')
  }
  if (source.includes('\r\n') || source.includes('\r')) {
    throw new StripError(
      '源码含 CR（CRLF）：本脚本按 LF 逐行处理并保证逐字节不变，换行风格变了就拒绝剥离，' +
        '以免静默改写整个文件的换行',
    )
  }
  if (!source.includes('__test__')) {
    throw new StripError('源码里找不到 __test__：是不是已经剥离过了？')
  }

  const lines = source.split('\n')
  const anchorLine = lines.findIndex((line) => line.includes(ANCHOR))
  if (anchorLine < 0) {
    throw new StripError(`找不到锚句「${ANCHOR}」：__test__ 块的结构变了，请同步本脚本`)
  }
  if (lines.filter((line) => line.includes(ANCHOR)).length !== 1) {
    throw new StripError(`锚句「${ANCHOR}」出现多次，无法唯一定位，拒绝剥离`)
  }

  // 回退到 JSDoc 起始行 `/**`
  let docStart = -1
  for (let i = anchorLine; i >= 0 && anchorLine - i < 40; i -= 1) {
    if (lines[i].trim() === '/**') {
      docStart = i
      break
    }
  }
  if (docStart < 0) {
    throw new StripError('锚句上方找不到 JSDoc 起始 `/**`，拒绝剥离')
  }

  // JSDoc 结束行
  let docEnd = -1
  for (let i = anchorLine; i < lines.length && i - anchorLine < 40; i += 1) {
    if (lines[i].trim() === '*/') {
      docEnd = i
      break
    }
  }
  if (docEnd < 0) {
    throw new StripError('锚句下方找不到 JSDoc 结束 `*/`，拒绝剥离')
  }

  // const __test__ = {
  const declLine = docEnd + 1
  if (!/^\s*const __test__ = \{\s*$/.test(lines[declLine] ?? '')) {
    throw new StripError(
      `第 ${declLine + 1} 行不是 'const __test__ = {'（实际：${JSON.stringify(lines[declLine])}），拒绝剥离`,
    )
  }

  const objEnd = findObjectEnd(lines, declLine)

  // 对象结尾之后（可能隔一个空行）必须紧跟那一行 return。
  // 空行一并算进被删块，产物的 return 才会落在原来的缩进层级上。
  let returnLine = objEnd + 1
  while (returnLine < lines.length && lines[returnLine].trim() === '') returnLine += 1
  if (lines[returnLine] !== RETURN_WITH_HOOKS) {
    throw new StripError(
      `第 ${returnLine + 1} 行不是 ${JSON.stringify(RETURN_WITH_HOOKS)}（实际：${JSON.stringify(lines[returnLine])}），拒绝剥离`,
    )
  }

  // 被删块的"整行"范围：JSDoc 起始行 .. 对象结尾行（含中间空行）与 return 行
  const blockStart = docStart
  const blockEnd = returnLine

  const before = lines.slice(0, blockStart)
  const after = lines.slice(blockEnd + 1)
  const output = before.concat([RETURN_PROD], after).join('\n')

  runSelfChecks({ source, output, lines, blockStart, blockEnd, returnLine })

  return {
    output,
    /** 源码中被删除的整行区间（1-based，闭区间）。 */
    removedLines: { from: blockStart + 1, to: blockEnd + 1 },
    /** 源码中被改写的那一行（1-based）。 */
    rewrittenLine: returnLine + 1,
    removedLineCount: blockEnd - blockStart + 1,
  }
}

/** 剥离产物的自带断言：只改了该改的、契约还在、产物干净。 */
function runSelfChecks({ source, output, lines, blockStart, blockEnd, returnLine }) {
  const outLines = output.split('\n')
  const removedCount = blockEnd - blockStart + 1
  // 注意：源码以换行结尾，`split('\n')` 的元素数 = 逻辑行数 + 1（最后一个是空串）。
  // 产物的尾部空串由 `after` 的末元素带过来，所以元素数账是
  // `blockStart（前缀） + 1（新 return 行） + suffixCount`。
  const suffixCount = lines.length - blockEnd - 1
  const expectedOutElements = blockStart + 1 + suffixCount

  // ①a 前缀逐行相同（第 1..blockStart 行）
  for (let i = 0; i < blockStart; i += 1) {
    if (lines[i] !== outLines[i]) {
      throw new StripError(`自证失败：第 ${i + 1} 行在产物里被改动了（该块之外不允许有任何差异）`)
    }
  }
  // ①b 唯一的改写位置恰好是生产版 return
  if (outLines[blockStart] !== RETURN_PROD) {
    throw new StripError(
      `自证失败：产物第 ${blockStart + 1} 行不是 ${JSON.stringify(RETURN_PROD)}，而是 ${JSON.stringify(outLines[blockStart])}`,
    )
  }
  // ①c 后缀逐行相同（删掉块之后必须逐字节对齐到文件末尾）
  for (let k = 0; k < suffixCount; k += 1) {
    const s = lines[blockEnd + 1 + k]
    const o = outLines[blockStart + 1 + k]
    if (s !== o) {
      throw new StripError(
        `自证失败：源码第 ${blockEnd + 2 + k} 行与产物第 ${blockStart + 2 + k} 行不一致（该块之外不允许有任何差异）`,
      )
    }
  }
  // ①d 行数账
  if (outLines.length !== expectedOutElements) {
    throw new StripError(
      `自证失败：产物 ${outLines.length} 个行元素，预期 ${expectedOutElements} 个（源码 ${lines.length} 个，删 ${removedCount} 行）`,
    )
  }
  // ①e 差异区间必须落在按锚点定位出来的块内
  if (blockStart < 0 || returnLine >= lines.length - 1 || blockStart > returnLine) {
    throw new StripError('自证失败：差异区间越界')
  }
  if (!lines.slice(blockStart, blockEnd + 1).some((line) => line.includes('__test__'))) {
    throw new StripError('自证失败：被删区间里一行 __test__ 都没有，锚点定位错了')
  }

  // ② 产物不含测试钩子
  if (output.includes('__test__')) {
    throw new StripError('自证失败：产物里仍含 __test__')
  }

  // ③ 生产契约未被破坏（宿主只读 name / inject / apply 三个键）
  for (const token of ['const name = PLUGIN', "const inject = ['slots']", 'function apply(ctx)']) {
    if (!output.includes(token)) {
      throw new StripError(`自证失败：产物缺少「${token}」`)
    }
  }
  if (!output.includes(RETURN_PROD)) {
    throw new StripError('自证失败：产物缺少生产版 return')
  }
  if (!/__ModuleLoader__/.test(output)) {
    throw new StripError('自证失败：产物缺少 __ModuleLoader__ 装载包装')
  }

  // ④ 字节账：产物必须比源码短，且短的幅度正好落在"删掉该块"的量级上。
  // 用 UTF-8 字节数（该块里有中文注释，字符数 ≠ 字节数）。
  const bytes = (text) => Buffer.byteLength(text, 'utf8')
  const blockBytes = bytes(lines.slice(blockStart, blockEnd + 1).join('\n')) + 1 /* return 行末尾的 \n */
  const srcBytes = bytes(source)
  const outBytes = bytes(output)
  const byteDelta = srcBytes - outBytes
  const lo = blockBytes - bytes(RETURN_WITH_HOOKS)
  const hi = blockBytes + bytes(RETURN_PROD)
  if (byteDelta < lo || byteDelta > hi) {
    throw new StripError(
      `自证失败：产物比源码少 ${byteDelta} 字节，超出按行账的合理区间 [${lo}, ${hi}]`,
    )
  }
}

/** 写文件后跑 `node --check`，产物解析不过就算剥离失败。 */
function assertParses(filePath) {
  const result = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new StripError(
      `产物无法通过 node --check：\n${result.stderr || result.stdout || String(result.error)}`,
    )
  }
}

/** 主流程：读源码 → 剥离 → 写 `dist/client.js` → 自检 → `node --check`。 */
export function build() {
  const source = readFileSync(SOURCE_PATH, 'utf8')
  const { output, removedLines, rewrittenLine, removedLineCount } = stripTestHooks(source)

  mkdirSync(dirname(DIST_PATH), { recursive: true })
  writeFileSync(DIST_PATH, output, 'utf8')

  assertParses(DIST_PATH)

  const onDisk = readFileSync(DIST_PATH, 'utf8')
  if (onDisk !== output) {
    throw new StripError('自证失败：写盘后的字节与预期不一致')
  }

  return { source, output, removedLines, rewrittenLine, removedLineCount }
}

const isEntry =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isEntry) {
  try {
    const info = build()
    process.stdout.write(
      [
        'dsh-pixmart: 已剥离 client bundle 的 __test__ 测试钩子',
        `  源码  ${SOURCE_PATH}`,
        `  产物  ${DIST_PATH}`,
        `  删除  ${info.removedLineCount} 行（第 ${info.removedLines.from}–${info.removedLines.to} 行）`,
        `  改写  第 ${info.rewrittenLine} 行 → ${RETURN_PROD.trim()}`,
        `  体积  ${Buffer.byteLength(info.source)} → ${Buffer.byteLength(info.output)} 字节`,
        '  自证  差异仅限该块 / 产物无 __test__ / node --check 通过',
        '',
      ].join('\n'),
    )
  } catch (error) {
    process.stderr.write(
      `${error instanceof StripError ? '剥离失败' : '剥离异常'}：${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}
