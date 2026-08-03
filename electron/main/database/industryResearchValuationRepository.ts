import type Database from 'better-sqlite3'
import type { IndustryResearchValuationSnapshotRow } from './types'

export function getValuationSnapshotByRequestId(
  db: Database.Database,
  requestId: string,
): IndustryResearchValuationSnapshotRow | null {
  return (db.prepare('SELECT * FROM industry_research_valuation_snapshots WHERE request_id = ?')
    .get(requestId) as IndustryResearchValuationSnapshotRow | undefined) ?? null
}

export function getValuationSnapshot(
  db: Database.Database,
  projectId: string,
  snapshotId: string,
): IndustryResearchValuationSnapshotRow | null {
  return (db.prepare(`
    SELECT * FROM industry_research_valuation_snapshots WHERE id = ? AND project_id = ?
  `).get(snapshotId, projectId) as IndustryResearchValuationSnapshotRow | undefined) ?? null
}

export function saveValuationSnapshot(
  db: Database.Database,
  row: IndustryResearchValuationSnapshotRow,
): IndustryResearchValuationSnapshotRow {
  const existing = getValuationSnapshotByRequestId(db, row.request_id)
  if (existing) return existing
  db.prepare(`
    INSERT INTO industry_research_valuation_snapshots (
      id, request_id, project_id, company_id, scenario_set_version_id,
      market_snapshot_id, valuation_method, status, input_json, output_json,
      fact_ids_json, formula_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.request_id, row.project_id, row.company_id,
    row.scenario_set_version_id, row.market_snapshot_id, row.valuation_method,
    row.status, row.input_json, row.output_json, row.fact_ids_json,
    row.formula_version, row.created_at,
  )
  return getValuationSnapshotByRequestId(db, row.request_id)!
}
