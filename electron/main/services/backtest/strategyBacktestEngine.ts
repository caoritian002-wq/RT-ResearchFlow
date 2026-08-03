/**
 * 策略级回测引擎 - 主编排 + 组合统计（P1）
 *
 * 职责：拉信号（signalSources）→ 逐笔撮合（tradeSimulator）→ 汇总统计 → 写缓存（repository）。
 * 统计部分（aggregateReport）拆为纯函数，便于单测，不依赖 DB。
 *
 * 设计见 strategy-backtest-engine.md §3.4 / §5。
 */

import type Database from 'better-sqlite3'
import { queryDailyClose, queryDailyCloseByDate } from '../../database/dailyCloseCacheRepository'
import { sha256 } from '../../utils/hashUtils'
import { getDataQualitySnapshot } from '../dataQualityService'
import {
  computeParamHash,
  findRunByParamHash,
  markRunFailed,
  saveRun
} from '../../database/strategyBacktestRepository'
import {
  fromAuctionBacktestDetails,
  fromDecisionSignals,
  fromShortTermSignals,
  fromTrendAlerts,
  mergeShortTermSignals
} from './signalSources'
import { simulateTrade } from './tradeSimulator'
import { assessBacktestCredibility } from './credibility'
import {
  STRATEGY_BACKTEST_EQUITY_MODEL,
  STRATEGY_BACKTEST_ENGINE_VERSION,
  STRATEGY_BACKTEST_REPORT_SCHEMA_VERSION
} from './types'
import type {
  BacktestEquityPoint,
  BacktestSignal,
  BacktestSignalSource,
  OHLC,
  StrategyBacktestReport,
  StrategyBacktestProgress,
  StrengthDecileReport,
  TradePlan,
  TradeResult
} from './types'
import type { AssessedBacktestCredibility } from './credibility'

const LEGACY_DEGRADED_TRUST_REASONS = [
  'UNADJUSTED_PRICES', 'TRADING_CALENDAR_NOT_ENFORCED', 'LIMIT_RULES_NOT_ENFORCED',
  'REALIZED_EQUITY_ONLY', 'OVERLAPPING_POSITIONS_NOT_CAPITAL_ALLOCATED', 'SHARPE_NOT_ANNUALIZED'
] as const

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    )
  }
  return value
}

export interface BacktestFactInput {
  signals: BacktestSignal[]
  targetPrices: Array<OHLC & { tsCode: string }>
  benchmarkPrices: Array<OHLC & { tsCode: string }>
}

export function computeBacktestFactFingerprint(input: BacktestFactInput): string {
  const signals = input.signals
    .map(signal => canonicalize(signal))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  const sortPrices = (rows: Array<OHLC & { tsCode: string }>) => rows
    .map(row => canonicalize(row))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  return sha256(JSON.stringify({
    signals,
    targetPrices: sortPrices(input.targetPrices),
    benchmarkPrices: sortPrices(input.benchmarkPrices)
  }))
}

