import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import { createResearchProject } from '../../electron/main/database/industryResearchRepository'
import { createGenerationRun } from '../../electron/main/database/industryResearchGenerationRepository'
import {
  compareResearchEvidenceRequest,
  startResearchEvidenceDiscussionRequest,
} from '../../electron/main/ipc/researchEvidenceHandlers'
import { createSession, getSession } from '../../electron/main/database/aiAnalysisSessionRepository'
import {
  createResearchDiscussionContext,
  getResearchDiscussionContext,
} from '../../electron/main/database/researchDiscussionRepository'
import {
  auditResearchText,
  getResearchEvidenceReferenceId,
  type ResearchEvidenceContrast,
  type ResearchEvidenceItem,
  type ResearchEvidenceSubject,
} from '../../electron/main/services/researchEvidenceAuditService'
import {
  buildResearchEvidenceDeltaView,
  compareResearchEvidenceSnapshot,
  ResearchEvidenceDeltaError,
} from '../../electron/main/services/researchEvidenceDeltaService'
import {
  getDiscussionResearchAuditContext,
  startResearchDiscussion,
  startResearchEvidenceDiscussion,
} from '../../electron/main/services/researchDiscussionContextService'

const NOW = Date.parse('2026-07-30T02:00:00.000Z')

function item(code: string, detail: string, overrides: Partial<ResearchEvidenceItem> = {}): ResearchEvidenceItem {
  return {
    code,
    toolId: 'stock.trend_snapshot',
    label: code,
    detail,
    factDate: '20260715',
    sourceIds: ['local.trend_score_history'],
    ...overrides,
  }
}

function contrast(subject: ResearchEvidenceSubject, asOf = '20260715'): ResearchEvidenceContrast {
  for (const evidence of [...subject.supporting, ...subject.challenging, ...subject.unknowns]) {
    evidence.referenceId = getResearchEvidenceReferenceId(subject, evidence)
  }
  return {
    schemaVersion: 1,
    generatedAt: NOW,
    asOf,
    subjects: [subject],
    warnings: [],
    markdown: '## 确定性证据对照',
  }
}

function stockSubject(input: Partial<Pick<ResearchEvidenceSubject, 'supporting' | 'challenging' | 'unknowns'>>): ResearchEvidenceSubject {
  return {
    subjectKind: 'stock',
    subjectId: '600522',
    label: '中天科技',
    supporting: input.supporting ?? [],
    challenging: input.challenging ?? [],
    unknowns: input.unknowns ?? [],
  }
}

