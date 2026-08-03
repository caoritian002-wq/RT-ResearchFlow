/**
 * 策略级回测引擎 - 信号源适配器（P1）
 *
 * 把不同表结构的信号归一为 BacktestSignal[]，让回测引擎对信号来源无感。
 * P1 仅实现 short_term_signals 适配器；P3 再补 trend_alerts / decision_signals。
 *
 * 设计见 strategy-backtest-engine.md §3.1。
 */

import type Database from 'better-sqlite3'
import { queryDetails } from '../../database/backtestDetailRepository'
import type { BacktestDetailRow } from '../../database/types'
import type { BacktestSignal } from './types'

const BOARD_AUCTION_POOLS: BacktestDetailRow['pool'][] = [
  'firstBoard',
  'secondBoard',
  'brokenBoard',
  'brokenConsec'
]

const AUCTION_POOLS_BY_STRATEGY: Record<string, BacktestDetailRow['pool'][]> = {
  'auction.threeOne': BOARD_AUCTION_POOLS,
  'auction.firstBoard': ['firstBoard'],
  'auction.secondBoard': ['secondBoard'],
  'auction.brokenBoard': ['brokenBoard'],
  'auction.brokenConsec': ['brokenConsec'],
  'auction.allMarket': ['allMarket'],
  'auction.*': [...BOARD_AUCTION_POOLS, 'allMarket']
}

/**
 * 将 6 位纯数字代码规范为带交易所后缀的形式，对齐 daily_close_cache.ts_code。
 * 已含后缀（带 '.'）则原样返回。无法判定时返回 null（调用方剔除）。
 */
export function toSuffixedTsCode(raw: string | null | undefined): string | null {
  if (!raw) return null
  if (raw.includes('.')) return raw
  if (!/^\d{6}$/.test(raw)) return null
  const p = raw.slice(0, 1)
  const p3 = raw.slice(0, 3)
  if (p3 === '688' || p === '6' || p === '5') return `${raw}.SH`
  if (p === '0' || p === '3' || p3 === '200') return `${raw}.SZ`
  if (p === '4' || p === '8' || p === '9') return `${raw}.BJ`
  return null
}

