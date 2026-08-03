import { sha256 } from '../../utils/hashUtils'
import type { DataQualitySnapshot, DataTrustStatus } from '../dataQualityService'
import type {
  BacktestCredibilityAssessment,
  BacktestCredibilityGate,
  BacktestCredibilityPeriodSlice,
  BacktestTrustReason,
  BacktestTrustStatus,
} from './types'

const RELEVANT_DATASETS = ['dailyMarket', 'tradeCalendar', 'benchmarks'] as const

export type CredibilityEntryBasis = 'auction_925' | 'next_trade_open' | 'nextOpen' | 'signalClose'

export interface CredibilityObservation {
  signalDate: string
  entryDate: string | null
  exitDate: string | null
  returnPct: number | null
  valid: boolean
  entryBasis: CredibilityEntryBasis
}

export interface AssessBacktestCredibilityInput {
  dataQuality: DataQualitySnapshot
  observations: CredibilityObservation[]
  strategyCount: number
  executionProfile: 'historical' | 'effectiveness'
  assessedAt?: number
}

export interface AssessedBacktestCredibility {
  status: BacktestTrustStatus
  reasons: BacktestTrustReason[]
  assessment: BacktestCredibilityAssessment
}

function rankStatus(statuses: DataTrustStatus[]): DataTrustStatus {
  if (statuses.includes('blocked')) return 'blocked'
  if (statuses.includes('degraded')) return 'degraded'
  return 'reliable'
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function average(values: number[]): number | null {
  return values.length > 0 ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null
}

function buildPeriodSlice(
  label: BacktestCredibilityPeriodSlice['label'],
  observations: CredibilityObservation[],
): BacktestCredibilityPeriodSlice {
  const values = observations.map(item => item.returnPct).filter((value): value is number => value != null && Number.isFinite(value))
  return {
    label,
    sampleCount: values.length,
    avgReturn: average(values),
    winRate: values.length > 0 ? round(values.filter(value => value > 0).length / values.length) : null,
  }
}

function periodSlices(observations: CredibilityObservation[]): BacktestCredibilityPeriodSlice[] {
  const valid = observations
    .filter(item => item.valid && item.returnPct != null && Number.isFinite(item.returnPct))
    .sort((left, right) => left.signalDate.localeCompare(right.signalDate))
  const dates = [...new Set(valid.map(item => item.signalDate))]
  if (dates.length === 0) return [buildPeriodSlice('前半区间', []), buildPeriodSlice('后半区间', [])]
  const splitIndex = Math.ceil(dates.length / 2)
  const firstDates = new Set(dates.slice(0, splitIndex))
  return [
    buildPeriodSlice('前半区间', valid.filter(item => firstDates.has(item.signalDate))),
    buildPeriodSlice('后半区间', valid.filter(item => !firstDates.has(item.signalDate))),
  ]
}

function projectDataQuality(snapshot: DataQualitySnapshot): {
  status: DataTrustStatus
  fingerprint: string
  gate: BacktestCredibilityGate
} {
  const datasets = RELEVANT_DATASETS.map(key => snapshot.datasets.find(item => item.key === key)).filter((item): item is DataQualitySnapshot['datasets'][number] => item != null)
  const missingCount = RELEVANT_DATASETS.length - datasets.length
  const status = missingCount > 0 ? 'blocked' : rankStatus(datasets.map(item => item.status))
  const normalized = RELEVANT_DATASETS.map(key => {
    const dataset = datasets.find(item => item.key === key)
    return dataset ? {
      key,
      status: dataset.status,
      recordCount: dataset.recordCount,
      earliestDate: dataset.earliestDate,
      latestDate: dataset.latestDate,
      reasons: dataset.reasons.map(reason => reason.code).sort(),
    } : { key, status: 'blocked', missing: true }
  })
  const fingerprint = sha256(JSON.stringify(normalized))
  const labels: Record<(typeof RELEVANT_DATASETS)[number], string> = {
    dailyMarket: '日线与复权',
    tradeCalendar: '交易日历',
    benchmarks: '核心基准',
  }
  const details = normalized.map(item => `${labels[item.key]}：${item.status === 'reliable' ? '可用' : item.status === 'degraded' ? '需注意' : '阻断'}`)
  const summary = status === 'reliable'
    ? '日线、交易日历和核心基准均满足当前质量门槛'
    : status === 'degraded'
      ? '底座可计算，但部分行情或基准仍有质量提醒'
      : '关键行情或交易日历被数据质量中心标记为阻断'
  return {
    status,
    fingerprint,
    gate: { key: 'dataFoundation', title: '数据底座', status, summary, details },
  }
}

function temporalGate(observations: CredibilityObservation[]): { gate: BacktestCredibilityGate; violationCount: number; sameDayClose: boolean } {
  const valid = observations.filter(item => item.valid)
  let violationCount = 0
  let sameDayClose = false
  for (const item of valid) {
    const expectsNextDay = item.entryBasis === 'nextOpen' || item.entryBasis === 'next_trade_open'
    const expectsSameDay = item.entryBasis === 'signalClose' || item.entryBasis === 'auction_925'
    if (!item.entryDate || (expectsNextDay && item.entryDate <= item.signalDate) || (expectsSameDay && item.entryDate !== item.signalDate)) violationCount += 1
    if (item.entryDate && item.exitDate && item.exitDate < item.entryDate) violationCount += 1
    if (item.entryBasis === 'signalClose') sameDayClose = true
  }
  const status: DataTrustStatus = violationCount > 0 ? 'blocked' : sameDayClose ? 'degraded' : 'reliable'
  return {
    violationCount,
    sameDayClose,
    gate: {
      key: 'temporalIntegrity',
      title: '时间完整性',
      status,
      summary: violationCount > 0
        ? `发现 ${violationCount} 项入场或出场时间顺序异常`
        : sameDayClose
          ? '日期顺序成立，但同日收盘入场属于乐观假设'
          : '有效样本均遵守信号、入场和出场先后顺序',
      details: [
        `已检查 ${valid.length} 个有效样本`,
        sameDayClose ? '包含同日收盘入场' : '未使用同日收盘入场',
      ],
    },
  }
}

function sampleGate(observations: CredibilityObservation[]): {
  gate: BacktestCredibilityGate
  totalSignals: number
  validSignals: number
  signalDayCount: number
  missingRate: number | null
} {
  const totalSignals = observations.length
  const valid = observations.filter(item => item.valid && item.returnPct != null && Number.isFinite(item.returnPct))
  const validSignals = valid.length
  const signalDayCount = new Set(valid.map(item => item.signalDate)).size
  const missingRate = totalSignals > 0 ? round((totalSignals - validSignals) / totalSignals) : null
  const blocked = totalSignals === 0 || validSignals === 0
  const degraded = validSignals < 30 || signalDayCount < 10 || (missingRate != null && missingRate > 0.2)
  const status: DataTrustStatus = blocked ? 'blocked' : degraded ? 'degraded' : 'reliable'
  const issues = [
    validSignals < 30 ? `有效样本 ${validSignals}/30` : null,
    signalDayCount < 10 ? `有效信号日 ${signalDayCount}/10` : null,
    missingRate != null && missingRate > 0.2 ? `缺失或剔除率 ${(missingRate * 100).toFixed(1)}%` : null,
  ].filter((item): item is string => item != null)
  return {
    totalSignals,
    validSignals,
    signalDayCount,
    missingRate,
    gate: {
      key: 'sampleAdequacy',
      title: '样本充分性',
      status,
      summary: blocked ? '当前没有可形成统计的有效样本' : status === 'reliable' ? `${validSignals} 笔样本分布在 ${signalDayCount} 个信号日` : issues.join('；'),
      details: [
        `总信号 ${totalSignals} 笔，有效 ${validSignals} 笔`,
        missingRate == null ? '缺失率不可统计' : `缺失或剔除率 ${(missingRate * 100).toFixed(1)}%`,
      ],
    },
  }
}

function stabilityGate(slices: BacktestCredibilityPeriodSlice[]): { gate: BacktestCredibilityGate; directionUnstable: boolean } {
  const [first, second] = slices
  const directionUnstable = first.avgReturn != null && second.avgReturn != null && first.avgReturn * second.avgReturn < 0
  const status: DataTrustStatus = first.sampleCount === 0 && second.sampleCount === 0 ? 'blocked' : 'degraded'
  return {
    directionUnstable,
    gate: {
      key: 'stabilityValidation',
      title: '稳健性验证',
      status,
      summary: status === 'blocked'
        ? '没有可用于区间稳定性检查的样本'
        : directionUnstable
          ? '前后半区间平均收益方向相反，结论对时期敏感'
          : '已展示前后半区间，但尚未完成滚动和样本外验证',
      details: slices.map(slice => `${slice.label}：${slice.sampleCount} 笔，平均收益 ${slice.avgReturn == null ? '不可统计' : `${slice.avgReturn.toFixed(2)}%`}`),
    },
  }
}

function executionGate(profile: AssessBacktestCredibilityInput['executionProfile']): BacktestCredibilityGate {
  return {
    key: 'executionRealism',
    title: '成交可执行性',
    status: 'degraded',
    summary: profile === 'historical'
      ? '已计入费用和持有期，尚未逐笔模拟涨跌停、停牌与流动性'
      : '已使用既定入场价并排除一字板，尚未模拟流动性和滑点路径',
    details: profile === 'historical'
      ? ['已检查有效正价格和持有期', '未模拟盘口容量、停牌原因和逐笔成交可得性']
      : ['竞价路径使用9:25撮合价，实验室路径使用下一交易日开盘价', '未模拟盘口容量、冲击成本和逐笔成交可得性'],
  }
}

export function assessBacktestCredibility(input: AssessBacktestCredibilityInput): AssessedBacktestCredibility {
  const data = projectDataQuality(input.dataQuality)
  const temporal = temporalGate(input.observations)
  const sample = sampleGate(input.observations)
  const slices = periodSlices(input.observations)
  const stability = stabilityGate(slices)
  const gates = [data.gate, temporal.gate, executionGate(input.executionProfile), sample.gate, stability.gate]
  const unavailable = data.status === 'blocked' || temporal.gate.status === 'blocked' || sample.gate.status === 'blocked'
  const conclusion = unavailable
    ? 'unavailable'
    : data.status === 'reliable' && temporal.gate.status === 'reliable' && sample.gate.status === 'reliable' && input.strategyCount >= 2
      ? 'comparable'
      : 'exploratory'
  const status: BacktestTrustStatus = unavailable ? 'blocked' : gates.some(gate => gate.status === 'degraded') ? 'degraded' : 'reliable'
  const summary = conclusion === 'unavailable'
    ? '当前结果暂不可用于策略判断，请先处理阻断项'
    : conclusion === 'comparable'
      ? '可用于相同观察口径下的策略比较，不代表收益可以真实实现'
      : '当前结果仅适合作为探索线索，不能形成稳定策略结论'
  const reasons: BacktestTrustReason[] = []
  if (data.status === 'blocked') reasons.push('DATA_QUALITY_BLOCKED')
  else if (data.status === 'degraded') reasons.push('DATA_QUALITY_DEGRADED')
  if (temporal.violationCount > 0) reasons.push('TEMPORAL_ORDER_VIOLATION')
  if (temporal.sameDayClose) reasons.push('SAME_DAY_CLOSE_ENTRY')
  if (sample.validSignals > 0 && sample.validSignals < 30) reasons.push('SAMPLE_SIZE_LOW')
  if (sample.validSignals > 0 && sample.signalDayCount < 10) reasons.push('SIGNAL_DATE_CONCENTRATED')
  if (sample.missingRate != null && sample.missingRate > 0.2) reasons.push('DROP_RATE_HIGH')
  if (stability.directionUnstable) reasons.push('PERIOD_DIRECTION_UNSTABLE')
  reasons.push('LIMIT_RULES_NOT_ENFORCED')
  if (input.executionProfile === 'historical') {
    reasons.push('UNADJUSTED_PRICES', 'TRADING_CALENDAR_NOT_ENFORCED', 'REALIZED_EQUITY_ONLY', 'OVERLAPPING_POSITIONS_NOT_CAPITAL_ALLOCATED', 'SHARPE_NOT_ANNUALIZED')
  }
  reasons.push('OUT_OF_SAMPLE_NOT_VALIDATED')
  return {
    status,
    reasons: [...new Set(reasons)],
    assessment: {
      version: 1,
      assessedAt: input.assessedAt ?? Date.now(),
      conclusion,
      summary,
      dataQualityFingerprint: data.fingerprint,
      gates,
      sample: {
        totalSignals: sample.totalSignals,
        validSignals: sample.validSignals,
        signalDayCount: sample.signalDayCount,
        missingRate: sample.missingRate,
      },
      periodSlices: slices,
    },
  }
}
