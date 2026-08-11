import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  fetchSnapshot: vi.fn(),
  fetchConstituents: vi.fn(),
  recoverMomentum: vi.fn(),
  getDb: vi.fn(() => ({ id: 'db' })),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle },
}))

vi.mock('../../electron/main/services/marketHeatmapService', () => ({
  EmptyDataError: class EmptyDataError extends Error {},
  fetchMarketSnapshot: mocks.fetchSnapshot,
  fetchIndustryConstituents: mocks.fetchConstituents,
}))

vi.mock('../../electron/main/services/marketHeatmapMomentumRecoveryService', () => ({
  recoverHeatmapMomentum: mocks.recoverMomentum,
}))

vi.mock('../../electron/main/database/db', () => ({
  getDb: mocks.getDb,
}))

import { registerMarketHeatmapHandlers } from '../../electron/main/ipc/marketHeatmapHandlers'

beforeEach(() => {
  mocks.handlers.clear()
  mocks.handle.mockReset()
  mocks.fetchSnapshot.mockReset()
  mocks.fetchConstituents.mockReset()
  mocks.recoverMomentum.mockReset()
  mocks.handle.mockImplementation((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
    mocks.handlers.set(channel, handler)
  })
  registerMarketHeatmapHandlers()
})

describe('FR-263 行业云图IPC缓存与错误收敛', () => {
  it('重复读取同一个L2命中LRU，不重复调用数据源', async () => {
    const data = [{ code: 'SH600000', name: '浦发银行', price: 9, change: 2, marketCap: 100 }]
    mocks.fetchConstituents.mockResolvedValue(data)
    const handler = mocks.handlers.get('marketHeatmap:getIndustryConstituents')!
    const payload = { industryCode: 'hangye_ZJ66', industryName: '货币金融服务' }

    const first = await handler({}, payload)
    const second = await handler({}, payload)

    expect(first).toEqual({ ok: true, data })
    expect(second).toEqual({ ok: true, data })
    expect(mocks.fetchConstituents).toHaveBeenCalledTimes(1)
  })

  it('新浪限频错误只返回稳定错误码，不暴露底层异常', async () => {
    mocks.fetchSnapshot.mockRejectedValue(new Error('SINA_RATE_LIMITED_456'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const handler = mocks.handlers.get('marketHeatmap:getSnapshot')!

    await expect(handler({})).resolves.toEqual({
      ok: false,
      code: 'UPSTREAM_RATE_LIMITED',
      message: '数据源请求过于频繁，请稍后重试',
    })
  })

  it('只接受有界窗口并把历史恢复交给主进程服务', async () => {
    const data = { tradeDate: '2026-08-11', momentum: { 电子: 0.2 } }
    mocks.recoverMomentum.mockResolvedValue(data)
    const handler = mocks.handlers.get('marketHeatmap:recoverMomentum')!

    await expect(handler({}, { windowMinutes: 3, includeL2: false })).resolves.toEqual({ ok: true, data })
    expect(mocks.recoverMomentum).toHaveBeenCalledWith(
      { id: 'db' },
      { windowMinutes: 3, includeL2: false, forceRefresh: false },
    )
    await expect(handler({}, { windowMinutes: 0, includeL2: false })).resolves.toEqual({
      ok: false,
      code: 'INVALID_PARAM',
      message: '动量恢复参数无效',
    })
  })
})
