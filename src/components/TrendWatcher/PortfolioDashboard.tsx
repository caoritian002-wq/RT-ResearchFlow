import { useCallback, useEffect, useMemo, useState } from 'react'
import { ForecastPanel } from '../ForecastPanel/ForecastPanel'
import { StockKlineChipDrawer } from '../shared/StockMiniChart'
import { useAppStore } from '../../store/appStore'
import { getConclusion } from '../../utils/chipColors'
import { LocalTrendSummaryPanel } from './LocalTrendSummaryPanel'
import {
  MetricCell,
  ScoreSparkline,
  TrendBenchmarkMeta,
  TrendPageHeader,
  TrendStateBadge,
  WorkbenchError,
  formatSigned,
  formatTrendDate,
  valueTone,
} from './TrendWorkbenchUi'
import type { PositionAdvice, TrendBenchmarkHealth, TrendWorkbenchItem, TrendWorkbenchPageProps } from './trendWorkbenchTypes'

interface PortfolioDashboardItem {
  tsCode: string
  stockCode: string
  stockName: string
  addedAt: number
  costPrice: number | null
  price: number | null
  change: number | null
  profitPct: number | null
  positionAdvice: PositionAdvice | null
  positionAdviceReason: string | null
  forecast: {
    provider: string
    model: string | null
    targetDate: string | null
    direction: string | null
    summary: string | null
    createdAt: number
    backtestDirection: string | null
    backtestMape: number | null
  } | null
  todaySignals: { count: number; maxPriority: number | null; latestTitle: string | null; latestSignalTime: number | null }
  news: Array<{ briefingId: number; title: string; impactLevel: string | null; publishedAt: number | null }>
  supplyChain: { topNodes: string[] } | null
  sectorFlow: {
    conceptName: string
    metricMode: 'verified_flow' | 'turnover_strength'
    mainNetInflow: number | null
    mainNetInflowRate: number | null
    turnoverDirectionStrength: number | null
    weightedChange: number | null
  } | null
}

interface PortfolioViewItem extends PortfolioDashboardItem {
  trendItem: TrendWorkbenchItem | null
}

type BackfillProvider = 'tushare' | 'eastmoney' | 'local-cache'

interface BackfillStockResult {
  tsCode: string
  provider: BackfillProvider
  latestTradeDate: string | null
  bars: number
  state: 'ready' | 'partial' | 'missing'
  message: string
  error: string | null
}

interface BackfillResult {
  requested: number
  synced: number
  skipped: number
  failed: number
  benchmark: TrendBenchmarkHealth
  stocks: BackfillStockResult[]
}

interface BackfillProgress {
  current: number
  total: number
  detail: string
}

