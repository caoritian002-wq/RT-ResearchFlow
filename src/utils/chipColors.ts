/**
 * 筹码结论共享工具
 *
 * 提取自 ChipMonitor.tsx，供竞价界面等模块复用结论引擎，避免重复定义。
 */

// ── 类型定义 ─────────────────────────────────────────────────────────

/** 筹码结论计算所需数据字段（所有字段均可 null） */
export interface ChipConclusionData {
  loosening1d: number | null
  loosening3d: number | null
  loosening5d: number | null
  bottomPct: number | null
  pctChg: number | null
  turnoverRate: number | null
}

/** 筹码结论输出 */
export interface Conclusion {
  label: string
  color: string  // Tailwind text-color class
  tip: string    // hover tooltip 详细说明
}

// ── 辅助函数 ─────────────────────────────────────────────────────────

/**
 * 松动值颜色：≥10% 红色（异常松动）/ ≥3% 橙色 / >0 黄色 / ≤0 蓝色（固化）
 */
export function loosenColor(v: number | null): string {
  if (v == null) return 'text-gray-400 dark:text-gray-500'
  if (v >= 10) return 'text-red-500 dark:text-red-400 font-medium'
  if (v >= 3) return 'text-orange-500 dark:text-orange-400'
  if (v > 0) return 'text-yellow-600 dark:text-yellow-400'
  return 'text-blue-500 dark:text-blue-400'
}

/**
 * 基于松动指标 + 当日涨跌幅 + 换手率推断筹码行为结论
 *
 * 逻辑层级（由强到弱）：
 * 1. 数据不足 → 无法判断
 * 2. 三周期均固化 + 当日上涨 → 低位吸筹（主力压低收集）
 * 3. 异常松动（1日≥15%）+ 当日下跌 → 出货信号较强（高位减仓）
 * 4. 异常松动（1日≥15%）+ 涨停 → 解套换手（低成本户离场）
 * 5. 三周期持续松动 + 底部占比<20% + 当日上涨 → 筹码上移（成本结构整体抬升）
 * 6. 三周期持续松动 + 当日上涨 → 价升筹散（正常上涨换手）
 * 7. 三周期持续松动 + 当日下跌 → 疑似出货（需结合量能判断）
 * 8. 其他 → 信号混合
 */
export function getConclusion(r: ChipConclusionData): Conclusion {
  const { loosening1d, loosening3d, loosening5d, bottomPct, pctChg, turnoverRate } = r

  // 当日涨跌幅数据缺失
  if (pctChg == null) {
    return { label: '—', color: 'text-gray-400 dark:text-gray-500', tip: '当日价格数据缺失，无法判断' }
  }

  const rising = pctChg >= 2
  const falling = pctChg <= -2
  const limitUp = pctChg >= 9.5
  const highTurnover = (turnoverRate ?? 0) >= 8

  const allLoosening =
    (loosening1d ?? -1) > 0 && (loosening3d ?? -1) > 0 && (loosening5d ?? -1) > 0
  const allFixed =
    (loosening1d ?? 1) < 0 && (loosening3d ?? 1) < 0 && (loosening5d ?? 1) < 0
  const abnormal = (loosening1d ?? 0) >= 15

  // 1. 三周期固化 + 上涨 → 低位吸筹
  if (allFixed && rising) {
    return {
      label: '📥 低位吸筹',
      color: 'text-emerald-600 dark:text-emerald-400',
      tip: `底部筹码持续增加（3周期均固化），同日价格上涨 ${pctChg.toFixed(1)}%。\n低位成本区资金持续积累，符合主力建仓特征。`,
    }
  }

  // 2. 异常松动 + 下跌 → 出货信号
  if (abnormal && falling) {
    return {
      label: '🚨 疑似出货',
      color: 'text-red-600 dark:text-red-400',
      tip: `1日松动 ${loosening1d?.toFixed(1)}%（异常大），同日价格下跌 ${pctChg.toFixed(1)}%。\n底部低成本筹码大量离场叠加价格下跌，出货信号较强。`,
    }
  }

  // 3. 异常松动 + 涨停 → 解套换手
  if (abnormal && limitUp) {
    return {
      label: '🔄 解套换手',
      color: 'text-sky-500 dark:text-sky-400',
      tip: `1日松动 ${loosening1d?.toFixed(1)}%，当日涨停（${pctChg.toFixed(1)}%）。\n涨停封板，买盘强劲，底部低成本户解套离场属正常换手，有新资金承接。`,
    }
  }

  // 4. 三周期松动 + 底部占比低 + 上涨 → 筹码上移
  if (allLoosening && (bottomPct ?? 100) < 20 && rising) {
    return {
      label: '↗ 筹码上移',
      color: 'text-orange-500 dark:text-orange-400',
      tip: `三周期持续松动，底部占比仅 ${bottomPct?.toFixed(1)}%（极低），同日上涨 ${pctChg.toFixed(1)}%。\n底部筹码已轻，成本结构整体向高位迁移，趋势健康。`,
    }
  }

  // 5. 三周期松动 + 上涨 → 价升筹散
  if (allLoosening && rising) {
    const turnoverNote = highTurnover ? `换手率 ${turnoverRate?.toFixed(1)}% 偏高，注意节奏。` : ''
    return {
      label: '✅ 价升筹散',
      color: 'text-green-600 dark:text-green-400',
      tip: `三周期持续松动，同日上涨 ${pctChg.toFixed(1)}%。\n上涨过程中低成本户有序兑现，属正常换手。${turnoverNote}`,
    }
  }

  // 6. 三周期松动 + 下跌 → 疑似出货
  if (allLoosening && falling) {
    return {
      label: '⚠️ 松动下跌',
      color: 'text-yellow-600 dark:text-yellow-500',
      tip: `三周期持续松动，同日价格下跌 ${pctChg.toFixed(1)}%。\n底部筹码减少叠加价格下行，需警惕主力出货，建议结合成交量判断。`,
    }
  }

  // 7. 其他
  return {
    label: '— 信号混合',
    color: 'text-gray-500 dark:text-gray-400',
    tip: `松动信号不一致，价格变动 ${pctChg >= 0 ? '+' : ''}${pctChg.toFixed(1)}%。\n多空交织，暂无明确结论，建议观察后续走势。`,
  }
}
