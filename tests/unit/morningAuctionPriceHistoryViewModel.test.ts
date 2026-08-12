import { describe, expect, it } from 'vitest'
import {
  formatMorningAuctionPriceHistoryCoverage,
  getMorningAuctionPriceHistoryMissingDisplay,
} from '../../src/components/ShortTermStrategy/morningAuctionPriceHistoryViewModel'

describe('早盘历史涨跌状态展示', () => {
  it('区分旧主进程、样本不足、无数据、本地失败和补采失败', () => {
    expect(getMorningAuctionPriceHistoryMissingDisplay(undefined, 5)).toMatchObject({ label: '待补齐', tone: 'muted' })
    expect(getMorningAuctionPriceHistoryMissingDisplay({
      state: 'insufficient',
      availableDays: 3,
      reason: 'SAMPLE_INSUFFICIENT',
      remoteAttempted: false,
    }, 5)).toMatchObject({ label: '样本不足', tone: 'warning' })
    expect(getMorningAuctionPriceHistoryMissingDisplay({
      state: 'unavailable',
      availableDays: 0,
      reason: 'NO_HISTORY_DATA',
      remoteAttempted: false,
    }, 3)).toMatchObject({ label: '暂无数据', tone: 'muted' })
    expect(getMorningAuctionPriceHistoryMissingDisplay({
      state: 'failed',
      availableDays: 0,
      reason: 'LOCAL_READ_FAILED',
      remoteAttempted: false,
    }, 3)).toMatchObject({ label: '读取失败', tone: 'danger' })
    expect(getMorningAuctionPriceHistoryMissingDisplay({
      state: 'partial',
      availableDays: 4,
      reason: 'REMOTE_BACKFILL_FAILED',
      remoteAttempted: true,
    }, 5)).toMatchObject({ label: '补采失败', tone: 'warning' })
  })

  it('覆盖摘要同时披露3日和5日覆盖', () => {
    expect(formatMorningAuctionPriceHistoryCoverage({
      requestedCount: 89,
      covered3dCount: 88,
      covered5dCount: 87,
      readyCount: 87,
      partialCount: 1,
      insufficientCount: 1,
      unavailableCount: 0,
      failedCount: 0,
      updatedAt: 1,
    })).toBe('历史涨跌 3日 88/89 · 5日 87/89')
  })
})
