import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import {
  deleteStrategyLabStrategy,
  duplicateStrategyLabStrategy,
  ensureDefaultStrategyLabStrategies,
  createConditionBlocksDraft,
  createDefaultActions,
  createDefaultRunConfig,
  getStrategyLabStrategy,
  listStrategyLabStrategies,
  saveStrategyLabStrategy,
  setStrategyLabStrategyEnabled,
} from '../../electron/main/services/strategyLabService'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE strategy_lab_strategies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      enabled INTEGER NOT NULL DEFAULT 1,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      rule_draft_json TEXT NOT NULL,
      run_config_json TEXT NOT NULL,
      actions_json TEXT NOT NULL,
      last_run_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_strategy_lab_strategies_source ON strategy_lab_strategies(source);
    CREATE INDEX idx_strategy_lab_strategies_status ON strategy_lab_strategies(status, enabled);
  `)
  return db
}

describe('strategyLabService', () => {
  it('初始化三个内置策略模板', () => {
    const db = createDb()
    ensureDefaultStrategyLabStrategies(db)

    const strategies = listStrategyLabStrategies(db)
    expect(strategies.map(item => item.strategyKey).sort()).toEqual([
      'builtin-condition-blocks',
      'builtin-new-rule',
      'builtin-screener',
    ])
    expect(strategies.every(item => item.isBuiltin)).toBe(true)
    db.close()
  })

  it('保存用户草稿并支持启停', () => {
    const db = createDb()
    const saved = saveStrategyLabStrategy(db, {
      name: '测试策略',
      description: '测试说明',
      source: 'conditionBlocks',
      status: 'draft',
      enabled: true,
      ruleDraft: createConditionBlocksDraft(),
      runConfig: createDefaultRunConfig(),
      actions: createDefaultActions(),
    })

    expect(saved.strategyKey).not.toMatch(/^builtin-/)
    expect(saved.status).toBe('draft')
    expect(saved.ruleDraft.conditionBlocksProfile?.templateSnapshot?.root.children.length).toBeGreaterThan(0)
    expect(getStrategyLabStrategy(db, saved.id)?.ruleDraft.conditionBlocksProfile?.templateVersion).toBe(4)
    const disabled = setStrategyLabStrategyEnabled(db, saved.id, false)
    expect(disabled.enabled).toBe(false)
    expect(disabled.status).toBe('disabled')
    db.close()
  })

  it('复制策略生成用户草稿, 但不允许删除内置模板', () => {
    const db = createDb()
    ensureDefaultStrategyLabStrategies(db)
    const builtin = listStrategyLabStrategies(db).find(item => item.strategyKey === 'builtin-screener')
    expect(builtin).toBeTruthy()

    const copied = duplicateStrategyLabStrategy(db, builtin!.id, '复制策略')
    expect(copied.name).toBe('复制策略')
    expect(copied.isBuiltin).toBe(false)
    expect(copied.status).toBe('draft')

    expect(() => deleteStrategyLabStrategy(db, builtin!.id)).toThrow('BUILTIN_STRATEGY_CANNOT_DELETE')
    deleteStrategyLabStrategy(db, copied.id)
    expect(listStrategyLabStrategies(db).some(item => item.id === copied.id)).toBe(false)
    db.close()
  })

  it('拒绝覆盖内置策略和越界的条件参数', () => {
    const db = createDb()
    ensureDefaultStrategyLabStrategies(db)
    const builtin = listStrategyLabStrategies(db).find(item => item.strategyKey === 'builtin-condition-blocks')!
    const detail = getStrategyLabStrategy(db, builtin.id)!

    expect(() => saveStrategyLabStrategy(db, {
      id: builtin.id,
      name: detail.name,
      description: detail.description,
      source: detail.source,
      status: 'ready',
      enabled: true,
      ruleDraft: detail.ruleDraft,
      runConfig: detail.runConfig,
      actions: detail.actions,
    })).toThrow('BUILTIN_STRATEGY_READ_ONLY')

    const invalid = createConditionBlocksDraft()
    const snapshot = invalid.conditionBlocksProfile!.templateSnapshot!
    const gain = snapshot.root.children[0]
    if ('type' in gain) gain.params.minGainPct = 99
    expect(() => saveStrategyLabStrategy(db, {
      name: '越界参数策略',
      source: 'conditionBlocks',
      status: 'ready',
      ruleDraft: invalid,
      runConfig: createDefaultRunConfig(),
      actions: createDefaultActions(),
    })).toThrow('CONDITION_PARAM_TOO_LARGE')
    db.close()
  })

  it('编辑条件模板副本不会改写内置模板', () => {
    const db = createDb()
    ensureDefaultStrategyLabStrategies(db)
    const builtin = listStrategyLabStrategies(db).find(item => item.strategyKey === 'builtin-condition-blocks')!
    const copied = duplicateStrategyLabStrategy(db, builtin.id, '我的5%策略')
    const snapshot = copied.ruleDraft.conditionBlocksProfile!.templateSnapshot!
    const gain = snapshot.root.children[0]
    if ('type' in gain) gain.params.minGainPct = 5

    const saved = saveStrategyLabStrategy(db, {
      id: copied.id,
      name: copied.name,
      description: copied.description,
      source: 'conditionBlocks',
      status: 'ready',
      ruleDraft: copied.ruleDraft,
      runConfig: copied.runConfig,
      actions: copied.actions,
    })
    const builtinAfter = getStrategyLabStrategy(db, builtin.id)!
    const savedGain = saved.ruleDraft.conditionBlocksProfile!.templateSnapshot!.root.children[0]
    const builtinGain = builtinAfter.ruleDraft.conditionBlocksProfile!.templateSnapshot!.root.children[0]
    expect('type' in savedGain && savedGain.params.minGainPct).toBe(5)
    expect('type' in builtinGain && builtinGain.params.minGainPct).toBe(3)
    expect(saved.ruleDraft.conditionBlocksProfile?.templateVersion).toBeGreaterThanOrEqual(4)
    db.close()
  })

  it('手动股票池必须提供合法代码', () => {
    const db = createDb()
    const emptyManual = createConditionBlocksDraft()
    emptyManual.stockPool.sources = ['allMarket', 'manual']
    emptyManual.stockPool.manualTsCodes = []
    expect(() => saveStrategyLabStrategy(db, {
      name: '空手动股票池',
      source: 'conditionBlocks',
      status: 'draft',
      ruleDraft: emptyManual,
      runConfig: createDefaultRunConfig(),
      actions: createDefaultActions(),
    })).toThrow('MANUAL_STOCK_POOL_REQUIRED')

    const invalidManual = createConditionBlocksDraft()
    invalidManual.stockPool.sources = ['manual']
    invalidManual.stockPool.manualTsCodes = ['ABC']
    expect(() => saveStrategyLabStrategy(db, {
      name: '非法手动股票池',
      source: 'conditionBlocks',
      status: 'draft',
      ruleDraft: invalidManual,
      runConfig: createDefaultRunConfig(),
      actions: createDefaultActions(),
    })).toThrow('INVALID_STOCK_CODE')
    db.close()
  })
})
