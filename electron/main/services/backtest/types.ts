/**
 * 策略级回测引擎 - 共享类型（P1）
 *
 * 策略回测引擎的共享类型定义。
 *
 * 核心抽象：
 *  - BacktestSignal：归一化后的信号（决策日 + 标的 + 强度 + 原始 meta）
 *  - TradePlan：统一交易假设（入场规则 / 持有期 / 止盈止损 / 费用）
 *  - TradeResult：单笔撮合结果（含数据不足/停牌剔除标记）
 *  - StrategyBacktestReport：组合统计（胜率/盈亏比/期望/回撤等）
 */

/** 归一化信号——不同信号源（short_term_signals / trend_alerts / decision_signals）经适配器统一为此结构 */
export interface BacktestSignal {
  /** 策略键，如 'shortTerm.limitBoardMonitor'，用于分组与展示 */
  strategyKey: string
  /** 标的代码，与 daily_close_cache.ts_code 同格式（带后缀，如 000001.SZ） */
  tsCode: string
  /** 信号产生日 = 决策日 T（YYYYMMDD）。入场最早 T+1，严禁用 T 之后的数据回填 T 日决策。 */
  tradeDate: string
  /** 信号强度/评分，用于 P3 分层统计；缺失为 null */
  strength: number | null
  /** 原始 signal_meta（解析后），供入场价等扩展使用 */
  meta?: Record<string, unknown>
}

export type BacktestSignalSource = 'shortTerm' | 'trendAlerts' | 'decisionSignals'

export const STRATEGY_BACKTEST_REPORT_SCHEMA_VERSION = 4 as const
export const STRATEGY_BACKTEST_ENGINE_VERSION = '4.0.0'

export type BacktestEquityModel = 'equal_weighted_exit_day_compound'
export const STRATEGY_BACKTEST_EQUITY_MODEL: BacktestEquityModel = 'equal_weighted_exit_day_compound'

export type BacktestTrustStatus = 'reliable' | 'degraded' | 'blocked'

export type BacktestTrustReason =
  | 'NO_SIGNALS'
  | 'NO_VALID_TRADES'
  | 'UNADJUSTED_PRICES'
  | 'TRADING_CALENDAR_NOT_ENFORCED'
  | 'LIMIT_RULES_NOT_ENFORCED'
  | 'APPROXIMATE_DRAWDOWN'
  | 'REALIZED_EQUITY_ONLY'
  | 'OVERLAPPING_POSITIONS_NOT_CAPITAL_ALLOCATED'
  | 'SHARPE_NOT_ANNUALIZED'
  | 'DATA_QUALITY_DEGRADED'
  | 'DATA_QUALITY_BLOCKED'
  | 'TEMPORAL_ORDER_VIOLATION'
  | 'SAME_DAY_CLOSE_ENTRY'
  | 'SAMPLE_SIZE_LOW'
  | 'SIGNAL_DATE_CONCENTRATED'
  | 'DROP_RATE_HIGH'
  | 'PERIOD_DIRECTION_UNSTABLE'
  | 'OUT_OF_SAMPLE_NOT_VALIDATED'
  | 'LEGACY_REPORT'

export type BacktestCredibilityStatus = 'reliable' | 'degraded' | 'blocked'
export type BacktestCredibilityConclusion = 'unavailable' | 'exploratory' | 'comparable'
export type BacktestCredibilityGateKey = 'dataFoundation' | 'temporalIntegrity' | 'executionRealism' | 'sampleAdequacy' | 'stabilityValidation'

export interface BacktestCredibilityGate {
  key: BacktestCredibilityGateKey
  title: string
  status: BacktestCredibilityStatus
  summary: string
  details: string[]
}

export interface BacktestCredibilityPeriodSlice {
  label: '前半区间' | '后半区间'
  sampleCount: number
  avgReturn: number | null
  winRate: number | null
}

export interface BacktestCredibilityAssessment {
  version: 1
  assessedAt: number
  conclusion: BacktestCredibilityConclusion
  summary: string
  dataQualityFingerprint: string
  gates: BacktestCredibilityGate[]
  sample: {
    totalSignals: number
    validSignals: number
    signalDayCount: number
    missingRate: number | null
  }
  periodSlices: BacktestCredibilityPeriodSlice[]
}

export interface BacktestTrust {
  status: BacktestTrustStatus
  reasons: BacktestTrustReason[]
  engineVersion: string
  factFingerprint: string
  credibility?: BacktestCredibilityAssessment
}

export type StrategyBacktestProgressStage = 'cache' | 'signals' | 'prices' | 'trades' | 'benchmark' | 'save' | 'done' | 'failed'

export interface StrategyBacktestProgress {
  stage: StrategyBacktestProgressStage
  current: number
  total: number
  message: string
}

