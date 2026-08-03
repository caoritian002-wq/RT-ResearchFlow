import type { WebContents } from 'electron'
import type Database from 'better-sqlite3'
import {
  completeRun,
  createRun,
  failRun,
  getMatch,
  getRun,
  listMatches,
  listRuns,
  markRunBacktest,
} from '../database/strategyLabRepository'
import type { StrategyLabMatchRow, StrategyLabRunRow, StrategyLabStrategySource } from '../database/types'
import { ensureDefaultStrategyLabStrategies, getStrategyLabStrategy, type StrategyLabRunConfig, type StrategyLabStrategyDetail } from './strategyLabService'
import { runScreener, type ScreenerSnapshot } from './stockScreenerService'
import { ensureDefaultConditionTemplates, getConditionTemplate, listConditionMatches, listConditionTemplates } from '../database/conditionBlockRepository'
import { runConditionBlockScan, type ConditionBlockScanMode, type ConditionBlockScanProgress } from './conditionBlocks/blockScanEngine'
import { resolveMinuteUserTier } from './minuteData/minuteDataProviderRegistry'
import { insertSignalsBatch, type ShortTermSignalInsert } from '../database/shortTermSignalsRepository'
import { runStrategyBacktest } from './backtest/strategyBacktestEngine'
import type { TradePlan } from './backtest/types'

export type StrategyLabRunProgressStage = 'prepare' | 'screener' | 'conditionBlocks' | 'save' | 'done' | 'failed' | 'cancelled'

export interface StrategyLabRunProgressEvent {
  runId: number
  strategyId: number
  stage: StrategyLabRunProgressStage
  current: number
  total: number
  message: string
}

export interface StrategyLabRunSummary {
  totalStocks: number
  matchedCount: number
  dateStart: string | null
  dateEnd: string | null
  source: StrategyLabStrategySource
  engine: string
  coverage: Record<string, unknown>
}

let runningController: AbortController | null = null
let runningRunId: number | null = null

function todayYmd(): string {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return now.toISOString().slice(0, 10).replace(/-/g, '')
}

function latestTradeDate(db: Database.Database): string {
  const row = db.prepare('SELECT MAX(trade_date) AS tradeDate FROM daily_close_cache').get() as { tradeDate: string | null } | undefined
  return row?.tradeDate ?? todayYmd()
}

function emit(webContents: WebContents | undefined, event: StrategyLabRunProgressEvent): void {
  webContents?.send('strategyLab:runProgress', event)
}

function parseRunConfig(strategy: StrategyLabStrategyDetail): StrategyLabRunConfig {
  return strategy.runConfig
}

function signalStrategyKey(strategy: StrategyLabStrategyDetail): string {
  return `strategyLab.${strategy.strategyKey}`
}

function normalizeScreenerScore(stock: ScreenerSnapshot['stocks'][number]): number {
  const maxRankScore = stock.rankBreakdown.reduce((sum, item) => sum + Math.max(0, item.weight), 0)
  if (maxRankScore > 0) return Math.min(100, Math.max(0, (stock.rankScore / maxRankScore) * 100))
  return Math.min(100, Math.max(0, (stock.signalScore / 6) * 100))
}

function getEffectiveScreenerMinScore(strategy: StrategyLabStrategyDetail): number {
  const rawMinScore = Number(strategy.ruleDraft.scoring?.minScore)
  if (!Number.isFinite(rawMinScore) || rawMinScore < 1) return 1
  return rawMinScore > 6 ? 1 : rawMinScore
}

function mapScreenerMatches(strategy: StrategyLabStrategyDetail, snapshot: ScreenerSnapshot): Array<{
  strategyId: number
  strategyKey: string
  source: StrategyLabStrategySource
  tsCode: string
  stockName: string | null
  tradeDate: string
  score: number
  signalStrength: number | null
  matchedFrom: string
  evidenceJson: string
  actionJson: string
}> {
  const minScore = getEffectiveScreenerMinScore(strategy)
  return snapshot.stocks
    .filter(stock => stock.signalScore >= minScore)
    .slice(0, 500)
    .map(stock => ({
      strategyId: strategy.id,
      strategyKey: strategy.strategyKey,
      source: strategy.source,
      tsCode: stock.tsCode,
      stockName: stock.stockName,
      tradeDate: snapshot.tradeDate,
      score: normalizeScreenerScore(stock),
      signalStrength: stock.signalScore,
      matchedFrom: 'screener',
      evidenceJson: JSON.stringify({
        rawRankScore: stock.rankScore,
        rawSignalScore: stock.signalScore,
        conditionsMet: stock.conditionsMet,
        concepts: stock.concepts,
        rankBreakdown: stock.rankBreakdown,
        moneyFlow: stock.moneyFlow,
        pctChg: stock.pctChg,
        turnoverRate: stock.turnoverRate,
        close: stock.close,
      }),
      actionJson: JSON.stringify(strategy.actions),
    }))
}

