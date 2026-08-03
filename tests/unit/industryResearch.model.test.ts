import { describe, expect, it } from 'vitest'
import { graphDraft } from '../../src/components/IndustryResearch/ResearchGraphDialog'
import {
  buildResearchCounts,
  normalizeResearchReportFindings,
  projectReviewReasons,
  validateEvidenceDraft,
  validateHypothesisDraft,
} from '../../src/components/IndustryResearch/industryResearchModel'
import type { ResearchEvidenceDraft, ResearchGraph, ResearchHypothesisDraft, ResearchProject } from '../../src/components/IndustryResearch/industryResearchTypes'

const project: ResearchProject = {
  id: 'project:test', title: '测试产业研究', industry_name: '测试产业', product_scope: '测试产品', region_scope: '中国',
  time_scope: '近三年', purpose: 'investment', depth: 'standard', status: 'review_due', data_as_of: null,
  source_type: 'manual', skill_rule_version: null, graph_updated_at: 1, stop_condition: null, next_review_at: null, updated_at: 1,
}

describe('产业研究工作台模型', () => {
  it('把边界变化、事实缺失、冲突和开放假设汇总为复核原因', () => {
    const counts = buildResearchCounts(null, [{ statement_kind: 'estimate', conflict_note: '来源口径冲突' } as never], [{ status: 'open' } as never])
    expect(projectReviewReasons(project, counts)).toEqual(expect.arrayContaining([
      '研究边界已变化，需要重新核对事实和假设', '尚未登记数据截止日', '尚无经过来源确认的事实证据',
      '存在 1 条来源冲突，正式采用前需要核对', '仍有 1 条开放假设待验证',
    ]))
  })

  it('阻止未绑定来源或未人工确认的事实', () => {
    const draft: ResearchEvidenceDraft = {
      title: '产能数据', sourceType: 'public_document', sourceName: '公司公告', sourceUrl: '', sourceRef: '', factDate: '',
      statementKind: 'fact', direction: 'support', reliability: 'primary', primarySourceConfirmed: false, conflictNote: '', excerpt: '',
    }
    expect(validateEvidenceDraft(draft)).toBe('事实必须填写原始来源网址或来源编号')
    expect(validateEvidenceDraft({ ...draft, sourceRef: '公告-001' })).toBe('事实必须由人工确认原始来源')
    expect(validateEvidenceDraft({ ...draft, sourceRef: '公告-001', primarySourceConfirmed: true })).toBeNull()
  })

  it('要求假设提供最低成本反证和有效重要性', () => {
    const draft: ResearchHypothesisDraft = { statement: '需求增速将持续', importance: 3, cheapestDisproof: '', verificationMetric: '', threshold: '' }
    expect(validateHypothesisDraft(draft)).toBe('最低成本反证不能为空')
    expect(validateHypothesisDraft({ ...draft, cheapestDisproof: '核对月度出货量', importance: 6 })).toBe('重要性必须为 1 至 5')
    expect(validateHypothesisDraft({ ...draft, cheapestDisproof: '核对月度出货量' })).toBeNull()
  })

  it('完整往返图谱节点和关系字段', () => {
    const graph: ResearchGraph = {
      projectId: project.id,
      graphUpdatedAt: 17,
      nodes: [{
        id: 'node:material', type: 'material', name: '关键材料', stage: '上游', statement_kind: 'estimate', status: 'active',
        metrics_json: '[{"name":"价格","value":12.5,"unit":"万元/吨"}]', evidence_ids_json: '["evidence:1"]', last_updated: '2026-07-13',
      }],
      edges: [{
        id: 'edge:supply', source_node_id: 'node:material', target_node_id: 'node:product', relation: '供应', statement_kind: 'estimate',
        strength: 0.8, bottleneck: 1, exposure_pct: 35, evidence_ids_json: '["evidence:2"]', last_updated: '2026-07-12',
      }],
      mermaid: 'flowchart LR',
      nodeNames: { 'node:material': '关键材料' },
    }

    expect(graphDraft(graph)).toEqual({
      expectedUpdatedAt: 17,
      nodes: [{
        id: 'node:material', type: 'material', name: '关键材料', stage: '上游', statementKind: 'estimate', status: 'active',
        metrics: [{ name: '价格', value: 12.5, unit: '万元/吨' }], evidenceIds: ['evidence:1'], lastUpdated: '2026-07-13',
      }],
      edges: [{
        id: 'edge:supply', source: 'node:material', target: 'node:product', relation: '供应', statementKind: 'estimate',
        strength: 0.8, bottleneck: true, exposurePct: 35, evidenceIds: ['evidence:2'], lastUpdated: '2026-07-12',
      }],
    })
  })

  it('图谱草稿固定使用打开维护区时的并发版本', () => {
    const graph = { projectId: project.id, graphUpdatedAt: 23, nodes: [], edges: [], mermaid: '', nodeNames: {} }
    expect(graphDraft(graph).expectedUpdatedAt).toBe(23)
  })

  it('兼容旧字符串结论并保留新结构化代表性来源', () => {
    expect(normalizeResearchReportFindings([
      '旧版结论',
      { text: '结构化结论', candidateIds: ['candidate-1', 'candidate-1', 'candidate-2'] },
    ])).toEqual([
      { text: '旧版结论', candidateIds: [] },
      { text: '结构化结论', candidateIds: ['candidate-1', 'candidate-2'] },
    ])
  })
})
