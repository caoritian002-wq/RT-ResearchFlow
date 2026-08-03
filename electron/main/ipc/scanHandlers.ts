import { ipcMain, BrowserWindow } from 'electron'
import { runScan, isScanning, stopScan } from '../services/scanEngine'
import { getLatestScanRun } from '../database/scanRunRepository'
import { getSettings } from '../database/settingsRepository'
import { getNextScanAt } from '../services/schedulerService'

export function registerScanHandlers(): void {
  ipcMain.handle('scan:getStatus', () => {
    const settings = getSettings()
    return {
      isScanning: isScanning(),
      lastScanAt: settings.lastSuccessfulScanAt,
      nextScanAt: getNextScanAt(),
      currentRun: getLatestScanRun()
    }
  })

  ipcMain.handle('scan:triggerManual', async () => {
    if (isScanning()) {
      throw new Error('扫描已在进行中')
    }
    return await runScan('MANUAL')
  })

  ipcMain.handle('scan:stop', () => {
    stopScan()
  })
}

export function sendScanEvent(
  win: BrowserWindow,
  event: string,
  data: unknown
): void {
  if (!win.isDestroyed()) {
    win.webContents.send(event, data)
  }
}
