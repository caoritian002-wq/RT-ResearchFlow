import type Database from 'better-sqlite3'
import { sha256 } from '../utils/hashUtils'
import type {
  PremarketScenarioEvidenceV1,
  PremarketScenarioResultV1,
  PremarketScenarioRevisionKind,
  PremarketScenarioRevisionSummary,
  PremarketScenarioStage,
  PremarketScenarioStatus,
  PremarketScenarioVersion,
} from '../services/premarketRehearsalTypes'

interface PremarketScenarioVersionRow {
  id: string
  trade_date: string
  stage: PremarketScenarioStage
  status: PremarketScenarioStatus
  schema_version: number
  rule_version: string
  base_fact_snapshot_id: string | null
  parent_version_id: string | null
  previous_revision_id: string | null
  revision: number
  revision_kind: PremarketScenarioRevisionKind
  requested_at: number
  cutoff_at: number
  fact_cutoff_at: number
  generated_at: number
  evidence_json: string
  evidence_sha256: string
  scenario_json: string
  scenario_sha256: string
  warnings_json: string
  created_at: number
}

export interface SavePremarketScenarioVersionInput {
  id: string
  tradeDate: string
  stage: PremarketScenarioStage
  status: PremarketScenarioStatus
  ruleVersion: 'premarket-scenario-v1'
  baseFactSnapshotId: string | null
  parentVersionId: string | null
  previousRevisionId: string | null
  revision: number
  revisionKind: PremarketScenarioRevisionKind
  requestedAt: number
  cutoffAt: number
  factCutoffAt: number
  generatedAt: number
  evidence: PremarketScenarioEvidenceV1
  scenario: PremarketScenarioResultV1
  warnings: string[]
  createdAt: number
}

export interface SavedPremarketScenarioVersion {
  version: PremarketScenarioVersion
  reused: boolean
}

function parseJson<T>(value: string, errorCode: string): T {
  try {
    return JSON.parse(value) as T
  } catch {
    throw new Error(errorCode)
  }
}

function mapVersion(row: PremarketScenarioVersionRow): PremarketScenarioVersion {
  if (row.schema_version !== 1 || row.rule_version !== 'premarket-scenario-v1') {
    throw new Error('PREMARKET_SCENARIO_SCHEMA_UNSUPPORTED')
  }
  if (sha256(row.evidence_json) !== row.evidence_sha256) {
    throw new Error('PREMARKET_SCENARIO_EVIDENCE_HASH_MISMATCH')
  }
  if (sha256(row.scenario_json) !== row.scenario_sha256) {
    throw new Error('PREMARKET_SCENARIO_RESULT_HASH_MISMATCH')
  }
  const evidence = parseJson<PremarketScenarioEvidenceV1>(
    row.evidence_json,
    'PREMARKET_SCENARIO_EVIDENCE_INVALID',
  )
  const scenario = parseJson<PremarketScenarioResultV1>(
    row.scenario_json,
    'PREMARKET_SCENARIO_RESULT_INVALID',
  )
  const warnings = parseJson<string[]>(
    row.warnings_json,
    'PREMARKET_SCENARIO_WARNINGS_INVALID',
  )
  if (
    evidence.schemaVersion !== 1
    || evidence.tradeDate !== row.trade_date
    || evidence.stage !== row.stage
    || evidence.cutoffAt !== row.fact_cutoff_at
    || scenario.schemaVersion !== 1
    || scenario.ruleVersion !== row.rule_version
    || scenario.tradeDate !== row.trade_date
    || scenario.stage !== row.stage
    || scenario.status !== row.status
    || !Array.isArray(evidence.holdings)
    || !Array.isArray(evidence.sectors)
    || !Array.isArray(evidence.references)
    || !Array.isArray(scenario.branches)
    || scenario.branches.length !== 3
    || !Array.isArray(warnings)
  ) {
    throw new Error('PREMARKET_SCENARIO_CONTENT_MISMATCH')
  }
  return {
    id: row.id,
    tradeDate: row.trade_date,
    stage: row.stage,
    status: row.status,
    schemaVersion: 1,
    ruleVersion: 'premarket-scenario-v1',
    baseFactSnapshotId: row.base_fact_snapshot_id,
    parentVersionId: row.parent_version_id,
    previousRevisionId: row.previous_revision_id,
    revision: row.revision,
    revisionKind: row.revision_kind,
    requestedAt: row.requested_at,
    cutoffAt: row.cutoff_at,
    factCutoffAt: row.fact_cutoff_at,
    generatedAt: row.generated_at,
    evidence,
    evidenceSha256: row.evidence_sha256,
    scenario,
    scenarioSha256: row.scenario_sha256,
    warnings,
    createdAt: row.created_at,
  }
}