function findConditionTemplateId(db: Database.Database, templateKey: string): number {
  ensureDefaultConditionTemplates(db)
  const templates = listConditionTemplates(db)
  const matched = templates.find(item => item.templateKey === templateKey) ?? templates[0]
  if (!matched) throw new Error('CONDITION_TEMPLATE_NOT_FOUND')
  return matched.id
}

function mapConditionMatches(strategy: StrategyLabStrategyDetail, rows: ReturnType<typeof listConditionMatches>): Array<{
  strategyId: number
  strategyKey: string
  source: StrategyLabStrategySource
  tsCode: string
  stockName: string | null
  tradeDate: string
  score: number
  signalStrength: number | null
  matchedFrom: string
  evidenceJson: string
  actionJson: string
}> {
  const templateSnapshot = strategy.ruleDraft.conditionBlocksProfile?.templateSnapshot ?? null
  const minScore = templateSnapshot?.executionMode === 'score' ? strategy.ruleDraft.scoring.minScore : 0
  return rows
    .filter(row => row.totalScore >= minScore)
    .map(row => ({
      strategyId: strategy.id,
      strategyKey: strategy.strategyKey,
      source: strategy.source,
      tsCode: row.tsCode,
      stockName: row.stockName,
      tradeDate: row.tradeDate,
      score: row.totalScore,
      signalStrength: row.totalScore,
      matchedFrom: `conditionBlock.${row.templateKey}`,
      evidenceJson: JSON.stringify({
        ...parseEvidenceJson(row.evidenceJson),
        strategyVersion: strategy.version,
        templateVersion: templateSnapshot?.version ?? row.templateVersion,
        templateKey: templateSnapshot?.key ?? row.templateKey,
        executionMode: templateSnapshot?.executionMode ?? null,
        templateSnapshot,
      }),
      actionJson: JSON.stringify(strategy.actions),
    }))
}

function parseEvidenceJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { rawEvidence: parsed }
  } catch {
    return { rawEvidence: value }
  }
}

function insertBacktestSignals(db: Database.Database, strategy: StrategyLabStrategyDetail, matches: Array<{ tsCode: string; stockName: string | null; tradeDate: string; score: number; evidenceJson: string }>): number {
  const strategyKey = signalStrategyKey(strategy)
  const rows: ShortTermSignalInsert[] = matches.map(match => ({
    strategy: strategyKey,
    tsCode: match.tsCode,
    name: match.stockName,
    triggerAt: Date.now(),
    tradeDate: match.tradeDate,
    signalStrength: match.score,
    signalMeta: JSON.stringify({
      strategyLabStrategyId: strategy.id,
      strategyLabStrategyKey: strategy.strategyKey,
      evidence: match.evidenceJson,
    }),
  }))
  return insertSignalsBatch(db, rows)
}

async function runScreenerStrategy(db: Database.Database, strategy: StrategyLabStrategyDetail, runId: number, webContents?: WebContents): Promise<{ summary: StrategyLabRunSummary; matches: ReturnType<typeof mapScreenerMatches> }> {
  const runConfig = parseRunConfig(strategy)
  const tradeDate = runConfig.dateEnd ?? latestTradeDate(db)
  emit(webContents, { runId, strategyId: strategy.id, stage: 'screener', current: 1, total: 2, message: '运行个性选股白盒扫描' })
  const snapshot = runScreener(db, tradeDate)
  const matches = mapScreenerMatches(strategy, snapshot)
  const sampleStocks = snapshot.stocks.slice(0, 10).map(stock => ({
    tsCode: stock.tsCode,
    stockName: stock.stockName,
    signalScore: stock.signalScore,
    rankScore: stock.rankScore,
    conditionsMet: stock.conditionsMet,
  }))
  console.info('[StrategyLab:ScreenerRun]', {
    runId,
    strategyId: strategy.id,
    strategyKey: strategy.strategyKey,
    strategyName: strategy.name,
    tradeDate,
    configuredMinScore: strategy.ruleDraft.scoring?.minScore,
    effectiveMinScore: getEffectiveScreenerMinScore(strategy),
    totalScanned: snapshot.totalScanned,
    snapshotStocks: snapshot.stocks.length,
    maxSignalScore: snapshot.stocks.reduce((max, stock) => Math.max(max, stock.signalScore), 0),
    maxRankScore: snapshot.stocks.reduce((max, stock) => Math.max(max, stock.rankScore), 0),
    matchedCount: matches.length,
    sampleStocks,
  })
  return {
    summary: {
      totalStocks: snapshot.totalScanned,
      matchedCount: matches.length,
      dateStart: tradeDate,
      dateEnd: tradeDate,
      source: strategy.source,
      engine: 'screener',
      coverage: { mode: snapshot.mode, rtTime: snapshot.rtTime ?? null },
    },
    matches,
  }
}

