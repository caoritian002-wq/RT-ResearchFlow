import { useCallback, useEffect, useRef, useState } from 'react'
import {
  parseDecisionSignalBriefingId,
  type DecisionSignalToastSignal,
} from './decisionSignalToastModel'

export const PRIORITY_NEWS_PREVIEW_INTERVAL_MS = 60_000

export type PriorityNewsPreviewStatus = 'idle' | 'loading' | 'ready' | 'running' | 'empty' | 'error'

export interface PriorityNewsPreviewState {
  status: PriorityNewsPreviewStatus
  candidateCount: number
  shownCount: number
  lastTitle: string | null
  message: string | null
}

const INITIAL_STATE: PriorityNewsPreviewState = {
  status: 'idle',
  candidateCount: 0,
  shownCount: 0,
  lastTitle: null,
  message: null,
}

export function selectPriorityNewsPreviewSignals(
  signals: readonly DecisionSignalToastSignal[],
): DecisionSignalToastSignal[] {
  const unique = new Map<number, DecisionSignalToastSignal>()
  for (const signal of signals) {
    if (signal.sourceModule !== 'news' || signal.priority < 4) continue
    const briefingId = parseDecisionSignalBriefingId(signal)
    if (briefingId === null) continue
    const previous = unique.get(briefingId)
    if (!previous || signal.signalTime > previous.signalTime) unique.set(briefingId, signal)
  }

  return [...unique.values()].sort((left, right) => (
    right.priority - left.priority
    || right.signalTime - left.signalTime
    || right.id - left.id
  ))
}

export function useDecisionSignalToastPreview(
  onPreview: (signal: DecisionSignalToastSignal) => void,
): {
  state: PriorityNewsPreviewState
  start: () => Promise<boolean>
  showNext: () => Promise<boolean>
  stop: () => void
} {
  const [state, setState] = useState<PriorityNewsPreviewState>(INITIAL_STATE)
  const candidatesRef = useRef<DecisionSignalToastSignal[]>([])
  const nextIndexRef = useRef(0)
  const intervalRef = useRef<number | null>(null)

  const clearPreviewInterval = useCallback(() => {
    if (intervalRef.current === null) return
    window.clearInterval(intervalRef.current)
    intervalRef.current = null
  }, [])

  const loadCandidates = useCallback(async (): Promise<DecisionSignalToastSignal[]> => {
    if (!import.meta.env.DEV) return []
    setState((current) => ({ ...current, status: 'loading', message: null }))
    try {
      const [todayResponse, historyResponse] = await Promise.all([
        window.api.decision.getTodaySignals({
          sourceModules: ['news'],
          minPriority: 4,
          limit: 100,
        }),
        window.api.decision.getHistorySignals({
          rangeDays: 180,
          sourceModules: ['news'],
          limit: 100,
        }),
      ])
      if (!todayResponse.ok && !historyResponse.ok) {
        throw new Error(
          todayResponse.message
          || historyResponse.message
          || todayResponse.error
          || historyResponse.error
          || '读取本地重大资讯失败',
        )
      }
      const candidates = selectPriorityNewsPreviewSignals([
        ...(todayResponse.data ?? []),
        ...(todayResponse.carryover ?? []),
        ...(historyResponse.data?.items ?? []),
      ])
      candidatesRef.current = candidates
      nextIndexRef.current = 0
      if (candidates.length === 0) {
        setState({
          status: 'empty',
          candidateCount: 0,
          shownCount: 0,
          lastTitle: null,
          message: '本地账本中没有带有效资讯原文的 P4/P5 信号。',
        })
        return []
      }
      setState({
        status: 'ready',
        candidateCount: candidates.length,
        shownCount: 0,
        lastTitle: null,
        message: null,
      })
      return candidates
    } catch (error) {
      candidatesRef.current = []
      nextIndexRef.current = 0
      setState({
        status: 'error',
        candidateCount: 0,
        shownCount: 0,
        lastTitle: null,
        message: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }, [])

  const presentNext = useCallback((): boolean => {
    const candidates = candidatesRef.current
    if (candidates.length === 0) return false
    const signal = candidates[nextIndexRef.current % candidates.length]
    nextIndexRef.current = (nextIndexRef.current + 1) % candidates.length
    onPreview(signal)
    setState((current) => ({
      ...current,
      shownCount: current.shownCount + 1,
      lastTitle: signal.title,
      message: null,
    }))
    return true
  }, [onPreview])

  const start = useCallback(async (): Promise<boolean> => {
    if (!import.meta.env.DEV) return false
    clearPreviewInterval()
    const candidates = await loadCandidates()
    if (candidates.length === 0) return false
    setState((current) => ({ ...current, status: 'running' }))
    presentNext()
    intervalRef.current = window.setInterval(() => {
      presentNext()
    }, PRIORITY_NEWS_PREVIEW_INTERVAL_MS)
    return true
  }, [clearPreviewInterval, loadCandidates, presentNext])

  const showNext = useCallback(async (): Promise<boolean> => {
    if (!import.meta.env.DEV) return false
    if (candidatesRef.current.length === 0) {
      const candidates = await loadCandidates()
      if (candidates.length === 0) return false
    }
    return presentNext()
  }, [loadCandidates, presentNext])

  const stop = useCallback(() => {
    clearPreviewInterval()
    setState((current) => ({
      ...current,
      status: current.candidateCount > 0 ? 'ready' : 'idle',
      message: null,
    }))
  }, [clearPreviewInterval])

  useEffect(() => () => clearPreviewInterval(), [clearPreviewInterval])

  return { state, start, showNext, stop }
}
