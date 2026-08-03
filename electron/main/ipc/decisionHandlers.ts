import { ipcMain } from 'electron'
import { getDb } from '../database/db'
import {
  dismissDecisionSignal,
  getDecisionSignalSummary,
  getDecisionSignalTimeline,
  getTodayDecisionSignalContext,
  markDecisionSignalRead,
  resolveDecisionSignal,
  watchDecisionSignal,
} from '../services/decisionSignalService'
import { ensureTodayDecisionSignalsBackfilled } from '../services/decisionSignalBackfillService'
import { getDecisionHistorySignals, getDecisionPortfolioRiskReview, getDecisionReviewStats } from '../services/decisionReviewStatsService'
import { getDecisionOutcomeMemory } from '../services/decisionOutcomeMemory'
import {
  DecisionReviewReportRepositoryError,
  deleteReviewReport,
  getReviewReport,
  listReviewReports,
  saveReviewReport,
} from '../database/decisionReviewReportRepository'
import {
  getDecisionJudgment,
  listDecisionJudgments,
  type ListDecisionJudgmentsInput,
  type SaveDecisionJudgmentInput,
} from '../database/decisionJudgmentRepository'
import {
  isDecisionJudgmentExpectedError,
  saveDecisionJudgment,
} from '../services/decisionJudgmentService'
import {
  completeDecisionJudgmentFollowUp,
  isDecisionJudgmentFollowUpExpectedError,
  type CompleteDecisionJudgmentFollowUpInput,
} from '../services/decisionJudgmentFollowUpService'
import {
  listDueDecisionJudgmentFollowUps,
  type ListDueDecisionJudgmentFollowUpsInput,
} from '../database/decisionJudgmentFollowUpRepository'
import type {
  DecisionReviewReportKind,
  DecisionSignalResolution,
  DecisionSignalSourceModule,
  DecisionSignalStatus,
  DecisionSignalType,
} from '../database/types'
import type Database from 'better-sqlite3'

interface SignalQueryPayload {
  sourceModules?: DecisionSignalSourceModule[]
  statuses?: DecisionSignalStatus[]
  types?: DecisionSignalType[]
  minPriority?: number
  tsCode?: string
  conceptCode?: string
  limit?: number
  portfolioOnly?: boolean
}

interface ReviewStatsPayload {
  rangeDays?: number
  sourceModules?: DecisionSignalSourceModule[]
  types?: DecisionSignalType[]
  statuses?: DecisionSignalStatus[]
  tsCode?: string
  portfolioOnly?: boolean
  offset?: number
  limit?: number
  tradeDate?: string
}

interface OutcomeMemoryPayload {
  rangeDays?: number
  horizonDays?: number
  portfolioOnly?: boolean
  limit?: number
}

interface SaveReviewReportPayload {
  requestId?: unknown
  periodStart?: unknown
  periodEnd?: unknown
  report?: unknown
}

interface ListReviewReportsPayload {
  kind?: DecisionReviewReportKind
  periodStart?: string
  periodEnd?: string
  includeAllVersions?: boolean
  offset?: number
  limit?: number
}

const DECISION_CHANNELS = [
  'decision:getTodaySignals',
  'decision:getSignalSummary',
  'decision:markRead',
  'decision:watch',
  'decision:dismiss',
  'decision:resolve',
  'decision:getTimeline',
  'decision:getReviewStats',
  'decision:getHistorySignals',
  'decision:getPortfolioRiskReview',
  'decision:getOutcomeMemory',
  'decision:saveReviewReport',
  'decision:listReviewReports',
  'decision:getReviewReport',
  'decision:deleteReviewReport',
  'decision:saveJudgment',
  'decision:listJudgments',
  'decision:getJudgment',
  'decision:listDueJudgmentFollowUps',
  'decision:completeJudgmentFollowUp',
] as const

