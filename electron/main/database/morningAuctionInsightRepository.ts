import type { Database } from 'better-sqlite3'
import type {
  MorningAuctionChipStatus,
  MorningAuctionInsightRow,
  MorningAuctionInsightStatus,
  MorningAuctionVerificationItem,
  MorningAuctionVerificationStatus
} from './types'

export interface UpsertMorningAuctionInsightParams {
  tradeDate: string
  tsCode: string
  stockName: string
  poolKey: string
  schemaVersion: number
  score: number
  scoreBreakdownJson: string
  entryReasonsJson: string
  verificationItemsJson: string
  riskFlagsJson: string
  intradayPreviewJson: string | null
  backtestSummaryJson: string | null
  chipStatus: MorningAuctionChipStatus
  status: MorningAuctionInsightStatus
  errorMessage: string | null
  generatedAt: number
}

export interface MorningAuctionInsightStatusSummary {
  tradeDate: string
  generatedAt: number | null
  completedCount: number
  missingCount: number
  blockedVerificationCount: number
}

export function filterMorningAuctionInsightsBySchema(
  rows: MorningAuctionInsightRow[],
  schemaVersion: number
): MorningAuctionInsightRow[] {
  return rows.filter((row) => row.schemaVersion === schemaVersion)
}

export function getExistingVerificationJsonForSchema(
  existing: MorningAuctionInsightRow | null,
  schemaVersion: number
): string | null {
  return existing?.schemaVersion === schemaVersion ? existing.verificationItemsJson : null
}

function mapRow(row: any): MorningAuctionInsightRow {
  return {
    id: row.id,
    tradeDate: row.trade_date,
    tsCode: row.ts_code,
    stockName: row.stock_name,
    poolKey: row.pool_key,
    schemaVersion: row.schema_version,
    score: row.score,
    scoreBreakdownJson: row.score_breakdown_json,
    entryReasonsJson: row.entry_reasons_json,
    verificationItemsJson: row.verification_items_json,
    riskFlagsJson: row.risk_flags_json,
    intradayPreviewJson: row.intraday_preview_json,
    backtestSummaryJson: row.backtest_summary_json,
    chipStatus: row.chip_status,
    status: row.status,
    errorMessage: row.error_message,
    generatedAt: row.generated_at,
    updatedAt: row.updated_at
  }
}

function parseVerificationItems(json: string): MorningAuctionVerificationItem[] {
  try {
    const value = JSON.parse(json) as unknown
    return Array.isArray(value) ? value as MorningAuctionVerificationItem[] : []
  } catch {
    return []
  }
}

export function mergeManualVerificationItems(
  generatedJson: string,
  existingJson: string | null
): string {
  const generatedItems = parseVerificationItems(generatedJson)
  if (!existingJson) return JSON.stringify(generatedItems)
  const manualItems = new Map(
    parseVerificationItems(existingJson)
      .filter((item) => item.checkedByUser)
      .map((item) => [item.key, item])
  )
  return JSON.stringify(generatedItems.map((item) => {
    const manual = manualItems.get(item.key)
    if (!manual || item.status === 'blocked') return item
    return {
      ...item,
      status: manual.status,
      reason: manual.reason,
      updatedAt: manual.updatedAt,
      checkedByUser: true
    }
  }))
}

