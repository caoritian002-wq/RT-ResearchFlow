import type Database from 'better-sqlite3'
import { getDataSourceConfig } from '../database/dataSourceRepository'
import { getConfiguredProviders } from '../database/aiConfigRepository'
import { getConceptSource } from '../database/settingsRepository'
import { runStockBasicSyncJob, runConceptMembersSyncJob } from './schedulerService'
import { ensureTodayDecisionSignalsBackfilled } from './decisionSignalBackfillService'
import {
  countDailyCloseByTradeDates,
  DAILY_CLOSE_RETENTION_TRADE_DAYS,
  getDailyCloseMaintenanceState,
  getDailyCloseQualitySummary,
  upsertDailyClose,
  type DailyCloseFieldQuality,
  type DailyCloseQualitySummary,
} from '../database/dailyCloseCacheRepository'
import { getLastNTradingDays } from '../database/tradeCalRepository'
import {
  getHistoricalDailyDefaultEndDate,
  HISTORICAL_DAILY_TARGET_TRADE_DAYS,
  runHistoricalDailySync,
} from './historicalDailySyncService'
import { decryptApiKey } from '../utils/apiKeyEncryption'
import type { BrowserWindow } from 'electron'
import {
  CORE_BENCHMARK_CODES,
  getDataQualitySnapshot,
  persistDataQualitySnapshot,
  type DataQualitySnapshot,
} from './dataQualityService'
import { syncTradeCalFull } from './tradeCalSyncService'
import { fetchIndexDailyForCodes } from './tushareService'

export type DiagnosticStatus = 'ok' | 'warning' | 'error'
export type DiagnosticGroupKey = 'config' | 'freshness' | 'sync' | 'database'
export type DiagnosticActionKey = 'open-datasource' | 'open-ai-config' | 'syncStockBasic' | 'syncTradeCalendar' | 'syncHistoricalDaily' | 'syncMarketBenchmarks' | 'syncConceptMembers' | 'backfillDecisionSignals'
export type DiagnosticRunAction = 'refreshHealth' | 'refreshDataQuality' | 'syncStockBasic' | 'syncTradeCalendar' | 'syncHistoricalDaily' | 'syncMarketBenchmarks' | 'syncConceptMembers' | 'backfillDecisionSignals'

export interface DiagnosticAction {
  key: DiagnosticActionKey
  label: string
  kind: 'navigate' | 'run'
}

export interface DiagnosticItem {
  key: string
  title: string
  status: DiagnosticStatus
  message: string
  detail?: string
  recordCount?: number | null
  latestDate?: string | null
  checkedAt: number
  actions?: DiagnosticAction[]
}

export interface DiagnosticGroup {
  key: DiagnosticGroupKey
  title: string
  items: DiagnosticItem[]
}

export interface DiagnosticsHealthSnapshot {
  status: DiagnosticStatus
  checkedAt: number
  summary: Record<DiagnosticStatus, number>
  groups: DiagnosticGroup[]
  dailyCloseQuality?: DailyCloseQuality
  dataQuality?: DataQualitySnapshot
}

export interface DailyCloseCleanupState {
  status: 'never' | 'running' | 'success' | 'failed'
  startedAt: number | null
  completedAt: number | null
  retainTradeDays: number | null
  removedRows: number | null
  remainingTradeDays: number | null
  message: string | null
}

export interface DailyCloseQuality {
  targetTradeDays: number
  retentionTradeDays: number
  actualTradeDays: number
  totalRows: number
  earliestTradeDate: string | null
  latestTradeDate: string | null
  fields: Record<
    'open' | 'high' | 'low' | 'close' | 'pctChg' | 'vol' | 'turnoverRate',
    DailyCloseFieldQuality
  >
  cleanup: DailyCloseCleanupState
}

export interface DiagnosticRunResult {
  action: DiagnosticRunAction
  status: 'completed' | 'started'
  message: string
}

interface TableFreshnessSpec {
  key: string
  title: string
  table: string
  dateColumn?: string
  detail: string
  staleDays?: number
}

