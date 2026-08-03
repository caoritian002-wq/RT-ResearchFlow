import type { TrendScoreRow } from '../database/types'

export interface TrendOhlcvBar {
  close: number
  high: number
  low: number
  vol: number | null
  turnoverRate: number | null
}

export interface TrendScoreComputation {
  score: TrendScoreRow
  validWeight: number
  dimensions: {
    maArrangement: number | null
    maAbove60: number | null
    relativeStrength: number | null
    drawdownQuality: number | null
    turnoverQuality: number | null
    macd: number | null
    boll: number | null
  }
  facts: {
    stockReturn20d: number | null
    benchmarkReturn20d: number | null
    excessReturn20d: number | null
    maxDrawdown20d: number | null
    turnoverRatio: number | null
  }
}

export type TrendState = 'strengthening' | 'strong' | 'stable' | 'weakening' | 'broken' | 'insufficient'

const RAW_WEIGHTS = {
  maArrangement: 25,
  maAbove60: 20,
  relativeStrength: 20,
  drawdownQuality: 15,
  turnoverQuality: 15,
  macd: 10,
  boll: 5,
} as const

const RAW_WEIGHT_TOTAL = Object.values(RAW_WEIGHTS).reduce((sum, value) => sum + value, 0)

export const TREND_SCORE_WEIGHTS = Object.fromEntries(
  Object.entries(RAW_WEIGHTS).map(([key, value]) => [key, value / RAW_WEIGHT_TOTAL]),
) as Record<keyof typeof RAW_WEIGHTS, number>

const MIN_VALID_WEIGHT = 0.7

export function computeTrendScoreV2(
  inputBars: TrendOhlcvBar[],
  benchmarkReturn20d: number | null,
  realtimePrice: number | null = null,
): TrendScoreComputation {
  const bars = inputBars.filter((bar) => Number.isFinite(bar.close) && bar.close > 0)
  const closes = bars.map((bar) => bar.close)
  const latest = realtimePrice != null && realtimePrice > 0 ? realtimePrice : closes.at(-1) ?? null
  const now = Date.now()

  if (latest == null || bars.length < 20) {
    return emptyComputation(now, benchmarkReturn20d)
  }

  const ma5 = sma(closes, 5)
  const ma10 = sma(closes, 10)
  const ma20 = sma(closes, 20)
  const maConditions = [latest > ma5, ma5 > ma10, ma10 > ma20]
  const maArrangement = maConditions.filter(Boolean).length / maConditions.length * 100

  const ma60 = bars.length >= 60 ? sma(closes, 60) : null
  const maAbove60 = ma60 == null ? null : latest > ma60 ? 100 : 0

  const stockReturn20d = computeWindowReturn(closes, 20, latest)
  const excessReturn20d = stockReturn20d != null && benchmarkReturn20d != null
    ? stockReturn20d - benchmarkReturn20d
    : null
  const relativeStrength = excessReturn20d == null
    ? null
    : clamp((excessReturn20d + 30) / 60 * 100, 0, 100)

  const recentCloses = [...closes.slice(-20)]
  recentCloses[recentCloses.length - 1] = latest
  const maxDrawdown20d = computeOrderedMaxDrawdown(recentCloses)
  const drawdownQuality = maxDrawdown20d == null ? null : clamp((1 - maxDrawdown20d / 20) * 100, 0, 100)

  const recent10 = bars.slice(-10).map((bar) => bar.turnoverRate).filter(isPositiveNumber)
  const previous20 = bars.slice(-30, -10).map((bar) => bar.turnoverRate).filter(isPositiveNumber)
  const turnoverRatio = recent10.length >= 5 && previous20.length >= 10
    ? average(recent10) / average(previous20)
    : null
  const turnoverQuality = turnoverRatio == null
    ? null
    : turnoverRatio <= 1
      ? clamp(turnoverRatio * 100, 0, 100)
      : clamp(100 - (turnoverRatio - 1) * 50, 0, 100)

  const macd = closes.length >= 26 ? (computeMacd(closes).dea > 0 ? 100 : 0) : null
  const boll = closes.length >= 20 ? (latest > ma20 ? 100 : 0) : null

  const dimensions = {
    maArrangement,
    maAbove60,
    relativeStrength,
    drawdownQuality,
    turnoverQuality,
    macd,
    boll,
  }
  const validWeight = weightedEntries(dimensions).reduce((sum, entry) => sum + entry.weight, 0)
  const weightedScore = weightedEntries(dimensions).reduce((sum, entry) => sum + entry.score * entry.weight, 0)
  const totalScore = validWeight >= MIN_VALID_WEIGHT
    ? Math.round(clamp(weightedScore / validWeight, 0, 100))
    : null

  return {
    score: {
      tsCode: '',
      tradeDate: '',
      maScore: roundOrNull(maArrangement),
      maAbove60: maAbove60 == null ? null : maAbove60 > 0 ? 1 : 0,
      alphaScore: roundOrNull(relativeStrength),
      drawdown: roundOne(maxDrawdown20d),
      turnoverRatio: roundOrNull(turnoverQuality),
      macdAboveZero: macd == null ? null : macd > 0 ? 1 : 0,
      bollAboveMid: boll == null ? null : boll > 0 ? 1 : 0,
      totalScore,
      computedAt: now,
    },
    validWeight,
    dimensions,
    facts: {
      stockReturn20d,
      benchmarkReturn20d,
      excessReturn20d,
      maxDrawdown20d,
      turnoverRatio,
    },
  }
}

