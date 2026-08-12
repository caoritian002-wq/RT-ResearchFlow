import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SHENWAN_L1_INDUSTRIES } from '../../electron/main/services/eastmoneyIndustryHierarchy'
import { getMarketResonanceSnapshot } from '../../electron/main/services/marketResonanceService'

const fetchMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  net: { fetch: fetchMock },
}))

function trendsFor(secid: string): string[] {
  return ['2026-08-06', '2026-08-07', '2026-08-10'].flatMap((date, dateIndex) => (
    Array.from({ length: 36 }, (_, index) => {
      const minutes = 9 * 60 + 30 + index
      const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
      const price = 100 + dateIndex + index * 0.01 + (secid.charCodeAt(secid.length - 1) % 5) * 0.001
      return `${date} ${time},${price.toFixed(3)},0,0,0,0,0,0`
    })
  ))
}

describe('FR-261 市场共振历史补采', () => {
  let db: Database.Database

  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = new URL(String(input))
      const secid = url.searchParams.get('secid') ?? 'unknown'
      return {
        ok: true,
        json: async () => ({
          data: { code: secid, name: secid, preClose: 100, trends: trendsFor(secid) },
        }),
      }
    })
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE sector_flow_observations (
        trade_date TEXT NOT NULL,
        provider TEXT NOT NULL,
        scope TEXT NOT NULL,
        board_code TEXT NOT NULL,
        board_name TEXT NOT NULL,
        metric_kind TEXT NOT NULL,
        weighted_change REAL NOT NULL,
        up_count INTEGER NOT NULL,
        down_count INTEGER NOT NULL,
        flat_count INTEGER NOT NULL,
        main_net_inflow REAL,
        main_net_inflow_rate REAL
      );
      CREATE TABLE market_resonance_daily_snapshots (
        trade_date TEXT PRIMARY KEY,
        data_mode TEXT NOT NULL,
        source_label TEXT NOT NULL,
        coverage_available INTEGER NOT NULL,
        coverage_total INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        snapshot_sha256 TEXT NOT NULL,
        captured_at INTEGER NOT NULL
      );
    `)
    const insert = db.prepare(`
      INSERT INTO sector_flow_observations VALUES (
        '20260807', 'eastmoney', 'industry', ?, ?, 'verified_flow', 1.5, 60, 30, 10, 1000000, 1.2
      )
    `)
    for (const industry of SHENWAN_L1_INDUSTRIES) insert.run(industry.code, industry.name)
  })

  afterEach(() => db.close())

  it('从多日响应中只提取目标交易日并在二次读取时命中本地快照', async () => {
    const backfilled = await getMarketResonanceSnapshot(db, {
      tradeDate: '20260807',
      forceRefresh: true,
    })
    const requestCount = fetchMock.mock.calls.length

    expect(backfilled.tradeDate).toBe('20260807')
    expect(backfilled.sourceMode).toBe('network_backfill')
    expect(backfilled.recoverableTradeDates).toEqual(['20260806', '20260807', '20260810'])
    expect(backfilled.benchmarks.every((item) => item.tradeDate === '20260807')).toBe(true)
    expect(backfilled.sectors.every((item) => item.tradeDate === '20260807')).toBe(true)
    expect(backfilled.coverage).toMatchObject({
      available: SHENWAN_L1_INDUSTRIES.length,
      total: SHENWAN_L1_INDUSTRIES.length,
      boardFacts: { available: SHENWAN_L1_INDUSTRIES.length, total: SHENWAN_L1_INDUSTRIES.length },
    })

    const local = await getMarketResonanceSnapshot(db, { tradeDate: '20260807' })
    expect(local.sourceMode).toBe('local_archive')
    expect(fetchMock).toHaveBeenCalledTimes(requestCount)
  })

  it('拒绝未来日期, 并在本地快照日期漂移时标记损坏', async () => {
    await expect(getMarketResonanceSnapshot(db, { tradeDate: '20990101' }))
      .rejects.toThrow('INVALID_MARKET_OVERVIEW_REQUEST')

    await getMarketResonanceSnapshot(db, {
      tradeDate: '20260807',
      forceRefresh: true,
    })
    const row = db.prepare(`
      SELECT snapshot_json FROM market_resonance_daily_snapshots WHERE trade_date = '20260807'
    `).get() as { snapshot_json: string }
    const parsed = JSON.parse(row.snapshot_json) as {
      tradeDate: string
      benchmarks: Array<{ tradeDate: string }>
      sectors: Array<{ tradeDate: string }>
    }
    parsed.benchmarks[0].tradeDate = '20260806'
    const nextJson = JSON.stringify(parsed)
    db.prepare(`
      UPDATE market_resonance_daily_snapshots
      SET snapshot_json = ?, snapshot_sha256 = ?
      WHERE trade_date = '20260807'
    `).run(
      nextJson,
      require('node:crypto').createHash('sha256').update(nextJson, 'utf8').digest('hex'),
    )

    await expect(getMarketResonanceSnapshot(db, { tradeDate: '20260807' }))
      .rejects.toThrow('MARKET_RESONANCE_ARCHIVE_CORRUPTED')
  })

  it('历史板块截面缺失时明确降级且不伪装为完整覆盖', async () => {
    db.prepare('DELETE FROM sector_flow_observations').run()

    const snapshot = await getMarketResonanceSnapshot(db, {
      tradeDate: '20260807',
      forceRefresh: true,
    })

    expect(snapshot.dataMode).toBe('partial')
    expect(snapshot.sourceMode).toBe('network_backfill')
    expect(snapshot.coverage).toMatchObject({
      available: 0,
      boardFacts: { available: 0, total: SHENWAN_L1_INDUSTRIES.length },
      sectorTrends: {
        available: SHENWAN_L1_INDUSTRIES.length,
        total: SHENWAN_L1_INDUSTRIES.length,
      },
    })
    expect(snapshot.sectors.every((sector) => sector.breadthRate == null && sector.mainNetInflow == null)).toBe(true)
  })

  it('历史分钟曲线不可恢复时仍用同日板块事实形成可回看降级页', async () => {
    fetchMock.mockRejectedValue(new Error('NETWORK_UNAVAILABLE'))

    const snapshot = await getMarketResonanceSnapshot(db, {
      tradeDate: '20260807',
      forceRefresh: true,
    })

    expect(snapshot.dataMode).toBe('partial')
    expect(snapshot.sourceMode).toBe('network_backfill')
    expect(snapshot.sourceLabel).toContain('历史分钟曲线暂不可恢复')
    expect(snapshot.coverage).toMatchObject({
      available: 0,
      benchmarkTrends: { available: 0, total: 3 },
      sectorTrends: { available: 0, total: SHENWAN_L1_INDUSTRIES.length },
      boardFacts: {
        available: SHENWAN_L1_INDUSTRIES.length,
        total: SHENWAN_L1_INDUSTRIES.length,
      },
    })
    expect(snapshot.benchmarks).toHaveLength(3)
    expect(snapshot.benchmarks.every((benchmark) => benchmark.points.length === 0)).toBe(true)
    expect(snapshot.sectors).toHaveLength(SHENWAN_L1_INDUSTRIES.length)
    expect(snapshot.sectors.every((sector) => (
      sector.change === 1.5
      && sector.points.length === 0
      && sector.metrics.shanghai.state === 'insufficient'
    ))).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.every(([input]) => (
      new URL(String(input)).searchParams.get('secid') === '1.000001'
    ))).toBe(true)
  })

  it('低质量重新补采不会替换或投影覆盖更好的本地快照', async () => {
    const complete = await getMarketResonanceSnapshot(db, {
      tradeDate: '20260807',
      forceRefresh: true,
    })
    expect(complete.dataMode).toBe('archive')
    db.prepare('DELETE FROM sector_flow_observations').run()

    const displayed = await getMarketResonanceSnapshot(db, {
      tradeDate: '20260807',
      forceRefresh: true,
    })

    expect(displayed.dataMode).toBe('archive')
    expect(displayed.sourceMode).toBe('local_archive')
    expect(displayed.coverage.available).toBe(SHENWAN_L1_INDUSTRIES.length)
  })

  it('盘中部分覆盖保持实时来源, 不写入日级快照', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-10T02:00:00.000Z'))
    try {
      db.prepare('DELETE FROM sector_flow_observations').run()
      const snapshot = await getMarketResonanceSnapshot(db, {
        tradeDate: '20260810',
        forceRefresh: true,
      })

      expect(snapshot.dataMode).toBe('partial')
      expect(snapshot.sourceMode).toBe('realtime')
      expect(snapshot.coverage.boardFacts.available).toBe(0)
      const row = db.prepare(`
        SELECT COUNT(*) AS count FROM market_resonance_daily_snapshots WHERE trade_date = '20260810'
      `).get() as { count: number }
      expect(row.count).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('最新视图只用一个基准五日窗口发现可回看日期, 行业仍保持单日请求', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-10T02:00:00.000Z'))
    try {
      const snapshot = await getMarketResonanceSnapshot(db, { forceRefresh: true })
      const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)))
      const shanghaiRequest = urls.find((url) => url.searchParams.get('secid') === '1.000001')
      const sectorRequest = urls.find((url) => url.searchParams.get('secid')?.startsWith('90.'))

      expect(shanghaiRequest?.searchParams.get('ndays')).toBe('5')
      expect(shanghaiRequest?.searchParams.get('ut')).toBe('fa5fd1943c7b386f172d6893dbfba10b')
      expect(shanghaiRequest?.hostname).toBe('push2his.eastmoney.com')
      expect(sectorRequest?.searchParams.get('ndays')).toBe('1')
      expect(snapshot.recoverableTradeDates).toEqual(['20260806', '20260807', '20260810'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('历史节点未返回目标日期时继续回退, 不把非空的当前日响应当成功', async () => {
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = new URL(String(input))
      const secid = url.searchParams.get('secid') ?? 'unknown'
      const trends = url.hostname === 'push2his.eastmoney.com'
        ? trendsFor(secid).filter((item) => item.startsWith('2026-08-10 '))
        : trendsFor(secid)
      return {
        ok: true,
        json: async () => ({ data: { code: secid, name: secid, preClose: 100, trends } }),
      }
    })

    const snapshot = await getMarketResonanceSnapshot(db, {
      tradeDate: '20260807',
      forceRefresh: true,
    })
    const requestedHosts = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.searchParams.get('secid') === '1.000001')
      .map((url) => url.hostname)

    expect(snapshot.tradeDate).toBe('20260807')
    expect(requestedHosts.slice(0, 2)).toEqual([
      'push2his.eastmoney.com',
      'push2delay.eastmoney.com',
    ])
  })
})
