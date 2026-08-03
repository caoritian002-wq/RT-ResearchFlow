import type {
  PremarketHoldingEvidence,
  PremarketHoldingScenarioState,
  PremarketScenarioBranch,
  PremarketScenarioEvidenceV1,
  PremarketScenarioResultV1,
  PremarketScenarioStatus,
} from './premarketRehearsalTypes'

export const PREMARKET_SCENARIO_RULE_VERSION = 'premarket-scenario-v1' as const

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function classifyHolding(holding: PremarketHoldingEvidence): PremarketHoldingScenarioState {
  const auctionGap = holding.auction?.gapPercent ?? null
  const risk = holding.trend.trendState === 'broken'
    || holding.trend.trendState === 'weakening'
    || (auctionGap != null && auctionGap <= -2)
    || (holding.chip.trappedPct != null && holding.chip.trappedPct >= 60)
  const aligned = (
    holding.trend.trendState === 'strong'
    || holding.trend.trendState === 'strengthening'
  ) && (auctionGap == null || auctionGap >= 0)
  const insufficient = holding.trend.status === 'missing'
    && holding.chip.status === 'missing'
    && holding.auction == null
  const state = insufficient ? 'insufficient' : risk ? 'risk' : aligned ? 'aligned' : 'watching'
  const summary = state === 'risk'
    ? '趋势、筹码或竞价中存在需要优先核对的反向证据'
    : state === 'aligned'
      ? '本地趋势与当前可见竞价未形成明显冲突'
      : state === 'insufficient'
        ? '趋势、筹码与竞价证据均不足'
        : '证据未形成一致方向，等待开盘后确认'
  return {
    tsCode: holding.tsCode,
    stockName: holding.stockName,
    state,
    summary,
    referenceIds: holding.referenceIds,
  }
}

function deriveStatus(evidence: PremarketScenarioEvidenceV1): PremarketScenarioStatus {
  if (
    evidence.previousTradeDate == null
    || evidence.holdings.length === 0
    || evidence.market.baseFactSnapshotId == null
    || evidence.market.snapshotStatus === 'blocked'
    || evidence.market.snapshotStatus === 'failed'
    || evidence.market.externalRiskTone === 'insufficient'
    || evidence.warnings.includes('ASIA_OPEN_SCENARIO_VERSION_MISSING')
    || (evidence.stage === 'auction_confirmed' && evidence.auctionMatchedCount === 0)
  ) return 'blocked'
  const incompleteHolding = evidence.holdings.some((holding) => (
    holding.trend.status !== 'ready'
    || holding.chip.status !== 'ready'
    || (evidence.stage === 'auction_confirmed' && holding.auction == null)
  ))
  const missingSectorFlow = evidence.sectors.length === 0
    || evidence.sectors.every((sector) => sector.mainNetInflow == null)
  return evidence.market.snapshotStatus === 'partial'
    || incompleteHolding
    || missingSectorFlow
    || evidence.warnings.length > 0
    ? 'partial'
    : 'ready'
}

function branch(
  input: Omit<PremarketScenarioBranch, 'confirmConditions' | 'invalidationConditions' | 'unknowns'> & {
    confirmConditions?: string[]
    invalidationConditions?: string[]
    unknowns?: string[]
  },
): PremarketScenarioBranch {
  return {
    ...input,
    supportingReferenceIds: unique(input.supportingReferenceIds).slice(0, 24),
    counterReferenceIds: unique(input.counterReferenceIds).slice(0, 24),
    confirmConditions: unique(input.confirmConditions ?? []).slice(0, 8),
    invalidationConditions: unique(input.invalidationConditions ?? []).slice(0, 8),
    unknowns: unique(input.unknowns ?? []).slice(0, 12),
  }
}