export function registerDecisionHandlers(): void {
  // 开发热重载时避免 "Attempted to register a second handler"
  for (const channel of DECISION_CHANNELS) {
    ipcMain.removeHandler(channel)
  }

  ipcMain.handle('decision:getTodaySignals', async (_event, payload: SignalQueryPayload = {}) => {
    try {
      const db = getDb()
      await ensureTodayDecisionSignalsBackfilled(db)
      const result = getTodayDecisionSignalContext(db, normalizeQueryPayload(payload))
      return { ok: true, ...result }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: 'DB_ERROR', message: msg }
    }
  })

  ipcMain.handle('decision:getSignalSummary', async () => {
    try {
      const db = getDb()
      await ensureTodayDecisionSignalsBackfilled(db)
      return { ok: true, data: getDecisionSignalSummary(db) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: 'DB_ERROR', message: msg }
    }
  })

  ipcMain.handle('decision:markRead', (_event, { id }: { id: number }) => updateStatus(id, markDecisionSignalRead))
  ipcMain.handle('decision:watch', (_event, { id }: { id: number }) => updateStatus(id, watchDecisionSignal))
  ipcMain.handle('decision:dismiss', (_event, payload: { id: number; reason?: string; note?: string }) => updateStatus(
    payload.id,
    (db, id) => dismissDecisionSignal(db, id, normalizeOptionalText(payload.reason), normalizeOptionalText(payload.note))
  ))
  ipcMain.handle('decision:resolve', (_event, payload: { id: number; resolution: DecisionSignalResolution; note?: string }) => {
    const resolution = normalizeResolution(payload.resolution)
    if (!resolution) return { ok: false, error: 'INVALID_PARAM', message: 'invalid resolution' }
    return updateStatus(payload.id, (db, id) => resolveDecisionSignal(db, id, resolution, normalizeOptionalText(payload.note)))
  })
  ipcMain.handle('decision:getTimeline', (_event, { id }: { id: number }) => {
    try {
      if (!Number.isInteger(id) || id <= 0) {
        return { ok: false, error: 'INVALID_PARAM', message: 'id must be positive integer' }
      }
      const events = getDecisionSignalTimeline(getDb(), id)
      if (!events) return { ok: false, error: 'NOT_FOUND', message: `decision signal ${id} not found` }
      return { ok: true, data: events }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: 'DB_ERROR', message: msg }
    }
  })

  ipcMain.handle('decision:getReviewStats', (_event, payload: ReviewStatsPayload = {}) => {
    try {
      const normalized = normalizeReviewStatsPayload(payload)
      return { ok: true, data: getDecisionReviewStats(getDb(), normalized) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: 'DB_ERROR', message: msg }
    }
  })

  ipcMain.handle('decision:getHistorySignals', (_event, payload: ReviewStatsPayload = {}) => {
    try {
      const normalized = normalizeReviewStatsPayload(payload)
      return { ok: true, data: getDecisionHistorySignals(getDb(), normalized) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: 'DB_ERROR', message: msg }
    }
  })

  ipcMain.handle('decision:getPortfolioRiskReview', (_event, payload: ReviewStatsPayload = {}) => {
    try {
      const normalized = normalizeReviewStatsPayload(payload)
      return { ok: true, data: getDecisionPortfolioRiskReview(getDb(), normalized) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: 'DB_ERROR', message: msg }
    }
  })

  // FR-234: 决策事后对照只读聚合
  ipcMain.handle('decision:getOutcomeMemory', (_event, payload: OutcomeMemoryPayload = {}) => {
    try {
      const rangeDays = payload.rangeDays == null ? 30 : Math.max(7, Math.min(90, Math.round(payload.rangeDays)))
      const horizonDays = payload.horizonDays === 3 ? 3 : 5
      const limit = payload.limit == null ? 50 : Math.max(1, Math.min(100, Math.round(payload.limit)))
      const portfolioOnly = payload.portfolioOnly !== false
      const data = getDecisionOutcomeMemory(getDb(), {
        rangeDays,
        horizonDays,
        limit,
        portfolioOnly,
      })
      return { ok: true, data }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: 'DB_ERROR', message: msg }
    }
  })

  ipcMain.handle('decision:saveReviewReport', (_event, payload: SaveReviewReportPayload = {}) => {
    return handleReviewReportRepositoryCall(() => saveReviewReport(getDb(), {
      requestId: payload.requestId as string,
      periodStart: payload.periodStart as string,
      periodEnd: payload.periodEnd as string,
      report: payload.report,
    }))
  })

  ipcMain.handle('decision:listReviewReports', (_event, payload: ListReviewReportsPayload = {}) => {
    return handleReviewReportRepositoryCall(() => listReviewReports(getDb(), payload))
  })

  ipcMain.handle('decision:getReviewReport', (_event, payload: { id?: unknown } = {}) => {
    return handleReviewReportRepositoryCall(() => getReviewReport(getDb(), payload.id as string))
  })

  ipcMain.handle('decision:deleteReviewReport', (_event, payload: { id?: unknown } = {}) => {
    return handleReviewReportRepositoryCall(() => deleteReviewReport(getDb(), payload.id as string))
  })

  ipcMain.handle('decision:saveJudgment', (_event, payload: SaveDecisionJudgmentInput) => {
    return handleJudgmentCall(() => saveDecisionJudgment(getDb(), payload))
  })

  ipcMain.handle('decision:listJudgments', (_event, payload: ListDecisionJudgmentsInput = {}) => {
    return handleJudgmentCall(() => listDecisionJudgments(getDb(), payload))
  })

  ipcMain.handle('decision:getJudgment', (_event, payload: { id?: unknown } = {}) => {
    return handleJudgmentCall(() => getDecisionJudgment(getDb(), payload.id as string))
  })

  ipcMain.handle('decision:listDueJudgmentFollowUps', (_event, payload: ListDueDecisionJudgmentFollowUpsInput = {}) => {
    return handleJudgmentCall(() => listDueDecisionJudgmentFollowUps(getDb(), payload))
  })

  ipcMain.handle('decision:completeJudgmentFollowUp', (_event, payload: CompleteDecisionJudgmentFollowUpInput) => {
    return handleJudgmentCall(() => completeDecisionJudgmentFollowUp(getDb(), payload))
  })
}