describe('research evidence delta', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
  })

  it('按稳定引用确定性区分变化、新增、不再出现和未变化', () => {
    const historical = contrast(stockSubject({
      supporting: [item('shared', '旧值'), item('removed', '仅历史存在'), item('same', '完全一致')],
    }))
    const current = contrast(stockSubject({
      supporting: [item('added', '仅当前存在'), item('same', '完全一致')],
      challenging: [item('shared', '新值', { factDate: '20260730' })],
    }), '20260730')

    const delta = buildResearchEvidenceDeltaView(historical, current, {
      generatedAt: NOW,
      currentAsOf: '20260730',
      referencedIds: new Set([historical.subjects[0].supporting[0].referenceId!]),
    })

    expect(delta.summary).toEqual({ changed: 1, added: 1, removed: 1, unchanged: 1 })
    expect(delta.subjects[0].items.map((entry) => entry.change)).toEqual([
      'changed', 'added', 'removed', 'unchanged',
    ])
    expect(delta.subjects[0].items.find((entry) => entry.change === 'changed')).toMatchObject({
      historical: { category: 'supporting', detail: '旧值', referenced: true },
      current: { category: 'challenging', detail: '新值', referenced: false },
    })
  })

  it('显式对比只读当前SQLite，使用主进程北京时间当天并保留缺口', () => {
    const historical = contrast(stockSubject({
      supporting: [item('trend_state_positive', '趋势状态=strong；评分=72')],
    }))
    const referenceId = historical.subjects[0].supporting[0].referenceId!
    const text = `历史趋势结论。[${referenceId}]`
    const audit = auditResearchText({
      text,
      documentKind: 'discussion',
      evidenceContrast: historical,
      now: NOW,
    })
    const before = totalChanges(db)

    const delta = compareResearchEvidenceSnapshot(db, {
      audit,
      evidenceContrast: historical,
      documentText: text,
    }, { now: NOW })

    expect(delta.currentAsOf).toBe('20260730')
    expect(delta.historicalAsOf).toBe('20260715')
    expect(delta.status).toBe('partial')
    expect(delta.summary.removed).toBe(1)
    expect(delta.summary.added).toBeGreaterThan(0)
    expect(delta.warnings.length).toBeGreaterThan(0)
    expect(totalChanges(db)).toBe(before)
  })

  it('正文或证据快照错配时阻断，不读取当前事实补造解释', () => {
    const historical = contrast(stockSubject({
      supporting: [item('trend_state_positive', '趋势状态=strong；评分=72')],
    }))
    const text = `历史趋势结论。[${historical.subjects[0].supporting[0].referenceId}]`
    const audit = auditResearchText({
      text,
      documentKind: 'discussion',
      evidenceContrast: historical,
      now: NOW,
    })

    expect(() => compareResearchEvidenceSnapshot(db, {
      audit,
      evidenceContrast: historical,
      documentText: '被修改的正文',
    }, { now: NOW })).toThrowError(ResearchEvidenceDeltaError)

    try {
      compareResearchEvidenceSnapshot(db, {
        audit,
        evidenceContrast: historical,
        documentText: '被修改的正文',
      }, { now: NOW })
    } catch (error) {
      expect(error).toMatchObject({ code: 'TRACE_MISMATCH' })
    }
  })

  it('窄IPC拒绝renderer注入额外工具参数', () => {
    expect(() => compareResearchEvidenceRequest(db, {
      sourceKind: 'discussion_message',
      sessionId: 1,
      messageIndex: 0,
      toolId: 'stock.price_history',
    })).toThrowError('包含不支持的字段')

    try {
      compareResearchEvidenceRequest(db, {
        sourceKind: 'industry_report',
        projectId: 'project-a',
        runId: 'run-a',
        asOf: '20260730',
      })
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_PARAM' })
    }
  })

  it('产业报告运行不属于请求项目时按不存在阻断', () => {
    createProject(db, 'project-a')
    createProject(db, 'project-b')
    createGenerationRun(db, {
      id: 'run-a',
      projectId: 'project-a',
      researchQuestion: '验证产业链事实',
      skillId: 'builtin:industry-chain-research',
      skillContentHash: 'a'.repeat(64),
    })

    try {
      compareResearchEvidenceRequest(db, {
        sourceKind: 'industry_report',
        projectId: 'project-b',
        runId: 'run-a',
      })
      throw new Error('expected request to fail')
    } catch (error) {
      expect(error).toMatchObject({ code: 'NOT_FOUND' })
    }
  })

  it('从受信消息创建有界专项讨论，相同事实指纹恢复且普通讨论不误恢复', () => {
    const historical = contrast(stockSubject({
      supporting: [item('trend_state_positive', '趋势状态=strong；评分=72')],
    }))
    const referenceId = historical.subjects[0].supporting[0].referenceId!
    const text = `历史趋势结论。[${referenceId}]`
    const audit = auditResearchText({
      text,
      documentKind: 'discussion',
      evidenceContrast: historical,
      now: NOW,
    })
    const sourceSessionId = createSession(db, {
      provider: 'qwen',
      model: 'test-model',
      articleUrls: [],
      promptSent: '受信历史讨论上下文',
      response: null,
      scanRunId: null,
      isError: false,
      messages: [{ role: 'assistant', content: text, researchAudit: audit }],
    })
    createResearchDiscussionContext(db, {
      sessionId: sourceSessionId,
      requestId: '00000000-0000-4000-8000-000000000101',
      originType: 'manual',
      originId: null,
      originTitle: '历史趋势讨论',
      originOccurredAt: NOW,
      originContentHash: 'source-hash',
      contextSnapshotJson: JSON.stringify({
        schemaVersion: 3,
        title: '历史趋势讨论',
        occurredAt: NOW,
        sourceUrl: null,
        items: [],
        researchFacts: { asOf: historical.asOf, evidenceContrast: historical },
      }),
      contextKeysJson: '[]',
      includedContextKeysJson: '[]',
      returnTargetJson: JSON.stringify({ tab: 'ai-analysis', subTab: 'records' }),
      projectId: null,
      baseSnapshotId: null,
      baseSelectionReason: 'unassigned',
    })

    const first = startResearchEvidenceDiscussionRequest(db, {
      sourceKind: 'discussion_message',
      sessionId: sourceSessionId,
      messageIndex: 0,
      requestId: '00000000-0000-4000-8000-000000000102',
      returnTarget: {
        tab: 'ai-analysis',
        subTab: 'records',
        entityId: String(sourceSessionId),
        stateKey: 'research-discussion',
        scrollTop: 240,
      },
    }, { now: NOW })
    const snapshot = JSON.parse(
      getResearchDiscussionContext(db, first.discussion.sessionId)!.context_snapshot_json,
    ) as {
      schemaVersion: number
      contextKind: string
      evidenceDelta: { source: unknown; subjects: Array<{ items: unknown[] }> }
      trustedEvidenceContrast: ResearchEvidenceContrast
    }
    expect(first).toMatchObject({
      resumed: false,
      discussion: { origin: { title: '历史趋势讨论 · 事实变化复核' } },
      contextPreview: [{ key: 'trusted-evidence-delta', removable: false }],
    })
    expect(first.initialQuestion).toContain('重新检验原结论')
    expect(JSON.parse(getSession(db, first.discussion.sessionId)!.messages!)).toEqual([])
    expect(snapshot).toMatchObject({
      schemaVersion: 4,
      contextKind: 'evidence_delta',
      evidenceDelta: {
        source: { sourceKind: 'discussion_message', sessionId: sourceSessionId, messageIndex: 0 },
      },
    })
    expect(snapshot.evidenceDelta.subjects.flatMap((subject) => subject.items).length).toBeLessThanOrEqual(24)
    expect(snapshot.trustedEvidenceContrast.asOf).toBe('20260730')
    expect(getDiscussionResearchAuditContext(db, first.discussion.sessionId)?.asOf).toBe('20260730')

    const resumed = startResearchEvidenceDiscussionRequest(db, {
      sourceKind: 'discussion_message',
      sessionId: sourceSessionId,
      messageIndex: 0,
      requestId: '00000000-0000-4000-8000-000000000103',
      returnTarget: { tab: 'ai-analysis', subTab: 'records', entityId: String(sourceSessionId) },
    }, { now: NOW + 60_000 })
    expect(resumed.resumed).toBe(true)
    expect(resumed.discussion.sessionId).toBe(first.discussion.sessionId)
    expect(resumed.initialQuestion).toContain('重新检验原结论')

    const ordinary = startResearchDiscussion(db, {
      requestId: '00000000-0000-4000-8000-000000000104',
      origin: { type: 'manual', id: null },
      initialQuestion: '新建普通研究讨论',
      returnTarget: { tab: 'ai-analysis', subTab: 'records' },
    })
    expect(ordinary.resumed).toBe(true)
    expect(ordinary.session.id).toBe(sourceSessionId)
    expect(ordinary.session.id).not.toBe(first.discussion.sessionId)
  })

  it('启动专项讨论拒绝renderer差异注入和无变化上下文，失败不创建会话', () => {
    const before = countSessions(db)
    expect(() => startResearchEvidenceDiscussionRequest(db, {
      sourceKind: 'discussion_message',
      sessionId: 1,
      messageIndex: 0,
      requestId: '00000000-0000-4000-8000-000000000105',
      returnTarget: { tab: 'ai-analysis' },
      delta: { summary: { changed: 99 } },
    })).toThrowError('包含不支持的字段')
    expect(countSessions(db)).toBe(before)

    const stable = contrast(stockSubject({ supporting: [item('same', '完全一致')] }), '20260730')
    expect(() => startResearchEvidenceDiscussion(db, {
      requestId: '00000000-0000-4000-8000-000000000106',
      source: { sourceKind: 'discussion_message', sessionId: 1, messageIndex: 0 },
      origin: {
        type: 'manual', id: null, title: '无变化', occurredAt: NOW, sourceUrl: null, projectId: null,
      },
      comparison: {
        historicalEvidence: stable,
        currentEvidence: stable,
        delta: buildResearchEvidenceDeltaView(stable, stable, {
          generatedAt: NOW,
          currentAsOf: '20260730',
        }),
      },
      returnTarget: { tab: 'ai-analysis', subTab: 'records' },
    })).toThrowError('没有可讨论的变化')
    expect(countSessions(db)).toBe(before)
  })
})

function createProject(db: Database.Database, id: string): void {
  createResearchProject(db, {
    id,
    title: id,
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

function totalChanges(db: Database.Database): number {
  return (db.prepare('SELECT total_changes() AS value').get() as { value: number }).value
}

function countSessions(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS value FROM ai_analysis_sessions').get() as { value: number }).value
}
