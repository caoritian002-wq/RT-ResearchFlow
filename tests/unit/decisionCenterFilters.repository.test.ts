import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import {
  getDecisionCenterFilters,
  normalizeDecisionCenterFiltersPreference,
  setDecisionCenterFilters,
} from '../../electron/main/database/settingsRepository'

describe('今日看板筛选偏好仓库', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
  })

  it('Migration 111 初始为空，写入 P4 后可从 SQLite 恢复', () => {
    expect(getDecisionCenterFilters(db)).toBeNull()

    const saved = setDecisionCenterFilters({
      status: 'active',
      type: 'all',
      source: 'news',
      portfolioOnly: false,
      minPriority: 4,
      viewMode: 'market',
    }, db)

    expect(saved).toMatchObject({ minPriority: 4, source: 'news', viewMode: 'market' })
    expect(getDecisionCenterFilters(db)).toEqual(saved)
  })

  it('损坏 JSON 返回未初始化，不把损坏内容当作有效 P1 偏好', () => {
    db.prepare('UPDATE app_settings SET decision_center_filters_json = ? WHERE id = 1')
      .run('{broken-json')

    expect(getDecisionCenterFilters(db)).toBeNull()
  })

  it('归一化非法优先级并保持组合模式只看持仓', () => {
    expect(normalizeDecisionCenterFiltersPreference({
      minPriority: 99,
      viewMode: 'portfolio',
      portfolioOnly: false,
    })).toMatchObject({
      minPriority: 5,
      viewMode: 'portfolio',
      portfolioOnly: true,
    })

    expect(normalizeDecisionCenterFiltersPreference({ minPriority: 'invalid' }))
      .toMatchObject({ minPriority: 1 })
  })
})