export function computeWindowReturn(
  closes: number[],
  periods: number,
  latestOverride: number | null = null,
): number | null {
  if (periods < 1 || closes.length < periods + 1) return null
  const start = closes[closes.length - 1 - periods]
  const latest = latestOverride != null && latestOverride > 0 ? latestOverride : closes.at(-1)
  if (latest == null || !Number.isFinite(start) || start <= 0) return null
  return (latest - start) / start * 100
}

export function computeOrderedMaxDrawdown(closes: number[]): number | null {
  const valid = closes.filter((value) => Number.isFinite(value) && value > 0)
  if (valid.length < 2) return null
  let peak = valid[0]
  let maxDrawdown = 0
  for (const value of valid.slice(1)) {
    peak = Math.max(peak, value)
    maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak * 100)
  }
  return maxDrawdown
}

export function classifyTrendState(
  totalScore: number | null,
  maAbove60: boolean | null,
  delta5d: number | null,
): TrendState {
  if (totalScore == null) return 'insufficient'
  if (maAbove60 === false || totalScore < 45) return 'broken'
  if (delta5d != null && delta5d <= -8) return 'weakening'
  if (totalScore >= 70 && delta5d != null && delta5d >= 3) return 'strengthening'
  if (totalScore >= 70) return 'strong'
  return 'stable'
}

function emptyComputation(now: number, benchmarkReturn20d: number | null): TrendScoreComputation {
  return {
    score: {
      tsCode: '',
      tradeDate: '',
      maScore: null,
      maAbove60: null,
      alphaScore: null,
      drawdown: null,
      turnoverRatio: null,
      macdAboveZero: null,
      bollAboveMid: null,
      totalScore: null,
      computedAt: now,
    },
    validWeight: 0,
    dimensions: {
      maArrangement: null,
      maAbove60: null,
      relativeStrength: null,
      drawdownQuality: null,
      turnoverQuality: null,
      macd: null,
      boll: null,
    },
    facts: {
      stockReturn20d: null,
      benchmarkReturn20d,
      excessReturn20d: null,
      maxDrawdown20d: null,
      turnoverRatio: null,
    },
  }
}

function weightedEntries(dimensions: TrendScoreComputation['dimensions']): Array<{ score: number; weight: number }> {
  const entries: Array<{ score: number; weight: number }> = []
  for (const key of Object.keys(dimensions) as Array<keyof TrendScoreComputation['dimensions']>) {
    const score = dimensions[key]
    if (score == null) continue
    entries.push({ score, weight: TREND_SCORE_WEIGHTS[key] })
  }
  return entries
}

function sma(values: number[], period: number): number {
  const slice = values.slice(-period)
  return slice.reduce((sum, value) => sum + value, 0) / slice.length
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function computeMacd(closes: number[]): { dif: number; dea: number } {
  let ema12 = closes[0]
  let ema26 = closes[0]
  let dif = 0
  let dea = 0
  for (const close of closes.slice(1)) {
    ema12 = ema12 * (11 / 13) + close * (2 / 13)
    ema26 = ema26 * (25 / 27) + close * (2 / 27)
    dif = ema12 - ema26
    dea = dea * (8 / 10) + dif * (2 / 10)
  }
  return { dif, dea }
}

function isPositiveNumber(value: number | null): value is number {
  return value != null && Number.isFinite(value) && value > 0
}

function roundOrNull(value: number | null): number | null {
  return value == null ? null : Math.round(value)
}

function roundOne(value: number | null): number | null {
  return value == null ? null : Math.round(value * 10) / 10
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
