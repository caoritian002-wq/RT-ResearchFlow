import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import {
  completeAiEvaluationRun,
  createAiEvaluationRun,
  failInterruptedAiEvaluationRuns,
  findPreviousComparableAiEvaluationRun,
  getActiveAiEvaluationRun,
  getAiEvaluationRun,
  listAiEvaluationCaseResults,
  saveAiEvaluationCaseResult,
  updateAiEvaluationProgress,
} from '../../electron/main/database/aiEvaluationRepository'
import type { AiEvaluationCaseScore } from '../../electron/main/services/aiEvaluationSuite'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  runMigrations(db)
  return db
}

function createRun(db: Database.Database, now: number, prompt = 'prompt-a'): number {
  return createAiEvaluationRun(db, {
    suiteId: 'news-analysis-core',
    suiteVersion: '1.0.0',
    suiteFingerprint: 'suite',
    provider: 'chatgpt',
    model: 'gpt-test',
    businessPromptFingerprint: prompt,
    evaluationPromptFingerprint: `eval-${prompt}`,
    progressTotal: 4,
    now,
  })
}

const CASE_RESULT: AiEvaluationCaseScore = {
  caseId: 'case-1',
  title: '样本1',
  kind: 'round1',
  score: 100,
  conclusion: 'passed',
  rules: [{
    id: 'rule-1', dimension: 'candidateMapping', title: '规则1', passed: true,
    blocking: true, weight: 1, detail: '通过',
  }],
}

describe('aiEvaluationRepository', () => {
  it('保存运行进度、逐样本规则、Token和完成结论', () => {
    const db = createDb()
    const runId = createRun(db, 100)
    updateAiEvaluationProgress(db, runId, 0, 'case-1')
    saveAiEvaluationCaseResult(db, {
      runId,
      result: CASE_RESULT,
      responseText: 'response',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      completedAt: 110,
    })
    updateAiEvaluationProgress(db, runId, 1, null)
    completeAiEvaluationRun(db, runId, {
      score: 100,
      conclusion: 'passed',
      blockingFailures: 0,
      dimensionScores: {
        candidateMapping: 100,
        directionAccuracy: 100,
        evidenceDiscipline: 100,
        marketGrounding: 100,
        compliance: 100,
      },
    }, 120)

    expect(getAiEvaluationRun(db, runId)).toMatchObject({
      status: 'completed', totalScore: 100, conclusion: 'passed',
      inputTokens: 100, outputTokens: 50, totalTokens: 150,
    })
    expect(listAiEvaluationCaseResults(db, runId)).toEqual([
      expect.objectContaining({ caseId: 'case-1', responseText: 'response', score: 100 }),
    ])
  })

  it('应用重启将遗留运行中记录收口为失败', () => {
    const db = createDb()
    const runId = createRun(db, 100)
    expect(getActiveAiEvaluationRun(db)?.id).toBe(runId)
    expect(failInterruptedAiEvaluationRuns(db, 200)).toBe(1)
    expect(getActiveAiEvaluationRun(db)).toBeNull()
    expect(getAiEvaluationRun(db, runId)).toMatchObject({
      status: 'failed', conclusion: 'failed', completedAt: 200,
    })
  })

  it('只有相同套件、模型和业务提示词指纹可作为比较基线', () => {
    const db = createDb()
    const first = createRun(db, 100)
    completeAiEvaluationRun(db, first, {
      score: 80, conclusion: 'warning', blockingFailures: 0,
      dimensionScores: { candidateMapping: 80, directionAccuracy: 80, evidenceDiscipline: 80, marketGrounding: 80, compliance: 80 },
    }, 110)
    const changedPrompt = createRun(db, 200, 'prompt-b')
    completeAiEvaluationRun(db, changedPrompt, {
      score: 90, conclusion: 'passed', blockingFailures: 0,
      dimensionScores: { candidateMapping: 90, directionAccuracy: 90, evidenceDiscipline: 90, marketGrounding: 90, compliance: 90 },
    }, 210)
    const current = createRun(db, 300)
    completeAiEvaluationRun(db, current, {
      score: 85, conclusion: 'passed', blockingFailures: 0,
      dimensionScores: { candidateMapping: 85, directionAccuracy: 85, evidenceDiscipline: 85, marketGrounding: 85, compliance: 85 },
    }, 310)

    expect(findPreviousComparableAiEvaluationRun(db, getAiEvaluationRun(db, current)! )?.id).toBe(first)
  })
})
