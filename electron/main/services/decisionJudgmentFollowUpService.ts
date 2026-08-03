import type Database from 'better-sqlite3'
import {
  DecisionJudgmentFollowUpRepositoryError,
  getDecisionJudgmentFollowUpByRequestId,
  insertDecisionJudgmentFollowUp,
} from '../database/decisionJudgmentFollowUpRepository'
import {
  DecisionJudgmentRepositoryError,
  getDecisionJudgment,
  getDecisionJudgmentSummary,
  saveDecisionJudgmentVersion,
} from '../database/decisionJudgmentRepository'
import type {
  DecisionJudgmentFollowUpAction,
  DecisionJudgmentFollowUpRecord,
  DecisionJudgmentSummary,
  DecisionJudgmentTag,
} from '../database/types'

export interface CompleteDecisionJudgmentFollowUpInput {
  requestId: string
  judgmentId: string
  action: DecisionJudgmentFollowUpAction
  tag?: DecisionJudgmentTag
  note?: string
  nextReviewDueAt?: number | null
}

export interface CompleteDecisionJudgmentFollowUpResult extends DecisionJudgmentFollowUpRecord {
  resultJudgment: DecisionJudgmentSummary
}

export function completeDecisionJudgmentFollowUp(
  db: Database.Database,
  input: CompleteDecisionJudgmentFollowUpInput,
  now = Date.now(),
): CompleteDecisionJudgmentFollowUpResult {
  return db.transaction(() => {
    const existing = getDecisionJudgmentFollowUpByRequestId(db, input.requestId)
    if (existing) return { ...existing, resultJudgment: getDecisionJudgmentSummary(db, existing.resultJudgmentId) }

    const source = getDecisionJudgment(db, input.judgmentId)
    const latest = source.versions[0]
    if (!latest || latest.id !== source.id) {
      throw new DecisionJudgmentFollowUpRepositoryError('FOLLOW_UP_ALREADY_COMPLETED', '该判断已有后续版本')
    }
    if (source.reviewDueAt == null || source.reviewDueAt > now) {
      throw new DecisionJudgmentFollowUpRepositoryError('INVALID_PARAM', '判断尚未到回访时间')
    }
    if (!['maintain', 'revise', 'close'].includes(input.action)) {
      throw new DecisionJudgmentFollowUpRepositoryError('INVALID_PARAM', 'action 无效')
    }
    if (input.action === 'revise' && !input.tag) {
      throw new DecisionJudgmentFollowUpRepositoryError('INVALID_PARAM', '修正判断必须提供 tag')
    }

    const resultJudgment = saveDecisionJudgmentVersion(db, {
      requestId: input.requestId,
      judgmentGroupId: source.judgmentGroupId,
      tsCode: source.tsCode,
      stockName: source.stockName ?? undefined,
      tag: input.action === 'close' ? 'done' : (input.action === 'revise' ? input.tag! : source.tag),
      note: input.note?.trim() || source.note,
      sourceSignalId: source.sourceSignalAvailable ? source.sourceSignalId ?? undefined : undefined,
      relatedSignalIds: source.relatedSignalIds,
      evidenceSnapshot: source.evidenceSnapshot,
      reviewDueAt: input.action === 'close' ? null : input.nextReviewDueAt ?? null,
    }, now)
    const followUp = insertDecisionJudgmentFollowUp(db, {
      requestId: input.requestId,
      sourceJudgmentId: source.id,
      resultJudgmentId: resultJudgment.id,
      action: input.action,
      note: input.note,
    }, now)
    return { ...followUp, resultJudgment }
  })()
}

export function isDecisionJudgmentFollowUpExpectedError(
  error: unknown,
): error is DecisionJudgmentFollowUpRepositoryError | DecisionJudgmentRepositoryError {
  return error instanceof DecisionJudgmentFollowUpRepositoryError || error instanceof DecisionJudgmentRepositoryError
}
