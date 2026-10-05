/**
 * 最小 Node 面声明。
 *
 * 本插件的 tsconfig 使用 `types: []`，不引入 @types/node——保持依赖面为零。
 * 这里只声明实际用到的运行时能力。
 *
 * 本文件不含顶层 import/export，因此是全局脚本：上面的 `declare const process`
 * 对所有源文件可见。
 */

declare const process: {
  readonly version: string
  readonly pid: number
  cwd(): string
  readonly argv: string[]
  readonly env: Record<string, string | undefined>
}

declare function setTimeout(callback: () => void, delayMs: number): unknown
declare function clearTimeout(handle: unknown): void

/* ── 宿主 Node 的 Web 兼容全局（仅声明用到的面） ───────────────────────── */

interface PixmartAbortSignal {
  readonly aborted: boolean
  addEventListener(type: 'abort', listener: () => void): void
}

declare class AbortController {
  constructor()
  readonly signal: PixmartAbortSignal
  abort(reason?: unknown): void
}

declare class Blob {
  constructor(parts: readonly unknown[], options?: { readonly type?: string })
}

declare class FormData {
  append(name: string, value: unknown, filename?: string): void
}

declare const Buffer: {
  from(data: Uint8Array): { toString(encoding: string): string }
  from(data: string, encoding: string): Uint8Array
}

interface PixmartFetchResponse {
  readonly ok: boolean
  readonly status: number
  readonly statusText: string
  readonly headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
  json(): Promise<unknown>
}

declare function fetch(
  input: string,
  init?: {
    readonly method?: string
    readonly headers?: Record<string, string>
    readonly body?: unknown
    readonly signal?: unknown
  },
): Promise<PixmartFetchResponse>

declare module 'node:fs' {
  export function writeFileSync(file: string, data: string | Uint8Array, encoding?: string): void
  export function readFileSync(file: string): Uint8Array
  export function readFileSync(file: string, encoding: string): string
  export function mkdirSync(path: string, options?: { readonly recursive?: boolean }): string | undefined
  export function openSync(path: string, flags: string): number
  export function closeSync(fd: number): void
  export function writeSync(fd: number, data: string): number
  export function fsyncSync(fd: number): void
  export function renameSync(oldPath: string, newPath: string): void
  export function unlinkSync(path: string): void
  export function existsSync(path: string): boolean
  export function readdirSync(path: string): string[]
  export function statSync(path: string): { isDirectory(): boolean; isFile(): boolean; size: number; mtimeMs: number }
  export function rmSync(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): void
}

declare module 'node:path' {
  export function dirname(p: string): string
  export function basename(p: string): string
  export function isAbsolute(p: string): boolean
  export function join(...parts: string[]): string
  export function resolve(...parts: string[]): string
  export const sep: string
}

declare module 'node:os' {
  export function homedir(): string
}

declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(data: Uint8Array | string): { digest(encoding: string): string }
  }
}
