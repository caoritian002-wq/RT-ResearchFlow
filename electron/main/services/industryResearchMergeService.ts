import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import {
  getCandidateBatch,
  getChangeSet,
  getExternalResearchRef,
  getLatestResearchSnapshot,
  listCandidatesForChangeSets,
  recomputeCandidateBatchStatus,
  resolveChangeSetRows,
  saveExternalResearchRef,
  updateCandidateResolution,
  updateCandidateTargetEntity,
} from '../database/industryResearchChangeRepository'
import {
  saveResearchBusinessExposure,
  saveResearchCompany,
  saveResearchProjectCompany,
} from '../database/industryResearchFinancialRepository'
import {
  getResearchProject,
  touchResearchGraph,
  updateResearchProject,
  upsertResearchEdge,
  upsertResearchNode,
  type ResearchEdgeInput,
  type ResearchNodeInput,
} from '../database/industryResearchRepository'
import { getResearchDiscussionContext, updateResearchDiscussionProgress } from '../database/researchDiscussionRepository'
import type {
  IndustryResearchChangeCandidateRow,
  IndustryResearchChangeSetRow,
  ResearchStatementKind,
} from '../database/types'
import {
  changeIndustryResearchHypothesisStatus,
  saveIndustryResearchEvidence,
  saveIndustryResearchHypothesis,
} from './industryResearchService'
import { getLatestSkillAdoption } from '../database/industryResearchDecisionRepository'
import { createIndustryResearchSnapshot } from './industryResearchSnapshotService'

const NODE_TYPES = new Set([
  'industry', 'product', 'material', 'process', 'equipment', 'company', 'country',
  'demand', 'metric', 'stock', 'technology', 'policy', 'hypothesis', 'shock',
])

export class IndustryResearchMergeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
  }
}

export interface ResolveChangeSetsInput {
  requestId: string
  batchId: string
  changeSetIds: string[]
  action: 'accept' | 'reject' | 'defer'
  reason?: string
  userEdits?: Array<{ changeSetId: string; title?: string; summary?: string; payloadPatch?: unknown }>
  target?:
    | { mode: 'existing'; projectId: string }
    | {
        mode: 'create'
        project: {
          title: string
          industry: string
          product: string
          region: string
          timeHorizon: string
          purpose: 'learning' | 'strategy' | 'investment'
          depth: 'quick' | 'standard' | 'deep'
        }
      }
  expectedGraphUpdatedAt?: number
  expectedSnapshotId?: string | null
  factConfirmations?: Array<{
    candidateId: string
    primarySourceConfirmed: true
    confirmedBy: 'human'
    originalSourceUrl: string
  }>
}

export interface MergeProjectFactory {
  (input: NonNullable<Extract<ResolveChangeSetsInput['target'], { mode: 'create' }>['project']>): { id: string }
}

function safeJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T } catch { return fallback }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown, fallback: string, max = 2000): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback
}

function nullableText(value: unknown, max = 2000): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringArray(value: unknown, limit = 200): string[] {
  return Array.isArray(value)
    ? value.slice(0, limit).filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 300))
    : []
}

function effectiveStatementKind(candidate: IndustryResearchChangeCandidateRow): ResearchStatementKind {
  if (candidate.statement_type === 'fact') return 'fact'
  if (candidate.statement_type === 'hypothesis') return 'hypothesis'
  return 'estimate'
}

