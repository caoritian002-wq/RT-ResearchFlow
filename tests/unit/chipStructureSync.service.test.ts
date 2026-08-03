import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchCyqChips: vi.fn(),
  fetchCyqPerf: vi.fn(),
  fetchDailyForCandidates: vi.fn(),
  getCyqPerf: vi.fn(),
  getChipInstitutionEvidence: vi.fn(),
  getChipStructureSummaries: vi.fn(),
  listChipTradeDates: vi.fn(),
  listCyqPerfHistory: vi.fn(),
  queryChips: vi.fn(),
  syncChipInstitutionEvidenceTradeDate: vi.fn(),
}))

vi.mock('../../electron/main/database/chipMonitorRepository', () => ({
  getMonitorStocks: vi.fn(() => []),
}))

vi.mock('../../electron/main/database/cyqPerfCacheRepository', () => ({
  getCyqPerf: mocks.getCyqPerf,
  listCyqPerfHistory: mocks.listCyqPerfHistory,
  upsertCyqPerf: vi.fn(),
}))

vi.mock('../../electron/main/database/cyqChipsCacheRepository', () => ({
  listChipTradeDates: mocks.listChipTradeDates,
  queryChips: mocks.queryChips,
  upsertChips: vi.fn(),
}))

vi.mock('../../electron/main/database/dailyCloseCacheRepository', () => ({
  upsertDailyClose: vi.fn(),
}))

vi.mock('../../electron/main/services/tushareService', () => ({
  fetchCyqChips: mocks.fetchCyqChips,
  fetchCyqPerf: mocks.fetchCyqPerf,
  fetchDailyForCandidates: mocks.fetchDailyForCandidates,
}))

vi.mock('../../electron/main/services/chipStructureService', () => ({
  getChipStructureSummaries: mocks.getChipStructureSummaries,
  normalizeChipStructureTsCode: (value: string) => value,
}))

vi.mock('../../electron/main/services/chipInstitutionEvidenceService', () => ({
  getChipInstitutionEvidence: mocks.getChipInstitutionEvidence,
  syncChipInstitutionEvidenceTradeDate: mocks.syncChipInstitutionEvidenceTradeDate,
}))

import { fetchCyqChipsSingleflight } from '../../electron/main/services/cyqChipsFetchService'
import {
  resolveInstitutionTradeDates,
  runChipStructureSync,
  startChipStructureSync,
} from '../../electron/main/services/chipStructureSyncService'

function createPerfHistory(tsCode: string): Array<{ tsCode: string; tradeDate: string }> {
  return Array.from({ length: 13 }, (_, index) => ({
    tsCode,
    tradeDate: `202606${String(20 + index).padStart(2, '0')}`,
  }))
}

