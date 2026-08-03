import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import {
  getStockFundamentalSnapshot,
  refreshStockFundamentals,
} from '../../electron/main/services/stockFundamentalService'

const NOW = Date.parse('2026-07-28T02:00:00.000Z')

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function profileBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    jbzl: [{
      SECUCODE: '600519.SH',
      SECURITY_CODE: '600519',
      SECURITY_NAME_ABBR: '贵州茅台',
      ORG_NAME: '贵州茅台酒股份有限公司',
      SECURITY_TYPE: 'A股',
      TRADE_MARKET: '上海证券交易所',
      EM2016: '白酒',
      CHAIRMAN: '测试董事长',
      LEGAL_PERSON: '测试代表',
      ORG_WEB: 'https://www.moutaichina.com/',
      ADDRESS: '贵州省仁怀市茅台镇',
      REG_CAPITAL: 125619.78,
      EMP_NUM: 32000,
      BUSINESS_SCOPE: '茅台酒系列产品的生产与销售。',
      ORG_PROFILE: '公司专注于酒类产品。',
      ...overrides,
    }],
  }
}

function financialRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    SECUCODE: '600519.SH',
    SECURITY_NAME_ABBR: '贵州茅台',
    REPORT_DATE: '2026-06-30 00:00:00',
    REPORT_TYPE: '中报',
    NOTICE_DATE: '2026-07-20 00:00:00',
    UPDATE_DATE: '2026-07-20 00:00:00',
    CURRENCY: 'CNY',
    TOTALOPERATEREVE: 91000000000,
    PARENTNETPROFIT: 47000000000,
    KCFJCXSYJLR: 46800000000,
    TOTALOPERATEREVETZ: 9.8,
    PARENTNETPROFITTZ: 11.2,
    KCFJCXSYJLRTZ: 10.9,
    ROEJQ: 18.6,
    XSMLL: 91.2,
    XSJLL: 51.6,
    ZCFZL: 17.3,
    NETCASH_OPERATE_PK: 52000000000,
    EPSJB: 37.4,
    BPS: 182.5,
    ...overrides,
  }
}

function financeBody(rows: Array<Record<string, unknown>> = [financialRow()]): unknown {
  return { success: true, code: 0, result: { data: rows } }
}

function announcementRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    art_code: 'AN202607200001',
    codes: [{ stock_code: '600519', short_name: '贵州茅台' }],
    columns: [{ column_code: '001002008', column_name: '其他' }],
    display_time: '2026-07-19 21:26:22:243',
    notice_date: '2026-07-20 00:00:00',
    title_ch: '贵州茅台:贵州茅台重大事项公告',
    ...overrides,
  }
}

function announcementBody(rows: Array<Record<string, unknown>> = [announcementRow()]): unknown {
  return { success: 1, error: '', data: { list: rows, page_index: 1, page_size: 30 } }
}

function successFetcher(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.hostname === 'emweb.securities.eastmoney.com') return jsonResponse(profileBody())
    if (url.hostname === 'datacenter.eastmoney.com') return jsonResponse(financeBody())
    if (url.hostname === 'np-anotice-stock.eastmoney.com') return jsonResponse(announcementBody())
    throw new Error(`unexpected host: ${url.hostname}`)
  })
}

