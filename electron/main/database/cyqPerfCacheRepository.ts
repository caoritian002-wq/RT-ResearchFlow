import type Database from 'better-sqlite3'
import type { CyqPerfCacheRow } from './types'
import type { CyqPerfRow } from '../services/tushareService'

interface CyqPerfDbRow {
  ts_code: string
  trade_date: string
  his_low: number | null
  his_high: number | null
  cost_5pct: number | null
  cost_15pct: number | null
  cost_50pct: number | null
  cost_85pct: number | null
  cost_95pct: number | null
  weight_avg: number | null
  winner_rate: number | null
  winner_rate_unit: 'percent' | 'ratio'
  fetched_at: number
}

function mapRow(row: CyqPerfDbRow): CyqPerfCacheRow {
  return {
    tsCode: row.ts_code,
    tradeDate: row.trade_date,
    hisLow: row.his_low,
    hisHigh: row.his_high,
    cost5Pct: row.cost_5pct,
    cost15Pct: row.cost_15pct,
    cost50Pct: row.cost_50pct,
    cost85Pct: row.cost_85pct,
    cost95Pct: row.cost_95pct,
    weightAvg: row.weight_avg,
    winnerRate: row.winner_rate,
    winnerRateUnit: row.winner_rate_unit,
    fetchedAt: row.fetched_at,
  }
}

export function upsertCyqPerf(
  db: Database.Database,
  rows: CyqPerfRow[],
  fetchedAt = Date.now(),
): void {
  if (rows.length === 0) return
  const statement = db.prepare(`
    INSERT OR REPLACE INTO cyq_perf_cache (
      ts_code, trade_date, his_low, his_high,
      cost_5pct, cost_15pct, cost_50pct, cost_85pct, cost_95pct,
      weight_avg, winner_rate, winner_rate_unit, fetched_at
    ) VALUES (
      @tsCode, @tradeDate, @hisLow, @hisHigh,
      @cost5Pct, @cost15Pct, @cost50Pct, @cost85Pct, @cost95Pct,
      @weightAvg, @winnerRate, 'percent', @fetchedAt
    )
  `)
  const runAll = db.transaction((items: CyqPerfRow[]) => {
    for (const row of items) statement.run({ ...row, fetchedAt })
  })
  runAll(rows)
}

export function getCyqPerf(
  db: Database.Database,
  tsCode: string,
  tradeDate: string,
): CyqPerfCacheRow | null {
  const row = db.prepare(`
    SELECT * FROM cyq_perf_cache
    WHERE ts_code = ? AND trade_date = ?
  `).get(tsCode, tradeDate) as CyqPerfDbRow | undefined
  return row ? mapRow(row) : null
}

export function getLatestCyqPerf(
  db: Database.Database,
  tsCode: string,
): CyqPerfCacheRow | null {
  const row = db.prepare(`
    SELECT * FROM cyq_perf_cache
    WHERE ts_code = ?
    ORDER BY trade_date DESC
    LIMIT 1
  `).get(tsCode) as CyqPerfDbRow | undefined
  return row ? mapRow(row) : null
}

export function listCyqPerfHistory(
  db: Database.Database,
  tsCode: string,
  limit = 20,
): CyqPerfCacheRow[] {
  const rows = db.prepare(`
    SELECT * FROM cyq_perf_cache
    WHERE ts_code = ?
    ORDER BY trade_date DESC
    LIMIT ?
  `).all(tsCode, Math.max(1, limit)) as CyqPerfDbRow[]
  return rows.map(mapRow)
}

/** 批量查询多只股票最近若干个官方成本交易日，按日期升序返回。 */
export function listCyqPerfHistories(
  db: Database.Database,
  tsCodes: string[],
  limit = 30,
  tradeDate?: string,
): Map<string, CyqPerfCacheRow[]> {
  const result = new Map<string, CyqPerfCacheRow[]>()
  if (tsCodes.length === 0) return result

  const aliases = [...new Set(tsCodes.flatMap((tsCode) => [tsCode, tsCode.split('.')[0]]))]
  const placeholders = aliases.map(() => '?').join(', ')
  const rows = (tradeDate
    ? db.prepare(`
        SELECT * FROM cyq_perf_cache
        WHERE ts_code IN (${placeholders}) AND trade_date = ?
        ORDER BY ts_code ASC
      `).all(...aliases, tradeDate)
    : db.prepare(`
        SELECT * FROM (
          SELECT perf.*,
                 ROW_NUMBER() OVER (PARTITION BY ts_code ORDER BY trade_date DESC) AS date_rank
          FROM cyq_perf_cache perf
          WHERE ts_code IN (${placeholders})
        )
        WHERE date_rank <= ?
        ORDER BY ts_code ASC, trade_date ASC
      `).all(...aliases, Math.max(1, limit))) as Array<CyqPerfDbRow & { date_rank?: number }>

  const byStoredCode = new Map<string, CyqPerfCacheRow[]>()
  for (const row of rows) {
    const history = byStoredCode.get(row.ts_code) ?? []
    history.push(mapRow(row))
    byStoredCode.set(row.ts_code, history)
  }
  for (const tsCode of tsCodes) {
    const exact = byStoredCode.get(tsCode)
    const fallback = byStoredCode.get(tsCode.split('.')[0])
    const rowsByDate = new Map<string, CyqPerfCacheRow>()
    for (const row of fallback ?? []) rowsByDate.set(row.tradeDate, row)
    for (const row of exact ?? []) rowsByDate.set(row.tradeDate, row)
    result.set(tsCode, [...rowsByDate.values()].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate)))
  }
  return result
}

export function cleanupCyqPerfCache(db: Database.Database, daysToKeep = 90): number {
  const thresholdMs = Date.now() - daysToKeep * 24 * 60 * 60 * 1000
  const bjDate = new Date(thresholdMs + 8 * 60 * 60 * 1000)
  const threshold = bjDate.toISOString().slice(0, 10).replace(/-/g, '')
  return db.prepare('DELETE FROM cyq_perf_cache WHERE trade_date < ?').run(threshold).changes
}