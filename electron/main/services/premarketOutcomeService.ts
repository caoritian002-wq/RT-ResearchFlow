import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { queryDailyCloseExact } from '../database/dailyCloseCacheRepository'
import {
  getLatestPremarketOutcomeValidation,
  listLatestPremarketOutcomeValidations,
  savePremarketOutcomeValidation,
} from '../database/premarketOutcomeRepository'
import { getPremarketScenarioVersion } from '../database/premarketScenarioVersionRepository'
import type { StockPriceCacheRow } from '../database/types'
import { sha256 } from '../utils/hashUtils'
import { getPremarketStageCutoffAt } from './premarketCutoffPolicy'
import { classifyPremarketOutcome, PREMARKET_OUTCOME_RULE_VERSION } from './premarketOutcomeModel'
import { PREMARKET_SCENARIO_RULE_VERSION } from './premarketScenarioModel'
import type {
  PremarketCalibrationView,
  PremarketOutcomeReadView,
  PremarketOutcomeValidationItem,
  PremarketOutcomeValidationPayloadV1,
  PremarketOutcomeValidationRecord,
  PremarketOutcomeValidationView,
  PremarketScenarioVersion,
} from './premarketRehearsalTypes'
import type { PremarketOutcomeLabel } from './premarketScenarioTypes'

export const PREMARKET_VALIDATION_RULE_VERSION = 'premarket-validation-v1' as const
const OUTCOME_LABELS: PremarketOutcomeLabel[] = [
  'gap_up_fade',
  'gap_up_hold',
  'low_or_flat_rebound',
  'weak_all_day',
  'mixed',
  'insufficient',
]

function toView(record: PremarketOutcomeValidationRecord): PremarketOutcomeValidationView {
  const { sourceFingerprint: _sourceFingerprint, validationSha256: _validationSha256, ...view } = record
  return view
}

