import { BrowserWindow, Notification } from 'electron'
import { getSettings } from '../database/settingsRepository'
import type { DecisionSignalRow } from '../database/types'

const MAX_BODY_LENGTH = 180

export function notifyDecisionSignalNative(signal: DecisionSignalRow, win?: BrowserWindow): void {
  try {
    const settings = getSettings()
    if ((settings.decision_notify_windows_enabled ?? 0) !== 1) return
    const minPriority = clampPriority(settings.decision_notify_min_priority ?? 4)
    if (signal.priority < minPriority) return
    if (!Notification.isSupported()) return

    const notification = new Notification({
      title: buildTitle(signal),
      body: truncate(signal.summary, MAX_BODY_LENGTH),
      silent: false,
    })
    notification.on('click', () => {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
    })
    notification.show()
  } catch (err) {
    console.warn('[decisionNotification] native notification failed:', err)
  }
}

function buildTitle(signal: DecisionSignalRow): string {
  const subject = signal.stockName ?? signal.conceptName ?? signal.tsCode ?? signal.conceptCode
  if (!subject) return `P${signal.priority} ${signal.title}`
  return `P${signal.priority} ${subject} - ${signal.title}`
}

function truncate(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1)}...`
}

function clampPriority(value: number): number {
  if (!Number.isFinite(value)) return 4
  return Math.max(3, Math.min(5, Math.round(value)))
}