/** 默认交易假设：T+1 开盘入场、持有 1 日、无止盈止损、13bps 单边费用 */
export const DEFAULT_TRADE_PLAN: TradePlan = {
  entryRule: 'nextOpen',
  holdDays: 1,
  stopProfit: null,
  stopLoss: null,
  feeBps: 13
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function summarizeReturns(values: number[]): Omit<StrengthDecileReport, 'bucket' | 'minStrength' | 'maxStrength' | 'count'> {
  if (values.length === 0) {
    return { winRate: null, avgReturn: null, medianReturn: null, profitFactor: null, expectancy: null }
  }
  const wins = values.filter(r => r > 0)
  const losses = values.filter(r => r <= 0)
  const avgReturn = values.reduce((a, b) => a + b, 0) / values.length
  const winRate = wins.length / values.length
  const grossProfit = wins.reduce((a, b) => a + b, 0)
  const grossLossAbs = Math.abs(losses.reduce((a, b) => a + b, 0))
  const profitFactor = grossLossAbs === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLossAbs
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0
  return {
    winRate,
    avgReturn,
    medianReturn: median([...values].sort((a, b) => a - b)),
    profitFactor,
    expectancy: winRate * avgWin + (1 - winRate) * avgLoss
  }
}

export function computeStrengthDeciles(trades: TradeResult[]): StrengthDecileReport[] | null {
  const valid = trades
    .filter(t => t.valid && t.returnPct !== null && Number.isFinite(t.signal.strength))
    .map(t => ({ strength: t.signal.strength as number, returnPct: t.returnPct as number }))
    .sort((a, b) => b.strength - a.strength)
  if (valid.length < 10) return null

  const strengthGroups: Array<{ strength: number; returns: number[] }> = []
  for (const item of valid) {
    const current = strengthGroups[strengthGroups.length - 1]
    if (current && Math.abs(current.strength - item.strength) < 1e-12) {
      current.returns.push(item.returnPct)
    } else {
      strengthGroups.push({ strength: item.strength, returns: [item.returnPct] })
    }
  }

  // 同一强度没有可比较的排序信息，继续拆分只会制造虚假层级。
  if (strengthGroups.length < 2) return null
  const bucketCount = Math.min(5, strengthGroups.length, Math.floor(valid.length / 5))
  if (bucketCount < 2) return null

  const groupedBuckets: Array<Array<{ strength: number; returns: number[] }>> = []
  let cursor = 0
  let remainingSamples = valid.length
  for (let index = 0; index < bucketCount; index += 1) {
    const remainingBuckets = bucketCount - index
    const targetSize = remainingSamples / remainingBuckets
    const currentBucket: Array<{ strength: number; returns: number[] }> = []
    let currentSize = 0

    while (cursor < strengthGroups.length) {
      const group = strengthGroups[cursor]
      const groupsAfterTake = strengthGroups.length - cursor - 1
      const bucketsAfter = remainingBuckets - 1
      if (
        currentBucket.length > 0
        && groupsAfterTake >= bucketsAfter
        && Math.abs(currentSize - targetSize) <= Math.abs(currentSize + group.returns.length - targetSize)
      ) {
        break
      }
      currentBucket.push(group)
      currentSize += group.returns.length
      cursor += 1
      if (groupsAfterTake === bucketsAfter) break
    }

    groupedBuckets.push(currentBucket)
    remainingSamples -= currentSize
  }

  const buckets: StrengthDecileReport[] = []
  for (let index = 0; index < groupedBuckets.length; index += 1) {
    const groups = groupedBuckets[index]
    if (groups.length === 0) continue
    const returns = groups.flatMap(group => group.returns)
    buckets.push({
      bucket: index + 1,
      minStrength: groups[groups.length - 1].strength,
      maxStrength: groups[0].strength,
      count: returns.length,
      ...summarizeReturns(returns)
    })
  }
  return buckets.length > 0 ? buckets : null
}

export interface RealizedEquitySummary {
  totalReturn: number | null
  equityCurve: BacktestEquityPoint[] | null
  maxDrawdown: number | null
}

export function computeRealizedEquity(trades: TradeResult[]): RealizedEquitySummary {
  const returnsByExitDate = new Map<string, number[]>()
  for (const trade of trades) {
    if (!trade.valid || trade.status !== 'executed' || !trade.exitDate || !Number.isFinite(trade.netReturnPct)) continue
    const returns = returnsByExitDate.get(trade.exitDate) ?? []
    returns.push(trade.netReturnPct as number)
    returnsByExitDate.set(trade.exitDate, returns)
  }
  if (returnsByExitDate.size === 0) {
    return { totalReturn: null, equityCurve: null, maxDrawdown: null }
  }

  let equity = 1
  let peakEquity = 1
  let maxDrawdown = 0
  const equityCurve = [...returnsByExitDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, returns]) => {
      const realizedReturnPct = returns.reduce((sum, value) => sum + value, 0) / returns.length
      equity *= 1 + realizedReturnPct / 100
      peakEquity = Math.max(peakEquity, equity)
      const drawdownPct = peakEquity > 0 ? (peakEquity - equity) / peakEquity * 100 : 0
      maxDrawdown = Math.max(maxDrawdown, drawdownPct)
      return {
        date,
        realizedReturnPct,
        tradeCount: returns.length,
        equity,
        drawdownPct
      }
    })

  return {
    totalReturn: (equity - 1) * 100,
    equityCurve,
    maxDrawdown
  }
}

