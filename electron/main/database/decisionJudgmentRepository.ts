import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type {
  DecisionJudgmentDetail,
  DecisionJudgmentEvidenceSnapshot,
  DecisionJudgmentSummary,
  DecisionJudgmentTag,
} from './types'

export const DECISION_JUDGMENT_SCHEMA_VERSION = 1
export const DECISION_JUDGMENT_MAX_SNAPSHOT_BYTES = 256 * 1024

export type DecisionJudgmentRepositoryErrorCode =
  | 'INVALID_PARAM'
  | 'JUDGMENT_GROUP_NOT_FOUND'
  | 'JUDGMENT_GROUP_MISMATCH'
  | 'SNAPSHOT_TOO_LARGE'
  | 'UNSUPPORTED_SCHEMA'
  | 'CORRUPT_DATA'
  | 'NOT_FOUND'

export class DecisionJudgmentRepositoryError extends Error {
  constructor(public readonly code: DecisionJudgmentRepositoryErrorCode, message: string) {
    super(message)
    this.name = 'DecisionJudgmentRepositoryError'
  }
}

export interface SaveDecisionJudgmentInput {
  requestId: string
  judgmentGroupId?: string
  tsCode: string
  stockName?: string
  tag: DecisionJudgmentTag
  note?: string
  sourceSignalId?: number
  relatedSignalIds?: number[]
  evidenceSnapshot: DecisionJudgmentEvidenceSnapshot
  reviewDueAt?: number | null
}

export interface ListDecisionJudgmentsInput {
  tsCode?: string
  tags?: DecisionJudgmentTag[]
  from?: number
  to?: number
  latestPerGroup?: boolean
  limit?: number
  offset?: number
}

export interface DecisionJudgmentListResult {
  items: DecisionJudgmentSummary[]
  total: number
  limit: number
  offset: number
}

export interface DecisionJudgmentHistoryVersion extends DecisionJudgmentSummary {
  relatedSignalIds: number[]
  evidenceSnapshot: DecisionJudgmentEvidenceSnapshot
}

export interface DecisionJudgmentHistoryResult {
  judgmentId: string
  judgmentGroupId: string
  total: number
  versions: DecisionJudgmentHistoryVersion[]
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TS_CODE_PATTERN = /^\d{6}(?:\.(?:SH|SZ|BJ))?$/
const TAGS = new Set<DecisionJudgmentTag>(['watch', 'risk_off', 'noise', 'insufficient', 'done'])
const EVIDENCE_STATUSES = new Set(['ready', 'missing', 'blocked'])

function invalid(message: string): never {
  throw new DecisionJudgmentRepositoryError('INVALID_PARAM', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '') invalid(`${field} 必须为非空文本`)
  const normalized = value.trim()
  if (normalized.length > maxLength) invalid(`${field} 超出长度限制`)
  return normalized
}

function optionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value == null || value === '') return null
  return requireText(value, field, maxLength)
}

function validateUuid(value: unknown, field: string): string {
  const normalized = requireText(value, field, 64)
  if (!UUID_PATTERN.test(normalized)) invalid(`${field} 必须为 UUID`)
  return normalized
}

function validateTsCode(value: unknown): string {
  const normalized = requireText(value, 'tsCode', 16).toUpperCase()
  if (!TS_CODE_PATTERN.test(normalized)) invalid('tsCode 无效')
  return normalized
}

function validateTimestamp(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`${field} 必须为非负整数时间戳`)
  return value as number
}

function validateOptionalId(value: unknown, field: string): number | null {
  if (value == null) return null
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(`${field} 必须为正整数`)
  return value as number
}

function validateRelatedSignalIds(value: unknown): number[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 200) invalid('relatedSignalIds 无效')
  const ids = value.map((item) => validateOptionalId(item, 'relatedSignalIds 条目') as number)
  return [...new Set(ids)]
}

