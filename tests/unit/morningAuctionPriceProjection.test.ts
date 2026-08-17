import { describe, expect, it } from 'vitest'
import {
  applyMorningAuctionCloseProjection,
  isCurrentMorningAuctionTradeDate,
  type MorningAuctionProjectedStock,
} from '../../electron/main/services/morningAuctionPriceProjection'

function stock(
  tsCode: string,
  currentPrice: number | null = null,
  currentPctChg: number | null = null,
  currentAmount: number | null = null,
): MorningAuctionProjectedStock {
  return { tsCode, currentPrice, currentPctChg, currentAmount }
}

describe('FR-269 早盘历史交易日收盘价投影', () => {
  it('历史日期使用目标日收盘覆盖残留实时价并清除跨日成交额', () => {
    const stocks = [
      stock('002483.SZ', 99, 9.9, 88_000_000),
      stock('600602.SH', 88, 8.8, 77_000_000),
      stock('000001.SZ', 77, 7.7, 66_000_000),
    ]
    applyMorningAuctionCloseProjection(stocks, new Map([
      ['002483.SZ', { close: 5.76, pctChg: 0.1739 }],
      ['600602.SH', { close: 19.36, pctChg: -4.3951 }],
    ]), { replaceExisting: true })

    expect(stocks).toEqual([
      stock('002483.SZ', 5.76, 0.1739, null),
      stock('600602.SH', 19.36, -4.3951, null),
      stock('000001.SZ', null, null, null),
    ])
  })

  it('当前日期收盘事实只补空值，不覆盖同日实时行情', () => {
    const stocks = [
      stock('002483.SZ', 5.8, 0.87, 12_000_000),
      stock('600602.SH'),
    ]
    applyMorningAuctionCloseProjection(stocks, new Map([
      ['002483.SZ', { close: 5.76, pctChg: 0.1739 }],
      ['600602.SH', { close: 19.36, pctChg: -4.3951 }],
    ]), { replaceExisting: false })

    expect(stocks).toEqual([
      stock('002483.SZ', 5.8, 0.87, 12_000_000),
      stock('600602.SH', 19.36, -4.3951, null),
    ])
  })

  it('只有目标交易日等于北京时间当天时才允许实时行情覆盖', () => {
    expect(isCurrentMorningAuctionTradeDate('20260813', '20260816')).toBe(false)
    expect(isCurrentMorningAuctionTradeDate('20260816', '20260816')).toBe(true)
  })
})
