import { getDb } from './db'
import type Database from 'better-sqlite3'
import type {
  Briefing,
  BriefingRow,
  BriefingListOptions,
  BriefingListResult,
  BriefingSourceStat,
  ImpactRating,
  PublicationTimeStatus,
} from './types'

function rowToBriefing(row: BriefingRow): Briefing {
  return {
    ...row,
    publicationTimeStatus: row.publicationTimeStatus ?? 'exact',
    isRead: row.isRead === 1,
    isCatchUp: row.isCatchUp === 1
  }
}

export function insertBriefing(
  data: Omit<BriefingRow, 'id'>
): { inserted: boolean; id: number | null } {
  const db = getDb()
  try {
    const result = db
      .prepare(
        `INSERT INTO briefings
          (sourceId, sourceName, originalUrl, title, summary, fullContent,
           publishedAt, publishedDateBJ, publicationTimeStatus, collectedAt, impactRating,
           impactRatingScore, deduplicationHash, titleSimhash,
           isRead, readAt, scanRunId, isCatchUp)
         VALUES
          (@sourceId, @sourceName, @originalUrl, @title, @summary, @fullContent,
           @publishedAt, @publishedDateBJ, @publicationTimeStatus, @collectedAt, @impactRating,
           @impactRatingScore, @deduplicationHash, @titleSimhash,
           0, NULL, @scanRunId, @isCatchUp)`
      )
      .run(data)
    return { inserted: true, id: result.lastInsertRowid as number }
  } catch (err: unknown) {
    // UNIQUE constraint on deduplicationHash → duplicate
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      return { inserted: false, id: null }
    }
    throw err
  }
}

export function getBriefingById(id: number): Briefing | null {
  const row = getDb().prepare('SELECT * FROM briefings WHERE id = ?').get(id) as
    | BriefingRow
    | undefined
  return row ? rowToBriefing(row) : null
}

export function markAsRead(id: number): boolean {
  const result = getDb()
    .prepare('UPDATE briefings SET isRead = 1, readAt = ? WHERE id = ? AND isRead = 0')
    .run(Date.now(), id)
  return result.changes > 0
}

export function markAllAsRead(
  options: BriefingListOptions = {},
  database?: Database.Database,
): { count: number; dates: string[] } {
  const db = database ?? getDb()
  const now = Date.now()
  const built = buildBriefingConditions(options, db, true)
  if (built.noSearchResults) return { count: 0, dates: [] }
  const { conditions, params } = built
  conditions.push('b.isRead = 0')
  const where = `WHERE ${conditions.join(' AND ')}`
  const dates = (db.prepare(
    `SELECT DISTINCT b.publishedDateBJ AS date FROM briefings b ${where}`
  ).all(params) as Array<{ date: string }>).map((row) => row.date)
  const result = db.prepare(
    `UPDATE briefings SET isRead = 1, readAt = ?
     WHERE id IN (SELECT b.id FROM briefings b ${where})`
  ).run(now, ...params) as { changes: number }
  return { count: result.changes, dates }
}

export function listBriefings(
  options: BriefingListOptions = {},
  database?: Database.Database
): BriefingListResult {
  const db = database ?? getDb()
  const { sourceId, limit = 50, offset = 0 } = options
  const built = buildBriefingConditions(options, db, false)
  if (built.noSearchResults) return { items: [], total: 0, unreadCount: 0, sourceStats: [] }
  const baseConditions = built.conditions
  const baseParams = built.params

  const itemConditions = [...baseConditions]
  const itemParams = [...baseParams]
  if (sourceId != null) {
    itemConditions.push('b.sourceId = ?')
    itemParams.push(sourceId)
  }

  const itemWhere = itemConditions.length > 0 ? `WHERE ${itemConditions.join(' AND ')}` : ''
  const sourceStatsWhere = baseConditions.length > 0 ? `WHERE ${baseConditions.join(' AND ')}` : ''

  const total = (
    db
      .prepare(`SELECT COUNT(*) as cnt FROM briefings b ${itemWhere}`)
      .get(itemParams) as { cnt: number }
  ).cnt

  const unreadCount = (
    db
      .prepare(
        `SELECT COUNT(*) as cnt FROM briefings b ${itemWhere} ${itemWhere ? 'AND' : 'WHERE'} b.isRead = 0`
      )
      .get(itemParams) as { cnt: number }
  ).cnt

  const rows = db
    .prepare(
      `SELECT b.* FROM briefings b ${itemWhere}
       ORDER BY b.publishedAt DESC
       LIMIT ? OFFSET ?`
    )
    .all([...itemParams, limit, offset]) as BriefingRow[]

  const sourceStats = db
    .prepare(
      `SELECT b.sourceId as sourceId,
              b.sourceName as sourceName,
              COUNT(*) as total,
              SUM(CASE WHEN b.isRead = 0 THEN 1 ELSE 0 END) as unread,
              SUM(CASE WHEN b.impactRating != 'GENERAL' THEN 1 ELSE 0 END) as highImpact
         FROM briefings b ${sourceStatsWhere}
        GROUP BY b.sourceId, b.sourceName
        ORDER BY highImpact DESC, unread DESC, total DESC, sourceName ASC`
    )
    .all(baseParams) as BriefingSourceStat[]

  return {
    items: rows.map(rowToBriefing),
    total,
    unreadCount,
    sourceStats
  }
}

