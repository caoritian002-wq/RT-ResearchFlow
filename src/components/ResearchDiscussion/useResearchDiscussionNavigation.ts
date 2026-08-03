import { useCallback, useState } from 'react'
import { useAppStore, type ResearchDiscussionReturnTarget } from '../../store/appStore'
import type {
  ResearchApiResponse,
  ResearchDiscussionOriginType,
  ResearchDiscussionSummary,
} from './researchDiscussionTypes'

export interface StartDiscussionRequest {
  origin: { type: ResearchDiscussionOriginType; id: string | null }
  projectId?: string | null
  initialQuestion?: string
  mode?: 'continue_or_create' | 'new'
  returnTarget: ResearchDiscussionReturnTarget
}

export type ResearchEvidenceSourceIdentity =
  | { sourceKind: 'discussion_message'; sessionId: number; messageIndex: number }
  | { sourceKind: 'industry_report'; projectId: string; runId: string }

export interface StartEvidenceDiscussionRequest {
  source: ResearchEvidenceSourceIdentity
  returnTarget: ResearchDiscussionReturnTarget
}

function sourceScrollTop(stateKey?: string): number | undefined {
  const selector = stateKey?.startsWith('industry-research:')
    ? '[data-testid="industry-research-workspace-scroll"]'
    : stateKey === 'review-report'
      ? '[data-testid="review-report-scroll"]'
      : stateKey === 'judgment-history'
        ? '[data-testid="judgment-history-scroll"]'
        : stateKey === 'stock-judgment'
          ? '[data-testid="stock-judgment-scroll"]'
          : stateKey === 'signal-detail'
            ? '[data-testid="signal-lifecycle-scroll"]'
            : '[data-testid="decision-workspace-scroll"]'
  const element = document.querySelector<HTMLElement>(selector)
  return element ? Math.max(0, Math.trunc(element.scrollTop)) : undefined
}

export function useResearchDiscussionNavigation() {
  const navigateToResearchDiscussion = useAppStore((state) => state.navigateToResearchDiscussion)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = useCallback(async (request: StartDiscussionRequest) => {
    setStarting(true)
    setError(null)
    try {
      const returnTarget = {
        ...request.returnTarget,
        scrollTop: request.returnTarget.scrollTop ?? sourceScrollTop(request.returnTarget.stateKey),
      }
      const response = await window.api.ai.startResearchDiscussion({
        requestId: crypto.randomUUID(),
        ...request,
        returnTarget,
      }) as ResearchApiResponse<{ discussion: ResearchDiscussionSummary; resumed: boolean; initialQuestion?: string | null }>
      if (!response.ok || !response.data) throw new Error(response.message || response.error || '启动研究讨论失败')
      navigateToResearchDiscussion(
        response.data.discussion.sessionId,
        response.data.resumed ? null : (response.data.initialQuestion ?? request.initialQuestion ?? null),
      )
      return response.data
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message)
      return null
    } finally {
      setStarting(false)
    }
  }, [navigateToResearchDiscussion])

  const startFromEvidence = useCallback(async (request: StartEvidenceDiscussionRequest) => {
    setStarting(true)
    setError(null)
    try {
      const returnTarget = {
        ...request.returnTarget,
        scrollTop: request.returnTarget.scrollTop ?? sourceScrollTop(request.returnTarget.stateKey),
      }
      const response = await window.api.researchEvidence.startDiscussion({
        ...request.source,
        requestId: crypto.randomUUID(),
        returnTarget,
      }) as ResearchApiResponse<{
        discussion: ResearchDiscussionSummary
        resumed: boolean
        initialQuestion?: string | null
      }>
      if (!response.ok || !response.data) {
        throw new Error(response.message || response.error || '创建事实变化讨论失败')
      }
      navigateToResearchDiscussion(
        response.data.discussion.sessionId,
        response.data.initialQuestion ?? null,
      )
      return { ok: true as const, data: response.data }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message)
      return { ok: false as const, message }
    } finally {
      setStarting(false)
    }
  }, [navigateToResearchDiscussion])

  return { start, startFromEvidence, starting, error, clearError: () => setError(null) }
}
