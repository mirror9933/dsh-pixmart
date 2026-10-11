#!/usr/bin/env node
/**
 * 版本号同步 —— 以 `package.json` 的 `version` 为**唯一真理**。
 *
 * 背景：插件版本在三处独立存在，而且**运行时谁都不读 package.json** ——
 *   - `package.json`        npm 包版本（安装对话框、registry 读它）
 *   - `src/version.ts`      宿主侧常量
 *   - `client/client.js`    **设置页那行「插件 dsh-pixmart@x.y.z」读的就是它**
 * 2026-10-07 只改了 `package.json` 就发版，设置页于是仍显示旧版本。
 *
 * 现在「发版只改 package.json 一处」：本脚本在 `pretest` / `prepack` / `prepare` 里先跑，
 * 把两处常量改写成 `package.json` 的值。**一致时不写文件**（no-op，不留改动）。
 *
 * 保留 `test/version.test.mjs` 作为冗余校验：即使有人绕过生命周期直接改常量，测试也会红。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const version = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version
if (typeof version !== 'string' || version.trim() === '') {
  console.error('sync-version: package.json 里没有可用的 version')
  process.exit(1)
}

const targets = [
  { url: new URL('src/version.ts', root), re: /(export const VERSION = ')([^']+)(')/, label: 'src/version.ts' },
  { url: new URL('client/client.js', root), re: /(const VERSION = ')([^']+)(')/, label: 'client/client.js' },
]

let changed = 0
for (const t of targets) {
  const text = readFileSync(t.url, 'utf8')
  const m = t.re.exec(text)
  if (m === null) {
    console.error(`sync-version: ${t.label} 里找不到版本常量，拒绝继续`)
    process.exit(1)
  }
  if (m[2] === version) continue
  writeFileSync(t.url, text.replace(t.re, `$1${version}$3`))
  changed += 1
  console.log(`sync-version: ${t.label}  ${m[2]} -> ${version}`)
}
console.log(changed === 0 ? `sync-version: 两处已是 ${version}（no-op）` : `sync-version: 已同步 ${changed} 处 -> ${version}`)
