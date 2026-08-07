import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXPIRED_RUN_ID = '00000000-0000-4000-8000-000000003001'
const QUEUED_RUN_ID = '00000000-0000-4000-8000-000000003002'
const SUCCEEDED_RUN_ID = '00000000-0000-4000-8000-000000003003'
const NETWORK_RUN_ID = '00000000-0000-4000-8000-000000003004'
const UNKNOWN_RUN_ID = '00000000-0000-4000-8000-000000003005'
const REVIEW_RUN_ID = '00000000-0000-4000-8000-000000003006'
const RETRY_RUN_ID = '00000000-0000-4000-8000-000000003007'
const RETRY_REQUEST_ID = '00000000-0000-4000-8000-000000003107'

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  return electron.launch({
    args: [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })
}

function runElectronScript(script: string, env: Record<string, string>): string {
  const electronExecutable = require('electron') as string
  return execFileSync(electronExecutable, ['-e', script], {
    cwd: join(__dirname, '../..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env },
  }).toString()
}

function seedResearchAgentFixture(dbPath: string): { sessionId: number } {
  const output = runElectronScript(String.raw`
    const Database = require('better-sqlite3')
    const { createHash } = require('crypto')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    const now = Date.now()
    const hash = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex')
    const json = (value) => JSON.stringify(value)
    const sessionId = Number(db.prepare(
      'INSERT INTO ai_analysis_sessions (createdAt, provider, model, articleUrls, promptSent, response, scanRunId, briefingId, isError, messages) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?)'
    ).run(now, 'deepseek', 'deepseek-chat', '[]', 'FR-256 E2E trusted discussion', '[]').lastInsertRowid)
    const context = {
      schemaVersion: 3,
      title: '贵州茅台事实复核',
      occurredAt: now - 86400000,
      sourceUrl: null,
      items: [{ key: 'question', type: 'question', label: '问题', excerpt: '趋势与基本面是否背离', removable: false }],
      researchFacts: { schemaVersion: 1, stockCodes: ['600519.SH'], invocations: [], markdown: '', toolIds: [], generatedAt: now, asOf: '20260730' },
      contextFacts: { schemaVersion: 1, invocations: [], markdown: '', toolIds: [], generatedAt: now, asOf: '20260730' }
    }
    db.prepare(
      'INSERT INTO ai_research_discussion_contexts (session_id, start_request_id, status, origin_type, origin_id, origin_title, origin_occurred_at, origin_available, origin_content_hash, context_snapshot_json, context_keys_json, included_context_keys_json, return_target_json, project_id, base_snapshot_id, base_selection_reason, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, 1, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)'
    ).run(sessionId, '00000000-0000-4000-8000-000000003100', 'active', 'manual', '贵州茅台事实复核', now - 86400000, hash('origin'), json(context), '[]', '[]', json({ tab: 'ai-analysis', subTab: 'records' }), 'unassigned', now, now)

    const budget = json({
      id: 'single-agent-standard-v1', maxModelCalls: 6, maxToolCalls: 8,
      maxToolDecisionRounds: 4, maxToolsPerDecision: 2, maxModelInputBytes: 98304,
      maxIntermediateOutputTokens: 2048, maxFinalOutputTokens: 8192,
      maxToolResultBytes: 262144, maxToolProjectionBytes: 24576,
      maxRunToolResultBytes: 2097152, maxReportCharacters: 60000,
      maxModelCallDurationMs: 120000, maxToolCallDurationMs: 10000,
      maxNetworkToolCallDurationMs: 30000, maxDurationMs: 1200000
    })
    const contextSnapshot = json({ schemaVersion: 1, source: { kind: 'discussion', sessionId }, researchFacts: context.researchFacts, messages: [] })
    const subjects = json([{ kind: 'stock', tsCode: '600519.SH', label: '贵州茅台' }])
    const plan = json({ protocolVersion: 'single-agent.v1', action: 'plan', questions: ['趋势与基本面是否背离？'], candidateTools: ['stock.price_history'], stopConditions: ['取得本地价格事实后停止'], rationale: '最小事实集合' })
    const report = '# 深度研究报告\n\n## 结论摘要\n本地事实支持继续跟踪，但仍需核验财报口径。[E-626F75C405]\n\n## 支持证据\n价格事实已固化。[E-626F75C405]\n\n## 反证与风险\n基本面覆盖仍不完整。\n\n## 未知项\n公告正文未读取。\n\n## 资料截点\n2026-07-30。\n\n## 继续验证清单\n复核下一期财报。'
    const evidence = {
      schemaVersion: 1,
      generatedAt: now - 2000,
      asOf: '20260730',
      subjects: [{
        subjectKind: 'stock', subjectId: '600519', label: '贵州茅台',
        supporting: [{ referenceId: 'E-626F75C405', code: 'PRICE_READY', toolId: 'stock.price_history', label: '本地日线可用', detail: '最近20个交易日本地日线已固化', factDate: '20260730', sourceIds: ['local.daily_close_cache'] }],
        challenging: [], unknowns: []
      }],
      warnings: ['公告正文未进入本次工具范围'],
      markdown: '确定性证据对照'
    }
    const evidenceHash = hash(json({
      schemaVersion: evidence.schemaVersion,
      asOf: evidence.asOf,
      subjects: evidence.subjects,
      warnings: evidence.warnings
    }))
    const audit = {
      schemaVersion: 1,
      documentKind: 'discussion',
      status: 'warning',
      generatedAt: now - 1000,
      asOf: '20260730',
      originalTextSha256: hash(report.trim()),
      checkedCharacters: report.length,
      evidenceSummary: { subjectCount: 1, supporting: 1, challenging: 0, unknowns: 0 },
      checks: [{ code: 'UNKNOWN_DISCLOSED', status: 'passed', message: '未知项已披露', excerpts: [] }]
    }
    const localGate = {
      schemaVersion: 1,
      ruleVersion: 'research-evidence-gate.v1',
      decision: 'network_required',
      maximumOutcome: 'blocked',
      questionProfile: { marketOnly: false, timeSensitive: true, intraday: false, asksNews: true, asksFundamentals: false, asksDisclosures: false, asksIndustry: false, offlineRequested: false },
      checks: [{ category: 'current_events', status: 'failed', code: 'CURRENT_EVENT_BODY_AND_CORROBORATION_REQUIRED', message: '本地资讯标题不能支撑时效性结论；需要至少两份独立正文证据，并包含一级或官方来源。', observedToolIds: ['news.recent_briefings'] }],
      requiredNetworkTools: ['web.search', 'web.fetch_page', 'official.disclosure_search', 'official.disclosure_document'],
      summary: '本地证据存在1项硬缺口，必须完成受控联网取证后才能进入模型综合。'
    }
    const finalGate = {
      ...localGate,
      checks: [{ category: 'current_events', status: 'failed', code: 'CURRENT_EVENT_BODY_AND_CORROBORATION_REQUIRED', message: '目前只有一份带正文的官方来源，仍缺少第二份独立正文样本。', observedToolIds: ['news.recent_briefings', 'web.search', 'web.fetch_page', 'official.disclosure_search'] }],
      summary: '受控联网已取得候选和一份官方正文，但独立正文样本仍不足，完整综合继续被阻断。'
    }
    const networkReport = '# 深度研究受阻\n\n## 结论摘要\n当前证据不足，不能生成完整深度研究结论。\n\n## 已取得证据\n已固化一份官方公告正文。\n\n## 剩余未知项\n仍缺少第二份独立正文样本。\n\n## 资料截点\n2026-07-30。'
    const networkAudit = {
      schemaVersion: 1,
      documentKind: 'discussion',
      status: 'warning',
      generatedAt: now - 500,
      asOf: '20260730',
      originalTextSha256: hash(networkReport.trim()),
      checkedCharacters: networkReport.length,
      evidenceSummary: { subjectCount: 1, supporting: 1, challenging: 0, unknowns: 1 },
      checks: [{ code: 'UNKNOWN_DISCLOSED', status: 'passed', message: '剩余未知项已明确披露', excerpts: [] }]
    }
    const insertRun = db.prepare(
      'INSERT INTO research_agent_runs (id, request_id, request_fingerprint, discussion_session_id, question, context_snapshot_json, context_snapshot_sha256, subjects_json, include_portfolio, as_of, status, phase, outcome, provider, model, model_config_fingerprint, prompt_rule_version, tool_registry_version, budget_json, plan_json, plan_sha256, evidence_snapshot_sha256, report_markdown, report_sha256, audit_json, model_call_count, tool_call_count, tool_result_bytes, input_tokens, output_tokens, total_tokens, usage_status, estimated_cost, cost_currency, cost_status, cancel_requested, lease_owner, lease_expires_at, revision, error_code, error_message, retryable, created_at, started_at, completed_at, updated_at) VALUES (@id, @requestId, @requestFingerprint, @sessionId, @question, @contextSnapshot, @contextHash, @subjects, 0, @asOf, @status, @phase, @outcome, @provider, @model, @modelFingerprint, @promptVersion, @toolVersion, @budget, @plan, @planHash, @evidenceHash, @report, @reportHash, @audit, @modelCalls, @toolCalls, @toolBytes, @inputTokens, @outputTokens, @totalTokens, @usageStatus, @estimatedCost, @costCurrency, @costStatus, @cancelRequested, @leaseOwner, @leaseExpiresAt, @revision, @errorCode, @errorMessage, @retryable, @createdAt, @startedAt, @completedAt, @updatedAt)'
    )
    const base = {
      sessionId, contextSnapshot, contextHash: hash(contextSnapshot), subjects, asOf: '20260730',
      provider: 'deepseek', model: 'deepseek-chat', modelFingerprint: hash('fixed-model'),
      promptVersion: 'single-agent.v1-controlled-network.v1', toolVersion: 'research-agent-tools.v2', budget,
      plan: null, planHash: null, evidenceHash: null, report: null, reportHash: null, audit: null,
      modelCalls: 0, toolCalls: 0, toolBytes: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
      usageStatus: 'not_started', estimatedCost: 0, costCurrency: null, costStatus: 'not_started',
      cancelRequested: 0, leaseOwner: null, leaseExpiresAt: null, revision: 0, errorCode: null,
      errorMessage: null, retryable: 0, startedAt: null, completedAt: null, updatedAt: now
    }
    insertRun.run({ ...base, id: process.env.EXPIRED_RUN_ID, requestId: '00000000-0000-4000-8000-000000003101', requestFingerprint: hash('expired'), question: '恢复中断的趋势与基本面深度研究运行并检查既有证据。', status: 'running', phase: 'tooling', outcome: null, leaseOwner: 'boot-crashed-e2e', leaseExpiresAt: now - 10000, revision: 3, createdAt: now - 30000, startedAt: now - 25000 })
    insertRun.run({ ...base, id: process.env.QUEUED_RUN_ID, requestId: '00000000-0000-4000-8000-000000003102', requestFingerprint: hash('queued'), question: '取消尚未开始的深度研究并确认不会产生任何调用。', status: 'queued', phase: 'planning', outcome: null, createdAt: now - 20000 })
    insertRun.run({ ...base, id: process.env.SUCCEEDED_RUN_ID, requestId: '00000000-0000-4000-8000-000000003103', requestFingerprint: hash('succeeded'), question: '回放已经完成的贵州茅台深度研究账本与审计证据。', status: 'succeeded', phase: 'persist', outcome: 'partial', plan, planHash: hash(plan), evidenceHash, report, reportHash: hash(report), audit: json(audit), modelCalls: 2, toolCalls: 1, toolBytes: 256, inputTokens: 320, outputTokens: 180, totalTokens: 500, usageStatus: 'complete', estimatedCost: 0.0012, costCurrency: 'CNY', costStatus: 'complete', revision: 12, createdAt: now - 10000, startedAt: now - 9000, completedAt: now - 1000 })
    insertRun.run({ ...base, id: process.env.NETWORK_RUN_ID, requestId: '00000000-0000-4000-8000-000000003104', requestFingerprint: hash('network-blocked'), question: '核验贵州茅台最新事件，展示本地缺口、联网查询、正文、失败和剩余未知项。', status: 'succeeded', phase: 'persist', outcome: 'blocked', plan, planHash: hash(plan), evidenceHash, report: networkReport, reportHash: hash(networkReport), audit: json(networkAudit), modelCalls: 2, toolCalls: 5, toolBytes: 4096, inputTokens: 260, outputTokens: 90, totalTokens: 350, usageStatus: 'complete', estimatedCost: 0.0009, costCurrency: 'CNY', costStatus: 'complete', revision: 18, createdAt: now - 15000, startedAt: now - 14000, completedAt: now - 700 })
    insertRun.run({ ...base, id: process.env.UNKNOWN_RUN_ID, requestId: '00000000-0000-4000-8000-000000003105', requestFingerprint: hash('network-unknown'), question: '验证联网请求提交后失联时禁止自动重放并保留费用未知状态。', status: 'needs_attention', phase: 'tooling', outcome: null, modelCalls: 1, toolCalls: 1, inputTokens: 120, outputTokens: 40, totalTokens: 160, usageStatus: 'partial', estimatedCost: 0, costCurrency: null, costStatus: 'unknown', revision: 8, errorCode: 'CALL_OUTCOME_UNKNOWN', errorMessage: '联网请求已提交但没有取得可验证完整响应', createdAt: now - 12000, startedAt: now - 11000 })

    const insertStep = db.prepare('INSERT INTO research_agent_steps (id, run_id, ordinal, kind, status, predecessor_step_id, input_json, input_sha256, output_sha256, artifact_json, attempt_count, revision, created_at, started_at, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 1, 2, ?, ?, ?, ?)')
    const stepIds = {}
    ;['planning', 'tooling', 'synthesis', 'audit', 'persist'].forEach((kind, index) => {
      const id = '00000000-0000-4000-8000-0000000032' + String(index + 1).padStart(2, '0')
      stepIds[kind] = id
      const input = json({ schemaVersion: 1, kind })
      const artifactValue = kind === 'planning' ? JSON.parse(plan) : kind === 'audit' ? { schemaVersion: 1, outcome: 'complete', evidenceContrast: evidence, audit } : { schemaVersion: 1, kind }
      const artifact = json(artifactValue)
      insertStep.run(id, process.env.SUCCEEDED_RUN_ID, index + 1, kind, 'succeeded', input, hash(input), hash(artifact), artifact, now - 9000 + index * 1000, now - 8500 + index * 1000, now - 8000 + index * 1000, now - 8000 + index * 1000)
    })
    const envelope = json({ toolId: 'stock.price_history', status: 'ready', asOf: '20260730', factDate: '20260730', data: { bars: 20 }, sources: [{ id: 'local.daily_close_cache' }], coverage: { requested: 20, available: 20 }, warnings: [] })
    const projection = json({ toolId: 'stock.price_history', status: 'ready', factDate: '20260730', data: { available: 20 } })
    const references = json(evidence.subjects[0].supporting)
    const insertTool = db.prepare('INSERT INTO research_agent_tool_calls (id, run_id, step_id, tool_id, attempt, input_json, input_sha256, as_of, status, envelope_json, envelope_sha256, model_projection_json, model_projection_sha256, stable_references_json, fact_date, sources_json, coverage_json, warnings_json, duration_ms, prepared_at, started_at, completed_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    insertTool.run('00000000-0000-4000-8000-000000003301', process.env.SUCCEEDED_RUN_ID, stepIds.tooling, 'stock.price_history', json({ stockCode: '600519', limit: 20 }), hash(json({ stockCode: '600519', limit: 20 })), '20260730', 'succeeded', envelope, hash(envelope), projection, hash(projection), references, '20260730', json([{ id: 'local.daily_close_cache' }]), json({ requested: 20, available: 20 }), '[]', 18, now - 7000, now - 6900, now - 6800, now - 6800)
    const insertModel = db.prepare('INSERT INTO research_agent_model_calls (id, run_id, step_id, purpose, attempt, status, provider, model, prompt_rule_version, input_messages_json, input_sha256, response_id, response_text, response_sha256, finish_reason, input_tokens, output_tokens, total_tokens, usage_status, price_snapshot_json, estimated_cost, cost_currency, prepared_at, submitted_at, completed_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const modelInput = json([{ role: 'user', content: '受控本地研究输入' }])
    const price = json({ version: 'e2e-v1', provider: 'deepseek', model: 'deepseek-chat', currency: 'CNY' })
    const planningResponse = json({ protocolVersion: 'single-agent.v1', action: 'plan' })
    insertModel.run('00000000-0000-4000-8000-000000003401', process.env.SUCCEEDED_RUN_ID, stepIds.planning, 'planning', 'succeeded', 'deepseek', 'deepseek-chat', 'single-agent.v1-controlled-network.v1', modelInput, hash(modelInput), 'e2e-plan', planningResponse, hash(planningResponse), 'stop', 140, 60, 200, 'complete', price, 0.0004, 'CNY', now - 9000, now - 8900, now - 8500, now - 8500)
    const synthesisResponse = json({ protocolVersion: 'single-agent.v1', action: 'finish', reportMarkdown: report })
    insertModel.run('00000000-0000-4000-8000-000000003402', process.env.SUCCEEDED_RUN_ID, stepIds.synthesis, 'synthesis', 'succeeded', 'deepseek', 'deepseek-chat', 'single-agent.v1-controlled-network.v1', modelInput, hash(modelInput), 'e2e-synthesis', synthesisResponse, hash(synthesisResponse), 'stop', 180, 120, 300, 'complete', price, 0.0008, 'CNY', now - 5000, now - 4900, now - 4500, now - 4500)

    const reviewBudget = json({
      id: 'multi-perspective-standard-v1', maxModelCalls: 3, maxToolCalls: 0,
      maxToolDecisionRounds: 0, maxToolsPerDecision: 0, maxModelInputBytes: 98304,
      maxIntermediateOutputTokens: 4096, maxFinalOutputTokens: 6144,
      maxToolResultBytes: 262144, maxToolProjectionBytes: 24576,
      maxRunToolResultBytes: 0, maxReportCharacters: 60000,
      maxModelCallDurationMs: 120000, maxToolCallDurationMs: 0,
      maxNetworkToolCallDurationMs: 0, maxDurationMs: 900000
    })
    const reviewContext = json({
      schemaVersion: 1,
      kind: 'multi_perspective_source',
      sourceRunId: process.env.SUCCEEDED_RUN_ID,
      sourceReportSha256: hash(report),
      sourceEvidenceSnapshotSha256: evidenceHash
    })
    const bull = {
      protocolVersion: 'multi-perspective.v1', action: 'position', role: 'bull',
      thesis: '本地趋势事实支持继续验证积极路径。',
      claims: [{ id: 'P1', statement: '价格事实已经固化并可追溯。', evidenceRefs: ['E-626F75C405'], confidence: 'medium' }],
      counterpoints: [{ statement: '基本面覆盖不足限制结论强度。', evidenceRefs: ['E-626F75C405'] }],
      unknowns: ['下一期财报与公告正文尚未进入底稿。'],
      verificationItems: ['核验下一期正式财务披露。'],
      rationale: '只使用父运行证据形成积极路径。'
    }
    const bear = {
      protocolVersion: 'multi-perspective.v1', action: 'position', role: 'bear',
      thesis: '单一趋势事实不足以排除基本面与事件风险。',
      claims: [{ id: 'P1', statement: '当前证据覆盖仍然有限。', evidenceRefs: ['E-626F75C405'], confidence: 'medium' }],
      counterpoints: [{ statement: '趋势事实可追溯但不能替代财务证据。', evidenceRefs: ['E-626F75C405'] }],
      unknowns: ['基本面和正式公告覆盖仍不完整。'],
      verificationItems: ['读取交易所公告正文并核对财务口径。'],
      rationale: '只使用父运行证据识别风险边界。'
    }
    const moderator = {
      protocolVersion: 'multi-perspective.v1', action: 'moderate', outcome: 'partial',
      conclusion: { statement: '价格趋势事实已经确认，但不足以支持更强外推。', evidenceRefs: ['E-626F75C405'] },
      consensus: [{ statement: '本地价格事实已经固化且可追溯。', evidenceRefs: ['E-626F75C405'] }],
      disagreements: [{ topic: '趋势事实的外推范围', bullPosition: '可继续验证积极路径。', bearPosition: '不足以排除基本面风险。', materiality: 'high', evidenceRefs: ['E-626F75C405'] }],
      unknowns: ['下一期财报与正式公告正文仍未知。'],
      verificationChecklist: [{ question: '下一期正式披露是否支持当前趋势判断？', reason: '解决事实外推分歧', preferredSource: '交易所公告正文' }],
      rationale: '保留分歧和未知项，不选择赢家。'
    }
    const quality = {
      schemaVersion: 1, sourceReportValidReferenceCount: 1, roleClaimCount: 2,
      roleCounterpointCount: 2, roleUniqueReferenceCount: 1, consensusCount: 1,
      disagreementCount: 1, unknownCount: 1, verificationCount: 1,
      invalidReferenceCount: 0, note: '结构质量只描述论证覆盖，不判断投资结论正确性。'
    }
    const reviewReport = '# 多视角研究复核\n\n## 中立结论\n价格趋势事实已经确认，但不足以支持更强外推。[E-626F75C405]\n\n## 已确认共识\n本地价格事实已经固化且可追溯。[E-626F75C405]\n\n## 核心分歧\n趋势事实的外推范围。\n\n## 剩余未知\n下一期财报与正式公告正文仍未知。\n\n## 验证清单\n核验下一期正式披露。'
    const reviewAudit = {
      schemaVersion: 1, documentKind: 'discussion', status: 'warning', generatedAt: now - 200,
      asOf: '20260730', originalTextSha256: hash(reviewReport.trim()), checkedCharacters: reviewReport.length,
      evidenceSummary: { subjectCount: 1, supporting: 1, challenging: 0, unknowns: 0 },
      checks: [{ code: 'UNKNOWN_DISCLOSED', status: 'passed', message: '未知项已披露', excerpts: [] }]
    }
    const reviewPlan = json({
      protocolVersion: 'multi-perspective.v1', action: 'review_plan',
      sourceRunId: process.env.SUCCEEDED_RUN_ID, evidenceSnapshotSha256: evidenceHash,
      roles: ['bull', 'bear', 'moderator'], modelCallLimit: 3, toolCallLimit: 0, asOf: '20260730'
    })
    insertRun.run({
      ...base,
      id: process.env.REVIEW_RUN_ID,
      requestId: '00000000-0000-4000-8000-000000003106',
      requestFingerprint: hash('multi-perspective-review'),
      question: '回放已经完成的贵州茅台深度研究账本与审计证据。',
      contextSnapshot: reviewContext,
      contextHash: hash(reviewContext),
      status: 'succeeded', phase: 'persist', outcome: 'partial',
      promptVersion: 'multi-perspective.v1-evidence-bound.v1',
      toolVersion: 'evidence-snapshot-only.v1', budget: reviewBudget,
      plan: reviewPlan, planHash: hash(reviewPlan), evidenceHash,
      report: reviewReport, reportHash: hash(reviewReport), audit: json(reviewAudit),
      modelCalls: 3, toolCalls: 0, toolBytes: 0,
      inputTokens: 210, outputTokens: 270, totalTokens: 480,
      usageStatus: 'complete', estimatedCost: 0.0015, costCurrency: 'CNY', costStatus: 'complete',
      revision: 16, createdAt: now - 600, startedAt: now - 550, completedAt: now - 100
    })
    db.prepare("UPDATE research_agent_runs SET run_kind = 'multi_perspective', parent_run_id = ? WHERE id = ?")
      .run(process.env.SUCCEEDED_RUN_ID, process.env.REVIEW_RUN_ID)

    const reviewStepArtifacts = [
      JSON.parse(reviewPlan),
      { schemaVersion: 1, sourceRunId: process.env.SUCCEEDED_RUN_ID, evidenceSnapshotSha256: evidenceHash, bull, bear },
      { schemaVersion: 1, sourceRunId: process.env.SUCCEEDED_RUN_ID, evidenceSnapshotSha256: evidenceHash, moderator },
      { schemaVersion: 1, outcome: 'partial', evidenceContrast: evidence, audit: reviewAudit, sourceRunId: process.env.SUCCEEDED_RUN_ID, sourceReportSha256: hash(report), evidenceSnapshotSha256: evidenceHash, bull, bear, moderator, quality, reportSha256: hash(reviewReport), originalReportSha256: hash(reviewReport) },
      { schemaVersion: 1, persistedToDiscussion: true }
    ]
    const reviewStepIds = {}
    ;['planning', 'tooling', 'synthesis', 'audit', 'persist'].forEach((kind, index) => {
      const id = '00000000-0000-4000-8000-0000000037' + String(index + 1).padStart(2, '0')
      reviewStepIds[kind] = id
      const input = json({ schemaVersion: 1, kind, sourceRunId: process.env.SUCCEEDED_RUN_ID, evidenceSnapshotSha256: evidenceHash })
      const artifact = json(reviewStepArtifacts[index])
      insertStep.run(id, process.env.REVIEW_RUN_ID, index + 1, kind, 'succeeded', input, hash(input), hash(artifact), artifact, now - 550 + index * 80, now - 540 + index * 80, now - 500 + index * 80, now - 500 + index * 80)
    })
    const roleModelInput = json([{ role: 'user', content: '绑定父运行不可变证据的角色输入' }])
    ;[
      ['00000000-0000-4000-8000-000000003711', reviewStepIds.tooling, 'bull_case', bull, 60, 70, 0.0004],
      ['00000000-0000-4000-8000-000000003712', reviewStepIds.tooling, 'bear_case', bear, 65, 75, 0.0005],
      ['00000000-0000-4000-8000-000000003713', reviewStepIds.synthesis, 'moderator', moderator, 85, 125, 0.0006]
    ].forEach(([id, stepId, purpose, response, inputTokens, outputTokens, cost], index) => {
      const responseText = json(response)
      insertModel.run(id, process.env.REVIEW_RUN_ID, stepId, purpose, 'succeeded', 'deepseek', 'deepseek-chat', 'multi-perspective.v1-evidence-bound.v1', roleModelInput, hash(roleModelInput), 'e2e-review-' + purpose, responseText, hash(responseText), 'stop', inputTokens, outputTokens, Number(inputTokens) + Number(outputTokens), 'complete', price, cost, 'CNY', now - 500 + index * 100, now - 490 + index * 100, now - 450 + index * 100, now - 450 + index * 100)
    })

    const networkStepIds = {
      planning: '00000000-0000-4000-8000-000000003501',
      local: '00000000-0000-4000-8000-000000003502',
      network: '00000000-0000-4000-8000-000000003503',
      synthesis: '00000000-0000-4000-8000-000000003504',
      audit: '00000000-0000-4000-8000-000000003505',
      persist: '00000000-0000-4000-8000-000000003506'
    }
    ;[
      ['planning', JSON.parse(plan)],
      ['tooling', { schemaVersion: 1, action: 'tool_batch', evidenceGate: localGate }],
      ['tooling', { schemaVersion: 1, action: 'tool_batch', evidenceGate: finalGate }],
      ['synthesis', { schemaVersion: 1, action: 'finish', outcome: 'blocked', evidenceGate: finalGate }],
      ['audit', { schemaVersion: 1, outcome: 'blocked', evidenceContrast: evidence, audit: networkAudit }],
      ['persist', { schemaVersion: 1, persistedToDiscussion: true }]
    ].forEach(([kind, artifactValue], index) => {
      const id = Object.values(networkStepIds)[index]
      const input = json({ schemaVersion: 1, kind, decisionRound: kind === 'tooling' ? index : undefined })
      const artifact = json(artifactValue)
      insertStep.run(id, process.env.NETWORK_RUN_ID, index + 1, kind, 'succeeded', input, hash(input), hash(artifact), artifact, now - 14000 + index * 1000, now - 13900 + index * 1000, now - 13500 + index * 1000, now - 13500 + index * 1000)
    })

    const makeNetworkEnvelope = (requestUrl, finalUrl, mimeKind, decodedBytes, tag) => ({
      version: 'research-agent-network.v2',
      request: { method: 'GET', url: requestUrl, headerNames: ['accept'], bodyBytes: 0, bodySha256: null },
      response: { finalUrl, statusCode: 200, contentType: mimeKind === 'html' ? 'text/html' : 'application/json', mimeKind, contentEncoding: 'identity', fetchedAt: now - 6000, compressedBytes: decodedBytes, decodedBytes, bodySha256: hash(tag + '-body') },
      hops: [{ url: requestUrl, resolvedAddresses: ['93.184.216.34'], statusCode: 200, redirectTo: requestUrl === finalUrl ? null : finalUrl }],
      envelopeSha256: hash(tag + '-envelope')
    })
    const localNewsEnvelope = json({ schemaVersion: 1, toolId: 'news.recent_briefings', status: 'ready', generatedAt: now - 12000, asOf: '20260730', sources: [{ id: 'local.briefings', status: 'ready', factDate: '20260730' }], coverage: { available: 3, required: 1, unit: 'briefings' }, warnings: ['本地资讯只有标题和摘要，不能替代正文。'], data: { items: [{ title: '贵州茅台近期事件标题' }] } })
    insertTool.run('00000000-0000-4000-8000-000000003601', process.env.NETWORK_RUN_ID, networkStepIds.local, 'news.recent_briefings', json({ query: '贵州茅台', limit: 10 }), hash(json({ query: '贵州茅台', limit: 10 })), '20260730', 'succeeded', localNewsEnvelope, hash(localNewsEnvelope), json({ toolId: 'news.recent_briefings', status: 'ready' }), hash(json({ toolId: 'news.recent_briefings', status: 'ready' })), '[]', '20260730', json([{ id: 'local.briefings', status: 'ready', factDate: '20260730' }]), json({ available: 3, required: 1, unit: 'briefings' }), json(['本地资讯只有标题和摘要，不能替代正文。']), 12, now - 12000, now - 11900, now - 11800, now - 11800)

    const searchCallId = '00000000-0000-4000-8000-000000003602'
    const searchInput = json({ query: '贵州茅台 最新事件 官方公告', maxResults: 6 })
    const searchEnvelope = json({ schemaVersion: 1, toolId: 'web.search', status: 'ready', generatedAt: now - 9000, asOf: '20260730', sources: [{ id: 'search.tavily', status: 'ready', factDate: '20260730' }], coverage: { available: 2, required: 1, unit: 'candidates' }, warnings: ['搜索标题、摘要与URL仅用于发现候选，不计为正文证据。'], data: { query: '贵州茅台 最新事件 官方公告', providerId: 'tavily', candidates: [{ candidateId: 'SRC-1111111111111111', searchCallId, title: '贵州茅台股份有限公司公告', url: 'https://www.cninfo.com.cn/new/disclosure/detail?id=600519&access_token=redacted-in-view', domain: 'www.cninfo.com.cn', snippet: '公司正式公告候选摘要。', publishedAt: '2026-07-30', sourceClass: 'official' }, { candidateId: 'SRC-2222222222222222', searchCallId, title: '市场媒体跟踪', url: 'https://news.example.com/maotai-event', domain: 'news.example.com', snippet: '二级来源候选摘要。', publishedAt: '2026-07-30', sourceClass: 'secondary' }], networkEnvelope: makeNetworkEnvelope('https://api.tavily.com/search', 'https://api.tavily.com/search', 'json', 1024, 'search') } })
    const searchProjection = json({ toolId: 'web.search', status: 'ready', data: { candidateCount: 2 } })
    insertTool.run(searchCallId, process.env.NETWORK_RUN_ID, networkStepIds.network, 'web.search', searchInput, hash(searchInput), '20260730', 'succeeded', searchEnvelope, hash(searchEnvelope), searchProjection, hash(searchProjection), '[]', '20260730', json([{ id: 'search.tavily', status: 'ready', factDate: '20260730' }]), json({ available: 2, required: 1, unit: 'candidates' }), json(['搜索标题、摘要与URL仅用于发现候选，不计为正文证据。']), 180, now - 10000, now - 9900, now - 9000, now - 9000)

    const excerpt = '贵州茅台股份有限公司发布正式公告，正文用于核验当前事件的事实边界、披露主体、发生日期与仍待确认的信息。该摘录只保存有限文本和哈希，不保存站点原始全文。'
    const documentInput = json({ candidateId: 'SRC-1111111111111111' })
    const documentEnvelope = json({ schemaVersion: 1, toolId: 'web.fetch_page', status: 'ready', generatedAt: now - 7000, asOf: '20260730', sources: [{ id: 'official.www.cninfo.com.cn', status: 'ready', factDate: '20260730' }], coverage: { available: 1, required: 1, unit: 'documents' }, warnings: [], data: { document: { candidateId: 'SRC-1111111111111111', title: '贵州茅台股份有限公司公告', finalUrl: 'https://www.cninfo.com.cn/new/disclosure/detail?id=600519', sourceDomain: 'www.cninfo.com.cn', sourceClass: 'official', primarySourceConfirmed: true, publishedAt: '2026-07-30', fetchedAt: now - 7000, excerpt, excerptTruncated: false, contentSha256: hash(excerpt), rawBodySha256: hash('document-raw'), mimeKind: 'html' }, networkEnvelope: makeNetworkEnvelope('https://www.cninfo.com.cn/new/disclosure/detail?id=600519', 'https://www.cninfo.com.cn/new/disclosure/detail?id=600519', 'html', 4096, 'document') } })
    const documentProjection = json({ toolId: 'web.fetch_page', status: 'ready', data: { title: '贵州茅台股份有限公司公告', excerpt } })
    insertTool.run('00000000-0000-4000-8000-000000003603', process.env.NETWORK_RUN_ID, networkStepIds.network, 'web.fetch_page', documentInput, hash(documentInput), '20260730', 'succeeded', documentEnvelope, hash(documentEnvelope), documentProjection, hash(documentProjection), '[]', '20260730', json([{ id: 'official.www.cninfo.com.cn', status: 'ready', factDate: '20260730' }]), json({ available: 1, required: 1, unit: 'documents' }), '[]', 220, now - 8000, now - 7900, now - 7000, now - 7000)

    const insertFailedTool = db.prepare('INSERT INTO research_agent_tool_calls (id, run_id, step_id, tool_id, attempt, input_json, input_sha256, as_of, status, stable_references_json, sources_json, coverage_json, warnings_json, duration_ms, error_code, error_message, prepared_at, submitted_at, completed_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const limitedInput = json({ query: '贵州茅台 2026 公告', stockCode: '600519.SH' })
    insertFailedTool.run('00000000-0000-4000-8000-000000003604', process.env.NETWORK_RUN_ID, networkStepIds.network, 'official.disclosure_search', limitedInput, hash(limitedInput), '20260730', 'failed', '[]', '[]', '{}', '[]', 90, 'NETWORK_RATE_LIMITED', '联网响应状态为429：上游限流', now - 6500, now - 6400, now - 6300, now - 6300)
    const offlineInput = json({ query: '贵州茅台 第二独立来源' })
    insertFailedTool.run('00000000-0000-4000-8000-000000003605', process.env.NETWORK_RUN_ID, networkStepIds.network, 'web.search', offlineInput, hash(offlineInput), '20260730', 'failed', '[]', '[]', '{}', '[]', 110, 'NETWORK_REQUEST_FAILED', '网络连接中断，未取得第二份独立来源', now - 6200, now - 6100, now - 6000, now - 6000)

    const unknownStepInput = json({ schemaVersion: 1, kind: 'tooling', decisionRound: 2 })
    insertStep.run('00000000-0000-4000-8000-000000003507', process.env.UNKNOWN_RUN_ID, 2, 'tooling', 'running', unknownStepInput, hash(unknownStepInput), null, null, now - 10000, now - 9900, null, now - 5000)
    const unknownInput = json({ candidateId: 'SRC-1111111111111111' })
    insertFailedTool.run('00000000-0000-4000-8000-000000003606', process.env.UNKNOWN_RUN_ID, '00000000-0000-4000-8000-000000003507', 'web.fetch_page', unknownInput, hash(unknownInput), '20260730', 'outcome_unknown', '[]', '[]', '{}', '[]', 120000, 'NETWORK_REQUEST_FAILED', '请求已提交但连接在响应完成前中断', now - 9000, now - 8900, now - 5000, now - 5000)
    db.prepare('UPDATE ai_analysis_sessions SET messages = ? WHERE id = ?').run(json([
      { role: 'user', content: '核验贵州茅台最新事件。', researchAgentRunId: process.env.NETWORK_RUN_ID },
      { role: 'assistant', content: networkReport, researchAgentRunId: process.env.NETWORK_RUN_ID }
    ]), sessionId)
    db.close()
    process.stdout.write(JSON.stringify({ sessionId }))
  `, {
    TRADE_WATCH_SEED_DB: dbPath,
    EXPIRED_RUN_ID,
    QUEUED_RUN_ID,
    SUCCEEDED_RUN_ID,
    NETWORK_RUN_ID,
    UNKNOWN_RUN_ID,
    REVIEW_RUN_ID,
  })
  return JSON.parse(output) as { sessionId: number }
}

function seedRetryReplay(dbPath: string): void {
  runElectronScript(String.raw`
    const Database = require('better-sqlite3')
    const { createHash } = require('crypto')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    const source = db.prepare('SELECT * FROM research_agent_runs WHERE id = ?').get(process.env.UNKNOWN_RUN_ID)
    const now = Date.now()
    const budget = JSON.stringify({
      id: 'single-agent-unrestricted-v3', maxModelCalls: null, maxToolCalls: null,
      maxToolDecisionRounds: null, maxToolsPerDecision: 2, maxModelInputBytes: 98304,
      maxIntermediateOutputTokens: null, maxFinalOutputTokens: null,
      maxToolResultBytes: 262144, maxToolProjectionBytes: 24576,
      maxRunToolResultBytes: 16777216, maxReportCharacters: null,
      maxModelCallDurationMs: null, maxToolCallDurationMs: 10000,
      maxNetworkToolCallDurationMs: 120000, maxDurationMs: null
    })
    const clone = {
      ...source,
      id: process.env.RETRY_RUN_ID,
      request_id: process.env.RETRY_REQUEST_ID,
      request_fingerprint: createHash('sha256').update('e2e-retry-replay').digest('hex'),
      run_kind: 'single_agent',
      parent_run_id: process.env.UNKNOWN_RUN_ID,
      status: 'queued', phase: 'planning', outcome: null, budget_json: budget,
      plan_json: null, plan_sha256: null, evidence_snapshot_sha256: null,
      report_markdown: null, report_sha256: null, audit_json: null,
      model_call_count: 0, tool_call_count: 0, tool_result_bytes: 0,
      input_tokens: 0, output_tokens: 0, total_tokens: 0,
      usage_status: 'not_started', estimated_cost: 0, cost_currency: null, cost_status: 'not_started',
      cancel_requested: 0, lease_owner: null, lease_expires_at: null, revision: 0,
      error_code: null, error_message: null, retryable: 0,
      created_at: now, started_at: null, completed_at: null, updated_at: now
    }
    const columns = db.prepare('PRAGMA table_info(research_agent_runs)').all().map((column) => column.name)
    const names = columns.map((name) => '"' + name + '"').join(', ')
    const values = columns.map((name) => '@' + name).join(', ')
    db.prepare('INSERT INTO research_agent_runs (' + names + ') VALUES (' + values + ')').run(clone)
    db.close()
  `, { TRADE_WATCH_SEED_DB: dbPath, UNKNOWN_RUN_ID, RETRY_RUN_ID, RETRY_REQUEST_ID })
}

function readDiscussionMessages(dbPath: string, sessionId: number): Array<{ researchAgentRunId?: string }> {
  const output = runElectronScript(String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB, { readonly: true })
    const row = db.prepare('SELECT messages FROM ai_analysis_sessions WHERE id = ?').get(Number(process.env.SESSION_ID))
    db.close()
    process.stdout.write(row?.messages || '[]')
  `, { TRADE_WATCH_SEED_DB: dbPath, SESSION_ID: String(sessionId) })
  return JSON.parse(output) as Array<{ researchAgentRunId?: string }>
}

function readMutableRunState(dbPath: string): Record<string, { status: string; modelCalls: number; toolCalls: number }> {
  const output = runElectronScript(String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB, { readonly: true })
    const rows = db.prepare('SELECT id, status, model_call_count AS modelCalls, tool_call_count AS toolCalls FROM research_agent_runs WHERE id IN (?, ?, ?, ?, ?) ORDER BY id').all(process.env.EXPIRED_RUN_ID, process.env.QUEUED_RUN_ID, process.env.REVIEW_RUN_ID, process.env.NETWORK_RUN_ID, process.env.RETRY_RUN_ID)
    db.close()
    process.stdout.write(JSON.stringify(Object.fromEntries(rows.map((row) => [row.id, row]))))
  `, { TRADE_WATCH_SEED_DB: dbPath, EXPIRED_RUN_ID, QUEUED_RUN_ID, REVIEW_RUN_ID, NETWORK_RUN_ID, RETRY_RUN_ID })
  return JSON.parse(output) as Record<string, { status: string; modelCalls: number; toolCalls: number }>
}

