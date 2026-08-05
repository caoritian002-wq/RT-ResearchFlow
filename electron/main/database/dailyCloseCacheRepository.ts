/**
 * FR-138 / FR-139: 日线收盘价 + OHLCV 本地缓存仓库（daily_close_cache 表）
 *
 * FR-138：避免每次重启后重复调用 Tushare daily 接口拉取历史收盘价数据。
 * FR-139：扩展 open/high/low 列，支持微缩蜡烛图渲染和18:00统一盘后同步。
 */

import type Database from 'better-sqlite3'
import type { DailyBasicRow, DailyRow } from '../services/tushareService'

export const DAILY_CLOSE_RETENTION_TRADE_DAYS = 520

export type DailyCloseQualityField =
  | 'open'
  | 'high'
  | 'low'
  | 'close'
  | 'pctChg'
  | 'vol'
  | 'turnoverRate'

export interface DailyCloseFieldQuality {
  missingRows: number
  missingRate: number | null
}

export interface DailyCloseQualitySummary {
  actualTradeDays: number
  totalRows: number
  earliestTradeDate: string | null
  latestTradeDate: string | null
  fields: Record<DailyCloseQualityField, DailyCloseFieldQuality>
  invalid: {
    nonPositiveCloseRows: number
    negativeVolumeRows: number
    invalidOhlcRows: number
    futureRows: number
  }
}

export type DailyCloseMaintenanceStatus = 'running' | 'success' | 'failed'

export interface DailyCloseMaintenanceState {
  status: DailyCloseMaintenanceStatus
  startedAt: number
  completedAt: number | null
  retainTradeDays: number
  removedRows: number | null
  remainingTradeDays: number | null
  message: string | null
}

interface CacheRow {
  ts_code: string
  trade_date: string
  open: number | null
  high: number | null
  low: number | null
  close: number
  pct_chg: number | null
  vol: number | null
  turnover_rate: number | null
}

function toDbRow(r: DailyRow): CacheRow {
  return {
    ts_code: r.tsCode,
    trade_date: r.tradeDate,
    open: r.open ?? null,
    high: r.high ?? null,
    low: r.low ?? null,
    close: r.close,
    pct_chg: r.pctChg,
    vol: r.vol ?? null,
    turnover_rate: r.turnoverRate ?? null
  }
}

function fromDbRow(r: CacheRow): DailyRow {
  return {
    tsCode: r.ts_code,
    tradeDate: r.trade_date,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    pctChg: r.pct_chg ?? 0,
    vol: r.vol,
    turnoverRate: r.turnover_rate
  }
}

function mergeDailyRows(
  requestedCode: string,
  exactRows: DailyRow[],
  fallbackRows: DailyRow[],
): DailyRow[] {
  const rowsByDate = new Map<string, DailyRow>()
  for (const row of fallbackRows) rowsByDate.set(row.tradeDate, { ...row, tsCode: requestedCode })
  for (const row of exactRows) rowsByDate.set(row.tradeDate, { ...row, tsCode: requestedCode })
  return [...rowsByDate.values()].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate))
}

/** 批量写入日线缓存，增量响应缺失的字段保留已有非空值。 */
export function upsertDailyClose(db: Database.Database, rows: DailyRow[]): void {
  if (rows.length === 0) return
  const stmt = db.prepare(
    `INSERT INTO daily_close_cache (ts_code, trade_date, open, high, low, close, pct_chg, vol, turnover_rate)
     VALUES (@ts_code, @trade_date, @open, @high, @low, @close, @pct_chg, @vol, @turnover_rate)
     ON CONFLICT(ts_code, trade_date) DO UPDATE SET
       open = COALESCE(excluded.open, daily_close_cache.open),
       high = COALESCE(excluded.high, daily_close_cache.high),
       low = COALESCE(excluded.low, daily_close_cache.low),
       close = excluded.close,
       pct_chg = COALESCE(excluded.pct_chg, daily_close_cache.pct_chg),
       vol = COALESCE(excluded.vol, daily_close_cache.vol),
       turnover_rate = COALESCE(excluded.turnover_rate, daily_close_cache.turnover_rate)`
  )
  const runAll = db.transaction((items: CacheRow[]) => {
    for (const item of items) {
      stmt.run(item)
    }
  })
  runAll(rows.map(toDbRow))
}

/**
 * 按股票列表和起始日期批量查询缓存，返回 Map<tsCode, 升序 DailyRow[]>
 * 仅返回 trade_date >= startDate 的行（含 open/high/low 字段）
 */
