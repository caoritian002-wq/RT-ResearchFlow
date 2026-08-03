import type {
  MorningAuctionThemeAttribution,
  MorningAuctionThemeConfidence,
  MorningAuctionThemeEvidence,
  MorningAuctionThemePeer,
} from '../database/types'

export interface MorningAuctionThemeStockInput {
  tsCode: string
  stockName: string
  conceptNames: string[]
  pctChg: number
  auctionAmount: number
}

export interface MorningAuctionDirectThemeFact {
  tradeDate: string
  themes: string[]
  reason: string | null
}

const GENERIC_THEME_PATTERN = /融资融券|沪股通|深股通|陆股通|MSCI|富时罗素|标普道琼斯|证金持股|基金重仓|机构重仓|转融券|参股新三板/i

function isGenericTheme(name: string): boolean {
  return GENERIC_THEME_PATTERN.test(name)
}

function normalizeTheme(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function uniqueThemes(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = normalizeTheme(value)
    if (!normalized || normalized === '无题材' || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

export function splitMorningAuctionThemeNames(value: string | null | undefined): string[] {
  if (!value) return []
  return uniqueThemes(value.split(/[、,，;；/+＋|]+/))
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function buildConfidence(
  direct: boolean,
  activePeerCount: number,
  peerCount: number,
): MorningAuctionThemeConfidence {
  if (direct && activePeerCount >= 1) return 'high'
  if (direct || activePeerCount >= 3) return 'medium'
  if (peerCount >= 1) return 'low'
  return 'none'
}

function formatSignedPct(value: number | null): string {
  if (value == null) return '暂无均值'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

export function buildMorningAuctionThemeAttributions(
  stockInputs: MorningAuctionThemeStockInput[],
  directFacts: Map<string, MorningAuctionDirectThemeFact>,
): Map<string, MorningAuctionThemeAttribution> {
  const stocks = [...new Map(stockInputs.map((stock) => [stock.tsCode, stock])).values()]
  const themesByStock = new Map<string, string[]>()
  const membersByTheme = new Map<string, MorningAuctionThemeStockInput[]>()

  for (const stock of stocks) {
    const fact = directFacts.get(stock.tsCode)
    const themes = uniqueThemes([...(fact?.themes ?? []), ...stock.conceptNames])
    themesByStock.set(stock.tsCode, themes)
    for (const theme of themes) {
      const members = membersByTheme.get(theme) ?? []
      members.push(stock)
      membersByTheme.set(theme, members)
    }
  }

  const result = new Map<string, MorningAuctionThemeAttribution>()
  for (const stock of stocks) {
    const fact = directFacts.get(stock.tsCode)
    const directThemes = uniqueThemes(fact?.themes ?? [])
    const directSet = new Set(directThemes)
    const allThemes = themesByStock.get(stock.tsCode) ?? []

    const evidence = allThemes.map((name, index): MorningAuctionThemeEvidence => {
      const members = membersByTheme.get(name) ?? []
      const peers = members
        .filter((member) => member.tsCode !== stock.tsCode)
        .sort((left, right) => {
          const leftPower = left.auctionAmount * Math.max(left.pctChg, 0)
          const rightPower = right.auctionAmount * Math.max(right.pctChg, 0)
          return rightPower - leftPower
        })
      const activeMembers = members.filter((member) => member.pctChg >= 1 && member.auctionAmount >= 100)
      const activePeers = activeMembers.filter((member) => member.tsCode !== stock.tsCode)
      const averageAuctionPct = activeMembers.length > 0
        ? round(activeMembers.reduce((sum, member) => sum + member.pctChg, 0) / activeMembers.length)
        : null
      const totalAuctionAmount = round(members.reduce((sum, member) => sum + Math.max(member.auctionAmount, 0), 0))
      const isDirect = directSet.has(name)
      const directRank = directThemes.indexOf(name)
      const genericPenalty = isGenericTheme(name) && !isDirect ? 36 : 0
      const directScore = isDirect ? Math.max(48, 68 - Math.max(directRank, 0) * 4) : 0
      const breadthScore = Math.min(24, activePeers.length * 8)
      const strengthScore = averageAuctionPct == null ? 0 : Math.min(14, Math.max(0, averageAuctionPct) * 2)
      const amountScore = totalAuctionAmount <= 0 ? 0 : Math.min(10, Math.log10(totalAuctionAmount + 1) * 2.2)
      const staticRankScore = Math.max(0, 4 - index * 0.5)
      const score = round(Math.max(0, directScore + breadthScore + strengthScore + amountScore + staticRankScore - genericPenalty))
      const basis: string[] = []
      if (isDirect && fact) basis.push(`${fact.tradeDate} 直接题材记录`)
      if (isDirect && fact?.reason) basis.push('上一交易日涨停原因可追溯')
      if (activePeers.length > 0) basis.push(`另有 ${activePeers.length} 只竞价候选共振`)
      if (averageAuctionPct != null) basis.push(`相关候选平均竞价 ${formatSignedPct(averageAuctionPct)}`)
      if (isGenericTheme(name) && !isDirect) basis.push('基础属性题材不参与主驱动竞争')
      const peerItems: MorningAuctionThemePeer[] = peers.slice(0, 4).map((peer) => ({
        tsCode: peer.tsCode,
        stockName: peer.stockName,
        auctionPctChg: peer.pctChg,
        auctionAmount: peer.auctionAmount,
      }))
      return {
        name,
        score,
        direct: isDirect,
        peerCount: peers.length,
        activePeerCount: activePeers.length,
        averageAuctionPct,
        totalAuctionAmount,
        peers: peerItems,
        basis,
      }
    })

    const directCandidates = evidence.filter((item) => item.direct).sort((a, b) => b.score - a.score)
    const resonanceCandidates = evidence
      .filter((item) => !item.direct && !isGenericTheme(item.name) && item.activePeerCount >= 1 && item.averageAuctionPct != null && item.averageAuctionPct >= 1)
      .sort((a, b) => b.score - a.score)
    const primary = directCandidates[0] ?? resonanceCandidates[0] ?? null
    const state = primary?.direct ? 'direct' : primary ? 'resonance' : 'unresolved'
    const confidence = primary
      ? buildConfidence(primary.direct, primary.activePeerCount, primary.peerCount)
      : 'none'
    const resonance = evidence
      .filter((item) => item.name !== primary?.name && (item.direct || !isGenericTheme(item.name)) && item.activePeerCount >= 1 && item.averageAuctionPct != null && item.averageAuctionPct >= 1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
    const emphasized = new Set([primary?.name, ...resonance.map((item) => item.name)].filter(Boolean))
    const staticThemes = allThemes.filter((name) => !emphasized.has(name))
    const summary = primary?.direct
      ? `早盘主驱动优先指向“${primary.name}”${primary.activePeerCount > 0 ? `，另有 ${primary.activePeerCount} 只竞价候选同步走强` : '，当前主要依据上一交易日直接题材记录'}。`
      : primary
        ? `尚无直接原因记录，“${primary.name}”因 ${primary.activePeerCount} 只竞价候选共振，暂列早盘主驱动线索。`
        : allThemes.length > 0
          ? '现有数据只有静态关联题材，尚不能确认早盘主要交易方向。'
          : '当前没有可用题材映射，早盘主驱动仍待补齐。'

    result.set(stock.tsCode, {
      state,
      confidence,
      primary,
      resonance,
      staticThemes,
      allThemes,
      directReason: fact?.reason?.trim() || null,
      sourceTradeDate: fact?.tradeDate ?? null,
      summary,
    })
  }
  return result
}
