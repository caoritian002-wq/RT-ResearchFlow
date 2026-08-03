import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  countDailyCloseByTradeDates,
  getDailyCloseQualitySummary,
  type DailyCloseQualitySummary,
} from '../database/dailyCloseCacheRepository'
import { getLatestDataQualityRun, saveDataQualityRun } from '../database/dataQualityRepository'
import { getLastNTradingDays } from '../database/tradeCalRepository'
import {
  getHistoricalDailyDefaultEndDate,
  HISTORICAL_DAILY_TARGET_TRADE_DAYS,
} from './historicalDailySyncService'

export type DataTrustStatus = 'reliable' | 'degraded' | 'blocked'
export type DataQualityDatasetKey = 'stockBasic' | 'tradeCalendar' | 'dailyMarket' | 'auction' | 'benchmarks' | 'financials'
export type DataQualityActionKey = 'syncStockBasic' | 'syncTradeCalendar' | 'syncHistoricalDaily' | 'syncMarketBenchmarks'

export interface DataQualityReason {
  code: string
  message: string
  severity: 'warning' | 'error'
}

export interface DataQualityDatasetResult {
  key: DataQualityDatasetKey
  title: string
  status: DataTrustStatus
  summary: string
  recordCount: number
  earliestDate: string | null
  latestDate: string | null
  sourceLabel: string
  affectedModules: string[]
  reasons: DataQualityReason[]
  action: { key: DataQualityActionKey; label: string } | null
}

export interface DataQualitySnapshot {
  status: DataTrustStatus
  checkedAt: number
  fingerprint: string
  persistedRunId: number | null
  persistedAt: number | null
  summary: Record<DataTrustStatus, number>
  datasets: DataQualityDatasetResult[]
}

export const CORE_BENCHMARK_CODES = ['000001.SH', '399001.SZ', '399006.SZ', '000300.SH'] as const
const COMPLETE_DAILY_ROW_THRESHOLD = 4000

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined
}

function tableHasColumns(db: Database.Database, table: string, columns: string[]): boolean {
  if (!tableExists(db, table)) return false
  const available = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name))
  return columns.every((column) => available.has(column))
}

function bjYmd(now: number): string {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '')
}

function addDaysYmd(ymd: string, days: number): string {
  const date = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10).replace(/-/g, '')
}

function timestampToYmd(value: number | null): string | null {
  if (!value || !Number.isFinite(value)) return null
  return new Date(value + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '')
}

function rankStatus(statuses: DataTrustStatus[]): DataTrustStatus {
  if (statuses.includes('blocked')) return 'blocked'
  if (statuses.includes('degraded')) return 'degraded'
  return 'reliable'
}

function reason(code: string, message: string, severity: DataQualityReason['severity']): DataQualityReason {
  return { code, message, severity }
}

function missingTable(
  key: DataQualityDatasetKey,
  title: string,
  sourceLabel: string,
  affectedModules: string[],
  action: DataQualityDatasetResult['action'],
): DataQualityDatasetResult {
  return {
    key,
    title,
    status: 'blocked',
    summary: '本地数据结构尚未就绪',
    recordCount: 0,
    earliestDate: null,
    latestDate: null,
    sourceLabel,
    affectedModules,
    reasons: [reason('TABLE_MISSING', '应用数据库尚未完成对应数据结构初始化。', 'error')],
    action,
  }
}