/**
 * 组合统计——纯函数。输入全部撮合结果（含剔除笔），输出报告。
 * 仅 valid 笔参与收益统计；剔除笔只用于计 dropRate。
 */
export function aggregateReport(
  strategyKey: string,
  dateRange: { start: string; end: string },
  plan: TradePlan,
  trades: TradeResult[],
  options: {
    signalSource?: BacktestSignalSource
    benchmarkReturn?: number | null
    benchmarkNote?: string | null
    engineVersion?: string
    factFingerprint?: string
    generatedAt?: number
    credibility?: AssessedBacktestCredibility
  } = {}
): StrategyBacktestReport {
  const totalSignals = trades.length
  const valid = trades.filter(t => t.valid && t.returnPct !== null) as Array<
    TradeResult & { returnPct: number }
  >
  const validTrades = valid.length
  const dropRate = totalSignals > 0 ? (totalSignals - validTrades) / totalSignals : 0

  if (validTrades === 0) {
    return {
      schemaVersion: STRATEGY_BACKTEST_REPORT_SCHEMA_VERSION,
      generatedAt: options.generatedAt ?? Date.now(),
      trust: {
        status: 'blocked',
        reasons: [totalSignals === 0 ? 'NO_SIGNALS' : 'NO_VALID_TRADES'],
        engineVersion: options.engineVersion ?? STRATEGY_BACKTEST_ENGINE_VERSION,
        factFingerprint: options.factFingerprint ?? '',
        credibility: options.credibility?.assessment,
      },
      strategyKey,
      signalSource: options.signalSource ?? 'shortTerm',
      dateRange,
      plan,
      totalSignals,
      validTrades: 0,
      dropRate: totalSignals === 0 ? null : dropRate,
      winRate: null,
      avgReturn: null,
      medianReturn: null,
      profitFactor: null,
      expectancy: null,
      equityModel: STRATEGY_BACKTEST_EQUITY_MODEL,
      totalReturn: null,
      equityCurve: null,
      maxDrawdown: null,
      sharpeLike: null,
      byStrengthDecile: null,
      benchmarkReturn: options.benchmarkReturn ?? null,
      excessReturn: null,
      benchmarkNote: options.benchmarkNote ?? null
    }
  }

  const returns = valid.map(t => t.returnPct)
  const wins = returns.filter(r => r > 0)
  const losses = returns.filter(r => r <= 0)

  const sum = returns.reduce((a, b) => a + b, 0)
  const avgReturn = sum / validTrades
  const winRate = wins.length / validTrades

  const grossProfit = wins.reduce((a, b) => a + b, 0)
  const grossLossAbs = Math.abs(losses.reduce((a, b) => a + b, 0))
  const profitFactor = grossLossAbs === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLossAbs

  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0
  const expectancy = winRate * avgWin + (1 - winRate) * avgLoss

  // 标准差 → 粗略夏普
  const variance = returns.reduce((a, r) => a + (r - avgReturn) ** 2, 0) / validTrades
  const std = Math.sqrt(variance)
  const sharpeLike = std === 0 ? 0 : avgReturn / std
  const equitySummary = computeRealizedEquity(valid)

  const sortedReturns = [...returns].sort((a, b) => a - b)

  return {
    schemaVersion: STRATEGY_BACKTEST_REPORT_SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? Date.now(),
    trust: {
      status: options.credibility?.status ?? 'degraded',
      reasons: options.credibility?.reasons ?? [...LEGACY_DEGRADED_TRUST_REASONS],
      engineVersion: options.engineVersion ?? STRATEGY_BACKTEST_ENGINE_VERSION,
      factFingerprint: options.factFingerprint ?? '',
      credibility: options.credibility?.assessment,
    },
    strategyKey,
    signalSource: options.signalSource ?? 'shortTerm',
    dateRange,
    plan,
    totalSignals,
    validTrades,
    dropRate,
    winRate,
    avgReturn,
    medianReturn: median(sortedReturns),
    profitFactor,
    expectancy,
    equityModel: STRATEGY_BACKTEST_EQUITY_MODEL,
    totalReturn: equitySummary.totalReturn,
    equityCurve: equitySummary.equityCurve,
    maxDrawdown: equitySummary.maxDrawdown,
    sharpeLike,
    byStrengthDecile: computeStrengthDeciles(trades),
    benchmarkReturn: options.benchmarkReturn ?? null,
    excessReturn: options.benchmarkReturn == null ? null : avgReturn - options.benchmarkReturn,
    benchmarkNote: options.benchmarkNote ?? null
  }
}

