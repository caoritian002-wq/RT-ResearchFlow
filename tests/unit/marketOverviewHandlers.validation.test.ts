import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getDbMock,
  getMarketOverviewSnapshotMock,
  getMarketResonanceSnapshotMock,
  getMarketResonanceIndustryChildrenMock,
  handleMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getMarketOverviewSnapshotMock: vi.fn(),
  getMarketResonanceSnapshotMock: vi.fn(),
  getMarketResonanceIndustryChildrenMock: vi.fn(),
  handleMock: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock },
}))
vi.mock('../../electron/main/database/db', () => ({ getDb: getDbMock }))
vi.mock('../../electron/main/database/tradeCalRepository', () => ({
  getNextTradeDay: vi.fn(),
  getPrevTradeDay: vi.fn(),
}))
vi.mock('../../electron/main/services/sharedRtKCache', () => ({ getRtKCache: vi.fn() }))
vi.mock('../../electron/main/services/marketOverviewService', () => ({
  getMarketOverviewSnapshot: getMarketOverviewSnapshotMock,
}))
vi.mock('../../electron/main/services/marketResonanceService', () => ({
  getMarketResonanceSnapshot: getMarketResonanceSnapshotMock,
}))
vi.mock('../../electron/main/services/marketResonanceIndustryService', () => ({
  getMarketResonanceIndustryChildren: getMarketResonanceIndustryChildrenMock,
}))

import { registerMarketOverviewHandlers } from '../../electron/main/ipc/marketOverviewHandlers'

type IpcHandler = (event: unknown, payload?: unknown) => Promise<unknown>

function getHandler(channel: string): IpcHandler {
  const registration = handleMock.mock.calls.find(([registeredChannel]) => registeredChannel === channel)
  if (!registration) throw new Error(`未注册 IPC: ${channel}`)
  return registration[1] as IpcHandler
}

beforeAll(() => {
  registerMarketOverviewHandlers()
})

beforeEach(() => {
  getDbMock.mockClear()
  getMarketOverviewSnapshotMock.mockReset()
  getMarketResonanceSnapshotMock.mockClear()
  getMarketResonanceIndustryChildrenMock.mockReset()
})

