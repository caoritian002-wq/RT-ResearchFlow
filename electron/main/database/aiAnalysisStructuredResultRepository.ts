import type { Database } from 'better-sqlite3'
import type { AIAnalysisStructuredResultRow, AIAnalysisStructuredResultStatus } from './types'

export interface UpsertStructuredResultParams {
  sessionId: number
  schemaVersion: number
  status: AIAnalysisStructuredResultStatus
  summary: string | null
  confidence: number | null
  primaryTheme: string | null
  themesJson: string
  candidateStocksJson: string
  riskFactorsJson: string
  verificationItemsJson: string
  sourceRefsJson: string
  rawJson: string | null
  errorMessage: string | null
  generatedAt: number | null
}

export interface StructuredResultStatusSummary {
  sessionId: number
  status: AIAnalysisStructuredResultStatus
  updatedAt: number
}

function mapRow(row: any): AIAnalysisStructuredResultRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    schemaVersion: row.schema_version,
    status: row.status,
    summary: row.summary,
    confidence: row.confidence,
    primaryTheme: row.primary_theme,
    themesJson: row.themes_json,
    candidateStocksJson: row.candidate_stocks_json,
    riskFactorsJson: row.risk_factors_json,
    verificationItemsJson: row.verification_items_json,
    sourceRefsJson: row.source_refs_json,
    rawJson: row.raw_json,
    errorMessage: row.error_message,
    generatedAt: row.generated_at,
    updatedAt: row.updated_at
  }
}

export function upsertStructuredResult(db: Database, params: UpsertStructuredResultParams): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO ai_analysis_structured_results (
      session_id, schema_version, status, summary, confidence, primary_theme,
      themes_json, candidate_stocks_json, risk_factors_json, verification_items_json,
      source_refs_json, raw_json, error_message, generated_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      schema_version = excluded.schema_version,
      status = excluded.status,
      summary = excluded.summary,
      confidence = excluded.confidence,
      primary_theme = excluded.primary_theme,
      themes_json = excluded.themes_json,
      candidate_stocks_json = excluded.candidate_stocks_json,
      risk_factors_json = excluded.risk_factors_json,
      verification_items_json = excluded.verification_items_json,
      source_refs_json = excluded.source_refs_json,
      raw_json = excluded.raw_json,
      error_message = excluded.error_message,
      generated_at = excluded.generated_at,
      updated_at = excluded.updated_at`
  ).run(
    params.sessionId,
    params.schemaVersion,
    params.status,
    params.summary,
    params.confidence,
    params.primaryTheme,
    params.themesJson,
    params.candidateStocksJson,
    params.riskFactorsJson,
    params.verificationItemsJson,
    params.sourceRefsJson,
    params.rawJson,
    params.errorMessage,
    params.generatedAt,
    now
  )
}

export function getStructuredResultBySessionId(db: Database, sessionId: number): AIAnalysisStructuredResultRow | null {
  const row = db
    .prepare('SELECT * FROM ai_analysis_structured_results WHERE session_id = ?')
    .get(sessionId)
  return row ? mapRow(row) : null
}

export function listStructuredStatusBySessionIds(
  db: Database,
  sessionIds: number[]
): Map<number, StructuredResultStatusSummary> {
  if (sessionIds.length === 0) return new Map()
  const placeholders = sessionIds.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT session_id, status, updated_at FROM ai_analysis_structured_results WHERE session_id IN (${placeholders})`)
    .all(...sessionIds) as Array<{ session_id: number; status: AIAnalysisStructuredResultStatus; updated_at: number }>
  return new Map(rows.map((row) => [row.session_id, {
    sessionId: row.session_id,
    status: row.status,
    updatedAt: row.updated_at
  }]))
}

export function deleteStructuredResultBySessionId(db: Database, sessionId: number): void {
  db.prepare('DELETE FROM ai_analysis_structured_results WHERE session_id = ?').run(sessionId)
}