import type Database from 'better-sqlite3'
import type { ChipMonitorStockRow, ChipMonitorResultRow } from './types'

// ── FR-156 筹码监控仓库 ──────────────────────────────────────────────

type ChipMonitorSource = ChipMonitorStockRow['source']

/** 插入或更新单条监控股记录 */
export function upsertMonitorStock(db: Database.Database, row: ChipMonitorStockRow): void {
  const normalized = {
    ...row,
    tsCode: normalizeStockCode(row.tsCode),
    stockName: row.stockName?.trim() || null,
  }
  db.prepare(`
    INSERT OR REPLACE INTO chip_monitor_stocks (ts_code, source, stock_name, added_at)
    VALUES (@tsCode, @source, @stockName, @addedAt)
  `).run(normalized)
}

/** 返回全部监控股池记录 */
export function getMonitorStocks(db: Database.Database): ChipMonitorStockRow[] {
  const rows = db
    .prepare(`
      SELECT c.ts_code, c.source,
             COALESCE(NULLIF(c.stock_name, ''), si.stockName) AS stock_name,
             c.added_at
      FROM chip_monitor_stocks c
      LEFT JOIN stock_info si ON si.stockCode = replace(replace(replace(c.ts_code, '.SH', ''), '.SZ', ''), '.BJ', '')
      ORDER BY c.added_at ASC
    `)
    .all() as { ts_code: string; source: string; stock_name: string | null; added_at: number }[]
  return rows.map((r) => ({
    tsCode: r.ts_code,
    source: r.source as ChipMonitorSource,
    stockName: r.stock_name,
    addedAt: r.added_at,
  }))
}

/**
 * 全量替换指定来源的股池（事务）：
 * 先删除 source=? 的全部记录，再批量插入新记录
 */
export function replaceMonitorStocksBySource(
  db: Database.Database,
  source: ChipMonitorSource,
  rows: ChipMonitorStockRow[]
): void {
  const deleteStmt = db.prepare(`DELETE FROM chip_monitor_stocks WHERE source = ?`)
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO chip_monitor_stocks (ts_code, source, stock_name, added_at)
    VALUES (@tsCode, @source, @stockName, @addedAt)
  `)
  const deduped = dedupeMonitorRows(rows, source)
  const run = db.transaction(() => {
    deleteStmt.run(source)
    for (const row of deduped) insertStmt.run(row)
  })
  run()
}

/** 批量写入计算结果（INSERT OR REPLACE，事务） */
export function upsertMonitorResults(db: Database.Database, rows: ChipMonitorResultRow[]): void {
  if (rows.length === 0) return
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO chip_monitor_results
      (ts_code, trade_date, mode, bottom_pct, bottom_avg_cost,
       loosening_1d, loosening_3d, loosening_5d,
       loosening_1d_reason, loosening_3d_reason, loosening_5d_reason,
       updated_at)
    VALUES
      (@tsCode, @tradeDate, @mode, @bottomPct, @bottomAvgCost,
       @loosening1d, @loosening3d, @loosening5d,
       @loosening1dReason, @loosening3dReason, @loosening5dReason,
       @updatedAt)
  `)
  const runAll = db.transaction((items: ChipMonitorResultRow[]) => {
    for (const row of items) stmt.run({
      ...row,
      mode: row.mode ?? 'relative',
      loosening1dReason: row.loosening1dReason ?? null,
      loosening3dReason: row.loosening3dReason ?? null,
      loosening5dReason: row.loosening5dReason ?? null,
    })
  })
  runAll(rows)
}

/**
 * 以监控股池为主表返回每只股票一行，并 LEFT JOIN 当前模式最新结果。
 * 这样切换相对/绝对低位只影响指标口径，不影响列表里的股票数量。
 */
