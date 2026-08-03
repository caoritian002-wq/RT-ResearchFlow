import { ipcMain } from 'electron'
import { getDb } from '../database/db'
import {
  getStockFundamentalSnapshot,
  refreshStockFundamentals,
} from '../services/stockFundamentalService'

export function registerStockFundamentalHandlers(): void {
  ipcMain.handle('stockFundamentals:get', (_event, data: { stockCode?: string }) => {
    try {
      return getStockFundamentalSnapshot(getDb(), String(data?.stockCode ?? ''))
    } catch {
      return { ok: false as const, code: 'INVALID_STOCK_CODE' as const, message: '基本面资料读取失败' }
    }
  })

  ipcMain.handle('stockFundamentals:refresh', async (_event, data: { stockCode?: string }) => {
    try {
      return await refreshStockFundamentals(getDb(), String(data?.stockCode ?? ''))
    } catch {
      return {
        ok: false as const,
        code: 'FUNDAMENTAL_FETCH_FAILED' as const,
        message: '公开基本面资料获取失败，请稍后重试',
        snapshot: null,
      }
    }
  })
}
