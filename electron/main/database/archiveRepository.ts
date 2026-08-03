import { getDb } from './db'
import type { DailyArchiveRow } from './types'
import { todayBj } from '../utils/dateUtils'

export function listArchiveDates(limit = 90): DailyArchiveRow[] {
  return getDb()
    .prepare('SELECT * FROM daily_archive WHERE date <= ? ORDER BY date DESC LIMIT ?')
    .all(todayBj(), limit) as DailyArchiveRow[]
}

export function getArchiveForDate(date: string): DailyArchiveRow | null {
  if (date > todayBj()) return null
  return (
    (getDb()
      .prepare('SELECT * FROM daily_archive WHERE date = ?')
      .get(date) as DailyArchiveRow | undefined) ?? null
  )
}

export function refreshDailyArchive(date: string): void {
  const db = getDb()
  if (date > todayBj()) {
    db.prepare('DELETE FROM daily_archive WHERE date = ?').run(date)
    return
  }
  const stats = db
    .prepare(
      `SELECT
         SUM(CASE WHEN publicationTimeStatus != 'collected_fallback' THEN 1 ELSE 0 END) AS totalCount,
         SUM(CASE WHEN publicationTimeStatus != 'collected_fallback' AND isRead = 0 THEN 1 ELSE 0 END) AS unreadCount,
         SUM(CASE WHEN publicationTimeStatus != 'collected_fallback' AND impactRating = 'CRITICAL' THEN 1 ELSE 0 END) AS criticalCount,
         SUM(CASE WHEN publicationTimeStatus = 'collected_fallback' THEN 1 ELSE 0 END) AS uncertainTimeCount
       FROM briefings
       WHERE publishedDateBJ = ?`
    )
    .get(date) as { totalCount: number; unreadCount: number; criticalCount: number; uncertainTimeCount: number }

  db.prepare(
    `INSERT INTO daily_archive (date, totalCount, unreadCount, criticalCount, uncertainTimeCount, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       totalCount    = excluded.totalCount,
       unreadCount   = excluded.unreadCount,
       criticalCount = excluded.criticalCount,
       uncertainTimeCount = excluded.uncertainTimeCount,
       updatedAt     = excluded.updatedAt`
  ).run(
    date,
    stats.totalCount ?? 0,
    stats.unreadCount ?? 0,
    stats.criticalCount ?? 0,
    stats.uncertainTimeCount ?? 0,
    Date.now(),
  )
}

export function refreshArchiveForAffectedDates(dates: string[]): void {
  const unique = [...new Set(dates)]
  for (const date of unique) {
    refreshDailyArchive(date)
  }
}
