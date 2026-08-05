import { BrowserWindow } from 'electron'
import type Database from 'better-sqlite3'
import {
  cleanupDecisionSignals,
  expireDecisionSignals,
  getDecisionSignalEvents,
  getDecisionSignalById,
  queryDecisionSignalsByTimeRange,
  resolveDecisionSignalStatus,
  updateDecisionSignalStatus,
  upsertDecisionSignal,
  upsertDecisionSignals,
  type DecisionSignalFilters,
} from '../database/decisionSignalsRepository'
import type {
  DecisionSignalDirection,
  DecisionSignalEventRow,
  DecisionSignalResolution,
  DecisionSignalRow,
  DecisionSignalSourceModule,
  DecisionSignalStatus,
  DecisionSignalType,
} from '../database/types'
import { notifyDecisionSignalNative } from './decisionNotificationService'
import { getLastNTradingDays, isTradeDay } from '../database/tradeCalRepository'

export interface DecisionSignalInput {
  sourceModule: DecisionSignalSourceModule
  strategyKey: string
  tsCode?: string | null
  stockName?: string | null
  conceptCode?: string | null
  conceptName?: string | null
  signalType: DecisionSignalType
  direction: DecisionSignalDirection
  priority: number
  score?: number | null
  confidence?: number | null
  title: string
  summary: string
  reason?: unknown
  sourceRef?: unknown
  status?: DecisionSignalStatus
  dedupKey?: string
  signalTime?: number
  expireAt?: number | null
}

export interface DecisionSignalSummary {
  totalToday: number
  unreadCount: number
  highPriorityUnreadCount: number
  watchingCount: number
  byType: Record<DecisionSignalType, number>
  bySource: Partial<Record<DecisionSignalSourceModule, number>>
  topSignals: DecisionSignalRow[]
}

export type TodayDecisionSignalFilters = DecisionSignalFilters
  & { portfolioOnly?: boolean }

export interface DecisionSignalDateContext {
  today: string
  displayDate: string
  latestTradeDate: string | null
  isFallback: boolean
  isTradingDay: boolean
}

export interface TodayDecisionSignalResult {
  data: DecisionSignalRow[]
  carryover: DecisionSignalRow[]
  context: DecisionSignalDateContext
}

const DEFAULT_ACTIVE_STATUSES: DecisionSignalStatus[] = ['NEW', 'READ', 'WATCHING']

export function emitDecisionSignal(
  db: Database.Database,
  input: DecisionSignalInput,
  win?: BrowserWindow
): DecisionSignalRow {
  const now = Date.now()
  const signalTime = input.signalTime ?? now
  const normalized = normalizeInput(input, signalTime, now)
  const result = upsertDecisionSignal(db, normalized)

  if (result.inserted && normalized.priority >= 3) {
    pushDecisionSignalCreated(win, result.signal)
  }
  return result.signal
}

export function emitDecisionSignals(
  db: Database.Database,
  inputs: DecisionSignalInput[],
  win?: BrowserWindow
): DecisionSignalRow[] {
  if (inputs.length === 0) return []
  const now = Date.now()
  const rows = inputs.map((input) => normalizeInput(input, input.signalTime ?? now, now))
  const beforeKeys = new Set(
    rows
      .map((row) => db.prepare('SELECT dedup_key FROM decision_signals WHERE dedup_key = ?').get(row.dedupKey) as { dedup_key: string } | undefined)
      .filter((row): row is { dedup_key: string } => row != null)
      .map((row) => row.dedup_key)
  )
  const signals = upsertDecisionSignals(db, rows)
  for (const signal of signals) {
    if (!beforeKeys.has(signal.dedupKey) && signal.priority >= 3) {
      pushDecisionSignalCreated(win, signal)
    }
  }
  return signals
}

export function getTodayDecisionSignals(
  db: Database.Database,
  filters: TodayDecisionSignalFilters = {},
  now = Date.now()
): DecisionSignalRow[] {
  const result = getTodayDecisionSignalContext(db, filters, now)
  return [...result.data, ...result.carryover]
}

