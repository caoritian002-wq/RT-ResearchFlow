import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import { upsertPublicDailySyncCheckpoint } from '../../electron/main/database/publicMarketDataRepository'
import { PersistentPublicMarketRequestGovernor } from '../../electron/main/services/publicMarketRequestGovernor'
import {
  parseSinaQuoteTradeClock,
  runPublicDailySnapshotSync,
} from '../../electron/main/services/publicDailySnapshotService'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE daily_close_cache (
      ts_code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      open REAL,
      high REAL,
      low REAL,
      close REAL NOT NULL,
      pct_chg REAL,
      vol REAL,
      turnover_rate REAL,
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

function marketRows(): Array<Record<string, string>> {
  return Array.from({ length: 4_000 }, (_, index) => {
    const code = String(600000 + index).padStart(6, '0')
    return {
      symbol: `sh${code}`,
      code,
      trade: '10.50',
      settlement: '10.00',
      open: '10.00',
      high: '11.00',
      low: '9.80',
      volume: '100000',
      amount: '1050000',
      changepercent: '5.00',
      turnoverratio: '1.25',
    }
  })
}

describe('public daily snapshot sync', () => {
  const databases: Database.Database[] = []
  afterEach(() => {
    for (const db of databases.splice(0)) db.close()
  })

  it('parses the actual date and time from Sina quote payloads', () => {
    expect(parseSinaQuoteTradeClock('var hq_str_sh000001="name,1,2,2026-08-17,15:00:00,00";')).toEqual({
      tradeDate: '20260817',
      quoteTime: '15:00:00',
    })
  })

  it('writes a settled full-market snapshot and advances only completed historical checkpoints', async () => {
    const db = createDb()
    databases.push(db)
    let now = 1_000
    upsertPublicDailySyncCheckpoint(db, {
      tsCode: '600000.SH',
      primaryProvider: 'sina',
      status: 'success',
      targetEndDate: '20260814',
      lastSuccessDate: '20260814',
      writtenRows: 480,
      lastError: null,
      attempts: 1,
      updatedAt: 500,
    })
    const governor = new PersistentPublicMarketRequestGovernor(db, {
      minIntervalMs: 0,
      jitterMs: 0,
      batchSize: 20,
      batchPauseMs: 0,
      rateLimitCooldownMs: 30 * 60_000,
      failureCooldownMs: 15 * 60_000,
      consecutiveFailureLimit: 3,
    }, {
      now: () => now,
      sleep: async (ms) => { now += ms },
      random: () => 0,
    })
    const fetchImpl: typeof fetch = async () => new Response(
      'var hq_str_sh000001="name,1,2,2026-08-17,15:00:00,00";',
      { status: 200 },
    )
    const result = await runPublicDailySnapshotSync(db, '20260817', {
      fetchImpl,
      governor,
      now: () => now,
      marketRows: marketRows(),
    })

    expect(result).toMatchObject({ writtenRows: 4_000, rejectedRows: 0, advancedCheckpoints: 1 })
    expect(db.prepare(`
      SELECT close, vol, amount, turnover_rate, data_source, amount_source, turnover_source
      FROM daily_close_cache WHERE ts_code = '600000.SH' AND trade_date = '20260817'
    `).get()).toEqual({
      close: 10.5,
      vol: 1000,
      amount: 1050,
      turnover_rate: 1.25,
      data_source: 'sina_snapshot',
      amount_source: 'sina_snapshot',
      turnover_source: 'sina_snapshot',
    })
    expect(db.prepare(`
      SELECT target_end_date, last_success_date
      FROM public_daily_sync_checkpoints WHERE ts_code = '600000.SH'
    `).get()).toEqual({ target_end_date: '20260817', last_success_date: '20260817' })
  })

  it('rejects an intraday snapshot before writing any rows', async () => {
    const db = createDb()
    databases.push(db)
    let now = 1_000
    const governor = new PersistentPublicMarketRequestGovernor(db, {
      minIntervalMs: 0,
      jitterMs: 0,
      batchSize: 20,
      batchPauseMs: 0,
      rateLimitCooldownMs: 30 * 60_000,
      failureCooldownMs: 15 * 60_000,
      consecutiveFailureLimit: 3,
    }, {
      now: () => now,
      sleep: async (ms) => { now += ms },
      random: () => 0,
    })
    const fetchImpl: typeof fetch = async () => new Response(
      'var hq_str_sh000001="name,1,2,2026-08-17,13:03:32,00";',
      { status: 200 },
    )

    await expect(runPublicDailySnapshotSync(db, '20260817', {
      fetchImpl,
      governor,
      now: () => now,
      marketRows: marketRows(),
    })).rejects.toThrow('不写入预期交易日')
    expect((db.prepare('SELECT COUNT(*) AS count FROM daily_close_cache').get() as { count: number }).count).toBe(0)
  })

  it('records provider rate limiting as cooldown without writing a snapshot', async () => {
    const db = createDb()
    databases.push(db)
    let now = 1_000
    const governor = new PersistentPublicMarketRequestGovernor(db, {
      minIntervalMs: 0,
      jitterMs: 0,
      batchSize: 20,
      batchPauseMs: 0,
      rateLimitCooldownMs: 30 * 60_000,
      failureCooldownMs: 15 * 60_000,
      consecutiveFailureLimit: 3,
    }, {
      now: () => now,
      sleep: async (ms) => { now += ms },
      random: () => 0,
    })

    await expect(runPublicDailySnapshotSync(db, '20260817', {
      fetchImpl: async () => new Response('limited', { status: 456 }),
      governor,
      now: () => now,
      marketRows: marketRows(),
    })).rejects.toMatchObject({ code: 'PUBLIC_PROVIDER_COOLDOWN' })
    expect(db.prepare(`
      SELECT status, written_rows FROM public_market_sync_jobs
      WHERE job_key = 'daily_snapshot_public'
    `).get()).toEqual({ status: 'cooldown', written_rows: 0 })
    expect((db.prepare('SELECT COUNT(*) AS count FROM daily_close_cache').get() as { count: number }).count).toBe(0)
  })
})
