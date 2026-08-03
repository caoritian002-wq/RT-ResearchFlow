import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import {
  getResearchFinancialSyncState,
  listResearchBusinessExposures,
  saveResearchCompany,
  saveResearchProjectCompany,
  saveResearchSecurity,
} from '../../electron/main/database/industryResearchFinancialRepository'
import { createResearchProject } from '../../electron/main/database/industryResearchRepository'
import { collectIndustryResearchProjectFinancials } from '../../electron/main/services/industryResearchFinancialCollectionService'
import type { IndustryResearchFinancialFetchers } from '../../electron/main/services/industryResearchFinancialSyncService'
import type { TushareFinancialRow } from '../../electron/main/services/tushareService'

function row(values: Record<string, string | number | null> = { revenue: 100 }): TushareFinancialRow {
  return {
    tsCode: '002463.SZ',
    annDate: '20260428',
    fAnnDate: '20260428',
    endDate: '20260331',
    reportType: '1',
    compType: '1',
    updateFlag: '0',
    values,
  }
}

function fetchers(failing: string[] = []): IndustryResearchFinancialFetchers {
  const build = (dataset: string) => vi.fn().mockResolvedValue(
    failing.includes(dataset)
      ? []
      : [row(dataset === 'fina_mainbz'
        ? { bz_item: '企业通讯市场板', bz_sales: 80, bz_profit: 12, bz_cost: 68, curr_type: 'CNY' }
        : { revenue: 100 })],
  )
  return {
    income: build('income'),
    balancesheet: build('balancesheet'),
    cashflow: build('cashflow'),
    fina_indicator: build('fina_indicator'),
    fina_audit: build('fina_audit'),
    forecast: build('forecast'),
    express: build('express'),
    disclosure_date: build('disclosure_date'),
    fina_mainbz: build('fina_mainbz'),
  }
}

describe('产业研究项目级财务采集', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    createResearchProject(db, {
      id: 'project-1',
      title: 'PCB 产业研究',
      industryName: 'PCB',
      productScope: '高多层板',
      regionScope: '中国',
      timeScope: '2025-2026',
      purpose: 'investment',
      depth: 'standard',
      sourceType: 'manual',
      skillId: 'builtin:industry-chain-research',
      skillContentHash: 'a'.repeat(64),
    })
    saveResearchCompany(db, {
      id: 'company-1',
      legalName: '沪士电子股份有限公司',
      shortName: '沪电股份',
      sourceType: 'tushare',
    })
    saveResearchSecurity(db, {
      id: 'security-1',
      companyId: 'company-1',
      tsCode: '002463.SZ',
      exchange: 'SZSE',
      securityType: 'stock',
      listStatus: 'L',
      mappingSource: 'tushare',
    })
    saveResearchProjectCompany(db, {
      projectId: 'project-1',
      companyId: 'company-1',
      status: 'candidate',
    })
  })

  it('首次串行采集九个数据集，成功后重复调用全部跳过', async () => {
    const firstFetchers = fetchers()
    const progress: Array<{
      processedDatasets: number
      currentCompanyIndex: number | null
      currentDatasetIndex: number | null
      currentDataset: string | null
      message: string
    }> = []
    const first = await collectIndustryResearchProjectFinancials(db, 'project-1', {
      token: 'token',
      fetchers: firstFetchers,
      onProgress: (state) => progress.push(state),
    })

    expect(first).toMatchObject({
      status: 'succeeded',
      totalCompanies: 1,
      totalDatasets: 9,
      coveredDatasets: 9,
      pendingDatasets: 0,
      attemptedDatasets: 9,
      processedDatasets: 9,
    })
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({
        processedDatasets: 0,
        currentCompanyIndex: 1,
        currentDatasetIndex: 1,
        currentDataset: 'income',
        message: expect.stringContaining('利润表'),
      }),
      expect.objectContaining({ processedDatasets: 9, currentDataset: null }),
    ]))
    expect(getResearchFinancialSyncState(db, 'company-1', 'fina_mainbz')).toMatchObject({
      status: 'success',
      last_success_row_count: 1,
    })

    const secondFetchers = fetchers()
    const second = await collectIndustryResearchProjectFinancials(db, 'project-1', {
      token: 'token',
      fetchers: secondFetchers,
    })
    expect(second).toMatchObject({
      status: 'succeeded',
      attemptedDatasets: 0,
      skippedDatasets: 9,
      processedDatasets: 9,
    })
    expect(secondFetchers.income).not.toHaveBeenCalled()
    expect(secondFetchers.fina_mainbz).not.toHaveBeenCalled()

    createResearchProject(db, {
      id: 'project-2', title: '服务器 PCB 研究', industryName: 'PCB', productScope: '服务器板',
      regionScope: '中国', timeScope: '2025-2026', purpose: 'investment', depth: 'standard',
      sourceType: 'manual', skillId: 'builtin:industry-chain-research', skillContentHash: 'b'.repeat(64),
    })
    saveResearchProjectCompany(db, {
      projectId: 'project-2', companyId: 'company-1', status: 'candidate',
    })
    const crossProjectFetchers = fetchers()
    await collectIndustryResearchProjectFinancials(db, 'project-2', {
      token: 'token', fetchers: crossProjectFetchers,
    })
    expect(crossProjectFetchers.fina_mainbz).not.toHaveBeenCalled()
    expect(listResearchBusinessExposures(db, 'project-2', 'company-1')).toMatchObject([{
      status: 'candidate',
      main_business_item_name: '企业通讯市场板',
    }])
  })

  it('部分失败后只重试失败数据集，并保留其他成功事实', async () => {
    const first = await collectIndustryResearchProjectFinancials(db, 'project-1', {
      token: 'token',
      fetchers: fetchers(['balancesheet']),
    })
    expect(first).toMatchObject({ status: 'partial', coveredDatasets: 8, failedDatasets: 1 })

    const retryFetchers = fetchers()
    const retried = await collectIndustryResearchProjectFinancials(db, 'project-1', {
      token: 'token',
      fetchers: retryFetchers,
    })
    expect(retried).toMatchObject({
      status: 'succeeded',
      coveredDatasets: 9,
      attemptedDatasets: 1,
      skippedDatasets: 8,
      processedDatasets: 9,
    })
    expect(retryFetchers.balancesheet).toHaveBeenCalledTimes(1)
    expect(retryFetchers.income).not.toHaveBeenCalled()
  })

  it('中断时保留已完成数据，并把未完成数据留给下次继续', async () => {
    let completedRequests = 0
    const controlled = fetchers()
    controlled.income = vi.fn(async () => {
      completedRequests += 1
      return [row()]
    })
    const result = await collectIndustryResearchProjectFinancials(db, 'project-1', {
      token: 'token',
      fetchers: controlled,
      shouldCancel: () => completedRequests >= 1,
    })

    expect(result).toMatchObject({
      status: 'cancelled',
      coveredDatasets: 1,
      attemptedDatasets: 1,
      processedDatasets: 1,
      pendingDatasets: 8,
    })
    expect(getResearchFinancialSyncState(db, 'company-1', 'income')?.status).toBe('success')
    expect(controlled.balancesheet).not.toHaveBeenCalled()
  })
})
