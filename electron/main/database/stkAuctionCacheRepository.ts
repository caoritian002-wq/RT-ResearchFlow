import type Database from 'better-sqlite3'
import type { StkAuctionRow } from './types'

/**
 * stk_auction_cache 仓库
 * 缓存 Tushare stk_auction API 返回的历史竞价数据，按 (ts_code, trade_date) 主键去重。
 */

/** 批量 upsert 竞价数据（事务） */
export function upsertStkAuctionCache(db: Database.Database, rows: StkAuctionRow[]): void {
  if (rows.length === 0) return
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO stk_auction_cache
      (ts_code, trade_date, price, vol, amount, pre_close, turnover_rate, volume_ratio, float_share, fetched_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertMany = db.transaction((items: StkAuctionRow[]) => {
    for (const r of items) {
      stmt.run(
        r.tsCode,
        r.tradeDate,
        r.price ?? null,
        r.vol ?? null,
        r.amount ?? null,
        r.preClose ?? null,
        r.turnoverRate ?? null,
        r.volumeRatio ?? null,
        r.floatShare ?? null,
        r.fetchedAt ?? Date.now()
      )
    }
  })
  insertMany(rows)
}

/** 按单日查全量竞价数据 */
export function queryByDate(db: Database.Database, tradeDate: string): StkAuctionRow[] {
  const rows = db
    .prepare(
      `SELECT ts_code, trade_date, price, vol, amount, pre_close, turnover_rate, volume_ratio, float_share, fetched_at
       FROM stk_auction_cache
       WHERE trade_date = ?`
    )
    .all(tradeDate) as {
    ts_code: string
    trade_date: string
    price: number | null
    vol: number | null
    amount: number | null
    pre_close: number | null
    turnover_rate: number | null
    volume_ratio: number | null
    float_share: number | null
    fetched_at: number | null
  }[]
  return rows.map((r) => ({
    tsCode: r.ts_code,
    tradeDate: r.trade_date,
    price: r.price,
    vol: r.vol,
    amount: r.amount,
    preClose: r.pre_close,
    turnoverRate: r.turnover_rate,
    volumeRatio: r.volume_ratio,
    floatShare: r.float_share,
    fetchedAt: r.fetched_at ?? 0
  }))
}

/**
 * 返回最近 `days` 个自然日内已有数据的交易日列表（YYYYMMDD，降序）
 */
export function getAvailableDates(db: Database.Database, days: number): string[] {
  // 用 fetched_at 推算 days 天前的时间戳
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const rows = db
    .prepare(
      `SELECT DISTINCT trade_date
       FROM stk_auction_cache
       WHERE fetched_at >= ?
       ORDER BY trade_date DESC`
    )
    .all(cutoff) as { trade_date: string }[]
  return rows.map((r) => r.trade_date)
}

/**
 * 删除 fetched_at 超过 keepDays 天的行，返回删除行数
 */
export function cleanupStkAuctionCache(db: Database.Database, keepDays = 90): number {
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000
  const result = db
    .prepare('DELETE FROM stk_auction_cache WHERE fetched_at < ?')
    .run(cutoff)
  return result.changes
}
