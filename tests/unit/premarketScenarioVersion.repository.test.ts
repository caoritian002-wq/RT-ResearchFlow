import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import {
  getPremarketScenarioVersion,
  listPremarketScenarioVersions,
  savePremarketScenarioVersion,
} from '../../electron/main/database/premarketScenarioVersionRepository'
import { savePremarketFactSnapshot } from '../../electron/main/database/premarketFactSnapshotRepository'
import { evaluateExternalRiskBreadth } from '../../electron/main/services/premarketExternalRiskModel'
import { buildPremarketScenarioResult } from '../../electron/main/services/premarketScenarioModel'
import type { PremarketScenarioEvidenceV1 } from '../../electron/main/services/premarketRehearsalTypes'

describe('premarketScenarioVersionRepository', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, DATABASE_MIGRATIONS.filter((migration) => (
      migration.version === 125
      || migration.version === 127
      || migration.version === 131
      || migration.version === 132
    )))
  })

  afterEach(() => db?.close())

  function createBaseSnapshot(tradeDate = '20260731'): string {
    const cutoffAt = Date.parse('2026-07-31T08:45:00+08:00')
    return savePremarketFactSnapshot(db, {
      id: '00000000-0000-4000-8000-000000000001',
      tradeDate,
      stage: 'asia_open',
      status: 'blocked',
      ruleVersion: 'premarket-facts-v1',
      cutoffAt,
      capturedAt: cutoffAt,
      providerId: 'eastmoney-global-public-v1',
      facts: {
        schemaVersion: 1,
        tradeDate,
        stage: 'asia_open',
        cutoffAt,
        observations: [],
        externalRisk: evaluateExternalRiskBreadth([]),
      },
      sources: [],
      warnings: ['NO_DATA'],
      createdAt: cutoffAt,
    }).snapshot.id
  }

  function createEvidence(stage: 'asia_open' | 'auction_confirmed'): PremarketScenarioEvidenceV1 {
    return {
      schemaVersion: 1,
      tradeDate: '20260731',
      stage,
      cutoffAt: Date.parse(stage === 'asia_open' ? '2026-07-31T08:45:00+08:00' : '2026-07-31T09:25:00+08:00'),
      previousTradeDate: null,
      holdingsCapturedAt: Date.parse('2026-07-31T09:25:10+08:00'),
      portfolioSnapshotKind: 'current-only',
      market: {
        baseFactSnapshotId: '00000000-0000-4000-8000-000000000001',
        snapshotStatus: 'blocked',
        externalRiskTone: 'insufficient',
        confidence: 'low',
        eligibleAssetCount: 0,
        regionCount: 0,
        medianChangePercent: null,
        observations: [],
        briefings: [],
        referenceIds: [],
      },
      sectors: [],
      holdings: [],
      auctionMatchedCount: 0,
      references: [],
      warnings: ['PREVIOUS_TRADE_DATE_MISSING'],
    }
  }

  function saveVersion(input: {
    id: string
    stage: 'asia_open' | 'auction_confirmed'
    parentVersionId?: string | null
    revision?: number
    previousRevisionId?: string | null
    revisionKind?: 'scheduled' | 'manual_backfill'
  }) {
    const evidence = createEvidence(input.stage)
    const scenario = buildPremarketScenarioResult(evidence)
    return savePremarketScenarioVersion(db, {
      id: input.id,
      tradeDate: evidence.tradeDate,
      stage: input.stage,
      status: scenario.status,
      ruleVersion: 'premarket-scenario-v1',
      baseFactSnapshotId: evidence.market.baseFactSnapshotId,
      parentVersionId: input.parentVersionId ?? null,
      previousRevisionId: input.previousRevisionId ?? null,
      revision: input.revision ?? 1,
      revisionKind: input.revisionKind ?? 'scheduled',
      requestedAt: evidence.holdingsCapturedAt,
      cutoffAt: evidence.cutoffAt,
      factCutoffAt: evidence.cutoffAt,
      generatedAt: evidence.holdingsCapturedAt,
      evidence,
      scenario,
      warnings: scenario.warnings,
      createdAt: evidence.holdingsCapturedAt,
    })
  }

  it('08:45与09:25形成独立不可变版本且重复写入只复用首次版本', () => {
    createBaseSnapshot()
    const initial = saveVersion({
      id: '00000000-0000-4000-8000-000000000010',
      stage: 'asia_open',
    })
    const confirmed = saveVersion({
      id: '00000000-0000-4000-8000-000000000011',
      stage: 'auction_confirmed',
      parentVersionId: initial.version.id,
    })
    const repeated = saveVersion({
      id: '00000000-0000-4000-8000-000000000012',
      stage: 'auction_confirmed',
      parentVersionId: initial.version.id,
    })

    expect(initial.reused).toBe(false)
    expect(confirmed.version.parentVersionId).toBe(initial.version.id)
    expect(repeated.reused).toBe(true)
    expect(repeated.version.id).toBe(confirmed.version.id)
    expect(() => db.prepare("UPDATE premarket_scenario_versions SET status = 'ready'").run())
      .toThrow('PREMARKET_SCENARIO_VERSION_IMMUTABLE')
    expect(() => db.prepare('DELETE FROM premarket_scenario_versions').run())
      .toThrow('PREMARKET_SCENARIO_VERSION_IMMUTABLE')
  })

  it('同日补采追加R2并保留R1和前序修订关系', () => {
    createBaseSnapshot()
    const original = saveVersion({
      id: '00000000-0000-4000-8000-000000000040',
      stage: 'auction_confirmed',
    })
    const backfill = saveVersion({
      id: '00000000-0000-4000-8000-000000000041',
      stage: 'auction_confirmed',
      revision: 2,
      revisionKind: 'manual_backfill',
      previousRevisionId: original.version.id,
    })

    expect(backfill.reused).toBe(false)
    expect(backfill.version.previousRevisionId).toBe(original.version.id)
    expect(getPremarketScenarioVersion(db, '20260731', 'auction_confirmed')?.id)
      .toBe(backfill.version.id)
    expect(listPremarketScenarioVersions(db, '20260731', 'auction_confirmed')
      .map((item) => [item.revision, item.id])).toEqual([
      [2, backfill.version.id],
      [1, original.version.id],
    ])
  })

  it('父版本不属于同日08:45版本时稳定拒绝', () => {
    createBaseSnapshot()
    expect(() => saveVersion({
      id: '00000000-0000-4000-8000-000000000020',
      stage: 'auction_confirmed',
      parentVersionId: '00000000-0000-4000-8000-000000000099',
    })).toThrow('PREMARKET_SCENARIO_PARENT_MISMATCH')
  })

  it('读取时分别校验证据和情景SHA-256', () => {
    createBaseSnapshot()
    const evidence = createEvidence('asia_open')
    const scenario = buildPremarketScenarioResult(evidence)
    db.prepare(`
      INSERT INTO premarket_scenario_versions (
        id, trade_date, stage, status, schema_version, rule_version,
        base_fact_snapshot_id, parent_version_id, previous_revision_id,
        revision, revision_kind, requested_at, cutoff_at, fact_cutoff_at, generated_at,
        evidence_json, evidence_sha256, scenario_json, scenario_sha256,
        warnings_json, created_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, NULL, NULL, 1, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)
    `).run(
      '00000000-0000-4000-8000-000000000030',
      evidence.tradeDate,
      evidence.stage,
      scenario.status,
      scenario.ruleVersion,
      evidence.market.baseFactSnapshotId,
      evidence.holdingsCapturedAt,
      evidence.cutoffAt,
      evidence.cutoffAt,
      evidence.holdingsCapturedAt,
      JSON.stringify(evidence),
      '0'.repeat(64),
      JSON.stringify(scenario),
      '0'.repeat(64),
      evidence.holdingsCapturedAt,
    )
    expect(() => getPremarketScenarioVersion(db, evidence.tradeDate, evidence.stage))
      .toThrow('PREMARKET_SCENARIO_EVIDENCE_HASH_MISMATCH')
  })
})
