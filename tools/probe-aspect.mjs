/**
 * F1 探测脚本：找出 Ofox 的 Gemini 原生端点认哪个"尺寸"字段。
 *
 * ⚠️ **这个脚本会真实调用厂商并产生费用。**
 * 因此它默认**什么都不做**，只打印预算；必须显式放行才会发请求：
 *
 *   node tools/probe-aspect.mjs --yes                       # 跑全部（5 形状 + 3 比例）
 *   node tools/probe-aspect.mjs --yes --shapes-only         # 只跑 5 种 body 形状
 *   node tools/probe-aspect.mjs --yes --ratios-only         # 只跑比例确认
 *   node tools/probe-aspect.mjs --yes --only=v1,v2          # 只跑指定形状
 *
 * 教训（2026-10-05）：首版没有闸门也没有选择器，我为"再看一眼"整跑了两次，
 * 把 21 次付费调用花在了一次只需 8 次的诊断上。改一行就整跑一遍是坏习惯。
 *
 * 用法补充：第一个非选项参数可指定 config.json 路径。
 * 依赖：node tools/probe-aspect.mjs 需要先 `pnpm build`（读 lib/image-info.js）。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { imageInfo } from '../lib/image-info.js'

const args = process.argv.slice(2)
const allowSpend = args.includes('--yes') || process.env.PIXMART_PROBE_ALLOW_SPEND === '1'
const shapesOnly = args.includes('--shapes-only')
const ratiosOnly = args.includes('--ratios-only')
const onlyArg = args.find((arg) => arg.startsWith('--only='))
const only = onlyArg === undefined ? undefined : new Set(onlyArg.slice('--only='.length).split(','))

const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const configPath = args.find((arg) => !arg.startsWith('--')) ?? join(dshHome, 'pixmart', 'config.json')

const config = JSON.parse(readFileSync(configPath, 'utf8'))
const provider = config.providers[0]
const apiKey = (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) || provider.apiKey
const model = config.defaults.model
const base = provider.geminiNativeBaseUrl.replace(/[\\/]+$/, '')

if (!apiKey) {
  console.error('没有可用密钥')
  process.exit(1)
}

const PROMPT =
  'A single plain matte red cube centered on a seamless white background. No text, no logo, no brand.'

const shapes = [
  { id: 'v1', name: '基线 imageConfig.aspectRatio', config: { imageConfig: { aspectRatio: '1:1' } } },
  {
    id: 'v2',
    name: '+responseModalities',
    config: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1' } },
  },
  { id: 'v3', name: '+imageSize 1K', config: { imageConfig: { aspectRatio: '1:1', imageSize: '1K' } } },
  { id: 'v4', name: 'generationConfig.aspectRatio', config: { aspectRatio: '1:1' } },
  { id: 'v5', name: '对照：不传 generationConfig', config: undefined },
]

const RATIOS = ['1:1', '3:4', '16:9']

const selectedShapes = shapesOnly || ratiosOnly ? (shapesOnly ? shapes : []) : shapes
const selectedRatios = ratiosOnly ? RATIOS : shapesOnly ? [] : RATIOS
const filteredShapes = only === undefined ? selectedShapes : selectedShapes.filter((s) => only.has(s.id))
const budget = filteredShapes.length + selectedRatios.length

console.log(`模型: ${model}`)
console.log(`端点: ${base}`)
console.log(`计划: ${filteredShapes.length} 个形状变体 + ${selectedRatios.length} 个比例确认 = ${budget} 次付费请求`)

if (!allowSpend) {
  console.log('\n未放行：这 ${budget} 次调用会真实计费。确认后加 --yes 重新运行。'.replace('${budget}', String(budget)))
  process.exit(0)
}
if (budget === 0) {
  console.log('没有选中任何变体，退出。')
  process.exit(0)
}

async function call(body) {
  const response = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) return { error: `HTTP ${response.status} ${text.slice(0, 120)}` }
  const parts = JSON.parse(text)?.candidates?.[0]?.content?.parts ?? []
  const imagePart = parts.find((p) => p.inlineData?.data)
  if (!imagePart) {
    const textPart = parts.find((p) => p.text)
    return { error: `无图片（文本：${String(textPart?.text ?? '').slice(0, 80)}）` }
  }
  const bytes = Buffer.from(imagePart.inlineData.data, 'base64')
  const info = imageInfo(new Uint8Array(bytes), imagePart.inlineData.mimeType ?? 'image/png')
  return { info, bytes }
}

let spent = 0

for (const shape of filteredShapes) {
  const body = { contents: [{ parts: [{ text: PROMPT }] }] }
  if (shape.config !== undefined) body.generationConfig = shape.config
  spent += 1
  const result = await call(body)
  if (result.error !== undefined) {
    console.log(`  ${shape.name.padEnd(38)} → ${result.error}`)
    continue
  }
  const ratio = result.info.height === 0 ? 0 : result.info.width / result.info.height
  console.log(
    `  ${shape.name.padEnd(38)} → ${String(result.info.width).padStart(4)}x${String(result.info.height)}  比例 ${ratio.toFixed(3)}  ${result.info.mediaType}  ${result.bytes.length} 字节`,
  )
}

for (const ratio of selectedRatios) {
  spent += 1
  const body = {
    contents: [{ parts: [{ text: PROMPT }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: ratio } },
  }
  const result = await call(body)
  if (result.error !== undefined) {
    console.log(`  aspectRatio ${ratio.padEnd(5)} → ${result.error}`)
    continue
  }
  const [w, h] = ratio.split(':').map(Number)
  const expected = w / h
  const actual = result.info.height === 0 ? 0 : result.info.width / result.info.height
  const ok = Math.abs(actual - expected) / expected < 0.02 ? '✅' : '❌'
  console.log(
    `  aspectRatio ${ratio.padEnd(5)} → ${String(result.info.width).padStart(4)}x${String(result.info.height)}  实际 ${actual.toFixed(3)} 期望 ${expected.toFixed(3)} ${ok}`,
  )
}

console.log(`\n本次实际发出 ${spent} 次付费请求。`)
