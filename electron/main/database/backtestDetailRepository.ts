import type Database from 'better-sqlite3'
import type { BacktestDetailRow } from './types'

/**
 * stk_auction_backtest_detail 仓库
 * 存储每个交易日各股票的回测明细（T+1/2/3/5 收益率）。
 */

/** 批量 upsert 回测明细（事务） */
export function upsertBacktestDetail(db: Database.Database, rows: BacktestDetailRow[]): void {
  if (rows.length === 0) return
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO stk_auction_backtest_detail
      (trade_date, ts_code, pool, buy_price, ret_1d, ret_2d, ret_3d, ret_5d, computed_at, is_one_word,
       idx_today_pct, idx_ret1d, idx_ret2d, idx_ret3d, idx_ret5d)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertMany = db.transaction((items: BacktestDetailRow[]) => {
    for (const r of items) {
      stmt.run(
        r.tradeDate,
        r.tsCode,
        r.pool,
        r.buyPrice ?? null,
        r.ret1d ?? null,
        r.ret2d ?? null,
        r.ret3d ?? null,
        r.ret5d ?? null,
        r.computedAt ?? Date.now(),
        r.isOneWord ?? 0,
        r.idxTodayPct ?? null,
        r.idxRet1d ?? null,
        r.idxRet2d ?? null,
        r.idxRet3d ?? null,
        r.idxRet5d ?? null
      )
    }
  })
  insertMany(rows)
}

/** 按日期范围查全量回测明细（降序） */
export function queryDetails(
  db: Database.Database,
  opts: { startDate: string; endDate: string }
): BacktestDetailRow[] {
  const rows = db
    .prepare(
      `SELECT d.trade_date, d.ts_code, d.pool, d.buy_price, d.ret_1d, d.ret_2d, d.ret_3d, d.ret_5d, d.computed_at, d.is_one_word,
              d.idx_today_pct, d.idx_ret1d, d.idx_ret2d, d.idx_ret3d, d.idx_ret5d,
              si.stockName
       FROM stk_auction_backtest_detail d
       LEFT JOIN stock_info si ON si.stockCode = SUBSTR(d.ts_code, 1, 6)
       WHERE d.trade_date BETWEEN ? AND ?
       ORDER BY d.trade_date DESC, d.ts_code ASC`
    )
    .all(opts.startDate, opts.endDate) as {
    trade_date: string
    ts_code: string
    stockName: string | null
    pool: string
    buy_price: number | null
    ret_1d: number | null
    ret_2d: number | null
    ret_3d: number | null
    ret_5d: number | null
    computed_at: number | null
    is_one_word: number | null
    idx_today_pct: number | null
    idx_ret1d: number | null
    idx_ret2d: number | null
    idx_ret3d: number | null
    idx_ret5d: number | null
  }[]
  return rows.map((r) => ({
    tradeDate: r.trade_date,
    tsCode: r.ts_code,
    stockName: r.stockName,
    pool: r.pool as BacktestDetailRow['pool'],
    buyPrice: r.buy_price,
    ret1d: r.ret_1d,
    ret2d: r.ret_2d,
    ret3d: r.ret_3d,
    ret5d: r.ret_5d,
    computedAt: r.computed_at,
    isOneWord: r.is_one_word ?? 0,
    idxTodayPct: r.idx_today_pct,
    idxRet1d: r.idx_ret1d,
    idxRet2d: r.idx_ret2d,
    idxRet3d: r.idx_ret3d,
    idxRet5d: r.idx_ret5d,
  }))
}

/** 返回所有已完成计算的 trade_date 列表（升序） */
export function getComputedDates(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT trade_date
       FROM stk_auction_backtest_detail
       ORDER BY trade_date ASC`
    )
    .all() as { trade_date: string }[]
  return rows.map((r) => r.trade_date)
}

/**
 * 删除 computed_at 超过 keepDays 天的行，返回删除行数
 */
export function cleanupBacktestDetail(db: Database.Database, keepDays = 180): number {
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000
  const result = db
    .prepare('DELETE FROM stk_auction_backtest_detail WHERE computed_at < ?')
    .run(cutoff)
  return result.changes
}
