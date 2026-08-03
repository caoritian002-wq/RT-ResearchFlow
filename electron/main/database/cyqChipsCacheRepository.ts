import type Database from 'better-sqlite3'
import type { CyqChipsRow } from '../services/tushareService'

// ── FR-142 筹码分布缓存仓库 ─────────────────────────────────────────

/** 批量写入筹码数据（INSERT OR REPLACE，事务包裹） */
export function upsertChips(db: Database.Database, rows: CyqChipsRow[]): void {
  if (rows.length === 0) return
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO cyq_chips_cache (ts_code, trade_date, price, percent)
    VALUES (@tsCode, @tradeDate, @price, @percent)
  `)
  const runAll = db.transaction((items: CyqChipsRow[]) => {
    for (const row of items) stmt.run(row)
  })
  runAll(rows)
}

/** 查询指定股票、指定交易日的筹码分布，按价格升序返回 */
export function queryChips(
  db: Database.Database,
  tsCode: string,
  tradeDate: string
): { price: number; percent: number }[] {
  const rows = db
    .prepare(
      `SELECT price, percent FROM cyq_chips_cache
       WHERE ts_code = ? AND trade_date = ?
       ORDER BY price ASC`
    )
    .all(tsCode, tradeDate) as { price: number; percent: number }[]
  return rows
}

/** 查询该股票 DB 中最新一期筹码数据（按 trade_date 降序取最新），盘中兜底用 */
export function queryLatestChips(
  db: Database.Database,
  tsCode: string
): { tradeDate: string; chips: { price: number; percent: number }[] } | null {
  const dateRow = db
    .prepare(
      `SELECT trade_date FROM cyq_chips_cache WHERE ts_code = ? ORDER BY trade_date DESC LIMIT 1`
    )
    .get(tsCode) as { trade_date: string } | undefined
  if (!dateRow) return null
  const chips = db
    .prepare(
      `SELECT price, percent FROM cyq_chips_cache
       WHERE ts_code = ? AND trade_date = ?
       ORDER BY price ASC`
    )
    .all(tsCode, dateRow.trade_date) as { price: number; percent: number }[]
  return { tradeDate: dateRow.trade_date, chips }
}

/** 查询该股票已有筹码数据的最近交易日，按日期升序返回。 */
export function listChipTradeDates(
  db: Database.Database,
  tsCode: string,
  limit: number,
): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT trade_date
    FROM cyq_chips_cache
    WHERE ts_code = ?
    ORDER BY trade_date DESC
    LIMIT ?
  `).all(tsCode, limit) as { trade_date: string }[]
  return rows.map((row) => row.trade_date).reverse()
}

export type ChipHistoryByDate = Map<string, { price: number; percent: number }[]>

/**
 * 批量查询多只股票最近若干个筹码交易日的价格级分布。
 * 查询范围由股票集合和日期窗口共同限定，不随全表历史长度增长。
 */
export function queryChipHistories(
  db: Database.Database,
  tsCodes: string[],
  limitDates = 30,
  tradeDate?: string,
): Map<string, ChipHistoryByDate> {
  const result = new Map<string, ChipHistoryByDate>()
  if (tsCodes.length === 0) return result

  const aliases = [...new Set(tsCodes.flatMap((tsCode) => [tsCode, tsCode.split('.')[0]]))]
  const placeholders = aliases.map(() => '?').join(', ')
  const rows = (tradeDate
    ? db.prepare(`
        SELECT ts_code, trade_date, price, percent
        FROM cyq_chips_cache
        WHERE ts_code IN (${placeholders}) AND trade_date = ?
        ORDER BY ts_code ASC, price ASC
      `).all(...aliases, tradeDate)
    : db.prepare(`
        WITH distinct_dates AS (
          SELECT DISTINCT ts_code, trade_date
          FROM cyq_chips_cache
          WHERE ts_code IN (${placeholders})
        ), ranked_dates AS (
          SELECT ts_code, trade_date,
                 ROW_NUMBER() OVER (PARTITION BY ts_code ORDER BY trade_date DESC) AS date_rank
          FROM distinct_dates
        )
        SELECT chips.ts_code, chips.trade_date, chips.price, chips.percent
        FROM cyq_chips_cache chips
        JOIN ranked_dates dates
          ON dates.ts_code = chips.ts_code AND dates.trade_date = chips.trade_date
        WHERE dates.date_rank <= ?
        ORDER BY chips.ts_code ASC, chips.trade_date ASC, chips.price ASC
      `).all(...aliases, Math.max(1, limitDates))) as Array<{
    ts_code: string
    trade_date: string
    price: number
    percent: number
  }>

  const byStoredCode = new Map<string, ChipHistoryByDate>()
  for (const row of rows) {
    const history = byStoredCode.get(row.ts_code) ?? new Map()
    const points = history.get(row.trade_date) ?? []
    points.push({ price: row.price, percent: row.percent })
    history.set(row.trade_date, points)
    byStoredCode.set(row.ts_code, history)
  }
  for (const tsCode of tsCodes) {
    const exact = byStoredCode.get(tsCode)
    const fallback = byStoredCode.get(tsCode.split('.')[0])
    const merged = new Map([
      ...(fallback ?? new Map()),
      ...(exact ?? new Map()),
    ])
    result.set(tsCode, new Map([...merged.entries()].sort(([left], [right]) => left.localeCompare(right))))
  }
  return result
}

/** 清理超过指定天数的旧数据，返回删除行数 */
export function cleanupChipsCache(db: Database.Database, daysToKeep = 30): number {
  // 计算北京时间阈值日期（YYYYMMDD）
  const thresholdMs = Date.now() - daysToKeep * 24 * 60 * 60 * 1000
  const bjDate = new Date(thresholdMs + 8 * 3600 * 1000)
  const threshold = bjDate.toISOString().slice(0, 10).replace(/-/g, '')
  const result = db
    .prepare(`DELETE FROM cyq_chips_cache WHERE trade_date < ?`)
    .run(threshold)
  return result.changes
}
