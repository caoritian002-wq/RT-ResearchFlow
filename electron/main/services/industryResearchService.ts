import { createHash, randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { VerifiedSkillBundle } from './skillService'
import { IndustryResearchError } from './industryResearchError'
import { getGenerationRunView } from './industryResearchGenerationService'
import { initializeIndustryResearchDecisionFacts } from './industryResearchDecisionService'
import {
  createResearchProject,
  getResearchGraph,
  getResearchProject,
  listResearchEvidence,
  listResearchHypotheses,
  replaceResearchGraph,
  saveResearchEvidence,
  saveResearchHypothesis,
  updateResearchHypothesisStatus,
  updateResearchProject,
  type ResearchEdgeInput,
  type ResearchEvidenceInput,
  type ResearchHypothesisInput,
  type ResearchNodeInput,
  type ResearchProjectInput,
} from '../database/industryResearchRepository'

const INDUSTRY_RESEARCH_SKILL_NAME = 'industry-chain-research'

export { IndustryResearchError } from './industryResearchError'

export interface ResearchSkillResolver {
  (): VerifiedSkillBundle | null
}

export interface CreateIndustryResearchInput extends Omit<ResearchProjectInput,
  'id' | 'status' | 'skillId' | 'skillContentHash' | 'skillRuleVersion' | 'sourceTextSummary'> {
  sourceText?: string | null
  seedSupplyChain?: {
    chainGroup: string
    hitConcepts: string[]
    nodes: Array<{ concept: string; distance: number; isHit: boolean }>
    edges: Array<{ upstreamConcept: string; downstreamConcept: string; relationLabel: string }>
  }
}

function stableId(projectId: string, kind: string, value: string): string {
  return `${kind}_${createHash('sha256').update(`${projectId}:${kind}:${value}`).digest('hex').slice(0, 20)}`
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function requireProject(db: Database.Database, projectId: string) {
  const project = getResearchProject(db, projectId)
  if (!project) throw new IndustryResearchError('NOT_FOUND', '研究项目不存在')
  return project
}

export function createIndustryResearchProject(
  db: Database.Database,
  input: CreateIndustryResearchInput,
  resolveSkill: ResearchSkillResolver,
) {
  const skill = resolveSkill()
  if (!skill || !skill.meta.skillId.endsWith(`:${INDUSTRY_RESEARCH_SKILL_NAME}`)) {
    throw new IndustryResearchError('SKILL_NOT_FOUND', '未发现产业研究 Skill')
  }
  if (skill.meta.integrity !== 'complete' || skill.contentHash !== skill.meta.contentHash) {
    throw new IndustryResearchError('SKILL_CHANGED', '产业研究 Skill 完整性异常')
  }
  const projectId = randomUUID()
  const create = db.transaction(() => {
    const project = createResearchProject(db, {
      ...input,
      id: projectId,
      status: 'draft',
      sourceTextSummary: input.sourceText?.trim().slice(0, 1000) || null,
      skillId: skill.meta.skillId,
      skillContentHash: skill.contentHash,
      skillRuleVersion: skill.meta.ruleVersion,
    })
    if (input.seedSupplyChain) {
      const nodeByConcept = new Map<string, ResearchNodeInput>()
      for (const seed of input.seedSupplyChain.nodes) {
        nodeByConcept.set(seed.concept, {
          id: stableId(projectId, 'node', seed.concept),
          type: seed.distance === 0 ? 'industry' : 'product',
          name: seed.concept,
          stage: input.seedSupplyChain.chainGroup,
          statementKind: 'estimate',
          status: seed.isHit ? 'seed_hit' : 'seed_related',
        })
      }
      for (const edge of input.seedSupplyChain.edges) {
        for (const concept of [edge.upstreamConcept, edge.downstreamConcept]) {
          if (!nodeByConcept.has(concept)) {
            nodeByConcept.set(concept, {
              id: stableId(projectId, 'node', concept), type: 'product', name: concept,
              stage: input.seedSupplyChain.chainGroup, statementKind: 'estimate', status: 'seed_related',
            })
          }
        }
      }
      const edges: ResearchEdgeInput[] = input.seedSupplyChain.edges.map((edge) => ({
        id: stableId(projectId, 'edge', `${edge.upstreamConcept}:${edge.downstreamConcept}:${edge.relationLabel}`),
        source: nodeByConcept.get(edge.upstreamConcept)!.id,
        target: nodeByConcept.get(edge.downstreamConcept)!.id,
        relation: edge.relationLabel,
        statementKind: 'estimate',
      }))
      replaceResearchGraph(db, projectId, [...nodeByConcept.values()], edges, project.graph_updated_at)
    }
    const saved = requireProject(db, projectId)
    initializeIndustryResearchDecisionFacts(db, saved, skill)
    return saved
  })
  return create()
}

export function updateIndustryResearchProject(
  db: Database.Database,
  projectId: string,
  patch: Parameters<typeof updateResearchProject>[2],
) {
  const before = requireProject(db, projectId)
  const boundaryChanged = ['productScope', 'regionScope', 'timeScope'].some((key) => {
    const value = patch[key as keyof typeof patch]
    const column = key === 'productScope' ? before.product_scope : key === 'regionScope' ? before.region_scope : before.time_scope
    return value !== undefined && value !== column
  })
  const saved = updateResearchProject(db, projectId, boundaryChanged ? { ...patch, status: 'review_due' } : patch)
  const hypothesesNeedReview = boundaryChanged ? listResearchHypotheses(db, projectId).map((item) => item.id) : []
  return { project: saved!, boundaryChanged, hypothesesNeedReview }
}

export function saveIndustryResearchGraph(
  db: Database.Database,
  projectId: string,
  nodes: ResearchNodeInput[],
  edges: ResearchEdgeInput[],
  expectedUpdatedAt: number,
) {
  requireProject(db, projectId)
  if (nodes.length > 500 || edges.length > 1000) throw new IndustryResearchError('SCHEMA_VALIDATION_FAILED', '图谱规模超过限制')
  const nodeIds = new Set(nodes.map((node) => node.id))
  if (nodeIds.size !== nodes.length || edges.some((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target))) {
    throw new IndustryResearchError('SCHEMA_VALIDATION_FAILED', '图谱节点或关系引用无效')
  }
  try {
    return replaceResearchGraph(db, projectId, nodes, edges, expectedUpdatedAt)
  } catch (error) {
    if (error instanceof Error && error.message === 'VERSION_CONFLICT') {
      throw new IndustryResearchError('VERSION_CONFLICT', '图谱已被其他操作更新')
    }
    throw error
  }
}

export function saveIndustryResearchEvidence(db: Database.Database, projectId: string, input: ResearchEvidenceInput) {
  requireProject(db, projectId)
  const hasSource = Boolean(input.sourceName.trim() && (input.sourceUrl?.trim() || input.sourceRef?.trim()))
  if (input.statementKind === 'fact' && (!hasSource || !input.primarySourceConfirmed)) {
    throw new IndustryResearchError('FACT_REQUIRES_SOURCE', '事实必须关联人工确认的原始来源')
  }
  return saveResearchEvidence(db, projectId, input)
}

export function saveIndustryResearchHypothesis(db: Database.Database, projectId: string, input: ResearchHypothesisInput) {
  requireProject(db, projectId)
  if (!input.cheapestDisproof.trim()) {
    throw new IndustryResearchError('HYPOTHESIS_DISPROOF_REQUIRED', '最低成本反证不能为空')
  }
  return saveResearchHypothesis(db, projectId, input)
}

export function changeIndustryResearchHypothesisStatus(
  db: Database.Database,
  projectId: string,
  hypothesisId: string,
  status: Parameters<typeof updateResearchHypothesisStatus>[3],
  reason: string,
  evidenceIds: string[] = [],
) {
  if (!reason.trim()) throw new IndustryResearchError('INVALID_PARAM', '状态变化原因不能为空')
  return updateResearchHypothesisStatus(db, projectId, hypothesisId, status, reason, evidenceIds, randomUUID())
}

export function getIndustryResearchGraph(db: Database.Database, projectId: string) {
  const project = requireProject(db, projectId)
  const graph = getResearchGraph(db, projectId)
  const names = new Map(graph.nodes.map((node) => [node.id, node.name]))
  const mermaidLines = ['flowchart LR']
  for (const node of graph.nodes) mermaidLines.push(`  ${node.id}["${node.name.replace(/["\n\r]/g, ' ')}"]`)
  for (const edge of graph.edges) {
    mermaidLines.push(`  ${edge.source_node_id} -->|"${edge.relation.replace(/["\n\r]/g, ' ')}"| ${edge.target_node_id}`)
  }
  return { projectId, schemaVersion: project.schema_version, graphUpdatedAt: project.graph_updated_at, ...graph, mermaid: mermaidLines.join('\n'), nodeNames: Object.fromEntries(names) }
}

export function getIndustryResearchReport(db: Database.Database, projectId: string) {
  const project = requireProject(db, projectId)
  const graph = getIndustryResearchGraph(db, projectId)
  const evidence = listResearchEvidence(db, projectId)
  const hypotheses = listResearchHypotheses(db, projectId)
  const conflicts = evidence.filter((item) => item.conflict_note).map((item) => ({ evidenceId: item.id, note: item.conflict_note }))
  const missingSections: string[] = []
  if (!graph.nodes.length) missingSections.push('map')
  if (!evidence.length) missingSections.push('evidence')
  if (!hypotheses.length) missingSections.push('hypothesis')
  const generation = getGenerationRunView(db, projectId)
  const reportDocument = generation.reportDocument
  const hasFullMarkdown = typeof reportDocument?.markdown === 'string' && reportDocument.markdown.trim().length > 0
  const partitions = generation.reportPartitions
  return {
    projectId,
    // 有完整生成文档时优先展示 AI 报告摘要；否则回退确定性投影计数摘要
    summary: hasFullMarkdown && reportDocument?.summary
      ? reportDocument.summary
      : `${project.industry_name}研究包含 ${graph.nodes.length} 个节点、${graph.edges.length} 条关系、${evidence.length} 条证据和 ${hypotheses.length} 条假设。`,
    dataAsOf: project.data_as_of,
    missingSections: hasFullMarkdown && Array.isArray(reportDocument?.missingSections) && reportDocument.missingSections.length
      ? reportDocument.missingSections
      : missingSections,
    conflicts,
    mermaid: graph.mermaid,
    facts: evidence.filter((item) => item.statement_kind === 'fact').map((item) => ({ ...item, excerpt: item.excerpt?.slice(0, 1000) ?? null })),
    estimates: evidence.filter((item) => item.statement_kind === 'estimate').map((item) => ({ ...item, excerpt: item.excerpt?.slice(0, 1000) ?? null })),
    hypotheses: hypotheses.map((item) => ({ ...item, evidenceIds: parseJsonArray(item.evidence_ids_json) })),
    reportKind: hasFullMarkdown ? 'full_markdown' as const : 'legacy_projection' as const,
    reportDocument: hasFullMarkdown ? reportDocument : null,
    reportPartitions: partitions,
  }
}
