import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import {
  getPremarketFactSnapshot,
  savePremarketFactSnapshot,
  type SavedPremarketFactSnapshot,
} from '../database/premarketFactSnapshotRepository'
import {
  getPremarketCaptureWindowState,
  getPremarketStageCutoffAt,
} from './premarketCutoffPolicy'
import {
  PREMARKET_GLOBAL_PROVIDER_ID,
  PREMARKET_EXTERNAL_ASSETS,
  fetchPremarketExternalFacts,
  type PremarketFetch,
} from './premarketGlobalFactProvider'
import {
  EXTERNAL_RISK_RULE_VERSION,
  evaluateExternalRiskBreadth,
} from './premarketExternalRiskModel'
import type {
  PremarketFactPayloadV1,
  PremarketSourceRecord,
} from './premarketScenarioTypes'

export const PREMARKET_FACT_RULE_VERSION = 'premarket-facts-v1'

export interface CapturePremarketSnapshotOptions {
  tradeDate: string
  stage: 'overnight' | 'asia_open'
  now?: number
  fetcher?: PremarketFetch
}

export async function capturePremarketFactSnapshot(
  db: Database.Database,
  options: CapturePremarketSnapshotOptions,
): Promise<SavedPremarketFactSnapshot> {
  const existing = getPremarketFactSnapshot(
    db,
    options.tradeDate,
    options.stage,
    PREMARKET_FACT_RULE_VERSION,
  )
  if (existing) return { snapshot: existing, reused: true }

  const now = options.now ?? Date.now()
  const cutoffAt = getPremarketStageCutoffAt(options.tradeDate, options.stage)
  const windowState = getPremarketCaptureWindowState(options.tradeDate, options.stage, now)
  if (windowState === 'early') throw new Error('PREMARKET_CAPTURE_BEFORE_CUTOFF')

  let status: 'ready' | 'partial' | 'blocked' | 'failed'
  let observations: PremarketFactPayloadV1['observations'] = []
  let sources: PremarketSourceRecord[]
  let warnings: string[]

  if (windowState === 'missed') {
    status = 'blocked'
    warnings = ['PREMARKET_CAPTURE_WINDOW_MISSED']
    sources = [{
      sourceId: PREMARKET_GLOBAL_PROVIDER_ID,
      status: 'blocked',
      attemptedAt: now,
      completedAt: now,
      observationCount: 0,
      expectedCount: PREMARKET_EXTERNAL_ASSETS.filter((item) => item.stages.includes(options.stage)).length,
      errorCode: 'CAPTURE_WINDOW_MISSED',
    }]
  } else {
    const result = await fetchPremarketExternalFacts({
      stage: options.stage,
      cutoffAt,
      fetcher: options.fetcher,
      now: () => now,
    })
    status = result.status
    observations = result.observations
    sources = [result.source]
    warnings = result.warnings
  }

  const externalRisk = evaluateExternalRiskBreadth(observations)
  warnings = [...new Set([...warnings, ...externalRisk.warnings])]
  const facts: PremarketFactPayloadV1 = {
    schemaVersion: 1,
    tradeDate: options.tradeDate,
    stage: options.stage,
    cutoffAt,
    observations,
    externalRisk,
  }

  return savePremarketFactSnapshot(db, {
    id: randomUUID(),
    tradeDate: options.tradeDate,
    stage: options.stage,
    status,
    ruleVersion: PREMARKET_FACT_RULE_VERSION,
    cutoffAt,
    capturedAt: now,
    providerId: PREMARKET_GLOBAL_PROVIDER_ID,
    facts,
    sources,
    warnings,
    createdAt: now,
  })
}

export { EXTERNAL_RISK_RULE_VERSION }
