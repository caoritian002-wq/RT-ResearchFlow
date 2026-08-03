/**
 * FR-153: 东方财富题材成分股仓库
 *
 * 表结构：
 *   dc_concept_members — 按日期存储（ts_code=股票, trade_date=交易日, theme_code=题材代码, PRIMARY KEY(ts_code, trade_date, theme_code)）
 *
 * 说明：DC 数据为每日快照，支持历史日期查询；需定期清理旧数据。
 */

import type Database from 'better-sqlite3'
import type { DcConceptMembersRow } from './types'

/**
 * 批量写入东方财富题材成分股（INSERT OR REPLACE）
 */
export function upsertDcConceptMembers(
  db: Database.Database,
  rows: DcConceptMembersRow[]
): void {
  if (rows.length === 0) return
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO dc_concept_members
      (ts_code, trade_date, name, theme_code, theme_name, industry_code, industry)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const run = db.transaction(() => {
    for (const r of rows) {
      stmt.run(r.tsCode, r.tradeDate, r.name, r.themeCode, r.themeName, r.industryCode, r.industry)
    }
  })
  run()
}

/**
 * 查询指定股票在指定交易日的所属题材列表
 * @param tsCode     股票代码（含交易所后缀）
 * @param tradeDate  交易日 YYYYMMDD
 */
export function getDcConceptsByStock(
  db: Database.Database,
  tsCode: string,
  tradeDate: string
): DcConceptMembersRow[] {
  const rows = db.prepare(`
    SELECT ts_code, trade_date, name, theme_code, theme_name, industry_code, industry
    FROM dc_concept_members
    WHERE ts_code = ? AND trade_date = ?
  `).all(tsCode, tradeDate) as Array<{
    ts_code: string
    trade_date: string
    name: string | null
    theme_code: string
    theme_name: string | null
    industry_code: string | null
    industry: string | null
  }>
  return rows.map(r => ({
    tsCode: r.ts_code,
    tradeDate: r.trade_date,
    name: r.name,
    themeCode: r.theme_code,
    themeName: r.theme_name,
    industryCode: r.industry_code,
    industry: r.industry,
  }))
}

/**
 * 查询指定题材在指定交易日的成员股票列表
 * @param themeCode  题材代码
 * @param tradeDate  交易日 YYYYMMDD
 */
export function getDcMembersByTheme(
  db: Database.Database,
  themeCode: string,
  tradeDate: string
): DcConceptMembersRow[] {
  const rows = db.prepare(`
    SELECT ts_code, trade_date, name, theme_code, theme_name, industry_code, industry
    FROM dc_concept_members
    WHERE theme_code = ? AND trade_date = ?
  `).all(themeCode, tradeDate) as Array<{
    ts_code: string
    trade_date: string
    name: string | null
    theme_code: string
    theme_name: string | null
    industry_code: string | null
    industry: string | null
  }>
  return rows.map(r => ({
    tsCode: r.ts_code,
    tradeDate: r.trade_date,
    name: r.name,
    themeCode: r.theme_code,
    themeName: r.theme_name,
    industryCode: r.industry_code,
    industry: r.industry,
  }))
}

/**
 * 查询指定交易日 dc_concept_members 是否已有数据
 */
export function hasDcDataForDate(db: Database.Database, tradeDate: string): boolean {
  const row = db
    .prepare('SELECT COUNT(*) as c FROM dc_concept_members WHERE trade_date = ?')
    .get(tradeDate) as { c: number }
  return row.c > 0
}

/**
 * 清理超出保留天数的旧数据
 * @param daysToKeep  保留最近 N 个日历日内的数据
 */
export function cleanupDcConceptMembers(db: Database.Database, daysToKeep: number): number {
  const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000 + 8 * 60 * 60 * 1000)
  const cutoffYmd = cutoff.toISOString().slice(0, 10).replace(/-/g, '')
  const result = db
    .prepare('DELETE FROM dc_concept_members WHERE trade_date < ?')
    .run(cutoffYmd)
  return result.changes
}
