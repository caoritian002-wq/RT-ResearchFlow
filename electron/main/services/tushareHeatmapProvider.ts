/**
 * FR-132: 行业云图 Tushare 申万实时行情数据源
 *
 * 数据流:
 *   1. 启动时（或缓存过期时）调 fetchSwClassify(level='L1') 填充 31 个 L1 行业代码缓存
 *   2. fetchTushareSnapshot(): 调 fetchSwRealtime() → 与 L1 缓存取交集过滤 → 构造 MarketSnapshot
 *      同时 fire-and-forget 调 fetchRtK() 填充个股实时行情缓存（60s TTL）
 *   3. fetchTushareIndustryConstituents(): 调 fetchSwMembers() 拿成分股名单，
 *      从 rt_k 行情缓存补充每只股票的实时 change/price
 *
 * 限制:
 *   - rt_sw_k 需「申万实时行情」月度订阅（200元/月）；权限不足抛 TUSHARE_QUOTA_INSUFFICIENT
 *   - rt_k 需「实时行情」权限；未开通时成分股 change/price 回退为 0
 *   - subIndustries 暂不实现，始终为 undefined
 */

import { fetchSwClassify, fetchSwRealtime, fetchSwMembers } from './tushareService'
import { getRtKCache, refreshRtKCache, isRtKStale, clearRtKCache } from './sharedRtKCache'
import { EmptyDataError } from './marketHeatmapService'
import type { HeatmapStock, HeatmapIndustry, MarketSnapshot } from './marketHeatmapService'
import type { SwRealtimeItem } from './tushareService'

interface L1CacheItem {
  indexCode: string    // 申万指数代码，如 801010.SI（与 rt_sw_k ts_code 匹配用）
  industryCode: string // 行业分类代码，如 110000（index_member_all l1_code 参数用）
  name: string         // 行业名称，如 农林牧渔
}

interface L2CacheItem {
  indexCode: string        // L2 申万指数代码，如 801011.SI
  name: string             // L2 行业名称
  parentIndexCode: string  // 父 L1 的 indexCode，如 801010.SI
}

/** 模块级 L1 行业代码缓存；启动时填充，每日 04:00 由调度器调 clearSwL1Cache() 清空触发刷新 */
let _l1Cache: L1CacheItem[] | null = null
/** 模块级 L2 子行业缓存；与 L1 同时填充/清空 */
let _l2Cache: L2CacheItem[] | null = null

const MIN_VALID_L1_INDUSTRIES = 20
const INVALID_PLACEHOLDER_PCT = -99

function hasPositiveQuoteValue(...values: Array<number | null>): boolean {
  return values.some(value => value != null && Number.isFinite(value) && value > 0)
}

function isSwPlaceholderQuote(item: SwRealtimeItem): boolean {
  const pct = item.pctChange
  if (pct == null || !Number.isFinite(pct)) return true
  if (pct <= INVALID_PLACEHOLDER_PCT) return true
  return !hasPositiveQuoteValue(item.close, item.preClose, item.open, item.high, item.low, item.amount)
}

/** FR-132: 清空 L1/L2 及 rt_k 行情缓存（每日 04:00 定时调用；下次 fetchTushareSnapshot 时自动重填） */
export function clearSwL1Cache(): void {
  _l1Cache = null
  _l2Cache = null
  clearRtKCache()
}

/** 内部: 确保 L1/L2 缓存已填充，缓存为 null 时并发拉取两级分类 */
async function ensureL1Cache(token: string): Promise<void> {
  if (_l1Cache !== null) return
  const [l1Items, l2Items] = await Promise.all([
    fetchSwClassify(token, 'L1', 'SW2021'),
    fetchSwClassify(token, 'L2', 'SW2021'),
  ])
  if (l1Items.length === 0) {
    throw new Error('CLASSIFY_NOT_READY')
  }
  _l1Cache = l1Items.map(it => ({ indexCode: it.indexCode, industryCode: it.industryCode, name: it.industryName.trim() }))

  // index_classify 的 parent_code 字段返回 industry_code 格式（如 110000），
  // 而 rt_sw_k 的 ts_code 是 index_code 格式（如 801010.SI）。
  // 需将 parent_code(industry_code) → 父 L1 的 index_code 做转换，才能与 l1IndustryMap key 匹配。
  const industryCodeToIndexCode = new Map<string, string>(
    l1Items.map(it => [it.industryCode, it.indexCode])
  )
  _l2Cache = l2Items
    .filter(it => it.parentCode != null)
    .map(it => {
      // parent_code 可能是 110000（industry_code）或 801010.SI（index_code），都做兼容转换
      const parentIndexCode = industryCodeToIndexCode.get(it.parentCode!) ?? it.parentCode!
      return { indexCode: it.indexCode, name: it.industryName.trim(), parentIndexCode }
    })
}

/**
 * FR-132: 主快照拉取
 * 调 rt_sw_k() 获取全量申万指数实时截面，与 L1 缓存取交集过滤出 31 个 L1 行业
 */
