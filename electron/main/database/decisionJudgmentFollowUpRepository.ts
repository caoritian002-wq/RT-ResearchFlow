import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type {
  DecisionJudgmentFollowUpAction,
  DecisionJudgmentFollowUpRecord,
  DecisionJudgmentFollowUpTask,
  DecisionJudgmentTag,
} from './types'

export const DECISION_JUDGMENT_FOLLOW_UP_SCHEMA_VERSION = 1

export type DecisionJudgmentFollowUpRepositoryErrorCode = 'INVALID_PARAM' | 'FOLLOW_UP_ALREADY_COMPLETED'

export class DecisionJudgmentFollowUpRepositoryError extends Error {
  constructor(public readonly code: DecisionJudgmentFollowUpRepositoryErrorCode, message: string) {
    super(message)
    this.name = 'DecisionJudgmentFollowUpRepositoryError'
  }
}

export interface ListDueDecisionJudgmentFollowUpsInput {
  now?: number
  limit?: number
  offset?: number
}

export interface DecisionJudgmentFollowUpListResult {
  items: DecisionJudgmentFollowUpTask[]
  total: number
  limit: number
  offset: number
}

interface FollowUpRow {
  id: string
  request_id: string
  source_judgment_id: string
  result_judgment_id: string
  action: DecisionJudgmentFollowUpAction
  note: string
  completed_at: number
  schema_version: number
}

function invalid(message: string): never {
  throw new DecisionJudgmentFollowUpRepositoryError('INVALID_PARAM', message)
}

function validateTimestamp(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`${field} 必须为非负整数时间戳`)
  return value as number
}

function mapRecord(row: FollowUpRow): DecisionJudgmentFollowUpRecord {
  return {
    id: row.id,
    requestId: row.request_id,
    sourceJudgmentId: row.source_judgment_id,
    resultJudgmentId: row.result_judgment_id,
    action: row.action,
    note: row.note,
    completedAt: row.completed_at,
    schemaVersion: row.schema_version,
  }
}

export function listDueDecisionJudgmentFollowUps(
  db: Database.Database,
  input: ListDueDecisionJudgmentFollowUpsInput = {},
): DecisionJudgmentFollowUpListResult {
  const now = validateTimestamp(input.now ?? Date.now(), 'now')
  const limit = input.limit ?? 30
  const offset = input.offset ?? 0
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid('limit 必须在 1 到 100 之间')
  if (!Number.isSafeInteger(offset) || offset < 0) invalid('offset 必须为非负整数')

  const dueSql = `
    FROM decision_judgments j
    WHERE j.review_due_at IS NOT NULL
      AND j.review_due_at <= ?
      AND j.version_number = (
        SELECT MAX(latest.version_number)
        FROM decision_judgments latest
        WHERE latest.judgment_group_id = j.judgment_group_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM decision_judgment_follow_ups f
        WHERE f.source_judgment_id = j.id
      )
  `
  const total = (db.prepare(`SELECT COUNT(*) AS count ${dueSql}`).get(now) as { count: number }).count
  const rows = db.prepare(`
    SELECT j.id, j.judgment_group_id, j.ts_code, j.stock_name, j.tag, j.note,
           j.review_due_at, j.created_at
    ${dueSql}
    ORDER BY j.review_due_at ASC, j.created_at DESC, j.id DESC
    LIMIT ? OFFSET ?
  `).all(now, limit, offset) as Array<Record<string, unknown>>

  return {
    total,
    limit,
    offset,
    items: rows.map((row) => ({
      judgmentId: row.id as string,
      judgmentGroupId: row.judgment_group_id as string,
      tsCode: row.ts_code as string,
      stockName: (row.stock_name as string | null) ?? null,
      tag: row.tag as DecisionJudgmentTag,
      note: row.note as string,
      reviewDueAt: row.review_due_at as number,
      createdAt: row.created_at as number,
      overdueMs: Math.max(0, now - (row.review_due_at as number)),
      status: 'due',
    })),
  }
}

export function getDecisionJudgmentFollowUpByRequestId(
  db: Database.Database,
  requestId: string,
): DecisionJudgmentFollowUpRecord | null {
  const row = db.prepare('SELECT * FROM decision_judgment_follow_ups WHERE request_id = ?').get(requestId) as FollowUpRow | undefined
  return row ? mapRecord(row) : null
}

export function insertDecisionJudgmentFollowUp(
  db: Database.Database,
  input: {
    requestId: string
    sourceJudgmentId: string
    resultJudgmentId: string
    action: DecisionJudgmentFollowUpAction
    note?: string
  },
  now = Date.now(),
): DecisionJudgmentFollowUpRecord {
  const existing = getDecisionJudgmentFollowUpByRequestId(db, input.requestId)
  if (existing) return existing
  const note = input.note?.trim() ?? ''
  if (note.length > 4_000) invalid('note 超出长度限制')
  try {
    const id = randomUUID()
    db.prepare(`
      INSERT INTO decision_judgment_follow_ups (
        id, request_id, source_judgment_id, result_judgment_id, action, note, completed_at, schema_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.requestId, input.sourceJudgmentId, input.resultJudgmentId, input.action, note, now, DECISION_JUDGMENT_FOLLOW_UP_SCHEMA_VERSION)
    return getDecisionJudgmentFollowUpByRequestId(db, input.requestId)!
  } catch (error) {
    if (error instanceof Error && error.message.includes('source_judgment_id')) {
      throw new DecisionJudgmentFollowUpRepositoryError('FOLLOW_UP_ALREADY_COMPLETED', '该判断已完成回访')
    }
    throw error
  }
}