function stockPriceRow(
  db: Database.Database,
  tsCode: string,
  tradeDate: string | null,
): StockPriceCacheRow | null {
  if (!tradeDate) return null
  const code = tsCode.split('.')[0] ?? tsCode
  return (db.prepare(`
    SELECT * FROM stock_price_cache
    WHERE stockCode IN (?, ?) AND tradeDate = ?
    ORDER BY CASE WHEN stockCode = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).get(code, tsCode, tradeDate, code) as StockPriceCacheRow | undefined) ?? null
}

function sourceRows(
  db: Database.Database,
  version: PremarketScenarioVersion,
): PremarketOutcomeValidationItem[] {
  const tsCodes = version.evidence.holdings.map((holding) => holding.tsCode)
  const currentDaily = queryDailyCloseExact(db, tsCodes, version.tradeDate)
  const previousDaily = version.evidence.previousTradeDate
    ? queryDailyCloseExact(db, tsCodes, version.evidence.previousTradeDate)
    : new Map()
  const stateByCode = new Map(version.scenario.holdings.map((item) => [item.tsCode, item]))

  return version.evidence.holdings.map((holding) => {
    const currentPrimary = currentDaily.get(holding.tsCode)?.[0] ?? null
    const previousPrimary = previousDaily.get(holding.tsCode)?.[0] ?? null
    const currentFallback = currentPrimary ? null : stockPriceRow(db, holding.tsCode, version.tradeDate)
    const previousFallback = previousPrimary ? null : stockPriceRow(db, holding.tsCode, version.evidence.previousTradeDate)
    const current = currentPrimary ?? currentFallback
    const previous = previousPrimary ?? previousFallback
    const source = currentPrimary && previousPrimary
      ? 'daily_close_cache' as const
      : current && previous
        ? 'stock_price_cache' as const
        : 'missing' as const
    const input = {
      previousClose: previous?.close ?? null,
      open: current?.open ?? null,
      high: current?.high ?? null,
      low: current?.low ?? null,
      close: current?.close ?? null,
    }
    const outcome = classifyPremarketOutcome(input)
    const warnings = [...outcome.warnings]
    if (!previous) warnings.push('PREVIOUS_CLOSE_MISSING')
    if (!current) warnings.push('CURRENT_DAILY_OHLC_MISSING')
    const premarketState = stateByCode.get(holding.tsCode)?.state ?? 'insufficient'
    return {
      tsCode: holding.tsCode,
      stockName: holding.stockName,
      premarketState,
      status: outcome.label === 'insufficient' ? 'missing' : 'matured',
      previousTradeDate: version.evidence.previousTradeDate,
      source,
      input,
      outcome,
      warnings: [...new Set(warnings)],
    }
  })
}

function buildValidation(
  version: PremarketScenarioVersion,
  items: PremarketOutcomeValidationItem[],
  validatedAt: number,
): PremarketOutcomeValidationPayloadV1 {
  const matured = items.filter((item) => item.status === 'matured').length
  const missing = items.length - matured
  const status = items.length > 0 && matured === items.length
    ? 'matured' as const
    : matured > 0
      ? 'partial' as const
      : 'missing' as const
  const outcomeCounts = Object.fromEntries(OUTCOME_LABELS.map((label) => [label, 0])) as Record<PremarketOutcomeLabel, number>
  for (const item of items) outcomeCounts[item.outcome.label] += 1
  const warnings = items.flatMap((item) => item.warnings.map((warning) => `${item.tsCode}:${warning}`)).slice(0, 200)
  if (items.length === 0) warnings.push('SCENARIO_HOLDINGS_EMPTY')
  return {
    schemaVersion: 1,
    ruleVersion: PREMARKET_VALIDATION_RULE_VERSION,
    tradeDate: version.tradeDate,
    scenarioVersionId: version.id,
    scenarioRuleVersion: version.ruleVersion,
    marketState: version.scenario.marketState,
    status,
    validatedAt,
    items,
    counts: { total: items.length, matured, missing },
    coverageRate: items.length > 0 ? Math.round((matured / items.length) * 10_000) / 10_000 : null,
    outcomeCounts,
    warnings,
  }
}

export function runPremarketOutcomeValidation(
  db: Database.Database,
  tradeDate: string,
  now = Date.now(),
): { record: PremarketOutcomeValidationRecord; reused: boolean } | null {
  const version = getPremarketScenarioVersion(
    db,
    tradeDate,
    'auction_confirmed',
    PREMARKET_SCENARIO_RULE_VERSION,
  )
  if (!version) return null
  const items = sourceRows(db, version)
  const validation = buildValidation(version, items, now)
  const sourceFingerprint = sha256(JSON.stringify({
    scenarioVersionId: version.id,
    ruleVersion: PREMARKET_VALIDATION_RULE_VERSION,
    items: items.map((item) => ({
      tsCode: item.tsCode,
      source: item.source,
      previousTradeDate: item.previousTradeDate,
      input: item.input,
    })),
  }))
  return savePremarketOutcomeValidation(db, {
    id: randomUUID(),
    tradeDate,
    scenarioVersionId: version.id,
    status: validation.status,
    sourceFingerprint,
    validation,
    createdAt: now,
  })
}

export function readPremarketOutcome(
  db: Database.Database,
  version: PremarketScenarioVersion,
  now = Date.now(),
): PremarketOutcomeReadView {
  const record = getLatestPremarketOutcomeValidation(db, version.id)
  if (record) {
    return {
      state: 'available',
      message: record.status === 'matured' ? '当日持仓路径已完整验证' : record.status === 'partial' ? '部分持仓路径已验证' : '当日日K事实仍缺失',
      validation: toView(record),
    }
  }
  if (now < getPremarketStageCutoffAt(version.tradeDate, 'after_close')) {
    return { state: 'pending', message: '18:00结算后生成盘后验证', validation: null }
  }
  return { state: 'missing', message: '尚无盘后验证修订，等待18:00协调器或启动补漏', validation: null }
}

export function buildPremarketCalibration(
  db: Database.Database,
  now = Date.now(),
): PremarketCalibrationView {
  const records = listLatestPremarketOutcomeValidations(db, 120)
  const items = records.flatMap((record) => record.validation.items.map((item) => ({
    item,
    marketState: record.validation.marketState,
  }))).slice(0, 5000)
  const matured = items.filter(({ item }) => item.status === 'matured')
  const missing = items.length - matured.length
  const confusion = new Map<string, number>()
  const market = new Map<string, { count: number; closeSum: number; closeCount: number }>()
  for (const { item, marketState } of matured) {
    const confusionKey = `${item.premarketState}|${item.outcome.label}`
    confusion.set(confusionKey, (confusion.get(confusionKey) ?? 0) + 1)
    const marketKey = `${marketState}|${item.outcome.label}`
    const current = market.get(marketKey) ?? { count: 0, closeSum: 0, closeCount: 0 }
    current.count += 1
    if (item.outcome.closeChangePercent != null) {
      current.closeSum += item.outcome.closeChangePercent
      current.closeCount += 1
    }
    market.set(marketKey, current)
  }
  return {
    generatedAt: now,
    rangeTradeDays: 120,
    versionCount: records.length,
    totalSamples: items.length,
    maturedSamples: matured.length,
    missingSamples: missing,
    coverageRate: items.length > 0 ? Math.round((matured.length / items.length) * 10_000) / 10_000 : null,
    confusion: [...confusion.entries()].map(([key, count]) => {
      const [premarketState, outcomeLabel] = key.split('|')
      return { premarketState, outcomeLabel, count } as PremarketCalibrationView['confusion'][number]
    }),
    marketGroups: [...market.entries()].map(([key, value]) => {
      const [marketState, outcomeLabel] = key.split('|')
      return {
        marketState,
        outcomeLabel,
        count: value.count,
        averageCloseChangePercent: value.closeCount > 0
          ? Math.round((value.closeSum / value.closeCount) * 10_000) / 10_000
          : null,
      } as PremarketCalibrationView['marketGroups'][number]
    }),
    probabilityGate: {
      enabled: false,
      reason: 'NO_PROBABILITY_MODEL',
      brierScore: null,
      reliabilityBins: [],
    },
  }
}

export function getLatestOutcomeValidationForScenario(
  db: Database.Database,
  scenarioVersionId: string,
): PremarketOutcomeValidationRecord | null {
  return getLatestPremarketOutcomeValidation(db, scenarioVersionId)
}

export { PREMARKET_OUTCOME_RULE_VERSION }
