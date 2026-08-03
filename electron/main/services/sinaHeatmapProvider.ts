/**
 * FR-098/FR-121/FR-122: 行业云图 —— 新浪财经数据源实现
 *
 * 数据源（FR-122 升级为 GB/T 4754 国民经济行业分类）：
 *   L2 行业列表：vip.stock.finance.sina.com.cn/q/view/newFLJK.php?param=industry
 *     → 84 个 GB/T 中类（ZA01..ZS90），自带 totalMarketCap/weightedChange
 *   M2 行业成分股：vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData
 *     → node=hangye_Zxx，含 mktcap（万元，真实总市值）
 *
 * 适用场景：DPI 受限网络（公司/ISP 屏蔽东财 clist/get 路径）。
 * 网络层使用 Node 原生 `https` 模块（独立 OpenSSL 网络栈）。
 *
 * 与东财对齐策略：
 *   - 84 个 GB/T L2 通过 SINA_GBT_TO_SHENWAN_L1 映射归并到 31 个申万 L1
 *   - L1 的 weightedChange = ∑(L2 change × L2 mcap) / ∑ L2 mcap
 *   - L1 的 totalMarketCap = ∑ L2 mcap
 *   - subIndustries 填该 L1 下所有 GB/T L2（与东财 L2 嵌套一致）
 *   - 个股 marketCap 来自 mktcap 字段（万元转元，真实市值）
 */

import * as https from 'https'
import { URL } from 'url'
import type { HeatmapStock, HeatmapIndustry, MarketSnapshot } from './marketHeatmapService'
import { EmptyDataError } from './marketHeatmapService'

/**
 * FR-122: 84 个 GB/T 国民经济行业中类 → 31 个申万 L1 行业映射表
 *   - 注释中标注 GB/T 中类名（按字母大类编码：A 农、B 采矿、C 制造、D 电力、E 建筑、
 *     F 批发零售、G 交通运输、H 住宿餐饮、I 信息技术、J 金融、K 房地产、L 租赁、
 *     M 科研、N 环境、O 居民服务、P 教育、Q 卫生、R 文化、S 综合）
 */
