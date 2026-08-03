export const DIP_BUY_STRATEGY_VERSION = '2.0.0'

export const DIP_BUY_STRATEGY_KEYS = {
  trendDip: 'shortTerm.dipBuy.trend',
  arbitrageDip: 'shortTerm.dipBuy.arbitrage',
  rotationDip: 'shortTerm.dipBuy.rotation',
} as const

export type DipMode = keyof typeof DIP_BUY_STRATEGY_KEYS
export type DipDataMode = 'realtime' | 'eod' | 'fallback'
export type DipConditionStatus = 'passed' | 'failed' | 'unknown'
export type DipCandidateTier = 'focus' | 'watch' | 'insufficient' | 'rejected'
export type DipDataStatus = 'complete' | 'partial' | 'insufficient'
export type DipModeStatus = 'available' | 'watch' | 'blocked' | 'empty' | 'insufficient'

export interface DipCondition {
  key: string
  label: string
  status: DipConditionStatus
  value: string
  detail: string
  required: boolean
}

export interface DipCandidateJudgment {
  tier: DipCandidateTier
  title: string
  summary: string
  rankScore: number | null
  completeness: number
  dataStatus: DipDataStatus
  missingFields: string[]
  conditions: DipCondition[]
  evidence: string[]
  risks: string[]
  confirmations: string[]
  invalidations: string[]
}

export interface DipModeJudgment {
  mode: DipMode
  status: DipModeStatus
  title: string
  summary: string
  screenedCount: number
  focusCount: number
  watchCount: number
  insufficientCount: number
  rejectedCount: number
  completeness: number
  dataStatus: DipDataStatus
  gates: DipCondition[]
  missingFields: string[]
  strategyKey: string
  strategyVersion: string
}

export interface TrendDipJudgmentInput {
  dataMode: DipDataMode
  currentPrice: number | null
  currentIsLimitUp: boolean | null
  recentPeakBoards: number | null
  recentPeakDate: string | null
  ma10: number | null
  ma20: number | null
  ma30: number | null
  ma20Slope5Pct: number | null
  nearestMaLabel: string | null
  distanceToNearestMaPct: number | null
  themeName: string | null
  themeLimitUpCount: number | null
}

export interface ArbitrageDipJudgmentInput {
  dataMode: DipDataMode
  marketLimitUpCount: number | null
  retreatThemeCount: number | null
  recentLimitUpDate: string | null
  themeName: string | null
  themeRetreated: boolean | null
  currentPctChg: number | null
  currentIsLimitDown: boolean | null
  drop5dPct: number | null
  netMoneyFlowAmount: number | null
  volumeRatio5: number | null
}

export interface RotationDipJudgmentInput {
  dataMode: DipDataMode
  leaderName: string | null
  leaderPreviousBoards: number | null
  leaderIsLimitUp: boolean | null
  leaderPctChg: number | null
  sameTheme: boolean | null
  themeName: string | null
  themeLimitUpCount: number | null
  candidateRecentPeakBoards: number | null
  candidatePctChg: number | null
}

export interface BuildDipModeJudgmentInput {
  mode: DipMode
  gates: DipCondition[]
  judgments: DipCandidateJudgment[]
  screenedCount: number
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value))
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)))
}