function safeParseMeta(json: string | null): Record<string, unknown> | undefined {
  if (!json) return undefined
  try {
    const v = JSON.parse(json)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function bjYmdFromEpochMs(value: number | null | undefined): string | null {
  if (!Number.isFinite(value)) return null
  const date = new Date((value as number) + 8 * 60 * 60 * 1000)
  return date.toISOString().slice(0, 10).replace(/-/g, '')
}

function normalizeDecisionStrength(row: { score: number | null; confidence: number | null; priority: number | null }): number {
  if (Number.isFinite(row.score)) return Math.max(0, Math.min(1, (row.score as number) / 100))
  if (Number.isFinite(row.confidence)) {
    const confidence = row.confidence as number
    return confidence > 1 ? Math.max(0, Math.min(1, confidence / 100)) : Math.max(0, Math.min(1, confidence))
  }
  if (Number.isFinite(row.priority)) return Math.max(0, Math.min(1, (row.priority as number) / 5))
  return 1
}

/**
 * 从 short_term_signals 读取指定策略在 [start, end] 区间的信号。
 *
 * @param strategyKey 精确策略键，或 'shortTerm.*' 形式的前缀通配（结尾 '.*'）
 * @param start/end   YYYYMMDD（含端点）
 */
export function fromShortTermSignals(
  db: Database.Database,
  strategyKey: string,
  start: string,
  end: string
): BacktestSignal[] {
  const usesPrefix = strategyKey.endsWith('.*')
  const where = usesPrefix ? 'strategy LIKE ?' : 'strategy = ?'
  const strategyParam = usesPrefix ? strategyKey.slice(0, -1) + '%' : strategyKey

  const rows = db
    .prepare(
      `SELECT strategy, ts_code, signal_strength, signal_meta, trade_date
       FROM short_term_signals
       WHERE ${where}
         AND trade_date IS NOT NULL
         AND trade_date >= ? AND trade_date <= ?
         AND ts_code IS NOT NULL
       ORDER BY trade_date ASC, id ASC`
    )
    .all(strategyParam, start, end) as Array<{
    strategy: string
    ts_code: string | null
    signal_strength: number | null
    signal_meta: string | null
    trade_date: string
  }>

  const out: BacktestSignal[] = []
  for (const r of rows) {
    const tsCode = toSuffixedTsCode(r.ts_code)
    if (!tsCode) continue
    out.push({
      strategyKey: r.strategy,
      tsCode,
      tradeDate: r.trade_date,
      strength: r.signal_strength ?? 1,
      meta: safeParseMeta(r.signal_meta)
    })
  }
  return out
}

function auctionStrategyKey(pool: BacktestDetailRow['pool']): string {
  return `auction.${pool}`
}

/**
 * 将竞价历史明细作为“信号发生事实”接入可配置资金回测。
 * 这里只读取信号日、股票和来源池；入场价、持有期和退出价仍由回测计划与日线重新撮合。
 */
export function fromAuctionBacktestDetails(
  db: Database.Database,
  strategyKey: string,
  start: string,
  end: string
): BacktestSignal[] {
  const selectedPools = strategyKey === 'shortTerm.*'
    ? AUCTION_POOLS_BY_STRATEGY['auction.*']
    : AUCTION_POOLS_BY_STRATEGY[strategyKey]
  if (!selectedPools) return []

  const selected = new Set<BacktestDetailRow['pool']>(selectedPools)
  const grouped = new Map<string, {
    row: BacktestDetailRow
    pools: BacktestDetailRow['pool'][]
  }>()

  for (const row of queryDetails(db, { startDate: start, endDate: end })) {
    if (!selected.has(row.pool)) continue
    const tsCode = toSuffixedTsCode(row.tsCode)
    if (!tsCode) continue
    const key = `${row.tradeDate}:${tsCode}`
    const existing = grouped.get(key)
    if (!existing) {
      grouped.set(key, { row: { ...row, tsCode }, pools: [row.pool] })
      continue
    }
    if (!existing.pools.includes(row.pool)) existing.pools.push(row.pool)
    if (existing.row.pool === 'allMarket' && row.pool !== 'allMarket') {
      existing.row = { ...row, tsCode }
    }
  }

  return [...grouped.values()]
    .sort((left, right) => left.row.tradeDate.localeCompare(right.row.tradeDate) || left.row.tsCode.localeCompare(right.row.tsCode))
    .map(({ row, pools }) => ({
      strategyKey: strategyKey === 'shortTerm.*' || strategyKey === 'auction.*'
        ? auctionStrategyKey(row.pool)
        : strategyKey,
      tsCode: row.tsCode,
      tradeDate: row.tradeDate,
      strength: 1,
      meta: {
        source: 'stk_auction_backtest_detail',
        stockName: row.stockName ?? null,
        pools: [...pools].sort(),
        auctionPrice: row.buyPrice ?? null,
        isOneWord: row.isOneWord === 1,
        computedAt: row.computedAt ?? null
      }
    }))
}

/** “全部短线信号”按同股同日只保留一次，避免同一竞价标的跨池重复买入。 */
export function mergeShortTermSignals(signals: BacktestSignal[]): BacktestSignal[] {
  const merged = new Map<string, BacktestSignal>()
  for (const signal of signals) {
    const key = `${signal.tradeDate}:${signal.tsCode}`
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, signal)
      continue
    }
    const matchedStrategyKeys = [...new Set([
      ...((existing.meta?.matchedStrategyKeys as string[] | undefined) ?? [existing.strategyKey]),
      signal.strategyKey
    ])].sort()
    merged.set(key, {
      ...existing,
      strength: Math.max(existing.strength ?? 0, signal.strength ?? 0) || null,
      meta: { ...existing.meta, matchedStrategyKeys }
    })
  }
  return [...merged.values()].sort((left, right) => left.tradeDate.localeCompare(right.tradeDate) || left.tsCode.localeCompare(right.tsCode))
}

