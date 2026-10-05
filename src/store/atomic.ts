/**
 * 崩溃安全的文件读写（技术方案 §4.6）。
 *
 * 写入协议：同目录临时文件 → 写入 → `fsync` → 原子 `rename`。
 * 任何一步失败都清理临时文件并保留原文件，**绝不留下半截 JSON**。
 *
 * 读取容错：缺失与损坏分开返回，调用方决定是否把损坏文件隔离。
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

let tmpSeq = 0

/**
 * 原子写文本文件。
 * @param file - 目标绝对路径。
 * @param data - 完整内容（调用方负责序列化为 UTF-8 文本）。
 */
export function writeFileAtomic(file: string, data: string): void {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })

  tmpSeq += 1
  const tmp = join(dir, `.${basename(file)}.tmp-${process.pid}-${tmpSeq}`)

  let fd: number | undefined
  try {
    fd = openSync(tmp, 'w')
    writeSync(fd, data)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, file)
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // 关闭失败不掩盖原始错误
      }
    }
    try {
      unlinkSync(tmp)
    } catch {
      // 临时文件可能未创建
    }
    throw error
  }
}

/** JSON 读取结果：缺失 / 损坏 分开，避免调用方把两者混为一谈。 */
export type JsonReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: 'missing' }
  | { readonly ok: false; readonly reason: 'unreadable'; readonly error: string }

/**
 * 读取并解析 JSON 文件。
 * @param file - 目标绝对路径。
 */
export function readJsonFile<T>(file: string): JsonReadResult<T> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code
    if (code === 'ENOENT') return { ok: false, reason: 'missing' }
    return { ok: false, reason: 'unreadable', error: code ?? String(error) }
  }

  try {
    return { ok: true, value: JSON.parse(text) as T }
  } catch (error) {
    return {
      ok: false,
      reason: 'unreadable',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 把损坏文件改名隔离（保留证据，不静默删除）。
 * @returns 隔离后的路径；改名失败返回 `undefined`。
 */
export function quarantineFile(file: string): string | undefined {
  const target = `${file}.corrupt-${Date.now()}`
  try {
    renameSync(file, target)
    return target
  } catch {
    return undefined
  }
}
