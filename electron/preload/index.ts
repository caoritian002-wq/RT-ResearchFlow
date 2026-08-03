import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  BriefingListOptions,
  AppSettingsRow,
  DecisionCenterFiltersPreference,
  ParseStrategy,
  ChipStructureDetail,
  ChipStructureSummary,
  StrategyLabMatchRow,
  StrategyLabRunRow,
} from '../main/database/types'
import type {
  SaveStrategyLabStrategyRequest,
  StrategyLabStrategyDetail,
  StrategyLabStrategySummary,
} from '../main/services/strategyLabService'
import type { BlockStrategyTemplate } from '../main/services/conditionBlocks/types'
import type {
  AiEvaluationCaseResultRecord,
  AiEvaluationRunRecord,
} from '../main/database/aiEvaluationRepository'
import type {
  AiEvaluationConfiguredTarget,
  AiEvaluationRunDetail,
} from '../main/services/aiEvaluationService'
import type {
  StockFundamentalReadResult,
  StockFundamentalRefreshResult,
} from '../main/services/stockFundamentalService'
import type {
  ResearchEvidenceCompareRequest,
  ResearchEvidenceCompareResponse,
  ResearchEvidenceStartDiscussionRequest,
  ResearchEvidenceStartDiscussionResponse,
} from '../main/ipc/researchEvidenceHandlers'
import type {
  ResearchAccessApiResult,
  ResearchAccessAuditRequest,
  ResearchAccessAuditView,
  ResearchAccessCreateRequest,
  ResearchAccessCredentialDelivery,
  ResearchAccessProfileOperationRequest,
  ResearchAccessUpdateRequest,
  ResearchAccessWorkbench,
} from '../main/ipc/researchAccessHandlers'
import type {
  ResearchAgentDetailResponse,
  ResearchAgentDeleteResponse,
  ResearchAgentListResponse,
  ResearchAgentMutationResponse,
  ResearchAgentMutationRequest,
  ResearchAgentDirectPreflightRequest,
  ResearchAgentPreflightResponse,
  ResearchAgentRetryRequest,
  ResearchAgentRetryResponse,
  ResearchAgentStartDirectRequest,
  ResearchAgentStartDirectResponse,
  ResearchAgentStartRequest,
  ResearchAgentStartReviewRequest,
  ResearchAgentStartReviewResponse,
  ResearchAgentStartResponse,
} from '../main/ipc/researchAgentHandlers'
import type { ResearchAgentRunnerProgress } from '../main/services/researchAgentRunner'
import type { PremarketCaptureStatusView } from '../main/services/premarketCaptureCoordinator'
import type { PremarketCaptureActionResponse } from '../main/ipc/premarketHandlers'
import type {
  PremarketExplainResponse,
  PremarketPreparationReadResponse,
  PremarketPreparationRefreshResponse,
  PremarketScenarioReadResponse,
  PremarketScenarioRetryProgress,
  PremarketScenarioRetryResponse,
} from '../main/services/premarketRehearsalTypes'

interface ChipStructureSyncStatus {
  taskId: string
  scope: 'structure' | 'institution' | 'all'
  stage: 'structure' | 'institution' | null
  state: 'idle' | 'running' | 'completed' | 'partial' | 'failed'
  done: number
  total: number
  success: number
  noRecord: number
  partial: number
  failed: number
  currentStock: string | null
  startedAt: number | null
  completedAt: number | null
  failureReasons: Array<{ code: string; count: number }>
}

interface AfterCloseScheduleStatus {
  scheduledTime: '18:00'
  active: boolean
  nextRunAt: number
  lastRun: {
    id: number
    tradeDate: string
    trigger: 'scheduled' | 'startup_catch_up'
    status: 'running' | 'completed' | 'partial' | 'failed' | 'blocked'
    startedAt: number
    completedAt: number | null
    updatedAt: number
    attemptCount: number
    tasks: Partial<Record<
      'short_term_daily' | 'market_daily' | 'chip_structure' | 'sector_snapshot' | 'trend_scores',
      {
        status: 'running' | 'completed' | 'partial' | 'failed' | 'blocked'
        startedAt: number
        completedAt: number | null
        message: string | null
      }
    >>
    errorSummary: string | null
  } | null
}

interface ChipStructureProgress {
  taskId: string
  scope: 'structure' | 'institution' | 'all'
  stage: 'structure' | 'institution' | null
  done: number
  total: number
  currentStock: string
  success: number
  noRecord: number
  partial: number
  failed: number
}

interface ChipStructureDone {
  taskId: string
  scope: 'structure' | 'institution' | 'all'
  stage: 'structure' | 'institution' | null
  state: 'completed' | 'partial' | 'failed'
  success: number
  noRecord: number
  partial: number
  failed: number
  failureReasons: Array<{ code: string; count: number }>
  completedAt: number
}

// FR-125: 晨间集合竞价快照内联类型（preload 层避免跨进程深 import）
interface MorningAuctionThemePeer {
  tsCode: string
  stockName: string
  auctionPctChg: number
  auctionAmount: number
}
interface MorningAuctionThemeEvidence {
  name: string
  score: number
  direct: boolean
  peerCount: number
  activePeerCount: number
  averageAuctionPct: number | null
  totalAuctionAmount: number
  peers: MorningAuctionThemePeer[]
  basis: string[]
}
interface MorningAuctionThemeAttribution {
  state: 'direct' | 'resonance' | 'unresolved'
  confidence: 'high' | 'medium' | 'low' | 'none'
  primary: MorningAuctionThemeEvidence | null
  resonance: MorningAuctionThemeEvidence[]
  staticThemes: string[]
  allThemes: string[]
  directReason: string | null
  sourceTradeDate: string | null
  summary: string
}
interface MorningAuctionMarketTheme {
  name: string
  aliases: string[]
  state: 'confirmed_continuation' | 'unconfirmed_continuation' | 'new_rotation' | 'isolated_risk' | 'auction_only' | 'insufficient'
  score: number
  confidence: number
  stockCodes: string[]
  stocks: Array<{
    tsCode: string
    stockName: string
    auctionPctChg: number
    auctionAmount: number
    role: 'primary' | 'resonance'
  }>
  auction: {
    candidateCount: number
    activeCandidateCount: number
    primaryCandidateCount: number
    directCandidateCount: number
    medianPctChg: number | null
    totalAuctionAmount: number
    leaderConcentration: number | null
    limitUpCount: number
  }
  flow: null | {
    tradeDate: string
    boardCode: string
    boardName: string
    mainNetInflow: number
    mainNetInflowRate: number | null
    weightedChange: number
    breadthRate: number | null
    matchKind: 'name' | 'member_overlap'
  }
  summary: string
  basis: string[]
  risks: string[]
}
interface MorningAuctionMarketThemeSummary {
  status: 'ready' | 'no_verified_flow' | 'no_auction_theme'
  flowTradeDate: string | null
  candidateStockCount: number
  attributedStockCount: number
  coverageRate: number | null
  summary: string
  themes: MorningAuctionMarketTheme[]
}
interface MorningAuctionStock {
  tsCode: string
  stockCode: string
  stockName: string
  auctionPrice: number
  prevClose: number
  pctChg: number
  auctionAmount: number
  auctionTurnover: number
  volumeRatio: number | null
  currentPrice: number | null
  currentPctChg: number | null
  currentAmount: number | null
  pctChg3d: number | null
  pctChg5d: number | null
  conceptNames: string[]
  themeAttribution?: MorningAuctionThemeAttribution | null
}
interface WeakToStrongStock extends MorningAuctionStock {
  prevDayMeta: string
  signalStrength: number
}
interface BoardCategoryStock extends MorningAuctionStock {
  limitTimes: number
  hotNum: number
}
interface MorningAuctionSnapshot {
  tradeDate: string
  generatedAt: number
  isMock: boolean
  threeOne: {
    firstBoard: MorningAuctionStock[]
    secondBoard: MorningAuctionStock[]
    brokenBoard: MorningAuctionStock[]
    brokenConsec: MorningAuctionStock[]
    allMarket: MorningAuctionStock[]
  }
  weakToStrong: {
    badBoard: WeakToStrongStock[]
    tailAttack: WeakToStrongStock[]
    brokenBoard: WeakToStrongStock[]
    afternoonReseal: WeakToStrongStock[]
    reversal: WeakToStrongStock[]
  }
  boardCategory: {
    first: BoardCategoryStock[]
    second: BoardCategoryStock[]
    third: BoardCategoryStock[]
    n: BoardCategoryStock[]
  }
  marketThemes?: MorningAuctionMarketThemeSummary
}

type MorningAuctionVerificationStatus = 'pending' | 'checked' | 'blocked' | 'not_applicable'
interface MorningAuctionInsight {
  tradeDate: string
  tsCode: string
  stockName: string
  poolKey: string
  schemaVersion: number
  score: number
  scoreBreakdown: Array<{
    key: string; label: string; value: number | null; weight: number; contribution: number; reason: string
  }>
  entryReasons: string[]
  verificationItems: Array<{
    key: string; label: string; status: MorningAuctionVerificationStatus; source: string
    reason: string; updatedAt: number; checkedByUser?: boolean
    themeAttribution?: MorningAuctionThemeAttribution
  }>
  riskFlags: Array<{
    key: string; label: string; severity: 'low' | 'medium' | 'high'; reason: string
  }>
  intradayPreview: {
    latestTime: string | null; maxPctChg: number | null; maxDrawdownFromOpen: number | null
    amountChangePct: number | null; touchedLimitUp: boolean | null; priceVsAuctionPct: number | null
  } | null
  backtestSummary: {
    sampleSize: number; winRate: number | null; avgReturn: number | null; maxDrawdown: null
  } | null
  chipEvidence: ChipStructureSummary | null
  themeAttribution: MorningAuctionThemeAttribution | null
  chipStatus: 'available' | 'missing' | 'insufficient'
  status: 'completed' | 'partial' | 'failed'
  errorMessage: string | null
  generatedAt: number
  updatedAt: number
}
interface MorningAuctionInsightStatusSummary {
  tradeDate: string
  generatedAt: number | null
  completedCount: number
  missingCount: number
  blockedVerificationCount: number
}
interface MorningAuctionTradeDateStatus {
  isTradeDay: boolean
  previousTradeDate: string | null
  nextTradeDate: string | null
  recommendedTradeDate: string | null
}

// FR-250: 尾盘行为与次日风险研判快照内联类型
type ClosingHalfHourDataMode = 'realtime' | 'eod' | 'history'
type ClosingHalfHourTier = 'active' | 'confirm' | 'retreat' | 'insufficient'
type ClosingHalfHourDataStatus = 'complete' | 'partial' | 'insufficient'
type ClosingHalfHourStance = 'active' | 'selective' | 'defensive' | 'insufficient'
type ClosingHalfHourDimensionStatus = 'strong' | 'neutral' | 'weak' | 'unknown'
type ClosingHalfHourLegacyForm =
  | 'spikeBreakOpen'
  | 'dipReboundNotBreakOpen'
  | 'mildPullAboveBaseline'
  | 'riseFallHoldBaseline'
  | 'flatNoMove'
  | 'lastTenSharpDrop'
interface ClosingHalfHourMetrics {
  baseline1430: number | null
  latestPrice: number | null
  latestTime: string | null
  tailReturnPct: number | null
  tailHighPct: number | null
  tailLowPct: number | null
  lateReturnPct: number | null
  closePositionPct: number | null
  maxDrawdownPct: number | null
  pathEfficiencyPct: number | null
  tailVolumeSharePct: number | null
  tailVolumePace: number | null
  pointCount: number
}
interface ClosingHalfHourDimension {
  key: 'direction' | 'closePosition' | 'participation' | 'stability' | 'keyLevel'
  label: string
  score: number | null
  maxScore: number
  status: ClosingHalfHourDimensionStatus
  value: string
  detail: string
}
interface ClosingHalfHourStockJudgment {
  tier: ClosingHalfHourTier
  title: string
  summary: string
  totalScore: number | null
  confidence: number
  completeness: number
  dataStatus: ClosingHalfHourDataStatus
  missingFields: string[]
  metrics: ClosingHalfHourMetrics
  dimensions: ClosingHalfHourDimension[]
  evidence: string[]
  risks: string[]
  confirmations: string[]
  invalidations: string[]
  legacyForms: ClosingHalfHourLegacyForm[]
}
interface ClosingHalfHourStock {
  tsCode: string
  stockCode: string
  stockName: string
  open: number | null
  previousClose: number | null
  closeFinal: number | null
  pctChg: number | null
  amountYuan: number | null
  judgment: ClosingHalfHourStockJudgment
}
interface ClosingHalfHourWorkbenchJudgment {
  stance: ClosingHalfHourStance
  title: string
  summary: string
  activeCount: number
  confirmCount: number
  retreatCount: number
  insufficientCount: number
  analyzedCount: number
  completeness: number
  dataStatus: ClosingHalfHourDataStatus
  missingFields: string[]
  strategyVersion: string
}
interface ClosingHalfHourSnapshot {
  requestedTradeDate: string
  tradeDate: string
  generatedAt: number
  dataMode: ClosingHalfHourDataMode
  candidateSource: 'realtimeActive' | 'localMinuteCache' | 'eodLimitList' | 'savedSignal'
  windowStatus: 'waiting' | 'live' | 'closed' | 'historical'
  latestMinute: string | null
  candidateCount: number
  stocks: ClosingHalfHourStock[]
  judgment: ClosingHalfHourWorkbenchJudgment
  strategyVersion: string
}

// FR-127: 打板助手实时涨停监控快照内联类型
type LimitTimeWindow = 'before1030' | 'between1030_1130' | 'after1300' | 'unknown'
type LimitBoardQualityTier = 'focus' | 'watch' | 'fragile'
type LimitBoardDataStatus = 'complete' | 'partial' | 'insufficient'
interface LimitBoardQualityDimension {
  key: 'time' | 'stability' | 'seal' | 'theme' | 'boardPosition'
  label: string
  score: number | null
  maxScore: number
  status: 'strong' | 'neutral' | 'weak' | 'unknown'
  value: string
  detail: string
}
interface LimitBoardStockQuality {
  tier: LimitBoardQualityTier
  title: string
  summary: string
  totalScore: number | null
  confidence: number
  dataStatus: LimitBoardDataStatus
  completeness: number
  missingFields: string[]
  dimensions: LimitBoardQualityDimension[]
  evidence: string[]
  risks: string[]
  confirmations: string[]
  invalidations: string[]
}
interface LimitBoardStock {
  tsCode: string
  stockCode: string
  stockName: string
  limitTime: string
  limitPrice: number
  pctChg: number
  fundAmount: number
  openTimes: number
  limitTimes: number
  conceptName: string
  conceptZtNum: number
  hasDumpInstWarning: boolean
  dumpInstDesc: string | null
  timeWindow: LimitTimeWindow
  quality: LimitBoardStockQuality
}
interface LimitBoardSnapshot {
  tradeDate: string
  generatedAt: number
  isMock: boolean
  inTradingHours: boolean
  totalLimitCount: number
  conceptList: string[]
  stocks: LimitBoardStock[]
  dataMode: 'realtime' | 'eod'
  rtDataTime: string | null
  strategyVersion: string
  workbench: {
    stance: 'focus' | 'selective' | 'defensive' | 'insufficient'
    title: string
    summary: string
    dataStatus: LimitBoardDataStatus
    completeness: number
    missingFields: string[]
    focusCount: number
    watchCount: number
    fragileCount: number
    themes: Array<{
      name: string
      stockCount: number
      focusCount: number
      watchCount: number
      averageScore: number | null
    }>
    strategyVersion: string
  }
}

type SecondBoardDataMode = 'realtime' | 'eod' | 'fallback'
type SecondBoardTier = 'core' | 'contender' | 'fragile' | 'insufficient'
type SecondBoardDataStatus = 'complete' | 'partial' | 'insufficient'
interface SecondBoardThemeContext {
  name: string
  consecutiveCount: number
  limitUpCount: number | null
  maxBoards: number | null
  heightLevels: number[]
  ladderDepth: number
  supportCount: number | null
  formed: boolean
}
interface SecondBoardDimension {
  key: 'boardPosition' | 'stability' | 'seal' | 'turnover' | 'themeLadder'
  label: string
  score: number | null
  maxScore: number
  status: 'strong' | 'neutral' | 'weak' | 'unknown'
  value: string
  detail: string
}
interface SecondBoardStockJudgment {
  tier: SecondBoardTier
  title: string
  summary: string
  totalScore: number | null
  confidence: number
  dataStatus: SecondBoardDataStatus
  completeness: number
  missingFields: string[]
  dimensions: SecondBoardDimension[]
  evidence: string[]
  risks: string[]
  confirmations: string[]
  invalidations: string[]
  theme: SecondBoardThemeContext | null
}
interface SecondBoardStock {
  tsCode: string
  stockCode: string
  stockName: string
  pctChg: number | null
  limitTimes: number | null
  firstTime: string | null
  lastTime: string | null
  openTimes: number | null
  fundAmount: number | null
  turnoverRatio: number | null
  prevTurnoverRatio: number | null
  conceptName: string | null
  conceptLimitUpCount: number | null
  hasDumpInstWarning: boolean
  dumpInstDesc: string | null
  dataMode: SecondBoardDataMode
  judgment: SecondBoardStockJudgment
}
interface SecondBoardSnapshot {
  tradeDate: string
  generatedAt: number
  isMock: boolean
  totalSecondBoardCount: number
  conceptList: string[]
  stocks: SecondBoardStock[]
  dataMode: SecondBoardDataMode
  rtDataTime: string | null
  strategyVersion: string
  workbench: {
    stance: 'formed' | 'selective' | 'defensive' | 'insufficient'
    title: string
    summary: string
    dataStatus: SecondBoardDataStatus
    completeness: number
    missingFields: string[]
    highestBoard: number | null
    heightDistribution: Array<{ boards: number; count: number }>
    coreCount: number
    contenderCount: number
    fragileCount: number
    insufficientCount: number
    formedThemeCount: number
    isolatedHighCount: number
    themes: SecondBoardThemeContext[]
    strategyVersion: string
  }
}

interface FirstYinStock {
  tsCode: string
  stockCode: string
  stockName: string
  price: number | null
  pctChg: number | null
  turnoverRatio: number | null
  peakTurnoverRatio: number | null
  peakBoards: number
  peakDate: string
  divergenceDate: string
  sessionsSinceDivergence: number
  confirmPrice: number | null
  invalidationPrice: number | null
  conceptName: string | null
  conceptLimitUpCount: number | null
  judgment: import('../main/services/firstYinDipJudgmentModel').FirstYinStockJudgment
}
interface FirstYinSnapshot {
  requestedTradeDate: string
  tradeDate: string
  generatedAt: number
  dataMode: import('../main/services/firstYinDipJudgmentModel').FirstYinDataMode
  rtDataTime: string | null
  candidateCount: number
  conceptList: string[]
  stocks: FirstYinStock[]
  judgment: import('../main/services/firstYinDipJudgmentModel').FirstYinWorkbenchJudgment
  strategyVersion: string
}

type DipBuyRadarSnapshot = import('../main/services/dipBuyRadarService').DipBuyRadarSnapshot

interface BaseDataPackageManifest {
  formatVersion: number
  app: string
  exportedAt: number
  tradeDateStart: string | null
  tradeDateEnd: string | null
  recordCounts: Record<string, number>
  tables: string[]
}

