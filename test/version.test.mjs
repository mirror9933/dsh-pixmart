/**
 * 版本号一致性 —— **机器检查，不靠"手工同步"**。
 *
 * 背景：插件版本在三处独立存在 —— `package.json`（npm 包）、`src/version.ts`（宿主侧，
 * 注释原本写着"与 package.json 保持一致（P0 手工同步）"）、`client/client.js`（设置页头部
 * 渲染 `dsh-pixmart@<VERSION>`）。2026-10-12 只改了 package.json 发版，另两处留在 0.0.1，
 * 用户看到设置页头部还是旧版本 —— 这条断言就是那次漂移的产物。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))
const srcVersion = /export const VERSION = '([^']+)'/.exec(read('../src/version.ts'))?.[1]
const clientVersion = /const VERSION = '([^']+)'/.exec(read('../client/client.js'))?.[1]

test('版本号三处必须一致：package.json / src/version.ts / client/client.js', () => {
  assert.equal(srcVersion, pkg.version, 'src/version.ts 的 VERSION 必须等于 package.json 的 version')
  assert.equal(clientVersion, pkg.version, 'client/client.js 的 VERSION 必须等于 package.json 的 version')
})
