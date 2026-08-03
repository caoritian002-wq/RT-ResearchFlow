/**
 * FR-098/FR-114/FR-117: 行业云图 —— 东方财富数据源实现
 *
 * 主拉接口（板块聚合，单请求拿全部 86 个一级行业）：
 *   GET https://{HOST}/api/qt/clist/get
 *     ?fs=m:90+t:2
 *     &fields=f2,f3,f12,f14,f20,f100,f128,f140,f136,f124
 *     &pn=1&pz=200&po=1&np=1&fltt=2&invt=2&fid=f3
 *
 * 字段映射（板块行）：
 *   f12 = 板块代码（如 BK1621）  → industry.code
 *   f14 = 板块中文名（与 f100 等价）→ industry.name
 *   f3  = 板块加权涨跌幅（官方计算，已剔除新股 / N / C 异常）→ weightedChange
 *   f20 = 板块总市值                → totalMarketCap
 *   f128/f140/f136 = 领涨股名/代码/涨幅 → stocks[0]（占位 1 只，hover 时懒加载补全）
 *
 * Hover 懒加载接口（按板块代码拉成分股）：
 *   GET https://{HOST}/api/qt/clist/get?fs=b:{BKxxxx}&fields=f2,f3,f12,f14,f20...
 *
 * 节点策略（FR-117 全交易时段 + 失败降级）：
 *   - 整个交易时段（北京时间 09:15–11:30 + 13:00–15:00）：push2.eastmoney.com（实时）
 *   - 非交易时段（盘前 / 午休 / 盘后 / 非交易日）：push2delay.eastmoney.com（延时，反爬宽松）
 *   - push2 累计连续 3 次失败时自动降级至当日结束（次日北京时间 0 点重置）
 *   - 单次请求失败仍保留 mainHost → DELAY 即时 fallback（FR-114 既有逻辑）
 *   - hover 懒加载与主拉共享同一节点策略与失败计数器
 */

import { net } from 'electron'
import type { HeatmapStock, HeatmapIndustry, MarketSnapshot } from './marketHeatmapService'
import { EmptyDataError } from './marketHeatmapService'
import { SHENWAN_L1_CODE_SET, SHENWAN_L2_NAME_TO_L1_CODE } from './eastmoneyIndustryHierarchy'

const HOST_REALTIME = 'push2.eastmoney.com'
const HOST_DELAY = 'push2delay.eastmoney.com'

const BOARD_FS = 'm:90+t:2'
const FIELDS_BOARD = 'f2,f3,f12,f14,f20,f100,f128,f140,f136,f124'
const FIELDS_CONS = 'f2,f3,f12,f14,f20'

const PER_REQUEST_TIMEOUT_MS = 8000
const TOTAL_TIMEOUT_MS = 20000
const RETRY_MAX = 1
const RETRY_BASE_DELAY_MS = 400

interface EmDiffItem {
  f2?: number | string
  f3?: number | string
  f12?: string
  f14?: string
  f20?: number | string
  f100?: string
  f128?: string
  f140?: string
  f136?: number | string
}

