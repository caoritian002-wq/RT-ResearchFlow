import type Database from 'better-sqlite3'

export type StoredDataTrustStatus = 'reliable' | 'degraded' | 'blocked'

export interface StoredDataQualityRun {
  id: number
  checkedAt: number
  status: StoredDataTrustStatus
  fingerprint: string
  snapshot: Record<string, unknown>
  createdAt: number
}

interface DataQualityRunRow {
  id: number
  checked_at: number
  status: StoredDataTrustStatus
  fingerprint: string
  snapshot_json: string
  created_at: number
}

function parseRun(row: DataQualityRunRow): StoredDataQualityRun | null {
  try {
    const snapshot = JSON.parse(row.snapshot_json) as unknown
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null
    const value = snapshot as Record<string, unknown>
    if (!Array.isArray(value.datasets) || typeof value.fingerprint !== 'string') return null
    return {
      id: row.id,
      checkedAt: row.checked_at,
      status: row.status,
      fingerprint: row.fingerprint,
      snapshot: value,
      createdAt: row.created_at,
    }
  } catch {
    return null
  }
}

export function saveDataQualityRun(
  db: Database.Database,
  input: {
    checkedAt: number
    status: StoredDataTrustStatus
    fingerprint: string
    snapshot: Record<string, unknown>
  },
): number {
  const result = db.prepare(`
    INSERT INTO data_quality_runs (
      checked_at, status, fingerprint, snapshot_json, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    input.checkedAt,
    input.status,
    input.fingerprint,
    JSON.stringify(input.snapshot),
    Date.now(),
  )
  return Number(result.lastInsertRowid)
}

export function getLatestDataQualityRun(db: Database.Database): StoredDataQualityRun | null {
  const rows = db.prepare(`
    SELECT id, checked_at, status, fingerprint, snapshot_json, created_at
    FROM data_quality_runs
    ORDER BY checked_at DESC, id DESC
    LIMIT 20
  `).all() as DataQualityRunRow[]
  for (const row of rows) {
    const parsed = parseRun(row)
    if (parsed) return parsed
  }
  return null
}
