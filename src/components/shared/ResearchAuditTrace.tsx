import React, { useEffect, useRef, useState } from 'react'

export interface ResearchAuditTraceView {
  schemaVersion: 1
  status: 'passed' | 'warning' | 'blocked'
  replayStatus: 'ready' | 'legacy' | 'document_mismatch' | 'snapshot_mismatch' | 'evidence_unavailable'
  generatedAt: number
  asOf: string | null
  originalTextSha256: string
  checkedCharacters: number
  evidenceSnapshotSha256: string | null
  evidenceSummary: {
    subjectCount: number
    supporting: number
    challenging: number
    unknowns: number
  }
  citationSummary: {
    availableReferences: number
    referencedReferences: number
    unresolvedReferences: number
  }
  checkSummary: {
    passed: number
    warning: number
    blocked: number
  }
  findings: Array<{
    code: string
    status: 'passed' | 'warning' | 'blocked'
    message: string
    excerpts: string[]
  }>
  warnings: string[]
  subjects: Array<{
    subjectKind: 'stock' | 'judgment' | 'industry_project'
    subjectId: string
    label: string
    items: Array<{
      referenceId: string
      category: 'supporting' | 'challenging' | 'unknowns'
      toolId: string
      label: string
      detail: string
      factDate: string | null
      sourceIds: string[]
      referenced: boolean
    }>
  }>
}

export type ResearchEvidenceDeltaChange = 'changed' | 'added' | 'removed' | 'unchanged'

export interface ResearchEvidenceDeltaView {
  schemaVersion: 1
  status: 'ready' | 'partial'
  generatedAt: number
  historicalAsOf: string | null
  currentAsOf: string
  summary: Record<ResearchEvidenceDeltaChange, number>
  warnings: string[]
  subjects: Array<{
    subjectKind: 'stock' | 'judgment' | 'industry_project'
    subjectId: string
    label: string
    items: Array<{
      referenceId: string
      change: ResearchEvidenceDeltaChange
      historical: ResearchAuditTraceView['subjects'][number]['items'][number] | null
      current: ResearchAuditTraceView['subjects'][number]['items'][number] | null
    }>
  }>
}

export type ResearchEvidenceCompareAction = () => Promise<
  | { ok: true; data: ResearchEvidenceDeltaView }
  | { ok: false; code?: string; message?: string }
>

export type ResearchEvidenceDiscussionAction = () => Promise<
  | { ok: true }
  | { ok: false; message?: string }
>

const STATUS_META = {
  passed: {
    label: '审计通过',
    className: 'text-emerald-700 dark:text-emerald-300',
  },
  warning: {
    label: '存在审计警告',
    className: 'text-amber-800 dark:text-amber-300',
  },
  blocked: {
    label: '输出已阻断',
    className: 'text-red-700 dark:text-red-300',
  },
} as const

const CATEGORY_META = {
  supporting: {
    label: '支持证据',
    className: 'text-emerald-700 dark:text-emerald-300',
  },
  challenging: {
    label: '反证与风险',
    className: 'text-amber-800 dark:text-amber-300',
  },
  unknowns: {
    label: '未知与待核验',
    className: 'text-slate-600 dark:text-slate-300',
  },
} as const

const DELTA_META = {
  changed: { label: '已变化', className: 'text-amber-800 dark:text-amber-300' },
  added: { label: '新增', className: 'text-cyan-700 dark:text-cyan-300' },
  removed: { label: '不再出现', className: 'text-red-700 dark:text-red-300' },
  unchanged: { label: '未变化', className: 'text-slate-600 dark:text-slate-300' },
} as const

type DeltaFilter = 'changes' | ResearchEvidenceDeltaChange

