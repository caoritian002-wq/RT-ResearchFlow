import type Database from 'better-sqlite3'
import type { KplConceptMembersRow } from './types'

function mapRow(r: Record<string, unknown>): KplConceptMembersRow {
  return {
    conCode: r.con_code as string,
    conName: (r.con_name as string | null) ?? null,
    tsCode: r.ts_code as string,
    name: (r.name as string | null) ?? null,
    hotNum: (r.hot_num as number | null) ?? null,
    desc: (r.desc as string | null) ?? null,
    fetchedAt: (r.fetched_at as number) ?? 0
  }
}

export function upsertMembers(db: Database.Database, rows: KplConceptMembersRow[]): void {
  if (rows.length === 0) return
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO kpl_concept_members (
      con_code, con_name, ts_code, name, hot_num, "desc", fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const tx = db.transaction((items: KplConceptMembersRow[]) => {
    for (const r of items) {
      stmt.run(r.conCode, r.conName, r.tsCode, r.name, r.hotNum, r.desc, r.fetchedAt)
    }
  })
  tx(rows)
}

export function getMembersByConcept(db: Database.Database, tsCode: string): KplConceptMembersRow[] {
  const rows = db
    .prepare('SELECT * FROM kpl_concept_members WHERE ts_code = ? ORDER BY hot_num DESC')
    .all(tsCode) as Record<string, unknown>[]
  return rows.map(mapRow)
}

export function getConceptsByStock(db: Database.Database, conCode: string): KplConceptMembersRow[] {
  const rows = db
    .prepare('SELECT * FROM kpl_concept_members WHERE con_code = ? ORDER BY hot_num DESC')
    .all(conCode) as Record<string, unknown>[]
  return rows.map(mapRow)
}

/**
 * 补充插入（INSERT OR IGNORE），用于"无题材"股票的按需补查。
 * 不覆盖已有记录，仅写入全量同步未覆盖到的数据。
 */
export function insertConceptMembersIfAbsent(db: Database.Database, rows: KplConceptMembersRow[]): void {
  if (rows.length === 0) return
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO kpl_concept_members (
      con_code, con_name, ts_code, name, hot_num, "desc", fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const tx = db.transaction((items: KplConceptMembersRow[]) => {
    for (const r of items) {
      stmt.run(r.conCode, r.conName, r.tsCode, r.name, r.hotNum, r.desc, r.fetchedAt)
    }
  })
  tx(rows)
}

/** Full-replace strategy: weekly cron clears all and inserts the latest snapshot. */
export function clearAllAndReplace(db: Database.Database, rows: KplConceptMembersRow[]): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM kpl_concept_members').run()
    if (rows.length === 0) return
    const stmt = db.prepare(`
      INSERT INTO kpl_concept_members (
        con_code, con_name, ts_code, name, hot_num, "desc", fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const r of rows) {
      stmt.run(r.conCode, r.conName, r.tsCode, r.name, r.hotNum, r.desc, r.fetchedAt)
    }
  })
  tx()
}
