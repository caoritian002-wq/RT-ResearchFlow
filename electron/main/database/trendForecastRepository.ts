import type { Database } from 'better-sqlite3'
import type { BacktestMetrics, TrendForecastRow } from './types'

export function insertForecast(
  db: Database,
  data: {
    stockCode: string
    type: 'today' | 'morrow'
    points: string
    aiReason: string | null
    provider: string | null
    model: string | null
    targetDate?: string | null
    direction?: string | null
    confidence?: number | null
    keySupport?: number | null
    keyResistance?: number | null
    parentForecastId?: number | null
    userFeedback?: string | null
    inputSnapshot?: string | null
  }
): number {
  const createdAt = Date.now()
  const targetDate = data.targetDate ?? inferForecastTargetDate(data.type, createdAt)
  const result = db.prepare(
    `INSERT INTO trend_forecasts (stockCode, type, points, aiReason, provider, model, createdAt, targetDate, direction, confidence, key_support, key_resistance, parentForecastId, userFeedback, inputSnapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    data.stockCode, data.type, data.points, data.aiReason, data.provider, data.model, createdAt, targetDate,
    data.direction ?? null, data.confidence ?? null, data.keySupport ?? null, data.keyResistance ?? null,
    data.parentForecastId ?? null, data.userFeedback ?? null, data.inputSnapshot ?? null
  )
  return result.lastInsertRowid as number
}

export function listForecasts(
  db: Database,
  stockCode: string,
  limit?: number
): TrendForecastRow[] {
  const sql = `SELECT * FROM trend_forecasts WHERE stockCode = ? ORDER BY createdAt DESC`
  return normalizeForecastRows(db.prepare(sql).all(stockCode) as TrendForecastRow[])
    .sort((a, b) => {
      const dateDelta = getForecastTargetDate(b).localeCompare(getForecastTargetDate(a))
      return dateDelta !== 0 ? dateDelta : b.createdAt - a.createdAt
    })
    .slice(0, limit ?? 100)
}

export function getForecast(db: Database, id: number): TrendForecastRow | undefined {
  const row = db.prepare('SELECT * FROM trend_forecasts WHERE id = ?').get(id) as TrendForecastRow | undefined
  return row ? normalizeForecastRow(row) : undefined
}

export function deleteForecast(db: Database, id: number): void {
  db.prepare('DELETE FROM trend_forecasts WHERE id = ?').run(id)
}

export function deleteForecasts(db: Database, stockCode: string): void {
  db.prepare('DELETE FROM trend_forecasts WHERE stockCode = ?').run(stockCode)
}

/** Trim old forecasts for a stock, keeping only the most recent `keep` rows */
export function trimForecasts(db: Database, stockCode: string, keep: number): void {
  db.prepare(
    `DELETE FROM trend_forecasts WHERE stockCode = ? AND id NOT IN (
       SELECT id FROM trend_forecasts WHERE stockCode = ? ORDER BY createdAt DESC LIMIT ?
     )`
  ).run(stockCode, stockCode, keep)
}

/** Get the latest forecast of each type for a stock (for chart overlay) */
export function getLatestForecasts(
  db: Database,
  stockCode: string
): { today?: TrendForecastRow; morrow?: TrendForecastRow } {
  const today = db.prepare(
    `SELECT * FROM trend_forecasts WHERE stockCode = ? AND type = 'today' ORDER BY createdAt DESC LIMIT 1`
  ).get(stockCode) as TrendForecastRow | undefined
  const morrow = db.prepare(
    `SELECT * FROM trend_forecasts WHERE stockCode = ? AND type = 'morrow' ORDER BY createdAt DESC LIMIT 1`
  ).get(stockCode) as TrendForecastRow | undefined
  return { today: today ? normalizeForecastRow(today) : undefined, morrow: morrow ? normalizeForecastRow(morrow) : undefined }
}

/** Update backtest results for a forecast */
export function updateBacktestResult(
  db: Database,
  id: number,
  metrics: BacktestMetrics
): void {
  db.prepare(
    `UPDATE trend_forecasts
     SET backtestDirection = ?, backtestCloseDeviation = ?, backtestMAPE = ?, backtestPearson = ?, backtestAt = ?, errorAnalysis = ?
     WHERE id = ?`
  ).run(metrics.direction, metrics.closeDeviation, metrics.mape, metrics.pearson, Date.now(), metrics.errorAnalysis ?? null, id)
}

export function updateForecastOutcome(
  db: Database,
  id: number,
  tag: 'valid' | 'invalid' | 'uncertain' | null,
  note: string | null
): void {
  db.prepare(
    `UPDATE trend_forecasts
     SET userOutcomeTag = ?, userOutcomeNote = ?, userOutcomeUpdatedAt = ?
     WHERE id = ?`
  ).run(tag, note, Date.now(), id)
}

/** Get all forecasts that haven't been backtested yet */
export function getPendingBacktestForecasts(db: Database): TrendForecastRow[] {
  return normalizeForecastRows(db
    .prepare('SELECT * FROM trend_forecasts WHERE backtestAt IS NULL ORDER BY createdAt ASC')
    .all() as TrendForecastRow[])
}

/**
 * Get forecasts within recent N days that need intraday data for backtesting.
 * Returns objects with stockCode and the target tradeDate (the day whose intraday data is needed).
 * - today type: targetDate = createdAt's Beijing date
 * - morrow type: targetDate = next weekday after createdAt's Beijing date
 */
export function getForecastsNeedingIntraday(
  db: Database,
  withinDays = 7
): { stockCode: string; tradeDate: string; forecastId: number; type: 'today' | 'morrow' }[] {
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const cutoff = new Date(bjNow)
  cutoff.setDate(cutoff.getDate() - withinDays)
  const cutoffMs = cutoff.getTime() - 8 * 60 * 60 * 1000 // convert back to UTC

  const forecasts = db
    .prepare('SELECT * FROM trend_forecasts WHERE backtestAt IS NULL AND createdAt > ?')
    .all(cutoffMs) as TrendForecastRow[]

  const results: { stockCode: string; tradeDate: string; forecastId: number; type: 'today' | 'morrow' }[] = []
  for (const f of normalizeForecastRows(forecasts)) {
    const tradeDateStr = getForecastTargetDate(f)

    // Check if intraday_cache already has this entry
    const cached = db
      .prepare('SELECT 1 FROM intraday_cache WHERE stockCode = ? AND tradeDate = ?')
      .get(f.stockCode, tradeDateStr)
    if (!cached) {
      results.push({ stockCode: f.stockCode, tradeDate: tradeDateStr, forecastId: f.id, type: f.type })
    }
  }

  // Deduplicate by stockCode+tradeDate
  const seen = new Set<string>()
  return results.filter((r) => {
    const key = `${r.stockCode}:${r.tradeDate}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function getForecastTargetDate(row: Pick<TrendForecastRow, 'type' | 'createdAt' | 'targetDate'>): string {
  return row.targetDate || inferForecastTargetDate(row.type, row.createdAt)
}

export function inferForecastTargetDate(type: 'today' | 'morrow', createdAt: number): string {
  const bjDate = new Date(createdAt + 8 * 60 * 60 * 1000)
  const targetDate = new Date(bjDate)
  if (type === 'morrow') {
    targetDate.setUTCDate(targetDate.getUTCDate() + 1)
    const dow = targetDate.getUTCDay()
    if (dow === 6) targetDate.setUTCDate(targetDate.getUTCDate() + 2)
    if (dow === 0) targetDate.setUTCDate(targetDate.getUTCDate() + 1)
  }
  return `${targetDate.getUTCFullYear()}${String(targetDate.getUTCMonth() + 1).padStart(2, '0')}${String(targetDate.getUTCDate()).padStart(2, '0')}`
}

export function normalizeForecastRow(row: TrendForecastRow): TrendForecastRow {
  return { ...row, targetDate: getForecastTargetDate(row) }
}

export function normalizeForecastRows(rows: TrendForecastRow[]): TrendForecastRow[] {
  return rows.map(normalizeForecastRow)
}
