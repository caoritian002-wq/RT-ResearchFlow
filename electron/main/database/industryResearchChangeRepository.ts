import type Database from 'better-sqlite3'
import type {
  IndustryResearchCandidateBatchRow,
  IndustryResearchChangeCandidateRow,
  IndustryResearchChangeSetRow,
  IndustryResearchExternalRefRow,
  IndustryResearchSnapshotRow,
  ResearchCandidateBatchStatus,
  ResearchCandidateSourceType,
  ResearchChangeCandidateKind,
  ResearchChangeCandidateStatus,
  ResearchChangeSetAction,
  ResearchChangeSetStatus,
  ResearchCandidateStatementType,
} from './types'

export interface PreparedChangeCandidateInput {
  id: string
  kind: ResearchChangeCandidateKind
  action: string
  externalRef?: string | null
  sourceLocator: string
  targetEntityId?: string | null
  statementType: ResearchCandidateStatementType
  primarySource?: boolean
  payload: unknown
  conflicts?: string[]
  warnings?: string[]
}

export interface PreparedChangeSetInput {
  id: string
  title: string
  summary: string
  impact: string
  action: ResearchChangeSetAction
  risk: 'low' | 'medium' | 'high'
  affectedObjects: Array<{ type: string; id: string | null; label: string }>
  evidenceSummary: string[]
  confidenceBoundary: string
  requiresExpandedReview: boolean
  candidates: PreparedChangeCandidateInput[]
}

export interface PreparedCandidateBatchInput {
  id: string
  requestId: string
  idempotencyKey: string
  sourceType: ResearchCandidateSourceType
  sourceSessionId: number | null
  projectId: string | null
  baseSnapshotId: string | null
  messageStartIndex: number | null
  messageEndIndex: number | null
  contextHash: string
  provider: string | null
  model: string | null
  ruleVersion: string
  degradedReasons?: string[]
  archiveMeta?: unknown
  changeSets: PreparedChangeSetInput[]
}

export function getCandidateBatch(db: Database.Database, batchId: string): IndustryResearchCandidateBatchRow | null {
  return (db.prepare('SELECT * FROM industry_research_candidate_batches WHERE id = ?').get(batchId) as IndustryResearchCandidateBatchRow | undefined) ?? null
}

export function getCandidateBatchByRequestId(db: Database.Database, requestId: string): IndustryResearchCandidateBatchRow | null {
  return (db.prepare('SELECT * FROM industry_research_candidate_batches WHERE request_id = ?').get(requestId) as IndustryResearchCandidateBatchRow | undefined) ?? null
}

export function getCandidateBatchByIdempotencyKey(db: Database.Database, key: string): IndustryResearchCandidateBatchRow | null {
  return (db.prepare('SELECT * FROM industry_research_candidate_batches WHERE idempotency_key = ?').get(key) as IndustryResearchCandidateBatchRow | undefined) ?? null
}

