export type MarketBenchmarkKey = 'shanghai' | 'csi300' | 'chinext'

export type MarketResonanceState =
  | 'leading_sync'
  | 'synchronized'
  | 'falling_sync'
  | 'defensive'
  | 'lagging'
  | 'diverging'
  | 'weak'
  | 'insufficient'

export interface MarketTrendPoint {
  time: string
  change: number
}

export interface MarketTrendSeries {
  code: string
  name: string
  tradeDate: string
  change: number
  points: MarketTrendPoint[]
}

export interface MarketResonanceMetric {
  sampleCount: number
  correlation: number | null
  directionAgreement: number | null
  recentAgreement: number | null
  excessReturn: number
  sectorReturn: number
  benchmarkReturn: number
  lagMinutes: number | null
  score: number
  state: MarketResonanceState
}

interface AlignedPoint {
  time: string
  benchmarkChange: number
  sectorChange: number
}

const MIN_SAMPLE_COUNT = 30
const DIRECTION_EPSILON = 0.003

export function calculateMarketResonance(
  benchmark: MarketTrendSeries,
  sector: MarketTrendSeries,
  breadthRate: number | null,
): MarketResonanceMetric {
  const aligned = alignSeries(benchmark.points, sector.points)
  const benchmarkReturn = latestChange(aligned, 'benchmarkChange', benchmark.change)
  const sectorReturn = latestChange(aligned, 'sectorChange', sector.change)
  const excessReturn = sectorReturn - benchmarkReturn

  if (aligned.length < MIN_SAMPLE_COUNT) {
    return {
      sampleCount: aligned.length,
      correlation: null,
      directionAgreement: null,
      recentAgreement: null,
      excessReturn: round(excessReturn, 3),
      sectorReturn: round(sectorReturn, 3),
      benchmarkReturn: round(benchmarkReturn, 3),
      lagMinutes: null,
      score: 0,
      state: 'insufficient',
    }
  }

  const benchmarkMoves = differences(aligned.map((point) => point.benchmarkChange))
  const sectorMoves = differences(aligned.map((point) => point.sectorChange))
  const correlation = pearson(benchmarkMoves, sectorMoves)
  const directionAgreement = calculateDirectionAgreement(benchmarkMoves, sectorMoves)
  const recentAgreement = calculateDirectionAgreement(
    benchmarkMoves.slice(-30),
    sectorMoves.slice(-30),
  )
  const lagMinutes = findBestLag(benchmarkMoves, sectorMoves)
  const state = classifyResonance({
    correlation,
    directionAgreement,
    recentAgreement,
    sectorReturn,
    benchmarkReturn,
    excessReturn,
  })
  const score = calculateScore({
    correlation,
    directionAgreement,
    recentAgreement,
    excessReturn,
    breadthRate,
    state,
  })

  return {
    sampleCount: aligned.length,
    correlation: correlation == null ? null : round(correlation, 3),
    directionAgreement: directionAgreement == null ? null : round(directionAgreement, 3),
    recentAgreement: recentAgreement == null ? null : round(recentAgreement, 3),
    excessReturn: round(excessReturn, 3),
    sectorReturn: round(sectorReturn, 3),
    benchmarkReturn: round(benchmarkReturn, 3),
    lagMinutes,
    score,
    state,
  }
}

function alignSeries(benchmark: MarketTrendPoint[], sector: MarketTrendPoint[]): AlignedPoint[] {
  const sectorByTime = new Map(sector.map((point) => [point.time, point.change]))
  return benchmark.flatMap((point) => {
    const sectorChange = sectorByTime.get(point.time)
    return sectorChange == null
      ? []
      : [{ time: point.time, benchmarkChange: point.change, sectorChange }]
  })
}

function differences(values: number[]): number[] {
  const result: number[] = []
  for (let index = 1; index < values.length; index += 1) {
    result.push(values[index] - values[index - 1])
  }
  return result
}

function latestChange(
  aligned: AlignedPoint[],
  key: 'benchmarkChange' | 'sectorChange',
  fallback: number,
): number {
  const value = aligned.at(-1)?.[key]
  return Number.isFinite(value) ? value as number : fallback
}

