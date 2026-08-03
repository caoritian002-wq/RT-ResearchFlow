import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAppStore } from '../../store/appStore'
import { createPortal } from 'react-dom'
import { StockKlineChipDrawer } from '../shared/StockMiniChart'
import { BacktestModal } from '../shared/BacktestModal'
import { getConclusion } from '../../utils/chipColors'
import {
  buildMorningAuctionFocusEvidence,
  buildMorningAuctionThemeTableDisplay,
  buildMorningAuctionWorkbench,
  getChipSyncPlaceholder,
  getMorningAuctionThemeConfidenceLabel,
  hasSameDayChipEvidence,
  isMorningAuctionMarketThemeRuntimeOutdated,
  resolveChipConclusionPctChg,
  type MorningAuctionCandidate,
  type MorningAuctionChipEntry,
  type MorningAuctionMarketTheme,
  type MorningAuctionMarketThemeState,
  type MorningAuctionMarketThemeSummary,
  type MorningAuctionThemeAttribution,
  type MorningAuctionThemeEvidence,
} from './morningAuctionViewModel'
import {
  buildMorningAuctionRecoveryState,
  type MorningAuctionRecoveryAction,
  type MorningAuctionRecoveryIssue,
  type MorningAuctionTradeDateStatus,
} from './morningAuctionRecoveryModel'

