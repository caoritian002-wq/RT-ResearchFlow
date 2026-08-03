import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { getSession, updateSessionMessages } from '../../electron/main/database/aiAnalysisSessionRepository'
import { runMigrations } from '../../electron/main/database/db'
import { saveDecisionJudgmentVersion } from '../../electron/main/database/decisionJudgmentRepository'
import { saveResearchSnapshot } from '../../electron/main/database/industryResearchChangeRepository'
import {
  saveResearchCompany,
  saveResearchProjectCompany,
  saveResearchSecurity,
} from '../../electron/main/database/industryResearchFinancialRepository'
import {
  createGenerationRun,
  upsertEvidenceCandidate,
} from '../../electron/main/database/industryResearchGenerationRepository'
import {
  createResearchProject,
  deleteResearchProject,
  getResearchProject,
} from '../../electron/main/database/industryResearchRepository'
import { getResearchDiscussionContext } from '../../electron/main/database/researchDiscussionRepository'
import {
  buildDiscussionModelMessages,
  buildDiscussionAIRequest,
  getDiscussionResearchAuditContext,
  getDiscussionWebSearchPolicy,
  listResearchDiscussions,
  startResearchDiscussion,
  updateDiscussionContextBeforeStart,
} from '../../electron/main/services/researchDiscussionContextService'
import { auditResearchText } from '../../electron/main/services/researchEvidenceAuditService'

