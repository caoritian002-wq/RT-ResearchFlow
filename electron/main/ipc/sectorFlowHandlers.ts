import { ipcMain } from 'electron'
import { getDb } from '../database/db'
import {
  getSectorFlowWorkbenchSnapshot,
  invalidateSectorFlowCache,
} from '../services/sectorFlowService'
import {
  getSectorConceptSource,
  setSectorConceptSource,
} from '../database/settingsRepository'

const VALID_SOURCES = ['kpl', 'ths', 'dc'] as const

interface SectorFlowSnapshotRequest {
  forceRefresh?: boolean
  tradeDate?: string | null
}

export function registerSectorFlowHandlers(): void {
  /** FR-157: 获取板块资金流向快照（60s TTL 缓存） */
  ipcMain.handle('sectorFlow:getSnapshot', async (_event, payload?: unknown) => {
    try {
      const request = parseSectorFlowSnapshotRequest(payload)
      const db = getDb()
      const snapshot = await getSectorFlowWorkbenchSnapshot(db, request)
      return { ok: true, snapshot }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message === 'INVALID_SECTOR_FLOW_REQUEST') {
        return {
          ok: false,
          error: 'INVALID_SECTOR_FLOW_REQUEST',
          message: '交易日期格式不正确，或不能选择未来日期。',
        }
      }
      if (
        message === 'SECTOR_FLOW_HISTORY_UNAVAILABLE'
        || message === 'SECTOR_FLOW_HISTORY_DATE_MISMATCH'
      ) {
        return {
          ok: false,
          error: 'SECTOR_FLOW_HISTORY_UNAVAILABLE',
          message: '该交易日没有已核验的本地板块资金存档，请选择其他交易日。',
        }
      }
      console.error('[SectorFlow] getSnapshot error:', message)
      return { ok: false, error: 'SECTOR_FLOW_FAILED', message: '板块资金加载失败，请稍后重试。' }
    }
  })

  /** FR-157: 读取当前板块资金流向题材源设置 */
  ipcMain.handle('sectorFlow:getConceptSource', () => {
    try {
      const source = getSectorConceptSource()
      return { ok: true, source }
    } catch (err) {
      console.error('[SectorFlow] getConceptSource error:', err)
      return { ok: false, error: String(err) }
    }
  })

  /** FR-157: 更新题材源并清空缓存 */
  ipcMain.handle('sectorFlow:setConceptSource', (_event, args: { source: string }) => {
    if (!VALID_SOURCES.includes(args?.source as typeof VALID_SOURCES[number])) {
      return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM' }
    }
    try {
      setSectorConceptSource(args.source as 'kpl' | 'ths' | 'dc')
      invalidateSectorFlowCache()
      return { ok: true }
    } catch (err) {
      console.error('[SectorFlow] setConceptSource error:', err)
      return { ok: false, error: String(err) }
    }
  })
}

function parseSectorFlowSnapshotRequest(payload: unknown): SectorFlowSnapshotRequest {
  if (payload === undefined) return {}
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('INVALID_SECTOR_FLOW_REQUEST')
  }
  const input = payload as Record<string, unknown>
  const allowedKeys = new Set(['forceRefresh', 'tradeDate'])
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new Error('INVALID_SECTOR_FLOW_REQUEST')
  }
  if (
    Object.prototype.hasOwnProperty.call(input, 'forceRefresh')
    && typeof input.forceRefresh !== 'boolean'
  ) {
    throw new Error('INVALID_SECTOR_FLOW_REQUEST')
  }
  if (
    Object.prototype.hasOwnProperty.call(input, 'tradeDate')
    && input.tradeDate !== null
    && typeof input.tradeDate !== 'string'
  ) {
    throw new Error('INVALID_SECTOR_FLOW_REQUEST')
  }
  const tradeDate = input.tradeDate as string | null | undefined
  if (typeof tradeDate === 'string' && (!isValidCompactDate(tradeDate) || tradeDate > beijingYmd())) {
    throw new Error('INVALID_SECTOR_FLOW_REQUEST')
  }
  return {
    ...(typeof input.forceRefresh === 'boolean' ? { forceRefresh: input.forceRefresh } : {}),
    ...(tradeDate ? { tradeDate } : {}),
  }
}

function isValidCompactDate(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(4, 6))
  const day = Number(value.slice(6, 8))
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
}

function beijingYmd(now = Date.now()): string {
  const date = new Date(now + 8 * 60 * 60 * 1000)
  return (
    `${date.getUTCFullYear()}`
    + `${String(date.getUTCMonth() + 1).padStart(2, '0')}`
    + `${String(date.getUTCDate()).padStart(2, '0')}`
  )
}
