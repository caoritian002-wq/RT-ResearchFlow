import type Database from 'better-sqlite3'
import { getLimitListByDate } from '../database/limitListDailyRepository'
import { queryStockOHLCV } from '../database/dailyCloseCacheRepository'
import { emitDecisionSignals, type DecisionSignalInput } from './decisionSignalService'
import { getOrCreateMorningAuctionSnapshot } from './morningAuctionService'
import { refreshLimitBoardSnapshot } from './limitBoardMonitorService'
import { computeSectorFlowSnapshot } from './sectorFlowService'
import { getTrendAlerts, getTrendPortfolioSignalContext, trendDecisionPriority } from './trendWatchlistService'

interface BackfillStepResult {
  name: string
  ok: boolean
  count: number
  message?: string
}

export interface DecisionSignalBackfillResult {
  tradeDate: string
  steps: BackfillStepResult[]
}

let _inflight: Promise<DecisionSignalBackfillResult> | null = null
let _lastBackfillDate: string | null = null
let _lastBackfillAt = 0

const BACKFILL_TTL_MS = 5 * 60_000

export async function ensureTodayDecisionSignalsBackfilled(
  db: Database.Database,
  forceRefresh = false
): Promise<DecisionSignalBackfillResult> {
  const tradeDate = getBjTodayYmd()
  const now = Date.now()
  if (!forceRefresh && _lastBackfillDate === tradeDate && now - _lastBackfillAt < BACKFILL_TTL_MS) {
    return { tradeDate, steps: [] }
  }
  if (_inflight) return _inflight

  _inflight = runBackfill(db, tradeDate).finally(() => {
    _inflight = null
  })
  return _inflight
}

async function runBackfill(db: Database.Database, tradeDate: string): Promise<DecisionSignalBackfillResult> {
  const steps: BackfillStepResult[] = []

  steps.push(await runStep('news', () => backfillNewsSignals(db, tradeDate)))
  steps.push(await runStep('trend', () => backfillTrendAlertSignals(db, tradeDate)))
  steps.push(await runStep('morningAuction', async () => {
    await getOrCreateMorningAuctionSnapshot(tradeDate)
    return 0
  }))
  steps.push(await runStep('limitBoard', async () => {
    const hasTodayLimitRows = getLimitListByDate(db, tradeDate).length > 0
    if (!isInTradingHoursBj() && !hasTodayLimitRows) return 0
    await refreshLimitBoardSnapshot(tradeDate)
    return 0
  }))
  steps.push(await runStep('sectorFlow', async () => {
    await computeSectorFlowSnapshot(db, true)
    return 0
  }))

  _lastBackfillDate = tradeDate
  _lastBackfillAt = Date.now()
  return { tradeDate, steps }
}