describe('chipStructureSyncService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchCyqChips.mockResolvedValue([])
    mocks.fetchCyqPerf.mockResolvedValue([])
    mocks.fetchDailyForCandidates.mockResolvedValue([])
    mocks.getCyqPerf.mockReturnValue(null)
    mocks.listChipTradeDates.mockImplementation((_db, tsCode: string) => (
      createPerfHistory(tsCode).map((row) => row.tradeDate)
    ))
    mocks.listCyqPerfHistory.mockImplementation((_db, tsCode: string) => createPerfHistory(tsCode))
    mocks.queryChips.mockReturnValue([{ price: 10, percent: 1 }])
    mocks.getChipStructureSummaries.mockImplementation((
      _db,
      requests: Array<{ tsCode: string }>,
    ) => (
      requests.map(({ tsCode }) => ({ tsCode, tradeDate: '20260710' }))
    ))
    mocks.syncChipInstitutionEvidenceTradeDate.mockResolvedValue({
      tradeDate: '20260710',
      status: 'success',
      rowCount: 1,
      errorCode: null,
      skipped: false,
    })
    mocks.getChipInstitutionEvidence.mockImplementation((_db, tsCode: string) => ({
      coverageStatus: tsCode === '600000.SH' ? 'available' : 'no_record',
    }))
  })

  it('all 模式先同步结构后同步机构，同一交易日只请求一次且 no_record 不视为失败', async () => {
    const events: Array<{ channel: string; payload: Record<string, unknown> }> = []
    let resolveDone: (() => void) | null = null
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    const webContents = {
      send(channel: string, payload: Record<string, unknown>) {
        events.push({ channel, payload })
        if (channel === 'chipStructure:done') resolveDone?.()
      },
    }

    const started = startChipStructureSync({} as never, 'token', {
      tsCodes: ['600000.SH', '000001.SZ'],
      scope: 'all',
      webContents: webContents as never,
    })

    expect(started.total).toBe(4)
    await done

    expect(mocks.syncChipInstitutionEvidenceTradeDate).toHaveBeenCalledTimes(1)
    expect(mocks.syncChipInstitutionEvidenceTradeDate).toHaveBeenCalledWith(
      expect.anything(),
      'token',
      '20260710',
      false,
    )

    const progress = events
      .filter((event) => event.channel === 'chipStructure:progress')
      .map((event) => event.payload)
    expect(progress.map((payload) => payload.stage)).toEqual([
      'structure',
      'structure',
      'institution',
      'institution',
    ])

    const completed = events.find((event) => event.channel === 'chipStructure:done')?.payload
    expect(completed).toMatchObject({
      scope: 'all',
      state: 'completed',
      success: 3,
      noRecord: 1,
      partial: 0,
      failed: 0,
    })
    expect(mocks.getChipStructureSummaries).toHaveBeenCalledTimes(1)
  })

  it('批量解析机构日期，并用单次日线查询补足无筹码事实股票', () => {
    mocks.getChipStructureSummaries.mockReturnValue([
      { tsCode: '600000.SH', tradeDate: '20260710' },
      { tsCode: '000001.SZ', tradeDate: null },
    ])
    const all = vi.fn().mockReturnValue([
      { ts_code: '000001', trade_date: '20260709' },
      { ts_code: '000001.SZ', trade_date: '20260708' },
    ])
    const db = { prepare: () => ({ all }) }

    const dates = resolveInstitutionTradeDates(
      db as never,
      ['600000.SH', '000001.SZ'],
    )

    expect(mocks.getChipStructureSummaries).toHaveBeenCalledTimes(1)
    expect(all).toHaveBeenCalledTimes(1)
    expect(dates).toEqual(new Map([
      ['600000.SH', '20260710'],
      ['000001.SZ', '20260709'],
    ]))
  })

  it('structure 模式只同步双源结构，不进入机构阶段', async () => {
    let resolveDone: (() => void) | null = null
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    const webContents = {
      send(channel: string) {
        if (channel === 'chipStructure:done') resolveDone?.()
      },
    }

    const started = startChipStructureSync({} as never, 'token', {
      tsCodes: ['600000.SH'],
      scope: 'structure',
      force: true,
      webContents: webContents as never,
    })

    expect(started.total).toBe(1)
    await done
    expect(mocks.fetchCyqPerf).toHaveBeenCalled()
    expect(mocks.fetchCyqChips).toHaveBeenCalled()
    expect(mocks.syncChipInstitutionEvidenceTradeDate).not.toHaveBeenCalled()
  })

  it('统一盘后协调器可以等待结构任务收敛并读取最终状态', async () => {
    mocks.fetchCyqPerf.mockResolvedValue([{
      tsCode: '600000.SH',
      tradeDate: '20260710',
      hisLow: 8,
      hisHigh: 12,
      cost5Pct: 8.5,
      cost15Pct: 9,
      cost50Pct: 10,
      cost85Pct: 11,
      cost95Pct: 11.5,
      weightAvg: 10,
      winnerRate: 55,
    }])
    mocks.fetchCyqChips.mockResolvedValue([{
      tsCode: '600000.SH',
      tradeDate: '20260710',
      price: 10,
      percent: 100,
    }])

    const status = await runChipStructureSync({} as never, 'token', {
      tsCodes: ['600000.SH'],
      tradeDate: '20260710',
      scope: 'structure',
    })

    expect(status).toMatchObject({
      state: 'completed',
      done: 1,
      total: 1,
      success: 1,
      completedAt: expect.any(Number),
    })
  })

  it('cyq_perf 刷新失败时仍独立拉取 cyq_chips，并将股票标记为 partial', async () => {
    mocks.listCyqPerfHistory.mockReturnValue([])
    mocks.listChipTradeDates.mockReturnValue([])
    mocks.fetchCyqPerf.mockRejectedValue(new Error('perf failed'))
    mocks.fetchCyqChips.mockResolvedValue([
      { tsCode: '600000.SH', tradeDate: '20260710', price: 10, percent: 100 },
    ])
    const events: Array<{ channel: string; payload: Record<string, unknown> }> = []
    const done = new Promise<void>((resolve) => {
      const webContents = {
        send(channel: string, payload: Record<string, unknown>) {
          events.push({ channel, payload })
          if (channel === 'chipStructure:done') resolve()
        },
      }
      startChipStructureSync({} as never, 'token', {
        tsCodes: ['600000.SH'],
        scope: 'structure',
        webContents: webContents as never,
      })
    })

    await done

    expect(mocks.fetchCyqChips).toHaveBeenCalledWith('token', '600000.SH', undefined)
    expect(events.find((event) => event.channel === 'chipStructure:done')?.payload).toMatchObject({
      state: 'partial',
      success: 0,
      partial: 1,
      failed: 0,
    })
  })

  it('强刷双源失败时不使用旧缓存伪报成功', async () => {
    mocks.fetchCyqPerf.mockRejectedValue(new Error('perf failed'))
    mocks.fetchCyqChips.mockRejectedValue(new Error('chips failed'))
    const events: Array<{ channel: string; payload: Record<string, unknown> }> = []
    const done = new Promise<void>((resolve) => {
      const webContents = {
        send(channel: string, payload: Record<string, unknown>) {
          events.push({ channel, payload })
          if (channel === 'chipStructure:done') resolve()
        },
      }
      startChipStructureSync({} as never, 'token', {
        tsCodes: ['600000.SH'],
        scope: 'structure',
        force: true,
        webContents: webContents as never,
      })
    })

    await done

    expect(events.find((event) => event.channel === 'chipStructure:done')?.payload).toMatchObject({
      state: 'failed',
      success: 0,
      partial: 0,
      failed: 1,
    })
  })

  it('合并相同股票日期的并发 cyq_chips 请求', async () => {
    let release: ((rows: unknown[]) => void) | null = null
    mocks.fetchCyqChips.mockImplementation(() => new Promise((resolve) => {
      release = resolve
    }))

    const first = fetchCyqChipsSingleflight('token', '600000.SH', '20260710')
    const second = fetchCyqChipsSingleflight('token', '600000.SH', '20260710')
    release?.([])
    await Promise.all([first, second])

    expect(mocks.fetchCyqChips).toHaveBeenCalledTimes(1)
  })
})