function stockBasicQuality(db: Database.Database, now: number): DataQualityDatasetResult {
  const action = { key: 'syncStockBasic' as const, label: '补齐股票基础资料' }
  if (!tableHasColumns(db, 'stock_basic_cache', ['ts_code', 'name', 'updated_at'])) {
    return missingTable('stockBasic', '股票基础资料', 'Tushare / 本地缓存', ['股票搜索', '策略候选', '公司映射'], action)
  }
  const stats = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN name IS NULL OR trim(name) = '' THEN 1 ELSE 0 END) AS missing_names,
      SUM(CASE WHEN ts_code NOT GLOB '[0-9][0-9][0-9][0-9][0-9][0-9].[A-Z][A-Z]' THEN 1 ELSE 0 END) AS invalid_codes,
      MIN(updated_at) AS earliest_at, MAX(updated_at) AS latest_at
    FROM stock_basic_cache
  `).get() as { total: number; missing_names: number; invalid_codes: number; earliest_at: number | null; latest_at: number | null }
  const reasons: DataQualityReason[] = []
  if (stats.total === 0) reasons.push(reason('EMPTY', '尚未同步股票基础资料。', 'error'))
  else if (stats.total < 4000) reasons.push(reason('MARKET_COVERAGE_LOW', `当前只有 ${stats.total} 只股票，未达到全市场基础规模。`, 'warning'))
  if (stats.invalid_codes > 0) reasons.push(reason('INVALID_CODES', `${stats.invalid_codes} 条证券代码格式异常。`, 'warning'))
  if (stats.missing_names > 0) reasons.push(reason('MISSING_NAMES', `${stats.missing_names} 条记录缺少股票名称。`, 'warning'))
  const latestDate = timestampToYmd(stats.latest_at)
  if (latestDate && addDaysYmd(latestDate, 14) < bjYmd(now)) reasons.push(reason('STALE', '最近一次股票基础资料更新已超过14天。', 'warning'))
  const status: DataTrustStatus = stats.total === 0 ? 'blocked' : reasons.length > 0 ? 'degraded' : 'reliable'
  return {
    key: 'stockBasic', title: '股票基础资料', status,
    summary: status === 'reliable' ? `已覆盖 ${stats.total} 只股票` : status === 'blocked' ? '股票搜索和公司映射暂不可用' : `已覆盖 ${stats.total} 只股票，仍有质量提醒`,
    recordCount: stats.total,
    earliestDate: timestampToYmd(stats.earliest_at), latestDate,
    sourceLabel: 'Tushare / 本地缓存', affectedModules: ['股票搜索', '策略候选', '公司映射'], reasons, action,
  }
}

function tradeCalendarQuality(db: Database.Database, now: number): DataQualityDatasetResult {
  const action = { key: 'syncTradeCalendar' as const, label: '补齐交易日历' }
  if (!tableExists(db, 'trade_cal')) {
    return missingTable('tradeCalendar', '交易日历', 'Tushare 交易日历', ['任务调度', 'T+N回访', '策略评估'], action)
  }
  const today = bjYmd(now)
  const futureTarget = addDaysYmd(today, 60)
  const stats = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN is_open = 1 AND cal_date <= ? THEN 1 ELSE 0 END) AS historical_open_days,
      MIN(cal_date) AS earliest_date, MAX(cal_date) AS latest_date
    FROM trade_cal
  `).get(today) as { total: number; historical_open_days: number; earliest_date: string | null; latest_date: string | null }
  const reasons: DataQualityReason[] = []
  if (stats.total === 0) reasons.push(reason('EMPTY', '本地尚无交易日历。', 'error'))
  if (stats.historical_open_days < HISTORICAL_DAILY_TARGET_TRADE_DAYS) {
    reasons.push(reason('HISTORY_INCOMPLETE', `历史开市日只有 ${stats.historical_open_days}/${HISTORICAL_DAILY_TARGET_TRADE_DAYS}。`, 'error'))
  }
  if (!stats.latest_date || stats.latest_date < futureTarget) reasons.push(reason('FUTURE_COVERAGE_LOW', '未来60天开闭市安排尚未完整覆盖。', 'warning'))
  const status: DataTrustStatus = stats.total === 0 || stats.historical_open_days < HISTORICAL_DAILY_TARGET_TRADE_DAYS
    ? 'blocked' : reasons.length > 0 ? 'degraded' : 'reliable'
  return {
    key: 'tradeCalendar', title: '交易日历', status,
    summary: status === 'reliable' ? '历史与未来交易日安排完整' : status === 'blocked' ? '交易日推进与T+N统计暂不可信' : '历史可用，未来日历需要补齐',
    recordCount: stats.total, earliestDate: stats.earliest_date, latestDate: stats.latest_date,
    sourceLabel: 'Tushare 交易日历', affectedModules: ['任务调度', 'T+N回访', '策略评估'], reasons, action,
  }
}