// FR-151b: 个性选股快照
type ScreenerSignalKey = 'crossUp' | 'volAmplified' | 'bullTrend' | 'macdBull' | 'hasTurnover' | 'moneyInflow'
type ScreenerTieBreaker = 'pctChg' | 'turnoverRate' | 'amount'

interface ScreenerRankBreakdownItem {
  key: ScreenerSignalKey
  label: string
  matched: boolean
  weight: number
  strength: number
  contribution: number
}

interface ScreenerMoneyFlowSummary {
  source: 'real' | 'estimated' | 'none'
  mainNetInflow: number | null
  mainNetInflowRatio: number | null
  netMfAmount: number | null
  detail?: {
    small: { buy: number | null; sell: number | null }
    medium: { buy: number | null; sell: number | null }
    large: { buy: number | null; sell: number | null }
    extraLarge: { buy: number | null; sell: number | null }
  }
}

interface ScreenerRankConfig {
  weights: Record<ScreenerSignalKey, number>
  tieBreaker: ScreenerTieBreaker
  normalizeEnabled: boolean
  normalizationCaps: {
    volAmplified: number
    macdBull: number
    hasTurnover: number
    moneyInflow: number
  }
  updatedAt: number
}

interface ScreenerStock {
  tsCode: string
  stockName: string
  close: number
  pctChg: number
  turnoverRate: number | null
  vol: number
  amount: number
  signalScore: number
  conditionsMet: string[]
  concepts: string[]
  turnoverMissing?: boolean
  rankScore: number
  rankBreakdown: ScreenerRankBreakdownItem[]
  signalStrength: Record<ScreenerSignalKey, number>
  moneyFlow: ScreenerMoneyFlowSummary | null
}

interface ScreenerSnapshot {
  tradeDate: string
  calculatedAt: string
  isCached: boolean
  mode: 'realtime' | 'eod' | 'eod-fallback'
  rtTime?: string
  totalScanned: number
  stocks: ScreenerStock[]
}

interface ScreenerInsight {
  tradeDate: string
  tsCode: string
  stockName: string | null
  sections: {
    hitReason: string
    catalyst: string
    technicalContext: string
    risks: string
  }
  confidenceBoundary: string
  evidenceSummary: string[]
  evidenceHash: string
  fromCache: boolean
  provider: string | null
  model: string | null
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  finishReason?: string | null
  complianceBlocked: boolean
  updatedAt: number
}

type DecisionSignalSourceModule = 'news' | 'ai' | 'short_term' | 'trend' | 'market' | 'sector_flow' | 'manual'
type DecisionSignalType = 'ALERT' | 'OPPORTUNITY' | 'RISK' | 'INFO'
type DecisionSignalDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL'
type DecisionSignalStatus = 'NEW' | 'READ' | 'WATCHING' | 'DISMISSED' | 'EXPIRED'
type DecisionSignalResolution =
  | 'RESOLVED_VALID'
  | 'RESOLVED_INVALID'
  | 'RESOLVED_MISSED'
  | 'RESOLVED_DUPLICATE'
  | 'RESOLVED_DATA_ISSUE'
  | 'RESOLVED_MANUAL'
type DecisionSignalEventType =
  | 'CREATED'
  | 'UPDATED'
  | 'READ'
  | 'WATCHED'
  | 'DISMISSED'
  | 'EXPIRED'
  | 'RESOLVED'
  | 'REOPENED'
  | 'NOTE_ADDED'

interface DecisionSignalItem {
  id: number
  sourceModule: DecisionSignalSourceModule
  strategyKey: string
  tsCode: string | null
  stockName: string | null
  conceptCode: string | null
  conceptName: string | null
  signalType: DecisionSignalType
  direction: DecisionSignalDirection
  priority: number
  score: number | null
  confidence: number | null
  title: string
  summary: string
  reasonJson: string | null
  sourceRefJson: string | null
  status: DecisionSignalStatus
  dedupKey: string
  signalTime: number
  expireAt: number | null
  createdAt: number
  updatedAt: number
  firstSeenAt: number | null
  lastSeenAt: number | null
  occurrenceCount: number
  acknowledgedAt: number | null
  watchedAt: number | null
  dismissedAt: number | null
  resolvedAt: number | null
  resolution: DecisionSignalResolution | null
  resolutionNote: string | null
}

interface DecisionSignalEventItem {
  id: number
  signalId: number
  eventType: DecisionSignalEventType
  fromStatus: DecisionSignalStatus | null
  toStatus: DecisionSignalStatus | null
  resolution: DecisionSignalResolution | null
  reason: string | null
  note: string | null
  createdAt: number
}

interface DecisionSignalSummary {
  totalToday: number
  unreadCount: number
  highPriorityUnreadCount: number
  watchingCount: number
  byType: Record<DecisionSignalType, number>
  bySource: Partial<Record<DecisionSignalSourceModule, number>>
  topSignals: DecisionSignalItem[]
}

interface DecisionReviewSignalItem {
  id: number
  sourceModule: DecisionSignalSourceModule
  strategyKey: string
  tsCode: string | null
  stockName: string | null
  conceptCode: string | null
  conceptName: string | null
  signalType: DecisionSignalType
  direction: DecisionSignalDirection
  priority: number
  score: number | null
  confidence: number | null
  title: string
  summary: string
  reasonJson: string | null
  sourceRefJson: string | null
  status: DecisionSignalStatus
  signalTime: number
  firstSeenAt: number | null
  lastSeenAt: number | null
  occurrenceCount: number
  resolution: DecisionSignalResolution | null
  resolutionNote: string | null
}

interface DecisionReviewStats {
  rangeDays: number
  startTime: number
  endTime: number
  sampleSize: number
  summary: {
    total: number
    resolved: number
    watching: number
    dismissed: number
    unresolved: number
    readUnresolved: number
    repeated: number
  }
  bySource: Partial<Record<DecisionSignalSourceModule, number>>
  byType: Partial<Record<DecisionSignalType, number>>
  byResolution: Partial<Record<DecisionSignalResolution, number>>
  byPriority: Record<'P1' | 'P2' | 'P3' | 'P4' | 'P5', number>
  noiseSuggestions: Array<{
    id: string
    level: 'high' | 'medium' | 'low'
    targetType: 'source' | 'strategy' | 'review' | 'data'
    title: string
    summary: string
    metric: string
    actionLabel: string
    sourceModule?: DecisionSignalSourceModule
    strategyKey?: string
  }>
  pendingReview: DecisionReviewSignalItem[]
  repeatedSignals: DecisionReviewSignalItem[]
}

interface DecisionHistorySignalsResult {
  rangeDays: number
  startTime: number
  endTime: number
  total: number
  offset: number
  limit: number
  items: DecisionReviewSignalItem[]
  availableDates: string[]
  selectedTradeDate: string | null
}

interface DecisionSignalDateContext {
  today: string
  displayDate: string
  latestTradeDate: string | null
  isFallback: boolean
  isTradingDay: boolean
}

interface DecisionPortfolioRiskReview {
  rangeDays: number
  totalPortfolio: number
  missingCostPrice: number
  withRiskSignals: number
  unresolvedRiskSignals: number
  repeatedRiskSignals: number
  items: Array<{
    tsCode: string
    stockName: string
    costPrice: number | null
    totalSignals: number
    riskSignals: number
    unresolvedSignals: number
    repeatedSignals: number
    latestSignal: DecisionReviewSignalItem | null
  }>
}

interface DecisionReviewStatsFilters {
  rangeDays?: number
  sourceModules?: DecisionSignalSourceModule[]
  types?: DecisionSignalType[]
  statuses?: DecisionSignalStatus[]
  tsCode?: string
  portfolioOnly?: boolean
  offset?: number
  limit?: number
  tradeDate?: string
}

interface DecisionOutcomeMemoryFilters {
  rangeDays?: number
  horizonDays?: number
  portfolioOnly?: boolean
  limit?: number
}

interface DecisionOutcomeMemoryResult {
  rangeDays: number
  horizonDays: number
  generatedAt: number
  sampleSize: number
  evaluableSize: number
  samples: Array<{
    tsCode: string
    stockName: string | null
    tag: string
    judgmentAt: number
    signalId: number
    title: string
    note: string
    direction: string
    forwardReturnPct: number | null
    outcomeLabel: 'aligned' | 'mixed' | 'misaligned' | 'blocked'
    outcomeReason: string
    baseTradeDate: string | null
    endTradeDate: string | null
  }>
  bias: {
    byTag: Array<{
      tag: string
      total: number
      evaluable: number
      aligned: number
      misaligned: number
      mixed: number
      blocked: number
    }>
    insufficientSample: boolean
    hint: string
  }
}

type ReviewReportKind = 'daily' | 'weekly'

interface ReviewReportSnapshot {
  kind: ReviewReportKind
  rangeDays: number
  generatedAt: number
  title: string
  headline: string
  summary: {
    holdingCount: number
    portfolioSignalCount: number
    processedCount: number
    openRiskCount: number
    evidenceGapCount: number
    followUpCount: number
  }
  processed: unknown[]
  openRisks: unknown[]
  evidenceGaps: unknown[]
  followUps: unknown[]
  disclaimer: string
  emptyDay: boolean
}

interface SavedReviewReportSummary {
  id: string
  kind: ReviewReportKind
  periodStart: string
  periodEnd: string
  rangeDays: number
  generatedAt: number
  savedAt: number
  schemaVersion: number
  title: string
  headline: string
  openRiskCount: number
  evidenceGapCount: number
  followUpCount: number
  versionNumber: number
  versionCount: number
}

interface SavedReviewReportDetail extends SavedReviewReportSummary {
  snapshot: ReviewReportSnapshot
}

interface ReviewReportListFilters {
  kind?: ReviewReportKind
  periodStart?: string
  periodEnd?: string
  includeAllVersions?: boolean
  offset?: number
  limit?: number
}

type DecisionJudgmentTag = 'watch' | 'risk_off' | 'noise' | 'insufficient' | 'done'

interface DecisionJudgmentEvidenceSnapshot {
  primaryTitle: string
  primarySummary: string
  sourceCount: number
  maxPriority: number
  trustHint: string
  evidence: Array<{
    key: string
    label: string
    status: 'ready' | 'missing' | 'blocked'
    detail: string
  }>
}

interface SaveDecisionJudgmentPayload {
  requestId: string
  judgmentGroupId?: string
  tsCode: string
  stockName?: string
  tag: DecisionJudgmentTag
  note?: string
  sourceSignalId?: number
  relatedSignalIds?: number[]
  evidenceSnapshot: DecisionJudgmentEvidenceSnapshot
  reviewDueAt?: number | null
}

interface DecisionJudgmentSummary {
  id: string
  judgmentGroupId: string
  versionNumber: number
  tsCode: string
  stockName: string | null
  tag: DecisionJudgmentTag
  note: string
  sourceSignalId: number | null
  reviewDueAt: number | null
  createdAt: number
  schemaVersion: number
  versionCount: number
  sourceSignalAvailable: boolean
}

interface DecisionJudgmentDetail extends DecisionJudgmentSummary {
  relatedSignalIds: number[]
  evidenceSnapshot: DecisionJudgmentEvidenceSnapshot
  versions: DecisionJudgmentSummary[]
}

interface DecisionJudgmentListFilters {
  tsCode?: string
  tags?: DecisionJudgmentTag[]
  from?: number
  to?: number
  latestPerGroup?: boolean
  limit?: number
  offset?: number
}

type DecisionJudgmentFollowUpAction = 'maintain' | 'revise' | 'close'

interface DecisionJudgmentFollowUpTask {
  judgmentId: string
  judgmentGroupId: string
  tsCode: string
  stockName: string | null
  tag: DecisionJudgmentTag
  note: string
  reviewDueAt: number
  createdAt: number
  overdueMs: number
  status: 'due'
}

interface CompleteDecisionJudgmentFollowUpPayload {
  requestId: string
  judgmentId: string
  action: DecisionJudgmentFollowUpAction
  tag?: DecisionJudgmentTag
  note?: string
  nextReviewDueAt?: number | null
}

interface DecisionJudgmentFollowUpRecord {
  id: string
  requestId: string
  sourceJudgmentId: string
  resultJudgmentId: string
  action: DecisionJudgmentFollowUpAction
  note: string
  completedAt: number
  schemaVersion: number
  resultJudgment: DecisionJudgmentSummary
}

interface DecisionSignalFilters {
  sourceModules?: DecisionSignalSourceModule[]
  statuses?: DecisionSignalStatus[]
  types?: DecisionSignalType[]
  minPriority?: number
  tsCode?: string
  conceptCode?: string
  limit?: number
  portfolioOnly?: boolean
}

type PortfolioPositionAdvice = 'HOLD' | 'WATCH' | 'TAKE_PROFIT' | 'STOP_LOSS'

interface ChipSummary {
  tradeDate: string
  bottomPct: number | null
  bottomAvgCost: number | null
  loosening1d: number | null
  loosening3d: number | null
  loosening5d: number | null
  pctChg: number | null
  turnoverRate: number | null
}

interface PortfolioDashboardItem {
  tsCode: string
  stockCode: string
  stockName: string
  addedAt: number
  costPrice: number | null
  price: number | null
  change: number | null
  profitPct: number | null
  positionAdvice: PortfolioPositionAdvice | null
  positionAdviceReason: string | null
  chip: ChipSummary | null
  trend: {
    totalScore: number | null
    maScore: number | null
    maAbove60: boolean | null
    drawdown: number | null
    macdAboveZero: boolean | null
    bollAboveMid: boolean | null
    dataSource: 'realtime' | 'eod' | null
    dataTime: string | null
  }
  forecast: {
    id: number
    provider: string
    model: string | null
    targetDate: string | null
    direction: string | null
    summary: string | null
    createdAt: number
    backtestDirection: string | null
    backtestMape: number | null
  } | null
  todaySignals: { count: number; maxPriority: number | null; latestTitle: string | null; latestSignalTime: number | null }
  news: Array<{ briefingId: number; title: string; impactLevel: string | null; publishedAt: number | null }>
  supplyChain: { chainGroup: string | null; eventType: string | null; direction: string | null; confidence: number | null; topNodes: string[] } | null
  sectorFlow: {
    conceptName: string
    metricMode: 'verified_flow' | 'turnover_strength'
    mainNetInflow: number | null
    mainNetInflowRate: number | null
    previousMainNetInflow: number | null
    turnoverDirectionStrength: number | null
    weightedChange: number | null
  } | null
}

type TrendWorkbenchState = 'strengthening' | 'strong' | 'stable' | 'weakening' | 'broken' | 'insufficient'

