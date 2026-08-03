/**
 * FR-153: 同花顺题材成分股仓库
 *
 * 表结构（标准语义）：
 *   ths_concept_index  — 概念指数目录（ts_code=概念代码 PRIMARY KEY）
 *   ths_concept_members — 成分股明细（ts_code=股票代码, con_code=概念代码, PRIMARY KEY(ts_code,con_code)）
 *
 * 注意：与 kpl_concept_members 的列语义相反（kpl 中 con_code=股票, ts_code=概念）。
 * THS 表采用标准语义：ts_code=股票代码，con_code=概念代码。
 */

import type Database from 'better-sqlite3'
import type { ThsConceptIndexRow, ThsConceptMembersRow } from './types'

// ── 概念指数目录 ──────────────────────────────────────────

/**
 * 批量写入同花顺概念指数目录（INSERT OR REPLACE）
 */
export function upsertThsConceptIndex(
  db: Database.Database,
  rows: Array<{ tsCode: string; name: string | null; count: number | null }>
): void {
  const now = Date.now()
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO ths_concept_index (ts_code, name, count, synced_at)
    VALUES (?, ?, ?, ?)
  `)
  const run = db.transaction(() => {
    for (const r of rows) {
      stmt.run(r.tsCode, r.name, r.count, now)
    }
  })
  run()
}

/**
 * 查询所有同花顺概念指数目录
 */
export function getAllThsConceptIndex(db: Database.Database): ThsConceptIndexRow[] {
  const rows = db.prepare('SELECT ts_code, name, count, synced_at FROM ths_concept_index').all() as Array<{
    ts_code: string
    name: string | null
    count: number | null
    synced_at: number
  }>
  return rows.map(r => ({
    tsCode: r.ts_code,
    name: r.name,
    count: r.count,
    syncedAt: r.synced_at,
  }))
}

// ── 概念成分股明细 ────────────────────────────────────────

/**
 * 按股票代码查询该股所属概念列表（ts_code=股票代码）
 */
export function getThsConceptsByStock(
  db: Database.Database,
  tsCode: string
): ThsConceptMembersRow[] {
  const rows = db
    .prepare('SELECT ts_code, con_code, con_name FROM ths_concept_members WHERE ts_code = ?')
    .all(tsCode) as Array<{ ts_code: string; con_code: string; con_name: string | null }>
  return rows.map(r => ({ tsCode: r.ts_code, conCode: r.con_code, conName: r.con_name }))
}

/**
 * 按概念代码查询该概念的成分股列表（con_code=概念代码）
 */
export function getThsMembersByConcept(
  db: Database.Database,
  conCode: string
): ThsConceptMembersRow[] {
  const rows = db
    .prepare('SELECT ts_code, con_code, con_name FROM ths_concept_members WHERE con_code = ?')
    .all(conCode) as Array<{ ts_code: string; con_code: string; con_name: string | null }>
  return rows.map(r => ({ tsCode: r.ts_code, conCode: r.con_code, conName: r.con_name }))
}

/**
 * 全量清空并重建 ths_concept_members（用于每周一全量同步）
 * 使用事务保证原子性
 */
export function clearAllAndReplaceThsMembers(
  db: Database.Database,
  rows: ThsConceptMembersRow[]
): void {
  const run = db.transaction(() => {
    db.prepare('DELETE FROM ths_concept_members').run()
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO ths_concept_members (ts_code, con_code, con_name)
      VALUES (?, ?, ?)
    `)
    for (const r of rows) {
      stmt.run(r.tsCode, r.conCode, r.conName)
    }
  })
  run()
}

/**
 * 统计 ths_concept_members 表当前行数
 */
export function countThsMembers(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) as c FROM ths_concept_members').get() as { c: number }
  return row.c
}

/**
 * 查询 ths_concept_index 最近一次同步时间戳（MAX synced_at），
 * 返回毫秒时间戳，表为空时返回 null。
 */
export function getThsSyncedAt(db: Database.Database): number | null {
  const row = db.prepare('SELECT MAX(synced_at) as t FROM ths_concept_index').get() as { t: number | null }
  return row.t ?? null
}