const FRESHNESS_TABLES: TableFreshnessSpec[] = [
  { key: 'stockBasic', title: '股票基础数据', table: 'stock_basic_cache', dateColumn: 'updated_at', detail: '用于股票名称搜索和冷启动候选列表。', staleDays: 14 },
  { key: 'dailyClose', title: '日线缓存', table: 'daily_close_cache', dateColumn: 'trade_date', detail: '用于走势图、趋势评分、策略回测和条件积木全市场候选。', staleDays: 7 },
  { key: 'minute', title: '分钟缓存', table: 'stock_minute_cache', dateColumn: 'trade_date', detail: '用于分时图、预测回测和盘中走势展示。', staleDays: 3 },
  { key: 'limitList', title: '涨跌停缓存', table: 'limit_list_daily', dateColumn: 'trade_date', detail: '用于短线策略、打板助手和今日看板补种。', staleDays: 7 },
  { key: 'kplConcept', title: 'KPL 题材成分', table: 'kpl_concept_members', detail: '用于题材归因、板块联动和短线策略题材标签。' },
  { key: 'thsConcept', title: 'THS 题材成分', table: 'ths_concept_members', detail: '题材源切换到同花顺时使用。' },
  { key: 'dcConcept', title: '东方财富题材成分', table: 'dc_concept_members', dateColumn: 'trade_date', detail: '题材源切换到东方财富时使用。', staleDays: 14 },
  { key: 'chipResults', title: '筹码监控结果', table: 'chip_monitor_results', dateColumn: 'trade_date', detail: '用于筹码结论和持仓筹码摘要。', staleDays: 14 },
  { key: 'trendScores', title: '趋势评分', table: 'trend_scores', dateColumn: 'trade_date', detail: '用于长线趋势看板和趋势信号。', staleDays: 7 },
  { key: 'decisionSignals', title: '今日看板信号', table: 'decision_signals', dateColumn: 'signal_time', detail: '用于今日看板首页、红点和信号生命周期。', staleDays: 2 }
]

const HISTORICAL_DAILY_COMPLETE_ROW_THRESHOLD = 4000

function toDateLike(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null
    return new Date(value).toISOString().slice(0, 10)
  }
  const text = String(value)
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10)
  return text
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table) as { name: string } | undefined
  return !!row
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    return rows.some((row) => row.name === column)
  } catch {
    return false
  }
}

function countRows(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
  return row.count
}

function getMaxValue(db: Database.Database, table: string, column: string): unknown {
  const row = db.prepare(`SELECT MAX(${column}) AS value FROM ${table}`).get() as { value: unknown }
  return row.value
}

function daysSince(dateText: string | null): number | null {
  if (!dateText) return null
  const normalized = dateText.replace(/-/g, '')
  if (!/^\d{8}$/.test(normalized)) return null
  const year = Number(normalized.slice(0, 4))
  const month = Number(normalized.slice(4, 6)) - 1
  const day = Number(normalized.slice(6, 8))
  const date = Date.UTC(year, month, day)
  const now = Date.now() + 8 * 60 * 60 * 1000
  const today = new Date(now).toISOString().slice(0, 10).replace(/-/g, '')
  const todayDate = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(4, 6)) - 1, Number(today.slice(6, 8)))
  return Math.floor((todayDate - date) / 86_400_000)
}

function rankStatus(statuses: DiagnosticStatus[]): DiagnosticStatus {
  if (statuses.includes('error')) return 'error'
  if (statuses.includes('warning')) return 'warning'
  return 'ok'
}

function getHistoricalDailyCoverage(db: Database.Database): { covered: number; target: number; hasTradeCal: boolean } {
  const endDate = getHistoricalDailyDefaultEndDate()
  const tradeDays = getLastNTradingDays(db, HISTORICAL_DAILY_TARGET_TRADE_DAYS, endDate)
  if (tradeDays.length > 0) {
    const counts = countDailyCloseByTradeDates(db, tradeDays)
    const covered = tradeDays.filter((tradeDate) => (counts.get(tradeDate) ?? 0) >= HISTORICAL_DAILY_COMPLETE_ROW_THRESHOLD).length
    return { covered, target: HISTORICAL_DAILY_TARGET_TRADE_DAYS, hasTradeCal: true }
  }
  const rows = db
    .prepare('SELECT trade_date, COUNT(*) AS count FROM daily_close_cache GROUP BY trade_date ORDER BY trade_date DESC LIMIT ?')
    .all(HISTORICAL_DAILY_TARGET_TRADE_DAYS) as Array<{ trade_date: string; count: number }>
  const covered = rows.filter((row) => row.count >= HISTORICAL_DAILY_COMPLETE_ROW_THRESHOLD).length
  return { covered, target: HISTORICAL_DAILY_TARGET_TRADE_DAYS, hasTradeCal: false }
}