export function getPremarketScenarioVersion(
  db: Database.Database,
  tradeDate: string,
  stage: PremarketScenarioStage,
  ruleVersion = 'premarket-scenario-v1',
): PremarketScenarioVersion | null {
  const row = db.prepare(`
    SELECT * FROM premarket_scenario_versions
    WHERE trade_date = ? AND stage = ? AND rule_version = ?
    ORDER BY revision DESC, created_at DESC, id DESC
    LIMIT 1
  `).get(tradeDate, stage, ruleVersion) as PremarketScenarioVersionRow | undefined
  return row ? mapVersion(row) : null
}

export function listPremarketScenarioVersions(
  db: Database.Database,
  tradeDate: string,
  stage: PremarketScenarioStage,
  ruleVersion = 'premarket-scenario-v1',
): PremarketScenarioVersion[] {
  const rows = db.prepare(`
    SELECT * FROM premarket_scenario_versions
    WHERE trade_date = ? AND stage = ? AND rule_version = ?
    ORDER BY revision DESC, created_at DESC, id DESC
  `).all(tradeDate, stage, ruleVersion) as PremarketScenarioVersionRow[]
  return rows.map(mapVersion)
}

export function toPremarketScenarioRevisionSummary(
  version: PremarketScenarioVersion,
): PremarketScenarioRevisionSummary {
  return {
    id: version.id,
    revision: version.revision,
    revisionKind: version.revisionKind,
    status: version.status,
    stage: version.stage,
    cutoffAt: version.cutoffAt,
    factCutoffAt: version.factCutoffAt,
    requestedAt: version.requestedAt,
    generatedAt: version.generatedAt,
    auctionMatchedCount: version.evidence.auctionMatchedCount,
    briefingCount: version.evidence.market.briefings.length
      + version.evidence.holdings.reduce((sum, item) => sum + item.briefings.length, 0),
    announcementCount: version.evidence.holdings.reduce(
      (sum, item) => sum + item.announcements.length,
      0,
    ),
    warningCount: version.warnings.length,
  }
}

export function getPremarketScenarioVersionById(
  db: Database.Database,
  id: string,
): PremarketScenarioVersion | null {
  const row = db.prepare('SELECT * FROM premarket_scenario_versions WHERE id = ?')
    .get(id) as PremarketScenarioVersionRow | undefined
  return row ? mapVersion(row) : null
}

export function getLatestPremarketScenarioVersionForTradeDate(
  db: Database.Database,
  tradeDate: string,
): PremarketScenarioVersion | null {
  const row = db.prepare(`
    SELECT * FROM premarket_scenario_versions
    WHERE trade_date = ?
    ORDER BY CASE stage WHEN 'auction_confirmed' THEN 2 ELSE 1 END DESC,
      revision DESC, created_at DESC, id DESC
    LIMIT 1
  `).get(tradeDate) as PremarketScenarioVersionRow | undefined
  return row ? mapVersion(row) : null
}

export function getLatestPremarketScenarioVersion(
  db: Database.Database,
): PremarketScenarioVersion | null {
  const row = db.prepare(`
    SELECT * FROM premarket_scenario_versions
    ORDER BY trade_date DESC,
      CASE stage WHEN 'auction_confirmed' THEN 2 ELSE 1 END DESC,
      revision DESC, created_at DESC, id DESC
    LIMIT 1
  `).get() as PremarketScenarioVersionRow | undefined
  return row ? mapVersion(row) : null
}

export function getLatestPremarketScenarioVersionBefore(
  db: Database.Database,
  tradeDate: string,
  ruleVersion = 'premarket-scenario-v1',
): PremarketScenarioVersion | null {
  const row = db.prepare(`
    SELECT * FROM premarket_scenario_versions
    WHERE trade_date < ? AND rule_version = ?
    ORDER BY trade_date DESC,
      CASE stage WHEN 'auction_confirmed' THEN 2 ELSE 1 END DESC,
      revision DESC, created_at DESC, id DESC
    LIMIT 1
  `).get(tradeDate, ruleVersion) as PremarketScenarioVersionRow | undefined
  return row ? mapVersion(row) : null
}

