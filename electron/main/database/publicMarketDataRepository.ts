import type Database from 'better-sqlite3'

export type PublicMarketSyncJobStatus = 'idle' | 'running' | 'success' | 'partial' | 'failed' | 'cooldown'

export interface PublicMarketGlobalRequestState {
  totalRequests: number
  requestsInBatch: number
  nextAllowedAt: number
  batchBlockedUntil: number
  updatedAt: number
}

export interface PublicMarketProviderState {
  provider: string
  requestCount: number
  successCount: number
  failureCount: number
  rateLimitCount: number
  consecutiveFailures: number
  blockedUntil: number
  blockReason: string | null
  lastStatus: number | null
  lastRequestAt: number | null
  updatedAt: number
}

export interface PublicMarketSyncJob {
  jobKey: string
  status: PublicMarketSyncJobStatus
  totalItems: number
  processedItems: number
  writtenRows: number
  currentItem: string | null
  message: string | null
  startedAt: number | null
  completedAt: number | null
  updatedAt: number
}

export type PublicDailyCheckpointStatus = 'pending' | 'running' | 'success' | 'partial' | 'failed' | 'cooldown'

export interface PublicDailySyncCheckpoint {
  tsCode: string
  primaryProvider: 'sina' | 'tencent'
  status: PublicDailyCheckpointStatus
  targetEndDate: string
  lastSuccessDate: string | null
  writtenRows: number
  lastError: string | null
  attempts: number
  updatedAt: number
}

interface GlobalDbRow {
  total_requests: number
  requests_in_batch: number
  next_allowed_at: number
  batch_blocked_until: number
  updated_at: number
}

interface ProviderDbRow {
  provider: string
  request_count: number
  success_count: number
  failure_count: number
  rate_limit_count: number
  consecutive_failures: number
  blocked_until: number
  block_reason: string | null
  last_status: number | null
  last_request_at: number | null
  updated_at: number
}

interface JobDbRow {
  job_key: string
  status: PublicMarketSyncJobStatus
  total_items: number
  processed_items: number
  written_rows: number
  current_item: string | null
  message: string | null
  started_at: number | null
  completed_at: number | null
  updated_at: number
}

function fromProviderRow(row: ProviderDbRow): PublicMarketProviderState {
  return {
    provider: row.provider,
    requestCount: row.request_count,
    successCount: row.success_count,
    failureCount: row.failure_count,
    rateLimitCount: row.rate_limit_count,
    consecutiveFailures: row.consecutive_failures,
    blockedUntil: row.blocked_until,
    blockReason: row.block_reason,
    lastStatus: row.last_status,
    lastRequestAt: row.last_request_at,
    updatedAt: row.updated_at,
  }
}

export function getPublicMarketGlobalRequestState(db: Database.Database): PublicMarketGlobalRequestState {
  const row = db.prepare(`
    SELECT total_requests, requests_in_batch, next_allowed_at, batch_blocked_until, updated_at
    FROM public_market_request_global_state WHERE id = 1
  `).get() as GlobalDbRow
  return {
    totalRequests: row.total_requests,
    requestsInBatch: row.requests_in_batch,
    nextAllowedAt: row.next_allowed_at,
    batchBlockedUntil: row.batch_blocked_until,
    updatedAt: row.updated_at,
  }
}

export function deferPublicMarketRequestsUntil(
  db: Database.Database,
  blockedUntil: number,
  updatedAt: number,
): void {
  db.prepare(`
    UPDATE public_market_request_global_state
    SET batch_blocked_until = MAX(batch_blocked_until, ?),
        updated_at = ?
    WHERE id = 1
  `).run(blockedUntil, updatedAt)
}

export function getPublicMarketProviderState(
  db: Database.Database,
  provider: string,
  now = Date.now(),
): PublicMarketProviderState {
  db.prepare(`
    INSERT OR IGNORE INTO public_market_provider_states (provider, updated_at)
    VALUES (?, ?)
  `).run(provider, now)
  const row = db.prepare(`
    SELECT provider, request_count, success_count, failure_count, rate_limit_count,
           consecutive_failures, blocked_until, block_reason, last_status,
           last_request_at, updated_at
    FROM public_market_provider_states WHERE provider = ?
  `).get(provider) as ProviderDbRow
  return fromProviderRow(row)
}