function buildConfigGroup(db: Database.Database, checkedAt: number): DiagnosticGroup {
  const dsConfig = getDataSourceConfig(db)
  const providers = getConfiguredProviders(db)
  const conceptSource = getConceptSource()
  const items: DiagnosticItem[] = []

  const hasTushare = !!(dsConfig.tushareEnabled && dsConfig.tushareTokenEncrypted)
  items.push({
    key: 'config.tushare',
    title: 'Tushare 配置',
    status: hasTushare ? 'ok' : 'warning',
    message: hasTushare ? 'Tushare 已启用且 Token 已保存' : '尚未启用或保存 Tushare Token',
    detail: '股票搜索、行情同步、短线策略、筹码和趋势评分依赖该配置。',
    checkedAt,
    actions: hasTushare ? [] : [{ key: 'open-datasource', label: '打开数据源配置', kind: 'navigate' }]
  })

  items.push({
    key: 'config.ai',
    title: 'AI 厂商配置',
    status: providers.length > 0 ? 'ok' : 'warning',
    message: providers.length > 0 ? `已配置 ${providers.length} 个 AI 厂商` : '尚未配置 AI API Key',
    detail: 'AI 分析、走势预测和产业链辅助归因需要至少一个可用厂商。',
    recordCount: providers.length,
    checkedAt,
    actions: providers.length > 0 ? [] : [{ key: 'open-ai-config', label: '打开 AI 配置', kind: 'navigate' }]
  })

  items.push({
    key: 'config.conceptSource',
    title: '当前题材源',
    status: 'ok',
    message: `当前题材源为 ${conceptSource.toUpperCase()}`,
    detail: '诊断中心会同时展示多路题材表状态, 实际业务以当前题材源为准。',
    checkedAt
  })

  return { key: 'config', title: '配置状态', items }
}

function buildFreshnessItem(db: Database.Database, spec: TableFreshnessSpec, checkedAt: number): DiagnosticItem {
  if (!tableExists(db, spec.table)) {
    return {
      key: `freshness.${spec.key}`,
      title: spec.title,
      status: 'error',
      message: `数据表 ${spec.table} 不存在`,
      detail: '请先确认数据库迁移是否正常完成。',
      recordCount: null,
      latestDate: null,
      checkedAt
    }
  }

  const recordCount = countRows(db, spec.table)
  let latestDate: string | null = null
  if (spec.dateColumn && columnExists(db, spec.table, spec.dateColumn)) {
    latestDate = toDateLike(getMaxValue(db, spec.table, spec.dateColumn))
  }

  let status: DiagnosticStatus = 'ok'
  let message = recordCount > 0 ? `已有 ${recordCount} 条记录` : '暂无本地数据'
  if (spec.key === 'stockBasic' && recordCount > 0 && recordCount < 4000) {
    status = 'warning'
    message = `股票基础数据仅 ${recordCount} 条, 尚未达到全市场基础数据规模。`
  }
  if (spec.key === 'dailyClose' && recordCount > 0) {
    const coverage = getHistoricalDailyCoverage(db)
    const sufficient = coverage.covered >= coverage.target
    if (sufficient) {
      message = `近 2 年日线底座已覆盖 ${coverage.covered}/${coverage.target} 个交易日, 可用于全市场扫描。`
    } else {
      status = 'warning'
      const hint = coverage.hasTradeCal ? '' : ', 交易日历不完整时按保守目标估算'
      message = `日线缓存已有 ${recordCount} 条记录, 但近 2 年完整交易日覆盖仅 ${coverage.covered}/${coverage.target}${hint}, 尚不足以支撑全市场扫描。`
    }
  }
  if (recordCount === 0) {
    status = 'warning'
  } else if (spec.staleDays && latestDate) {
    const age = daysSince(latestDate)
    if (age !== null && age > spec.staleDays) {
      status = 'warning'
      message = `${message} 最近数据为 ${latestDate}, 可能偏旧。`
    }
  }

  const actions: DiagnosticAction[] = []
  if (spec.key === 'stockBasic') actions.push({ key: 'syncStockBasic', label: '同步股票基础数据', kind: 'run' })
  if (spec.key === 'dailyClose') actions.push({ key: 'syncHistoricalDaily', label: '同步全市场历史日线', kind: 'run' })
  if (spec.key === 'kplConcept' || spec.key === 'thsConcept' || spec.key === 'dcConcept') {
    actions.push({ key: 'syncConceptMembers', label: '同步题材成分', kind: 'run' })
  }
  if (spec.key === 'decisionSignals') actions.push({ key: 'backfillDecisionSignals', label: '刷新今日看板信号', kind: 'run' })

  return {
    key: `freshness.${spec.key}`,
    title: spec.title,
    status,
    message,
    detail: spec.detail,
    recordCount,
    latestDate,
    checkedAt,
    actions
  }
}