export function queryDailyClose(
  db: Database.Database,
  tsCodes: string[],
  startDate: string
): Map<string, DailyRow[]> {
  const result = new Map<string, DailyRow[]>()
  if (tsCodes.length === 0) return result

  const aliasToRequested = new Map<string, string[]>()
  for (const tsCode of tsCodes) {
    const aliases = new Set<string>([tsCode])
    const bareCode = tsCode.split('.')[0]
    if (bareCode) aliases.add(bareCode)
    for (const alias of aliases) {
      const requested = aliasToRequested.get(alias) ?? []
      requested.push(tsCode)
      aliasToRequested.set(alias, requested)
    }
  }
  const queryCodes = [...aliasToRequested.keys()]
  const placeholders = queryCodes.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT ts_code, trade_date, open, high, low, close, pct_chg, vol, turnover_rate
       FROM daily_close_cache
       WHERE ts_code IN (${placeholders}) AND trade_date >= ?
       ORDER BY ts_code, trade_date ASC`
    )
    .all(...queryCodes, startDate) as CacheRow[]

  const rowsByCode = new Map<string, DailyRow[]>()
  for (const r of rows) {
    if (!rowsByCode.has(r.ts_code)) rowsByCode.set(r.ts_code, [])
    rowsByCode.get(r.ts_code)!.push(fromDbRow(r))
  }

  for (const requestedCode of tsCodes) {
    const bareCode = requestedCode.split('.')[0]
    const exactRows = rowsByCode.get(requestedCode) ?? []
    const fallbackRows = bareCode && bareCode !== requestedCode ? (rowsByCode.get(bareCode) ?? []) : []
    const mergedRows = mergeDailyRows(requestedCode, exactRows, fallbackRows)
    if (mergedRows.length > 0) result.set(requestedCode, mergedRows)
  }
  return result
}

/** 按股票列表和目标交易日精确查询缓存，兼容带后缀与六位历史代码。 */
export function queryDailyCloseExact(
  db: Database.Database,
  tsCodes: string[],
  tradeDate: string,
): Map<string, DailyRow[]> {
  const result = new Map<string, DailyRow[]>()
  if (tsCodes.length === 0) return result

  const aliases = [...new Set(tsCodes.flatMap((tsCode) => [tsCode, tsCode.split('.')[0]]))]
  const placeholders = aliases.map(() => '?').join(', ')
  const rows = db.prepare(
    `SELECT ts_code, trade_date, open, high, low, close, pct_chg, vol, turnover_rate
     FROM daily_close_cache
     WHERE ts_code IN (${placeholders}) AND trade_date = ?
     ORDER BY ts_code ASC`
  ).all(...aliases, tradeDate) as CacheRow[]
  const rowsByCode = new Map<string, DailyRow[]>()
  for (const row of rows) {
    const mapped = rowsByCode.get(row.ts_code) ?? []
    mapped.push(fromDbRow(row))
    rowsByCode.set(row.ts_code, mapped)
  }
  for (const tsCode of tsCodes) {
    const bareCode = tsCode.split('.')[0]
    const mergedRows = mergeDailyRows(
      tsCode,
      rowsByCode.get(tsCode) ?? [],
      bareCode === tsCode ? [] : rowsByCode.get(bareCode) ?? [],
    )
    if (mergedRows.length > 0) result.set(tsCode, mergedRows)
  }
  return result
}

/**
 * FR-139: 查单只股票近 60 日全量 OHLCV，按 trade_date 升序。
 * 供 shortTerm:getStockMiniKline IPC 使用。
 */
export function queryStockOHLCV(
  db: Database.Database,
  tsCode: string,
  startDate: string
): DailyRow[] {
  const rows = db
    .prepare(
      `SELECT ts_code, trade_date, open, high, low, close, pct_chg, vol, turnover_rate
       FROM daily_close_cache
       WHERE ts_code = ? AND trade_date >= ?
       ORDER BY trade_date ASC`
    )
    .all(tsCode, startDate) as CacheRow[]
  return rows.map(fromDbRow)
}

/**
 * 查询某个交易日所有具备 OHLC 的日线记录, 供策略回测等权基准计算使用。
 */
export function queryDailyCloseByDate(db: Database.Database, tradeDate: string): DailyRow[] {
  const rows = db
    .prepare(
      `SELECT ts_code, trade_date, open, high, low, close, pct_chg, vol, turnover_rate
       FROM daily_close_cache
       WHERE trade_date = ?
         AND open IS NOT NULL
         AND high IS NOT NULL
         AND low IS NOT NULL
       ORDER BY ts_code ASC`
    )
    .all(tradeDate) as CacheRow[]
  return rows.map(fromDbRow)
}

/** 返回日线缓存中的最新交易日。交易日索引保证该查询不随全表行数线性增长。 */
export function getLatestDailyCloseTradeDate(db: Database.Database): string | null {
  const row = db.prepare(`
    SELECT trade_date
    FROM daily_close_cache
    ORDER BY trade_date DESC
    LIMIT 1
  `).get() as { trade_date: string } | undefined
  return row?.trade_date ?? null
}

/**
 * 返回指定股票在 startDate 之后的缓存行数，用于判断数据是否充足（>= 20 则跳过 API）
 */
export function countByTsCode(
  db: Database.Database,
  tsCode: string,
  startDate: string
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM daily_close_cache
       WHERE ts_code = ? AND trade_date >= ?`
    )
    .get(tsCode, startDate) as { cnt: number }
  return row?.cnt ?? 0
}

