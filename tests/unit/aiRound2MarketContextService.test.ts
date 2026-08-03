import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import { upsertDailyClose } from '../../electron/main/database/dailyCloseCacheRepository'
import { insertPrices, upsertStockInfo } from '../../electron/main/database/stockPriceCacheRepository'
import {
  ROUND2_MARKET_BLOCKED_MARKER,
  buildRound2MarketBlockedResponse,
  prepareArticleRound2MarketContext,
} from '../../electron/main/services/aiRound2MarketContextService'

let db: Database.Database | null = null

function openDb(): Database.Database {
  db = new Database(':memory:')
  runMigrations(db)
  return db
}

function seedDaily(database: Database.Database, tsCode: string, count: number, startPrice = 10): void {
  upsertDailyClose(database, Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(2026, 5, 1 + index))
    const tradeDate = date.toISOString().slice(0, 10).replace(/-/g, '')
    const close = startPrice + index * 0.2
    return {
      tsCode,
      tradeDate,
      open: close - 0.1,
      high: close + 0.5,
      low: close - 0.6,
      close,
      pctChg: index === 0 ? 0 : 1,
      vol: 1000 + index,
      turnoverRate: 1,
    }
  }))
}

afterEach(() => {
  db?.close()
  db = null
})

describe('FR-240 第二轮真实行情上下文', () => {
  it('无Tushare配置时直接使用本地日线完成近期走势和价位口径', async () => {
    const database = openDb()
    upsertStockInfo(database, '300012', '华测检测')
    seedDaily(database, '300012.SZ', 30, 10)

    const result = await prepareArticleRound2MarketContext(database, ['300012'], null)

    expect(result).toEqual(expect.objectContaining({
      status: 'ready',
      availableCodes: ['300012'],
      missingCodes: [],
      latestTradeDate: '20260630',
      refreshAttempted: false,
    }))
    expect(result.markdown).toContain('300012｜华测检测')
    expect(result.markdown).toContain('数据截止：2026-06-30')
    expect(result.markdown).toContain('MA5')
    expect(result.markdown).toContain('近20日最低价')
    expect(result.markdown).toContain('近20日最高价')
    expect(result.markdown).toContain('不是预测目标、止损位或交易指令')
  })

  it('合并个股行情缓存中的较新交易日并限制为最近30个有效样本', async () => {
    const database = openDb()
    seedDaily(database, '300012.SZ', 30, 10)
    insertPrices(database, [{
      stockCode: '300012',
      tradeDate: '20260717',
      open: 20,
      high: 21,
      low: 19,
      close: 20.5,
      volume: 2000,
      amount: 3000,
      fetchedAt: Date.now(),
    }])

    const result = await prepareArticleRound2MarketContext(database, ['300012'], null)

    expect(result.latestTradeDate).toBe('20260717')
    expect(result.markdown).toContain('2026-06-02 至 2026-07-17，30 个有效交易日')
    expect(result.markdown).toContain('| 2026-07-17 | 20 | 21 | 19 | 20.5 | 2000 |')
  })

  it('部分候选行情不足时只允许复核可用股票并明确缺口', async () => {
    const database = openDb()
    seedDaily(database, '300012.SZ', 30)
    seedDaily(database, '002967.SZ', 5)

    const result = await prepareArticleRound2MarketContext(database, ['300012', '002967'], null)

    expect(result.status).toBe('partial')
    expect(result.availableCodes).toEqual(['300012'])
    expect(result.missingCodes).toEqual(['002967'])
    expect(result.markdown).toContain('002967；不得为这些股票补写走势或价位')
  })

  it('完全没有足够OHLC时生成阻断事实且不伪造技术位', async () => {
    const database = openDb()
    const context = await prepareArticleRound2MarketContext(database, ['300012'], null)
    const response = buildRound2MarketBlockedResponse(context)

    expect(context.status).toBe('blocked')
    expect(context.markdown).toBe('')
    expect(response).toContain('未调用 AI 生成走势、支撑位或压力位结论')
    expect(response).toContain('补齐近期日线数据后')
    expect(response).toContain(ROUND2_MARKET_BLOCKED_MARKER)
  })
})
