/**
 * FR-139/FR-142/FR-143/FR-228: 股票近期日K与筹码峰抽屉
 *
 * 从股票表格打开右侧抽屉，含：
 *   左侧：近期日K、均线和BOLL
 *   右侧：与日K联动的价格级筹码峰
 *   底部：技术因子摘要（有 Tushare 权限时）
 * 使用 lightweight-charts 渲染蜡烛图，原生 Canvas 渲染筹码。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  createChart,
  ColorType,
  CandlestickSeries,
  LineSeries,
  LineStyle,
} from 'lightweight-charts'
import {
  calculateChipProfileSummary,
  ChipPoint,
  ChipsLayout,
  drawTerminalChipProfile,
} from '../../utils/drawChipsCanvas'
import { buildBollingerBandSeries, buildMovingAverageSeries } from '../../utils/movingAverage'
import type { FactorData } from './FactorSummary'
import { RightDrawer } from './RightDrawer'
import { StockStructureInsight } from './StockStructureInsight'
import type { StockStructureRow } from './stockStructureInsightModel'

interface Props {
  tsCode: string
  stockName: string
  /** @deprecated 抽屉不再依赖点击坐标，仅保留兼容旧调用方。 */
  anchorX?: number
  /** @deprecated 抽屉不再依赖点击坐标，仅保留兼容旧调用方。 */
  anchorY?: number
  /** 点击 × 关闭按钮时触发 */
  onClose: () => void
  /** 点击「查看走势图」按钮时触发 */
  onNavigate: () => void
  /** 嵌套在整页业务抽屉中时由调用方提升层级。 */
  zIndex?: number
}

type OhlcvRow = StockStructureRow
type CandleTooltip = { x: number; y: number; date: string; open: number | null; high: number | null; low: number | null; close: number; pctChg: number | null; amount: number | null }
type ChipProfileTooltip = { y: number; price: number; selectedPercent: number; latestPercent: number | null }

const CANDLE_HEIGHT = 460
const CHIPS_COL_WIDTH = 320
const CHIP_PROFILE_TRANSITION_MS = 180
type VisibleRange = 30 | 60 | 120

function formatProfilePercent(value: number | null | undefined, signed = false): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const prefix = signed && value > 0 ? '+' : ''
  return `${prefix}${value.toFixed(1)}%`
}

function applyVisibleRange(
  chart: import('lightweight-charts').IChartApi,
  total: number,
  range: VisibleRange,
) {
  if (total > range) chart.timeScale().setVisibleLogicalRange({ from: total - range, to: total + 2 })
  else chart.timeScale().fitContent()
}

// drawChipsCanvas 已提取到 ../../utils/drawChipsCanvas
// FactorSummary 已提取到 ./FactorSummary



