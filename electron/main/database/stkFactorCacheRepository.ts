import type Database from 'better-sqlite3'
import type { StkFactorRow } from '../services/tushareService'

// ── FR-143 技术因子缓存仓库 ─────────────────────────────────────────

/** 写入单条技术因子记录（INSERT OR REPLACE） */
export function upsertFactor(db: Database.Database, row: StkFactorRow): void {
  db.prepare(`
    INSERT OR REPLACE INTO stk_factor_cache (
      ts_code, trade_date, close,
      macd_bfq, macd_dif_bfq, macd_dea_bfq,
      kdj_k_bfq, kdj_d_bfq, kdj_bfq,
      rsi_bfq_6, rsi_bfq_12,
      boll_upper_bfq, boll_mid_bfq, boll_lower_bfq,
      ma_bfq_5, ma_bfq_10, ma_bfq_20, ma_bfq_60,
      turnover_rate, volume_ratio, updays, downdays
    ) VALUES (
      @tsCode, @tradeDate, @close,
      @macdBfq, @macdDifBfq, @macdDeaBfq,
      @kdjKBfq, @kdjDBfq, @kdjBfq,
      @rsiBfq6, @rsiBfq12,
      @bollUpperBfq, @bollMidBfq, @bollLowerBfq,
      @maBfq5, @maBfq10, @maBfq20, @maBfq60,
      @turnoverRate, @volumeRatio, @updays, @downdays
    )
  `).run(row)
}

/** 查询指定股票、指定交易日的技术因子，返回单条或 null */
export function queryFactor(
  db: Database.Database,
  tsCode: string,
  tradeDate: string
): StkFactorRow | null {
  const row = db
    .prepare(
      `SELECT ts_code, trade_date, close,
              macd_bfq, macd_dif_bfq, macd_dea_bfq,
              kdj_k_bfq, kdj_d_bfq, kdj_bfq,
              rsi_bfq_6, rsi_bfq_12,
              boll_upper_bfq, boll_mid_bfq, boll_lower_bfq,
              ma_bfq_5, ma_bfq_10, ma_bfq_20, ma_bfq_60,
              turnover_rate, volume_ratio, updays, downdays
       FROM stk_factor_cache
       WHERE ts_code = ? AND trade_date = ?`
    )
    .get(tsCode, tradeDate) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    tsCode: row['ts_code'] as string,
    tradeDate: row['trade_date'] as string,
    close: (row['close'] as number | null) ?? null,
    macdBfq: (row['macd_bfq'] as number | null) ?? null,
    macdDifBfq: (row['macd_dif_bfq'] as number | null) ?? null,
    macdDeaBfq: (row['macd_dea_bfq'] as number | null) ?? null,
    kdjKBfq: (row['kdj_k_bfq'] as number | null) ?? null,
    kdjDBfq: (row['kdj_d_bfq'] as number | null) ?? null,
    kdjBfq: (row['kdj_bfq'] as number | null) ?? null,
    rsiBfq6: (row['rsi_bfq_6'] as number | null) ?? null,
    rsiBfq12: (row['rsi_bfq_12'] as number | null) ?? null,
    bollUpperBfq: (row['boll_upper_bfq'] as number | null) ?? null,
    bollMidBfq: (row['boll_mid_bfq'] as number | null) ?? null,
    bollLowerBfq: (row['boll_lower_bfq'] as number | null) ?? null,
    maBfq5: (row['ma_bfq_5'] as number | null) ?? null,
    maBfq10: (row['ma_bfq_10'] as number | null) ?? null,
    maBfq20: (row['ma_bfq_20'] as number | null) ?? null,
    maBfq60: (row['ma_bfq_60'] as number | null) ?? null,
    turnoverRate: (row['turnover_rate'] as number | null) ?? null,
    volumeRatio: (row['volume_ratio'] as number | null) ?? null,
    updays: (row['updays'] as number | null) ?? null,
    downdays: (row['downdays'] as number | null) ?? null,
  }
}

/** 查询该股票 DB 中最新一期技术因子（按 trade_date 降序取最新），盘中兜底用 */
export function queryLatestFactor(db: Database.Database, tsCode: string): StkFactorRow | null {
  const row = db
    .prepare(
      `SELECT ts_code, trade_date, close,
              macd_bfq, macd_dif_bfq, macd_dea_bfq,
              kdj_k_bfq, kdj_d_bfq, kdj_bfq,
              rsi_bfq_6, rsi_bfq_12,
              boll_upper_bfq, boll_mid_bfq, boll_lower_bfq,
              ma_bfq_5, ma_bfq_10, ma_bfq_20, ma_bfq_60,
              turnover_rate, volume_ratio, updays, downdays
       FROM stk_factor_cache
       WHERE ts_code = ? ORDER BY trade_date DESC LIMIT 1`
    )
    .get(tsCode) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    tsCode: row['ts_code'] as string,
    tradeDate: row['trade_date'] as string,
    close: (row['close'] as number | null) ?? null,
    macdBfq: (row['macd_bfq'] as number | null) ?? null,
    macdDifBfq: (row['macd_dif_bfq'] as number | null) ?? null,
    macdDeaBfq: (row['macd_dea_bfq'] as number | null) ?? null,
    kdjKBfq: (row['kdj_k_bfq'] as number | null) ?? null,
    kdjDBfq: (row['kdj_d_bfq'] as number | null) ?? null,
    kdjBfq: (row['kdj_bfq'] as number | null) ?? null,
    rsiBfq6: (row['rsi_bfq_6'] as number | null) ?? null,
    rsiBfq12: (row['rsi_bfq_12'] as number | null) ?? null,
    bollUpperBfq: (row['boll_upper_bfq'] as number | null) ?? null,
    bollMidBfq: (row['boll_mid_bfq'] as number | null) ?? null,
    bollLowerBfq: (row['boll_lower_bfq'] as number | null) ?? null,
    maBfq5: (row['ma_bfq_5'] as number | null) ?? null,
    maBfq10: (row['ma_bfq_10'] as number | null) ?? null,
    maBfq20: (row['ma_bfq_20'] as number | null) ?? null,
    maBfq60: (row['ma_bfq_60'] as number | null) ?? null,
    turnoverRate: (row['turnover_rate'] as number | null) ?? null,
    volumeRatio: (row['volume_ratio'] as number | null) ?? null,
    updays: (row['updays'] as number | null) ?? null,
    downdays: (row['downdays'] as number | null) ?? null,
  }
}

