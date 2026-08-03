import { describe, expect, it } from 'vitest'
import {
  TREND_SCORE_WEIGHTS,
  classifyTrendState,
  computeOrderedMaxDrawdown,
  computeTrendScoreV2,
  computeWindowReturn,
  type TrendOhlcvBar,
} from '../../electron/main/services/trendScoreModel'

function bars(count: number, start = 100, step = 0.5, withTurnover = true): TrendOhlcvBar[] {
  return Array.from({ length: count }, (_, index) => {
    const close = start + index * step
    return {
      close,
      high: close * 1.01,
      low: close * 0.99,
      vol: 1_000_000 + index,
      turnoverRate: withTurnover ? 1 + (index % 3) * 0.02 : null,
    }
  })
}

describe('trendScoreModel', () => {
  it('normalizes the historical 110-point weight set and caps the score at 100', () => {
    const weight = Object.values(TREND_SCORE_WEIGHTS).reduce((sum, value) => sum + value, 0)
    const result = computeTrendScoreV2(bars(80), 0)

    expect(weight).toBeCloseTo(1, 10)
    expect(result.score.totalScore).not.toBeNull()
    expect(result.score.totalScore).toBeLessThanOrEqual(100)
    expect(result.validWeight).toBeCloseTo(1, 10)
  })

  it('compares stock and benchmark returns over the same 20-session window', () => {
    const input = bars(80, 100, 1)
    const stockReturn = computeWindowReturn(input.map((bar) => bar.close), 20)
    const result = computeTrendScoreV2(input, stockReturn)

    expect(result.facts.stockReturn20d).toBeCloseTo(stockReturn ?? 0, 8)
    expect(result.facts.excessReturn20d).toBeCloseTo(0, 8)
    expect(result.score.alphaScore).toBe(50)
  })

  it('calculates drawdown only from an earlier peak to a later trough', () => {
    expect(computeOrderedMaxDrawdown([100, 80, 120])).toBeCloseTo(20, 8)
    expect(computeOrderedMaxDrawdown([80, 100, 120])).toBe(0)
  })

  it('keeps MA60 unknown when the local window is incomplete', () => {
    const result = computeTrendScoreV2(bars(35), 0)

    expect(result.score.maAbove60).toBeNull()
    expect(result.dimensions.maAbove60).toBeNull()
    expect(result.score.totalScore).not.toBeNull()
  })

  it('blocks the total score when too much evidence is missing', () => {
    const result = computeTrendScoreV2(bars(80, 100, 0.5, false), null)

    expect(result.validWeight).toBeLessThan(0.7)
    expect(result.score.totalScore).toBeNull()
    expect(result.score.alphaScore).toBeNull()
    expect(result.score.turnoverRatio).toBeNull()
  })

  it('classifies strengthening, weakening, broken and insufficient states', () => {
    expect(classifyTrendState(82, true, 5)).toBe('strengthening')
    expect(classifyTrendState(82, true, -9)).toBe('weakening')
    expect(classifyTrendState(70, false, 4)).toBe('broken')
    expect(classifyTrendState(null, null, null)).toBe('insufficient')
  })
})
