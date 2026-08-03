import type { PremarketStage } from './premarketScenarioTypes'
import { getBeijingEpochForYmd } from './marketSettlementPolicy'

export const PREMARKET_CAPTURE_GRACE_MS = 5 * 60 * 1000
export const PREMARKET_AUCTION_CONFIRM_HOUR_BJ = 9
export const PREMARKET_AUCTION_CONFIRM_MINUTE_BJ = 28
export const PREMARKET_AUCTION_EVIDENCE_DEADLINE_HOUR_BJ = 9
export const PREMARKET_AUCTION_EVIDENCE_DEADLINE_MINUTE_BJ = 30

const STAGE_TIME: Record<PremarketStage, readonly [hour: number, minute: number]> = {
  overnight: [7, 30],
  asia_open: [8, 45],
  auction_confirmed: [PREMARKET_AUCTION_CONFIRM_HOUR_BJ, PREMARKET_AUCTION_CONFIRM_MINUTE_BJ],
  after_close: [18, 0],
}

export function getPremarketStageCutoffAt(tradeDate: string, stage: PremarketStage): number {
  const [hour, minute] = STAGE_TIME[stage]
  return getBeijingEpochForYmd(tradeDate, hour, minute)
}

export function getPremarketAuctionEvidenceDeadlineAt(tradeDate: string): number {
  return getBeijingEpochForYmd(
    tradeDate,
    PREMARKET_AUCTION_EVIDENCE_DEADLINE_HOUR_BJ,
    PREMARKET_AUCTION_EVIDENCE_DEADLINE_MINUTE_BJ,
  )
}

export function getPremarketScenarioFactCutoffAt(
  tradeDate: string,
  stage: Extract<PremarketStage, 'asia_open' | 'auction_confirmed'>,
): number {
  return stage === 'auction_confirmed'
    ? getPremarketAuctionEvidenceDeadlineAt(tradeDate)
    : getPremarketStageCutoffAt(tradeDate, stage)
}

export function getPremarketCaptureWindowState(
  tradeDate: string,
  stage: PremarketStage,
  now: number,
): 'early' | 'open' | 'missed' {
  const cutoffAt = getPremarketStageCutoffAt(tradeDate, stage)
  if (now < cutoffAt) return 'early'
  if (now <= cutoffAt + PREMARKET_CAPTURE_GRACE_MS) return 'open'
  return 'missed'
}
