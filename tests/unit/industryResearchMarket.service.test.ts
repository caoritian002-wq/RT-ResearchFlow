import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { upsertDailyClose } from '../../electron/main/database/dailyCloseCacheRepository'
import { runMigrations } from '../../electron/main/database/db'
import {
  saveMarketSyncRun,
  upsertSecurityAdjustmentFactors,
  upsertSecurityValuationDaily,
} from '../../electron/main/database/industryResearchMarketRepository'
import {
  saveResearchCompany,
  saveResearchProjectCompany,
  saveResearchSecurity,
} from '../../electron/main/database/industryResearchFinancialRepository'
import { createResearchProject } from '../../electron/main/database/industryResearchRepository'
import {
  benchmarkForSecurity,
  buildIndustryResearchMarketContext,
  syncIndustryResearchMarketData,
} from '../../electron/main/services/industryResearchMarketService'
import { saveIndustryResearchEvidence } from '../../electron/main/services/industryResearchService'
import type { DailyRow } from '../../electron/main/services/tushareService'

function tradeDates(count: number, start = '2025-07-01'): string[] {
  const result: string[] = []
  const date = new Date(`${start}T00:00:00Z`)
  while (result.length < count) {
    const day = date.getUTCDay()
    if (day !== 0 && day !== 6) result.push(date.toISOString().slice(0, 10).replaceAll('-', ''))
    date.setUTCDate(date.getUTCDate() + 1)
  }
  return result
}

function daily(tsCode: string, tradeDate: string, close: number): DailyRow {
  return {
    tsCode, tradeDate, open: close, high: close, low: close, close,
    pctChg: 0, vol: 1000, turnoverRate: null,
  }
}

function seedScope(db: Database.Database): void {
  createResearchProject(db, {
    id: 'project-market', title: '市场服务研究', industryName: '光通信', productScope: '光模块',
    regionScope: '中国', timeScope: '2026', purpose: 'investment', depth: 'standard', sourceType: 'manual',
    skillId: 'builtin:industry-chain-research', skillContentHash: 'a'.repeat(64), skillRuleVersion: 'v1',
  })
  saveResearchCompany(db, { id: 'company-market', legalName: '示例光通信股份有限公司', sourceType: 'manual' }, 1)
  saveResearchSecurity(db, {
    id: 'security-market', companyId: 'company-market', tsCode: '600001.SH', exchange: 'SSE',
    securityType: 'A_SHARE', mappingSource: 'manual',
  }, 2)
  saveResearchProjectCompany(db, { projectId: 'project-market', companyId: 'company-market', status: 'core' }, 3)
}

