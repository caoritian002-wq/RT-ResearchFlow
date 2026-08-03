/**
 * FR-164: 长线趋势 Watchlist 服务
 *
 * 职责：
 * 1. 七维评分算法（MA排列 + MA60位置 + HS300超额 + 回撤 + 换手比 + MACD零轴 + 布林带）
 * 2. 盘中实时评分（_realtimeScoreCache，不写 DB）
 * 3. EOD 评分存档（写 trend_scores）
 * 4. 预警检测（破支撑/突破压力/止损，写 trend_alerts）
 */

import type Database from 'better-sqlite3'
import { BrowserWindow } from 'electron'
import { getRtKCache, getRtKCachedAt } from './sharedRtKCache'
import { getAllTrendWatchStocks } from '../database/trendWatchlistRepository'
import { listPortfolioStocks } from '../database/portfolioRepository'
import {
  upsertTrendScores,
  getLatestTrendScores,
  cleanupTrendScores,
} from '../database/trendScoresRepository'
import {
  insertTrendAlert,
  hasAlertToday,
  getRecentTrendAlerts,
  cleanupTrendAlerts,
} from '../database/trendAlertsRepository'
import { emitDecisionSignal } from './decisionSignalService'
import { queryStockOHLCV } from '../database/dailyCloseCacheRepository'
import { getCachedPrices } from '../database/stockPriceCacheRepository'
import type { TrendScoreRow } from '../database/types'
import type { DailyRow } from './tushareService'
import { buildLatestChipSummaryMap, type ChipSummary } from './chipSummaryService'
import {
  computeTrendScoreV2,
  computeWindowReturn,
  type TrendOhlcvBar,
  type TrendScoreComputation,
} from './trendScoreModel'

// ──────────────────────────────────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────────────────────────────────

export interface TrendScoreDetail {
  tsCode: string
  stockName: string
  groupTag: string
  /** 一级大类，如 "AI算力" */
  category: string
  /** 细分赛道，如 "光模块" */
  subCategory: string
  /** 自定义备注 */
  notes: string
  /** 是否为用户持仓 */
  isPortfolio: boolean
  /** 用户手填持仓成本价 */
  costPrice: number | null
  /** 基于现价和成本价计算的浮盈亏百分比 */
  profitPct: number | null
  /** 持仓处置建议：仅为本地规则辅助判断，不代表交易指令 */
  positionAdvice: 'HOLD' | 'WATCH' | 'TAKE_PROFIT' | 'STOP_LOSS' | null
  /** 持仓处置建议原因 */
  positionAdviceReason: string | null
  /** 最新筹码监控摘要 */
  chip: ChipSummary | null
  /** 七维评分 0-100 */
  totalScore: number | null
  maScore: number | null
  maAbove60: boolean | null
  alphaScore: number | null
  drawdown: number | null
  turnoverRatio: number | null
  macdAboveZero: boolean | null
  bollAboveMid: boolean | null
  /** 最新价（盘中实时 / EOD 收盘） */
  price: number | null
  /** 涨跌幅（%） */
  change: number | null
  /** 数据来源：realtime=盘中实时评分，eod=最近存档 */
  dataSource: 'realtime' | 'eod'
  /** 数据时间（YYYYMMDD 或 HH:mm） */
  dataTime: string
  scoreSource: 'realtime' | 'eod'
  scoreDate: string
  quoteSource: 'realtime' | 'eod'
  quoteTime: string
  scoreVersion: 'v2' | 'legacy'
  validWeight: number | null
}

export interface TrendAlertItem {
  id: number | undefined
  tsCode: string
  stockName: string
  alertType: string
  alertDate: string
  price: number | null
  refPrice: number | null
  createdAt: number
}

// ──────────────────────────────────────────────────────────────────────────
// 模块状态
// ──────────────────────────────────────────────────────────────────────────

/** 盘中实时评分缓存（内存，不写 DB），key=tsCode */
const _realtimeScoreCache = new Map<
  string,
  {
    score: TrendScoreRow
    updatedAt: number
    price?: number | null
    change?: number | null
    source: 'realtime' | 'eod'
    computation: TrendScoreComputation
  }
>()

/** EOD 批量计算锁，防重入 */
let _eodRunning = false

interface TrendSubject {
  tsCode: string
  stockName: string
  groupTag: string
  category: string
  subCategory: string
  notes: string
  isPortfolio: boolean
  costPrice: number | null
}

const PORTFOLIO_CATEGORY = '我的持仓'

function normalizeTsCode(tsCode: string): string {
  const clean = tsCode.trim().toUpperCase()
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(clean)) return clean
  const code = clean.replace(/\.(SH|SZ|BJ)$/i, '')
  if (/^(600|601|603|605|688|900|110|113|118|127|128|129|131|132)/.test(code)) return `${code}.SH`
  if (/^(430|830|870|871|872|873|874|875|876|877|878|879|880|881|882|883|884|885|886|887|888|889|890|891|892|893|894|895|896|897|898|899)/.test(code)) return `${code}.BJ`
  return `${code}.SZ`
}