function dailyMarketQuality(
  db: Database.Database,
  now: number,
  suppliedQuality?: DailyCloseQualitySummary,
): DataQualityDatasetResult {
  const action = { key: 'syncHistoricalDaily' as const, label: '补齐历史日线' }
  if (!tableHasColumns(db, 'daily_close_cache', ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'vol'])) {
    return missingTable('dailyMarket', '日线与复权', 'Tushare 日线 / 复权因子', ['行情图表', '趋势评分', '策略回测', '产业决策'], action)
  }
  const asOf = getHistoricalDailyDefaultEndDate(now)
  const quality = suppliedQuality ?? getDailyCloseQualitySummary(db, asOf)
  const tradeDays = tableExists(db, 'trade_cal') ? getLastNTradingDays(db, HISTORICAL_DAILY_TARGET_TRADE_DAYS, asOf) : []
  const coverage = tradeDays.length > 0 ? countDailyCloseByTradeDates(db, tradeDays) : new Map<string, number>()
  const activeStockCount = tableHasColumns(db, 'stock_basic_cache', ['ts_code', 'list_status'])
    ? (db.prepare(`SELECT COUNT(*) AS count FROM stock_basic_cache WHERE list_status IS NULL OR list_status != 'D'`).get() as { count: number }).count
    : 0
  const completeRowThreshold = activeStockCount > 0
    ? Math.min(COMPLETE_DAILY_ROW_THRESHOLD, Math.max(1, Math.floor(activeStockCount * 0.9)))
    : COMPLETE_DAILY_ROW_THRESHOLD
  const completeDays = tradeDays.length > 0
    ? tradeDays.filter((date) => (coverage.get(date) ?? 0) >= completeRowThreshold).length
    : (db.prepare(`
        SELECT COUNT(*) AS count FROM (
          SELECT trade_date FROM daily_close_cache
          WHERE trade_date <= ? GROUP BY trade_date HAVING COUNT(*) >= ?
          ORDER BY trade_date DESC LIMIT ?
        )
      `).get(asOf, completeRowThreshold, HISTORICAL_DAILY_TARGET_TRADE_DAYS) as { count: number }).count
  const registeredSecurities = tableExists(db, 'industry_research_securities')
    ? (db.prepare(`SELECT COUNT(*) AS count FROM industry_research_securities WHERE list_status IS NULL OR list_status != 'D'`).get() as { count: number }).count
    : 0
  const adjustedSecurities = registeredSecurities > 0 && tableExists(db, 'security_adjustment_factor_cache')
    ? (db.prepare(`
        SELECT COUNT(DISTINCT s.ts_code) AS count
        FROM industry_research_securities s
        JOIN security_adjustment_factor_cache a ON a.ts_code = s.ts_code AND a.trade_date <= ?
        WHERE s.list_status IS NULL OR s.list_status != 'D'
      `).get(asOf) as { count: number }).count
    : 0
  const reasons: DataQualityReason[] = []
  if (quality.totalRows === 0) reasons.push(reason('EMPTY', '本地尚无日线数据。', 'error'))
  if (completeDays < HISTORICAL_DAILY_TARGET_TRADE_DAYS) reasons.push(reason('TRADE_DAY_COVERAGE_LOW', `全市场完整交易日只有 ${completeDays}/${HISTORICAL_DAILY_TARGET_TRADE_DAYS}。`, 'error'))
  const missingKeyRows = quality.fields.open.missingRows + quality.fields.high.missingRows + quality.fields.low.missingRows
  if (missingKeyRows > 0) reasons.push(reason('KEY_FIELDS_MISSING', `OHLC关键字段累计缺失 ${missingKeyRows} 行。`, 'warning'))
  const invalidMarketRows = quality.invalid.nonPositiveCloseRows + quality.invalid.negativeVolumeRows + quality.invalid.invalidOhlcRows
  if (invalidMarketRows > 0) {
    reasons.push(reason('INVALID_MARKET_VALUES', `发现 ${invalidMarketRows} 条价格或成交量异常。`, 'warning'))
  }
  if (quality.invalid.futureRows > 0) reasons.push(reason('FUTURE_FACTS', `${quality.invalid.futureRows} 条日线晚于当前可用截止日，已排除在覆盖判断之外。`, 'warning'))
  if (registeredSecurities > adjustedSecurities) reasons.push(reason('ADJUSTMENT_GAPS', `已登记产业公司中 ${registeredSecurities - adjustedSecurities} 只证券缺少复权因子。`, 'warning'))
  const status: DataTrustStatus = quality.totalRows === 0 || completeDays < HISTORICAL_DAILY_TARGET_TRADE_DAYS
    ? 'blocked' : reasons.length > 0 ? 'degraded' : 'reliable'
  return {
    key: 'dailyMarket', title: '日线与复权', status,
    summary: status === 'reliable' ? `全市场 ${completeDays} 个交易日可用` : status === 'blocked' ? `完整交易日仅 ${completeDays}/${HISTORICAL_DAILY_TARGET_TRADE_DAYS}` : '行情可用，但部分字段或复权仍有缺口',
    recordCount: quality.totalRows, earliestDate: quality.earliestTradeDate, latestDate: quality.latestTradeDate,
    sourceLabel: 'Tushare 日线 / 复权因子', affectedModules: ['行情图表', '趋势评分', '策略回测', '产业决策'], reasons, action,
  }
}

