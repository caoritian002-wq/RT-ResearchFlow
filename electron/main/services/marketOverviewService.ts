/**
 * 大盘热力图数据服务
 *
 * 三个计算模块：
 *  1. computeDistribution() — 从 sharedRtKCache 按 9 档统计涨跌分布
 *  2. appendTimelinePoint(db) — 追加今日涨停/跌停时间序列，同时持久化到 DB
 *  3. computeConceptHeat(db) — 三步聚合热点概念热度，记录每个概念首次出现涨停的时刻
 */

import type Database from 'better-sqlite3'
import { getRtKCache, getRtKCachedAt, getLimitPct } from './sharedRtKCache'
import { isTodayTradingDay } from './tradingCalendarService'
import {
  insertTimelinePoint,
  getTimelineByDate,
} from '../database/marketTimelineRepository'

// ─── 接口定义 ─────────────────────────────────────────────────

export interface DistributionBin {
  label: string
  count: number
  /** true=红系（涨），false=绿系（跌），null=灰（平盘） */
  isPositive: boolean | null
}

export interface MarketTimelinePoint {
  /** 'HH:mm'，北京时间 */
  time: string
  limitUp: number
  limitDown: number
}

export interface ConceptHeat {
  conCode: string
  conName: string
  /** 从 sharedRtKCache 匹配到的有效成员数 */
  memberCount: number
  /** 成员平均涨跌幅（百分比） */
  avgChange: number
  limitUpCount: number
  limitDownCount: number
  /**
   * 该概念首次出现涨停的盘中时刻（HH:mm），用于分时图标签锁定时间轴锚点。
   * 暂无涨停成员时为 undefined（前端默认均匀分布）。
   */
  peakTime?: string
}

export interface MarketOverviewSnapshot {
  distribution: DistributionBin[]
  /** 今日盘中时间序列，最多 390 点 */
  timeline: MarketTimelinePoint[]
  /** 按 limitUpCount*3+avgChange 降序 */
  conceptHeat: ConceptHeat[]
  generatedAt: number
  /** rtKCache 为空时 fallback 历史数据，此字段为 true */
  isHistorical?: boolean
  /** 历史模式下来源交易日，格式 YYYYMMDD */
  tradeDate?: string
}

// ─── 模块级状态 ───────────────────────────────────────────────

/** 今日盘中涨停/跌停时间序列，每 60s 追加一条，04:00 清空 */
let _todayTimeline: MarketTimelinePoint[] = []

/** 标记今日是否已从 DB 恢复过，防止重复加载 */
let _timelineRestoredDate = ''

/** 每个概念首次出现涨停的时刻（HH:mm），04:00 清空 */
const _conceptPeakTime = new Map<string, string>()

/** 最近一次 appendTimelinePoint 时的北京时间 HH:mm（用于概念热度首次涨停时刻标记） */
let _lastTimelineTime = ''

/** 热点概念热度缓存 */
let _conceptHeatCache: ConceptHeat[] | null = null
let _conceptHeatCachedAt = 0
const CONCEPT_HEAT_TTL = 60_000

// ─── 区域1：涨跌分布 ──────────────────────────────────────────

const DISTRIBUTION_BINS: Array<{ label: string; isPositive: boolean | null; test: (c: number) => boolean }> = [
  { label: '≥7%',    isPositive: true,  test: c => c >= 7 },
  { label: '5~7%',   isPositive: true,  test: c => c >= 5 && c < 7 },
  { label: '3~5%',   isPositive: true,  test: c => c >= 3 && c < 5 },
  { label: '0~3%',   isPositive: true,  test: c => c > 0 && c < 3 },
  { label: '=0%',    isPositive: null,  test: c => c === 0 },
  { label: '-3~0%',  isPositive: false, test: c => c > -3 && c < 0 },
  { label: '-5~-3%', isPositive: false, test: c => c >= -5 && c <= -3 },
  { label: '-7~-5%', isPositive: false, test: c => c > -7 && c < -5 },
  { label: '≤-7%',   isPositive: false, test: c => c <= -7 },
]