function selectSignals(db: Database.Database, signalSource: BacktestSignalSource, strategyKey: string, start: string, end: string): BacktestSignal[] {
  if (signalSource === 'trendAlerts') return fromTrendAlerts(db, strategyKey, start, end)
  if (signalSource === 'decisionSignals') return fromDecisionSignals(db, strategyKey, start, end)
  if (strategyKey.startsWith('auction.')) return fromAuctionBacktestDetails(db, strategyKey, start, end)
  if (strategyKey === 'shortTerm.*') {
    return mergeShortTermSignals([
      ...fromShortTermSignals(db, strategyKey, start, end),
      ...fromAuctionBacktestDetails(db, strategyKey, start, end)
    ])
  }
  return fromShortTermSignals(db, strategyKey, start, end)
}

type ProgressReporter = (progress: StrategyBacktestProgress) => void

function emitProgress(onProgress: ProgressReporter | undefined, progress: StrategyBacktestProgress): void {
  onProgress?.(progress)
}

function computeBenchmarkReturn(
  db: Database.Database,
  trades: TradeResult[],
  plan: TradePlan,
  onProgress?: ProgressReporter
): { value: number | null; note: string | null; factRows: Array<OHLC & { tsCode: string }> } {
  const valid = trades.filter(t => t.valid && t.entryDate && t.exitDate)
  if (valid.length === 0) return { value: null, note: '无有效成交, 无法计算基准', factRows: [] }
  const benchmarkReturns: number[] = []
  const cache = new Map<string, Array<OHLC & { tsCode: string }>>()
  const factRows = new Map<string, OHLC & { tsCode: string }>()

  for (let index = 0; index < valid.length; index += 1) {
    const trade = valid[index]
    if (index === 0 || (index + 1) % 20 === 0 || index === valid.length - 1) {
      emitProgress(onProgress, { stage: 'benchmark', current: index + 1, total: valid.length, message: `计算本地等权基准 ${index + 1}/${valid.length}` })
    }
    const entryDate = trade.entryDate as string
    const exitDate = trade.exitDate as string
    if (!cache.has(entryDate)) {
      cache.set(entryDate, queryDailyCloseByDate(db, entryDate).map(row => ({
        tsCode: row.tsCode,
        tradeDate: row.tradeDate,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close
      })))
    }
    const rows = cache.get(entryDate) ?? []
    const returns: number[] = []
    for (const row of rows) {
      const entryPrice = plan.entryRule === 'signalClose' ? row.close : row.open
      if (!Number.isFinite(entryPrice) || !entryPrice) continue
      if (entryDate === exitDate) {
        returns.push((row.close - entryPrice) / entryPrice * 100)
        factRows.set(`${row.tsCode}|${row.tradeDate}`, row)
        continue
      }
      const exitRow = queryDailyClose(db, [row.tsCode], exitDate).get(row.tsCode)?.find(item => item.tradeDate === exitDate)
      if (!exitRow) continue
      returns.push((exitRow.close - entryPrice) / entryPrice * 100)
      factRows.set(`${row.tsCode}|${row.tradeDate}`, row)
      factRows.set(`${row.tsCode}|${exitRow.tradeDate}`, {
        tsCode: row.tsCode,
        tradeDate: exitRow.tradeDate,
        open: exitRow.open,
        high: exitRow.high,
        low: exitRow.low,
        close: exitRow.close
      })
    }
    if (returns.length > 0) benchmarkReturns.push(returns.reduce((a, b) => a + b, 0) / returns.length)
  }

  if (benchmarkReturns.length === 0) {
    return { value: null, note: '本地日线不足, 无法计算同期等权基准', factRows: [] }
  }
  return {
    value: benchmarkReturns.reduce((a, b) => a + b, 0) / benchmarkReturns.length,
    note: benchmarkReturns.length < valid.length ? '部分成交日基准样本不足, 已按可用样本计算' : null,
    factRows: [...factRows.values()]
  }
}

