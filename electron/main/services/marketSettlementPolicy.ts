const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

export const AFTER_CLOSE_SYNC_HOUR_BJ = 18
export const AFTER_CLOSE_SYNC_MINUTE_BJ = 0

export function formatBeijingYmd(date: Date): string {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
}

export function getBeijingYmd(now = Date.now()): string {
  return formatBeijingYmd(new Date(now + BEIJING_OFFSET_MS))
}

export function offsetYmd(ymd: string, days: number): string {
  const shifted = new Date(
    Date.UTC(
      Number(ymd.slice(0, 4)),
      Number(ymd.slice(4, 6)) - 1,
      Number(ymd.slice(6, 8)) + days,
    ),
  )
  return formatBeijingYmd(shifted)
}

export function isWeekdayYmd(ymd: string): boolean {
  const day = new Date(Date.UTC(
    Number(ymd.slice(0, 4)),
    Number(ymd.slice(4, 6)) - 1,
    Number(ymd.slice(6, 8)),
  )).getUTCDay()
  return day !== 0 && day !== 6
}

export function getLastSettledCalendarDate(now = Date.now()): string {
  const beijing = new Date(now + BEIJING_OFFSET_MS)
  const hhmm = beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
  const cutoff = AFTER_CLOSE_SYNC_HOUR_BJ * 60 + AFTER_CLOSE_SYNC_MINUTE_BJ
  if (hhmm < cutoff) beijing.setUTCDate(beijing.getUTCDate() - 1)
  return formatBeijingYmd(beijing)
}

export function getBeijingEpochForYmd(
  ymd: string,
  hour = AFTER_CLOSE_SYNC_HOUR_BJ,
  minute = AFTER_CLOSE_SYNC_MINUTE_BJ,
): number {
  return Date.UTC(
    Number(ymd.slice(0, 4)),
    Number(ymd.slice(4, 6)) - 1,
    Number(ymd.slice(6, 8)),
    hour - 8,
    minute,
  )
}