/** 从 sharedRtKCache 统计 9 档涨跌分布；缓存为空时返回空数组 */
export function computeDistribution(): DistributionBin[] {
  const cache = getRtKCache()
  if (!cache || cache.size === 0) return []

  const counts = new Array<number>(DISTRIBUTION_BINS.length).fill(0)
  for (const entry of cache.values()) {
    const c = entry.change
    for (let i = 0; i < DISTRIBUTION_BINS.length; i++) {
      if (DISTRIBUTION_BINS[i].test(c)) {
        counts[i]++
        break
      }
    }
  }
  return DISTRIBUTION_BINS.map((bin, i) => ({
    label: bin.label,
    count: counts[i],
    isPositive: bin.isPositive,
  }))
}

// ─── 区域2：涨跌停时间序列 ────────────────────────────────────

/** 获取北京时间 HH:mm 字符串 */
function getBjHHMM(): string {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const hh = d.getUTCHours().toString().padStart(2, '0')
  const mm = d.getUTCMinutes().toString().padStart(2, '0')
  return `${hh}:${mm}`
}

/**
 * 追加当前时刻的涨停/跌停数到时间序列，并将数据持久化到 DB。
 * 由 schedulerService.ts 在 60s 回调中调用（仅交易时段）。
 */
export function appendTimelinePoint(db: Database.Database): void {
  const cache = getRtKCache()
  if (!cache || cache.size === 0) return

  let limitUp = 0
  let limitDown = 0
  for (const [tsCode, entry] of cache) {
    const pct = getLimitPct(tsCode, entry.name)
    if (entry.change >= pct - 0.3 && entry.change <= pct + 1.5) limitUp++
    if (entry.change <= -(pct - 0.3) && entry.change >= -(pct + 1.5)) limitDown++
  }

  const time = getBjHHMM()
  const tradeDate = getBjYmd()
  const point: MarketTimelinePoint = { time, limitUp, limitDown }

  _todayTimeline.push(point)
  if (_todayTimeline.length > 390) {
    _todayTimeline = _todayTimeline.slice(-390)
  }

  // 异步写入 DB，失败静默
  try {
    insertTimelinePoint(db, { trade_date: tradeDate, time, limit_up: limitUp, limit_down: limitDown })
  } catch (err) {
    console.warn('[MarketTimeline] insertTimelinePoint failed:', err)
  }

  // 记录本次时间供 getConceptHeat 对新出现的涨停概念打时间戳
  _lastTimelineTime = time
}

/**
 * 清空今日时间序列及相关状态（每日 04:00 日切时调用）。
 */
export function clearTodayTimeline(): void {
  _todayTimeline = []
  _timelineRestoredDate = ''
  _lastTimelineTime = ''
  _conceptPeakTime.clear()
}

/** 清空概念热度缓存（供外部调用，如 rtK 更新后触发重算） */
export function clearConceptHeatCache(): void {
  _conceptHeatCache = null
}

// ─── 区域3：热点概念热度 ──────────────────────────────────────

/**
 * 三步聚合：
 *  1. kpl_concept_daily 近10日 theme 文本 → activeThemeNames
 *  2. kpl_concept_members WHERE con_name IN (...) → 去重 (tsCode, conName) 对
 *  3. 对每个题材，getMembersByConcept → sharedRtKCache 聚合统计
 */