function pearson(left: number[], right: number[]): number | null {
  const size = Math.min(left.length, right.length)
  if (size < 10) return null
  const leftSlice = left.slice(0, size)
  const rightSlice = right.slice(0, size)
  const leftMean = leftSlice.reduce((sum, value) => sum + value, 0) / size
  const rightMean = rightSlice.reduce((sum, value) => sum + value, 0) / size
  let numerator = 0
  let leftSquare = 0
  let rightSquare = 0
  for (let index = 0; index < size; index += 1) {
    const leftDelta = leftSlice[index] - leftMean
    const rightDelta = rightSlice[index] - rightMean
    numerator += leftDelta * rightDelta
    leftSquare += leftDelta * leftDelta
    rightSquare += rightDelta * rightDelta
  }
  const denominator = Math.sqrt(leftSquare * rightSquare)
  return denominator <= Number.EPSILON ? null : numerator / denominator
}

function calculateDirectionAgreement(left: number[], right: number[]): number | null {
  const size = Math.min(left.length, right.length)
  let valid = 0
  let agreed = 0
  for (let index = 0; index < size; index += 1) {
    const leftValue = left[index]
    const rightValue = right[index]
    if (Math.abs(leftValue) < DIRECTION_EPSILON && Math.abs(rightValue) < DIRECTION_EPSILON) continue
    valid += 1
    if (Math.sign(leftValue) === Math.sign(rightValue)) agreed += 1
  }
  return valid < 10 ? null : agreed / valid
}

function findBestLag(benchmarkMoves: number[], sectorMoves: number[]): number | null {
  let bestLag = 0
  let bestCorrelation = -Infinity
  for (let lag = -5; lag <= 5; lag += 1) {
    const left: number[] = []
    const right: number[] = []
    for (let index = 0; index < benchmarkMoves.length; index += 1) {
      const sectorIndex = index + lag
      if (sectorIndex < 0 || sectorIndex >= sectorMoves.length) continue
      left.push(benchmarkMoves[index])
      right.push(sectorMoves[sectorIndex])
    }
    const value = pearson(left, right)
    if (value != null && value > bestCorrelation) {
      bestCorrelation = value
      bestLag = lag
    }
  }
  return Number.isFinite(bestCorrelation) ? bestLag : null
}

function classifyResonance(input: {
  correlation: number | null
  directionAgreement: number | null
  recentAgreement: number | null
  sectorReturn: number
  benchmarkReturn: number
  excessReturn: number
}): MarketResonanceState {
  const correlation = input.correlation ?? -1
  const agreement = input.directionAgreement ?? 0
  const recent = input.recentAgreement ?? agreement
  const synchronized = correlation >= 0.42 && agreement >= 0.56

  if (synchronized && input.sectorReturn > 0 && input.excessReturn >= 0.25 && recent >= 0.56) {
    return 'leading_sync'
  }
  if (synchronized && input.sectorReturn < 0 && input.benchmarkReturn < 0 && input.excessReturn <= -0.15) {
    return 'falling_sync'
  }
  if (synchronized) return 'synchronized'
  if (input.benchmarkReturn <= -0.2 && input.sectorReturn >= 0 && input.excessReturn >= 0.4) {
    return 'defensive'
  }
  if (input.benchmarkReturn >= 0.2 && (input.sectorReturn < 0 || input.excessReturn <= -0.5)) {
    return 'lagging'
  }
  if (Math.abs(input.excessReturn) >= 0.5 && (correlation < 0.25 || agreement < 0.52)) {
    return 'diverging'
  }
  return 'weak'
}

function calculateScore(input: {
  correlation: number | null
  directionAgreement: number | null
  recentAgreement: number | null
  excessReturn: number
  breadthRate: number | null
  state: MarketResonanceState
}): number {
  if (input.state === 'insufficient') return 0
  const correlationPart = Math.max(0, Math.min(1, input.correlation ?? 0)) * 35
  const directionPart = Math.max(0, Math.min(1, input.directionAgreement ?? 0)) * 25
  const recentPart = Math.max(0, Math.min(1, input.recentAgreement ?? 0)) * 15
  const breadthPart = input.breadthRate == null ? 7.5 : Math.max(0, Math.min(1, input.breadthRate)) * 15
  const excessPart = Math.max(-10, Math.min(10, input.excessReturn * 5))
  const stateAdjustment = input.state === 'leading_sync'
    ? 10
    : input.state === 'falling_sync' || input.state === 'lagging'
      ? -8
      : input.state === 'diverging'
        ? -5
        : 0
  return Math.round(Math.max(0, Math.min(100, correlationPart + directionPart + recentPart + breadthPart + excessPart + stateAdjustment)))
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

