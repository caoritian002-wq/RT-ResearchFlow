import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import {
  saveResearchCompany,
  saveResearchFinancialFacts,
  saveResearchProjectCompany,
} from '../../electron/main/database/industryResearchFinancialRepository'
import { createResearchProject } from '../../electron/main/database/industryResearchRepository'
import { saveIndustryResearchProfitBridge } from '../../electron/main/services/industryResearchProfitBridgeService'

describe('产业研究利润桥服务', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    createResearchProject(db, {
      id: 'project-1', title: '公司利润研究', industryName: '半导体', productScope: '设备',
      regionScope: '中国', timeScope: '2024-2026', purpose: 'investment', depth: 'standard',
      sourceType: 'manual', skillId: 'builtin:industry-chain-research', skillContentHash: 'a'.repeat(64),
    })
    saveResearchCompany(db, {
      id: 'company-1', legalName: '示例科技股份有限公司', sourceType: 'manual',
    }, 100)
    saveResearchProjectCompany(db, {
      projectId: 'project-1', companyId: 'company-1', status: 'core',
    }, 110)
    saveResearchFinancialFacts(db, [{
      id: 'fact-1', companyId: 'company-1', sourceApi: 'income', sourceFactKey: 'income-1',
      sourceVersion: 'v1', metricName: 'revenue', metricValue: 100, reportPeriod: '20241231', fetchedAt: 120,
    }])
  })

  it('资料不足的假设桥保持hypothesis且不伪装估算', () => {
    const saved = saveIndustryResearchProfitBridge(db, 'project-1', 'company-1', {
      bridgeKey: 'annual-profit', basePeriod: '20231231', targetPeriod: '20241231', status: 'hypothesis',
      items: [{ key: 'volume', label: '销量', amount: null }], createdBy: 'human',
    }, null, 200)

    expect(saved).toMatchObject({ status: 'hypothesis', version: 1 })
  })

  it('estimate必须具备透明公式、非空桥接项和同公司输入事实', () => {
    expect(() => saveIndustryResearchProfitBridge(db, 'project-1', 'company-1', {
      bridgeKey: 'annual-profit', basePeriod: '20231231', targetPeriod: '20241231', status: 'estimate',
      formula: '销量影响', items: [{ key: 'volume', label: '销量', amount: 10 }], createdBy: 'human',
    }, null, 200)).toThrow('估算利润桥缺少透明公式、非空桥接项或输入事实')

    const saved = saveIndustryResearchProfitBridge(db, 'project-1', 'company-1', {
      bridgeKey: 'annual-profit', basePeriod: '20231231', targetPeriod: '20241231', status: 'estimate',
      formula: '销量影响', inputFactIds: ['fact-1'],
      items: [{ key: 'volume', label: '销量', amount: 10 }], createdBy: 'human',
    }, null, 210)
    expect(saved).toMatchObject({ status: 'estimate', version: 1, inputFactIds: ['fact-1'] })
  })

  it('更新使用expectedUpdatedAt并只追加新版本', () => {
    const first = saveIndustryResearchProfitBridge(db, 'project-1', 'company-1', {
      bridgeKey: 'annual-profit', basePeriod: '20231231', targetPeriod: '20241231', status: 'hypothesis',
      items: [{ key: 'volume', label: '销量', amount: 10 }], createdBy: 'human',
    }, null, 200)

    expect(() => saveIndustryResearchProfitBridge(db, 'project-1', 'company-1', {
      bridgeKey: 'annual-profit', basePeriod: '20231231', targetPeriod: '20241231', status: 'hypothesis',
      items: [{ key: 'volume', label: '销量', amount: 12 }], createdBy: 'human',
    }, 199, 210)).toThrow('利润桥版本已变化')

    const second = saveIndustryResearchProfitBridge(db, 'project-1', 'company-1', {
      bridgeKey: 'annual-profit', basePeriod: '20231231', targetPeriod: '20241231', status: 'hypothesis',
      items: [{ key: 'volume', label: '销量', amount: 12 }], createdBy: 'human',
    }, first.updatedAt, 220)
    expect(second).toMatchObject({ version: 2 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM industry_research_profit_bridges').get()).toEqual({ count: 2 })
  })
})
