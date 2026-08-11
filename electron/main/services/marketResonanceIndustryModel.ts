import { SHENWAN_L2_TO_L1_NAME } from './eastmoneyIndustryHierarchy'

export type MarketIndustryStructureState =
  | 'broad_strength'
  | 'concentrated_lead'
  | 'divergent'
  | 'broad_weakness'
  | 'insufficient'

export interface MarketIndustryStructureFact {
  name: string
  weightedChange: number
}

export interface MarketIndustryStructure {
  state: MarketIndustryStructureState
  available: number
  total: number
  leaders: string[]
  laggards: string[]
  summary: string
}

const STRUCTURE_STATES = new Set<MarketIndustryStructureState>([
  'broad_strength',
  'concentrated_lead',
  'divergent',
  'broad_weakness',
  'insufficient',
])

export function getShenwanL2Names(parentIndustryName: string): string[] {
  return Object.entries(SHENWAN_L2_TO_L1_NAME)
    .filter(([, parentName]) => parentName === parentIndustryName)
    .map(([childName]) => childName)
}

export function buildMarketIndustryStructure(
  parentIndustryName: string,
  parentChange: number | null,
  facts: MarketIndustryStructureFact[],
): MarketIndustryStructure {
  const expectedNames = getShenwanL2Names(parentIndustryName)
  const expected = new Set(expectedNames)
  const deduped = new Map<string, MarketIndustryStructureFact>()
  for (const fact of facts) {
    if (!expected.has(fact.name) || !Number.isFinite(fact.weightedChange)) continue
    deduped.set(fact.name, fact)
  }
  const ordered = [...deduped.values()].sort((left, right) => right.weightedChange - left.weightedChange)
  const total = expectedNames.length
  const available = ordered.length
  const leaders = ordered.filter((fact) => fact.weightedChange > 0).slice(0, 2).map((fact) => fact.name)
  const laggards = ordered.filter((fact) => fact.weightedChange < 0).slice(-2).reverse().map((fact) => fact.name)
  const minimumCoverage = total <= 1 ? total : Math.max(2, Math.ceil(total * 0.6))

  if (total === 0 || available < minimumCoverage) {
    return {
      state: 'insufficient',
      available,
      total,
      leaders,
      laggards,
      summary: total === 0
        ? `${parentIndustryName}暂无可用的申万二级行业映射。`
        : `${parentIndustryName}仅覆盖${available}/${total}个二级行业，暂不足以判断内部结构。`,
    }
  }

  const positiveCount = ordered.filter((fact) => fact.weightedChange > 0).length
  const negativeCount = ordered.filter((fact) => fact.weightedChange < 0).length
  const positiveRatio = positiveCount / available
  const negativeRatio = negativeCount / available
  const leaderText = joinNames(leaders)
  const laggardText = joinNames(laggards)
  const topChange = ordered[0]?.weightedChange ?? 0

  if (positiveRatio >= 0.7) {
    return {
      state: 'broad_strength',
      available,
      total,
      leaders,
      laggards,
      summary: `${parentIndustryName}内部多数二级行业上涨，${leaderText}领涨。`,
    }
  }
  if (negativeRatio >= 0.7) {
    return {
      state: 'broad_weakness',
      available,
      total,
      leaders,
      laggards,
      summary: `${parentIndustryName}内部多数二级行业下跌，${laggardText}拖累更明显。`,
    }
  }
  if (
    parentChange != null
    && parentChange > 0
    && positiveRatio < 0.7
    && topChange > 0
    && topChange - parentChange >= 0.75
  ) {
    return {
      state: 'concentrated_lead',
      available,
      total,
      leaders,
      laggards,
      summary: `${parentIndustryName}的上涨主要集中在${leaderText}，其余二级行业跟随有限。`,
    }
  }
  return {
    state: 'divergent',
    available,
    total,
    leaders,
    laggards,
    summary: positiveCount > 0 && negativeCount > 0
      ? `${parentIndustryName}内部分化，${leaderText}走强，但${laggardText}形成拖累。`
      : `${parentIndustryName}二级行业强弱不一，暂未形成一致方向。`,
  }
}

export function isMarketIndustryStructure(value: unknown): value is MarketIndustryStructure {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const input = value as Partial<MarketIndustryStructure>
  return STRUCTURE_STATES.has(input.state as MarketIndustryStructureState)
    && Number.isInteger(input.available)
    && Number.isInteger(input.total)
    && Array.isArray(input.leaders)
    && input.leaders.every((item) => typeof item === 'string')
    && Array.isArray(input.laggards)
    && input.laggards.every((item) => typeof item === 'string')
    && typeof input.summary === 'string'
}

function joinNames(names: string[]): string {
  return names.length > 0 ? names.join('、') : '相对强势分项'
}
