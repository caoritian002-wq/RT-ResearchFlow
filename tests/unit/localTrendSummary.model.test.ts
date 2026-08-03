import { describe, expect, it } from 'vitest'
import { buildLocalTrendSummary } from '../../src/components/TrendWatcher/localTrendSummary'
import type { TrendWorkbenchItem } from '../../src/components/TrendWatcher/trendWorkbenchTypes'

function createItem(overrides: Partial<TrendWorkbenchItem> = {}): TrendWorkbenchItem {
  return {
    tsCode: '600519.SH',
    stockCode: '600519',
    stockName: '贵州茅台',
    categories: [],
    subCategories: [],
    groupTags: [],
    notes: [],
    isPortfolio: true,
    costPrice: null,
    profitPct: null,
    positionAdvice: null,
    positionAdviceReason: null,
    chip: null,
    totalScore: 78,
    maScore: 100,
    maAbove60: true,
    alphaScore: 57,
    drawdown: 3.2,
    turnoverRatio: null,
    macdAboveZero: true,
    bollAboveMid: true,
    price: 1500,
    change: 1.2,
    dataSource: 'eod',
    dataTime: '20260727',
    scoreSource: 'eod',
    scoreDate: '20260727',
    quoteSource: 'eod',
    quoteTime: '20260727',
    scoreVersion: 'v2',
    validWeight: 0.857,
    scoreDelta5d: 4,
    scoreDelta20d: 9,
    trendState: 'strong',
    scoreHistory: [],
    dataCoverage: { bars: 149, requiredBars: 60, latestTradeDate: '20260727', state: 'ready' },
    dimensions: {
      maArrangement: 100,
      maAbove60: 100,
      relativeStrength: 57,
      drawdownQuality: 84,
      turnoverQuality: null,
      macd: 100,
      boll: 100,
    },
    facts: {
      stockReturn20d: 8,
      benchmarkReturn20d: 4,
      excessReturn20d: 4,
      maxDrawdown20d: 3.2,
      turnoverRatio: null,
    },
    benchmarkHealth: {
      tsCode: '000300.SH',
      state: 'current',
      latestTradeDate: '20260727',
      expectedTradeDate: '20260727',
      bars: 149,
      requiredBars: 21,
      calendarSource: 'trade-calendar',
      refreshOutcome: 'not-requested',
      attempted: false,
      rowsWritten: 0,
      errorCode: null,
      message: '沪深300基准已对齐',
    },
    ...overrides,
  }
}

describe('local trend fact summary', () => {
  it('keeps a zero-key score usable while disclosing that turnover did not participate', () => {
    const item = createItem()
    const summary = buildLocalTrendSummary(item)

    expect(summary).toMatchObject({
      method: 'local-rules',
      status: 'degraded',
      headline: '趋势结构保持强势，长期均线仍完整',
      asOf: '20260727',
      validWeightPct: 86,
    })
    expect(summary.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '个股20日', value: '+8.0%' }),
      expect.objectContaining({ label: '沪深300同期', value: '+4.0%' }),
      expect.objectContaining({ label: '20日超额', value: '+4.0%' }),
      expect.objectContaining({ label: '20日最大回撤', value: '3.2%' }),
    ]))
    expect(summary.unknowns).toContain('换手率缺失，量能质量未参与评分')
    expect(summary.risks).toEqual([])
    expect(buildLocalTrendSummary(item)).toEqual(summary)
  })

  it('blocks a trend conclusion when history or valid weight is insufficient', () => {
    const summary = buildLocalTrendSummary(createItem({
      totalScore: null,
      validWeight: 0.55,
      maAbove60: null,
      macdAboveZero: null,
      scoreDelta5d: null,
      trendState: 'insufficient',
      dataCoverage: { bars: 32, requiredBars: 60, latestTradeDate: '20260727', state: 'partial' },
    }))

    expect(summary.status).toBe('insufficient')
    expect(summary.headline).toBe('日线覆盖 32/60，暂不形成趋势结构结论')
    expect(summary.unknowns).toEqual(expect.arrayContaining([
      'MA60上下文不足，长期均线位置未知',
      '评分轨迹不足，5日变化未知',
      'MACD零轴位置未知',
    ]))
  })

  it('blocks a complete conclusion when valid weight is not recorded', () => {
    const summary = buildLocalTrendSummary(createItem({ validWeight: null }))

    expect(summary.status).toBe('insufficient')
    expect(summary.headline).toBe('有效评分权重未知，暂不形成综合趋势结论')
    expect(summary.unknowns).toContain('有效评分权重未记录')
  })

  it('keeps absolute facts but suppresses relative claims when benchmark freshness is unknown', () => {
    const summary = buildLocalTrendSummary(createItem({
      benchmarkHealth: {
        ...createItem().benchmarkHealth!,
        state: 'calendar-unknown',
        latestTradeDate: '20260724',
        expectedTradeDate: '20260727',
        calendarSource: 'weekday-fallback',
        errorCode: 'CALENDAR_UNAVAILABLE',
        message: '交易日历未覆盖，基准日期待确认',
      },
    }))

    expect(summary.status).toBe('insufficient')
    expect(summary.headline).toContain('沪深300基准尚未确认')
    expect(summary.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '个股20日', value: '+8.0%' }),
    ]))
    expect(summary.facts.map((fact) => fact.label)).not.toEqual(expect.arrayContaining(['沪深300同期', '20日超额', '综合趋势分']))
    expect(summary.unknowns).toContain('交易日历未覆盖，基准日期待确认')
  })

  it('states broken-structure risks without producing trading instructions', () => {
    const summary = buildLocalTrendSummary(createItem({
      totalScore: 38,
      maAbove60: false,
      macdAboveZero: false,
      bollAboveMid: false,
      validWeight: 1,
      scoreDelta5d: -7,
      trendState: 'broken',
      facts: {
        stockReturn20d: -10,
        benchmarkReturn20d: -2,
        excessReturn20d: -8,
        maxDrawdown20d: 12,
        turnoverRatio: 1.4,
      },
    }))

    expect(summary.status).toBe('ready')
    expect(summary.headline).toBe('长期趋势结构处于破坏状态')
    expect(summary.risks).toEqual(expect.arrayContaining([
      '现价低于MA60，长期均线结构处于破坏状态',
      '近20日落后沪深300 8.0个百分点',
      '近20日最大回撤达到 12.0%',
      '近5个交易日趋势分下降 7.0分',
      'MACD DEA位于零轴下方',
      '现价位于BOLL中轨下方',
    ]))
    const output = JSON.stringify(summary)
    expect(output).not.toMatch(/买入|卖出|加仓|减仓|目标价|收益承诺/)
  })
})
