import type Database from 'better-sqlite3'
import type { StockInfoRow, StockPriceCacheRow } from './types'

export function getStockInfo(db: Database.Database, stockCode: string): StockInfoRow | null {
  return (db.prepare('SELECT * FROM stock_info WHERE stockCode = ?').get(stockCode) as StockInfoRow) ?? null
}

export function upsertStockInfo(db: Database.Database, stockCode: string, stockName: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO stock_info (stockCode, stockName, fetchedAt) VALUES (?, ?, ?)'
  ).run(stockCode, stockName, Date.now())
}

/** Insert AI-provided stock name only when no record exists yet.
 *  Tushare (authoritative source) should always use upsertStockInfo() to overwrite.
 */
export function upsertStockInfoIfAbsent(db: Database.Database, stockCode: string, stockName: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO stock_info (stockCode, stockName, fetchedAt) VALUES (?, ?, ?)'
  ).run(stockCode, stockName, Date.now())
}

export function listStockInfos(db: Database.Database): StockInfoRow[] {
  return db.prepare('SELECT * FROM stock_info ORDER BY stockCode').all() as StockInfoRow[]
}

/** Returns cached rows for a stock sorted ascending by tradeDate */
export function getCachedPrices(db: Database.Database, stockCode: string): StockPriceCacheRow[] {
  return db
    .prepare('SELECT * FROM stock_price_cache WHERE stockCode = ? ORDER BY tradeDate ASC')
    .all(stockCode) as StockPriceCacheRow[]
}

export function getCachedPricePage(
  db: Database.Database,
  stockCode: string,
  limit: number,
  beforeTradeDate?: string,
): { rows: StockPriceCacheRow[]; hasMore: boolean } {
  const safeLimit = Math.max(1, Math.min(240, Math.trunc(limit)))
  const rows = beforeTradeDate
    ? db.prepare(`
        SELECT * FROM stock_price_cache
        WHERE stockCode = ? AND tradeDate < ?
        ORDER BY tradeDate DESC
        LIMIT ?
      `).all(stockCode, beforeTradeDate, safeLimit + 1) as StockPriceCacheRow[]
    : db.prepare(`
        SELECT * FROM stock_price_cache
        WHERE stockCode = ?
        ORDER BY tradeDate DESC
        LIMIT ?
      `).all(stockCode, safeLimit + 1) as StockPriceCacheRow[]

  return {
    rows: rows.slice(0, safeLimit).reverse(),
    hasMore: rows.length > safeLimit,
  }
}

/** Returns the set of cached tradeDates for a stock */
export function getCachedDates(db: Database.Database, stockCode: string): Set<string> {
  const rows = db
    .prepare('SELECT tradeDate FROM stock_price_cache WHERE stockCode = ?')
    .all(stockCode) as { tradeDate: string }[]
  return new Set(rows.map((r) => r.tradeDate))
}

/** Upsert price rows (INSERT OR REPLACE to update existing rows when new fields like amount are added) */
export function insertPrices(db: Database.Database, rows: StockPriceCacheRow[]): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO stock_price_cache
      (stockCode, tradeDate, open, high, low, close, volume, amount, fetchedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertMany = db.transaction((items: StockPriceCacheRow[]) => {
    for (const r of items) {
      stmt.run(r.stockCode, r.tradeDate, r.open, r.high, r.low, r.close, r.volume, r.amount, r.fetchedAt)
    }
  })
  insertMany(rows)
}

/**
 * 仅在对应 (stockCode, tradeDate) 不存在时插入，不覆盖已有数据。
 * 用于每日 cron 补填空缺交易日，保留已有 amount 等精确字段。
 */
export function insertPricesIfMissing(db: Database.Database, rows: StockPriceCacheRow[]): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO stock_price_cache
      (stockCode, tradeDate, open, high, low, close, volume, amount, fetchedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertMany = db.transaction((items: StockPriceCacheRow[]) => {
    for (const r of items) {
      stmt.run(r.stockCode, r.tradeDate, r.open, r.high, r.low, r.close, r.volume, r.amount, r.fetchedAt)
    }
  })
  insertMany(rows)
}

/** Returns true if any cached row for this stock within the given date range is missing amount data */
export function hasMissingAmount(db: Database.Database, stockCode: string, startDate: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM stock_price_cache WHERE stockCode = ? AND tradeDate >= ? AND amount IS NULL LIMIT 1')
    .get(stockCode, startDate)
  return !!row
}