export function getLatestMonitorResults(
  db: Database.Database,
  mode: 'relative' | 'absolute' = 'relative'
): ChipMonitorResultRow[] {
  const rows = db
    .prepare(`
      WITH stock_ranked AS (
        SELECT c.ts_code,
               c.source,
               c.stock_name,
               c.added_at,
               replace(replace(replace(c.ts_code, '.SH', ''), '.SZ', ''), '.BJ', '') AS code6,
               CASE c.source
                 WHEN 'portfolio' THEN 1
                 WHEN 'morningAuction' THEN 2
                 WHEN 'screener' THEN 3
                 ELSE 4
               END AS source_priority,
               ROW_NUMBER() OVER (
                 PARTITION BY replace(replace(replace(c.ts_code, '.SH', ''), '.SZ', ''), '.BJ', '')
                 ORDER BY
                   CASE c.source
                     WHEN 'portfolio' THEN 1
                     WHEN 'morningAuction' THEN 2
                     WHEN 'screener' THEN 3
                     ELSE 4
                   END ASC,
                   c.added_at DESC
               ) AS rn
        FROM chip_monitor_stocks c
      ), stock_one AS (
        SELECT * FROM stock_ranked WHERE rn = 1
      ), result_ranked AS (
        SELECT r.*,
               replace(replace(replace(r.ts_code, '.SH', ''), '.SZ', ''), '.BJ', '') AS code6,
               ROW_NUMBER() OVER (
                 PARTITION BY replace(replace(replace(r.ts_code, '.SH', ''), '.SZ', ''), '.BJ', '')
                 ORDER BY r.trade_date DESC,
                   CASE
                     WHEN r.ts_code LIKE '%.SH' OR r.ts_code LIKE '%.SZ' OR r.ts_code LIKE '%.BJ' THEN 1
                     ELSE 2
                   END ASC,
                   r.updated_at DESC
               ) AS rn
        FROM chip_monitor_results r
        WHERE COALESCE(r.mode, 'relative') = ?
      ), latest AS (
        SELECT * FROM result_ranked WHERE rn = 1
      )
      SELECT COALESCE(r.ts_code, c.ts_code) AS ts_code,
             c.source AS source,
             COALESCE(NULLIF(c.stock_name, ''), si.stockName) AS stock_name,
             r.trade_date, COALESCE(r.mode, 'relative') AS mode,
             r.bottom_pct, r.bottom_avg_cost,
             r.loosening_1d, r.loosening_3d, r.loosening_5d,
             r.loosening_1d_reason, r.loosening_3d_reason, r.loosening_5d_reason,
             r.updated_at,
             d.pct_chg, d.turnover_rate, d.close AS current_price
      FROM stock_one c
      LEFT JOIN latest r
        ON r.code6 = c.code6
      LEFT JOIN stock_info si
        ON si.stockCode = c.code6
      LEFT JOIN daily_close_cache d ON d.ts_code = r.ts_code AND d.trade_date = r.trade_date
      ORDER BY c.source_priority ASC, c.added_at DESC, c.ts_code ASC
    `)
    .all(mode) as {
      ts_code: string; source: string | null; stock_name: string | null
      trade_date: string | null; mode: string | null; bottom_pct: number | null
      bottom_avg_cost: number | null; loosening_1d: number | null
      loosening_3d: number | null; loosening_5d: number | null; updated_at: number | null
      loosening_1d_reason: string | null; loosening_3d_reason: string | null; loosening_5d_reason: string | null
      pct_chg: number | null; turnover_rate: number | null; current_price: number | null
    }[]
  return rows.map(mapResultRow)
}

