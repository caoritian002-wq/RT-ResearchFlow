import type { MinuteBarForCondition, MinuteWindowEvidence } from './types'

export interface NormalizedMinuteBar extends MinuteBarForCondition {
  index: number
  closeValue: number
  highValue: number
  lowValue: number
  amountValue: number
  volumeValue: number
}

export interface MinuteWindow {
  startIndex: number
  endIndex: number
  bars: NormalizedMinuteBar[]
  start: NormalizedMinuteBar
  end: NormalizedMinuteBar
  high: NormalizedMinuteBar
  low: NormalizedMinuteBar
  gainPct: number
  amount: number
  volume: number
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function normalizeMinuteBars(rows: MinuteBarForCondition[]): NormalizedMinuteBar[] {
  return rows
    .filter((row) => finiteOrNull(row.close) !== null)
    .sort((a, b) => a.tsMinute.localeCompare(b.tsMinute))
    .map((row, index) => {
      const closeValue = finiteOrNull(row.close) ?? 0
      return {
        ...row,
        index,
        closeValue,
        highValue: finiteOrNull(row.high) ?? closeValue,
        lowValue: finiteOrNull(row.low) ?? closeValue,
        amountValue: finiteOrNull(row.amount) ?? 0,
        volumeValue: finiteOrNull(row.vol) ?? 0,
      }
    })
}

export function buildMinuteWindows(bars: NormalizedMinuteBar[], windowMinutes: number): MinuteWindow[] {
  const windowSize = Math.max(1, Math.round(windowMinutes))
  if (bars.length < windowSize) return []
  const windows: MinuteWindow[] = []
  for (let startIndex = 0; startIndex <= bars.length - windowSize; startIndex++) {
    const slice = bars.slice(startIndex, startIndex + windowSize)
    const start = slice[0]
    const end = slice[slice.length - 1]
    if (!start || !end || start.closeValue <= 0) continue
    const high = slice.reduce((best, item) => item.highValue > best.highValue ? item : best, slice[0])
    const low = slice.reduce((best, item) => item.lowValue < best.lowValue ? item : best, slice[0])
    const amount = slice.reduce((sum, item) => sum + item.amountValue, 0)
    const volume = slice.reduce((sum, item) => sum + item.volumeValue, 0)
    windows.push({
      startIndex,
      endIndex: startIndex + windowSize - 1,
      bars: slice,
      start,
      end,
      high,
      low,
      gainPct: (end.closeValue - start.closeValue) / start.closeValue * 100,
      amount,
      volume,
    })
  }
  return windows
}

export function findBestGainWindow(bars: NormalizedMinuteBar[], windowMinutes: number): MinuteWindow | null {
  const windows = buildMinuteWindows(bars, windowMinutes)
  if (windows.length === 0) return null
  return windows.reduce((best, item) => item.gainPct > best.gainPct ? item : best, windows[0])
}

export function sumBeforeWindow(
  bars: NormalizedMinuteBar[],
  window: MinuteWindow,
  baselineMinutes: number,
  field: 'amountValue' | 'volumeValue',
): { baselineTotal: number; baselinePerMinute: number; count: number } {
  const count = Math.max(1, Math.round(baselineMinutes))
  const start = Math.max(0, window.startIndex - count)
  const slice = bars.slice(start, window.startIndex)
  const total = slice.reduce((sum, item) => sum + item[field], 0)
  return { baselineTotal: total, baselinePerMinute: slice.length > 0 ? total / slice.length : 0, count: slice.length }
}

export function getAfterBars(bars: NormalizedMinuteBar[], window: MinuteWindow, afterMinutes: number): NormalizedMinuteBar[] {
  const count = Math.max(1, Math.round(afterMinutes))
  return bars.slice(window.endIndex + 1, window.endIndex + 1 + count)
}

export function computeMaxPullbackAfterHigh(bars: NormalizedMinuteBar[], window: MinuteWindow, afterMinutes: number): { pullbackPct: number | null; lowMinute: string | null } {
  const afterBars = getAfterBars(bars, window, afterMinutes)
  const high = window.high.highValue
  if (high <= 0 || afterBars.length === 0) return { pullbackPct: null, lowMinute: null }
  const low = afterBars.reduce((best, item) => item.lowValue < best.lowValue ? item : best, afterBars[0])
  return { pullbackPct: (high - low.lowValue) / high * 100, lowMinute: low.tsMinute }
}

export function computeHoldRatioAfterWindow(bars: NormalizedMinuteBar[], window: MinuteWindow, afterMinutes: number): number | null {
  const afterBars = getAfterBars(bars, window, afterMinutes)
  const gain = window.end.closeValue - window.start.closeValue
  if (gain <= 0 || afterBars.length === 0) return null
  const heldCount = afterBars.filter((item) => item.closeValue >= window.start.closeValue + gain * 0.65).length
  return heldCount / afterBars.length * 100
}

export function computeCloseRetention(bars: NormalizedMinuteBar[], window: MinuteWindow): number | null {
  const last = bars[bars.length - 1]
  const gain = window.high.highValue - window.start.closeValue
  if (!last || gain <= 0) return null
  return Math.max(0, (last.closeValue - window.start.closeValue) / gain * 100)
}

export function windowEvidence(window: MinuteWindow): MinuteWindowEvidence {
  return {
    startMinute: window.start.tsMinute,
    endMinute: window.end.tsMinute,
    highMinute: window.high.tsMinute,
    gainPct: Number(window.gainPct.toFixed(4)),
    amount: Number(window.amount.toFixed(4)),
    volume: Number(window.volume.toFixed(4)),
  }
}
