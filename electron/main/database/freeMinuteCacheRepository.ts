import type Database from 'better-sqlite3'
import type { FreeMinuteCacheRow } from './types'

export function upsertFreeMinuteCache(db: Database.Database, rows: FreeMinuteCacheRow[]): void {
  if (rows.length === 0) return
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO free_minute_cache
      (provider_id, ts_code, trade_date, granularity, ts_minute, open, high, low, close, vol, amount, fetched_at)
    VALUES (@providerId, @tsCode, @tradeDate, @granularity, @tsMinute, @open, @high, @low, @close, @vol, @amount, @fetchedAt)
  `)
  const tx = db.transaction((items: FreeMinuteCacheRow[]) => {
    for (const row of items) stmt.run(row)
  })
  tx(rows)
}

export function getFreeMinuteCacheByDate(
  db: Database.Database,
  providerId: string,
  tsCode: string,
  tradeDate: string,
  granularity: string
): FreeMinuteCacheRow[] {
  return db.prepare(`
    SELECT
      provider_id AS providerId,
      ts_code AS tsCode,
      trade_date AS tradeDate,
      granularity,
      ts_minute AS tsMinute,
      open,
      high,
      low,
      close,
      vol,
      amount,
      fetched_at AS fetchedAt
    FROM free_minute_cache
    WHERE provider_id = ? AND ts_code = ? AND trade_date = ? AND granularity = ?
    ORDER BY ts_minute ASC
  `).all(providerId, tsCode, tradeDate, granularity) as FreeMinuteCacheRow[]
}