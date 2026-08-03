const BJ_OFFSET_MS = 8 * 60 * 60 * 1000

export function formatBjDateTime(utcMs: number): string {
  const bjMs = utcMs + BJ_OFFSET_MS
  const d = new Date(bjMs)
  const now = new Date(Date.now() + BJ_OFFSET_MS)

  const sameDay =
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()

  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')

  if (sameDay) return `${hh}:${mm}`

  const M = d.getUTCMonth() + 1
  const D = d.getUTCDate()
  return `${M}月${D}日 ${hh}:${mm}`
}
