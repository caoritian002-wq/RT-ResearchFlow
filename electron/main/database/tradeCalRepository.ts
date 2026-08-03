import Database from 'better-sqlite3'
import { TradeCalRow } from './types'

/**
 * 批量写入/更新交易日历（幂等，INSERT OR REPLACE）
 */
export function upsertTradeCal(db: Database.Database, rows: TradeCalRow[]): void {
  if (rows.length === 0) return
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date)
    VALUES (?, ?, ?)
  `)
  const insert = db.transaction((items: TradeCalRow[]) => {
    for (const r of items) {
      stmt.run(r.calDate, r.isOpen, r.pretradeDate ?? null)
    }
  })
  insert(rows)
}

/**
 * 查询指定日期是否为交易日。
 * 返回 true/false；trade_cal 表为空或无该日记录时返回 null（触发 fallback）
 */
export function isTradeDay(db: Database.Database, calDate: string): boolean | null {
  const row = db
    .prepare('SELECT is_open FROM trade_cal WHERE cal_date = ?')
    .get(calDate) as { is_open: number } | undefined
  if (row === undefined) {
    // 检查表是否完全为空
    const count = (
      db.prepare('SELECT COUNT(*) as cnt FROM trade_cal').get() as { cnt: number }
    ).cnt
    if (count === 0) return null
    // 表有数据但无该日期记录：该日为非交易日（节假日补录缺失，保守返回 false）
    return false
  }
  return row.is_open === 1
}

/**
 * 查询某日期的上一交易日（读取 pretrade_date 列）。
 * 无记录或表为空时返回 null
 */
export function getPrevTradeDay(db: Database.Database, calDate: string): string | null {
  const row = db
    .prepare('SELECT pretrade_date FROM trade_cal WHERE cal_date = ?')
    .get(calDate) as { pretrade_date: string | null } | undefined
  return row?.pretrade_date ?? null
}

/**
 * 查询某日期的下一交易日。
 * 无数据时返回 null
 */
export function getNextTradeDay(db: Database.Database, calDate: string): string | null {
  const row = db
    .prepare(
      'SELECT cal_date FROM trade_cal WHERE cal_date > ? AND is_open = 1 ORDER BY cal_date ASC LIMIT 1'
    )
    .get(calDate) as { cal_date: string } | undefined
  return row?.cal_date ?? null
}

/**
 * 返回 [startDate, endDate] 区间内所有交易日（升序）。
 * 表为空时返回 []
 */
export function getTradingDaysInRange(
  db: Database.Database,
  startDate: string,
  endDate: string
): string[] {
  const rows = db
    .prepare(
      'SELECT cal_date FROM trade_cal WHERE cal_date >= ? AND cal_date <= ? AND is_open = 1 ORDER BY cal_date ASC'
    )
    .all(startDate, endDate) as { cal_date: string }[]
  return rows.map((r) => r.cal_date)
}

/**
 * 返回 beforeDate（含）往前数 n 个交易日的所有交易日（升序）。
 * 常用于"近 N 交易日"区间计算。
 * 表为空或不足 n 条时返回已有条目；表空返回 []
 */
export function getLastNTradingDays(
  db: Database.Database,
  n: number,
  beforeDate: string
): string[] {
  const rows = db
    .prepare(
      'SELECT cal_date FROM trade_cal WHERE cal_date <= ? AND is_open = 1 ORDER BY cal_date DESC LIMIT ?'
    )
    .all(beforeDate, n) as { cal_date: string }[]
  // 结果是降序，需反转为升序
  return rows.map((r) => r.cal_date).reverse()
}

/**
 * 查询数据库中已有的最晚 cal_date。
 * 表为空时返回 null
 */
export function getLatestCalDate(db: Database.Database): string | null {
  const row = db
    .prepare('SELECT MAX(cal_date) as latest FROM trade_cal')
    .get() as { latest: string | null }
  return row?.latest ?? null
}
