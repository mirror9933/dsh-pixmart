/**
 * 打包步骤的守卫测试：`dist/client.js`（剥离 `__test__` 的产物）必须存在且**不陈旧**。
 *
 * ## 这里在守什么
 *
 * `client/client.js` 是手写产物、没有传统构建步骤，因此"忘了重新构建"是**最可能**
 * 的翻车方式：源码改了、`dist/` 还停在旧字节，而打包/发布拿走的正是 `dist/`。
 * 所以本文件的核心不是"产物里没有 `__test__`"（那是剥离脚本自己就该保证的），
 * 而是**陈旧性守卫**：把当前 `client/client.js` 现场剥一遍，逐字节比对 `dist/client.js`。
 *
 * ## 为什么不从 `client/client.js` 里删 `__test__`
 *
 * 五套 node:test + 浏览器 lane 全都从 bundle 的 `__test__` 里取组件（见
 * `tools/lane-mutations.mjs` 与 `test/client-*.test.mjs`）。删源码等于一次性打断所有测试，
 * 也就无法验证"剥离"本身。**源码保留，打包时产出剥离版** —— 见 §12.2 P4 待办第 1 条。
 *
 * ## 两种情形
 *
 * - `dist/client.js` **不存在**（干净 checkout、且没跑构建）→ **跳过**（带原因），
 *   不假装通过、也不以"文件不存在"这种原始错误炸掉整轮。
 * - `dist/client.js` **存在但与当前源码不一致** → **失败**，并提示跑 `pnpm build:client`。
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DIST_PATH,
  SOURCE_PATH,
  StripError,
  stripTestHooks,
} from '../tools/strip-test-hooks.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

const source = readFileSync(SOURCE_PATH, 'utf8')
const distExists = existsSync(DIST_PATH)
const dist = distExists ? readFileSync(DIST_PATH, 'utf8') : null
const rebuilt = stripTestHooks(source).output

/** 缺失时的统一提示：既说明为什么跳过，也说明怎么让它真的跑起来。 */
const MISSING_HINT =
  'dist/client.js 不存在（干净 checkout，或还没跑过构建）——跳过。' +
  '要让它参与校验，先跑 `pnpm build:client`（`pnpm test` 的 pretest 会自动跑）。'

describe('打包步骤：client bundle 的 __test__ 剥离', () => {
  it('源码仍带 __test__ 测试钩子（剥离的前提，删源码是错的）', () => {
    assert.ok(
      source.includes('const __test__ = {'),
      'client/client.js 里没有 __test__ 对象了：五套 node:test 与浏览器 lane 都靠它取组件，' +
        '删除源码会同时打断全部测试。剥离应当只发生在打包步骤。',
    )
    assert.ok(source.includes('return { name, inject, apply, __test__ }'))
  })

  it('剥离是确定的：同一个源码剥两次，字节完全一致', () => {
    assert.equal(stripTestHooks(source).output, rebuilt)
  })

  it('剥离产物不含 __test__', (t) => {
    if (!distExists) return t.skip(MISSING_HINT)
    assert.ok(!dist.includes('__test__'), 'dist/client.js 里仍有 __test__：剥离没生效')
  })

  it('剥离产物能被 node --check 解析', (t) => {
    if (!distExists) return t.skip(MISSING_HINT)
    const result = spawnSync(process.execPath, ['--check', DIST_PATH], { encoding: 'utf8' })
    assert.equal(
      result.status,
      0,
      `node --check 失败：\n${result.stderr || result.stdout || String(result.error)}`,
    )
  })

  it('剥离产物里 name / inject / apply 仍然齐全（生产契约没被破坏）', (t) => {
    if (!distExists) return t.skip(MISSING_HINT)
    for (const token of ['const name = PLUGIN', "const inject = ['slots']", 'function apply(ctx)']) {
      assert.ok(dist.includes(token), `产物缺少「${token}」`)
    }
    assert.ok(dist.includes('return { name, inject, apply }'), '产物缺少生产版 return')
    assert.ok(dist.includes('__ModuleLoader__'), '产物缺少 __ModuleLoader__ 装载包装')
  })

  it('★ 陈旧性守卫：dist/client.js 必须等于当前源码剥出来的字节', (t) => {
    if (!distExists) return t.skip(MISSING_HINT)
    if (dist === rebuilt) return

    // 找第一处差异行，给一条能直接定位的提示
    const a = dist.split('\n')
    const b = rebuilt.split('\n')
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1
    assert.fail(
      'dist/client.js 与当前 client/client.js 不一致（忘了重新构建）：' +
        `第一个不同的位置在第 ${i + 1} 行附近\n` +
        `  dist : ${JSON.stringify(a[i] ?? '(文件结束)')}\n` +
        `  期望 : ${JSON.stringify(b[i] ?? '(文件结束)')}\n` +
        '  → 跑 `pnpm build:client` 重新生成产物。',
    )
  })

  it('剥离脚本拒绝结构对不上的源码（不"尽力而为"地改一刀）', () => {
    // 少了锚点 → 必须报错，而不是输出一份悄悄改坏了的产物
    assert.throws(() => stripTestHooks(source.replace('测试入口（jsdom lane 专用）', '入口变了')), StripError)
    // 少了 return 那一行 → 同样必须报错
    assert.throws(
      () => stripTestHooks(source.replace('    return { name, inject, apply, __test__ }', '    return null')),
      StripError,
    )
    // 没有 __test__（已经剥过）→ 明确报错，不产出空产物
    assert.throws(() => stripTestHooks(rebuilt), StripError)
  })
})

