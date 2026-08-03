import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import { upsertDailyClose } from '../../electron/main/database/dailyCloseCacheRepository'
import {
  batchAddTrendWatchStocks,
  getAllTrendWatchStocks,
  updateTrendWatchGroupTag,
} from '../../electron/main/database/trendWatchlistRepository'
import { insertTrendAlert } from '../../electron/main/database/trendAlertsRepository'

const sharedQuote = vi.hoisted(() => ({
  cache: new Map<string, {
    name: string | null
    change: number
    price: number
    amount: number
    preClose: number
    vol: number
    bidPrice1: number | null
    bidVolume1: number | null
  }>(),
  cachedAt: Date.now(),
}))

vi.mock('../../electron/main/services/sharedRtKCache', () => ({
  getRtKCache: () => sharedQuote.cache,
  getRtKCachedAt: () => sharedQuote.cachedAt,
}))

import { computeTrendScoresOnDemand } from '../../electron/main/services/trendWatchlistService'
import { deriveEventState, getTrendWorkbench } from '../../electron/main/services/trendWorkbenchService'

describe('trendWorkbenchService', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    db.exec('DELETE FROM trend_watchlist; DELETE FROM trend_scores; DELETE FROM trend_alerts; DELETE FROM daily_close_cache; DELETE FROM portfolio_stocks;')
    sharedQuote.cache.clear()
  })

  afterEach(() => (db as Database.Database | undefined)?.close())

  it('deduplicates multi-track registrations and calculates 5/20-session score changes', () => {
    batchAddTrendWatchStocks(db, [
      { tsCode: '600001.SH', stockName: '测试股份', groupTag: '核心', category: 'PCB', subCategory: '服务器PCB' },
      { tsCode: '600001.SH', stockName: '测试股份', groupTag: '复核', category: '半导体材料', subCategory: '封装材料' },
    ])
    seedBars(db, '000300.SH', 90, 100, 0.15)
    seedBars(db, '600001.SH', 90, 20, 0.22)
    sharedQuote.cache.set('600001.SH', {
      name: '测试股份',
      change: 1.25,
      price: 41,
      amount: 10_000,
      preClose: 40.5,
      vol: 2_000,
      bidPrice1: null,
      bidVolume1: null,
    })

    computeTrendScoresOnDemand(db)
    const snapshot = getTrendWorkbench(db)

    expect(snapshot.items).toHaveLength(1)
    const item = snapshot.items[0]
    expect(item.categories).toEqual(expect.arrayContaining(['PCB', '半导体材料']))
    expect(item.subCategories).toEqual(expect.arrayContaining(['服务器PCB', '封装材料']))
    expect(item.scoreHistory.length).toBeGreaterThan(20)
    expect(item.scoreDelta5d).toBeCloseTo(
      item.scoreHistory.at(-1)!.totalScore - item.scoreHistory.at(-6)!.totalScore,
      8,
    )
    expect(item.scoreDelta20d).toBeCloseTo(
      item.scoreHistory.at(-1)!.totalScore - item.scoreHistory.at(-21)!.totalScore,
      8,
    )
    expect(snapshot.dataHealth.benchmark).toMatchObject({
      state: 'current',
      latestTradeDate: expect.stringMatching(/^\d{8}$/),
      bars: 90,
      refreshOutcome: 'not-requested',
      attempted: false,
    })
    expect(item.benchmarkHealth).toEqual(snapshot.dataHealth.benchmark)
  })

  it('keeps the EOD score timestamp separate from a realtime quote timestamp', () => {
    batchAddTrendWatchStocks(db, [{ tsCode: '600002.SH', stockName: '来源测试', category: '测试', subCategory: '来源' }])
    seedBars(db, '000300.SH', 90, 100, 0.1)
    const dates = seedBars(db, '600002.SH', 90, 30, 0.12)
    sharedQuote.cache.set('600002.SH', {
      name: '来源测试',
      change: 2.1,
      price: 42,
      amount: 10_000,
      preClose: 41,
      vol: 2_000,
      bidPrice1: null,
      bidVolume1: null,
    })

    computeTrendScoresOnDemand(db)
    const item = getTrendWorkbench(db).items[0]

    expect(item.scoreSource).toBe('eod')
    expect(item.scoreDate).toBe(dates.at(-1))
    expect(item.quoteSource).toBe('realtime')
    expect(item.quoteTime).toMatch(/^\d{2}:\d{2}$/)
    expect(item.price).toBe(42)
  })

  it('derives whether a historical event still holds or has recovered', () => {
    expect(deriveEventState('BREAK_MA60', 12, 11, false)).toBe('active')
    expect(deriveEventState('BREAK_MA60', 12, 11, true)).toBe('recovered')
    expect(deriveEventState('BREAK_HIGH20', 12, 11, null)).toBe('active')
    expect(deriveEventState('BREAK_HIGH20', 10, 11, null)).toBe('recovered')
    expect(deriveEventState('STOP_LOSS_5PCT', 9.4, 10, null)).toBe('active')
    expect(deriveEventState('STOP_LOSS_5PCT', null, 10, null)).toBe('unknown')
  })

  it('updates the group for every track registered under the same stock', () => {
    batchAddTrendWatchStocks(db, [
      { tsCode: '600003.SH', stockName: '多赛道', groupTag: '旧分组', category: 'A', subCategory: 'A1' },
      { tsCode: '600003.SH', stockName: '多赛道', groupTag: '旧分组', category: 'B', subCategory: 'B1' },
    ])

    expect(updateTrendWatchGroupTag(db, '600003.SH', '新分组')).toBe(2)
    expect(getAllTrendWatchStocks(db).map((row) => row.groupTag)).toEqual(['新分组', '新分组'])
  })

  it('projects alert prices and current states into the workbench event ledger', () => {
    batchAddTrendWatchStocks(db, [{ tsCode: '600004.SH', stockName: '事件测试', category: '测试', subCategory: '事件' }])
    seedBars(db, '000300.SH', 90, 100, 0.1)
    seedBars(db, '600004.SH', 90, 20, 0.25)
    sharedQuote.cache.set('600004.SH', {
      name: '事件测试', change: 1, price: 45, amount: 1, preClose: 44, vol: 1, bidPrice1: null, bidVolume1: null,
    })
    insertTrendAlert(db, {
      tsCode: '600004.SH',
      stockName: '事件测试',
      alertType: 'BREAK_HIGH20',
      alertDate: ymdOffset(0),
      price: 40,
      refPrice: 39,
      createdAt: Date.now(),
    })

    computeTrendScoresOnDemand(db)
    const event = getTrendWorkbench(db).events[0]

    expect(event.kind).toBe('opportunity')
    expect(event.currentState).toBe('active')
    expect(event.currentPrice).toBe(45)
    expect(event.changeSinceTrigger).toBeCloseTo(12.5, 8)
  })
})

function seedBars(db: Database.Database, tsCode: string, count: number, start: number, step: number): string[] {
  const dates = Array.from({ length: count }, (_, index) => ymdOffset(index - count + 1))
  upsertDailyClose(db, dates.map((tradeDate, index) => {
    const close = start + step * index
    return {
      tsCode,
      tradeDate,
      open: close - 0.1,
      high: close + 0.3,
      low: close - 0.3,
      close,
      pctChg: index === 0 ? 0 : step / (close - step) * 100,
      vol: 1_000_000 + index * 1_000,
      turnoverRate: 1 + index % 4 * 0.05,
    }
  }))
  return dates
}

function ymdOffset(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000)
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
}
