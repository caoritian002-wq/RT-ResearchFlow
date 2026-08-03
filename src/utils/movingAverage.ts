export type MovingAverageInput = { tradeDate: string; close: number }
export type MovingAveragePoint = { tradeDate: string; value: number }
export type BollingerBandPoint = {
  tradeDate: string
  upper: number
  mid: number
  lower: number
}

export function buildMovingAverageSeries(
  rows: MovingAverageInput[],
  period: number,
): MovingAveragePoint[] {
  if (!Number.isInteger(period) || period <= 0) return []
  const points: MovingAveragePoint[] = []
  const rollingWindow: number[] = []
  let sum = 0

  for (const row of rows) {
    if (!Number.isFinite(row.close)) {
      rollingWindow.length = 0
      sum = 0
      continue
    }
    rollingWindow.push(row.close)
    sum += row.close
    if (rollingWindow.length > period) sum -= rollingWindow.shift()!
    if (rollingWindow.length === period) {
      points.push({ tradeDate: row.tradeDate, value: sum / period })
    }
  }

  return points
}

export function buildBollingerBandSeries(
  rows: MovingAverageInput[],
  period = 20,
  multiplier = 2,
): BollingerBandPoint[] {
  if (!Number.isInteger(period) || period <= 0 || !Number.isFinite(multiplier) || multiplier < 0) return []
  const points: BollingerBandPoint[] = []
  const rollingWindow: number[] = []
  let sum = 0
  let sumSquares = 0

  for (const row of rows) {
    if (!Number.isFinite(row.close)) {
      rollingWindow.length = 0
      sum = 0
      sumSquares = 0
      continue
    }
    rollingWindow.push(row.close)
    sum += row.close
    sumSquares += row.close * row.close
    if (rollingWindow.length > period) {
      const removed = rollingWindow.shift()!
      sum -= removed
      sumSquares -= removed * removed
    }
    if (rollingWindow.length === period) {
      const mid = sum / period
      const variance = Math.max(0, sumSquares / period - mid * mid)
      const deviation = Math.sqrt(variance) * multiplier
      points.push({
        tradeDate: row.tradeDate,
        upper: mid + deviation,
        mid,
        lower: mid - deviation,
      })
    }
  }

  return points
}
