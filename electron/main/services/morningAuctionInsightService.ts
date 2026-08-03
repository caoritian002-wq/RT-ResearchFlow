import type Database from 'better-sqlite3'
import type { MorningAuctionSnapshot, MorningAuctionStock } from './morningAuctionService'
import type {
  BacktestDetailRow,
  ChipStructureSummary,
  MorningAuctionInsightRow,
  MorningAuctionThemeAttribution,
  MorningAuctionVerificationItem,
  StockMinuteCacheRow
} from '../database/types'
import { getStockMinuteByDate } from '../database/stockMinuteCacheRepository'
import { queryDetails } from '../database/backtestDetailRepository'
import { buildCompatibleChipStructureSummaries } from './chipSummaryService'
import {
  filterMorningAuctionInsightsBySchema,
  getMorningAuctionInsight,
  listMorningAuctionInsightsByDate,
  upsertMorningAuctionInsight,
  updateMorningAuctionVerificationItem
} from '../database/morningAuctionInsightRepository'

export interface MorningAuctionScoreBreakdownItem {
  key: string
  label: string
  value: number | null
  weight: number
  contribution: number
  reason: string
}

export interface MorningAuctionRiskFlag {
  key: string
  label: string
  severity: 'low' | 'medium' | 'high'
  reason: string
}

export interface MorningAuctionIntradayPreview {
  latestTime: string | null
  maxPctChg: number | null
  maxDrawdownFromOpen: number | null
  amountChangePct: number | null
  touchedLimitUp: boolean | null
  priceVsAuctionPct: number | null
}

export interface MorningAuctionBacktestSummary {
  sampleSize: number
  winRate: number | null
  avgReturn: number | null
  maxDrawdown: null
}

export interface MorningAuctionInsight {
  tradeDate: string
  tsCode: string
  stockName: string
  poolKey: string
  schemaVersion: number
  score: number
  scoreBreakdown: MorningAuctionScoreBreakdownItem[]
  entryReasons: string[]
  verificationItems: MorningAuctionVerificationItem[]
  riskFlags: MorningAuctionRiskFlag[]
  intradayPreview: MorningAuctionIntradayPreview | null
  backtestSummary: MorningAuctionBacktestSummary | null
  chipEvidence: ChipStructureSummary | null
  themeAttribution: MorningAuctionThemeAttribution | null
  chipStatus: 'available' | 'missing' | 'insufficient'
  status: 'completed' | 'partial' | 'failed'
  errorMessage: string | null
  generatedAt: number
  updatedAt: number
}

export interface GenerateMorningAuctionInsightsResult {
  tradeDate: string
  generatedCount: number
  failedCount: number
  expectedCount: number
  insights: MorningAuctionInsight[]
}

interface PoolCandidate {
  stock: MorningAuctionStock
  poolKey: string
  poolLabel: string
  entryReason: string
  backtestPool: BacktestDetailRow['pool'] | null
}

export const MORNING_AUCTION_INSIGHT_SCHEMA_VERSION = 2

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase().replace(/\.(SH|SZ|BJ)$/i, '').slice(0, 6)
}