const SINA_GBT_TO_SHENWAN_L1: Record<string, string> = {
  // A 农林牧渔
  hangye_ZA01: '农林牧渔', // 农业
  hangye_ZA02: '农林牧渔', // 林业
  hangye_ZA03: '农林牧渔', // 畜牧业
  hangye_ZA04: '农林牧渔', // 渔业
  hangye_ZA05: '农林牧渔', // 农林牧渔服务业
  // B 采矿业
  hangye_ZB06: '煤炭',
  hangye_ZB07: '石油石化', // 石油和天然气开采
  hangye_ZB08: '钢铁', // 黑色金属矿采选
  hangye_ZB09: '有色金属', // 有色金属矿采选
  hangye_ZB10: '建筑材料', // 非金属矿采选
  hangye_ZB11: '石油石化', // 开采辅助
  // C 制造业
  hangye_ZC13: '食品饮料', // 农副食品加工
  hangye_ZC14: '食品饮料', // 食品制造
  hangye_ZC15: '食品饮料', // 酒、饮料和精制茶
  hangye_ZC17: '纺织服饰', // 纺织业
  hangye_ZC18: '纺织服饰', // 纺织服装
  hangye_ZC19: '纺织服饰', // 皮革羽毛
  hangye_ZC20: '轻工制造', // 木材加工
  hangye_ZC21: '轻工制造', // 家具制造
  hangye_ZC22: '轻工制造', // 造纸
  hangye_ZC23: '传媒', // 印刷和记录媒介
  hangye_ZC24: '轻工制造', // 文教工美体育
  hangye_ZC25: '石油石化', // 石油加工炼焦
  hangye_ZC26: '基础化工', // 化学原料和化学制品
  hangye_ZC27: '医药生物', // 医药制造
  hangye_ZC28: '基础化工', // 化学纤维
  hangye_ZC29: '基础化工', // 橡胶和塑料制品
  hangye_ZC30: '建筑材料', // 非金属矿物制品
  hangye_ZC31: '钢铁', // 黑色金属冶炼
  hangye_ZC32: '有色金属', // 有色金属冶炼
  hangye_ZC33: '机械设备', // 金属制品
  hangye_ZC34: '机械设备', // 通用设备
  hangye_ZC35: '机械设备', // 专用设备
  hangye_ZC36: '汽车', // 汽车制造
  hangye_ZC37: '国防军工', // 铁路船舶航空航天
  hangye_ZC38: '电力设备', // 电气机械和器材
  hangye_ZC39: '电子', // 计算机通信和其他电子设备
  hangye_ZC40: '机械设备', // 仪器仪表
  hangye_ZC41: '综合', // 其他制造业
  hangye_ZC42: '环保', // 废弃资源综合利用
  hangye_ZC43: '机械设备', // 金属设备修理
  // D 电力热力燃气
  hangye_ZD44: '公用事业', // 电力热力
  hangye_ZD45: '公用事业', // 燃气
  hangye_ZD46: '公用事业', // 水的生产和供应
  // E 建筑业
  hangye_ZE47: '建筑装饰', // 房屋建筑
  hangye_ZE48: '建筑装饰', // 土木工程
  hangye_ZE49: '建筑装饰', // 建筑安装
  hangye_ZE50: '建筑装饰', // 建筑装饰和其他建筑
  // F 批发零售
  hangye_ZF51: '商贸零售', // 批发
  hangye_ZF52: '商贸零售', // 零售
  // G 交通运输仓储邮政
  hangye_ZG53: '交通运输', // 铁路
  hangye_ZG54: '交通运输', // 道路
  hangye_ZG55: '交通运输', // 水上
  hangye_ZG56: '交通运输', // 航空
  hangye_ZG58: '交通运输', // 装卸搬运
  hangye_ZG59: '交通运输', // 仓储
  hangye_ZG60: '交通运输', // 邮政
  // H 住宿餐饮
  hangye_ZH61: '社会服务', // 住宿
  hangye_ZH62: '社会服务', // 餐饮
  // I 信息技术
  hangye_ZI63: '通信', // 电信广播电视卫星传输
  hangye_ZI64: '计算机', // 互联网
  hangye_ZI65: '计算机', // 软件和信息技术服务
  // J 金融业
  hangye_ZJ66: '银行', // 货币金融服务
  hangye_ZJ67: '非银金融', // 资本市场服务
  hangye_ZJ68: '非银金融', // 保险业
  hangye_ZJ69: '非银金融', // 其他金融业
  // K 房地产
  hangye_ZK70: '房地产',
  // L 租赁和商务服务
  hangye_ZL71: '社会服务', // 租赁业
  hangye_ZL72: '社会服务', // 商务服务业
  // M 科研技术服务
  hangye_ZM73: '综合', // 研究和试验发展
  hangye_ZM74: '综合', // 专业技术服务
  hangye_ZM75: '综合', // 科技推广
  // N 水利环境
  hangye_ZN76: '公用事业', // 水利管理
  hangye_ZN77: '环保', // 生态保护和环境治理
  hangye_ZN78: '公用事业', // 公共设施管理
  // O 居民服务
  hangye_ZO80: '社会服务', // 修理业
  // P 教育
  hangye_ZP82: '社会服务',
  // Q 卫生和社会工作
  hangye_ZQ83: '医药生物', // 卫生
  hangye_ZQ84: '社会服务', // 社会工作
  // R 文化体育娱乐
  hangye_ZR85: '传媒', // 新闻出版
  hangye_ZR86: '传媒', // 广播电视电影
  hangye_ZR87: '传媒', // 文化艺术
  hangye_ZR88: '社会服务', // 体育
  // S 综合
  hangye_ZS90: '综合'
}

const SHENWAN_FALLBACK = '综合'

const SINA_INDUSTRY_LIST_URL = 'https://vip.stock.finance.sina.com.cn/q/view/newFLJK.php?param=industry'
const SINA_INDUSTRY_NODE_URL =
  'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData' +
  '?page=1&num=500&sort=symbol&asc=1&node='

const PER_REQUEST_TIMEOUT_MS = 15000
const TOTAL_TIMEOUT_MS = 60000
const CONCURRENCY = 6
const BATCH_DELAY_MS = 100
const RETRY_MAX = 2
const RETRY_BASE_DELAY_MS = 400

const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: 'https://finance.sina.com.cn/'
}

function normalizeCode(rawSymbol: string): string {
  if (!rawSymbol) return ''
  return rawSymbol.toUpperCase()
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function httpsGetRaw(url: string, parentSignal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const startedAt = Date.now()
    const req = https.request(
      {
        method: 'GET',
        hostname: u.hostname,
        path: u.pathname + u.search,
        port: u.port || 443,
        headers: HEADERS,
        agent: false,
        timeout: PER_REQUEST_TIMEOUT_MS
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          const elapsed = Date.now() - startedAt
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            console.warn(`[sinaProvider][https] HTTP ${res.statusCode} (${elapsed}ms) ${url}`)
            reject(new Error(`HTTP ${res.statusCode}`))
            return
          }
          resolve(buf)
        })
        res.on('error', (err) => reject(err))
      }
    )
    req.on('timeout', () => req.destroy(new Error('request timeout')))
    req.on('error', (err) => {
      const elapsed = Date.now() - startedAt
      console.warn(`[sinaProvider][https] ERROR (${elapsed}ms) ${err.name}: ${err.message} on ${url}`)
      reject(err)
    })
    const onParentAbort = () => req.destroy(new Error('aborted'))
    parentSignal.addEventListener('abort', onParentAbort, { once: true })
    req.on('close', () => parentSignal.removeEventListener('abort', onParentAbort))
    req.end()
  })
}

