import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import {
  advanceResearchAgentRunPhase,
  canTransitionResearchAgentModelCallStatus,
  canTransitionResearchAgentRunStatus,
  canTransitionResearchAgentStepStatus,
  claimResearchAgentRunLease,
  createResearchAgentModelCall,
  createResearchAgentStep,
  createResearchAgentToolCall,
  deleteResearchAgentRun,
  getResearchAgentRun,
  getResearchAgentRunLedger,
  hashResearchAgentText,
  pauseExpiredResearchAgentRuns,
  researchAgentBudgetForRun,
  renewResearchAgentRunLease,
  requestResearchAgentRunCancellation,
  RESEARCH_AGENT_CONTINUOUS_BUDGET_V2,
  RESEARCH_AGENT_CONTINUOUS_BUDGET_V2_INITIAL,
  RESEARCH_AGENT_JSON_LIMITS,
  RESEARCH_AGENT_LEGACY_BUDGET,
  RESEARCH_AGENT_MULTI_PERSPECTIVE_BUDGET,
  RESEARCH_AGENT_MULTI_PERSPECTIVE_LEGACY_BUDGET,
  RESEARCH_AGENT_STANDARD_BUDGET,
  saveResearchAgentRunAuditedReport,
  serializeResearchAgentJson,
  startResearchAgentRun,
  transitionResearchAgentModelCallStatus,
  transitionResearchAgentRunStatus,
  transitionResearchAgentStepStatus,
  transitionResearchAgentToolCallStatus,
} from '../../electron/main/database/researchAgentRunRepository'
import type { ResearchAgentRunStatus } from '../../electron/main/database/types'
import { RESEARCH_AGENT_TOOL_REGISTRY_VERSION } from '../../electron/main/services/researchAgentNetworkTools'

const OWNER = 'boot-00000000-0000-4000-8000-000000001256'
let sequence = 0

function uuid(): string {
  sequence += 1
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
}

