import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import {
  createAiEvaluationRun,
  getAiEvaluationRun,
  listAiEvaluationCaseResults,
} from '../../electron/main/database/aiEvaluationRepository'
import {
  AI_EVALUATION_CASES,
  AI_EVALUATION_SUITE_FINGERPRINT,
  AI_EVALUATION_SUITE_ID,
  AI_EVALUATION_SUITE_VERSION,
} from '../../electron/main/services/aiEvaluationSuite'
import { executeAiEvaluationRun } from '../../electron/main/services/aiEvaluationService'

const RESPONSES = [
  `事实：[1]沪电股份认证通过，构成直接正面线索；订单和财务影响待验证，后续属于推断。\nSTOCK_CODES: 002463|沪电股份`,
  `事实：[1]生益科技成本上升且售价未变，构成潜在利空并可能承压；幅度待验证。\nSTOCK_CODES: 600183|生益科技`,
  `[1]没有可解释的A股关系，因此无有效映射。\nSTOCK_CODES: NONE`,
  `维持沪电股份002463观察。行情数据边界来自本地，数据截止2026-07-18，最近30个交易日。业务兑现待验证并保留反证。MA5 49.20，MA20 47.30；支撑46.80和43.20，压力51.60和54.80。`,
]

function createDb(): Database.Database {
  const db = new Database(':memory:')
  runMigrations(db)
  return db
}

function createRun(db: Database.Database): number {
  return createAiEvaluationRun(db, {
    suiteId: AI_EVALUATION_SUITE_ID,
    suiteVersion: AI_EVALUATION_SUITE_VERSION,
    suiteFingerprint: AI_EVALUATION_SUITE_FINGERPRINT,
    provider: 'chatgpt',
    model: 'gpt-test',
    businessPromptFingerprint: 'business',
    evaluationPromptFingerprint: 'evaluation',
    progressTotal: AI_EVALUATION_CASES.length,
  })
}

describe('aiEvaluationService', () => {
  it('串行完成四个样本并保存Token和聚合结果', async () => {
    const db = createDb()
    const runId = createRun(db)
    let index = 0
    await executeAiEvaluationRun(db, runId, { articlePrompt: '业务提示词', skillsBlock: '' }, async () => {
      const text = RESPONSES[index++]
      return { text, usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } }
    })
    expect(index).toBe(4)
    expect(getAiEvaluationRun(db, runId)).toMatchObject({
      status: 'completed', progressCurrent: 4, inputTokens: 400, outputTokens: 200, totalTokens: 600,
    })
    expect(listAiEvaluationCaseResults(db, runId)).toHaveLength(4)
  })

  it('模型调用中途失败时保留已完成样本并进入失败终态', async () => {
    const db = createDb()
    const runId = createRun(db)
    let index = 0
    await expect(executeAiEvaluationRun(db, runId, { articlePrompt: '业务提示词', skillsBlock: '' }, async () => {
      if (index++ === 1) throw new Error('provider unavailable')
      return { text: RESPONSES[0] }
    })).rejects.toThrow('provider unavailable')
    expect(getAiEvaluationRun(db, runId)).toMatchObject({
      status: 'failed', progressCurrent: 1, errorMessage: 'provider unavailable',
    })
    expect(listAiEvaluationCaseResults(db, runId)).toHaveLength(1)
  })
})
