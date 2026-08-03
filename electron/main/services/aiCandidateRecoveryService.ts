import type Database from 'better-sqlite3'
import { getSession, updateSessionResponse } from '../database/aiAnalysisSessionRepository'
import { extractStockCodeEntries } from '../aiPromptDefaults'

export type CandidateRecoveryErrorCode = 'NOT_FOUND' | 'INVALID_STATE'

export class CandidateRecoveryError extends Error {
  constructor(
    public readonly code: CandidateRecoveryErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CandidateRecoveryError'
  }
}

export interface CandidateRecoveryAttempt {
  response: string
}

export interface SessionCandidateRecoveryResult {
  recovered: boolean
  updated: boolean
  stockCodes: string[]
  response: string
}

function parseStoredArticleUrls(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export async function recoverSessionCandidates(
  db: Database.Database,
  sessionId: number,
  attemptRecovery: (response: string) => Promise<CandidateRecoveryAttempt>,
): Promise<SessionCandidateRecoveryResult> {
  const session = getSession(db, sessionId)
  if (!session) throw new CandidateRecoveryError('NOT_FOUND', '分析会话不存在')
  if (session.isError || !session.response || parseStoredArticleUrls(session.articleUrls).length === 0) {
    throw new CandidateRecoveryError('INVALID_STATE', '当前会话没有可用于A股标的映射的文章研判')
  }

  const existing = extractStockCodeEntries(session.response).map((entry) => entry.code)
  if (existing.length > 0) {
    return {
      recovered: false,
      updated: false,
      stockCodes: existing,
      response: session.response,
    }
  }

  const recovery = await attemptRecovery(session.response)
  const stockCodes = extractStockCodeEntries(recovery.response).map((entry) => entry.code)
  updateSessionResponse(db, sessionId, recovery.response)
  return {
    recovered: stockCodes.length > 0,
    updated: true,
    stockCodes,
    response: recovery.response,
  }
}
