import type Database from 'better-sqlite3'
import type {
  StrategyLabMatchRow,
  StrategyLabRunRow,
  StrategyLabRunStatus,
  StrategyLabStrategyRow,
  StrategyLabStrategySource,
  StrategyLabStrategyStatus,
} from './types'

function nowMs(): number {
  return Date.now()
}

function mapStrategyRow(row: Record<string, unknown>): StrategyLabStrategyRow {
  return {
    id: row.id as number,
    strategyKey: row.strategy_key as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    source: row.source as StrategyLabStrategySource,
    status: row.status as StrategyLabStrategyStatus,
    enabled: row.enabled as number,
    isBuiltin: row.is_builtin as number,
    version: row.version as number,
    ruleDraftJson: row.rule_draft_json as string,
    runConfigJson: row.run_config_json as string,
    actionsJson: row.actions_json as string,
    lastRunAt: (row.last_run_at as number | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  }
}

function mapRunRow(row: Record<string, unknown>): StrategyLabRunRow {
  return {
    id: row.id as number,
    strategyId: row.strategy_id as number,
    strategyKey: row.strategy_key as string,
    strategyName: row.strategy_name as string,
    source: row.source as StrategyLabStrategySource,
    status: row.status as StrategyLabRunStatus,
    dateStart: (row.date_start as string | null) ?? null,
    dateEnd: (row.date_end as string | null) ?? null,
    runConfigJson: row.run_config_json as string,
    summaryJson: (row.summary_json as string | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
    backtestRunId: (row.backtest_run_id as number | null) ?? null,
    createdAt: row.created_at as number,
    startedAt: (row.started_at as number | null) ?? null,
    completedAt: (row.completed_at as number | null) ?? null,
  }
}

function mapMatchRow(row: Record<string, unknown>): StrategyLabMatchRow {
  return {
    id: row.id as number,
    runId: row.run_id as number,
    strategyId: row.strategy_id as number,
    strategyKey: row.strategy_key as string,
    source: row.source as StrategyLabStrategySource,
    tsCode: row.ts_code as string,
    stockName: (row.stock_name as string | null) ?? null,
    tradeDate: row.trade_date as string,
    score: row.score as number,
    signalStrength: (row.signal_strength as number | null) ?? null,
    matchedFrom: row.matched_from as string,
    evidenceJson: row.evidence_json as string,
    actionJson: (row.action_json as string | null) ?? null,
    createdAt: row.created_at as number,
  }
}

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'strategy'
}

function makeUniqueStrategyKey(db: Database.Database, base: string): string {
  const safeBase = slugify(base)
  let key = safeBase
  let index = 2
  while (db.prepare('SELECT 1 FROM strategy_lab_strategies WHERE strategy_key = ?').get(key)) {
    key = `${safeBase}-${index}`
    index++
  }
  return key
}

export interface StrategyLabStrategyInput {
  id?: number
  name: string
  description?: string | null
  source: StrategyLabStrategySource
  status?: StrategyLabStrategyStatus
  enabled?: boolean
  isBuiltin?: boolean
  ruleDraftJson: string
  runConfigJson: string
  actionsJson: string
}

export interface StrategyLabRunInput {
  strategyId: number
  strategyKey: string
  strategyName: string
  source: StrategyLabStrategySource
  dateStart?: string | null
  dateEnd?: string | null
  runConfigJson: string
}

export interface StrategyLabRunCompleteInput {
  runId: number
  summaryJson: string
  matches: Array<{
    strategyId: number
    strategyKey: string
    source: StrategyLabStrategySource
    tsCode: string
    stockName?: string | null
    tradeDate: string
    score: number
    signalStrength?: number | null
    matchedFrom: string
    evidenceJson: string
    actionJson?: string | null
  }>
}

export function listStrategies(db: Database.Database): StrategyLabStrategyRow[] {
  const rows = db.prepare(`
    SELECT * FROM strategy_lab_strategies
    ORDER BY is_builtin DESC, enabled DESC, updated_at DESC, id DESC
  `).all() as Record<string, unknown>[]
  return rows.map(mapStrategyRow)
}

export function getStrategy(db: Database.Database, id: number): StrategyLabStrategyRow | null {
  const row = db.prepare('SELECT * FROM strategy_lab_strategies WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? mapStrategyRow(row) : null
}

export function getStrategyByKey(db: Database.Database, strategyKey: string): StrategyLabStrategyRow | null {
  const row = db.prepare('SELECT * FROM strategy_lab_strategies WHERE strategy_key = ?').get(strategyKey) as Record<string, unknown> | undefined
  return row ? mapStrategyRow(row) : null
}

export function upsertStrategy(db: Database.Database, input: StrategyLabStrategyInput): StrategyLabStrategyRow {
  const ts = nowMs()
  const name = input.name.trim()
  if (!name) throw new Error('STRATEGY_NAME_REQUIRED')
  if (input.id) {
    const existing = getStrategy(db, input.id)
    if (!existing) throw new Error('STRATEGY_NOT_FOUND')
    db.prepare(`
      UPDATE strategy_lab_strategies
      SET name = ?, description = ?, source = ?, status = ?, enabled = ?, rule_draft_json = ?,
          run_config_json = ?, actions_json = ?, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(
      name,
      input.description ?? null,
      input.source,
      input.status ?? existing.status,
      input.enabled === false ? 0 : 1,
      input.ruleDraftJson,
      input.runConfigJson,
      input.actionsJson,
      ts,
      input.id,
    )
    const saved = getStrategy(db, input.id)
    if (!saved) throw new Error('STRATEGY_SAVE_FAILED')
    return saved
  }

  const strategyKey = makeUniqueStrategyKey(db, name)
  const info = db.prepare(`
    INSERT INTO strategy_lab_strategies
      (strategy_key, name, description, source, status, enabled, is_builtin, version,
       rule_draft_json, run_config_json, actions_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
  `).run(
    strategyKey,
    name,
    input.description ?? null,
    input.source,
    input.status ?? 'draft',
    input.enabled === false ? 0 : 1,
    input.isBuiltin === true ? 1 : 0,
    input.ruleDraftJson,
    input.runConfigJson,
    input.actionsJson,
    ts,
    ts,
  )
  const saved = getStrategy(db, Number(info.lastInsertRowid))
  if (!saved) throw new Error('STRATEGY_SAVE_FAILED')
  return saved
}

export function duplicateStrategy(db: Database.Database, id: number, name?: string): StrategyLabStrategyRow {
  const source = getStrategy(db, id)
  if (!source) throw new Error('STRATEGY_NOT_FOUND')
  return upsertStrategy(db, {
    name: name?.trim() || `${source.name} 副本`,
    description: source.description,
    source: source.source,
    status: 'draft',
    enabled: true,
    ruleDraftJson: source.ruleDraftJson,
    runConfigJson: source.runConfigJson,
    actionsJson: source.actionsJson,
  })
}

export function deleteStrategy(db: Database.Database, id: number): void {
  const row = getStrategy(db, id)
  if (!row) throw new Error('STRATEGY_NOT_FOUND')
  if (row.isBuiltin === 1) throw new Error('BUILTIN_STRATEGY_CANNOT_DELETE')
  db.prepare('DELETE FROM strategy_lab_strategies WHERE id = ?').run(id)
}

export function setStrategyEnabled(db: Database.Database, id: number, enabled: boolean): StrategyLabStrategyRow {
  const row = getStrategy(db, id)
  if (!row) throw new Error('STRATEGY_NOT_FOUND')
  const status: StrategyLabStrategyStatus = enabled ? (row.status === 'disabled' ? 'ready' : row.status) : 'disabled'
  db.prepare(`
    UPDATE strategy_lab_strategies
    SET enabled = ?, status = ?, updated_at = ?
    WHERE id = ?
  `).run(enabled ? 1 : 0, status, nowMs(), id)
  const saved = getStrategy(db, id)
  if (!saved) throw new Error('STRATEGY_SAVE_FAILED')
  return saved
}

export function createRun(db: Database.Database, input: StrategyLabRunInput): number {
  const ts = nowMs()
  const info = db.prepare(`
    INSERT INTO strategy_lab_runs
      (strategy_id, strategy_key, strategy_name, source, status, date_start, date_end,
       run_config_json, created_at, started_at)
    VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)
  `).run(
    input.strategyId,
    input.strategyKey,
    input.strategyName,
    input.source,
    input.dateStart ?? null,
    input.dateEnd ?? null,
    input.runConfigJson,
    ts,
    ts,
  )
  return Number(info.lastInsertRowid)
}

export function completeRun(db: Database.Database, input: StrategyLabRunCompleteInput): void {
  const ts = nowMs()
  const insert = db.prepare(`
    INSERT OR REPLACE INTO strategy_lab_matches
      (run_id, strategy_id, strategy_key, source, ts_code, stock_name, trade_date, score,
       signal_strength, matched_from, evidence_json, action_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM strategy_lab_matches WHERE run_id = ?').run(input.runId)
    for (const match of input.matches) {
      insert.run(
        input.runId,
        match.strategyId,
        match.strategyKey,
        match.source,
        match.tsCode,
        match.stockName ?? null,
        match.tradeDate,
        match.score,
        match.signalStrength ?? null,
        match.matchedFrom,
        match.evidenceJson,
        match.actionJson ?? null,
        ts,
      )
    }
    db.prepare(`
      UPDATE strategy_lab_runs
      SET status = 'completed', summary_json = ?, error_message = NULL, completed_at = ?
      WHERE id = ?
    `).run(input.summaryJson, ts, input.runId)
    db.prepare(`
      UPDATE strategy_lab_strategies
      SET last_run_at = ?, updated_at = ?
      WHERE id = (SELECT strategy_id FROM strategy_lab_runs WHERE id = ?)
    `).run(ts, ts, input.runId)
  })
  tx()
}

export function failRun(db: Database.Database, runId: number, errorMessage: string, status: 'failed' | 'cancelled' = 'failed'): void {
  db.prepare(`
    UPDATE strategy_lab_runs
    SET status = ?, error_message = ?, completed_at = ?
    WHERE id = ?
  `).run(status, errorMessage, nowMs(), runId)
}

export function markRunBacktest(db: Database.Database, runId: number, backtestRunId: number): void {
  db.prepare('UPDATE strategy_lab_runs SET backtest_run_id = ? WHERE id = ?').run(backtestRunId, runId)
}

export function getRun(db: Database.Database, runId: number): StrategyLabRunRow | null {
  const row = db.prepare('SELECT * FROM strategy_lab_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined
  return row ? mapRunRow(row) : null
}

export function listRuns(db: Database.Database, strategyId?: number, limit = 20): StrategyLabRunRow[] {
  const safeLimit = Math.max(1, Math.min(100, Math.round(limit)))
  const rows = strategyId
    ? db.prepare('SELECT * FROM strategy_lab_runs WHERE strategy_id = ? ORDER BY created_at DESC LIMIT ?').all(strategyId, safeLimit)
    : db.prepare('SELECT * FROM strategy_lab_runs ORDER BY created_at DESC LIMIT ?').all(safeLimit)
  return (rows as Record<string, unknown>[]).map(mapRunRow)
}

export function listMatches(db: Database.Database, params: { runId?: number; strategyId?: number; query?: string; source?: StrategyLabStrategySource; minScore?: number; limit?: number; offset?: number } = {}): StrategyLabMatchRow[] {
  const clauses: string[] = []
  const args: unknown[] = []
  if (params.runId) { clauses.push('run_id = ?'); args.push(params.runId) }
  if (params.strategyId) { clauses.push('strategy_id = ?'); args.push(params.strategyId) }
  if (params.source) { clauses.push('source = ?'); args.push(params.source) }
  if (params.minScore != null) { clauses.push('score >= ?'); args.push(params.minScore) }
  if (params.query?.trim()) {
    clauses.push('(ts_code LIKE ? OR stock_name LIKE ?)')
    const like = `%${params.query.trim()}%`
    args.push(like, like)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = Math.max(1, Math.min(500, params.limit ?? 100))
  const offset = Math.max(0, params.offset ?? 0)
  const rows = db.prepare(`
    SELECT * FROM strategy_lab_matches
    ${where}
    ORDER BY trade_date DESC, score DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...args, limit, offset) as Record<string, unknown>[]
  return rows.map(mapMatchRow)
}

export function getMatch(db: Database.Database, id: number): StrategyLabMatchRow | null {
  const row = db.prepare('SELECT * FROM strategy_lab_matches WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? mapMatchRow(row) : null
}