interface EmResponse {
  data?: { total?: number; diff?: EmDiffItem[] | null }
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'

/** 当前北京时间小时:分钟字符串 'HHMM'（数值） */
function bjHHMM(): number {
  const now = new Date()
  // 北京时间 = UTC + 8h
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes()
  const bjMin = (utcMin + 8 * 60) % (24 * 60)
  const h = Math.floor(bjMin / 60)
  const m = bjMin % 60
  return h * 100 + m
}

/** 当前北京时间日期字符串 YYYY-MM-DD（用于失败计数器降级 key） */
function getBjDateStr(): string {
  const now = new Date()
  // 北京时间偏移
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  const y = bj.getUTCFullYear()
  const m = String(bj.getUTCMonth() + 1).padStart(2, '0')
  const d = String(bj.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * FR-117: push2 实时节点连续失败计数器 + 探测恢复机制
 *   - 累计 3 次失败 → 当日内降级到 push2delay（failBackoffUntilDate 记今日日期）
 *   - 降级生效后每 5 分钟允许一次 push2 探测；探测成功则重置计数器并解除降级
 *   - 次日北京时间 0 点之后第一次拉取自动重置
 */
let consecutiveFailCount = 0
let failBackoffUntilDate: string | null = null
let lastProbeAt = 0  // 上次 push2 探测时间戳（ms）
const PROBE_INTERVAL_MS = 5 * 60 * 1000  // 降级期间探测间隔

/**
 * FR-114/FR-117: 主节点动态选择
 *   - 整个交易时段（北京时间 09:15–11:30 + 13:00–15:00）：push2 实时
 *   - 非交易时段：push2delay 延时
 *   - 当日已累计 3 次 push2 失败：强制降级到 push2delay，但每 5 分钟允许一次探测
 */
function pickMainHost(): string {
  const t = bjHHMM()
  const isInTradingHours = (t >= 915 && t <= 1130) || (t >= 1300 && t <= 1500)
  if (!isInTradingHours) {
    console.log(`[eastmoneyProvider] pickHost: DELAY (off-hours, t=${t})`)
    return HOST_DELAY
  }
  if (failBackoffUntilDate === getBjDateStr()) {
    // 降级期内探测恢复：距上次探测超过 5 分钟则试一次 push2
    const now = Date.now()
    if (now - lastProbeAt >= PROBE_INTERVAL_MS) {
      lastProbeAt = now
      console.log(`[eastmoneyProvider] pickHost: REALTIME (probe attempt during backoff)`)
      return HOST_REALTIME
    }
    console.log(`[eastmoneyProvider] pickHost: DELAY (in backoff, next probe in ${Math.ceil((PROBE_INTERVAL_MS - (now - lastProbeAt)) / 1000)}s)`)
    return HOST_DELAY
  }
  console.log(`[eastmoneyProvider] pickHost: REALTIME (in-hours, no backoff)`)
  return HOST_REALTIME
}

function buildBoardUrl(host: string, page = 1): string {
  // fid=f20: 按市值降序，确保分页截断时也能优先展示最重要的板块；
  // pz=100: 实际 API 上限就是 100，写 200 也只返回 100
  return (
    `https://${host}/api/qt/clist/get?fs=${BOARD_FS}` +
    `&fields=${FIELDS_BOARD}&pn=${page}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f20&_=${Date.now()}`
  )
}

function buildConstituentUrl(industryCode: string, host: string): string {
  // FR-117: hover 跟随主拉的节点策略（盘中走 push2 实时、盘外走 push2delay、降级期内统一走 push2delay）
  return (
    `https://${host}/api/qt/clist/get?fs=b:${encodeURIComponent(industryCode)}` +
    `&fields=${FIELDS_CONS}&pn=1&pz=200&po=1&np=1&fltt=2&invt=2&fid=f3&_=${Date.now()}`
  )
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    if (v === '-' || v === '') return NaN
    const n = Number(v)
    return Number.isFinite(n) ? n : NaN
  }
  return NaN
}

/** 个股代码标准化：6 开头 → SH，4/8 开头 → BJ，其余 → SZ */
function normalizeCode(code: string): string {
  if (!code) return ''
  if (code.startsWith('6')) return `SH${code}`
  if (code.startsWith('4') || code.startsWith('8')) return `BJ${code}`
  return `SZ${code}`
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchJson(url: string, timeoutMs: number): Promise<EmResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await net.fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      }
    } as RequestInit)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as EmResponse
  } finally {
    clearTimeout(timer)
  }
}

async function fetchJsonWithRetry(url: string): Promise<EmResponse> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    try {
      return await fetchJson(url, PER_REQUEST_TIMEOUT_MS)
    } catch (err) {
      lastErr = err
      if (attempt < RETRY_MAX) {
        await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 100))
      }
    }
  }
  throw new Error(
    `request failed after ${RETRY_MAX + 1} attempts: ${
      (lastErr as Error)?.message ?? String(lastErr)
    }`
  )
}

