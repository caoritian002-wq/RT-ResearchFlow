/**
 * FR-096/FR-098/FR-114/FR-132: 行业云图数据服务 —— 路由层
 *
 * 负责：
 *   1. 定义并导出公共接口类型（HeatmapStock / HeatmapIndustry / MarketSnapshot）
 *   2. 定义并导出 EmptyDataError 错误类
 *   3. 根据 settingsRepository.getMarketHeatmapProvider() 的返回值，
 *      将 fetchMarketSnapshot() 调用路由到对应的数据源实现
 *   4. (FR-114) 提供 fetchIndustryConstituents() 方法用于 hover 懒加载行业成分股
 *
 * 数据源：
 *   'sina'       → sinaHeatmapProvider.fetchSinaSnapshot()（默认，Node https 模块）
 *   'eastmoney'  → eastmoneyHeatmapProvider.fetchEastmoneySnapshot()（Electron net.fetch）
 *   'tushare'    → tushareHeatmapProvider.fetchTushareSnapshot()（申万实时行情，需月度订阅）
 */

import { getMarketHeatmapProvider } from '../database/settingsRepository'
import { getDb } from '../database/db'
import { getDataSourceConfig } from '../database/dataSourceRepository'
import { decryptApiKey } from '../utils/apiKeyEncryption'
import { fetchSinaSnapshot, fetchSinaIndustryConstituents } from './sinaHeatmapProvider'
import {
  fetchEastmoneySnapshot,
  fetchEastmoneyIndustryConstituents
} from './eastmoneyHeatmapProvider'
import {
  fetchTushareSnapshot,
  fetchTushareIndustryConstituents
} from './tushareHeatmapProvider'

export interface HeatmapStock {
  code: string // 标准化后代码：SH600000 / SZ000001 / BJ920000
  name: string
  price: number
  change: number // 涨跌幅百分数（带正负，如 -1.25）
  marketCap: number // 占面积权重（新浪数据源实为成交额，东财为真实总市值）
}

export interface HeatmapIndustry {
  name: string
  /** 板块代码。东财为 BKxxxx；新浪 L2 为 hangye_Zxx，新浪聚合 L1 不填。 */
  code?: string
  totalMarketCap: number // 行业总市值或成交额之和
  weightedChange: number // 加权涨跌幅
  stocks: HeatmapStock[]
  /**
   * FR-119: 申万二级子行业列表（按 change 降序）
   * - 东财填充申万 L2，新浪填充 GB/T 中类，Tushare 可能为空
   * - 元素 code 为数据源 L2 代码，name 为 L2 中文名，marketCap 为 L2 总市值
   * - 前端 graphic 浮层据此渲染 L1 框内嵌的至多 4 块 L2（2 涨 + 2 跌）
   */
  subIndustries?: HeatmapStock[]
}

export interface MarketSnapshot {
  updatedAt: string // UTC ISO
  industries: HeatmapIndustry[]
}

export class EmptyDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmptyDataError'
  }
}

export async function fetchMarketSnapshot(): Promise<MarketSnapshot> {
  const provider = getMarketHeatmapProvider()
  let snap: MarketSnapshot
  if (provider === 'eastmoney') {
    snap = await fetchEastmoneySnapshot()
  } else if (provider === 'tushare') {
    const token = getTushareTokenOrThrow()
    snap = await fetchTushareSnapshot(token)
  } else {
    snap = await fetchSinaSnapshot()
  }
  return snap
}

/** 内部: 获取 Tushare token，未配置或未启用时抛 TUSHARE_DISABLED */
function getTushareTokenOrThrow(): string {
  const cfg = getDataSourceConfig(getDb())
  if (!cfg.tushareEnabled || !cfg.tushareTokenEncrypted) {
    throw new Error('TUSHARE_DISABLED')
  }
  const token = decryptApiKey(cfg.tushareTokenEncrypted)
  if (!token) throw new Error('TUSHARE_DISABLED')
  return token
}

/**
 * FR-114: 按需获取单个行业内的全部成分股（按涨跌幅降序）
 *
 * - 东财：调用 push2delay.eastmoney.com `fs=b:{industryCode}` 拉单板块成分股
 * - 新浪：仅允许 hangye_Zxx L2 代码调用按需成分接口；聚合 L1 不拼接多个 L2 请求
 *
 * 永远不抛错；上游失败时返回空数组，由前端保留行业级事实并允许稍后重试。
 */
export async function fetchIndustryConstituents(
  industryCode: string,
  industryName: string
): Promise<HeatmapStock[]> {
  const provider = getMarketHeatmapProvider()
  if (provider === 'eastmoney') {
    if (!industryCode) return []
    return fetchEastmoneyIndustryConstituents(industryCode)
  }
  if (provider === 'tushare') {
    if (!industryCode) return []
    try {
      const token = getTushareTokenOrThrow()
      return await fetchTushareIndustryConstituents(token, industryCode, industryName)
    } catch {
      return []
    }
  }
  // 新浪模式只读取单个 GB/T L2。L1 由多个 L2 聚合，不能在一次 hover 中扩散为多路请求。
  if (industryCode && industryCode.startsWith('hangye_')) {
    return fetchSinaIndustryConstituents(industryCode)
  }
  return []
}
