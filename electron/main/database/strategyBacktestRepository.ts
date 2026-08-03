/**
 * 策略级回测引擎 - 运行记录仓库（P1）
 *
 * strategy_backtest_runs：缓存回测报告，param_hash 命中即复用，避免重复计算。
 * strategy_backtest_trades：单笔明细，支撑 UI 下钻与调试，随 run 级联清理。
 *
 * 设计见 strategy-backtest-engine.md §4。
 */

import type Database from 'better-sqlite3'
import { sha256 } from '../utils/hashUtils'
import {
  STRATEGY_BACKTEST_EQUITY_MODEL,
  STRATEGY_BACKTEST_REPORT_SCHEMA_VERSION
} from '../services/backtest/types'
import type {
  BacktestSignalSource,
  BacktestTrustStatus,
  StrategyBacktestReport,
  TradePlan,
  TradeResult
} from '../services/backtest/types'
import type { StrategyBacktestRunRow, StrategyBacktestTradeRow } from './types'

export interface BacktestRunSummary {
  id: number
  strategyKey: string
  signalSource?: BacktestSignalSource
  dateStart: string
  dateEnd: string
  plan: TradePlan
  status: StrategyBacktestRunRow['status']
  trustStatus: BacktestTrustStatus
  errorMessage: string | null
  createdAt: number
}

/** (策略 + 区间 + 交易假设) 的确定性指纹——相同输入复用同一 run */
export function computeParamHash(
  strategyKey: string,
  dateStart: string,
  dateEnd: string,
  plan: TradePlan,
  signalSource: BacktestSignalSource = 'shortTerm',
  engineVersion: string,
  factFingerprint: string,
  dataQualityFingerprint = ''
): string {
  // 规范化 plan 字段顺序，保证序列化稳定
  const planCanonical = JSON.stringify({
    entryRule: plan.entryRule,
    holdDays: plan.holdDays,
    stopProfit: plan.stopProfit ?? plan.takeProfitPct ?? null,
    stopLoss: plan.stopLoss ?? plan.stopLossPct ?? null,
    feeBps: plan.feeBps
  })
  return sha256(`${signalSource}|${strategyKey}|${dateStart}|${dateEnd}|${planCanonical}|${engineVersion}|${factFingerprint}|${dataQualityFingerprint}`)
}

function isCurrentReport(
  value: unknown,
  engineVersion: string,
  factFingerprint: string,
  dataQualityFingerprint: string
): value is StrategyBacktestReport {
  if (!value || typeof value !== 'object') return false
  const report = value as Partial<StrategyBacktestReport>
  return report.schemaVersion === STRATEGY_BACKTEST_REPORT_SCHEMA_VERSION
    && report.trust?.engineVersion === engineVersion
    && report.trust?.factFingerprint === factFingerprint
    && report.trust?.credibility?.dataQualityFingerprint === dataQualityFingerprint
}

export function parseStoredBacktestReport(reportJson: string): StrategyBacktestReport | null {
  try {
    const parsed = JSON.parse(reportJson) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.schemaVersion === STRATEGY_BACKTEST_REPORT_SCHEMA_VERSION && parsed.trust) {
      return parsed as unknown as StrategyBacktestReport
    }
    const legacySchemaVersion = parsed.schemaVersion === 3 ? 3 : parsed.schemaVersion === 2 ? 2 : 1
    return {
      ...parsed,
      schemaVersion: legacySchemaVersion,
      generatedAt: typeof parsed.generatedAt === 'number' ? parsed.generatedAt : 0,
      equityModel: STRATEGY_BACKTEST_EQUITY_MODEL,
      totalReturn: null,
      equityCurve: null,
      maxDrawdown: null,
      trust: {
        status: 'degraded',
        reasons: ['LEGACY_REPORT'],
        engineVersion: 'legacy',
        factFingerprint: ''
      }
    } as unknown as StrategyBacktestReport
  } catch {
    return null
  }
}

/** 按 param_hash 查已有 run；命中返回 { id, report }，否则 null */
export function findRunByParamHash(
  db: Database.Database,
  paramHash: string,
  engineVersion: string,
  factFingerprint: string,
  dataQualityFingerprint = ''
): { id: number; report: StrategyBacktestReport } | null {
  const row = db
    .prepare("SELECT id, report_json FROM strategy_backtest_runs WHERE param_hash = ? AND status = 'completed'")
    .get(paramHash) as { id: number; report_json: string } | undefined
  if (!row) return null
  const report = parseStoredBacktestReport(row.report_json)
  return report && isCurrentReport(report, engineVersion, factFingerprint, dataQualityFingerprint)
    ? { id: row.id, report }
    : null
}

