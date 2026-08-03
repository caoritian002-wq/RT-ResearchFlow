/**
 * tradeCal IPC handler（FR-162）
 *
 * tradeCal:sync                  — 强制全量同步交易日历
 * tradeCal:getLastNTradingDays   — 查询近 N 个交易日（升序日期数组）
 */

import { ipcMain } from 'electron'
import { getDb } from '../database/db'
import { getDataSourceConfig } from '../database/dataSourceRepository'
import { decryptApiKey } from '../utils/apiKeyEncryption'
import { getLastNTradingDays } from '../database/tradeCalRepository'
import { syncTradeCalFull, isTradeCalSyncRunning } from '../services/tradeCalSyncService'

export function registerTradeCalHandlers(): void {
  /**
   * 强制全量同步交易日历
   * 返回 { ok: true } | { ok: false; code: string; message: string }
   */
  ipcMain.handle('tradeCal:sync', async () => {
    const db = getDb()
    const cfg = getDataSourceConfig(db)
    if (!cfg.tushareEnabled || !cfg.tushareTokenEncrypted) {
      return { ok: false, code: 'TUSHARE_DISABLED', message: 'Tushare 未配置或未启用' }
    }
    if (isTradeCalSyncRunning()) {
      return { ok: false, code: 'ALREADY_RUNNING', message: '同步已在进行中，请稍后再试' }
    }
    const token = decryptApiKey(cfg.tushareTokenEncrypted)
    if (!token) {
      return { ok: false, code: 'TUSHARE_DISABLED', message: 'API Key 解密失败' }
    }
    try {
      const result = await syncTradeCalFull(db, token)
      if (result.status !== 'completed') {
        return {
          ok: false,
          code: 'UPSTREAM_ERROR',
          message: result.status === 'empty'
            ? '交易日历接口暂未返回可用数据，本地已有数据保持不变'
            : '交易日历同步失败，本地已有数据保持不变，请稍后重试',
        }
      }
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, code: 'UPSTREAM_ERROR', message: msg }
    }
  })

  /**
   * 查询近 N 个交易日（升序 YYYYMMDD 数组）
   * 入参：{ n: number, beforeDate?: string }
   * 若 trade_cal 表为空（返回空数组），前端应 fallback 到旧逻辑
   */
  ipcMain.handle('tradeCal:getLastNTradingDays', (_event, { n, beforeDate }: { n: number; beforeDate?: string }) => {
    if (!n || n <= 0) return []
    const db = getDb()
    // 默认以今日（北京时间）为上界
    const before = beforeDate ?? (() => {
      const d = new Date(Date.now() + 8 * 60 * 60 * 1000)
      return (
        `${d.getUTCFullYear()}` +
        `${String(d.getUTCMonth() + 1).padStart(2, '0')}` +
        `${String(d.getUTCDate()).padStart(2, '0')}`
      )
    })()
    return getLastNTradingDays(db, n, before)
  })
}
