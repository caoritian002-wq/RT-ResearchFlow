import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import {
  advanceResearchAgentRunPhase,
  claimResearchAgentRunLease,
  createResearchAgentModelCall,
  createResearchAgentStep,
  createResearchAgentToolCall,
  getResearchAgentRunLedger,
  RESEARCH_AGENT_CONTINUOUS_BUDGET_V2,
  RESEARCH_AGENT_MULTI_PERSPECTIVE_BUDGET,
  RESEARCH_AGENT_MULTI_PERSPECTIVE_LEGACY_BUDGET,
  RESEARCH_AGENT_STANDARD_BUDGET,
  requestResearchAgentRunCancellation,
  saveResearchAgentRunPlan,
  startResearchAgentRun,
  transitionResearchAgentModelCallStatus,
  transitionResearchAgentRunStatus,
  transitionResearchAgentStepStatus,
  transitionResearchAgentToolCallStatus,
} from '../../electron/main/database/researchAgentRunRepository'
import {
  buildResearchAgentPlanningMessages,
  buildResearchAgentToolDecisionMessages,
  RESEARCH_AGENT_PREVIOUS_PROMPT_RULE_VERSION,
  RESEARCH_AGENT_PROMPT_RULE_VERSION,
} from '../../electron/main/services/researchAgentProtocol'
import { assessResearchAgentEvidence } from '../../electron/main/services/researchAgentEvidenceGate'
import {
  buildResearchAgentSynthesisFactContext,
  ResearchAgentRunnerError,
  researchAgentModelConfigFingerprint,
  runResearchAgent,
  type ResearchAgentPinnedModelConfig,
} from '../../electron/main/services/researchAgentRunner'
import { listAvailableResearchAgentTools } from '../../electron/main/services/researchAgentToolService'
import {
  RESEARCH_AGENT_TOOL_REGISTRY_VERSION,
  type ExecuteResearchAgentNetworkToolInput,
  type ResearchAgentNetworkToolEnvelope,
} from '../../electron/main/services/researchAgentNetworkTools'
import {
  MULTI_PERSPECTIVE_PROMPT_RULE_VERSION,
  MULTI_PERSPECTIVE_TOOL_REGISTRY_VERSION,
  MULTI_PERSPECTIVE_UNRESTRICTED_PROMPT_RULE_VERSION,
  MULTI_PERSPECTIVE_UNRESTRICTED_TOOL_REGISTRY_VERSION,
} from '../../electron/main/services/researchMultiPerspectiveProtocol'
import {
  type ResearchFactToolEnvelope,
} from '../../electron/main/services/researchFactToolRegistry'
import type { AIProviderRequest, AIProviderResponse } from '../../electron/main/services/aiProvider'
import type { ResearchAgentToolCallRow } from '../../electron/main/database/types'

const NOW = Date.parse('2026-07-30T08:00:00.000Z')
const OWNER = 'boot-00000000-0000-4000-8000-000000001256'
let sequence = 0

function uuid(): string {
  sequence += 1
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
}

function json(value: unknown): AIProviderResponse {
  return {
    text: JSON.stringify(value),
    responseId: `response-${sequence}`,
    finishReason: 'stop',
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  }
}

function readyEnvelope(toolId: string): ResearchFactToolEnvelope<string, unknown> {
  return {
    schemaVersion: 1,
    toolId,
    status: 'ready',
    generatedAt: NOW,
    asOf: toolId === 'portfolio.holdings' ? null : '20260730',
    sources: [{ id: 'local.runner-test', status: 'ready', factDate: '20260729' }],
    coverage: { available: 1, required: 1, unit: 'items' },
    warnings: [],
    data: { summary: '本地事实可用', metric: 12.5 },
  }
}

