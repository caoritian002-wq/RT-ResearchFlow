import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import {
  getStockFundamentalSourceState,
  listLatestStockFundamentalAnnouncements,
  listLatestStockFundamentalFinancials,
  recordStockFundamentalSyncFailure,
  recordStockFundamentalSyncSuccess,
  replaceStockFundamentalAnnouncements,
  saveStockFundamentalFinancials,
  type StockFundamentalAnnouncementRecord,
  type StockFundamentalFinancial,
} from '../../electron/main/database/stockFundamentalRepository'

function financial(overrides: Partial<StockFundamentalFinancial> = {}): StockFundamentalFinancial {
  return {
    tsCode: '600519.SH',
    stockCode: '600519',
    shortName: '贵州茅台',
    reportDate: '20251231',
    reportType: '年报',
    noticeDate: '20260330',
    updateDate: '20260330',
    currency: 'CNY',
    totalRevenue: 100,
    parentNetProfit: 50,
    deductedNetProfit: 48,
    revenueYoy: 10,
    parentNetProfitYoy: 12,
    deductedNetProfitYoy: 11,
    weightedRoe: 20,
    grossMargin: 90,
    netMargin: 50,
    debtRatio: 15,
    operatingCashFlow: 60,
    basicEps: 2,
    bookValuePerShare: 10,
    source: 'eastmoney-main-finance',
    sourceVersion: 'v1',
    fetchedAt: 1000,
    ...overrides,
  }
}

function announcement(
  overrides: Partial<StockFundamentalAnnouncementRecord> = {},
): StockFundamentalAnnouncementRecord {
  return {
    tsCode: '600519.SH',
    stockCode: '600519',
    shortName: '贵州茅台',
    articleCode: 'AN202607200001',
    title: '贵州茅台重大事项公告',
    noticeDate: '20260720',
    displayAt: 2000,
    categoryCodes: ['001002008'],
    categoryNames: ['其他'],
    source: 'eastmoney-announcement-index',
    sourceUrl: 'https://data.eastmoney.com/notices/detail/600519/AN202607200001.html',
    fetchedAt: 3000,
    ...overrides,
  }
}

describe('FR-253 stock fundamental repository', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db, DATABASE_MIGRATIONS.filter(
      (migration) => migration.version === 118 || migration.version === 119,
    ))
  })

  afterEach(() => {
    db.close()
  })

  it('keeps source versions and returns the newest version for each report period', () => {
    saveStockFundamentalFinancials(db, [
      financial(),
      financial({ sourceVersion: 'v2', updateDate: '20260401', totalRevenue: 101, fetchedAt: 2000 }),
      financial({ reportDate: '20250930', reportType: '三季报', noticeDate: '20251025', sourceVersion: 'q3' }),
    ])

    const rows = listLatestStockFundamentalFinancials(db, '600519.SH', 8)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ reportDate: '20251231', sourceVersion: 'v2', totalRevenue: 101 })
    expect(rows[1]).toMatchObject({ reportDate: '20250930', sourceVersion: 'q3' })

    saveStockFundamentalFinancials(db, [financial({ fetchedAt: 3000 })])
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM stock_fundamental_financials',
    ).get()).toEqual({ count: 3 })
    expect(db.prepare(`
      SELECT fetched_at FROM stock_fundamental_financials
      WHERE ts_code = '600519.SH' AND report_date = '20251231' AND source_version = 'v1'
    `).get()).toEqual({ fetched_at: 3000 })
  })

  it('reports a failed latest attempt while preserving the prior success metadata and facts', () => {
    recordStockFundamentalSyncSuccess(db, '600519.SH', 'financial', 1000, '20260330', 1)
    recordStockFundamentalSyncFailure(db, '600519.SH', 'financial', 2000, 'FINANCIAL_HTTP_ERROR')

    expect(getStockFundamentalSourceState(
      db,
      '600519.SH',
      'financial',
      true,
      '20260330',
    )).toEqual({
      status: 'failed',
      lastAttemptAt: 2000,
      lastSuccessAt: 1000,
      factDate: '20260330',
      errorCode: 'FINANCIAL_HTTP_ERROR',
      rowsWritten: 0,
    })
    expect(getStockFundamentalSourceState(db, '000001.SZ', 'profile', false, null).status).toBe('missing')
  })

  it('replaces the bounded announcement index and restores structured categories', () => {
    replaceStockFundamentalAnnouncements(db, '600519.SH', [
      announcement(),
      announcement({
        articleCode: 'AN202607100001',
        title: '贵州茅台权益分派公告',
        noticeDate: '20260710',
        categoryCodes: ['001002002001005'],
        categoryNames: ['分配方案实施'],
      }),
    ])

    expect(listLatestStockFundamentalAnnouncements(db, '600519.SH')).toMatchObject([
      {
        articleCode: 'AN202607200001',
        categoryCodes: ['001002008'],
        categoryNames: ['其他'],
      },
      {
        articleCode: 'AN202607100001',
        categoryCodes: ['001002002001005'],
        categoryNames: ['分配方案实施'],
      },
    ])

    replaceStockFundamentalAnnouncements(db, '600519.SH', [
      announcement({ articleCode: 'AN202607210001', noticeDate: '20260721' }),
    ])
    expect(listLatestStockFundamentalAnnouncements(db, '600519.SH')).toHaveLength(1)
    expect(listLatestStockFundamentalAnnouncements(db, '600519.SH')[0].articleCode).toBe('AN202607210001')

    replaceStockFundamentalAnnouncements(db, '600519.SH', [])
    recordStockFundamentalSyncSuccess(db, '600519.SH', 'announcement', 4000, null, 0)
    expect(listLatestStockFundamentalAnnouncements(db, '600519.SH')).toEqual([])
    expect(getStockFundamentalSourceState(db, '600519.SH', 'announcement', false, null)).toMatchObject({
      status: 'available',
      rowsWritten: 0,
    })
  })
})
