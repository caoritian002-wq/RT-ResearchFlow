import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  cancelMock,
  deleteMock,
  getDbMock,
  getMock,
  handleMock,
  initializeMock,
  listMock,
  preflightDirectMock,
  preflightMock,
  resumeMock,
  retryMock,
  startMock,
  startDirectMock,
  startReviewMock,
} = vi.hoisted(() => ({
  cancelMock: vi.fn(),
  deleteMock: vi.fn(),
  getDbMock: vi.fn(),
  getMock: vi.fn(),
  handleMock: vi.fn(),
  initializeMock: vi.fn(),
  listMock: vi.fn(),
  preflightDirectMock: vi.fn(),
  preflightMock: vi.fn(),
  resumeMock: vi.fn(),
  retryMock: vi.fn(),
  startMock: vi.fn(),
  startDirectMock: vi.fn(),
  startReviewMock: vi.fn(),
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('../../electron/main/database/db', () => ({ getDb: getDbMock }))
vi.mock('../../electron/main/services/researchAgentRunManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/services/researchAgentRunManager')>()
  return {
    ...actual,
    ResearchAgentRunManager: class {
      initialize = initializeMock
      preflight = preflightMock
      preflightDirect = preflightDirectMock
      start = startMock
      startDirect = startDirectMock
      startReview = startReviewMock
      list = listMock
      get = getMock
      cancel = cancelMock
      resume = resumeMock
      retry = retryMock
      delete = deleteMock
    },
  }
})

import { registerResearchAgentHandlers } from '../../electron/main/ipc/researchAgentHandlers'

const sender = { id: 'renderer' }
const window = { webContents: sender }
type Handler = (event: { sender: unknown }, payload?: unknown) => unknown

function handler(channel: string): Handler {
  const registration = handleMock.mock.calls.find(([name]) => name === channel)
  if (!registration) throw new Error(`missing ${channel}`)
  return registration[1] as Handler
}

beforeEach(() => {
  vi.clearAllMocks()
  getDbMock.mockReturnValue({ name: 'db' })
  initializeMock.mockReturnValue({ count: 0, runIds: [] })
  preflightMock.mockReturnValue({ ready: true })
  preflightDirectMock.mockReturnValue({ ready: true, sessionId: null })
  startMock.mockReturnValue({ run: { id: 'run' }, replayed: false })
  startDirectMock.mockReturnValue({ run: { id: 'direct-run' }, replayed: false, discussionSessionId: 21 })
  startReviewMock.mockReturnValue({ run: { id: 'review' }, replayed: false })
  listMock.mockReturnValue([])
  getMock.mockReturnValue({ run: { id: 'run' } })
  cancelMock.mockReturnValue({ id: 'run', status: 'cancelled' })
  resumeMock.mockReturnValue({ id: 'run', status: 'running' })
  retryMock.mockReturnValue({ run: { id: 'retry-run' }, replayed: false })
  deleteMock.mockReturnValue({ deletedRunIds: ['run'], discussionDeleted: false })
  registerResearchAgentHandlers(() => window as never)
})

describe('FR-256 research agent IPC', () => {
  it('exposes only bounded lifecycle/read channels and no model or tool execution entry', () => {
    expect(handleMock.mock.calls.map(([channel]) => channel)).toEqual([
      'researchAgent:preflight',
      'researchAgent:preflightDirect',
      'researchAgent:startRun',
      'researchAgent:startDirect',
      'researchAgent:startReview',
      'researchAgent:listRuns',
      'researchAgent:getRun',
      'researchAgent:cancelRun',
      'researchAgent:resumeRun',
      'researchAgent:retryRun',
      'researchAgent:deleteRun',
    ])
    expect(handleMock.mock.calls.map(([channel]) => channel)).not.toContain('researchAgent:callTool')
    expect(handleMock.mock.calls.map(([channel]) => channel)).not.toContain('researchAgent:callModel')
  })

  it('rejects foreign senders and extra fields before invoking the manager', () => {
    expect(handler('researchAgent:preflight')({ sender: {} }, { sessionId: 1 })).toEqual({
      ok: false,
      code: 'UNAUTHORIZED',
      message: '研究运行请求来源无权访问',
    })
    expect(handler('researchAgent:startRun')({ sender }, {
      requestId: '00000000-0000-4000-8000-000000002565',
      sessionId: 1,
      question: '这个问题已经超过十个字符并且可用于研究。',
      subjects: [{ kind: 'stock', tsCode: '600519.SH' }],
      includePortfolio: false,
      apiKey: 'must-not-pass',
    })).toMatchObject({ ok: false, code: 'INVALID_PARAM' })
    expect(startMock).not.toHaveBeenCalled()

    expect(handler('researchAgent:startRun')({ sender }, {
      requestId: '00000000-0000-4000-8000-000000002565',
      sessionId: 1,
      question: '这个问题已经超过十个字符并且可用于研究。',
      subjects: [{ kind: 'stock', tsCode: '600519.SH', toolInput: { limit: 999 } }],
      includePortfolio: false,
    })).toMatchObject({ ok: false, code: 'INVALID_PARAM' })
    expect(startMock).not.toHaveBeenCalled()
  })

  it('passes only confirmed subjects and lifecycle identifiers to the manager', () => {
    const payload = {
      requestId: '00000000-0000-4000-8000-000000002566',
      sessionId: 12,
      question: '贵州茅台基本面与趋势事实是否存在明显背离？',
      subjects: [{ kind: 'stock', tsCode: '600519.SH', label: '贵州茅台' }],
      includePortfolio: true,
      confirmedBudgetVersion: 'single-agent-unrestricted-v3',
      parentRunId: null,
    }
    expect(handler('researchAgent:startRun')({ sender }, payload)).toMatchObject({ ok: true })
    expect(startMock).toHaveBeenCalledWith(payload)
    expect(JSON.stringify(startMock.mock.calls[0][0])).not.toContain('messages')
    expect(JSON.stringify(startMock.mock.calls[0][0])).not.toContain('toolInput')
  })

  it('starts direct research through one bounded command without accepting context or tool overrides', () => {
    const payload = {
      requestId: '00000000-0000-4000-8000-000000002591',
      question: '直接核验贵州茅台趋势、基本面和最新正式披露是否相互印证。',
      subjects: [{ kind: 'stock', tsCode: '600519.SH', label: '贵州茅台' }],
      includePortfolio: false,
      projectId: null,
      confirmedBudgetVersion: 'single-agent-unrestricted-v3',
    }
    expect(handler('researchAgent:preflightDirect')({ sender }, { projectId: null })).toMatchObject({ ok: true })
    expect(preflightDirectMock).toHaveBeenCalledWith(null)
    expect(handler('researchAgent:startDirect')({ sender }, payload)).toMatchObject({ ok: true })
    expect(startDirectMock).toHaveBeenCalledWith(payload)
    expect(handler('researchAgent:startDirect')({ sender }, { ...payload, toolInput: { url: 'https://example.com' } }))
      .toMatchObject({ ok: false, code: 'INVALID_PARAM' })
    expect(startDirectMock).toHaveBeenCalledTimes(1)
  })

  it('requires the fixed budget confirmation and UUIDs for lifecycle mutations', () => {
    expect(handler('researchAgent:startRun')({ sender }, {
      requestId: '00000000-0000-4000-8000-000000002567',
      sessionId: 12,
      question: '贵州茅台基本面与趋势事实是否存在明显背离？',
      subjects: [{ kind: 'stock', tsCode: '600519.SH' }],
      includePortfolio: false,
    })).toMatchObject({ ok: false, code: 'INVALID_PARAM' })
    expect(startMock).not.toHaveBeenCalled()

    expect(handler('researchAgent:cancelRun')({ sender }, {
      requestId: '00000000-0000-4000-8000-000000002568',
      runId: '00000000-0000-4000-8000-000000002569',
    })).toMatchObject({ ok: true })
    expect(cancelMock).toHaveBeenCalledWith('00000000-0000-4000-8000-000000002569')

    expect(handler('researchAgent:resumeRun')({ sender }, {
      requestId: 'not-a-uuid',
      runId: '00000000-0000-4000-8000-000000002569',
    })).toMatchObject({ ok: false, code: 'INVALID_PARAM' })
    expect(resumeMock).not.toHaveBeenCalled()

    expect(handler('researchAgent:retryRun')({ sender }, {
      requestId: '00000000-0000-4000-8000-000000002572',
      sourceRunId: '00000000-0000-4000-8000-000000002569',
      confirmedBudgetVersion: 'single-agent-unrestricted-v3',
    })).toMatchObject({ ok: true })
    expect(retryMock).toHaveBeenCalledWith({
      requestId: '00000000-0000-4000-8000-000000002572',
      sourceRunId: '00000000-0000-4000-8000-000000002569',
      confirmedBudgetVersion: 'single-agent-unrestricted-v3',
    })

    expect(handler('researchAgent:deleteRun')({ sender }, {
      requestId: '00000000-0000-4000-8000-000000002573',
      runId: '00000000-0000-4000-8000-000000002569',
    })).toMatchObject({ ok: true })
    expect(deleteMock).toHaveBeenCalledWith('00000000-0000-4000-8000-000000002569')
  })

  it('starts review from only a source UUID and the fixed multi-perspective budget', () => {
    const payload = {
      requestId: '00000000-0000-4000-8000-000000002570',
      sourceRunId: '00000000-0000-4000-8000-000000002571',
      confirmedBudgetVersion: 'multi-perspective-unrestricted-v2',
    }
    expect(handler('researchAgent:startReview')({ sender }, payload)).toMatchObject({ ok: true })
    expect(startReviewMock).toHaveBeenCalledWith(payload)
    expect(handler('researchAgent:startReview')({ sender }, { ...payload, prompt: 'override' }))
      .toMatchObject({ ok: false, code: 'INVALID_PARAM' })
    expect(handler('researchAgent:startReview')({ sender }, { ...payload, confirmedBudgetVersion: 'single-agent-continuous-v2' }))
      .toMatchObject({ ok: false, code: 'INVALID_PARAM' })
  })
})