function safeJson<T>(json: string | null, fallback: T): T {
  if (!json) return fallback
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

function dateBefore(tradeDate: string, days: number): string {
  const year = Number(tradeDate.slice(0, 4))
  const month = Number(tradeDate.slice(4, 6)) - 1
  const day = Number(tradeDate.slice(6, 8))
  const date = new Date(Date.UTC(year, month, day - days))
  return date.toISOString().slice(0, 10).replace(/-/g, '')
}

function collectPoolCandidates(snapshot: MorningAuctionSnapshot): PoolCandidate[] {
  const result: PoolCandidate[] = []
  const push = (
    rows: MorningAuctionStock[],
    poolKey: string,
    poolLabel: string,
    entryReason: string,
    backtestPool: BacktestDetailRow['pool'] | null = null
  ): void => {
    for (const stock of rows) result.push({ stock, poolKey, poolLabel, entryReason, backtestPool })
  }

  push(snapshot.threeOne.brokenBoard, 'brokenBoard', '炸板修复', '昨日炸板后竞价资金回补, 需验证修复承接。', 'brokenBoard')
  push(snapshot.threeOne.firstBoard, 'firstBoard', '首板续强', '昨日首板后竞价继续靠前, 观察题材扩散。', 'firstBoard')
  push(snapshot.threeOne.secondBoard, 'secondBoard', '连板晋级', '连板股竞价继续强势, 需验证分歧承接。', 'secondBoard')
  push(snapshot.threeOne.brokenConsec, 'brokenConsec', '断板回流', '断板后竞价重新活跃, 需区分回流与反抽。', 'brokenConsec')
  push(snapshot.threeOne.allMarket, 'allMarket', '全市场异动', '竞价金额和换手同时放大, 进入扩展观察池。', 'allMarket')
  push(snapshot.weakToStrong.badBoard, 'badBoard', '烂板转强', '昨日分歧后竞价转强, 观察主动修复。')
  push(snapshot.weakToStrong.tailAttack, 'tailAttack', '尾盘偷袭', '尾盘封板后竞价延续, 需排查一日游。')
  push(snapshot.weakToStrong.brokenBoard, 'weakBrokenBoard', '断板转强', '断板后重新获得竞价资金关注。')
  push(snapshot.weakToStrong.afternoonReseal, 'afternoonReseal', '午后回封', '午后回封后竞价延续, 观察板块共振。')
  push(snapshot.weakToStrong.reversal, 'reversal', '反包转强', '反包形态波动较大, 需优先验证风险。')
  push(snapshot.boardCategory.first, 'boardFirst', '首板板态', '首板池用于观察题材发酵与弹性。')
  push(snapshot.boardCategory.second, 'boardSecond', '二板板态', '二板池代表接力梯队, 需核对封单与分歧。')
  push(snapshot.boardCategory.third, 'boardThird', '三板板态', '三板股进入高度竞争, 需观察分歧承接。')
  push(snapshot.boardCategory.n, 'boardN', '高标板态', '高标股情绪代表性强, 同时回撤风险更高。')
  return result
}

function findChipSummary(
  chipByCode: Map<string, ChipStructureSummary>,
  tsCode: string
): ChipStructureSummary | null {
  return chipByCode.get(normalizeCode(tsCode)) ?? null
}

function hasChipEvidence(chip: ChipStructureSummary | null): boolean {
  if (!chip) return false
  return chip.winnerRate != null || chip.thickProfitPct != null || chip.thinProfitPct != null ||
    chip.trappedPct != null || chip.deepLowPct != null || chip.concentration != null ||
    chip.costDeviationPct != null || chip.bottomPct != null || chip.loosening1d != null ||
    chip.loosening3d != null || chip.loosening5d != null
}

function getChipStatus(chip: ChipStructureSummary | null): MorningAuctionInsight['chipStatus'] {
  if (!chip?.tradeDate) return 'missing'
  return chip.dateRelation === 'same_day' && hasChipEvidence(chip) ? 'available' : 'insufficient'
}

function buildIntradayPreview(
  stock: MorningAuctionStock,
  rows: StockMinuteCacheRow[]
): MorningAuctionIntradayPreview | null {
  const validRows = rows.filter((row) => row.close != null)
  if (validRows.length === 0) return null
  const firstOpen = validRows.find((row) => row.open != null)?.open ?? stock.auctionPrice
  const latest = validRows[validRows.length - 1]
  const highs = validRows.map((row) => row.high ?? row.close as number)
  const lows = validRows.map((row) => row.low ?? row.close as number)
  const amountWan = validRows.reduce((sum, row) => sum + (row.amount ?? 0) * 0.1, 0)
  const limitPct = /ST/i.test(stock.stockName) ? 5 : stock.stockCode.startsWith('30') || stock.stockCode.startsWith('68') ? 20 : stock.stockCode.startsWith('8') || stock.stockCode.startsWith('4') ? 30 : 10
  return {
    latestTime: latest.tsMinute,
    maxPctChg: stock.prevClose > 0 ? round((Math.max(...highs) - stock.prevClose) / stock.prevClose * 100) : null,
    maxDrawdownFromOpen: firstOpen > 0 ? round((Math.min(...lows) - firstOpen) / firstOpen * 100) : null,
    amountChangePct: stock.auctionAmount > 0 ? round((amountWan - stock.auctionAmount) / stock.auctionAmount * 100) : null,
    touchedLimitUp: stock.prevClose > 0 ? Math.max(...highs) >= stock.prevClose * (1 + (limitPct - 0.3) / 100) : null,
    priceVsAuctionPct: stock.auctionPrice > 0 && latest.close != null ? round((latest.close - stock.auctionPrice) / stock.auctionPrice * 100) : null
  }
}

function buildBacktestSummary(
  tsCode: string,
  pool: BacktestDetailRow['pool'] | null,
  rows: BacktestDetailRow[]
): MorningAuctionBacktestSummary | null {
  if (!pool) return null
  const samples = rows.filter((row) => normalizeCode(row.tsCode) === normalizeCode(tsCode) && row.pool === pool && row.ret1d != null)
  if (samples.length === 0) return null
  const returns = samples.map((row) => row.ret1d as number)
  return {
    sampleSize: returns.length,
    winRate: round(returns.filter((value) => value > 0).length / returns.length * 100),
    avgReturn: round(returns.reduce((sum, value) => sum + value, 0) / returns.length),
    maxDrawdown: null
  }
}

function buildRiskFlags(
  stock: MorningAuctionStock,
  chip: ChipStructureSummary | null,
  chipStatus: MorningAuctionInsight['chipStatus']
): MorningAuctionRiskFlag[] {
  const flags: MorningAuctionRiskFlag[] = []
  if (/ST/i.test(stock.stockName)) flags.push({ key: 'st', label: 'ST 风险', severity: 'high', reason: '涨跌停规则和流动性与普通股票不同。' })
  if (stock.pctChg >= 9.5 && stock.auctionTurnover < 0.2) flags.push({ key: 'oneWord', label: '一字流动性', severity: 'high', reason: '竞价接近涨停但换手偏低, 可成交性需要单独验证。' })
  if (stock.pctChg5d != null && stock.pctChg5d > 25) flags.push({ key: 'extended', label: '短期涨幅偏高', severity: 'medium', reason: `近 5 日累计涨幅 ${round(stock.pctChg5d)}%。` })
  if (chipStatus === 'available' && chip?.loosening1d != null && chip.loosening1d > 12) flags.push({ key: 'chipLoose', label: '筹码松动', severity: 'medium', reason: `1 日筹码松动 ${round(chip.loosening1d)}%。` })
  if (stock.currentPctChg != null && stock.currentPctChg < stock.pctChg - 3) flags.push({ key: 'acceptanceWeak', label: '盘中承接转弱', severity: 'medium', reason: '当前涨幅较竞价涨幅回落超过 3 个百分点。' })
  return flags
}

function buildVerificationItems(
  stock: MorningAuctionStock,
  chip: ChipStructureSummary | null,
  chipStatus: MorningAuctionInsight['chipStatus'],
  intradayPreview: MorningAuctionIntradayPreview | null,
  backtestSummary: MorningAuctionBacktestSummary | null,
  now: number
): MorningAuctionVerificationItem[] {
  const themeAttribution = stock.themeAttribution ?? null
  const hasThemeEvidence = Boolean(themeAttribution?.primary || themeAttribution?.directReason)
  const themeReason = themeAttribution?.primary
    ? themeAttribution.summary
    : stock.conceptNames.length > 0
      ? '已有静态关联题材，但当前没有足够直接原因或竞价共振确认主驱动。'
      : '题材归因尚未补齐。'
  return [
    {
      key: 'intradayAcceptance',
      label: '盘中承接',
      status: intradayPreview ? 'pending' : 'blocked',
      source: 'stock_minute_cache',
      reason: intradayPreview ? '分钟缓存已就绪, 待人工确认承接质量。' : '本地分钟缓存不足。',
      updatedAt: now
    },
    {
      key: 'conceptResonance',
      label: '题材共振',
      status: hasThemeEvidence ? 'pending' : 'blocked',
      source: 'kpl_concept_daily+concept_members+stk_auction',
      reason: themeReason,
      updatedAt: now,
      themeAttribution: themeAttribution ?? undefined,
    },
    {
      key: 'chipConsistency',
      label: '筹码一致性',
      status: chipStatus === 'available' ? 'pending' : 'blocked',
      source: 'chip_structure_summary',
      reason: chipStatus === 'available'
        ? `竞价日 ${stock.tsCode} 的同日筹码摘要已就绪, 待核对与竞价方向是否一致。`
        : chip?.dateRelation === 'history'
          ? `仅有 ${chip.tradeDate} 历史筹码证据, 不作为当前竞价日确认项。`
          : chipStatus === 'missing'
            ? '尚无本地筹码结构事实。'
            : '当前竞价日筹码证据不完整。',
      updatedAt: now,
      chipEvidence: chip ?? undefined
    },
    {
      key: 'priceHistory',
      label: '短期涨跌',
      status: stock.pctChg3d != null && stock.pctChg5d != null ? 'pending' : 'blocked',
      source: 'daily_close_cache',
      reason: stock.pctChg3d != null && stock.pctChg5d != null ? '3 日和 5 日涨跌已就绪。' : '3 日或 5 日涨跌仍缺失。',
      updatedAt: now
    },
    {
      key: 'historicalPerformance',
      label: '历史表现',
      status: backtestSummary ? 'pending' : 'blocked',
      source: 'stk_auction_backtest_detail',
      reason: backtestSummary ? `本地同股同池样本 ${backtestSummary.sampleSize} 条。` : '暂无同股同池本地回测样本。',
      updatedAt: now
    }
  ]
}

export function buildMorningAuctionInsight(
  tradeDate: string,
  candidate: PoolCandidate,
  chip: ChipStructureSummary | null,
  minuteRows: StockMinuteCacheRow[],
  backtestRows: BacktestDetailRow[],
  generatedAt = Date.now()
): Omit<MorningAuctionInsight, 'updatedAt'> {
  const { stock } = candidate
  const chipStatus = getChipStatus(chip)
  const intradayPreview = buildIntradayPreview(stock, minuteRows)
  const backtestSummary = buildBacktestSummary(stock.tsCode, candidate.backtestPool, backtestRows)
  const riskFlags = buildRiskFlags(stock, chip, chipStatus)
  const amountContribution = round(clamp(stock.auctionAmount / 1000 * 20, 0, 20))
  const turnoverContribution = round(clamp(stock.auctionTurnover / 1 * 15, 0, 15))
  const pctContribution = round(clamp(stock.pctChg / 10 * 15, 0, 15))
  const themeAttribution = stock.themeAttribution ?? null
  const conceptContribution = themeAttribution?.state === 'direct'
    ? themeAttribution.confidence === 'high' ? 10 : 8
    : themeAttribution?.state === 'resonance'
      ? themeAttribution.confidence === 'medium' ? 7 : 5
      : stock.conceptNames.length > 0 ? 2 : 0
  const chipContribution = chipStatus === 'available' ? 10 : 0
  const historyContribution = backtestSummary?.avgReturn == null ? 0 : round(clamp(5 + backtestSummary.avgReturn, 0, 10))
  const currentContribution = stock.currentPctChg == null ? 0 : round(clamp(stock.currentPctChg / 10 * 5, 0, 5))
  const riskPenalty = round(clamp(riskFlags.reduce((sum, flag) => sum + (flag.severity === 'high' ? 8 : flag.severity === 'medium' ? 4 : 2), 0), 0, 20))
  const score = Math.round(clamp(15 + amountContribution + turnoverContribution + pctContribution + conceptContribution + chipContribution + historyContribution + currentContribution - riskPenalty, 0, 100))
  const scoreBreakdown: MorningAuctionScoreBreakdownItem[] = [
    { key: 'pool', label: '信号池', value: null, weight: 15, contribution: 15, reason: `${candidate.poolLabel}候选基础分。` },
    { key: 'auctionAmount', label: '竞价金额', value: stock.auctionAmount, weight: 20, contribution: amountContribution, reason: `竞价金额 ${round(stock.auctionAmount)} 万元。` },
    { key: 'auctionTurnover', label: '竞价换手', value: stock.auctionTurnover, weight: 15, contribution: turnoverContribution, reason: `竞价换手率 ${round(stock.auctionTurnover, 3)}%。` },
    { key: 'auctionPct', label: '竞价涨幅', value: stock.pctChg, weight: 15, contribution: pctContribution, reason: `竞价涨幅 ${round(stock.pctChg)}%。` },
    {
      key: 'concept',
      label: '题材证据',
      value: themeAttribution?.allThemes.length ?? stock.conceptNames.length,
      weight: 10,
      contribution: conceptContribution,
      reason: themeAttribution?.primary
        ? `${themeAttribution.summary} 题材分项 ${conceptContribution}/10。`
        : stock.conceptNames.length > 0
          ? `仅有 ${stock.conceptNames.length} 个静态关联题材，尚未确认主驱动。`
          : '题材未补齐。'
    },
    { key: 'chip', label: '筹码证据', value: chip?.winnerRate ?? chip?.bottomPct ?? null, weight: 10, contribution: chipContribution, reason: chipStatus === 'available' ? '本地同日筹码结构摘要可用。' : chip?.dateRelation === 'history' ? `仅有 ${chip.tradeDate} 历史筹码证据, 不计入当日评分。` : chipStatus === 'insufficient' ? '当前竞价日筹码证据不完整。' : '无本地筹码结构事实。' },
    { key: 'history', label: '历史表现', value: backtestSummary?.avgReturn ?? null, weight: 10, contribution: historyContribution, reason: backtestSummary ? `同股同池 T+1 平均收益 ${backtestSummary.avgReturn}%。` : '无同股同池回测样本。' },
    { key: 'current', label: '当前确认', value: stock.currentPctChg, weight: 5, contribution: currentContribution, reason: stock.currentPctChg == null ? '当前行情未就绪。' : `当前涨幅 ${round(stock.currentPctChg)}%。` },
    { key: 'risk', label: '风险扣分', value: riskFlags.length, weight: -20, contribution: -riskPenalty, reason: riskFlags.length > 0 ? `命中 ${riskFlags.length} 项风险。` : '未命中显式风险项。' }
  ]
  const verificationItems = buildVerificationItems(stock, chip, chipStatus, intradayPreview, backtestSummary, generatedAt)
  const status = verificationItems.some((item) => item.status === 'blocked') ? 'partial' : 'completed'
  return {
    tradeDate,
    tsCode: stock.tsCode,
    stockName: stock.stockName,
    poolKey: candidate.poolKey,
    schemaVersion: MORNING_AUCTION_INSIGHT_SCHEMA_VERSION,
    score,
    scoreBreakdown,
    entryReasons: [candidate.entryReason],
    verificationItems,
    riskFlags,
    intradayPreview,
    backtestSummary,
    chipEvidence: chip,
    themeAttribution,
    chipStatus,
    status,
    errorMessage: null,
    generatedAt
  }
}

function rowToInsight(row: MorningAuctionInsightRow): MorningAuctionInsight {
  const verificationItems = safeJson<MorningAuctionVerificationItem[]>(row.verificationItemsJson, [])
  const themeAttribution = verificationItems.find((item) => item.key === 'conceptResonance')?.themeAttribution ?? null
  return {
    tradeDate: row.tradeDate,
    tsCode: row.tsCode,
    stockName: row.stockName,
    poolKey: row.poolKey,
    schemaVersion: row.schemaVersion,
    score: row.score,
    scoreBreakdown: safeJson(row.scoreBreakdownJson, []),
    entryReasons: safeJson(row.entryReasonsJson, []),
    verificationItems,
    riskFlags: safeJson(row.riskFlagsJson, []),
    intradayPreview: safeJson(row.intradayPreviewJson, null),
    backtestSummary: safeJson(row.backtestSummaryJson, null),
    chipEvidence: verificationItems.find((item) => item.key === 'chipConsistency')?.chipEvidence ?? null,
    themeAttribution,
    chipStatus: row.chipStatus,
    status: row.status,
    errorMessage: row.errorMessage,
    generatedAt: row.generatedAt,
    updatedAt: row.updatedAt
  }
}

export function getMorningAuctionStructuredInsight(
  db: Database.Database,
  tradeDate: string,
  tsCode: string,
  poolKey: string
): MorningAuctionInsight | null {
  const row = getMorningAuctionInsight(db, tradeDate, tsCode, poolKey)
  return row?.schemaVersion === MORNING_AUCTION_INSIGHT_SCHEMA_VERSION ? rowToInsight(row) : null
}

export function listMorningAuctionStructuredInsights(
  db: Database.Database,
  tradeDate: string
): MorningAuctionInsight[] {
  return filterMorningAuctionInsightsBySchema(
    listMorningAuctionInsightsByDate(db, tradeDate),
    MORNING_AUCTION_INSIGHT_SCHEMA_VERSION
  )
    .map(rowToInsight)
}

export function generateMorningAuctionInsights(
  db: Database.Database,
  snapshot: MorningAuctionSnapshot,
  options: { tsCode?: string; poolKey?: string } = {}
): GenerateMorningAuctionInsightsResult {
  const snapshotCopy = structuredClone(snapshot)
  const candidates = collectPoolCandidates(snapshotCopy).filter((candidate) => {
    return (!options.tsCode || normalizeCode(candidate.stock.tsCode) === normalizeCode(options.tsCode)) &&
      (!options.poolKey || candidate.poolKey === options.poolKey)
  })
  const chipRequests = [...new Map(candidates.map((candidate) => [normalizeCode(candidate.stock.tsCode), {
    tsCode: candidate.stock.tsCode,
    stockName: candidate.stock.stockName,
  }])).values()]
  const chipByCode = new Map(buildCompatibleChipStructureSummaries(
    db,
    chipRequests,
    undefined,
    snapshotCopy.tradeDate,
  ).map((summary) => [normalizeCode(summary.tsCode), summary]))
  const backtestRows = queryDetails(db, { startDate: dateBefore(snapshotCopy.tradeDate, 180), endDate: snapshotCopy.tradeDate })
  let generatedCount = 0
  let failedCount = 0

  for (const candidate of candidates) {
    const generatedAt = Date.now()
    try {
      const minuteRows = getStockMinuteByDate(db, normalizeCode(candidate.stock.tsCode), snapshotCopy.tradeDate)
      const built = buildMorningAuctionInsight(
        snapshotCopy.tradeDate,
        candidate,
        findChipSummary(chipByCode, candidate.stock.tsCode),
        minuteRows,
        backtestRows,
        generatedAt
      )
      upsertMorningAuctionInsight(db, {
        tradeDate: snapshotCopy.tradeDate,
        tsCode: built.tsCode,
        stockName: built.stockName,
        poolKey: built.poolKey,
        schemaVersion: built.schemaVersion,
        score: built.score,
        scoreBreakdownJson: JSON.stringify(built.scoreBreakdown),
        entryReasonsJson: JSON.stringify(built.entryReasons),
        verificationItemsJson: JSON.stringify(built.verificationItems),
        riskFlagsJson: JSON.stringify(built.riskFlags),
        intradayPreviewJson: built.intradayPreview ? JSON.stringify(built.intradayPreview) : null,
        backtestSummaryJson: built.backtestSummary ? JSON.stringify(built.backtestSummary) : null,
        chipStatus: built.chipStatus,
        status: built.status,
        errorMessage: null,
        generatedAt
      })
      generatedCount += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      upsertMorningAuctionInsight(db, {
        tradeDate: snapshotCopy.tradeDate,
        tsCode: candidate.stock.tsCode,
        stockName: candidate.stock.stockName,
        poolKey: candidate.poolKey,
        schemaVersion: MORNING_AUCTION_INSIGHT_SCHEMA_VERSION,
        score: 0,
        scoreBreakdownJson: '[]',
        entryReasonsJson: JSON.stringify([candidate.entryReason]),
        verificationItemsJson: '[]',
        riskFlagsJson: '[]',
        intradayPreviewJson: null,
        backtestSummaryJson: null,
        chipStatus: 'missing',
        status: 'failed',
        errorMessage: message,
        generatedAt
      })
      failedCount += 1
    }
  }

  return {
    tradeDate: snapshotCopy.tradeDate,
    generatedCount,
    failedCount,
    expectedCount: candidates.length,
    insights: listMorningAuctionStructuredInsights(db, snapshotCopy.tradeDate).filter((insight) => {
      return (!options.tsCode || normalizeCode(insight.tsCode) === normalizeCode(options.tsCode)) &&
        (!options.poolKey || insight.poolKey === options.poolKey)
    })
  }
}

export function updateMorningAuctionVerification(
  db: Database.Database,
  input: Parameters<typeof updateMorningAuctionVerificationItem>[1]
): MorningAuctionInsight | null {
  const existing = getMorningAuctionInsight(db, input.tradeDate, input.tsCode, input.poolKey)
  if (existing?.schemaVersion !== MORNING_AUCTION_INSIGHT_SCHEMA_VERSION) return null
  const row = updateMorningAuctionVerificationItem(db, input)
  return row ? rowToInsight(row) : null
}

export function countMorningAuctionCandidates(snapshot: MorningAuctionSnapshot): number {
  return collectPoolCandidates(snapshot).length
}
