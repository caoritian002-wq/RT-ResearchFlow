import type { BrowserWindow } from 'electron'
import type Database from 'better-sqlite3'
import { emitDecisionSignals, type DecisionSignalInput } from './decisionSignalService'

interface PriorityNewsRow {
  id: number
  title: string
  sourceName: string
  originalUrl: string | null
  impactRating: string
  impactRatingScore: number
  publishedAt: number | null
  summary: string | null
}

export function emitPriorityNewsSignalsForScan(
  db: Database.Database,
  briefingScanRunId: number,
  win?: BrowserWindow,
): number {
  const rows = db.prepare(`
    SELECT id, title, sourceName, originalUrl, impactRating, impactRatingScore, publishedAt, summary
    FROM briefings
    WHERE scanRunId = ?
      AND (impactRating = 'CRITICAL' OR impactRatingScore >= 30)
    ORDER BY impactRatingScore DESC, publishedAt DESC
    LIMIT 10
  `).all(briefingScanRunId) as PriorityNewsRow[]

  const signals: DecisionSignalInput[] = rows.map((row) => ({
    sourceModule: 'news',
    strategyKey: 'news.critical',
    signalType: 'INFO',
    direction: 'NEUTRAL',
    priority: row.impactRating === 'CRITICAL' ? 4 : 3,
    score: row.impactRatingScore,
    confidence: 70,
    title: row.title,
    summary: row.summary ?? row.title,
    reason: { impactRating: row.impactRating, impactRatingScore: row.impactRatingScore },
    sourceRef: {
      briefingId: row.id,
      sourceName: row.sourceName,
      originalUrl: row.originalUrl,
      scanRunId: briefingScanRunId,
    },
    signalTime: row.publishedAt ?? Date.now(),
    dedupKey: `news:critical:${row.id}`,
  }))

  emitDecisionSignals(db, signals, win)
  return signals.length
}
