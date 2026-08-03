import { createHash, randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import {
  createDecision,
  getDecision,
  getDecisionEventByRequestId,
  getDecisionEventByTriggerEvaluation,
  getLatestDecisionEvent,
  getLatestMonitoringItemVersion,
  getLatestReviewEvent,
  getLatestScenarioSetVersion,
  getLatestSkillAdoption,
  getLatestTriggerVersion,
  getLatestWorkItemVersion,
  getMonitoringItemVersionByRequestId,
  getMonitoringObservationByRequestId,
  getReviewEventByRequestId,
  getScenarioSetVersion,
  getScenarioSetVersionByRequestId,
  getSkillAdoptionByRequestId,
  getSkillSnapshot,
  getSkillSnapshotByHash,
  getTriggerEvaluation,
  getTriggerEvaluationByRequestId,
  getTriggerVersionByRequestId,
  getWorkItemVersionByRequestId,
  listDecisionEvents,
  listLatestDecisionEvents,
  listLatestMonitoringItemVersions,
  listLatestMonitoringObservations,
  listLatestReviewEvents,
  listLatestScenarioSetVersions,
  listLatestTriggerVersions,
  listLatestWorkItemVersions,
  listScenariosForVersion,
  saveDecisionEvent,
  saveMonitoringItemVersion,
  saveMonitoringObservation,
  saveReviewEvent,
  saveScenarioSetVersion,
  saveSkillAdoption,
  saveSkillSnapshot,
  saveTriggerEvaluation,
  saveTriggerVersion,
  saveWorkItemVersion,
} from '../database/industryResearchDecisionRepository'
import { getMarketSnapshot } from '../database/industryResearchMarketRepository'
import { getValuationSnapshot } from '../database/industryResearchValuationRepository'
import {
  getResearchProject,
  updateResearchProjectSkill,
} from '../database/industryResearchRepository'
import type {
  IndustryResearchDecisionEventRow,
  IndustryResearchDecisionTriggerEvaluationRow,
  IndustryResearchDecisionTriggerVersionRow,
  IndustryResearchMonitoringItemVersionRow,
  IndustryResearchMonitoringObservationRow,
  IndustryResearchProjectRow,
  IndustryResearchReviewEventRow,
  IndustryResearchScenarioRow,
  IndustryResearchScenarioSetVersionRow,
  IndustryResearchSkillAdoptionEventRow,
  IndustryResearchSkillSnapshotRow,
  IndustryResearchWorkItemVersionRow,
  IndustryResearchValuationMethod,
  ResearchDecisionAction,
  ResearchDecisionEventType,
  ResearchEffort,
  ResearchMonitoringFrequency,
  ResearchMonitoringTiming,
  ResearchMonitoringValueKind,
  ResearchReviewKind,
  ResearchTriggerOperator,
} from '../database/types'
import type { VerifiedSkillBundle } from './skillService'
import {
  createIndustryResearchSnapshot,
  getIndustryResearchSnapshot,
} from './industryResearchSnapshotService'

const MAX_SKILL_BYTES = 1024 * 1024
const MAX_JSON_BYTES = 128 * 1024
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export class IndustryResearchDecisionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

function requireProject(db: Database.Database, projectId: string): IndustryResearchProjectRow {
  const project = getResearchProject(db, projectId)
  if (!project) throw new IndustryResearchDecisionError('NOT_FOUND', '研究项目不存在')
  return project
}

function requireIdempotentScope(matches: boolean): void {
  if (!matches) throw new IndustryResearchDecisionError('NOT_FOUND', '幂等请求不属于当前研究对象')
}

function safeJson<T>(value: string, fallback: T): { value: T; corrupt: boolean } {
  try {
    return { value: JSON.parse(value) as T, corrupt: false }
  } catch {
    return { value: fallback, corrupt: true }
  }
}

function json(value: unknown, name: string, maxBytes = MAX_JSON_BYTES): string {
  const result = JSON.stringify(value)
  if (Buffer.byteLength(result, 'utf8') > maxBytes) {
    throw new IndustryResearchDecisionError('PAYLOAD_TOO_LARGE', `${name}超过大小限制`)
  }
  return result
}

function requireDate(value: string, name: string): string {
  if (!DATE_PATTERN.test(value)) throw new IndustryResearchDecisionError('INVALID_PARAM', `${name}格式无效`)
  return value
}

function requireProjectCompany(db: Database.Database, projectId: string, companyId: string | null): void {
  if (!companyId) return
  const found = db.prepare(`
    SELECT 1 FROM industry_research_project_companies WHERE project_id = ? AND company_id = ?
  `).get(projectId, companyId)
  if (!found) throw new IndustryResearchDecisionError('NOT_FOUND', '项目公司不存在')
}

function requireIds(
  db: Database.Database,
  table: string,
  projectColumn: string,
  projectId: string,
  ids: string[],
): void {
  if (!ids.length) return
  const unique = [...new Set(ids)]
  if (unique.length !== ids.length || ids.length > 100) {
    throw new IndustryResearchDecisionError('INVALID_PARAM', '关联对象数量或重复项无效')
  }
  const placeholders = unique.map(() => '?').join(',')
  const rows = db.prepare(`SELECT id FROM ${table} WHERE ${projectColumn} = ? AND id IN (${placeholders})`)
    .all(projectId, ...unique) as Array<{ id: string }>
  if (rows.length !== unique.length) throw new IndustryResearchDecisionError('NOT_FOUND', '关联对象不存在或不属于当前项目')
}

function requireAffectedObjects(db: Database.Database, projectId: string, ids: string[]): void {
  if (!ids.length) return
  const unique = [...new Set(ids)]
  if (unique.length !== ids.length || ids.length > 100) {
    throw new IndustryResearchDecisionError('INVALID_PARAM', '受影响对象数量或重复项无效')
  }
  for (const objectId of unique) {
    const found = db.prepare(`
      SELECT 1 FROM industry_research_nodes WHERE project_id = ? AND id = ?
      UNION ALL SELECT 1 FROM industry_research_hypotheses WHERE project_id = ? AND id = ?
      UNION ALL SELECT 1 FROM industry_research_project_companies WHERE project_id = ? AND company_id = ?
      UNION ALL SELECT 1 FROM industry_research_decisions WHERE project_id = ? AND id = ?
      LIMIT 1
    `).get(projectId, objectId, projectId, objectId, projectId, objectId, projectId, objectId)
    if (!found) throw new IndustryResearchDecisionError('NOT_FOUND', '受影响对象不存在或不属于当前项目')
  }
}

function skillSnapshotView(row: IndustryResearchSkillSnapshotRow | null) {
  if (!row) return null
  return {
    id: row.id,
    skillId: row.skill_id,
    contentHash: row.content_hash,
    ruleVersion: row.rule_version,
    sourceType: row.source_type,
    sourceDisplayName: row.source_locator,
    contentBytes: row.content_bytes,
    capturedAt: row.captured_at,
  }
}

export function captureIndustryResearchSkillSnapshot(
  db: Database.Database,
  bundle: VerifiedSkillBundle,
): IndustryResearchSkillSnapshotRow {
  if (!bundle.content || bundle.contentBytes <= 0 || bundle.contentBytes > MAX_SKILL_BYTES) {
    throw new IndustryResearchDecisionError('SKILL_SNAPSHOT_MISSING', 'Skill正文为空或超过1 MiB限制')
  }
  const existing = getSkillSnapshotByHash(db, bundle.meta.skillId, bundle.contentHash)
  if (existing) return existing
  return saveSkillSnapshot(db, {
    id: randomUUID(),
    skill_id: bundle.meta.skillId,
    content_hash: bundle.contentHash,
    rule_version: bundle.meta.ruleVersion,
    content: bundle.content,
    source_type: bundle.meta.source,
    source_locator: bundle.sourceDisplayName,
    content_bytes: bundle.contentBytes,
    captured_at: Date.now(),
  })
}

interface MarkdownSection {
  heading: string
  hash: string
}

function markdownSections(content: string): MarkdownSection[] {
  const sections: Array<{ heading: string; lines: string[] }> = []
  let current = { heading: '正文', lines: [] as string[] }
  for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
    const heading = line.match(/^#{1,6}\s+(.+)$/)?.[1]?.trim()
    if (heading) {
      if (current.lines.some((item) => item.trim())) sections.push(current)
      current = { heading, lines: [] }
    } else {
      current.lines.push(line)
    }
  }
  if (current.lines.some((item) => item.trim()) || !sections.length) sections.push(current)
  return sections.map((section) => ({
    heading: section.heading,
    hash: createHash('sha256').update(section.lines.join('\n').trim(), 'utf8').digest('hex'),
  }))
}

function compareSkillContent(previous: string | null, current: string) {
  if (previous == null) {
    return { status: 'previous_content_missing' as const, added: [], removed: [], changed: [], unchanged: [] }
  }
  const before = new Map(markdownSections(previous).map((item) => [item.heading, item.hash]))
  const after = new Map(markdownSections(current).map((item) => [item.heading, item.hash]))
  const headings = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  const unchanged: string[] = []
  for (const heading of headings) {
    if (!before.has(heading)) added.push(heading)
    else if (!after.has(heading)) removed.push(heading)
    else if (before.get(heading) !== after.get(heading)) changed.push(heading)
    else unchanged.push(heading)
  }
  return { status: 'available' as const, added, removed, changed, unchanged }
}

function adoptionView(db: Database.Database, projectId: string, currentBundle: VerifiedSkillBundle | null) {
  const project = requireProject(db, projectId)
  const adoption = getLatestSkillAdoption(db, projectId)
  const adoptedSnapshot = adoption ? getSkillSnapshot(db, adoption.target_snapshot_id) : null
  const current = currentBundle ? {
    skillId: currentBundle.meta.skillId,
    contentHash: currentBundle.contentHash,
    ruleVersion: currentBundle.meta.ruleVersion,
    sourceType: currentBundle.meta.source,
    sourceDisplayName: currentBundle.sourceDisplayName,
  } : null
  const status = !currentBundle
    ? 'current_skill_missing'
    : adoption
      ? adoptedSnapshot?.content_hash === currentBundle.contentHash ? 'current' : 'changed'
      : project.skill_content_hash === currentBundle.contentHash ? 'legacy_hash_only' : 'legacy_snapshot_missing'
  return {
    projectId,
    status,
    projectUpdatedAt: project.updated_at,
    legacyContentHash: adoption ? null : project.skill_content_hash,
    adopted: adoption ? {
      id: adoption.id,
      eventType: adoption.event_type,
      migrationNote: adoption.migration_note,
      adoptedAt: adoption.adopted_at,
      skillSnapshot: skillSnapshotView(adoptedSnapshot),
    } : null,
    current,
    diff: currentBundle
      ? compareSkillContent(adoptedSnapshot?.content ?? null, currentBundle.content)
      : null,
  }
}

export function getIndustryResearchSkillAdoption(
  db: Database.Database,
  projectId: string,
  currentBundle: VerifiedSkillBundle | null,
) {
  return adoptionView(db, projectId, currentBundle)
}

function reviewGroups(db: Database.Database, projectId: string): Array<{ kind: string; count: number }> {
  const queries: Array<[string, string, unknown[]]> = [
    ['graph', 'SELECT (SELECT COUNT(*) FROM industry_research_nodes WHERE project_id = ?) + (SELECT COUNT(*) FROM industry_research_edges WHERE project_id = ?) AS count', [projectId, projectId]],
    ['evidence', 'SELECT COUNT(*) AS count FROM industry_research_evidence WHERE project_id = ?', [projectId]],
    ['hypothesis', 'SELECT COUNT(*) AS count FROM industry_research_hypotheses WHERE project_id = ?', [projectId]],
    ['company', 'SELECT COUNT(*) AS count FROM industry_research_project_companies WHERE project_id = ?', [projectId]],
    ['decision', 'SELECT COUNT(*) AS count FROM industry_research_decisions WHERE project_id = ?', [projectId]],
  ]
  return queries.map(([kind, sql, params]) => ({
    kind,
    count: (db.prepare(sql).get(...params) as { count: number }).count,
  })).filter((item) => item.count > 0)
}

function appendPendingReview(
  db: Database.Database,
  input: {
    requestId: string
    reviewGroupId: string
    projectId: string
    kind: ResearchReviewKind
    subjectKind: string
    subjectId: string
    sourceEventId?: string | null
    reason: string
    payload?: unknown
  },
): IndustryResearchReviewEventRow {
  const existing = getReviewEventByRequestId(db, input.requestId)
  if (existing) return existing
  return saveReviewEvent(db, {
    id: randomUUID(),
    request_id: input.requestId,
    review_group_id: input.reviewGroupId,
    project_id: input.projectId,
    previous_event_id: null,
    kind: input.kind,
    subject_kind: input.subjectKind,
    subject_id: input.subjectId,
    source_event_id: input.sourceEventId ?? null,
    state: 'pending',
    reason: input.reason,
    payload_json: json(input.payload ?? {}, '待复核信息'),
    created_at: Date.now(),
  })
}

export function initializeIndustryResearchDecisionFacts(
  db: Database.Database,
  project: IndustryResearchProjectRow,
  bundle: VerifiedSkillBundle,
): { skillSnapshot: IndustryResearchSkillSnapshotRow; researchSnapshotId: string; adoption: IndustryResearchSkillAdoptionEventRow } {
  const skillSnapshot = captureIndustryResearchSkillSnapshot(db, bundle)
  const researchSnapshot = createIndustryResearchSnapshot(db, {
    projectId: project.id,
    reason: 'project_baseline',
    requestId: `project-baseline:${project.id}`,
    skillSnapshotId: skillSnapshot.id,
    sourceOriginType: project.source_type,
    sourceOriginId: project.source_ref,
  })
  const adoption = saveSkillAdoption(db, {
    id: randomUUID(),
    request_id: `project-initial-adoption:${project.id}`,
    project_id: project.id,
    event_type: 'initial',
    previous_snapshot_id: null,
    target_snapshot_id: skillSnapshot.id,
    research_snapshot_id: researchSnapshot.id,
    migration_note: '项目创建时采用当前产业研究规则。',
    diff_schema_version: 1,
    diff_json: json({ status: 'initial', added: [], removed: [], changed: [], unchanged: [] }, '规则差异'),
    review_summary_json: '[]',
    adopted_at: Date.now(),
  })
  return { skillSnapshot, researchSnapshotId: researchSnapshot.id, adoption }
}

export function adoptIndustryResearchSkillVersion(
  db: Database.Database,
  input: {
    projectId: string
    requestId: string
    targetContentHash: string
    migrationNote: string
    expectedUpdatedAt: number
  },
  currentBundle: VerifiedSkillBundle | null,
) {
  const idempotent = getSkillAdoptionByRequestId(db, input.requestId)
  if (idempotent) {
    const target = getSkillSnapshot(db, idempotent.target_snapshot_id)
    requireIdempotentScope(idempotent.project_id === input.projectId && target?.content_hash === input.targetContentHash)
    return adoptionView(db, input.projectId, currentBundle)
  }
  if (!currentBundle || currentBundle.contentHash !== input.targetContentHash) {
    throw new IndustryResearchDecisionError('SKILL_SNAPSHOT_MISSING', '目标Skill不是当前可验证版本')
  }
  const project = requireProject(db, input.projectId)
  if (project.updated_at !== input.expectedUpdatedAt) {
    throw new IndustryResearchDecisionError('VERSION_CONFLICT', '研究项目已变化，请刷新后重试')
  }
  if (!input.migrationNote.trim()) throw new IndustryResearchDecisionError('INVALID_PARAM', '规则迁移说明不能为空')
  const apply = db.transaction(() => {
    const previousAdoption = getLatestSkillAdoption(db, input.projectId)
    const previousSnapshot = previousAdoption ? getSkillSnapshot(db, previousAdoption.target_snapshot_id) : null
    if (previousSnapshot?.content_hash === currentBundle.contentHash) {
      return adoptionView(db, input.projectId, currentBundle)
    }
    const target = captureIndustryResearchSkillSnapshot(db, currentBundle)
    const diff = compareSkillContent(previousSnapshot?.content ?? null, currentBundle.content)
    const summaries = reviewGroups(db, input.projectId)
    updateResearchProjectSkill(db, input.projectId, input.expectedUpdatedAt, {
      skillId: currentBundle.meta.skillId,
      contentHash: currentBundle.contentHash,
      ruleVersion: currentBundle.meta.ruleVersion,
    })
    const researchSnapshot = createIndustryResearchSnapshot(db, {
      projectId: input.projectId,
      reason: 'skill_adoption',
      requestId: `${input.requestId}:snapshot`,
      skillSnapshotId: target.id,
      sourceOriginType: 'skill_adoption',
      sourceOriginId: input.requestId,
    })
    const adoption = saveSkillAdoption(db, {
      id: randomUUID(),
      request_id: input.requestId,
      project_id: input.projectId,
      event_type: previousAdoption
        ? 'adopted'
        : project.skill_content_hash === currentBundle.contentHash ? 'legacy_verified' : 'adopted',
      previous_snapshot_id: previousSnapshot?.id ?? null,
      target_snapshot_id: target.id,
      research_snapshot_id: researchSnapshot.id,
      migration_note: input.migrationNote.trim(),
      diff_schema_version: 1,
      diff_json: json(diff, '规则差异'),
      review_summary_json: json(summaries, '待复核摘要'),
      adopted_at: Date.now(),
    })
    for (const summary of summaries) {
      appendPendingReview(db, {
        requestId: `${input.requestId}:review:${summary.kind}`,
        reviewGroupId: `skill:${adoption.id}:${summary.kind}`,
        projectId: input.projectId,
        kind: 'skill_adoption',
        subjectKind: summary.kind,
        subjectId: input.projectId,
        sourceEventId: adoption.id,
        reason: `规则更新后复核${summary.kind}分组`,
        payload: summary,
      })
    }
    return adoptionView(db, input.projectId, currentBundle)
  })
  try {
    return apply()
  } catch (error) {
    if (error instanceof Error && error.message === 'VERSION_CONFLICT') {
      throw new IndustryResearchDecisionError('VERSION_CONFLICT', '研究项目已变化，请刷新后重试')
    }
    throw error
  }
}

function workItemView(row: IndustryResearchWorkItemVersionRow) {
  const affected = safeJson<string[]>(row.affected_objects_json, [])
  return {
    id: row.work_item_id,
    versionId: row.id,
    projectId: row.project_id,
    version: row.version,
    previousVersionId: row.previous_version_id,
    question: row.question,
    effort: row.effort,
    conclusionSensitivity: row.conclusion_sensitivity,
    evidenceUncertainty: row.evidence_uncertainty,
    changeVelocity: row.change_velocity,
    stopReason: row.stop_reason,
    nextTriggerMetric: row.next_trigger_metric,
    affectedObjectIds: affected.value,
    status: row.status,
    createdAt: row.created_at,
    dataStatus: affected.corrupt ? 'corrupt' : 'ok',
  }
}

export function listIndustryResearchWorkItems(db: Database.Database, projectId: string) {
  requireProject(db, projectId)
  return listLatestWorkItemVersions(db, projectId).map(workItemView)
}

export function saveIndustryResearchWorkItem(
  db: Database.Database,
  input: {
    projectId: string
    requestId: string
    workItemId: string
    expectedVersion: number
    question: string
    effort: ResearchEffort
    conclusionSensitivity: 'low' | 'medium' | 'high'
    evidenceUncertainty: 'low' | 'medium' | 'high'
    changeVelocity: 'low' | 'medium' | 'high'
    stopReason?: string | null
    nextTriggerMetric?: string | null
    affectedObjectIds: string[]
    status: 'open' | 'blocked' | 'completed' | 'stopped'
  },
) {
  const idempotent = getWorkItemVersionByRequestId(db, input.requestId)
  if (idempotent) {
    requireIdempotentScope(idempotent.project_id === input.projectId && idempotent.work_item_id === input.workItemId)
    return workItemView(idempotent)
  }
  requireProject(db, input.projectId)
  if (!input.question.trim()) throw new IndustryResearchDecisionError('INVALID_PARAM', '研究问题不能为空')
  if (input.status === 'stopped' && !input.stopReason?.trim() && !input.nextTriggerMetric?.trim()) {
    throw new IndustryResearchDecisionError('INVALID_PARAM', '停止研究必须说明停止理由或下一触发指标')
  }
  requireAffectedObjects(db, input.projectId, input.affectedObjectIds)
  const latest = getLatestWorkItemVersion(db, input.projectId, input.workItemId)
  if ((latest?.version ?? 0) !== input.expectedVersion) {
    throw new IndustryResearchDecisionError('VERSION_CONFLICT', '研究工作项已变化，请刷新后重试')
  }
  return workItemView(saveWorkItemVersion(db, {
    id: randomUUID(),
    work_item_id: input.workItemId,
    project_id: input.projectId,
    version: input.expectedVersion + 1,
    previous_version_id: latest?.id ?? null,
    request_id: input.requestId,
    question: input.question.trim(),
    effort: input.effort,
    conclusion_sensitivity: input.conclusionSensitivity,
    evidence_uncertainty: input.evidenceUncertainty,
    change_velocity: input.changeVelocity,
    stop_reason: input.stopReason?.trim() || null,
    next_trigger_metric: input.nextTriggerMetric?.trim() || null,
    affected_objects_json: json(input.affectedObjectIds, '受影响对象'),
    status: input.status,
    created_at: Date.now(),
  }))
}

function scenarioSetView(db: Database.Database, row: IndustryResearchScenarioSetVersionRow) {
  const scenarios = listScenariosForVersion(db, row.id).map((scenario) => {
    const assumptions = safeJson<Record<string, number | string | null>>(scenario.assumptions_json, {})
    const valuationInputs = safeJson<Record<string, unknown>>(scenario.valuation_inputs_json, {})
    const facts = safeJson<string[]>(scenario.fact_ids_json, [])
    return {
      id: scenario.id,
      name: scenario.name,
      weightPct: scenario.weight_pct,
      assumptions: assumptions.value,
      valuationInputs: valuationInputs.value,
      factIds: facts.value,
      dataStatus: assumptions.corrupt || valuationInputs.corrupt || facts.corrupt ? 'corrupt' : 'ok',
    }
  })
  return {
    id: row.scenario_set_id,
    versionId: row.id,
    projectId: row.project_id,
    companyId: row.company_id,
    version: row.version,
    previousVersionId: row.previous_version_id,
    dataAsOf: row.data_as_of,
    valuationDate: row.valuation_date,
    valuationMethod: row.valuation_method,
    methodologyVersion: row.methodology_version,
    createdAt: row.created_at,
    scenarios,
  }
}

export function listIndustryResearchScenarios(
  db: Database.Database,
  projectId: string,
  companyId?: string | null,
) {
  requireProject(db, projectId)
  requireProjectCompany(db, projectId, companyId ?? null)
  return listLatestScenarioSetVersions(db, projectId, companyId).map((row) => scenarioSetView(db, row))
}

export function saveIndustryResearchScenarioSet(
  db: Database.Database,
  input: {
    projectId: string
    companyId?: string | null
    requestId: string
    scenarioSetId: string
    expectedVersion: number
    dataAsOf: string
    valuationDate?: string | null
    valuationMethod?: IndustryResearchValuationMethod | null
    methodologyVersion?: string | null
    scenarios: Array<{
      name: 'bear' | 'base' | 'bull'
      weightPct: number | null
      assumptions: Record<string, number | string | null>
      valuationInputs?: Record<string, unknown>
      factIds: string[]
    }>
  },
) {
  const idempotent = getScenarioSetVersionByRequestId(db, input.requestId)
  if (idempotent) {
    requireIdempotentScope(idempotent.project_id === input.projectId
      && idempotent.scenario_set_id === input.scenarioSetId
      && idempotent.company_id === (input.companyId ?? null))
    return scenarioSetView(db, idempotent)
  }
  requireProject(db, input.projectId)
  requireProjectCompany(db, input.projectId, input.companyId ?? null)
  requireDate(input.dataAsOf, '数据截至日')
  if (input.valuationDate) requireDate(input.valuationDate, '估值基准日')
  const valuationMethods = new Set<IndustryResearchValuationMethod>(['pe', 'pb_roe', 'ev_ebitda', 'dcf', 'sotp', 'nav'])
  if (input.valuationMethod && !valuationMethods.has(input.valuationMethod)) {
    throw new IndustryResearchDecisionError('VALUATION_METHOD_UNSUPPORTED', '估值方法不受支持')
  }
  if (input.valuationMethod && !input.methodologyVersion?.trim()) {
    throw new IndustryResearchDecisionError('INVALID_PARAM', '估值方法必须携带方法版本')
  }
  const names = input.scenarios.map((item) => item.name)
  if (input.scenarios.length !== 3 || new Set(names).size !== 3 || !['bear', 'base', 'bull'].every((name) => names.includes(name as 'bear'))) {
    throw new IndustryResearchDecisionError('INVALID_PARAM', '情景集合必须完整包含悲观、基准和乐观三项')
  }
  const weights = input.scenarios.map((item) => item.weightPct)
  const allNull = weights.every((weight) => weight == null)
  if (!allNull && (weights.some((weight) => weight == null || !Number.isFinite(weight) || weight! < 0 || weight! > 100)
    || Math.abs(weights.reduce<number>((sum, weight) => sum + (weight ?? 0), 0) - 100) > 0.000001)) {
    throw new IndustryResearchDecisionError('SCENARIO_WEIGHT_INVALID', '情景权重必须全部未知或合计100')
  }
  const factIds = [...new Set(input.scenarios.flatMap((item) => item.factIds))]
  requireFinancialFacts(db, input.projectId, input.companyId ?? null, factIds)
  const latest = getLatestScenarioSetVersion(db, input.projectId, input.scenarioSetId)
  if ((latest?.version ?? 0) !== input.expectedVersion) {
    throw new IndustryResearchDecisionError('VERSION_CONFLICT', '情景集合已变化，请刷新后重试')
  }
  const save = db.transaction(() => {
    const versionId = randomUUID()
    const row: IndustryResearchScenarioSetVersionRow = {
      id: versionId,
      scenario_set_id: input.scenarioSetId,
      project_id: input.projectId,
      company_id: input.companyId ?? null,
      version: input.expectedVersion + 1,
      previous_version_id: latest?.id ?? null,
      request_id: input.requestId,
      data_as_of: input.dataAsOf,
      valuation_date: input.valuationDate ?? null,
      valuation_method: input.valuationMethod ?? null,
      methodology_version: input.methodologyVersion?.trim() || null,
      created_at: Date.now(),
    }
    const scenarios: IndustryResearchScenarioRow[] = input.scenarios.map((scenario) => ({
      id: randomUUID(),
      scenario_set_version_id: versionId,
      name: scenario.name,
      weight_pct: scenario.weightPct,
      assumptions_json: json(scenario.assumptions, '情景假设', 64 * 1024),
      valuation_inputs_json: json(scenario.valuationInputs ?? {}, '估值输入', 64 * 1024),
      fact_ids_json: json(scenario.factIds, '情景事实'),
    }))
    return scenarioSetView(db, saveScenarioSetVersion(db, row, scenarios))
  })
  return save()
}

function requireFinancialFacts(db: Database.Database, projectId: string, companyId: string | null, factIds: string[]): void {
  if (!factIds.length) return
  const unique = [...new Set(factIds)]
  if (unique.length !== factIds.length || unique.length > 100) {
    throw new IndustryResearchDecisionError('INVALID_PARAM', '财务事实数量或重复项无效')
  }
  const placeholders = unique.map(() => '?').join(',')
  const companyClause = companyId ? 'AND fact.company_id = ?' : ''
  const params: unknown[] = [projectId, ...unique]
  if (companyId) params.push(companyId)
  const count = (db.prepare(`
    SELECT COUNT(DISTINCT fact.id) AS count
    FROM industry_research_financial_facts fact
    JOIN industry_research_project_companies scope ON scope.company_id = fact.company_id
    WHERE scope.project_id = ? AND fact.id IN (${placeholders}) ${companyClause}
  `).get(...params) as { count: number }).count
  if (count !== unique.length) throw new IndustryResearchDecisionError('NOT_FOUND', '财务事实不存在或不属于当前项目')
}

export interface AppendDecisionEventInput {
  projectId: string
  companyId?: string | null
  requestId: string
  decisionId: string
  expectedLastEventId: string | null
  eventType: ResearchDecisionEventType
  action: ResearchDecisionAction
  rationale: string
  dataAsOf: string
  valuationDate?: string | null
  validUntil: number
  invalidationCondition: string
  scenarioSetVersionId?: string | null
  workItemVersionIds: string[]
  factIds: string[]
  evidenceIds: string[]
  hypothesisIds: string[]
  sourceTriggerEvaluationId?: string | null
  marketSnapshotId?: string | null
  valuationSnapshotId?: string | null
}

function validateAvailabilityDate(db: Database.Database, dataAsOf: string, factIds: string[], evidenceIds: string[]): void {
  const normalized = dataAsOf.replaceAll('-', '')
  if (factIds.length) {
    const placeholders = factIds.map(() => '?').join(',')
    const dates = db.prepare(`
      SELECT COALESCE(NULLIF(f_ann_date, ''), NULLIF(ann_date, ''), NULLIF(period_end, '')) AS available_date
      FROM industry_research_financial_facts WHERE id IN (${placeholders})
    `).all(...factIds) as Array<{ available_date: string | null }>
    if (dates.some((item) => item.available_date && item.available_date.replaceAll('-', '') > normalized)) {
      throw new IndustryResearchDecisionError('DECISION_REPLAY_INCOMPLETE', '决策引用了数据截至日之后公开的财务事实')
    }
  }
  if (evidenceIds.length) {
    const placeholders = evidenceIds.map(() => '?').join(',')
    const dates = db.prepare(`
      SELECT COALESCE(NULLIF(fact_date, ''), NULLIF(published_date, '')) AS available_date
      FROM industry_research_evidence WHERE id IN (${placeholders})
    `).all(...evidenceIds) as Array<{ available_date: string | null }>
    if (dates.some((item) => item.available_date && item.available_date.replaceAll('-', '') > normalized)) {
      throw new IndustryResearchDecisionError('DECISION_REPLAY_INCOMPLETE', '决策引用了数据截至日之后公开的证据')
    }
  }
}

function decisionEventView(row: IndustryResearchDecisionEventRow) {
  const workItems = safeJson<string[]>(row.work_item_ids_json, [])
  const facts = safeJson<string[]>(row.fact_ids_json, [])
  const evidence = safeJson<string[]>(row.evidence_ids_json, [])
  const hypotheses = safeJson<string[]>(row.hypothesis_ids_json, [])
  return {
    id: row.id,
    decisionId: row.decision_id,
    projectId: row.project_id,
    previousEventId: row.previous_event_id,
    eventType: row.event_type,
    action: row.action,
    rationale: row.rationale,
    dataAsOf: row.data_as_of,
    valuationDate: row.valuation_date,
    validUntil: row.valid_until,
    invalidationCondition: row.invalidation_condition,
    skillSnapshotId: row.skill_snapshot_id,
    researchSnapshotId: row.research_snapshot_id,
    scenarioSetVersionId: row.scenario_set_version_id,
    workItemVersionIds: workItems.value,
    factIds: facts.value,
    evidenceIds: evidence.value,
    hypothesisIds: hypotheses.value,
    sourceTriggerEvaluationId: row.source_trigger_evaluation_id,
    marketSnapshotId: row.market_snapshot_id,
    valuationSnapshotId: row.valuation_snapshot_id,
    createdAt: row.created_at,
    dataStatus: workItems.corrupt || facts.corrupt || evidence.corrupt || hypotheses.corrupt ? 'corrupt' : 'ok',
  }
}

export function listIndustryResearchDecisions(db: Database.Database, projectId: string) {
  requireProject(db, projectId)
  return listLatestDecisionEvents(db, projectId).map((row) => {
    const decision = getDecision(db, projectId, row.decision_id)!
    return { ...decisionEventView(row), companyId: decision.company_id }
  })
}

export function appendIndustryResearchDecisionEvent(
  db: Database.Database,
  input: AppendDecisionEventInput,
) {
  const idempotent = getDecisionEventByRequestId(db, input.requestId)
  if (idempotent) {
    requireIdempotentScope(idempotent.project_id === input.projectId
      && idempotent.decision_id === input.decisionId
      && idempotent.source_trigger_evaluation_id === (input.sourceTriggerEvaluationId ?? null))
    return decisionEventView(idempotent)
  }
  requireProject(db, input.projectId)
  requireProjectCompany(db, input.projectId, input.companyId ?? null)
  requireDate(input.dataAsOf, '数据截至日')
  if (input.valuationDate) requireDate(input.valuationDate, '估值基准日')
  if (!input.rationale.trim() || !input.invalidationCondition.trim()) {
    throw new IndustryResearchDecisionError('INVALID_PARAM', '决策依据和失效条件不能为空')
  }
  if (!Number.isSafeInteger(input.validUntil) || input.validUntil <= Date.now()) {
    throw new IndustryResearchDecisionError('INVALID_PARAM', '决策有效期必须晚于当前时间')
  }
  if (!input.factIds.length && !input.evidenceIds.length && !input.hypothesisIds.length) {
    throw new IndustryResearchDecisionError('DECISION_EVIDENCE_REQUIRED', '研究决策至少关联一项事实、证据或假设')
  }
  requireFinancialFacts(db, input.projectId, input.companyId ?? null, input.factIds)
  requireIds(db, 'industry_research_evidence', 'project_id', input.projectId, input.evidenceIds)
  requireIds(db, 'industry_research_hypotheses', 'project_id', input.projectId, input.hypothesisIds)
  requireIds(db, 'industry_research_work_item_versions', 'project_id', input.projectId, input.workItemVersionIds)
  validateAvailabilityDate(db, input.dataAsOf, input.factIds, input.evidenceIds)
  if (input.scenarioSetVersionId && !getScenarioSetVersion(db, input.projectId, input.scenarioSetVersionId)) {
    throw new IndustryResearchDecisionError('NOT_FOUND', '情景版本不存在或不属于当前项目')
  }
  if (input.sourceTriggerEvaluationId && !getTriggerEvaluation(db, input.projectId, input.sourceTriggerEvaluationId)) {
    throw new IndustryResearchDecisionError('NOT_FOUND', '触发求值不存在或不属于当前项目')
  }
  const marketSnapshot = input.marketSnapshotId ? getMarketSnapshot(db, input.projectId, input.marketSnapshotId) : null
  const valuationSnapshot = input.valuationSnapshotId ? getValuationSnapshot(db, input.projectId, input.valuationSnapshotId) : null
  if (input.marketSnapshotId && (!marketSnapshot || marketSnapshot.company_id !== (input.companyId ?? null))) {
    throw new IndustryResearchDecisionError('NOT_FOUND', '市场快照不存在或不属于当前项目公司')
  }
  if (input.valuationSnapshotId && (!valuationSnapshot || valuationSnapshot.company_id !== (input.companyId ?? null)
    || valuationSnapshot.market_snapshot_id !== input.marketSnapshotId)) {
    throw new IndustryResearchDecisionError('NOT_FOUND', '估值快照不存在或与市场快照不匹配')
  }
  if (input.action === 'wait_price' && (!marketSnapshot || !valuationSnapshot
    || marketSnapshot.status === 'blocked' || valuationSnapshot.status === 'blocked')) {
    throw new IndustryResearchDecisionError('MARKET_DATA_BLOCKED', '等待价格决策必须绑定非阻断市场与估值快照')
  }
  if (valuationSnapshot && input.scenarioSetVersionId !== valuationSnapshot.scenario_set_version_id) {
    throw new IndustryResearchDecisionError('VERSION_CONFLICT', '估值快照与情景版本不一致')
  }
  const adoption = getLatestSkillAdoption(db, input.projectId)
  if (!adoption) throw new IndustryResearchDecisionError('SKILL_ADOPTION_REQUIRED', '项目尚未保存可回放的Skill规则')
  const latest = getLatestDecisionEvent(db, input.projectId, input.decisionId)
  if ((latest?.id ?? null) !== input.expectedLastEventId) {
    throw new IndustryResearchDecisionError('VERSION_CONFLICT', '研究决策已变化，请刷新后重试')
  }
  const decision = getDecision(db, input.projectId, input.decisionId)
  if (input.eventType === 'created' ? decision != null || latest != null : decision == null || latest == null) {
    throw new IndustryResearchDecisionError('VERSION_CONFLICT', '决策事件类型与当前状态不一致')
  }
  if (decision && decision.company_id !== (input.companyId ?? null)) {
    throw new IndustryResearchDecisionError('NOT_FOUND', '决策公司归属不一致')
  }
  const append = db.transaction(() => {
    if (!decision) {
      createDecision(db, {
        id: input.decisionId,
        project_id: input.projectId,
        company_id: input.companyId ?? null,
        created_at: Date.now(),
      })
    }
    const researchSnapshot = createIndustryResearchSnapshot(db, {
      projectId: input.projectId,
      reason: 'decision_basis',
      requestId: `${input.requestId}:snapshot`,
      skillSnapshotId: adoption.target_snapshot_id,
      sourceOriginType: 'decision',
      sourceOriginId: input.decisionId,
    })
    return decisionEventView(saveDecisionEvent(db, {
      id: randomUUID(),
      request_id: input.requestId,
      decision_id: input.decisionId,
      project_id: input.projectId,
      previous_event_id: latest?.id ?? null,
      event_type: input.eventType,
      action: input.action,
      rationale: input.rationale.trim(),
      data_as_of: input.dataAsOf,
      valuation_date: input.valuationDate ?? null,
      valid_until: input.validUntil,
      invalidation_condition: input.invalidationCondition.trim(),
      skill_snapshot_id: adoption.target_snapshot_id,
      research_snapshot_id: researchSnapshot.id,
      scenario_set_version_id: input.scenarioSetVersionId ?? null,
      work_item_ids_json: json(input.workItemVersionIds, '研究工作项'),
      fact_ids_json: json(input.factIds, '财务事实'),
      evidence_ids_json: json(input.evidenceIds, '研究证据'),
      hypothesis_ids_json: json(input.hypothesisIds, '研究假设'),
      source_trigger_evaluation_id: input.sourceTriggerEvaluationId ?? null,
      market_snapshot_id: input.marketSnapshotId ?? null,
      valuation_snapshot_id: input.valuationSnapshotId ?? null,
      created_at: Date.now(),
    }))
  })
  return append()
}

function monitoringItemView(row: IndustryResearchMonitoringItemVersionRow) {
  const hypotheses = safeJson<string[]>(row.hypothesis_ids_json, [])
  const scenarios = safeJson<string[]>(row.scenario_set_ids_json, [])
  const decisions = safeJson<string[]>(row.decision_ids_json, [])
  return {
    id: row.monitoring_item_id,
    versionId: row.id,
    projectId: row.project_id,
    version: row.version,
    previousVersionId: row.previous_version_id,
    name: row.name,
    valueKind: row.value_kind,
    frequency: row.frequency,
    sourceName: row.source_name,
    sourceRef: row.source_ref,
    unit: row.unit,
    timingType: row.timing_type,
    staleAfterMs: row.stale_after_ms,
    nextReviewAt: row.next_review_at,
    hypothesisIds: hypotheses.value,
    scenarioSetVersionIds: scenarios.value,
    decisionIds: decisions.value,
    status: row.status,
    createdAt: row.created_at,
    dataStatus: hypotheses.corrupt || scenarios.corrupt || decisions.corrupt ? 'corrupt' : 'ok',
  }
}

export function listIndustryResearchMonitoringItems(db: Database.Database, projectId: string) {
  requireProject(db, projectId)
  return listLatestMonitoringItemVersions(db, projectId).map((item) => ({
    ...monitoringItemView(item),
    latestObservation: listLatestMonitoringObservations(db, projectId, item.monitoring_item_id, 1).map(observationView)[0] ?? null,
  }))
}

export function saveIndustryResearchMonitoringItem(
  db: Database.Database,
  input: {
    projectId: string
    requestId: string
    monitoringItemId: string
    expectedVersion: number
    name: string
    valueKind: ResearchMonitoringValueKind
    frequency: ResearchMonitoringFrequency
    sourceName: string
    sourceRef?: string | null
    unit?: string | null
    timingType: ResearchMonitoringTiming
    staleAfterMs: number
    nextReviewAt?: number | null
    hypothesisIds: string[]
    scenarioSetVersionIds: string[]
    decisionIds: string[]
    status: 'active' | 'paused' | 'closed'
  },
) {
  const idempotent = getMonitoringItemVersionByRequestId(db, input.requestId)
  if (idempotent) {
    requireIdempotentScope(idempotent.project_id === input.projectId
      && idempotent.monitoring_item_id === input.monitoringItemId)
    return monitoringItemView(idempotent)
  }
  requireProject(db, input.projectId)
  if (!input.name.trim() || !input.sourceName.trim() || !Number.isSafeInteger(input.staleAfterMs) || input.staleAfterMs <= 0) {
    throw new IndustryResearchDecisionError('INVALID_PARAM', '监控项名称、来源或过期窗口无效')
  }
  requireIds(db, 'industry_research_hypotheses', 'project_id', input.projectId, input.hypothesisIds)
  requireIds(db, 'industry_research_scenario_set_versions', 'project_id', input.projectId, input.scenarioSetVersionIds)
  for (const decisionId of input.decisionIds) {
    if (!getDecision(db, input.projectId, decisionId)) throw new IndustryResearchDecisionError('NOT_FOUND', '关联决策不存在')
  }
  const latest = getLatestMonitoringItemVersion(db, input.projectId, input.monitoringItemId)
  if ((latest?.version ?? 0) !== input.expectedVersion) {
    throw new IndustryResearchDecisionError('VERSION_CONFLICT', '监控项已变化，请刷新后重试')
  }
  return monitoringItemView(saveMonitoringItemVersion(db, {
    id: randomUUID(),
    monitoring_item_id: input.monitoringItemId,
    project_id: input.projectId,
    version: input.expectedVersion + 1,
    previous_version_id: latest?.id ?? null,
    request_id: input.requestId,
    name: input.name.trim(),
    value_kind: input.valueKind,
    frequency: input.frequency,
    source_name: input.sourceName.trim(),
    source_ref: input.sourceRef?.trim() || null,
    unit: input.unit?.trim() || null,
    timing_type: input.timingType,
    stale_after_ms: input.staleAfterMs,
    next_review_at: input.nextReviewAt ?? null,
    hypothesis_ids_json: json(input.hypothesisIds, '关联假设'),
    scenario_set_ids_json: json(input.scenarioSetVersionIds, '关联情景'),
    decision_ids_json: json(input.decisionIds, '关联决策'),
    status: input.status,
    created_at: Date.now(),
  }))
}

function observationView(row: IndustryResearchMonitoringObservationRow) {
  return {
    id: row.id,
    monitoringItemId: row.monitoring_item_id,
    monitoringItemVersionId: row.monitoring_item_version_id,
    value: row.value_number ?? row.value_text,
    unit: row.unit,
    sourceRef: row.source_ref,
    observedAt: row.observed_at,
    availableAt: row.available_at,
    dataAsOf: row.data_as_of,
    methodologyVersion: row.methodology_version,
    createdAt: row.created_at,
  }
}

export function appendIndustryResearchMonitoringObservation(
  db: Database.Database,
  input: {
    projectId: string
    requestId: string
    monitoringItemId: string
    expectedVersion: number
    value: number | string
    unit?: string | null
    sourceRef?: string | null
    observedAt: number
    availableAt: number
    dataAsOf: string
    methodologyVersion: string
  },
) {
  const idempotent = getMonitoringObservationByRequestId(db, input.requestId)
  if (idempotent) {
    requireIdempotentScope(idempotent.project_id === input.projectId
      && idempotent.monitoring_item_id === input.monitoringItemId)
    return observationView(idempotent)
  }
  requireProject(db, input.projectId)
  requireDate(input.dataAsOf, '数据截至日')
  const item = getLatestMonitoringItemVersion(db, input.projectId, input.monitoringItemId)
  if (!item) throw new IndustryResearchDecisionError('NOT_FOUND', '监控项不存在')
  if (item.version !== input.expectedVersion) throw new IndustryResearchDecisionError('VERSION_CONFLICT', '监控项已变化，请刷新后重试')
  if (item.value_kind === 'number' ? typeof input.value !== 'number' || !Number.isFinite(input.value) : typeof input.value !== 'string' || !input.value.trim()) {
    throw new IndustryResearchDecisionError('INVALID_PARAM', '监控观测值类型无效')
  }
  if (!Number.isSafeInteger(input.observedAt) || !Number.isSafeInteger(input.availableAt) || input.availableAt < input.observedAt || input.availableAt > Date.now()) {
    throw new IndustryResearchDecisionError('INVALID_PARAM', '监控观测时间无效')
  }
  if (!input.methodologyVersion.trim()) throw new IndustryResearchDecisionError('INVALID_PARAM', '监控口径版本不能为空')
  return observationView(saveMonitoringObservation(db, {
    id: randomUUID(),
    request_id: input.requestId,
    project_id: input.projectId,
    monitoring_item_id: input.monitoringItemId,
    monitoring_item_version_id: item.id,
    value_number: typeof input.value === 'number' ? input.value : null,
    value_text: typeof input.value === 'string' ? input.value.trim() : null,
    unit: input.unit?.trim() || null,
    source_ref: input.sourceRef?.trim() || null,
    observed_at: input.observedAt,
    available_at: input.availableAt,
    data_as_of: input.dataAsOf,
    methodology_version: input.methodologyVersion.trim(),
    created_at: Date.now(),
  }))
}

function triggerView(row: IndustryResearchDecisionTriggerVersionRow) {
  return {
    id: row.trigger_id,
    versionId: row.id,
    projectId: row.project_id,
    decisionId: row.decision_id,
    monitoringItemId: row.monitoring_item_id,
    monitoringItemVersionId: row.monitoring_item_version_id,
    version: row.version,
    previousVersionId: row.previous_version_id,
    metricName: row.metric_name,
    operator: row.operator,
    threshold: row.threshold_number ?? row.threshold_text,
    validationWindowMs: row.validation_window_ms,
    actionIfNotTriggered: row.action_if_not_triggered,
    proposedActionIfTriggered: row.proposed_action_if_triggered,
    expiresAt: row.expires_at,
    status: row.status,
    createdAt: row.created_at,
  }
}

export function listIndustryResearchDecisionTriggers(db: Database.Database, projectId: string) {
  requireProject(db, projectId)
  return listLatestTriggerVersions(db, projectId).map(triggerView)
}

export function saveIndustryResearchDecisionTrigger(
  db: Database.Database,
  input: {
    projectId: string
    requestId: string
    triggerId: string
    expectedVersion: number
    decisionId: string
    monitoringItemId: string
    metricName: string
    operator: ResearchTriggerOperator
    threshold: number | string | null
    validationWindowMs: number
    actionIfNotTriggered: ResearchDecisionAction
    proposedActionIfTriggered: ResearchDecisionAction
    expiresAt?: number | null
    status: 'active' | 'disabled'
  },
) {
  const idempotent = getTriggerVersionByRequestId(db, input.requestId)
  if (idempotent) {
    requireIdempotentScope(idempotent.project_id === input.projectId
      && idempotent.trigger_id === input.triggerId
      && idempotent.decision_id === input.decisionId
      && idempotent.monitoring_item_id === input.monitoringItemId)
    return triggerView(idempotent)
  }
  requireProject(db, input.projectId)
  if (!getDecision(db, input.projectId, input.decisionId)) throw new IndustryResearchDecisionError('NOT_FOUND', '研究决策不存在')
  const monitoring = getLatestMonitoringItemVersion(db, input.projectId, input.monitoringItemId)
  if (!monitoring) throw new IndustryResearchDecisionError('NOT_FOUND', '监控项不存在')
  if (!input.metricName.trim() || !Number.isSafeInteger(input.validationWindowMs) || input.validationWindowMs <= 0) {
    throw new IndustryResearchDecisionError('INVALID_PARAM', '触发指标或验证窗口无效')
  }
  if (input.operator === 'changed' ? input.threshold != null : input.threshold == null) {
    throw new IndustryResearchDecisionError('INVALID_PARAM', '触发器阈值与运算符不匹配')
  }
  if (typeof input.threshold === 'number' && !Number.isFinite(input.threshold)) {
    throw new IndustryResearchDecisionError('INVALID_PARAM', '触发器数值阈值无效')
  }
  if (['gt', 'gte', 'lt', 'lte'].includes(input.operator) && (monitoring.value_kind !== 'number' || typeof input.threshold !== 'number')) {
    throw new IndustryResearchDecisionError('INVALID_PARAM', '数值运算符只能用于数值监控项')
  }
  const latest = getLatestTriggerVersion(db, input.projectId, input.triggerId)
  if ((latest?.version ?? 0) !== input.expectedVersion) throw new IndustryResearchDecisionError('VERSION_CONFLICT', '触发器已变化，请刷新后重试')
  return triggerView(saveTriggerVersion(db, {
    id: randomUUID(),
    trigger_id: input.triggerId,
    project_id: input.projectId,
    decision_id: input.decisionId,
    monitoring_item_id: input.monitoringItemId,
    monitoring_item_version_id: monitoring.id,
    version: input.expectedVersion + 1,
    previous_version_id: latest?.id ?? null,
    request_id: input.requestId,
    metric_name: input.metricName.trim(),
    operator: input.operator,
    threshold_number: typeof input.threshold === 'number' ? input.threshold : null,
    threshold_text: typeof input.threshold === 'string' ? input.threshold.trim() : null,
    validation_window_ms: input.validationWindowMs,
    action_if_not_triggered: input.actionIfNotTriggered,
    proposed_action_if_triggered: input.proposedActionIfTriggered,
    expires_at: input.expiresAt ?? null,
    status: input.status,
    created_at: Date.now(),
  }))
}

function evaluateComparison(
  trigger: IndustryResearchDecisionTriggerVersionRow,
  current: IndustryResearchMonitoringObservationRow,
  previous: IndustryResearchMonitoringObservationRow | undefined,
): boolean {
  if (trigger.operator === 'changed') {
    if (!previous) return false
    return (current.value_number ?? current.value_text) !== (previous.value_number ?? previous.value_text)
  }
  const value = current.value_number ?? current.value_text
  const threshold = trigger.threshold_number ?? trigger.threshold_text
  if (trigger.operator === 'eq') return value === threshold
  if (typeof value !== 'number' || typeof threshold !== 'number') return false
  if (trigger.operator === 'gt') return value > threshold
  if (trigger.operator === 'gte') return value >= threshold
  if (trigger.operator === 'lt') return value < threshold
  return value <= threshold
}

function evaluationView(row: IndustryResearchDecisionTriggerEvaluationRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    triggerId: row.trigger_id,
    triggerVersionId: row.trigger_version_id,
    observationId: row.observation_id,
    result: row.result,
    reason: row.result_reason,
    evaluatedAt: row.evaluated_at,
  }
}