export function getTodayDecisionSignalContext(
  db: Database.Database,
  filters: TodayDecisionSignalFilters = {},
  now = Date.now()
): TodayDecisionSignalResult {
  expireDecisionSignals(db, now)
  const today = getBjYmd(now)
  const todayRange = getBjDayRange(now)
  const globalToday = queryDecisionSignalsByTimeRange(db, todayRange.start, todayRange.end, {
    statuses: DEFAULT_ACTIVE_STATUSES,
    limit: 1,
  })
  const latestTradeDate = getLatestTradeDate(db, today)
  const tradingDay = getTradingDayState(db, today)
  const displayDate = globalToday.length === 0 && latestTradeDate && latestTradeDate < today
    ? latestTradeDate
    : today
  const displayRange = getBjDayRangeFromYmd(displayDate)
  normalizeNonPortfolioTrendPriority(db, displayRange.start, displayRange.end)
  const { portfolioOnly, ...queryFilters } = filters
  const signals = queryDecisionSignalsByTimeRange(db, displayRange.start, displayRange.end, {
    statuses: DEFAULT_ACTIVE_STATUSES,
    limit: 200,
    ...queryFilters,
  })
  const filteredSignals = portfolioOnly ? signals.filter(hasPortfolioMarker) : signals
  const wantsWatching = !queryFilters.statuses?.length || queryFilters.statuses.includes('WATCHING')
  const carryoverRows = wantsWatching
    ? queryDecisionSignalsByTimeRange(db, 0, displayRange.start, {
        ...queryFilters,
        statuses: ['WATCHING'],
        limit: 100,
      })
    : []
  const carryover = portfolioOnly ? carryoverRows.filter(hasPortfolioMarker) : carryoverRows
  return {
    data: filteredSignals,
    carryover,
    context: {
      today,
      displayDate,
      latestTradeDate,
      isFallback: displayDate !== today,
      isTradingDay: tradingDay,
    },
  }
}

function normalizeNonPortfolioTrendPriority(db: Database.Database, start: number, end: number): number {
  return db.prepare(`
    UPDATE decision_signals
    SET priority = 3,
        updated_at = ?
    WHERE source_module = 'trend'
      AND priority > 3
      AND signal_time >= ?
      AND signal_time < ?
      AND status NOT IN ('DISMISSED', 'EXPIRED')
      AND COALESCE(json_extract(reason_json, '$.isPortfolio'), 0) != 1
      AND COALESCE(json_extract(source_ref_json, '$.isPortfolio'), 0) != 1
  `).run(Date.now(), start, end).changes
}

function hasPortfolioMarker(signal: DecisionSignalRow): boolean {
  return jsonHasPortfolioMarker(signal.reasonJson) || jsonHasPortfolioMarker(signal.sourceRefJson)
}

function jsonHasPortfolioMarker(raw: string | null): boolean {
  if (!raw) return false
  try {
    const obj = JSON.parse(raw) as { isPortfolio?: unknown }
    return obj.isPortfolio === true
  } catch {
    return false
  }
}

export function getDecisionSignalSummary(db: Database.Database, now = Date.now()): DecisionSignalSummary {
  const signals = getTodayDecisionSignals(db, { limit: 500 }, now)
  const byType: Record<DecisionSignalType, number> = { ALERT: 0, OPPORTUNITY: 0, RISK: 0, INFO: 0 }
  const bySource: Partial<Record<DecisionSignalSourceModule, number>> = {}
  let unreadCount = 0
  let highPriorityUnreadCount = 0
  let watchingCount = 0

  for (const signal of signals) {
    byType[signal.signalType] += 1
    bySource[signal.sourceModule] = (bySource[signal.sourceModule] ?? 0) + 1
    if (signal.status === 'NEW') {
      unreadCount += 1
      if (signal.priority >= 4) highPriorityUnreadCount += 1
    }
    if (signal.status === 'WATCHING') watchingCount += 1
  }

  return {
    totalToday: signals.length,
    unreadCount,
    highPriorityUnreadCount,
    watchingCount,
    byType,
    bySource,
    topSignals: signals.slice(0, 8),
  }
}

export function markDecisionSignalRead(db: Database.Database, id: number): DecisionSignalRow | null {
  return updateAndReturn(db, id, 'READ')
}

export function watchDecisionSignal(db: Database.Database, id: number): DecisionSignalRow | null {
  return updateAndReturn(db, id, 'WATCHING')
}

export function dismissDecisionSignal(
  db: Database.Database,
  id: number,
  reason: string | null = null,
  note: string | null = null
): DecisionSignalRow | null {
  return updateAndReturn(db, id, 'DISMISSED', reason, note)
}

export function resolveDecisionSignal(
  db: Database.Database,
  id: number,
  resolution: DecisionSignalResolution,
  note: string | null = null
): DecisionSignalRow | null {
  const ok = resolveDecisionSignalStatus(db, id, resolution, note)
  if (!ok) return null
  return getDecisionSignalById(db, id)
}

export function getDecisionSignalTimeline(db: Database.Database, id: number): DecisionSignalEventRow[] | null {
  const signal = getDecisionSignalById(db, id)
  if (!signal) return null
  return getDecisionSignalEvents(db, id)
}

export function expireOldDecisionSignals(db: Database.Database): number {
  return expireDecisionSignals(db)
}

export function cleanupOldDecisionSignals(db: Database.Database, keepDays = 180): number {
  return cleanupDecisionSignals(db, keepDays)
}

