import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import { getChangeSet, listChangeSets, listResearchSnapshots, savePreparedCandidateBatch } from '../../electron/main/database/industryResearchChangeRepository'
import {
  createResearchProject,
  deleteResearchProject,
  listResearchEvidence,
} from '../../electron/main/database/industryResearchRepository'
import { resolveIndustryResearchChangeSets } from '../../electron/main/services/industryResearchMergeService'
import { getIndustryResearchSnapshot } from '../../electron/main/services/industryResearchSnapshotService'

describe('产业研究变更包合并服务', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    createResearchProject(db, {
      id: 'project-1', title: '光纤研究', industryName: '光通信', productScope: '预制棒、光纤和光缆',
      regionScope: '中国', timeScope: '2026-2028', purpose: 'investment', depth: 'standard',
      sourceType: 'manual', skillId: 'builtin:industry-chain-research', skillContentHash: 'a'.repeat(64),
    })
  })

  function createFactBatch(): void {
    savePreparedCandidateBatch(db, {
      id: 'batch-fact', requestId: '00000000-0000-4000-8000-000000000010', idempotencyKey: 'fact-key',
      sourceType: 'archive', sourceSessionId: null, projectId: null, baseSnapshotId: null,
      messageStartIndex: null, messageEndIndex: null, contextHash: 'hash', provider: null, model: null, ruleVersion: 'v1',
      changeSets: [{
        id: 'set-fact', title: '新增产能事实', summary: '需要一级来源确认', impact: '供给判断', action: 'add', risk: 'high',
        affectedObjects: [{ type: 'evidence', id: null, label: '产能公告' }], evidenceSummary: [],
        confidenceBoundary: '未确认前不能升级事实', requiresExpandedReview: true,
        candidates: [{
          id: 'candidate-fact', kind: 'evidence', action: 'add', sourceLocator: 'archive:evidence:F-1',
          statementType: 'fact', primarySource: false,
          payload: { title: '公司产能公告', sourceType: 'archive', sourceName: '迁移档案', sourceUrl: 'https://example.com/copy', excerpt: '规划产能' },
        }],
      }],
    })
  }

  it('事实未获人工一级来源确认时整批回滚', () => {
    createFactBatch()

    let caught: unknown
    try {
      resolveIndustryResearchChangeSets(db, {
        requestId: '00000000-0000-4000-8000-000000000011', batchId: 'batch-fact', changeSetIds: ['set-fact'],
        action: 'accept', target: { mode: 'existing', projectId: 'project-1' },
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'FACT_REQUIRES_SOURCE', message: '事实升级需要用户确认具体一级来源' })

    expect(getChangeSet(db, 'set-fact')?.status).toBe('pending')
    expect(listResearchEvidence(db, 'project-1')).toHaveLength(0)
    expect(listResearchSnapshots(db, 'project-1').total).toBe(0)
  })

  it('接受后原子写入事实与不可变版本，并禁止物理删除项目', () => {
    createFactBatch()
    const result = resolveIndustryResearchChangeSets(db, {
      requestId: '00000000-0000-4000-8000-000000000012', batchId: 'batch-fact', changeSetIds: ['set-fact'],
      action: 'accept', target: { mode: 'existing', projectId: 'project-1' },
      factConfirmations: [{ candidateId: 'candidate-fact', primarySourceConfirmed: true, confirmedBy: 'human', originalSourceUrl: 'https://company.example.com/announcement' }],
    })

    expect(result.snapshotId).toBeTruthy()
    expect(getChangeSet(db, 'set-fact')?.status).toBe('accepted')
    expect(listChangeSets(db, { projectId: 'project-1' }).items.map((item) => item.id)).toEqual(['set-fact'])
    expect(listResearchEvidence(db, 'project-1')[0]).toMatchObject({ statement_kind: 'fact', primary_source_confirmed: 1, source_url: 'https://company.example.com/announcement' })
    expect(getIndustryResearchSnapshot(db, 'project-1', result.snapshotId!)).toMatchObject({
      summary: { projectId: 'project-1', acceptedChangeSetCount: 1 },
      snapshot: { acceptedChangeSetIds: ['set-fact'] },
    })
    expect(() => deleteResearchProject(db, 'project-1')).toThrowError('SNAPSHOT_PROTECTED')
    expect(() => db.prepare('UPDATE industry_research_snapshots SET title = ? WHERE id = ?').run('篡改', result.snapshotId)).toThrow()
    expect(() => db.prepare('DELETE FROM industry_research_snapshots WHERE id = ?').run(result.snapshotId)).toThrow()
  })
})