function validateEvidenceSnapshot(value: unknown): DecisionJudgmentEvidenceSnapshot {
  if (!isRecord(value)) invalid('evidenceSnapshot 必须为对象')
  const sourceCount = value.sourceCount
  const maxPriority = value.maxPriority
  if (!Number.isSafeInteger(sourceCount) || (sourceCount as number) < 0) invalid('evidenceSnapshot.sourceCount 无效')
  if (!Number.isSafeInteger(maxPriority) || (maxPriority as number) < 0 || (maxPriority as number) > 5) {
    invalid('evidenceSnapshot.maxPriority 无效')
  }
  if (!Array.isArray(value.evidence) || value.evidence.length > 100) invalid('evidenceSnapshot.evidence 无效')
  const evidence = value.evidence.map((item, index) => {
    if (!isRecord(item) || !EVIDENCE_STATUSES.has(item.status as string)) invalid(`evidenceSnapshot.evidence[${index}] 无效`)
    return {
      key: requireText(item.key, `evidenceSnapshot.evidence[${index}].key`, 80),
      label: requireText(item.label, `evidenceSnapshot.evidence[${index}].label`, 120),
      status: item.status as 'ready' | 'missing' | 'blocked',
      detail: requireText(item.detail, `evidenceSnapshot.evidence[${index}].detail`, 1_000),
    }
  })
  return {
    primaryTitle: requireText(value.primaryTitle, 'evidenceSnapshot.primaryTitle', 200),
    primarySummary: requireText(value.primarySummary, 'evidenceSnapshot.primarySummary', 2_000),
    sourceCount: sourceCount as number,
    maxPriority: maxPriority as number,
    trustHint: requireText(value.trustHint, 'evidenceSnapshot.trustHint', 500),
    evidence,
  }
}

function summarySelect(alias = 'j'): string {
  return `
    ${alias}.id, ${alias}.judgment_group_id, ${alias}.version_number,
    ${alias}.ts_code, ${alias}.stock_name, ${alias}.tag, ${alias}.note,
    ${alias}.source_signal_id, ${alias}.review_due_at, ${alias}.created_at,
    ${alias}.schema_version,
    COUNT(*) OVER (PARTITION BY ${alias}.judgment_group_id) AS version_count,
    CASE WHEN ${alias}.source_signal_id IS NULL THEN 0
         WHEN EXISTS (SELECT 1 FROM decision_signals s WHERE s.id = ${alias}.source_signal_id) THEN 1
         ELSE 0 END AS source_signal_available
  `
}

function mapSummary(row: Record<string, unknown>): DecisionJudgmentSummary {
  return {
    id: row.id as string,
    judgmentGroupId: row.judgment_group_id as string,
    versionNumber: row.version_number as number,
    tsCode: row.ts_code as string,
    stockName: (row.stock_name as string | null) ?? null,
    tag: row.tag as DecisionJudgmentTag,
    note: row.note as string,
    sourceSignalId: (row.source_signal_id as number | null) ?? null,
    reviewDueAt: (row.review_due_at as number | null) ?? null,
    createdAt: row.created_at as number,
    schemaVersion: row.schema_version as number,
    versionCount: row.version_count as number,
    sourceSignalAvailable: row.source_signal_available === 1,
  }
}

