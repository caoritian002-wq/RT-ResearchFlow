import { useMemo } from 'react'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

interface EquityPoint {
  date: string
  realizedReturnPct: number
  tradeCount: number
  equity: number
  drawdownPct: number
}

interface BacktestEquityChartProps {
  points: EquityPoint[]
  totalReturn: number | null
  maxDrawdown: number | null
  startDate: string
}

interface EquityChartPoint extends EquityPoint {
  axisLabel: string
  cumulativeReturnPct: number
  chartDrawdownPct: number
  baseline: boolean
}

function shortDate(value: string): string {
  return /^\d{8}$/.test(value) ? `${value.slice(4, 6)}/${value.slice(6, 8)}` : value
}

function formatPct(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function formatDrawdownPct(value: number): string {
  return `${Math.abs(value).toFixed(2)}%`
}

export function buildBacktestEquityChartData(points: EquityPoint[], startDate: string): EquityChartPoint[] {
  const realizedPoints = points.map((point) => ({
    ...point,
    axisLabel: shortDate(point.date),
    cumulativeReturnPct: (point.equity - 1) * 100,
    chartDrawdownPct: -Math.abs(point.drawdownPct),
    baseline: false,
  }))

  if (realizedPoints.length !== 1) return realizedPoints

  const baselineDate = /^\d{8}$/.test(startDate) ? startDate : realizedPoints[0].date
  return [{
    date: baselineDate,
    axisLabel: '起点',
    realizedReturnPct: 0,
    tradeCount: 0,
    equity: 1,
    drawdownPct: 0,
    cumulativeReturnPct: 0,
    chartDrawdownPct: 0,
    baseline: true,
  }, realizedPoints[0]]
}

export function BacktestEquityChart({
  points,
  totalReturn,
  maxDrawdown,
  startDate,
}: BacktestEquityChartProps): JSX.Element {
  const data = useMemo(() => buildBacktestEquityChartData(points, startDate), [points, startDate])
  const singleRealization = points.length === 1 ? points[0] : null

  if (data.length === 0) {
    return (
      <div className="flex h-56 items-center justify-center border-y border-slate-100 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
        当前报告没有可绘制的权益曲线
      </div>
    )
  }

  return (
    <section data-testid="backtest-equity-chart" className="border-y border-slate-100 py-4 dark:border-slate-800">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3 px-1">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">实现净值曲线</h3>
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">按交易出场日确认收益，同日多笔交易等权聚合。</p>
        </div>
        <div className="flex items-center gap-4 text-xs tabular-nums">
          <span className="text-slate-500 dark:text-slate-400">累计 <strong className={totalReturn != null && totalReturn >= 0 ? 'text-rose-600 dark:text-rose-300' : 'text-emerald-600 dark:text-emerald-300'}>{totalReturn == null ? '—' : formatPct(totalReturn)}</strong></span>
          <span className="text-slate-500 dark:text-slate-400">最大回撤 <strong className="text-slate-800 dark:text-slate-200">{maxDrawdown == null ? '—' : formatDrawdownPct(maxDrawdown)}</strong></span>
        </div>
      </div>
      {singleRealization && (
        <div
          data-testid="backtest-equity-single-day-note"
          className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-cyan-200 bg-cyan-50/70 px-3 py-2 text-xs leading-5 text-slate-600 dark:border-cyan-900 dark:bg-cyan-950/25 dark:text-slate-300"
        >
          <span className="font-semibold text-cyan-800 dark:text-cyan-200">本区间仅 1 个实现日</span>
          <span>{singleRealization.tradeCount} 笔交易集中在 {shortDate(singleRealization.date)} 出场；曲线从 0% 基准连接至真实结果，不代表逐日盯市净值。</span>
        </div>
      )}
      <div
        role="img"
        aria-label={`策略实现净值曲线，共 ${points.length} 个实现日，累计收益 ${totalReturn == null ? '不可统计' : formatPct(totalReturn)}，最大回撤 ${maxDrawdown == null ? '不可统计' : formatDrawdownPct(maxDrawdown)}`}
        className="h-60 w-full text-slate-200 dark:text-slate-700"
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="backtest-equity-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgb(8 145 178)" stopOpacity={0.24} />
                <stop offset="100%" stopColor="rgb(8 145 178)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="currentColor" strokeDasharray="3 4" vertical={false} />
            <XAxis dataKey="axisLabel" minTickGap={28} tick={{ fill: 'rgb(100 116 139)', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={(value) => `${Number(value).toFixed(0)}%`} width={48} tick={{ fill: 'rgb(100 116 139)', fontSize: 11 }} axisLine={false} tickLine={false} />
            <ReferenceLine y={0} stroke="rgb(148 163 184)" strokeDasharray="3 3" />
            <Tooltip
              labelFormatter={(_label, payload) => {
                const point = payload?.[0]?.payload as EquityChartPoint | undefined
                if (!point) return '实现净值'
                return point.baseline
                  ? `回测起点 ${shortDate(point.date)}`
                  : `实现日 ${shortDate(point.date)} · ${point.tradeCount} 笔出场`
              }}
              formatter={(value, name) => [
                name === '当前回撤' ? formatDrawdownPct(Number(value)) : formatPct(Number(value)),
                name,
              ]}
              contentStyle={{ borderRadius: 6, borderColor: 'rgb(203 213 225)', boxShadow: '0 10px 24px rgb(15 23 42 / 0.12)', fontSize: 12 }}
            />
            <Area name="累计实现收益" type="monotone" dataKey="cumulativeReturnPct" stroke="rgb(8 145 178)" strokeWidth={2} fill="url(#backtest-equity-fill)" dot={singleRealization ? { r: 3, strokeWidth: 2 } : false} activeDot={{ r: 4 }} isAnimationActive={false} />
            <Line name="当前回撤" type="monotone" dataKey="chartDrawdownPct" stroke="rgb(225 29 72)" strokeWidth={1.5} strokeDasharray="5 4" dot={singleRealization ? { r: 2.5, strokeWidth: 1.5 } : false} activeDot={{ r: 3 }} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex items-center justify-end gap-4 px-1 text-[11px] text-slate-500 dark:text-slate-400" aria-hidden="true">
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 bg-cyan-600" />累计实现收益</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-4 border-t border-dashed border-rose-600" />当前回撤（向下）</span>
      </div>
    </section>
  )
}
