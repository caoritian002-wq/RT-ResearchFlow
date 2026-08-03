import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import {
  advanceResearchAgentRunPhase,
  claimResearchAgentRunLease,
  createResearchAgentToolCall,
  createResearchAgentStep,
  getResearchAgentRun,
  getResearchAgentRunLedger,
  RESEARCH_AGENT_JSON_LIMITS,
  startResearchAgentRun,
  transitionResearchAgentRunStatus,
  transitionResearchAgentStepStatus,
  transitionResearchAgentToolCallStatus,
} from '../../electron/main/database/researchAgentRunRepository'
import {
  executeResearchAgentTool,
  listAvailableResearchAgentTools,
  parseResearchAgentTrustedSubjects,
} from '../../electron/main/services/researchAgentToolService'
import {
  RESEARCH_AGENT_TOOL_REGISTRY_VERSION,
  ResearchAgentNetworkToolError,
} from '../../electron/main/services/researchAgentNetworkTools'

const NOW = Date.parse('2026-07-30T04:00:00.000Z')
const OWNER = 'boot-00000000-0000-4000-8000-000000002560'
let sequence = 0

function uuid(): string {
  sequence += 1
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
}

describe('FR-256 research agent controlled fact tool service', () => {
  let db: Database.Database

  beforeEach(() => {
    sequence = 0
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, DATABASE_MIGRATIONS)
  })

  afterEach(() => db.close())

  function startToolingRun(overrides: Partial<Parameters<typeof startResearchAgentRun>[1]> = {}) {
    const started = startResearchAgentRun(db, {
      requestId: uuid(),
      id: uuid(),
      question: '茅台最近基本面与趋势事实之间是否存在明显背离？',
      contextSnapshot: { schemaVersion: 1, trustedSubjects: [] },
      subjects: [{ kind: 'stock', tsCode: '600519.SH', label: '贵州茅台' }],
      includePortfolio: false,
      asOf: '20260730',
      provider: 'deepseek',
      model: 'deepseek-chat',
      modelConfigFingerprint: 'a'.repeat(64),
      promptRuleVersion: 'single-agent.v1',
      toolRegistryVersion: RESEARCH_AGENT_TOOL_REGISTRY_VERSION,
      now: NOW,
      ...overrides,
    })
    claimResearchAgentRunLease(db, {
      runId: started.run.id,
      leaseOwner: OWNER,
      now: NOW + 10,
      ttlMs: 60_000,
    })
    const planning = createResearchAgentStep(db, {
      runId: started.run.id,
      leaseOwner: OWNER,
      ordinal: 1,
      kind: 'planning',
      stepInput: { action: 'plan' },
      id: uuid(),
      now: NOW + 20,
    })
    transitionResearchAgentStepStatus(db, {
      stepId: planning.id,
      leaseOwner: OWNER,
      toStatus: 'running',
      now: NOW + 21,
    })
    transitionResearchAgentStepStatus(db, {
      stepId: planning.id,
      leaseOwner: OWNER,
      toStatus: 'succeeded',
      artifact: { action: 'plan', questions: ['核验趋势与基本面'] },
      now: NOW + 22,
    })
    advanceResearchAgentRunPhase(db, {
      runId: started.run.id,
      toPhase: 'tooling',
      leaseOwner: OWNER,
      now: NOW + 23,
    })
    const tooling = createResearchAgentStep(db, {
      runId: started.run.id,
      leaseOwner: OWNER,
      ordinal: 2,
      kind: 'tooling',
      stepInput: { action: 'tool_batch', decisionRound: 1 },
      id: uuid(),
      now: NOW + 24,
    })
    transitionResearchAgentStepStatus(db, {
      stepId: tooling.id,
      leaseOwner: OWNER,
      toStatus: 'running',
      now: NOW + 25,
    })
    return { runId: started.run.id, stepId: tooling.id }
  }

  function readyEnvelope(toolId = 'stock.price_history') {
    return {
      schemaVersion: 1 as const,
      toolId,
      status: 'ready' as const,
      generatedAt: NOW + 30,
      asOf: '20260730',
      sources: [{ id: 'local.stock_price_cache', status: 'ready' as const, factDate: '20260729' }],
      coverage: { available: 1, required: 1, unit: 'bars' },
      warnings: [],
      data: { stockCode: '600519', tsCode: '600519.SH', bars: [{ tradeDate: '20260729', close: 1400 }] },
    }
  }

  function pauseRun(runId: string): void {
    transitionResearchAgentRunStatus(db, {
      runId,
      toStatus: 'paused',
      leaseOwner: OWNER,
      now: NOW + 100,
    })
  }

  it('normalizes and validates the immutable stock/project subject contract', () => {
    expect(parseResearchAgentTrustedSubjects([
      { kind: 'stock', tsCode: '600519', label: '贵州茅台' },
      { kind: 'stock', tsCode: '000001.SZ' },
    ])).toEqual([
      { kind: 'stock', tsCode: '600519.SH', label: '贵州茅台' },
      { kind: 'stock', tsCode: '000001.SZ', label: null },
    ])
    expect(() => parseResearchAgentTrustedSubjects([
      { kind: 'stock', tsCode: '600519.SH' },
      { kind: 'industry_project', id: uuid() },
    ])).toThrowError(expect.objectContaining({ code: 'MIXED_SUBJECTS' }))
    expect(() => parseResearchAgentTrustedSubjects([
      { kind: 'stock', tsCode: '600519.SZ' },
    ])).toThrowError(expect.objectContaining({ code: 'INVALID_SUBJECTS' }))
  })

  it('exposes only tools permitted by trusted subjects, context and portfolio confirmation', () => {
    const { runId } = startToolingRun({
      includePortfolio: true,
      contextSnapshot: {
        schemaVersion: 1,
        trustedSubjects: [{ kind: 'judgment', id: 'judgment-1' }],
      },
    })
    const ids = listAvailableResearchAgentTools(getResearchAgentRun(db, runId)!).map((tool) => tool.id)
    expect(ids).toEqual([
      'stock.price_history',
      'stock.trend_snapshot',
      'stock.fundamentals',
      'stock.announcements',
      'portfolio.holdings',
      'news.recent_briefings',
      'decision.judgment_history',
      'web.search',
      'web.fetch_page',
      'official.disclosure_search',
      'official.disclosure_document',
      'company.fundamentals_refresh',
      'market.price_refresh',
      'market.quote_snapshot',
    ])
    expect(ids).not.toContain('industry.project_snapshot')
  })

  it('keeps portfolio stocks outside an industry project subject and strips guessed stockCode from disclosure search', async () => {
    const projectId = '00000000-0000-4000-8000-000000009999'
    const { runId, stepId } = startToolingRun({
      question: '研究光纤产业扩产与供需变化。',
      subjects: [{ kind: 'industry_project', id: projectId, label: '光纤产业' }],
      includePortfolio: true,
    })
    const run = getResearchAgentRun(db, runId)!
    const disclosureDefinition = listAvailableResearchAgentTools(run)
      .find((definition) => definition.id === 'official.disclosure_search')!
    expect(disclosureDefinition.inputSchema.properties).not.toHaveProperty('stockCode')

    const executeNetworkTool = vi.fn(async (input: { toolInput: Record<string, unknown> }) => ({
      schemaVersion: 1 as const,
      toolId: 'official.disclosure_search' as const,
      status: 'ready' as const,
      generatedAt: NOW + 30,
      asOf: '20260730',
      sources: [{ id: 'search.test', status: 'ready' as const, factDate: '20260730' }],
      coverage: { available: 1, required: 1, unit: 'candidates' },
      warnings: [],
      data: { query: input.toolInput.query, candidates: [] },
    }))
    const result = await executeResearchAgentTool(db, {
      runId,
      stepId,
      leaseOwner: OWNER,
      toolId: 'official.disclosure_search',
      toolInput: {
        query: '光纤产业 长飞光纤 扩产 正式披露',
        stockCode: '601869.SH',
        maxResults: 4,
      },
      callId: uuid(),
      now: NOW + 30,
    }, { executeNetworkTool: executeNetworkTool as never })

    expect(result.call).toMatchObject({ status: 'succeeded', error_code: null })
    expect(JSON.parse(result.call.input_json)).toEqual({
      asOf: '20260730',
      maxResults: 4,
      query: '光纤产业 长飞光纤 扩产 正式披露',
    })
    expect(executeNetworkTool).toHaveBeenCalledWith(expect.objectContaining({
      toolInput: expect.not.objectContaining({ stockCode: expect.anything() }),
    }))
    pauseRun(runId)
  })

  it('executes the real local registry with authoritative asOf and persists both immutable hashes', async () => {
    const { runId, stepId } = startToolingRun()
    const result = await executeResearchAgentTool(db, {
      runId,
      stepId,
      leaseOwner: OWNER,
      toolId: 'stock.price_history',
      toolInput: { stockCode: '600519', limit: 30, minBars: 10 },
      callId: uuid(),
      now: NOW + 30,
    })
    expect(result).toMatchObject({ reused: false, call: { status: 'succeeded', as_of: '20260730' } })
    expect(result.envelope).toMatchObject({
      schemaVersion: 1,
      toolId: 'stock.price_history',
      status: 'missing',
      asOf: '20260730',
    })
    expect(JSON.parse(result.call.input_json)).toEqual({
      asOf: '20260730',
      limit: 30,
      minBars: 10,
      stockCode: '600519',
    })
    expect(result.call.envelope_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.call.model_projection_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(Buffer.byteLength(result.call.model_projection_json!, 'utf8')).toBeLessThanOrEqual(RESEARCH_AGENT_JSON_LIMITS.toolProjection)
    const references = JSON.parse(result.call.stable_references_json) as Array<{ referenceId: string; toolId: string }>
    expect(references).toEqual([])
    expect(JSON.parse(result.call.model_projection_json!)).toMatchObject({
      identity: 'internal.single_agent',
      evidenceReferences: [],
    })
  })

  it('writes prepared then blocks extra fields, cross-subject access, future cutoff and unconfirmed portfolio before execution', async () => {
    const cases = [
      {
        input: { toolId: 'stock.trend_snapshot', toolInput: { stockCode: '600519', extra: true } },
        code: 'INVALID_INPUT',
      },
      {
        input: { toolId: 'stock.trend_snapshot', toolInput: { stockCode: '000001.SZ' } },
        code: 'SUBJECT_DENIED',
      },
      {
        input: { toolId: 'portfolio.holdings', toolInput: {} },
        code: 'SCOPE_DENIED',
      },
    ]
    for (const item of cases) {
      const { runId, stepId } = startToolingRun()
      const executor = vi.fn(() => readyEnvelope(item.input.toolId))
      const result = await executeResearchAgentTool(db, {
        runId,
        stepId,
        leaseOwner: OWNER,
        ...item.input,
        callId: uuid(),
        now: NOW + 30,
      }, { executeTool: executor })
      expect(result.call).toMatchObject({ status: 'blocked', error_code: item.code })
      expect(executor).not.toHaveBeenCalled()
      expect(result.call.envelope_json).not.toBeNull()
      expect(JSON.parse(result.call.envelope_json!)).toMatchObject({ status: 'blocked', schemaVersion: 1 })
      pauseRun(runId)
    }

    const future = startToolingRun({ asOf: '20260731' })
    const executor = vi.fn(() => readyEnvelope())
    const result = await executeResearchAgentTool(db, {
      ...future,
      leaseOwner: OWNER,
      toolId: 'stock.price_history',
      toolInput: { stockCode: '600519' },
      callId: uuid(),
      now: NOW + 30,
    }, { executeTool: executor })
    expect(result.call).toMatchObject({ status: 'blocked', error_code: 'FUTURE_AS_OF' })
    expect(executor).not.toHaveBeenCalled()
    pauseRun(future.runId)
  })

  it('blocks registry version drift and guessed judgment/project identities', async () => {
    const drift = startToolingRun({ toolRegistryVersion: 'research-facts.v0' })
    const driftExecutor = vi.fn(() => readyEnvelope())
    const driftResult = await executeResearchAgentTool(db, {
      ...drift,
      leaseOwner: OWNER,
      toolId: 'stock.price_history',
      toolInput: { stockCode: '600519' },
      callId: uuid(),
      now: NOW + 30,
    }, { executeTool: driftExecutor })
    expect(driftResult.call).toMatchObject({ status: 'blocked', error_code: 'TOOL_REGISTRY_VERSION_MISMATCH' })
    expect(driftExecutor).not.toHaveBeenCalled()
    pauseRun(drift.runId)

    const judgment = startToolingRun()
    const judgmentExecutor = vi.fn(() => readyEnvelope('decision.judgment_history'))
    const judgmentResult = await executeResearchAgentTool(db, {
      ...judgment,
      leaseOwner: OWNER,
      toolId: 'decision.judgment_history',
      toolInput: { judgmentId: 'model-guessed-id' },
      callId: uuid(),
      now: NOW + 30,
    }, { executeTool: judgmentExecutor })
    expect(judgmentResult.call).toMatchObject({ status: 'blocked', error_code: 'SUBJECT_DENIED' })
    expect(judgmentExecutor).not.toHaveBeenCalled()
    pauseRun(judgment.runId)

    const projectId = uuid()
    const project = startToolingRun({ subjects: [{ kind: 'industry_project', id: projectId }] })
    const projectExecutor = vi.fn(() => readyEnvelope('industry.project_snapshot'))
    const projectResult = await executeResearchAgentTool(db, {
      ...project,
      leaseOwner: OWNER,
      toolId: 'industry.project_snapshot',
      toolInput: { projectId: uuid() },
      callId: uuid(),
      now: NOW + 30,
    }, { executeTool: projectExecutor })
    expect(projectResult.call).toMatchObject({ status: 'blocked', error_code: 'SUBJECT_DENIED' })
    expect(projectExecutor).not.toHaveBeenCalled()
    pauseRun(project.runId)
  })

  it('reuses the exact successful tool result without a second registry execution', async () => {
    const { runId, stepId } = startToolingRun()
    const executor = vi.fn(() => readyEnvelope())
    const request = {
      runId,
      stepId,
      leaseOwner: OWNER,
      toolId: 'stock.price_history',
      toolInput: { stockCode: '600519' },
      now: NOW + 30,
    }
    const first = await executeResearchAgentTool(db, { ...request, callId: uuid() }, { executeTool: executor })
    const second = await executeResearchAgentTool(db, { ...request, callId: uuid(), now: NOW + 31 }, { executeTool: executor })
    expect(first.call.status).toBe('succeeded')
    expect(second).toMatchObject({ reused: true, call: { id: first.call.id } })
    expect(executor).toHaveBeenCalledTimes(1)
    expect(getResearchAgentRun(db, runId)).toMatchObject({ tool_call_count: 1 })
  })

  it('does not dispatch the same terminal network failure more than once', async () => {
    const { runId, stepId } = startToolingRun()
    const executeNetworkTool = vi.fn(async () => {
      throw new ResearchAgentNetworkToolError('NETWORK_RESPONSE_TOO_LARGE', '压缩响应超过研究联网字节上限')
    })
    const request = {
      runId,
      stepId,
      leaseOwner: OWNER,
      toolId: 'web.fetch_page',
      toolInput: { candidateId: 'SRC-AAAAAAAAAAAAAAAA' },
      now: NOW + 30,
    }
    const first = await executeResearchAgentTool(db, {
      ...request,
      executionOrigin: 'recovery',
      callId: uuid(),
    }, { executeNetworkTool })
    const second = await executeResearchAgentTool(db, { ...request, callId: uuid(), now: NOW + 31 }, { executeNetworkTool })
    expect(first.call).toMatchObject({ status: 'failed', error_code: 'NETWORK_RESPONSE_TOO_LARGE' })
    expect(second).toMatchObject({ reused: true, call: { id: first.call.id } })
    expect(executeNetworkTool).toHaveBeenCalledTimes(1)
    expect(getResearchAgentRun(db, runId)).toMatchObject({ tool_call_count: 1 })
  })

  it('uses the continuous-v2 network timeout instead of the legacy 30-second ceiling', async () => {
    vi.useFakeTimers()
    try {
      const { runId, stepId } = startToolingRun()
      const resultPromise = executeResearchAgentTool(db, {
        runId,
        stepId,
        leaseOwner: OWNER,
        toolId: 'web.search',
        toolInput: { query: '贵州茅台 最新正式披露' },
        callId: uuid(),
        now: NOW + 30,
      }, {
        networkTimeoutMs: 60_000,
        executeNetworkTool: () => new Promise((resolve) => {
          setTimeout(() => resolve(readyEnvelope('web.search')), 40_000)
        }),
      })
      await vi.advanceTimersByTimeAsync(40_000)
      await expect(resultPromise).resolves.toMatchObject({ call: { status: 'succeeded' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('resumes an existing prepared call without consuming a second tool attempt', async () => {
    const { runId, stepId } = startToolingRun()
    const prepared = createResearchAgentToolCall(db, {
      runId,
      stepId,
      leaseOwner: OWNER,
      toolId: 'stock.price_history',
      toolInput: { stockCode: '600519', asOf: '20260730' },
      asOf: '20260730',
      id: uuid(),
      now: NOW + 30,
    })
    const executor = vi.fn(() => readyEnvelope())

    const resumed = await executeResearchAgentTool(db, {
      runId,
      stepId,
      leaseOwner: OWNER,
      toolId: 'stock.price_history',
      toolInput: { stockCode: '600519' },
      now: NOW + 31,
    }, { executeTool: executor })

    expect(resumed).toMatchObject({
      reused: false,
      call: { id: prepared.id, attempt: 1, status: 'succeeded' },
    })
    expect(executor).toHaveBeenCalledTimes(1)
    expect(getResearchAgentRunLedger(db, runId)?.toolCalls).toHaveLength(1)
    expect(getResearchAgentRun(db, runId)).toMatchObject({ tool_call_count: 1 })
  })

  it('marks an interrupted running call failed and retries it as a new attempt after explicit resume', async () => {
    const { runId, stepId } = startToolingRun()
    const interrupted = createResearchAgentToolCall(db, {
      runId,
      stepId,
      leaseOwner: OWNER,
      toolId: 'stock.price_history',
      toolInput: { stockCode: '600519', asOf: '20260730' },
      asOf: '20260730',
      id: uuid(),
      now: NOW + 30,
    })
    transitionResearchAgentToolCallStatus(db, {
      callId: interrupted.id,
      leaseOwner: OWNER,
      toStatus: 'running',
      now: NOW + 31,
    })
    pauseRun(runId)

    const resumedOwner = 'boot-00000000-0000-4000-8000-000000002561'
    claimResearchAgentRunLease(db, {
      runId,
      leaseOwner: resumedOwner,
      now: NOW + 110,
      ttlMs: 60_000,
    })
    const executor = vi.fn(() => readyEnvelope())
    const resumed = await executeResearchAgentTool(db, {
      runId,
      stepId,
      leaseOwner: resumedOwner,
      toolId: 'stock.price_history',
      toolInput: { stockCode: '600519' },
      now: NOW + 120,
    }, { executeTool: executor })

    expect(resumed.call).toMatchObject({ status: 'succeeded', attempt: 2 })
    expect(resumed.call.id).not.toBe(interrupted.id)
    expect(executor).toHaveBeenCalledTimes(1)
    expect(getResearchAgentRunLedger(db, runId)?.toolCalls).toEqual([
      expect.objectContaining({ id: interrupted.id, attempt: 1, status: 'failed', error_code: 'PROCESS_INTERRUPTED' }),
      expect.objectContaining({ id: resumed.call.id, attempt: 2, status: 'succeeded' }),
    ])
    expect(getResearchAgentRun(db, runId)).toMatchObject({ tool_call_count: 2 })
  })

  it('enforces two executed tools per decision step and records the rejected third attempt', async () => {
    const { runId, stepId } = startToolingRun()
    const executor = vi.fn((_db, toolId: string) => readyEnvelope(toolId))
    for (const [toolId, toolInput] of [
      ['stock.price_history', { stockCode: '600519' }],
      ['stock.trend_snapshot', { stockCode: '600519' }],
    ] as const) {
      const result = await executeResearchAgentTool(db, {
        runId, stepId, leaseOwner: OWNER, toolId, toolInput, callId: uuid(), now: NOW + 30,
      }, { executeTool: executor })
      expect(result.call.status).toBe('succeeded')
    }
    const third = await executeResearchAgentTool(db, {
      runId,
      stepId,
      leaseOwner: OWNER,
      toolId: 'stock.fundamentals',
      toolInput: { stockCode: '600519' },
      callId: uuid(),
      now: NOW + 31,
    }, { executeTool: executor })
    expect(third.call).toMatchObject({ status: 'blocked', error_code: 'TOOL_ROUND_BUDGET_EXCEEDED' })
    expect(executor).toHaveBeenCalledTimes(2)
    expect(getResearchAgentRunLedger(db, runId)?.toolCalls).toHaveLength(3)
  })

  it('fails timed-out and oversized results without persisting a partial envelope', async () => {
    const timeout = startToolingRun()
    const timedOut = await executeResearchAgentTool(db, {
      ...timeout,
      leaseOwner: OWNER,
      toolId: 'stock.price_history',
      toolInput: { stockCode: '600519' },
      callId: uuid(),
      now: NOW + 30,
    }, {
      timeoutMs: 5,
      executeTool: () => new Promise(() => undefined),
    })
    expect(timedOut.call).toMatchObject({ status: 'failed', error_code: 'TOOL_TIMEOUT', envelope_json: null })
    pauseRun(timeout.runId)

    const oversized = startToolingRun()
    const tooLarge = await executeResearchAgentTool(db, {
      ...oversized,
      leaseOwner: OWNER,
      toolId: 'stock.price_history',
      toolInput: { stockCode: '600519' },
      callId: uuid(),
      now: NOW + 30,
    }, {
      executeTool: () => ({ ...readyEnvelope(), data: { text: 'x'.repeat(300 * 1024) } }),
    })
    expect(tooLarge.call).toMatchObject({ status: 'failed', error_code: 'JSON_TOO_LARGE', envelope_json: null })
    expect(getResearchAgentRun(db, oversized.runId)).toMatchObject({ tool_result_bytes: 0 })
  })

  it('keeps large valid envelopes intact while bounding the model projection to 24 KiB', async () => {
    const { runId, stepId } = startToolingRun()
    const result = await executeResearchAgentTool(db, {
      runId,
      stepId,
      leaseOwner: OWNER,
      toolId: 'stock.price_history',
      toolInput: { stockCode: '600519' },
      callId: uuid(),
      now: NOW + 30,
    }, {
      executeTool: () => ({
        ...readyEnvelope(),
        data: {
          stockCode: '600519',
          rows: Array.from({ length: 120 }, (_, index) => ({
            index,
            detail: `第${index}项-${'x'.repeat(900)}`,
          })),
        },
      }),
    })
    expect(result.call.status).toBe('succeeded')
    expect(Buffer.byteLength(result.call.envelope_json!, 'utf8')).toBeGreaterThan(96 * 1024)
    expect(Buffer.byteLength(result.call.model_projection_json!, 'utf8')).toBeLessThanOrEqual(24 * 1024)
    expect(JSON.parse(result.call.model_projection_json!)).toMatchObject({ truncated: true })
  })
})
