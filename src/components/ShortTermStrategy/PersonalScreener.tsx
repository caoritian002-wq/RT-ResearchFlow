/**
 * FR-151b: 个性选股（魔鬼操盘手·精准控量版）
 *
 * 左侧可折叠条件面板（策略说明 + 参数展示）
 * 右侧选股结果表格（代码/名称/涨幅/换手率/成交额/题材/信号强度）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../store/appStore'
import { StockKlineChipDrawer } from '../shared/StockMiniChart'
import { publishAppToast } from '../shared/appToastBus'

type ScreenerSignalKey = 'crossUp' | 'volAmplified' | 'bullTrend' | 'macdBull' | 'hasTurnover' | 'moneyInflow'
type ScreenerTieBreaker = 'pctChg' | 'turnoverRate' | 'amount'

interface ScreenerRankBreakdownItem {
  key: ScreenerSignalKey
  label: string
  matched: boolean
  weight: number
  strength: number
  contribution: number
}

interface ScreenerMoneyFlowSummary {
  source: 'real' | 'estimated' | 'none'
  mainNetInflow: number | null
  mainNetInflowRatio: number | null
  netMfAmount: number | null
  detail?: {
    small: { buy: number | null; sell: number | null }
    medium: { buy: number | null; sell: number | null }
    large: { buy: number | null; sell: number | null }
    extraLarge: { buy: number | null; sell: number | null }
  }
}

interface ScreenerRankConfig {
  weights: Record<ScreenerSignalKey, number>
  tieBreaker: ScreenerTieBreaker
  normalizeEnabled: boolean
  normalizationCaps: {
    volAmplified: number
    macdBull: number
    hasTurnover: number
    moneyInflow: number
  }
  updatedAt: number
}

interface ScreenerStock {
  tsCode: string
  stockName: string
  close: number
  pctChg: number
  turnoverRate: number | null
  vol: number
  amount: number
  signalScore: number
  conditionsMet: string[]
  concepts: string[]
  turnoverMissing?: boolean
  rankScore: number
  rankBreakdown: ScreenerRankBreakdownItem[]
  signalStrength: Partial<Record<ScreenerSignalKey, number>>
  moneyFlow: ScreenerMoneyFlowSummary | null
}

interface ScreenerSnapshot {
  tradeDate: string
  calculatedAt: string
  isCached: boolean
  mode: 'realtime' | 'eod' | 'eod-fallback'
  rtTime?: string
  totalScanned: number
  stocks: ScreenerStock[]
}

interface ScreenerInsight {
  tradeDate: string
  tsCode: string
  stockName: string | null
  sections: {
    hitReason: string
    catalyst: string
    technicalContext: string
    risks: string
  }
  confidenceBoundary: string
  evidenceSummary: string[]
  evidenceHash: string
  fromCache: boolean
  provider: string | null
  model: string | null
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  finishReason?: string | null
  complianceBlocked: boolean
  updatedAt: number
}
type ScreenerInsightProgress = { current: number; total: number; tsCode: string; status: string }
type ScreenerInsightCompatApi = typeof window.api.shortTerm.screener & {
  getInsight?: typeof window.api.shortTerm.screener.getInsight
  batchInsight?: typeof window.api.shortTerm.screener.batchInsight
  onInsightProgress?: (cb: (p: ScreenerInsightProgress) => void) => () => void
}

function pctColor(v: number): string {
  if (v >= 7) return 'text-red-700 dark:text-red-400 font-bold'
  if (v >= 3) return 'text-red-500 dark:text-red-400'
  if (v > 0) return 'text-red-400 dark:text-red-300'
  if (v < -3) return 'text-green-600 dark:text-green-400'
  if (v < 0) return 'text-green-500 dark:text-green-400'
  return 'text-gray-500 dark:text-gray-400'
}

function fmtAmount(yuan: number): string {
  if (yuan >= 1e8) return (yuan / 1e8).toFixed(2) + '亿'
  return (yuan / 1e4).toFixed(0) + '万'
}

function fmtSignedAmount(yuan: number | null | undefined): string {
  if (yuan == null || !Number.isFinite(yuan)) return '--'
  const sign = yuan > 0 ? '+' : yuan < 0 ? '-' : ''
  return sign + fmtAmount(Math.abs(yuan))
}

// 信号强度：6 个方块格
function ScoreBar({ score }: { score: number }) {
  return (
    <span className="flex gap-0.5">
      {[1, 2, 3, 4, 5, 6].map(i => (
        <span
          key={i}
          className={`inline-block w-2.5 h-2.5 rounded-sm ${
            i <= score
              ? score >= 4
                ? 'bg-red-500'
                : 'bg-orange-400'
              : 'bg-gray-200 dark:bg-gray-600'
          }`}
        />
      ))}
    </span>
  )
}

const CONDITION_LABELS: Record<string, string> = {
  '天使魔鬼金叉': '金叉',
  '量能放大': '量↑',
  '短期多头': '多头',
  'MACD向好': 'MACD',
  '有效换手': '换手',
  '资金净流入': '资金'
}

const SIGNAL_LABELS: Record<ScreenerSignalKey, string> = {
  crossUp: '金叉',
  volAmplified: '量能',
  bullTrend: '多头',
  macdBull: 'MACD',
  hasTurnover: '换手',
  moneyInflow: '资金',
}

const DEFAULT_RANK_CONFIG: ScreenerRankConfig = {
  weights: { crossUp: 1, volAmplified: 1, bullTrend: 1, macdBull: 1, hasTurnover: 1, moneyInflow: 0 },
  tieBreaker: 'pctChg',
  normalizeEnabled: false,
  normalizationCaps: { volAmplified: 3, macdBull: 0.08, hasTurnover: 8, moneyInflow: 5 },
  updatedAt: 0,
}

export function PersonalScreener() {
  const setShortTermActiveSubTab = useAppStore(s => s.setShortTermActiveSubTab)
  const [snapshot, setSnapshot] = useState<ScreenerSnapshot | null>(null)
  const screenerApi = window.api.shortTerm.screener as ScreenerInsightCompatApi
  const insightApiReady = typeof screenerApi.getInsight === 'function' && typeof screenerApi.batchInsight === 'function'
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [syncingBasic, setSyncingBasic] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [panelOpen, setPanelOpen] = useState(true)
  const [rankConfigOpen, setRankConfigOpen] = useState(false)
  const [rankConfig, setRankConfig] = useState<ScreenerRankConfig>(DEFAULT_RANK_CONFIG)
  const [rankSaving, setRankSaving] = useState(false)
  const [clickedStock, setClickedStock] = useState<{
    tsCode: string; stockName: string
  } | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 动态过滤参数
  const [minSignal, setMinSignal] = useState(5)
  const [requireTurnover, setRequireTurnover] = useState(true)

  // 历史日线初始化进度状态
  const [initInFlight, setInitInFlight] = useState(false)
  const [initProgress, setInitProgress] = useState<{ done: number; total: number; date: string } | null>(null)
  // 用于存储事件监听清理函数
  const initCleanupRef = useRef<Array<() => void>>([])

  // FR-156 筹码监控确认弹窗
  const [showChipConfirm, setShowChipConfirm] = useState(false)
  const [insightOpen, setInsightOpen] = useState(false)
  const [selectedInsight, setSelectedInsight] = useState<ScreenerInsight | null>(null)
  const [insightLoadingCode, setInsightLoadingCode] = useState<string | null>(null)
  const [insightError, setInsightError] = useState('')
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number; tsCode: string; status: string } | null>(null)
  const [selectedInsightCodes, setSelectedInsightCodes] = useState<string[]>([])
  const [trendAddBusy, setTrendAddBusy] = useState(false)

  const loadSnapshot = useCallback(async (force = false) => {
    setLoading(true)
    setErrorMsg('')
    try {
      const res = force
        ? await window.api.shortTerm.screener.run()
        : await window.api.shortTerm.screener.get()
      if (res.ok) {
        setSnapshot(res.snapshot)
      } else {
        const code = (res as { code?: string }).code
        if (code === 'STOCK_BASIC_NOT_READY') {
          setErrorMsg('STOCK_BASIC_NOT_READY')
        } else if (code === 'DAILY_DATA_INSUFFICIENT') {
          setErrorMsg('DAILY_DATA_INSUFFICIENT')
        } else {
          setErrorMsg((res as { error: string }).error || '选股计算失败')
        }
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '未知错误')
    } finally {
      setLoading(false)
      setRunning(false)
    }
  }, [])

  useEffect(() => {
    void loadSnapshot(false)
  }, [loadSnapshot])

  useEffect(() => {
    let canceled = false
    void window.api.shortTerm.screener.getRankConfig().then(res => {
      if (!canceled && res.ok) setRankConfig(res.config)
    }).catch(() => undefined)
    return () => { canceled = true }
  }, [])

  // 组件卸载时清理所有事件监听
  useEffect(() => {
    return () => {
      initCleanupRef.current.forEach(fn => fn())
      initCleanupRef.current = []
    }
  }, [])

  useEffect(() => {
    if (typeof screenerApi.onInsightProgress !== 'function') return undefined
    const clean = screenerApi.onInsightProgress(p => {
      setBatchProgress(p)
    })
    return () => clean()
  }, [screenerApi])

  const handleInitDailyData = useCallback(async () => {
    // 清理上次的事件监听（若存在）
    initCleanupRef.current.forEach(fn => fn())
    initCleanupRef.current = []

    setInitInFlight(true)
    setInitProgress(null)

    // 注册进度事件监听
    const cleanProgress = window.api.shortTerm.onInitDailyDataProgress(p => {
      setInitProgress(p)
    })
    // 注册完成事件监听
    const cleanDone = window.api.shortTerm.onInitDailyDataDone(() => {
      setInitInFlight(false)
      setInitProgress(null)
      setErrorMsg('')
      // 清理监听
      initCleanupRef.current.forEach(fn => fn())
      initCleanupRef.current = []
      // 初始化完成，自动重新运行选股
      void loadSnapshot(false)
    })
    initCleanupRef.current = [cleanProgress, cleanDone]

    try {
      const r = await window.api.shortTerm.initDailyData()
      if (!r.ok) {
        const code = (r as { code?: string }).code
        setErrorMsg(
          code === 'TUSHARE_DISABLED'
            ? 'Tushare 未配置，无法初始化日线数据'
            : (r as { error: string }).error || '初始化失败'
        )
        setInitInFlight(false)
        initCleanupRef.current.forEach(fn => fn())
        initCleanupRef.current = []
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '初始化失败')
      setInitInFlight(false)
      initCleanupRef.current.forEach(fn => fn())
      initCleanupRef.current = []
    }
  }, [loadSnapshot])

  const handleRowClick = useCallback((stock: ScreenerStock) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
    setClickedStock({
      tsCode: stock.tsCode,  // 保留完整格式如 "002009.SZ"，与 daily_close_cache 的 ts_code 字段一致
      stockName: stock.stockName
    })
  }, [])

  const handleCloseChart = useCallback(() => {
    setClickedStock(null)
  }, [])

  // 前端动态过滤（纯 JS，无 IPC）
  const displayedStocks = snapshot
    ? [...snapshot.stocks].sort((a, b) => {
        const tieA = rankConfig.tieBreaker === 'turnoverRate' ? (a.turnoverRate ?? -Infinity) : rankConfig.tieBreaker === 'amount' ? a.amount : a.pctChg
        const tieB = rankConfig.tieBreaker === 'turnoverRate' ? (b.turnoverRate ?? -Infinity) : rankConfig.tieBreaker === 'amount' ? b.amount : b.pctChg
        return (b.rankScore ?? b.signalScore) - (a.rankScore ?? a.signalScore) || tieB - tieA
      }).filter(s => {
        if (s.signalScore < minSignal) return false
        if (requireTurnover && !s.conditionsMet.includes('有效换手')) return false
        return true
      })
    : []
  const displayedCodeSet = useMemo(() => new Set(displayedStocks.map(stock => stock.tsCode)), [displayedStocks])
  const selectedVisibleStocks = useMemo(
    () => displayedStocks.filter(stock => selectedInsightCodes.includes(stock.tsCode)),
    [displayedStocks, selectedInsightCodes],
  )
  const allVisibleSelected = displayedStocks.length > 0 && displayedStocks.every(stock => selectedInsightCodes.includes(stock.tsCode))
  const someVisibleSelected = displayedStocks.some(stock => selectedInsightCodes.includes(stock.tsCode))

  useEffect(() => {
    setSelectedInsightCodes(prev => prev.filter(code => displayedCodeSet.has(code)))
  }, [displayedCodeSet])

  const handleToggleSelectAllInsights = useCallback(() => {
    setSelectedInsightCodes(prev => {
      if (displayedStocks.length === 0) return []
      if (displayedStocks.every(stock => prev.includes(stock.tsCode))) {
        return prev.filter(code => !displayedCodeSet.has(code))
      }
      return Array.from(new Set([...prev, ...displayedStocks.map(stock => stock.tsCode)]))
    })
  }, [displayedCodeSet, displayedStocks])

  const handleToggleInsightCode = useCallback((tsCode: string) => {
    setSelectedInsightCodes(prev => prev.includes(tsCode) ? prev.filter(code => code !== tsCode) : [...prev, tsCode])
  }, [])

  const handleSaveRankConfig = useCallback(async () => {
    setRankSaving(true)
    try {
      const res = await window.api.shortTerm.screener.saveRankConfig(rankConfig)
      if (res.ok) {
        setRankConfig(res.config)
        void loadSnapshot(true)
      } else {
        setErrorMsg(res.error || '排序配置保存失败')
      }
    } finally {
      setRankSaving(false)
    }
  }, [loadSnapshot, rankConfig])

  const handleResetRankConfig = useCallback(async () => {
    setRankSaving(true)
    try {
      const res = await window.api.shortTerm.screener.resetRankConfig()
      if (res.ok) {
        setRankConfig(res.config)
        void loadSnapshot(true)
      } else {
        setErrorMsg(res.error || '排序配置重置失败')
      }
    } finally {
      setRankSaving(false)
    }
  }, [loadSnapshot])

  const handleInsight = useCallback(async (stock: ScreenerStock, forceRefresh = false) => {
    if (!snapshot) return
    if (typeof screenerApi.getInsight !== 'function') {
      setInsightError('AI 解读接口尚未加载，请重启开发进程后再试。')
      setInsightOpen(true)
      return
    }
    setInsightLoadingCode(stock.tsCode)
    setInsightError('')
    setInsightOpen(true)
    try {
      const res = await screenerApi.getInsight({
        tradeDate: snapshot.tradeDate,
        tsCode: stock.tsCode,
        forceRefresh,
      })
      if (res.ok) {
        setSelectedInsight(res.insight)
      } else {
        setInsightError((res as { error: string }).error || 'AI 解读失败')
      }
    } catch (err) {
      setInsightError(err instanceof Error ? err.message : 'AI 解读失败')
    } finally {
      setInsightLoadingCode(null)
    }
  }, [screenerApi, snapshot])

  const handleBatchInsight = useCallback(async () => {
    if (!snapshot || selectedVisibleStocks.length === 0) return
    if (typeof screenerApi.batchInsight !== 'function') {
      setInsightError('AI 解读接口尚未加载，请重启开发进程后再试。')
      return
    }
    if (selectedVisibleStocks.length > 10) {
      setInsightError('单次批量 AI 解读最多选择 10 只股票，请减少勾选数量。')
      return
    }
    setBatchRunning(true)
    setBatchProgress({ current: 0, total: selectedVisibleStocks.length, tsCode: '', status: 'running' })
    setInsightError('')
    try {
      const res = await screenerApi.batchInsight({
        tradeDate: snapshot.tradeDate,
        tsCodes: selectedVisibleStocks.map(s => s.tsCode),
        limit: selectedVisibleStocks.length,
      })
      if (res.ok) {
        const first = res.results[0]
        if (first) {
          setSelectedInsight(first)
          setInsightOpen(true)
        }
        if (res.errors.length > 0) {
          setInsightError(`部分股票解读失败：${res.errors.slice(0, 2).map(e => e.tsCode).join('、')}`)
        }
      } else {
        setInsightError((res as { error: string }).error || '批量解读失败')
      }
    } catch (err) {
      setInsightError(err instanceof Error ? err.message : '批量解读失败')
    } finally {
      setBatchRunning(false)
    }
  }, [screenerApi, selectedVisibleStocks, snapshot])

  const handleAddToTrendPool = useCallback(async () => {
    if (displayedStocks.length === 0 || trendAddBusy) return
    setTrendAddBusy(true)
    try {
      const stocks = displayedStocks.map((stock) => ({
        tsCode: stock.tsCode,
        stockName: stock.stockName,
        groupTag: '选股',
      }))
      const res = await window.api.trend.addStocks(stocks)
      if (res.ok) {
        publishAppToast(`已将 ${res.count} 只股票加入趋势池。`, 'success')
      } else {
        publishAppToast(`加入趋势池失败：${res.message ?? res.error}`, 'error')
      }
    } catch (err) {
      publishAppToast(`加入趋势池失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setTrendAddBusy(false)
    }
  }, [displayedStocks, trendAddBusy])

  return (
    <div className="flex h-full min-h-0 overflow-hidden" data-testid="personal-screener-page">
      {/* 左侧条件面板 */}
      <div
        className={`flex-shrink-0 transition-all duration-200 overflow-y-auto border-r border-gray-200 dark:border-gray-700 ${
          panelOpen ? 'w-60' : 'w-8'
        }`}
      >
        {/* 折叠手柄 */}
        <button
          onClick={() => setPanelOpen(!panelOpen)}
          className="w-full flex items-center justify-center py-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700"
          title={panelOpen ? '收起面板' : '展开面板'}
        >
          {panelOpen ? '‹' : '›'}
        </button>

        {panelOpen && (
          <div className="p-3 text-xs text-gray-600 dark:text-gray-400 space-y-4">
            <div>
              <div className="font-bold text-gray-800 dark:text-gray-200 mb-2">🎯 核心策略</div>
              <div className="bg-blue-50 dark:bg-blue-900/30 rounded p-2 space-y-1">
                <p className="font-semibold text-blue-700 dark:text-blue-300">天使线 = EMA(收盘, 2)</p>
                <p className="font-semibold text-purple-700 dark:text-purple-300">魔鬼线 = EMA(SLOPE(收盘, 21)×20 + 收盘, 42)</p>
                <p className="mt-1 text-green-700 dark:text-green-300 font-bold">✦ 金叉：天使上穿魔鬼</p>
              </div>
            </div>

            <div>
              <div className="font-bold text-gray-800 dark:text-gray-200 mb-2">📋 过滤条件（各计 1 分）</div>
              <ul className="space-y-1">
                {[
                  ['天使魔鬼金叉', '前日天使 < 魔鬼，当日天使 > 魔鬼'],
                  ['量能放大', 'VOL > MA(VOL,5) × 1.1'],
                  ['短期多头', '收盘 > MA5 > MA10'],
                  ['MACD 向好', 'DIF > DEA (12/26/9)'],
                  ['有效换手', '换手率 > 1%'],
                  ['资金净流入', '真实 moneyflow 主力净流入 > 0']
                ].map(([name, desc]) => (
                  <li key={name} className="flex gap-1">
                    <span className="text-orange-400">◆</span>
                    <span>
                      <span className="font-semibold text-gray-700 dark:text-gray-300">{name}</span>
                      <br />
                      <span className="text-gray-400">{desc}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-orange-600 dark:text-orange-400 font-semibold">信号强度 ≥ {minSignal} 分才显示</p>
              <p className="text-gray-400 mt-0.5">（右上角可动态调整）</p>
            </div>

            <div>
              <div className="font-bold text-gray-800 dark:text-gray-200 mb-2">🚫 风险排除</div>
              <ul className="space-y-0.5 text-gray-500 dark:text-gray-400">
                <li>名称含 ST（含 *ST）</li>
                <li>退市 / 暂停上市</li>
                <li>科创板（688 开头）</li>
                <li>银行 / 证券 / 房地产行业</li>
              </ul>
            </div>

            <div>
              <div className="font-bold text-gray-800 dark:text-gray-200 mb-1">📊 历史数据需求</div>
              <p className="text-gray-500 dark:text-gray-400">≥ 65 个交易日（EMA42 稳定需约 84 天）</p>
            </div>
          </div>
        )}
      </div>

      {/* 右侧结果区 */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* 工具栏 */}
        <div className="flex-shrink-0 flex items-center gap-3 px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
          <span className="text-sm font-semibold text-gray-700 dark:text-gray-300" data-testid="personal-screener-title">🔍 个性选股</span>
          {snapshot && (
            <>
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                snapshot.mode === 'realtime'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-600 dark:bg-emerald-900/30 dark:border-emerald-700 dark:text-emerald-300'
                  : snapshot.mode === 'eod-fallback'
                    ? 'bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-900/30 dark:border-amber-700 dark:text-amber-300'
                    : 'bg-gray-100 border-gray-200 text-gray-500 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-300'
              }`}>
                {snapshot.mode === 'realtime'
                  ? `实时模式 ${snapshot.rtTime ?? ''}`.trim()
                  : snapshot.mode === 'eod-fallback'
                    ? '盘中降级(盘后数据)'
                    : '盘后数据'}
              </span>
              <span className="text-xs text-gray-400 dark:text-gray-500">
                {snapshot.tradeDate.slice(0, 4)}-{snapshot.tradeDate.slice(4, 6)}-{snapshot.tradeDate.slice(6, 8)}
                {' · '}
                显示 {displayedStocks.length} / 共 {snapshot.stocks.length} 只
                {snapshot.totalScanned > 0 && ` · 扫描 ${snapshot.totalScanned} 只`}
                {snapshot.isCached && ' · 缓存'}
              </span>
            </>
          )}
          <div className="flex-1" />

          <button
            onClick={() => setRankConfigOpen(v => !v)}
            className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
              rankConfigOpen
                ? 'bg-slate-700 border-slate-700 text-white dark:bg-slate-200 dark:text-slate-900'
                : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-100 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200'
            }`}
            title="配置个性选股白盒排序权重、平手项和强度归一"
          >
            排序设置
          </button>

          {/* 信号强度选择器 */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-500 dark:text-gray-400">信号≥</span>
            <span className="flex gap-0.5">
              {[1, 2, 3, 4, 5, 6].map(i => (
                <button
                  key={i}
                  onClick={() => setMinSignal(i)}
                  title={`最低信号强度 ${i} 分`}
                  className={`w-4 h-4 rounded-sm transition-colors ${
                    i <= minSignal
                      ? minSignal >= 4
                        ? 'bg-red-500 hover:bg-red-400'
                        : 'bg-orange-400 hover:bg-orange-300'
                      : 'bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500'
                  }`}
                />
              ))}
            </span>
            <span className="text-xs font-bold text-orange-500 w-3">{minSignal}</span>
          </div>

          {/* 换手率要求 toggle */}
          <button
            onClick={() => setRequireTurnover(v => !v)}
            title={requireTurnover ? '当前：要求有效换手（点击关闭）' : '当前：不要求换手（点击开启）'}
            className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
              requireTurnover
                ? 'bg-blue-50 border-blue-300 text-blue-600 dark:bg-blue-900/30 dark:border-blue-600 dark:text-blue-300'
                : 'bg-gray-100 border-gray-300 text-gray-400 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-500'
            }`}
          >
            换手{requireTurnover ? '✓' : '—'}
          </button>

          <button
            onClick={() => { setRunning(true); void loadSnapshot(true) }}
            disabled={loading || running}
            className="text-xs px-3 py-1 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white rounded"
          >
            {running ? '计算中…' : '重新计算'}
          </button>

          {/* 监控筹码按钮：仅在有结果时显示 */}
          {displayedStocks.length > 0 && (
            <button
              onClick={() => void handleBatchInsight()}
              disabled={batchRunning || !insightApiReady || selectedVisibleStocks.length === 0 || selectedVisibleStocks.length > 10}
              data-testid="screener-batch-insight-btn"
              className="text-xs px-3 py-1 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded"
              title={insightApiReady ? '批量生成已勾选股票的本地证据解读，单次最多 10 只' : 'AI 解读接口尚未加载，请重启开发进程后再试'}
            >
              {batchRunning ? '解读中…' : `批量AI解读(${selectedVisibleStocks.length}只)`}
            </button>
          )}
          {displayedStocks.length > 0 && (
            <button
              onClick={() => setShowChipConfirm(true)}
              className="text-xs px-3 py-1 bg-purple-600 hover:bg-purple-700 text-white rounded"
            >
              监控筹码({displayedStocks.length}只)
            </button>
          )}
          {/* 加入趋势池按钮：仅在有结果时显示 */}
          {displayedStocks.length > 0 && (
            <button
              onClick={() => { void handleAddToTrendPool() }}
              disabled={trendAddBusy}
              className="text-xs px-3 py-1 bg-green-600 hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50 text-white rounded"
            >
              {trendAddBusy ? '加入中…' : `加入趋势池(${displayedStocks.length}只)`}
            </button>
          )}
          <button
            onClick={() => void loadSnapshot(false)}
            disabled={loading}
            className="text-xs px-3 py-1 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white rounded"
          >
            {loading && !running ? '加载中…' : '刷新'}
          </button>
        </div>

        {rankConfigOpen && (
          <div className="flex-shrink-0 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-850 px-4 py-3 text-xs">
            <div className="flex flex-wrap items-end gap-3">
              {(Object.keys(SIGNAL_LABELS) as ScreenerSignalKey[]).map(key => (
                <label key={key} className="flex flex-col gap-1 text-gray-500 dark:text-gray-400">
                  <span>{SIGNAL_LABELS[key]}权重</span>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={rankConfig.weights[key]}
                    onChange={e => setRankConfig(prev => ({
                      ...prev,
                      weights: { ...prev.weights, [key]: Math.max(0, Number(e.target.value) || 0) },
                    }))}
                    className="w-16 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-gray-800 dark:text-gray-100"
                  />
                </label>
              ))}
              <label className="flex flex-col gap-1 text-gray-500 dark:text-gray-400">
                <span>平手排序</span>
                <select
                  value={rankConfig.tieBreaker}
                  onChange={e => setRankConfig(prev => ({ ...prev, tieBreaker: e.target.value as ScreenerTieBreaker }))}
                  className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-gray-800 dark:text-gray-100"
                >
                  <option value="pctChg">涨跌幅</option>
                  <option value="turnoverRate">换手率</option>
                  <option value="amount">成交额</option>
                </select>
              </label>
              <label className="flex items-center gap-1 pb-1 text-gray-600 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={rankConfig.normalizeEnabled}
                  onChange={e => setRankConfig(prev => ({ ...prev, normalizeEnabled: e.target.checked }))}
                />
                强度归一
              </label>
              {(['volAmplified', 'macdBull', 'hasTurnover', 'moneyInflow'] as const).map(key => (
                <label key={key} className="flex flex-col gap-1 text-gray-500 dark:text-gray-400">
                  <span>{SIGNAL_LABELS[key]}上限</span>
                  <input
                    type="number"
                    min={0.0001}
                    step={key === 'macdBull' ? 0.01 : 0.1}
                    value={rankConfig.normalizationCaps[key]}
                    disabled={!rankConfig.normalizeEnabled}
                    onChange={e => setRankConfig(prev => ({
                      ...prev,
                      normalizationCaps: { ...prev.normalizationCaps, [key]: Math.max(0.0001, Number(e.target.value) || prev.normalizationCaps[key]) },
                    }))}
                    className="w-16 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-gray-800 dark:text-gray-100 disabled:opacity-50"
                  />
                </label>
              ))}
              <div className="flex-1 min-w-[8rem] text-[10px] leading-5 text-gray-400 dark:text-gray-500">
                仅改变排序，不改变入选规则；资金权重默认 0，AI 不参与排序。
              </div>
              <button
                onClick={() => void handleResetRankConfig()}
                disabled={rankSaving}
                className="rounded border border-gray-300 dark:border-gray-600 px-3 py-1 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                恢复默认
              </button>
              <button
                onClick={() => void handleSaveRankConfig()}
                disabled={rankSaving}
                className="rounded bg-slate-700 px-3 py-1 text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {rankSaving ? '保存中…' : '保存并重算'}
              </button>
            </div>
          </div>
        )}

        {/* 错误横幅 */}
        {errorMsg && (
          <div className={`flex-shrink-0 flex items-center gap-2 px-4 py-2 border-b text-xs ${
            errorMsg === 'DAILY_DATA_INSUFFICIENT'
              ? 'bg-orange-50 dark:bg-orange-900/30 border-orange-200 dark:border-orange-800 text-orange-700 dark:text-orange-300'
              : 'bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
          }`}>
            <span>⚠</span>
            {errorMsg === 'STOCK_BASIC_NOT_READY' ? (
              <>
                <span className="flex-1">
                  stock_basic 尚未初始化（全市场股票基础信息缓存为空），每周一 04:00 自动同步，或点击右侧按钮立即同步。
                </span>
                <button
                  onClick={async () => {
                    setSyncingBasic(true)
                    setErrorMsg('')
                    try {
                      const r = await window.api.shortTerm.syncDataNow('stockBasic')
                      if (!r.ok) {
                        setErrorMsg((r as { error: string }).error === 'TUSHARE_DISABLED'
                          ? 'Tushare 未配置，无法同步'
                          : '同步失败，请检查 Tushare 配置')
                        return
                      }
                      // 同步成功后延迟 2s 等待写库完成，再重新运行选股
                      await new Promise(res => setTimeout(res, 2000))
                      void loadSnapshot(false)
                    } catch (err) {
                      setErrorMsg(err instanceof Error ? err.message : '同步失败')
                    } finally {
                      setSyncingBasic(false)
                    }
                  }}
                  disabled={syncingBasic}
                  className="flex-shrink-0 px-2 py-1 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white rounded text-xs"
                >
                  {syncingBasic ? '同步中…' : '立即同步'}
                </button>
              </>
            ) : errorMsg === 'DAILY_DATA_INSUFFICIENT' ? (
              <div className="flex-1 flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <span className="flex-1">
                    历史日线数据不足（需 ≥65 个交易日），请点击右侧按钮初始化（约 1~3 分钟），无需手动等待每日 18:00。
                  </span>
                  <button
                    onClick={() => void handleInitDailyData()}
                    disabled={initInFlight}
                    className="flex-shrink-0 px-2 py-1 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white rounded text-xs"
                  >
                    {initInFlight ? '初始化中…' : '初始化历史数据（约1~3分钟）'}
                  </button>
                </div>
                {/* 初始化进度条 */}
                {initInFlight && initProgress && (
                  <div className="flex flex-col gap-0.5">
                    <div className="flex justify-between text-[10px] text-orange-600 dark:text-orange-400">
                      <span>
                        已下载 {initProgress.done}/{initProgress.total} 天
                        {' · '}
                        当前：{initProgress.date.slice(0, 4)}-{initProgress.date.slice(4, 6)}-{initProgress.date.slice(6, 8)}
                      </span>
                      <span>{Math.round((initProgress.done / initProgress.total) * 100)}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-orange-200 dark:bg-orange-900 rounded overflow-hidden">
                      <div
                        className="h-full bg-orange-500 dark:bg-orange-400 rounded transition-all duration-300"
                        style={{ width: `${(initProgress.done / initProgress.total) * 100}%` }}
                      />
                    </div>
                  </div>
                )}
                {initInFlight && !initProgress && (
                  <span className="text-[10px] text-orange-500 dark:text-orange-400">正在拉取交易日历…</span>
                )}
              </div>
            ) : (
              <>
                <span className="flex-1">{errorMsg}</span>
                <button onClick={() => setErrorMsg('')} className="text-red-400 hover:text-red-600">✕</button>
              </>
            )}
          </div>
        )}

        {(batchRunning || batchProgress || insightError) && (
          <div className="flex-shrink-0 flex items-center gap-2 px-4 py-1.5 border-b border-indigo-100 dark:border-indigo-900/50 bg-indigo-50 dark:bg-indigo-950/30 text-xs text-indigo-700 dark:text-indigo-300">
            {batchRunning && batchProgress ? (
              <>
                <span>AI 解读进度 {batchProgress.current}/{batchProgress.total}</span>
                {batchProgress.tsCode && <span className="font-mono text-[10px]">{batchProgress.tsCode}</span>}
                <div className="h-1.5 w-32 bg-indigo-100 dark:bg-indigo-900 rounded overflow-hidden">
                  <div
                    className="h-full bg-indigo-500 transition-all duration-300"
                    style={{ width: `${batchProgress.total > 0 ? (batchProgress.current / batchProgress.total) * 100 : 0}%` }}
                  />
                </div>
              </>
            ) : insightError ? (
              <span className="text-red-600 dark:text-red-300">{insightError}</span>
            ) : null}
            <div className="flex-1" />
            {insightError && (
              <button onClick={() => setInsightError('')} className="text-indigo-400 hover:text-indigo-600">×</button>
            )}
          </div>
        )}

        {/* loading 占位 */}
        {loading && !snapshot && (
          <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500 text-sm">
            正在计算选股信号，全市场约需 1~3 秒…
          </div>
        )}

        {/* 空结果 */}
        {!loading && !errorMsg && snapshot && displayedStocks.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-400 dark:text-gray-500 text-sm gap-2">
            <span className="text-4xl">🔍</span>
            {snapshot.stocks.length === 0
              ? <p>当日未找到满足任何信号的股票</p>
              : <p>当前过滤条件（信号 ≥ {minSignal}{requireTurnover ? ' + 有效换手' : ''}）无匹配股票</p>
            }
            <p className="text-xs">可尝试降低信号强度门槛或关闭换手要求</p>
          </div>
        )}

        {/* 结果表格 */}
        {snapshot && displayedStocks.length > 0 && (
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                <tr>
                  <th className="px-2 py-1.5 text-left w-8">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      ref={el => {
                        if (el) el.indeterminate = someVisibleSelected && !allVisibleSelected
                      }}
                      onChange={handleToggleSelectAllInsights}
                      data-testid="screener-select-all-insights"
                      className="h-3.5 w-3.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                      title="选择当前可见股票"
                    />
                  </th>
                  <th className="px-2 py-1.5 text-left">代码</th>
                  <th className="px-2 py-1.5 text-left">名称</th>
                  <th className="px-2 py-1.5 text-right">现价</th>
                  <th className="px-2 py-1.5 text-right">涨幅%</th>
                  <th className="px-2 py-1.5 text-right">换手率%</th>
                  <th className="px-2 py-1.5 text-right">成交额</th>
                  <th className="px-2 py-1.5 text-right">排序分</th>
                  <th className="px-2 py-1.5 text-right">主力净流入</th>
                  <th className="px-2 py-1.5 text-left">题材</th>
                  <th className="px-2 py-1.5 text-left">信号强度</th>
                  <th className="px-2 py-1.5 text-left">满足条件</th>
                  <th className="px-2 py-1.5 text-right">解读</th>
                </tr>
              </thead>
              <tbody>
                {displayedStocks.map((stock, idx) => (
                  <tr
                    key={stock.tsCode}
                    onClick={() => handleRowClick(stock)}
                    className={`cursor-pointer border-b border-gray-100 dark:border-gray-700 hover:bg-blue-50 dark:hover:bg-blue-900/20 ${
                      idx % 2 === 0 ? 'bg-white dark:bg-gray-800' : 'bg-gray-50 dark:bg-gray-800/50'
                    }`}
                  >
                    <td className="px-2 py-1.5" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedInsightCodes.includes(stock.tsCode)}
                        onChange={() => handleToggleInsightCode(stock.tsCode)}
                        data-testid="screener-insight-select"
                        className="h-3.5 w-3.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                        title={`选择 ${stock.stockName} 进行批量 AI 解读`}
                      />
                    </td>
                    <td className="px-2 py-1.5 text-gray-500 dark:text-gray-400 font-mono">
                      {stock.tsCode.split('.')[0]}
                    </td>
                    <td className="px-2 py-1.5 text-gray-800 dark:text-gray-200 font-medium max-w-[6rem] truncate">
                      {stock.stockName}
                    </td>
                    <td className="px-2 py-1.5 text-right text-gray-700 dark:text-gray-300">
                      {stock.close.toFixed(2)}
                    </td>
                    <td className={`px-2 py-1.5 text-right ${pctColor(stock.pctChg)}`}>
                      {stock.pctChg >= 0 ? '+' : ''}{stock.pctChg.toFixed(2)}%
                    </td>
                    <td className="px-2 py-1.5 text-right text-gray-600 dark:text-gray-400">
                      {stock.turnoverRate == null ? (
                        <span title="当日换手率缺失">--</span>
                      ) : (
                        `${stock.turnoverRate.toFixed(2)}%`
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right text-gray-600 dark:text-gray-400">
                      {fmtAmount(stock.amount)}
                    </td>
                    <td
                      className="px-2 py-1.5 text-right text-slate-700 dark:text-slate-200 font-mono"
                      title={(stock.rankBreakdown ?? []).map(item => `${item.label}: ${item.strength.toFixed(2)} × ${item.weight} = ${item.contribution.toFixed(2)}`).join('\n')}
                    >
                      {(stock.rankScore ?? stock.signalScore).toFixed(2)}
                    </td>
                    <td
                      className={`px-2 py-1.5 text-right ${(stock.moneyFlow?.mainNetInflow ?? 0) > 0 ? 'text-red-500 dark:text-red-300' : (stock.moneyFlow?.mainNetInflow ?? 0) < 0 ? 'text-green-600 dark:text-green-400' : 'text-gray-400'}`}
                      title={stock.moneyFlow?.source === 'real'
                        ? `真实 moneyflow\n主力净占比：${stock.moneyFlow.mainNetInflowRatio == null ? '--' : stock.moneyFlow.mainNetInflowRatio.toFixed(2) + '%'}\n全档净流入：${fmtSignedAmount(stock.moneyFlow.netMfAmount)}`
                        : stock.moneyFlow?.source === 'estimated'
                        ? `真实资金分档未发布或无 Tushare 权限（估算占位，不计入信号）\n当日成交额：${fmtAmount(stock.amount)}\n涨跌：${stock.pctChg > 0 ? '+' : ''}${stock.pctChg.toFixed(2)}%`
                        : '资金数据缺失，不计入信号'}
                    >
                      {stock.moneyFlow?.source === 'real' ? fmtSignedAmount(stock.moneyFlow.mainNetInflow) : '--'}
                    </td>
                    <td className="px-2 py-1.5 max-w-[8rem]">
                      <div className="flex flex-wrap gap-0.5">
                        {stock.concepts.slice(0, 3).map(c => (
                          <span key={c} className="px-1 py-0.5 bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 rounded text-[10px]">
                            {c}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-2 py-1.5">
                      <ScoreBar score={stock.signalScore} />
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex flex-wrap gap-0.5">
                        {stock.conditionsMet.map(c => (
                          <span key={c} className="px-1 py-0.5 bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 rounded text-[10px]">
                            {CONDITION_LABELS[c] ?? c}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <button
                        onClick={e => {
                          e.stopPropagation()
                          void handleInsight(stock)
                        }}
                        disabled={insightLoadingCode === stock.tsCode || !insightApiReady}
                        data-testid="screener-insight-btn"
                        className="px-2 py-1 rounded border border-indigo-200 dark:border-indigo-700 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 disabled:opacity-50"
                        title={insightApiReady ? '生成该股票的本地证据解读' : 'AI 解读接口尚未加载，请重启开发进程后再试'}
                      >
                        {insightLoadingCode === stock.tsCode ? '生成中' : 'AI解读'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 股票近期日K与筹码峰抽屉 */}
      {clickedStock && (
        <StockKlineChipDrawer
          tsCode={clickedStock.tsCode}
          stockName={clickedStock.stockName}
          onClose={handleCloseChart}
          onNavigate={() => {
            handleCloseChart()
          }}
        />
      )}

      {/* FR-156 筹码监控确认弹窗 */}
      {showChipConfirm && (
        <>
          <div className="fixed inset-0 z-[10000] bg-black/50" onClick={() => setShowChipConfirm(false)} />
          <div className="fixed z-[10001] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2
            w-80 bg-white dark:bg-gray-800 rounded-lg shadow-xl p-5 flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
              📊 启动筹码监控
            </h3>
            <p className="text-xs text-gray-600 dark:text-gray-300">
              将对当前 <span className="font-bold text-purple-600 dark:text-purple-400">{displayedStocks.length} 只</span> 选股结果，
              拉取近 5 个交易日的筹码分布并计算底部占比与松动指标。
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              预计约 <span className="font-bold">{Math.max(1, Math.ceil(displayedStocks.length * 5 / 3 / 60))} 分钟</span>（每分钟约 3 只批次）。
              任务后台运行，期间可正常使用其他功能。
            </p>
            <div className="flex justify-end gap-2 mt-1">
              <button
                onClick={() => setShowChipConfirm(false)}
                className="text-xs px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600
                  text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                取消
              </button>
              <button
                onClick={() => {
                  setShowChipConfirm(false)
                  const stocks = displayedStocks.map(s => ({
                    tsCode: s.tsCode,
                    stockName: s.stockName,
                    source: 'screener' as const,
                  }))
                  void window.api.shortTerm.chipMonitorStart({ stocks })
                  setShortTermActiveSubTab('chipMonitor')
                }}
                className="text-xs px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-700 text-white font-medium"
              >
                确认，前往监控
              </button>
            </div>
          </div>
        </>
      )}

      {insightOpen && (
        <div className="fixed inset-0 z-[10002] flex justify-end bg-black/30" data-testid="screener-insight-drawer" onClick={() => setInsightOpen(false)}>
          <aside
            className="h-full w-full max-w-md bg-white dark:bg-gray-900 shadow-2xl border-l border-gray-200 dark:border-gray-700 flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  个性选股 AI 解读
                </h3>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">
                  {selectedInsight ? `${selectedInsight.stockName ?? selectedInsight.tsCode} · ${selectedInsight.tsCode}` : '正在生成本地证据解读'}
                </p>
              </div>
              <button
                onClick={() => setInsightOpen(false)}
                className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-lg leading-none"
              >
                ×
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 text-sm">
              {insightLoadingCode && !selectedInsight ? (
                <div className="text-gray-500 dark:text-gray-400 text-sm">正在装配证据并生成解读…</div>
              ) : selectedInsight ? (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedInsight.evidenceSummary.map(item => (
                      <span key={item} className="px-2 py-1 rounded bg-gray-100 dark:bg-gray-800 text-xs text-gray-600 dark:text-gray-300">
                        {item}
                      </span>
                    ))}
                  </div>

                  {selectedInsight.complianceBlocked && (
                    <div className="rounded border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                      原始输出未通过边界检查，已切换为本地证据安全摘要。
                    </div>
                  )}

                  {[
                    ['命中归因', selectedInsight.sections.hitReason],
                    ['题材/产业链催化', selectedInsight.sections.catalyst],
                    ['趋势/筹码/持仓面', selectedInsight.sections.technicalContext],
                    ['风险与不确定性', selectedInsight.sections.risks],
                  ].map(([title, text]) => (
                    <section key={title} className="space-y-1.5">
                      <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400">{title}</h4>
                      <p className="text-sm leading-6 text-gray-800 dark:text-gray-100 whitespace-pre-wrap">{text}</p>
                    </section>
                  ))}

                  <div className="rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 px-3 py-2 text-xs text-gray-500 dark:text-gray-400 space-y-1">
                    <p>{selectedInsight.confidenceBoundary}</p>
                    <p>
                      {selectedInsight.fromCache ? '缓存命中' : '本次生成'}
                      {selectedInsight.provider ? ` · ${selectedInsight.provider}/${selectedInsight.model ?? ''}` : ''}
                      {selectedInsight.usage?.totalTokens ? ` · ${selectedInsight.usage.totalTokens} tokens` : ''}
                    </p>
                  </div>
                </>
              ) : (
                <div className="text-gray-500 dark:text-gray-400 text-sm">请选择一只股票生成解读。</div>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
