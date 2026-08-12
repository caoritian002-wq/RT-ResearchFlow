export type MorningAuctionPriceHistoryState =
  | 'ready'
  | 'partial'
  | 'insufficient'
  | 'unavailable'
  | 'failed'

export type MorningAuctionPriceHistoryReason =
  | 'LOCAL_READY'
  | 'REMOTE_BACKFILLED'
  | 'SAMPLE_INSUFFICIENT'
  | 'NO_HISTORY_DATA'
  | 'REMOTE_BACKFILL_FAILED'
  | 'LOCAL_READ_FAILED'

export interface MorningAuctionPriceHistoryEntry {
  p3d: number | null
  p5d: number | null
  state: MorningAuctionPriceHistoryState
  availableDays: number
  reason: MorningAuctionPriceHistoryReason
  remoteAttempted: boolean
}

export interface MorningAuctionPriceHistoryCoverage {
  requestedCount: number
  covered3dCount: number
  covered5dCount: number
  readyCount: number
  partialCount: number
  insufficientCount: number
  unavailableCount: number
  failedCount: number
  updatedAt: number
}

interface TradeDateState {
  entries: Map<string, MorningAuctionPriceHistoryEntry>
  pending: Set<string>
  loading: Set<string>
  inFlight: Promise<void> | null
  updatedAt: number
}

export type MorningAuctionPriceHistoryLoader = (
  tradeDate: string,
  tsCodes: string[],
) => Promise<Map<string, MorningAuctionPriceHistoryEntry>>

export interface MorningAuctionPriceCloseRow {
  tsCode: string
  tradeDate: string
  close: number
}

export interface MorningAuctionPriceHistoryLoadDependencies {
  queryLocal: (
    tsCodes: string[],
    startDate: string,
  ) => Map<string, MorningAuctionPriceCloseRow[]>
  fetchRemote?: (
    tsCode: string,
    startDate: string,
    endDate: string,
  ) => Promise<MorningAuctionPriceCloseRow[]>
  persistRemote?: (rows: MorningAuctionPriceCloseRow[]) => void
}

function uniqueCodes(tsCodes: string[]): string[] {
  return [...new Set(tsCodes.filter(Boolean))]
}

function isComplete(entry: MorningAuctionPriceHistoryEntry | undefined): boolean {
  return entry?.state === 'ready'
}

function subtractCalendarDays(ymd: string, days: number): string {
  const date = new Date(Date.UTC(
    Number(ymd.slice(0, 4)),
    Number(ymd.slice(4, 6)) - 1,
    Number(ymd.slice(6, 8)),
  ))
  date.setUTCDate(date.getUTCDate() - days)
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
}

function normalizeCloseRows(
  tsCode: string,
  rows: MorningAuctionPriceCloseRow[],
  tradeDate: string,
): MorningAuctionPriceCloseRow[] {
  const byDate = new Map<string, MorningAuctionPriceCloseRow>()
  for (const row of rows) {
    if (row.tradeDate >= tradeDate || !Number.isFinite(row.close) || row.close <= 0) continue
    byDate.set(row.tradeDate, { ...row, tsCode })
  }
  return [...byDate.values()].sort((left, right) => left.tradeDate.localeCompare(right.tradeDate))
}

export function calculateMorningAuctionPriceHistoryEntry(
  tsCode: string,
  rows: MorningAuctionPriceCloseRow[],
  tradeDate: string,
  options: { remoteAttempted?: boolean; remoteFailed?: boolean } = {},
): MorningAuctionPriceHistoryEntry {
  const normalized = normalizeCloseRows(tsCode, rows, tradeDate)
  const availableDays = normalized.length
  const latest = normalized.at(-1)?.close ?? null
  const p3Base = normalized.at(-4)?.close ?? null
  const p5Base = normalized.at(-6)?.close ?? null
  const p3d = latest != null && p3Base != null ? (latest - p3Base) / p3Base * 100 : null
  const p5d = latest != null && p5Base != null ? (latest - p5Base) / p5Base * 100 : null
  const remoteAttempted = options.remoteAttempted === true

  if (options.remoteFailed) {
    return {
      p3d,
      p5d,
      state: p3d != null ? 'partial' : 'failed',
      availableDays,
      reason: 'REMOTE_BACKFILL_FAILED',
      remoteAttempted,
    }
  }
  if (p5d != null) {
    return {
      p3d,
      p5d,
      state: 'ready',
      availableDays,
      reason: remoteAttempted ? 'REMOTE_BACKFILLED' : 'LOCAL_READY',
      remoteAttempted,
    }
  }
  if (p3d != null) {
    return {
      p3d,
      p5d: null,
      state: 'partial',
      availableDays,
      reason: 'SAMPLE_INSUFFICIENT',
      remoteAttempted,
    }
  }
  return {
    p3d: null,
    p5d: null,
    state: availableDays === 0 ? 'unavailable' : 'insufficient',
    availableDays,
    reason: availableDays === 0 ? 'NO_HISTORY_DATA' : 'SAMPLE_INSUFFICIENT',
    remoteAttempted,
  }
}

