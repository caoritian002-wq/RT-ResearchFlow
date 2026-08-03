/**
 * market_timeline_daily 仓库
 *
 * 负责盘中涨停/跌停时间序列的持久化读写，支持：
 *  - 盘中断点续传（重启后从 DB 恢复当日已记录的点）
 *  - 盘后回看（历史交易日完整时间序列）
 *  - 7 日滚动清理
 */

import type Database from 'better-sqlite3'
import type { MarketTimelineDailyRow } from './types'

/**
 * 批量写入时间序列点（INSERT OR REPLACE），使用事务提升性能。
 */
export function upsertTimelinePoints(
  db: Database.Database,
  rows: MarketTimelineDailyRow[]
): void {
  if (rows.length === 0) return
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO market_timeline_daily (trade_date, time, limit_up, limit_down)
    VALUES (@trade_date, @time, @limit_up, @limit_down)
  `)
  const runAll = db.transaction((items: MarketTimelineDailyRow[]) => {
    for (const row of items) stmt.run(row)
  })
  runAll(rows)
}

/**
 * 写入单个时间序列点（盘中每 60s 调用一次）。
 */
export function insertTimelinePoint(
  db: Database.Database,
  row: MarketTimelineDailyRow
): void {
  db.prepare(`
    INSERT OR REPLACE INTO market_timeline_daily (trade_date, time, limit_up, limit_down)
    VALUES (@trade_date, @time, @limit_up, @limit_down)
  `).run(row)
}

/**
 * 读取指定交易日的完整时间序列，按 time 升序返回。
 */
export function getTimelineByDate(
  db: Database.Database,
  tradeDate: string
): MarketTimelineDailyRow[] {
  return db
    .prepare(
      `SELECT trade_date, time, limit_up, limit_down
       FROM market_timeline_daily
       WHERE trade_date = ?
       ORDER BY time ASC`
    )
    .all(tradeDate) as MarketTimelineDailyRow[]
}

/**
 * 删除 N 天前的历史记录（按日历日，保留最近 keepDays 个交易日数据）。
 * 返回删除行数。
 */
export function cleanupTimelineOlderThan(
  db: Database.Database,
  keepDays: number
): number {
  const cutoffMs = Date.now() - keepDays * 24 * 60 * 60 * 1000
  const cutoffDate = new Date(cutoffMs + 8 * 60 * 60 * 1000) // 转北京时间
  const cutoffYmd =
    `${cutoffDate.getUTCFullYear()}` +
    `${String(cutoffDate.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(cutoffDate.getUTCDate()).padStart(2, '0')}`
  const result = db
    .prepare(`DELETE FROM market_timeline_daily WHERE trade_date < ?`)
    .run(cutoffYmd)
  return result.changes
}
