/**
 * FR-151b: 个性选股计算引擎（魔鬼操盘手·精准控量版）
 *
 * 核心策略参数：
 *   天使线 = EMA(close, 2)
 *   魔鬼线 = EMA(SLOPE(close, 21) * 20 + close, 42)
 *   金叉信号 = 天使线上穿魔鬼线（前一日天使 < 魔鬼，当日天使 > 魔鬼）
 *   量能放大 = vol > MA(vol, 5) * 1.1
 *   短期多头 = close > MA(close,5) && MA(close,5) > MA(close,10)
 *   MACD 向好 = DIF > DEA（默认 12/26/9）
 *   有换手 = vol / (circFloat * 10000) * 100 > 1%
 *
 * 风险排除（预筛）：
 *   - 名称含 "ST"（包括 *ST）
 *   - list_status != 'L'（退市 / 暂停）
 *   - ts_code 以 "688" 开头（科创板）
 *   - industry 含 "银行" / "证券" / "房地产"
 *
 * 历史数据要求：>= 65 行（EMA42 稳定需要约 84 天，但 65 天是可接受的最低门槛）
 * 信号强度：signalScore = 满足的五项信号数（0~5），>= 1 才进入结果列表（前端动态过滤）
 */

import type Database from 'better-sqlite3'
import { queryAllActive } from '../database/stockBasicCacheRepository'
import { queryDailyClose } from '../database/dailyCloseCacheRepository'
import { upsertResults } from '../database/stockScreenerResultsRepository'
import type { ScreenerMoneyFlowSummary, ScreenerRankBreakdownItem, ScreenerSignalKey, StockScreenerResultRow } from '../database/types'
import { buildEstimatedMoneyFlowSummary, buildMoneyFlowSummary, getMoneyFlowMapByDate } from '../database/moneyFlowRepository'
import { getScreenerRankConfig, type ScreenerRankConfig } from '../database/screenerRankConfigRepository'
import { getRtKCache, getRtKCachedAt, isRtKStale } from './sharedRtKCache'

// ── 数学辅助函数 ─────────────────────────────────────────────────────────────

/**
 * 指数移动平均（EWM），对标通达信 EMA
 * 初值 = 前 period 个简单均值；k = 2/(period+1)
 * 前 period-1 项输出 NaN（数据不足）
 */
export function ema(series: number[], period: number): number[] {
  const result = new Array<number>(series.length).fill(NaN)
  if (series.length < period) return result
  // 初始均值
  let sum = 0
  for (let i = 0; i < period; i++) sum += series[i]
  const k = 2 / (period + 1)
  result[period - 1] = sum / period
  for (let i = period; i < series.length; i++) {
    result[i] = series[i] * k + result[i - 1] * (1 - k)
  }
  return result
}

/**
 * 最小二乘线性斜率（SLOPE），对标通达信 SLOPE
 * 对每个位置 i（i >= period-1），用最近 period 个值拟合直线，返回斜率
 * 前 period-1 项输出 NaN
 */
export function slope(series: number[], period: number): number[] {
  const result = new Array<number>(series.length).fill(NaN)
  const xMean = (period - 1) / 2
  // 预计算 x 方差（固定）
  let xVar = 0
  for (let x = 0; x < period; x++) xVar += (x - xMean) ** 2
  if (xVar === 0) return result

  for (let i = period - 1; i < series.length; i++) {
    let xy = 0
    let yMean = 0
    for (let j = 0; j < period; j++) yMean += series[i - period + 1 + j]
    yMean /= period
    for (let j = 0; j < period; j++) {
      xy += (j - xMean) * (series[i - period + 1 + j] - yMean)
    }
    result[i] = xy / xVar
  }
  return result
}

/**
 * 简单移动平均（MA / SMA）
 * 前 period-1 项输出 NaN
 */
export function ma(series: number[], period: number): number[] {
  const result = new Array<number>(series.length).fill(NaN)
  if (series.length < period) return result
  let sum = 0
  for (let i = 0; i < period; i++) sum += series[i]
  result[period - 1] = sum / period
  for (let i = period; i < series.length; i++) {
    sum += series[i] - series[i - period]
    result[i] = sum / period
  }
  return result
}

/**
 * MACD（DIF + DEA），对标通达信 MACD
 * dif = EMA(series, fast) - EMA(series, slow)
 * dea = EMA(dif_valid, signal)  — 仅对有效（非 NaN）dif 段计算 EWM
 */
