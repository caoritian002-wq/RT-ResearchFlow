import { ipcMain } from 'electron'
import { setPremarketNetworkEnabled } from '../database/settingsRepository'
import {
  captureCurrentPremarketWindow,
  getPremarketCaptureScheduleStatus,
  reconfigurePremarketCaptures,
} from '../services/schedulerService'
import type {
  PremarketCaptureCurrentResult,
  PremarketCaptureStatusView,
} from '../services/premarketCaptureCoordinator'
import {
  readCurrentPremarketScenario,
  readPremarketScenarioRevision,
} from '../services/premarketRehearsalService'
import { getDb } from '../database/db'
import { explainCurrentPremarketScenario } from '../services/premarketAIExplanationService'
import {
  readPremarketPreparation,
  refreshPremarketPreparation,
} from '../services/premarketPreparationService'
import { runScan } from '../services/scanEngine'
import { refreshPremarketAuctionHistory } from '../services/premarketScenarioBackfillService'
import { recoverPremarketExternalSnapshot } from '../services/premarketExternalRecoveryService'
import { retryPremarketScenario } from '../services/premarketScenarioRetryService'
import { refreshStockAnnouncements } from '../services/stockFundamentalService'

export interface PremarketCaptureActionResponse extends PremarketCaptureCurrentResult {
  status: PremarketCaptureStatusView
}

export function registerPremarketHandlers(): void {
  ipcMain.handle('premarket:getStatus', () => getPremarketCaptureScheduleStatus())

  ipcMain.handle('premarket:setEnabled', async (_event, enabled: unknown) => {
    setPremarketNetworkEnabled(enabled)
    try {
      await reconfigurePremarketCaptures()
    } catch (error) {
      console.warn('[Premarket] reconfigure failed:', error instanceof Error ? error.message : String(error))
    }
    return getPremarketCaptureScheduleStatus()
  })

  ipcMain.handle('premarket:captureCurrent', async (): Promise<PremarketCaptureActionResponse> => {
    const result = await captureCurrentPremarketWindow()
    return {
      ...result,
      status: getPremarketCaptureScheduleStatus(),
    }
  })

  ipcMain.handle('premarket:getScenario', () => readCurrentPremarketScenario(getDb()))
  ipcMain.handle('premarket:getScenarioRevision', (_event, data: { versionId?: string }) => (
    readPremarketScenarioRevision(getDb(), String(data?.versionId ?? ''))
  ))
  ipcMain.handle('premarket:retryScenario', (event) => retryPremarketScenario(getDb(), {
    refreshExternal: (tradeDate) => recoverPremarketExternalSnapshot(getDb(), tradeDate),
    refreshAuction: (tradeDate) => refreshPremarketAuctionHistory(getDb(), tradeDate),
    scanBriefings: () => runScan('MANUAL'),
    refreshAnnouncement: (stockCode) => refreshStockAnnouncements(getDb(), stockCode),
    onProgress: (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('premarket:retryProgress', progress)
    },
  }))
  ipcMain.handle('premarket:explainScenario', (_event, data: { versionId?: string } | undefined) => (
    explainCurrentPremarketScenario(getDb(), { versionId: String(data?.versionId ?? '') || undefined })
  ))
  ipcMain.handle('premarket:getPreparation', () => readPremarketPreparation(getDb()))
  ipcMain.handle('premarket:refreshPreparation', () => refreshPremarketPreparation(getDb(), {
    scanBriefings: () => runScan('MANUAL'),
  }))
}
