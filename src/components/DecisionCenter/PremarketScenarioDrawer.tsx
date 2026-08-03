import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  PremarketAIExplanationView,
  PremarketCalibrationView,
  PremarketOutcomeReadView,
  PremarketPreparationReadResponse,
  PremarketPreparationView,
  PremarketScenarioBranch,
  PremarketScenarioReadResponse,
  PremarketScenarioRetryProgress,
  PremarketScenarioView,
} from '../../../electron/main/services/premarketRehearsalTypes'
import type { PremarketCaptureStatusView } from '../../../electron/main/services/premarketCaptureCoordinator'
import { RightDrawer } from '../shared/RightDrawer'
import {
  buildPremarketUserConclusion,
  type PremarketConclusionTone,
} from './premarketScenarioConclusion'

interface PremarketScenarioDrawerProps {
  open: boolean
  onClose: () => void
  onOpenCaptureSettings?: () => void
}

function formatDate(value: string | null): string {
  if (!value || !/^\d{8}$/.test(value)) return '未知'
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function formatClock(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function formatScenarioStage(version: PremarketScenarioView): string {
  return version.stage === 'auction_confirmed'
    ? `${formatClock(version.cutoffAt)}确认版`
    : `${formatClock(version.cutoffAt)}初版`
}

function formatPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '未知'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function formatAmount(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '未知'
  const absolute = Math.abs(value)
  if (absolute >= 100_000_000) return `${value >= 0 ? '+' : ''}${(value / 100_000_000).toFixed(2)}亿`
  if (absolute >= 10_000) return `${value >= 0 ? '+' : ''}${(value / 10_000).toFixed(1)}万`
  return `${value >= 0 ? '+' : ''}${value.toFixed(0)}`
}

const STATUS_LABEL = {
  ready: '证据完整',
  partial: '部分可用',
  blocked: '推演受阻',
} as const

const COMPACT_DRAWER_ACTION_CLASS = 'inline-flex h-8 min-w-[68px] shrink-0 items-center justify-center whitespace-nowrap rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium leading-none text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:focus-visible:ring-offset-slate-950'

interface EvidenceGapDetail {
  key: string
  title: string
  detail: string
}

interface EvidenceDiagnosis {
  issues: EvidenceGapDetail[]
  readySummary: string
  recovery: string
}

function buildEvidenceDiagnosis(
  version: PremarketScenarioView,
  captureStatus: PremarketCaptureStatusView | null,
): EvidenceDiagnosis {
  const issues: EvidenceGapDetail[] = []
  const warnings = new Set(version.warnings)
  const externalUnavailable = version.evidence.market.baseFactSnapshotId == null
    || version.evidence.market.snapshotStatus === 'blocked'
    || version.evidence.market.snapshotStatus === 'failed'
    || version.evidence.market.externalRiskTone === 'insufficient'

  if (externalUnavailable) {
    const detail = version.revisionKind === 'manual_backfill'
      ? `本次历史补采后仅取得 ${version.evidence.market.eligibleAssetCount} 项风险资产、${version.evidence.market.regionCount} 个地区，仍未达到至少3项且跨2个地区的门槛。`
      : captureStatus && !captureStatus.enabled
        ? '自动采集当前关闭；仍可点击“重新补采”，按08:45截点读取Tushare与公共历史接口。'
        : version.evidence.market.snapshotStatus === 'failed'
          ? '08:45外盘来源请求失败；可重新补采，失败的Tushare路径会自动回退公共历史接口。'
          : version.evidence.market.snapshotStatus === 'blocked'
            ? '08:45固定快照受阻；可重新补采历史分钟与已闭市日线，晚于08:45的数据不会进入。'
            : '08:45外盘快照没有形成；可重新补采历史事实并追加不可变修订。'
    issues.push({ key: 'asia-open', title: '08:45 外盘快照未形成', detail })
  }

  if (warnings.has('ASIA_OPEN_SCENARIO_VERSION_MISSING')) {
    issues.push({
      key: 'initial-version',
      title: '08:45 初版缺失',
      detail: `${formatScenarioStage(version)}没有可引用的同日初版，无法比较盘前证据如何变化。`,
    })
  }

  if (version.stage === 'auction_confirmed' && version.evidence.auctionMatchedCount === 0) {
    const names = version.evidence.holdings
      .filter((holding) => holding.auction == null)
      .map((holding) => holding.stockName)
    const nameText = names.length > 0 ? `（${names.slice(0, 4).join('、')}${names.length > 4 ? '等' : ''}）` : ''
    const cutoffClock = formatClock(version.cutoffAt)
    issues.push({
      key: 'auction',
      title: `${cutoffClock} 持仓竞价未命中${nameText}`,
      detail: version.revisionKind === 'manual_backfill'
        ? `本次补采后仍未取得交易日对应的09:25定稿竞价，不能用盘中价格替代。`
        : `当前持仓没有匹配到交易日对应的09:25定稿竞价；可显式重新补采历史竞价后生成新修订。`,
    })
  }

  if (version.evidence.previousTradeDate == null) {
    issues.push({ key: 'trade-date', title: '上一交易日未知', detail: '交易日历没有提供上一交易日，历史事实无法按统一日期截断。' })
  }
  if (version.evidence.holdings.length === 0) {
    issues.push({ key: 'portfolio', title: '当前没有持仓', detail: '盘前推演以当前持仓为对象，空组合不会生成方向性结论。' })
  }

  const trendReady = version.evidence.holdings.filter((holding) => holding.trend.status === 'ready').length
  const chipReady = version.evidence.holdings.filter((holding) => holding.chip.status === 'ready').length
  const sectorReady = version.evidence.sectors.filter((sector) => sector.mainNetInflow != null).length
  const holdingCount = version.evidence.holdings.length
  const readySummary = holdingCount > 0
    ? `已具备：趋势 ${trendReady}/${holdingCount} 只、筹码 ${chipReady}/${holdingCount} 只、行业/题材资金 ${sectorReady}/${version.evidence.sectors.length} 项、盘前资讯 ${version.evidence.market.briefings.length} 条。`
    : `已具备：行业/题材资金 ${sectorReady}/${version.evidence.sectors.length} 项、盘前资讯 ${version.evidence.market.briefings.length} 条。`

  const nextRun = captureStatus?.nextRun
  const nextRunText = nextRun
    ? `${formatDate(nextRun.tradeDate)} ${nextRun.stage === 'overnight' ? '07:30' : '08:45'}`
    : null
  const recovery = `当前修订保持冻结；“重新补采”只会读取可按交易日或发布时间还原的事实，并追加新修订。外盘优先使用Tushare已闭市日线，并以公共历史接口恢复08:45日韩分钟；无Tushare权限时自动使用公共接口。${nextRunText ? ` 下次自动采集 ${nextRunText}。` : ''}`

  if (issues.length === 0 && version.status === 'blocked') {
    issues.push({ key: 'unknown', title: '关键证据未通过完整性校验', detail: '当前版本保留了既有事实，但不足以形成方向性推演。' })
  }
  return { issues, readySummary, recovery }
}

const OUTCOME_LABEL = {
  gap_up_fade: '高开回落',
  gap_up_hold: '高开承接',
  low_or_flat_rebound: '低/平开修复',
  weak_all_day: '全天偏弱',
  mixed: '路径混合',
  insufficient: '事实不足',
} as const

const HOLDING_STATE_LABEL = {
  aligned: '同向',
  watching: '观察',
  risk: '风险',
  insufficient: '证据不足',
} as const

const MARKET_STATE_LABEL = {
  constructive: '偏积极',
  mixed: '分化',
  defensive: '偏防御',
  insufficient: '证据不足',
} as const

const EXTERNAL_RISK_LABEL: Record<string, string> = {
  broad_risk_on: '外部风险偏好改善',
  broad_risk_off: '外部风险偏好走弱',
  mixed: '外部证据分化',
  insufficient: '外部证据不足',
}

function formatExternalSource(source: NonNullable<PremarketScenarioView['evidence']['market']['sourceStates']>[number]): string {
  if (source.sourceId === 'tushare-index-global-v1') {
    if (source.errorCode === 'TUSHARE_NOT_CONFIGURED') return 'Tushare未配置'
    if (source.errorCode === 'TUSHARE_TOKEN_UNAVAILABLE') return 'Tushare凭据不可用'
    if (source.status === 'failed') return 'Tushare不可用'
    return `Tushare ${source.observationCount}/${source.expectedCount}`
  }
  if (source.sourceId === 'eastmoney-global-history-v1') {
    return `东方财富历史 ${source.observationCount}/${source.expectedCount}`
  }
  if (source.sourceId === 'eastmoney-global-public-v1') {
    return `东方财富实时快照 ${source.observationCount}/${source.expectedCount}`
  }
  return `${source.sourceId} ${source.observationCount}/${source.expectedCount}`
}

const TREND_STATE_LABEL: Record<string, string> = {
  strengthening: '增强',
  strong: '强势',
  stable: '稳定',
  weakening: '转弱',
  broken: '破坏',
  insufficient: '不足',
}

function formatRatio(value: number | null): string {
  return value == null ? '未知' : `${(value * 100).toFixed(1)}%`
}

const CONFIDENCE_LABEL = {
  high: '高',
  medium: '中等',
  low: '低',
} as const

const SUPPORT_LABEL = {
  supported: '已有支持',
  watching: '等待确认',
  insufficient: '证据不足',
} as const

function StatusMark({ status }: { status: PremarketScenarioView['status'] }) {
  const tone = status === 'ready'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/70 dark:bg-emerald-950/35 dark:text-emerald-200'
    : status === 'partial'
      ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/35 dark:text-amber-200'
      : 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/70 dark:bg-rose-950/35 dark:text-rose-200'
  return <span className={`inline-flex min-h-7 items-center rounded border px-2 text-xs font-semibold ${tone}`}>{STATUS_LABEL[status]}</span>
}

const CONCLUSION_TONE_CLASS: Record<PremarketConclusionTone, string> = {
  constructive: 'border-l-emerald-500 bg-emerald-50/65 dark:bg-emerald-950/20',
  caution: 'border-l-amber-500 bg-amber-50/70 dark:bg-amber-950/20',
  defensive: 'border-l-rose-500 bg-rose-50/70 dark:bg-rose-950/20',
  blocked: 'border-l-slate-400 bg-white dark:border-l-slate-600 dark:bg-slate-950',
}

const CONCLUSION_STANCE_CLASS: Record<PremarketConclusionTone, string> = {
  constructive: 'border-emerald-300 bg-emerald-100 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-100',
  caution: 'border-amber-300 bg-amber-100 text-amber-950 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100',
  defensive: 'border-rose-300 bg-rose-100 text-rose-950 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-100',
  blocked: 'border-slate-300 bg-slate-100 text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100',
}

function PremarketConclusionSection({ version }: { version: PremarketScenarioView }) {
  const conclusion = buildPremarketUserConclusion(version)
  return (
    <section
      data-testid="premarket-user-conclusion"
      className={`border-b border-l-4 border-b-slate-200 px-4 py-4 dark:border-b-slate-800 ${CONCLUSION_TONE_CLASS[conclusion.tone]}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">盘前结论</span>
          <span className={`inline-flex min-h-7 items-center rounded border px-2 text-xs font-semibold ${CONCLUSION_STANCE_CLASS[conclusion.tone]}`}>
            {conclusion.stance}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusMark status={version.status} />
          <span className="text-xs text-slate-500 dark:text-slate-400">结论置信 {CONFIDENCE_LABEL[version.scenario.confidence]}</span>
        </div>
      </div>
      <h2 className="mt-3 text-lg font-semibold leading-7 text-slate-950 dark:text-slate-50">{conclusion.headline}</h2>
      <p className="mt-1.5 max-w-4xl text-sm leading-6 text-slate-700 dark:text-slate-200">{conclusion.summary}</p>
      <dl className="mt-4 grid border-t border-slate-300/70 pt-3 text-xs dark:border-slate-700 sm:grid-cols-2 sm:gap-6">
        <div className="min-w-0 pb-3 sm:pb-0">
          <dt className="font-semibold text-slate-800 dark:text-slate-100">开盘如何确认</dt>
          <dd className="mt-1 leading-5 text-slate-600 dark:text-slate-300">{conclusion.confirmation}</dd>
        </div>
        <div className="min-w-0 border-t border-slate-300/70 pt-3 dark:border-slate-700 sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0">
          <dt className="font-semibold text-slate-800 dark:text-slate-100">什么情况下判断失效</dt>
          <dd className="mt-1 leading-5 text-slate-600 dark:text-slate-300">{conclusion.invalidation}</dd>
        </div>
      </dl>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-300/70 pt-3 text-[11px] leading-5 text-slate-500 dark:border-slate-700 dark:text-slate-400">
        {conclusion.basis.map((item) => <span key={item}>{item}</span>)}
        <span>事实边界 {formatTime(version.factCutoffAt)}</span>
        <span>生成 {formatTime(version.generatedAt)}</span>
        <span>规则 {version.ruleVersion}</span>
      </div>
    </section>
  )
}

function EmptyState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-[320px] flex-col items-center justify-center border-y border-slate-200 px-6 text-center dark:border-slate-800">
      <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">暂无可读的盘前推演版本</div>
      <div className="mt-2 max-w-md text-xs leading-5 text-slate-500 dark:text-slate-400">{message}</div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-5 h-11 rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
      >
        重新读取
      </button>
    </div>
  )
}

function ScenarioBranch({ branch }: { branch: PremarketScenarioBranch }) {
  const tone = branch.key === 'reinforced'
    ? 'border-emerald-200 dark:border-emerald-900/70'
    : branch.key === 'risk'
      ? 'border-rose-200 dark:border-rose-900/70'
      : 'border-cyan-200 dark:border-cyan-900/70'
  return (
    <article data-testid={`premarket-scenario-branch-${branch.key}`} className={`min-w-0 rounded-md border bg-white p-3 dark:bg-slate-950 ${tone}`}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-950 dark:text-slate-100">{branch.label}</h3>
          <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-300">{branch.summary}</p>
        </div>
        <span className="shrink-0 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
          {SUPPORT_LABEL[branch.support]}
        </span>
      </div>
      <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
        <div>
          <dt className="font-semibold text-slate-700 dark:text-slate-200">确认条件</dt>
          <dd className="mt-1 space-y-1 text-slate-500 dark:text-slate-400">
            {branch.confirmConditions.length > 0
              ? branch.confirmConditions.map((item) => <div key={item}>· {item}</div>)
              : <div>暂无</div>}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-700 dark:text-slate-200">失效条件</dt>
          <dd className="mt-1 space-y-1 text-slate-500 dark:text-slate-400">
            {branch.invalidationConditions.length > 0
              ? branch.invalidationConditions.map((item) => <div key={item}>· {item}</div>)
              : <div>暂无</div>}
          </dd>
        </div>
      </dl>
      {branch.unknowns.length > 0 && (
        <div className="mt-3 border-t border-slate-100 pt-2 text-xs leading-5 text-amber-700 dark:border-slate-800 dark:text-amber-300">
          未知项：{branch.unknowns.join('；')}
        </div>
      )}
    </article>
  )
}

function OutcomeView({ outcome }: { outcome: PremarketOutcomeReadView }) {
  if (outcome.state !== 'available' || !outcome.validation) {
    return (
      <section data-testid="premarket-outcome-empty" className="px-4 py-10 text-center">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {outcome.state === 'pending' ? '盘后验证尚未到时' : '盘后验证尚未生成'}
        </h2>
        <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">{outcome.message}</p>
      </section>
    )
  }
  const { validation } = outcome.validation
  return (
    <div data-testid="premarket-outcome-content" className="min-w-0">
      <section className="border-b border-slate-200 px-4 py-4 dark:border-slate-800">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-950 dark:text-slate-100">当日实际路径</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">只使用当日结算OHLC，不以分时或后续行情补造。</p>
          </div>
          <div className="text-right text-xs text-slate-500 dark:text-slate-400">
            <div>{outcome.message}</div>
            <div className="mt-1">覆盖率 {formatRatio(validation.coverageRate)}</div>
          </div>
        </div>
        <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
          <div className="border-l-2 border-slate-300 px-2 dark:border-slate-700"><dt className="text-[11px] text-slate-400">总样本</dt><dd className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">{validation.counts.total}</dd></div>
          <div className="border-l-2 border-emerald-400 px-2"><dt className="text-[11px] text-slate-400">已成熟</dt><dd className="mt-1 text-lg font-semibold text-emerald-700 dark:text-emerald-300">{validation.counts.matured}</dd></div>
          <div className="border-l-2 border-amber-400 px-2"><dt className="text-[11px] text-slate-400">缺事实</dt><dd className="mt-1 text-lg font-semibold text-amber-700 dark:text-amber-300">{validation.counts.missing}</dd></div>
        </dl>
      </section>
      <section className="px-4 py-4">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] table-fixed text-left text-xs">
            <thead className="text-slate-400"><tr><th className="w-[24%] pb-2 font-medium">股票</th><th className="w-[16%] pb-2 font-medium">盘前状态</th><th className="w-[20%] pb-2 font-medium">实际路径</th><th className="w-[20%] pb-2 text-right font-medium">开盘缺口</th><th className="w-[20%] pb-2 text-right font-medium">收盘涨跌</th></tr></thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {validation.items.map((item) => (
                <tr key={item.tsCode}>
                  <td className="py-2 pr-2"><div className="truncate font-medium text-slate-800 dark:text-slate-200">{item.stockName}</div><div className="mt-0.5 text-[11px] text-slate-400">{item.tsCode}</div></td>
                  <td className="py-2 text-slate-600 dark:text-slate-300">{HOLDING_STATE_LABEL[item.premarketState]}</td>
                  <td className="py-2 font-medium text-slate-700 dark:text-slate-200">{OUTCOME_LABEL[item.outcome.label]}<div className="mt-0.5 text-[11px] font-normal text-slate-400">{item.source === 'missing' ? '日K缺失' : item.source}</div></td>
                  <td className="py-2 text-right text-slate-600 dark:text-slate-300">{formatPercent(item.outcome.gapPercent)}</td>
                  <td className="py-2 text-right text-slate-600 dark:text-slate-300">{formatPercent(item.outcome.closeChangePercent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function CalibrationView({ calibration }: { calibration: PremarketCalibrationView }) {
  return (
    <div data-testid="premarket-calibration-content" className="min-w-0">
      <section className="border-b border-slate-200 px-4 py-4 dark:border-slate-800">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-950 dark:text-slate-100">历史覆盖与校准</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">最近{calibration.rangeTradeDays}个交易日，成熟与缺失样本全部计入。</p>
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">{calibration.versionCount}个版本 · 覆盖率 {formatRatio(calibration.coverageRate)}</div>
        </div>
        <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
          <div className="border-l-2 border-slate-300 px-2 dark:border-slate-700"><dt className="text-[11px] text-slate-400">总样本</dt><dd className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">{calibration.totalSamples}</dd></div>
          <div className="border-l-2 border-emerald-400 px-2"><dt className="text-[11px] text-slate-400">已成熟</dt><dd className="mt-1 text-lg font-semibold text-emerald-700 dark:text-emerald-300">{calibration.maturedSamples}</dd></div>
          <div className="border-l-2 border-amber-400 px-2"><dt className="text-[11px] text-slate-400">缺事实</dt><dd className="mt-1 text-lg font-semibold text-amber-700 dark:text-amber-300">{calibration.missingSamples}</dd></div>
        </dl>
      </section>
      {calibration.totalSamples === 0 ? (
        <section className="px-4 py-10 text-center text-xs text-slate-500 dark:text-slate-400">尚无成熟或缺失样本，18:00验证后会在这里累计。</section>
      ) : (
        <>
          <section className="border-b border-slate-200 px-4 py-4 dark:border-slate-800">
            <h2 className="text-sm font-semibold text-slate-950 dark:text-slate-100">盘前状态 × 实际路径</h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-xs">
                <thead className="text-slate-400"><tr><th className="pb-2 font-medium">盘前状态</th><th className="pb-2 font-medium">实际路径</th><th className="pb-2 text-right font-medium">样本数</th></tr></thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {calibration.confusion.map((row) => <tr key={`${row.premarketState}-${row.outcomeLabel}`}><td className="py-2 text-slate-700 dark:text-slate-200">{HOLDING_STATE_LABEL[row.premarketState]}</td><td className="py-2 text-slate-600 dark:text-slate-300">{OUTCOME_LABEL[row.outcomeLabel]}</td><td className="py-2 text-right font-semibold text-slate-800 dark:text-slate-100">{row.count}</td></tr>)}
                </tbody>
              </table>
            </div>
          </section>
          <section className="border-b border-slate-200 px-4 py-4 dark:border-slate-800">
            <h2 className="text-sm font-semibold text-slate-950 dark:text-slate-100">市场环境分组</h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-xs">
                <thead className="text-slate-400"><tr><th className="pb-2 font-medium">环境</th><th className="pb-2 font-medium">实际路径</th><th className="pb-2 text-right font-medium">样本数</th><th className="pb-2 text-right font-medium">平均收盘涨跌</th></tr></thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {calibration.marketGroups.map((row) => <tr key={`${row.marketState}-${row.outcomeLabel}`}><td className="py-2 text-slate-700 dark:text-slate-200">{MARKET_STATE_LABEL[row.marketState]}</td><td className="py-2 text-slate-600 dark:text-slate-300">{OUTCOME_LABEL[row.outcomeLabel]}</td><td className="py-2 text-right text-slate-700 dark:text-slate-200">{row.count}</td><td className="py-2 text-right text-slate-700 dark:text-slate-200">{formatPercent(row.averageCloseChangePercent)}</td></tr>)}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
      <section className="px-4 py-4">
        <div className="border-l-2 border-amber-400 pl-3">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">数字概率尚未开放</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">当前模型没有概率输出，因此Brier Score与可靠性曲线不适用。样本量和校准门禁满足前不会展示胜率或概率。</p>
        </div>
      </section>
    </div>
  )
}

function AIExplanationSection({ explanation, loading, error, onGenerate }: {
  explanation: PremarketAIExplanationView | null
  loading: boolean
  error: string | null
  onGenerate: () => void
}) {
  return (
    <section data-testid="premarket-ai-explanation" className="border-t border-slate-200 px-4 py-4 dark:border-slate-800">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-950 dark:text-slate-100">AI证据解释</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">解释已冻结证据；最新外盘与资讯由联网准备区更新，不会倒灌历史版本。</p>
        </div>
        <button type="button" onClick={onGenerate} disabled={loading} className="h-11 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">
          {loading ? '解释中' : explanation ? '重新读取解释' : '生成AI解释'}
        </button>
      </div>
      {error && <div className="mt-3 border-l-2 border-rose-400 pl-3 text-xs leading-5 text-rose-700 dark:text-rose-300">{error}</div>}
      {explanation && (
        <div className="mt-4 space-y-4 text-xs leading-5">
          <p className="text-slate-700 dark:text-slate-200">{explanation.explanation.summary}</p>
          <div><h3 className="font-semibold text-slate-700 dark:text-slate-200">证据解释</h3><div className="mt-1 space-y-1 text-slate-500 dark:text-slate-400">{explanation.explanation.observations.map((item) => <div key={`${item.text}-${item.referenceIds.join('-')}`}>· {item.text} <span className="text-cyan-700 dark:text-cyan-300">[{item.referenceIds.join(', ')}]</span></div>)}</div></div>
          <div className="grid gap-4 md:grid-cols-2"><div><h3 className="font-semibold text-slate-700 dark:text-slate-200">未知项</h3><div className="mt-1 space-y-1 text-slate-500 dark:text-slate-400">{explanation.explanation.uncertainties.map((item) => <div key={item}>· {item}</div>)}</div></div><div><h3 className="font-semibold text-slate-700 dark:text-slate-200">观察事项</h3><div className="mt-1 space-y-1 text-slate-500 dark:text-slate-400">{explanation.explanation.watchItems.map((item) => <div key={item}>· {item}</div>)}</div></div></div>
          <div className="text-[11px] text-slate-400">{explanation.provider} · {explanation.model} · {formatTime(explanation.generatedAt)}</div>
        </div>
      )}
    </section>
  )
}

const PREPARATION_STATUS_LABEL = {
  ready: '资料完整',
  partial: '部分可用',
  failed: '更新失败',
} as const

function PreparationSection({
  result,
  captureStatus,
  loading,
  error,
  onRefresh,
  onOpenCaptureSettings,
}: {
  result: PremarketPreparationReadResponse | null
  captureStatus: PremarketCaptureStatusView | null
  loading: boolean
  error: string | null
  onRefresh: () => void
  onOpenCaptureSettings?: () => void
}) {
  const preparation: PremarketPreparationView | null = result?.preparation ?? null
  const targetTradeDate = result?.targetTradeDate ?? preparation?.targetTradeDate ?? null
  const observations = preparation?.external.observations.slice(0, 8) ?? []
  return (
    <section data-testid="premarket-preparation" className="border-b border-cyan-200 bg-cyan-50/55 px-4 py-4 dark:border-cyan-900/60 dark:bg-cyan-950/15">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-950 dark:text-slate-100">下一交易日准备</h2>
            <span className="text-xs font-medium text-cyan-800 dark:text-cyan-200">{formatDate(targetTradeDate)}</span>
            <span className={`text-xs ${captureStatus?.enabled ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}`}>
              {captureStatus?.enabled ? '联网采集已开启' : '联网采集未开启'}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-300">
            准备资料独立保存；正式07:30/08:45仍会重新联网采集，不会把当前数据冒充正式截点。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!captureStatus?.enabled && onOpenCaptureSettings && (
            <button type="button" onClick={onOpenCaptureSettings} className={COMPACT_DRAWER_ACTION_CLASS}>采集设置</button>
          )}
          <button
            type="button"
            data-testid="premarket-refresh-preparation"
            onClick={onRefresh}
            disabled={loading || !targetTradeDate}
            className={COMPACT_DRAWER_ACTION_CLASS}
          >
            {loading ? '更新中' : '更新准备资料'}
          </button>
        </div>
      </div>
      {error && <div className="mt-3 border-l-2 border-rose-400 pl-3 text-xs leading-5 text-rose-700 dark:text-rose-300">{error}</div>}
      {!preparation ? (
        <div className="mt-3 border-y border-cyan-200/80 py-3 text-xs leading-5 text-slate-600 dark:border-cyan-900/60 dark:text-slate-300">
          尚无该交易日的准备快照。更新后会记录当前外盘观测、资讯扫描结果及各自时间。
        </div>
      ) : (
        <>
          <div className="mt-3 grid gap-3 text-xs sm:grid-cols-4">
            <div className="border-l-2 border-cyan-500 pl-2"><div className="text-slate-400">快照状态</div><div className="mt-1 font-semibold text-slate-800 dark:text-slate-100">{PREPARATION_STATUS_LABEL[preparation.status]}</div></div>
            <div className="border-l-2 border-slate-300 pl-2 dark:border-slate-700"><div className="text-slate-400">更新时间</div><div className="mt-1 font-semibold text-slate-800 dark:text-slate-100">{formatTime(preparation.capturedAt)}</div></div>
            <div className="border-l-2 border-slate-300 pl-2 dark:border-slate-700"><div className="text-slate-400">外盘覆盖</div><div className="mt-1 font-semibold text-slate-800 dark:text-slate-100">{preparation.external.source.observationCount}/{preparation.external.source.expectedCount}项</div></div>
            <div className="border-l-2 border-slate-300 pl-2 dark:border-slate-700"><div className="text-slate-400">近72小时资讯</div><div className="mt-1 font-semibold text-slate-800 dark:text-slate-100">{preparation.briefings.recentCount}条 · {preparation.briefings.sourceCount}源</div></div>
          </div>
          {observations.length > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {observations.map((item) => (
                <div key={item.assetId} className="min-w-0 border-t border-cyan-200 pt-2 dark:border-cyan-900/60">
                  <div className="truncate text-xs font-medium text-slate-700 dark:text-slate-200" title={item.name}>{item.name}</div>
                  <div className={`mt-0.5 text-sm font-semibold ${item.changePercent > 0 ? 'text-rose-600 dark:text-rose-300' : item.changePercent < 0 ? 'text-emerald-600 dark:text-emerald-300' : 'text-slate-500'}`}>{formatPercent(item.changePercent)}</div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 text-[11px] leading-5 text-slate-500 dark:text-slate-400">
            资讯扫描：{preparation.briefings.scanStatus === 'completed' ? `完成，本次新增${preparation.briefings.newBriefingsFound}条` : preparation.briefings.scanStatus === 'busy' ? '已有扫描正在进行，保留当前本地覆盖' : '失败，保留当前本地覆盖'}
            {preparation.briefings.latestPublishedAt ? ` · 最新发布时间 ${formatTime(preparation.briefings.latestPublishedAt)}` : ' · 尚无可验证发布时间'}
          </div>
        </>
      )}
    </section>
  )
}

export function PremarketScenarioDrawer({ open, onClose, onOpenCaptureSettings }: PremarketScenarioDrawerProps) {
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState<PremarketScenarioReadResponse | null>(null)
  const [captureStatus, setCaptureStatus] = useState<PremarketCaptureStatusView | null>(null)
  const [preparationResponse, setPreparationResponse] = useState<PremarketPreparationReadResponse | null>(null)
  const [preparationLoading, setPreparationLoading] = useState(false)
  const [preparationError, setPreparationError] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<'scenario' | 'outcome' | 'calibration'>('scenario')
  const [explainLoading, setExplainLoading] = useState(false)
  const [explainError, setExplainError] = useState<string | null>(null)
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)
  const [retryLoading, setRetryLoading] = useState(false)
  const [retryProgress, setRetryProgress] = useState<PremarketScenarioRetryProgress | null>(null)
  const [retryMessage, setRetryMessage] = useState<string | null>(null)
  const [retryError, setRetryError] = useState<string | null>(null)

  const load = useCallback(async (versionId?: string) => {
    setLoading(true)
    try {
      const [scenarioResult, statusResult, preparationResult] = await Promise.allSettled([
        versionId
          ? window.api.premarket.getScenarioRevision(versionId)
          : window.api.premarket.getScenario(),
        window.api.premarket.getStatus(),
        window.api.premarket.getPreparation(),
      ])
      const nextResponse = scenarioResult.status === 'fulfilled' ? scenarioResult.value : {
        ok: false,
        code: 'SCENARIO_READ_FAILED',
        message: scenarioResult.reason instanceof Error ? scenarioResult.reason.message : '盘前推演读取失败',
      } as PremarketScenarioReadResponse
      setResponse(nextResponse)
      setSelectedVersionId(nextResponse.ok ? nextResponse.version.id : null)
      setCaptureStatus(statusResult.status === 'fulfilled' ? statusResult.value : null)
      setPreparationResponse(preparationResult.status === 'fulfilled' ? preparationResult.value : null)
    } catch (error) {
      setResponse({
        ok: false,
        code: 'SCENARIO_READ_FAILED',
        message: error instanceof Error ? error.message : '盘前推演读取失败',
      })
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshPreparation = useCallback(async () => {
    setPreparationLoading(true)
    setPreparationError(null)
    try {
      const result = await window.api.premarket.refreshPreparation()
      if (!result.ok) {
        setPreparationError(result.message)
        return
      }
      setPreparationResponse({
        ok: true,
        targetTradeDate: result.preparation.targetTradeDate,
        preparation: result.preparation,
      })
      const status = await window.api.premarket.getStatus().catch(() => null)
      if (status) setCaptureStatus(status)
    } catch (error) {
      setPreparationError(error instanceof Error ? error.message : '下一交易日准备资料更新失败')
    } finally {
      setPreparationLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      setActiveView('scenario')
      setExplainError(null)
      setRetryError(null)
      setRetryMessage(null)
      setSelectedVersionId(null)
      void load()
    }
  }, [load, open])

  useEffect(() => window.api.premarket.onRetryProgress((next) => {
    setRetryProgress(next)
  }), [])

  const retryScenario = useCallback(async () => {
    setRetryLoading(true)
    setRetryError(null)
    setRetryMessage(null)
    setRetryProgress({ phase: 'starting', message: '正在启动补采', current: null, total: null })
    try {
      const result = await window.api.premarket.retryScenario()
      if (!result.ok) {
        setRetryError(result.message)
        return
      }
      const external = result.sources.find((item) => item.source === 'external')
      const externalText = external
        ? ` 外盘历史恢复 ${external.itemCount} 项${external.status === 'failed' ? '，仍未达到覆盖门槛' : ''}。`
        : ''
      setRetryMessage(`已生成不可变修订 R${result.revision.revision}，事实边界保持在09:30。${externalText}`)
      setSelectedVersionId(null)
      await load()
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : '盘前推演补采失败')
    } finally {
      setRetryLoading(false)
      setRetryProgress(null)
    }
  }, [load])

  const currentVersionId = response?.ok ? response.version.id : undefined

  const explain = useCallback(async () => {
    setExplainLoading(true)
    setExplainError(null)
    try {
      const result = await window.api.premarket.explainScenario(currentVersionId)
      if (!result.ok) {
        setExplainError(result.message)
        return
      }
      setResponse((current) => current?.ok ? { ...current, explanation: result.explanation } : current)
    } catch (error) {
      setExplainError(error instanceof Error ? error.message : 'AI解释生成失败')
    } finally {
      setExplainLoading(false)
    }
  }, [currentVersionId])

  const version = response?.ok ? response.version : null
  const diagnosis = useMemo(
    () => version ? buildEvidenceDiagnosis(version, captureStatus) : null,
    [captureStatus, version],
  )
  const sectorRows = useMemo(() => (
    version?.evidence.sectors
      .filter((item) => item.holdingCodes.length > 0)
      .sort((left, right) => Math.abs(right.mainNetInflow ?? 0) - Math.abs(left.mainNetInflow ?? 0))
      .slice(0, 16) ?? []
  ), [version])

  return (
    <RightDrawer
      open={open}
      onClose={onClose}
      title="盘前推演"
      description={version
        ? `${formatDate(version.tradeDate)} · ${formatScenarioStage(version)} · 修订 R${version.revision}`
        : '当前交易日的持仓情景与证据状态'}
      defaultWidth={980}
      minWidth={720}
      maxWidth={1180}
      testId="premarket-scenario-drawer"
      bodyClassName="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-slate-50 dark:bg-slate-950"
      actions={(
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="premarket-scenario-retry"
            onClick={() => { void retryScenario() }}
            disabled={retryLoading}
            className={`${COMPACT_DRAWER_ACTION_CLASS} border-cyan-300 text-cyan-700 dark:border-cyan-800 dark:text-cyan-200`}
          >
            {retryLoading ? '补采中' : '重新补采'}
          </button>
          <button
            type="button"
            data-testid="premarket-scenario-reload"
            onClick={() => { void load(selectedVersionId ?? undefined) }}
            disabled={loading}
            className={COMPACT_DRAWER_ACTION_CLASS}
          >
            {loading ? '读取中' : '重新读取'}
          </button>
        </div>
      )}
    >
      <div aria-live="polite" className="min-h-full">
        {(retryLoading || retryMessage || retryError) && (
          <section
            data-testid="premarket-retry-feedback"
            className={`border-b px-4 py-3 text-xs ${retryError ? 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/20 dark:text-rose-200' : 'border-cyan-200 bg-cyan-50 text-cyan-900 dark:border-cyan-900/60 dark:bg-cyan-950/20 dark:text-cyan-100'}`}
          >
            <div className="flex items-center gap-2">
              {retryLoading && <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-cyan-200 border-t-cyan-700 motion-reduce:animate-none dark:border-cyan-900 dark:border-t-cyan-200" aria-hidden="true" />}
              <span>{retryError ?? retryProgress?.message ?? retryMessage}</span>
              {retryProgress?.current != null && retryProgress.total != null && (
                <span className="ml-auto tabular-nums">{retryProgress.current}/{retryProgress.total}</span>
              )}
            </div>
          </section>
        )}
        {loading && !response ? (
          <div data-testid="premarket-scenario-loading" className="flex min-h-[320px] items-center justify-center text-sm text-slate-500 dark:text-slate-400">
            <span className="mr-3 h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-cyan-600 motion-reduce:animate-none dark:border-slate-700 dark:border-t-cyan-300" aria-hidden="true" />
            正在读取本地不可变版本
          </div>
        ) : (
          <>
            {response?.ok && response.displayContext.isFallback && (
              <section data-testid="premarket-scenario-fallback" className="border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-950">
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {response.displayContext.fallbackReason === 'non_trading_day' ? '今日休市' : '今日版本尚未形成'} · 当前展示最近交易日 {formatDate(response.displayContext.displayTradeDate)}
                </div>
                <div className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">盘前推演、盘后验证与AI解释均绑定该冻结版本。</div>
              </section>
            )}
            {!response || !response.ok || !version ? (
              <>
                <PreparationSection
                  result={preparationResponse}
                  captureStatus={captureStatus}
                  loading={preparationLoading}
                  error={preparationError}
                  onRefresh={() => { void refreshPreparation() }}
                  onOpenCaptureSettings={onOpenCaptureSettings}
                />
                <EmptyState
                  message={response && !response.ok ? response.message : '本地尚未生成可回看的盘前初版或竞价确认版'}
                  onRetry={() => { void load() }}
                />
              </>
            ) : (
          <div data-testid="premarket-scenario-content" className="min-w-0">
            <PremarketConclusionSection version={version} />

            {response.revisions.length > 0 && (
              <section data-testid="premarket-revision-history" className="border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/40">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mr-1 text-xs font-semibold text-slate-700 dark:text-slate-200">修订记录</span>
                  {response.revisions.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={item.id === version.id}
                      data-testid={`premarket-revision-${item.revision}`}
                      onClick={() => { void load(item.id) }}
                      className={`inline-flex min-h-8 items-center gap-2 rounded-md border px-2.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${item.id === version.id ? 'border-cyan-400 bg-white text-cyan-800 dark:border-cyan-700 dark:bg-slate-950 dark:text-cyan-200' : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'}`}
                    >
                      <span>R{item.revision} · {item.revisionKind === 'manual_backfill' ? '补采' : item.revisionKind === 'startup_catch_up' ? '启动补漏' : '原始'}</span>
                      <span className="text-[11px] font-normal text-slate-400">竞价 {item.auctionMatchedCount} · 资讯 {item.briefingCount}</span>
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-[11px] leading-5 text-slate-500 dark:text-slate-400">每次补采都追加新修订；旧修订、盘后验证和AI解释不会被覆盖。</p>
              </section>
            )}

            {diagnosis && diagnosis.issues.length > 0 && (
              <section data-testid="premarket-evidence-diagnosis" className="border-b border-amber-200 bg-amber-50/75 px-4 py-4 dark:border-amber-900/60 dark:bg-amber-950/20">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-semibold text-amber-950 dark:text-amber-100">为什么当前推演受阻</h2>
                    <p className="mt-1 text-xs leading-5 text-amber-800/90 dark:text-amber-200/80">{diagnosis.recovery}</p>
                  </div>
                  {onOpenCaptureSettings && (
                    <button
                      type="button"
                      data-testid="premarket-open-capture-settings"
                      onClick={onOpenCaptureSettings}
                      aria-label="打开盘前采集设置"
                      title="打开盘前采集设置"
                      className={COMPACT_DRAWER_ACTION_CLASS}
                    >
                      采集设置
                    </button>
                  )}
                </div>
                <div className="mt-3 divide-y divide-amber-200/80 border-y border-amber-200/80 dark:divide-amber-900/60 dark:border-amber-900/60">
                  {diagnosis.issues.map((issue) => (
                    <div key={issue.key} className="grid gap-1 py-2.5 text-xs sm:grid-cols-[190px_minmax(0,1fr)] sm:gap-4">
                      <div className="font-semibold text-amber-950 dark:text-amber-100">{issue.title}</div>
                      <div className="leading-5 text-amber-800/90 dark:text-amber-200/75">{issue.detail}</div>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-xs leading-5 text-slate-600 dark:text-slate-300">{diagnosis.readySummary}</p>
              </section>
            )}

            <nav role="tablist" aria-label="盘前推演视图" className="flex min-h-11 items-stretch border-b border-slate-200 bg-white px-4 dark:border-slate-800 dark:bg-slate-950">
              {([
                ['scenario', '盘前推演'],
                ['outcome', response.outcome.state === 'available' ? '盘后验证' : '盘后验证 · 待完成'],
                ['calibration', '历史校准'],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  id={`premarket-tab-${key}`}
                  aria-controls={`premarket-panel-${key}`}
                  aria-selected={activeView === key}
                  data-testid={`premarket-view-${key}`}
                  onClick={() => setActiveView(key)}
                  className={`min-h-11 border-b-2 px-4 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-cyan-500 ${activeView === key ? 'border-cyan-600 text-cyan-800 dark:border-cyan-300 dark:text-cyan-200' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'}`}
                >
                  {label}
                </button>
              ))}
            </nav>

            <div
              id="premarket-panel-scenario"
              role="tabpanel"
              aria-labelledby="premarket-tab-scenario"
              hidden={activeView !== 'scenario'}
            >
            <section className="border-b border-slate-200 px-4 py-4 dark:border-slate-800">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-slate-950 dark:text-slate-100">市场证据</h2>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">外部风险状态只作A股外生证据，不直接映射个股方向。</p>
                </div>
                <div className="text-xs font-medium text-slate-700 dark:text-slate-200">
                  {EXTERNAL_RISK_LABEL[version.evidence.market.externalRiskTone] ?? '外部证据未知'} · {version.evidence.market.eligibleAssetCount}项 / {version.evidence.market.regionCount}地区
                </div>
              </div>
              {version.evidence.market.baseFactSnapshotId && (
                <div
                  data-testid="premarket-market-snapshot-meta"
                  className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] leading-5 text-slate-500 dark:text-slate-400"
                >
                  <span>事实截点 08:45</span>
                  {version.evidence.market.snapshotRevision != null && <span>快照 R{version.evidence.market.snapshotRevision}</span>}
                  {version.evidence.market.snapshotCapturedAt != null && <span>采集 {formatTime(version.evidence.market.snapshotCapturedAt)}</span>}
                  {version.evidence.market.sourceStates?.map((source) => (
                    <span key={source.sourceId}>{formatExternalSource(source)}</span>
                  ))}
                </div>
              )}
              {version.evidence.market.observations.length > 0 ? (
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {version.evidence.market.observations.slice(0, 8).map((item) => (
                    <div key={item.assetId} className="min-w-0 border-l-2 border-slate-300 pl-2 dark:border-slate-700">
                      <div className="truncate text-xs font-medium text-slate-700 dark:text-slate-200" title={item.name}>{item.name}</div>
                      <div className={`mt-0.5 text-sm font-semibold ${item.changePercent > 0 ? 'text-rose-600 dark:text-rose-300' : item.changePercent < 0 ? 'text-emerald-600 dark:text-emerald-300' : 'text-slate-500'}`}>{formatPercent(item.changePercent)}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-3 border-y border-slate-200 py-3 text-xs leading-5 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  08:45固定快照中没有可展示的外盘观测；这里不会用当前行情补填历史截点。
                </div>
              )}
            </section>

            <section className="border-b border-slate-200 px-4 py-4 dark:border-slate-800">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-slate-950 dark:text-slate-100">行业与题材传导</h2>
                <span className="text-xs text-slate-500 dark:text-slate-400">事实日 {formatDate(version.evidence.previousTradeDate)}</span>
              </div>
              {sectorRows.length === 0 ? (
                <div className="mt-3 border-y border-slate-200 py-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">没有可匹配的持仓行业或题材资金事实</div>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[640px] table-fixed text-left text-xs">
                    <thead className="text-slate-400"><tr><th className="w-[32%] pb-2 font-medium">身份</th><th className="w-[18%] pb-2 font-medium">类型</th><th className="w-[20%] pb-2 text-right font-medium">主力净流入</th><th className="w-[15%] pb-2 text-right font-medium">涨跌</th><th className="w-[15%] pb-2 text-right font-medium">覆盖</th></tr></thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {sectorRows.map((item) => (
                        <tr key={item.key}>
                          <td className="truncate py-2 pr-2 font-medium text-slate-800 dark:text-slate-200" title={item.name}>{item.name}</td>
                          <td className="py-2 text-slate-500 dark:text-slate-400">{item.kind === 'industry' ? '行业' : '题材'}</td>
                          <td className="py-2 text-right text-slate-700 dark:text-slate-300">{formatAmount(item.mainNetInflow)}</td>
                          <td className="py-2 text-right text-slate-700 dark:text-slate-300">{formatPercent(item.weightedChange)}</td>
                          <td className="py-2 text-right text-slate-500 dark:text-slate-400">{item.holdingCodes.length}只</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="border-b border-slate-200 px-4 py-4 dark:border-slate-800">
              <h2 className="text-sm font-semibold text-slate-950 dark:text-slate-100">持仓状态</h2>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[760px] table-fixed text-left text-xs">
                  <thead className="text-slate-400"><tr><th className="w-[22%] pb-2 font-medium">股票</th><th className="w-[16%] pb-2 font-medium">趋势</th><th className="w-[16%] pb-2 font-medium">筹码</th><th className="w-[24%] pb-2 text-right font-medium">竞价缺口</th><th className="w-[22%] pb-2 font-medium">状态</th></tr></thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {version.evidence.holdings.map((holding) => {
                      const state = version.scenario.holdings.find((item) => item.tsCode === holding.tsCode)
                      return (
                        <tr key={holding.tsCode}>
                          <td className="py-2 pr-2"><div className="truncate font-medium text-slate-800 dark:text-slate-200">{holding.stockName}</div><div className="mt-0.5 text-[11px] text-slate-400">{holding.tsCode}</div></td>
                          <td className="py-2 text-slate-600 dark:text-slate-300">{TREND_STATE_LABEL[holding.trend.trendState] ?? '未知'}<div className="mt-0.5 text-[11px] text-slate-400">评分 {holding.trend.totalScore?.toFixed(0) ?? '未知'}</div></td>
                          <td className="py-2 text-slate-600 dark:text-slate-300">{holding.chip.status === 'ready' ? '可用' : holding.chip.status === 'partial' ? '部分' : '缺失'}<div className="mt-0.5 text-[11px] text-slate-400">获利盘 {formatPercent(holding.chip.winnerRate)}</div></td>
                          <td className="py-2 text-right font-medium text-slate-700 dark:text-slate-200">
                            {holding.auction ? (
                              <>
                                <div>{formatPercent(holding.auction.gapPercent)}</div>
                                <div className="mt-0.5 text-[11px] font-normal leading-4 text-slate-400">
                                  09:25定稿 · 采集 {formatTime(holding.auction.fetchedAt)}
                                </div>
                              </>
                            ) : <span className="text-amber-700 dark:text-amber-300">未在截点命中</span>}
                          </td>
                          <td className="py-2 text-slate-600 dark:text-slate-300">{HOLDING_STATE_LABEL[state?.state ?? 'insufficient']}<div className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-slate-400">{state?.summary ?? '趋势、筹码与竞价证据均不足'}</div></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="px-4 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-950 dark:text-slate-100">三类情景</h2>
                <span className="text-xs text-slate-500 dark:text-slate-400">证据置信不代表收益概率</span>
              </div>
              <div
                data-testid="premarket-scenario-branches"
                className="mt-3 grid gap-3"
                style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 22rem), 1fr))' }}
              >
                {version.scenario.branches.map((branch) => <ScenarioBranch key={branch.key} branch={branch} />)}
              </div>
            </section>
            <AIExplanationSection
              explanation={response.explanation}
              loading={explainLoading}
              error={explainError}
              onGenerate={() => { void explain() }}
            />
            <PreparationSection
              result={preparationResponse}
              captureStatus={captureStatus}
              loading={preparationLoading}
              error={preparationError}
              onRefresh={() => { void refreshPreparation() }}
              onOpenCaptureSettings={onOpenCaptureSettings}
            />
            </div>
            <div id="premarket-panel-outcome" role="tabpanel" aria-labelledby="premarket-tab-outcome" hidden={activeView !== 'outcome'}>
              {activeView === 'outcome' && <OutcomeView outcome={response.outcome} />}
            </div>
            <div id="premarket-panel-calibration" role="tabpanel" aria-labelledby="premarket-tab-calibration" hidden={activeView !== 'calibration'}>
              {activeView === 'calibration' && <CalibrationView calibration={response.calibration} />}
            </div>
          </div>
            )}
          </>
        )}
      </div>
    </RightDrawer>
  )
}