/** 主拉：板块聚合（单请求拿全部一级行业） */
export async function fetchEastmoneySnapshot(): Promise<MarketSnapshot> {
  const t0 = Date.now()

  // FR-117: 跨日重置失败计数器（次日北京时间 0 点之后第一次拉取）
  if (failBackoffUntilDate !== null && failBackoffUntilDate !== getBjDateStr()) {
    consecutiveFailCount = 0
    failBackoffUntilDate = null
    console.log('[eastmoneyProvider] cross-day, push2 fail counter reset')
  }

  const mainHost = pickMainHost()
  const PAGE_SIZE = 100

  // 先拉第 1 页，确定 total 数量
  let page1: EmResponse
  let effectiveHost = mainHost
  try {
    console.log(`[eastmoneyProvider] board page-1 fetch via ${mainHost}`)
    page1 = await fetchJsonWithRetry(buildBoardUrl(mainHost, 1))
    // FR-117: push2 实时节点请求成功 → 重置计数器并解除降级状态
    if (mainHost === HOST_REALTIME) {
      if (consecutiveFailCount > 0 || failBackoffUntilDate !== null) {
        console.log(
          `[eastmoneyProvider] push2 success, clear backoff (was failCount=${consecutiveFailCount}, backoffDate=${failBackoffUntilDate})`
        )
        consecutiveFailCount = 0
        failBackoffUntilDate = null
      }
    }
  } catch (err) {
    // FR-117: push2 实时节点失败 → 累加计数器，达到 3 次自动降级到当日结束
    if (mainHost === HOST_REALTIME) {
      consecutiveFailCount++
      console.warn(
        `[eastmoneyProvider] push2 failure ${consecutiveFailCount}/3: ${
          (err as Error)?.message ?? err
        }`
      )
      if (consecutiveFailCount >= 3) {
        failBackoffUntilDate = getBjDateStr()
        console.warn(
          `[eastmoneyProvider] push2 fail threshold reached, downgrading to ${HOST_DELAY} until ${failBackoffUntilDate}`
        )
      }
    }
    // 主节点失败 → 立即降级到 push2delay（FR-114 既有逻辑）
    if (mainHost !== HOST_DELAY) {
      console.warn(
        `[eastmoneyProvider] ${mainHost} failed, fallback to ${HOST_DELAY}: ${
          (err as Error)?.message ?? err
        }`
      )
      effectiveHost = HOST_DELAY
      page1 = await fetchJsonWithRetry(buildBoardUrl(HOST_DELAY, 1))
    } else {
      throw err
    }
  }

  const total = page1?.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  let allDiff: EmDiffItem[] = [...(page1?.data?.diff ?? [])]

  // 剩余页串行逐页拉取（不并发，依靠每次请求的自然 RTT ~200ms 作为间隔，防触发反爬）
  if (totalPages > 1) {
    for (let pn = 2; pn <= totalPages; pn++) {
      if (Date.now() - t0 > TOTAL_TIMEOUT_MS) {
        console.warn(`[eastmoneyProvider] total timeout mid-pagination at page ${pn}`)
        break
      }
      try {
        const r = await fetchJsonWithRetry(buildBoardUrl(effectiveHost, pn))
        allDiff = allDiff.concat(r?.data?.diff ?? [])
      } catch (err) {
        console.warn(`[eastmoneyProvider] page ${pn} failed, skipping: ${(err as Error)?.message ?? err}`)
      }
      // 非最后一页：随机 sleep 1–3s，降低触发反爬的概率
      if (pn < totalPages) {
        const delay = 1000 + Math.floor(Math.random() * 2000)
        await sleep(delay)
      }
    }
  }

  console.log(
    `[eastmoneyProvider] got ${allDiff.length}/${total} boards in ${Date.now() - t0}ms (pages: ${totalPages})`
  )
  if (allDiff.length === 0) throw new EmptyDataError('Eastmoney returned empty board diff array')

  const diff = allDiff

  const industries: HeatmapIndustry[] = []
  let skippedSubLevel = 0
  // FR-119: 收集 L2 子行业到对应 L1 桶（按 L1 BK 代码索引）
  const subBucket = new Map<string, HeatmapStock[]>()
  let collectedL2 = 0
  let skippedOrphan = 0
  for (const item of diff) {
    const code = (item.f12 ?? '').trim()
    const name = (item.f14 ?? item.f100 ?? '').trim()
    const change = toNum(item.f3)
    const marketCap = toNum(item.f20)
    if (!code || !name) continue
    // FR-118: 仅保留申万 31 个真·一级行业（硬编码白名单 SHENWAN_L1_CODE_SET）
    // 探针验证（2026-04-28）：东财 m:90+t:2 接口 total ~496 板块按代码段分布如下：
    //   BK01xx → 31 个地区板块（北京/广东/上海...）
    //   BK04xx → 32 个，其中仅 10 个为申万一级（公用事业/食品饮料/煤炭/家电/有色金属/钢铁
    //            /传媒/农林牧渔/纺织服饰/石油石化），其余 22 个为二级（电力/通信设备/证券Ⅱ
    //            /保险Ⅱ/银行Ⅱ/汽车零部件/化学制药/电网设备/航空机场/家居用品/...）
    //   BK12xx → 97 个，其中仅 19 个为申万一级（电子/银行/电力设备/通信/非银金融/医药生物
    //            /机械设备/基础化工/汽车/计算机/国防军工/交通运输/建筑装饰/轻工制造/建筑材料
    //            /房地产/商贸零售/社会服务/综合），其余 78 个为二级（白酒Ⅱ/IT 服务Ⅱ/...）
    //   BK0728 = 环保（一级），BK1035 = 美容护理（一级）
    //   BK05/09/13-16 → 全部二级及以下层级
    // 接口本身不暴露层级标识字段（f124 全部=1777361985 无效），名字罗马后缀 Ⅱ/Ⅲ 仅覆盖一小
    // 部分子级，无法作为通用过滤条件。硬编码白名单是唯一可靠维度，分类标准多年不变。
    if (!SHENWAN_L1_CODE_SET.has(code)) {
      skippedSubLevel++
      // FR-119: 非 L1 板块尝试按名字反查 L1 归属（仅申万官方 L2 命中）
      if (Number.isFinite(change) && Number.isFinite(marketCap) && marketCap > 0) {
        const l1Code = SHENWAN_L2_NAME_TO_L1_CODE.get(name)
        if (l1Code) {
          const arr = subBucket.get(l1Code) ?? []
          arr.push({
            code,
            name,
            price: 0,
            change,
            marketCap
          })
          subBucket.set(l1Code, arr)
          collectedL2++
        } else {
          skippedOrphan++
        }
      }
      continue
    }
    if (!Number.isFinite(change) || !Number.isFinite(marketCap) || marketCap <= 0) continue

    const stocks: HeatmapStock[] = []
    const leaderName = (item.f128 ?? '').trim()
    const leaderCode = (item.f140 ?? '').trim()
    const leaderChange = toNum(item.f136)
    if (leaderName && leaderCode && Number.isFinite(leaderChange)) {
      stocks.push({
        code: normalizeCode(leaderCode),
        name: leaderName,
        price: 0, // 板块接口不返回领涨股价格，前端 hover 卡片不显示
        change: leaderChange,
        marketCap: 0
      })
    }

    industries.push({ name, code, totalMarketCap: marketCap, weightedChange: change, stocks })
  }

  // FR-119: 将 L2 桶按 L1 BK 代码合并到对应 industry，并按 change 降序排序
  for (const industry of industries) {
    const subs = subBucket.get(industry.code ?? '')
    if (subs && subs.length > 0) {
      subs.sort((a, b) => b.change - a.change)
      industry.subIndustries = subs
    }
  }

  industries.sort((a, b) => b.totalMarketCap - a.totalMarketCap)
  if (industries.length === 0) {
    throw new EmptyDataError('No industries assembled from Eastmoney board data')
  }
  console.log(
    `[eastmoneyProvider] kept ${industries.length} L1 + collected ${collectedL2} L2 across ${subBucket.size} L1 buckets (skipped ${skippedSubLevel} sub-level non-L1, ${skippedOrphan} orphan L2 not in shenwan map, total ${diff.length})`
  )
  return { updatedAt: new Date().toISOString(), industries }
}

