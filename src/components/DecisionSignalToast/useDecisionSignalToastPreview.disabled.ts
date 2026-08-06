import type { DecisionSignalToastSignal } from './decisionSignalToastModel'
import type { PriorityNewsPreviewState } from './useDecisionSignalToastPreview'

const DISABLED_STATE: PriorityNewsPreviewState = {
  status: 'idle',
  candidateCount: 0,
  shownCount: 0,
  lastTitle: null,
  message: null,
}

async function rejectPreviewAction(): Promise<boolean> {
  return false
}

function stopDisabledPreview(): void {}

export function useDecisionSignalToastPreview(
  _onPreview: (signal: DecisionSignalToastSignal) => void,
): {
  state: PriorityNewsPreviewState
  start: () => Promise<boolean>
  showNext: () => Promise<boolean>
  stop: () => void
} {
  return {
    state: DISABLED_STATE,
    start: rejectPreviewAction,
    showNext: rejectPreviewAction,
    stop: stopDisabledPreview,
  }
}