export async function fetchTushareSnapshot(token: string): Promise<MarketSnapshot> {
  await ensureL1Cache(token)

  // L1 Map: indexCode(801010.SI) → { name, industryCode }
  const l1Map = new Map<string, { name: string; industryCode: string }>(
    (_l1Cache!).map(it => [it.indexCode, { name: it.name, industryCode: it.industryCode }])
  )
  // L2 Map: indexCode(801011.SI) → { name, parentIndexCode(801010.SI) }
  const l2Map = new Map<string, { name: string; parentIndexCode: string }>(
    (_l2Cache ?? []).map(it => [it.indexCode, { name: it.name, parentIndexCode: it.parentIndexCode }])
  )

  // rt_sw_k（行业指数）与 rt_k（个股行情）并行拉取，两者耗时相近，不增加实际延迟
  // rt_k 读写共享缓存（sharedRtKCache），60s TTL；失败时保留旧缓存不清空
  const [realtimeData] = await Promise.all([
    fetchSwRealtime(token),
    isRtKStale()
      ? refreshRtKCache(token).catch(() => { /* 权限不足/网络异常，不刷新 cachedAt，下次继续重试 */ })
      : Promise.resolve(),  // TTL 未过期，跳过
  ])

  // 第一遍：收集 L1 行业 + L2 子行业桶
  const l1IndustryMap = new Map<string, HeatmapIndustry>()
  const l2Bucket = new Map<string, HeatmapStock[]>()  // key = parentIndexCode（801010.SI 格式）
  let l1Seen = 0
  let l1Invalid = 0

  for (const item of realtimeData) {
    const l1Info = l1Map.get(item.tsCode)
    if (l1Info) {
      l1Seen++
      if (isSwPlaceholderQuote(item)) {
        l1Invalid++
        continue
      }
      // L1 行业：rt_sw_k name 为 UTF-8 正确值；code 用 indexCode（801010.SI 格式），供 index_member_all l1_code 参数使用
      l1IndustryMap.set(item.tsCode, {
        name: item.name,
        code: item.tsCode,
        totalMarketCap: item.amount ?? 0,
        weightedChange: item.pctChange ?? 0,
        stocks: [],
      })
      continue
    }
    const l2Info = l2Map.get(item.tsCode)
    if (l2Info) {
      if (isSwPlaceholderQuote(item)) continue
      // L2 子行业 → 放入父 L1 的桶（parentIndexCode 已在 ensureL1Cache 中转换为 801010.SI 格式）
      const bucket = l2Bucket.get(l2Info.parentIndexCode) ?? []
      bucket.push({
        code: item.tsCode,
        name: item.name,
        price: 0,
        change: item.pctChange ?? 0,
        marketCap: item.amount ?? 0,
      })
      l2Bucket.set(l2Info.parentIndexCode, bucket)
    }
  }

  if (l1IndustryMap.size < MIN_VALID_L1_INDUSTRIES) {
    throw new EmptyDataError(
      l1Seen > 0 && l1Invalid / l1Seen >= 0.8
        ? 'Tushare 申万实时行情返回异常占位数据，请稍后重试'
        : 'Tushare 申万实时行情有效行业数量不足，请稍后重试'
    )
  }

  // 第二遍：为每个 L1 分配 subIndustries
  const industries: HeatmapIndustry[] = []
  for (const [indexCode, ind] of l1IndustryMap) {
    const subs = l2Bucket.get(indexCode)
    if (subs && subs.length > 0) {
      ind.subIndustries = subs.sort((a, b) => b.change - a.change)
    }
    industries.push(ind)
  }

  // 按加权涨跌幅降序排列
  industries.sort((a, b) => b.weightedChange - a.weightedChange)

  return {
    updatedAt: new Date().toISOString(),
    industries
  }
}

/**
 * FR-132: 成分股懒加载（静态名单，无实时行情）
 * 调 index_member_all(l1Code, is_new='Y') 拿成分股 ts_code + name
 * 代码格式转换: 000001.SZ → SZ000001，600036.SH → SH600036
 */
export async function fetchTushareIndustryConstituents(
  token: string,
  tsCode: string,
  _name: string
): Promise<HeatmapStock[]> {
  // 确保缓存已填充（正常情况下 fetchTushareSnapshot 已先调用，这里仅防御性处理）
  if (!_l1Cache) await ensureL1Cache(token)

  let members: Awaited<ReturnType<typeof fetchSwMembers>>
  const isL1 = _l1Cache!.some(it => it.indexCode === tsCode)
  if (isL1) {
    // L1 行业：直接传 l1_code
    members = await fetchSwMembers(token, tsCode)
  } else {
    // L2 子行业：找父 L1 的 indexCode，传 l1_code + l2_code 过滤
    const l2Info = _l2Cache?.find(it => it.indexCode === tsCode)
    if (!l2Info) return []
    members = await fetchSwMembers(token, l2Info.parentIndexCode, tsCode)
  }

  return members.map(m => {
    // 从共享 rt_k 缓存补充实时涨跌幅；缓存未命中（盘外/权限不足）时回退为 0
    const quote = getRtKCache()?.get(m.tsCode)
    return {
      code: convertTsCode(m.tsCode),
      name: m.name,
      price: quote?.price ?? 0,
      change: quote?.change ?? 0,
      marketCap: quote?.amount ?? 0
    }
  })
}

/**
 * 将 Tushare 代码格式（000001.SZ）转换为内部流转格式（SZ000001）
 * 规则: 拆 '.'，后缀前移 → 000001.SZ → SZ000001
 */
function convertTsCode(tsCode: string): string {
  const parts = tsCode.split('.')
  if (parts.length !== 2) return tsCode
  return parts[1] + parts[0]
}
