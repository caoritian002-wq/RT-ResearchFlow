type DecisionSignalStatus = 'NEW' | 'READ' | 'WATCHING' | 'DISMISSED' | 'EXPIRED'

type DecisionSignalType = 'ALERT' | 'OPPORTUNITY' | 'RISK' | 'INFO'

type DecisionSignalDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL'

type DecisionSignalResolution =
  | 'RESOLVED_VALID'
  | 'RESOLVED_INVALID'
  | 'RESOLVED_MISSED'
  | 'RESOLVED_DUPLICATE'
  | 'RESOLVED_DATA_ISSUE'
  | 'RESOLVED_MANUAL'

export interface DecisionSignalItem {
  id: number
  sourceModule: string
  strategyKey: string
  tsCode: string | null
  stockName: string | null
  conceptCode: string | null
  conceptName: string | null
  signalType: DecisionSignalType
  direction: DecisionSignalDirection
  priority: number
  score: number | null
  confidence: number | null
  title: string
  summary: string
  reasonJson: string | null
  sourceRefJson: string | null
  status: DecisionSignalStatus
  signalTime: number
  firstSeenAt?: number | null
  lastSeenAt?: number | null
  occurrenceCount?: number
  acknowledgedAt?: number | null
  watchedAt?: number | null
  dismissedAt?: number | null
  resolvedAt?: number | null
  resolution?: DecisionSignalResolution | null
  resolutionNote?: string | null
}

interface SignalCardProps {
  signal: DecisionSignalItem
  onRead: (id: number) => void
  onWatch: (id: number) => void
  onDismiss: (id: number) => void
  onNavigateStock?: (signal: DecisionSignalItem) => void
  /** FR-171: 产业链传导分析，仅 news 来源且优先级 ≥4 时显示 */
  onChainAnalysis?: (text: string) => void
  onLifecycle?: (signal: DecisionSignalItem) => void
  onDiscuss?: (signal: DecisionSignalItem) => void
  /** FR-232: 默认「事件明细」; 组合语境可传「研判」 */
  lifecycleLabel?: string
}

const TYPE_LABEL: Record<DecisionSignalType, string> = {
  ALERT: '预警',
  OPPORTUNITY: '机会',
  RISK: '风险',
  INFO: '信息',
}