/** 返回当前北京时间 YYYYMMDD */
function todayYmd(): string {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

/** YYYYMMDD → YYYY-MM-DD */
function ymdToDash(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
}

/** YYYY-MM-DD → YYYYMMDD */
function dashToYmd(dash: string): string {
  return dash.replace(/-/g, '')
}

// FR-125: 内联类型与 preload 保持一致（render 端避免跨进程深 import）
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

interface MorningAuctionProps {
  dataTools?: ReactNode
  onOpenDataTools?: () => void
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

type VerificationStatus = 'pending' | 'checked' | 'blocked' | 'not_applicable'

interface StructuredInsight {
  tradeDate: string
  tsCode: string
  stockName: string
  poolKey: string
  score: number
  scoreBreakdown: Array<{
    key: string
    label: string
    value: number | null
    weight: number
    contribution: number
    reason: string
  }>
  entryReasons: string[]
  verificationItems: Array<{
    key: string
    label: string
    status: VerificationStatus
    source: string
    reason: string
    updatedAt: number
    checkedByUser?: boolean
    themeAttribution?: MorningAuctionThemeAttribution
  }>
  riskFlags: Array<{
    key: string
    label: string
    severity: 'low' | 'medium' | 'high'
    reason: string
  }>
  intradayPreview: {
    latestTime: string | null
    maxPctChg: number | null
    maxDrawdownFromOpen: number | null
    amountChangePct: number | null
    touchedLimitUp: boolean | null
    priceVsAuctionPct: number | null
  } | null
  backtestSummary: {
    sampleSize: number
    winRate: number | null
    avgReturn: number | null
    maxDrawdown: null
  } | null
  chipEvidence: ChipEntry | null
  themeAttribution: MorningAuctionThemeAttribution | null
  chipStatus: 'available' | 'missing' | 'insufficient'
  status: 'completed' | 'partial' | 'failed'
  errorMessage: string | null
  generatedAt: number
  updatedAt: number
}

interface InsightStatusSummary {
  tradeDate: string
  generatedAt: number | null
  completedCount: number
  missingCount: number
  blockedVerificationCount: number
}

interface InsightErrorState {
  code?: string
  message: string
  details?: string
  recommendedTradeDate?: string | null
}

/** 本地兼容型筹码结构摘要，旧结论字段与结构日期关系共用同一条目。 */
type ChipEntry = MorningAuctionChipEntry

type AuctionCandidate = MorningAuctionCandidate<MorningAuctionStock>

function insightKey(tsCode: string, poolKey: string): string {
  return `${tsCode}:${poolKey}`
}

function collectSnapshotStocks(snapshot: MorningAuctionSnapshot): MorningAuctionStock[] {
  return [
    ...snapshot.threeOne.firstBoard, ...snapshot.threeOne.secondBoard,
    ...snapshot.threeOne.brokenBoard, ...snapshot.threeOne.brokenConsec,
    ...snapshot.threeOne.allMarket,
    ...snapshot.weakToStrong.badBoard, ...snapshot.weakToStrong.tailAttack,
    ...snapshot.weakToStrong.brokenBoard, ...snapshot.weakToStrong.afternoonReseal,
    ...snapshot.weakToStrong.reversal,
    ...snapshot.boardCategory.first, ...snapshot.boardCategory.second,
    ...snapshot.boardCategory.third, ...snapshot.boardCategory.n,
  ]
}

const RECOVERY_ACTION_LABEL: Record<MorningAuctionRecoveryAction, string> = {
  relaunch: '重新启动应用',
  switchTradeDate: '切换最近交易日',
  refreshSnapshot: '立即刷新',
  regenerateInsights: '重建结构化研判',
  syncChips: '同步筹码',
  openDataTools: '打开数据工具',
  openStock: '进入走势图',
  openBacktest: '查看历史回测',
}

function RecoveryPanel({
  issues,
  onAction,
  onClose,
  insightLoading,
}: {
  issues: MorningAuctionRecoveryIssue[]
  onAction: (action: MorningAuctionRecoveryAction) => void
  onClose: () => void
  insightLoading: boolean
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  if (issues.length === 0) return null
  const primaryIssue = issues[0]
  const actions = [...new Set(issues.flatMap(issue => issue.actions))]
  return (
    <section className="shrink-0 border-b border-amber-200 bg-amber-50/90 px-3 py-1.5 dark:border-amber-900 dark:bg-amber-950/30">
      <div className="flex min-h-8 items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px]">
            <strong className="shrink-0 text-amber-900 dark:text-amber-100">
              {primaryIssue.title}{primaryIssue.count ? ` · ${primaryIssue.count} 项` : ''}
            </strong>
            <span className="truncate text-amber-800/80 dark:text-amber-200/80">{primaryIssue.impact}</span>
            {issues.length > 1 && <span className="shrink-0 text-amber-700 dark:text-amber-300">另有 {issues.length - 1} 类问题</span>}
          </div>
        </div>
        <button type="button" onClick={() => setExpanded(current => !current)} className="h-7 shrink-0 px-1.5 text-[11px] font-medium text-amber-800 hover:text-amber-950 dark:text-amber-200 dark:hover:text-amber-50">
          {expanded ? '收起详情' : '查看详情'}
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {actions.map(action => (
            <button key={action} type="button" onClick={() => onAction(action)} disabled={action === 'regenerateInsights' && insightLoading} className="h-7 rounded border border-amber-300 bg-white px-2 text-[11px] font-medium text-amber-800 hover:bg-amber-100 disabled:cursor-wait disabled:opacity-60 dark:border-amber-800 dark:bg-slate-900 dark:text-amber-200 dark:hover:bg-amber-900/60">
              {action === 'regenerateInsights' && insightLoading ? '重建中…' : RECOVERY_ACTION_LABEL[action]}
            </button>
          ))}
        </div>
        <button type="button" onClick={onClose} aria-label="关闭当前恢复提示" title="关闭当前恢复提示" className="flex size-7 shrink-0 items-center justify-center rounded text-lg leading-none text-amber-700 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/60">×</button>
      </div>
      {expanded && (
        <div className="mt-1 grid gap-1 border-t border-amber-200/70 pt-1.5 md:grid-cols-2 dark:border-amber-900/70">
          {issues.map(issue => (
            <div key={issue.key} className="min-w-0 text-[10px] leading-4 text-slate-600 dark:text-slate-300">
              <strong className="text-slate-700 dark:text-slate-100">{issue.title}: </strong>
              {issue.description} <span className="text-slate-400">影响: {issue.impact}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// 涨跌幅文字配色：A 股红涨绿跌
function pctColor(v: number): string {
  if (v > 0.05) return 'text-red-600 dark:text-red-400'
  if (v < -0.05) return 'text-green-600 dark:text-green-400'
  return 'text-slate-500 dark:text-slate-400'
}

function formatTs(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function formatTradeDate(ymd: string): string {
  if (ymd.length !== 8) return ymd
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
}

/**
 * 竞价金额格式化：入参单位为万元
 * >= 1000万 → X.XX亿；< 1000万 → XX万
 */
function formatAmount(wanYuan: number): string {
  if (wanYuan >= 1000) {
    return `${(wanYuan / 10000).toFixed(2)}亿`
  }
  return `${wanYuan.toFixed(0)}万`
}

function formatSignedPct(value: number | null): string {
  if (value == null) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function formatScore(score: number): string {
  return Math.max(0, Math.min(100, score)).toFixed(0)
}

function formatFlowAmount(yuan: number | null): string {
  if (yuan == null) return '--'
  const sign = yuan > 0 ? '+' : ''
  const abs = Math.abs(yuan)
  if (abs >= 100_000_000) return `${sign}${(yuan / 100_000_000).toFixed(2)}亿`
  if (abs >= 10_000) return `${sign}${(yuan / 10_000).toFixed(0)}万`
  return `${sign}${yuan.toFixed(0)}`
}

const MARKET_THEME_STATE_META: Record<MorningAuctionMarketThemeState, { label: string; className: string }> = {
  confirmed_continuation: {
    label: '延续确认',
    className: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/35 dark:text-red-300',
  },
  unconfirmed_continuation: {
    label: '延续未确认',
    className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/35 dark:text-amber-300',
  },
  new_rotation: {
    label: '新轮动线索',
    className: 'border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-900 dark:bg-cyan-950/35 dark:text-cyan-300',
  },
  isolated_risk: {
    label: '持续性存疑',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/35 dark:text-emerald-300',
  },
  auction_only: {
    label: '仅竞价转强',
    className: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/35 dark:text-blue-300',
  },
  insufficient: {
    label: '证据不足',
    className: 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300',
  },
}

/**
 * 按 tsCode 判断所属板块
 * tsCode 格式： 600519.SH / 000001.SZ / 688001.SH / 300001.SZ / 830000.BJ
 */
type ExchangeFilter = 'all' | 'sh_main' | 'kcb' | 'sz_main' | 'cyb' | 'bj'

function classifyExchange(tsCode: string): ExchangeFilter {
  if (tsCode.endsWith('.BJ')) return 'bj'
  const code = tsCode.split('.')[0]
  if (tsCode.endsWith('.SH')) {
    return code.startsWith('688') ? 'kcb' : 'sh_main'
  }
  if (tsCode.endsWith('.SZ')) {
    return code.startsWith('3') ? 'cyb' : 'sz_main'
  }
  return 'sh_main'
}

const EXCHANGE_OPTIONS: { value: ExchangeFilter; label: string }[] = [
  { value: 'all', label: '全部板块' },
  { value: 'sh_main', label: '沪主板' },
  { value: 'kcb', label: '科创板' },
  { value: 'sz_main', label: '深主板' },
  { value: 'cyb', label: '创业板' },
  { value: 'bj', label: '北交所' },
]

type CandidateView = 'all' | 'threeOne' | 'firstBoard' | 'mixed' | 'chipMissing' | 'weakToStrong' | 'boardCategory' | 'allMarket' | 'verificationGap'
type CandidateSortMode = 'rank' | 'auctionAmount' | 'auctionPct' | 'turnover'
type CandidateQuickFilter = 'all' | 'limitUp' | 'withChip' | 'missingHistory'

const SEGMENTED_VIEWS: { key: CandidateView; label: string }[] = [
  { key: 'threeOne', label: '板票竞价双第一' },
  { key: 'firstBoard', label: '首板票竞价双第一' },
  { key: 'mixed', label: '二信号混合' },
  { key: 'chipMissing', label: '筹码未补' },
]

function hasChipEntry(candidate: AuctionCandidate): boolean {
  return hasSameDayChipEvidence(candidate.chipEntry)
}

function isVerificationGap(candidate: AuctionCandidate): boolean {
  const stock = candidate.stock
  return stock.pctChg3d == null || stock.pctChg5d == null || stock.conceptNames.length === 0 || !hasChipEntry(candidate)
}

function getCandidateViewLabel(view: CandidateView): string {
  return {
    all: '全部竞价候选',
    threeOne: '板票竞价双第一',
    firstBoard: '首板票竞价双第一',
    mixed: '二信号混合',
    chipMissing: '筹码未补',
    weakToStrong: '弱转强信号',
    boardCategory: '板态分类',
    allMarket: '全市场异动',
    verificationGap: '验证缺口',
  }[view]
}

function matchCandidateView(candidate: AuctionCandidate, view: CandidateView): boolean {
  switch (view) {
    case 'all':
      return true
    case 'threeOne':
      return candidate.group === 'threeOne'
    case 'firstBoard':
      return candidate.group === 'threeOne' && candidate.poolKey === 'firstBoard'
    case 'mixed':
      return candidate.group === 'weakToStrong' || candidate.group === 'boardCategory'
    case 'chipMissing':
      return !hasChipEntry(candidate)
    case 'weakToStrong':
      return candidate.group === 'weakToStrong'
    case 'boardCategory':
      return candidate.group === 'boardCategory'
    case 'allMarket':
      return candidate.group === 'allMarket'
    case 'verificationGap':
      return isVerificationGap(candidate)
    default:
      return true
  }
}

function sortCandidates(
  candidates: AuctionCandidate[],
  mode: CandidateSortMode,
  scoreForCandidate?: (candidate: AuctionCandidate) => number
): AuctionCandidate[] {
  return [...candidates].sort((left, right) => {
    if (mode === 'auctionAmount') return right.stock.auctionAmount - left.stock.auctionAmount
    if (mode === 'auctionPct') return right.stock.pctChg - left.stock.pctChg
    if (mode === 'turnover') return right.stock.auctionTurnover - left.stock.auctionTurnover
    return (scoreForCandidate?.(right) ?? right.rankScore) - (scoreForCandidate?.(left) ?? left.rankScore)
  })
}

function PoolStrip({ candidates, missingHistoryCount, activeView, onSelectView }: {
  candidates: AuctionCandidate[]
  missingHistoryCount: number
  activeView: CandidateView
  onSelectView: (view: CandidateView) => void
}): JSX.Element {
  const groupRows = (view: CandidateView): AuctionCandidate[] => candidates.filter(candidate => matchCandidateView(candidate, view))
  const describeGroup = (rows: AuctionCandidate[], fallback: string): string => {
    if (rows.length === 0) return fallback
    const avgPct = rows.reduce((sum, candidate) => sum + candidate.stock.pctChg, 0) / rows.length
    const lead = rows[0]?.stock.stockName ?? '暂无'
    return `${lead} 领队, 平均竞价 ${formatSignedPct(avgPct)}`
  }
  const threeOneRows = groupRows('threeOne')
  const weakRows = groupRows('weakToStrong')
  const boardRows = groupRows('boardCategory')
  const allMarketRows = groupRows('allMarket')
  const cards: Array<{ key: string; view: CandidateView; label: string; badge: string; count: number; unit: string; note: string }> = [
    {
      key: 'threeOne',
      view: 'threeOne',
      label: '竞价二信号',
      badge: '重点',
      count: threeOneRows.length,
      unit: '只',
      note: describeGroup(threeOneRows, '板票竞价双第一候选'),
    },
    {
      key: 'weakToStrong',
      view: 'weakToStrong',
      label: '弱转强信号',
      badge: '观察',
      count: weakRows.length,
      unit: '只',
      note: describeGroup(weakRows, '一字回封与高开承接待观察'),
    },
    {
      key: 'boardCategory',
      view: 'boardCategory',
      label: '板态分类',
      badge: '复盘',
      count: boardRows.length,
      unit: '条',
      note: describeGroup(boardRows, '首板、二板、高标状态复盘'),
    },
    {
      key: 'allMarket',
      view: 'allMarket',
      label: '全市场异动',
      badge: '扩展',
      count: allMarketRows.length,
      unit: '只',
      note: describeGroup(allMarketRows, '竞价额过阈值的非涨停异动'),
    },
    {
      key: 'verificationGap',
      view: 'verificationGap' as CandidateView,
      label: '验证缺口',
      badge: '待办',
      count: missingHistoryCount,
      unit: '项',
      note: missingHistoryCount > 0 ? '历史涨跌、题材或筹码仍需补齐' : '当前候选基础验证已补齐',
    },
  ]

  return (
    <div className="grid shrink-0 grid-cols-1 gap-2 lg:grid-cols-5">
      {cards.map(card => (
        <button
          type="button"
          key={card.key}
          onClick={() => onSelectView(card.view)}
          className={`relative min-h-[66px] min-w-0 overflow-hidden rounded-lg border bg-white px-2.5 py-2 shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:bg-slate-800 ${
            activeView === card.view
              ? 'border-blue-200 shadow-[inset_0_3px_0_#2563eb,0_1px_2px_rgba(15,23,42,0.04)] dark:border-blue-800'
              : 'border-slate-200 text-left hover:border-blue-200 hover:bg-blue-50/30 dark:border-slate-700 dark:hover:border-blue-800 dark:hover:bg-blue-950/20'
          }`}
        >
          <div className="pointer-events-none absolute -right-8 -top-12 h-20 w-20 rounded-full bg-blue-500/5" />
          <div className="relative flex items-center gap-1.5 text-[12px] font-bold text-slate-700 dark:text-slate-200">
            <span className="truncate">{card.label}</span>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-700 dark:text-slate-300">{card.badge}</span>
          </div>
          <div className="relative mt-1 flex items-baseline gap-1.5">
            <strong className="text-xl font-bold tabular-nums text-slate-950 dark:text-slate-50">{card.count}</strong>
            <span className="text-xs text-slate-500 dark:text-slate-400">{card.unit}</span>
          </div>
          <div className="relative mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400">{card.note}</div>
        </button>
      ))}
    </div>
  )
}

function MarketThemeStrip({
  summary,
  snapshotLoaded,
  activeThemeName,
  onSelectTheme,
  onRelaunch,
}: {
  summary: MorningAuctionMarketThemeSummary | null
  snapshotLoaded: boolean
  activeThemeName: string | null
  onSelectTheme: (theme: MorningAuctionMarketTheme) => void
  onRelaunch: () => void
}): JSX.Element {
  const themes = summary?.themes.slice(0, 3) ?? []
  const coverage = summary?.coverageRate == null ? '--' : `${Math.round(summary.coverageRate * 100)}%`
  const runtimeOutdated = isMorningAuctionMarketThemeRuntimeOutdated(snapshotLoaded, summary)
  const sourceText = !snapshotLoaded
    ? '正在读取竞价快照'
    : runtimeOutdated
      ? '主进程待重启'
      : summary?.flowTradeDate
        ? `资金事实 ${formatTradeDate(summary.flowTradeDate)}`
        : summary?.status === 'no_verified_flow'
          ? '昨日真实资金缺失'
          : '等待竞价归因'
  const themeGridColumns = themes.length === 1
    ? 'grid-cols-1'
    : themes.length === 2
      ? 'grid-cols-2'
      : 'grid-cols-3'

  return (
    <section
      data-testid="morning-auction-market-themes"
      className="col-span-full grid min-h-[58px] shrink-0 grid-cols-[190px_minmax(0,1fr)] items-stretch overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:border-slate-700 dark:bg-slate-800 max-md:grid-cols-1"
      aria-label="今日竞价主线"
    >
      <div className="flex min-w-0 flex-col justify-center border-r border-slate-100 px-3 py-2 dark:border-slate-700 max-md:border-b max-md:border-r-0">
        <div className="flex items-center justify-between gap-2">
          <h2 className="truncate text-xs font-extrabold text-slate-800 dark:text-slate-100">今日竞价主线</h2>
          <span className="shrink-0 rounded border border-blue-100 bg-blue-50 px-1.5 py-0.5 text-[9px] font-semibold text-blue-600 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">自动判断</span>
        </div>
        <p className="mt-1 flex min-w-0 items-center justify-between gap-2 text-[10px] text-slate-500 dark:text-slate-400" title={summary?.summary}>
          <span className="truncate">{sourceText}</span>
          <span className="shrink-0 tabular-nums text-slate-400">覆盖 {coverage}</span>
        </p>
      </div>
      {themes.length > 0 ? (
        <div className={`grid min-w-0 ${themeGridColumns} divide-x divide-slate-100 dark:divide-slate-700 max-md:grid-cols-1 max-md:divide-x-0 max-md:divide-y`}>
          {themes.map((theme, index) => {
            const active = activeThemeName === theme.name
            const meta = MARKET_THEME_STATE_META[theme.state]
            return (
              <button
                key={`${theme.name}:${theme.flow?.boardCode ?? index}`}
                type="button"
                data-testid={`morning-auction-market-theme-${index + 1}`}
                aria-pressed={active}
                onClick={() => onSelectTheme(theme)}
                title={`${theme.summary} ${theme.risks[0] ?? ''}`}
                className={`min-h-11 min-w-0 px-3 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 motion-reduce:transition-none ${active ? 'bg-blue-50/80 dark:bg-blue-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-900/50'}`}
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0 text-[10px] font-bold tabular-nums text-slate-400">#{index + 1}</span>
                  <strong className="truncate text-xs text-slate-900 dark:text-slate-50">{theme.name}</strong>
                  <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold ${meta.className}`}>{meta.label}</span>
                </div>
                <div className="mt-1 flex min-w-0 items-center gap-2 text-[10px] text-slate-500 dark:text-slate-400">
                  <span className="shrink-0">{theme.auction.activeCandidateCount}只共振</span>
                  <span className="shrink-0">中位 {formatSignedPct(theme.auction.medianPctChg)}</span>
                  <span className="truncate">昨日 {formatFlowAmount(theme.flow?.mainNetInflow ?? null)}</span>
                </div>
              </button>
            )
          })}
        </div>
      ) : (
        <div
          className="flex min-h-11 min-w-0 items-center justify-between gap-3 px-3 py-2 text-xs text-slate-500 dark:text-slate-400"
          role={runtimeOutdated ? 'alert' : 'status'}
        >
          <span className="min-w-0 leading-5" title={runtimeOutdated ? '当前界面已更新，但主进程仍是旧版本，因此没有返回竞价主线字段。重启后将直接使用现有竞价、题材和昨日资金重新计算。' : summary?.summary}>
            {runtimeOutdated
              ? '当前界面已更新，但主进程仍是旧版本；重启后会直接使用现有数据计算主线。'
              : summary?.summary ?? '正在读取竞价主线证据，无需手工设置。'}
          </span>
          {runtimeOutdated && (
            <button
              type="button"
              onClick={onRelaunch}
              className="min-h-11 shrink-0 rounded-md border border-blue-200 bg-blue-50 px-3 text-[11px] font-semibold text-blue-700 transition-colors hover:bg-blue-100 active:bg-blue-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 motion-reduce:transition-none dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200 dark:hover:bg-blue-900/50 dark:active:bg-blue-900"
            >
              重启应用加载主线
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function ThemeEvidenceSummary({ evidence }: { evidence: MorningAuctionThemeEvidence }): JSX.Element {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50/70 p-2.5 dark:border-slate-700 dark:bg-slate-900/60">
      <div className="flex items-center justify-between gap-2">
        <strong className="truncate text-xs text-slate-800 dark:text-slate-100">{evidence.name}</strong>
        <span className="shrink-0 text-[10px] text-slate-400">
          {evidence.direct ? '直接原因' : evidence.activePeerCount > 0 ? `${evidence.activePeerCount + 1} 只候选共振` : '静态关联'}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {evidence.basis.map(item => (
          <span key={item} className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">{item}</span>
        ))}
      </div>
      {evidence.peers.length > 0 && (
        <div className="mt-2 text-[11px] leading-5 text-slate-500 dark:text-slate-400">
          共振股票：{evidence.peers.map(peer => `${peer.stockName} ${formatSignedPct(peer.auctionPctChg)}`).join(' · ')}
        </div>
      )}
    </div>
  )
}

function ThemeAttributionCell({
  candidate,
  onSelect,
}: {
  candidate: AuctionCandidate
  onSelect: (candidate: AuctionCandidate) => void
}): JSX.Element {
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0, width: 380, maxHeight: 420 })
  const stock = candidate.stock
  const attribution = stock.themeAttribution ?? null
  const display = buildMorningAuctionThemeTableDisplay(stock)
  const hasThemeContent = display.totalCount > 0 || Boolean(attribution?.directReason)
  const popoverId = `morning-auction-theme-popover-${stock.stockCode}`
  const popoverTitleId = `${popoverId}-title`

  const updatePopoverPosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect || !hasThemeContent) return
    const width = Math.min(380, Math.max(280, window.innerWidth - 24))
    const roomBelow = window.innerHeight - rect.bottom - 12
    const roomAbove = rect.top - 12
    const placeAbove = roomBelow < 280 && roomAbove > roomBelow
    const maxHeight = Math.min(440, Math.max(180, (placeAbove ? roomAbove : roomBelow) - 8))
    const top = placeAbove
      ? rect.top - maxHeight - 8
      : rect.bottom + 8
    const left = Math.min(
      Math.max(12, rect.right - width),
      Math.max(12, window.innerWidth - width - 12),
    )
    setPosition({ top, left, width, maxHeight })
  }, [hasThemeContent])

  const closePopover = useCallback(() => {
    setOpen(false)
    buttonRef.current?.focus({ preventScroll: true })
  }, [])

  const openPopover = useCallback(() => {
    if (!hasThemeContent) return
    updatePopoverPosition()
    onSelect(candidate)
    setOpen(true)
  }, [candidate, hasThemeContent, onSelect, updatePopoverPosition])

  useEffect(() => {
    if (!open) return undefined
    closeButtonRef.current?.focus({ preventScroll: true })
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closePopover()
      }
    }
    document.addEventListener('keydown', closeOnKey)
    window.addEventListener('resize', updatePopoverPosition)
    return () => {
      document.removeEventListener('keydown', closeOnKey)
      window.removeEventListener('resize', updatePopoverPosition)
    }
  }, [closePopover, open, updatePopoverPosition])

  const toneClass = display.primary.tone === 'direct'
    ? 'border-cyan-200 bg-cyan-50 text-cyan-800 dark:border-cyan-900 dark:bg-cyan-950/50 dark:text-cyan-200'
    : display.primary.tone === 'inferred'
      ? 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/50 dark:text-blue-200'
      : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'

  const popover = open ? (
    <div
      id={popoverId}
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={popoverTitleId}
      className="fixed z-[1200] overflow-y-auto overscroll-contain rounded-lg border border-slate-200 bg-white shadow-[0_18px_48px_rgba(15,23,42,0.22)] dark:border-slate-700 dark:bg-slate-800"
      style={position}
      data-testid="morning-auction-theme-popover"
    >
      <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-slate-100 bg-white/95 px-3.5 py-3 backdrop-blur dark:border-slate-700 dark:bg-slate-800/95">
        <div className="min-w-0">
          <div id={popoverTitleId} className="truncate text-sm font-bold text-slate-900 dark:text-slate-50">{stock.stockName} · 题材归因</div>
          <div className="mt-0.5 text-[10px] text-slate-400">早盘主驱动判断，不代表全天最终上涨原因</div>
        </div>
        <button ref={closeButtonRef} type="button" onClick={closePopover} className="min-h-11 shrink-0 rounded px-3 text-[11px] font-semibold text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100">关闭</button>
      </div>
      <div className="space-y-3 p-3.5">
        <section>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h4 className="text-xs font-extrabold text-slate-700 dark:text-slate-200">今日主驱动</h4>
            <span className="text-[10px] font-semibold text-slate-400">{getMorningAuctionThemeConfidenceLabel(attribution?.confidence ?? 'none')}</span>
          </div>
          {attribution?.primary ? (
            <>
              <ThemeEvidenceSummary evidence={attribution.primary} />
              <p className="mt-2 text-xs leading-5 text-slate-600 dark:text-slate-300">{attribution.summary}</p>
              {attribution.directReason && (
                <div className="mt-2 rounded-md border-l-2 border-cyan-400 bg-cyan-50/70 px-2.5 py-2 text-[11px] leading-5 text-cyan-900 dark:bg-cyan-950/30 dark:text-cyan-100">
                  <span className="font-semibold">上一交易日涨停原因：</span>{attribution.directReason}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="rounded-md border border-dashed border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                {attribution?.summary ?? '当前没有足够的直接原因和竞价共振，主炒题材待确认。'}
              </div>
              {attribution?.directReason && (
                <div className="mt-2 rounded-md border-l-2 border-cyan-400 bg-cyan-50/70 px-2.5 py-2 text-[11px] leading-5 text-cyan-900 dark:bg-cyan-950/30 dark:text-cyan-100">
                  <span className="font-semibold">直接原因记录（待映射题材）：</span>{attribution.directReason}
                </div>
              )}
            </>
          )}
        </section>

        {attribution && attribution.resonance.length > 0 && (
          <section>
            <h4 className="mb-2 text-xs font-extrabold text-slate-700 dark:text-slate-200">今日共振</h4>
            <div className="grid gap-2">
              {attribution.resonance.map(item => <ThemeEvidenceSummary key={item.name} evidence={item} />)}
            </div>
          </section>
        )}

        <section>
          <h4 className="mb-2 text-xs font-extrabold text-slate-700 dark:text-slate-200">静态关联题材</h4>
          {(attribution?.staticThemes.length ?? stock.conceptNames.length) > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {(attribution?.staticThemes ?? stock.conceptNames).map(name => (
                <span key={name} className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">{name}</span>
              ))}
            </div>
          ) : <div className="text-xs text-slate-400">暂无其他静态关联题材</div>}
        </section>

        <div className="border-t border-slate-100 pt-2 text-[10px] leading-4 text-slate-400 dark:border-slate-700">
          {attribution?.sourceTradeDate ? `直接事实日 ${formatTradeDate(attribution.sourceTradeDate)} · ` : ''}竞价共振来自当前候选快照；基础属性类题材已降权。
        </div>
      </div>
    </div>
  ) : null

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={!hasThemeContent}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={`${stock.stockName}题材详情，共${display.totalCount}项`}
        data-testid={`morning-auction-theme-trigger-${stock.stockCode}`}
        onClick={(event) => {
          event.stopPropagation()
          if (!open) openPopover()
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        className="flex min-h-8 max-w-[270px] items-center justify-end gap-1 rounded px-1 py-0.5 text-right transition-colors duration-150 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-default disabled:hover:bg-transparent motion-reduce:transition-none dark:hover:bg-slate-700/70"
      >
        <span className={`max-w-[126px] truncate rounded border px-1.5 py-0.5 text-[10px] font-semibold ${toneClass}`}>
          {display.primary.name ? `${display.primary.label}·${display.primary.name}` : display.primary.label}
        </span>
        {display.secondary && (
          <span className="max-w-[96px] truncate rounded border border-blue-100 bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">
            {display.secondary.label}·{display.secondary.name}
          </span>
        )}
        {display.hiddenCount > 0 && (
          <span className="shrink-0 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">+{display.hiddenCount}</span>
        )}
      </button>
      {popover && typeof document !== 'undefined' ? createPortal(popover, document.body) : popover}
    </>
  )
}

function CandidateQueue({
  candidates,
  selectedId,
  title,
  selectedName,
  chipSyncAttemptedCodes,
  chipSyncing,
  onSelect,
  onStockClick,
}: {
  candidates: AuctionCandidate[]
  selectedId: string | null
  title: string
  selectedName: string | null
  chipSyncAttemptedCodes: Set<string>
  chipSyncing: boolean
  onSelect: (candidate: AuctionCandidate) => void
  onStockClick: (stock: MorningAuctionStock) => void
}): JSX.Element {
  if (candidates.length === 0) {
    return (
      <div className="flex h-full min-h-[320px] items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white text-sm text-slate-400 dark:border-slate-700 dark:bg-slate-800">
        暂无符合当前筛选的竞价候选
      </div>
    )
  }

  return (
    <div className="flex min-h-[220px] flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] max-xl:h-[560px] xl:max-h-[calc(100vh-430px)] dark:border-slate-700 dark:bg-slate-800">
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 bg-gradient-to-b from-white to-slate-50 px-3.5 py-3 dark:border-slate-700 dark:from-slate-800 dark:to-slate-800/70">
        <h3 className="m-0 text-[15px] font-bold text-slate-950 dark:text-slate-50">{title}</h3>
        <span className="text-xs text-slate-500 dark:text-slate-400">{candidates.length} 只股票 · 当前选中 {selectedName ?? '暂无'} · 表格保留高密度, 证据收纳到右侧研判</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
        <table className="w-full min-w-[1120px] border-separate border-spacing-0 text-xs">
          <thead>
            <tr>
              {['股票', '竞价开盘', '竞价涨幅', '现价', '现涨幅', '现价成交额', '3日涨跌', '5日涨跌', '题材', '筹码结论', '竞价金额', '竞价换手率'].map((header, index) => (
                <th
                  key={header}
                  className={`sticky top-0 z-10 h-8 border-b border-slate-100 bg-slate-50 px-2.5 text-[11px] font-bold text-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-500 ${index === 0 ? 'text-left' : 'text-right'}`}
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {candidates.map((candidate, index) => {
              const stock = candidate.stock
              const selected = candidate.id === selectedId
              const chipSyncAttempted = chipSyncAttemptedCodes.has(stock.stockCode)
              const chipConclusion = candidate.chipEntry && candidate.chipEntry.dateRelation !== 'missing'
                ? getConclusion({
                    ...candidate.chipEntry,
                    pctChg: resolveChipConclusionPctChg(candidate.chipEntry, stock.currentPctChg ?? stock.pctChg),
                  })
                : null
              return (
                <tr
                  key={candidate.id}
                  onClick={() => onSelect(candidate)}
                  onDoubleClick={() => onStockClick(stock)}
                  className={`cursor-pointer ${selected ? '[&_td]:bg-blue-50 dark:[&_td]:bg-blue-950/30' : 'hover:[&_td]:bg-slate-50 dark:hover:[&_td]:bg-slate-700/50'}`}
                >
                  <td className="h-[42px] border-b border-slate-100 bg-white px-2.5 text-left dark:border-slate-700 dark:bg-slate-800">
                    <div className="flex min-w-[170px] items-center gap-2">
                      <span className={`text-[13px] ${index === 0 ? 'text-amber-500' : 'text-transparent'}`}>★</span>
                      <div className="min-w-0">
                        <div className="truncate font-bold text-slate-800 dark:text-slate-100">{stock.stockName}</div>
                        <div className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-400 dark:text-slate-500">
                          <span>{stock.stockCode}</span>
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-700 dark:text-slate-300">{candidate.poolLabel}</span>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="h-[42px] border-b border-slate-100 bg-white px-2.5 text-right tabular-nums text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">{stock.auctionPrice > 0 ? stock.auctionPrice.toFixed(2) : '—'}</td>
                  <td className={`h-[42px] border-b border-slate-100 bg-white px-2.5 text-right font-semibold tabular-nums dark:border-slate-700 dark:bg-slate-800 ${pctColor(stock.pctChg)}`}>{formatSignedPct(stock.pctChg)}</td>
                  <td className="h-[42px] border-b border-slate-100 bg-white px-2.5 text-right tabular-nums text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">{stock.currentPrice != null ? stock.currentPrice.toFixed(2) : '—'}</td>
                  <td className={`h-[42px] border-b border-slate-100 bg-white px-2.5 text-right font-semibold tabular-nums dark:border-slate-700 dark:bg-slate-800 ${stock.currentPctChg != null ? pctColor(stock.currentPctChg) : 'text-slate-400'}`}>{formatSignedPct(stock.currentPctChg)}</td>
                  <td className="h-[42px] border-b border-slate-100 bg-white px-2.5 text-right tabular-nums text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">{stock.currentAmount != null ? formatAmount(stock.currentAmount / 10000) : '—'}</td>
                  <td className={`h-[42px] border-b border-slate-100 bg-white px-2.5 text-right font-semibold tabular-nums dark:border-slate-700 dark:bg-slate-800 ${stock.pctChg3d != null ? pctColor(stock.pctChg3d) : 'text-slate-400'}`}>{formatSignedPct(stock.pctChg3d)}</td>
                  <td className={`h-[42px] border-b border-slate-100 bg-white px-2.5 text-right font-semibold tabular-nums dark:border-slate-700 dark:bg-slate-800 ${stock.pctChg5d != null ? pctColor(stock.pctChg5d) : 'text-slate-400'}`}>{formatSignedPct(stock.pctChg5d)}</td>
                  <td className="h-[42px] border-b border-slate-100 bg-white px-2.5 text-right dark:border-slate-700 dark:bg-slate-800">
                    <ThemeAttributionCell candidate={candidate} onSelect={onSelect} />
                  </td>
                  <td className="h-[42px] border-b border-slate-100 bg-white px-2.5 text-right dark:border-slate-700 dark:bg-slate-800">
                    {chipConclusion && chipConclusion.label !== '—'
                      ? <div className="flex flex-col items-end gap-0.5"><span className={`rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold dark:border-slate-700 dark:bg-slate-900 ${chipConclusion.color}`}>{chipConclusion.label}</span><span className={`text-[9px] ${candidate.chipEntry?.dateRelation === 'same_day' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>{candidate.chipEntry?.dateRelation === 'same_day' ? '同日' : `历史 ${candidate.chipEntry?.tradeDate?.slice(4, 6)}/${candidate.chipEntry?.tradeDate?.slice(6, 8)}`}</span></div>
                      : <span className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] ${chipSyncAttempted ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300' : 'border-slate-200 bg-slate-50 text-slate-400 dark:border-slate-700 dark:bg-slate-900'}`}>{getChipSyncPlaceholder(chipSyncAttempted, chipSyncing)}</span>}
                  </td>
                  <td className="h-[42px] border-b border-slate-100 bg-white px-2.5 text-right tabular-nums text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">{formatAmount(stock.auctionAmount)}</td>
                  <td className="h-[42px] border-b border-slate-100 bg-white px-2.5 text-right font-semibold tabular-nums text-blue-600 dark:border-slate-700 dark:bg-slate-800 dark:text-blue-300">{stock.auctionTurnover.toFixed(2)}%</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function InsightPanel({
  candidate,
  insight,
  marketTheme,
  insightLoading,
  updatingItemKey,
  onOpenStock,
  onRegenerate,
  onUpdateVerification,
}: {
  candidate: AuctionCandidate | null
  insight: StructuredInsight | null
  marketTheme: MorningAuctionMarketTheme | null
  insightLoading: boolean
  updatingItemKey: string | null
  onOpenStock: (stock: MorningAuctionStock) => void
  onRegenerate: () => void
  onUpdateVerification: (itemKey: string, status: VerificationStatus) => void
}): JSX.Element {
  const [panelView, setPanelView] = useState<'summary' | 'evidence'>('summary')

  useEffect(() => {
    setPanelView('summary')
  }, [candidate?.id])

  if (!candidate) {
    return (
      <aside className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-400 shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:border-slate-700 dark:bg-slate-800">
        选择一只候选股后查看竞价研判
      </aside>
    )
  }

  const stock = candidate.stock
  const focusEvidence = buildMorningAuctionFocusEvidence(candidate)
  const chipEvidence = insight?.chipEvidence ?? candidate.chipEntry
  const chipConclusion = chipEvidence && chipEvidence.dateRelation !== 'missing'
    ? getConclusion({
        ...chipEvidence,
        pctChg: resolveChipConclusionPctChg(chipEvidence, stock.currentPctChg ?? stock.pctChg),
      })
    : null
  const displayScore = insight?.score ?? candidate.rankScore
  const verificationItems = insight?.verificationItems ?? candidate.verificationItems.map((label, index) => ({
    key: `p1-${index}`,
    label,
    status: 'pending' as VerificationStatus,
    source: 'p1-frontend',
    reason: 'P1 前端派生项, 结构化研判可用后才能持久化。',
    updatedAt: 0,
  }))
  const riskFlags = insight?.riskFlags ?? candidate.riskFlags.map((label, index) => ({
    key: `p1-risk-${index}`,
    label,
    severity: 'medium' as const,
    reason: label,
  }))
  const themeAttribution = stock.themeAttribution ?? insight?.themeAttribution ?? null

  return (
    <aside data-testid="morning-auction-insight-panel" className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:border-slate-700 dark:bg-slate-800 max-xl:h-[620px] max-xl:min-h-[520px]">
      <div className="border-b border-slate-100 bg-slate-50/70 p-3.5 dark:border-slate-700 dark:bg-slate-800/80">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="m-0 text-[15px] font-bold text-slate-950 dark:text-slate-50">选中研判</h2>
            <p className="mt-1 text-[11px] leading-4 text-slate-500 dark:text-slate-400">先看结论与缺口, 再按需进入证据。</p>
          </div>
          <div className="flex shrink-0 whitespace-nowrap rounded-md border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900">
            {(['summary', 'evidence'] as const).map(view => (
              <button
                key={view}
                type="button"
                onClick={() => setPanelView(view)}
                className={`min-w-12 whitespace-nowrap rounded px-2 py-1 text-[11px] font-semibold leading-4 ${panelView === view ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'}`}
              >
                {view === 'summary' ? '研判' : '证据'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3.5">
        <section className="rounded-lg border border-blue-100 bg-gradient-to-b from-blue-50/60 to-white p-3 dark:border-blue-900/60 dark:from-blue-950/30 dark:to-slate-800">
          <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-lg font-bold text-slate-950 dark:text-slate-50">{stock.stockName}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
              <span>{stock.stockCode}</span>
              <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-600 dark:bg-red-950/40 dark:text-red-300">{candidate.signalLabel}</span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-700">{candidate.poolLabel}</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] text-slate-400">研判状态</div>
            <div className="mt-1 text-xs font-semibold text-slate-700 dark:text-slate-200">{insight ? '结构化证据' : '白盒回退'}</div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-md border border-slate-100 bg-white p-2 dark:border-slate-700 dark:bg-slate-900/40"><div className="text-[10px] text-slate-400">竞价金额</div><div className="mt-1 font-semibold text-slate-800 dark:text-slate-100">{formatAmount(stock.auctionAmount)}</div></div>
          <div className="rounded-md border border-slate-100 bg-white p-2 dark:border-slate-700 dark:bg-slate-900/40"><div className="text-[10px] text-slate-400">换手率</div><div className="mt-1 font-semibold text-blue-600 dark:text-blue-300">{stock.auctionTurnover.toFixed(2)}%</div></div>
          <div className="rounded-md border border-slate-100 bg-white p-2 dark:border-slate-700 dark:bg-slate-900/40"><div className="text-[10px] text-slate-400">5日涨跌</div><div className={`mt-1 font-semibold ${stock.pctChg5d != null ? pctColor(stock.pctChg5d) : 'text-slate-400'}`}>{formatSignedPct(stock.pctChg5d)}</div></div>
        </div>
        </section>

        {panelView === 'summary' ? <>
          <section data-testid="morning-auction-theme-driver">
            <h4 className="mb-2 flex items-center justify-between text-xs font-extrabold text-slate-600 dark:text-slate-200">
              这只股今天在炒什么？
              <span className="font-normal text-slate-400">早盘主驱动判断</span>
            </h4>
            {themeAttribution?.primary ? (
              <div className="rounded-md border border-cyan-100 bg-cyan-50/50 p-2.5 dark:border-cyan-900/60 dark:bg-cyan-950/20">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded border border-cyan-200 bg-white px-2 py-0.5 text-xs font-bold text-cyan-800 dark:border-cyan-800 dark:bg-cyan-950/50 dark:text-cyan-100">
                    {themeAttribution.state === 'direct' ? '主炒' : '主炒线索'} · {themeAttribution.primary.name}
                  </span>
                  <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">{getMorningAuctionThemeConfidenceLabel(themeAttribution.confidence)}</span>
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-600 dark:text-slate-300">{themeAttribution.summary}</p>
                {themeAttribution.directReason && (
                  <p className="mt-1.5 border-l-2 border-cyan-400 pl-2 text-[11px] leading-5 text-slate-500 dark:text-slate-400">
                    {formatTradeDate(themeAttribution.sourceTradeDate ?? '')} 原因：{themeAttribution.directReason}
                  </p>
                )}
                {themeAttribution.primary.peers.length > 0 && (
                  <div className="mt-2 text-[11px] leading-5 text-slate-500 dark:text-slate-400">
                    同方向：{themeAttribution.primary.peers.slice(0, 3).map(peer => `${peer.stockName} ${formatSignedPct(peer.auctionPctChg)}`).join(' · ')}
                  </div>
                )}
                {themeAttribution.resonance.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {themeAttribution.resonance.map(item => <span key={item.name} className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">共振 · {item.name}</span>)}
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="rounded-md border border-dashed border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                  {themeAttribution?.summary ?? (stock.conceptNames.length > 0
                    ? `已登记 ${stock.conceptNames.length} 项关联题材，但当前没有足够证据判断哪一项是早盘主驱动。`
                    : '当前没有题材映射，暂时无法判断这只股票早盘在交易什么。')}
                </div>
                {themeAttribution?.directReason && (
                  <p className="border-l-2 border-cyan-400 pl-2 text-[11px] leading-5 text-slate-500 dark:text-slate-400">
                    {formatTradeDate(themeAttribution.sourceTradeDate ?? '')} 直接原因记录：{themeAttribution.directReason}（尚未映射到具体题材）
                  </p>
                )}
              </div>
            )}
          </section>
          <section data-testid="morning-auction-stock-market-confirmation">
            <h4 className="mb-2 flex items-center justify-between text-xs font-extrabold text-slate-600 dark:text-slate-200">
              昨日资金 × 今日竞价
              <span className="font-normal text-slate-400">系统交叉验证</span>
            </h4>
            {marketTheme ? (
              <div className="rounded-md border border-slate-200 bg-slate-50/70 px-3 py-2.5 dark:border-slate-700 dark:bg-slate-900/55">
                <div className="flex min-w-0 items-center gap-2">
                  <strong className="truncate text-xs text-slate-800 dark:text-slate-100">{marketTheme.name}</strong>
                  <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold ${MARKET_THEME_STATE_META[marketTheme.state].className}`}>
                    {MARKET_THEME_STATE_META[marketTheme.state].label}
                  </span>
                </div>
                <p className="mt-1.5 text-[11px] leading-5 text-slate-600 dark:text-slate-300">{marketTheme.summary}</p>
                <div className="mt-2 grid grid-cols-3 gap-1.5 text-[10px]">
                  <div><span className="block text-slate-400">昨日资金</span><strong className="mt-0.5 block text-slate-700 dark:text-slate-200">{formatFlowAmount(marketTheme.flow?.mainNetInflow ?? null)}</strong></div>
                  <div><span className="block text-slate-400">有效共振</span><strong className="mt-0.5 block text-slate-700 dark:text-slate-200">{marketTheme.auction.activeCandidateCount} 只</strong></div>
                  <div><span className="block text-slate-400">龙头集中</span><strong className="mt-0.5 block text-slate-700 dark:text-slate-200">{marketTheme.auction.leaderConcentration == null ? '--' : `${Math.round(marketTheme.auction.leaderConcentration * 100)}%`}</strong></div>
                </div>
                <div className="mt-2 border-l-2 border-amber-400 pl-2 text-[10px] leading-4 text-slate-500 dark:text-slate-400">
                  {marketTheme.flow ? `${formatTradeDate(marketTheme.flow.tradeDate)} · ${marketTheme.flow.matchKind === 'name' ? '板块名称匹配' : '核心股票重合匹配'}；` : ''}{marketTheme.risks[0]}
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-2.5 text-xs leading-5 text-slate-500 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-400">
                该股当前未进入可解释的竞价主线候选。市场主线由系统自动聚合，无需手工设置。
              </div>
            )}
          </section>
          <section>
            <h4 className="mb-2 flex items-center justify-between text-xs font-extrabold text-slate-600 dark:text-slate-200">分时承接预览 <span className="font-normal text-slate-400">本地分钟证据</span></h4>
            {insight?.intradayPreview ? (
              <div className="grid grid-cols-2 gap-1.5 rounded-md border border-slate-100 bg-white p-2.5 text-[11px] dark:border-slate-700 dark:bg-slate-900/40">
                <span className="text-slate-500">相对竞价价</span><strong className={pctColor(insight.intradayPreview.priceVsAuctionPct ?? 0)}>{formatSignedPct(insight.intradayPreview.priceVsAuctionPct)}</strong>
                <span className="text-slate-500">盘中最高涨幅</span><strong>{formatSignedPct(insight.intradayPreview.maxPctChg)}</strong>
                <span className="text-slate-500">开盘后最大回撤</span><strong>{formatSignedPct(insight.intradayPreview.maxDrawdownFromOpen)}</strong>
                <span className="text-slate-500">最近更新</span><strong>{insight.intradayPreview.latestTime ?? '—'}</strong>
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-3 text-xs leading-5 text-slate-500 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-400">
                当前没有可用分钟证据, 分时承接判断受阻。页面不会用模拟走势替代真实数据。
              </div>
            )}
          </section>
          <section>
            <h4 className="mb-2 flex items-center justify-between text-xs font-extrabold text-slate-600 dark:text-slate-200">为什么进入重点 <span className="font-normal text-slate-400">{insight ? '结构化研判' : 'P1 回退'}</span></h4>
            <div className="grid gap-2">
              {focusEvidence.map(item => (
                <div key={item.key} className="rounded-md border border-slate-100 bg-white p-2.5 text-xs leading-5 dark:border-slate-700 dark:bg-slate-900/40">
                  <div className="font-semibold text-slate-700 dark:text-slate-200">{item.label}</div>
                  <div className="mt-0.5 text-slate-500 dark:text-slate-400">{item.text}</div>
                </div>
              ))}
            </div>
          </section>
          <section>
            <h4 className="mb-2 text-xs font-extrabold text-slate-600 dark:text-slate-200">风险与验证</h4>
            <div className="grid gap-2">
              {riskFlags.length > 0 ? riskFlags.slice(0, 2).map(flag => <div key={flag.key} className="rounded-md border border-amber-100 bg-amber-50 p-2.5 text-xs leading-5 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300"><strong>{flag.label}</strong><div className="mt-0.5">{flag.reason}</div></div>) : <span className="text-xs text-slate-400">暂无明显风险标签</span>}
              {verificationItems.filter(item => item.status !== 'checked' && item.status !== 'not_applicable').slice(0, 2).map(item => (
                <div key={item.key} className="rounded-md border border-slate-100 bg-white p-2.5 text-xs dark:border-slate-700 dark:bg-slate-900/40">
                  <div className="flex items-center justify-between gap-2"><strong className="text-slate-700 dark:text-slate-200">{item.label}</strong><span className="text-[10px] text-slate-400">{item.status === 'blocked' ? '受阻' : '待验证'}</span></div>
                  <div className="mt-1 leading-5 text-slate-500 dark:text-slate-400">{item.reason}</div>
                </div>
              ))}
            </div>
          </section>
        </> : <>
        {insight && (
          <section>
            <h4 className="mb-2 text-xs font-extrabold text-slate-600 dark:text-slate-200">分项得分</h4>
            <div className="grid grid-cols-2 gap-1.5">
              {insight.scoreBreakdown.map(item => (
                <div key={item.key} title={item.reason} className="flex items-center justify-between rounded-md border border-slate-100 bg-white px-2 py-1.5 text-[11px] dark:border-slate-700 dark:bg-slate-900/40">
                  <span className="text-slate-500 dark:text-slate-400">{item.label}</span>
                  <strong className={item.contribution < 0 ? 'text-amber-600 dark:text-amber-300' : 'text-slate-800 dark:text-slate-100'}>{item.contribution > 0 ? '+' : ''}{item.contribution}</strong>
                </div>
              ))}
            </div>
          </section>
        )}
        <section>
          <h4 className="mb-2 text-xs font-extrabold text-slate-600 dark:text-slate-200">筹码结论</h4>
          <div className="rounded-md border border-slate-100 bg-white p-2.5 text-xs dark:border-slate-700 dark:bg-slate-900/40">
            {chipConclusion && chipConclusion.label !== '—' ? <><div className="flex items-center justify-between gap-2"><div className={`font-semibold ${chipConclusion.color}`}>{chipConclusion.label}</div><span className={`rounded px-1.5 py-0.5 text-[10px] ${chipEvidence?.dateRelation === 'same_day' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'}`}>{chipEvidence?.dateRelation === 'same_day' ? `同日 ${formatTradeDate(chipEvidence.tradeDate ?? '')}` : `历史参考 ${formatTradeDate(chipEvidence?.tradeDate ?? '')}`}</span></div><div className="mt-1 text-slate-500 dark:text-slate-400">{chipConclusion.tip}</div>{chipEvidence?.dateRelation === 'history' && <div className="mt-1 text-amber-600 dark:text-amber-300">该摘要不参与当前竞价日评分、覆盖统计或自动验证。</div>}</> : <div className="text-slate-400">暂无有效筹码结论，可先同步筹码后复核。</div>}
          </div>
        </section>
        <section>
          <h4 className="mb-2 text-xs font-extrabold text-slate-600 dark:text-slate-200">验证清单</h4>
          <div className="grid gap-2">
            {verificationItems.map(item => (
              <div key={item.key} className="rounded-md border border-slate-100 bg-white p-2.5 text-xs dark:border-slate-700 dark:bg-slate-900/40">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold text-slate-700 dark:text-slate-200">{item.label}</div>
                  {insight ? (
                    <select
                      value={item.status}
                      disabled={updatingItemKey === item.key}
                      onChange={(event) => onUpdateVerification(item.key, event.target.value as VerificationStatus)}
                      className="h-7 rounded border border-slate-200 bg-white px-1.5 text-[11px] text-slate-600 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                    >
                      <option value="pending">待验证</option>
                      <option value="checked">已确认</option>
                      <option value="blocked">受阻</option>
                      <option value="not_applicable">不适用</option>
                    </select>
                  ) : <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-400 dark:bg-slate-700">只读</span>}
                </div>
                <div className="mt-1 leading-5 text-slate-500 dark:text-slate-400">{item.reason}</div>
              </div>
            ))}
          </div>
        </section>
        {insight?.backtestSummary && (
          <section>
            <h4 className="mb-2 text-xs font-extrabold text-slate-600 dark:text-slate-200">历史回测摘要</h4>
            <div className="grid grid-cols-3 gap-1.5 rounded-md border border-slate-100 bg-white p-2.5 text-center text-[11px] dark:border-slate-700 dark:bg-slate-900/40">
              <div><div className="text-slate-400">样本</div><strong>{insight.backtestSummary.sampleSize}</strong></div>
              <div><div className="text-slate-400">胜率</div><strong>{formatSignedPct(insight.backtestSummary.winRate)}</strong></div>
              <div><div className="text-slate-400">平均收益</div><strong className={pctColor(insight.backtestSummary.avgReturn ?? 0)}>{formatSignedPct(insight.backtestSummary.avgReturn)}</strong></div>
            </div>
          </section>
        )}
        <section><h4 className="mb-2 text-xs font-extrabold text-slate-600 dark:text-slate-200">生成状态</h4><div className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-500 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-400">{insight ? `优先级 ${formatScore(displayScore)}, 状态 ${insight.status}, 生成于 ${formatTs(insight.generatedAt)}。人工验证状态会在符合继承条件时保留。` : `当前优先级 ${formatScore(displayScore)}, 使用 P1 白盒回退, 结构化研判缺失或尚未生成。`}</div></section>
        </>}
      </div>

      <div className="grid grid-cols-2 gap-2 border-t border-slate-100 p-3.5 dark:border-slate-700">
        <button type="button" onClick={() => onOpenStock(stock)} className="rounded-md bg-blue-600 px-3 py-2 text-xs font-semibold text-white shadow-[0_6px_16px_rgba(37,99,235,0.18)] hover:bg-blue-700">打开走势图</button>
        <button type="button" onClick={() => setPanelView(panelView === 'summary' ? 'evidence' : 'summary')} className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">{panelView === 'summary' ? '查看证据' : '返回研判'}</button>
        {panelView === 'evidence' && <button type="button" onClick={onRegenerate} disabled={insightLoading} className="col-span-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">{insightLoading ? '生成当前研判中…' : '重建当前研判'}</button>}
      </div>
    </aside>
  )
}

export function MorningAuction({ dataTools, onOpenDataTools }: MorningAuctionProps): JSX.Element {
  const navigateToStock = useAppStore((s) => s.navigateToStock)
  const [snapshot, setSnapshot] = useState<MorningAuctionSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [insightsByKey, setInsightsByKey] = useState<Map<string, StructuredInsight>>(() => new Map())
  const [insightStatus, setInsightStatus] = useState<InsightStatusSummary | null>(null)
  const [insightLoading, setInsightLoading] = useState(false)
  const [insightError, setInsightError] = useState<InsightErrorState | null>(null)
  const [insightFeedback, setInsightFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const [dismissedRecoverySignature, setDismissedRecoverySignature] = useState<string | null>(null)
  const [tradeDateStatus, setTradeDateStatus] = useState<MorningAuctionTradeDateStatus | null>(null)
  const [updatingVerificationKey, setUpdatingVerificationKey] = useState<string | null>(null)
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null)
  const [candidateView, setCandidateView] = useState<CandidateView>('threeOne')
  const [activeMarketThemeName, setActiveMarketThemeName] = useState<string | null>(null)
  const candidateViewBeforeThemeRef = useRef<CandidateView>('threeOne')
  const [candidateSearch, setCandidateSearch] = useState('')
  const [candidateSortMode, setCandidateSortMode] = useState<CandidateSortMode>('rank')
  const [candidateQuickFilter, setCandidateQuickFilter] = useState<CandidateQuickFilter>('all')
  const [filterExchange, setFilterExchange] = useState<ExchangeFilter>('all')
  const [filterConcept, setFilterConcept] = useState<string>('all')
  const [filterST, setFilterST] = useState<'all' | 'excludeST'>('excludeST')
  // FR-136: 历史日期查询，默认当日北京时间
  const [selectedDate, setSelectedDate] = useState<string>(() => todayYmd())
  const selectedDateRef = useRef(selectedDate)
  const snapshotRequestIdRef = useRef(0)
  const chipRequestIdRef = useRef(0)
  const insightRequestIdRef = useRef(0)
  selectedDateRef.current = selectedDate

  // FR-159: 历史回测胜率弹窗
  const [showBacktest, setShowBacktest] = useState(false)

  // FR-228 T1303: 本地兼容型筹码结构摘要（按 tsCode 索引）
  const [chipDataMap, setChipDataMap] = useState<Map<string, ChipEntry>>(() => new Map())
  const [chipSyncing, setChipSyncing] = useState(false)
  const [chipSyncProg, setChipSyncProg] = useState<{ current: number; total: number } | null>(null)
  const [chipSyncAttemptedCodes, setChipSyncAttemptedCodes] = useState<Set<string>>(() => new Set())

  /** 按当前候选集合批量读取本地摘要，不触发远端同步。 */
  const loadChipResults = useCallback(async (currentSnapshot: MorningAuctionSnapshot, referenceTradeDate: string): Promise<Map<string, ChipEntry> | null> => {
    const requestId = ++chipRequestIdRef.current
    try {
      const stocks = collectSnapshotStocks(currentSnapshot)
      const tsCodes = [...new Set(stocks.map(stock => stock.tsCode))]
      if (tsCodes.length === 0) {
        if (requestId === chipRequestIdRef.current && referenceTradeDate === selectedDateRef.current) {
          setChipDataMap(new Map())
        }
        return new Map()
      }
      const res = await window.api.chipStructure.getSummaries({ tsCodes, referenceTradeDate })
      if (!res.ok || requestId !== chipRequestIdRef.current || referenceTradeDate !== selectedDateRef.current) return null
      const map = new Map<string, ChipEntry>()
      for (const summary of res.summaries) {
        map.set(summary.tsCode, summary)
        map.set(summary.tsCode.slice(0, 6), summary)
      }
      setChipDataMap(map)
      return map
    } catch {
      // 静默失败，不影响主流程
      return null
    }
  }, [])

  /** 同步当前 snapshot 股票的筹码数据 */
  const handleSyncChips = useCallback(async (): Promise<void> => {
    if (!snapshot || chipSyncing) return
    const seen = new Set<string>()
    const stocks: { tsCode: string; stockName: string | null; source: 'screener' | 'watchlist' | 'morningAuction' }[] = []
    for (const s of collectSnapshotStocks(snapshot)) {
      if (!seen.has(s.tsCode)) {
        seen.add(s.tsCode)
        // 用独立来源 morningAuction，与 watchlist/screener 池隔离
        stocks.push({ tsCode: s.tsCode, stockName: s.stockName, source: 'morningAuction' })
      }
    }
    if (stocks.length === 0) return
    setError(null)
    setChipSyncAttemptedCodes(new Set(stocks.map((stock) => stock.tsCode.slice(0, 6))))
    setChipSyncing(true)
    setChipSyncProg({ current: 0, total: stocks.length })
    const unsubProgress = window.api.shortTerm.onChipMonitorProgress((p) => {
      setChipSyncProg({ current: p.done, total: p.total })
    })
    const unsubDone = window.api.shortTerm.onChipMonitorDone((outcome) => {
      unsubProgress()
      unsubDone()
      void loadChipResults(snapshot, snapshot.tradeDate).finally(() => {
        setChipSyncing(false)
        setChipSyncProg(null)
        setInsightFeedback({
          kind: outcome.failed > 0 ? 'error' : 'success',
          message: outcome.failed > 0
            ? `筹码同步完成：${outcome.success} 只生成结论，${outcome.failed} 只未取得上游筹码，可稍后重试。`
            : `筹码同步完成：${outcome.success} 只股票已生成筹码结论。`,
        })
      })
    })
    try {
      const res = await window.api.shortTerm.chipMonitorStart({ stocks, mode: 'relative' })
      if (!res.ok) {
        unsubProgress()
        unsubDone()
        setChipSyncing(false)
        setChipSyncProg(null)
        setChipSyncAttemptedCodes(new Set())
        const message = res.error === 'TUSHARE_DISABLED'
          ? '筹码同步失败：Tushare 未启用或 token 不可用'
          : res.error === 'JOB_RUNNING'
            ? '筹码同步失败：已有筹码同步任务正在运行'
            : `筹码同步失败：${res.error}`
        setError(message)
      }
    } catch {
      unsubProgress()
      unsubDone()
      setChipSyncing(false)
      setChipSyncProg(null)
      setChipSyncAttemptedCodes(new Set())
      setError('筹码同步失败：请求未成功发送')
    }
  }, [snapshot, chipSyncing, loadChipResults])

  // FR-139/FR-228: 双击打开近期日K与筹码峰抽屉
  const [clickedStock, setClickedStock] = useState<{
    tsCode: string; stockCode: string; stockName: string
  } | null>(null)

  const handleStockClick = useCallback((s: MorningAuctionStock): void => {
    setClickedStock({ tsCode: s.tsCode, stockCode: s.stockCode, stockName: s.stockName })
  }, [])

  const loadInsights = useCallback(async (tradeDate: string, force = false, tsCode?: string): Promise<void> => {
    const requestId = ++insightRequestIdRef.current
    setInsightLoading(true)
    setInsightError(null)
    if (force) setInsightFeedback(null)
    try {
      const res = await window.api.shortTerm.morningAuction.generateInsights({ tradeDate, force, tsCode })
      if (requestId !== insightRequestIdRef.current || tradeDate !== selectedDateRef.current) return
      if (!res.ok) {
        setInsightError({
          code: res.error.code,
          message: res.error.message,
          details: res.error.details,
          recommendedTradeDate: res.error.recommendedTradeDate,
        })
        if (force) setInsightFeedback({ kind: 'error', message: `结构化研判重建失败: ${res.error.message}` })
        return
      }
      setInsightsByKey(current => {
        const next = tsCode ? new Map(current) : new Map<string, StructuredInsight>()
        for (const insight of res.insights) next.set(insightKey(insight.tsCode, insight.poolKey), insight)
        return next
      })
      setInsightStatus((current) => current ? {
        ...current,
        tradeDate,
        generatedAt: res.insights.reduce<number | null>((latest, insight) => latest == null || insight.generatedAt > latest ? insight.generatedAt : latest, current.generatedAt),
        ...(tsCode ? {} : {
          completedCount: res.insights.length,
          missingCount: Math.max(0, current.completedCount + current.missingCount - res.insights.length),
          blockedVerificationCount: res.insights.reduce((sum, insight) => sum + insight.verificationItems.filter(item => item.status === 'blocked').length, 0),
        }),
      } : null)
      if (force) setInsightFeedback({
        kind: 'success',
        message: tsCode ? `已重建当前股票研判, 更新 ${res.insights.length} 条记录` : `结构化研判重建完成, 更新 ${res.insights.length} 条记录`,
      })
    } catch (cause) {
      if (requestId !== insightRequestIdRef.current || tradeDate !== selectedDateRef.current) return
      const message = cause instanceof Error ? cause.message : String(cause)
      setInsightError({ message })
      if (force) setInsightFeedback({ kind: 'error', message: `结构化研判重建失败: ${message}` })
    } finally {
      if (requestId === insightRequestIdRef.current) setInsightLoading(false)
    }
  }, [])

  const loadSnapshot = useCallback(async (forceRefresh = false, date?: string): Promise<void> => {
    const requestId = ++snapshotRequestIdRef.current
    const targetDate = date ?? selectedDateRef.current
    setLoading(true)
    setError(null)
    try {
      const res = forceRefresh
        ? await window.api.shortTerm.morningAuction.refresh(targetDate)
        : await window.api.shortTerm.morningAuction.get(targetDate)
      if (requestId !== snapshotRequestIdRef.current || targetDate !== selectedDateRef.current) return
      if (res.ok) {
        const nextSnapshot = res.snapshot as MorningAuctionSnapshot
        setSnapshot(nextSnapshot)
        setTradeDateStatus(res.tradeDateStatus)
        setInsightStatus(res.insightStatus)
        void loadChipResults(nextSnapshot, nextSnapshot.tradeDate)
        if (res.tradeDateStatus.isTradeDay) void loadInsights(nextSnapshot.tradeDate, false)
      }
    } catch (e) {
      if (requestId !== snapshotRequestIdRef.current || targetDate !== selectedDateRef.current) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (requestId === snapshotRequestIdRef.current) setLoading(false)
    }
  }, [loadChipResults, loadInsights])

  useEffect(() => {
    snapshotRequestIdRef.current += 1
    chipRequestIdRef.current += 1
    insightRequestIdRef.current += 1
    setSnapshot(null)
    setChipDataMap(new Map())
    setInsightsByKey(new Map())
    setInsightStatus(null)
    setTradeDateStatus(null)
    setSelectedCandidateId(null)
    setActiveMarketThemeName(null)
    setCandidateView('threeOne')
    setInsightLoading(false)
    setChipSyncAttemptedCodes(new Set())
    void loadSnapshot(false, selectedDate)
  }, [loadSnapshot, selectedDate])

  // FR-134: 若 3d/5d 数据尚未就绪（后端异步填充中），5s 后自动二次拉取
  useEffect(() => {
    if (!snapshot) return
    const allPools = collectSnapshotStocks(snapshot)
    const hasMissing = allPools.length > 0 && allPools.some(s => s.pctChg3d === null || s.pctChg5d === null || s.conceptNames.length === 0)
    if (!hasMissing) return
    const timer = setTimeout(() => void loadSnapshot(false, snapshot.tradeDate), 5000)
    return () => clearTimeout(timer)
  }, [snapshot, loadSnapshot])

  // 动态收集当前 snapshot 所有候选股的题材集合（排除 null 和重复）
  const conceptOptions = useMemo<string[]>(() => {
    if (!snapshot) return []
    const all = collectSnapshotStocks(snapshot)
    const set = new Set<string>()
    for (const s of all) {
      for (const name of s.conceptNames) {
        if (name) set.add(name)
      }
    }
    return [...set].sort()
  }, [snapshot])

  // 应用筛选生成新快照对象（不修改原始 snapshot 缓存）
  const filteredSnapshot = useMemo<MorningAuctionSnapshot | null>(() => {
    if (!snapshot) return null
    const keep = (s: MorningAuctionStock): boolean => {
      if (filterExchange !== 'all' && classifyExchange(s.tsCode) !== filterExchange) return false
      if (filterConcept !== 'all' && !s.conceptNames.includes(filterConcept)) return false
      if (filterST === 'excludeST' && /ST/i.test(s.stockName)) return false
      return true
    }
    return {
      ...snapshot,
      threeOne: {
        firstBoard: snapshot.threeOne.firstBoard.filter(keep),
        secondBoard: snapshot.threeOne.secondBoard.filter(keep),
        brokenBoard: snapshot.threeOne.brokenBoard.filter(keep),
        brokenConsec: snapshot.threeOne.brokenConsec.filter(keep),
        allMarket: snapshot.threeOne.allMarket.filter(keep),
      },
      weakToStrong: {
        badBoard: snapshot.weakToStrong.badBoard.filter(keep),
        tailAttack: snapshot.weakToStrong.tailAttack.filter(keep),
        brokenBoard: snapshot.weakToStrong.brokenBoard.filter(keep),
        afternoonReseal: snapshot.weakToStrong.afternoonReseal.filter(keep),
        reversal: snapshot.weakToStrong.reversal.filter(keep),
      },
      boardCategory: {
        first: snapshot.boardCategory.first.filter(keep) as BoardCategoryStock[],
        second: snapshot.boardCategory.second.filter(keep) as BoardCategoryStock[],
        third: snapshot.boardCategory.third.filter(keep) as BoardCategoryStock[],
        n: snapshot.boardCategory.n.filter(keep) as BoardCategoryStock[],
      },
    }
  }, [snapshot, filterExchange, filterConcept, filterST])

  const workbench = useMemo(() => buildMorningAuctionWorkbench(filteredSnapshot, chipDataMap), [filteredSnapshot, chipDataMap])
  const activeMarketTheme = useMemo(() => {
    if (!activeMarketThemeName) return null
    return snapshot?.marketThemes?.themes.find((theme) => theme.name === activeMarketThemeName) ?? null
  }, [activeMarketThemeName, snapshot?.marketThemes?.themes])
  const activeMarketThemeCodes = useMemo(
    () => new Set((activeMarketTheme?.stockCodes ?? []).map((code) => code.split('.')[0])),
    [activeMarketTheme],
  )
  const visibleCandidates = useMemo(() => {
    const query = candidateSearch.trim().toLowerCase()
    const filtered = workbench.candidates.filter(candidate => {
      const stock = candidate.stock
      if (!matchCandidateView(candidate, candidateView)) return false
      if (activeMarketThemeCodes.size > 0 && !activeMarketThemeCodes.has(stock.stockCode)) return false
      if (candidateQuickFilter === 'limitUp' && (stock.currentPctChg ?? stock.pctChg) < 9.8) return false
      if (candidateQuickFilter === 'withChip' && !hasChipEntry(candidate)) return false
      if (candidateQuickFilter === 'missingHistory' && stock.pctChg3d != null && stock.pctChg5d != null) return false
      if (!query) return true
      return stock.stockCode.includes(query)
        || stock.tsCode.toLowerCase().includes(query)
        || stock.stockName.toLowerCase().includes(query)
        || stock.conceptNames.some(name => name.toLowerCase().includes(query))
    })
    return sortCandidates(filtered, candidateSortMode, candidate => insightsByKey.get(insightKey(candidate.stock.tsCode, candidate.poolKey))?.score ?? candidate.rankScore)
  }, [activeMarketThemeCodes, candidateQuickFilter, candidateSearch, candidateSortMode, candidateView, insightsByKey, workbench.candidates])

  const selectedCandidate = useMemo(() => {
    if (visibleCandidates.length === 0) return null
    return visibleCandidates.find(candidate => candidate.id === selectedCandidateId) ?? visibleCandidates[0]
  }, [visibleCandidates, selectedCandidateId])

  const selectedInsight = useMemo(() => {
    if (!selectedCandidate) return null
    return insightsByKey.get(insightKey(selectedCandidate.stock.tsCode, selectedCandidate.poolKey)) ?? null
  }, [insightsByKey, selectedCandidate])

  const selectedCandidateMarketTheme = useMemo(() => {
    if (!selectedCandidate) return null
    const code = selectedCandidate.stock.stockCode
    if (activeMarketTheme?.stockCodes.some((item) => item.split('.')[0] === code)) return activeMarketTheme
    return snapshot?.marketThemes?.themes.find((theme) => theme.stockCodes.some((item) => item.split('.')[0] === code)) ?? null
  }, [activeMarketTheme, selectedCandidate, snapshot?.marketThemes?.themes])

  const handleSelectCandidateView = useCallback((view: CandidateView): void => {
    setActiveMarketThemeName(null)
    setCandidateView(view)
    setSelectedCandidateId(null)
  }, [])

  const handleSelectMarketTheme = useCallback((theme: MorningAuctionMarketTheme): void => {
    if (activeMarketThemeName === theme.name) {
      setActiveMarketThemeName(null)
      setCandidateView(candidateViewBeforeThemeRef.current)
    } else {
      if (!activeMarketThemeName) candidateViewBeforeThemeRef.current = candidateView
      setActiveMarketThemeName(theme.name)
      setCandidateView('all')
    }
    setSelectedCandidateId(null)
  }, [activeMarketThemeName, candidateView])

  const handleUpdateVerification = useCallback(async (itemKey: string, status: VerificationStatus): Promise<void> => {
    if (!selectedCandidate || !selectedInsight) return
    setUpdatingVerificationKey(itemKey)
    setInsightError(null)
    try {
      const res = await window.api.shortTerm.morningAuction.updateVerification({
        tradeDate: selectedInsight.tradeDate,
        tsCode: selectedInsight.tsCode,
        poolKey: selectedInsight.poolKey,
        itemKey,
        status,
      })
      if (!res.ok) {
        setInsightError({ message: res.error.message })
        return
      }
      setInsightsByKey(current => {
        const next = new Map(current)
        next.set(insightKey(res.insight.tsCode, res.insight.poolKey), res.insight)
        return next
      })
    } catch (cause) {
      setInsightError({ message: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setUpdatingVerificationKey(null)
    }
  }, [selectedCandidate, selectedInsight])

  useEffect(() => {
    if (visibleCandidates.length === 0) {
      setSelectedCandidateId(null)
      return
    }
    if (!selectedCandidateId || !visibleCandidates.some(candidate => candidate.id === selectedCandidateId)) {
      setSelectedCandidateId(visibleCandidates[0].id)
    }
  }, [selectedCandidateId, visibleCandidates])

  const handleOpenStock = useCallback((stock: MorningAuctionStock): void => {
    navigateToStock(stock.stockCode, stock.stockName)
  }, [navigateToStock])

  const headlineCandidate = selectedCandidate ?? workbench.candidates[0] ?? null
  const headlineStock = headlineCandidate?.stock ?? null
  const candidateRecordCount = snapshot ? collectSnapshotStocks(snapshot).length : 0
  const recoveryState = useMemo(() => buildMorningAuctionRecoveryState({
    loadError: error,
    insightError,
    tradeDateStatus,
    uniqueStockCount: workbench.totalCandidates,
    candidateRecordCount,
    generatedInsightCount: insightStatus?.completedCount ?? insightsByKey.size,
    missingInsightCount: insightStatus?.missingCount ?? Math.max(0, candidateRecordCount - insightsByKey.size),
    blockedEvidenceCount: insightStatus?.blockedVerificationCount ?? 0,
    insights: [...insightsByKey.values()],
  }), [candidateRecordCount, error, insightError, insightStatus, insightsByKey, tradeDateStatus, workbench.totalCandidates])
  const recoverySignature = useMemo(() => JSON.stringify(recoveryState.issues.map(issue => ({
    key: issue.key,
    title: issue.title,
    description: issue.description,
    impact: issue.impact,
    count: issue.count ?? 0,
  }))), [recoveryState.issues])
  const visibleRecoveryIssues = dismissedRecoverySignature === recoverySignature ? [] : recoveryState.issues

  useEffect(() => {
    if (!insightFeedback) return
    const timer = window.setTimeout(() => setInsightFeedback(null), 5000)
    return () => window.clearTimeout(timer)
  }, [insightFeedback])

  const handleRecoveryAction = useCallback((action: MorningAuctionRecoveryAction): void => {
    if (action === 'relaunch') {
      void window.api.app.relaunch()
      return
    }
    if (action === 'switchTradeDate' && recoveryState.recommendedTradeDate) {
      setSelectedDate(recoveryState.recommendedTradeDate)
      return
    }
    if (action === 'refreshSnapshot') {
      void loadSnapshot(true, selectedDate)
      return
    }
    if (action === 'regenerateInsights') {
      void loadInsights(selectedDate, true)
      return
    }
    if (action === 'syncChips') {
      void handleSyncChips()
      return
    }
    if (action === 'openDataTools') {
      onOpenDataTools?.()
      return
    }
    if (action === 'openStock' && headlineStock) {
      handleOpenStock(headlineStock)
      return
    }
    if (action === 'openBacktest') setShowBacktest(true)
  }, [handleOpenStock, handleSyncChips, headlineStock, loadInsights, loadSnapshot, onOpenDataTools, recoveryState.recommendedTradeDate, selectedDate])

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[#f5f7fb] text-slate-700 dark:bg-slate-950 dark:text-slate-200">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
          <span className="text-slate-700 dark:text-slate-200">短线策略</span>
          <span className="text-slate-300">/</span>
          <span className="text-slate-900 dark:text-slate-50">早盘集合竞价</span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
          <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 dark:border-slate-700 dark:bg-slate-800">竞价数据 <strong className="text-slate-700 dark:text-slate-200">stk_auction</strong></span>
          <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 dark:border-slate-700 dark:bg-slate-800">自动刷新 <strong className="text-slate-700 dark:text-slate-200">60s</strong></span>
        </div>
      </div>

      <BacktestModal open={showBacktest} onClose={() => setShowBacktest(false)} />

      {insightFeedback && (
        <div className={`fixed right-4 top-14 z-[10020] max-w-sm rounded-md border px-3 py-2 text-xs shadow-lg ${insightFeedback.kind === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200' : 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200'}`} role="status">
          {insightFeedback.message}
        </div>
      )}

      {snapshot?.isMock && (
        <div className="shrink-0 border-b border-amber-300 bg-amber-50 px-4 py-1.5 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
          当前为 Mock 演示数据：Tushare 374 套餐尚未开通，待接入真实接口后将切换为实时数据。
        </div>
      )}

      <RecoveryPanel
        key={recoverySignature}
        issues={visibleRecoveryIssues}
        onAction={handleRecoveryAction}
        onClose={() => setDismissedRecoverySignature(recoverySignature)}
        insightLoading={insightLoading}
      />

      <section className="grid h-full min-h-0 flex-1 grid-cols-[minmax(0,1fr)_292px] grid-rows-[auto_auto_auto_minmax(0,1fr)] gap-2 overflow-hidden p-2.5 max-xl:grid-cols-1 max-xl:grid-rows-[auto_auto_auto_auto_auto] max-xl:overflow-auto">
        <div className="col-span-full">
          <div className="grid min-h-[92px] grid-cols-[minmax(320px,1fr)_minmax(540px,auto)] gap-4 rounded-lg border border-slate-200 bg-white p-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:border-slate-700 dark:bg-slate-800 max-2xl:grid-cols-[minmax(300px,0.8fr)_minmax(500px,1.2fr)] max-xl:grid-cols-1">
            <div className="min-w-0">
              <h1 className="m-0 text-lg font-bold leading-tight text-slate-950 dark:text-slate-50">早盘集合竞价战情台</h1>
              <p className="mt-1.5 max-w-[760px] text-xs leading-5 text-slate-500 dark:text-slate-400">
                先看竞价强度与可行动性，再进入题材、筹码和历史胜率验证。当前聚焦 {headlineCandidate ? headlineCandidate.signalLabel : '竞价候选'}。
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">交易日 {formatTradeDate(selectedDate)}</span>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-500 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-400">更新 {snapshot ? formatTs(snapshot.generatedAt) : '—'}</span>
                <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">{workbench.missingHistoryCount} 项待补验证</span>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-500 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-400">右侧收纳当前行证据</span>
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">股票 {recoveryState.stats.uniqueStockCount} · 池记录 {recoveryState.stats.candidateRecordCount}</span>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-500 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-400">结构化 已生成 {recoveryState.stats.generatedInsightCount} · 待生成 {recoveryState.stats.missingInsightCount} · 受阻证据 {recoveryState.stats.blockedEvidenceCount}</span>
              </div>
            </div>
            <div className="grid min-w-0 content-between gap-3 border-l border-slate-100 pl-4 dark:border-slate-700 max-xl:border-l-0 max-xl:border-t max-xl:pl-0 max-xl:pt-3">
              <div className="flex flex-wrap items-center justify-end gap-2 max-xl:justify-start">
                <button
                  type="button"
                  onClick={() => void loadSnapshot(true, selectedDate)}
                  disabled={loading}
                  className="h-8 whitespace-nowrap rounded-md border border-blue-600 bg-blue-600 px-3 text-xs font-semibold text-white shadow-[0_6px_16px_rgba(37,99,235,0.18)] hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loading ? '刷新中…' : '立即刷新'}
                </button>
                <button type="button" data-testid="morning-auction-backtest-trigger" onClick={() => setShowBacktest(true)} className="h-8 whitespace-nowrap rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">历史回测胜率</button>
                <button
                  type="button"
                  onClick={() => void handleSyncChips()}
                  disabled={chipSyncing || !snapshot}
                  className="h-8 whitespace-nowrap rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  {chipSyncing ? `同步 ${chipSyncProg ? `${chipSyncProg.current}/${chipSyncProg.total}` : '…'}` : '同步筹码'}
                </button>
                {dataTools}
              </div>
              <div className="grid grid-cols-4 divide-x divide-slate-100 border-t border-slate-100 pt-2.5 dark:divide-slate-700 dark:border-slate-700 max-md:grid-cols-2 max-md:gap-y-2 max-md:divide-x-0">
                {[
                  { label: '竞价候选', value: workbench.totalCandidates, detail: '去重排序', color: 'text-red-600 dark:text-red-300' },
                  { label: '强意图', value: workbench.highIntentCount, detail: '多项确认', color: 'text-amber-600 dark:text-amber-300' },
                  { label: '涨停确认', value: workbench.limitUpCount, detail: '触及阈值', color: 'text-red-600 dark:text-red-300' },
                  { label: '同日筹码', value: workbench.chipCoveredCount, detail: '有效覆盖', color: 'text-emerald-600 dark:text-emerald-300' },
                ].map((metric, index) => (
                  <div key={metric.label} className={`min-w-0 px-3 first:pl-0 last:pr-0 max-md:px-0 ${index % 2 === 1 ? 'max-md:border-l max-md:border-slate-100 max-md:pl-3 dark:max-md:border-slate-700' : ''}`}>
                    <div className="flex items-baseline justify-between gap-2 whitespace-nowrap">
                      <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{metric.label}</span>
                      <strong className={`text-xl font-bold tabular-nums leading-none ${metric.color}`}>{metric.value}</strong>
                    </div>
                    <div className="mt-1 truncate text-[10px] text-slate-400">{metric.detail}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <PoolStrip
          candidates={workbench.candidates}
          missingHistoryCount={workbench.missingHistoryCount}
          activeView={candidateView}
          onSelectView={handleSelectCandidateView}
        />

        <MarketThemeStrip
          summary={snapshot?.marketThemes ?? null}
          snapshotLoaded={snapshot !== null}
          activeThemeName={activeMarketThemeName}
          onSelectTheme={handleSelectMarketTheme}
          onRelaunch={() => void window.api.app.relaunch()}
        />

        <section data-testid="morning-auction-candidate-area" className="col-start-1 flex h-full min-h-0 min-w-0 flex-col gap-2 overflow-hidden max-xl:h-auto max-xl:min-h-[720px]">
          <div className="flex shrink-0 items-center gap-2 rounded-lg border border-slate-200 bg-white p-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:border-slate-700 dark:bg-slate-800 max-xl:flex-wrap">
            <div className="inline-flex shrink-0 rounded-lg bg-slate-100 p-1 dark:bg-slate-900">
              {SEGMENTED_VIEWS.map(view => (
                <button
                  key={view.key}
                  type="button"
                  onClick={() => handleSelectCandidateView(view.key)}
                  className={`h-7 whitespace-nowrap rounded-md px-3 text-xs font-semibold ${candidateView === view.key
                    ? 'bg-white text-blue-600 shadow-sm dark:bg-slate-800 dark:text-blue-300'
                    : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'}`}
                >
                  {view.label}
                </button>
              ))}
            </div>
            <input
              type="search"
              value={candidateSearch}
              onChange={(event) => setCandidateSearch(event.target.value)}
              placeholder="按代码、名称、题材搜索"
              className="h-8 w-48 shrink-0 rounded-md border border-slate-200 bg-white px-2.5 text-xs text-slate-600 placeholder:text-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            />
            <label className="flex shrink-0 items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
              交易日
              <input
                type="date"
                value={ymdToDash(selectedDate)}
                max={ymdToDash(todayYmd())}
                onChange={(e) => {
                  if (!e.target.value) return
                  const newYmd = dashToYmd(e.target.value)
                  selectedDateRef.current = newYmd
                  setSelectedDate(newYmd)
                }}
                className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              />
            </label>
            <div className="min-w-0 flex-1 max-xl:hidden" />
            <select
              value={candidateSortMode}
              onChange={(e) => setCandidateSortMode(e.target.value as CandidateSortMode)}
              className="h-8 shrink-0 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            >
              <option value="rank">强度降序</option>
              <option value="auctionAmount">金额降序</option>
              <option value="auctionPct">竞价涨幅</option>
              <option value="turnover">换手降序</option>
            </select>
            <select
              value={candidateQuickFilter}
              onChange={(e) => setCandidateQuickFilter(e.target.value as CandidateQuickFilter)}
              className="h-8 shrink-0 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            >
              <option value="all">全部状态</option>
              <option value="limitUp">只看涨停</option>
              <option value="withChip">同日筹码</option>
              <option value="missingHistory">涨跌待补</option>
            </select>
            <select
              value={filterST}
              onChange={(e) => setFilterST(e.target.value as 'all' | 'excludeST')}
              className="h-8 shrink-0 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            >
              <option value="all">含 ST</option>
              <option value="excludeST">除 ST</option>
            </select>
            <select
              value={filterExchange}
              onChange={(e) => setFilterExchange(e.target.value as ExchangeFilter)}
              className="h-8 shrink-0 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            >
              {EXCHANGE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <select
              value={filterConcept}
              onChange={(e) => setFilterConcept(e.target.value)}
              className="h-8 shrink-0 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            >
              <option value="all">全部题材</option>
              {conceptOptions.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <CandidateQueue
            candidates={visibleCandidates}
            selectedId={selectedCandidate?.id ?? null}
            title={activeMarketTheme ? `竞价主线 · ${activeMarketTheme.name}` : getCandidateViewLabel(candidateView)}
            selectedName={selectedCandidate?.stock.stockName ?? null}
            chipSyncAttemptedCodes={chipSyncAttemptedCodes}
            chipSyncing={chipSyncing}
            onSelect={(candidate) => setSelectedCandidateId(candidate.id)}
            onStockClick={handleStockClick}
          />
        </section>

        <InsightPanel
          candidate={selectedCandidate}
          insight={selectedInsight}
          marketTheme={selectedCandidateMarketTheme}
          insightLoading={insightLoading}
          updatingItemKey={updatingVerificationKey}
          onOpenStock={handleOpenStock}
          onRegenerate={() => selectedCandidate && void loadInsights(snapshot?.tradeDate ?? selectedDate, true, selectedCandidate.stock.tsCode)}
          onUpdateVerification={(itemKey, status) => void handleUpdateVerification(itemKey, status)}
        />
      </section>

      {/* FR-139/FR-228: 股票近期日K与筹码峰抽屉 */}
      {clickedStock && (
        <StockKlineChipDrawer
          tsCode={clickedStock.tsCode}
          stockName={clickedStock.stockName}
          onClose={() => setClickedStock(null)}
          onNavigate={() => {
            navigateToStock(clickedStock.stockCode, clickedStock.stockName)
            setClickedStock(null)
          }}
        />
      )}
    </div>
  )
}
