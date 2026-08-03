import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { getLatestMonitorResultsByTsCodes } from '../../electron/main/database/chipMonitorRepository'

describe('筹码兼容结果批量仓库', () => {
  it('只按请求代码查询旧结果，不扫描监控股池', () => {
    let preparedSql = ''
    const all = vi.fn().mockReturnValue([{
      ts_code: '600000.SH',
      source: null,
      stock_name: '浦发银行',
      trade_date: '20260710',
      mode: 'relative',
      bottom_pct: 20,
      bottom_avg_cost: 9.5,
      loosening_1d: 1,
      loosening_3d: 3,
      loosening_5d: 5,
      loosening_1d_reason: null,
      loosening_3d_reason: null,
      loosening_5d_reason: null,
      updated_at: 1000,
      pct_chg: 2.5,
      turnover_rate: 1.2,
      current_price: 10,
    }])
    const db = {
      prepare(sql: string) {
        preparedSql = sql
        return { all }
      },
    }

    const rows = getLatestMonitorResultsByTsCodes(db as never, ['600000.SH'])

    expect(preparedSql).toContain('FROM chip_monitor_results')
    expect(preparedSql).toContain('r.ts_code IN')
    expect(preparedSql).not.toContain('chip_monitor_stocks')
    expect(preparedSql).toContain('daily_ranked AS')
    expect(preparedSql).toContain("replace(replace(replace(d.ts_code, '.SH', ''), '.SZ', ''), '.BJ', '') = r.code6")
    expect(all).toHaveBeenCalledWith('relative', '600000.SH', '600000')
    expect(rows).toEqual([expect.objectContaining({
      tsCode: '600000.SH',
      tradeDate: '20260710',
      bottomPct: 20,
      pctChg: 2.5,
      turnoverRate: 1.2,
    })])
  })

  it('空请求不访问数据库', () => {
    const prepare = vi.fn()

    expect(getLatestMonitorResultsByTsCodes({ prepare } as never, [])).toEqual([])
    expect(prepare).not.toHaveBeenCalled()
  })

  it('纯六位代码会补充交易所后缀别名', () => {
    const all = vi.fn().mockReturnValue([])
    const db = { prepare: vi.fn().mockReturnValue({ all }) }

    getLatestMonitorResultsByTsCodes(db as never, ['600000', '000001', '920001'])

    expect(all).toHaveBeenCalledWith(
      'relative',
      '600000', '600000.SH',
      '000001', '000001.SZ',
      '920001', '920001.BJ',
    )
  })

  it('显式日期只读取目标交易日', () => {
    let preparedSql = ''
    const all = vi.fn().mockReturnValue([])
    const db = {
      prepare(sql: string) {
        preparedSql = sql
        return { all }
      },
    }

    getLatestMonitorResultsByTsCodes(db as never, ['600000.SH'], 'relative', '20260710')

    expect(preparedSql).toContain('r.trade_date = ?')
    expect(all).toHaveBeenCalledWith('relative', '20260710', '600000.SH', '600000')
  })

  it('可在真实 SQLite 中读取同日最优代码记录', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE chip_monitor_results (
        ts_code TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        mode TEXT,
        bottom_pct REAL,
        bottom_avg_cost REAL,
        loosening_1d REAL,
        loosening_3d REAL,
        loosening_5d REAL,
        loosening_1d_reason TEXT,
        loosening_3d_reason TEXT,
        loosening_5d_reason TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE daily_close_cache (
        ts_code TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        close REAL,
        pct_chg REAL,
        turnover_rate REAL
      );
      CREATE TABLE stock_info (stockCode TEXT PRIMARY KEY, stockName TEXT);
      INSERT INTO chip_monitor_results VALUES
        ('600000.SH', '20260710', 'relative', 20, 9.5, 1, 3, 5, NULL, NULL, NULL, 1000);
      INSERT INTO daily_close_cache VALUES
        ('600000', '20260710', 9.8, 1.1, 0.8),
        ('600000.SH', '20260710', 10, 2.5, 1.2);
      INSERT INTO stock_info VALUES ('600000', '浦发银行');
    `)

    try {
      const rows = getLatestMonitorResultsByTsCodes(db, ['600000'], 'relative', '20260710')

      expect(rows).toEqual([expect.objectContaining({
        tsCode: '600000.SH',
        stockName: '浦发银行',
        tradeDate: '20260710',
        pctChg: 2.5,
        turnoverRate: 1.2,
        currentPrice: 10,
      })])
    } finally {
      db.close()
    }
  })
})