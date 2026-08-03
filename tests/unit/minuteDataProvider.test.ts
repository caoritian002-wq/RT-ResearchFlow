import { afterEach, describe, expect, it, vi } from 'vitest'
import { __privateForMinuteDataTests } from '../../electron/main/services/minuteData/sinaHistory5mProvider'
import { fetchMinuteBarsForUserTier } from '../../electron/main/services/minuteData/minuteDataProviderRegistry'
import { sinaHistory5mProvider } from '../../electron/main/services/minuteData/sinaHistory5mProvider'
import type { FreeMinuteCacheRow } from '../../electron/main/database/types'

const originalFetch = globalThis.fetch

function mockSinaFetch(): void {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    text: async () => JSON.stringify([
      { day: '2026-05-25 09:30:00', open: '9.8', high: '10.2', low: '9.7', close: '10', volume: '800' },
      { day: '2026-05-25 09:35:00', open: '10', high: '11', low: '9.8', close: '10.5', volume: '900' },
    ]),
  } as Response))
}

function createMinuteCacheDbStub() {
  const rows: FreeMinuteCacheRow[] = []
  return {
    rows,
    db: {
      prepare(sql: string) {
        if (sql.includes('SELECT')) {
          return {
            all(providerId: string, tsCode: string, tradeDate: string, granularity: string) {
              return rows.filter(row => row.providerId === providerId && row.tsCode === tsCode && row.tradeDate === tradeDate && row.granularity === granularity)
            },
          }
        }
        return {
          run(row: FreeMinuteCacheRow) {
            rows.push(row)
          },
        }
      },
      transaction(fn: (items: FreeMinuteCacheRow[]) => void) {
        return (items: FreeMinuteCacheRow[]) => fn(items)
      },
    } as never,
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('sinaHistory5mProvider helpers', () => {
  it('maps tushare codes to sina symbols', () => {
    expect(__privateForMinuteDataTests.toSinaSymbol('600519.SH')).toBe('sh600519')
    expect(__privateForMinuteDataTests.toSinaSymbol('300308.SZ')).toBe('sz300308')
    expect(__privateForMinuteDataTests.toSinaSymbol('000001')).toBe('sz000001')
  })

  it('filters rows by target trade date and keeps sorted minute bars', () => {
    const rows = __privateForMinuteDataTests.mapRows('300308.SZ', '20260525', [
      { day: '2026-05-26 09:35:00', open: '11', high: '12', low: '10', close: '11.5', volume: '1000' },
      { day: '2026-05-25 09:35:00', open: '10', high: '11', low: '9.8', close: '10.5', volume: '900' },
      { day: '2026-05-25 09:30:00', open: '9.8', high: '10.2', low: '9.7', close: '10', volume: '800' },
      { day: '2026-05-25 09:40:00', open: '10.5', high: '10.8', low: '10.1', close: '', volume: '700' },
    ])

    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.tsMinute)).toEqual(['09:30', '09:35'])
    expect(rows[0]).toMatchObject({ tsCode: '300308.SZ', tradeDate: '20260525', close: 10, amount: null })
  })

  it('routes free users to sina 5m data through the unified minute entry', async () => {
    mockSinaFetch()
    const stub = createMinuteCacheDbStub()
    const result = await fetchMinuteBarsForUserTier({
      db: stub.db,
      tsCode: '300308.SZ',
      tradeDate: '20260525',
      userTier: 'free',
      purpose: 'conditionBlocks',
      preferredGranularity: '1m',
      allowApproximate: true,
    })

    expect(result.status).toBe('success')
    expect(result.capability.providerId).toBe('sinaHistory5m')
    expect(result.capability.granularity).toBe('5m')
    expect(result.capability.isApproximate).toBe(true)
    expect(result.bars).toHaveLength(2)
  })

  it('keeps pro users on exact route when approximate fallback is not allowed', async () => {
    const result = await fetchMinuteBarsForUserTier({
      db: {} as never,
      tsCode: '300308.SZ',
      tradeDate: '20260525',
      userTier: 'pro',
      purpose: 'conditionBlocks',
      preferredGranularity: '1m',
      allowApproximate: false,
    })

    expect(result.status).toBe('unavailable')
    expect(result.capability.providerId).toBe('cloudPro1m')
    expect(result.capability.granularity).toBe('1m')
  })

  it('falls back pro users to sina 5m when approximate fallback is allowed', async () => {
    mockSinaFetch()
    const stub = createMinuteCacheDbStub()
    const result = await fetchMinuteBarsForUserTier({
      db: stub.db,
      tsCode: '300308.SZ',
      tradeDate: '20260525',
      userTier: 'pro',
      purpose: 'conditionBlocks',
      preferredGranularity: '1m',
      allowApproximate: true,
    })

    expect(result.status).toBe('success')
    expect(result.capability.providerId).toBe('sinaHistory5m')
    expect(result.qualityNote).toContain('5分钟')
  })

  it('persists sina 5m bars and reuses cached bars without another network request', async () => {
    mockSinaFetch()
    const stub = createMinuteCacheDbStub()

    const first = await sinaHistory5mProvider.fetchBars({
      db: stub.db,
      tsCode: '300308.SZ',
      tradeDate: '20260525',
    })
    const second = await sinaHistory5mProvider.fetchBars({
      db: stub.db,
      tsCode: '300308.SZ',
      tradeDate: '20260525',
    })

    expect(first.status).toBe('success')
    expect(second.status).toBe('success')
    expect(second.message).toContain('缓存')
    expect(stub.rows).toHaveLength(2)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })
})
