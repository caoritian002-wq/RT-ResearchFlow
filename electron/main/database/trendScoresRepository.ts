import Database from 'better-sqlite3'
import type { TrendScoreRow } from './types'

// ──────────────────────────────────────────────────────────────────────────
// FR-164: trend_scores 表仓库
// 存储每只趋势股的七维评分日存档
// ──────────────────────────────────────────────────────────────────────────

/**
 * 批量写入/更新评分记录（INSERT OR REPLACE）
 */
export function upsertTrendScores(
  db: Database.Database,
  rows: TrendScoreRow[]
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO trend_scores
      (ts_code, trade_date, ma_score, ma_above_60, alpha_score,
       drawdown, turnover_ratio, macd_above_zero, boll_above_mid,
       total_score, computed_at)
    VALUES
      (@tsCode, @tradeDate, @maScore, @maAbove60, @alphaScore,
       @drawdown, @turnoverRatio, @macdAboveZero, @bollAboveMid,
       @totalScore, @computedAt)
  `)
  const run = db.transaction((items: TrendScoreRow[]) => {
    for (const r of items) {
      stmt.run(r)
    }
  })
  run(rows)
}

/**
 * 查询指定股票最近一条评分记录
 */
export function getLatestTrendScore(
  db: Database.Database,
  tsCode: string
): TrendScoreRow | null {
  const row = db
    .prepare(`
      SELECT ts_code, trade_date, ma_score, ma_above_60, alpha_score,
             drawdown, turnover_ratio, macd_above_zero, boll_above_mid,
             total_score, computed_at
      FROM trend_scores
      WHERE ts_code = ?
      ORDER BY trade_date DESC
      LIMIT 1
    `)
    .get(tsCode) as {
      ts_code: string; trade_date: string; ma_score: number | null
      ma_above_60: number | null; alpha_score: number | null; drawdown: number | null
      turnover_ratio: number | null; macd_above_zero: number | null
      boll_above_mid: number | null; total_score: number | null; computed_at: number | null
    } | undefined
  if (!row) return null
  return mapScoreRow(row)
}

/**
 * 批量查询多只股票最新评分（各取最近一条）
 */
export function getLatestTrendScores(
  db: Database.Database,
  tsCodes: string[]
): Map<string, TrendScoreRow> {
  if (tsCodes.length === 0) return new Map()
  const placeholders = tsCodes.map(() => '?').join(',')
  const rows = db
    .prepare(`
      SELECT s.ts_code, s.trade_date, s.ma_score, s.ma_above_60, s.alpha_score,
             s.drawdown, s.turnover_ratio, s.macd_above_zero, s.boll_above_mid,
             s.total_score, s.computed_at
      FROM trend_scores s
      INNER JOIN (
        SELECT ts_code, MAX(trade_date) AS max_date
        FROM trend_scores
        WHERE ts_code IN (${placeholders})
        GROUP BY ts_code
      ) latest ON s.ts_code = latest.ts_code AND s.trade_date = latest.max_date
    `)
    .all(...tsCodes) as Array<{
      ts_code: string; trade_date: string; ma_score: number | null
      ma_above_60: number | null; alpha_score: number | null; drawdown: number | null
      turnover_ratio: number | null; macd_above_zero: number | null
      boll_above_mid: number | null; total_score: number | null; computed_at: number | null
    }>
  const map = new Map<string, TrendScoreRow>()
  for (const r of rows) {
    map.set(r.ts_code, mapScoreRow(r))
  }
  return map
}

/**
 * 删除超过 N 天的评分记录，返回删除行数
 */
export function cleanupTrendScores(
  db: Database.Database,
  keepDays: number
): number {
  const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000)
  const cutoffYmd =
    `${cutoff.getUTCFullYear()}` +
    `${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(cutoff.getUTCDate()).padStart(2, '0')}`
  const result = db
    .prepare('DELETE FROM trend_scores WHERE trade_date < ?')
    .run(cutoffYmd)
  return result.changes
}

// ──── 内部辅助 ────────────────────────────────────────────────────────────

function mapScoreRow(r: {
  ts_code: string; trade_date: string; ma_score: number | null
  ma_above_60: number | null; alpha_score: number | null; drawdown: number | null
  turnover_ratio: number | null; macd_above_zero: number | null
  boll_above_mid: number | null; total_score: number | null; computed_at: number | null
}): TrendScoreRow {
  return {
    tsCode: r.ts_code,
    tradeDate: r.trade_date,
    maScore: r.ma_score,
    maAbove60: r.ma_above_60,
    alphaScore: r.alpha_score,
    drawdown: r.drawdown,
    turnoverRatio: r.turnover_ratio,
    macdAboveZero: r.macd_above_zero,
    bollAboveMid: r.boll_above_mid,
    totalScore: r.total_score,
    computedAt: r.computed_at
  }
}
