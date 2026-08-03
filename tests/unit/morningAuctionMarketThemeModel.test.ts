import { describe, expect, it } from 'vitest'
import type { MorningAuctionThemeAttribution, MorningAuctionThemeEvidence } from '../../electron/main/database/types'
import {
  buildMorningAuctionMarketThemes,
  type MorningAuctionMarketThemeStockInput,
} from '../../electron/main/services/morningAuctionMarketThemeModel'
import type { SectorFlowItem, SectorFlowStock } from '../../electron/main/services/sectorFlowTypes'

function evidence(name: string, direct = false): MorningAuctionThemeEvidence {
  return {
    name,
    score: 80,
    direct,
    peerCount: 1,
    activePeerCount: 1,
    averageAuctionPct: 4,
    totalAuctionAmount: 2_000,
    peers: [],
    basis: [],
  }
}

function attribution(primary: string, options: { direct?: boolean; resonance?: string[] } = {}): MorningAuctionThemeAttribution {
  return {
    state: options.direct ? 'direct' : 'resonance',
    confidence: 'high',
    primary: evidence(primary, options.direct),
    resonance: (options.resonance ?? []).map((name) => evidence(name)),
    staticThemes: [],
    allThemes: [primary, ...(options.resonance ?? [])],
    directReason: options.direct ? '上一交易日直接题材' : null,
    sourceTradeDate: options.direct ? '20260722' : null,
    summary: '测试归因',
  }
}

function stock(
  tsCode: string,
  stockName: string,
  theme: string,
  pctChg = 4,
  auctionAmount = 1_000,
  options: { direct?: boolean; resonance?: string[] } = {},
): MorningAuctionMarketThemeStockInput {
  return { tsCode, stockName, pctChg, auctionAmount, attribution: attribution(theme, options) }
}

function coreStock(tsCode: string, name: string): SectorFlowStock {
  return { tsCode, name, change: 3, totalAmount: 100, mainNetInflow: 50, mainNetInflowRate: 5 }
}

function flow(
  mainNetInflow: number,
  options: { boardName?: string; boardCode?: string; coreStocks?: SectorFlowStock[] } = {},
): SectorFlowItem {
  return {
    boardCode: options.boardCode ?? 'BK1000',
    boardName: options.boardName ?? '算力',
    scope: 'concept',
    metricMode: 'verified_flow',
    totalAmount: 10_000_000_000,
    turnoverDirectionStrength: null,
    mainNetInflow,
    mainNetInflowRate: mainNetInflow / 10_000_000_000 * 100,
    superLargeNetInflow: null,
    superLargeNetInflowRate: null,
    largeNetInflow: null,
    largeNetInflowRate: null,
    mediumNetInflow: null,
    mediumNetInflowRate: null,
    smallNetInflow: null,
    smallNetInflowRate: null,
    weightedChange: mainNetInflow >= 0 ? 2 : -2,
    totalMarketCap: null,
    memberCount: 10,
    upCount: mainNetInflow >= 0 ? 8 : 3,
    downCount: mainNetInflow >= 0 ? 2 : 7,
    flatCount: 0,
    previousMainNetInflow: null,
    leader: null,
    coreStocks: options.coreStocks ?? [],
    relatedThemes: [],
    sourceUpdatedAt: null,
  }
}

describe('morningAuctionMarketThemeModel', () => {
  const broadAuction = [
    stock('600001.SH', '候选甲', '算力', 5, 1_600, { direct: true }),
    stock('600002.SH', '候选乙', '算力', 4, 1_200),
    stock('600003.SH', '候选丙', '算力', 3, 800),
  ]

  it('昨日流入与今日多股竞价共振形成延续确认', () => {
    const result = buildMorningAuctionMarketThemes(broadAuction, [flow(600_000_000)], '20260722')
    expect(result).toMatchObject({ status: 'ready', flowTradeDate: '20260722', attributedStockCount: 3 })
    expect(result.themes[0]).toMatchObject({
      name: '算力',
      state: 'confirmed_continuation',
      auction: { activeCandidateCount: 3, medianPctChg: 4 },
      flow: { tradeDate: '20260722', matchKind: 'name', mainNetInflow: 600_000_000 },
    })
  })

  it('昨日流入但只有单股高开时保持延续未确认', () => {
    const result = buildMorningAuctionMarketThemes([
      stock('600001.SH', '孤立候选', '算力', 6, 2_000, { direct: true }),
    ], [flow(600_000_000)], '20260722')
    expect(result.themes[0].state).toBe('unconfirmed_continuation')
    expect(result.themes[0].risks.join('')).toContain('尚未得到多股竞价扩散确认')
  })

  it('昨日流出但今日多股转强时标记新轮动线索', () => {
    const result = buildMorningAuctionMarketThemes(broadAuction, [flow(-400_000_000)], '20260722')
    expect(result.themes[0].state).toBe('new_rotation')
  })

  it('昨日流出且单股孤立高开时标记持续性存疑', () => {
    const result = buildMorningAuctionMarketThemes([
      stock('600001.SH', '孤立候选', '算力', 6, 2_000, { direct: true }),
    ], [flow(-400_000_000)], '20260722')
    expect(result.themes[0]).toMatchObject({ state: 'isolated_risk' })
  })

  it('没有昨日真实资金但多股共振时只输出竞价转强', () => {
    const result = buildMorningAuctionMarketThemes(broadAuction, [], null)
    expect(result.status).toBe('no_verified_flow')
    expect(result.themes[0]).toMatchObject({ state: 'auction_only', flow: null })
  })

  it('按核心股票重合合并不同口径题材并优先显示资金板块名', () => {
    const stocks = [
      stock('600001.SH', '光模块甲', 'CPO', 5, 1_600, { resonance: ['光模块'] }),
      stock('600002.SH', '光模块乙', '光模块', 4, 1_200, { resonance: ['CPO'] }),
    ]
    const result = buildMorningAuctionMarketThemes(stocks, [flow(500_000_000, {
      boardName: '光模块',
      coreStocks: [coreStock('600001.SH', '光模块甲'), coreStock('600002.SH', '光模块乙')],
    })], '20260722')

    expect(result.themes).toHaveLength(1)
    expect(result.themes[0]).toMatchObject({
      name: '光模块',
      aliases: expect.arrayContaining(['CPO', '光模块']),
      state: 'confirmed_continuation',
    })
    expect(result.themes[0].stockCodes).toHaveLength(2)
  })
})
