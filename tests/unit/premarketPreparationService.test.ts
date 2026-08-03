import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import { PREMARKET_EXTERNAL_ASSETS, type PremarketFetch } from '../../electron/main/services/premarketGlobalFactProvider'
import {
  readPremarketPreparation,
  refreshPremarketPreparation,
  resolvePremarketPreparationTargetTradeDate,
} from '../../electron/main/services/premarketPreparationService'

const NOW = Date.parse('2026-08-01T12:00:00+08:00')

function successFetcher(): PremarketFetch {
  const observedAt = Math.floor((NOW - 60_000) / 1000)
  const rows = PREMARKET_EXTERNAL_ASSETS
    .filter((item) => item.stages.includes('asia_open'))
    .map((item, index) => {
      const [market, code] = item.securityId.split('.')
      return {
        f2: 100 + index,
        f3: index % 2 === 0 ? 1.2 : -0.5,
        f12: code,
        f13: Number(market),
        f14: item.fallbackName,
        f17: 99,
        f18: 100,
        f124: observedAt,
      }
    })
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { diff: rows } }),
  }))
}

describe('premarketPreparationService', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, DATABASE_MIGRATIONS)
    db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 0, ?)')
      .run('20260801', '20260731')
    db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 1, ?)')
      .run('20260803', '20260731')
  })

  afterEach(() => db?.close())

  it('休市日把准备资料绑定下一交易日并以不可变修订追加', async () => {
    db.prepare('UPDATE app_settings SET premarket_network_enabled = 1 WHERE id = 1').run()
    expect(resolvePremarketPreparationTargetTradeDate(db, NOW)).toBe('20260803')
    const scanBriefings = vi.fn(async () => ({ runId: 7, newBriefingsFound: 0 }))
    const [first, concurrent] = await Promise.all([
      refreshPremarketPreparation(db, { now: NOW, fetcher: successFetcher(), scanBriefings }),
      refreshPremarketPreparation(db, { now: NOW, fetcher: successFetcher(), scanBriefings }),
    ])
    expect(first.ok).toBe(true)
    expect(concurrent.ok && first.ok && concurrent.preparation.id).toBe(first.ok ? first.preparation.id : '')
    expect(scanBriefings).toHaveBeenCalledTimes(1)
    expect(db.prepare('SELECT COUNT(*) AS count FROM premarket_preparation_snapshots').get()).toEqual({ count: 1 })

    const second = await refreshPremarketPreparation(db, {
      now: NOW + 60_000,
      fetcher: successFetcher(),
      scanBriefings,
    })
    expect(second.ok).toBe(true)
    expect(db.prepare('SELECT COUNT(*) AS count FROM premarket_preparation_snapshots').get()).toEqual({ count: 2 })
    const read = readPremarketPreparation(db, NOW + 60_000)
    expect(read.preparation?.id).toBe(second.ok ? second.preparation.id : '')
    expect(read.preparation && 'externalSha256' in read.preparation).toBe(false)
    expect(() => db.prepare("UPDATE premarket_preparation_snapshots SET status = 'failed'").run())
      .toThrow('PREMARKET_PREPARATION_SNAPSHOT_IMMUTABLE')
    db.exec('DROP TRIGGER premarket_preparation_snapshots_no_update')
    db.prepare("UPDATE premarket_preparation_snapshots SET external_sha256 = ? WHERE id = ?")
      .run('0'.repeat(64), second.ok ? second.preparation.id : '')
    expect(() => readPremarketPreparation(db, NOW + 60_000))
      .toThrow('PREMARKET_PREPARATION_EXTERNAL_HASH_MISMATCH')
  })

  it('联网开关关闭时稳定拒绝且不写入准备快照', async () => {
    const result = await refreshPremarketPreparation(db, {
      now: NOW,
      fetcher: successFetcher(),
      scanBriefings: vi.fn(async () => ({ runId: 1, newBriefingsFound: 0 })),
    })
    expect(result).toMatchObject({ ok: false, code: 'PREMARKET_NETWORK_DISABLED' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM premarket_preparation_snapshots').get()).toEqual({ count: 0 })
  })
})
