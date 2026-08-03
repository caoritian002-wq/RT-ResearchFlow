import type {
  PremarketOutcomeInput,
  PremarketOutcomeResult,
} from './premarketScenarioTypes'

export const PREMARKET_OUTCOME_RULE_VERSION = 'premarket-outcome-v1' as const

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function isValidPrice(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0
}

export function classifyPremarketOutcome(input: PremarketOutcomeInput): PremarketOutcomeResult {
  const { previousClose, open, high, low, close } = input
  const prices = [previousClose, open, high, low, close]
  const valid = prices.every(isValidPrice)
    && (high as number) >= Math.max(open as number, close as number, low as number)
    && (low as number) <= Math.min(open as number, close as number, high as number)

  if (!valid) {
    return {
      ruleVersion: PREMARKET_OUTCOME_RULE_VERSION,
      label: 'insufficient',
      gapPercent: null,
      highChangePercent: null,
      closeChangePercent: null,
      highGivebackRatio: null,
      warnings: ['OUTCOME_OHLC_INSUFFICIENT_OR_INVALID'],
    }
  }

  const prev = previousClose as number
  const dayOpen = open as number
  const dayHigh = high as number
  const dayClose = close as number
  const gapPercent = round(((dayOpen - prev) / prev) * 100)
  const highChangePercent = round(((dayHigh - prev) / prev) * 100)
  const closeChangePercent = round(((dayClose - prev) / prev) * 100)
  const highGain = dayHigh - prev
  const highGivebackRatio = highGain > 0 ? round((dayHigh - dayClose) / highGain) : null

  let label: PremarketOutcomeResult['label'] = 'mixed'
  if (dayOpen > prev) {
    label = dayClose < dayOpen && (highGivebackRatio ?? 0) >= 0.5
      ? 'gap_up_fade'
      : 'gap_up_hold'
  } else if (dayClose > dayOpen && dayClose > prev) {
    label = 'low_or_flat_rebound'
  } else if (dayClose <= dayOpen) {
    label = 'weak_all_day'
  }

  return {
    ruleVersion: PREMARKET_OUTCOME_RULE_VERSION,
    label,
    gapPercent,
    highChangePercent,
    closeChangePercent,
    highGivebackRatio,
    warnings: [],
  }
}
