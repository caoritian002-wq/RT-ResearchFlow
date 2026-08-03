import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import {
  getCandidateBatchByIdempotencyKey,
  listChangeCandidates,
  listChangeSets,
  resolveChangeSetRows,
  savePreparedCandidateBatch,
} from '../../electron/main/database/industryResearchChangeRepository'
import { changeSetSummary } from '../../electron/main/services/industryResearchChangeGenerationService'

describe('产业研究语义变更包仓库', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  it('40项以上底层候选仍聚合为少量语义变更包并支持分页审计', () => {
    const batch = savePreparedCandidateBatch(db, {
      id: 'batch-1', requestId: '00000000-0000-4000-8000-000000000001', idempotencyKey: 'discussion:1:0:50:hash',
      sourceType: 'discussion', sourceSessionId: null, projectId: null, baseSnapshotId: null,
      messageStartIndex: 0, messageEndIndex: 50, contextHash: 'hash', provider: 'qwen', model: 'test', ruleVersion: 'v1',
      changeSets: Array.from({ length: 5 }, (_, setIndex) => ({
        id: `set-${setIndex}`, title: `主题 ${setIndex}`, summary: '摘要', impact: '影响', action: 'add' as const,
        risk: 'low' as const, affectedObjects: [], evidenceSummary: [], confidenceBoundary: '保持估算', requiresExpandedReview: false,
        candidates: Array.from({ length: 10 }, (_, candidateIndex) => ({
          id: `candidate-${setIndex}-${candidateIndex}`, kind: 'node' as const, action: 'add',
          sourceLocator: `discussion:${candidateIndex}`, statementType: 'estimate' as const,
          payload: { name: `节点 ${setIndex}-${candidateIndex}` },
        })),
      })),
    })

    expect(batch.change_set_count).toBe(5)
    expect(batch.candidate_count).toBe(50)
    expect(listChangeSets(db, { batchId: batch.id, limit: 100 }).items).toHaveLength(5)
    expect(listChangeCandidates(db, { changeSetId: 'set-0', offset: 0, limit: 4 })).toMatchObject({ total: 10, items: { length: 4 } })
    expect(getCandidateBatchByIdempotencyKey(db, 'discussion:1:0:50:hash')?.id).toBe(batch.id)
  })

  it('用户修改以展示投影返回且保留模型原始标题和摘要', () => {
    savePreparedCandidateBatch(db, {
      id: 'batch-edit', requestId: '00000000-0000-4000-8000-000000000002', idempotencyKey: 'edit-key',
      sourceType: 'archive', sourceSessionId: null, projectId: null, baseSnapshotId: null,
      messageStartIndex: null, messageEndIndex: null, contextHash: 'hash', provider: null, model: null, ruleVersion: 'v1',
      changeSets: [{ id: 'set-edit', title: '模型标题', summary: '模型摘要', impact: '影响', action: 'revise', risk: 'low', affectedObjects: [], evidenceSummary: [], confidenceBoundary: '边界', requiresExpandedReview: false, candidates: [{ id: 'candidate-edit', kind: 'hypothesis', action: 'add', sourceLocator: 'archive:test', statementType: 'hypothesis', payload: { statement: '假设' } }] }],
    })
    resolveChangeSetRows(db, {
      changeSetIds: ['set-edit'], status: 'deferred', action: 'defer', requestId: '00000000-0000-4000-8000-000000000003',
      userEditsById: new Map([['set-edit', { title: '用户标题', summary: '用户摘要' }]]),
    })

    expect(changeSetSummary(listChangeSets(db, { batchId: 'batch-edit' }).items[0])).toMatchObject({
      title: '用户标题', summary: '用户摘要', generatedTitle: '模型标题', generatedSummary: '模型摘要', userEdited: true,
    })
  })
})
