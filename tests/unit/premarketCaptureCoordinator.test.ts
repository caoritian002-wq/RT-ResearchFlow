import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import {
  getPremarketNetworkEnabled,
  setPremarketNetworkEnabled,
} from '../../electron/main/database/settingsRepository'
import { upsertTradeCal } from '../../electron/main/database/tradeCalRepository'
import {
  buildPremarketCaptureStatus,
  captureCurrentPremarketStage,
  getNextPremarketCaptureRun,
  reconcilePremarketCaptureForToday,
} from '../../electron/main/services/premarketCaptureCoordinator'
import type { PremarketFetch } from '../../electron/main/services/premarketGlobalFactProvider'

function emptySuccessFetcher(): PremarketFetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { diff: [] } }),
  }))
}

describe('premarketCaptureCoordinator', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db, DATABASE_MIGRATIONS.filter((migration) => (
      [1, 59, 125, 126, 132].includes(migration.version)
    )))
    upsertTradeCal(db, [
      { calDate: '20260731', isOpen: 1, pretradeDate: '20260730' },
      { calDate: '20260803', isOpen: 1, pretradeDate: '20260731' },
    ])
  })

  afterEach(() => db.close())

  it('Migration 126默认关闭且专用设置只接受严格布尔值', () => {
    expect(getPremarketNetworkEnabled(db)).toBe(false)
    expect(setPremarketNetworkEnabled(true, db)).toBe(true)
    expect(getPremarketNetworkEnabled(db)).toBe(true)
    expect(() => setPremarketNetworkEnabled(1, db)).toThrow('PREMARKET_ENABLED_INVALID')
  })

  it('关闭或休市时不请求网络也不创建快照', async () => {
    const fetcher = emptySuccessFetcher()
    const disabled = await reconcilePremarketCaptureForToday(
      db,
      false,
      Date.parse('2026-07-31T08:46:00+08:00'),
      fetcher,
    )
    const closedDay = await reconcilePremarketCaptureForToday(
      db,
      true,
      Date.parse('2026-08-01T08:46:00+08:00'),
      fetcher,
    )

    expect(disabled).toEqual([])
    expect(closedDay).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
    expect((db.prepare('SELECT COUNT(*) AS count FROM premarket_fact_snapshots').get() as { count: number }).count).toBe(0)
  })

  it('启动过晚为两个阶段保存阻断快照且不联网补造', async () => {
    const fetcher = emptySuccessFetcher()
    const results = await reconcilePremarketCaptureForToday(
      db,
      true,
      Date.parse('2026-07-31T08:51:00+08:00'),
      fetcher,
    )

    expect(results).toHaveLength(2)
    expect(results.every((item) => item.snapshot.status === 'blocked')).toBe(true)
    expect(results.every((item) => item.snapshot.warnings.includes('PREMARKET_CAPTURE_WINDOW_MISSED'))).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('当前窗口显式补采与调度共享单飞并固定首个快照', async () => {
    const fetcher = emptySuccessFetcher()
    const now = Date.parse('2026-07-31T07:31:00+08:00')
    const [first, second] = await Promise.all([
      captureCurrentPremarketStage(db, true, now, fetcher),
      captureCurrentPremarketStage(db, true, now, fetcher),
    ])

    expect(first).toEqual({ ok: false, code: 'PREMARKET_CAPTURE_BLOCKED', reused: false })
    expect(second).toEqual({ ok: false, code: 'PREMARKET_CAPTURE_BLOCKED', reused: false })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect((db.prepare('SELECT COUNT(*) AS count FROM premarket_fact_snapshots').get() as { count: number }).count).toBe(1)

    const repeated = await captureCurrentPremarketStage(db, true, now + 30_000, fetcher)
    expect(repeated).toEqual({ ok: false, code: 'PREMARKET_CAPTURE_BLOCKED', reused: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('网络失败固定failed快照并向动作与状态返回同一失败语义', async () => {
    const fetcher = vi.fn(async () => { throw new Error('offline') }) as PremarketFetch
    const now = Date.parse('2026-07-31T08:46:00+08:00')
    const result = await captureCurrentPremarketStage(db, true, now, fetcher)
    const status = buildPremarketCaptureStatus(db, true, true, now + 30_000)
    const asia = status.stages.find((stage) => stage.stage === 'asia_open')

    expect(result).toEqual({ ok: false, code: 'PREMARKET_CAPTURE_FAILED', reused: false })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(asia?.latest).toMatchObject({
      status: 'failed',
      sourceStatus: 'failed',
      errorCode: 'NETWORK_ERROR',
      observationCount: 0,
    })
  })

  it('窗口外显式补采稳定阻断，状态只投影健康与下一时刻', async () => {
    const fetcher = emptySuccessFetcher()
    const beforeWindow = Date.parse('2026-07-31T07:00:00+08:00')
    const result = await captureCurrentPremarketStage(db, true, beforeWindow, fetcher)
    const status = buildPremarketCaptureStatus(db, true, true, beforeWindow)
    const nextOvernight = getNextPremarketCaptureRun(db, 'overnight', beforeWindow)

    expect(result).toEqual({ ok: false, code: 'PREMARKET_NO_ACTIVE_WINDOW', reused: false })
    expect(fetcher).not.toHaveBeenCalled()
    expect(status).toMatchObject({
      enabled: true,
      schedulerActive: true,
      tradeDate: '20260731',
      tradingDay: true,
      currentWindow: null,
    })
    expect(status.stages.map((stage) => stage.latest)).toEqual([null, null])
    expect(nextOvernight).toEqual({
      tradeDate: '20260731',
      stage: 'overnight',
      scheduledAt: Date.parse('2026-07-31T07:30:00+08:00'),
    })
  })

  it('单阶段损坏不会阻断同日另一阶段启动收敛', async () => {
    const overnightCutoff = Date.parse('2026-07-31T07:30:00+08:00')
    db.prepare(`
      INSERT INTO premarket_fact_snapshots (
        id, trade_date, stage, status, schema_version, rule_version,
        cutoff_at, captured_at, provider_id, facts_json, facts_sha256,
        sources_json, warnings_json, created_at
      ) VALUES (?, ?, 'overnight', 'failed', 1, 'premarket-facts-v1', ?, ?, ?, ?, ?, '[]', '[]', ?)
    `).run(
      '00000000-0000-4000-8000-000000000099',
      '20260731',
      overnightCutoff,
      overnightCutoff,
      'eastmoney-global-public-v1',
      JSON.stringify({ schemaVersion: 1 }),
      '0'.repeat(64),
      overnightCutoff,
    )
    const fetcher = emptySuccessFetcher()
    const results = await reconcilePremarketCaptureForToday(
      db,
      true,
      Date.parse('2026-07-31T08:46:00+08:00'),
      fetcher,
    )

    expect(results).toHaveLength(1)
    expect(results[0].snapshot.stage).toBe('asia_open')
    expect(fetcher).toHaveBeenCalledTimes(1)
    const status = buildPremarketCaptureStatus(
      db,
      true,
      true,
      Date.parse('2026-07-31T08:46:30+08:00'),
    )
    expect(status.stages.find((stage) => stage.stage === 'overnight')?.readError)
      .toBe('PREMARKET_SNAPSHOT_HASH_MISMATCH')
    expect(status.stages.find((stage) => stage.stage === 'asia_open')?.latest?.warningCount)
      .toBeGreaterThan(0)
  })
})
