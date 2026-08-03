import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  completeFollowUpMock,
  getDbMock,
  getJudgmentMock,
  handleMock,
  listDueFollowUpsMock,
  listJudgmentsMock,
  removeHandlerMock,
  saveJudgmentMock,
} = vi.hoisted(() => ({
  completeFollowUpMock: vi.fn(),
  getDbMock: vi.fn(),
  getJudgmentMock: vi.fn(),
  handleMock: vi.fn(),
  listDueFollowUpsMock: vi.fn(),
  listJudgmentsMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  saveJudgmentMock: vi.fn(),
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock, removeHandler: removeHandlerMock } }))
vi.mock('../../electron/main/database/db', () => ({ getDb: getDbMock }))
vi.mock('../../electron/main/database/decisionJudgmentRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/database/decisionJudgmentRepository')>()
  return { ...actual, getDecisionJudgment: getJudgmentMock, listDecisionJudgments: listJudgmentsMock }
})
vi.mock('../../electron/main/services/decisionJudgmentService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/services/decisionJudgmentService')>()
  return { ...actual, saveDecisionJudgment: saveJudgmentMock }
})
vi.mock('../../electron/main/database/decisionJudgmentFollowUpRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/database/decisionJudgmentFollowUpRepository')>()
  return { ...actual, listDueDecisionJudgmentFollowUps: listDueFollowUpsMock }
})
vi.mock('../../electron/main/services/decisionJudgmentFollowUpService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/services/decisionJudgmentFollowUpService')>()
  return { ...actual, completeDecisionJudgmentFollowUp: completeFollowUpMock }
})
vi.mock('../../electron/main/services/decisionSignalService')
vi.mock('../../electron/main/services/decisionSignalBackfillService')
vi.mock('../../electron/main/services/decisionReviewStatsService')
vi.mock('../../electron/main/services/decisionOutcomeMemory')
vi.mock('../../electron/main/database/decisionReviewReportRepository')

import { DecisionJudgmentRepositoryError } from '../../electron/main/database/decisionJudgmentRepository'
import { DecisionJudgmentFollowUpRepositoryError } from '../../electron/main/database/decisionJudgmentFollowUpRepository'
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

describe('决策判断账本 IPC', () => {
  it('保存、列表和详情请求透传到判断服务与仓库', () => {
    const payload = { requestId: 'request-1', tsCode: '600000.SH' }
    const saved = { id: 'judgment-1', projectedSignal: null }
    saveJudgmentMock.mockReturnValue(saved)
    listJudgmentsMock.mockReturnValue({ items: [saved], total: 1, limit: 30, offset: 0 })
    getJudgmentMock.mockReturnValue(saved)

    expect(handler('decision:saveJudgment')({}, payload)).toEqual({ ok: true, data: saved })
    expect(handler('decision:listJudgments')({}, { tsCode: '600000.SH' })).toMatchObject({ ok: true, data: { total: 1 } })
    expect(handler('decision:getJudgment')({}, { id: 'judgment-1' })).toEqual({ ok: true, data: saved })
    expect(saveJudgmentMock).toHaveBeenCalledWith(getDbMock(), payload)
    expect(listJudgmentsMock).toHaveBeenCalledWith(getDbMock(), { tsCode: '600000.SH' })
    expect(getJudgmentMock).toHaveBeenCalledWith(getDbMock(), 'judgment-1')
  })

  it('保留预期错误码并清洗未知数据库异常', () => {
    getJudgmentMock.mockImplementation(() => {
      throw new DecisionJudgmentRepositoryError('CORRUPT_DATA', '判断快照损坏')
    })
    listJudgmentsMock.mockImplementation(() => {
      throw new Error('SQLITE_BUSY at C:\\private\\db.sqlite')
    })

    expect(handler('decision:getJudgment')({}, { id: 'judgment-1' })).toEqual({
      ok: false,
      error: 'CORRUPT_DATA',
      message: '判断快照损坏',
    })
    expect(handler('decision:listJudgments')({}, {})).toEqual({
      ok: false,
      error: 'DB_ERROR',
      message: '判断账本暂时不可用，请稍后重试',
    })
  })

  it('查询并完成到期回访，保留业务错误且不泄露未知异常', () => {
    const taskList = { items: [{ judgmentId: 'judgment-1' }], total: 1, limit: 20, offset: 0 }
    listDueFollowUpsMock.mockReturnValueOnce(taskList).mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY at C:\\private\\follow-up.sqlite')
    })
    completeFollowUpMock.mockImplementation(() => {
      throw new DecisionJudgmentFollowUpRepositoryError('FOLLOW_UP_ALREADY_COMPLETED', '该判断已完成回访')
    })

    expect(handler('decision:listDueJudgmentFollowUps')({}, { now: 123 })).toEqual({ ok: true, data: taskList })
    expect(listDueFollowUpsMock).toHaveBeenCalledWith(getDbMock(), { now: 123 })
    expect(handler('decision:completeJudgmentFollowUp')({}, {
      requestId: 'request-1', judgmentId: 'judgment-1', action: 'maintain',
    })).toEqual({
      ok: false,
      error: 'FOLLOW_UP_ALREADY_COMPLETED',
      message: '该判断已完成回访',
    })
    expect(handler('decision:listDueJudgmentFollowUps')({}, {})).toEqual({
      ok: false,
      error: 'DB_ERROR',
      message: '判断账本暂时不可用，请稍后重试',
    })
  })
})