/** 按请求股票代码批量返回当前模式的最新兼容结果，不依赖监控股池。 */
export function getLatestMonitorResultsByTsCodes(
  db: Database.Database,
  tsCodes: string[],
  mode: 'relative' | 'absolute' = 'relative',
  tradeDate?: string,
): ChipMonitorResultRow[] {
  if (tsCodes.length === 0) return []
  const aliases = [...new Set(tsCodes.flatMap((tsCode) => {
    const clean = tsCode.trim().toUpperCase()
    const code6 = normalizeStockCode(clean)
    const normalized = normalizeStockTsCode(code6)
    return [clean, code6, normalized]
  }).filter(Boolean))]
  if (aliases.length === 0) return []
  const placeholders = aliases.map(() => '?').join(', ')
  const tradeDateClause = tradeDate ? 'AND r.trade_date = ?' : ''
  const params = tradeDate ? [mode, tradeDate, ...aliases] : [mode, ...aliases]
  const rows = db.prepare(`
    WITH result_ranked AS (
      SELECT r.*,
             replace(replace(replace(r.ts_code, '.SH', ''), '.SZ', ''), '.BJ', '') AS code6,
             ROW_NUMBER() OVER (
               PARTITION BY replace(replace(replace(r.ts_code, '.SH', ''), '.SZ', ''), '.BJ', '')
               ORDER BY r.trade_date DESC,
                 CASE
                   WHEN r.ts_code LIKE '%.SH' OR r.ts_code LIKE '%.SZ' OR r.ts_code LIKE '%.BJ' THEN 1
                   ELSE 2
                 END ASC,
                 r.updated_at DESC
             ) AS rn
      FROM chip_monitor_results r
      WHERE COALESCE(r.mode, 'relative') = ?
        ${tradeDateClause}
        AND r.ts_code IN (${placeholders})
    ), latest AS (
      SELECT * FROM result_ranked WHERE rn = 1
    ), daily_ranked AS (
      SELECT r.code6,
             r.trade_date AS result_trade_date,
             d.pct_chg,
             d.turnover_rate,
             d.close,
             ROW_NUMBER() OVER (
               PARTITION BY r.code6, r.trade_date
               ORDER BY CASE
                 WHEN d.ts_code = r.ts_code THEN 1
                 WHEN d.ts_code LIKE '%.SH' OR d.ts_code LIKE '%.SZ' OR d.ts_code LIKE '%.BJ' THEN 2
                 ELSE 3
               END
             ) AS rn
      FROM latest r
      LEFT JOIN daily_close_cache d
        ON d.trade_date = r.trade_date
       AND replace(replace(replace(d.ts_code, '.SH', ''), '.SZ', ''), '.BJ', '') = r.code6
    )
    SELECT r.ts_code,
           NULL AS source,
           si.stockName AS stock_name,
           r.trade_date,
           COALESCE(r.mode, 'relative') AS mode,
           r.bottom_pct,
           r.bottom_avg_cost,
           r.loosening_1d,
           r.loosening_3d,
           r.loosening_5d,
           r.loosening_1d_reason,
           r.loosening_3d_reason,
           r.loosening_5d_reason,
           r.updated_at,
           d.pct_chg,
           d.turnover_rate,
           d.close AS current_price
    FROM latest r
    LEFT JOIN stock_info si ON si.stockCode = r.code6
    LEFT JOIN daily_ranked d
      ON d.code6 = r.code6
     AND d.result_trade_date = r.trade_date
     AND d.rn = 1
    ORDER BY r.code6 ASC
  `).all(...params) as Array<{
    ts_code: string; source: string | null; stock_name: string | null
    trade_date: string; mode: string | null; bottom_pct: number | null
    bottom_avg_cost: number | null; loosening_1d: number | null
    loosening_3d: number | null; loosening_5d: number | null; updated_at: number
    loosening_1d_reason: string | null; loosening_3d_reason: string | null; loosening_5d_reason: string | null
    pct_chg: number | null; turnover_rate: number | null; current_price: number | null
  }>
  return rows.map(mapResultRow)
}

