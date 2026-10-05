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
  cwd(): string
  readonly argv: string[]
  readonly env: Record<string, string | undefined>
}

declare function setTimeout(callback: () => void, delayMs: number): unknown

declare module 'node:fs' {
  export function writeFileSync(file: string, data: string, encoding?: string): void
  export function mkdirSync(path: string, options?: { readonly recursive?: boolean }): string | undefined
}

declare module 'node:path' {
  export function dirname(p: string): string
  export function join(...parts: string[]): string
}

declare module 'node:os' {
  export function homedir(): string
}
