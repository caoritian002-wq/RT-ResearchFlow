import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import { mergePublicStockIdentities } from '../../electron/main/database/stockBasicCacheRepository'
import { PersistentPublicMarketRequestGovernor } from '../../electron/main/services/publicMarketRequestGovernor'
import { runPublicStockUniverseSync } from '../../electron/main/services/publicStockUniverseService'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE daily_close_cache (
      ts_code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      close REAL NOT NULL,
      PRIMARY KEY (ts_code, trade_date)
    );
    CREATE TABLE stock_basic_cache (
      ts_code TEXT PRIMARY KEY,
      name TEXT,
      industry TEXT,
      market TEXT,
      list_status TEXT,
      circ_float REAL,
      updated_at INTEGER NOT NULL
    );
  `)
  runMigrations(db, DATABASE_MIGRATIONS.filter((migration) => migration.version === 137))
  return db
}

function pageRows(page: number): Array<Record<string, string>> {
  if (page > 40) return []
  return Array.from({ length: 100 }, (_, offset) => {
    const code = String(600000 + (page - 1) * 100 + offset).padStart(6, '0')
    return { symbol: `sh${code}`, code, name: `测试股票${code}` }
  })
}

describe('public stock universe production sync', () => {
  const databases: Database.Database[] = []
  afterEach(() => {
    for (const db of databases.splice(0)) db.close()
  })

  it('preserves richer local fields while updating public identity', () => {
    const db = createDb()
    databases.push(db)
    db.prepare(`
      INSERT INTO stock_basic_cache
        (ts_code, name, industry, market, list_status, circ_float, updated_at)
      VALUES ('600000.SH', '旧名称', '银行', '主板', 'L', 12345, 1)
    `).run()

    const result = mergePublicStockIdentities(db, [{
      tsCode: '600000.SH',
      name: '浦发银行',
      market: '主板',
      listStatus: 'L',
      observedAt: 2,
    }])
    expect(result).toMatchObject({ updatedRows: 1, preservedIndustryRows: 1, preservedCircFloatRows: 1 })
    expect(db.prepare(`
      SELECT name, industry, market, list_status, circ_float
      FROM stock_basic_cache WHERE ts_code = '600000.SH'
    `).get()).toEqual({
      name: '浦发银行',
      industry: '银行',
      market: '主板',
      list_status: 'L',
      circ_float: 12345,
    })
  })

  it('merges only after a complete low-frequency paginated universe passes its gates', async () => {
    const db = createDb()
    databases.push(db)
    let now = 10_000
    let active = 0
    let maximumActive = 0
    const governor = new PersistentPublicMarketRequestGovernor(db, {
      minIntervalMs: 3_000,
      jitterMs: 0,
      batchSize: 20,
      batchPauseMs: 60_000,
      rateLimitCooldownMs: 30 * 60_000,
      failureCooldownMs: 15 * 60_000,
      consecutiveFailureLimit: 3,
    }, {
      now: () => now,
      sleep: async (ms) => { now += ms },
      random: () => 0,
    })
    const fetchImpl: typeof fetch = async (input) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      const page = Number(new URL(String(input)).searchParams.get('page'))
      active -= 1
      return new Response(JSON.stringify(pageRows(page)), { status: 200 })
    }

    const result = await runPublicStockUniverseSync(db, {
      fetchImpl,
      governor,
      now: () => now,
    })

    expect(result).toMatchObject({ source: 'sina', totalRows: 4_000, insertedRows: 4_000, pageCount: 41 })
    expect(maximumActive).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS count FROM stock_basic_cache').get() as { count: number }).count).toBe(4_000)
    expect((db.prepare(`SELECT status FROM public_market_sync_jobs WHERE job_key = 'stock_universe'`).get() as { status: string }).status).toBe('success')
  })

  it('preserves completed page progress when a later page enters cooldown', async () => {
    const db = createDb()
    databases.push(db)
    let now = 25_000
    const governor = new PersistentPublicMarketRequestGovernor(db, {
      minIntervalMs: 3_000,
      jitterMs: 0,
      batchSize: 20,
      batchPauseMs: 60_000,
      rateLimitCooldownMs: 30 * 60_000,
      failureCooldownMs: 15 * 60_000,
      consecutiveFailureLimit: 3,
    }, {
      now: () => now,
      sleep: async (ms) => { now += ms },
      random: () => 0,
    })
    const fetchImpl: typeof fetch = async (input) => {
      const page = Number(new URL(String(input)).searchParams.get('page'))
      if (page === 4) return new Response('limited', { status: 456 })
      return new Response(JSON.stringify(pageRows(page)), { status: 200 })
    }

    await expect(runPublicStockUniverseSync(db, {
      fetchImpl,
      governor,
      now: () => now,
    })).rejects.toBeInstanceOf(Error)
    expect(db.prepare(`
      SELECT status, processed_items, written_rows, current_item, started_at
      FROM public_market_sync_jobs WHERE job_key = 'stock_universe'
    `).get()).toEqual({
      status: 'cooldown',
      processed_items: 3,
      written_rows: 300,
      current_item: '第 4 页',
      started_at: 25_000,
    })
  })
})
