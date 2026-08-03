import type Database from 'better-sqlite3'
import { sha256 } from '../utils/hashUtils'
import type {
  PremarketOutcomeValidationPayloadV1,
  PremarketOutcomeValidationRecord,
  PremarketOutcomeValidationStatus,
} from '../services/premarketRehearsalTypes'

interface OutcomeRow {
  id: string
  trade_date: string
  scenario_version_id: string
  status: PremarketOutcomeValidationStatus
  schema_version: number
  rule_version: string
  source_fingerprint: string
  validation_json: string
  validation_sha256: string
  created_at: number
}

export interface SavePremarketOutcomeValidationInput {
  id: string
  tradeDate: string
  scenarioVersionId: string
  status: PremarketOutcomeValidationStatus
  sourceFingerprint: string
  validation: PremarketOutcomeValidationPayloadV1
  createdAt: number
}

function mapRow(row: OutcomeRow): PremarketOutcomeValidationRecord {
  if (row.schema_version !== 1 || row.rule_version !== 'premarket-validation-v1') {
    throw new Error('PREMARKET_OUTCOME_SCHEMA_UNSUPPORTED')
  }
  if (sha256(row.validation_json) !== row.validation_sha256) {
    throw new Error('PREMARKET_OUTCOME_HASH_MISMATCH')
  }
  let validation: PremarketOutcomeValidationPayloadV1
  try {
    validation = JSON.parse(row.validation_json) as PremarketOutcomeValidationPayloadV1
  } catch {
    throw new Error('PREMARKET_OUTCOME_JSON_INVALID')
  }
  if (
    validation.schemaVersion !== 1
    || validation.ruleVersion !== row.rule_version
    || validation.tradeDate !== row.trade_date
    || validation.scenarioVersionId !== row.scenario_version_id
    || validation.status !== row.status
    || !Array.isArray(validation.items)
    || validation.counts.total !== validation.items.length
  ) {
    throw new Error('PREMARKET_OUTCOME_CONTENT_MISMATCH')
  }
  return {
    id: row.id,
    tradeDate: row.trade_date,
    scenarioVersionId: row.scenario_version_id,
    status: row.status,
    ruleVersion: 'premarket-validation-v1',
    sourceFingerprint: row.source_fingerprint,
    validation,
    validationSha256: row.validation_sha256,
    createdAt: row.created_at,
  }
}

export function getLatestPremarketOutcomeValidation(
  db: Database.Database,
  scenarioVersionId: string,
): PremarketOutcomeValidationRecord | null {
  const row = db.prepare(`
    SELECT * FROM premarket_outcome_validations
    WHERE scenario_version_id = ? AND rule_version = 'premarket-validation-v1'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(scenarioVersionId) as OutcomeRow | undefined
  return row ? mapRow(row) : null
}

export function listLatestPremarketOutcomeValidations(
  db: Database.Database,
  maxTradeDays = 120,
): PremarketOutcomeValidationRecord[] {
  const safeDays = Math.max(1, Math.min(240, Math.trunc(maxTradeDays)))
  const rows = db.prepare(`
    SELECT outcome.*
    FROM premarket_outcome_validations outcome
    JOIN premarket_scenario_versions scenario
      ON scenario.id = outcome.scenario_version_id
    WHERE scenario.stage = 'auction_confirmed'
      AND scenario.revision = (
        SELECT MAX(latest.revision)
        FROM premarket_scenario_versions latest
        WHERE latest.trade_date = scenario.trade_date
          AND latest.stage = scenario.stage
          AND latest.rule_version = scenario.rule_version
      )
    ORDER BY outcome.trade_date DESC, outcome.created_at DESC, outcome.id DESC
  `).all() as OutcomeRow[]
  const dates = new Set<string>()
  const result: PremarketOutcomeValidationRecord[] = []
  for (const row of rows) {
    if (!dates.has(row.trade_date) && dates.size >= safeDays) continue
    if (dates.has(row.trade_date)) continue
    dates.add(row.trade_date)
    result.push(mapRow(row))
  }
  return result
}

export function savePremarketOutcomeValidation(
  db: Database.Database,
  input: SavePremarketOutcomeValidationInput,
): { record: PremarketOutcomeValidationRecord; reused: boolean } {
  if (
    input.validation.schemaVersion !== 1
    || input.validation.ruleVersion !== 'premarket-validation-v1'
    || input.validation.tradeDate !== input.tradeDate
    || input.validation.scenarioVersionId !== input.scenarioVersionId
    || input.validation.status !== input.status
    || !/^[a-f0-9]{64}$/.test(input.sourceFingerprint)
  ) throw new Error('PREMARKET_OUTCOME_INPUT_MISMATCH')
  const validationJson = JSON.stringify(input.validation)
  if (Buffer.byteLength(validationJson, 'utf8') > 524288) {
    throw new Error('PREMARKET_OUTCOME_TOO_LARGE')
  }
  db.prepare(`
    INSERT OR IGNORE INTO premarket_outcome_validations (
      id, trade_date, scenario_version_id, status, schema_version, rule_version,
      source_fingerprint, validation_json, validation_sha256, created_at
    ) VALUES (?, ?, ?, ?, 1, 'premarket-validation-v1', ?, ?, ?, ?)
  `).run(
    input.id,
    input.tradeDate,
    input.scenarioVersionId,
    input.status,
    input.sourceFingerprint,
    validationJson,
    sha256(validationJson),
    input.createdAt,
  )
  const row = db.prepare(`
    SELECT * FROM premarket_outcome_validations
    WHERE scenario_version_id = ? AND rule_version = 'premarket-validation-v1' AND source_fingerprint = ?
  `).get(input.scenarioVersionId, input.sourceFingerprint) as OutcomeRow | undefined
  if (!row) throw new Error('PREMARKET_OUTCOME_NOT_CREATED')
  return { record: mapRow(row), reused: row.id !== input.id }
}