export function macd(
  series: number[],
  fast = 12,
  slow = 26,
  signal = 9
): { dif: number[]; dea: number[] } {
  const emaFast = ema(series, fast)
  const emaSlow = ema(series, slow)
  const dif = emaFast.map((v, i) => (isNaN(v) || isNaN(emaSlow[i]) ? NaN : v - emaSlow[i]))
  // 对 dif 中的有效段做 EMA
  const dea = new Array<number>(series.length).fill(NaN)
  const k = 2 / (signal + 1)
  let initialized = false
  let signalCount = 0
  let signalSum = 0
  for (let i = 0; i < dif.length; i++) {
    if (isNaN(dif[i])) {
      initialized = false
      signalCount = 0
      signalSum = 0
      continue
    }
    if (!initialized) {
      signalSum += dif[i]
      signalCount++
      if (signalCount >= signal) {
        dea[i] = signalSum / signal
        initialized = true
      }
    } else {
      dea[i] = dif[i] * k + dea[i - 1] * (1 - k)
    }
  }
  return { dif, dea }
}

// ── 选股主函数类型定义 ────────────────────────────────────────────────────────

export interface ScreenerOptions {
  /** 换手率门槛（%），默认 1.0 */
  turnoverThreshold?: number
  /** 量能倍数门槛，默认 1.1 */
  volumeMultiplier?: number
  /** 最少历史天数，默认 65 */
  minDays?: number
}

export interface ScreenerStock {
  tsCode: string
  stockName: string
  close: number
  pctChg: number
  turnoverRate: number | null
  vol: number
  amount: number
  signalScore: number
  conditionsMet: string[]   // 满足的条件名称
  concepts: string[]        // 题材名称（最多 5 个）
  turnoverMissing?: boolean
  rankScore: number
  rankBreakdown: ScreenerRankBreakdownItem[]
  signalStrength: Record<ScreenerSignalKey, number>
  moneyFlow: ScreenerMoneyFlowSummary | null
}

export type ScreenerMode = 'realtime' | 'eod' | 'eod-fallback'

export interface ScreenerSnapshot {
  tradeDate: string
  calculatedAt: string      // ISO 时间字符串
  isCached: boolean
  mode: ScreenerMode
  rtTime?: string
  totalScanned: number      // 参与计算的股票数
  stocks: ScreenerStock[]
}

// ── 排除行业关键字 ────────────────────────────────────────────────────────────
const EXCLUDED_INDUSTRIES = ['银行', '证券', '房地产']

