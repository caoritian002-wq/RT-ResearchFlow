/**
 * FR-164: 长线趋势 Watchlist IPC 处理器
 *
 * 注册7个 IPC：
 * - trend:getWatchList      查询 Watchlist 全部股票
 * - trend:addStocks         批量添加股票到 Watchlist
 * - trend:removeStock       移除单只股票
 * - trend:updateGroupTag    更新分组标签
 * - trend:getScores         获取当前评分快照（实时缓存 + DB 最近存档）
 * - trend:getAlerts         获取近 N 天预警记录
 * - trend:syncNow           触发全市场日线数据同步（防重入）
 */

import { ipcMain, BrowserWindow } from 'electron'
import { getDb } from '../database/db'
import {
  batchAddTrendWatchStocks,
  removeTrendWatchStock,
  getAllTrendWatchStocks,
  updateTrendWatchGroupTag,
  updateTrendWatchNotes,
} from '../database/trendWatchlistRepository'
import {
  getTrendScoreSnapshot,
  getTrendAlerts,
  computeTrendScoresOnDemand,
} from '../services/trendWatchlistService'
import {
  backfillTrendStockData,
  isTrendBackfillRunning,
  isTrendSyncRunning,
  syncTrendDailyData,
} from '../services/trendSyncService'
import { getTrendWorkbench } from '../services/trendWorkbenchService'
import { getDataSourceConfig } from '../database/dataSourceRepository'
import { decryptApiKey } from '../utils/apiKeyEncryption'
import { getLastNTradingDays } from '../database/tradeCalRepository'
import { searchStockBasicByKeyword } from '../database/stockBasicCacheRepository'