async function httpsGetWithRetry(url: string, parentSignal: AbortSignal): Promise<Buffer> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    if (parentSignal.aborted) throw new Error('aborted')
    try {
      return await httpsGetRaw(url, parentSignal)
    } catch (err) {
      lastErr = err
      if (attempt < RETRY_MAX) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 100)
        await sleep(delay)
      }
    }
  }
  throw new Error(`request failed after ${RETRY_MAX + 1} attempts: ${(lastErr as Error)?.message ?? lastErr}`)
}

function decodeBody(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      return buf.toString('utf8')
    }
  }
}

interface IndustryListItem {
  code: string
  name: string
  stockCount: number
  weightedChange: number
  totalMarketCap: number
}

function parseIndustryList(text: string): IndustryListItem[] {
  const eqIdx = text.indexOf('=')
  if (eqIdx < 0) throw new Error('parseIndustryList: no `=` in response')
  const jsonStart = text.indexOf('{', eqIdx)
  const jsonEnd = text.lastIndexOf('}')
  if (jsonStart < 0 || jsonEnd <= jsonStart) throw new Error('parseIndustryList: no JSON object')
  const raw = text.slice(jsonStart, jsonEnd + 1)
  let obj: Record<string, string>
  try {
    obj = JSON.parse(raw)
  } catch (e) {
    throw new Error(`parseIndustryList: JSON.parse failed: ${(e as Error).message}`)
  }
  const out: IndustryListItem[] = []
  for (const [, csv] of Object.entries(obj)) {
    if (typeof csv !== 'string') continue
    const parts = csv.split(',')
    if (parts.length < 13) continue
    const code = parts[0].trim()
    const name = parts[1].trim()
    const stockCount = toNum(parts[2])
    const weightedChange = toNum(parts[5])
    const totalMarketCap = toNum(parts[7])
    if (!code || !name) continue
    if (!Number.isFinite(weightedChange) || !Number.isFinite(totalMarketCap) || totalMarketCap <= 0) continue
    out.push({ code, name, stockCount: Number.isFinite(stockCount) ? stockCount : 0, weightedChange, totalMarketCap })
  }
  return out
}

interface SinaStockItem {
  symbol?: string
  name?: string
  trade?: string | number
  changepercent?: string | number
  amount?: string | number
  mktcap?: string | number  // 总市值（万元）
}

function parseIndustryStocks(text: string): HeatmapStock[] {
  const trimmed = text.trim()
  if (!trimmed.startsWith('[')) return []
  let arr: SinaStockItem[]
  try {
    arr = JSON.parse(trimmed)
  } catch {
    return []
  }
  const out: HeatmapStock[] = []
  for (const it of arr) {
    const symbol = (it.symbol ?? '').trim()
    const name = (it.name ?? '').trim()
    const change = toNum(it.changepercent)
    const price = toNum(it.trade)
    const mktcapWan = toNum(it.mktcap)  // 万元
    const amount = toNum(it.amount)
    if (!symbol || !name || !Number.isFinite(change)) continue
    // FR-122: 优先用 mktcap（真实市值，万元→元），fallback 到 amount（成交额）
    const marketCap = Number.isFinite(mktcapWan) && mktcapWan > 0
      ? mktcapWan * 10000
      : (Number.isFinite(amount) && amount > 0 ? amount : 1)
    out.push({
      code: normalizeCode(symbol),
      name,
      price: Number.isFinite(price) ? price : 0,
      change,
      marketCap
    })
  }
  return out
}