/** 单根日线 OHLC（来自 daily_close_cache，按 tradeDate 升序传入撮合器） */
export interface OHLC {
  tradeDate: string
  open: number | null
  high: number | null
  low: number | null
  close: number
}

/** 统一交易假设模型 */
export interface TradePlan {
  /**
   * 入场规则：
   *  - 'nextOpen'：T+1 开盘价入场（最贴近真实，默认）
   *  - 'signalClose'：T 日收盘价入场（乐观，仅用于理论上限对比）
   */
  entryRule: 'nextOpen' | 'signalClose'
  /** 持有 N 个该股票的交易日（停牌日不计入，由逐行推进自动跳过） */
  holdDays: number
  /** 止盈百分比（如 8 表示 +8%）；null/缺省表示不设 */
  stopProfit?: number | null
  /** 止盈百分比别名；P2 表单使用该字段时与 stopProfit 等价 */
  takeProfitPct?: number | null
  /** 止损百分比（如 5 表示 -5%）；null/缺省表示不设 */
  stopLoss?: number | null
  /** 止损百分比别名；P2 表单使用该字段时与 stopLoss 等价 */
  stopLossPct?: number | null
  /** 单边费用，基点（bps）。默认约 13bps：佣金+印花税+滑点的粗略合计 */
  feeBps: number
}

export type ExitReason = 'hold_expired' | 'stop_profit' | 'stop_loss' | 'data_insufficient'
export type TradeStatus = 'executed' | 'data_insufficient'

/** 单笔撮合结果 */
export interface TradeResult {
  signal: BacktestSignal
  entryDate: string | null
  entryPrice: number | null
  exitDate: string | null
  exitPrice: number | null
  /** 已扣双边费用的收益率，单位 %（如 3.2 表示 +3.2%）；数据不足为 null */
  returnPct: number | null
  /** 未扣费用的毛收益率，单位 %；数据不足为 null */
  grossReturnPct: number | null
  /** 已扣费用的净收益率，单位 %；与 returnPct 保持一致 */
  netReturnPct: number | null
  exitReason: ExitReason
  status: TradeStatus
  /** 数据不足/停牌时为 false，不计入组合统计 */
  valid: boolean
}

/** 组合回测报告 */
export interface StrengthDecileReport {
  bucket: number
  minStrength: number
  maxStrength: number
  count: number
  winRate: number | null
  avgReturn: number | null
  medianReturn: number | null
  profitFactor: number | null
  expectancy: number | null
}

export interface BacktestEquityPoint {
  date: string
  realizedReturnPct: number
  tradeCount: number
  equity: number
  drawdownPct: number
}

export interface StrategyBacktestReport {
  schemaVersion: 1 | 2 | 3 | typeof STRATEGY_BACKTEST_REPORT_SCHEMA_VERSION
  generatedAt: number
  trust: BacktestTrust
  strategyKey: string
  signalSource?: BacktestSignalSource
  dateRange: { start: string; end: string }
  plan: TradePlan
  /** 信号总数（含被剔除的） */
  totalSignals: number
  /** 有效成交笔数（数据充足、可完成持有期） */
  validTrades: number
  /** 剔除率 = (totalSignals - validTrades) / totalSignals；过高（>0.2）报告应警示幸存者偏差 */
  dropRate: number | null
  /** 胜率（returnPct > 0 占比，0~1） */
  winRate: number | null
  /** 平均单笔收益 % */
  avgReturn: number | null
  /** 收益中位数 % */
  medianReturn: number | null
  /** 盈亏比 = 总盈利 / 总亏损绝对值；无亏损时为 Infinity */
  profitFactor: number | null
  /** 期望 = winRate*avgWin + (1-winRate)*avgLoss（avgLoss 为负） */
  expectancy: number | null
  /** 实现净值模型：按出场日聚合，同日交易等权，跨实现日复合 */
  equityModel: BacktestEquityModel
  /** 复合累计实现收益 % */
  totalReturn: number | null
  /** 只在交易出场日确认收益的实现净值曲线 */
  equityCurve: BacktestEquityPoint[] | null
  /** 最大回撤 %（基于复合实现净值和历史权益峰值） */
  maxDrawdown: number | null
  /** 粗略风险调整：avgReturn / 收益标准差；标准差为 0 时为 0 */
  sharpeLike: number | null
  /** 按强度分层统计，用于验证评分是否有预测力 */
  byStrengthDecile: StrengthDecileReport[] | null
  /** 同期等权基准收益 */
  benchmarkReturn: number | null
  /** 策略平均收益 - 同期等权基准收益 */
  excessReturn?: number | null
  /** 基准无法计算或样本不足时的说明 */
  benchmarkNote?: string | null
}
