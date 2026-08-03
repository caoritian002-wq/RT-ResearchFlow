// Beijing time is UTC+8. We compute dates manually to avoid platform timezone issues.
const BJ_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * Convert a UTC timestamp (ms) to a YYYY-MM-DD string in Beijing time (UTC+8).
 */
export function utcToBjDate(utcMs: number): string {
  const bjMs = utcMs + BJ_OFFSET_MS
  const d = new Date(bjMs)
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * Return today's date string in Beijing time.
 */
export function todayBj(): string {
  return utcToBjDate(Date.now())
}

/**
 * Parse an ISO date string or various date formats to UTC milliseconds.
 * Returns null if parsing fails.
 */
export function parsePublishedDate(raw: string | Date | undefined | null): number | null {
  if (!raw) return null
  try {
    const d = raw instanceof Date ? raw : new Date(raw)
    if (isNaN(d.getTime())) return null
    return d.getTime()
  } catch {
    return null
  }
}

/**
 * Format a UTC ms timestamp to a human-readable Beijing time string.
 */
export function formatBjDateTime(utcMs: number): string {
  const bjMs = utcMs + BJ_OFFSET_MS
  const d = new Date(bjMs)
  return (
    `${d.getUTCFullYear()}-` +
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getUTCDate()).padStart(2, '0')} ` +
    `${String(d.getUTCHours()).padStart(2, '0')}:` +
    `${String(d.getUTCMinutes()).padStart(2, '0')}`
  )
}