describe('FR-261 市场概览 IPC 请求校验', () => {
  it.each([
    null,
    '20260807',
    [],
    { tradeDate: '' },
    { tradeDate: '2026-08-07' },
    { tradeDate: '20260230' },
    { forceRefresh: 'true' },
    { tradeDate: '20260807', url: 'https://example.com' },
  ])('拒绝非法或越权请求 %#', async (payload) => {
    const result = await getHandler('market:getMarketOverview')({}, payload)

    expect(result).toEqual({
      ok: false,
      code: 'INVALID_MARKET_OVERVIEW_REQUEST',
      error: '交易日期格式不正确, 或不能选择未来日期。',
    })
    expect(getDbMock).not.toHaveBeenCalled()
    expect(getMarketResonanceSnapshotMock).not.toHaveBeenCalled()
  })

  it('分别汇总分钟曲线、板块截面、分布和精确时间线质量', async () => {
    const prepare = vi.fn(() => ({ get: vi.fn(() => ({ trade_date: null })) }))
    getDbMock.mockReturnValue({ prepare })
    getMarketResonanceSnapshotMock.mockResolvedValue({
      tradeDate: '20260807',
      recoverableTradeDates: ['20260806', '20260807', '20260810'],
      dataMode: 'partial',
      sourceMode: 'network_backfill',
      sourceLabel: '测试',
      generatedAt: 1,
      coverage: {
        available: 20,
        total: 31,
        benchmarkTrends: { available: 3, total: 3 },
        sectorTrends: { available: 31, total: 31 },
        boardFacts: { available: 20, total: 31 },
      },
      benchmarks: [],
      sectors: [],
    })
    getMarketOverviewSnapshotMock.mockReturnValue({
      distribution: [],
      timeline: [],
      conceptHeat: [],
      generatedAt: 1,
      coverage: {
        distribution: { available: false, sampleCount: 0 },
        timeline: { mode: 'approximate', pointCount: 11 },
      },
    })

    const result = await getHandler('market:getMarketOverview')({}, {
      tradeDate: '20260807',
      forceRefresh: true,
    }) as {
      ok: boolean
      snapshot?: {
        quality: { status: string; missingParts: string[] }
        navigation: { previousTradeDate: string | null; nextTradeDate: string | null; latestTradeDate: string }
      }
    }

    expect(result.ok).toBe(true)
    expect(result.snapshot?.quality).toEqual({
      status: 'partial',
      missingParts: ['board_facts', 'distribution', 'timeline_approximate'],
    })
    expect(result.snapshot?.navigation).toMatchObject({
      previousTradeDate: '20260806',
      nextTradeDate: '20260810',
      latestTradeDate: '20260810',
    })
  })

  it('显式补采等待同日普通读取后仍单独执行, 不复用普通读取结果', async () => {
    let releaseOrdinary: ((value: unknown) => void) | null = null
    const ordinaryResult = new Promise((resolve) => { releaseOrdinary = resolve })
    const makeResonance = (sourceMode: 'local_archive' | 'network_backfill') => ({
      tradeDate: '20260806',
      recoverableTradeDates: ['20260806'],
      dataMode: 'archive',
      sourceMode,
      sourceLabel: '测试',
      generatedAt: 1,
      coverage: {
        available: 31,
        total: 31,
        benchmarkTrends: { available: 3, total: 3 },
        sectorTrends: { available: 31, total: 31 },
        boardFacts: { available: 31, total: 31 },
      },
      benchmarks: [],
      sectors: [],
    })
    getDbMock.mockReturnValue({
      prepare: vi.fn(() => ({ get: vi.fn(() => ({ trade_date: null })) })),
    })
    getMarketOverviewSnapshotMock.mockReturnValue({
      distribution: [],
      timeline: [],
      conceptHeat: [],
      generatedAt: 1,
      coverage: {
        distribution: { available: true, sampleCount: 1 },
        timeline: { mode: 'exact', pointCount: 1 },
      },
    })
    getMarketResonanceSnapshotMock
      .mockImplementationOnce(() => ordinaryResult)
      .mockResolvedValueOnce(makeResonance('network_backfill'))

    const ordinaryRequest = getHandler('market:getMarketOverview')({}, { tradeDate: '20260806' })
    const refreshRequest = getHandler('market:getMarketOverview')({}, {
      tradeDate: '20260806',
      forceRefresh: true,
    })
    await Promise.resolve()
    expect(getMarketResonanceSnapshotMock).toHaveBeenCalledTimes(1)

    releaseOrdinary?.(makeResonance('local_archive'))
    await expect(ordinaryRequest).resolves.toMatchObject({ ok: true })
    await expect(refreshRequest).resolves.toMatchObject({
      ok: true,
      snapshot: { resonance: { sourceMode: 'network_backfill' } },
    })
    expect(getMarketResonanceSnapshotMock).toHaveBeenCalledTimes(2)
    expect(getMarketResonanceSnapshotMock.mock.calls[1]?.[1]).toEqual({
      tradeDate: '20260806',
      forceRefresh: true,
    })
  })
})

describe('FR-262 二级行业 IPC 请求校验', () => {
  it.each([
    undefined,
    null,
    'BK1201',
    [],
    {},
    { tradeDate: '2026-08-07', parentIndustryCode: 'BK1201' },
    { tradeDate: '20260230', parentIndustryCode: 'BK1201' },
    { tradeDate: '20260807', parentIndustryCode: 'BK9999' },
    { tradeDate: '20260807', parentIndustryCode: 'BK1201', forceRefresh: 'true' },
    { tradeDate: '20260807', parentIndustryCode: 'BK1201', url: 'https://example.com' },
  ])('拒绝非法或越权请求 %#', async (payload) => {
    const result = await getHandler('market:getMarketResonanceChildren')({}, payload)

    expect(result).toEqual({
      ok: false,
      code: 'INVALID_MARKET_RESONANCE_CHILDREN_REQUEST',
      error: '交易日期或一级行业参数不正确。',
    })
    expect(getMarketResonanceIndustryChildrenMock).not.toHaveBeenCalled()
  })

  it('只把规范日期、白名单父级和刷新语义传入服务', async () => {
    const db = { prepare: vi.fn() }
    getDbMock.mockReturnValue(db)
    getMarketResonanceIndustryChildrenMock.mockResolvedValue({
      tradeDate: '20260807', parentIndustryCode: 'BK1201', children: [],
    })

    await expect(getHandler('market:getMarketResonanceChildren')({}, {
      tradeDate: '20260807',
      parentIndustryCode: 'BK1201',
      forceRefresh: true,
    })).resolves.toMatchObject({ ok: true })
    expect(getMarketResonanceIndustryChildrenMock).toHaveBeenCalledWith(db, {
      tradeDate: '20260807',
      parentIndustryCode: 'BK1201',
      forceRefresh: true,
    })
  })
})
