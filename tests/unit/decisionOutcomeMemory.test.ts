import { describe, expect, it } from 'vitest'
import {
  bjYmdFromMs,
  classifyOutcome,
  computeForwardReturnPct,
  mergeDecisionOutcomeCandidates,
  parseJudgmentTagFromNote,
} from '../../electron/main/services/decisionOutcomeMemory'
import type { DecisionSignalRow } from '../../electron/main/database/types'

function legacySignal(): DecisionSignalRow {
  return {
    id: 1, sourceModule: 'trend', strategyKey: 'trend.test', tsCode: '600000.SH', stockName: '浦发银行',
    conceptCode: null, conceptName: null, signalType: 'RISK', direction: 'BEARISH', priority: 4,
    score: null, confidence: null, title: '旧信号', summary: '摘要', reasonJson: null, sourceRefJson: null,
    status: 'WATCHING', dedupKey: 'legacy', signalTime: 10, expireAt: null, createdAt: 10, updatedAt: 20,
    firstSeenAt: 10, lastSeenAt: 10, occurrenceCount: 1, acknowledgedAt: null, watchedAt: 20,
    dismissedAt: null, resolvedAt: 20, resolution: 'RESOLVED_VALID', resolutionNote: '[judgment:risk_off] 旧备注',
  }
}

describe('mergeDecisionOutcomeCandidates', () => {
  it('账本优先并去除同股票同标签旧备注投影', () => {
    const candidates = mergeDecisionOutcomeCandidates({
      judgments: [{ tsCode: '600000.SH', stockName: '浦发银行', tag: 'risk_off', note: '新判断', createdAt: 30, sourceSignalId: 1 }],
      signals: [legacySignal()],
    })
    expect(candidates).toEqual([expect.objectContaining({ note: '新判断', direction: 'BEARISH', title: '旧信号' })])
  })
})

describe('parseJudgmentTagFromNote', () => {
  it('parses known tags and falls back', () => {
    expect(parseJudgmentTagFromNote('[judgment:risk_off] 减仓观察')).toEqual({
      tag: 'risk_off',
      note: '减仓观察',
    })
    expect(parseJudgmentTagFromNote('[judgment:noise]')).toEqual({ tag: 'noise', note: '' })
    expect(parseJudgmentTagFromNote('普通备注').tag).toBeNull()
    expect(parseJudgmentTagFromNote('[judgment:unknown] x').tag).toBeNull()
  })
})

describe('computeForwardReturnPct', () => {
  const rows = [
    { tradeDate: '20260701', close: 10 },
    { tradeDate: '20260702', close: 10.5 },
    { tradeDate: '20260703', close: 11 },
    { tradeDate: '20260704', close: 10.8 },
    { tradeDate: '20260707', close: 10.2 },
    { tradeDate: '20260708', close: 9.8 },
  ]

  it('uses previous close when judgment is on a non-trading calendar day', () => {
    // 2026-07-05 北京时间周日附近: 用 <= 判断日的最近交易日
    const judgmentAt = Date.parse('2026-07-05T04:00:00.000Z') // BJ 12:00 7/5
    const ymd = bjYmdFromMs(judgmentAt)
    expect(ymd).toBe('20260705')
    const ret = computeForwardReturnPct(rows, judgmentAt, 2)
    // base = 20260704 (10.8), end = baseIdx+2 = 20260708 (9.8)
    expect(ret.baseTradeDate).toBe('20260704')
    expect(ret.endTradeDate).toBe('20260708')
    expect(ret.forwardReturnPct).toBeCloseTo(((9.8 - 10.8) / 10.8) * 100, 5)
  })

  it('blocks when horizon not filled', () => {
    const judgmentAt = Date.parse('2026-07-07T04:00:00.000Z')
    const ret = computeForwardReturnPct(rows, judgmentAt, 5)
    expect(ret.forwardReturnPct).toBeNull()
    expect(ret.reason).toContain('窗口未满')
  })
})

describe('classifyOutcome', () => {
  it('blocks noise and insufficient', () => {
    expect(classifyOutcome({ tag: 'noise', direction: 'NEUTRAL', forwardReturnPct: 5 }).label).toBe('blocked')
    expect(classifyOutcome({ tag: 'insufficient', direction: 'BULLISH', forwardReturnPct: -3 }).label).toBe('blocked')
  })

  it('classifies risk_off by return direction', () => {
    expect(classifyOutcome({ tag: 'risk_off', direction: 'BEARISH', forwardReturnPct: -1 }).label).toBe('aligned')
    expect(classifyOutcome({ tag: 'risk_off', direction: 'BEARISH', forwardReturnPct: 3 }).label).toBe('misaligned')
    expect(classifyOutcome({ tag: 'risk_off', direction: 'BEARISH', forwardReturnPct: 1 }).label).toBe('mixed')
  })

  it('uses signal direction for watch/done when present', () => {
    expect(classifyOutcome({ tag: 'watch', direction: 'BULLISH', forwardReturnPct: 2 }).label).toBe('aligned')
    expect(classifyOutcome({ tag: 'done', direction: 'BULLISH', forwardReturnPct: -3 }).label).toBe('misaligned')
    expect(classifyOutcome({ tag: 'done', direction: 'NEUTRAL', forwardReturnPct: 1 }).label).toBe('mixed')
  })
})
