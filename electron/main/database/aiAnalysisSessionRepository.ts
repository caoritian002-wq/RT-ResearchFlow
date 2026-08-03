import type { Database } from 'better-sqlite3'
import type { AIAnalysisSessionRow, AIProvider } from './types'
import type { ResearchTextAudit } from '../services/researchEvidenceAuditService'

export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
  researchAgentRunId?: string
  webSearchTrace?: import('../services/aiProvider').AIWebSearchTrace
  researchAudit?: ResearchTextAudit
}

export interface CreateSessionParams {
  provider: AIProvider
  model: string
  articleUrls: string[] // will be JSON-stringified
  promptSent: string
  response: string | null
  scanRunId: number | null
  briefingId?: number | null // single-article analysis; mutually exclusive with scanRunId
  isError: boolean
  messages?: ConversationMessage[] | null
  createdAt?: number
}

export function createSession(db: Database, params: CreateSessionParams): number {
  const result = db
    .prepare(
      `INSERT INTO ai_analysis_sessions
        (createdAt, provider, model, articleUrls, promptSent, response, scanRunId, briefingId, isError, messages)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.createdAt ?? Date.now(),
      params.provider,
      params.model,
      JSON.stringify(params.articleUrls),
      params.promptSent,
      params.response,
      params.scanRunId ?? null,
      params.briefingId ?? null,
      params.isError ? 1 : 0,
      params.messages == null ? null : JSON.stringify(params.messages),
    )
  return result.lastInsertRowid as number
}

export function listSessions(db: Database): AIAnalysisSessionRow[] {
  return db
    .prepare(
      'SELECT * FROM ai_analysis_sessions ORDER BY createdAt DESC'
    )
    .all() as AIAnalysisSessionRow[]
}

export function getSession(db: Database, id: number): AIAnalysisSessionRow | null {
  return (
    (db
      .prepare('SELECT * FROM ai_analysis_sessions WHERE id = ?')
      .get(id) as AIAnalysisSessionRow) || null
  )
}

export function updateSessionRound2(db: Database, id: number, responseRound2: string): void {
  db.prepare('UPDATE ai_analysis_sessions SET responseRound2 = ? WHERE id = ?').run(responseRound2, id)
}

export function updateSessionResponse(db: Database, id: number, response: string): void {
  db.prepare('UPDATE ai_analysis_sessions SET response = ? WHERE id = ?').run(response, id)
}

export function updateSessionMessages(db: Database, id: number, messages: ConversationMessage[]): void {
  db.prepare('UPDATE ai_analysis_sessions SET messages = ? WHERE id = ?').run(JSON.stringify(messages), id)
}

export function deleteSession(db: Database, id: number): void {
  db.prepare('DELETE FROM ai_analysis_sessions WHERE id = ?').run(id)
}

export function deleteAllSessions(db: Database, includeResearchDiscussions = false): number {
  const result = includeResearchDiscussions
    ? db.prepare('DELETE FROM ai_analysis_sessions').run()
    : db.prepare(`
        DELETE FROM ai_analysis_sessions
        WHERE NOT EXISTS (
          SELECT 1 FROM ai_research_discussion_contexts c WHERE c.session_id = ai_analysis_sessions.id
        )
      `).run()
  return result.changes
}

export function deleteSessionsOlderThan(
  db: Database,
  olderThanMs: number,
  dryRun: boolean
): { count: number; deleted: number } {
  const cutoff = Date.now() - olderThanMs
  const countRow = db
    .prepare(`
      SELECT COUNT(*) as cnt FROM ai_analysis_sessions s
      WHERE s.createdAt < ?
        AND NOT EXISTS (SELECT 1 FROM ai_research_discussion_contexts c WHERE c.session_id = s.id)
    `)
    .get(cutoff) as { cnt: number }
  const count = countRow.cnt
  if (dryRun) return { count, deleted: 0 }
  const result = db
    .prepare(`
      DELETE FROM ai_analysis_sessions
      WHERE createdAt < ?
        AND NOT EXISTS (
          SELECT 1 FROM ai_research_discussion_contexts c WHERE c.session_id = ai_analysis_sessions.id
        )
    `)
    .run(cutoff)
  return { count, deleted: result.changes }
}
