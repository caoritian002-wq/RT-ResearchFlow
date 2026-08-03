import { describe, expect, it } from 'vitest'
import {
  buildPortfolioActionQueue,
  buildPortfolioCommandSummary,
  buildPortfolioProgressModel,
} from '../../src/components/DecisionCenter/portfolioCommandModel'
import type { DecisionSignalItem } from '../../src/components/DecisionCenter/SignalCard'

function signal(partial: Partial<DecisionSignalItem> & Pick<DecisionSignalItem, 'id' | 'tsCode'>): DecisionSignalItem {
  return {
    id: partial.id,
    tsCode: partial.tsCode,
    stockName: partial.stockName ?? '测试',
    conceptCode: null,
    conceptName: null,
    sourceModule: partial.sourceModule ?? 'trend',
    strategyKey: partial.strategyKey ?? 'trend.STOP_LOSS',
    signalType: partial.signalType ?? 'RISK',
    direction: partial.direction ?? 'BEARISH',
    priority: partial.priority ?? 4,
    score: partial.score ?? null,
    confidence: partial.confidence ?? null,
    title: partial.title ?? '测试信号',
    summary: partial.summary ?? '',
    reasonJson: partial.reasonJson ?? JSON.stringify({ isPortfolio: true }),
    sourceRefJson: partial.sourceRefJson ?? null,
    status: partial.status ?? 'NEW',
    signalTime: partial.signalTime ?? Date.now(),
    occurrenceCount: 1,
    resolvedAt: partial.resolvedAt ?? null,
    resolution: partial.resolution ?? null,
  }
}

describe('buildPortfolioCommandSummary', () => {
  it('uses holding list count and blocks fake zero profit when all costs missing', () => {
    const summary = buildPortfolioCommandSummary(
      [signal({ id: 1, tsCode: '600000.SH', status: 'NEW', signalType: 'RISK' })],
      [
        { tsCode: '600000.SH', stockName: '浦发', addedAt: 1, costPrice: null },
        { tsCode: '000001.SZ', stockName: '平安', addedAt: 2, costPrice: null },
      ],
      null,
    )
    expect(summary.holdingCount).toBe(2)
    expect(summary.missingCostCount).toBe(2)
    expect(summary.profitSummaryKind).toBe('blocked')
    expect(summary.profitSummaryText).toBe('成本未补齐')
    expect(summary.profitPctAvg).toBeNull()
    expect(summary.metrics.map((item) => item.label)).toEqual(['持仓数', '持仓风险', '证据缺口', '组合未处理'])
  })

  it('averages available profit samples without inventing zeros for missing holdings', () => {
    const summary = buildPortfolioCommandSummary(
      [
        signal({
          id: 1,
          tsCode: '600000.SH',
          reasonJson: JSON.stringify({ isPortfolio: true, profitPct: 2, costPrice: 10 }),
        }),
        signal({
          id: 2,
          tsCode: '000001.SZ',
          reasonJson: JSON.stringify({ isPortfolio: true, profitPct: 4, costPrice: 12 }),
          status: 'WATCHING',
        }),
      ],
      [
        { tsCode: '600000.SH', stockName: '浦发', addedAt: 1, costPrice: 10 },
        { tsCode: '000001.SZ', stockName: '平安', addedAt: 2, costPrice: 12 },
        { tsCode: '600519.SH', stockName: '茅台', addedAt: 3, costPrice: 1500 },
      ],
      { rangeDays: 30, totalPortfolio: 3, missingCostPrice: 0, withRiskSignals: 1, unresolvedRiskSignals: 1, repeatedRiskSignals: 0, items: [] },
    )
    expect(summary.holdingCount).toBe(3)
    expect(summary.profitSummaryKind).toBe('partial')
    expect(summary.profitPctAvg).toBeCloseTo(3, 5)
    expect(summary.pendingCount).toBe(2)
    expect(summary.portfolioRiskCount).toBeGreaterThanOrEqual(1)
  })
})

describe('buildPortfolioActionQueue', () => {
  it('aggregates multiple sources for the same stock into one task', () => {
    const queue = buildPortfolioActionQueue(
      [
        signal({ id: 1, tsCode: '600000.SH', stockName: '浦发', title: '趋势风险', sourceModule: 'trend', priority: 5 }),
        signal({ id: 2, tsCode: '600000.SH', stockName: '浦发', title: '资讯冲击', sourceModule: 'news', priority: 4, signalType: 'ALERT' }),
        signal({ id: 3, tsCode: '000001.SZ', stockName: '平安', title: '短线机会', sourceModule: 'short_term', signalType: 'OPPORTUNITY', direction: 'BULLISH', priority: 5, reasonJson: '{}' }),
      ],
      [{ tsCode: '600000.SH', stockName: '浦发', addedAt: 1, costPrice: 10 }],
      5,
    )
    expect(queue).toHaveLength(1)
    expect(queue[0]!.sourceCount).toBe(2)
    expect(queue[0]!.displayTitle).toContain('浦发')
    expect(queue[0]!.displayTitle).toContain('2 条线索')
  })

  it('creates cost-gap task when holding lacks cost and has no open signal', () => {
    const queue = buildPortfolioActionQueue(
      [],
      [{ tsCode: '600519.SH', stockName: '茅台', addedAt: 1, costPrice: null }],
      5,
    )
    expect(queue).toHaveLength(1)
    expect(queue[0]!.signal.id).toBeLessThan(0)
    expect(queue[0]!.gaps.some((gap) => gap.includes('成本'))).toBe(true)
    expect(queue[0]!.primaryAction).toBe('stock')
  })
})

describe('buildPortfolioProgressModel', () => {
  it('distinguishes no-holding and cleared portfolio backlog', () => {
    const emptyHoldings = buildPortfolioProgressModel([], [])
    expect(emptyHoldings.title).toBe('尚未添加持仓')

    const cleared = buildPortfolioProgressModel(
      [signal({ id: 1, tsCode: '600000.SH', status: 'READ', resolvedAt: Date.now() })],
      [{ tsCode: '600000.SH', stockName: '浦发', addedAt: 1, costPrice: 10 }],
    )
    expect(cleared.title).toBe('组合待办已清空')
  })
})