describe('FR-253 public stock fundamentals service', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE stock_info (
        stockCode TEXT PRIMARY KEY,
        stockName TEXT NOT NULL,
        fetchedAt INTEGER NOT NULL
      );
    `)
    runMigrations(db, DATABASE_MIGRATIONS.filter(
      (migration) => migration.version === 118 || migration.version === 119,
    ))
  })

  afterEach(() => {
    db.close()
  })

  it('keeps get local and persists complete profile and financial facts with nulls intact', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname === 'emweb.securities.eastmoney.com') return jsonResponse(profileBody())
      if (url.hostname === 'datacenter.eastmoney.com') {
        return jsonResponse(financeBody([
          financialRow({ XSMLL: null }),
          financialRow({
            REPORT_DATE: '2026-09-30 00:00:00',
            NOTICE_DATE: '2026-10-25 00:00:00',
            TOTALOPERATEREVE: 999999999999,
          }),
        ]))
      }
      return jsonResponse(announcementBody([
        announcementRow(),
        announcementRow({
          art_code: 'AN202608010001',
          display_time: '2026-08-01 09:00:00:000',
          notice_date: '2026-08-01 00:00:00',
          title_ch: '未来公告不得写入',
        }),
      ]))
    })

    const local = getStockFundamentalSnapshot(db, '600519.SH')
    expect(local).toMatchObject({ ok: true, snapshot: { status: 'missing' } })
    expect(fetcher).not.toHaveBeenCalled()

    const refreshed = await refreshStockFundamentals(db, '600519', {
      fetcher: fetcher as typeof fetch,
      now: NOW,
    })
    expect(refreshed).toMatchObject({
      ok: true,
      refreshStatus: 'complete',
      snapshot: {
        status: 'complete',
        profile: {
          legalName: '贵州茅台酒股份有限公司',
          businessScope: '茅台酒系列产品的生产与销售。',
          sourceFactDate: null,
        },
        latestFinancial: {
          reportDate: '20260630',
          noticeDate: '20260720',
          totalRevenue: 91000000000,
          grossMargin: null,
        },
        sources: {
          profile: { status: 'available', factDate: null },
          financial: { status: 'available', factDate: '20260720' },
          announcement: { status: 'available', factDate: '20260720' },
        },
        announcementSummary: { total: 1, attentionCount: 1, latestNoticeDate: '20260720' },
      },
    })
    if (!refreshed.ok) throw new Error('expected refresh success')
    expect(refreshed.snapshot.financialHistory).toHaveLength(1)
    expect(refreshed.snapshot.announcements).toMatchObject([{
      articleCode: 'AN202607200001',
      title: '贵州茅台:贵州茅台重大事项公告',
      categoryNames: ['其他'],
      attentionTags: ['major'],
      sourceUrl: 'https://data.eastmoney.com/notices/detail/600519/AN202607200001.html',
    }])
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM stock_fundamental_financials',
    ).get()).toEqual({ count: 1 })
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM stock_fundamental_announcements',
    ).get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT stockName FROM stock_info WHERE stockCode = ?').get('600519')).toEqual({
      stockName: '贵州茅台',
    })

    expect(fetcher).toHaveBeenCalledTimes(3)
    const urls = fetcher.mock.calls.map((call) => new URL(String(call[0])))
    const profileUrl = urls.find((url) => url.hostname === 'emweb.securities.eastmoney.com')
    const financeUrl = urls.find((url) => url.hostname === 'datacenter.eastmoney.com')
    const announcementUrl = urls.find((url) => url.hostname === 'np-anotice-stock.eastmoney.com')
    expect(profileUrl?.protocol).toBe('https:')
    expect(profileUrl?.searchParams.get('code')).toBe('SH600519')
    expect(financeUrl?.searchParams.get('reportName')).toBe('RPT_F10_FINANCE_MAINFINADATA')
    expect(financeUrl?.searchParams.get('pageSize')).toBe('8')
    expect(financeUrl?.searchParams.get('filter')).toBe('(SECUCODE="600519.SH")')
    expect(announcementUrl?.protocol).toBe('https:')
    expect(announcementUrl?.searchParams.get('stock_list')).toBe('600519')
    expect(announcementUrl?.searchParams.get('page_size')).toBe('30')
  })

  it('returns partial success when one source fails and keeps independent diagnostics', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname === 'emweb.securities.eastmoney.com') {
        return jsonResponse({ error: 'unavailable' }, 503)
      }
      return url.hostname === 'datacenter.eastmoney.com'
        ? jsonResponse(financeBody())
        : jsonResponse(announcementBody())
    })

    const result = await refreshStockFundamentals(db, '600519', {
      fetcher: fetcher as typeof fetch,
      now: NOW,
    })
    expect(result).toMatchObject({
      ok: true,
      refreshStatus: 'partial',
      snapshot: {
        status: 'partial',
        profile: null,
        sources: {
          profile: { status: 'failed', errorCode: 'PROFILE_HTTP_ERROR' },
          financial: { status: 'available' },
          announcement: { status: 'available' },
        },
      },
    })
  })

  it('treats a valid empty announcement list as checked and complete', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname === 'emweb.securities.eastmoney.com') return jsonResponse(profileBody())
      if (url.hostname === 'datacenter.eastmoney.com') return jsonResponse(financeBody())
      return jsonResponse(announcementBody([]))
    })

    const result = await refreshStockFundamentals(db, '600519', {
      fetcher: fetcher as typeof fetch,
      now: NOW,
    })
    expect(result).toMatchObject({
      ok: true,
      refreshStatus: 'complete',
      snapshot: {
        status: 'complete',
        announcements: [],
        announcementSummary: { total: 0, attentionCount: 0, latestNoticeDate: null },
        sources: { announcement: { status: 'available', rowsWritten: 0 } },
      },
    })
  })

  it('preserves old facts and marks both latest attempts failed', async () => {
    const firstFetcher = successFetcher()
    const first = await refreshStockFundamentals(db, '600519', {
      fetcher: firstFetcher as typeof fetch,
      now: NOW,
    })
    expect(first.ok).toBe(true)

    const mismatchedFetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname === 'emweb.securities.eastmoney.com') {
        return jsonResponse(profileBody({ SECUCODE: '000001.SZ', SECURITY_CODE: '000001' }))
      }
      return url.hostname === 'datacenter.eastmoney.com'
        ? jsonResponse(financeBody([financialRow({ SECUCODE: '000001.SZ' })]))
        : jsonResponse(announcementBody([
          announcementRow({ codes: [{ stock_code: '000001', short_name: '平安银行' }] }),
        ]))
    })
    const failed = await refreshStockFundamentals(db, '600519', {
      fetcher: mismatchedFetcher as typeof fetch,
      now: NOW + 1000,
    })

    expect(failed).toMatchObject({
      ok: false,
      code: 'PROFILE_UPSTREAM_ERROR',
      snapshot: {
        status: 'complete',
        profile: { legalName: '贵州茅台酒股份有限公司' },
        latestFinancial: { reportDate: '20260630' },
        sources: {
          profile: { status: 'failed', errorCode: 'PROFILE_UPSTREAM_ERROR', lastSuccessAt: NOW },
          financial: { status: 'failed', errorCode: 'FINANCIAL_EMPTY', lastSuccessAt: NOW },
          announcement: {
            status: 'failed',
            errorCode: 'ANNOUNCEMENT_UPSTREAM_ERROR',
            lastSuccessAt: NOW,
          },
        },
      },
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM stock_fundamental_profiles').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM stock_fundamental_financials').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM stock_fundamental_announcements').get()).toEqual({ count: 1 })
  })

  it('rejects invalid and mismatched codes without writing facts', async () => {
    const fetcher = successFetcher()
    const invalid = await refreshStockFundamentals(db, '000001.SH', {
      fetcher: fetcher as typeof fetch,
      now: NOW,
    })
    expect(invalid).toMatchObject({ ok: false, code: 'INVALID_STOCK_CODE', snapshot: null })
    expect(fetcher).not.toHaveBeenCalled()

    const mismatchFetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname === 'emweb.securities.eastmoney.com') {
        return jsonResponse(profileBody({ SECUCODE: '000001.SZ', SECURITY_CODE: '000001' }))
      }
      return url.hostname === 'datacenter.eastmoney.com'
        ? jsonResponse(financeBody([financialRow({ SECUCODE: '000001.SZ' })]))
        : jsonResponse(announcementBody([
          announcementRow({ codes: [{ stock_code: '000001', short_name: '平安银行' }] }),
        ]))
    })
    await refreshStockFundamentals(db, '600519', {
      fetcher: mismatchFetcher as typeof fetch,
      now: NOW,
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM stock_fundamental_profiles').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM stock_fundamental_financials').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM stock_fundamental_announcements').get()).toEqual({ count: 0 })
  })

  it('reuses concurrent refreshes and keeps identical facts idempotent across later refreshes', async () => {
    const fetcher = successFetcher()
    const first = refreshStockFundamentals(db, '600519', {
      fetcher: fetcher as typeof fetch,
      now: NOW,
    })
    const second = refreshStockFundamentals(db, '600519.SH', {
      fetcher: fetcher as typeof fetch,
      now: NOW,
    })
    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(fetcher).toHaveBeenCalledTimes(3)

    const originalVersion = db.prepare(
      'SELECT source_version FROM stock_fundamental_financials',
    ).get() as { source_version: string }
    await refreshStockFundamentals(db, '600519', {
      fetcher: fetcher as typeof fetch,
      now: NOW + 60_000,
    })
    expect(fetcher).toHaveBeenCalledTimes(6)
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM stock_fundamental_financials',
    ).get()).toEqual({ count: 1 })
    expect(db.prepare(
      'SELECT source_version, fetched_at FROM stock_fundamental_financials',
    ).get()).toEqual({ source_version: originalVersion.source_version, fetched_at: NOW + 60_000 })
  })
})