async function runStep(name: string, fn: () => number | Promise<number>): Promise<BackfillStepResult> {
  try {
    const count = await fn()
    return { name, ok: true, count }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[decisionBackfill] ${name} failed:`, err)
    return { name, ok: false, count: 0, message }
  }
}

function backfillNewsSignals(db: Database.Database, tradeDate: string): number {
  const publishedDateBJ = `${tradeDate.slice(0, 4)}-${tradeDate.slice(4, 6)}-${tradeDate.slice(6, 8)}`
  const rows = db.prepare(`
    SELECT id, title, originalUrl, impactRating, impactRatingScore, publishedAt, summary, scanRunId
    FROM briefings
    WHERE publishedDateBJ = ?
      AND (impactRating = 'CRITICAL' OR impactRatingScore >= 30)
    ORDER BY impactRatingScore DESC, publishedAt DESC
    LIMIT 10
  `).all(publishedDateBJ) as Array<{
    id: number
    title: string
    originalUrl: string | null
    impactRating: string
    impactRatingScore: number
    publishedAt: number | null
    summary: string | null
    scanRunId: number | null
  }>

  const signals: DecisionSignalInput[] = rows.map((row) => ({
    sourceModule: 'news',
    strategyKey: 'news.critical',
    signalType: 'INFO',
    direction: 'NEUTRAL',
    priority: row.impactRating === 'CRITICAL' ? 4 : 3,
    score: row.impactRatingScore,
    confidence: 70,
    title: row.title,
    summary: row.summary ?? row.title,
    reason: { impactRating: row.impactRating, impactRatingScore: row.impactRatingScore },
    sourceRef: { briefingId: row.id, originalUrl: row.originalUrl, scanRunId: row.scanRunId },
    signalTime: row.publishedAt ?? Date.now(),
    dedupKey: `news:critical:${row.id}`,
  }))
  emitDecisionSignals(db, signals)
  return signals.length
}

function backfillTrendAlertSignals(db: Database.Database, tradeDate: string): number {
  const alerts = getTrendAlerts(db, 7).filter((alert) => alert.alertDate === tradeDate)
  const signals = alerts.map((alert): DecisionSignalInput | null => {
    const portfolioContext = getTrendPortfolioSignalContext(db, alert.tsCode, alert.price)
    const priceText = alert.price != null ? alert.price.toFixed(2) : '--'
    const refText = alert.refPrice != null ? alert.refPrice.toFixed(2) : '--'
    if (alert.alertType === 'BREAK_MA60') {
      return {
        sourceModule: 'trend',
        strategyKey: 'trend.breakMa60',
        tsCode: alert.tsCode,
        stockName: alert.stockName,
        signalType: 'RISK',
        direction: 'BEARISH',
        priority: trendDecisionPriority(4, portfolioContext.isPortfolio, 'RISK'),
        score: computeTrendAlertScore(alert.price, alert.refPrice),
        confidence: 70,
        title: `${alert.stockName} 跌破 MA60`,
        summary: `触发价 ${priceText} 跌破 MA60 ${refText}, 需要复核趋势是否走弱。`,
        reason: { triggerPrice: alert.price, ma60: alert.refPrice, ...portfolioContext },
        sourceRef: { trendAlertId: alert.id, alertType: alert.alertType, ...portfolioContext },
        signalTime: alert.createdAt,
        dedupKey: `trend:breakMa60:${alert.alertDate}:${alert.tsCode}`,
      }
    }
    if (alert.alertType === 'BREAK_HIGH20') {
      return {
        sourceModule: 'trend',
        strategyKey: 'trend.breakHigh20',
        tsCode: alert.tsCode,
        stockName: alert.stockName,
        signalType: 'OPPORTUNITY',
        direction: 'BULLISH',
        priority: trendDecisionPriority(4, portfolioContext.isPortfolio, 'OPPORTUNITY'),
        score: computeTrendAlertScore(alert.price, alert.refPrice),
        confidence: 72,
        title: `${alert.stockName} 突破 20 日高点`,
        summary: `触发价 ${priceText} 突破近 20 日高点 ${refText}, 可关注趋势延续。`,
        reason: { triggerPrice: alert.price, recent20High: alert.refPrice, ...portfolioContext },
        sourceRef: { trendAlertId: alert.id, alertType: alert.alertType, ...portfolioContext },
        signalTime: alert.createdAt,
        dedupKey: `trend:breakHigh20:${alert.alertDate}:${alert.tsCode}`,
      }
    }
    if (alert.alertType === 'STOP_LOSS_5PCT') {
      const close = getDailyClose(db, alert.tsCode, alert.alertDate)
      const closeNote = close == null
        ? ''
        : close >= (alert.refPrice ?? Number.POSITIVE_INFINITY)
          ? ` 当日收盘 ${close.toFixed(2)}, 盘中触发后已收回至参考价上方。`
          : ` 当日收盘 ${close.toFixed(2)}, 仍低于参考价。`
      return {
        sourceModule: 'trend',
        strategyKey: 'trend.stopLoss5Pct',
        tsCode: alert.tsCode,
        stockName: alert.stockName,
        signalType: 'RISK',
        direction: 'BEARISH',
        priority: trendDecisionPriority(5, portfolioContext.isPortfolio, 'RISK'),
        score: computeTrendAlertScore(alert.price, alert.refPrice),
        confidence: 80,
        title: `${alert.stockName} 单日跌幅触发止损线`,
        summary: `触发价 ${priceText}, 参考价 ${refText}, 已触发止损预警。${closeNote}`,
        reason: { triggerPrice: alert.price, refPrice: alert.refPrice, close, ...portfolioContext },
        sourceRef: { trendAlertId: alert.id, alertType: alert.alertType, ...portfolioContext },
        signalTime: alert.createdAt,
        dedupKey: `trend:stopLoss5Pct:${alert.alertDate}:${alert.tsCode}`,
      }
    }
    return null
  }).filter((signal): signal is DecisionSignalInput => signal != null)

  emitDecisionSignals(db, signals)
  return signals.length
}

function computeTrendAlertScore(price: number | null, refPrice: number | null): number | null {
  if (price == null || refPrice == null || refPrice === 0) return null
  return Math.min(100, Math.abs((price - refPrice) / refPrice) * 1000)
}

function isInTradingHoursBj(): boolean {
  const bj = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const day = bj.getUTCDay()
  if (day === 0 || day === 6) return false
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  return (minutes >= 9 * 60 + 30 && minutes <= 11 * 60 + 30) || (minutes >= 13 * 60 && minutes <= 15 * 60)
}

function getBjTodayYmd(): string {
  const bj = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return `${bj.getUTCFullYear()}${String(bj.getUTCMonth() + 1).padStart(2, '0')}${String(bj.getUTCDate()).padStart(2, '0')}`
}

function getDailyClose(db: Database.Database, tsCode: string, tradeDate: string): number | null {
  const rows = queryStockOHLCV(db, tsCode, tradeDate)
  const row = rows.find((item) => item.tradeDate === tradeDate)
  return row?.close ?? null
}