function expectedAuctionDate(db: Database.Database, now: number): string | null {
  if (!tableExists(db, 'trade_cal')) return null
  const bj = new Date(now + 8 * 60 * 60 * 1000)
  const today = bjYmd(now)
  const afterAuction = bj.getUTCHours() > 9 || (bj.getUTCHours() === 9 && bj.getUTCMinutes() >= 30)
  const operator = afterAuction ? '<=' : '<'
  const row = db.prepare(`SELECT MAX(cal_date) AS date FROM trade_cal WHERE is_open = 1 AND cal_date ${operator} ?`).get(today) as { date: string | null }
  return row.date
}

function auctionQuality(db: Database.Database, now: number): DataQualityDatasetResult {
  if (!tableExists(db, 'stk_auction_cache')) {
    return missingTable('auction', '早盘竞价', 'Tushare 竞价快照', ['早盘竞价', '题材主线', '竞价效果评估'], null)
  }
  const expectedDate = expectedAuctionDate(db, now)
  const stats = db.prepare(`
    SELECT COUNT(*) AS total, MIN(trade_date) AS earliest_date, MAX(trade_date) AS latest_date,
      SUM(CASE WHEN price IS NULL OR price <= 0 THEN 1 ELSE 0 END) AS invalid_prices,
      SUM(CASE WHEN trade_date > ? THEN 1 ELSE 0 END) AS future_rows
    FROM stk_auction_cache
  `).get(bjYmd(now)) as { total: number; earliest_date: string | null; latest_date: string | null; invalid_prices: number; future_rows: number }
  const expectedRows = expectedDate
    ? (db.prepare('SELECT COUNT(*) AS count FROM stk_auction_cache WHERE trade_date = ?').get(expectedDate) as { count: number }).count
    : 0
  const reasons: DataQualityReason[] = []
  if (stats.total === 0) reasons.push(reason('EMPTY', '本地尚无竞价快照。', 'error'))
  if (!expectedDate) reasons.push(reason('CALENDAR_UNAVAILABLE', '缺少交易日历，无法确定应有的竞价日期。', 'error'))
  else if (expectedRows === 0) reasons.push(reason('EXPECTED_DATE_MISSING', `${expectedDate} 尚无竞价记录。`, 'error'))
  if (stats.invalid_prices > 0) reasons.push(reason('INVALID_PRICE', `${stats.invalid_prices} 条竞价记录缺少有效价格。`, 'warning'))
  if (stats.future_rows > 0) reasons.push(reason('FUTURE_FACTS', `${stats.future_rows} 条竞价记录晚于当前日期。`, 'warning'))
  const blocked = stats.total === 0 || !expectedDate || expectedRows === 0
  return {
    key: 'auction', title: '早盘竞价', status: blocked ? 'blocked' : reasons.length > 0 ? 'degraded' : 'reliable',
    summary: blocked ? '最近应有交易日的竞价事实缺失' : reasons.length > 0 ? `${expectedDate} 已有 ${expectedRows} 条，部分记录需注意` : `${expectedDate} 已有 ${expectedRows} 条竞价事实`,
    recordCount: stats.total, earliestDate: stats.earliest_date, latestDate: stats.latest_date,
    sourceLabel: 'Tushare 竞价快照', affectedModules: ['早盘竞价', '题材主线', '竞价效果评估'], reasons, action: null,
  }
}

