import { describe, expect, it } from 'vitest'
import {
  buildMorningAuctionFocusEvidence,
  buildMorningAuctionThemeTableDisplay,
  buildMorningAuctionWorkbench,
  getChipSyncPlaceholder,
  hasSameDayChipEvidence,
  isMorningAuctionMarketThemeRuntimeOutdated,
  resolveChipConclusionPctChg,
  type MorningAuctionChipEntry,
  type MorningAuctionSnapshotLike,
  type MorningAuctionThemeAttribution,
} from '../../src/components/ShortTermStrategy/morningAuctionViewModel'

function createStock() {
  return {
    tsCode: '600000.SH',
    stockCode: '600000',
    stockName: '测试股份',
    auctionPrice: 10.5,
    pctChg: 5,
    auctionAmount: 2000,
    auctionTurnover: 1,
    currentPrice: 10.8,
    currentPctChg: 8,
    currentAmount: 300000000,
    pctChg3d: 8,
    pctChg5d: 12,
    conceptNames: ['测试题材'],
  }
}

function createSnapshot(): MorningAuctionSnapshotLike {
  const empty: ReturnType<typeof createStock>[] = []
  return {
    threeOne: {
      firstBoard: [createStock()],
      secondBoard: empty,
      brokenBoard: empty,
      brokenConsec: empty,
      allMarket: empty,
    },
    weakToStrong: {
      badBoard: empty,
      tailAttack: empty,
      brokenBoard: empty,
      afternoonReseal: empty,
      reversal: empty,
    },
    boardCategory: {
      first: empty,
      second: empty,
      third: empty,
      n: empty,
    },
  }
}

function createChipEntry(overrides: Partial<MorningAuctionChipEntry> = {}): MorningAuctionChipEntry {
  return {
    tradeDate: '20260710',
    dateRelation: 'same_day',
    winnerRate: 68,
    thickProfitPct: 24,
    trappedPct: 32,
    concentration: 62,
    costDeviationPct: 4,
    loosening1d: 15,
    loosening3d: 8,
    loosening5d: 5,
    bottomPct: 30,
    pctChg: 3,
    turnoverRate: 4,
    completenessStatus: 'complete',
    consistencyStatus: 'matched',
    ...overrides,
  }
}

