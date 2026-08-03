import type Database from 'better-sqlite3'
import type { MinuteBarForCondition } from '../conditionBlocks/types'

export type MinuteDataGranularity = '1m' | '5m'
export type MinuteDataSource = 'localFree' | 'userProvided' | 'cloudFree' | 'cloudPro'
export type MinuteDataCoverage = 'allMarket' | 'selectedOnly' | 'unknown'
export type MinuteDataReliability = 'realtime' | 'cached' | 'approximate'
export type MinuteUserTier = 'free' | 'pro'
export type MinuteDataPurpose = 'conditionBlocks' | 'chart' | 'backtest'

export interface MinuteDataCapability {
  providerId: string
  label: string
  source: MinuteDataSource
  granularity: MinuteDataGranularity
  historyDepthDays: number | null
  coverage: MinuteDataCoverage
  reliability: MinuteDataReliability
  isApproximate: boolean
  requiresCredential: boolean
  isCloud: boolean
  enabled: boolean
  note: string
}

export interface MinuteDataRequest {
  db: Database.Database
  tsCode: string
  tradeDate: string
  userTier?: MinuteUserTier
  purpose?: MinuteDataPurpose
  preferredGranularity?: MinuteDataGranularity
  allowApproximate?: boolean
}

export interface MinuteDataResult {
  status: 'success' | 'empty' | 'failed' | 'unavailable'
  bars: MinuteBarForCondition[]
  capability: MinuteDataCapability
  message?: string
  coverageStatus?: 'complete' | 'partial' | 'empty' | 'unavailable'
  qualityNote?: string
}

export interface MinuteDataUnifiedRequest {
  db: Database.Database
  tsCode: string
  tradeDate: string
  userTier: MinuteUserTier
  purpose: MinuteDataPurpose
  preferredGranularity?: MinuteDataGranularity
  allowApproximate?: boolean
}

export interface MinuteDataProvider {
  capability: MinuteDataCapability
  fetchBars(request: MinuteDataRequest): Promise<MinuteDataResult>
}

export interface MinuteProviderUsageStats {
  minuteUserTier?: MinuteUserTier
  minuteDataProviderId: string
  minuteDataProviderLabel: string
  minuteGranularity: MinuteDataGranularity
  minuteDataSource: MinuteDataSource
  minuteDataApproximate: boolean
  minuteExactEvaluatedStocks: number
  minuteApproxEvaluatedStocks: number
  minuteDataQualityNote: string
}