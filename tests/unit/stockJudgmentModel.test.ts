import { describe, expect, it } from 'vitest'
import { buildStockJudgmentModel, applyStockJudgment } from '../../src/components/DecisionCenter/stockJudgmentModel'
import type { DecisionSignalItem } from '../../src/components/DecisionCenter/SignalCard'

function signal(partial: Partial<DecisionSignalItem> & Pick<DecisionSignalItem, 'id' | 'tsCode'>): DecisionSignalItem {
  return {
    id: partial.id,
    tsCode: partial.tsCode,
    stockName: partial.stockName ?? '测试',
    conceptCode: null,
    conceptName: null,
    sourceModule: partial.sourceModule ?? 'trend',
    strategyKey: partial.strategyKey ?? 'trend.x',
    signalType: partial.signalType ?? 'RISK',
    direction: partial.direction ?? 'BEARISH',
    priority: partial.priority ?? 4,
    score: null,
    confidence: null,
    title: partial.title ?? '测试信号',
    summary: partial.summary ?? '摘要',
    reasonJson: partial.reasonJson ?? JSON.stringify({ isPortfolio: true, costPrice: 10, profitPct: -5 }),
    sourceRefJson: null,
    status: partial.status ?? 'NEW',
    signalTime: Date.now(),
    occurrenceCount: 1,
  }
}

describe('buildStockJudgmentModel', () => {
  it('builds evidence and portfolio context for a stock', () => {
    const model = buildStockJudgmentModel(
      signal({ id: 1, tsCode: '600487.SH', stockName: '亨通光电' }),
      {
        holdings: [{ tsCode: '600487.SH', stockName: '亨通光电', addedAt: 1, costPrice: 108 }],
        relatedSignals: [
          signal({ id: 1, tsCode: '600487.SH', title: '跌破MA60' }),
          signal({ id: 2, tsCode: '600487.SH', title: '资讯', sourceModule: 'news', signalType: 'ALERT' }),
        ],
      },
    )
    expect(model).not.toBeNull()
    expect(model!.sourceCount).toBe(2)
    expect(model!.isPortfolio).toBe(true)
    expect(model!.evidence.some((item) => item.key === 'cost' && item.status === 'ready')).toBe(true)
    expect(model!.evidence.some((item) => item.key === 'news' && item.status === 'ready')).toBe(true)
  })
})

describe('applyStockJudgment', () => {
  it('saves one atomic judgment with its evidence snapshot', async () => {
    const calls: Array<Parameters<typeof applyStockJudgment>[0]> = []
    const api = {
      decision: {
        saveJudgment: async (payload: Parameters<typeof applyStockJudgment>[0]) => {
          calls.push(payload)
          return { ok: true, data: { projectedSignal: null } }
        },
      },
    }
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { api } })
    const payload: Parameters<typeof applyStockJudgment>[0] = {
      requestId: 'judgment-request-1',
      tsCode: '600487.SH',
      stockName: '亨通光电',
      tag: 'noise',
      note: '重复异动',
      sourceSignalId: 1,
      relatedSignalIds: [1, 2],
      evidenceSnapshot: {
        primaryTitle: '测试信号',
        primarySummary: '摘要',
        sourceCount: 2,
        maxPriority: 4,
        trustHint: '仅作辅助复核',
        evidence: [],
      },
    }
    const res = await applyStockJudgment(payload)
    expect(res.ok).toBe(true)
    expect(calls).toEqual([payload])
  })
})
