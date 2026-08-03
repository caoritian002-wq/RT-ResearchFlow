import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import {
  getPremarketScenarioVersion,
  listPremarketScenarioVersions,
} from '../../electron/main/database/premarketScenarioVersionRepository'
import { upsertStkAuctionCache } from '../../electron/main/database/stkAuctionCacheRepository'
import { runPremarketScenarioStage } from '../../electron/main/services/premarketRehearsalService'
import { retryPremarketScenario } from '../../electron/main/services/premarketScenarioRetryService'

describe('premarketScenarioRetryService', () => {
  let db: Database.Database
  const tradeDate = '20260731'
  const confirmAt = Date.parse('2026-07-31T09:28:00+08:00')
  const retryAt = Date.parse('2026-07-31T09:40:00+08:00')

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, DATABASE_MIGRATIONS)
    db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 1, ?)')
      .run(tradeDate, '20260730')
    db.prepare('INSERT INTO portfolio_stocks (ts_code, stock_name, added_at) VALUES (?, ?, ?)')
      .run('600487.SH', '亨通光电', confirmAt - 1)
  })

  afterEach(() => db.close())

  it('09:40补采追加R2且再次重试追加R3，不覆盖首次失败记录', async () => {
    const original = await runPremarketScenarioStage(db, {
      tradeDate,
      stage: 'auction_confirmed',
      now: confirmAt,
    })
    expect(original.version.evidence.auctionMatchedCount).toBe(0)
    const phases: string[] = []
    const refreshAuction = vi.fn(async () => {
      upsertStkAuctionCache(db, [{
        tsCode: '600487.SH',
        tradeDate,
        price: 17,
        vol: 1_000,
        amount: 17_000,
        preClose: 16.5,
        turnoverRate: 0.1,
        volumeRatio: 1,
        floatShare: null,
        fetchedAt: retryAt,
      }])
      return { status: 'completed' as const, itemCount: 1, errorCode: null }
    })
    const options = {
      now: retryAt,
      refreshExternal: vi.fn(async () => ({
        status: 'completed' as const,
        itemCount: 5,
        errorCode: null,
      })),
      refreshAuction,
      scanBriefings: vi.fn(async () => ({ runId: 1, newBriefingsFound: 0 })),
      refreshAnnouncement: vi.fn(async () => ({ ok: true as const, rowsWritten: 0 })),
      onProgress: (item: { phase: string }) => phases.push(item.phase),
    }

    const firstRetry = await retryPremarketScenario(db, options)
    const secondRetry = await retryPremarketScenario(db, options)

    expect(firstRetry.ok && firstRetry.revision.revision).toBe(2)
    expect(secondRetry.ok && secondRetry.revision.revision).toBe(3)
    const revisions = listPremarketScenarioVersions(db, tradeDate, 'auction_confirmed')
    expect(revisions.map((item) => item.revision)).toEqual([3, 2, 1])
    expect(revisions[2]?.id).toBe(original.version.id)
    expect(revisions[1]?.previousRevisionId).toBe(original.version.id)
    expect(revisions[0]?.previousRevisionId).toBe(revisions[1]?.id)
    expect(revisions[0]?.factCutoffAt).toBe(Date.parse('2026-07-31T09:30:00+08:00'))
    expect(revisions[0]?.requestedAt).toBe(retryAt)
    expect(revisions[0]?.evidence.auctionMatchedCount).toBe(1)
    expect(getPremarketScenarioVersion(db, tradeDate, 'auction_confirmed')?.revision).toBe(3)
    expect(phases).toEqual(expect.arrayContaining([
      'starting', 'external', 'auction', 'briefings', 'announcements', 'generating', 'completed',
    ]))
  })

  it('09:28以前拒绝补采且不写入版本', async () => {
    const response = await retryPremarketScenario(db, {
      now: Date.parse('2026-07-31T09:27:59+08:00'),
      refreshExternal: vi.fn(),
      refreshAuction: vi.fn(),
      scanBriefings: vi.fn(),
      refreshAnnouncement: vi.fn(),
    })

    expect(response).toEqual({
      ok: false,
      code: 'PREMARKET_RETRY_BEFORE_CONFIRMATION',
      message: '09:28竞价确认后才能重新补采盘前推演',
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM premarket_scenario_versions').get())
      .toEqual({ count: 0 })
  })

  it('来源空结果或失败仍追加带稳定诊断的不可变修订', async () => {
    const response = await retryPremarketScenario(db, {
      now: retryAt,
      refreshExternal: vi.fn(async () => ({
        status: 'failed' as const,
        itemCount: 0,
        errorCode: 'EXTERNAL_RECOVERY_INSUFFICIENT',
      })),
      refreshAuction: vi.fn(async () => ({
        status: 'completed' as const,
        itemCount: 0,
        errorCode: 'AUCTION_HISTORY_EMPTY',
      })),
      scanBriefings: vi.fn(async () => { throw new Error('network unavailable') }),
      refreshAnnouncement: vi.fn(async () => ({
        ok: false as const,
        code: 'ANNOUNCEMENT_UPSTREAM_ERROR' as const,
        message: 'network unavailable',
      })),
    })

    expect(response.ok).toBe(true)
    const version = getPremarketScenarioVersion(db, tradeDate, 'auction_confirmed')
    expect(version?.revisionKind).toBe('manual_backfill')
    expect(version?.warnings).toEqual(expect.arrayContaining([
      'MANUAL_BACKFILL_EXTERNAL_EXTERNAL_RECOVERY_INSUFFICIENT',
      'MANUAL_BACKFILL_AUCTION_AUCTION_HISTORY_EMPTY',
      'MANUAL_BACKFILL_BRIEFINGS_BRIEFING_SCAN_FAILED',
      'MANUAL_BACKFILL_ANNOUNCEMENTS_ANNOUNCEMENT_BACKFILL_PARTIAL',
    ]))
  })
})
