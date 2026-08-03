import type {
  SectorFlowAuctionGuidance,
  SectorFlowItem,
  SectorFlowStock,
  SectorFlowThemeGuidance,
  SectorFlowThemeState,
} from './sectorFlowTypes'

export interface SectorFlowGuidanceResult {
  items: SectorFlowItem[]
  guidance: SectorFlowAuctionGuidance
}

export function buildSectorFlowGuidance(
  sourceItems: SectorFlowItem[],
  membersByBoard: Map<string, SectorFlowStock[]>,
): SectorFlowGuidanceResult {
  const items = sourceItems.map((item) => enrichCoreStocks(item, membersByBoard.get(item.boardCode) ?? []))
  if (items.length === 0 || items.every((item) => item.mainNetInflow == null)) {
    return {
      items,
      guidance: {
        stance: 'insufficient',
        confidence: 20,
        summary: '当前只有成交方向强度，无法据此判断主力资金是否支持次日竞价。',
        focusThemes: [],
        riskThemes: [],
      },
    }
  }

  const positiveCandidates = rankCandidates(items, 1, 12)
  const riskCandidates = rankCandidates(items, -1, 6)

  const focusThemes = clusterCandidates(positiveCandidates, membersByBoard)
    .slice(0, 3)
    .map((cluster) => toThemeGuidance(
      cluster.representative,
      cluster.related,
      1,
      membersByBoard.has(cluster.representative.boardCode),
    ))
  const riskThemes = clusterCandidates(riskCandidates, membersByBoard)
    .slice(0, 3)
    .map((cluster) => toThemeGuidance(
      cluster.representative,
      cluster.related,
      -1,
      membersByBoard.has(cluster.representative.boardCode),
    ))

  const relatedByCode = new Map<string, Array<{ boardCode: string; boardName: string }>>()
  for (const theme of [...focusThemes, ...riskThemes]) relatedByCode.set(theme.boardCode, theme.relatedThemes)
  const enrichedItems = items.map((item) => ({ ...item, relatedThemes: relatedByCode.get(item.boardCode) ?? item.relatedThemes }))
  const positiveStrength = average(focusThemes.map((theme) => theme.score))
  const riskStrength = average(riskThemes.map((theme) => theme.score))
  const stance = focusThemes.length === 0
    ? 'defensive'
    : positiveStrength >= 68 && positiveStrength >= riskStrength + 8
      ? 'focus'
      : riskStrength > positiveStrength + 5
        ? 'defensive'
        : 'selective'
  const confidence = clamp(Math.round(average([...focusThemes, ...riskThemes].map((theme) => theme.confidence)) || 35), 20, 92)
  const summary = stance === 'focus'
    ? `资金与上涨广度集中在${focusThemes.map((theme) => theme.boardName).join('、')}，明早优先验证核心股竞价是否继续同向。`
    : stance === 'defensive'
      ? `流出或分化主题的强度不弱于流入主线，明早先验证风险是否收敛，避免把单日涨幅当作延续。`
      : `主线存在但资金集中度一般，明早只观察竞价确认，不把盘后排名直接外推为延续。`

  return { items: enrichedItems, guidance: { stance, confidence, summary, focusThemes, riskThemes } }
}

export function selectSectorFlowMemberCandidateCodes(
  sourceItems: SectorFlowItem[],
  positiveLimit = 12,
  riskLimit = 6,
): string[] {
  return Array.from(new Set([
    ...rankCandidates(sourceItems, 1, positiveLimit),
    ...rankCandidates(sourceItems, -1, riskLimit),
  ].map((item) => item.boardCode)))
}

function enrichCoreStocks(item: SectorFlowItem, members: SectorFlowStock[]): SectorFlowItem {
  const direction = (item.mainNetInflow ?? 0) >= 0 ? 1 : -1
  const ranked = [...members].sort((left, right) => {
    const leftFlow = left.mainNetInflow ?? 0
    const rightFlow = right.mainNetInflow ?? 0
    return direction > 0 ? rightFlow - leftFlow : leftFlow - rightFlow
  })
  const coreStocks = ranked
    .filter((stock) => stock.mainNetInflow == null || direction * stock.mainNetInflow > 0)
    .slice(0, 3)
  if (coreStocks.length === 0 && item.leader) coreStocks.push(item.leader)
  return { ...item, coreStocks }
}

function clusterCandidates(
  candidates: SectorFlowItem[],
  membersByBoard: Map<string, SectorFlowStock[]>,
): Array<{ representative: SectorFlowItem; related: SectorFlowItem[] }> {
  const clusters: Array<{ representative: SectorFlowItem; related: SectorFlowItem[] }> = []
  for (const candidate of candidates) {
    const candidateMembers = codeSet(membersByBoard.get(candidate.boardCode) ?? [])
    const cluster = clusters.find((entry) => {
      const clusterItems = [entry.representative, ...entry.related]
      return clusterItems.some((clusterItem) => {
        if (hasDeclaredRelation(candidate, clusterItem)) return true
        const clusterMembers = codeSet(membersByBoard.get(clusterItem.boardCode) ?? [])
        return isHighlyOverlapping(candidateMembers, clusterMembers)
      })
    })
    if (cluster) cluster.related.push(candidate)
    else clusters.push({ representative: candidate, related: [] })
  }
  return clusters
}

function hasDeclaredRelation(left: SectorFlowItem, right: SectorFlowItem): boolean {
  return left.relatedThemes.some((item) => item.boardCode === right.boardCode)
    || right.relatedThemes.some((item) => item.boardCode === left.boardCode)
}

