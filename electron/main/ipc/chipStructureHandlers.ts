import { ipcMain } from 'electron'
import { getDb } from '../database/db'
import { getMonitorStocks } from '../database/chipMonitorRepository'
import { getDataSourceConfig } from '../database/dataSourceRepository'
import type {
  ChipStructureCompletenessStatus,
  ChipStructureConsistencyStatus,
  ChipStructureSummary,
} from '../database/types'
import {
  getChipStructureDetail,
  getChipStructureSummaries,
  normalizeChipStructureTsCode,
  type ChipStructureSummarySelectionPolicy,
} from '../services/chipStructureService'
import { buildCompatibleChipStructureSummaries } from '../services/chipSummaryService'
import {
  getChipStructureSyncStatus,
  startChipStructureSync,
} from '../services/chipStructureSyncService'
import { decryptApiKey } from '../utils/apiKeyEncryption'
import { getAfterCloseScheduleStatus } from '../services/schedulerService'

type SourceFilter = 'all' | 'watchlist' | 'screener' | 'morningAuction' | 'portfolio'
type StatusFilter = 'all' | ChipStructureCompletenessStatus | ChipStructureConsistencyStatus

interface ListStocksPayload {
  source?: SourceFilter
  mode?: 'relative' | 'absolute'
  status?: StatusFilter
  search?: string
  limit?: number
  offset?: number
}

function errorPayload(code: string, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } }
}

export function validChipStructureDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(4, 6))
  const day = Number(value.slice(6, 8))
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

export function validateChipStructureTsCodes(value: unknown): {
  ok: true
  tsCodes: string[]
} | {
  ok: false
  errorCode: 'INVALID_PARAM' | 'TOO_MANY_STOCKS'
} {
  if (!Array.isArray(value) || value.length === 0 || value.some((code) => typeof code !== 'string')) {
    return { ok: false, errorCode: 'INVALID_PARAM' }
  }
  if (value.length > 500) return { ok: false, errorCode: 'TOO_MANY_STOCKS' }
  const normalizedCodes = value.map(normalizeChipStructureTsCode)
  if (normalizedCodes.some((code) => code == null)) return { ok: false, errorCode: 'INVALID_PARAM' }
  return { ok: true, tsCodes: [...new Set(normalizedCodes as string[])] }
}

function parseLimit(value: unknown, fallback: number, max: number): number | null {
  if (value == null) return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : null
}

function validSource(value: unknown): value is SourceFilter {
  return value === 'all' || value === 'watchlist' || value === 'screener'
    || value === 'morningAuction' || value === 'portfolio'
}

function validStatus(value: unknown): value is StatusFilter {
  return value === 'all' || value === 'complete' || value === 'partial' || value === 'blocked'
    || value === 'matched' || value === 'warning' || value === 'not_comparable'
}

function matchesStatus(summary: ChipStructureSummary, status: StatusFilter): boolean {
  return status === 'all'
    || summary.completenessStatus === status
    || summary.consistencyStatus === status
}

function sourcePriority(source: string): number {
  if (source === 'portfolio') return 1
  if (source === 'morningAuction') return 2
  if (source === 'screener') return 3
  return 4
}

export function dedupeChipStructureMonitorStocks(rows: ReturnType<typeof getMonitorStocks>) {
  const byCode = new Map<string, (typeof rows)[number] & { tsCode: string }>()
  for (const row of rows) {
    const tsCode = normalizeChipStructureTsCode(row.tsCode)
    if (!tsCode) continue
    const current = byCode.get(tsCode)
    if (!current
      || sourcePriority(row.source) < sourcePriority(current.source)
      || (sourcePriority(row.source) === sourcePriority(current.source) && row.addedAt > current.addedAt)) {
      byCode.set(tsCode, { ...row, tsCode })
    }
  }
  return [...byCode.values()]
}

