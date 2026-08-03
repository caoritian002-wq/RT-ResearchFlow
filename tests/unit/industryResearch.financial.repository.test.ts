import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import { createResearchProject } from '../../electron/main/database/industryResearchRepository'
import {
  listResearchFinancialFacts,
  listResearchFinancialTimelineFacts,
  listResearchBusinessExposures,
  listResearchDisclosureEvidence,
  listResearchProfitBridgeItems,
  listResearchProjectCompanies,
  listResearchProjectStockCodes,
  listResearchSecurities,
  recordResearchFinancialSyncFailure,
  recordResearchFinancialSyncSuccess,
  saveResearchBusinessExposure,
  saveResearchCompany,
  saveResearchDisclosureEvidence,
  saveResearchFinancialFacts,
  saveResearchMainBusinessItem,
  saveResearchProfitBridgeVersion,
  saveResearchProjectCompany,
  saveResearchSecurity,
} from '../../electron/main/database/industryResearchFinancialRepository'

describe('产业研究公司与财务事实仓库', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    createResearchProject(db, {
      id: 'project-1',
      title: '公司事实研究',
      industryName: '半导体',
      productScope: '设备',
      regionScope: '中国',
      timeScope: '2024-2026',
      purpose: 'investment',
      depth: 'standard',
      sourceType: 'manual',
      skillId: 'builtin:industry-chain-research',
      skillContentHash: 'a'.repeat(64),
    })
    saveResearchCompany(db, {
      id: 'company-1',
      legalName: '示例科技股份有限公司',
      shortName: '示例科技',
      sourceType: 'manual',
    }, 100)
  })

  it('一家公司可映射多个证券且保留各自有效期', () => {
    saveResearchSecurity(db, {
      id: 'security-a', companyId: 'company-1', tsCode: '600001.SH', exchange: 'SSE',
      securityType: 'A_SHARE', listDate: '20010101', mappingSource: 'tushare',
    }, 110)
    saveResearchSecurity(db, {
      id: 'security-b', companyId: 'company-1', tsCode: '000001.HK', exchange: 'HKEX',
      securityType: 'H_SHARE', listDate: '20050101', delistDate: '20250101', mappingSource: 'manual',
    }, 120)

    expect(listResearchSecurities(db, 'company-1')).toMatchObject([
      { id: 'security-b', ts_code: '000001.HK', list_date: '20050101', delist_date: '20250101' },
      { id: 'security-a', ts_code: '600001.SH', list_date: '20010101', delist_date: null },
    ])
  })

  it('共享事实只选择项目内未排除的A股证券', () => {
    saveResearchSecurity(db, {
      id: 'security-a', companyId: 'company-1', tsCode: '600001.SH', exchange: 'SSE',
      securityType: 'A_SHARE', mappingSource: 'tushare',
    }, 110)
    saveResearchSecurity(db, {
      id: 'security-h', companyId: 'company-1', tsCode: '000001.HK', exchange: 'HKEX',
      securityType: 'H_SHARE', mappingSource: 'manual',
    }, 120)
    saveResearchProjectCompany(db, {
      projectId: 'project-1', companyId: 'company-1', status: 'candidate',
    }, 130)

    expect(listResearchProjectStockCodes(db, 'project-1')).toEqual(['600001.SH'])

    saveResearchProjectCompany(db, {
      projectId: 'project-1', companyId: 'company-1', status: 'excluded',
      exclusionReason: '不属于当前研究范围',
    }, 140)
    expect(listResearchProjectStockCodes(db, 'project-1')).toEqual([])
  })

  it('相同来源版本幂等且新修订版本不会覆盖旧事实', () => {
    const base = {
      companyId: 'company-1',
      sourceApi: 'income',
      sourceFactKey: '600001.SH:20241231:1:0',
      metricName: 'revenue',
      reportPeriod: '20241231',
      statementType: '1',
      updateFlag: '0',
      fetchedAt: 200,
    }
    saveResearchFinancialFacts(db, [{ ...base, id: 'fact-v1', sourceVersion: 'v1', metricValue: 100 }], 200)
    saveResearchFinancialFacts(db, [{ ...base, id: 'duplicate', sourceVersion: 'v1', metricValue: 999 }], 210)
    saveResearchFinancialFacts(db, [{ ...base, id: 'fact-v2', sourceVersion: 'v2', updateFlag: '1', metricValue: 120 }], 220)

    expect(listResearchFinancialFacts(db, 'company-1')).toMatchObject([
      { id: 'fact-v1', source_version: 'v1', metric_value: 100 },
      { id: 'fact-v2', source_version: 'v2', metric_value: 120 },
    ])
  })

  it('同报告期不同报表类型和来源接口可并存', () => {
    saveResearchFinancialFacts(db, [
      {
        id: 'income-fact', companyId: 'company-1', sourceApi: 'income', sourceFactKey: 'income-key',
        sourceVersion: 'original', metricName: 'net_profit', metricValue: 10, reportPeriod: '20241231',
        statementType: '1', updateFlag: '0', fetchedAt: 200,
      },
      {
        id: 'express-fact', companyId: 'company-1', sourceApi: 'express', sourceFactKey: 'express-key',
        sourceVersion: 'latest', metricName: 'net_profit', metricValue: 9, reportPeriod: '20241231',
        statementType: 'express', updateFlag: '1', fetchedAt: 210,
      },
    ])

    expect(listResearchFinancialFacts(db, 'company-1').map((row) => row.source_api).sort())
      .toEqual(['express', 'income'])
  })

  it('财务时间轴组合筛选保持证券、数据集和公告日期参数顺序', () => {
    saveResearchSecurity(db, {
      id: 'security-a', companyId: 'company-1', tsCode: '600001.SH', exchange: 'SSE',
      securityType: 'A_SHARE', mappingSource: 'tushare',
    }, 110)
    saveResearchSecurity(db, {
      id: 'security-b', companyId: 'company-1', tsCode: '000001.HK', exchange: 'HKEX',
      securityType: 'H_SHARE', mappingSource: 'manual',
    }, 120)
    saveResearchFinancialFacts(db, [
      {
        id: 'matched-income', companyId: 'company-1', securityId: 'security-a', sourceApi: 'income',
        sourceFactKey: 'matched-income', sourceVersion: 'v1', metricName: 'revenue', metricValue: 100,
        reportPeriod: '20241231', annDate: '20250110', fAnnDate: '20250112', fetchedAt: 200,
      },
      {
        id: 'wrong-dataset', companyId: 'company-1', securityId: 'security-a', sourceApi: 'cashflow',
        sourceFactKey: 'wrong-dataset', sourceVersion: 'v1', metricName: 'net_cashflow_operate', metricValue: 20,
        reportPeriod: '20241231', annDate: '20250111', fetchedAt: 200,
      },
      {
        id: 'wrong-security', companyId: 'company-1', securityId: 'security-b', sourceApi: 'income',
        sourceFactKey: 'wrong-security', sourceVersion: 'v1', metricName: 'revenue', metricValue: 90,
        reportPeriod: '20241231', annDate: '20250112', fetchedAt: 200,
      },
      {
        id: 'outside-date', companyId: 'company-1', securityId: 'security-a', sourceApi: 'income',
        sourceFactKey: 'outside-date', sourceVersion: 'v1', metricName: 'net_profit', metricValue: 10,
        reportPeriod: '20240930', annDate: '20241020', fetchedAt: 200,
      },
    ])

    expect(listResearchFinancialTimelineFacts(db, {
      companyId: 'company-1',
      securityId: 'security-a',
      datasets: ['income'],
      fromAnnouncementDate: '20250101',
      toAnnouncementDate: '20250131',
    })).toMatchObject([
      { id: 'matched-income', ts_code: '600001.SH', f_ann_date: '20250112' },
    ])
  })

  it('自动主营条目只能形成候选且不能覆盖人工确认暴露', () => {
    const item = saveResearchMainBusinessItem(db, {
      id: 'main-1', companyId: 'company-1', sourceApi: 'fina_mainbz', sourceFactKey: 'main-key',
      sourceVersion: 'v1', reportPeriod: '20241231', dimension: 'product', itemName: '刻蚀设备',
      revenue: 100, fetchedAt: 200,
    }, 200)
    expect(item.item_name).toBe('刻蚀设备')
    expect(() => saveResearchBusinessExposure(db, {
      id: 'auto-invalid', projectId: 'project-1', companyId: 'company-1',
      mainBusinessItemId: item.id, sourceKey: 'main-key', sourceType: 'fina_mainbz',
      status: 'confirmed', basis: '自动主营构成', createdBy: 'import',
    })).toThrow('AUTO_EXPOSURE_MUST_BE_CANDIDATE')

    saveResearchBusinessExposure(db, {
      id: 'manual-1', projectId: 'project-1', companyId: 'company-1', sourceKey: 'manual-key',
      sourceType: 'manual', status: 'not_separable', basis: '业务无法可靠拆分', createdBy: 'human',
    }, 210)
    expect(() => saveResearchBusinessExposure(db, {
      id: 'import-1', projectId: 'project-1', companyId: 'company-1', sourceKey: 'manual-key',
      sourceType: 'manual', status: 'candidate', basis: '自动更新', createdBy: 'import',
    }, 220)).toThrow('MANUAL_EXPOSURE_PROTECTED')
  })

  it('确认暴露必须绑定同公司的人工确认官方来源', () => {
    expect(() => saveResearchBusinessExposure(db, {
      id: 'confirmed-1', projectId: 'project-1', companyId: 'company-1', sourceKey: 'confirmed-key',
      sourceType: 'manual', status: 'confirmed', basis: '公告确认', createdBy: 'human',
    })).toThrow('CONFIRMED_EXPOSURE_REQUIRES_EVIDENCE')

    saveResearchDisclosureEvidence(db, {
      id: 'evidence-1', companyId: 'company-1', projectId: 'project-1', title: '年度报告',
      sourceUrl: 'https://example.com/official.pdf', createdBy: 'human', primarySourceConfirmed: true,
    }, 200)
    expect(saveResearchBusinessExposure(db, {
      id: 'confirmed-1', projectId: 'project-1', companyId: 'company-1', evidenceId: 'evidence-1',
      sourceKey: 'confirmed-key', sourceType: 'manual', status: 'confirmed', basis: '公告确认', createdBy: 'human',
    }, 210)).toMatchObject({ status: 'confirmed', evidence_id: 'evidence-1' })
  })

  it('公告证据按项目公司隔离并优先实际发布日期倒序', () => {
    createResearchProject(db, {
      id: 'project-2', title: '另一项目', industryName: '半导体', productScope: '材料',
      regionScope: '中国', timeScope: '2024-2026', purpose: 'investment', depth: 'standard',
      sourceType: 'manual', skillId: 'builtin:industry-chain-research', skillContentHash: 'b'.repeat(64),
    })
    saveResearchCompany(db, {
      id: 'company-2', legalName: '另一家公司', sourceType: 'manual',
    }, 100)
    saveResearchDisclosureEvidence(db, {
      id: 'shared-old', companyId: 'company-1', title: '共享年度报告',
      sourceUrl: 'https://example.com/shared.pdf', publishedDate: '2024-03-01',
      actualPublishedDate: '2024-03-02', createdBy: 'human', primarySourceConfirmed: true,
    }, 200)
    saveResearchDisclosureEvidence(db, {
      id: 'project-new', companyId: 'company-1', projectId: 'project-1', title: '项目业绩公告',
      sourceUrl: 'https://example.com/project.pdf', publishedDate: '2024-02-01',
      actualPublishedDate: '2024-04-01', createdBy: 'human', primarySourceConfirmed: true,
    }, 210)
    saveResearchDisclosureEvidence(db, {
      id: 'other-project', companyId: 'company-1', projectId: 'project-2', title: '其他项目证据',
      sourceUrl: 'https://example.com/other-project.pdf', publishedDate: '2024-05-01',
      createdBy: 'human', primarySourceConfirmed: true,
    }, 220)
    saveResearchDisclosureEvidence(db, {
      id: 'other-company', companyId: 'company-2', projectId: 'project-2', title: '其他公司证据',
      sourceUrl: 'https://example.com/other-company.pdf', publishedDate: '2024-06-01',
      createdBy: 'human', primarySourceConfirmed: true,
    }, 230)

    expect(listResearchDisclosureEvidence(db, 'project-1', 'company-1')).toMatchObject([
      { id: 'project-new', actual_published_date: '2024-04-01' },
      { id: 'shared-old', actual_published_date: '2024-03-02' },
    ])
  })

  it('派生事实缺少公式或输入版本时整批回滚', () => {
    expect(() => saveResearchFinancialFacts(db, [
      {
        id: 'reported', companyId: 'company-1', sourceApi: 'income', sourceFactKey: 'reported-key',
        sourceVersion: 'v1', metricName: 'revenue', metricValue: 100, reportPeriod: '20240930', fetchedAt: 200,
      },
      {
        id: 'derived', companyId: 'company-1', sourceApi: 'derived_quarter', sourceFactKey: 'derived-key',
        sourceVersion: 'v1', metricName: 'revenue_q3', metricValue: 30, reportPeriod: '20240930',
        factKind: 'derived', fetchedAt: 200,
      },
    ])).toThrow('DERIVED_FACT_REQUIRES_PROVENANCE')
    expect(listResearchFinancialFacts(db, 'company-1')).toEqual([])
  })

  it('同步失败保留最后成功事实和成功状态字段', () => {
    const success = recordResearchFinancialSyncSuccess(db, 'company-1', 'income', '20241231', 12, 300)
    expect(success).toMatchObject({ status: 'success', last_success_at: 300, last_success_row_count: 12 })

    const failed = recordResearchFinancialSyncFailure(db, 'company-1', 'income', 'UPSTREAM_ERROR', 400)
    expect(failed).toMatchObject({
      status: 'failed',
      last_attempt_at: 400,
      last_success_at: 300,
      last_success_fact_date: '20241231',
      last_success_row_count: 12,
      last_error_code: 'UPSTREAM_ERROR',
    })
  })

  it('删除项目不会删除共享公司和财务事实', () => {
    saveResearchFinancialFacts(db, [{
      id: 'fact-1', companyId: 'company-1', sourceApi: 'income', sourceFactKey: 'fact-key',
      sourceVersion: 'v1', metricName: 'revenue', metricValue: 100, reportPeriod: '20241231', fetchedAt: 200,
    }])
    db.prepare('DELETE FROM industry_research_projects WHERE id = ?').run('project-1')

    expect(db.prepare('SELECT COUNT(*) AS count FROM industry_research_companies').get())
      .toEqual({ count: 1 })
    expect(listResearchFinancialFacts(db, 'company-1')).toHaveLength(1)
  })

  it('Migration 101建立项目公司状态和版本化利润桥结构', () => {
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'industry_research_project_companies',
        'industry_research_profit_bridges',
        'industry_research_profit_bridge_items'
      ) ORDER BY name
    `).all()).toEqual([
      { name: 'industry_research_profit_bridge_items' },
      { name: 'industry_research_profit_bridges' },
      { name: 'industry_research_project_companies' },
    ])

    const exposureColumns = db.prepare('PRAGMA table_info(industry_research_business_exposures)')
      .all() as Array<{ name: string }>
    expect(exposureColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'fact_date',
      'evidence_ids_json',
      'methodology',
    ]))
  })

  it('项目公司状态、暴露证据和方法可完整往返', () => {
    saveResearchProjectCompany(db, {
      projectId: 'project-1', companyId: 'company-1', status: 'core', evidenceIds: ['evidence-1'],
    }, 500)
    saveResearchMainBusinessItem(db, {
      id: 'main-business-1', companyId: 'company-1', sourceApi: 'fina_mainbz',
      sourceFactKey: 'main-business-key', sourceVersion: 'main-business-version', reportPeriod: '20241231',
      dimension: 'product', itemName: '高端覆铜板', revenue: 1_200_000_000, cost: 900_000_000,
      profit: 300_000_000, currency: 'CNY', fetchedAt: 505,
    }, 505)
    saveResearchBusinessExposure(db, {
      id: 'exposure-1', projectId: 'project-1', companyId: 'company-1', sourceKey: 'manual-1',
      sourceType: 'manual', status: 'candidate', basis: '产品收入映射', createdBy: 'human',
      mainBusinessItemId: 'main-business-1', factDate: '20241231', evidenceIds: ['evidence-1', 'evidence-2'],
      methodology: '按公开产品口径映射',
    }, 510)

    expect(listResearchProjectCompanies(db, 'project-1')).toMatchObject([
      { company_id: 'company-1', status: 'core', legal_name: '示例科技股份有限公司' },
    ])
    expect(listResearchBusinessExposures(db, 'project-1')).toMatchObject([
      {
        id: 'exposure-1', fact_date: '20241231', evidence_ids_json: '["evidence-1","evidence-2"]',
        methodology: '按公开产品口径映射', main_business_item_name: '高端覆铜板',
        main_business_report_period: '20241231', main_business_revenue: 1_200_000_000,
        main_business_cost: 900_000_000, main_business_profit: 300_000_000,
        main_business_currency: 'CNY', main_business_source_api: 'fina_mainbz',
      },
    ])
  })

  it('利润桥新版本只追加并保留旧版本和明细', () => {
    saveResearchProjectCompany(db, {
      projectId: 'project-1', companyId: 'company-1', status: 'core',
    }, 500)
    const first = saveResearchProfitBridgeVersion(db, {
      id: 'bridge-v1', projectId: 'project-1', companyId: 'company-1', bridgeKey: 'annual-profit',
      basePeriod: '20231231', targetPeriod: '20241231', status: 'hypothesis', createdBy: 'human', version: 1,
      items: [{ id: 'item-v1', key: 'volume', label: '销量', amount: 10, sortOrder: 0 }],
    }, 510)
    const second = saveResearchProfitBridgeVersion(db, {
      id: 'bridge-v2', projectId: 'project-1', companyId: 'company-1', bridgeKey: 'annual-profit',
      basePeriod: '20231231', targetPeriod: '20241231', status: 'estimate', createdBy: 'human', version: 2,
      previousVersionId: first.id, formula: '销量影响 + 价格影响', inputFactIds: ['fact-1'],
      items: [{ id: 'item-v2', key: 'volume', label: '销量', amount: 12, sortOrder: 0 }],
    }, 520)

    expect(second).toMatchObject({ version: 2, previous_version_id: 'bridge-v1' })
    expect(db.prepare('SELECT id, version FROM industry_research_profit_bridges ORDER BY version').all())
      .toEqual([{ id: 'bridge-v1', version: 1 }, { id: 'bridge-v2', version: 2 }])
    expect(listResearchProfitBridgeItems(db, 'bridge-v1')).toMatchObject([
      { id: 'item-v1', amount: 10 },
    ])
  })
})