function formatFactDate(value: string | null): string {
  if (!value || !/^\d{8}$/.test(value)) return '事实日未知'
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

function replayLabel(trace: ResearchAuditTraceView): string {
  if (trace.replayStatus === 'document_mismatch') return '正文校验不匹配'
  if (trace.replayStatus === 'snapshot_mismatch') return '证据快照不匹配'
  if (trace.replayStatus === 'evidence_unavailable') return '证据快照不可用'
  if (trace.replayStatus === 'legacy') return '历史审计，无结论级引用'
  if (trace.citationSummary.unresolvedReferences > 0) {
    return `${trace.citationSummary.unresolvedReferences} 个引用无法定位`
  }
  return `已定位 ${trace.citationSummary.referencedReferences}/${trace.citationSummary.availableReferences} 项证据`
}

export function ResearchAuditTrace({
  trace,
  variant = 'full',
  onCompareCurrent,
  onDiscussChanges,
}: {
  trace?: ResearchAuditTraceView | null
  variant?: 'compact' | 'full'
  onCompareCurrent?: ResearchEvidenceCompareAction
  onDiscussChanges?: ResearchEvidenceDiscussionAction
}): React.ReactElement | null {
  const compareRequestRef = useRef(0)
  const [delta, setDelta] = useState<ResearchEvidenceDeltaView | null>(null)
  const [deltaLoading, setDeltaLoading] = useState(false)
  const [deltaError, setDeltaError] = useState<string | null>(null)
  const [deltaFilter, setDeltaFilter] = useState<DeltaFilter>('changes')
  const [discussionLoading, setDiscussionLoading] = useState(false)
  const [discussionError, setDiscussionError] = useState<string | null>(null)
  const traceIdentity = trace
    ? `${trace.originalTextSha256}:${trace.evidenceSnapshotSha256 ?? 'none'}`
    : 'none'
  useEffect(() => {
    compareRequestRef.current += 1
    setDelta(null)
    setDeltaLoading(false)
    setDeltaError(null)
    setDeltaFilter('changes')
    setDiscussionLoading(false)
    setDiscussionError(null)
  }, [traceIdentity])
  if (!trace) return null
  const status = STATUS_META[trace.status]
  const containerClass = variant === 'compact'
    ? 'mt-3 border-t border-slate-200 pt-1 dark:border-slate-700'
    : 'rounded-md border border-slate-200 bg-white px-4 dark:border-slate-800 dark:bg-slate-900'
  const canCompare = Boolean(
    onCompareCurrent
    && (trace.replayStatus === 'ready' || trace.replayStatus === 'legacy')
    && trace.subjects.length > 0,
  )

  async function compareCurrent(): Promise<void> {
    if (!onCompareCurrent || deltaLoading) return
    const requestId = ++compareRequestRef.current
    setDeltaLoading(true)
    setDeltaError(null)
    try {
      const response = await onCompareCurrent()
      if (requestId !== compareRequestRef.current) return
      if (!response.ok) {
        setDeltaError(response.message || '当前本地事实读取失败')
        return
      }
      setDelta(response.data)
      setDeltaFilter('changes')
    } catch (error) {
      if (requestId !== compareRequestRef.current) return
      setDeltaError(error instanceof Error ? error.message : '当前本地事实读取失败')
    } finally {
      if (requestId === compareRequestRef.current) setDeltaLoading(false)
    }
  }

  async function discussChanges(): Promise<void> {
    if (!onDiscussChanges || discussionLoading) return
    setDiscussionLoading(true)
    setDiscussionError(null)
    try {
      const response = await onDiscussChanges()
      if (!response.ok) setDiscussionError(response.message || '创建事实变化讨论失败')
    } catch (error) {
      setDiscussionError(error instanceof Error ? error.message : '创建事实变化讨论失败')
    } finally {
      setDiscussionLoading(false)
    }
  }

  return (
    <details data-testid="research-audit-trace" className={containerClass}>
      <summary className="flex min-h-11 cursor-pointer list-inside items-center gap-2 py-2 text-xs font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900">
        <span className={status.className}>{status.label}</span>
        <span className="font-normal text-slate-500 dark:text-slate-400">{replayLabel(trace)}</span>
      </summary>
      <div className="min-w-0 space-y-4 pb-4 text-xs leading-5 text-slate-600 dark:text-slate-300">
        {trace.replayStatus === 'document_mismatch' && (
          <p role="alert" className="border-l-2 border-red-400 pl-3 text-red-700 dark:text-red-300">
            当前展示正文与审计时保存的正文校验值不一致，系统已停止关联具体证据，避免用旧审计解释被改写的文本。
          </p>
        )}
        {trace.replayStatus === 'snapshot_mismatch' && (
          <p role="alert" className="border-l-2 border-red-400 pl-3 text-red-700 dark:text-red-300">
            当前证据投影与审计时保存的快照校验值不一致，系统已停止关联具体证据，避免用错误快照解释历史结论。
          </p>
        )}
        {trace.replayStatus === 'evidence_unavailable' && (
          <p className="border-l-2 border-slate-300 pl-3 text-slate-600 dark:border-slate-600 dark:text-slate-300">
            该结果没有可回放的结构化证据快照。正文和原始审计校验值仍保留。
          </p>
        )}
        {trace.replayStatus === 'legacy' && (
          <p className="border-l-2 border-amber-400 pl-3 text-amber-800 dark:text-amber-300">
            该结果生成于结论级引用上线前。证据快照可以回放，但不能声称正文已经逐项引用。
          </p>
        )}

        <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
          <AuditMetric label="事实截点" value={formatFactDate(trace.asOf)} />
          <AuditMetric label="审计规则" value={`${trace.checkSummary.passed} 通过 / ${trace.checkSummary.warning} 警告 / ${trace.checkSummary.blocked} 阻断`} />
          <AuditMetric label="证据结构" value={`${trace.evidenceSummary.supporting} 支持 / ${trace.evidenceSummary.challenging} 反证 / ${trace.evidenceSummary.unknowns} 未知`} />
          <AuditMetric label="正文字符" value={String(trace.checkedCharacters)} />
        </div>

        {canCompare && (
          <section data-testid="research-evidence-delta" aria-label="历史证据与当前本地事实对比" className="border-y border-slate-200 py-3 dark:border-slate-700">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h4 className="font-semibold text-slate-800 dark:text-slate-100">事实变化</h4>
                {delta && (
                  <div className="mt-0.5 text-slate-400">
                    历史 {formatFactDate(delta.historicalAsOf)} · 当前 {formatFactDate(delta.currentAsOf)}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => { void compareCurrent() }}
                disabled={deltaLoading}
                className="min-h-11 rounded-md border border-cyan-600 bg-white px-3 font-semibold text-cyan-700 transition-colors hover:bg-cyan-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none dark:bg-slate-900 dark:text-cyan-300 dark:hover:bg-cyan-950/30 dark:focus-visible:ring-offset-slate-900"
              >
                {deltaLoading ? '正在读取本地事实...' : delta ? '重新对比' : '对比当前事实'}
              </button>
            </div>
            {deltaError && (
              <p role="alert" className="mt-3 border-l-2 border-red-400 pl-3 text-red-700 dark:text-red-300">
                {deltaError}
              </p>
            )}
            {delta && (
              <ResearchEvidenceDelta
                delta={delta}
                filter={deltaFilter}
                onFilterChange={setDeltaFilter}
                onDiscussChanges={onDiscussChanges ? discussChanges : undefined}
                discussionLoading={discussionLoading}
                discussionError={discussionError}
              />
            )}
          </section>
        )}

        {trace.findings.length > 0 && (
          <section aria-label="审计发现">
            <h4 className="font-semibold text-slate-800 dark:text-slate-100">审计发现</h4>
            <ul className="mt-2 space-y-2">
              {trace.findings.map((finding) => (
                <li key={finding.code} className="border-l-2 border-amber-400 pl-3">
                  <div className="font-medium text-slate-700 dark:text-slate-200">{finding.message}</div>
                  <div className="mt-0.5 break-all font-mono text-[12px] text-slate-400">{finding.code}</div>
                  {finding.excerpts.length > 0 && (
                    <div className="mt-1 text-slate-500 dark:text-slate-400">命中：{finding.excerpts.join('；')}</div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {trace.subjects.length > 0 && (
          <section aria-label="证据快照">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h4 className="font-semibold text-slate-800 dark:text-slate-100">本轮证据快照</h4>
              <span className="text-slate-400">被正文引用的编号标记为“已引用”</span>
            </div>
            <div className="mt-2 divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-700 dark:border-slate-700">
              {trace.subjects.map((subject) => (
                <div key={`${subject.subjectKind}:${subject.subjectId}`} className="py-3">
                  <div className="font-semibold text-slate-800 dark:text-slate-100">{subject.label}</div>
                  <div className="mt-2 space-y-2">
                    {subject.items.map((item) => {
                      const category = CATEGORY_META[item.category]
                      return (
                        <div key={item.referenceId} className="grid min-w-0 gap-1 sm:grid-cols-[112px_minmax(0,1fr)] sm:gap-3">
                          <div className="flex flex-wrap items-center gap-1">
                            <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[12px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                              {item.referenceId}
                            </code>
                            {item.referenced && <span className="font-semibold text-cyan-700 dark:text-cyan-300">已引用</span>}
                          </div>
                          <div className="min-w-0">
                            <div><span className={category.className}>{category.label}</span> · {item.label}</div>
                            <div className="mt-0.5 break-words text-slate-500 dark:text-slate-400">{item.detail}</div>
                            <div className="mt-0.5 break-all text-slate-400">
                              {item.toolId} · {formatFactDate(item.factDate)} · {item.sourceIds.length > 0 ? item.sourceIds.join('、') : '来源未知'}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {trace.warnings.length > 0 && (
          <section aria-label="工具警告">
            <h4 className="font-semibold text-slate-800 dark:text-slate-100">工具警告</h4>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {trace.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}
            </ul>
          </section>
        )}

        <div className="space-y-1 border-t border-slate-200 pt-3 font-mono text-[12px] text-slate-400 dark:border-slate-700">
          <div className="break-all">正文 SHA-256：{trace.originalTextSha256}</div>
          {trace.evidenceSnapshotSha256 && <div className="break-all">证据 SHA-256：{trace.evidenceSnapshotSha256}</div>}
        </div>
      </div>
    </details>
  )
}

export function ResearchEvidenceDelta({
  delta,
  filter,
  onFilterChange,
  onDiscussChanges,
  discussionLoading = false,
  discussionError,
}: {
  delta: ResearchEvidenceDeltaView
  filter: DeltaFilter
  onFilterChange: (filter: DeltaFilter) => void
  onDiscussChanges?: () => void
  discussionLoading?: boolean
  discussionError?: string | null
}): React.ReactElement {
  const filterItems: Array<{ id: DeltaFilter; label: string; count: number }> = [
    {
      id: 'changes',
      label: '全部变化',
      count: delta.summary.changed + delta.summary.added + delta.summary.removed,
    },
    { id: 'changed', label: DELTA_META.changed.label, count: delta.summary.changed },
    { id: 'added', label: DELTA_META.added.label, count: delta.summary.added },
    { id: 'removed', label: DELTA_META.removed.label, count: delta.summary.removed },
    { id: 'unchanged', label: DELTA_META.unchanged.label, count: delta.summary.unchanged },
  ]
  const visibleSubjects = delta.subjects.map((subject) => ({
    ...subject,
    items: subject.items.filter((item) => filter === 'changes'
      ? item.change !== 'unchanged'
      : item.change === filter),
  })).filter((subject) => subject.items.length > 0)
  const generatedAt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(delta.generatedAt))

  return (
    <div className="mt-3 min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-medium text-slate-700 dark:text-slate-200">
          {delta.status === 'partial' ? '当前事实存在缺口' : '当前事实读取完成'}
          <span className="ml-2 font-normal text-slate-400">{generatedAt}</span>
        </div>
        <div role="group" aria-label="事实变化筛选" className="flex flex-wrap gap-2">
          {filterItems.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={filter === item.id}
              onClick={() => onFilterChange(item.id)}
              className={`min-h-11 rounded-md border px-3 font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 motion-reduce:transition-none ${filter === item.id
                ? 'border-cyan-600 bg-cyan-50 text-cyan-800 dark:bg-cyan-950/30 dark:text-cyan-200'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'}`}
            >
              {item.label} {item.count}
            </button>
          ))}
        </div>
      </div>

      {filterItems[0].count > 0 && onDiscussChanges && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-cyan-500 bg-cyan-50/70 px-3 py-2 dark:bg-cyan-950/20">
          <p className="min-w-0 flex-1 text-slate-600 dark:text-slate-300">
            将由主进程重新校验这些变化，并作为不可变上下文进入研究讨论。
          </p>
          <button
            type="button"
            onClick={onDiscussChanges}
            disabled={discussionLoading}
            className="min-h-11 shrink-0 rounded-md bg-cyan-700 px-4 font-semibold text-white transition-colors hover:bg-cyan-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none dark:focus-visible:ring-offset-slate-900"
          >
            {discussionLoading ? '正在进入讨论...' : '基于变化继续讨论'}
          </button>
        </div>
      )}
      {discussionError && (
        <p role="alert" className="border-l-2 border-red-400 pl-3 text-red-700 dark:text-red-300">
          {discussionError}
        </p>
      )}

      {visibleSubjects.length === 0 ? (
        <p className="py-3 text-center text-slate-500 dark:text-slate-400">
          {filter === 'changes' ? '当前本地证据与历史快照一致。' : '当前筛选没有证据项。'}
        </p>
      ) : (
        <div className="divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-700 dark:border-slate-700">
          {visibleSubjects.map((subject) => (
            <section key={`${subject.subjectKind}:${subject.subjectId}`} className="py-3" aria-label={`${subject.label}事实变化`}>
              <h5 className="font-semibold text-slate-800 dark:text-slate-100">{subject.label}</h5>
              <div className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
                {subject.items.map((item) => (
                  <div key={item.referenceId} className="min-w-0 py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`font-semibold ${DELTA_META[item.change].className}`}>{DELTA_META[item.change].label}</span>
                      <code className="break-all rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[12px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                        {item.referenceId}
                      </code>
                      {item.historical?.referenced && <span className="font-medium text-cyan-700 dark:text-cyan-300">原文已引用</span>}
                    </div>
                    <div className="mt-2 grid min-w-0 gap-3 sm:grid-cols-2">
                      <DeltaEvidenceSide label="历史快照" item={item.historical} />
                      <DeltaEvidenceSide label="当前本地" item={item.current} />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {delta.summary.removed > 0 && (
        <p className="border-l-2 border-amber-400 pl-3 text-amber-800 dark:text-amber-300">
          “不再出现”表示当前证据规则没有产出同一编号，不等于历史事实已被证伪。
        </p>
      )}
      {delta.warnings.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-slate-500 dark:text-slate-400">
          {delta.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}
        </ul>
      )}
    </div>
  )
}

function DeltaEvidenceSide({
  label,
  item,
}: {
  label: string
  item: ResearchAuditTraceView['subjects'][number]['items'][number] | null
}): React.ReactElement {
  return (
    <div className="min-w-0 border-l-2 border-slate-200 pl-3 dark:border-slate-700">
      <div className="font-semibold text-slate-500 dark:text-slate-400">{label}</div>
      {item ? (
        <div className="mt-1 min-w-0 space-y-0.5">
          <div className={CATEGORY_META[item.category].className}>{CATEGORY_META[item.category].label} · {item.label}</div>
          <div className="break-words text-slate-600 dark:text-slate-300">{item.detail}</div>
          <div className="break-all text-slate-400">
            {item.toolId} · {formatFactDate(item.factDate)} · {item.sourceIds.length > 0 ? item.sourceIds.join('、') : '来源未知'}
          </div>
        </div>
      ) : (
        <div className="mt-1 text-slate-400">无对应证据项</div>
      )}
    </div>
  )
}

function AuditMetric({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="min-w-0">
      <div className="text-slate-400">{label}</div>
      <div className="mt-0.5 break-words font-medium text-slate-700 dark:text-slate-200">{value}</div>
    </div>
  )
}
