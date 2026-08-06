import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}))

vi.mock('../../electron/main/database/db', () => ({ getDb: mocks.getDb }))

import {
  seedBuiltInSources,
  updateSource,
  type BuiltInSourceSeed,
} from '../../electron/main/database/sourceRepository'

function createDatabase(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nameCN TEXT NOT NULL,
      nameEN TEXT NOT NULL,
      url TEXT NOT NULL,
      feedUrl TEXT,
      category TEXT NOT NULL,
      authorityWeight INTEGER NOT NULL,
      isBuiltIn INTEGER NOT NULL,
      isEnabled INTEGER NOT NULL,
      status TEXT NOT NULL,
      lastScannedAt INTEGER,
      successRate REAL NOT NULL,
      parseStrategy TEXT NOT NULL,
      contentSelector TEXT,
      financeSectionFilter TEXT,
      detailSelector TEXT
    );
    CREATE TABLE built_in_source_state (
      source_id INTEGER PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
      seed_key TEXT NOT NULL UNIQUE,
      has_local_overrides INTEGER NOT NULL DEFAULT 0
    );
  `)
  return db
}

function stcnSeed(overrides: Partial<BuiltInSourceSeed> = {}): BuiltInSourceSeed {
  return {
    seedKey: 'stcn',
    nameCN: '证券时报',
    nameEN: 'Securities Times',
    url: 'https://www.stcn.com',
    feedUrl: null,
    category: 'FINANCIAL_PRESS',
    authorityWeight: 8,
    isBuiltIn: 1,
    isEnabled: 1,
    status: 'ACTIVE',
    parseStrategy: 'HTML_SCRAPE',
    contentSelector: '.box-content ul li a,.top-news a,.cc-list a',
    financeSectionFilter: null,
    detailSelector: '.detail-content|.detail-content-wrapper|.video-content-left',
    ...overrides,
  }
}

describe('内置监控源本地配置持久化', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDatabase()
    mocks.getDb.mockReturnValue(db)
  })

  afterEach(() => {
    db?.close()
  })

  it('未编辑的来源跟随新版默认配置', () => {
    seedBuiltInSources([stcnSeed({ detailSelector: '.old-default' })])
    seedBuiltInSources([stcnSeed({
      url: 'https://www.stcn.com.cn',
      detailSelector: '.new-default',
    })])

    expect(db.prepare('SELECT url, detailSelector FROM sources').get()).toEqual({
      url: 'https://www.stcn.com.cn',
      detailSelector: '.new-default',
    })
    expect(db.prepare('SELECT has_local_overrides AS hasLocalOverrides FROM built_in_source_state').get())
      .toEqual({ hasLocalOverrides: 0 })
  })

  it('用户保存后跨重启保留全部本地配置且不重复建源', () => {
    seedBuiltInSources([stcnSeed()])
    const row = db.prepare('SELECT id FROM sources').get() as { id: number }

    updateSource(row.id, {
      nameCN: '我的证券时报',
      url: 'https://local.example.com/stcn',
      detailSelector: '.user-detail|.user-video',
    })
    seedBuiltInSources([stcnSeed({
      url: 'https://www.stcn.com/new-home',
      detailSelector: '.future-default',
    })])

    expect(db.prepare('SELECT nameCN, url, detailSelector FROM sources WHERE id = ?').get(row.id)).toEqual({
      nameCN: '我的证券时报',
      url: 'https://local.example.com/stcn',
      detailSelector: '.user-detail|.user-video',
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM sources').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT seed_key AS seedKey, has_local_overrides AS hasLocalOverrides FROM built_in_source_state').get())
      .toEqual({ seedKey: 'stcn', hasLocalOverrides: 1 })
  })
})
