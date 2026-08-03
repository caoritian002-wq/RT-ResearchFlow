import { ipcMain } from 'electron'
import { getDb } from '../database/db'
import {
  deleteStrategyLabStrategy,
  duplicateStrategyLabStrategy,
  ensureDefaultStrategyLabStrategies,
  getStrategyLabStrategy,
  listStrategyLabStrategies,
  saveStrategyLabStrategy,
  setStrategyLabStrategyEnabled,
  type SaveStrategyLabStrategyRequest,
} from '../services/strategyLabService'
import {
  cancelStrategyLabRun,
  createBacktestFromStrategyLabRun,
  getStrategyLabMatchEvidence,
  getStrategyLabRun,
  listStrategyLabMatches,
  listStrategyLabRuns,
  runStrategyLabStrategy,
} from '../services/strategyLabRunService'
import type { StrategyLabStrategySource } from '../database/types'
import type { TradePlan } from '../services/backtest/types'

function parsePositiveInt(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(num) && num > 0 ? num : null
}

function parseSource(value: unknown): StrategyLabStrategySource | undefined {
  return value === 'screener' || value === 'conditionBlocks' || value === 'custom' ? value : undefined
}

function errorPayload(err: unknown, fallback: string): { ok: false; error: string; code: string } {
  const message = err instanceof Error ? err.message : String(err)
  return { ok: false, error: message, code: message || fallback }
}

