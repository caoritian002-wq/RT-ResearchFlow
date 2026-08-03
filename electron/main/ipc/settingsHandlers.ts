import { ipcMain } from 'electron'
import {
  getDecisionCenterFilters,
  getMarketHeatmapProvider,
  getSettings,
  getTheme,
  setDecisionCenterFilters,
  setMarketHeatmapProvider,
  setTheme,
  updateSettings,
} from '../database/settingsRepository'
import { reschedule } from '../services/schedulerService'
import type { AppSettingsRow } from '../database/types'

export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:get', () => {
    return getSettings()
  })

  ipcMain.handle('settings:update', (_e, data: Partial<Omit<AppSettingsRow, 'id'>>) => {
    const updated = updateSettings(data)
    // If scan interval changed, reschedule
    if (data.scanIntervalMinutes !== undefined) {
      reschedule()
    }
    return updated
  })

  ipcMain.handle('settings:getDecisionCenterFilters', () => getDecisionCenterFilters())

  ipcMain.handle('settings:setDecisionCenterFilters', (_e, filters: unknown) => (
    setDecisionCenterFilters(filters)
  ))

  ipcMain.handle('settings:getTheme', () => {
    return getTheme()
  })

  ipcMain.handle('settings:setTheme', (_e, theme: 'light' | 'dark') => {
    setTheme(theme)
  })

  ipcMain.handle('settings:getMarketHeatmapProvider', () => {
    return getMarketHeatmapProvider()
  })

  ipcMain.handle('settings:setMarketHeatmapProvider', (_e, provider: 'sina' | 'eastmoney' | 'tushare') => {
    setMarketHeatmapProvider(provider)
    return 'ok'
  })
}
