import type Database from 'better-sqlite3'
import type { BrowserWindow } from 'electron'
import {
  backfillDailyCloseTurnover,
  countDailyCloseByTradeDates,
  countMissingDailyCloseTurnoverByTradeDates,
  upsertDailyClose,
} from '../database/dailyCloseCacheRepository'
import { getLastNTradingDays } from '../database/tradeCalRepository'
import {
  fetchDailyBasicByDate,
  fetchDailyByDate,
  getTushareAccessErrorCode,
  type TushareAccessErrorCode,
} from './tushareService'
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
  turnoverSupplementWarning: HistoricalDailyTurnoverWarning | null
}

export type HistoricalDailyTurnoverWarning = TushareAccessErrorCode | 'TUSHARE_UPSTREAM_UNAVAILABLE'

export interface HistoricalDailySyncOptions {
  tradeDayCount?: number
  completeRowThreshold?: number
  endDate?: string
  requestDelayMs?: number
  onProgress?: (progress: HistoricalDailyProgress) => void
}

export const HISTORICAL_DAILY_TARGET_TRADE_DAYS = 480
const DEFAULT_COMPLETE_ROW_THRESHOLD = 4000
const MAX_CONSECUTIVE_DATE_FAILURES = 3

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

function createHistoricalDailyError(code: string, message = code): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
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
  let consecutiveDateFailures = 0
  let turnoverSupplementWarning: HistoricalDailyTurnoverWarning | null = null

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
    const turnoverGaps = countMissingDailyCloseTurnoverByTradeDates(db, tradeDays)

    for (const tradeDate of tradeDays) {
      progress.currentTradeDate = tradeDate
      const existingRows = coverage.get(tradeDate) ?? 0
      const missingTurnoverRows = turnoverGaps.get(tradeDate) ?? 0
      if (existingRows >= completeRowThreshold && missingTurnoverRows === 0) {
        progress.processedTradeDays += 1
        progress.skippedTradeDays += 1
        progress.message = `${tradeDate} 已有 ${existingRows} 条日线, 跳过`
        emitProgress(win, progress, options.onProgress)
        continue
      }

      let requested = false
      let dateSucceeded = false
      try {
        if (existingRows >= completeRowThreshold) {
          if (turnoverSupplementWarning) {
            progress.skippedTradeDays += 1
            dateSucceeded = true
            progress.message = `${tradeDate} 日线已可用，换手率补充已停止（${turnoverSupplementWarning}）`
          } else {
            progress.message = `正在补齐 ${tradeDate} 的 ${missingTurnoverRows} 条换手率`
            emitProgress(win, progress, options.onProgress)
            requested = true
            try {
              const basics = await fetchDailyBasicByDate(token, tradeDate)
              const updated = backfillDailyCloseTurnover(db, basics)
              progress.insertedRows += updated
              if (updated >= missingTurnoverRows) {
                progress.syncedTradeDays += 1
                dateSucceeded = true
                progress.message = `${tradeDate} 已补齐 ${updated} 条换手率`
              } else {
                progress.failedTradeDays += 1
                failedDates.push(tradeDate)
                progress.message = `${tradeDate} 仅补齐 ${updated}/${missingTurnoverRows} 条换手率`
              }
            } catch (err) {
              const warning = getTushareAccessErrorCode(err) ?? 'TUSHARE_UPSTREAM_UNAVAILABLE'
              turnoverSupplementWarning = warning
              progress.skippedTradeDays += 1
              dateSucceeded = true
              progress.message = `${tradeDate} 日线已可用，换手率补充已停止（${warning}）`
              console.warn('[HistoricalDailySync] turnover supplement stopped:', warning)
            }
          }
        } else {
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
            if (!turnoverSupplementWarning) {
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
                turnoverSupplementWarning = getTushareAccessErrorCode(err) ?? 'TUSHARE_UPSTREAM_UNAVAILABLE'
                console.warn('[HistoricalDailySync] daily_basic merge failed:', err instanceof Error ? err.message : String(err))
              }
            }

            upsertDailyClose(db, mergedRows, {
              dataSource: 'tushare',
              amountSource: 'tushare',
              turnoverSource: 'tushare',
              fetchedAt: Date.now(),
            })
            progress.insertedRows += mergedRows.length
            progress.syncedTradeDays += 1
            dateSucceeded = true
            progress.message = `${tradeDate} 写入 ${mergedRows.length} 条日线`
          }
        }
      } catch (err) {
        progress.failedTradeDays += 1
        failedDates.push(tradeDate)
        const accessCode = getTushareAccessErrorCode(err)
        progress.message = accessCode
          ? `${tradeDate} 同步已停止: ${accessCode}`
          : `${tradeDate} 同步失败: ${err instanceof Error ? err.message : String(err)}`
        console.warn('[HistoricalDailySync] date failed:', tradeDate, err)
        if (accessCode) throw createHistoricalDailyError(accessCode)
      } finally {
        progress.processedTradeDays += 1
        emitProgress(win, progress, options.onProgress)
      }
      consecutiveDateFailures = dateSucceeded ? 0 : consecutiveDateFailures + 1
      if (consecutiveDateFailures >= MAX_CONSECUTIVE_DATE_FAILURES) {
        throw createHistoricalDailyError(
          'HISTORICAL_DAILY_UPSTREAM_UNAVAILABLE',
          `连续 ${consecutiveDateFailures} 个交易日同步失败，已停止重复请求`,
        )
      }
      if (requested && requestDelayMs > 0 && progress.processedTradeDays < progress.totalTradeDays) {
        await new Promise((resolve) => setTimeout(resolve, requestDelayMs))
      }
    }

    progress.currentTradeDate = null
    const turnoverMessage = turnoverSupplementWarning ? `, 换手率补充已降级(${turnoverSupplementWarning})` : ''
    progress.message = failedDates.length > 0
      ? `历史日线同步完成, ${failedDates.length} 个交易日失败, 可再次运行补齐${turnoverMessage}`
      : `历史日线同步完成${turnoverMessage}`
    emitProgress(win, progress, options.onProgress)

    return {
      ...progress,
      startDate: tradeDays[0] ?? null,
      endDate: tradeDays[tradeDays.length - 1] ?? null,
      failedDates,
      turnoverSupplementWarning,
    }
  } finally {
    syncRunning = false
  }
}