export const StockKlineChipDrawer: React.FC<Props> = ({
  tsCode,
  stockName,
  onClose,
  onNavigate,
  zIndex = 9999,
}) => {
  const candleRef = useRef<HTMLDivElement>(null)
  const chipsCanvasRef = useRef<HTMLCanvasElement>(null)

  const [lastClose, setLastClose] = useState<number | null>(null)
  const [lastPctChg, setLastPctChg] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [visibleRange, setVisibleRange] = useState<VisibleRange>(60)
  const visibleRangeRef = useRef<VisibleRange>(60)

  const [chipsData, setChipsData] = useState<ChipPoint[] | null>(null)
  const [latestChipsData, setLatestChipsData] = useState<ChipPoint[] | null>(null)
  const [chipsDataDate, setChipsDataDate] = useState<string | null>(null)
  const [factorData, setFactorData] = useState<FactorData | null>(null)
  const [ohlcvRows, setOhlcvRows] = useState<OhlcvRow[]>([])
  const [chipsTooltip, setChipsTooltip] = useState<ChipProfileTooltip | null>(null)
  const [candleTooltip, setCandleTooltip] = useState<CandleTooltip | null>(null)
  const [profileOverlay, setProfileOverlay] = useState<{ coreY: number } | null>(null)
  const chipsLayoutRef = useRef<ChipsLayout | null>(null)

  // FR-144：K 线点击联动筹码历史
  const candleChartRef = useRef<import('lightweight-charts').IChartApi | null>(null)
  const ohlcvRowsRef = useRef<OhlcvRow[]>([])
  const chipsCacheRef = useRef<Map<string, ChipPoint[]>>(new Map())
  const chipsDataRef = useRef<ChipPoint[] | null>(null)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [chipsLoading, setChipsLoading] = useState(false)

  // 是否有筹码数据
  const activeChipsData = chipsDataDate === selectedDate ? chipsData : null
  const hasChips = activeChipsData !== null && activeChipsData.length > 0
  const chipReferencePrice = selectedDate
    ? (ohlcvRowsRef.current.find(row => row.tradeDate === selectedDate)?.close ?? lastClose)
    : lastClose
  const latestTradeDate = ohlcvRows[ohlcvRows.length - 1]?.tradeDate ?? null
  const profileSummary = useMemo(
    () => calculateChipProfileSummary(activeChipsData ?? [], chipReferencePrice),
    [activeChipsData, chipReferencePrice],
  )
  const latestProfileSummary = useMemo(
    () => selectedDate ? calculateChipProfileSummary(latestChipsData ?? [], lastClose) : null,
    [lastClose, latestChipsData, selectedDate],
  )
  const profileDateLabel = chipsLoading
    ? '读取中'
    : selectedDate
      ? `${selectedDate.slice(4, 6)}/${selectedDate.slice(6, 8)} ↔ ${latestTradeDate ? `${latestTradeDate.slice(4, 6)}/${latestTradeDate.slice(6, 8)}` : '最新'}`
      : latestTradeDate
        ? `最新 · ${latestTradeDate.slice(4, 6)}/${latestTradeDate.slice(6, 8)}`
        : '日期待补'
  const profileAriaLabel = profileSummary && selectedDate && latestProfileSummary
    ? `筹码分布对比，左侧所选日${selectedDate}，主峰价格${profileSummary.peakPrice.toFixed(2)}；右侧最新日${latestTradeDate ?? '日期待补'}，主峰价格${latestProfileSummary.peakPrice.toFixed(2)}；两侧共享价格和占比尺度`
    : profileSummary
      ? `筹码分布，${profileSummary.profitPercent == null ? '浮盈与套牢比例待现价补齐' : `浮盈筹码${profileSummary.profitPercent.toFixed(1)}%，套牢筹码${profileSummary.trappedPercent?.toFixed(1)}%`}，主峰价格${profileSummary.peakPrice.toFixed(2)}，核心成本区${profileSummary.coreLowPrice.toFixed(2)}至${profileSummary.coreHighPrice.toFixed(2)}`
    : '筹码分布尚未加载'

  // 蜡烛图 + 并行拉取筹码/因子数据
  useEffect(() => {
    let cancelled = false
    let candleChart: ReturnType<typeof createChart> | null = null

    const load = async () => {
      setLoading(true)
      setLoadError(null)
      setLastClose(null)
      setLastPctChg(null)
      setChipsData(null)
      setLatestChipsData(null)
      setChipsDataDate(null)
      setFactorData(null)
      setOhlcvRows([])
      setChipsTooltip(null)
      setCandleTooltip(null)
      setProfileOverlay(null)
      setChipsLoading(false)
      // FR-144：切换股票时清空历史缓存和选中状态
      chipsCacheRef.current.clear()
      chipsDataRef.current = null
      chipsLayoutRef.current = null
      ohlcvRowsRef.current = []
      setSelectedDate(null)

      try {
        // 并行发起：蜡烛K线 + 筹码 + 技术因子
        const [klineRes, chipsRes, factorRes] = await Promise.all([
          window.api.shortTerm.getStockMiniKline(tsCode),
          window.api.shortTerm.getStockChips(tsCode),
          window.api.shortTerm.getStockFactor(tsCode),
        ])

        if (cancelled) return

        // 筹码数据
        if (chipsRes.ok && chipsRes.data.length > 0) {
          setChipsData(chipsRes.data)
          setLatestChipsData(chipsRes.data)
          setChipsDataDate(null)
          chipsDataRef.current = chipsRes.data
        }
        // 技术因子
        if (factorRes.ok) {
          setFactorData(factorRes.data)
        }

        // 蜡烛K线
        if (!klineRes.ok) {
          setLoadError('近期日K读取失败，请重试。')
          setLoading(false)
          return
        }
        const ohlcvRows = (() => {
          const filtered = klineRes.rows.filter(
            (r) => r.open != null && r.high != null && r.low != null
          )
          // 去重（同一 tradeDate 保留最后一条）并升序排序
          const map = new Map<string, typeof filtered[0]>()
          for (const r of filtered) map.set(r.tradeDate, r)
          return [...map.values()].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate))
        })()

        if (ohlcvRows.length > 0 && candleRef.current) {
          candleChart = createChart(candleRef.current, {
            autoSize: true,
            layout: {
              background: { type: ColorType.Solid, color: '#1f2937' },
              textColor: '#9ca3af',
              fontSize: 11,
              attributionLogo: false,
            },
            localization: {
              // 将十字线底部日期标签统一显示为 MM/DD（避免出现 "06 5月 '26" 等本地化格式）
              timeFormatter: (time: unknown) => {
                const s = typeof time === 'string' ? time : ''
                const parts = s.split('-')
                return parts.length === 3 ? `${parts[1]}/${parts[2]}` : s
              },
            },
            grid: {
              vertLines: { visible: false },
              horzLines: { color: '#374151' },
            },
            leftPriceScale: { visible: true, borderColor: '#374151' },
            rightPriceScale: { visible: false },
            timeScale: {
              borderColor: '#374151',
              timeVisible: false,
              tickMarkFormatter: (time: unknown, tickMarkType: number) => {
                const s = typeof time === 'string' ? time : ''
                if (!s.includes('-')) return s
                const parts = s.split('-')
                if (tickMarkType === 0) return parts[0]
                return `${parts[1]}/${parts[2]}`
              },
            },
            height: CANDLE_HEIGHT,
          })

          const candleSeries = candleChart.addSeries(CandlestickSeries, {
            upColor: '#ef4444',
            downColor: '#22c55e',
            borderUpColor: '#ef4444',
            borderDownColor: '#22c55e',
            wickUpColor: '#ef4444',
            wickDownColor: '#22c55e',
            priceLineVisible: false,
            lastValueVisible: false,
          })
          const data = ohlcvRows.map((r) => ({
            time: `${r.tradeDate.slice(0, 4)}-${r.tradeDate.slice(4, 6)}-${r.tradeDate.slice(6, 8)}` as import('lightweight-charts').Time,
            open: r.open!,
            high: r.high!,
            low: r.low!,
            close: r.close,
          }))
          candleSeries.setData(data)

          const addChartLine = (
            lineData: Array<{ time: import('lightweight-charts').Time; value: number }>,
            color: string,
            title: string,
          ) => {
            if (!lineData.length) return
            const series = candleChart!.addSeries(LineSeries, {
              color,
              lineWidth: 1,
              lineStyle: LineStyle.Dashed,
              lastValueVisible: false,
              priceLineVisible: false,
              title,
            })
            series.setData(lineData)
          }

          const addLocalMovingAverage = (period: number, color: string, title: string) => {
            addChartLine(
              buildMovingAverageSeries(ohlcvRows, period).map((point) => ({
                time: `${point.tradeDate.slice(0, 4)}-${point.tradeDate.slice(4, 6)}-${point.tradeDate.slice(6, 8)}` as import('lightweight-charts').Time,
                value: point.value,
              })),
              color,
              title,
            )
          }
          // 均线直接基于当前完整日K计算，避免30日技术因子缓存截断可见曲线。
          addLocalMovingAverage(5, '#f97316', 'MA5')
          addLocalMovingAverage(10, '#3b82f6', 'MA10')
          addLocalMovingAverage(20, '#8b5cf6', 'MA20 / BOLL中轨')
          addLocalMovingAverage(60, '#a16207', 'MA60')
          const bollingerRows = buildBollingerBandSeries(ohlcvRows)
          addChartLine(bollingerRows.map((point) => ({
            time: `${point.tradeDate.slice(0, 4)}-${point.tradeDate.slice(4, 6)}-${point.tradeDate.slice(6, 8)}` as import('lightweight-charts').Time,
            value: point.upper,
          })), '#ef4444', 'BOLL上')
          addChartLine(bollingerRows.map((point) => ({
            time: `${point.tradeDate.slice(0, 4)}-${point.tradeDate.slice(4, 6)}-${point.tradeDate.slice(6, 8)}` as import('lightweight-charts').Time,
            value: point.lower,
          })), '#22c55e', 'BOLL下')
          applyVisibleRange(candleChart, data.length, visibleRangeRef.current)
          // FR-144：写入 ref 供 subscribeClick 回调同步访问
          const normalizedRows = ohlcvRows.map(r => ({
            tradeDate: r.tradeDate,
            open: r.open ?? null,
            high: r.high ?? null,
            low: r.low ?? null,
            close: r.close,
            pctChg: r.pctChg ?? null,
            amount: r.amount ?? null,
          }))
          ohlcvRowsRef.current = normalizedRows
          setOhlcvRows(normalizedRows)
          // FR-144：注册蜡烛点击 → 联动筹码日期
          candleChartRef.current = candleChart
          candleChart.subscribeClick((param) => {
            if (!param.time || !chipsDataRef.current) return
            const ymd = (param.time as string).replace(/-/g, '')
            const rows = ohlcvRowsRef.current
            const isLatest = rows.length > 0 && rows[rows.length - 1].tradeDate === ymd
            setSelectedDate(isLatest ? null : ymd)
          })

          // 十字线移动时展示 OHLC + 成交额 tooltip
          candleChart.subscribeCrosshairMove((param) => {
            if (!param.time || !param.point) { setCandleTooltip(null); return }
            const ymd = (param.time as string).replace(/-/g, '')
            const row = ohlcvRowsRef.current.find((r) => r.tradeDate === ymd)
            if (!row) { setCandleTooltip(null); return }
            setCandleTooltip({
              x: param.point.x,
              y: param.point.y,
              date: ymd,
              open: row.open,
              high: row.high,
              low: row.low,
              close: row.close,
              pctChg: row.pctChg,
              amount: row.amount,
            })
          })

          const last = ohlcvRows[ohlcvRows.length - 1]
          if (last && Number.isFinite(last.close)) {
            candleSeries.createPriceLine({
              price: last.close,
              color: '#59d9e8',
              lineWidth: 1,
              lineStyle: LineStyle.Dashed,
              axisLabelVisible: true,
              title: '',
            })
          }
          setLastClose(last?.close ?? null)
          setLastPctChg(last?.pctChg ?? null)
        } else {
          setLoadError('本地没有可用的近期日K数据。')
        }
        setLoading(false)
      } catch {
        if (!cancelled) {
          setLoadError('近期走势加载失败，请重试。')
          setLoading(false)
        }
      }
    }

    void load()

    return () => {
      cancelled = true
      setCandleTooltip(null)
      candleChart?.remove()
      candleChart = null
      candleChartRef.current = null
    }
  }, [reloadKey, tsCode])

  // 最新日使用单侧终端剖面；历史日使用左右共享尺度的蝴蝶对比。
  useEffect(() => {
    if (!activeChipsData || activeChipsData.length === 0 || !chipsCanvasRef.current) {
      chipsLayoutRef.current = null
      setProfileOverlay(null)
      return
    }
    let animationFrame: number | null = null
    const compareChips = selectedDate !== null ? (chipsDataRef.current ?? undefined) : undefined
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const startedAt = performance.now()
    const commitOverlay = (layout: ChipsLayout | null) => {
      chipsLayoutRef.current = layout
      if (!layout || !profileSummary) {
        setProfileOverlay(null)
        return
      }
      const coreMid = (profileSummary.coreLowPrice + profileSummary.coreHighPrice) / 2
      const coreY = layout.padTop + layout.chartH - (coreMid - layout.minPrice) / layout.priceRange * layout.chartH
      setProfileOverlay((current) => current && Math.abs(current.coreY - coreY) < 0.5 ? current : { coreY })
    }
    const drawFrame = (now: number) => {
      const rawProgress = reduceMotion ? 1 : Math.min(1, (now - startedAt) / CHIP_PROFILE_TRANSITION_MS)
      const easedProgress = 1 - Math.pow(1 - rawProgress, 3)
      const layout = drawTerminalChipProfile(
        chipsCanvasRef.current!,
        activeChipsData,
        chipReferencePrice,
        CHIPS_COL_WIDTH,
        CANDLE_HEIGHT,
        compareChips,
        easedProgress,
        selectedDate ? lastClose : null,
      )
      chipsLayoutRef.current = layout
      if (rawProgress < 1) animationFrame = window.requestAnimationFrame(drawFrame)
      else commitOverlay(layout)
    }
    if (reduceMotion) drawFrame(startedAt + CHIP_PROFILE_TRANSITION_MS)
    else animationFrame = window.requestAnimationFrame(drawFrame)
    return () => {
      if (animationFrame != null) window.cancelAnimationFrame(animationFrame)
    }
  }, [activeChipsData, chipReferencePrice, lastClose, profileSummary, selectedDate])

  // FR-144：selectedDate 变化时加载对应历史筹码
  useEffect(() => {
    if (selectedDate === null) {
      // 还原为最新筹码
      setChipsLoading(false)
      setChipsData(chipsDataRef.current)
      setChipsDataDate(null)
      return
    }
    const cached = chipsCacheRef.current.get(selectedDate)
    if (cached) {
      setChipsLoading(false)
      setChipsData(cached)
      setChipsDataDate(selectedDate)
      return
    }
    let cancelled = false
    setChipsLoading(true)
    setChipsTooltip(null)
    setChipsData(null)
    setProfileOverlay(null)
    window.api.shortTerm.getStockChips(tsCode, selectedDate)
      .then(res => {
        if (cancelled) return
        if (res.ok && res.data.length > 0) {
          chipsCacheRef.current.set(selectedDate, res.data)
          setChipsData(res.data)
        } else setChipsData([])
        setChipsDataDate(selectedDate)
      })
      .catch(() => {
        if (!cancelled) {
          setChipsData([])
          setChipsDataDate(selectedDate)
        }
      })
      .finally(() => { if (!cancelled) setChipsLoading(false) })
    return () => { cancelled = true }
  }, [selectedDate, tsCode])

  const handleChipsMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const layout = chipsLayoutRef.current
    if (!layout || !activeChipsData || activeChipsData.length === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const y = e.clientY - rect.top
    const { minPrice, maxPrice, priceRange, padTop, chartH } = layout
    if (y < padTop || y > padTop + chartH) {
      setChipsTooltip(null)
      return
    }
    // y 坐标反算价格（低价在底部）
    const rawPrice = minPrice + (1 - (y - padTop) / chartH) * priceRange
    const clampedPrice = Math.max(minPrice, Math.min(maxPrice, rawPrice))
    const selectedNearest = activeChipsData.reduce((best, c) =>
      Math.abs(c.price - clampedPrice) < Math.abs(best.price - clampedPrice) ? c : best
    )
    const latestRows = selectedDate ? chipsDataRef.current : null
    const latestNearest = latestRows && latestRows.length > 0
      ? latestRows.reduce((best, c) =>
          Math.abs(c.price - clampedPrice) < Math.abs(best.price - clampedPrice) ? c : best
        )
      : null
    setChipsTooltip({
      y,
      price: selectedDate ? clampedPrice : selectedNearest.price,
      selectedPercent: selectedNearest.percent,
      latestPercent: latestNearest?.percent ?? null,
    })
  }

  const handleChipsMouseLeave = () => { setChipsTooltip(null) }

  const handleVisibleRangeChange = (range: VisibleRange) => {
    visibleRangeRef.current = range
    setVisibleRange(range)
    if (candleChartRef.current) applyVisibleRange(candleChartRef.current, ohlcvRowsRef.current.length, range)
  }

  const pctColor =
    lastPctChg == null
      ? 'text-gray-400'
      : lastPctChg > 0
        ? 'text-red-400'
        : lastPctChg < 0
          ? 'text-green-400'
          : 'text-gray-400'
  const chipsTooltipStatus = chipsTooltip && chipReferencePrice != null
    ? chipsTooltip.price > chipReferencePrice ? 'trapped' : 'profit'
    : 'unknown'
  const chipsTooltipDelta = chipsTooltip?.latestPercent == null
    ? null
    : chipsTooltip.latestPercent - chipsTooltip.selectedPercent

  return (
    <RightDrawer
      title={stockName}
      description={`${tsCode} · 近期日K与筹码峰`}
      onClose={onClose}
      defaultWidth={980}
      minWidth={760}
      maxWidth={1120}
      zIndex={zIndex}
      testId="stock-kline-chip-drawer"
      bodyClassName="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-4 dark:bg-slate-900"
      actions={(
        <button
          type="button"
          onClick={onNavigate}
          className="min-h-9 rounded-md border border-cyan-200 bg-cyan-50 px-3 text-xs font-semibold text-cyan-800 transition-colors hover:border-cyan-300 hover:bg-cyan-100 focus:outline-none focus:ring-2 focus:ring-cyan-500 dark:border-cyan-800 dark:bg-cyan-950/45 dark:text-cyan-200 dark:hover:bg-cyan-900/55"
        >
          打开完整走势
        </button>
      )}
    >
      <section data-testid="stock-kline-chip-content" className="overflow-hidden rounded-md border border-slate-700 bg-slate-800 shadow-sm">
        <header className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-slate-700 px-3 py-2">
          <div className="flex min-w-0 items-center gap-3">
            <div>
              <div className="text-[11px] text-slate-400">最新收盘</div>
              <div className="mt-0.5 flex items-baseline gap-2 tabular-nums">
                <span className={`text-lg font-semibold ${pctColor}`}>{lastClose?.toFixed(2) ?? '—'}</span>
                {lastPctChg != null && (
                  <span className={`text-xs font-medium ${pctColor}`}>{lastPctChg > 0 ? '+' : ''}{lastPctChg.toFixed(2)}%</span>
                )}
              </div>
            </div>
            <div className="h-7 w-px bg-slate-700" aria-hidden="true" />
            <div className="min-w-0 text-[11px] text-slate-400">
              <div>{latestTradeDate ? `${latestTradeDate.slice(0, 4)}/${latestTradeDate.slice(4, 6)}/${latestTradeDate.slice(6, 8)}` : '日期待补'}</div>
              <div className="mt-0.5 truncate text-slate-300">{selectedDate ? `筹码 ${selectedDate.slice(4, 6)}/${selectedDate.slice(6, 8)}` : hasChips ? '最新筹码' : '筹码待补'}</div>
            </div>
          </div>
          <div className="inline-flex h-8 shrink-0 items-center rounded-md border border-slate-600 bg-slate-900 p-0.5" aria-label="日K显示区间">
            {([30, 60, 120] as VisibleRange[]).map(range => (
              <button
                key={range}
                type="button"
                aria-pressed={visibleRange === range}
                onClick={() => handleVisibleRangeChange(range)}
                className={`h-7 min-w-12 rounded px-2 text-[11px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-400 ${visibleRange === range ? 'bg-cyan-500/20 text-cyan-200' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'}`}
              >
                {range}日
              </button>
            ))}
          </div>
        </header>

        <div className="flex min-w-0">
          <div className="relative min-w-0 flex-1" style={{ height: CANDLE_HEIGHT }}>
            <div ref={candleRef} data-testid="stock-kline-candle-chart" className="h-full w-full" />
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-800/88 text-xs text-slate-400" role="status">
                <span className="mr-2 h-3.5 w-3.5 animate-spin rounded-full border-2 border-cyan-300 border-r-transparent motion-reduce:animate-none" aria-hidden="true" />
                正在读取近期日K与筹码
              </div>
            )}
            {!loading && loadError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-800/95 px-6 text-center" role="alert">
                <span className="text-sm text-slate-300">{loadError}</span>
                <button type="button" onClick={() => setReloadKey(value => value + 1)} className="min-h-9 rounded-md border border-slate-600 px-3 text-xs font-semibold text-slate-200 hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-cyan-400">重新读取</button>
              </div>
            )}
            {candleTooltip && (() => {
              const chartW = candleRef.current?.clientWidth ?? 520
              const flipX = candleTooltip.x > chartW / 2
              const ttLeft = flipX ? candleTooltip.x - 144 : candleTooltip.x + 10
              const ttTop = Math.max(4, candleTooltip.y - 8)
              const tooltipPctColor = candleTooltip.pctChg == null ? 'text-slate-400'
                : candleTooltip.pctChg > 0 ? 'text-red-400'
                  : candleTooltip.pctChg < 0 ? 'text-green-400' : 'text-slate-400'
              return (
                <div
                  data-testid="stock-kline-candle-tooltip"
                  style={{ left: ttLeft, top: ttTop }}
                  className="pointer-events-none absolute z-20 rounded-md border border-slate-500/80 bg-slate-950 px-2.5 py-2 text-xs leading-snug shadow-[0_12px_30px_rgba(0,0,0,0.55)] ring-1 ring-white/5"
                >
                  <div className="mb-1 text-slate-400">{`${candleTooltip.date.slice(0, 4)}/${candleTooltip.date.slice(4, 6)}/${candleTooltip.date.slice(6, 8)}`}</div>
                  <div className="grid grid-cols-2 gap-x-3 font-mono text-slate-200">
                    <span>开 {candleTooltip.open?.toFixed(2) ?? '—'}</span><span>收 {candleTooltip.close.toFixed(2)}</span>
                    <span>高 {candleTooltip.high?.toFixed(2) ?? '—'}</span><span>低 {candleTooltip.low?.toFixed(2) ?? '—'}</span>
                  </div>
                  {candleTooltip.pctChg != null && (
                    <div className={`mt-1 font-mono ${tooltipPctColor}`}>
                      {candleTooltip.pctChg > 0 ? '+' : ''}{candleTooltip.pctChg.toFixed(2)}%
                      {candleTooltip.amount != null && <span className="ml-2 text-slate-400">{(candleTooltip.amount / 100000).toFixed(2)}亿</span>}
                    </div>
                  )}
                </div>
              )
            })()}
          </div>

          <div
            role="img"
            aria-label={profileAriaLabel}
            data-testid="stock-chip-profile"
            className="relative shrink-0 overflow-hidden border-l border-slate-700 bg-slate-950"
            style={{ width: CHIPS_COL_WIDTH, height: CANDLE_HEIGHT }}
            onMouseMove={handleChipsMouseMove}
            onMouseLeave={handleChipsMouseLeave}
          >
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-[74px] border-b border-slate-700/80 bg-slate-950/95 px-3 pt-2.5 backdrop-blur-sm">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-100">{selectedDate ? '筹码对比' : '筹码分布'}</span>
                <span className="ml-auto rounded border border-cyan-800 bg-cyan-950/55 px-1.5 py-0.5 text-[9px] font-medium text-cyan-200">
                  {profileDateLabel}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-3">
                <div className="border-r border-slate-700 pr-2">
                  <div className="font-mono text-[11px] font-semibold text-rose-400">{formatProfilePercent(profileSummary?.profitPercent)}</div>
                  <div className="mt-0.5 text-[9px] text-slate-500">浮盈筹码</div>
                </div>
                <div className="border-r border-slate-700 px-2">
                  <div className="font-mono text-[11px] font-semibold text-emerald-300">{formatProfilePercent(profileSummary?.trappedPercent)}</div>
                  <div className="mt-0.5 text-[9px] text-slate-500">套牢筹码</div>
                </div>
                <div className="pl-2">
                  <div className="font-mono text-[11px] font-semibold text-amber-300">{formatProfilePercent(profileSummary?.distanceToPeakPercent, true)}</div>
                  <div className="mt-0.5 text-[9px] text-slate-500">距主峰</div>
                </div>
              </div>
            </div>
            {hasChips ? (
              <canvas ref={chipsCanvasRef} aria-hidden="true" className="block h-full w-full" />
            ) : !loading && !chipsLoading && (
              <div className="flex h-full items-center justify-center px-8 pt-16 text-center text-xs leading-5 text-slate-500">当前日期暂无价格级筹码数据</div>
            )}
            {chipsLoading && (
              <div className="pointer-events-none absolute inset-x-0 bottom-8 top-[74px] z-10 flex items-center justify-center bg-slate-950/45 text-xs text-slate-400" role="status">
                <span className="mr-2 h-3.5 w-3.5 animate-spin rounded-full border-2 border-cyan-300 border-r-transparent motion-reduce:animate-none" aria-hidden="true" />
                正在读取历史筹码
              </div>
            )}
            {profileSummary && profileOverlay && !chipsLoading && (
              <div
                data-testid="chip-profile-core-zone"
                className="pointer-events-none absolute left-3 z-10 rounded-sm border border-amber-700/70 bg-amber-950/70 px-1.5 py-1 text-[9px] font-medium text-amber-200 shadow-sm"
                style={{ top: Math.max(84, Math.min(CANDLE_HEIGHT - 58, profileOverlay.coreY - 11)) }}
              >
                {selectedDate ? '所选核心' : '核心成本区'} {profileSummary.coreLowPrice.toFixed(2)}–{profileSummary.coreHighPrice.toFixed(2)}
              </div>
            )}
            {chipsTooltip && hasChips && (
              <div aria-hidden="true" className="pointer-events-none absolute left-0 right-0 z-20 h-px bg-slate-200/25" style={{ top: chipsTooltip.y }} />
            )}
            {chipsTooltip && hasChips && (
              <div
                data-testid="chip-profile-tooltip"
                className="pointer-events-none absolute right-3 z-30 w-36 rounded-md border border-slate-500/80 bg-slate-950 px-2.5 py-2 text-[10px] leading-snug shadow-[0_12px_30px_rgba(0,0,0,0.55)] ring-1 ring-white/5"
                style={{ top: Math.max(82, Math.min(CANDLE_HEIGHT - (selectedDate ? 116 : 86), chipsTooltip.y - 30)) }}
              >
                <div className="font-mono text-xs font-semibold text-slate-100">{chipsTooltip.price.toFixed(2)}</div>
                {selectedDate ? (
                  <>
                    <div className="mt-1 flex items-center justify-between text-slate-400">
                      <span>所选日占比</span>
                      <span className="font-mono text-amber-200">{chipsTooltip.selectedPercent.toFixed(2)}%</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between border-t border-slate-800 pt-1 text-slate-400">
                      <span>最新日占比</span>
                      <span className="font-mono text-cyan-300">{chipsTooltip.latestPercent == null ? '—' : `${chipsTooltip.latestPercent.toFixed(2)}%`}</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between border-t border-slate-800 pt-1 text-slate-400">
                      <span>占比变化</span>
                      <span className={`font-mono ${chipsTooltipDelta == null ? 'text-slate-300' : chipsTooltipDelta > 0 ? 'text-cyan-300' : chipsTooltipDelta < 0 ? 'text-amber-200' : 'text-slate-300'}`}>
                        {chipsTooltipDelta == null ? '—' : `${chipsTooltipDelta > 0 ? '+' : ''}${chipsTooltipDelta.toFixed(2)}pp`}
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="mt-1 flex items-center justify-between text-slate-400">
                    <span>筹码占比</span>
                    <span className={chipsTooltipStatus === 'trapped' ? 'font-mono text-emerald-300' : chipsTooltipStatus === 'profit' ? 'font-mono text-rose-400' : 'font-mono text-slate-300'}>{chipsTooltip.selectedPercent.toFixed(2)}%</span>
                  </div>
                )}
                <div className="mt-1 flex items-center justify-between border-t border-slate-800 pt-1 text-slate-400">
                  <span>{selectedDate ? '所选日状态' : '价格状态'}</span>
                  <span className={chipsTooltipStatus === 'trapped' ? 'text-emerald-300' : chipsTooltipStatus === 'profit' ? 'text-rose-400' : 'text-slate-300'}>
                    {chipsTooltipStatus === 'trapped' ? '套牢区' : chipsTooltipStatus === 'profit' ? '浮盈区' : '待现价'}
                  </span>
                </div>
              </div>
            )}
            <div className="pointer-events-none absolute bottom-2.5 left-3 right-3 z-20 flex items-center gap-3 text-[9px] text-slate-500">
              {selectedDate ? (
                <div data-testid="chip-profile-compare-legend" className="flex w-full items-center justify-between">
                  <span><i className="mr-1 inline-block h-0.5 w-3 rounded bg-gradient-to-r from-rose-400 to-emerald-300 align-middle" />左 · {selectedDate.slice(4, 6)}/{selectedDate.slice(6, 8)} 所选</span>
                  <span><i className="mr-1 inline-block h-0.5 w-3 rounded bg-cyan-300 align-middle" />右 · {latestTradeDate ? `${latestTradeDate.slice(4, 6)}/${latestTradeDate.slice(6, 8)}` : '最新'} 最新</span>
                </div>
              ) : (
                <>
                  <span><i className="mr-1 inline-block h-0.5 w-3 rounded bg-rose-400 align-middle" />浮盈</span>
                  <span><i className="mr-1 inline-block h-0.5 w-3 rounded bg-emerald-300 align-middle" />套牢</span>
                  <span><i className="mr-1 inline-block h-px w-3 bg-cyan-300 align-middle" />现价</span>
                </>
              )}
            </div>
          </div>
        </div>

        <StockStructureInsight
          rows={ohlcvRows}
          visibleRange={visibleRange}
          selectedDate={selectedDate}
          activeProfile={profileSummary}
          latestProfile={latestProfileSummary}
          hasActiveChips={hasChips}
          factor={factorData}
        />
      </section>
    </RightDrawer>
  )
}

/** @deprecated 使用 StockKlineChipDrawer；保留旧导出避免既有消费页面一次性失效。 */
export const StockMiniChart = StockKlineChipDrawer
