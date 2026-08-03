import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type {
  TopInstDailyRow,
  TopInstSyncCoverageRow,
} from '../../electron/main/database/types'
import {
  getTopInstByStockAndDate,
  getTopInstCoverage,
  replaceTopInstForTradeDate,
} from '../../electron/main/database/topInstDailyRepository'
import { buildChipInstitutionEvidence } from '../../electron/main/services/chipInstitutionEvidenceService'

function createRow(overrides: Partial<TopInstDailyRow> = {}): TopInstDailyRow {
  return {
    tradeDate: '20260710',
    tsCode: '600000.SH',
    exalter: '机构专用',
    side: 0,
    buy: 12_000_000,
    buyRate: 4.2,
    sell: 3_000_000,
    sellRate: 1.1,
    netBuy: 9_000_000,
    reason: '日涨幅偏离值达7%',
    fetchedAt: 1000,
    ...overrides,
  }
}

function createCoverage(
  overrides: Partial<TopInstSyncCoverageRow> = {},
): TopInstSyncCoverageRow {
  return {
    tradeDate: '20260710',
    status: 'success',
    rowCount: 0,
    errorCode: null,
    attemptedAt: 1000,
    completedAt: 1100,
    ...overrides,
  }
}

describe('chipInstitutionEvidenceService', () => {
  it('折叠同一经济记录的买卖双榜行，不重复累计金额', () => {
    const evidence = buildChipInstitutionEvidence(
      '20260710',
      [createRow({ side: 0 }), createRow({ side: 1 })],
      createCoverage({ rowCount: 2 }),
    )

    expect(evidence.coverageStatus).toBe('available')
    expect(evidence.records).toHaveLength(1)
    expect(evidence.institutionCount).toBe(1)
    expect(evidence.buyAmount).toBe(12_000_000)
    expect(evidence.sellAmount).toBe(3_000_000)
    expect(evidence.netAmount).toBe(9_000_000)
  })

  it('保留金额不同的同名席位记录并分别累计', () => {
    const evidence = buildChipInstitutionEvidence(
      '20260710',
      [createRow(), createRow({ buy: 5_000_000, sell: 1_000_000, netBuy: 4_000_000 })],
      createCoverage({ rowCount: 2 }),
    )

    expect(evidence.records).toHaveLength(2)
    expect(evidence.institutionCount).toBe(1)
    expect(evidence.buyAmount).toBe(17_000_000)
    expect(evidence.sellAmount).toBe(4_000_000)
    expect(evidence.netAmount).toBe(13_000_000)
  })

  it('成功覆盖且没有股票记录时标记 no_record', () => {
    const evidence = buildChipInstitutionEvidence('20260710', [], createCoverage())

    expect(evidence.coverageStatus).toBe('no_record')
    expect(evidence.buyAmount).toBeNull()
    expect(evidence.records).toEqual([])
    expect(evidence.updatedAt).toBe(1100)
  })

  it('无覆盖和失败覆盖分别标记 not_synced 与 failed', () => {
    expect(buildChipInstitutionEvidence('20260710', [], null).coverageStatus).toBe('not_synced')
    expect(buildChipInstitutionEvidence(
      '20260710',
      [],
      createCoverage({ status: 'failed', errorCode: 'UPSTREAM_ERROR', completedAt: null }),
    ).coverageStatus).toBe('failed')
  })
})

describe('topInstDailyRepository', () => {
  it('持久化同席位同方向同原因但金额不同的经济记录', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE top_inst_daily (
        trade_date TEXT NOT NULL,
        ts_code TEXT NOT NULL,
        institution_name TEXT NOT NULL DEFAULT '',
        side INTEGER NOT NULL CHECK (side IN (0, 1)),
        buy_amount REAL,
        buy_rate REAL,
        sell_amount REAL,
        sell_rate REAL,
        net_amount REAL,
        reason TEXT NOT NULL DEFAULT '',
        record_key TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY(trade_date, ts_code, side, record_key)
      );
      CREATE TABLE top_inst_sync_coverage (
        trade_date TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
        row_count INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        attempted_at INTEGER NOT NULL,
        completed_at INTEGER
      );
    `)

    try {
      const inserted = replaceTopInstForTradeDate(db, '20260710', [
        createRow(),
        createRow({ buy: 5_000_000, sell: 1_000_000, netBuy: 4_000_000 }),
      ], 2000)
      const rows = getTopInstByStockAndDate(db, '600000.SH', '20260710')

      expect(inserted).toBe(2)
      expect(rows).toHaveLength(2)
      expect(rows.map((row) => row.buy).sort((left, right) => (left ?? 0) - (right ?? 0)))
        .toEqual([5_000_000, 12_000_000])
      expect(getTopInstCoverage(db, '20260710')).toMatchObject({
        status: 'success',
        rowCount: 2,
      })
    } finally {
      db.close()
    }
  })
})