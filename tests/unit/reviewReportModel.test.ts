import { describe, expect, it } from 'vitest'
import {
  buildDailyReviewReport,
  buildWeeklyReviewReport,
  formatDailyReviewReportText,
  parseJudgmentNote,
  WEEKLY_REVIEW_RANGE_DAYS,
} from '../../src/components/DecisionCenter/reviewReportModel'
import type { DecisionSignalItem } from '../../src/components/DecisionCenter/SignalCard'

function signal(partial: Partial<DecisionSignalItem> & Pick<DecisionSignalItem, 'id'>): DecisionSignalItem {
  return {
    id: partial.id,
    tsCode: partial.tsCode ?? '600000.SH',
    stockName: partial.stockName ?? '浦发银行',
    conceptCode: null,
    conceptName: null,
    sourceModule: partial.sourceModule ?? 'trend',
    strategyKey: partial.strategyKey ?? 'trend.STOP_LOSS',
    signalType: partial.signalType ?? 'RISK',
    direction: partial.direction ?? 'BEARISH',
    priority: partial.priority ?? 4,
    score: null,
    confidence: null,
    title: partial.title ?? '跌破止损',
    summary: partial.summary ?? '摘要',
    reasonJson: partial.reasonJson ?? JSON.stringify({ isPortfolio: true }),
    sourceRefJson: partial.sourceRefJson ?? null,
    status: partial.status ?? 'NEW',
    signalTime: partial.signalTime ?? Date.now(),
    occurrenceCount: 1,
    resolvedAt: partial.resolvedAt ?? null,
    resolution: partial.resolution ?? null,
    resolutionNote: partial.resolutionNote ?? null,
    dismissedAt: partial.dismissedAt ?? null,
  }
}

describe('parseJudgmentNote', () => {
  it('parses known judgment tags and falls back on unknown', () => {
    expect(parseJudgmentNote('[judgment:noise] 重复异动')).toEqual({
      tag: 'noise',
      tagLabel: '噪音/忽略',
      note: '重复异动',
      raw: '[judgment:noise] 重复异动',
    })
    expect(parseJudgmentNote('[judgment:watch]')).toMatchObject({ tag: 'watch', note: '' })
    expect(parseJudgmentNote('普通备注')).toMatchObject({ tag: null, note: '普通备注' })
    expect(parseJudgmentNote('[judgment:unknown] x')).toMatchObject({ tag: null, note: '[judgment:unknown] x' })
  })
})