export function evaluateIndustryResearchDecisionTriggers(
  db: Database.Database,
  input: { projectId: string; requestId: string; triggerIds: string[]; evaluatedAt?: number },
) {
  requireProject(db, input.projectId)
  if (!input.triggerIds.length || input.triggerIds.length > 50 || new Set(input.triggerIds).size !== input.triggerIds.length) {
    throw new IndustryResearchDecisionError('INVALID_PARAM', '触发器列表无效')
  }
  const now = input.evaluatedAt ?? Date.now()
  const evaluate = db.transaction(() => input.triggerIds.map((triggerId) => {
    const requestId = `${input.requestId}:${triggerId}`
    const idempotent = getTriggerEvaluationByRequestId(db, requestId)
    if (idempotent) {
      requireIdempotentScope(idempotent.project_id === input.projectId && idempotent.trigger_id === triggerId)
      return evaluationView(idempotent)
    }
    const trigger = getLatestTriggerVersion(db, input.projectId, triggerId)
    if (!trigger || trigger.status !== 'active') throw new IndustryResearchDecisionError('NOT_FOUND', '有效触发器不存在')
    const monitoring = getLatestMonitoringItemVersion(db, input.projectId, trigger.monitoring_item_id)
    const observations = listLatestMonitoringObservations(db, input.projectId, trigger.monitoring_item_id, 2)
    const current = observations[0]
    let result: IndustryResearchDecisionTriggerEvaluationRow['result'] = 'blocked'
    let reason = '监控观测缺失'
    if (trigger.expires_at != null && trigger.expires_at <= now) {
      result = 'expired'
      reason = '触发器已过期'
    } else if (!monitoring || !current) {
      result = 'blocked'
      reason = '监控项或观测缺失'
    } else if (current.monitoring_item_version_id !== trigger.monitoring_item_version_id) {
      result = 'blocked'
      reason = '监控口径已变化，需重新确认触发器'
    } else if (current.available_at > now || now - current.observed_at > monitoring.stale_after_ms || now - current.observed_at > trigger.validation_window_ms) {
      result = 'blocked'
      reason = '监控观测尚不可用或已过期'
    } else if ((monitoring.unit ?? null) !== (current.unit ?? null)) {
      result = 'blocked'
      reason = '监控观测单位不一致'
    } else if (trigger.operator === 'changed' && !observations[1]) {
      result = 'blocked'
      reason = '变化触发器缺少前序观测'
    } else if (evaluateComparison(trigger, current, observations[1])) {
      result = 'pending_review'
      reason = '触发条件命中，等待人工复核'
    } else {
      result = 'not_triggered'
      reason = '触发条件未命中'
    }
    const saved = saveTriggerEvaluation(db, {
      id: randomUUID(),
      request_id: requestId,
      project_id: input.projectId,
      trigger_id: triggerId,
      trigger_version_id: trigger.id,
      observation_id: current?.id ?? null,
      result,
      result_reason: reason,
      evaluated_at: now,
    })
    if (result === 'pending_review') {
      appendPendingReview(db, {
        requestId: `${requestId}:review`,
        reviewGroupId: `trigger:${saved.id}`,
        projectId: input.projectId,
        kind: 'trigger',
        subjectKind: 'decision_trigger',
        subjectId: triggerId,
        sourceEventId: saved.id,
        reason,
        payload: {
          proposedAction: trigger.proposed_action_if_triggered,
          observationId: current!.id,
          decisionId: trigger.decision_id,
        },
      })
    }
    return evaluationView(saved)
  }))
  return evaluate()
}

