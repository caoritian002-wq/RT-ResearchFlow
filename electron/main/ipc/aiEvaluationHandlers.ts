import { ipcMain } from 'electron'
import { getDb } from '../database/db'
import { failInterruptedAiEvaluationRuns } from '../database/aiEvaluationRepository'
import {
  AiEvaluationError,
  getAiEvaluationRunDetail,
  getAiEvaluationWorkbench,
  startAiEvaluationRun,
} from '../services/aiEvaluationService'

function failure(error: unknown) {
  if (error instanceof AiEvaluationError) {
    return { ok: false as const, error: error.code, message: error.message }
  }
  return { ok: false as const, error: 'AI_EVALUATION_FAILED' as const, message: 'AI评测操作失败' }
}

export function registerAiEvaluationHandlers(): void {
  failInterruptedAiEvaluationRuns(getDb())

  ipcMain.handle('aiEvaluation:getWorkbench', () => {
    try {
      return { ok: true as const, data: getAiEvaluationWorkbench(getDb()) }
    } catch (error) {
      console.error('[aiEvaluation:getWorkbench] failed:', error)
      return failure(error)
    }
  })

  ipcMain.handle('aiEvaluation:startRun', (_event, payload?: { provider?: string }) => {
    try {
      return { ok: true as const, data: startAiEvaluationRun(getDb(), payload?.provider ?? '') }
    } catch (error) {
      console.error('[aiEvaluation:startRun] failed:', error)
      return failure(error)
    }
  })

  ipcMain.handle('aiEvaluation:getRun', (_event, payload?: { runId?: number }) => {
    const runId = Number(payload?.runId)
    if (!Number.isInteger(runId) || runId <= 0) {
      return { ok: false as const, error: 'INVALID_PARAM' as const, message: '评测运行ID无效' }
    }
    try {
      return { ok: true as const, data: getAiEvaluationRunDetail(getDb(), runId) }
    } catch (error) {
      console.error('[aiEvaluation:getRun] failed:', error)
      return failure(error)
    }
  })
}