describe('FR-256 single-agent.v1 runner', () => {
  let db: Database.Database
  let config: ResearchAgentPinnedModelConfig

  beforeEach(() => {
    sequence = 0
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, DATABASE_MIGRATIONS.filter((migration) => [121, 122, 123, 130].includes(migration.version)))
    const provider = 'deepseek' as const
    const model = 'deepseek-chat'
    const baseUrl = 'https://api.deepseek.com'
    const maxTokens = 16_000
    config = {
      provider,
      model,
      apiKey: 'test-only-key-never-persisted',
      baseUrl,
      maxTokens,
      fingerprint: researchAgentModelConfigFingerprint({ provider, model, baseUrl, maxTokens }),
    }
  })

  afterEach(() => db.close())

  function startRun(overrides: Partial<Parameters<typeof startResearchAgentRun>[1]> = {}) {
    const run = startResearchAgentRun(db, {
      requestId: uuid(),
      id: uuid(),
      question: '茅台截至研究日的历史股价趋势与回撤如何？',
      contextSnapshot: { schemaVersion: 1, trustedSubjects: [] },
      subjects: [{ kind: 'stock', tsCode: '600519.SH', label: '贵州茅台' }],
      includePortfolio: false,
      asOf: '20260730',
      provider: config.provider,
      model: config.model,
      modelConfigFingerprint: config.fingerprint,
      promptRuleVersion: RESEARCH_AGENT_PROMPT_RULE_VERSION,
      toolRegistryVersion: RESEARCH_AGENT_TOOL_REGISTRY_VERSION,
      now: NOW,
      ...overrides,
    }).run
    return claimResearchAgentRunLease(db, {
      runId: run.id,
      leaseOwner: OWNER,
      now: NOW + 1,
      ttlMs: 120_000,
    })
  }

  function successfulModel(): (request: AIProviderRequest) => Promise<AIProviderResponse> {
    let call = 0
    return vi.fn(async (request: AIProviderRequest) => {
      call += 1
      if (call === 1) {
        return json({
          protocolVersion: 'single-agent.v1',
          action: 'plan',
          questions: ['趋势状态如何', '事实缺口是什么'],
          candidateTools: ['stock.trend_snapshot'],
          stopConditions: ['取得至少一项可用本地事实'],
          rationale: '先核验趋势工具。',
        })
      }
      if (call === 2) {
        return json({
          protocolVersion: 'single-agent.v1',
          action: 'tool_batch',
          calls: [{ toolId: 'stock.trend_snapshot', input: { stockCode: '600519.SH' } }],
          rationale: '读取已确认主体的本地趋势。',
        })
      }
      if (call === 3) {
        return json({
          protocolVersion: 'single-agent.v1',
          action: 'finish',
          rationale: '已有最低可用证据，可以综合并保留缺口。',
        })
      }
      const toolCall = getResearchAgentRunLedger(db, currentRunId())!.toolCalls[0]
      const reference = (JSON.parse(toolCall.stable_references_json) as Array<{ referenceId: string }>)[0].referenceId
      return json({
        protocolVersion: 'single-agent.v1',
        action: 'finish',
        outcome: 'complete',
        reportMarkdown: [
          '# 结论摘要',
          `本地趋势事实已经形成可核验底稿 [${reference}]。`,
          '## 支持证据',
          `趋势工具返回可用状态 [${reference}]。`,
          '## 反证与风险',
          '单一趋势事实不能替代基本面验证，也不构成交易建议。',
          '## 未知项',
          '基本面与公告正文仍未覆盖，结论存在不确定性。',
          '## 资料截点',
          '资料截点为2026-07-30。',
          '## 继续验证清单',
          '后续需显式读取基本面并核验公告正文。',
        ].join('\n'),
        rationale: '严格按已持久化事实形成报告。',
      })
    })
  }

  let activeRunId = ''
  function currentRunId() { return activeRunId }

  it('keeps the exact gate-qualified document excerpts visible when cumulative tool projections exceed the model context budget', () => {
    const projectId = '00000000-0000-4000-8000-000000009999'
    const run = startRun({
      question: '研究光纤扩产、技术壁垒和供需冲击是否会重演光伏的产能过剩路径？',
      subjects: [{ kind: 'industry_project', id: projectId, label: '光纤产业' }],
      includePortfolio: true,
    })
    const makeCall = (input: {
      id: string
      toolId: string
      envelope: Record<string, unknown>
      projection: Record<string, unknown>
      references?: unknown[]
      coverage?: Record<string, unknown>
    }) => ({
      id: input.id,
      run_id: run.id,
      step_id: uuid(),
      tool_id: input.toolId,
      attempt: 1,
      input_json: JSON.stringify({ asOf: '20260730' }),
      input_sha256: input.id.padEnd(64, 'a').slice(0, 64),
      as_of: '20260730',
      status: 'succeeded',
      envelope_json: JSON.stringify(input.envelope),
      envelope_sha256: 'b'.repeat(64),
      model_projection_json: JSON.stringify(input.projection),
      model_projection_sha256: 'c'.repeat(64),
      stable_references_json: JSON.stringify(input.references ?? []),
      fact_date: '20260729',
      sources_json: JSON.stringify([]),
      coverage_json: JSON.stringify(input.coverage ?? { available: 1, required: 1, unit: 'documents' }),
      warnings_json: '[]',
      duration_ms: 10,
      error_code: null,
      error_message: null,
      prepared_at: NOW,
      submitted_at: NOW,
      started_at: NOW,
      completed_at: NOW,
      updated_at: NOW,
    }) as unknown as ResearchAgentToolCallRow
    const noiseCalls = Array.from({ length: 36 }, (_, index) => makeCall({
      id: `noise-${index}`,
      toolId: 'web.search',
      envelope: {
        status: 'ready',
        data: { candidates: [{ title: `候选${index}`, snippet: '不计入正文证据的搜索摘要'.repeat(300) }] },
      },
      projection: {
        status: 'ready',
        data: { candidates: [{ title: `候选${index}`, snippet: '不计入正文证据的搜索摘要'.repeat(300) }] },
      },
      coverage: { available: 8, required: 1, unit: 'candidates' },
    }))
    const documentSpecs = [
      {
        id: 'document-official',
        toolId: 'official.disclosure_document',
        title: '光纤产业发行人2025年年度报告',
        domain: 'cninfo.com.cn',
        sourceClass: 'official' as const,
        primary: true,
        publishedAt: '2026-03-27',
        hash: '1'.repeat(64),
        referenceId: 'E-0000000001',
        excerpt: `证券代码：600498 证券简称：烽火通信\n${'光纤产业正式披露显示，扩产规模、建设周期、产能利用率和客户认证构成达产约束。'.repeat(260)}`,
      },
      {
        id: 'document-primary',
        toolId: 'web.fetch_page',
        title: '光纤产业协会供需调查',
        domain: 'industry.example.org',
        sourceClass: 'primary' as const,
        primary: true,
        publishedAt: '2025-12-10',
        hash: '2'.repeat(64),
        referenceId: 'E-0000000002',
        excerpt: '光纤产业一手调查记录新增供给、需求增量、价格传导和良率爬坡。'.repeat(220),
      },
      {
        id: 'document-secondary',
        toolId: 'web.fetch_page',
        title: '光纤产业扩产与光伏路径对照',
        domain: 'research.example.com',
        sourceClass: 'secondary' as const,
        primary: false,
        publishedAt: '2025-09-18',
        hash: '3'.repeat(64),
        referenceId: 'E-0000000003',
        excerpt: '光纤产业独立研究比较扩产周期、技术壁垒、资本强度和光伏产能过剩路径。'.repeat(220),
      },
    ]
    const documentCalls = documentSpecs.map((document) => {
      const data = {
        document: {
          title: document.title,
          excerpt: document.excerpt,
          contentSha256: document.hash,
          finalUrl: `https://${document.domain}/article`,
          fetchedAt: NOW,
          sourceDomain: document.domain,
          sourceClass: document.sourceClass,
          primarySourceConfirmed: document.primary,
          publishedAt: document.publishedAt,
        },
      }
      return makeCall({
        id: document.id,
        toolId: document.toolId,
        envelope: { status: 'ready', data },
        projection: { status: 'ready', data: { document: { ...data.document, excerpt: document.excerpt.slice(0, 1_200) } } },
        references: [{
          referenceId: document.referenceId,
          subjectKind: 'industry_project',
          subjectId: projectId,
          toolId: document.toolId,
          code: `agent_tool_20260730_${document.id}`,
          label: document.title,
          status: 'ready',
          factDate: '20260729',
          sourceIds: [document.domain],
        }],
      })
    })
    const toolCalls = [...noiseCalls, ...documentCalls]
    const evidenceGate = assessResearchAgentEvidence({
      question: run.question,
      asOf: run.as_of,
      subjects: [{ kind: 'industry_project', id: projectId, label: '光纤产业' }],
      observations: toolCalls.map((call) => ({
        callId: call.id,
        toolId: call.tool_id,
        callStatus: call.status,
        envelope: JSON.parse(call.envelope_json!),
      })),
    })
    expect(evidenceGate).toMatchObject({ decision: 'local_sufficient', maximumOutcome: 'complete' })

    const context = buildResearchAgentSynthesisFactContext(run, toolCalls, evidenceGate, {
      protocolVersion: 'single-agent.v1',
      action: 'plan',
      questions: ['扩产规模与达产周期如何', '技术壁垒是否足以延缓供给冲击'],
      candidateTools: [],
      stopConditions: [],
      rationale: '测试综合证据包。',
    }) as {
      omittedData: boolean
      contextCompleteness: string
      evidenceDocuments: Array<{ referenceIds: string[]; excerpt: string }>
    }
    expect(Buffer.byteLength(JSON.stringify(context), 'utf8')).toBeLessThanOrEqual(72 * 1024)
    expect(context).toMatchObject({ omittedData: false, contextCompleteness: 'complete' })
    expect(context.evidenceDocuments).toHaveLength(3)
    expect(context.evidenceDocuments.flatMap((document) => document.referenceIds)).toEqual([
      'E-0000000001',
      'E-0000000002',
      'E-0000000003',
    ])
    expect(context.evidenceDocuments.every((document) => document.excerpt.length >= 500)).toBe(true)
    expect(JSON.stringify(context)).not.toContain('cumulative_model_input_budget')
  })

  it('runs plan, controlled tools, synthesis, audit and persistence with fixed provider/model and exact usage/cost ledgers', async () => {
    const run = startRun()
    activeRunId = run.id
    const callModel = successfulModel()
    const toolExecutor = vi.fn((_db, toolId: string) => readyEnvelope(toolId))
    const onProgress = vi.fn()
    const completed = await runResearchAgent(db, { runId: run.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel,
      toolService: { executeTool: toolExecutor },
      now: () => NOW + 100,
      priceSnapshot: {
        version: 'test-price-v1',
        provider: config.provider,
        model: config.model,
        currency: 'CNY',
        inputPerMillionTokens: 1,
        outputPerMillionTokens: 2,
      },
      onProgress,
    })

    expect(completed).toMatchObject({ status: 'succeeded', phase: 'persist', outcome: 'complete' })
    expect(completed.plan_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(completed.evidence_snapshot_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(completed.report_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(completed.audit_json).toContain('EVIDENCE_REFERENCE_REQUIRED')
    expect(completed).toMatchObject({
      model_call_count: 4,
      tool_call_count: 1,
      input_tokens: 400,
      output_tokens: 200,
      total_tokens: 600,
      usage_status: 'complete',
      cost_currency: 'CNY',
      cost_status: 'complete',
    })
    expect(completed.estimated_cost).toBeCloseTo(0.0008, 8)
    expect(callModel).toHaveBeenCalledTimes(4)
    expect(toolExecutor).toHaveBeenCalledTimes(1)
    expect(onProgress).toHaveBeenCalled()
    expect(onProgress.mock.calls[0][0]).toMatchObject({
      runId: run.id,
      status: 'running',
      phase: 'planning',
      stepOrdinal: null,
      executionStartedAt: NOW + 100,
      modelCalls: { completed: 0, maximum: null },
      toolCalls: { completed: 0, maximum: null },
      usage: {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        completeness: 'unknown',
      },
    })
    expect(onProgress.mock.calls.at(-1)?.[0]).toMatchObject({
      phase: 'persist',
      modelCalls: { completed: 4, maximum: null },
      toolCalls: { completed: 1, maximum: null },
      usage: { inputTokens: 400, outputTokens: 200, totalTokens: 600, completeness: 'complete' },
    })
    const progressMessages = onProgress.mock.calls.map(([event]) => event.message)
    expect(progressMessages).toContain('正在调用固定模型制定研究计划')
    expect(progressMessages).toContain('第 1 轮：正在执行 stock.trend_snapshot（1/1）')
    expect(progressMessages).toContain('证据已达到综合门槛，正在生成研究报告')
    expect(progressMessages).toContain('正在校验证据引用、结论边界与风险披露')
    expect(progressMessages).toContain('正在固化最终研究账本')
    for (const request of (callModel as ReturnType<typeof vi.fn>).mock.calls.map((args) => args[0] as AIProviderRequest)) {
      expect(request).toMatchObject({
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
        disableNativeSearch: true,
      })
      expect(request.apiKey).toBe(config.apiKey)
      expect(request.signal).toBeInstanceOf(AbortSignal)
      expect(request.maxTokens).toBeNull()
      expect(request.omitOutputTokenLimit).toBe(true)
    }
    const firstDecisionMessage = ((callModel as ReturnType<typeof vi.fn>).mock.calls[1][0] as AIProviderRequest).messages[0].content
    expect(firstDecisionMessage).toContain('"subjects":[{"kind":"stock"')
    expect(firstDecisionMessage).toContain('"tsCode":"600519.SH"')
    expect(firstDecisionMessage).toContain('"trustedContext"')
    expect(firstDecisionMessage).toContain('"remainingToolCalls":null')
    expect(firstDecisionMessage).toContain('"reservedRecoveryCalls":null')
    const synthesisMessage = ((callModel as ReturnType<typeof vi.fn>).mock.calls[3][0] as AIProviderRequest).messages[0].content
    expect(synthesisMessage).toContain('outcome评价的是核心问题覆盖，不是未知项数量')
    expect(synthesisMessage).toContain('不得仅因存在未知项就降级')
    const ledgerJson = JSON.stringify(getResearchAgentRunLedger(db, run.id))
    expect(ledgerJson).not.toContain(config.apiKey)
  })

  it('resumes the previous v4 prompt contract without silently applying v5 outcome semantics', async () => {
    const run = startRun({ promptRuleVersion: RESEARCH_AGENT_PREVIOUS_PROMPT_RULE_VERSION })
    activeRunId = run.id
    const callModel = successfulModel()

    const completed = await runResearchAgent(db, { runId: run.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel,
      toolService: { executeTool: (_db, toolId) => readyEnvelope(toolId) },
      now: () => NOW + 100,
    })

    expect(completed).toMatchObject({ status: 'succeeded', outcome: 'complete' })
    const synthesisMessage = ((callModel as ReturnType<typeof vi.fn>).mock.calls[3][0] as AIProviderRequest).messages[0].content
    expect(synthesisMessage).toContain('证据支持有限时返回partial')
    expect(synthesisMessage).not.toContain('不得仅因存在未知项就降级')
    expect(getResearchAgentRunLedger(db, run.id)!.steps.every((step) => (
      JSON.parse(step.input_json).protocolVersion === RESEARCH_AGENT_PREVIOUS_PROMPT_RULE_VERSION
    ))).toBe(true)
  })

  it('measures the duration budget from each resumed execution instead of the original creation time', async () => {
    const run = startRun({ budget: RESEARCH_AGENT_CONTINUOUS_BUDGET_V2, now: NOW - RESEARCH_AGENT_CONTINUOUS_BUDGET_V2.maxDurationMs - 60_000 })
    activeRunId = run.id
    const toolExecutor = vi.fn((_db, toolId) => readyEnvelope(toolId))

    const completed = await runResearchAgent(db, { runId: run.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel: successfulModel(),
      toolService: { executeTool: toolExecutor },
      now: () => NOW + 100,
    })

    expect(completed).toMatchObject({ status: 'succeeded', outcome: 'complete', error_code: null })
    expect(toolExecutor).toHaveBeenCalled()
    expect(getResearchAgentRunLedger(db, run.id)!.toolCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'succeeded' }),
    ]))
  })

  it('continues model synthesis with a partial outcome when an unrestricted run still lacks local evidence', async () => {
    const run = startRun({ question: '仅基于本地资料分析茅台最近基本面与公告是否支持当前判断？' })
    activeRunId = run.id
    const callModel = successfulModel()
    const completed = await runResearchAgent(db, { runId: run.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel,
      toolService: { executeTool: (_db, toolId) => readyEnvelope(toolId) },
      now: () => NOW + 100,
    })

    expect(completed).toMatchObject({ status: 'succeeded', outcome: 'partial', model_call_count: 4 })
    expect(completed.report_markdown).toContain('本地趋势事实已经形成可核验底稿')
    expect(JSON.parse(completed.audit_json!).checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'EVIDENCE_COMPLETENESS_OVERCLAIM', status: 'passed' }),
    ]))
    expect(callModel).toHaveBeenCalledTimes(4)
    const ledger = getResearchAgentRunLedger(db, run.id)!
    expect(ledger.modelCalls.some((call) => call.purpose === 'synthesis' && call.status === 'succeeded')).toBe(true)
    const synthesis = ledger.steps.find((step) => step.kind === 'synthesis')!
    expect(JSON.parse(synthesis.artifact_json!)).toMatchObject({
      evidenceGate: { decision: 'network_required', maximumOutcome: 'blocked' },
      modelOutcome: 'complete',
      finalAction: { outcome: 'complete' },
    })
  })

  it('re-runs the same evidence gate after controlled network supplementation before synthesis', async () => {
    const run = startRun({ question: '贵州茅台最近有什么重要新闻和事件？' })
    activeRunId = run.id
    let modelCall = 0
    const callModel = vi.fn(async () => {
      modelCall += 1
      if (modelCall === 1) {
        return json({
          protocolVersion: 'single-agent.v1',
          action: 'plan',
          questions: ['核验最新事件及独立来源正文'],
          candidateTools: ['news.recent_briefings', 'web.search', 'web.fetch_page'],
          stopConditions: ['取得两份独立正文且至少一份官方来源'],
          rationale: '先查本地，再按证据缺口受控联网。',
        })
      }
      if (modelCall === 2) {
        return json({
          protocolVersion: 'single-agent.v1',
          action: 'tool_batch',
          calls: [{ toolId: 'news.recent_briefings', input: { query: '贵州茅台', limit: 10 } }],
          rationale: '先核验本地资讯覆盖。',
        })
      }
      if (modelCall === 3) {
        return json({
          protocolVersion: 'single-agent.v1',
          action: 'tool_batch',
          calls: [{ toolId: 'web.search', input: { query: '贵州茅台 600519 最新事件', maxResults: 4 } }],
          rationale: '本地只有摘要，发现受控正文候选。',
        })
      }
      if (modelCall === 4) {
        return json({
          protocolVersion: 'single-agent.v1',
          action: 'tool_batch',
          calls: [
            { toolId: 'web.fetch_page', input: { candidateId: 'SRC-AAAAAAAAAAAAAAAA' } },
            { toolId: 'web.fetch_page', input: { candidateId: 'SRC-BBBBBBBBBBBBBBBB' } },
          ],
          rationale: '抓取两份独立正文并固化哈希。',
        })
      }
      if (modelCall === 5) {
        return json({
          protocolVersion: 'single-agent.v1',
          action: 'finish',
          rationale: '正文样本与官方来源已经满足同版本门禁。',
        })
      }
      const references = getResearchAgentRunLedger(db, run.id)!.toolCalls
        .filter((call) => call.tool_id === 'web.fetch_page')
        .flatMap((call) => JSON.parse(call.stable_references_json) as Array<{ referenceId: string }>)
        .map((reference) => reference.referenceId)
      return json({
        protocolVersion: 'single-agent.v1',
        action: 'finish',
        outcome: 'complete',
        reportMarkdown: [
          '# 结论摘要',
          `两份独立正文已经固化并相互印证[${references[0]}][${references[1]}]。`,
          '## 支持证据',
          `官方正文与独立媒体正文均可追溯[${references[0]}][${references[1]}]。`,
          '## 反证与风险',
          '公开来源可能存在后续修订，当前结论不构成交易建议。',
          '## 未知项',
          '事件后续影响和管理层进一步说明仍未知。',
          '## 资料截点',
          '资料截点为2026-07-30。',
          '## 继续验证清单',
          '后续按新公告显式复核，不用当前事实覆盖本次快照。',
        ].join('\n'),
        rationale: '只使用同一运行已落账并通过门禁的正文证据。',
      })
    })
    const executeNetworkTool = vi.fn(async (
      input: ExecuteResearchAgentNetworkToolInput,
    ): Promise<ResearchAgentNetworkToolEnvelope> => {
      if (input.call.tool_id === 'web.search') {
        return {
          schemaVersion: 1,
          toolId: 'web.search',
          status: 'ready',
          generatedAt: NOW + 100,
          asOf: '20260730',
          sources: [{ id: 'search.test', status: 'ready', factDate: '20260730' }],
          coverage: { available: 2, required: 1, unit: 'candidates' },
          warnings: ['搜索候选不计为正文证据。'],
          data: {
            candidates: [
              { candidateId: 'SRC-AAAAAAAAAAAAAAAA', sourceClass: 'official' },
              { candidateId: 'SRC-BBBBBBBBBBBBBBBB', sourceClass: 'secondary' },
            ],
          },
        }
      }
      const official = input.toolInput.candidateId === 'SRC-AAAAAAAAAAAAAAAA'
      const sourceDomain = official ? 'www.cninfo.com.cn' : 'news.example.com'
      return {
        schemaVersion: 1,
        toolId: 'web.fetch_page',
        status: 'ready',
        generatedAt: NOW + 100,
        asOf: '20260730',
        sources: [{ id: official ? 'official.cninfo' : 'media.example', status: 'ready', factDate: '20260729' }],
        coverage: { available: 1, required: 1, unit: 'documents' },
        warnings: [],
        data: {
          document: {
            candidateId: input.toolInput.candidateId,
            title: official ? '贵州茅台官方公告正文' : '贵州茅台独立媒体正文',
            finalUrl: `https://${sourceDomain}/article`,
            sourceDomain,
            sourceClass: official ? 'official' : 'secondary',
            primarySourceConfirmed: official,
            publishedAt: '2026-07-29',
            fetchedAt: NOW + 100,
            excerpt: official
              ? `证券代码：600519 证券简称：贵州茅台\n${'贵州茅台公告披露事项的发生时间、决策程序、事实细节、限制条件和后续未知项。'.repeat(5)}`
              : '独立媒体采访贵州茅台相关人员，核验近期事件时间线、现场信息和仍待确认的后续影响。'.repeat(5),
            excerptTruncated: false,
            contentSha256: (official ? 'a' : 'b').repeat(64),
            rawBodySha256: (official ? 'c' : 'd').repeat(64),
            mimeKind: 'html',
          },
        },
      }
    })
    const completed = await runResearchAgent(db, { runId: run.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel,
      toolService: {
        executeTool: (_db, toolId) => readyEnvelope(toolId),
        executeNetworkTool,
      },
      now: () => NOW + 100,
    })

    expect(completed).toMatchObject({
      status: 'succeeded',
      outcome: 'complete',
      model_call_count: 6,
      tool_call_count: 4,
    })
    expect(callModel).toHaveBeenCalledTimes(6)
    expect(executeNetworkTool).toHaveBeenCalledTimes(3)
    const ledger = getResearchAgentRunLedger(db, run.id)!
    const toolingArtifacts = ledger.steps
      .filter((step) => step.kind === 'tooling')
      .map((step) => JSON.parse(step.artifact_json!))
    expect(toolingArtifacts.slice(0, 2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceGate: expect.objectContaining({ decision: 'network_required' }) }),
    ]))
    expect(toolingArtifacts.at(-1)).toMatchObject({
      action: 'finish',
      evidenceGate: { decision: 'local_sufficient', maximumOutcome: 'complete' },
    })
    expect(ledger.modelCalls.some((call) => call.purpose === 'synthesis' && call.status === 'succeeded')).toBe(true)
  })

  it('uses at most two persisted fallback candidates after an unusable document without another model decision', async () => {
    const run = startRun({ question: '贵州茅台最近有什么重要新闻和事件？' })
    activeRunId = run.id
    let modelCall = 0
    const callModel = vi.fn(async () => {
      modelCall += 1
      if (modelCall === 1) return json({
        protocolVersion: 'single-agent.v1',
        action: 'plan',
        questions: ['核验贵州茅台近期事件'],
        candidateTools: ['news.recent_briefings', 'web.search', 'web.fetch_page'],
        stopConditions: ['两份独立正文且至少一份一级来源'],
        rationale: '先本地后联网。',
      })
      if (modelCall === 2) return json({
        protocolVersion: 'single-agent.v1',
        action: 'tool_batch',
        calls: [{ toolId: 'news.recent_briefings', input: { query: '贵州茅台', limit: 10 } }],
        rationale: '核验本地覆盖。',
      })
      if (modelCall === 3) return json({
        protocolVersion: 'single-agent.v1',
        action: 'tool_batch',
        calls: [{ toolId: 'web.search', input: { query: '贵州茅台 600519 最新事件', maxResults: 6 } }],
        rationale: '发现候选正文。',
      })
      if (modelCall === 4) return json({
        protocolVersion: 'single-agent.v1',
        action: 'tool_batch',
        calls: [{ toolId: 'web.fetch_page', input: { candidateId: 'SRC-AAAAAAAAAAAAAAAA' } }],
        rationale: '抓取首个候选。',
      })
      if (modelCall === 5) return json({
        protocolVersion: 'single-agent.v1',
        action: 'finish',
        rationale: '确定性恢复已补齐两份正文。',
      })
      const references = getResearchAgentRunLedger(db, run.id)!.toolCalls
        .flatMap((call) => JSON.parse(call.stable_references_json) as Array<{ referenceId: string }>)
        .map((item) => item.referenceId)
      return json({
        protocolVersion: 'single-agent.v1',
        action: 'finish',
        outcome: 'complete',
        reportMarkdown: [
          '# 结论摘要',
          `近期事件已由正式披露和独立媒体正文交叉核验[${references[0]}][${references[1]}]。`,
          '## 支持证据',
          `两份正文均已固化[${references[0]}][${references[1]}]。`,
          '## 反证与风险',
          '事件影响仍可能变化，不构成交易建议。',
          '## 未知项',
          '后续公告与经营影响仍未知。',
          '## 资料截点',
          '资料截点为2026-07-30。',
          '## 继续验证清单',
          '后续按新披露显式复核。',
        ].join('\n'),
        rationale: '只使用已持久化正文。',
      })
    })
    const executeNetworkTool = vi.fn(async (
      input: ExecuteResearchAgentNetworkToolInput,
    ): Promise<ResearchAgentNetworkToolEnvelope> => {
      if (input.call.tool_id === 'web.search') return {
        schemaVersion: 1,
        toolId: 'web.search',
        status: 'ready',
        generatedAt: NOW + 100,
        asOf: '20260730',
        sources: [{ id: 'search.test', status: 'ready', factDate: '20260730' }],
        coverage: { available: 3, required: 1, unit: 'candidates' },
        warnings: [],
        data: {
          candidates: [
            { candidateId: 'SRC-AAAAAAAAAAAAAAAA', sourceClass: 'secondary' },
            { candidateId: 'SRC-BBBBBBBBBBBBBBBB', sourceClass: 'official' },
            { candidateId: 'SRC-CCCCCCCCCCCCCCCC', sourceClass: 'secondary' },
          ],
        },
      }
      const candidateId = String(input.toolInput.candidateId)
      const unusable = candidateId === 'SRC-AAAAAAAAAAAAAAAA'
      const official = candidateId === 'SRC-BBBBBBBBBBBBBBBB'
      const sourceDomain = official ? 'www.cninfo.com.cn' : unusable ? 'empty.example.com' : 'news.example.com'
      const excerpt = unusable
        ? ''
        : official
          ? `证券代码：600519 证券简称：贵州茅台\n${'贵州茅台公告披露近期事项的时间、决策程序、事实边界和后续风险。'.repeat(6)}`
          : '独立媒体采访贵州茅台相关人员并核验事件时间线、现场信息和后续未知项。'.repeat(6)
      return {
        schemaVersion: 1,
        toolId: 'web.fetch_page',
        status: unusable ? 'partial' : 'ready',
        generatedAt: NOW + 100,
        asOf: '20260730',
        sources: [{ id: `source.${sourceDomain}`, status: unusable ? 'missing' : 'ready', factDate: '20260729' }],
        coverage: { available: unusable ? 0 : 1, required: 1, unit: 'documents' },
        warnings: unusable ? ['候选没有可引用正文。'] : [],
        data: {
          document: {
            candidateId,
            title: official ? '贵州茅台重要事项公告' : '贵州茅台近期事项独立核验',
            finalUrl: `https://${sourceDomain}/article`,
            sourceDomain,
            sourceClass: official ? 'official' : 'secondary',
            primarySourceConfirmed: official,
            publishedAt: '2026-07-29',
            fetchedAt: NOW + 100,
            excerpt,
            excerptTruncated: false,
            contentSha256: (official ? 'b' : unusable ? 'a' : 'c').repeat(64),
            rawBodySha256: (official ? 'e' : unusable ? 'd' : 'f').repeat(64),
            mimeKind: 'html',
          },
        },
      }
    })
    const completed = await runResearchAgent(db, { runId: run.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel,
      toolService: {
        executeTool: (_db, toolId) => readyEnvelope(toolId),
        executeNetworkTool,
      },
      now: () => NOW + 100,
    })

    expect(completed).toMatchObject({ status: 'succeeded', outcome: 'complete', model_call_count: 6, tool_call_count: 5 })
    expect(executeNetworkTool).toHaveBeenCalledTimes(4)
    const ledger = getResearchAgentRunLedger(db, run.id)!
    const recoveryCalls = ledger.toolCalls.filter((call) => JSON.parse(call.input_json).__executionOrigin === 'recovery')
    expect(recoveryCalls).toHaveLength(2)
    expect(new Set(recoveryCalls.map((call) => JSON.parse(call.input_json).candidateId))).toEqual(new Set([
      'SRC-BBBBBBBBBBBBBBBB',
      'SRC-CCCCCCCCCCCCCCCC',
    ]))
    const fetchedCandidateIds = executeNetworkTool.mock.calls
      .map((args) => args[0] as ExecuteResearchAgentNetworkToolInput)
      .filter((input) => input.call.tool_id === 'web.fetch_page')
      .map((input) => input.toolInput.candidateId)
    expect(fetchedCandidateIds).toEqual([
      'SRC-AAAAAAAAAAAAAAAA',
      'SRC-BBBBBBBBBBBBBBBB',
      'SRC-CCCCCCCCCCCCCCCC',
    ])
    const unusableCall = ledger.toolCalls.find((call) => (
      call.tool_id === 'web.fetch_page' && JSON.parse(call.input_json).candidateId === 'SRC-AAAAAAAAAAAAAAAA'
    ))!
    expect(JSON.parse(unusableCall.stable_references_json)).toEqual([])
    const recoveryStep = ledger.steps.find((step) => {
      if (!step.artifact_json) return false
      return JSON.parse(step.artifact_json).recoveryCount === 2
    })
    expect(JSON.parse(recoveryStep!.artifact_json!)).toMatchObject({ recoveryCount: 2 })
  })

  it('reuses a persisted tool decision after partial step progress without changing its budget snapshot', async () => {
    const run = startRun()
    activeRunId = run.id
    const plan = {
      protocolVersion: 'single-agent.v1' as const,
      action: 'plan' as const,
      questions: ['核验历史趋势'],
      candidateTools: ['stock.trend_snapshot'],
      stopConditions: ['取得可用趋势事实'],
      rationale: '先读取本地趋势事实。',
    }
    saveResearchAgentRunPlan(db, { runId: run.id, leaseOwner: OWNER, plan, now: NOW + 10 })
    advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner: OWNER, toPhase: 'tooling', now: NOW + 11 })
    const step = createResearchAgentStep(db, {
      runId: run.id,
      leaseOwner: OWNER,
      ordinal: 1,
      kind: 'tooling',
      stepInput: { protocolVersion: RESEARCH_AGENT_PROMPT_RULE_VERSION, action: 'tool_batch', decisionRound: 1 },
      id: uuid(),
      now: NOW + 12,
    })
    transitionResearchAgentStepStatus(db, { stepId: step.id, leaseOwner: OWNER, toStatus: 'running', now: NOW + 13 })
    const tools = listAvailableResearchAgentTools(run, { includeNetwork: false })
    const gate = assessResearchAgentEvidence({
      question: run.question,
      asOf: run.as_of,
      subjects: JSON.parse(run.subjects_json),
      observations: [],
    })
    const messages = buildResearchAgentToolDecisionMessages({
      question: run.question,
      subjects: JSON.parse(run.subjects_json),
      trustedContext: JSON.parse(run.context_snapshot_json),
      plan,
      asOf: run.as_of,
      round: 1,
      maximumRounds: RESEARCH_AGENT_STANDARD_BUDGET.maxToolDecisionRounds,
      budget: {
        maximumToolCalls: RESEARCH_AGENT_STANDARD_BUDGET.maxToolCalls,
        usedToolCalls: 0,
        remainingToolCalls: RESEARCH_AGENT_STANDARD_BUDGET.maxToolCalls,
        reservedRecoveryCalls: null,
      },
      tools,
      persistedFacts: { schemaVersion: 2, facts: [], failures: [], omittedData: false },
      evidenceGate: gate,
    })
    const toolBatchAction = {
      protocolVersion: 'single-agent.v1',
      action: 'tool_batch',
      calls: [{ toolId: 'stock.trend_snapshot', input: { stockCode: '600519.SH' } }],
      rationale: '读取已确认主体的趋势事实。',
    }
    const modelCall = createResearchAgentModelCall(db, {
      runId: run.id,
      stepId: step.id,
      leaseOwner: OWNER,
      purpose: 'tool_decision_1',
      attempt: 1,
      inputMessages: messages,
      id: uuid(),
      now: NOW + 14,
    })
    transitionResearchAgentModelCallStatus(db, {
      callId: modelCall.id,
      leaseOwner: OWNER,
      toStatus: 'submitted',
      now: NOW + 15,
    })
    transitionResearchAgentModelCallStatus(db, {
      callId: modelCall.id,
      leaseOwner: OWNER,
      toStatus: 'succeeded',
      responseId: 'persisted-tool-decision',
      responseText: JSON.stringify(toolBatchAction),
      finishReason: 'stop',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      now: NOW + 16,
    })
    const toolEnvelope = readyEnvelope('stock.trend_snapshot')
    const reference = {
      referenceId: 'E-AAAAAAAAAA',
      subjectKind: 'stock',
      subjectId: '600519.SH',
      toolId: 'stock.trend_snapshot',
      code: 'resume_trend_fact',
      label: '恢复用趋势事实',
      status: 'ready',
      factDate: '20260729',
      sourceIds: ['local.runner-test'],
    }
    const toolCall = createResearchAgentToolCall(db, {
      runId: run.id,
      stepId: step.id,
      leaseOwner: OWNER,
      toolId: 'stock.trend_snapshot',
      toolInput: { stockCode: '600519.SH', asOf: run.as_of },
      asOf: run.as_of,
      id: uuid(),
      now: NOW + 17,
    })
    transitionResearchAgentToolCallStatus(db, {
      callId: toolCall.id,
      leaseOwner: OWNER,
      toStatus: 'running',
      now: NOW + 18,
    })
    transitionResearchAgentToolCallStatus(db, {
      callId: toolCall.id,
      leaseOwner: OWNER,
      toStatus: 'succeeded',
      envelope: toolEnvelope,
      modelProjection: { ...toolEnvelope, stableReferences: [reference] },
      stableReferences: [reference],
      factDate: '20260729',
      sources: toolEnvelope.sources,
      coverage: toolEnvelope.coverage,
      warnings: toolEnvelope.warnings,
      now: NOW + 19,
    })
    transitionResearchAgentRunStatus(db, {
      runId: run.id,
      leaseOwner: OWNER,
      toStatus: 'paused',
      errorCode: 'PROCESS_RESTARTED',
      errorMessage: '测试模拟工具步骤落账后的进程中断',
      now: NOW + 20,
    })
    claimResearchAgentRunLease(db, { runId: run.id, leaseOwner: OWNER, now: NOW + 21, ttlMs: 120_000 })

    let continuationCalls = 0
    const continuationModel = vi.fn(async () => {
      continuationCalls += 1
      if (continuationCalls === 1) return json({
        protocolVersion: 'single-agent.v1',
        action: 'finish',
        rationale: '本地趋势事实已经满足最低门禁。',
      })
      return json({
        protocolVersion: 'single-agent.v1',
        action: 'finish',
        outcome: 'complete',
        reportMarkdown: [
          '# 结论摘要',
          '历史趋势事实已经形成可核验底稿 [E-AAAAAAAAAA]。',
          '## 支持证据',
          '趋势工具返回可用状态 [E-AAAAAAAAAA]。',
          '## 反证与风险',
          '历史走势不能替代未来验证，也不构成交易建议。',
          '## 未知项',
          '后续行情仍然未知。',
          '## 资料截点',
          '资料截点为2026-07-30。',
          '## 继续验证清单',
          '后续按新交易日显式复核。',
        ].join('\n'),
        rationale: '只使用已持久化趋势事实。',
      })
    })
    const toolExecutor = vi.fn((_db, toolId: string) => readyEnvelope(toolId))
    const completed = await runResearchAgent(db, { runId: run.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel: continuationModel,
      toolService: { executeTool: toolExecutor },
      now: () => NOW + 100,
    })

    expect(completed.error_message).toBeNull()
    expect(completed).toMatchObject({ status: 'succeeded', outcome: 'complete', tool_call_count: 1 })
    expect(continuationModel).toHaveBeenCalledTimes(2)
    expect(toolExecutor).not.toHaveBeenCalled()
    expect(getResearchAgentRunLedger(db, run.id)!.modelCalls).toHaveLength(3)
  })

  it('includes terminal tool failures in the next persisted model decision context', async () => {
    const run = startRun({
      question: '贵州茅台最近有什么重要新闻和事件？',
      budget: RESEARCH_AGENT_CONTINUOUS_BUDGET_V2,
    })
    activeRunId = run.id
    const plan = {
      protocolVersion: 'single-agent.v1' as const,
      action: 'plan' as const,
      questions: ['核验贵州茅台近期事件'],
      candidateTools: ['web.search', 'web.fetch_page'],
      stopConditions: ['取得可验证正文'],
      rationale: '通过受控联网工具补齐正文。',
    }
    saveResearchAgentRunPlan(db, { runId: run.id, leaseOwner: OWNER, plan, now: NOW + 10 })
    advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner: OWNER, toPhase: 'tooling', now: NOW + 11 })
    const step = createResearchAgentStep(db, {
      runId: run.id,
      leaseOwner: OWNER,
      ordinal: 1,
      kind: 'tooling',
      stepInput: { protocolVersion: RESEARCH_AGENT_PROMPT_RULE_VERSION, action: 'tool_batch', decisionRound: 1 },
      id: uuid(),
      now: NOW + 12,
    })
    transitionResearchAgentStepStatus(db, { stepId: step.id, leaseOwner: OWNER, toStatus: 'running', now: NOW + 13 })
    const failedCall = createResearchAgentToolCall(db, {
      runId: run.id,
      stepId: step.id,
      leaseOwner: OWNER,
      toolId: 'web.fetch_page',
      toolInput: { candidateId: 'SRC-AAAAAAAAAAAAAAAA' },
      asOf: run.as_of,
      id: uuid(),
      now: NOW + 14,
    })
    transitionResearchAgentToolCallStatus(db, {
      callId: failedCall.id,
      leaseOwner: OWNER,
      toStatus: 'submitted',
      now: NOW + 15,
    })
    transitionResearchAgentToolCallStatus(db, {
      callId: failedCall.id,
      leaseOwner: OWNER,
      toStatus: 'failed',
      errorCode: 'NETWORK_RESPONSE_TOO_LARGE',
      errorMessage: '压缩响应超过研究联网字节上限',
      now: NOW + 16,
    })
    transitionResearchAgentStepStatus(db, {
      stepId: step.id,
      leaseOwner: OWNER,
      toStatus: 'succeeded',
      artifact: { protocolVersion: RESEARCH_AGENT_PROMPT_RULE_VERSION, action: 'tool_batch' },
      now: NOW + 17,
    })

    const continuationModel = vi.fn(async () => json({
      protocolVersion: 'single-agent.v1',
      action: 'finish',
      rationale: '已识别终态失败，不再重复请求同一候选。',
    }))
    const completed = await runResearchAgent(db, { runId: run.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel: continuationModel,
      now: () => NOW + 100,
    })

    expect(completed).toMatchObject({ status: 'succeeded', outcome: 'blocked', tool_call_count: 1 })
    expect(continuationModel).toHaveBeenCalledTimes(1)
    const decisionPrompt = continuationModel.mock.calls[0][0].messages[0].content
    expect(decisionPrompt).toContain('"failures":[{')
    expect(decisionPrompt).toContain('"errorCode":"NETWORK_RESPONSE_TOO_LARGE"')
    expect(decisionPrompt).toContain('"terminal":true')
  })

  it('persists a schema-invalid model response but fails before any tool execution', async () => {
    const run = startRun()
    const callModel = vi.fn(async () => json({
      protocolVersion: 'single-agent.v1',
      action: 'plan',
      questions: ['核验趋势'],
      candidateTools: ['stock.trend_snapshot'],
      stopConditions: ['取得事实'],
      rationale: '计划',
      injectedField: 'not-allowed',
    }))
    const toolExecutor = vi.fn((_db, toolId: string) => readyEnvelope(toolId))
    const failed = await runResearchAgent(db, { runId: run.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel,
      toolService: { executeTool: toolExecutor },
      now: () => NOW + 100,
    })
    expect(failed).toMatchObject({ status: 'failed', error_code: 'ACTION_SCHEMA_INVALID', retryable: 0 })
    const ledger = getResearchAgentRunLedger(db, run.id)!
    expect(ledger.modelCalls).toHaveLength(1)
    expect(ledger.modelCalls[0].status).toBe('succeeded')
    expect(ledger.steps[0]).toMatchObject({ status: 'failed', error_code: 'ACTION_SCHEMA_INVALID' })
    expect(toolExecutor).not.toHaveBeenCalled()
  })

  it('rejects duplicate tool declarations before any call consumes the shared budget', async () => {
    const run = startRun({ question: '核验贵州茅台历史趋势。' })
    let modelCall = 0
    const callModel = vi.fn(async () => {
      modelCall += 1
      return modelCall === 1
        ? json({
            protocolVersion: 'single-agent.v1',
            action: 'plan',
            questions: ['核验历史趋势'],
            candidateTools: ['stock.trend_snapshot'],
            stopConditions: ['取得趋势事实'],
            rationale: '先读取本地趋势。',
          })
        : json({
            protocolVersion: 'single-agent.v1',
            action: 'tool_batch',
            calls: [
              { toolId: 'stock.trend_snapshot', input: { stockCode: '600519.SH' } },
              { toolId: 'stock.trend_snapshot', input: { stockCode: '600519.SH' } },
            ],
            rationale: '重复声明同一调用。',
          })
    })
    const toolExecutor = vi.fn((_db, toolId: string) => readyEnvelope(toolId))

    const failed = await runResearchAgent(db, { runId: run.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel,
      toolService: { executeTool: toolExecutor },
      now: () => NOW + 100,
    })

    expect(failed).toMatchObject({
      status: 'failed',
      error_code: 'ACTION_SCHEMA_INVALID',
      tool_call_count: 0,
    })
    expect(failed.error_message).toContain('不得重复声明')
    expect(toolExecutor).not.toHaveBeenCalled()
  })

  it('marks any provider failure after submitted as outcome_unknown and never retries it', async () => {
    const run = startRun()
    const callModel = vi.fn(async () => { throw new Error('socket closed') })
    const result = await runResearchAgent(db, { runId: run.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel,
      now: () => NOW + 100,
    })
    expect(result).toMatchObject({
      status: 'needs_attention',
      error_code: 'MODEL_OUTCOME_UNKNOWN',
      retryable: 0,
    })
    expect(getResearchAgentRunLedger(db, run.id)!.modelCalls[0]).toMatchObject({
      status: 'outcome_unknown',
      error_code: 'GENERATION_PROVIDER_FAILED',
    })
    expect(callModel).toHaveBeenCalledTimes(1)
    expect(() => claimResearchAgentRunLease(db, {
      runId: run.id,
      leaseOwner: OWNER,
      now: NOW + 200,
      ttlMs: 10_000,
    })).toThrowError(expect.objectContaining({ code: 'RUN_STATE_CONFLICT' }))
  })

  it('detects a submitted call after process interruption without invoking the provider again', async () => {
    const run = startRun()
    const step = createResearchAgentStep(db, {
      runId: run.id,
      leaseOwner: OWNER,
      ordinal: 1,
      kind: 'planning',
      stepInput: { protocolVersion: 'single-agent.v1', objective: '生成受控研究计划' },
      id: uuid(),
      now: NOW + 10,
    })
    const runningStep = transitionResearchAgentStepStatus(db, {
      stepId: step.id,
      leaseOwner: OWNER,
      toStatus: 'running',
      now: NOW + 11,
    })
    const messages = buildResearchAgentPlanningMessages({
      question: run.question,
      subjects: JSON.parse(run.subjects_json),
      asOf: run.as_of,
      includePortfolio: false,
      trustedContext: JSON.parse(run.context_snapshot_json),
      tools: listAvailableResearchAgentTools(run),
    })
    const call = createResearchAgentModelCall(db, {
      runId: run.id,
      stepId: runningStep.id,
      leaseOwner: OWNER,
      purpose: 'planning',
      attempt: 1,
      inputMessages: messages,
      id: uuid(),
      now: NOW + 12,
    })
    transitionResearchAgentModelCallStatus(db, {
      callId: call.id,
      leaseOwner: OWNER,
      toStatus: 'submitted',
      now: NOW + 13,
    })
    const provider = vi.fn(async () => json({}))
    const recovered = await runResearchAgent(db, { runId: run.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel: provider,
      now: () => NOW + 100,
    })
    expect(recovered.status).toBe('needs_attention')
    expect(provider).not.toHaveBeenCalled()
    expect(getResearchAgentRunLedger(db, run.id)!.modelCalls[0].status).toBe('outcome_unknown')
  })

  it('settles an interrupted submitted tool call before trying another persisted candidate', async () => {
    const run = startRun()
    const planning = createResearchAgentStep(db, {
      runId: run.id,
      leaseOwner: OWNER,
      ordinal: 1,
      kind: 'planning',
      stepInput: { action: 'plan' },
      id: uuid(),
      now: NOW + 10,
    })
    transitionResearchAgentStepStatus(db, { stepId: planning.id, leaseOwner: OWNER, toStatus: 'running', now: NOW + 11 })
    transitionResearchAgentStepStatus(db, {
      stepId: planning.id,
      leaseOwner: OWNER,
      toStatus: 'succeeded',
      artifact: { action: 'plan' },
      now: NOW + 12,
    })
    advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner: OWNER, toPhase: 'tooling', now: NOW + 13 })
    const tooling = createResearchAgentStep(db, {
      runId: run.id,
      leaseOwner: OWNER,
      ordinal: 2,
      kind: 'tooling',
      stepInput: { action: 'tool_batch', decisionRound: 1 },
      id: uuid(),
      now: NOW + 14,
    })
    transitionResearchAgentStepStatus(db, { stepId: tooling.id, leaseOwner: OWNER, toStatus: 'running', now: NOW + 15 })
    const call = createResearchAgentToolCall(db, {
      runId: run.id,
      stepId: tooling.id,
      leaseOwner: OWNER,
      toolId: 'web.fetch_page',
      toolInput: { candidateId: 'SRC-AAAAAAAAAAAAAAAA', asOf: '20260730' },
      asOf: '20260730',
      id: uuid(),
      now: NOW + 16,
    })
    transitionResearchAgentToolCallStatus(db, {
      callId: call.id,
      leaseOwner: OWNER,
      toStatus: 'submitted',
      now: NOW + 17,
    })
    const provider = vi.fn(async () => json({}))
    const networkTool = vi.fn()
    const result = await runResearchAgent(db, { runId: run.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel: provider,
      toolService: { executeNetworkTool: networkTool },
      now: () => NOW + 100,
    })

    expect(result).toMatchObject({ status: 'needs_attention', error_code: 'TOOL_OUTCOME_UNKNOWN' })
    expect(getResearchAgentRunLedger(db, run.id)!.toolCalls[0]).toMatchObject({
      status: 'outcome_unknown',
      error_code: 'PROCESS_INTERRUPTED_AFTER_SUBMIT',
    })
    expect(provider).not.toHaveBeenCalled()
    expect(networkTool).not.toHaveBeenCalled()
  })

  it('persists cancellation before abort and ignores a late provider response', async () => {
    const run = startRun()
    let resolveProvider!: (response: AIProviderResponse) => void
    const callModel = vi.fn(() => new Promise<AIProviderResponse>((resolve) => { resolveProvider = resolve }))
    const controller = new AbortController()
    const running = runResearchAgent(db, { runId: run.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel,
      signal: controller.signal,
      now: () => NOW + 100,
    })
    await vi.waitFor(() => expect(callModel).toHaveBeenCalledTimes(1))
    requestResearchAgentRunCancellation(db, { runId: run.id, now: NOW + 101 })
    controller.abort()
    resolveProvider(json({
      protocolVersion: 'single-agent.v1',
      action: 'plan',
      questions: ['迟到响应'],
      candidateTools: [],
      stopConditions: ['停止'],
      rationale: '不应写入',
    }))
    const cancelled = await running
    expect(cancelled).toMatchObject({ status: 'cancelled', cancel_requested: 1, report_markdown: null })
    expect(getResearchAgentRunLedger(db, run.id)!.modelCalls[0]).toMatchObject({
      status: 'cancelled',
      response_text: null,
    })
  })

  it('retries only the local discussion write after a persistence failure', async () => {
    const run = startRun({ discussionSessionId: 42 })
    activeRunId = run.id
    const callModel = successfulModel()
    const firstPersist = vi.fn(async () => { throw new Error('local write failed') })
    const failed = await runResearchAgent(db, { runId: run.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel,
      toolService: { executeTool: (_db, toolId) => readyEnvelope(toolId) },
      persistReport: firstPersist,
      now: () => NOW + 100,
    })
    expect(failed).toMatchObject({ status: 'failed', phase: 'persist', error_code: 'PERSIST_FAILED', retryable: 1 })
    expect(failed.report_markdown).toBeTruthy()
    expect(callModel).toHaveBeenCalledTimes(4)

    claimResearchAgentRunLease(db, {
      runId: run.id,
      leaseOwner: OWNER,
      now: NOW + 200,
      ttlMs: 120_000,
    })
    const secondModel = vi.fn(async () => { throw new Error('model must not run during local retry') })
    const secondPersist = vi.fn(async () => ({ messageIndex: 1 }))
    const completed = await runResearchAgent(db, { runId: run.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel: secondModel,
      persistReport: secondPersist,
      now: () => NOW + 210,
    })
    expect(completed).toMatchObject({ status: 'succeeded', outcome: 'complete' })
    expect(secondModel).not.toHaveBeenCalled()
    expect(secondPersist).toHaveBeenCalledTimes(1)
    expect(getResearchAgentRunLedger(db, run.id)!.modelCalls).toHaveLength(4)
  })

  it('blocks resume when model configuration fingerprint changes without creating a model call', async () => {
    const run = startRun({ modelConfigFingerprint: 'b'.repeat(64) })
    const provider = vi.fn(async () => json({}))
    const result = await runResearchAgent(db, { runId: run.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel: provider,
      now: () => NOW + 100,
    })
    expect(result).toMatchObject({ status: 'needs_attention', error_code: 'MODEL_CONFIG_CHANGED' })
    expect(provider).not.toHaveBeenCalled()
    expect(getResearchAgentRunLedger(db, run.id)!.modelCalls).toHaveLength(0)
  })

  it('runs bull, bear and moderator from one immutable parent snapshot with three model calls and zero tools', async () => {
    const parent = startRun({ discussionSessionId: 42 })
    activeRunId = parent.id
    const completedParent = await runResearchAgent(db, { runId: parent.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel: successfulModel(),
      toolService: { executeTool: (_db, toolId) => readyEnvelope(toolId) },
      persistReport: vi.fn(async () => undefined),
      now: () => NOW + 100,
    })
    expect(completedParent).toMatchObject({ status: 'succeeded', outcome: 'complete' })
    const parentLedger = getResearchAgentRunLedger(db, parent.id)!
    const reference = (JSON.parse(parentLedger.toolCalls[0].stable_references_json) as Array<{ referenceId: string }>)[0].referenceId

    const child = startResearchAgentRun(db, {
      requestId: uuid(),
      id: uuid(),
      runKind: 'multi_perspective',
      parentRunId: parent.id,
      discussionSessionId: parent.discussion_session_id,
      question: parent.question,
      contextSnapshot: {
        schemaVersion: 1,
        kind: 'multi_perspective_source',
        sourceRunId: parent.id,
        sourceReportSha256: completedParent.report_sha256,
        sourceEvidenceSnapshotSha256: completedParent.evidence_snapshot_sha256,
      },
      subjects: JSON.parse(parent.subjects_json),
      includePortfolio: false,
      asOf: parent.as_of,
      provider: config.provider,
      model: config.model,
      modelConfigFingerprint: config.fingerprint,
      promptRuleVersion: MULTI_PERSPECTIVE_PROMPT_RULE_VERSION,
      toolRegistryVersion: MULTI_PERSPECTIVE_TOOL_REGISTRY_VERSION,
      budget: RESEARCH_AGENT_MULTI_PERSPECTIVE_LEGACY_BUDGET,
      now: NOW + 200,
    }).run
    claimResearchAgentRunLease(db, { runId: child.id, leaseOwner: OWNER, now: NOW + 201, ttlMs: 120_000 })
    let call = 0
    const callModel = vi.fn(async () => {
      call += 1
      if (call <= 2) {
        const role = call === 1 ? 'bull' : 'bear'
        return json({
          protocolVersion: 'multi-perspective.v1',
          action: 'position',
          role,
          thesis: role === 'bull' ? '趋势事实支持继续验证积极路径。' : '单一趋势事实不足以排除基本面风险。',
          claims: [{ id: 'P1', statement: role === 'bull' ? '趋势底稿已可追溯。' : '证据覆盖仍然有限。', evidenceRefs: [reference], confidence: 'medium' }],
          counterpoints: [{ statement: '相反方向仍需正式资料验证。', evidenceRefs: [reference] }],
          unknowns: ['基本面与公告正文仍未知。'],
          verificationItems: ['核验下一期正式披露。'],
          rationale: '只使用父运行证据。',
        })
      }
      return json({
        protocolVersion: 'multi-perspective.v1',
        action: 'moderate',
        outcome: 'partial',
        conclusion: { statement: '现有趋势事实可以确认，但外推范围仍有分歧。', evidenceRefs: [reference] },
        consensus: [{ statement: '趋势底稿已经固化且可追溯。', evidenceRefs: [reference] }],
        disagreements: [{
          topic: '趋势事实的外推范围',
          bullPosition: '可以支持继续验证积极路径。',
          bearPosition: '不足以排除基本面风险。',
          materiality: 'high',
          evidenceRefs: [reference],
        }],
        unknowns: ['基本面与公告正文仍未知。'],
        verificationChecklist: [{ question: '正式披露是否支持趋势判断？', reason: '解决外推分歧', preferredSource: '交易所公告正文' }],
        rationale: '不选择赢家并保留未知项。',
      })
    })
    const onProgress = vi.fn()
    const completed = await runResearchAgent(db, { runId: child.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel,
      persistReport: vi.fn(async () => undefined),
      now: () => NOW + 300,
      onProgress,
    })

    expect(completed.error_message).toBeNull()
    expect(completed).toMatchObject({
      run_kind: 'multi_perspective',
      parent_run_id: parent.id,
      status: 'succeeded',
      outcome: 'partial',
      model_call_count: 3,
      tool_call_count: 0,
      evidence_snapshot_sha256: completedParent.evidence_snapshot_sha256,
    })
    expect(callModel).toHaveBeenCalledTimes(3)
    const ledger = getResearchAgentRunLedger(db, child.id)!
    expect(ledger.toolCalls).toHaveLength(0)
    expect(ledger.modelCalls.map((item) => item.purpose)).toEqual(expect.arrayContaining(['bull_case', 'bear_case', 'moderator']))
    expect(ledger.modelCalls).toHaveLength(3)
    expect(completed.report_markdown).toContain('## 已确认共识')
    expect(completed.report_markdown).toContain('## 核心分歧')
    expect(completed.report_markdown).toContain('## 验证清单')
    expect(onProgress.mock.calls[0][0]).toMatchObject({
      modelCalls: { completed: 0, maximum: 3 },
      toolCalls: { completed: 0, maximum: 0 },
    })
    const audit = JSON.parse(ledger.steps.find((step) => step.kind === 'audit')!.artifact_json!)
    expect(audit).toMatchObject({
      sourceRunId: parent.id,
      evidenceSnapshotSha256: completedParent.evidence_snapshot_sha256,
      quality: { disagreementCount: 1, invalidReferenceCount: 0, verificationCount: 1 },
    })
  })

  it('runs unrestricted multi-perspective review beyond six calls until semantic convergence', async () => {
    const parent = startRun({ discussionSessionId: 42 })
    activeRunId = parent.id
    const completedParent = await runResearchAgent(db, { runId: parent.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel: successfulModel(),
      toolService: { executeTool: (_db, toolId) => readyEnvelope(toolId) },
      persistReport: vi.fn(async () => undefined),
      now: () => NOW + 100,
    })
    const parentLedger = getResearchAgentRunLedger(db, parent.id)!
    const reference = (JSON.parse(parentLedger.toolCalls[0].stable_references_json) as Array<{ referenceId: string }>)[0].referenceId
    const child = startResearchAgentRun(db, {
      requestId: uuid(),
      id: uuid(),
      runKind: 'multi_perspective',
      parentRunId: parent.id,
      discussionSessionId: parent.discussion_session_id,
      question: parent.question,
      contextSnapshot: {
        schemaVersion: 1,
        kind: 'multi_perspective_source',
        sourceRunId: parent.id,
        sourceReportSha256: completedParent.report_sha256,
        sourceEvidenceSnapshotSha256: completedParent.evidence_snapshot_sha256,
      },
      subjects: JSON.parse(parent.subjects_json),
      includePortfolio: false,
      asOf: parent.as_of,
      provider: config.provider,
      model: config.model,
      modelConfigFingerprint: config.fingerprint,
      promptRuleVersion: MULTI_PERSPECTIVE_UNRESTRICTED_PROMPT_RULE_VERSION,
      toolRegistryVersion: MULTI_PERSPECTIVE_UNRESTRICTED_TOOL_REGISTRY_VERSION,
      budget: RESEARCH_AGENT_MULTI_PERSPECTIVE_BUDGET,
      now: NOW + 200,
    }).run
    claimResearchAgentRunLease(db, { runId: child.id, leaseOwner: OWNER, now: NOW + 201, ttlMs: 120_000 })
    let call = 0
    const callModel = vi.fn(async () => {
      call += 1
      if (call <= 4 || call === 6 || call === 7) {
        const role = [1, 3, 6].includes(call) ? 'bull' : 'bear'
        const round = call <= 2 ? 1 : call <= 4 ? 2 : 3
        return json({
          protocolVersion: 'multi-perspective.v2',
          action: 'position',
          role,
          thesis: role === 'bull'
            ? `第${round}轮：趋势事实支持继续验证积极路径。`
            : `第${round}轮：现有证据不足以排除基本面风险。`,
          claims: [{
            id: 'P1',
            statement: role === 'bull' ? '趋势底稿已可追溯。' : '证据覆盖仍然有限。',
            evidenceRefs: [reference],
            confidence: 'medium',
          }],
          counterpoints: [{ statement: '相反方向已经纳入本轮回应。', evidenceRefs: [reference] }],
          unknowns: ['基本面与公告正文仍未知。'],
          verificationItems: ['核验下一期正式披露。'],
          rationale: `完成第${round}轮证据约束研判。`,
        })
      }
      if (call === 5) {
        return json({
          protocolVersion: 'multi-perspective.v2',
          action: 'assess_convergence',
          decision: 'continue',
          substantiveChanges: ['双方均已正面回应相反观点。'],
          resolvedIssues: ['趋势事实的可追溯性。'],
          unresolvedIssues: ['趋势事实能否支持更强外推仍有逻辑分歧。'],
          focusAreas: ['区分已证事实与方向性外推。'],
          rationale: '双方仍需进一步澄清从趋势事实到方向判断的推理边界。',
        })
      }
      if (call === 8) {
        return json({
          protocolVersion: 'multi-perspective.v2',
          action: 'assess_convergence',
          decision: 'finish',
          substantiveChanges: ['双方已明确区分事实与外推。'],
          resolvedIssues: ['趋势事实的适用边界。'],
          unresolvedIssues: ['基本面覆盖仍需未来正式披露验证。'],
          focusAreas: [],
          rationale: '剩余分歧来自快照外未知事实，继续改写不能产生实质增量。',
        })
      }
      return json({
        protocolVersion: 'multi-perspective.v2',
        action: 'moderate',
        outcome: 'partial',
        conclusion: { statement: '趋势事实可以确认，但基本面外推仍需验证。', evidenceRefs: [reference] },
        consensus: [{ statement: '趋势底稿已经固化且可追溯。', evidenceRefs: [reference] }],
        disagreements: [{
          topic: '趋势事实的外推范围',
          bullPosition: '可以支持继续验证积极路径。',
          bearPosition: '不足以排除基本面风险。',
          materiality: 'high',
          evidenceRefs: [reference],
        }],
        unknowns: ['基本面与公告正文仍未知。'],
        verificationChecklist: [{ question: '正式披露是否支持趋势判断？', reason: '解决外推分歧', preferredSource: '交易所公告正文' }],
        rationale: '汇总三轮交锋并保留快照无法解决的未知项。',
      })
    })
    const onProgress = vi.fn()
    let postConvergenceNowCalls = 0
    const interrupted = await runResearchAgent(db, { runId: child.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel,
      persistReport: vi.fn(async () => undefined),
      now: () => {
        if (call === 8) {
          postConvergenceNowCalls += 1
          if (postConvergenceNowCalls === 2) {
            throw new ResearchAgentRunnerError('TEST_INTERRUPTION', '模拟成功调用后的进程中断', true)
          }
        }
        return NOW + 300
      },
      onProgress,
    })
    expect(interrupted).toMatchObject({
      status: 'failed',
      phase: 'tooling',
      retryable: 1,
      model_call_count: 8,
    })
    expect(callModel).toHaveBeenCalledTimes(8)
    claimResearchAgentRunLease(db, { runId: child.id, leaseOwner: OWNER, now: NOW + 400, ttlMs: 120_000 })
    const completed = await runResearchAgent(db, { runId: child.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel,
      persistReport: vi.fn(async () => undefined),
      now: () => NOW + 410,
      onProgress,
    })

    expect(completed).toMatchObject({
      status: 'succeeded',
      outcome: 'partial',
      model_call_count: 9,
      tool_call_count: 0,
    })
    expect(callModel).toHaveBeenCalledTimes(9)
    const ledger = getResearchAgentRunLedger(db, child.id)!
    expect(ledger.modelCalls.map((item) => item.purpose)).toEqual(expect.arrayContaining([
      'bull_round_1',
      'bear_round_1',
      'bull_round_2',
      'bear_round_2',
      'convergence_round_2',
      'bull_round_3',
      'bear_round_3',
      'convergence_round_3',
      'moderator',
    ]))
    expect(ledger.modelCalls).toHaveLength(9)
    expect(ledger.toolCalls).toHaveLength(0)
    expect(JSON.parse(ledger.steps.find((step) => step.kind === 'tooling')!.artifact_json!)).toMatchObject({
      protocolVersion: 'multi-perspective.v2',
      roundCount: 3,
      terminationReason: 'model_converged',
      convergence: { decision: 'finish' },
    })
    expect(completed.report_markdown).toContain('多空交锋：3 轮，按实质分歧收敛，不设模型调用次数上限')
    expect(onProgress.mock.calls.some(([progress]) => progress.modelCalls.maximum === null)).toBe(true)
  })

  it('blocks execution when a parent stable reference or report body drifts after review creation', async () => {
    const parent = startRun({ discussionSessionId: 42 })
    activeRunId = parent.id
    const completedParent = await runResearchAgent(db, { runId: parent.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel: successfulModel(),
      toolService: { executeTool: (_db, toolId) => readyEnvelope(toolId) },
      persistReport: vi.fn(async () => undefined),
      now: () => NOW + 100,
    })
    expect(completedParent).toMatchObject({ status: 'succeeded', outcome: 'complete' })

    const createReview = (now: number) => {
      const source = getResearchAgentRunLedger(db, parent.id)!.run
      const child = startResearchAgentRun(db, {
        requestId: uuid(),
        id: uuid(),
        runKind: 'multi_perspective',
        parentRunId: parent.id,
        discussionSessionId: parent.discussion_session_id,
        question: parent.question,
        contextSnapshot: {
          schemaVersion: 1,
          kind: 'multi_perspective_source',
          sourceRunId: parent.id,
          sourceReportSha256: source.report_sha256,
          sourceEvidenceSnapshotSha256: source.evidence_snapshot_sha256,
        },
        subjects: JSON.parse(parent.subjects_json),
        includePortfolio: false,
        asOf: parent.as_of,
        provider: config.provider,
        model: config.model,
        modelConfigFingerprint: config.fingerprint,
        promptRuleVersion: MULTI_PERSPECTIVE_PROMPT_RULE_VERSION,
        toolRegistryVersion: MULTI_PERSPECTIVE_TOOL_REGISTRY_VERSION,
        budget: RESEARCH_AGENT_MULTI_PERSPECTIVE_LEGACY_BUDGET,
        now,
      }).run
      return claimResearchAgentRunLease(db, { runId: child.id, leaseOwner: OWNER, now: now + 1, ttlMs: 120_000 })
    }

    const auditStep = getResearchAgentRunLedger(db, parent.id)!.steps.find((step) => step.kind === 'audit')!
    const originalArtifact = auditStep.artifact_json!
    const forgedArtifact = JSON.parse(originalArtifact)
    forgedArtifact.evidenceContrast.subjects[0].supporting[0].referenceId = 'E-FFFFFFFFFF'
    db.prepare('UPDATE research_agent_steps SET artifact_json = ? WHERE id = ?').run(JSON.stringify(forgedArtifact), auditStep.id)
    const forgedReferenceReview = createReview(NOW + 200)
    const forgedReferenceModel = vi.fn(async () => json({}))
    const forgedReferenceResult = await runResearchAgent(db, { runId: forgedReferenceReview.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel: forgedReferenceModel,
      now: () => NOW + 210,
    })
    expect(forgedReferenceResult).toMatchObject({ status: 'failed', error_code: 'EVIDENCE_MISMATCH' })
    expect(forgedReferenceModel).not.toHaveBeenCalled()

    db.prepare('UPDATE research_agent_steps SET artifact_json = ? WHERE id = ?').run(originalArtifact, auditStep.id)
    db.prepare('UPDATE research_agent_runs SET report_markdown = ? WHERE id = ?').run('# 被替换的父报告', parent.id)
    const driftedReportReview = createReview(NOW + 300)
    const driftedReportModel = vi.fn(async () => json({}))
    const driftedReportResult = await runResearchAgent(db, { runId: driftedReportReview.id, leaseOwner: OWNER }, {
      modelConfig: config,
      callModel: driftedReportModel,
      now: () => NOW + 310,
    })
    expect(driftedReportResult).toMatchObject({ status: 'failed', error_code: 'EVIDENCE_MISMATCH' })
    expect(driftedReportModel).not.toHaveBeenCalled()
  })
})