function validateFactConfirmation(
  candidate: IndustryResearchChangeCandidateRow,
  confirmations: Map<string, NonNullable<ResolveChangeSetsInput['factConfirmations']>[number]>,
) {
  if (candidate.statement_type !== 'fact') return null
  const confirmation = confirmations.get(candidate.id)
  if (!confirmation || confirmation.confirmedBy !== 'human' || confirmation.primarySourceConfirmed !== true) {
    throw new IndustryResearchMergeError('FACT_REQUIRES_SOURCE', '事实升级需要用户确认具体一级来源', { candidateId: candidate.id })
  }
  try {
    const url = new URL(confirmation.originalSourceUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol')
  } catch {
    throw new IndustryResearchMergeError('FACT_REQUIRES_SOURCE', '事实升级必须绑定有效的原始来源 URL', { candidateId: candidate.id })
  }
  return confirmation
}

function resolveEntityId(
  db: Database.Database,
  projectId: string,
  batchId: string,
  candidate: IndustryResearchChangeCandidateRow,
  payload: Record<string, unknown>,
  localRefs: Map<string, string>,
): string {
  if (candidate.target_entity_id) return candidate.target_entity_id
  const externalRef = candidate.external_ref ?? nullableText(payload.externalRef, 300)
  if (externalRef) {
    const local = localRefs.get(externalRef)
    if (local) return local
    const existing = getExternalResearchRef(db, projectId, `batch:${batchId}`, externalRef)
    if (existing) return existing.entity_id
  }
  return randomUUID()
}

function saveExternalRefIfPresent(
  db: Database.Database,
  projectId: string,
  batchId: string,
  candidate: IndustryResearchChangeCandidateRow,
  entityId: string,
  localRefs: Map<string, string>,
): void {
  if (!candidate.external_ref) return
  localRefs.set(candidate.external_ref, entityId)
  saveExternalResearchRef(db, {
    id: randomUUID(),
    project_id: projectId,
    source_scope: `batch:${batchId}`,
    external_id: candidate.external_ref,
    entity_kind: candidate.kind,
    entity_id: entityId,
    source_batch_id: batchId,
  })
}

function candidatePriority(kind: IndustryResearchChangeCandidateRow['kind']): number {
  if (kind === 'project') return 0
  if (kind === 'node') return 1
  if (kind === 'evidence') return 2
  if (kind === 'hypothesis') return 3
  if (kind === 'company') return 4
  if (kind === 'edge') return 5
  if (kind === 'hypothesis_event') return 6
  if (kind === 'company_exposure') return 7
  return 8
}

function applyCandidate(
  db: Database.Database,
  projectId: string,
  batchId: string,
  candidate: IndustryResearchChangeCandidateRow,
  confirmations: Map<string, NonNullable<ResolveChangeSetsInput['factConfirmations']>[number]>,
  localRefs: Map<string, string>,
): { entityId: string; label: string; graphChanged: boolean } {
  const payload = record(safeJson(candidate.payload_json, {}))
  const confirmation = validateFactConfirmation(candidate, confirmations)
  const entityId = resolveEntityId(db, projectId, batchId, candidate, payload, localRefs)
  const statementKind = effectiveStatementKind(candidate)

  if (candidate.kind === 'project') {
    updateResearchProject(db, projectId, {
      title: nullableText(payload.title, 200) ?? undefined,
      industryName: nullableText(payload.industryName, 120) ?? undefined,
      productScope: nullableText(payload.productScope, 500) ?? undefined,
      regionScope: nullableText(payload.regionScope, 200) ?? undefined,
      timeScope: nullableText(payload.timeScope, 200) ?? undefined,
      dataAsOf: nullableText(payload.dataAsOf, 20) ?? undefined,
      nextReviewAt: numberOrNull(payload.nextReviewAt) ?? undefined,
      stopCondition: nullableText(payload.stopCondition, 1000) ?? undefined,
    })
    return { entityId: projectId, label: text(payload.title, '研究项目'), graphChanged: false }
  }

  if (candidate.kind === 'node') {
    const type = text(payload.type, 'product', 40)
    if (!NODE_TYPES.has(type)) throw new IndustryResearchMergeError('INVALID_PARAM', '节点类型无效', { candidateId: candidate.id })
    const node: ResearchNodeInput = {
      id: entityId,
      type: type as ResearchNodeInput['type'],
      name: text(payload.name, '未命名研究节点', 200),
      stage: nullableText(payload.stage, 200),
      statementKind,
      status: nullableText(payload.status, 100),
      metrics: Array.isArray(payload.metrics) ? payload.metrics : [],
      evidenceIds: stringArray(payload.evidenceIds),
      lastUpdated: nullableText(payload.lastUpdated, 30),
    }
    upsertResearchNode(db, projectId, node)
    saveExternalRefIfPresent(db, projectId, batchId, candidate, entityId, localRefs)
    return { entityId, label: node.name, graphChanged: true }
  }

  if (candidate.kind === 'edge') {
    const sourceRef = text(payload.sourceRef ?? payload.source, '', 300)
    const targetRef = text(payload.targetRef ?? payload.target, '', 300)
    const source = localRefs.get(sourceRef) ?? sourceRef
    const target = localRefs.get(targetRef) ?? targetRef
    if (!source || !target) throw new IndustryResearchMergeError('UNRESOLVED_REFERENCE', '关系候选缺少可解析节点引用', { candidateId: candidate.id })
    const edge: ResearchEdgeInput = {
      id: entityId,
      source,
      target,
      relation: text(payload.relation, '关联', 200),
      statementKind,
      strength: numberOrNull(payload.strength),
      bottleneck: payload.bottleneck === true,
      exposurePct: numberOrNull(payload.exposurePct),
      evidenceIds: stringArray(payload.evidenceIds),
      lastUpdated: nullableText(payload.lastUpdated, 30),
    }
    upsertResearchEdge(db, projectId, edge)
    saveExternalRefIfPresent(db, projectId, batchId, candidate, entityId, localRefs)
    return { entityId, label: edge.relation, graphChanged: true }
  }

  if (candidate.kind === 'evidence') {
    const sourceUrl = confirmation?.originalSourceUrl ?? nullableText(payload.sourceUrl, 2000)
    const saved = saveIndustryResearchEvidence(db, projectId, {
      id: entityId,
      title: text(payload.title, '讨论形成的待核验证据', 300),
      sourceType: text(payload.sourceType, confirmation ? 'original' : 'discussion', 80),
      sourceName: text(payload.sourceName, confirmation ? '用户确认一级来源' : 'AI 讨论整理', 200),
      sourceUrl,
      sourceRef: nullableText(payload.sourceRef, 1000) ?? candidate.source_locator,
      publishedDate: nullableText(payload.publishedDate, 20),
      factDate: nullableText(payload.factDate, 20),
      collectedAt: Date.now(),
      metricName: nullableText(payload.metricName, 200),
      metricValue: numberOrNull(payload.metricValue),
      unit: nullableText(payload.unit, 80),
      region: nullableText(payload.region, 100),
      productSpec: nullableText(payload.productSpec, 200),
      methodology: nullableText(payload.methodology, 1000),
      statementKind,
      direction: payload.direction === 'weaken' || payload.direction === 'refute' || payload.direction === 'neutral' ? payload.direction : 'support',
      reliability: confirmation ? 'primary' : payload.reliability === 'secondary' || payload.reliability === 'tertiary' ? payload.reliability : 'unknown',
      createdBy: 'import',
      primarySourceConfirmed: Boolean(confirmation),
      conflictNote: nullableText(payload.conflictNote, 1000),
      excerpt: nullableText(payload.excerpt, 5000),
    })
    saveExternalRefIfPresent(db, projectId, batchId, candidate, saved.id, localRefs)
    return { entityId: saved.id, label: saved.title, graphChanged: false }
  }

  if (candidate.kind === 'hypothesis') {
    const statement = text(payload.statement, '讨论形成的待验证假设', 2000)
    const saved = saveIndustryResearchHypothesis(db, projectId, {
      id: entityId,
      statement,
      importance: Math.min(5, Math.max(1, Math.round(numberOrNull(payload.importance) ?? 3))),
      status: payload.status === 'supported' || payload.status === 'weakened' || payload.status === 'refuted' || payload.status === 'reopened' ? payload.status : 'open',
      cheapestDisproof: text(payload.cheapestDisproof, '寻找一条可直接否定该假设的一级来源或反向数据。', 2000),
      verificationMetric: nullableText(payload.verificationMetric, 500),
      threshold: nullableText(payload.threshold, 500),
      dueAt: numberOrNull(payload.dueAt),
      evidenceIds: stringArray(payload.evidenceIds),
    })
    saveExternalRefIfPresent(db, projectId, batchId, candidate, saved.id, localRefs)
    return { entityId: saved.id, label: saved.statement, graphChanged: false }
  }

  if (candidate.kind === 'hypothesis_event') {
    const hypothesisRef = text(payload.hypothesisRef ?? payload.hypothesisId ?? candidate.target_entity_id, '', 300)
    const hypothesisId = localRefs.get(hypothesisRef) ?? hypothesisRef
    if (!hypothesisId) throw new IndustryResearchMergeError('UNRESOLVED_REFERENCE', '假设事件缺少目标假设', { candidateId: candidate.id })
    const status = payload.status === 'supported' || payload.status === 'weakened' || payload.status === 'refuted' || payload.status === 'reopened' ? payload.status : 'open'
    const saved = changeIndustryResearchHypothesisStatus(
      db, projectId, hypothesisId, status,
      text(payload.reason, '根据本次讨论更新假设状态', 2000),
      stringArray(payload.evidenceIds),
    )
    return { entityId: saved.id, label: saved.statement, graphChanged: false }
  }

  if (candidate.kind === 'company') {
    const saved = saveResearchCompany(db, {
      id: entityId,
      legalName: text(payload.legalName ?? payload.name, '待核验公司', 300),
      shortName: nullableText(payload.shortName, 120),
      unifiedCreditCode: null,
      registrationRegion: nullableText(payload.registrationRegion, 120),
      sourceType: 'manual',
      sourceRef: candidate.source_locator,
    })
    saveResearchProjectCompany(db, {
      projectId,
      companyId: saved.id,
      status: payload.status === 'watching' || payload.status === 'core' ? payload.status : 'candidate',
      evidenceIds: stringArray(payload.evidenceIds),
    })
    saveExternalRefIfPresent(db, projectId, batchId, candidate, saved.id, localRefs)
    return { entityId: saved.id, label: saved.short_name || saved.legal_name, graphChanged: false }
  }

  if (candidate.kind === 'company_exposure') {
    const companyRef = text(payload.companyRef ?? payload.companyId, '', 300)
    const companyId = localRefs.get(companyRef) ?? companyRef
    if (!companyId) throw new IndustryResearchMergeError('UNRESOLVED_REFERENCE', '公司暴露缺少公司引用', { candidateId: candidate.id })
    const saved = saveResearchBusinessExposure(db, {
      id: entityId,
      projectId,
      companyId,
      researchNodeId: nullableText(payload.researchNodeId, 300),
      mainBusinessItemId: null,
      evidenceId: null,
      sourceKey: text(payload.sourceKey ?? candidate.external_ref, entityId, 500),
      sourceType: 'manual',
      status: 'candidate',
      exposurePct: numberOrNull(payload.exposurePct),
      basis: text(payload.basis, '来自讨论整理，待公告证据确认。', 2000),
      createdBy: 'import',
      factDate: nullableText(payload.factDate, 20),
      evidenceIds: stringArray(payload.evidenceIds),
      methodology: nullableText(payload.methodology, 2000),
    })
    saveExternalRefIfPresent(db, projectId, batchId, candidate, saved.id, localRefs)
    return { entityId: saved.id, label: saved.basis, graphChanged: false }
  }

  const dueAt = numberOrNull(payload.dueAt)
  const hypothesisRef = nullableText(payload.hypothesisRef ?? payload.hypothesisId, 300)
  if (hypothesisRef) {
    const hypothesisId = localRefs.get(hypothesisRef) ?? hypothesisRef
    const result = db.prepare('UPDATE industry_research_hypotheses SET due_at = ?, updated_at = ? WHERE id = ? AND project_id = ?')
      .run(dueAt, Date.now(), hypothesisId, projectId)
    if (!result.changes) throw new IndustryResearchMergeError('UNRESOLVED_REFERENCE', '回访项关联的假设不存在', { candidateId: candidate.id })
    return { entityId: hypothesisId, label: text(payload.label, '假设回访', 200), graphChanged: false }
  }
  updateResearchProject(db, projectId, { nextReviewAt: dueAt })
  return { entityId: projectId, label: text(payload.label, '项目回访', 200), graphChanged: false }
}

export function resolveIndustryResearchChangeSets(
  db: Database.Database,
  input: ResolveChangeSetsInput,
  createProject?: MergeProjectFactory,
) {
  if (!input.changeSetIds.length || input.changeSetIds.length > 20 || new Set(input.changeSetIds).size !== input.changeSetIds.length) {
    throw new IndustryResearchMergeError('INVALID_PARAM', '单次必须选择 1 至 20 个不重复变更包')
  }
  const batch = getCandidateBatch(db, input.batchId)
  if (!batch) throw new IndustryResearchMergeError('NOT_FOUND', '变更批次不存在')
  const changeSets = input.changeSetIds.map((id) => getChangeSet(db, id))
  if (changeSets.some((item) => !item || item.batch_id !== input.batchId)) {
    throw new IndustryResearchMergeError('SESSION_MISMATCH', '变更包不属于同一批次')
  }
  const typedSets = changeSets as IndustryResearchChangeSetRow[]
  if (typedSets.every((item) => item.resolution_request_id === input.requestId)) {
    const snapshot = db.prepare('SELECT id, project_id, graph_updated_at FROM industry_research_snapshots WHERE trigger_batch_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(input.batchId) as { id: string; project_id: string; graph_updated_at: number } | undefined
    return {
      resolvedChangeSetIds: input.changeSetIds,
      projectId: snapshot?.project_id ?? batch.project_id,
      mergedEntityIds: {},
      snapshotId: snapshot?.id ?? null,
      graphUpdatedAt: snapshot?.graph_updated_at ?? null,
      batchStatus: batch.status,
      appliedSummary: [],
    }
  }
  if (typedSets.some((item) => !['pending', 'deferred', 'conflicted'].includes(item.status))) {
    throw new IndustryResearchMergeError('ALREADY_RESOLVED', '所选变更包包含已处理项')
  }
  const edits = new Map((input.userEdits ?? []).map((item) => [item.changeSetId, item]))

  if (input.action !== 'accept') {
    const apply = db.transaction(() => {
      const status = input.action === 'reject' ? 'rejected' as const : 'deferred' as const
      resolveChangeSetRows(db, {
        changeSetIds: input.changeSetIds,
        status,
        action: input.action,
        requestId: input.requestId,
        reason: input.reason,
        userEditsById: edits,
      })
      if (input.action === 'reject') updateCandidateResolution(db, input.changeSetIds, 'rejected')
      const batchStatus = recomputeCandidateBatchStatus(db, input.batchId)
      return {
        resolvedChangeSetIds: input.changeSetIds,
        projectId: batch.project_id,
        mergedEntityIds: {},
        snapshotId: null,
        graphUpdatedAt: null,
        batchStatus,
        appliedSummary: [],
      }
    })
    return apply()
  }

  if (!input.target) throw new IndustryResearchMergeError('PROJECT_REQUIRED_FOR_ACCEPT', '接受变更包必须选择目标研究项目')
  const accept = db.transaction(() => {
    let projectId: string
    if (input.target!.mode === 'existing') {
      projectId = input.target!.projectId
      if (!getResearchProject(db, projectId)) throw new IndustryResearchMergeError('NOT_FOUND', '目标研究项目不存在')
    } else {
      if (!createProject) throw new IndustryResearchMergeError('INVALID_PARAM', '缺少创建研究草稿能力')
      projectId = createProject(input.target!.project).id
    }
    if (batch.project_id && batch.project_id !== projectId) throw new IndustryResearchMergeError('PROJECT_MISMATCH', '批次与目标研究项目不一致')
    if (!batch.project_id) {
      db.prepare('UPDATE industry_research_candidate_batches SET project_id = ?, updated_at = ? WHERE id = ? AND project_id IS NULL')
        .run(projectId, Date.now(), input.batchId)
    }
    const projectBefore = getResearchProject(db, projectId)!
    if (input.expectedGraphUpdatedAt !== undefined && input.expectedGraphUpdatedAt !== projectBefore.graph_updated_at) {
      throw new IndustryResearchMergeError('VERSION_CONFLICT', '研究图谱已变化，请刷新变更包后重试')
    }
    const latestSnapshot = getLatestResearchSnapshot(db, projectId)
    if (input.expectedSnapshotId !== undefined && input.expectedSnapshotId !== (latestSnapshot?.id ?? null)) {
      throw new IndustryResearchMergeError('VERSION_CONFLICT', '研究版本已变化，请刷新后重试')
    }
    const confirmations = new Map((input.factConfirmations ?? []).map((item) => [item.candidateId, item]))
    const candidates = listCandidatesForChangeSets(db, input.changeSetIds)
      .sort((a, b) => candidatePriority(a.kind) - candidatePriority(b.kind))
    if (candidates.some((candidate) => candidate.status === 'invalid' || candidate.status === 'superseded')) {
      throw new IndustryResearchMergeError('ALREADY_RESOLVED', '底层候选已失效，请重新整理讨论')
    }
    const localRefs = new Map<string, string>()
    const mergedEntityIds: Record<string, string> = {}
    const appliedSummary: Array<{ type: string; label: string; entityId: string }> = []
    let graphChanged = false
    for (const candidate of candidates) {
      const applied = applyCandidate(db, projectId, input.batchId, candidate, confirmations, localRefs)
      mergedEntityIds[candidate.id] = applied.entityId
      appliedSummary.push({ type: candidate.kind, label: applied.label, entityId: applied.entityId })
      graphChanged ||= applied.graphChanged
      updateCandidateTargetEntity(db, candidate.id, projectId, applied.entityId)
    }
    const graphUpdatedAt = graphChanged
      ? touchResearchGraph(db, projectId, projectBefore.graph_updated_at)
      : getResearchProject(db, projectId)!.graph_updated_at
    const context = batch.source_session_id == null ? null : getResearchDiscussionContext(db, batch.source_session_id)
    const originType = context?.origin_type ?? 'archive'
    const originId = context?.origin_id ?? null
    const returnTarget = context ? safeJson(context.return_target_json, null) : null
    const skillAdoption = getLatestSkillAdoption(db, projectId)
    const researchSnapshot = createIndustryResearchSnapshot(db, {
      projectId,
      reason: batch.source_type === 'archive' ? 'archive_import' : 'discussion_merge',
      requestId: input.requestId,
      triggerBatchId: input.batchId,
      skillSnapshotId: skillAdoption?.target_snapshot_id ?? null,
      sourceSessionId: batch.source_session_id,
      sourceOriginType: originType,
      sourceOriginId: originId,
      sourceReturnTarget: returnTarget,
      acceptedChangeSetIds: input.changeSetIds,
    })
    const snapshotId = researchSnapshot.id
    resolveChangeSetRows(db, {
      changeSetIds: input.changeSetIds,
      status: 'accepted',
      action: 'accept',
      requestId: input.requestId,
      reason: input.reason,
      userEditsById: edits,
    })
    updateCandidateResolution(db, input.changeSetIds, 'accepted')
    const batchStatus = recomputeCandidateBatchStatus(db, input.batchId)
    if (batch.source_session_id != null) {
      updateResearchDiscussionProgress(db, batch.source_session_id, {
        status: batchStatus === 'resolved' ? 'applied' : 'partially_applied',
        projectId,
        baseSnapshotId: snapshotId,
        baseSelectionReason: 'latest_compatible',
      })
    }
    return {
      resolvedChangeSetIds: input.changeSetIds,
      projectId,
      mergedEntityIds,
      snapshotId,
      graphUpdatedAt,
      batchStatus,
      appliedSummary,
    }
  })
  try {
    return accept()
  } catch (error) {
    if (error instanceof IndustryResearchMergeError) throw error
    if (error instanceof Error && error.message === 'VERSION_CONFLICT') {
      throw new IndustryResearchMergeError('VERSION_CONFLICT', '研究图谱已变化，请刷新后重试')
    }
    throw error
  }
}