export interface DailyCloseCoverageRow {
  tradeDate: string
  count: number
}

/**
 * 按交易日统计 daily_close_cache 覆盖行数。
 * 用于历史全市场日线同步判断哪些日期已完整、哪些日期需要补齐。
 */
export function countDailyCloseByTradeDates(
  db: Database.Database,
  tradeDates: string[]
): Map<string, number> {
  const result = new Map<string, number>()
  if (tradeDates.length === 0) return result
  const placeholders = tradeDates.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT trade_date, COUNT(*) AS count
       FROM daily_close_cache
       WHERE trade_date IN (${placeholders})
       GROUP BY trade_date`
    )
    .all(...tradeDates) as { trade_date: string; count: number }[]
  for (const row of rows) result.set(row.trade_date, row.count)
  return result
}

/** 统计已上市 A 股日线中仍缺少换手率的记录，指数等非股票代码不计入缺口。 */
export function countMissingDailyCloseTurnoverByTradeDates(
  db: Database.Database,
  tradeDates: string[],
): Map<string, number> {
  const result = new Map<string, number>()
  if (tradeDates.length === 0) return result
  const placeholders = tradeDates.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT d.trade_date, COUNT(*) AS count
    FROM daily_close_cache d
    INNER JOIN stock_basic_cache s
      ON s.ts_code = d.ts_code AND s.list_status = 'L'
    WHERE d.trade_date IN (${placeholders})
      AND d.turnover_rate IS NULL
    GROUP BY d.trade_date
  `).all(...tradeDates) as Array<{ trade_date: string; count: number }>
  for (const row of rows) result.set(row.trade_date, row.count)
  return result
}

/** 只补齐已有日线的空换手率，不创建孤立日线，也不改写已有非空事实。 */
export function backfillDailyCloseTurnover(
  db: Database.Database,
  rows: DailyBasicRow[],
): number {
  const candidates = rows.filter((row) => row.turnoverRate != null)
  if (candidates.length === 0) return 0
  const stmt = db.prepare(`
    UPDATE daily_close_cache
    SET turnover_rate = @turnover_rate
    WHERE ts_code = @ts_code
      AND trade_date = @trade_date
      AND turnover_rate IS NULL
  `)
  const updateAll = db.transaction((items: DailyBasicRow[]) => {
    let updated = 0
    for (const item of items) {
      updated += stmt.run({
        ts_code: item.tsCode,
        trade_date: item.tradeDate,
        turnover_rate: item.turnoverRate,
      }).changes
    }
    return updated
  })
  return updateAll(candidates)
}

/** 返回某日期之后已有日线的交易日数量。 */
export function countDailyCloseTradeDatesSince(db: Database.Database, startDate: string): number {
  const row = db
    .prepare('SELECT COUNT(DISTINCT trade_date) AS count FROM daily_close_cache WHERE trade_date >= ?')
    .get(startDate) as { count: number } | undefined
  return row?.count ?? 0
}

