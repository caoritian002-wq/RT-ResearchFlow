import { getSettings } from '../database/settingsRepository'
import { deleteOldBriefings } from '../database/briefingRepository'
import { utcToBjDate } from '../utils/dateUtils'

let _lastCleanDate: string | null = null

/**
 * Run data retention cleanup if it hasn't run today (Beijing time).
 * Deletes briefings older than retentionDays.
 */
export function runCleanupIfNeeded(): void {
  const todayBj = utcToBjDate(Date.now())
  if (_lastCleanDate === todayBj) return

  const settings = getSettings()
  const deleted = deleteOldBriefings(settings.retentionDays)
  _lastCleanDate = todayBj

  if (deleted > 0) {
    console.log(`[Cleaner] Deleted ${deleted} briefings older than ${settings.retentionDays} days`)
  }
}

/**
 * Schedule daily cleanup at midnight Beijing time.
 */
export function scheduleDailyCleanup(): void {
  runCleanupIfNeeded()

  // Check every hour if it's a new BJ day
  setInterval(() => {
    runCleanupIfNeeded()
  }, 60 * 60 * 1000)
}
