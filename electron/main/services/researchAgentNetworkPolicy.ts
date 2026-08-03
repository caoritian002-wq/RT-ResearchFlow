import { createHash } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import {
  brotliDecompressSync,
  gunzipSync,
  inflateRawSync,
  inflateSync,
} from 'node:zlib'

export const RESEARCH_AGENT_NETWORK_POLICY_VERSION = 'research-agent-network.v2'

export const RESEARCH_AGENT_NETWORK_LIMITS = Object.freeze({
  connectTimeoutMs: 10_000,
  totalTimeoutMs: 120_000,
  maxRedirects: 5,
  maxRequestBodyBytes: 256 * 1024,
  maxCompressedResponseBytes: 64 * 1024 * 1024,
  maxDecodedResponseBytes: 128 * 1024 * 1024,
})

export type ResearchAgentNetworkMethod = 'GET' | 'HEAD' | 'POST'
export type ResearchAgentNetworkMimeKind = 'html' | 'text' | 'json' | 'xml' | 'pdf'
export type ResearchAgentNetworkErrorCode =
  | 'NETWORK_ABORTED'
  | 'NETWORK_ADDRESS_BLOCKED'
  | 'NETWORK_CONNECT_TIMEOUT'
  | 'NETWORK_CREDENTIALS_NOT_ALLOWED'
  | 'NETWORK_DNS_FAILED'
  | 'NETWORK_ENCODING_NOT_ALLOWED'
  | 'NETWORK_HEADERS_INVALID'
  | 'NETWORK_HOST_BLOCKED'
  | 'NETWORK_MIME_NOT_ALLOWED'
  | 'NETWORK_REDIRECT_INVALID'
  | 'NETWORK_REDIRECT_LIMIT'
  | 'NETWORK_REDIRECT_UNSAFE'
  | 'NETWORK_REQUEST_BODY_TOO_LARGE'
  | 'NETWORK_REQUEST_FAILED'
  | 'NETWORK_RESPONSE_INVALID'
  | 'NETWORK_RESPONSE_TOO_LARGE'
  | 'NETWORK_TOTAL_TIMEOUT'
  | 'NETWORK_URL_INVALID'
  | 'NETWORK_URL_PROTOCOL_NOT_ALLOWED'

export interface ResearchAgentNetworkRequest {
  url: string
  method?: ResearchAgentNetworkMethod
  headers?: Readonly<Record<string, string>>
  body?: string | Buffer | null
  acceptedMimeKinds?: readonly ResearchAgentNetworkMimeKind[]
  signal?: AbortSignal
}

export interface ResearchAgentNetworkHopEnvelope {
  url: string
  resolvedAddresses: string[]
  statusCode: number
  redirectTo: string | null
}

export interface ResearchAgentNetworkEnvelope {
  version: typeof RESEARCH_AGENT_NETWORK_POLICY_VERSION
  request: {
    method: ResearchAgentNetworkMethod
    url: string
    headerNames: string[]
    bodyBytes: number
    bodySha256: string | null
  }
  response: {
    finalUrl: string
    statusCode: number
    contentType: string
    mimeKind: ResearchAgentNetworkMimeKind
    contentEncoding: string
    fetchedAt: number
    compressedBytes: number
    decodedBytes: number
    bodySha256: string
  }
  hops: ResearchAgentNetworkHopEnvelope[]
  envelopeSha256: string
}

export interface ResearchAgentNetworkResponse {
  envelope: ResearchAgentNetworkEnvelope
  body: Buffer
}

export class ResearchAgentNetworkError extends Error {
  constructor(
    public readonly code: ResearchAgentNetworkErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'ResearchAgentNetworkError'
  }
}

interface ResolvedAddress {
  address: string
  family: 4 | 6
}

interface TransportRequest {
  url: URL
  method: ResearchAgentNetworkMethod
  headers: Readonly<Record<string, string>>
  body: Buffer | null
  resolvedAddress: ResolvedAddress
  connectTimeoutMs: number
  signal: AbortSignal
}

interface TransportResponse {
  statusCode: number
  headers: Readonly<Record<string, string | readonly string[] | undefined>>
  body: AsyncIterable<Buffer | Uint8Array | string>
  destroy(error?: Error): void
}