export function registerTrendHandlers(): void {
  // 启动时清理 trend_watchlist 中的脏 tsCode（含非 ASCII 字符如 U+2019 右单引号）
  try {
    const db = getDb()
    db.prepare(`DELETE FROM trend_watchlist WHERE ts_code != CAST(CAST(ts_code AS BLOB) AS TEXT) OR length(ts_code) != length(trim(ts_code))`).run()
    // 直接按正常格式校验：合法 tsCode 形如 600176.SH，只含 0-9 A-Z a-z 和 .
    db.prepare(`DELETE FROM trend_watchlist WHERE ts_code GLOB '*[^0-9A-Za-z.]*'`).run()
  } catch (_e) {
    // 清理失败不中断启动
  }

  // ──────────────────────────────────────────────────────────────────────
  // trend:getWatchList — 查询所有趋势池股票
  // ──────────────────────────────────────────────────────────────────────
  ipcMain.handle('trend:getWatchList', () => {
    try {
      return { ok: true, data: getAllTrendWatchStocks(getDb()) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: 'DB_ERROR', message: msg }
    }
  })

  // ──────────────────────────────────────────────────────────────────────
  // trend:addStocks — 批量添加股票
  // ──────────────────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────────────────
  // trend:searchStocks — 按关键词搜索股票（中文名称 / 代码模糊匹配）
  // ──────────────────────────────────────────────────────────────────────
  ipcMain.handle('trend:searchStocks', (_event, keyword: string) => {
    try {
      if (!keyword || keyword.trim().length === 0) return { ok: true, data: [] }
      const results = searchStockBasicByKeyword(getDb(), keyword.trim())
      return { ok: true, data: results }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: 'DB_ERROR', message: msg }
    }
  })

  ipcMain.handle(
    'trend:addStocks',
    (
      _event,
      stocks: Array<{
        tsCode: string
        stockName: string
        groupTag?: string
        category?: string
        subCategory?: string
      }>
    ) => {
      try {
        if (!Array.isArray(stocks) || stocks.length === 0) {
          return { ok: false, error: 'INVALID_PARAM', message: 'stocks must be non-empty array' }
        }
        // 清洗 tsCode：只保留 0-9 A-Z a-z 和 .，防止脏字符写入
        const rows = stocks.map((s) => ({
          tsCode: s.tsCode.trim().replace(/[^0-9A-Za-z.]/g, ''),
          stockName: s.stockName.trim(),
          groupTag: s.groupTag ?? '',
          category: s.category ?? '',
          subCategory: s.subCategory ?? '',
          notes: '',
        })).filter((s) => s.tsCode.length > 0)
        batchAddTrendWatchStocks(getDb(), rows)
        return { ok: true, count: rows.length }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: 'DB_ERROR', message: msg }
      }
    }
  )

  // ──────────────────────────────────────────────────────────────────────
  // trend:removeStock — 移除股票（若指定 subCategory 则只删该赛道条目）
  // ──────────────────────────────────────────────────────────────────────
  ipcMain.handle(
    'trend:removeStock',
    (_event, { tsCode, subCategory }: { tsCode: string; subCategory?: string }) => {
      try {
        if (!tsCode) return { ok: false, error: 'INVALID_PARAM', message: 'tsCode required' }
        removeTrendWatchStock(getDb(), tsCode, subCategory)
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: 'DB_ERROR', message: msg }
      }
    }
  )

  // ──────────────────────────────────────────────────────────────────────
  // trend:updateNotes — 更新指定 (tsCode, subCategory) 条目的备注
  // ──────────────────────────────────────────────────────────────────────
  ipcMain.handle(
    'trend:updateNotes',
    (_event, { tsCode, subCategory, notes }: { tsCode: string; subCategory: string; notes: string }) => {
      try {
        if (!tsCode || subCategory === undefined) {
          return { ok: false, error: 'INVALID_PARAM', message: 'tsCode and subCategory required' }
        }
        updateTrendWatchNotes(getDb(), tsCode, subCategory, notes ?? '')
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: 'DB_ERROR', message: msg }
      }
    }
  )

  // ──────────────────────────────────────────────────────────────────────
  // trend:updateGroupTag — 更新分组标签
  // ──────────────────────────────────────────────────────────────────────
  ipcMain.handle('trend:updateGroupTag', (_event, { tsCode, groupTag }: { tsCode: string; groupTag: string }) => {
    try {
      if (!tsCode) return { ok: false, error: 'INVALID_PARAM', message: 'tsCode required' }
      const changed = updateTrendWatchGroupTag(getDb(), tsCode, groupTag ?? '')
      if (changed === 0) return { ok: false, error: 'NOT_FOUND', message: `${tsCode} not in watchlist` }
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: 'DB_ERROR', message: msg }
    }
  })

  // ──────────────────────────────────────────────────────────────────────
  // trend:getScores — 获取评分快照
  // ──────────────────────────────────────────────────────────────────────
  ipcMain.handle('trend:getScores', () => {
    try {
      const db = getDb()
      // 非交易时段首次查询时，对尚无任何缓存的股票按需同步计算一次历史评分
      computeTrendScoresOnDemand(db)
      const snapshot = getTrendScoreSnapshot(db)
      return { ok: true, data: snapshot }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: 'DB_ERROR', message: msg }
    }
  })

  ipcMain.handle('trend:getWorkbench', () => {
    try {
      const db = getDb()
      computeTrendScoresOnDemand(db)
      return { ok: true, data: getTrendWorkbench(db) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: 'DB_ERROR', message: msg }
    }
  })

  // ──────────────────────────────────────────────────────────────────────
  // trend:getAlerts — 获取近 30 天预警记录
  // ──────────────────────────────────────────────────────────────────────
  ipcMain.handle('trend:getAlerts', (_event, { days = 30 }: { days?: number } = {}) => {
    try {
      const alerts = getTrendAlerts(getDb(), days)
      return { ok: true, data: alerts }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: 'DB_ERROR', message: msg }
    }
  })

  // ──────────────────────────────────────────────────────────────────────
  // trend:syncNow — 触发全市场日线同步（fire-and-forget）
  // ──────────────────────────────────────────────────────────────────────
  ipcMain.handle('trend:syncNow', async (_event, { days = 60 }: { days?: number } = {}) => {
    if (isTrendSyncRunning()) {
      return { ok: false, error: 'ALREADY_RUNNING', message: 'Trend sync is already running' }
    }

    const cfg = getDataSourceConfig(getDb())
    if (!cfg.tushareEnabled || !cfg.tushareTokenEncrypted) {
      return { ok: false, error: 'TUSHARE_DISABLED', message: 'Tushare not configured' }
    }

    const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
    const todayYmd =
      `${bjNow.getUTCFullYear()}` +
      `${String(bjNow.getUTCMonth() + 1).padStart(2, '0')}` +
      `${String(bjNow.getUTCDate()).padStart(2, '0')}`

    const tradeDates = getLastNTradingDays(getDb(), days, todayYmd)
    if (tradeDates.length === 0) {
      return { ok: false, error: 'NO_TRADE_DATES', message: 'No trading dates in calendar' }
    }

    const token = decryptApiKey(cfg.tushareTokenEncrypted)
    if (!token) {
      return { ok: false, error: 'TUSHARE_DISABLED', message: 'Tushare token decryption failed' }
    }
    const win = BrowserWindow.getAllWindows()[0] ?? undefined

    // fire-and-forget，由 trend:syncProgress / trend:syncDone 推送进度
    void syncTrendDailyData(getDb(), token, days, win)

    return { ok: true, message: 'Sync started' }
  })

  ipcMain.handle('trend:backfillStocks', async (_event, payload: { tsCodes?: string[] } = {}) => {
    const tsCodes = Array.isArray(payload.tsCodes) ? payload.tsCodes : []
    if (tsCodes.length === 0 || tsCodes.length > 200) {
      return { ok: false, error: 'INVALID_PARAM', message: '请选择1至200只股票' }
    }
    if (tsCodes.some((value) => !/^\d{6}(?:\.(?:SH|SZ|BJ))?$/i.test(String(value).trim()))) {
      return { ok: false, error: 'INVALID_PARAM', message: '股票代码格式无效' }
    }
    if (isTrendBackfillRunning()) {
      return { ok: false, error: 'ALREADY_RUNNING', message: '观察池数据补齐正在进行中' }
    }
    const db = getDb()
    const cfg = getDataSourceConfig(db)
    const token = cfg.tushareEnabled && cfg.tushareTokenEncrypted
      ? decryptApiKey(cfg.tushareTokenEncrypted)
      : null
    if (cfg.tushareEnabled && cfg.tushareTokenEncrypted && !token) {
      return { ok: false, error: 'TUSHARE_DISABLED', message: 'Tushare凭据无法解密，请重新配置' }
    }
    try {
      const win = BrowserWindow.getAllWindows()[0] ?? undefined
      const data = await backfillTrendStockData(db, token, tsCodes, win)
      computeTrendScoresOnDemand(db)
      if (win && !win.isDestroyed()) win.webContents.send('trend:scoresUpdated')
      return { ok: true, data }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        error: message === 'TREND_BACKFILL_RUNNING' ? 'ALREADY_RUNNING' : 'UPSTREAM_ERROR',
        message,
      }
    }
  })
}
