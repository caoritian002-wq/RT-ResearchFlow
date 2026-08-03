/**
 * 交易日历 DB 同步服务（FR-162）
 *
 * 将 Tushare trade_cal 数据持久化到 trade_cal 表，
 * 为调度器和各策略服务提供精确的交易日判断和区间计算。
 *
 * 与 tradingCalendarService.ts 的区别：
 *   - tradingCalendarService：仅缓存今日是否开市（内存布尔值）
 *   - tradeCalSyncService：全量存储 trade_cal 到 SQLite，支持任意日期查询
 */

import Database from 'better-sqlite3'
import { upsertTradeCal, getLatestCalDate } from '../database/tradeCalRepository'
import { fetchTradeCal } from './tushareService'

/** 防止并发同步 */
let _syncRunning = false
let _syncPromise: Promise<TradeCalSyncResult> | null = null

export interface TradeCalSyncResult {
  status: 'completed' | 'empty' | 'failed'
  rowCount: number
}

/** 返回北京时间当日 YYYYMMDD */
function getBjTodayYmd(): string {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return (
    `${d.getUTCFullYear()}` +
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(d.getUTCDate()).padStart(2, '0')}`
  )
}

/** 日期字符串加 N 天（YYYYMMDD → YYYYMMDD） */
function addDaysYmd(ymd: string, days: number): string {
  const y = parseInt(ymd.slice(0, 4), 10)
  const m = parseInt(ymd.slice(4, 6), 10) - 1
  const d = parseInt(ymd.slice(6, 8), 10)
  const dt = new Date(Date.UTC(y, m, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return (
    `${dt.getUTCFullYear()}` +
    `${String(dt.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(dt.getUTCDate()).padStart(2, '0')}`
  )
}

/**
 * 按需同步交易日历：
 *  - 若数据库最新日期 >= 今日 + 60 天，视为充足，跳过
 *  - 否则拉取：从今日往前 1 年到今日往后 12 个月（约 2 年跨度）
 *
 * 启动时和每月 1 日 04:00 由 schedulerService 调用。
 */
export async function syncTradeCalIfNeeded(db: Database.Database, token: string): Promise<void> {
  if (_syncPromise) {
    await _syncPromise
    return
  }
  const today = getBjTodayYmd()
  const threshold = addDaysYmd(today, 60)
  const latest = getLatestCalDate(db)
  if (latest !== null && latest >= threshold) {
    console.log(`[TradeCal] DB 已充足（最新=${latest}），跳过同步`)
    return
  }
  await syncTradeCalFull(db, token)
}

/**
 * 强制全量同步：拉取 3 年历史 + 未来 1 年。
 * 由 IPC handler 的「立即同步」和 syncTradeCalIfNeeded 不足时调用。
 */
export async function syncTradeCalFull(db: Database.Database, token: string): Promise<TradeCalSyncResult> {
  if (_syncPromise) return _syncPromise
  _syncRunning = true
  _syncPromise = (async () => {
    try {
      const today = getBjTodayYmd()
      const startDate = addDaysYmd(today, -3 * 365) // 约 3 年前
      const endDate = addDaysYmd(today, 365)         // 未来约 1 年

      console.log(`[TradeCal] 开始同步 ${startDate} ~ ${endDate}`)
      const rows = await fetchTradeCal(token, 'SSE', startDate, endDate)
      if (rows.length === 0) {
        console.warn('[TradeCal] API 返回 0 行，跳过写库')
        return { status: 'empty', rowCount: 0 }
      }
      upsertTradeCal(db, rows.map((r) => ({
        calDate: r.calDate,
        isOpen: r.isOpen,
        pretradeDate: r.pretradeDate,
      })))
      console.log(`[TradeCal] 同步完成，共 ${rows.length} 条记录`)
      return { status: 'completed', rowCount: rows.length }
    } catch (err) {
      console.warn('[TradeCal] 同步失败:', err instanceof Error ? err.message : String(err))
      return { status: 'failed', rowCount: 0 }
    } finally {
      _syncRunning = false
      _syncPromise = null
    }
  })()
  return _syncPromise
}

/** 供外部检查是否正在同步 */
export function isTradeCalSyncRunning(): boolean {
  return _syncRunning
}