interface ResearchAgentNetworkDependencies {
  resolveHostname(hostname: string, signal: AbortSignal): Promise<ResolvedAddress[]>
  requestHop(input: TransportRequest): Promise<TransportResponse>
  now(): number
  limits: typeof RESEARCH_AGENT_NETWORK_LIMITS
}

const FIXED_USER_AGENT = 'tradeWatching-research-agent/1.0'
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308])
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie',
  'host',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const CROSS_ORIGIN_REDIRECT_HEADERS = new Set(['accept', 'accept-language'])
const LOCAL_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
])
const SENSITIVE_QUERY_KEY = /(?:^|[_-])(?:api[_-]?key|access[_-]?token|auth|authorization|credential|password|secret|signature|token)(?:$|[_-])/i

export function isPublicResearchAgentAddress(address: string): boolean {
  const normalized = normalizeIpLiteral(address)
  const family = isIP(normalized)
  if (family === 4) return isPublicIpv4(normalized)
  if (family !== 6) return false
  const words = parseIpv6(normalized)
  if (!words) return false
  const mappedIpv4 = mappedIpv4FromWords(words)
  if (mappedIpv4) return isPublicIpv4(mappedIpv4)
  if ((words[0] & 0xe000) !== 0x2000) return false
  if (words[0] === 0x2002) return false
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false
  if (words[0] === 0x2001 && words[1] === 0x0002) return false
  if (words[0] === 0x2001 && words[1] === 0x0000) return false
  if (words[0] === 0x2001 && (words[1] & 0xfff0) === 0x0010) return false
  if (words[0] === 0x2001 && (words[1] & 0xfff0) === 0x0020) return false
  return true
}

export function createResearchAgentNetworkClient(
  overrides: Partial<ResearchAgentNetworkDependencies> = {},
): (request: ResearchAgentNetworkRequest) => Promise<ResearchAgentNetworkResponse> {
  const dependencies: ResearchAgentNetworkDependencies = {
    resolveHostname: defaultResolveHostname,
    requestHop: defaultRequestHop,
    now: Date.now,
    limits: RESEARCH_AGENT_NETWORK_LIMITS,
    ...overrides,
  }

  return async (request) => executeRequest(request, dependencies)
}

export const requestResearchAgentNetwork = createResearchAgentNetworkClient()