const ADVICE_META: Record<PositionAdvice, { label: string; className: string }> = {
  STOP_LOSS: { label: '风险复核', className: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300' },
  TAKE_PROFIT: { label: '止盈观察', className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300' },
  WATCH: { label: '继续观察', className: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200' },
  HOLD: { label: '结构持有', className: 'border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-300' },
}

export function PortfolioDashboard({ snapshot, loading, errorMessage, onRefresh }: TrendWorkbenchPageProps) {
  const [portfolioItems, setPortfolioItems] = useState<PortfolioDashboardItem[]>([])
  const [portfolioLoading, setPortfolioLoading] = useState(false)
  const [portfolioError, setPortfolioError] = useState('')
  const [selectedCode, setSelectedCode] = useState<string | null>(null)
  const [savingCode, setSavingCode] = useState<string | null>(null)
  const [forecasting, setForecasting] = useState(false)
  const [backfillRunning, setBackfillRunning] = useState(false)
  const [backfillProgress, setBackfillProgress] = useState<BackfillProgress | null>(null)
  const [backfillResult, setBackfillResult] = useState<BackfillResult | null>(null)
  const [chartStock, setChartStock] = useState<PortfolioViewItem | null>(null)
  const [forecastStock, setForecastStock] = useState<PortfolioViewItem | null>(null)
  const navigateToStock = useAppStore((state) => state.navigateToStock)

  const loadPortfolio = useCallback(async () => {
    setPortfolioLoading(true)
    try {
      const response = await window.api.portfolio.getDashboard()
      if (!response.ok || !response.data) {
        setPortfolioError(response.message ?? '持仓聚合数据加载失败')
        return
      }
      setPortfolioItems(response.data as PortfolioDashboardItem[])
      setPortfolioError('')
    } catch {
      setPortfolioError('持仓聚合数据加载失败')
    } finally {
      setPortfolioLoading(false)
    }
  }, [])

  useEffect(() => { void loadPortfolio() }, [loadPortfolio])

  useEffect(() => {
    const offProgress = window.api.trend.onBackfillProgress((progress) => {
      setBackfillRunning(true)
      setBackfillProgress({
        current: progress.current,
        total: progress.total,
        detail: `${stripCode(progress.tsCode)} · ${backfillStatusLabel(progress.status)} · ${providerLabel(progress.provider)}`,
      })
    })
    const offDone = window.api.trend.onBackfillDone((result) => {
      setBackfillRunning(false)
      setBackfillProgress({
        current: result.requested,
        total: result.requested,
        detail: `更新${result.synced}只 · 复用${result.skipped}只 · 未完成${result.failed}只`,
      })
      void loadPortfolio()
      onRefresh()
    })
    return () => {
      offProgress()
      offDone()
    }
  }, [loadPortfolio, onRefresh])

  const items = useMemo<PortfolioViewItem[]>(() => {
    const trendByCode = new Map((snapshot?.items ?? []).map((item) => [item.stockCode, item]))
    const rank: Record<PositionAdvice, number> = { STOP_LOSS: 0, TAKE_PROFIT: 1, WATCH: 2, HOLD: 3 }
    return portfolioItems
      .map((item) => ({ ...item, trendItem: trendByCode.get(item.stockCode) ?? null }))
      .sort((left, right) => {
        const advice = (left.positionAdvice ? rank[left.positionAdvice] : 4) - (right.positionAdvice ? rank[right.positionAdvice] : 4)
        if (advice !== 0) return advice
        const delta = (left.trendItem?.scoreDelta5d ?? 999) - (right.trendItem?.scoreDelta5d ?? 999)
        if (delta !== 0) return delta
        const priority = (right.todaySignals.maxPriority ?? 0) - (left.todaySignals.maxPriority ?? 0)
        if (priority !== 0) return priority
        return (right.trendItem?.totalScore ?? -1) - (left.trendItem?.totalScore ?? -1)
      })
  }, [portfolioItems, snapshot?.items])

  useEffect(() => {
    if (items.length === 0) {
      setSelectedCode(null)
      return
    }
    if (!selectedCode || !items.some((item) => item.stockCode === selectedCode)) setSelectedCode(items[0].stockCode)
  }, [items, selectedCode])

  const selected = items.find((item) => item.stockCode === selectedCode) ?? items[0] ?? null
  const missingCodes = useMemo(() => items
    .filter((item) => item.trendItem?.dataCoverage.state !== 'ready')
    .map((item) => item.tsCode), [items])
  const backfillByCode = useMemo(() => new Map(
    (backfillResult?.stocks ?? []).map((item) => [stripCode(item.tsCode), item]),
  ), [backfillResult?.stocks])
  const summary = useMemo(() => ({
    review: items.filter((item) => item.positionAdvice === 'STOP_LOSS' || item.trendItem?.trendState === 'broken').length,
    weakening: items.filter((item) => item.trendItem?.trendState === 'weakening').length,
    stable: items.filter((item) => ['strong', 'stable', 'strengthening'].includes(item.trendItem?.trendState ?? '')).length,
    missing: items.filter((item) => item.trendItem?.dataCoverage.state !== 'ready').length,
  }), [items])

  const refreshAll = () => {
    onRefresh()
    void loadPortfolio()
  }

  const saveCost = async (item: PortfolioViewItem, raw: string) => {
    const value = raw.trim() === '' ? null : Number(raw)
    if (value != null && (!Number.isFinite(value) || value <= 0)) {
      setPortfolioError('成本价必须为正数')
      return
    }
    setSavingCode(item.tsCode)
    try {
      const response = await window.api.portfolio.updateCostPrice(item.tsCode, value)
      if (!response.ok) {
        setPortfolioError(response.message ?? '成本价保存失败')
        return
      }
      refreshAll()
    } finally {
      setSavingCode(null)
    }
  }

  const forecastAll = async () => {
    setForecasting(true)
    try {
      const response = await window.api.portfolio.forecastNow()
      if (!response.ok) setPortfolioError(response.code === 'ALREADY_RUNNING' ? '持仓预测正在进行中' : '预测任务启动失败')
    } finally {
      setForecasting(false)
    }
  }

  const runBackfill = useCallback(async (codes: string[]) => {
    const uniqueCodes = [...new Set(codes)]
    if (uniqueCodes.length === 0 || backfillRunning) return
    setPortfolioError('')
    setBackfillResult(null)
    setBackfillRunning(true)
    setBackfillProgress({ current: 0, total: uniqueCodes.length, detail: '正在检查本地日线覆盖' })
    try {
      const response = await window.api.trend.backfillStocks(uniqueCodes)
      if (!response.ok || !response.data) {
        setPortfolioError(response.message ?? response.error ?? '持仓日线补齐失败')
        return
      }
      setBackfillResult(response.data as BackfillResult)
      setBackfillProgress({
        current: response.data.requested,
        total: response.data.requested,
        detail: `更新${response.data.synced}只 · 复用${response.data.skipped}只 · 未完成${response.data.failed}只`,
      })
      onRefresh()
      void loadPortfolio()
    } catch {
      setPortfolioError('持仓日线补齐失败，请稍后重试')
    } finally {
      setBackfillRunning(false)
    }
  }, [backfillRunning, loadPortfolio, onRefresh])

  return (
    <div data-testid="trend-portfolio-overview" className="flex h-full min-h-0 flex-col overflow-y-auto">
      <TrendPageHeader
        title="持仓总览"
        subtitle="按风险、趋势恶化和今日信号排序，先处理最需要复核的股票"
        loading={loading || portfolioLoading}
        onRefresh={refreshAll}
        meta={snapshot && (
          <span className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span>{items.length}只持仓 · 评分至 {formatTrendDate(snapshot.dataHealth.latestTradeDate)}</span>
            {snapshot.dataHealth.benchmark && <TrendBenchmarkMeta health={snapshot.dataHealth.benchmark} />}
          </span>
        )}
        actions={(
          <div className="flex flex-wrap gap-2">
            {missingCodes.length > 0 && (
              <button
                type="button"
                data-testid="portfolio-backfill-all"
                onClick={() => { void runBackfill(missingCodes) }}
                disabled={backfillRunning}
                className="min-h-11 rounded-md border border-cyan-600 bg-white px-3 text-sm font-semibold text-cyan-700 transition-colors hover:bg-cyan-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:cursor-wait disabled:opacity-45 dark:border-cyan-700 dark:bg-slate-950 dark:text-cyan-300 dark:hover:bg-cyan-950/40"
              >{backfillRunning ? '补齐进行中' : `补齐数据缺口 ${missingCodes.length}`}</button>
            )}
            <button
              type="button"
              onClick={() => { void forecastAll() }}
              disabled={forecasting || items.length === 0}
              className="min-h-11 rounded-md bg-slate-900 px-3 text-sm font-medium text-white transition-colors hover:bg-cyan-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:cursor-not-allowed disabled:opacity-45 dark:bg-cyan-500 dark:text-slate-950 dark:hover:bg-cyan-400"
            >{forecasting ? '任务启动中…' : '批量预测'}</button>
          </div>
        )}
      />

      {(errorMessage || portfolioError) && <WorkbenchError message={portfolioError || errorMessage} onRetry={refreshAll} />}

      <div className="grid grid-cols-2 border-b border-slate-200 bg-white sm:grid-cols-4 dark:border-slate-800 dark:bg-slate-950">
        <Summary label="需要复核" value={summary.review} tone="risk" />
        <Summary label="趋势转弱" value={summary.weakening} tone="warning" />
        <Summary label="相对稳定" value={summary.stable} tone="normal" />
        <Summary label="数据待补" value={summary.missing} tone="warning" />
      </div>

      {(backfillProgress || backfillResult) && (
        <section data-testid="portfolio-backfill-status" aria-live="polite" className="border-b border-slate-200 bg-cyan-50/60 px-4 py-3 dark:border-slate-800 dark:bg-cyan-950/20 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-medium text-slate-700 dark:text-slate-200">持仓数据补齐</span>
            <span className="text-slate-500 dark:text-slate-400">{backfillProgress?.detail}</span>
          </div>
          {backfillProgress && backfillProgress.total > 0 && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800" role="progressbar" aria-label="持仓数据补齐进度" aria-valuemin={0} aria-valuemax={backfillProgress.total} aria-valuenow={backfillProgress.current}>
              <div className="h-full rounded-full bg-cyan-600 transition-[width] motion-reduce:transition-none dark:bg-cyan-400" style={{ width: `${Math.min(100, backfillProgress.current / backfillProgress.total * 100)}%` }} />
            </div>
          )}
          {backfillResult && backfillResult.failed > 0 && (
            <div className="mt-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
              {backfillResult.stocks.filter((item) => item.error).map((item) => `${stripCode(item.tsCode)}：${item.message}`).join('；')}
            </div>
          )}
          {backfillResult && (
            <div data-testid="portfolio-backfill-benchmark" data-state={backfillResult.benchmark.state} className={`mt-2 text-xs leading-5 ${backfillResult.benchmark.state === 'current' ? 'text-cyan-700 dark:text-cyan-300' : 'text-amber-700 dark:text-amber-300'}`}>
              {backfillResult.benchmark.message}
            </div>
          )}
        </section>
      )}

      {!snapshot && loading ? (
        <div className="space-y-2 p-5">{Array.from({ length: 6 }, (_, index) => <div key={index} className="h-14 animate-pulse rounded bg-slate-200 motion-reduce:animate-none dark:bg-slate-800" />)}</div>
      ) : items.length === 0 ? (
        <div className="flex min-h-64 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <div className="text-sm font-medium text-slate-700 dark:text-slate-200">暂无持仓股票</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">在股票走势图中加入持仓后，这里会自动形成风险排序</div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[340px_minmax(0,1fr)]">
          <div className="min-h-0 border-b border-slate-200 bg-white xl:border-b-0 xl:border-r dark:border-slate-800 dark:bg-slate-950">
            <div className="border-b border-slate-200 px-4 py-2 text-xs font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400">按复核优先级排序</div>
            <div className="max-h-[340px] overflow-y-auto xl:max-h-none xl:h-[calc(100%-37px)]">
              {items.map((item) => (
                <button
                  key={item.tsCode}
                  type="button"
                  onClick={() => setSelectedCode(item.stockCode)}
                  className={`grid min-h-[68px] w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-slate-100 px-4 py-2 text-left transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500 dark:border-slate-900 ${
                    selected?.stockCode === item.stockCode ? 'bg-cyan-50 dark:bg-cyan-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-900'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{item.stockName}</span>
                      {item.positionAdvice && <AdviceBadge advice={item.positionAdvice} />}
                    </span>
                    <span className="mt-1 flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                      <span className="font-mono">{item.stockCode}</span>
                      <span>{item.todaySignals.count}条今日信号</span>
                      <span className={coverageTone(item.trendItem?.dataCoverage.state)}>{coverageShortLabel(item.trendItem)}</span>
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block text-sm font-semibold tabular-nums">{item.trendItem?.totalScore ?? '—'}</span>
                    <span className={`mt-1 block text-[11px] tabular-nums ${valueTone(item.trendItem?.scoreDelta5d)}`}>{formatSigned(item.trendItem?.scoreDelta5d)}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          {selected && (
            <div className="min-h-0 overflow-y-auto bg-slate-50 dark:bg-slate-950">
              <div className="border-b border-slate-200 bg-white px-5 py-4 dark:border-slate-800 dark:bg-slate-950">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-semibold">{selected.stockName}</h2>
                      {selected.trendItem && <TrendStateBadge state={selected.trendItem.trendState} />}
                    </div>
                    <div className="mt-1 text-xs font-mono text-slate-500 dark:text-slate-400">{selected.tsCode}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {selected.trendItem?.dataCoverage.state !== 'ready' && (
                      <button type="button" data-testid="portfolio-backfill-selected" onClick={() => { void runBackfill([selected.tsCode]) }} disabled={backfillRunning} className="min-h-11 rounded-md border border-cyan-600 bg-white px-3 text-sm font-semibold text-cyan-700 hover:bg-cyan-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:cursor-wait disabled:opacity-45 dark:border-cyan-700 dark:bg-slate-950 dark:text-cyan-300 dark:hover:bg-cyan-950/40">补齐这只股票</button>
                    )}
                    <button type="button" onClick={() => setChartStock(selected)} className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium hover:border-cyan-400 hover:text-cyan-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-cyan-600 dark:hover:text-cyan-300">日K与筹码</button>
                    <button type="button" onClick={() => setForecastStock(selected)} className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium hover:border-cyan-400 hover:text-cyan-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-cyan-600 dark:hover:text-cyan-300">预测记录</button>
                    <button type="button" onClick={() => navigateToStock(selected.stockCode, selected.stockName)} className="min-h-11 rounded-md bg-slate-900 px-3 text-sm font-medium text-white hover:bg-cyan-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:bg-cyan-500 dark:text-slate-950">完整研判</button>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-y-4 sm:grid-cols-4">
                  <MetricCell label="现价" value={selected.price == null ? '—' : selected.price.toFixed(2)} />
                  <MetricCell label="当日涨跌" value={<span className={valueTone(selected.change)}>{formatSigned(selected.change, '%', 2)}</span>} />
                  <MetricCell label="成本 / 浮盈亏" value={<CostEditor item={selected} saving={savingCode === selected.tsCode} onSave={saveCost} />} />
                  <MetricCell label="趋势分 / 5日变化" value={<span>{selected.trendItem?.totalScore ?? '—'} <span className={valueTone(selected.trendItem?.scoreDelta5d)}>{formatSigned(selected.trendItem?.scoreDelta5d)}</span></span>} />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-px bg-slate-200 dark:bg-slate-800 lg:grid-cols-2">
                <DetailSection title="趋势结构" subtitle={coverageDetail(selected.trendItem, backfillByCode.get(selected.stockCode))}>
                  {selected.trendItem ? (
                    <>
                      <LocalTrendSummaryPanel item={selected.trendItem} />
                      <div className="mt-4 flex items-center justify-between gap-4 border-t border-slate-200 pt-4 dark:border-slate-800">
                        <ScoreSparkline points={selected.trendItem.scoreHistory} label={`${selected.stockName}评分轨迹`} />
                        <div className="text-right text-xs text-slate-500 dark:text-slate-400">20日变化<br /><span className={`text-sm font-semibold ${valueTone(selected.trendItem.scoreDelta20d)}`}>{formatSigned(selected.trendItem.scoreDelta20d)}</span></div>
                      </div>
                      <div className="mt-4 space-y-2">
                        <DimensionRow label="均线排列" value={selected.trendItem.dimensions?.maArrangement ?? null} />
                        <DimensionRow label="相对强度" value={selected.trendItem.dimensions?.relativeStrength ?? null} />
                        <DimensionRow label="回撤质量" value={selected.trendItem.dimensions?.drawdownQuality ?? null} />
                        <DimensionRow label="量能质量" value={selected.trendItem.dimensions?.turnoverQuality ?? null} />
                      </div>
                    </>
                  ) : <EmptyText>暂无趋势评分</EmptyText>}
                </DetailSection>

                <DetailSection title="持仓与筹码" subtitle="规则提示仅用于复核，不代表交易指令">
                  <div className="flex flex-wrap items-center gap-2">
                    {selected.positionAdvice ? <AdviceBadge advice={selected.positionAdvice} /> : <span className="text-slate-400">缺少成本价或趋势事实</span>}
                    {selected.trendItem?.chip ? (
                      <span className="rounded border border-slate-200 px-2 py-1 text-xs dark:border-slate-700">筹码：{getConclusion(selected.trendItem.chip).label}</span>
                    ) : <span className="text-xs text-slate-400">暂无筹码摘要</span>}
                  </div>
                  <p className="mt-3 text-xs leading-5 text-slate-600 dark:text-slate-300">{selected.positionAdviceReason ?? '补充成本价后可结合趋势结构生成本地规则提示。'}</p>
                </DetailSection>

                <DetailSection title="今日信号与模型预测" subtitle="模型预测与本地事实摘要独立；只有形成回测时才显示误差结果">
                  <div className="text-sm font-medium">{selected.todaySignals.latestTitle ?? '暂无今日信号'}</div>
                  <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">共{selected.todaySignals.count}条{selected.todaySignals.maxPriority != null ? ` · 最高P${selected.todaySignals.maxPriority}` : ''}</div>
                  <div className="mt-4 border-t border-slate-200 pt-3 text-xs dark:border-slate-800">
                    {selected.forecast ? (
                      <>
                        <div className="font-medium text-slate-800 dark:text-slate-100">{directionLabel(selected.forecast.direction)} · {selected.forecast.provider}{selected.forecast.model ? ` / ${selected.forecast.model}` : ''}</div>
                        <div className="mt-1 leading-5 text-slate-600 dark:text-slate-300">{selected.forecast.summary ?? '暂无结构化摘要'}</div>
                        <div className="mt-1 text-slate-400">{selected.forecast.backtestDirection ? `回测${selected.forecast.backtestDirection === 'correct' ? '方向正确' : '方向偏差'}` : '尚未回测'}{selected.forecast.backtestMape != null ? ` · MAPE ${selected.forecast.backtestMape.toFixed(2)}%` : ''}</div>
                      </>
                    ) : <EmptyText>暂无模型预测记录</EmptyText>}
                  </div>
                </DetailSection>

                <DetailSection title="题材、板块与资讯" subtitle="概念映射不冒充产业链事实">
                  <div className="flex flex-wrap gap-1.5">
                    {(selected.supplyChain?.topNodes ?? []).slice(0, 5).map((node) => <span key={node} className="rounded border border-cyan-200 bg-cyan-50 px-2 py-1 text-xs text-cyan-700 dark:border-cyan-900 dark:bg-cyan-950/30 dark:text-cyan-300">{node}</span>)}
                    {!selected.supplyChain && <span className="text-xs text-slate-400">暂无本地题材映射</span>}
                  </div>
                  {selected.sectorFlow && <div className="mt-3 text-xs text-slate-600 dark:text-slate-300">{selected.sectorFlow.conceptName} · {selected.sectorFlow.metricMode === 'verified_flow' ? `主力资金率 ${formatSigned(selected.sectorFlow.mainNetInflowRate, '%')}` : `成交方向强度 ${formatSigned(selected.sectorFlow.turnoverDirectionStrength, '%')}`}</div>}
                  <div className="mt-3 space-y-1 border-t border-slate-200 pt-3 dark:border-slate-800">
                    {selected.news.length > 0 ? selected.news.map((news) => <div key={news.briefingId} className="truncate text-xs text-slate-600 dark:text-slate-300">{news.title}</div>) : <EmptyText>近7日暂无直接命中资讯</EmptyText>}
                  </div>
                </DetailSection>
              </div>
            </div>
          )}
        </div>
      )}

      {chartStock && (
        <StockKlineChipDrawer
          tsCode={chartStock.tsCode}
          stockName={chartStock.stockName}
          onClose={() => setChartStock(null)}
          onNavigate={() => {
            navigateToStock(chartStock.stockCode, chartStock.stockName)
            setChartStock(null)
          }}
        />
      )}
      {forecastStock && <ForecastPanel stockCode={forecastStock.stockCode} stockName={forecastStock.stockName} isOpen onClose={() => setForecastStock(null)} />}
    </div>
  )
}

function Summary({ label, value, tone }: { label: string; value: number; tone: 'risk' | 'warning' | 'normal' }) {
  const cls = tone === 'risk' ? 'text-emerald-600 dark:text-emerald-300' : tone === 'warning' ? 'text-amber-600 dark:text-amber-300' : 'text-slate-900 dark:text-slate-100'
  return <div className="border-r border-slate-200 px-4 py-3 last:border-r-0 dark:border-slate-800"><div className="text-[11px] text-slate-500 dark:text-slate-400">{label}</div><div className={`mt-1 text-xl font-semibold tabular-nums ${cls}`}>{value}</div></div>
}

function AdviceBadge({ advice }: { advice: PositionAdvice }) {
  const meta = ADVICE_META[advice]
  return <span className={`inline-flex rounded border px-2 py-0.5 text-[11px] font-medium ${meta.className}`}>{meta.label}</span>
}

function CostEditor({ item, saving, onSave }: { item: PortfolioViewItem; saving: boolean; onSave: (item: PortfolioViewItem, value: string) => void }) {
  return (
    <span className="flex items-center gap-2">
      <label className="sr-only" htmlFor={`cost-${item.stockCode}`}>成本价</label>
      <input id={`cost-${item.stockCode}`} type="number" min="0" step="0.01" defaultValue={item.costPrice ?? ''} disabled={saving} onBlur={(event) => onSave(item, event.currentTarget.value)} className="h-8 w-20 rounded border border-slate-300 bg-white px-2 text-right text-xs outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 dark:border-slate-700 dark:bg-slate-900" placeholder="成本价" />
      <span className={valueTone(item.profitPct)}>{formatSigned(item.profitPct, '%')}</span>
    </span>
  )
}

function DetailSection({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return <section className="min-h-[190px] bg-white p-5 dark:bg-slate-950"><h3 className="text-sm font-semibold">{title}</h3><p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{subtitle}</p><div className="mt-4">{children}</div></section>
}

function DimensionRow({ label, value }: { label: string; value: number | null }) {
  return <div className="grid grid-cols-[72px_minmax(0,1fr)_32px] items-center gap-2 text-xs"><span className="text-slate-500 dark:text-slate-400">{label}</span><span className="h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"><span className="block h-full rounded-full bg-cyan-500" style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} /></span><span className="text-right tabular-nums">{value == null ? '—' : Math.round(value)}</span></div>
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-slate-400">{children}</span>
}

function directionLabel(direction: string | null): string {
  if (direction === 'up') return '偏强'
  if (direction === 'down') return '偏弱'
  if (direction === 'flat') return '震荡'
  return '方向未知'
}

function stripCode(tsCode: string): string {
  return tsCode.trim().toUpperCase().replace(/\.(SH|SZ|BJ)$/i, '')
}

function providerLabel(provider: BackfillProvider | undefined): string {
  if (provider === 'tushare') return 'Tushare'
  if (provider === 'eastmoney') return '东方财富'
  if (provider === 'local-cache') return '本地缓存'
  return '来源待确认'
}

function backfillStatusLabel(status: 'synced' | 'skipped' | 'failed'): string {
  if (status === 'synced') return '已补齐'
  if (status === 'skipped') return '已复用'
  return '未完成'
}

function coverageShortLabel(item: TrendWorkbenchItem | null): string {
  const coverage = item?.dataCoverage
  if (!coverage) return '日线 0/60'
  return coverage.state === 'ready' ? `日线 ${coverage.bars}` : `日线 ${coverage.bars}/${coverage.requiredBars}`
}

function coverageTone(state: TrendWorkbenchItem['dataCoverage']['state'] | undefined): string {
  if (state === 'ready') return 'text-cyan-700 dark:text-cyan-300'
  if (state === 'partial') return 'text-amber-700 dark:text-amber-300'
  return 'text-rose-700 dark:text-rose-300'
}

function coverageDetail(item: TrendWorkbenchItem | null, result: BackfillStockResult | undefined): string {
  if (result) return result.message
  if (!item) return '本地日线 · 暂无有效覆盖'
  const date = formatTrendDate(item.dataCoverage.latestTradeDate)
  return `本地日线 · 截至 ${date} · ${item.dataCoverage.bars}日 · ${item.dataCoverage.state === 'ready' ? '可研判' : '待补齐'}`
}
