import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import {
  createResearchProject,
  deleteResearchProject,
  deleteResearchProjects,
  getResearchGraph,
  getResearchProject,
  IndustryResearchProjectDeletionError,
  replaceResearchGraph,
  updateResearchProject,
} from '../../electron/main/database/industryResearchRepository'
import { createGenerationRun } from '../../electron/main/database/industryResearchGenerationRepository'
import { startResearchAgentRun } from '../../electron/main/database/researchAgentRunRepository'
import { RESEARCH_AGENT_TOOL_REGISTRY_VERSION } from '../../electron/main/services/researchAgentNetworkTools'

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

  it('活动生成任务阻断单项目和批量删除且不产生部分清理', () => {
    createResearchProject(db, {
      id: 'project-2', title: '储能研究', industryName: '储能', productScope: '电池', regionScope: '中国',
      timeScope: '2024-2026', purpose: 'investment', depth: 'standard', sourceType: 'manual',
      skillId: 'builtin:industry-chain-research', skillContentHash: 'b'.repeat(64),
    })
    createGenerationRun(db, {
      id: 'run-active', projectId: 'project-1', researchQuestion: '继续验证光伏产业供需与价格传导变化',
      skillId: 'builtin:industry-chain-research', skillContentHash: 'a'.repeat(64),
    })

    expect(() => deleteResearchProject(db, 'project-1')).toThrowError(IndustryResearchProjectDeletionError)
    expect(() => deleteResearchProjects(db, { all: true })).toThrowError('项目仍有进行中的产业研究生成')
    expect(getResearchProject(db, 'project-1')).not.toBeNull()
    expect(getResearchProject(db, 'project-2')).not.toBeNull()
  })

  it('进行中的深度研究会阻断删除并保留项目', () => {
    startResearchAgentRun(db, {
      id: '00000000-0000-4000-8000-000000000101',
      requestId: '00000000-0000-4000-8000-000000000102',
      question: '继续验证光伏产业供需与价格变化是否足以改变原有研究结论？',
      contextSnapshot: { projectId: 'project-1', trusted: true },
      subjects: [{ kind: 'industry_project', id: 'project-1', label: '光伏研究' }],
      includePortfolio: false,
      asOf: '20260806',
      provider: 'chatgpt',
      model: 'gpt-5.6-sol',
      modelConfigFingerprint: 'c'.repeat(64),
      promptRuleVersion: 'single-agent.v1-controlled-network.v5',
      toolRegistryVersion: RESEARCH_AGENT_TOOL_REGISTRY_VERSION,
    })

    expect(() => deleteResearchProject(db, 'project-1')).toThrowError('项目仍有进行中的深度研究')
    expect(getResearchProject(db, 'project-1')).not.toBeNull()
  })
})
