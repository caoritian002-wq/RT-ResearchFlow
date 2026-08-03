import type Database from 'better-sqlite3'
import type { StockMinuteCacheRow } from './types'

// FR-123: 个股分钟级 K 线缓存仓库（Tushare 374 rt_min）
// 表结构由 Migration 031 创建. 三联合主键 (stock_code, trade_date, ts_minute)

/** 批量 upsert 分钟 K 线行. 使用事务 + INSERT OR REPLACE 实现增量去重写入. */
export function upsertStockMinute(db: Database.Database, rows: StockMinuteCacheRow[]): void {
  if (rows.length === 0) return
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO stock_minute_cache
      (stock_code, trade_date, ts_minute, open, high, low, close, vol, amount, fetched_at)
    VALUES (@stockCode, @tradeDate, @tsMinute, @open, @high, @low, @close, @vol, @amount, @fetchedAt)
  `)
  const tx = db.transaction((items: StockMinuteCacheRow[]) => {
    for (const r of items) stmt.run(r)
  })
  tx(rows)
}

/** 查询指定股票指定交易日的分钟 K 线, 按 ts_minute 升序. */
export function getStockMinuteByDate(
  db: Database.Database,
  stockCode: string,
  tradeDate: string
): StockMinuteCacheRow[] {
  return db
    .prepare(
      `SELECT stock_code AS stockCode, trade_date AS tradeDate, ts_minute AS tsMinute,
              open, high, low, close, vol, amount, fetched_at AS fetchedAt
       FROM stock_minute_cache
       WHERE stock_code = ? AND trade_date = ?
       ORDER BY ts_minute ASC`
    )
    .all(stockCode, tradeDate) as StockMinuteCacheRow[]
}

/** 返回该股票最近一个有缓存的交易日; 无数据返回 null. */
export function getLatestTradeDateForStock(
  db: Database.Database,
  stockCode: string
): string | null {
  const row = db
    .prepare(
      'SELECT MAX(trade_date) AS d FROM stock_minute_cache WHERE stock_code = ?'
    )
    .get(stockCode) as { d: string | null } | undefined
  return row?.d ?? null
}

/** 清理早于 daysToKeep 天前的分钟 K 缓存; 返回删除行数. 阈值按北京时间日期计算. */
export function cleanupStockMinuteCache(
  db: Database.Database,
  daysToKeep: number = 7
): number {
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const thresholdMs = bjNow.getTime() - daysToKeep * 24 * 60 * 60 * 1000
  const thresholdDate = new Date(thresholdMs).toISOString().slice(0, 10).replace(/-/g, '')
  const info = db
    .prepare('DELETE FROM stock_minute_cache WHERE trade_date < ?')
    .run(thresholdDate)
  return info.changes
}
