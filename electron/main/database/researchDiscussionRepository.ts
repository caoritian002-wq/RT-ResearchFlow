import type Database from 'better-sqlite3'
import type {
  AIResearchDiscussionContextRow,
  ResearchBaseSelectionReason,
  ResearchDiscussionOriginType,
  ResearchDiscussionStatus,
} from './types'

export interface CreateResearchDiscussionContextInput {
  sessionId: number
  requestId: string
  status?: ResearchDiscussionStatus
  originType: ResearchDiscussionOriginType
  originId: string | null
  originTitle: string
  originOccurredAt: number | null
  originContentHash: string
  contextSnapshotJson: string
  contextKeysJson: string
  includedContextKeysJson: string
  returnTargetJson: string
  projectId: string | null
  baseSnapshotId: string | null
  baseSelectionReason: ResearchBaseSelectionReason
  degradedReason?: string | null
  now?: number
}

export interface ListResearchDiscussionContextsInput {
  originType?: ResearchDiscussionOriginType
  originId?: string | null
  projectId?: string
  status?: ResearchDiscussionStatus
  offset?: number
  limit?: number
}

export function createResearchDiscussionContext(
  db: Database.Database,
  input: CreateResearchDiscussionContextInput,
): AIResearchDiscussionContextRow {
  const now = input.now ?? Date.now()
  db.prepare(`
    INSERT INTO ai_research_discussion_contexts (
      session_id, start_request_id, status, origin_type, origin_id, origin_title,
      origin_occurred_at, origin_available, origin_content_hash, context_snapshot_json,
      context_keys_json, included_context_keys_json, return_target_json, project_id,
      base_snapshot_id, base_selection_reason, degraded_reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.sessionId,
    input.requestId,
    input.status ?? 'active',
    input.originType,
    input.originId,
    input.originTitle,
    input.originOccurredAt,
    input.originContentHash,
    input.contextSnapshotJson,
    input.contextKeysJson,
    input.includedContextKeysJson,
    input.returnTargetJson,
    input.projectId,
    input.baseSnapshotId,
    input.baseSelectionReason,
    input.degradedReason ?? null,
    now,
    now,
  )
  return getResearchDiscussionContext(db, input.sessionId)!
}

export function getResearchDiscussionContext(
  db: Database.Database,
  sessionId: number,
): AIResearchDiscussionContextRow | null {
  return (db.prepare('SELECT * FROM ai_research_discussion_contexts WHERE session_id = ?')
    .get(sessionId) as AIResearchDiscussionContextRow | undefined) ?? null
}

export function getResearchDiscussionContextByRequestId(
  db: Database.Database,
  requestId: string,
): AIResearchDiscussionContextRow | null {
  return (db.prepare('SELECT * FROM ai_research_discussion_contexts WHERE start_request_id = ?')
    .get(requestId) as AIResearchDiscussionContextRow | undefined) ?? null
}

export function findResumableResearchDiscussion(
  db: Database.Database,
  originType: ResearchDiscussionOriginType,
  originId: string | null,
  projectId: string | null,
): AIResearchDiscussionContextRow | null {
  const row = db.prepare(`
    SELECT * FROM ai_research_discussion_contexts
    WHERE origin_type = ?
      AND origin_id IS ?
      AND project_id IS ?
      AND COALESCE(
        CASE WHEN json_valid(context_snapshot_json)
          THEN json_extract(context_snapshot_json, '$.contextKind')
        END,
        'source'
      ) <> 'evidence_delta'
      AND status IN ('active', 'changes_ready', 'partially_applied')
    ORDER BY updated_at DESC, session_id DESC
    LIMIT 1
  `).get(originType, originId, projectId) as AIResearchDiscussionContextRow | undefined
  return row ?? null
}

export function findResumableEvidenceDeltaDiscussion(
  db: Database.Database,
  originContentHash: string,
): AIResearchDiscussionContextRow | null {
  const row = db.prepare(`
    SELECT * FROM ai_research_discussion_contexts
    WHERE origin_content_hash = ?
      AND json_valid(context_snapshot_json)
      AND json_extract(context_snapshot_json, '$.contextKind') = 'evidence_delta'
      AND status IN ('active', 'changes_ready', 'partially_applied')
    ORDER BY updated_at DESC, session_id DESC
    LIMIT 1
  `).get(originContentHash) as AIResearchDiscussionContextRow | undefined
  return row ?? null
}

export function updateResearchDiscussionContextSelection(
  db: Database.Database,
  input: {
    sessionId: number
    requestId: string
    contextSnapshotJson: string
    includedContextKeysJson: string
    originContentHash: string
    now?: number
  },
): AIResearchDiscussionContextRow | null {
  const existing = getResearchDiscussionContext(db, input.sessionId)
  if (!existing) return null
  if (existing.context_update_request_id === input.requestId) return existing
  const now = input.now ?? Date.now()
  db.prepare(`
    UPDATE ai_research_discussion_contexts
    SET context_update_request_id = ?, context_snapshot_json = ?,
        included_context_keys_json = ?, origin_content_hash = ?, updated_at = ?
    WHERE session_id = ?
  `).run(
    input.requestId,
    input.contextSnapshotJson,
    input.includedContextKeysJson,
    input.originContentHash,
    now,
    input.sessionId,
  )
  return getResearchDiscussionContext(db, input.sessionId)
}

export function updateResearchDiscussionReturnTarget(
  db: Database.Database,
  sessionId: number,
  returnTargetJson: string,
): AIResearchDiscussionContextRow | null {
  db.prepare(`
    UPDATE ai_research_discussion_contexts
    SET return_target_json = ?, updated_at = ?
    WHERE session_id = ?
  `).run(returnTargetJson, Date.now(), sessionId)
  return getResearchDiscussionContext(db, sessionId)
}

export function updateResearchDiscussionProgress(
  db: Database.Database,
  sessionId: number,
  patch: {
    status?: ResearchDiscussionStatus
    projectId?: string | null
    baseSnapshotId?: string | null
    baseSelectionReason?: ResearchBaseSelectionReason
    summarizedThroughMessageIndex?: number | null
    latestBatchId?: string | null
    degradedReason?: string | null
  },
): AIResearchDiscussionContextRow | null {
  const entries: Array<[string, unknown]> = []
  if (patch.status !== undefined) entries.push(['status', patch.status])
  if (patch.projectId !== undefined) entries.push(['project_id', patch.projectId])
  if (patch.baseSnapshotId !== undefined) entries.push(['base_snapshot_id', patch.baseSnapshotId])
  if (patch.baseSelectionReason !== undefined) entries.push(['base_selection_reason', patch.baseSelectionReason])
  if (patch.summarizedThroughMessageIndex !== undefined) entries.push(['summarized_through_message_index', patch.summarizedThroughMessageIndex])
  if (patch.latestBatchId !== undefined) entries.push(['latest_batch_id', patch.latestBatchId])
  if (patch.degradedReason !== undefined) entries.push(['degraded_reason', patch.degradedReason])
  if (!entries.length) return getResearchDiscussionContext(db, sessionId)
  entries.push(['updated_at', Date.now()])
  db.prepare(`UPDATE ai_research_discussion_contexts SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE session_id = ?`)
    .run(...entries.map(([, value]) => value), sessionId)
  return getResearchDiscussionContext(db, sessionId)
}

export function markResearchDiscussionOriginAvailability(
  db: Database.Database,
  sessionId: number,
  available: boolean,
): void {
  db.prepare('UPDATE ai_research_discussion_contexts SET origin_available = ?, updated_at = ? WHERE session_id = ?')
    .run(available ? 1 : 0, Date.now(), sessionId)
}

export function listResearchDiscussionContexts(
  db: Database.Database,
  input: ListResearchDiscussionContextsInput,
): { items: AIResearchDiscussionContextRow[]; total: number; offset: number; limit: number } {
  const where: string[] = []
  const params: unknown[] = []
  if (input.originType !== undefined) {
    where.push('origin_type = ?')
    params.push(input.originType)
  }
  if (input.originId !== undefined) {
    where.push('origin_id IS ?')
    params.push(input.originId)
  }
  if (input.projectId !== undefined) {
    where.push('project_id = ?')
    params.push(input.projectId)
  }
  if (input.status !== undefined) {
    where.push('status = ?')
    params.push(input.status)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const offset = Math.max(0, input.offset ?? 0)
  const limit = Math.min(100, Math.max(1, input.limit ?? 20))
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM ai_research_discussion_contexts ${whereSql}`)
    .get(...params) as { count: number }).count
  const items = db.prepare(`
    SELECT * FROM ai_research_discussion_contexts
    ${whereSql}
    ORDER BY updated_at DESC, session_id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as AIResearchDiscussionContextRow[]
  return { items, total, offset, limit }
}

export function countResearchDiscussionSessions(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM ai_research_discussion_contexts').get() as { count: number }).count
}