describe('buildDailyReviewReport', () => {
  it('优先使用判断账本，并且只把真实到期任务计入待回访', () => {
    const report = buildDailyReviewReport({
      holdings: [{ tsCode: '600000.SH', stockName: '浦发银行', addedAt: 1, costPrice: 10 }],
      signals: [signal({ id: 1, resolvedAt: 10, resolution: 'RESOLVED_VALID', resolutionNote: '[judgment:done] 旧备注' })],
      judgments: [{
        id: 'judgment-1', judgmentGroupId: 'group-1', versionNumber: 2, versionCount: 2,
        tsCode: '600000.SH', stockName: '浦发银行', tag: 'watch', note: '新判断',
        sourceSignalId: 1, reviewDueAt: null, createdAt: 20, schemaVersion: 1, sourceSignalAvailable: true,
      }],
      judgmentFollowUps: [{
        judgmentId: 'judgment-1', tsCode: '600000.SH', stockName: '浦发银行', tag: 'watch',
        note: '新判断', reviewDueAt: 19,
      }],
    })
    expect(report.processed).toEqual([expect.objectContaining({ tag: 'watch', note: '新判断' })])
    expect(report.followUps).toEqual([expect.objectContaining({ note: '新判断', title: '到期判断待回访' })])
  })

  it('不把尚未到期的观察判断误报为待回访', () => {
    const report = buildDailyReviewReport({
      holdings: [{ tsCode: '600000.SH', stockName: '浦发银行', addedAt: 1, costPrice: 10 }],
      signals: [],
      judgments: [{
        id: 'judgment-future', judgmentGroupId: 'group-future', versionNumber: 1, versionCount: 1,
        tsCode: '600000.SH', stockName: '浦发银行', tag: 'watch', note: '三天后复核',
        sourceSignalId: null, reviewDueAt: Date.now() + 3 * 86_400_000, createdAt: 20,
        schemaVersion: 1, sourceSignalAvailable: false,
      }],
      judgmentFollowUps: [],
    })

    expect(report.followUps).toEqual([])
    expect(report.summary.followUpCount).toBe(0)
  })

  it('builds processed, open risk, gaps and follow-ups from portfolio signals', () => {
    const report = buildDailyReviewReport({
      generatedAt: 1_700_000_000_000,
      holdings: [
        { tsCode: '600000.SH', stockName: '浦发银行', addedAt: 1, costPrice: null },
        { tsCode: '000001.SZ', stockName: '平安银行', addedAt: 2, costPrice: 12 },
        { tsCode: '600519.SH', stockName: '贵州茅台', addedAt: 3, costPrice: 1500 },
      ],
      signals: [
        signal({
          id: 1,
          tsCode: '600000.SH',
          stockName: '浦发银行',
          status: 'NEW',
          signalType: 'RISK',
          title: '持仓风险未处理',
        }),
        signal({
          id: 2,
          tsCode: '000001.SZ',
          stockName: '平安银行',
          status: 'READ',
          resolvedAt: 1_700_000_000_100,
          resolution: 'RESOLVED_VALID',
          resolutionNote: '[judgment:done] 已复核',
          title: '已处理线索',
        }),
        signal({
          id: 3,
          tsCode: '600519.SH',
          stockName: '贵州茅台',
          status: 'WATCHING',
          resolvedAt: 1_700_000_000_200,
          resolution: 'RESOLVED_DATA_ISSUE',
          resolutionNote: '[judgment:insufficient] 缺公告',
          title: '信息不足',
        }),
      ],
      portfolioRiskData: null,
    })

    expect(report.title).toBe('今日复盘报告')
    expect(report.summary.holdingCount).toBe(3)
    expect(report.summary.openRiskCount).toBeGreaterThanOrEqual(1)
    expect(report.processed.some((item) => item.tag === 'done')).toBe(true)
    expect(report.evidenceGaps.some((item) => item.stockName === '浦发银行')).toBe(true)
    expect(report.followUps.some((item) => item.tagLabel === '信息不足')).toBe(true)
    expect(report.disclaimer).toContain('不构成买卖')
    expect(report.emptyDay).toBe(false)
  })

  it('returns a short complete report on quiet portfolio day', () => {
    const report = buildDailyReviewReport({
      holdings: [{ tsCode: '600000.SH', stockName: '浦发银行', addedAt: 1, costPrice: 10 }],
      signals: [],
    })
    expect(report.emptyDay).toBe(true)
    expect(report.headline).toContain('无新的持仓相关信号')
    expect(report.processed).toEqual([])
    expect(report.openRisks).toEqual([])
    const text = formatDailyReviewReportText(report)
    expect(text).toContain('今日复盘报告')
    expect(text).toContain('## 已处理')
    expect(text).toContain('辅助复盘')
  })
})

describe('buildWeeklyReviewReport', () => {
  it('aggregates history processed items and uses today open risks separately', () => {
    const history = [
      signal({
        id: 10,
        tsCode: '000001.SZ',
        stockName: '平安银行',
        status: 'READ',
        resolvedAt: 1_700_000_000_100,
        resolution: 'RESOLVED_VALID',
        resolutionNote: '[judgment:done] 周内已复核',
        title: '周内已处理',
      }),
      signal({
        id: 11,
        tsCode: '600519.SH',
        stockName: '贵州茅台',
        status: 'WATCHING',
        resolvedAt: 1_700_000_000_200,
        resolution: 'RESOLVED_DATA_ISSUE',
        resolutionNote: '[judgment:insufficient] 缺公告',
        title: '周内信息不足',
      }),
    ]
    const todayOpen = [
      signal({
        id: 12,
        tsCode: '600000.SH',
        stockName: '浦发银行',
        status: 'NEW',
        signalType: 'RISK',
        title: '今日仍开放风险',
      }),
    ]
    const report = buildWeeklyReviewReport({
      historySignals: history,
      openRiskSignals: todayOpen,
      holdings: [
        { tsCode: '600000.SH', stockName: '浦发银行', addedAt: 1, costPrice: null },
        { tsCode: '000001.SZ', stockName: '平安银行', addedAt: 2, costPrice: 12 },
        { tsCode: '600519.SH', stockName: '贵州茅台', addedAt: 3, costPrice: 1500 },
      ],
    })
    expect(report.kind).toBe('weekly')
    expect(report.rangeDays).toBe(WEEKLY_REVIEW_RANGE_DAYS)
    expect(report.title).toBe('本周复盘报告')
    expect(report.processed.some((item) => item.tag === 'done')).toBe(true)
    expect(report.openRisks.some((item) => item.title === '今日仍开放风险')).toBe(true)
    expect(report.followUps.some((item) => item.tagLabel === '信息不足')).toBe(true)
    expect(formatDailyReviewReportText(report)).toContain('近 7 个自然日')
  })
})