export function buildPremarketScenarioResult(
  evidence: PremarketScenarioEvidenceV1,
): PremarketScenarioResultV1 {
  const status = deriveStatus(evidence)
  const holdings = evidence.holdings.map(classifyHolding)
  const aligned = holdings.filter((item) => item.state === 'aligned')
  const risks = holdings.filter((item) => item.state === 'risk')
  const insufficient = holdings.filter((item) => item.state === 'insufficient')
  const positiveAuction = evidence.holdings.filter((item) => (item.auction?.gapPercent ?? -Infinity) >= 0)
  const negativeAuction = evidence.holdings.filter((item) => (item.auction?.gapPercent ?? Infinity) <= -2)
  const positiveFlows = evidence.sectors.filter((item) => (item.mainNetInflow ?? 0) > 0)
  const negativeFlows = evidence.sectors.filter((item) => (item.mainNetInflow ?? 0) < 0)
  const marketState = evidence.market.externalRiskTone === 'broad_risk_on'
    ? 'constructive' as const
    : evidence.market.externalRiskTone === 'broad_risk_off'
      ? 'defensive' as const
      : evidence.market.externalRiskTone === 'mixed'
        ? 'mixed' as const
        : 'insufficient' as const
  const confidence = status === 'ready'
    ? evidence.market.confidence
    : status === 'partial'
      ? evidence.market.confidence === 'low' ? 'low' : 'medium'
      : 'low'
  const marketRefs = evidence.market.referenceIds
  const alignedRefs = aligned.flatMap((item) => item.referenceIds)
  const riskRefs = risks.flatMap((item) => item.referenceIds)
  const positiveFlowRefs = positiveFlows.map((item) => item.referenceId)
  const negativeFlowRefs = negativeFlows.map((item) => item.referenceId)
  const commonUnknowns = [
    ...(insufficient.length > 0 ? [`${insufficient.length}只持仓的本地证据不足`] : []),
    ...(evidence.sectors.every((item) => item.mainNetInflow == null) ? ['持仓行业与题材缺少上一交易日已验证资金'] : []),
    ...(evidence.stage === 'asia_open' ? ['09:25真实竞价尚未进入本版本'] : []),
  ]

  const baseSupport = status === 'blocked' ? 'insufficient' : 'supported'
  const reinforcedSupport = status === 'blocked'
    ? 'insufficient'
    : marketState === 'constructive'
      && aligned.length > 0
      && (evidence.stage === 'asia_open' || positiveAuction.length > 0)
      ? 'supported'
      : 'watching'
  const riskSupport = status === 'blocked' && risks.length === 0
    ? 'insufficient'
    : marketState === 'defensive' || risks.length > 0 || negativeAuction.length > 0
      ? 'supported'
      : 'watching'

  const branches: PremarketScenarioBranch[] = [
    branch({
      key: 'base',
      label: '基准情景',
      support: baseSupport,
      confidence,
      summary: status === 'blocked'
        ? '关键盘前事实不足，当前只能保留观察框架'
        : `外部环境${marketState === 'constructive' ? '偏积极' : marketState === 'defensive' ? '偏防御' : '分化'}，组合以逐股确认而非外盘直接映射为主`,
      supportingReferenceIds: [...marketRefs, ...positiveFlowRefs, ...alignedRefs],
      counterReferenceIds: [...negativeFlowRefs, ...riskRefs],
      confirmConditions: evidence.stage === 'asia_open'
        ? ['09:25持仓竞价与外部风险方向未明显冲突', '开盘后行业强弱与上一交易日资金线索一致']
        : ['开盘后持仓未快速跌破竞价参考价', '行业强弱未与昨日资金线索显著背离'],
      invalidationConditions: ['持仓竞价或开盘路径与外部风险证据明显反向', '组合风险项数量继续增加'],
      unknowns: commonUnknowns,
    }),
    branch({
      key: 'reinforced',
      label: '强化情景',
      support: reinforcedSupport,
      confidence: reinforcedSupport === 'supported' ? confidence : 'low',
      summary: reinforcedSupport === 'supported'
        ? '外部风险偏好与部分持仓本地证据形成同向确认'
        : '尚未形成外部、行业和持仓三层同向证据',
      supportingReferenceIds: [...marketRefs, ...positiveFlowRefs, ...alignedRefs],
      counterReferenceIds: [...negativeFlowRefs, ...riskRefs],
      confirmConditions: ['同向持仓竞价获得行业或题材共振', '趋势完整持仓开盘后保持结构稳定'],
      invalidationConditions: ['竞价高开后迅速失去承接', '行业或题材出现与昨日资金线索相反的扩散'],
      unknowns: commonUnknowns,
    }),
    branch({
      key: 'risk',
      label: '风险情景',
      support: riskSupport,
      confidence: riskSupport === 'supported' ? confidence : 'low',
      summary: riskSupport === 'supported'
        ? `${risks.length}只持仓存在趋势、筹码或竞价反向证据，需要优先验证`
        : '当前反向证据未形成组合层共振，但仍需观察开盘路径',
      supportingReferenceIds: [...marketRefs, ...negativeFlowRefs, ...riskRefs],
      counterReferenceIds: [...positiveFlowRefs, ...alignedRefs],
      confirmConditions: ['风险持仓开盘后继续弱于竞价参考价', '负向行业或题材资金线索扩散至更多持仓'],
      invalidationConditions: ['风险持仓收复竞价参考价且行业同步修复', '原反向证据被后续可验证事实否定'],
      unknowns: commonUnknowns,
    }),
  ]
  const headline = status === 'blocked'
    ? '盘前关键证据不足，暂不形成方向性推演'
    : risks.length > 0
      ? `组合中${risks.length}只持仓存在优先验证的反向证据`
      : aligned.length > 0
        ? `${aligned.length}只持仓与当前盘前证据未形成明显冲突`
        : '盘前证据分化，等待竞价与开盘路径确认'

  return {
    schemaVersion: 1,
    ruleVersion: PREMARKET_SCENARIO_RULE_VERSION,
    tradeDate: evidence.tradeDate,
    stage: evidence.stage,
    status,
    marketState,
    confidence,
    headline,
    branches,
    holdings,
    warnings: evidence.warnings,
  }
}
