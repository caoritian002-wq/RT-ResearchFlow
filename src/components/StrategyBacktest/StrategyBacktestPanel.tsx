import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getBeijingDateValue,
  ResearchCombobox,
  ResearchDatePicker,
} from '../IndustryResearch/ResearchDecisionControls'
import InfoTip from '../shared/InfoTip'
import { BacktestDeleteDialog } from './BacktestDeleteDialog'
import { BacktestEquityChart } from './BacktestEquityChart'
import { BacktestCredibilityBand, type BacktestCredibilityAssessmentView } from './BacktestCredibilityBand'
import { StrategyEffectivenessWorkbench } from './StrategyEffectivenessWorkbench'

type EntryRule = 'nextOpen' | 'signalClose'
type SignalSource = 'shortTerm' | 'trendAlerts' | 'decisionSignals'
type TrustStatus = 'reliable' | 'degraded' | 'blocked'
type TrustReason =
  | 'NO_SIGNALS'
  | 'NO_VALID_TRADES'
  | 'UNADJUSTED_PRICES'
  | 'TRADING_CALENDAR_NOT_ENFORCED'
  | 'LIMIT_RULES_NOT_ENFORCED'
  | 'APPROXIMATE_DRAWDOWN'
  | 'REALIZED_EQUITY_ONLY'
  | 'OVERLAPPING_POSITIONS_NOT_CAPITAL_ALLOCATED'
  | 'SHARPE_NOT_ANNUALIZED'
  | 'DATA_QUALITY_DEGRADED'
  | 'DATA_QUALITY_BLOCKED'
  | 'TEMPORAL_ORDER_VIOLATION'
  | 'SAME_DAY_CLOSE_ENTRY'
  | 'SAMPLE_SIZE_LOW'
  | 'SIGNAL_DATE_CONCENTRATED'
  | 'DROP_RATE_HIGH'
  | 'PERIOD_DIRECTION_UNSTABLE'
  | 'OUT_OF_SAMPLE_NOT_VALIDATED'
  | 'LEGACY_REPORT'

type EquityModel = 'equal_weighted_exit_day_compound'

interface TradePlan {
  entryRule: EntryRule
  holdDays: number
  stopProfit: number | null
  stopLoss: number | null
  feeBps: number
}

interface BacktestReport {
  schemaVersion: 1 | 2 | 3 | 4
  generatedAt: number
  trust: {
    status: TrustStatus
    reasons: TrustReason[]
    engineVersion: string
    factFingerprint: string
    credibility?: BacktestCredibilityAssessmentView
  }
  strategyKey: string
  signalSource?: SignalSource
  dateRange: { start: string; end: string }
  plan: TradePlan
  totalSignals: number
  validTrades: number
  dropRate: number | null
  winRate: number | null
  avgReturn: number | null
  medianReturn: number | null
  profitFactor: number | null
  expectancy: number | null
  equityModel: EquityModel
  totalReturn: number | null
  equityCurve: Array<{
    date: string
    realizedReturnPct: number
    tradeCount: number
    equity: number
    drawdownPct: number
  }> | null
  maxDrawdown: number | null
  sharpeLike: number | null
  byStrengthDecile: Array<{
    bucket: number
    minStrength: number
    maxStrength: number
    count: number
    winRate: number | null
    avgReturn: number | null
    medianReturn: number | null
    profitFactor: number | null
    expectancy: number | null
  }> | null
  benchmarkReturn: number | null
  excessReturn?: number | null
  benchmarkNote?: string | null
}

interface RunSummary {
  id: number
  strategyKey: string
  signalSource?: SignalSource
  dateStart: string
  dateEnd: string
  plan: TradePlan
  status: 'completed' | 'failed'
  trustStatus: TrustStatus
  errorMessage: string | null
  createdAt: number
}

interface TradeRow {
  runId: number
  strategyKey: string
  tsCode: string
  stockName?: string | null
  signalDate: string
  entryDate: string | null
  entryPrice: number | null
  exitDate: string | null
  exitPrice: number | null
  grossReturnPct: number | null
  netReturnPct: number | null
  returnPct: number | null
  exitReason: string | null
  status: 'executed' | 'data_insufficient'
  strength: number | null
}

interface BacktestProgress {
  stage: 'cache' | 'signals' | 'prices' | 'trades' | 'benchmark' | 'save' | 'done' | 'failed'
  current: number
  total: number
  message: string
}

const SIGNAL_SOURCE_OPTIONS: Array<{ key: SignalSource; label: string; hint: string }> = [
  { key: 'shortTerm', label: '策略信号库', hint: '竞价、短线与实验室信号' },
  { key: 'trendAlerts', label: '趋势预警', hint: '趋势信号' },
  { key: 'decisionSignals', label: '今日看板', hint: '决策信号' },
]

const STRATEGY_OPTIONS: Record<SignalSource, Array<{ key: string; label: string }>> = {
  shortTerm: [
    { key: 'shortTerm.*', label: '短线模块全部信号' },
    { key: 'shortTerm.limitBoardMonitor', label: '涨停封板质量' },
    { key: 'shortTerm.secondBoardLeader', label: '连板梯队与题材竞争' },
    { key: 'shortTerm.closingHalfHour', label: '尾盘主动行为' },
    { key: 'shortTerm.firstYinDip', label: '首阴回踩修复' },
    { key: 'shortTerm.dipBuy.trend', label: '趋势低吸' },
    { key: 'shortTerm.dipBuy.arbitrage', label: '冰点套利低吸' },
    { key: 'shortTerm.dipBuy.rotation', label: '题材轮动低吸' },
    { key: 'auction.threeOne', label: '板票竞价双第一' },
    { key: 'auction.firstBoard', label: '首板竞价' },
    { key: 'auction.secondBoard', label: '二板及以上竞价' },
    { key: 'auction.brokenBoard', label: '炸板封回竞价' },
    { key: 'auction.brokenConsec', label: '断板竞价' },
    { key: 'auction.allMarket', label: '竞价全市场异动' },
    { key: 'strategyLab.*', label: '策略实验室全部信号' },
    { key: 'strategyLab.builtin-screener', label: '个性选股' },
    { key: 'strategyLab.builtin-condition-blocks', label: '条件积木命中' },
  ],
  trendAlerts: [
    { key: 'trend.*', label: '全部趋势预警' },
    { key: 'BREAK_MA60', label: '突破 MA60' },
    { key: 'BREAK_HIGH20', label: '创 20 日新高' },
    { key: 'STOP_LOSS_5PCT', label: '跌破 5% 风险线' },
  ],
  decisionSignals: [
    { key: 'decision.*', label: '今日看板全部股票信号' },
    { key: 'morningAuction.allMarket', label: '早盘集合竞价全市场异动' },
    { key: 'trend.*', label: '今日看板趋势类信号' },
    { key: 'shortTerm.*', label: '今日看板短线类信号' },
    { key: 'market.*', label: '今日看板市场类信号' },
  ],
}