function handleJudgmentCall<T>(fn: () => T): {
  ok: boolean
  data?: T
  error?: string
  message?: string
} {
  try {
    return { ok: true, data: fn() }
  } catch (err) {
    if (isDecisionJudgmentExpectedError(err) || isDecisionJudgmentFollowUpExpectedError(err)) {
      return { ok: false, error: err.code, message: err.message }
    }
    return { ok: false, error: 'DB_ERROR', message: '判断账本暂时不可用，请稍后重试' }
  }
}

function handleReviewReportRepositoryCall<T>(fn: () => T): {
  ok: boolean
  data?: T
  error?: string
  message?: string
} {
  try {
    return { ok: true, data: fn() }
  } catch (err) {
    if (err instanceof DecisionReviewReportRepositoryError) {
      return { ok: false, error: err.code, message: err.message }
    }
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: 'DB_ERROR', message }
  }
}

function updateStatus(
  id: number,
  fn: (db: Database.Database, id: number) => unknown
): { ok: boolean; data?: unknown; error?: string; message?: string } {
  try {
    if (!Number.isInteger(id) || id <= 0) {
      return { ok: false, error: 'INVALID_PARAM', message: 'id must be positive integer' }
    }
    const signal = fn(getDb(), id)
    if (!signal) return { ok: false, error: 'NOT_FOUND', message: `decision signal ${id} not found` }
    return { ok: true, data: signal }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: 'DB_ERROR', message: msg }
  }
}

function normalizeQueryPayload(payload: SignalQueryPayload): SignalQueryPayload {
  return {
    sourceModules: Array.isArray(payload.sourceModules) ? payload.sourceModules : undefined,
    statuses: Array.isArray(payload.statuses) ? payload.statuses : undefined,
    types: Array.isArray(payload.types) ? payload.types : undefined,
    minPriority: payload.minPriority == null ? undefined : Math.max(1, Math.min(5, Math.round(payload.minPriority))),
    tsCode: typeof payload.tsCode === 'string' && payload.tsCode.trim() ? payload.tsCode.trim() : undefined,
    conceptCode: typeof payload.conceptCode === 'string' && payload.conceptCode.trim() ? payload.conceptCode.trim() : undefined,
    limit: payload.limit == null ? undefined : Math.max(1, Math.min(500, Math.round(payload.limit))),
    portfolioOnly: payload.portfolioOnly === true,
  }
}

function normalizeReviewStatsPayload(payload: ReviewStatsPayload): ReviewStatsPayload {
  return {
    rangeDays: payload.rangeDays == null ? 30 : Math.max(1, Math.min(180, Math.round(payload.rangeDays))),
    sourceModules: Array.isArray(payload.sourceModules) ? payload.sourceModules : undefined,
    types: Array.isArray(payload.types) ? payload.types : undefined,
    statuses: Array.isArray(payload.statuses) ? payload.statuses : undefined,
    tsCode: typeof payload.tsCode === 'string' && payload.tsCode.trim() ? payload.tsCode.trim() : undefined,
    portfolioOnly: payload.portfolioOnly === true,
    offset: payload.offset == null ? 0 : Math.max(0, Math.min(10000, Math.round(payload.offset))),
    limit: payload.limit == null ? 8 : Math.max(1, Math.min(100, Math.round(payload.limit))),
    tradeDate: normalizeTradeDate(payload.tradeDate),
  }
}

function normalizeTradeDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const compact = value.trim().replace(/-/g, '')
  if (!/^\d{8}$/.test(compact)) return undefined
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`
}

function normalizeOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : null
}

function normalizeResolution(value: unknown): DecisionSignalResolution | null {
  const allowed: DecisionSignalResolution[] = [
    'RESOLVED_VALID',
    'RESOLVED_INVALID',
    'RESOLVED_MISSED',
    'RESOLVED_DUPLICATE',
    'RESOLVED_DATA_ISSUE',
    'RESOLVED_MANUAL',
  ]
  return allowed.includes(value as DecisionSignalResolution) ? value as DecisionSignalResolution : null
}