function normalizeInput(input: DecisionSignalInput, signalTime: number, now: number): Omit<DecisionSignalRow, 'id'> {
  const priority = clampInt(input.priority, 1, 5)
  const score = input.score == null ? null : clampNumber(input.score, 0, 100)
  const confidence = input.confidence == null ? null : clampNumber(input.confidence, 0, 100)
  const dedupKey = input.dedupKey ?? buildDedupKey(input, signalTime)

  return {
    sourceModule: input.sourceModule,
    strategyKey: input.strategyKey.trim(),
    tsCode: input.tsCode ?? null,
    stockName: input.stockName ?? null,
    conceptCode: input.conceptCode ?? null,
    conceptName: input.conceptName ?? null,
    signalType: input.signalType,
    direction: input.direction,
    priority,
    score,
    confidence,
    title: input.title.trim().slice(0, 120),
    summary: input.summary.trim().slice(0, 600),
    reasonJson: input.reason === undefined ? null : JSON.stringify(input.reason),
    sourceRefJson: input.sourceRef === undefined ? null : JSON.stringify(input.sourceRef),
    status: input.status ?? 'NEW',
    dedupKey,
    signalTime,
    expireAt: input.expireAt === undefined ? getDefaultExpireAt(input.sourceModule, signalTime) : input.expireAt,
    createdAt: now,
    updatedAt: now,
    firstSeenAt: now,
    lastSeenAt: signalTime,
    occurrenceCount: 1,
    acknowledgedAt: null,
    watchedAt: null,
    dismissedAt: null,
    resolvedAt: null,
    resolution: null,
    resolutionNote: null,
  }
}

function updateAndReturn(
  db: Database.Database,
  id: number,
  status: DecisionSignalStatus,
  reason: string | null = null,
  note: string | null = null
): DecisionSignalRow | null {
  const ok = updateDecisionSignalStatus(db, id, status, Date.now(), { reason, note })
  if (!ok) return null
  return getDecisionSignalById(db, id)
}

function pushDecisionSignalCreated(win: BrowserWindow | undefined, signal: DecisionSignalRow): void {
  const target = win && !win.isDestroyed() ? win : BrowserWindow.getAllWindows()[0]
  if (target && !target.isDestroyed()) {
    target.webContents.send('decision:signalCreated', signal)
  }
  notifyDecisionSignalNative(signal, target)
}

function buildDedupKey(input: DecisionSignalInput, signalTime: number): string {
  const subject = input.tsCode ?? input.conceptCode ?? 'global'
  return [
    input.sourceModule,
    input.strategyKey,
    subject,
    input.signalType,
    input.direction,
    getBjYmd(signalTime),
  ].join(':')
}

function getBjYmd(timeMs: number): string {
  const bj = new Date(timeMs + 8 * 60 * 60 * 1000)
  return `${bj.getUTCFullYear()}${String(bj.getUTCMonth() + 1).padStart(2, '0')}${String(bj.getUTCDate()).padStart(2, '0')}`
}

function getBjDayRange(timeMs: number): { start: number; end: number } {
  const bj = new Date(timeMs + 8 * 60 * 60 * 1000)
  const startUtcMs = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - 8 * 60 * 60 * 1000
  return { start: startUtcMs, end: startUtcMs + 24 * 60 * 60 * 1000 }
}

function getBjDayRangeFromYmd(ymd: string): { start: number; end: number } {
  const year = Number(ymd.slice(0, 4))
  const month = Number(ymd.slice(4, 6))
  const day = Number(ymd.slice(6, 8))
  const start = Date.UTC(year, month - 1, day) - 8 * 60 * 60 * 1000
  return { start, end: start + 24 * 60 * 60 * 1000 }
}

function getDefaultExpireAt(sourceModule: DecisionSignalSourceModule, signalTime: number): number {
  if (sourceModule === 'short_term') {
    return getBjDayRange(signalTime).start + (15 * 60 + 30) * 60 * 1000
  }
  const lifetimeDays = sourceModule === 'trend'
    ? 7
    : sourceModule === 'news' || sourceModule === 'ai'
      ? 3
      : 1
  return signalTime + lifetimeDays * 24 * 60 * 60 * 1000
}

function getLatestTradeDate(db: Database.Database, today: string): string | null {
  try {
    const latest = getLastNTradingDays(db, 1, today).at(-1)
    if (latest) return latest
  } catch {
    // 旧测试库或受损日历表降级到已有信号日期。
  }
  const end = getBjDayRangeFromYmd(today).end
  const row = db.prepare('SELECT MAX(signal_time) AS signal_time FROM decision_signals WHERE signal_time < ?').get(end) as {
    signal_time: number | null
  }
  return row.signal_time == null ? null : getBjYmd(row.signal_time)
}

function getTradingDayState(db: Database.Database, today: string): boolean {
  try {
    const state = isTradeDay(db, today)
    if (state != null) return state
  } catch {
    // trade_cal 不可用时仅用周末规则兜底，不阻断信号读取。
  }
  const day = new Date(`${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6, 8)}T00:00:00+08:00`).getUTCDay()
  return day !== 0 && day !== 6
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(Number.isFinite(value) ? value : min)))
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min))
}
