import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { getDb } from '../database/db'
import {
  ResearchAgentRunManager,
  ResearchAgentRunManagerError,
  type ResearchAgentPreflightView,
  type ResearchAgentRunDetailView,
  type ResearchAgentRunSummaryView,
} from '../services/researchAgentRunManager'
import {
  RESEARCH_AGENT_MULTI_PERSPECTIVE_BUDGET,
  RESEARCH_AGENT_STANDARD_BUDGET,
  ResearchAgentRunRepositoryError,
} from '../database/researchAgentRunRepository'
import { ResearchAgentRunnerError } from '../services/researchAgentRunner'
import { ResearchAgentToolServiceError } from '../services/researchAgentToolService'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type ResearchAgentApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string }

export interface ResearchAgentStartRequest {
  requestId: string
  sessionId: number
  question: string
  subjects: Array<
    | { kind: 'stock'; tsCode: string; label?: string | null }
    | { kind: 'industry_project'; id: string; label?: string | null }
  >
  includePortfolio: boolean
  confirmedBudgetVersion: typeof RESEARCH_AGENT_STANDARD_BUDGET.id
  parentRunId?: string | null
}

export interface ResearchAgentDirectPreflightRequest {
  projectId?: string | null
}

export interface ResearchAgentStartDirectRequest {
  requestId: string
  question: string
  subjects: ResearchAgentStartRequest['subjects']
  includePortfolio: boolean
  projectId?: string | null
  confirmedBudgetVersion: typeof RESEARCH_AGENT_STANDARD_BUDGET.id
}

export interface ResearchAgentMutationRequest {
  requestId: string
  runId: string
}

export interface ResearchAgentRetryRequest {
  requestId: string
  sourceRunId: string
  confirmedBudgetVersion: typeof RESEARCH_AGENT_STANDARD_BUDGET.id
}

export interface ResearchAgentStartReviewRequest {
  requestId: string
  sourceRunId: string
  confirmedBudgetVersion: typeof RESEARCH_AGENT_MULTI_PERSPECTIVE_BUDGET.id
}

let manager: ResearchAgentRunManager | null = null

