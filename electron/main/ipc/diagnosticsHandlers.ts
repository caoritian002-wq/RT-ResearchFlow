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
  const explicitCode = typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code ?? '')
    : ''
  const message = err instanceof Error ? err.message : String(err)
  const knownCodes = [
    'TUSHARE_DISABLED',
    'TUSHARE_QUOTA_INSUFFICIENT',
    'TUSHARE_RATE_LIMITED',
    'TUSHARE_AUTH_FAILED',
    'TUSHARE_REQUEST_TIMEOUT',
    'HISTORICAL_DAILY_UPSTREAM_UNAVAILABLE',
    'TRADE_CAL_HISTORY_INCOMPLETE',
    'TRADE_CAL_SYNC_EMPTY',
    'TRADE_CAL_SYNC_FAILED',
    'BENCHMARK_SYNC_EMPTY',
    'PUBLIC_PROVIDER_COOLDOWN',
    'PUBLIC_STOCK_UNIVERSE_INCOMPLETE',
    'PUBLIC_STOCK_UNIVERSE_INVALID_RESPONSE',
    'PUBLIC_STOCK_UNIVERSE_NOT_READY',
    'PUBLIC_DAILY_INVALID_TARGET_DATE',
  ]
  const matched = knownCodes.find(code => explicitCode === code || message.includes(code))
  if (matched) return matched
  if (message === 'HISTORICAL_DAILY_SYNC_RUNNING') return 'ALREADY_RUNNING'
  if (message === 'INVALID_ACTION') return 'INVALID_PARAM'
  return 'DIAGNOSTICS_FAILED'
}

function toErrorMessage(code: string): string {
  if (code === 'TUSHARE_DISABLED') return '请先启用并配置 Tushare'
  if (code === 'TUSHARE_QUOTA_INSUFFICIENT') return 'Tushare 权限或积分不足。任务已停止，不会继续重复请求；已完成日期已保留，可稍后重试或导入全市场基座包。'
  if (code === 'TUSHARE_RATE_LIMITED') return 'Tushare 触发访问频率限制。任务已停止，不会继续重复请求；已完成日期已保留，请稍后重试。'
  if (code === 'TUSHARE_AUTH_FAILED') return 'Tushare Token 无效或认证失败。任务已停止，请更新数据源配置后重试；已完成日期已保留。'
  if (code === 'TUSHARE_REQUEST_TIMEOUT') return 'Tushare 请求超时。任务已停止，不会继续遍历剩余交易日；已完成日期已保留，可稍后重试。'
  if (code === 'PUBLIC_PROVIDER_COOLDOWN') return '公共数据来源正在冷却，系统不会立即重试；已完成进度保留，请稍后继续。'
  if (code === 'PUBLIC_STOCK_UNIVERSE_INCOMPLETE') return '公共证券列表覆盖不足，本次未合并，原有本地证券数据保持不变。'
  if (code === 'PUBLIC_STOCK_UNIVERSE_INVALID_RESPONSE') return '公共证券列表返回格式异常，本次未写入任何证券身份。'
  if (code === 'PUBLIC_STOCK_UNIVERSE_NOT_READY') return '股票基础列表尚未准备完成，请等待证券列表后台同步后再启动历史日线。'
  if (code === 'PUBLIC_DAILY_INVALID_TARGET_DATE') return '公共历史日线目标日期无效，本次未启动。'
  if (code === 'HISTORICAL_DAILY_UPSTREAM_UNAVAILABLE') return '连续多个交易日未取得有效数据，任务已熔断，不会继续重复请求；已完成日期已保留，可稍后重试。'
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
