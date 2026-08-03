import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { queryDetails } from '../../electron/main/database/backtestDetailRepository'
import {
  getMatureIncompleteBacktestDates,
  repairBacktestDetailsFromLocalDaily,
} from '../../electron/main/services/backtestAuctionService'

describe('backtestAuctionService local repair', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE stock_info (
        stockCode TEXT PRIMARY KEY,
        stockName TEXT,
        fetchedAt INTEGER
      );
      CREATE TABLE stk_auction_backtest_detail (
        trade_date TEXT NOT NULL,
        ts_code TEXT NOT NULL,
        pool TEXT NOT NULL,
        buy_price REAL,
        ret_1d REAL,
        ret_2d REAL,
        ret_3d REAL,
        ret_5d REAL,
        computed_at INTEGER,
        is_one_word INTEGER NOT NULL DEFAULT 0,
        idx_today_pct REAL,
        idx_ret1d REAL,
        idx_ret2d REAL,
        idx_ret3d REAL,
        idx_ret5d REAL,
        PRIMARY KEY (trade_date, ts_code, pool)
      );
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
  })

  afterEach(() => db.close())

  it('用已有个股与指数日线幂等回填成熟收益', () => {
    db.prepare(`
      INSERT INTO stk_auction_backtest_detail (
        trade_date, ts_code, pool, buy_price, ret_1d, ret_2d, ret_3d, ret_5d,
        computed_at, is_one_word, idx_today_pct, idx_ret1d, idx_ret2d, idx_ret3d, idx_ret5d
      ) VALUES ('20260720', '600000.SH', 'brokenBoard', 10, NULL, NULL, NULL, NULL, 1, 0, NULL, NULL, NULL, NULL, NULL)
    `).run()
    db.prepare('INSERT INTO stock_info (stockCode, stockName, fetchedAt) VALUES (?, ?, ?)').run('600000', '浦发银行', 1)
    const insertDaily = db.prepare(`
      INSERT INTO daily_close_cache (ts_code, trade_date, open, high, low, close, pct_chg, vol, turnover_rate)
      VALUES (?, ?, 1, 1, 1, ?, 0, 1, 1)
    `)
    for (const [date, close] of [
      ['20260720', 11], ['20260721', 12], ['20260722', 9],
      ['20260723', 10], ['20260724', 11], ['20260727', 13],
    ] as Array<[string, number]>) insertDaily.run('600000.SH', date, close)
    for (const [date, close] of [
      ['20260717', 99], ['20260720', 100], ['20260721', 101],
      ['20260722', 102], ['20260723', 103], ['20260724', 104], ['20260727', 105],
    ] as Array<[string, number]>) insertDaily.run('000001.SH', date, close)

    expect(repairBacktestDetailsFromLocalDaily(db, { startDate: '20260720', endDate: '20260720' })).toBe(1)
    const [detail] = queryDetails(db, { startDate: '20260720', endDate: '20260720' })
    expect(detail).toMatchObject({
      stockName: '浦发银行',
      ret1d: 20,
      ret2d: -10,
      ret3d: 0,
      ret5d: 30,
      idxTodayPct: 1.01,
      idxRet1d: 1,
      idxRet2d: 2,
      idxRet3d: 3,
      idxRet5d: 5,
    })
    expect(repairBacktestDetailsFromLocalDaily(db, { startDate: '20260720', endDate: '20260720' })).toBe(0)
  })

  it('只把已到达对应交易日但仍缺失的日期列入补齐', () => {
    const details = [
      {
        tradeDate: '20260720', tsCode: '600000.SH', pool: 'brokenBoard' as const,
        buyPrice: 10, ret1d: 1, ret2d: null, ret3d: null, ret5d: null,
        computedAt: 1, isOneWord: 0,
      },
      {
        tradeDate: '20260722', tsCode: '600001.SH', pool: 'allMarket' as const,
        buyPrice: 10, ret1d: null, ret2d: null, ret3d: null, ret5d: null,
        computedAt: 1, isOneWord: 0,
      },
    ]
    const dates = ['20260717', '20260720', '20260721', '20260722', '20260723']

    expect(getMatureIncompleteBacktestDates(details, dates, '20260723')).toEqual(['20260720', '20260722'])
    expect(getMatureIncompleteBacktestDates(details, dates, '20260722')).toEqual(['20260720'])
  })
})
