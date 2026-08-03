import type Database from 'better-sqlite3'
import { sha256 } from '../utils/hashUtils'
import type {
  PremarketPreparationBriefingsV1,
  PremarketPreparationExternalV1,
  PremarketPreparationSnapshot,
  PremarketPreparationStatus,
} from '../services/premarketRehearsalTypes'

interface PremarketPreparationRow {
  id: string
  target_trade_date: string
  status: PremarketPreparationStatus
  schema_version: number
  rule_version: string
  captured_at: number
  external_json: string
  external_sha256: string
  briefings_json: string
  briefings_sha256: string
  warnings_json: string
  created_at: number
}

export interface SavePremarketPreparationInput {
  id: string
  targetTradeDate: string
  status: PremarketPreparationStatus
  capturedAt: number
  external: PremarketPreparationExternalV1
  briefings: PremarketPreparationBriefingsV1
  warnings: string[]
  createdAt: number
}

function parseJson<T>(value: string, errorCode: string): T {
  try {
    return JSON.parse(value) as T
  } catch {
    throw new Error(errorCode)
  }
}

function mapSnapshot(row: PremarketPreparationRow): PremarketPreparationSnapshot {
  if (row.schema_version !== 1 || row.rule_version !== 'premarket-preparation-v1') {
    throw new Error('PREMARKET_PREPARATION_SCHEMA_UNSUPPORTED')
  }
  if (sha256(row.external_json) !== row.external_sha256) {
    throw new Error('PREMARKET_PREPARATION_EXTERNAL_HASH_MISMATCH')
  }
  if (sha256(row.briefings_json) !== row.briefings_sha256) {
    throw new Error('PREMARKET_PREPARATION_BRIEFINGS_HASH_MISMATCH')
  }
  const external = parseJson<PremarketPreparationExternalV1>(
    row.external_json,
    'PREMARKET_PREPARATION_EXTERNAL_INVALID',
  )
  const briefings = parseJson<PremarketPreparationBriefingsV1>(
    row.briefings_json,
    'PREMARKET_PREPARATION_BRIEFINGS_INVALID',
  )
  const warnings = parseJson<string[]>(
    row.warnings_json,
    'PREMARKET_PREPARATION_WARNINGS_INVALID',
  )
  if (
    external.schemaVersion !== 1
    || external.targetTradeDate !== row.target_trade_date
    || external.capturedAt !== row.captured_at
    || briefings.schemaVersion !== 1
    || !Array.isArray(external.observations)
    || !Array.isArray(warnings)
  ) {
    throw new Error('PREMARKET_PREPARATION_CONTENT_MISMATCH')
  }
  return {
    id: row.id,
    targetTradeDate: row.target_trade_date,
    status: row.status,
    schemaVersion: 1,
    ruleVersion: 'premarket-preparation-v1',
    capturedAt: row.captured_at,
    external,
    externalSha256: row.external_sha256,
    briefings,
    briefingsSha256: row.briefings_sha256,
    warnings,
    createdAt: row.created_at,
  }
}

export function getLatestPremarketPreparation(
  db: Database.Database,
  targetTradeDate?: string,
): PremarketPreparationSnapshot | null {
  const row = targetTradeDate
    ? db.prepare(`
        SELECT * FROM premarket_preparation_snapshots
        WHERE target_trade_date = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(targetTradeDate)
    : db.prepare(`
        SELECT * FROM premarket_preparation_snapshots
        ORDER BY target_trade_date DESC, created_at DESC
        LIMIT 1
      `).get()
  return row ? mapSnapshot(row as PremarketPreparationRow) : null
}

export function savePremarketPreparation(
  db: Database.Database,
  input: SavePremarketPreparationInput,
): PremarketPreparationSnapshot {
  if (
    input.external.schemaVersion !== 1
    || input.external.targetTradeDate !== input.targetTradeDate
    || input.external.capturedAt !== input.capturedAt
    || input.briefings.schemaVersion !== 1
    || !Array.isArray(input.warnings)
  ) {
    throw new Error('PREMARKET_PREPARATION_INPUT_MISMATCH')
  }
  const externalJson = JSON.stringify(input.external)
  const briefingsJson = JSON.stringify(input.briefings)
  const warningsJson = JSON.stringify(input.warnings)
  if (Buffer.byteLength(externalJson, 'utf8') > 131072) throw new Error('PREMARKET_PREPARATION_EXTERNAL_TOO_LARGE')
  if (Buffer.byteLength(briefingsJson, 'utf8') > 32768) throw new Error('PREMARKET_PREPARATION_BRIEFINGS_TOO_LARGE')
  if (Buffer.byteLength(warningsJson, 'utf8') > 32768) throw new Error('PREMARKET_PREPARATION_WARNINGS_TOO_LARGE')
  db.prepare(`
    INSERT INTO premarket_preparation_snapshots (
      id, target_trade_date, status, schema_version, rule_version, captured_at,
      external_json, external_sha256, briefings_json, briefings_sha256,
      warnings_json, created_at
    ) VALUES (?, ?, ?, 1, 'premarket-preparation-v1', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.targetTradeDate,
    input.status,
    input.capturedAt,
    externalJson,
    sha256(externalJson),
    briefingsJson,
    sha256(briefingsJson),
    warningsJson,
    input.createdAt,
  )
  const row = db.prepare('SELECT * FROM premarket_preparation_snapshots WHERE id = ?')
    .get(input.id) as PremarketPreparationRow | undefined
  if (!row) throw new Error('PREMARKET_PREPARATION_NOT_CREATED')
  return mapSnapshot(row)
}