export function saveDecisionJudgmentVersion(
  db: Database.Database,
  input: SaveDecisionJudgmentInput,
  now = Date.now(),
): DecisionJudgmentSummary {
  const requestId = validateUuid(input.requestId, 'requestId')
  const requestedGroupId = input.judgmentGroupId == null ? null : validateUuid(input.judgmentGroupId, 'judgmentGroupId')
  const tsCode = validateTsCode(input.tsCode)
  const stockName = optionalText(input.stockName, 'stockName', 120)
  if (!TAGS.has(input.tag)) invalid('tag 无效')
  const note = input.note == null ? '' : String(input.note).trim()
  if (note.length > 4_000) invalid('note 超出长度限制')
  const sourceSignalId = validateOptionalId(input.sourceSignalId, 'sourceSignalId')
  const relatedSignalIds = validateRelatedSignalIds(input.relatedSignalIds)
  const evidenceSnapshot = validateEvidenceSnapshot(input.evidenceSnapshot)
  const reviewDueAt = input.reviewDueAt == null ? null : validateTimestamp(input.reviewDueAt, 'reviewDueAt')
  validateTimestamp(now, 'createdAt')

  const evidenceSnapshotJson = JSON.stringify(evidenceSnapshot)
  if (Buffer.byteLength(evidenceSnapshotJson, 'utf8') > DECISION_JUDGMENT_MAX_SNAPSHOT_BYTES) {
    throw new DecisionJudgmentRepositoryError('SNAPSHOT_TOO_LARGE', '证据快照超过 256 KiB')
  }
  const relatedSignalIdsJson = JSON.stringify(relatedSignalIds)

  const existing = db.prepare('SELECT id FROM decision_judgments WHERE request_id = ?').get(requestId) as { id: string } | undefined
  if (existing) return getDecisionJudgmentSummary(db, existing.id)

  const judgmentGroupId = requestedGroupId ?? randomUUID()
  let versionNumber = 1
  if (requestedGroupId) {
    const group = db.prepare(`
      SELECT ts_code, MAX(version_number) AS latest_version
      FROM decision_judgments
      WHERE judgment_group_id = ?
      GROUP BY ts_code
    `).get(requestedGroupId) as { ts_code: string; latest_version: number } | undefined
    if (!group) throw new DecisionJudgmentRepositoryError('JUDGMENT_GROUP_NOT_FOUND', '判断组不存在')
    if (group.ts_code !== tsCode) throw new DecisionJudgmentRepositoryError('JUDGMENT_GROUP_MISMATCH', '判断组股票不一致')
    versionNumber = group.latest_version + 1
  }

  const id = randomUUID()
  db.prepare(`
    INSERT INTO decision_judgments (
      id, request_id, judgment_group_id, version_number, ts_code, stock_name, tag, note,
      source_signal_id, related_signal_ids_json, evidence_snapshot_json, review_due_at,
      created_at, schema_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, requestId, judgmentGroupId, versionNumber, tsCode, stockName, input.tag, note,
    sourceSignalId, relatedSignalIdsJson, evidenceSnapshotJson, reviewDueAt, now,
    DECISION_JUDGMENT_SCHEMA_VERSION,
  )
  return getDecisionJudgmentSummary(db, id)
}

export function getDecisionJudgmentSummary(db: Database.Database, id: string): DecisionJudgmentSummary {
  const normalizedId = validateUuid(id, 'id')
  const row = db.prepare(`
    SELECT * FROM (SELECT ${summarySelect('j')} FROM decision_judgments j) summaries
    WHERE id = ?
  `).get(normalizedId) as Record<string, unknown> | undefined
  if (!row) throw new DecisionJudgmentRepositoryError('NOT_FOUND', '判断版本不存在')
  return mapSummary(row)
}

export function getDecisionJudgmentSummaryByRequestId(
  db: Database.Database,
  requestId: string,
): DecisionJudgmentSummary | null {
  const normalizedRequestId = validateUuid(requestId, 'requestId')
  const row = db.prepare(`
    SELECT * FROM (SELECT ${summarySelect('j')}, ${'j.request_id'} FROM decision_judgments j) summaries
    WHERE request_id = ?
  `).get(normalizedRequestId) as Record<string, unknown> | undefined
  return row ? mapSummary(row) : null
}

export function listDecisionJudgments(
  db: Database.Database,
  input: ListDecisionJudgmentsInput = {},
): DecisionJudgmentListResult {
  const limit = input.limit ?? 30
  const offset = input.offset ?? 0
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid('limit 必须在 1 到 100 之间')
  if (!Number.isSafeInteger(offset) || offset < 0) invalid('offset 必须为非负整数')
  if (input.tags != null && (!Array.isArray(input.tags) || input.tags.length === 0 || input.tags.some((tag) => !TAGS.has(tag)))) {
    invalid('tags 无效')
  }
  const where: string[] = []
  const params: unknown[] = []
  if (input.tsCode) {
    where.push('ts_code = ?')
    params.push(validateTsCode(input.tsCode))
  }
  if (input.tags?.length) {
    where.push(`tag IN (${input.tags.map(() => '?').join(',')})`)
    params.push(...input.tags)
  }
  if (input.from != null) {
    where.push('created_at >= ?')
    params.push(validateTimestamp(input.from, 'from'))
  }
  if (input.to != null) {
    where.push('created_at <= ?')
    params.push(validateTimestamp(input.to, 'to'))
  }
  const filterSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const baseSql = `SELECT ${summarySelect('j')} FROM decision_judgments j ${filterSql}`
  const visibleSql = input.latestPerGroup === false
    ? baseSql
    : `SELECT * FROM (${baseSql}) ranked WHERE version_number = (
        SELECT MAX(latest.version_number)
        FROM decision_judgments latest
        WHERE latest.judgment_group_id = ranked.judgment_group_id
      )`
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM (${visibleSql})`).get(...params) as { count: number }).count
  const rows = db.prepare(`
    SELECT * FROM (${visibleSql}) visible
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Record<string, unknown>[]
  return { items: rows.map(mapSummary), total, limit, offset }
}

export function getDecisionJudgment(db: Database.Database, id: string): DecisionJudgmentDetail {
  const summary = getDecisionJudgmentSummary(db, id)
  if (summary.schemaVersion !== DECISION_JUDGMENT_SCHEMA_VERSION) {
    throw new DecisionJudgmentRepositoryError('UNSUPPORTED_SCHEMA', '判断快照版本暂不支持')
  }
  const row = db.prepare(`
    SELECT related_signal_ids_json, evidence_snapshot_json
    FROM decision_judgments
    WHERE id = ?
  `).get(summary.id) as { related_signal_ids_json: string; evidence_snapshot_json: string }
  try {
    const relatedSignalIds = validateRelatedSignalIds(JSON.parse(row.related_signal_ids_json) as unknown)
    const evidenceSnapshot = validateEvidenceSnapshot(JSON.parse(row.evidence_snapshot_json) as unknown)
    const versionRows = db.prepare(`
      SELECT ${summarySelect('j')}
      FROM decision_judgments j
      WHERE judgment_group_id = ?
      ORDER BY version_number DESC
    `).all(summary.judgmentGroupId) as Record<string, unknown>[]
    return { ...summary, relatedSignalIds, evidenceSnapshot, versions: versionRows.map(mapSummary) }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new DecisionJudgmentRepositoryError('CORRUPT_DATA', '判断快照 JSON 损坏')
    }
    if (error instanceof DecisionJudgmentRepositoryError && error.code === 'INVALID_PARAM') {
      throw new DecisionJudgmentRepositoryError('CORRUPT_DATA', '判断快照结构损坏')
    }
    throw error
  }
}

export function getDecisionJudgmentHistoryAt(
  db: Database.Database,
  id: string,
  maxCreatedAt: number | null,
  limit = 10,
): DecisionJudgmentHistoryResult | null {
  const normalizedId = validateUuid(id, 'id')
  if (maxCreatedAt != null) validateTimestamp(maxCreatedAt, 'maxCreatedAt')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) invalid('limit 必须在 1 到 20 之间')
  const anchor = db.prepare(`
    SELECT id, judgment_group_id
    FROM decision_judgments
    WHERE id = ? AND (? IS NULL OR created_at <= ?)
  `).get(normalizedId, maxCreatedAt, maxCreatedAt) as { id: string; judgment_group_id: string } | undefined
  if (!anchor) return null

  const rows = db.prepare(`
    SELECT ${summarySelect('j')}, j.related_signal_ids_json, j.evidence_snapshot_json
    FROM decision_judgments j
    WHERE j.judgment_group_id = ? AND (? IS NULL OR j.created_at <= ?)
    ORDER BY j.version_number DESC
    LIMIT ?
  `).all(anchor.judgment_group_id, maxCreatedAt, maxCreatedAt, limit) as Array<Record<string, unknown> & {
    related_signal_ids_json: string
    evidence_snapshot_json: string
  }>
  try {
    const versions = rows.map((row) => {
      const summary = mapSummary(row)
      if (summary.schemaVersion !== DECISION_JUDGMENT_SCHEMA_VERSION) {
        throw new DecisionJudgmentRepositoryError('UNSUPPORTED_SCHEMA', '判断快照版本暂不支持')
      }
      return {
        ...summary,
        relatedSignalIds: validateRelatedSignalIds(JSON.parse(row.related_signal_ids_json) as unknown),
        evidenceSnapshot: validateEvidenceSnapshot(JSON.parse(row.evidence_snapshot_json) as unknown),
      }
    })
    return {
      judgmentId: anchor.id,
      judgmentGroupId: anchor.judgment_group_id,
      total: versions[0]?.versionCount ?? 0,
      versions,
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new DecisionJudgmentRepositoryError('CORRUPT_DATA', '判断快照 JSON 损坏')
    }
    if (error instanceof DecisionJudgmentRepositoryError && error.code === 'INVALID_PARAM') {
      throw new DecisionJudgmentRepositoryError('CORRUPT_DATA', '判断快照结构损坏')
    }
    throw error
  }
}
