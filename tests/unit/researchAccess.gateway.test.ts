import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import {
  createResearchAccessProfile,
  listResearchAccessAudit,
} from '../../electron/main/database/researchAccessRepository'
import {
  executeResearchAccessTool,
  listAuthorizedResearchAccessTools,
  RESEARCH_ACCESS_RATE_PER_MINUTE,
} from '../../electron/main/services/researchAccessGateway'
import { listResearchFactTools } from '../../electron/main/services/researchFactToolRegistry'

const NOW = Date.UTC(2026, 6, 30, 4, 0, 0)

describe('FR-255 research access gateway', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  afterEach(() => db.close())

  function profile(scopes: Array<'market.read' | 'research.read' | 'portfolio.read'> = ['market.read']) {
    return createResearchAccessProfile(db, {
      requestId: crypto.randomUUID(),
      name: '本机Agent',
      scopes,
      now: NOW,
    })
  }

  it('publishes stable exact schemas and lists only tools allowed by the current scopes', () => {
    const definitions = listResearchFactTools()
    expect(definitions.map((item) => item.externalName)).toEqual([
      'stock_price_history',
      'stock_trend_snapshot',
      'stock_fundamentals',
      'stock_announcements',
      'portfolio_holdings',
      'news_recent_briefings',
      'decision_judgment_history',
      'industry_project_snapshot',
    ])
    expect(definitions.every((item) => item.inputSchema.additionalProperties === false)).toBe(true)

    const created = profile()
    const listed = listAuthorizedResearchAccessTools(db, {
      profileId: created.profile.id,
      credential: created.credential!,
      surface: 'mcp',
    })
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'stock_price_history',
      'stock_trend_snapshot',
      'stock_fundamentals',
      'stock_announcements',
      'news_recent_briefings',
    ])
    expect(listed.tools.every((tool) => tool.scope === 'market.read')).toBe(true)
  })

  it('blocks guessed personal tools, future facts and extra fields before returning data', () => {
    const created = profile()
    const caller = {
      profileId: created.profile.id,
      credential: created.credential!,
      surface: 'mcp' as const,
      sessionId: crypto.randomUUID(),
    }
    expect(executeResearchAccessTool(db, caller, {
      requestId: crypto.randomUUID(),
      externalToolName: 'decision_judgment_history',
      input: { judgmentId: 'judgment-1' },
    }, { now: NOW })).toMatchObject({ ok: false, error: { code: 'SCOPE_DENIED' } })

    expect(executeResearchAccessTool(db, caller, {
      requestId: crypto.randomUUID(),
      externalToolName: 'stock_price_history',
      input: { stockCode: '600519', asOf: '20260731' },
    }, { now: NOW })).toMatchObject({ ok: false, error: { code: 'FUTURE_AS_OF' } })

    expect(executeResearchAccessTool(db, caller, {
      requestId: crypto.randomUUID(),
      externalToolName: 'stock_price_history',
      input: { stockCode: '600519', sql: 'SELECT * FROM portfolio_stocks' },
    }, { now: NOW })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
      envelope: { status: 'blocked' },
    })
    expect(listResearchAccessAudit(db).items.map((item) => item.errorCode)).toEqual([
      'INVALID_INPUT',
      'FUTURE_AS_OF',
      'SCOPE_DENIED',
    ])
  })

  it('returns the same fact envelope through MCP and CLI without storing raw research ids', () => {
    const created = profile(['market.read', 'research.read'])
    const baseCaller = { profileId: created.profile.id, credential: created.credential! }
    const judgmentId = '7c0954f2-1537-4b36-8c7d-2c4b643ee920'
    const input = { judgmentId, asOf: '20260730' }
    const mcp = executeResearchAccessTool(db, { ...baseCaller, surface: 'mcp' }, {
      requestId: crypto.randomUUID(),
      externalToolName: 'decision_judgment_history',
      input,
    }, { now: NOW })
    const cli = executeResearchAccessTool(db, { ...baseCaller, surface: 'cli' }, {
      requestId: crypto.randomUUID(),
      externalToolName: 'decision_judgment_history',
      input,
    }, { now: NOW })
    expect(mcp.ok).toBe(true)
    expect(cli.ok).toBe(true)
    if (!mcp.ok || !cli.ok) return
    expect(cli.envelope).toEqual(mcp.envelope)
    expect(mcp.envelope).toMatchObject({
      toolId: 'decision.judgment_history',
      status: 'missing',
      asOf: '20260730',
    })
    const auditText = JSON.stringify(listResearchAccessAudit(db).items)
    expect(auditText).not.toContain(judgmentId)
    expect(auditText).toContain('judgmentIdSha256')
  })

  it('persists minute limits across calls and rejects duplicate request ids', () => {
    const created = profile()
    const caller = { profileId: created.profile.id, credential: created.credential!, surface: 'cli' as const }
    for (let index = 0; index < RESEARCH_ACCESS_RATE_PER_MINUTE; index += 1) {
      expect(executeResearchAccessTool(db, caller, {
        requestId: crypto.randomUUID(),
        externalToolName: 'stock_price_history',
        input: { stockCode: '600519', limit: 10 },
      }, { now: NOW + index })).toMatchObject({ ok: true })
    }
    expect(executeResearchAccessTool(db, caller, {
      requestId: crypto.randomUUID(),
      externalToolName: 'stock_price_history',
      input: { stockCode: '600519' },
    }, { now: NOW + 31 })).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } })

    const requestId = crypto.randomUUID()
    expect(executeResearchAccessTool(db, caller, {
      requestId,
      externalToolName: 'stock_price_history',
      input: { stockCode: '600519' },
    }, { now: NOW + 60_032 })).toMatchObject({ ok: true })
    expect(executeResearchAccessTool(db, caller, {
      requestId,
      externalToolName: 'stock_price_history',
      input: { stockCode: '600519' },
    }, { now: NOW + 60_033 })).toMatchObject({ ok: false, error: { code: 'DUPLICATE_REQUEST' } })
  })

  it('uses one generic unauthorized response and does not expose profile existence', () => {
    const created = profile(['market.read', 'portfolio.read'])
    const usedRequestId = crypto.randomUUID()
    expect(executeResearchAccessTool(db, {
      profileId: created.profile.id,
      credential: created.credential!,
      surface: 'cli',
    }, {
      requestId: usedRequestId,
      externalToolName: 'stock_price_history',
      input: { stockCode: '600519', limit: 10 },
    }, { now: NOW })).toMatchObject({ ok: true })
    expect(executeResearchAccessTool(db, {
      profileId: created.profile.id,
      credential: 'twr_invalid',
      surface: 'cli',
    }, {
      requestId: usedRequestId,
      externalToolName: 'stock_price_history',
      input: { stockCode: '600519', limit: 10 },
    }, { now: NOW })).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } })

    const wrong = listAuthorizedResearchAccessTools(db, {
      profileId: created.profile.id,
      credential: 'twr_invalid',
      surface: 'mcp',
    })
    const missing = listAuthorizedResearchAccessTools(db, {
      profileId: crypto.randomUUID(),
      credential: 'twr_invalid',
      surface: 'mcp',
    })
    expect(wrong).toEqual(missing)
    expect(wrong).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } })
  })
})
