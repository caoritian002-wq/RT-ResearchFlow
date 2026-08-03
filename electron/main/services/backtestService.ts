import type { Database } from 'better-sqlite3'
import type { BacktestMetrics } from '../database/types'
import { getIntraday, upsertIntraday, cleanupOldIntraday } from '../database/intradayCacheRepository'
import {
  getForecast,
  getPendingBacktestForecasts,
  getForecastsNeedingIntraday,
  getForecastTargetDate,
  updateBacktestResult
} from '../database/trendForecastRepository'
import { fetchIntradayDataByDate } from './tushareService'

interface PointData {
  time: string
  price: number
}

/**
 * Compute backtest metrics by comparing predicted points against actual intraday points.
 * Both arrays should contain {time: "HH:mm", price: number} entries.
 */
export function computeBacktest(
  predictedPoints: PointData[],
  actualPoints: PointData[]
): BacktestMetrics {
  // Build time->price map for actual data (for alignment)
  const actualMap = new Map<string, number>()
  for (const p of actualPoints) {
    actualMap.set(p.time, p.price)
  }

  // Align predicted points with actual by exact 5-min time match
  const aligned: { time: string; pred: number; actual: number }[] = []
  for (const p of predictedPoints) {
    const actualPrice = actualMap.get(p.time)
    if (actualPrice !== undefined && actualPrice > 0) {
      aligned.push({ time: p.time, pred: p.price, actual: actualPrice })
    }
  }

  // Direction accuracy: compare first→last direction
  const predFirst = predictedPoints[0]?.price ?? 0
  const predLast = predictedPoints[predictedPoints.length - 1]?.price ?? 0
  const actualFirst = actualPoints[0]?.price ?? 0
  const actualLast = actualPoints[actualPoints.length - 1]?.price ?? 0
  const predDirection = predLast >= predFirst ? 1 : 0
  const actualDirection = actualLast >= actualFirst ? 1 : 0
  const direction: 0 | 1 = predDirection === actualDirection ? 1 : 0

  // Close deviation: |predicted last - actual last| / actual last * 100
  const closeDeviation =
    actualLast > 0 ? Math.abs(predLast - actualLast) / actualLast * 100 : 0

  // MAPE on aligned points
  let mape = 0
  if (aligned.length > 0) {
    let sumAPE = 0
    for (const a of aligned) {
      sumAPE += Math.abs(a.pred - a.actual) / a.actual * 100
    }
    mape = sumAPE / aligned.length
  }

  // Pearson correlation on aligned points
  let pearson = 0
  if (aligned.length >= 3) {
    const n = aligned.length
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0
    for (const a of aligned) {
      sumX += a.pred
      sumY += a.actual
      sumXY += a.pred * a.actual
      sumX2 += a.pred * a.pred
      sumY2 += a.actual * a.actual
    }
    const num = n * sumXY - sumX * sumY
    const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY))
    pearson = den > 0 ? num / den : 0
  }

  const errorAnalysis = buildErrorAnalysis({
    direction,
    closeDeviation,
    mape,
    pearson,
    predictedPoints,
    actualPoints,
    aligned,
    predFirst,
    predLast,
    actualFirst,
    actualLast,
  })

  return {
    direction,
    closeDeviation: Math.round(closeDeviation * 100) / 100,
    mape: Math.round(mape * 100) / 100,
    pearson: Math.round(pearson * 10000) / 10000,
    errorAnalysis: JSON.stringify(errorAnalysis)
  }
}