interface TrendBenchmarkHealth {
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

interface TrendWorkbenchItem {
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
  positionAdvice: PortfolioPositionAdvice | null
  positionAdviceReason: string | null
  chip: ChipSummary | null
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
  trendState: TrendWorkbenchState
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
  benchmarkHealth: TrendBenchmarkHealth
}

interface TrendWorkbenchSnapshot {
  generatedAt: number
  items: TrendWorkbenchItem[]
  events: Array<{
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
  }>
  dataHealth: {
    total: number
    ready: number
    partial: number
    missing: number
    latestTradeDate: string | null
    benchmark: TrendBenchmarkHealth
  }
}

interface StrategyBacktestTradePlan {
  entryRule: 'nextOpen' | 'signalClose'
  holdDays: number
  stopProfit?: number | null
  stopLoss?: number | null
  feeBps: number
}

type StrategyBacktestSignalSource = 'shortTerm' | 'trendAlerts' | 'decisionSignals'
type StrategyBacktestTrustStatus = 'reliable' | 'degraded' | 'blocked'
type StrategyBacktestTrustReason =
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

interface StrategyBacktestCredibility {
  version: 1
  assessedAt: number
  conclusion: 'unavailable' | 'exploratory' | 'comparable'
  summary: string
  dataQualityFingerprint: string
  gates: Array<{
    key: 'dataFoundation' | 'temporalIntegrity' | 'executionRealism' | 'sampleAdequacy' | 'stabilityValidation'
    title: string
    status: StrategyBacktestTrustStatus
    summary: string
    details: string[]
  }>
  sample: { totalSignals: number; validSignals: number; signalDayCount: number; missingRate: number | null }
  periodSlices: Array<{ label: '前半区间' | '后半区间'; sampleCount: number; avgReturn: number | null; winRate: number | null }>
}

type StrategyBacktestEquityModel = 'equal_weighted_exit_day_compound'

interface StrategyBacktestEquityPoint {
  date: string
  realizedReturnPct: number
  tradeCount: number
  equity: number
  drawdownPct: number
}

interface StrategyBacktestStrengthDecile {
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

interface StrategyBacktestReport {
  schemaVersion: 1 | 2 | 3 | 4
  generatedAt: number
  trust: {
    status: StrategyBacktestTrustStatus
    reasons: StrategyBacktestTrustReason[]
    engineVersion: string
    factFingerprint: string
    credibility?: StrategyBacktestCredibility
  }
  strategyKey: string
  signalSource?: StrategyBacktestSignalSource
  dateRange: { start: string; end: string }
  plan: StrategyBacktestTradePlan
  totalSignals: number
  validTrades: number
  dropRate: number | null
  winRate: number | null
  avgReturn: number | null
  medianReturn: number | null
  profitFactor: number | null
  expectancy: number | null
  equityModel: StrategyBacktestEquityModel
  totalReturn: number | null
  equityCurve: StrategyBacktestEquityPoint[] | null
  maxDrawdown: number | null
  sharpeLike: number | null
  byStrengthDecile: StrategyBacktestStrengthDecile[] | null
  benchmarkReturn: number | null
  excessReturn?: number | null
  benchmarkNote?: string | null
}

interface StrategyBacktestRunSummary {
  id: number
  strategyKey: string
  signalSource?: StrategyBacktestSignalSource
  dateStart: string
  dateEnd: string
  plan: StrategyBacktestTradePlan
  status: 'completed' | 'failed'
  trustStatus: StrategyBacktestTrustStatus
  errorMessage: string | null
  createdAt: number
}

interface StrategyBacktestTradeRow {
  runId: number
  strategyKey: string
  tsCode: string
  stockName?: string | null
  signalDate: string
  entryDate: string | null
  entryPrice: number | null
  exitDate: string | null
  exitPrice: number | null
  grossReturnPct: number | null
  netReturnPct: number | null
  returnPct: number | null
  exitReason: string | null
  status: 'executed' | 'data_insufficient'
  strength: number | null
  metaJson: string | null
}

interface StrategyBacktestProgress {
  stage: 'cache' | 'signals' | 'prices' | 'trades' | 'benchmark' | 'save' | 'done' | 'failed'
  current: number
  total: number
  message: string
}

type StrategyEffectivenessHorizon = 1 | 2 | 3 | 5
type StrategyEffectivenessSource = 'auction' | 'strategyLab'
type StrategyEffectivenessDirection = 'long' | 'short'
type StrategyEffectivenessEntryBasis = 'auction_925' | 'next_trade_open'
type StrategyEffectivenessHorizonRecord = Record<'1' | '2' | '3' | '5', number | null>

interface StrategyEffectivenessCatalogItem {
  id: string
  label: string
  description: string
  source: StrategyEffectivenessSource
  direction: StrategyEffectivenessDirection
  version: string
  entryBasis: StrategyEffectivenessEntryBasis
  latestRunAt: number | null
  availableDateStart: string | null
  availableDateEnd: string | null
  available: boolean
  unavailableReason: string | null
}

interface StrategyEffectivenessMetric {
  horizon: StrategyEffectivenessHorizon
  validCount: number
  missingRate: number | null
  avgReturn: number | null
  medianReturn: number | null
  winRate: number | null
  profitFactor: number | null
  dateWeightedReturn: number | null
  avgExcess: number | null
  p25: number | null
  p75: number | null
  best: number | null
  worst: number | null
}

interface StrategyEffectivenessResult {
  generatedAt: number
  dateRange: { start: string; end: string }
  horizons: StrategyEffectivenessHorizon[]
  selectedStrategyIds: string[]
  catalog: StrategyEffectivenessCatalogItem[]
  rankings: Array<{
    strategyId: string
    label: string
    source: StrategyEffectivenessSource
    direction: StrategyEffectivenessDirection
    version: string
    entryBasis: StrategyEffectivenessEntryBasis
    signalCount: number
    signalDayCount: number
    metrics: StrategyEffectivenessMetric[]
  }>
  overlaps: Array<{
    leftStrategyId: string
    rightStrategyId: string
    intersectionCount: number
    unionCount: number
    overlapRate: number | null
  }>
  observations: Array<{
    id: string
    strategyId: string
    strategyLabel: string
    source: StrategyEffectivenessSource
    version: string
    tsCode: string
    stockName: string | null
    signalDate: string
    direction: StrategyEffectivenessDirection
    entryBasis: StrategyEffectivenessEntryBasis
    entryDate: string | null
    entryPrice: number | null
    score: number | null
    status: 'valid' | 'partial' | 'data_insufficient' | 'excluded'
    missingReason: 'ONE_WORD_LIMIT' | 'NO_ENTRY_PRICE' | 'NO_FUTURE_CLOSE' | null
    returns: StrategyEffectivenessHorizonRecord
    benchmarkReturns: StrategyEffectivenessHorizonRecord
    excessReturns: StrategyEffectivenessHorizonRecord
  }>
  credibility: StrategyBacktestCredibility
  coverage: {
    totalSignals: number
    validSignals: number
    partialSignals: number
    excludedSignals: number
    insufficientSignals: number
    truncated: boolean
    note: string
  }
}

// Expose a typed API to the renderer via window.api
const api = {
  researchAgent: {
    preflight: (sessionId: number) => (
      ipcRenderer.invoke('researchAgent:preflight', { sessionId }) as Promise<ResearchAgentPreflightResponse>
    ),
    preflightDirect: (payload: ResearchAgentDirectPreflightRequest = {}) => (
      ipcRenderer.invoke('researchAgent:preflightDirect', payload) as Promise<ResearchAgentPreflightResponse>
    ),
    startRun: (payload: ResearchAgentStartRequest) => (
      ipcRenderer.invoke('researchAgent:startRun', payload) as Promise<ResearchAgentStartResponse>
    ),
    startDirect: (payload: ResearchAgentStartDirectRequest) => (
      ipcRenderer.invoke('researchAgent:startDirect', payload) as Promise<ResearchAgentStartDirectResponse>
    ),
    startReview: (payload: ResearchAgentStartReviewRequest) => (
      ipcRenderer.invoke('researchAgent:startReview', payload) as Promise<ResearchAgentStartReviewResponse>
    ),
    listRuns: (sessionId?: number | null) => (
      ipcRenderer.invoke('researchAgent:listRuns', { sessionId: sessionId ?? null }) as Promise<ResearchAgentListResponse>
    ),
    getRun: (runId: string) => (
      ipcRenderer.invoke('researchAgent:getRun', { runId }) as Promise<ResearchAgentDetailResponse>
    ),
    cancelRun: (payload: ResearchAgentMutationRequest) => (
      ipcRenderer.invoke('researchAgent:cancelRun', payload) as Promise<ResearchAgentMutationResponse>
    ),
    resumeRun: (payload: ResearchAgentMutationRequest) => (
      ipcRenderer.invoke('researchAgent:resumeRun', payload) as Promise<ResearchAgentMutationResponse>
    ),
    retryRun: (payload: ResearchAgentRetryRequest) => (
      ipcRenderer.invoke('researchAgent:retryRun', payload) as Promise<ResearchAgentRetryResponse>
    ),
    deleteRun: (payload: ResearchAgentMutationRequest) => (
      ipcRenderer.invoke('researchAgent:deleteRun', payload) as Promise<ResearchAgentDeleteResponse>
    ),
    onProgress: (listener: (event: ResearchAgentRunnerProgress) => void) => {
      const wrapped = (_event: IpcRendererEvent, data: ResearchAgentRunnerProgress) => listener(data)
      ipcRenderer.on('researchAgent:progress', wrapped)
      return () => { ipcRenderer.removeListener('researchAgent:progress', wrapped) }
    },
  },
  researchAccess: {
    getWorkbench: () => ipcRenderer.invoke('researchAccess:getWorkbench') as Promise<ResearchAccessApiResult<ResearchAccessWorkbench>>,
    createProfile: (payload: ResearchAccessCreateRequest) =>
      ipcRenderer.invoke('researchAccess:createProfile', payload) as Promise<ResearchAccessApiResult<ResearchAccessCredentialDelivery>>,
    updateProfile: (payload: ResearchAccessUpdateRequest) =>
      ipcRenderer.invoke('researchAccess:updateProfile', payload) as Promise<ResearchAccessApiResult<ResearchAccessWorkbench['profiles'][number]>>,
    rotateCredential: (payload: ResearchAccessProfileOperationRequest) =>
      ipcRenderer.invoke('researchAccess:rotateCredential', payload) as Promise<ResearchAccessApiResult<ResearchAccessCredentialDelivery>>,
    revokeProfile: (payload: ResearchAccessProfileOperationRequest) =>
      ipcRenderer.invoke('researchAccess:revokeProfile', payload) as Promise<ResearchAccessApiResult<ResearchAccessWorkbench['profiles'][number]>>,
    listAudit: (payload: ResearchAccessAuditRequest = {}) =>
      ipcRenderer.invoke('researchAccess:listAudit', payload) as Promise<ResearchAccessApiResult<{ items: ResearchAccessAuditView[]; nextCursor: number | null }>>,
  },
  app: {
    relaunch: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),
  },

  // ── Briefings ──────────────────────────────────────────
  briefings: {
    list: (options?: BriefingListOptions) =>
      ipcRenderer.invoke('briefings:list', options ?? {}),
    getById: (id: number) =>
      ipcRenderer.invoke('briefings:getById', id),
    markRead: (id: number) =>
      ipcRenderer.invoke('briefings:markRead', id),
    markAllRead: (options?: BriefingListOptions) =>
      ipcRenderer.invoke('briefings:markAllRead', options ?? {})
  },

  // ── Sources ────────────────────────────────────────────
  sources: {
    list: () => ipcRenderer.invoke('sources:list'),
    add: (data: {
      nameCN: string
      nameEN: string
      url: string
      feedUrl?: string
      parseStrategy: ParseStrategy
      contentSelector?: string
      detailSelector?: string
      authorityWeight?: number
    }) => ipcRenderer.invoke('sources:add', data),
    toggle: (id: number, isEnabled: boolean) =>
      ipcRenderer.invoke('sources:toggle', id, isEnabled),
    delete: (id: number) => ipcRenderer.invoke('sources:delete', id) as Promise<boolean>,
    test: (id: number) => ipcRenderer.invoke('sources:test', id),
    update: (
      id: number,
      data: {
        nameCN: string
        nameEN: string
        url: string
        feedUrl?: string | null
        category?: string
        parseStrategy: ParseStrategy
        contentSelector?: string | null
        detailSelector?: string | null
        authorityWeight?: number
        isEnabled?: boolean
        financeSectionFilter?: string | null
      }
    ) => ipcRenderer.invoke('sources:update', id, data)
  },

  // ── Detail content (on-demand fetch + cache) ───────────
  detail: {
    getContent: (briefingId: number) =>
      ipcRenderer.invoke('detail:getContent', briefingId) as Promise<{
        content: string | null
        status: 'OK' | 'NO_DETAIL_SELECTOR' | 'FETCH_ERROR' | 'PARSER_ERROR' | 'NO_MATCH'
        error?: string
      }>
  },

  // ── Cache management ───────────────────────────────────
  cache: {
    getStats: () =>
      ipcRenderer.invoke('cache:getStats') as Promise<{ count: number; estimatedBytes: number }>,
    clear: (range: 'all' | '1month' | '3months' | '1year') =>
      ipcRenderer.invoke('cache:clear', range) as Promise<number>
  },

  // ── Scan ───────────────────────────────────────────────
  scan: {
    getStatus: () => ipcRenderer.invoke('scan:getStatus'),
    triggerManual: () => ipcRenderer.invoke('scan:triggerManual'),
    stop: () => ipcRenderer.invoke('scan:stop')
  },

  // ── Settings ───────────────────────────────────────────
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (data: Partial<Omit<AppSettingsRow, 'id'>>) =>
      ipcRenderer.invoke('settings:update', data),
    getDecisionCenterFilters: () => ipcRenderer.invoke('settings:getDecisionCenterFilters') as Promise<DecisionCenterFiltersPreference | null>,
    setDecisionCenterFilters: (filters: DecisionCenterFiltersPreference) =>
      ipcRenderer.invoke('settings:setDecisionCenterFilters', filters) as Promise<DecisionCenterFiltersPreference>,
    getTheme: () => ipcRenderer.invoke('settings:getTheme') as Promise<string>,
    setTheme: (theme: string) => ipcRenderer.invoke('settings:setTheme', theme) as Promise<void>,
    getMarketHeatmapProvider: () => ipcRenderer.invoke('settings:getMarketHeatmapProvider') as Promise<'sina' | 'eastmoney' | 'tushare'>,
    setMarketHeatmapProvider: (provider: 'sina' | 'eastmoney' | 'tushare') => ipcRenderer.invoke('settings:setMarketHeatmapProvider', provider) as Promise<'ok'>
  },

  // ── Premarket external facts ───────────────────────────
  premarket: {
    getStatus: () => ipcRenderer.invoke('premarket:getStatus') as Promise<PremarketCaptureStatusView>,
    setEnabled: (enabled: boolean) => (
      ipcRenderer.invoke('premarket:setEnabled', enabled) as Promise<PremarketCaptureStatusView>
    ),
    captureCurrent: () => (
      ipcRenderer.invoke('premarket:captureCurrent') as Promise<PremarketCaptureActionResponse>
    ),
    getScenario: () => (
      ipcRenderer.invoke('premarket:getScenario') as Promise<PremarketScenarioReadResponse>
    ),
    getScenarioRevision: (versionId: string) => (
      ipcRenderer.invoke('premarket:getScenarioRevision', { versionId }) as Promise<PremarketScenarioReadResponse>
    ),
    retryScenario: () => (
      ipcRenderer.invoke('premarket:retryScenario') as Promise<PremarketScenarioRetryResponse>
    ),
    onRetryProgress: (listener: (progress: PremarketScenarioRetryProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: PremarketScenarioRetryProgress) => listener(progress)
      ipcRenderer.on('premarket:retryProgress', handler)
      return () => { ipcRenderer.removeListener('premarket:retryProgress', handler) }
    },
    explainScenario: (versionId?: string) => (
      ipcRenderer.invoke('premarket:explainScenario', { versionId }) as Promise<PremarketExplainResponse>
    ),
    getPreparation: () => (
      ipcRenderer.invoke('premarket:getPreparation') as Promise<PremarketPreparationReadResponse>
    ),
    refreshPreparation: () => (
      ipcRenderer.invoke('premarket:refreshPreparation') as Promise<PremarketPreparationRefreshResponse>
    ),
    onOpenScenario: (listener: () => void) => {
      const handler = () => listener()
      ipcRenderer.on('premarket:openScenario', handler)
      return () => { ipcRenderer.removeListener('premarket:openScenario', handler) }
    },
  },

  // ── Archive ────────────────────────────────────────────
  archive: {
    listDates: (limit?: number) => ipcRenderer.invoke('archive:listDates', limit),
    getDate: (date: string) => ipcRenderer.invoke('archive:getDate', date)
  },

  // ── AI Config & Analysis ────────────────────────────────
  ai: {
    getConfig: () => ipcRenderer.invoke('ai:getConfig'),
    saveConfig: (data: {
      provider?: string
      model?: string
      apiKey?: string
      baseUrl?: string
      presetPrompt?: string
      triggerRating?: string
      maxArticlesPerBatch?: number
      maxContentCharsPerArticle?: number
      maxArticleAgeDays?: number | null
      autoCleanupDays?: number | null
      trendForecastPrompt?: string | null
      trendForecastMorrowPrompt?: string | null
      maxForecastsPerStock?: number
      providerPriority?: string[]
      multiModelProviders?: string[]
      maxForecastComparison?: number
      selectedSkills?: string[]
      customSkillPaths?: string[]
      skillsForTrend?: boolean
      maxSkillChars?: number
      providerConfig?: {
        provider: string
        model?: string
        apiKey?: string
        baseUrl?: string
        maxTokens?: number
        presetPrompt?: string
        trendForecastPrompt?: string
        trendForecastMorrowPrompt?: string
      }
    }) => ipcRenderer.invoke('ai:saveConfig', data),
    analyze: (data: {
      briefingIds?: number[]
      articleUrls?: string[]
      scanRunId: number | null
      briefingId?: number
    }) => ipcRenderer.invoke('ai:analyze', data),
    listSessions: () => ipcRenderer.invoke('ai:listSessions'),
    getSession: (id: number) => ipcRenderer.invoke('ai:getSession', { id }),
    generateStructuredResult: (sessionId: number, force?: boolean) =>
      ipcRenderer.invoke('ai:generateStructuredResult', { sessionId, force }),
    recoverCandidates: (sessionId: number) =>
      ipcRenderer.invoke('ai:recoverCandidates', { sessionId }) as Promise<{
        ok: boolean
        recovered?: boolean
        stockCodes?: string[]
        response?: string
        code?: string
        message?: string
      }>,
    deleteAllSessions: (includeResearchDiscussions = false) =>
      ipcRenderer.invoke('ai:deleteAllSessions', { includeResearchDiscussions }),
    deleteSession: (id: number, confirmResearchDiscussion = false) =>
      ipcRenderer.invoke('ai:deleteSession', { id, confirmResearchDiscussion }),
    cleanupOldSessions: (olderThanDays: number, dryRun: boolean) =>
      ipcRenderer.invoke('ai:cleanupOldSessions', { olderThanDays, dryRun }),
    triggerRound2: (sessionId: number) => ipcRenderer.invoke('ai:triggerRound2', { sessionId }),
    followUp: (sessionId: number, message: string) =>
      ipcRenderer.invoke('ai:followUp', { sessionId, message }),
    startResearchDiscussion: (payload: {
      requestId: string
      origin: { type: 'daily_review' | 'weekly_review' | 'decision_signal' | 'judgment' | 'industry_research' | 'briefing' | 'manual'; id: string | null }
      projectId?: string | null
      initialQuestion?: string
      mode?: 'continue_or_create' | 'new'
      returnTarget: { tab: string; subTab?: string; entityId?: string; stateKey?: string; scrollTop?: number }
    }) => ipcRenderer.invoke('ai:startResearchDiscussion', payload),
    updateResearchDiscussionContext: (payload: {
      requestId: string
      sessionId: number
      includedContextKeys: string[]
    }) => ipcRenderer.invoke('ai:updateResearchDiscussionContext', payload),
    listResearchDiscussions: (payload: {
      origin?: { type: 'daily_review' | 'weekly_review' | 'decision_signal' | 'judgment' | 'industry_research' | 'briefing' | 'manual'; id: string | null }
      projectId?: string
      status?: 'active' | 'changes_ready' | 'partially_applied' | 'applied' | 'archived'
      offset?: number
      limit?: number
    }) => ipcRenderer.invoke('ai:listResearchDiscussions', payload),
    onAnalyzeProgress: (
      listener: (data: {
        step: 'fetching' | 'callingRound1' | 'parsingStocks' | 'recoveringCandidates' | 'fetchingPrices' | 'callingRound2' | 'saving' | 'done' | 'error'
        current?: number
        total?: number
        usages?: {
          round1?: { provider: string; model: string; maxTokens?: number | null; finishReason?: string | null; inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null }
          candidateRecovery?: { provider: string; model: string; maxTokens?: number | null; finishReason?: string | null; inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null }
          round2?: { provider: string; model: string; maxTokens?: number | null; finishReason?: string | null; inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null }
        }
      }) => void
    ) => {
      ipcRenderer.on('ai:analyzeProgress', (_event, data) => listener(data))
      return () => { ipcRenderer.removeAllListeners('ai:analyzeProgress') }
    },
    onTushareNotConfigured: (listener: (data: { stockCodes: string[] }) => void) => {
      ipcRenderer.on('ai:tushareNotConfigured', (_event, data) => listener(data))
      return () => { ipcRenderer.removeAllListeners('ai:tushareNotConfigured') }
    },
    predictTrendToday: (stockCode: string, provider?: string, providers?: string[]) =>
      ipcRenderer.invoke('ai:predictTrendToday', { stockCode, provider, providers }),
    predictTrendMorrow: (stockCode: string, providers?: string[]) =>
      ipcRenderer.invoke('ai:predictTrendMorrow', { stockCode, providers }),
    reviseTrendForecast: (payload: { forecastId: number; stockCode: string; userFeedback: string; providers?: string[] }) =>
      ipcRenderer.invoke('ai:reviseTrendForecast', payload),
    clearForecast: (stockCode: string) =>
      ipcRenderer.invoke('ai:clearForecast', { stockCode }),
    getPredictionCache: (stockCode: string) =>
      ipcRenderer.invoke('ai:getPredictionCache', { stockCode }),
    listForecasts: (stockCode: string) =>
      ipcRenderer.invoke('ai:listForecasts', { stockCode }),
    getForecast: (id: number) =>
      ipcRenderer.invoke('ai:getForecast', { id }),
    deleteForecast: (id: number) =>
      ipcRenderer.invoke('ai:deleteForecast', { id }),
    deleteAllForecasts: (stockCode: string) =>
      ipcRenderer.invoke('ai:deleteAllForecasts', { stockCode })
  },

  researchEvidence: {
    compareSnapshot: (payload: ResearchEvidenceCompareRequest) => (
      ipcRenderer.invoke('researchEvidence:compareSnapshot', payload) as Promise<ResearchEvidenceCompareResponse>
    ),
    startDiscussion: (payload: ResearchEvidenceStartDiscussionRequest) => (
      ipcRenderer.invoke('researchEvidence:startDiscussion', payload) as Promise<ResearchEvidenceStartDiscussionResponse>
    ),
  },

  // ── Skills (Analysis Frameworks) ─────────────────────────
  skill: {
    list: () => ipcRenderer.invoke('skill:list') as Promise<Array<{
      skillId: string
      name: string
      description: string
      version: string
      source: 'builtin' | 'custom'
      dirPath: string
      contentLength: number
      contentHash: string
      ruleVersion: string
      integrity: 'complete' | 'invalid' | 'conflict'
      conflictPaths?: string[]
    }>>,
    getContent: (skillId: string) => ipcRenderer.invoke('skill:getContent', { skillId }),
    addCustomPath: (dirPath: string) => ipcRenderer.invoke('skill:addCustomPath', { dirPath }) as Promise<{
      skills?: Array<{
        skillId: string
        name: string
        description: string
        version: string
        source: 'builtin' | 'custom'
        dirPath: string
        contentLength: number
        contentHash: string
        ruleVersion: string
        integrity: 'complete' | 'invalid' | 'conflict'
        conflictPaths?: string[]
      }>
      error?: { code: string; message: string }
    }>,
    removeCustomPath: (dirPath: string) => ipcRenderer.invoke('skill:removeCustomPath', { dirPath }),
    reload: () => ipcRenderer.invoke('skill:reload')
  },

