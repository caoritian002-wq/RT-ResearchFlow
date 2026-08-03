import { getDb } from './db'
import type { Source, SourceRow, SourceStatus, ParseStrategy, SourceCategory } from './types'

function rowToSource(row: SourceRow): Source {
  return {
    ...row,
    isBuiltIn: row.isBuiltIn === 1,
    isEnabled: row.isEnabled === 1
  }
}

export function getAllSources(): Source[] {
  const rows = getDb().prepare('SELECT * FROM sources ORDER BY authorityWeight DESC, id').all() as SourceRow[]
  return rows.map(rowToSource)
}

export function getEnabledSources(): Source[] {
  const rows = getDb()
    .prepare('SELECT * FROM sources WHERE isEnabled = 1 ORDER BY authorityWeight DESC')
    .all() as SourceRow[]
  return rows.map(rowToSource)
}

export function getSourceById(id: number): Source | null {
  const row = getDb().prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow | undefined
  return row ? rowToSource(row) : null
}

export function addCustomSource(data: {
  nameCN: string
  nameEN: string
  url: string
  feedUrl?: string | null
  parseStrategy: ParseStrategy
  contentSelector?: string | null
  financeSectionFilter?: string | null
  detailSelector?: string | null
  authorityWeight?: number
}): Source {
  const db = getDb()
  const result = db
    .prepare(
      `INSERT INTO sources
        (nameCN, nameEN, url, feedUrl, category, authorityWeight,
         isBuiltIn, isEnabled, status, successRate,
         parseStrategy, contentSelector, financeSectionFilter, detailSelector)
       VALUES
        (@nameCN, @nameEN, @url, @feedUrl, 'CUSTOM', @authorityWeight,
         0, 1, 'ACTIVE', 1.0,
         @parseStrategy, @contentSelector, @financeSectionFilter, @detailSelector)`
    )
    .run({
      nameCN: data.nameCN,
      nameEN: data.nameEN,
      url: data.url,
      feedUrl: data.feedUrl ?? null,
      authorityWeight: data.authorityWeight ?? 5,
      parseStrategy: data.parseStrategy,
      contentSelector: data.contentSelector ?? null,
      financeSectionFilter: data.financeSectionFilter ?? null,
      detailSelector: data.detailSelector ?? null
    })
  const id = result.lastInsertRowid as number
  return rowToSource(getDb().prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow)
}

export function toggleSourceEnabled(id: number, isEnabled: boolean): boolean {
  const result = getDb()
    .prepare('UPDATE sources SET isEnabled = ? WHERE id = ?')
    .run(isEnabled ? 1 : 0, id) as { changes: number }
  return result.changes > 0
}

export function updateSourceStatus(id: number, status: SourceStatus, successRate?: number): void {
  const db = getDb()
  if (successRate !== undefined) {
    db.prepare('UPDATE sources SET status = ?, successRate = ?, lastScannedAt = ? WHERE id = ?').run(
      status,
      successRate,
      Date.now(),
      id
    )
  } else {
    db.prepare('UPDATE sources SET status = ?, lastScannedAt = ? WHERE id = ?').run(
      status,
      Date.now(),
      id
    )
  }
}

