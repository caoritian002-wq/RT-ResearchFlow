import { describe, expect, it } from 'vitest'
import type { CyqPerfCacheRow } from '../../electron/main/database/types'
import {
  buildChipMetricChanges,
  buildChipStructureSnapshot,
  getChipStructureSummaries,
  normalizeChipPercent,
  normalizeChipStructureTsCode,
  selectCurrentChipStructureSnapshot,
} from '../../electron/main/services/chipStructureService'
import { classifyChipStructureSyncResult } from '../../electron/main/services/chipStructureSyncService'

function createPerf(overrides: Partial<CyqPerfCacheRow> = {}): CyqPerfCacheRow {
  return {
    tsCode: '600000.SH',
    tradeDate: '20260710',
    hisLow: 5,
    hisHigh: 15,
    cost5Pct: 7,
    cost15Pct: 8,
    cost50Pct: 9,
    cost85Pct: 10,
    cost95Pct: 11,
    weightAvg: 9,
    winnerRate: 60,
    winnerRateUnit: 'percent',
    fetchedAt: 1000,
    ...overrides,
  }
}

const points = [
  { price: 7, percent: 10 },
  { price: 8.5, percent: 20 },
  { price: 9.5, percent: 28 },
  { price: 10.5, percent: 42 },
]

describe('chipStructureService', () => {
  it('按显式单位归一获利比例，不由组件猜测量纲', () => {
    expect(normalizeChipPercent(3.52, 'percent')).toBe(3.52)
    expect(normalizeChipPercent(0.6, 'ratio')).toBe(60)
    expect(normalizeChipPercent(120, 'percent')).toBe(100)
  })

  it('基于同日事实计算白盒结构并通过一致性校验', () => {
    const snapshot = buildChipStructureSnapshot({
      latestTradeDate: '20260710',
      close: { tradeDate: '20260710', value: 10 },
      perf: createPerf(),
      chips: { tradeDate: '20260710', points },
    })

    expect(snapshot).toMatchObject({
      tradeDate: '20260710',
      freshnessStatus: 'current',
      completenessStatus: 'complete',
      consistencyStatus: 'matched',
      missingReasons: [],
    })
    expect(snapshot.metrics).toMatchObject({
      winnerRatePct: 60,
      recomputedWinnerRatePct: 58,
      thickProfitPct: 30,
      thinProfitPct: 30,
      trappedPct: 40,
      deepLowPct: 10,
      consistencyDeviationPct: 2,
    })
    expect(snapshot.metrics.costConcentration).toBeCloseTo(200 / 9)
    expect(snapshot.metrics.costDeviationPct).toBeCloseTo(100 / 9)
  })

  it('将新北交所 920 前缀规范化为 BJ 后缀', () => {
    expect(normalizeChipStructureTsCode('920001')).toBe('920001.BJ')
    expect(normalizeChipStructureTsCode('920001.BJ')).toBe('920001.BJ')
    expect(normalizeChipStructureTsCode('900001')).toBe('900001.SH')
  })

  it('偏差超过三个百分点时标记 warning', () => {
    const snapshot = buildChipStructureSnapshot({
      latestTradeDate: '20260710',
      close: { tradeDate: '20260710', value: 10 },
      perf: createPerf({ winnerRate: 50 }),
      chips: { tradeDate: '20260710', points },
    })

    expect(snapshot.consistencyStatus).toBe('warning')
    expect(snapshot.metrics.consistencyDeviationPct).toBe(8)
  })

  it('数据日期不一致时不跨日拼接派生指标', () => {
    const snapshot = buildChipStructureSnapshot({
      latestTradeDate: '20260710',
      close: { tradeDate: '20260710', value: 10 },
      perf: createPerf({ tradeDate: '20260709' }),
      chips: { tradeDate: '20260710', points },
    })

    expect(snapshot.tradeDate).toBeNull()
    expect(snapshot.completenessStatus).toBe('partial')
    expect(snapshot.consistencyStatus).toBe('not_comparable')
    expect(snapshot.missingReasons).toContain('DATE_MISMATCH')
    expect(snapshot.metrics.winnerRatePct).toBeNull()
  })

  it('两个筹码源均缺失时明确阻塞', () => {
    const snapshot = buildChipStructureSnapshot({
      latestTradeDate: '20260710',
      close: { tradeDate: '20260710', value: 10 },
      perf: null,
      chips: null,
    })

    expect(snapshot.completenessStatus).toBe('blocked')
    expect(snapshot.consistencyStatus).toBe('not_comparable')
    expect(snapshot.missingReasons).toEqual(['CYQ_PERF_MISSING', 'CYQ_CHIPS_MISSING'])
  })

  it('按有效筹码日而不是自然日计算 1/3/5/12 日变化', () => {
    const snapshots = Array.from({ length: 13 }, (_, index) => buildChipStructureSnapshot({
      latestTradeDate: '20260720',
      close: { tradeDate: `202607${String(index + 1).padStart(2, '0')}`, value: 10 },
      perf: createPerf({
        tradeDate: `202607${String(index + 1).padStart(2, '0')}`,
        winnerRate: 40 + index,
      }),
      chips: {
        tradeDate: `202607${String(index + 1).padStart(2, '0')}`,
        points,
      },
    }))

    const changes = buildChipMetricChanges(snapshots)
    expect(changes.winnerRate).toEqual([
      { days: 1, value: 1, reason: null },
      { days: 3, value: 3, reason: null },
      { days: 5, value: 5, reason: null },
      { days: 12, value: 12, reason: null },
    ])
  })

  it('双源独立同步时区分成功、部分成功和失败', () => {
    expect(classifyChipStructureSyncResult(true, true)).toBe('success')
    expect(classifyChipStructureSyncResult(true, false)).toBe('partial')
    expect(classifyChipStructureSyncResult(false, true)).toBe('partial')
    expect(classifyChipStructureSyncResult(false, false)).toBe('failed')
  })

  it('只有价格级筹码时保留事实并标记 partial', () => {
    const snapshot = buildChipStructureSnapshot({
      latestTradeDate: '20260710',
      close: { tradeDate: '20260710', value: 10 },
      perf: null,
      chips: { tradeDate: '20260710', points },
    })

    expect(snapshot.tradeDate).toBe('20260710')
    expect(snapshot.completenessStatus).toBe('partial')
    expect(snapshot.missingReasons).toEqual(['CYQ_PERF_MISSING'])
    expect(snapshot.metrics.recomputedWinnerRatePct).toBe(58)
  })

  it('默认选择最新事实日期，不用较旧 complete 隐藏较新 partial', () => {
    const complete = buildChipStructureSnapshot({
      latestTradeDate: '20260710',
      close: { tradeDate: '20260709', value: 10 },
      perf: createPerf({ tradeDate: '20260709' }),
      chips: { tradeDate: '20260709', points },
    })
    const latestPartial = buildChipStructureSnapshot({
      latestTradeDate: '20260710',
      close: { tradeDate: '20260710', value: 10 },
      perf: null,
      chips: { tradeDate: '20260710', points },
    })

    expect(selectCurrentChipStructureSnapshot([complete, latestPartial])).toBe(latestPartial)
    expect(selectCurrentChipStructureSnapshot([complete, latestPartial], undefined, 'latest_complete')).toBe(complete)
    expect(selectCurrentChipStructureSnapshot(
      [complete, latestPartial],
      undefined,
      'latest_complete',
      '20260708',
    )).toBeUndefined()
    expect(selectCurrentChipStructureSnapshot([complete, latestPartial], '20260709')).toBe(complete)
    expect(selectCurrentChipStructureSnapshot([complete, latestPartial], '20260708')).toBeUndefined()
  })

  it('最近完整策略没有完整快照时仍返回最新部分事实', () => {
    const olderPartial = buildChipStructureSnapshot({
      latestTradeDate: '20260710',
      close: { tradeDate: '20260709', value: 10 },
      perf: createPerf({ tradeDate: '20260709' }),
      chips: null,
    })
    const latestPartial = buildChipStructureSnapshot({
      latestTradeDate: '20260710',
      close: { tradeDate: '20260710', value: 10 },
      perf: null,
      chips: { tradeDate: '20260710', points },
    })

    expect(selectCurrentChipStructureSnapshot(
      [olderPartial, latestPartial],
      undefined,
      'latest_complete',
    )).toBe(latestPartial)
  })

  it('批量摘要不装配机构证据和兼容详情', () => {
    const preparedSql: string[] = []
    const db = {
      prepare(sql: string) {
        preparedSql.push(sql)
        return {
          all: () => [],
          get: () => undefined,
        }
      },
    }

    const summaries = getChipStructureSummaries(db as never, [
      { tsCode: '600000.SH', stockName: '浦发银行' },
    ])

    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      tsCode: '600000.SH',
      thinProfitPct: null,
      deepLowPct: null,
      completenessStatus: 'blocked',
    })
    expect(preparedSql.join('\n')).not.toMatch(/top_inst|chip_monitor/i)
  })
})
