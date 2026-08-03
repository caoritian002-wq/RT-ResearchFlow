import { app, ipcMain } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { getDb } from '../database/db'
import {
  RESEARCH_ACCESS_SCOPES,
  ResearchAccessRepositoryError,
  createResearchAccessProfile,
  listResearchAccessAudit,
  listResearchAccessProfiles,
  revokeResearchAccessProfile,
  rotateResearchAccessCredential,
  updateResearchAccessProfile,
  type ResearchAccessAuditEntry,
  type ResearchAccessProfile,
  type ResearchAccessScope,
  type ResearchAccessSurface,
} from '../database/researchAccessRepository'
import { getResearchAccessTransportStatus } from '../services/researchAccessTransport'

const AUDIT_LIMITS = [20, 50, 100] as const
const AUDIT_STATUSES = ['available', 'partial', 'missing', 'blocked'] as const

export interface ResearchAccessAuditView {
  id: number
  requestId: string
  profileId: string | null
  profileName: string | null
  surface: ResearchAccessSurface
  externalToolName: string | null
  toolId: string | null
  asOf: string | null
  decision: 'allowed' | 'blocked'
  toolStatus: string | null
  errorCode: string | null
  durationMs: number
  resultBytes: number
  createdAt: number
}

export interface ResearchAccessWorkbench {
  endpoint: {
    state: 'stopped' | 'starting' | 'ready' | 'failed'
    protocolVersion: string
    serviceVersion: string
    errorCode: string | null
    adapterAvailable: boolean
    platform: NodeJS.Platform
  }
  profiles: ResearchAccessProfile[]
  audit: { items: ResearchAccessAuditView[]; nextCursor: number | null }
  scopes: Array<{
    id: ResearchAccessScope
    label: string
    description: string
    defaultEnabled: boolean
  }>
}

export interface ResearchAccessCredentialDelivery {
  profile: ResearchAccessProfile
  credential: string
  mcpConfig: string
  cliExamples: { doctor: string; tools: string; call: string }
}

export type ResearchAccessApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; message: string }

export interface ResearchAccessCreateRequest {
  requestId: string
  name: string
  scopes: ResearchAccessScope[]
}

export interface ResearchAccessUpdateRequest {
  requestId: string
  profileId: string
  name?: string
  scopes?: ResearchAccessScope[]
  enabled?: boolean
}

export interface ResearchAccessProfileOperationRequest {
  requestId: string
  profileId: string
}

export interface ResearchAccessAuditRequest {
  profileId?: string | null
  surface?: ResearchAccessSurface | null
  status?: string | null
  cursor?: number | null
  limit?: 20 | 50 | 100
}

export function registerResearchAccessHandlers(): void {
  ipcMain.handle('researchAccess:getWorkbench', () => safeResult(() => buildWorkbench()))

  ipcMain.handle('researchAccess:createProfile', (_event, payload: unknown) => safeResult(() => {
    const input = parseCreateRequest(payload)
    assertCredentialDeliveryAvailable()
    const created = createResearchAccessProfile(getDb(), input)
    if (!created.credential) throw new ResearchAccessRepositoryError(
      'CREDENTIAL_ALREADY_DELIVERED',
      '该requestId的一次性凭据已经返回，请使用新的requestId重试',
    )
    return credentialDelivery(created.profile, created.credential)
  }))

  ipcMain.handle('researchAccess:updateProfile', (_event, payload: unknown) => safeResult(() => {
    const input = parseUpdateRequest(payload)
    return updateResearchAccessProfile(getDb(), input)
  }))

  ipcMain.handle('researchAccess:rotateCredential', (_event, payload: unknown) => safeResult(() => {
    const input = parseProfileOperationRequest(payload)
    assertCredentialDeliveryAvailable()
    const rotated = rotateResearchAccessCredential(getDb(), input)
    if (!rotated.credential) throw new ResearchAccessRepositoryError(
      'CREDENTIAL_ALREADY_DELIVERED',
      '该requestId的一次性凭据已经返回，请使用新的requestId重试',
    )
    return credentialDelivery(rotated.profile, rotated.credential)
  }))

  ipcMain.handle('researchAccess:revokeProfile', (_event, payload: unknown) => safeResult(() => {
    return revokeResearchAccessProfile(getDb(), parseProfileOperationRequest(payload))
  }))

  ipcMain.handle('researchAccess:listAudit', (_event, payload: unknown) => safeResult(() => {
    const input = parseAuditRequest(payload)
    const page = listResearchAccessAudit(getDb(), {
      profileId: input.profileId,
      surface: input.surface,
      toolStatus: input.status,
      cursor: input.cursor,
      limit: input.limit,
    })
    return { items: page.items.map(toAuditView), nextCursor: page.nextCursor }
  }))
}