function assertReferencedVersions(
  db: Database.Database,
  input: SavePremarketScenarioVersionInput,
): void {
  if (input.baseFactSnapshotId) {
    const base = db.prepare(`
      SELECT trade_date, stage FROM premarket_fact_snapshots WHERE id = ?
    `).get(input.baseFactSnapshotId) as { trade_date: string; stage: string } | undefined
    if (!base || base.trade_date !== input.tradeDate || base.stage !== 'asia_open') {
      throw new Error('PREMARKET_SCENARIO_BASE_SNAPSHOT_MISMATCH')
    }
  }
  if (input.stage === 'asia_open' && input.parentVersionId !== null) {
    throw new Error('PREMARKET_SCENARIO_PARENT_MISMATCH')
  }
  if (input.revision === 1 && input.previousRevisionId !== null) {
    throw new Error('PREMARKET_SCENARIO_PREVIOUS_REVISION_MISMATCH')
  }
  if (input.revision > 1) {
    const previous = input.previousRevisionId
      ? db.prepare(`
          SELECT trade_date, stage, rule_version, revision
          FROM premarket_scenario_versions WHERE id = ?
        `).get(input.previousRevisionId) as {
          trade_date: string
          stage: string
          rule_version: string
          revision: number
        } | undefined
      : undefined
    if (
      !previous
      || previous.trade_date !== input.tradeDate
      || previous.stage !== input.stage
      || previous.rule_version !== input.ruleVersion
      || previous.revision !== input.revision - 1
    ) {
      throw new Error('PREMARKET_SCENARIO_PREVIOUS_REVISION_MISMATCH')
    }
  }
  if (input.parentVersionId) {
    const parent = db.prepare(`
      SELECT trade_date, stage, rule_version FROM premarket_scenario_versions WHERE id = ?
    `).get(input.parentVersionId) as {
      trade_date: string
      stage: string
      rule_version: string
    } | undefined
    if (
      !parent
      || parent.trade_date !== input.tradeDate
      || parent.stage !== 'asia_open'
      || parent.rule_version !== input.ruleVersion
    ) {
      throw new Error('PREMARKET_SCENARIO_PARENT_MISMATCH')
    }
  }
}

function assertInput(input: SavePremarketScenarioVersionInput): void {
  if (
    input.evidence.schemaVersion !== 1
    || input.evidence.tradeDate !== input.tradeDate
    || input.evidence.stage !== input.stage
    || input.evidence.cutoffAt !== input.factCutoffAt
    || input.scenario.schemaVersion !== 1
    || input.scenario.ruleVersion !== input.ruleVersion
    || input.scenario.tradeDate !== input.tradeDate
    || input.scenario.stage !== input.stage
    || input.scenario.status !== input.status
    || input.scenario.branches.length !== 3
    || !Array.isArray(input.warnings)
    || !Number.isInteger(input.revision)
    || input.revision < 1
    || input.requestedAt <= 0
    || input.factCutoffAt < input.cutoffAt
  ) {
    throw new Error('PREMARKET_SCENARIO_INPUT_MISMATCH')
  }
}

export function savePremarketScenarioVersion(
  db: Database.Database,
  input: SavePremarketScenarioVersionInput,
): SavedPremarketScenarioVersion {
  assertInput(input)
  const existingRow = db.prepare(`
    SELECT * FROM premarket_scenario_versions
    WHERE trade_date = ? AND stage = ? AND rule_version = ? AND revision = ?
    LIMIT 1
  `).get(input.tradeDate, input.stage, input.ruleVersion, input.revision) as PremarketScenarioVersionRow | undefined
  const existing = existingRow ? mapVersion(existingRow) : null
  if (existing) return { version: existing, reused: true }
  assertReferencedVersions(db, input)

  const evidenceJson = JSON.stringify(input.evidence)
  const scenarioJson = JSON.stringify(input.scenario)
  const warningsJson = JSON.stringify(input.warnings)
  if (Buffer.byteLength(evidenceJson, 'utf8') > 524288) {
    throw new Error('PREMARKET_SCENARIO_EVIDENCE_TOO_LARGE')
  }
  if (Buffer.byteLength(scenarioJson, 'utf8') > 524288) {
    throw new Error('PREMARKET_SCENARIO_RESULT_TOO_LARGE')
  }
  if (Buffer.byteLength(warningsJson, 'utf8') > 65536) {
    throw new Error('PREMARKET_SCENARIO_WARNINGS_TOO_LARGE')
  }

  db.prepare(`
    INSERT OR IGNORE INTO premarket_scenario_versions (
      id, trade_date, stage, status, schema_version, rule_version,
      base_fact_snapshot_id, parent_version_id, previous_revision_id,
      revision, revision_kind, requested_at, cutoff_at, fact_cutoff_at, generated_at,
      evidence_json, evidence_sha256, scenario_json, scenario_sha256,
      warnings_json, created_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.tradeDate,
    input.stage,
    input.status,
    input.ruleVersion,
    input.baseFactSnapshotId,
    input.parentVersionId,
    input.previousRevisionId,
    input.revision,
    input.revisionKind,
    input.requestedAt,
    input.cutoffAt,
    input.factCutoffAt,
    input.generatedAt,
    evidenceJson,
    sha256(evidenceJson),
    scenarioJson,
    sha256(scenarioJson),
    warningsJson,
    input.createdAt,
  )

  const savedRow = db.prepare(`
    SELECT * FROM premarket_scenario_versions
    WHERE trade_date = ? AND stage = ? AND rule_version = ? AND revision = ?
    LIMIT 1
  `).get(input.tradeDate, input.stage, input.ruleVersion, input.revision) as PremarketScenarioVersionRow | undefined
  const saved = savedRow ? mapVersion(savedRow) : null
  if (!saved) throw new Error('PREMARKET_SCENARIO_NOT_CREATED')
  return { version: saved, reused: saved.id !== input.id }
}