async function openDiscussion(window: Page, sessionId: number): Promise<void> {
  await window.waitForLoadState('domcontentloaded')
  const coldStartGuide = window.locator('[data-testid="cold-start-guide"]')
  if (await coldStartGuide.isVisible()) await coldStartGuide.getByLabel('关闭引导').click()
  const recordsEntry = window.getByTestId('secondary-nav-ai-analysis-records')
  if (!await recordsEntry.isVisible()) await window.getByTestId('nav-tab-ai-analysis').click()
  await recordsEntry.click()
  await window.getByTestId(`ai-session-${sessionId}`).click()
  await expect(window.getByTestId('research-agent-panel')).toBeVisible({ timeout: 15_000 })
}

async function openDeepResearch(window: Page): Promise<void> {
  await window.waitForLoadState('domcontentloaded')
  const coldStartGuide = window.locator('[data-testid="cold-start-guide"]')
  if (await coldStartGuide.isVisible()) await coldStartGuide.getByLabel('关闭引导').click()
  const deepResearchEntry = window.getByTestId('secondary-nav-ai-analysis-deepResearch')
  if (!await deepResearchEntry.isVisible()) await window.getByTestId('nav-tab-ai-analysis').click()
  await expect(deepResearchEntry).toHaveText('深度研究')
  await deepResearchEntry.click()
  await expect(window.getByTestId('deep-research-workbench')).toBeVisible({ timeout: 15_000 })
}