function buildWorkbench(): ResearchAccessWorkbench {
  const transport = getResearchAccessTransportStatus()
  const runtime = adapterRuntime()
  const audit = listResearchAccessAudit(getDb(), { limit: 50 })
  return {
    endpoint: {
      state: transport.state,
      protocolVersion: transport.protocolVersion,
      serviceVersion: transport.serviceVersion,
      errorCode: transport.errorCode,
      adapterAvailable: existsSync(runtime.scriptPath),
      platform: process.platform,
    },
    profiles: listResearchAccessProfiles(getDb()),
    audit: { items: audit.items.map(toAuditView), nextCursor: audit.nextCursor },
    scopes: [
      { id: 'market.read', label: '市场事实', description: '行情、趋势、基本面、公告标题和本地资讯', defaultEnabled: true },
      { id: 'research.read', label: '研究资料', description: '判断历史和产业项目不可变快照', defaultEnabled: false },
      { id: 'portfolio.read', label: '当前持仓', description: '当前持仓摘要，不伪装为历史快照', defaultEnabled: false },
    ],
  }
}

function credentialDelivery(profile: ResearchAccessProfile, credential: string): ResearchAccessCredentialDelivery {
  assertCredentialDeliveryAvailable()
  const transport = getResearchAccessTransportStatus()
  const runtime = adapterRuntime()
  const pipePath = transport.pipePath
  if (!pipePath) throw new ResearchAccessRepositoryError('ACCESS_DISABLED', '本机研究访问服务当前不可用')
  const env = {
    ELECTRON_RUN_AS_NODE: '1',
    TRADE_WATCH_PIPE: pipePath,
    TRADE_WATCH_PROFILE_ID: profile.id,
    TRADE_WATCH_CREDENTIAL: credential,
  }
  const mcpConfig = JSON.stringify({
    mcpServers: {
      'trade-watching': {
        command: runtime.command,
        args: [runtime.scriptPath, 'mcp'],
        env,
      },
    },
  }, null, 2)
  const prefix = Object.entries(env)
    .map(([key, value]) => `$env:${key}=${quotePowerShell(value)}`)
    .join('; ')
  const invoke = `& ${quotePowerShell(runtime.command)} ${quotePowerShell(runtime.scriptPath)}`
  return {
    profile,
    credential,
    mcpConfig,
    cliExamples: {
      doctor: `${prefix}; ${invoke} doctor`,
      tools: `${prefix}; ${invoke} tools`,
      call: `${prefix}; ${invoke} call stock_price_history '{"stockCode":"600519","limit":30}'`,
    },
  }
}

function assertCredentialDeliveryAvailable(): void {
  const transport = getResearchAccessTransportStatus()
  if (transport.state !== 'ready' || !transport.pipePath) {
    throw new ResearchAccessRepositoryError('ACCESS_DISABLED', '本机研究访问服务当前不可用')
  }
  if (!existsSync(adapterRuntime().scriptPath)) {
    throw new ResearchAccessRepositoryError('ADAPTER_NOT_BUILT', '本机研究访问适配器尚未构建')
  }
}

function adapterRuntime(): { command: string; scriptPath: string } {
  return {
    command: process.execPath,
    scriptPath: app.isPackaged
      ? join(process.resourcesPath, 'research-access', 'research-mcp.cjs')
      : join(__dirname, '..', 'research-access', 'research-mcp.cjs'),
  }
}

function parseCreateRequest(value: unknown): ResearchAccessCreateRequest {
  const record = exactRecord(value, ['requestId', 'name', 'scopes'])
  return {
    requestId: requireUuid(record.requestId, 'requestId'),
    name: requireName(record.name),
    scopes: requireScopes(record.scopes, false),
  }
}

