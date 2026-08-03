import Store from 'electron-store'
import { getSettings } from '../database/settingsRepository'
import { runScan } from './scanEngine'

interface StoreSchema {
  lastCloseTime: number
  lastHeartbeat: number
}

let store: Store<StoreSchema> | null = null

function getStore(): Store<StoreSchema> {
  if (!store) store = new Store<StoreSchema>()
  return store
}

let _heartbeatTimer: ReturnType<typeof setInterval> | null = null

export function startHeartbeat(): void {
  // Write heartbeat every 60 seconds so we can detect crash vs clean close
  _heartbeatTimer = setInterval(() => {
    getStore().set('lastHeartbeat', Date.now())
  }, 60_000)
}

export function stopHeartbeat(): void {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer)
    _heartbeatTimer = null
  }
}

export function recordCloseTime(): void {
  getStore().set('lastCloseTime', Date.now())
}

/**
 * Determine if we need a catch-up scan and run it.
 * Decision tree:
 *   gap < 30 min   → skip
 *   30 min – 8 h   → quick scan (last hour only)
 *   8 h – 48 h     → full catch-up
 *   > 48 h         → partial catch-up (max catchUpMaxDays) + notify user
 */
export async function runCatchUpIfNeeded(
  onStatus: (msg: string) => void
): Promise<{ ran: boolean; newCount: number; scanRunId?: number }> {
  const lastClose = getStore().get('lastCloseTime') as number | undefined
  const lastHeartbeat = getStore().get('lastHeartbeat') as number | undefined

  // Use the more recent of close time and last heartbeat
  const lastActive = Math.max(lastClose ?? 0, lastHeartbeat ?? 0)
  if (!lastActive) {
    onStatus('首次启动，跳过补漏')
    return { ran: false, newCount: 0 }
  }

  const gapMs = Date.now() - lastActive
  const gapMin = gapMs / 60_000

  if (gapMin < 30) {
    return { ran: false, newCount: 0 }
  }

  const settings = getSettings()
  const maxDaysMs = settings.catchUpMaxDays * 24 * 60 * 60 * 1000

  let rangeStart: number
  let rangeEnd = Date.now()

  if (gapMin < 480) {
    // < 8 hours: quick scan — look back 1 hour from last active + gap
    rangeStart = lastActive - 60 * 60 * 1000
    onStatus(`检测到 ${Math.round(gapMin)} 分钟离线，正在补漏…`)
  } else if (gapMs < 48 * 60 * 60 * 1000) {
    // < 48 hours: full catch-up from last active
    rangeStart = lastActive
    onStatus(`检测到 ${Math.round(gapMs / 3_600_000)} 小时离线，正在全量补漏…`)
  } else {
    // > 48 hours: limit by catchUpMaxDays
    rangeStart = Math.max(lastActive, Date.now() - maxDaysMs)
    onStatus(`检测到长时间离线，补漏最近 ${settings.catchUpMaxDays} 天的数据…`)
  }

  try {
    const { runId, newBriefingsFound } = await runScan('CATCH_UP', {
      start: rangeStart,
      end: rangeEnd
    })
    onStatus(`补漏完成，新增 ${newBriefingsFound} 条资讯`)
    return { ran: true, newCount: newBriefingsFound, scanRunId: runId }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onStatus(`补漏失败: ${msg}`)
    return { ran: false, newCount: 0 }
  }
}
