import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
  app: {},
  dialog: {},
}))
vi.mock('../../electron/main/services/decisionNotificationService', () => ({
  notifyDecisionSignalNative: vi.fn(),
}))
import { runMigrations } from '../../electron/main/database/db'
import { createSession, getSession } from '../../electron/main/database/aiAnalysisSessionRepository'
import { upsertStructuredResult } from '../../electron/main/database/aiAnalysisStructuredResultRepository'
import { addPortfolioStock } from '../../electron/main/database/portfolioRepository'
import {
  buildPortfolioRiskSignalInputs,
  emitPortfolioRiskSignals,
  getStructuredResult,
  type StructuredCandidateStock,
} from '../../electron/main/services/aiStructuredResultService'

function candidate(overrides: Partial<StructuredCandidateStock> = {}): StructuredCandidateStock {
  return {
    code: '600000',
    name: '浦发银行',
    direction: 'negative',
    evidenceLevel: 'direct',
    reason: '监管变化可能增加合规成本',
    confidence: 0.82,
    evidence: ['文章明确描述成本上升'],
    riskNotes: ['实际影响仍需公告验证'],
    ...overrides,
  }
}

describe('FR-240 持仓风险信号', () => {
  it('只把利空持仓候选转换为P4/P5风险输入', () => {
    const session = {
      id: 7, createdAt: Date.now(), provider: 'chatgpt' as const, model: 'gpt-5.6-sol',
      articleUrls: '["https://example.com/news"]', promptSent: '', response: '', responseRound2: null,
      messages: null, scanRunId: null, briefingId: null, isError: 0,
    }
    const inputs = buildPortfolioRiskSignalInputs(session, [
      candidate(),
      candidate({ code: '000001', direction: 'positive' }),
      candidate({ code: '600519', evidenceLevel: 'inferred' }),
    ], [
      { tsCode: '600000.SH', stockName: '浦发银行', addedAt: 1, costPrice: null },
      { tsCode: '000001.SZ', stockName: '平安银行', addedAt: 1, costPrice: null },
    ])

    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toEqual(expect.objectContaining({
      sourceModule: 'ai', signalType: 'RISK', direction: 'BEARISH', priority: 5,
      tsCode: '600000.SH', dedupKey: 'ai:news_portfolio_negative:7:600000',
    }))
    expect(inputs[0].reason).toEqual(expect.objectContaining({ isPortfolio: true, evidenceLevel: 'direct' }))
  })

  it('写入幂等决策信号并兼容V1候选读取', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      const sessionId = createSession(db, {
        provider: 'chatgpt', model: 'gpt-5.6-sol', articleUrls: ['https://example.com/news'],
        promptSent: 'prompt', response: 'response', scanRunId: null, isError: false,
      })
      addPortfolioStock(db, '600000.SH', '浦发银行')
      const session = getSession(db, sessionId)!
      emitPortfolioRiskSignals(db, session, [candidate()])
      emitPortfolioRiskSignals(db, session, [candidate()])

      const signals = db.prepare(`
        SELECT source_module, signal_type, direction, priority, dedup_key, occurrence_count, reason_json
        FROM decision_signals WHERE source_module = 'ai'
      `).all() as Array<Record<string, unknown>>
      expect(signals).toHaveLength(1)
      expect(signals[0]).toEqual(expect.objectContaining({
        source_module: 'ai', signal_type: 'RISK', direction: 'BEARISH', priority: 5,
        dedup_key: `ai:news_portfolio_negative:${sessionId}:600000`, occurrence_count: 1,
      }))
      expect(JSON.parse(String(signals[0].reason_json))).toEqual(expect.objectContaining({ isPortfolio: true }))

      upsertStructuredResult(db, {
        sessionId, schemaVersion: 1, status: 'completed', summary: '旧结果', confidence: 0.5,
        primaryTheme: '银行', themesJson: '[]',
        candidateStocksJson: JSON.stringify([{ code: '600000', name: '浦发银行', reason: '旧候选', confidence: 0.5, evidence: [], riskNotes: [] }]),
        riskFactorsJson: '[]', verificationItemsJson: '[]', sourceRefsJson: '[]', rawJson: null,
        errorMessage: null, generatedAt: Date.now(),
      })
      expect(getStructuredResult(db, sessionId)?.candidateStocks[0]).toEqual(expect.objectContaining({
        direction: 'unclear', evidenceLevel: 'unverified',
      }))
    } finally {
      db.close()
    }
  })
})
