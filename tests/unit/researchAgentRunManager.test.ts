import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSession, getSession, updateSessionMessages } from '../../electron/main/database/aiAnalysisSessionRepository'
import { runMigrations } from '../../electron/main/database/db'
import { createResearchDiscussionContext, getResearchDiscussionContext } from '../../electron/main/database/researchDiscussionRepository'
import {
  advanceResearchAgentRunPhase,
  claimResearchAgentRunLease,
  createResearchAgentModelCall,
  createResearchAgentStep,
  createResearchAgentToolCall,
  getResearchAgentRun,
  hashResearchAgentText,
  RESEARCH_AGENT_CONTINUOUS_BUDGET_V2_INITIAL,
  RESEARCH_AGENT_MULTI_PERSPECTIVE_BUDGET,
  saveResearchAgentRunAuditedReport,
  startResearchAgentRun,
  transitionResearchAgentModelCallStatus,
  transitionResearchAgentStepStatus,
  transitionResearchAgentToolCallStatus,
  transitionResearchAgentRunStatus,
} from '../../electron/main/database/researchAgentRunRepository'
import {
  persistResearchAgentReport,
  ResearchAgentRunManager,
} from '../../electron/main/services/researchAgentRunManager'
import {
  researchAgentModelConfigFingerprint,
  type ResearchAgentPinnedModelConfig,
  type ResearchAgentPersistInput,
  type ResearchAgentRunnerOptions,
} from '../../electron/main/services/researchAgentRunner'
import { RESEARCH_AGENT_TOOL_REGISTRY_VERSION } from '../../electron/main/services/researchAgentNetworkTools'
import { RESEARCH_AGENT_PROMPT_RULE_VERSION } from '../../electron/main/services/researchAgentProtocol'
import { RESEARCH_AGENT_EVIDENCE_GATE_RULE_VERSION } from '../../electron/main/services/researchAgentEvidenceGate'
import { startResearchDiscussion } from '../../electron/main/services/researchDiscussionContextService'
import {
  getResearchEvidenceReferenceId,
  hashResearchEvidenceContrast,
  type ResearchEvidenceContrast,
  type ResearchTextAudit,
} from '../../electron/main/services/researchEvidenceAuditService'
import type { ResearchAgentRunRow } from '../../electron/main/database/types'

const NOW = Date.parse('2026-07-30T08:00:00.000Z')
const CONFIG: ResearchAgentPinnedModelConfig = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  apiKey: 'test-only-never-persisted',
  baseUrl: 'https://api.deepseek.com',
  maxTokens: 16_000,
  fingerprint: researchAgentModelConfigFingerprint({
    provider: 'deepseek',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    maxTokens: 16_000,
  }),
}

