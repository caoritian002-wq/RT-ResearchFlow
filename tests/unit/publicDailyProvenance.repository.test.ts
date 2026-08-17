import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import { upsertDailyClose } from '../../electron/main/database/dailyCloseCacheRepository'

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
  `)
  runMigrations(db, DATABASE_MIGRATIONS.filter((migration) => migration.version === 137))
  return db
}

describe('daily close source-aware merge', () => {
  it('does not let lower-quality public rows erase or replace Tushare facts', () => {
    const db = createDb()
    upsertDailyClose(db, [{
      tsCode: '600000.SH',
      tradeDate: '20260814',
      open: 10,
      high: 11,
      low: 9.8,
      close: 10.8,
      pctChg: 2,
      vol: 1000,
      amount: 10_500,
      turnoverRate: 1.2,
    }], {
      dataSource: 'tushare',
      amountSource: 'tushare',
      turnoverSource: 'tushare',
      fetchedAt: 100,
    })
    upsertDailyClose(db, [{
      tsCode: '600000.SH',
      tradeDate: '20260814',
      open: 10.1,
      high: 11.1,
      low: 9.9,
      close: 10.9,
      pctChg: 3,
      vol: 1100,
      amount: null,
      turnoverRate: null,
    }], { dataSource: 'sina', fetchedAt: 200 })

    expect(db.prepare(`
      SELECT open, close, pct_chg, vol, turnover_rate, amount,
             data_source, amount_source, turnover_source, fetched_at
      FROM daily_close_cache
    `).get()).toEqual({
      open: 10,
      close: 10.8,
      pct_chg: 2,
      vol: 1000,
      turnover_rate: 1.2,
      amount: 10_500,
      data_source: 'tushare',
      amount_source: 'tushare',
      turnover_source: 'tushare',
      fetched_at: 100,
    })
    db.close()
  })

  it('treats pre-migration local rows as facts that public providers may fill but not replace', () => {
    const db = createDb()
    db.prepare(`
      INSERT INTO daily_close_cache (
        ts_code, trade_date, open, high, low, close, pct_chg, vol,
        turnover_rate, amount, data_source, amount_source, turnover_source, fetched_at
      ) VALUES ('000001.SZ', '20260814', 12, 12.5, 11.8, 12.2, 1.5, 800,
                NULL, NULL, 'legacy', NULL, NULL, NULL)
    `).run()

    upsertDailyClose(db, [{
      tsCode: '000001.SZ',
      tradeDate: '20260814',
      open: 12.1,
      high: 12.6,
      low: 11.9,
      close: 12.3,
      pctChg: 2,
      vol: 900,
      amount: 10_000,
      turnoverRate: 1.1,
    }], {
      dataSource: 'sina_snapshot',
      amountSource: 'sina_snapshot',
      turnoverSource: 'sina_snapshot',
      fetchedAt: 200,
    })

    expect(db.prepare(`
      SELECT open, close, pct_chg, vol, turnover_rate, amount,
             data_source, amount_source, turnover_source, fetched_at
      FROM daily_close_cache
    `).get()).toEqual({
      open: 12,
      close: 12.2,
      pct_chg: 1.5,
      vol: 800,
      turnover_rate: 1.1,
      amount: 10_000,
      data_source: 'legacy',
      amount_source: 'sina_snapshot',
      turnover_source: 'sina_snapshot',
      fetched_at: null,
    })
    db.close()
  })
})
