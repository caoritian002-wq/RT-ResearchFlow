import type Database from 'better-sqlite3'
import { BrowserWindow, Notification } from 'electron'
import {
  completePremarketNotificationDelivery,
  getPremarketNotificationDelivery,
  preparePremarketNotificationDelivery,
} from '../database/premarketNotificationRepository'
import { getPremarketScenarioVersion } from '../database/premarketScenarioVersionRepository'
import { PREMARKET_SCENARIO_RULE_VERSION } from './premarketScenarioModel'
import type { PremarketScenarioVersion } from './premarketRehearsalTypes'

export type PremarketNotificationRunResult =
  | 'disabled'
  | 'not_available'
  | 'already_delivered'
  | 'shown'
  | 'unsupported'
  | 'failed'

export interface PremarketNotificationAdapter {
  isSupported: () => boolean
  show: (input: { title: string; body: string; onClick: () => void }) => void
}

const electronNotificationAdapter: PremarketNotificationAdapter = {
  isSupported: () => Notification.isSupported(),
  show: ({ title, body, onClick }) => {
    const notification = new Notification({ title, body, silent: false })
    notification.on('click', onClick)
    notification.show()
  },
}

function truncate(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`
}

function formatCutoffClock(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

export function buildPremarketNotificationContent(
  version: PremarketScenarioVersion,
): { title: string; body: string } {
  const risks = version.scenario.holdings.filter((item) => item.state === 'risk').length
  const insufficient = version.scenario.holdings.filter((item) => item.state === 'insufficient').length
  const watch = version.scenario.holdings.filter((item) => item.state === 'watching').length
  const details = [
    risks > 0 ? `${risks}只存在反向证据` : '未形成组合级反向共振',
    watch > 0 ? `${watch}只等待确认` : null,
    insufficient > 0 ? `${insufficient}只证据不足` : null,
  ].filter(Boolean).join('，')
  return {
    title: `盘前推演 · ${formatCutoffClock(version.cutoffAt)}确认`,
    body: truncate(`${details}。点击查看确认条件、失效条件与未知项。`, 180),
  }
}

function openScenario(win?: BrowserWindow): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.webContents.send('premarket:openScenario')
}

export function deliverPremarketScenarioNotification(
  db: Database.Database,
  tradeDate: string,
  win?: BrowserWindow,
  now = Date.now(),
  adapter: PremarketNotificationAdapter = electronNotificationAdapter,
): PremarketNotificationRunResult {
  const setting = db.prepare('SELECT decision_notify_windows_enabled FROM app_settings WHERE id = 1')
    .get() as { decision_notify_windows_enabled: number } | undefined
  if (setting?.decision_notify_windows_enabled !== 1) return 'disabled'
  if (getPremarketNotificationDelivery(db, tradeDate)) return 'already_delivered'
  const version = getPremarketScenarioVersion(
    db,
    tradeDate,
    'auction_confirmed',
    PREMARKET_SCENARIO_RULE_VERSION,
  )
  if (!version) return 'not_available'
  const content = buildPremarketNotificationContent(version)
  const prepared = preparePremarketNotificationDelivery(db, {
    tradeDate,
    scenarioVersionId: version.id,
    ...content,
    attemptedAt: now,
  })
  if (!prepared.created) return 'already_delivered'
  if (!adapter.isSupported()) {
    completePremarketNotificationDelivery(db, tradeDate, 'unsupported', 'NOTIFICATION_UNSUPPORTED', now)
    return 'unsupported'
  }
  try {
    adapter.show({ ...content, onClick: () => openScenario(win) })
    completePremarketNotificationDelivery(db, tradeDate, 'shown', null, now)
    return 'shown'
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 120) : 'NOTIFICATION_FAILED'
    completePremarketNotificationDelivery(db, tradeDate, 'failed', code, now)
    return 'failed'
  }
}
