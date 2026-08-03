import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import {
  changeIndustryResearchHypothesisStatus,
  createIndustryResearchProject,
  getIndustryResearchGraph,
  getIndustryResearchReport,
  saveIndustryResearchEvidence,
  saveIndustryResearchHypothesis,
} from '../../electron/main/services/industryResearchService'
import type { SkillMeta, VerifiedSkillBundle } from '../../electron/main/services/skillService'

const skill: SkillMeta = {
  skillId: 'custom:industry-chain-research',
  name: 'industry-chain-research',
  description: '产业研究规则',
  version: '',
  source: 'custom',
  dirPath: 'C:\\skills\\industry-chain-research',
  contentLength: 100,
  contentHash: 'a'.repeat(64),
  ruleVersion: 'sha256:aaaaaaaaaaaa',
  integrity: 'complete',
}
const skillBundle: VerifiedSkillBundle = {
  meta: skill,
  content: '# 产业研究规则\n\n按证据建立研究结论。',
  contentHash: skill.contentHash,
  contentBytes: 55,
  sourceDisplayName: 'industry-chain-research',
}

function createInput() {
  return {
    title: '光伏产业研究', industryName: '光伏', productScope: '光伏组件', regionScope: '中国',
    timeScope: '2024-2026', purpose: 'investment' as const, depth: 'standard' as const,
    sourceType: 'supply_chain' as const, sourceRef: 'briefing:1', sourceText: '产业链快速传导摘要',
    seedSupplyChain: {
      chainGroup: '光伏', hitConcepts: ['光伏组件'],
      nodes: [
        { concept: '硅料', distance: 1, isHit: false },
        { concept: '光伏组件', distance: 0, isHit: true },
      ],
      edges: [{ upstreamConcept: '硅料', downstreamConcept: '光伏组件', relationLabel: '加工为' }],
    },
  }
}

describe('产业研究本地服务', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  it('保存 Skill 快照并仅导入快速传导节点与关系', () => {
    const project = createIndustryResearchProject(db, createInput(), () => skillBundle)
    const graph = getIndustryResearchGraph(db, project.id)

    expect(project.skill_content_hash).toBe(skill.contentHash)
    expect(project.skill_rule_version).toBe(skill.ruleVersion)
    expect(graph.nodes.map((node) => node.name)).toEqual(['光伏组件', '硅料'])
    expect(graph.nodes.every((node) => node.statement_kind === 'estimate')).toBe(true)
    expect(graph.nodes.some((node) => node.type === 'company' || node.type === 'stock')).toBe(false)
    expect(graph.edges).toHaveLength(1)
    expect(graph.mermaid).toContain('加工为')
    expect(db.prepare('SELECT COUNT(*) AS count FROM industry_research_skill_snapshots').get()).toEqual({ count: 1 })
    expect(db.prepare("SELECT snapshot_reason FROM industry_research_snapshots WHERE project_id = ?").get(project.id)).toEqual({ snapshot_reason: 'project_baseline' })
    expect(getIndustryResearchReport(db, project.id)).toEqual(expect.objectContaining({
      projectId: project.id,
      reportKind: 'legacy_projection',
      reportDocument: null,
    }))
  })

  it('拒绝没有人工确认原始来源的事实', () => {
    const project = createIndustryResearchProject(db, createInput(), () => skillBundle)

    expect(() => saveIndustryResearchEvidence(db, project.id, {
      id: 'evidence-1', title: 'AI 生成产能数据', sourceType: 'ai', sourceName: '模型输出',
      statementKind: 'fact', direction: 'support', reliability: 'unknown', createdBy: 'ai',
      primarySourceConfirmed: false,
    })).toThrowError(expect.objectContaining({ code: 'FACT_REQUIRES_SOURCE' }))
    expect(db.prepare('SELECT COUNT(*) AS count FROM industry_research_evidence').get()).toEqual({ count: 0 })
  })

  it('假设状态变化只追加事件并保留完整历史', () => {
    const project = createIndustryResearchProject(db, createInput(), () => skillBundle)
    saveIndustryResearchHypothesis(db, project.id, {
      id: 'hypothesis-1', statement: '组件需求持续增长', importance: 5,
      cheapestDisproof: '连续两个季度组件出货量同比下降',
    })
    changeIndustryResearchHypothesisStatus(db, project.id, 'hypothesis-1', 'weakened', '季度出货增速下降')
    changeIndustryResearchHypothesisStatus(db, project.id, 'hypothesis-1', 'reopened', '新政策提升装机目标')

    const events = db.prepare(`
      SELECT from_status, to_status, reason
      FROM industry_research_hypothesis_events
      WHERE hypothesis_id = ? ORDER BY created_at, id
    `).all('hypothesis-1')
    expect(events).toHaveLength(3)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ from_status: null, to_status: 'open' }),
      expect.objectContaining({ from_status: 'open', to_status: 'weakened' }),
      expect.objectContaining({ from_status: 'weakened', to_status: 'reopened' }),
    ]))
  })
})
