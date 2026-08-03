import { describe, expect, it } from 'vitest'
import {
  buildFirstYinWorkbenchJudgment,
  judgeFirstYinStock,
  type FirstYinJudgmentInput,
} from '../../electron/main/services/firstYinDipJudgmentModel'

function input(overrides: Partial<FirstYinJudgmentInput> = {}): FirstYinJudgmentInput {
  return {
    tsCode: '000001.SZ',
    stockCode: '000001',
    stockName: '状态样本',
    dataMode: 'eod',
    peakDate: '20260720',
    peakBoards: 4,
    peakClose: 10.8,
    peakTurnoverRate: 18,
    divergenceDate: '20260721',
    divergenceOpen: 10.5,
    divergenceHigh: 10.6,
    divergenceLow: 9.8,
    divergenceClose: 10.1,
    divergencePctChg: -6.48,
    divergenceTurnoverRate: 16,
    currentDate: '20260721',
    sessionsSinceDivergence: 0,
    currentPrice: 10.1,
    currentClose: 10.1,
    currentPctChg: -6.48,
    currentTurnoverRate: 16,
    currentIsClosed: true,
    themeName: '算力',
    themeLimitUpCount: 3,
    ...overrides,
  }
}

describe('FR-250 首阴回踩状态机', () => {
  it('只把事件首日识别为首次分歧，不由总分替代状态', () => {
    const result = judgeFirstYinStock(input())
    expect(result.state).toBe('divergence')
    expect(result.title).toBe('首次分歧')
    expect(result.metrics.isYin).toBe(true)
  })

  it('分歧后三个交易日内未越过边界时保持修复等待', () => {
    const result = judgeFirstYinStock(input({
      currentDate: '20260723',
      sessionsSinceDivergence: 2,
      currentPrice: 10.4,
      currentClose: 10.4,
      currentPctChg: 1.2,
    }))
    expect(result.state).toBe('waiting')
    expect(result.metrics.repairProgressPct).toBeGreaterThan(70)
  })

  it('只有后续收盘站上分歧日高点才形成修复确认', () => {
    const closed = judgeFirstYinStock(input({
      currentDate: '20260722',
      sessionsSinceDivergence: 1,
      currentPrice: 10.72,
      currentClose: 10.72,
      currentPctChg: 6.1,
    }))
    expect(closed.state).toBe('confirmed')

    const realtime = judgeFirstYinStock(input({
      dataMode: 'realtime',
      currentDate: '20260722',
      sessionsSinceDivergence: 1,
      currentPrice: 10.72,
      currentClose: null,
      currentIsClosed: false,
    }))
    expect(realtime.state).toBe('waiting')
    expect(realtime.risks.join('')).toContain('只有收盘站稳')
  })

  it('收盘跌破分歧低点或修复窗口超时后进入失败', () => {
    const broken = judgeFirstYinStock(input({
      currentDate: '20260722',
      sessionsSinceDivergence: 1,
      currentPrice: 9.7,
      currentClose: 9.7,
    }))
    expect(broken.state).toBe('failed')

    const timeout = judgeFirstYinStock(input({
      currentDate: '20260724',
      sessionsSinceDivergence: 3,
      currentPrice: 10.2,
      currentClose: 10.2,
    }))
    expect(timeout.state).toBe('failed')
  })

  it('缺失换手保持未知，不伪装成0%换手不足', () => {
    const result = judgeFirstYinStock(input({
      peakTurnoverRate: null,
      divergenceTurnoverRate: null,
      currentTurnoverRate: null,
    }))
    const turnover = result.dimensions.find((item) => item.key === 'turnover')
    expect(turnover?.score).toBeNull()
    expect(turnover?.value).toBe('待补')
    expect(result.missingFields).toContain('分歧日换手率')
  })

  it('盘中跌破只提示触及失效线，不冒充收盘失败', () => {
    const result = judgeFirstYinStock(input({
      dataMode: 'realtime',
      currentDate: '20260722',
      sessionsSinceDivergence: 1,
      currentPrice: 9.7,
      currentClose: null,
      currentIsClosed: false,
    }))
    expect(result.state).toBe('waiting')
    expect(result.risks.join('')).toContain('触及失效线')
  })

  it('工作台按状态给出结论，不把候选数量当作确认', () => {
    const divergence = judgeFirstYinStock(input())
    const waiting = judgeFirstYinStock(input({ currentDate: '20260722', sessionsSinceDivergence: 1, currentPrice: 10.3, currentClose: 10.3 }))
    const confirmed = judgeFirstYinStock(input({ currentDate: '20260722', sessionsSinceDivergence: 1, currentPrice: 10.7, currentClose: 10.7 }))
    const result = buildFirstYinWorkbenchJudgment([divergence, waiting, confirmed])
    expect(result.stance).toBe('confirmed')
    expect(result.confirmedCount).toBe(1)
    expect(result.summary).toContain('收盘事实')
  })
})