export function markPublicMarketRequestStarted(
  db: Database.Database,
  provider: string,
  startedAt: number,
  nextAllowedAt: number,
): void {
  const write = db.transaction(() => {
    getPublicMarketProviderState(db, provider, startedAt)
    db.prepare(`
      UPDATE public_market_request_global_state
      SET next_allowed_at = ?, updated_at = ?
      WHERE id = 1
    `).run(nextAllowedAt, startedAt)
    db.prepare(`
      UPDATE public_market_provider_states
      SET last_request_at = ?,
          blocked_until = CASE
            WHEN blocked_until > 0 AND blocked_until <= ? THEN 0
            ELSE blocked_until
          END,
          block_reason = CASE
            WHEN blocked_until > 0 AND blocked_until <= ? THEN NULL
            ELSE block_reason
          END,
          consecutive_failures = CASE
            WHEN blocked_until > 0 AND blocked_until <= ? THEN 0
            ELSE consecutive_failures
          END,
          updated_at = ?
      WHERE provider = ?
    `).run(startedAt, startedAt, startedAt, startedAt, startedAt, provider)
  })
  write()
}

export interface PublicMarketRequestOutcome {
  provider: string
  status: number
  completedAt: number
  batchSize: number
  batchPauseMs: number
  rateLimitCooldownMs: number
  failureCooldownMs: number
  consecutiveFailureLimit: number
}

export function recordPublicMarketRequestOutcome(
  db: Database.Database,
  outcome: PublicMarketRequestOutcome,
): void {
  const rateLimited = [403, 429, 456].includes(outcome.status)
  const succeeded = outcome.status >= 200 && outcome.status < 400
  const write = db.transaction(() => {
    const global = getPublicMarketGlobalRequestState(db)
    const requestsInBatch = global.requestsInBatch + 1
    const batchCompleted = requestsInBatch >= outcome.batchSize
    db.prepare(`
      UPDATE public_market_request_global_state
      SET total_requests = total_requests + 1,
          requests_in_batch = ?,
          batch_blocked_until = ?,
          updated_at = ?
      WHERE id = 1
    `).run(
      batchCompleted ? 0 : requestsInBatch,
      batchCompleted ? outcome.completedAt + outcome.batchPauseMs : global.batchBlockedUntil,
      outcome.completedAt,
    )

    const current = getPublicMarketProviderState(db, outcome.provider, outcome.completedAt)
    const consecutiveFailures = succeeded ? 0 : current.consecutiveFailures + 1
    const shouldOpenFailureCircuit = !rateLimited
      && !succeeded
      && consecutiveFailures >= outcome.consecutiveFailureLimit
    const blockedUntil = rateLimited
      ? outcome.completedAt + outcome.rateLimitCooldownMs
      : shouldOpenFailureCircuit
        ? outcome.completedAt + outcome.failureCooldownMs
        : current.blockedUntil
    const blockReason = rateLimited
      ? `HTTP_${outcome.status}`
      : shouldOpenFailureCircuit
        ? `CONSECUTIVE_FAILURES_${consecutiveFailures}`
        : succeeded
          ? null
          : current.blockReason

    db.prepare(`
      UPDATE public_market_provider_states
      SET request_count = request_count + 1,
          success_count = success_count + ?,
          failure_count = failure_count + ?,
          rate_limit_count = rate_limit_count + ?,
          consecutive_failures = ?,
          blocked_until = ?,
          block_reason = ?,
          last_status = ?,
          updated_at = ?
      WHERE provider = ?
    `).run(
      succeeded ? 1 : 0,
      succeeded ? 0 : 1,
      rateLimited ? 1 : 0,
      consecutiveFailures,
      blockedUntil,
      blockReason,
      outcome.status,
      outcome.completedAt,
      outcome.provider,
    )
  })
  write()
}

export function upsertPublicMarketSyncJob(
  db: Database.Database,
  job: PublicMarketSyncJob,
): void {
  db.prepare(`
    INSERT INTO public_market_sync_jobs (
      job_key, status, total_items, processed_items, written_rows,
      current_item, message, started_at, completed_at, updated_at
    ) VALUES (
      @jobKey, @status, @totalItems, @processedItems, @writtenRows,
      @currentItem, @message, @startedAt, @completedAt, @updatedAt
    )
    ON CONFLICT(job_key) DO UPDATE SET
      status = excluded.status,
      total_items = excluded.total_items,
      processed_items = excluded.processed_items,
      written_rows = excluded.written_rows,
      current_item = excluded.current_item,
      message = excluded.message,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      updated_at = excluded.updated_at
  `).run(job)
}

export function getPublicMarketSyncJob(
  db: Database.Database,
  jobKey: string,
): PublicMarketSyncJob | null {
  const row = db.prepare(`
    SELECT job_key, status, total_items, processed_items, written_rows,
           current_item, message, started_at, completed_at, updated_at
    FROM public_market_sync_jobs WHERE job_key = ?
  `).get(jobKey) as JobDbRow | undefined
  if (!row) return null
  return {
    jobKey: row.job_key,
    status: row.status,
    totalItems: row.total_items,
    processedItems: row.processed_items,
    writtenRows: row.written_rows,
    currentItem: row.current_item,
    message: row.message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  }
}