  // ── Data Sources ───────────────────────────────────────
  datasource: {
    getConfig: () => ipcRenderer.invoke('datasource:getConfig'),
    saveConfig: (data: { tushareToken?: string; tushareEnabled?: boolean }) =>
      ipcRenderer.invoke('datasource:saveConfig', data),
    validateTushare: (token: string) => ipcRenderer.invoke('datasource:validateTushare', { token }),
    listStocks: () => ipcRenderer.invoke('datasource:listStocks') as Promise<{ stockCode: string; stockName: string }[]>,
    getStockPrices: (stockCode: string) => ipcRenderer.invoke('datasource:getStockPrices', { stockCode }),
    getStockPricePage: (stockCode: string, beforeTradeDate?: string, limit = 149) =>
      ipcRenderer.invoke('datasource:getStockPricePage', { stockCode, beforeTradeDate, limit }) as Promise<
        | {
            ok: true
            rows: Array<{
              stockCode: string
              tradeDate: string
              open: number | null
              high: number | null
              low: number | null
              close: number | null
              volume: number | null
              amount: number | null
              pctChg: number | null
              turnoverRate: number | null
              fetchedAt: number
            }>
            hasMore: boolean
          }
        | { ok: false; error: { code: string; message: string } }
      >,
    deleteStock: (stockCode: string) =>
      ipcRenderer.invoke('datasource:deleteStock', { stockCode }) as Promise<{ ok: boolean; reason?: string }>,
    clearAllStocks: () =>
      ipcRenderer.invoke('datasource:clearAllStocks') as Promise<{ ok: boolean }>,
    refreshStock: (stockCode: string, force = true) =>
      ipcRenderer.invoke('datasource:refreshStock', { stockCode, force }) as Promise<
        | {
            ok: true
            provider: 'tushare' | 'eastmoney'
            latestTradeDate: string | null
            rowsWritten: number
            totalRows: number
            dataState: 'complete' | 'degraded'
            benchmark: TrendBenchmarkHealth
            message: string
          }
        | { ok: false; reason: 'invalid_code' | 'no_token' | 'not_found' | 'fetch_error' }
      >,
    fetchStock: (stockCode: string) =>
      ipcRenderer.invoke('datasource:fetchStock', { stockCode }) as Promise<
        | {
            stockCode: string
            stockName: string
            added: true
            provider: 'tushare' | 'eastmoney' | 'local-cache'
            latestTradeDate: string | null
            rowsWritten: number
            totalRows: number
            dataState: 'complete' | 'degraded'
            benchmark: TrendBenchmarkHealth
            message: string
          }
        | { error: { code: 'INVALID_STOCK_CODE' | 'STOCK_NOT_FOUND' | 'FETCH_FAILED'; message: string } }
      >,
    updateStockName: (stockCode: string, stockName: string) =>
      ipcRenderer.invoke('datasource:updateStockName', { stockCode, stockName }) as Promise<{ ok: boolean }>,
    searchStock: (keyword: string) =>
      ipcRenderer.invoke('datasource:searchStock', { keyword }) as Promise<
        | { ok: true; results: Array<{ tsCode: string; name: string; market: string | null }>; empty: false }
        | { ok: true; results: []; empty: true }
      >,
    getIntradayData: (stockCode: string) =>
      ipcRenderer.invoke('datasource:getIntradayData', { stockCode }),
    // FR-123: 个股分钟级 K 线（Tushare 374 rt_min）
    getStockMinuteKline: (tsCode: string, tradeDate?: string) =>
      ipcRenderer.invoke('datasource:getStockMinuteKline', { tsCode, tradeDate }) as Promise<
        | {
            ok: true
            data: Array<{
              stockCode: string
              tradeDate: string
              tsMinute: string
              open: number | null
              high: number | null
              low: number | null
              close: number | null
              vol: number | null
              amount: number | null
              fetchedAt: number
            }>
          }
        | { ok: false; code: 'INVALID_PARAM'; message: string }
      >,
    subscribeStockMinute: (stockCode: string) =>
      ipcRenderer.invoke('datasource:subscribeStockMinute', { stockCode }) as Promise<
        { ok: true } | { ok: false; code: 'INVALID_PARAM' | 'TUSHARE_DISABLED'; message: string }
      >,
    unsubscribeStockMinute: () =>
      ipcRenderer.invoke('datasource:unsubscribeStockMinute') as Promise<{ ok: true }>,
    onStockMinuteUpdated: (cb: (payload: { stockCode: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: { stockCode: string }) => cb(payload)
      ipcRenderer.on('datasource:stockMinuteUpdated', handler)
      return () => { ipcRenderer.removeListener('datasource:stockMinuteUpdated', handler) }
    },
    onStockMinuteFallback: (cb: (payload: { stockCode: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: { stockCode: string }) => cb(payload)
      ipcRenderer.on('datasource:stockMinuteFallback', handler)
      return () => { ipcRenderer.removeListener('datasource:stockMinuteFallback', handler) }
    }
  },

  stockFundamentals: {
    get: (stockCode: string) =>
      ipcRenderer.invoke('stockFundamentals:get', { stockCode }) as Promise<StockFundamentalReadResult>,
    refresh: (stockCode: string) =>
      ipcRenderer.invoke('stockFundamentals:refresh', { stockCode }) as Promise<StockFundamentalRefreshResult>,
  },

  minuteData: {
    getCapabilities: () => ipcRenderer.invoke('minuteData:getCapabilities') as Promise<
      | { ok: true; data: { defaultProvider: string; providers: Array<{ providerId: string; label: string; source: 'localFree' | 'userProvided' | 'cloudFree' | 'cloudPro'; granularity: '1m' | '5m'; historyDepthDays: number | null; coverage: 'allMarket' | 'selectedOnly' | 'unknown'; reliability: 'realtime' | 'cached' | 'approximate'; isApproximate: boolean; requiresCredential: boolean; isCloud: boolean; enabled: boolean; note: string }> } }
      | { ok: false; code: string; message: string }
    >,
    getBars: (payload: { userTier?: 'free' | 'pro'; purpose?: 'conditionBlocks' | 'chart' | 'backtest'; tsCode: string; tradeDate: string; preferredGranularity?: '1m' | '5m'; allowApproximate?: boolean }) =>
      ipcRenderer.invoke('minuteData:getBars', payload) as Promise<
        | { ok: true; data: { status: 'success' | 'empty' | 'failed' | 'unavailable'; bars: Array<{ tsCode: string; tradeDate: string; tsMinute: string; open: number | null; high: number | null; low: number | null; close: number; vol: number | null; amount: number | null }>; capability: { providerId: string; label: string; source: 'localFree' | 'userProvided' | 'cloudFree' | 'cloudPro'; granularity: '1m' | '5m'; isApproximate: boolean; isCloud: boolean; note: string }; coverageStatus?: 'complete' | 'partial' | 'empty' | 'unavailable'; qualityNote?: string; message?: string } }
        | { ok: false; code: 'INVALID_PARAM' | 'PROVIDER_UNAVAILABLE' | 'EMPTY_DATA' | 'UPSTREAM_ERROR'; message: string; data?: unknown }
      >,
    getCloudStatus: () => ipcRenderer.invoke('minuteData:getCloudStatus') as Promise<
      | { ok: true; data: { configured: boolean; signedIn: boolean; plan: string; capabilities: unknown[]; message: string } }
      | { ok: false; code: string; message: string }
    >,
    saveCloudConfig: (payload: { endpoint?: string; accessToken?: string }) =>
      ipcRenderer.invoke('minuteData:saveCloudConfig', payload) as Promise<{ ok: boolean; code?: string; message?: string }>,
  },

  // ── Backtest (FR-088) ─────────────────────────────────
  backtest: {
    getStartupSyncRequirement: () =>
      ipcRenderer.invoke('backtest:getStartupSyncRequirement') as Promise<{ required: boolean; stockCodes: string[] }>,
    syncIntraday: () =>
      ipcRenderer.invoke('backtest:syncIntraday') as Promise<{ synced: number; backtested: number }>,
    getIntradayCache: (stockCode: string, tradeDate: string) =>
      ipcRenderer.invoke('backtest:getIntradayCache', { stockCode, tradeDate }),
    runBacktest: (forecastId?: number) =>
      ipcRenderer.invoke('backtest:runBacktest', forecastId ? { forecastId } : {}) as Promise<{ processed: number }>,
    getStats: (filter?: string | { stockCode?: string; type?: 'today' | 'morrow' | 'all'; fromTargetDate?: string; toTargetDate?: string; portfolioOnly?: boolean }) => {
      const payload = typeof filter === 'string' ? { stockCode: filter } : (filter ?? {})
      return ipcRenderer.invoke('backtest:getStats', payload)
    },
    updateForecastOutcome: (payload: { forecastId: number; tag: 'valid' | 'invalid' | 'uncertain' | null; note?: string | null }) =>
      ipcRenderer.invoke('backtest:updateForecastOutcome', payload) as Promise<{ ok: boolean; error?: { code: string; message: string } }>
  },

  // ── Market Heatmap (FR-096/FR-114) ────────────────────
  marketHeatmap: {
    getSnapshot: () =>
      ipcRenderer.invoke('marketHeatmap:getSnapshot') as Promise<
        | {
            ok: true
            data: {
              updatedAt: string
              industries: Array<{
                name: string
                code?: string
                totalMarketCap: number
                weightedChange: number
                stocks: Array<{
                  code: string
                  name: string
                  price: number
                  change: number
                  marketCap: number
                }>
                subIndustries?: Array<{
                  code: string
                  name: string
                  price: number
                  change: number
                  marketCap: number
                }>
              }>
            }
          }
        | { ok: false; code: 'UPSTREAM_TIMEOUT' | 'UPSTREAM_ERROR' | 'EMPTY_DATA'; message: string }
      >,
    // FR-114: Hover 懒加载行业成分股
    getIndustryConstituents: (industryCode: string, industryName: string) =>
      ipcRenderer.invoke('marketHeatmap:getIndustryConstituents', { industryCode, industryName }) as Promise<
        | {
            ok: true
            data: Array<{
              code: string
              name: string
              price: number
              change: number
              marketCap: number
            }>
          }
        | {
            ok: false
            code: 'INVALID_PARAM' | 'UPSTREAM_TIMEOUT' | 'UPSTREAM_ERROR'
            message: string
          }
      >
  },

  conditionBlocks: {
    listTemplates: () =>
      ipcRenderer.invoke('conditionBlocks:listTemplates') as Promise<
        | { ok: true; templates: Array<{ id: number; templateKey: string; name: string; description: string | null; version: number; enabled: boolean; updatedAt: number; lastRunAt: number | null; lastMatchCount: number | null }> }
        | { ok: false; error: string; code: string }
      >,
    getTemplate: (id: number) =>
      ipcRenderer.invoke('conditionBlocks:getTemplate', { id }) as Promise<
        | { ok: true; template: BlockStrategyTemplate; row: unknown }
        | { ok: false; error: string; code: string }
      >,
    saveTemplate: (payload: { id?: number; template: BlockStrategyTemplate }) =>
      ipcRenderer.invoke('conditionBlocks:saveTemplate', payload) as Promise<
        | { ok: true; template: BlockStrategyTemplate; row: unknown }
        | { ok: false; error: string; code: string }
      >,
    runScan: (payload: { templateId: number; force?: boolean; scanMode?: 'complete' | 'quick'; userTier?: 'free' | 'pro'; scopeOverride?: { dateStart?: string; dateEnd?: string; dailyPrefilterLimit?: number | null; autoFetchMinuteLimit?: number | null } }) =>
      ipcRenderer.invoke('conditionBlocks:runScan', payload) as Promise<
        | { ok: true; runId: number; cached: boolean; matchedCount: number; totalStocks: number; summary: { scanMode: 'complete' | 'quick'; dateStart: string; dateEnd: string; totalStocks: number; dailyPrefilteredStocks: number; dailyCandidateStocks: number; minuteCompleteStocks: number; minuteIncompleteStocks: number; evaluatedStocks: number; unevaluatedStocks: number; minuteCacheHitGaps: number; minuteMissingGaps: number; minuteFetchAttempted: number; minuteFetchSucceeded: number; minuteFetchFailed: number; minuteFetchEmpty: number; minuteFetchSkippedByLimit: number; minuteFetchSkippedByFailureGuard: number; minuteFetchStoppedByFailureGuard: boolean; minuteUserTier?: 'free' | 'pro'; minuteDataProviderId: string; minuteDataProviderLabel: string; minuteGranularity: '1m' | '5m'; minuteDataSource: 'localFree' | 'userProvided' | 'cloudFree' | 'cloudPro'; minuteDataApproximate: boolean; minuteExactEvaluatedStocks: number; minuteApproxEvaluatedStocks: number; minuteDataQualityNote: string; stocksWithMinuteData: number; evaluatedTradeDays: number; minuteRows: number; matchedCount: number } }
        | { ok: false; error: string; code: string }
      >,
    cancelScan: () =>
      ipcRenderer.invoke('conditionBlocks:cancelScan') as Promise<
        | { ok: true; cancelled: true }
        | { ok: false; error: string; code: string }
      >,
    listMatches: (payload?: { templateKey?: string; runId?: number; limit?: number; offset?: number }) =>
      ipcRenderer.invoke('conditionBlocks:listMatches', payload ?? {}) as Promise<
        | { ok: true; matches: Array<{ id: number; runId: number; templateKey: string; templateVersion: number; tsCode: string; stockName: string | null; tradeDate: string; windowStart: string | null; windowEnd: string | null; totalScore: number; dataStatus: string; evidenceJson: string; createdAt: number }> }
        | { ok: false; error: string; code: string }
      >,
    getMatchEvidence: (id: number) =>
      ipcRenderer.invoke('conditionBlocks:getMatchEvidence', { id }) as Promise<
        | { ok: true; match: unknown; evidence: unknown }
        | { ok: false; error: string; code: string }
      >,
    onProgress: (cb: (progress: { stage: 'prepare' | 'prefilter' | 'minuteCheck' | 'minuteFetch' | 'evaluate' | 'save' | 'done' | 'failed'; current: number; total: number; message: string; stats?: Partial<{ scanMode: 'complete' | 'quick'; dateStart: string; dateEnd: string; totalStocks: number; dailyPrefilteredStocks: number; dailyCandidateStocks: number; minuteCompleteStocks: number; minuteIncompleteStocks: number; evaluatedStocks: number; unevaluatedStocks: number; minuteCacheHitGaps: number; minuteMissingGaps: number; minuteFetchAttempted: number; minuteFetchSucceeded: number; minuteFetchFailed: number; minuteFetchEmpty: number; minuteFetchSkippedByLimit: number; minuteFetchSkippedByFailureGuard: number; minuteFetchStoppedByFailureGuard: boolean; stocksWithMinuteData: number; evaluatedTradeDays: number; minuteRows: number; matchedCount: number }> }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { stage: 'prepare' | 'prefilter' | 'minuteCheck' | 'minuteFetch' | 'evaluate' | 'save' | 'done' | 'failed'; current: number; total: number; message: string; stats?: Partial<{ scanMode: 'complete' | 'quick'; dateStart: string; dateEnd: string; totalStocks: number; dailyPrefilteredStocks: number; dailyCandidateStocks: number; minuteCompleteStocks: number; minuteIncompleteStocks: number; evaluatedStocks: number; unevaluatedStocks: number; minuteCacheHitGaps: number; minuteMissingGaps: number; minuteFetchAttempted: number; minuteFetchSucceeded: number; minuteFetchFailed: number; minuteFetchEmpty: number; minuteFetchSkippedByLimit: number; minuteFetchSkippedByFailureGuard: number; minuteFetchStoppedByFailureGuard: boolean; stocksWithMinuteData: number; evaluatedTradeDays: number; minuteRows: number; matchedCount: number }> }) => cb(data)
      ipcRenderer.on('conditionBlocks:progress', handler)
      return () => { ipcRenderer.removeListener('conditionBlocks:progress', handler) }
    },
  },

  strategyBacktest: {
    evaluateSignals: (payload: { dateStart: string; dateEnd: string; strategyIds?: string[]; excludeUntradeable?: boolean }) =>
      ipcRenderer.invoke('strategyBacktest:evaluateSignals', payload) as Promise<
        | { ok: true; data: StrategyEffectivenessResult }
        | { ok: false; error: 'INVALID_PARAM' | 'EVALUATION_FAILED'; message: string }
      >,
    run: (payload: { signalSource?: StrategyBacktestSignalSource; strategyKey: string; dateStart: string; dateEnd: string; plan: StrategyBacktestTradePlan; force?: boolean }) =>
      ipcRenderer.invoke('strategyBacktest:run', payload) as Promise<
        | { ok: true; data: { runId: number; cached: boolean; report: StrategyBacktestReport } }
        | { ok: false; error: 'INVALID_PARAM' | 'BACKTEST_FAILED'; message: string }
      >,
    getReport: (runId: number) =>
      ipcRenderer.invoke('strategyBacktest:getReport', { runId }) as Promise<
        | { ok: true; data: { runId: number; report: StrategyBacktestReport; run: unknown } }
        | { ok: false; error: 'INVALID_PARAM' | 'NOT_FOUND' | 'RUN_NOT_COMPLETED' | 'INVALID_REPORT' | 'QUERY_FAILED'; message: string }
      >,
    listRuns: (strategyKey?: string, signalSource?: StrategyBacktestSignalSource) =>
      ipcRenderer.invoke('strategyBacktest:listRuns', { strategyKey, signalSource }) as Promise<
        | { ok: true; data: { runs: StrategyBacktestRunSummary[] } }
        | { ok: false; error: 'INVALID_PARAM' | 'QUERY_FAILED'; message: string }
      >,
    getTrades: (runId: number) =>
      ipcRenderer.invoke('strategyBacktest:getTrades', { runId }) as Promise<
        | { ok: true; data: { trades: StrategyBacktestTradeRow[] } }
        | { ok: false; error: 'INVALID_PARAM' | 'NOT_FOUND' | 'RUN_NOT_COMPLETED' | 'QUERY_FAILED'; message: string }
      >,
    deleteRun: (runId: number) =>
      ipcRenderer.invoke('strategyBacktest:deleteRun', { runId }) as Promise<
        | { ok: true; data: { runId: number } }
        | { ok: false; error: 'INVALID_PARAM' | 'NOT_FOUND' | 'DELETE_FAILED'; message: string }
      >,
    onProgress: (cb: (progress: StrategyBacktestProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: StrategyBacktestProgress) => cb(data)
      ipcRenderer.on('strategyBacktest:progress', handler)
      return () => {
        ipcRenderer.removeListener('strategyBacktest:progress', handler)
      }
    },
  },

  strategyLab: {
    listStrategies: () =>
      ipcRenderer.invoke('strategyLab:listStrategies') as Promise<
        | { ok: true; strategies: StrategyLabStrategySummary[] }
        | { ok: false; error: string; code: string }
      >,
    getStrategy: (id: number) =>
      ipcRenderer.invoke('strategyLab:getStrategy', { id }) as Promise<
        | { ok: true; strategy: StrategyLabStrategyDetail }
        | { ok: false; error: string; code: string }
      >,
    saveStrategy: (payload: SaveStrategyLabStrategyRequest) =>
      ipcRenderer.invoke('strategyLab:saveStrategy', payload) as Promise<
        | { ok: true; strategy: StrategyLabStrategyDetail }
        | { ok: false; error: string; code: string }
      >,
    duplicateStrategy: (id: number, name?: string) =>
      ipcRenderer.invoke('strategyLab:duplicateStrategy', { id, name }) as Promise<
        | { ok: true; strategy: StrategyLabStrategyDetail }
        | { ok: false; error: string; code: string }
      >,
    deleteStrategy: (id: number) =>
      ipcRenderer.invoke('strategyLab:deleteStrategy', { id }) as Promise<
        | { ok: true }
        | { ok: false; error: string; code: string }
      >,
    setStrategyEnabled: (id: number, enabled: boolean) =>
      ipcRenderer.invoke('strategyLab:setStrategyEnabled', { id, enabled }) as Promise<
        | { ok: true; strategy: StrategyLabStrategyDetail }
        | { ok: false; error: string; code: string }
      >,
    runStrategy: (strategyId: number) =>
      ipcRenderer.invoke('strategyLab:runStrategy', { strategyId }) as Promise<
        | { ok: true; runId: number; summary: unknown; matchedCount: number }
        | { ok: false; error: string; code: string }
      >,
    listRuns: (payload?: { strategyId?: number; limit?: number }) =>
      ipcRenderer.invoke('strategyLab:listRuns', payload ?? {}) as Promise<
        | { ok: true; runs: StrategyLabRunRow[] }
        | { ok: false; error: string; code: string }
      >,
    getRun: (runId: number) =>
      ipcRenderer.invoke('strategyLab:getRun', { runId }) as Promise<
        | { ok: true; run: StrategyLabRunRow }
        | { ok: false; error: string; code: string }
      >,
    listMatches: (payload?: { runId?: number; strategyId?: number; query?: string; source?: 'screener' | 'conditionBlocks' | 'custom'; minScore?: number; limit?: number; offset?: number }) =>
      ipcRenderer.invoke('strategyLab:listMatches', payload ?? {}) as Promise<
        | { ok: true; matches: StrategyLabMatchRow[] }
        | { ok: false; error: string; code: string }
      >,
    getMatchEvidence: (matchId: number) =>
      ipcRenderer.invoke('strategyLab:getMatchEvidence', { matchId }) as Promise<
        | { ok: true; match: StrategyLabMatchRow; evidence: unknown; action: unknown }
        | { ok: false; error: string; code: string }
      >,
    cancelRun: (runId?: number) =>
      ipcRenderer.invoke('strategyLab:cancelRun', { runId }) as Promise<
        | { ok: true; cancelled: true }
        | { ok: false; error: string; code: string }
      >,
    createBacktestFromRun: (runId: number, plan?: Partial<StrategyBacktestTradePlan>) =>
      ipcRenderer.invoke('strategyLab:createBacktestFromRun', { runId, plan }) as Promise<
        | { ok: true; backtestRunId: number; strategyKey: string }
        | { ok: false; error: string; code: string }
      >,
    onRunProgress: (cb: (progress: { runId: number; strategyId: number; stage: 'prepare' | 'screener' | 'conditionBlocks' | 'save' | 'done' | 'failed' | 'cancelled'; current: number; total: number; message: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { runId: number; strategyId: number; stage: 'prepare' | 'screener' | 'conditionBlocks' | 'save' | 'done' | 'failed' | 'cancelled'; current: number; total: number; message: string }) => cb(data)
      ipcRenderer.on('strategyLab:runProgress', handler)
      return () => {
        ipcRenderer.removeListener('strategyLab:runProgress', handler)
      }
    },
  },

  // ── FR-228 筹码结构工作台 ───────────────────────────────
  chipStructure: {
    listStocks: (payload: {
      source?: 'all' | 'watchlist' | 'screener' | 'morningAuction' | 'portfolio'
      mode?: 'relative' | 'absolute'
      status?: 'all' | 'complete' | 'partial' | 'blocked' | 'matched' | 'warning' | 'not_comparable'
      search?: string
      limit?: number
      offset?: number
    } = {}) => ipcRenderer.invoke('chipStructure:listStocks', payload) as Promise<
      | {
          ok: true
          stocks: Array<{
            tsCode: string
            stockName: string | null
            source: 'watchlist' | 'screener' | 'morningAuction' | 'portfolio'
            addedAt: number
            summary: ChipStructureSummary
          }>
          total: number
          statusCounts: {
            complete: number
            partial: number
            blocked: number
            consistencyWarning: number
            stale: number
          }
        }
      | { ok: false; error: { code: string; message: string } }
    >,
    getStockDetail: (payload: {
      tsCode: string
      tradeDate?: string
      mode?: 'relative' | 'absolute'
    }) => ipcRenderer.invoke('chipStructure:getStockDetail', payload) as Promise<
      | { ok: true; detail: ChipStructureDetail | null }
      | { ok: false; error: { code: string; message: string } }
    >,
    getSummaries: (payload: {
      tsCodes: string[]
      tradeDate?: string
      referenceTradeDate?: string
      selectionPolicy?: 'latest_fact' | 'latest_complete'
    }) =>
      ipcRenderer.invoke('chipStructure:getSummaries', payload) as Promise<
        | { ok: true; summaries: ChipStructureSummary[] }
        | { ok: false; error: { code: string; message: string } }
      >,
    refresh: (payload: {
      tsCodes?: string[]
      tradeDate?: string
      scope?: 'structure' | 'institution' | 'all'
      force?: boolean
    } = {}) => ipcRenderer.invoke('chipStructure:refresh', payload) as Promise<
      | { ok: true; started: true; taskId: string; total: number }
      | { ok: false; error: { code: string; message: string } }
    >,
    getSyncStatus: () => ipcRenderer.invoke('chipStructure:getSyncStatus') as Promise<{
      ok: true
      status: ChipStructureSyncStatus
      schedule: AfterCloseScheduleStatus
    }>,
    onProgress: (cb: (progress: ChipStructureProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: ChipStructureProgress) => cb(data)
      ipcRenderer.on('chipStructure:progress', handler)
      return () => { ipcRenderer.removeListener('chipStructure:progress', handler) }
    },
    onDone: (cb: (result: ChipStructureDone) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: ChipStructureDone) => cb(data)
      ipcRenderer.on('chipStructure:done', handler)
      return () => { ipcRenderer.removeListener('chipStructure:done', handler) }
    },
  },

  // ── FR-124 Short-term Strategy ─────────────────────────
  shortTerm: {
    getActiveSubTab: () =>
      ipcRenderer.invoke('shortTerm:getActiveSubTab') as Promise<{
        ok: true
        subTab:
          | 'morningAuction'
          | 'closingHalfHour'
          | 'limitBoardMonitor'
          | 'secondBoardLeader'
          | 'firstYinDip'
          | 'dipBuyRadar'
          | 'strategyLab'
          | 'personalScreener'
          | 'chipMonitor'
          | 'conditionBlocks'
          | 'strategyBacktest'
      }>,
    setActiveSubTab: (
      subTab:
        | 'morningAuction'
        | 'closingHalfHour'
        | 'limitBoardMonitor'
        | 'secondBoardLeader'
        | 'firstYinDip'
        | 'dipBuyRadar'
        | 'strategyLab'
        | 'personalScreener'
        | 'chipMonitor'
        | 'conditionBlocks'
        | 'strategyBacktest'
    ) =>
      ipcRenderer.invoke('shortTerm:setActiveSubTab', { subTab }) as Promise<
        { ok: true } | { ok: false; error: 'INVALID_PARAM' }
      >,
    syncDataNow: (task: 'afterCloseDaily' | 'topList' | 'conceptMembers' | 'dailyOHLCV' | 'stockBasic') =>
      ipcRenderer.invoke('shortTerm:syncDataNow', { task }) as Promise<
        { ok: true } | { ok: false; error: 'INVALID_PARAM' | 'TUSHARE_DISABLED' | 'SYNC_FAILED' }
      >,
    refreshRtKNow: () =>
      ipcRenderer.invoke('shortTerm:refreshRtKNow') as Promise<
        | { ok: true; skipped: boolean }
        | { ok: false; error: string; message?: string }
      >,
    getStockMiniKline: (tsCode: string) =>
      ipcRenderer.invoke('shortTerm:getStockMiniKline', { tsCode }) as Promise<
        | { ok: true; rows: Array<{ tsCode: string; tradeDate: string; open: number | null; high: number | null; low: number | null; close: number; pctChg: number; amount: number | null }> }
        | { ok: false; error: string }
      >,
    getStockIntraday: (tsCode: string) =>
      ipcRenderer.invoke('shortTerm:getStockIntraday', { tsCode }) as Promise<
        | { ok: true; rows: Array<{ stockCode: string; tradeDate: string; tsMinute: string; open: number | null; high: number | null; low: number | null; close: number | null; vol: number | null; amount: number | null; fetchedAt: number }> }
        | { ok: false; error: string }
      >,
    getStockChips: (tsCode: string, tradeDate?: string) =>
      ipcRenderer.invoke('shortTerm:getStockChips', { tsCode, tradeDate }) as Promise<
        | { ok: true; data: Array<{ price: number; percent: number }> }
        | { ok: false; code: string }
      >,
    getStockFactor: (tsCode: string, tradeDate?: string) =>
      ipcRenderer.invoke('shortTerm:getStockFactor', { tsCode, tradeDate }) as Promise<
        | {
            ok: true
            data: {
              tsCode: string; tradeDate: string; close: number | null
              macdBfq: number | null; macdDifBfq: number | null; macdDeaBfq: number | null
              kdjKBfq: number | null; kdjDBfq: number | null; kdjBfq: number | null
              rsiBfq6: number | null; rsiBfq12: number | null
              bollUpperBfq: number | null; bollMidBfq: number | null; bollLowerBfq: number | null
              maBfq5: number | null; maBfq10: number | null; maBfq20: number | null; maBfq60: number | null
              turnoverRate: number | null; volumeRatio: number | null
              updays: number | null; downdays: number | null
            }
          }
        | { ok: false; code: string }
      >,
    getStockFactorHistory: (tsCode: string, startDate: string, dbOnly = false) =>
      ipcRenderer.invoke('shortTerm:getStockFactorHistory', { tsCode, startDate, dbOnly }) as Promise<
        | {
            ok: true
            data: Array<{
              tsCode: string; tradeDate: string; close: number | null
              macdBfq: number | null; macdDifBfq: number | null; macdDeaBfq: number | null
              kdjKBfq: number | null; kdjDBfq: number | null; kdjBfq: number | null
              rsiBfq6: number | null; rsiBfq12: number | null
              bollUpperBfq: number | null; bollMidBfq: number | null; bollLowerBfq: number | null
              maBfq5: number | null; maBfq10: number | null; maBfq20: number | null; maBfq60: number | null
              turnoverRate: number | null; volumeRatio: number | null
              updays: number | null; downdays: number | null
            }>
          }
        | { ok: false; code: string }
      >,
    morningAuction: {
      get: (tradeDate?: string) =>
        ipcRenderer.invoke('shortTerm:morningAuction:get', { tradeDate }) as Promise<{
          ok: true
          snapshot: MorningAuctionSnapshot
          tradeDateStatus: MorningAuctionTradeDateStatus
          insightStatus: MorningAuctionInsightStatusSummary
        }>,
      refresh: (tradeDate?: string) =>
        ipcRenderer.invoke('shortTerm:morningAuction:refresh', { tradeDate }) as Promise<{
          ok: true
          snapshot: MorningAuctionSnapshot
          tradeDateStatus: MorningAuctionTradeDateStatus
          insightStatus: MorningAuctionInsightStatusSummary
        }>,
      generateInsights: (payload: { tradeDate: string; tsCode?: string; poolKey?: string; force?: boolean }) =>
        ipcRenderer.invoke('shortTerm:morningAuction:generateInsights', payload) as Promise<
          | { ok: true; tradeDate: string; generatedCount: number; failedCount: number; insights: MorningAuctionInsight[] }
          | { ok: false; error: { code: string; message: string; details?: string; recommendedTradeDate?: string | null } }
        >,
      getInsight: (payload: { tradeDate: string; tsCode: string; poolKey: string }) =>
        ipcRenderer.invoke('shortTerm:morningAuction:getInsight', payload) as Promise<
          | { ok: true; insight: MorningAuctionInsight | null }
          | { ok: false; error: { code: string; message: string } }
        >,
      updateVerification: (payload: {
        tradeDate: string; tsCode: string; poolKey: string; itemKey: string
        status: MorningAuctionVerificationStatus; reason?: string
      }) => ipcRenderer.invoke('shortTerm:morningAuction:updateVerification', payload) as Promise<
        | { ok: true; insight: MorningAuctionInsight }
        | { ok: false; error: { code: string; message: string } }
      >
    },
    closingHalfHour: {
      get: (tradeDate?: string) =>
        ipcRenderer.invoke('shortTerm:closingHalfHour:get', { tradeDate }) as Promise<{
          ok: true
          snapshot: ClosingHalfHourSnapshot
        }>,
      refresh: (tradeDate?: string) =>
        ipcRenderer.invoke('shortTerm:closingHalfHour:refresh', { tradeDate }) as Promise<{
          ok: true
          snapshot: ClosingHalfHourSnapshot
        }>
    },
    limitBoardMonitor: {
      get: (tradeDate?: string) =>
        ipcRenderer.invoke('shortTerm:limitBoardMonitor:get', { tradeDate }) as Promise<{
          ok: true
          snapshot: LimitBoardSnapshot
        }>,
      refresh: (tradeDate?: string) =>
        ipcRenderer.invoke('shortTerm:limitBoardMonitor:refresh', { tradeDate }) as Promise<{
          ok: true
          snapshot: LimitBoardSnapshot
        }>
    },
    secondBoardLeader: {
      get: (tradeDate?: string) =>
        ipcRenderer.invoke('shortTerm:secondBoardLeader:get', { tradeDate }) as Promise<{
          ok: true
          snapshot: SecondBoardSnapshot
        }>,
      refresh: (tradeDate?: string) =>
        ipcRenderer.invoke('shortTerm:secondBoardLeader:refresh', { tradeDate }) as Promise<{
          ok: true
          snapshot: SecondBoardSnapshot
        }>
    },
    firstYinDip: {
      get: (tradeDate?: string) =>
        ipcRenderer.invoke('shortTerm:firstYinDip:get', { tradeDate }) as Promise<{
          ok: true
          snapshot: FirstYinSnapshot
        }>,
      refresh: (tradeDate?: string) =>
        ipcRenderer.invoke('shortTerm:firstYinDip:refresh', { tradeDate }) as Promise<{
          ok: true
          snapshot: FirstYinSnapshot
        }>
    },
    dipBuyRadar: {
      get: (tradeDate?: string) =>
        ipcRenderer.invoke('shortTerm:dipBuyRadar:get', { tradeDate }) as Promise<{
          ok: true
          snapshot: DipBuyRadarSnapshot
        }>,
      refresh: (tradeDate?: string) =>
        ipcRenderer.invoke('shortTerm:dipBuyRadar:refresh', { tradeDate }) as Promise<{
          ok: true
          snapshot: DipBuyRadarSnapshot
        }>
    },
    screener: {
      get: (tradeDate?: string) =>
        ipcRenderer.invoke('shortTerm:screener:get', { tradeDate }) as Promise<
          | { ok: true; snapshot: ScreenerSnapshot }
          | { ok: false; error: string; code: string }
        >,
      run: (tradeDate?: string) =>
        ipcRenderer.invoke('shortTerm:screener:run', { tradeDate }) as Promise<
          | { ok: true; snapshot: ScreenerSnapshot }
          | { ok: false; error: string; code: string }
        >,
      getRankConfig: () =>
        ipcRenderer.invoke('shortTerm:screener:getRankConfig') as Promise<
          | { ok: true; config: ScreenerRankConfig }
          | { ok: false; error: string; code: string }
        >,
      saveRankConfig: (payload: Partial<ScreenerRankConfig>) =>
        ipcRenderer.invoke('shortTerm:screener:saveRankConfig', payload) as Promise<
          | { ok: true; config: ScreenerRankConfig }
          | { ok: false; error: string; code: string }
        >,
      resetRankConfig: () =>
        ipcRenderer.invoke('shortTerm:screener:resetRankConfig') as Promise<
          | { ok: true; config: ScreenerRankConfig }
          | { ok: false; error: string; code: string }
        >,
      getInsight: (payload: { tradeDate?: string; tsCode: string; forceRefresh?: boolean }) =>
        ipcRenderer.invoke('shortTerm:screener:getInsight', payload) as Promise<
          | { ok: true; insight: ScreenerInsight }
          | { ok: false; error: string; code: string }
        >,
      batchInsight: (payload?: { tradeDate?: string; tsCodes?: string[]; limit?: number; forceRefresh?: boolean }) =>
        ipcRenderer.invoke('shortTerm:screener:batchInsight', payload ?? {}) as Promise<
          | { ok: true; results: ScreenerInsight[]; errors: { tsCode: string; error: string }[] }
          | { ok: false; error: string; code: string }
        >,
      onInsightProgress: (cb: (p: { current: number; total: number; tsCode: string; status: 'running' | 'done' | 'failed'; error?: string }) => void) => {
        const listener = (_: Electron.IpcRendererEvent, p: { current: number; total: number; tsCode: string; status: 'running' | 'done' | 'failed'; error?: string }) => cb(p)
        ipcRenderer.on('shortTerm:screener:insightProgress', listener)
        return () => { ipcRenderer.removeListener('shortTerm:screener:insightProgress', listener) }
      },
      /**
       * 全量补查题材（5 路并发按股票代码查 kpl_concept_cons）
       * 调用后通过 onSyncConceptsProgress / onSyncConceptsDone 监听进度
       */
      syncAllConcepts: () =>
        ipcRenderer.invoke('shortTerm:screener:syncAllConcepts') as Promise<
          | { ok: true; inserted: number; total: number }
          | { ok: false; error: string; code?: string }
        >,
      /**
       * 监听全量题材同步进度推送，返回清理函数
       */
      onSyncConceptsProgress: (cb: (p: { done: number; total: number }) => void) => {
        const listener = (_: Electron.IpcRendererEvent, p: { done: number; total: number }) => cb(p)
        ipcRenderer.on('shortTerm:screener:syncConcepts:progress', listener)
        return () => { ipcRenderer.removeListener('shortTerm:screener:syncConcepts:progress', listener) }
      },
      /**
       * 监听全量题材同步完成事件，返回清理函数
       */
      onSyncConceptsDone: (cb: (r: { inserted: number; total: number }) => void) => {
        const listener = (_: Electron.IpcRendererEvent, r: { inserted: number; total: number }) => cb(r)
        ipcRenderer.on('shortTerm:screener:syncConcepts:done', listener)
        return () => { ipcRenderer.removeListener('shortTerm:screener:syncConcepts:done', listener) }
      }
    },
    /**
     * 初始化历史日线数据（目标 480 个交易日，已有完整交易日自动跳过）
     * 调用后通过 onInitDailyDataProgress / onInitDailyDataDone 监听进度
     */
    initDailyData: () =>
      ipcRenderer.invoke('shortTerm:initDailyData') as Promise<
        | { ok: true }
        | { ok: false; error: string; code?: string }
      >,
    /**
     * 监听初始化进度推送，返回清理函数
     */
    onInitDailyDataProgress: (
      cb: (p: { done: number; total: number; date: string }) => void
    ) => {
      const listener = (_: Electron.IpcRendererEvent, p: { done: number; total: number; date: string }) => cb(p)
      ipcRenderer.on('shortTerm:initDailyData:progress', listener)
      return () => { ipcRenderer.removeListener('shortTerm:initDailyData:progress', listener) }
    },
    /**
     * 监听初始化完成事件，返回清理函数
     */
    onInitDailyDataDone: (cb: () => void) => {
      ipcRenderer.on('shortTerm:initDailyData:done', cb)
      return () => { ipcRenderer.removeListener('shortTerm:initDailyData:done', cb) }
    },
    // FR-153: 题材数据源切换
    getConceptSource: () =>
      ipcRenderer.invoke('shortTerm:getConceptSource') as Promise<
        { ok: true; source: 'kpl' | 'ths' | 'dc' }
      >,
    setConceptSource: (source: 'kpl' | 'ths' | 'dc') =>
      ipcRenderer.invoke('shortTerm:setConceptSource', { source }) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    syncConceptMembers: (source: string) =>
      ipcRenderer.invoke('shortTerm:syncConceptMembers', { source }) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    getConceptDataStatus: () =>
      ipcRenderer.invoke('shortTerm:getConceptDataStatus') as Promise<
        { ok: true; thsCount: number; thsSyncedAt: number | null; dcHasData: boolean }
      >,
    onConceptSyncProgress: (cb: (p: { source: string; current: number; total: number; message: string }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, p: { source: string; current: number; total: number; message: string }) => cb(p)
      ipcRenderer.on('shortTerm:conceptSyncProgress', handler)
      return () => { ipcRenderer.removeListener('shortTerm:conceptSyncProgress', handler) }
    },
    /** 临时诊断：查 ths_concept_members 表数据格式，可在 DevTools console 调用 */
    diagnoseThs: (tsCode?: string) =>
      ipcRenderer.invoke('shortTerm:diagnoseThs', { tsCode }) as Promise<{
        ok: true; total: number
        samples: Array<{ ts_code: string; con_code: string; con_name: string | null }>
        stockFmt: number; conceptFmt: number
        conceptSource: string; testCode: string
        routedResult: Array<{ conceptCode: string; conceptName: string }>
      }>,
    /** 查询单只股票所属题材名称列表（供走势图展示，最多 8 个） */
    getStockConcepts: (tsCode: string) =>
      ipcRenderer.invoke('shortTerm:getStockConcepts', { tsCode }) as Promise<
        { ok: true; names: string[] } | { ok: false; error: string }
      >,

    // ── FR-156 筹码监控 ──────────────────────────────────
    chipMonitorStart: (payload?: {
      stocks?: { tsCode: string; stockName: string | null; source: 'screener' | 'watchlist' | 'morningAuction' | 'portfolio' }[]
      mode?: 'relative' | 'absolute'
      source?: 'screener' | 'watchlist' | 'morningAuction' | 'portfolio'
    }) =>
      ipcRenderer.invoke('shortTerm:chipMonitor:start', payload) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    chipMonitorGetStocks: () =>
      ipcRenderer.invoke('shortTerm:chipMonitor:getStocks') as Promise<{
        ok: true
        stocks: Array<{
          tsCode: string; source: 'watchlist' | 'screener' | 'morningAuction' | 'portfolio'
          stockName: string | null; addedAt: number
        }>
      }>,
    chipMonitorGetResults: (payload?: { mode?: 'relative' | 'absolute' }) =>
      ipcRenderer.invoke('shortTerm:chipMonitor:getResults', payload) as Promise<{
        ok: true
        results: Array<{
          tsCode: string; source?: 'watchlist' | 'screener' | 'morningAuction' | 'portfolio' | null
          stockName?: string | null
          tradeDate: string
          mode?: 'relative' | 'absolute'
          bottomPct: number | null; bottomAvgCost: number | null
          loosening1d: number | null; loosening3d: number | null; loosening5d: number | null
          loosening1dReason?: 'INSUFFICIENT_HISTORY' | 'LOW_BASE_PCT' | null
          loosening3dReason?: 'INSUFFICIENT_HISTORY' | 'LOW_BASE_PCT' | null
          loosening5dReason?: 'INSUFFICIENT_HISTORY' | 'LOW_BASE_PCT' | null
          updatedAt: number
          pctChg: number | null; turnoverRate: number | null; currentPrice: number | null
        }>
      }>,
    chipMonitorSyncWatchlist: (payload: { stocks: { tsCode: string; stockName: string | null }[] }) =>
      ipcRenderer.invoke('shortTerm:chipMonitor:syncWatchlist', payload) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    chipMonitorSyncPortfolio: () =>
      ipcRenderer.invoke('shortTerm:chipMonitor:syncPortfolio') as Promise<
        { ok: true; count: number } | { ok: false; error: string }
      >,
    /** 仅用 DB 现有数据重算筹码指标，不拉 API，适合切换计算模式时立即刷新 */
    chipMonitorRecompute: (payload?: { mode?: 'relative' | 'absolute' }) =>
      ipcRenderer.invoke('shortTerm:chipMonitor:recompute', payload) as Promise<
        { ok: true; success: number; failed: number }
      >,
    onChipMonitorProgress: (
      cb: (p: { done: number; total: number; currentStock: string }) => void
    ) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        p: { done: number; total: number; currentStock: string }
      ) => cb(p)
      ipcRenderer.on('shortTerm:chipMonitor:progress', handler)
      return () => { ipcRenderer.removeListener('shortTerm:chipMonitor:progress', handler) }
    },
    onChipMonitorDone: (cb: (p: { success: number; failed: number }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, p: { success: number; failed: number }) =>
        cb(p)
      ipcRenderer.on('shortTerm:chipMonitor:done', handler)
      return () => { ipcRenderer.removeListener('shortTerm:chipMonitor:done', handler) }
    },

    // ── FR-159 竞价回测 ─────────────────────────────────
    /** 触发回测同步（fire-and-forget，防重入） */
    backtestRun: (payload?: { days?: number; force?: boolean }) =>
      ipcRenderer.invoke('shortTerm:backtest:run', payload) as Promise<
        { ok: true } | { ok: false; error: 'TUSHARE_DISABLED' | 'JOB_RUNNING' }
      >,
    /** 查询运行状态和已有回测日期列表 */
    backtestGetStatus: () =>
      ipcRenderer.invoke('shortTerm:backtest:getStatus') as Promise<{
        ok: true
        running: boolean
        computedDates: string[]
        availableDates: string[]
        latestCloseTradeDate: string | null
      }>,
    /** 按日期范围查回测明细 */
    backtestGetDetails: (startDate: string, endDate: string) =>
      ipcRenderer.invoke('shortTerm:backtest:getDetails', { startDate, endDate }) as Promise<
        | {
            ok: true
            details: Array<{
              tradeDate: string
              tsCode: string
              stockName?: string | null
              pool: 'firstBoard' | 'secondBoard' | 'brokenBoard' | 'brokenConsec' | 'allMarket'
              buyPrice: number | null
              ret1d: number | null
              ret2d: number | null
              ret3d: number | null
              ret5d: number | null
              computedAt: number | null
              isOneWord: number
              // FR-163: 对应基准指数同期涨幅
              idxTodayPct?: number | null
              idxRet1d?: number | null
              idxRet2d?: number | null
              idxRet3d?: number | null
              idxRet5d?: number | null
            }>
          }
        | { ok: false; error: 'INVALID_PARAM' }
      >,
    /** 监听回测进度推送事件，返回清理函数 */
    onBacktestProgress: (cb: (p: { pct: number; message: string }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, p: { pct: number; message: string }) =>
        cb(p)
      ipcRenderer.on('shortTerm:backtest:progress', handler)
      return () => { ipcRenderer.removeListener('shortTerm:backtest:progress', handler) }
    },
  },