async function executeRequest(
  input: ResearchAgentNetworkRequest,
  dependencies: ResearchAgentNetworkDependencies,
): Promise<ResearchAgentNetworkResponse> {
  const limits = validateLimits(dependencies.limits)
  const method = input.method ?? 'GET'
  const initialUrl = parseAndValidateUrl(input.url)
  const initialHeaders = normalizeRequestHeaders(input.headers)
  const initialBody = normalizeRequestBody(method, input.body, limits.maxRequestBodyBytes)
  assertPlainHttpRequestIsAnonymous(initialUrl, initialHeaders, initialBody)
  const acceptedMimeKinds = normalizeAcceptedMimeKinds(input.acceptedMimeKinds)
  const operation = createOperationSignal(input.signal, limits.totalTimeoutMs)

  try {
    let currentUrl = initialUrl
    let currentMethod = method
    let currentHeaders = initialHeaders
    let currentBody = initialBody
    const hops: ResearchAgentNetworkHopEnvelope[] = []

    for (let redirectCount = 0; ; redirectCount += 1) {
      throwIfAborted(operation.signal)
      const resolvedAddresses = await resolveAndValidateDestination(
        currentUrl,
        operation.signal,
        dependencies.resolveHostname,
      )
      throwIfAborted(operation.signal)
      const response = await dependencies.requestHop({
        url: currentUrl,
        method: currentMethod,
        headers: withFixedHeaders(currentHeaders),
        body: currentBody,
        resolvedAddress: resolvedAddresses[0],
        connectTimeoutMs: limits.connectTimeoutMs,
        signal: operation.signal,
      })
      throwIfAborted(operation.signal)
      if (!Number.isSafeInteger(response.statusCode) || response.statusCode < 100 || response.statusCode > 599) {
        response.destroy()
        throw new ResearchAgentNetworkError('NETWORK_RESPONSE_INVALID', '研究联网响应状态码无效')
      }

      const location = getSingleHeader(response.headers, 'location')
      if (REDIRECT_STATUS_CODES.has(response.statusCode)) {
        response.destroy()
        if (redirectCount >= limits.maxRedirects) {
          throw new ResearchAgentNetworkError('NETWORK_REDIRECT_LIMIT', '联网请求超过重定向次数上限')
        }
        if (!location) {
          throw new ResearchAgentNetworkError('NETWORK_REDIRECT_INVALID', '重定向响应缺少唯一 Location')
        }
        const nextUrl = parseRedirectUrl(location, currentUrl)
        if (currentUrl.protocol === 'https:' && nextUrl.protocol !== 'https:') {
          throw new ResearchAgentNetworkError('NETWORK_REDIRECT_UNSAFE', 'HTTPS研究请求不得降级重定向到HTTP')
        }
        const crossOrigin = nextUrl.origin !== currentUrl.origin
        if (crossOrigin && currentBody != null && (response.statusCode === 307 || response.statusCode === 308)) {
          throw new ResearchAgentNetworkError('NETWORK_REDIRECT_UNSAFE', '跨站重定向不得转发请求正文或认证信息')
        }
        const nextRequest = redirectRequest(
          currentMethod,
          currentHeaders,
          currentBody,
          response.statusCode,
          crossOrigin,
        )
        hops.push({
          url: redactUrlForAudit(currentUrl),
          resolvedAddresses: resolvedAddresses.map((item) => item.address),
          statusCode: response.statusCode,
          redirectTo: redactUrlForAudit(nextUrl),
        })
        currentUrl = nextUrl
        currentMethod = nextRequest.method
        currentHeaders = nextRequest.headers
        currentBody = nextRequest.body
        assertPlainHttpRequestIsAnonymous(currentUrl, currentHeaders, currentBody)
        continue
      }

      const contentType = normalizeContentType(getSingleHeader(response.headers, 'content-type'))
      const mimeKind = classifyMime(contentType)
      if (!mimeKind || !acceptedMimeKinds.has(mimeKind)) {
        response.destroy()
        throw new ResearchAgentNetworkError(
          'NETWORK_MIME_NOT_ALLOWED',
          `响应 MIME 不在研究出口白名单内：${contentType || 'missing'}`,
          { contentType: contentType || null },
        )
      }
      const rawContentEncoding = response.headers['content-encoding']
      if (Array.isArray(rawContentEncoding) && rawContentEncoding.length !== 1) {
        response.destroy()
        throw new ResearchAgentNetworkError('NETWORK_ENCODING_NOT_ALLOWED', '响应包含多个压缩编码头')
      }
      const contentEncoding = normalizeContentEncoding(getSingleHeader(response.headers, 'content-encoding'))
      if (!contentEncoding) {
        response.destroy()
        throw new ResearchAgentNetworkError('NETWORK_ENCODING_NOT_ALLOWED', '响应使用了不支持的压缩编码')
      }
      const compressedBody = await collectResponseBody(
        response,
        limits.maxCompressedResponseBytes,
        operation.signal,
      )
      const body = decodeResponseBody(compressedBody, contentEncoding, limits.maxDecodedResponseBytes)
      throwIfAborted(operation.signal)
      hops.push({
        url: redactUrlForAudit(currentUrl),
        resolvedAddresses: resolvedAddresses.map((item) => item.address),
        statusCode: response.statusCode,
        redirectTo: null,
      })
      const envelopeWithoutHash = {
        version: RESEARCH_AGENT_NETWORK_POLICY_VERSION as typeof RESEARCH_AGENT_NETWORK_POLICY_VERSION,
        request: {
          method,
          url: redactUrlForAudit(initialUrl),
          headerNames: Object.keys(initialHeaders).sort(),
          bodyBytes: initialBody?.byteLength ?? 0,
          bodySha256: initialBody ? sha256(initialBody) : null,
        },
        response: {
          finalUrl: redactUrlForAudit(currentUrl),
          statusCode: response.statusCode,
          contentType,
          mimeKind,
          contentEncoding,
          fetchedAt: dependencies.now(),
          compressedBytes: compressedBody.byteLength,
          decodedBytes: body.byteLength,
          bodySha256: sha256(body),
        },
        hops,
      }
      const envelopeSha256 = sha256(stableJson(envelopeWithoutHash))
      return {
        body,
        envelope: { ...envelopeWithoutHash, envelopeSha256 },
      }
    }
  } catch (error) {
    throw normalizeNetworkError(error, operation.signal)
  } finally {
    operation.dispose()
  }
}

