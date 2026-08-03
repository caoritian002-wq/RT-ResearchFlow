import { beforeAll, describe, expect, it, vi } from 'vitest'

const { evaluateMock, getDbMock, handleMock } = vi.hoisted(() => ({
  evaluateMock: vi.fn(),
  getDbMock: vi.fn(),
  handleMock: vi.fn(),
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('../../electron/main/database/db', () => ({ getDb: getDbMock }))
vi.mock('../../electron/main/database/strategyBacktestRepository', () => ({
  deleteRun: vi.fn(),
  getRun: vi.fn(),
  getTrades: vi.fn(),
  listRuns: vi.fn(),
  parseStoredBacktestReport: vi.fn(),
}))
vi.mock('../../electron/main/services/backtest/strategyBacktestEngine', () => ({ runStrategyBacktest: vi.fn() }))
vi.mock('../../electron/main/services/backtest/strategyEffectivenessService', () => ({ evaluateStrategySignals: evaluateMock }))

import { registerStrategyBacktestHandlers } from '../../electron/main/ipc/strategyBacktestHandlers'

type Handler = (event: unknown, payload?: unknown) => unknown

function handler(channel: string): Handler {
  const match = handleMock.mock.calls.find(([registered]) => registered === channel)
  if (!match) throw new Error(`未注册 IPC: ${channel}`)
  return match[1] as Handler
}

beforeAll(() => registerStrategyBacktestHandlers())

describe('strategyBacktest:evaluateSignals', () => {
  it('拒绝无效日期、空策略和非法策略ID', () => {
    const invoke = handler('strategyBacktest:evaluateSignals')
    expect(invoke({}, { dateStart: '20260720', dateEnd: '20260701' })).toEqual({
      ok: false,
      error: 'INVALID_PARAM',
      message: '策略评估参数无效',
    })
    expect(invoke({}, { dateStart: '20260701', dateEnd: '20260720', strategyIds: [] })).toMatchObject({ ok: false, error: 'INVALID_PARAM' })
    expect(invoke({}, { dateStart: '20260701', dateEnd: '20260720', strategyIds: ['bad id'] })).toMatchObject({ ok: false, error: 'INVALID_PARAM' })
    expect(evaluateMock).not.toHaveBeenCalled()
  })

  it('规范去重策略ID并只读调用评估服务', () => {
    const db = { name: 'db' }
    const data = { rankings: [], observations: [] }
    getDbMock.mockReturnValue(db)
    evaluateMock.mockReturnValue(data)

    const result = handler('strategyBacktest:evaluateSignals')({}, {
      dateStart: '20260701',
      dateEnd: '20260720',
      strategyIds: ['auction.threeOne', 'auction.threeOne', 'strategyLab.alpha'],
      excludeUntradeable: true,
    })

    expect(evaluateMock).toHaveBeenCalledWith(db, {
      dateStart: '20260701',
      dateEnd: '20260720',
      strategyIds: ['auction.threeOne', 'strategyLab.alpha'],
      excludeUntradeable: true,
    })
    expect(result).toEqual({ ok: true, data })
  })

  it('数据库异常只返回稳定错误，不暴露底层消息', () => {
    evaluateMock.mockImplementationOnce(() => { throw new Error('SQL failed at E:\\secret\\trade-watch.db') })
    const result = handler('strategyBacktest:evaluateSignals')({}, {
      dateStart: '20260701',
      dateEnd: '20260720',
      strategyIds: ['auction.threeOne'],
    })
    expect(result).toEqual({
      ok: false,
      error: 'EVALUATION_FAILED',
      message: '策略信号评估失败，请稍后重试',
    })
  })
})
