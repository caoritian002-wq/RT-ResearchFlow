import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  deleteReviewReportMock,
  getDbMock,
  getReviewReportMock,
  handleMock,
  listReviewReportsMock,
  removeHandlerMock,
  saveReviewReportMock,
} = vi.hoisted(() => ({
  deleteReviewReportMock: vi.fn(),
  getDbMock: vi.fn(),
  getReviewReportMock: vi.fn(),
  handleMock: vi.fn(),
  listReviewReportsMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  saveReviewReportMock: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock },
}))
vi.mock('../../electron/main/database/db', () => ({ getDb: getDbMock }))
vi.mock('../../electron/main/database/decisionReviewReportRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/database/decisionReviewReportRepository')>()
  return {
    ...actual,
    deleteReviewReport: deleteReviewReportMock,
    getReviewReport: getReviewReportMock,
    listReviewReports: listReviewReportsMock,
    saveReviewReport: saveReviewReportMock,
  }
})
vi.mock('../../electron/main/services/decisionSignalService')
vi.mock('../../electron/main/services/decisionSignalBackfillService')
vi.mock('../../electron/main/services/decisionReviewStatsService')
vi.mock('../../electron/main/services/decisionOutcomeMemory')

import { DecisionReviewReportRepositoryError } from '../../electron/main/database/decisionReviewReportRepository'
import { registerDecisionHandlers } from '../../electron/main/ipc/decisionHandlers'

type IpcHandler = (event: unknown, payload?: unknown) => unknown

function handler(channel: string): IpcHandler {
  const registration = handleMock.mock.calls.find(([registeredChannel]) => registeredChannel === channel)
  if (!registration) throw new Error(`未注册 IPC: ${channel}`)
  return registration[1] as IpcHandler
}

beforeEach(() => {
  vi.clearAllMocks()
  getDbMock.mockReturnValue({ name: 'db' })
  registerDecisionHandlers()
})

describe('复盘报告历史 IPC', () => {
  it('保存和列表请求透传到报告仓库', async () => {
    const summary = { id: 'report-1', versionNumber: 1 }
    saveReviewReportMock.mockReturnValue(summary)
    listReviewReportsMock.mockReturnValue({ items: [summary], total: 1, offset: 0, limit: 30 })
    const savePayload = {
      requestId: '28d35c4e-dabb-4d54-85fd-4eb85417a66f',
      periodStart: '2026-07-15',
      periodEnd: '2026-07-15',
      report: { kind: 'daily' },
    }

    expect(handler('decision:saveReviewReport')({}, savePayload)).toEqual({ ok: true, data: summary })
    expect(handler('decision:listReviewReports')({}, { kind: 'daily' })).toMatchObject({
      ok: true,
      data: { total: 1 },
    })
    expect(saveReviewReportMock).toHaveBeenCalledWith(getDbMock(), savePayload)
    expect(listReviewReportsMock).toHaveBeenCalledWith(getDbMock(), { kind: 'daily' })
  })

  it('保留仓库错误码并将未知异常映射为 DB_ERROR', async () => {
    getReviewReportMock.mockImplementation(() => {
      throw new DecisionReviewReportRepositoryError('CORRUPT_DATA', '快照损坏')
    })
    deleteReviewReportMock.mockImplementation(() => {
      throw new Error('sqlite busy')
    })

    expect(handler('decision:getReviewReport')({}, { id: 'report-1' })).toEqual({
      ok: false,
      error: 'CORRUPT_DATA',
      message: '快照损坏',
    })
    expect(handler('decision:deleteReviewReport')({}, { id: 'report-1' })).toEqual({
      ok: false,
      error: 'DB_ERROR',
      message: 'sqlite busy',
    })
  })
})