function pct(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function passed(key: string, label: string, value: string, detail: string, required = true): DipCondition {
  return { key, label, status: 'passed', value, detail, required }
}

function failed(key: string, label: string, value: string, detail: string, required = true): DipCondition {
  return { key, label, status: 'failed', value, detail, required }
}

function unknown(key: string, label: string, detail: string, required = true): DipCondition {
  return { key, label, status: 'unknown', value: '待补', detail, required }
}

function conditionResult(
  key: string,
  label: string,
  value: boolean | null,
  displayValue: string,
  passDetail: string,
  failDetail: string,
  unknownDetail: string,
  required = true,
): DipCondition {
  if (value == null) return unknown(key, label, unknownDetail, required)
  return value
    ? passed(key, label, displayValue, passDetail, required)
    : failed(key, label, displayValue, failDetail, required)
}

function finalizeCandidate(
  conditions: DipCondition[],
  rankScore: number | null,
  focus: boolean,
  summaries: { focus: string; watch: string; insufficient: string; rejected: string },
  confirmations: string[],
  invalidations: string[],
): DipCandidateJudgment {
  const required = conditions.filter((item) => item.required)
  const hasFailed = required.some((item) => item.status === 'failed')
  const hasUnknown = required.some((item) => item.status === 'unknown')
  const knownCount = conditions.filter((item) => item.status !== 'unknown').length
  const completeness = conditions.length === 0 ? 0 : Math.round(knownCount / conditions.length * 100)
  const tier: DipCandidateTier = hasFailed ? 'rejected' : hasUnknown ? 'insufficient' : focus ? 'focus' : 'watch'
  const dataStatus: DipDataStatus = hasUnknown
    ? 'insufficient'
    : completeness === 100
      ? 'complete'
      : 'partial'
  const title = tier === 'focus' ? '重点观察'
    : tier === 'watch' ? '选择性观察'
      : tier === 'insufficient' ? '证据待补'
        : '前置条件未通过'
  const evidence = conditions
    .filter((item) => item.status === 'passed')
    .map((item) => `${item.label}：${item.detail}`)
  const risks = conditions
    .filter((item) => item.status === 'failed' || item.status === 'unknown')
    .map((item) => `${item.label}：${item.detail}`)
  const missingFields = conditions
    .filter((item) => item.status === 'unknown')
    .map((item) => item.label)
  return {
    tier,
    title,
    summary: summaries[tier],
    rankScore: tier === 'focus' || tier === 'watch' ? rankScore : null,
    completeness,
    dataStatus,
    missingFields: unique(missingFields),
    conditions,
    evidence: unique(evidence),
    risks: unique(risks),
    confirmations,
    invalidations,
  }
}

export function judgeTrendDip(input: TrendDipJudgmentInput): DipCandidateJudgment {
  const hasRecentStrength = finite(input.recentPeakBoards) && input.recentPeakDate != null
    ? input.recentPeakBoards >= 2
    : null
  const hasMaHistory = finite(input.ma10) && finite(input.ma20) && finite(input.ma30)
  const nearSupport = finite(input.distanceToNearestMaPct)
    ? Math.abs(input.distanceToNearestMaPct) <= 2
    : null
  const holdsMa30 = finite(input.currentPrice) && finite(input.ma30)
    ? input.currentPrice >= input.ma30
    : null
  const slopeStable = finite(input.ma20Slope5Pct) ? input.ma20Slope5Pct >= 0 : null
  const notLimitUp = input.currentIsLimitUp == null ? null : !input.currentIsLimitUp
  const themeKnown = input.themeName != null && finite(input.themeLimitUpCount)

  const conditions: DipCondition[] = [
    conditionResult(
      'recentStrength', '近期强势事件', hasRecentStrength,
      hasRecentStrength ? `${input.recentPeakBoards}板 · ${input.recentPeakDate}` : input.recentPeakBoards == null ? '待补' : `${input.recentPeakBoards}板`,
      '近30个交易日存在真实二板及以上事件',
      '近30个交易日没有二板及以上强势事件',
      '近期连板事件覆盖不足',
    ),
    conditionResult(
      'maHistory', '均线历史', hasMaHistory,
      hasMaHistory ? 'MA10/20/30齐全' : '待补',
      '本地日线足以计算三条均线',
      '本地日线不足以计算三条均线',
      'MA10/20/30至少一项缺失',
    ),
    conditionResult(
      'nearSupport', '回踩位置', nearSupport,
      finite(input.distanceToNearestMaPct) && input.nearestMaLabel ? `${input.nearestMaLabel} ${pct(input.distanceToNearestMaPct)}` : '待补',
      '当前价位于最近均线支撑上下2%范围内',
      '当前价已经离开均线支撑上下2%范围',
      '当前价或最近均线位置缺失',
    ),
    conditionResult(
      'holdsMa30', '长期支撑', holdsMa30,
      finite(input.ma30) ? `MA30 ${input.ma30.toFixed(2)}` : '待补',
      '当前价格没有跌破MA30',
      '当前价格已经跌破MA30',
      '当前价或MA30缺失',
    ),
    conditionResult(
      'slopeStable', '趋势方向', slopeStable,
      finite(input.ma20Slope5Pct) ? `MA20五日${pct(input.ma20Slope5Pct)}` : '待补',
      'MA20最近五个交易日没有向下倾斜',
      'MA20最近五个交易日仍在向下',
      '缺少计算MA20五日方向的历史日线',
    ),
    conditionResult(
      'notLimitUp', '价格状态', notLimitUp,
      input.currentIsLimitUp == null ? '待补' : input.currentIsLimitUp ? '涨停' : '非涨停',
      '当前不是涨停追价状态',
      '当前仍处于涨停，不属于回踩观察',
      '当前价格状态缺失',
    ),
    conditionResult(
      'themeSupport', '题材支撑', themeKnown ? (input.themeLimitUpCount ?? 0) > 0 : null,
      themeKnown ? `${input.themeName} · ${input.themeLimitUpCount}只涨停` : input.themeName ?? '待补',
      '同题材仍有涨停广度',
      '同题材当前没有涨停支撑',
      '题材或当前涨停广度缺失',
      false,
    ),
  ]
  const rankScore = hasRecentStrength && nearSupport && holdsMa30 && slopeStable && notLimitUp
    ? clamp(
      70
      + Math.min(10, Math.max(0, (input.recentPeakBoards ?? 2) - 2) * 5)
      + Math.min(10, Math.max(0, input.ma20Slope5Pct ?? 0) * 4)
      + Math.min(10, Math.max(0, input.themeLimitUpCount ?? 0) * 4),
    )
    : null
  const focus = rankScore != null
    && (input.recentPeakBoards ?? 0) >= 3
    && (input.ma20Slope5Pct ?? 0) > 0
    && (input.themeLimitUpCount ?? 0) >= 1
  return finalizeCandidate(
    conditions,
    rankScore,
    focus,
    {
      focus: '近期强势事件、上行均线和题材支撑同时存在，当前回踩位置可列为重点观察。',
      watch: '趋势回踩的硬条件已经满足，但强势高度或题材支撑有限，只适合选择性观察。',
      insufficient: '均线、当前价格或近期强势事件证据不完整，暂不能确认趋势低吸条件。',
      rejected: '至少一项趋势低吸硬条件未通过，不进入本模式候选。',
    },
    ['后续收盘继续守住最近均线支撑，并重新转强时再提高观察优先级'],
    ['收盘跌破MA30，或MA20重新转为向下，本次趋势回踩条件失效'],
  )
}

export function judgeArbitrageDip(input: ArbitrageDipJudgmentInput): DipCandidateJudgment {
  const icePoint = finite(input.marketLimitUpCount) ? input.marketLimitUpCount < 30 : null
  const broadRetreat = finite(input.retreatThemeCount) ? input.retreatThemeCount > 0 : null
  const recentHot = input.recentLimitUpDate == null ? null : true
  const controlledDrop = finite(input.currentPctChg) && input.currentIsLimitDown != null
    ? !input.currentIsLimitDown && input.currentPctChg <= 0 && input.currentPctChg >= -5
    : null
  const capitalKnown = finite(input.netMoneyFlowAmount) || finite(input.volumeRatio5)
  const capitalConfirm = capitalKnown
    ? (finite(input.netMoneyFlowAmount) && input.netMoneyFlowAmount > 0)
      || (finite(input.volumeRatio5) && input.volumeRatio5 <= 0.8)
    : null
  const conditions: DipCondition[] = [
    conditionResult(
      'marketIce', '市场冰点', icePoint,
      finite(input.marketLimitUpCount) ? `${input.marketLimitUpCount}只涨停` : '待补',
      '全市场涨停数低于30，满足冰点观察前提',
      '全市场涨停数不少于30，不属于冰点套利环境',
      '当日涨停总数缺失',
    ),
    conditionResult(
      'themeRetreatBreadth', '题材退潮', broadRetreat,
      finite(input.retreatThemeCount) ? `${input.retreatThemeCount}个题材显著退潮` : '待补',
      '至少一个前一交易日主流题材的涨停广度下降过半',
      '没有观察到主流题材涨停广度下降过半',
      '前后两个交易日的题材涨停广度不足',
    ),
    conditionResult(
      'recentHot', '前期热点', recentHot,
      input.recentLimitUpDate ?? '待补',
      '近30个交易日曾出现涨停事件',
      '近30个交易日没有热点事件',
      '近期涨停事件覆盖不足',
    ),
    conditionResult(
      'themeRetreated', '个股题材归属', input.themeRetreated,
      input.themeName ?? '待补',
      '个股属于本次显著退潮题材',
      '个股不属于本次显著退潮题材',
      '题材映射缺失，无法确认是否属于退潮方向',
    ),
    conditionResult(
      'controlledDrop', '跌幅边界', controlledDrop,
      finite(input.currentPctChg) ? pct(input.currentPctChg) : '待补',
      '当日下跌在0%至-5%之间且没有跌停',
      '当日未下跌、跌幅超过5%或已经跌停',
      '当日涨跌幅或跌停状态缺失',
    ),
    conditionResult(
      'capitalConfirm', '资金或缩量', capitalConfirm,
      finite(input.netMoneyFlowAmount) && input.netMoneyFlowAmount > 0
        ? `资金净流入 ${input.netMoneyFlowAmount.toFixed(0)}万`
        : finite(input.volumeRatio5)
          ? `量比 ${input.volumeRatio5.toFixed(2)}`
          : '待补',
      finite(input.netMoneyFlowAmount) && input.netMoneyFlowAmount > 0
        ? '真实moneyflow显示净流入'
        : '收盘成交量不高于前五日均量的80%',
      '真实资金没有净流入且成交量未明显收缩',
      input.dataMode === 'realtime'
        ? '盘中累计成交量不能冒充收盘缩量，且当日moneyflow尚未形成'
        : 'moneyflow与收盘成交量确认均缺失',
    ),
    conditionResult(
      'drop5d', '五日位置', finite(input.drop5dPct) ? input.drop5dPct < 0 : null,
      finite(input.drop5dPct) ? pct(input.drop5dPct) : '待补',
      '近五日累计处于回撤状态',
      '近五日并未形成回撤',
      '五日累计涨跌幅缺失',
      false,
    ),
  ]
  const hardPassed = icePoint && broadRetreat && recentHot && input.themeRetreated === true && controlledDrop && capitalConfirm
  const rankScore = hardPassed
    ? clamp(
      70
      + (finite(input.netMoneyFlowAmount) && input.netMoneyFlowAmount > 0 ? 15 : 0)
      + (finite(input.volumeRatio5) && input.volumeRatio5 <= 0.8 ? 10 : 0)
      + (finite(input.drop5dPct) && input.drop5dPct <= -3 ? 5 : 0),
    )
    : null
  const focus = rankScore != null
    && finite(input.netMoneyFlowAmount)
    && input.netMoneyFlowAmount > 0
    && finite(input.volumeRatio5)
    && input.volumeRatio5 <= 0.8
  return finalizeCandidate(
    conditions,
    rankScore,
    focus,
    {
      focus: '冰点、题材退潮、受控回撤、真实净流入和收盘缩量形成双重确认，可重点跟踪反弹验证。',
      watch: '套利低吸硬条件已经满足，但资金与缩量只形成单一确认，保持选择性观察。',
      insufficient: '市场、题材、收盘量或资金流证据不完整，不能把跌停或大跌直接当作套利机会。',
      rejected: '至少一项套利低吸硬条件未通过，不进入本模式候选。',
    },
    ['下一交易日不继续放量下杀，且题材出现止跌或相对强度改善'],
    ['个股收盘跌幅扩大到5%以下、触及跌停，或题材退潮继续加速时失效'],
  )
}

export function judgeRotationDip(input: RotationDipJudgmentInput): DipCandidateJudgment {
  const leaderHeight = finite(input.leaderPreviousBoards) ? input.leaderPreviousBoards >= 5 : null
  const leaderOpened = input.leaderIsLimitUp != null && finite(input.leaderPctChg)
    ? !input.leaderIsLimitUp && input.leaderPctChg > 0
    : null
  const lowPosition = finite(input.candidateRecentPeakBoards) ? input.candidateRecentPeakBoards <= 2 : null
  const lagging = finite(input.candidatePctChg) && finite(input.leaderPctChg) && input.leaderPctChg > 0
    ? input.candidatePctChg >= -3 && input.candidatePctChg < input.leaderPctChg / 2
    : null
  const conditions: DipCondition[] = [
    conditionResult(
      'leaderHeight', '前一日高标', leaderHeight,
      finite(input.leaderPreviousBoards) ? `${input.leaderPreviousBoards}板` : '待补',
      '前一交易日存在五板及以上真实高标',
      '关联龙头前一交易日未达到五板',
      '前一交易日龙头高度缺失',
    ),
    conditionResult(
      'leaderOpened', '龙头打开高度', leaderOpened,
      input.leaderIsLimitUp == null || !finite(input.leaderPctChg)
        ? '待补'
        : `${input.leaderIsLimitUp ? '仍涨停' : '已打开'} · ${pct(input.leaderPctChg)}`,
      '高位龙头已打开涨停但仍保持红盘',
      '高位龙头仍封涨停或已经跌入绿盘，不满足轮动前提',
      '龙头当前涨停状态或涨跌幅缺失',
    ),
    conditionResult(
      'sameTheme', '同题材关系', input.sameTheme,
      input.themeName ?? '待补',
      '候选与高位龙头具有本地题材成员关系',
      '候选与高位龙头没有同题材关系',
      '题材成员映射缺失',
    ),
    conditionResult(
      'lowPosition', '低位属性', lowPosition,
      finite(input.candidateRecentPeakBoards) ? `近30日最高${input.candidateRecentPeakBoards}板` : '待补',
      '候选近30个交易日最高不超过二板',
      '候选自身已经处于三板及以上高位',
      '候选近期连板位置缺失',
    ),
    conditionResult(
      'laggingRange', '涨幅差', lagging,
      finite(input.candidatePctChg) && finite(input.leaderPctChg)
        ? `候选${pct(input.candidatePctChg)} / 龙头${pct(input.leaderPctChg)}`
        : '待补',
      '候选涨幅低于龙头一半且跌幅没有超过3%',
      '候选已经追高、跌幅过大或龙头不在红盘',
      '候选或龙头当日涨跌幅缺失',
    ),
    conditionResult(
      'themeBreadth', '题材支撑', input.themeName != null && finite(input.themeLimitUpCount)
        ? input.themeLimitUpCount > 0
        : null,
      input.themeName != null && finite(input.themeLimitUpCount)
        ? `${input.themeName} · ${input.themeLimitUpCount}只涨停`
        : input.themeName ?? '待补',
      '同题材仍有涨停广度，轮动并非孤立关系',
      '同题材当前没有其他涨停支撑',
      '题材或涨停广度缺失',
      false,
    ),
  ]
  const hardPassed = leaderHeight && leaderOpened && input.sameTheme === true && lowPosition && lagging
  const rankScore = hardPassed
    ? clamp(
      70
      + Math.min(12, Math.max(0, (input.leaderPreviousBoards ?? 5) - 5) * 6)
      + Math.min(10, Math.max(0, input.themeLimitUpCount ?? 0) * 4)
      + (finite(input.candidatePctChg) && input.candidatePctChg >= -1 ? 8 : 0),
    )
    : null
  const focus = rankScore != null
    && (input.leaderPreviousBoards ?? 0) >= 6
    && (input.themeLimitUpCount ?? 0) >= 1
    && (input.candidatePctChg ?? -99) >= -1
  return finalizeCandidate(
    conditions,
    rankScore,
    focus,
    {
      focus: '高位龙头打开高度、候选低位滞涨且题材仍有广度，可重点跟踪是否出现真实补涨。',
      watch: '轮动低吸硬条件已经满足，但龙头高度、题材广度或候选相对强度有限。',
      insufficient: '龙头当日状态、候选行情或题材关系不完整，暂不能确认轮动条件。',
      rejected: '至少一项轮动低吸硬条件未通过，不进入本模式候选。',
    },
    ['候选相对强度改善，同时高位龙头保持红盘且题材广度不继续收缩'],
    ['高位龙头跌入绿盘、候选跌幅超过3%，或题材涨停广度归零时失效'],
  )
}

function modeName(mode: DipMode): string {
  if (mode === 'trendDip') return '趋势低吸'
  if (mode === 'arbitrageDip') return '套利低吸'
  return '轮动低吸'
}

export function buildDipModeJudgment(input: BuildDipModeJudgmentInput): DipModeJudgment {
  const focusCount = input.judgments.filter((item) => item.tier === 'focus').length
  const watchCount = input.judgments.filter((item) => item.tier === 'watch').length
  const insufficientCount = input.judgments.filter((item) => item.tier === 'insufficient').length
  const rejectedCount = input.judgments.filter((item) => item.tier === 'rejected').length
  const gateFailed = input.gates.some((item) => item.required && item.status === 'failed')
  const gateUnknown = input.gates.some((item) => item.required && item.status === 'unknown')
  const status: DipModeStatus = gateFailed
    ? 'blocked'
    : focusCount > 0
      ? 'available'
      : watchCount > 0
        ? 'watch'
        : gateUnknown || insufficientCount > 0
          ? 'insufficient'
          : 'empty'
  const known = input.gates.filter((item) => item.status !== 'unknown').length
    + input.judgments.reduce((sum, item) => sum + item.conditions.filter((condition) => condition.status !== 'unknown').length, 0)
  const total = input.gates.length
    + input.judgments.reduce((sum, item) => sum + item.conditions.length, 0)
  const completeness = total === 0 ? 0 : Math.round(known / total * 100)
  const dataStatus: DipDataStatus = gateUnknown || insufficientCount > 0
    ? 'insufficient'
    : completeness === 100
      ? 'complete'
      : 'partial'
  const name = modeName(input.mode)
  const title = status === 'available' ? `${name}出现重点候选`
    : status === 'watch' ? `${name}仅有选择性观察`
      : status === 'blocked' ? `${name}前置环境未成立`
        : status === 'empty' ? `${name}当前没有合格候选`
          : `${name}证据不足`
  const summary = status === 'available'
    ? `${focusCount}只重点观察、${watchCount}只选择性观察；所有入选股票均通过本模式独立硬条件。`
    : status === 'watch'
      ? `${watchCount}只股票通过硬条件，但增强证据有限，不与其他低吸模式混合排序。`
      : status === 'blocked'
        ? `市场或事件前置条件没有成立，本模式不输出伪候选；已筛除${rejectedCount}只。`
        : status === 'empty'
          ? `前置环境已成立，但${input.screenedCount}只来源股票中没有通过全部硬条件的候选。`
          : '关键行情、题材、资金或事件证据缺失，未知字段没有按零值处理。'
  const missingFields = unique([
    ...input.gates.filter((item) => item.status === 'unknown').map((item) => item.label),
    ...input.judgments.flatMap((item) => item.missingFields),
  ])
  return {
    mode: input.mode,
    status,
    title,
    summary,
    screenedCount: input.screenedCount,
    focusCount,
    watchCount,
    insufficientCount,
    rejectedCount,
    completeness,
    dataStatus,
    gates: input.gates,
    missingFields,
    strategyKey: DIP_BUY_STRATEGY_KEYS[input.mode],
    strategyVersion: DIP_BUY_STRATEGY_VERSION,
  }
}

export const dipGate = { passed, failed, unknown }
