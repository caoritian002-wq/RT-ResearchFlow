import { BrowserWindow, ipcMain } from 'electron'
import { getDb } from '../database/db'
import { getDiagnosticsHealth, runDiagnosticAction, type DiagnosticRunAction } from '../services/diagnosticsService'

const ALLOWED_ACTIONS: DiagnosticRunAction[] = [
  'refreshHealth',
  'refreshDataQuality',
  'syncStockBasic',
  'syncTradeCalendar',
  'syncHistoricalDaily',
  'syncMarketBenchmarks',
  'syncConceptMembers',
  'backfillDecisionSignals'
]

function toErrorCode(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (message === 'TUSHARE_DISABLED') return 'TUSHARE_DISABLED'
  if (message === 'HISTORICAL_DAILY_SYNC_RUNNING') return 'ALREADY_RUNNING'
  if (message === 'TRADE_CAL_HISTORY_INCOMPLETE') return 'TRADE_CAL_HISTORY_INCOMPLETE'
  if (message === 'TRADE_CAL_SYNC_EMPTY') return 'TRADE_CAL_SYNC_EMPTY'
  if (message === 'TRADE_CAL_SYNC_FAILED') return 'TRADE_CAL_SYNC_FAILED'
  if (message === 'BENCHMARK_SYNC_EMPTY') return 'BENCHMARK_SYNC_EMPTY'
  if (message === 'INVALID_ACTION') return 'INVALID_PARAM'
  return 'DIAGNOSTICS_FAILED'
}

function toErrorMessage(code: string): string {
  if (code === 'TUSHARE_DISABLED') return '请先启用并配置 Tushare'
  if (code === 'ALREADY_RUNNING') return '全市场历史日线同步正在进行中'
  if (code === 'TRADE_CAL_HISTORY_INCOMPLETE') return '交易日历历史覆盖不足，请先补齐交易日历'
  if (code === 'TRADE_CAL_SYNC_EMPTY') return '交易日历接口暂未返回可用数据，本地已有数据保持不变'
  if (code === 'TRADE_CAL_SYNC_FAILED') return '交易日历同步失败，本地已有数据保持不变，请稍后重试'
  if (code === 'BENCHMARK_SYNC_EMPTY') return '核心基准接口暂未返回可用日线'
  if (code === 'INVALID_PARAM') return '诊断动作参数无效'
  return '诊断动作执行失败'
}

export function registerDiagnosticsHandlers(): void {
  ipcMain.handle('diagnostics:getHealth', () => {
    try {
      return { ok: true as const, data: getDiagnosticsHealth(getDb()) }
    } catch (err) {
      console.error('[diagnostics:getHealth] failed:', err)
      return { ok: false as const, error: 'DB_ERROR' as const, message: '诊断快照生成失败' }
    }
  })

  ipcMain.handle('diagnostics:runCheck', async (event, payload?: { action?: DiagnosticRunAction }) => {
    const action = payload?.action
    if (!action || !ALLOWED_ACTIONS.includes(action)) {
      return { ok: false as const, error: 'INVALID_PARAM' as const, message: '诊断动作参数无效' }
    }
    try {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      return { ok: true as const, data: await runDiagnosticAction(getDb(), action, win) }
    } catch (err) {
      console.error(`[diagnostics:runCheck] action=${action} failed:`, err)
      const code = toErrorCode(err)
      return { ok: false as const, error: code, message: toErrorMessage(code) }
    }
  })
}