/**
 * 对给定信号集执行撮合（纯逻辑，不查 DB）。
 * priceByStock：Map<tsCode, 升序 OHLC[]>。
 */
export function runTrades(
  signals: BacktestSignal[],
  plan: TradePlan,
  priceByStock: Map<string, OHLC[]>
): TradeResult[] {
  return signals.map(sig => simulateTrade(sig, plan, priceByStock.get(sig.tsCode) ?? []))
}

export interface RunBacktestParams {
  signalSource?: BacktestSignalSource
  strategyKey: string
  dateStart: string
  dateEnd: string
  plan?: TradePlan
  /** true 时即使命中缓存也强制重算（默认 false，命中即复用） */
  force?: boolean
  onProgress?: ProgressReporter
}

export interface RunBacktestResult {
  runId: number
  report: StrategyBacktestReport
  cached: boolean
}

/**
 * 主入口：执行一次策略回测并落库。
 * 命中 param_hash 缓存且非 force 时直接返回缓存报告。
 *
 */
export function runStrategyBacktest(
  db: Database.Database,
  params: RunBacktestParams
): RunBacktestResult {
  const plan = params.plan ?? DEFAULT_TRADE_PLAN
  const signalSource = params.signalSource ?? 'shortTerm'
  let paramHash: string | null = null
  let dataQualityFingerprint = 'UNRESOLVED_QUALITY'

  try {
    // 1) 拉信号
    emitProgress(params.onProgress, { stage: 'signals', current: 0, total: 1, message: '读取回测信号' })
    const signals = selectSignals(db, signalSource, params.strategyKey, params.dateStart, params.dateEnd)
    emitProgress(params.onProgress, { stage: 'signals', current: signals.length, total: signals.length, message: `读取回测信号 ${signals.length} 条` })

    // 2) 取相关股票的日线序列（含 dateEnd 之后的行，用于完成持有期出场）
    const tsCodes = Array.from(new Set(signals.map(s => s.tsCode)))
    emitProgress(params.onProgress, { stage: 'prices', current: 0, total: tsCodes.length, message: `加载日线缓存 ${tsCodes.length} 只股票` })
    const priceMap = queryDailyClose(db, tsCodes, params.dateStart)
    const priceByStock = new Map<string, OHLC[]>()
    const targetPriceRows: Array<OHLC & { tsCode: string }> = []
    let loadedPrices = 0
    for (const [code, rows] of priceMap) {
      loadedPrices += 1
      const prices = rows.map(r => ({
          tradeDate: r.tradeDate,
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close
        }))
      priceByStock.set(code, prices)
      targetPriceRows.push(...prices.map(row => ({ ...row, tsCode: code })))
      if (loadedPrices === 1 || loadedPrices % 50 === 0 || loadedPrices === priceMap.size) {
        emitProgress(params.onProgress, { stage: 'prices', current: loadedPrices, total: tsCodes.length, message: `加载日线缓存 ${loadedPrices}/${tsCodes.length}` })
      }
    }

    // 3) 逐笔撮合
    const trades: TradeResult[] = []
    for (let index = 0; index < signals.length; index += 1) {
      trades.push(simulateTrade(signals[index], plan, priceByStock.get(signals[index].tsCode) ?? []))
      if (index === 0 || (index + 1) % 20 === 0 || index === signals.length - 1) {
        emitProgress(params.onProgress, { stage: 'trades', current: index + 1, total: signals.length, message: `撮合交易 ${index + 1}/${signals.length}` })
      }
    }

    // 4) 统计
    const benchmark = computeBenchmarkReturn(db, trades, plan, params.onProgress)
    const credibility = assessBacktestCredibility({
      dataQuality: getDataQualitySnapshot(db),
      observations: trades.map(trade => ({
        signalDate: trade.signal.tradeDate,
        entryDate: trade.entryDate,
        exitDate: trade.exitDate,
        returnPct: trade.returnPct,
        valid: trade.valid,
        entryBasis: plan.entryRule,
      })),
      strategyCount: 1,
      executionProfile: 'historical',
    })
    dataQualityFingerprint = credibility.assessment.dataQualityFingerprint
    const factFingerprint = computeBacktestFactFingerprint({
      signals,
      targetPrices: targetPriceRows,
      benchmarkPrices: benchmark.factRows
    })
    paramHash = computeParamHash(
      params.strategyKey,
      params.dateStart,
      params.dateEnd,
      plan,
      signalSource,
      STRATEGY_BACKTEST_ENGINE_VERSION,
      factFingerprint,
      dataQualityFingerprint
    )

    if (!params.force) {
      emitProgress(params.onProgress, { stage: 'cache', current: 0, total: 1, message: '检查当前事实回测缓存' })
      const hit = findRunByParamHash(
        db,
        paramHash,
        STRATEGY_BACKTEST_ENGINE_VERSION,
        factFingerprint,
        dataQualityFingerprint
      )
      if (hit) {
        emitProgress(params.onProgress, { stage: 'done', current: 1, total: 1, message: '已复用当前事实回测结果' })
        return { runId: hit.id, report: hit.report, cached: true }
      }
    }

    const report = aggregateReport(
      params.strategyKey,
      { start: params.dateStart, end: params.dateEnd },
      plan,
      trades,
      {
        signalSource,
        benchmarkReturn: benchmark.value,
        benchmarkNote: benchmark.note,
        engineVersion: STRATEGY_BACKTEST_ENGINE_VERSION,
        factFingerprint,
        credibility,
      }
    )

    // 5) 落库
    emitProgress(params.onProgress, { stage: 'save', current: 0, total: 1, message: '写入回测结果' })
    const runId = saveRun(db, {
      strategyKey: params.strategyKey,
      signalSource,
      dateStart: params.dateStart,
      dateEnd: params.dateEnd,
      plan,
      paramHash,
      report,
      trades
    })
    emitProgress(params.onProgress, { stage: 'done', current: 1, total: 1, message: '回测完成' })

    return { runId, report, cached: false }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    emitProgress(params.onProgress, { stage: 'failed', current: 0, total: 1, message })
    const failureHash = paramHash ?? computeParamHash(
      params.strategyKey,
      params.dateStart,
      params.dateEnd,
      plan,
      signalSource,
      STRATEGY_BACKTEST_ENGINE_VERSION,
      'UNRESOLVED_FACTS',
      dataQualityFingerprint
    )
    markRunFailed(db, {
      strategyKey: params.strategyKey,
      signalSource,
      dateStart: params.dateStart,
      dateEnd: params.dateEnd,
      plan,
      paramHash: failureHash,
      errorMessage: message
    })
    throw err
  }
}
