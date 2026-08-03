/**
 * 共享 rt_k 实时行情缓存
 *
 * 设计目标：所有短线策略服务（打板助手、尾盘半小时、连板龙头、首阴回踩、低吸雷达）
 * 及行业云图均读取同一份 rt_k 缓存，避免重复拉取浪费积分。
 *
 * 刷新策略：
 *  - 调度器盘中每 60s 自动调用 refreshRtKCache()
 *  - 前端点击短线策略 Tab 时触发 shortTerm:refreshRtKNow IPC（30s 防抖）
 *  - 行业云图主拉时顺带触发（60s TTL 复用）
 */

import { fetchRtK } from './tushareService'

export interface SharedRtKEntry {
  /** 股票名称 */
  name: string | null
  /** 当日涨跌幅（%），正=涨，负=跌 */
  change: number
  /** 最新价 */
  price: number
  /**
   * 成交额（元，int，来自 rt_k 接口原始值）
   * 注：daily 接口的 amount 单位为「千元」（float），两者不同，使用时注意区分
   */
  amount: number
  /** 昨收价（用于各服务自行计算涨跌幅） */
  preClose: number
  /** 当日开高低；旧缓存或上游缺字段时保持 null。 */
  open: number | null
  high: number | null
  low: number | null
  /** 当日累计成交量（手） */
  vol: number
  /** 买一价（用于计算封单额） */
  bidPrice1: number | null
  /** 买一量（手，用于计算封单额） */
  bidVolume1: number | null
}

/** 带 tsCode 的完整行 */
export type SharedRtKRow = { tsCode: string } & SharedRtKEntry

let _cache: Map<string, SharedRtKEntry> | null = null
let _cachedAt = 0

// ---------- 基础读取 ----------

/** 获取原始缓存 Map（可能为 null，表示尚未拉取或已清空） */
export function getRtKCache(): Map<string, SharedRtKEntry> | null {
  return _cache
}

/** 缓存最后更新时间戳（毫秒） */
export function getRtKCachedAt(): number {
  return _cachedAt
}

/** 判断缓存是否超过指定 TTL（默认 60s） */
export function isRtKStale(ttlMs = 60_000): boolean {
  return Date.now() - _cachedAt > ttlMs
}

// ---------- 刷新 ----------

/**
 * 拉取全市场 rt_k（4 批并发），成功后更新缓存。
 * 失败时保留旧缓存不清空，调用方可通过 getRtKCachedAt() 判断数据新鲜度。
 */
export async function refreshRtKCache(token: string): Promise<void> {
  const rows = await fetchRtK(token)
  const m = new Map<string, SharedRtKEntry>()
  for (const r of rows) {
    if (!r.preClose || !r.close || r.preClose <= 0) continue
    const change = (r.close - r.preClose) / r.preClose * 100
    m.set(r.tsCode, {
      name: r.name,
      change: parseFloat(change.toFixed(2)),
      price: r.close,
      amount: r.amount ?? 0,
      preClose: r.preClose,
      open: r.open,
      high: r.high,
      low: r.low,
      vol: r.vol ?? 0,
      bidPrice1: r.bidPrice1 ?? null,
      bidVolume1: r.bidVolume1 ?? null
    })
  }
  _cache = m
  _cachedAt = Date.now()
  console.log(`[SharedRtKCache] refreshed: ${m.size} stocks, cachedAt=${new Date(_cachedAt).toISOString()}`)
}

// ---------- 语义查询 ----------

/**
 * 按上市板块动态计算涨跌停阈值（与 limitBoardMonitorService 保持一致）
 * ST：5%  北交所：30%  科创/创业：20%  主板：10%
 */
export function getLimitPct(tsCode: string, name: string | null): number {
  if (name && /\bST\b/i.test(name)) return 5
  if (tsCode.endsWith('.BJ')) return 30
  const code = tsCode.split('.')[0]
  if (code.startsWith('688') || code.startsWith('689')) return 20
  if (code.startsWith('300') || code.startsWith('301')) return 20
  return 10
}

/** 今日涨停股（按动态阈值，容差 0.3%，上界 +1.5% 过滤新股/复牌异常大涨）列表 */
export function getLimitUpToday(): SharedRtKRow[] {
  if (!_cache) return []
  const result: SharedRtKRow[] = []
  for (const [tsCode, entry] of _cache) {
    const limitPct = getLimitPct(tsCode, entry.name)
    if (entry.change >= limitPct - 0.3 && entry.change <= limitPct + 1.5) result.push({ tsCode, ...entry })
  }
  return result
}

/** 今日跌停股（按动态阈值，容差 0.3%，上界 +1.5% 过滤新股/复牌异常大跌）列表 */
export function getLimitDownToday(): SharedRtKRow[] {
  if (!_cache) return []
  const result: SharedRtKRow[] = []
  for (const [tsCode, entry] of _cache) {
    const limitPct = getLimitPct(tsCode, entry.name)
    if (entry.change <= -(limitPct - 0.3) && entry.change >= -(limitPct + 1.5)) result.push({ tsCode, ...entry })
  }
  return result
}

/** 清空缓存（每日 04:00 由调度器调用） */
export function clearRtKCache(): void {
  _cache = null
  _cachedAt = 0
}
