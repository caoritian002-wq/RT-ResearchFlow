import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import {
  createResearchProject,
  getResearchGraph,
  getResearchProject,
  replaceResearchGraph,
  updateResearchProject,
} from '../../electron/main/database/industryResearchRepository'

describe('产业研究仓库', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    createResearchProject(db, {
      id: 'project-1', title: '光伏研究', industryName: '光伏', productScope: '组件', regionScope: '中国',
      timeScope: '2024-2026', purpose: 'investment', depth: 'standard', sourceType: 'manual',
      skillId: 'builtin:industry-chain-research', skillContentHash: 'a'.repeat(64),
    })
  })

  it('拒绝过期图谱版本并保留现有图谱', () => {
    const initialVersion = getResearchProject(db, 'project-1')!.graph_updated_at
    const currentVersion = replaceResearchGraph(db, 'project-1', [
      { id: 'node-a', type: 'material', name: '硅料', statementKind: 'estimate' },
      { id: 'node-b', type: 'product', name: '组件', statementKind: 'estimate' },
    ], [
      { id: 'edge-a-b', source: 'node-a', target: 'node-b', relation: '加工为', statementKind: 'estimate' },
    ], initialVersion)

    expect(() => replaceResearchGraph(db, 'project-1', [], [], initialVersion)).toThrowError('VERSION_CONFLICT')
    expect(getResearchProject(db, 'project-1')!.graph_updated_at).toBe(currentVersion)
    expect(getResearchGraph(db, 'project-1')).toMatchObject({
      nodes: [{ id: 'node-a' }, { id: 'node-b' }],
      edges: [{ id: 'edge-a-b' }],
    })
  })

  it('新图谱违反关系约束时回滚删除和写入', () => {
    const initialVersion = getResearchProject(db, 'project-1')!.graph_updated_at
    const currentVersion = replaceResearchGraph(db, 'project-1', [
      { id: 'node-old', type: 'product', name: '旧节点', statementKind: 'estimate' },
    ], [], initialVersion)

    expect(() => replaceResearchGraph(db, 'project-1', [
      { id: 'node-new', type: 'product', name: '新节点', statementKind: 'estimate' },
    ], [
      { id: 'edge-invalid', source: 'node-new', target: 'node-missing', relation: '依赖', statementKind: 'estimate' },
    ], currentVersion)).toThrow()

    expect(getResearchGraph(db, 'project-1')).toMatchObject({ nodes: [{ id: 'node-old' }], edges: [] })
    expect(getResearchProject(db, 'project-1')!.graph_updated_at).toBe(currentVersion)
  })

  it('归档项目只更新状态并保留事实图谱', () => {
    const version = getResearchProject(db, 'project-1')!.graph_updated_at
    replaceResearchGraph(db, 'project-1', [
      { id: 'node-a', type: 'industry', name: '光伏', statementKind: 'fact' },
    ], [], version)

    updateResearchProject(db, 'project-1', { status: 'archived' })

    expect(getResearchProject(db, 'project-1')!.status).toBe('archived')
    expect(getResearchGraph(db, 'project-1').nodes).toHaveLength(1)
  })
})