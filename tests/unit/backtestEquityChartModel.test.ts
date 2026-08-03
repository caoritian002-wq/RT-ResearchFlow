import { describe, expect, it } from 'vitest'
import { buildBacktestEquityChartData } from '../../src/components/StrategyBacktest/BacktestEquityChart'

describe('buildBacktestEquityChartData', () => {
  it('为单一实现日补充可见基准点并把回撤绘制在零轴下方', () => {
    const data = buildBacktestEquityChartData([{
      date: '20260720',
      realizedReturnPct: -19.5572,
      tradeCount: 25,
      equity: 0.804428,
      drawdownPct: 19.5572,
    }], '20260713')

    expect(data).toHaveLength(2)
    expect(data[0]).toMatchObject({
      date: '20260713',
      axisLabel: '起点',
      cumulativeReturnPct: 0,
      chartDrawdownPct: 0,
      baseline: true,
    })
    expect(data[1]).toMatchObject({
      date: '20260720',
      axisLabel: '07/20',
      tradeCount: 25,
      chartDrawdownPct: -19.5572,
      baseline: false,
    })
    expect(data[1].cumulativeReturnPct).toBeCloseTo(-19.5572, 4)
  })

  it('多个实现日保持报告点数且不伪造额外交易日', () => {
    const data = buildBacktestEquityChartData([
      { date: '20260717', realizedReturnPct: 2, tradeCount: 1, equity: 1.02, drawdownPct: 0 },
      { date: '20260720', realizedReturnPct: -1, tradeCount: 1, equity: 1.0098, drawdownPct: 1 },
    ], '20260713')

    expect(data).toHaveLength(2)
    expect(data.every((point) => !point.baseline)).toBe(true)
    expect(data[1].chartDrawdownPct).toBe(-1)
  })
})
