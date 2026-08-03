import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  LineSeries,
  LineStyle,
  type CandlestickData,
  type Time,
} from 'lightweight-charts'
import {
  buildRound2MarketVisualModel,
  toAshareTsCode,
  toBeijingTradeDate,
  type Round2MarketSourceRow,
  type Round2MarketVisualModel,
  type Round2TrendTone,
} from './round2MarketVisualModel'

interface Round2MarketCandidate {
  code: string
  name?: string | null
}

interface Round2InlineMarketVisualProps {
  candidate: Round2MarketCandidate
  createdAt: string
  fallback?: ReactNode
}

type CardState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; model: Round2MarketVisualModel }

interface HoveredCandle {
  tradeDate: string
  open: number
  high: number
  low: number
  close: number
}

const trendClasses: Record<Round2TrendTone, string> = {
  strong: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/35 dark:text-red-300',
  recovering: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/35 dark:text-amber-300',
  range: 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300',
  weakening: 'border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-900/70 dark:bg-cyan-950/35 dark:text-cyan-300',
  weak: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/35 dark:text-emerald-300',
}

function formatPrice(value: number | null): string {
  return value == null ? '--' : value.toFixed(value >= 100 ? 2 : 3).replace(/0+$/, '').replace(/\.$/, '')
}

function formatPercent(value: number | null): string {
  if (value == null) return '--'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function formatDate(value: string | null): string {
  if (!value || !/^\d{8}$/.test(value)) return '--'
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

function resolveChartPalette() {
  const dark = document.documentElement.classList.contains('dark')
  return dark
    ? { background: '#0f172a', text: '#94a3b8', grid: '#1e293b', border: '#334155' }
    : { background: '#ffffff', text: '#64748b', grid: '#e2e8f0', border: '#cbd5e1' }
}

function MiniMarketChart({ model, stockLabel }: { model: Round2MarketVisualModel; stockLabel: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState<HoveredCandle | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container || model.status !== 'ready') return
    const palette = resolveChartPalette()
    const chart = createChart(container, {
      autoSize: true,
      height: 170,
      layout: {
        background: { type: ColorType.Solid, color: palette.background },
        textColor: palette.text,
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: palette.grid },
      },
      leftPriceScale: { visible: false },
      rightPriceScale: { borderColor: palette.border, scaleMargins: { top: 0.12, bottom: 0.1 } },
      timeScale: {
        borderColor: palette.border,
        timeVisible: false,
        secondsVisible: false,
        rightOffset: 1,
        barSpacing: 7,
        minBarSpacing: 4,
        tickMarkFormatter: (time: Time) => {
          const value = typeof time === 'string' ? time : ''
          const parts = value.split('-')
          return parts.length === 3 ? `${parts[1]}/${parts[2]}` : value
        },
      },
      crosshair: {
        vertLine: { color: '#64748b', labelVisible: false },
        horzLine: { color: '#64748b', labelVisible: false },
      },
      handleScale: false,
      handleScroll: false,
    })
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#ef4444',
      downColor: '#16a34a',
      borderUpColor: '#ef4444',
      borderDownColor: '#16a34a',
      wickUpColor: '#ef4444',
      wickDownColor: '#16a34a',
      priceLineVisible: false,
      lastValueVisible: true,
    })
    candleSeries.setData(model.rows.map((row) => ({
      time: `${row.tradeDate.slice(0, 4)}-${row.tradeDate.slice(4, 6)}-${row.tradeDate.slice(6, 8)}` as Time,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
    })))

    const addAverage = (series: Array<{ tradeDate: string; value: number }>, color: string) => {
      if (series.length === 0) return
      const line = chart.addSeries(LineSeries, {
        color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      })
      line.setData(series.map((point) => ({
        time: `${point.tradeDate.slice(0, 4)}-${point.tradeDate.slice(4, 6)}-${point.tradeDate.slice(6, 8)}` as Time,
        value: point.value,
      })))
    }
    addAverage(model.ma5Series, '#f59e0b')
    addAverage(model.ma20Series, '#06b6d4')

    if (model.support20 != null) {
      candleSeries.createPriceLine({
        price: model.support20,
        color: '#10b981',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
        title: '',
      })
    }
    if (model.pressure20 != null && model.pressure20 !== model.support20) {
      candleSeries.createPriceLine({
        price: model.pressure20,
        color: '#f43f5e',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
        title: '',
      })
    }

    chart.timeScale().fitContent()
    chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        setHovered(null)
        return
      }
      const candle = param.seriesData.get(candleSeries) as CandlestickData<Time> | undefined
      if (!candle || !('open' in candle)) {
        setHovered(null)
        return
      }
      const tradeDate = String(param.time).replace(/-/g, '')
      setHovered({ tradeDate, open: candle.open, high: candle.high, low: candle.low, close: candle.close })
    })

    const observer = new MutationObserver(() => {
      const next = resolveChartPalette()
      chart.applyOptions({
        layout: { background: { type: ColorType.Solid, color: next.background }, textColor: next.text },
        grid: { vertLines: { visible: false }, horzLines: { color: next.grid } },
        rightPriceScale: { borderColor: next.border },
        timeScale: { borderColor: next.border },
      })
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => {
      observer.disconnect()
      chart.remove()
    }
  }, [model])

  const summary = `${stockLabel}近${model.rows.length}个交易日日K，趋势${model.trendLabel}，最新收盘${formatPrice(model.latestClose)}，近5日收益${formatPercent(model.return5)}`
  return (
    <div className="relative h-[170px] min-w-0 overflow-hidden rounded-md border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900" aria-label={summary} role="img">
      <div ref={containerRef} className="h-full w-full" data-testid="ai-round2-kline-canvas" />
      {hovered && (
        <div className="pointer-events-none absolute left-2 top-2 z-10 rounded border border-slate-200 bg-white/95 px-2 py-1 font-mono text-[10px] leading-4 text-slate-700 shadow-sm dark:border-slate-700 dark:bg-slate-950/95 dark:text-slate-200">
          <div>{formatDate(hovered.tradeDate)}</div>
          <div>开 {formatPrice(hovered.open)} 高 {formatPrice(hovered.high)}</div>
          <div>低 {formatPrice(hovered.low)} 收 {formatPrice(hovered.close)}</div>
        </div>
      )}
    </div>
  )
}

