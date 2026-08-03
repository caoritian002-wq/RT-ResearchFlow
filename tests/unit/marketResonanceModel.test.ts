import { describe, expect, it } from 'vitest'
import {
  calculateMarketResonance,
  type MarketTrendSeries,
} from '../../electron/main/services/marketResonanceModel'

function series(code: string, moves: number[]): MarketTrendSeries {
  let change = 0
  const points = [{ time: toTime(0), change }]
  moves.forEach((move, index) => {
    change += move
    points.push({ time: toTime(index + 1), change })
  })
  return { code, name: code, tradeDate: '20260723', change, points }
}

function toTime(index: number): string {
  const totalMinutes = 9 * 60 + 30 + index
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`
}

describe('FR-244 市场共振模型', () => {
  it('识别与指数同向且取得超额收益的共振领涨行业', () => {
    const benchmarkMoves = Array.from({ length: 80 }, (_, index) => index % 4 === 0 ? -0.012 : 0.018)
    const sectorMoves = benchmarkMoves.map((move) => move * 1.8 + 0.004)
    const result = calculateMarketResonance(
      series('index', benchmarkMoves),
      series('sector', sectorMoves),
      0.78,
    )

    expect(result.state).toBe('leading_sync')
    expect(result.correlation).toBeGreaterThan(0.95)
    expect(result.directionAgreement).toBeGreaterThan(0.7)
    expect(result.excessReturn).toBeGreaterThan(0.25)
    expect(result.score).toBeGreaterThanOrEqual(75)
  })

  it('在指数下跌而行业逆势上涨时标记为抗跌，不伪装成共振', () => {
    const benchmarkMoves = Array.from({ length: 70 }, (_, index) => index % 2 === 0 ? -0.03 : -0.01)
    const sectorMoves = Array.from({ length: 70 }, (_, index) => index % 3 === 0 ? -0.01 : 0.02)
    const result = calculateMarketResonance(
      series('index', benchmarkMoves),
      series('sector', sectorMoves),
      0.62,
    )

    expect(result.state).toBe('defensive')
    expect(result.excessReturn).toBeGreaterThan(1)
  })

  it('通过移位相关识别行业相对指数的分钟领先或滞后', () => {
    const benchmarkMoves = Array.from({ length: 90 }, (_, index) => Math.sin(index * 1.7) * 0.04 + (index % 7 === 0 ? 0.03 : 0))
    const sectorMoves = [0, 0, ...benchmarkMoves.slice(0, -2)]
    const result = calculateMarketResonance(
      series('index', benchmarkMoves),
      series('sector', sectorMoves),
      0.55,
    )

    expect(result.lagMinutes).toBe(2)
  })

  it('对齐样本少于30个时保持证据不足和空统计', () => {
    const moves = Array.from({ length: 20 }, () => 0.02)
    const result = calculateMarketResonance(series('index', moves), series('sector', moves), null)

    expect(result.state).toBe('insufficient')
    expect(result.correlation).toBeNull()
    expect(result.directionAgreement).toBeNull()
    expect(result.lagMinutes).toBeNull()
  })
})

