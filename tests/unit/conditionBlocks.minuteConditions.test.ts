import { describe, expect, it } from 'vitest'
import type { ConditionBlock, MinuteBarForCondition } from '../../electron/main/services/conditionBlocks/types'
import { createEvaluationContext, evaluateMinuteCondition } from '../../electron/main/services/conditionBlocks/minuteConditions'

function bar(minute: string, close: number, amount = 100, vol = 10): MinuteBarForCondition {
  return {
    tsCode: '000001.SZ',
    tradeDate: '20260616',
    tsMinute: minute,
    open: close,
    high: close,
    low: close,
    close,
    amount,
    vol,
  }
}

function block(type: ConditionBlock['type'], params: Record<string, number>, id = type): ConditionBlock {
  return {
    id,
    type,
    name: id,
    description: id,
    enabled: true,
    weight: 20,
    params,
  }
}

describe('condition block minute conditions', () => {
  it('识别 15 分钟涨幅窗口', () => {
    const rows = [
      bar('09:30', 10),
      bar('09:31', 10.05),
      bar('09:32', 10.1),
      bar('09:33', 10.2),
      bar('09:34', 10.35),
    ]
    const context = createEvaluationContext(rows, 5)
    const result = evaluateMinuteCondition(block('minute_window_gain', { windowMinutes: 5, minGainPct: 3 }), context)

    expect(result.passed).toBe(true)
    expect(result.evidence.startMinute).toBe('09:30')
    expect(result.evidence.endMinute).toBe('09:34')
    expect(result.evidence.gainPct).toBeCloseTo(3.5, 2)
  })

  it('5 分钟 K 线按实际粒度换算 15 分钟窗口', () => {
    const rows = [
      bar('09:30', 10),
      bar('09:35', 10.1),
      bar('09:40', 10.5),
      bar('09:45', 10.3),
      bar('09:50', 10.2),
    ]
    const context = createEvaluationContext(rows, 15)
    const result = evaluateMinuteCondition(block('minute_window_gain', { windowMinutes: 15, minGainPct: 3 }), context)

    expect(result.passed).toBe(true)
    expect(result.evidence.startMinute).toBe('09:30')
    expect(result.evidence.endMinute).toBe('09:40')
    expect(result.evidence.gainPct).toBeCloseTo(5, 2)
  })

  it('使用拉升窗口前的成交额均值判断放量倍数', () => {
    const rows = [
      bar('09:30', 10, 100),
      bar('09:31', 10, 100),
      bar('09:32', 10, 100),
      bar('09:33', 10.1, 250),
      bar('09:34', 10.3, 300),
      bar('09:35', 10.5, 350),
    ]
    const context = createEvaluationContext(rows, 3)
    evaluateMinuteCondition(block('minute_window_gain', { windowMinutes: 3, minGainPct: 3 }), context)
    const result = evaluateMinuteCondition(block('minute_window_amount_ratio', { windowMinutes: 3, baselineMinutes: 3, minRatio: 2 }), context)

    expect(result.passed).toBe(true)
    expect(result.evidence.ratio).toBeCloseTo(3, 2)
  })

  it('回撤过大时不通过', () => {
    const rows = [
      bar('09:30', 10),
      bar('09:31', 10.2),
      bar('09:32', 10.5),
      { ...bar('09:33', 10.1), low: 10.0 },
      bar('09:34', 10.2),
    ]
    const context = createEvaluationContext(rows, 3)
    evaluateMinuteCondition(block('minute_window_gain', { windowMinutes: 3, minGainPct: 3 }), context)
    const result = evaluateMinuteCondition(block('pullback_after_high', { afterMinutes: 2, maxPullbackPct: 2 }), context)

    expect(result.passed).toBe(false)
    expect(result.evidence.maxPullbackPct).toBeGreaterThan(4)
  })

  it('收盘保持度不足时不通过', () => {
    const rows = [
      bar('09:30', 10),
      bar('09:31', 10.2),
      { ...bar('09:32', 10.5), high: 10.5 },
      bar('09:33', 10.2),
      bar('14:57', 10.1),
    ]
    const context = createEvaluationContext(rows, 3)
    evaluateMinuteCondition(block('minute_window_gain', { windowMinutes: 3, minGainPct: 3 }), context)
    const result = evaluateMinuteCondition(block('close_retention', { minRetentionPct: 60 }), context)

    expect(result.passed).toBe(false)
    expect(result.evidence.retentionPct).toBeCloseTo(20, 1)
  })
})
