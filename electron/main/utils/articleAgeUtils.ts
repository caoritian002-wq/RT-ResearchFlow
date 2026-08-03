/**
 * FR-053: Determine article publication date from DB field or summary text.
 * Priority: publishedAt (UTC ms) → summary regex → null (unknown).
 */
export function parseArticleAge(publishedAt: number | null, summary: string): Date | null {
  if (publishedAt) return new Date(publishedAt)

  // Try YYYY年MM月DD日
  const fullMatch = summary.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
  if (fullMatch) {
    return new Date(
      parseInt(fullMatch[1]),
      parseInt(fullMatch[2]) - 1,
      parseInt(fullMatch[3])
    )
  }

  // Try MM月DD日 — assume current year, rollback if future
  const partialMatch = summary.match(/(\d{1,2})月(\d{1,2})日/)
  if (partialMatch) {
    const now = new Date()
    const d = new Date(now.getFullYear(), parseInt(partialMatch[1]) - 1, parseInt(partialMatch[2]))
    if (d > now) d.setFullYear(d.getFullYear() - 1)
    return d
  }

  return null
}

/**
 * Returns true if the article is older than maxDays.
 * Returns false when maxDays is null (no filter) or age cannot be determined.
 */
export function isArticleExpired(
  publishedAt: number | null,
  summary: string,
  maxDays: number | null
): boolean {
  if (maxDays === null) return false
  const date = parseArticleAge(publishedAt, summary)
  if (!date) return false
  const ageDays = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24)
  return ageDays > maxDays
}
