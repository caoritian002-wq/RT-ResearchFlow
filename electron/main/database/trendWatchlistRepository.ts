import Database from 'better-sqlite3'
import type { TrendWatchlistRow } from './types'

// ──────────────────────────────────────────────────────────────────────────
// FR-164: trend_watchlist 表仓库
// PK 为复合键 (ts_code, sub_category)，同一股票可出现在多个细分赛道
// ──────────────────────────────────────────────────────────────────────────

/**
 * 新增或更新单条 (tsCode, subCategory) 记录
 */
export function upsertTrendWatchStock(
  db: Database.Database,
  row: TrendWatchlistRow
): void {
  db.prepare(`
    INSERT OR REPLACE INTO trend_watchlist
      (ts_code, stock_name, group_tag, added_at, category, sub_category, notes)
    VALUES
      (@tsCode, @stockName, @groupTag, @addedAt, @category, @subCategory, @notes)
  `).run(row)
}

/**
 * 批量添加股票到趋势池（INSERT OR IGNORE，不覆盖已有记录）
 */
export function batchAddTrendWatchStocks(
  db: Database.Database,
  stocks: Array<{
    tsCode: string
    stockName: string
    groupTag?: string
    category?: string
    subCategory?: string
    notes?: string
  }>
): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO trend_watchlist
      (ts_code, stock_name, group_tag, added_at, category, sub_category, notes)
    VALUES
      (@tsCode, @stockName, @groupTag, @addedAt, @category, @subCategory, @notes)
  `)
  const now = Date.now()
  const run = db.transaction(() => {
    for (const s of stocks) {
      stmt.run({
        tsCode: s.tsCode,
        stockName: s.stockName,
        groupTag: s.groupTag ?? '',
        addedAt: now,
        category: s.category ?? '',
        subCategory: s.subCategory ?? '',
        notes: s.notes ?? '',
      })
    }
  })
  run()
}

/**
 * 从趋势池移除股票
 * @param tsCode 股票代码
 * @param subCategory 若指定则只移除该赛道条目；否则移除该股票所有条目
 */
export function removeTrendWatchStock(
  db: Database.Database,
  tsCode: string,
  subCategory?: string
): void {
  if (subCategory !== undefined) {
    db.prepare('DELETE FROM trend_watchlist WHERE ts_code = ? AND sub_category = ?')
      .run(tsCode, subCategory)
  } else {
    db.prepare('DELETE FROM trend_watchlist WHERE ts_code = ?').run(tsCode)
  }
}

/**
 * 获取趋势池所有记录，按 category / sub_category / added_at 排序
 */
export function getAllTrendWatchStocks(db: Database.Database): TrendWatchlistRow[] {
  const rows = db
    .prepare(`
      SELECT ts_code, stock_name, group_tag, added_at, category, sub_category, notes
      FROM trend_watchlist
      ORDER BY category, sub_category, added_at DESC
    `)
    .all() as {
      ts_code: string
      stock_name: string
      group_tag: string
      added_at: number
      category: string
      sub_category: string
      notes: string
    }[]
  return rows.map((r) => ({
    tsCode: r.ts_code,
    stockName: r.stock_name,
    groupTag: r.group_tag,
    addedAt: r.added_at,
    category: r.category,
    subCategory: r.sub_category,
    notes: r.notes,
  }))
}

/**
 * 更新指定 (tsCode, subCategory) 条目的备注文本
 */
export function updateTrendWatchNotes(
  db: Database.Database,
  tsCode: string,
  subCategory: string,
  notes: string
): void {
  db.prepare('UPDATE trend_watchlist SET notes = ? WHERE ts_code = ? AND sub_category = ?')
    .run(notes, tsCode, subCategory)
}

/** 同一股票可能登记在多个赛道，分组标签按股票统一维护。 */
export function updateTrendWatchGroupTag(
  db: Database.Database,
  tsCode: string,
  groupTag: string
): number {
  return db.prepare('UPDATE trend_watchlist SET group_tag = ? WHERE ts_code = ?')
    .run(groupTag, tsCode).changes
}

/**
 * 查询单只股票是否在趋势池中（任意赛道）
 */
export function isTrendWatchStock(
  db: Database.Database,
  tsCode: string
): boolean {
  const row = db
    .prepare('SELECT 1 FROM trend_watchlist WHERE ts_code = ? LIMIT 1')
    .get(tsCode)
  return row != null
}

/**
 * 获取趋势池不重复股票数量（按 tsCode 去重）
 */
export function countTrendWatchStocks(db: Database.Database): number {
  const row = db
    .prepare('SELECT COUNT(DISTINCT ts_code) as cnt FROM trend_watchlist')
    .get() as { cnt: number }
  return row.cnt
}

