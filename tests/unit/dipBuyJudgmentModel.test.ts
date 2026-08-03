import { describe, expect, it } from 'vitest'
import {
  buildDipModeJudgment,
  dipGate,
  judgeArbitrageDip,
  judgeRotationDip,
  judgeTrendDip,
} from '../../electron/main/services/dipBuyJudgmentModel'

describe('dipBuyJudgmentModel', () => {
  it('趋势低吸只有近期强势、均线支撑和趋势方向同时通过才形成重点候选', () => {
    const result = judgeTrendDip({
      dataMode: 'eod',
      currentPrice: 12.08,
      currentIsLimitUp: false,
      recentPeakBoards: 4,
      recentPeakDate: '20260717',
      ma10: 12,
      ma20: 11.8,
      ma30: 11.5,
      ma20Slope5Pct: 1.2,
      nearestMaLabel: 'MA10',
      distanceToNearestMaPct: 0.67,
      themeName: '光模块',
      themeLimitUpCount: 2,
    })
    expect(result.tier).toBe('focus')
    expect(result.conditions.every((condition) => !condition.required || condition.status === 'passed')).toBe(true)
    expect(result.rankScore).toBeGreaterThanOrEqual(85)
  })

  it('趋势低吸不会把向下的MA20仅因贴近均线而判为候选', () => {
    const result = judgeTrendDip({
      dataMode: 'eod',
      currentPrice: 12,
      currentIsLimitUp: false,
      recentPeakBoards: 3,
      recentPeakDate: '20260717',
      ma10: 12,
      ma20: 12.2,
      ma30: 11.8,
      ma20Slope5Pct: -1.1,
      nearestMaLabel: 'MA10',
      distanceToNearestMaPct: 0,
      themeName: 'PCB',
      themeLimitUpCount: 1,
    })
    expect(result.tier).toBe('rejected')
    expect(result.conditions.find((condition) => condition.key === 'slopeStable')?.status).toBe('failed')
  })

  it('套利低吸要求冰点、题材退潮、受控下跌及资金或缩量确认', () => {
    const result = judgeArbitrageDip({
      dataMode: 'eod',
      marketLimitUpCount: 18,
      retreatThemeCount: 2,
      recentLimitUpDate: '20260717',
      themeName: 'CPO',
      themeRetreated: true,
      currentPctChg: -3.2,
      currentIsLimitDown: false,
      drop5dPct: -7.4,
      netMoneyFlowAmount: 3200,
      volumeRatio5: 0.68,
    })
    expect(result.tier).toBe('focus')
    expect(result.conditions.find((condition) => condition.key === 'capitalConfirm')?.status).toBe('passed')
  })

  it('盘中缺少moneyflow时不会把未完成成交量冒充缩量确认', () => {
    const result = judgeArbitrageDip({
      dataMode: 'realtime',
      marketLimitUpCount: 16,
      retreatThemeCount: 1,
      recentLimitUpDate: '20260717',
      themeName: '机器人',
      themeRetreated: true,
      currentPctChg: -2.1,
      currentIsLimitDown: false,
      drop5dPct: -5,
      netMoneyFlowAmount: null,
      volumeRatio5: null,
    })
    expect(result.tier).toBe('insufficient')
    expect(result.conditions.find((condition) => condition.key === 'capitalConfirm')).toMatchObject({ status: 'unknown', value: '待补' })
    expect(result.risks.join(' ')).toContain('盘中累计成交量不能冒充收盘缩量')
  })

  it('涨停数不少于30时套利环境直接不通过', () => {
    const result = judgeArbitrageDip({
      dataMode: 'eod',
      marketLimitUpCount: 45,
      retreatThemeCount: 2,
      recentLimitUpDate: '20260717',
      themeName: '算力',
      themeRetreated: true,
      currentPctChg: -2,
      currentIsLimitDown: false,
      drop5dPct: -4,
      netMoneyFlowAmount: 100,
      volumeRatio5: 0.7,
    })
    expect(result.tier).toBe('rejected')
    expect(result.conditions.find((condition) => condition.key === 'marketIce')?.status).toBe('failed')
  })

  it('轮动低吸只接受前一日五板以上、打开高度且仍红盘的龙头关系', () => {
    const result = judgeRotationDip({
      dataMode: 'eod',
      leaderName: '高度龙头',
      leaderPreviousBoards: 6,
      leaderIsLimitUp: false,
      leaderPctChg: 4,
      sameTheme: true,
      themeName: '先进封装',
      themeLimitUpCount: 2,
      candidateRecentPeakBoards: 1,
      candidatePctChg: 0.8,
    })
    expect(result.tier).toBe('focus')
    expect(result.conditions.find((condition) => condition.key === 'laggingRange')?.status).toBe('passed')
  })

  it('龙头仍封涨停时不会提前输出轮动候选', () => {
    const result = judgeRotationDip({
      dataMode: 'realtime',
      leaderName: '高度龙头',
      leaderPreviousBoards: 7,
      leaderIsLimitUp: true,
      leaderPctChg: 10,
      sameTheme: true,
      themeName: '先进封装',
      themeLimitUpCount: 3,
      candidateRecentPeakBoards: 0,
      candidatePctChg: 1,
    })
    expect(result.tier).toBe('rejected')
    expect(result.conditions.find((condition) => condition.key === 'leaderOpened')?.status).toBe('failed')
  })

  it('工作台明确区分环境阻断、筛除和数据不足', () => {
    const candidate = judgeArbitrageDip({
      dataMode: 'eod',
      marketLimitUpCount: 50,
      retreatThemeCount: 0,
      recentLimitUpDate: '20260717',
      themeName: 'CPO',
      themeRetreated: false,
      currentPctChg: -2,
      currentIsLimitDown: false,
      drop5dPct: -4,
      netMoneyFlowAmount: null,
      volumeRatio5: null,
    })
    const result = buildDipModeJudgment({
      mode: 'arbitrageDip',
      gates: [dipGate.failed('marketIce', '市场冰点', '50只涨停', '涨停数不少于30')],
      judgments: [candidate],
      screenedCount: 1,
    })
    expect(result.status).toBe('blocked')
    expect(result.rejectedCount).toBe(1)
    expect(result.title).toContain('前置环境未成立')
  })
})