describe('研究讨论上下文服务', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    createResearchProject(db, {
      id: 'project-1', title: '光纤产业研究', industryName: '光通信', productScope: '预制棒与光纤',
      regionScope: '中国', timeScope: '2026-2028', purpose: 'investment', depth: 'deep', sourceType: 'manual',
      skillId: 'builtin:industry-chain-research', skillContentHash: 'a'.repeat(64),
    })
  })

  it('启动时不伪造持久化消息，并允许首条消息前裁剪可选上下文', () => {
    const started = startResearchDiscussion(db, {
      requestId: '00000000-0000-4000-8000-000000000050',
      origin: { type: 'industry_research', id: 'project-1' }, projectId: 'project-1',
      initialQuestion: '继续验证有效供给和价格传导', mode: 'continue_or_create',
      returnTarget: { tab: 'ai-analysis', subTab: 'industryResearch', entityId: 'project-1', stateKey: 'industry-research:changes', scrollTop: 160 },
    })

    expect(JSON.parse(getSession(db, started.session.id)!.messages!)).toEqual([])
    expect(started.discussion.returnTarget.scrollTop).toBe(160)
    expect(started.contextPreview).toHaveLength(3)
    const updated = updateDiscussionContextBeforeStart(db, started.session.id, '00000000-0000-4000-8000-000000000051', ['project-boundary'])
    expect(updated.contextPreview.map((item) => item.key)).toEqual(['project-boundary'])

    const modelMessages = buildDiscussionModelMessages(db, started.session.id, [{ role: 'user', content: '实际发送的问题' }])
    expect(modelMessages).toHaveLength(2)
    expect(modelMessages[0].content).toContain('研究边界')
    expect(modelMessages[0].content).not.toContain('回访与停止条件')
    expect(JSON.parse(getSession(db, started.session.id)!.messages!)).toEqual([])
  })

  it('同来源恢复原讨论，首条消息后禁止无痕修改上下文', () => {
    const input = {
      requestId: '00000000-0000-4000-8000-000000000052',
      origin: { type: 'industry_research' as const, id: 'project-1' }, projectId: 'project-1',
      initialQuestion: '讨论供需', mode: 'continue_or_create' as const,
      returnTarget: { tab: 'ai-analysis', subTab: 'industryResearch', entityId: 'project-1' },
    }
    const first = startResearchDiscussion(db, input)
    const resumed = startResearchDiscussion(db, {
      ...input,
      requestId: '00000000-0000-4000-8000-000000000053',
      returnTarget: { ...input.returnTarget, stateKey: 'industry-research:report', scrollTop: 420 },
    })
    expect(resumed.resumed).toBe(true)
    expect(resumed.session.id).toBe(first.session.id)
    expect(resumed.discussion.returnTarget).toMatchObject({ stateKey: 'industry-research:report', scrollTop: 420 })

    updateSessionMessages(db, first.session.id, [{ role: 'user', content: '已发送' }])
    expect(() => updateDiscussionContextBeforeStart(db, first.session.id, '00000000-0000-4000-8000-000000000054', ['project-boundary'])).toThrowError('讨论已开始')
  })

  it('固化可靠证券事实并在普通上下文裁剪时原样保留，不从主动问题猜代码', () => {
    saveResearchCompany(db, {
      id: 'company-1',
      legalName: '江苏中天科技股份有限公司',
      shortName: '中天科技',
      sourceType: 'tushare',
    }, Date.parse('2026-04-16T01:00:00.000Z'))
    saveResearchSecurity(db, {
      id: 'security-1',
      companyId: 'company-1',
      tsCode: '600522.SH',
      exchange: 'SSE',
      securityType: 'stock',
      mappingSource: 'tushare',
    }, Date.parse('2026-04-16T01:00:00.000Z'))
    saveResearchProjectCompany(db, {
      projectId: 'project-1',
      companyId: 'company-1',
      status: 'candidate',
    }, Date.parse('2026-04-16T01:00:00.000Z'))
    db.prepare('UPDATE industry_research_projects SET updated_at = ? WHERE id = ?')
      .run(Date.parse('2026-04-15T16:30:00.000Z'), 'project-1')
    seedResearchSnapshot(db, Date.parse('2026-04-16T02:00:00.000Z'))

    const started = startResearchDiscussion(db, {
      requestId: '00000000-0000-4000-8000-000000000057',
      origin: { type: 'industry_research', id: 'project-1' },
      projectId: 'project-1',
      mode: 'new',
      returnTarget: { tab: 'ai-analysis', subTab: 'industryResearch', entityId: 'project-1' },
    })
    const before = JSON.parse(getResearchDiscussionContext(db, started.session.id)!.context_snapshot_json) as {
      schemaVersion: number
      researchFacts: {
        asOf: string
        stockCodes: string[]
        toolIds: string[]
        invocations: unknown[]
        markdown: string
        evidenceContrast: { subjects: unknown[] }
      }
      contextFacts: {
        asOf: string
        toolIds: string[]
        invocations: Array<{ status: string }>
        markdown: string
        evidenceContrast: { subjects: unknown[] }
      }
    }
    expect(before).toMatchObject({
      schemaVersion: 3,
      researchFacts: {
        asOf: '20260416',
        stockCodes: ['600522'],
        toolIds: ['stock.trend_snapshot', 'stock.fundamentals', 'stock.announcements'],
      },
      contextFacts: {
        asOf: '20260416',
        toolIds: ['industry.project_snapshot'],
        invocations: [{ status: 'ready' }],
      },
    })
    expect(before.researchFacts.invocations).toHaveLength(3)
    expect(before.researchFacts.evidenceContrast.subjects).toHaveLength(1)
    expect(before.contextFacts.evidenceContrast.subjects).toHaveLength(1)
    expect(getSession(db, started.session.id)?.promptSent).toContain('统一投研事实底稿')
    expect(getSession(db, started.session.id)?.promptSent).toContain('统一来源实体事实底稿')
    expect(getSession(db, started.session.id)?.promptSent).toContain('确定性证据对照')
    expect(before.contextFacts.markdown).toContain('预制棒供给')
    expect(getDiscussionResearchAuditContext(db, started.session.id)).toMatchObject({
      asOf: '20260416',
      evidenceContrast: { subjects: [{ subjectKind: 'industry_project' }, { subjectKind: 'stock' }] },
    })
    const fixedFacts = JSON.stringify(before.researchFacts)
    const fixedContextFacts = JSON.stringify(before.contextFacts)

    updateDiscussionContextBeforeStart(
      db,
      started.session.id,
      '00000000-0000-4000-8000-000000000058',
      ['project-boundary'],
    )
    const after = JSON.parse(getResearchDiscussionContext(db, started.session.id)!.context_snapshot_json) as {
      researchFacts: unknown
      contextFacts: unknown
    }
    expect(JSON.stringify(after.researchFacts)).toBe(fixedFacts)
    expect(JSON.stringify(after.contextFacts)).toBe(fixedContextFacts)

    const manual = startResearchDiscussion(db, {
      requestId: '00000000-0000-4000-8000-000000000059',
      origin: { type: 'manual', id: null },
      initialQuestion: '请分析标题里出现的600519，但当前没有受信证券身份',
      mode: 'new',
      returnTarget: { tab: 'ai-analysis', subTab: 'records' },
    })
    const manualSnapshot = JSON.parse(
      getResearchDiscussionContext(db, manual.session.id)!.context_snapshot_json,
    ) as {
      researchFacts: { stockCodes: string[]; toolIds: string[]; invocations: unknown[] }
      contextFacts: { toolIds: string[]; invocations: unknown[] }
    }
    expect(manualSnapshot.researchFacts).toEqual(expect.objectContaining({
      stockCodes: [],
      toolIds: [],
      invocations: [],
    }))
    expect(manualSnapshot.contextFacts).toEqual(expect.objectContaining({
      toolIds: [],
      invocations: [],
    }))
  })

  it('判断讨论按来源事实日固化版本历史，不纳入后续修正版', () => {
    const first = saveDecisionJudgmentVersion(db, {
      requestId: '00000000-0000-4000-8000-000000000061',
      tsCode: '600000.SH',
      stockName: '浦发银行',
      tag: 'watch',
      note: '四月等待确认',
      evidenceSnapshot: judgmentEvidence('四月证据'),
    }, Date.parse('2026-04-20T01:00:00.000Z'))
    saveDecisionJudgmentVersion(db, {
      requestId: '00000000-0000-4000-8000-000000000062',
      judgmentGroupId: first.judgmentGroupId,
      tsCode: '600000.SH',
      stockName: '浦发银行',
      tag: 'risk_off',
      note: '同日稍晚风险上升',
      evidenceSnapshot: judgmentEvidence('同日稍晚证据'),
    }, Date.parse('2026-04-20T10:00:00.000Z'))

    const started = startResearchDiscussion(db, {
      requestId: '00000000-0000-4000-8000-000000000063',
      origin: { type: 'judgment', id: first.id },
      mode: 'new',
      returnTarget: { tab: 'decision-center', entityId: first.id },
    })
    const snapshot = JSON.parse(
      getResearchDiscussionContext(db, started.session.id)!.context_snapshot_json,
    ) as {
      schemaVersion: number
      contextFacts: {
        asOf: string
        toolIds: string[]
        invocations: Array<{ subjectKind: string; subjectId: string; status: string }>
        markdown: string
        evidenceContrast: { subjects: Array<{ subjectKind: string; subjectId: string }> }
      }
    }
    expect(snapshot).toMatchObject({
      schemaVersion: 3,
      contextFacts: {
        asOf: '20260420',
        toolIds: ['decision.judgment_history'],
        invocations: [{
          subjectKind: 'judgment',
          subjectId: first.id,
          status: 'ready',
        }],
      },
    })
    expect(snapshot.contextFacts.markdown).toContain('四月等待确认')
    expect(snapshot.contextFacts.markdown).not.toContain('同日稍晚风险上升')
    expect(snapshot.contextFacts.evidenceContrast.subjects).toEqual([
      expect.objectContaining({ subjectKind: 'judgment', subjectId: first.id }),
    ])
  })

  it('产业研究讨论强制 GPT 原生搜索，并把用户排除 URL 注入每轮约束', () => {
    createGenerationRun(db, {
      id: 'discussion-source-run',
      projectId: 'project-1',
      researchQuestion: '验证光纤价格传导',
      skillId: 'builtin:industry-chain-research',
      skillContentHash: 'a'.repeat(64),
    })
    upsertEvidenceCandidate(db, {
      id: 'discussion-excluded-source',
      projectId: 'project-1',
      runId: 'discussion-source-run',
      query: '旧来源',
      sourceUrl: 'https://excluded.example.com/old-claim',
      title: '用户已排除的材料',
      providerId: 'openai_native_web_search',
      status: 'rejected',
      sourceKind: 'web_search',
      isDetailPage: true,
    })
    const started = startResearchDiscussion(db, {
      requestId: '00000000-0000-4000-8000-000000000056',
      origin: { type: 'industry_research', id: 'project-1' },
      projectId: 'project-1',
      mode: 'new',
      returnTarget: { tab: 'ai-analysis', subTab: 'industryResearch', entityId: 'project-1' },
    })
    const messages = [{ role: 'user' as const, content: '结合最新集采继续判断' }]

    expect(getDiscussionWebSearchPolicy(db, started.session.id)).toEqual({
      enabled: true,
      projectId: 'project-1',
      excludedUrls: ['https://excluded.example.com/old-claim'],
    })
    const request = buildDiscussionAIRequest(db, started.session.id, messages)
    expect(request).toMatchObject({
      nativeWebSearchOnly: true,
      webSearch: {
        enabled: true,
        searchContextSize: 'high',
        excludedUrls: ['https://excluded.example.com/old-claim'],
      },
    })
    expect(request.messages[0].content).toContain('系统负责检索、分析和形成结论')
    expect(request.messages[0].content).toContain('https://excluded.example.com/old-claim')

    const auditContext = getDiscussionResearchAuditContext(db, started.session.id)!
    const researchAudit = auditResearchText({
      text: '基于最新来源的结论；风险与未知项仍待核验。',
      documentKind: 'discussion',
      evidenceContrast: auditContext.evidenceContrast,
      asOf: auditContext.asOf,
      now: 1,
    })
    updateSessionMessages(db, started.session.id, [{
      role: 'assistant',
      content: '基于最新来源的结论；风险与未知项仍待核验。',
      webSearchTrace: {
        responseId: 'resp-discussion',
        calls: [],
        citations: [],
        sources: [{ url: 'https://example.com/new', title: '新来源', cited: true }],
      },
      researchAudit,
    }])
    const persistedMessage = JSON.parse(getSession(db, started.session.id)!.messages!)[0]
    expect(persistedMessage.webSearchTrace.responseId).toBe('resp-discussion')
    expect(persistedMessage.researchAudit).toMatchObject({
      schemaVersion: 1,
      documentKind: 'discussion',
      generatedAt: 1,
      originalTextSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
  })

  it('来源删除后保留启动上下文并明确标记不可用', () => {
    const started = startResearchDiscussion(db, {
      requestId: '00000000-0000-4000-8000-000000000055',
      origin: { type: 'industry_research', id: 'project-1' }, projectId: 'project-1', mode: 'new',
      returnTarget: { tab: 'ai-analysis', subTab: 'industryResearch', entityId: 'project-1' },
    })
    expect(deleteResearchProject(db, 'project-1')).toBe(true)

    const listed = listResearchDiscussions(db, { originType: 'industry_research', originId: 'project-1' })
    expect(listed.items[0]).toMatchObject({ sessionId: started.session.id, origin: { available: false } })
    expect(getSession(db, started.session.id)).not.toBeNull()
  })
})

