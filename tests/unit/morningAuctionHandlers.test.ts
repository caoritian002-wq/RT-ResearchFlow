import { beforeAll, describe, expect, it, vi } from 'vitest'

const {
  generateMorningAuctionInsightsMock,
  getCachedMorningAuctionSnapshotMock,
  getDbMock,
  getOrCreateMorningAuctionSnapshotMock,
  handleMock,
  refreshMorningAuctionSnapshotMock,
  resolveMorningAuctionTradeDateStatusMock,
} = vi.hoisted(() => ({
  generateMorningAuctionInsightsMock: vi.fn(),
  getCachedMorningAuctionSnapshotMock: vi.fn(),
  getDbMock: vi.fn(),
  getOrCreateMorningAuctionSnapshotMock: vi.fn(),
  handleMock: vi.fn(),
  refreshMorningAuctionSnapshotMock: vi.fn(),
  resolveMorningAuctionTradeDateStatusMock: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  ipcMain: { handle: handleMock },
}))
vi.mock('../../electron/main/database/db', () => ({ getDb: getDbMock }))
vi.mock('../../electron/main/database/settingsRepository')
vi.mock('../../electron/main/database/dataSourceRepository')
vi.mock('../../electron/main/utils/apiKeyEncryption')
vi.mock('../../electron/main/services/schedulerService')
vi.mock('../../electron/main/services/marketOverviewService')
vi.mock('../../electron/main/services/morningAuctionService', () => ({
  getCachedMorningAuctionSnapshot: getCachedMorningAuctionSnapshotMock,
  getOrCreateMorningAuctionSnapshot: getOrCreateMorningAuctionSnapshotMock,
  refreshMorningAuctionSnapshot: refreshMorningAuctionSnapshotMock,
  resolveMorningAuctionTradeDateStatus: resolveMorningAuctionTradeDateStatusMock,
}))
vi.mock('../../electron/main/services/closingHalfHourService')
vi.mock('../../electron/main/services/limitBoardMonitorService')
vi.mock('../../electron/main/services/secondBoardLeaderService')
vi.mock('../../electron/main/services/firstYinDipService')
vi.mock('../../electron/main/services/dipBuyRadarService')
vi.mock('../../electron/main/services/tushareService')
vi.mock('../../electron/main/services/cyqChipsFetchService')
vi.mock('../../electron/main/database/dailyCloseCacheRepository')
vi.mock('../../electron/main/database/cyqChipsCacheRepository')
vi.mock('../../electron/main/database/stkFactorCacheRepository')
vi.mock('../../electron/main/database/thsConceptMembersRepository')
vi.mock('../../electron/main/database/dcConceptMembersRepository')
vi.mock('../../electron/main/services/conceptRouter')
vi.mock('../../electron/main/services/sharedRtKCache')
vi.mock('../../electron/main/services/chipMonitorService')
vi.mock('../../electron/main/database/chipMonitorRepository')
vi.mock('../../electron/main/database/portfolioRepository')
vi.mock('../../electron/main/services/backtestAuctionService')
vi.mock('../../electron/main/database/backtestDetailRepository')
vi.mock('../../electron/main/database/stkAuctionCacheRepository')
vi.mock('../../electron/main/database/morningAuctionInsightRepository')
vi.mock('../../electron/main/services/morningAuctionInsightService', () => ({
  MORNING_AUCTION_INSIGHT_SCHEMA_VERSION: 2,
  countMorningAuctionCandidates: vi.fn(),
  generateMorningAuctionInsights: generateMorningAuctionInsightsMock,
  getMorningAuctionStructuredInsight: vi.fn(),
  listMorningAuctionStructuredInsights: vi.fn(),
  updateMorningAuctionVerification: vi.fn(),
}))

import { registerShortTermHandlers } from '../../electron/main/ipc/shortTermHandlers'

type IpcHandler = (event: unknown, payload?: unknown) => unknown

