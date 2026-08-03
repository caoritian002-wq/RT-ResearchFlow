import type Database from 'better-sqlite3'
import { getPremarketFactSnapshot } from '../database/premarketFactSnapshotRepository'
import { listPortfolioStocks } from '../database/portfolioRepository'
import {
  getLatestVerifiedObservationDateBefore,
  listSectorFlowObservations,
} from '../database/sectorFlowObservationRepository'
import { getStockBasicByTsCodes } from '../database/stockBasicCacheRepository'
import { queryByDate } from '../database/stkAuctionCacheRepository'
import { getPrevTradeDay } from '../database/tradeCalRepository'
import { buildCompatibleChipStructureSummaries } from './chipSummaryService'
import { getConceptsByStockRouted, type ConceptSource } from './conceptRouter'
import {
  getPremarketAuctionEvidenceDeadlineAt,
  getPremarketScenarioFactCutoffAt,
} from './premarketCutoffPolicy'
import type {
  PremarketEvidenceReference,
  PremarketHoldingEvidence,
  PremarketScenarioEvidenceV1,
  PremarketScenarioStage,
  PremarketSectorEvidence,
} from './premarketRehearsalTypes'
import { PREMARKET_FACT_RULE_VERSION } from './premarketSnapshotService'
import { executeResearchFactTool } from './researchFactToolRegistry'
import { getStockFundamentalSnapshot } from './stockFundamentalService'

const MAX_HOLDINGS = 50
const MAX_CONCEPTS = 8
const MAX_ANNOUNCEMENTS = 3
const MAX_BRIEFINGS = 3

function normalizeTsCode(value: string): string {
  const clean = value.trim().toUpperCase()
  if (/^\d{6}\.(?:SH|SZ|BJ)$/.test(clean)) return clean
  const code = clean.replace(/\.(SH|SZ|BJ)$/i, '')
  if (/^(4|8|920)/.test(code)) return `${code}.BJ`
  if (/^(5|6|9)/.test(code)) return `${code}.SH`
  return `${code}.SZ`
}

function finite(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null
}

function percentChange(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous <= 0) return null
  return ((current - previous) / previous) * 100
}

function readConceptSource(db: Database.Database): ConceptSource {
  try {
    const row = db.prepare('SELECT concept_source FROM app_settings WHERE id = 1')
      .get() as { concept_source: string | null } | undefined
    if (row?.concept_source === 'ths' || row?.concept_source === 'dc') return row.concept_source
  } catch {
    // The established default remains KPL when settings are unavailable.
  }
  return 'kpl'
}

function safeConcepts(
  db: Database.Database,
  tsCode: string,
  source: ConceptSource,
  tradeDate: string | null,
): Array<{ code: string; name: string }> {
  try {
    return getConceptsByStockRouted(db, tsCode, source, tradeDate ?? undefined)
      .slice(0, MAX_CONCEPTS)
      .map((item) => ({ code: item.conceptCode, name: item.conceptName }))
  } catch {
    return []
  }
}

function appendWarning(target: string[], value: string): void {
  if (!target.includes(value) && target.length < 200) target.push(value)
}

interface EligibleBriefingRow {
  sourceId: number
  sourceName: string
  title: string
  publishedAt: number
  publishedDateBJ: string
  publicationTimeStatus: 'exact' | 'date_only' | 'collected_fallback'
  collectedAt: number
  impactRating: 'CRITICAL' | 'IMPORTANT' | 'GENERAL'
}

