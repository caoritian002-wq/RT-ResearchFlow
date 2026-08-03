/**
 * 交易日历服务（trade_cal）
 *
 * 解决问题：调休补班日（如周六上班、周一休市）无法被 weekday 判断识别。
 *
 * 策略：
 *  - 内存缓存今日是否交易日（布尔值），每日 04:00 由调度器重置
 *  - refreshTradingCalendar() 调 Tushare trade_cal 拉取，启动时和每日 04:00 后各调一次
 *  - isTodayTradingDay() 同步返回缓存值；未拉取过则 fallback 到 weekday 判断（保守策略）
 */

import { fetchTradeCal } from './tushareService'

/** 内存缓存：今日（北京时间 YYYYMMDD）是否交易日 */
let _isTodayOpen: boolean | null = null
/** 已缓存的日期（YYYYMMDD），用于跨日失效 */
let _cachedForDate: string | null = null
/** 防止并发重复拉取 */
let _inflight: Promise<void> | null = null

/** 返回北京时间当日 YYYYMMDD */
function getBjTodayYmd(): string {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}

/**
 * 判断今天是否是交易日。
 *
 * - 已拉取缓存且日期匹配：直接返回缓存值
 * - 尚未拉取或跨日失效：fallback 到 weekday 判断（周一~周五返回 true）
 *   这是保守策略，避免阻塞调用，等下次 refreshTradingCalendar 完成后缓存会被更新
 */
export function isTodayTradingDay(): boolean {
  const today = getBjTodayYmd()
  if (_cachedForDate === today && _isTodayOpen !== null) {
    return _isTodayOpen
  }
  // fallback：weekday 判断（不能处理调休，但至少不会把普通工作日误判为休市）
  const dow = new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCDay()
  return dow !== 0 && dow !== 6
}

/**
 * 异步刷新今日交易日状态（调 Tushare trade_cal）。
 * 同一天重复调用幂等（有缓存直接返回）；并发调用合并为同一 Promise。
 */
export async function refreshTradingCalendar(token: string): Promise<void> {
  const today = getBjTodayYmd()

  // 已有今日缓存，无需重复拉取
  if (_cachedForDate === today && _isTodayOpen !== null) return

  // 并发保护
  if (_inflight) return _inflight

  _inflight = (async () => {
    try {
      const rows = await fetchTradeCal(token, 'SSE', today, today)
      const row = rows.find(r => r.calDate === today)
      if (row !== undefined) {
        _isTodayOpen = row.isOpen === 1
        _cachedForDate = today
        console.log(`[TradingCalendar] ${today} isOpen=${row.isOpen}`)
      } else {
        // 接口返回为空（非工作日 Tushare 可能不返回），视为休市
        _isTodayOpen = false
        _cachedForDate = today
        console.log(`[TradingCalendar] ${today} not found in trade_cal, treated as closed`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[TradingCalendar] fetch failed: ${msg}`)
      // 失败不更新缓存，保留 fallback 的 weekday 判断
    } finally {
      _inflight = null
    }
  })()

  return _inflight
}

/** 每日 04:00 由调度器调用，清空缓存以便次日重新拉取 */
export function clearTradingCalendarCache(): void {
  _isTodayOpen = null
  _cachedForDate = null
  _inflight = null
}