async function resolveAndValidateDestination(
  url: URL,
  signal: AbortSignal,
  resolver: ResearchAgentNetworkDependencies['resolveHostname'],
): Promise<ResolvedAddress[]> {
  const hostname = normalizeHostname(url.hostname)
  if (LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new ResearchAgentNetworkError('NETWORK_HOST_BLOCKED', '本机或本地域名不可用于研究联网')
  }
  const literalFamily = isIP(hostname)
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await resolver(hostname, signal)
  if (!addresses.length) {
    throw new ResearchAgentNetworkError('NETWORK_DNS_FAILED', '域名没有可用的 DNS 结果')
  }
  const normalized = addresses.map((item) => ({
    address: normalizeIpLiteral(item.address),
    family: item.family,
  }))
  for (const item of normalized) {
    if (isIP(item.address) !== item.family || !isPublicResearchAgentAddress(item.address)) {
      throw new ResearchAgentNetworkError(
        'NETWORK_ADDRESS_BLOCKED',
        '域名解析到了非公网或保留地址',
        { address: item.address },
      )
    }
  }
  return deduplicateAddresses(normalized)
}

async function defaultResolveHostname(hostname: string, signal: AbortSignal): Promise<ResolvedAddress[]> {
  try {
    const result = await raceAbort(
      dnsLookup(hostname, { all: true, verbatim: true }),
      signal,
    )
    return result.map((item) => ({ address: item.address, family: item.family as 4 | 6 }))
  } catch (error) {
    throwIfAborted(signal)
    throw new ResearchAgentNetworkError(
      'NETWORK_DNS_FAILED',
      '研究联网域名解析失败',
      { cause: safeErrorCode(error) },
    )
  }
}

function defaultRequestHop(input: TransportRequest): Promise<TransportResponse> {
  return new Promise((resolve, reject) => {
    let connectionTimer: ReturnType<typeof setTimeout> | null = null
    const clearConnectionTimer = () => {
      if (connectionTimer) clearTimeout(connectionTimer)
      connectionTimer = null
    }
    const lookup: NonNullable<RequestOptions['lookup']> = (_hostname, options, callback) => {
      if (typeof options === 'object' && options.all) {
        const allCallback = callback as unknown as (
          error: NodeJS.ErrnoException | null,
          addresses: Array<{ address: string; family: number }>,
        ) => void
        allCallback(null, [input.resolvedAddress])
        return
      }
      const oneCallback = callback as unknown as (
        error: NodeJS.ErrnoException | null,
        address: string,
        family: number,
      ) => void
      oneCallback(null, input.resolvedAddress.address, input.resolvedAddress.family)
    }
    const request = (input.url.protocol === 'https:' ? httpsRequest : httpRequest)(input.url, {
      agent: false,
      method: input.method,
      headers: input.headers,
      lookup,
      signal: input.signal,
    }, (response) => {
      resolve({
        statusCode: response.statusCode ?? 0,
        headers: normalizeIncomingHeaders(response.headers),
        body: response,
        destroy: (error?: Error) => response.destroy(error),
      })
    })
    request.once('socket', (socket) => {
      if (!socket.connecting) return
      connectionTimer = setTimeout(() => {
        request.destroy(new ResearchAgentNetworkError('NETWORK_CONNECT_TIMEOUT', '研究联网连接超时'))
      }, input.connectTimeoutMs)
      socket.once(input.url.protocol === 'https:' ? 'secureConnect' : 'connect', clearConnectionTimer)
      socket.once('error', clearConnectionTimer)
    })
    request.once('close', clearConnectionTimer)
    request.once('error', (error) => {
      clearConnectionTimer()
      reject(error)
    })
    if (input.body) request.write(input.body)
    request.end()
  })
}

function parseAndValidateUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ResearchAgentNetworkError('NETWORK_URL_INVALID', '研究联网 URL 无效')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ResearchAgentNetworkError('NETWORK_URL_PROTOCOL_NOT_ALLOWED', '研究联网只允许 HTTP 或 HTTPS')
  }
  if (url.username || url.password) {
    throw new ResearchAgentNetworkError('NETWORK_CREDENTIALS_NOT_ALLOWED', '研究联网 URL 不得携带用户名或密码')
  }
  if (!url.hostname || url.hostname.includes('%')) {
    throw new ResearchAgentNetworkError('NETWORK_URL_INVALID', '研究联网 URL 主机名无效')
  }
  return url
}

function parseRedirectUrl(location: string, currentUrl: URL): URL {
  try {
    return parseAndValidateUrl(new URL(location, currentUrl).toString())
  } catch (error) {
    if (error instanceof ResearchAgentNetworkError) throw error
    throw new ResearchAgentNetworkError('NETWORK_REDIRECT_INVALID', '重定向 Location 无效')
  }
}

function normalizeRequestHeaders(headers: ResearchAgentNetworkRequest['headers']): Record<string, string> {
  const normalized: Record<string, string> = {}
  const entries = Object.entries(headers ?? {})
  if (entries.length > 32) {
    throw new ResearchAgentNetworkError('NETWORK_HEADERS_INVALID', '研究联网请求头数量超过上限')
  }
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim().toLowerCase()
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || rawValue.length > 8_192 || /[\r\n]/.test(rawValue)) {
      throw new ResearchAgentNetworkError('NETWORK_HEADERS_INVALID', '研究联网请求头无效')
    }
    if (FORBIDDEN_REQUEST_HEADERS.has(name)) {
      throw new ResearchAgentNetworkError(
        name === 'cookie' || name === 'proxy-authorization'
          ? 'NETWORK_CREDENTIALS_NOT_ALLOWED'
          : 'NETWORK_HEADERS_INVALID',
        `研究联网不得设置请求头：${name}`,
      )
    }
    normalized[name] = rawValue.trim()
  }
  return normalized
}

function withFixedHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  return {
    ...headers,
    'accept-encoding': 'gzip, deflate, br',
    'user-agent': FIXED_USER_AGENT,
  }
}

function assertPlainHttpRequestIsAnonymous(
  url: URL,
  headers: Readonly<Record<string, string>>,
  body: Buffer | null,
): void {
  if (url.protocol !== 'http:') return
  const unsafeHeader = Object.keys(headers).find((name) => !CROSS_ORIGIN_REDIRECT_HEADERS.has(name))
  if (body != null || unsafeHeader) {
    throw new ResearchAgentNetworkError(
      'NETWORK_CREDENTIALS_NOT_ALLOWED',
      '明文HTTP研究请求不得携带正文或自定义敏感头',
    )
  }
}

function normalizeRequestBody(
  method: ResearchAgentNetworkMethod,
  body: ResearchAgentNetworkRequest['body'],
  maximumBytes: number,
): Buffer | null {
  if (body == null) return null
  if (method === 'GET' || method === 'HEAD') {
    throw new ResearchAgentNetworkError('NETWORK_REQUEST_BODY_TOO_LARGE', `${method} 请求不得携带正文`)
  }
  const buffer = Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(body, 'utf8')
  if (buffer.byteLength > maximumBytes) {
    throw new ResearchAgentNetworkError('NETWORK_REQUEST_BODY_TOO_LARGE', '研究联网请求正文超过字节上限')
  }
  return buffer
}

function redirectRequest(
  method: ResearchAgentNetworkMethod,
  headers: Readonly<Record<string, string>>,
  body: Buffer | null,
  statusCode: number,
  crossOrigin: boolean,
): { method: ResearchAgentNetworkMethod; headers: Record<string, string>; body: Buffer | null } {
  const switchesToGet = statusCode === 303 || ((statusCode === 301 || statusCode === 302) && method === 'POST')
  const nextHeaders = Object.fromEntries(
    Object.entries(headers).filter(([name]) => !crossOrigin || CROSS_ORIGIN_REDIRECT_HEADERS.has(name)),
  )
  if (switchesToGet) {
    delete nextHeaders['content-type']
    return { method: 'GET', headers: nextHeaders, body: null }
  }
  return { method, headers: nextHeaders, body }
}

