import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { MarketResonanceDailySnapshotRow } from './types'

export interface SaveMarketResonanceSnapshotInput {
  tradeDate: string
  dataMode: 'archive' | 'partial'
  sourceLabel: string
  coverageAvailable: number
  coverageTotal: number
  snapshotJson: string
  capturedAt: number
}

export interface MarketResonanceSnapshotRecord extends SaveMarketResonanceSnapshotInput {
  snapshotSha256: string
}

interface SnapshotCoverageQuality {
  benchmarkTrends: number
  sectorTrends: number
  boardFacts: number
}

export function saveMarketResonanceSnapshot(
  db: Database.Database,
  input: SaveMarketResonanceSnapshotInput,
): MarketResonanceSnapshotRecord {
  const incomingQuality = validateSnapshotJson(input.snapshotJson, input)
  const snapshotSha256 = sha256(input.snapshotJson)
  const existing = db.prepare(`
    SELECT data_mode, snapshot_json, captured_at
    FROM market_resonance_daily_snapshots
    WHERE trade_date = ?
  `).get(input.tradeDate) as {
    data_mode: 'archive' | 'partial'
    snapshot_json: string
    captured_at: number
  } | undefined
  if (existing && !shouldReplaceSnapshot(existing, input, incomingQuality)) {
    const retained = getMarketResonanceSnapshotRecord(db, input.tradeDate)
    if (!retained) throw new Error('MARKET_RESONANCE_ARCHIVE_WRITE_FAILED')
    return retained
  }
  db.prepare(`
    INSERT INTO market_resonance_daily_snapshots (
      trade_date, data_mode, source_label, coverage_available, coverage_total,
      snapshot_json, snapshot_sha256, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(trade_date) DO UPDATE SET
      data_mode = excluded.data_mode,
      source_label = excluded.source_label,
      coverage_available = excluded.coverage_available,
      coverage_total = excluded.coverage_total,
      snapshot_json = excluded.snapshot_json,
      snapshot_sha256 = excluded.snapshot_sha256,
      captured_at = excluded.captured_at
  `).run(
    input.tradeDate,
    input.dataMode,
    input.sourceLabel,
    input.coverageAvailable,
    input.coverageTotal,
    input.snapshotJson,
    snapshotSha256,
    input.capturedAt,
  )
  const saved = getMarketResonanceSnapshotRecord(db, input.tradeDate)
  if (!saved) throw new Error('MARKET_RESONANCE_ARCHIVE_WRITE_FAILED')
  return saved
}

export function getMarketResonanceSnapshotRecord(
  db: Database.Database,
  tradeDate: string,
): MarketResonanceSnapshotRecord | null {
  const row = db.prepare(`
    SELECT trade_date, data_mode, source_label, coverage_available, coverage_total,
           snapshot_json, snapshot_sha256, captured_at
    FROM market_resonance_daily_snapshots
    WHERE trade_date = ?
  `).get(tradeDate) as MarketResonanceDailySnapshotRow | undefined
  if (!row) return null
  if (sha256(row.snapshot_json) !== row.snapshot_sha256) {
    throw new Error('MARKET_RESONANCE_ARCHIVE_CORRUPTED')
  }
  try {
    validateSnapshotJson(row.snapshot_json, {
      tradeDate: row.trade_date,
      dataMode: row.data_mode,
      coverageAvailable: row.coverage_available,
      coverageTotal: row.coverage_total,
    })
  } catch {
    throw new Error('MARKET_RESONANCE_ARCHIVE_CORRUPTED')
  }
  return {
    tradeDate: row.trade_date,
    dataMode: row.data_mode,
    sourceLabel: row.source_label,
    coverageAvailable: row.coverage_available,
    coverageTotal: row.coverage_total,
    snapshotJson: row.snapshot_json,
    snapshotSha256: row.snapshot_sha256,
    capturedAt: row.captured_at,
  }
}

