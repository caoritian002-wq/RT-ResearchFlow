import type Database from 'better-sqlite3'
import type {
  AiEvaluationAggregate,
  AiEvaluationCaseScore,
  AiEvaluationConclusion,
  AiEvaluationDimension,
} from '../services/aiEvaluationSuite'

export type AiEvaluationRunStatus = 'running' | 'completed' | 'failed'

export interface AiEvaluationRunRecord {
  id: number
  suiteId: string
  suiteVersion: string
  suiteFingerprint: string
  provider: string
  model: string
  businessPromptFingerprint: string
  evaluationPromptFingerprint: string
  status: AiEvaluationRunStatus
  progressCurrent: number
  progressTotal: number
  currentCaseId: string | null
  totalScore: number | null
  conclusion: AiEvaluationConclusion | null
  dimensionScores: Record<AiEvaluationDimension, number | null> | null
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  errorMessage: string | null
  startedAt: number
  completedAt: number | null
  createdAt: number
}

export interface AiEvaluationCaseResultRecord {
  runId: number
  caseId: string
  title: string
  kind: 'round1' | 'round2'
  status: AiEvaluationConclusion
  score: number
  rules: AiEvaluationCaseScore['rules']
  responseText: string
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  errorMessage: string | null
  completedAt: number
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== 'string' || !value) return null
  try { return JSON.parse(value) as T } catch { return null }
}

function mapRun(row: Record<string, unknown>): AiEvaluationRunRecord {
  return {
    id: row.id as number,
    suiteId: row.suite_id as string,
    suiteVersion: row.suite_version as string,
    suiteFingerprint: row.suite_fingerprint as string,
    provider: row.provider as string,
    model: row.model as string,
    businessPromptFingerprint: row.business_prompt_fingerprint as string,
    evaluationPromptFingerprint: row.evaluation_prompt_fingerprint as string,
    status: row.status as AiEvaluationRunStatus,
    progressCurrent: row.progress_current as number,
    progressTotal: row.progress_total as number,
    currentCaseId: (row.current_case_id as string | null) ?? null,
    totalScore: nullableNumber(row.total_score),
    conclusion: (row.conclusion as AiEvaluationConclusion | null) ?? null,
    dimensionScores: parseJson<Record<AiEvaluationDimension, number | null>>(row.dimension_scores_json),
    inputTokens: nullableNumber(row.input_tokens),
    outputTokens: nullableNumber(row.output_tokens),
    totalTokens: nullableNumber(row.total_tokens),
    errorMessage: (row.error_message as string | null) ?? null,
    startedAt: row.started_at as number,
    completedAt: nullableNumber(row.completed_at),
    createdAt: row.created_at as number,
  }
}

function mapCase(row: Record<string, unknown>): AiEvaluationCaseResultRecord {
  return {
    runId: row.run_id as number,
    caseId: row.case_id as string,
    title: row.title as string,
    kind: row.kind as 'round1' | 'round2',
    status: row.status as AiEvaluationConclusion,
    score: row.score as number,
    rules: parseJson<AiEvaluationCaseScore['rules']>(row.rules_json) ?? [],
    responseText: row.response_text as string,
    inputTokens: nullableNumber(row.input_tokens),
    outputTokens: nullableNumber(row.output_tokens),
    totalTokens: nullableNumber(row.total_tokens),
    errorMessage: (row.error_message as string | null) ?? null,
    completedAt: row.completed_at as number,
  }
}

export function createAiEvaluationRun(db: Database.Database, input: {
  suiteId: string
  suiteVersion: string
  suiteFingerprint: string
  provider: string
  model: string
  businessPromptFingerprint: string
  evaluationPromptFingerprint: string
  progressTotal: number
  now?: number
}): number {
  const now = input.now ?? Date.now()
  const info = db.prepare(`
    INSERT INTO ai_evaluation_runs (
      suite_id, suite_version, suite_fingerprint, provider, model,
      business_prompt_fingerprint, evaluation_prompt_fingerprint,
      status, progress_current, progress_total, current_case_id,
      started_at, completed_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', 0, ?, NULL, ?, NULL, ?)
  `).run(
    input.suiteId,
    input.suiteVersion,
    input.suiteFingerprint,
    input.provider,
    input.model,
    input.businessPromptFingerprint,
    input.evaluationPromptFingerprint,
    input.progressTotal,
    now,
    now,
  )
  return Number(info.lastInsertRowid)
}

export function getActiveAiEvaluationRun(db: Database.Database): AiEvaluationRunRecord | null {
  const row = db.prepare("SELECT * FROM ai_evaluation_runs WHERE status = 'running' ORDER BY id DESC LIMIT 1").get() as Record<string, unknown> | undefined
  return row ? mapRun(row) : null
}