export function registerResearchAgentHandlers(getWindow: () => BrowserWindow | null): void {
  manager = new ResearchAgentRunManager(getDb(), { getWindow })
  const recovery = manager.initialize()
  if (recovery.count > 0) {
    console.info(`[ResearchAgent] paused ${recovery.count} expired run(s) at startup`)
  }

  ipcMain.handle('researchAgent:preflight', (event, payload: unknown) => safe(event, getWindow, () => {
    const value = exactRecord(payload, ['sessionId'])
    return requireManager().preflight(positiveInteger(value.sessionId, 'sessionId'))
  }))
  ipcMain.handle('researchAgent:preflightDirect', (event, payload: unknown) => safe(event, getWindow, () => {
    const value = exactRecord(payload ?? {}, ['projectId'])
    return requireManager().preflightDirect(nullableBoundedId(value.projectId, 'projectId'))
  }))
  ipcMain.handle('researchAgent:startRun', (event, payload: unknown) => safe(event, getWindow, () => {
    const value = exactRecord(payload, ['requestId', 'sessionId', 'question', 'subjects', 'includePortfolio', 'confirmedBudgetVersion', 'parentRunId'])
    if (value.confirmedBudgetVersion !== RESEARCH_AGENT_STANDARD_BUDGET.id) {
      throw new ResearchAgentRunManagerError('INVALID_PARAM', '必须确认当前固定研究预算版本')
    }
    return requireManager().start({
      requestId: uuid(value.requestId, 'requestId'),
      sessionId: positiveInteger(value.sessionId, 'sessionId'),
      question: boundedQuestion(value.question),
      subjects: boundedSubjects(value.subjects),
      includePortfolio: strictBoolean(value.includePortfolio, 'includePortfolio'),
      confirmedBudgetVersion: value.confirmedBudgetVersion,
      parentRunId: nullableUuid(value.parentRunId, 'parentRunId'),
    })
  }))
  ipcMain.handle('researchAgent:startDirect', (event, payload: unknown) => safe(event, getWindow, () => {
    const value = exactRecord(payload, ['requestId', 'question', 'subjects', 'includePortfolio', 'projectId', 'confirmedBudgetVersion'])
    if (value.confirmedBudgetVersion !== RESEARCH_AGENT_STANDARD_BUDGET.id) {
      throw new ResearchAgentRunManagerError('INVALID_PARAM', '必须确认当前固定研究预算版本')
    }
    return requireManager().startDirect({
      requestId: uuid(value.requestId, 'requestId'),
      question: boundedQuestion(value.question),
      subjects: boundedSubjects(value.subjects),
      includePortfolio: strictBoolean(value.includePortfolio, 'includePortfolio'),
      projectId: nullableBoundedId(value.projectId, 'projectId'),
      confirmedBudgetVersion: value.confirmedBudgetVersion,
    })
  }))
  ipcMain.handle('researchAgent:startReview', (event, payload: unknown) => safe(event, getWindow, () => {
    const value = exactRecord(payload, ['requestId', 'sourceRunId', 'confirmedBudgetVersion'])
    if (value.confirmedBudgetVersion !== RESEARCH_AGENT_MULTI_PERSPECTIVE_BUDGET.id) {
      throw new ResearchAgentRunManagerError('INVALID_PARAM', '必须确认当前多视角固定预算版本')
    }
    return requireManager().startReview({
      requestId: uuid(value.requestId, 'requestId'),
      sourceRunId: uuid(value.sourceRunId, 'sourceRunId'),
      confirmedBudgetVersion: value.confirmedBudgetVersion,
    })
  }))
  ipcMain.handle('researchAgent:listRuns', (event, payload: unknown) => safe(event, getWindow, () => {
    const value = exactRecord(payload ?? {}, ['sessionId'])
    return requireManager().list(value.sessionId == null ? null : positiveInteger(value.sessionId, 'sessionId'))
  }))
  ipcMain.handle('researchAgent:getRun', (event, payload: unknown) => safe(event, getWindow, () => {
    const value = exactRecord(payload, ['runId'])
    return requireManager().get(uuid(value.runId, 'runId'))
  }))
  ipcMain.handle('researchAgent:cancelRun', (event, payload: unknown) => safe(event, getWindow, () => {
    const value = exactRecord(payload, ['requestId', 'runId'])
    uuid(value.requestId, 'requestId')
    return requireManager().cancel(uuid(value.runId, 'runId'))
  }))
  ipcMain.handle('researchAgent:resumeRun', (event, payload: unknown) => safe(event, getWindow, () => {
    const value = exactRecord(payload, ['requestId', 'runId'])
    uuid(value.requestId, 'requestId')
    return requireManager().resume(uuid(value.runId, 'runId'))
  }))
  ipcMain.handle('researchAgent:retryRun', (event, payload: unknown) => safe(event, getWindow, () => {
    const value = exactRecord(payload, ['requestId', 'sourceRunId', 'confirmedBudgetVersion'])
    if (value.confirmedBudgetVersion !== RESEARCH_AGENT_STANDARD_BUDGET.id) {
      throw new ResearchAgentRunManagerError('INVALID_PARAM', '必须确认当前连续研究预算版本')
    }
    return requireManager().retry({
      requestId: uuid(value.requestId, 'requestId'),
      sourceRunId: uuid(value.sourceRunId, 'sourceRunId'),
      confirmedBudgetVersion: value.confirmedBudgetVersion,
    })
  }))
  ipcMain.handle('researchAgent:deleteRun', (event, payload: unknown) => safe(event, getWindow, () => {
    const value = exactRecord(payload, ['requestId', 'runId'])
    uuid(value.requestId, 'requestId')
    return requireManager().delete(uuid(value.runId, 'runId'))
  }))
}