export function registerChipStructureHandlers(): void {
  ipcMain.handle('chipStructure:listStocks', (_event, payload: ListStocksPayload = {}) => {
    try {
      const source = payload.source ?? 'all'
      const status = payload.status ?? 'all'
      const limit = parseLimit(payload.limit, 200, 500)
      const offset = parseLimit(payload.offset, 0, Number.MAX_SAFE_INTEGER)
      if (!validSource(source) || !validStatus(status) || limit == null || limit === 0 || offset == null) {
        return errorPayload('INVALID_PARAM', '查询参数无效')
      }
      const search = payload.search?.trim().toLowerCase() ?? ''
      const mode = payload.mode === 'absolute' ? 'absolute' : 'relative'
      void mode
      const db = getDb()
      const rows = dedupeChipStructureMonitorStocks(getMonitorStocks(db)).filter((stock) => (
        (source === 'all' || stock.source === source)
        && (!search || stock.tsCode.toLowerCase().includes(search) || stock.stockName?.toLowerCase().includes(search))
      ))
      const summaries = getChipStructureSummaries(db, rows.map((stock) => ({
        tsCode: stock.tsCode,
        stockName: stock.stockName,
      })))
      const summaryByCode = new Map(summaries.map((summary) => [summary.tsCode, summary]))
      const mapped = rows.map((stock) => ({
        ...stock,
        summary: summaryByCode.get(stock.tsCode)!,
      }))
      const statusCounts = mapped.reduce((counts, stock) => {
        counts[stock.summary.completenessStatus]++
        if (stock.summary.consistencyStatus === 'warning') counts.consistencyWarning++
        if (stock.summary.freshnessStatus === 'stale') counts.stale++
        return counts
      }, { complete: 0, partial: 0, blocked: 0, consistencyWarning: 0, stale: 0 })
      const filtered = mapped.filter((stock) => matchesStatus(stock.summary, status))
      const stocks = filtered.slice(offset, offset + limit)
      return { ok: true as const, stocks, total: filtered.length, statusCounts }
    } catch (error) {
      console.error('[chipStructure:listStocks] Query failed:', error)
      return errorPayload('DB_ERROR', '读取筹码结构股池失败')
    }
  })

  ipcMain.handle('chipStructure:getStockDetail', (_event, payload?: {
    tsCode?: unknown
    tradeDate?: unknown
    mode?: unknown
  }) => {
    try {
      if (typeof payload?.tsCode !== 'string') return errorPayload('INVALID_PARAM', '股票代码无效')
      const tsCode = normalizeChipStructureTsCode(payload.tsCode)
      if (!tsCode || (payload.tradeDate != null && !validChipStructureDate(payload.tradeDate))) {
        return errorPayload('INVALID_PARAM', '股票代码或交易日期无效')
      }
      const mode = payload.mode === 'absolute' ? 'absolute' : 'relative'
      const stockName = getMonitorStocks(getDb()).find((stock) => (
        normalizeChipStructureTsCode(stock.tsCode) === tsCode
      ))?.stockName ?? null
      return {
        ok: true as const,
        detail: getChipStructureDetail(getDb(), tsCode, payload.tradeDate as string | undefined, mode, stockName),
      }
    } catch (error) {
      console.error('[chipStructure:getStockDetail] Query failed:', error)
      return errorPayload('DB_ERROR', '读取筹码结构详情失败')
    }
  })

  ipcMain.handle('chipStructure:getSummaries', (_event, payload?: {
    tsCodes?: unknown
    tradeDate?: unknown
    referenceTradeDate?: unknown
    selectionPolicy?: unknown
  }) => {
    try {
      const input = payload ?? {}
      const validation = validateChipStructureTsCodes(input.tsCodes)
      if (!validation.ok) {
        const message = validation.errorCode === 'TOO_MANY_STOCKS'
          ? '单次最多查询 500 只股票'
          : '股票代码列表无效'
        return errorPayload(validation.errorCode, message)
      }
      if (input.tradeDate != null && !validChipStructureDate(input.tradeDate)) {
        return errorPayload('INVALID_PARAM', '交易日期无效')
      }
      if (input.referenceTradeDate != null && !validChipStructureDate(input.referenceTradeDate)) {
        return errorPayload('INVALID_PARAM', '业务参考日期无效')
      }
      if (input.selectionPolicy != null
        && input.selectionPolicy !== 'latest_fact'
        && input.selectionPolicy !== 'latest_complete') {
        return errorPayload('INVALID_PARAM', '筹码摘要选择策略无效')
      }
      return {
        ok: true as const,
        summaries: buildCompatibleChipStructureSummaries(
          getDb(),
          validation.tsCodes.map((tsCode) => ({ tsCode })),
          input.tradeDate as string | undefined,
          input.referenceTradeDate as string | undefined,
          'relative',
          input.selectionPolicy as ChipStructureSummarySelectionPolicy | undefined,
        ),
      }
    } catch (error) {
      console.error('[chipStructure:getSummaries] Query failed:', error)
      return errorPayload('DB_ERROR', '批量读取筹码结构摘要失败')
    }
  })

  ipcMain.handle('chipStructure:refresh', (event, payload?: {
    tsCodes?: unknown
    tradeDate?: unknown
    scope?: unknown
    force?: unknown
  }) => {
    if (payload?.scope != null
      && payload.scope !== 'structure'
      && payload.scope !== 'institution'
      && payload.scope !== 'all') {
      return errorPayload('INVALID_PARAM', '同步范围无效')
    }
    if (payload?.tradeDate != null && !validChipStructureDate(payload.tradeDate)) {
      return errorPayload('INVALID_PARAM', '交易日期无效')
    }
    if (payload && 'force' in payload && typeof payload.force !== 'boolean') {
      return errorPayload('INVALID_PARAM', '强制刷新参数无效')
    }
    let tsCodes: string[] | undefined
    if (payload && 'tsCodes' in payload) {
      const validation = validateChipStructureTsCodes(payload.tsCodes)
      if (!validation.ok) {
        const message = validation.errorCode === 'TOO_MANY_STOCKS'
          ? '单次最多同步 500 只股票'
          : '股票代码列表无效'
        return errorPayload(validation.errorCode, message)
      }
      tsCodes = validation.tsCodes
    }
    try {
      const db = getDb()
      const config = getDataSourceConfig(db)
      if (!config.tushareEnabled || !config.tushareTokenEncrypted) {
        return errorPayload('TUSHARE_DISABLED', 'Tushare 数据源未启用')
      }
      const token = decryptApiKey(config.tushareTokenEncrypted)
      if (!token) return errorPayload('TUSHARE_DISABLED', 'Tushare Token 不可用')
      const result = startChipStructureSync(db, token, {
        tsCodes,
        tradeDate: payload?.tradeDate as string | undefined,
        scope: payload?.scope as 'structure' | 'institution' | 'all' | undefined,
        force: payload?.force === true,
        webContents: event.sender,
      })
      return { ok: true as const, started: true as const, ...result }
    } catch (error) {
      const code = error instanceof Error ? error.message : 'INVALID_PARAM'
      if (code === 'JOB_RUNNING') return errorPayload(code, '筹码结构同步任务正在运行')
      if (code === 'EMPTY_STOCK_POOL') return errorPayload(code, '当前筹码监控股池为空')
      return errorPayload('INVALID_PARAM', '无法启动筹码结构同步')
    }
  })

  ipcMain.handle('chipStructure:getSyncStatus', () => ({
    ok: true as const,
    status: getChipStructureSyncStatus(),
    schedule: getAfterCloseScheduleStatus(),
  }))
}