function benchmarkQuality(db: Database.Database, now: number): DataQualityDatasetResult {
  const action = { key: 'syncMarketBenchmarks' as const, label: '补齐核心基准' }
  if (!tableExists(db, 'daily_close_cache') && !tableExists(db, 'stock_price_cache')) {
    return missingTable('benchmarks', '核心市场基准', 'Tushare / 东方财富指数日线', ['趋势比较', '策略超额', '市场环境'], action)
  }
  const placeholders = CORE_BENCHMARK_CODES.map(() => '?').join(',')
  const parts: string[] = []
  if (tableExists(db, 'daily_close_cache')) parts.push(`SELECT ts_code AS code, trade_date FROM daily_close_cache WHERE ts_code IN (${placeholders})`)
  if (tableExists(db, 'stock_price_cache')) parts.push(`SELECT stockCode AS code, tradeDate AS trade_date FROM stock_price_cache WHERE stockCode IN (${placeholders})`)
  const params = parts.flatMap(() => [...CORE_BENCHMARK_CODES])
  const rows = db.prepare(`
    SELECT code, COUNT(DISTINCT trade_date) AS trade_days, MIN(trade_date) AS earliest_date, MAX(trade_date) AS latest_date
    FROM (${parts.join(' UNION ALL ')}) GROUP BY code
  `).all(...params) as Array<{ code: string; trade_days: number; earliest_date: string; latest_date: string }>
  const asOf = getHistoricalDailyDefaultEndDate(now)
  const byCode = new Map(rows.map((row) => [row.code, row]))
  const missing = CORE_BENCHMARK_CODES.filter((code) => !byCode.has(code))
  const short = rows.filter((row) => row.trade_days < 30)
  const stale = rows.filter((row) => row.latest_date < asOf)
  const reasons: DataQualityReason[] = []
  if (missing.length === CORE_BENCHMARK_CODES.length) reasons.push(reason('EMPTY', '四个核心市场基准均无本地日线。', 'error'))
  else if (missing.length > 0) reasons.push(reason('INDEX_MISSING', `${missing.length} 个核心基准没有本地日线。`, 'warning'))
  if (short.length > 0) reasons.push(reason('HISTORY_SHORT', `${short.length} 个核心基准不足30个交易日。`, 'warning'))
  if (stale.length > 0) reasons.push(reason('STALE', `${stale.length} 个核心基准未更新到最近可用日期。`, 'warning'))
  const allDates = rows.flatMap((row) => [row.earliest_date, row.latest_date]).sort()
  const recordCount = rows.reduce((sum, row) => sum + row.trade_days, 0)
  const status: DataTrustStatus = missing.length === CORE_BENCHMARK_CODES.length ? 'blocked' : reasons.length > 0 ? 'degraded' : 'reliable'
  return {
    key: 'benchmarks', title: '核心市场基准', status,
    summary: status === 'reliable' ? '四个核心指数可用于比较' : status === 'blocked' ? '趋势与策略超额暂缺比较基准' : `已覆盖 ${rows.length}/4 个核心指数`,
    recordCount, earliestDate: allDates[0] ?? null, latestDate: allDates[allDates.length - 1] ?? null,
    sourceLabel: 'Tushare / 东方财富指数日线', affectedModules: ['趋势比较', '策略超额', '市场环境'], reasons, action,
  }
}

