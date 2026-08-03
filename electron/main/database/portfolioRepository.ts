import type Database from 'better-sqlite3'
import type { PortfolioStockRow } from './types'

function portfolioCodeCandidates(tsCode: string): string[] {
  const clean = tsCode.trim().toUpperCase()
  const stripped = clean.replace(/\.(SH|SZ|BJ)$/i, '')
  return Array.from(new Set([clean, stripped]))
}

/**
 * 将股票加入持仓列表；若已存在则更新 stock_name（INSERT OR REPLACE 语义）.
 */
export function addPortfolioStock(
  db: Database.Database,
  tsCode: string,
  stockName: string
): void {
  const candidates = portfolioCodeCandidates(tsCode)
  const existing = db
    .prepare('SELECT cost_price FROM portfolio_stocks WHERE ts_code IN (?, ?) LIMIT 1')
    .get(candidates[0], candidates[1] ?? candidates[0]) as { cost_price: number | null } | undefined
  db.prepare(
    `INSERT OR REPLACE INTO portfolio_stocks (ts_code, stock_name, added_at, cost_price)
     VALUES (?, ?, ?, ?)`
  ).run(tsCode, stockName, Date.now(), existing?.cost_price ?? null)
}

/**
 * 从持仓列表移除指定股票.
 */
export function removePortfolioStock(db: Database.Database, tsCode: string): void {
  db.prepare('DELETE FROM portfolio_stocks WHERE ts_code = ?').run(tsCode)
}

/**
 * 返回所有持仓股票，按加入时间倒序.
 */
export function listPortfolioStocks(db: Database.Database): PortfolioStockRow[] {
  const rows = db
    .prepare('SELECT ts_code, stock_name, added_at, cost_price FROM portfolio_stocks ORDER BY added_at DESC')
    .all() as { ts_code: string; stock_name: string; added_at: number; cost_price: number | null }[]
  return rows.map((r) => ({
    tsCode: r.ts_code,
    stockName: r.stock_name,
    addedAt: r.added_at,
    costPrice: r.cost_price,
  }))
}

/**
 * 更新用户手填持仓成本价；costPrice 为 null 表示清空成本价.
 */
export function updatePortfolioCostPrice(
  db: Database.Database,
  tsCode: string,
  costPrice: number | null
): boolean {
  const stmt = db.prepare('UPDATE portfolio_stocks SET cost_price = ? WHERE ts_code = ?')
  for (const candidate of portfolioCodeCandidates(tsCode)) {
    const result = stmt.run(costPrice, candidate)
    if (result.changes > 0) return true
  }
  return false
}

/**
 * 检查指定股票是否已在持仓列表中.
 */
export function isPortfolioStock(db: Database.Database, tsCode: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM portfolio_stocks WHERE ts_code = ?')
    .get(tsCode)
  return !!row
}
