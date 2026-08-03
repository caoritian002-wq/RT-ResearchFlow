import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import {
  aggregateReport,
  computeRealizedEquity,
  computeStrengthDeciles,
  runStrategyBacktest
} from '../../electron/main/services/backtest/strategyBacktestEngine'
import {
  computeParamHash,
  deleteRun,
  findRunByParamHash,
  markRunFailed,
  parseStoredBacktestReport
} from '../../electron/main/database/strategyBacktestRepository'
import {
  fromAuctionBacktestDetails,
  fromDecisionSignals,
  fromShortTermSignals,
  fromTrendAlerts,
  mergeShortTermSignals,
  toSuffixedTsCode
} from '../../electron/main/services/backtest/signalSources'
import { STRATEGY_BACKTEST_ENGINE_VERSION } from '../../electron/main/services/backtest/types'
import type {
  BacktestSignal,
  TradePlan,
  TradeResult
} from '../../electron/main/services/backtest/types'

const SIG: BacktestSignal = {
  strategyKey: 'shortTerm.test',
  tsCode: '000001.SZ',
  tradeDate: '20260101',
  strength: 1
}
const NO_FEE: TradePlan = { entryRule: 'nextOpen', holdDays: 1, feeBps: 0 }

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE short_term_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy TEXT NOT NULL,
      ts_code TEXT, name TEXT, trigger_at INTEGER, trade_date TEXT,
      signal_strength REAL, signal_meta TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE stock_info (
      stockCode TEXT PRIMARY KEY,
      stockName TEXT
    );
    CREATE TABLE stk_auction_backtest_detail (
      trade_date TEXT NOT NULL,
      ts_code TEXT NOT NULL,
      pool TEXT NOT NULL,
      buy_price REAL,
      ret_1d REAL,
      ret_2d REAL,
      ret_3d REAL,
      ret_5d REAL,
      computed_at INTEGER,
      is_one_word INTEGER NOT NULL DEFAULT 0,
      idx_today_pct REAL,
      idx_ret1d REAL,
      idx_ret2d REAL,
      idx_ret3d REAL,
      idx_ret5d REAL,
      PRIMARY KEY (trade_date, ts_code, pool)
    );
    CREATE TABLE daily_close_cache (
      ts_code TEXT NOT NULL, trade_date TEXT NOT NULL,
      open REAL, high REAL, low REAL, close REAL NOT NULL,
      pct_chg REAL, vol REAL, turnover_rate REAL,
      PRIMARY KEY (ts_code, trade_date)
    );
    CREATE TABLE trend_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_code TEXT NOT NULL,
      stock_name TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      alert_date TEXT NOT NULL,
      price REAL,
      ref_price REAL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE decision_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_module TEXT NOT NULL,
      strategy_key TEXT NOT NULL,
      ts_code TEXT,
      stock_name TEXT,
      concept_code TEXT,
      concept_name TEXT,
      signal_type TEXT NOT NULL,
      direction TEXT NOT NULL,
      priority INTEGER NOT NULL,
      score REAL,
      confidence REAL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      reason_json TEXT,
      source_ref_json TEXT,
      status TEXT NOT NULL,
      dedup_key TEXT NOT NULL UNIQUE,
      signal_time INTEGER NOT NULL,
      expire_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE strategy_backtest_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_key TEXT NOT NULL,
      date_start TEXT NOT NULL,
      date_end TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      param_hash TEXT NOT NULL,
      report_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      error_message TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL,
      completed_at INTEGER DEFAULT NULL,
      UNIQUE(param_hash)
    );
    CREATE TABLE strategy_backtest_trades (
      run_id INTEGER NOT NULL,
      strategy_key TEXT NOT NULL,
      ts_code TEXT NOT NULL,
      signal_date TEXT NOT NULL,
      entry_date TEXT,
      entry_price REAL,
      exit_date TEXT,
      exit_price REAL,
      gross_return_pct REAL,
      net_return_pct REAL,
      return_pct REAL,
      exit_reason TEXT,
      status TEXT NOT NULL DEFAULT 'executed',
      strength REAL,
      meta_json TEXT DEFAULT NULL,
      PRIMARY KEY (run_id, ts_code, signal_date, entry_date)
    );
  `)
  return db
}

describe('aggregateReport - 组合统计', () => {
  function mkTrade(returnPct: number | null, entryDate: string | null): TradeResult {
    return {
      signal: { ...SIG, tsCode: '000001.SZ', tradeDate: entryDate ?? '20260101' },
      entryDate,
      entryPrice: 10,
      exitDate: entryDate,
      exitPrice: 10,
      returnPct,
      grossReturnPct: returnPct,
      netReturnPct: returnPct,
      exitReason: returnPct === null ? 'data_insufficient' : 'hold_expired',
      status: returnPct === null ? 'data_insufficient' : 'executed',
      valid: returnPct !== null
    }
  }

  it('胜率/均值/盈亏比/回撤/剔除率', () => {
    const trades: TradeResult[] = [
      mkTrade(10, '20260101'),
      mkTrade(-5, '20260102'),
      mkTrade(4, '20260103'),
      mkTrade(-2, '20260104'),
      mkTrade(8, '20260105'),
      mkTrade(null, null)
    ]
    const rep = aggregateReport('shortTerm.test', { start: '20260101', end: '20260105' }, NO_FEE, trades)
    expect(rep.totalSignals).toBe(6)
    expect(rep.validTrades).toBe(5)
    expect(rep.dropRate).toBeCloseTo(1 / 6, 6)
    expect(rep.winRate).toBeCloseTo(0.6, 6)
    expect(rep.avgReturn).toBeCloseTo(3, 6)
    expect(rep.profitFactor).toBeCloseTo(22 / 7, 6)
    expect(rep.maxDrawdown).toBeCloseTo(5, 6)
  })

  it('按出场日复合实现净值并以历史峰值计算回撤', () => {
    const summary = computeRealizedEquity([
      mkTrade(10, '20260101'),
      mkTrade(-5, '20260102'),
      mkTrade(20, '20260103')
    ])

    expect(summary.equityCurve?.map(point => point.equity)).toEqual([
      expect.closeTo(1.1, 10),
      expect.closeTo(1.045, 10),
      expect.closeTo(1.254, 10)
    ])
    expect(summary.totalReturn).toBeCloseTo(25.4, 10)
    expect(summary.maxDrawdown).toBeCloseTo(5, 10)
  })

  it('同一出场日先等权聚合且不受交易输入顺序影响', () => {
    const positive = mkTrade(10, '20260101')
    const negative = { ...mkTrade(-10, '20260101'), signal: { ...SIG, tsCode: '000002.SZ' } }
    const forward = computeRealizedEquity([positive, negative])
    const reversed = computeRealizedEquity([negative, positive])

    expect(forward).toEqual(reversed)
    expect(forward.equityCurve).toEqual([{
      date: '20260101',
      realizedReturnPct: 0,
      tradeCount: 2,
      equity: 1,
      drawdownPct: 0
    }])
    expect(forward.totalReturn).toBe(0)
    expect(forward.maxDrawdown).toBe(0)
  })

  it('全部剔除时阻断报告且不伪造零值绩效', () => {
    const rep = aggregateReport('x', { start: '20260101', end: '20260101' }, NO_FEE, [
      mkTrade(null, null)
    ])
    expect(rep.validTrades).toBe(0)
    expect(rep.trust.status).toBe('blocked')
    expect(rep.trust.reasons).toEqual(['NO_VALID_TRADES'])
    expect(rep.winRate).toBeNull()
    expect(rep.avgReturn).toBeNull()
    expect(rep.dropRate).toBe(1)
    expect(rep.totalReturn).toBeNull()
    expect(rep.equityCurve).toBeNull()
    expect(rep.maxDrawdown).toBeNull()
  })

  it('零信号时阻断报告且剔除率不可统计', () => {
    const rep = aggregateReport('x', { start: '20260101', end: '20260101' }, NO_FEE, [])
    expect(rep.trust.status).toBe('blocked')
    expect(rep.trust.reasons).toEqual(['NO_SIGNALS'])
    expect(rep.dropRate).toBeNull()
    expect(rep.winRate).toBeNull()
    expect(rep.totalReturn).toBeNull()
    expect(rep.equityCurve).toBeNull()
  })

  it('按强度从高到低分层且不拆分相同评分', () => {
    const strengths = [0.9, 0.9, 0.9, 0.9, 0.9, 0.8, 0.8, 0.8, 0.8, 0.8, 0.4, 0.4, 0.4, 0.4, 0.4, 0.1, 0.1, 0.1, 0.1, 0.1]
    const trades = strengths.map((strength, index): TradeResult => ({
      ...mkTrade(index + 1, `202601${String(index + 1).padStart(2, '0')}`),
      signal: { ...SIG, strength }
    }))
    const buckets = computeStrengthDeciles(trades)
    expect(buckets).toHaveLength(4)
    expect(buckets?.[0]).toMatchObject({ minStrength: 0.9, maxStrength: 0.9, count: 5 })
    expect(buckets?.[3]).toMatchObject({ minStrength: 0.1, maxStrength: 0.1, count: 5 })
    expect(buckets?.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(20)
  })

  it('所有信号强度相同时不制造虚假分层', () => {
    const trades = Array.from({ length: 20 }, (_, index): TradeResult => ({
      ...mkTrade(index + 1, `202602${String(index + 1).padStart(2, '0')}`),
      signal: { ...SIG, strength: 1 }
    }))
    expect(computeStrengthDeciles(trades)).toBeNull()
  })
})

describe('toSuffixedTsCode - 代码规范化', () => {
  it('补后缀与原样透传', () => {
    expect(toSuffixedTsCode('600000')).toBe('600000.SH')
    expect(toSuffixedTsCode('000001')).toBe('000001.SZ')
    expect(toSuffixedTsCode('300750')).toBe('300750.SZ')
    expect(toSuffixedTsCode('688981')).toBe('688981.SH')
    expect(toSuffixedTsCode('000001.SZ')).toBe('000001.SZ')
    expect(toSuffixedTsCode('abc')).toBeNull()
    expect(toSuffixedTsCode(null)).toBeNull()
  })
})

describe('fromShortTermSignals - 短线策略信号映射', () => {
  it('短线模块与策略实验室前缀互不混合', () => {
    const db = createDb()
    const insert = db.prepare(
      `INSERT INTO short_term_signals (strategy, ts_code, trade_date, signal_strength, created_at)
       VALUES (?, ?, ?, ?, 0)`
    )
    insert.run('strategyLab.builtin-condition-blocks', '000001.SZ', '20260714', 90)
    insert.run('shortTerm.legacy', '600000.SH', '20260715', 80)
    insert.run('strategyLab.outside-range', '300750.SZ', '20260720', 70)

    const shortTermOnly = fromShortTermSignals(db, 'shortTerm.*', '20260713', '20260716')
    expect(shortTermOnly.map(signal => signal.strategyKey)).toEqual(['shortTerm.legacy'])

    const strategyLabOnly = fromShortTermSignals(db, 'strategyLab.*', '20260713', '20260716')
    expect(strategyLabOnly.map(signal => signal.strategyKey)).toEqual([
      'strategyLab.builtin-condition-blocks'
    ])
  })

  it('短线全部信号接入真实竞价明细并按同股同日去重', () => {
    const db = createDb()
    const insertAuction = db.prepare(`
      INSERT INTO stk_auction_backtest_detail
        (trade_date, ts_code, pool, buy_price, computed_at, is_one_word)
      VALUES (?, ?, ?, ?, 100, 0)
    `)
    insertAuction.run('20260713', '000001.SZ', 'allMarket', 10)
    insertAuction.run('20260713', '000001.SZ', 'firstBoard', 10)
    insertAuction.run('20260713', '600000.SH', 'brokenBoard', 20)
    insertAuction.run('20260713', '300750.SZ', 'allMarket', 30)
    db.prepare(`
      INSERT INTO short_term_signals (strategy, ts_code, trade_date, signal_strength, created_at)
      VALUES ('shortTerm.manual', '000001.SZ', '20260713', 80, 0)
    `).run()

    const boardSignals = fromAuctionBacktestDetails(db, 'auction.threeOne', '20260713', '20260713')
    expect(boardSignals.map(signal => signal.tsCode)).toEqual(['000001.SZ', '600000.SH'])
    expect(boardSignals[0].meta?.pools).toEqual(['firstBoard'])

    const allSignals = mergeShortTermSignals([
      ...fromShortTermSignals(db, 'shortTerm.*', '20260713', '20260713'),
      ...fromAuctionBacktestDetails(db, 'shortTerm.*', '20260713', '20260713')
    ])
    expect(allSignals).toHaveLength(3)
    expect(allSignals.filter(signal => signal.tsCode === '000001.SZ')).toHaveLength(1)
  })
})

describe('runStrategyBacktest - 端到端 + 缓存命中', () => {
  it('板票竞价双第一可按用户持有期重新撮合历史报告', () => {
    const db = createDb()
    db.prepare(`
      INSERT INTO stk_auction_backtest_detail
        (trade_date, ts_code, pool, buy_price, computed_at, is_one_word)
      VALUES ('20260101', '000001.SZ', 'firstBoard', 9.8, 100, 0)
    `).run()
    const px = db.prepare(
      `INSERT INTO daily_close_cache (ts_code, trade_date, open, high, low, close) VALUES (?, ?, ?, ?, ?, ?)`
    )
    px.run('000001.SZ', '20260101', 9.8, 10, 9.7, 10)
    px.run('000001.SZ', '20260102', 10, 10.5, 9.9, 10.2)
    px.run('000001.SZ', '20260103', 10.2, 10.8, 10.1, 10.5)
    px.run('000001.SZ', '20260104', 10.5, 11.2, 10.4, 11)

    const result = runStrategyBacktest(db, {
      strategyKey: 'auction.threeOne',
      dateStart: '20260101',
      dateEnd: '20260101',
      plan: { entryRule: 'nextOpen', holdDays: 2, feeBps: 0 }
    })

    expect(result.report.totalSignals).toBe(1)
    expect(result.report.validTrades).toBe(1)
    expect(result.report.avgReturn).toBeCloseTo(10, 6)
    expect(result.report.totalReturn).toBeCloseTo(10, 6)
  })

  it('删除回测记录时在同一事务清理交易明细', () => {
    const db = createDb()
    db.prepare(
      `INSERT INTO short_term_signals (strategy, ts_code, trade_date, signal_strength, created_at)
       VALUES ('strategyLab.test', '000001.SZ', '20260101', 1, 0)`
    ).run()
    const px = db.prepare(
      `INSERT INTO daily_close_cache (ts_code, trade_date, open, high, low, close) VALUES (?, ?, ?, ?, ?, ?)`
    )
    px.run('000001.SZ', '20260102', 10, 10.5, 9.9, 10.4)
    px.run('000001.SZ', '20260103', 10.4, 11, 10.3, 11)

    const result = runStrategyBacktest(db, {
      strategyKey: 'strategyLab.test',
      dateStart: '20260101',
      dateEnd: '20260101',
      plan: NO_FEE
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM strategy_backtest_trades WHERE run_id = ?').get(result.runId)).toEqual({ count: 1 })

    expect(deleteRun(db, result.runId)).toBe(true)
    expect(db.prepare('SELECT COUNT(*) AS count FROM strategy_backtest_runs WHERE id = ?').get(result.runId)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM strategy_backtest_trades WHERE run_id = ?').get(result.runId)).toEqual({ count: 0 })
    expect(deleteRun(db, result.runId)).toBe(false)
  })

  it('从 short_term_signals 撮合并落库, 复算命中缓存', () => {
    const db = createDb()
    db.prepare(
      `INSERT INTO short_term_signals (strategy, ts_code, trade_date, signal_strength, signal_meta, created_at)
       VALUES ('shortTerm.test', '000001.SZ', '20260101', NULL, '{"pool":"test"}', 0)`
    ).run()
    const px = db.prepare(
      `INSERT INTO daily_close_cache (ts_code, trade_date, open, high, low, close) VALUES (?, ?, ?, ?, ?, ?)`
    )
    px.run('000001.SZ', '20260101', 9.9, 10, 9.8, 10)
    px.run('000001.SZ', '20260102', 10, 10.5, 9.9, 10.4)
    px.run('000001.SZ', '20260103', 10.4, 11, 10.3, 11)

    const r1 = runStrategyBacktest(db, {
      strategyKey: 'shortTerm.test',
      dateStart: '20260101',
      dateEnd: '20260101',
      plan: NO_FEE
    })
    expect(r1.cached).toBe(false)
    expect(r1.report.validTrades).toBe(1)
    expect(r1.report.winRate).toBe(1)
    expect(r1.report.avgReturn).toBeCloseTo(10, 6)

    const trade = db
      .prepare('SELECT strategy_key, signal_date, status, strength, gross_return_pct, net_return_pct, meta_json FROM strategy_backtest_trades WHERE run_id = ?')
      .get(r1.runId) as {
      strategy_key: string
      signal_date: string
      status: string
      strength: number
      gross_return_pct: number
      net_return_pct: number
      meta_json: string | null
    }
    expect(trade.strategy_key).toBe('shortTerm.test')
    expect(trade.signal_date).toBe('20260101')
    expect(trade.status).toBe('executed')
    expect(trade.strength).toBe(1)
    expect(trade.gross_return_pct).toBeCloseTo(10, 6)
    expect(trade.net_return_pct).toBeCloseTo(10, 6)
    expect(trade.meta_json).toContain('test')

    const r2 = runStrategyBacktest(db, {
      strategyKey: 'shortTerm.test',
      dateStart: '20260101',
      dateEnd: '20260101',
      plan: NO_FEE
    })
    expect(r2.cached).toBe(true)
    expect(r2.runId).toBe(r1.runId)
  })

  it('信号或行情事实变化时不命中旧缓存', () => {
    const db = createDb()
    db.prepare(
      `INSERT INTO short_term_signals (strategy, ts_code, trade_date, signal_strength, signal_meta, created_at)
       VALUES ('shortTerm.test', '000001.SZ', '20260101', 1, '{"pool":"before"}', 0)`
    ).run()
    const px = db.prepare(
      `INSERT INTO daily_close_cache (ts_code, trade_date, open, high, low, close) VALUES (?, ?, ?, ?, ?, ?)`
    )
    px.run('000001.SZ', '20260101', 9.9, 10, 9.8, 10)
    px.run('000001.SZ', '20260102', 10, 10.5, 9.9, 10.4)
    px.run('000001.SZ', '20260103', 10.4, 11, 10.3, 11)

    const first = runStrategyBacktest(db, {
      strategyKey: 'shortTerm.test',
      dateStart: '20260101',
      dateEnd: '20260101',
      plan: NO_FEE
    })
    db.prepare("UPDATE short_term_signals SET signal_meta = '{\"pool\":\"after\"}' WHERE strategy = 'shortTerm.test'").run()
    const signalChanged = runStrategyBacktest(db, {
      strategyKey: 'shortTerm.test',
      dateStart: '20260101',
      dateEnd: '20260101',
      plan: NO_FEE
    })
    expect(signalChanged.cached).toBe(false)
    expect(signalChanged.runId).not.toBe(first.runId)
    expect(signalChanged.report.trust.factFingerprint).not.toBe(first.report.trust.factFingerprint)

    db.prepare("UPDATE daily_close_cache SET close = 12 WHERE ts_code = '000001.SZ' AND trade_date = '20260103'").run()
    const priceChanged = runStrategyBacktest(db, {
      strategyKey: 'shortTerm.test',
      dateStart: '20260101',
      dateEnd: '20260101',
      plan: NO_FEE
    })
    expect(priceChanged.cached).toBe(false)
    expect(priceChanged.runId).not.toBe(signalChanged.runId)
    expect(priceChanged.report.avgReturn).toBeCloseTo(20, 6)
  })

  it('仅基准行情事实变化时不命中旧缓存', () => {
    const db = createDb()
    db.prepare(
      `INSERT INTO short_term_signals (strategy, ts_code, trade_date, signal_strength, created_at)
       VALUES ('shortTerm.test', '000001.SZ', '20260101', 1, 0)`
    ).run()
    const px = db.prepare(
      `INSERT INTO daily_close_cache (ts_code, trade_date, open, high, low, close) VALUES (?, ?, ?, ?, ?, ?)`
    )
    px.run('000001.SZ', '20260101', 9.9, 10, 9.8, 10)
    px.run('000001.SZ', '20260102', 10, 10.5, 9.9, 10.4)
    px.run('000001.SZ', '20260103', 10.4, 11, 10.3, 11)
    px.run('600000.SH', '20260102', 20, 20.5, 19.8, 20.2)
    px.run('600000.SH', '20260103', 20.2, 20.6, 20, 20.4)

    const first = runStrategyBacktest(db, {
      strategyKey: 'shortTerm.test',
      dateStart: '20260101',
      dateEnd: '20260101',
      plan: NO_FEE
    })
    db.prepare("UPDATE daily_close_cache SET close = 24 WHERE ts_code = '600000.SH' AND trade_date = '20260103'").run()
    const benchmarkChanged = runStrategyBacktest(db, {
      strategyKey: 'shortTerm.test',
      dateStart: '20260101',
      dateEnd: '20260101',
      plan: NO_FEE
    })

    expect(benchmarkChanged.cached).toBe(false)
    expect(benchmarkChanged.runId).not.toBe(first.runId)
    expect(benchmarkChanged.report.avgReturn).toBe(first.report.avgReturn)
    expect(benchmarkChanged.report.benchmarkReturn).not.toBe(first.report.benchmarkReturn)
    expect(benchmarkChanged.report.trust.factFingerprint).not.toBe(first.report.trust.factFingerprint)
  })

  it('相关数据质量指纹变化时不命中旧缓存', () => {
    const db = createDb()
    db.prepare(
      `INSERT INTO short_term_signals (strategy, ts_code, trade_date, signal_strength, created_at)
       VALUES ('shortTerm.test', '000001.SZ', '20260101', 1, 0)`
    ).run()
    const px = db.prepare(
      `INSERT INTO daily_close_cache (ts_code, trade_date, open, high, low, close) VALUES (?, ?, ?, ?, ?, ?)`
    )
    px.run('000001.SZ', '20260101', 9.9, 10, 9.8, 10)
    px.run('000001.SZ', '20260102', 10, 10.5, 9.9, 10.4)
    px.run('000001.SZ', '20260103', 10.4, 11, 10.3, 11)

    const first = runStrategyBacktest(db, {
      strategyKey: 'shortTerm.test',
      dateStart: '20260101',
      dateEnd: '20260101',
      plan: NO_FEE
    })
    const sameFacts = runStrategyBacktest(db, {
      strategyKey: 'shortTerm.test',
      dateStart: '20260101',
      dateEnd: '20260101',
      plan: NO_FEE
    })
    expect(sameFacts.cached).toBe(true)

    db.exec(`
      CREATE TABLE trade_cal (
        exchange TEXT,
        cal_date TEXT PRIMARY KEY,
        is_open INTEGER,
        pretrade_date TEXT
      )
    `)
    const qualityChanged = runStrategyBacktest(db, {
      strategyKey: 'shortTerm.test',
      dateStart: '20260101',
      dateEnd: '20260101',
      plan: NO_FEE
    })

    expect(qualityChanged.cached).toBe(false)
    expect(qualityChanged.runId).not.toBe(first.runId)
    expect(qualityChanged.report.trust.factFingerprint).toBe(first.report.trust.factFingerprint)
    expect(qualityChanged.report.trust.credibility?.dataQualityFingerprint)
      .not.toBe(first.report.trust.credibility?.dataQualityFingerprint)
  })

  it('引擎版本变化会生成不同缓存键', () => {
    const current = computeParamHash('shortTerm.test', '20260101', '20260101', NO_FEE, 'shortTerm', '2.0.0', 'facts')
    const upgraded = computeParamHash('shortTerm.test', '20260101', '20260101', NO_FEE, 'shortTerm', '2.0.1', 'facts')
    expect(upgraded).not.toBe(current)
  })

  it('旧报告可读但不能命中新版缓存', () => {
    const db = createDb()
    const factFingerprint = 'current-facts'
    const paramHash = computeParamHash(
      'shortTerm.test',
      '20260101',
      '20260101',
      NO_FEE,
      'shortTerm',
      STRATEGY_BACKTEST_ENGINE_VERSION,
      factFingerprint
    )
    const legacyReport = {
      strategyKey: 'shortTerm.test',
      dateRange: { start: '20260101', end: '20260101' },
      plan: NO_FEE,
      totalSignals: 1,
      validTrades: 1,
      winRate: 1
    }
    db.prepare(
      `INSERT INTO strategy_backtest_runs
         (strategy_key, date_start, date_end, plan_json, param_hash, report_json, status, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'completed', 1, 1)`
    ).run('shortTerm.test', '20260101', '20260101', JSON.stringify(NO_FEE), paramHash, JSON.stringify(legacyReport))

    const parsed = parseStoredBacktestReport(JSON.stringify(legacyReport))
    expect(parsed?.schemaVersion).toBe(1)
    expect(parsed?.trust).toEqual({
      status: 'degraded',
      reasons: ['LEGACY_REPORT'],
      engineVersion: 'legacy',
      factFingerprint: ''
    })
    expect(findRunByParamHash(db, paramHash, STRATEGY_BACKTEST_ENGINE_VERSION, factFingerprint)).toBeNull()
  })

  it('V2 报告保持历史版本可读且旧回撤不冒充实现净值回撤', () => {
    const db = createDb()
    const factFingerprint = 'v2-facts'
    const paramHash = computeParamHash(
      'shortTerm.test',
      '20260101',
      '20260101',
      NO_FEE,
      'shortTerm',
      STRATEGY_BACKTEST_ENGINE_VERSION,
      factFingerprint
    )
    const v2Report = {
      schemaVersion: 2,
      generatedAt: 1,
      trust: {
        status: 'degraded',
        reasons: ['APPROXIMATE_DRAWDOWN'],
        engineVersion: '2.0.0',
        factFingerprint: 'old-facts'
      },
      strategyKey: 'shortTerm.test',
      dateRange: { start: '20260101', end: '20260101' },
      plan: NO_FEE,
      totalSignals: 1,
      validTrades: 1,
      maxDrawdown: 5
    }
    db.prepare(
      `INSERT INTO strategy_backtest_runs
         (strategy_key, date_start, date_end, plan_json, param_hash, report_json, status, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'completed', 1, 1)`
    ).run('shortTerm.test', '20260101', '20260101', JSON.stringify(NO_FEE), paramHash, JSON.stringify(v2Report))

    const parsed = parseStoredBacktestReport(JSON.stringify(v2Report))
    expect(parsed?.schemaVersion).toBe(2)
    expect(parsed?.trust.reasons).toEqual(['LEGACY_REPORT'])
    expect(parsed?.totalReturn).toBeNull()
    expect(parsed?.equityCurve).toBeNull()
    expect(parsed?.maxDrawdown).toBeNull()
    expect(findRunByParamHash(db, paramHash, STRATEGY_BACKTEST_ENGINE_VERSION, factFingerprint)).toBeNull()
  })

  it('V3 报告保持历史版本可读但不会命中 V4 缓存', () => {
    const db = createDb()
    const factFingerprint = 'v3-facts'
    const paramHash = computeParamHash(
      'shortTerm.test',
      '20260101',
      '20260101',
      NO_FEE,
      'shortTerm',
      STRATEGY_BACKTEST_ENGINE_VERSION,
      factFingerprint,
      'current-quality'
    )
    const v3Report = {
      schemaVersion: 3,
      generatedAt: 1,
      trust: {
        status: 'reliable',
        reasons: [],
        engineVersion: '3.2.0',
        factFingerprint,
      },
      strategyKey: 'shortTerm.test',
      dateRange: { start: '20260101', end: '20260101' },
      plan: NO_FEE,
      totalSignals: 1,
      validTrades: 1,
    }
    db.prepare(
      `INSERT INTO strategy_backtest_runs
         (strategy_key, date_start, date_end, plan_json, param_hash, report_json, status, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'completed', 1, 1)`
    ).run('shortTerm.test', '20260101', '20260101', JSON.stringify(NO_FEE), paramHash, JSON.stringify(v3Report))

    const parsed = parseStoredBacktestReport(JSON.stringify(v3Report))
    expect(parsed?.schemaVersion).toBe(3)
    expect(parsed?.trust.reasons).toEqual(['LEGACY_REPORT'])
    expect(parsed?.trust.engineVersion).toBe('legacy')
    expect(findRunByParamHash(
      db,
      paramHash,
      STRATEGY_BACKTEST_ENGINE_VERSION,
      factFingerprint,
      'current-quality'
    )).toBeNull()
  })

  it('失败记录不会覆盖同一缓存键的最后成功结果', () => {
    const db = createDb()
    db.prepare(
      `INSERT INTO short_term_signals (strategy, ts_code, trade_date, signal_strength, created_at)
       VALUES ('shortTerm.test', '000001.SZ', '20260101', 1, 0)`
    ).run()
    const px = db.prepare(
      `INSERT INTO daily_close_cache (ts_code, trade_date, open, high, low, close) VALUES (?, ?, ?, ?, ?, ?)`
    )
    px.run('000001.SZ', '20260101', 9.9, 10, 9.8, 10)
    px.run('000001.SZ', '20260102', 10, 10.5, 9.9, 10.4)
    px.run('000001.SZ', '20260103', 10.4, 11, 10.3, 11)
    const success = runStrategyBacktest(db, {
      strategyKey: 'shortTerm.test',
      dateStart: '20260101',
      dateEnd: '20260101',
      plan: NO_FEE
    })
    const stored = db.prepare('SELECT param_hash, report_json FROM strategy_backtest_runs WHERE id = ?').get(success.runId) as {
      param_hash: string
      report_json: string
    }
    const failedRunId = markRunFailed(db, {
      strategyKey: 'shortTerm.test',
      signalSource: 'shortTerm',
      dateStart: '20260101',
      dateEnd: '20260101',
      plan: NO_FEE,
      paramHash: stored.param_hash,
      errorMessage: 'forced failure'
    })
    const after = db.prepare('SELECT status, report_json, error_message FROM strategy_backtest_runs WHERE id = ?').get(success.runId) as {
      status: string
      report_json: string
      error_message: string | null
    }
    const tradeCount = db.prepare('SELECT COUNT(*) AS count FROM strategy_backtest_trades WHERE run_id = ?').get(success.runId) as { count: number }
    expect(failedRunId).toBe(success.runId)
    expect(after.status).toBe('completed')
    expect(after.report_json).toBe(stored.report_json)
    expect(after.error_message).toBeNull()
    expect(tradeCount.count).toBe(1)
  })

  it('历史不足的信号计入剔除率并落库为 data_insufficient 明细', () => {
    const db = createDb()
    db.prepare(
      `INSERT INTO short_term_signals (strategy, ts_code, trade_date, signal_strength, created_at)
       VALUES ('shortTerm.test', '000002.SZ', '20260101', 3, 0)`
    ).run()
    db.prepare(
      `INSERT INTO daily_close_cache (ts_code, trade_date, open, high, low, close) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('000002.SZ', '20260101', 9.9, 10, 9.8, 10)

    const r = runStrategyBacktest(db, {
      strategyKey: 'shortTerm.test',
      dateStart: '20260101',
      dateEnd: '20260101',
      plan: NO_FEE
    })
    expect(r.report.totalSignals).toBe(1)
    expect(r.report.validTrades).toBe(0)
    expect(r.report.dropRate).toBe(1)

    const trade = db
      .prepare('SELECT status, entry_date, return_pct FROM strategy_backtest_trades WHERE run_id = ?')
      .get(r.runId) as { status: string; entry_date: string | null; return_pct: number | null }
    expect(trade.status).toBe('data_insufficient')
    expect(trade.entry_date).toBeNull()
    expect(trade.return_pct).toBeNull()
  })

  it('可从 trend_alerts 适配趋势预警信号并纳入 signalSource 缓存键', () => {
    const db = createDb()
    db.prepare(
      `INSERT INTO trend_alerts (ts_code, stock_name, alert_type, alert_date, price, ref_price, created_at)
       VALUES ('000001.SZ', '平安银行', 'BREAK_HIGH20', '20260101', 10, 9.8, 0)`
    ).run()
    const px = db.prepare(
      `INSERT INTO daily_close_cache (ts_code, trade_date, open, high, low, close) VALUES (?, ?, ?, ?, ?, ?)`
    )
    px.run('000001.SZ', '20260101', 9.9, 10, 9.8, 10)
    px.run('000001.SZ', '20260102', 10, 10.5, 9.9, 10.2)
    px.run('000001.SZ', '20260103', 10.2, 10.4, 10, 10.4)

    const signals = fromTrendAlerts(db, 'BREAK_HIGH20', '20260101', '20260101')
    expect(signals).toHaveLength(1)
    expect(signals[0].strength).toBe(1)

    const result = runStrategyBacktest(db, {
      signalSource: 'trendAlerts',
      strategyKey: 'BREAK_HIGH20',
      dateStart: '20260101',
      dateEnd: '20260101',
      plan: NO_FEE
    })
    expect(result.cached).toBe(false)
    expect(result.report.signalSource).toBe('trendAlerts')
    expect(result.report.validTrades).toBe(1)

    const again = runStrategyBacktest(db, {
      signalSource: 'trendAlerts',
      strategyKey: 'BREAK_HIGH20',
      dateStart: '20260101',
      dateEnd: '20260101',
      plan: NO_FEE
    })
    expect(again.cached).toBe(true)
    expect(again.runId).toBe(result.runId)
  })

  it('可从 decision_signals 适配股票级信号并归一强度', () => {
    const db = createDb()
    const signalTime = Date.UTC(2026, 0, 1, 2, 0, 0)
    db.prepare(
      `INSERT INTO decision_signals (
        source_module, strategy_key, ts_code, stock_name, signal_type, direction, priority, score, confidence,
        title, summary, reason_json, source_ref_json, status, dedup_key, signal_time, created_at, updated_at
       ) VALUES ('trend', 'decision.trend', '000001.SZ', '平安银行', 'trend_alert', 'bullish', 4, 80, 0.7,
        '趋势信号', '摘要', '{"a":1}', '{"b":2}', 'NEW', 'd1', ?, 0, 0)`
    ).run(signalTime)
    const px = db.prepare(
      `INSERT INTO daily_close_cache (ts_code, trade_date, open, high, low, close) VALUES (?, ?, ?, ?, ?, ?)`
    )
    px.run('000001.SZ', '20260101', 9.9, 10, 9.8, 10)
    px.run('000001.SZ', '20260102', 10, 10.5, 9.9, 10.5)
    px.run('000001.SZ', '20260103', 10.5, 10.7, 10.4, 10.6)

    const signals = fromDecisionSignals(db, 'decision.trend', '20260101', '20260101')
    expect(signals).toHaveLength(1)
    expect(signals[0].strength).toBeCloseTo(0.8, 6)

    const result = runStrategyBacktest(db, {
      signalSource: 'decisionSignals',
      strategyKey: 'decision.trend',
      dateStart: '20260101',
      dateEnd: '20260101',
      plan: NO_FEE
    })
    expect(result.report.signalSource).toBe('decisionSignals')
    expect(result.report.byStrengthDecile).toBeNull()
    expect(result.report.benchmarkReturn).not.toBeNull()
  })
})
