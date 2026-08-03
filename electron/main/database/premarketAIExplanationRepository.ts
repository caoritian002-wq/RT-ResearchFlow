import type Database from 'better-sqlite3'
import { sha256 } from '../utils/hashUtils'
import type {
  PremarketAIExplanationV1,
  PremarketAIExplanationView,
} from '../services/premarketRehearsalTypes'

interface ExplanationRow {
  id: string
  scenario_version_id: string
  outcome_validation_id: string | null
  provider: string
  model: string
  model_config_fingerprint: string
  source_fingerprint: string
  prompt_sha256: string
  explanation_json: string
  explanation_sha256: string
  usage_json: string
  created_at: number
}

export interface SavePremarketAIExplanationInput {
  id: string
  scenarioVersionId: string
  outcomeValidationId: string | null
  provider: string
  model: string
  modelConfigFingerprint: string
  sourceFingerprint: string
  promptSha256: string
  explanation: PremarketAIExplanationV1
  usage: Record<string, number | null | undefined>
  createdAt: number
}

function mapRow(row: ExplanationRow): PremarketAIExplanationView {
  if (sha256(row.explanation_json) !== row.explanation_sha256) {
    throw new Error('PREMARKET_AI_EXPLANATION_HASH_MISMATCH')
  }
  let explanation: PremarketAIExplanationV1
  try {
    explanation = JSON.parse(row.explanation_json) as PremarketAIExplanationV1
  } catch {
    throw new Error('PREMARKET_AI_EXPLANATION_JSON_INVALID')
  }
  if (
    explanation.schemaVersion !== 1
    || typeof explanation.summary !== 'string'
    || !Array.isArray(explanation.observations)
    || !Array.isArray(explanation.uncertainties)
    || !Array.isArray(explanation.watchItems)
  ) throw new Error('PREMARKET_AI_EXPLANATION_CONTENT_MISMATCH')
  return {
    id: row.id,
    scenarioVersionId: row.scenario_version_id,
    outcomeValidationId: row.outcome_validation_id,
    provider: row.provider,
    model: row.model,
    generatedAt: row.created_at,
    explanation,
  }
}

export function getLatestPremarketAIExplanation(
  db: Database.Database,
  scenarioVersionId: string,
): PremarketAIExplanationView | null {
  const row = db.prepare(`
    SELECT * FROM premarket_ai_explanations
    WHERE scenario_version_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(scenarioVersionId) as ExplanationRow | undefined
  return row ? mapRow(row) : null
}

export function getMatchingPremarketAIExplanation(
  db: Database.Database,
  input: {
    scenarioVersionId: string
    outcomeValidationId: string | null
    provider: string
    model: string
    modelConfigFingerprint: string
    sourceFingerprint: string
  },
): PremarketAIExplanationView | null {
  const row = db.prepare(`
    SELECT * FROM premarket_ai_explanations
    WHERE scenario_version_id = ?
      AND outcome_validation_id IS ?
      AND provider = ? AND model = ?
      AND model_config_fingerprint = ? AND source_fingerprint = ?
    LIMIT 1
  `).get(
    input.scenarioVersionId,
    input.outcomeValidationId,
    input.provider,
    input.model,
    input.modelConfigFingerprint,
    input.sourceFingerprint,
  ) as ExplanationRow | undefined
  return row ? mapRow(row) : null
}

export function savePremarketAIExplanation(
  db: Database.Database,
  input: SavePremarketAIExplanationInput,
): { explanation: PremarketAIExplanationView; reused: boolean } {
  const explanationJson = JSON.stringify(input.explanation)
  const usageJson = JSON.stringify(input.usage)
  if (Buffer.byteLength(explanationJson, 'utf8') > 32768) throw new Error('PREMARKET_AI_EXPLANATION_TOO_LARGE')
  if (Buffer.byteLength(usageJson, 'utf8') > 4096) throw new Error('PREMARKET_AI_USAGE_TOO_LARGE')
  db.prepare(`
    INSERT OR IGNORE INTO premarket_ai_explanations (
      id, scenario_version_id, outcome_validation_id, provider, model,
      model_config_fingerprint, source_fingerprint, prompt_sha256,
      explanation_json, explanation_sha256, usage_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.scenarioVersionId,
    input.outcomeValidationId,
    input.provider,
    input.model,
    input.modelConfigFingerprint,
    input.sourceFingerprint,
    input.promptSha256,
    explanationJson,
    sha256(explanationJson),
    usageJson,
    input.createdAt,
  )
  const saved = getMatchingPremarketAIExplanation(db, input)
  if (!saved) throw new Error('PREMARKET_AI_EXPLANATION_NOT_CREATED')
  return { explanation: saved, reused: saved.id !== input.id }
}
