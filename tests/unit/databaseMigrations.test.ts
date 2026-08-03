import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import {
  DEFAULT_ARTICLE_ANALYSIS_PROMPT,
  LEGACY_DEFAULT_ARTICLE_ANALYSIS_PROMPT,
} from '../../electron/main/aiPromptDefaults'
import {
  saveResearchCompany,
  saveResearchProjectCompany,
  saveResearchSecurity,
} from '../../electron/main/database/industryResearchFinancialRepository'
import { createResearchProject } from '../../electron/main/database/industryResearchRepository'

function tableExists(db: Database.Database, tableName: string): boolean {
  return db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(tableName) !== undefined
}

function getAppliedVersions(db: Database.Database): number[] {
  return (db.prepare(
    'SELECT version FROM schema_migrations ORDER BY version'
  ).all() as Array<{ version: number }>).map((row) => row.version)
}

describe('数据库 Migration 执行器', () => {
  it('完整迁移链创建并登记历史日线维护与产业研究事实表', () => {
    const db = new Database(':memory:')

    try {
      runMigrations(db)

      expect(tableExists(db, 'daily_close_maintenance_state')).toBe(true)
      expect(tableExists(db, 'industry_research_projects')).toBe(true)
      expect(tableExists(db, 'industry_research_nodes')).toBe(true)
      expect(tableExists(db, 'industry_research_edges')).toBe(true)
      expect(tableExists(db, 'industry_research_evidence')).toBe(true)
      expect(tableExists(db, 'industry_research_hypotheses')).toBe(true)
      expect(tableExists(db, 'industry_research_hypothesis_events')).toBe(true)
      expect(tableExists(db, 'industry_research_companies')).toBe(true)
      expect(tableExists(db, 'industry_research_securities')).toBe(true)
      expect(tableExists(db, 'industry_research_disclosure_evidence')).toBe(true)
      expect(tableExists(db, 'industry_research_main_business_items')).toBe(true)
      expect(tableExists(db, 'industry_research_business_exposures')).toBe(true)
      expect(tableExists(db, 'industry_research_financial_facts')).toBe(true)
      expect(tableExists(db, 'industry_research_financial_sync_state')).toBe(true)
      expect(tableExists(db, 'industry_research_skill_snapshots')).toBe(true)
      expect(tableExists(db, 'industry_research_decision_events')).toBe(true)
      expect(tableExists(db, 'industry_research_monitoring_observations')).toBe(true)
      expect(tableExists(db, 'industry_research_review_events')).toBe(true)
      expect(tableExists(db, 'security_adjustment_factor_cache')).toBe(true)
      expect(tableExists(db, 'security_valuation_daily_cache')).toBe(true)
      expect(tableExists(db, 'industry_research_market_sync_runs')).toBe(true)
      expect(tableExists(db, 'industry_research_market_snapshots')).toBe(true)
      expect(tableExists(db, 'industry_research_valuation_snapshots')).toBe(true)
      expect(tableExists(db, 'sector_flow_observations')).toBe(true)
      expect(tableExists(db, 'data_quality_runs')).toBe(true)
      expect(tableExists(db, 'ai_evaluation_runs')).toBe(true)
      expect(tableExists(db, 'ai_evaluation_case_results')).toBe(true)
      expect(tableExists(db, 'premarket_outcome_validations')).toBe(true)
      expect(tableExists(db, 'premarket_notification_deliveries')).toBe(true)
      expect(tableExists(db, 'premarket_ai_explanations')).toBe(true)
      expect(tableExists(db, 'premarket_preparation_snapshots')).toBe(true)
      expect(getAppliedVersions(db)).toContain(98)
      expect(getAppliedVersions(db)).toContain(99)
      expect(getAppliedVersions(db)).toContain(100)
      expect(getAppliedVersions(db)).toContain(108)
      expect(getAppliedVersions(db)).toContain(109)
      expect(getAppliedVersions(db)).toContain(110)
      expect(getAppliedVersions(db)).toContain(111)
      expect(getAppliedVersions(db)).toContain(112)
      expect(getAppliedVersions(db)).toContain(113)
      expect(getAppliedVersions(db)).toContain(114)
      expect(getAppliedVersions(db)).toContain(128)
      expect(getAppliedVersions(db)).toContain(129)
      expect(getAppliedVersions(db)).toContain(131)
      expect(getAppliedVersions(db)).toContain(132)
      const appSettingsColumns = db.prepare('PRAGMA table_info(app_settings)').all() as Array<{
        name: string
      }>
      expect(appSettingsColumns.map((column) => column.name)).toContain('decision_center_filters_json')
      expect(appSettingsColumns.map((column) => column.name)).toContain('premarket_network_enabled')
      const premarketFactColumns = db.prepare('PRAGMA table_info(premarket_fact_snapshots)').all() as Array<{
        name: string
      }>
      expect(premarketFactColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'previous_revision_id', 'revision', 'revision_kind', 'requested_at',
      ]))
      const scenarioForeignKeys = db.prepare('PRAGMA foreign_key_list(premarket_scenario_versions)').all() as Array<{
        table: string
        from: string
      }>
      expect(scenarioForeignKeys).toEqual(expect.arrayContaining([
        expect.objectContaining({ table: 'premarket_fact_snapshots', from: 'base_fact_snapshot_id' }),
      ]))
      const columns = db.prepare('PRAGMA table_info(daily_close_maintenance_state)').all() as Array<{
        name: string
      }>
      expect(columns.map((column) => column.name)).toEqual([
        'id',
        'status',
        'started_at',
        'completed_at',
        'retain_trade_days',
        'removed_rows',
        'remaining_trade_days',
        'message',
      ])
      const researchProjectColumns = db.prepare(
        'PRAGMA table_info(industry_research_projects)'
      ).all() as Array<{ name: string }>
      expect(researchProjectColumns.map((column) => column.name)).toContain('skill_content_hash')
      expect(researchProjectColumns.map((column) => column.name)).toContain('graph_updated_at')
      const financialFactColumns = db.prepare(
        'PRAGMA table_info(industry_research_financial_facts)'
      ).all() as Array<{ name: string }>
      expect(financialFactColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'source_fact_key',
        'source_version',
        'ann_date',
        'f_ann_date',
        'statement_type',
        'update_flag',
        'input_versions_json',
        'derivation_status',
      ]))
      const scenarioVersionColumns = db.prepare(
        'PRAGMA table_info(industry_research_scenario_set_versions)'
      ).all() as Array<{ name: string }>
      expect(scenarioVersionColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'valuation_method',
        'methodology_version',
      ]))
      const scenarioColumns = db.prepare(
        'PRAGMA table_info(industry_research_scenarios)'
      ).all() as Array<{ name: string }>
      expect(scenarioColumns.map((column) => column.name)).toContain('valuation_inputs_json')
      const premarketScenarioColumns = db.prepare(
        'PRAGMA table_info(premarket_scenario_versions)'
      ).all() as Array<{ name: string }>
      expect(premarketScenarioColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'previous_revision_id',
        'revision',
        'revision_kind',
        'requested_at',
        'fact_cutoff_at',
      ]))
      for (const table of [
        'premarket_outcome_validations',
        'premarket_notification_deliveries',
        'premarket_ai_explanations',
      ]) {
        const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string }>
        expect(foreignKeys.map((item) => item.table)).toContain('premarket_scenario_versions')
      }
      const decisionEventColumns = db.prepare(
        'PRAGMA table_info(industry_research_decision_events)'
      ).all() as Array<{ name: string }>
      expect(decisionEventColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'market_snapshot_id',
        'valuation_snapshot_id',
      ]))
    } finally {
      db.close()
    }
  })

  it('Migration 110只升级旧系统默认提示词并保留用户自定义值', () => {
    const db = new Database(':memory:')
    const through109 = DATABASE_MIGRATIONS.filter((migration) => migration.version <= 109)
    const migration110 = DATABASE_MIGRATIONS.filter((migration) => migration.version === 110)

    try {
      runMigrations(db, through109)
      db.prepare('UPDATE ai_config SET presetPrompt = ? WHERE id = 1')
        .run(LEGACY_DEFAULT_ARTICLE_ANALYSIS_PROMPT)
      db.prepare(`
        INSERT OR REPLACE INTO provider_configs (provider, apiKeyEncrypted, presetPrompt)
        VALUES ('chatgpt', X'', ?), ('qwen', X'', '我的自定义提示词'), ('deepseek', X'', NULL)
      `).run(LEGACY_DEFAULT_ARTICLE_ANALYSIS_PROMPT)

      runMigrations(db, migration110)

      expect(db.prepare('SELECT presetPrompt FROM ai_config WHERE id = 1').get())
        .toEqual({ presetPrompt: DEFAULT_ARTICLE_ANALYSIS_PROMPT })
      expect(db.prepare(`
        SELECT provider, presetPrompt FROM provider_configs
        WHERE provider IN ('chatgpt', 'qwen', 'deepseek') ORDER BY provider
      `).all()).toEqual([
        { provider: 'chatgpt', presetPrompt: DEFAULT_ARTICLE_ANALYSIS_PROMPT },
        { provider: 'deepseek', presetPrompt: null },
        { provider: 'qwen', presetPrompt: '我的自定义提示词' },
      ])
      expect(getAppliedVersions(db)).toContain(110)
    } finally {
      db.close()
    }
  })

  it('Migration 112只过期仍在活动中的旧板块净流入信号', () => {
    const db = new Database(':memory:')
    const through111 = DATABASE_MIGRATIONS.filter((migration) => migration.version <= 111)
    const migration112 = DATABASE_MIGRATIONS.filter((migration) => migration.version === 112)

    try {
      runMigrations(db, through111)
      const insertSignal = db.prepare(`
        INSERT INTO decision_signals (
          source_module, strategy_key, signal_type, direction, priority,
          title, summary, status, dedup_key, signal_time, created_at, updated_at
        ) VALUES ('sector_flow', ?, 'INFO', 'NEUTRAL', 3, ?, '迁移测试', ?, ?, 100, 100, 100)
      `)
      insertSignal.run('sectorFlow.netInflowTop', '旧信号 NEW', 'NEW', 'legacy-new')
      insertSignal.run('sectorFlow.netInflowTop', '旧信号 WATCHING', 'WATCHING', 'legacy-watching')
      insertSignal.run('sectorFlow.netInflowTop', '旧信号 DISMISSED', 'DISMISSED', 'legacy-dismissed')
      insertSignal.run('sectorFlow.auctionWatch', '新竞价观察', 'WATCHING', 'auction-watching')

      runMigrations(db, migration112)

      expect(db.prepare(`
        SELECT dedup_key, status FROM decision_signals ORDER BY dedup_key
      `).all()).toEqual([
        { dedup_key: 'auction-watching', status: 'WATCHING' },
        { dedup_key: 'legacy-dismissed', status: 'DISMISSED' },
        { dedup_key: 'legacy-new', status: 'EXPIRED' },
        { dedup_key: 'legacy-watching', status: 'EXPIRED' },
      ])
      expect(tableExists(db, 'sector_flow_observations')).toBe(true)
      expect(getAppliedVersions(db)).toContain(112)
    } finally {
      db.close()
    }
  })

  it('Migration 108升级到109保留旧情景并保护市场与估值快照不可变', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    const through108 = DATABASE_MIGRATIONS.filter((migration) => migration.version <= 108)
    const migration109 = DATABASE_MIGRATIONS.filter((migration) => migration.version === 109)

    try {
      runMigrations(db, through108)
      createResearchProject(db, {
        id: 'market-upgrade-project', title: '市场升级研究', industryName: '光通信', productScope: '光模块',
        regionScope: '中国', timeScope: '2026', purpose: 'investment', depth: 'standard', sourceType: 'manual',
        skillId: 'builtin:industry-chain-research', skillContentHash: 'a'.repeat(64), skillRuleVersion: 'v1',
      })
      saveResearchCompany(db, { id: 'market-company', legalName: '示例光通信股份有限公司', sourceType: 'manual' }, 10)
      saveResearchSecurity(db, {
        id: 'market-security', companyId: 'market-company', tsCode: '600001.SH', exchange: 'SSE',
        securityType: 'A_SHARE', mappingSource: 'manual',
      }, 11)
      saveResearchProjectCompany(db, {
        projectId: 'market-upgrade-project', companyId: 'market-company', status: 'core',
      }, 12)
      db.prepare(`
        INSERT INTO industry_research_scenario_set_versions (
          id, scenario_set_id, project_id, company_id, version, previous_version_id,
          request_id, data_as_of, valuation_date, created_at
        ) VALUES ('scenario-v1', 'scenario-set', 'market-upgrade-project', 'market-company', 1, NULL,
          'scenario-request', '2026-07-16', '2026-07-17', 20)
      `).run()
      db.prepare(`
        INSERT INTO industry_research_scenarios (
          id, scenario_set_version_id, name, weight_pct, assumptions_json, fact_ids_json
        ) VALUES ('scenario-base', 'scenario-v1', 'base', NULL, '{}', '[]')
      `).run()

      runMigrations(db, migration109)

      expect(db.prepare(`
        SELECT valuation_method, methodology_version FROM industry_research_scenario_set_versions WHERE id = 'scenario-v1'
      `).get()).toEqual({ valuation_method: null, methodology_version: null })
      expect(db.prepare(`
        SELECT valuation_inputs_json FROM industry_research_scenarios WHERE id = 'scenario-base'
      `).get()).toEqual({ valuation_inputs_json: '{}' })

      db.prepare(`
        INSERT INTO industry_research_market_snapshots (
          id, request_id, project_id, company_id, security_id, ts_code, requested_valuation_date,
          market_date, benchmark_code, benchmark_name, raw_close, status, reason_json,
          market_data_json, fact_fingerprint, methodology_version, created_at
        ) VALUES ('market-snapshot', 'market-request', 'market-upgrade-project', 'market-company',
          'market-security', '600001.SH', '2026-07-17', '20260717', '000001.SH', '上证指数',
          10, 'ok', '[]', '{}', ?, 'market-context-v1', 30)
      `).run('b'.repeat(64))
      db.prepare(`
        INSERT INTO industry_research_valuation_snapshots (
          id, request_id, project_id, company_id, scenario_set_version_id, market_snapshot_id,
          valuation_method, status, input_json, output_json, fact_ids_json, formula_version, created_at
        ) VALUES ('valuation-snapshot', 'valuation-request', 'market-upgrade-project', 'market-company',
          'scenario-v1', 'market-snapshot', 'pe', 'ok', '{}', '{}', '[]', 'valuation-formulas-v1', 31)
      `).run()

      expect(() => db.prepare("UPDATE industry_research_market_snapshots SET raw_close = 11 WHERE id = 'market-snapshot'").run())
        .toThrow('INDUSTRY_RESEARCH_FACT_IMMUTABLE')
      expect(() => db.prepare("DELETE FROM industry_research_valuation_snapshots WHERE id = 'valuation-snapshot'").run())
        .toThrow('INDUSTRY_RESEARCH_FACT_IMMUTABLE')
      expect(getAppliedVersions(db)).toContain(109)
    } finally {
      db.close()
    }
  })

  it('Migration 107研究版本升级到108后保持来源、内容与不可变保护', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    const through107 = DATABASE_MIGRATIONS.filter((migration) => migration.version <= 107)
    const migration108 = DATABASE_MIGRATIONS.filter((migration) => migration.version === 108)

    try {
      runMigrations(db, through107)
      createResearchProject(db, {
        id: 'upgrade-project', title: '升级研究', industryName: '光通信', productScope: '光模块',
        regionScope: '中国', timeScope: '2026', purpose: 'investment', depth: 'standard', sourceType: 'manual',
        skillId: 'builtin:industry-chain-research', skillContentHash: 'a'.repeat(64), skillRuleVersion: 'v1',
      })
      db.prepare(`
        INSERT INTO industry_research_candidate_batches (
          id, request_id, idempotency_key, source_type, source_session_id, project_id,
          base_snapshot_id, message_start_index, message_end_index, context_hash, provider,
          model, rule_version, status, change_set_count, candidate_count, conflict_count,
          degraded_reasons_json, archive_meta_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'archive', NULL, ?, NULL, NULL, NULL, ?, NULL, NULL, ?, 'resolved', 1, 1, 0, '[]', NULL, ?, ?)
      `).run('upgrade-batch', 'upgrade-request', 'upgrade-key', 'upgrade-project', 'context-hash', 'v1', 10, 10)
      db.prepare(`
        INSERT INTO industry_research_snapshots (
          id, project_id, previous_snapshot_id, trigger_batch_id, source_session_id,
          source_origin_type, source_origin_id, source_return_target_json, schema_version,
          graph_updated_at, title, accepted_change_set_count, snapshot_json, created_at
        ) VALUES (?, ?, NULL, ?, NULL, 'archive', 'archive-1', NULL, 1, ?, '历史版本', 1, ?, ?)
      `).run('snapshot-v107', 'upgrade-project', 'upgrade-batch', 10, '{"schemaVersion":1,"legacy":true}', 10)
      db.prepare(`
        INSERT INTO industry_research_snapshots (
          id, project_id, previous_snapshot_id, trigger_batch_id, source_session_id,
          source_origin_type, source_origin_id, source_return_target_json, schema_version,
          graph_updated_at, title, accepted_change_set_count, snapshot_json, created_at
        ) VALUES (?, ?, ?, ?, NULL, 'archive', 'archive-2', NULL, 1, ?, '历史版本2', 1, ?, ?)
      `).run(
        'snapshot-v107-2', 'upgrade-project', 'snapshot-v107', 'upgrade-batch',
        11, '{"schemaVersion":1,"legacy":true,"version":2}', 11,
      )

      runMigrations(db, migration108)

      expect(db.prepare(`
        SELECT id, snapshot_reason, trigger_batch_id, skill_snapshot_id, accepted_change_set_count, snapshot_json
        FROM industry_research_snapshots WHERE id = 'snapshot-v107'
      `).get()).toEqual({
        id: 'snapshot-v107', snapshot_reason: 'archive_import', trigger_batch_id: 'upgrade-batch',
        skill_snapshot_id: null, accepted_change_set_count: 1, snapshot_json: '{"schemaVersion":1,"legacy":true}',
      })
      expect(db.prepare('SELECT previous_snapshot_id FROM industry_research_snapshots WHERE id = ?').get('snapshot-v107-2'))
        .toEqual({ previous_snapshot_id: 'snapshot-v107' })
      expect(() => db.prepare("UPDATE industry_research_snapshots SET title = 'changed' WHERE id = 'snapshot-v107'").run())
        .toThrow('INDUSTRY_RESEARCH_SNAPSHOT_IMMUTABLE')
      expect(() => db.prepare("DELETE FROM industry_research_snapshots WHERE id = 'snapshot-v107'").run())
        .toThrow('INDUSTRY_RESEARCH_SNAPSHOT_IMMUTABLE')
    } finally {
      db.close()
    }
  })

  it('版本登记失败时回滚同一 Migration 的结构变更', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        appliedAt INTEGER NOT NULL
      );
      CREATE TRIGGER fail_migration_record
      BEFORE INSERT ON schema_migrations
      BEGIN
        SELECT RAISE(ABORT, 'injected registration failure');
      END;
    `)

    try {
      expect(() => runMigrations(db, [{
        version: 101,
        sql: 'CREATE TABLE migration_probe (id INTEGER PRIMARY KEY);',
      }])).toThrow('Migration #101 执行失败：injected registration failure')

      const appliedCount = db.prepare(
        'SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 101'
      ).get() as { count: number }

      expect(tableExists(db, 'migration_probe')).toBe(false)
      expect(appliedCount.count).toBe(0)
    } finally {
      db.close()
    }
  })

  it('SQL 中途失败时不残留结构、数据或版本记录', () => {
    const db = new Database(':memory:')

    try {
      expect(() => runMigrations(db, [{
        version: 102,
        sql: `
          CREATE TABLE migration_partial (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO migration_partial (id, value) VALUES (1, 'partial');
          INSERT INTO missing_table (id) VALUES (1);
        `,
      }])).toThrow('Migration #102 执行失败：no such table: missing_table')

      expect(tableExists(db, 'migration_partial')).toBe(false)
      expect(getAppliedVersions(db)).toEqual([])
    } finally {
      db.close()
    }
  })

  it('后一版本失败时保留此前已经提交的版本', () => {
    const db = new Database(':memory:')

    try {
      expect(() => runMigrations(db, [
        {
          version: 201,
          sql: 'CREATE TABLE migration_v201 (id INTEGER PRIMARY KEY);',
        },
        {
          version: 202,
          sql: `
            CREATE TABLE migration_v202 (id INTEGER PRIMARY KEY);
            INSERT INTO missing_table (id) VALUES (1);
          `,
        },
      ])).toThrow('Migration #202 执行失败：no such table: missing_table')

      expect(tableExists(db, 'migration_v201')).toBe(true)
      expect(tableExists(db, 'migration_v202')).toBe(false)
      expect(getAppliedVersions(db)).toEqual([201])
    } finally {
      db.close()
    }
  })

  it('故障修复后从失败版本继续且不重复执行已登记版本', () => {
    const db = new Database(':memory:')
    const firstVersion = {
      version: 301,
      sql: `
        CREATE TABLE migration_v301 (id INTEGER PRIMARY KEY);
        INSERT INTO migration_v301 (id) VALUES (1);
      `,
    }
    const brokenVersion = {
      version: 302,
      sql: `
        CREATE TABLE migration_v302 (id INTEGER PRIMARY KEY);
        INSERT INTO missing_table (id) VALUES (1);
      `,
    }
    const repairedVersion = {
      version: 302,
      sql: `
        CREATE TABLE migration_v302 (id INTEGER PRIMARY KEY);
        INSERT INTO migration_v302 (id) VALUES (1);
      `,
    }

    try {
      expect(() => runMigrations(db, [firstVersion, brokenVersion])).toThrow('Migration #302')

      expect(() => runMigrations(db, [firstVersion, repairedVersion])).not.toThrow()
      expect(() => runMigrations(db, [firstVersion, repairedVersion])).not.toThrow()

      const firstVersionRows = db.prepare(
        'SELECT COUNT(*) AS count FROM migration_v301'
      ).get() as { count: number }
      const repairedVersionRows = db.prepare(
        'SELECT COUNT(*) AS count FROM migration_v302'
      ).get() as { count: number }

      expect(firstVersionRows.count).toBe(1)
      expect(repairedVersionRows.count).toBe(1)
      expect(getAppliedVersions(db)).toEqual([301, 302])
    } finally {
      db.close()
    }
  })

  it('Migration 115 清理重复事件并修正旧默认有效期', () => {
    const db = new Database(':memory:')
    const migration115 = DATABASE_MIGRATIONS.filter((migration) => migration.version === 115)
    const signalTime = Date.parse('2026-07-24T10:00:00+08:00')
    db.exec(`
      CREATE TABLE decision_signals (
        id INTEGER PRIMARY KEY,
        source_module TEXT NOT NULL,
        signal_time INTEGER NOT NULL,
        expire_at INTEGER,
        occurrence_count INTEGER NOT NULL
      );
      CREATE TABLE decision_signal_events (
        id INTEGER PRIMARY KEY,
        event_type TEXT NOT NULL
      );
    `)
    const insert = db.prepare('INSERT INTO decision_signals VALUES (?, ?, ?, ?, ?)')
    insert.run(1, 'short_term', signalTime, signalTime + 24 * 60 * 60 * 1000, 10488)
    insert.run(2, 'trend', signalTime, signalTime + 24 * 60 * 60 * 1000, 20)
    insert.run(3, 'ai', signalTime, signalTime + 24 * 60 * 60 * 1000, 9)
    db.prepare("INSERT INTO decision_signal_events VALUES (1, 'CREATED'), (2, 'UPDATED'), (3, 'WATCHED')").run()

    try {
      runMigrations(db, migration115)
      expect(db.prepare('SELECT id, occurrence_count, expire_at FROM decision_signals ORDER BY id').all()).toEqual([
        { id: 1, occurrence_count: 1, expire_at: Date.parse('2026-07-24T15:30:00+08:00') },
        { id: 2, occurrence_count: 1, expire_at: signalTime + 7 * 24 * 60 * 60 * 1000 },
        { id: 3, occurrence_count: 1, expire_at: signalTime + 3 * 24 * 60 * 60 * 1000 },
      ])
      expect(db.prepare('SELECT event_type FROM decision_signal_events ORDER BY id').all()).toEqual([
        { event_type: 'CREATED' },
        { event_type: 'WATCHED' },
      ])
    } finally {
      db.close()
    }
  })

  it('Migration 116 分离待校时资讯、恢复URL日期并清理同源精确重复', () => {
    const db = new Database(':memory:')
    const migration116 = DATABASE_MIGRATIONS.filter((migration) => migration.version === 116)
    const collectedAt = Date.parse('2026-07-21T10:00:00+08:00')
    db.exec(`
      CREATE TABLE briefings (
        id INTEGER PRIMARY KEY,
        sourceId INTEGER NOT NULL,
        originalUrl TEXT NOT NULL,
        title TEXT NOT NULL,
        publishedAt INTEGER NOT NULL,
        publishedDateBJ TEXT NOT NULL,
        collectedAt INTEGER NOT NULL,
        impactRating TEXT NOT NULL,
        isRead INTEGER NOT NULL
      );
      CREATE TABLE ai_analysis_sessions (
        id INTEGER PRIMARY KEY,
        briefingId INTEGER
      );
      CREATE TABLE daily_archive (
        date TEXT PRIMARY KEY,
        totalCount INTEGER NOT NULL,
        unreadCount INTEGER NOT NULL,
        criticalCount INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `)
    const insert = db.prepare('INSERT INTO briefings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    insert.run(1, 1, 'https://www.21jingji.com/article/20260720/herald/a.html', '可恢复日期', collectedAt, '2026-07-21', collectedAt, 'GENERAL', 0)
    insert.run(2, 2, 'https://www.stcn.com/article/detail/1.html', '证券时报待校时', collectedAt, '2026-07-21', collectedAt, 'GENERAL', 0)
    insert.run(3, 3, 'https://example.com/exact', '精确时间文章', Date.parse('2026-07-21T09:00:00+08:00'), '2026-07-21', collectedAt, 'CRITICAL', 0)
    insert.run(4, 3, 'https://example.com/duplicate-a', '同源重复标题', Date.parse('2026-07-21T08:00:00+08:00'), '2026-07-21', collectedAt, 'GENERAL', 1)
    insert.run(5, 3, 'https://example.com/duplicate-b', '同源重复标题', Date.parse('2026-07-21T08:30:00+08:00'), '2026-07-21', collectedAt, 'GENERAL', 0)
    insert.run(6, 4, 'https://example.com/comment', '评论(0)', collectedAt, '2026-07-21', collectedAt, 'GENERAL', 0)
    insert.run(7, 1, 'https://www.21jingji.com/article/20260430/herald/event.html', '社会救助法2026年7月1日起施行', Date.parse('2026-07-01T00:00:00+08:00'), '2026-07-01', Date.parse('2026-04-30T10:56:47+08:00'), 'GENERAL', 0)
    db.prepare('INSERT INTO ai_analysis_sessions VALUES (1, 5), (2, 6)').run()

    try {
      runMigrations(db, migration116)

      expect(db.prepare('SELECT id, publishedDateBJ, publicationTimeStatus FROM briefings WHERE id IN (1, 2, 3, 7) ORDER BY id').all()).toEqual([
        { id: 1, publishedDateBJ: '2026-07-20', publicationTimeStatus: 'date_only' },
        { id: 2, publishedDateBJ: '2026-07-21', publicationTimeStatus: 'collected_fallback' },
        { id: 3, publishedDateBJ: '2026-07-21', publicationTimeStatus: 'exact' },
        { id: 7, publishedDateBJ: '2026-04-30', publicationTimeStatus: 'date_only' },
      ])
      expect(db.prepare("SELECT id FROM briefings WHERE title = '同源重复标题' ORDER BY id").all()).toEqual([{ id: 4 }])
      expect(db.prepare('SELECT id FROM briefings WHERE id = 6').get()).toBeUndefined()
      expect(db.prepare('SELECT id, briefingId FROM ai_analysis_sessions ORDER BY id').all()).toEqual([
        { id: 1, briefingId: 4 },
        { id: 2, briefingId: null },
      ])
      expect(db.prepare('SELECT date, totalCount, unreadCount, criticalCount, uncertainTimeCount FROM daily_archive ORDER BY date').all()).toEqual([
        { date: '2026-04-30', totalCount: 1, unreadCount: 1, criticalCount: 0, uncertainTimeCount: 0 },
        { date: '2026-07-20', totalCount: 1, unreadCount: 1, criticalCount: 0, uncertainTimeCount: 0 },
        { date: '2026-07-21', totalCount: 2, unreadCount: 1, criticalCount: 1, uncertainTimeCount: 1 },
      ])
    } finally {
      db.close()
    }
  })

  it('Migration 117 将错误的未来发布时间恢复到采集日期', () => {
    const db = new Database(':memory:')
    const migration117 = DATABASE_MIGRATIONS.filter((migration) => migration.version === 117)
    const collectedJuly17 = Date.parse('2026-07-17T20:22:47+08:00')
    const collectedJuly22 = Date.parse('2026-07-22T08:35:54+08:00')
    db.exec(`
      CREATE TABLE briefings (
        id INTEGER PRIMARY KEY,
        sourceId INTEGER NOT NULL,
        title TEXT NOT NULL,
        publishedAt INTEGER NOT NULL,
        publishedDateBJ TEXT NOT NULL,
        publicationTimeStatus TEXT NOT NULL,
        collectedAt INTEGER NOT NULL,
        impactRating TEXT NOT NULL,
        isRead INTEGER NOT NULL
      );
      CREATE TABLE ai_analysis_sessions (
        id INTEGER PRIMARY KEY,
        briefingId INTEGER
      );
      CREATE TABLE daily_archive (
        date TEXT PRIMARY KEY,
        totalCount INTEGER NOT NULL,
        unreadCount INTEGER NOT NULL,
        criticalCount INTEGER NOT NULL,
        uncertainTimeCount INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `)
    const insert = db.prepare('INSERT INTO briefings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    insert.run(1, 13, '2026-09-01 policy event', Date.parse('2026-09-01T00:00:00+08:00'), '2026-09-01', 'date_only', collectedJuly17, 'GENERAL', 0)
    insert.run(2, 13, '2027-01-01 service event', Date.parse('2027-01-01T00:00:00+08:00'), '2027-01-01', 'exact', collectedJuly22, 'CRITICAL', 0)
    insert.run(3, 13, 'normal publication', Date.parse('2026-07-22T08:30:00+08:00'), '2026-07-22', 'exact', collectedJuly22, 'GENERAL', 1)
    db.prepare("INSERT INTO daily_archive VALUES ('2026-09-01', 1, 1, 0, 0, 0), ('2027-01-01', 1, 1, 1, 0, 0)").run()

    try {
      runMigrations(db, migration117)

      expect(db.prepare('SELECT id, publishedAt, publishedDateBJ, publicationTimeStatus FROM briefings ORDER BY id').all()).toEqual([
        { id: 1, publishedAt: collectedJuly17, publishedDateBJ: '2026-07-17', publicationTimeStatus: 'collected_fallback' },
        { id: 2, publishedAt: collectedJuly22, publishedDateBJ: '2026-07-22', publicationTimeStatus: 'collected_fallback' },
        { id: 3, publishedAt: Date.parse('2026-07-22T08:30:00+08:00'), publishedDateBJ: '2026-07-22', publicationTimeStatus: 'exact' },
      ])
      expect(db.prepare('SELECT date, totalCount, unreadCount, criticalCount, uncertainTimeCount FROM daily_archive ORDER BY date').all()).toEqual([
        { date: '2026-07-17', totalCount: 0, unreadCount: 0, criticalCount: 0, uncertainTimeCount: 1 },
        { date: '2026-07-22', totalCount: 1, unreadCount: 0, criticalCount: 0, uncertainTimeCount: 1 },
      ])
    } finally {
      db.close()
    }
  })
})
