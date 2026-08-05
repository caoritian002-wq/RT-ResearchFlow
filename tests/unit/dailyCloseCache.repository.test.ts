import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import {
  backfillDailyCloseTurnover,
  cleanupDailyCloseCache,
  countMissingDailyCloseTurnoverByTradeDates,
  DAILY_CLOSE_RETENTION_TRADE_DAYS,
  getDailyCloseQualitySummary,
  queryDailyCloseExact,
  upsertDailyClose,
} from '../../electron/main/database/dailyCloseCacheRepository'

function createDailyCloseDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE daily_close_cache (
      ts_code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      close REAL NOT NULL,
      PRIMARY KEY (ts_code, trade_date)
    )
  `)
  return db
}

function createQualityDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE daily_close_cache (
      ts_code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      pct_chg REAL,
      vol REAL,
      turnover_rate REAL,
      PRIMARY KEY (ts_code, trade_date)
    )
  `)
  return db
}

function buildWeekdayTradeDates(count: number): string[] {
  const dates: string[] = []
  const cursor = new Date(Date.UTC(2024, 0, 1))
  while (dates.length < count) {
    const weekday = cursor.getUTCDay()
    if (weekday !== 0 && weekday !== 6) {
      dates.push(cursor.toISOString().slice(0, 10).replace(/-/g, ''))
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}

function seedTradeDates(db: Database.Database, dates: string[], tsCodes = ['600000.SH']): void {
  const insert = db.prepare(`
    INSERT INTO daily_close_cache (ts_code, trade_date, close)
    VALUES (?, ?, ?)
  `)
  const insertAll = db.transaction(() => {
    for (const tradeDate of dates) {
      for (const tsCode of tsCodes) insert.run(tsCode, tradeDate, 10)
    }
  })
  insertAll()
}

describe('dailyCloseCacheRepository', () => {
  it('一次聚合返回交易日边界和关键字段缺失率', () => {
    const db = createQualityDb()
    db.exec(`
      INSERT INTO daily_close_cache VALUES
        ('600000.SH', '20260709', 10, 11, 9, 10.5, 1.2, 100, 2.1),
        ('000001.SZ', '20260709', NULL, 12, NULL, 11, NULL, 200, NULL),
        ('600000.SH', '20260710', 10.5, NULL, 10, 11, 0.5, NULL, 1.8);
    `)

    expect(getDailyCloseQualitySummary(db)).toEqual({
      actualTradeDays: 2,
      totalRows: 3,
      earliestTradeDate: '20260709',
      latestTradeDate: '20260710',
      fields: {
        open: { missingRows: 1, missingRate: 1 / 3 },
        high: { missingRows: 1, missingRate: 1 / 3 },
        low: { missingRows: 1, missingRate: 1 / 3 },
        close: { missingRows: 0, missingRate: 0 },
        pctChg: { missingRows: 1, missingRate: 1 / 3 },
        vol: { missingRows: 1, missingRate: 1 / 3 },
        turnoverRate: { missingRows: 1, missingRate: 1 / 3 },
      },
      invalid: {
        nonPositiveCloseRows: 0,
        negativeVolumeRows: 0,
        invalidOhlcRows: 0,
        futureRows: 0,
      },
    })
    db.close()
  })

  it('空表质量摘要不把字段缺失率伪装为零', () => {
    const db = createQualityDb()
    const summary = getDailyCloseQualitySummary(db)

    expect(summary).toMatchObject({
      actualTradeDays: 0,
      totalRows: 0,
      earliestTradeDate: null,
      latestTradeDate: null,
    })
    expect(Object.values(summary.fields).every((field) => field.missingRate === null)).toBe(true)
    db.close()
  })

  it('增量行缺少换手率时保留已有非空值', () => {
    let preparedSql = ''
    const run = vi.fn()
    const db = {
      prepare(sql: string) {
        preparedSql = sql
        return { run }
      },
      transaction(callback: (items: unknown[]) => void) {
        return (items: unknown[]) => callback(items)
      },
    }

    upsertDailyClose(db as never, [{
      tsCode: '600000.SH',
      tradeDate: '20260710',
      open: null,
      high: null,
      low: null,
      close: 10,
      pctChg: 1,
      vol: null,
      turnoverRate: null,
    }])

    expect(preparedSql).toContain(
      'turnover_rate = COALESCE(excluded.turnover_rate, daily_close_cache.turnover_rate)',
    )
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      close: 10,
      turnover_rate: null,
    }))
  })

  it('只统计上市股票的换手率缺口并只补已有空值', () => {
    const db = createQualityDb()
    db.exec(`
      CREATE TABLE stock_basic_cache (
        ts_code TEXT PRIMARY KEY,
        list_status TEXT NOT NULL
      );
      INSERT INTO stock_basic_cache VALUES
        ('600487.SH', 'L'),
        ('000977.SZ', 'L'),
        ('600000.SH', 'D');
      INSERT INTO daily_close_cache VALUES
        ('600487.SH', '20260623', 10, 11, 9, 10.5, 1, 100, NULL),
        ('000977.SZ', '20260623', 20, 21, 19, 20.5, 1, 200, 3.2),
        ('600000.SH', '20260623', 8, 9, 7, 8.5, 1, 300, NULL),
        ('000001.SH', '20260623', 10, 10, 10, 10, 0, 400, NULL);
    `)

    expect(countMissingDailyCloseTurnoverByTradeDates(db, ['20260623'])).toEqual(
      new Map([['20260623', 1]]),
    )
    expect(backfillDailyCloseTurnover(db, [
      { tsCode: '600487.SH', tradeDate: '20260623', turnoverRate: 7.5, floatShare: 245000 },
      { tsCode: '000977.SZ', tradeDate: '20260623', turnoverRate: 9.9, floatShare: 146000 },
      { tsCode: '999999.SZ', tradeDate: '20260623', turnoverRate: 1, floatShare: 1 },
    ])).toBe(1)
    expect(db.prepare(`
      SELECT ts_code, turnover_rate FROM daily_close_cache
      WHERE ts_code IN ('600487.SH', '000977.SZ') ORDER BY ts_code
    `).all()).toEqual([
      { ts_code: '000977.SZ', turnover_rate: 3.2 },
      { ts_code: '600487.SH', turnover_rate: 7.5 },
    ])
    db.close()
  })

  it('精确日期查询不读取后续日期且同日优先使用带后缀代码', () => {
    let preparedSql = ''
    const all = vi.fn().mockReturnValue([
      {
        ts_code: '600000', trade_date: '20260710', open: 9, high: 11, low: 8,
        close: 9.5, pct_chg: 0, vol: 100, turnover_rate: 1,
      },
      {
        ts_code: '600000.SH', trade_date: '20260710', open: 9, high: 11, low: 8,
        close: 10, pct_chg: 1, vol: 100, turnover_rate: 1,
      },
    ])
    const db = {
      prepare(sql: string) {
        preparedSql = sql
        return { all }
      },
    }

    const rows = queryDailyCloseExact(db as never, ['600000.SH'], '20260710').get('600000.SH')

    expect(preparedSql).toContain('trade_date = ?')
    expect(preparedSql).not.toContain('trade_date >= ?')
    expect(all).toHaveBeenCalledWith('600000.SH', '600000', '20260710')
    expect(rows).toEqual([expect.objectContaining({ tsCode: '600000.SH', close: 10 })])
  })

  it('按有效交易日窗口统一清理边界日前的全部股票', () => {
    const db = createDailyCloseDb()
    const dates = buildWeekdayTradeDates(DAILY_CLOSE_RETENTION_TRADE_DAYS + 10)
    seedTradeDates(db, dates, ['600000.SH', '000001.SZ'])

    const removed = cleanupDailyCloseCache(db)
    const summary = db.prepare(`
      SELECT COUNT(*) AS rows, COUNT(DISTINCT trade_date) AS trade_days, MIN(trade_date) AS min_date
      FROM daily_close_cache
    `).get() as { rows: number; trade_days: number; min_date: string }
    const boundaryRows = db
      .prepare('SELECT COUNT(*) AS count FROM daily_close_cache WHERE trade_date = ?')
      .get(dates[10]) as { count: number }

    expect(removed).toBe(20)
    expect(summary).toEqual({
      rows: DAILY_CLOSE_RETENTION_TRADE_DAYS * 2,
      trade_days: DAILY_CLOSE_RETENTION_TRADE_DAYS,
      min_date: dates[10],
    })
    expect(boundaryRows.count).toBe(2)
    db.close()
  })

  it.each([
    DAILY_CLOSE_RETENTION_TRADE_DAYS - 1,
    DAILY_CLOSE_RETENTION_TRADE_DAYS,
  ])('缓存只有 %i 个有效交易日时不删除数据', (tradeDayCount) => {
    const db = createDailyCloseDb()
    const dates = buildWeekdayTradeDates(tradeDayCount)
    seedTradeDates(db, dates)

    expect(cleanupDailyCloseCache(db)).toBe(0)
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM daily_close_cache').get() as { count: number }).count,
    ).toBe(tradeDayCount)
    db.close()
  })

  it.each([0, -1, 1.5])('拒绝非法保留交易日数量 %s', (retainTradeDays) => {
    const db = createDailyCloseDb()
    expect(() => cleanupDailyCloseCache(db, retainTradeDays)).toThrow(
      'retainTradeDays must be a positive integer',
    )
    db.close()
  })
})