export async function loadMorningAuctionPriceHistoryEntries(
  tradeDate: string,
  tsCodes: string[],
  dependencies: MorningAuctionPriceHistoryLoadDependencies,
): Promise<Map<string, MorningAuctionPriceHistoryEntry>> {
  const codes = uniqueCodes(tsCodes)
  const result = new Map<string, MorningAuctionPriceHistoryEntry>()
  if (codes.length === 0) return result
  const startDate = subtractCalendarDays(tradeDate, 60)
  let localRows: Map<string, MorningAuctionPriceCloseRow[]>
  try {
    localRows = dependencies.queryLocal(codes, startDate)
  } catch {
    for (const code of codes) {
      result.set(code, {
        p3d: null,
        p5d: null,
        state: 'failed',
        availableDays: 0,
        reason: 'LOCAL_READ_FAILED',
        remoteAttempted: false,
      })
    }
    return result
  }

  for (const code of codes) {
    const local = normalizeCloseRows(code, localRows.get(code) ?? [], tradeDate)
    if (local.length >= 6 || !dependencies.fetchRemote) {
      result.set(code, calculateMorningAuctionPriceHistoryEntry(code, local, tradeDate))
      continue
    }
    try {
      const remote = await dependencies.fetchRemote(code, startDate, tradeDate)
      if (remote.length > 0) dependencies.persistRemote?.(remote)
      result.set(code, calculateMorningAuctionPriceHistoryEntry(
        code,
        [...local, ...remote],
        tradeDate,
        { remoteAttempted: true },
      ))
    } catch {
      result.set(code, calculateMorningAuctionPriceHistoryEntry(
        code,
        local,
        tradeDate,
        { remoteAttempted: true, remoteFailed: true },
      ))
    }
  }
  return result
}

export function buildMorningAuctionPriceHistoryCoverage(
  tsCodes: string[],
  entries: ReadonlyMap<string, MorningAuctionPriceHistoryEntry>,
  updatedAt = Date.now(),
): MorningAuctionPriceHistoryCoverage {
  const codes = uniqueCodes(tsCodes)
  const coverage: MorningAuctionPriceHistoryCoverage = {
    requestedCount: codes.length,
    covered3dCount: 0,
    covered5dCount: 0,
    readyCount: 0,
    partialCount: 0,
    insufficientCount: 0,
    unavailableCount: 0,
    failedCount: 0,
    updatedAt,
  }
  for (const code of codes) {
    const entry = entries.get(code)
    if (!entry) continue
    if (entry.p3d != null) coverage.covered3dCount += 1
    if (entry.p5d != null) coverage.covered5dCount += 1
    if (entry.state === 'ready') coverage.readyCount += 1
    else if (entry.state === 'partial') coverage.partialCount += 1
    else if (entry.state === 'insufficient') coverage.insufficientCount += 1
    else if (entry.state === 'unavailable') coverage.unavailableCount += 1
    else coverage.failedCount += 1
  }
  return coverage
}

export class MorningAuctionPriceHistoryCoordinator {
  private readonly states = new Map<string, TradeDateState>()

  constructor(
    private readonly loader: MorningAuctionPriceHistoryLoader,
    private readonly maxTradeDates = 8,
  ) {}

  async ensure(
    tradeDate: string,
    tsCodes: string[],
    options: { retryUnresolved?: boolean } = {},
  ): Promise<Map<string, MorningAuctionPriceHistoryEntry>> {
    const requested = uniqueCodes(tsCodes)
    if (requested.length === 0) return new Map()
    const state = this.getOrCreateState(tradeDate)

    if (options.retryUnresolved) {
      if (state.inFlight) await state.inFlight
      for (const code of requested) {
        if (!isComplete(state.entries.get(code))) state.entries.delete(code)
      }
    }

    while (requested.some(code => !state.entries.has(code))) {
      for (const code of requested) {
        if (!state.entries.has(code) && !state.loading.has(code)) state.pending.add(code)
      }
      if (!state.inFlight) {
        state.inFlight = this.drain(tradeDate, state).finally(() => {
          state.inFlight = null
        })
      }
      await state.inFlight
    }

    return new Map(requested.map(code => [code, state.entries.get(code)!]))
  }

  getCoverage(tradeDate: string, tsCodes: string[]): MorningAuctionPriceHistoryCoverage {
    const state = this.states.get(tradeDate)
    return buildMorningAuctionPriceHistoryCoverage(tsCodes, state?.entries ?? new Map(), state?.updatedAt ?? Date.now())
  }

  private getOrCreateState(tradeDate: string): TradeDateState {
    const existing = this.states.get(tradeDate)
    if (existing) return existing
    const state: TradeDateState = {
      entries: new Map(),
      pending: new Set(),
      loading: new Set(),
      inFlight: null,
      updatedAt: Date.now(),
    }
    this.states.set(tradeDate, state)
    while (this.states.size > this.maxTradeDates) {
      const oldest = this.states.keys().next().value as string | undefined
      if (!oldest || oldest === tradeDate) break
      this.states.delete(oldest)
    }
    return state
  }

  private async drain(tradeDate: string, state: TradeDateState): Promise<void> {
    while (state.pending.size > 0) {
      const batch = [...state.pending]
      state.pending.clear()
      for (const code of batch) state.loading.add(code)
      let loaded: Map<string, MorningAuctionPriceHistoryEntry>
      try {
        loaded = await this.loader(tradeDate, batch)
      } catch {
        loaded = new Map()
      }
      for (const code of batch) {
        state.entries.set(code, loaded.get(code) ?? {
          p3d: null,
          p5d: null,
          state: 'failed',
          availableDays: 0,
          reason: 'LOCAL_READ_FAILED',
          remoteAttempted: false,
        })
        state.loading.delete(code)
      }
      state.updatedAt = Date.now()
    }
  }
}
