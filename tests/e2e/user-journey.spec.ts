import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

interface HoldingSnapshot {
  tsCode: string
  stockName: string
  costPrice: number | null
}

async function launchApp(userDataDir?: string) {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  return electron.launch({
    args: [
      join(__dirname, '../../out/main/index.js'),
      ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []),
    ],
    env: { ...launchEnv, NODE_ENV: 'test' }
  })
}

function seedIndustryResearchJourney(dbPath: string): void {
  const electronExecutable = require('electron') as string
  const seedScript = String.raw`
    const Database = require('better-sqlite3')
    const { createHash } = require('crypto')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    db.pragma('foreign_keys = ON')
    const now = Date.now()
    const projectInsert = db.prepare(
      'INSERT INTO industry_research_projects (id, title, industry_name, product_scope, region_scope, time_scope, purpose, depth, status, data_as_of, source_type, source_ref, source_text_summary, skill_id, skill_content_hash, skill_rule_version, generation_model, graph_updated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    projectInsert.run('e2e-project-main', '光通信自动证据研究', '光通信', '光纤光缆', '中国', '近三年', 'investment', 'standard', 'active', '2026-07-15', 'manual', null, 'E2E isolated research', 'builtin:industry-chain-research', 'a'.repeat(64), 'sha256:aaaaaaaaaaaa', 'e2e-model', now, now, now + 1)
    projectInsert.run('e2e-project-other', '跨项目归属校验', '光通信', '光模块', '中国', '近三年', 'investment', 'standard', 'active', '2026-07-15', 'manual', null, 'E2E isolated project', 'builtin:industry-chain-research', 'a'.repeat(64), 'sha256:aaaaaaaaaaaa', 'e2e-model', now, now, now)

    const representativeIds = Array.from({ length: 14 }, (_, index) => 'e2e-candidate-' + index)
    const evidenceItem = {
      code: 'trend_state_positive',
      toolId: 'stock.trend_snapshot',
      label: '趋势状态',
      detail: '中天科技趋势状态=strong；评分=72',
      factDate: '20260715',
      sourceIds: ['local.trend_score_history'],
    }
    evidenceItem.referenceId = 'E-' + createHash('sha256')
      .update('stock\u0000600522\u0000' + evidenceItem.toolId + '\u0000' + evidenceItem.code)
      .digest('hex').slice(0, 10).toUpperCase()
    const evidenceContrast = {
      schemaVersion: 1,
      generatedAt: now,
      asOf: '20260715',
      subjects: [{
        subjectKind: 'stock',
        subjectId: '600522',
        label: '中天科技',
        supporting: [evidenceItem],
        challenging: [],
        unknowns: [],
      }],
      warnings: [],
      markdown: '## 确定性证据对照\n- [' + evidenceItem.referenceId + '] 趋势状态',
    }
    const evidenceSnapshotSha256 = createHash('sha256').update(JSON.stringify({
      schemaVersion: evidenceContrast.schemaVersion,
      asOf: evidenceContrast.asOf,
      subjects: evidenceContrast.subjects.map(subject => ({
        subjectKind: subject.subjectKind,
        subjectId: subject.subjectId,
        label: subject.label,
        supporting: subject.supporting.map(item => ({ ...item, referenceId: item.referenceId, sourceIds: [...item.sourceIds] })),
        challenging: [],
        unknowns: [],
      })),
      warnings: evidenceContrast.warnings,
    })).digest('hex')
    const reportSummary = '系统已自动处理候选来源并生成完整报告。'
    const reportMarkdown = '# 光通信产业研究报告\n\n> 数据截至：2026-07-15\n\n## 一、核心结论\n\n运营商资本开支、光纤价格与供给格局共同决定景气斜率。[' + evidenceItem.referenceId + ']\n\n## 二、验证边界\n\n网页来源只作为估算和假设约束，财务数字仍以本地事实为准。'
    const auditedDocument = reportSummary + '\n\n' + reportMarkdown
    const reportAudit = {
      schemaVersion: 1,
      documentKind: 'industry_report',
      status: 'passed',
      generatedAt: now,
      asOf: '20260715',
      originalTextSha256: createHash('sha256').update(auditedDocument).digest('hex'),
      checkedCharacters: auditedDocument.length,
      evidenceSummary: { subjectCount: 1, supporting: 1, challenging: 0, unknowns: 0 },
      citationSummary: {
        evidenceSnapshotSha256,
        availableReferences: 1,
        referencedIds: [evidenceItem.referenceId],
        unresolvedIds: [],
      },
      checks: [{ code: 'EVIDENCE_REFERENCE_REQUIRED', status: 'passed', message: '最终文本已保留可识别的确定性证据引用', excerpts: [] }],
    }
    const artifacts = {
      researchFacts: { schemaVersion: 1, evidenceContrast },
      retrieve: {
        mode: 'strong',
        selectedTopNIds: representativeIds,
        plan: {
          mode: 'strong', candidatePoolSize: 45, selectedTopN: 14, localHitCount: 5, webHitCount: 40, detailPageCount: 32,
          message: '系统已自动完成 45 条候选的评级与精选',
          queries: Array.from({ length: 8 }, (_, index) => ({ id: 'query-' + index, text: '光通信产业 query ' + index, intent: index % 2 ? 'company_exposure' : 'supply_demand_price', hitCount: 5, status: 'executed' }))
        },
        nativeWebSearch: {
          status: 'succeeded',
          provider: 'chatgpt',
          model: 'gpt-5.6-sol',
          responseId: 'resp-e2e-native-search',
          calls: [
            { id: 'search-e2e', status: 'completed', action: { type: 'search', queries: ['2026 光通信产业供需'], url: null, pattern: null, sources: ['https://example.com/research/source-0'] } },
            { id: 'open-e2e', status: 'completed', action: { type: 'open_page', queries: [], url: 'https://example.com/research/source-0', pattern: null, sources: [] } },
            { id: 'find-e2e', status: 'completed', action: { type: 'find_in_page', queries: [], url: 'https://example.com/research/source-0', pattern: '运营商资本开支', sources: [] } }
          ],
          citations: [{ url: 'https://example.com/research/source-0', title: '公开来源 0', startIndex: 0, endIndex: 12 }],
          sources: [{ url: 'https://example.com/research/source-0', title: '公开来源 0', cited: true }]
        }
      },
      report: {
        title: '光通信产业研究报告',
        summary: reportSummary,
        markdown: reportMarkdown,
        supportedFindings: [
          { text: '运营商需求与供给格局共同影响光纤价格弹性。', candidateIds: ['e2e-candidate-0', 'e2e-candidate-1'] },
          { text: '公司映射仍需通过公告和本地财务事实验证。', candidateIds: ['e2e-candidate-2'] }
        ],
        modelOnlyFindings: ['价格传导速度仍属于模型推断。'],
        pendingSources: ['运营商集采成交价原始公告'],
        candidateIds: representativeIds,
        evidenceInsufficient: false,
        missingSections: [],
        conflicts: [
          '多项候选资料发布于2026年，晚于2024-12-31数据截止日。',
          '媒体口径对需求增速存在差异。'
        ],
        textAudit: reportAudit,
      },
      companies: {
        count: 1,
        items: [{
          displayName: '中天科技',
          legalNameCandidate: '江苏中天科技股份有限公司',
          rationale: '具备光纤光缆业务暴露，仍需公告和本地财务事实验证。',
          researchNodeIds: [],
          tsCodeHint: '600522.SH',
          candidateIds: ['e2e-candidate-2'],
          noEvidenceSupport: false
        }]
      },
      financialCollection: {
        status: 'partial',
        source: 'tushare',
        totalCompanies: 1,
        completedCompanies: 0,
        totalDatasets: 9,
        coveredDatasets: 6,
        failedDatasets: 1,
        pendingDatasets: 3,
        attemptedDatasets: 7,
        skippedDatasets: 0,
        currentCompanyId: null,
        currentCompanyName: null,
        currentTsCode: null,
        currentDataset: null,
        errorCode: 'FINANCIAL_COLLECTION_INCOMPLETE',
        message: '财务采集部分完成：已覆盖 6/9 个公司数据集，失败 1 个',
        startedAt: now - 3000,
        updatedAt: now,
        completedAt: now,
        companies: []
      }
    }
    db.prepare(
      "INSERT INTO industry_research_generation_runs (id, project_id, research_question, status, current_stage, last_successful_stage, progress_current, progress_total, progress_message, cancel_requested, skill_id, skill_content_hash, skill_rule_version, provider, model, error_code, error_message, retryable, stage_artifacts_json, scope_json, enable_web_retrieval, created_at, started_at, completed_at, updated_at) VALUES (?, ?, ?, 'succeeded', 'report', 'report', 7, 7, ?, 0, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, '{}', 1, ?, ?, ?, ?)"
    ).run('e2e-run-main', 'e2e-project-main', '光通信产业链的供需、价格和公司暴露如何验证？', '研究报告已生成', 'builtin:industry-chain-research', 'a'.repeat(64), 'sha256:aaaaaaaaaaaa', 'e2e-provider', 'e2e-model', JSON.stringify(artifacts), now, now, now, now)
    const candidateInsert = db.prepare(
      "INSERT INTO research_evidence_candidates (id, project_id, run_id, query, source_url, title, summary, excerpt, provider_id, published_at, fetched_at, status, failure_reason, confirmed_at, source_kind, is_detail_page, relevance_score, authority_score, freshness_score, rank_score, created_at, updated_at) VALUES (?, 'e2e-project-main', 'e2e-run-main', ?, ?, ?, ?, ?, 'builtin_web', '2026-07-15', ?, 'fetched', NULL, NULL, ?, 1, ?, ?, 0.9, ?, ?, ?)"
    )
    for (let index = 0; index < 45; index += 1) {
      candidateInsert.run('e2e-candidate-' + index, '光通信 query ' + index, 'https://example.com/research/source-' + index, '公开来源 ' + index, '公开来源摘要 ' + index + '：用于验证产业链判断。', '有限摘录 ' + index + '：不保存外部全文。', now, index < 4 ? 'official_detail' : 'web_search', 1 - index / 100, index < 4 ? 0.95 : 0.6, 1 - index / 120, now, now)
    }
    db.prepare(
      "INSERT INTO industry_research_company_candidates (id, run_id, project_id, legal_name_candidate, display_name, research_node_ids_json, rationale, matched_securities_json, resolution_status, exclusion_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)"
    ).run(
      'e2e-company-candidate',
      'e2e-run-main',
      'e2e-project-main',
      '江苏中天科技股份有限公司',
      '中天科技',
      '[]',
      '具备光纤光缆业务暴露，仍需公告和本地财务事实验证。',
      JSON.stringify([{ tsCode: '600522.SH', stockName: '中天科技', exchange: 'SSE', matchStatus: 'exact' }]),
      now,
      now
    )
    db.close()
  `
  execFileSync(electronExecutable, ['-e', seedScript], {
    cwd: join(__dirname, '../..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TRADE_WATCH_SEED_DB: dbPath },
    stdio: 'pipe',
  })
}

function seedIndustryResearchFinancialJourney(dbPath: string, companyId: string, securityId: string): void {
  const electronExecutable = require('electron') as string
  const seedScript = String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    db.pragma('foreign_keys = ON')
    const companyId = process.env.TRADE_WATCH_SEED_COMPANY
    const securityId = process.env.TRADE_WATCH_SEED_SECURITY
    const projectId = 'e2e-project-main'
    const now = Date.now()
    const bridgeKey = 'annual:' + companyId

    db.transaction(() => {
      db.prepare(
        'INSERT INTO industry_research_disclosure_evidence (id, company_id, project_id, title, source_url, published_date, actual_published_date, excerpt, created_by, primary_source_confirmed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('e2e-official-report', companyId, projectId, '中天科技2024年年度报告', 'https://example.com/official/annual-report.pdf', '2025-04-30', '2025-04-30', '光通信网络产品收入与产能信息。', 'human', 1, now, now)
      db.prepare(
        'INSERT INTO industry_research_main_business_items (id, company_id, source_api, source_fact_key, source_version, report_period, dimension, item_code, item_name, revenue, cost, profit, currency, fetched_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)'
      ).run('e2e-main-business', companyId, 'fina_mainbz', 'e2e-main-business-key', 'e2e-main-business-version', '20241231', 'product', '光通信网络产品', 1200000000, 900000000, 300000000, 'CNY', now, now)
      db.prepare(
        'INSERT INTO industry_research_business_exposures (id, project_id, company_id, research_node_id, main_business_item_id, evidence_id, source_key, source_type, status, exposure_pct, basis, created_by, fact_date, evidence_ids_json, methodology, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('e2e-exposure', projectId, companyId, 'e2e-main-business', 'e2e-official-report', 'annual-report-optical-fiber', 'manual', 'confirmed', 36.5, '依据年报分部口径确认光纤光缆业务暴露。', 'human', '20241231', '["e2e-official-report"]', '按年报分部收入占比映射', now, now)

      const businessPeriods = Array.from({ length: 9 }, (_, index) => String(2017 + index))
        .flatMap(year => [year + '0630', year + '1231'])
      const insertBusinessItem = db.prepare(
        'INSERT INTO industry_research_main_business_items (id, company_id, source_api, source_fact_key, source_version, report_period, dimension, item_code, item_name, revenue, cost, profit, currency, fetched_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)'
      )
      const insertExposure = db.prepare(
        'INSERT INTO industry_research_business_exposures (id, project_id, company_id, research_node_id, main_business_item_id, evidence_id, source_key, source_type, status, exposure_pct, basis, created_by, fact_date, evidence_ids_json, methodology, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, ?, NULL, ?, ?, NULL, ?, NULL, ?, ?)'
      )
      for (let index = 1; index < 150; index += 1) {
        const itemId = 'e2e-main-business-' + index
        const period = businessPeriods[index % businessPeriods.length]
        const itemName = '业务分项' + (index % 23 + 1)
        const revenue = 100000000 + index * 1370000
        const cost = 70000000 + index * 910000
        insertBusinessItem.run(itemId, companyId, 'fina_mainbz', 'e2e-main-business-key-' + index, 'e2e-main-business-version-' + index, period, 'product', itemName, revenue, cost, revenue - cost, 'CNY', now, now)
        insertExposure.run('e2e-exposure-' + index, projectId, companyId, itemId, 'fina-mainbz-' + index, 'fina_mainbz', 'candidate', 'Tushare主营构成候选: ' + itemName, 'import', '[]', now, now)
      }

      const insertFact = db.prepare(
        'INSERT INTO industry_research_financial_facts (id, company_id, security_id, source_api, source_fact_key, source_version, metric_name, metric_value, text_value, unit, currency, ann_date, f_ann_date, report_period, statement_type, company_type, update_flag, fact_kind, derivation_formula, input_versions_json, derivation_status, fetched_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      const reported = (id, sourceApi, sourceKey, sourceVersion, metricName, metricValue, reportPeriod, updateFlag, annDate, unit = null, currency = null) => {
        insertFact.run(id, companyId, securityId, sourceApi, sourceKey, sourceVersion, metricName, metricValue, unit, currency, annDate, annDate, reportPeriod, '1', '1', updateFlag, 'reported', null, '[]', 'not_applicable', now, now)
      }
      reported('e2e-income-v1', 'income', '600522.SH:20241231:1', 'v1', 'revenue', 100, '20241231', '0', '20250420', 'CNY', 'CNY')
      reported('e2e-income-v2', 'income', '600522.SH:20241231:1', 'v2', 'revenue', 120, '20241231', '1', '20250430', 'CNY', 'CNY')
      reported('e2e-receivables', 'balancesheet', '600522.SH:20241231:balance', 'v1', 'accounts_receiv', 120, '20241231', '0', '20250430', 'CNY', 'CNY')
      reported('e2e-inventory', 'balancesheet', '600522.SH:20241231:balance', 'v1', 'inventories', 80, '20241231', '0', '20250430', 'CNY', 'CNY')
      reported('e2e-contract-assets', 'balancesheet', '600522.SH:20241231:balance', 'v1', 'contract_assets', 30, '20241231', '0', '20250430', 'CNY', 'CNY')
      reported('e2e-cashflow', 'cashflow', '600522.SH:20240930:cashflow', 'v1', 'n_cashflow_act', 90, '20240930', '0', '20241030', 'CNY', 'CNY')
      insertFact.run('e2e-cashflow-blocked', companyId, securityId, 'derived_quarter_cashflow', '600522.SH:20240930:cashflow:single', 'v1', 'n_cashflow_act_single_quarter', null, 'CNY', 'CNY', '20241030', '20241030', '20240930', '1', '1', '0', 'derived', 'Q3 = YTD(Q3) - YTD(Q2)', '["missing:20240630"]', 'blocked', now, now)

      const insertSync = db.prepare(
        'INSERT INTO industry_research_financial_sync_state (company_id, dataset, status, last_attempt_at, last_success_at, last_error_code, last_success_fact_date, last_success_row_count, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      insertSync.run(companyId, 'income', 'failed', now, now - 1000, 'PERMISSION_REQUIRED', '20231231', 1, now)
      insertSync.run(companyId, 'balancesheet', 'success', now, now, null, '20241231', 3, now)
      insertSync.run(companyId, 'cashflow', 'success', now, now, null, '20240930', 1, now)

      db.prepare(
        'INSERT INTO industry_research_profit_bridges (id, project_id, company_id, bridge_key, base_period, target_period, status, formula, input_fact_ids_json, evidence_ids_json, created_by, version, previous_version_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)'
      ).run('e2e-profit-bridge', projectId, companyId, bridgeKey, '20231231', '20241231', 'estimate', '目标利润 = 基期利润 + 价格影响', '["e2e-income-v2"]', '["e2e-official-report"]', 'human', 1, now, now)
      db.prepare(
        'INSERT INTO industry_research_profit_bridge_items (id, profit_bridge_id, item_key, label, amount, unit, methodology, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('e2e-profit-bridge-price', 'e2e-profit-bridge', 'price', '价格影响', 12, 'CNY', '按年报与集采口径估算', 0)
    })()
    db.close()
  `
  execFileSync(electronExecutable, ['-e', seedScript], {
    cwd: join(__dirname, '../..'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      TRADE_WATCH_SEED_DB: dbPath,
      TRADE_WATCH_SEED_COMPANY: companyId,
      TRADE_WATCH_SEED_SECURITY: securityId,
    },
    stdio: 'pipe',
  })
}

function seedIndustryResearchDecisionJourney(dbPath: string, companyId: string, securityId: string): void {
  const electronExecutable = require('electron') as string
  const seedScript = String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    db.pragma('foreign_keys = ON')
    const companyId = process.env.TRADE_WATCH_SEED_COMPANY
    const securityId = process.env.TRADE_WATCH_SEED_SECURITY
    const projectId = 'e2e-project-main'
    const now = Date.now()
    const skillSnapshotId = 'e2e-decision-skill'

    db.transaction(() => {
      db.prepare(
        'INSERT OR IGNORE INTO industry_research_skill_snapshots (id, skill_id, content_hash, rule_version, content, source_type, source_locator, content_bytes, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(skillSnapshotId, 'builtin:industry-chain-research', 'a'.repeat(64), 'sha256:aaaaaaaaaaaa', '# E2E industry research rules', 'builtin', 'industry-chain-research', 29, now)
      db.prepare(
        'INSERT OR IGNORE INTO industry_research_skill_adoption_events (id, request_id, project_id, event_type, previous_snapshot_id, target_snapshot_id, research_snapshot_id, migration_note, diff_schema_version, diff_json, review_summary_json, adopted_at) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, 1, ?, ?, ?)'
      ).run('e2e-decision-adoption', 'e2e-decision-adoption-request', projectId, 'initial', skillSnapshotId, 'E2E initial adoption', '{"schemaVersion":1,"added":[],"removed":[],"changed":[],"unchanged":[]}', '[]', now)
      db.prepare(
        'INSERT OR IGNORE INTO industry_research_hypotheses (id, project_id, statement, importance, status, cheapest_disproof, verification_metric, threshold, due_at, evidence_ids_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('e2e-price-hypothesis', projectId, '价格回撤后风险收益改善', 5, 'open', '合理价值区间下修至现价以下', '估值区间', '悲观价值低于现价', now - 1000, '[]', now, now)
      db.prepare(
        'INSERT OR IGNORE INTO industry_research_hypothesis_events (id, project_id, hypothesis_id, from_status, to_status, reason, evidence_ids_json, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)'
      ).run('e2e-price-hypothesis-event', projectId, 'e2e-price-hypothesis', 'open', 'E2E baseline', '[]', now)

      const dates = []
      const cursor = new Date('2026-07-17T00:00:00Z')
      while (dates.length < 260) {
        const day = cursor.getUTCDay()
        if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10).replaceAll('-', ''))
        cursor.setUTCDate(cursor.getUTCDate() - 1)
      }
      dates.reverse()
      const daily = db.prepare(
        'INSERT INTO daily_close_cache (ts_code, trade_date, open, high, low, close, pct_chg, vol, turnover_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ts_code, trade_date) DO UPDATE SET open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, pct_chg=excluded.pct_chg, vol=excluded.vol, turnover_rate=excluded.turnover_rate'
      )
      const adjustment = db.prepare(
        'INSERT INTO security_adjustment_factor_cache (ts_code, trade_date, adj_factor, source, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(ts_code, trade_date) DO UPDATE SET adj_factor=excluded.adj_factor, source=excluded.source, fetched_at=excluded.fetched_at'
      )
      const valuation = db.prepare(
        'INSERT INTO security_valuation_daily_cache (ts_code, trade_date, total_share, float_share, total_mv, circ_mv, pe_ttm, pb, ps_ttm, dv_ttm, source, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ts_code, trade_date) DO UPDATE SET total_share=excluded.total_share, float_share=excluded.float_share, total_mv=excluded.total_mv, circ_mv=excluded.circ_mv, pe_ttm=excluded.pe_ttm, pb=excluded.pb, ps_ttm=excluded.ps_ttm, dv_ttm=excluded.dv_ttm, source=excluded.source, fetched_at=excluded.fetched_at'
      )
      dates.forEach((date, index) => {
        const stockClose = 10 + index / 100
        const benchmarkClose = 100 + index / 20
        daily.run('600522.SH', date, stockClose, stockClose, stockClose, stockClose, 0, 1000, 1)
        daily.run('000001.SH', date, benchmarkClose, benchmarkClose, benchmarkClose, benchmarkClose, 0, 1000, null)
        adjustment.run('600522.SH', date, 1, 'e2e:adj_factor', now)
        valuation.run('600522.SH', date, 10000, 8000, stockClose * 10000, stockClose * 8000, 10 + index / 100, 1 + index / 1000, 2 + index / 1000, 1, 'e2e:daily_basic', now)
      })
    })()
    db.close()
  `
  execFileSync(electronExecutable, ['-e', seedScript], {
    cwd: join(__dirname, '../..'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      TRADE_WATCH_SEED_DB: dbPath,
      TRADE_WATCH_SEED_COMPANY: companyId,
      TRADE_WATCH_SEED_SECURITY: securityId,
    },
    stdio: 'pipe',
  })
}

test.describe.serial('真实用户主流程', () => {
  test('首次引导的两个今日看板入口都会导航并关闭引导', async () => {
    test.setTimeout(60000)
    const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-onboarding-entry-'))
    const app = await launchApp(userDataDir)
    try {
      const window = await app.firstWindow()
      await window.waitForLoadState('domcontentloaded')
      await expect(window.getByText('RT-ResearchFlow')).toBeVisible({ timeout: 15000 })

      const existingGuide = window.locator('[data-testid="cold-start-guide"]')
      if (await existingGuide.isVisible()) {
        await existingGuide.getByLabel('关闭引导').click()
        await expect(existingGuide).toBeHidden()
      }

      await app.evaluate(({ ipcMain }) => {
        const now = Date.now()
        const item = (key: string, title: string) => ({ key, title, status: 'ok' as const, message: '已完成', checkedAt: now })
        ipcMain.removeHandler('diagnostics:getHealth')
        ipcMain.handle('diagnostics:getHealth', () => ({
          ok: true as const,
          data: {
            status: 'ok' as const,
            checkedAt: now,
            summary: { ok: 6, warning: 0, error: 0 },
            groups: [
              {
                key: 'config' as const,
                title: '配置',
                items: [item('config.tushare', 'Tushare 数据源'), item('config.ai', 'AI 模型')]
              },
              {
                key: 'freshness' as const,
                title: '数据新鲜度',
                items: [
                  item('freshness.stockBasic', '股票基础数据'),
                  item('freshness.dailyClose', '全市场历史日线'),
                  item('kplConcept', '题材成分'),
                  item('freshness.decisionSignals', '今日看板信号')
                ]
              }
            ]
          }
        }))
      })

      const openGuideFromConfig = async () => {
        await window.locator('[data-testid="open-config-drawer-btn"]').click()
        await expect(window.locator('[data-testid="config-drawer"]')).toBeVisible()
        await window.locator('[data-testid="config-open-onboarding-guide-btn"]').click()
        await expect(window.locator('[data-testid="config-drawer"]')).toBeHidden()
        await expect(window.locator('[data-testid="cold-start-guide"]')).toBeVisible({ timeout: 15000 })
      }

      await window.locator('[data-testid="nav-tab-stock-chart"]').click()
      await expect(window.locator('[data-testid="stock-chart-root"]')).toBeVisible({ timeout: 15000 })
      await openGuideFromConfig()

      const coldStartGuide = window.locator('[data-testid="cold-start-guide"]')
      await expect(coldStartGuide.locator('[data-testid="initialization-flow-panel"]')).toBeVisible()
      await expect(coldStartGuide.locator('[data-testid="start-initialization-flow-btn"]')).toBeVisible()
      await coldStartGuide.locator('[data-testid="onboarding-step-action-enter-home"]').click()
      await expect(coldStartGuide).toBeHidden()
      await expect(window.locator('[data-testid="decision-center-root"]')).toBeVisible({ timeout: 15000 })
      await expect.poll(() => window.evaluate(() => localStorage.getItem('trade-watch:onboarding:v1:dismissed'))).toBe('1')

      await window.locator('[data-testid="nav-tab-stock-chart"]').click()
      await expect(window.locator('[data-testid="stock-chart-root"]')).toBeVisible({ timeout: 15000 })
      await openGuideFromConfig()
      await coldStartGuide.locator('[data-testid="onboarding-primary-action"]').click()
      await expect(coldStartGuide).toBeHidden()
      await expect(window.locator('[data-testid="decision-center-root"]')).toBeVisible({ timeout: 15000 })
      await expect.poll(() => window.evaluate(() => localStorage.getItem('trade-watch:onboarding:v1:dismissed'))).toBe('1')
    } finally {
      await app.close()
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  test('用户可从组合空态加入首只持仓并返回组合', async () => {
    test.setTimeout(90000)
    const app = await launchApp()
    let holdingsBackup: HoldingSnapshot[] = []
    try {
      const window = await app.firstWindow()
      await window.waitForLoadState('domcontentloaded')
      await expect(window.getByText('RT-ResearchFlow')).toBeVisible({ timeout: 15000 })

      holdingsBackup = await window.evaluate(async () => {
        const res = await window.api.portfolio.list()
        if (!res.ok) throw new Error(res.message || '读取持仓失败')
        return (res.data ?? []).map(item => ({
          tsCode: item.tsCode,
          stockName: item.stockName,
          costPrice: item.costPrice,
        }))
      })
      await window.evaluate(async () => {
        const current = await window.api.portfolio.list()
        if (!current.ok) throw new Error(current.message || '读取持仓失败')
        for (const item of current.data ?? []) {
          const removed = await window.api.portfolio.remove(item.tsCode)
          if (!removed.ok) throw new Error(removed.message || `清空持仓失败: ${item.tsCode}`)
        }
      })
      await window.reload()
      await window.waitForLoadState('domcontentloaded')

      const coldStartGuide = window.locator('[data-testid="cold-start-guide"]')
      if (await coldStartGuide.isVisible()) {
        await coldStartGuide.getByLabel('关闭引导').click()
        await expect(coldStartGuide).toBeHidden()
      }

      await window.locator('[data-testid="nav-tab-decision-center"]').click()
      await window.locator('[data-testid="decision-view-mode-portfolio"]').click()
      await expect(window.locator('[data-testid="decision-portfolio-no-holding-empty"]')).toBeVisible({ timeout: 15000 })
      await window.locator('[data-testid="decision-start-portfolio-journey"]').click()

      await expect(window.locator('[data-testid="stock-chart-root"]')).toBeVisible({ timeout: 15000 })
      const firstCachedStock = window.locator('[data-testid^="stock-list-item-"]').first()
      if (await firstCachedStock.count() > 0) {
        await firstCachedStock.locator('button').first().click()
      } else {
        const stockSearch = window.getByPlaceholder('输入公司名或股票代码')
        await stockSearch.fill('600000')
        await stockSearch.press('Enter')
      }

      await expect(window.locator('[data-testid="portfolio-journey-banner"]')).toBeVisible()
      const portfolioButton = window.locator('[data-testid="portfolio-toggle-btn"]')
      await expect(portfolioButton).toContainText('+ 持仓')
      await portfolioButton.click()
      await expect(window.locator('[data-testid="portfolio-journey-banner"]')).toContainText('持仓已加入')
      await expect(window.locator('[data-testid="portfolio-journey-edit-cost"]')).toBeVisible()
      await window.locator('[data-testid="portfolio-journey-return"]').click()

      await expect(window.locator('[data-testid="decision-center-root"]')).toBeVisible({ timeout: 15000 })
      await expect(window.locator('[data-testid="decision-view-mode-portfolio"]')).toHaveAttribute('aria-pressed', 'true')
      await expect(window.locator('[data-testid="decision-portfolio-no-holding-empty"]')).toBeHidden()
    } finally {
      const windows = app.windows()
      const window = windows[0]
      if (window) {
        await window.evaluate(async (backup) => {
          const current = await window.api.portfolio.list()
          if (current.ok) {
            for (const item of current.data ?? []) {
              await window.api.portfolio.remove(item.tsCode)
            }
          }
          for (const item of backup) {
            const added = await window.api.portfolio.add(item.tsCode, item.stockName)
            if (added.ok && item.costPrice != null) {
              await window.api.portfolio.updateCostPrice(item.tsCode, item.costPrice)
            }
          }
        }, holdingsBackup).catch(() => {})
      }
      await app.close()
    }
  })

  test('复盘报告自动保存后可跨重启回看并显式删除', async () => {
    test.setTimeout(90000)
    const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-fr239-review-'))
    let app = await launchApp(userDataDir)
    let createdReportIds: string[] = []
    try {
      let window = await app.firstWindow()
      await window.waitForLoadState('domcontentloaded')
      await expect(window.getByText('RT-ResearchFlow')).toBeVisible({ timeout: 15000 })

      const beforeIds = await window.evaluate(async () => {
        const res = await window.api.decision.listReviewReports({ includeAllVersions: true, limit: 100 })
        if (!res.ok || !res.data) throw new Error(res.message || '读取历史复盘失败')
        return res.data.items.map((item) => item.id)
      })

      const coldStartGuide = window.locator('[data-testid="cold-start-guide"]')
      if (await coldStartGuide.isVisible()) {
        await coldStartGuide.getByLabel('关闭引导').click()
      }
      await window.locator('[data-testid="nav-tab-decision-center"]').click()
      await window.locator('[data-testid="decision-view-mode-portfolio"]').click()
      await window.locator('[data-testid="decision-generate-daily-review"]').click()
      const reportPanel = window.locator('[data-testid="review-report-panel"]')
      await expect(reportPanel).toBeVisible({ timeout: 15000 })
      await expect(reportPanel.getByText(/已保存 · 版本/)).toBeVisible({ timeout: 15000 })
      await window.setViewportSize({ width: 1024, height: 480 })
      const reportScrollTop = await reportPanel.locator('[data-testid="review-report-scroll"]').evaluate((element) => {
        const target = Math.min(240, Math.max(0, element.scrollHeight - element.clientHeight))
        element.scrollTop = target
        return element.scrollTop
      })
      expect(reportScrollTop).toBeGreaterThan(0)
      await reportPanel.locator('[data-testid="review-report-discuss"]').click()
      const discussionContext = window.locator('[data-testid="research-discussion-context"]')
      await expect(discussionContext).toBeVisible({ timeout: 15000 })
      await discussionContext.getByRole('button', { name: '返回来源' }).click()
      await expect(window.locator('[data-testid="review-report-panel"]')).toBeVisible({ timeout: 15000 })
      await expect.poll(async () => window.locator('[data-testid="review-report-scroll"]').evaluate((element) => element.scrollTop)).toBe(reportScrollTop)

      createdReportIds = await window.evaluate(async (existingIds) => {
        const res = await window.api.decision.listReviewReports({ includeAllVersions: true, limit: 100 })
        if (!res.ok || !res.data) throw new Error(res.message || '读取历史复盘失败')
        const existing = new Set(existingIds)
        return res.data.items.map((item) => item.id).filter((id) => !existing.has(id))
      }, beforeIds)
      expect(createdReportIds).toHaveLength(1)
      const reportId = createdReportIds[0]!

      await app.close()
      app = await launchApp(userDataDir)
      window = await app.firstWindow()
      await window.waitForLoadState('domcontentloaded')
      await expect(window.getByText('RT-ResearchFlow')).toBeVisible({ timeout: 15000 })
      await window.locator('[data-testid="nav-tab-decision-center"]').click()
      await window.locator('[data-testid="decision-view-mode-portfolio"]').click()
      await window.locator('[data-testid="decision-review-report-history"]').click()

      const historyItem = window.locator(`[data-testid="review-report-history-item-${reportId}"]`)
      await expect(historyItem).toBeVisible({ timeout: 15000 })
      await window.locator(`[data-testid="review-report-open-${reportId}"]`).click()
      await expect(window.locator('[data-testid="review-report-panel"]')).toBeVisible()
      await window.getByLabel('关闭复盘报告').click()

      await window.locator(`[data-testid="review-report-versions-${reportId}"]`).click()
      await expect(window.locator(`[data-testid="review-report-delete-${reportId}"]`)).toBeVisible()
      window.once('dialog', (dialog) => dialog.accept())
      await window.locator(`[data-testid="review-report-delete-${reportId}"]`).click()
      await expect(window.locator(`[data-testid="review-report-history-item-${reportId}"]`)).toHaveCount(0)
      createdReportIds = []
    } finally {
      const windows = app.windows()
      const window = windows[0]
      if (window && createdReportIds.length > 0) {
        await window.evaluate(async (ids) => {
          for (const id of ids) await window.api.decision.deleteReviewReport(id)
        }, createdReportIds).catch(() => {})
      }
      await app.close().catch(() => {})
      rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
    }
  })

  test('判断版本可跨重启回看并追加修正版', async () => {
    test.setTimeout(90000)
    const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-fr237-'))
    let app = await launchApp(userDataDir)
    const firstNote = `FR237-v1-${Date.now()}`
    const secondNote = `FR237-v2-${Date.now()}`
    let firstId = ''
    try {
      let window = await app.firstWindow()
      await window.waitForLoadState('domcontentloaded')
      await expect(window.getByText('RT-ResearchFlow')).toBeVisible({ timeout: 15000 })
      const first = await window.evaluate(async ({ note }) => {
        return window.api.decision.saveJudgment({
          requestId: crypto.randomUUID(),
          tsCode: '600000.SH',
          stockName: '浦发银行',
          tag: 'watch',
          note,
          relatedSignalIds: [],
          evidenceSnapshot: {
            primaryTitle: '跨重启判断旅程',
            primarySummary: '验证不可变版本和历史入口',
            sourceCount: 0,
            maxPriority: 0,
            trustHint: 'E2E 隔离数据',
            evidence: [{ key: 'e2e', label: '旅程证据', status: 'ready', detail: '本地隔离数据库' }],
          },
        })
      }, { note: firstNote })
      expect(first.ok).toBe(true)
      firstId = first.data?.id ?? ''
      expect(firstId).not.toBe('')

      await app.close()
      app = await launchApp(userDataDir)
      window = await app.firstWindow()
      await window.waitForLoadState('domcontentloaded')
      await expect(window.getByText('RT-ResearchFlow')).toBeVisible({ timeout: 15000 })
      const coldStartGuide = window.locator('[data-testid="cold-start-guide"]')
      if (await coldStartGuide.isVisible()) await coldStartGuide.getByLabel('关闭引导').click()
      await window.locator('[data-testid="nav-tab-decision-center"]').click()
      await window.locator('[data-testid="decision-view-mode-portfolio"]').click()
      await window.locator('[data-testid="decision-judgment-history"]').click()
      await expect(window.locator('[data-testid="judgment-history-panel"]')).toBeVisible({ timeout: 15000 })
      await expect(window.getByText(firstNote)).toBeVisible()
      await window.getByText(firstNote).locator('..').locator('..').getByRole('button', { name: '详情' }).click()
      await expect(window.locator('[data-testid="judgment-correct-button"]')).toBeVisible()
      await window.locator('[data-testid="judgment-correct-button"]').click()
      await window.locator('[data-testid="judgment-correction-note"]').fill(secondNote)
      await window.locator('[data-testid="judgment-correction-submit"]').click()
      await expect(window.getByText('共 2 个不可变版本')).toBeVisible({ timeout: 15000 })
      await expect(window.getByText(secondNote)).toBeVisible()

      const versions = await window.evaluate(async ({ id }) => {
        const detail = await window.api.decision.getJudgment(id)
        if (!detail.ok || !detail.data) throw new Error(detail.message || '读取判断详情失败')
        return detail.data
      }, { id: firstId })
      expect(versions.note).toBe(firstNote)
      expect(versions.versions.map((item) => item.versionNumber)).toEqual([2, 1])
    } finally {
      await app.close().catch(() => {})
      rmSync(userDataDir, { recursive: true, force: true })
      rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
    }
  })

  test('到期判断跨重启进入待回访，结束观察后不再出现', async () => {
    test.setTimeout(120000)
    const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-fr238-'))
    let app = await launchApp(userDataDir)
    const note = `FR238-due-${Date.now()}`
    let judgmentId = ''
    try {
      let window = await app.firstWindow()
      await window.waitForLoadState('domcontentloaded')
      await expect(window.getByText('RT-ResearchFlow')).toBeVisible({ timeout: 15000 })
      const saved = await window.evaluate(async ({ judgmentNote }) => {
        return window.api.decision.saveJudgment({
          requestId: crypto.randomUUID(),
          tsCode: '600000.SH',
          stockName: '浦发银行',
          tag: 'watch',
          note: judgmentNote,
          relatedSignalIds: [],
          reviewDueAt: Date.now() - 1000,
          evidenceSnapshot: {
            primaryTitle: '跨重启回访旅程',
            primarySummary: '验证到期入口和完成事实',
            sourceCount: 0,
            maxPriority: 0,
            trustHint: 'E2E 隔离数据',
            evidence: [{ key: 'e2e-follow-up', label: '回访证据', status: 'ready', detail: '本地隔离数据库' }],
          },
        })
      }, { judgmentNote: note })
      expect(saved.ok).toBe(true)
      judgmentId = saved.data?.id ?? ''
      expect(judgmentId).not.toBe('')

      await app.close()
      app = await launchApp(userDataDir)
      window = await app.firstWindow()
      await window.waitForLoadState('domcontentloaded')
      await expect(window.getByText('RT-ResearchFlow')).toBeVisible({ timeout: 15000 })
      const coldStartGuide = window.locator('[data-testid="cold-start-guide"]')
      if (await coldStartGuide.isVisible()) await coldStartGuide.getByLabel('关闭引导').click()
      await window.locator('[data-testid="nav-tab-decision-center"]').click()
      await window.locator('[data-testid="decision-view-mode-portfolio"]').click()

      const followUpPanel = window.locator('[data-testid="judgment-follow-up-panel"]')
      await expect(followUpPanel).toBeVisible({ timeout: 15000 })
      await expect(followUpPanel.getByText(note)).toBeVisible()
      await followUpPanel.getByText(note).click()
      await followUpPanel.getByRole('button', { name: '结束观察' }).click()
      await followUpPanel.getByPlaceholder('记录本次回访依据').fill('回访目标已完成')
      await followUpPanel.getByRole('button', { name: '完成回访' }).click()
      await expect(followUpPanel).toHaveCount(0, { timeout: 15000 })

      await app.close()
      app = await launchApp(userDataDir)
      window = await app.firstWindow()
      await window.waitForLoadState('domcontentloaded')
      const restored = await window.evaluate(async ({ id }) => {
        const [due, detail] = await Promise.all([
          window.api.decision.listDueJudgmentFollowUps({ limit: 30 }),
          window.api.decision.getJudgment(id),
        ])
        if (!due.ok || !due.data) throw new Error(due.message || '读取待回访失败')
        if (!detail.ok || !detail.data) throw new Error(detail.message || '读取判断版本失败')
        return { due: due.data, detail: detail.data }
      }, { id: judgmentId })
      expect(restored.due.items).toEqual([])
      expect(restored.detail.versions).toEqual([
        expect.objectContaining({ versionNumber: 2, tag: 'done', reviewDueAt: null }),
        expect.objectContaining({ versionNumber: 1, note }),
      ])
    } finally {
      await app.close().catch(() => {})
      rmSync(userDataDir, { recursive: true, force: true })
      rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
    }
  })

  test('产业研究 45 条候选无需人工审核即可读报告并按需正式纳入', async () => {
    test.setTimeout(180000)
    const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-fr230-evidence-'))
    let app = await launchApp(userDataDir)
    try {
      let window = await app.firstWindow()
      await window.waitForLoadState('domcontentloaded')
      await expect(window.getByText('RT-ResearchFlow')).toBeVisible({ timeout: 15000 })
      await app.close()

      seedIndustryResearchJourney(join(`${userDataDir}-dev`, 'trade-watch.db'))
      app = await launchApp(userDataDir)
      window = await app.firstWindow()
      await window.waitForLoadState('domcontentloaded')
      const coldStartGuide = window.locator('[data-testid="cold-start-guide"]')
      if (await coldStartGuide.isVisible()) await coldStartGuide.getByLabel('关闭引导').click()

      await window.locator('[data-testid="nav-tab-ai-analysis"]').click()
      await window.locator('[data-testid="secondary-nav-ai-analysis-industryResearch"]').click()
      await expect(window.locator('[data-testid="industry-research-page"]')).toBeVisible({ timeout: 15000 })
      await expect(window.getByRole('heading', { name: '光通信自动证据研究' })).toBeVisible()
      await expect(window.locator('[data-testid="industry-research-view-report"]')).toBeVisible()
      await expect(window.locator('[data-testid="industry-research-report-findings"]')).toHaveCount(0)
      await expect(window.locator('[data-testid="industry-research-report-document"]')).toContainText('运营商资本开支、光纤价格与供给格局')
      await expect(window.locator('[data-testid="industry-research-report-document"]').getByRole('heading', { name: '光通信产业研究报告', exact: true })).toBeVisible()
      await expect(window.getByText('重大来源冲突 1')).toBeVisible()
      await expect(window.locator('[data-testid="industry-research-workspace-scroll"]')).not.toContainText('2024-12-31')
      await expect(window.getByTestId('industry-research-financial-coverage')).toContainText('财务 6/9')
      await expect(window.getByRole('button', { name: '继续收集并更新报告' })).toBeVisible()
      const researchAudit = window.getByTestId('research-audit-trace')
      await expect(researchAudit).toContainText('审计通过')
      await expect(researchAudit).toContainText('已定位 1/1 项证据')
      await researchAudit.locator('summary').click()
      await expect(researchAudit).toContainText('中天科技')
      await expect(researchAudit).toContainText('local.trend_score_history')
      await expect(researchAudit).toContainText('正文 SHA-256')
      await expect(researchAudit).toContainText('证据 SHA-256')
      await researchAudit.getByRole('button', { name: '对比当前事实' }).click()
      const researchDelta = researchAudit.getByTestId('research-evidence-delta')
      await expect(researchDelta).toContainText('新增')
      await expect(researchDelta).toContainText('不再出现')
      await expect(researchDelta).toContainText('历史快照')
      await expect(researchDelta).toContainText('当前本地')

      for (const viewport of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
        await window.setViewportSize(viewport)
        const generationStatus = window.getByTestId('industry-research-generation-complete')
        await expect(generationStatus).toBeVisible()
        const statusLayout = await generationStatus.evaluate((element) => ({
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        }))
        expect(statusLayout.scrollWidth).toBeLessThanOrEqual(statusLayout.clientWidth)
        const auditLayout = await researchAudit.evaluate((element) => ({
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        }))
        expect(auditLayout.scrollWidth).toBeLessThanOrEqual(auditLayout.clientWidth)
        const deltaLayout = await researchDelta.evaluate((element) => ({
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        }))
        expect(deltaLayout.scrollWidth).toBeLessThanOrEqual(deltaLayout.clientWidth)
        const pageLayout = await window.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }))
        expect(pageLayout.scrollWidth).toBeLessThanOrEqual(pageLayout.clientWidth)
        if (process.env.FR254_SCREENSHOT_DIR) {
          mkdirSync(process.env.FR254_SCREENSHOT_DIR, { recursive: true })
          await researchAudit.screenshot({
            path: join(process.env.FR254_SCREENSHOT_DIR, `research-evidence-delta-${viewport.width}x${viewport.height}.png`),
          })
        }
      }

      await researchDelta.getByRole('button', { name: '基于变化继续讨论' }).click()
      const evidenceDiscussionContext = window.getByTestId('research-discussion-context')
      await expect(evidenceDiscussionContext).toBeVisible()
      await expect(evidenceDiscussionContext).toContainText('事实变化复核')
      await evidenceDiscussionContext.getByText(/本次带入的上下文/).click()
      await expect(evidenceDiscussionContext).toContainText('历史证据与当前事实变化')
      await expect(window.getByText('输入问题开始讨论')).toBeVisible()
      const discussionDraft = window.locator('textarea[placeholder="继续讨论…"]')
      await expect(discussionDraft).toHaveValue(/请基于这次事实变化重新检验原结论/)

      for (const viewport of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
        await window.setViewportSize(viewport)
        const contextLayout = await evidenceDiscussionContext.evaluate((element) => ({
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        }))
        expect(contextLayout.scrollWidth).toBeLessThanOrEqual(contextLayout.clientWidth)
        const pageLayout = await window.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }))
        expect(pageLayout.scrollWidth).toBeLessThanOrEqual(pageLayout.clientWidth)
        if (process.env.FR254_SCREENSHOT_DIR) {
          await window.screenshot({
            path: join(process.env.FR254_SCREENSHOT_DIR, `research-evidence-discussion-${viewport.width}x${viewport.height}.png`),
          })
        }
      }

      await evidenceDiscussionContext.getByRole('button', { name: '返回来源' }).click()
      await expect(window.locator('[data-testid="industry-research-report-document"]')).toBeVisible()

      await window.locator('[data-testid="industry-research-workspace-scroll"]').getByRole('button', { name: '来源与审计' }).click()
      const nativeSearchAudit = window.locator('[data-testid="industry-research-native-web-search"]')
      await expect(nativeSearchAudit).toContainText('GPT 原生网页搜索已完成')
      await expect(nativeSearchAudit).toContainText('3 次工具动作')
      await nativeSearchAudit.getByText('查看模型工具调用轨迹').click()
      await expect(nativeSearchAudit).toContainText('2026 光通信产业供需')
      const reportSource = window.locator('[data-testid="industry-research-source-e2e-candidate-0"]')
      await reportSource.getByRole('button', { name: '纳入正式证据库' }).click()
      await expect(window.getByRole('status')).toContainText('已纳入项目正式证据库')
      await expect(reportSource).toContainText('已纳入')
      const excludedSource = window.locator('[data-testid="industry-research-source-e2e-candidate-1"]')
      await excludedSource.getByRole('button', { name: '排除此来源' }).click()
      await expect(window.getByRole('status')).toContainText('后续产业研究讨论不会再引用该 URL')
      await expect(excludedSource).toContainText('已排除')

      const crossProjectResult = await window.evaluate(async () => {
        return window.api.industryResearch.confirmEvidenceCandidate('e2e-project-other', 'e2e-candidate-1', 'confirm')
      })
      expect(crossProjectResult).toEqual(expect.objectContaining({ ok: false, code: 'NOT_FOUND' }))

      await expect(window.getByText('候选来源').locator('..')).toContainText('45')
      await expect(window.locator('article[data-testid^="industry-research-source-"]')).toHaveCount(14)
      await window.locator('[data-testid="industry-research-source-filter"]').selectOption('all')
      await expect(window.locator('article[data-testid^="industry-research-source-"]')).toHaveCount(45)
      await window.locator('[data-testid="industry-research-query-audit"]').locator('summary').click()
      await expect(window.getByText('光通信产业 query 0')).toBeVisible()

      await window.getByRole('button', { name: '纳入验证' }).click()
      const companyFinancial = window.locator('[data-testid="industry-research-company-financial"]')
      await expect(companyFinancial).toBeVisible({ timeout: 15000 })
      await expect(companyFinancial).toContainText('中天科技')
      const acceptedCompany = await window.evaluate(async () => {
        const response = await window.api.industryResearch.listCompanies('e2e-project-main') as {
          ok: boolean
          message?: string
          data?: Array<{ company_id: string; securities: Array<{ id: string; ts_code: string }> }>
        }
        if (!response.ok || !response.data?.[0]?.securities?.[0]) {
          throw new Error(response.message || '公司候选纳入后未形成证券上下文')
        }
        return {
          companyId: response.data[0].company_id,
          securityId: response.data[0].securities[0].id,
          tsCode: response.data[0].securities[0].ts_code,
        }
      })
      expect(acceptedCompany.tsCode).toBe('600522.SH')

      await app.close()
      seedIndustryResearchFinancialJourney(
        join(`${userDataDir}-dev`, 'trade-watch.db'),
        acceptedCompany.companyId,
        acceptedCompany.securityId,
      )
      seedIndustryResearchDecisionJourney(
        join(`${userDataDir}-dev`, 'trade-watch.db'),
        acceptedCompany.companyId,
        acceptedCompany.securityId,
      )
      app = await launchApp(userDataDir)
      window = await app.firstWindow()
      await window.waitForLoadState('domcontentloaded')
      await window.locator('[data-testid="nav-tab-ai-analysis"]').click()
      await window.locator('[data-testid="secondary-nav-ai-analysis-industryResearch"]').click()
      await expect(window.locator('[data-testid="industry-research-page"]')).toBeVisible({ timeout: 15000 })
      await window.locator('[data-testid="industry-research-view-companies"]').click()
      await expect(window.locator('[data-testid="industry-research-company-financial"]')).toBeVisible()
      await expect(window.locator(`[data-testid="industry-research-company-${acceptedCompany.companyId}"]`)).toHaveAttribute('aria-pressed', 'true')
      const exposurePanel = window.locator('[data-testid="industry-research-company-exposure"]')
      await expect(exposurePanel).toContainText(/36\.5\s*%/)
      await expect(exposurePanel).toContainText('光通信网络产品')
      await expect(exposurePanel).toContainText('150 条主营构成')
      await expect(exposurePanel).toContainText('16.77亿元')
      await expect(exposurePanel).toContainText('31.87%')
      await expect(exposurePanel).toContainText('中天科技2024年年度报告')
      await expect(exposurePanel.getByText('来源记录键')).not.toBeVisible()
      if (process.env.FR230_SCREENSHOT_DIR) {
        mkdirSync(process.env.FR230_SCREENSHOT_DIR, { recursive: true })
        await window.screenshot({ path: join(process.env.FR230_SCREENSHOT_DIR, 'industry-research-company-exposure-readable.png') })
      }

      await window.locator('[data-testid="industry-research-company-panel-timeline"]').click()
      const incomeRevisions = window.locator('[data-testid="industry-research-financial-revision"]').filter({ hasText: '利润表 · 2024年报' })
      await expect(incomeRevisions).toHaveCount(2)
      await expect(incomeRevisions.first()).toContainText('营业收入')
      await expect(incomeRevisions.first()).toContainText(/原始报告|修订版/)
      await expect(incomeRevisions.first().getByText('版本哈希')).not.toBeVisible()
      await incomeRevisions.first().locator('summary').click()
      await expect(incomeRevisions.first().getByText('版本哈希')).toBeVisible()
      await incomeRevisions.first().locator('summary').click()
      if (process.env.FR230_SCREENSHOT_DIR) {
        await window.screenshot({ path: join(process.env.FR230_SCREENSHOT_DIR, 'industry-research-company-timeline-readable.png') })
      }

      await window.locator('[data-testid="industry-research-company-panel-validation"]').click()
      await expect(window.locator('[data-testid="industry-research-company-validation"]')).toContainText('2024年报')
      await expect(window.locator('[data-testid="industry-research-company-validation"]')).toContainText('80')
      await expect(window.locator('[data-testid="industry-research-company-validation"]')).toContainText('本地事实中缺少预告或快报')

      await window.locator('[data-testid="industry-research-company-panel-bridge"]').click()
      await expect(window.locator('[data-testid="industry-research-profit-bridge"]')).toContainText('V1')
      await expect(window.locator('[data-testid="industry-research-profit-bridge"]')).toContainText('目标利润 = 基期利润 + 价格影响')

      await window.locator('[data-testid="industry-research-company-panel-sync"]').click()
      await expect(window.locator('[data-testid="industry-research-sync-income"]')).toContainText('failed')
      await expect(window.locator('[data-testid="industry-research-sync-income"]')).toContainText('PERMISSION_REQUIRED')
      await expect(window.locator('[data-testid="industry-research-sync-balancesheet"]')).toContainText('success')

      await window.locator('[data-testid="industry-research-view-decision"]').click()
      const decisionWorkbench = window.locator('[data-testid="industry-research-decision-workbench"]')
      await expect(decisionWorkbench).toBeVisible({ timeout: 15000 })
      await expect(window.locator('[data-testid="industry-research-decision-company"]')).toHaveValue(acceptedCompany.companyId)
      await expect(decisionWorkbench).toContainText('共同行情日 2026-07-17')
      await expect(decisionWorkbench).toContainText('12.59 元')

      await decisionWorkbench.getByRole('button', { name: '建立情景' }).click()
      const scenarioDialog = window.getByRole('dialog')
      await expect(scenarioDialog).toContainText('建立情景估值')
      const scenarioValues: Array<{ name: RegExp; values: string[] }> = [
        { name: /悲观/, values: ['5000', '10000', '10'] },
        { name: /基准/, values: ['10000', '10000', '20'] },
        { name: /乐观/, values: ['12000', '10000', '25'] },
      ]
      for (const scenarioInput of scenarioValues) {
        await scenarioDialog.getByRole('tab', { name: scenarioInput.name }).click()
        const valueInputs = scenarioDialog.getByLabel('数值')
        for (let index = 0; index < scenarioInput.values.length; index += 1) {
          await valueInputs.nth(index).fill(scenarioInput.values[index])
        }
      }
      await scenarioDialog.getByRole('button', { name: '保存情景版本' }).click()
      await expect(scenarioDialog).toBeHidden({ timeout: 15000 })
      await expect(decisionWorkbench).toContainText('5.00 元', { timeout: 15000 })
      await expect(decisionWorkbench).toContainText('30.00 元')

      await decisionWorkbench.getByRole('button', { name: '冻结估值' }).click()
      await expect(decisionWorkbench).toContainText('已冻结快照', { timeout: 15000 })
      await decisionWorkbench.getByRole('button', { name: '建立决策' }).click()
      const decisionDialog = window.getByRole('dialog')
      await decisionDialog.getByLabel('研究动作').selectOption('wait_price')
      await decisionDialog.getByLabel('决策依据').fill('当前价格高于悲观情景，等待更好的价格条件。')
      await decisionDialog.getByLabel('失效条件').fill('盈利假设或估值区间失效。')
      await decisionDialog.getByRole('button', { name: '保存决策事件' }).click()
      await expect(decisionDialog).toBeHidden({ timeout: 15000 })
      await expect(decisionWorkbench).toContainText('等待价格', { timeout: 15000 })

      const triggerJourney = await window.evaluate(async () => {
        const projectId = 'e2e-project-main'
        const decisionResponse = await window.api.industryResearch.listDecisions(projectId)
        if (!decisionResponse.ok || !decisionResponse.data?.[0]) throw new Error(decisionResponse.message || '决策未保存')
        const decision = decisionResponse.data[0]
        const monitoringItemId = crypto.randomUUID()
        const monitorResponse = await window.api.industryResearch.saveMonitoringItem({
          projectId, requestId: crypto.randomUUID(), monitoringItemId, expectedVersion: 0,
          name: '光纤价格指数', valueKind: 'number', frequency: 'weekly', sourceName: 'E2E人工观测',
          sourceRef: null, unit: '点', timingType: 'leading', staleAfterMs: 86400000,
          nextReviewAt: Date.now() + 3600000, hypothesisIds: ['e2e-price-hypothesis'],
          scenarioSetVersionIds: [], decisionIds: [decision.decisionId], status: 'active',
        })
        if (!monitorResponse.ok || !monitorResponse.data) throw new Error(monitorResponse.message || '监控项未保存')
        const observationResponse = await window.api.industryResearch.appendMonitoringObservation({
          projectId, requestId: crypto.randomUUID(), monitoringItemId,
          expectedVersion: monitorResponse.data.version, value: 12, unit: '点', sourceRef: 'e2e-local',
          observedAt: Date.now() - 1000, availableAt: Date.now() - 1000,
          dataAsOf: '2026-07-17', methodologyVersion: 'e2e-manual-v1',
        })
        if (!observationResponse.ok) throw new Error(observationResponse.message || '观测未保存')
        const triggerId = crypto.randomUUID()
        const triggerResponse = await window.api.industryResearch.saveDecisionTrigger({
          projectId, requestId: crypto.randomUUID(), triggerId, expectedVersion: 0,
          decisionId: decision.decisionId, monitoringItemId, metricName: '光纤价格指数',
          operator: 'gte', threshold: 10, validationWindowMs: 86400000,
          actionIfNotTriggered: 'wait_price', proposedActionIfTriggered: 'monitor',
          expiresAt: Date.now() + 86400000, status: 'active',
        })
        if (!triggerResponse.ok) throw new Error(triggerResponse.message || '触发器未保存')
        const evaluationResponse = await window.api.industryResearch.evaluateDecisionTriggers({
          projectId, requestId: crypto.randomUUID(), triggerIds: [triggerId],
        })
        if (!evaluationResponse.ok || evaluationResponse.data?.[0]?.result !== 'pending_review') {
          throw new Error(evaluationResponse.message || '触发器未生成待复核')
        }
        return { decisionId: decision.decisionId }
      })
      expect(triggerJourney.decisionId).toBeTruthy()

      await window.locator('[data-testid="industry-research-view-report"]').click()
      await window.locator('[data-testid="industry-research-view-decision"]').click()
      await expect(decisionWorkbench).toBeVisible({ timeout: 15000 })
      await window.locator('[data-testid="industry-research-decision-panel-review"]').click()
      const triggerReview = decisionWorkbench.getByText('触发条件命中，等待人工复核').locator('../..')
      await triggerReview.getByRole('button', { name: '复核并更新决策' }).click()
      const triggerDecisionDialog = window.getByRole('dialog')
      await expect(triggerDecisionDialog.getByLabel('研究动作')).toBeDisabled()
      await expect(triggerDecisionDialog.getByLabel('研究动作')).toHaveValue('monitor')
      await triggerDecisionDialog.getByLabel('决策依据').fill('价格触发条件已命中，后续转为仅跟踪。')
      await triggerDecisionDialog.getByRole('button', { name: '确认触发并追加决策' }).click()
      await expect(triggerDecisionDialog).toBeHidden({ timeout: 15000 })

      await window.locator('[data-testid="industry-research-decision-panel-current"]').click()
      await expect(decisionWorkbench).toContainText('仅跟踪', { timeout: 15000 })
      await window.locator('[data-testid="industry-research-decision-panel-monitoring"]').click()
      await expect(window.locator('[data-testid="industry-research-decision-monitoring"]')).toContainText('已逾期')
      await expect(window.locator('[data-testid="industry-research-decision-monitoring"]')).toContainText('价格回撤后风险收益改善')
      await window.locator('[data-testid="industry-research-decision-panel-history"]').click()
      const historyView = window.locator('[data-testid="industry-research-decision-history"]')
      await historyView.getByRole('button', { name: /仅跟踪/ }).click()
      await expect(historyView).toContainText('决策时点回放')
      await expect(historyView).toContainText('12.59 元')

      await window.locator('[data-testid="industry-research-discuss"]').click()
      await expect(window.locator('[data-testid="research-discussion-context"]')).toBeVisible({ timeout: 15000 })
      await window.locator('[data-testid="research-discussion-context"]').getByRole('button', { name: '返回来源' }).click()
      await expect(window.locator('[data-testid="industry-research-decision-history"]')).toBeVisible({ timeout: 15000 })

      for (const viewport of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
        await window.setViewportSize(viewport)
        for (const panel of ['current', 'review', 'monitoring', 'history'] as const) {
          await window.locator(`[data-testid="industry-research-decision-panel-${panel}"]`).click()
          await expect(window.locator(`[data-testid="industry-research-decision-${panel}"]`)).toBeVisible()
          const panelLayout = await decisionWorkbench.evaluate((element) => ({
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
          }))
          expect(panelLayout.scrollWidth).toBeLessThanOrEqual(panelLayout.clientWidth)
          const pageLayout = await window.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }))
          expect(pageLayout.scrollWidth).toBeLessThanOrEqual(pageLayout.clientWidth)
          if (process.env.FR230_SCREENSHOT_DIR) {
            mkdirSync(process.env.FR230_SCREENSHOT_DIR, { recursive: true })
            await window.screenshot({
              path: join(process.env.FR230_SCREENSHOT_DIR, `industry-research-decision-${panel}-${viewport.width}x${viewport.height}.png`),
            })
          }
        }
      }

      await window.locator('[data-testid="industry-research-view-changes"]').click()
      await expect(window.locator('[data-testid="industry-research-change-sets"]')).toBeVisible()
      await window.locator('[data-testid="industry-research-discuss"]').click()
      const discussionContext = window.locator('[data-testid="research-discussion-context"]')
      await expect(discussionContext).toBeVisible({ timeout: 15000 })
      await expect(discussionContext).toContainText('光通信自动证据研究')
      await discussionContext.getByRole('button', { name: '返回来源' }).click()
      await expect(window.getByRole('heading', { name: '光通信自动证据研究' })).toBeVisible({ timeout: 15000 })
      await expect(window.locator('[data-testid="industry-research-change-sets"]')).toBeVisible()

      await window.locator('[data-testid="industry-research-view-report"]').click()
      await expect(window.locator('[data-testid="industry-research-report-document"]')).toBeVisible()
      const researchScrollTop = await window.locator('[data-testid="industry-research-workspace-scroll"]').evaluate((element) => {
        const target = Math.min(320, Math.max(0, element.scrollHeight - element.clientHeight))
        element.scrollTop = target
        return element.scrollTop
      })
      expect(researchScrollTop).toBeGreaterThan(0)
      await window.locator('[data-testid="industry-research-discuss"]').click()
      await expect(window.locator('[data-testid="research-discussion-context"]')).toBeVisible({ timeout: 15000 })
      await window.locator('[data-testid="research-discussion-context"]').getByRole('button', { name: '返回来源' }).click()
      await expect(window.locator('[data-testid="industry-research-report-document"]')).toBeVisible({ timeout: 15000 })
      await expect.poll(async () => {
        const restored = await window.locator('[data-testid="industry-research-workspace-scroll"]').evaluate((element) => element.scrollTop)
        return Math.abs(restored - researchScrollTop)
      }).toBeLessThanOrEqual(1)

      for (const viewport of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
        await window.setViewportSize(viewport)
        await window.locator('[data-testid="industry-research-view-companies"]').click()
        await expect(window.locator('[data-testid="industry-research-company-financial"]')).toBeVisible()
        await window.locator('[data-testid="industry-research-company-panel-exposure"]').click()
        await expect(window.locator('[data-testid="industry-research-company-exposure"]')).toBeVisible()
        await expect(window.getByTestId('industry-research-exposure-trend-chart')).toBeVisible()
        const exposureMatrix = window.getByTestId('industry-research-exposure-matrix-chart')
        await expect(exposureMatrix).toBeVisible()
        const longestUnexpectedLegendLine = await exposureMatrix.locator('canvas').evaluate((canvas) => {
          const context = (canvas as HTMLCanvasElement).getContext('2d')
          if (!context) return Number.POSITIVE_INFINITY
          const { width, height } = canvas as HTMLCanvasElement
          const clientHeight = Math.max(1, canvas.getBoundingClientRect().height)
          const pixels = context.getImageData(0, 0, width, height).data
          let longest = 0
          for (let x = Math.floor(width * 0.12); x < Math.floor(width * 0.88); x += 1) {
            let run = 0
            for (let y = Math.floor(height * 0.72); y < height; y += 1) {
              const index = (y * width + x) * 4
              const red = pixels[index]
              const green = pixels[index + 1]
              const blue = pixels[index + 2]
              const alpha = pixels[index + 3]
              const cyan = alpha > 0 && blue > red + 25 && green > red + 15
              run = cyan ? run + 1 : 0
              longest = Math.max(longest, run)
            }
          }
          return longest / (height / clientHeight)
        })
        expect(longestUnexpectedLegendLine).toBeLessThan(36)
        if (process.env.FR230_SCREENSHOT_DIR) {
          mkdirSync(process.env.FR230_SCREENSHOT_DIR, { recursive: true })
          await window.screenshot({
            path: join(process.env.FR230_SCREENSHOT_DIR, `industry-research-company-exposure-${viewport.width}x${viewport.height}.png`),
          })
          if (viewport.width === 1440) {
            await exposureMatrix.scrollIntoViewIfNeeded()
            await window.screenshot({
              path: join(process.env.FR230_SCREENSHOT_DIR, 'industry-research-company-exposure-matrix-1440x900.png'),
            })
          }
        }
        await window.locator('[data-testid="industry-research-company-panel-timeline"]').click()
        await expect(window.locator('[data-testid="industry-research-company-timeline"]')).toBeVisible()
        if (process.env.FR230_SCREENSHOT_DIR) {
          await window.screenshot({
            path: join(process.env.FR230_SCREENSHOT_DIR, `industry-research-company-timeline-${viewport.width}x${viewport.height}.png`),
          })
        }
        if (viewport.width === 1440) {
          await window.evaluate(() => document.documentElement.classList.add('dark'))
          if (process.env.FR230_SCREENSHOT_DIR) {
            await window.screenshot({
              path: join(process.env.FR230_SCREENSHOT_DIR, 'industry-research-company-timeline-dark-1440x900.png'),
            })
          }
          await window.evaluate(() => document.documentElement.classList.remove('dark'))
        }
        await window.locator('[data-testid="industry-research-company-panel-validation"]').click()
        if (process.env.FR230_SCREENSHOT_DIR) {
          mkdirSync(process.env.FR230_SCREENSHOT_DIR, { recursive: true })
          await window.screenshot({
            path: join(process.env.FR230_SCREENSHOT_DIR, `industry-research-company-financial-${viewport.width}x${viewport.height}.png`),
          })
        }
        const companyLayout = await window.locator('[data-testid="industry-research-company-financial"]').evaluate((element) => ({
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        }))
        expect(companyLayout.scrollWidth).toBeLessThanOrEqual(companyLayout.clientWidth)
        await window.locator('[data-testid="industry-research-view-changes"]').click()
        await expect(window.locator('[data-testid="industry-research-change-sets"]')).toBeVisible()
        if (process.env.FR230_SCREENSHOT_DIR) {
          mkdirSync(process.env.FR230_SCREENSHOT_DIR, { recursive: true })
          await window.screenshot({
            path: join(process.env.FR230_SCREENSHOT_DIR, `industry-research-changes-${viewport.width}x${viewport.height}.png`),
          })
        }
        await window.locator('[data-testid="industry-research-discuss"]').click()
        await expect(window.locator('[data-testid="research-discussion-context"]')).toBeVisible({ timeout: 15000 })
        if (process.env.FR230_SCREENSHOT_DIR) {
          await window.screenshot({
            path: join(process.env.FR230_SCREENSHOT_DIR, `research-discussion-${viewport.width}x${viewport.height}.png`),
          })
        }
        await window.locator('[data-testid="research-discussion-context"]').getByRole('button', { name: '返回来源' }).click()
        await expect(window.locator('[data-testid="industry-research-change-sets"]')).toBeVisible({ timeout: 15000 })
        await window.locator('[data-testid="industry-research-view-report"]').click()
        await expect(window.locator('[data-testid="industry-research-report-document"]')).toBeVisible()
        if (process.env.FR230_SCREENSHOT_DIR) {
          mkdirSync(process.env.FR230_SCREENSHOT_DIR, { recursive: true })
          await window.screenshot({
            path: join(process.env.FR230_SCREENSHOT_DIR, `industry-research-${viewport.width}x${viewport.height}.png`),
          })
        }
        const layout = await window.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }))
        expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth)
      }

      await app.close()
      app = await launchApp(userDataDir)
      window = await app.firstWindow()
      await window.waitForLoadState('domcontentloaded')
      await window.locator('[data-testid="nav-tab-ai-analysis"]').click()
      await window.locator('[data-testid="secondary-nav-ai-analysis-industryResearch"]').click()
      await window.locator('[data-testid="industry-research-view-review"]').click()
      await expect(window.locator('[data-testid="industry-research-source-e2e-candidate-0"]')).toContainText('已纳入', { timeout: 15000 })
      await expect(window.locator('[data-testid="industry-research-source-e2e-candidate-1"]')).toContainText('已排除')
      await window.locator('[data-testid="industry-research-view-companies"]').click()
      await expect(window.locator('[data-testid="industry-research-company-exposure"]')).toContainText(/36\.5\s*%/, { timeout: 15000 })
      await window.locator('[data-testid="industry-research-company-panel-sync"]').click()
      await expect(window.locator('[data-testid="industry-research-sync-income"]')).toContainText('PERMISSION_REQUIRED')
      await window.locator('[data-testid="industry-research-view-decision"]').click()
      await expect(window.locator('[data-testid="industry-research-decision-workbench"]')).toBeVisible({ timeout: 15000 })
      await window.locator('[data-testid="industry-research-decision-panel-history"]').click()
      const restoredHistory = window.locator('[data-testid="industry-research-decision-history"]')
      await expect(restoredHistory.getByRole('button', { name: /仅跟踪/ })).toBeVisible()
      await restoredHistory.getByRole('button', { name: /仅跟踪/ }).click()
      await expect(restoredHistory).toContainText('12.59 元')
      const persisted = await window.evaluate(async () => window.api.industryResearch.getProject('e2e-project-main'))
      expect(persisted).toEqual(expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          evidence: [expect.objectContaining({ statement_kind: 'estimate', primary_source_confirmed: 0 })],
        }),
      }))
    } finally {
      await app.close().catch(() => {})
      rmSync(userDataDir, { recursive: true, force: true })
      rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
    }
  })
})