export function resolveIndustryResearchReviewItem(
  db: Database.Database,
  input: {
    projectId: string
    requestId: string
    reviewGroupId: string
    resolution: 'confirm' | 'dismiss'
    reason: string
  },
) {
  const idempotent = getReviewEventByRequestId(db, input.requestId)
  if (idempotent) {
    requireIdempotentScope(idempotent.project_id === input.projectId
      && idempotent.review_group_id === input.reviewGroupId)
    return idempotent
  }
  const latest = getLatestReviewEvent(db, input.projectId, input.reviewGroupId)
  if (!latest) throw new IndustryResearchDecisionError('NOT_FOUND', '待复核项不存在')
  if (latest.state !== 'pending') throw new IndustryResearchDecisionError('TRIGGER_REVIEW_REQUIRED', '待复核项已处理')
  if (!input.reason.trim()) throw new IndustryResearchDecisionError('INVALID_PARAM', '处置原因不能为空')
  return saveReviewEvent(db, {
    ...latest,
    id: randomUUID(),
    request_id: input.requestId,
    previous_event_id: latest.id,
    state: input.resolution === 'confirm' ? 'confirmed' : 'dismissed',
    reason: input.reason.trim(),
    created_at: Date.now(),
  })
}

export function resolveIndustryResearchTriggerReview(
  db: Database.Database,
  input: {
    projectId: string
    evaluationId: string
    requestId: string
    resolution: 'confirm' | 'dismiss'
    reason: string
    decisionEvent?: AppendDecisionEventInput
  },
) {
  const idempotent = getReviewEventByRequestId(db, input.requestId)
  if (idempotent) {
    requireIdempotentScope(idempotent.project_id === input.projectId
      && idempotent.source_event_id === input.evaluationId)
    return {
      review: idempotent,
      decisionEvent: getDecisionEventByTriggerEvaluation(db, input.projectId, input.evaluationId),
    }
  }
  const evaluation = getTriggerEvaluation(db, input.projectId, input.evaluationId)
  if (!evaluation || evaluation.result !== 'pending_review') {
    throw new IndustryResearchDecisionError('TRIGGER_REVIEW_REQUIRED', '触发求值不处于待复核状态')
  }
  const trigger = db.prepare('SELECT * FROM industry_research_decision_trigger_versions WHERE id = ?')
    .get(evaluation.trigger_version_id) as IndustryResearchDecisionTriggerVersionRow | undefined
  if (!trigger) throw new IndustryResearchDecisionError('NOT_FOUND', '触发器版本不存在')
  const reviewGroupId = `trigger:${evaluation.id}`
  const latestReview = getLatestReviewEvent(db, input.projectId, reviewGroupId)
  if (!latestReview || latestReview.state !== 'pending') throw new IndustryResearchDecisionError('TRIGGER_REVIEW_REQUIRED', '触发待复核项已处理')
  if (!input.reason.trim()) throw new IndustryResearchDecisionError('INVALID_PARAM', '处置原因不能为空')
  const resolve = db.transaction(() => {
    let decisionEvent: ReturnType<typeof decisionEventView> | null = null
    if (input.resolution === 'confirm') {
      if (!input.decisionEvent || input.decisionEvent.sourceTriggerEvaluationId !== evaluation.id
        || input.decisionEvent.action !== trigger.proposed_action_if_triggered
        || input.decisionEvent.decisionId !== trigger.decision_id
        || input.decisionEvent.projectId !== input.projectId) {
        throw new IndustryResearchDecisionError('INVALID_PARAM', '确认触发器必须提交匹配的完整决策事件')
      }
      decisionEvent = appendIndustryResearchDecisionEvent(db, input.decisionEvent)
    }
    const review = saveReviewEvent(db, {
      ...latestReview,
      id: randomUUID(),
      request_id: input.requestId,
      previous_event_id: latestReview.id,
      state: input.resolution === 'confirm' ? 'confirmed' : 'dismissed',
      reason: input.reason.trim(),
      created_at: Date.now(),
    })
    return { review, decisionEvent }
  })
  return resolve()
}