describe('产业研究市场服务', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    seedScope(db)
  })

  it('使用最近共同交易日计算前复权窗口、事件窗口和点时估值分位', () => {
    const dates = tradeDates(260)
    upsertDailyClose(db, dates.flatMap((date, index) => [
      daily('600001.SH', date, 100 + index),
      daily('000001.SH', date, 200 + index),
    ]))
    upsertSecurityAdjustmentFactors(db, dates.map((date, index) => ({
      ts_code: '600001.SH', trade_date: date, adj_factor: index >= 250 ? 2 : 1,
      source: 'seed', fetched_at: 1,
    })))
    upsertSecurityValuationDaily(db, dates.map((date, index) => ({
      ts_code: '600001.SH', trade_date: date, total_share: 100000, float_share: 80000,
      total_mv: 1000000 + index, circ_mv: 800000 + index, pe_ttm: 10 + index / 100,
      pb: 1 + index / 1000, ps_ttm: 2 + index / 1000, dv_ttm: 1,
      source: 'seed', fetched_at: 1,
    })))
    for (const [suffix, pe, pb, ps] of [['peer-a', 20, 2, 3], ['peer-b', 30, 3, 4]] as const) {
      saveResearchCompany(db, { id: `company-${suffix}`, legalName: `可比公司${suffix}`, sourceType: 'manual' }, 1)
      saveResearchSecurity(db, {
        id: `security-${suffix}`, companyId: `company-${suffix}`, tsCode: suffix === 'peer-a' ? '000002.SZ' : '300003.SZ',
        exchange: 'SZSE', securityType: 'A_SHARE', mappingSource: 'manual',
      }, 2)
      saveResearchProjectCompany(db, { projectId: 'project-market', companyId: `company-${suffix}`, status: 'watching' }, 3)
      upsertSecurityValuationDaily(db, [{
        ts_code: suffix === 'peer-a' ? '000002.SZ' : '300003.SZ', trade_date: dates[259],
        total_share: 100000, float_share: 80000, total_mv: 1000000, circ_mv: 800000,
        pe_ttm: pe, pb, ps_ttm: ps, dv_ttm: 1, source: 'seed', fetched_at: 1,
      }])
    }
    saveIndustryResearchEvidence(db, 'project-market', {
      id: 'event-evidence', title: '产品提价公告', sourceType: 'official', sourceName: '公司公告',
      sourceUrl: 'https://example.com/notice', publishedDate: dates[200], factDate: dates[200],
      statementKind: 'fact', direction: 'support', reliability: 'primary', createdBy: 'human',
      primarySourceConfirmed: true,
    })

    const context = buildIndustryResearchMarketContext(db, {
      projectId: 'project-market', companyId: 'company-market', securityId: 'security-market',
      valuationDate: dates.at(-1),
    })

    expect(context.status).toBe('ok')
    expect(context.marketDate).toBe(dates.at(-1))
    expect(context.benchmarkCode).toBe('000001.SH')
    expect(context.rawClose).toBe(359)
    expect(context.windows.map((window) => window.days)).toEqual([20, 60, 120, 250])
    expect(context.windows[0]).toEqual(expect.objectContaining({
      status: 'ok', startDate: dates[239], endDate: dates[259],
      stockReturnPct: 111.8, benchmarkReturnPct: 4.56, excessReturnPct: 107.24,
    }))
    expect(context.series).toHaveLength(120)
    expect(context.events).toEqual([
      expect.objectContaining({ id: 'event-evidence', anchorDate: dates[200], post5Pct: expect.any(Number) }),
    ])
    expect(context.valuationDaily).toEqual(expect.objectContaining({ tradeDate: dates[259], peTtm: 12.59 }))
    expect(context.valuationHistory.peTtm).toEqual(expect.objectContaining({ sampleCount: 260, percentile: 100 }))
    expect(context.comparables).toEqual(expect.objectContaining({
      status: 'ok', sampleCount: 3,
      currentPercentiles: expect.objectContaining({ peTtm: 33.33, pb: 33.33, psTtm: 33.33 }),
    }))
    expect(context.factFingerprint).toMatch(/^[a-f0-9]{64}$/)

    const fingerprint = context.factFingerprint
    upsertDailyClose(db, [daily('600001.SH', dates[259], 360)])
    expect(buildIndustryResearchMarketContext(db, {
      projectId: 'project-market', companyId: 'company-market', securityId: 'security-market',
      valuationDate: dates[259],
    }).factFingerprint).not.toBe(fingerprint)
    db.close()
  })

  it('按请求日截断未来数据，缺少调整因子时窗口保持blocked/null而不是0', () => {
    const dates = tradeDates(260)
    upsertDailyClose(db, dates.flatMap((date, index) => [
      daily('600001.SH', date, 10 + index),
      daily('000001.SH', date, 100 + index),
    ]))
    upsertSecurityValuationDaily(db, dates.map((date, index) => ({
      ts_code: '600001.SH', trade_date: date, total_share: 1000, float_share: 800,
      total_mv: 10000, circ_mv: 8000, pe_ttm: 10 + index, pb: 1, ps_ttm: 2, dv_ttm: null,
      source: 'seed', fetched_at: 1,
    })))
    saveMarketSyncRun(db, {
      id: 'corrupt-sync', request_id: 'corrupt-sync-request', project_id: 'project-market',
      company_id: 'company-market', security_id: 'security-market', ts_code: '600001.SH',
      benchmark_code: '000001.SH', status: 'partial', result_json: '{broken', data_start: dates[0],
      data_end: dates[220], fact_fingerprint: null, error_code: 'UPSTREAM_ERROR', started_at: 1, completed_at: 2,
    })

    const context = buildIndustryResearchMarketContext(db, {
      projectId: 'project-market', companyId: 'company-market', securityId: 'security-market',
      valuationDate: dates[220],
    })

    expect(context.marketDate).toBe(dates[220])
    expect(context.valuationDaily?.tradeDate).toBe(dates[220])
    expect(context.reasons).toContainEqual(expect.objectContaining({ code: 'ADJUSTMENT_FACTOR_MISSING' }))
    expect(context.reasons).toContainEqual(expect.objectContaining({ code: 'MARKET_DATA_STALE' }))
    expect(context.windows.slice(0, 3).every((window) => window.status === 'blocked')).toBe(true)
    expect(context.windows.slice(0, 3).every((window) => window.stockReturnPct === null)).toBe(true)
    expect(context.windows[3]).toEqual(expect.objectContaining({ status: 'blocked', stockReturnPct: null }))
    expect(context.valuationHistory.peTtm.percentile).not.toBeNull()
    expect(context.comparables).toEqual(expect.objectContaining({ status: 'blocked', sampleCount: 1 }))
    expect(context.comparables.rows).toHaveLength(1)
    expect(context.latestSync).toEqual(expect.objectContaining({ result: { dataStatus: 'corrupt' } }))
    expect(benchmarkForSecurity('688001.SH')).toEqual({ code: '000688.SH', name: '科创50' })
    expect(benchmarkForSecurity('300001.SZ')).toEqual({ code: '399006.SZ', name: '创业板指' })
    expect(benchmarkForSecurity('000001.HK')).toBeNull()
    db.close()
  })

  it('显式同步四段失败隔离、保留旧缓存并按请求幂等', async () => {
    const dates = tradeDates(3, '2026-07-15')
    upsertSecurityAdjustmentFactors(db, [
      { ts_code: '600001.SH', trade_date: dates[0], adj_factor: 1.5, source: 'old', fetched_at: 1 },
    ])
    const fetchers = {
      daily: vi.fn(async () => dates.map((date, index) => daily('600001.SH', date, 10 + index))),
      adjustment: vi.fn(async () => { throw new Error('permission denied') }),
      valuation: vi.fn(async () => []),
      indexDaily: vi.fn(async () => dates.map((date, index) => daily('000001.SH', date, 100 + index))),
    }
    const requestId = randomUUID()
    const result = await syncIndustryResearchMarketData(db, 'token', {
      projectId: 'project-market', companyId: 'company-market', securityId: 'security-market',
      requestId, valuationDate: '2026-07-17',
    }, Date.parse('2026-07-17T08:00:00Z'), fetchers)

    expect(result).toEqual(expect.objectContaining({ status: 'partial', errorCode: 'PERMISSION_REQUIRED' }))
    expect(result.result).toEqual(expect.objectContaining({
      valuation: { status: 'failed', rows: 0, errorCode: 'EMPTY_RESPONSE' },
    }))
    expect(db.prepare(`SELECT adj_factor, source FROM security_adjustment_factor_cache WHERE ts_code = '600001.SH'`).get())
      .toEqual({ adj_factor: 1.5, source: 'old' })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM daily_close_cache WHERE ts_code IN ('600001.SH', '000001.SH')`).get())
      .toEqual({ count: 6 })

    const retry = await syncIndustryResearchMarketData(db, 'token', {
      projectId: 'project-market', companyId: 'company-market', securityId: 'security-market',
      requestId, valuationDate: '2026-07-17',
    }, Date.parse('2026-07-17T08:00:00Z'), fetchers)
    expect(retry).toEqual(result)
    expect(fetchers.daily).toHaveBeenCalledTimes(1)
    expect(fetchers.adjustment).toHaveBeenCalledTimes(1)
    db.close()
  })
})