function todayYmd(): string {
  const now = new Date()
  const bj = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60_000)
  return `${bj.getFullYear()}${String(bj.getMonth() + 1).padStart(2, '0')}${String(bj.getDate()).padStart(2, '0')}`
}

function offsetYmd(days: number): string {
  const now = new Date()
  const bj = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60_000)
  bj.setDate(bj.getDate() + days)
  return `${bj.getFullYear()}${String(bj.getMonth() + 1).padStart(2, '0')}${String(bj.getDate()).padStart(2, '0')}`
}

function ymdToDash(value: string): string {
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : ''
}

function dashToYmd(value: string): string {
  return value.replace(/-/g, '')
}

function fmtPct(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function fmtAbsPct(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${Math.abs(value).toFixed(digits)}%`
}

function fmtNum(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return value.toFixed(digits)
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return '—'
  return /^\d{8}$/.test(value) ? `${value.slice(4, 6)}/${value.slice(6, 8)}` : value
}

function fmtGeneratedAt(value: number): string {
  return value > 0 ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '历史报告未记录'
}

const TRUST_REASON_LABELS: Record<TrustReason, string> = {
  NO_SIGNALS: '所选范围没有可回测信号',
  NO_VALID_TRADES: '没有可完成撮合的有效交易',
  UNADJUSTED_PRICES: '行情未做复权处理',
  TRADING_CALENDAR_NOT_ENFORCED: '持有期按个股现有日线推进, 未使用统一交易日历',
  LIMIT_RULES_NOT_ENFORCED: '未模拟涨跌停、停牌与成交可得性',
  APPROXIMATE_DRAWDOWN: '最大回撤使用等额累积单仓近似',
  REALIZED_EQUITY_ONLY: '权益曲线只在交易出场日确认已实现收益',
  OVERLAPPING_POSITIONS_NOT_CAPITAL_ALLOCATED: '重叠持仓未模拟资金占用和仓位分配',
  SHARPE_NOT_ANNUALIZED: '风险调整指标不是正式年化 Sharpe',
  DATA_QUALITY_DEGRADED: '本地日线、交易日历或核心基准存在质量提醒',
  DATA_QUALITY_BLOCKED: '关键本地数据被质量中心标记为阻断',
  TEMPORAL_ORDER_VIOLATION: '发现信号、入场或出场时间顺序异常',
  SAME_DAY_CLOSE_ENTRY: '同日收盘入场属于较乐观的理论假设',
  SAMPLE_SIZE_LOW: '有效样本少于30笔',
  SIGNAL_DATE_CONCENTRATED: '有效样本分布不足10个信号日',
  DROP_RATE_HIGH: '缺失或剔除率高于20%',
  PERIOD_DIRECTION_UNSTABLE: '前后半区间平均收益方向相反',
  OUT_OF_SAMPLE_NOT_VALIDATED: '尚未完成滚动窗口和样本外验证',
  LEGACY_REPORT: '历史报告缺少引擎版本和事实指纹',
}

function trustLabel(status: TrustStatus): string {
  if (status === 'blocked') return '已阻断'
  if (status === 'reliable') return '可信'
  return '降级可用'
}

function returnColor(value: number | null | undefined): string {
  if (value == null) return 'text-slate-400 dark:text-slate-500'
  if (value > 0) return 'text-red-600 dark:text-red-300'
  if (value < 0) return 'text-emerald-600 dark:text-emerald-300'
  return 'text-slate-500 dark:text-slate-400'
}

function statusLabel(status: TradeRow['status']): string {
  return status === 'executed' ? '已成交' : '数据不足'
}

function exitReasonLabel(reason: string | null): string {
  if (reason === 'hold_expired') return '持有到期'
  if (reason === 'stop_profit') return '止盈'
  if (reason === 'stop_loss') return '止损'
  if (reason === 'data_insufficient') return '数据不足'
  return reason ?? '—'
}

function progressPct(progress: BacktestProgress | null): number {
  if (!progress || progress.total <= 0) return 0
  if (progress.stage === 'done' || progress.stage === 'failed') return 100
  return Math.max(5, Math.min(98, Math.round(progress.current / progress.total * 100)))
}

function strategyLabel(source: SignalSource, key: string): string {
  const legacyLabels: Record<string, string> = {
    'shortTerm.limitBoardMonitor': '涨停板监控',
    'shortTerm.secondBoardLeader': '连板梯队与题材竞争',
    'shortTerm.closingHalfHour': '尾盘主动行为',
    'shortTerm.firstYinDip': '首阴回踩修复',
    'shortTerm.dipBuy.trend': '趋势低吸',
    'shortTerm.dipBuy.arbitrage': '冰点套利低吸',
    'shortTerm.dipBuy.rotation': '题材轮动低吸',
    'shortTerm.morningAuction': '早盘集合竞价',
    'shortTerm.personalScreener': '个性选股',
    'shortTerm.conditionBlocks': '条件积木命中',
  }
  return STRATEGY_OPTIONS[source].find((option) => option.key === key)?.label ?? legacyLabels[key] ?? '历史策略'
}

function blockedReportMessage(report: BacktestReport): string | null {
  if (report.trust.reasons.includes('NO_SIGNALS')) {
    return '所选日期内没有匹配到已保存的策略信号。日期范围筛选的是信号发生日，请检查策略和信号日期。'
  }
  if (report.trust.reasons.includes('NO_VALID_TRADES')) {
    return `已找到 ${report.totalSignals} 条信号，但还没有可完成撮合的交易。临近今天的信号需要等待 T+1 入场、${report.plan.holdDays} 个持有交易日结束且收盘日线入库。`
  }
  return null
}

function sourceLabel(source: SignalSource): string {
  return SIGNAL_SOURCE_OPTIONS.find((option) => option.key === source)?.label ?? '历史信号源'
}

function strengthLayerLabel(index: number, total: number): string {
  const labels: Record<number, string[]> = {
    2: ['较高强度', '较低强度'],
    3: ['高强度', '中等强度', '低强度'],
    4: ['最高强度', '较高强度', '较低强度', '最低强度'],
    5: ['最高强度', '较高强度', '中等强度', '较低强度', '最低强度'],
  }
  return labels[total]?.[index] ?? `强度第 ${index + 1} 组${index === 0 ? '（最高）' : index === total - 1 ? '（最低）' : ''}`
}

function tradesForStrengthRange(trades: TradeRow[], minStrength: number, maxStrength: number): TradeRow[] {
  return trades.filter((trade) => (
    trade.status === 'executed'
    && trade.returnPct != null
    && trade.strength != null
    && trade.strength >= minStrength - 1e-12
    && trade.strength <= maxStrength + 1e-12
  ))
}

function sampleTooltipContent(title: string, expectedCount: number, samples: TradeRow[]): string {
  const sorted = [...samples].sort((left, right) => left.signalDate.localeCompare(right.signalDate) || left.tsCode.localeCompare(right.tsCode))
  const visible = sorted.slice(0, 20)
  const stockCount = new Set(sorted.map((trade) => trade.tsCode)).size
  const lines = visible.map((trade, index) => {
    const name = trade.stockName?.trim() || trade.tsCode.slice(0, 6)
    const date = /^\d{8}$/.test(trade.signalDate) ? `${trade.signalDate.slice(4, 6)}/${trade.signalDate.slice(6, 8)}` : trade.signalDate
    return `${index + 1}. ${name}（${trade.tsCode.slice(0, 6)}） · ${date}`
  })
  const summary = `${expectedCount} 笔信号${sorted.length > 0 ? ` · ${stockCount} 只股票` : ''}`
  if (lines.length === 0) return `${title}\n${summary}\n交易明细加载中…`
  const hiddenCount = Math.max(0, expectedCount - visible.length)
  return [title, summary, ...lines, hiddenCount > 0 ? `另有 ${hiddenCount} 笔，请在下方交易明细查看完整名单` : ''].filter(Boolean).join('\n')
}

const IPC_NOT_READY_MESSAGE = '策略回测 IPC 尚未加载, 请重启应用或刷新窗口后再试'

export function LegacyStrategyBacktestPanel({ initialStrategyKey = 'shortTerm.*' }: { initialStrategyKey?: string }): JSX.Element {
  const [signalSource, setSignalSource] = useState<SignalSource>('shortTerm')
  const [strategyKey, setStrategyKey] = useState(initialStrategyKey)
  const [dateStart, setDateStart] = useState(offsetYmd(-30))
  const [dateEnd, setDateEnd] = useState(todayYmd())
  const [entryRule, setEntryRule] = useState<EntryRule>('nextOpen')
  const [holdDays, setHoldDays] = useState(1)
  const [stopProfit, setStopProfit] = useState('')
  const [stopLoss, setStopLoss] = useState('')
  const [feeBps, setFeeBps] = useState(13)
  const [force, setForce] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [runId, setRunId] = useState<number | null>(null)
  const [report, setReport] = useState<BacktestReport | null>(null)
  const [cached, setCached] = useState<boolean | null>(null)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [trades, setTrades] = useState<TradeRow[]>([])
  const [loadingTrades, setLoadingTrades] = useState(false)
  const [loadingReport, setLoadingReport] = useState(false)
  const [deletingRunId, setDeletingRunId] = useState<number | null>(null)
  const [pendingDeleteRun, setPendingDeleteRun] = useState<RunSummary | null>(null)
  const [progress, setProgress] = useState<BacktestProgress | null>(null)
  const runListRequestRef = useRef(0)
  const reportRequestRef = useRef(0)

  const plan = useMemo<TradePlan>(() => ({
    entryRule,
    holdDays: Math.max(1, Math.round(holdDays)),
    stopProfit: stopProfit.trim() === '' ? null : Number(stopProfit),
    stopLoss: stopLoss.trim() === '' ? null : Number(stopLoss),
    feeBps: Math.max(0, Number(feeBps) || 0),
  }), [entryRule, feeBps, holdDays, stopLoss, stopProfit])

  const getStrategyBacktestApi = (): typeof window.api.strategyBacktest | null => {
    const api = window.api.strategyBacktest
    if (!api) {
      setError(IPC_NOT_READY_MESSAGE)
      return null
    }
    return api
  }

  const loadTrades = async (id: number): Promise<void> => {
    const api = getStrategyBacktestApi()
    if (!api) return
    setLoadingTrades(true)
    try {
      const res = await api.getTrades(id)
      if (res.ok) setTrades(res.data.trades as TradeRow[])
    } finally {
      setLoadingTrades(false)
    }
  }

  const applyRunToForm = (item: RunSummary): void => {
    setSignalSource(item.signalSource ?? 'shortTerm')
    setStrategyKey(item.strategyKey)
    setDateStart(item.dateStart)
    setDateEnd(item.dateEnd)
    setEntryRule(item.plan.entryRule)
    setHoldDays(item.plan.holdDays)
    setStopProfit(item.plan.stopProfit == null ? '' : String(item.plan.stopProfit))
    setStopLoss(item.plan.stopLoss == null ? '' : String(item.plan.stopLoss))
    setFeeBps(item.plan.feeBps)
  }

  const loadRun = async (item: RunSummary, syncForm = true): Promise<void> => {
    if (item.status !== 'completed') return
    const api = getStrategyBacktestApi()
    if (!api) return
    const requestId = ++reportRequestRef.current
    setLoadingReport(true)
    setRunId(item.id)
    setCached(null)
    setProgress(null)
    if (syncForm) applyRunToForm(item)
    try {
      const [reportRes, tradesRes] = await Promise.all([api.getReport(item.id), api.getTrades(item.id)])
      if (requestId !== reportRequestRef.current) return
      if (reportRes.ok) setReport(reportRes.data.report as BacktestReport)
      if (tradesRes.ok) setTrades(tradesRes.data.trades as TradeRow[])
    } finally {
      if (requestId === reportRequestRef.current) setLoadingReport(false)
    }
  }

  const loadRuns = async (key = strategyKey, source = signalSource, openLatest = false): Promise<void> => {
    const api = getStrategyBacktestApi()
    if (!api) return
    const requestId = ++runListRequestRef.current
    const res = await api.listRuns(key || undefined, source)
    if (!res.ok || requestId !== runListRequestRef.current) return
    const nextRuns = res.data.runs as RunSummary[]
    setRuns(nextRuns)
    if (openLatest) {
      const latest = nextRuns.find((item) => item.status === 'completed')
      if (latest) await loadRun(latest)
      else {
        reportRequestRef.current += 1
        setLoadingReport(false)
        setRunId(null)
        setReport(null)
        setTrades([])
      }
    }
  }

  useEffect(() => {
    void loadRuns(strategyKey, signalSource, true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyKey, signalSource])

  useEffect(() => {
    const api = window.api.strategyBacktest
    if (!api?.onProgress) return undefined
    const dispose = api.onProgress((item: BacktestProgress) => {
      setProgress(item)
      if (item.stage === 'failed') setError(item.message)
    })
    return () => {
      dispose()
    }
  }, [])

  const handleSignalSourceChange = (source: SignalSource): void => {
    reportRequestRef.current += 1
    setLoadingReport(false)
    setSignalSource(source)
    setStrategyKey(STRATEGY_OPTIONS[source][0].key)
    setReport(null)
    setCached(null)
    setTrades([])
    setRunId(null)
  }

  const handleStrategyKeyChange = (key: string): void => {
    reportRequestRef.current += 1
    setLoadingReport(false)
    setStrategyKey(key)
    setReport(null)
    setCached(null)
    setTrades([])
    setRunId(null)
  }

  const handleRun = async (): Promise<void> => {
    reportRequestRef.current += 1
    setLoadingReport(false)
    setError(null)
    setMessage(null)
    setProgress(null)
    setCached(null)
    if (!/^\d{8}$/.test(dateStart) || !/^\d{8}$/.test(dateEnd) || dateStart > dateEnd) {
      setError('日期范围无效')
      return
    }
    if ((plan.stopProfit != null && !Number.isFinite(plan.stopProfit)) || (plan.stopLoss != null && !Number.isFinite(plan.stopLoss))) {
      setError('止盈止损必须是数字或留空')
      return
    }

    setRunning(true)
    try {
      const api = getStrategyBacktestApi()
      if (!api) return
      const res = await api.run({ signalSource, strategyKey, dateStart, dateEnd, plan, force })
      if (!res.ok) {
        setError(res.message)
        return
      }
      setRunId(res.data.runId)
      setReport(res.data.report as BacktestReport)
      setCached(res.data.cached)
      setMessage(res.data.cached ? '已复用当前引擎与事实一致的历史回测结果' : '回测完成')
      await Promise.all([loadRuns(), loadTrades(res.data.runId)])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const handleSelectRun = async (item: RunSummary): Promise<void> => {
    await loadRun(item)
  }

  const handleDeleteRun = (item: RunSummary): void => {
    setError(null)
    setMessage(null)
    setPendingDeleteRun(item)
  }

  const handleConfirmDeleteRun = async (): Promise<void> => {
    const item = pendingDeleteRun
    if (!item) return
    const api = getStrategyBacktestApi()
    if (!api) return
    if (typeof api.deleteRun !== 'function') {
      setPendingDeleteRun(null)
      setError('删除功能的运行组件尚未加载，请完全重启应用后再试。')
      return
    }
    const wasSelected = runId === item.id
    setDeletingRunId(item.id)
    setError(null)
    setMessage(null)
    try {
      const res = await api.deleteRun(item.id)
      if (!res.ok) {
        setPendingDeleteRun(null)
        setError(res.message)
        return
      }
      if (wasSelected) {
        reportRequestRef.current += 1
        setLoadingReport(false)
        setRunId(null)
        setReport(null)
        setTrades([])
        setCached(null)
      }
      await loadRuns(strategyKey, signalSource, wasSelected)
      setMessage(`已删除回测记录 #${item.id}`)
      setPendingDeleteRun(null)
    } catch (err) {
      setPendingDeleteRun(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeletingRunId(null)
    }
  }

  const currentDate = getBeijingDateValue()
  const startDateValue = ymdToDash(dateStart)
  const endDateValue = ymdToDash(dateEnd)
  const startDateMax = endDateValue && endDateValue < currentDate ? endDateValue : currentDate
  const dateRangeError = !/^\d{8}$/.test(dateStart) || !/^\d{8}$/.test(dateEnd)
    ? '请输入完整日期'
    : dateStart > dateEnd
      ? '开始日期不能晚于结束日期'
      : endDateValue > currentDate
        ? '结束日期不能晚于今天'
        : null
  const sourceOptions = SIGNAL_SOURCE_OPTIONS.map((option) => ({
    value: option.key,
    label: option.label,
    meta: option.hint,
  }))
  const strategyOptions = STRATEGY_OPTIONS[signalSource].map((option) => ({
    value: option.key,
    label: option.label,
  }))
  const primaryStats = report ? [
    { label: '累计实现收益', value: report.totalReturn == null ? '不可统计' : fmtPct(report.totalReturn), tone: returnColor(report.totalReturn) },
    { label: '超额收益', value: report.excessReturn == null ? '不可统计' : fmtPct(report.excessReturn), tone: returnColor(report.excessReturn) },
    { label: '最大回撤', value: report.maxDrawdown == null ? '不可统计' : fmtAbsPct(report.maxDrawdown), tone: 'text-slate-900 dark:text-slate-100' },
    { label: '胜率', value: report.winRate == null ? '不可统计' : fmtPct(report.winRate * 100), tone: 'text-slate-900 dark:text-slate-100' },
  ] : []
  const secondaryStats = report ? [
    ['信号 / 成交', `${report.totalSignals} / ${report.validTrades}`],
    ['剔除率', report.dropRate == null ? '不可统计' : fmtPct(report.dropRate * 100)],
    ['平均 / 中位收益', `${fmtPct(report.avgReturn)} / ${fmtPct(report.medianReturn)}`],
    ['盈亏比', report.profitFactor == null ? '不可统计' : report.profitFactor === Infinity ? '∞' : fmtNum(report.profitFactor)],
    ['单笔期望', report.expectancy == null ? '不可统计' : fmtPct(report.expectancy)],
    ['风险调整', report.sharpeLike == null ? '不可统计' : fmtNum(report.sharpeLike)],
    ['基准收益', report.benchmarkReturn == null ? '不可统计' : fmtPct(report.benchmarkReturn)],
    ['持有期', `${report.plan.holdDays} 个交易日`],
  ] : []
  const blockedMessage = report ? blockedReportMessage(report) : null
  const validStrengthTrades = trades.filter((trade) => trade.status === 'executed' && trade.returnPct != null && trade.strength != null)
  const distinctTradeStrengths = new Set(validStrengthTrades.map((trade) => Number(trade.strength).toPrecision(12)))
  const reportStrengthValues = report?.byStrengthDecile?.flatMap((bucket) => [bucket.minStrength, bucket.maxStrength]) ?? []
  const uniformStrength = report != null && report.validTrades > 0 && (
    (validStrengthTrades.length > 0 && distinctTradeStrengths.size === 1)
    || (validStrengthTrades.length === 0 && reportStrengthValues.length > 0 && new Set(reportStrengthValues.map((value) => value.toPrecision(12))).size === 1)
  )
  const strengthBuckets = uniformStrength
    ? []
    : [...(report?.byStrengthDecile ?? [])].sort((left, right) => right.maxStrength - left.maxStrength || right.minStrength - left.minStrength)
  const uniformStrengthValue = validStrengthTrades[0]?.strength ?? reportStrengthValues[0] ?? null
  const uniformStrengthTooltip = report
    ? sampleTooltipContent('同一强度的有效样本', report.validTrades, validStrengthTrades)
    : ''
  const deleteRuntimeReady = typeof window.api.strategyBacktest?.deleteRun === 'function'

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header data-testid="strategy-backtest-setup" className="relative z-20 shrink-0 border-b border-slate-200 bg-white px-5 py-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-cyan-700 dark:text-cyan-300">历史验证</p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950 dark:text-slate-50">策略回测</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">使用本地信号与日线验证策略表现，历史报告不会因打开页面而重新计算。</p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="rounded border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">本地数据</span>
            <span className="rounded border border-slate-200 bg-slate-50 px-2.5 py-1.5 tabular-nums text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">历史 {runs.length}</span>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-12">
          <label className="col-span-2 min-w-0 lg:col-span-3">
            <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">信号来源</span>
            <ResearchCombobox
              value={signalSource}
              options={sourceOptions}
              placeholder="选择信号来源"
              searchPlaceholder="搜索信号来源"
              testId="strategy-backtest-signal-source"
              disabled={running}
              onChange={(value) => handleSignalSourceChange(value as SignalSource)}
            />
          </label>
          <label className="col-span-2 min-w-0 lg:col-span-3">
            <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">策略</span>
            <ResearchCombobox
              value={strategyKey}
              options={strategyOptions}
              placeholder="选择策略"
              searchPlaceholder="搜索策略"
              testId="strategy-backtest-strategy"
              disabled={running}
              onChange={handleStrategyKeyChange}
            />
          </label>
          <label className="col-span-1 min-w-0 lg:col-span-3">
            <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">开始日期</span>
            <ResearchDatePicker
              value={startDateValue}
              testId="strategy-backtest-date-start"
              max={startDateMax}
              disabled={running}
              ariaLabel="回测开始日期，格式为年-月-日"
              triggerAriaLabel="打开回测开始日期选择器"
              dialogLabel="选择回测开始日期"
              footerHint="回测区间起点"
              quickSelectLabel="今天"
              onChange={(value) => setDateStart(dashToYmd(value))}
            />
          </label>
          <label className="col-span-1 min-w-0 lg:col-span-3">
            <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">结束日期</span>
            <ResearchDatePicker
              value={endDateValue}
              testId="strategy-backtest-date-end"
              min={startDateValue}
              max={currentDate}
              disabled={running}
              ariaLabel="回测结束日期，格式为年-月-日"
              triggerAriaLabel="打开回测结束日期选择器"
              dialogLabel="选择回测结束日期"
              footerHint="不晚于今天"
              quickSelectLabel="今天"
              onChange={(value) => setDateEnd(dashToYmd(value))}
            />
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3 dark:border-slate-800">
          <fieldset className="min-w-[220px]">
            <legend className="mb-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">入场方式</legend>
            <div className="grid h-10 grid-cols-2 rounded-md bg-slate-100 p-1 dark:bg-slate-950" role="group" aria-label="回测入场方式">
              {([
                ['nextOpen', 'T+1 开盘'],
                ['signalClose', '信号日收盘'],
              ] as Array<[EntryRule, string]>).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={entryRule === value}
                  disabled={running}
                  onClick={() => setEntryRule(value)}
                  className={`rounded px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30 ${entryRule === value ? 'bg-white text-cyan-800 shadow-sm ring-1 ring-slate-200 dark:bg-slate-800 dark:text-cyan-200 dark:ring-slate-700' : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>
          {[
            { label: '持有交易日', value: holdDays, onChange: (value: string) => setHoldDays(Number(value)), min: 1, max: 30, placeholder: '' },
            { label: '止盈 %', value: stopProfit, onChange: setStopProfit, min: undefined, max: undefined, placeholder: '不设' },
            { label: '止损 %', value: stopLoss, onChange: setStopLoss, min: undefined, max: undefined, placeholder: '不设' },
            { label: '费用 bps', value: feeBps, onChange: (value: string) => setFeeBps(Number(value)), min: 0, max: undefined, placeholder: '' },
          ].map((field) => (
            <label key={field.label} className="w-24">
              <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">{field.label}</span>
              <input
                type="number"
                min={field.min}
                max={field.max}
                value={field.value}
                placeholder={field.placeholder}
                disabled={running}
                onChange={(event) => field.onChange(event.target.value)}
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm tabular-nums text-slate-900 outline-none transition-colors hover:border-cyan-400 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:hover:border-cyan-600"
              />
            </label>
          ))}
          <label className="flex min-h-10 cursor-pointer items-center gap-2 pb-0.5 text-xs font-medium text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={force} disabled={running} onChange={(event) => setForce(event.target.checked)} className="peer sr-only" />
            <span aria-hidden="true" className="relative h-6 w-11 rounded-full bg-slate-300 transition-colors peer-checked:bg-cyan-700 peer-focus-visible:ring-2 peer-focus-visible:ring-cyan-500/30 peer-disabled:opacity-45 dark:bg-slate-700">
              <span className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 motion-reduce:transition-none ${force ? 'translate-x-6' : 'translate-x-1'}`} />
            </span>
            强制重算
          </label>
          <button
            type="button"
            onClick={() => void handleRun()}
            disabled={running || Boolean(dateRangeError)}
            className="ml-auto h-10 min-w-28 rounded-md bg-cyan-700 px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-cyan-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {running ? '回测中…' : '运行回测'}
          </button>
        </div>

        {dateRangeError && <div className="mt-2 text-xs text-red-700 dark:text-red-300" role="alert">{dateRangeError}</div>}
        {message && <div className="mt-2 text-xs text-cyan-700 dark:text-cyan-300" role="status">{message}</div>}
        {error && <div className="mt-2 text-xs text-red-700 dark:text-red-300" role="alert">{error}</div>}
        {(running || progress) && (
          <div className="mt-3 rounded-md border border-cyan-100 bg-cyan-50 px-3 py-2 dark:border-cyan-900/60 dark:bg-cyan-950/30" aria-live="polite">
            <div className="flex items-center justify-between gap-3 text-xs text-cyan-800 dark:text-cyan-200">
              <span>{progress?.message ?? '准备回测'}</span>
              <span className="font-mono tabular-nums">{progressPct(progress)}%</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-cyan-100 dark:bg-cyan-900">
              <div className="h-full rounded-full bg-cyan-700 transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${progressPct(progress)}%` }} />
            </div>
          </div>
        )}
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] gap-3 overflow-hidden p-3 xl:grid-cols-[280px_minmax(0,1fr)]">
        <aside data-testid="strategy-backtest-history" className="min-h-0 overflow-auto rounded-md border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-3 py-3 dark:border-slate-800 dark:bg-slate-900">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">历史回测</h3>
              <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">当前策略的本地报告</p>
            </div>
            <span className="rounded bg-slate-100 px-2 py-1 text-[11px] tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">{runs.length}</span>
          </div>
          {runs.length === 0 ? (
            <div data-testid="strategy-backtest-history-empty" className="px-3 py-10 text-center text-xs leading-5 text-slate-500 dark:text-slate-400">当前策略还没有历史报告</div>
          ) : runs.map(item => (
            <div key={item.id} className={(runId === item.id ? 'border-l-cyan-600 bg-cyan-50/70 dark:border-l-cyan-400 dark:bg-cyan-950/25 ' : 'border-l-transparent ') + 'group flex min-h-[76px] border-b border-l-2 border-slate-100 transition-colors hover:bg-slate-50 dark:border-b-slate-800 dark:hover:bg-slate-800'}>
              <button
                type="button"
                disabled={item.status !== 'completed' || deletingRunId !== null}
                onClick={() => void handleSelectRun(item)}
                title={item.errorMessage ?? undefined}
                className="min-w-0 flex-1 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-55"
              >
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 text-xs font-semibold leading-5 text-slate-800 dark:text-slate-100">{strategyLabel(item.signalSource ?? 'shortTerm', item.strategyKey)}</span>
                  <span className={item.status === 'failed' ? 'shrink-0 rounded bg-red-50 px-1.5 py-0.5 text-[10px] text-red-700 dark:bg-red-950/40 dark:text-red-300' : item.trustStatus === 'blocked' ? 'shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-950/40 dark:text-amber-300' : 'shrink-0 rounded bg-cyan-50 px-1.5 py-0.5 text-[10px] text-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-300'}>{item.status === 'failed' ? '失败' : trustLabel(item.trustStatus)}</span>
                </div>
                <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">{sourceLabel(item.signalSource ?? 'shortTerm')} · {fmtDate(item.dateStart)} - {fmtDate(item.dateEnd)}</div>
                <div className="mt-0.5 text-[10px] text-slate-400">持有 {item.plan.holdDays} 个交易日 · #{item.id}</div>
              </button>
              <div className="flex shrink-0 items-center pr-2">
                <button
                  type="button"
                  data-testid={`strategy-backtest-delete-${item.id}`}
                  aria-label={`删除回测记录 #${item.id}`}
                  title={`删除回测记录 #${item.id}`}
                  disabled={running || deletingRunId !== null}
                  onClick={() => handleDeleteRun(item)}
                  className="h-11 w-14 rounded text-xs font-medium text-slate-500 transition-colors hover:bg-red-50 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30 disabled:cursor-not-allowed disabled:opacity-45 dark:text-slate-400 dark:hover:bg-red-950/40 dark:hover:text-red-300"
                >
                  {deletingRunId === item.id ? '删除中' : '删除'}
                </button>
              </div>
            </div>
          ))}
        </aside>

        <main data-testid="strategy-backtest-report" className="min-h-0 overflow-auto rounded-md border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          {loadingReport ? (
            <div className="flex h-full min-h-80 flex-col items-center justify-center gap-3 p-8 text-sm text-slate-500 dark:text-slate-400" aria-live="polite">
              <span className="h-7 w-7 animate-spin rounded-full border-2 border-slate-200 border-t-cyan-600 motion-reduce:animate-none dark:border-slate-700 dark:border-t-cyan-300" />
              正在打开最近报告
            </div>
          ) : !report ? (
            <div data-testid="strategy-backtest-report-empty" className="flex h-full min-h-80 items-center justify-center p-8">
              <div className="max-w-md text-center">
                <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100">暂无可展示的回测报告</h3>
                <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">选择信号、策略和时间区间后运行回测，结果会保存在本地历史中。</p>
              </div>
            </div>
          ) : (
            <div className="space-y-4 p-4">
              <section className="border-b border-slate-100 pb-4 dark:border-slate-800">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold text-slate-950 dark:text-slate-50">{strategyLabel(report.signalSource ?? signalSource, report.strategyKey)}</h3>
                      <span className={report.trust.status === 'blocked' ? 'rounded bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300' : 'rounded bg-cyan-50 px-2 py-1 text-[11px] font-medium text-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-300'}>{trustLabel(report.trust.status)}</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{fmtDate(report.dateRange.start)} - {fmtDate(report.dateRange.end)} · {sourceLabel(report.signalSource ?? signalSource)} · {cached === true ? '复用事实一致报告' : cached === false ? '本次重新计算' : '历史记录'}</p>
                  </div>
                  <div className="text-right text-[11px] leading-5 text-slate-500 dark:text-slate-400">报告 v{report.schemaVersion}<br />{fmtGeneratedAt(report.generatedAt)}</div>
                </div>
                {report.trust.reasons.length > 0 && (
                  <details className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs dark:bg-slate-950/60">
                    <summary className="cursor-pointer select-none font-medium text-slate-700 outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30 dark:text-slate-200">查看口径限制（{report.trust.reasons.length}）</summary>
                    <ul className="mt-2 space-y-1.5 text-slate-600 dark:text-slate-300">
                      {report.trust.reasons.map(reason => <li key={reason}>· {TRUST_REASON_LABELS[reason]}</li>)}
                    </ul>
                  </details>
                )}
                <details className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
                  <summary className="cursor-pointer select-none outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30">技术审计</summary>
                  <div className="mt-1.5 break-all leading-5">引擎 {report.trust.engineVersion} · 事实指纹 {report.trust.factFingerprint || '历史缺失'}</div>
                </details>
              </section>
              {report.trust.credibility && (
                <BacktestCredibilityBand assessment={report.trust.credibility} testId="strategy-backtest-credibility" />
              )}
              {report.dropRate != null && report.dropRate > 0.2 && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                  剔除率高于 20%，样本可能受到本地日线底座不足、停牌或幸存者偏差影响。
                </div>
              )}
              {blockedMessage && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200" role="status">
                  {blockedMessage}
                </div>
              )}
              {report.benchmarkNote && (
                <div className="rounded-md border border-cyan-200 bg-cyan-50 px-3 py-2 text-xs leading-5 text-cyan-800 dark:border-cyan-800 dark:bg-cyan-950/30 dark:text-cyan-200">
                  {report.benchmarkNote}
                </div>
              )}
              <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
                {primaryStats.map((item) => (
                  <article key={item.label} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-3 dark:border-slate-800 dark:bg-slate-950/55">
                    <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{item.label}</p>
                    <p className={`mt-1.5 text-xl font-semibold tabular-nums ${item.tone}`}>{item.value}</p>
                  </article>
                ))}
              </div>

              {report.equityCurve && (
                <BacktestEquityChart points={report.equityCurve} totalReturn={report.totalReturn} maxDrawdown={report.maxDrawdown} startDate={report.dateRange.start} />
              )}

              <section>
                <h3 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">样本与交易统计</h3>
                <dl className="grid grid-cols-2 border-y border-slate-100 text-xs md:grid-cols-4 dark:border-slate-800">
                  {secondaryStats.map(([label, value]) => (
                    <div key={label} className="border-b border-slate-100 px-3 py-2.5 md:[&:nth-last-child(-n+4)]:border-b-0 dark:border-slate-800">
                      <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
                      <dd className="mt-1 font-medium tabular-nums text-slate-800 dark:text-slate-200">{value}</dd>
                    </div>
                  ))}
                </dl>
              </section>

              {uniformStrength && (
                <section data-testid="strategy-backtest-uniform-strength" className="border-y border-slate-100 px-1 py-3 dark:border-slate-800">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">强度比较</h3>
                      <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                        本策略的有效信号没有可区分的原始评分{uniformStrengthValue == null ? '' : `（均为 ${fmtNum(uniformStrengthValue, 2)}）`}，因此不做强弱分层，避免把同一强度任意拆成多个层级。
                      </p>
                    </div>
                    <InfoTip content={uniformStrengthTooltip} placement="top">
                      <button type="button" className="cursor-help text-xs font-medium text-cyan-700 underline decoration-cyan-300 underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30 dark:text-cyan-300" aria-label={`查看同一强度的 ${report.validTrades} 笔样本`}>
                        查看 {report.validTrades} 笔样本
                      </button>
                    </InfoTip>
                  </div>
                </section>
              )}

              {strengthBuckets.length > 1 && (
                <div className="overflow-hidden rounded border border-slate-200 dark:border-slate-700">
                  <div className="border-b border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800">
                    <div className="text-sm font-semibold">强度比较</div>
                    <div className="mt-1 text-[11px] leading-4 text-slate-500 dark:text-slate-400">按触发时原始评分从高到低分组，每档至少保留约5笔样本；评分只表示信号触发强弱，不保证后续收益。</div>
                  </div>
                  <div className="overflow-auto">
                    <table className="min-w-full text-left text-xs">
                      <thead className="bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                        <tr>
                          <th className="px-3 py-2">强度档位</th>
                          <th className="px-3 py-2 text-right">评分范围</th>
                          <th className="px-3 py-2 text-right">样本</th>
                          <th className="px-3 py-2 text-right">胜率</th>
                          <th className="px-3 py-2 text-right">平均收益</th>
                          <th className="px-3 py-2 text-right">中位收益</th>
                          <th className="px-3 py-2 text-right">盈亏比</th>
                          <th className="px-3 py-2 text-right">期望</th>
                        </tr>
                      </thead>
                      <tbody>
                        {strengthBuckets.map((bucket, index) => {
                          const bucketSamples = tradesForStrengthRange(trades, bucket.minStrength, bucket.maxStrength)
                          const tooltip = sampleTooltipContent(strengthLayerLabel(index, strengthBuckets.length), bucket.count, bucketSamples)
                          return (
                          <tr key={bucket.bucket} className="border-t border-slate-100 dark:border-slate-800">
                            <td className="px-3 py-2 font-medium text-slate-700 dark:text-slate-200">{strengthLayerLabel(index, strengthBuckets.length)}</td>
                            <td className="px-3 py-2 text-right">{fmtNum(bucket.minStrength, 2)} - {fmtNum(bucket.maxStrength, 2)}</td>
                            <td className="px-3 py-2 text-right">
                              <InfoTip content={tooltip} placement="top">
                                <button type="button" className="cursor-help font-medium text-cyan-700 underline decoration-cyan-300 underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30 dark:text-cyan-300" aria-label={`查看${strengthLayerLabel(index, strengthBuckets.length)}的 ${bucket.count} 笔样本`}>
                                  {bucket.count} 笔
                                </button>
                              </InfoTip>
                            </td>
                            <td className="px-3 py-2 text-right">{fmtPct(bucket.winRate == null ? null : bucket.winRate * 100)}</td>
                            <td className={`px-3 py-2 text-right ${returnColor(bucket.avgReturn)}`}>{fmtPct(bucket.avgReturn)}</td>
                            <td className={`px-3 py-2 text-right ${returnColor(bucket.medianReturn)}`}>{fmtPct(bucket.medianReturn)}</td>
                            <td className="px-3 py-2 text-right">{bucket.profitFactor === Infinity ? '∞' : fmtNum(bucket.profitFactor)}</td>
                            <td className={`px-3 py-2 text-right ${returnColor(bucket.expectancy)}`}>{fmtPct(bucket.expectancy)}</td>
                          </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="overflow-hidden rounded border border-slate-200 dark:border-slate-700">
                <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800">
                  <div className="text-sm font-semibold">交易明细</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">{loadingTrades ? '加载中…' : `${trades.length} 条`}</div>
                </div>
                <div className="max-h-[420px] overflow-auto">
                  <table className="min-w-full text-left text-xs">
                    <thead className="sticky top-0 bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                      <tr>
                        <th className="px-3 py-2">股票</th>
                        <th className="px-3 py-2">信号日</th>
                        <th className="px-3 py-2">入场</th>
                        <th className="px-3 py-2">出场</th>
                        <th className="px-3 py-2 text-right">净收益</th>
                        <th className="px-3 py-2">原因</th>
                        <th className="px-3 py-2">状态</th>
                        <th className="px-3 py-2 text-right">强度</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trades.map((trade, index) => (
                        <tr key={`${trade.tsCode}-${trade.signalDate}-${index}`} className="border-t border-slate-100 dark:border-slate-800">
                          <td className="px-3 py-2 font-medium text-slate-800 dark:text-slate-100">
                            <div>{trade.stockName?.trim() || trade.tsCode}</div>
                            {trade.stockName?.trim() && <div className="mt-0.5 text-[11px] font-normal text-slate-500 dark:text-slate-400">{trade.tsCode}</div>}
                          </td>
                          <td className="px-3 py-2">{fmtDate(trade.signalDate)}</td>
                          <td className="px-3 py-2">{fmtDate(trade.entryDate)} · {fmtNum(trade.entryPrice)}</td>
                          <td className="px-3 py-2">{fmtDate(trade.exitDate)} · {fmtNum(trade.exitPrice)}</td>
                          <td className={`px-3 py-2 text-right font-semibold ${returnColor(trade.netReturnPct)}`}>{fmtPct(trade.netReturnPct)}</td>
                          <td className="px-3 py-2">{exitReasonLabel(trade.exitReason)}</td>
                          <td className="px-3 py-2">{statusLabel(trade.status)}</td>
                          <td className="px-3 py-2 text-right">{fmtNum(trade.strength, 0)}</td>
                        </tr>
                      ))}
                      {trades.length === 0 && (
                        <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-500 dark:text-slate-400">暂无交易明细</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
      {pendingDeleteRun && (
        <BacktestDeleteDialog
          target={{
            id: pendingDeleteRun.id,
            strategyLabel: strategyLabel(pendingDeleteRun.signalSource ?? 'shortTerm', pendingDeleteRun.strategyKey),
            dateRange: `${fmtDate(pendingDeleteRun.dateStart)} - ${fmtDate(pendingDeleteRun.dateEnd)}`,
            holdDays: pendingDeleteRun.plan.holdDays,
          }}
          deleting={deletingRunId === pendingDeleteRun.id}
          runtimeUpdateRequired={!deleteRuntimeReady}
          onCancel={() => setPendingDeleteRun(null)}
          onConfirm={() => void handleConfirmDeleteRun()}
          onRestart={() => void window.api.app.relaunch()}
        />
      )}
    </div>
  )
}

interface StrategyBacktestPanelProps {
  initialView?: 'effectiveness' | 'history'
  initialStrategyKey?: string
  onInitialEntryApplied?: () => void
}

export function StrategyBacktestPanel({
  initialView = 'effectiveness',
  initialStrategyKey,
  onInitialEntryApplied,
}: StrategyBacktestPanelProps = {}): JSX.Element {
  const [view, setView] = useState<'effectiveness' | 'history'>(initialView)
  const [historyVisited, setHistoryVisited] = useState(initialView === 'history')

  useEffect(() => {
    onInitialEntryApplied?.()
  }, [onInitialEntryApplied])

  const selectView = (next: 'effectiveness' | 'history'): void => {
    setView(next)
    if (next === 'history') setHistoryVisited(true)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-50 dark:bg-slate-950">
      <div className="z-40 flex min-h-12 shrink-0 items-end gap-1 border-b border-slate-200 bg-white px-5 dark:border-slate-800 dark:bg-slate-900" role="tablist" aria-label="策略评估视图">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'effectiveness'}
          data-testid="strategy-backtest-view-effectiveness"
          onClick={() => selectView('effectiveness')}
          className={`min-h-11 border-b-2 px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30 ${view === 'effectiveness' ? 'border-cyan-600 text-cyan-800 dark:text-cyan-200' : 'border-transparent text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'}`}
        >
          效果评估
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'history'}
          data-testid="strategy-backtest-view-history"
          onClick={() => selectView('history')}
          className={`min-h-11 border-b-2 px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30 ${view === 'history' ? 'border-cyan-600 text-cyan-800 dark:text-cyan-200' : 'border-transparent text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'}`}
        >
          历史报告
        </button>
        <span className="ml-auto hidden min-h-11 items-center text-xs text-slate-400 md:flex">历史报告保留原资金净值模型；效果评估不创建新记录</span>
      </div>
      <div className={view === 'effectiveness' ? 'min-h-0 flex-1' : 'hidden'} role="tabpanel" aria-label="策略效果评估">
        <StrategyEffectivenessWorkbench />
      </div>
      {historyVisited && (
        <div className={view === 'history' ? 'min-h-0 flex-1' : 'hidden'} role="tabpanel" aria-label="历史回测报告">
          <LegacyStrategyBacktestPanel initialStrategyKey={initialStrategyKey} />
        </div>
      )}
    </div>
  )
}
