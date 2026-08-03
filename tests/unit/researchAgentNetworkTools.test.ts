import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import {
  advanceResearchAgentRunPhase,
  claimResearchAgentRunLease,
  createResearchAgentStep,
  getResearchAgentRunLedger,
  requestResearchAgentRunCancellation,
  startResearchAgentRun,
  transitionResearchAgentRunStatus,
  transitionResearchAgentStepStatus,
} from '../../electron/main/database/researchAgentRunRepository'
import { assessResearchAgentEvidence } from '../../electron/main/services/researchAgentEvidenceGate'
import {
  RESEARCH_AGENT_TOOL_REGISTRY_VERSION,
} from '../../electron/main/services/researchAgentNetworkTools'
import {
  RESEARCH_AGENT_NETWORK_POLICY_VERSION,
  ResearchAgentNetworkError,
  type ResearchAgentNetworkMimeKind,
  type ResearchAgentNetworkRequest,
  type ResearchAgentNetworkResponse,
} from '../../electron/main/services/researchAgentNetworkPolicy'
import { RESEARCH_AGENT_PROMPT_RULE_VERSION } from '../../electron/main/services/researchAgentProtocol'
import { executeResearchAgentTool } from '../../electron/main/services/researchAgentToolService'

const NOW = Date.parse('2026-07-30T08:00:00.000Z')
const OWNER = 'boot-00000000-0000-4000-8000-000000002566'
let sequence = 0

function uuid(): string {
  sequence += 1
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
}

function networkResponse(
  request: ResearchAgentNetworkRequest,
  mimeKind: ResearchAgentNetworkMimeKind,
  value: string | Record<string, unknown>,
  statusCode = 200,
): ResearchAgentNetworkResponse {
  const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
  const requestBody = request.body == null
    ? null
    : Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body, 'utf8')
  const bodySha256 = createHash('sha256').update(body).digest('hex')
  return {
    body,
    envelope: {
      version: RESEARCH_AGENT_NETWORK_POLICY_VERSION,
      request: {
        method: request.method ?? 'GET',
        url: request.url,
        headerNames: Object.keys(request.headers ?? {}).map((name) => name.toLowerCase()).sort(),
        bodyBytes: requestBody?.length ?? 0,
        bodySha256: requestBody ? createHash('sha256').update(requestBody).digest('hex') : null,
      },
      response: {
        finalUrl: request.url,
        statusCode,
        contentType: mimeKind === 'json' ? 'application/json' : mimeKind === 'html' ? 'text/html' : 'text/plain',
        mimeKind,
        contentEncoding: 'identity',
        fetchedAt: NOW + 500,
        compressedBytes: body.length,
        decodedBytes: body.length,
        bodySha256,
      },
      hops: [{
        url: request.url,
        resolvedAddresses: ['93.184.216.34'],
        statusCode,
        redirectTo: null,
      }],
      envelopeSha256: 'f'.repeat(64),
    },
  }
}

