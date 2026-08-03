import { describe, expect, it } from 'vitest'
import { classifyPremarketOutcome } from '../../electron/main/services/premarketOutcomeModel'

describe('premarketOutcomeModel', () => {
  it.each([
    [{ previousClose: 100, open: 103, high: 106, low: 99, close: 101 }, 'gap_up_fade'],
    [{ previousClose: 100, open: 102, high: 106, low: 101, close: 105 }, 'gap_up_hold'],
    [{ previousClose: 100, open: 99, high: 104, low: 98, close: 103 }, 'low_or_flat_rebound'],
    [{ previousClose: 100, open: 99, high: 100, low: 94, close: 96 }, 'weak_all_day'],
    [{ previousClose: 100, open: 98, high: 103, low: 97, close: 99 }, 'mixed'],
  ] as const)('将完整OHLC稳定标记为%s', (input, expected) => {
    expect(classifyPremarketOutcome(input).label).toBe(expected)
  })

  it('保留连续路径指标并阻断缺失或非法OHLC', () => {
    const fade = classifyPremarketOutcome({ previousClose: 100, open: 103, high: 106, low: 99, close: 101 })
    expect(fade).toMatchObject({
      gapPercent: 3,
      highChangePercent: 6,
      closeChangePercent: 1,
      highGivebackRatio: 0.8333,
    })
    const invalid = classifyPremarketOutcome({ previousClose: 100, open: 101, high: 99, low: 98, close: 100 })
    expect(invalid.label).toBe('insufficient')
    expect(invalid.warnings).toContain('OUTCOME_OHLC_INSUFFICIENT_OR_INVALID')
  })
})
