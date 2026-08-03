import type Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { chmodSync, existsSync, unlinkSync } from 'fs'
import { createServer, type Server, type Socket } from 'net'
import { join } from 'path'
import {
  executeResearchAccessTool,
  listAuthorizedResearchAccessTools,
  type ResearchAccessCaller,
  type ResearchAccessGatewayError,
} from './researchAccessGateway'

export const RESEARCH_ACCESS_PROTOCOL_VERSION = '1'
export const RESEARCH_ACCESS_SERVICE_VERSION = '1.0.0'
export const RESEARCH_ACCESS_PIPE_MAX_REQUEST_BYTES = 16 * 1024
export const RESEARCH_ACCESS_PIPE_MAX_RESPONSE_BYTES = 256 * 1024

export interface ResearchAccessTransportStatus {
  state: 'stopped' | 'starting' | 'ready' | 'failed'
  pipePath: string | null
  protocolVersion: string
  serviceVersion: string
  errorCode: string | null
}

type WireRequest = Record<string, unknown> & { id?: unknown; type?: unknown }
type WireError = ResearchAccessGatewayError | { code: 'PROTOCOL_MISMATCH'; message: string }

let transportServer: Server | null = null
let transportStatus: ResearchAccessTransportStatus = {
  state: 'stopped',
  pipePath: null,
  protocolVersion: RESEARCH_ACCESS_PROTOCOL_VERSION,
  serviceVersion: RESEARCH_ACCESS_SERVICE_VERSION,
  errorCode: null,
}