function buildFreshnessGroup(db: Database.Database, checkedAt: number): DiagnosticGroup {
  return {
    key: 'freshness',
    title: '数据新鲜度',
    items: FRESHNESS_TABLES.map((spec) => buildFreshnessItem(db, spec, checkedAt))
  }
}

function buildSyncGroup(db: Database.Database, checkedAt: number): DiagnosticGroup {
  const dsConfig = getDataSourceConfig(db)
  const hasTushare = !!(dsConfig.tushareEnabled && dsConfig.tushareTokenEncrypted)
  const items: DiagnosticItem[] = [
    {
      key: 'sync.stockBasic',
      title: '股票基础数据同步',
      status: hasTushare ? 'ok' : 'warning',
      message: hasTushare ? '可手动触发同步' : '需要先配置 Tushare',
      detail: '新用户搜索股票名前需要先初始化股票基础数据。',
      checkedAt,
      actions: [{ key: 'syncStockBasic', label: '立即同步', kind: 'run' }]
    },
    {
      key: 'sync.historicalDaily',
      title: '全市场历史日线同步',
      status: hasTushare ? 'ok' : 'warning',
      message: hasTushare ? '可同步近 2 年全市场日线' : '需要先配置 Tushare',
      detail: '条件积木全市场扫描、策略回测和历史筛选依赖该本地底座。',
      checkedAt,
      actions: [{ key: 'syncHistoricalDaily', label: '立即同步', kind: 'run' }]
    },
    {
      key: 'sync.conceptMembers',
      title: '题材成分同步',
      status: hasTushare ? 'ok' : 'warning',
      message: hasTushare ? '可手动触发当前题材源同步' : '需要先配置 Tushare',
      detail: '题材源数据影响短线策略、产业链归因和板块联动展示。',
      checkedAt,
      actions: [{ key: 'syncConceptMembers', label: '立即同步', kind: 'run' }]
    },
    {
      key: 'sync.decisionBackfill',
      title: '今日看板补种',
      status: 'ok',
      message: '可手动刷新今日信号',
      detail: '补种会复用资讯、趋势、竞价、打板和板块资金等既有来源。',
      checkedAt,
      actions: [{ key: 'backfillDecisionSignals', label: '刷新信号', kind: 'run' }]
    }
  ]
  return { key: 'sync', title: '同步任务', items }
}

function buildDatabaseGroup(db: Database.Database, checkedAt: number): DiagnosticGroup {
  const rows = db.prepare('SELECT version, appliedAt FROM schema_migrations ORDER BY version DESC').all() as { version: number; appliedAt: number }[]
  const currentVersion = rows[0]?.version ?? 0
  const latestAppliedAt = rows[0]?.appliedAt ?? null
  return {
    key: 'database',
    title: '数据库状态',
    items: [
      {
        key: 'database.migrations',
        title: '数据库迁移',
        status: currentVersion > 0 ? 'ok' : 'warning',
        message: currentVersion > 0 ? `当前迁移版本 ${currentVersion}` : '尚未记录迁移版本',
        detail: '应用启动时会自动执行内联迁移; 若迁移失败, 主进程会在启动阶段提示并退出。',
        recordCount: rows.length,
        latestDate: toDateLike(latestAppliedAt),
        checkedAt
      }
    ]
  }
}

function buildDailyCloseQuality(
  db: Database.Database,
  suppliedQuality?: DailyCloseQualitySummary,
): DailyCloseQuality | undefined {
  if (!tableExists(db, 'daily_close_cache')) return undefined

  const quality = suppliedQuality ?? getDailyCloseQualitySummary(db)
  const maintenance = tableExists(db, 'daily_close_maintenance_state')
    ? getDailyCloseMaintenanceState(db)
    : null
  return {
    targetTradeDays: HISTORICAL_DAILY_TARGET_TRADE_DAYS,
    retentionTradeDays: DAILY_CLOSE_RETENTION_TRADE_DAYS,
    actualTradeDays: quality.actualTradeDays,
    totalRows: quality.totalRows,
    earliestTradeDate: quality.earliestTradeDate,
    latestTradeDate: quality.latestTradeDate,
    fields: quality.fields,
    cleanup: maintenance ?? {
      status: 'never',
      startedAt: null,
      completedAt: null,
      retainTradeDays: null,
      removedRows: null,
      remainingTradeDays: null,
      message: null,
    },
  }
}

