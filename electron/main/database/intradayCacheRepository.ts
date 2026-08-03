import type Database from 'better-sqlite3'
import type { IntradayCacheRow } from './types'

export function upsertIntraday(
  db: Database.Database,
  stockCode: string,
  tradeDate: string,
  points: string
): void {
  db.prepare(
    `INSERT OR REPLACE INTO intraday_cache (stockCode, tradeDate, points, fetchedAt)
     VALUES (?, ?, ?, ?)`
  ).run(stockCode, tradeDate, points, Date.now())
}

export function getIntraday(
  db: Database.Database,
  stockCode: string,
  tradeDate: string
): IntradayCacheRow | undefined {
  return db
    .prepare('SELECT * FROM intraday_cache WHERE stockCode = ? AND tradeDate = ?')
    .get(stockCode, tradeDate) as IntradayCacheRow | undefined
}

export function getIntradayBatch(
  db: Database.Database,
  entries: { stockCode: string; tradeDate: string }[]
): IntradayCacheRow[] {
  if (entries.length === 0) return []
  const results: IntradayCacheRow[] = []
  const stmt = db.prepare(
    'SELECT * FROM intraday_cache WHERE stockCode = ? AND tradeDate = ?'
  )
  for (const e of entries) {
    const row = stmt.get(e.stockCode, e.tradeDate) as IntradayCacheRow | undefined
    if (row) results.push(row)
  }
  return results
}

export function cleanupOldIntraday(db: Database.Database, keepDays = 30): void {
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const cutoff = new Date(bjNow)
  cutoff.setDate(cutoff.getDate() - keepDays)
  const cutoffStr = cutoff.toISOString().slice(0, 10).replace(/-/g, '')
  db.prepare('DELETE FROM intraday_cache WHERE tradeDate < ?').run(cutoffStr)
}
