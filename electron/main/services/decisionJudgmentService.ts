import type Database from 'better-sqlite3'
import {
  DecisionJudgmentRepositoryError,
  getDecisionJudgmentSummaryByRequestId,
  saveDecisionJudgmentVersion,
  type SaveDecisionJudgmentInput,
} from '../database/decisionJudgmentRepository'
import {
  getDecisionSignalById,
  resolveDecisionSignalStatus,
  updateDecisionSignalStatus,
} from '../database/decisionSignalsRepository'
import type {
  DecisionJudgmentSummary,
  DecisionJudgmentTag,
  DecisionSignalResolution,
  DecisionSignalRow,
  DecisionSignalStatus,
} from '../database/types'

export type DecisionJudgmentServiceErrorCode = 'SOURCE_SIGNAL_NOT_FOUND' | 'INVALID_PARAM'

export class DecisionJudgmentServiceError extends Error {
  constructor(public readonly code: DecisionJudgmentServiceErrorCode, message: string) {
    super(message)
    this.name = 'DecisionJudgmentServiceError'
  }
}

export interface SaveDecisionJudgmentResult extends DecisionJudgmentSummary {
  projectedSignal: DecisionSignalRow | null
}

interface SignalProjection {
  status: DecisionSignalStatus
  resolution: DecisionSignalResolution | null
}

export function saveDecisionJudgment(
  db: Database.Database,
  input: SaveDecisionJudgmentInput,
  now = Date.now(),
): SaveDecisionJudgmentResult {
  const save = db.transaction(() => {
    const existing = getDecisionJudgmentSummaryByRequestId(db, input.requestId)
    if (existing) {
      return {
        ...existing,
        projectedSignal: existing.sourceSignalId == null ? null : getDecisionSignalById(db, existing.sourceSignalId),
      }
    }

    const sourceSignal = input.sourceSignalId == null ? null : getDecisionSignalById(db, input.sourceSignalId)
    if (input.sourceSignalId != null && !sourceSignal) {
      throw new DecisionJudgmentServiceError('SOURCE_SIGNAL_NOT_FOUND', '来源信号不存在')
    }
    if (sourceSignal?.tsCode && normalizeTsCode(sourceSignal.tsCode) !== normalizeTsCode(input.tsCode)) {
      throw new DecisionJudgmentServiceError('INVALID_PARAM', '来源信号与判断股票不一致')
    }

    const judgment = saveDecisionJudgmentVersion(db, input, now)
    if (!sourceSignal) return { ...judgment, projectedSignal: null }

    const projection = projectionForTag(input.tag, input.note)
    const note = formatJudgmentProjection(input.tag, input.note)
    const statusUpdated = updateDecisionSignalStatus(db, sourceSignal.id, projection.status, now, { note })
    if (!statusUpdated) throw new DecisionJudgmentServiceError('SOURCE_SIGNAL_NOT_FOUND', '来源信号不存在')
    if (projection.resolution) {
      const resolutionUpdated = resolveDecisionSignalStatus(db, sourceSignal.id, projection.resolution, note, now)
      if (!resolutionUpdated) throw new DecisionJudgmentServiceError('SOURCE_SIGNAL_NOT_FOUND', '来源信号不存在')
    }
    return { ...judgment, projectedSignal: getDecisionSignalById(db, sourceSignal.id) }
  })

  return save()
}

function projectionForTag(tag: DecisionJudgmentTag, note: string | undefined): SignalProjection {
  if (tag === 'noise') return { status: 'DISMISSED', resolution: 'RESOLVED_DUPLICATE' }
  if (tag === 'done') return { status: 'READ', resolution: 'RESOLVED_VALID' }
  if (tag === 'insufficient') return { status: 'WATCHING', resolution: 'RESOLVED_DATA_ISSUE' }
  if (tag === 'risk_off') return { status: 'WATCHING', resolution: 'RESOLVED_VALID' }
  return { status: 'WATCHING', resolution: note?.trim() ? 'RESOLVED_VALID' : null }
}

function formatJudgmentProjection(tag: DecisionJudgmentTag, note: string | undefined): string {
  const body = note?.trim() ?? ''
  return body ? `[judgment:${tag}] ${body}` : `[judgment:${tag}]`
}

function normalizeTsCode(tsCode: string): string {
  return tsCode.trim().toUpperCase().split('.')[0] ?? ''
}

export function isDecisionJudgmentExpectedError(
  error: unknown,
): error is DecisionJudgmentRepositoryError | DecisionJudgmentServiceError {
  return error instanceof DecisionJudgmentRepositoryError || error instanceof DecisionJudgmentServiceError
}