import type Database from 'better-sqlite3'
import { fetchStockPricesForPrompt } from './tushareService'
import {
  executeResearchFactTool,
  type ResearchPriceBar,
  type StockPriceHistoryData,
} from './researchFactToolRegistry'

const MAX_MARKET_BARS = 30
const MIN_MARKET_BARS = 10

export const ROUND2_MARKET_BLOCKED_MARKER = '<!-- round2-market-data-blocked -->'

export interface ArticleRound2MarketContext {
  status: 'ready' | 'partial' | 'blocked'
  markdown: string
  availableCodes: string[]
  missingCodes: string[]
  latestTradeDate: string | null
  refreshAttempted: boolean
}

function formatPrice(value: number | null): string {
  if (value == null) return '--'
  return Number(value.toFixed(3)).toString()
}

function formatPercent(value: number | null): string {
  if (value == null) return '--'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

function formatTradeDate(value: string): string {
  return /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : value
}

function movingAverage(rows: ResearchPriceBar[], count: number): number | null {
  if (rows.length < count) return null
  const window = rows.slice(-count)
  return window.reduce((sum, row) => sum + row.close, 0) / count
}

function closeReturn(rows: ResearchPriceBar[], interval: number): number | null {
  if (rows.length <= interval) return null
  const start = rows[rows.length - interval - 1].close
  const end = rows[rows.length - 1].close
  if (start <= 0) return null
  return ((end / start) - 1) * 100
}

function priceRange(rows: ResearchPriceBar[], count: number): { low: number; high: number } | null {
  if (rows.length < count) return null
  const window = rows.slice(-count)
  return {
    low: Math.min(...window.map((row) => row.low)),
    high: Math.max(...window.map((row) => row.high)),
  }
}

function buildStockSection(data: StockPriceHistoryData): string {
  const code = data.stockCode ?? '代码待核验'
  const rows = data.bars
  const name = data.stockName?.trim() || '名称待核验'
  const first = rows[0]
  const latest = rows[rows.length - 1]
  const previous = rows.length > 1 ? rows[rows.length - 2] : null
  const dayChange = previous && previous.close > 0
    ? ((latest.close / previous.close) - 1) * 100
    : null
  const range5 = priceRange(rows, 5)
  const range20 = priceRange(rows, 20)

  const tableRows = rows.map((row) => (
    `| ${formatTradeDate(row.tradeDate)} | ${formatPrice(row.open)} | ${formatPrice(row.high)} | ${formatPrice(row.low)} | ${formatPrice(row.close)} | ${row.volume == null ? '--' : formatPrice(row.volume)} |`
  )).join('\n')

  return `### ${code}｜${name}
- 样本：${formatTradeDate(first.tradeDate)} 至 ${formatTradeDate(latest.tradeDate)}，${rows.length} 个有效交易日
- 最新收盘：${formatPrice(latest.close)}；单日涨跌：${formatPercent(dayChange)}
- 区间收益：近5日 ${formatPercent(closeReturn(rows, 5))}；近20日 ${formatPercent(closeReturn(rows, 20))}
- 收盘均线：MA5 ${formatPrice(movingAverage(rows, 5))}；MA10 ${formatPrice(movingAverage(rows, 10))}；MA20 ${formatPrice(movingAverage(rows, 20))}
- 支撑观察参考：近5日最低价 ${formatPrice(range5?.low ?? null)}；近20日最低价 ${formatPrice(range20?.low ?? null)}
- 压力观察参考：近5日最高价 ${formatPrice(range5?.high ?? null)}；近20日最高价 ${formatPrice(range20?.high ?? null)}

| 日期 | 开盘 | 最高 | 最低 | 收盘 | 成交量(手) |
|---|---:|---:|---:|---:|---:|
${tableRows}`
}

export async function prepareArticleRound2MarketContext(
  db: Database.Database,
  stockCodes: string[],
  tushareToken: string | null,
): Promise<ArticleRound2MarketContext> {
  const codes = [...new Set(stockCodes.filter((code) => /^[036]\d{5}$/.test(code)))].slice(0, 5)
  const refreshAttempted = Boolean(tushareToken)

  if (tushareToken && codes.length > 0) {
    try {
      await fetchStockPricesForPrompt(db, tushareToken, codes)
    } catch (error) {
      console.warn('[AI Round2 Market] Tushare refresh failed, using local cache:', error instanceof Error ? error.message : String(error))
    }
  }

  const available: StockPriceHistoryData[] = []
  const missingCodes: string[] = []
  for (const code of codes) {
    const facts = executeResearchFactTool(db, 'stock.price_history', {
      stockCode: code,
      limit: MAX_MARKET_BARS,
      minBars: MIN_MARKET_BARS,
    })
    if (facts.status !== 'ready') {
      missingCodes.push(code)
      continue
    }
    available.push(facts.data)
  }

  if (available.length === 0) {
    return {
      status: 'blocked',
      markdown: '',
      availableCodes: [],
      missingCodes: codes,
      latestTradeDate: null,
      refreshAttempted,
    }
  }

  const latestTradeDate = available
    .map(({ bars }) => bars[bars.length - 1].tradeDate)
    .sort()
    .at(-1) ?? null
  const sourceDescription = refreshAttempted
    ? '本地全市场日线缓存 + 个股行情缓存；本轮已尝试通过 Tushare daily 增量更新'
    : '本地全市场日线缓存 + 个股行情缓存'
  const status = missingCodes.length === 0 ? 'ready' : 'partial'
  const missingNotice = missingCodes.length > 0
    ? `\n- 未满足最少10个有效交易日的候选：${missingCodes.join('、')}；不得为这些股票补写走势或价位。`
    : ''
  const sections = available.map((data) => buildStockSection(data))

  return {
    status,
    markdown: `## 行情数据边界
- 取数状态：${status === 'ready' ? '全部候选可复核' : '部分候选可复核'}
- 数据来源：${sourceDescription}
- 数据截止：${latestTradeDate ? formatTradeDate(latestTradeDate) : '--'}
- 样本口径：每只股票最多取最近${MAX_MARKET_BARS}个 OHLC 完整交易日，少于${MIN_MARKET_BARS}日视为不足。
- 技术位口径：支撑参考仅为近5/20日最低价，压力参考仅为近5/20日最高价；均为观察区间边界，不是预测目标、止损位或交易指令。${missingNotice}

${sections.join('\n\n')}`,
    availableCodes: available.map(({ stockCode }) => stockCode).filter((code): code is string => code != null),
    missingCodes,
    latestTradeDate,
    refreshAttempted,
  }
}

export function buildRound2MarketBlockedResponse(context: ArticleRound2MarketContext): string {
  const codes = context.missingCodes.length > 0 ? context.missingCodes.join('、') : '本轮候选'
  return `## 第二轮行情复核受阻

本轮没有为 ${codes} 取得至少 ${MIN_MARKET_BARS} 个 OHLC 完整交易日，因此未调用 AI 生成走势、支撑位或压力位结论，避免用模型记忆补齐真实行情。

- 已检查：本地全市场日线缓存、个股行情缓存${context.refreshAttempted ? '，并已尝试 Tushare 增量更新' : ''}
- 影响：第一轮新闻与公司映射仍然保留，但尚未完成真实行情复核
- 恢复动作：补齐近期日线数据后，点击“重新用近期行情复核”

${ROUND2_MARKET_BLOCKED_MARKER}`
}
