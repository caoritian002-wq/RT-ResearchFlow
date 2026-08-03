import { ipcMain } from 'electron'
import { getDb } from '../database/db'
import { fetchMinuteBarsForUserTier, getMinuteCloudStatus, listMinuteDataCapabilities, resolveMinuteUserTier } from '../services/minuteData/minuteDataProviderRegistry'
import type { MinuteDataGranularity, MinuteDataPurpose } from '../services/minuteData/minuteDataTypes'

function normalizeGranularity(value: unknown): MinuteDataGranularity | undefined {
  return value === '1m' || value === '5m' ? value : undefined
}

function normalizePurpose(value: unknown): MinuteDataPurpose {
  return value === 'chart' || value === 'backtest' ? value : 'conditionBlocks'
}

export function registerMinuteDataHandlers(): void {
  ipcMain.handle('minuteData:getCapabilities', () => ({ ok: true, data: listMinuteDataCapabilities() }))
  ipcMain.handle('minuteData:getBars', async (_event, payload: { userTier?: unknown; purpose?: unknown; tsCode?: string; tradeDate?: string; preferredGranularity?: unknown; allowApproximate?: boolean }) => {
    try {
      const tradeDate = payload?.tradeDate
      if (!payload?.tsCode || !tradeDate || !/^\d{8}$/.test(tradeDate)) {
        return { ok: false, code: 'INVALID_PARAM', message: '缺少有效的 tsCode 或 tradeDate' }
      }
      const result = await fetchMinuteBarsForUserTier({
        db: getDb(),
        tsCode: payload.tsCode,
        tradeDate,
        userTier: resolveMinuteUserTier(payload.userTier),
        purpose: normalizePurpose(payload.purpose),
        preferredGranularity: normalizeGranularity(payload.preferredGranularity),
        allowApproximate: payload.allowApproximate !== false,
      })
      if (result.status !== 'success') {
        const code = result.status === 'unavailable' ? 'PROVIDER_UNAVAILABLE' : result.status === 'empty' ? 'EMPTY_DATA' : 'UPSTREAM_ERROR'
        return { ok: false, code, message: result.message ?? result.capability.note, data: result }
      }
      return { ok: true, data: result }
    } catch (err) {
      return { ok: false, code: 'UPSTREAM_ERROR', message: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('minuteData:getCloudStatus', () => ({ ok: true, data: getMinuteCloudStatus() }))
  ipcMain.handle('minuteData:saveCloudConfig', () => ({ ok: false, code: 'NOT_IMPLEMENTED', message: '云端分钟数据服务尚未启用' }))
}