export function registerStrategyLabHandlers(getMainWindow?: () => Electron.BrowserWindow | null): void {
  try {
    ensureDefaultStrategyLabStrategies(getDb())
  } catch (err) {
    console.warn('[StrategyLab] 初始化内置模板失败:', err instanceof Error ? err.message : String(err))
  }

  ipcMain.handle('strategyLab:listStrategies', () => {
    try {
      return { ok: true as const, strategies: listStrategyLabStrategies(getDb()) }
    } catch (err) {
      return errorPayload(err, 'QUERY_FAILED')
    }
  })

  ipcMain.handle('strategyLab:getStrategy', (_event, payload: { id?: unknown }) => {
    try {
      const id = parsePositiveInt(payload?.id)
      if (!id) return { ok: false as const, error: 'INVALID_PARAM', code: 'INVALID_PARAM' }
      const strategy = getStrategyLabStrategy(getDb(), id)
      if (!strategy) return { ok: false as const, error: 'STRATEGY_NOT_FOUND', code: 'NOT_FOUND' }
      return { ok: true as const, strategy }
    } catch (err) {
      return errorPayload(err, 'QUERY_FAILED')
    }
  })

  ipcMain.handle('strategyLab:saveStrategy', (_event, payload: SaveStrategyLabStrategyRequest) => {
    try {
      if (!payload?.name || !parseSource(payload.source)) {
        return { ok: false as const, error: 'INVALID_PARAM', code: 'INVALID_PARAM' }
      }
      const strategy = saveStrategyLabStrategy(getDb(), payload)
      return { ok: true as const, strategy }
    } catch (err) {
      return errorPayload(err, 'SAVE_FAILED')
    }
  })

  ipcMain.handle('strategyLab:duplicateStrategy', (_event, payload: { id?: unknown; name?: string }) => {
    try {
      const id = parsePositiveInt(payload?.id)
      if (!id) return { ok: false as const, error: 'INVALID_PARAM', code: 'INVALID_PARAM' }
      const strategy = duplicateStrategyLabStrategy(getDb(), id, payload?.name)
      return { ok: true as const, strategy }
    } catch (err) {
      return errorPayload(err, 'DUPLICATE_FAILED')
    }
  })

  ipcMain.handle('strategyLab:deleteStrategy', (_event, payload: { id?: unknown }) => {
    try {
      const id = parsePositiveInt(payload?.id)
      if (!id) return { ok: false as const, error: 'INVALID_PARAM', code: 'INVALID_PARAM' }
      deleteStrategyLabStrategy(getDb(), id)
      return { ok: true as const }
    } catch (err) {
      return errorPayload(err, 'DELETE_FAILED')
    }
  })

  ipcMain.handle('strategyLab:setStrategyEnabled', (_event, payload: { id?: unknown; enabled?: unknown }) => {
    try {
      const id = parsePositiveInt(payload?.id)
      if (!id || typeof payload?.enabled !== 'boolean') return { ok: false as const, error: 'INVALID_PARAM', code: 'INVALID_PARAM' }
      const strategy = setStrategyLabStrategyEnabled(getDb(), id, payload.enabled)
      return { ok: true as const, strategy }
    } catch (err) {
      return errorPayload(err, 'SAVE_FAILED')
    }
  })

  ipcMain.handle('strategyLab:runStrategy', async (event, payload: { strategyId?: unknown }) => {
    try {
      const strategyId = parsePositiveInt(payload?.strategyId)
      if (!strategyId) return { ok: false as const, error: 'INVALID_PARAM', code: 'INVALID_PARAM' }
      const webContents = getMainWindow?.()?.webContents ?? event.sender
      const result = await runStrategyLabStrategy(getDb(), strategyId, webContents)
      return { ok: true as const, ...result }
    } catch (err) {
      return errorPayload(err, 'RUN_FAILED')
    }
  })

  ipcMain.handle('strategyLab:listRuns', (_event, payload?: { strategyId?: unknown; limit?: unknown }) => {
    try {
      const strategyId = parsePositiveInt(payload?.strategyId)
      const limit = parsePositiveInt(payload?.limit) ?? 20
      return { ok: true as const, runs: listStrategyLabRuns(getDb(), strategyId ?? undefined, limit) }
    } catch (err) {
      return errorPayload(err, 'QUERY_FAILED')
    }
  })

  ipcMain.handle('strategyLab:getRun', (_event, payload: { runId?: unknown }) => {
    try {
      const runId = parsePositiveInt(payload?.runId)
      if (!runId) return { ok: false as const, error: 'INVALID_PARAM', code: 'INVALID_PARAM' }
      const run = getStrategyLabRun(getDb(), runId)
      if (!run) return { ok: false as const, error: 'RUN_NOT_FOUND', code: 'NOT_FOUND' }
      return { ok: true as const, run }
    } catch (err) {
      return errorPayload(err, 'QUERY_FAILED')
    }
  })

  ipcMain.handle('strategyLab:listMatches', (_event, payload?: { runId?: unknown; strategyId?: unknown; query?: string; source?: unknown; minScore?: unknown; limit?: unknown; offset?: unknown }) => {
    try {
      const minScore = payload?.minScore == null ? undefined : Number(payload.minScore)
      return {
        ok: true as const,
        matches: listStrategyLabMatches(getDb(), {
          runId: parsePositiveInt(payload?.runId) ?? undefined,
          strategyId: parsePositiveInt(payload?.strategyId) ?? undefined,
          query: payload?.query,
          source: parseSource(payload?.source),
          minScore: Number.isFinite(minScore) ? minScore : undefined,
          limit: parsePositiveInt(payload?.limit) ?? 100,
          offset: Math.max(0, Number(payload?.offset) || 0),
        }),
      }
    } catch (err) {
      return errorPayload(err, 'QUERY_FAILED')
    }
  })

  ipcMain.handle('strategyLab:getMatchEvidence', (_event, payload: { matchId?: unknown }) => {
    try {
      const matchId = parsePositiveInt(payload?.matchId)
      if (!matchId) return { ok: false as const, error: 'INVALID_PARAM', code: 'INVALID_PARAM' }
      const result = getStrategyLabMatchEvidence(getDb(), matchId)
      if (!result) return { ok: false as const, error: 'MATCH_NOT_FOUND', code: 'NOT_FOUND' }
      return { ok: true as const, ...result }
    } catch (err) {
      return errorPayload(err, 'QUERY_FAILED')
    }
  })

  ipcMain.handle('strategyLab:cancelRun', (_event, payload?: { runId?: unknown }) => {
    try {
      const cancelled = cancelStrategyLabRun(getDb(), parsePositiveInt(payload?.runId) ?? undefined)
      if (!cancelled) return { ok: false as const, error: 'NO_RUNNING_RUN', code: 'NO_RUNNING_RUN' }
      return { ok: true as const, cancelled: true }
    } catch (err) {
      return errorPayload(err, 'CANCEL_FAILED')
    }
  })

  ipcMain.handle('strategyLab:createBacktestFromRun', (_event, payload: { runId?: unknown; plan?: Partial<TradePlan> }) => {
    try {
      const runId = parsePositiveInt(payload?.runId)
      if (!runId) return { ok: false as const, error: 'INVALID_PARAM', code: 'INVALID_PARAM' }
      const result = createBacktestFromStrategyLabRun(getDb(), runId, payload?.plan)
      return { ok: true as const, ...result }
    } catch (err) {
      return errorPayload(err, 'BACKTEST_FAILED')
    }
  })
}