/** 返回指定股票近 5 条结果（按 trade_date 升序） */
export function getMonitorResultsForStock(
  db: Database.Database,
  tsCode: string
): ChipMonitorResultRow[] {
  const rows = db
    .prepare(`
      SELECT ts_code, trade_date, bottom_pct, bottom_avg_cost,
            COALESCE(mode, 'relative') AS mode,
            loosening_1d, loosening_3d, loosening_5d,
            loosening_1d_reason, loosening_3d_reason, loosening_5d_reason,
            updated_at
      FROM chip_monitor_results
      WHERE ts_code = ?
      ORDER BY trade_date DESC
      LIMIT 5
    `)
    .all(tsCode) as {
      ts_code: string; trade_date: string; mode: string | null; bottom_pct: number | null
      bottom_avg_cost: number | null; loosening_1d: number | null
      loosening_3d: number | null; loosening_5d: number | null; updated_at: number
      loosening_1d_reason: string | null; loosening_3d_reason: string | null; loosening_5d_reason: string | null
    }[]
  // 转为升序返回
  return rows.reverse().map(mapResultRow)
}

/** 删除超过 daysToKeep 天的历史结果，返回删除行数 */
export function cleanupMonitorResults(db: Database.Database, daysToKeep: number): number {
  const thresholdMs = Date.now() - daysToKeep * 24 * 60 * 60 * 1000
  const bjDate = new Date(thresholdMs + 8 * 3600 * 1000)
  const threshold = bjDate.toISOString().slice(0, 10).replace(/-/g, '')
  const result = db
    .prepare(`DELETE FROM chip_monitor_results WHERE trade_date < ?`)
    .run(threshold)
  return result.changes
}

// ── 内部辅助 ────────────────────────────────────────────────────────

function mapResultRow(r: {
  ts_code: string; source?: string | null; stock_name?: string | null
  trade_date: string | null; mode?: string | null; bottom_pct: number | null
  bottom_avg_cost: number | null; loosening_1d: number | null
  loosening_3d: number | null; loosening_5d: number | null; updated_at: number | null
  loosening_1d_reason?: string | null; loosening_3d_reason?: string | null; loosening_5d_reason?: string | null
  pct_chg?: number | null; turnover_rate?: number | null; current_price?: number | null
}): ChipMonitorResultRow {
  return {
    tsCode: r.ts_code,
    source: r.source as ChipMonitorResultRow['source'] ?? null,
    stockName: r.stock_name ?? null,
    tradeDate: r.trade_date ?? '',
    mode: r.mode === 'absolute' ? 'absolute' : 'relative',
    bottomPct: r.bottom_pct,
    bottomAvgCost: r.bottom_avg_cost,
    loosening1d: r.loosening_1d,
    loosening3d: r.loosening_3d,
    loosening5d: r.loosening_5d,
    loosening1dReason: mapMissingReason(r.loosening_1d_reason),
    loosening3dReason: mapMissingReason(r.loosening_3d_reason),
    loosening5dReason: mapMissingReason(r.loosening_5d_reason),
    updatedAt: r.updated_at ?? 0,
    pctChg: r.pct_chg ?? null,
    turnoverRate: r.turnover_rate ?? null,
    currentPrice: r.current_price ?? null,
  }
}

function mapMissingReason(reason?: string | null): ChipMonitorResultRow['loosening1dReason'] {
  return reason === 'INSUFFICIENT_HISTORY' || reason === 'LOW_BASE_PCT' ? reason : null
}

function normalizeStockCode(tsCode: string): string {
  return tsCode.trim().toUpperCase().replace(/\.(SH|SZ|BJ)$/i, '')
}

function normalizeStockTsCode(code: string): string {
  if (!/^\d{6}$/.test(code)) return code
  if (/^(4|8|920)/.test(code)) return `${code}.BJ`
  if (/^(5|6|9)/.test(code)) return `${code}.SH`
  return `${code}.SZ`
}

function dedupeMonitorRows(rows: ChipMonitorStockRow[], source: ChipMonitorSource): ChipMonitorStockRow[] {
  const byCode = new Map<string, ChipMonitorStockRow>()
  for (const row of rows) {
    const code = normalizeStockCode(row.tsCode)
    if (!code) continue
    byCode.set(code, {
      ...row,
      tsCode: code,
      source,
      stockName: row.stockName?.trim() || null,
    })
  }
  return Array.from(byCode.values())
}