  // ── Diagnostics (FR-192) ──────────────────────────────
  diagnostics: {
    getHealth: () => ipcRenderer.invoke('diagnostics:getHealth') as Promise<
      | {
          ok: true
          data: {
            status: 'ok' | 'warning' | 'error'
            checkedAt: number
            summary: Record<'ok' | 'warning' | 'error', number>
            dailyCloseQuality?: {
              targetTradeDays: number
              retentionTradeDays: number
              actualTradeDays: number
              totalRows: number
              earliestTradeDate: string | null
              latestTradeDate: string | null
              fields: Record<'open' | 'high' | 'low' | 'close' | 'pctChg' | 'vol' | 'turnoverRate', {
                missingRows: number
                missingRate: number | null
              }>
              cleanup: {
                status: 'never' | 'running' | 'success' | 'failed'
                startedAt: number | null
                completedAt: number | null
                retainTradeDays: number | null
                removedRows: number | null
                remainingTradeDays: number | null
                message: string | null
              }
            }
            dataQuality?: {
              status: 'reliable' | 'degraded' | 'blocked'
              checkedAt: number
              fingerprint: string
              persistedRunId: number | null
              persistedAt: number | null
              summary: Record<'reliable' | 'degraded' | 'blocked', number>
              datasets: Array<{
                key: 'stockBasic' | 'tradeCalendar' | 'dailyMarket' | 'auction' | 'benchmarks' | 'financials'
                title: string
                status: 'reliable' | 'degraded' | 'blocked'
                summary: string
                recordCount: number
                earliestDate: string | null
                latestDate: string | null
                sourceLabel: string
                affectedModules: string[]
                reasons: Array<{ code: string; message: string; severity: 'warning' | 'error' }>
                action: null | {
                  key: 'syncStockBasic' | 'syncTradeCalendar' | 'syncHistoricalDaily' | 'syncMarketBenchmarks'
                  label: string
                }
              }>
            }
            groups: Array<{
              key: 'config' | 'freshness' | 'sync' | 'database'
              title: string
              items: Array<{
                key: string
                title: string
                status: 'ok' | 'warning' | 'error'
                message: string
                detail?: string
                recordCount?: number | null
                latestDate?: string | null
                checkedAt: number
                actions?: Array<{
                  key: 'open-datasource' | 'open-ai-config' | 'syncStockBasic' | 'syncHistoricalDaily' | 'syncConceptMembers' | 'backfillDecisionSignals'
                  label: string
                  kind: 'navigate' | 'run'
                }>
              }>
            }>
          }
        }
      | { ok: false; error: string; message: string }
    >,
    runCheck: (action: 'refreshHealth' | 'refreshDataQuality' | 'syncStockBasic' | 'syncTradeCalendar' | 'syncHistoricalDaily' | 'syncMarketBenchmarks' | 'syncConceptMembers' | 'backfillDecisionSignals') =>
      ipcRenderer.invoke('diagnostics:runCheck', { action }) as Promise<
        | { ok: true; data: { action: string; status: 'completed' | 'started'; message: string } }
        | { ok: false; error: string; message: string }
      >,
    onHistoricalDailyProgress: (cb: (p: {
      totalTradeDays: number
      processedTradeDays: number
      skippedTradeDays: number
      syncedTradeDays: number
      failedTradeDays: number
      currentTradeDate: string | null
      insertedRows: number
      message: string
    }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, p: {
        totalTradeDays: number
        processedTradeDays: number
        skippedTradeDays: number
        syncedTradeDays: number
        failedTradeDays: number
        currentTradeDate: string | null
        insertedRows: number
        message: string
      }) => cb(p)
      ipcRenderer.on('diagnostics:historicalDailyProgress', handler)
      return () => { ipcRenderer.removeListener('diagnostics:historicalDailyProgress', handler) }
    }
  },