const SOURCE_LABEL: Record<string, string> = {
  news: '资讯',
  ai: 'AI',
  short_term: '短线',
  trend: '趋势',
  market: '大盘',
  sector_flow: '板块',
  manual: '手动',
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function directionClass(direction: DecisionSignalDirection): string {
  if (direction === 'BULLISH') return 'text-red-600 dark:text-red-400'
  if (direction === 'BEARISH') return 'text-green-600 dark:text-green-400'
  return 'text-gray-500 dark:text-gray-400'
}

function hasPortfolioMarker(signal: DecisionSignalItem): boolean {
  const parse = (raw: string | null): boolean => {
    if (!raw) return false
    try {
      const obj = JSON.parse(raw) as { isPortfolio?: unknown }
      return obj.isPortfolio === true
    } catch {
      return false
    }
  }
  return parse(signal.reasonJson) || parse(signal.sourceRefJson)
}

function parseSignalJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

function mergedContext(signal: DecisionSignalItem): Record<string, unknown> {
  return {
    ...(parseSignalJson(signal.sourceRefJson) ?? {}),
    ...(parseSignalJson(signal.reasonJson) ?? {})
  }
}

function importanceReasons(signal: DecisionSignalItem, isPortfolio: boolean): string[] {
  const reasons: string[] = []
  if (signal.priority >= 5) reasons.push('P5 高优先级')
  else if (signal.priority >= 4) reasons.push('高优先级')
  if (isPortfolio) reasons.push('持仓相关')
  if (signal.signalType === 'RISK' || signal.direction === 'BEARISH') reasons.push('风险信号')
  if (signal.status === 'NEW') reasons.push('未读')
  if (signal.status === 'WATCHING') reasons.push('关注中')
  if ((signal.occurrenceCount ?? 1) > 1) reasons.push(`重复触发 ${signal.occurrenceCount} 次`)
  if (signal.confidence != null) reasons.push(`置信度 ${signal.confidence.toFixed(0)}%`)
  return reasons.slice(0, 4)
}

function trustHint(signal: DecisionSignalItem): string {
  if (signal.sourceModule === 'ai') return 'AI 预测需要结合走势、成交量和回测记录复核。'
  if (signal.sourceModule === 'news') return '资讯影响需要确认事件持续性和产业链传导强度。'
  if (signal.sourceModule === 'short_term') return '短线策略信号更依赖流动性和盘中执行窗口。'
  if (signal.sourceModule === 'trend') return '趋势预警适合作为复盘入口, 不等同于交易指令。'
  if (signal.sourceModule === 'sector_flow') return '板块主力资金来自东方财富，仍需用次日竞价与核心股走势确认是否延续。'
  if (signal.sourceModule === 'market') return '市场状态用于判断环境, 不直接替代单股判断。'
  return '该信号仅作为辅助线索, 需要结合行情和个人风险约束复核。'
}

function contextGaps(signal: DecisionSignalItem, isPortfolio: boolean): string[] {
  const context = mergedContext(signal)
  const gaps: string[] = []
  if (isPortfolio && typeof context.costPrice !== 'number') gaps.push('缺少成本价')
  if (signal.sourceModule === 'ai' && signal.confidence == null) gaps.push('缺少置信度')
  if (signal.sourceModule === 'ai' && !('backtestMape' in context) && !('backtestDirection' in context)) gaps.push('缺少回测摘要')
  if (signal.sourceModule === 'news' && !signal.tsCode && !signal.conceptName) gaps.push('缺少映射对象')
  if (signal.sourceModule === 'trend' && signal.tsCode && typeof context.triggerPrice !== 'number') gaps.push('缺少触发价')
  return gaps.slice(0, 3)
}

interface PortfolioSignalContext {
  costPrice: number | null
  profitPct: number | null
  positionAdvice: 'HOLD' | 'WATCH' | 'TAKE_PROFIT' | 'STOP_LOSS' | null
  positionAdviceReason: string | null
  triggerPrice: number | null
}

function parsePortfolioContext(signal: DecisionSignalItem): PortfolioSignalContext | null {
  const parse = (raw: string | null): Partial<PortfolioSignalContext> | null => {
    if (!raw) return null
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>
      if (obj.isPortfolio !== true) return null
      return {
        costPrice: typeof obj.costPrice === 'number' ? obj.costPrice : null,
        profitPct: typeof obj.profitPct === 'number' ? obj.profitPct : null,
        positionAdvice: isAdvice(obj.positionAdvice) ? obj.positionAdvice : null,
        positionAdviceReason: typeof obj.positionAdviceReason === 'string' ? obj.positionAdviceReason : null,
        triggerPrice: typeof obj.triggerPrice === 'number' ? obj.triggerPrice : null,
      }
    } catch {
      return null
    }
  }
  const reason = parse(signal.reasonJson)
  const sourceRef = parse(signal.sourceRefJson)
  if (!reason && !sourceRef) return null
  return {
    costPrice: reason?.costPrice ?? sourceRef?.costPrice ?? null,
    profitPct: reason?.profitPct ?? sourceRef?.profitPct ?? null,
    positionAdvice: reason?.positionAdvice ?? sourceRef?.positionAdvice ?? null,
    positionAdviceReason: reason?.positionAdviceReason ?? sourceRef?.positionAdviceReason ?? null,
    triggerPrice: reason?.triggerPrice ?? sourceRef?.triggerPrice ?? null,
  }
}

function isAdvice(value: unknown): value is NonNullable<PortfolioSignalContext['positionAdvice']> {
  return value === 'HOLD' || value === 'WATCH' || value === 'TAKE_PROFIT' || value === 'STOP_LOSS'
}

function formatPrice(value: number | null): string {
  return value == null ? '--' : value.toFixed(2)
}

