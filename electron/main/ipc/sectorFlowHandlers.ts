import { ipcMain } from 'electron'
import { getDb } from '../database/db'
import {
  computeSectorFlowSnapshot,
  invalidateSectorFlowCache,
} from '../services/sectorFlowService'
import {
  getSectorConceptSource,
  setSectorConceptSource,
} from '../database/settingsRepository'

const VALID_SOURCES = ['kpl', 'ths', 'dc'] as const

export function registerSectorFlowHandlers(): void {
  /** FR-157: 获取板块资金流向快照（60s TTL 缓存） */
  ipcMain.handle('sectorFlow:getSnapshot', async (_event, args: { forceRefresh?: boolean } = {}) => {
    try {
      const db = getDb()

      const snapshot = await computeSectorFlowSnapshot(db, args.forceRefresh)
      return { ok: true, snapshot }
    } catch (err) {
      console.error('[SectorFlow] getSnapshot error:', err)
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
