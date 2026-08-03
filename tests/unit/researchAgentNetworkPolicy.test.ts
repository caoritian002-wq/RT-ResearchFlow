import { gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import {
  createResearchAgentNetworkClient,
  isPublicResearchAgentAddress,
  RESEARCH_AGENT_NETWORK_LIMITS,
  requestResearchAgentNetwork,
  ResearchAgentNetworkError,
} from '../../electron/main/services/researchAgentNetworkPolicy'

const PUBLIC_IP = '93.184.216.34'
const TEST_LIMITS = {
  ...RESEARCH_AGENT_NETWORK_LIMITS,
  connectTimeoutMs: 50,
  totalTimeoutMs: 100,
  maxRedirects: 2,
  maxRequestBodyBytes: 128,
  maxCompressedResponseBytes: 64,
  maxDecodedResponseBytes: 128,
}

function response(
  body: string | Buffer,
  overrides: Partial<{
    statusCode: number
    headers: Record<string, string | readonly string[] | undefined>
    destroy: (error?: Error) => void
  }> = {},
) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body)
  return {
    statusCode: overrides.statusCode ?? 200,
    headers: overrides.headers ?? { 'content-type': 'text/html; charset=utf-8' },
    body: (async function* () { yield buffer })(),
    destroy: overrides.destroy ?? vi.fn(),
  }
}

function client(overrides: Record<string, unknown> = {}) {
  return createResearchAgentNetworkClient({
    limits: TEST_LIMITS,
    now: () => 1_800_000_000_000,
    resolveHostname: vi.fn(async () => [{ address: PUBLIC_IP, family: 4 as const }]),
    requestHop: vi.fn(async () => response('<html>research</html>')),
    ...overrides,
  })
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code })
}