const SIGNAL_LABELS: Record<ScreenerSignalKey, string> = {
  crossUp: '天使魔鬼金叉',
  volAmplified: '量能放大',
  bullTrend: '短期多头',
  macdBull: 'MACD向好',
  hasTurnover: '有效换手',
  moneyInflow: '资金净流入',
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function normalizeByCap(value: number | null | undefined, cap: number): number {
  if (value == null || !Number.isFinite(value) || value <= 0 || cap <= 0) return 0
  return clamp01(value / cap)
}

function buildRankBreakdown(
  matches: Record<ScreenerSignalKey, boolean>,
  rawStrength: Record<ScreenerSignalKey, number>,
  config: ScreenerRankConfig,
): { rankScore: number; rankBreakdown: ScreenerRankBreakdownItem[]; signalStrength: Record<ScreenerSignalKey, number> } {
  const signalStrength = Object.keys(SIGNAL_LABELS).reduce<Record<ScreenerSignalKey, number>>((acc, key) => {
    const signalKey = key as ScreenerSignalKey
    acc[signalKey] = matches[signalKey]
      ? (config.normalizeEnabled ? clamp01(rawStrength[signalKey]) : 1)
      : 0
    return acc
  }, {} as Record<ScreenerSignalKey, number>)

  const rankBreakdown = (Object.keys(SIGNAL_LABELS) as ScreenerSignalKey[]).map((key) => {
    const weight = config.weights[key] ?? 0
    const strength = signalStrength[key]
    return {
      key,
      label: SIGNAL_LABELS[key],
      matched: matches[key],
      weight,
      strength,
      contribution: strength * weight,
    }
  })
  return {
    rankScore: rankBreakdown.reduce((sum, item) => sum + item.contribution, 0),
    rankBreakdown,
    signalStrength,
  }
}

function getTieBreakerValue(stock: ScreenerStock, tieBreaker: ScreenerRankConfig['tieBreaker']): number {
  if (tieBreaker === 'turnoverRate') return stock.turnoverRate ?? -Infinity
  if (tieBreaker === 'amount') return stock.amount ?? -Infinity
  return stock.pctChg
}

// ── 计算起始日期（回溯 N 个日历日）────────────────────────────────────────────
function calcStartDate(tradeDate: string, calendarDays: number): string {
  const year = parseInt(tradeDate.slice(0, 4), 10)
  const month = parseInt(tradeDate.slice(4, 6), 10) - 1
  const day = parseInt(tradeDate.slice(6, 8), 10)
  const d = new Date(year, month, day)
  d.setDate(d.getDate() - calendarDays)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${dd}`
}

function isInTradingHoursBj(): boolean {
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const day = bjNow.getUTCDay()
  if (day < 1 || day > 5) return false
  const totalMin = bjNow.getUTCHours() * 60 + bjNow.getUTCMinutes()
  return (totalMin >= 9 * 60 + 30 && totalMin < 11 * 60 + 30)
    || (totalMin >= 13 * 60 && totalMin < 15 * 60)
}

function toBjHHmm(ms: number): string {
  const d = new Date(ms + 8 * 60 * 60 * 1000)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

// ── 主函数 ────────────────────────────────────────────────────────────────────

/**
 * 在全市场范围内运行个性选股，返回 ScreenerSnapshot。
 * 计算过程纯 JS 同步（避免 worker_threads 复杂度），
 * 全市场约 5000 只股票，耗时约 200-500ms。
 */
export function runScreener(
  db: Database.Database,
  tradeDate: string,
  options?: ScreenerOptions
): ScreenerSnapshot {
  const turnoverThreshold = options?.turnoverThreshold ?? 1.0
  const volumeMultiplier = options?.volumeMultiplier ?? 1.1
  const minDays = options?.minDays ?? 65
  const rankConfig = getScreenerRankConfig(db)

  const inTradingHours = isInTradingHoursBj()
  const rtCache = getRtKCache()
  const canUseRealtime = inTradingHours && !!rtCache && rtCache.size > 0 && !isRtKStale()
  const mode: ScreenerMode = inTradingHours ? (canUseRealtime ? 'realtime' : 'eod-fallback') : 'eod'
  const rtTime = canUseRealtime ? toBjHHmm(getRtKCachedAt()) : undefined


  // 步骤1：读 stock_basic_cache 并预筛
  const basics = queryAllActive(db)
  if (basics.length === 0) {
    throw Object.assign(new Error('stock_basic_cache is empty'), { code: 'STOCK_BASIC_NOT_READY' })
  }

  // 预筛：排除 ST / 科创板 / 行业
  const candidates = basics.filter(b => {
    if (b.name && b.name.includes('ST')) return false
    if (b.tsCode.startsWith('688')) return false
    if (b.industry && EXCLUDED_INDUSTRIES.some(kw => b.industry!.includes(kw))) return false
    return true
  })

  // 步骤2：批量读 daily_close_cache
  const startDate = calcStartDate(tradeDate, 130) // 130 日历天 ≈ 90 个交易日，足够 EMA42
  const tsCodes = candidates.map(b => b.tsCode)
  const dailyMap = queryDailyClose(db, tsCodes, startDate)
  const moneyFlowMap = getMoneyFlowMapByDate(db, tradeDate)

  // 检查数据充分性：需 ≥65 个不同交易日（EMA42 稳定需约 84 个日历天）
  const distinctDateCount = (db.prepare('SELECT COUNT(DISTINCT trade_date) AS cnt FROM daily_close_cache').get() as { cnt: number }).cnt
  if (distinctDateCount < 65) {
    throw Object.assign(new Error(`daily_close_cache 仅有 ${distinctDateCount} 个交易日，需 ≥65 个`), {
      code: 'DAILY_DATA_INSUFFICIENT'
    })
  }

  // 步骤3：读题材数据（kpl_concept_members 全量，按 hot_num 降序）
  // con_code=股票代码（600657.SH），name=题材名称，hot_num=热度
  // 不做 JOIN 过滤：所有在 kpl_concept_members 中有记录的股票均可取到题材
  const conceptMap = new Map<string, string[]>() // 股票代码 → [题材名称，最多5个]
  try {
    const conceptRows = db
      .prepare(
        `SELECT con_code, name, hot_num
         FROM kpl_concept_members
         WHERE name IS NOT NULL
         ORDER BY hot_num DESC
         LIMIT 200000`
      )
      .all() as { con_code: string; name: string; hot_num: number | null }[]
    for (const r of conceptRows) {
      if (!conceptMap.has(r.con_code)) conceptMap.set(r.con_code, [])
      const arr = conceptMap.get(r.con_code)!
      if (arr.length < 5) arr.push(r.name)
    }
  } catch {
    // 题材查询失败不影响选股主流程
  }

  // 步骤4：逐只计算信号
  const results: ScreenerStock[] = []
  let totalScanned = 0

  for (const basic of candidates) {
    const rows = dailyMap.get(basic.tsCode)
    if (!rows || rows.length < minDays) {
      continue
    }

    totalScanned++

    // 只取 tradeDate 及以前的数据（防止未来数据泄漏）
    const filtered = rows.filter(r => r.tradeDate <= tradeDate)
    if (filtered.length < minDays) continue

    const rtEntry = canUseRealtime ? (rtCache?.get(basic.tsCode) ?? null) : null
    let effectiveRows = filtered
    if (rtEntry && Number.isFinite(rtEntry.price) && rtEntry.price > 0) {
      const lastKnownTurnover = [...filtered].reverse().find((r) => r.turnoverRate != null)?.turnoverRate ?? null
      const estimatedTurnover = basic.circFloat && basic.circFloat > 0
        ? rtEntry.vol / basic.circFloat
        : null
      const realtimeRow = {
        tsCode: basic.tsCode,
        tradeDate,
        open: null,
        high: null,
        low: null,
        close: rtEntry.price,
        pctChg: rtEntry.change,
        vol: rtEntry.vol,
        turnoverRate: lastKnownTurnover ?? estimatedTurnover,
      }
      if (filtered.length > 0 && filtered[filtered.length - 1].tradeDate === tradeDate) {
        effectiveRows = [...filtered.slice(0, -1), realtimeRow]
      } else {
        effectiveRows = [...filtered, realtimeRow]
      }
    }

    const closes = effectiveRows.map(r => r.close)
    const vols = effectiveRows.map(r => r.vol ?? 0)
    const turnovers = effectiveRows.map((r) => r.turnoverRate ?? null)
    const n = closes.length

    // 天使线 = EMA(close, 2)
    const angel = ema(closes, 2)
    // 魔鬼线原材料：SLOPE(close, 21) * 20 + close
    const slopeArr = slope(closes, 21)
    const devilInput = closes.map((c, i) => (isNaN(slopeArr[i]) ? NaN : slopeArr[i] * 20 + c))
    // 过滤 NaN 段，对有效序列做 EMA42
    const devilFull = new Array<number>(n).fill(NaN)
    // 找到第一个有效 devilInput 的位置
    let firstValid = devilInput.findIndex(v => !isNaN(v))
    if (firstValid >= 0) {
      const validSlice = devilInput.slice(firstValid)
      const devilSlice = ema(validSlice, 42)
      for (let i = 0; i < devilSlice.length; i++) {
        devilFull[firstValid + i] = devilSlice[i]
      }
    }
    // 魔鬼线 = devilFull

    const last = n - 1
    const prev = n - 2

    if (isNaN(angel[last]) || isNaN(devilFull[last])) continue
    if (prev < 0 || isNaN(angel[prev]) || isNaN(devilFull[prev])) continue

    // 信号1：天使魔鬼金叉（前一日天使 < 魔鬼，当日天使 > 魔鬼）
    const crossUp = angel[prev] < devilFull[prev] && angel[last] > devilFull[last]

    // 信号2：量能放大 vol > MA(vol,5) * multiplier
    const maVol5 = ma(vols, 5)
    const volAmplified =
      !isNaN(maVol5[last]) && maVol5[last] > 0 && vols[last] > maVol5[last] * volumeMultiplier

    // 信号3：短期多头 close > MA(5) > MA(10)
    const ma5 = ma(closes, 5)
    const ma10 = ma(closes, 10)
    const bullTrend =
      !isNaN(ma5[last]) &&
      !isNaN(ma10[last]) &&
      closes[last] > ma5[last] &&
      ma5[last] > ma10[last]

    // 信号4：MACD DIF > DEA
    const { dif, dea } = macd(closes)
    const macdBull = !isNaN(dif[last]) && !isNaN(dea[last]) && dif[last] > dea[last]

    // 信号5：换手率 > 阈值
    // vol 单位：手（1手=100股）；circFloat 单位：万股（=10000股）
    // 换手率(%) = vol*100股 / (circFloat*10000股) * 100 = vol / circFloat
    const lastVol = vols[last]
    const circFloat = basic.circFloat ?? 0
    const estimatedTurnover = circFloat > 0 ? lastVol / circFloat : null
    const dbTurnover = turnovers[last]
    const turnoverRate = dbTurnover ?? estimatedTurnover
    const hasTurnover = turnoverRate != null && turnoverRate > turnoverThreshold

    // 计算信号分数
    const conditionsMet: string[] = []
    if (crossUp) conditionsMet.push('天使魔鬼金叉')
    if (volAmplified) conditionsMet.push('量能放大')
    if (bullTrend) conditionsMet.push('短期多头')
    if (macdBull) conditionsMet.push('MACD向好')
    if (hasTurnover) conditionsMet.push('有效换手')

    // 末日行情数据
    const lastRow = effectiveRows[last]
    const amount = rtEntry?.amount ?? (lastRow.vol != null ? lastRow.vol * lastRow.close * 100 : 0) // 近似成交额（元）
    const moneyFlowRow = moneyFlowMap.get(basic.tsCode) ?? moneyFlowMap.get(basic.tsCode.split('.')[0]) ?? null
    const moneyFlow = moneyFlowRow ? buildMoneyFlowSummary(moneyFlowRow, amount) : buildEstimatedMoneyFlowSummary()
    const moneyInflow = moneyFlow?.source === 'real' && (moneyFlow.mainNetInflow ?? 0) > 0
    if (moneyInflow) conditionsMet.push('资金净流入')
    const signalScore = conditionsMet.length

    // 前端负责按用户设定的门槛过滤；后端只排除完全无信号的
    if (signalScore < 1) continue

    const volumeRatio = !isNaN(maVol5[last]) && maVol5[last] > 0 ? vols[last] / maVol5[last] : 0
    const macdSpread = !isNaN(dif[last]) && !isNaN(dea[last]) ? dif[last] - dea[last] : 0
    const matches: Record<ScreenerSignalKey, boolean> = {
      crossUp,
      volAmplified,
      bullTrend,
      macdBull,
      hasTurnover,
      moneyInflow,
    }
    const rawStrength: Record<ScreenerSignalKey, number> = {
      crossUp: crossUp ? 1 : 0,
      volAmplified: normalizeByCap(volumeRatio, rankConfig.normalizationCaps.volAmplified),
      bullTrend: bullTrend ? 1 : 0,
      macdBull: normalizeByCap(macdSpread, rankConfig.normalizationCaps.macdBull),
      hasTurnover: normalizeByCap(turnoverRate, rankConfig.normalizationCaps.hasTurnover),
      moneyInflow: normalizeByCap(moneyFlow?.mainNetInflowRatio, rankConfig.normalizationCaps.moneyInflow),
    }
    const { rankScore, rankBreakdown, signalStrength } = buildRankBreakdown(matches, rawStrength, rankConfig)

    results.push({
      tsCode: basic.tsCode,
      stockName: basic.name ?? basic.tsCode,
      close: lastRow.close,
      pctChg: lastRow.pctChg,
      turnoverRate,
      vol: lastVol,
      amount,
      signalScore,
      conditionsMet,
      concepts: conceptMap.get(basic.tsCode) ?? [],  // tsCode 格式如 002009.SZ
      turnoverMissing: turnoverRate == null,
      rankScore,
      rankBreakdown,
      signalStrength,
      moneyFlow,
    })
  }

  // 按 rankScore 降序排列，平手按配置的 tieBreaker 降序
  results.sort((a, b) => b.rankScore - a.rankScore || getTieBreakerValue(b, rankConfig.tieBreaker) - getTieBreakerValue(a, rankConfig.tieBreaker))

  // 步骤5：持久化
  const dbRows: StockScreenerResultRow[] = results.map(s => ({
    tsCode: s.tsCode,
    tradeDate,
    stockName: s.stockName,
    close: s.close,
    pctChg: s.pctChg,
    turnoverRate: s.turnoverRate,
    vol: s.vol,
    amount: s.amount,
    signalScore: s.signalScore,
    conditionsMet: JSON.stringify(s.conditionsMet),
    concepts: JSON.stringify(s.concepts),
    rankScore: s.rankScore,
    rankBreakdownJson: JSON.stringify(s.rankBreakdown),
    moneyflowJson: s.moneyFlow ? JSON.stringify(s.moneyFlow) : null,
    signalStrengthJson: JSON.stringify(s.signalStrength)
  }))
  upsertResults(db, dbRows)

  return {
    tradeDate,
    calculatedAt: new Date().toISOString(),
    isCached: false,
    mode,
    rtTime,
    totalScanned,
    stocks: results
  }
}
