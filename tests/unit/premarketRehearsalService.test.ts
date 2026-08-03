import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import { getPremarketScenarioVersion } from '../../electron/main/database/premarketScenarioVersionRepository'
import { upsertStkAuctionCache } from '../../electron/main/database/stkAuctionCacheRepository'
import {
  readCurrentPremarketScenario,
  reconcilePremarketScenariosForToday,
  runPremarketScenarioStage,
} from '../../electron/main/services/premarketRehearsalService'

describe('premarketRehearsalService', () => {
  let db: Database.Database
  const tradeDate = '20260731'
  const initialAt = Date.parse('2026-07-31T08:45:10+08:00')
  const auctionAt = Date.parse('2026-07-31T09:28:10+08:00')

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, DATABASE_MIGRATIONS)
    db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 1, ?)')
      .run(tradeDate, '20260730')
    db.prepare('INSERT INTO portfolio_stocks (ts_code, stock_name, added_at) VALUES (?, ?, ?)')
      .run('600487.SH', '亨通光电', initialAt - 1)
  })

  afterEach(() => db?.close())

  it('同阶段并发单飞并由09:28确认版引用而不改写08:45初版', async () => {
    const [first, concurrent] = await Promise.all([
      runPremarketScenarioStage(db, { tradeDate, stage: 'asia_open', now: initialAt }),
      runPremarketScenarioStage(db, { tradeDate, stage: 'asia_open', now: initialAt + 1 }),
    ])
    expect(concurrent.version.id).toBe(first.version.id)
    expect(db.prepare("SELECT COUNT(*) AS count FROM premarket_scenario_versions WHERE stage = 'asia_open'").get())
      .toEqual({ count: 1 })

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
      fetchedAt: auctionAt,
    }])
    const confirmed = await runPremarketScenarioStage(db, {
      tradeDate,
      stage: 'auction_confirmed',
      now: auctionAt,
    })
    const initialAfter = getPremarketScenarioVersion(db, tradeDate, 'asia_open')

    expect(confirmed.version.parentVersionId).toBe(first.version.id)
    expect(confirmed.version.evidence.auctionMatchedCount).toBe(1)
    expect(initialAfter?.id).toBe(first.version.id)
    expect(initialAfter?.evidence.auctionMatchedCount).toBe(0)
    const view = readCurrentPremarketScenario(db, auctionAt + 1)
    expect(view.ok && view.version.stage).toBe('auction_confirmed')
    expect(view.ok && 'evidenceSha256' in view.version).toBe(false)
  })

  it('启动收敛在09:27不生成确认版并于09:28生成', async () => {
    const beforeCutoff = Date.parse('2026-07-31T09:27:59+08:00')
    const atCutoff = Date.parse('2026-07-31T09:28:00+08:00')

    await expect(runPremarketScenarioStage(db, {
      tradeDate,
      stage: 'auction_confirmed',
      now: beforeCutoff,
    })).rejects.toThrow('PREMARKET_SCENARIO_BEFORE_CUTOFF')

    const before = await reconcilePremarketScenariosForToday(db, beforeCutoff)
    expect(before.map((item) => item.version.stage)).toEqual(['asia_open'])
    expect(getPremarketScenarioVersion(db, tradeDate, 'auction_confirmed')).toBeNull()

    const after = await reconcilePremarketScenariosForToday(db, atCutoff)
    expect(after.map((item) => item.version.stage)).toEqual(['asia_open', 'auction_confirmed'])
    expect(getPremarketScenarioVersion(db, tradeDate, 'auction_confirmed')?.cutoffAt).toBe(atCutoff)
  })

  it('截点前只读返回无版本且不产生数据库写入', () => {
    const response = readCurrentPremarketScenario(
      db,
      Date.parse('2026-07-31T08:30:00+08:00'),
    )
    expect(response).toEqual({
      ok: false,
      code: 'SCENARIO_NOT_AVAILABLE',
      message: '本地尚未生成可回看的盘前推演版本',
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM premarket_scenario_versions').get())
      .toEqual({ count: 0 })
  })

  it('休市日回看最近交易日冻结版本且不产生数据库写入', async () => {
    await runPremarketScenarioStage(db, {
      tradeDate,
      stage: 'auction_confirmed',
      now: auctionAt,
    })
    const confirmed = await runPremarketScenarioStage(db, {
      tradeDate,
      stage: 'auction_confirmed',
      now: auctionAt,
      requestedAt: auctionAt,
      revisionKind: 'manual_backfill',
      appendRevision: true,
    })
    db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 0, ?)')
      .run('20260801', tradeDate)
    const before = db.totalChanges
    const response = readCurrentPremarketScenario(
      db,
      Date.parse('2026-08-01T12:00:00+08:00'),
    )

    expect(response.ok && response.version.id).toBe(confirmed.version.id)
    expect(response.ok && response.version.revision).toBe(2)
    expect(response.ok && response.displayContext).toEqual({
      requestedTradeDate: '20260801',
      displayTradeDate: tradeDate,
      isFallback: true,
      requestedTradingDay: false,
      fallbackReason: 'non_trading_day',
    })
    expect(db.totalChanges).toBe(before)
  })

  it('交易日当前版本尚未形成时回看最近版本并明确原因', async () => {
    await runPremarketScenarioStage(db, { tradeDate, stage: 'asia_open', now: initialAt })
    db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 1, ?)')
      .run('20260803', tradeDate)
    const response = readCurrentPremarketScenario(
      db,
      Date.parse('2026-08-03T08:30:00+08:00'),
    )

    expect(response.ok && response.version.tradeDate).toBe(tradeDate)
    expect(response.ok && response.displayContext.fallbackReason).toBe('current_version_unavailable')
    expect(response.ok && response.displayContext.requestedTradingDay).toBe(true)
  })
})
