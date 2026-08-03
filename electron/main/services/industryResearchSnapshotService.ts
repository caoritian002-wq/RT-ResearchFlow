import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import {
  getLatestResearchSnapshot,
  getResearchSnapshot,
  getResearchSnapshotByRequestId,
  listResearchSnapshots,
  saveResearchSnapshot,
} from '../database/industryResearchChangeRepository'
import { listResearchProjectCompanies } from '../database/industryResearchFinancialRepository'
import {
  getResearchGraph,
  getResearchProject,
  listResearchEvidence,
  listResearchHypotheses,
} from '../database/industryResearchRepository'
import type { IndustryResearchSnapshotReason, IndustryResearchSnapshotRow } from '../database/types'
import { getSession } from '../database/aiAnalysisSessionRepository'

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024

export class IndustryResearchSnapshotError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

export interface CreateIndustryResearchSnapshotInput {
  projectId: string
  reason: IndustryResearchSnapshotReason
  requestId: string
  triggerBatchId?: string | null
  skillSnapshotId?: string | null
  sourceSessionId?: number | null
  sourceOriginType: string
  sourceOriginId?: string | null
  sourceReturnTarget?: unknown
  acceptedChangeSetIds?: string[]
  title?: string
}

export function snapshotSummary(row: IndustryResearchSnapshotRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    previousSnapshotId: row.previous_snapshot_id,
    reason: row.snapshot_reason,
    triggerBatchId: row.trigger_batch_id,
    skillSnapshotId: row.skill_snapshot_id,
    sourceSessionId: row.source_session_id,
    schemaVersion: row.schema_version,
    graphUpdatedAt: row.graph_updated_at,
    createdAt: row.created_at,
    title: row.title,
    acceptedChangeSetCount: row.accepted_change_set_count,
  }
}

export function getIndustryResearchSnapshot(db: Database.Database, projectId: string, snapshotId: string) {
  const row = getResearchSnapshot(db, projectId, snapshotId)
  if (!row) throw new IndustryResearchSnapshotError('NOT_FOUND', '产业研究版本不存在')
  if (row.schema_version !== 1) throw new IndustryResearchSnapshotError('UNSUPPORTED_SCHEMA', '产业研究版本暂不支持')
  try {
    return {
      summary: snapshotSummary(row),
      snapshot: JSON.parse(row.snapshot_json) as unknown,
      sourceDiscussionAvailable: row.source_session_id != null && getSession(db, row.source_session_id) != null,
    }
  } catch {
    throw new IndustryResearchSnapshotError('CORRUPT_DATA', '产业研究版本 JSON 损坏')
  }
}

export function listIndustryResearchSnapshots(db: Database.Database, projectId: string, offset = 0, limit = 20) {
  const result = listResearchSnapshots(db, projectId, offset, limit)
  return { ...result, items: result.items.map(snapshotSummary) }
}

export function createIndustryResearchSnapshot(
  db: Database.Database,
  input: CreateIndustryResearchSnapshotInput,
): IndustryResearchSnapshotRow {
  const existing = getResearchSnapshotByRequestId(db, input.requestId)
  if (existing) {
    if (existing.project_id !== input.projectId) {
      throw new IndustryResearchSnapshotError('VERSION_CONFLICT', '研究版本请求已用于其他项目')
    }
    return existing
  }
  const project = getResearchProject(db, input.projectId)
  if (!project) throw new IndustryResearchSnapshotError('NOT_FOUND', '研究项目不存在')
  const graph = getResearchGraph(db, input.projectId)
  const hypotheses = listResearchHypotheses(db, input.projectId)
  const acceptedChangeSetIds = input.acceptedChangeSetIds ?? []
  const sourceReturnTarget = input.sourceReturnTarget ?? null
  const snapshot = {
    schemaVersion: 1,
    project,
    graph,
    evidenceRefs: listResearchEvidence(db, input.projectId).map((item) => ({
      id: item.id,
      title: item.title,
      statementKind: item.statement_kind,
      sourceUrl: item.source_url,
      primarySourceConfirmed: item.primary_source_confirmed === 1,
    })),
    hypotheses,
    companies: listResearchProjectCompanies(db, input.projectId),
    followUps: [
      ...(project.next_review_at ? [{ type: 'project', id: project.id, dueAt: project.next_review_at }] : []),
      ...hypotheses.filter((item) => item.due_at).map((item) => ({ type: 'hypothesis', id: item.id, dueAt: item.due_at })),
    ],
    skillSnapshotId: input.skillSnapshotId ?? null,
    reason: input.reason,
    source: {
      sessionId: input.sourceSessionId ?? null,
      originType: input.sourceOriginType,
      originId: input.sourceOriginId ?? null,
      returnTarget: sourceReturnTarget,
    },
    acceptedChangeSetIds,
    triggerBatchId: input.triggerBatchId ?? null,
  }
  const snapshotJson = JSON.stringify(snapshot)
  if (Buffer.byteLength(snapshotJson, 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw new IndustryResearchSnapshotError('PAYLOAD_TOO_LARGE', '产业研究版本超过 2 MiB 限制')
  }
  const latest = getLatestResearchSnapshot(db, input.projectId)
  return saveResearchSnapshot(db, {
    id: randomUUID(),
    project_id: input.projectId,
    previous_snapshot_id: latest?.id ?? null,
    snapshot_reason: input.reason,
    request_id: input.requestId,
    trigger_batch_id: input.triggerBatchId ?? null,
    skill_snapshot_id: input.skillSnapshotId ?? null,
    source_session_id: input.sourceSessionId ?? null,
    source_origin_type: input.sourceOriginType,
    source_origin_id: input.sourceOriginId ?? null,
    source_return_target_json: sourceReturnTarget == null ? null : JSON.stringify(sourceReturnTarget),
    schema_version: 1,
    graph_updated_at: project.graph_updated_at,
    title: input.title?.trim() || `${project.title} · 研究版本`,
    accepted_change_set_count: acceptedChangeSetIds.length,
    snapshot_json: snapshotJson,
    created_at: Date.now(),
  })
}