function parseUpdateRequest(value: unknown): ResearchAccessUpdateRequest {
  const record = exactRecord(value, ['requestId', 'profileId', 'name', 'scopes', 'enabled'])
  const input: ResearchAccessUpdateRequest = {
    requestId: requireUuid(record.requestId, 'requestId'),
    profileId: requireUuid(record.profileId, 'profileId'),
  }
  if (record.name !== undefined) input.name = requireName(record.name)
  if (record.scopes !== undefined) input.scopes = requireScopes(record.scopes)
  if (record.enabled !== undefined) {
    if (typeof record.enabled !== 'boolean') invalid('enabled必须是布尔值')
    input.enabled = record.enabled
  }
  if (input.name === undefined && input.scopes === undefined && input.enabled === undefined) invalid('没有可更新字段')
  return input
}

function parseProfileOperationRequest(value: unknown): ResearchAccessProfileOperationRequest {
  const record = exactRecord(value, ['requestId', 'profileId'])
  return {
    requestId: requireUuid(record.requestId, 'requestId'),
    profileId: requireUuid(record.profileId, 'profileId'),
  }
}

function parseAuditRequest(value: unknown): ResearchAccessAuditRequest {
  const record = exactRecord(value ?? {}, ['profileId', 'surface', 'status', 'cursor', 'limit'])
  const input: ResearchAccessAuditRequest = {}
  if (record.profileId != null) input.profileId = requireUuid(record.profileId, 'profileId')
  if (record.surface != null) {
    if (record.surface !== 'mcp' && record.surface !== 'cli') invalid('surface无效')
    input.surface = record.surface
  }
  if (record.status != null) {
    if (typeof record.status !== 'string' || !AUDIT_STATUSES.includes(record.status as typeof AUDIT_STATUSES[number])) invalid('status无效')
    input.status = record.status
  }
  if (record.cursor != null) {
    if (!Number.isSafeInteger(record.cursor) || Number(record.cursor) <= 0) invalid('cursor无效')
    input.cursor = Number(record.cursor)
  }
  if (record.limit != null) {
    if (!AUDIT_LIMITS.includes(record.limit as typeof AUDIT_LIMITS[number])) invalid('limit无效')
    input.limit = record.limit as 20 | 50 | 100
  }
  return input
}

function toAuditView(entry: ResearchAccessAuditEntry): ResearchAccessAuditView {
  return {
    id: entry.id,
    requestId: entry.requestId,
    profileId: entry.profileId ?? null,
    profileName: entry.profileNameSnapshot ?? null,
    surface: entry.surface,
    externalToolName: entry.externalToolName ?? null,
    toolId: entry.toolId ?? null,
    asOf: entry.asOf ?? null,
    decision: entry.decision,
    toolStatus: entry.toolStatus ?? null,
    errorCode: entry.errorCode ?? null,
    durationMs: entry.durationMs,
    resultBytes: entry.resultBytes,
    createdAt: entry.createdAt,
  }
}

function exactRecord(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!isRecord(value)) invalid('请求必须是JSON对象')
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid('请求包含未授权字段')
  return value
}

function requireScopes(value: unknown, allowEmpty = true): ResearchAccessScope[] {
  if (!Array.isArray(value) || value.length > RESEARCH_ACCESS_SCOPES.length) invalid('scopes无效')
  if (!allowEmpty && value.length === 0) invalid('创建配置时至少需要一个权限')
  if (value.some((scope) => typeof scope !== 'string' || !RESEARCH_ACCESS_SCOPES.includes(scope as ResearchAccessScope))) invalid('scopes无效')
  if (new Set(value).size !== value.length) invalid('scopes不能重复')
  return RESEARCH_ACCESS_SCOPES.filter((scope) => value.includes(scope))
}

function requireName(value: unknown): string {
  if (typeof value !== 'string') invalid('name无效')
  const name = value.trim()
  if (name.length < 1 || name.length > 60) invalid('name长度必须为1到60个字符')
  return name
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    invalid(`${field}必须是UUID`)
  }
  return value
}

function safeResult<T>(operation: () => T): ResearchAccessApiResult<T> {
  try {
    return { ok: true, data: operation() }
  } catch (error) {
    const code = error instanceof ResearchAccessRepositoryError ? error.code : 'INVALID_REQUEST'
    const message = error instanceof ResearchAccessRepositoryError ? error.message : '本机研究访问请求未通过校验'
    return { ok: false, error: code, message }
  }
}

function invalid(message: string): never {
  throw new ResearchAccessRepositoryError('INVALID_REQUEST', message)
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