describe('打包脚本的 CLI 形态（package.json 里挂的那些钩子）', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'pixmart-strip-'))
  after(() => rmSync(scratch, { recursive: true, force: true }))

  it('`node tools/strip-test-hooks.mjs` 能在一个干净副本里产出 dist/client.js', () => {
    // 在临时目录里复刻最小仓库结构：这一步验的是"脚本作为命令跑得通"，
    // 顺带把 package.json 里 build:client / pretest / prepack 指向的那条命令钉住。
    cpSync(join(REPO_ROOT, 'tools'), join(scratch, 'tools'), { recursive: true })
    cpSync(join(REPO_ROOT, 'client'), join(scratch, 'client'), { recursive: true })

    const script = join(scratch, 'tools', 'strip-test-hooks.mjs')
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', cwd: scratch })
    assert.equal(result.status, 0, `脚本退出码非 0：\n${result.stderr}`)

    const produced = readFileSync(join(scratch, 'dist', 'client.js'), 'utf8')
    assert.ok(!produced.includes('__test__'))
    assert.equal(produced, rebuilt, '临时副本里产出的字节应与仓库内一致（剥离是纯函数）')
  })

  it('源码被改坏时脚本以非零码退出，并留下可读原因', () => {
    cpSync(join(REPO_ROOT, 'tools'), join(scratch, 'broken-tools'), { recursive: true })
    // 把 client 换成一份没有 __test__ 的内容
    const brokenDir = join(scratch, 'broken-client')
    cpSync(join(REPO_ROOT, 'client'), brokenDir, { recursive: true })
    writeFileSync(join(brokenDir, 'client.js'), rebuilt, 'utf8')

    const scriptText = readFileSync(join(scratch, 'broken-tools', 'strip-test-hooks.mjs'), 'utf8')
      .replace("'client', 'client.js'", "'broken-client', 'client.js'")
    writeFileSync(join(scratch, 'broken-tools', 'strip-test-hooks.mjs'), scriptText, 'utf8')

    const result = spawnSync(
      process.execPath,
      [join(scratch, 'broken-tools', 'strip-test-hooks.mjs')],
      { encoding: 'utf8', cwd: scratch },
    )
    assert.notEqual(result.status, 0, '结构对不上时必须失败，不能静默产出')
    assert.match(result.stderr, /剥离失败/)
  })
})
