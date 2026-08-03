import { describe, expect, it, vi } from 'vitest'
import {
  PREMARKET_EXTERNAL_ASSETS,
  fetchPremarketExternalFacts,
  type PremarketFetch,
} from '../../electron/main/services/premarketGlobalFactProvider'

const cutoffAt = Date.parse('2026-07-31T08:45:00+08:00')

function toSeconds(value: string): number {
  return Date.parse(value) / 1000
}

function buildRows(stage: 'overnight' | 'asia_open') {
  return PREMARKET_EXTERNAL_ASSETS
    .filter((definition) => definition.stages.includes(stage))
    .map((definition, index) => {
      const [market, code] = definition.securityId.split('.')
      const observedAt = definition.region === 'asia'
        ? toSeconds('2026-07-31T08:44:00+08:00')
        : definition.region === 'us'
          ? toSeconds('2026-07-31T04:00:00+08:00')
          : toSeconds('2026-07-31T08:43:00+08:00')
      return {
        f2: 100 + index,
        f3: 1 + index / 10,
        f12: code,
        f13: Number(market),
        f14: definition.fallbackName,
        f17: 99 + index,
        f18: 98 + index,
        f124: observedAt,
      }
    })
}

function successFetcher(rows: unknown[]): PremarketFetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { diff: rows } }),
  }))
}

describe('premarketGlobalFactProvider', () => {
  it('使用固定白名单解析08:45核心事实并保留上游观测时间', async () => {
    const fetcher = successFetcher(buildRows('asia_open'))
    const result = await fetchPremarketExternalFacts({
      stage: 'asia_open',
      cutoffAt,
      fetcher,
      now: () => cutoffAt,
      retryCount: 0,
    })

    expect(result.status).toBe('ready')
    expect(result.observations).toHaveLength(11)
    expect(result.observations.find((item) => item.assetId === 'asia.nikkei225')?.observedAt)
      .toBe(Date.parse('2026-07-31T08:44:00+08:00'))
    const requestedUrl = String(vi.mocked(fetcher).mock.calls[0][0])
    expect(requestedUrl).toContain('secids=100.DJIA%2C100.NDX%2C100.SPX')
    expect(requestedUrl).toContain('fltt=2')
    expect(requestedUrl).not.toContain('http%3A')
  })

  it('未来、陈旧和缺失观测逐项降级而不是填0', async () => {
    const rows = buildRows('asia_open')
    const kospi = rows.find((row) => row.f12 === 'KS11')
    if (kospi) kospi.f124 = toSeconds('2026-07-31T08:51:00+08:00')
    const nikkei = rows.find((row) => row.f12 === 'N225')
    if (nikkei) nikkei.f124 = toSeconds('2026-07-31T05:00:00+08:00')
    const withoutCopper = rows.filter((row) => row.f12 !== 'HG00Y')
    const result = await fetchPremarketExternalFacts({
      stage: 'asia_open',
      cutoffAt,
      fetcher: successFetcher(withoutCopper),
      now: () => cutoffAt,
      retryCount: 0,
    })

    expect(result.status).toBe('partial')
    expect(result.observations.some((item) => item.assetId === 'asia.kospi')).toBe(false)
    expect(result.observations.some((item) => item.assetId === 'asia.nikkei225')).toBe(false)
    expect(result.warnings).toContain('OBSERVATION_AFTER_CUTOFF:asia.kospi')
    expect(result.warnings).toContain('OBSERVATION_STALE:asia.nikkei225')
    expect(result.warnings).toContain('OBSERVATION_MISSING:commodity.copper')
  })

  it('网络失败有限重试并返回稳定失败信封', async () => {
    const fetcher = vi.fn(async () => { throw new Error('socket closed') }) as PremarketFetch
    const result = await fetchPremarketExternalFacts({
      stage: 'overnight',
      cutoffAt,
      fetcher,
      now: () => cutoffAt,
      retryCount: 1,
      timeoutMs: 100,
    })

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(result.status).toBe('failed')
    expect(result.source.errorCode).toBe('NETWORK_ERROR')
    expect(result.observations).toEqual([])
  })

  it('周一盘前接受上周五已完成的美股时段，但不放宽亚洲早盘新鲜度', async () => {
    const mondayCutoff = Date.parse('2026-08-03T08:45:00+08:00')
    const rows = buildRows('asia_open')
    for (const row of rows) {
      if (['DJIA', 'NDX', 'SPX', 'US10Y', 'VIXY'].includes(row.f12)) {
        row.f124 = toSeconds('2026-07-31T04:00:00+08:00')
      } else if (['N225', 'KS11'].includes(row.f12)) {
        row.f124 = toSeconds('2026-07-31T14:30:00+08:00')
      } else {
        row.f124 = toSeconds('2026-08-03T08:43:00+08:00')
      }
    }
    const result = await fetchPremarketExternalFacts({
      stage: 'asia_open',
      cutoffAt: mondayCutoff,
      fetcher: successFetcher(rows),
      now: () => mondayCutoff,
      retryCount: 0,
    })

    expect(result.observations.filter((item) => item.region === 'us')).toHaveLength(5)
    expect(result.observations.filter((item) => item.region === 'asia')).toHaveLength(0)
    expect(result.warnings).toContain('OBSERVATION_STALE:asia.nikkei225')
    expect(result.warnings).toContain('OBSERVATION_STALE:asia.kospi')
  })
})
