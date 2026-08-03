import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import {
  aggregateStrategyEffectiveness,
  evaluateStrategySignals,
  type StrategyEffectivenessCatalogItem,
  type StrategySignalObservation,
} from '../../electron/main/services/backtest/strategyEffectivenessService'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE stock_info (
      stockCode TEXT PRIMARY KEY,
      stockName TEXT NOT NULL,
      fetchedAt INTEGER NOT NULL
    );
    CREATE TABLE stock_basic_cache (
      ts_code TEXT PRIMARY KEY,
      name TEXT NOT NULL
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
    CREATE TABLE strategy_lab_strategies (
      id INTEGER PRIMARY KEY,
      strategy_key TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      version INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE strategy_lab_runs (
      id INTEGER PRIMARY KEY,
      strategy_id INTEGER NOT NULL,
      strategy_key TEXT NOT NULL,
      strategy_name TEXT NOT NULL,
      status TEXT NOT NULL,
      run_config_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE TABLE strategy_lab_matches (
      id INTEGER PRIMARY KEY,
      run_id INTEGER NOT NULL,
      strategy_id INTEGER NOT NULL,
      strategy_key TEXT NOT NULL,
      ts_code TEXT NOT NULL,
      stock_name TEXT,
      trade_date TEXT NOT NULL,
      score REAL,
      action_json TEXT,
      evidence_json TEXT
    );
    CREATE TABLE daily_close_cache (
      ts_code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      open REAL,
      close REAL NOT NULL,
      PRIMARY KEY (ts_code, trade_date)
    );
  `)
  return db
}

function horizons(value: number | null): StrategySignalObservation['returns'] {
  return { '1': value, '2': value, '3': value, '5': value }
}

function observation(input: Partial<StrategySignalObservation> & Pick<StrategySignalObservation, 'id' | 'strategyId' | 'signalDate' | 'tsCode'>): StrategySignalObservation {
  return {
    strategyLabel: input.strategyId,
    source: 'strategyLab',
    version: 'v1',
    stockName: null,
    direction: 'long',
    entryBasis: 'next_trade_open',
    entryDate: '20260102',
    entryPrice: 10,
    score: null,
    status: 'valid',
    missingReason: null,
    returns: horizons(0),
    benchmarkReturns: horizons(null),
    excessReturns: horizons(null),
    ...input,
  }
}

describe('strategyEffectivenessService', () => {
  it('聚合板票竞价池并默认排除一字涨停样本', () => {
    const db = createDb()
    db.prepare('INSERT INTO stock_info (stockCode, stockName, fetchedAt) VALUES (?, ?, 0)').run('000001', '平安银行')
    const insert = db.prepare(`
      INSERT INTO stk_auction_backtest_detail
        (trade_date, ts_code, pool, buy_price, ret_1d, ret_2d, ret_3d, ret_5d, computed_at, is_one_word,
         idx_ret1d, idx_ret2d, idx_ret3d, idx_ret5d)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insert.run('20260102', '000001.SZ', 'firstBoard', 10, 2, 3, 4, 5, 100, 0, 1, 1, 1, 1)
    insert.run('20260103', '600000.SH', 'secondBoard', 20, 9, 9, 9, 9, 101, 1, 1, 1, 1, 1)

    const result = evaluateStrategySignals(db, {
      dateStart: '20260101',
      dateEnd: '20260131',
      strategyIds: ['auction.threeOne'],
    })

    expect(result.rankings).toHaveLength(1)
    expect(result.rankings[0].signalCount).toBe(2)
    expect(result.rankings[0].metrics[0]).toMatchObject({ validCount: 1, avgReturn: 2, avgExcess: 1 })
    expect(result.coverage.excludedSignals).toBe(1)
    expect(result.credibility.gates).toHaveLength(5)
    expect(result.credibility.sample.totalSignals).toBe(result.coverage.totalSignals)
    expect(result.catalog.find(item => item.id === 'auction.threeOne')).toMatchObject({
      availableDateStart: '20260102',
      availableDateEnd: '20260103',
    })
    expect(result.observations.find(item => item.tsCode === '600000.SH')).toMatchObject({
      status: 'excluded',
      missingReason: 'ONE_WORD_LIMIT',
    })
  })

  it('策略实验室只消费最近完成运行并按下一交易日开盘计算四周期收益', () => {
    const db = createDb()
    db.prepare('INSERT INTO strategy_lab_strategies (id, strategy_key, name, description, version) VALUES (1, ?, ?, ?, 3)')
      .run('custom-alpha', '自定义强势策略', '测试策略')
    const insertRun = db.prepare(`
      INSERT INTO strategy_lab_runs
        (id, strategy_id, strategy_key, strategy_name, status, run_config_json, created_at, completed_at)
      VALUES (?, 1, 'custom-alpha', '自定义强势策略', 'completed', ?, ?, ?)
    `)
    insertRun.run(1, JSON.stringify({ strategyVersion: 1 }), 10, 10)
    insertRun.run(2, JSON.stringify({ strategyVersion: 2 }), 20, 20)
    const insertMatch = db.prepare(`
      INSERT INTO strategy_lab_matches
        (id, run_id, strategy_id, strategy_key, ts_code, stock_name, trade_date, score, action_json, evidence_json)
      VALUES (?, ?, 1, 'custom-alpha', ?, ?, ?, ?, '{}', '{}')
    `)
    insertMatch.run(1, 1, '000002.SZ', '万科A', '20260101', 60)
    insertMatch.run(2, 2, '000001.SZ', null, '20260101', 88)
    insertMatch.run(3, 2, '000001.SZ', null, '20260101', 70)
    db.prepare('INSERT INTO stock_basic_cache (ts_code, name) VALUES (?, ?)').run('000001.SZ', '平安银行')

    const insertPrice = db.prepare('INSERT INTO daily_close_cache (ts_code, trade_date, open, close) VALUES (?, ?, ?, ?)')
    const stockRows = [
      ['20260102', 10, 11],
      ['20260105', 11, 12],
      ['20260106', 12, 9],
      ['20260107', 9, 13],
      ['20260108', 13, 15],
    ] as const
    const indexRows = [
      ['20260102', 100, 101],
      ['20260105', 101, 102],
      ['20260106', 102, 103],
      ['20260107', 103, 104],
      ['20260108', 104, 105],
    ] as const
    for (const row of stockRows) insertPrice.run('000001.SZ', ...row)
    for (const row of indexRows) insertPrice.run('399001.SZ', ...row)

    const result = evaluateStrategySignals(db, {
      dateStart: '20260101',
      dateEnd: '20260131',
      strategyIds: ['strategyLab.custom-alpha'],
    })

    expect(result.observations).toHaveLength(1)
    expect(result.observations[0]).toMatchObject({
      version: 'v2 · 运行 #2',
      tsCode: '000001.SZ',
      stockName: '平安银行',
      entryDate: '20260102',
      entryPrice: 10,
      returns: { '1': 10, '2': 20, '3': -10, '5': 50 },
      status: 'valid',
    })
    expect(result.observations.some(item => item.tsCode === '000002.SZ')).toBe(false)
    expect(result.rankings[0].metrics.find(item => item.horizon === 5)?.avgExcess).toBe(45)
    expect(result.catalog.find(item => item.id === 'strategyLab.custom-alpha')).toMatchObject({
      availableDateStart: '20260101',
      availableDateEnd: '20260101',
    })
  })

  it('已登记但没有完成运行的策略保留在目录并明确不可评估', () => {
    const db = createDb()
    db.prepare('INSERT INTO strategy_lab_strategies (id, strategy_key, name, description, version) VALUES (1, ?, ?, NULL, 4)')
      .run('waiting', '尚未运行策略')

    const result = evaluateStrategySignals(db, { dateStart: '20260101', dateEnd: '20260131' })
    expect(result.catalog.find(item => item.id === 'strategyLab.waiting')).toMatchObject({
      available: false,
      version: 'v4 · 尚未运行',
      unavailableReason: '尚无完成运行，请先在策略实验室运行该策略',
    })
  })

  it('当前筛选无信号时返回所选策略的本地可用日期范围', () => {
    const db = createDb()
    db.prepare(`
      INSERT INTO stk_auction_backtest_detail
        (trade_date, ts_code, pool, buy_price, ret_1d, ret_2d, ret_3d, ret_5d, computed_at, is_one_word)
      VALUES ('20260102', '000001.SZ', 'firstBoard', 10, 1, 2, 3, 5, 100, 0)
    `).run()

    const result = evaluateStrategySignals(db, {
      dateStart: '20260201',
      dateEnd: '20260228',
      strategyIds: ['auction.threeOne'],
    })

    expect(result.coverage.totalSignals).toBe(0)
    expect(result.coverage.note).toContain('板票竞价双第一 20260102-20260102')
  })

  it('看空方向反转收益成功判断并保留原始信号方向', () => {
    const db = createDb()
    db.prepare('INSERT INTO strategy_lab_strategies (id, strategy_key, name, description, version) VALUES (1, ?, ?, NULL, 1)')
      .run('bearish', '风险转弱策略')
    db.prepare(`
      INSERT INTO strategy_lab_runs
        (id, strategy_id, strategy_key, strategy_name, status, run_config_json, created_at, completed_at)
      VALUES (1, 1, 'bearish', '风险转弱策略', 'completed', '{}', 1, 1)
    `).run()
    db.prepare(`
      INSERT INTO strategy_lab_matches
        (id, run_id, strategy_id, strategy_key, ts_code, stock_name, trade_date, score, action_json, evidence_json)
      VALUES (1, 1, 1, 'bearish', '000001.SZ', '平安银行', '20260101', 80, '{}', '{"direction":"short"}')
    `).run()
    const insertPrice = db.prepare('INSERT INTO daily_close_cache (ts_code, trade_date, open, close) VALUES (?, ?, ?, ?)')
    for (const [date, close] of [['20260102', 9], ['20260105', 8], ['20260106', 7], ['20260107', 6], ['20260108', 5]] as const) {
      insertPrice.run('000001.SZ', date, 10, close)
      insertPrice.run('399001.SZ', date, 100, 100)
    }

    const result = evaluateStrategySignals(db, {
      dateStart: '20260101',
      dateEnd: '20260131',
      strategyIds: ['strategyLab.bearish'],
    })

    expect(result.observations[0]).toMatchObject({ direction: 'short', returns: { '1': 10, '5': 50 } })
    expect(result.rankings[0].direction).toBe('short')
    expect(result.rankings[0].metrics[0].winRate).toBe(1)
  })

  it('同时计算按信号与按信号日等权，并计算跨策略重合率', () => {
    const catalog: StrategyEffectivenessCatalogItem[] = ['alpha', 'beta'].map(id => ({
      id,
      label: id,
      description: id,
      source: 'strategyLab',
      direction: 'long',
      version: 'v1',
      entryBasis: 'next_trade_open',
      latestRunAt: 1,
      availableDateStart: '20260101',
      availableDateEnd: '20260103',
      available: true,
      unavailableReason: null,
    }))
    const observations = [
      observation({ id: 'a1', strategyId: 'alpha', signalDate: '20260101', tsCode: '000001.SZ', returns: horizons(10) }),
      observation({ id: 'a2', strategyId: 'alpha', signalDate: '20260101', tsCode: '000002.SZ', returns: horizons(10) }),
      observation({ id: 'a3', strategyId: 'alpha', signalDate: '20260102', tsCode: '000003.SZ', returns: horizons(-10) }),
      observation({ id: 'b1', strategyId: 'beta', signalDate: '20260101', tsCode: '000001.SZ', returns: horizons(5) }),
      observation({ id: 'b2', strategyId: 'beta', signalDate: '20260103', tsCode: '000004.SZ', returns: horizons(5) }),
    ]

    const result = aggregateStrategyEffectiveness(catalog, ['alpha', 'beta'], observations)
    const alpha = result.rankings[0].metrics[0]
    expect(alpha.avgReturn).toBeCloseTo(3.333333, 6)
    expect(alpha.dateWeightedReturn).toBe(0)
    expect(alpha.p25).toBe(0)
    expect(alpha.p75).toBe(10)
    expect(result.overlaps[0]).toEqual({
      leftStrategyId: 'alpha',
      rightStrategyId: 'beta',
      intersectionCount: 1,
      unionCount: 4,
      overlapRate: 0.25,
    })
  })
})