function isHighlyOverlapping(left: Set<string>, right: Set<string>): boolean {
  if (left.size < 3 || right.size < 3) return false
  let intersection = 0
  for (const code of left) if (right.has(code)) intersection += 1
  const union = left.size + right.size - intersection
  const jaccard = union > 0 ? intersection / union : 0
  const containment = intersection / Math.min(left.size, right.size)
  return jaccard >= 0.55 || containment >= 0.72
}

function codeSet(stocks: SectorFlowStock[]): Set<string> {
  return new Set(stocks.map((stock) => stock.tsCode))
}

function toThemeGuidance(
  item: SectorFlowItem,
  related: SectorFlowItem[],
  direction: 1 | -1,
  hasMemberCoverage: boolean,
): SectorFlowThemeGuidance {
  const score = Math.round(scoreItem(item, direction))
  const breadthRate = item.memberCount > 0 ? item.upCount / item.memberCount : null
  const state = classifyState(item, breadthRate, direction, hasMemberCoverage)
  const hasPrevious = item.previousMainNetInflow != null
  const confidence = clamp(44 + (hasPrevious ? 16 : 0) + (hasMemberCoverage ? 14 : 0) + (item.memberCount > 0 ? 8 : 0) + Math.round(Math.min(10, Math.abs(item.mainNetInflowRate ?? 0))), 35, 92)
  const relatedThemes = Array.from(new Map(
    [
      ...item.relatedThemes,
      ...related.map((entry) => ({ boardCode: entry.boardCode, boardName: entry.boardName })),
    ].map((entry) => [entry.boardCode, entry]),
  ).values())
  const coreNames = item.coreStocks.map((stock) => stock.name).join('、') || '代表股'
  const reason = buildReason(item, breadthRate, state)
  const confirmations = direction > 0
    ? [
        `${coreNames}中至少两只竞价红盘，且没有仅靠单只个股独立高开。`,
        `开盘后板块主力资金保持净流入，上涨家数占比不低于盘后水平的六成。`,
      ]
    : [
        `${coreNames}竞价弱势未继续扩散，低开个股数量较盘后风险覆盖明显收窄。`,
        `开盘后板块主力流出收敛，而不是只靠指数反弹掩盖个股弱势。`,
      ]
  const invalidations = direction > 0
    ? [
        `${coreNames}多数低开且开盘15分钟内无法修复。`,
        `板块主力资金转为净流出，或上涨覆盖降至半数以下。`,
      ]
    : [
        `${coreNames}竞价与开盘资金同步转强，原有流出未延续。`,
        `风险仅集中在少数个股，板块上涨覆盖恢复至半数以上。`,
      ]
  return {
    boardCode: item.boardCode,
    boardName: item.boardName,
    scope: item.scope,
    state,
    score,
    confidence,
    mainNetInflow: item.mainNetInflow ?? 0,
    mainNetInflowRate: item.mainNetInflowRate,
    previousMainNetInflow: item.previousMainNetInflow,
    weightedChange: item.weightedChange,
    breadthRate,
    reason,
    coreStocks: item.coreStocks,
    relatedThemes,
    confirmations,
    invalidations,
  }
}

function classifyState(
  item: SectorFlowItem,
  breadthRate: number | null,
  direction: 1 | -1,
  hasMemberCoverage: boolean,
): SectorFlowThemeState {
  const flow = item.mainNetInflow ?? 0
  const previous = item.previousMainNetInflow
  if (direction < 0) return item.weightedChange < 0 || (breadthRate != null && breadthRate < 0.42) ? 'retreat' : 'divergence'
  if (item.weightedChange <= 0 || (breadthRate != null && breadthRate < 0.5)) return 'divergence'
  if (previous != null && previous <= 0 && flow > 0) return 'rotation'
  if (previous == null && !hasMemberCoverage) return 'insufficient'
  return 'continuation'
}

function buildReason(item: SectorFlowItem, breadthRate: number | null, state: SectorFlowThemeState): string {
  const labels: Record<SectorFlowThemeState, string> = {
    continuation: '资金、涨幅和上涨覆盖同向，具备延续观察价值',
    rotation: '较前一日由流出转为流入，属于新出现的轮动线索',
    divergence: '资金与涨幅或上涨覆盖没有形成一致方向',
    retreat: '主力流出与个股弱势相互印证，风险仍在扩散',
    insufficient: '缺少前序或成分事实，只能保留为低置信观察',
  }
  const breadth = breadthRate == null ? '上涨覆盖未知' : `上涨覆盖${Math.round(breadthRate * 100)}%`
  return `${labels[state]}；${breadth}，板块涨跌${formatSigned(item.weightedChange)}%。`
}

function scoreItem(item: SectorFlowItem, direction: 1 | -1): number {
  const flowRate = direction * (item.mainNetInflowRate ?? 0)
  const change = direction * item.weightedChange
  const breadthRate = item.memberCount > 0 ? item.upCount / item.memberCount : 0.5
  const breadth = direction > 0 ? breadthRate : 1 - breadthRate
  const previous = item.previousMainNetInflow
  const deltaBoost = previous == null || item.mainNetInflow == null
    ? 0
    : clamp(direction * (item.mainNetInflow - previous) / Math.max(Math.abs(previous), item.totalAmount * 0.01), -1, 1) * 10
  return clamp(42 + clamp(flowRate, -8, 8) * 3.2 + clamp(change, -5, 5) * 3 + (breadth - 0.5) * 32 + deltaBoost, 0, 100)
}

function rankCandidates(items: SectorFlowItem[], direction: 1 | -1, limit: number): SectorFlowItem[] {
  return items
    .filter((item) => direction * (item.mainNetInflow ?? 0) > 0)
    .sort((left, right) => scoreItem(right, direction) - scoreItem(left, direction))
    .slice(0, limit)
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function formatSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`
}
