import { describe, expect, it, vi } from 'vitest'
import {
  MorningAuctionPriceHistoryCoordinator,
  calculateMorningAuctionPriceHistoryEntry,
  loadMorningAuctionPriceHistoryEntries,
  type MorningAuctionPriceCloseRow,
  type MorningAuctionPriceHistoryEntry,
} from '../../electron/main/services/morningAuctionPriceHistoryCoordinator'

function rows(tsCode: string, count: number, endDate = '20260811'): MorningAuctionPriceCloseRow[] {
  const end = new Date(Date.UTC(
    Number(endDate.slice(0, 4)),
    Number(endDate.slice(4, 6)) - 1,
    Number(endDate.slice(6, 8)),
  ))
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(end)
    date.setUTCDate(date.getUTCDate() - (count - index - 1))
    return {
      tsCode,
      tradeDate: date.toISOString().slice(0, 10).replace(/-/g, ''),
      close: 10 + index,
    }
  })
}

function ready(value: number): MorningAuctionPriceHistoryEntry {
  return {
    p3d: value,
    p5d: value,
    state: 'ready',
    availableDays: 6,
    reason: 'LOCAL_READY',
    remoteAttempted: false,
  }
}

describe('早盘历史涨跌增量协调器', () => {
  it('同交易日候选集合扩张后只补新增股票', async () => {
    const batches: string[][] = []
    const coordinator = new MorningAuctionPriceHistoryCoordinator(async (_tradeDate, codes) => {
      batches.push(codes)
      return new Map(codes.map((code, index) => [code, ready(index + batches.length)]))
    })

    await coordinator.ensure('20260812', ['000001.SZ'])
    const expanded = await coordinator.ensure('20260812', ['000001.SZ', '000002.SZ'])

    expect(batches).toEqual([['000001.SZ'], ['000002.SZ']])
    expect([...expanded.keys()]).toEqual(['000001.SZ', '000002.SZ'])
    expect(coordinator.getCoverage('20260812', [...expanded.keys()])).toMatchObject({
      requestedCount: 2,
      covered3dCount: 2,
      covered5dCount: 2,
    })
  })

  it('早期快照与完整快照并发时在同一 singleflight 中继续收敛新增候选', async () => {
    let releaseFirst: (() => void) | null = null
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const batches: string[][] = []
    const coordinator = new MorningAuctionPriceHistoryCoordinator(async (_tradeDate, codes) => {
      batches.push(codes)
      if (batches.length === 1) await firstGate
      return new Map(codes.map(code => [code, ready(1)]))
    })

    const early = coordinator.ensure('20260812', ['000001.SZ'])
    await vi.waitFor(() => expect(batches).toHaveLength(1))
    const complete = coordinator.ensure('20260812', ['000001.SZ', '000002.SZ'])
    releaseFirst?.()

    await expect(early).resolves.toHaveLength(1)
    await expect(complete).resolves.toHaveLength(2)
    expect(batches).toEqual([['000001.SZ'], ['000002.SZ']])
  })

  it('不同交易日请求使用各自状态并可并行完成', async () => {
    const pending = new Map<string, () => void>()
    const starts: string[] = []
    const coordinator = new MorningAuctionPriceHistoryCoordinator(async (tradeDate, codes) => {
      starts.push(tradeDate)
      await new Promise<void>(resolve => pending.set(tradeDate, resolve))
      return new Map(codes.map(code => [code, ready(Number(tradeDate.slice(-2)))]))
    })

    const first = coordinator.ensure('20260811', ['000001.SZ'])
    const second = coordinator.ensure('20260812', ['000001.SZ'])
    await vi.waitFor(() => expect(starts).toHaveLength(2))
    pending.get('20260812')?.()
    await expect(second).resolves.toEqual(new Map([['000001.SZ', ready(12)]]))
    pending.get('20260811')?.()
    await expect(first).resolves.toEqual(new Map([['000001.SZ', ready(11)]]))
  })

  it('显式刷新只重试未完整股票', async () => {
    const batches: string[][] = []
    let attempt = 0
    const coordinator = new MorningAuctionPriceHistoryCoordinator(async (_tradeDate, codes) => {
      attempt += 1
      batches.push(codes)
      return new Map(codes.map(code => [code, code === '000001.SZ' || attempt > 1
        ? ready(attempt)
        : {
            p3d: 2,
            p5d: null,
            state: 'partial' as const,
            availableDays: 4,
            reason: 'SAMPLE_INSUFFICIENT' as const,
            remoteAttempted: false,
          }]))
    })

    await coordinator.ensure('20260812', ['000001.SZ', '000002.SZ'])
    const refreshed = await coordinator.ensure(
      '20260812',
      ['000001.SZ', '000002.SZ'],
      { retryUnresolved: true },
    )

    expect(batches).toEqual([
      ['000001.SZ', '000002.SZ'],
      ['000002.SZ'],
    ])
    expect(refreshed.get('000001.SZ')?.p5d).toBe(1)
    expect(refreshed.get('000002.SZ')?.p5d).toBe(2)
  })
})