export function listMarketResonanceSnapshotDates(
  db: Database.Database,
  limit = 120,
): string[] {
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
  const rows = db.prepare(`
    SELECT trade_date
    FROM market_resonance_daily_snapshots
    ORDER BY trade_date DESC
    LIMIT ?
  `).all(safeLimit) as Array<{ trade_date: string }>
  return rows.map((row) => row.trade_date)
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function validateSnapshotJson(
  snapshotJson: string,
  expected: Pick<SaveMarketResonanceSnapshotInput, 'tradeDate' | 'dataMode' | 'coverageAvailable' | 'coverageTotal'>,
): SnapshotCoverageQuality {
  try {
    const parsed = JSON.parse(snapshotJson) as {
      tradeDate?: unknown
      dataMode?: unknown
      generatedAt?: unknown
      coverage?: {
        available?: unknown
        total?: unknown
        benchmarkTrends?: { available?: unknown; total?: unknown }
        sectorTrends?: { available?: unknown; total?: unknown }
        boardFacts?: { available?: unknown; total?: unknown }
      }
      benchmarks?: Array<{ tradeDate?: unknown }>
      sectors?: Array<{ tradeDate?: unknown }>
    }
    const benchmarkCoverage = parsed.coverage?.benchmarkTrends
    const sectorCoverage = parsed.coverage?.sectorTrends
    const boardCoverage = parsed.coverage?.boardFacts
    if (
      !parsed
      || typeof parsed !== 'object'
      || parsed.tradeDate !== expected.tradeDate
      || parsed.dataMode !== expected.dataMode
      || typeof parsed.generatedAt !== 'number'
      || !Number.isFinite(parsed.generatedAt)
      || !Array.isArray(parsed.benchmarks)
      || parsed.benchmarks.length === 0
      || !Array.isArray(parsed.sectors)
      || parsed.sectors.length < 10
      || parsed.benchmarks.some((item) => item?.tradeDate !== expected.tradeDate)
      || parsed.sectors.some((item) => item?.tradeDate !== expected.tradeDate)
      || parsed.coverage?.available !== expected.coverageAvailable
      || parsed.coverage?.total !== expected.coverageTotal
      || !isCoverageDimension(benchmarkCoverage)
      || !isCoverageDimension(sectorCoverage)
      || !isCoverageDimension(boardCoverage)
      || sectorCoverage.total !== expected.coverageTotal
      || boardCoverage.total !== expected.coverageTotal
    ) {
      throw new Error('INVALID_MARKET_RESONANCE_SNAPSHOT')
    }
    const completeSectorCoverage = benchmarkCoverage.available === benchmarkCoverage.total
      ? Math.min(sectorCoverage.available, boardCoverage.available)
      : 0
    const fullyCovered = benchmarkCoverage.available === benchmarkCoverage.total
      && sectorCoverage.available === sectorCoverage.total
      && boardCoverage.available === boardCoverage.total
    if (
      expected.coverageAvailable !== completeSectorCoverage
      || (expected.dataMode === 'archive' && !fullyCovered)
      || (expected.dataMode === 'partial' && fullyCovered)
    ) {
      throw new Error('INVALID_MARKET_RESONANCE_SNAPSHOT')
    }
    return {
      benchmarkTrends: benchmarkCoverage.available,
      sectorTrends: sectorCoverage.available,
      boardFacts: boardCoverage.available,
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_MARKET_RESONANCE_SNAPSHOT') throw error
    throw new Error('INVALID_MARKET_RESONANCE_SNAPSHOT')
  }
}

function isCoverageDimension(
  value: { available?: unknown; total?: unknown } | undefined,
): value is { available: number; total: number } {
  return Boolean(
    value
    && Number.isInteger(value.available)
    && Number.isInteger(value.total)
    && (value.available as number) >= 0
    && (value.total as number) > 0
    && (value.available as number) <= (value.total as number),
  )
}

function shouldReplaceSnapshot(
  existing: { data_mode: 'archive' | 'partial'; snapshot_json: string; captured_at: number },
  incoming: SaveMarketResonanceSnapshotInput,
  incomingQuality: SnapshotCoverageQuality,
): boolean {
  if (incoming.dataMode === 'archive' && existing.data_mode === 'partial') return true
  if (incoming.dataMode === 'partial' && existing.data_mode === 'archive') return false
  let existingQuality: SnapshotCoverageQuality
  try {
    const parsed = JSON.parse(existing.snapshot_json) as {
      coverage?: {
        benchmarkTrends?: { available?: unknown }
        sectorTrends?: { available?: unknown }
        boardFacts?: { available?: unknown }
      }
    }
    const benchmarkTrends = parsed.coverage?.benchmarkTrends?.available
    const sectorTrends = parsed.coverage?.sectorTrends?.available
    const boardFacts = parsed.coverage?.boardFacts?.available
    if (
      !Number.isInteger(benchmarkTrends)
      || !Number.isInteger(sectorTrends)
      || !Number.isInteger(boardFacts)
    ) return true
    existingQuality = {
      benchmarkTrends: benchmarkTrends as number,
      sectorTrends: sectorTrends as number,
      boardFacts: boardFacts as number,
    }
  } catch {
    // A valid explicit backfill is allowed to repair a malformed derived archive.
    return true
  }
  const dimensions = (Object.keys(incomingQuality) as Array<keyof SnapshotCoverageQuality>)
  const neverWorse = dimensions.every((key) => incomingQuality[key] >= existingQuality[key])
  if (!neverWorse) return false
  const strictlyBetter = dimensions.some((key) => incomingQuality[key] > existingQuality[key])
  return strictlyBetter || incoming.capturedAt >= existing.captured_at
}
