import type { ResearchDiscussionReturnTarget } from '../../store/appStore'

export type ResearchDiscussionOriginType = 'daily_review' | 'weekly_review' | 'decision_signal' | 'judgment' | 'industry_research' | 'briefing' | 'manual'
export type ResearchDiscussionStatus = 'active' | 'changes_ready' | 'partially_applied' | 'applied' | 'archived'

export interface ResearchDiscussionContextItem {
  key: string
  type: string
  label: string
  excerpt: string
  removable: boolean
}

export interface ResearchDiscussionSummary {
  sessionId: number
  status: ResearchDiscussionStatus
  origin: {
    type: ResearchDiscussionOriginType
    id: string | null
    title: string
    occurredAt: number | null
    available: boolean
  }
  projectId: string | null
  projectTitle: string | null
  baseSnapshotId: string | null
  baseSelectionReason: 'latest_compatible' | 'empty_project' | 'unassigned'
  returnTarget: ResearchDiscussionReturnTarget
  summarizedThroughMessageIndex: number | null
  latestBatchId: string | null
  degradedReason?: string | null
  createdAt: number
  updatedAt: number
}

export interface ResearchCandidateBatchSummary {
  id: string
  requestId: string
  sourceType: 'discussion' | 'archive'
  sourceSessionId: number | null
  projectId: string | null
  baseSnapshotId: string | null
  messageStartIndex: number | null
  messageEndIndex: number | null
  status: 'draft' | 'ready' | 'partially_resolved' | 'resolved' | 'failed' | 'cancelled'
  changeSetCount: number
  candidateCount: number
  conflictCount: number
  createdAt: number
}

export interface ResearchChangeSetSummary {
  id: string
  batchId: string
  title: string
  summary: string
  generatedTitle?: string
  generatedSummary?: string
  userEdited?: boolean
  impact: string
  action: 'add' | 'revise' | 'strengthen' | 'weaken' | 'refute' | 'reopen' | 'follow_up' | 'no_change'
  status: 'pending' | 'accepted' | 'rejected' | 'deferred' | 'superseded' | 'conflicted' | 'invalid'
  risk: 'low' | 'medium' | 'high'
  affectedObjects: Array<{ type: string; id: string | null; label: string }>
  evidenceSummary: string[]
  confidenceBoundary: string
  requiresExpandedReview: boolean
  candidateCount: number
  sourceSessionId: number | null
  messageStartIndex: number | null
  messageEndIndex: number | null
}

export interface ResearchChangeCandidate {
  id: string
  changeSetId: string
  batchId: string
  projectId: string | null
  kind: string
  action: string
  status: string
  statementType: 'fact' | 'estimate' | 'hypothesis' | 'candidate'
  primarySource: boolean
  sourceLocator: string
  targetEntityId: string | null
  payload: Record<string, unknown>
  conflicts: string[]
  warnings: string[]
}

export interface IndustryResearchSnapshotSummary {
  id: string
  projectId: string
  previousSnapshotId: string | null
  triggerBatchId: string
  sourceSessionId: number | null
  schemaVersion: number
  graphUpdatedAt: number
  createdAt: number
  title: string
  acceptedChangeSetCount: number
}

export interface ResearchApiResponse<T> {
  ok: boolean
  data?: T
  code?: string
  error?: string
  message?: string
  details?: unknown
}