export function fromTrendAlerts(
  db: Database.Database,
  strategyKey: string,
  start: string,
  end: string
): BacktestSignal[] {
  const usesPrefix = strategyKey.endsWith('.*')
  const where = usesPrefix ? 'alert_type LIKE ?' : 'alert_type = ?'
  const strategyParam = usesPrefix ? strategyKey.slice(0, -1) + '%' : strategyKey

  const rows = db
    .prepare(
      `SELECT ts_code, stock_name, alert_type, alert_date, price, ref_price, created_at
       FROM trend_alerts
       WHERE ${where}
         AND alert_date >= ? AND alert_date <= ?
         AND ts_code IS NOT NULL
       ORDER BY alert_date ASC, id ASC`
    )
    .all(strategyParam, start, end) as Array<{
    ts_code: string
    stock_name: string
    alert_type: string
    alert_date: string
    price: number | null
    ref_price: number | null
    created_at: number
  }>

  const out: BacktestSignal[] = []
  for (const row of rows) {
    const tsCode = toSuffixedTsCode(row.ts_code)
    if (!tsCode) continue
    out.push({
      strategyKey: row.alert_type,
      tsCode,
      tradeDate: row.alert_date,
      strength: 1,
      meta: {
        source: 'trend_alerts',
        stockName: row.stock_name,
        alertType: row.alert_type,
        price: row.price,
        refPrice: row.ref_price,
        createdAt: row.created_at
      }
    })
  }
  return out
}

export function fromDecisionSignals(
  db: Database.Database,
  strategyKey: string,
  start: string,
  end: string
): BacktestSignal[] {
  const usesPrefix = strategyKey.endsWith('.*')
  const where = usesPrefix ? 'strategy_key LIKE ?' : 'strategy_key = ?'
  const strategyParam = usesPrefix ? strategyKey.slice(0, -1) + '%' : strategyKey

  const rows = db
    .prepare(
      `SELECT id, source_module, strategy_key, ts_code, stock_name, signal_type, direction,
              priority, score, confidence, title, signal_time, reason_json, source_ref_json
       FROM decision_signals
       WHERE ${where}
         AND ts_code IS NOT NULL
       ORDER BY signal_time ASC, id ASC`
    )
    .all(strategyParam) as Array<{
    id: number
    source_module: string
    strategy_key: string
    ts_code: string | null
    stock_name: string | null
    signal_type: string
    direction: string
    priority: number | null
    score: number | null
    confidence: number | null
    title: string
    signal_time: number
    reason_json: string | null
    source_ref_json: string | null
  }>

  const out: BacktestSignal[] = []
  for (const row of rows) {
    const tradeDate = bjYmdFromEpochMs(row.signal_time)
    if (!tradeDate || tradeDate < start || tradeDate > end) continue
    const tsCode = toSuffixedTsCode(row.ts_code)
    if (!tsCode) continue
    const reason = safeParseMeta(row.reason_json)
    const sourceRef = safeParseMeta(row.source_ref_json)
    out.push({
      strategyKey: row.strategy_key,
      tsCode,
      tradeDate,
      strength: normalizeDecisionStrength({ score: row.score, confidence: row.confidence, priority: row.priority }),
      meta: {
        source: 'decision_signals',
        signalId: row.id,
        stockName: row.stock_name,
        sourceModule: row.source_module,
        signalType: row.signal_type,
        direction: row.direction,
        priority: row.priority,
        score: row.score,
        confidence: row.confidence,
        title: row.title,
        signalTime: row.signal_time,
        reason,
        sourceRef
      }
    })
  }
  return out
}