function MarketVisualCard({ candidate, state, onRetry, fallback }: { candidate: Round2MarketCandidate; state: CardState; onRetry: () => void; fallback?: ReactNode }) {
  const label = candidate.name?.trim() || candidate.code
  if (state.status === 'loading') {
    return (
      <article data-testid={`ai-round2-visual-${candidate.code}`} className="min-h-[310px] animate-pulse rounded-md border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900 motion-reduce:animate-none">
        <div className="h-5 w-32 rounded bg-slate-200 dark:bg-slate-700" />
        <div className="mt-3 h-[170px] rounded bg-slate-100 dark:bg-slate-800" />
        <div className="mt-3 h-16 rounded bg-slate-100 dark:bg-slate-800" />
      </article>
    )
  }
  if (state.status === 'error' || state.model.status === 'insufficient') {
    const message = state.status === 'error'
      ? state.message
      : state.model.reason === 'invalid_cutoff'
        ? '分析记录时间无效，无法确定历史行情截止日。'
        : `截至 ${formatDate(state.model.cutoffDate)} 仅有 ${state.model.rows.length} 个有效交易日，至少需要 10 个。`
    return (
      <article data-testid={`ai-round2-visual-${candidate.code}`} className="flex min-h-[250px] flex-col rounded-md border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center justify-between gap-3">
          <div><span className="font-semibold text-slate-900 dark:text-slate-100">{label}</span><span className="ml-2 font-mono text-xs text-slate-400">{candidate.code}</span></div>
          <span className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/35 dark:text-amber-300">行情不足</span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center px-4 text-center text-xs leading-5 text-slate-500 dark:text-slate-400">
          <p>{message}</p>
          <button type="button" onClick={onRetry} className="mt-3 min-h-10 rounded-md border border-slate-300 bg-white px-3 font-medium text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">重试读取</button>
          {fallback && (
            <div className="mt-3 w-full rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-left text-slate-700 dark:border-amber-900/70 dark:bg-amber-950/25 dark:text-slate-300">
              <div className="mb-1 font-medium text-amber-800 dark:text-amber-300">保留模型原始观察参考</div>
              {fallback}
            </div>
          )}
        </div>
      </article>
    )
  }

  const model = state.model
  return (
    <article data-testid={`ai-round2-visual-${candidate.code}`} className="min-w-0 rounded-md border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-semibold text-slate-950 dark:text-slate-100">{label}</div>
          <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-slate-400"><span>{candidate.code}</span><span>{formatDate(model.latestTradeDate)}</span></div>
        </div>
        <span className={`shrink-0 rounded border px-2 py-1 text-xs font-semibold ${trendClasses[model.trendTone!]}`}>趋势 {model.trendLabel}</span>
      </div>

      <div className="mt-3">
        <MiniMarketChart model={model} stockLabel={label} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
        <span className="inline-flex items-center gap-1"><i className="h-0.5 w-3 bg-amber-500" aria-hidden="true" />MA5 {formatPrice(model.ma5)}</span>
        <span className="inline-flex items-center gap-1"><i className="h-0.5 w-3 bg-cyan-500" aria-hidden="true" />MA20 {formatPrice(model.ma20)}</span>
        <span>样本 {model.rows.length} 日</span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 dark:border-slate-700 dark:bg-slate-700 sm:grid-cols-4">
        <div className="min-w-0 bg-slate-50 px-2.5 py-2 dark:bg-slate-950/60"><dt className="text-[10px] text-slate-500 dark:text-slate-400">最新 / 5日</dt><dd className="mt-1 truncate font-mono text-xs font-semibold text-slate-800 dark:text-slate-100">{formatPrice(model.latestClose)} <span className={model.return5 != null && model.return5 < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>{formatPercent(model.return5)}</span></dd></div>
        <div className="min-w-0 bg-slate-50 px-2.5 py-2 dark:bg-slate-950/60"><dt className="text-[10px] text-slate-500 dark:text-slate-400">20日收益</dt><dd className="mt-1 truncate font-mono text-xs font-semibold text-slate-800 dark:text-slate-100">{formatPercent(model.return20)}</dd></div>
        <div className="min-w-0 bg-slate-50 px-2.5 py-2 dark:bg-slate-950/60"><dt className="text-[10px] text-slate-500 dark:text-slate-400">支撑观察 5 / 20日</dt><dd className="mt-1 truncate font-mono text-xs font-semibold text-emerald-700 dark:text-emerald-300">{formatPrice(model.support5)} / {formatPrice(model.support20)}</dd></div>
        <div className="min-w-0 bg-slate-50 px-2.5 py-2 dark:bg-slate-950/60"><dt className="text-[10px] text-slate-500 dark:text-slate-400">压力观察 5 / 20日</dt><dd className="mt-1 truncate font-mono text-xs font-semibold text-rose-700 dark:text-rose-300">{formatPrice(model.pressure5)} / {formatPrice(model.pressure20)}</dd></div>
      </dl>
    </article>
  )
}

export function Round2InlineMarketVisual({ candidate, createdAt, fallback }: Round2InlineMarketVisualProps) {
  const normalizedCandidate = useMemo(() => ({
    ...candidate,
    code: candidate.code.trim().replace(/\.(SH|SZ|BJ)$/i, ''),
  }), [candidate])
  const cutoffDate = useMemo(() => toBeijingTradeDate(createdAt), [createdAt])
  const [reloadKey, setReloadKey] = useState(0)
  const [state, setState] = useState<CardState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    if (!cutoffDate) {
      setState({
        status: 'loaded' as const,
        model: buildRound2MarketVisualModel([], ''),
      })
      return () => { cancelled = true }
    }
    const tsCode = toAshareTsCode(normalizedCandidate.code)
    if (!tsCode) {
      setState({ status: 'error', message: '股票代码无效，无法读取近期日线。' })
      return () => { cancelled = true }
    }
    void window.api.shortTerm.getStockMiniKline(tsCode)
      .then((result) => {
        if (cancelled) return
        if (!result.ok) {
          setState({ status: 'error', message: '近期日线读取失败，请稍后重试。' })
          return
        }
        setState({
          status: 'loaded' as const,
          model: buildRound2MarketVisualModel(result.rows as Round2MarketSourceRow[], cutoffDate),
        })
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', message: '近期日线读取失败，请稍后重试。' })
      })
    return () => { cancelled = true }
  }, [cutoffDate, normalizedCandidate.code, reloadKey])

  if (!/^\d{6}$/.test(normalizedCandidate.code)) return null
  const latestMarketDate = state.status === 'loaded' ? state.model.latestTradeDate : null
  return (
    <section data-testid={`ai-round2-inline-${normalizedCandidate.code}`} className="not-prose my-4" aria-label={`${normalizedCandidate.name ?? normalizedCandidate.code}支撑与压力观察参考`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">支撑与压力观察参考</div>
        <div className="text-[11px] text-slate-400">
          {latestMarketDate ? `行情截至 ${formatDate(latestMarketDate)} · ` : ''}分析日 {formatDate(cutoffDate)} · 非交易指令
        </div>
      </div>
      <MarketVisualCard
        candidate={normalizedCandidate}
        state={state}
        onRetry={() => setReloadKey((value) => value + 1)}
        fallback={fallback}
      />
    </section>
  )
}
