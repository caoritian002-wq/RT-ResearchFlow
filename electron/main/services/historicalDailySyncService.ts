import type Database from 'better-sqlite3'
import type { BrowserWindow } from 'electron'
import { countDailyCloseByTradeDates, upsertDailyClose } from '../database/dailyCloseCacheRepository'
import { getLastNTradingDays } from '../database/tradeCalRepository'
import { fetchDailyBasicByDate, fetchDailyByDate } from './tushareService'
import { syncTradeCalFull, syncTradeCalIfNeeded } from './tradeCalSyncService'
import { getLastSettledCalendarDate } from './marketSettlementPolicy'

export interface HistoricalDailyProgress {
  totalTradeDays: number
  processedTradeDays: number
  skippedTradeDays: number
  syncedTradeDays: number
  failedTradeDays: number
  currentTradeDate: string | null
  insertedRows: number
  message: string
}

export interface HistoricalDailySyncResult extends HistoricalDailyProgress {
  startDate: string | null
  endDate: string | null
  failedDates: string[]
}

export interface HistoricalDailySyncOptions {
  tradeDayCount?: number
  completeRowThreshold?: number
  endDate?: string
  requestDelayMs?: number
  onProgress?: (progress: HistoricalDailyProgress) => void
}

export const HISTORICAL_DAILY_TARGET_TRADE_DAYS = 480
const DEFAULT_COMPLETE_ROW_THRESHOLD = 4000

let syncRunning = false

export function getHistoricalDailyDefaultEndDate(now = Date.now()): string {
  return getLastSettledCalendarDate(now)
}

function emitProgress(win: BrowserWindow | undefined, progress: HistoricalDailyProgress, onProgress?: (progress: HistoricalDailyProgress) => void): void {
  win?.webContents.send('diagnostics:historicalDailyProgress', progress)
  onProgress?.({ ...progress })
}

export function isHistoricalDailySyncRunning(): boolean {
  return syncRunning
}

export async function runHistoricalDailySync(
  db: Database.Database,
  token: string,
  win?: BrowserWindow,
  options: HistoricalDailySyncOptions = {}
): Promise<HistoricalDailySyncResult> {
  if (syncRunning) throw new Error('HISTORICAL_DAILY_SYNC_RUNNING')
  syncRunning = true
  const tradeDayCount = options.tradeDayCount ?? HISTORICAL_DAILY_TARGET_TRADE_DAYS
  const completeRowThreshold = options.completeRowThreshold ?? DEFAULT_COMPLETE_ROW_THRESHOLD
  const endDate = options.endDate ?? getHistoricalDailyDefaultEndDate()
  const requestDelayMs = Math.max(0, options.requestDelayMs ?? 500)

  const progress: HistoricalDailyProgress = {
    totalTradeDays: 0,
    processedTradeDays: 0,
    skippedTradeDays: 0,
    syncedTradeDays: 0,
    failedTradeDays: 0,
    currentTradeDate: null,
    insertedRows: 0,
    message: '准备同步全市场历史日线'
  }
  const failedDates: string[] = []

  try {
    await syncTradeCalIfNeeded(db, token)
    let tradeDays = getLastNTradingDays(db, tradeDayCount, endDate)
    if (tradeDays.length < tradeDayCount) {
      await syncTradeCalFull(db, token)
      tradeDays = getLastNTradingDays(db, tradeDayCount, endDate)
    }
    if (tradeDays.length < tradeDayCount) {
      const error = new Error(`交易日历历史覆盖不足：需要 ${tradeDayCount} 日，当前 ${tradeDays.length} 日`) as Error & { code: string }
      error.code = 'TRADE_CAL_HISTORY_INCOMPLETE'
      throw error
    }

    progress.totalTradeDays = tradeDays.length
    progress.message = `待检查 ${tradeDays.length} 个交易日`
    emitProgress(win, progress, options.onProgress)

    const coverage = countDailyCloseByTradeDates(db, tradeDays)

    for (const tradeDate of tradeDays) {
      progress.currentTradeDate = tradeDate
      const existingRows = coverage.get(tradeDate) ?? 0
      if (existingRows >= completeRowThreshold) {
        progress.processedTradeDays += 1
        progress.skippedTradeDays += 1
        progress.message = `${tradeDate} 已有 ${existingRows} 条日线, 跳过`
        emitProgress(win, progress, options.onProgress)
        continue
      }

      let requested = false
      try {
        progress.message = `正在同步 ${tradeDate} 全市场日线`
        emitProgress(win, progress, options.onProgress)
        requested = true
        const rows = await fetchDailyByDate(token, tradeDate)
        if (rows.length === 0) {
          progress.failedTradeDays += 1
          failedDates.push(tradeDate)
          progress.message = `${tradeDate} daily 返回 0 行`
        } else {
          let mergedRows = rows
          try {
            const basics = await fetchDailyBasicByDate(token, tradeDate)
            if (basics.length > 0) {
              const turnoverMap = new Map(basics.map((row) => [row.tsCode, row.turnoverRate]))
              mergedRows = rows.map((row) => ({
                ...row,
                turnoverRate: turnoverMap.get(row.tsCode) ?? row.turnoverRate ?? null
              }))
            }
          } catch (err) {
            console.warn('[HistoricalDailySync] daily_basic merge failed:', err instanceof Error ? err.message : String(err))
          }

          upsertDailyClose(db, mergedRows)
          progress.insertedRows += mergedRows.length
          progress.syncedTradeDays += 1
          progress.message = `${tradeDate} 写入 ${mergedRows.length} 条日线`
        }
      } catch (err) {
        progress.failedTradeDays += 1
        failedDates.push(tradeDate)
        progress.message = `${tradeDate} 同步失败: ${err instanceof Error ? err.message : String(err)}`
        console.warn('[HistoricalDailySync] date failed:', tradeDate, err)
      } finally {
        progress.processedTradeDays += 1
        emitProgress(win, progress, options.onProgress)
      }
      if (requested && requestDelayMs > 0 && progress.processedTradeDays < progress.totalTradeDays) {
        await new Promise((resolve) => setTimeout(resolve, requestDelayMs))
      }
    }

    progress.currentTradeDate = null
    progress.message = failedDates.length > 0
      ? `历史日线同步完成, ${failedDates.length} 个交易日失败, 可再次运行补齐`
      : '历史日线同步完成'
    emitProgress(win, progress, options.onProgress)

    return {
      ...progress,
      startDate: tradeDays[0] ?? null,
      endDate: tradeDays[tradeDays.length - 1] ?? null,
      failedDates
    }
  } finally {
    syncRunning = false
  }
}