function normalizeAcceptedMimeKinds(
  values: ResearchAgentNetworkRequest['acceptedMimeKinds'],
): Set<ResearchAgentNetworkMimeKind> {
  const allowed = new Set<ResearchAgentNetworkMimeKind>(['html', 'text', 'json', 'xml', 'pdf'])
  if (values == null) return allowed
  if (!values.length || values.some((value) => !allowed.has(value))) {
    throw new ResearchAgentNetworkError('NETWORK_MIME_NOT_ALLOWED', '请求的 MIME 范围无效')
  }
  return new Set(values)
}

function classifyMime(contentType: string): ResearchAgentNetworkMimeKind | null {
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') return 'html'
  if (contentType === 'text/plain') return 'text'
  if (contentType === 'application/json' || contentType.endsWith('+json')) return 'json'
  if (
    contentType === 'application/xml'
    || contentType === 'text/xml'
    || contentType.endsWith('+xml')
  ) return 'xml'
  if (contentType === 'application/pdf') return 'pdf'
  return null
}

function normalizeContentType(value: string | null): string {
  return (value ?? '').split(';', 1)[0].trim().toLowerCase()
}

function normalizeContentEncoding(value: string | null): string | null {
  const normalized = (value ?? 'identity').trim().toLowerCase()
  if (!normalized || normalized === 'identity') return 'identity'
  if (normalized === 'gzip' || normalized === 'x-gzip') return 'gzip'
  if (normalized === 'deflate' || normalized === 'br') return normalized
  return null
}

async function collectResponseBody(
  response: TransportResponse,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const rawChunk of response.body) {
      throwIfAborted(signal)
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
      total += chunk.byteLength
      if (total > maximumBytes) {
        throw new ResearchAgentNetworkError('NETWORK_RESPONSE_TOO_LARGE', '压缩响应超过研究联网字节上限')
      }
      chunks.push(chunk)
    }
  } catch (error) {
    response.destroy(error instanceof Error ? error : undefined)
    throw error
  }
  return Buffer.concat(chunks, total)
}

function decodeResponseBody(body: Buffer, encoding: string, maximumBytes: number): Buffer {
  try {
    let decoded: Buffer
    if (encoding === 'gzip') decoded = gunzipSync(body, { maxOutputLength: maximumBytes })
    else if (encoding === 'br') decoded = brotliDecompressSync(body, { maxOutputLength: maximumBytes })
    else if (encoding === 'deflate') {
      try {
        decoded = inflateSync(body, { maxOutputLength: maximumBytes })
      } catch (error) {
        if (isZlibOutputTooLarge(error)) throw error
        decoded = inflateRawSync(body, { maxOutputLength: maximumBytes })
      }
    } else decoded = body
    if (decoded.byteLength > maximumBytes) {
      throw new ResearchAgentNetworkError('NETWORK_RESPONSE_TOO_LARGE', '解压响应超过研究联网字节上限')
    }
    return decoded
  } catch (error) {
    if (error instanceof ResearchAgentNetworkError) throw error
    const code = safeErrorCode(error)
    if (isZlibOutputTooLarge(error)) {
      throw new ResearchAgentNetworkError('NETWORK_RESPONSE_TOO_LARGE', '解压响应超过研究联网字节上限')
    }
    throw new ResearchAgentNetworkError('NETWORK_RESPONSE_INVALID', '研究联网响应解压失败', { cause: code })
  }
}

function createOperationSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal
  dispose(): void
} {
  const controller = new AbortController()
  const abortFromParent = () => controller.abort(
    new ResearchAgentNetworkError('NETWORK_ABORTED', '研究联网已取消'),
  )
  if (parent?.aborted) abortFromParent()
  else parent?.addEventListener('abort', abortFromParent, { once: true })
  const timer = setTimeout(() => controller.abort(
    new ResearchAgentNetworkError('NETWORK_TOTAL_TIMEOUT', '研究联网超过总超时'),
  ), timeoutMs)
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', abortFromParent)
    },
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason instanceof ResearchAgentNetworkError) throw signal.reason
  throw new ResearchAgentNetworkError('NETWORK_ABORTED', '研究联网已取消')
}

