import type { ChipConclusionData } from '../../utils/chipColors'

export type TrendState = 'strengthening' | 'strong' | 'stable' | 'weakening' | 'broken' | 'insufficient'
export type PositionAdvice = 'HOLD' | 'WATCH' | 'TAKE_PROFIT' | 'STOP_LOSS'

export interface TrendBenchmarkHealth {
  tsCode: '000300.SH'
  state: 'current' | 'stale' | 'missing' | 'insufficient' | 'calendar-unknown'
  latestTradeDate: string | null
  expectedTradeDate: string | null
  bars: number
  requiredBars: 21
  calendarSource: 'trade-calendar' | 'weekday-fallback'
  refreshOutcome: 'not-requested' | 'not-needed' | 'updated' | 'unchanged' | 'failed' | 'deduplicated'
  attempted: boolean
  rowsWritten: number
  errorCode: 'HTTP_ERROR' | 'UPSTREAM_ERROR' | 'EMPTY_RESPONSE' | 'NETWORK_ERROR' | 'EXPECTED_DATE_MISSING' | 'INSUFFICIENT_HISTORY' | 'CALENDAR_UNAVAILABLE' | null
  message: string
}

export interface TrendWorkbenchItem {
  tsCode: string
  stockCode: string
  stockName: string
  categories: string[]
  subCategories: string[]
  groupTags: string[]
  notes: string[]
  isPortfolio: boolean
  costPrice: number | null
  profitPct: number | null
  positionAdvice: PositionAdvice | null
  positionAdviceReason: string | null
  chip: (ChipConclusionData & { tradeDate: string; bottomAvgCost: number | null }) | null
  totalScore: number | null
  maScore: number | null
  maAbove60: boolean | null
  alphaScore: number | null
  drawdown: number | null
  turnoverRatio: number | null
  macdAboveZero: boolean | null
  bollAboveMid: boolean | null
  price: number | null
  change: number | null
  dataSource: 'realtime' | 'eod'
  dataTime: string
  scoreSource: 'realtime' | 'eod'
  scoreDate: string
  quoteSource: 'realtime' | 'eod'
  quoteTime: string
  scoreVersion: 'v2' | 'legacy'
  validWeight: number | null
  scoreDelta5d: number | null
  scoreDelta20d: number | null
  trendState: TrendState
  scoreHistory: Array<{ tradeDate: string; totalScore: number }>
  dataCoverage: {
    bars: number
    requiredBars: number
    latestTradeDate: string | null
    state: 'ready' | 'partial' | 'missing'
  }
  dimensions: {
    maArrangement: number | null
    maAbove60: number | null
    relativeStrength: number | null
    drawdownQuality: number | null
    turnoverQuality: number | null
    macd: number | null
    boll: number | null
  } | null
  facts: {
    stockReturn20d: number | null
    benchmarkReturn20d: number | null
    excessReturn20d: number | null
    maxDrawdown20d: number | null
    turnoverRatio: number | null
  } | null
  benchmarkHealth?: TrendBenchmarkHealth
}

export interface TrendWorkbenchEvent {
  id: number | undefined
  tsCode: string
  stockCode: string
  stockName: string
  alertType: string
  kind: 'risk' | 'opportunity'
  alertDate: string
  triggerPrice: number | null
  referencePrice: number | null
  currentPrice: number | null
  changeSinceTrigger: number | null
  createdAt: number
  isPortfolio: boolean
  currentState: 'active' | 'recovered' | 'unknown'
}

export interface TrendWorkbenchSnapshot {
  generatedAt: number
  items: TrendWorkbenchItem[]
  events: TrendWorkbenchEvent[]
  dataHealth: {
    total: number
    ready: number
    partial: number
    missing: number
    latestTradeDate: string | null
    benchmark?: TrendBenchmarkHealth
  }
}

export interface TrendWorkbenchPageProps {
  snapshot: TrendWorkbenchSnapshot | null
  loading: boolean
  errorMessage: string
  onRefresh: () => void
}