describe('morningAuctionViewModel', () => {
  it('只把已加载快照但缺少主线字段识别为旧主进程', () => {
    expect(isMorningAuctionMarketThemeRuntimeOutdated(false, undefined)).toBe(false)
    expect(isMorningAuctionMarketThemeRuntimeOutdated(true, undefined)).toBe(true)
    expect(isMorningAuctionMarketThemeRuntimeOutdated(true, null)).toBe(true)
    expect(isMorningAuctionMarketThemeRuntimeOutdated(true, {
      status: 'no_auction_theme',
      flowTradeDate: null,
      candidateStockCount: 0,
      attributedStockCount: 0,
      coverageRate: null,
      summary: '当前竞价候选不足以形成市场主线。',
      themes: [],
    })).toBe(false)
  })

  it('区分未同步、同步中和同步后无数据', () => {
    expect(getChipSyncPlaceholder(false, false)).toBe('未同步')
    expect(getChipSyncPlaceholder(true, true)).toBe('同步中')
    expect(getChipSyncPlaceholder(true, false)).toBe('同步无数据')
  })

  it('只有同日筹码摘要参与回退排序与覆盖统计', () => {
    const sameDay = buildMorningAuctionWorkbench(
      createSnapshot(),
      new Map([['600000.SH', createChipEntry()]]),
    )
    const history = buildMorningAuctionWorkbench(
      createSnapshot(),
      new Map([['600000.SH', createChipEntry({ tradeDate: '20260709', dateRelation: 'history' })]]),
    )

    expect(sameDay.candidates[0].rankScore - history.candidates[0].rankScore).toBe(8)
    expect(sameDay.chipCoveredCount).toBe(1)
    expect(history.chipCoveredCount).toBe(0)
    expect(sameDay.candidates[0].riskFlags).toContain('筹码松动')
    expect(history.candidates[0].riskFlags).not.toContain('筹码松动')
    expect(history.candidates[0].tags).toContain('历史筹码参考')
    expect(history.candidates[0].verificationItems).toContain('仅有 20260709 筹码证据, 不作为当日确认项')
  })

  it('同日空摘要不计入排序、覆盖和有效证据筛选', () => {
    const emptyEntry = createChipEntry({
      winnerRate: null,
      thickProfitPct: null,
      trappedPct: null,
      concentration: null,
      costDeviationPct: null,
      loosening1d: null,
      loosening3d: null,
      loosening5d: null,
      bottomPct: null,
    })
    const withoutChip = buildMorningAuctionWorkbench(createSnapshot(), new Map())
    const withEmptyChip = buildMorningAuctionWorkbench(
      createSnapshot(),
      new Map([['600000.SH', emptyEntry]]),
    )

    expect(hasSameDayChipEvidence(emptyEntry)).toBe(false)
    expect(withEmptyChip.candidates[0].rankScore).toBe(withoutChip.candidates[0].rankScore)
    expect(withEmptyChip.chipCoveredCount).toBe(0)
  })

  it('历史筹码结论使用事实日自身涨跌幅', () => {
    const history = createChipEntry({ tradeDate: '20260709', dateRelation: 'history', pctChg: -2 })
    const sameDay = createChipEntry({ pctChg: 3 })

    expect(resolveChipConclusionPctChg(history, 8)).toBe(-2)
    expect(resolveChipConclusionPctChg(sameDay, 8)).toBe(8)
  })

  it('主研判按当前股票真实字段生成三类重点证据', () => {
    const workbench = buildMorningAuctionWorkbench(createSnapshot(), new Map())
    const evidence = buildMorningAuctionFocusEvidence(workbench.candidates[0])

    expect(evidence.map(item => item.key)).toEqual(['auction', 'momentum', 'concept'])
    expect(evidence[0].text).toContain('竞价涨幅 +5.00%')
    expect(evidence[0].text).toContain('竞价金额 2000万')
    expect(evidence[1].text).toContain('3日涨跌 +8.00%')
    expect(evidence[1].text).toContain('5日涨跌 +12.00%')
    expect(evidence[2].text).toContain('静态关联题材')
    expect(evidence[2].text).toContain('主炒题材仍待确认')
  })

  it('题材列优先展示主炒、共振并把其余题材收进详情', () => {
    const stock = {
      ...createStock(),
      themeAttribution: {
      state: 'direct',
      confidence: 'high',
      primary: {
        name: '算力', score: 96, direct: true, peerCount: 3, activePeerCount: 2,
        averageAuctionPct: 4.5, totalAuctionAmount: 5000, peers: [], basis: ['直接题材记录'],
      },
      resonance: [{
        name: '液冷服务器', score: 44, direct: false, peerCount: 2, activePeerCount: 1,
        averageAuctionPct: 3.8, totalAuctionAmount: 2600, peers: [], basis: ['另有 1 只竞价候选共振'],
      }],
      staticThemes: ['融资融券', '深股通'],
      allThemes: ['算力', '液冷服务器', '融资融券', '深股通'],
      directReason: '算力订单预期增强',
      sourceTradeDate: '20260709',
        summary: '早盘主驱动优先指向“算力”。',
      } as MorningAuctionThemeAttribution,
    }

    expect(buildMorningAuctionThemeTableDisplay(stock)).toEqual({
      primary: { label: '主炒', name: '算力', tone: 'direct' },
      secondary: { label: '共振', name: '液冷服务器' },
      hiddenCount: 2,
      totalCount: 4,
    })
  })

  it('主研判对历史涨跌和题材缺失给出受阻说明', () => {
    const snapshot = createSnapshot()
    snapshot.threeOne.firstBoard[0].pctChg3d = null
    snapshot.threeOne.firstBoard[0].pctChg5d = null
    snapshot.threeOne.firstBoard[0].conceptNames = []

    const workbench = buildMorningAuctionWorkbench(snapshot, new Map())
    const evidence = buildMorningAuctionFocusEvidence(workbench.candidates[0])

    expect(evidence[1].text).toContain('无法确认近期持续性')
    expect(evidence[2].text).toContain('题材共振证据仍受阻')
  })
})