function computeConceptHeat(db: Database.Database): ConceptHeat[] {
  const cache = getRtKCache()
  if (!cache || cache.size === 0) return []

  // 步骤 1：收集近10日活跃题材名（从 kpl_concept_daily.theme 逗号拆分）
  const themeRows = db
    .prepare(`SELECT DISTINCT theme FROM kpl_concept_daily WHERE theme IS NOT NULL ORDER BY trade_date DESC LIMIT 5000`)
    .all() as { theme: string }[]

  const activeThemeNames = new Set<string>()
  for (const row of themeRows) {
    if (!row.theme) continue
    // kpl_list.theme 字段以「、」（U+3001）或英文逗号分隔多个题材，两者都要处理
    for (const t of row.theme.split(/[,、，]/)) {
      const name = t.trim()
      if (name) activeThemeNames.add(name)
    }
  }
  if (activeThemeNames.size === 0) return []

  // 步骤 2：按题材名（name 列）匹配 activeThemeNames，获取题材代码（ts_code 列）
  // 列语义：ts_code=题材代码 / con_code=股票代码 / name=题材名 / con_name=股票名
  const placeholders = [...activeThemeNames].map(() => '?').join(',')
  const conceptRows = db
    .prepare(
      `SELECT DISTINCT ts_code AS conceptCode, name AS conceptName FROM kpl_concept_members WHERE name IN (${placeholders})`
    )
    .all([...activeThemeNames]) as { conceptCode: string; conceptName: string }[]

  if (conceptRows.length === 0) return []

  // 步骤 3：对每个题材聚合成员行情
  const results: ConceptHeat[] = []
  for (const { conceptCode, conceptName: conName } of conceptRows) {
    // 按题材代码（ts_code）取所有成员股（con_code = 股票 ts_code，con_name = 股票名）
    const members = db
      .prepare(`SELECT con_code, con_name FROM kpl_concept_members WHERE ts_code = ?`)
      .all(conceptCode) as { con_code: string; con_name: string }[]

    let totalChange = 0
    let validCount = 0
    let limitUpCount = 0
    let limitDownCount = 0

    for (const { con_code: memberTsCode, con_name: stockName } of members) {
      const entry = cache.get(memberTsCode)
      if (!entry) continue
      validCount++
      totalChange += entry.change
      const pct = getLimitPct(memberTsCode, stockName || entry.name)
      if (entry.change >= pct - 0.3 && entry.change <= pct + 1.5) limitUpCount++
      if (entry.change <= -(pct - 0.3) && entry.change >= -(pct + 1.5)) limitDownCount++
    }

    // 成员数 < 3 的题材意义不大，过滤掉
    if (validCount < 3) continue

    // 若该概念本次有涨停且之前未登记首次涨停时刻，记录当前时间
    if (limitUpCount > 0 && _lastTimelineTime && !_conceptPeakTime.has(conceptCode)) {
      _conceptPeakTime.set(conceptCode, _lastTimelineTime)
    }

    results.push({
      conCode: conceptCode,
      conName,
      memberCount: validCount,
      avgChange: parseFloat((totalChange / validCount).toFixed(2)),
      limitUpCount,
      limitDownCount,
    })
  }

  // 按热度降序（涨停数权重 3 倍 + 平均涨幅）
  results.sort((a, b) => (b.limitUpCount * 3 + b.avgChange) - (a.limitUpCount * 3 + a.avgChange))
  return results
}

/** 60s TTL 缓存封装，返回时为每条结果补充 peakTime */
export function getConceptHeat(db: Database.Database): ConceptHeat[] {
  if (_conceptHeatCache !== null && Date.now() - _conceptHeatCachedAt < CONCEPT_HEAT_TTL) {
    // 缓存命中：_conceptPeakTime 可能在此间隔内更新，动态附加
    return _conceptHeatCache.map(item => ({
      ...item,
      peakTime: _conceptPeakTime.get(item.conCode),
    }))
  }
  const heat = computeConceptHeat(db)
  _conceptHeatCache = heat
  _conceptHeatCachedAt = Date.now()
  // 附加峰值时刻后返回
  return heat.map(item => ({
    ...item,
    peakTime: _conceptPeakTime.get(item.conCode),
  }))
}

