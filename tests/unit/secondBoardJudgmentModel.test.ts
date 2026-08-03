import { describe, expect, it } from 'vitest'
import {
  SECOND_BOARD_STRATEGY_KEY,
  buildSecondBoardThemeContexts,
  evaluateSecondBoardWorkbench,
  type SecondBoardJudgmentInput,
} from '../../electron/main/services/secondBoardJudgmentModel'

function stock(overrides: Partial<SecondBoardJudgmentInput> = {}): SecondBoardJudgmentInput {
  return {
    tsCode: '000001.SZ',
    stockCode: '000001',
    stockName: '梯队科技',
    pctChg: 10,
    limitTimes: 3,
    firstTime: '09:42:00',
    lastTime: '14:55:00',
    openTimes: 0,
    fundAmount: 12_000,
    turnoverRatio: 8,
    prevTurnoverRatio: 7,
    conceptName: '光模块',
    conceptLimitUpCount: 5,
    hasDumpInstWarning: false,
    dumpInstDesc: null,
    dataMode: 'eod',
    ...overrides,
  }
}

describe('FR-250 连板梯队与题材竞争模型', () => {
  it('按同批候选的高度层与涨停助攻形成题材梯队', () => {
    const inputs = [
      stock({ tsCode: '000001.SZ', stockCode: '000001', limitTimes: 4 }),
      stock({ tsCode: '000002.SZ', stockCode: '000002', stockName: '助攻科技', limitTimes: 2 }),
    ]
    const context = buildSecondBoardThemeContexts(inputs).get('光模块')
    const result = evaluateSecondBoardWorkbench(inputs)

    expect(context).toMatchObject({ consecutiveCount: 2, limitUpCount: 5, maxBoards: 4, ladderDepth: 2, formed: true })
    expect(result.workbench.highestBoard).toBe(4)
    expect(result.workbench.heightDistribution).toEqual([{ boards: 4, count: 1 }, { boards: 2, count: 1 }])
    expect(result.workbench.formedThemeCount).toBe(1)
    expect(result.workbench.stance).toBe('formed')
    expect(result.stocks[0].judgment.tier).toBe('core')
  })

  it('孤立最高板不会仅凭高度和总分升级为核心', () => {
    const result = evaluateSecondBoardWorkbench([
      stock({ limitTimes: 5, conceptName: '机器人', conceptLimitUpCount: 1 }),
      stock({ tsCode: '000002.SZ', stockCode: '000002', conceptName: '算力', limitTimes: 2, conceptLimitUpCount: 1 }),
    ])
    const highest = result.stocks.find((item) => item.limitTimes === 5)

    expect(highest?.judgment.theme?.formed).toBe(false)
    expect(highest?.judgment.tier).toBe('contender')
    expect(highest?.judgment.risks.join(' ')).toContain('孤立连板')
    expect(result.workbench.isolatedHighCount).toBe(1)
  })

  it('反复开板或龙虎榜卖压触发硬降级', () => {
    const result = evaluateSecondBoardWorkbench([
      stock({ openTimes: 4 }),
      stock({
        tsCode: '000002.SZ', stockCode: '000002', stockName: '卖压科技', limitTimes: 2,
        hasDumpInstWarning: true, dumpInstDesc: '机构卖出/买入比 3.2',
      }),
    ])

    expect(result.stocks.every((item) => item.judgment.tier === 'fragile')).toBe(true)
    expect(result.stocks.flatMap((item) => item.judgment.risks).join(' ')).toContain('机构卖出/买入比 3.2')
  })

  it('盘中缺失字段保持未知，不以0、2.0或二板补位', () => {
    const result = evaluateSecondBoardWorkbench([
      stock({
        dataMode: 'realtime', limitTimes: null, firstTime: null, lastTime: null, openTimes: null,
        turnoverRatio: null, prevTurnoverRatio: 6, fundAmount: 3_000,
      }),
    ])
    const candidate = result.stocks[0]

    expect(candidate.limitTimes).toBeNull()
    expect(candidate.openTimes).toBeNull()
    expect(candidate.turnoverRatio).toBeNull()
    expect(candidate.judgment.tier).toBe('insufficient')
    expect(candidate.judgment.dataStatus).toBe('insufficient')
    expect(candidate.judgment.missingFields).toEqual(expect.arrayContaining(['连板高度', '首次封板时间', '开板次数', '当日换手率']))
    expect(candidate.judgment.dimensions.find((item) => item.key === 'boardPosition')?.value).toBe('待盘后')
    expect(candidate.judgment.dimensions).toHaveLength(5)
    expect(candidate.judgment.dimensions.filter((item) => item.key === 'themeLadder')).toHaveLength(1)
  })

  it('盘中只有同题材涨停广度但没有准确高度时不宣称梯队成形', () => {
    const result = evaluateSecondBoardWorkbench([
      stock({ tsCode: '000001.SZ', stockCode: '000001', dataMode: 'realtime', limitTimes: null, firstTime: null, openTimes: null, turnoverRatio: null, conceptLimitUpCount: 4 }),
      stock({ tsCode: '000002.SZ', stockCode: '000002', dataMode: 'realtime', limitTimes: null, firstTime: null, openTimes: null, turnoverRatio: null, conceptLimitUpCount: 4 }),
    ])

    expect(result.workbench.highestBoard).toBeNull()
    expect(result.workbench.formedThemeCount).toBe(0)
    expect(result.workbench.stance).toBe('insufficient')
    expect(result.workbench.themes[0]?.formed).toBe(false)
  })

  it('题材广度只进入一个题材梯队维度，不重复形成带队得分', () => {
    const result = evaluateSecondBoardWorkbench([
      stock({ tsCode: '000001.SZ', stockCode: '000001', conceptLimitUpCount: 8 }),
      stock({ tsCode: '000002.SZ', stockCode: '000002', limitTimes: 2, conceptLimitUpCount: 8 }),
    ])
    const keys = result.stocks[0].judgment.dimensions.map((item) => item.key)

    expect(keys).toEqual(['boardPosition', 'stability', 'seal', 'turnover', 'themeLadder'])
    expect(new Set(keys).size).toBe(keys.length)
    expect(SECOND_BOARD_STRATEGY_KEY).toBe('shortTerm.secondBoardLeader')
  })

  it('空样本给出可恢复的证据不足结论', () => {
    const result = evaluateSecondBoardWorkbench([])

    expect(result.workbench.stance).toBe('insufficient')
    expect(result.workbench.title).toContain('没有二板及以上')
    expect(result.stocks).toEqual([])
  })
})
