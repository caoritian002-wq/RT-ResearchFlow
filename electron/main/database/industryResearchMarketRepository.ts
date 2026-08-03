import type Database from 'better-sqlite3'
import type {
  IndustryResearchMarketSnapshotRow,
  IndustryResearchMarketSyncRunRow,
  SecurityAdjustmentFactorRow,
  SecurityValuationDailyRow,
} from './types'

export function upsertSecurityAdjustmentFactors(
  db: Database.Database,
  rows: SecurityAdjustmentFactorRow[],
): void {
  if (!rows.length) return
  const statement = db.prepare(`
    INSERT INTO security_adjustment_factor_cache (ts_code, trade_date, adj_factor, source, fetched_at)
    VALUES (@ts_code, @trade_date, @adj_factor, @source, @fetched_at)
    ON CONFLICT(ts_code, trade_date) DO UPDATE SET
      adj_factor = excluded.adj_factor,
      source = excluded.source,
      fetched_at = excluded.fetched_at
  `)
  db.transaction((items: SecurityAdjustmentFactorRow[]) => {
    for (const item of items) statement.run(item)
  })(rows)
}

export function listSecurityAdjustmentFactors(
  db: Database.Database,
  tsCode: string,
  startDate = '00000000',
  endDate = '99999999',
): SecurityAdjustmentFactorRow[] {
  return db.prepare(`
    SELECT * FROM security_adjustment_factor_cache
    WHERE ts_code = ? AND trade_date BETWEEN ? AND ?
    ORDER BY trade_date ASC
  `).all(tsCode, startDate, endDate) as SecurityAdjustmentFactorRow[]
}

export function upsertSecurityValuationDaily(
  db: Database.Database,
  rows: SecurityValuationDailyRow[],
): void {
  if (!rows.length) return
  const statement = db.prepare(`
    INSERT INTO security_valuation_daily_cache (
      ts_code, trade_date, total_share, float_share, total_mv, circ_mv,
      pe_ttm, pb, ps_ttm, dv_ttm, source, fetched_at
    ) VALUES (
      @ts_code, @trade_date, @total_share, @float_share, @total_mv, @circ_mv,
      @pe_ttm, @pb, @ps_ttm, @dv_ttm, @source, @fetched_at
    )
    ON CONFLICT(ts_code, trade_date) DO UPDATE SET
      total_share = excluded.total_share,
      float_share = excluded.float_share,
      total_mv = excluded.total_mv,
      circ_mv = excluded.circ_mv,
      pe_ttm = excluded.pe_ttm,
      pb = excluded.pb,
      ps_ttm = excluded.ps_ttm,
      dv_ttm = excluded.dv_ttm,
      source = excluded.source,
      fetched_at = excluded.fetched_at
  `)
  db.transaction((items: SecurityValuationDailyRow[]) => {
    for (const item of items) statement.run(item)
  })(rows)
}

export function listSecurityValuationDaily(
  db: Database.Database,
  tsCode: string,
  startDate = '00000000',
  endDate = '99999999',
): SecurityValuationDailyRow[] {
  return db.prepare(`
    SELECT * FROM security_valuation_daily_cache
    WHERE ts_code = ? AND trade_date BETWEEN ? AND ?
    ORDER BY trade_date ASC
  `).all(tsCode, startDate, endDate) as SecurityValuationDailyRow[]
}

export function getMarketSyncRunByRequestId(
  db: Database.Database,
  requestId: string,
): IndustryResearchMarketSyncRunRow | null {
  return (db.prepare('SELECT * FROM industry_research_market_sync_runs WHERE request_id = ?')
    .get(requestId) as IndustryResearchMarketSyncRunRow | undefined) ?? null
}

export function getLatestMarketSyncRun(
  db: Database.Database,
  projectId: string,
  securityId: string,
): IndustryResearchMarketSyncRunRow | null {
  return (db.prepare(`
    SELECT * FROM industry_research_market_sync_runs
    WHERE project_id = ? AND security_id = ?
    ORDER BY started_at DESC, id DESC LIMIT 1
  `).get(projectId, securityId) as IndustryResearchMarketSyncRunRow | undefined) ?? null
}

export function saveMarketSyncRun(
  db: Database.Database,
  row: IndustryResearchMarketSyncRunRow,
): IndustryResearchMarketSyncRunRow {
  const existing = getMarketSyncRunByRequestId(db, row.request_id)
  if (existing) return existing
  db.prepare(`
    INSERT INTO industry_research_market_sync_runs (
      id, request_id, project_id, company_id, security_id, ts_code, benchmark_code,
      status, result_json, data_start, data_end, fact_fingerprint, error_code,
      started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.request_id, row.project_id, row.company_id, row.security_id,
    row.ts_code, row.benchmark_code, row.status, row.result_json, row.data_start,
    row.data_end, row.fact_fingerprint, row.error_code, row.started_at, row.completed_at,
  )
  return getMarketSyncRunByRequestId(db, row.request_id)!
}

export function getMarketSnapshotByRequestId(
  db: Database.Database,
  requestId: string,
): IndustryResearchMarketSnapshotRow | null {
  return (db.prepare('SELECT * FROM industry_research_market_snapshots WHERE request_id = ?')
    .get(requestId) as IndustryResearchMarketSnapshotRow | undefined) ?? null
}

export function getMarketSnapshot(
  db: Database.Database,
  projectId: string,
  snapshotId: string,
): IndustryResearchMarketSnapshotRow | null {
  return (db.prepare(`
    SELECT * FROM industry_research_market_snapshots WHERE id = ? AND project_id = ?
  `).get(snapshotId, projectId) as IndustryResearchMarketSnapshotRow | undefined) ?? null
}

export function saveMarketSnapshot(
  db: Database.Database,
  row: IndustryResearchMarketSnapshotRow,
): IndustryResearchMarketSnapshotRow {
  const existing = getMarketSnapshotByRequestId(db, row.request_id)
  if (existing) return existing
  db.prepare(`
    INSERT INTO industry_research_market_snapshots (
      id, request_id, project_id, company_id, security_id, ts_code,
      requested_valuation_date, market_date, benchmark_code, benchmark_name,
      raw_close, status, reason_json, market_data_json, fact_fingerprint,
      methodology_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.request_id, row.project_id, row.company_id, row.security_id,
    row.ts_code, row.requested_valuation_date, row.market_date, row.benchmark_code,
    row.benchmark_name, row.raw_close, row.status, row.reason_json,
    row.market_data_json, row.fact_fingerprint, row.methodology_version, row.created_at,
  )
  return getMarketSnapshotByRequestId(db, row.request_id)!
}