function buildBriefingConditions(
  options: BriefingListOptions,
  db: Database.Database,
  includeSource: boolean,
): { conditions: string[]; params: Array<string | number>; noSearchResults: boolean } {
  const { date, impactRating, sourceId, isRead, search, publicationTimeScope = 'all' } = options
  const conditions: string[] = []
  const params: Array<string | number> = []

  if (date) {
    if (date.length < 10) {
      conditions.push('b.publishedDateBJ LIKE ?')
      params.push(`${date}%`)
    } else {
      conditions.push('b.publishedDateBJ = ?')
      params.push(date)
    }
  }
  if (impactRating) {
    conditions.push('b.impactRating = ?')
    params.push(impactRating)
  }
  if (isRead != null) {
    conditions.push('b.isRead = ?')
    params.push(isRead ? 1 : 0)
  }
  if (publicationTimeScope === 'confirmed') {
    conditions.push("b.publicationTimeStatus != 'collected_fallback'")
  } else if (publicationTimeScope === 'uncertain') {
    conditions.push("b.publicationTimeStatus = 'collected_fallback'")
  }
  if (includeSource && sourceId != null) {
    conditions.push('b.sourceId = ?')
    params.push(sourceId)
  }
  if (search?.trim()) {
    const ftsRows = db.prepare(
      'SELECT rowid FROM briefings_fts WHERE briefings_fts MATCH ? ORDER BY rank LIMIT 500'
    ).all(`${search.trim()}*`) as Array<{ rowid: number }>
    const ids = ftsRows.map((row) => row.rowid)
    if (ids.length === 0) return { conditions, params, noSearchResults: true }
    conditions.push(`b.id IN (${ids.join(',')})`)
  }
  return { conditions, params, noSearchResults: false }
}

export function hashExists(hash: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM briefings WHERE deduplicationHash = ?')
    .get(hash)
  return row != null
}

export function findBriefingByUrlOrTitle(
  sourceId: number,
  canonicalUrl: string,
  normalizedTitle: string,
  publishedDateBJ?: string,
): Briefing | null {
  const row = getDb().prepare(
    `SELECT * FROM briefings
     WHERE originalUrl = ?
        OR (sourceId = ? AND trim(title) = ? ${publishedDateBJ ? 'AND publishedDateBJ = ?' : ''})
     ORDER BY CASE WHEN originalUrl = ? THEN 0 ELSE 1 END, id ASC
     LIMIT 1`
  ).get(
    canonicalUrl,
    sourceId,
    normalizedTitle,
    ...(publishedDateBJ ? [publishedDateBJ] : []),
    canonicalUrl,
  ) as BriefingRow | undefined
  return row ? rowToBriefing(row) : null
}

export function updateBriefingPublication(
  id: number,
  publishedAt: number,
  publishedDateBJ: string,
  status: Exclude<PublicationTimeStatus, 'collected_fallback'>,
): { previousDate: string | null; changed: boolean } {
  const db = getDb()
  const existing = db.prepare(
    'SELECT publishedDateBJ FROM briefings WHERE id = ? AND publicationTimeStatus = ?'
  ).get(id, 'collected_fallback') as { publishedDateBJ: string } | undefined
  if (!existing) return { previousDate: null, changed: false }
  const result = db.prepare(
    `UPDATE briefings
     SET publishedAt = ?, publishedDateBJ = ?, publicationTimeStatus = ?
     WHERE id = ? AND publicationTimeStatus = 'collected_fallback'`
  ).run(publishedAt, publishedDateBJ, status, id) as { changes: number }
  return { previousDate: existing.publishedDateBJ, changed: result.changes > 0 }
}

export function findSimilarSimhash(
  simhash: string,
  publishedAt: number = Date.now(),
  maxHammingDistance: number = 3,
): Briefing | null {
  // Retrieve recent simhashes and compute Hamming distance in JS
  // (SQLite has no bitwise XOR on hex strings natively)
  const rows = getDb()
    .prepare(
      `SELECT * FROM briefings
       WHERE publishedAt BETWEEN ? AND ?
       ORDER BY ABS(publishedAt - ?) ASC
       LIMIT 2000`
    )
    .all(
      publishedAt - 24 * 60 * 60 * 1000,
      publishedAt + 24 * 60 * 60 * 1000,
      publishedAt,
    ) as BriefingRow[]

  const targetBig = BigInt('0x' + simhash)
  for (const row of rows) {
    const rowBig = BigInt('0x' + row.titleSimhash)
    const xor = targetBig ^ rowBig
    const distance = popcount64(xor)
    if (distance <= maxHammingDistance) {
      return rowToBriefing(row)
    }
  }
  return null
}

function popcount64(n: bigint): number {
  let count = 0
  let v = n
  while (v > 0n) {
    v &= v - 1n
    count++
  }
  return count
}

export function deleteOldBriefings(retentionDays: number): number {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  const db = getDb()
  // 先解除 ai_analysis_sessions 对旧 briefing 的外键引用，保留会话历史
  db.prepare(
    'UPDATE ai_analysis_sessions SET briefingId = NULL WHERE briefingId IN (SELECT id FROM briefings WHERE publishedAt < ?)'
  ).run(cutoff)
  const result = db
    .prepare('DELETE FROM briefings WHERE publishedAt < ?')
    .run(cutoff) as { changes: number }
  return result.changes
}

export function getLatestBriefingDate(): number | null {
  const row = getDb()
    .prepare('SELECT MAX(publishedAt) as latest FROM briefings')
    .get() as { latest: number | null }
  return row.latest
}

export function countByRating(): Record<ImpactRating, number> {
  const rows = getDb()
    .prepare(
      `SELECT impactRating, COUNT(*) as cnt FROM briefings WHERE isRead = 0 GROUP BY impactRating`
    )
    .all() as { impactRating: ImpactRating; cnt: number }[]
  const result: Record<ImpactRating, number> = { CRITICAL: 0, IMPORTANT: 0, GENERAL: 0 }
  for (const row of rows) {
    result[row.impactRating] = row.cnt
  }
  return result
}
