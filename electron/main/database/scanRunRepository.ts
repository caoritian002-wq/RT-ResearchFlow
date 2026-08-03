import { getDb } from './db'
import type { ScanRunRow, ScanRunType } from './types'

export function createScanRun(type: ScanRunType, catchUpRange?: { start: number; end: number }): number {
  const result = getDb()
    .prepare(
      `INSERT INTO scan_runs (type, startedAt, sourcesScanned, newBriefingsFound, catchUpRangeStart, catchUpRangeEnd)
       VALUES (?, ?, 0, 0, ?, ?)`
    )
    .run(type, Date.now(), catchUpRange?.start ?? null, catchUpRange?.end ?? null)
  return result.lastInsertRowid as number
}

export function completeScanRun(
  id: number,
  data: { sourcesScanned: number; newBriefingsFound: number; errors?: string[] }
): void {
  getDb()
    .prepare(
      `UPDATE scan_runs
       SET completedAt = ?, sourcesScanned = ?, newBriefingsFound = ?, errors = ?
       WHERE id = ?`
    )
    .run(
      Date.now(),
      data.sourcesScanned,
      data.newBriefingsFound,
      data.errors ? JSON.stringify(data.errors) : null,
      id
    )
}

export function getLatestScanRun(): ScanRunRow | null {
  return (
    (getDb()
      .prepare('SELECT * FROM scan_runs ORDER BY startedAt DESC LIMIT 1')
      .get() as ScanRunRow | undefined) ?? null
  )
}

export function getInProgressScanRun(): ScanRunRow | null {
  return (
    (getDb()
      .prepare('SELECT * FROM scan_runs WHERE completedAt IS NULL ORDER BY startedAt DESC LIMIT 1')
      .get() as ScanRunRow | undefined) ?? null
  )
}