function buildErrorAnalysis(input: {
  direction: 0 | 1
  closeDeviation: number
  mape: number
  pearson: number
  predictedPoints: PointData[]
  actualPoints: PointData[]
  aligned: { time: string; pred: number; actual: number }[]
  predFirst: number
  predLast: number
  actualFirst: number
  actualLast: number
}) {
  const tags: string[] = []
  if (input.direction === 0) tags.push('DIRECTION_MISMATCH')
  if (input.closeDeviation >= 5) tags.push('CLOSE_DEVIATION_HIGH')
  if (input.mape >= 5) tags.push('MAPE_HIGH')
  if (input.pearson < 0.2) tags.push('SHAPE_MISMATCH')

  const predRange = Math.max(...input.predictedPoints.map(p => p.price)) - Math.min(...input.predictedPoints.map(p => p.price))
  const actualRange = Math.max(...input.actualPoints.map(p => p.price)) - Math.min(...input.actualPoints.map(p => p.price))
  if (actualRange > 0 && predRange / actualRange < 0.6) tags.push('VOLATILITY_UNDERESTIMATED')
  if (predRange > 0 && actualRange / predRange < 0.6) tags.push('VOLATILITY_OVERESTIMATED')

  const afterNoon = input.aligned.filter(point => point.time >= '13:00')
  if (afterNoon.length >= 3) {
    const first = afterNoon[0]
    const last = afterNoon[afterNoon.length - 1]
    const predAfternoonUp = last.pred >= first.pred
    const actualAfternoonUp = last.actual >= first.actual
    if (predAfternoonUp !== actualAfternoonUp) tags.push('AFTERNOON_REVERSAL_MISSED')
  }

  const summary = tags.length === 0
    ? '预测与真实走势整体匹配, 未识别出显著误差类型。'
    : `识别到 ${tags.length} 类误差: ${tags.join(', ')}`

  return {
    tags,
    summary,
    metrics: {
      direction: input.direction,
      closeDeviation: Math.round(input.closeDeviation * 100) / 100,
      mape: Math.round(input.mape * 100) / 100,
      pearson: Math.round(input.pearson * 10000) / 10000,
      predictedRange: Math.round(predRange * 100) / 100,
      actualRange: Math.round(actualRange * 100) / 100,
    },
  }
}

/**
 * Run backtest for a single forecast if intraday data is available.
 * Returns true if backtest was computed, false if data not available.
 */
export function runBacktestForForecast(db: Database, forecastId: number): boolean {
  const forecast = getForecast(db, forecastId)
  if (!forecast || forecast.backtestAt != null) return false

  // Determine target date for actual intraday data
  const tradeDateStr = getForecastTargetDate(forecast)

  const cached = getIntraday(db, forecast.stockCode, tradeDateStr)
  if (!cached) return false

  let predictedPoints: PointData[]
  try {
    predictedPoints = JSON.parse(forecast.points)
  } catch {
    return false
  }

  let actualPoints: PointData[]
  try {
    actualPoints = (JSON.parse(cached.points) as { time: string; price: number; volume?: number }[])
      .map((p) => ({ time: p.time, price: p.price }))
  } catch {
    return false
  }

  if (predictedPoints.length < 2 || actualPoints.length < 2) return false

  const metrics = computeBacktest(predictedPoints, actualPoints)
  updateBacktestResult(db, forecastId, metrics)
  return true
}

/**
 * Run backtest for all pending forecasts that have intraday data available.
 * Returns number of forecasts processed.
 */
export function runAllPendingBacktests(db: Database): number {
  const pending = getPendingBacktestForecasts(db)
  let processed = 0
  for (const f of pending) {
    if (runBacktestForForecast(db, f.id)) {
      processed++
    }
  }
  return processed
}

/**
 * Sync intraday data for stocks that have predictions but missing intraday cache.
 * Returns number of entries synced.
 */
export async function syncIntradayForPredictedStocks(db: Database): Promise<number> {
  const missing = getForecastsNeedingIntraday(db, 7)
  let synced = 0

  for (const entry of missing) {
    const items = await fetchIntradayDataByDate(entry.stockCode, entry.tradeDate)
    if (items.length > 0) {
      const pointsJson = JSON.stringify(items.map((i) => ({ time: i.time, price: i.price, volume: i.volume })))
      upsertIntraday(db, entry.stockCode, entry.tradeDate, pointsJson)
      synced++
    }
  }

  cleanupOldIntraday(db)
  return synced
}
