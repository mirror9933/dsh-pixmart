/**
 * F1 探测脚本：找出 Ofox 的 Gemini 原生端点到底认哪个"尺寸"字段。
 *
 * 背景：我们请求 `generationConfig.imageConfig.aspectRatio = '1:1'`，实际产出 1408x768。
 * 参考项目用的是同一写法，所以疑点在于端点行为已变、或该字段需要配套参数。
 *
 * 做法：同一句极短提示词，只改 body 形状，比较实际输出像素。
 * 成本：5 次 flash-lite-image 调用（极短提示词，无品牌内容）。
 *
 * 用法：node tools/probe-aspect.mjs [config.json 路径]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { imageInfo } from '../lib/image-info.js'

// 与插件同一套数据目录解析规则，不写死本机路径。
const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const configPath = process.argv[2] ?? join(dshHome, 'pixmart', 'config.json')
const config = JSON.parse(readFileSync(configPath, 'utf8'))
const provider = config.providers[0]
const apiKey = (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) || provider.apiKey
const model = config.defaults.model
const base = provider.geminiNativeBaseUrl.replace(/[\\/]+$/, '')

if (!apiKey) {
  console.error('没有可用密钥')
  process.exit(1)
}

const PROMPT = 'A single plain matte red cube centered on a seamless white background. No text, no logo, no brand.'

const variants = [
  { name: 'v1 基线 imageConfig.aspectRatio', config: { imageConfig: { aspectRatio: '1:1' } } },
  {
    name: 'v2 +responseModalities',
    config: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1' } },
  },
  {
    name: 'v3 +imageSize 1K',
    config: { imageConfig: { aspectRatio: '1:1', imageSize: '1K' } },
  },
  { name: 'v4 generationConfig.aspectRatio', config: { aspectRatio: '1:1' } },
  { name: 'v5 对照：不传 generationConfig', config: undefined },
]

console.log(`模型: ${model}`)
console.log(`端点: ${base}\n`)

/** 第二轮：用"胜出形状"验证多个比例的映射是否正确。 */
async function probeRatio(ratio) {
  const body = {
    contents: [{ parts: [{ text: PROMPT }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: ratio } },
  }
  const response = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) return `HTTP ${response.status}`
  const parts = JSON.parse(text)?.candidates?.[0]?.content?.parts ?? []
  const imagePart = parts.find((p) => p.inlineData?.data)
  if (!imagePart) return '无图片'
  const bytes = Buffer.from(imagePart.inlineData.data, 'base64')
  const info = imageInfo(new Uint8Array(bytes), imagePart.inlineData.mimeType ?? 'image/png')
  const actual = info.height === 0 ? 0 : info.width / info.height
  const expected = (() => {
    const [w, h] = ratio.split(':').map(Number)
    return w / h
  })()
  const ok = Math.abs(actual - expected) / expected < 0.02 ? '✅' : '❌'
  return `${String(info.width).padStart(4)}x${String(info.height)}  实际 ${actual.toFixed(3)} 期望 ${expected.toFixed(3)} ${ok}`
}

for (const variant of variants) {
  const body = { contents: [{ parts: [{ text: PROMPT }] }] }
  if (variant.config !== undefined) body.generationConfig = variant.config

  let line = `${variant.name.padEnd(38)} → `
  try {
    const response = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) {
      line += `HTTP ${response.status} ${text.slice(0, 120).replace(/\s+/g, ' ')}`
      console.log(line)
      continue
    }

    const json = JSON.parse(text)
    const parts = json?.candidates?.[0]?.content?.parts ?? []
    const imagePart = parts.find((p) => p.inlineData?.data)
    if (!imagePart) {
      const textPart = parts.find((p) => p.text)
      line += `无图片（文本：${String(textPart?.text ?? '').slice(0, 80)}）`
      console.log(line)
      continue
    }

    const bytes = Buffer.from(imagePart.inlineData.data, 'base64')
    const info = imageInfo(new Uint8Array(bytes), imagePart.inlineData.mimeType ?? 'image/png')
    const ratio = info.height === 0 ? 0 : info.width / info.height
    line += `${String(info.width).padStart(4)}x${String(info.height)}  比例 ${ratio.toFixed(3)}  ${info.mediaType}  ${bytes.length} 字节`
    console.log(line)
  } catch (error) {
    console.log(`${line}异常：${error.message}`)
  }
}

console.log('\n第二轮：验证胜出形状（responseModalities + imageConfig.aspectRatio）的映射')
for (const ratio of ['1:1', '3:4', '16:9']) {
  console.log(`  aspectRatio ${ratio.padEnd(5)} → ${await probeRatio(ratio)}`)
}
