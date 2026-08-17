import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  getDb: vi.fn(),
  getSnapshot: vi.fn(),
  invalidateCache: vi.fn(),
  getConceptSource: vi.fn(),
  setConceptSource: vi.fn(),
}))

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../../electron/main/database/db', () => ({ getDb: mocks.getDb }))
vi.mock('../../electron/main/services/sectorFlowService', () => ({
  getSectorFlowWorkbenchSnapshot: mocks.getSnapshot,
  invalidateSectorFlowCache: mocks.invalidateCache,
}))
vi.mock('../../electron/main/database/settingsRepository', () => ({
  getSectorConceptSource: mocks.getConceptSource,
  setSectorConceptSource: mocks.setConceptSource,
}))

import { registerSectorFlowHandlers } from '../../electron/main/ipc/sectorFlowHandlers'

type IpcHandler = (event: unknown, payload?: unknown) => Promise<unknown>

function getHandler(channel: string): IpcHandler {
  const registration = mocks.handle.mock.calls.find(([registeredChannel]) => registeredChannel === channel)
  if (!registration) throw new Error(`未注册 IPC: ${channel}`)
  return registration[1] as IpcHandler
}

beforeAll(() => {
  registerSectorFlowHandlers()
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-11T12:00:00+08:00'))
  mocks.getDb.mockReset()
  mocks.getSnapshot.mockReset()
})

afterAll(() => {
  vi.useRealTimers()
})

describe('FR-265 板块资金历史 IPC', () => {
  it.each([
    null,
    '20260810',
    [],
    { tradeDate: '' },
    { tradeDate: '2026-08-10' },
    { tradeDate: '20260230' },
    { tradeDate: '20260812' },
    { forceRefresh: 'true' },
    { tradeDate: '20260810', url: 'https://example.com' },
  ])('拒绝非法、未来或越权请求 %#', async (payload) => {
    await expect(getHandler('sectorFlow:getSnapshot')({}, payload)).resolves.toEqual({
      ok: false,
      error: 'INVALID_SECTOR_FLOW_REQUEST',
      message: '交易日期格式不正确，或不能选择未来日期。',
    })
    expect(mocks.getDb).not.toHaveBeenCalled()
    expect(mocks.getSnapshot).not.toHaveBeenCalled()
  })

  it('只把规范历史日期和重新读取语义交给服务', async () => {
    const db = { id: 'db' }
    mocks.getDb.mockReturnValue(db)
    mocks.getSnapshot.mockResolvedValue({ tradeDate: '20260810' })

    await expect(getHandler('sectorFlow:getSnapshot')({}, {
      tradeDate: '20260810',
      forceRefresh: true,
    })).resolves.toEqual({ ok: true, snapshot: { tradeDate: '20260810' } })
    expect(mocks.getSnapshot).toHaveBeenCalledWith(db, {
      tradeDate: '20260810',
      forceRefresh: true,
    })
  })

  it('历史日期无存档时只返回稳定错误', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.getDb.mockReturnValue({ id: 'db' })
    mocks.getSnapshot.mockRejectedValue(new Error('SECTOR_FLOW_HISTORY_UNAVAILABLE'))

    await expect(getHandler('sectorFlow:getSnapshot')({}, {
      tradeDate: '20260809',
    })).resolves.toEqual({
      ok: false,
      error: 'SECTOR_FLOW_HISTORY_UNAVAILABLE',
      message: '该交易日没有已核验的本地板块资金存档，请选择其他交易日。',
    })
  })
})
