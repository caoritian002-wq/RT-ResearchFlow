import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { RightDrawer } from '../shared/RightDrawer'

type ReadResult = Awaited<ReturnType<typeof window.api.stockFundamentals.get>>
type Snapshot = Extract<ReadResult, { ok: true }>['snapshot']
type SourceState = Snapshot['sources']['profile']
type DrawerView = 'overview' | 'announcements'
type AnnouncementFilter = 'all' | 'attention'
type AttentionTag = Snapshot['announcements'][number]['attentionTags'][number]

const ATTENTION_TAG_LABELS: Record<AttentionTag, string> = {
  major: '重大事项',
  performance: '业绩',
  capital: '资本运作',
  ownership: '股权变化',
  dividend: '分红',
  governance: '治理',
  risk: '风险合规',
  business: '经营事项',
}

interface StockFundamentalDrawerProps {
  open: boolean
  stockCode: string
  stockName: string
  onClose: () => void
}

function formatDate(value: string | null): string {
  if (!value || !/^\d{8}$/.test(value)) return '未知'
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

function formatCollectedAt(value: number | null): string {
  if (value == null) return '尚未采集'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value)
}

function formatDisplayAt(value: number | null): string {
  if (value == null) return '展示时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value)
}

function formatMoney(value: number | null, currency: string | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const unit = currency === 'CNY' || currency == null ? '元' : currency
  const absolute = Math.abs(value)
  if (absolute >= 1e8) return `${(value / 1e8).toFixed(2)}亿元`
  if (absolute >= 1e4) return `${(value / 1e4).toFixed(2)}万元`
  return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}${unit}`
}

function formatPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function formatNumber(value: number | null, suffix = ''): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}${suffix}`
}

function sourceLabel(state: SourceState, label: string): {
  title: string
  detail: string
  tone: string
} {
  if (state.status === 'available') {
    return {
      title: `${label}可用`,
      detail: state.factDate
        ? `事实日 ${formatDate(state.factDate)} · 最近采集 ${formatCollectedAt(state.lastSuccessAt)}`
        : `来源未提供资料更新日 · 最近采集 ${formatCollectedAt(state.lastSuccessAt)}`,
      tone: 'bg-emerald-500 dark:bg-emerald-400',
    }
  }
  if (state.status === 'failed') {
    return {
      title: `${label}获取失败`,
      detail: `${state.errorCode ?? 'UPSTREAM_ERROR'} · 最近尝试 ${formatCollectedAt(state.lastAttemptAt)}`,
      tone: 'bg-red-500 dark:bg-red-400',
    }
  }
  return {
    title: `${label}尚未获取`,
    detail: '本地没有该来源的事实',
    tone: 'bg-slate-300 dark:bg-slate-600',
  }
}