function getHandler(channel: string): IpcHandler {
  const registration = handleMock.mock.calls.find(([registeredChannel]) => registeredChannel === channel)
  if (!registration) throw new Error(`未注册 IPC: ${channel}`)
  return registration[1] as IpcHandler
}

beforeAll(() => {
  registerShortTermHandlers()
})

describe('早盘结构化研判 IPC', () => {
  it('从缓存读取快照并调用结构化生成服务', async () => {
    const db = { name: 'test-db' }
    const snapshot = { tradeDate: '20260712' }
    getDbMock.mockReturnValue(db)
    resolveMorningAuctionTradeDateStatusMock.mockReturnValue({
      isTradeDay: true,
      previousTradeDate: '20260710',
      nextTradeDate: '20260713',
      recommendedTradeDate: null,
    })
    getCachedMorningAuctionSnapshotMock.mockReturnValue(snapshot)
    generateMorningAuctionInsightsMock.mockReturnValue({
      generatedCount: 1,
      failedCount: 0,
      insights: [{ tsCode: '600000.SH', poolKey: 'firstBoard' }],
    })

    const handler = getHandler('shortTerm:morningAuction:generateInsights')
    const result = await handler({}, { tradeDate: '20260712', force: false })

    expect(getCachedMorningAuctionSnapshotMock).toHaveBeenCalledWith('20260712')
    expect(generateMorningAuctionInsightsMock).toHaveBeenCalledWith(db, snapshot, {
      tsCode: undefined,
      poolKey: undefined,
    })
    expect(result).toMatchObject({
      ok: true,
      tradeDate: '20260712',
      generatedCount: 1,
      failedCount: 0,
    })
  })

  it('非交易日返回空快照和推荐交易日且不生成结构化研判', async () => {
    const tradeDateStatus = {
      isTradeDay: false,
      previousTradeDate: '20260710',
      nextTradeDate: '20260713',
      recommendedTradeDate: '20260710',
    }
    const emptySnapshot = {
      tradeDate: '20260712',
      generatedAt: 1,
      isMock: false,
      threeOne: { firstBoard: [], secondBoard: [], brokenBoard: [], brokenConsec: [], allMarket: [] },
      weakToStrong: { badBoard: [], tailAttack: [], brokenBoard: [], afternoonReseal: [], reversal: [] },
      boardCategory: { first: [], second: [], third: [], n: [] },
    }
    resolveMorningAuctionTradeDateStatusMock.mockReturnValue(tradeDateStatus)
    getOrCreateMorningAuctionSnapshotMock.mockResolvedValue(emptySnapshot)
    refreshMorningAuctionSnapshotMock.mockResolvedValue(emptySnapshot)
    getCachedMorningAuctionSnapshotMock.mockClear()
    generateMorningAuctionInsightsMock.mockClear()

    const getResult = await getHandler('shortTerm:morningAuction:get')({}, { tradeDate: '20260712' })
    const refreshResult = await getHandler('shortTerm:morningAuction:refresh')({}, { tradeDate: '20260712' })
    const generateResult = await getHandler('shortTerm:morningAuction:generateInsights')({}, {
      tradeDate: '20260712',
      force: true,
    })

    expect(getResult).toMatchObject({
      ok: true,
      snapshot: emptySnapshot,
      tradeDateStatus,
    })
    expect(refreshResult).toMatchObject({
      ok: true,
      snapshot: emptySnapshot,
      tradeDateStatus,
    })
    expect(refreshMorningAuctionSnapshotMock).toHaveBeenCalledWith('20260712')
    expect(generateResult).toEqual({
      ok: false,
      error: {
        code: 'NON_TRADING_DAY',
        message: '所选日期不是交易日, 无法生成竞价研判。',
        recommendedTradeDate: '20260710',
      },
    })
    expect(getCachedMorningAuctionSnapshotMock).not.toHaveBeenCalled()
    expect(generateMorningAuctionInsightsMock).not.toHaveBeenCalled()
  })
})