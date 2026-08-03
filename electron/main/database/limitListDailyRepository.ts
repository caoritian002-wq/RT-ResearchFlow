import type Database from 'better-sqlite3'
import type { LimitListDailyRow } from './types'

/** Map a SQLite row (snake_case) to LimitListDailyRow (camelCase). */
function mapRow(r: Record<string, unknown>): LimitListDailyRow {
  return {
    tradeDate: r.trade_date as string,
    tsCode: r.ts_code as string,
    name: (r.name as string | null) ?? null,
    close: (r.close as number | null) ?? null,
    pctChg: (r.pct_chg as number | null) ?? null,
    amount: (r.amount as number | null) ?? null,
    floatMv: (r.float_mv as number | null) ?? null,
    totalMv: (r.total_mv as number | null) ?? null,
    turnoverRatio: (r.turnover_ratio as number | null) ?? null,
    fdAmount: (r.fd_amount as number | null) ?? null,
    firstTime: (r.first_time as string | null) ?? null,
    lastTime: (r.last_time as string | null) ?? null,
    openTimes: (r.open_times as number | null) ?? null,
    upStat: (r.up_stat as string | null) ?? null,
    limitTimes: (r.limit_times as number | null) ?? null,
    limit: (r.limit as string | null) ?? null,
    fetchedAt: (r.fetched_at as number) ?? 0
  }
}

export function upsertLimitList(db: Database.Database, rows: LimitListDailyRow[]): void {
  if (rows.length === 0) return
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO limit_list_daily (
      trade_date, ts_code, name, close, pct_chg, amount, float_mv, total_mv,
      turnover_ratio, fd_amount, first_time, last_time, open_times, up_stat,
      limit_times, "limit", fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const tx = db.transaction((items: LimitListDailyRow[]) => {
    for (const r of items) {
      stmt.run(
        r.tradeDate, r.tsCode, r.name, r.close, r.pctChg, r.amount, r.floatMv, r.totalMv,
        r.turnoverRatio, r.fdAmount, r.firstTime, r.lastTime, r.openTimes, r.upStat,
        r.limitTimes, r.limit, r.fetchedAt
      )
    }
  })
  tx(rows)
}

export function getLimitListByDate(db: Database.Database, tradeDate: string): LimitListDailyRow[] {
  const rows = db
    .prepare('SELECT * FROM limit_list_daily WHERE trade_date = ? ORDER BY limit_times DESC, ts_code')
    .all(tradeDate) as Record<string, unknown>[]
  return rows.map(mapRow)
}

export function getStockLimitHistory(
  db: Database.Database,
  tsCode: string,
  days: number
): LimitListDailyRow[] {
  const rows = db
    .prepare(
      'SELECT * FROM limit_list_daily WHERE ts_code = ? ORDER BY trade_date DESC LIMIT ?'
    )
    .all(tsCode, days) as Record<string, unknown>[]
  return rows.map(mapRow)
}

/** Aggregate: each stock's max historical limit_times. */
export function getMaxLimitTimesByStock(db: Database.Database): Map<string, number> {
  const rows = db
    .prepare('SELECT ts_code, MAX(limit_times) AS max_lt FROM limit_list_daily GROUP BY ts_code')
    .all() as { ts_code: string; max_lt: number | null }[]
  const m = new Map<string, number>()
  for (const r of rows) {
    if (r.max_lt != null) m.set(r.ts_code, r.max_lt)
  }
  return m
}

/**
 * 返回每只股票最近一次达到其历史最高连板数的交易日（YYYYMMDD）。
 * 用于龙头首阴计算真实"距高标天数"，避免展示遥远历史的高标股。
 */
export function getPeakDateByStock(db: Database.Database): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT l.ts_code, MAX(l.trade_date) AS peak_date
       FROM limit_list_daily l
       INNER JOIN (
         SELECT ts_code, MAX(limit_times) AS max_lt
         FROM limit_list_daily
         GROUP BY ts_code
       ) m ON l.ts_code = m.ts_code AND l.limit_times = m.max_lt
       GROUP BY l.ts_code`
    )
    .all() as { ts_code: string; peak_date: string | null }[]
  const map = new Map<string, string>()
  for (const r of rows) {
    if (r.peak_date) map.set(r.ts_code, r.peak_date)
  }
  return map
}

/** 返回 DB 中最近一个有涨停数据的 trade_date（YYYYMMDD），无数据返回 null */
export function getLatestAvailableTradeDate(db: Database.Database): string | null {
  const row = db
    .prepare('SELECT trade_date FROM limit_list_daily ORDER BY trade_date DESC LIMIT 1')
    .get() as { trade_date: string } | undefined
  return row?.trade_date ?? null
}

export function cleanupOlderThan(db: Database.Database, days = 90): number {
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const threshold = new Date(bjNow.getTime() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '')
  const info = db.prepare('DELETE FROM limit_list_daily WHERE trade_date < ?').run(threshold)
  return info.changes
}
