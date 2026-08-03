import { describe, expect, it } from 'vitest'
import {
  buildRound2MarketVisualModel,
  prepareRound2MarketMarkdown,
  toAshareTsCode,
  toBeijingTradeDate,
  type Round2MarketSourceRow,
} from '../../src/components/AIAnalysis/round2MarketVisualModel'

function makeRows(count: number): Round2MarketSourceRow[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 10 + index * 0.1
    return {
      tradeDate: `202606${String(index + 1).padStart(2, '0')}`,
      open: close - 0.1,
      high: close + 0.3,
      low: close - 0.3,
      close,
      pctChg: index === 0 ? 0 : 1,
    }
  })
}

describe('AI 行情复核视觉模型', () => {
  it('按分析发生日过滤未来行情并计算透明的均线、高低区间和强弱', () => {
    const rows = [
      ...makeRows(25),
      { tradeDate: '20260701', open: 90, high: 101, low: 89, close: 100, pctChg: 700 },
    ]
    const result = buildRound2MarketVisualModel(rows, '20260625')

    expect(result.status).toBe('ready')
    expect(result.rows).toHaveLength(25)
    expect(result.latestTradeDate).toBe('20260625')
    expect(result.latestClose).toBeCloseTo(12.4)
    expect(result.ma5).toBeCloseTo(12.2)
    expect(result.ma20).toBeCloseTo(11.45)
    expect(result.return5).toBeCloseTo((12.4 / 11.9 - 1) * 100)
    expect(result.support5).toBeCloseTo(11.7)
    expect(result.support20).toBeCloseTo(10.2)
    expect(result.pressure5).toBeCloseTo(12.7)
    expect(result.pressure20).toBeCloseTo(12.7)
    expect(result.trendLabel).toBe('偏强')
    expect(result.ma5Series).toHaveLength(21)
    expect(result.ma20Series).toHaveLength(6)
  })

  it('剔除损坏K线并在少于10个有效交易日时明确降级', () => {
    const rows = makeRows(9)
    rows.push({ tradeDate: '20260610', open: 10, high: 9, low: 8, close: 10 })
    rows.push({ tradeDate: '20260611', open: null, high: 11, low: 9, close: 10 })
    const result = buildRound2MarketVisualModel(rows, '20260630')

    expect(result.status).toBe('insufficient')
    expect(result.rows).toHaveLength(9)
    expect(result.reason).toBe('insufficient_rows')
    expect(result.trendLabel).toBe('样本不足')
  })

  it('使用北京时间确定历史记录截止日并规范A股交易所后缀', () => {
    expect(toBeijingTradeDate('2026-07-20T16:30:00.000Z')).toBe('20260721')
    expect(toAshareTsCode('600000')).toBe('600000.SH')
    expect(toAshareTsCode('000001')).toBe('000001.SZ')
    expect(toAshareTsCode('430047')).toBe('430047.BJ')
    expect(toAshareTsCode('invalid')).toBeNull()
  })

  it('按股票章节用单股K线替换对应的支撑与压力纯文本', () => {
    const segments = prepareRound2MarketMarkdown([
      '## 个股走势与支撑压力参考',
      '',
      '### 方正科技（600601）',
      '近期趋势偏强，量价关系仍需跟踪。',
      '- 支撑观察参考：12.20（近20日最低）',
      '- 压力观察参考：14.80（近20日最高）',
      '当前位置位于支撑观察参考与压力观察参考之间，仍需结合量能确认。',
      '',
      '### 生益科技 600183',
      '近期维持震荡。',
      '| 项目 | 价格 |',
      '| --- | --- |',
      '| 支撑位 | 28.30 |',
      '| 压力位 | 31.60 |',
      '',
      '## 风险与反证',
      '需求不及预期。',
    ].join('\n'), [
      { code: '600601.SH', name: '方正科技' },
      { code: '600183', name: '生益科技' },
    ])

    const visuals = segments.filter((segment) => segment.kind === 'visual')
    expect(visuals).toEqual([
      { kind: 'visual', code: '600601', fallbackMarkdown: '- 支撑观察参考：12.20（近20日最低）\n- 压力观察参考：14.80（近20日最高）' },
      { kind: 'visual', code: '600183', fallbackMarkdown: '| 项目 | 价格 |\n| --- | --- |\n| 支撑位 | 28.30 |\n| 压力位 | 31.60 |' },
    ])
    const visibleMarkdown = segments
      .filter((segment) => segment.kind === 'markdown')
      .map((segment) => segment.markdown)
      .join('\n')
    expect(visibleMarkdown).toContain('### 方正科技（600601）')
    expect(visibleMarkdown).toContain('### 生益科技 600183')
    expect(visibleMarkdown).toContain('当前位置位于支撑观察参考与压力观察参考之间，仍需结合量能确认。')
    expect(visibleMarkdown).not.toContain('12.20')
    expect(visibleMarkdown).not.toContain('31.60')
    expect(visibleMarkdown).not.toContain('| 项目 | 价格 |')
  })

  it('缺少纯文本价位时在该股票章节末尾插图而不回到报告顶部', () => {
    const segments = prepareRound2MarketMarkdown([
      '## 行情数据边界',
      '数据截止：2026-07-17',
      '',
      '## 个股走势与支撑压力参考',
      '',
      '浦发银行（600000）近期行情已完成复核。',
      '',
      '## 风险与反证',
      '政策口径仍待确认。',
    ].join('\n'), [{ code: '600000', name: '浦发银行' }])

    expect(segments.map((segment) => segment.kind)).toEqual(['markdown', 'visual', 'markdown'])
    expect(segments[0]).toMatchObject({ kind: 'markdown' })
    expect(segments[0].kind === 'markdown' ? segments[0].markdown : '').toContain('浦发银行（600000）近期行情已完成复核。')
    expect(segments[1]).toEqual({ kind: 'visual', code: '600000', fallbackMarkdown: '' })
    expect(segments[2].kind === 'markdown' ? segments[2].markdown : '').toContain('## 风险与反证')
  })

  it('不解析代码围栏内的价位文字并移除模型伪造的图表标记', () => {
    const segments = prepareRound2MarketMarkdown([
      '## 个股走势与支撑压力参考',
      '### 沪电股份（002463）',
      '```text',
      '支撑观察参考：这是引用示例',
      '```',
      '<!-- trade-watch-round2-market:000001 -->',
      '正文结论。',
    ].join('\n'), [{ code: '002463', name: '沪电股份' }])
    const markdown = segments
      .filter((segment) => segment.kind === 'markdown')
      .map((segment) => segment.markdown)
      .join('\n')

    expect(markdown).toContain('支撑观察参考：这是引用示例')
    expect(markdown).not.toContain('trade-watch-round2-market:000001')
    expect(segments.filter((segment) => segment.kind === 'visual')).toEqual([
      { kind: 'visual', code: '002463', fallbackMarkdown: '' },
    ])
  })
})
