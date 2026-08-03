import { describe, expect, it } from 'vitest'
import {
  buildAuctionBacktestConclusion,
  buildAuctionBacktestPoolSummaries,
  buildAuctionBacktestSummary,
  filterAuctionBacktestDetails,
  getAuctionBacktestAvailability,
  type AuctionBacktestDetail,
} from '../../src/components/shared/auctionBacktestViewModel'

const tradeDates = ['20260717', '20260720', '20260721', '20260722', '20260723']
const context = { tradeDates, latestCloseTradeDate: '20260723' }

function row(overrides: Partial<AuctionBacktestDetail> = {}): AuctionBacktestDetail {
  return {
    tradeDate: '20260720',
    tsCode: '600000.SH',
    stockName: '浦发银行',
    pool: 'brokenBoard',
    buyPrice: 10,
    ret1d: 2,
    ret2d: 3,
    ret3d: -1,
    ret5d: null,
    computedAt: 1,
    isOneWord: 0,
    idxRet1d: 1,
    idxRet2d: 1,
    idxRet3d: -0.5,
    idxRet5d: null,
    ...overrides,
  }
}

describe('auctionBacktestViewModel', () => {
  it('区分已成熟、待到期和已成熟但缺数据', () => {
    expect(getAuctionBacktestAvailability(row(), 1, context)).toBe('available')
    expect(getAuctionBacktestAvailability(row({ tradeDate: '20260722', ret2d: null }), 2, context)).toBe('pending')
    expect(getAuctionBacktestAvailability(row({ tradeDate: '20260720', ret2d: null }), 2, context)).toBe('missing')
  })

  it('胜率和收益只使用已成熟样本，但保留完整性缺口', () => {
    const summary = buildAuctionBacktestSummary([
      row({ ret1d: 2 }),
      row({ tsCode: '600001.SH', ret1d: -1 }),
      row({ tsCode: '600002.SH', tradeDate: '20260722', ret1d: null }),
      row({ tsCode: '600003.SH', tradeDate: '20260720', ret1d: null }),
    ], 1, context)

    expect(summary).toMatchObject({
      signalCount: 4,
      validCount: 2,
      pendingCount: 0,
      missingCount: 2,
      winRate: 50,
      avgReturn: 0.5,
      coverageRate: 0.5,
    })
  })

  it('池比较会单独说明被排除的一字板，不用零样本冒充无效策略', () => {
    const summaries = buildAuctionBacktestPoolSummaries([
      row({ pool: 'firstBoard', isOneWord: 1 }),
      row({ pool: 'brokenBoard', isOneWord: 0 }),
    ], 1, true, context)
    const firstBoard = summaries.find((item) => item.pool === 'firstBoard')!

    expect(firstBoard.rawCount).toBe(1)
    expect(firstBoard.signalCount).toBe(0)
    expect(firstBoard.excludedOneWordCount).toBe(1)
  })

  it('结论只在满足最小成熟样本后比较超额收益', () => {
    const details = Array.from({ length: 12 }, (_, index) => row({
      tsCode: `6000${String(index).padStart(2, '0')}.SH`,
      pool: 'brokenBoard',
      ret1d: 3,
      idxRet1d: 1,
    }))
    const summaries = buildAuctionBacktestPoolSummaries(details, 1, true, context)
    const conclusion = buildAuctionBacktestConclusion(summaries, 1)

    expect(conclusion.leaderPool).toBe('brokenBoard')
    expect(conclusion.title).toContain('炸板回封')
    expect(conclusion.detail).toContain('12 个成熟样本')
  })

  it('明细搜索、池筛选和收益排序可组合', () => {
    const result = filterAuctionBacktestDetails([
      row({ tsCode: '600001.SH', stockName: '甲', ret1d: 1 }),
      row({ tsCode: '600002.SH', stockName: '乙', ret1d: 5 }),
      row({ tsCode: '600003.SH', stockName: '乙二', pool: 'allMarket', ret1d: 9 }),
    ], {
      pool: 'brokenBoard',
      excludeOneWord: true,
      query: '乙',
      sortMode: 'return',
      horizon: 1,
    })

    expect(result.map((item) => item.tsCode)).toEqual(['600002.SH'])
  })
})