test('单 Agent 研究账本可跨重启恢复、显式继续和取消且不产生真实调用', async () => {
  test.setTimeout(120_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-research-agent-e2e-'))
  const dbPath = join(`${userDataDir}-dev`, 'trade-watch.db')
  const screenshotDir = join(process.cwd(), 'test-results', 'research-agent')
  mkdirSync(screenshotDir, { recursive: true })
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    await expect(window.getByText('RT-ResearchFlow')).toBeVisible({ timeout: 15_000 })
    await app.close()

    const fixture = seedResearchAgentFixture(dbPath)
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    const windowContract = await app.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]
      return mainWindow ? {
        size: mainWindow.getSize(),
        maximizable: mainWindow.isMaximizable(),
        manualResizeGuardCount: mainWindow.listenerCount('will-resize'),
      } : null
    })
    expect(windowContract).toEqual({ size: [1680, 960], maximizable: true, manualResizeGuardCount: 1 })

    await openDeepResearch(window)
    const workbench = window.getByTestId('deep-research-workbench')
    const progressBand = workbench.getByTestId('deep-research-progress')
    await expect(progressBand).toContainText('深度研究等待启动')
    await app.evaluate(({ BrowserWindow }, event) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('researchAgent:progress', event)
    }, {
      runId: QUEUED_RUN_ID,
      status: 'running',
      phase: 'tooling',
      stepOrdinal: 2,
      message: '正在核验本地事实与联网缺口',
      revision: 2,
      modelCalls: { completed: 1, maximum: 6 },
      toolCalls: { completed: 2, maximum: 8 },
      usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160, completeness: 'complete' },
      updatedAt: Date.now(),
    })
    await expect(progressBand).toContainText('深度研究进行中')
    await expect(progressBand).toContainText('正在核验本地事实与联网缺口')
    await expect(progressBand.getByLabel('当前阶段：取证')).toBeVisible()
    await expect(progressBand).toContainText('模型 1/6')
    await expect(progressBand).toContainText('工具 2/8')
    const completedSingleRow = workbench.getByTestId(`deep-research-run-${SUCCEEDED_RUN_ID}`)
    const completedReviewRow = workbench.getByTestId(`deep-research-run-${REVIEW_RUN_ID}`)
    await expect(completedSingleRow).toBeVisible()
    await expect(completedSingleRow).toContainText('已完成')
    await expect(completedSingleRow).toContainText('结论覆盖受限')
    await expect(completedSingleRow).not.toContainText('部分完成')
    await expect(completedReviewRow).toContainText('已完成')
    await expect(completedReviewRow).toContainText('结论覆盖受限')
    await expect(completedReviewRow).not.toContainText('部分完成')
    await workbench.getByTestId(`deep-research-run-${SUCCEEDED_RUN_ID}`).click()
    await expect(workbench.getByText('深度研究报告', { exact: true })).toBeVisible()
    const activeFilter = workbench.getByRole('button', { name: '进行中', exact: true })
    await activeFilter.click()
    await expect(workbench.getByTestId(`deep-research-run-${SUCCEEDED_RUN_ID}`)).toHaveCount(0)
    await expect(workbench).toContainText('结果与费用均可能未知')
    await workbench.getByRole('button', { name: '全部', exact: true }).click()

    await workbench.getByTestId('deep-research-start').click()
    const directDialog = window.getByRole('dialog', { name: '开始深度研究' })
    await expect(directDialog).toBeVisible()
    await expect(directDialog.getByRole('textbox', { name: '研究问题' })).toBeFocused()
    await expect(directDialog).toContainText('请先在 AI 配置中提供可用的固定厂商、模型和凭据')
    await directDialog.getByRole('textbox', { name: '研究问题' }).fill('核验贵州茅台趋势、基本面和最新正式披露是否相互印证。')
    await directDialog.getByRole('textbox', { name: '股票代码' }).fill('600519')
    await expect(directDialog).toContainText('已确认 1/5')
    await expect(directDialog.getByTestId('direct-research-submit')).toBeDisabled()
    await directDialog.getByRole('button', { name: '产业项目', exact: true }).click()
    const projectCombobox = directDialog.getByRole('combobox', { name: '产业研究项目' })
    await expect(projectCombobox).toContainText('暂无产业研究项目')
    await projectCombobox.click()
    const projectListbox = directDialog.getByRole('listbox', { name: '产业研究项目选项' })
    await expect(projectListbox).toBeVisible()
    await expect(projectListbox).toContainText('没有匹配项')
    await window.screenshot({ path: join(screenshotDir, 'direct-entry-project-combobox-open-1680x960-light.png'), fullPage: false })
    await projectCombobox.click()
    await directDialog.getByRole('button', { name: 'A股', exact: true }).click()
    expect(await directDialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await window.screenshot({ path: join(screenshotDir, 'direct-entry-default-1680x960-light.png'), fullPage: false })
    await directDialog.getByRole('button', { name: '打开 AI 配置' }).click()
    const configDrawer = window.getByTestId('config-drawer')
    await expect(configDrawer).toBeVisible()
    await expect(configDrawer.getByTestId('config-tab-ai-config')).toHaveText('AI配置')
    await configDrawer.getByLabel('关闭配置抽屉').click()

    await window.evaluate(() => window.api.windowControls.toggleMaximize())
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false)).toBe(true)
    await window.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    await workbench.getByTestId('deep-research-start').click()
    const maximizedDirectDialog = window.getByRole('dialog', { name: '开始深度研究' })
    await maximizedDirectDialog.getByRole('button', { name: '产业项目', exact: true }).click()
    const maximizedProjectCombobox = maximizedDirectDialog.getByRole('combobox', { name: '产业研究项目' })
    await maximizedProjectCombobox.click()
    await expect(maximizedDirectDialog.getByRole('listbox', { name: '产业研究项目选项' })).toBeVisible()
    expect(await maximizedDirectDialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await window.screenshot({ path: join(screenshotDir, 'direct-entry-project-combobox-open-maximized-dark-reduced.png'), fullPage: false })
    await maximizedDirectDialog.getByRole('button', { name: '关闭', exact: true }).click()
    await workbench.getByTestId(`deep-research-run-${UNKNOWN_RUN_ID}`).click()
    await expect(workbench).toContainText('结果与费用均可能未知')
    expect(await workbench.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await window.screenshot({ path: join(screenshotDir, 'global-ledger-maximized-dark-reduced.png'), fullPage: false })
    await window.evaluate(() => window.api.windowControls.toggleMaximize())
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false)).toBe(false)
    await window.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' })
    await window.evaluate(() => document.documentElement.classList.remove('dark'))

    await openDiscussion(window, fixture.sessionId)

    await window.getByTestId('research-agent-open').click()
    const startDialog = window.getByRole('dialog', { name: '开始深度研究' })
    await expect(startDialog.getByTestId('research-agent-evidence-policy')).toContainText('行情与财务受控补证可用')
    expect(await startDialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await window.screenshot({ path: join(screenshotDir, 'preflight-evidence-gate-default-light.png'), fullPage: false })
    await startDialog.getByRole('button', { name: '关闭', exact: true }).click()

    await window.getByTestId(`research-agent-run-${SUCCEEDED_RUN_ID}`).click()
    await expect(window.getByText('深度研究报告', { exact: true })).toBeVisible()
    await expect(window.getByTestId('research-agent-execution-status')).toContainText('执行状态：已完成')
    await expect(window.getByTestId('research-agent-conclusion-coverage')).toContainText('结论覆盖：受限')
    await expect(window.getByTestId('research-agent-conclusion-explanation')).toContainText('研究流程已完整执行')
    await expect(window.getByTestId('research-agent-panel')).not.toContainText('部分完成')
    await window.getByTestId('research-agent-evidence-tab').click()
    await expect(window.getByTestId('research-agent-panel')).toContainText('结论覆盖')
    await expect(window.getByTestId('research-agent-panel')).toContainText('受限')
    await window.getByTestId('research-agent-plan').getByText('研究计划').click()
    await expect(window.getByText('趋势与基本面是否背离？')).toBeVisible()
    await window.getByTestId('research-agent-local-evidence').getByText('本地证据覆盖').click()
    await expect(window.getByText('stock.price_history', { exact: true })).toBeVisible()
    await window.getByText('步骤与证据账本').click()
    await expect(window.getByTestId('research-agent-model-calls')).toContainText('200 tokens')
    await expect(window.getByTestId('research-agent-model-calls')).toContainText('300 tokens')
    await expect(window.getByTestId('research-audit-trace')).toContainText('存在审计警告')
    expect(await window.getByTestId('ai-analysis-page').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await window.screenshot({ path: join(screenshotDir, 'completed-default-light.png'), fullPage: false })

    await window.getByTestId('research-agent-start-review').click()
    const reviewDialog = window.getByTestId('research-agent-review-dialog')
    await expect(reviewDialog).toContainText('多方与空方')
    await expect(reviewDialog).toContainText('中立主持')
    await expect(reviewDialog).toContainText('模型调用按研究需要')
    await expect(reviewDialog).toContainText('至少完成两轮交锋')
    await expect(reviewDialog).toContainText('不会再次联网')
    await reviewDialog.getByRole('button', { name: '取消' }).click()

    await window.getByTestId(`research-agent-run-${REVIEW_RUN_ID}`).click()
    await expect(window.getByTestId('research-agent-execution-status')).toContainText('执行状态：已完成')
    await expect(window.getByTestId('research-agent-conclusion-coverage')).toContainText('结论覆盖：受限')
    await expect(window.getByTestId('research-agent-conclusion-explanation')).toContainText('多视角复核已完整执行')
    await expect(window.getByTestId('research-agent-conclusion-explanation')).toContainText('仍有1项关键事实需要补证')
    const multiPerspective = window.getByTestId('research-agent-multi-perspective')
    await expect(multiPerspective).not.toContainText('零次重新取数')
    await expect(window.getByTestId('research-agent-bull')).toContainText('积极路径')
    await expect(window.getByTestId('research-agent-bear')).toContainText('不足以排除基本面')
    await expect(window.getByTestId('research-agent-consensus')).toContainText('本地价格事实已经固化')
    await expect(window.getByTestId('research-agent-disagreements')).toContainText('趋势事实的外推范围')
    await expect(window.getByTestId('research-agent-unknowns')).toContainText('正式公告正文仍未知')
    await expect(window.getByTestId('research-agent-verification-checklist')).toContainText('下一期正式披露')
    await expect(window.getByTestId('research-agent-panel').getByText('0/0', { exact: true })).toBeHidden()
    await window.getByTestId('research-agent-evidence-tab').click()
    await expect(window.getByTestId('research-agent-multi-perspective-evidence')).toContainText('零次重新取数')
    await expect(window.getByTestId('research-agent-quality-summary')).toContainText('结构质量对比')
    await expect(window.getByTestId('research-agent-panel').getByText('0/0', { exact: true })).toBeVisible()
    expect(await window.getByTestId('ai-analysis-page').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await window.screenshot({ path: join(screenshotDir, 'multi-perspective-default-light.png'), fullPage: false })

    await window.getByTestId(`research-agent-run-${NETWORK_RUN_ID}`).click()
    await window.getByTestId('research-agent-evidence-tab').click()
    const evidenceOverview = window.getByTestId('research-agent-evidence-overview')
    await expect(evidenceOverview).toContainText('完整结论已阻断')
    await expect(evidenceOverview).toContainText('为什么需要联网')
    await expect(evidenceOverview).toContainText('本地资讯标题不能支撑时效性结论')
    await expect(window.getByTestId('research-agent-coverage-metrics')).toContainText('1 次')
    await expect(window.getByTestId('research-agent-coverage-metrics')).toContainText('4 次')
    await expect(window.getByTestId('research-agent-coverage-metrics')).toContainText('2 项')
    await expect(window.getByTestId('research-agent-coverage-metrics')).toContainText('1 份')
    const networkEvidence = window.getByTestId('research-agent-network-evidence')
    await expect(networkEvidence).toContainText('贵州茅台 最新事件 官方公告')
    await expect(window.getByTestId('research-agent-search-candidates')).toContainText('贵州茅台股份有限公司公告')
    await expect(window.getByTestId('research-agent-search-candidates')).toContainText('access_token=%5BREDACTED%5D')
    await expect(window.getByTestId('research-agent-document')).toContainText('正文用于核验当前事件的事实边界')
    await expect(window.getByTestId('research-agent-network-envelope').first()).toContainText('HTTP 200')
    await expect(networkEvidence).toContainText('上游限流')
    await expect(networkEvidence).toContainText('网络连接中断')
    await expect(window.getByTestId('research-agent-remaining-unknowns')).toContainText('仍缺少第二份独立正文样本')
    await expect(window.getByTestId('research-agent-panel')).toContainText('0.0009 CNY')
    expect(await window.getByTestId('ai-analysis-page').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await window.getByTestId('research-agent-document').scrollIntoViewIfNeeded()
    await window.screenshot({ path: join(screenshotDir, 'network-evidence-default-light.png'), fullPage: false })

    await window.evaluate(() => window.api.windowControls.toggleMaximize())
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false)).toBe(true)
    await window.emulateMedia({ reducedMotion: 'reduce' })
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    await window.getByTestId(`research-agent-run-${UNKNOWN_RUN_ID}`).click()
    await expect(window.getByTestId('research-agent-panel')).toContainText('需处理')
    await expect(window.getByTestId('research-agent-panel')).toContainText('结果与费用均可能未知')
    await expect(window.getByTestId('research-agent-panel').getByRole('button', { name: '继续', exact: true })).toHaveCount(0)
    expect(await window.getByTestId('ai-analysis-page').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await window.screenshot({ path: join(screenshotDir, 'network-unknown-maximized-dark-reduced.png'), fullPage: false })

    await window.getByTestId(`research-agent-run-${EXPIRED_RUN_ID}`).click()
    await expect(window.getByTestId('research-agent-panel')).toContainText('已暂停')
    await window.getByRole('button', { name: '继续', exact: true }).click()
    await expect(window.getByTestId('research-agent-panel')).toContainText('固定模型凭据当前不可用', { timeout: 15_000 })

    await window.getByTestId(`research-agent-run-${QUEUED_RUN_ID}`).click()
    await window.getByRole('button', { name: '取消', exact: true }).click()
    const cancelDialog = window.getByTestId('research-agent-cancel-dialog')
    await expect(cancelDialog).toContainText('取消会终止后续模型和事实调用')
    await cancelDialog.getByRole('button', { name: '确认取消' }).click()
    await expect(window.getByTestId('research-agent-panel')).toContainText('已取消')
    expect(await window.getByTestId('ai-analysis-page').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await window.screenshot({ path: join(screenshotDir, 'recovery-maximized-dark-reduced.png'), fullPage: false })

    await openDeepResearch(window)
    seedRetryReplay(dbPath)
    await window.evaluate((requestId) => {
      Object.defineProperty(window.crypto, 'randomUUID', { configurable: true, value: () => requestId })
    }, RETRY_REQUEST_ID)
    await workbench.getByTestId(`deep-research-run-${UNKNOWN_RUN_ID}`).click()
    await workbench.getByTestId('research-agent-retry').click()
    const retryDialog = window.getByTestId('deep-research-retry-dialog')
    await expect(retryDialog).toContainText('可能产生重复费用')
    await retryDialog.getByRole('button', { name: '重新研究' }).click()
    await expect(workbench.getByTestId(`deep-research-run-${RETRY_RUN_ID}`)).toBeVisible()
    await expect(workbench.getByTestId('deep-research-progress')).toContainText('新运行已创建，正在等待主进程规划')
    await expect(workbench).toContainText('模型 0')
    await window.evaluate(() => { delete (window.crypto as unknown as Record<string, unknown>).randomUUID })

    await workbench.getByTestId(`deep-research-run-${NETWORK_RUN_ID}`).click()
    await workbench.getByTestId('research-agent-delete').click()
    const deleteDialog = window.getByTestId('deep-research-delete-dialog')
    await expect(deleteDialog).toContainText('只删除当前选中的研究记录')
    await expect(deleteDialog).toContainText('其他重试记录会保留')
    await deleteDialog.getByRole('button', { name: '确认删除' }).click()
    await expect(workbench.getByTestId(`deep-research-run-${NETWORK_RUN_ID}`)).toHaveCount(0)
    expect(readDiscussionMessages(dbPath, fixture.sessionId).some((message) => message.researchAgentRunId === NETWORK_RUN_ID)).toBe(false)

    await app.close()
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await openDeepResearch(window)
    await window.getByTestId(`deep-research-run-${SUCCEEDED_RUN_ID}`).click()
    await expect(window.getByText('深度研究报告', { exact: true })).toBeVisible()
    expect(await window.getByTestId('deep-research-workbench').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await openDiscussion(window, fixture.sessionId)
    await window.getByTestId(`research-agent-run-${EXPIRED_RUN_ID}`).click()
    await expect(window.getByTestId('research-agent-panel')).toContainText('固定模型凭据当前不可用')
    await window.getByTestId(`research-agent-run-${QUEUED_RUN_ID}`).click()
    await expect(window.getByTestId('research-agent-panel')).toContainText('已取消')
    await expect(window.getByTestId(`research-agent-run-${NETWORK_RUN_ID}`)).toHaveCount(0)
    await window.getByTestId(`research-agent-run-${UNKNOWN_RUN_ID}`).click()
    await expect(window.getByTestId('research-agent-panel')).toContainText('结果与费用均可能未知')
    await window.emulateMedia({ reducedMotion: 'reduce' })
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    await window.getByTestId(`research-agent-run-${REVIEW_RUN_ID}`).click()
    await expect(window.getByTestId('research-agent-multi-perspective')).toContainText('趋势事实的外推范围')
    await window.getByTestId('research-agent-evidence-tab').click()
    await expect(window.getByTestId('research-agent-quality-summary')).toContainText('验证事项')
    await window.getByTestId('research-agent-quality-summary').scrollIntoViewIfNeeded()
    expect(await window.getByTestId('ai-analysis-page').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await window.screenshot({ path: join(screenshotDir, 'multi-perspective-replay-default-dark-reduced.png'), fullPage: false })

    const state = readMutableRunState(dbPath)
    expect(state[EXPIRED_RUN_ID]).toEqual(expect.objectContaining({ status: 'failed', modelCalls: 0, toolCalls: 0 }))
    expect(state[QUEUED_RUN_ID]).toEqual(expect.objectContaining({ status: 'cancelled', modelCalls: 0, toolCalls: 0 }))
    expect(state[REVIEW_RUN_ID]).toEqual(expect.objectContaining({ status: 'succeeded', modelCalls: 3, toolCalls: 0 }))
    expect(state[RETRY_RUN_ID]).toEqual(expect.objectContaining({ status: 'queued', modelCalls: 0, toolCalls: 0 }))
    expect(state[NETWORK_RUN_ID]).toBeUndefined()
  } finally {
    await app.close().catch(() => undefined)
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
