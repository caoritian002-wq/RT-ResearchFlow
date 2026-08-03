import Database from 'better-sqlite3'
import type { TrendAlertRow } from './types'

// ──────────────────────────────────────────────────────────────────────────
// FR-164: trend_alerts 表仓库
// 存储趋势预警记录，支持去重检测和历史查询
// ──────────────────────────────────────────────────────────────────────────

/**
 * 插入一条预警记录，返回新记录的 id
 */
export function insertTrendAlert(
  db: Database.Database,
  row: Omit<TrendAlertRow, 'id'>
): number {
  const result = db
    .prepare(`
      INSERT INTO trend_alerts
        (ts_code, stock_name, alert_type, alert_date, price, ref_price, created_at)
      VALUES
        (@tsCode, @stockName, @alertType, @alertDate, @price, @refPrice, @createdAt)
    `)
    .run(row)
  return result.lastInsertRowid as number
}

/**
 * 检查指定股票在指定日期的指定预警类型是否已存在，用于去重
 */
export function hasAlertToday(
  db: Database.Database,
  tsCode: string,
  alertType: string,
  alertDate: string
): boolean {
  const row = db
    .prepare(`
      SELECT 1 FROM trend_alerts
      WHERE ts_code = ? AND alert_type = ? AND alert_date = ?
      LIMIT 1
    `)
    .get(tsCode, alertType, alertDate)
  return row != null
}

/**
 * 查询最近 N 天的预警记录，倒序排列
 */
export function getRecentTrendAlerts(
  db: Database.Database,
  days: number
): TrendAlertRow[] {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const cutoffYmd =
    `${cutoff.getUTCFullYear()}` +
    `${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(cutoff.getUTCDate()).padStart(2, '0')}`
  const rows = db
    .prepare(`
      SELECT id, ts_code, stock_name, alert_type, alert_date, price, ref_price, created_at
      FROM trend_alerts
      WHERE alert_date >= ?
      ORDER BY created_at DESC
    `)
    .all(cutoffYmd) as Array<{
      id: number; ts_code: string; stock_name: string; alert_type: string
      alert_date: string; price: number | null; ref_price: number | null; created_at: number
    }>
  return rows.map(mapAlertRow)
}

/**
 * 删除超过 N 天的预警记录，返回删除行数
 */
export function cleanupTrendAlerts(
  db: Database.Database,
  keepDays: number
): number {
  const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000)
  const cutoffYmd =
    `${cutoff.getUTCFullYear()}` +
    `${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(cutoff.getUTCDate()).padStart(2, '0')}`
  const result = db
    .prepare('DELETE FROM trend_alerts WHERE alert_date < ?')
    .run(cutoffYmd)
  return result.changes
}

// ──── 内部辅助 ────────────────────────────────────────────────────────────

function mapAlertRow(r: {
  id: number; ts_code: string; stock_name: string; alert_type: string
  alert_date: string; price: number | null; ref_price: number | null; created_at: number
}): TrendAlertRow {
  return {
    id: r.id,
    tsCode: r.ts_code,
    stockName: r.stock_name,
    alertType: r.alert_type,
    alertDate: r.alert_date,
    price: r.price,
    refPrice: r.ref_price,
    createdAt: r.created_at
  }
}
