import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import {
  getMarketSnapshot,
  getMarketSyncRunByRequestId,
  listSecurityAdjustmentFactors,
  listSecurityValuationDaily,
  saveMarketSnapshot,
  saveMarketSyncRun,
  upsertSecurityAdjustmentFactors,
  upsertSecurityValuationDaily,
} from '../../electron/main/database/industryResearchMarketRepository'
import {
  saveResearchCompany,
  saveResearchProjectCompany,
  saveResearchSecurity,
} from '../../electron/main/database/industryResearchFinancialRepository'
import { createResearchProject } from '../../electron/main/database/industryResearchRepository'

const cleanup: string[] = []

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

function seedScope(db: Database.Database, projectId = 'project-market'): void {
  createResearchProject(db, {
    id: projectId, title: '市场事实研究', industryName: '光通信', productScope: '光模块',
    regionScope: '中国', timeScope: '2026', purpose: 'investment', depth: 'standard', sourceType: 'manual',
    skillId: 'builtin:industry-chain-research', skillContentHash: 'a'.repeat(64), skillRuleVersion: 'v1',
  })
  saveResearchCompany(db, { id: 'company-market', legalName: '示例光通信股份有限公司', sourceType: 'manual' }, 1)
  saveResearchSecurity(db, {
    id: 'security-market', companyId: 'company-market', tsCode: '600001.SH', exchange: 'SSE',
    securityType: 'A_SHARE', mappingSource: 'manual',
  }, 2)
  saveResearchProjectCompany(db, { projectId, companyId: 'company-market', status: 'core' }, 3)
}

describe('产业研究市场事实仓库', () => {
  it('调整因子与点时估值按证券日期幂等更新并有序读取', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    upsertSecurityAdjustmentFactors(db, [
      { ts_code: '600001.SH', trade_date: '20260716', adj_factor: 1, source: 'seed', fetched_at: 1 },
      { ts_code: '600001.SH', trade_date: '20260717', adj_factor: 1.1, source: 'seed', fetched_at: 1 },
    ])
    upsertSecurityAdjustmentFactors(db, [
      { ts_code: '600001.SH', trade_date: '20260717', adj_factor: 1.2, source: 'revision', fetched_at: 2 },
    ])
    upsertSecurityValuationDaily(db, [
      {
        ts_code: '600001.SH', trade_date: '20260717', total_share: 1000, float_share: 800,
        total_mv: 12000, circ_mv: 9600, pe_ttm: 20, pb: 2, ps_ttm: 3, dv_ttm: 1,
        source: 'seed', fetched_at: 1,
      },
    ])
    upsertSecurityValuationDaily(db, [
      {
        ts_code: '600001.SH', trade_date: '20260717', total_share: 1000, float_share: 800,
        total_mv: 12500, circ_mv: 10000, pe_ttm: 21, pb: 2.1, ps_ttm: 3.1, dv_ttm: 1.1,
        source: 'revision', fetched_at: 2,
      },
    ])

    expect(listSecurityAdjustmentFactors(db, '600001.SH')).toMatchObject([
      { trade_date: '20260716', adj_factor: 1 },
      { trade_date: '20260717', adj_factor: 1.2, source: 'revision' },
    ])
    expect(listSecurityValuationDaily(db, '600001.SH')).toMatchObject([
      { trade_date: '20260717', total_mv: 12500, pe_ttm: 21, source: 'revision' },
    ])
    db.close()
  })

  it('同步运行和市场快照按请求幂等且不可修改或删除', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    seedScope(db)
    const run = saveMarketSyncRun(db, {
      id: 'sync-run-1', request_id: 'sync-request-1', project_id: 'project-market',
      company_id: 'company-market', security_id: 'security-market', ts_code: '600001.SH',
      benchmark_code: '000001.SH', status: 'partial', result_json: '{"daily":{"status":"success"}}',
      data_start: '20250101', data_end: '20260717', fact_fingerprint: 'a'.repeat(64),
      error_code: 'PERMISSION_REQUIRED', started_at: 10, completed_at: 20,
    })
    const retry = saveMarketSyncRun(db, { ...run, id: 'sync-run-retry', status: 'success' })
    const snapshot = saveMarketSnapshot(db, {
      id: 'market-snapshot-1', request_id: 'snapshot-request-1', project_id: 'project-market',
      company_id: 'company-market', security_id: 'security-market', ts_code: '600001.SH',
      requested_valuation_date: '2026-07-17', market_date: '20260717', benchmark_code: '000001.SH',
      benchmark_name: '上证指数', raw_close: 12.5, status: 'degraded', reason_json: '[]',
      market_data_json: '{"status":"degraded"}', fact_fingerprint: 'b'.repeat(64),
      methodology_version: 'market-context-v1', created_at: 30,
    })
    const snapshotRetry = saveMarketSnapshot(db, { ...snapshot, id: 'market-snapshot-retry', raw_close: 99 })

    expect(retry.id).toBe('sync-run-1')
    expect(retry.status).toBe('partial')
    expect(snapshotRetry.id).toBe('market-snapshot-1')
    expect(snapshotRetry.raw_close).toBe(12.5)
    expect(getMarketSyncRunByRequestId(db, 'sync-request-1')).toEqual(expect.objectContaining({ error_code: 'PERMISSION_REQUIRED' }))
    expect(getMarketSnapshot(db, 'project-market', 'market-snapshot-1')).toEqual(expect.objectContaining({ raw_close: 12.5 }))
    expect(getMarketSnapshot(db, 'other-project', 'market-snapshot-1')).toBeNull()
    expect(() => db.prepare("UPDATE industry_research_market_sync_runs SET status = 'success' WHERE id = 'sync-run-1'").run())
      .toThrow('INDUSTRY_RESEARCH_FACT_IMMUTABLE')
    expect(() => db.prepare("DELETE FROM industry_research_market_snapshots WHERE id = 'market-snapshot-1'").run())
      .toThrow('INDUSTRY_RESEARCH_FACT_IMMUTABLE')
    db.close()
  })

  it('文件数据库跨重启保留市场缓存、同步失败事实和快照', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trade-watch-market-'))
    cleanup.push(dir)
    const path = join(dir, 'market.db')
    let db = new Database(path)
    runMigrations(db)
    seedScope(db)
    upsertSecurityAdjustmentFactors(db, [
      { ts_code: '600001.SH', trade_date: '20260717', adj_factor: 1.25, source: 'seed', fetched_at: 1 },
    ])
    saveMarketSyncRun(db, {
      id: 'restart-run', request_id: 'restart-request', project_id: 'project-market',
      company_id: 'company-market', security_id: 'security-market', ts_code: '600001.SH',
      benchmark_code: '000001.SH', status: 'failed', result_json: '{broken', data_start: '20250101',
      data_end: null, fact_fingerprint: null, error_code: 'UPSTREAM_ERROR', started_at: 1, completed_at: 2,
    })
    db.close()

    db = new Database(path)
    runMigrations(db)
    expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({
      version: DATABASE_MIGRATIONS.at(-1)?.version,
    })
    expect(listSecurityAdjustmentFactors(db, '600001.SH')).toEqual([
      expect.objectContaining({ trade_date: '20260717', adj_factor: 1.25 }),
    ])
    expect(getMarketSyncRunByRequestId(db, 'restart-request')).toEqual(expect.objectContaining({
      status: 'failed', result_json: '{broken', error_code: 'UPSTREAM_ERROR',
    }))
    db.close()
  })
})
