import type Database from 'better-sqlite3'
import { sha256 } from '../utils/hashUtils'
import type {
  PremarketFactPayloadV1,
  PremarketFactRevisionKind,
  PremarketFactSnapshot,
  PremarketSnapshotStatus,
  PremarketSourceRecord,
  PremarketStage,
} from '../services/premarketScenarioTypes'

interface PremarketFactSnapshotRow {
  id: string
  trade_date: string
  stage: PremarketStage
  status: PremarketSnapshotStatus
  schema_version: number
  rule_version: string
  previous_revision_id: string | null
  revision: number
  revision_kind: PremarketFactRevisionKind
  requested_at: number
  cutoff_at: number
  captured_at: number
  provider_id: string
  facts_json: string
  facts_sha256: string
  sources_json: string
  warnings_json: string
  created_at: number
}

export interface SavePremarketFactSnapshotInput {
  id: string
  tradeDate: string
  stage: PremarketStage
  status: PremarketSnapshotStatus
  ruleVersion: string
  appendRevision?: boolean
  revisionKind?: PremarketFactRevisionKind
  requestedAt?: number
  cutoffAt: number
  capturedAt: number
  providerId: string
  facts: PremarketFactPayloadV1
  sources: PremarketSourceRecord[]
  warnings: string[]
  createdAt: number
}

export interface SavedPremarketFactSnapshot {
  snapshot: PremarketFactSnapshot
  reused: boolean
}

function parseJson<T>(value: string, errorCode: string): T {
  try {
    return JSON.parse(value) as T
  } catch {
    throw new Error(errorCode)
  }
}

function mapSnapshot(row: PremarketFactSnapshotRow): PremarketFactSnapshot {
  if (row.schema_version !== 1) throw new Error('PREMARKET_SNAPSHOT_SCHEMA_UNSUPPORTED')
  if (sha256(row.facts_json) !== row.facts_sha256) throw new Error('PREMARKET_SNAPSHOT_HASH_MISMATCH')
  const facts = parseJson<PremarketFactPayloadV1>(row.facts_json, 'PREMARKET_SNAPSHOT_FACTS_INVALID')
  const sources = parseJson<PremarketSourceRecord[]>(row.sources_json, 'PREMARKET_SNAPSHOT_SOURCES_INVALID')
  const warnings = parseJson<string[]>(row.warnings_json, 'PREMARKET_SNAPSHOT_WARNINGS_INVALID')
  if (facts.schemaVersion !== 1 || facts.tradeDate !== row.trade_date || facts.stage !== row.stage || facts.cutoffAt !== row.cutoff_at) {
    throw new Error('PREMARKET_SNAPSHOT_FACTS_MISMATCH')
  }
  if (!Array.isArray(facts.observations) || !Array.isArray(sources) || !Array.isArray(warnings)) {
    throw new Error('PREMARKET_SNAPSHOT_FACTS_INVALID')
  }
  return {
    id: row.id,
    tradeDate: row.trade_date,
    stage: row.stage,
    status: row.status,
    schemaVersion: 1,
    ruleVersion: row.rule_version,
    previousRevisionId: row.previous_revision_id,
    revision: row.revision,
    revisionKind: row.revision_kind,
    requestedAt: row.requested_at,
    cutoffAt: row.cutoff_at,
    capturedAt: row.captured_at,
    providerId: row.provider_id,
    facts,
    factsSha256: row.facts_sha256,
    sources,
    warnings,
    createdAt: row.created_at,
  }
}

export function getPremarketFactSnapshot(
  db: Database.Database,
  tradeDate: string,
  stage: PremarketStage,
  ruleVersion: string,
): PremarketFactSnapshot | null {
  const row = db.prepare(`
    SELECT * FROM premarket_fact_snapshots
    WHERE trade_date = ? AND stage = ? AND rule_version = ?
    ORDER BY revision DESC, created_at DESC, id DESC
    LIMIT 1
  `).get(tradeDate, stage, ruleVersion) as PremarketFactSnapshotRow | undefined
  return row ? mapSnapshot(row) : null
}

export function premarketFactSnapshotExists(
  db: Database.Database,
  tradeDate: string,
  stage: PremarketStage,
  ruleVersion: string,
): boolean {
  return db.prepare(`
    SELECT 1 FROM premarket_fact_snapshots
    WHERE trade_date = ? AND stage = ? AND rule_version = ?
  `).get(tradeDate, stage, ruleVersion) !== undefined
}

export function getLatestPremarketFactSnapshot(
  db: Database.Database,
  stage?: PremarketStage,
): PremarketFactSnapshot | null {
  const row = stage
    ? db.prepare(`
        SELECT * FROM premarket_fact_snapshots
        WHERE stage = ?
        ORDER BY trade_date DESC, revision DESC, created_at DESC LIMIT 1
      `).get(stage) as PremarketFactSnapshotRow | undefined
    : db.prepare(`
      SELECT * FROM premarket_fact_snapshots
      ORDER BY trade_date DESC, revision DESC, created_at DESC LIMIT 1
      `).get() as PremarketFactSnapshotRow | undefined
  return row ? mapSnapshot(row) : null
}

export function savePremarketFactSnapshot(
  db: Database.Database,
  input: SavePremarketFactSnapshotInput,
): SavedPremarketFactSnapshot {
  if (
    input.facts.schemaVersion !== 1
    || input.facts.tradeDate !== input.tradeDate
    || input.facts.stage !== input.stage
    || input.facts.cutoffAt !== input.cutoffAt
    || !Array.isArray(input.facts.observations)
    || !Array.isArray(input.sources)
    || !Array.isArray(input.warnings)
  ) {
    throw new Error('PREMARKET_SNAPSHOT_INPUT_MISMATCH')
  }
  const existing = getPremarketFactSnapshot(db, input.tradeDate, input.stage, input.ruleVersion)
  if (existing && !input.appendRevision) return { snapshot: existing, reused: true }
  const revision = input.appendRevision ? (existing?.revision ?? 0) + 1 : 1
  const previousRevisionId = input.appendRevision ? existing?.id ?? null : null
  const revisionKind = input.revisionKind ?? 'scheduled'
  const requestedAt = input.requestedAt ?? input.createdAt

  const factsJson = JSON.stringify(input.facts)
  const sourcesJson = JSON.stringify(input.sources)
  const warningsJson = JSON.stringify(input.warnings)
  const factsSha256 = sha256(factsJson)

  db.prepare(`
    INSERT OR IGNORE INTO premarket_fact_snapshots (
      id, trade_date, stage, status, schema_version, rule_version,
      previous_revision_id, revision, revision_kind, requested_at,
      cutoff_at, captured_at, provider_id, facts_json, facts_sha256,
      sources_json, warnings_json, created_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.tradeDate,
    input.stage,
    input.status,
    input.ruleVersion,
    previousRevisionId,
    revision,
    revisionKind,
    requestedAt,
    input.cutoffAt,
    input.capturedAt,
    input.providerId,
    factsJson,
    factsSha256,
    sourcesJson,
    warningsJson,
    input.createdAt,
  )

  const savedRow = db.prepare(`
    SELECT * FROM premarket_fact_snapshots
    WHERE trade_date = ? AND stage = ? AND rule_version = ? AND revision = ?
    LIMIT 1
  `).get(input.tradeDate, input.stage, input.ruleVersion, revision) as PremarketFactSnapshotRow | undefined
  const saved = savedRow ? mapSnapshot(savedRow) : null
  if (!saved) throw new Error('PREMARKET_SNAPSHOT_NOT_CREATED')
  return { snapshot: saved, reused: saved.id !== input.id }
}
