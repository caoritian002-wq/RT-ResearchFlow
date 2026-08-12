import { describe, expect, it } from 'vitest'
import {
  computeIndustryMomentum,
  createPersistedIndustryMomentum,
  getBeijingDate,
  getBeijingMinuteKey,
  hasMeaningfulIndustryMomentum,
  isInClosingMomentumCaptureWindow,
  parsePersistedIndustryMomentum,
  type HeatmapHistoryEntry,
} from '../../src/utils/heatmapMomentum'

function entry(
  fetchedAt: number,
  l1Change: number,
  l2Change = l1Change,
): HeatmapHistoryEntry {
  return {
    fetchedAt,
    snapshot: {
      industries: [{
        name: '电子',
        weightedChange: l1Change,
        subIndustries: [{ name: '半导体', change: l2Change }],
      }],
    },
  }
}

describe('FR-264 行业动量保留', () => {
  const liveOptions = {
    origin: 'live-capture' as const,
    sourceProvider: 'sina' as const,
    scope: 'provider-snapshot' as const,
    boundary: 'live' as const,
  }

  it('使用目标时间之前最近的基线并同时计算L1和L2', () => {
    const history = [
      entry(0, 1, 0.5),
      entry(360_000, 3, 2),
      entry(600_000, 5, 4.5),
    ]

    expect(computeIndustryMomentum(history, 3)).toEqual({
      电子: 2,
      半导体: 2.5,
    })
  })

  it('拒绝用距离目标窗口过远的旧样本伪装三分钟动量', () => {
    const history = [entry(300_000, 1), entry(600_000, 5)]

    expect(computeIndustryMomentum(history, 3)).toEqual({})
  })

  it('支持设置页允许的三十分钟窗口', () => {
    const history = Array.from({ length: 31 }, (_, index) =>
      entry(index * 60_000, index / 10))

    expect(computeIndustryMomentum(history, 30)).toEqual({
      电子: 3,
      半导体: 3,
    })
  })

  it('持久化记录携带北京时间交易日和实际窗口', () => {
    const capturedAt = Date.parse('2026-08-11T06:59:00.000Z')
    const record = createPersistedIndustryMomentum({ 电子: 0.42 }, capturedAt, 3, liveOptions)

    expect(record.tradeDate).toBe('2026-08-11')
    expect(record.version).toBe(2)
    expect(parsePersistedIndustryMomentum(record, capturedAt + 60_000)).toEqual(record)
  })

  it('默认三分钟窗口只在收盘前五分钟执行有界采样', () => {
    const beforeWindow = Date.parse('2026-08-11T06:54:00.000Z')
    const windowStart = Date.parse('2026-08-11T06:55:00.000Z')
    const close = Date.parse('2026-08-11T07:00:00.000Z')

    expect(isInClosingMomentumCaptureWindow(beforeWindow, 3)).toBe(false)
    expect(isInClosingMomentumCaptureWindow(windowStart, 3)).toBe(true)
    expect(isInClosingMomentumCaptureWindow(close, 3)).toBe(false)
    expect(getBeijingMinuteKey(windowStart)).toBe('2026-08-11T14:55')
  })

  it('全零静态截面不覆盖最后一次有效盘中动量', () => {
    expect(hasMeaningfulIndustryMomentum({ 电子: 0, 半导体: 0 })).toBe(false)
    expect(hasMeaningfulIndustryMomentum({ 电子: 0, 半导体: -0.001 })).toBe(true)
  })

  it('拒绝超过七天、未来时间或日期身份不一致的记录', () => {
    const capturedAt = Date.parse('2026-08-01T06:59:00.000Z')
    const record = createPersistedIndustryMomentum({ 电子: 0.42 }, capturedAt, 3, liveOptions)

    expect(parsePersistedIndustryMomentum(record, capturedAt + 8 * 24 * 60 * 60 * 1000)).toBeNull()
    expect(parsePersistedIndustryMomentum({ ...record, capturedAt: capturedAt + 10 * 60_000 }, capturedAt)).toBeNull()
    expect(parsePersistedIndustryMomentum({ ...record, tradeDate: '2026-08-02' }, capturedAt)).toBeNull()
    expect(getBeijingDate(capturedAt)).toBe('2026-08-01')
  })

  it('兼容读取既有v1记录但拒绝伪造的恢复来源元信息', () => {
    const capturedAt = Date.parse('2026-08-11T07:00:00.000Z')
    expect(parsePersistedIndustryMomentum({
      version: 1,
      momentum: { 电子: 0.1 },
      capturedAt,
      tradeDate: '2026-08-11',
      windowMinutes: 3,
    }, capturedAt)).toMatchObject({
      version: 2,
      origin: 'live-capture',
      boundary: 'live',
    })

    const recovered = createPersistedIndustryMomentum({ 电子: 0.1 }, capturedAt, 3, {
      origin: 'historical-recovery',
      sourceProvider: 'eastmoney',
      scope: 'shenwan-l1',
      boundary: 'market-close',
      coverage: {
        l1: { available: 31, total: 31 },
        l2: { available: 0, total: 0 },
      },
    })
    expect(parsePersistedIndustryMomentum({
      ...recovered,
      coverage: { l1: { available: 32, total: 31 }, l2: { available: 0, total: 0 } },
    }, capturedAt)).toBeNull()
  })
})
