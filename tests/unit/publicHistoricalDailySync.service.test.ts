import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import { PersistentPublicMarketRequestGovernor } from '../../electron/main/services/publicMarketRequestGovernor'
import {
  runPublicHistoricalDailySync,
  runStartupPublicHistoricalDailySyncIfNeeded,
} from '../../electron/main/services/publicHistoricalDailySyncService'

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
    INSERT INTO stock_basic_cache VALUES
      ('600000.SH', '浦发银行', '银行', '主板', 'L', NULL, 1),
      ('920799.BJ', '艾融软件', '软件服务', '北交所', 'L', NULL, 1);
  `)
  runMigrations(db, DATABASE_MIGRATIONS.filter((migration) => migration.version === 137))
  return db
}

function sinaRows(): Array<Record<string, string>> {
  return [
    { day: '2026-08-12', open: '10', high: '11', low: '9', close: '10', volume: '10000' },
    { day: '2026-08-13', open: '10', high: '12', low: '10', close: '11', volume: '20000' },
    { day: '2026-08-14', open: '11', high: '12', low: '10', close: '11.5', volume: '30000' },
  ]
}

function tencentRows(): string[][] {
  return [
    ['2026-08-12', '10', '10', '11', '9', '100'],
    ['2026-08-13', '10', '11', '12', '10', '200'],
    ['2026-08-14', '11', '11.5', '12', '10', '300'],
  ]
}

describe('public historical daily sync', () => {
  const databases: Database.Database[] = []
  afterEach(() => {
    for (const db of databases.splice(0)) db.close()
  })

  it('falls back to Tencent only for failed Shanghai/Shenzhen stocks and resumes from checkpoints', async () => {
    const db = createDb()
    databases.push(db)
    let now = 1_000
    let requestCount = 0
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
    const fetchImpl: typeof fetch = async (input) => {
      requestCount += 1
      const url = String(input)
      if (url.includes('CN_MarketData') && url.includes('sh600000')) {
        return new Response('upstream unavailable', { status: 500 })
      }
      if (url.includes('ifzq') && url.includes('sh600000')) {
        return new Response(JSON.stringify({ data: { sh600000: { day: tencentRows() } } }), { status: 200 })
      }
      if (url.includes('CN_MarketData') && url.includes('bj920799')) {
        return new Response(JSON.stringify(sinaRows()), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }

    const first = await runPublicHistoricalDailySync(db, '20260814', {
      fetchImpl,
      governor,
      now: () => now,
    })
    expect(first).toMatchObject({ totalStocks: 2, syncedStocks: 2, failedStocks: 0, writtenRows: 4 })
    expect(requestCount).toBe(3)
    expect(db.prepare(`
      SELECT ts_code, primary_provider, status, target_end_date
      FROM public_daily_sync_checkpoints ORDER BY ts_code
    `).all()).toEqual([
      { ts_code: '600000.SH', primary_provider: 'tencent', status: 'success', target_end_date: '20260814' },
      { ts_code: '920799.BJ', primary_provider: 'sina', status: 'success', target_end_date: '20260814' },
    ])
    expect(db.prepare(`
      SELECT ts_code, data_source, amount, turnover_rate
      FROM daily_close_cache WHERE trade_date = '20260814' ORDER BY ts_code
    `).all()).toEqual([
      { ts_code: '600000.SH', data_source: 'tencent', amount: null, turnover_rate: null },
      { ts_code: '920799.BJ', data_source: 'sina', amount: null, turnover_rate: null },
    ])

    const second = await runPublicHistoricalDailySync(db, '20260814', {
      fetchImpl,
      governor,
      now: () => now,
    })
    expect(second).toMatchObject({ processedStocks: 2, syncedStocks: 0, failedStocks: 0, writtenRows: 0 })
    expect(requestCount).toBe(3)
  })

  it('stops at the current checkpoint while both providers cool down and resumes only after cooldown', async () => {
    const db = createDb()
    databases.push(db)
    let now = 10_000
    let requestCount = 0
    let rateLimited = true
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
    const fetchImpl: typeof fetch = async (input) => {
      requestCount += 1
      if (rateLimited) return new Response('limited', { status: 456 })
      const url = String(input)
      if (url.includes('CN_MarketData')) {
        return new Response(JSON.stringify(sinaRows()), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }

    const paused = await runPublicHistoricalDailySync(db, '20260814', {
      fetchImpl,
      governor,
      now: () => now,
    })
    expect(paused).toMatchObject({ processedStocks: 1, syncedStocks: 0, failedStocks: 1 })
    expect(requestCount).toBe(2)
    expect(db.prepare(`
      SELECT status, processed_items, written_rows
      FROM public_market_sync_jobs WHERE job_key = 'historical_daily_public'
    `).get()).toEqual({ status: 'cooldown', processed_items: 1, written_rows: 0 })

    const blockedStartup = await runStartupPublicHistoricalDailySyncIfNeeded(db, '20260814', {
      fetchImpl,
      governor,
      now: () => now,
    })
    expect(blockedStartup).toBeNull()
    expect(requestCount).toBe(2)

    now += 30 * 60_000
    rateLimited = false
    const resumed = await runStartupPublicHistoricalDailySyncIfNeeded(db, '20260814', {
      fetchImpl,
      governor,
      now: () => now,
    })
    expect(resumed).toMatchObject({ processedStocks: 2, syncedStocks: 2, failedStocks: 0 })
    expect(requestCount).toBe(4)
    expect(db.prepare(`
      SELECT status, processed_items
      FROM public_market_sync_jobs WHERE job_key = 'historical_daily_public'
    `).get()).toEqual({ status: 'success', processed_items: 2 })
  })

  it('skips network for stocks whose local cache already covers 480 rows through the target date', async () => {
    const db = createDb()
    databases.push(db)
    const insert = db.prepare(`
      INSERT INTO daily_close_cache (
        ts_code, trade_date, open, high, low, close, pct_chg, vol, turnover_rate,
        amount, data_source, amount_source, turnover_source, fetched_at
      ) VALUES ('600000.SH', ?, 10, 11, 9, 10, 0, 100, NULL,
                NULL, 'legacy', NULL, NULL, NULL)
    `)
    const start = Date.UTC(2025, 0, 1)
    for (let index = 0; index < 479; index += 1) {
      const tradeDate = new Date(start + index * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '')
      insert.run(tradeDate)
    }
    insert.run('20260814')

    let now = 1_000
    let requestCount = 0
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
    const result = await runPublicHistoricalDailySync(db, '20260814', {
      governor,
      now: () => now,
      fetchImpl: async (input) => {
        requestCount += 1
        expect(String(input)).toContain('bj920799')
        return new Response(JSON.stringify(sinaRows()), { status: 200 })
      },
    })

    expect(result).toMatchObject({ totalStocks: 2, processedStocks: 2, syncedStocks: 1, failedStocks: 0 })
    expect(requestCount).toBe(1)
  })

  it('records a first-listing-day empty response as checked without inventing history', async () => {
    const db = createDb()
    databases.push(db)
    db.prepare('DELETE FROM stock_basic_cache').run()
    db.prepare(`
      INSERT INTO stock_basic_cache VALUES
        ('920107.BJ', 'N恒兴', NULL, '北交所', 'L', NULL, ?)
    `).run(Date.UTC(2026, 7, 17, 2))
    let requestCount = 0
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1
      return new Response('[]', { status: 200 })
    }

    const first = await runPublicHistoricalDailySync(db, '20260814', { fetchImpl })
    expect(first).toMatchObject({
      totalStocks: 1,
      processedStocks: 1,
      syncedStocks: 1,
      failedStocks: 0,
      writtenRows: 0,
    })
    expect(db.prepare(`
      SELECT status, target_end_date, last_success_date, written_rows
      FROM public_daily_sync_checkpoints WHERE ts_code = '920107.BJ'
    `).get()).toEqual({
      status: 'success',
      target_end_date: '20260814',
      last_success_date: '20260814',
      written_rows: 0,
    })

    const second = await runPublicHistoricalDailySync(db, '20260814', { fetchImpl })
    expect(second).toMatchObject({ processedStocks: 1, syncedStocks: 0 })
    expect(requestCount).toBe(1)

    const nextSettledDate = await runPublicHistoricalDailySync(db, '20260817', { fetchImpl })
    expect(nextSettledDate).toMatchObject({
      processedStocks: 1,
      syncedStocks: 0,
      failedStocks: 1,
      writtenRows: 0,
    })
    expect(requestCount).toBe(2)
  })

  it('persists a 60 second pause after each 400 processed historical stocks', async () => {
    const db = createDb()
    databases.push(db)
    db.prepare('DELETE FROM stock_basic_cache').run()
    const insert = db.prepare(`
      INSERT INTO stock_basic_cache (
        ts_code, name, industry, market, list_status, circ_float, updated_at
      ) VALUES (?, ?, NULL, '主板', 'L', NULL, 1)
    `)
    const insertAll = db.transaction(() => {
      for (let index = 0; index < 401; index += 1) {
        const code = String(600000 + index).padStart(6, '0')
        insert.run(`${code}.SH`, `样本${index}`)
      }
    })
    insertAll()

    let now = 1_000
    const requestStarts: number[] = []
    const governor = new PersistentPublicMarketRequestGovernor(db, {
      minIntervalMs: 0,
      jitterMs: 0,
      batchSize: 10_000,
      batchPauseMs: 0,
      rateLimitCooldownMs: 30 * 60_000,
      failureCooldownMs: 15 * 60_000,
      consecutiveFailureLimit: 3,
    }, {
      now: () => now,
      sleep: async (ms) => { now += ms },
      random: () => 0,
    })
    const result = await runPublicHistoricalDailySync(db, '20260814', {
      governor,
      now: () => now,
      fetchImpl: async () => {
        requestStarts.push(now)
        return new Response(JSON.stringify(sinaRows()), { status: 200 })
      },
    })

    expect(result).toMatchObject({ totalStocks: 401, syncedStocks: 401, failedStocks: 0 })
    expect(requestStarts).toHaveLength(401)
    expect(requestStarts[399]).toBe(1_000)
    expect(requestStarts[400]).toBe(61_000)
  })
})
