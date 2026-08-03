import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import {
  saveResearchCompany,
  saveResearchFinancialFacts,
  saveResearchProjectCompany,
  saveResearchSecurity,
} from '../../electron/main/database/industryResearchFinancialRepository'
import { createResearchProject } from '../../electron/main/database/industryResearchRepository'
import {
  buildProjectBusinessExposureReportContext,
  buildProjectFinancialReportContext,
} from '../../electron/main/services/industryResearchGenerationService'

describe('产业研究报告本地财务上下文', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    createResearchProject(db, {
      id: 'project-1', title: 'PCB涨价验证', industryName: 'PCB', productScope: '覆铜板与PCB',
      regionScope: '中国', timeScope: '2025-2026', purpose: 'investment', depth: 'standard',
      sourceType: 'manual', skillId: 'builtin:industry-chain-research', skillContentHash: 'a'.repeat(64),
    })
    saveResearchCompany(db, { id: 'company-1', legalName: '方正科技', sourceType: 'manual' }, 100)
    saveResearchSecurity(db, {
      id: 'security-1', companyId: 'company-1', tsCode: '600601.SH', exchange: 'SSE',
      securityType: 'A_SHARE', mappingSource: 'tushare',
    }, 100)
    saveResearchProjectCompany(db, { projectId: 'project-1', companyId: 'company-1', status: 'candidate' }, 100)
  })

  it('只注入研究基准日前已知且与候选公司匹配的财务事实', () => {
    saveResearchFinancialFacts(db, [
      {
        id: 'q1-revenue', companyId: 'company-1', securityId: 'security-1', sourceApi: 'income',
        sourceFactKey: 'q1', sourceVersion: 'v1', metricName: 'revenue', metricValue: 156,
        reportPeriod: '20260331', annDate: '20260428', fetchedAt: 200,
      },
      {
        id: 'h1-forecast', companyId: 'company-1', securityId: 'security-1', sourceApi: 'forecast',
        sourceFactKey: 'h1-forecast', sourceVersion: 'v1', metricName: 'net_profit_min', metricValue: 51000,
        reportPeriod: '20260630', annDate: '20260711', fetchedAt: 210,
      },
      {
        id: 'h1-future-actual', companyId: 'company-1', securityId: 'security-1', sourceApi: 'income',
        sourceFactKey: 'h1-actual', sourceVersion: 'v1', metricName: 'revenue', metricValue: 999,
        reportPeriod: '20260630', annDate: '20260826', fetchedAt: 220,
      },
    ])

    const result = buildProjectFinancialReportContext(db, 'project-1', '2026-07-20', ['方正科技'])
    const serialized = JSON.stringify(result)
    expect(result).toHaveLength(1)
    expect(serialized).toContain('600601.SH')
    expect(serialized).toContain('net_profit_min')
    expect(serialized).toContain('51000')
    expect(serialized).toContain('20260428')
    expect(serialized).not.toContain('999')
    expect(serialized).not.toContain('20260826')
  })

  it('把最新主营构成作为待确认业务暴露上下文提供给报告', () => {
    db.prepare(`
      INSERT INTO industry_research_main_business_items (
        id, company_id, source_api, source_fact_key, source_version, report_period,
        dimension, item_code, item_name, revenue, cost, profit, currency, fetched_at, created_at
      ) VALUES ('main-1', 'company-1', 'fina_mainbz', 'source-1', 'v1', '20251231',
        'product', NULL, '高多层板', 120, 80, 40, 'CNY', 300, 300)
    `).run()
    db.prepare(`
      INSERT INTO industry_research_business_exposures (
        id, project_id, company_id, research_node_id, main_business_item_id, evidence_id,
        source_key, source_type, status, exposure_pct, basis, created_by, fact_date,
        evidence_ids_json, methodology, created_at, updated_at
      ) VALUES ('exposure-1', 'project-1', 'company-1', NULL, 'main-1', NULL,
        'source-1', 'fina_mainbz', 'candidate', NULL, 'Tushare 主营构成候选', 'import',
        NULL, '[]', NULL, 300, 300)
    `).run()

    expect(buildProjectBusinessExposureReportContext(db, 'project-1', ['600601.SH']))
      .toMatchObject([{
        legalName: '方正科技',
        reportPeriod: '20251231',
        items: [{ name: '高多层板', revenue: 120, status: 'candidate', source: 'tushare:fina_mainbz' }],
      }])
  })
})