function getTrendSubjects(db: Database.Database): TrendSubject[] {
  const portfolioRows = listPortfolioStocks(db)
  const portfolioMap = new Map(portfolioRows.map((row) => [normalizeTsCode(row.tsCode), row]))
  const watchlist = getAllTrendWatchStocks(db)
  const subjects: TrendSubject[] = watchlist.map((stock) => {
    const tsCode = normalizeTsCode(stock.tsCode)
    return {
      tsCode,
      stockName: stock.stockName,
      groupTag: stock.groupTag,
      category: stock.category,
      subCategory: stock.subCategory,
      notes: stock.notes,
      isPortfolio: portfolioMap.has(tsCode),
      costPrice: portfolioMap.get(tsCode)?.costPrice ?? null,
    }
  })
  const seen = new Set(subjects.map((stock) => stock.tsCode))
  for (const row of portfolioRows) {
    const tsCode = normalizeTsCode(row.tsCode)
    if (seen.has(tsCode)) continue
    subjects.push({
      tsCode,
      stockName: row.stockName || tsCode,
      groupTag: '',
      category: PORTFOLIO_CATEGORY,
      subCategory: '',
      notes: '',
      isPortfolio: true,
      costPrice: row.costPrice ?? null,
    })
    seen.add(tsCode)
  }
  return subjects
}

function portfolioPriority(basePriority: number, isPortfolio: boolean, signalType: 'RISK' | 'OPPORTUNITY'): number {
  if (!isPortfolio || signalType !== 'RISK') return basePriority
  return Math.min(5, basePriority + 1)
}

export function trendDecisionPriority(basePriority: number, isPortfolio: boolean, signalType: 'RISK' | 'OPPORTUNITY'): number {
  if (!isPortfolio) return 3
  return portfolioPriority(basePriority, isPortfolio, signalType)
}

function buildPositionAdvice(input: {
  costPrice: number | null
  price: number | null
  totalScore: number | null
  maAbove60: boolean | null
  drawdown: number | null
  change: number | null
}): {
  profitPct: number | null
  positionAdvice: TrendScoreDetail['positionAdvice']
  positionAdviceReason: string | null
} {
  const { costPrice, price, totalScore, maAbove60, drawdown, change } = input
  if (costPrice == null || costPrice <= 0 || price == null) {
    return { profitPct: null, positionAdvice: null, positionAdviceReason: null }
  }

  const profitPct = ((price - costPrice) / costPrice) * 100
  const reasons: string[] = [`浮盈亏 ${profitPct >= 0 ? '+' : ''}${profitPct.toFixed(1)}%`]
  if (totalScore != null) reasons.push(`趋势评分 ${totalScore}`)
  if (maAbove60 === false) reasons.push('跌破 MA60')
  if (maAbove60 === true) reasons.push('站上 MA60')
  if (drawdown != null) reasons.push(`20日回撤 ${drawdown.toFixed(1)}%`)

  if ((profitPct <= -8 && (totalScore ?? 0) < 45) || (profitPct <= -5 && maAbove60 === false) || (change != null && change <= -5 && maAbove60 === false)) {
    return { profitPct, positionAdvice: 'STOP_LOSS', positionAdviceReason: reasons.join(', ') }
  }

  if ((profitPct >= 30 && drawdown != null && drawdown >= 8) || (profitPct >= 20 && (totalScore ?? 100) < 55) || (profitPct >= 15 && maAbove60 === false)) {
    return { profitPct, positionAdvice: 'TAKE_PROFIT', positionAdviceReason: reasons.join(', ') }
  }

  if ((totalScore ?? 0) >= 60 && maAbove60 !== false) {
    return { profitPct, positionAdvice: 'HOLD', positionAdviceReason: reasons.join(', ') }
  }

  return { profitPct, positionAdvice: 'WATCH', positionAdviceReason: reasons.join(', ') }
}

