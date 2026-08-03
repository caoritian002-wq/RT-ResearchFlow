import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import { createResearchProject } from '../../electron/main/database/industryResearchRepository'
import {
  getLatestWorkItemVersion,
  saveSkillSnapshot,
  saveWorkItemVersion,
} from '../../electron/main/database/industryResearchDecisionRepository'
import { listIndustryResearchWorkItems } from '../../electron/main/services/industryResearchDecisionService'

const cleanup: string[] = []

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

function seedProject(db: Database.Database, id = 'project-decision') {
  return createResearchProject(db, {
    id,
    title: '光通信研究',
    industryName: '光通信',
    productScope: '光模块',
    regionScope: '中国',
    timeScope: '2026',
    purpose: 'investment',
    depth: 'standard',
    sourceType: 'manual',
    skillId: 'builtin:industry-chain-research',
    skillContentHash: 'a'.repeat(64),
    skillRuleVersion: 'v1',
  })
}

describe('产业研究决策事实仓库', () => {
  it('Skill快照按内容去重且不可更新或删除', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const first = saveSkillSnapshot(db, {
      id: 'skill-snapshot-1',
      skill_id: 'builtin:industry-chain-research',
      content_hash: 'a'.repeat(64),
      rule_version: 'v1',
      content: '# 规则',
      source_type: 'builtin',
      source_locator: 'industry-chain-research',
      content_bytes: 8,
      captured_at: 1,
    })
    const duplicate = saveSkillSnapshot(db, { ...first, id: 'skill-snapshot-2', captured_at: 2 })

    expect(duplicate.id).toBe(first.id)
    expect(() => db.prepare('UPDATE industry_research_skill_snapshots SET rule_version = ? WHERE id = ?').run('v2', first.id))
      .toThrow('INDUSTRY_RESEARCH_SKILL_SNAPSHOT_IMMUTABLE')
    expect(() => db.prepare('DELETE FROM industry_research_skill_snapshots WHERE id = ?').run(first.id))
      .toThrow('INDUSTRY_RESEARCH_SKILL_SNAPSHOT_IMMUTABLE')
    db.close()
  })

  it('工作项请求幂等、版本递增并隔离单条损坏JSON', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    seedProject(db)
    const first = saveWorkItemVersion(db, {
      id: 'work-version-1',
      work_item_id: 'work-1',
      project_id: 'project-decision',
      version: 1,
      previous_version_id: null,
      request_id: 'request-work-1',
      question: '验证需求弹性',
      effort: 'standard_validation',
      conclusion_sensitivity: 'high',
      evidence_uncertainty: 'medium',
      change_velocity: 'medium',
      stop_reason: null,
      next_trigger_metric: '季度出货量',
      affected_objects_json: '[]',
      status: 'open',
      created_at: 1,
    })
    const retry = saveWorkItemVersion(db, { ...first, id: 'work-version-retry' })
    saveWorkItemVersion(db, {
      ...first,
      id: 'work-version-2',
      version: 2,
      previous_version_id: first.id,
      request_id: 'request-work-2',
      affected_objects_json: '{broken',
      status: 'blocked',
      created_at: 2,
    })

    expect(retry.id).toBe(first.id)
    expect(getLatestWorkItemVersion(db, 'project-decision', 'work-1')?.version).toBe(2)
    expect(listIndustryResearchWorkItems(db, 'project-decision')).toEqual([
      expect.objectContaining({ id: 'work-1', version: 2, status: 'blocked', affectedObjectIds: [], dataStatus: 'corrupt' }),
    ])
    expect(() => db.prepare('DELETE FROM industry_research_work_item_versions WHERE id = ?').run(first.id))
      .toThrow('INDUSTRY_RESEARCH_FACT_IMMUTABLE')
    db.close()
  })

  it('文件数据库重启后保留Migration 109与不可变工作项版本', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trade-watch-decision-'))
    cleanup.push(dir)
    const path = join(dir, 'research.db')
    let db = new Database(path)
    runMigrations(db)
    seedProject(db, 'project-restart')
    saveWorkItemVersion(db, {
      id: 'restart-version-1', work_item_id: 'restart-work', project_id: 'project-restart',
      version: 1, previous_version_id: null, request_id: 'restart-request-1', question: '跨重启工作项',
      effort: 'quick_pass', conclusion_sensitivity: 'low', evidence_uncertainty: 'low', change_velocity: 'low',
      stop_reason: null, next_trigger_metric: null, affected_objects_json: '[]', status: 'completed', created_at: 1,
    })
    db.close()

    db = new Database(path)
    runMigrations(db)
    expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({
      version: DATABASE_MIGRATIONS.at(-1)?.version,
    })
    expect(getLatestWorkItemVersion(db, 'project-restart', 'restart-work')).toEqual(expect.objectContaining({ version: 1, status: 'completed' }))
    db.close()
  })
})
