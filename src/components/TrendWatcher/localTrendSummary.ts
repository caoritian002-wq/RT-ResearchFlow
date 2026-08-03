import type { TrendWorkbenchItem } from './trendWorkbenchTypes'

export type LocalTrendSummaryStatus = 'ready' | 'degraded' | 'insufficient'
export type LocalTrendFactTone = 'positive' | 'negative' | 'neutral'

export interface LocalTrendFact {
  key: string
  label: string
  value: string
  tone: LocalTrendFactTone
}

export interface LocalTrendSummary {
  method: 'local-rules'
  status: LocalTrendSummaryStatus
  headline: string
  asOf: string | null
  validWeightPct: number | null
  facts: LocalTrendFact[]
  risks: string[]
  unknowns: string[]
}

export function buildLocalTrendSummary(item: TrendWorkbenchItem): LocalTrendSummary {
  const facts: LocalTrendFact[] = []
  const risks: string[] = []
  const unknowns: string[] = []
  const validWeightPct = item.validWeight == null ? null : Math.round(item.validWeight * 100)
  const asOf = item.scoreDate || item.dataCoverage.latestTradeDate || null
  const benchmarkCurrent = item.benchmarkHealth?.state === 'current'

  if (item.totalScore != null && benchmarkCurrent) {
    facts.push({
      key: 'score',
      label: '综合趋势分',
      value: String(item.totalScore),
      tone: item.totalScore >= 70 ? 'positive' : item.totalScore < 45 ? 'negative' : 'neutral',
    })
  }

  if (item.maAbove60 == null) {
    unknowns.push('MA60上下文不足，长期均线位置未知')
  } else {
    facts.push({
      key: 'ma60',
      label: '长期均线',
      value: item.maAbove60 ? '站上MA60' : '跌破MA60',
      tone: item.maAbove60 ? 'positive' : 'negative',
    })
    if (!item.maAbove60) risks.push('现价低于MA60，长期均线结构处于破坏状态')
  }

  addReturnFact(facts, 'stock-return', '个股20日', item.facts?.stockReturn20d ?? null)
  if (benchmarkCurrent) {
    addReturnFact(facts, 'benchmark-return', '沪深300同期', item.facts?.benchmarkReturn20d ?? null)
    if (item.facts?.benchmarkReturn20d == null) unknowns.push('沪深300同期数据不足，相对强弱未知')
    const excess = item.facts?.excessReturn20d ?? null
    addReturnFact(facts, 'excess-return', '20日超额', excess)
    if (excess != null && excess <= -5) risks.push(`近20日落后沪深300 ${Math.abs(excess).toFixed(1)}个百分点`)
  } else {
    unknowns.push(item.benchmarkHealth?.message ?? '沪深300基准健康状态未知，相对强弱未参与本地结论')
  }

  const drawdown = item.facts?.maxDrawdown20d ?? null
  if (drawdown == null) {
    unknowns.push('近20日最大回撤未知')
  } else {
    facts.push({
      key: 'drawdown',
      label: '20日最大回撤',
      value: `${drawdown.toFixed(1)}%`,
      tone: drawdown >= 10 ? 'negative' : drawdown <= 5 ? 'positive' : 'neutral',
    })
    if (drawdown >= 10) risks.push(`近20日最大回撤达到 ${drawdown.toFixed(1)}%`)
  }

  if (item.scoreDelta5d == null) {
    unknowns.push('评分轨迹不足，5日变化未知')
  } else {
    facts.push({
      key: 'score-delta-5d',
      label: '趋势分5日变化',
      value: formatSigned(item.scoreDelta5d),
      tone: item.scoreDelta5d >= 3 ? 'positive' : item.scoreDelta5d <= -5 ? 'negative' : 'neutral',
    })
    if (item.scoreDelta5d <= -5) risks.push(`近5个交易日趋势分下降 ${Math.abs(item.scoreDelta5d).toFixed(1)}分`)
  }

  if (item.macdAboveZero == null) {
    unknowns.push('MACD零轴位置未知')
  } else if (!item.macdAboveZero) {
    risks.push('MACD DEA位于零轴下方')
  }

  if (item.bollAboveMid == null) {
    unknowns.push('BOLL中轨位置未知')
  } else if (!item.bollAboveMid) {
    risks.push('现价位于BOLL中轨下方')
  }

  if (item.facts?.turnoverRatio == null) {
    unknowns.push('换手率缺失，量能质量未参与评分')
  } else {
    facts.push({
      key: 'turnover-ratio',
      label: '近10/前20日换手比',
      value: item.facts.turnoverRatio.toFixed(2),
      tone: item.facts.turnoverRatio >= 0.8 && item.facts.turnoverRatio <= 1.2 ? 'positive' : 'neutral',
    })
  }

  if (validWeightPct == null) unknowns.push('有效评分权重未记录')

  const insufficient = item.dataCoverage.state !== 'ready'
    || item.totalScore == null
    || validWeightPct == null
    || validWeightPct < 70
    || !benchmarkCurrent
  const status: LocalTrendSummaryStatus = insufficient
    ? 'insufficient'
    : unknowns.length > 0 || (validWeightPct != null && validWeightPct < 100)
      ? 'degraded'
      : 'ready'

  return {
    method: 'local-rules',
    status,
    headline: insufficient ? insufficientHeadline(item, validWeightPct, benchmarkCurrent) : stateHeadline(item),
    asOf,
    validWeightPct,
    facts,
    risks: unique(risks),
    unknowns: unique(unknowns),
  }
}

function stateHeadline(item: TrendWorkbenchItem): string {
  if (item.trendState === 'strengthening') return '趋势结构转强，近5日评分同步改善'
  if (item.trendState === 'strong') return '趋势结构保持强势，长期均线仍完整'
  if (item.trendState === 'weakening') return '趋势结构正在走弱，近5日评分回落'
  if (item.trendState === 'broken') return '长期趋势结构处于破坏状态'
  return '趋势结构处于中性稳定区间'
}

function insufficientHeadline(
  item: TrendWorkbenchItem,
  validWeightPct: number | null,
  benchmarkCurrent: boolean,
): string {
  if (item.dataCoverage.state !== 'ready') {
    return `日线覆盖 ${item.dataCoverage.bars}/${item.dataCoverage.requiredBars}，暂不形成趋势结构结论`
  }
  if (!benchmarkCurrent) {
    return '沪深300基准尚未确认到最近已结算交易日，暂不形成综合趋势结论'
  }
  if (validWeightPct != null && validWeightPct < 70) {
    return `有效评分权重 ${validWeightPct}%，暂不形成综合趋势结论`
  }
  if (validWeightPct == null) {
    return '有效评分权重未知，暂不形成综合趋势结论'
  }
  return '可用评分维度不足，暂不形成综合趋势结论'
}

function addReturnFact(
  facts: LocalTrendFact[],
  key: string,
  label: string,
  value: number | null,
): void {
  if (value == null) return
  facts.push({
    key,
    label,
    value: `${formatSigned(value)}%`,
    tone: value >= 3 ? 'positive' : value <= -3 ? 'negative' : 'neutral',
  })
}

function formatSigned(value: number): string {
  const rounded = value.toFixed(1)
  return value > 0 ? `+${rounded}` : rounded
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
