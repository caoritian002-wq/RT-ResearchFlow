import type Database from 'better-sqlite3'
import type {
  EvidenceCreator,
  EvidenceDirection,
  EvidenceReliability,
  HypothesisStatus,
  IndustryResearchEdgeRow,
  IndustryResearchEvidenceRow,
  IndustryResearchHypothesisEventRow,
  IndustryResearchHypothesisRow,
  IndustryResearchNodeRow,
  IndustryResearchProjectRow,
  IndustryResearchNodeType,
  ResearchDepth,
  ResearchProjectStatus,
  ResearchPurpose,
  ResearchSourceType,
  ResearchStatementKind,
} from './types'

export interface ResearchProjectInput {
  id: string
  title: string
  industryName: string
  productScope: string
  regionScope: string
  timeScope: string
  purpose: ResearchPurpose
  depth: ResearchDepth
  status?: ResearchProjectStatus
  dataAsOf?: string | null
  valuationDate?: string | null
  sourceType: ResearchSourceType
  sourceRef?: string | null
  sourceTextSummary?: string | null
  skillId: string
  skillContentHash: string
  skillRuleVersion?: string | null
  generationModel?: string | null
  nextReviewAt?: number | null
  stopCondition?: string | null
}

export interface ResearchNodeInput {
  id: string
  type: IndustryResearchNodeType
  name: string
  stage?: string | null
  statementKind: ResearchStatementKind
  status?: string | null
  metrics?: unknown[]
  evidenceIds?: string[]
  lastUpdated?: string | null
}

export interface ResearchEdgeInput {
  id: string
  source: string
  target: string
  relation: string
  statementKind: ResearchStatementKind
  strength?: number | null
  bottleneck?: boolean
  exposurePct?: number | null
  evidenceIds?: string[]
  lastUpdated?: string | null
}

export interface ResearchEvidenceInput {
  id: string
  title: string
  sourceType: string
  sourceName: string
  sourceUrl?: string | null
  sourceRef?: string | null
  publishedDate?: string | null
  factDate?: string | null
  collectedAt?: number
  metricName?: string | null
  metricValue?: number | null
  unit?: string | null
  region?: string | null
  productSpec?: string | null
  methodology?: string | null
  statementKind: ResearchStatementKind
  direction: EvidenceDirection
  reliability: EvidenceReliability
  createdBy: EvidenceCreator
  primarySourceConfirmed?: boolean
  conflictNote?: string | null
  excerpt?: string | null
}

export interface ResearchHypothesisInput {
  id: string
  statement: string
  importance: number
  status?: HypothesisStatus
  cheapestDisproof: string
  verificationMetric?: string | null
  threshold?: string | null
  dueAt?: number | null
  evidenceIds?: string[]
}

export function createResearchProject(db: Database.Database, input: ResearchProjectInput): IndustryResearchProjectRow {
  const now = Date.now()
  db.prepare(`
    INSERT INTO industry_research_projects (
      id, title, industry_name, product_scope, region_scope, time_scope, purpose, depth, status,
      data_as_of, valuation_date, source_type, source_ref, source_text_summary,
      skill_id, skill_content_hash, skill_rule_version, generation_model,
      next_review_at, stop_condition, graph_updated_at, created_at, updated_at
    ) VALUES (
      @id, @title, @industryName, @productScope, @regionScope, @timeScope, @purpose, @depth, @status,
      @dataAsOf, @valuationDate, @sourceType, @sourceRef, @sourceTextSummary,
      @skillId, @skillContentHash, @skillRuleVersion, @generationModel,
      @nextReviewAt, @stopCondition, @graphUpdatedAt, @createdAt, @updatedAt
    )
  `).run({
    ...input,
    status: input.status ?? 'draft',
    dataAsOf: input.dataAsOf ?? null,
    valuationDate: input.valuationDate ?? null,
    sourceRef: input.sourceRef ?? null,
    sourceTextSummary: input.sourceTextSummary ?? null,
    skillRuleVersion: input.skillRuleVersion ?? null,
    generationModel: input.generationModel ?? null,
    nextReviewAt: input.nextReviewAt ?? null,
    stopCondition: input.stopCondition ?? null,
    graphUpdatedAt: now,
    createdAt: now,
    updatedAt: now,
  })
  return getResearchProject(db, input.id)!
}

