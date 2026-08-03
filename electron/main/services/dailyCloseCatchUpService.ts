import type Database from 'better-sqlite3'
import { getHistoricalDailyDefaultEndDate, runHistoricalDailySync, type HistoricalDailySyncResult } from './historicalDailySyncService'

export const STARTUP_DAILY_CATCH_UP_TRADE_DAYS = 20
export function getLastSettledMarketCalendarDate(now = Date.now()): string {
  return getHistoricalDailyDefaultEndDate(now)
}

export async function runStartupDailyCloseCatchUp(
  db: Database.Database,
  token: string,
  now = Date.now(),
): Promise<HistoricalDailySyncResult> {
  return runHistoricalDailySync(db, token, undefined, {
    tradeDayCount: STARTUP_DAILY_CATCH_UP_TRADE_DAYS,
    endDate: getLastSettledMarketCalendarDate(now),
  })
}
