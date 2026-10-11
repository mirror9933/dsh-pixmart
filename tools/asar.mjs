// Read-only helper: parse an Electron .asar archive without @electron/asar.
// Layout-agnostic: locates the JSON header by brace matching instead of
// assuming a fixed pickle offset.
import { open, readFile, writeFile, mkdir } from 'node:fs/promises'
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
      else {
        // `unpacked: true` 的条目**没有 `offset`**（内容在同级 `<asar>.unpacked/` 目录下）。
        // 早期版本这里直接 `Number(value.offset)` → NaN，随后 `fh.read(..., position: NaN)`
        // 抛 `ERR_OUT_OF_RANGE ... Received NaN`；所以这里显式区分"未打包"。
        const unpacked = value.unpacked === true || value.offset === undefined
        const offset = unpacked ? undefined : Number(value.offset)
        entries.push({
          path: p,
          size: Number(value.size ?? 0),
          offset: Number.isFinite(offset) ? offset : undefined,
          unpacked,
        })
      }
    }
  }
  walk(header, '')

  /**
   * 读一个条目的内容。打包进 asar 的按 `offset` 读；`unpacked` 的从同级
   * `<asar>.unpacked/<path>` 读（拿不到就给出能读懂的报错，绝不拿 NaN 去 read）。
   */
  const readEntry = async (hit) => {
    if (hit.offset === undefined) {
      const onDisk = join(`${ASAR}.unpacked`, hit.path)
      try {
        return await readFile(onDisk)
      } catch {
        throw new Error(
          `entry "${hit.path}" is unpacked (no offset in header); expected it at ${onDisk}`,
        )
      }
    }
    const buf = Buffer.alloc(hit.size)
    await fh.read(buf, 0, hit.size, dataStart + hit.offset)
    return buf
  }

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
    const buf = await readEntry(hit)
    process.stdout.write(buf.toString('utf8'))
  } else if (mode === 'extract') {
    const hit = entries.find(e => e.path === arg)
    if (!hit) {
      console.error(`not found: ${arg}`)
      process.exit(1)
    }
    const buf = await readEntry(hit)
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
    let skippedUnpacked = 0
    for (const e of entries) {
      if (shown >= limit) break
      if (e.size > 3_000_000) continue
      if (pathFilter && !pathFilter.test(e.path)) continue
      // 未打包的条目不在 asar 字节里（内容在 <asar>.unpacked/）→ grep 跳过，
      // 而不是拿 NaN 当 position 去 read（那正是 ERR_OUT_OF_RANGE 的来源）。
      if (e.offset === undefined) {
        skippedUnpacked++
        continue
      }
      const buf = await readEntry(e)
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
    if (skippedUnpacked > 0) {
      console.error(
        `[asar] skipped ${skippedUnpacked} unpacked entries (contents live in ${ASAR}.unpacked/)`,
      )
    }
  }
} finally {
  await fh.close()
}