export function getTrendPortfolioSignalContext(
  db: Database.Database,
  tsCode: string,
  fallbackPrice: number | null = null,
): {
  isPortfolio: boolean
  costPrice: number | null
  profitPct: number | null
  positionAdvice: TrendScoreDetail['positionAdvice']
  positionAdviceReason: string | null
} {
  const normalized = normalizeTsCode(tsCode)
  const portfolioRows = listPortfolioStocks(db)
  const portfolio = portfolioRows.find((row) => normalizeTsCode(row.tsCode) === normalized)
  if (!portfolio) {
    return {
      isPortfolio: false,
      costPrice: null,
      profitPct: null,
      positionAdvice: null,
      positionAdviceReason: null,
    }
  }

  const latestScore = getLatestTrendScores(db, [normalized]).get(normalized)
  const latestPrice = fallbackPrice ?? getLatestPriceSnapshot(db, normalized).price
  const position = buildPositionAdvice({
    costPrice: portfolio.costPrice ?? null,
    price: latestPrice,
    totalScore: latestScore?.totalScore ?? null,
    maAbove60: latestScore?.maAbove60 != null ? latestScore.maAbove60 === 1 : null,
    drawdown: latestScore?.drawdown ?? null,
    change: null,
  })

  return {
    isPortfolio: true,
    costPrice: portfolio.costPrice ?? null,
    profitPct: position.profitPct,
    positionAdvice: position.positionAdvice,
    positionAdviceReason: position.positionAdviceReason,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 七维评分算法
// ──────────────────────────────────────────────────────────────────────────

interface HistoricalScoreInput {
  bars: TrendOhlcvBar[]
  tradeDate: string
  price: number
  change: number | null
  dailyRows: number
  priceRows: number
  filteredPriceRows: number
  earliestPriceDate: string | null
  latestPriceDate: string | null
}

interface PriceSnapshot {
  price: number | null
  change: number | null
}

/**
 * 计算单只股票的七维评分（纯函数，输入历史 OHLCV，HS300基准涨幅，实时价）
 * @param bars 按日期升序排列的历史 K 线（至少 60 条）
 * @param hs300Change HS300 基准涨跌幅（%），用于计算 alpha
 * @param realtimePrice 盘中实时价（null=使用最后一根 bar close）
 */
export function computeTrendScore(
  bars: TrendOhlcvBar[],
  benchmarkReturn20d: number | null,
  realtimePrice: number | null = null
): TrendScoreRow {
  return computeTrendScoreV2(bars, benchmarkReturn20d, realtimePrice).score
}

// ──────────────────────────────────────────────────────────────────────────
// 盘中实时评分（写内存缓存，推送事件）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 从 sharedRtKCache 取实时行情，重新计算趋势池所有股票评分，结果写 _realtimeScoreCache。
 * 由 schedulerService 60s 回调触发（仅交易时段执行）。
 * @param win BrowserWindow 实例，用于推送 trend:scoresUpdated 事件
 */
export function recomputeTrendScoresRealtime(
  db: Database.Database,
  win?: BrowserWindow
): void {
  const rtCache = getRtKCache()
  if (!rtCache) return

  const watchlist = getTrendSubjects(db)
  if (watchlist.length === 0) return

  // 个股与HS300都使用同一20交易日窗口；盘中仅替换两者的最新价。
  const hs300Entry = rtCache.get('000300.SH')

  // 取各股历史数据（复用 daily_close_cache，使用最近 60 日）
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const startDate = new Date(bjNow.getTime() - 90 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10).replace(/-/g, '')
  const hs300Bars = queryStockOHLCV(db, '000300.SH', startDate)
  const benchmarkReturn20d = computeWindowReturn(
    hs300Bars.map((bar) => bar.close),
    20,
    hs300Entry?.price ?? null,
  )

  // 同一 tsCode 可能出现在多个赛道行，评分只需计算一次
  const processedTsCodes = new Set<string>()
  for (const stock of watchlist) {
    if (processedTsCodes.has(stock.tsCode)) continue
    processedTsCodes.add(stock.tsCode)
    try {
      const rtEntry = rtCache.get(stock.tsCode)
      const bars = queryStockOHLCV(db, stock.tsCode, startDate)
      if (bars.length < 20) continue

      const ohlcvBars: TrendOhlcvBar[] = bars.map((b) => ({
        close: b.close,
        high: b.high ?? b.close,
        low: b.low ?? b.close,
        vol: b.vol,
        turnoverRate: b.turnoverRate,
      }))

      const computation = computeTrendScoreV2(
        ohlcvBars,
        benchmarkReturn20d,
        rtEntry?.price ?? null
      )

      const fullScore: TrendScoreRow = {
        ...computation.score,
        tsCode: stock.tsCode,
        tradeDate: getBjTodayYmd(),
      }
      _realtimeScoreCache.set(stock.tsCode, {
        score: fullScore,
        updatedAt: Date.now(),
        price: rtEntry?.price ?? null,
        change: rtEntry?.change ?? null,
        source: 'realtime',
        computation,
      })

      // 预警检测（盘中实时）
      _checkAndFireAlerts(db, stock.tsCode, stock.stockName, rtEntry?.price ?? null, win)
    } catch {
      // 单只股票计算失败不影响其他股票
    }
  }

  // 推送前端评分更新事件
  if (win && !win.isDestroyed()) {
    win.webContents.send('trend:scoresUpdated')
  }
}

// ──────────────────────────────────────────────────────────────────────────
// EOD 评分存档（写 DB）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 收盘后批量计算趋势池所有股票评分，写入 trend_scores 表。
 * 由 schedulerService 18:00 cron 触发（runAfterCloseDailySyncJob 之后）。
 */
export async function computeAndSaveTrendScoresEOD(
  db: Database.Database,
  win?: BrowserWindow
): Promise<void> {
  if (_eodRunning) return
  _eodRunning = true
  try {
    const watchlist = getTrendSubjects(db)
    if (watchlist.length === 0) return

    const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
    const todayYmd = getBjTodayYmd()
    const startDate = new Date(bjNow.getTime() - 90 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10).replace(/-/g, '')

    const scoreRows: TrendScoreRow[] = []
    const hs300Bars = queryStockOHLCV(db, '000300.SH', startDate)
    let latestScoreDate = ''

    // 同一 tsCode 可能出现在多个赛道行，EOD 评分只需计算一次
    const processedEOD = new Set<string>()
    for (const stock of watchlist) {
      if (processedEOD.has(stock.tsCode)) continue
      processedEOD.add(stock.tsCode)
      try {
        const bars = queryStockOHLCV(db, stock.tsCode, startDate)
        if (bars.length < 20) continue

        const ohlcvBars: TrendOhlcvBar[] = bars.map((b) => ({
          close: b.close,
          high: b.high ?? b.close,
          low: b.low ?? b.close,
          vol: b.vol,
          turnoverRate: b.turnoverRate,
        }))

        const scoreTradeDate = bars.at(-1)?.tradeDate ?? todayYmd
        const benchmarkReturn20d = computeWindowReturn(
          hs300Bars.filter((bar) => bar.tradeDate <= scoreTradeDate).map((bar) => bar.close),
          20,
        )
        const computation = computeTrendScoreV2(ohlcvBars, benchmarkReturn20d)
        const fullScore: TrendScoreRow = {
          ...computation.score,
          tsCode: stock.tsCode,
          tradeDate: scoreTradeDate,
        }
        scoreRows.push(fullScore)
        if (scoreTradeDate > latestScoreDate) latestScoreDate = scoreTradeDate

        // 清除该股实时缓存（EOD 后不再需要）
        _realtimeScoreCache.delete(stock.tsCode)

        // 预警检测（EOD）
        const close = bars[bars.length - 1]?.close ?? null
        _checkAndFireAlerts(db, stock.tsCode, stock.stockName, close, win)
      } catch {
        // 单只计算失败静默
      }
    }

    if (scoreRows.length > 0) {
      upsertTrendScores(db, scoreRows)
    }

    if (win && !win.isDestroyed()) {
      win.webContents.send('trend:scoresUpdated')
    }

    console.log(`[TrendScores] EOD computed ${scoreRows.length} stocks through ${latestScoreDate || todayYmd}`)
  } finally {
    _eodRunning = false
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 预警检测
// ──────────────────────────────────────────────────────────────────────────

/**
 * 检测并触发预警：跌破 MA60（破支撑）、突破近 20 日高点（突破压力）、跌幅超 5%（止损）
 */
function _checkAndFireAlerts(
  db: Database.Database,
  tsCode: string,
  stockName: string,
  price: number | null,
  win?: BrowserWindow
): void {
  if (price == null) return
  const todayYmd = getBjTodayYmd()

  try {
    const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
    const startDate = new Date(bjNow.getTime() - 90 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10).replace(/-/g, '')
    const bars = queryStockOHLCV(db, tsCode, startDate)
    if (bars.length < 20) return

    const lastBar = bars.at(-1)
    const containsCurrentClose = lastBar?.tradeDate === todayYmd
      && Math.abs((lastBar.close ?? 0) - price) < 0.0001
    const referenceBars = containsCurrentClose ? bars.slice(0, -1) : bars
    if (referenceBars.length < 20) return
    const closes = referenceBars.map((b) => b.close)
    const ma60 = referenceBars.length >= 60 ? sma(closes, 60) : null
    const recent20High = Math.max(...closes.slice(-20))
    const prevClose = closes[closes.length - 1]
    const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0

    // 预警1：跌破 MA60
    if (
      ma60 != null &&
      prevClose >= ma60 &&
      price < ma60 &&
      !hasAlertToday(db, tsCode, 'BREAK_MA60', todayYmd)
    ) {
      const id = insertTrendAlert(db, {
        tsCode,
        stockName,
        alertType: 'BREAK_MA60',
        alertDate: todayYmd,
        price,
        refPrice: ma60,
        createdAt: Date.now(),
      })
      _sendAlertPush(win, {
        id,
        tsCode,
        stockName,
        alertType: 'BREAK_MA60',
        alertDate: todayYmd,
        price,
        refPrice: ma60,
      })
      const portfolioContext = getTrendPortfolioSignalContext(db, tsCode, price)
      emitDecisionSignal(db, {
        sourceModule: 'trend',
        strategyKey: 'trend.breakMa60',
        tsCode,
        stockName,
        signalType: 'RISK',
        direction: 'BEARISH',
        priority: trendDecisionPriority(4, portfolioContext.isPortfolio, 'RISK'),
        score: Math.min(100, Math.abs((price - ma60) / ma60) * 1000),
        confidence: 70,
        title: `${stockName} 跌破 MA60`,
        summary: `触发价 ${price.toFixed(2)} 跌破 MA60 ${ma60.toFixed(2)}, 需要复核趋势是否走弱。`,
        reason: { triggerPrice: price, ma60, ...portfolioContext },
        sourceRef: { trendAlertId: id, alertType: 'BREAK_MA60', ...portfolioContext },
        dedupKey: `trend:breakMa60:${todayYmd}:${tsCode}`,
      }, win)
    }

    // 预警2：突破近20日高点（向上突破压力）
    if (
      price > recent20High &&
      !hasAlertToday(db, tsCode, 'BREAK_HIGH20', todayYmd)
    ) {
      const id = insertTrendAlert(db, {
        tsCode,
        stockName,
        alertType: 'BREAK_HIGH20',
        alertDate: todayYmd,
        price,
        refPrice: recent20High,
        createdAt: Date.now(),
      })
      _sendAlertPush(win, {
        id,
        tsCode,
        stockName,
        alertType: 'BREAK_HIGH20',
        alertDate: todayYmd,
        price,
        refPrice: recent20High,
      })
      const portfolioContext = getTrendPortfolioSignalContext(db, tsCode, price)
      emitDecisionSignal(db, {
        sourceModule: 'trend',
        strategyKey: 'trend.breakHigh20',
        tsCode,
        stockName,
        signalType: 'OPPORTUNITY',
        direction: 'BULLISH',
        priority: trendDecisionPriority(4, portfolioContext.isPortfolio, 'OPPORTUNITY'),
        score: Math.min(100, ((price - recent20High) / recent20High) * 1000),
        confidence: 72,
        title: `${stockName} 突破 20 日高点`,
        summary: `触发价 ${price.toFixed(2)} 突破近 20 日高点 ${recent20High.toFixed(2)}, 可关注趋势延续。`,
        reason: { triggerPrice: price, recent20High, ...portfolioContext },
        sourceRef: { trendAlertId: id, alertType: 'BREAK_HIGH20', ...portfolioContext },
        dedupKey: `trend:breakHigh20:${todayYmd}:${tsCode}`,
      }, win)
    }

    // 预警3：单日跌幅超 5%（止损预警）
    if (
      changePct <= -5 &&
      !hasAlertToday(db, tsCode, 'STOP_LOSS_5PCT', todayYmd)
    ) {
      const id = insertTrendAlert(db, {
        tsCode,
        stockName,
        alertType: 'STOP_LOSS_5PCT',
        alertDate: todayYmd,
        price,
        refPrice: prevClose,
        createdAt: Date.now(),
      })
      _sendAlertPush(win, {
        id,
        tsCode,
        stockName,
        alertType: 'STOP_LOSS_5PCT',
        alertDate: todayYmd,
        price,
        refPrice: prevClose,
      })
      const portfolioContext = getTrendPortfolioSignalContext(db, tsCode, price)
      emitDecisionSignal(db, {
        sourceModule: 'trend',
        strategyKey: 'trend.stopLoss5Pct',
        tsCode,
        stockName,
        signalType: 'RISK',
        direction: 'BEARISH',
        priority: trendDecisionPriority(5, portfolioContext.isPortfolio, 'RISK'),
        score: Math.min(100, Math.abs(changePct) * 10),
        confidence: 80,
        title: `${stockName} 单日跌幅触发止损线`,
        summary: `触发价 ${price.toFixed(2)}, 参考价 ${prevClose.toFixed(2)}, 触发时跌幅 ${changePct.toFixed(2)}%, 已达到 5% 止损预警阈值。`,
        reason: { triggerPrice: price, refPrice: prevClose, changePct, ...portfolioContext },
        sourceRef: { trendAlertId: id, alertType: 'STOP_LOSS_5PCT', ...portfolioContext },
        dedupKey: `trend:stopLoss5Pct:${todayYmd}:${tsCode}`,
      }, win)
    }
  } catch {
    // 静默处理
  }
}

function _sendAlertPush(
  win: BrowserWindow | undefined,
  payload: {
    id: number
    tsCode: string
    stockName: string
    alertType: string
    alertDate: string
    price: number | null
    refPrice: number | null
  }
): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('trend:alert', payload)
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 对外查询接口
// ──────────────────────────────────────────────────────────────────────────

/**
 * 按需评分（对无评分或评分落后于最新本地行情的股票做一次纯历史评分，结果写入实时缓存）。
 * 优先读 daily_close_cache，无数据时 fallback 到 stock_price_cache（用户在走势图浏览过的股票）。
 * 用于非交易时段首次打开「趋势看板」时，确保用户能看到历史评分。
 * 已有实时缓存或 DB 存档且日期不落后于最新本地行情的股票直接跳过。
 */
export function computeTrendScoresOnDemand(db: Database.Database): void {
  const watchlist = getTrendSubjects(db)
  if (watchlist.length === 0) return

  // 去重：同一 tsCode 可能出现在多个赛道行（复合主键），评分只需计算一次
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const startDate = new Date(bjNow.getTime() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '')

  // 个股数据可能停在不同交易日，基准收益必须按每只股票的评分日截断。
  const hs300DailyBars = queryStockOHLCV(db, '000300.SH', startDate)
  const hs300PriceRows = hs300DailyBars.length >= 21 ? [] : getCachedPrices(db, '000300')

  for (const stock of watchlist) {
    try {
      const historicalInput = getHistoricalScoreInput(db, stock.tsCode, startDate)
      const rtScore = _realtimeScoreCache.get(stock.tsCode)
      if (rtScore && (!historicalInput || rtScore.score.tradeDate >= historicalInput.tradeDate)) {
        continue
      }

      if (!historicalInput) {
        console.warn(
          `[TrendOnDemand] ${stock.tsCode}: SKIP | startDate=${startDate}` +
          ` | no enough local bars`
        )
        continue
      }

      const benchmarkReturn20d = hs300DailyBars.length >= 21
        ? computeWindowReturn(
            hs300DailyBars.filter((bar) => bar.tradeDate <= historicalInput.tradeDate).map((bar) => bar.close),
            20,
          )
        : computeWindowReturn(
            hs300PriceRows
              .filter((row) => row.tradeDate <= historicalInput.tradeDate)
              .map((row) => row.close ?? 0)
              .filter((value) => value > 0),
            20,
          )
      const computation = computeTrendScoreV2(historicalInput.bars, benchmarkReturn20d)
      _realtimeScoreCache.set(stock.tsCode, {
        score: {
          ...computation.score,
          tsCode: stock.tsCode,
          tradeDate: historicalInput.tradeDate,
        },
        updatedAt: Date.now(),
        price: historicalInput.price,
        change: historicalInput.change,
        source: 'eod',
        computation,
      })
    } catch (e) {
      console.warn(`[TrendOnDemand] ${stock.tsCode}: error`, e)
    }
  }
}

export interface TrendScoreRankingItem {
  tsCode: string
  totalScore: number | null
  dataSource: 'realtime' | 'eod'
  dataTime: string
}

/**
 * 为其他本地工作台提供与趋势看板相同优先级的轻量评分视图。
 * 不触发评分计算：盘中缓存优先，最近EOD存档兜底。
 */
export function getTrendScoreRankingSnapshot(
  db: Database.Database,
  tsCodes: string[],
): Map<string, TrendScoreRankingItem> {
  const normalizedCodes = [...new Set(tsCodes.map((value) => value.trim().toUpperCase()).filter(Boolean))]
  const dbScores = getLatestTrendScores(db, normalizedCodes)
  const result = new Map<string, TrendScoreRankingItem>()
  for (const tsCode of normalizedCodes) {
    const realtime = _realtimeScoreCache.get(tsCode)
    if (realtime) {
      result.set(tsCode, {
        tsCode,
        totalScore: realtime.score.totalScore,
        dataSource: realtime.source,
        dataTime: realtime.source === 'realtime' ? toBjHHmm(realtime.updatedAt) : realtime.score.tradeDate,
      })
      continue
    }
    const eod = dbScores.get(tsCode)
    if (!eod) continue
    result.set(tsCode, {
      tsCode,
      totalScore: eod.totalScore,
      dataSource: 'eod',
      dataTime: eod.tradeDate,
    })
  }
  return result
}

export function getTrendScoreComputationSnapshot(tsCode: string): TrendScoreComputation | null {
  const normalized = normalizeTsCode(tsCode)
  return _realtimeScoreCache.get(normalized)?.computation ?? null
}

/**
 * 获取趋势池所有股票的当前评分快照（盘中优先实时缓存，否则取 DB 最近存档）
 */
export function getTrendScoreSnapshot(db: Database.Database): TrendScoreDetail[] {
  const watchlist = getTrendSubjects(db)
  if (watchlist.length === 0) return []

  const tsCodes = watchlist.map((s) => s.tsCode)
  const rtCache = getRtKCache()
  const rtDataTime = toBjHHmm(getRtKCachedAt())

  // 取 DB 最近存档（作为 fallback）
  const dbScores = getLatestTrendScores(db, tsCodes)
  const chipByCode = safeBuildLatestChipSummaryMap(db)

  const result: TrendScoreDetail[] = []
  for (const stock of watchlist) {
    const rtEntry = rtCache?.get(stock.tsCode)
    const rtScore = _realtimeScoreCache.get(stock.tsCode)

    let detail: TrendScoreDetail
    if (rtScore) {
      // 实时缓存
      const s = rtScore.score
      const price = rtEntry?.price ?? rtScore.price ?? null
      const change = rtEntry?.change ?? rtScore.change ?? null
      const position = buildPositionAdvice({
        costPrice: stock.costPrice,
        price,
        totalScore: s.totalScore,
        maAbove60: s.maAbove60 != null ? s.maAbove60 === 1 : null,
        drawdown: s.drawdown,
        change,
      })
      detail = {
        tsCode: stock.tsCode,
        stockName: stock.stockName,
        groupTag: stock.groupTag,
        category: stock.category,
        subCategory: stock.subCategory,
        notes: stock.notes,
        isPortfolio: stock.isPortfolio,
        costPrice: stock.costPrice,
        profitPct: position.profitPct,
        positionAdvice: position.positionAdvice,
        positionAdviceReason: position.positionAdviceReason,
        chip: chipByCode.get(stock.tsCode) ?? chipByCode.get(stripTsSuffix(stock.tsCode)) ?? null,
        totalScore: s.totalScore,
        maScore: s.maScore,
        maAbove60: s.maAbove60 != null ? s.maAbove60 === 1 : null,
        alphaScore: s.alphaScore,
        drawdown: s.drawdown,
        turnoverRatio: s.turnoverRatio,
        macdAboveZero: s.macdAboveZero != null ? s.macdAboveZero === 1 : null,
        bollAboveMid: s.bollAboveMid != null ? s.bollAboveMid === 1 : null,
        price,
        change,
        dataSource: rtScore.source,
        dataTime: rtScore.source === 'realtime'
          ? new Date(rtScore.updatedAt + 8 * 60 * 60 * 1000).toISOString().slice(11, 16)
          : rtScore.score.tradeDate,
        scoreSource: rtScore.source,
        scoreDate: rtScore.score.tradeDate,
        quoteSource: rtEntry ? 'realtime' : 'eod',
        quoteTime: rtEntry ? rtDataTime : rtScore.score.tradeDate,
        scoreVersion: 'v2',
        validWeight: rtScore.computation.validWeight,
      }
    } else {
      // DB 存档
      const s = dbScores.get(stock.tsCode)
      const eodSnapshot = s
        ? getPriceSnapshotForTradeDate(db, stock.tsCode, s.tradeDate)
        : getLatestPriceSnapshot(db, stock.tsCode)
      const displayPrice = rtEntry?.price ?? eodSnapshot.price
      const displayChange = rtEntry?.change ?? eodSnapshot.change
      const hasRealtimeQuote = rtEntry != null
      const position = buildPositionAdvice({
        costPrice: stock.costPrice,
        price: displayPrice,
        totalScore: s?.totalScore ?? null,
        maAbove60: s?.maAbove60 != null ? s.maAbove60 === 1 : null,
        drawdown: s?.drawdown ?? null,
        change: displayChange,
      })
      detail = {
        tsCode: stock.tsCode,
        stockName: stock.stockName,
        groupTag: stock.groupTag,
        category: stock.category,
        subCategory: stock.subCategory,
        notes: stock.notes,
        isPortfolio: stock.isPortfolio,
        costPrice: stock.costPrice,
        profitPct: position.profitPct,
        positionAdvice: position.positionAdvice,
        positionAdviceReason: position.positionAdviceReason,
        chip: chipByCode.get(stock.tsCode) ?? chipByCode.get(stripTsSuffix(stock.tsCode)) ?? null,
        totalScore: s?.totalScore ?? null,
        maScore: s?.maScore ?? null,
        maAbove60: s?.maAbove60 != null ? s.maAbove60 === 1 : null,
        alphaScore: s?.alphaScore ?? null,
        drawdown: s?.drawdown ?? null,
        turnoverRatio: s?.turnoverRatio ?? null,
        macdAboveZero: s?.macdAboveZero != null ? s.macdAboveZero === 1 : null,
        bollAboveMid: s?.bollAboveMid != null ? s.bollAboveMid === 1 : null,
        price: displayPrice,
        change: displayChange,
        dataSource: 'eod',
        dataTime: s?.tradeDate ?? '',
        scoreSource: 'eod',
        scoreDate: s?.tradeDate ?? '',
        quoteSource: hasRealtimeQuote ? 'realtime' : 'eod',
        quoteTime: hasRealtimeQuote ? rtDataTime : (s?.tradeDate ?? ''),
        scoreVersion: 'legacy',
        validWeight: null,
      }
    }
    result.push(detail)
  }

  // 保持 category/subCategory 排序（getAllTrendWatchStocks 已按此排序），不再全局按分数排
  return result
}

function safeBuildLatestChipSummaryMap(db: Database.Database): Map<string, ChipSummary> {
  try {
    return buildLatestChipSummaryMap(db)
  } catch (err) {
    console.warn('[TrendWatcher] chip summary failed:', err)
    return new Map()
  }
}

/**
 * 获取最近 N 天的预警记录
 */
export function getTrendAlerts(db: Database.Database, days = 30): TrendAlertItem[] {
  const rows = getRecentTrendAlerts(db, days)
  return rows.map((r) => ({
    id: r.id,
    tsCode: r.tsCode,
    stockName: r.stockName,
    alertType: r.alertType,
    alertDate: r.alertDate,
    price: r.price,
    refPrice: r.refPrice,
    createdAt: r.createdAt,
  }))
}

/**
 * 清理过期数据（16:00 cron 调用）
 */
export function cleanupTrendData(db: Database.Database): void {
  const r1 = cleanupTrendScores(db, 90)
  const r2 = cleanupTrendAlerts(db, 90)
  console.log(`[TrendCleanup] scores=${r1} alerts=${r2}`)
}

// ──────────────────────────────────────────────────────────────────────────
// 数学辅助函数
// ──────────────────────────────────────────────────────────────────────────

/** 去掉 Tushare 股票代码后缀，如 600176.SH → 600176 */
function stripTsSuffix(tsCode: string): string {
  return tsCode.replace(/\.(SH|SZ|BJ)$/i, '')
}

function toOhlcvFromDailyRows(rows: DailyRow[]): TrendOhlcvBar[] {
  return rows.map((b) => ({
    close: b.close,
    high: b.high ?? b.close,
    low: b.low ?? b.close,
    vol: b.vol,
    turnoverRate: b.turnoverRate,
  }))
}

function toOhlcvFromPriceRows(rows: ReturnType<typeof getCachedPrices>): TrendOhlcvBar[] {
  return rows.map((r) => ({
    close: r.close ?? 0,
    high: r.high ?? r.close ?? 0,
    low: r.low ?? r.close ?? 0,
    vol: r.volume,
    turnoverRate: null,
  }))
}

function computeChangeFromRows(rows: Array<{ close: number | null }>): number | null {
  if (rows.length < 2) return null
  const last = rows[rows.length - 1].close ?? null
  const prev = rows[rows.length - 2].close ?? null
  if (last == null || prev == null || prev <= 0) return null
  return ((last - prev) / prev) * 100
}

function buildHistoricalInputFromDailyRows(rows: DailyRow[]): HistoricalScoreInput | null {
  if (rows.length < 20) return null
  const last = rows[rows.length - 1]
  const previous = rows.length >= 2 ? rows[rows.length - 2] : null
  const fallbackChange = previous && previous.close > 0
    ? ((last.close - previous.close) / previous.close) * 100
    : null
  return {
    bars: toOhlcvFromDailyRows(rows),
    tradeDate: last.tradeDate,
    price: last.close,
    change: last.pctChg ?? fallbackChange,
    dailyRows: rows.length,
    priceRows: 0,
    filteredPriceRows: 0,
    earliestPriceDate: null,
    latestPriceDate: null,
  }
}

function buildHistoricalInputFromPriceRows(
  rows: ReturnType<typeof getCachedPrices>,
  dailyRows: number
): HistoricalScoreInput | null {
  const validRows = rows.filter((r) => (r.close ?? 0) > 0)
  if (validRows.length < 20) return null
  const last = validRows[validRows.length - 1]
  return {
    bars: toOhlcvFromPriceRows(validRows),
    tradeDate: last.tradeDate,
    price: last.close ?? 0,
    change: computeChangeFromRows(validRows),
    dailyRows,
    priceRows: rows.length,
    filteredPriceRows: validRows.length,
    earliestPriceDate: rows[0]?.tradeDate ?? null,
    latestPriceDate: rows[rows.length - 1]?.tradeDate ?? null,
  }
}

function getHistoricalScoreInput(
  db: Database.Database,
  tsCode: string,
  startDate: string
): HistoricalScoreInput | null {
  const dailyRows = queryStockOHLCV(db, tsCode, startDate)
  const dailyInput = buildHistoricalInputFromDailyRows(dailyRows)
  if (dailyInput) return dailyInput

  const code6 = stripTsSuffix(tsCode)
  const priceRows = getCachedPrices(db, code6).filter((r) => r.tradeDate >= startDate)
  return buildHistoricalInputFromPriceRows(priceRows, dailyRows.length)
}

function findDailyPriceSnapshot(rows: DailyRow[], tradeDate: string): PriceSnapshot | null {
  const index = rows.findIndex((row) => row.tradeDate === tradeDate)
  if (index < 0) return null
  const row = rows[index]
  const prev = index > 0 ? rows[index - 1] : null
  const fallbackChange = prev && prev.close > 0
    ? ((row.close - prev.close) / prev.close) * 100
    : null
  return {
    price: row.close,
    change: row.pctChg ?? fallbackChange,
  }
}

function findCachedPriceSnapshot(
  rows: ReturnType<typeof getCachedPrices>,
  tradeDate: string
): PriceSnapshot | null {
  const index = rows.findIndex((row) => row.tradeDate === tradeDate)
  if (index < 0) return null
  const row = rows[index]
  const prev = index > 0 ? rows[index - 1] : null
  const price = row.close ?? null
  const prevClose = prev?.close ?? null
  return {
    price,
    change: price != null && prevClose != null && prevClose > 0
      ? ((price - prevClose) / prevClose) * 100
      : null,
  }
}

function getLatestPriceSnapshot(db: Database.Database, tsCode: string): PriceSnapshot {
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const startDate = new Date(bjNow.getTime() - 10 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10).replace(/-/g, '')
  const dailyRows = queryStockOHLCV(db, tsCode, startDate)
  if (dailyRows.length > 0) {
    const last = dailyRows[dailyRows.length - 1]
    const prev = dailyRows.length >= 2 ? dailyRows[dailyRows.length - 2] : null
    return {
      price: last.close,
      change: last.pctChg ?? (prev && prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : null),
    }
  }

  const priceRows = getCachedPrices(db, stripTsSuffix(tsCode))
  if (priceRows.length === 0) return { price: null, change: null }
  const last = priceRows[priceRows.length - 1]
  return {
    price: last.close ?? null,
    change: computeChangeFromRows(priceRows),
  }
}

function getPriceSnapshotForTradeDate(
  db: Database.Database,
  tsCode: string,
  tradeDate: string
): PriceSnapshot {
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const startDate = new Date(bjNow.getTime() - 120 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10).replace(/-/g, '')
  const dailyRows = queryStockOHLCV(db, tsCode, startDate)
  const dailySnapshot = findDailyPriceSnapshot(dailyRows, tradeDate)
  if (dailySnapshot) return dailySnapshot

  const priceRows = getCachedPrices(db, stripTsSuffix(tsCode))
  const cachedSnapshot = findCachedPriceSnapshot(priceRows, tradeDate)
  if (cachedSnapshot) return cachedSnapshot

  return getLatestPriceSnapshot(db, tsCode)
}

/** 简单移动平均 */
function sma(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] ?? 0
  const slice = closes.slice(closes.length - period)
  return slice.reduce((s, v) => s + v, 0) / period
}

/** 算术平均 */
/** 返回北京时间当日 YYYYMMDD */
function getBjTodayYmd(): string {
  const bj = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return (
    `${bj.getUTCFullYear()}` +
    `${String(bj.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(bj.getUTCDate()).padStart(2, '0')}`
  )
}

function toBjHHmm(timestamp: number): string {
  if (!timestamp) return ''
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(11, 16)
}