function normalizeNetworkError(error: unknown, signal: AbortSignal): ResearchAgentNetworkError {
  if (signal.aborted) {
    try { throwIfAborted(signal) } catch (abortError) {
      return abortError as ResearchAgentNetworkError
    }
  }
  if (error instanceof ResearchAgentNetworkError) return error
  if (safeErrorCode(error) === 'ABORT_ERR') {
    return new ResearchAgentNetworkError('NETWORK_ABORTED', '研究联网已取消')
  }
  return new ResearchAgentNetworkError(
    'NETWORK_REQUEST_FAILED',
    '研究联网请求失败',
    { cause: safeErrorCode(error) },
  )
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function normalizeIncomingHeaders(headers: IncomingHttpHeaders): Record<string, string | readonly string[] | undefined> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
}

function getSingleHeader(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  name: string,
): string | null {
  const value = headers[name]
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null
  return typeof value === 'string' ? value : null
}

function normalizeHostname(hostname: string): string {
  return normalizeIpLiteral(hostname.trim().replace(/\.$/, '').toLowerCase())
}

function normalizeIpLiteral(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
}

function deduplicateAddresses(addresses: readonly ResolvedAddress[]): ResolvedAddress[] {
  const seen = new Set<string>()
  return addresses.filter((item) => {
    const key = `${item.family}:${item.address}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const value = (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0
  const blocked: Array<[number, number]> = [
    [0x00000000, 8],
    [0x0a000000, 8],
    [0x64400000, 10],
    [0x7f000000, 8],
    [0xa9fe0000, 16],
    [0xac100000, 12],
    [0xc0000000, 24],
    [0xc0000200, 24],
    [0xc0586300, 24],
    [0xc0a80000, 16],
    [0xc6120000, 15],
    [0xc6336400, 24],
    [0xcb007100, 24],
    [0xe0000000, 4],
    [0xf0000000, 4],
  ]
  return !blocked.some(([network, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    return (value & mask) >>> 0 === (network & mask) >>> 0
  })
}

function parseIpv6(address: string): number[] | null {
  if (address.includes('%')) return null
  let normalized = address.toLowerCase()
  const ipv4Match = normalized.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (ipv4Match) {
    const parts = ipv4Match[1].split('.').map(Number)
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
    const suffix = `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`
    normalized = `${normalized.slice(0, -ipv4Match[1].length)}${suffix}`
  }
  if ((normalized.match(/::/g) ?? []).length > 1) return null
  const [leftRaw, rightRaw] = normalized.split('::')
  const left = leftRaw ? leftRaw.split(':') : []
  const right = rightRaw ? rightRaw.split(':') : []
  if (left.some((part) => !/^[a-f0-9]{1,4}$/.test(part)) || right.some((part) => !/^[a-f0-9]{1,4}$/.test(part))) return null
  if (!normalized.includes('::') && left.length !== 8) return null
  const missing = 8 - left.length - right.length
  if (missing < (normalized.includes('::') ? 1 : 0)) return null
  return [...left, ...Array(missing).fill('0'), ...right].map((part) => Number.parseInt(part, 16))
}

function mappedIpv4FromWords(words: readonly number[]): string | null {
  if (words.length !== 8 || words.slice(0, 5).some((word) => word !== 0) || words[5] !== 0xffff) return null
  return `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`
}

function redactUrlForAudit(url: URL): string {
  const redacted = new URL(url.toString())
  for (const key of redacted.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEY.test(key)) redacted.searchParams.set(key, '[REDACTED]')
  }
  redacted.hash = ''
  return redacted.toString()
}

function validateLimits(limits: typeof RESEARCH_AGENT_NETWORK_LIMITS): typeof RESEARCH_AGENT_NETWORK_LIMITS {
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new ResearchAgentNetworkError('NETWORK_REQUEST_FAILED', '研究联网策略上限无效')
  }
  return limits
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) return String(error.code).slice(0, 120)
  return error instanceof Error ? error.name.slice(0, 120) : 'unknown'
}

function isZlibOutputTooLarge(error: unknown): boolean {
  const code = safeErrorCode(error)
  return code === 'ERR_BUFFER_TOO_LARGE' || code === 'ERR_OUT_OF_RANGE'
}
