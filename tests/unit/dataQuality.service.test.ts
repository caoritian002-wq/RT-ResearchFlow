import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import { getDataQualitySnapshot, persistDataQualitySnapshot } from '../../electron/main/services/dataQualityService'

const NOW = Date.parse('2026-07-24T02:00:00.000Z')

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '')
}

function createDb(): Database.Database {
  const db = new Database(':memory:')
  runMigrations(db, DATABASE_MIGRATIONS)
  return db
}

function seedUsableFixture(db: Database.Database): string[] {
  db.prepare(`
    INSERT INTO stock_basic_cache (ts_code, name, industry, market, list_status, circ_float, updated_at)
    VALUES ('600001.SH', '示例股份', '电子', '主板', 'L', 100, ?)
  `).run(NOW)

  const lastHistorical = new Date('2026-07-23T00:00:00.000Z')
  const historical: string[] = []
  const insertCalendar = db.prepare('INSERT INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 1, ?)')
  const insertDaily = db.prepare(`
    INSERT INTO daily_close_cache (ts_code, trade_date, close, pct_chg, open, high, low, vol, turnover_rate)
    VALUES ('600001.SH', ?, 10, 0, 10, 10.5, 9.5, 100, 1)
  `)
  const insertHistory = db.transaction(() => {
    let previous: string | null = null
    for (let offset = 479; offset >= 0; offset -= 1) {
      const date = new Date(lastHistorical)
      date.setUTCDate(date.getUTCDate() - offset)
      const value = ymd(date)
      historical.push(value)
      insertCalendar.run(value, previous)
      insertDaily.run(value)
      previous = value
    }
  })
  insertHistory()
  db.prepare(`INSERT INTO trade_cal (cal_date, is_open, pretrade_date) VALUES ('20260724', 1, '20260723')`).run()
  const future = new Date('2026-07-25T00:00:00.000Z')
  const insertFuture = db.prepare('INSERT INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 0, NULL)')
  for (let offset = 0; offset <= 70; offset += 1) {
    const date = new Date(future)
    date.setUTCDate(date.getUTCDate() + offset)
    insertFuture.run(ymd(date))
  }

  db.prepare(`
    INSERT INTO stk_auction_cache (ts_code, trade_date, price, vol, amount, fetched_at)
    VALUES ('600001.SH', '20260724', 10.1, 100, 1010, ?)
  `).run(NOW)

  const benchmarkDates = historical.slice(-30)
  const insertBenchmark = db.prepare(`
    INSERT INTO daily_close_cache (ts_code, trade_date, close, pct_chg, open, high, low, vol, turnover_rate)
    VALUES (?, ?, 100, 0, 100, 101, 99, NULL, NULL)
  `)
  for (const code of ['000001.SH', '399001.SZ', '399006.SZ', '000300.SH']) {
    for (const date of benchmarkDates) insertBenchmark.run(code, date)
  }

  db.prepare(`
    INSERT INTO industry_research_companies (
      id, legal_name, source_type, created_at, updated_at
    ) VALUES ('company-1', '示例股份有限公司', 'manual', ?, ?)
  `).run(NOW, NOW)
  db.prepare(`
    INSERT INTO industry_research_securities (
      id, company_id, ts_code, exchange, security_type, list_status, mapping_source, created_at, updated_at
    ) VALUES ('security-1', 'company-1', '600001.SH', 'SSE', 'A_SHARE', 'L', 'manual', ?, ?)
  `).run(NOW, NOW)
  db.prepare(`
    INSERT INTO security_adjustment_factor_cache (ts_code, trade_date, adj_factor, source, fetched_at)
    VALUES ('600001.SH', '20260723', 1, 'tushare', ?)
  `).run(NOW)
  db.prepare(`
    INSERT INTO industry_research_financial_facts (
      id, company_id, security_id, source_api, source_fact_key, source_version,
      metric_name, metric_value, ann_date, f_ann_date, report_period, fact_kind,
      input_versions_json, derivation_status, fetched_at, created_at
    ) VALUES (
      'fact-1', 'company-1', 'security-1', 'income', 'income-1', 'v1',
      'revenue', 100, '20260420', '20260420', '20260331', 'reported',
      '[]', 'not_applicable', ?, ?
    )
  `).run(NOW, NOW)
  return historical
}

describe('dataQualityService', () => {
  it('空库返回六类稳定结果且普通读取不保存正式快照', () => {
    const db = createDb()
    try {
      const snapshot = getDataQualitySnapshot(db, NOW)
      expect(snapshot.datasets).toHaveLength(6)
      expect(snapshot.status).toBe('blocked')
      expect(snapshot.persistedRunId).toBeNull()
      expect(db.prepare('SELECT COUNT(*) AS count FROM data_quality_runs').get()).toEqual({ count: 0 })
      expect(snapshot.datasets.find((item) => item.key === 'financials')).toMatchObject({ status: 'reliable', summary: '当前没有待检查的产业研究公司' })
    } finally {
      db.close()
    }
  })

  it('识别六类可用范围并只对显式完整检查落库', () => {
    const db = createDb()
    try {
      seedUsableFixture(db)
      const current = getDataQualitySnapshot(db, NOW)
      expect(current.datasets.find((item) => item.key === 'tradeCalendar')?.status).toBe('reliable')
      expect(current.datasets.find((item) => item.key === 'dailyMarket')?.status).not.toBe('blocked')
      expect(current.datasets.find((item) => item.key === 'auction')?.status).toBe('reliable')
      expect(current.datasets.find((item) => item.key === 'benchmarks')?.status).toBe('reliable')
      expect(current.datasets.find((item) => item.key === 'financials')?.status).toBe('reliable')
      expect(db.prepare('SELECT COUNT(*) AS count FROM data_quality_runs').get()).toEqual({ count: 0 })

      const persisted = persistDataQualitySnapshot(db, NOW + 1)
      expect(persisted.persistedRunId).toBeGreaterThan(0)
      expect(db.prepare('SELECT COUNT(*) AS count FROM data_quality_runs').get()).toEqual({ count: 1 })
      expect(getDataQualitySnapshot(db, NOW + 2).persistedAt).toBe(NOW + 1)
    } finally {
      db.close()
    }
  })

  it('未来日线和缺失复权因子只形成明确降级原因，不进入可用截止日', () => {
    const db = createDb()
    try {
      seedUsableFixture(db)
      db.prepare(`DELETE FROM security_adjustment_factor_cache WHERE ts_code = '600001.SH'`).run()
      db.prepare(`
        INSERT INTO daily_close_cache (ts_code, trade_date, close, pct_chg, open, high, low, vol, turnover_rate)
        VALUES ('600002.SH', '20260730', 10, 0, 10, 11, 9, 100, 1)
      `).run()
      const daily = getDataQualitySnapshot(db, NOW).datasets.find((item) => item.key === 'dailyMarket')
      expect(daily?.status).toBe('degraded')
      expect(daily?.reasons.map((item) => item.code)).toEqual(expect.arrayContaining(['FUTURE_FACTS', 'ADJUSTMENT_GAPS']))
    } finally {
      db.close()
    }
  })
})
