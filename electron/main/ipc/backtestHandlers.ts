import { ipcMain } from 'electron'
import { getDb } from '../database/db'
import { getIntraday } from '../database/intradayCacheRepository'
import { getForecastsNeedingIntraday, updateForecastOutcome } from '../database/trendForecastRepository'
import {
  syncIntradayForPredictedStocks,
  runAllPendingBacktests,
  runBacktestForForecast
} from '../services/backtestService'

type StatsFilter = {
  stockCode?: string
  type?: 'today' | 'morrow' | 'all'
  fromTargetDate?: string
  toTargetDate?: string
  portfolioOnly?: boolean
}

type ForecastOutcomeTag = 'valid' | 'invalid' | 'uncertain' | null

export function registerBacktestHandlers(): void {
  const db = getDb()

  ipcMain.handle('backtest:getStartupSyncRequirement', () => {
    const missing = getForecastsNeedingIntraday(db, 7)
    const stockCodes = [...new Set(missing.map((item) => item.stockCode))]
    return { required: stockCodes.length > 0, stockCodes }
  })

  ipcMain.handle('backtest:syncIntraday', async () => {
    const synced = await syncIntradayForPredictedStocks(db)
    const backtested = runAllPendingBacktests(db)
    return { synced, backtested }
  })

  ipcMain.handle('backtest:getIntradayCache', (_e, data: { stockCode: string; tradeDate: string }) => {
    return getIntraday(db, data.stockCode, data.tradeDate) ?? null
  })

  ipcMain.handle('backtest:runBacktest', (_e, data?: { forecastId?: number }) => {
    if (data?.forecastId) {
      const ok = runBacktestForForecast(db, data.forecastId)
      return { processed: ok ? 1 : 0 }
    }
    const processed = runAllPendingBacktests(db)
    return { processed }
  })

  ipcMain.handle('backtest:getStats', (_e, data?: StatsFilter) => {
    // Get all forecasts that have been backtested
    let sql = `SELECT provider, model, backtestDirection, backtestCloseDeviation, backtestMAPE, backtestPearson
               FROM trend_forecasts WHERE backtestAt IS NOT NULL`
    const params: (string | number)[] = []
    if (data?.stockCode) {
      sql += ' AND stockCode = ?'
      params.push(data.stockCode)
    }
    if (data?.type && data.type !== 'all') {
      sql += ' AND type = ?'
      params.push(data.type)
    }
    if (data?.fromTargetDate) {
      sql += ' AND targetDate >= ?'
      params.push(data.fromTargetDate)
    }
    if (data?.toTargetDate) {
      sql += ' AND targetDate <= ?'
      params.push(data.toTargetDate)
    }
    if (data?.portfolioOnly) {
      sql += ` AND EXISTS (
        SELECT 1 FROM portfolio_stocks p
        WHERE REPLACE(REPLACE(REPLACE(p.ts_code, '.SH', ''), '.SZ', ''), '.BJ', '') = trend_forecasts.stockCode
           OR p.ts_code = trend_forecasts.stockCode
      )`
    }

    const rows = db.prepare(sql).all(...params) as {
      provider: string | null
      model: string | null
      backtestDirection: number | null
      backtestCloseDeviation: number | null
      backtestMAPE: number | null
      backtestPearson: number | null
    }[]

    // Group by provider/model
    const groups = new Map<
      string,
      { provider: string; model: string; directions: number[]; deviations: number[]; mapes: number[]; pearsons: number[] }
    >()

    for (const r of rows) {
      const key = `${r.provider ?? 'unknown'}:${r.model ?? 'unknown'}`
      if (!groups.has(key)) {
        groups.set(key, {
          provider: r.provider ?? 'unknown',
          model: r.model ?? 'unknown',
          directions: [],
          deviations: [],
          mapes: [],
          pearsons: []
        })
      }
      const g = groups.get(key)!
      if (r.backtestDirection != null) g.directions.push(r.backtestDirection)
      if (r.backtestCloseDeviation != null) g.deviations.push(r.backtestCloseDeviation)
      if (r.backtestMAPE != null) g.mapes.push(r.backtestMAPE)
      if (r.backtestPearson != null) g.pearsons.push(r.backtestPearson)
    }

    const avg = (arr: number[]): number => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0

    return [...groups.values()].map((g) => ({
      provider: g.provider,
      model: g.model,
      avgDirection: Math.round(avg(g.directions) * 100) / 100,
      avgCloseDeviation: Math.round(avg(g.deviations) * 100) / 100,
      avgMAPE: Math.round(avg(g.mapes) * 100) / 100,
      avgPearson: Math.round(avg(g.pearsons) * 10000) / 10000,
      count: g.directions.length
    }))
  })

  ipcMain.handle('backtest:updateForecastOutcome', (_e, data?: { forecastId?: number; tag?: ForecastOutcomeTag; note?: string | null }) => {
    const forecastId = Number(data?.forecastId)
    if (!Number.isInteger(forecastId) || forecastId <= 0) {
      return { ok: false, error: { code: 'INVALID_PARAM', message: 'forecastId 无效' } }
    }
    const tag = data?.tag ?? null
    if (tag !== null && !['valid', 'invalid', 'uncertain'].includes(tag)) {
      return { ok: false, error: { code: 'INVALID_PARAM', message: '样本标签无效' } }
    }
    const note = typeof data?.note === 'string' && data.note.trim() ? data.note.trim().slice(0, 500) : null
    updateForecastOutcome(db, forecastId, tag, note)
    return { ok: true }
  })
}