export async function fetchSinaSnapshot(): Promise<MarketSnapshot> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS)
  try {
    console.log('[sinaProvider] fetching industry list (L1)...')
    const t0 = Date.now()
    const listBuf = await httpsGetWithRetry(SINA_INDUSTRY_LIST_URL, controller.signal)
    const listText = decodeBody(listBuf)
    const industries = parseIndustryList(listText)
    console.log(`[sinaProvider] L1 returned ${industries.length} industries in ${Date.now() - t0}ms`)
    if (industries.length === 0) throw new EmptyDataError('Sina industry list empty')

    const t1 = Date.now()
    const stocksMap = new Map<string, HeatmapStock[]>()
    for (let i = 0; i < industries.length; i += CONCURRENCY) {
      if (controller.signal.aborted) throw new Error('aborted')
      const batch = industries.slice(i, i + CONCURRENCY)
      const results = await Promise.allSettled(
        batch.map(async (ind) => {
          const url = SINA_INDUSTRY_NODE_URL + encodeURIComponent(ind.code)
          const buf = await httpsGetWithRetry(url, controller.signal)
          const text = decodeBody(buf)
          const stocks = parseIndustryStocks(text)
          return { code: ind.code, stocks }
        })
      )
      for (let k = 0; k < results.length; k++) {
        const r = results[k]
        if (r.status === 'fulfilled') {
          stocksMap.set(r.value.code, r.value.stocks)
        } else {
          console.warn(`[sinaProvider] industry ${batch[k].code} (${batch[k].name}) failed: ${(r.reason as Error)?.message ?? r.reason}`)
        }
      }
      if (i + CONCURRENCY < industries.length) await sleep(BATCH_DELAY_MS)
    }
    console.log(`[sinaProvider] M2 fetched ${stocksMap.size}/${industries.length} industries in ${Date.now() - t1}ms`)

    // FR-122: 84 个 GB/T 国民经济行业中类 → 31 个申万 L1 聚合（与东财统一）
    interface Bucket {
      name: string
      weightedSum: number // ∑ (gbtL2.weightedChange × gbtL2.totalMarketCap)
      mcapSum: number    // ∑ gbtL2.totalMarketCap
      stocks: HeatmapStock[]
      subIndustries: HeatmapStock[] // 该 L1 下的所有 GB/T L2 子行业
    }
    const buckets = new Map<string, Bucket>()
    let unmappedCount = 0
    for (const ind of industries) {
      const l1 = SINA_GBT_TO_SHENWAN_L1[ind.code] ?? SHENWAN_FALLBACK
      if (!SINA_GBT_TO_SHENWAN_L1[ind.code]) unmappedCount++
      let bucket = buckets.get(l1)
      if (!bucket) {
        bucket = { name: l1, weightedSum: 0, mcapSum: 0, stocks: [], subIndustries: [] }
        buckets.set(l1, bucket)
      }
      bucket.weightedSum += ind.weightedChange * ind.totalMarketCap
      bucket.mcapSum += ind.totalMarketCap
      const stocks = stocksMap.get(ind.code) ?? []
      bucket.stocks.push(...stocks)
      // L2 子行业：把 GB/T 中类作为 HeatmapStock 形态推入 subIndustries
      bucket.subIndustries.push({
        code: ind.code, // hangye_Zxx，供 hover 懒加载使用
        name: ind.name,
        price: 0,
        change: ind.weightedChange,
        marketCap: ind.totalMarketCap
      })
    }
    if (unmappedCount > 0) {
      console.warn(`[sinaProvider] ${unmappedCount} GB/T industries unmapped, fallback to "${SHENWAN_FALLBACK}"`)
    }

    const out: HeatmapIndustry[] = []
    for (const bucket of buckets.values()) {
      bucket.stocks.sort((a, b) => b.marketCap - a.marketCap)
      bucket.subIndustries.sort((a, b) => b.marketCap - a.marketCap)
      out.push({
        name: bucket.name,
        totalMarketCap: bucket.mcapSum,
        weightedChange: bucket.mcapSum > 0 ? bucket.weightedSum / bucket.mcapSum : 0,
        stocks: bucket.stocks,
        subIndustries: bucket.subIndustries
      })
    }
    out.sort((a, b) => b.totalMarketCap - a.totalMarketCap)
    if (out.length === 0) throw new EmptyDataError('No industries assembled')
    const subTotal = out.reduce((sum, i) => sum + (i.subIndustries?.length ?? 0), 0)
    console.log(`[sinaProvider] aggregated to ${out.length} Shenwan L1 + ${subTotal} GB/T L2 (from ${industries.length} GB/T raw)`)
    return { updatedAt: new Date().toISOString(), industries: out }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * FR-122: 按 hangye_Zxx 代码懒加载 GB/T L2 行业的成分股
 *   - 用于前端 hover/点击 L2 触发的成分股拉取
 *   - 永远不抛错；上游失败返回空数组
 */
export async function fetchSinaIndustryConstituents(industryCode: string): Promise<HeatmapStock[]> {
  if (!industryCode || !industryCode.startsWith('hangye_')) return []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PER_REQUEST_TIMEOUT_MS)
  try {
    const url = SINA_INDUSTRY_NODE_URL + encodeURIComponent(industryCode)
    const buf = await httpsGetWithRetry(url, controller.signal)
    const text = decodeBody(buf)
    const stocks = parseIndustryStocks(text)
    return stocks.sort((a, b) => b.change - a.change)
  } catch (err) {
    console.warn(`[sinaProvider] L2 constituents ${industryCode} failed: ${(err as Error)?.message ?? err}`)
    return []
  } finally {
    clearTimeout(timer)
  }
}