function judgmentEvidence(detail: string) {
  return {
    primaryTitle: '趋势判断',
    primarySummary: detail,
    sourceCount: 1,
    maxPriority: 3,
    trustHint: '本地不可变证据',
    evidence: [{ key: 'trend', label: '趋势', status: 'ready' as const, detail }],
  }
}

function seedResearchSnapshot(db: Database.Database, createdAt: number): void {
  const project = getResearchProject(db, 'project-1')!
  saveResearchSnapshot(db, {
    id: 'discussion-snapshot-1',
    project_id: project.id,
    previous_snapshot_id: null,
    snapshot_reason: 'project_baseline',
    request_id: null,
    trigger_batch_id: null,
    skill_snapshot_id: null,
    source_session_id: null,
    source_origin_type: 'test',
    source_origin_id: project.id,
    source_return_target_json: null,
    schema_version: 1,
    graph_updated_at: project.graph_updated_at,
    title: '光纤产业研究 · 基线',
    accepted_change_set_count: 0,
    snapshot_json: JSON.stringify({
      schemaVersion: 1,
      project,
      graph: {
        nodes: [{
          id: 'node-preform',
          type: 'material',
          name: '预制棒供给',
          stage: 'upstream',
          statement_kind: 'fact',
          status: 'active',
          last_updated: '20260416',
        }],
        edges: [],
      },
      evidenceRefs: [],
      hypotheses: [],
      companies: [],
      followUps: [],
    }),
    created_at: createdAt,
  })
}
