import type Database from 'better-sqlite3'
import type { AIProvider, ScreenerInsightRow } from './types'

interface DbRow {
  id: number
  trade_date: string
  ts_code: string
  stock_name: string | null
  evidence_hash: string
  evidence_json: string
  insight_json: string
  provider: AIProvider | null
  model: string | null
  usage_json: string | null
  finish_reason: string | null
  compliance_blocked: number
  created_at: number
  updated_at: number
}

export interface ScreenerInsightUpsert {
  tradeDate: string
  tsCode: string
  stockName: string | null
  evidenceHash: string
  evidenceJson: string
  insightJson: string
  provider: AIProvider | null
  model: string | null
  usageJson: string | null
  finishReason: string | null
  complianceBlocked: boolean
  createdAt?: number
  updatedAt?: number
}

function mapRow(row: DbRow): ScreenerInsightRow {
  return {
    id: row.id,
    tradeDate: row.trade_date,
    tsCode: row.ts_code,
    stockName: row.stock_name,
    evidenceHash: row.evidence_hash,
    evidenceJson: row.evidence_json,
    insightJson: row.insight_json,
    provider: row.provider,
    model: row.model,
    usageJson: row.usage_json,
    finishReason: row.finish_reason,
    complianceBlocked: row.compliance_blocked,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function normalizeCode(tsCode: string): string {
  return tsCode.trim().toUpperCase()
}

function codeCandidates(tsCode: string): string[] {
  const clean = normalizeCode(tsCode)
  const stripped = clean.replace(/\.(SH|SZ|BJ)$/i, '')
  return Array.from(new Set([clean, stripped]))
}

export function getScreenerInsight(
  db: Database.Database,
  tradeDate: string,
  tsCode: string,
  evidenceHash: string,
): ScreenerInsightRow | null {
  const candidates = codeCandidates(tsCode)
  const placeholders = candidates.map(() => '?').join(',')
  const row = db.prepare(
    `SELECT * FROM screener_insights
     WHERE trade_date = ? AND evidence_hash = ? AND ts_code IN (${placeholders})
     ORDER BY updated_at DESC
     LIMIT 1`,
  ).get(tradeDate, evidenceHash, ...candidates) as DbRow | undefined
  return row ? mapRow(row) : null
}

export function listScreenerInsightsByDate(
  db: Database.Database,
  tradeDate: string,
): ScreenerInsightRow[] {
  const rows = db.prepare(
    `SELECT * FROM screener_insights
     WHERE trade_date = ?
     ORDER BY updated_at DESC, id DESC`,
  ).all(tradeDate) as DbRow[]
  return rows.map(mapRow)
}

export function upsertScreenerInsight(
  db: Database.Database,
  input: ScreenerInsightUpsert,
): ScreenerInsightRow {
  const now = Date.now()
  const createdAt = input.createdAt ?? now
  const updatedAt = input.updatedAt ?? now
  db.prepare(
    `INSERT INTO screener_insights (
       trade_date, ts_code, stock_name, evidence_hash, evidence_json, insight_json,
       provider, model, usage_json, finish_reason, compliance_blocked, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(trade_date, ts_code, evidence_hash) DO UPDATE SET
       stock_name = excluded.stock_name,
       evidence_json = excluded.evidence_json,
       insight_json = excluded.insight_json,
       provider = excluded.provider,
       model = excluded.model,
       usage_json = excluded.usage_json,
       finish_reason = excluded.finish_reason,
       compliance_blocked = excluded.compliance_blocked,
       updated_at = excluded.updated_at`,
  ).run(
    input.tradeDate,
    normalizeCode(input.tsCode),
    input.stockName,
    input.evidenceHash,
    input.evidenceJson,
    input.insightJson,
    input.provider,
    input.model,
    input.usageJson,
    input.finishReason,
    input.complianceBlocked ? 1 : 0,
    createdAt,
    updatedAt,
  )

  const row = getScreenerInsight(db, input.tradeDate, input.tsCode, input.evidenceHash)
  if (!row) throw new Error('screener insight not found after upsert')
  return row
}

export function cleanupScreenerInsights(db: Database.Database, days = 90): number {
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const threshold = new Date(bjNow.getTime() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '')
  const info = db.prepare('DELETE FROM screener_insights WHERE trade_date < ?').run(threshold)
  return info.changes
}