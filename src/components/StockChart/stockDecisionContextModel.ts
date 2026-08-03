import type { StockNavigationContext } from '../../store/appStore'

export interface StockDecisionContextInput {
  stockCode: string
  stockName: string
  navigationContext: StockNavigationContext | null
  isPortfolio: boolean
  costPrice: number | null
  hasForecastToday: boolean
  hasForecastMorrow: boolean
  hasChips: boolean
  hasFactor: boolean
  latestClose: number | null
  latestPctChg: number | null
  tradeDate: string | null
}

export interface StockDecisionContextModel {
  hasSignalContext: boolean
  title: string
  subtitle: string
  badges: Array<{ label: string; tone: 'red' | 'green' | 'amber' | 'blue' | 'slate' }>
  reason: string
  trustHint: string
  gaps: string[]
  evidence: Array<{ label: string; value: string; tone: 'good' | 'warn' | 'neutral' }>
  primaryActionLabel: string
  signalStatus: string | null
  canHandleSignal: boolean
  canEditCostPrice: boolean
  costPrice: number | null
  profitPct: number | null
}

function parseJson(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

function mergedSignalContext(context: StockNavigationContext | null): Record<string, unknown> {
  if (!context) return {}
  return {
    ...(parseJson(context.sourceRefJson) ?? {}),
    ...(parseJson(context.reasonJson) ?? {})
  }
}

function sourceLabel(sourceModule: string): string {
  return {
    news: '资讯',
    ai: 'AI',
    short_term: '短线策略',
    trend: '趋势',
    market: '市场',
    sector_flow: '板块资金',
    manual: '手动'
  }[sourceModule] ?? sourceModule
}

function directionLabel(direction: string): string {
  if (direction === 'BULLISH') return '偏多'
  if (direction === 'BEARISH') return '偏空'
  return '中性'
}

function typeLabel(type: string): string {
  if (type === 'ALERT') return '预警'
  if (type === 'OPPORTUNITY') return '机会'
  if (type === 'RISK') return '风险'
  return '信息'
}

function formatPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '--'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function formatPrice(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '--'
  return value.toFixed(2)
}

function statusLabel(status: string | null | undefined): string {
  if (status === 'NEW') return '待处理'
  if (status === 'READ') return '已读'
  if (status === 'WATCHING') return '关注中'
  if (status === 'DISMISSED') return '已忽略'
  if (status === 'EXPIRED') return '已过期'
  return '待确认'
}

function buildTrustHint(context: StockNavigationContext | null): string {
  if (!context) return '当前为普通走势图视角, 可结合行情、预测、持仓和技术因子形成单股判断。'
  if (context.sourceModule === 'ai') return 'AI 预测需要结合实际走势、成交量和回测表现复核。'
  if (context.sourceModule === 'news') return '资讯影响需要继续确认事件持续性、产业链传导和个股实际反应。'
  if (context.sourceModule === 'short_term') return '短线信号更依赖流动性和盘中执行窗口, 需要先看分时与成交。'
  if (context.sourceModule === 'trend') return '趋势预警适合作为复盘入口, 需要结合成本价、触发价和中期结构判断。'
  if (context.sourceModule === 'sector_flow') return '板块主力资金来自东方财富，需要落到次日竞价、成分股走势和量能继续验证。'
  return '该信号只作为辅助线索, 不替代个人风险约束和复核。'
}

export function buildStockDecisionContextModel(input: StockDecisionContextInput): StockDecisionContextModel {
  const context = input.navigationContext
  const signalContext = mergedSignalContext(context)
  const gaps: string[] = []
  const profitPct = input.costPrice != null && input.costPrice > 0 && input.latestClose != null
    ? ((input.latestClose - input.costPrice) / input.costPrice) * 100
    : null

  if (!input.isPortfolio) gaps.push('未加入持仓, 无法结合成本价复盘')
  if (input.isPortfolio && input.costPrice == null) gaps.push('持仓缺少成本价')
  if (!input.hasForecastToday && !input.hasForecastMorrow) gaps.push('暂无 AI 预测记录')
  if (!input.hasChips) gaps.push('暂无筹码数据')
  if (!input.hasFactor) gaps.push('暂无技术因子')
  if (context?.sourceModule === 'trend' && typeof signalContext.triggerPrice !== 'number') gaps.push('原趋势信号缺少触发价')
  if (context?.sourceModule === 'ai' && context.confidence == null) gaps.push('原 AI 信号缺少置信度')

  const evidence: StockDecisionContextModel['evidence'] = [
    { label: '最新收盘', value: formatPrice(input.latestClose), tone: input.latestClose == null ? 'warn' : 'neutral' },
    { label: '最新涨跌', value: formatPct(input.latestPctChg), tone: input.latestPctChg == null ? 'warn' : input.latestPctChg >= 0 ? 'good' : 'neutral' },
    { label: '持仓状态', value: input.isPortfolio ? '已加入持仓' : '未加入持仓', tone: input.isPortfolio ? 'good' : 'warn' },
    { label: '成本/浮盈', value: input.isPortfolio ? `${formatPrice(input.costPrice)} / ${formatPct(profitPct)}` : '--', tone: input.isPortfolio && input.costPrice == null ? 'warn' : profitPct != null && profitPct >= 0 ? 'good' : 'neutral' },
    { label: 'AI 预测', value: input.hasForecastToday || input.hasForecastMorrow ? '已有记录' : '暂无记录', tone: input.hasForecastToday || input.hasForecastMorrow ? 'good' : 'warn' },
    { label: '筹码/因子', value: `${input.hasChips ? '筹码' : '缺筹码'} / ${input.hasFactor ? '因子' : '缺因子'}`, tone: input.hasChips && input.hasFactor ? 'good' : 'warn' }
  ]

  if (!context) {
    return {
      hasSignalContext: false,
      title: `${input.stockName} 单股研判`,
      subtitle: input.tradeDate ? `行情日期 ${input.tradeDate}` : '等待行情数据',
      badges: [{ label: '普通查看', tone: 'slate' }],
      reason: '当前未携带今日看板信号, 可从行情、预测、筹码和技术因子开始复核。',
      trustHint: buildTrustHint(null),
      gaps: gaps.slice(0, 4),
      evidence,
      primaryActionLabel: input.hasForecastToday || input.hasForecastMorrow ? '查看预测记录' : '发起 AI 预测',
      signalStatus: null,
      canHandleSignal: false,
      canEditCostPrice: input.isPortfolio,
      costPrice: input.costPrice,
      profitPct
    }
  }

  const badges: StockDecisionContextModel['badges'] = [
    { label: `P${context.priority}`, tone: context.priority >= 5 ? 'red' : context.priority >= 4 ? 'amber' : 'blue' },
    { label: sourceLabel(context.sourceModule), tone: 'blue' },
    { label: typeLabel(context.signalType), tone: context.signalType === 'RISK' ? 'green' : 'slate' },
    { label: directionLabel(context.direction), tone: context.direction === 'BEARISH' ? 'green' : context.direction === 'BULLISH' ? 'red' : 'slate' },
    { label: statusLabel(context.status), tone: context.status === 'WATCHING' ? 'amber' : context.status === 'DISMISSED' ? 'slate' : 'blue' }
  ]
  if (context.confidence != null) badges.push({ label: `置信度 ${context.confidence.toFixed(0)}%`, tone: 'blue' })
  if ((context.occurrenceCount ?? 1) > 1) badges.push({ label: `触发 ${context.occurrenceCount} 次`, tone: 'amber' })

  return {
    hasSignalContext: true,
    title: context.title,
    subtitle: `来自今日看板 · ${sourceLabel(context.sourceModule)} · ${input.stockName}`,
    badges,
    reason: context.summary || '该股票由今日看板信号带入, 需要结合行情和个人持仓继续判断。',
    trustHint: buildTrustHint(context),
    gaps: gaps.slice(0, 4),
    evidence,
    primaryActionLabel: input.hasForecastToday || input.hasForecastMorrow ? '查看预测记录' : '发起 AI 预测',
    signalStatus: context.status ?? null,
    canHandleSignal: context.status !== 'DISMISSED' && context.status !== 'EXPIRED',
    canEditCostPrice: input.isPortfolio,
    costPrice: input.costPrice,
    profitPct
  }
}
