import type Database from 'better-sqlite3'
import type {
  TopInstDailyRow,
  TopInstSyncCoverageRow,
} from './types'

interface TopInstDbRow {
  trade_date: string
  ts_code: string
  institution_name: string
  side: 0 | 1
  buy_amount: number | null
  buy_rate: number | null
  sell_amount: number | null
  sell_rate: number | null
  net_amount: number | null
  reason: string
  fetched_at: number
}

interface TopInstCoverageDbRow {
  trade_date: string
  status: 'success' | 'failed'
  row_count: number
  error_code: string | null
  attempted_at: number
  completed_at: number | null
}

function normalizeText(value: string | null): string {
  return value?.trim().replace(/\s+/g, ' ') ?? ''
}

function buildRecordKey(row: TopInstDailyRow): string {
  return JSON.stringify([
    normalizeText(row.exalter),
    normalizeText(row.reason),
    row.buy,
    row.buyRate,
    row.sell,
    row.sellRate,
    row.netBuy,
  ])
}

function mapDetailRow(row: TopInstDbRow): TopInstDailyRow {
  return {
    tradeDate: row.trade_date,
    tsCode: row.ts_code,
    exalter: row.institution_name || null,
    side: row.side,
    buy: row.buy_amount,
    buyRate: row.buy_rate,
    sell: row.sell_amount,
    sellRate: row.sell_rate,
    netBuy: row.net_amount,
    reason: row.reason || null,
    fetchedAt: row.fetched_at,
  }
}

function mapCoverageRow(row: TopInstCoverageDbRow): TopInstSyncCoverageRow {
  return {
    tradeDate: row.trade_date,
    status: row.status,
    rowCount: row.row_count,
    errorCode: row.error_code,
    attemptedAt: row.attempted_at,
    completedAt: row.completed_at,
  }
}

export function replaceTopInstForTradeDate(
  db: Database.Database,
  tradeDate: string,
  rows: TopInstDailyRow[],
  completedAt = Date.now(),
): number {
  const validRows = rows.filter(
    (row): row is TopInstDailyRow & { side: 0 | 1 } =>
      row.tradeDate === tradeDate && (row.side === 0 || row.side === 1),
  )
  const deleteStatement = db.prepare('DELETE FROM top_inst_daily WHERE trade_date = ?')
  const insertStatement = db.prepare(`
    INSERT OR REPLACE INTO top_inst_daily (
      trade_date, ts_code, institution_name, side,
      buy_amount, buy_rate, sell_amount, sell_rate, net_amount,
      reason, record_key, fetched_at
    ) VALUES (
      @tradeDate, @tsCode, @institutionName, @side,
      @buyAmount, @buyRate, @sellAmount, @sellRate, @netAmount,
      @reason, @recordKey, @fetchedAt
    )
  `)
  const coverageStatement = db.prepare(`
    INSERT OR REPLACE INTO top_inst_sync_coverage (
      trade_date, status, row_count, error_code, attempted_at, completed_at
    ) VALUES (?, 'success', ?, NULL, ?, ?)
  `)
  const replaceAll = db.transaction(() => {
    deleteStatement.run(tradeDate)
    for (const row of validRows) {
      insertStatement.run({
        tradeDate,
        tsCode: row.tsCode.trim().toUpperCase(),
        institutionName: normalizeText(row.exalter),
        side: row.side,
        buyAmount: row.buy,
        buyRate: row.buyRate,
        sellAmount: row.sell,
        sellRate: row.sellRate,
        netAmount: row.netBuy,
        reason: normalizeText(row.reason),
        recordKey: buildRecordKey(row),
        fetchedAt: row.fetchedAt || completedAt,
      })
    }
    coverageStatement.run(tradeDate, validRows.length, completedAt, completedAt)
  })
  replaceAll()
  return validRows.length
}

export function recordTopInstSyncFailure(
  db: Database.Database,
  tradeDate: string,
  errorCode: string,
  attemptedAt = Date.now(),
): void {
  const existing = getTopInstCoverage(db, tradeDate)
  if (existing?.status === 'success') return
  db.prepare(`
    INSERT OR REPLACE INTO top_inst_sync_coverage (
      trade_date, status, row_count, error_code, attempted_at, completed_at
    ) VALUES (?, 'failed', 0, ?, ?, NULL)
  `).run(tradeDate, errorCode, attemptedAt)
}

export function getTopInstByStockAndDate(
  db: Database.Database,
  tsCode: string,
  tradeDate: string,
): TopInstDailyRow[] {
  const rows = db.prepare(`
    SELECT * FROM top_inst_daily
    WHERE ts_code = ? AND trade_date = ?
    ORDER BY institution_name, reason, side
  `).all(tsCode.trim().toUpperCase(), tradeDate) as TopInstDbRow[]
  return rows.map(mapDetailRow)
}

export function getTopInstCoverage(
  db: Database.Database,
  tradeDate: string,
): TopInstSyncCoverageRow | null {
  const row = db.prepare(`
    SELECT * FROM top_inst_sync_coverage WHERE trade_date = ?
  `).get(tradeDate) as TopInstCoverageDbRow | undefined
  return row ? mapCoverageRow(row) : null
}

export function cleanupTopInstDaily(db: Database.Database, daysToKeep = 180): number {
  const thresholdMs = Date.now() - daysToKeep * 24 * 60 * 60 * 1000
  const bjDate = new Date(thresholdMs + 8 * 60 * 60 * 1000)
  const threshold = bjDate.toISOString().slice(0, 10).replace(/-/g, '')
  const cleanup = db.transaction(() => {
    const detailChanges = db
      .prepare('DELETE FROM top_inst_daily WHERE trade_date < ?')
      .run(threshold).changes
    db.prepare('DELETE FROM top_inst_sync_coverage WHERE trade_date < ?').run(threshold)
    return detailChanges
  })
  return cleanup()
}