  // FR-248: AI 研判评测集
  aiEvaluation: {
    getWorkbench: () => ipcRenderer.invoke('aiEvaluation:getWorkbench') as Promise<
      | {
          ok: true
          data: {
            suite: {
              id: string
              version: string
              fingerprint: string
              callCount: number
              cases: Array<{
                id: string
                title: string
                kind: 'round1' | 'round2'
                purpose: string
              }>
              dimensionWeights: Record<'candidateMapping' | 'directionAccuracy' | 'evidenceDiscipline' | 'marketGrounding' | 'compliance', number>
            }
            targets: AiEvaluationConfiguredTarget[]
            activeRun: AiEvaluationRunRecord | null
            runs: AiEvaluationRunRecord[]
          }
        }
      | { ok: false; error: string; message: string }
    >,
    startRun: (provider: string) => ipcRenderer.invoke('aiEvaluation:startRun', { provider }) as Promise<
      | { ok: true; data: { runId: number; status: 'running'; totalCases: number } }
      | { ok: false; error: string; message: string }
    >,
    getRun: (runId: number) => ipcRenderer.invoke('aiEvaluation:getRun', { runId }) as Promise<
      | { ok: true; data: AiEvaluationRunDetail & { cases: AiEvaluationCaseResultRecord[] } }
      | { ok: false; error: string; message: string }
    >,
  },

  // ── Data Safety (FR-196) ─────────────────────────────
  dataSafety: {
    getStatus: () => ipcRenderer.invoke('dataSafety:getStatus') as Promise<
      | {
          ok: true
          data: {
            status: 'ok' | 'warning' | 'error'
            checkedAt: number
            databasePath: string
            databaseSizeBytes: number | null
            backupDirectory: string
            latestBackupAt: number | null
            backupCount: number
            migrationVersion: number | null
            issues: Array<{ level: 'ok' | 'warning' | 'error'; message: string }>
          }
        }
      | { ok: false; error: string; message: string }
    >,
    createBackup: () => ipcRenderer.invoke('dataSafety:createBackup') as Promise<
      | { ok: true; data: { backupPath: string; backupSizeBytes: number; createdAt: number; deletedOldBackups: number; message: string } }
      | { ok: false; error: string; message: string }
    >,
    openBackupDirectory: () => ipcRenderer.invoke('dataSafety:openBackupDirectory') as Promise<
      | { ok: true; data: { backupDirectory: string } }
      | { ok: false; error: string; message: string }
    >,
    exportData: (scope: 'all' | 'portfolio' | 'forecasts' | 'decisionSignals' | 'settingsSummary') =>
      ipcRenderer.invoke('dataSafety:exportData', { scope }) as Promise<
        | { ok: true; data: { exportPath: string; scope: string; recordCounts: Record<string, number>; createdAt: number; message: string } }
        | { ok: false; error: string; message: string }
      >
  },

  baseDataPackage: {
    exportDailyBase: () => ipcRenderer.invoke('baseDataPackage:exportDailyBase') as Promise<
      | { ok: true; data: { filePath: string; createdAt: number; fileSizeBytes: number; manifest: BaseDataPackageManifest; message: string } }
      | { ok: false; error: string; message: string }
    >,
    previewImport: (filePath?: string) => ipcRenderer.invoke('baseDataPackage:previewImport', { filePath }) as Promise<
      | { ok: true; data: { filePath: string; compatible: boolean; warnings: string[]; manifest: BaseDataPackageManifest } }
      | { ok: false; error: string; message: string }
    >,
    importDailyBase: (filePath: string) => ipcRenderer.invoke('baseDataPackage:importDailyBase', { filePath }) as Promise<
      | { ok: true; data: { importedAt: number; filePath: string; recordCounts: Record<string, number>; message: string } }
      | { ok: false; error: string; message: string }
    >
  },

  // ── Market Overview ────────────────────────────────────
  market: {
    getMarketOverview: (forceRefresh?: boolean) =>
      ipcRenderer.invoke('market:getMarketOverview', { forceRefresh }) as Promise<
        | {
            ok: true
            snapshot: {
              distribution: { label: string; count: number; isPositive: boolean | null }[]
              timeline: { time: string; limitUp: number; limitDown: number }[]
              conceptHeat: {
                conCode: string
                conName: string
                memberCount: number
                avgChange: number
                limitUpCount: number
                limitDownCount: number
              }[]
              generatedAt: number
              isHistorical?: boolean
              tradeDate?: string
              resonance: {
                tradeDate: string
                dataMode: 'realtime' | 'archive' | 'partial'
                sourceLabel: string
                generatedAt: number
                coverage: { available: number; total: number }
                benchmarks: Array<{
                  key: 'shanghai' | 'csi300' | 'chinext'
                  code: string
                  name: string
                  tradeDate: string
                  change: number
                  points: Array<{ time: string; change: number }>
                }>
                sectors: Array<{
                  boardCode: string
                  code: string
                  name: string
                  tradeDate: string
                  change: number
                  points: Array<{ time: string; change: number }>
                  breadthRate: number | null
                  upCount: number | null
                  downCount: number | null
                  flatCount: number | null
                  mainNetInflow: number | null
                  mainNetInflowRate: number | null
                  metrics: Record<'shanghai' | 'csi300' | 'chinext', {
                    sampleCount: number
                    correlation: number | null
                    directionAgreement: number | null
                    recentAgreement: number | null
                    excessReturn: number
                    sectorReturn: number
                    benchmarkReturn: number
                    lagMinutes: number | null
                    score: number
                    state: 'leading_sync' | 'synchronized' | 'falling_sync' | 'defensive' | 'lagging' | 'diverging' | 'weak' | 'insufficient'
                  }>
                }>
              }
            }
          }
        | { ok: false; code: string; error: string }
      >,
    getConceptConstituents: (conCode: string) =>
      ipcRenderer.invoke('market:getConceptConstituents', { conCode }) as Promise<
        | {
            ok: true
            members: {
              tsCode: string
              stockCode: string
              name: string
              change: number
              price: number
            }[]
          }
        | { ok: false; error: string; code: string }
      >
  },