export function getAiEvaluationRun(db: Database.Database, runId: number): AiEvaluationRunRecord | null {
  const row = db.prepare('SELECT * FROM ai_evaluation_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined
  return row ? mapRun(row) : null
}

export function listAiEvaluationRuns(db: Database.Database, limit = 20): AiEvaluationRunRecord[] {
  const rows = db.prepare('SELECT * FROM ai_evaluation_runs ORDER BY created_at DESC, id DESC LIMIT ?').all(Math.max(1, Math.min(100, limit))) as Record<string, unknown>[]
  return rows.map(mapRun)
}

export function listAiEvaluationCaseResults(db: Database.Database, runId: number): AiEvaluationCaseResultRecord[] {
  const rows = db.prepare('SELECT * FROM ai_evaluation_case_results WHERE run_id = ? ORDER BY completed_at ASC, case_id ASC').all(runId) as Record<string, unknown>[]
  return rows.map(mapCase)
}

export function updateAiEvaluationProgress(
  db: Database.Database,
  runId: number,
  progressCurrent: number,
  currentCaseId: string | null,
): void {
  db.prepare(`
    UPDATE ai_evaluation_runs
    SET progress_current = ?, current_case_id = ?
    WHERE id = ? AND status = 'running'
  `).run(progressCurrent, currentCaseId, runId)
}

export function saveAiEvaluationCaseResult(db: Database.Database, input: {
  runId: number
  result: AiEvaluationCaseScore
  responseText: string
  inputTokens?: number | null
  outputTokens?: number | null
  totalTokens?: number | null
  errorMessage?: string | null
  completedAt?: number
}): void {
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT OR REPLACE INTO ai_evaluation_case_results (
        run_id, case_id, title, kind, status, score, rules_json, response_text,
        input_tokens, output_tokens, total_tokens, error_message, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.runId,
      input.result.caseId,
      input.result.title,
      input.result.kind,
      input.result.conclusion,
      input.result.score,
      JSON.stringify(input.result.rules),
      input.responseText,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.totalTokens ?? null,
      input.errorMessage ?? null,
      input.completedAt ?? Date.now(),
    )
    db.prepare(`
      UPDATE ai_evaluation_runs SET
        input_tokens = CASE
          WHEN input_tokens IS NULL AND ? IS NULL THEN NULL
          ELSE COALESCE(input_tokens, 0) + COALESCE(?, 0)
        END,
        output_tokens = CASE
          WHEN output_tokens IS NULL AND ? IS NULL THEN NULL
          ELSE COALESCE(output_tokens, 0) + COALESCE(?, 0)
        END,
        total_tokens = CASE
          WHEN total_tokens IS NULL AND ? IS NULL THEN NULL
          ELSE COALESCE(total_tokens, 0) + COALESCE(?, 0)
        END
      WHERE id = ? AND status = 'running'
    `).run(
      input.inputTokens ?? null, input.inputTokens ?? null,
      input.outputTokens ?? null, input.outputTokens ?? null,
      input.totalTokens ?? null, input.totalTokens ?? null,
      input.runId,
    )
  })
  tx()
}

export function completeAiEvaluationRun(
  db: Database.Database,
  runId: number,
  aggregate: AiEvaluationAggregate,
  now = Date.now(),
): void {
  db.prepare(`
    UPDATE ai_evaluation_runs SET
      status = 'completed',
      progress_current = progress_total,
      current_case_id = NULL,
      total_score = ?,
      conclusion = ?,
      dimension_scores_json = ?,
      error_message = NULL,
      completed_at = ?
    WHERE id = ? AND status = 'running'
  `).run(aggregate.score, aggregate.conclusion, JSON.stringify(aggregate.dimensionScores), now, runId)
}

export function failAiEvaluationRun(db: Database.Database, runId: number, message: string, now = Date.now()): void {
  db.prepare(`
    UPDATE ai_evaluation_runs SET
      status = 'failed',
      current_case_id = NULL,
      conclusion = 'failed',
      error_message = ?,
      completed_at = ?
    WHERE id = ? AND status = 'running'
  `).run(message.slice(0, 500), now, runId)
}

export function failInterruptedAiEvaluationRuns(db: Database.Database, now = Date.now()): number {
  return db.prepare(`
    UPDATE ai_evaluation_runs SET
      status = 'failed',
      current_case_id = NULL,
      conclusion = 'failed',
      error_message = '应用退出导致评测中断，请重新运行。',
      completed_at = ?
    WHERE status = 'running'
  `).run(now).changes
}

export function findPreviousComparableAiEvaluationRun(
  db: Database.Database,
  run: AiEvaluationRunRecord,
): AiEvaluationRunRecord | null {
  const row = db.prepare(`
    SELECT * FROM ai_evaluation_runs
    WHERE id != ?
      AND status = 'completed'
      AND suite_id = ?
      AND suite_version = ?
      AND provider = ?
      AND model = ?
      AND business_prompt_fingerprint = ?
      AND created_at <= ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(
    run.id,
    run.suiteId,
    run.suiteVersion,
    run.provider,
    run.model,
    run.businessPromptFingerprint,
    run.createdAt,
  ) as Record<string, unknown> | undefined
  return row ? mapRun(row) : null
}
