import type { ConditionBlock, ConditionEvaluationResult } from './types'
import {
  computeCloseRetention,
  computeHoldRatioAfterWindow,
  computeMaxPullbackAfterHigh,
  findBestGainWindow,
  normalizeMinuteBars,
  sumBeforeWindow,
  windowEvidence,
  type NormalizedMinuteBar,
  type MinuteWindow,
} from './minuteWindowUtils'

function numParam(block: ConditionBlock, key: string, fallback: number): number {
  const value = block.params[key]
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function result(block: ConditionBlock, passed: boolean, score: number, message: string, evidence = {}, dataStatus: 'complete' | 'partial' | 'data_insufficient' = 'complete'): ConditionEvaluationResult {
  return {
    blockId: block.id,
    type: block.type,
    name: block.name,
    passed,
    score,
    weight: block.weight,
    contribution: passed ? score * block.weight / 100 : 0,
    params: { ...block.params },
    hardRequired: block.hardRequired === true,
    dataStatus,
    message,
    evidence,
  }
}

function insufficient(block: ConditionBlock, message = '分钟数据不足'): ConditionEvaluationResult {
  return result(block, false, 0, message, {}, 'data_insufficient')
}

export interface EvaluationContext {
  bars: NormalizedMinuteBar[]
  bestWindow: MinuteWindow | null
  barIntervalMinutes: number
}

export function createEvaluationContext(rawRows: Parameters<typeof normalizeMinuteBars>[0], preferredWindowMinutes = 15): EvaluationContext {
  const bars = normalizeMinuteBars(rawRows)
  const barIntervalMinutes = inferBarIntervalMinutes(bars)
  return { bars, bestWindow: findBestGainWindow(bars, toBarCount(preferredWindowMinutes, barIntervalMinutes)), barIntervalMinutes }
}

function toMinuteOfDay(value: string): number | null {
  const match = value.match(/^(\d{2}):(\d{2})$/)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

function inferBarIntervalMinutes(bars: NormalizedMinuteBar[]): number {
  const diffs: number[] = []
  for (let i = 1; i < bars.length; i += 1) {
    const prev = toMinuteOfDay(bars[i - 1].tsMinute)
    const current = toMinuteOfDay(bars[i].tsMinute)
    if (prev == null || current == null) continue
    const diff = current - prev
    if (diff > 0 && diff <= 30) diffs.push(diff)
  }
  if (diffs.length === 0) return 1
  diffs.sort((a, b) => a - b)
  return Math.max(1, diffs[Math.floor(diffs.length / 2)])
}

function toBarCount(minutes: number, barIntervalMinutes: number): number {
  return Math.max(1, Math.round(minutes / Math.max(1, barIntervalMinutes)))
}

export function evaluateMinuteCondition(block: ConditionBlock, context: EvaluationContext): ConditionEvaluationResult {
  if (!block.enabled) return result(block, true, 100, '条件已停用')
  const bars = context.bars
  if (bars.length < 2) return insufficient(block)

  if (block.type === 'minute_window_gain') {
    const windowMinutes = numParam(block, 'windowMinutes', 15)
    const minGainPct = numParam(block, 'minGainPct', 3)
    const best = findBestGainWindow(bars, toBarCount(windowMinutes, context.barIntervalMinutes))
    if (!best) return insufficient(block)
    context.bestWindow = best
    const passed = best.gainPct >= minGainPct
    const score = Math.min(100, Math.max(0, best.gainPct / Math.max(minGainPct, 0.01) * 100))
    return result(block, passed, score, passed ? '窗口涨幅达标' : '窗口涨幅不足', windowEvidence(best))
  }

  const window = context.bestWindow ?? findBestGainWindow(bars, toBarCount(numParam(block, 'windowMinutes', 15), context.barIntervalMinutes))
  if (!window) return insufficient(block)

  if (block.type === 'minute_window_amount_ratio') {
    const baseline = sumBeforeWindow(bars, window, toBarCount(numParam(block, 'baselineMinutes', 30), context.barIntervalMinutes), 'amountValue')
    const minRatio = numParam(block, 'minRatio', 2)
    if (baseline.baselinePerMinute <= 0) return insufficient(block, '缺少成交额基准')
    const ratio = window.amount / (baseline.baselinePerMinute * window.bars.length)
    const passed = ratio >= minRatio
    return result(block, passed, Math.min(100, ratio / minRatio * 100), passed ? '成交额放大达标' : '成交额放大不足', { ...windowEvidence(window), ratio: Number(ratio.toFixed(4)) })
  }

  if (block.type === 'minute_window_volume_ratio') {
    const baseline = sumBeforeWindow(bars, window, toBarCount(numParam(block, 'baselineMinutes', 30), context.barIntervalMinutes), 'volumeValue')
    const minRatio = numParam(block, 'minRatio', 1.8)
    if (baseline.baselinePerMinute <= 0) return insufficient(block, '缺少成交量基准')
    const ratio = window.volume / (baseline.baselinePerMinute * window.bars.length)
    const passed = ratio >= minRatio
    return result(block, passed, Math.min(100, ratio / minRatio * 100), passed ? '成交量放大达标' : '成交量放大不足', { ...windowEvidence(window), ratio: Number(ratio.toFixed(4)) })
  }

  if (block.type === 'pullback_after_high') {
    const maxPullbackPct = numParam(block, 'maxPullbackPct', 1.2)
    const pullback = computeMaxPullbackAfterHigh(bars, window, toBarCount(numParam(block, 'afterMinutes', 30), context.barIntervalMinutes))
    if (pullback.pullbackPct === null) return insufficient(block, '缺少后续回撤观察数据')
    const passed = pullback.pullbackPct <= maxPullbackPct
    const score = Math.max(0, Math.min(100, (maxPullbackPct - pullback.pullbackPct) / Math.max(maxPullbackPct, 0.01) * 100 + 50))
    return result(block, passed, score, passed ? '高点后回撤可控' : '高点后回撤过大', { ...windowEvidence(window), maxPullbackPct: Number(pullback.pullbackPct.toFixed(4)) })
  }

  if (block.type === 'hold_above_gain_ratio') {
    const minHoldRatio = numParam(block, 'minHoldRatio', 65)
    const holdRatio = computeHoldRatioAfterWindow(bars, window, toBarCount(numParam(block, 'afterMinutes', 30), context.barIntervalMinutes))
    if (holdRatio === null) return insufficient(block, '缺少后续站稳观察数据')
    const passed = holdRatio >= minHoldRatio
    return result(block, passed, Math.min(100, holdRatio / Math.max(minHoldRatio, 1) * 100), passed ? '后续站稳比例达标' : '后续站稳比例不足', { ...windowEvidence(window), holdRatio: Number(holdRatio.toFixed(4)) })
  }

  if (block.type === 'close_retention') {
    const minRetentionPct = numParam(block, 'minRetentionPct', 60)
    const retention = computeCloseRetention(bars, window)
    if (retention === null) return insufficient(block, '缺少收盘保持度数据')
    const passed = retention >= minRetentionPct
    return result(block, passed, Math.min(100, retention / Math.max(minRetentionPct, 1) * 100), passed ? '收盘保持度达标' : '收盘保持度不足', { ...windowEvidence(window), retentionPct: Number(retention.toFixed(4)) })
  }

  return result(block, false, 0, `未知条件类型: ${block.type}`, {}, 'partial')
}
