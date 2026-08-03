/**
 * 技术因子摘要组件
 * 从 StockMiniChart 提取为独立模块，供 StockMiniChart 和 StockChart 共用。
 */

import React from 'react'

/** 技术因子数据结构（与 Tushare stk_factor_pro 接口字段对应） */
export type FactorData = {
  tsCode: string
  tradeDate: string
  close: number | null
  macdBfq: number | null
  macdDifBfq: number | null
  macdDeaBfq: number | null
  kdjKBfq: number | null
  kdjDBfq: number | null
  kdjBfq: number | null
  rsiBfq6: number | null
  rsiBfq12: number | null
  bollUpperBfq: number | null
  bollMidBfq: number | null
  bollLowerBfq: number | null
  maBfq5: number | null
  maBfq10: number | null
  maBfq20: number | null
  maBfq60: number | null
  turnoverRate: number | null
  volumeRatio: number | null
  updays: number | null
  downdays: number | null
}

/** 技术因子摘要展示组件 */
export const FactorSummary: React.FC<{ factor: FactorData; variant?: 'default' | 'terminal' }> = ({
  factor,
  variant = 'default',
}) => {
  const terminal = variant === 'terminal'
  const { macdBfq, macdDifBfq, macdDeaBfq } = factor
  const macdLabel =
    macdBfq != null && macdDifBfq != null && macdDeaBfq != null
      ? macdBfq > 0 && macdDifBfq > macdDeaBfq
        ? '金叉▲'
        : macdBfq < 0 && macdDifBfq < macdDeaBfq
          ? '死叉▼'
          : '震荡'
      : null

  const { maBfq5: ma5, maBfq10: ma10, maBfq20: ma20, maBfq60: ma60 } = factor
  const maLabel =
    ma5 != null && ma10 != null && ma20 != null && ma60 != null
      ? ma5 > ma10 && ma10 > ma20 && ma20 > ma60
        ? '多头排列'
        : ma5 < ma10 && ma10 < ma20 && ma20 < ma60
          ? '空头排列'
          : '均线纠缠'
      : null

  const price = factor.close
  const bollLabel =
    price != null && factor.bollUpperBfq != null && factor.bollLowerBfq != null
      ? price > factor.bollUpperBfq
        ? '突破上轨'
        : price < factor.bollLowerBfq
          ? '跌破下轨'
          : '轨道内'
      : null

  const macdColor =
    macdLabel === '金叉▲' ? 'text-red-400' : macdLabel === '死叉▼' ? 'text-green-400' : terminal ? 'text-slate-400' : 'text-gray-400'
  const maColor =
    maLabel === '多头排列' ? 'text-red-400' : maLabel === '空头排列' ? 'text-green-400' : terminal ? 'text-slate-400' : 'text-gray-400'
  const bollColor =
    bollLabel === '突破上轨' ? 'text-red-400' : bollLabel === '跌破下轨' ? 'text-green-400' : terminal ? 'text-slate-400' : 'text-gray-400'
  const rowColor = terminal ? 'text-slate-400' : 'text-gray-500 dark:text-gray-400'

  return (
    <div className={terminal
      ? 'space-y-0.5 border-t border-slate-800 bg-slate-950/35 px-3 py-2 text-xs'
      : 'space-y-0.5 border-t border-gray-200 px-3 py-1.5 text-xs dark:border-gray-700'}>
      {/* 第一行：MACD / KDJ / RSI / 量比 / 换手 / 连涨跌 */}
      <div className={`flex flex-wrap gap-x-3 gap-y-0 ${rowColor}`}>
        {macdLabel && (
          <span>MACD <span className={macdColor}>{macdLabel}</span></span>
        )}
        {factor.kdjKBfq != null && (
          <span>
            KDJ K:{factor.kdjKBfq.toFixed(0)}/D:{factor.kdjDBfq?.toFixed(0) ?? '—'}/J:{factor.kdjBfq?.toFixed(0) ?? '—'}
          </span>
        )}
        {factor.rsiBfq6 != null && (
          <span className={factor.rsiBfq6 > 70 ? 'text-red-400' : factor.rsiBfq6 < 30 ? 'text-green-400' : ''}>
            RSI6:{factor.rsiBfq6.toFixed(1)}
          </span>
        )}
        {factor.volumeRatio != null && (
          <span className={factor.volumeRatio > 2 ? 'text-yellow-400' : ''}>
            量比:{factor.volumeRatio.toFixed(2)}
          </span>
        )}
        {factor.turnoverRate != null && <span>换手:{factor.turnoverRate.toFixed(2)}%</span>}
        {factor.updays != null && factor.updays > 0 && (
          <span className="text-red-400">连涨{factor.updays}日</span>
        )}
        {factor.downdays != null && factor.downdays > 0 && (
          <span className="text-green-400">连跌{factor.downdays}日</span>
        )}
      </div>
      {/* 第二行：BOLL 位置 + MA 排列 + MA 值 */}
      <div className={`flex flex-wrap gap-x-3 gap-y-0 ${rowColor}`}>
        {bollLabel && <span>BOLL <span className={bollColor}>{bollLabel}</span></span>}
        {maLabel && <span className={maColor}>{maLabel}</span>}
        {ma5 != null && <span>MA5:{ma5.toFixed(2)}</span>}
        {ma10 != null && <span>MA10:{ma10.toFixed(2)}</span>}
        {ma20 != null && <span>MA20:{ma20.toFixed(2)}</span>}
        {ma60 != null && <span>MA60:{ma60.toFixed(2)}</span>}
      </div>
    </div>
  )
}
