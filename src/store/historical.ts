/**
 * 历史产出汇总 —— 与「用量账本」刻意分开。
 *
 * 背景：`usage.jsonl` 是 P2 才引入的，在那之前生成的两张图永远不在账本里。
 * 设置页把「累计用量 0」摆在两个可见项目旁边→数字对不上，看起来像 bug。
 *
 * 两种修法中选了这一种：**账本保持真实，历史另列**。
 * 不把推算行补写进 `usage.jsonl`，因为那会伪造从未发生过的逐请求明细
 * （项目记录里没有当时真实的 n / degraded / errorCode / 逐次耗时），
 * 而账本唯一的价值就是"每一行都真的发生过"。
 *
 * 本模块是纯函数，便于单测。
 */

/** 项目记录里用于汇总的最小面。 */
export interface CountableProject {
  readonly imageCount: number
}

export interface HistoricalTotals {
  /** 账本之前就已存在的项目数。 */
  readonly projects: number
  /** 账本之前就已存在的产出图片数。 */
  readonly images: number
  /** 固定说明：让 UI 能解释这行数字的来源，而不是让用户猜。 */
  readonly note: string
}

export const HISTORICAL_NOTE = '账本（usage.jsonl）自 P2 引入；此前的产出由项目记录汇总得出'

/**
 * 从项目列表推导历史产出。
 * @param projects - `ProjectStore.list()` 的结果（只要带 `imageCount`）。
 */
export function historicalTotals(projects: readonly CountableProject[]): HistoricalTotals {
  let images = 0
  for (const project of projects) {
    const count = project.imageCount
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) images += count
  }
  return { projects: projects.length, images, note: HISTORICAL_NOTE }
}
