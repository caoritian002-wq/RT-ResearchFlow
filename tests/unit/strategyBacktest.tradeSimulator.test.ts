import { describe, expect, it } from 'vitest'
import { simulateTrade } from '../../electron/main/services/backtest/tradeSimulator'
import type {
  BacktestSignal,
  OHLC,
  TradePlan
} from '../../electron/main/services/backtest/types'

const SIG: BacktestSignal = {
  strategyKey: 'shortTerm.test',
  tsCode: '000001.SZ',
  tradeDate: '20260101',
  strength: 1
}
const NO_FEE: TradePlan = { entryRule: 'nextOpen', holdDays: 1, feeBps: 0 }

function row(d: string, o: number, h: number, l: number, c: number): OHLC {
  return { tradeDate: d, open: o, high: h, low: l, close: c }
}

describe('simulateTrade - 入场与无前视', () => {
  it('nextOpen: T+1 开盘入场, 到期收盘出场', () => {
    const rows = [
      row('20260101', 9.9, 10, 9.8, 10),
      row('20260102', 10, 10.5, 9.9, 10.5),
      row('20260103', 10.5, 12, 10, 11)
    ]
    const r = simulateTrade(SIG, NO_FEE, rows)
    expect(r.valid).toBe(true)
    expect(r.entryDate).toBe('20260102')
    expect(r.entryPrice).toBe(10)
    expect(r.exitDate).toBe('20260103')
    expect(r.exitPrice).toBe(11)
    expect(r.exitReason).toBe('hold_expired')
    expect(r.returnPct).toBeCloseTo(10, 6)
    expect(r.grossReturnPct).toBeCloseTo(10, 6)
    expect(r.netReturnPct).toBeCloseTo(10, 6)
    expect(r.status).toBe('executed')
  })

  it('入场严格晚于信号日, 不会用信号日当天成交', () => {
    const rows = [
      row('20260101', 9.9, 10, 9.8, 10),
      row('20260102', 10, 10.5, 9.9, 10.5),
      row('20260103', 10.5, 12, 10, 11)
    ]
    const r = simulateTrade(SIG, NO_FEE, rows)
    expect(r.entryDate).not.toBe('20260101')
  })

  it('未来数据不足以完成持有期时返回 data_insufficient', () => {
    const rows = [
      row('20260101', 9.9, 10, 9.8, 10),
      row('20260102', 10, 10.5, 9.9, 10.5)
    ]
    const r = simulateTrade(SIG, NO_FEE, rows)
    expect(r.valid).toBe(false)
    expect(r.exitReason).toBe('data_insufficient')
    expect(r.returnPct).toBeNull()
    expect(r.status).toBe('data_insufficient')
  })

  it('停牌缺口按该股票自身行推进, 自动跳过停牌日', () => {
    const rows = [
      row('20260101', 9.9, 10, 9.8, 10),
      row('20260105', 10, 10.5, 9.9, 10.5),
      row('20260106', 10.5, 12, 10, 11)
    ]
    const r = simulateTrade(SIG, NO_FEE, rows)
    expect(r.entryDate).toBe('20260105')
    expect(r.exitDate).toBe('20260106')
    expect(r.returnPct).toBeCloseTo(10, 6)
  })
})

describe('simulateTrade - 止盈止损与费用', () => {
  const longHold: TradePlan = { entryRule: 'nextOpen', holdDays: 3, feeBps: 0 }

  it('止损触发, 且同日先止损后止盈', () => {
    const plan: TradePlan = { ...longHold, stopLoss: 5, stopProfit: 10 }
    const rows = [
      row('20260101', 9.9, 10, 9.8, 10),
      row('20260102', 10, 10.2, 9.8, 10),
      row('20260103', 10, 11.5, 9.0, 9.2),
      row('20260104', 9.2, 9.5, 9.0, 9.3),
      row('20260105', 9.3, 9.6, 9.1, 9.4)
    ]
    const r = simulateTrade(SIG, plan, rows)
    expect(r.exitReason).toBe('stop_loss')
    expect(r.exitDate).toBe('20260103')
    expect(r.exitPrice).toBeCloseTo(9.5, 6)
    expect(r.returnPct).toBeCloseTo(-5, 6)
  })

  it('止盈触发', () => {
    const plan: TradePlan = { ...longHold, stopProfit: 8 }
    const rows = [
      row('20260101', 9.9, 10, 9.8, 10),
      row('20260102', 10, 10.2, 9.9, 10),
      row('20260103', 10, 10.9, 10, 10.6),
      row('20260104', 10.6, 10.7, 10.4, 10.5),
      row('20260105', 10.5, 10.6, 10.3, 10.4)
    ]
    const r = simulateTrade(SIG, plan, rows)
    expect(r.exitReason).toBe('stop_profit')
    expect(r.exitPrice).toBeCloseTo(10.8, 6)
    expect(r.returnPct).toBeCloseTo(8, 6)
  })

  it('双边费用降低净收益', () => {
    const plan: TradePlan = { entryRule: 'nextOpen', holdDays: 1, feeBps: 13 }
    const rows = [
      row('20260101', 9.9, 10, 9.8, 10),
      row('20260102', 10, 10.5, 9.9, 10.5),
      row('20260103', 10.5, 12, 10, 11)
    ]
    const r = simulateTrade(SIG, plan, rows)
    expect(r.grossReturnPct).toBeCloseTo(10, 6)
    expect(r.netReturnPct).toBeLessThan(10)
    expect(r.returnPct).toBeCloseTo(9.714, 2)
  })

  it('signalClose 入场: T 日收盘买入', () => {
    const plan: TradePlan = { entryRule: 'signalClose', holdDays: 1, feeBps: 0 }
    const rows = [
      row('20260101', 9.9, 10, 9.8, 10),
      row('20260102', 10, 10.6, 9.9, 10.5)
    ]
    const r = simulateTrade(SIG, plan, rows)
    expect(r.entryDate).toBe('20260101')
    expect(r.entryPrice).toBe(10)
    expect(r.returnPct).toBeCloseTo(5, 6)
  })
})
