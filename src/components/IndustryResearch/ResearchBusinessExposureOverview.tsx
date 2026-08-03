import React, { useEffect, useMemo, useState } from 'react'
import type { EChartsOption } from 'echarts'
import ReactECharts from 'echarts-for-react'
import { useAppStore } from '../../store/appStore'
import {
  buildBusinessExposureMatrix,
  buildBusinessExposureOverview,
  buildBusinessExposureTrend,
  formatFinancialAmount,
  formatFinancialReportPeriod,
  type BusinessExposureTrendScope,
} from './industryResearchFinancialModel'
import type { BusinessExposure } from './industryResearchTypes'

const CHART_COLORS = ['#0891b2', '#2563eb', '#059669', '#d97706', '#64748b', '#0f766e', '#4f46e5', '#475569']

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return reduced
}

function formatPercent(value: number | null, showSign = false): string {
  if (value == null || !Number.isFinite(value)) return '未披露'
  const sign = showSign && value > 0 ? '+' : ''
  return `${sign}${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%`
}

function compactName(value: string, limit = 10): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

function compactPeriod(value: string): string {
  if (value.length < 8) return value
  if (value.endsWith('1231')) return `${value.slice(0, 4)}A`
  if (value.endsWith('0630')) return `${value.slice(0, 4)}H1`
  return formatFinancialReportPeriod(value)
}