describe('早盘历史涨跌本地优先加载', () => {
  it('六个本地有效收盘样本直接计算且不调用远端', async () => {
    const fetchRemote = vi.fn()
    const result = await loadMorningAuctionPriceHistoryEntries('20260812', ['000001.SZ'], {
      queryLocal: () => new Map([['000001.SZ', rows('000001.SZ', 6)]]),
      fetchRemote,
    })

    expect(fetchRemote).not.toHaveBeenCalled()
    expect(result.get('000001.SZ')).toMatchObject({
      state: 'ready',
      availableDays: 6,
      reason: 'LOCAL_READY',
      remoteAttempted: false,
    })
    expect(result.get('000001.SZ')?.p3d).toBeCloseTo(25)
    expect(result.get('000001.SZ')?.p5d).toBeCloseTo(50)
  })

  it('四至五个样本保留3日结果并明确5日样本不足', () => {
    expect(calculateMorningAuctionPriceHistoryEntry('000001.SZ', rows('000001.SZ', 4), '20260812')).toMatchObject({
      state: 'partial',
      availableDays: 4,
      p5d: null,
      reason: 'SAMPLE_INSUFFICIENT',
    })
    expect(calculateMorningAuctionPriceHistoryEntry('000001.SZ', rows('000001.SZ', 3), '20260812')).toMatchObject({
      state: 'insufficient',
      availableDays: 3,
      p3d: null,
      p5d: null,
    })
  })

  it('严格以目标交易日前最近收盘为终点，不倒灌目标日或未来日数据', () => {
    const historicalRows = rows('000001.SZ', 6)
    const result = calculateMorningAuctionPriceHistoryEntry('000001.SZ', [
      ...historicalRows,
      { tsCode: '000001.SZ', tradeDate: '20260812', close: 100 },
      { tsCode: '000001.SZ', tradeDate: '20260813', close: 200 },
    ], '20260812')

    expect(result).toMatchObject({
      state: 'ready',
      availableDays: 6,
      p3d: 25,
      p5d: 50,
    })
  })

  it('单只远端失败不影响其他股票且保留已有3日结果', async () => {
    const result = await loadMorningAuctionPriceHistoryEntries(
      '20260812',
      ['000001.SZ', '000002.SZ', '000003.SZ'],
      {
        queryLocal: () => new Map([
          ['000001.SZ', rows('000001.SZ', 6)],
          ['000002.SZ', rows('000002.SZ', 4)],
        ]),
        fetchRemote: async (code) => {
          if (code === '000002.SZ') throw new Error('network')
          return rows(code, 6)
        },
      },
    )

    expect(result.get('000001.SZ')?.state).toBe('ready')
    expect(result.get('000002.SZ')).toMatchObject({
      state: 'partial',
      reason: 'REMOTE_BACKFILL_FAILED',
      remoteAttempted: true,
    })
    expect(result.get('000002.SZ')?.p3d).not.toBeNull()
    expect(result.get('000003.SZ')).toMatchObject({
      state: 'ready',
      reason: 'REMOTE_BACKFILLED',
      remoteAttempted: true,
    })
  })

  it('本地读取失败返回稳定失败状态且不尝试远端', async () => {
    const fetchRemote = vi.fn()
    const result = await loadMorningAuctionPriceHistoryEntries('20260812', ['000001.SZ'], {
      queryLocal: () => { throw new Error('sqlite') },
      fetchRemote,
    })

    expect(fetchRemote).not.toHaveBeenCalled()
    expect(result.get('000001.SZ')).toEqual({
      p3d: null,
      p5d: null,
      state: 'failed',
      availableDays: 0,
      reason: 'LOCAL_READ_FAILED',
      remoteAttempted: false,
    })
  })
})
