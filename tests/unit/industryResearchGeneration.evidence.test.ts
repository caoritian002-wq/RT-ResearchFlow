import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import {
  createGenerationRun,
  getEvidenceCandidate,
  updateGenerationRun,
  upsertEvidenceCandidate,
} from '../../electron/main/database/industryResearchGenerationRepository'
import { createResearchProject, listResearchEvidence } from '../../electron/main/database/industryResearchRepository'
import {
  getGenerationRunView,
  normalizeReportConflicts,
  normalizeReportFindings,
  normalizeScopeArtifact,
  resolveGenerationDataAsOf,
} from '../../electron/main/services/industryResearchGenerationService'
import { confirmProjectEvidenceCandidate } from '../../electron/main/services/researchToolRuntime'
import {
  auditResearchText,
  mergeResearchEvidenceContrasts,
  type ResearchEvidenceContrast,
} from '../../electron/main/services/researchEvidenceAuditService'

function createProject(db: Database.Database, id: string): void {
  createResearchProject(db, {
    id,
    title: `${id} 产业研究`,
    industryName: '光通信',
    productScope: '光纤光缆',
    regionScope: '中国',
    timeScope: '近三年',
    purpose: 'investment',
    depth: 'standard',
    sourceType: 'manual',
    skillId: 'builtin:industry-chain-research',
    skillContentHash: 'a'.repeat(64),
  })
}

function createSucceededRun(db: Database.Database, projectId: string, runId: string, candidateCount: number): void {
  createGenerationRun(db, {
    id: runId,
    projectId,
    researchQuestion: '光通信产业链的供需、价格和公司暴露如何验证？',
    skillId: 'builtin:industry-chain-research',
    skillContentHash: 'a'.repeat(64),
  })
  for (let index = 0; index < candidateCount; index += 1) {
    upsertEvidenceCandidate(db, {
      id: `${runId}-candidate-${index}`,
      projectId,
      runId,
      query: `query-${index}`,
      sourceUrl: `https://example.com/source-${index}`,
      title: `公开来源 ${index}`,
      summary: `用于验证产业链结论的公开来源摘要 ${index}`.padEnd(60, '。'),
      excerpt: `用于验证产业链结论的有限摘录 ${index}`.padEnd(80, '。'),
      providerId: 'builtin_web',
      status: 'fetched',
      sourceKind: index === 0 ? 'official_detail' : 'web_search',
      isDetailPage: true,
      rankScore: 1 - index / 100,
    })
  }
  const representativeIds = Array.from({ length: Math.min(candidateCount, 14) }, (_, index) => `${runId}-candidate-${index}`)
  updateGenerationRun(db, runId, {
    status: 'succeeded',
    currentStage: 'report',
    lastSuccessfulStage: 'report',
    progressCurrent: 7,
    completedAt: Date.now(),
    stageArtifactsJson: JSON.stringify({
      retrieve: {
        mode: 'strong',
        selectedTopNIds: representativeIds,
        nativeWebSearch: {
          status: 'succeeded',
          provider: 'chatgpt',
          model: 'gpt-5.6-sol',
          responseId: 'resp-fixture',
          calls: [],
          citations: [],
          sources: [],
        },
      },
      report: {
        title: '光通信产业研究报告',
        summary: '阶段性研究摘要',
        markdown: '# 光通信产业研究报告\n\n## 核心结论\n\n完整报告正文。',
        supportedFindings: [{ text: '供需结构仍需结合运营商集采验证', candidateIds: representativeIds.slice(0, 2) }],
        modelOnlyFindings: [],
        pendingSources: [],
        candidateIds: representativeIds,
      },
    }),
  })
}