describe('FR-256 research agent safe network outlet', () => {
  it('accepts a typical multi-megabyte official PDF with the production limits', async () => {
    const body = Buffer.alloc(7 * 1024 * 1024, 65)
    const productionClient = createResearchAgentNetworkClient({
      now: () => 1_800_000_000_000,
      resolveHostname: vi.fn(async () => [{ address: PUBLIC_IP, family: 4 as const }]),
      requestHop: vi.fn(async () => response(body, {
        headers: { 'content-type': 'application/pdf', 'content-encoding': 'identity' },
      })),
    })
    const result = await productionClient({
      url: 'https://static.sse.com.cn/disclosure.pdf',
      acceptedMimeKinds: ['pdf'],
    })
    expect(result.body.byteLength).toBe(body.byteLength)
    expect(result.envelope).toMatchObject({
      version: 'research-agent-network.v2',
      response: { mimeKind: 'pdf', compressedBytes: body.byteLength, decodedBytes: body.byteLength },
    })
  })

  it('allows only globally routable IPv4 and IPv6 addresses', () => {
    expect(isPublicResearchAgentAddress('8.8.8.8')).toBe(true)
    expect(isPublicResearchAgentAddress('2606:4700:4700::1111')).toBe(true)
    for (const address of [
      '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
      '172.16.0.1', '192.168.1.1', '198.18.0.1', '203.0.113.1', '224.0.0.1',
      '::', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1',
      '2002:7f00:1::',
    ]) expect(isPublicResearchAgentAddress(address), address).toBe(false)
  })

  it('rejects non-HTTP schemes, URL credentials, localhost and private DNS answers', async () => {
    await expectCode(client()({ url: 'file:///etc/passwd' }), 'NETWORK_URL_PROTOCOL_NOT_ALLOWED')
    await expectCode(client()({ url: 'https://user:secret@example.com/' }), 'NETWORK_CREDENTIALS_NOT_ALLOWED')
    await expectCode(client()({ url: 'http://localhost:3000/' }), 'NETWORK_HOST_BLOCKED')
    await expectCode(client()({ url: 'http://127.1/' }), 'NETWORK_ADDRESS_BLOCKED')
    const resolveHostname = vi.fn(async () => [
      { address: PUBLIC_IP, family: 4 as const },
      { address: '127.0.0.1', family: 4 as const },
    ])
    await expectCode(client({ resolveHostname })({ url: 'https://example.com/' }), 'NETWORK_ADDRESS_BLOCKED')
  })

  it('re-resolves and validates every redirect hop to stop DNS rebinding', async () => {
    const resolveHostname = vi.fn()
      .mockResolvedValueOnce([{ address: PUBLIC_IP, family: 4 }])
      .mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }])
    const requestHop = vi.fn(async () => response('', {
      statusCode: 302,
      headers: { location: '/metadata' },
    }))
    await expectCode(
      client({ resolveHostname, requestHop })({ url: 'https://example.com/start' }),
      'NETWORK_ADDRESS_BLOCKED',
    )
    expect(resolveHostname).toHaveBeenCalledTimes(2)
    expect(requestHop).toHaveBeenCalledTimes(1)
  })

  it('blocks redirect targets that resolve to localhost or reserved addresses', async () => {
    const requestHop = vi.fn(async () => response('', {
      statusCode: 301,
      headers: { location: 'https://169.254.169.254/latest/meta-data/' },
    }))
    await expectCode(
      client({ requestHop })({ url: 'https://example.com/start' }),
      'NETWORK_ADDRESS_BLOCKED',
    )
  })

  it('never accepts cookies and strips credentials on cross-origin GET redirects', async () => {
    await expectCode(
      client()({ url: 'https://example.com/', headers: { Cookie: 'session=secret' } }),
      'NETWORK_CREDENTIALS_NOT_ALLOWED',
    )
    const requestHop = vi.fn()
      .mockResolvedValueOnce(response('', {
        statusCode: 302,
        headers: { location: 'https://other.example/final', 'set-cookie': 'session=ignored' },
      }))
      .mockResolvedValueOnce(response('{"ok":true}', { headers: { 'content-type': 'application/json' } }))
    await client({ requestHop })({
      url: 'https://example.com/start',
      headers: { Authorization: 'Bearer secret', Accept: 'application/json', 'X-Api-Key': 'secret' },
      acceptedMimeKinds: ['json'],
    })
    expect(requestHop).toHaveBeenCalledTimes(2)
    const redirected = requestHop.mock.calls[1][0]
    expect(redirected.headers).toMatchObject({ accept: 'application/json' })
    expect(redirected.headers).not.toHaveProperty('authorization')
    expect(redirected.headers).not.toHaveProperty('x-api-key')
    expect(redirected.headers).not.toHaveProperty('cookie')
  })

  it('rejects cross-origin 307 redirects before a POST body can be forwarded', async () => {
    const requestHop = vi.fn(async () => response('', {
      statusCode: 307,
      headers: { location: 'https://other.example/collect' },
    }))
    await expectCode(client({ requestHop })({
      url: 'https://api.example/search',
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: '{"query":"test"}',
    }), 'NETWORK_REDIRECT_UNSAFE')
    expect(requestHop).toHaveBeenCalledTimes(1)
  })

  it('blocks HTTPS downgrade redirects and non-anonymous plain HTTP requests', async () => {
    const downgrade = vi.fn(async () => response('', {
      statusCode: 302,
      headers: { location: 'http://example.com/final' },
    }))
    await expectCode(
      client({ requestHop: downgrade })({ url: 'https://example.com/start' }),
      'NETWORK_REDIRECT_UNSAFE',
    )
    await expectCode(client()({
      url: 'http://example.com/search',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"query":"test"}',
    }), 'NETWORK_CREDENTIALS_NOT_ALLOWED')
    await expectCode(client()({
      url: 'http://example.com/',
      headers: { Authorization: 'Bearer secret' },
    }), 'NETWORK_CREDENTIALS_NOT_ALLOWED')
  })

  it('enforces the redirect limit and requires a single Location', async () => {
    const requestHop = vi.fn(async () => response('', {
      statusCode: 302,
      headers: { location: '/again' },
    }))
    await expectCode(client({ requestHop })({ url: 'https://example.com/start' }), 'NETWORK_REDIRECT_LIMIT')
    await expectCode(client({ requestHop: vi.fn(async () => response('', {
      statusCode: 302,
      headers: { location: ['/a', '/b'] },
    })) })({ url: 'https://example.com/start' }), 'NETWORK_REDIRECT_INVALID')
  })

  it('allows only research document MIME types and rejects unsupported encodings', async () => {
    const destroy = vi.fn()
    await expectCode(client({ requestHop: vi.fn(async () => response('image', {
      headers: { 'content-type': 'image/png' }, destroy,
    })) })({ url: 'https://example.com/image.png' }), 'NETWORK_MIME_NOT_ALLOWED')
    expect(destroy).toHaveBeenCalledOnce()
    await expectCode(client({ requestHop: vi.fn(async () => response('data', {
      headers: { 'content-type': 'text/plain', 'content-encoding': 'compress' },
    })) })({ url: 'https://example.com/' }), 'NETWORK_ENCODING_NOT_ALLOWED')
    await expectCode(client({ requestHop: vi.fn(async () => response('data', {
      headers: { 'content-type': 'text/plain', 'content-encoding': ['gzip', 'br'] },
    })) })({ url: 'https://example.com/' }), 'NETWORK_ENCODING_NOT_ALLOWED')
  })

  it('enforces compressed and decoded byte ceilings', async () => {
    await expectCode(client({ requestHop: vi.fn(async () => response(Buffer.alloc(65), {
      headers: { 'content-type': 'text/plain' },
    })) })({ url: 'https://example.com/large' }), 'NETWORK_RESPONSE_TOO_LARGE')
    const compressed = gzipSync(Buffer.alloc(129, 65))
    expect(compressed.byteLength).toBeLessThanOrEqual(TEST_LIMITS.maxCompressedResponseBytes)
    await expectCode(client({ requestHop: vi.fn(async () => response(compressed, {
      headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
    })) })({ url: 'https://example.com/compressed' }), 'NETWORK_RESPONSE_TOO_LARGE')
  })

  it('propagates parent cancellation and applies one total timeout across the operation', async () => {
    const controller = new AbortController()
    const waitForAbort = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const cancelled = client({ requestHop: waitForAbort })({
      url: 'https://example.com/',
      signal: controller.signal,
    })
    controller.abort()
    await expectCode(cancelled, 'NETWORK_ABORTED')

    const timedOut = client({
      limits: { ...TEST_LIMITS, totalTimeoutMs: 10 },
      requestHop: waitForAbort,
    })({ url: 'https://example.com/' })
    await expectCode(timedOut, 'NETWORK_TOTAL_TIMEOUT')
  })

  it('passes the fixed connection deadline to the transport and preserves its stable failure', async () => {
    const requestHop = vi.fn(async ({ connectTimeoutMs }: { connectTimeoutMs: number }) => {
      expect(connectTimeoutMs).toBe(TEST_LIMITS.connectTimeoutMs)
      throw new ResearchAgentNetworkError('NETWORK_CONNECT_TIMEOUT', 'connect timeout')
    })
    await expectCode(client({ requestHop })({ url: 'https://example.com/' }), 'NETWORK_CONNECT_TIMEOUT')
  })

  it('returns a versioned hashable envelope without secret query values', async () => {
    const requestHop = vi.fn(async () => response('{"ok":true}', {
      headers: { 'content-type': 'application/problem+json; charset=utf-8' },
    }))
    const result = await client({ requestHop })({
      url: 'https://example.com/data?api_key=secret&symbol=600519',
      acceptedMimeKinds: ['json'],
    })
    expect(result.body.toString('utf8')).toBe('{"ok":true}')
    expect(result.envelope).toMatchObject({
      version: 'research-agent-network.v2',
      request: { method: 'GET', bodyBytes: 0, bodySha256: null },
      response: {
        contentType: 'application/problem+json',
        mimeKind: 'json',
        decodedBytes: 11,
      },
    })
    expect(result.envelope.request.url).toContain('api_key=%5BREDACTED%5D')
    expect(JSON.stringify(result.envelope)).not.toContain('secret')
    expect(result.envelope.response.bodySha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.envelope.envelopeSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('uses only the already validated pinned address for the transport', async () => {
    const requestHop = vi.fn(async () => response('ok', { headers: { 'content-type': 'text/plain' } }))
    await client({ requestHop })({ url: 'https://example.com/' })
    expect(requestHop.mock.calls[0][0]).toMatchObject({
      resolvedAddress: { address: PUBLIC_IP, family: 4 },
      headers: {
        'accept-encoding': 'gzip, deflate, br',
        'user-agent': 'tradeWatching-research-agent/1.0',
      },
    })
  })

  it('normalizes unknown transport failures to stable error codes', async () => {
    const error = await client({ requestHop: vi.fn(async () => { throw Object.assign(new Error('socket'), { code: 'ECONNRESET' }) }) })({
      url: 'https://example.com/',
    }).catch((caught) => caught)
    expect(error).toBeInstanceOf(ResearchAgentNetworkError)
    expect(error).toMatchObject({ code: 'NETWORK_REQUEST_FAILED', details: { cause: 'ECONNRESET' } })
  })
})

const realNetworkTest = process.env.TRADE_WATCH_REAL_NETWORK_TEST === '1' ? it : it.skip

describe('FR-256 research agent real network sandbox', () => {
  realNetworkTest('fetches a public document through the production safety outlet', async () => {
    const result = await requestResearchAgentNetwork({
      url: 'https://example.com/',
      headers: { accept: 'text/html' },
      acceptedMimeKinds: ['html'],
    })
    expect(result.envelope).toMatchObject({
      version: 'research-agent-network.v2',
      request: { method: 'GET', url: 'https://example.com/' },
      response: { statusCode: 200, finalUrl: 'https://example.com/', mimeKind: 'html' },
    })
    expect(result.envelope.hops.length).toBeGreaterThanOrEqual(1)
    expect(result.envelope.response.decodedBytes).toBe(result.body.byteLength)
    expect(result.body.toString('utf8')).toContain('Example Domain')
  }, 30_000)
})
