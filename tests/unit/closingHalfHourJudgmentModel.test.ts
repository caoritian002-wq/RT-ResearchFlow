import { describe, expect, it } from 'vitest'
import {
  buildClosingHalfHourWorkbenchJudgment,
  judgeClosingHalfHourStock,
  type ClosingHalfHourJudgmentInput,
  type ClosingMinutePoint,
} from '../../electron/main/services/closingHalfHourJudgmentModel'

function points(closes: number[], options: { volume?: number; start?: string } = {}): ClosingMinutePoint[] {
  const [startHour, startMinute] = (options.start ?? '14:30').split(':').map(Number)
  return closes.map((close, index) => {
    const total = startHour * 60 + startMinute + index
    const hour = Math.floor(total / 60)
    const minute = total % 60
    return {
      time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      open: close - 0.02,
      high: close + 0.05,
      low: close - 0.05,
      close,
      vol: options.volume ?? 1_000,
      amount: (options.volume ?? 1_000) * close,
    }
  })
}

function input(overrides: Partial<ClosingHalfHourJudgmentInput> = {}): ClosingHalfHourJudgmentInput {
  const morning = points(Array.from({ length: 120 }, (_, index) => 9.8 + index * 0.0015), { start: '09:30', volume: 500 })
  const tail = points(Array.from({ length: 30 }, (_, index) => 10 + index * 0.012), { volume: 1_500 })
  return {
    tsCode: '000001.SZ',
    stockCode: '000001',
    stockName: '主动样本',
    dataMode: 'eod',
    dayOpen: 9.8,
    previousClose: 9.7,
    pctChg: 6.2,
    dayAmount: 100_000,
    minutePoints: [...morning, ...tail],
    ...overrides,
  }
}

describe('FR-250 尾盘行为研判模型', () => {
  it('以真实路径识别主动增强，不使用固定形态分数', () => {
    const result = judgeClosingHalfHourStock(input())
    expect(result.tier).toBe('active')
    expect(result.totalScore).toBeGreaterThanOrEqual(68)
    expect(result.metrics.tailReturnPct).toBeGreaterThan(3)
    expect(result.dimensions.find((item) => item.key === 'participation')?.status).toBe('strong')
  })

  it('最后十分钟急跌时降级为撤退风险', () => {
    const stable = Array.from({ length: 20 }, (_, index) => 10 + index * 0.02)
    const drop = Array.from({ length: 10 }, (_, index) => 10.38 - index * 0.035)
    const result = judgeClosingHalfHourStock(input({ minutePoints: [...points([9.9, 9.95], { start: '09:30' }), ...points([...stable, ...drop])] }))
    expect(result.tier).toBe('retreat')
    expect(result.metrics.lateReturnPct).toBeLessThan(-1.5)
    expect(result.legacyForms).toContain('lastTenSharpDrop')
  })

  it('冲高后回落不会被上涨幅度误判为主动增强', () => {
    const closes = [10, 10.1, 10.2, 10.3, 10.4, 10.45, 10.35, 10.25, 10.12, 9.98]
    const result = judgeClosingHalfHourStock(input({ minutePoints: [...points([9.8, 9.9], { start: '09:30' }), ...points(closes)] }))
    expect(result.tier).not.toBe('active')
    expect(result.metrics.maxDrawdownPct).toBeGreaterThan(4)
    expect(result.risks.join('')).toContain('冲高回落')
  })

  it('缺少精确14:30价格时保持数据不足，不拿任意分钟代替', () => {
    const result = judgeClosingHalfHourStock(input({ minutePoints: points([10, 10.1, 10.2, 10.25, 10.3], { start: '14:31' }) }))
    expect(result.tier).toBe('insufficient')
    expect(result.metrics.baseline1430).toBeNull()
    expect(result.totalScore).not.toBe(0)
    expect(result.missingFields).toContain('精确14:30价格')
  })

  it('缺成交量时参与度保持未知，不伪装为零量弱势', () => {
    const minutePoints = input().minutePoints.map((point) => ({ ...point, vol: null, amount: null }))
    const result = judgeClosingHalfHourStock(input({ minutePoints }))
    const participation = result.dimensions.find((item) => item.key === 'participation')
    expect(participation?.score).toBeNull()
    expect(participation?.value).toBe('待补')
    expect(result.missingFields).toContain('分钟成交量')
  })

  it('只有尾盘片段时不把片段占比误判为全天放量，15:00覆盖不回绕', () => {
    const tailOnly = points(Array.from({ length: 31 }, (_, index) => 10 + index * 0.01), { volume: 1_000 })
    const partial = judgeClosingHalfHourStock(input({ minutePoints: tailOnly }))
    expect(partial.dimensions.find((item) => item.key === 'participation')?.score).toBeNull()

    const fullDay = judgeClosingHalfHourStock(input({
      minutePoints: [
        ...points(Array.from({ length: 120 }, () => 9.9), { start: '09:30', volume: 500 }),
        ...tailOnly,
      ],
    }))
    expect(fullDay.metrics.latestTime).toBe('15:00')
    expect(fullDay.metrics.tailVolumePace).toBeLessThan(10)
  })

  it('市场结论同时披露主动、确认、撤退和不足，不以候选数量替代结论', () => {
    const active = judgeClosingHalfHourStock(input())
    const retreat = judgeClosingHalfHourStock(input({ minutePoints: points([10, 9.95, 9.9, 9.8, 9.7, 9.6]) }))
    const insufficient = judgeClosingHalfHourStock(input({ minutePoints: points([10, 10.1], { start: '14:31' }) }))
    const result = buildClosingHalfHourWorkbenchJudgment([active, active, retreat, insufficient])
    expect(result.stance).toBe('active')
    expect(result.activeCount).toBe(2)
    expect(result.retreatCount).toBe(1)
    expect(result.insufficientCount).toBe(1)
    expect(result.summary).toContain('次日只跟踪确认条件')
  })
})