/** 获取北京时间 YYYYMMDD 字符串（当日） */
function getBjYmd(): string {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return (
    `${d.getUTCFullYear()}` +
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(d.getUTCDate()).padStart(2, '0')}`
  )
}

// ─── 快照入口 ─────────────────────────────────────────────────

// ─── 历史 Fallback（rtKCache 为空时读 daily_close_cache） ─────

/** 从 daily_close_cache 最新 trade_date 构建涨跌分布（9 档，同 computeDistribution 逻辑） */
function buildHistoricalDistribution(db: Database.Database): { bins: DistributionBin[]; tradeDate: string } {
  const dateRow = db
    .prepare(`SELECT MAX(trade_date) AS td FROM daily_close_cache`)
    .get() as { td: string | null }
  const tradeDate = dateRow?.td ?? ''
  if (!tradeDate) return { bins: [], tradeDate: '' }

  const rows = db
    .prepare(`SELECT pct_chg FROM daily_close_cache WHERE trade_date = ? AND pct_chg IS NOT NULL`)
    .all(tradeDate) as { pct_chg: number }[]

  const counts = new Array<number>(DISTRIBUTION_BINS.length).fill(0)
  for (const { pct_chg } of rows) {
    for (let i = 0; i < DISTRIBUTION_BINS.length; i++) {
      if (DISTRIBUTION_BINS[i].test(pct_chg)) {
        counts[i]++
        break
      }
    }
  }
  return {
    tradeDate,
    bins: DISTRIBUTION_BINS.map((bin, i) => ({
      label: bin.label,
      count: counts[i],
      isPositive: bin.isPositive,
    })),
  }
}

/** 从 daily_close_cache 构建概念热度（替代 rtKCache） */
function buildHistoricalConceptHeat(db: Database.Database, tradeDate: string): ConceptHeat[] {
  // 用 daily_close_cache 构建 tsCode→pctChg Map
  const rows = db
    .prepare(`SELECT ts_code, pct_chg FROM daily_close_cache WHERE trade_date = ? AND pct_chg IS NOT NULL`)
    .all(tradeDate) as { ts_code: string; pct_chg: number }[]
  if (rows.length === 0) return []

  const pctMap = new Map<string, number>()
  for (const r of rows) pctMap.set(r.ts_code, r.pct_chg)
  // 同 computeConceptHeat 的步骤1+2
  const themeRows = db
    .prepare(`SELECT DISTINCT theme FROM kpl_concept_daily WHERE theme IS NOT NULL ORDER BY trade_date DESC LIMIT 5000`)
    .all() as { theme: string }[]
  const activeThemeNames = new Set<string>()
  for (const row of themeRows) {
    if (!row.theme) continue
    for (const t of row.theme.split(/[,、，]/)) {
      const name = t.trim()
      if (name) activeThemeNames.add(name)
    }
  }
  if (activeThemeNames.size === 0) return []

  // 按题材名（name 列）匹配 activeThemeNames，获取题材代码（ts_code 列）
  // 列语义回顾：ts_code=题材代码 / con_code=股票代码 / name=题材名 / con_name=股票名
  const placeholders = [...activeThemeNames].map(() => '?').join(',')
  const conceptRows = db
    .prepare(`SELECT DISTINCT ts_code AS conceptCode, name AS conceptName FROM kpl_concept_members WHERE name IN (${placeholders})`)
    .all([...activeThemeNames]) as { conceptCode: string; conceptName: string }[]
  const results: ConceptHeat[] = []
  for (const { conceptCode, conceptName: conName } of conceptRows) {
    // 取该题材的所有成员股（con_code = 股票 ts_code，格式如 000001.SZ）
    const members = db
      .prepare(`SELECT con_code FROM kpl_concept_members WHERE ts_code = ?`)
      .all(conceptCode) as { con_code: string }[]

    let totalChange = 0
    let validCount = 0
    let limitUpCount = 0

    for (const { con_code: memberTsCode } of members) {
      const pct = pctMap.get(memberTsCode)
      if (pct === undefined) continue
      validCount++
      totalChange += pct
      // 历史模式：涨停判定用固定 9.8% 阈值（无 name 信息区分 ST/科创）
      if (pct >= 9.8) limitUpCount++
    }
    if (validCount < 3) continue

    results.push({
      conCode: conceptCode,
      conName,
      memberCount: validCount,
      avgChange: parseFloat((totalChange / validCount).toFixed(2)),
      limitUpCount,
      limitDownCount: 0,
    })
  }
  results.sort((a, b) => (b.limitUpCount * 3 + b.avgChange) - (a.limitUpCount * 3 + a.avgChange))
  return results
}

/** A股交易时段标准时间桶（含集合竞价 09:25） */
const TIMELINE_BUCKETS = [
  '09:25', '09:30', '10:00', '10:30', '11:00', '11:30',
  '13:00', '13:30', '14:00', '14:30', '15:00',
]

/**
 * 判断 rtKCache 是否属于今日数据：
 * 缓存存在 + 非空 + 缓存刷新时间是今天（北京时间 YYYYMMDD）。
 * 盘后数据仍是当日缓存，此判断应返回 true。
 */
function isRtKFromToday(): boolean {
  const cache = getRtKCache()
  if (!cache || cache.size === 0) return false
  const cachedAt = getRtKCachedAt()
  if (cachedAt === 0) return false
  const cacheDate = new Date(cachedAt + 8 * 60 * 60 * 1000)
  const cacheDateYmd = `${cacheDate.getUTCFullYear()}${String(cacheDate.getUTCMonth() + 1).padStart(2, '0')}${String(cacheDate.getUTCDate()).padStart(2, '0')}`
  return cacheDateYmd === getBjYmd()
}

/**
 * 从 limit_list_daily.first_time 按时间桶累计涨停数（真实曲线）。
 * 跌停无分时数据，仅在 15:00 放收盘总量，其余桶为 0。
 */
function buildHistoricalTimeline(db: Database.Database, tradeDate: string): MarketTimelinePoint[] {
  // 涨停：取每只股票的首次涨停时间
  const upRows = db
    .prepare(`SELECT first_time FROM limit_list_daily WHERE trade_date = ? AND "limit" = 'U' AND first_time IS NOT NULL`)
    .all(tradeDate) as { first_time: string }[]

  // 跌停：仅总数，放 15:00
  const downRow = db
    .prepare(`SELECT SUM(CASE WHEN "limit" = 'D' THEN 1 ELSE 0 END) AS limitDown FROM limit_list_daily WHERE trade_date = ?`)
    .get(tradeDate) as { limitDown: number | null } | undefined
  const totalDown = downRow?.limitDown ?? 0

  if (upRows.length === 0 && totalDown === 0) return []

  // Tushare first_time 为 HHMMSS 纯数字（无冒号），09:xx 时为5位（如'92500'），10:xx 起为6位（如'100015'）
  // 必须用数值分钟数比较，字符串比较会导致 '92500' > '15:00' 的错误结果
  const ftToMinutes = (ft: string): number => {
    if (!ft || ft.length < 4) return 9999
    const mStr = ft.substring(ft.length - 4, ft.length - 2)
    const hStr = ft.substring(0, ft.length - 4)
    const h = parseInt(hStr, 10)
    const m = parseInt(mStr, 10)
    return isNaN(h) || isNaN(m) ? 9999 : h * 60 + m
  }

  const firstMinutes = upRows.map(r => ftToMinutes(r.first_time ?? ''))

  return TIMELINE_BUCKETS.map(bucket => {
    const [bh, bm] = bucket.split(':').map(Number)
    const bucketMinutes = bh * 60 + bm
    return {
      time: bucket,
      // 累计到该时间桶为止已涨停的股票数
      limitUp: firstMinutes.filter(m => m <= bucketMinutes).length,
      limitDown: bucket === '15:00' ? totalDown : 0,
    }
  })
}

/**
 * 从 DB 恢复今日时间序列到内存（惰性，每日只恢复一次）。
 * 在 getMarketOverviewSnapshot 实时路径进入时调用，保证重启后断点续传。
 */
function restoreTodayTimelineFromDb(db: Database.Database): void {
  const today = getBjYmd()
  if (_timelineRestoredDate === today) return // 已恢复过
  _timelineRestoredDate = today

  try {
    const rows = getTimelineByDate(db, today)
    if (rows.length > 0) {
      _todayTimeline = rows.map(r => ({ time: r.time, limitUp: r.limit_up, limitDown: r.limit_down }))
    }
  } catch (err) {
    console.warn('[MarketTimeline] restoreTodayTimelineFromDb failed:', err)
  }
}

export function getMarketOverviewSnapshot(db: Database.Database): MarketOverviewSnapshot {
  const cache = getRtKCache()
  // 双重条件：① trade_cal 确认今天是交易日（含调休补班日，排除假期/周末）
  //            ② rtKCache 有今日实时数据
  // trade_cal 未拉到时 fallback weekday 判断（周六/周日=false，仍然正确走历史路径）
  if (isTodayTradingDay() && isRtKFromToday() && cache && cache.size > 0) {
    // 从 DB 恢复今日已记录的时间序列（重启后断点续传）
    restoreTodayTimelineFromDb(db)
    // 应用刚启动时 timeline 可能仍为空（60s cron 尚未触发），立即播种一个当前时刻的点
    if (_todayTimeline.length === 0) {
      appendTimelinePoint(db)
    }
    return {
      distribution: computeDistribution(),
      timeline: [..._todayTimeline],
      conceptHeat: getConceptHeat(db),
      generatedAt: Date.now(),
    }
  }
  // rtKCache 无今日数据 → 读 daily_close_cache 历史数据
  const { bins, tradeDate } = buildHistoricalDistribution(db)
  const conceptHeat = tradeDate ? buildHistoricalConceptHeat(db, tradeDate) : []
  const timeline = tradeDate ? buildHistoricalTimeline(db, tradeDate) : []
  return {
    distribution: bins,
    timeline,
    conceptHeat,
    generatedAt: Date.now(),
    isHistorical: true,
    tradeDate,
  }
}
