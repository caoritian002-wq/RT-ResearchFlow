import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../electron/main/database/dataSourceRepository', () => ({
  getDataSourceConfig: () => ({ tushareEnabled: false, tushareTokenEncrypted: null }),
}))
vi.mock('../../electron/main/database/aiConfigRepository', () => ({
  getConfiguredProviders: () => [],
}))
vi.mock('../../electron/main/database/settingsRepository', () => ({
  getConceptSource: () => 'kpl',
}))
vi.mock('../../electron/main/database/tradeCalRepository', () => ({
  getLastNTradingDays: () => [],
}))
vi.mock('../../electron/main/services/schedulerService', () => ({
  runStockBasicSyncJob: vi.fn(),
  runConceptMembersSyncJob: vi.fn(),
}))
vi.mock('../../electron/main/services/decisionSignalBackfillService', () => ({
  ensureTodayDecisionSignalsBackfilled: vi.fn(),
}))
vi.mock('../../electron/main/services/historicalDailySyncService', () => ({
  getHistoricalDailyDefaultEndDate: () => '20260719',
  HISTORICAL_DAILY_TARGET_TRADE_DAYS: 480,
  runHistoricalDailySync: vi.fn(),
}))
vi.mock('../../electron/main/utils/apiKeyEncryption', () => ({
  decryptApiKey: vi.fn(),
}))

import { getDiagnosticsHealth } from '../../electron/main/services/diagnosticsService'

const FRESHNESS_TABLES = [
  ['stock_basic_cache', 'updated_at'],
  ['daily_close_cache', 'trade_date'],
  ['stock_minute_cache', 'trade_date'],
  ['limit_list_daily', 'trade_date'],
  ['kpl_concept_members', null],
  ['ths_concept_members', null],
  ['dc_concept_members', 'trade_date'],
  ['chip_monitor_results', 'trade_date'],
  ['trend_scores', 'trade_date'],
  ['decision_signals', 'signal_time'],
] as const

function createDiagnosticsDb(): Database.Database {
  const db = new Database(':memory:')
  for (const [table, dateColumn] of FRESHNESS_TABLES) {
    if (table === 'daily_close_cache') {
      db.exec(`
        CREATE TABLE daily_close_cache (
          ts_code TEXT NOT NULL,
          trade_date TEXT NOT NULL,
          open REAL,
          high REAL,
          low REAL,
          close REAL,
          pct_chg REAL,
          vol REAL,
          turnover_rate REAL,
          PRIMARY KEY (ts_code, trade_date)
        )
      `)
    } else {
      db.exec(`CREATE TABLE ${table} (id INTEGER${dateColumn ? `, ${dateColumn} TEXT` : ''})`)
    }
  }
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, appliedAt INTEGER NOT NULL);
    INSERT INTO schema_migrations VALUES (98, 1000);
    CREATE TABLE daily_close_maintenance_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      retain_trade_days INTEGER NOT NULL,
      removed_rows INTEGER,
      remaining_trade_days INTEGER,
      message TEXT
    );
    INSERT INTO daily_close_cache VALUES
      ('600000.SH', '20260710', 10, 11, 9, 10.5, 1.2, 100, 2.1),
      ('000001.SZ', '20260711', NULL, 12, 10, 11, NULL, 200, NULL);
    INSERT INTO daily_close_maintenance_state VALUES
      (1, 'success', 1000, 2000, 520, 12, 520, NULL);
  `)
  return db
}

describe('diagnostics dailyCloseQuality', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('增加质量摘要且保持原日线诊断项和动作不变', () => {
    const db = createDiagnosticsDb()
    const snapshot = getDiagnosticsHealth(db)
    const dailyCloseItem = snapshot.groups
      .find((group) => group.key === 'freshness')
      ?.items.find((item) => item.key === 'freshness.dailyClose')

    expect(dailyCloseItem).toBeDefined()
    expect(dailyCloseItem?.actions).toEqual([
      { key: 'syncHistoricalDaily', label: '同步全市场历史日线', kind: 'run' },
    ])
    expect(dailyCloseItem?.message).toContain('/480')
    expect(snapshot.dailyCloseQuality).toEqual({
      targetTradeDays: 480,
      retentionTradeDays: 520,
      actualTradeDays: 2,
      totalRows: 2,
      earliestTradeDate: '20260710',
      latestTradeDate: '20260711',
      fields: {
        open: { missingRows: 1, missingRate: 0.5 },
        high: { missingRows: 0, missingRate: 0 },
        low: { missingRows: 0, missingRate: 0 },
        close: { missingRows: 0, missingRate: 0 },
        pctChg: { missingRows: 1, missingRate: 0.5 },
        vol: { missingRows: 0, missingRate: 0 },
        turnoverRate: { missingRows: 1, missingRate: 0.5 },
      },
      cleanup: {
        status: 'success',
        startedAt: 1000,
        completedAt: 2000,
        retainTradeDays: 520,
        removedRows: 12,
        remainingTradeDays: 520,
        message: null,
      },
    })
    db.close()
  })
})