function minimalPdf(text: string): Buffer {
  const escaped = text.replace(/([\\()])/g, '\\$1')
  const stream = `BT /F1 12 Tf 40 760 Td (${escaped}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let value = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(value, 'ascii'))
    value += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(value, 'ascii')
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  value += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  value += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(value, 'ascii')
}

describe('FR-256 controlled network research tools', () => {
  let db: Database.Database

  beforeEach(() => {
    sequence = 0
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, DATABASE_MIGRATIONS.filter((migration) => [121, 122, 123].includes(migration.version)))
    db.exec('CREATE TABLE stock_fundamental_profiles (ts_code TEXT PRIMARY KEY, website TEXT)')
  })

  afterEach(() => db.close())

  function startToolingRun(contextSnapshot: Record<string, unknown> = {}) {
    const started = startResearchAgentRun(db, {
      requestId: uuid(),
      id: uuid(),
      question: '研究贵州茅台截至当前截点的最新公告、新闻、行情和财务事实',
      contextSnapshot: { schemaVersion: 1, ...contextSnapshot },
      subjects: [{ kind: 'stock', tsCode: '600519.SH', label: '贵州茅台' }],
      includePortfolio: false,
      asOf: '20260730',
      provider: 'deepseek',
      model: 'deepseek-chat',
      modelConfigFingerprint: 'a'.repeat(64),
      promptRuleVersion: RESEARCH_AGENT_PROMPT_RULE_VERSION,
      toolRegistryVersion: RESEARCH_AGENT_TOOL_REGISTRY_VERSION,
      now: NOW,
    })
    claimResearchAgentRunLease(db, {
      runId: started.run.id,
      leaseOwner: OWNER,
      now: NOW + 1,
      ttlMs: 120_000,
    })
    const planning = createResearchAgentStep(db, {
      runId: started.run.id,
      leaseOwner: OWNER,
      ordinal: 1,
      kind: 'planning',
      stepInput: { action: 'plan' },
      id: uuid(),
      now: NOW + 2,
    })
    transitionResearchAgentStepStatus(db, {
      stepId: planning.id,
      leaseOwner: OWNER,
      toStatus: 'running',
      now: NOW + 3,
    })
    transitionResearchAgentStepStatus(db, {
      stepId: planning.id,
      leaseOwner: OWNER,
      toStatus: 'succeeded',
      artifact: { action: 'plan' },
      now: NOW + 4,
    })
    advanceResearchAgentRunPhase(db, {
      runId: started.run.id,
      leaseOwner: OWNER,
      toPhase: 'tooling',
      now: NOW + 5,
    })
    const tooling = createResearchAgentStep(db, {
      runId: started.run.id,
      leaseOwner: OWNER,
      ordinal: 2,
      kind: 'tooling',
      stepInput: { action: 'tool_batch', decisionRound: 1 },
      id: uuid(),
      now: NOW + 6,
    })
    transitionResearchAgentStepStatus(db, {
      stepId: tooling.id,
      leaseOwner: OWNER,
      toStatus: 'running',
      now: NOW + 7,
    })
    return { runId: started.run.id, stepId: tooling.id }
  }

  function pauseRun(runId: string): void {
    transitionResearchAgentRunStatus(db, {
      runId,
      leaseOwner: OWNER,
      toStatus: 'paused',
      now: NOW + 900,
    })
  }

  it('stores search candidates without credentials and only counts fetched bodies as evidence', async () => {
    const secret = 'tavily-secret-that-must-never-be-persisted'
    const { runId, stepId } = startToolingRun()
    const requestNetwork = vi.fn(async (request: ResearchAgentNetworkRequest) => {
      if (request.url.includes('api.tavily.com')) {
        expect(request.headers?.authorization).toBe(`Bearer ${secret}`)
        return networkResponse(request, 'json', {
          results: [
            {
              title: '贵州茅台公告正文',
              url: 'https://www.cninfo.com.cn/new/disclosure/detail?id=1',
              content: '候选摘要不属于正文证据',
              published_date: '2026-07-29',
            },
          ],
        })
      }
      return networkResponse(request, 'html', [
        '<html><head><title>贵州茅台公告正文</title>',
        '<meta property="article:published_time" content="2026-07-29T08:00:00+08:00"></head>',
        `<body><article>${'这是经安全出口抓取并固化的正式公告正文内容。'.repeat(12)}</article></body></html>`,
      ].join(''))
    })
    const options = {
      networkToolDependencies: {
        resolveSearchCredentials: () => ({ providerId: 'tavily' as const, apiKey: secret, baseUrl: null }),
        requestNetwork,
      },
    }

    const search = await executeResearchAgentTool(db, {
      runId,
      stepId,
      leaseOwner: OWNER,
      toolId: 'web.search',
      toolInput: { query: '贵州茅台 600519 最新公告', maxResults: 4 },
      callId: uuid(),
      now: NOW + 10,
    }, options)
    expect(search.call).toMatchObject({ status: 'succeeded', submitted_at: NOW + 10 })
    expect(JSON.parse(search.call.stable_references_json)).toEqual([])
    const searchData = (search.envelope?.data ?? {}) as {
      candidates?: Array<{ candidateId: string; sourceClass: string }>
    }
    const candidate = searchData.candidates?.[0]
    expect(candidate).toMatchObject({
      candidateId: expect.stringMatching(/^SRC-[A-F0-9]{16}$/),
      sourceClass: 'official',
    })
    expect(assessResearchAgentEvidence({
      question: '贵州茅台最近有什么重要新闻和事件？',
      asOf: '20260730',
      subjects: [{ kind: 'stock', tsCode: '600519.SH', label: '贵州茅台' }],
      observations: [{ toolId: 'web.search', callStatus: search.call.status, envelope: search.envelope }],
    }).decision).toBe('network_required')

    const fetched = await executeResearchAgentTool(db, {
      runId,
      stepId,
      leaseOwner: OWNER,
      toolId: 'web.fetch_page',
      toolInput: { candidateId: candidate!.candidateId },
      callId: uuid(),
      now: NOW + 20,
    }, options)
    const document = ((fetched.envelope?.data ?? {}) as { document?: Record<string, unknown> }).document
    expect(fetched.call.status).toBe('succeeded')
    expect(document).toMatchObject({
      candidateId: candidate!.candidateId,
      sourceDomain: 'www.cninfo.com.cn',
      sourceClass: 'official',
      primarySourceConfirmed: true,
      finalUrl: 'https://www.cninfo.com.cn/new/disclosure/detail?id=1',
      fetchedAt: NOW + 500,
      contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      rawBodySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(String(document?.excerpt).length).toBeGreaterThanOrEqual(80)
    expect(JSON.stringify(getResearchAgentRunLedger(db, runId))).not.toContain(secret)
    const replayedSearch = await executeResearchAgentTool(db, {
      runId,
      stepId,
      leaseOwner: OWNER,
      toolId: 'web.search',
      toolInput: { query: '贵州茅台 600519 最新公告', maxResults: 4 },
      callId: uuid(),
      now: NOW + 30,
    }, options)
    expect(replayedSearch).toMatchObject({ reused: true, call: { id: search.call.id, status: 'succeeded' } })
    expect(requestNetwork).toHaveBeenCalledTimes(2)
  })

  it('ranks an official PDF ahead of a supplier-first media hit and extracts bounded text', async () => {
    const { runId, stepId } = startToolingRun()
    const pdfBody = minimalPdf('Kweichow Moutai official disclosure evidence '.repeat(12))
    const requestNetwork = vi.fn(async (request: ResearchAgentNetworkRequest) => {
      if (request.url.includes('api.tavily.com')) {
        return networkResponse(request, 'json', {
          results: [
            {
              title: '转载：贵州茅台市场消息',
              url: 'https://media.example.com/repost',
              content: '来源：综合整理',
              published_date: '2026-07-30',
            },
            {
              title: '贵州茅台正式公告PDF',
              url: 'https://www.cninfo.com.cn/disclosure/600519.pdf',
              content: '贵州茅台正式披露文件',
              published_date: '2026-07-29',
            },
          ],
        })
      }
      const response = networkResponse(request, 'pdf', '')
      response.body = pdfBody
      response.envelope.response.bodySha256 = createHash('sha256').update(pdfBody).digest('hex')
      response.envelope.response.compressedBytes = pdfBody.length
      response.envelope.response.decodedBytes = pdfBody.length
      return response
    })
    const options = {
      networkToolDependencies: {
        resolveSearchCredentials: () => ({ providerId: 'tavily' as const, apiKey: 'secret', baseUrl: null }),
        requestNetwork,
      },
    }
    const search = await executeResearchAgentTool(db, {
      runId,
      stepId,
      leaseOwner: OWNER,
      toolId: 'web.search',
      toolInput: { query: '贵州茅台 600519 正式公告', maxResults: 4 },
      callId: uuid(),
      now: NOW + 10,
    }, options)
    const candidates = (search.envelope?.data as { candidates: Array<{ candidateId: string; sourceClass: string }> }).candidates
    expect(candidates[0].sourceClass).toBe('official')

    const fetched = await executeResearchAgentTool(db, {
      runId,
      stepId,
      leaseOwner: OWNER,
      toolId: 'web.fetch_page',
      toolInput: { candidateId: candidates[0].candidateId },
      callId: uuid(),
      now: NOW + 20,
    }, options)
    expect(fetched.envelope).toMatchObject({
      status: 'ready',
      coverage: { available: 1, required: 1, unit: 'documents' },
    })
    const document = (fetched.envelope?.data as { document: { excerpt: string; mimeKind: string } }).document
    expect(document.mimeKind).toBe('pdf')
    expect(document.excerpt).toContain('Kweichow Moutai official disclosure evidence')
    expect(fetched.envelope?.warnings).toContain('PDF已提取前24页内的有界正文；原始响应与提取正文分别固化哈希。')
  })

  it('uses a dated official disclosure URL when the search provider omits publication time', async () => {
    const { runId, stepId } = startToolingRun()
    const pdfBody = minimalPdf('Optical fiber preform capacity and production process evidence '.repeat(12))
    const requestNetwork = vi.fn(async (request: ResearchAgentNetworkRequest) => {
      if (request.url.includes('api.tavily.com')) {
        return networkResponse(request, 'json', {
          results: [{
            title: '贵州茅台产能与工艺正式披露',
            url: 'https://static.sse.com.cn/stock/disclosure/announcement/c/202603/600519_20260329_TEST.pdf',
            content: '贵州茅台交易所正式披露候选',
          }],
        })
      }
      const response = networkResponse(request, 'pdf', '')
      response.body = pdfBody
      response.envelope.response.bodySha256 = createHash('sha256').update(pdfBody).digest('hex')
      response.envelope.response.compressedBytes = pdfBody.length
      response.envelope.response.decodedBytes = pdfBody.length
      return response
    })
    const options = {
      networkToolDependencies: {
        resolveSearchCredentials: () => ({ providerId: 'tavily' as const, apiKey: 'secret', baseUrl: null }),
        requestNetwork,
      },
    }
    const search = await executeResearchAgentTool(db, {
      runId,
      stepId,
      leaseOwner: OWNER,
      toolId: 'official.disclosure_search',
      toolInput: { query: '贵州茅台 产能 工艺 正式披露' },
      callId: uuid(),
      now: NOW + 10,
    }, options)
    const candidateId = (search.envelope?.data as { candidates: Array<{ candidateId: string }> }).candidates[0].candidateId
    const fetched = await executeResearchAgentTool(db, {
      runId,
      stepId,
      leaseOwner: OWNER,
      toolId: 'official.disclosure_document',
      toolInput: { candidateId },
      callId: uuid(),
      now: NOW + 20,
    }, options)
    expect(fetched.envelope).toMatchObject({
      status: 'ready',
      coverage: { available: 1 },
      data: { document: { publishedAt: '2026-03-29', primarySourceConfirmed: true } },
    })
    expect(fetched.envelope?.warnings).toContain('发布日期取自正式披露URL中的日期标记，并已按研究截点校验。')
  })

  it('reclassifies an official candidate from the final response domain after a cross-domain redirect', async () => {
    const { runId, stepId } = startToolingRun()
    const requestNetwork = vi.fn(async (request: ResearchAgentNetworkRequest) => {
      if (request.url.includes('api.tavily.com')) {
        return networkResponse(request, 'json', {
          results: [{
            title: '贵州茅台重要事项公告',
            url: 'https://www.cninfo.com.cn/disclosure/redirect',
            content: '贵州茅台正式披露候选',
            published_date: '2026-07-29',
          }],
        })
      }
      const response = networkResponse(request, 'html', [
        '<html><head><title>贵州茅台市场消息转载</title>',
        '<meta property="article:published_time" content="2026-07-29"></head>',
        `<article>${'媒体转载贵州茅台近期事项，并整理公开信息、市场观点和仍待验证的后续影响。'.repeat(6)}</article></html>`,
      ].join(''))
      response.envelope.response.finalUrl = 'https://media.example.com/repost/maotai'
      return response
    })
    const options = {
      networkToolDependencies: {
        resolveSearchCredentials: () => ({ providerId: 'tavily' as const, apiKey: 'secret', baseUrl: null }),
        requestNetwork,
      },
    }
    const search = await executeResearchAgentTool(db, {
      runId,
      stepId,
      leaseOwner: OWNER,
      toolId: 'web.search',
      toolInput: { query: '贵州茅台 600519 重要事项公告' },
      callId: uuid(),
      now: NOW + 10,
    }, options)
    const candidateId = (search.envelope?.data as { candidates: Array<{ candidateId: string }> }).candidates[0].candidateId
    const fetched = await executeResearchAgentTool(db, {
      runId,
      stepId,
      leaseOwner: OWNER,
      toolId: 'web.fetch_page',
      toolInput: { candidateId },
      callId: uuid(),
      now: NOW + 20,
    }, options)

    expect(fetched.envelope?.data).toMatchObject({
      document: {
        finalUrl: 'https://media.example.com/repost/maotai',
        sourceDomain: 'media.example.com',
        sourceClass: 'secondary',
        primarySourceConfirmed: false,
      },
    })
    expect(fetched.envelope?.warnings).toContain('最终响应域名与搜索候选不同；来源等级已按最终响应域名重新判定。')
  })

  it('reads a verifiable publication date from JSON-LD before removing page scripts', async () => {
    const { runId, stepId } = startToolingRun()
    const requestNetwork = vi.fn(async (request: ResearchAgentNetworkRequest) => {
      if (request.url.includes('api.tavily.com')) {
        return networkResponse(request, 'json', {
          results: [{
            title: '贵州茅台近期事项核验',
            url: 'https://news.example.com/maotai-event',
            content: '贵州茅台近期事项正文候选',
          }],
        })
      }
      return networkResponse(request, 'html', [
        '<html><head><title>贵州茅台近期事项核验</title>',
        '<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-07-28T09:30:00+08:00"}</script>',
        '</head><body>',
        `<article>${'独立媒体核验贵州茅台近期事项的时间线、公开事实、限制条件和仍待确认的后续影响。'.repeat(6)}</article>`,
        '</body></html>',
      ].join(''))
    })
    const options = {
      networkToolDependencies: {
        resolveSearchCredentials: () => ({ providerId: 'tavily' as const, apiKey: 'secret', baseUrl: null }),
        requestNetwork,
      },
    }
    const search = await executeResearchAgentTool(db, {
      runId,
      stepId,
      leaseOwner: OWNER,
      toolId: 'web.search',
      toolInput: { query: '贵州茅台 600519 近期事项' },
      callId: uuid(),
      now: NOW + 10,
    }, options)
    const candidateId = (search.envelope?.data as { candidates: Array<{ candidateId: string }> }).candidates[0].candidateId
    const fetched = await executeResearchAgentTool(db, {
      runId,
      stepId,
      leaseOwner: OWNER,
      toolId: 'web.fetch_page',
      toolInput: { candidateId },
      callId: uuid(),
      now: NOW + 20,
    }, options)

    expect(fetched.envelope).toMatchObject({
      status: 'ready',
      coverage: { available: 1 },
      data: { document: { publishedAt: '2026-07-28' } },
    })
  })

  it('rejects arbitrary URLs before dispatch and candidates that are not frozen in the same run', async () => {
    const first = startToolingRun()
    const requestNetwork = vi.fn(async (request: ResearchAgentNetworkRequest) => networkResponse(request, 'json', {
      results: [{ title: '贵州茅台资料', url: 'https://example.com/maotai', content: '摘要' }],
    }))
    const options = {
      networkToolDependencies: {
        resolveSearchCredentials: () => ({ providerId: 'tavily' as const, apiKey: 'secret', baseUrl: null }),
        requestNetwork,
      },
    }
    const search = await executeResearchAgentTool(db, {
      runId: first.runId,
      stepId: first.stepId,
      leaseOwner: OWNER,
      toolId: 'web.search',
      toolInput: { query: '贵州茅台 600519 资料' },
      callId: uuid(),
      now: NOW + 10,
    }, options)
    const foreignCandidateId = ((search.envelope?.data as { candidates: Array<{ candidateId: string }> }).candidates[0]).candidateId
    pauseRun(first.runId)

    const second = startToolingRun()
    const arbitrary = await executeResearchAgentTool(db, {
      runId: second.runId,
      stepId: second.stepId,
      leaseOwner: OWNER,
      toolId: 'web.fetch_page',
      toolInput: { url: 'https://example.com/private' },
      callId: uuid(),
      now: NOW + 20,
    }, options)
    expect(arbitrary.call).toMatchObject({ status: 'blocked', submitted_at: null, error_code: 'INVALID_INPUT' })

    const foreign = await executeResearchAgentTool(db, {
      runId: second.runId,
      stepId: second.stepId,
      leaseOwner: OWNER,
      toolId: 'web.fetch_page',
      toolInput: { candidateId: foreignCandidateId },
      callId: uuid(),
      now: NOW + 30,
    }, options)
    expect(foreign.call).toMatchObject({
      status: 'failed',
      submitted_at: NOW + 30,
      error_code: 'CANDIDATE_NOT_AUTHORIZED',
    })
    expect(requestNetwork).toHaveBeenCalledTimes(1)
  })

  it('parses bounded daily prices, current quotes and fundamentals for only the trusted stock', async () => {
    const requestNetwork = vi.fn(async (request: ResearchAgentNetworkRequest) => {
      const url = new URL(request.url)
      if (url.hostname === 'push2his.eastmoney.com') {
        return networkResponse(request, 'json', {
          data: {
            name: '贵州茅台',
            klines: Array.from({ length: 10 }, (_, index) => (
              `2026-07-${String(20 + index).padStart(2, '0')},${100 + index},${101 + index},${102 + index},${99 + index},1000,2000`
            )),
          },
        })
      }
      if (url.hostname === 'push2.eastmoney.com') {
        return networkResponse(request, 'json', {
          data: { f43: 142050, f44: 143000, f45: 140000, f46: 141000, f47: 1234, f48: 5678, f58: '贵州茅台', f60: 141500, f170: 39 },
        })
      }
      return networkResponse(request, 'json', {
        result: {
          data: [{
            SECUCODE: '600519.SH',
            SECURITY_NAME_ABBR: '贵州茅台',
            REPORT_DATE: '2026-06-30',
            NOTICE_DATE: '2026-07-20',
            REPORT_TYPE: '中报',
            CURRENCY: 'CNY',
            TOTALOPERATEREVE: 100,
            PARENTNETPROFIT: 50,
            ROEJQ: 20,
          }],
        },
      })
    })
    const options = { networkToolDependencies: { requestNetwork } }

    const pricesRun = startToolingRun()
    const prices = await executeResearchAgentTool(db, {
      ...pricesRun,
      leaseOwner: OWNER,
      toolId: 'market.price_refresh',
      toolInput: { stockCode: '600519.SH', limit: 10 },
      callId: uuid(),
      now: NOW + 10,
    }, options)
    expect(prices.envelope).toMatchObject({
      status: 'ready',
      coverage: { available: 10, required: 10 },
      data: { tsCode: '600519.SH', bars: expect.arrayContaining([expect.objectContaining({ tradeDate: '20260729', close: 110 })]) },
    })
    pauseRun(pricesRun.runId)

    const quoteRun = startToolingRun()
    const quote = await executeResearchAgentTool(db, {
      ...quoteRun,
      leaseOwner: OWNER,
      toolId: 'market.quote_snapshot',
      toolInput: { stockCode: '600519.SH' },
      callId: uuid(),
      now: NOW + 20,
    }, options)
    expect(quote.envelope).toMatchObject({
      status: 'ready',
      asOf: null,
      data: { quote: { tsCode: '600519.SH', price: 1420.5, preClose: 1415, changePct: 0.39, quoteAt: NOW + 500 } },
    })
    pauseRun(quoteRun.runId)

    const fundamentalsRun = startToolingRun()
    const fundamentals = await executeResearchAgentTool(db, {
      ...fundamentalsRun,
      leaseOwner: OWNER,
      toolId: 'company.fundamentals_refresh',
      toolInput: { stockCode: '600519.SH' },
      callId: uuid(),
      now: NOW + 30,
    }, options)
    expect(fundamentals.envelope).toMatchObject({
      status: 'ready',
      data: {
        tsCode: '600519.SH',
        reports: [expect.objectContaining({ reportDate: '20260630', noticeDate: '20260720', totalRevenue: 100 })],
      },
    })
    expect(requestNetwork).toHaveBeenCalledTimes(3)
  })

  it('retries a known 429 response but never replays an uncertain submitted request', async () => {
    const { runId, stepId } = startToolingRun()
    const requestNetwork = vi.fn()
      .mockImplementationOnce(async (request: ResearchAgentNetworkRequest) => networkResponse(request, 'json', {}, 429))
      .mockImplementationOnce(async (request: ResearchAgentNetworkRequest) => networkResponse(request, 'json', {
        results: [{ title: '贵州茅台资料', url: 'https://example.com/maotai', content: '摘要' }],
      }))
    const options = {
      networkToolDependencies: {
        resolveSearchCredentials: () => ({ providerId: 'tavily' as const, apiKey: 'secret', baseUrl: null }),
        requestNetwork,
      },
    }
    const input = {
      runId,
      stepId,
      leaseOwner: OWNER,
      toolId: 'web.search',
      toolInput: { query: '贵州茅台 600519 资料' },
      now: NOW + 10,
    }
    const limited = await executeResearchAgentTool(db, { ...input, callId: uuid() }, options)
    expect(limited.call).toMatchObject({ status: 'failed', attempt: 1, error_code: 'NETWORK_RATE_LIMITED' })
    const recovered = await executeResearchAgentTool(db, { ...input, callId: uuid(), now: NOW + 20 }, options)
    expect(recovered.call).toMatchObject({ status: 'succeeded', attempt: 2 })
    expect(requestNetwork).toHaveBeenCalledTimes(2)
  })

  it('marks transport loss and post-submit cancellation outcome_unknown without a second request', async () => {
    const credentials = {
      resolveSearchCredentials: () => ({ providerId: 'tavily' as const, apiKey: 'secret', baseUrl: null }),
    }
    const uncertainRun = startToolingRun()
    const failedNetwork = vi.fn(async () => {
      throw new ResearchAgentNetworkError('NETWORK_REQUEST_FAILED', 'connection lost')
    })
    const uncertainInput = {
      ...uncertainRun,
      leaseOwner: OWNER,
      toolId: 'web.search',
      toolInput: { query: '贵州茅台 600519 资料' },
      callId: uuid(),
      now: NOW + 10,
    }
    await expect(executeResearchAgentTool(db, uncertainInput, {
      networkToolDependencies: { ...credentials, requestNetwork: failedNetwork },
    })).rejects.toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN' })
    await expect(executeResearchAgentTool(db, { ...uncertainInput, callId: uuid(), now: NOW + 20 }, {
      networkToolDependencies: { ...credentials, requestNetwork: failedNetwork },
    })).rejects.toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN' })
    expect(failedNetwork).toHaveBeenCalledTimes(1)
    expect(getResearchAgentRunLedger(db, uncertainRun.runId)?.toolCalls[0]).toMatchObject({
      status: 'outcome_unknown',
      error_code: 'NETWORK_REQUEST_FAILED',
    })
  })

  it('persists cancellation during a submitted request and ignores the late response', async () => {
    const { runId, stepId } = startToolingRun()
    let resolveResponse: ((response: ResearchAgentNetworkResponse) => void) | null = null
    let capturedRequest: ResearchAgentNetworkRequest | null = null
    const requestNetwork = vi.fn((request: ResearchAgentNetworkRequest) => {
      capturedRequest = request
      return new Promise<ResearchAgentNetworkResponse>((resolve) => { resolveResponse = resolve })
    })
    const pending = executeResearchAgentTool(db, {
      runId,
      stepId,
      leaseOwner: OWNER,
      toolId: 'web.search',
      toolInput: { query: '贵州茅台 600519 资料' },
      callId: uuid(),
      now: NOW + 10,
    }, {
      networkToolDependencies: {
        resolveSearchCredentials: () => ({ providerId: 'tavily' as const, apiKey: 'secret', baseUrl: null }),
        requestNetwork,
      },
    })
    await vi.waitFor(() => expect(requestNetwork).toHaveBeenCalledTimes(1))
    requestResearchAgentRunCancellation(db, { runId, now: NOW + 20 })
    resolveResponse!(networkResponse(capturedRequest!, 'json', {
      results: [{ title: 'late', url: 'https://example.com/late' }],
    }))
    const settled = await pending
    expect(settled.call).toMatchObject({ status: 'outcome_unknown', error_code: 'CANCELLED_AFTER_SUBMIT' })
    expect(settled.call.envelope_json).toBeNull()
    expect(requestNetwork).toHaveBeenCalledTimes(1)
  })
})
