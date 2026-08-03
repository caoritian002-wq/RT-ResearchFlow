import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { saveConditionTemplate } from '../../electron/main/database/conditionBlockRepository'
import { runConditionBlockScan } from '../../electron/main/services/conditionBlocks/blockScanEngine'
import type { BlockStrategyTemplate } from '../../electron/main/services/conditionBlocks/types'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE condition_block_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, template_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      description TEXT, version INTEGER NOT NULL, enabled INTEGER NOT NULL, template_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE condition_block_scan_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, template_id INTEGER NOT NULL, template_key TEXT NOT NULL,
      template_version INTEGER NOT NULL, date_start TEXT NOT NULL, date_end TEXT NOT NULL,
      scope_json TEXT NOT NULL, param_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
      error_message TEXT, total_stocks INTEGER NOT NULL DEFAULT 0, matched_count INTEGER NOT NULL DEFAULT 0,
      summary_json TEXT, created_at INTEGER NOT NULL, completed_at INTEGER
    );
    CREATE TABLE condition_block_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, template_key TEXT NOT NULL,
      template_version INTEGER NOT NULL, ts_code TEXT NOT NULL, stock_name TEXT, trade_date TEXT NOT NULL,
      window_start TEXT, window_end TEXT, total_score REAL NOT NULL, data_status TEXT NOT NULL,
      evidence_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(run_id, ts_code, trade_date, window_start, window_end)
    );
    CREATE TABLE daily_close_cache (ts_code TEXT NOT NULL, trade_date TEXT NOT NULL);
    CREATE TABLE stock_basic_cache (ts_code TEXT PRIMARY KEY, name TEXT, list_status TEXT);
    CREATE TABLE stock_info (stockCode TEXT PRIMARY KEY, stockName TEXT NOT NULL, fetchedAt INTEGER NOT NULL);
    CREATE TABLE stock_minute_cache (
      stock_code TEXT NOT NULL, trade_date TEXT NOT NULL, ts_minute TEXT NOT NULL,
      open REAL, high REAL, low REAL, close REAL, vol REAL, amount REAL
    );
    CREATE TABLE free_minute_cache (
      provider_id TEXT NOT NULL, ts_code TEXT NOT NULL, trade_date TEXT NOT NULL, granularity TEXT NOT NULL,
      ts_minute TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL NOT NULL, vol REAL, amount REAL,
      fetched_at INTEGER NOT NULL
    );
  `)
  db.prepare('INSERT INTO daily_close_cache (ts_code, trade_date) VALUES (?, ?)').run('000001.SZ', '20260720')
  db.prepare('INSERT INTO stock_info (stockCode, stockName, fetchedAt) VALUES (?, ?, ?)').run('000001', '平安银行', Date.now())
  const insertMinute = db.prepare('INSERT INTO stock_minute_cache (stock_code, trade_date, ts_minute, open, high, low, close, vol, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  insertMinute.run('000001.SZ', '20260720', '09:30', 10, 10, 10, 10, 10, 100)
  insertMinute.run('000001.SZ', '20260720', '09:31', 10.2, 10.2, 10.2, 10.2, 10, 100)
  insertMinute.run('000001.SZ', '20260720', '09:32', 10.5, 10.5, 10.5, 10.5, 10, 100)
  return db
}

function template(minGainPct: number, version = 1): BlockStrategyTemplate {
  return {
    key: 'snapshot-run-test',
    name: '快照运行测试',
    description: '验证运行时使用策略快照。',
    version,
    enabled: true,
    executionMode: 'strict',
    scoreThreshold: 70,
    scope: {
      dateStart: '20260720',
      dateEnd: '20260720',
      lookbackDays: 1,
      stockPoolSources: ['manual'],
      manualStocks: [{ tsCode: '000001.SZ', stockName: '平安银行' }],
      excludeST: true,
      excludeBJ: false,
      minDailyAmount: null,
      dailyPrefilterLimit: 10,
      autoFetchMinuteLimit: 0,
    },
    root: {
      id: 'root',
      operator: 'AND',
      enabled: true,
      children: [{
        id: 'gain',
        type: 'minute_window_gain',
        name: '窗口涨幅',
        description: '三分钟涨幅门槛。',
        enabled: true,
        weight: 100,
        hardRequired: true,
        params: { windowMinutes: 3, minGainPct },
      }],
    },
  }
}

describe('strategy lab condition snapshot run', () => {
  it('运行时规则快照会覆盖数据库模板阈值', async () => {
    const db = createDb()
    const saved = saveConditionTemplate(db, template(3))

    const storedResult = await runConditionBlockScan(db, saved.id, true)
    expect(storedResult.matchedCount).toBe(1)

    const snapshotResult = await runConditionBlockScan(db, saved.id, true, undefined, undefined, 'complete', 'free', undefined, template(6, 2))
    expect(snapshotResult.matchedCount).toBe(0)
    expect(snapshotResult.runId).not.toBe(storedResult.runId)
    db.close()
  })

  it('手动股票池只输入代码时从本地基础资料补齐公司名称', async () => {
    const db = createDb()
    const input = template(3)
    input.scope.manualStocks = [{ tsCode: '000001.SZ', stockName: null }]
    const saved = saveConditionTemplate(db, input)

    const result = await runConditionBlockScan(db, saved.id, true)
    const match = db.prepare('SELECT stock_name AS stockName FROM condition_block_matches WHERE run_id = ?').get(result.runId) as { stockName: string | null }

    expect(match.stockName).toBe('平安银行')
    db.close()
  })
})
