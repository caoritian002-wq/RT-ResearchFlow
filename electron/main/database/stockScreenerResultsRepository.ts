/**
 * FR-151a: stock_screener_results 仓库
 *
 * 存储个性选股每日计算结果，持久化至 SQLite，支持 DB-first 查询。
 * 每日 18:00 统一盘后批次运行 runScreener 并写入当日结果，保留 30 天历史。
 */

import type Database from 'better-sqlite3'
import type { StockScreenerResultRow } from './types'

interface DbRow {
  ts_code: string
  trade_date: string
  stock_name: string | null
  close: number | null
  pct_chg: number | null
  turnover_rate: number | null
  vol: number | null
  amount: number | null
  signal_score: number
  conditions_met: string | null
  concepts: string | null
  rank_score?: number | null
  rank_breakdown_json?: string | null
  moneyflow_json?: string | null
  signal_strength_json?: string | null
}

function fromDbRow(r: DbRow): StockScreenerResultRow {
  return {
    tsCode: r.ts_code,
    tradeDate: r.trade_date,
    stockName: r.stock_name,
    close: r.close,
    pctChg: r.pct_chg,
    turnoverRate: r.turnover_rate,
    vol: r.vol,
    amount: r.amount,
    signalScore: r.signal_score,
    conditionsMet: r.conditions_met,
    concepts: r.concepts,
    rankScore: r.rank_score ?? r.signal_score,
    rankBreakdownJson: r.rank_breakdown_json ?? null,
    moneyflowJson: r.moneyflow_json ?? null,
    signalStrengthJson: r.signal_strength_json ?? null
  }
}

function toDbRow(r: StockScreenerResultRow): DbRow {
  return {
    ts_code: r.tsCode,
    trade_date: r.tradeDate,
    stock_name: r.stockName ?? null,
    close: r.close ?? null,
    pct_chg: r.pctChg ?? null,
    turnover_rate: r.turnoverRate ?? null,
    vol: r.vol ?? null,
    amount: r.amount ?? null,
    signal_score: r.signalScore,
    conditions_met: r.conditionsMet ?? null,
    concepts: r.concepts ?? null,
    rank_score: r.rankScore ?? r.signalScore,
    rank_breakdown_json: r.rankBreakdownJson ?? null,
    moneyflow_json: r.moneyflowJson ?? null,
    signal_strength_json: r.signalStrengthJson ?? null
  }
}

/**
 * 批量写入选股结果（INSERT OR REPLACE）
 */
export function upsertResults(db: Database.Database, rows: StockScreenerResultRow[]): void {
  if (rows.length === 0) return
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO stock_screener_results
       (ts_code, trade_date, stock_name, close, pct_chg, turnover_rate, vol, amount,
        signal_score, conditions_met, concepts, rank_score, rank_breakdown_json, moneyflow_json, signal_strength_json)
     VALUES
       (@ts_code, @trade_date, @stock_name, @close, @pct_chg, @turnover_rate, @vol, @amount,
        @signal_score, @conditions_met, @concepts, @rank_score, @rank_breakdown_json, @moneyflow_json, @signal_strength_json)`
  )
  const runAll = db.transaction((items: DbRow[]) => {
    for (const item of items) stmt.run(item)
  })
  runAll(rows.map(toDbRow))
}

/**
 * 按交易日查询选股结果，按 rank_score 降序排列
 */
export function getByDate(db: Database.Database, tradeDate: string): StockScreenerResultRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM stock_screener_results
       WHERE trade_date = ?
       ORDER BY COALESCE(rank_score, signal_score) DESC, pct_chg DESC`
    )
    .all(tradeDate) as DbRow[]
  return rows.map(fromDbRow)
}

/**
 * 删除指定交易日的选股结果（用于回补换手率后强制重算）
 */
export function deleteByDate(db: Database.Database, tradeDate: string): void {
  db.prepare('DELETE FROM stock_screener_results WHERE trade_date = ?').run(tradeDate)
}

/**
 * 清理超过 N 天的历史结果，返回删除行数
 */
export function cleanupScreenerResults(db: Database.Database, days = 30): number {
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const threshold = new Date(bjNow.getTime() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '')
  const info = db
    .prepare('DELETE FROM stock_screener_results WHERE trade_date < ?')
    .run(threshold)
  return info.changes
}