/**
 * 写入一次回测运行 + 其单笔明细（同一事务）。
 * 若 param_hash 已存在则先删除旧 run 及其 trades 再写（覆盖语义）。
 * 返回新 run 的自增 id。
 */
export function saveRun(
  db: Database.Database,
  params: {
    strategyKey: string
    signalSource?: BacktestSignalSource
    dateStart: string
    dateEnd: string
    plan: TradePlan
    paramHash: string
    report: StrategyBacktestReport
    trades: TradeResult[]
  }
): number {
  const tx = db.transaction(() => {
    const existing = db
      .prepare('SELECT id FROM strategy_backtest_runs WHERE param_hash = ?')
      .get(params.paramHash) as { id: number } | undefined
    if (existing) {
      db.prepare('DELETE FROM strategy_backtest_trades WHERE run_id = ?').run(existing.id)
      db.prepare('DELETE FROM strategy_backtest_runs WHERE id = ?').run(existing.id)
    }

    const info = db
      .prepare(
          `INSERT INTO strategy_backtest_runs
            (strategy_key, date_start, date_end, plan_json, param_hash, report_json, status, error_message, created_at, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, 'completed', NULL, ?, ?)`
      )
      .run(
        params.strategyKey,
        params.dateStart,
        params.dateEnd,
        JSON.stringify({ ...params.plan, signalSource: params.signalSource ?? params.report.signalSource ?? 'shortTerm' }),
        params.paramHash,
        JSON.stringify(params.report),
        Date.now(),
        Date.now()
      )
    const runId = info.lastInsertRowid as number

    const stmt = db.prepare(
      `INSERT OR REPLACE INTO strategy_backtest_trades
         (run_id, strategy_key, ts_code, signal_date, entry_date, entry_price, exit_date, exit_price,
          gross_return_pct, net_return_pct, return_pct, exit_reason, status, strength, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const t of params.trades) {
      stmt.run(
        runId,
        t.signal.strategyKey,
        t.signal.tsCode,
        t.signal.tradeDate,
        t.entryDate,
        t.entryPrice,
        t.exitDate,
        t.exitPrice,
        t.grossReturnPct,
        t.netReturnPct,
        t.returnPct,
        t.exitReason,
        t.status,
        t.signal.strength,
        t.signal.meta ? JSON.stringify(t.signal.meta) : null
      )
    }
    return runId
  })
  return tx()
}

function mapRunRow(row: Record<string, unknown>): StrategyBacktestRunRow {
  return {
    id: row.id as number,
    strategyKey: row.strategy_key as string,
    dateStart: row.date_start as string,
    dateEnd: row.date_end as string,
    planJson: row.plan_json as string,
    paramHash: row.param_hash as string,
    reportJson: row.report_json as string,
    status: row.status as StrategyBacktestRunRow['status'],
    errorMessage: (row.error_message as string | null) ?? null,
    createdAt: row.created_at as number,
    completedAt: (row.completed_at as number | null) ?? null
  }
}

function mapTradeRow(row: Record<string, unknown>): StrategyBacktestTradeRow {
  const metaJson = (row.meta_json as string | null) ?? null
  let stockName = (row.stock_name as string | null) ?? null
  if (!stockName && metaJson) {
    try {
      const meta = JSON.parse(metaJson) as { stockName?: unknown }
      if (typeof meta.stockName === 'string' && meta.stockName.trim()) stockName = meta.stockName.trim()
    } catch {
      // ignore invalid meta json from old runs
    }
  }
  return {
    runId: row.run_id as number,
    strategyKey: row.strategy_key as string,
    tsCode: row.ts_code as string,
    stockName,
    signalDate: row.signal_date as string,
    entryDate: (row.entry_date as string | null) ?? null,
    entryPrice: (row.entry_price as number | null) ?? null,
    exitDate: (row.exit_date as string | null) ?? null,
    exitPrice: (row.exit_price as number | null) ?? null,
    grossReturnPct: (row.gross_return_pct as number | null) ?? null,
    netReturnPct: (row.net_return_pct as number | null) ?? null,
    returnPct: (row.return_pct as number | null) ?? null,
    exitReason: (row.exit_reason as string | null) ?? null,
    status: row.status as StrategyBacktestTradeRow['status'],
    strength: (row.strength as number | null) ?? null,
    metaJson
  }
}

export function getRun(db: Database.Database, runId: number): StrategyBacktestRunRow | null {
  const row = db.prepare('SELECT * FROM strategy_backtest_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined
  return row ? mapRunRow(row) : null
}

export function getTrades(db: Database.Database, runId: number): StrategyBacktestTradeRow[] {
  const rows = db
    .prepare(`
      SELECT t.*, si.stockName AS stock_name
      FROM strategy_backtest_trades t
      LEFT JOIN stock_info si
        ON si.stockCode = replace(replace(replace(t.ts_code, '.SH', ''), '.SZ', ''), '.BJ', '')
      WHERE t.run_id = ?
      ORDER BY t.signal_date ASC, t.ts_code ASC
    `)
    .all(runId) as Record<string, unknown>[]
  return rows.map(mapTradeRow)
}

/** Delete one saved run and all of its trade details as a single transaction. */
export function deleteRun(db: Database.Database, runId: number): boolean {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM strategy_backtest_trades WHERE run_id = ?').run(runId)
    return db.prepare('DELETE FROM strategy_backtest_runs WHERE id = ?').run(runId).changes > 0
  })
  return tx()
}

export function markRunFailed(db: Database.Database, params: {
  strategyKey: string
  signalSource?: BacktestSignalSource
  dateStart: string
  dateEnd: string
  plan: TradePlan
  paramHash: string
  errorMessage: string
}): number {
  const tx = db.transaction(() => {
    const existing = db
      .prepare('SELECT id, status FROM strategy_backtest_runs WHERE param_hash = ?')
      .get(params.paramHash) as { id: number; status: StrategyBacktestRunRow['status'] } | undefined
    if (existing?.status === 'completed') return existing.id
    if (existing) {
      db.prepare(
        `UPDATE strategy_backtest_runs
         SET error_message = ?, created_at = ?, completed_at = ?
         WHERE id = ?`
      ).run(params.errorMessage, Date.now(), Date.now(), existing.id)
      return existing.id
    }

    const info = db
      .prepare(
        `INSERT INTO strategy_backtest_runs
           (strategy_key, date_start, date_end, plan_json, param_hash, report_json, status, error_message, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?)`
      )
      .run(
        params.strategyKey,
        params.dateStart,
        params.dateEnd,
        JSON.stringify({ ...params.plan, signalSource: params.signalSource ?? 'shortTerm' }),
        params.paramHash,
        '{}',
        params.errorMessage,
        Date.now(),
        Date.now()
      )
    return info.lastInsertRowid as number
  })
  return tx()
}

export function listRuns(db: Database.Database, strategyKey?: string, signalSource?: BacktestSignalSource): BacktestRunSummary[] {
  const params: unknown[] = []
  const where: string[] = []
  if (strategyKey) {
    where.push('strategy_key = ?')
    params.push(strategyKey)
  }
  const sql = `SELECT id, strategy_key, date_start, date_end, plan_json, report_json, status, error_message, created_at FROM strategy_backtest_runs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`
  const rows = db.prepare(sql).all(...params) as Array<{
    id: number
    strategy_key: string
    date_start: string
    date_end: string
    plan_json: string
    report_json: string
    status: StrategyBacktestRunRow['status']
    error_message: string | null
    created_at: number
  }>

  return rows.map(r => {
    const parsed = JSON.parse(r.plan_json) as TradePlan & { signalSource?: BacktestSignalSource }
    const { signalSource, ...plan } = parsed
    const report = r.status === 'completed' ? parseStoredBacktestReport(r.report_json) : null
    return {
      id: r.id,
      strategyKey: r.strategy_key,
      signalSource: signalSource ?? 'shortTerm',
      dateStart: r.date_start,
      dateEnd: r.date_end,
      plan,
      status: r.status,
      trustStatus: report?.trust.status ?? 'blocked',
      errorMessage: r.error_message ?? null,
      createdAt: r.created_at
    }
  }).filter(row => !signalSource || (row.signalSource ?? 'shortTerm') === signalSource)
}

/** 清理超过 N 个日历日的 run 及其 trades，返回删除的 run 数 */
export function cleanupBacktestRuns(db: Database.Database, days = 180): number {
  const threshold = Date.now() - days * 24 * 60 * 60 * 1000
  const tx = db.transaction(() => {
    const stale = db
      .prepare('SELECT id FROM strategy_backtest_runs WHERE created_at < ?')
      .all(threshold) as Array<{ id: number }>
    const del = db.prepare('DELETE FROM strategy_backtest_trades WHERE run_id = ?')
    for (const s of stale) del.run(s.id)
    db.prepare('DELETE FROM strategy_backtest_runs WHERE created_at < ?').run(threshold)
    return stale.length
  })
  return tx()
}
