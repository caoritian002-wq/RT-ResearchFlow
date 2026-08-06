import { getDb } from './db'
import type { DetailCacheRow } from './types'

export function hasUsableDetailContent(content: string | null | undefined): boolean {
  return Boolean(content?.trim())
}

export function getCachedDetail(cacheKey: string): DetailCacheRow | null {
  const row = getDb()
    .prepare('SELECT * FROM detail_cache WHERE cacheKey = ?')
    .get(cacheKey) as DetailCacheRow | undefined
  return row && hasUsableDetailContent(row.content) ? row : null
}

export function setCachedDetail(cacheKey: string, briefingUrl: string, content: string): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO detail_cache (cacheKey, briefingUrl, content, fetchedAt)
       VALUES (?, ?, ?, ?)`
    )
    .run(cacheKey, briefingUrl, content, Date.now())
}

export interface CacheStats {
  count: number
  estimatedBytes: number
}

export function getCacheStats(): CacheStats {
  const row = getDb()
    .prepare('SELECT COUNT(*) as count, SUM(LENGTH(content)) as bytes FROM detail_cache')
    .get() as { count: number; bytes: number | null }
  return { count: row.count, estimatedBytes: row.bytes ?? 0 }
}

/** range: 'all' | '1month' | '3months' | '1year' */
export function clearDetailCache(range: 'all' | '1month' | '3months' | '1year'): number {
  const db = getDb()
  let result: { changes: number }

  if (range === 'all') {
    result = db.prepare('DELETE FROM detail_cache').run() as { changes: number }
  } else {
    const ms = range === '1month' ? 30 : range === '3months' ? 90 : 365
    const cutoff = Date.now() - ms * 24 * 60 * 60 * 1000
    result = db
      .prepare('DELETE FROM detail_cache WHERE fetchedAt < ?')
      .run(cutoff) as { changes: number }
  }

  return result.changes
}