export function updateSource(
  id: number,
  data: Partial<{
    nameCN: string
    nameEN: string
    url: string
    feedUrl: string | null
    category: SourceCategory
    authorityWeight: number
    isEnabled: boolean
    parseStrategy: ParseStrategy
    contentSelector: string | null
    financeSectionFilter: string | null
    detailSelector: string | null
  }>
): Source | null {
  const db = getDb()
  const fields: string[] = []
  const values: (string | number | null)[] = []

  if (data.nameCN !== undefined) { fields.push('nameCN = ?'); values.push(data.nameCN) }
  if (data.nameEN !== undefined) { fields.push('nameEN = ?'); values.push(data.nameEN) }
  if (data.url !== undefined) { fields.push('url = ?'); values.push(data.url) }
  if (data.feedUrl !== undefined) { fields.push('feedUrl = ?'); values.push(data.feedUrl) }
  if (data.category !== undefined) { fields.push('category = ?'); values.push(data.category) }
  if (data.authorityWeight !== undefined) { fields.push('authorityWeight = ?'); values.push(data.authorityWeight) }
  if (data.isEnabled !== undefined) { fields.push('isEnabled = ?'); values.push(data.isEnabled ? 1 : 0) }
  if (data.parseStrategy !== undefined) { fields.push('parseStrategy = ?'); values.push(data.parseStrategy) }
  if (data.contentSelector !== undefined) { fields.push('contentSelector = ?'); values.push(data.contentSelector) }
  if (data.financeSectionFilter !== undefined) { fields.push('financeSectionFilter = ?'); values.push(data.financeSectionFilter) }
  if (data.detailSelector !== undefined) { fields.push('detailSelector = ?'); values.push(data.detailSelector) }

  if (fields.length === 0) return getSourceById(id)

  db.prepare(`UPDATE sources SET ${fields.join(', ')} WHERE id = ?`).run([...values, id])
  return getSourceById(id)
}

export function deleteCustomSource(id: number): boolean {
  const result = getDb()
    .prepare('DELETE FROM sources WHERE id = ? AND isBuiltIn = 0')
    .run(id) as { changes: number }
  return result.changes > 0
}

export function seedBuiltInSources(sources: Omit<SourceRow, 'id' | 'lastScannedAt' | 'successRate'>[]): void {
  const db = getDb()

  const checkByUrl  = db.prepare('SELECT id FROM sources WHERE url = ?')
  const checkByName = db.prepare('SELECT id FROM sources WHERE nameCN = ? AND isBuiltIn = 1 LIMIT 1')

  const insert = db.prepare(
    `INSERT INTO sources
      (nameCN, nameEN, url, feedUrl, category, authorityWeight,
       isBuiltIn, isEnabled, status, successRate,
       parseStrategy, contentSelector, financeSectionFilter, detailSelector)
     VALUES
      (@nameCN, @nameEN, @url, @feedUrl, @category, @authorityWeight,
       @isBuiltIn, @isEnabled, @status, 1.0,
       @parseStrategy, @contentSelector, @financeSectionFilter, @detailSelector)`
  )

  // Update scraping-related fields for existing built-in sources so changes
  // to seeds.ts (e.g. adding detailSelector or a changed URL) take effect without wiping the DB.
  const updateByUrl = db.prepare(
    `UPDATE sources SET
       nameCN = @nameCN, nameEN = @nameEN,
       feedUrl = @feedUrl, category = @category,
       authorityWeight = @authorityWeight, parseStrategy = @parseStrategy,
       contentSelector = @contentSelector,
       financeSectionFilter = @financeSectionFilter,
       detailSelector = @detailSelector
     WHERE url = @url AND isBuiltIn = 1`
  )

  // Fallback: source existed with a different URL — update URL too so it stays a single row
  const updateByName = db.prepare(
    `UPDATE sources SET
       url = @url, nameEN = @nameEN,
       feedUrl = @feedUrl, category = @category,
       authorityWeight = @authorityWeight, parseStrategy = @parseStrategy,
       contentSelector = @contentSelector,
       financeSectionFilter = @financeSectionFilter,
       detailSelector = @detailSelector
     WHERE nameCN = @nameCN AND isBuiltIn = 1`
  )

  const upsertMany = db.transaction((rows: typeof sources) => {
    for (const row of rows) {
      const existingByUrl = checkByUrl.get(row.url) as { id: number } | undefined
      if (existingByUrl) {
        updateByUrl.run(row)
      } else {
        const existingByName = checkByName.get(row.nameCN) as { id: number } | undefined
        if (existingByName) {
          // URL changed in seeds.ts — update the existing row's URL and fields
          updateByName.run(row)
        } else {
          insert.run(row)
        }
      }
    }
  })

  upsertMany(sources)
}