export function savePreparedCandidateBatch(
  db: Database.Database,
  input: PreparedCandidateBatchInput,
): IndustryResearchCandidateBatchRow {
  const save = db.transaction(() => {
    const existing = getCandidateBatchByRequestId(db, input.requestId)
      ?? getCandidateBatchByIdempotencyKey(db, input.idempotencyKey)
    if (existing) return existing
    const now = Date.now()
    const candidateCount = input.changeSets.reduce((sum, item) => sum + item.candidates.length, 0)
    const conflictCount = input.changeSets.reduce(
      (sum, item) => sum + item.candidates.filter((candidate) => (candidate.conflicts?.length ?? 0) > 0).length,
      0,
    )
    db.prepare(`
      INSERT INTO industry_research_candidate_batches (
        id, request_id, idempotency_key, source_type, source_session_id, project_id,
        base_snapshot_id, message_start_index, message_end_index, context_hash, provider,
        model, rule_version, status, change_set_count, candidate_count, conflict_count,
        degraded_reasons_json, archive_meta_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.requestId, input.idempotencyKey, input.sourceType, input.sourceSessionId,
      input.projectId, input.baseSnapshotId, input.messageStartIndex, input.messageEndIndex,
      input.contextHash, input.provider, input.model, input.ruleVersion, input.changeSets.length,
      candidateCount, conflictCount, JSON.stringify(input.degradedReasons ?? []),
      input.archiveMeta == null ? null : JSON.stringify(input.archiveMeta), now, now,
    )
    const insertSet = db.prepare(`
      INSERT INTO industry_research_change_sets (
        id, batch_id, title, summary, impact, action, status, risk, affected_objects_json,
        evidence_summary_json, confidence_boundary, requires_expanded_review, candidate_count,
        source_session_id, message_start_index, message_end_index, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertCandidate = db.prepare(`
      INSERT INTO industry_research_change_candidates (
        id, change_set_id, batch_id, project_id, kind, action, status, external_ref,
        source_locator, message_start_index, message_end_index, target_entity_id,
        statement_type, primary_source, payload_json, conflicts_json, warnings_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const changeSet of input.changeSets) {
      insertSet.run(
        changeSet.id, input.id, changeSet.title, changeSet.summary, changeSet.impact,
        changeSet.action, changeSet.risk, JSON.stringify(changeSet.affectedObjects),
        JSON.stringify(changeSet.evidenceSummary), changeSet.confidenceBoundary,
        changeSet.requiresExpandedReview ? 1 : 0, changeSet.candidates.length,
        input.sourceSessionId, input.messageStartIndex, input.messageEndIndex, now, now,
      )
      for (const candidate of changeSet.candidates) {
        const status: ResearchChangeCandidateStatus = candidate.conflicts?.length ? 'conflicted' : 'pending'
        insertCandidate.run(
          candidate.id, changeSet.id, input.id, input.projectId, candidate.kind, candidate.action,
          status, candidate.externalRef ?? null, candidate.sourceLocator, input.messageStartIndex,
          input.messageEndIndex, candidate.targetEntityId ?? null, candidate.statementType,
          candidate.primarySource ? 1 : 0, JSON.stringify(candidate.payload),
          JSON.stringify(candidate.conflicts ?? []), JSON.stringify(candidate.warnings ?? []), now, now,
        )
      }
    }
    if (input.sourceSessionId != null) {
      db.prepare(`
        UPDATE industry_research_change_sets
        SET status = 'superseded', updated_at = ?
        WHERE source_session_id = ? AND batch_id <> ? AND status IN ('pending', 'deferred')
      `).run(now, input.sourceSessionId, input.id)
      db.prepare(`
        UPDATE industry_research_change_candidates
        SET status = 'superseded', updated_at = ?
        WHERE batch_id IN (
          SELECT id FROM industry_research_candidate_batches
          WHERE source_session_id = ? AND id <> ?
        ) AND status IN ('pending', 'conflicted')
      `).run(now, input.sourceSessionId, input.id)
    }
    return getCandidateBatch(db, input.id)!
  })
  return save()
}

export function getChangeSet(db: Database.Database, changeSetId: string): IndustryResearchChangeSetRow | null {
  return (db.prepare('SELECT * FROM industry_research_change_sets WHERE id = ?').get(changeSetId) as IndustryResearchChangeSetRow | undefined) ?? null
}

export function listChangeSets(
  db: Database.Database,
  input: { sessionId?: number; projectId?: string; batchId?: string; status?: ResearchChangeSetStatus; offset?: number; limit?: number },
): { items: IndustryResearchChangeSetRow[]; total: number; offset: number; limit: number } {
  const where: string[] = []
  const params: unknown[] = []
  if (input.sessionId !== undefined) { where.push('s.source_session_id = ?'); params.push(input.sessionId) }
  if (input.projectId !== undefined) { where.push('b.project_id = ?'); params.push(input.projectId) }
  if (input.batchId !== undefined) { where.push('s.batch_id = ?'); params.push(input.batchId) }
  if (input.status !== undefined) { where.push('s.status = ?'); params.push(input.status) }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const offset = Math.max(0, input.offset ?? 0)
  const limit = Math.min(100, Math.max(1, input.limit ?? 20))
  const join = 'FROM industry_research_change_sets s JOIN industry_research_candidate_batches b ON b.id = s.batch_id'
  const total = (db.prepare(`SELECT COUNT(*) AS count ${join} ${whereSql}`).get(...params) as { count: number }).count
  const items = db.prepare(`SELECT s.* ${join} ${whereSql} ORDER BY s.created_at DESC, s.id LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as IndustryResearchChangeSetRow[]
  return { items, total, offset, limit }
}

export function listChangeCandidates(
  db: Database.Database,
  input: { changeSetId: string; status?: ResearchChangeCandidateStatus; kind?: ResearchChangeCandidateKind; offset?: number; limit?: number },
): { items: IndustryResearchChangeCandidateRow[]; total: number; offset: number; limit: number } {
  const where = ['change_set_id = ?']
  const params: unknown[] = [input.changeSetId]
  if (input.status !== undefined) { where.push('status = ?'); params.push(input.status) }
  if (input.kind !== undefined) { where.push('kind = ?'); params.push(input.kind) }
  const whereSql = `WHERE ${where.join(' AND ')}`
  const offset = Math.max(0, input.offset ?? 0)
  const limit = Math.min(200, Math.max(1, input.limit ?? 50))
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM industry_research_change_candidates ${whereSql}`)
    .get(...params) as { count: number }).count
  const items = db.prepare(`SELECT * FROM industry_research_change_candidates ${whereSql} ORDER BY created_at, id LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as IndustryResearchChangeCandidateRow[]
  return { items, total, offset, limit }
}

export function listCandidatesForChangeSets(
  db: Database.Database,
  changeSetIds: string[],
): IndustryResearchChangeCandidateRow[] {
  if (!changeSetIds.length) return []
  return db.prepare(`
    SELECT * FROM industry_research_change_candidates
    WHERE change_set_id IN (${changeSetIds.map(() => '?').join(',')})
    ORDER BY created_at, id
  `).all(...changeSetIds) as IndustryResearchChangeCandidateRow[]
}

export function resolveChangeSetRows(
  db: Database.Database,
  input: {
    changeSetIds: string[]
    status: Exclude<ResearchChangeSetStatus, 'pending' | 'superseded' | 'conflicted' | 'invalid'>
    action: 'accept' | 'reject' | 'defer'
    requestId: string
    reason?: string | null
    userEditsById?: Map<string, unknown>
    resolvedBy?: string
  },
): void {
  const now = Date.now()
  const update = db.prepare(`
    UPDATE industry_research_change_sets
    SET status = ?, resolution_action = ?, resolution_reason = ?, resolution_request_id = ?,
        user_edits_json = ?, resolved_by = ?, resolved_at = ?, updated_at = ?
    WHERE id = ?
  `)
  for (const id of input.changeSetIds) {
    const edits = input.userEditsById?.get(id)
    update.run(
      input.status, input.action, input.reason ?? null, input.requestId,
      edits === undefined ? null : JSON.stringify(edits), input.resolvedBy ?? 'human', now, now, id,
    )
  }
}

export function updateCandidateResolution(
  db: Database.Database,
  changeSetIds: string[],
  status: 'accepted' | 'rejected',
): void {
  if (!changeSetIds.length) return
  db.prepare(`
    UPDATE industry_research_change_candidates
    SET status = ?, updated_at = ?
    WHERE change_set_id IN (${changeSetIds.map(() => '?').join(',')})
      AND status IN ('pending', 'conflicted')
  `).run(status, Date.now(), ...changeSetIds)
}

export function updateCandidateTargetEntity(
  db: Database.Database,
  candidateId: string,
  projectId: string,
  entityId: string,
): void {
  db.prepare(`
    UPDATE industry_research_change_candidates
    SET project_id = ?, target_entity_id = ?, updated_at = ? WHERE id = ?
  `).run(projectId, entityId, Date.now(), candidateId)
}

export function recomputeCandidateBatchStatus(db: Database.Database, batchId: string): ResearchCandidateBatchStatus {
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status IN ('pending', 'deferred', 'conflicted') THEN 1 ELSE 0 END) AS unresolved,
      SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
      COUNT(*) AS total
    FROM industry_research_change_sets WHERE batch_id = ?
  `).get(batchId) as { unresolved: number | null; accepted: number | null; total: number }
  const status: ResearchCandidateBatchStatus = (counts.unresolved ?? 0) === 0
    ? 'resolved'
    : (counts.accepted ?? 0) > 0 ? 'partially_resolved' : 'ready'
  db.prepare('UPDATE industry_research_candidate_batches SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, Date.now(), batchId)
  return status
}

export function cancelUnresolvedDiscussionBatches(db: Database.Database, sessionId: number): void {
  const now = Date.now()
  db.prepare(`
    UPDATE industry_research_candidate_batches SET status = 'cancelled', updated_at = ?
    WHERE source_session_id = ? AND status IN ('draft', 'ready', 'partially_resolved', 'failed')
  `).run(now, sessionId)
  db.prepare(`
    UPDATE industry_research_change_sets SET status = 'invalid', updated_at = ?
    WHERE source_session_id = ? AND status IN ('pending', 'deferred', 'conflicted')
  `).run(now, sessionId)
  db.prepare(`
    UPDATE industry_research_change_candidates SET status = 'invalid', updated_at = ?
    WHERE batch_id IN (SELECT id FROM industry_research_candidate_batches WHERE source_session_id = ?)
      AND status IN ('pending', 'conflicted')
  `).run(now, sessionId)
}

export function saveExternalResearchRef(
  db: Database.Database,
  input: Omit<IndustryResearchExternalRefRow, 'created_at'>,
): IndustryResearchExternalRefRow {
  db.prepare(`
    INSERT INTO industry_research_external_refs (
      id, project_id, source_scope, external_id, entity_kind, entity_id, source_batch_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, source_scope, external_id) DO UPDATE SET
      entity_kind = excluded.entity_kind, entity_id = excluded.entity_id
  `).run(input.id, input.project_id, input.source_scope, input.external_id, input.entity_kind, input.entity_id, input.source_batch_id, Date.now())
  return db.prepare('SELECT * FROM industry_research_external_refs WHERE project_id = ? AND source_scope = ? AND external_id = ?')
    .get(input.project_id, input.source_scope, input.external_id) as IndustryResearchExternalRefRow
}

export function getExternalResearchRef(
  db: Database.Database,
  projectId: string,
  sourceScope: string,
  externalId: string,
): IndustryResearchExternalRefRow | null {
  return (db.prepare('SELECT * FROM industry_research_external_refs WHERE project_id = ? AND source_scope = ? AND external_id = ?')
    .get(projectId, sourceScope, externalId) as IndustryResearchExternalRefRow | undefined) ?? null
}

export function getLatestResearchSnapshot(db: Database.Database, projectId: string): IndustryResearchSnapshotRow | null {
  return (db.prepare('SELECT * FROM industry_research_snapshots WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(projectId) as IndustryResearchSnapshotRow | undefined) ?? null
}

export function getLatestResearchSnapshotAt(
  db: Database.Database,
  projectId: string,
  maxCreatedAt: number,
): IndustryResearchSnapshotRow | null {
  return (db.prepare(`
    SELECT * FROM industry_research_snapshots
    WHERE project_id = ? AND created_at <= ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(projectId, maxCreatedAt) as IndustryResearchSnapshotRow | undefined) ?? null
}

export function getResearchSnapshotByRequestId(
  db: Database.Database,
  requestId: string,
): IndustryResearchSnapshotRow | null {
  return (db.prepare('SELECT * FROM industry_research_snapshots WHERE request_id = ?')
    .get(requestId) as IndustryResearchSnapshotRow | undefined) ?? null
}

export function saveResearchSnapshot(
  db: Database.Database,
  row: IndustryResearchSnapshotRow,
): IndustryResearchSnapshotRow {
  db.prepare(`
    INSERT INTO industry_research_snapshots (
      id, project_id, previous_snapshot_id, snapshot_reason, request_id,
      trigger_batch_id, skill_snapshot_id, source_session_id, source_origin_type,
      source_origin_id, source_return_target_json, schema_version, graph_updated_at,
      title, accepted_change_set_count, snapshot_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.project_id, row.previous_snapshot_id, row.snapshot_reason, row.request_id,
    row.trigger_batch_id, row.skill_snapshot_id, row.source_session_id, row.source_origin_type,
    row.source_origin_id, row.source_return_target_json, row.schema_version, row.graph_updated_at,
    row.title, row.accepted_change_set_count, row.snapshot_json, row.created_at,
  )
  return getResearchSnapshot(db, row.project_id, row.id)!
}

export function listResearchSnapshots(
  db: Database.Database,
  projectId: string,
  offset = 0,
  limit = 20,
): { items: IndustryResearchSnapshotRow[]; total: number; offset: number; limit: number } {
  const normalizedOffset = Math.max(0, offset)
  const normalizedLimit = Math.min(100, Math.max(1, limit))
  const total = (db.prepare('SELECT COUNT(*) AS count FROM industry_research_snapshots WHERE project_id = ?')
    .get(projectId) as { count: number }).count
  const items = db.prepare(`
    SELECT * FROM industry_research_snapshots
    WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
  `).all(projectId, normalizedLimit, normalizedOffset) as IndustryResearchSnapshotRow[]
  return { items, total, offset: normalizedOffset, limit: normalizedLimit }
}

export function getResearchSnapshot(
  db: Database.Database,
  projectId: string,
  snapshotId: string,
): IndustryResearchSnapshotRow | null {
  return (db.prepare('SELECT * FROM industry_research_snapshots WHERE id = ? AND project_id = ?')
    .get(snapshotId, projectId) as IndustryResearchSnapshotRow | undefined) ?? null
}

export function hasResearchSnapshots(db: Database.Database, projectId: string): boolean {
  return Boolean((db.prepare('SELECT 1 AS found FROM industry_research_snapshots WHERE project_id = ? LIMIT 1')
    .get(projectId) as { found: number } | undefined)?.found)
}