export function ResearchBusinessExposureOverview({
  exposures,
  onEdit,
}: {
  exposures: BusinessExposure[]
  onEdit: (exposure: BusinessExposure) => void
}): React.ReactElement {
  const theme = useAppStore((state) => state.theme)
  const reducedMotion = useReducedMotion()
  const baseOverview = useMemo(() => buildBusinessExposureOverview(exposures), [exposures])
  const [selectedPeriod, setSelectedPeriod] = useState<string | null>(baseOverview.selectedPeriod)
  const [trendScope, setTrendScope] = useState<BusinessExposureTrendScope>('annual')

  useEffect(() => {
    setSelectedPeriod(baseOverview.selectedPeriod)
  }, [baseOverview.selectedPeriod, exposures])

  const overview = useMemo(
    () => buildBusinessExposureOverview(exposures, selectedPeriod),
    [exposures, selectedPeriod],
  )
  const annualTrend = useMemo(() => buildBusinessExposureTrend(exposures, 'annual'), [exposures])
  const interimTrend = useMemo(() => buildBusinessExposureTrend(exposures, 'interim'), [exposures])
  const matrix = useMemo(() => buildBusinessExposureMatrix(exposures), [exposures])
  const researchMappings = useMemo(() => exposures
    .filter((item) => item.exposurePct != null)
    .map((item) => ({
      key: `${item.mainBusinessItemName ?? item.basis}:${item.exposurePct}`,
      name: item.mainBusinessItemName ?? item.basis,
      exposurePct: item.exposurePct,
    }))
    .filter((item, index, values) => values.findIndex((candidate) => candidate.key === item.key) === index), [exposures])
  const trend = trendScope === 'annual' ? annualTrend : interimTrend

  useEffect(() => {
    if (trendScope === 'annual' && !annualTrend.periods.length && interimTrend.periods.length) setTrendScope('interim')
    if (trendScope === 'interim' && !interimTrend.periods.length && annualTrend.periods.length) setTrendScope('annual')
  }, [annualTrend.periods.length, interimTrend.periods.length, trendScope])

  const chartItems = useMemo(() => {
    const ranked = overview.items.filter((item) => item.revenue != null && item.revenue > 0)
    if (ranked.length <= 8) return ranked
    const leading = ranked.slice(0, 7)
    const rest = ranked.slice(7)
    const revenue = rest.reduce((sum, item) => sum + (item.revenue ?? 0), 0)
    const profit = rest.reduce((sum, item) => sum + (item.profit ?? 0), 0)
    return [...leading, {
      key: `${overview.selectedPeriod}:other`,
      name: `其他 ${rest.length} 项`,
      exposures: rest.flatMap((item) => item.exposures),
      revenue,
      cost: rest.reduce((sum, item) => sum + (item.cost ?? 0), 0),
      profit,
      currency: rest.find((item) => item.currency)?.currency ?? null,
      grossMarginPct: revenue ? profit / revenue * 100 : null,
      revenueSharePct: overview.totalRevenue ? revenue / overview.totalRevenue * 100 : null,
      exposurePct: null,
      status: 'candidate' as const,
    }]
  }, [overview.items, overview.selectedPeriod, overview.totalRevenue])

  const compositionOption = useMemo<EChartsOption>(() => {
    const dark = theme === 'dark'
    const textColor = dark ? '#cbd5e1' : '#475569'
    return {
      animation: !reducedMotion,
      animationDuration: reducedMotion ? 0 : 220,
      aria: {
        enabled: true,
        description: `${formatFinancialReportPeriod(overview.selectedPeriod)}主营收入构成，按收入从高到低排列。`,
      },
      grid: { left: 112, right: 58, top: 10, bottom: 28 },
      tooltip: {
        trigger: 'item',
        backgroundColor: dark ? '#0f172a' : '#ffffff',
        borderColor: dark ? '#334155' : '#cbd5e1',
        textStyle: { color: dark ? '#e2e8f0' : '#0f172a', fontSize: 12 },
        formatter: (params: unknown) => {
          const source = params as { data?: { name?: string; value?: number; share?: number | null; margin?: number | null; currency?: string | null } }
          const item = source.data
          if (!item) return ''
          return [
            item.name ?? '',
            `主营收入 ${formatFinancialAmount(item.value ?? null, 'yuan', item.currency)}`,
            `收入占比 ${formatPercent(item.share ?? null)}`,
            `毛利率 ${formatPercent(item.margin ?? null)}`,
          ].join('\n')
        },
      },
      xAxis: {
        type: 'value',
        axisLabel: { color: textColor, fontSize: 10, formatter: (value: number) => formatFinancialAmount(value) },
        splitLine: { lineStyle: { color: dark ? '#1e293b' : '#e2e8f0' } },
      },
      yAxis: {
        type: 'category',
        inverse: true,
        data: chartItems.map((item) => item.name),
        axisLabel: { color: textColor, fontSize: 11, width: 96, overflow: 'truncate', formatter: (value: string) => compactName(value) },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      series: [{
        type: 'bar',
        barMaxWidth: 20,
        data: chartItems.map((item, index) => ({
          name: item.name,
          value: item.revenue,
          share: item.revenueSharePct,
          margin: item.grossMarginPct,
          currency: item.currency,
          itemStyle: { color: CHART_COLORS[index % CHART_COLORS.length], borderRadius: [0, 2, 2, 0] },
          label: {
            show: true,
            position: 'right',
            color: textColor,
            fontSize: 10,
            formatter: formatPercent(item.revenueSharePct),
          },
        })),
      }],
    }
  }, [chartItems, overview.selectedPeriod, reducedMotion, theme])

  const trendOption = useMemo<EChartsOption>(() => {
    const dark = theme === 'dark'
    const textColor = dark ? '#cbd5e1' : '#475569'
    return {
      animation: !reducedMotion,
      animationDuration: reducedMotion ? 0 : 220,
      aria: {
        enabled: true,
        description: `${trendScope === 'annual' ? '年报' : '中报'}主营业务收入跨期变化，展示规模最大的${trend.series.length}个可比口径。`,
      },
      color: CHART_COLORS,
      legend: {
        type: 'scroll',
        top: 0,
        left: 4,
        right: 4,
        itemWidth: 14,
        itemHeight: 6,
        textStyle: { color: textColor, fontSize: 10 },
      },
      grid: { left: 66, right: 24, top: 48, bottom: 38 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: dark ? '#0f172a' : '#ffffff',
        borderColor: dark ? '#334155' : '#cbd5e1',
        textStyle: { color: dark ? '#e2e8f0' : '#0f172a', fontSize: 12 },
        valueFormatter: (value: unknown) => formatFinancialAmount(typeof value === 'number' ? value : null),
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: trend.periods.map(compactPeriod),
        axisLabel: { color: textColor, fontSize: 10, interval: 'auto' },
        axisLine: { lineStyle: { color: dark ? '#334155' : '#cbd5e1' } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        name: '主营收入',
        nameTextStyle: { color: textColor, fontSize: 10 },
        axisLabel: { color: textColor, fontSize: 10, formatter: (value: number) => formatFinancialAmount(value) },
        splitLine: { lineStyle: { color: dark ? '#1e293b' : '#e2e8f0' } },
      },
      series: trend.series.map((item) => ({
        name: item.name,
        type: 'line',
        connectNulls: false,
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: { width: 2 },
        emphasis: { focus: 'series' },
        data: item.values,
      })),
    }
  }, [reducedMotion, theme, trend.periods, trend.series, trendScope])

  const matrixOption = useMemo<EChartsOption>(() => {
    const dark = theme === 'dark'
    const textColor = dark ? '#cbd5e1' : '#475569'
    const visibleRows = Math.min(20, Math.max(1, matrix.itemNames.length))
    const end = matrix.itemNames.length > visibleRows ? visibleRows / matrix.itemNames.length * 100 : 100
    return {
      animation: !reducedMotion,
      animationDuration: reducedMotion ? 0 : 180,
      aria: {
        enabled: true,
        description: `${matrix.sourceRecordCount}条主营构成记录形成的跨报告期业务版图，颜色表示同报告期内的相对业务规模。`,
      },
      grid: { left: 118, right: matrix.itemNames.length > visibleRows ? 42 : 18, top: 16, bottom: 64 },
      tooltip: {
        trigger: 'item',
        backgroundColor: dark ? '#0f172a' : '#ffffff',
        borderColor: dark ? '#334155' : '#cbd5e1',
        textStyle: { color: dark ? '#e2e8f0' : '#0f172a', fontSize: 12 },
        formatter: (params: unknown) => {
          const source = params as { data?: { value?: [number, number, number]; revenue?: number; profit?: number | null; margin?: number | null; sourceCount?: number } }
          const value = source.data?.value
          if (!value) return ''
          return [
            `${matrix.itemNames[value[1]]} · ${formatFinancialReportPeriod(matrix.periods[value[0]])}`,
            `主营收入 ${formatFinancialAmount(source.data?.revenue ?? null)}`,
            `主营毛利 ${formatFinancialAmount(source.data?.profit ?? null)}`,
            `毛利率 ${formatPercent(source.data?.margin ?? null)}`,
            source.data?.sourceCount && source.data.sourceCount > 1 ? `合并 ${source.data.sourceCount} 条等值来源口径` : '',
          ].filter(Boolean).join('\n')
        },
      },
      xAxis: {
        type: 'category',
        data: matrix.periods.map(compactPeriod),
        axisLabel: { color: textColor, fontSize: 9, interval: 'auto' },
        axisLine: { lineStyle: { color: dark ? '#334155' : '#cbd5e1' } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'category',
        inverse: true,
        data: matrix.itemNames,
        axisLabel: { color: textColor, fontSize: 10, width: 104, overflow: 'truncate', formatter: (value: string) => compactName(value, 12) },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      visualMap: {
        type: 'piecewise',
        orient: 'horizontal',
        left: 'center',
        bottom: 2,
        itemWidth: 12,
        itemHeight: 8,
        itemGap: 10,
        selectedMode: false,
        textStyle: { color: textColor, fontSize: 9 },
        pieces: dark ? [
          { min: 75, max: 100, label: '主导', color: '#22d3ee' },
          { min: 40, max: 74.999, label: '重要', color: '#0891b2' },
          { min: 10, max: 39.999, label: '次要', color: '#155e75' },
          { min: 0, max: 9.999, label: '微量', color: '#172033' },
        ] : [
          { min: 75, max: 100, label: '主导', color: '#0e7490' },
          { min: 40, max: 74.999, label: '重要', color: '#22d3ee' },
          { min: 10, max: 39.999, label: '次要', color: '#a5f3fc' },
          { min: 0, max: 9.999, label: '微量', color: '#e2e8f0' },
        ],
      },
      dataZoom: matrix.itemNames.length > visibleRows ? [
        { type: 'inside', yAxisIndex: 0, start: 0, end },
        { type: 'slider', yAxisIndex: 0, right: 4, width: 10, start: 0, end, showDetail: false, borderColor: 'transparent' },
      ] : [],
      series: [{
        type: 'heatmap',
        data: matrix.points.map((point) => ({
          value: [point.periodIndex, point.itemIndex, point.relativeScale],
          revenue: point.revenue,
          profit: point.profit,
          margin: point.grossMarginPct,
          sourceCount: point.sourceCount,
        })),
        itemStyle: { borderColor: dark ? '#0f172a' : '#ffffff', borderWidth: 1 },
        emphasis: { itemStyle: { borderColor: dark ? '#f8fafc' : '#0f172a', borderWidth: 2 } },
      }],
    }
  }, [matrix, reducedMotion, theme])

  if (!exposures.length) {
    return <div className="border border-dashed border-slate-300 px-5 py-10 text-center text-sm leading-6 text-slate-400 dark:border-slate-700">尚无业务暴露。同步主营构成后将生成跨期业务结构分析。</div>
  }

  if (!overview.structuredCount) {
    const importedCount = exposures.filter((item) => item.sourceType === 'fina_mainbz').length
    return (
      <section data-testid="industry-research-exposure-overview" className="space-y-4">
        <div>
          <h4 className="text-sm font-semibold">业务结构分析</h4>
          <p className="mt-1 text-xs text-slate-500">已读取 {exposures.length} 条业务记录，但缺少可用于汇总的报告期与主营金额。</p>
        </div>
        <div className="border border-dashed border-amber-300 bg-amber-50/60 px-4 py-5 text-sm leading-6 text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
          {importedCount
            ? `${importedCount} 条记录来自主营构成同步，但当前数据响应没有携带报告期和金额，不能生成可信图表。请重新启动应用后刷新公司数据。`
            : '当前记录仅描述研究映射，不能代替主营构成。请在“同步状态”中同步主营构成数据。'}
        </div>
      </section>
    )
  }

  return (
    <section data-testid="industry-research-exposure-overview" className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold">业务结构分析</h4>
          <p className="mt-1 text-xs text-slate-500">
            {overview.periods.length} 个报告期 · {overview.structuredCount} 条主营构成 · {overview.uniqueItemCount} 个业务口径
          </p>
        </div>
        {overview.selectedPeriod && <span className="border border-cyan-200 bg-cyan-50 px-2 py-1 text-xs font-medium text-cyan-800 dark:border-cyan-900 dark:bg-cyan-950/30 dark:text-cyan-200">{formatFinancialReportPeriod(overview.selectedPeriod)}</span>}
      </header>

      <section aria-labelledby="business-composition-title" className="space-y-4 border-t border-slate-200 pt-4 dark:border-slate-800">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h5 id="business-composition-title" className="text-xs font-semibold text-slate-800 dark:text-slate-100">最新业务构成</h5>
            <p className="mt-1 text-[11px] text-slate-400">主营收入、毛利与构成比例按披露报告期呈现。</p>
          </div>
          <div data-testid="industry-research-exposure-periods" role="group" aria-label="业务构成报告期" className="flex max-w-full gap-1.5 overflow-x-auto py-1">
            {overview.periods.map((period) => (
              <button
                key={period}
                type="button"
                aria-pressed={overview.selectedPeriod === period}
                onClick={() => setSelectedPeriod(period)}
                className={`h-8 shrink-0 border px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${overview.selectedPeriod === period ? 'border-slate-900 bg-slate-900 font-semibold text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900' : 'border-slate-200 text-slate-500 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800'}`}
              >{formatFinancialReportPeriod(period)}</button>
            ))}
          </div>
        </div>

        <dl className="grid grid-cols-2 border-y border-slate-200 sm:grid-cols-4 dark:border-slate-800">
          <SummaryMetric label="主营收入" value={formatFinancialAmount(overview.totalRevenue)} />
          <SummaryMetric label="主营毛利" value={formatFinancialAmount(overview.totalProfit)} />
          <SummaryMetric label="综合毛利率" value={formatPercent(overview.grossMarginPct)} />
          <SummaryMetric label="前三项收入占比" value={formatPercent(overview.topThreeSharePct)} />
        </dl>

        <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(240px,0.55fr)]">
          <div className="min-w-0">
            <div className="mb-1 flex items-center justify-between gap-3">
              <h6 className="text-xs font-semibold text-slate-700 dark:text-slate-200">主营收入构成</h6>
              <span className="text-[11px] text-slate-400">{overview.items.length} 个分项</span>
            </div>
            {chartItems.length ? (
              <ReactECharts
                data-testid="industry-research-exposure-chart"
                option={compositionOption}
                notMerge
                lazyUpdate
                onEvents={{
                  click: (params: { name?: string }) => {
                    const item = overview.items.find((entry) => entry.name === params.name)
                    if (item?.exposures[0]) onEdit(item.exposures[0])
                  },
                }}
                opts={{ renderer: 'canvas' }}
                style={{ width: '100%', height: Math.max(230, chartItems.length * 38 + 54) }}
              />
            ) : <ChartEmpty text="本报告期未披露可绘制的主营收入。" />}
          </div>
          <aside className="border-l border-slate-200 pl-5 dark:border-slate-800">
            <h6 className="text-xs font-semibold text-slate-700 dark:text-slate-200">结构摘要</h6>
            <dl className="mt-3 space-y-4 text-sm">
              <SummaryLine label="第一大业务" value={overview.topItem ? `${overview.topItem.name} · ${formatPercent(overview.topItem.revenueSharePct)}` : '未披露'} />
              <SummaryLine label="同比变化" value={overview.topItem && overview.previousComparablePeriod ? `${overview.topItem.name} · ${formatPercent(overview.topItemChangePct, true)}` : '缺少可比报告期'} />
              <SummaryLine label="毛利率最高" value={overview.highestMarginItem ? `${overview.highestMarginItem.name} · ${formatPercent(overview.highestMarginItem.grossMarginPct)}` : '未披露'} />
              {researchMappings.length > 0 && <SummaryLine label="研究映射暴露（独立口径）" value={researchMappings.map((item) => `${item.name} · ${formatPercent(item.exposurePct)}`).join(' / ')} />}
            </dl>
          </aside>
        </div>
      </section>

      <section aria-labelledby="business-trend-title" className="border-t border-slate-200 pt-4 dark:border-slate-800">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h5 id="business-trend-title" className="text-xs font-semibold text-slate-800 dark:text-slate-100">核心业务收入演变</h5>
            <p className="mt-1 text-[11px] text-slate-400">按规模筛选可比业务口径，年报与中报分开观察。</p>
          </div>
          <div role="group" aria-label="历史趋势报告类型" className="flex h-8 border border-slate-300 p-0.5 dark:border-slate-700">
            {([['annual', '年报趋势'], ['interim', '中报趋势']] as const).map(([scope, label]) => (
              <button
                key={scope}
                type="button"
                aria-pressed={trendScope === scope}
                disabled={scope === 'annual' ? !annualTrend.periods.length : !interimTrend.periods.length}
                onClick={() => setTrendScope(scope)}
                className={`px-3 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${trendScope === scope ? 'bg-slate-900 font-semibold text-white dark:bg-slate-100 dark:text-slate-900' : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'}`}
              >{label}</button>
            ))}
          </div>
        </div>
        {trend.periods.length ? (
          <ReactECharts
            data-testid="industry-research-exposure-trend-chart"
            option={trendOption}
            notMerge
            lazyUpdate
            opts={{ renderer: 'canvas' }}
            style={{ width: '100%', height: 300 }}
          />
        ) : <ChartEmpty text="缺少同类型报告期，暂时不能形成可比趋势。" />}
        <p className="text-[11px] leading-5 text-slate-400">
          {trend.sourceRecordCount} 条{trendScope === 'annual' ? '年报' : '中报'}记录参与排序与覆盖分析；折线展示规模最大的 {trend.series.length} 个口径，空档不做插值。
        </p>
      </section>

      <section aria-labelledby="business-matrix-title" className="border-t border-slate-200 pt-4 dark:border-slate-800">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h5 id="business-matrix-title" className="text-xs font-semibold text-slate-800 dark:text-slate-100">全量业务版图</h5>
            <p className="mt-1 text-[11px] text-slate-400">跨报告期识别业务进入、退出与相对规模迁移。</p>
          </div>
          <div className="text-right text-[11px] leading-5 text-slate-400">
            <div>{matrix.sourceRecordCount} 条来源记录 → {matrix.comparableCellCount} 个可比单元</div>
            {matrix.duplicateMergedCount > 0 && <div>已合并 {matrix.duplicateMergedCount} 条同报告期等值口径</div>}
          </div>
        </div>
        <ReactECharts
          data-testid="industry-research-exposure-matrix-chart"
          option={matrixOption}
          notMerge
          lazyUpdate
          opts={{ renderer: 'canvas' }}
          style={{ width: '100%', height: Math.min(620, Math.max(320, matrix.itemNames.length * 24 + 92)) }}
        />
      </section>

      <section aria-labelledby="business-change-title" className="grid gap-4 border-y border-slate-200 py-4 md:grid-cols-3 dark:border-slate-800">
        <div>
          <h5 id="business-change-title" className="text-[11px] text-slate-400">最新新增口径</h5>
          <p className="mt-1 text-sm leading-6 text-slate-800 dark:text-slate-200">{overview.newItemNames.length ? overview.newItemNames.join(' / ') : '与上一可比期一致'}</p>
        </div>
        <div>
          <h5 className="text-[11px] text-slate-400">最新退出口径</h5>
          <p className="mt-1 text-sm leading-6 text-slate-800 dark:text-slate-200">{overview.exitedItemNames.length ? overview.exitedItemNames.join(' / ') : '无'}</p>
        </div>
        <div>
          <h5 className="text-[11px] text-slate-400">数据覆盖</h5>
          <p className="mt-1 text-sm leading-6 text-slate-800 dark:text-slate-200">{formatFinancialReportPeriod(overview.periods.at(-1) ?? null)} 至 {formatFinancialReportPeriod(overview.periods[0])}</p>
        </div>
      </section>
    </section>
  )
}

function SummaryMetric({ label, value }: { label: string; value: string }): React.ReactElement {
  return <div className="border-r border-slate-200 px-3 py-3 last:border-r-0 dark:border-slate-800"><dt className="text-[11px] text-slate-500">{label}</dt><dd className="mt-1 text-base font-semibold tabular-nums text-slate-900 dark:text-slate-100">{value}</dd></div>
}

function SummaryLine({ label, value }: { label: string; value: string }): React.ReactElement {
  return <div><dt className="text-[11px] text-slate-400">{label}</dt><dd className="mt-1 leading-6 text-slate-800 dark:text-slate-200">{value}</dd></div>
}

function ChartEmpty({ text }: { text: string }): React.ReactElement {
  return <div className="flex h-56 items-center justify-center border border-dashed border-slate-300 px-4 text-center text-sm text-slate-400 dark:border-slate-700">{text}</div>
}