async function runConditionStrategy(db: Database.Database, strategy: StrategyLabStrategyDetail, runId: number, controller: AbortController, webContents?: WebContents): Promise<{ summary: StrategyLabRunSummary; matches: ReturnType<typeof mapConditionMatches> }> {
  const runConfig = parseRunConfig(strategy)
  const templateKey = strategy.ruleDraft.conditionBlocksProfile?.templateKey ?? 'intraday_amount_surge_hold'
  const templateId = strategy.ruleDraft.conditionBlocksProfile?.templateId ?? findConditionTemplateId(db, templateKey)
  const templateSnapshot = strategy.ruleDraft.conditionBlocksProfile?.templateSnapshot ?? null
  if (!templateSnapshot) throw new Error('CONDITION_TEMPLATE_SNAPSHOT_REQUIRED')
  const templateRow = getConditionTemplate(db, templateId)
  if (!templateRow) throw new Error('CONDITION_TEMPLATE_NOT_FOUND')
  const scanMode: ConditionBlockScanMode = runConfig.scanMode === 'quick' ? 'quick' : 'complete'
  emit(webContents, { runId, strategyId: strategy.id, stage: 'conditionBlocks', current: 1, total: 3, message: '运行条件积木扫描' })
  const result = await runConditionBlockScan(
    db,
    templateId,
    true,
    (progress: ConditionBlockScanProgress) => {
      emit(webContents, {
        runId,
        strategyId: strategy.id,
        stage: 'conditionBlocks',
        current: progress.current,
        total: progress.total,
        message: progress.message,
      })
    },
    {
      dateStart: runConfig.dateStart ?? undefined,
      dateEnd: runConfig.dateEnd ?? undefined,
      dailyPrefilterLimit: runConfig.dailyPrefilterLimit,
      autoFetchMinuteLimit: runConfig.autoFetchMinuteLimit,
    },
    scanMode,
    resolveMinuteUserTier(runConfig.userTier),
    controller.signal,
    templateSnapshot,
  )
  const conditionMatches = listConditionMatches(db, { runId: result.runId, limit: 500 })
  const matches = mapConditionMatches(strategy, conditionMatches)
  return {
    summary: {
      totalStocks: result.totalStocks,
      matchedCount: matches.length,
      dateStart: result.summary.dateStart,
      dateEnd: result.summary.dateEnd,
      source: strategy.source,
      engine: 'conditionBlocks',
      coverage: {
        ...result.summary,
        strategyVersion: strategy.version,
        templateKey: templateSnapshot.key,
        templateVersion: templateSnapshot.version,
        executionMode: templateSnapshot.executionMode,
        enabledConditionCount: templateSnapshot.root.children.length,
      },
    },
    matches,
  }
}

