import { describe, expect, it } from 'vitest'
import { assessBacktestCredibility, type CredibilityObservation } from '../../electron/main/services/backtest/credibility'
import type { DataQualitySnapshot, DataTrustStatus } from '../../electron/main/services/dataQualityService'

function quality(overrides: Partial<Record<'dailyMarket' | 'tradeCalendar' | 'benchmarks', DataTrustStatus>> = {}): DataQualitySnapshot {
  const keys = ['dailyMarket', 'tradeCalendar', 'benchmarks'] as const
  const datasets = keys.map((key, index) => ({
    key,
    title: key,
    status: overrides[key] ?? 'reliable',
    summary: 'fixture',
    recordCount: 100 + index,
    earliestDate: '20240101',
    latestDate: '20260724',
    sourceLabel: 'fixture',
    affectedModules: ['策略回测'],
    reasons: overrides[key] && overrides[key] !== 'reliable'
      ? [{ code: `${key.toUpperCase()}_ISSUE`, message: 'fixture issue', severity: 'warning' as const }]
      : [],
    action: null,
  }))
  const summary = { reliable: 0, degraded: 0, blocked: 0 }
  for (const dataset of datasets) summary[dataset.status] += 1
  return {
    status: summary.blocked > 0 ? 'blocked' : summary.degraded > 0 ? 'degraded' : 'reliable',
    checkedAt: 1,
    fingerprint: 'global-fingerprint',
    persistedRunId: null,
    persistedAt: null,
    summary,
    datasets,
  }
}

function observations(total: number, signalDays: number, missing = 0): CredibilityObservation[] {
  return Array.from({ length: total }, (_, index) => {
    const day = 1 + (index % Math.max(1, signalDays))
    const signalDate = `202601${String(day).padStart(2, '0')}`
    const entryDate = `202602${String(day).padStart(2, '0')}`
    const valid = index >= missing
    return {
      signalDate,
      entryDate: valid ? entryDate : null,
      exitDate: valid ? `202603${String(day).padStart(2, '0')}` : null,
      returnPct: valid ? (index % 3 === 0 ? -1 : 2) : null,
      valid,
      entryBasis: 'next_trade_open',
    }
  })
}

describe('backtest credibility', () => {
  it('核心数据、30笔和10个信号日满足时允许多策略同口径比较', () => {
    const result = assessBacktestCredibility({
      dataQuality: quality(), observations: observations(30, 10), strategyCount: 2,
      executionProfile: 'effectiveness', assessedAt: 100,
    })
    expect(result.assessment.conclusion).toBe('comparable')
    expect(result.assessment.gates.find(gate => gate.key === 'sampleAdequacy')?.status).toBe('reliable')
    expect(result.status).toBe('degraded')
  })

  it('29笔或只有9个信号日时降级为探索性参考', () => {
    const lowCount = assessBacktestCredibility({ dataQuality: quality(), observations: observations(29, 10), strategyCount: 2, executionProfile: 'effectiveness' })
    const concentrated = assessBacktestCredibility({ dataQuality: quality(), observations: observations(30, 9), strategyCount: 2, executionProfile: 'effectiveness' })
    expect(lowCount.assessment.conclusion).toBe('exploratory')
    expect(lowCount.reasons).toContain('SAMPLE_SIZE_LOW')
    expect(concentrated.assessment.conclusion).toBe('exploratory')
    expect(concentrated.reasons).toContain('SIGNAL_DATE_CONCENTRATED')
  })

  it('20%缺失率仍通过数量门，超过20%才降级', () => {
    const exact = assessBacktestCredibility({ dataQuality: quality(), observations: observations(40, 10, 8), strategyCount: 2, executionProfile: 'effectiveness' })
    const over = assessBacktestCredibility({ dataQuality: quality(), observations: observations(40, 10, 9), strategyCount: 2, executionProfile: 'effectiveness' })
    expect(exact.assessment.gates.find(gate => gate.key === 'sampleAdequacy')?.status).toBe('reliable')
    expect(exact.reasons).not.toContain('DROP_RATE_HIGH')
    expect(over.assessment.gates.find(gate => gate.key === 'sampleAdequacy')?.status).toBe('degraded')
    expect(over.reasons).toContain('DROP_RATE_HIGH')
  })

  it('时间顺序违规或关键数据阻断时结论不可用', () => {
    const invalidTime = observations(30, 10)
    invalidTime[0] = { ...invalidTime[0], entryDate: invalidTime[0].signalDate }
    const temporal = assessBacktestCredibility({ dataQuality: quality(), observations: invalidTime, strategyCount: 2, executionProfile: 'effectiveness' })
    const blockedData = assessBacktestCredibility({ dataQuality: quality({ dailyMarket: 'blocked' }), observations: observations(30, 10), strategyCount: 2, executionProfile: 'effectiveness' })
    expect(temporal.assessment.conclusion).toBe('unavailable')
    expect(temporal.reasons).toContain('TEMPORAL_ORDER_VIOLATION')
    expect(blockedData.assessment.conclusion).toBe('unavailable')
    expect(blockedData.reasons).toContain('DATA_QUALITY_BLOCKED')
  })

  it('数据降级保留探索结果，前后半区间反向时明确提示时期敏感', () => {
    const rows = observations(30, 10).map((item, index) => ({ ...item, returnPct: index < 15 ? 2 : -2 }))
    const result = assessBacktestCredibility({ dataQuality: quality({ benchmarks: 'degraded' }), observations: rows, strategyCount: 2, executionProfile: 'effectiveness' })
    expect(result.assessment.conclusion).toBe('exploratory')
    expect(result.reasons).toEqual(expect.arrayContaining(['DATA_QUALITY_DEGRADED', 'PERIOD_DIRECTION_UNSTABLE']))
    expect(result.assessment.periodSlices).toHaveLength(2)
  })

  it('相关数据质量投影顺序稳定且忽略全局快照ID', () => {
    const first = quality()
    const second = { ...quality(), checkedAt: 999, persistedRunId: 42, fingerprint: 'different-global' }
    second.datasets = [...second.datasets].reverse()
    const left = assessBacktestCredibility({ dataQuality: first, observations: observations(30, 10), strategyCount: 2, executionProfile: 'effectiveness' })
    const right = assessBacktestCredibility({ dataQuality: second, observations: observations(30, 10), strategyCount: 2, executionProfile: 'effectiveness' })
    expect(left.assessment.dataQualityFingerprint).toBe(right.assessment.dataQualityFingerprint)
  })
})