export function upsertMorningAuctionInsight(
  db: Database,
  params: UpsertMorningAuctionInsightParams
): MorningAuctionInsightRow {
  const existing = getMorningAuctionInsight(db, params.tradeDate, params.tsCode, params.poolKey)
  const verificationItemsJson = mergeManualVerificationItems(
    params.verificationItemsJson,
    getExistingVerificationJsonForSchema(existing, params.schemaVersion)
  )
  const now = Date.now()
  db.prepare(
    `INSERT INTO morning_auction_insights (
      trade_date, ts_code, stock_name, pool_key, schema_version, score,
      score_breakdown_json, entry_reasons_json, verification_items_json,
      risk_flags_json, intraday_preview_json, backtest_summary_json,
      chip_status, status, error_message, generated_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(trade_date, ts_code, pool_key) DO UPDATE SET
      stock_name = excluded.stock_name,
      schema_version = excluded.schema_version,
      score = excluded.score,
      score_breakdown_json = excluded.score_breakdown_json,
      entry_reasons_json = excluded.entry_reasons_json,
      verification_items_json = excluded.verification_items_json,
      risk_flags_json = excluded.risk_flags_json,
      intraday_preview_json = excluded.intraday_preview_json,
      backtest_summary_json = excluded.backtest_summary_json,
      chip_status = excluded.chip_status,
      status = excluded.status,
      error_message = excluded.error_message,
      generated_at = excluded.generated_at,
      updated_at = excluded.updated_at`
  ).run(
    params.tradeDate,
    params.tsCode,
    params.stockName,
    params.poolKey,
    params.schemaVersion,
    params.score,
    params.scoreBreakdownJson,
    params.entryReasonsJson,
    verificationItemsJson,
    params.riskFlagsJson,
    params.intradayPreviewJson,
    params.backtestSummaryJson,
    params.chipStatus,
    params.status,
    params.errorMessage,
    params.generatedAt,
    now
  )
  return getMorningAuctionInsight(db, params.tradeDate, params.tsCode, params.poolKey) as MorningAuctionInsightRow
}

export function listMorningAuctionInsightsByDate(
  db: Database,
  tradeDate: string
): MorningAuctionInsightRow[] {
  return (db.prepare(
    'SELECT * FROM morning_auction_insights WHERE trade_date = ? ORDER BY score DESC, ts_code, pool_key'
  ).all(tradeDate) as any[]).map(mapRow)
}

export function getMorningAuctionInsight(
  db: Database,
  tradeDate: string,
  tsCode: string,
  poolKey: string
): MorningAuctionInsightRow | null {
  const row = db.prepare(
    'SELECT * FROM morning_auction_insights WHERE trade_date = ? AND ts_code = ? AND pool_key = ?'
  ).get(tradeDate, tsCode, poolKey)
  return row ? mapRow(row) : null
}

export function updateMorningAuctionVerificationItem(
  db: Database,
  input: {
    tradeDate: string
    tsCode: string
    poolKey: string
    itemKey: string
    status: MorningAuctionVerificationStatus
    reason?: string
  }
): MorningAuctionInsightRow | null {
  const row = getMorningAuctionInsight(db, input.tradeDate, input.tsCode, input.poolKey)
  if (!row) return null
  const now = Date.now()
  let matched = false
  const items = parseVerificationItems(row.verificationItemsJson).map((item) => {
    if (item.key !== input.itemKey) return item
    matched = true
    return {
      ...item,
      status: input.status,
      reason: input.reason?.trim() || item.reason,
      updatedAt: now,
      checkedByUser: true
    }
  })
  if (!matched) return null
  db.prepare(
    `UPDATE morning_auction_insights
     SET verification_items_json = ?, updated_at = ?
     WHERE trade_date = ? AND ts_code = ? AND pool_key = ?`
  ).run(JSON.stringify(items), now, input.tradeDate, input.tsCode, input.poolKey)
  return getMorningAuctionInsight(db, input.tradeDate, input.tsCode, input.poolKey)
}

export function listMorningAuctionInsightStatus(
  db: Database,
  tradeDate: string,
  expectedCount = 0,
  schemaVersion?: number,
): MorningAuctionInsightStatusSummary {
  const allRows = listMorningAuctionInsightsByDate(db, tradeDate)
  const rows = schemaVersion == null
    ? allRows
    : filterMorningAuctionInsightsBySchema(allRows, schemaVersion)
  const blockedVerificationCount = rows.reduce((count, row) => {
    return count + parseVerificationItems(row.verificationItemsJson)
      .filter((item) => item.status === 'blocked').length
  }, 0)
  return {
    tradeDate,
    generatedAt: rows.reduce<number | null>((latest, row) => latest == null || row.generatedAt > latest ? row.generatedAt : latest, null),
    completedCount: rows.filter((row) => row.status !== 'failed').length,
    missingCount: Math.max(0, expectedCount - rows.length),
    blockedVerificationCount
  }
}

export function deleteMorningAuctionInsightsByDate(db: Database, tradeDate: string): number {
  return db.prepare('DELETE FROM morning_auction_insights WHERE trade_date = ?').run(tradeDate).changes
}