export async function runStrategyLabStrategy(db: Database.Database, strategyId: number, webContents?: WebContents): Promise<{ runId: number; summary: StrategyLabRunSummary; matchedCount: number }> {
  if (runningController) throw new Error('STRATEGY_LAB_RUN_ALREADY_RUNNING')
  ensureDefaultStrategyLabStrategies(db)
  const strategy = getStrategyLabStrategy(db, strategyId)
  if (!strategy) throw new Error('STRATEGY_NOT_FOUND')
  if (!strategy.enabled || strategy.status === 'disabled') throw new Error('STRATEGY_DISABLED')
  if (strategy.status !== 'ready') throw new Error('STRATEGY_NOT_READY')
  const runConfig = parseRunConfig(strategy)
  const controller = new AbortController()
  const runId = createRun(db, {
    strategyId: strategy.id,
    strategyKey: strategy.strategyKey,
    strategyName: strategy.name,
    source: strategy.source,
    dateStart: runConfig.dateStart ?? null,
    dateEnd: runConfig.dateEnd ?? null,
    runConfigJson: JSON.stringify({
      ...runConfig,
      strategyVersion: strategy.version,
      templateVersion: strategy.ruleDraft.conditionBlocksProfile?.templateVersion ?? null,
      templateSnapshot: strategy.ruleDraft.conditionBlocksProfile?.templateSnapshot ?? null,
    }),
  })
  runningController = controller
  runningRunId = runId
  try {
    emit(webContents, { runId, strategyId: strategy.id, stage: 'prepare', current: 0, total: 1, message: '准备策略实验室运行' })
    const result = strategy.source === 'conditionBlocks'
      ? await runConditionStrategy(db, strategy, runId, controller, webContents)
      : await runScreenerStrategy(db, strategy, runId, webContents)
    emit(webContents, { runId, strategyId: strategy.id, stage: 'save', current: 1, total: 1, message: '保存统一命中结果' })
    completeRun(db, {
      runId,
      summaryJson: JSON.stringify(result.summary),
      matches: result.matches,
    })
    insertBacktestSignals(db, strategy, result.matches)
    emit(webContents, { runId, strategyId: strategy.id, stage: 'done', current: 1, total: 1, message: '策略运行完成' })
    return { runId, summary: result.summary, matchedCount: result.matches.length }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const cancelled = controller.signal.aborted || message.includes('终止') || message.includes('cancel')
    failRun(db, runId, message, cancelled ? 'cancelled' : 'failed')
    emit(webContents, { runId, strategyId: strategy.id, stage: cancelled ? 'cancelled' : 'failed', current: 1, total: 1, message })
    throw err
  } finally {
    if (runningRunId === runId) {
      runningController = null
      runningRunId = null
    }
  }
}

export function cancelStrategyLabRun(db: Database.Database, runId?: number): boolean {
  if (!runningController || !runningRunId) return false
  if (runId && runningRunId !== runId) return false
  runningController.abort()
  failRun(db, runningRunId, '策略实验室运行已取消', 'cancelled')
  return true
}

export function listStrategyLabRuns(db: Database.Database, strategyId?: number, limit?: number): StrategyLabRunRow[] {
  return listRuns(db, strategyId, limit)
}

export function getStrategyLabRun(db: Database.Database, runId: number): StrategyLabRunRow | null {
  return getRun(db, runId)
}

export function listStrategyLabMatches(db: Database.Database, params: Parameters<typeof listMatches>[1] = {}): StrategyLabMatchRow[] {
  return listMatches(db, params)
}

export function getStrategyLabMatchEvidence(db: Database.Database, matchId: number): { match: StrategyLabMatchRow; evidence: unknown; action: unknown } | null {
  const match = getMatch(db, matchId)
  if (!match) return null
  let evidence: unknown = null
  let action: unknown = null
  try { evidence = JSON.parse(match.evidenceJson) } catch { evidence = match.evidenceJson }
  try { action = match.actionJson ? JSON.parse(match.actionJson) : null } catch { action = match.actionJson }
  return { match, evidence, action }
}

export function createBacktestFromStrategyLabRun(db: Database.Database, runId: number, plan?: Partial<TradePlan>): { backtestRunId: number; strategyKey: string } {
  const run = getRun(db, runId)
  if (!run) throw new Error('RUN_NOT_FOUND')
  if (run.status !== 'completed') throw new Error('RUN_NOT_COMPLETED')
  const matches = listMatches(db, { runId, limit: 1 })
  if (matches.length === 0) throw new Error('RUN_HAS_NO_MATCHES')
  const dates = listMatches(db, { runId, limit: 500 }).map(match => match.tradeDate).sort()
  const dateStart = dates[0]
  const dateEnd = dates[dates.length - 1]
  const strategyKey = `strategyLab.${run.strategyKey}`
  const result = runStrategyBacktest(db, {
    signalSource: 'shortTerm',
    strategyKey,
    dateStart,
    dateEnd,
    plan: {
      entryRule: plan?.entryRule === 'signalClose' ? 'signalClose' : 'nextOpen',
      holdDays: Math.max(1, Math.round(Number(plan?.holdDays) || 1)),
      stopProfit: plan?.stopProfit ?? plan?.takeProfitPct ?? null,
      stopLoss: plan?.stopLoss ?? plan?.stopLossPct ?? null,
      feeBps: Math.max(0, Number(plan?.feeBps) || 13),
    },
    force: true,
  })
  markRunBacktest(db, runId, result.runId)
  return { backtestRunId: result.runId, strategyKey }
}