describe('FR-256 research agent run manager', () => {
  let db: Database.Database
  let sessionId: number

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    sessionId = createSession(db, {
      provider: 'deepseek',
      model: 'deepseek-chat',
      articleUrls: [],
      promptSent: 'trusted discussion',
      response: null,
      scanRunId: null,
      isError: false,
      messages: [{ role: 'user', content: '已有讨论问题' }],
      createdAt: NOW - 1_000,
    })
    createResearchDiscussionContext(db, {
      sessionId,
      requestId: '00000000-0000-4000-8000-000000002561',
      originType: 'manual',
      originId: null,
      originTitle: '贵州茅台事实核验',
      originOccurredAt: NOW - 1_000,
      originContentHash: 'a'.repeat(64),
      contextSnapshotJson: JSON.stringify({
        schemaVersion: 3,
        title: '贵州茅台事实核验',
        occurredAt: NOW - 1_000,
        sourceUrl: null,
        items: [{ key: 'question', type: 'question', label: '问题', excerpt: '核验趋势与基本面', removable: false }],
        researchFacts: { schemaVersion: 1, stockCodes: ['600519.SH'], invocations: [], markdown: '', toolIds: [], generatedAt: NOW, asOf: '20260730' },
        contextFacts: { schemaVersion: 1, invocations: [], markdown: '', toolIds: [], generatedAt: NOW, asOf: '20260730' },
      }),
      contextKeysJson: '[]',
      includedContextKeysJson: '[]',
      returnTargetJson: JSON.stringify({ tab: 'ai-analysis' }),
      projectId: null,
      baseSnapshotId: null,
      baseSelectionReason: 'unassigned',
      now: NOW,
    })
  })

  afterEach(() => db.close())

  function manager(run: (db: Database.Database, input: { runId: string; leaseOwner: string }, options?: ResearchAgentRunnerOptions) => Promise<ResearchAgentRunRow>) {
    return new ResearchAgentRunManager(db, {
      now: () => NOW,
      resolveModelConfig: () => CONFIG,
      run,
    })
  }

  function createEligibleSourceRun(): { run: ResearchAgentRunRow; evidence: ResearchEvidenceContrast; referenceId: string } {
    const evidence: ResearchEvidenceContrast = {
      schemaVersion: 1,
      generatedAt: NOW - 100,
      asOf: '20260730',
      subjects: [{
        subjectKind: 'stock',
        subjectId: '600519',
        label: '贵州茅台',
        supporting: [{
          code: 'PRICE_READY',
          toolId: 'stock.price_history',
          label: '本地日线可用',
          detail: '最近交易日价格事实已经固化。',
          factDate: '20260730',
          sourceIds: ['local.daily_close_cache'],
        }],
        challenging: [],
        unknowns: [],
      }],
      warnings: [],
      markdown: '确定性证据对照',
    }
    const referenceId = getResearchEvidenceReferenceId(evidence.subjects[0], evidence.subjects[0].supporting[0])
    evidence.subjects[0].supporting[0].referenceId = referenceId
    const evidenceHash = hashResearchEvidenceContrast(evidence)!
    const report = `# 单 Agent 研究报告\n\n价格事实已经固化。[${referenceId}]`
    const audit: ResearchTextAudit = {
      schemaVersion: 1,
      documentKind: 'discussion',
      status: 'passed',
      generatedAt: NOW - 50,
      asOf: '20260730',
      originalTextSha256: hashResearchAgentText(report),
      checkedCharacters: report.length,
      evidenceSummary: { subjectCount: 1, supporting: 1, challenging: 0, unknowns: 0 },
      checks: [],
    }
    let run = startResearchAgentRun(db, {
      requestId: '00000000-0000-4000-8000-000000002576',
      discussionSessionId: sessionId,
      question: '复核贵州茅台趋势与基本面事实之间是否存在明显背离。',
      contextSnapshot: { schemaVersion: 1, source: 'manager-test' },
      subjects: [{ kind: 'stock', tsCode: '600519.SH', label: '贵州茅台' }],
      includePortfolio: false,
      asOf: '20260730',
      provider: CONFIG.provider,
      model: CONFIG.model,
      modelConfigFingerprint: CONFIG.fingerprint,
      promptRuleVersion: RESEARCH_AGENT_PROMPT_RULE_VERSION,
      toolRegistryVersion: RESEARCH_AGENT_TOOL_REGISTRY_VERSION,
      now: NOW - 1_000,
    }).run
    const owner = 'boot-00000000-0000-4000-8000-000000002577'
    run = claimResearchAgentRunLease(db, { runId: run.id, leaseOwner: owner, now: NOW - 900, ttlMs: 10_000 })
    for (const phase of ['tooling', 'synthesis', 'audit'] as const) {
      run = advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner: owner, toPhase: phase, now: NOW - 800 })
    }
    let step = createResearchAgentStep(db, {
      runId: run.id,
      leaseOwner: owner,
      ordinal: 1,
      kind: 'audit',
      stepInput: { objective: 'freeze eligible source evidence' },
      now: NOW - 700,
    })
    step = transitionResearchAgentStepStatus(db, { stepId: step.id, leaseOwner: owner, toStatus: 'running', now: NOW - 600 })
    saveResearchAgentRunAuditedReport(db, {
      runId: run.id,
      leaseOwner: owner,
      evidenceSnapshotSha256: evidenceHash,
      reportMarkdown: report,
      audit,
      now: NOW - 500,
    })
    transitionResearchAgentStepStatus(db, {
      stepId: step.id,
      leaseOwner: owner,
      toStatus: 'succeeded',
      artifact: { schemaVersion: 1, outcome: 'complete', evidenceContrast: evidence, audit },
      now: NOW - 400,
    })
    run = advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner: owner, toPhase: 'persist', now: NOW - 300 })
    run = transitionResearchAgentRunStatus(db, {
      runId: run.id,
      leaseOwner: owner,
      toStatus: 'succeeded',
      outcome: 'complete',
      now: NOW - 200,
    })
    return { run, evidence, referenceId }
  }

  it('rebuilds preflight from SQLite without starting a model or tool and exposes no credential', () => {
    const run = vi.fn(async (database: Database.Database, input: { runId: string }) => getResearchAgentRun(database, input.runId)!)
    const runtime = manager(run)
    const preflight = runtime.preflight(sessionId)

    expect(run).not.toHaveBeenCalled()
    expect(preflight).toMatchObject({
      ready: true,
      asOf: '20260730',
      model: { provider: 'deepseek', model: 'deepseek-chat', configured: true },
      suggestedSubjects: [{ kind: 'stock', tsCode: '600519.SH' }],
      budget: { id: 'single-agent-unrestricted-v3', maxModelCalls: null, maxToolCalls: null },
      costEstimate: { status: 'unavailable' },
      evidencePolicy: {
        ruleVersion: RESEARCH_AGENT_EVIDENCE_GATE_RULE_VERSION,
        mode: 'local_then_network',
        networkToolsAvailable: true,
      },
    })
    expect(JSON.stringify(preflight)).not.toContain(CONFIG.apiKey)
    expect(preflight.availableTools.map((tool) => tool.id)).not.toContain('shell')
  })

  it('lists historical continuous-v2 runs without rejecting their immutable 30-second budget', () => {
    const historical = startResearchAgentRun(db, {
      requestId: '00000000-0000-4000-8000-000000002562',
      discussionSessionId: sessionId,
      question: '核验历史连续研究预算兼容性。',
      contextSnapshot: { schemaVersion: 1, source: 'historical-continuous-v2' },
      subjects: [{ kind: 'stock', tsCode: '600519.SH' }],
      includePortfolio: false,
      asOf: '20260730',
      provider: CONFIG.provider,
      model: CONFIG.model,
      modelConfigFingerprint: CONFIG.fingerprint,
      promptRuleVersion: RESEARCH_AGENT_PROMPT_RULE_VERSION,
      toolRegistryVersion: RESEARCH_AGENT_TOOL_REGISTRY_VERSION,
      budget: RESEARCH_AGENT_CONTINUOUS_BUDGET_V2_INITIAL,
      now: NOW,
    }).run
    const runtime = manager(vi.fn(async () => historical))

    expect(runtime.list().find((run) => run.id === historical.id)).toMatchObject({
      budgetVersion: 'single-agent-continuous-v2',
      maxModelCalls: null,
      maxToolCalls: null,
      resultSemantics: {
        execution: 'queued',
        executionLabel: '等待启动',
        conclusionCoverage: 'pending',
        conclusionLabel: '结论待形成',
      },
    })
  })

  it('separates completed execution from limited conclusion coverage without rewriting outcome', () => {
    const source = createEligibleSourceRun()
    db.prepare('UPDATE research_agent_runs SET outcome = ? WHERE id = ?').run('partial', source.run.id)

    const detail = manager(vi.fn(async () => source.run)).get(source.run.id)

    expect(detail.run).toMatchObject({
      status: 'succeeded',
      outcome: 'partial',
      resultSemantics: {
        execution: 'completed',
        executionLabel: '已完成',
        conclusionCoverage: 'limited',
        conclusionLabel: '结论覆盖受限',
      },
    })
    expect(detail.conclusionExplanation).toContain('研究流程已完整执行')
    expect(detail.conclusionExplanation).toContain('不代表运行失败或模型、工具调用次数截断')
    expect(detail.outcomeExplanation).toBe(detail.conclusionExplanation)
  })

  it('advertises the stock tools that a manual discussion can actually use after subject confirmation', () => {
    const snapshot = {
      schemaVersion: 3,
      title: '手工研究讨论',
      occurredAt: NOW,
      items: [],
      researchFacts: { schemaVersion: 1, stockCodes: [], invocations: [], markdown: '', toolIds: [], generatedAt: NOW, asOf: '20260730' },
      contextFacts: { schemaVersion: 1, invocations: [], markdown: '', toolIds: [], generatedAt: NOW, asOf: '20260730' },
    }
    db.prepare('UPDATE ai_research_discussion_contexts SET context_snapshot_json = ? WHERE session_id = ?')
      .run(JSON.stringify(snapshot), sessionId)
    const run = vi.fn(async () => { throw new Error('preflight must not execute a run') })
    const preflight = manager(run).preflight(sessionId)

    expect(preflight.suggestedSubjects).toEqual([])
    expect(preflight.availableTools.map((tool) => tool.id)).toEqual([
      'stock.price_history',
      'stock.trend_snapshot',
      'stock.fundamentals',
      'stock.announcements',
      'portfolio.holdings',
      'news.recent_briefings',
      'web.search',
      'web.fetch_page',
      'official.disclosure_search',
      'official.disclosure_document',
      'company.fundamentals_refresh',
      'market.price_refresh',
      'market.quote_snapshot',
    ])
    expect(run).not.toHaveBeenCalled()
  })

  it('preflights and starts a direct research run without exposing the discussion prerequisite', async () => {
    const run = vi.fn(async (database: Database.Database, input: { runId: string }) => getResearchAgentRun(database, input.runId)!)
    const runtime = manager(run)
    const preflight = runtime.preflightDirect()

    expect(preflight).toMatchObject({
      sessionId: null,
      ready: true,
      asOf: '20260730',
      model: { provider: 'deepseek', model: 'deepseek-chat', configured: true },
      suggestedSubjects: [],
      budget: { id: 'single-agent-unrestricted-v3', maxModelCalls: null, maxToolCalls: null },
    })
    expect(run).not.toHaveBeenCalled()
    expect(() => runtime.preflightDirect('00000000-0000-4000-8000-000000002598'))
      .toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }))

    db.prepare('INSERT INTO stock_info (stockCode, stockName, fetchedAt) VALUES (?, ?, ?)')
      .run('600519', '贵州茅台', NOW)

    const request = {
      requestId: '00000000-0000-4000-8000-000000002590',
      question: '直接核验贵州茅台趋势、基本面和最新正式披露是否相互印证。',
      subjects: [{ kind: 'stock', tsCode: '600519.SH', label: '不受信标签' }],
      includePortfolio: false,
      projectId: null,
      confirmedBudgetVersion: 'single-agent-unrestricted-v3',
    }
    const discussionCountBeforeInvalidStart = (db.prepare('SELECT COUNT(*) AS count FROM ai_research_discussion_contexts').get() as { count: number }).count
    expect(() => runtime.startDirect({
      ...request,
      requestId: '00000000-0000-4000-8000-000000002599',
      confirmedBudgetVersion: 'untrusted-budget',
    })).toThrow('必须确认当前固定研究预算版本')
    expect((db.prepare('SELECT COUNT(*) AS count FROM ai_research_discussion_contexts').get() as { count: number }).count).toBe(discussionCountBeforeInvalidStart)

    const first = runtime.startDirect(request)
    db.prepare('UPDATE stock_info SET stockName = ?, fetchedAt = ? WHERE stockCode = ?')
      .run('贵州茅台股份', NOW + 1, '600519')
    const replay = runtime.startDirect(request)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    expect(first.replayed).toBe(false)
    expect(replay).toMatchObject({ replayed: true, run: { id: first.run.id }, discussionSessionId: first.discussionSessionId })
    expect(first.run.discussionSessionId).toBe(first.discussionSessionId)
    expect(JSON.parse(getResearchAgentRun(db, first.run.id)!.subjects_json)).toEqual([
      { kind: 'stock', tsCode: '600519.SH', label: '贵州茅台' },
    ])
    const discussion = getResearchDiscussionContext(db, first.discussionSessionId)
    expect(discussion).not.toBeNull()
    expect(JSON.parse(discussion!.return_target_json)).toEqual({
      tab: 'ai-analysis',
      subTab: 'deepResearch',
      stateKey: 'deep-research',
    })
    expect(JSON.parse(getSession(db, first.discussionSessionId)!.messages!)).toEqual([])
    expect(() => runtime.startDirect({ ...request, question: '同一请求标识不能改成另一个研究问题。' }))
      .toThrowError(expect.objectContaining({ code: 'REQUEST_ID_CONFLICT' }))

    const orphanRequestId = '00000000-0000-4000-8000-000000002597'
    startResearchDiscussion(db, {
      requestId: orphanRequestId,
      origin: { type: 'manual', id: null },
      projectId: null,
      initialQuestion: '应用中断前已经创建但尚未启动的原始研究问题。',
      mode: 'new',
      returnTarget: { tab: 'ai-analysis', subTab: 'deepResearch', stateKey: 'deep-research' },
    })
    expect(() => runtime.startDirect({
      ...request,
      requestId: orphanRequestId,
      question: '同一请求标识不得把新问题绑定到中断前的旧讨论。',
    })).toThrowError(expect.objectContaining({ code: 'REQUEST_ID_CONFLICT' }))
    expect(db.prepare('SELECT COUNT(*) AS count FROM research_agent_runs WHERE request_id = ?').get(orphanRequestId))
      .toEqual({ count: 0 })
  })

  it('starts explicitly, remains UUID-idempotent and sends only the stored run identity to the runner', async () => {
    const run = vi.fn(async (database: Database.Database, input: { runId: string }) => getResearchAgentRun(database, input.runId)!)
    const runtime = manager(run)
    const request = {
      requestId: '00000000-0000-4000-8000-000000002562',
      sessionId,
      question: '贵州茅台趋势与基本面事实之间是否存在明显背离？',
      subjects: [{ kind: 'stock', tsCode: '600519.SH' }],
      includePortfolio: false,
      confirmedBudgetVersion: 'single-agent-unrestricted-v3',
    }
    const first = runtime.start(request)
    const replay = runtime.start(request)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    expect(first.replayed).toBe(false)
    expect(replay).toMatchObject({ replayed: true, run: { id: first.run.id } })
    expect(run.mock.calls[0][1]).toEqual({ runId: first.run.id, leaseOwner: runtime.bootId })
    expect(JSON.stringify(run.mock.calls[0][1])).not.toContain('apiKey')
  })

  it('starts an eligible evidence-bound review idempotently and derives every child field from the source run', async () => {
    const source = createEligibleSourceRun()
    const run = vi.fn(async (database: Database.Database, input: { runId: string }) => getResearchAgentRun(database, input.runId)!)
    const runtime = manager(run)
    const request = {
      requestId: '00000000-0000-4000-8000-000000002578',
      sourceRunId: source.run.id,
      confirmedBudgetVersion: 'multi-perspective-unrestricted-v2',
    }

    const first = runtime.startReview(request)
    const replay = runtime.startReview(request)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))

    expect(first.replayed).toBe(false)
    expect(replay).toMatchObject({ replayed: true, run: { id: first.run.id } })
    expect(first.run).toMatchObject({
      parentRunId: source.run.id,
      runKind: 'multi_perspective',
      discussionSessionId: sessionId,
      question: source.run.question,
      subjects: [{ kind: 'stock', tsCode: '600519.SH', label: '贵州茅台' }],
      includePortfolio: false,
      asOf: source.run.as_of,
      provider: source.run.provider,
      model: source.run.model,
      budgetVersion: 'multi-perspective-unrestricted-v2',
      maxModelCalls: null,
      toolCallCount: 0,
    })
    expect(JSON.parse(getResearchAgentRun(db, first.run.id)!.context_snapshot_json)).toEqual({
      kind: 'multi_perspective_source',
      schemaVersion: 1,
      sourceEvidenceSnapshotSha256: source.run.evidence_snapshot_sha256,
      sourceReportSha256: source.run.report_sha256,
      sourceRunId: source.run.id,
    })
    expect(JSON.stringify(runtime.get(first.run.id))).not.toContain('apiKey')
  })

  it('rejects blocked or evidence-drifted source runs before creating a child or invoking the runner', () => {
    const blocked = createEligibleSourceRun()
    db.prepare("UPDATE research_agent_runs SET outcome = 'blocked' WHERE id = ?").run(blocked.run.id)
    const run = vi.fn(async () => blocked.run)
    const runtime = manager(run)

    expect(() => runtime.startReview({
      requestId: '00000000-0000-4000-8000-000000002579',
      sourceRunId: blocked.run.id,
      confirmedBudgetVersion: 'multi-perspective-unrestricted-v2',
    })).toThrowError(expect.objectContaining({ code: 'SOURCE_RUN_NOT_ELIGIBLE' }))
    expect(run).not.toHaveBeenCalled()
    expect(db.prepare("SELECT COUNT(*) AS count FROM research_agent_runs WHERE run_kind = 'multi_perspective'").get()).toEqual({ count: 0 })

    db.prepare("UPDATE research_agent_runs SET outcome = 'complete' WHERE id = ?").run(blocked.run.id)
    const auditStep = db.prepare("SELECT id, artifact_json FROM research_agent_steps WHERE run_id = ? AND kind = 'audit'").get(blocked.run.id) as { id: string; artifact_json: string }
    const artifact = JSON.parse(auditStep.artifact_json) as { evidenceContrast: ResearchEvidenceContrast }
    artifact.evidenceContrast.subjects[0].supporting[0].detail = '证据已经被非预期修改。'
    db.prepare('UPDATE research_agent_steps SET artifact_json = ? WHERE id = ?').run(JSON.stringify(artifact), auditStep.id)

    expect(() => runtime.startReview({
      requestId: '00000000-0000-4000-8000-000000002580',
      sourceRunId: blocked.run.id,
      confirmedBudgetVersion: 'multi-perspective-unrestricted-v2',
    })).toThrowError(expect.objectContaining({ code: 'SOURCE_RUN_NOT_ELIGIBLE' }))
    expect(run).not.toHaveBeenCalled()
    expect(db.prepare("SELECT COUNT(*) AS count FROM research_agent_runs WHERE run_kind = 'multi_perspective'").get()).toEqual({ count: 0 })
  })

  it('rejects forged stable references and report drift even when the canonical evidence hash still matches', () => {
    const source = createEligibleSourceRun()
    const run = vi.fn(async () => source.run)
    const runtime = manager(run)
    const auditStep = db.prepare("SELECT id, artifact_json FROM research_agent_steps WHERE run_id = ? AND kind = 'audit'").get(source.run.id) as { id: string; artifact_json: string }
    const artifact = JSON.parse(auditStep.artifact_json) as { evidenceContrast: ResearchEvidenceContrast }
    artifact.evidenceContrast.subjects[0].supporting[0].referenceId = 'E-FFFFFFFFFF'
    expect(hashResearchEvidenceContrast(artifact.evidenceContrast)).toBe(source.run.evidence_snapshot_sha256)
    db.prepare('UPDATE research_agent_steps SET artifact_json = ? WHERE id = ?').run(JSON.stringify(artifact), auditStep.id)

    expect(() => runtime.startReview({
      requestId: '00000000-0000-4000-8000-000000002590',
      sourceRunId: source.run.id,
      confirmedBudgetVersion: 'multi-perspective-unrestricted-v2',
    })).toThrowError(expect.objectContaining({ code: 'SOURCE_RUN_NOT_ELIGIBLE' }))

    artifact.evidenceContrast.subjects[0].supporting[0].referenceId = source.referenceId
    db.prepare('UPDATE research_agent_steps SET artifact_json = ? WHERE id = ?').run(JSON.stringify(artifact), auditStep.id)
    db.prepare('UPDATE research_agent_runs SET report_markdown = ? WHERE id = ?').run('# 被替换的父报告', source.run.id)

    expect(() => runtime.startReview({
      requestId: '00000000-0000-4000-8000-000000002591',
      sourceRunId: source.run.id,
      confirmedBudgetVersion: 'multi-perspective-unrestricted-v2',
    })).toThrowError(expect.objectContaining({ code: 'SOURCE_RUN_NOT_ELIGIBLE' }))
    expect(run).not.toHaveBeenCalled()
  })

  it('projects validated role results and quality without exposing raw model responses', async () => {
    const source = createEligibleSourceRun()
    const execute = vi.fn(async (database: Database.Database, input: { runId: string }) => getResearchAgentRun(database, input.runId)!)
    const runtime = manager(execute)
    const started = runtime.startReview({
      requestId: '00000000-0000-4000-8000-000000002581',
      sourceRunId: source.run.id,
      confirmedBudgetVersion: 'multi-perspective-unrestricted-v2',
    })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    const childId = started.run.id
    const owner = runtime.bootId
    advanceResearchAgentRunPhase(db, { runId: childId, leaseOwner: owner, toPhase: 'tooling', now: NOW + 1 })
    let roleStep = createResearchAgentStep(db, {
      runId: childId,
      leaseOwner: owner,
      ordinal: 1,
      kind: 'tooling',
      stepInput: { objective: 'role projection' },
      now: NOW + 2,
    })
    roleStep = transitionResearchAgentStepStatus(db, { stepId: roleStep.id, leaseOwner: owner, toStatus: 'running', now: NOW + 3 })
    const roleArtifacts: Partial<Record<'bull' | 'bear', Record<string, unknown>>> = {}
    for (const role of ['bull', 'bear'] as const) {
      const roleArtifact = {
        protocolVersion: 'multi-perspective.v2',
        action: 'position',
        role,
        thesis: role === 'bull' ? '积极路径具备可追溯事实。' : '现有事实不足以排除风险。',
        claims: [{ id: 'P1', statement: '价格事实已经固化。', evidenceRefs: [source.referenceId], confidence: 'medium' }],
        counterpoints: [],
        unknowns: ['基本面覆盖仍待补充。'],
        verificationItems: ['核验下一期正式披露。'],
        rationale: '仅使用绑定证据。',
      }
      roleArtifacts[role] = roleArtifact
      let call = createResearchAgentModelCall(db, {
        runId: childId,
        stepId: roleStep.id,
        leaseOwner: owner,
        purpose: role === 'bull' ? 'bull_round_2' : 'bear_round_2',
        attempt: 1,
        inputMessages: [{ role: 'user', content: `${role} input must not render` }],
        now: NOW + 4,
      })
      call = transitionResearchAgentModelCallStatus(db, { callId: call.id, leaseOwner: owner, toStatus: 'submitted', now: NOW + 5 })
      transitionResearchAgentModelCallStatus(db, {
        callId: call.id,
        leaseOwner: owner,
        toStatus: 'succeeded',
        responseText: JSON.stringify(roleArtifact),
        inputTokens: 20,
        outputTokens: 30,
        totalTokens: 50,
        now: NOW + 6,
      })
    }
    transitionResearchAgentStepStatus(db, {
      stepId: roleStep.id,
      leaseOwner: owner,
      toStatus: 'succeeded',
      artifact: {
        schemaVersion: 2,
        protocolVersion: 'multi-perspective.v2',
        roundCount: 2,
        terminationReason: 'model_converged',
        convergence: {
          protocolVersion: 'multi-perspective.v2',
          action: 'assess_convergence',
          decision: 'finish',
          substantiveChanges: [],
          resolvedIssues: [],
          unresolvedIssues: ['基本面覆盖仍待补充。'],
          focusAreas: [],
          rationale: '当前快照无法继续消除未知项。',
        },
        bull: roleArtifacts.bull,
        bear: roleArtifacts.bear,
      },
      now: NOW + 7,
    })
    advanceResearchAgentRunPhase(db, { runId: childId, leaseOwner: owner, toPhase: 'synthesis', now: NOW + 8 })
    let moderatorStep = createResearchAgentStep(db, {
      runId: childId,
      leaseOwner: owner,
      ordinal: 2,
      kind: 'synthesis',
      stepInput: { objective: 'moderator projection' },
      now: NOW + 9,
    })
    moderatorStep = transitionResearchAgentStepStatus(db, { stepId: moderatorStep.id, leaseOwner: owner, toStatus: 'running', now: NOW + 10 })
    let moderatorCall = createResearchAgentModelCall(db, {
      runId: childId,
      stepId: moderatorStep.id,
      leaseOwner: owner,
      purpose: 'moderator',
      attempt: 1,
      inputMessages: [{ role: 'user', content: 'moderator input must not render' }],
      now: NOW + 11,
    })
    moderatorCall = transitionResearchAgentModelCallStatus(db, { callId: moderatorCall.id, leaseOwner: owner, toStatus: 'submitted', now: NOW + 12 })
    const moderatorArtifact = {
      protocolVersion: 'multi-perspective.v2',
      action: 'moderate',
      outcome: 'partial',
      conclusion: { statement: '已确认价格事实，外推范围仍有限。', evidenceRefs: [source.referenceId] },
      consensus: [{ statement: '价格事实已经固化。', evidenceRefs: [source.referenceId] }],
      disagreements: [{
        topic: '事实外推范围',
        bullPosition: '可以继续验证积极路径。',
        bearPosition: '不足以排除基本面风险。',
        materiality: 'high',
        evidenceRefs: [source.referenceId],
      }],
      unknowns: ['基本面覆盖仍待补充。'],
      verificationChecklist: [{ question: '下一期披露是否支持当前判断？', reason: '解决外推分歧', preferredSource: '交易所公告正文' }],
      rationale: '不选择赢家。',
    }
    transitionResearchAgentModelCallStatus(db, {
      callId: moderatorCall.id,
      leaseOwner: owner,
      toStatus: 'succeeded',
      responseText: JSON.stringify(moderatorArtifact),
      inputTokens: 30,
      outputTokens: 40,
      totalTokens: 70,
      now: NOW + 13,
    })
    transitionResearchAgentStepStatus(db, {
      stepId: moderatorStep.id,
      leaseOwner: owner,
      toStatus: 'succeeded',
      artifact: {
        schemaVersion: 2,
        protocolVersion: 'multi-perspective.v2',
        roundCount: 2,
        moderator: moderatorArtifact,
      },
      now: NOW + 14,
    })
    advanceResearchAgentRunPhase(db, { runId: childId, leaseOwner: owner, toPhase: 'audit', now: NOW + 15 })
    let auditStep = createResearchAgentStep(db, {
      runId: childId,
      leaseOwner: owner,
      ordinal: 3,
      kind: 'audit',
      stepInput: { objective: 'quality projection' },
      now: NOW + 16,
    })
    auditStep = transitionResearchAgentStepStatus(db, { stepId: auditStep.id, leaseOwner: owner, toStatus: 'running', now: NOW + 17 })
    transitionResearchAgentStepStatus(db, {
      stepId: auditStep.id,
      leaseOwner: owner,
      toStatus: 'succeeded',
      artifact: {
        schemaVersion: 1,
        quality: {
          schemaVersion: 1,
          sourceReportValidReferenceCount: 1,
          roleClaimCount: 2,
          roleCounterpointCount: 0,
          roleUniqueReferenceCount: 1,
          consensusCount: 1,
          disagreementCount: 1,
          unknownCount: 1,
          verificationCount: 1,
          invalidReferenceCount: 0,
          note: '只描述结构覆盖。',
        },
      },
      now: NOW + 18,
    })
    advanceResearchAgentRunPhase(db, { runId: childId, leaseOwner: owner, toPhase: 'persist', now: NOW + 19 })
    transitionResearchAgentRunStatus(db, {
      runId: childId,
      leaseOwner: owner,
      toStatus: 'succeeded',
      outcome: 'partial',
      now: NOW + 20,
    })

    const detail = runtime.get(childId)
    expect(detail.run.resultSemantics).toEqual({
      execution: 'completed',
      executionLabel: '已完成',
      conclusionCoverage: 'limited',
      conclusionLabel: '结论覆盖受限',
    })
    expect(detail.conclusionExplanation).toContain('多视角复核已完整执行')
    expect(detail.conclusionExplanation).toContain('仍有1项关键事实需要补证')
    expect(detail.multiPerspective).toMatchObject({
      sourceRunId: source.run.id,
      evidenceSnapshotSha256: source.run.evidence_snapshot_sha256,
      bull: { role: 'bull', claims: [{ evidenceRefs: [source.referenceId] }] },
      bear: { role: 'bear', claims: [{ evidenceRefs: [source.referenceId] }] },
      moderator: { outcome: 'partial', disagreements: [{ topic: '事实外推范围' }] },
      quality: { disagreementCount: 1, invalidReferenceCount: 0 },
    })
    const projection = JSON.stringify(detail)
    expect(projection).not.toContain('input must not render')
    expect(projection).not.toContain('仅使用绑定证据。')
    expect(projection).not.toContain('不选择赢家。')
  })

  it('persists cancellation before aborting the active request', async () => {
    let cancelWasPersistedAtAbort = false
    let resolveRun!: (run: ResearchAgentRunRow) => void
    const run = vi.fn((database: Database.Database, input: { runId: string }, options: ResearchAgentRunnerOptions = {}) => (
      new Promise<ResearchAgentRunRow>((resolve) => {
        resolveRun = resolve
        options.signal?.addEventListener('abort', () => {
          cancelWasPersistedAtAbort = getResearchAgentRun(database, input.runId)?.cancel_requested === 1
          resolve(getResearchAgentRun(database, input.runId)!)
        }, { once: true })
      })
    ))
    const runtime = manager(run)
    const started = runtime.start({
      requestId: '00000000-0000-4000-8000-000000002563',
      sessionId,
      question: '取消测试需要确认持久状态早于网络中止信号。',
      subjects: [{ kind: 'stock', tsCode: '600519.SH' }],
      includePortfolio: false,
      confirmedBudgetVersion: 'single-agent-unrestricted-v3',
    })
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    const cancelled = runtime.cancel(started.run.id)
    expect(cancelled.cancelRequested).toBe(true)
    expect(cancelWasPersistedAtAbort).toBe(true)
    resolveRun(getResearchAgentRun(db, started.run.id)!)
    await Promise.resolve()
  })

  it('pauses an expired lease at startup without automatically invoking the runner, then resumes explicitly', async () => {
    const stale = startResearchAgentRun(db, {
      requestId: '00000000-0000-4000-8000-000000002567',
      discussionSessionId: sessionId,
      question: '应用重启后只暂停过期研究，并等待用户显式继续。',
      contextSnapshot: { schemaVersion: 1 },
      subjects: [{ kind: 'stock', tsCode: '600519.SH' }],
      includePortfolio: false,
      asOf: '20260730',
      provider: CONFIG.provider,
      model: CONFIG.model,
      modelConfigFingerprint: CONFIG.fingerprint,
      promptRuleVersion: RESEARCH_AGENT_PROMPT_RULE_VERSION,
      toolRegistryVersion: RESEARCH_AGENT_TOOL_REGISTRY_VERSION,
      now: NOW - 300_000,
    }).run
    claimResearchAgentRunLease(db, {
      runId: stale.id,
      leaseOwner: 'boot-00000000-0000-4000-8000-000000002568',
      now: NOW - 300_000,
      ttlMs: 60_000,
    })
    const run = vi.fn(async (database: Database.Database, input: { runId: string }) => getResearchAgentRun(database, input.runId)!)
    const runtime = manager(run)

    expect(runtime.initialize()).toEqual({ count: 1, runIds: [stale.id] })
    expect(getResearchAgentRun(db, stale.id)).toMatchObject({ status: 'paused', error_code: 'LEASE_EXPIRED' })
    expect(run).not.toHaveBeenCalled()

    const resumed = runtime.resume(stale.id)
    expect(resumed.status).toBe('running')
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
  })

  it('never resumes an unknown-outcome run but retries it into a new continuous ledger', async () => {
    const uncertain = startResearchAgentRun(db, {
      requestId: '00000000-0000-4000-8000-000000002569',
      discussionSessionId: sessionId,
      question: '模型请求结果未知时不得在同一运行内自动或显式重放。',
      contextSnapshot: { schemaVersion: 1 },
      subjects: [{ kind: 'stock', tsCode: '600519.SH' }],
      includePortfolio: false,
      asOf: '20260730',
      provider: CONFIG.provider,
      model: CONFIG.model,
      modelConfigFingerprint: CONFIG.fingerprint,
      promptRuleVersion: RESEARCH_AGENT_PROMPT_RULE_VERSION,
      toolRegistryVersion: RESEARCH_AGENT_TOOL_REGISTRY_VERSION,
      now: NOW,
    }).run
    const owner = 'boot-00000000-0000-4000-8000-000000002570'
    claimResearchAgentRunLease(db, { runId: uncertain.id, leaseOwner: owner, now: NOW + 1, ttlMs: 60_000 })
    transitionResearchAgentRunStatus(db, {
      runId: uncertain.id,
      toStatus: 'needs_attention',
      leaseOwner: owner,
      errorCode: 'MODEL_OUTCOME_UNKNOWN',
      errorMessage: '模型请求可能已送达但未取得响应',
      now: NOW + 2,
    })
    const run = vi.fn(async () => uncertain)
    const runtime = manager(run)

    expect(() => runtime.resume(uncertain.id)).toThrowError(expect.objectContaining({ code: 'CALL_OUTCOME_UNKNOWN' }))
    expect(run).not.toHaveBeenCalled()

    const retried = runtime.retry({
      requestId: '00000000-0000-4000-8000-000000002599',
      sourceRunId: uncertain.id,
      confirmedBudgetVersion: 'single-agent-unrestricted-v3',
    })
    expect(retried).toMatchObject({ replayed: false, run: { parentRunId: uncertain.id, budgetVersion: 'single-agent-unrestricted-v3' } })
    expect(retried.run.id).not.toBe(uncertain.id)
    const replayed = runtime.retry({
      requestId: '00000000-0000-4000-8000-000000002599',
      sourceRunId: uncertain.id,
      confirmedBudgetVersion: 'single-agent-unrestricted-v3',
    })
    expect(replayed).toMatchObject({ replayed: true, run: { id: retried.run.id } })
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
  })

  it('deletes only the selected retry, keeps the remaining retry chain and removes only its messages', () => {
    const source = createEligibleSourceRun()
    persistResearchAgentReport(db, {
      run: source.run,
      reportMarkdown: source.run.report_markdown!,
      evidenceContrast: source.evidence,
      audit: JSON.parse(source.run.audit_json!) as ResearchTextAudit,
      outcome: 'complete',
    })
    const startRetry = (parentRunId: string, suffix: number) => startResearchAgentRun(db, {
      requestId: `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`,
      parentRunId,
      discussionSessionId: sessionId,
      question: source.run.question,
      contextSnapshot: { schemaVersion: 1, parentRunId },
      subjects: [{ kind: 'stock', tsCode: '600519.SH' }],
      includePortfolio: false,
      asOf: '20260730',
      provider: CONFIG.provider,
      model: CONFIG.model,
      modelConfigFingerprint: CONFIG.fingerprint,
      promptRuleVersion: RESEARCH_AGENT_PROMPT_RULE_VERSION,
      toolRegistryVersion: RESEARCH_AGENT_TOOL_REGISTRY_VERSION,
      now: NOW + suffix,
    }).run
    const retry1 = startRetry(source.run.id, 2_600)
    const retry2 = startRetry(retry1.id, 2_601)
    const retry3 = startRetry(retry2.id, 2_602)
    const retry4 = startRetry(retry3.id, 2_603)
    transitionResearchAgentRunStatus(db, { runId: retry2.id, toStatus: 'cancelled', now: NOW + 2_604 })
    updateSessionMessages(db, sessionId, [
      { role: 'user', content: '已有讨论问题' },
      { role: 'assistant', content: '来源报告', researchAgentRunId: source.run.id },
      { role: 'assistant', content: '第二次重试报告', researchAgentRunId: retry2.id },
      { role: 'assistant', content: '第三次重试仍在执行', researchAgentRunId: retry3.id },
    ])
    const runtime = manager(vi.fn(async () => source.run))

    expect(runtime.get(retry2.id).deleteEligibility).toEqual({ eligible: true, reason: null })
    const deleted = runtime.delete(retry2.id)
    expect(deleted.deletedRunIds).toEqual([retry2.id])
    expect(getResearchAgentRun(db, source.run.id)).not.toBeNull()
    expect(getResearchAgentRun(db, retry1.id)).not.toBeNull()
    expect(getResearchAgentRun(db, retry2.id)).toBeNull()
    expect(getResearchAgentRun(db, retry3.id)).toMatchObject({ parent_run_id: retry1.id, status: 'queued' })
    expect(getResearchAgentRun(db, retry4.id)).toMatchObject({ parent_run_id: retry3.id, status: 'queued' })
    const messages = JSON.parse(getSession(db, sessionId)!.messages!) as Array<{ researchAgentRunId?: string }>
    expect(messages.some((message) => message.researchAgentRunId === source.run.id)).toBe(true)
    expect(messages.some((message) => message.researchAgentRunId === retry2.id)).toBe(false)
    expect(messages.some((message) => message.researchAgentRunId === retry3.id)).toBe(true)
  })

  it('blocks deleting a source until its directly dependent multi-perspective review is deleted', () => {
    const source = createEligibleSourceRun()
    const review = startResearchAgentRun(db, {
      requestId: '00000000-0000-4000-8000-000000002610',
      runKind: 'multi_perspective',
      parentRunId: source.run.id,
      discussionSessionId: sessionId,
      question: source.run.question,
      contextSnapshot: { schemaVersion: 1, sourceRunId: source.run.id },
      subjects: [{ kind: 'stock', tsCode: '600519.SH' }],
      includePortfolio: false,
      asOf: '20260730',
      provider: CONFIG.provider,
      model: CONFIG.model,
      modelConfigFingerprint: CONFIG.fingerprint,
      promptRuleVersion: 'multi-perspective.v1',
      toolRegistryVersion: 'multi-perspective-tools.v1',
      budget: RESEARCH_AGENT_MULTI_PERSPECTIVE_BUDGET,
      now: NOW,
    }).run
    transitionResearchAgentRunStatus(db, { runId: review.id, toStatus: 'cancelled', now: NOW + 1 })
    const runtime = manager(vi.fn(async () => source.run))

    expect(runtime.get(source.run.id).deleteEligibility).toEqual({
      eligible: false,
      reason: '该研究仍有直接依赖的多视角复核，请先删除复核记录',
    })
    expect(() => runtime.delete(source.run.id)).toThrowError(expect.objectContaining({ code: 'RUN_NOT_DELETABLE' }))
    expect(runtime.delete(review.id).deletedRunIds).toEqual([review.id])
    expect(runtime.get(source.run.id).deleteEligibility).toEqual({ eligible: true, reason: null })
  })

  it('projects bounded network evidence and failures without exposing raw envelopes or secret URL values', () => {
    const runtime = manager(vi.fn(async () => { throw new Error('not executed') }))
    const created = startResearchAgentRun(db, {
      requestId: '00000000-0000-4000-8000-000000002571',
      discussionSessionId: sessionId,
      question: '核验贵州茅台最新公告正文并说明仍然缺失的证据。',
      contextSnapshot: { schemaVersion: 1 },
      subjects: [{ kind: 'stock', tsCode: '600519.SH', label: '贵州茅台' }],
      includePortfolio: false,
      asOf: '20260730',
      provider: CONFIG.provider,
      model: CONFIG.model,
      modelConfigFingerprint: CONFIG.fingerprint,
      promptRuleVersion: RESEARCH_AGENT_PROMPT_RULE_VERSION,
      toolRegistryVersion: RESEARCH_AGENT_TOOL_REGISTRY_VERSION,
      now: NOW,
    }).run
    const owner = 'boot-00000000-0000-4000-8000-000000002572'
    claimResearchAgentRunLease(db, { runId: created.id, leaseOwner: owner, now: NOW + 1, ttlMs: 60_000 })
    advanceResearchAgentRunPhase(db, { runId: created.id, leaseOwner: owner, toPhase: 'tooling', now: NOW + 2 })
    let step = createResearchAgentStep(db, {
      runId: created.id,
      leaseOwner: owner,
      ordinal: 1,
      kind: 'tooling',
      stepInput: { protocolVersion: RESEARCH_AGENT_PROMPT_RULE_VERSION, decisionRound: 1 },
      id: '00000000-0000-4000-8000-000000002573',
      now: NOW + 3,
    })
    step = transitionResearchAgentStepStatus(db, { stepId: step.id, leaseOwner: owner, toStatus: 'running', now: NOW + 4 })
    let search = createResearchAgentToolCall(db, {
      runId: created.id,
      stepId: step.id,
      leaseOwner: owner,
      toolId: 'web.search',
      toolInput: { query: '贵州茅台 最新公告', maxResults: 6 },
      asOf: '20260730',
      id: '00000000-0000-4000-8000-000000002574',
      now: NOW + 5,
    })
    search = transitionResearchAgentToolCallStatus(db, { callId: search.id, leaseOwner: owner, toStatus: 'submitted', now: NOW + 7 })
    const bodyHash = 'b'.repeat(64)
    transitionResearchAgentToolCallStatus(db, {
      callId: search.id,
      leaseOwner: owner,
      toStatus: 'succeeded',
      envelope: {
        schemaVersion: 1,
        toolId: 'web.search',
        status: 'ready',
        generatedAt: NOW,
        asOf: '20260730',
        sources: [{ id: 'search.tavily', status: 'ready', factDate: '20260730' }],
        coverage: { available: 1, required: 1, unit: 'candidates' },
        warnings: ['搜索摘要不作为正文证据。'],
        data: {
          query: '贵州茅台 最新公告',
          providerId: 'tavily',
          candidates: [{
            candidateId: 'SRC-0123456789ABCDEF',
            searchCallId: search.id,
            title: '贵州茅台公告',
            url: 'https://www.cninfo.com.cn/report?id=1&access_token=must-not-render',
            domain: 'www.cninfo.com.cn',
            snippet: '公告摘要仅用于发现候选。',
            publishedAt: '2026-07-30',
            sourceClass: 'official',
          }],
          networkEnvelope: {
            version: 'research-agent-network.v2',
            request: { method: 'POST', url: 'https://api.tavily.com/search?api_key=must-not-render', headerNames: ['authorization'], bodyBytes: 20, bodySha256: 'c'.repeat(64) },
            response: { finalUrl: 'https://api.tavily.com/search', statusCode: 200, contentType: 'application/json', mimeKind: 'json', contentEncoding: 'identity', fetchedAt: NOW, compressedBytes: 200, decodedBytes: 400, bodySha256: bodyHash },
            hops: [{ url: 'https://api.tavily.com/search', resolvedAddresses: ['1.1.1.1'], statusCode: 200, redirectTo: null }],
            envelopeSha256: 'd'.repeat(64),
          },
        },
      },
      modelProjection: { toolId: 'web.search', status: 'ready', data: { candidates: 1 } },
      sources: [{ id: 'search.tavily', status: 'ready', factDate: '20260730' }],
      coverage: { available: 1, required: 1, unit: 'candidates' },
      warnings: ['搜索摘要不作为正文证据。'],
      durationMs: 42,
      now: NOW + 8,
    })
    let limited = createResearchAgentToolCall(db, {
      runId: created.id,
      stepId: step.id,
      leaseOwner: owner,
      toolId: 'official.disclosure_search',
      toolInput: { query: '贵州茅台 年报', stockCode: '600519.SH' },
      asOf: '20260730',
      id: '00000000-0000-4000-8000-000000002575',
      now: NOW + 9,
    })
    limited = transitionResearchAgentToolCallStatus(db, { callId: limited.id, leaseOwner: owner, toStatus: 'submitted', now: NOW + 10 })
    transitionResearchAgentToolCallStatus(db, {
      callId: limited.id,
      leaseOwner: owner,
      toStatus: 'failed',
      errorCode: 'NETWORK_RATE_LIMITED',
      errorMessage: '联网响应状态为429：上游限流',
      now: NOW + 11,
    })

    const detail = runtime.get(created.id)
    expect(detail.toolCalls[0]).toMatchObject({
      scope: 'network',
      kind: 'search',
      request: { query: '贵州茅台 最新公告', requestedLimit: 6 },
      searchProvider: 'tavily',
      candidates: [{ sourceClass: 'official', domain: 'www.cninfo.com.cn' }],
      network: { requestHost: 'api.tavily.com', statusCode: 200, decodedBytes: 400 },
    })
    expect(detail.toolCalls[0].candidates[0].url).toContain('access_token=%5BREDACTED%5D')
    expect(detail.toolCalls[1].failure).toMatchObject({ category: 'rate_limited', resultUnknown: false, retryable: true })
    const rendererProjection = JSON.stringify(detail)
    expect(rendererProjection).not.toContain('must-not-render')
    expect(rendererProjection).not.toContain('authorization')
    expect(rendererProjection).not.toContain('resolvedAddresses')
    expect(rendererProjection).not.toContain('"modelProjection":')
  })

  it('appends the question and audited report exactly once by runId', () => {
    const run = startResearchAgentRun(db, {
      requestId: '00000000-0000-4000-8000-000000002564',
      discussionSessionId: sessionId,
      question: '把已审计的深度研究报告幂等写回研究讨论。',
      contextSnapshot: { schemaVersion: 1 },
      subjects: [{ kind: 'stock', tsCode: '600519.SH' }],
      includePortfolio: false,
      asOf: '20260730',
      provider: CONFIG.provider,
      model: CONFIG.model,
      modelConfigFingerprint: CONFIG.fingerprint,
      promptRuleVersion: RESEARCH_AGENT_PROMPT_RULE_VERSION,
      toolRegistryVersion: RESEARCH_AGENT_TOOL_REGISTRY_VERSION,
      now: NOW,
    }).run
    const persistInput = {
      run,
      reportMarkdown: '# 审计报告\n\n本地事实已核验。',
      evidenceContrast: { schemaVersion: 1, generatedAt: NOW, asOf: '20260730', subjects: [], warnings: [], markdown: '' },
      audit: {
        schemaVersion: 1,
        status: 'passed',
        generatedAt: NOW,
        asOf: '20260730',
        originalTextSha256: 'a'.repeat(64),
        checkedCharacters: 16,
        checks: [],
        warnings: [],
        evidenceSummary: { subjectCount: 0, supporting: 0, challenging: 0, unknowns: 0 },
      },
      outcome: 'complete',
    } as ResearchAgentPersistInput
    persistResearchAgentReport(db, persistInput)
    persistResearchAgentReport(db, persistInput)

    const messages = JSON.parse(getSession(db, sessionId)!.messages!) as Array<{ role: string; researchAgentRunId?: string }>
    expect(messages.filter((message) => message.researchAgentRunId === run.id)).toEqual([
      { role: 'user', content: run.question, researchAgentRunId: run.id },
      expect.objectContaining({ role: 'assistant', researchAgentRunId: run.id }),
    ])
  })
})
