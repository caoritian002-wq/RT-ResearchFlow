import type Database from 'better-sqlite3'

export type AfterCloseSyncTrigger = 'scheduled' | 'startup_catch_up'
export type AfterCloseSyncRunStatus = 'running' | 'completed' | 'partial' | 'failed' | 'blocked'
export type AfterCloseSyncTaskKey =
  | 'security_master'
  | 'short_term_daily'
  | 'market_daily'
  | 'chip_structure'
  | 'sector_snapshot'
  | 'trend_scores'
  | 'premarket_validation'
export type AfterCloseSyncTaskStatus = 'running' | 'completed' | 'partial' | 'failed' | 'blocked'

export interface AfterCloseSyncTaskRecord {
  status: AfterCloseSyncTaskStatus
  startedAt: number
  completedAt: number | null
  message: string | null
}

export interface AfterCloseSyncRun {
  id: number
  tradeDate: string
  trigger: AfterCloseSyncTrigger
  status: AfterCloseSyncRunStatus
  startedAt: number
  completedAt: number | null
  updatedAt: number
  attemptCount: number
  tasks: Partial<Record<AfterCloseSyncTaskKey, AfterCloseSyncTaskRecord>>
  errorSummary: string | null
}

interface AfterCloseSyncRunRow {
  id: number
  trade_date: string
  trigger: AfterCloseSyncTrigger
  status: AfterCloseSyncRunStatus
  started_at: number
  completed_at: number | null
  updated_at: number
  attempt_count: number
  tasks_json: string
  error_summary: string | null
}

const ACTIVE_RUN_TIMEOUT_MS = 30 * 60 * 1000
const RETRY_COOLDOWN_MS = 60 * 60 * 1000

function mapRun(row: AfterCloseSyncRunRow): AfterCloseSyncRun {
  let tasks: AfterCloseSyncRun['tasks'] = {}
  try {
    tasks = JSON.parse(row.tasks_json) as AfterCloseSyncRun['tasks']
  } catch {
    tasks = {}
  }
  return {
    id: row.id,
    tradeDate: row.trade_date,
    trigger: row.trigger,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
    attemptCount: row.attempt_count,
    tasks,
    errorSummary: row.error_summary,
  }
}

export function getAfterCloseSyncRun(
  db: Database.Database,
  tradeDate: string,
): AfterCloseSyncRun | null {
  const row = db.prepare(
    'SELECT * FROM after_close_sync_runs WHERE trade_date = ?',
  ).get(tradeDate) as AfterCloseSyncRunRow | undefined
  return row ? mapRun(row) : null
}

export function getLatestAfterCloseSyncRun(db: Database.Database): AfterCloseSyncRun | null {
  const row = db.prepare(
    'SELECT * FROM after_close_sync_runs ORDER BY trade_date DESC, updated_at DESC LIMIT 1',
  ).get() as AfterCloseSyncRunRow | undefined
  return row ? mapRun(row) : null
}

export function shouldStartAfterCloseSyncRun(
  run: AfterCloseSyncRun | null,
  now = Date.now(),
): boolean {
  if (!run) return true
  if (run.status === 'completed') return false
  const age = Math.max(0, now - run.updatedAt)
  if (run.status === 'running') return age >= ACTIVE_RUN_TIMEOUT_MS
  return age >= RETRY_COOLDOWN_MS
}

export function beginAfterCloseSyncRun(
  db: Database.Database,
  tradeDate: string,
  trigger: AfterCloseSyncTrigger,
  now = Date.now(),
): AfterCloseSyncRun {
  db.prepare(`
    INSERT INTO after_close_sync_runs (
      trade_date, trigger, status, started_at, completed_at, updated_at,
      attempt_count, tasks_json, error_summary
    ) VALUES (?, ?, 'running', ?, NULL, ?, 1, '{}', NULL)
    ON CONFLICT(trade_date) DO UPDATE SET
      trigger = excluded.trigger,
      status = 'running',
      started_at = excluded.started_at,
      completed_at = NULL,
      updated_at = excluded.updated_at,
      attempt_count = after_close_sync_runs.attempt_count + 1,
      tasks_json = '{}',
      error_summary = NULL
  `).run(tradeDate, trigger, now, now)
  const run = getAfterCloseSyncRun(db, tradeDate)
  if (!run) throw new Error('AFTER_CLOSE_RUN_NOT_CREATED')
  return run
}

export function updateAfterCloseSyncTask(
  db: Database.Database,
  tradeDate: string,
  taskKey: AfterCloseSyncTaskKey,
  status: AfterCloseSyncTaskStatus,
  message: string | null,
  now = Date.now(),
): AfterCloseSyncRun {
  const run = getAfterCloseSyncRun(db, tradeDate)
  if (!run) throw new Error('AFTER_CLOSE_RUN_NOT_FOUND')
  const previous = run.tasks[taskKey]
  const tasks = {
    ...run.tasks,
    [taskKey]: {
      status,
      startedAt: previous?.startedAt ?? now,
      completedAt: status === 'running' ? null : now,
      message,
    },
  }
  db.prepare(`
    UPDATE after_close_sync_runs
    SET tasks_json = ?, updated_at = ?
    WHERE trade_date = ?
  `).run(JSON.stringify(tasks), now, tradeDate)
  const updated = getAfterCloseSyncRun(db, tradeDate)
  if (!updated) throw new Error('AFTER_CLOSE_RUN_NOT_FOUND')
  return updated
}

export function completeAfterCloseSyncRun(
  db: Database.Database,
  tradeDate: string,
  status: Exclude<AfterCloseSyncRunStatus, 'running'>,
  errorSummary: string | null,
  now = Date.now(),
): AfterCloseSyncRun {
  db.prepare(`
    UPDATE after_close_sync_runs
    SET status = ?, completed_at = ?, updated_at = ?, error_summary = ?
    WHERE trade_date = ?
  `).run(status, now, now, errorSummary, tradeDate)
  const run = getAfterCloseSyncRun(db, tradeDate)
  if (!run) throw new Error('AFTER_CLOSE_RUN_NOT_FOUND')
  return run
}
