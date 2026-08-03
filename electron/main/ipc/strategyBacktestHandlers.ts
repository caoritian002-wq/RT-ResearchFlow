import { ipcMain } from 'electron'
import { getDb } from '../database/db'
import { deleteRun, getRun, getTrades, listRuns, parseStoredBacktestReport } from '../database/strategyBacktestRepository'
import { runStrategyBacktest } from '../services/backtest/strategyBacktestEngine'
import { evaluateStrategySignals } from '../services/backtest/strategyEffectivenessService'
import type { BacktestSignalSource, StrategyBacktestProgress, TradePlan } from '../services/backtest/types'

function parseYmd(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return /^\d{8}$/.test(value) ? value : null
}

function parseStrategyKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 120) return null
  if (!/^[A-Za-z0-9_.*-]+$/.test(trimmed)) return null
  return trimmed
}

function parseSignalSource(value: unknown): BacktestSignalSource | null {
  if (value == null || value === '') return 'shortTerm'
  return value === 'shortTerm' || value === 'trendAlerts' || value === 'decisionSignals' ? value : null
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(num) && num > 0 ? num : fallback
}

function parseNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

function parseTradePlan(value: unknown): TradePlan {
  const raw = (value && typeof value === 'object') ? value as Partial<TradePlan> : {}
  const entryRule = raw.entryRule === 'signalClose' ? 'signalClose' : 'nextOpen'
  return {
    entryRule,
    holdDays: parsePositiveInt(raw.holdDays, 1),
    stopProfit: parseNullableNumber(raw.stopProfit ?? raw.takeProfitPct),
    stopLoss: parseNullableNumber(raw.stopLoss ?? raw.stopLossPct),
    feeBps: Math.max(0, parseNullableNumber(raw.feeBps) ?? 13),
  }
}

function parseRunId(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(num) && num > 0 ? num : null
}

function parseStrategyIds(value: unknown): string[] | undefined | null {
  if (value == null) return undefined
  if (!Array.isArray(value) || value.length > 20) return null
  const ids: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    const trimmed = item.trim()
    if (!trimmed || trimmed.length > 120 || !/^[A-Za-z0-9_.-]+$/.test(trimmed)) return null
    if (!ids.includes(trimmed)) ids.push(trimmed)
  }
  return ids
}

export function registerStrategyBacktestHandlers(): void {
  ipcMain.handle('strategyBacktest:evaluateSignals', (_event, payload?: { dateStart?: unknown; dateEnd?: unknown; strategyIds?: unknown; excludeUntradeable?: unknown }) => {
    try {
      const dateStart = parseYmd(payload?.dateStart)
      const dateEnd = parseYmd(payload?.dateEnd)
      const strategyIds = parseStrategyIds(payload?.strategyIds)
      if (!dateStart || !dateEnd || dateStart > dateEnd || strategyIds === null || strategyIds?.length === 0) {
        return { ok: false, error: 'INVALID_PARAM', message: '策略评估参数无效' }
      }
      return {
        ok: true,
        data: evaluateStrategySignals(getDb(), {
          dateStart,
          dateEnd,
          strategyIds,
          excludeUntradeable: payload?.excludeUntradeable !== false,
        }),
      }
    } catch (err) {
      console.error('[strategyBacktest:evaluateSignals] failed:', err)
      return { ok: false, error: 'EVALUATION_FAILED', message: '策略信号评估失败，请稍后重试' }
    }
  })

  ipcMain.handle('strategyBacktest:run', (event, payload: { signalSource?: unknown; strategyKey?: unknown; dateStart?: unknown; dateEnd?: unknown; plan?: unknown; force?: unknown }) => {
    try {
      const signalSource = parseSignalSource(payload?.signalSource)
      const strategyKey = parseStrategyKey(payload?.strategyKey)
      const dateStart = parseYmd(payload?.dateStart)
      const dateEnd = parseYmd(payload?.dateEnd)
      if (!signalSource || !strategyKey || !dateStart || !dateEnd || dateStart > dateEnd) {
        return { ok: false, error: 'INVALID_PARAM', message: '回测参数无效' }
      }

      const result = runStrategyBacktest(getDb(), {
        signalSource,
        strategyKey,
        dateStart,
        dateEnd,
        plan: parseTradePlan(payload?.plan),
        force: payload?.force === true,
        onProgress: (progress: StrategyBacktestProgress) => {
          event.sender.send('strategyBacktest:progress', progress)
        },
      })
      return { ok: true, data: result }
    } catch (err) {
      return { ok: false, error: 'BACKTEST_FAILED', message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('strategyBacktest:getReport', (_event, payload: { runId?: unknown }) => {
    try {
      const runId = parseRunId(payload?.runId)
      if (!runId) return { ok: false, error: 'INVALID_PARAM', message: 'runId 无效' }
      const run = getRun(getDb(), runId)
      if (!run) return { ok: false, error: 'NOT_FOUND', message: '回测记录不存在' }
      if (run.status !== 'completed') return { ok: false, error: 'RUN_NOT_COMPLETED', message: run.errorMessage ?? '回测未完成' }
      const report = parseStoredBacktestReport(run.reportJson)
      return report
        ? { ok: true, data: { runId, report, run } }
        : { ok: false, error: 'INVALID_REPORT', message: '回测报告解析失败' }
    } catch (err) {
      return { ok: false, error: 'QUERY_FAILED', message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('strategyBacktest:listRuns', (_event, payload?: { strategyKey?: unknown; signalSource?: unknown }) => {
    try {
      const signalSource = parseSignalSource(payload?.signalSource)
      const strategyKey = payload?.strategyKey == null || payload.strategyKey === '' ? undefined : parseStrategyKey(payload.strategyKey)
      if (!signalSource) return { ok: false, error: 'INVALID_PARAM', message: 'signalSource 无效' }
      if (payload?.strategyKey && !strategyKey) return { ok: false, error: 'INVALID_PARAM', message: 'strategyKey 无效' }
      return { ok: true, data: { runs: listRuns(getDb(), strategyKey ?? undefined, signalSource) } }
    } catch (err) {
      return { ok: false, error: 'QUERY_FAILED', message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('strategyBacktest:getTrades', (_event, payload: { runId?: unknown }) => {
    try {
      const runId = parseRunId(payload?.runId)
      if (!runId) return { ok: false, error: 'INVALID_PARAM', message: 'runId 无效' }
      const run = getRun(getDb(), runId)
      if (!run) return { ok: false, error: 'NOT_FOUND', message: '回测记录不存在' }
      if (run.status !== 'completed') return { ok: false, error: 'RUN_NOT_COMPLETED', message: run.errorMessage ?? '回测未完成' }
      return { ok: true, data: { trades: getTrades(getDb(), runId) } }
    } catch (err) {
      return { ok: false, error: 'QUERY_FAILED', message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('strategyBacktest:deleteRun', (_event, payload: { runId?: unknown }) => {
    try {
      const runId = parseRunId(payload?.runId)
      if (!runId) return { ok: false, error: 'INVALID_PARAM', message: 'runId 无效' }
      if (!deleteRun(getDb(), runId)) {
        return { ok: false, error: 'NOT_FOUND', message: '回测记录不存在或已被删除' }
      }
      return { ok: true, data: { runId } }
    } catch (err) {
      console.error('[strategyBacktest:deleteRun] failed:', err)
      return { ok: false, error: 'DELETE_FAILED', message: '删除回测记录失败，请稍后重试' }
    }
  })
}