export type ResearchAgentPreflightResponse = ResearchAgentApiResult<ResearchAgentPreflightView>
export type ResearchAgentStartResponse = ResearchAgentApiResult<{ run: ResearchAgentRunSummaryView; replayed: boolean }>
export type ResearchAgentStartDirectResponse = ResearchAgentApiResult<{
  run: ResearchAgentRunSummaryView
  replayed: boolean
  discussionSessionId: number
}>
export type ResearchAgentStartReviewResponse = ResearchAgentApiResult<{ run: ResearchAgentRunSummaryView; replayed: boolean }>
export type ResearchAgentListResponse = ResearchAgentApiResult<ResearchAgentRunSummaryView[]>
export type ResearchAgentDetailResponse = ResearchAgentApiResult<ResearchAgentRunDetailView>
export type ResearchAgentMutationResponse = ResearchAgentApiResult<ResearchAgentRunSummaryView>
export type ResearchAgentRetryResponse = ResearchAgentApiResult<{ run: ResearchAgentRunSummaryView; replayed: boolean }>
export type ResearchAgentDeleteResponse = ResearchAgentApiResult<{ deletedRunIds: string[]; discussionDeleted: boolean }>

function safe<T>(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null,
  action: () => T,
): ResearchAgentApiResult<T> {
  const window = getWindow()
  if (!window || event.sender !== window.webContents) {
    return { ok: false, code: 'UNAUTHORIZED', message: '研究运行请求来源无权访问' }
  }
  try {
    return { ok: true, data: action() }
  } catch (error) {
    if (
      error instanceof ResearchAgentRunManagerError
      || error instanceof ResearchAgentRunRepositoryError
      || error instanceof ResearchAgentRunnerError
      || error instanceof ResearchAgentToolServiceError
    ) {
      return { ok: false, code: error.code, message: error.message }
    }
    console.error('[researchAgent IPC]', error instanceof Error ? error.message : String(error))
    return { ok: false, code: 'INTERNAL_ERROR', message: '研究运行请求失败' }
  }
}

function requireManager(): ResearchAgentRunManager {
  if (!manager) throw new ResearchAgentRunManagerError('NOT_READY', '研究运行管理器尚未初始化')
  return manager
}

function exactRecord(value: unknown, allowedKeys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResearchAgentRunManagerError('INVALID_PARAM', '请求必须是对象')
  }
  const record = value as Record<string, unknown>
  const allowed = new Set(allowedKeys)
  const extra = Object.keys(record).filter((key) => !allowed.has(key))
  if (extra.length > 0) {
    throw new ResearchAgentRunManagerError('INVALID_PARAM', `包含不支持的字段：${extra.join('、')}`)
  }
  return record
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ResearchAgentRunManagerError('INVALID_PARAM', `${field} 必须是正整数`)
  }
  return Number(value)
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ResearchAgentRunManagerError('INVALID_PARAM', `${field} 必须是 UUID`)
  }
  return value.toLowerCase()
}

function nullableUuid(value: unknown, field: string): string | null {
  return value == null ? null : uuid(value, field)
}

function nullableBoundedId(value: unknown, field: string): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 128) {
    throw new ResearchAgentRunManagerError('INVALID_PARAM', `${field} 必须为1至128个字符`)
  }
  return value.trim()
}

function boundedQuestion(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 10 || value.trim().length > 4_000) {
    throw new ResearchAgentRunManagerError('INVALID_PARAM', '研究问题必须为 10 至 4000 个字符')
  }
  return value.trim()
}

function boundedSubjects(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) {
    throw new ResearchAgentRunManagerError('INVALID_PARAM', '研究主体必须包含 1 至 5 项')
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ResearchAgentRunManagerError('INVALID_PARAM', '研究主体必须是对象')
    }
    const kind = (item as Record<string, unknown>).kind
    if (kind === 'stock') return exactRecord(item, ['kind', 'tsCode', 'label'])
    if (kind === 'industry_project') return exactRecord(item, ['kind', 'id', 'label'])
    throw new ResearchAgentRunManagerError('INVALID_PARAM', '研究主体类型不受支持')
  })
}

function strictBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new ResearchAgentRunManagerError('INVALID_PARAM', `${field} 必须是布尔值`)
  return value
}