export function getResearchProject(db: Database.Database, projectId: string): IndustryResearchProjectRow | null {
  return (db.prepare('SELECT * FROM industry_research_projects WHERE id = ?').get(projectId) as IndustryResearchProjectRow | undefined) ?? null
}

export function updateResearchProjectSkill(
  db: Database.Database,
  projectId: string,
  expectedUpdatedAt: number,
  skill: { skillId: string; contentHash: string; ruleVersion: string },
): IndustryResearchProjectRow {
  const updatedAt = Math.max(Date.now(), expectedUpdatedAt + 1)
  const result = db.prepare(`
    UPDATE industry_research_projects
    SET skill_id = ?, skill_content_hash = ?, skill_rule_version = ?, updated_at = ?
    WHERE id = ? AND updated_at = ?
  `).run(
    skill.skillId, skill.contentHash, skill.ruleVersion, updatedAt, projectId, expectedUpdatedAt,
  )
  if (!result.changes) throw new Error('VERSION_CONFLICT')
  return getResearchProject(db, projectId)!
}

export function listResearchProjects(
  db: Database.Database,
  filters: {
    status?: ResearchProjectStatus
    query?: string
    limit: number
    offset: number
    includeArchived?: boolean
  },
): { items: IndustryResearchProjectRow[]; total: number } {
  const clauses: string[] = []
  const params: Record<string, unknown> = { limit: filters.limit, offset: filters.offset }
  if (filters.status) {
    clauses.push('status = @status')
    params.status = filters.status
  } else if (filters.includeArchived === false) {
    // 默认主队列隐藏已归档，避免垃圾项目占位
    clauses.push("status != 'archived'")
  }
  if (filters.query) {
    clauses.push('(title LIKE @query OR industry_name LIKE @query OR product_scope LIKE @query)')
    params.query = `%${filters.query}%`
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const items = db.prepare(`
    SELECT * FROM industry_research_projects ${where}
    ORDER BY updated_at DESC, id DESC LIMIT @limit OFFSET @offset
  `).all(params) as IndustryResearchProjectRow[]
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM industry_research_projects ${where}`).get(params) as { count: number }).count
  return { items, total }
}

export function updateResearchProject(
  db: Database.Database,
  projectId: string,
  patch: Partial<Pick<ResearchProjectInput, 'title' | 'industryName' | 'productScope' | 'regionScope' | 'timeScope' | 'purpose' | 'depth' | 'status' | 'dataAsOf' | 'valuationDate' | 'nextReviewAt' | 'stopCondition'>>,
): IndustryResearchProjectRow | null {
  const columns: Record<string, string> = {
    title: 'title', industryName: 'industry_name', productScope: 'product_scope', regionScope: 'region_scope',
    timeScope: 'time_scope', purpose: 'purpose', depth: 'depth', status: 'status', dataAsOf: 'data_as_of',
    valuationDate: 'valuation_date', nextReviewAt: 'next_review_at', stopCondition: 'stop_condition',
  }
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
  if (!entries.length) return getResearchProject(db, projectId)
  const params: Record<string, unknown> = { projectId, updatedAt: Date.now() }
  const assignments = entries.map(([key, value]) => {
    params[key] = value
    return `${columns[key]} = @${key}`
  })
  db.prepare(`UPDATE industry_research_projects SET ${assignments.join(', ')}, updated_at = @updatedAt WHERE id = @projectId`).run(params)
  return getResearchProject(db, projectId)
}

/**
 * 物理删除研究项目及其项目级事实。
 * 共享公司、证券、财务事实、公告证据不删除；公告证据的 project_id 由 FK 置空。
 */
export function deleteResearchProject(db: Database.Database, projectId: string): boolean {
  const project = getResearchProject(db, projectId)
  if (!project) return false
  const snapshotTable = db.prepare(`
    SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'industry_research_snapshots'
  `).get() as { found: number } | undefined
  if (snapshotTable) {
    const protectedVersion = db.prepare('SELECT 1 AS found FROM industry_research_snapshots WHERE project_id = ? LIMIT 1')
      .get(projectId) as { found: number } | undefined
    if (protectedVersion) throw new Error('SNAPSHOT_PROTECTED')
  }
  const result = db.prepare('DELETE FROM industry_research_projects WHERE id = ?').run(projectId)
  return result.changes > 0
}

export function deleteResearchProjects(
  db: Database.Database,
  options: { projectIds?: string[]; all?: boolean },
): { deletedIds: string[]; deletedCount: number } {
  if (options.all) {
    const rows = db.prepare('SELECT id FROM industry_research_projects').all() as Array<{ id: string }>
    const deletedIds: string[] = []
    const tx = db.transaction(() => {
      for (const row of rows) {
        if (deleteResearchProject(db, row.id)) deletedIds.push(row.id)
      }
    })
    tx()
    return { deletedIds, deletedCount: deletedIds.length }
  }

  const ids = Array.from(new Set((options.projectIds ?? []).map((id) => id.trim()).filter(Boolean)))
  const deletedIds: string[] = []
  const tx = db.transaction(() => {
    for (const projectId of ids) {
      if (deleteResearchProject(db, projectId)) deletedIds.push(projectId)
    }
  })
  tx()
  return { deletedIds, deletedCount: deletedIds.length }
}

export function getResearchGraph(db: Database.Database, projectId: string): { nodes: IndustryResearchNodeRow[]; edges: IndustryResearchEdgeRow[] } {
  return {
    nodes: db.prepare('SELECT * FROM industry_research_nodes WHERE project_id = ? ORDER BY type, name').all(projectId) as IndustryResearchNodeRow[],
    edges: db.prepare('SELECT * FROM industry_research_edges WHERE project_id = ? ORDER BY relation, id').all(projectId) as IndustryResearchEdgeRow[],
  }
}

export function upsertResearchNode(
  db: Database.Database,
  projectId: string,
  node: ResearchNodeInput,
  now = Date.now(),
): IndustryResearchNodeRow {
  db.prepare(`
    INSERT INTO industry_research_nodes (
      id, project_id, type, name, stage, statement_kind, status, metrics_json,
      evidence_ids_json, last_updated, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type, name = excluded.name, stage = excluded.stage,
      statement_kind = excluded.statement_kind, status = excluded.status,
      metrics_json = excluded.metrics_json, evidence_ids_json = excluded.evidence_ids_json,
      last_updated = excluded.last_updated, updated_at = excluded.updated_at
  `).run(
    node.id, projectId, node.type, node.name, node.stage ?? null, node.statementKind,
    node.status ?? null, JSON.stringify(node.metrics ?? []), JSON.stringify(node.evidenceIds ?? []),
    node.lastUpdated ?? null, now, now,
  )
  return db.prepare('SELECT * FROM industry_research_nodes WHERE id = ? AND project_id = ?')
    .get(node.id, projectId) as IndustryResearchNodeRow
}

export function upsertResearchEdge(
  db: Database.Database,
  projectId: string,
  edge: ResearchEdgeInput,
  now = Date.now(),
): IndustryResearchEdgeRow {
  db.prepare(`
    INSERT INTO industry_research_edges (
      id, project_id, source_node_id, target_node_id, relation, statement_kind, strength,
      bottleneck, exposure_pct, evidence_ids_json, last_updated, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source_node_id = excluded.source_node_id, target_node_id = excluded.target_node_id,
      relation = excluded.relation, statement_kind = excluded.statement_kind,
      strength = excluded.strength, bottleneck = excluded.bottleneck,
      exposure_pct = excluded.exposure_pct, evidence_ids_json = excluded.evidence_ids_json,
      last_updated = excluded.last_updated, updated_at = excluded.updated_at
  `).run(
    edge.id, projectId, edge.source, edge.target, edge.relation, edge.statementKind,
    edge.strength ?? null, edge.bottleneck ? 1 : 0, edge.exposurePct ?? null,
    JSON.stringify(edge.evidenceIds ?? []), edge.lastUpdated ?? null, now, now,
  )
  return db.prepare('SELECT * FROM industry_research_edges WHERE id = ? AND project_id = ?')
    .get(edge.id, projectId) as IndustryResearchEdgeRow
}

export function touchResearchGraph(
  db: Database.Database,
  projectId: string,
  expectedUpdatedAt: number,
  now = Date.now(),
): number {
  const nextVersion = Math.max(now, expectedUpdatedAt + 1)
  const result = db.prepare(`
    UPDATE industry_research_projects
    SET graph_updated_at = ?, updated_at = ?
    WHERE id = ? AND graph_updated_at = ?
  `).run(nextVersion, now, projectId, expectedUpdatedAt)
  if (result.changes !== 1) throw new Error('VERSION_CONFLICT')
  return nextVersion
}

export function replaceResearchGraph(
  db: Database.Database,
  projectId: string,
  nodes: ResearchNodeInput[],
  edges: ResearchEdgeInput[],
  expectedUpdatedAt: number,
): number {
  const replace = db.transaction(() => {
    const project = getResearchProject(db, projectId)
    if (!project) throw new Error('NOT_FOUND')
    if (project.graph_updated_at !== expectedUpdatedAt) throw new Error('VERSION_CONFLICT')
    const now = Date.now()
    db.prepare('DELETE FROM industry_research_edges WHERE project_id = ?').run(projectId)
    db.prepare('DELETE FROM industry_research_nodes WHERE project_id = ?').run(projectId)
    const insertNode = db.prepare(`
      INSERT INTO industry_research_nodes (
        id, project_id, type, name, stage, statement_kind, status, metrics_json,
        evidence_ids_json, last_updated, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const node of nodes) {
      insertNode.run(node.id, projectId, node.type, node.name, node.stage ?? null, node.statementKind,
        node.status ?? null, JSON.stringify(node.metrics ?? []), JSON.stringify(node.evidenceIds ?? []),
        node.lastUpdated ?? null, now, now)
    }
    const insertEdge = db.prepare(`
      INSERT INTO industry_research_edges (
        id, project_id, source_node_id, target_node_id, relation, statement_kind, strength,
        bottleneck, exposure_pct, evidence_ids_json, last_updated, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const edge of edges) {
      insertEdge.run(edge.id, projectId, edge.source, edge.target, edge.relation, edge.statementKind,
        edge.strength ?? null, edge.bottleneck ? 1 : 0, edge.exposurePct ?? null,
        JSON.stringify(edge.evidenceIds ?? []), edge.lastUpdated ?? null, now, now)
    }
    const nextVersion = Math.max(now, expectedUpdatedAt + 1)
    db.prepare('UPDATE industry_research_projects SET graph_updated_at = ?, updated_at = ? WHERE id = ?')
      .run(nextVersion, now, projectId)
    return nextVersion
  })
  return replace()
}

export function listResearchEvidence(db: Database.Database, projectId: string): IndustryResearchEvidenceRow[] {
  return db.prepare('SELECT * FROM industry_research_evidence WHERE project_id = ? ORDER BY updated_at DESC, id DESC').all(projectId) as IndustryResearchEvidenceRow[]
}

export function saveResearchEvidence(db: Database.Database, projectId: string, input: ResearchEvidenceInput): IndustryResearchEvidenceRow {
  const now = Date.now()
  db.prepare(`
    INSERT INTO industry_research_evidence (
      id, project_id, title, source_type, source_name, source_url, source_ref, published_date,
      fact_date, collected_at, metric_name, metric_value, unit, region, product_spec, methodology,
      statement_kind, direction, reliability, created_by, primary_source_confirmed, conflict_note,
      excerpt, created_at, updated_at
    ) VALUES (
      @id, @projectId, @title, @sourceType, @sourceName, @sourceUrl, @sourceRef, @publishedDate,
      @factDate, @collectedAt, @metricName, @metricValue, @unit, @region, @productSpec, @methodology,
      @statementKind, @direction, @reliability, @createdBy, @primarySourceConfirmed, @conflictNote,
      @excerpt, @createdAt, @updatedAt
    ) ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, source_type = excluded.source_type, source_name = excluded.source_name,
      source_url = excluded.source_url, source_ref = excluded.source_ref, published_date = excluded.published_date,
      fact_date = excluded.fact_date, collected_at = excluded.collected_at, metric_name = excluded.metric_name,
      metric_value = excluded.metric_value, unit = excluded.unit, region = excluded.region,
      product_spec = excluded.product_spec, methodology = excluded.methodology,
      statement_kind = excluded.statement_kind, direction = excluded.direction,
      reliability = excluded.reliability, created_by = excluded.created_by,
      primary_source_confirmed = excluded.primary_source_confirmed, conflict_note = excluded.conflict_note,
      excerpt = excluded.excerpt, updated_at = excluded.updated_at
  `).run({
    ...input, projectId, sourceUrl: input.sourceUrl ?? null, sourceRef: input.sourceRef ?? null,
    publishedDate: input.publishedDate ?? null, factDate: input.factDate ?? null,
    collectedAt: input.collectedAt ?? now, metricName: input.metricName ?? null,
    metricValue: input.metricValue ?? null, unit: input.unit ?? null, region: input.region ?? null,
    productSpec: input.productSpec ?? null, methodology: input.methodology ?? null,
    primarySourceConfirmed: input.primarySourceConfirmed ? 1 : 0, conflictNote: input.conflictNote ?? null,
    excerpt: input.excerpt ?? null, createdAt: now, updatedAt: now,
  })
  return db.prepare('SELECT * FROM industry_research_evidence WHERE id = ?').get(input.id) as IndustryResearchEvidenceRow
}

export function listResearchHypotheses(db: Database.Database, projectId: string): Array<IndustryResearchHypothesisRow & { events: IndustryResearchHypothesisEventRow[] }> {
  const hypotheses = db.prepare('SELECT * FROM industry_research_hypotheses WHERE project_id = ? ORDER BY importance DESC, updated_at DESC').all(projectId) as IndustryResearchHypothesisRow[]
  const eventQuery = db.prepare('SELECT * FROM industry_research_hypothesis_events WHERE hypothesis_id = ? ORDER BY created_at, id')
  return hypotheses.map((item) => ({ ...item, events: eventQuery.all(item.id) as IndustryResearchHypothesisEventRow[] }))
}

export function saveResearchHypothesis(db: Database.Database, projectId: string, input: ResearchHypothesisInput): IndustryResearchHypothesisRow {
  const save = db.transaction(() => {
    const now = Date.now()
    const existing = db.prepare('SELECT * FROM industry_research_hypotheses WHERE id = ?').get(input.id) as IndustryResearchHypothesisRow | undefined
    const status = input.status ?? existing?.status ?? 'open'
    db.prepare(`
      INSERT INTO industry_research_hypotheses (
        id, project_id, statement, importance, status, cheapest_disproof, verification_metric,
        threshold, due_at, evidence_ids_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET statement = excluded.statement, importance = excluded.importance,
        cheapest_disproof = excluded.cheapest_disproof, verification_metric = excluded.verification_metric,
        threshold = excluded.threshold, due_at = excluded.due_at,
        evidence_ids_json = excluded.evidence_ids_json, updated_at = excluded.updated_at
    `).run(input.id, projectId, input.statement, input.importance, status, input.cheapestDisproof,
      input.verificationMetric ?? null, input.threshold ?? null, input.dueAt ?? null,
      JSON.stringify(input.evidenceIds ?? []), existing?.created_at ?? now, now)
    if (!existing) {
      db.prepare(`
        INSERT INTO industry_research_hypothesis_events (
          id, project_id, hypothesis_id, from_status, to_status, reason, evidence_ids_json, created_at
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
      `).run(`${input.id}:created:${now}`, projectId, input.id, status, '创建假设', JSON.stringify(input.evidenceIds ?? []), now)
    }
  })
  save()
  return db.prepare('SELECT * FROM industry_research_hypotheses WHERE id = ?').get(input.id) as IndustryResearchHypothesisRow
}

export function updateResearchHypothesisStatus(
  db: Database.Database,
  projectId: string,
  hypothesisId: string,
  status: HypothesisStatus,
  reason: string,
  evidenceIds: string[],
  eventId: string,
): IndustryResearchHypothesisRow {
  const update = db.transaction(() => {
    const current = db.prepare('SELECT * FROM industry_research_hypotheses WHERE id = ? AND project_id = ?').get(hypothesisId, projectId) as IndustryResearchHypothesisRow | undefined
    if (!current) throw new Error('NOT_FOUND')
    const now = Date.now()
    db.prepare('UPDATE industry_research_hypotheses SET status = ?, evidence_ids_json = ?, updated_at = ? WHERE id = ?')
      .run(status, JSON.stringify(evidenceIds), now, hypothesisId)
    db.prepare(`
      INSERT INTO industry_research_hypothesis_events (
        id, project_id, hypothesis_id, from_status, to_status, reason, evidence_ids_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, projectId, hypothesisId, current.status, status, reason, JSON.stringify(evidenceIds), now)
  })
  update()
  return db.prepare('SELECT * FROM industry_research_hypotheses WHERE id = ?').get(hypothesisId) as IndustryResearchHypothesisRow
}
