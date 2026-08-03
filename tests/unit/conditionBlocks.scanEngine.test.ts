import { describe, expect, it } from 'vitest'
import type { BlockStrategyTemplate } from '../../electron/main/services/conditionBlocks/types'
import { __privateForConditionBlockScanTests, resolveConditionScanDateRange, resolveConditionScanMode } from '../../electron/main/services/conditionBlocks/blockScanEngine'
import { __privateForMinuteDataTests } from '../../electron/main/services/minuteData/sinaHistory5mProvider'
import { getDefaultApproximateCapability } from '../../electron/main/services/minuteData/minuteDataProviderRegistry'

function template(overrides: Partial<BlockStrategyTemplate['scope']> = {}): BlockStrategyTemplate {
  return {
    key: 'scan_test',
    name: '扫描测试',
    description: '扫描测试',
    version: 1,
    enabled: true,
    executionMode: 'strict',
    scoreThreshold: 70,
    scope: {
      dateStart: '',
      dateEnd: '',
      lookbackDays: 2,
      stockPoolSources: ['portfolio'],
      excludeST: true,
      excludeBJ: false,
      minDailyAmount: null,
      ...overrides,
    },
    root: { id: 'root', operator: 'AND', enabled: true, children: [] },
  }
}

describe('condition block scan engine date range', () => {
  it('未指定日期时按 lookbackDays 选择本地最近交易日范围', () => {
    const result = resolveConditionScanDateRange(template(), ['20260612', '20260615', '20260616'])

    expect(result).toEqual({ dateStart: '20260615', dateEnd: '20260616' })
  })

  it('指定 dateEnd 时只回看不晚于该日期的数据', () => {
    const result = resolveConditionScanDateRange(template({ dateEnd: '20260615', lookbackDays: 2 }), ['20260612', '20260615', '20260616'])

    expect(result).toEqual({ dateStart: '20260612', dateEnd: '20260615' })
  })

  it('显式指定起止日期时优先生效', () => {
    const result = resolveConditionScanDateRange(template({ dateStart: '20260601', dateEnd: '20260610' }), ['20260612', '20260615'])

    expect(result).toEqual({ dateStart: '20260601', dateEnd: '20260610' })
  })
})

describe('condition block scan mode', () => {
  it('默认使用完整扫描模式', () => {
    expect(resolveConditionScanMode(undefined)).toBe('complete')
    expect(resolveConditionScanMode('unknown')).toBe('complete')
  })

  it('显式 quick 时使用快速扫描模式', () => {
    expect(resolveConditionScanMode('quick')).toBe('quick')
  })
})

describe('condition block minute data guard', () => {
  it('免费用户的分钟数据失败不触发全局失败保护', () => {
    const approximateCapability = getDefaultApproximateCapability()
    const exactCapability = __privateForConditionBlockScanTests.exactMinuteCapability

    expect(__privateForConditionBlockScanTests.shouldCountMinuteFailureForGuard({ status: 'failed', capability: approximateCapability, bars: [] }, 'free')).toBe(false)
    expect(__privateForConditionBlockScanTests.shouldCountMinuteFailureForGuard({ status: 'empty', capability: approximateCapability, bars: [] }, 'free')).toBe(false)
    expect(__privateForConditionBlockScanTests.shouldCountMinuteFailureForGuard({ status: 'failed', capability: exactCapability, bars: [] }, 'free')).toBe(false)
    expect(__privateForConditionBlockScanTests.shouldCountMinuteFailureForGuard({ status: 'failed', capability: exactCapability, bars: [] }, 'pro')).toBe(true)
  })

  it('测试夹具可构造新浪5分钟能力, 避免0评估摘要误判为本地1分钟', () => {
    const rows = __privateForMinuteDataTests.mapRows('300308.SZ', '20260525', [
      { day: '2026-05-25 09:30:00', open: '9.8', high: '10.2', low: '9.7', close: '10', volume: '800' },
    ])
    const capability = getDefaultApproximateCapability()

    expect(rows).toHaveLength(1)
    expect(capability.providerId).toBe('sinaHistory5m')
    expect(capability.granularity).toBe('5m')
    expect(capability.isApproximate).toBe(true)
  })
})
