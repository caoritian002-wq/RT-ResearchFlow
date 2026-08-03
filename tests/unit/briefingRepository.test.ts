import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { listBriefings, markAllAsRead } from '../../electron/main/database/briefingRepository'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE briefings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sourceId INTEGER NOT NULL,
      sourceName TEXT NOT NULL,
      originalUrl TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      fullContent TEXT,
      publishedAt INTEGER NOT NULL,
      publishedDateBJ TEXT NOT NULL,
      publicationTimeStatus TEXT NOT NULL DEFAULT 'exact',
      collectedAt INTEGER NOT NULL,
      impactRating TEXT NOT NULL,
      impactRatingScore REAL NOT NULL,
      deduplicationHash TEXT NOT NULL UNIQUE,
      titleSimhash TEXT NOT NULL,
      isRead INTEGER NOT NULL,
      readAt INTEGER,
      scanRunId INTEGER,
      isCatchUp INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE briefings_fts USING fts5(
      title,
      summary,
      content='briefings',
      content_rowid='id'
    );
    CREATE TRIGGER briefings_ai AFTER INSERT ON briefings BEGIN
      INSERT INTO briefings_fts(rowid, title, summary) VALUES (new.id, new.title, new.summary);
    END;
  `)
  return db
}

function insertBriefing(
  db: Database.Database,
  input: {
    sourceId: number
    sourceName: string
    title: string
    date: string
    rating: 'CRITICAL' | 'IMPORTANT' | 'GENERAL'
    isRead?: number
    publishedAt: number
    publicationTimeStatus?: 'exact' | 'date_only' | 'collected_fallback'
  },
): void {
  db.prepare(`
    INSERT INTO briefings (
      sourceId, sourceName, originalUrl, title, summary, fullContent,
      publishedAt, publishedDateBJ, publicationTimeStatus, collectedAt, impactRating,
      impactRatingScore, deduplicationHash, titleSimhash,
      isRead, readAt, scanRunId, isCatchUp
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)
  `).run(
    input.sourceId,
    input.sourceName,
    `https://example.com/${input.sourceId}/${input.publishedAt}`,
    input.title,
    `${input.title}摘要`,
    input.publishedAt,
    input.date,
    input.publicationTimeStatus ?? 'exact',
    input.publishedAt,
    input.rating,
    input.rating === 'CRITICAL' ? 90 : input.rating === 'IMPORTANT' ? 70 : 20,
    `${input.sourceId}-${input.publishedAt}-${input.title}`,
    `${input.publishedAt}`,
    input.isRead ?? 0,
  )
}

describe('briefingRepository 来源筛选', () => {
  it('筛选文章时保留其他可切换来源的统计', () => {
    const db = createDb()
    try {
      insertBriefing(db, { sourceId: 1, sourceName: '来源甲', title: '甲一', date: '2026-07-25', rating: 'CRITICAL', publishedAt: 300 })
      insertBriefing(db, { sourceId: 1, sourceName: '来源甲', title: '甲二', date: '2026-07-25', rating: 'GENERAL', publishedAt: 200, isRead: 1 })
      insertBriefing(db, { sourceId: 2, sourceName: '来源乙', title: '乙一', date: '2026-07-25', rating: 'IMPORTANT', publishedAt: 100 })

      const result = listBriefings({ sourceId: 1, limit: 100 }, db)

      expect(result.total).toBe(2)
      expect(result.items.map(item => item.sourceId)).toEqual([1, 1])
      expect(result.sourceStats).toEqual([
        { sourceId: 1, sourceName: '来源甲', total: 2, unread: 1, highImpact: 1 },
        { sourceId: 2, sourceName: '来源乙', total: 1, unread: 1, highImpact: 1 },
      ])
    } finally {
      db.close()
    }
  })

  it('来源导航继续遵守日期和影响等级条件', () => {
    const db = createDb()
    try {
      insertBriefing(db, { sourceId: 1, sourceName: '来源甲', title: '甲重要', date: '2026-07-25', rating: 'IMPORTANT', publishedAt: 300 })
      insertBriefing(db, { sourceId: 2, sourceName: '来源乙', title: '乙重要', date: '2026-07-25', rating: 'IMPORTANT', publishedAt: 200 })
      insertBriefing(db, { sourceId: 2, sourceName: '来源乙', title: '乙旧闻', date: '2026-07-24', rating: 'IMPORTANT', publishedAt: 100 })
      insertBriefing(db, { sourceId: 3, sourceName: '来源丙', title: '丙一般', date: '2026-07-25', rating: 'GENERAL', publishedAt: 50 })

      const result = listBriefings({
        sourceId: 1,
        date: '2026-07-25',
        impactRating: 'IMPORTANT',
      }, db)

      expect(result.items.map(item => item.title)).toEqual(['甲重要'])
      expect(result.sourceStats.map(item => [item.sourceId, item.total]).sort((a, b) => a[0] - b[0]))
        .toEqual([[1, 1], [2, 1]])
    } finally {
      db.close()
    }
  })

  it('按发布时间可信状态筛选，并且批量已读只作用于完整筛选交集', () => {
    const db = createDb()
    try {
      insertBriefing(db, {
        sourceId: 1,
        sourceName: '来源甲',
        title: '甲确认',
        date: '2026-07-25',
        rating: 'IMPORTANT',
        publishedAt: 300,
      })
      insertBriefing(db, {
        sourceId: 1,
        sourceName: '来源甲',
        title: '甲待校时',
        date: '2026-07-25',
        rating: 'IMPORTANT',
        publicationTimeStatus: 'collected_fallback',
        publishedAt: 200,
      })
      insertBriefing(db, {
        sourceId: 2,
        sourceName: '来源乙',
        title: '乙确认',
        date: '2026-07-25',
        rating: 'IMPORTANT',
        publishedAt: 100,
      })

      expect(listBriefings({ date: '2026-07-25', publicationTimeScope: 'confirmed' }, db).items.map(item => item.title))
        .toEqual(['甲确认', '乙确认'])
      expect(listBriefings({ date: '2026-07-25', publicationTimeScope: 'uncertain' }, db).items.map(item => item.title))
        .toEqual(['甲待校时'])

      expect(markAllAsRead({ search: '完全不存在的词' }, db)).toEqual({ count: 0, dates: [] })
      expect(db.prepare('SELECT COUNT(*) AS count FROM briefings WHERE isRead = 1').get()).toEqual({ count: 0 })

      const marked = markAllAsRead({
        date: '2026-07-25',
        sourceId: 1,
        publicationTimeScope: 'confirmed',
      }, db)
      expect(marked).toEqual({ count: 1, dates: ['2026-07-25'] })
      expect(db.prepare('SELECT title, isRead FROM briefings ORDER BY id').all()).toEqual([
        { title: '甲确认', isRead: 1 },
        { title: '甲待校时', isRead: 0 },
        { title: '乙确认', isRead: 0 },
      ])
    } finally {
      db.close()
    }
  })
})
