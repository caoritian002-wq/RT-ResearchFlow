export const DEFAULT_VISIBLE_BARS = 30
export const MAX_VISIBLE_PRESET_BARS = 90
export const INDICATOR_WARMUP_BARS = 59
export const INITIAL_HISTORY_BARS = MAX_VISIBLE_PRESET_BARS + INDICATOR_WARMUP_BARS
export const OLDER_HISTORY_BATCH = 120
export const HISTORY_LOAD_THRESHOLD = 6
export const HISTORY_RANGE_PRESETS = [30, 60, 90] as const

export type HistoryRangePreset = typeof HISTORY_RANGE_PRESETS[number] | 'all'
export type HistoryRangeSelection = HistoryRangePreset | 'custom'

export interface TradeDateRow {
  tradeDate: string
}

export interface LogicalRange {
  from: number
  to: number
}

export function mergeHistoryRows<T extends TradeDateRow>(
  current: T[],
  incoming: T[],
): { rows: T[]; addedBefore: number } {
  if (incoming.length === 0) return { rows: current, addedBefore: 0 }

  const currentEarliest = current[0]?.tradeDate ?? null
  const byDate = new Map<string, T>()
  for (const row of current) byDate.set(row.tradeDate, row)
  for (const row of incoming) byDate.set(row.tradeDate, row)

  const rows = Array.from(byDate.values()).sort((a, b) =>
    a.tradeDate.localeCompare(b.tradeDate),
  )
  const addedBefore = currentEarliest == null
    ? 0
    : rows.filter((row) => row.tradeDate < currentEarliest).length

  return { rows, addedBefore }
}

export function shouldLoadOlderHistory(
  range: LogicalRange | null,
  hasMore: boolean,
  loading: boolean,
): boolean {
  return Boolean(
    range
      && hasMore
      && !loading
      && Number.isFinite(range.from)
      && range.from <= HISTORY_LOAD_THRESHOLD,
  )
}

export function shiftLogicalRange(
  range: LogicalRange | null,
  addedBefore: number,
): LogicalRange | null {
  if (!range || addedBefore <= 0) return range
  return {
    from: range.from + addedBefore,
    to: range.to + addedBefore,
  }
}

export function defaultVisibleLogicalRange(rowCount: number): LogicalRange {
  return visibleLogicalRange(rowCount, DEFAULT_VISIBLE_BARS)
}

export function visibleLogicalRange(
  rowCount: number,
  target: number | 'all',
): LogicalRange {
  const safeRowCount = Math.max(0, Math.trunc(rowCount))
  const requested = target === 'all'
    ? safeRowCount
    : Math.max(1, Math.trunc(target))
  const visibleBars = Math.min(safeRowCount, requested)
  return {
    from: Math.max(0, safeRowCount - visibleBars),
    to: Math.max(0, safeRowCount + 2),
  }
}

export function countVisibleRows(
  range: LogicalRange | null,
  rowCount: number,
): number {
  if (!range || rowCount <= 0) return 0
  const first = Math.max(0, Math.ceil(range.from))
  const last = Math.min(rowCount - 1, Math.floor(range.to))
  return Math.max(0, last - first + 1)
}

export function resolveHistoryRangeSelection(
  visibleRows: number,
  rowCount: number,
  hasMore: boolean,
): HistoryRangeSelection {
  if (!hasMore && rowCount > 0 && visibleRows >= rowCount - 1) return 'all'
  const preset = HISTORY_RANGE_PRESETS.find((value) => Math.abs(value - visibleRows) <= 1)
  return preset ?? 'custom'
}