export function researchAccessPipePath(userDataPath: string): string {
  const suffix = createHash('sha256').update(userDataPath, 'utf8').digest('hex').slice(0, 20)
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\trade-watch-research-${suffix}`
    : join(userDataPath, `research-access-${suffix}.sock`)
}

export function getResearchAccessTransportStatus(): ResearchAccessTransportStatus {
  return { ...transportStatus }
}

export async function startResearchAccessTransport(
  db: Database.Database,
  userDataPath: string,
): Promise<ResearchAccessTransportStatus> {
  if (transportServer) return getResearchAccessTransportStatus()
  const pipePath = researchAccessPipePath(userDataPath)
  transportStatus = {
    state: 'starting',
    pipePath,
    protocolVersion: RESEARCH_ACCESS_PROTOCOL_VERSION,
    serviceVersion: RESEARCH_ACCESS_SERVICE_VERSION,
    errorCode: null,
  }

  if (process.platform !== 'win32' && existsSync(pipePath)) unlinkSync(pipePath)
  const server = createServer((socket) => handleConnection(db, socket))
  server.maxConnections = 16

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => reject(error)
      server.once('error', onError)
      server.listen(pipePath, () => {
        server.off('error', onError)
        resolve()
      })
    })
    if (process.platform !== 'win32') chmodSync(pipePath, 0o600)
    server.on('error', (error) => {
      console.warn('[ResearchAccess] Local transport error:', error instanceof Error ? error.message : String(error))
    })
    transportServer = server
    transportStatus = { ...transportStatus, state: 'ready' }
  } catch (error) {
    server.close()
    transportStatus = {
      ...transportStatus,
      state: 'failed',
      errorCode: transportErrorCode(error),
    }
  }
  return getResearchAccessTransportStatus()
}

export async function stopResearchAccessTransport(): Promise<void> {
  const server = transportServer
  const pipePath = transportStatus.pipePath
  transportServer = null
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  if (process.platform !== 'win32' && pipePath && existsSync(pipePath)) {
    try {
      unlinkSync(pipePath)
    } catch {
      // The operating system may already have removed the socket.
    }
  }
  transportStatus = {
    state: 'stopped',
    pipePath: null,
    protocolVersion: RESEARCH_ACCESS_PROTOCOL_VERSION,
    serviceVersion: RESEARCH_ACCESS_SERVICE_VERSION,
    errorCode: null,
  }
}

function handleConnection(db: Database.Database, socket: Socket): void {
  let buffer = Buffer.alloc(0)
  let caller: ResearchAccessCaller | null = null
  socket.setTimeout(5 * 60_000, () => socket.destroy())

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > RESEARCH_ACCESS_PIPE_MAX_REQUEST_BYTES && buffer.indexOf(0x0a) < 0) {
      writeWireResponse(socket, null, false, undefined, pipeError('INPUT_TOO_LARGE'))
      socket.destroy()
      return
    }

    let newline = buffer.indexOf(0x0a)
    while (newline >= 0) {
      const frame = buffer.subarray(0, newline)
      buffer = buffer.subarray(newline + 1)
      if (frame.length > 0) {
        if (frame.length > RESEARCH_ACCESS_PIPE_MAX_REQUEST_BYTES) {
          writeWireResponse(socket, null, false, undefined, pipeError('INPUT_TOO_LARGE'))
        } else {
          let request: WireRequest | null = null
          try {
            const parsed: unknown = JSON.parse(frame.toString('utf8'))
            request = isRecord(parsed) ? parsed : null
          } catch {
            request = null
          }
          if (!request) {
            writeWireResponse(socket, null, false, undefined, pipeError('INVALID_INPUT'))
          } else {
            caller = handleWireRequest(db, socket, request, caller)
          }
        }
      }
      newline = buffer.indexOf(0x0a)
    }
  })
}

function handleWireRequest(
  db: Database.Database,
  socket: Socket,
  request: WireRequest,
  caller: ResearchAccessCaller | null,
): ResearchAccessCaller | null {
  const id = typeof request.id === 'string' ? request.id : null
  if (!id || id.length > 100 || typeof request.type !== 'string') {
    writeWireResponse(socket, id, false, undefined, pipeError('INVALID_INPUT'))
    return caller
  }

  if (request.type === 'handshake') {
    if (
      request.protocolVersion !== RESEARCH_ACCESS_PROTOCOL_VERSION
      || (request.surface !== 'mcp' && request.surface !== 'cli')
    ) {
      writeWireResponse(socket, id, false, undefined, pipeError('PROTOCOL_MISMATCH'))
      return null
    }
    if (
      !isUuid(request.profileId)
      || typeof request.credential !== 'string'
      || request.credential.length > 128
      || !isUuid(request.sessionId)
    ) {
      writeWireResponse(socket, id, false, undefined, pipeError('UNAUTHORIZED'))
      return null
    }
    const nextCaller: ResearchAccessCaller = {
      profileId: request.profileId,
      credential: request.credential,
      surface: request.surface,
      sessionId: request.sessionId,
    }
    const listed = listAuthorizedResearchAccessTools(db, nextCaller)
    if (!listed.ok) {
      writeWireResponse(socket, id, false, undefined, listed.error)
      return null
    }
    writeWireResponse(socket, id, true, {
      protocolVersion: RESEARCH_ACCESS_PROTOCOL_VERSION,
      serviceVersion: RESEARCH_ACCESS_SERVICE_VERSION,
      profile: {
        id: listed.profile.id,
        name: listed.profile.name,
        scopes: listed.profile.scopes,
        credentialVersion: listed.profile.credentialVersion,
        scopeVersion: listed.profile.scopeVersion,
      },
      tools: listed.tools,
    })
    return nextCaller
  }

  if (!caller) {
    writeWireResponse(socket, id, false, undefined, pipeError('UNAUTHORIZED'))
    return null
  }

  if (request.type === 'tools.list') {
    const listed = listAuthorizedResearchAccessTools(db, caller)
    if (!listed.ok) {
      writeWireResponse(socket, id, false, undefined, listed.error)
      return null
    }
    writeWireResponse(socket, id, true, { tools: listed.tools })
    return caller
  }

  if (request.type === 'tools.call') {
    if (!isUuid(request.requestId) || typeof request.name !== 'string') {
      writeWireResponse(socket, id, false, undefined, pipeError('INVALID_INPUT'))
      return caller
    }
    const result = executeResearchAccessTool(db, caller, {
      requestId: request.requestId,
      externalToolName: request.name,
      input: request.input,
    })
    writeWireResponse(socket, id, result.ok, { result }, result.ok ? undefined : result.error)
    return !result.ok && result.error.code === 'UNAUTHORIZED' ? null : caller
  }

  writeWireResponse(socket, id, false, undefined, pipeError('INVALID_INPUT'))
  return caller
}

function writeWireResponse(
  socket: Socket,
  id: string | null,
  ok: boolean,
  data?: unknown,
  error?: WireError,
): void {
  let encoded = JSON.stringify({ id, ok, data, error })
  if (Buffer.byteLength(encoded, 'utf8') > RESEARCH_ACCESS_PIPE_MAX_RESPONSE_BYTES) {
    encoded = JSON.stringify({ id, ok: false, error: pipeError('RESULT_TOO_LARGE') })
  }
  socket.write(`${encoded}\n`)
}

function pipeError(code: ResearchAccessGatewayError['code'] | 'PROTOCOL_MISMATCH'): WireError {
  if (code === 'PROTOCOL_MISMATCH') {
    return { code, message: '本地研究访问协议版本不兼容' }
  }
  const messages: Record<ResearchAccessGatewayError['code'], string> = {
    UNAUTHORIZED: '访问凭据无效或配置不可用',
    SCOPE_DENIED: '当前访问配置未授权该工具',
    UNKNOWN_TOOL: '未知本地研究工具',
    INVALID_INPUT: '协议输入未通过白名单校验',
    FUTURE_AS_OF: '事实截点不能晚于北京时间当天',
    RATE_LIMITED: '调用频率超过当前访问配置上限',
    TOO_MANY_CONCURRENT_CALLS: '并发调用已达上限',
    INPUT_TOO_LARGE: '协议输入超过16 KiB上限',
    RESULT_TOO_LARGE: '协议结果超过256 KiB上限',
    DUPLICATE_REQUEST: 'requestId已经使用',
    INTERNAL_ERROR: '本地研究访问发生内部错误',
  }
  return { code, message: messages[code] }
}

function transportErrorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === 'string' ? error.code : 'TRANSPORT_START_FAILED'
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
