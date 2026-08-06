/**
 * FR-151a: stock_basic_cache 仓库
 *
 * 存储全市场股票基础信息（来自 Tushare stock_basic 接口），由18:00协调器与启动补偿全量替换。
 * 用于个性选股（personalScreener）的预筛门槛：ST / 退市 / 科创板 / 行业过滤。
 */

import type Database from 'better-sqlite3'
import type { StockBasicCacheRow } from './types'

interface DbRow {
  ts_code: string
  name: string | null
  industry: string | null
  market: string | null
  list_status: string | null
  circ_float: number | null
  updated_at: number
}

export interface StockBasicCacheFreshness {
  count: number
  maxUpdatedAt: number | null
}

function fromDbRow(r: DbRow): StockBasicCacheRow {
  return {
    tsCode: r.ts_code,
    name: r.name,
    industry: r.industry,
    market: r.market,
    listStatus: r.list_status,
    circFloat: r.circ_float,
    updatedAt: r.updated_at
  }
}

function toDbRow(r: StockBasicCacheRow): DbRow {
  return {
    ts_code: r.tsCode,
    name: r.name ?? null,
    industry: r.industry ?? null,
    market: r.market ?? null,
    list_status: r.listStatus ?? null,
    circ_float: r.circFloat ?? null,
    updated_at: r.updatedAt
  }
}

/**
 * 批量写入（INSERT OR REPLACE），不清除旧数据
 */
export function upsertAll(db: Database.Database, rows: StockBasicCacheRow[]): void {
  if (rows.length === 0) return
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO stock_basic_cache
       (ts_code, name, industry, market, list_status, circ_float, updated_at)
     VALUES
       (@ts_code, @name, @industry, @market, @list_status, @circ_float, @updated_at)`
  )
  const runAll = db.transaction((items: DbRow[]) => {
    for (const item of items) stmt.run(item)
  })
  runAll(rows.map(toDbRow))
}

/**
 * 全量替换：先 DELETE 所有行，再 batch INSERT（事务保证原子性）
 */
export function clearAllAndInsert(db: Database.Database, rows: StockBasicCacheRow[]): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO stock_basic_cache
       (ts_code, name, industry, market, list_status, circ_float, updated_at)
     VALUES
       (@ts_code, @name, @industry, @market, @list_status, @circ_float, @updated_at)`
  )
  const runAll = db.transaction((items: DbRow[]) => {
    db.prepare('DELETE FROM stock_basic_cache').run()
    for (const item of items) stmt.run(item)
  })
  runAll(rows.map(toDbRow))
}

/**
 * 查询所有上市中（list_status = 'L'）的股票，用于选股候选集预筛
 */
export function queryAllActive(db: Database.Database): StockBasicCacheRow[] {
  const rows = db
    .prepare(`SELECT * FROM stock_basic_cache WHERE list_status = 'L' ORDER BY ts_code ASC`)
    .all() as DbRow[]
  return rows.map(fromDbRow)
}

/**
 * 按关键词模糊搜索股票（名称或代码），最多返回 20 条
 */
export function searchStockBasicByKeyword(
  db: Database.Database,
  keyword: string
): Array<{ tsCode: string; name: string }> {
  const kw = `%${keyword}%`
  const rows = db
    .prepare(
      `SELECT ts_code, name FROM stock_basic_cache
       WHERE list_status = 'L' AND (name LIKE ? OR ts_code LIKE ?)
       ORDER BY ts_code ASC LIMIT 20`
    )
    .all(kw, kw) as Array<{ ts_code: string; name: string | null }>
  return rows.map((r) => ({ tsCode: r.ts_code, name: r.name ?? r.ts_code }))
}

/**
 * 返回缓存中的总行数（用于判断 stock_basic 是否已初始化）
 */
export function countAll(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM stock_basic_cache').get() as { cnt: number }
  return row?.cnt ?? 0
}

export function getStockBasicCacheFreshness(db: Database.Database): StockBasicCacheFreshness {
  const row = db.prepare(`
    SELECT COUNT(*) AS count, MAX(updated_at) AS max_updated_at
    FROM stock_basic_cache
  `).get() as { count: number; max_updated_at: number | null }
  return {
    count: row.count,
    maxUpdatedAt: row.max_updated_at,
  }
}

export function isStockBasicCacheStale(
  db: Database.Database,
  expectedBeijingYmd: string,
): boolean {
  const freshness = getStockBasicCacheFreshness(db)
  if (freshness.count === 0 || freshness.maxUpdatedAt == null) return true
  const updatedBeijingYmd = new Date(freshness.maxUpdatedAt + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
    .replaceAll('-', '')
  return updatedBeijingYmd < expectedBeijingYmd
}

/**
 * 按名称或代码模糊搜索股票（用于搜索框下拉候选）
 * - keyword 同时匹配 name（股票名称）和 ts_code（如 600519.SH）
 * - 仅返回 list_status = 'L' 的上市中股票
 * - 结果按 ts_code 升序，最多返回 limit 条（默认 10）
 */
export function searchByNameOrCode(
  db: Database.Database,
  keyword: string,
  limit = 10
): Array<{ tsCode: string; name: string; market: string | null }> {
  const pattern = `%${keyword}%`
  const rows = db
    .prepare(
      `SELECT ts_code, name, market
       FROM stock_basic_cache
       WHERE list_status = 'L'
         AND (name LIKE ? OR ts_code LIKE ? OR REPLACE(ts_code, '.SH', '') LIKE ? OR REPLACE(ts_code, '.SZ', '') LIKE ? OR REPLACE(ts_code, '.BJ', '') LIKE ?)
       ORDER BY ts_code ASC
       LIMIT ?`
    )
    .all(pattern, pattern, pattern, pattern, pattern, limit) as Array<{
    ts_code: string
    name: string | null
    market: string | null
  }>
  return rows.map((r) => ({
    tsCode: r.ts_code,
    name: r.name ?? r.ts_code,
    market: r.market,
  }))
}

export function getStockBasicByTsCodes(
  db: Database.Database,
  tsCodes: string[],
): Map<string, StockBasicCacheRow> {
  const normalized = [...new Set(tsCodes.map((code) => code.trim().toUpperCase()).filter(Boolean))]
  if (normalized.length === 0) return new Map()
  const placeholders = normalized.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT * FROM stock_basic_cache WHERE ts_code IN (${placeholders})
  `).all(...normalized) as DbRow[]
  return new Map(rows.map((row) => [row.ts_code, fromDbRow(row)]))
}