  // ── Sector Flow ────────────────────────────────────────
  sectorFlow: {
    getSnapshot: (forceRefresh?: boolean) =>
      ipcRenderer.invoke('sectorFlow:getSnapshot', { forceRefresh }) as Promise<
        | {
            ok: true
            snapshot: {
              items: {
                boardCode: string
                boardName: string
                scope: 'concept' | 'industry'
                metricMode: 'verified_flow' | 'turnover_strength'
                totalAmount: number
                turnoverDirectionStrength: number | null
                mainNetInflow: number | null
                mainNetInflowRate: number | null
                superLargeNetInflow: number | null
                superLargeNetInflowRate: number | null
                largeNetInflow: number | null
                largeNetInflowRate: number | null
                mediumNetInflow: number | null
                mediumNetInflowRate: number | null
                smallNetInflow: number | null
                smallNetInflowRate: number | null
                weightedChange: number
                totalMarketCap: number | null
                memberCount: number
                upCount: number
                downCount: number
                flatCount: number
                previousMainNetInflow: number | null
                leader: {
                  tsCode: string; name: string; change: number; totalAmount: number | null
                  mainNetInflow: number | null; mainNetInflowRate: number | null
                } | null
                coreStocks: {
                  tsCode: string; name: string; change: number; totalAmount: number | null
                  mainNetInflow: number | null; mainNetInflowRate: number | null
                }[]
                relatedThemes: { boardCode: string; boardName: string }[]
                sourceUpdatedAt: number | null
              }[]
              guidance: {
                stance: 'focus' | 'selective' | 'defensive' | 'insufficient'
                confidence: number
                summary: string
                focusThemes: {
                  boardCode: string; boardName: string; scope: 'concept' | 'industry'
                  state: 'continuation' | 'rotation' | 'divergence' | 'retreat' | 'insufficient'
                  score: number; confidence: number; mainNetInflow: number; mainNetInflowRate: number | null
                  previousMainNetInflow: number | null; weightedChange: number; breadthRate: number | null
                  reason: string
                  coreStocks: {
                    tsCode: string; name: string; change: number; totalAmount: number | null
                    mainNetInflow: number | null; mainNetInflowRate: number | null
                  }[]
                  relatedThemes: { boardCode: string; boardName: string }[]
                  confirmations: string[]; invalidations: string[]
                }[]
                riskThemes: {
                  boardCode: string; boardName: string; scope: 'concept' | 'industry'
                  state: 'continuation' | 'rotation' | 'divergence' | 'retreat' | 'insufficient'
                  score: number; confidence: number; mainNetInflow: number; mainNetInflowRate: number | null
                  previousMainNetInflow: number | null; weightedChange: number; breadthRate: number | null
                  reason: string
                  coreStocks: {
                    tsCode: string; name: string; change: number; totalAmount: number | null
                    mainNetInflow: number | null; mainNetInflowRate: number | null
                  }[]
                  relatedThemes: { boardCode: string; boardName: string }[]
                  confirmations: string[]; invalidations: string[]
                }[]
              }
              tradeDate: string | null
              updatedAt: string
              capturedAt: number
              dataMode: 'realtime' | 'archive' | 'degraded' | 'empty'
              metricMode: 'verified_flow' | 'turnover_strength'
              provider: 'eastmoney' | 'local_estimate'
              sourceLabel: string
              quality: {
                isVerified: boolean
                partialScopes: Array<'concept' | 'industry'>
                archived: boolean
                message: string
              }
            }
          }
        | { ok: false; error: string; message?: string }
      >,
    getConceptSource: () =>
      ipcRenderer.invoke('sectorFlow:getConceptSource') as Promise<
        | { ok: true; source: 'kpl' | 'ths' | 'dc' }
        | { ok: false; error: string }
      >,
    setConceptSource: (source: 'kpl' | 'ths' | 'dc') =>
      ipcRenderer.invoke('sectorFlow:setConceptSource', { source }) as Promise<
        | { ok: true }
        | { ok: false; error: string; code?: string }
      >,
  },

  // ── Trade Calendar (FR-162) ───────────────────────────
  tradeCal: {
    /** 强制全量同步交易日历 */
    sync: () =>
      ipcRenderer.invoke('tradeCal:sync') as Promise<
        { ok: true } | { ok: false; code: string; message: string }
      >,
    /**
     * 查询近 n 个交易日（升序 YYYYMMDD 数组）。
     * trade_cal 表为空时返回 []，前端需 fallback 到旧逻辑。
     */
    getLastNTradingDays: (n: number, beforeDate?: string) =>
      ipcRenderer.invoke('tradeCal:getLastNTradingDays', { n, beforeDate }) as Promise<string[]>,
  },

  // ── FR-164: 长线趋势 Watchlist ──────────────────────────
  trend: {
    getWatchList: () =>
      ipcRenderer.invoke('trend:getWatchList') as Promise<{
        ok: boolean
        data?: Array<{
          tsCode: string
          stockName: string
          groupTag: string
          addedAt: number
          category: string
          subCategory: string
          notes: string
        }>
        error?: string
        message?: string
      }>,
    addStocks: (
      stocks: Array<{
        tsCode: string
        stockName: string
        groupTag?: string
        category?: string
        subCategory?: string
      }>
    ) =>
      ipcRenderer.invoke('trend:addStocks', stocks) as Promise<{
        ok: boolean; count?: number; error?: string; message?: string
      }>,
    searchStocks: (keyword: string) =>
      ipcRenderer.invoke('trend:searchStocks', keyword) as Promise<{
        ok: boolean
        data?: Array<{ tsCode: string; name: string }>
        error?: string
      }>,
    removeStock: ({ tsCode, subCategory }: { tsCode: string; subCategory?: string }) =>
      ipcRenderer.invoke('trend:removeStock', { tsCode, subCategory }) as Promise<{
        ok: boolean; error?: string
      }>,
    updateGroupTag: (tsCode: string, groupTag: string) =>
      ipcRenderer.invoke('trend:updateGroupTag', { tsCode, groupTag }) as Promise<{ ok: boolean; error?: string }>,
    updateNotes: (tsCode: string, subCategory: string, notes: string) =>
      ipcRenderer.invoke('trend:updateNotes', { tsCode, subCategory, notes }) as Promise<{
        ok: boolean; error?: string
      }>,
    getScores: () =>
      ipcRenderer.invoke('trend:getScores') as Promise<{
        ok: boolean
        data?: Array<{
          tsCode: string
          stockName: string
          groupTag: string
          category: string
          subCategory: string
          notes: string
          isPortfolio: boolean
          costPrice: number | null
          profitPct: number | null
          positionAdvice: 'HOLD' | 'WATCH' | 'TAKE_PROFIT' | 'STOP_LOSS' | null
          positionAdviceReason: string | null
          chip: ChipSummary | null
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
        }>
        error?: string
      }>,
    getWorkbench: () =>
      ipcRenderer.invoke('trend:getWorkbench') as Promise<{
        ok: boolean
        data?: TrendWorkbenchSnapshot
        error?: string
        message?: string
      }>,
    getAlerts: (days?: number) =>
      ipcRenderer.invoke('trend:getAlerts', { days }) as Promise<{
        ok: boolean
        data?: Array<{
          id: number | undefined
          tsCode: string
          stockName: string
          alertType: string
          alertDate: string
          price: number | null
          refPrice: number | null
          createdAt: number
        }>
        error?: string
      }>,
    syncNow: (days?: number) =>
      ipcRenderer.invoke('trend:syncNow', { days }) as Promise<{ ok: boolean; error?: string; message?: string }>,
    backfillStocks: (tsCodes: string[]) =>
      ipcRenderer.invoke('trend:backfillStocks', { tsCodes }) as Promise<{
        ok: boolean
        data?: {
          requested: number
          synced: number
          skipped: number
          failed: number
          benchmark: TrendBenchmarkHealth
          stocks: Array<{
            tsCode: string
            provider: 'tushare' | 'eastmoney' | 'local-cache'
            latestTradeDate: string | null
            bars: number
            state: 'ready' | 'partial' | 'missing'
            message: string
            error: string | null
          }>
        }
        error?: string
        message?: string
      }>,
    onScoresUpdated: (cb: () => void) => {
      const listener = () => cb()
      ipcRenderer.on('trend:scoresUpdated', listener)
      return () => { ipcRenderer.removeListener('trend:scoresUpdated', listener) }
    },
    onAlert: (cb: (payload: {
      id: number
      tsCode: string
      stockName: string
      alertType: string
      alertDate: string
      price: number | null
      refPrice: number | null
    }) => void) => {
      const listener = (_event: IpcRendererEvent, data: Parameters<typeof cb>[0]) => cb(data)
      ipcRenderer.on('trend:alert', listener)
      return () => { ipcRenderer.removeListener('trend:alert', listener) }
    },
    onSyncProgress: (cb: (progress: { current: number; total: number; tradeDate: string }) => void) => {
      const listener = (_event: IpcRendererEvent, data: Parameters<typeof cb>[0]) => cb(data)
      ipcRenderer.on('trend:syncProgress', listener)
      return () => { ipcRenderer.removeListener('trend:syncProgress', listener) }
    },
    onSyncDone: (cb: (result: { synced: number; skipped: number; failed: number }) => void) => {
      const listener = (_event: IpcRendererEvent, data: Parameters<typeof cb>[0]) => cb(data)
      ipcRenderer.on('trend:syncDone', listener)
      return () => { ipcRenderer.removeListener('trend:syncDone', listener) }
    },
    onBackfillProgress: (cb: (progress: {
      current: number
      total: number
      tsCode: string
      status: 'synced' | 'skipped' | 'failed'
      provider: 'tushare' | 'eastmoney' | 'local-cache'
    }) => void) => {
      const listener = (_event: IpcRendererEvent, data: Parameters<typeof cb>[0]) => cb(data)
      ipcRenderer.on('trend:backfillProgress', listener)
      return () => { ipcRenderer.removeListener('trend:backfillProgress', listener) }
    },
    onBackfillDone: (cb: (result: {
      requested: number
      synced: number
      skipped: number
      failed: number
      benchmark: TrendBenchmarkHealth
    }) => void) => {
      const listener = (_event: IpcRendererEvent, data: Parameters<typeof cb>[0]) => cb(data)
      ipcRenderer.on('trend:backfillDone', listener)
      return () => { ipcRenderer.removeListener('trend:backfillDone', listener) }
    },
  },

  // ── FR-165: 今日决策看板 ──────────────────────────
  decision: {
    getTodaySignals: (filters?: DecisionSignalFilters) =>
      ipcRenderer.invoke('decision:getTodaySignals', filters ?? {}) as Promise<{
        ok: boolean
        data?: DecisionSignalItem[]
        carryover?: DecisionSignalItem[]
        context?: DecisionSignalDateContext
        error?: string
        message?: string
      }>,
    getSignalSummary: () =>
      ipcRenderer.invoke('decision:getSignalSummary') as Promise<{
        ok: boolean
        data?: DecisionSignalSummary
        error?: string
        message?: string
      }>,
    markRead: (id: number) =>
      ipcRenderer.invoke('decision:markRead', { id }) as Promise<{ ok: boolean; data?: DecisionSignalItem; error?: string; message?: string }>,
    watch: (id: number) =>
      ipcRenderer.invoke('decision:watch', { id }) as Promise<{ ok: boolean; data?: DecisionSignalItem; error?: string; message?: string }>,
    dismiss: (id: number, reason?: string, note?: string) =>
      ipcRenderer.invoke('decision:dismiss', { id, reason, note }) as Promise<{ ok: boolean; data?: DecisionSignalItem; error?: string; message?: string }>,
    resolve: (id: number, resolution: DecisionSignalResolution, note?: string) =>
      ipcRenderer.invoke('decision:resolve', { id, resolution, note }) as Promise<{ ok: boolean; data?: DecisionSignalItem; error?: string; message?: string }>,
    getTimeline: (id: number) =>
      ipcRenderer.invoke('decision:getTimeline', { id }) as Promise<{ ok: boolean; data?: DecisionSignalEventItem[]; error?: string; message?: string }>,
    getReviewStats: (filters?: DecisionReviewStatsFilters) =>
      ipcRenderer.invoke('decision:getReviewStats', filters ?? {}) as Promise<{ ok: boolean; data?: DecisionReviewStats; error?: string; message?: string }>,
    getHistorySignals: (filters?: DecisionReviewStatsFilters) =>
      ipcRenderer.invoke('decision:getHistorySignals', filters ?? {}) as Promise<{ ok: boolean; data?: DecisionHistorySignalsResult; error?: string; message?: string }>,
    getPortfolioRiskReview: (filters?: DecisionReviewStatsFilters) =>
      ipcRenderer.invoke('decision:getPortfolioRiskReview', filters ?? {}) as Promise<{ ok: boolean; data?: DecisionPortfolioRiskReview; error?: string; message?: string }>,
    getOutcomeMemory: (filters?: DecisionOutcomeMemoryFilters) =>
      ipcRenderer.invoke('decision:getOutcomeMemory', filters ?? {}) as Promise<{
        ok: boolean
        data?: DecisionOutcomeMemoryResult
        error?: string
        message?: string
      }>,
    saveReviewReport: (payload: {
      requestId: string
      periodStart: string
      periodEnd: string
      report: ReviewReportSnapshot
    }) =>
      ipcRenderer.invoke('decision:saveReviewReport', payload) as Promise<{
        ok: boolean
        data?: SavedReviewReportSummary
        error?: string
        message?: string
      }>,
    listReviewReports: (filters?: ReviewReportListFilters) =>
      ipcRenderer.invoke('decision:listReviewReports', filters ?? {}) as Promise<{
        ok: boolean
        data?: { items: SavedReviewReportSummary[]; total: number; offset: number; limit: number }
        error?: string
        message?: string
      }>,
    getReviewReport: (id: string) =>
      ipcRenderer.invoke('decision:getReviewReport', { id }) as Promise<{
        ok: boolean
        data?: SavedReviewReportDetail
        error?: string
        message?: string
      }>,
    deleteReviewReport: (id: string) =>
      ipcRenderer.invoke('decision:deleteReviewReport', { id }) as Promise<{
        ok: boolean
        data?: { id: string }
        error?: string
        message?: string
      }>,
    saveJudgment: (payload: SaveDecisionJudgmentPayload) =>
      ipcRenderer.invoke('decision:saveJudgment', payload) as Promise<{
        ok: boolean
        data?: DecisionJudgmentSummary & { projectedSignal: DecisionSignalItem | null }
        error?: string
        message?: string
      }>,
    listJudgments: (filters?: DecisionJudgmentListFilters) =>
      ipcRenderer.invoke('decision:listJudgments', filters ?? {}) as Promise<{
        ok: boolean
        data?: { items: DecisionJudgmentSummary[]; total: number; limit: number; offset: number }
        error?: string
        message?: string
      }>,
    getJudgment: (id: string) =>
      ipcRenderer.invoke('decision:getJudgment', { id }) as Promise<{
        ok: boolean
        data?: DecisionJudgmentDetail
        error?: string
        message?: string
      }>,
    listDueJudgmentFollowUps: (filters?: { now?: number; limit?: number; offset?: number }) =>
      ipcRenderer.invoke('decision:listDueJudgmentFollowUps', filters ?? {}) as Promise<{
        ok: boolean
        data?: { items: DecisionJudgmentFollowUpTask[]; total: number; limit: number; offset: number }
        error?: string
        message?: string
      }>,
    completeJudgmentFollowUp: (payload: CompleteDecisionJudgmentFollowUpPayload) =>
      ipcRenderer.invoke('decision:completeJudgmentFollowUp', payload) as Promise<{
        ok: boolean
        data?: DecisionJudgmentFollowUpRecord
        error?: string
        message?: string
      }>,
    onSignalCreated: (cb: (signal: DecisionSignalItem) => void) => {
      ipcRenderer.on('decision:signalCreated', (_e, d) => cb(d))
      return () => { ipcRenderer.removeAllListeners('decision:signalCreated') }
    },
  },

  // ── FR-168: 持仓批量 AI 预测 ────────────────────────
  portfolio: {
    list: () =>
      ipcRenderer.invoke('portfolio:list') as Promise<{
        ok: boolean
        data?: { tsCode: string; stockName: string; addedAt: number; costPrice: number | null }[]
        code?: string
        message?: string
      }>,
    add: (tsCode: string, stockName: string) =>
      ipcRenderer.invoke('portfolio:add', { tsCode, stockName }) as Promise<{ ok: boolean; code?: string; message?: string }>,
    remove: (tsCode: string) =>
      ipcRenderer.invoke('portfolio:remove', { tsCode }) as Promise<{ ok: boolean; code?: string; message?: string }>,
    updateCostPrice: (tsCode: string, costPrice: number | null) =>
      ipcRenderer.invoke('portfolio:updateCostPrice', { tsCode, costPrice }) as Promise<{ ok: boolean; code?: string; message?: string }>,
    getDashboard: (options?: { limit?: number; offset?: number }) =>
      ipcRenderer.invoke('portfolio:getDashboard', options ?? {}) as Promise<{ ok: boolean; data?: PortfolioDashboardItem[]; total?: number; code?: string; message?: string }>,
    forecastNow: () =>
      ipcRenderer.invoke('portfolio:forecastNow') as Promise<{ ok: boolean; code?: string }>,
    onForecastProgress: (
      cb: (data: { current: number; total: number; stockCode: string; ok: boolean; error?: string }) => void
    ) => {
      const handler = (_e: Electron.IpcRendererEvent, data: { current: number; total: number; stockCode: string; ok: boolean; error?: string }) => cb(data)
      ipcRenderer.on('portfolio:forecastProgress', handler)
      return () => { ipcRenderer.removeListener('portfolio:forecastProgress', handler) }
    },
  },

  // ── FR-171: 产业链传导分析 ─────────────────────────────
  supplyChain: {
    /** 分析文本，返回传导图谱 */
    analyze: (text: string) =>
      ipcRenderer.invoke('supplyChain:analyze', { text }) as Promise<{
        ok: boolean
        data?: {
          hitConcepts: string[]
          chainGroup: string
          matchedBy: 'local' | 'alias' | 'llm' | 'mixed' | 'none'
          attribution?: {
            chainGroups: Array<{
              chainGroup: string
              confidence: number
              direction: 'positive' | 'negative' | 'neutral' | 'mixed'
              reason: string
            }>
            affectedNodes: Array<{
              concept: string
              chainGroup: string
              role: 'direct' | 'upstream' | 'downstream' | 'related'
              confidence: number
              reason: string
            }>
            eventType: 'policy' | 'price' | 'supply_demand' | 'order' | 'tech' | 'export_control' | 'earnings' | 'market' | 'other'
            matchedBy: 'local' | 'alias' | 'llm' | 'mixed' | 'none'
          }
          recommendedStocks?: Array<{
            tsCode: string
            stockName: string
            chainGroup: string
            concepts: string[]
            rankScore: number
            leaderScore: number | null
            relevanceScore: number
            signalBoost: number
            todayChange: number | null
            amount: number | null
            reasons: string[]
            source: Array<'default' | 'kpl' | 'ths' | 'dc' | 'watchlist' | 'trend' | 'portfolio' | 'decision'>
          }>
          nodes: Array<{
            concept: string
            chainGroup: string
            distance: number
            isHit: boolean
            stocks: Array<{ stockCode: string; stockName: string; hotNum: number | null; todayChange: number | null }>
          }>
          edges: Array<{
            id: number
            upstreamConcept: string
            downstreamConcept: string
            relationLabel: string
            chainGroup: string
            sortOrder: number
            isEnabled: number
          }>
          stocks: Record<string, Array<{ stockCode: string; stockName: string; hotNum: number | null; todayChange: number | null }>>
        }
        code?: string
        message?: string
      }>,
    /** 获取所有边（含禁用，用于管理界面） */
    getEdges: () =>
      ipcRenderer.invoke('supplyChain:getEdges') as Promise<{
        ok: boolean
        data?: Array<{
          id: number
          upstreamConcept: string
          downstreamConcept: string
          relationLabel: string
          chainGroup: string
          sortOrder: number
          isEnabled: number
        }>
        code?: string
      }>,
    /** 写入或更新一条边 */
    saveEdge: (edge: {
      id?: number
      upstreamConcept: string
      downstreamConcept: string
      relationLabel?: string
      chainGroup?: string
      sortOrder?: number
      isEnabled?: number | boolean
    }) =>
      ipcRenderer.invoke('supplyChain:saveEdge', { edge }) as Promise<{
        ok: boolean
        data?: { id: number }
        code?: string
        message?: string
      }>,
    /** 删除一条边 */
    deleteEdge: (id: number) =>
      ipcRenderer.invoke('supplyChain:deleteEdge', { id }) as Promise<{
        ok: boolean
        code?: string
        message?: string
      }>,
    /** 获取所有产业链组名（去重） */
    getChainGroups: () =>
      ipcRenderer.invoke('supplyChain:getChainGroups') as Promise<{
        ok: boolean
        data?: string[]
        code?: string
      }>,
  },