function listEligiblePremarketBriefings(
  db: Database.Database,
  input: {
    tradeDate: string
    factCutoffAt: number
    limit: number
    query?: string
  },
): EligibleBriefingRow[] {
  const dashedTradeDate = `${input.tradeDate.slice(0, 4)}-${input.tradeDate.slice(4, 6)}-${input.tradeDate.slice(6, 8)}`
  const conditions = [
    'publishedAt <= ?',
    'publishedAt >= ?',
    'publishedDateBJ <= ?',
    `(publicationTimeStatus = 'exact' OR publishedDateBJ < ? OR collectedAt <= ?)`,
  ]
  const params: Array<string | number> = [
    input.factCutoffAt,
    input.factCutoffAt - 72 * 60 * 60 * 1000,
    dashedTradeDate,
    dashedTradeDate,
    input.factCutoffAt,
  ]
  if (input.query) {
    conditions.push("(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')")
    const escaped = input.query.replace(/[\\%_]/g, (value) => `\\${value}`)
    params.push(`%${escaped}%`, `%${escaped}%`)
  }
  params.push(Math.max(1, Math.min(20, input.limit)))
  return db.prepare(`
    SELECT sourceId, sourceName, title, publishedAt, publishedDateBJ,
      publicationTimeStatus, collectedAt, impactRating
    FROM briefings
    WHERE ${conditions.join(' AND ')}
    ORDER BY publishedAt DESC, id DESC
    LIMIT ?
  `).all(...params) as EligibleBriefingRow[]
}

function isAnnouncementEligible(
  announcement: { noticeDate: string; displayAt: number | null; fetchedAt: number },
  tradeDate: string,
  factCutoffAt: number,
): boolean {
  if (announcement.noticeDate < tradeDate) return true
  if (announcement.noticeDate > tradeDate) return false
  if (announcement.displayAt != null) return announcement.displayAt <= factCutoffAt
  return announcement.fetchedAt <= factCutoffAt
}