/** 使用一次聚合查询返回历史日线覆盖、关键字段完整性和异常值。 */
export function getDailyCloseQualitySummary(db: Database.Database, maxTradeDate?: string): DailyCloseQualitySummary {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total_rows,
      COUNT(DISTINCT trade_date) AS actual_trade_days,
      MIN(trade_date) AS earliest_trade_date,
      MAX(trade_date) AS latest_trade_date,
      SUM(CASE WHEN open IS NULL THEN 1 ELSE 0 END) AS missing_open,
      SUM(CASE WHEN high IS NULL THEN 1 ELSE 0 END) AS missing_high,
      SUM(CASE WHEN low IS NULL THEN 1 ELSE 0 END) AS missing_low,
      SUM(CASE WHEN close IS NULL THEN 1 ELSE 0 END) AS missing_close,
      SUM(CASE WHEN pct_chg IS NULL THEN 1 ELSE 0 END) AS missing_pct_chg,
      SUM(CASE WHEN vol IS NULL THEN 1 ELSE 0 END) AS missing_vol,
      SUM(CASE WHEN turnover_rate IS NULL THEN 1 ELSE 0 END) AS missing_turnover_rate,
      SUM(CASE WHEN close <= 0 THEN 1 ELSE 0 END) AS non_positive_close,
      SUM(CASE WHEN vol < 0 THEN 1 ELSE 0 END) AS negative_volume,
      SUM(CASE WHEN high IS NOT NULL AND low IS NOT NULL AND (high < low OR (open IS NOT NULL AND (open > high OR open < low)) OR close > high OR close < low) THEN 1 ELSE 0 END) AS invalid_ohlc,
      SUM(CASE WHEN ? IS NOT NULL AND trade_date > ? THEN 1 ELSE 0 END) AS future_rows
    FROM daily_close_cache
  `).get(maxTradeDate ?? null, maxTradeDate ?? null) as {
    total_rows: number
    actual_trade_days: number
    earliest_trade_date: string | null
    latest_trade_date: string | null
    missing_open: number | null
    missing_high: number | null
    missing_low: number | null
    missing_close: number | null
    missing_pct_chg: number | null
    missing_vol: number | null
    missing_turnover_rate: number | null
    non_positive_close: number | null
    negative_volume: number | null
    invalid_ohlc: number | null
    future_rows: number | null
  }

  const totalRows = row.total_rows
  const field = (missingRows: number | null): DailyCloseFieldQuality => {
    const count = missingRows ?? 0
    return {
      missingRows: count,
      missingRate: totalRows === 0 ? null : count / totalRows,
    }
  }

  return {
    actualTradeDays: row.actual_trade_days,
    totalRows,
    earliestTradeDate: row.earliest_trade_date,
    latestTradeDate: row.latest_trade_date,
    fields: {
      open: field(row.missing_open),
      high: field(row.missing_high),
      low: field(row.missing_low),
      close: field(row.missing_close),
      pctChg: field(row.missing_pct_chg),
      vol: field(row.missing_vol),
      turnoverRate: field(row.missing_turnover_rate),
    },
    invalid: {
      nonPositiveCloseRows: row.non_positive_close ?? 0,
      negativeVolumeRows: row.negative_volume ?? 0,
      invalidOhlcRows: row.invalid_ohlc ?? 0,
      futureRows: row.future_rows ?? 0,
    },
  }
}

/** 读取最近一次历史日线清理状态；从未运行时返回 null。 */
export function getDailyCloseMaintenanceState(
  db: Database.Database,
): DailyCloseMaintenanceState | null {
  const row = db.prepare(`
    SELECT
      status,
      started_at,
      completed_at,
      retain_trade_days,
      removed_rows,
      remaining_trade_days,
      message
    FROM daily_close_maintenance_state
    WHERE id = 1
  `).get() as {
    status: DailyCloseMaintenanceStatus
    started_at: number
    completed_at: number | null
    retain_trade_days: number
    removed_rows: number | null
    remaining_trade_days: number | null
    message: string | null
  } | undefined

  if (!row) return null
  return {
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    retainTradeDays: row.retain_trade_days,
    removedRows: row.removed_rows,
    remainingTradeDays: row.remaining_trade_days,
    message: row.message,
  }
}

/** 覆盖单行维护状态，保证应用重启后仍可诊断最近清理结果。 */
export function saveDailyCloseMaintenanceState(
  db: Database.Database,
  state: DailyCloseMaintenanceState,
): void {
  db.prepare(`
    INSERT INTO daily_close_maintenance_state (
      id,
      status,
      started_at,
      completed_at,
      retain_trade_days,
      removed_rows,
      remaining_trade_days,
      message
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      retain_trade_days = excluded.retain_trade_days,
      removed_rows = excluded.removed_rows,
      remaining_trade_days = excluded.remaining_trade_days,
      message = excluded.message
  `).run(
    state.status,
    state.startedAt,
    state.completedAt,
    state.retainTradeDays,
    state.removedRows,
    state.remainingTradeDays,
    state.message,
  )
}

/** 按全库有效交易日保留窗口清理日线缓存，返回删除行数。 */
export function cleanupDailyCloseCache(
  db: Database.Database,
  retainTradeDays = DAILY_CLOSE_RETENTION_TRADE_DAYS,
): number {
  if (!Number.isInteger(retainTradeDays) || retainTradeDays < 1) {
    throw new RangeError('retainTradeDays must be a positive integer')
  }

  const boundary = db
    .prepare(`
      SELECT trade_date
      FROM (
        SELECT DISTINCT trade_date
        FROM daily_close_cache
        ORDER BY trade_date DESC
        LIMIT 1 OFFSET ?
      )
    `)
    .get(retainTradeDays - 1) as { trade_date: string } | undefined

  if (!boundary) return 0

  const info = db
    .prepare('DELETE FROM daily_close_cache WHERE trade_date < ?')
    .run(boundary.trade_date)
  return info.changes
}
