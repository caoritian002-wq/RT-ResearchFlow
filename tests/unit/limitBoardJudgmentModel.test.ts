import { describe, expect, it } from 'vitest'
import {
  buildLimitBoardWorkbenchJudgment,
  judgeLimitBoardStock,
  type LimitBoardJudgmentInput,
} from '../../electron/main/services/limitBoardJudgmentModel'

function stock(overrides: Partial<LimitBoardJudgmentInput> = {}): LimitBoardJudgmentInput {
  return {
    tsCode: '000001.SZ',
    stockCode: '000001',
    stockName: '示例股份',
    limitTime: '09:42:00',
    limitPrice: 12.34,
    pctChg: 10,
    fundAmount: 12_000,
    openTimes: 0,
    limitTimes: 2,
    conceptName: '光模块',
    conceptZtNum: 8,
    hasDumpInstWarning: false,
    dumpInstDesc: null,
    dataMode: 'eod',
    ...overrides,
  }
}

describe('FR-250 涨停封板质量模型', () => {
  it('把早封、未开板、强封单和题材共振识别为重点观察', () => {
    const result = judgeLimitBoardStock(stock())

    expect(result.tier).toBe('focus')
    expect(result.dataStatus).toBe('complete')
    expect(result.completeness).toBe(100)
    expect(result.totalScore).toBeGreaterThanOrEqual(90)
    expect(result.evidence.some((item) => item.includes('10:30前'))).toBe(true)
  })

  it('把中等时间和有限共振保留为选择性观察', () => {
    const result = judgeLimitBoardStock(stock({
      limitTime: '11:08:00',
      fundAmount: 1_200,
      openTimes: 2,
      limitTimes: 1,
      conceptZtNum: 2,
    }))

    expect(result.tier).toBe('watch')
    expect(result.title).toBe('选择性观察')
    expect(result.risks.length).toBeGreaterThan(0)
  })

  it('反复开板属于硬风险，不能被其他高分抵消', () => {
    const result = judgeLimitBoardStock(stock({ openTimes: 4 }))

    expect(result.tier).toBe('fragile')
    expect(result.summary).toContain('硬风险已触发降级')
    expect(result.risks.some((item) => item.includes('反复开板'))).toBe(true)
  })

  it('龙虎榜卖出风险属于硬降级项', () => {
    const result = judgeLimitBoardStock(stock({
      hasDumpInstWarning: true,
      dumpInstDesc: '机构卖出/买入比 2.8',
    }))

    expect(result.tier).toBe('fragile')
    expect(result.risks[0]).toContain('2.8')
  })

  it('缺失字段保持未知，不把0封单和-1开板伪装成弱事实', () => {
    const result = judgeLimitBoardStock(stock({
      limitTime: '—',
      fundAmount: 0,
      openTimes: -1,
      conceptName: '无题材',
      conceptZtNum: 0,
      limitTimes: 0,
      dataMode: 'realtime',
    }))

    expect(result.totalScore).toBeNull()
    expect(result.dataStatus).toBe('insufficient')
    expect(result.completeness).toBe(0)
    expect(result.dimensions.every((item) => item.status === 'unknown')).toBe(true)
    expect(result.missingFields).toEqual(['首次封板时间', '开板次数', '封单金额', '题材广度', '连板位置'])
  })

  it('按重点数量、股票广度和均分聚合前三题材', () => {
    const inputs = [
      stock({ tsCode: '000001.SZ', conceptName: '光模块', conceptZtNum: 5 }),
      stock({ tsCode: '000002.SZ', conceptName: '光模块', conceptZtNum: 5 }),
      stock({ tsCode: '000003.SZ', conceptName: 'PCB', conceptZtNum: 2, fundAmount: 800, openTimes: 2 }),
      stock({ tsCode: '000004.SZ', conceptName: '无题材', conceptZtNum: 0 }),
    ].map((item) => ({ ...item, quality: judgeLimitBoardStock(item) }))

    const result = buildLimitBoardWorkbenchJudgment(inputs)

    expect(result.themes[0]).toMatchObject({ name: '光模块', stockCount: 2, focusCount: 2 })
    expect(result.themes.some((item) => item.name === '无题材')).toBe(false)
    expect(result.focusCount).toBe(3)
    expect(result.stance).toBe('focus')
    expect(result.strategyVersion).toBe('2.0.0')
  })
})