function SourceBlock({ state, label }: { state: SourceState; label: string }) {
  const model = sourceLabel(state, label)
  return (
    <div
      data-status={state.status}
      className="flex min-w-0 items-start gap-2 border-b border-slate-200 px-3 py-2.5 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0 dark:border-slate-800"
    >
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${model.tone}`} aria-hidden="true" />
      <div className="min-w-0">
        <div className={`text-xs font-semibold ${state.status === 'failed' ? 'text-red-700 dark:text-red-300' : 'text-slate-800 dark:text-slate-200'}`}>
          {model.title}
        </div>
        <div className="mt-0.5 text-[11px] leading-4 text-slate-500 dark:text-slate-400">{model.detail}</div>
      </div>
    </div>
  )
}

function FactCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-b border-slate-100 py-2 dark:border-slate-800">
      <div className="text-[11px] text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-0.5 break-words text-sm font-medium text-slate-900 dark:text-slate-100">{value}</div>
    </div>
  )
}

function AnnouncementPanel({
  snapshot,
  onOpen,
}: {
  snapshot: Snapshot
  onOpen: (url: string) => void
}) {
  const [filter, setFilter] = useState<AnnouncementFilter>('all')
  const announcements = snapshot.announcements ?? []
  const summary = snapshot.announcementSummary ?? {
    total: announcements.length,
    attentionCount: announcements.filter((item) => item.attentionTags.length > 0).length,
    latestNoticeDate: announcements[0]?.noticeDate ?? null,
  }
  const filtered = filter === 'attention'
    ? announcements.filter((announcement) => announcement.attentionTags.length > 0)
    : announcements

  return (
    <section
      id="stock-fundamental-panel-announcements"
      role="tabpanel"
      aria-labelledby="stock-fundamental-tab-announcements"
      data-testid="stock-fundamental-announcements"
      className="space-y-4"
    >
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-300 pb-3 dark:border-slate-700">
        <div>
          <h3 className="text-sm font-semibold text-slate-950 dark:text-white">公告事项</h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            共 {summary.total} 条 · 重点线索 {summary.attentionCount} 条 · 最新 {formatDate(summary.latestNoticeDate)}
          </p>
        </div>
        <div aria-label="公告范围" className="flex min-h-11 items-center gap-0.5">
          {([
            ['all', `全部 ${summary.total}`],
            ['attention', `重点 ${summary.attentionCount}`],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              data-testid={`stock-fundamental-announcement-filter-${value}`}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className="group flex h-11 items-center rounded px-0.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60 motion-reduce:transition-none"
            >
              <span
                data-testid={`stock-fundamental-announcement-filter-${value}-visual`}
                className={`flex h-7 items-center justify-center rounded border px-2.5 transition-colors motion-reduce:transition-none ${filter === value
                  ? 'border-slate-300 bg-slate-100 text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100'
                  : 'border-transparent text-slate-500 group-hover:bg-slate-100 group-hover:text-slate-800 dark:text-slate-400 dark:group-hover:bg-slate-800 dark:group-hover:text-slate-100'
                }`}
              >
                {label}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="border-l-2 border-cyan-600 pl-3 text-xs leading-5 text-slate-600 dark:border-cyan-400 dark:text-slate-300">
        重点标签仅由公告标题和上游分类匹配，不代表已读取正文或判断事件影响。
      </div>

      {filtered.length > 0 ? (
        <div className="divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {filtered.map((announcement) => (
            <article
              key={announcement.articleCode}
              data-testid={`stock-fundamental-announcement-${announcement.articleCode}`}
              className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-3 py-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
                  <span className="tabular-nums">公告 {formatDate(announcement.noticeDate)}</span>
                  <span>{formatDisplayAt(announcement.displayAt)}</span>
                  <span className="font-mono">{announcement.articleCode}</span>
                </div>
                <h4 className="mt-1 break-words text-sm font-medium leading-6 text-slate-950 dark:text-slate-100">
                  {announcement.title}
                </h4>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] leading-5">
                  {announcement.categoryNames.length > 0 && (
                    <span className="text-slate-500 dark:text-slate-400">
                      来源分类：{announcement.categoryNames.join(' / ')}
                    </span>
                  )}
                  {announcement.attentionTags.map((tag) => (
                    <span key={tag} className="font-medium text-amber-700 dark:text-amber-300">
                      {ATTENTION_TAG_LABELS[tag]}线索
                    </span>
                  ))}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onOpen(announcement.sourceUrl)}
                aria-label={`在东方财富查看：${announcement.title}`}
                title="在东方财富查看"
                className="h-11 shrink-0 self-center border border-slate-300 px-3 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800 motion-reduce:transition-none"
              >
                查看
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="border-y border-slate-200 py-8 text-center dark:border-slate-800">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
            {filter === 'attention' ? '当前公告中没有重点标题线索' : '本地没有公告索引'}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {snapshot.sources.announcement?.status === 'available'
              ? '公开来源已检查，当前范围没有可展示记录。'
              : '公告来源尚未成功同步。'}
          </p>
        </div>
      )}
    </section>
  )
}

export function StockFundamentalDrawer({
  open,
  stockCode,
  stockName,
  onClose,
}: StockFundamentalDrawerProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<DrawerView>('overview')

  const api = (window.api as typeof window.api & {
    stockFundamentals?: typeof window.api.stockFundamentals
  }).stockFundamentals

  const loadLocal = useCallback(async () => {
    if (!open || !api) return
    setLoading(true)
    setError(null)
    try {
      const result = await api.get(stockCode)
      if (!result.ok) throw new Error(result.message)
      setSnapshot(result.snapshot)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '基本面资料读取失败')
    } finally {
      setLoading(false)
    }
  }, [api, open, stockCode])

  useEffect(() => {
    if (!open) return
    setSnapshot(null)
    setMessage(null)
    setError(null)
    setActiveView('overview')
    void loadLocal()
  }, [loadLocal, open, stockCode])

  const handleRefresh = async () => {
    if (!api || refreshing) return
    setRefreshing(true)
    setMessage(null)
    setError(null)
    try {
      const result = await api.refresh(stockCode)
      if (result.snapshot) setSnapshot(result.snapshot)
      if (!result.ok) throw new Error(result.message)
      setMessage(result.message)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '公开基本面资料获取失败')
    } finally {
      setRefreshing(false)
    }
  }

  const latest = snapshot?.latestFinancial ?? null
  const profile = snapshot?.profile ?? null
  const reportPeriods = useMemo(
    () => snapshot?.financialHistory.map((item) => item.reportDate) ?? [],
    [snapshot],
  )

  const announcementSource: SourceState = snapshot?.sources.announcement ?? {
    status: 'missing',
    lastAttemptAt: null,
    lastSuccessAt: null,
    factDate: null,
    errorCode: null,
    rowsWritten: 0,
  }

  const handleOpenAnnouncement = (url: string) => {
    setError(null)
    void window.api.openExternal(url).then((result) => {
      if (!result.ok) setError('公告页面打开失败，请稍后重试')
    }).catch(() => setError('公告页面打开失败，请稍后重试'))
  }

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: DrawerView) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const next: DrawerView = current === 'overview' ? 'announcements' : 'overview'
    setActiveView(next)
    window.requestAnimationFrame(() => {
      document.getElementById(`stock-fundamental-tab-${next}`)?.focus()
    })
  }

  const refreshIsPrimary = snapshot?.status === 'missing'
  const action = api ? (
    <button
      type="button"
      data-testid="stock-fundamental-refresh"
      onClick={() => void handleRefresh()}
      disabled={refreshing}
      className="group flex h-11 items-center justify-center rounded px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60 focus-visible:ring-offset-1 disabled:cursor-wait motion-reduce:transition-none"
    >
      <span
        data-testid="stock-fundamental-refresh-visual"
        className={`flex h-8 items-center justify-center gap-1.5 rounded border px-3 text-xs font-semibold transition-colors group-disabled:opacity-60 motion-reduce:transition-none ${refreshIsPrimary
          ? 'border-cyan-700 bg-cyan-700 text-white group-hover:bg-cyan-800 dark:border-cyan-500 dark:bg-cyan-500 dark:text-slate-950 dark:group-hover:bg-cyan-400'
          : 'border-slate-300 bg-white text-slate-700 group-hover:border-cyan-400 group-hover:text-cyan-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:group-hover:border-cyan-600 dark:group-hover:text-cyan-200'
        }`}
      >
        {refreshing && (
          <span className="h-3 w-3 animate-spin rounded-full border border-current border-r-transparent motion-reduce:animate-none" aria-hidden="true" />
        )}
        {refreshing ? '正在获取...' : refreshIsPrimary ? '获取公开资料' : '刷新资料'}
      </span>
    </button>
  ) : null

  return (
    <RightDrawer
      open={open}
      title={`${stockName} 基本面事实`}
      description={`${stockCode} · 公开来源按需补齐 · 本地读取不联网`}
      actions={action}
      onClose={onClose}
      defaultWidth={780}
      minWidth={620}
      maxWidth={960}
      testId="stock-fundamental-drawer"
      bodyClassName="min-h-0 flex-1 overflow-y-auto px-4 py-3"
    >
      <div aria-live="polite" aria-atomic="true" className="min-h-5 text-xs">
        {message && <span className="text-emerald-700 dark:text-emerald-300">{message}</span>}
        {error && <span role="alert" className="text-red-700 dark:text-red-300">{error}</span>}
      </div>

      {!api ? (
        <div className="mt-3 border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          当前主进程尚未加载基本面组件，请重启应用后再试。
        </div>
      ) : loading ? (
        <div className="flex min-h-56 items-center justify-center text-sm text-slate-500 dark:text-slate-400">
          正在读取本地基本面事实...
        </div>
      ) : snapshot ? (
        <div data-testid="stock-fundamental-content" data-state={snapshot.status} className="space-y-5 pb-5">
          <div
            data-testid="stock-fundamental-source-summary"
            className="grid grid-cols-1 border-y border-slate-200 bg-slate-50/60 sm:grid-cols-3 dark:border-slate-800 dark:bg-slate-900/45"
          >
            <SourceBlock state={snapshot.sources.profile} label="公司概况" />
            <SourceBlock state={snapshot.sources.financial} label="主要财务" />
            <SourceBlock state={announcementSource} label="公告索引" />
          </div>

          <div
            role="tablist"
            aria-label="基本面事实视图"
            className="flex min-h-11 items-center gap-0.5 border-y border-slate-200 px-1 dark:border-slate-800"
          >
            {([
              ['overview', '概况财务'],
              ['announcements', `公告事项 ${snapshot.announcementSummary?.total ?? snapshot.announcements?.length ?? 0}`],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                id={`stock-fundamental-tab-${value}`}
                type="button"
                role="tab"
                data-testid={`stock-fundamental-tab-${value}`}
                aria-selected={activeView === value}
                aria-controls={`stock-fundamental-panel-${value}`}
                tabIndex={activeView === value ? 0 : -1}
                onClick={() => setActiveView(value)}
                onKeyDown={(event) => handleTabKeyDown(event, value)}
                className="group flex h-11 items-center rounded px-0.5 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60 motion-reduce:transition-none"
              >
                <span
                  data-testid={`stock-fundamental-tab-${value}-visual`}
                  className={`flex h-7 min-w-28 items-center justify-center rounded border px-3 transition-colors motion-reduce:transition-none ${activeView === value
                    ? 'border-cyan-300 bg-cyan-50 text-cyan-800 dark:border-cyan-800 dark:bg-cyan-950/45 dark:text-cyan-200'
                    : 'border-transparent text-slate-500 group-hover:bg-slate-100 group-hover:text-slate-800 dark:text-slate-400 dark:group-hover:bg-slate-800 dark:group-hover:text-slate-100'
                  }`}
                >
                  {label}
                </span>
              </button>
            ))}
          </div>

          {activeView === 'overview' ? (
            <div
              id="stock-fundamental-panel-overview"
              role="tabpanel"
              aria-labelledby="stock-fundamental-tab-overview"
              className="space-y-5"
            >
          {snapshot.status === 'missing' && (
            <section className="border-y border-slate-200 py-5 text-center dark:border-slate-700">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">本地尚无基本面事实</h3>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                点击“获取公开资料”后，只会查询当前这只股票。
              </p>
            </section>
          )}

          {profile && (
            <section data-testid="stock-fundamental-profile" aria-labelledby="stock-fundamental-profile-title">
              <div className="border-b border-slate-300 pb-2 dark:border-slate-600">
                <h3 id="stock-fundamental-profile-title" className="text-sm font-semibold text-slate-950 dark:text-white">公司概况</h3>
                <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">东方财富公司概况 · 来源未提供资料更新日</p>
              </div>
              <div className="grid grid-cols-1 gap-x-5 sm:grid-cols-2">
                <FactCell label="法定名称" value={profile.legalName ?? '—'} />
                <FactCell label="证券简称" value={profile.shortName ?? '—'} />
                <FactCell label="行业" value={profile.industry ?? '—'} />
                <FactCell label="交易市场" value={profile.tradeMarket ?? '—'} />
                <FactCell label="证券类型" value={profile.securityType ?? '—'} />
                <FactCell label="董事长" value={profile.chairman ?? '—'} />
                <FactCell label="法定代表人" value={profile.legalRepresentative ?? '—'} />
                <FactCell label="注册资本" value={profile.registeredCapitalWan == null ? '—' : `${formatNumber(profile.registeredCapitalWan)}万元`} />
                <FactCell label="员工人数" value={profile.employeeCount == null ? '—' : formatNumber(profile.employeeCount, '人')} />
                <FactCell label="公司网站" value={profile.website ?? '—'} />
                <div className="sm:col-span-2"><FactCell label="办公地址" value={profile.officeAddress ?? '—'} /></div>
              </div>
              <div className="mt-4 space-y-4 text-sm leading-6 text-slate-700 dark:text-slate-300">
                <div>
                  <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100">经营范围</h4>
                  <p className="mt-1 whitespace-pre-wrap break-words">{profile.businessScope ?? '来源未提供'}</p>
                </div>
                <div>
                  <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100">公司简介</h4>
                  <p className="mt-1 whitespace-pre-wrap break-words">{profile.companyProfile ?? '来源未提供'}</p>
                </div>
              </div>
            </section>
          )}

          {latest && (
            <section data-testid="stock-fundamental-financial" aria-labelledby="stock-fundamental-financial-title">
              <div className="flex flex-wrap items-end justify-between gap-2 border-b border-slate-300 pb-2 dark:border-slate-600">
                <div>
                  <h3 id="stock-fundamental-financial-title" className="text-sm font-semibold text-slate-950 dark:text-white">最新主要财务</h3>
                  <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                    {formatDate(latest.reportDate)} · {latest.reportType ?? '报告类型未知'} · 公告 {formatDate(latest.noticeDate)} · {latest.currency ?? '币种未知'}
                  </p>
                </div>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">本地覆盖 {reportPeriods.length} 个报告期</span>
              </div>

              <div className="grid grid-cols-1 gap-x-5 sm:grid-cols-2">
                <FactCell label="营业收入" value={formatMoney(latest.totalRevenue, latest.currency)} />
                <FactCell label="营收同比" value={formatPercent(latest.revenueYoy)} />
                <FactCell label="归母净利润" value={formatMoney(latest.parentNetProfit, latest.currency)} />
                <FactCell label="归母净利同比" value={formatPercent(latest.parentNetProfitYoy)} />
                <FactCell label="扣非归母净利润" value={formatMoney(latest.deductedNetProfit, latest.currency)} />
                <FactCell label="扣非净利同比" value={formatPercent(latest.deductedNetProfitYoy)} />
                <FactCell label="经营现金流" value={formatMoney(latest.operatingCashFlow, latest.currency)} />
                <FactCell label="加权ROE" value={formatPercent(latest.weightedRoe)} />
                <FactCell label="毛利率" value={formatPercent(latest.grossMargin)} />
                <FactCell label="净利率" value={formatPercent(latest.netMargin)} />
                <FactCell label="资产负债率" value={formatPercent(latest.debtRatio)} />
                <FactCell label="基本每股收益" value={formatNumber(latest.basicEps, '元')} />
                <FactCell label="每股净资产" value={formatNumber(latest.bookValuePerShare, '元')} />
              </div>

              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[520px] text-left text-xs">
                  <caption className="sr-only">本地已保存财务报告期</caption>
                  <thead className="text-slate-500 dark:text-slate-400">
                    <tr className="border-b border-slate-200 dark:border-slate-700">
                      <th className="py-2 font-medium">报告期</th>
                      <th className="py-2 font-medium">类型</th>
                      <th className="py-2 font-medium">公告日</th>
                      <th className="py-2 text-right font-medium">营收同比</th>
                      <th className="py-2 text-right font-medium">归母净利同比</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.financialHistory.map((item) => (
                      <tr key={`${item.reportDate}:${item.sourceVersion}`} className="border-b border-slate-100 dark:border-slate-800">
                        <td className="py-2 tabular-nums text-slate-900 dark:text-slate-100">{formatDate(item.reportDate)}</td>
                        <td className="py-2 text-slate-600 dark:text-slate-300">{item.reportType ?? '—'}</td>
                        <td className="py-2 tabular-nums text-slate-600 dark:text-slate-300">{formatDate(item.noticeDate)}</td>
                        <td className="py-2 text-right tabular-nums text-slate-700 dark:text-slate-200">{formatPercent(item.revenueYoy)}</td>
                        <td className="py-2 text-right tabular-nums text-slate-700 dark:text-slate-200">{formatPercent(item.parentNetProfitYoy)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
            </div>
          ) : (
            <AnnouncementPanel snapshot={snapshot} onOpen={handleOpenAnnouncement} />
          )}
        </div>
      ) : null}
    </RightDrawer>
  )
}
