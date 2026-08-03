import { describe, expect, it } from 'vitest'
import type { ChipMonitorResultRow, ChipStructureSummary } from '../../electron/main/database/types'
import { mergeCompatibleChipStructureSummaries } from '../../electron/main/services/chipSummaryService'

function structureSummary(overrides: Partial<ChipStructureSummary> = {}): ChipStructureSummary {
  return {
    tsCode: '600000.SH',
    stockName: null,
    tradeDate: '20260710',
    dateRelation: 'missing',
    winnerRate: 60,
    thickProfitPct: 20,
    thinProfitPct: 40,
    trappedPct: 40,
    deepLowPct: 5,
    concentration: 30,
    costDeviationPct: 2,
    bottomPct: null,
    bottomAvgCost: null,
    loosening1d: null,
    loosening3d: null,
    loosening5d: null,
    pctChg: null,
    turnoverRate: null,
    primaryChange: { metric: 'winnerRate', days: 1, value: 2 },
    freshnessStatus: 'current',
    completenessStatus: 'complete',
    consistencyStatus: 'matched',
    missingReasons: [],
    updatedAt: 2000,
    ...overrides,
  }
}

function legacyResult(overrides: Partial<ChipMonitorResultRow> = {}): ChipMonitorResultRow {
  return {
    tsCode: '600000',
    source: 'watchlist',
    stockName: '浦发银行',
    tradeDate: '20260710',
    mode: 'relative',
    bottomPct: 25,
    bottomAvgCost: 9.5,
    loosening1d: 1,
    loosening3d: 3,
    loosening5d: 5,
    loosening1dReason: null,
    loosening3dReason: null,
    loosening5dReason: null,
    updatedAt: 1000,
    pctChg: 2.5,
    turnoverRate: 1.2,
    currentPrice: 10,
    ...overrides,
  }
}

describe('筹码结构兼容摘要', () => {
  it('按六位与后缀代码合并同日旧指标，并保持结构变化独立', () => {
    const [summary] = mergeCompatibleChipStructureSummaries(
      [structureSummary()],
      [legacyResult()],
      '20260710',
    )

    expect(summary).toMatchObject({
      stockName: '浦发银行',
      dateRelation: 'same_day',
      bottomPct: 25,
      loosening1d: 1,
      pctChg: 2.5,
      primaryChange: { metric: 'winnerRate', days: 1, value: 2 },
    })
  })

  it('不同事实日不拼接旧指标，并降级为历史证据', () => {
    const [summary] = mergeCompatibleChipStructureSummaries(
      [structureSummary()],
      [legacyResult({ tradeDate: '20260709' })],
      '20260711',
    )

    expect(summary.dateRelation).toBe('history')
    expect(summary.bottomPct).toBeNull()
    expect(summary.loosening1d).toBeNull()
  })

  it('结构事实缺失时保留旧兼容摘要，但不改变阻塞状态', () => {
    const [summary] = mergeCompatibleChipStructureSummaries(
      [structureSummary({
        tradeDate: null,
        winnerRate: null,
        completenessStatus: 'blocked',
        missingReasons: ['CYQ_PERF_MISSING', 'CYQ_CHIPS_MISSING'],
        updatedAt: null,
      })],
      [legacyResult({ tradeDate: '20260709' })],
      '20260710',
    )

    expect(summary).toMatchObject({
      tradeDate: '20260709',
      dateRelation: 'history',
      completenessStatus: 'blocked',
      bottomPct: 25,
      updatedAt: 1000,
    })
  })

  it('未传参考日期时不得把本地事实标记为业务同日', () => {
    const summaries = mergeCompatibleChipStructureSummaries(
      [structureSummary({ tsCode: '000001.SZ' }), structureSummary({ tsCode: '600000.SH' })],
      [],
    )

    expect(summaries.map((summary) => summary.tsCode)).toEqual(['000001.SZ', '600000.SH'])
    expect(summaries.every((summary) => summary.dateRelation === 'missing')).toBe(true)
  })
})