export function getIndustryResearchReviewQueue(db: Database.Database, projectId: string) {
  const project = requireProject(db, projectId)
  const now = Date.now()
  const items: Array<Record<string, unknown>> = listLatestReviewEvents(db, projectId)
    .filter((event) => event.state === 'pending')
    .map((event) => {
      const payload = safeJson<Record<string, unknown>>(event.payload_json, {})
      return {
        id: event.review_group_id,
        kind: event.kind,
        subjectKind: event.subject_kind,
        subjectId: event.subject_id,
        sourceEventId: event.source_event_id,
        payload: payload.value,
        dataStatus: payload.corrupt ? 'corrupt' : 'ok',
        reason: event.reason,
        dueAt: null,
        persisted: true,
        createdAt: event.created_at,
      }
    })
  for (const work of listLatestWorkItemVersions(db, projectId).filter((item) => item.status === 'open' || item.status === 'blocked')) {
    items.push({ id: `work:${work.work_item_id}`, kind: 'work_item', subjectKind: 'work_item', subjectId: work.work_item_id, reason: work.question, dueAt: null, persisted: false })
  }
  if (project.next_review_at && project.next_review_at <= now) {
    items.push({ id: `project:${project.id}:${project.next_review_at}`, kind: 'project_boundary', subjectKind: 'project', subjectId: project.id, reason: '项目已到回访时间', dueAt: project.next_review_at, persisted: false })
  }
  const hypotheses = db.prepare(`
    SELECT id, statement, due_at FROM industry_research_hypotheses
    WHERE project_id = ? AND due_at IS NOT NULL AND due_at <= ? AND status != 'refuted'
  `).all(projectId, now) as Array<{ id: string; statement: string; due_at: number }>
  for (const item of hypotheses) {
    items.push({ id: `hypothesis:${item.id}:${item.due_at}`, kind: 'hypothesis_due', subjectKind: 'hypothesis', subjectId: item.id, reason: item.statement, dueAt: item.due_at, persisted: false })
  }
  for (const decision of listLatestDecisionEvents(db, projectId).filter((item) => item.valid_until <= now && !['closed', 'invalidated'].includes(item.event_type))) {
    items.push({ id: `decision:${decision.decision_id}:${decision.id}`, kind: 'decision_expiry', subjectKind: 'decision', subjectId: decision.decision_id, reason: '研究决策已到有效期', dueAt: decision.valid_until, persisted: false })
  }
  for (const monitoring of listLatestMonitoringItemVersions(db, projectId).filter((item) => item.status === 'active')) {
    const latest = listLatestMonitoringObservations(db, projectId, monitoring.monitoring_item_id, 1)[0]
    if (!latest || now - latest.observed_at > monitoring.stale_after_ms || (monitoring.next_review_at != null && monitoring.next_review_at <= now)) {
      items.push({ id: `monitor:${monitoring.monitoring_item_id}:${monitoring.id}`, kind: 'monitoring_stale', subjectKind: 'monitoring_item', subjectId: monitoring.monitoring_item_id, reason: latest ? '监控观测已过期' : '监控观测缺失', dueAt: monitoring.next_review_at, persisted: false })
    }
  }
  return items.sort((left, right) => Number(left.dueAt ?? Number.MAX_SAFE_INTEGER) - Number(right.dueAt ?? Number.MAX_SAFE_INTEGER))
}