/** 清理超过指定天数的旧数据，返回删除行数 */
export function cleanupFactorCache(db: Database.Database, daysToKeep = 30): number {
  const thresholdMs = Date.now() - daysToKeep * 24 * 60 * 60 * 1000
  const bjDate = new Date(thresholdMs + 8 * 3600 * 1000)
  const threshold = bjDate.toISOString().slice(0, 10).replace(/-/g, '')
  const result = db
    .prepare(`DELETE FROM stk_factor_cache WHERE trade_date < ?`)
    .run(threshold)
  return result.changes
}

/** 查询指定股票从 startDate（含）起的多期技术因子，按 trade_date 升序返回 */
export function queryFactorHistory(
  db: Database.Database,
  tsCode: string,
  startDate: string   // YYYYMMDD
): StkFactorRow[] {
  const rows = db
    .prepare(
      `SELECT ts_code, trade_date, close,
              macd_bfq, macd_dif_bfq, macd_dea_bfq,
              kdj_k_bfq, kdj_d_bfq, kdj_bfq,
              rsi_bfq_6, rsi_bfq_12,
              boll_upper_bfq, boll_mid_bfq, boll_lower_bfq,
              ma_bfq_5, ma_bfq_10, ma_bfq_20, ma_bfq_60,
              turnover_rate, volume_ratio, updays, downdays
       FROM stk_factor_cache
       WHERE ts_code = ? AND trade_date >= ?
       ORDER BY trade_date ASC`
    )
    .all(tsCode, startDate) as Record<string, unknown>[]
  return rows.map((row) => ({
    tsCode: row['ts_code'] as string,
    tradeDate: row['trade_date'] as string,
    close: (row['close'] as number | null) ?? null,
    macdBfq: (row['macd_bfq'] as number | null) ?? null,
    macdDifBfq: (row['macd_dif_bfq'] as number | null) ?? null,
    macdDeaBfq: (row['macd_dea_bfq'] as number | null) ?? null,
    kdjKBfq: (row['kdj_k_bfq'] as number | null) ?? null,
    kdjDBfq: (row['kdj_d_bfq'] as number | null) ?? null,
    kdjBfq: (row['kdj_bfq'] as number | null) ?? null,
    rsiBfq6: (row['rsi_bfq_6'] as number | null) ?? null,
    rsiBfq12: (row['rsi_bfq_12'] as number | null) ?? null,
    bollUpperBfq: (row['boll_upper_bfq'] as number | null) ?? null,
    bollMidBfq: (row['boll_mid_bfq'] as number | null) ?? null,
    bollLowerBfq: (row['boll_lower_bfq'] as number | null) ?? null,
    maBfq5: (row['ma_bfq_5'] as number | null) ?? null,
    maBfq10: (row['ma_bfq_10'] as number | null) ?? null,
    maBfq20: (row['ma_bfq_20'] as number | null) ?? null,
    maBfq60: (row['ma_bfq_60'] as number | null) ?? null,
    turnoverRate: (row['turnover_rate'] as number | null) ?? null,
    volumeRatio: (row['volume_ratio'] as number | null) ?? null,
    updays: (row['updays'] as number | null) ?? null,
    downdays: (row['downdays'] as number | null) ?? null,
  }))
}

/** 批量写入技术因子历史记录（事务包裹，提升性能） */
export function upsertFactorBatch(db: Database.Database, rows: StkFactorRow[]): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO stk_factor_cache (
      ts_code, trade_date, close,
      macd_bfq, macd_dif_bfq, macd_dea_bfq,
      kdj_k_bfq, kdj_d_bfq, kdj_bfq,
      rsi_bfq_6, rsi_bfq_12,
      boll_upper_bfq, boll_mid_bfq, boll_lower_bfq,
      ma_bfq_5, ma_bfq_10, ma_bfq_20, ma_bfq_60,
      turnover_rate, volume_ratio, updays, downdays
    ) VALUES (
      @tsCode, @tradeDate, @close,
      @macdBfq, @macdDifBfq, @macdDeaBfq,
      @kdjKBfq, @kdjDBfq, @kdjBfq,
      @rsiBfq6, @rsiBfq12,
      @bollUpperBfq, @bollMidBfq, @bollLowerBfq,
      @maBfq5, @maBfq10, @maBfq20, @maBfq60,
      @turnoverRate, @volumeRatio, @updays, @downdays
    )
  `)
  const run = db.transaction((items: StkFactorRow[]) => {
    for (const r of items) stmt.run(r)
  })
  run(rows)
}