export function getDiagnosticsHealth(db: Database.Database): DiagnosticsHealthSnapshot {
  const checkedAt = Date.now()
  const dailyCloseSummary = tableExists(db, 'daily_close_cache')
    ? getDailyCloseQualitySummary(db, getHistoricalDailyDefaultEndDate(checkedAt))
    : undefined
  const groups = [
    buildConfigGroup(db, checkedAt),
    buildFreshnessGroup(db, checkedAt),
    buildSyncGroup(db, checkedAt),
    buildDatabaseGroup(db, checkedAt)
  ]
  const items = groups.flatMap((group) => group.items)
  const summary: Record<DiagnosticStatus, number> = { ok: 0, warning: 0, error: 0 }
  for (const item of items) summary[item.status] += 1
  return {
    status: rankStatus(items.map((item) => item.status)),
    checkedAt,
    summary,
    groups,
    dailyCloseQuality: buildDailyCloseQuality(db, dailyCloseSummary),
    dataQuality: getDataQualitySnapshot(db, checkedAt, dailyCloseSummary),
  }
}

function ensureTushareConfigured(db: Database.Database): string {
  const cfg = getDataSourceConfig(db)
  if (!cfg.tushareEnabled || !cfg.tushareTokenEncrypted) {
    throw new Error('TUSHARE_DISABLED')
  }
  const token = decryptApiKey(cfg.tushareTokenEncrypted)
  if (!token) throw new Error('TUSHARE_DISABLED')
  return token
}

export async function runDiagnosticAction(db: Database.Database, action: DiagnosticRunAction, win?: BrowserWindow): Promise<DiagnosticRunResult> {
  switch (action) {
    case 'refreshHealth':
      getDiagnosticsHealth(db)
      return { action, status: 'completed', message: '诊断快照已刷新' }
    case 'refreshDataQuality': {
      const snapshot = persistDataQualitySnapshot(db)
      return {
        action,
        status: 'completed',
        message: `完整检查已保存：${snapshot.summary.reliable} 项可用，${snapshot.summary.degraded} 项需注意，${snapshot.summary.blocked} 项阻断`,
      }
    }
    case 'syncStockBasic':
      ensureTushareConfigured(db)
      await runStockBasicSyncJob()
      persistDataQualitySnapshot(db)
      return { action, status: 'completed', message: '股票基础数据同步完成' }
    case 'syncTradeCalendar': {
      const token = ensureTushareConfigured(db)
      const result = await syncTradeCalFull(db, token)
      persistDataQualitySnapshot(db)
      if (result.status === 'empty') throw new Error('TRADE_CAL_SYNC_EMPTY')
      if (result.status === 'failed') throw new Error('TRADE_CAL_SYNC_FAILED')
      return { action, status: 'completed', message: `交易日历同步完成，写入 ${result.rowCount} 条并重新检查` }
    }
    case 'syncHistoricalDaily': {
      const token = ensureTushareConfigured(db)
      const result = await runHistoricalDailySync(db, token, win)
      persistDataQualitySnapshot(db)
      const failedMessage = result.failedDates.length > 0 ? `, 失败 ${result.failedDates.length} 日` : ''
      return {
        action,
        status: 'completed',
        message: `全市场历史日线同步完成：区间 ${result.startDate ?? '—'}~${result.endDate ?? '—'}, 跳过 ${result.skippedTradeDays} 日, 同步 ${result.syncedTradeDays} 日, 写入 ${result.insertedRows} 行${failedMessage}`
      }
    }
    case 'syncMarketBenchmarks': {
      const token = ensureTushareConfigured(db)
      const endDate = getHistoricalDailyDefaultEndDate()
      let tradeDays = getLastNTradingDays(db, 60, endDate)
      if (tradeDays.length < 30) {
        await syncTradeCalFull(db, token)
        tradeDays = getLastNTradingDays(db, 60, endDate)
      }
      const startDate = tradeDays[0]
      if (!startDate) throw new Error('TRADE_CAL_HISTORY_INCOMPLETE')
      const rows = await fetchIndexDailyForCodes(token, [...CORE_BENCHMARK_CODES], startDate, endDate)
      if (rows.length === 0) throw new Error('BENCHMARK_SYNC_EMPTY')
      upsertDailyClose(db, rows)
      persistDataQualitySnapshot(db)
      return { action, status: 'completed', message: `核心基准同步完成，写入 ${rows.length} 条指数日线` }
    }
    case 'syncConceptMembers':
      ensureTushareConfigured(db)
      void runConceptMembersSyncJob()
      return { action, status: 'started', message: '已触发题材成分同步' }
    case 'backfillDecisionSignals':
      await ensureTodayDecisionSignalsBackfilled(db, true)
      return { action, status: 'completed', message: '今日看板信号已刷新' }
    default:
      throw new Error('INVALID_ACTION')
  }
}
