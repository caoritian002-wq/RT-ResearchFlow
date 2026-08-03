import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import {
  DecisionReviewReportRepositoryError,
  REVIEW_REPORT_MAX_BYTES,
  deleteReviewReport,
  getReviewReport,
  listReviewReports,
  saveReviewReport,
} from '../../electron/main/database/decisionReviewReportRepository'

function report(generatedAt: number, headline = '今日组合风险可控') {
  return {
    kind: 'daily' as const,
    rangeDays: 1,
    generatedAt,
    title: '2026-07-15 日复盘',
    headline,
    summary: {
      holdingCount: 2,
      portfolioSignalCount: 3,
      processedCount: 1,
      openRiskCount: 1,
      evidenceGapCount: 0,
      followUpCount: 1,
    },
    processed: [],
    openRisks: [{ signalId: 1 }],
    evidenceGaps: [],
    followUps: [{ signalId: 2 }],
    disclaimer: '仅供研究记录，不构成投资建议。',
    emptyDay: false,
  }
}

describe('复盘报告快照仓库', () => {
  let db: Database.Database
  const now = Date.UTC(2026, 6, 15, 12)

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  it('同一请求幂等，同周期新请求创建不可变新版本', () => {
    const requestId = randomUUID()
    const first = saveReviewReport(db, {
      requestId,
      periodStart: '2026-07-15',
      periodEnd: '2026-07-15',
      report: report(now - 2_000),
    }, now)
    const retried = saveReviewReport(db, {
      requestId,
      periodStart: '2026-07-15',
      periodEnd: '2026-07-15',
      report: report(now - 1_000, '重试不应覆盖'),
    }, now)
    const second = saveReviewReport(db, {
      requestId: randomUUID(),
      periodStart: '2026-07-15',
      periodEnd: '2026-07-15',
      report: report(now),
    }, now)

    expect(retried.id).toBe(first.id)
    expect(getReviewReport(db, first.id).snapshot.headline).toBe('今日组合风险可控')
    expect(second).toMatchObject({ versionNumber: 2, versionCount: 2 })
    expect(listReviewReports(db).items).toEqual([expect.objectContaining({ id: second.id, versionCount: 2 })])
    expect(listReviewReports(db, { includeAllVersions: true }).items).toHaveLength(2)
  })

  it('列表不解析快照，详情隔离未知版本和损坏 JSON', () => {
    const saved = saveReviewReport(db, {
      requestId: randomUUID(),
      periodStart: '2026-07-15',
      periodEnd: '2026-07-15',
      report: report(now),
    }, now)
    db.prepare('UPDATE decision_review_reports SET schema_version = ? WHERE id = ?').run(99, saved.id)

    expect(listReviewReports(db).items).toHaveLength(1)
    expect(() => getReviewReport(db, saved.id)).toThrowError(
      expect.objectContaining<Partial<DecisionReviewReportRepositoryError>>({ code: 'UNSUPPORTED_SCHEMA' }),
    )

    db.prepare('UPDATE decision_review_reports SET schema_version = ?, snapshot_json = ? WHERE id = ?')
      .run(1, '{broken', saved.id)

    expect(listReviewReports(db).items).toHaveLength(1)
    expect(() => getReviewReport(db, saved.id)).toThrowError(
      expect.objectContaining<Partial<DecisionReviewReportRepositoryError>>({ code: 'CORRUPT_DATA' }),
    )
  })

  it('拒绝超限快照并只删除指定版本', () => {
    expect(() => saveReviewReport(db, {
      requestId: randomUUID(),
      periodStart: '2026-07-15',
      periodEnd: '2026-07-15',
      report: report(now, 'x'.repeat(REVIEW_REPORT_MAX_BYTES)),
    }, now)).toThrowError(expect.objectContaining<Partial<DecisionReviewReportRepositoryError>>({ code: 'PAYLOAD_TOO_LARGE' }))

    const first = saveReviewReport(db, {
      requestId: randomUUID(),
      periodStart: '2026-07-15',
      periodEnd: '2026-07-15',
      report: report(now - 1),
    }, now)
    const second = saveReviewReport(db, {
      requestId: randomUUID(),
      periodStart: '2026-07-15',
      periodEnd: '2026-07-15',
      report: report(now),
    }, now)

    expect(deleteReviewReport(db, first.id)).toEqual({ id: first.id })
    expect(getReviewReport(db, second.id)).toMatchObject({ id: second.id, versionNumber: 2, versionCount: 1 })
    expect(listReviewReports(db).items[0]).toMatchObject({ id: second.id, versionNumber: 2, versionCount: 1 })
  })
})