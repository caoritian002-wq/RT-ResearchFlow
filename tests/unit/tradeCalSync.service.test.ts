import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchTradeCal: vi.fn(),
  getLatestCalDate: vi.fn(),
  upsertTradeCal: vi.fn(),
}))

vi.mock('../../electron/main/services/tushareService', () => ({ fetchTradeCal: mocks.fetchTradeCal }))
vi.mock('../../electron/main/database/tradeCalRepository', () => ({
  getLatestCalDate: mocks.getLatestCalDate,
  upsertTradeCal: mocks.upsertTradeCal,
}))

import { syncTradeCalFull } from '../../electron/main/services/tradeCalSyncService'

describe('tradeCalSyncService', () => {
  beforeEach(() => vi.clearAllMocks())

  it('并发请求等待同一个完整日历任务，不让后到调用方误判完成', async () => {
    let resolveRows: (rows: Array<{ calDate: string; isOpen: number; pretradeDate: string }>) => void = () => undefined
    mocks.fetchTradeCal.mockReturnValue(new Promise((resolve) => { resolveRows = resolve }))

    const first = syncTradeCalFull({} as never, 'token')
    const second = syncTradeCalFull({} as never, 'token')
    expect(mocks.fetchTradeCal).toHaveBeenCalledOnce()

    resolveRows([{ calDate: '20260720', isOpen: 1, pretradeDate: '20260717' }])
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(mocks.upsertTradeCal).toHaveBeenCalledOnce()
    expect(firstResult).toEqual({ status: 'completed', rowCount: 1 })
    expect(secondResult).toEqual(firstResult)
  })

  it('上游空响应和异常返回可判断终态，不改写本地日历', async () => {
    mocks.fetchTradeCal.mockResolvedValueOnce([])
    await expect(syncTradeCalFull({} as never, 'token')).resolves.toEqual({ status: 'empty', rowCount: 0 })

    mocks.fetchTradeCal.mockRejectedValueOnce(new Error('network unavailable'))
    await expect(syncTradeCalFull({} as never, 'token')).resolves.toEqual({ status: 'failed', rowCount: 0 })
    expect(mocks.upsertTradeCal).not.toHaveBeenCalled()
  })
})
