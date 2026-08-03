import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import { getPremarketFactSnapshot } from '../../electron/main/database/premarketFactSnapshotRepository'
import {
  EASTMONEY_GLOBAL_HISTORY_PROVIDER_ID,
  recoverPremarketExternalFacts,
  recoverPremarketExternalSnapshot,
  TUSHARE_GLOBAL_INDEX_PROVIDER_ID,
  type PremarketRecoveryFetch,
} from '../../electron/main/services/premarketExternalRecoveryService'
import { getPremarketStageCutoffAt } from '../../electron/main/services/premarketCutoffPolicy'
import { PREMARKET_FACT_RULE_VERSION } from '../../electron/main/services/premarketSnapshotService'
import type { TushareGlobalIndexDailyRow } from '../../electron/main/services/tushareService'

const tradeDate = '20260803'
const cutoffAt = getPremarketStageCutoffAt(tradeDate, 'asia_open')
const requestedAt = Date.parse('2026-08-03T10:00:00+08:00')

function response(klines: string[]): Awaited<ReturnType<PremarketRecoveryFetch>> {
  return {
    ok: true,
    status: 200,
    json: async () => ({ rc: 0, data: { klines } }),
  }
}

function dailyKline(changePercent = 1): string {
  return `2026-07-31,100,101,102,99,1000,100000,2,${changePercent},1`
}

function minuteKline(clock = '08:45', changePercent = 1): string {
  return `2026-08-03 ${clock},100,101,102,99,1000,100000,2,${changePercent},1`
}

function publicFetcher(options: { minuteClock?: string; omit?: string[] } = {}): PremarketRecoveryFetch {
  return vi.fn(async (value: string) => {
    const url = new URL(value)
    const securityId = url.searchParams.get('secid') ?? ''
    if (options.omit?.includes(securityId)) return response([])
    return response(url.searchParams.get('klt') === '101'
      ? [dailyKline()]
      : [minuteKline(options.minuteClock)])
  })
}

function tushareRows(): TushareGlobalIndexDailyRow[] {
  return ['DJI', 'IXIC', 'SPX'].map((tsCode) => ({
    tsCode,
    tradeDate: '20260731',
    open: 100,
    close: 101,
    high: 102,
    low: 99,
    previousClose: 100,
    changePercent: 1,
  }))
}

