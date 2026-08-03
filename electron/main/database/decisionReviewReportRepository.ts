import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type {
  DecisionReviewReportKind,
  DecisionReviewReportSnapshot,
  SavedReviewReportDetail,
  SavedReviewReportSummary,
} from './types'

export const REVIEW_REPORT_SCHEMA_VERSION = 1
export const REVIEW_REPORT_MAX_BYTES = 512 * 1024

export type DecisionReviewReportRepositoryErrorCode =
  | 'INVALID_PARAM'
  | 'PAYLOAD_TOO_LARGE'
  | 'NOT_FOUND'
  | 'UNSUPPORTED_SCHEMA'
  | 'CORRUPT_DATA'

export class DecisionReviewReportRepositoryError extends Error {
  constructor(public readonly code: DecisionReviewReportRepositoryErrorCode, message: string) {
    super(message)
    this.name = 'DecisionReviewReportRepositoryError'
  }
}

export interface SaveReviewReportInput {
  requestId: string
  periodStart: string
  periodEnd: string
  report: unknown
}

export interface ListReviewReportsInput {
  kind?: DecisionReviewReportKind
  periodStart?: string
  periodEnd?: string
  includeAllVersions?: boolean
  offset?: number
  limit?: number
}

export interface ReviewReportListResult {
  items: SavedReviewReportSummary[]
  total: number
  offset: number
  limit: number
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function invalid(message: string): never {
  throw new DecisionReviewReportRepositoryError('INVALID_PARAM', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') invalid(`${field} 必须为非空文本`)
  return value.trim()
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) invalid(`${field} 必须为非负整数`)
  return value as number
}

function validateDate(value: unknown, field: string): string {
  const date = requireText(value, field)
  if (!DATE_PATTERN.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) invalid(`${field} 日期无效`)
  return date
}

function validateSnapshot(value: unknown, now: number): DecisionReviewReportSnapshot {
  if (!isRecord(value)) invalid('report 必须为对象')
  if (value.kind !== 'daily' && value.kind !== 'weekly') invalid('report.kind 无效')
  if (!Number.isInteger(value.rangeDays) || (value.rangeDays as number) < 1) invalid('report.rangeDays 无效')
  if (!Number.isInteger(value.generatedAt) || (value.generatedAt as number) < 0) invalid('report.generatedAt 无效')
  if ((value.generatedAt as number) > now + 5 * 60 * 1000) invalid('report.generatedAt 超出允许范围')
  requireText(value.title, 'report.title')
  requireText(value.headline, 'report.headline')
  requireText(value.disclaimer, 'report.disclaimer')
  if (typeof value.emptyDay !== 'boolean') invalid('report.emptyDay 无效')
  if (!isRecord(value.summary)) invalid('report.summary 必须为对象')
  for (const field of ['holdingCount', 'portfolioSignalCount', 'processedCount', 'openRiskCount', 'evidenceGapCount', 'followUpCount']) {
    requireNonNegativeInteger(value.summary[field], `report.summary.${field}`)
  }
  for (const field of ['processed', 'openRisks', 'evidenceGaps', 'followUps']) {
    if (!Array.isArray(value[field])) invalid(`report.${field} 必须为数组`)
    for (const item of value[field] as unknown[]) {
      if (!isRecord(item)) invalid(`report.${field} 包含无效条目`)
    }
  }
  return value as unknown as DecisionReviewReportSnapshot
}

function validatePeriod(kind: DecisionReviewReportKind, periodStart: string, periodEnd: string, rangeDays: number): void {
  if (periodStart > periodEnd) invalid('periodStart 不得晚于 periodEnd')
  if (kind === 'daily' && (periodStart !== periodEnd || rangeDays !== 1)) invalid('日报周期必须为同一天')
  if (kind === 'weekly' && rangeDays !== 7) invalid('周报 rangeDays 必须为 7')
  const actualDays = Math.round((Date.parse(`${periodEnd}T00:00:00Z`) - Date.parse(`${periodStart}T00:00:00Z`)) / 86_400_000) + 1
  if (kind === 'weekly' && Math.abs(actualDays - rangeDays) > 1) invalid('周报日期范围与 rangeDays 不一致')
}

function summarySelect(alias = 'r'): string {
  return `
    ${alias}.id, ${alias}.kind, ${alias}.period_start, ${alias}.period_end,
    ${alias}.range_days, ${alias}.generated_at, ${alias}.saved_at,
    ${alias}.schema_version, ${alias}.title, ${alias}.headline,
    ${alias}.open_risk_count, ${alias}.evidence_gap_count, ${alias}.follow_up_count,
    ${alias}.version_number,
    COUNT(*) OVER (
      PARTITION BY ${alias}.kind, ${alias}.period_start, ${alias}.period_end
    ) AS version_count
  `
}

function mapSummary(row: Record<string, unknown>): SavedReviewReportSummary {
  return {
    id: row.id as string,
    kind: row.kind as DecisionReviewReportKind,
    periodStart: row.period_start as string,
    periodEnd: row.period_end as string,
    rangeDays: row.range_days as number,
    generatedAt: row.generated_at as number,
    savedAt: row.saved_at as number,
    schemaVersion: row.schema_version as number,
    title: row.title as string,
    headline: row.headline as string,
    openRiskCount: row.open_risk_count as number,
    evidenceGapCount: row.evidence_gap_count as number,
    followUpCount: row.follow_up_count as number,
    versionNumber: row.version_number as number,
    versionCount: row.version_count as number,
  }
}

export function saveReviewReport(
  db: Database.Database,
  input: SaveReviewReportInput,
  now = Date.now(),
): SavedReviewReportSummary {
  const requestId = requireText(input.requestId, 'requestId')
  if (!UUID_PATTERN.test(requestId)) invalid('requestId 必须为 UUID')
  const periodStart = validateDate(input.periodStart, 'periodStart')
  const periodEnd = validateDate(input.periodEnd, 'periodEnd')
  const report = validateSnapshot(input.report, now)
  validatePeriod(report.kind, periodStart, periodEnd, report.rangeDays)

  const snapshotJson = JSON.stringify(report)
  if (Buffer.byteLength(snapshotJson, 'utf8') > REVIEW_REPORT_MAX_BYTES) {
    throw new DecisionReviewReportRepositoryError('PAYLOAD_TOO_LARGE', '报告快照超过 512 KiB')
  }

  const save = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM decision_review_reports WHERE request_id = ?').get(requestId) as { id: string } | undefined
    if (existing) return existing.id
    const id = randomUUID()
    const versionNumber = (db.prepare(`
      SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
      FROM decision_review_reports
      WHERE kind = ? AND period_start = ? AND period_end = ?
    `).get(report.kind, periodStart, periodEnd) as { next_version: number }).next_version
    db.prepare(`
      INSERT INTO decision_review_reports (
        id, request_id, kind, period_start, period_end, range_days, generated_at, saved_at,
        schema_version, title, headline, open_risk_count, evidence_gap_count, follow_up_count,
        version_number, snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, requestId, report.kind, periodStart, periodEnd, report.rangeDays, report.generatedAt, now,
      REVIEW_REPORT_SCHEMA_VERSION, report.title, report.headline, report.summary.openRiskCount,
      report.summary.evidenceGapCount, report.summary.followUpCount, versionNumber, snapshotJson,
    )
    return id
  })

  const id = save()
  return getReviewReportSummary(db, id)
}

export function getReviewReportSummary(db: Database.Database, id: string): SavedReviewReportSummary {
  const row = db.prepare(`
    SELECT * FROM (SELECT ${summarySelect('r')} FROM decision_review_reports r) versions
    WHERE id = ?
  `).get(id) as Record<string, unknown> | undefined
  if (!row) throw new DecisionReviewReportRepositoryError('NOT_FOUND', '复盘报告不存在')
  return mapSummary(row)
}

export function listReviewReports(db: Database.Database, input: ListReviewReportsInput = {}): ReviewReportListResult {
  if (input.kind != null && input.kind !== 'daily' && input.kind !== 'weekly') invalid('kind 无效')
  const offset = input.offset ?? 0
  const limit = input.limit ?? 30
  if (!Number.isInteger(offset) || offset < 0) invalid('offset 必须为非负整数')
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('limit 必须在 1 到 100 之间')

  const where: string[] = []
  const params: unknown[] = []
  if (input.kind) {
    where.push('kind = ?')
    params.push(input.kind)
  }
  if (input.periodStart) {
    where.push('period_start >= ?')
    params.push(validateDate(input.periodStart, 'periodStart'))
  }
  if (input.periodEnd) {
    where.push('period_end <= ?')
    params.push(validateDate(input.periodEnd, 'periodEnd'))
  }
  const filterSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rankedSql = `SELECT ${summarySelect('r')} FROM decision_review_reports r ${filterSql}`
  const visibleSql = input.includeAllVersions
    ? rankedSql
    : `SELECT * FROM (${rankedSql}) ranked WHERE version_number = (
        SELECT MAX(latest.version_number)
        FROM decision_review_reports latest
        WHERE latest.kind = ranked.kind
          AND latest.period_start = ranked.period_start
          AND latest.period_end = ranked.period_end
      )`
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM (${visibleSql})`).get(...params) as { count: number }).count
  const rows = db.prepare(`
    SELECT * FROM (${visibleSql}) visible
    ORDER BY generated_at DESC, saved_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Record<string, unknown>[]
  return { items: rows.map(mapSummary), total, offset, limit }
}

export function getReviewReport(db: Database.Database, id: string): SavedReviewReportDetail {
  const summary = getReviewReportSummary(db, requireText(id, 'id'))
  if (summary.schemaVersion !== REVIEW_REPORT_SCHEMA_VERSION) {
    throw new DecisionReviewReportRepositoryError('UNSUPPORTED_SCHEMA', '复盘报告版本暂不支持')
  }
  const row = db.prepare('SELECT snapshot_json FROM decision_review_reports WHERE id = ?').get(id) as { snapshot_json: string }
  try {
    const snapshot = validateSnapshot(JSON.parse(row.snapshot_json) as unknown, Number.MAX_SAFE_INTEGER)
    return { ...summary, snapshot }
  } catch (error) {
    if (error instanceof DecisionReviewReportRepositoryError && error.code === 'INVALID_PARAM') {
      throw new DecisionReviewReportRepositoryError('CORRUPT_DATA', '复盘报告快照结构损坏')
    }
    if (error instanceof SyntaxError) {
      throw new DecisionReviewReportRepositoryError('CORRUPT_DATA', '复盘报告快照 JSON 损坏')
    }
    throw error
  }
}

export function deleteReviewReport(db: Database.Database, id: string): { id: string } {
  const normalizedId = requireText(id, 'id')
  const info = db.prepare('DELETE FROM decision_review_reports WHERE id = ?').run(normalizedId)
  if (info.changes === 0) throw new DecisionReviewReportRepositoryError('NOT_FOUND', '复盘报告不存在')
  return { id: normalizedId }
}