describe('FR-256 research agent run repository', () => {
  let db: Database.Database

  beforeEach(() => {
    sequence = 0
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, DATABASE_MIGRATIONS.filter((migration) => [121, 122, 123].includes(migration.version)))
  })

  afterEach(() => db.close())

  function startRun(
    overrides: Partial<Parameters<typeof startResearchAgentRun>[1]> = {},
    targetDb: Database.Database = db,
  ) {
    return startResearchAgentRun(targetDb, {
      requestId: uuid(),
      id: uuid(),
      question: '茅台最近基本面与趋势事实之间是否存在明显背离？',
      contextSnapshot: { sessionId: 1, trusted: true },
      subjects: [{ kind: 'stock', tsCode: '600519.SH' }],
      includePortfolio: false,
      asOf: '20260730',
      provider: 'deepseek',
      model: 'deepseek-chat',
      modelConfigFingerprint: 'a'.repeat(64),
      promptRuleVersion: 'single-agent.v1',
      toolRegistryVersion: RESEARCH_AGENT_TOOL_REGISTRY_VERSION,
      now: 100,
      ...overrides,
    })
  }

  function claim(runId: string, now = 110) {
    return claimResearchAgentRunLease(db, {
      runId,
      leaseOwner: OWNER,
      now,
      ttlMs: 1_000,
    })
  }

  function createRunningStep(runId: string, kind: 'planning' | 'tooling' = 'planning', ordinal = 1) {
    const step = createResearchAgentStep(db, {
      runId,
      leaseOwner: OWNER,
      ordinal,
      kind,
      stepInput: { objective: kind },
      id: uuid(),
      now: 120 + ordinal,
    })
    return transitionResearchAgentStepStatus(db, {
      stepId: step.id,
      leaseOwner: OWNER,
      toStatus: 'running',
      now: 130 + ordinal,
    })
  }

  it('Migrations 121 to 123 create constrained ledgers, recoverable network states and run kinds', () => {
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'research_agent_%'
      ORDER BY name
    `).all() as Array<{ name: string }>
    expect(tables.map((row) => row.name)).toEqual([
      'research_agent_model_calls',
      'research_agent_runs',
      'research_agent_steps',
      'research_agent_tool_calls',
    ])
    expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 121 }, { version: 122 }, { version: 123 }])
    const runSql = (db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'research_agent_runs'
    `).get() as { sql: string }).sql
    expect(runSql).toContain("status IN ('queued', 'running', 'paused', 'needs_attention'")
    expect(runSql).toContain('json_valid(context_snapshot_json)')
    expect(runSql).toContain('report_markdown_v121')
    expect(runSql).toContain('length(report_markdown) <= 60000')
    const toolCallSql = (db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'research_agent_tool_calls'
    `).get() as { sql: string }).sql
    expect(toolCallSql).toContain("'submitted'")
    expect(toolCallSql).toContain("'outcome_unknown'")
    expect(toolCallSql).toContain('submitted_at')
    expect(() => db.prepare("UPDATE research_agent_runs SET status = 'invalid'").run()).not.toThrow()

    const started = startRun()
    const longReport = 'x'.repeat(40_000)
    expect(() => db.prepare(`
      UPDATE research_agent_runs SET report_markdown = ?, report_sha256 = ? WHERE id = ?
    `).run(longReport, hashResearchAgentText(longReport), started.run.id)).not.toThrow()
    expect(() => db.prepare("UPDATE research_agent_runs SET status = 'invalid' WHERE id = ?").run(started.run.id))
      .toThrow(/CHECK constraint failed/)
    expect(() => db.prepare("UPDATE research_agent_runs SET context_snapshot_json = 'invalid' WHERE id = ?").run(started.run.id))
      .toThrow(/CHECK constraint failed/)
  })

  it('Migration 122 preserves existing reports while widening the report limit', () => {
    const upgradeDb = new Database(':memory:')
    try {
      upgradeDb.pragma('foreign_keys = ON')
      // The current repository writes run_kind; applying 123 first keeps this focused on 122's report rewrite.
      runMigrations(upgradeDb, DATABASE_MIGRATIONS.filter((migration) => migration.version === 121 || migration.version === 123))
      const started = startRun({}, upgradeDb)
      const existingReport = '# Existing audited report'
      const existingHash = hashResearchAgentText(existingReport)
      upgradeDb.prepare(`
        UPDATE research_agent_runs SET report_markdown = ?, report_sha256 = ? WHERE id = ?
      `).run(existingReport, existingHash, started.run.id)

      runMigrations(upgradeDb, DATABASE_MIGRATIONS.filter((migration) => migration.version === 122))
      expect(getResearchAgentRun(upgradeDb, started.run.id)).toMatchObject({
        report_markdown: existingReport,
        report_sha256: existingHash,
      })
      expect(upgradeDb.prepare(`
        SELECT report_markdown_v121, report_sha256_v121 FROM research_agent_runs WHERE id = ?
      `).get(started.run.id)).toEqual({ report_markdown_v121: null, report_sha256_v121: null })
      const longReport = 'x'.repeat(40_000)
      expect(() => upgradeDb.prepare(`
        UPDATE research_agent_runs SET report_markdown = ?, report_sha256 = ? WHERE id = ?
      `).run(longReport, hashResearchAgentText(longReport), started.run.id)).not.toThrow()
    } finally {
      upgradeDb.close()
    }
  })

  it('Migration 130 preserves child ledgers and removes single-agent call-count checks', () => {
    const upgradeDb = new Database(':memory:')
    try {
      upgradeDb.pragma('foreign_keys = ON')
      runMigrations(upgradeDb, DATABASE_MIGRATIONS.filter((migration) => [121, 122, 123].includes(migration.version)))
      const run = startRun({}, upgradeDb).run
      claimResearchAgentRunLease(upgradeDb, { runId: run.id, leaseOwner: OWNER, now: 110, ttlMs: 10_000 })
      advanceResearchAgentRunPhase(upgradeDb, { runId: run.id, leaseOwner: OWNER, toPhase: 'tooling', now: 120 })
      const step = createResearchAgentStep(upgradeDb, {
        runId: run.id,
        leaseOwner: OWNER,
        ordinal: 1,
        kind: 'tooling',
        stepInput: { objective: 'migration-130' },
        id: uuid(),
        now: 121,
      })
      transitionResearchAgentStepStatus(upgradeDb, { stepId: step.id, leaseOwner: OWNER, toStatus: 'running', now: 122 })

      runMigrations(upgradeDb, DATABASE_MIGRATIONS.filter((migration) => migration.version === 130))
      expect(upgradeDb.pragma('foreign_key_check')).toEqual([])
      const runSql = (upgradeDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'research_agent_runs'").get() as { sql: string }).sql
      expect(runSql).toContain('CHECK (model_call_count >= 0)')
      expect(runSql).not.toContain('model_call_count BETWEEN 0 AND 6')
      expect(getResearchAgentRunLedger(upgradeDb, run.id)?.steps).toHaveLength(1)

      for (let index = 0; index < 10; index += 1) {
        createResearchAgentToolCall(upgradeDb, {
          runId: run.id,
          stepId: step.id,
          leaseOwner: OWNER,
          toolId: 'web.search',
          toolInput: { query: `continuous evidence ${index}` },
          asOf: '20260730',
          id: uuid(),
          now: 130 + index,
        })
      }
      for (let index = 0; index < 7; index += 1) {
        createResearchAgentModelCall(upgradeDb, {
          runId: run.id,
          stepId: step.id,
          leaseOwner: OWNER,
          purpose: `continuous_${index}`,
          attempt: 1,
          inputMessages: [{ role: 'user', content: `round ${index}` }],
          id: uuid(),
          now: 150 + index,
        })
      }
      expect(getResearchAgentRun(upgradeDb, run.id)).toMatchObject({ model_call_count: 7, tool_call_count: 10 })
    } finally {
      upgradeDb.close()
    }
  })

  it('uses canonical UUID request fingerprints for idempotent start and rejects changed input', () => {
    const requestId = uuid()
    const runId = uuid()
    const first = startRun({
      requestId,
      id: runId,
      contextSnapshot: { z: 1, a: { y: 2, x: 3 } },
    })
    const replay = startRun({
      requestId,
      id: uuid(),
      contextSnapshot: { a: { x: 3, y: 2 }, z: 1 },
    })
    expect(replay).toMatchObject({ replayed: true, run: { id: runId } })
    expect(db.prepare('SELECT COUNT(*) AS count FROM research_agent_runs').get()).toEqual({ count: 1 })
    expect(() => startRun({ requestId, question: '同一个请求标识不能改成另一份研究问题。' }))
      .toThrowError(expect.objectContaining({ code: 'REQUEST_ID_CONFLICT' }))
    expect(first.run.context_snapshot_sha256).toBe(replay.run.context_snapshot_sha256)
  })

  it('defines every legal run transition explicitly and rejects illegal repository transitions', () => {
    const expected: Record<ResearchAgentRunStatus, ResearchAgentRunStatus[]> = {
      queued: ['running', 'cancelled'],
      running: ['paused', 'needs_attention', 'succeeded', 'failed', 'cancelled'],
      paused: ['running', 'cancelled'],
      needs_attention: ['cancelled'],
      succeeded: [],
      failed: ['running', 'cancelled'],
      cancelled: [],
    }
    const statuses = Object.keys(expected) as ResearchAgentRunStatus[]
    for (const from of statuses) {
      for (const to of statuses) {
        expect(canTransitionResearchAgentRunStatus(from, to), `${from} -> ${to}`)
          .toBe(expected[from].includes(to))
      }
    }
    const run = startRun().run
    expect(() => transitionResearchAgentRunStatus(db, {
      runId: run.id,
      toStatus: 'succeeded',
      outcome: 'complete',
      now: 101,
    })).toThrowError(expect.objectContaining({ code: 'RUN_STATE_CONFLICT' }))
    const running = claim(run.id)
    const paused = transitionResearchAgentRunStatus(db, {
      runId: run.id,
      toStatus: 'paused',
      leaseOwner: OWNER,
      now: 150,
      expectedRevision: running.revision,
    })
    expect(paused).toMatchObject({ status: 'paused', lease_owner: null, revision: running.revision + 1 })
  })

  it('enforces lease ownership, renewal, single active run and explicit expiry recovery without read side effects', () => {
    const first = startRun().run
    const second = startRun().run
    const running = claim(first.id)
    expect(renewResearchAgentRunLease(db, {
      runId: first.id,
      leaseOwner: OWNER,
      now: 200,
      ttlMs: 2_000,
      expectedRevision: running.revision,
    })).toMatchObject({ lease_expires_at: 2_200, revision: running.revision + 1 })
    expect(() => renewResearchAgentRunLease(db, {
      runId: first.id,
      leaseOwner: 'other-boot',
      now: 201,
      ttlMs: 1_000,
    })).toThrowError(expect.objectContaining({ code: 'RUN_LEASE_CONFLICT' }))
    expect(() => claim(second.id, 300)).toThrowError(expect.objectContaining({ code: 'RUN_LEASE_CONFLICT' }))

    expect(getResearchAgentRun(db, first.id)?.status).toBe('running')
    expect(pauseExpiredResearchAgentRuns(db, { now: 2_199 })).toEqual({ count: 0, runIds: [] })
    expect(getResearchAgentRun(db, first.id)?.status).toBe('running')
    expect(pauseExpiredResearchAgentRuns(db, { now: 2_200 })).toEqual({ count: 1, runIds: [first.id] })
    expect(getResearchAgentRun(db, first.id)).toMatchObject({
      status: 'paused',
      lease_owner: null,
      error_code: 'LEASE_EXPIRED',
    })
    expect(claim(second.id, 2_201).status).toBe('running')
  })

  it('persists cancellation first and keeps repeated cancellation idempotent', () => {
    const run = claim(startRun().run.id)
    const cancelled = requestResearchAgentRunCancellation(db, {
      runId: run.id,
      now: 140,
      expectedRevision: run.revision,
    })
    expect(cancelled).toMatchObject({ cancel_requested: 1, revision: run.revision + 1 })
    expect(requestResearchAgentRunCancellation(db, { runId: run.id, now: 150 }).revision)
      .toBe(cancelled.revision)
    expect(() => createResearchAgentStep(db, {
      runId: run.id,
      leaseOwner: OWNER,
      ordinal: 1,
      kind: 'planning',
      stepInput: {},
      now: 150,
    })).toThrowError(expect.objectContaining({ code: 'RUN_STATE_CONFLICT' }))
    expect(() => transitionResearchAgentRunStatus(db, {
      runId: run.id,
      toStatus: 'succeeded',
      outcome: 'complete',
      leaseOwner: OWNER,
      now: 151,
    })).toThrowError(expect.objectContaining({ code: 'RUN_STATE_CONFLICT' }))
    expect(transitionResearchAgentRunStatus(db, {
      runId: run.id,
      toStatus: 'cancelled',
      leaseOwner: OWNER,
      now: 152,
    })).toMatchObject({ status: 'cancelled', cancel_requested: 1, lease_owner: null })
  })

  it('makes succeeded steps immutable and increments revisions monotonically', () => {
    const running = claim(startRun().run.id)
    const step = createRunningStep(running.id)
    const succeeded = transitionResearchAgentStepStatus(db, {
      stepId: step.id,
      leaseOwner: OWNER,
      toStatus: 'succeeded',
      artifact: { plan: ['读取事实', '形成审计报告'] },
      now: 150,
      expectedRevision: step.revision,
    })
    expect(succeeded).toMatchObject({ status: 'succeeded', revision: step.revision + 1 })
    expect(canTransitionResearchAgentStepStatus('succeeded', 'running')).toBe(false)
    expect(() => transitionResearchAgentStepStatus(db, {
      stepId: step.id,
      leaseOwner: OWNER,
      toStatus: 'failed',
      now: 160,
    })).toThrowError(expect.objectContaining({ code: 'STEP_STATE_CONFLICT' }))
    expect(getResearchAgentRun(db, running.id)!.revision).toBeGreaterThan(running.revision)
  })

  it('validates JSON serialization, UTF-8 byte limits and caller-provided hashes', () => {
    const canonicalA = serializeResearchAgentJson({ z: 1, a: { d: 2, c: 3 } }, 1024)
    const canonicalB = serializeResearchAgentJson({ a: { c: 3, d: 2 }, z: 1 }, 1024)
    expect(canonicalA).toEqual(canonicalB)
    const circular: { self?: unknown } = {}
    circular.self = circular
    expect(() => serializeResearchAgentJson(circular, 1024))
      .toThrowError(expect.objectContaining({ code: 'INVALID_JSON' }))
    expect(() => serializeResearchAgentJson({ value: Number.NaN }, 1024))
      .toThrowError(expect.objectContaining({ code: 'INVALID_JSON' }))
    expect(() => serializeResearchAgentJson({ text: '中'.repeat(400) }, 1024))
      .toThrowError(expect.objectContaining({ code: 'JSON_TOO_LARGE' }))
    expect(() => startRun({ contextSnapshotSha256: 'b'.repeat(64) }))
      .toThrowError(expect.objectContaining({ code: 'HASH_MISMATCH' }))
    expect(RESEARCH_AGENT_JSON_LIMITS.modelInput).toBe(96 * 1024)
    expect(RESEARCH_AGENT_JSON_LIMITS.toolProjection).toBe(24 * 1024)
    expect(RESEARCH_AGENT_STANDARD_BUDGET).toMatchObject({
      id: 'single-agent-unrestricted-v3',
      maxModelCalls: null,
      maxToolCalls: null,
      maxToolDecisionRounds: null,
      maxToolsPerDecision: 2,
      maxIntermediateOutputTokens: null,
      maxFinalOutputTokens: null,
      maxReportCharacters: null,
      maxModelCallDurationMs: null,
      maxDurationMs: null,
      maxToolCallDurationMs: 10_000,
    })
    expect(() => startRun({ question: '研'.repeat(4001) }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(startRun({
      subjects: Array.from({ length: 5 }, (_, index) => ({ kind: 'stock', tsCode: `60000${index}.SH` })),
    }).run.id).toBeTruthy()
    expect(() => startRun({
      subjects: Array.from({ length: 6 }, (_, index) => ({ kind: 'stock', tsCode: `60000${index}.SH` })),
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })

  it('accepts both immutable continuous-v2 snapshots plus unrestricted-v3 and rejects tampering', () => {
    const initialRun = startRun({ budget: RESEARCH_AGENT_CONTINUOUS_BUDGET_V2_INITIAL }).run
    expect(researchAgentBudgetForRun(initialRun)).toMatchObject({
      id: 'single-agent-continuous-v2',
      maxNetworkToolCallDurationMs: 30_000,
    })

    const currentV2Run = startRun({ budget: RESEARCH_AGENT_CONTINUOUS_BUDGET_V2 }).run
    expect(researchAgentBudgetForRun(currentV2Run)).toMatchObject({
      id: 'single-agent-continuous-v2',
      maxNetworkToolCallDurationMs: 120_000,
    })

    const currentRun = startRun().run
    expect(researchAgentBudgetForRun(currentRun)).toMatchObject({
      id: 'single-agent-unrestricted-v3',
      maxModelCallDurationMs: null,
      maxDurationMs: null,
    })

    const tampered = serializeResearchAgentJson({
      ...RESEARCH_AGENT_STANDARD_BUDGET,
      maxToolResultBytes: RESEARCH_AGENT_STANDARD_BUDGET.maxToolResultBytes + 1,
    }, RESEARCH_AGENT_JSON_LIMITS.budget)
    db.prepare('UPDATE research_agent_runs SET budget_json = ? WHERE id = ?')
      .run(tampered.json, currentRun.id)
    expect(() => researchAgentBudgetForRun(getResearchAgentRun(db, currentRun.id)!))
      .toThrowError(expect.objectContaining({ code: 'BUDGET_MISMATCH' }))
  })

  it('keeps an audited report bound to its original report and evidence hashes', () => {
    let run = claim(startRun().run.id)
    run = advanceResearchAgentRunPhase(db, {
      runId: run.id,
      toPhase: 'tooling',
      leaseOwner: OWNER,
      now: 140,
    })
    run = advanceResearchAgentRunPhase(db, {
      runId: run.id,
      toPhase: 'synthesis',
      leaseOwner: OWNER,
      now: 150,
    })
    run = advanceResearchAgentRunPhase(db, {
      runId: run.id,
      toPhase: 'audit',
      leaseOwner: OWNER,
      now: 160,
    })
    const evidenceHash = 'c'.repeat(64)
    const report = '# 结论摘要\n已核验本地事实。'
    const audit = { status: 'passed', evidenceSnapshotSha256: evidenceHash }
    const saved = saveResearchAgentRunAuditedReport(db, {
      runId: run.id,
      leaseOwner: OWNER,
      evidenceSnapshotSha256: evidenceHash,
      reportMarkdown: report,
      reportSha256: hashResearchAgentText(report),
      audit,
      now: 170,
    })
    expect(saved).toMatchObject({
      evidence_snapshot_sha256: evidenceHash,
      report_sha256: hashResearchAgentText(report),
    })
    expect(saveResearchAgentRunAuditedReport(db, {
      runId: run.id,
      leaseOwner: OWNER,
      evidenceSnapshotSha256: evidenceHash,
      reportMarkdown: report,
      audit,
      now: 171,
    }).revision).toBe(saved.revision)
    expect(() => saveResearchAgentRunAuditedReport(db, {
      runId: run.id,
      leaseOwner: OWNER,
      evidenceSnapshotSha256: 'd'.repeat(64),
      reportMarkdown: report,
      audit,
      now: 172,
    })).toThrowError(expect.objectContaining({ code: 'HASH_MISMATCH' }))
    expect(() => saveResearchAgentRunAuditedReport(db, {
      runId: run.id,
      leaseOwner: OWNER,
      evidenceSnapshotSha256: evidenceHash,
      reportMarkdown: `${report}\n被篡改`,
      audit,
      now: 173,
    })).toThrowError(expect.objectContaining({ code: 'HASH_MISMATCH' }))
  })

  it('stores immutable tool envelopes and projections and prevents successful duplicate execution', () => {
    const run = claim(startRun().run.id)
    const planning = createRunningStep(run.id)
    transitionResearchAgentStepStatus(db, {
      stepId: planning.id,
      leaseOwner: OWNER,
      toStatus: 'succeeded',
      artifact: { plan: true },
      now: 150,
    })
    advanceResearchAgentRunPhase(db, { runId: run.id, toPhase: 'tooling', leaseOwner: OWNER, now: 160 })
    const tooling = createRunningStep(run.id, 'tooling', 2)
    const toolInput = { tsCode: '600519.SH' }
    const first = createResearchAgentToolCall(db, {
      runId: run.id,
      stepId: tooling.id,
      leaseOwner: OWNER,
      toolId: 'stock.price_history',
      toolInput,
      asOf: '20260730',
      id: uuid(),
      now: 170,
    })
    transitionResearchAgentToolCallStatus(db, {
      callId: first.id,
      leaseOwner: OWNER,
      toStatus: 'running',
      now: 171,
    })
    const envelope = { status: 'ready', facts: [{ close: 1400 }] }
    const projection = { status: 'ready', latestClose: 1400 }
    const succeeded = transitionResearchAgentToolCallStatus(db, {
      callId: first.id,
      leaseOwner: OWNER,
      toStatus: 'succeeded',
      envelope,
      envelopeSha256: serializeResearchAgentJson(envelope, 1024).sha256,
      modelProjection: projection,
      stableReferences: ['RF-STOCK-001'],
      sources: [{ provider: 'local-sqlite' }],
      coverage: { rows: 1 },
      warnings: [],
      factDate: '20260729',
      durationMs: 4,
      now: 172,
    })
    expect(succeeded).toMatchObject({
      status: 'succeeded',
      envelope_sha256: hashResearchAgentText(succeeded.envelope_json!),
      model_projection_sha256: hashResearchAgentText(succeeded.model_projection_json!),
    })

    const duplicate = createResearchAgentToolCall(db, {
      runId: run.id,
      stepId: tooling.id,
      leaseOwner: OWNER,
      toolId: 'stock.price_history',
      attempt: 2,
      toolInput,
      asOf: '20260730',
      id: uuid(),
      now: 173,
    })
    expect(duplicate.id).toBe(first.id)
    expect(getResearchAgentRun(db, run.id)).toMatchObject({ tool_call_count: 1 })
    expect(getResearchAgentRun(db, run.id)!.tool_result_bytes).toBe(Buffer.byteLength(succeeded.envelope_json!, 'utf8'))
  })

  it('preserves the legacy eight-call budget for legacy runs', () => {
    const run = claim(startRun({ budget: RESEARCH_AGENT_LEGACY_BUDGET }).run.id)
    const planning = createRunningStep(run.id)
    transitionResearchAgentStepStatus(db, {
      stepId: planning.id,
      leaseOwner: OWNER,
      toStatus: 'succeeded',
      artifact: { plan: true },
      now: 150,
    })
    advanceResearchAgentRunPhase(db, { runId: run.id, toPhase: 'tooling', leaseOwner: OWNER, now: 160 })
    const tooling = createRunningStep(run.id, 'tooling', 2)
    for (let index = 0; index < 8; index += 1) {
      createResearchAgentToolCall(db, {
        runId: run.id,
        stepId: tooling.id,
        leaseOwner: OWNER,
        toolId: 'web.search',
        toolInput: { query: `600519 evidence ${index}`, asOf: '20260730' },
        asOf: '20260730',
        id: uuid(),
        now: 170 + index,
      })
    }
    expect(getResearchAgentRun(db, run.id)).toMatchObject({ tool_call_count: 8 })
    expect(() => createResearchAgentToolCall(db, {
      runId: run.id,
      stepId: tooling.id,
      leaseOwner: OWNER,
      toolId: 'web.search',
      toolInput: { query: '600519 ninth request', asOf: '20260730' },
      asOf: '20260730',
      id: uuid(),
      now: 180,
    })).toThrowError(expect.objectContaining({ code: 'RUN_STATE_CONFLICT' }))
    expect(getResearchAgentRun(db, run.id)).toMatchObject({ tool_call_count: 8 })
  })

  it('preserves three model calls and zero tools for historical multi-perspective runs', () => {
    const parent = startRun().run
    const child = startRun({
      runKind: 'multi_perspective',
      parentRunId: parent.id,
      budget: RESEARCH_AGENT_MULTI_PERSPECTIVE_LEGACY_BUDGET,
      promptRuleVersion: 'multi-perspective.v1',
      toolRegistryVersion: 'multi-perspective-tools.v1',
    }).run
    claim(child.id)
    advanceResearchAgentRunPhase(db, {
      runId: child.id,
      toPhase: 'tooling',
      leaseOwner: OWNER,
      now: 120,
    })
    const step = createRunningStep(child.id, 'tooling')

    for (const purpose of ['bull_case', 'bear_case', 'moderator']) {
      createResearchAgentModelCall(db, {
        runId: child.id,
        stepId: step.id,
        leaseOwner: OWNER,
        purpose,
        attempt: 1,
        inputMessages: [{ role: 'user', content: purpose }],
        id: uuid(),
        now: 140,
      })
    }

    expect(getResearchAgentRun(db, child.id)).toMatchObject({
      run_kind: 'multi_perspective',
      parent_run_id: parent.id,
      model_call_count: 3,
      tool_call_count: 0,
    })
    expect(() => createResearchAgentModelCall(db, {
      runId: child.id,
      stepId: step.id,
      leaseOwner: OWNER,
      purpose: 'fourth_call',
      attempt: 1,
      inputMessages: [{ role: 'user', content: 'must be rejected' }],
      id: uuid(),
      now: 141,
    })).toThrowError(expect.objectContaining({ code: 'RUN_STATE_CONFLICT' }))
    expect(() => createResearchAgentToolCall(db, {
      runId: child.id,
      stepId: step.id,
      leaseOwner: OWNER,
      toolId: 'stock.price_history',
      toolInput: { tsCode: '600519.SH' },
      asOf: '20260730',
      id: uuid(),
      now: 142,
    })).toThrowError(expect.objectContaining({ code: 'RUN_STATE_CONFLICT' }))
    expect(getResearchAgentRun(db, child.id)).toMatchObject({ model_call_count: 3, tool_call_count: 0 })
  })

  it('allows unrestricted multi-perspective runs to exceed three model calls while keeping tools disabled', () => {
    runMigrations(db, DATABASE_MIGRATIONS.filter((migration) => migration.version === 130))
    const parent = startRun().run
    const child = startRun({
      runKind: 'multi_perspective',
      parentRunId: parent.id,
      budget: RESEARCH_AGENT_MULTI_PERSPECTIVE_BUDGET,
      promptRuleVersion: 'multi-perspective.v2-convergent.v1',
      toolRegistryVersion: 'evidence-snapshot-only.v2',
    }).run
    claim(child.id)
    advanceResearchAgentRunPhase(db, {
      runId: child.id,
      toPhase: 'tooling',
      leaseOwner: OWNER,
      now: 120,
    })
    const step = createRunningStep(child.id, 'tooling')

    for (let index = 1; index <= 7; index += 1) {
      createResearchAgentModelCall(db, {
        runId: child.id,
        stepId: step.id,
        leaseOwner: OWNER,
        purpose: `review_${index}`,
        attempt: 1,
        inputMessages: [{ role: 'user', content: `review ${index}` }],
        id: uuid(),
        now: 140 + index,
      })
    }

    expect(researchAgentBudgetForRun(getResearchAgentRun(db, child.id)!)).toMatchObject({
      id: 'multi-perspective-unrestricted-v2',
      maxModelCalls: null,
      maxToolCalls: 0,
    })
    expect(getResearchAgentRun(db, child.id)).toMatchObject({ model_call_count: 7, tool_call_count: 0 })
    expect(() => createResearchAgentToolCall(db, {
      runId: child.id,
      stepId: step.id,
      leaseOwner: OWNER,
      toolId: 'stock.price_history',
      toolInput: { tsCode: '600519.SH' },
      asOf: '20260730',
      id: uuid(),
      now: 150,
    })).toThrowError(expect.objectContaining({ code: 'RUN_STATE_CONFLICT' }))
  })

  it('records model intent before submission, usage/cost after success and exact response hashes', () => {
    const run = claim(startRun().run.id)
    const step = createRunningStep(run.id)
    const call = createResearchAgentModelCall(db, {
      runId: run.id,
      stepId: step.id,
      leaseOwner: OWNER,
      purpose: 'planning',
      attempt: 1,
      inputMessages: [{ role: 'user', content: '制定研究计划' }],
      id: uuid(),
      now: 140,
    })
    expect(getResearchAgentRunLedger(db, run.id)).toMatchObject({
      run: { id: run.id },
      steps: [{ id: step.id }],
      modelCalls: [{ id: call.id, status: 'prepared' }],
      toolCalls: [],
    })
    expect(call).toMatchObject({ status: 'prepared', provider: 'deepseek', model: 'deepseek-chat' })
    expect(createResearchAgentModelCall(db, {
      runId: run.id,
      stepId: step.id,
      leaseOwner: OWNER,
      purpose: 'planning',
      attempt: 1,
      inputMessages: [{ content: '制定研究计划', role: 'user' }],
      id: call.id,
      now: 140,
    }).id).toBe(call.id)
    expect(getResearchAgentRun(db, run.id)?.model_call_count).toBe(1)
    expect(canTransitionResearchAgentModelCallStatus('prepared', 'succeeded')).toBe(false)
    transitionResearchAgentModelCallStatus(db, {
      callId: call.id,
      leaseOwner: OWNER,
      toStatus: 'submitted',
      now: 141,
    })
    const responseText = '{"action":"plan"}'
    const succeeded = transitionResearchAgentModelCallStatus(db, {
      callId: call.id,
      leaseOwner: OWNER,
      toStatus: 'succeeded',
      responseId: 'response-1',
      responseText,
      responseSha256: hashResearchAgentText(responseText),
      finishReason: 'stop',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      priceSnapshot: { version: '2026-07-30', currency: 'CNY' },
      estimatedCost: 0.01,
      costCurrency: 'CNY',
      now: 142,
    })
    expect(succeeded).toMatchObject({ status: 'succeeded', response_sha256: hashResearchAgentText(responseText) })
    expect(getResearchAgentRun(db, run.id)).toMatchObject({
      model_call_count: 1,
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      usage_status: 'complete',
      estimated_cost: 0.01,
      cost_currency: 'CNY',
      cost_status: 'complete',
    })
  })

  it('turns submitted calls with unknown outcomes into needs_attention and never permits replay', () => {
    const run = claim(startRun().run.id)
    const step = createRunningStep(run.id)
    const call = createResearchAgentModelCall(db, {
      runId: run.id,
      stepId: step.id,
      leaseOwner: OWNER,
      purpose: 'planning',
      attempt: 1,
      inputMessages: [{ role: 'user', content: '制定研究计划' }],
      id: uuid(),
      now: 140,
    })
    transitionResearchAgentModelCallStatus(db, {
      callId: call.id,
      leaseOwner: OWNER,
      toStatus: 'submitted',
      now: 141,
    })
    const unknown = transitionResearchAgentModelCallStatus(db, {
      callId: call.id,
      leaseOwner: OWNER,
      toStatus: 'outcome_unknown',
      errorCode: 'CONNECTION_LOST_AFTER_SUBMIT',
      now: 142,
    })
    expect(unknown.status).toBe('outcome_unknown')
    expect(getResearchAgentRun(db, run.id)).toMatchObject({
      status: 'needs_attention',
      lease_owner: null,
      error_code: 'MODEL_OUTCOME_UNKNOWN',
      retryable: 0,
    })
    expect(() => claim(run.id, 143)).toThrowError(expect.objectContaining({ code: 'RUN_STATE_CONFLICT' }))
    expect(() => transitionResearchAgentModelCallStatus(db, {
      callId: call.id,
      leaseOwner: OWNER,
      toStatus: 'submitted',
      now: 144,
    })).toThrowError(expect.objectContaining({ code: 'RUN_LEASE_CONFLICT' }))
  })

  it('cascades a deleted run through steps and both call ledgers', () => {
    const run = claim(startRun().run.id)
    const step = createRunningStep(run.id)
    createResearchAgentModelCall(db, {
      runId: run.id,
      stepId: step.id,
      leaseOwner: OWNER,
      purpose: 'planning',
      attempt: 1,
      inputMessages: [],
      id: uuid(),
      now: 140,
    })
    db.prepare('DELETE FROM research_agent_runs WHERE id = ?').run(run.id)
    expect(db.prepare('SELECT COUNT(*) AS count FROM research_agent_steps').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM research_agent_model_calls').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM research_agent_tool_calls').get()).toEqual({ count: 0 })
  })

  it('deletes only the selected terminal run and reparents direct single-agent retries', () => {
    const source = startRun().run
    const retry1 = startRun({ parentRunId: source.id }).run
    const retry2 = startRun({ parentRunId: retry1.id }).run
    transitionResearchAgentRunStatus(db, { runId: retry1.id, toStatus: 'cancelled', now: 150 })

    expect(deleteResearchAgentRun(db, retry1.id)).toEqual({ deletedRunIds: [retry1.id] })
    expect(getResearchAgentRun(db, source.id)).not.toBeNull()
    expect(getResearchAgentRun(db, retry1.id)).toBeNull()
    expect(getResearchAgentRun(db, retry2.id)).toMatchObject({ parent_run_id: source.id, status: 'queued' })
  })

  it('requires directly dependent multi-perspective reviews to be deleted first', () => {
    const source = startRun().run
    transitionResearchAgentRunStatus(db, { runId: source.id, toStatus: 'cancelled', now: 150 })
    const review = startRun({
      runKind: 'multi_perspective',
      parentRunId: source.id,
      budget: RESEARCH_AGENT_MULTI_PERSPECTIVE_BUDGET,
      promptRuleVersion: 'multi-perspective.v1',
      toolRegistryVersion: 'multi-perspective-tools.v1',
    }).run
    transitionResearchAgentRunStatus(db, { runId: review.id, toStatus: 'cancelled', now: 151 })

    expect(() => deleteResearchAgentRun(db, source.id)).toThrowError(expect.objectContaining({
      code: 'DEPENDENT_REVIEW_EXISTS',
    }))
    expect(getResearchAgentRun(db, source.id)).not.toBeNull()
    expect(getResearchAgentRun(db, review.id)).not.toBeNull()
  })
})