export function buildPremarketScenarioEvidence(
  db: Database.Database,
  input: {
    tradeDate: string
    stage: PremarketScenarioStage
    generatedAt?: number
  },
): PremarketScenarioEvidenceV1 {
  const generatedAt = input.generatedAt ?? Date.now()
  const cutoffAt = getPremarketScenarioFactCutoffAt(input.tradeDate, input.stage)
  const previousTradeDate = getPrevTradeDay(db, input.tradeDate)
  const warnings: string[] = []
  const references: PremarketEvidenceReference[] = []
  const baseSnapshot = getPremarketFactSnapshot(
    db,
    input.tradeDate,
    'asia_open',
    PREMARKET_FACT_RULE_VERSION,
  )
  if (!previousTradeDate) appendWarning(warnings, 'PREVIOUS_TRADE_DATE_MISSING')
  if (!baseSnapshot) appendWarning(warnings, 'ASIA_OPEN_FACT_SNAPSHOT_MISSING')
  else if (baseSnapshot.status === 'blocked' || baseSnapshot.status === 'failed') {
    appendWarning(warnings, `ASIA_OPEN_FACT_${baseSnapshot.status.toUpperCase()}`)
  }

  const marketReferenceIds: string[] = []
  if (baseSnapshot) {
    const id = 'PM-MARKET-EXTERNAL'
    marketReferenceIds.push(id)
    references.push({
      id,
      layer: 'market',
      kind: 'external',
      label: '08:45外部风险事实',
      factDate: input.tradeDate,
      sourceId: baseSnapshot.providerId,
    })
  }
  const marketBriefings = listEligiblePremarketBriefings(db, {
    tradeDate: input.tradeDate,
    factCutoffAt: cutoffAt,
    limit: 5,
  })
  marketBriefings.forEach((item, index) => {
    const id = `PM-MARKET-NEWS-${String(index + 1).padStart(2, '0')}`
    marketReferenceIds.push(id)
    references.push({
      id,
      layer: 'market',
      kind: 'briefing',
      label: item.title,
      factDate: item.publishedDateBJ.replace(/-/g, ''),
      sourceId: `briefing:${item.sourceId}`,
    })
  })

  const holdings = listPortfolioStocks(db)
    .map((holding) => ({ ...holding, tsCode: normalizeTsCode(holding.tsCode) }))
    .sort((left, right) => left.tsCode.localeCompare(right.tsCode))
    .slice(0, MAX_HOLDINGS)
  if (holdings.length === 0) appendWarning(warnings, 'PORTFOLIO_EMPTY')
  if (listPortfolioStocks(db).length > MAX_HOLDINGS) appendWarning(warnings, 'PORTFOLIO_TRUNCATED_TO_50')

  const stockBasics = getStockBasicByTsCodes(db, holdings.map((item) => item.tsCode))
  const conceptSource = readConceptSource(db)
  const chipSummaries = previousTradeDate
    ? buildCompatibleChipStructureSummaries(
        db,
        holdings.map((holding) => ({ tsCode: holding.tsCode, stockName: holding.stockName })),
        undefined,
        previousTradeDate,
        'relative',
        'latest_complete',
      )
    : []
  const chipsByCode = new Map(chipSummaries.map((item) => [normalizeTsCode(item.tsCode), item]))
  const auctionRows = input.stage === 'auction_confirmed'
    ? queryByDate(db, input.tradeDate)
    : []
  const auctionsByCode = new Map(auctionRows.map((item) => [normalizeTsCode(item.tsCode), item]))
  const holdingConcepts = new Map<string, Array<{ code: string; name: string }>>()
  for (const holding of holdings) {
    holdingConcepts.set(
      holding.tsCode,
      safeConcepts(db, holding.tsCode, conceptSource, previousTradeDate),
    )
  }

  const flowTradeDate = getLatestVerifiedObservationDateBefore(db, input.tradeDate)
  const flows = flowTradeDate
    ? listSectorFlowObservations(db, flowTradeDate, 'eastmoney')
      .filter((item) => item.metricMode === 'verified_flow')
    : []
  if (!flowTradeDate) appendWarning(warnings, 'VERIFIED_SECTOR_FLOW_MISSING')
  else if (previousTradeDate && flowTradeDate < previousTradeDate) {
    appendWarning(warnings, 'VERIFIED_SECTOR_FLOW_STALE')
  }
  const flowsByKey = new Map(flows.map((item) => [`${item.scope}:${item.boardName}`, item]))
  const sectorHoldingCodes = new Map<string, Set<string>>()
  for (const holding of holdings) {
    const industry = stockBasics.get(holding.tsCode)?.industry?.trim()
    if (industry) {
      const key = `industry:${industry}`
      const codes = sectorHoldingCodes.get(key) ?? new Set<string>()
      codes.add(holding.tsCode)
      sectorHoldingCodes.set(key, codes)
    }
    for (const concept of holdingConcepts.get(holding.tsCode) ?? []) {
      const key = `concept:${concept.name}`
      const codes = sectorHoldingCodes.get(key) ?? new Set<string>()
      codes.add(holding.tsCode)
      sectorHoldingCodes.set(key, codes)
    }
  }
  const sectors: PremarketSectorEvidence[] = [...sectorHoldingCodes.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
    .slice(0, 120)
    .map(([key, codes], index) => {
      const separator = key.indexOf(':')
      const kind = key.slice(0, separator) as 'industry' | 'concept'
      const name = key.slice(separator + 1)
      const flow = flowsByKey.get(key)
      const referenceId = `PM-SECTOR-${String(index + 1).padStart(3, '0')}`
      references.push({
        id: referenceId,
        layer: 'sector',
        kind: 'sector_flow',
        label: `${kind === 'industry' ? '行业' : '题材'}：${name}`,
        factDate: flow ? flowTradeDate : null,
        sourceId: flow ? 'eastmoney.verified_sector_flow' : 'local.sector_identity',
      })
      return {
        key,
        kind,
        name,
        holdingCodes: [...codes].sort(),
        flowTradeDate: flow ? flowTradeDate : null,
        mainNetInflow: finite(flow?.mainNetInflow),
        mainNetInflowRate: finite(flow?.mainNetInflowRate),
        weightedChange: finite(flow?.weightedChange),
        referenceId,
      }
    })

  const holdingEvidence: PremarketHoldingEvidence[] = holdings.map((holding, index) => {
    const localWarnings: string[] = []
    const sequence = String(index + 1).padStart(3, '0')
    const referenceIds: string[] = []
    const trend = previousTradeDate
      ? executeResearchFactTool(db, 'stock.trend_snapshot', {
          stockCode: holding.tsCode,
          asOf: previousTradeDate,
        }, { now: generatedAt })
      : null
    const trendRef = `PM-HOLDING-${sequence}-TREND`
    referenceIds.push(trendRef)
    references.push({
      id: trendRef,
      layer: 'holding',
      kind: 'trend',
      label: `${holding.stockName}趋势`,
      factDate: trend?.data.tradeDate ?? null,
      sourceId: 'local.research_fact.stock_trend_snapshot',
    })
    if (!trend || trend.status !== 'ready') localWarnings.push('TREND_INCOMPLETE')

    const chip = chipsByCode.get(holding.tsCode)
    const chipStatus = !chip?.tradeDate
      ? 'missing' as const
      : chip.completenessStatus === 'complete'
        ? 'ready' as const
        : 'partial' as const
    const chipRef = `PM-HOLDING-${sequence}-CHIP`
    referenceIds.push(chipRef)
    references.push({
      id: chipRef,
      layer: 'holding',
      kind: 'chip',
      label: `${holding.stockName}筹码结构`,
      factDate: chip?.tradeDate ?? null,
      sourceId: 'local.chip_structure',
    })
    if (chipStatus !== 'ready') localWarnings.push('CHIP_INCOMPLETE')

    const fundamentalResult = getStockFundamentalSnapshot(db, holding.tsCode)
    const fundamentalSnapshot = fundamentalResult.ok ? fundamentalResult.snapshot : null
    const allAnnouncements = fundamentalSnapshot?.announcements ?? []
    const announcementItems = allAnnouncements
      .filter((item) => isAnnouncementEligible(item, input.tradeDate, cutoffAt))
      .slice(0, MAX_ANNOUNCEMENTS)
    announcementItems.forEach((item, itemIndex) => {
      const id = `PM-HOLDING-${sequence}-ANN-${itemIndex + 1}`
      referenceIds.push(id)
      references.push({
        id,
        layer: 'holding',
        kind: 'announcement',
        label: item.title,
        factDate: item.noticeDate,
        sourceId: 'eastmoney.announcement_index',
      })
    })
    if (!fundamentalSnapshot || fundamentalSnapshot.sources.announcement.status !== 'available') {
      localWarnings.push('ANNOUNCEMENT_INDEX_MISSING')
    }
    if (allAnnouncements.some((item) => !isAnnouncementEligible(item, input.tradeDate, cutoffAt))) {
      localWarnings.push('ANNOUNCEMENT_AFTER_FACT_CUTOFF_IGNORED')
    }

    const briefingItems = listEligiblePremarketBriefings(db, {
      tradeDate: input.tradeDate,
      factCutoffAt: cutoffAt,
      limit: MAX_BRIEFINGS,
      query: holding.stockName,
    })
    briefingItems.forEach((item, itemIndex) => {
      const id = `PM-HOLDING-${sequence}-NEWS-${itemIndex + 1}`
      referenceIds.push(id)
      references.push({
        id,
        layer: 'holding',
        kind: 'briefing',
        label: item.title,
        factDate: item.publishedDateBJ.replace(/-/g, ''),
        sourceId: `briefing:${item.sourceId}`,
      })
    })

    const auction = auctionsByCode.get(holding.tsCode)
    if (input.stage === 'auction_confirmed') {
      const id = `PM-HOLDING-${sequence}-AUCTION`
      referenceIds.push(id)
      references.push({
        id,
        layer: 'holding',
        kind: 'auction',
        label: `${holding.stockName}09:25竞价`,
        factDate: auction?.tradeDate ?? null,
        sourceId: 'local.stk_auction_cache',
      })
      if (!auction) localWarnings.push('AUCTION_NOT_MATCHED')
    }

    return {
      tsCode: holding.tsCode,
      stockName: holding.stockName,
      industry: stockBasics.get(holding.tsCode)?.industry?.trim() || null,
      concepts: holdingConcepts.get(holding.tsCode) ?? [],
      trend: {
        status: trend?.status ?? 'missing',
        tradeDate: trend?.data.tradeDate ?? null,
        bars: trend?.data.bars ?? 0,
        totalScore: trend?.data.totalScore ?? null,
        validWeight: trend?.data.validWeight ?? 0,
        trendState: trend?.data.trendState ?? 'insufficient',
        stockReturn20d: trend?.data.facts?.stockReturn20d ?? null,
        excessReturn20d: trend?.data.facts?.excessReturn20d ?? null,
        maxDrawdown20d: trend?.data.facts?.maxDrawdown20d ?? null,
      },
      chip: {
        status: chipStatus,
        tradeDate: chip?.tradeDate ?? null,
        winnerRate: finite(chip?.winnerRate),
        trappedPct: finite(chip?.trappedPct),
        concentration: finite(chip?.concentration),
        costDeviationPct: finite(chip?.costDeviationPct),
        loosening1d: finite(chip?.loosening1d),
        missingReasons: chip?.missingReasons.map(String).slice(0, 12) ?? ['CHIP_FACT_MISSING'],
      },
      announcements: announcementItems.map((item) => ({
        title: item.title,
        noticeDate: item.noticeDate,
        attentionTags: item.attentionTags.map(String).slice(0, 8),
        displayAt: item.displayAt,
        collectedAt: item.fetchedAt,
      })),
      briefings: briefingItems.map((item) => ({
        title: item.title,
        sourceName: item.sourceName,
        publishedDate: item.publishedDateBJ.replace(/-/g, ''),
        impactRating: item.impactRating,
        publicationTimeStatus: item.publicationTimeStatus,
        collectedAt: item.collectedAt,
      })),
      auction: auction ? {
        tradeDate: auction.tradeDate,
        price: finite(auction.price),
        previousClose: finite(auction.preClose),
        gapPercent: percentChange(finite(auction.price), finite(auction.preClose)),
        amount: finite(auction.amount),
        turnoverRate: finite(auction.turnoverRate),
        volumeRatio: finite(auction.volumeRatio),
        fetchedAt: auction.fetchedAt,
        factAt: getPremarketAuctionEvidenceDeadlineAt(input.tradeDate) - 5 * 60 * 1000,
      } : null,
      referenceIds,
      warnings: localWarnings,
    }
  })

  for (const holding of holdingEvidence) {
    for (const warning of holding.warnings) appendWarning(warnings, `${holding.tsCode}:${warning}`)
  }
  const auctionMatchedCount = holdingEvidence.filter((item) => item.auction !== null).length
  if (input.stage === 'auction_confirmed' && auctionMatchedCount === 0) {
    appendWarning(warnings, 'PORTFOLIO_AUCTION_NOT_MATCHED')
  }

  return {
    schemaVersion: 1,
    tradeDate: input.tradeDate,
    stage: input.stage,
    cutoffAt,
    previousTradeDate,
    holdingsCapturedAt: generatedAt,
    portfolioSnapshotKind: 'current-only',
    market: {
      baseFactSnapshotId: baseSnapshot?.id ?? null,
      snapshotStatus: baseSnapshot?.status ?? 'missing',
      snapshotRevision: baseSnapshot?.revision,
      snapshotRevisionKind: baseSnapshot?.revisionKind,
      snapshotCapturedAt: baseSnapshot?.capturedAt,
      providerId: baseSnapshot?.providerId,
      sourceStates: baseSnapshot?.sources.map((item) => ({
        sourceId: item.sourceId,
        status: item.status,
        observationCount: item.observationCount,
        expectedCount: item.expectedCount,
        errorCode: item.errorCode,
      })),
      externalRiskTone: baseSnapshot?.facts.externalRisk.tone ?? 'insufficient',
      confidence: baseSnapshot?.facts.externalRisk.confidence ?? 'low',
      eligibleAssetCount: baseSnapshot?.facts.externalRisk.eligibleAssetCount ?? 0,
      regionCount: baseSnapshot?.facts.externalRisk.regionCount ?? 0,
      medianChangePercent: baseSnapshot?.facts.externalRisk.medianChangePercent ?? null,
      observations: baseSnapshot?.facts.observations.map((item) => ({
        assetId: item.assetId,
        name: item.name,
        role: item.role,
        changePercent: item.changePercent,
        observedAt: item.observedAt,
      })) ?? [],
      briefings: marketBriefings.map((item) => ({
        title: item.title,
        sourceName: item.sourceName,
        publishedAt: item.publishedAt,
        publishedDate: item.publishedDateBJ.replace(/-/g, ''),
        impactRating: item.impactRating,
        publicationTimeStatus: item.publicationTimeStatus,
        collectedAt: item.collectedAt,
      })),
      referenceIds: marketReferenceIds,
    },
    sectors,
    holdings: holdingEvidence,
    auctionMatchedCount,
    references,
    warnings,
  }
}
