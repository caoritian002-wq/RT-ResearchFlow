import { describe, expect, it } from 'vitest'
import {
  buildDecisionSignalToastBatch,
  decisionSignalSourceLabel,
  parseDecisionSignalBriefingId,
  shouldShowDecisionSignalToast,
  type DecisionSignalToastSignal,
} from '../../src/components/DecisionSignalToast/decisionSignalToastModel'

function signal(overrides: Partial<DecisionSignalToastSignal> = {}): DecisionSignalToastSignal {
  return {
    id: 1,
    sourceModule: 'news',
    priority: 4,
    title: '韩国股市熔断，两大存储芯片龙头开盘爆发',
    summary: '测试摘要',
    sourceRefJson: JSON.stringify({ briefingId: 42, sourceName: '财联社' }),
    signalTime: 100,
    ...overrides,
  }
}

describe('FR-260 应用内主动提醒模型', () => {
  it('默认开启P4门槛，并支持独立关闭与P3门槛', () => {
    expect(shouldShowDecisionSignalToast(signal(), null)).toBe(true)
    expect(shouldShowDecisionSignalToast(signal({ priority: 3 }), null)).toBe(false)
    expect(shouldShowDecisionSignalToast(signal({ priority: 3 }), {
      decision_notify_in_app_enabled: 1,
      decision_notify_min_priority: 3,
    })).toBe(true)
    expect(shouldShowDecisionSignalToast(signal({ priority: 5 }), {
      decision_notify_in_app_enabled: 0,
      decision_notify_min_priority: 3,
    })).toBe(false)
  })

  it('只接受news引用中的正安全整数briefingId，并读取有界来源名', () => {
    expect(parseDecisionSignalBriefingId(signal())).toBe(42)
    expect(decisionSignalSourceLabel(signal())).toBe('财联社')
    expect(parseDecisionSignalBriefingId(signal({ sourceRefJson: '{broken' }))).toBeNull()
    expect(parseDecisionSignalBriefingId(signal({ sourceRefJson: JSON.stringify({ briefingId: '42' }) }))).toBeNull()
    expect(parseDecisionSignalBriefingId(signal({ sourceRefJson: JSON.stringify({ briefingId: -1 }) }))).toBeNull()
    expect(parseDecisionSignalBriefingId(signal({ sourceModule: 'trend' }))).toBeNull()
    expect(decisionSignalSourceLabel(signal({ sourceModule: 'trend' }))).toBe('长线趋势')
  })

  it('非资讯信号或缺少合法文章ID时不展示应用内资讯提醒', () => {
    const settings = {
      decision_notify_in_app_enabled: 1,
      decision_notify_min_priority: 3,
    }

    expect(shouldShowDecisionSignalToast(signal({ sourceModule: 'trend', priority: 5 }), settings)).toBe(false)
    expect(shouldShowDecisionSignalToast(signal({ sourceRefJson: null, priority: 5 }), settings)).toBe(false)
    expect(shouldShowDecisionSignalToast(signal({
      sourceRefJson: JSON.stringify({ briefingId: '42', sourceName: '财联社' }),
      priority: 5,
    }), settings)).toBe(false)
  })

  it('批量信号去重后按优先级、时间和ID稳定选择主消息', () => {
    const batch = buildDecisionSignalToastBatch([
      signal({ id: 1, priority: 4, signalTime: 300, title: '较新P4' }),
      signal({ id: 2, priority: 5, signalTime: 100, title: 'P5主消息' }),
      signal({ id: 3, priority: 5, signalTime: 90, title: '较早P5' }),
      signal({ id: 1, priority: 4, signalTime: 200, title: '重复旧值' }),
    ])

    expect(batch?.primary).toMatchObject({ id: 2, title: 'P5主消息' })
    expect(batch?.additionalCount).toBe(2)
    expect(batch?.total).toBe(3)
    expect(buildDecisionSignalToastBatch([])).toBeNull()
  })
})
