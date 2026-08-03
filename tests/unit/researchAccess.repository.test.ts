import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import {
  appendResearchAccessAudit,
  authenticateResearchAccessProfile,
  createResearchAccessProfile,
  getResearchAccessProfile,
  listResearchAccessAudit,
  RESEARCH_ACCESS_AUDIT_LIMIT,
  revokeResearchAccessProfile,
  rotateResearchAccessCredential,
  updateResearchAccessProfile,
} from '../../electron/main/database/researchAccessRepository'

describe('FR-255 research access repository', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db, DATABASE_MIGRATIONS.filter((migration) => migration.version === 120))
  })

  afterEach(() => db.close())

  it('Migration 120 creates constrained profile, receipt and bounded audit tables', () => {
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'research_access_%'
      ORDER BY name
    `).all() as Array<{ name: string }>
    expect(tables.map((row) => row.name)).toEqual([
      'research_access_audit',
      'research_access_operation_receipts',
      'research_access_profiles',
    ])
    expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 120 }])
  })

  it('returns a credential once, authenticates by hash and rejects request id reuse across operations', () => {
    const created = createResearchAccessProfile(db, {
      requestId: '00000000-0000-4000-8000-000000001201',
      id: '10000000-0000-4000-8000-000000001201',
      name: 'Codex 市场事实',
      scopes: ['portfolio.read', 'market.read'],
      now: 100,
    })
    expect(created.credential).toMatch(/^twr_[A-Za-z0-9_-]{43}$/)
    expect(created.profile.scopes).toEqual(['market.read', 'portfolio.read'])
    expect(authenticateResearchAccessProfile(db, created.profile.id, created.credential!)).toMatchObject({
      id: created.profile.id,
      name: 'Codex 市场事实',
    })
    expect(authenticateResearchAccessProfile(db, created.profile.id, 'twr_wrong')).toBeNull()

    const replayed = createResearchAccessProfile(db, {
      requestId: '00000000-0000-4000-8000-000000001201',
      name: '不会覆盖',
      scopes: ['research.read'],
      now: 200,
    })
    expect(replayed).toMatchObject({ replayed: true, credential: null })
    expect(replayed.profile.name).toBe('Codex 市场事实')
    expect(() => updateResearchAccessProfile(db, {
      requestId: '00000000-0000-4000-8000-000000001201',
      profileId: created.profile.id,
      enabled: false,
    })).toThrow('requestId已用于其他操作')
  })

  it('rotates and revokes immediately while keeping replay operations deterministic', () => {
    const created = createResearchAccessProfile(db, {
      requestId: '00000000-0000-4000-8000-000000001202',
      id: '10000000-0000-4000-8000-000000001202',
      name: '研究项目',
      scopes: ['market.read'],
      now: 100,
    })
    const updated = updateResearchAccessProfile(db, {
      requestId: '00000000-0000-4000-8000-000000001203',
      profileId: created.profile.id,
      scopes: ['market.read', 'research.read'],
      enabled: true,
      now: 200,
    })
    expect(updated).toMatchObject({ scopes: ['market.read', 'research.read'], scopeVersion: 2 })

    const rotated = rotateResearchAccessCredential(db, {
      requestId: '00000000-0000-4000-8000-000000001204',
      profileId: created.profile.id,
      now: 300,
    })
    expect(rotated.credential).not.toBe(created.credential)
    expect(rotated.profile.credentialVersion).toBe(2)
    expect(authenticateResearchAccessProfile(db, created.profile.id, created.credential!)).toBeNull()
    expect(authenticateResearchAccessProfile(db, created.profile.id, rotated.credential!)).not.toBeNull()
    expect(rotateResearchAccessCredential(db, {
      requestId: '00000000-0000-4000-8000-000000001204',
      profileId: created.profile.id,
    })).toMatchObject({ replayed: true, credential: null })

    const revoked = revokeResearchAccessProfile(db, {
      requestId: '00000000-0000-4000-8000-000000001205',
      profileId: created.profile.id,
      now: 400,
    })
    expect(revoked).toMatchObject({ enabled: false, revokedAt: 400, credentialVersion: 3, scopeVersion: 3 })
    expect(authenticateResearchAccessProfile(db, created.profile.id, rotated.credential!)).toBeNull()
    expect(() => updateResearchAccessProfile(db, {
      requestId: '00000000-0000-4000-8000-000000001206',
      profileId: created.profile.id,
      enabled: true,
    })).toThrow('访问配置已撤销')
  })

  it('stores only bounded audit metadata, paginates and prunes the oldest rows', () => {
    const created = createResearchAccessProfile(db, {
      requestId: '00000000-0000-4000-8000-000000001207',
      id: '10000000-0000-4000-8000-000000001207',
      name: '审计配置',
      scopes: ['market.read'],
      now: 1,
    })
    const insert = db.prepare(`
      INSERT INTO research_access_audit (
        request_id, profile_id, profile_name_snapshot, surface, decision,
        duration_ms, result_bytes, created_at
      ) VALUES (?, ?, ?, 'mcp', 'allowed', 1, 2, ?)
    `)
    const bulk = db.transaction(() => {
      for (let index = 0; index < RESEARCH_ACCESS_AUDIT_LIMIT; index += 1) {
        insert.run(`20000000-0000-4000-8000-${String(index).padStart(12, '0')}`, created.profile.id, '审计配置', index)
      }
    })
    bulk()
    appendResearchAccessAudit(db, {
      requestId: '30000000-0000-4000-8000-000000000001',
      profileId: created.profile.id,
      profileNameSnapshot: '审计配置',
      surface: 'cli',
      externalToolName: 'stock_price_history',
      toolId: 'stock.price_history',
      inputSha256: 'a'.repeat(64),
      inputSummaryJson: '{"stockCode":"600519"}',
      asOf: '20260730',
      decision: 'allowed',
      scopeVersion: 1,
      toolStatus: 'ready',
      durationMs: 5,
      resultBytes: 120,
      resultSha256: 'b'.repeat(64),
      createdAt: RESEARCH_ACCESS_AUDIT_LIMIT + 1,
    })

    expect(db.prepare('SELECT COUNT(*) AS count FROM research_access_audit').get()).toEqual({
      count: RESEARCH_ACCESS_AUDIT_LIMIT,
    })
    expect(db.prepare('SELECT MIN(created_at) AS value FROM research_access_audit').get()).toEqual({ value: 1 })
    const first = listResearchAccessAudit(db, { limit: 20 })
    expect(first.items).toHaveLength(20)
    expect(first.items[0]).toMatchObject({
      surface: 'cli',
      externalToolName: 'stock_price_history',
      resultBytes: 120,
    })
    expect(first.nextCursor).not.toBeNull()
    expect(listResearchAccessAudit(db, { cursor: first.nextCursor, limit: 20 }).items[0].id)
      .toBeLessThan(first.items.at(-1)!.id)
    expect(getResearchAccessProfile(db, created.profile.id)?.name).toBe('审计配置')
  })
})
