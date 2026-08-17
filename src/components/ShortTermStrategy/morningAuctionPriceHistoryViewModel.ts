export type MorningAuctionPriceHistoryState = 'ready' | 'partial' | 'insufficient' | 'unavailable' | 'failed'

export type MorningAuctionPriceHistoryReason =
  | 'LOCAL_READY'
  | 'REMOTE_BACKFILLED'
  | 'SAMPLE_INSUFFICIENT'
  | 'NO_HISTORY_DATA'
  | 'REMOTE_BACKFILL_FAILED'
  | 'LOCAL_READ_FAILED'

export interface MorningAuctionPriceHistoryStatus {
  state: MorningAuctionPriceHistoryState
  availableDays: number
  reason: MorningAuctionPriceHistoryReason
  remoteAttempted: boolean
}

export interface MorningAuctionPriceHistoryCoverage {
  requestedCount: number
  covered3dCount: number
  covered5dCount: number
  readyCount: number
  partialCount: number
  insufficientCount: number
  unavailableCount: number
  failedCount: number
  updatedAt: number
}

export interface MorningAuctionPriceHistoryMissingDisplay {
  label: string
  title: string
  tone: 'muted' | 'warning' | 'danger'
}

export function getMorningAuctionPriceHistoryMissingDisplay(
  status: MorningAuctionPriceHistoryStatus | undefined,
  days: 3 | 5,
): MorningAuctionPriceHistoryMissingDisplay {
  if (!status) {
    return {
      label: '待补齐',
      title: '当前主进程尚未返回历史涨跌状态，可点击立即刷新重试。',
      tone: 'muted',
    }
  }
  if (status.reason === 'LOCAL_READ_FAILED') {
    return {
      label: '读取失败',
      title: '本地日K读取失败，可点击立即刷新重试。',
      tone: 'danger',
    }
  }
  if (status.reason === 'REMOTE_BACKFILL_FAILED') {
    return {
      label: '补采失败',
      title: `本地仅有${status.availableDays}个有效收盘样本，远端补采失败，可点击立即刷新重试。`,
      tone: 'warning',
    }
  }
  if (status.reason === 'NO_HISTORY_DATA') {
    return {
      label: '暂无数据',
      title: '当前本地数据与已配置数据源均未取得有效日K。',
      tone: 'muted',
    }
  }
  return {
    label: '样本不足',
    title: `${days}日涨跌至少需要${days + 1}个有效收盘样本，当前只有${status.availableDays}个。`,
    tone: 'warning',
  }
}

export function formatMorningAuctionPriceHistoryCoverage(
  coverage: MorningAuctionPriceHistoryCoverage,
): string {
  return `历史涨跌 3日 ${coverage.covered3dCount}/${coverage.requestedCount} · 5日 ${coverage.covered5dCount}/${coverage.requestedCount}`
}
