import { randomUUID } from 'crypto'
import { connect, type Socket } from 'net'

const PROTOCOL_VERSION = '1'
const MAX_REQUEST_BYTES = 16 * 1024
const MAX_RESPONSE_BYTES = 256 * 1024
const REQUEST_TIMEOUT_MS = 15_000

export interface PipeClientConfig {
  pipePath: string
  profileId: string
  credential: string
  surface: 'mcp' | 'cli'
}

export interface PipeToolDefinition {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  toolId: string
  scope: string
}

interface WireResponse {
  id: string | null
  ok: boolean
  data?: Record<string, unknown>
  error?: { code: string; message: string }
}

interface PendingRequest {
  resolve: (value: WireResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class ResearchAccessPipeClient {
  private readonly socket: Socket
  private readonly pending = new Map<string, PendingRequest>()
  private buffer = Buffer.alloc(0)

  private constructor(socket: Socket) {
    this.socket = socket
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', (error) => this.rejectAll(error))
    socket.on('close', () => this.rejectAll(clientError('APP_NOT_RUNNING', '本地应用连接已关闭')))
  }

  static async connect(config: PipeClientConfig): Promise<ResearchAccessPipeClient> {
    const socket = await openSocket(config.pipePath)
    const client = new ResearchAccessPipeClient(socket)
    const response = await client.request({
      type: 'handshake',
      protocolVersion: PROTOCOL_VERSION,
      surface: config.surface,
      profileId: config.profileId,
      credential: config.credential,
      sessionId: randomUUID(),
    })
    if (!response.ok) {
      client.close()
      throw clientError(response.error?.code ?? 'UNAUTHORIZED', response.error?.message ?? '访问认证失败')
    }
    return client
  }

  async listTools(): Promise<PipeToolDefinition[]> {
    const response = await this.request({ type: 'tools.list' })
    if (!response.ok) throw clientError(response.error?.code ?? 'INTERNAL_ERROR', response.error?.message)
    const tools = response.data?.tools
    return Array.isArray(tools) ? tools as PipeToolDefinition[] : []
  }

  async callTool(name: string, input: unknown, requestId = randomUUID()): Promise<Record<string, unknown>> {
    const response = await this.request({ type: 'tools.call', requestId, name, input })
    const result = response.data?.result
    if (isRecord(result)) return result
    throw clientError(response.error?.code ?? 'INTERNAL_ERROR', response.error?.message)
  }

  close(): void {
    this.socket.end()
    this.socket.destroy()
  }

  private request(payload: Record<string, unknown>): Promise<WireResponse> {
    const id = randomUUID()
    const encoded = JSON.stringify({ id, ...payload })
    if (Buffer.byteLength(encoded, 'utf8') > MAX_REQUEST_BYTES) {
      return Promise.reject(clientError('INPUT_TOO_LARGE', '协议输入超过16 KiB上限'))
    }
    return new Promise<WireResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(clientError('REQUEST_TIMEOUT', '本地研究访问请求超时'))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.write(`${encoded}\n`)
    })
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (this.buffer.length > MAX_RESPONSE_BYTES && this.buffer.indexOf(0x0a) < 0) {
      this.rejectAll(clientError('RESULT_TOO_LARGE', '协议结果超过256 KiB上限'))
      this.socket.destroy()
      return
    }
    let newline = this.buffer.indexOf(0x0a)
    while (newline >= 0) {
      const frame = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      try {
        const response = JSON.parse(frame.toString('utf8')) as WireResponse
        if (typeof response.id === 'string') {
          const pending = this.pending.get(response.id)
          if (pending) {
            clearTimeout(pending.timer)
            this.pending.delete(response.id)
            pending.resolve(response)
          }
        }
      } catch {
        this.rejectAll(clientError('INVALID_RESPONSE', '本地研究访问返回了无效响应'))
        this.socket.destroy()
        return
      }
      newline = this.buffer.indexOf(0x0a)
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export function researchAccessClientConfigFromEnv(surface: 'mcp' | 'cli'): PipeClientConfig {
  const pipePath = process.env.TRADE_WATCH_PIPE
  const profileId = process.env.TRADE_WATCH_PROFILE_ID
  const credential = process.env.TRADE_WATCH_CREDENTIAL
  if (!pipePath || !profileId || !credential) {
    throw clientError('MISSING_CONFIG', '缺少TRADE_WATCH_PIPE、TRADE_WATCH_PROFILE_ID或TRADE_WATCH_CREDENTIAL')
  }
  return { pipePath, profileId, credential, surface }
}

function openSocket(pipePath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipePath)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(clientError('APP_NOT_RUNNING', '未连接到运行中的 RT-ResearchFlow'))
    }, 3_000)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      reject(clientError('APP_NOT_RUNNING', '未连接到运行中的 RT-ResearchFlow'))
    })
  })
}

function clientError(code: string, message = '本地研究访问失败'): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
