import type Database from 'better-sqlite3'
import {
  cleanupDailyCloseCache,
  DAILY_CLOSE_RETENTION_TRADE_DAYS,
  getDailyCloseMaintenanceState,
  getDailyCloseQualitySummary,
  saveDailyCloseMaintenanceState,
  type DailyCloseMaintenanceState,
} from '../database/dailyCloseCacheRepository'

export type MaintenanceClock = () => number

function getSafeFailureMessage(error: unknown): string {
  if (error instanceof RangeError) return '历史日线保留窗口参数无效'
  return '历史日线清理失败，请查看应用日志'
}

export function runDailyCloseMaintenance(
  db: Database.Database,
  retainTradeDays = DAILY_CLOSE_RETENTION_TRADE_DAYS,
  now: MaintenanceClock = Date.now,
): DailyCloseMaintenanceState {
  const startedAt = now()
  saveDailyCloseMaintenanceState(db, {
    status: 'running',
    startedAt,
    completedAt: null,
    retainTradeDays,
    removedRows: null,
    remainingTradeDays: null,
    message: null,
  })

  try {
    const removedRows = cleanupDailyCloseCache(db, retainTradeDays)
    const remainingTradeDays = getDailyCloseQualitySummary(db).actualTradeDays
    const state: DailyCloseMaintenanceState = {
      status: 'success',
      startedAt,
      completedAt: now(),
      retainTradeDays,
      removedRows,
      remainingTradeDays,
      message: null,
    }
    saveDailyCloseMaintenanceState(db, state)
    return state
  } catch (error) {
    saveDailyCloseMaintenanceState(db, {
      status: 'failed',
      startedAt,
      completedAt: now(),
      retainTradeDays,
      removedRows: null,
      remainingTradeDays: null,
      message: getSafeFailureMessage(error),
    })
    throw error
  }
}

export function readDailyCloseMaintenanceState(
  db: Database.Database,
): DailyCloseMaintenanceState | null {
  return getDailyCloseMaintenanceState(db)
}