export function replaceStockBasicIdentityProvenance(
  db: Database.Database,
  tsCodes: string[],
  dataSource: 'tushare' | 'sina',
  observedAt: number,
): void {
  const stmt = db.prepare(`
    INSERT INTO stock_basic_identity_provenance (ts_code, data_source, observed_at)
    VALUES (?, ?, ?)
    ON CONFLICT(ts_code) DO UPDATE SET
      data_source = excluded.data_source,
      observed_at = excluded.observed_at
  `)
  const write = db.transaction(() => {
    for (const tsCode of tsCodes) stmt.run(tsCode, dataSource, observedAt)
  })
  write()
}

export function upsertPublicDailySyncCheckpoint(
  db: Database.Database,
  checkpoint: PublicDailySyncCheckpoint,
): void {
  db.prepare(`
    INSERT INTO public_daily_sync_checkpoints (
      ts_code, primary_provider, status, target_end_date, last_success_date,
      written_rows, last_error, attempts, updated_at
    ) VALUES (
      @tsCode, @primaryProvider, @status, @targetEndDate, @lastSuccessDate,
      @writtenRows, @lastError, @attempts, @updatedAt
    )
    ON CONFLICT(ts_code) DO UPDATE SET
      primary_provider = excluded.primary_provider,
      status = excluded.status,
      target_end_date = excluded.target_end_date,
      last_success_date = excluded.last_success_date,
      written_rows = excluded.written_rows,
      last_error = excluded.last_error,
      attempts = excluded.attempts,
      updated_at = excluded.updated_at
  `).run(checkpoint)
}

export function getPublicDailySyncCheckpoint(
  db: Database.Database,
  tsCode: string,
): PublicDailySyncCheckpoint | null {
  const row = db.prepare(`
    SELECT ts_code, primary_provider, status, target_end_date, last_success_date,
           written_rows, last_error, attempts, updated_at
    FROM public_daily_sync_checkpoints WHERE ts_code = ?
  `).get(tsCode) as {
    ts_code: string
    primary_provider: 'sina' | 'tencent'
    status: PublicDailyCheckpointStatus
    target_end_date: string
    last_success_date: string | null
    written_rows: number
    last_error: string | null
    attempts: number
    updated_at: number
  } | undefined
  if (!row) return null
  return {
    tsCode: row.ts_code,
    primaryProvider: row.primary_provider,
    status: row.status,
    targetEndDate: row.target_end_date,
    lastSuccessDate: row.last_success_date,
    writtenRows: row.written_rows,
    lastError: row.last_error,
    attempts: row.attempts,
    updatedAt: row.updated_at,
  }
}

export function listPendingPublicDailyCodes(
  db: Database.Database,
  targetEndDate: string,
  minimumLocalRows: number,
): string[] {
  const rows = db.prepare(`
    WITH local_coverage AS (
      SELECT ts_code, COUNT(*) AS row_count, MAX(trade_date) AS latest_trade_date
      FROM daily_close_cache
      WHERE trade_date <= ?
      GROUP BY ts_code
    )
    SELECT s.ts_code
    FROM stock_basic_cache s
    LEFT JOIN public_daily_sync_checkpoints c ON c.ts_code = s.ts_code
    LEFT JOIN local_coverage l ON l.ts_code = s.ts_code
    WHERE s.list_status = 'L'
      AND NOT (
        (COALESCE(c.status, '') = 'success' AND COALESCE(c.target_end_date, '') = ?)
        OR (COALESCE(l.row_count, 0) >= ? AND l.latest_trade_date = ?)
      )
    ORDER BY
      CASE c.status
        WHEN 'running' THEN 0
        WHEN 'pending' THEN 1
        WHEN 'partial' THEN 2
        WHEN 'failed' THEN 3
        WHEN 'cooldown' THEN 4
        ELSE 5
      END,
      COALESCE(c.updated_at, 0),
      s.ts_code
  `).all(targetEndDate, targetEndDate, minimumLocalRows, targetEndDate) as Array<{ ts_code: string }>
  return rows.map((row) => row.ts_code)
}

export function advanceSuccessfulPublicDailyCheckpoints(
  db: Database.Database,
  tradeDate: string,
  observedAt: number,
): number {
  return db.prepare(`
    UPDATE public_daily_sync_checkpoints
    SET target_end_date = ?,
        last_success_date = ?,
        updated_at = ?
    WHERE status = 'success'
      AND target_end_date < ?
  `).run(tradeDate, tradeDate, observedAt, tradeDate).changes
}