  // ── FR-230: 产业研究事实层 ─────────────────────────────
  industryResearch: {
    listProjects: (options: {
      status?: 'draft' | 'active' | 'review_due' | 'archived'
      query?: string
      limit?: number
      offset?: number
      includeArchived?: boolean
    } = {}) => ipcRenderer.invoke('industryResearch:listProjects', options),
    getProject: (projectId: string) => ipcRenderer.invoke('industryResearch:getProject', { projectId }),
    createProject: (payload: object) => ipcRenderer.invoke('industryResearch:createProject', payload),
    updateProject: (projectId: string, patch: object) =>
      ipcRenderer.invoke('industryResearch:updateProject', { projectId, patch }),
    archiveProject: (projectId: string) => ipcRenderer.invoke('industryResearch:archiveProject', { projectId }),
    deleteProject: (projectId: string) => ipcRenderer.invoke('industryResearch:deleteProject', { projectId }),
    purgeProjects: (payload: { projectIds?: string[]; all?: boolean }) =>
      ipcRenderer.invoke('industryResearch:purgeProjects', payload),
    getGraph: (projectId: string) => ipcRenderer.invoke('industryResearch:getGraph', { projectId }),
    saveGraph: (payload: { projectId: string; nodes: unknown[]; edges: unknown[]; expectedUpdatedAt: number }) =>
      ipcRenderer.invoke('industryResearch:saveGraph', payload),
    listEvidence: (projectId: string) => ipcRenderer.invoke('industryResearch:listEvidence', { projectId }),
    saveEvidence: (projectId: string, evidence: Record<string, unknown>) =>
      ipcRenderer.invoke('industryResearch:saveEvidence', { projectId, evidence }),
    listHypotheses: (projectId: string) => ipcRenderer.invoke('industryResearch:listHypotheses', { projectId }),
    saveHypothesis: (projectId: string, hypothesis: Record<string, unknown>) =>
      ipcRenderer.invoke('industryResearch:saveHypothesis', { projectId, hypothesis }),
    updateHypothesisStatus: (payload: { projectId: string; hypothesisId: string; status: string; reason: string; evidenceIds?: string[] }) =>
      ipcRenderer.invoke('industryResearch:updateHypothesisStatus', payload),
    getReport: (projectId: string) => ipcRenderer.invoke('industryResearch:getReport', { projectId }),
    listCompanies: (projectId: string) => ipcRenderer.invoke('industryResearch:listCompanies', { projectId }),
    saveCompany: (projectId: string, company: Record<string, unknown>) =>
      ipcRenderer.invoke('industryResearch:saveCompany', { projectId, company }),
    listBusinessExposure: (projectId: string, companyId?: string) =>
      ipcRenderer.invoke('industryResearch:listBusinessExposure', { projectId, companyId }),
    saveBusinessExposure: (projectId: string, exposure: Record<string, unknown>) =>
      ipcRenderer.invoke('industryResearch:saveBusinessExposure', { projectId, exposure }),
    listDisclosureEvidence: (projectId: string, companyId: string) =>
      ipcRenderer.invoke('industryResearch:listDisclosureEvidence', { projectId, companyId }),
    saveDisclosureEvidence: (projectId: string, companyId: string, evidence: {
      id: string
      title: string
      sourceUrl: string
      publishedDate?: string | null
      actualPublishedDate?: string | null
      excerpt?: string | null
      primarySourceConfirmed: boolean
    }) => ipcRenderer.invoke('industryResearch:saveDisclosureEvidence', { projectId, companyId, evidence }),
    syncCompanyFinancials: (payload: {
      projectId: string
      companyId: string
      securityId: string
      tsCode: string
      datasets: Array<'income' | 'balancesheet' | 'cashflow' | 'fina_indicator' | 'fina_audit' | 'forecast' | 'express' | 'disclosure_date' | 'fina_mainbz'>
    }) => ipcRenderer.invoke('industryResearch:syncCompanyFinancials', payload),
    getFinancialTimeline: (payload: {
      companyId: string
      securityId?: string
      datasets?: Array<'income' | 'balancesheet' | 'cashflow' | 'fina_indicator' | 'fina_audit' | 'forecast' | 'express' | 'disclosure_date' | 'fina_mainbz'>
      fromAnnouncementDate?: string
      toAnnouncementDate?: string
    }) => ipcRenderer.invoke('industryResearch:getFinancialTimeline', payload),
    getFinancialValidation: (projectId: string, companyId: string) =>
      ipcRenderer.invoke('industryResearch:getFinancialValidation', { projectId, companyId }),
    saveProfitBridge: (payload: {
      projectId: string
      companyId: string
      bridge: Record<string, unknown>
      expectedUpdatedAt: number | null
    }) => ipcRenderer.invoke('industryResearch:saveProfitBridge', payload),
    getProfitBridge: (projectId: string, companyId: string, bridgeKey: string) =>
      ipcRenderer.invoke('industryResearch:getProfitBridge', { projectId, companyId, bridgeKey }),
    getFinancialSyncStatus: (companyId: string) =>
      ipcRenderer.invoke('industryResearch:getFinancialSyncStatus', { companyId }),
    getWebSearchConfig: () => ipcRenderer.invoke('industryResearch:getWebSearchConfig'),
    saveWebSearchConfig: (payload: {
      providerId: 'tavily' | 'bing' | 'custom_openai_compatible_search'
      enabled: boolean
      apiKey?: string | null
      baseUrl?: string | null
    }) => ipcRenderer.invoke('industryResearch:saveWebSearchConfig', payload),
    validateWebSearchConfig: () => ipcRenderer.invoke('industryResearch:validateWebSearchConfig'),
    listEvidenceCandidates: (projectId: string, runId?: string) =>
      ipcRenderer.invoke('industryResearch:listEvidenceCandidates', { projectId, runId }),
    confirmEvidenceCandidate: (projectId: string, candidateId: string, action: 'confirm' | 'reject') =>
      ipcRenderer.invoke('industryResearch:confirmEvidenceCandidate', { projectId, candidateId, action }),
    startGeneration: (payload: Record<string, unknown>) =>
      ipcRenderer.invoke('industryResearch:startGeneration', payload),
    getGenerationRun: (projectId: string, runId?: string) =>
      ipcRenderer.invoke('industryResearch:getGenerationRun', { projectId, runId }),
    cancelGeneration: (projectId: string, runId: string) =>
      ipcRenderer.invoke('industryResearch:cancelGeneration', { projectId, runId }),
    continueFinancialCollection: (projectId: string, runId: string) =>
      ipcRenderer.invoke('industryResearch:continueFinancialCollection', { projectId, runId }),
    retryGenerationStage: (projectId: string, runId: string, stage?: string) =>
      ipcRenderer.invoke('industryResearch:retryGenerationStage', { projectId, runId, stage }),
    resolveCompanyCandidate: (payload: {
      projectId: string
      runId: string
      candidateId: string
      action: 'accept' | 'exclude'
      securityTsCode?: string | null
      exclusionReason?: string | null
    }) => ipcRenderer.invoke('industryResearch:resolveCompanyCandidate', payload),
    prepareDiscussionChanges: (payload: {
      requestId: string
      sessionId: number
      throughMessageIndex: number
      projectId?: string | null
      baseSnapshotId?: string | null
    }) => ipcRenderer.invoke('industryResearch:prepareDiscussionChanges', payload),
    listChangeSets: (payload: {
      sessionId?: number
      projectId?: string
      batchId?: string
      status?: 'pending' | 'accepted' | 'rejected' | 'deferred' | 'superseded' | 'conflicted' | 'invalid'
      offset?: number
      limit?: number
    }) => ipcRenderer.invoke('industryResearch:listChangeSets', payload),
    listChangeCandidates: (payload: {
      changeSetId: string
      status?: 'pending' | 'accepted' | 'rejected' | 'superseded' | 'conflicted' | 'invalid'
      kind?: 'project' | 'node' | 'edge' | 'evidence' | 'hypothesis' | 'hypothesis_event' | 'company' | 'company_exposure' | 'follow_up'
      offset?: number
      limit?: number
    }) => ipcRenderer.invoke('industryResearch:listChangeCandidates', payload),
    resolveChangeSets: (payload: {
      requestId: string
      batchId: string
      changeSetIds: string[]
      action: 'accept' | 'reject' | 'defer'
      reason?: string
      userEdits?: Array<{ changeSetId: string; title?: string; summary?: string; payloadPatch?: unknown }>
      target?:
        | { mode: 'existing'; projectId: string }
        | { mode: 'create'; project: { title: string; industry: string; product: string; region: string; timeHorizon: string; purpose: 'learning' | 'strategy' | 'investment'; depth: 'quick' | 'standard' | 'deep' } }
      expectedGraphUpdatedAt?: number
      expectedSnapshotId?: string | null
      factConfirmations?: Array<{ candidateId: string; primarySourceConfirmed: true; confirmedBy: 'human'; originalSourceUrl: string }>
    }) => ipcRenderer.invoke('industryResearch:resolveChangeSets', payload),
    importCandidateArchive: (payload: {
      requestId: string
      projectId?: string
      archiveType: string
      dryRun?: boolean
    }) => ipcRenderer.invoke('industryResearch:importCandidateArchive', payload),
    listSnapshots: (payload: { projectId: string; offset?: number; limit?: number }) =>
      ipcRenderer.invoke('industryResearch:listSnapshots', payload),
    getSnapshot: (payload: { projectId: string; snapshotId: string }) =>
      ipcRenderer.invoke('industryResearch:getSnapshot', payload),
    getDecisionWorkbench: (payload: {
      projectId: string
      companyId?: string | null
      securityId?: string | null
      valuationDate?: string | null
    }) => ipcRenderer.invoke('industryResearch:getDecisionWorkbench', payload),
    syncMarketData: (payload: {
      projectId: string
      companyId: string
      securityId: string
      requestId: string
      valuationDate?: string | null
    }) => ipcRenderer.invoke('industryResearch:syncMarketData', payload),
    previewValuation: (payload: {
      projectId: string
      companyId: string
      securityId: string
      valuationDate: string
      valuationMethod: 'pe' | 'pb_roe' | 'ev_ebitda' | 'dcf' | 'sotp' | 'nav'
      scenarios: Array<{
        name: 'bear' | 'base' | 'bull'
        weightPct: number | null
        inputs: Record<string, {
          value: number | null
          unit: string
          sourceKind: 'fact' | 'assumption'
          factId?: string | null
          note?: string | null
        }>
        factIds?: string[]
      }>
      marketFingerprint: string
    }) => ipcRenderer.invoke('industryResearch:previewValuation', payload),
    captureValuationSnapshot: (payload: {
      projectId: string
      companyId: string
      securityId: string
      requestId: string
      scenarioSetVersionId: string
      valuationDate: string
      marketFingerprint: string
    }) => ipcRenderer.invoke('industryResearch:captureValuationSnapshot', payload),
    getSkillAdoption: (projectId: string) =>
      ipcRenderer.invoke('industryResearch:getSkillAdoption', { projectId }),
    adoptSkillVersion: (payload: {
      projectId: string
      requestId: string
      targetContentHash: string
      migrationNote: string
      expectedUpdatedAt: number
    }) => ipcRenderer.invoke('industryResearch:adoptSkillVersion', payload),
    listWorkItems: (projectId: string) =>
      ipcRenderer.invoke('industryResearch:listWorkItems', { projectId }),
    saveWorkItem: (payload: {
      projectId: string
      requestId: string
      workItemId: string
      expectedVersion: number
      question: string
      effort: 'quick_pass' | 'standard_validation' | 'deep_research'
      conclusionSensitivity: 'low' | 'medium' | 'high'
      evidenceUncertainty: 'low' | 'medium' | 'high'
      changeVelocity: 'low' | 'medium' | 'high'
      stopReason?: string | null
      nextTriggerMetric?: string | null
      affectedObjectIds: string[]
      status: 'open' | 'blocked' | 'completed' | 'stopped'
    }) => ipcRenderer.invoke('industryResearch:saveWorkItem', payload),
    listScenarios: (projectId: string, companyId?: string | null) =>
      ipcRenderer.invoke('industryResearch:listScenarios', { projectId, companyId }),
    saveScenarioSet: (payload: {
      projectId: string
      companyId?: string | null
      requestId: string
      scenarioSetId: string
      expectedVersion: number
      dataAsOf: string
      valuationDate?: string | null
      valuationMethod?: 'pe' | 'pb_roe' | 'ev_ebitda' | 'dcf' | 'sotp' | 'nav' | null
      methodologyVersion?: string | null
      scenarios: Array<{
        name: 'bear' | 'base' | 'bull'
        weightPct: number | null
        assumptions: Record<string, number | string | null>
        valuationInputs?: Record<string, {
          value: number | null
          unit: string
          sourceKind: 'fact' | 'assumption'
          factId?: string | null
          note?: string | null
        }>
        factIds: string[]
      }>
    }) => ipcRenderer.invoke('industryResearch:saveScenarioSet', payload),
    listDecisions: (projectId: string) =>
      ipcRenderer.invoke('industryResearch:listDecisions', { projectId }),
    appendDecisionEvent: (payload: {
      projectId: string
      companyId?: string | null
      requestId: string
      decisionId: string
      expectedLastEventId: string | null
      eventType: 'created' | 'maintained' | 'upgraded' | 'downgraded' | 'invalidated' | 'closed'
      action: 'continue_research' | 'wait_financial_validation' | 'wait_price' | 'monitor' | 'exclude'
      rationale: string
      dataAsOf: string
      valuationDate?: string | null
      validUntil: number
      invalidationCondition: string
      scenarioSetVersionId?: string | null
      workItemVersionIds: string[]
      factIds: string[]
      evidenceIds: string[]
      hypothesisIds: string[]
      sourceTriggerEvaluationId?: string | null
      marketSnapshotId?: string | null
      valuationSnapshotId?: string | null
    }) => ipcRenderer.invoke('industryResearch:appendDecisionEvent', payload),
    listMonitoringItems: (projectId: string) =>
      ipcRenderer.invoke('industryResearch:listMonitoringItems', { projectId }),
    saveMonitoringItem: (payload: {
      projectId: string
      requestId: string
      monitoringItemId: string
      expectedVersion: number
      name: string
      valueKind: 'number' | 'text' | 'event'
      frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'event_driven'
      sourceName: string
      sourceRef?: string | null
      unit?: string | null
      timingType: 'leading' | 'coincident' | 'lagging' | 'unknown'
      staleAfterMs: number
      nextReviewAt?: number | null
      hypothesisIds: string[]
      scenarioSetVersionIds: string[]
      decisionIds: string[]
      status: 'active' | 'paused' | 'closed'
    }) => ipcRenderer.invoke('industryResearch:saveMonitoringItem', payload),
    appendMonitoringObservation: (payload: {
      projectId: string
      requestId: string
      monitoringItemId: string
      expectedVersion: number
      value: number | string
      unit?: string | null
      sourceRef?: string | null
      observedAt: number
      availableAt: number
      dataAsOf: string
      methodologyVersion: string
    }) => ipcRenderer.invoke('industryResearch:appendMonitoringObservation', payload),
    listDecisionTriggers: (projectId: string) =>
      ipcRenderer.invoke('industryResearch:listDecisionTriggers', { projectId }),
    saveDecisionTrigger: (payload: {
      projectId: string
      requestId: string
      triggerId: string
      expectedVersion: number
      decisionId: string
      monitoringItemId: string
      metricName: string
      operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'changed'
      threshold: number | string | null
      validationWindowMs: number
      actionIfNotTriggered: 'continue_research' | 'wait_financial_validation' | 'wait_price' | 'monitor' | 'exclude'
      proposedActionIfTriggered: 'continue_research' | 'wait_financial_validation' | 'wait_price' | 'monitor' | 'exclude'
      expiresAt?: number | null
      status: 'active' | 'disabled'
    }) => ipcRenderer.invoke('industryResearch:saveDecisionTrigger', payload),
    evaluateDecisionTriggers: (payload: {
      projectId: string
      requestId: string
      triggerIds: string[]
      evaluatedAt?: number
    }) => ipcRenderer.invoke('industryResearch:evaluateDecisionTriggers', payload),
    resolveTriggerReview: (payload: {
      projectId: string
      evaluationId: string
      requestId: string
      resolution: 'confirm' | 'dismiss'
      reason: string
      decisionEvent?: Record<string, unknown>
    }) => ipcRenderer.invoke('industryResearch:resolveTriggerReview', payload),
    getReviewQueue: (projectId: string) =>
      ipcRenderer.invoke('industryResearch:getReviewQueue', { projectId }),
    resolveReviewItem: (payload: {
      projectId: string
      reviewGroupId: string
      requestId: string
      resolution: 'confirm' | 'dismiss'
      reason: string
    }) => ipcRenderer.invoke('industryResearch:resolveReviewItem', payload),
    getDecisionReplay: (projectId: string, decisionId: string) =>
      ipcRenderer.invoke('industryResearch:getDecisionReplay', { projectId, decisionId }),
    onGenerationProgress: (callback: (payload: {
      projectId: string
      runId: string
      status: string
      stage: string
      progressCurrent: number
      progressTotal: number
      message: string
      updatedAt: number
      financialCollection?: Record<string, unknown> | null
    }) => void) => {
      const listener = (_event: unknown, payload: {
        projectId: string
        runId: string
        status: string
        stage: string
        progressCurrent: number
        progressTotal: number
        message: string
        updatedAt: number
        financialCollection?: Record<string, unknown> | null
      }) => callback(payload)
      ipcRenderer.on('industryResearch:generationProgress', listener)
      return () => { ipcRenderer.removeListener('industryResearch:generationProgress', listener) }
    },
  },

  // ── Lifecycle ──────────────────────────────────────────
  notifyReady: () => ipcRenderer.invoke('renderer:ready'),

  // ── Shell ──────────────────────────────────────────────
  openExternal: (url: string) => ipcRenderer.invoke('system:openExternal', url) as Promise<
    { ok: true } | { ok: false; error: 'INVALID_URL' | 'UNAUTHORIZED' | 'OPEN_FAILED' }
  >,

  // ── Window controls ───────────────────────────────────
  windowControls: {
    minimize: () => ipcRenderer.invoke('window:minimize') as Promise<void>,
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize') as Promise<void>,
    close: () => ipcRenderer.invoke('window:close') as Promise<void>,
    isMaximized: () => ipcRenderer.invoke('window:isMaximized') as Promise<boolean>,
    onMaximizedChanged: (listener: (isMaximized: boolean) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, isMaximized: boolean) => listener(isMaximized)
      ipcRenderer.on('window:maximized-changed', handler)
      return () => { ipcRenderer.removeListener('window:maximized-changed', handler) }
    },
  },

  // ── Push events ────────────────────────────────────────
  on: (
    channel:
      | 'scan:started'
      | 'scan:completed'
      | 'briefings:new'
      | 'catchup:status'
      | 'source:statusChanged'
      | 'network:statusChanged'
      | 'scan:source-progress'
      | 'scan:aiAnalysisAvailable'
      | 'datasource:stocksUpdated',
    listener: (data: unknown) => void
  ) => {
    ipcRenderer.on(channel, (_event, data) => listener(data))
    return () => { ipcRenderer.removeAllListeners(channel) }
  },

  off: (channel: string) => {
    ipcRenderer.removeAllListeners(channel)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type API = typeof api