export function getIndustryResearchDecisionReplay(
  db: Database.Database,
  projectId: string,
  decisionId: string,
) {
  requireProject(db, projectId)
  const decision = getDecision(db, projectId, decisionId)
  const latest = getLatestDecisionEvent(db, projectId, decisionId)
  if (!decision || !latest) throw new IndustryResearchDecisionError('NOT_FOUND', '研究决策不存在')
  const skill = getSkillSnapshot(db, latest.skill_snapshot_id)
  if (!skill) throw new IndustryResearchDecisionError('DECISION_REPLAY_INCOMPLETE', '决策Skill快照缺失')
  const research = getIndustryResearchSnapshot(db, projectId, latest.research_snapshot_id)
  const scenario = latest.scenario_set_version_id
    ? getScenarioSetVersion(db, projectId, latest.scenario_set_version_id)
    : null
  const triggerEvaluation = latest.source_trigger_evaluation_id
    ? getTriggerEvaluation(db, projectId, latest.source_trigger_evaluation_id)
    : null
  const facts = safeJson<string[]>(latest.fact_ids_json, []).value
  const financialFacts = facts.length
    ? db.prepare(`SELECT * FROM industry_research_financial_facts WHERE id IN (${facts.map(() => '?').join(',')})`).all(...facts)
    : []
  const marketSnapshot = latest.market_snapshot_id ? getMarketSnapshot(db, projectId, latest.market_snapshot_id) : null
  const valuationSnapshot = latest.valuation_snapshot_id ? getValuationSnapshot(db, projectId, latest.valuation_snapshot_id) : null
  const marketData = marketSnapshot ? safeJson<Record<string, unknown>>(marketSnapshot.market_data_json, {}) : null
  const valuationData = valuationSnapshot ? safeJson<Record<string, unknown>>(valuationSnapshot.output_json, {}) : null
  const marketCorrupt = marketData?.corrupt || valuationData?.corrupt
  return {
    decision: { ...decisionEventView(latest), companyId: decision.company_id },
    history: listDecisionEvents(db, projectId, decisionId).map(decisionEventView),
    skillSnapshot: { ...skillSnapshotView(skill), content: skill.content },
    researchVersion: research,
    scenarioSet: scenario ? scenarioSetView(db, scenario) : null,
    financialFacts,
    triggerEvaluation: triggerEvaluation ? evaluationView(triggerEvaluation) : null,
    marketContext: marketSnapshot && !marketCorrupt ? {
      status: marketSnapshot.status === 'blocked' || valuationSnapshot?.status === 'blocked' ? 'blocked' : marketSnapshot.status,
      reason: marketSnapshot.status === 'blocked' ? '决策时点市场快照处于阻断状态' : null,
      marketSnapshotId: marketSnapshot.id,
      valuationSnapshotId: valuationSnapshot?.id ?? null,
      price: marketSnapshot.raw_close,
      marketDate: marketSnapshot.market_date,
      benchmark: marketSnapshot.benchmark_code ? { code: marketSnapshot.benchmark_code, name: marketSnapshot.benchmark_name } : null,
      market: marketData?.value ?? null,
      valuation: valuationData?.value ?? null,
      capturedAt: marketSnapshot.created_at,
    } : {
      status: 'blocked',
      reason: marketCorrupt ? '决策市场或估值快照损坏，已隔离该区块' : '该历史决策没有可信的市场与估值快照',
      price: null,
      benchmark: null,
      valuation: null,
    },
  }
}
