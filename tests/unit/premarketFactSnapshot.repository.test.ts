import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import {
  getPremarketFactSnapshot,
  savePremarketFactSnapshot,
} from '../../electron/main/database/premarketFactSnapshotRepository'
import { evaluateExternalRiskBreadth } from '../../electron/main/services/premarketExternalRiskModel'
import type { PremarketFactPayloadV1 } from '../../electron/main/services/premarketScenarioTypes'

describe('premarketFactSnapshotRepository', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db, DATABASE_MIGRATIONS)
  })

  afterEach(() => db?.close())

  function createFacts(tradeDate = '20260731'): PremarketFactPayloadV1 {
    const cutoffAt = Date.parse('2026-07-31T08:45:00+08:00')
    return {
      schemaVersion: 1,
      tradeDate,
      stage: 'asia_open',
      cutoffAt,
      observations: [],
      externalRisk: evaluateExternalRiskBreadth([]),
    }
  }

  it('同交易日、阶段和规则幂等复用首次不可变快照', () => {
    const facts = createFacts()
    const first = savePremarketFactSnapshot(db, {
      id: '00000000-0000-4000-8000-000000000001',
      tradeDate: facts.tradeDate,
      stage: facts.stage,
      status: 'blocked',
      ruleVersion: 'premarket-facts-v1',
      cutoffAt: facts.cutoffAt,
      capturedAt: facts.cutoffAt,
      providerId: 'eastmoney-global-public-v1',
      facts,
      sources: [],
      warnings: ['NO_DATA'],
      createdAt: facts.cutoffAt,
    })
    const second = savePremarketFactSnapshot(db, {
      id: '00000000-0000-4000-8000-000000000002',
      tradeDate: facts.tradeDate,
      stage: facts.stage,
      status: 'ready',
      ruleVersion: 'premarket-facts-v1',
      cutoffAt: facts.cutoffAt,
      capturedAt: facts.cutoffAt + 1,
      providerId: 'other-provider',
      facts,
      sources: [],
      warnings: [],
      createdAt: facts.cutoffAt + 1,
    })

    expect(first.reused).toBe(false)
    expect(second.reused).toBe(true)
    expect(second.snapshot.id).toBe(first.snapshot.id)
    expect(second.snapshot.status).toBe('blocked')
    expect(() => db.prepare('UPDATE premarket_fact_snapshots SET status = ?').run('ready'))
      .toThrow('PREMARKET_FACT_SNAPSHOT_IMMUTABLE')
    expect(() => db.prepare('DELETE FROM premarket_fact_snapshots').run())
      .toThrow('PREMARKET_FACT_SNAPSHOT_IMMUTABLE')
  })

  it('读取时阻断哈希与正文不一致的快照', () => {
    const facts = createFacts('20260803')
    db.prepare(`
      INSERT INTO premarket_fact_snapshots (
        id, trade_date, stage, status, schema_version, rule_version,
        cutoff_at, captured_at, provider_id, facts_json, facts_sha256,
        sources_json, warnings_json, created_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, '[]', '[]', ?)
    `).run(
      '00000000-0000-4000-8000-000000000003',
      facts.tradeDate,
      facts.stage,
      'ready',
      'premarket-facts-v1',
      facts.cutoffAt,
      facts.cutoffAt,
      'eastmoney-global-public-v1',
      JSON.stringify(facts),
      '0'.repeat(64),
      facts.cutoffAt,
    )

    expect(() => getPremarketFactSnapshot(db, facts.tradeDate, facts.stage, 'premarket-facts-v1'))
      .toThrow('PREMARKET_SNAPSHOT_HASH_MISMATCH')
  })

  it('显式补采追加不可变修订并保留前序快照', () => {
    const facts = createFacts()
    const first = savePremarketFactSnapshot(db, {
      id: '00000000-0000-4000-8000-000000000011',
      tradeDate: facts.tradeDate,
      stage: facts.stage,
      status: 'blocked',
      ruleVersion: 'premarket-facts-v1',
      cutoffAt: facts.cutoffAt,
      capturedAt: facts.cutoffAt,
      providerId: 'eastmoney-global-public-v1',
      facts,
      sources: [],
      warnings: ['NO_DATA'],
      createdAt: facts.cutoffAt,
    })
    const recovered = savePremarketFactSnapshot(db, {
      id: '00000000-0000-4000-8000-000000000012',
      tradeDate: facts.tradeDate,
      stage: facts.stage,
      status: 'partial',
      ruleVersion: 'premarket-facts-v1',
      appendRevision: true,
      revisionKind: 'manual_backfill',
      requestedAt: facts.cutoffAt + 60_000,
      cutoffAt: facts.cutoffAt,
      capturedAt: facts.cutoffAt + 60_000,
      providerId: 'premarket-global-recovery-v1',
      facts,
      sources: [],
      warnings: [],
      createdAt: facts.cutoffAt + 60_000,
    })

    expect(first.snapshot.revision).toBe(1)
    expect(recovered.snapshot).toMatchObject({
      revision: 2,
      revisionKind: 'manual_backfill',
      previousRevisionId: first.snapshot.id,
      requestedAt: facts.cutoffAt + 60_000,
    })
    expect(getPremarketFactSnapshot(db, facts.tradeDate, facts.stage, 'premarket-facts-v1')?.id)
      .toBe(recovered.snapshot.id)
    expect(db.prepare('SELECT COUNT(*) AS count FROM premarket_fact_snapshots').get())
      .toEqual({ count: 2 })
  })
})
