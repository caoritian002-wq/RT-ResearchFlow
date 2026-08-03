import React, { useMemo } from 'react'
import type { ChipProfileSummary } from '../../utils/drawChipsCanvas'
import { FactorSummary, type FactorData } from './FactorSummary'
import {
  buildStockStructureInsight,
  type StockStructureRow,
  type StockStructureTone,
} from './stockStructureInsightModel'

interface StockStructureInsightProps {
  rows: StockStructureRow[]
  visibleRange: 30 | 60 | 120
  selectedDate: string | null
  activeProfile: ChipProfileSummary | null
  latestProfile: ChipProfileSummary | null
  hasActiveChips: boolean
  factor: FactorData | null
}

function formatDate(value: string | null | undefined): string {
  if (!value || value.length !== 8) return '日期待补'
  return `${value.slice(0, 4)}/${value.slice(4, 6)}/${value.slice(6, 8)}`
}

function formatPercent(value: number | null | undefined, digits = 1, signed = false): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const prefix = signed && value > 0 ? '+' : ''
  return `${prefix}${value.toFixed(digits)}%`
}

function formatPoints(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}pp`
}

function formatPrice(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '—' : value.toFixed(2)
}

function toneClasses(tone: StockStructureTone): string {
  if (tone === 'positive') return 'border-rose-400/70 bg-rose-950/20 text-rose-100'
  if (tone === 'negative') return 'border-emerald-300/70 bg-emerald-950/20 text-emerald-100'
  return 'border-cyan-300/60 bg-cyan-950/18 text-slate-200'
}

function MetricRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex min-h-7 items-baseline justify-between gap-3 border-b border-slate-800/80 py-1 last:border-b-0">
      <dt className="shrink-0 text-[10px] text-slate-500">{label}</dt>
      <dd className="min-w-0 text-right font-mono text-[11px] font-medium tabular-nums text-slate-200">
        {value}
        {hint && <span className="ml-1 font-sans text-[9px] font-normal text-slate-500">{hint}</span>}
      </dd>
    </div>
  )
}

function InsightConclusion({ tone, children }: { tone: StockStructureTone; children: React.ReactNode }) {
  return (
    <p className={`mt-3 border-l-2 px-2.5 py-2 text-[11px] leading-5 ${toneClasses(tone)}`}>
      {children}
    </p>
  )
}

export function StockStructureInsight({
  rows,
  visibleRange,
  selectedDate,
  activeProfile,
  latestProfile,
  hasActiveChips,
  factor,
}: StockStructureInsightProps) {
  const insight = useMemo(() => buildStockStructureInsight({
    rows,
    activeDate: selectedDate,
    visibleRange,
    activeProfile,
    latestProfile,
  }), [activeProfile, latestProfile, rows, selectedDate, visibleRange])

  const maReading = (distance: number | null, slope: number | null) => {
    if (distance == null) return '—'
    const position = distance >= 0 ? `上方 ${Math.abs(distance).toFixed(1)}%` : `下方 ${Math.abs(distance).toFixed(1)}%`
    return slope == null ? position : `${position} · ${slope > 0 ? '+' : ''}${slope.toFixed(1)}%`
  }
  const supportHint = insight.risk.supportDistancePercent == null ? undefined : `下方 ${insight.risk.supportDistancePercent.toFixed(1)}%`
  const resistanceHint = insight.risk.resistanceDistancePercent == null ? undefined : `上方 ${insight.risk.resistanceDistancePercent.toFixed(1)}%`
  const amountLabel = insight.risk.amountChangePercent == null
    ? '—'
    : insight.risk.amountChangePercent > 5
      ? `放量 ${formatPercent(insight.risk.amountChangePercent, 1, true)}`
      : insight.risk.amountChangePercent < -5
        ? `缩量 ${formatPercent(insight.risk.amountChangePercent)}`
        : `量能接近 ${formatPercent(insight.risk.amountChangePercent, 1, true)}`

  return (
    <section data-testid="stock-structure-insight" className="border-t border-slate-700 bg-slate-900">
      <header className="flex min-h-11 flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-3 w-0.5 shrink-0 rounded-full bg-cyan-300" aria-hidden="true" />
          <h3 className="text-xs font-semibold text-slate-100">价格 × 筹码结构研判</h3>
          <span className="text-[10px] text-slate-500">仅基于本地事实计算</span>
        </div>
        <div className="font-mono text-[10px] tabular-nums text-slate-400">
          {insight.isHistorical ? `历史快照 ${formatDate(insight.activeDate)}` : `最新结构 ${formatDate(insight.activeDate)}`}
          <span className="mx-1.5 text-slate-700">/</span>{visibleRange}日窗口
        </div>
      </header>

      <div className="grid border-t border-slate-800 md:grid-cols-2 xl:grid-cols-3">
        <section className="min-w-0 px-3 py-3 md:border-r md:border-slate-800" aria-labelledby="stock-trend-position-title">
          <h4 id="stock-trend-position-title" className="mb-2 text-[11px] font-semibold text-slate-300">趋势与位置</h4>
          <dl>
            <MetricRow label="MA20位置 / 5日斜率" value={maReading(insight.trend.ma20.distancePercent, insight.trend.ma20.slopePercent)} />
            <MetricRow label="MA60位置 / 5日斜率" value={maReading(insight.trend.ma60.distancePercent, insight.trend.ma60.slopePercent)} />
            <MetricRow label={`${visibleRange}日区间位置`} value={formatPercent(insight.trend.rangePositionPercent)} />
            <MetricRow
              label="5 / 20 / 60日涨跌"
              value={`${formatPercent(insight.trend.returns[5], 1, true)} / ${formatPercent(insight.trend.returns[20], 1, true)} / ${formatPercent(insight.trend.returns[60], 1, true)}`}
            />
          </dl>
          <InsightConclusion tone={insight.trend.tone}>{insight.trend.summary}</InsightConclusion>
        </section>

        <section className="min-w-0 border-t border-slate-800 px-3 py-3 md:border-t-0" aria-labelledby="stock-chip-change-title">
          <h4 id="stock-chip-change-title" className="mb-2 text-[11px] font-semibold text-slate-300">
            {insight.isHistorical ? '筹码变化' : '当前筹码结构'}
          </h4>
          <dl>
            {insight.isHistorical ? (
              <>
                <MetricRow label="主峰迁移" value={formatPercent(insight.chips.peakShiftPercent, 1, true)} />
                <MetricRow label="成本中枢迁移" value={formatPercent(insight.chips.coreShiftPercent, 1, true)} />
                <MetricRow label="核心区宽度变化" value={formatPoints(insight.chips.coreWidthChangePoints)} />
                <MetricRow label="浮盈比例变化" value={formatPoints(insight.chips.profitChangePoints)} />
              </>
            ) : (
              <>
                <MetricRow label="当前主峰" value={formatPrice(insight.chips.peakPrice)} />
                <MetricRow label="70%核心成本区" value={insight.chips.coreLowPrice == null ? '—' : `${formatPrice(insight.chips.coreLowPrice)} – ${formatPrice(insight.chips.coreHighPrice)}`} />
                <MetricRow label="核心区宽度" value={formatPercent(insight.chips.coreWidthPercent)} />
                <MetricRow label="浮盈 / 套牢" value={`${formatPercent(insight.chips.profitPercent)} / ${formatPercent(insight.chips.profitPercent == null ? null : 100 - insight.chips.profitPercent)}`} />
              </>
            )}
          </dl>
          <InsightConclusion tone={insight.chips.tone}>{insight.chips.summary}</InsightConclusion>
        </section>

        <section className="min-w-0 border-t border-slate-800 px-3 py-3 md:col-span-2 xl:col-span-1 xl:border-l xl:border-slate-800 xl:border-t-0" aria-labelledby="stock-key-risk-title">
          <h4 id="stock-key-risk-title" className="mb-2 text-[11px] font-semibold text-slate-300">关键位置与风险</h4>
          <dl className="md:grid md:grid-cols-2 md:gap-x-4 xl:block">
            <MetricRow label="支撑候选" value={formatPrice(insight.risk.support)} hint={supportHint} />
            <MetricRow label="压力候选" value={formatPrice(insight.risk.resistance)} hint={resistanceHint} />
            <MetricRow label="ATR14 / 现价" value={formatPercent(insight.risk.atrPercent)} />
            <MetricRow label={`${visibleRange}日最大回撤`} value={insight.risk.maxDrawdownPercent == null ? '—' : `-${insight.risk.maxDrawdownPercent.toFixed(1)}%`} />
            <MetricRow label="近5日量能变化" value={amountLabel} />
          </dl>
          <div className="mt-3 grid gap-1.5 md:grid-cols-2 xl:grid-cols-1">
            <p className="border-l-2 border-cyan-400/60 bg-slate-950/45 px-2.5 py-1.5 text-[10px] leading-4 text-slate-300"><span className="font-semibold text-cyan-200">观察：</span>{insight.risk.observation}</p>
            <p className="border-l-2 border-amber-400/60 bg-slate-950/45 px-2.5 py-1.5 text-[10px] leading-4 text-slate-300"><span className="font-semibold text-amber-200">失效：</span>{insight.risk.invalidation}</p>
          </div>
        </section>
      </div>

      <details data-testid="stock-technical-factors" className="group border-t border-slate-800">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-[11px] text-slate-400 transition-colors hover:bg-slate-800/60 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400">
          <span className="font-medium">更多技术因子</span>
          <span className="text-[10px] text-slate-600">MACD、KDJ、RSI、BOLL、换手与量比</span>
          <span className="ml-auto font-mono text-[10px] text-slate-500">{factor ? formatDate(factor.tradeDate) : '因子待补'}</span>
          <span className="text-slate-500 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true">⌄</span>
        </summary>
        {factor ? <FactorSummary factor={factor} variant="terminal" /> : <p className="border-t border-slate-800 px-3 py-3 text-xs text-slate-500">当前没有可用技术因子，日K与筹码研判仍可独立查看。</p>}
      </details>

      <footer className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-800 bg-slate-950/55 px-3 py-1.5 text-[9px] text-slate-500">
        <span>行情 {formatDate(insight.latestDate)}</span>
        <span>日线 {insight.sampleCount}/{visibleRange} 个交易日（本地共 {insight.totalCount} 条）</span>
        <span>筹码 {hasActiveChips ? (insight.isHistorical ? `${formatDate(insight.activeDate)} 对比最新` : '当前日期可用') : '当前日期待补'}</span>
        <span>技术因子 {factor ? formatDate(factor.tradeDate) : '待补'}</span>
      </footer>
    </section>
  )
}
