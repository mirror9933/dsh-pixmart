/**
 * 按 key 串行的异步互斥（技术方案 §7.8）。
 *
 * 同一 key 上的读改写必须串行，否则并发生图会互相覆盖项目索引。
 * 不同 key 之间互不阻塞。
 *
 * 失败传播：某个任务抛错**不会**污染后续任务——链尾单独吞掉结果，
 * 只用于维持顺序。
 */

export interface KeyedMutex {
  /**
   * 在 `key` 上串行执行 `fn`。
   * @returns `fn` 的结果；`fn` 抛错时该次调用的 Promise 也 reject。
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T>
  /** 当前仍在排队或执行的 key 数量（测试用）。 */
  size(): number
}

export function createKeyedMutex(): KeyedMutex {
  const tails = new Map<string, Promise<void>>()

  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve()

      // 无论上一个成功还是失败，都继续执行当前任务。
      const result = previous.then(
        () => fn(),
        () => fn(),
      )

      // 链尾吞掉结果，只保留顺序；避免一次失败卡死整条链。
      const tail = result.then(
        () => undefined,
        () => undefined,
      )
      tails.set(key, tail)
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key)
      })

      return result
    },

    size(): number {
      return tails.size
    },
  }
}