/**
 * FR-114: hover 懒加载 —— 按板块代码拉单个行业全部成分股
 *
 * 单请求 8s 超时，失败抛错由 handler 层捕获并向前端返回错误码。
 * 不在此处重试 / 降级，由前端 hover 防护层（防抖 + 缓存 + singleflight + 令牌桶）兜底。
 */
export async function fetchEastmoneyIndustryConstituents(
  industryCode: string
): Promise<HeatmapStock[]> {
  if (!industryCode) return []
  const t0 = Date.now()
  // FR-117: hover 跟随主拉节点策略
  const host = pickMainHost()
  const json = await fetchJson(buildConstituentUrl(industryCode, host), PER_REQUEST_TIMEOUT_MS)
  const diff = json?.data?.diff ?? []
  console.log(
    `[eastmoneyProvider] constituents ${industryCode} via ${host}: ${diff.length} stocks in ${Date.now() - t0}ms`
  )

  const stocks: HeatmapStock[] = []
  for (const item of diff) {
    const code = (item.f12 ?? '').trim()
    const name = (item.f14 ?? '').trim()
    const change = toNum(item.f3)
    const price = toNum(item.f2)
    const marketCap = toNum(item.f20)
    if (!code || !name) continue
    if (!Number.isFinite(change) || !Number.isFinite(marketCap) || marketCap <= 0) continue
    stocks.push({
      code: normalizeCode(code),
      name,
      price: Number.isFinite(price) ? price : 0,
      change,
      marketCap
    })
  }
  stocks.sort((a, b) => b.change - a.change)
  return stocks
}