describe('产业研究报告引用与正式证据纳入', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    createProject(db, 'project-1')
    createProject(db, 'project-2')
  })

  it('45 条候选零人工确认时仍可恢复成功报告和代表性引用', () => {
    createSucceededRun(db, 'project-1', 'run-45', 45)

    const view = getGenerationRunView(db, 'project-1', 'run-45')

    expect(view.run?.status).toBe('succeeded')
    expect(view.evidenceCandidates).toHaveLength(45)
    expect(view.evidenceCandidates.every((item) => item.status === 'fetched')).toBe(true)
    expect(view.reportDocument.markdown).toContain('完整报告正文')
    expect(view.nativeWebSearch).toMatchObject({
      status: 'succeeded',
      provider: 'chatgpt',
      model: 'gpt-5.6-sol',
      responseId: 'resp-fixture',
    })
    expect(view.reportPartitions.supportedFindings).toEqual([
      expect.objectContaining({
        text: '供需结构仍需结合运营商集采验证',
        candidateIds: ['run-45-candidate-0', 'run-45-candidate-1'],
      }),
    ])
  })

  it('结构化结论过滤越权引用并兼容旧字符串结论', () => {
    const allowed = new Set(['candidate-1', 'candidate-2'])
    expect(normalizeReportFindings([
      { text: '结构化结论', candidateIds: ['candidate-1', 'other-project-candidate'] },
      '旧字符串结论',
    ], allowed, ['candidate-2'])).toEqual([
      { text: '结构化结论', candidateIds: ['candidate-1'] },
      { text: '旧字符串结论', candidateIds: ['candidate-2'] },
    ])
  })

  it('从运行中固化的审计与证据快照返回只读报告回放视图', () => {
    createSucceededRun(db, 'project-1', 'run-trace', 2)
    const contrast = mergeResearchEvidenceContrasts([{
      schemaVersion: 1,
      generatedAt: 1,
      asOf: '20260728',
      subjects: [{
        subjectKind: 'stock',
        subjectId: '600000',
        label: '浦发银行',
        supporting: [{
          code: 'trend_state_positive',
          toolId: 'stock.trend_snapshot',
          label: '趋势状态',
          detail: '趋势状态=strong；评分=72',
          factDate: '20260728',
          sourceIds: ['local.trend_score_history'],
        }],
        challenging: [],
        unknowns: [],
      }],
      warnings: [],
      markdown: '',
    } satisfies ResearchEvidenceContrast], { generatedAt: 1, asOf: '20260728' })
    const referenceId = contrast.subjects[0].supporting[0].referenceId!
    const summary = '阶段性研究摘要'
    const markdown = `# 光通信产业研究报告\n\n## 一、核心结论\n趋势结构保持积极。[${referenceId}]`
    const audit = auditResearchText({
      text: `${summary}\n\n${markdown}`,
      documentKind: 'industry_report',
      evidenceContrast: contrast,
      asOf: '20260728',
      now: 2,
    })
    updateGenerationRun(db, 'run-trace', {
      stageArtifactsJson: JSON.stringify({
        researchFacts: { evidenceContrast: contrast },
        report: {
          title: '光通信产业研究报告',
          summary,
          markdown,
          supportedFindings: [],
          modelOnlyFindings: [],
          pendingSources: [],
          candidateIds: [],
          textAudit: audit,
        },
      }),
    })

    const trace = getGenerationRunView(db, 'project-1', 'run-trace').reportDocument.researchTrace
    expect(trace).toMatchObject({
      replayStatus: 'ready',
      citationSummary: { availableReferences: 1, referencedReferences: 1, unresolvedReferences: 0 },
      subjects: [{ label: '浦发银行', items: [{ referenceId, referenced: true }] }],
    })
  })

  it('未显式设置截止日时使用北京时间当天，不采信模型虚构的旧日期', () => {
    const now = new Date('2026-07-18T16:30:00.000Z')

    expect(resolveGenerationDataAsOf(null, now)).toBe('2026-07-19')
    expect(resolveGenerationDataAsOf('2024-12-31', now)).toBe('2024-12-31')
    expect(normalizeScopeArtifact(
      { dataAsOf: '2024-12-31' },
      { dataAsOf: '2026-07-19' },
      '研究2026年光通信产业变化',
    ).dataAsOf).toBe('2026-07-19')
  })

  it('只保留与权威研究截止日一致的时间冲突，并保留其他真实来源冲突', () => {
    const conflicts = [
      '多项候选资料发布于2026年，晚于2024-12-31数据截止日。',
      '2026-07-20晚于2026-07-19数据截止日，只能作为后见信息。',
      '两家行业协会对产量统计口径存在差异。',
    ]

    expect(normalizeReportConflicts(conflicts, '2026-07-19')).toEqual([
      '2026-07-20晚于2026-07-19数据截止日，只能作为后见信息。',
      '两家行业协会对产量统计口径存在差异。',
    ])
    expect(normalizeReportConflicts(conflicts, '2024-12-31')).toContain(conflicts[0])
  })

  it('报告后正式纳入保持 estimate 语义、幂等并拒绝跨项目候选', () => {
    createSucceededRun(db, 'project-1', 'run-1', 2)

    confirmProjectEvidenceCandidate(db, 'project-1', 'run-1-candidate-0', 'confirm')
    confirmProjectEvidenceCandidate(db, 'project-1', 'run-1-candidate-0', 'confirm')

    const evidence = listResearchEvidence(db, 'project-1')
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toMatchObject({
      statement_kind: 'estimate',
      direction: 'support',
      primary_source_confirmed: 0,
      created_by: 'human',
      source_url: 'https://example.com/source-0',
    })
    expect(() => confirmProjectEvidenceCandidate(db, 'project-2', 'run-1-candidate-0', 'confirm'))
      .toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(getEvidenceCandidate(db, 'run-1-candidate-0')?.status).toBe('confirmed')

    confirmProjectEvidenceCandidate(db, 'project-1', 'run-1-candidate-0', 'reject')
    expect(listResearchEvidence(db, 'project-1')).toHaveLength(0)
    expect(getEvidenceCandidate(db, 'run-1-candidate-0')?.status).toBe('rejected')
  })
})