function formatProfitPct(value: number | null): string {
  if (value == null) return '--'
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`
}

function profitClass(value: number | null): string {
  if (value == null) return 'text-gray-500 dark:text-gray-400'
  if (value > 0) return 'text-red-600 dark:text-red-400'
  if (value < 0) return 'text-green-600 dark:text-green-400'
  return 'text-gray-500 dark:text-gray-400'
}

function adviceLabel(advice: PortfolioSignalContext['positionAdvice']): string {
  if (advice === 'HOLD') return '继续持有'
  if (advice === 'WATCH') return '观察'
  if (advice === 'TAKE_PROFIT') return '止盈'
  if (advice === 'STOP_LOSS') return '止损'
  return '--'
}

function adviceClass(advice: PortfolioSignalContext['positionAdvice']): string {
  if (advice === 'STOP_LOSS') return 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300'
  if (advice === 'TAKE_PROFIT') return 'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-900/20 dark:text-orange-300'
  if (advice === 'HOLD') return 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300'
  return 'border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300'
}

function resolutionLabel(resolution: DecisionSignalResolution | null | undefined): string | null {
  if (resolution === 'RESOLVED_VALID') return '已处理'
  if (resolution === 'RESOLVED_INVALID') return '无效'
  if (resolution === 'RESOLVED_MISSED') return '错过'
  if (resolution === 'RESOLVED_DUPLICATE') return '重复'
  if (resolution === 'RESOLVED_DATA_ISSUE') return '数据问题'
  if (resolution === 'RESOLVED_MANUAL') return '人工关闭'
  return null
}

export function SignalCard({ signal, onRead, onWatch, onDismiss, onNavigateStock, onChainAnalysis, onLifecycle, onDiscuss, lifecycleLabel = '事件明细' }: SignalCardProps) {
  const isNew = signal.status === 'NEW'
  const isPortfolio = hasPortfolioMarker(signal)
  const portfolioContext = signal.sourceModule === 'trend' ? parsePortfolioContext(signal) : null
  const resolvedLabel = resolutionLabel(signal.resolution)
  const reasons = importanceReasons(signal, isPortfolio)
  const gaps = contextGaps(signal, isPortfolio)
  return (
    <div className={[
      'grid gap-3 rounded-lg border bg-white p-3 transition-colors dark:bg-slate-900 lg:grid-cols-[92px_minmax(0,1fr)_150px]',
      signal.priority >= 5 ? 'border-l-4 border-l-red-500 border-slate-200 dark:border-slate-700 dark:border-l-red-500' : isRiskSignalLike(signal) ? 'border-l-4 border-l-emerald-600 border-slate-200 dark:border-slate-700 dark:border-l-emerald-500' : isNew ? 'border-blue-200 dark:border-blue-800' : 'border-slate-200 dark:border-slate-700'
    ].join(' ')}>
      <div className="source min-w-0 text-xs text-slate-500 dark:text-slate-400">
        <div className="font-semibold text-slate-900 dark:text-slate-100">{SOURCE_LABEL[signal.sourceModule] ?? signal.sourceModule}</div>
        <div className="mt-1">P{signal.priority} / {TYPE_LABEL[signal.signalType]}</div>
        <div className={`mt-1 font-medium ${directionClass(signal.direction)}`}>{signal.direction === 'BULLISH' ? '偏多' : signal.direction === 'BEARISH' ? '偏空' : '中性'}</div>
        {(signal.occurrenceCount ?? 1) > 1 && <div className="mt-1 text-blue-600 dark:text-blue-300">重复触发 {signal.occurrenceCount} 次</div>}
        <div className="mt-1 text-slate-400 dark:text-slate-500">{formatTime(signal.signalTime)}</div>
        <div className="mt-2 flex flex-wrap gap-1">
          {isPortfolio && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-200">持仓</span>}
          {signal.status === 'WATCHING' && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">关注</span>}
          {resolvedLabel && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">{resolvedLabel}</span>}
        </div>
      </div>

      <div className="min-w-0">
        <h3 className="line-clamp-2 text-[15px] font-extrabold leading-5 text-slate-950 dark:text-slate-100">{signal.title}</h3>
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500 dark:text-slate-400">{signal.summary}</p>
          {portfolioContext && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-amber-100 bg-amber-50 px-2 py-1.5 text-xs dark:border-amber-900/60 dark:bg-amber-950/30">
              <span className="text-gray-600 dark:text-gray-300">成本价 {formatPrice(portfolioContext.costPrice)}</span>
              <span className="text-gray-600 dark:text-gray-300">触发价 {formatPrice(portfolioContext.triggerPrice)}</span>
              <span className={profitClass(portfolioContext.profitPct)}>浮盈亏 {formatProfitPct(portfolioContext.profitPct)}</span>
              <span
                title={portfolioContext.positionAdviceReason ?? undefined}
                className={`rounded border px-1.5 py-0.5 font-medium ${adviceClass(portfolioContext.positionAdvice)}`}
              >{adviceLabel(portfolioContext.positionAdvice)}</span>
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500 dark:text-slate-400">
            {signal.score != null && <span>评分 {signal.score.toFixed(0)}</span>}
            {signal.confidence != null && <span>置信度 {signal.confidence.toFixed(0)}%</span>}
            <span>{signal.strategyKey}</span>
          </div>
          <div data-testid="decision-signal-why" className="mt-2 rounded-md bg-slate-50 px-2 py-1.5 text-xs leading-5 text-slate-600 dark:bg-slate-950/40 dark:text-slate-300">
            <span className="font-medium">为什么重要：</span>{reasons.length > 0 ? reasons.join(' / ') : '作为辅助线索进入今日看板'}。{trustHint(signal)}
          </div>
          {gaps.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {gaps.map(gap => <span key={gap} className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">需要补充验证：{gap}</span>)}
            </div>
          )}
          {resolvedLabel && (
            <div className="mt-2 rounded border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-xs text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300">
              已完成复盘：{resolvedLabel}{signal.resolutionNote ? ` · ${signal.resolutionNote}` : ''}
            </div>
          )}
      </div>

      <div className="flex flex-col items-start gap-2 text-xs text-slate-500 dark:text-slate-400 lg:items-end">
        {signal.tsCode ? (
          <button onClick={() => onNavigateStock?.(signal)} className="font-semibold text-blue-700 hover:underline dark:text-blue-300">
            {signal.stockName || signal.tsCode}
          </button>
        ) : signal.conceptName ? (
          <span className="font-semibold text-blue-700 dark:text-blue-300">{signal.conceptName}</span>
        ) : null}
        <div className="flex flex-wrap gap-1.5 lg:justify-end">
          {signal.status === 'NEW' && (
            <button onClick={() => onRead(signal.id)} className="px-2 py-1 text-xs rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800">已读</button>
          )}
          <button onClick={() => onWatch(signal.id)} className="px-2 py-1 text-xs rounded border border-amber-200 text-amber-700 dark:border-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/20">关注</button>
          {onLifecycle && (
            <button onClick={() => onLifecycle(signal)} className="px-2 py-1 text-xs rounded border border-blue-200 text-blue-700 dark:border-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/20">{lifecycleLabel}</button>
          )}
          {onDiscuss && (
            <button type="button" data-testid={`decision-signal-discuss-${signal.id}`} onClick={() => onDiscuss(signal)} className="rounded border border-cyan-200 px-2 py-1 text-xs text-cyan-700 hover:bg-cyan-50 dark:border-cyan-800 dark:text-cyan-300 dark:hover:bg-cyan-950/30">讨论</button>
          )}
          <button onClick={() => onDismiss(signal.id)} className="px-2 py-1 text-xs rounded border border-gray-200 text-gray-500 dark:border-gray-700 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800">忽略</button>
          {onChainAnalysis && signal.sourceModule === 'news' && (signal.priority ?? 0) >= 4 && (
            <button
              onClick={() => onChainAnalysis(`${signal.title} ${signal.summary ?? ''}`.trim())}
              className="px-2 py-1 text-xs rounded border border-teal-200 text-teal-700 dark:border-teal-700 dark:text-teal-300 hover:bg-teal-50 dark:hover:bg-teal-900/20"
              title="产业分析"
            >产业分析</button>
          )}
        </div>
      </div>
    </div>
  )
}

function isRiskSignalLike(signal: DecisionSignalItem): boolean {
  return signal.signalType === 'RISK' || signal.direction === 'BEARISH'
}