describe('premarketExternalRecoveryService', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, DATABASE_MIGRATIONS)
  })

  afterEach(() => db.close())

  it('优先使用Tushare美股日线，并以东方财富补齐08:45亚洲与离岸事实', async () => {
    const fetcher = publicFetcher()
    const fetchTushareDaily = vi.fn(async () => tushareRows())

    const result = await recoverPremarketExternalFacts(tradeDate, cutoffAt, {
      token: 'token',
      now: requestedAt,
      fetcher,
      fetchTushareDaily,
    })

    expect(result.status).toBe('ready')
    expect(result.observations).toHaveLength(7)
    expect(fetchTushareDaily).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: TUSHARE_GLOBAL_INDEX_PROVIDER_ID, status: 'ready', observationCount: 3 }),
      expect.objectContaining({ sourceId: EASTMONEY_GLOBAL_HISTORY_PROVIDER_ID, status: 'ready', observationCount: 4 }),
    ]))
  })

  it('普通用户未配置Tushare时，全部回退东方财富历史接口', async () => {
    const result = await recoverPremarketExternalFacts(tradeDate, cutoffAt, {
      token: null,
      now: requestedAt,
      fetcher: publicFetcher(),
    })

    expect(result.status).toBe('ready')
    expect(result.observations).toHaveLength(7)
    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceId: TUSHARE_GLOBAL_INDEX_PROVIDER_ID,
        status: 'blocked',
        errorCode: 'TUSHARE_NOT_CONFIGURED',
      }),
      expect.objectContaining({ sourceId: EASTMONEY_GLOBAL_HISTORY_PROVIDER_ID, status: 'ready', observationCount: 7 }),
    ]))
  })

  it('Tushare权限不足时自动回退公共历史接口', async () => {
    const result = await recoverPremarketExternalFacts(tradeDate, cutoffAt, {
      token: 'token',
      now: requestedAt,
      fetcher: publicFetcher(),
      fetchTushareDaily: vi.fn(async () => { throw new Error('TUSHARE_QUOTA_INSUFFICIENT') }),
    })

    expect(result.status).toBe('ready')
    expect(result.observations).toHaveLength(7)
    expect(result.warnings).toContain('TUSHARE_QUOTA_INSUFFICIENT')
    expect(result.sources[0]).toMatchObject({
      sourceId: TUSHARE_GLOBAL_INDEX_PROVIDER_ID,
      status: 'failed',
      errorCode: 'TUSHARE_QUOTA_INSUFFICIENT',
    })
  })

  it('拒绝08:45之后的分钟值，不能用盘中现值冒充盘前事实', async () => {
    const result = await recoverPremarketExternalFacts(tradeDate, cutoffAt, {
      token: null,
      now: requestedAt,
      fetcher: publicFetcher({ minuteClock: '08:46' }),
    })

    expect(result.observations.map((item) => item.assetId)).toEqual([
      'us.dow', 'us.nasdaq', 'us.sp500',
    ])
    expect(result.status).toBe('partial')
    expect(result.warnings).toContain('EXTERNAL_RISK_COVERAGE_INSUFFICIENT')
  })

  it('公共分钟缺失时保留逐项诊断，外盘广度继续标记不足', async () => {
    const result = await recoverPremarketExternalFacts(tradeDate, cutoffAt, {
      token: null,
      now: requestedAt,
      fetcher: publicFetcher({ omit: ['100.N225', '100.KS11'] }),
    })

    expect(result.observations).toHaveLength(5)
    expect(result.warnings).toEqual(expect.arrayContaining([
      'EASTMONEY_HISTORY_MISSING:asia.nikkei225',
      'EASTMONEY_HISTORY_MISSING:asia.kospi',
      'EXTERNAL_RISK_COVERAGE_INSUFFICIENT',
    ]))
  })

  it('公共请求抛错时仍保留对应资产诊断', async () => {
    const fetcher = publicFetcher()
    const rejectingFetcher: PremarketRecoveryFetch = async (url, init) => {
      if (new URL(url).searchParams.get('secid') === '100.KS11') throw new Error('network failed')
      return fetcher(url, init)
    }
    const result = await recoverPremarketExternalFacts(tradeDate, cutoffAt, {
      token: null,
      now: requestedAt,
      fetcher: rejectingFetcher,
    })

    expect(result.warnings).toContain('EASTMONEY_HISTORY_MISSING:asia.kospi')
    expect(result.observations.some((item) => item.assetId === 'asia.kospi')).toBe(false)
  })

  it('手动恢复追加事实快照R2并保留R1', async () => {
    const first = await recoverPremarketExternalSnapshot(db, tradeDate, {
      token: null,
      now: requestedAt - 1,
      fetcher: publicFetcher({ omit: ['100.N225', '100.KS11'] }),
    })
    const recovered = await recoverPremarketExternalSnapshot(db, tradeDate, {
      token: null,
      now: requestedAt,
      fetcher: publicFetcher(),
    })

    expect(first.snapshot).toMatchObject({ revision: 1, status: 'partial' })
    expect(recovered).toMatchObject({ status: 'completed', itemCount: 7 })
    expect(recovered.snapshot).toMatchObject({
      revision: 2,
      revisionKind: 'manual_backfill',
      previousRevisionId: first.snapshot?.id,
      requestedAt,
    })
    expect(getPremarketFactSnapshot(db, tradeDate, 'asia_open', PREMARKET_FACT_RULE_VERSION)?.id)
      .toBe(recovered.snapshot?.id)
    expect(db.prepare('SELECT COUNT(*) AS count FROM premarket_fact_snapshots').get())
      .toEqual({ count: 2 })
  })
})