function financialQuality(db: Database.Database): DataQualityDatasetResult {
  const required = ['industry_research_securities', 'industry_research_financial_facts', 'industry_research_financial_sync_state']
  if (required.some((table) => !tableExists(db, table))) {
    return missingTable('financials', '产业研究财务', 'Tushare 财务 / 官方公告', ['产业研究', '财务验证', '决策复核'], null)
  }
  const target = (db.prepare(`
    SELECT COUNT(*) AS count FROM industry_research_securities
    WHERE list_status IS NULL OR list_status != 'D'
  `).get() as { count: number }).count
  if (target === 0) {
    return {
      key: 'financials', title: '产业研究财务', status: 'reliable', summary: '当前没有待检查的产业研究公司',
      recordCount: 0, earliestDate: null, latestDate: null, sourceLabel: 'Tushare 财务 / 官方公告',
      affectedModules: ['产业研究', '财务验证', '决策复核'], reasons: [], action: null,
    }
  }
  const stats = db.prepare(`
    SELECT COUNT(*) AS total,
      COUNT(DISTINCT security_id) AS covered_securities,
      MIN(COALESCE(f_ann_date, ann_date)) AS earliest_date,
      MAX(COALESCE(f_ann_date, ann_date)) AS latest_date,
      SUM(CASE WHEN f_ann_date IS NULL AND ann_date IS NULL THEN 1 ELSE 0 END) AS missing_available_date
    FROM industry_research_financial_facts
  `).get() as { total: number; covered_securities: number; earliest_date: string | null; latest_date: string | null; missing_available_date: number }
  const failed = (db.prepare(`SELECT COUNT(*) AS count FROM industry_research_financial_sync_state WHERE status = 'failed'`).get() as { count: number }).count
  const reasons: DataQualityReason[] = []
  if (stats.total === 0) reasons.push(reason('EMPTY', '已登记产业公司尚无财务事实。', 'error'))
  else if (stats.covered_securities < target) reasons.push(reason('COMPANY_COVERAGE_LOW', `${target - stats.covered_securities} 只已登记证券尚无财务事实。`, 'warning'))
  if (failed > 0) reasons.push(reason('SYNC_FAILURES', `${failed} 个财务数据集最近同步失败。`, 'warning'))
  if (stats.missing_available_date > 0) reasons.push(reason('AVAILABLE_DATE_MISSING', `${stats.missing_available_date} 条财务事实缺少可用披露日期。`, 'warning'))
  const status: DataTrustStatus = stats.total === 0 ? 'blocked' : reasons.length > 0 ? 'degraded' : 'reliable'
  return {
    key: 'financials', title: '产业研究财务', status,
    summary: status === 'reliable' ? `${target} 只已登记证券均有财务事实` : status === 'blocked' ? '已登记产业公司尚未形成财务验证' : `财务事实覆盖 ${stats.covered_securities}/${target} 只证券`,
    recordCount: stats.total, earliestDate: stats.earliest_date, latestDate: stats.latest_date,
    sourceLabel: 'Tushare 财务 / 官方公告', affectedModules: ['产业研究', '财务验证', '决策复核'], reasons, action: null,
  }
}

function fingerprintDatasets(datasets: DataQualityDatasetResult[]): string {
  const normalized = datasets.map((dataset) => ({
    key: dataset.key,
    status: dataset.status,
    recordCount: dataset.recordCount,
    earliestDate: dataset.earliestDate,
    latestDate: dataset.latestDate,
    reasons: dataset.reasons.map((item) => item.code).sort(),
  }))
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

export function getDataQualitySnapshot(
  db: Database.Database,
  now = Date.now(),
  dailyCloseQuality?: DailyCloseQualitySummary,
): DataQualitySnapshot {
  const datasets = [
    stockBasicQuality(db, now),
    tradeCalendarQuality(db, now),
    dailyMarketQuality(db, now, dailyCloseQuality),
    auctionQuality(db, now),
    benchmarkQuality(db, now),
    financialQuality(db),
  ]
  const summary: Record<DataTrustStatus, number> = { reliable: 0, degraded: 0, blocked: 0 }
  for (const dataset of datasets) summary[dataset.status] += 1
  const latest = tableExists(db, 'data_quality_runs') ? getLatestDataQualityRun(db) : null
  return {
    status: rankStatus(datasets.map((dataset) => dataset.status)),
    checkedAt: now,
    fingerprint: fingerprintDatasets(datasets),
    persistedRunId: latest?.id ?? null,
    persistedAt: latest?.checkedAt ?? null,
    summary,
    datasets,
  }
}

export function persistDataQualitySnapshot(db: Database.Database, now = Date.now()): DataQualitySnapshot {
  const snapshot = getDataQualitySnapshot(db, now)
  const id = saveDataQualityRun(db, {
    checkedAt: snapshot.checkedAt,
    status: snapshot.status,
    fingerprint: snapshot.fingerprint,
    snapshot: snapshot as unknown as Record<string, unknown>,
  })
  return { ...snapshot, persistedRunId: id, persistedAt: snapshot.checkedAt }
}
