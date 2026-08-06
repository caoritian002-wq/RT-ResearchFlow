import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  DATABASE_MIGRATIONS,
  runMigrations,
} from '../../electron/main/database/db'

const STCN_DEFAULT = '.detail-content|.detail-content-wrapper|.video-content-left'

function migrateStcn(detailSelector: string | null): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE sources (
      id INTEGER PRIMARY KEY,
      nameCN TEXT NOT NULL,
      nameEN TEXT NOT NULL,
      url TEXT NOT NULL,
      isBuiltIn INTEGER NOT NULL,
      detailSelector TEXT
    );
  `)
  db.prepare(
    'INSERT INTO sources (id, nameCN, nameEN, url, isBuiltIn, detailSelector) VALUES (1, ?, ?, ?, 1, ?)'
  ).run('证券时报', 'Securities Times', 'https://www.stcn.com', detailSelector)
  runMigrations(db, DATABASE_MIGRATIONS.filter((migration) => migration.version === 134))
  return db
}

describe('Migration 134 内置监控源本地覆盖状态', () => {
  it('将证券时报旧默认升级为三段正文选择器并保护现有数据库', () => {
    const db = migrateStcn('.detail-content')
    try {
      expect(db.prepare('SELECT detailSelector FROM sources WHERE id = 1').get()).toEqual({
        detailSelector: STCN_DEFAULT,
      })
      expect(db.prepare(
        'SELECT seed_key AS seedKey, has_local_overrides AS hasLocalOverrides FROM built_in_source_state WHERE source_id = 1'
      ).get()).toEqual({ seedKey: 'stcn', hasLocalOverrides: 1 })
    } finally {
      db.close()
    }
  })

  it('不覆盖已经不同于旧默认的用户选择器', () => {
    const db = migrateStcn('.my-article|.my-video')
    try {
      expect(db.prepare('SELECT detailSelector FROM sources WHERE id = 1').get()).toEqual({
        detailSelector: '.my-article|.my-video',
      })
    } finally {
      db.close()
    }
  })
})
