import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import { savePremarketFactSnapshot } from '../../electron/main/database/premarketFactSnapshotRepository'
import { upsertStkAuctionCache } from '../../electron/main/database/stkAuctionCacheRepository'
import { evaluateExternalRiskBreadth } from '../../electron/main/services/premarketExternalRiskModel'
import { buildPremarketScenarioEvidence } from '../../electron/main/services/premarketEvidenceBuilder'
import type { ExternalAssetObservation } from '../../electron/main/services/premarketScenarioTypes'

describe('premarketEvidenceBuilder', () => {
  let db: Database.Database
  const tradeDate = '20260731'
  const previousTradeDate = '20260730'
  const initialCutoff = Date.parse('2026-07-31T08:45:00+08:00')
  const auctionCutoff = Date.parse('2026-07-31T09:28:00+08:00')

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, DATABASE_MIGRATIONS)
    db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 1, ?)')
      .run(tradeDate, previousTradeDate)
    db.prepare('INSERT INTO portfolio_stocks (ts_code, stock_name, added_at) VALUES (?, ?, ?)')
      .run('600487.SH', '亨通光电', initialCutoff - 1)
    db.prepare(`
      INSERT OR REPLACE INTO stock_basic_cache
        (ts_code, name, industry, market, list_status, circ_float, updated_at)
      VALUES (?, ?, ?, '主板', 'L', NULL, ?)
    `).run('600487.SH', '亨通光电', '通信设备', initialCutoff - 1)

    const observations: ExternalAssetObservation[] = [
      ['us.dow', '道琼斯', 'us'],
      ['us.nasdaq', '纳斯达克', 'us'],
      ['asia.nikkei225', '日经225', 'asia'],
      ['asia.kospi', '韩国KOSPI', 'asia'],
    ].map(([assetId, name, region], index) => ({
      assetId,
      providerSecurityId: `provider-${index}`,
      name,
      region: region as 'us' | 'asia',
      role: 'risk_asset',
      latest: 101 + index,
      open: 100,
      previousClose: 100,
      changePercent: 1 + index * 0.1,
      observedAt: initialCutoff - 60_000,
    }))
    savePremarketFactSnapshot(db, {
      id: '00000000-0000-4000-8000-000000000001',
      tradeDate,
      stage: 'asia_open',
      status: 'ready',
      ruleVersion: 'premarket-facts-v1',
      cutoffAt: initialCutoff,
      capturedAt: initialCutoff,
      providerId: 'eastmoney-global-public-v1',
      facts: {
        schemaVersion: 1,
        tradeDate,
        stage: 'asia_open',
        cutoffAt: initialCutoff,
        observations,
        externalRisk: evaluateExternalRiskBreadth(observations),
      },
      sources: [{
        sourceId: 'eastmoney-global-history-v1',
        status: 'ready',
        attemptedAt: initialCutoff,
        completedAt: initialCutoff,
        observationCount: 4,
        expectedCount: 4,
        errorCode: null,
      }],
      warnings: [],
      createdAt: initialCutoff,
    })

    db.prepare(`
      INSERT INTO sources (
        nameCN, nameEN, url, feedUrl, category, authorityWeight,
        isBuiltIn, isEnabled, status, successRate, parseStrategy
      ) VALUES ('测试来源', 'Test Source', 'https://example.com', NULL, 'FINANCIAL_PRESS', 5, 1, 1, 'ACTIVE', 1, 'RSS')
    `).run()
    const source = db.prepare('SELECT id, nameCN FROM sources ORDER BY id LIMIT 1')
      .get() as { id: number; nameCN: string }
    const insertBriefing = db.prepare(`
      INSERT INTO briefings (
        sourceId, sourceName, originalUrl, title, summary, fullContent,
        publishedAt, publishedDateBJ, publicationTimeStatus, collectedAt,
        impactRating, impactRatingScore, deduplicationHash, titleSimhash,
        isRead, readAt, scanRunId, isCatchUp
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'exact', ?, 'IMPORTANT', 50, ?, ?, 0, NULL, NULL, 0)
    `)
    insertBriefing.run(
      source.id,
      source.nameCN,
      'https://example.com/past',
      '亨通光电上一交易日线索',
      '上一交易日已经公开的本地资讯',
      Date.parse('2026-07-30T15:00:00+08:00'),
      '2026-07-30',
      Date.parse('2026-07-30T15:01:00+08:00'),
      'a'.repeat(64),
      '1'.repeat(16),
    )
    insertBriefing.run(
      source.id,
      source.nameCN,
      'https://example.com/future',
      '亨通光电当日未来线索',
      '不得进入盘前历史事实',
      Date.parse('2026-07-31T10:00:00+08:00'),
      '2026-07-31',
      Date.parse('2026-07-31T10:01:00+08:00'),
      'b'.repeat(64),
      '2'.repeat(16),
    )
    insertBriefing.run(
      source.id,
      source.nameCN,
      'https://example.com/premarket-late-collected',
      '亨通光电09:20盘前线索',
      '发布时间属于盘前，允许稍后补采',
      Date.parse('2026-07-31T09:20:00+08:00'),
      '2026-07-31',
      Date.parse('2026-07-31T09:40:00+08:00'),
      'c'.repeat(64),
      '3'.repeat(16),
    )
    const insertAnnouncement = db.prepare(`
      INSERT INTO stock_fundamental_announcements (
        ts_code, stock_code, short_name, article_code, title, notice_date,
        display_at, category_codes_json, category_names_json, source,
        source_url, fetched_at
      ) VALUES (?, '600487', '亨通光电', ?, ?, ?, ?, '[]', '[]',
        'eastmoney-announcement-index', ?, ?)
    `)
    insertAnnouncement.run(
      '600487.SH',
      'AN-PREMARKET',
      '09:20盘前公告',
      tradeDate,
      Date.parse('2026-07-31T09:20:00+08:00'),
      'https://example.com/announcement/premarket',
      Date.parse('2026-07-31T09:40:00+08:00'),
    )
    insertAnnouncement.run(
      '600487.SH',
      'AN-INTRADAY',
      '10:00盘中公告',
      tradeDate,
      Date.parse('2026-07-31T10:00:00+08:00'),
      'https://example.com/announcement/intraday',
      Date.parse('2026-07-31T10:01:00+08:00'),
    )
    db.prepare(`
      INSERT OR REPLACE INTO stock_fundamental_sync_state (
        ts_code, dataset, status, last_attempt_at, last_success_at,
        fact_date, last_error_code, rows_written
      ) VALUES (?, 'announcement', 'available', ?, ?, ?, NULL, 2)
    `).run('600487.SH', auctionCutoff, auctionCutoff, tradeDate)
    upsertStkAuctionCache(db, [{
      tsCode: '600487.SH',
      tradeDate,
      price: 17,
      vol: 1_000_000,
      amount: 17_000_000,
      preClose: 16.5,
      turnoverRate: 0.6,
      volumeRatio: 1.2,
      floatShare: null,
      fetchedAt: auctionCutoff + 30_000,
    }])
  })

  afterEach(() => db?.close())

  it('按09:30事实边界纳入可还原的竞价、资讯和公告', () => {
    const evidence = buildPremarketScenarioEvidence(db, {
      tradeDate,
      stage: 'auction_confirmed',
      generatedAt: auctionCutoff + 60_000,
    })

    expect(evidence.previousTradeDate).toBe(previousTradeDate)
    expect(evidence.market.externalRiskTone).toBe('broad_risk_on')
    expect(evidence.market.observations).toHaveLength(4)
    expect(evidence.market).toMatchObject({
      snapshotRevision: 1,
      snapshotRevisionKind: 'scheduled',
      snapshotCapturedAt: initialCutoff,
      providerId: 'eastmoney-global-public-v1',
      sourceStates: [expect.objectContaining({
        sourceId: 'eastmoney-global-history-v1',
        status: 'ready',
        observationCount: 4,
      })],
    })
    expect(evidence.holdings).toHaveLength(1)
    expect(evidence.holdings[0].industry).toBe('通信设备')
    expect(evidence.holdings[0].auction?.gapPercent).toBeCloseTo(3.03, 1)
    expect(evidence.auctionMatchedCount).toBe(1)
    expect(evidence.cutoffAt).toBe(Date.parse('2026-07-31T09:30:00+08:00'))
    expect(evidence.holdings[0].briefings.map((item) => item.title)).toEqual([
      '亨通光电09:20盘前线索',
      '亨通光电上一交易日线索',
    ])
    expect(evidence.holdings[0].announcements.map((item) => item.title)).toEqual(['09:20盘前公告'])
    expect(JSON.stringify(evidence)).not.toContain('10:00盘中公告')
    expect(JSON.stringify(evidence)).not.toContain('亨通光电当日未来线索')
    expect(JSON.stringify(evidence)).not.toContain('provider-0')
    expect(evidence.portfolioSnapshotKind).toBe('current-only')
  })

  it('09:40补采的交易日竞价仍按09:25定稿事实纳入且披露采集时间', () => {
    upsertStkAuctionCache(db, [{
      tsCode: '600487.SH',
      tradeDate,
      price: 17,
      vol: 1_000_000,
      amount: 17_000_000,
      preClose: 16.5,
      turnoverRate: 0.6,
      volumeRatio: 1.2,
      floatShare: null,
      fetchedAt: Date.parse('2026-07-31T09:30:01+08:00'),
    }])

    const evidence = buildPremarketScenarioEvidence(db, {
      tradeDate,
      stage: 'auction_confirmed',
      generatedAt: Date.parse('2026-07-31T09:30:02+08:00'),
    })

    expect(evidence.holdings[0].auction?.fetchedAt).toBe(Date.parse('2026-07-31T09:30:01+08:00'))
    expect(evidence.holdings[0].auction?.factAt).toBe(Date.parse('2026-07-31T09:25:00+08:00'))
    expect(evidence.auctionMatchedCount).toBe(1)
  })
})
