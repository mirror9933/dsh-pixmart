// Read-only helper: parse an Electron .asar archive without @electron/asar.
// Layout-agnostic: locates the JSON header by brace matching instead of
// assuming a fixed pickle offset.
import { open, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const ASAR = process.env.ASAR_PATH ?? 'E:\\Program Files\\deepseek harness\\resources\\app.asar'

function parseHeader(headerBuf) {
  const start = headerBuf.indexOf(0x7b) // '{'
  if (start < 0) throw new Error('no JSON object found in asar header')
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < headerBuf.length; i++) {
    const c = headerBuf[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === 0x5c) escaped = true
      else if (c === 0x22) inString = false
      continue
    }
    if (c === 0x22) inString = true
    else if (c === 0x7b) depth++
    else if (c === 0x7d) {
      depth--
      if (depth === 0) return JSON.parse(headerBuf.toString('utf8', start, i + 1))
    }
  }
  throw new Error('unterminated JSON object in asar header')
}

const fh = await open(ASAR, 'r')
try {
  const sizeBuf = Buffer.alloc(8)
  await fh.read(sizeBuf, 0, 8, 0)
  const headerPickleSize = sizeBuf.readUInt32LE(4)
  const headerBuf = Buffer.alloc(headerPickleSize)
  await fh.read(headerBuf, 0, headerPickleSize, 8)
  const header = parseHeader(headerBuf)
  const dataStart = 8 + headerPickleSize

  const entries = []
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const p = prefix ? `${prefix}/${name}` : name
      if (value.files) walk(value, p)
      else entries.push({ path: p, size: value.size, offset: Number(value.offset) })
    }
  }
  walk(header, '')

  const mode = process.argv[2] ?? 'count'
  const arg = process.argv[3]

  if (mode === 'count') {
    console.log(JSON.stringify({ entries: entries.length, dataStart }))
  } else if (mode === 'find') {
    const re = new RegExp(arg, 'i')
    for (const e of entries.filter(e => re.test(e.path)).slice(0, 200)) {
      console.log(`${e.size}\t${e.path}`)
    }
  } else if (mode === 'read') {
    const hit = entries.find(e => e.path === arg)
    if (!hit) {
      console.error(`not found: ${arg}`)
      process.exit(1)
    }
    const buf = Buffer.alloc(hit.size)
    await fh.read(buf, 0, hit.size, dataStart + hit.offset)
    process.stdout.write(buf.toString('utf8'))
  } else if (mode === 'extract') {
    const hit = entries.find(e => e.path === arg)
    if (!hit) {
      console.error(`not found: ${arg}`)
      process.exit(1)
    }
    const buf = Buffer.alloc(hit.size)
    await fh.read(buf, 0, hit.size, dataStart + hit.offset)
    const out = join('.probe', 'out', arg)
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, buf)
    console.log(`wrote ${out} (${hit.size} bytes)`)
  } else if (mode === 'grep') {
    // grep inside file contents, printing path:line
    const re = new RegExp(arg)
    const limit = Number(process.argv[4] ?? 60)
    const pathFilter = process.argv[5] ? new RegExp(process.argv[5]) : null
    let shown = 0
    for (const e of entries) {
      if (shown >= limit) break
      if (e.size > 3_000_000) continue
      if (pathFilter && !pathFilter.test(e.path)) continue
      const buf = Buffer.alloc(e.size)
      await fh.read(buf, 0, e.size, dataStart + e.offset)
      const text = buf.toString('utf8')
      if (text.includes('\u0000')) continue
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          console.log(`${e.path}:${i + 1}: ${lines[i].slice(0, 240)}`)
          shown++
          if (shown >= limit) break
        }
      }
    }
  }
} finally {
  await fh.close()
}
