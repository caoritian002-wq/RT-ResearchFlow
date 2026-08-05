import { useEffect, useState } from 'react'
import DOMPurify from 'dompurify'
import { ImpactBadge } from '../ImpactBadge/ImpactBadge'
import { formatBjDateTime } from '../BriefingCard/dateFormat'
import IndustryAnalysisDrawer from '../IndustryChain/IndustryAnalysisDrawer'
import { useAppStore } from '../../store/appStore'
import type { Briefing } from '../../../electron/main/database/types'

interface Props {
  briefingId: number | null
}

function impactTone(briefing: Briefing): { label: string; reason: string; action: string } {
  if (briefing.impactRating === 'CRITICAL') {
    return {
      label: '重大影响',
      reason: `AI 影响评分 ${briefing.impactRatingScore.toFixed(1)}, 需要优先确认是否影响持仓、题材和产业链。`,
      action: '先读正文, 再做 AI 分析和产业链验证。',
    }
  }
  if (briefing.impactRating === 'IMPORTANT') {
    return {
      label: '重要影响',
      reason: `AI 影响评分 ${briefing.impactRatingScore.toFixed(1)}, 适合放入今日观察队列继续验证。`,
      action: '结合来源、发布时间和相关题材判断是否升级处理。',
    }
  }
  return {
    label: '一般资讯',
    reason: `AI 影响评分 ${briefing.impactRatingScore.toFixed(1)}, 当前更适合作为背景信息补充。`,
    action: '快速浏览摘要和原文, 必要时再进入 AI 分析。',
  }
}

function publicationTimeLabel(briefing: Briefing): string {
  if (briefing.publicationTimeStatus === 'collected_fallback') return '原始发布时间待校时，当前日期按采集时间暂存'
  if (briefing.publicationTimeStatus === 'date_only') return `发布日期 ${briefing.publishedDateBJ}，来源未提供精确时分`
  return formatBjDateTime(briefing.publishedAt)
}

export function BriefingDetail({ briefingId }: Props) {
  const { aiHasApiKey, loadAISessions } = useAppStore()
  const [briefing, setBriefing] = useState<Briefing | null>(null)
  const [detailContent, setDetailContent] = useState<{
    content: string | null
    status: 'OK' | 'NO_DETAIL_SELECTOR' | 'FETCH_ERROR' | 'PARSER_ERROR' | 'NO_MATCH'
    error?: string
  } | null>(null)
  const [isLoadingDetail, setIsLoadingDetail] = useState(false)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [analyzeToast, setAnalyzeToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [chainText, setChainText] = useState('')
  const [showChain, setShowChain] = useState(false)

  // Load briefing metadata
  useEffect(() => {
    console.log('[detail] briefingId changed:', briefingId)
    if (!briefingId) {
      setBriefing(null)
      setDetailContent(null)
      return
    }
    setBriefing(null)
    setDetailContent(null)
    window.api.briefings.getById(briefingId).then((b) => {
      console.log('[detail] briefing loaded:', b?.id, b?.originalUrl)
      setBriefing(b)
    })
  }, [briefingId])

  // Load detail content when briefing is available
  useEffect(() => {
    console.log('[detail] briefing effect fired, id:', briefing?.id)
    if (!briefing) return
    setIsLoadingDetail(true)
    console.log('[detail] calling getContent for id:', briefing.id, 'url:', briefing.originalUrl)
    window.api.detail
      .getContent(briefing.id)
      .then((result) => {
        console.log(
          '[detail] getContent result:',
          result.status,
          result.error ? result.error : `${result.content?.length ?? 0} chars`
        )
        setDetailContent(result)
      })
      .finally(() => setIsLoadingDetail(false))
  }, [briefing?.id])

  if (!briefingId) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div className="max-w-sm rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 py-8 dark:border-slate-800 dark:bg-slate-950/40">
          <div className="text-xs font-semibold uppercase tracking-wide text-cyan-600 dark:text-cyan-300">Detail Desk</div>
          <h2 className="mt-2 text-lg font-semibold text-slate-900 dark:text-white">选择一条高影响资讯</h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">详情区会展示正文、AI 分析入口、产业链分析和后续验证线索。</p>
        </div>
      </div>
    )
  }

  if (!briefing) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-400 dark:text-slate-500">
        加载中…
      </div>
    )
  }

  async function handleAIAnalyze() {
    if (!briefing || isAnalyzing) return
    setIsAnalyzing(true)
    setAnalyzeToast(null)
    try {
      const result = await window.api.ai.analyze({
        briefingIds: [briefing.id],
        scanRunId: null,
        briefingId: briefing.id
      })
      if (result && 'error' in result) {
        setAnalyzeToast({ type: 'error', message: (result as { error: { message: string } }).error.message || 'AI分析失败' })
        setTimeout(() => setAnalyzeToast(null), 4000)
      } else {
        await loadAISessions()
        setAnalyzeToast({ type: 'success', message: 'AI分析完成，结果已保存至AI分析Tab' })
        setTimeout(() => setAnalyzeToast(null), 4000)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'AI分析失败'
      setAnalyzeToast({ type: 'error', message: msg })
      setTimeout(() => setAnalyzeToast(null), 4000)
    } finally {
      setIsAnalyzing(false)
    }
  }

  const safeDetail = detailContent?.content
      ? DOMPurify.sanitize(detailContent.content, {
        USE_PROFILES: { html: true },
        ADD_TAGS: ['video', 'source', 'figure', 'figcaption'],
        ADD_ATTR: ['referrerpolicy', 'loading', 'decoding', 'srcset', 'sizes', 'controls', 'poster', 'preload', 'playsinline', 'target', 'rel']
      })
    : null
  const detailError = detailContent && detailContent.status !== 'OK' ? detailContent : null
  const tone = impactTone(briefing)
  const readStatusText = briefing.isRead ? '已读' : '待处理'

  return (
    <div data-testid="briefing-detail" className="h-full overflow-y-auto p-4">
      <IndustryAnalysisDrawer
        open={showChain}
        onClose={() => setShowChain(false)}
        text={chainText}
      />
      {/* Analysis toast */}
      {analyzeToast && (
        <div className={[
          'mb-3 px-3 py-2 rounded-md text-xs border',
          analyzeToast.type === 'success'
            ? 'bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-700 text-green-700 dark:text-green-300'
            : 'bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-700 text-red-600'
        ].join(' ')}>
          {analyzeToast.message}
        </div>
      )}

      <section className="mb-3 rounded-md border border-slate-200 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-slate-950/40">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <ImpactBadge rating={briefing.impactRating} />
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-300">{readStatusText}</span>
          <span className="rounded bg-white px-2 py-0.5 text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-300">{briefing.sourceName}</span>
          <span className={[
            'text-xs',
            briefing.publicationTimeStatus === 'collected_fallback'
              ? 'text-amber-600 dark:text-amber-300'
              : 'text-slate-400 dark:text-slate-500',
          ].join(' ')}>{publicationTimeLabel(briefing)}</span>
        </div>
        <h2 className="text-xl font-semibold leading-snug text-slate-950 dark:text-white">
          {briefing.title}
        </h2>
        <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">关联方向: {tone.action}</div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={handleAIAnalyze}
            disabled={!aiHasApiKey || isAnalyzing}
            title={!aiHasApiKey ? '请先前往 AI配置填写 API Key' : '对本文发起AI分析'}
            className={[
              'flex items-center gap-1 rounded px-2.5 py-1.5 text-xs font-medium transition-colors',
              aiHasApiKey && !isAnalyzing
                ? 'cursor-pointer border border-cyan-500 bg-cyan-600 text-white hover:bg-cyan-500'
                : 'cursor-not-allowed border border-slate-200 bg-slate-100 text-slate-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-500'
            ].join(' ')}
          >
            {isAnalyzing ? (
              <>
                <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                分析中
              </>
            ) : (
              '一键 AI 分析'
            )}
          </button>
          {briefing.impactRating !== 'GENERAL' && (
            <button
              type="button"
              onClick={() => {
                setChainText(`${briefing.title} ${briefing.summary ?? ''}`.trim())
                setShowChain(true)
              }}
              className="rounded border border-teal-200 bg-teal-50 px-2.5 py-1.5 text-xs font-medium text-teal-700 transition-colors hover:bg-teal-100 dark:border-teal-400/20 dark:bg-teal-400/10 dark:text-teal-200 dark:hover:bg-teal-400/15"
            >
              产业链分析
            </button>
          )}
          <a
            href={briefing.originalUrl}
            onClick={(e) => {
              e.preventDefault()
              window.open(briefing.originalUrl)
            }}
            className="rounded border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            打开原文
          </a>
        </div>
      </section>

      <section className="mb-3 rounded-md border border-cyan-100 bg-cyan-50/70 p-3 dark:border-cyan-400/20 dark:bg-cyan-400/10">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-white">为什么值得先看</h3>
        <p className="mt-1 text-sm leading-relaxed text-slate-700 dark:text-slate-300">{tone.reason}</p>
        <div className="mt-3 grid grid-cols-2 gap-2 xl:grid-cols-4">
          <div className="rounded bg-white/80 px-3 py-2 dark:bg-slate-950/35">
            <div className="text-[11px] text-slate-400 dark:text-slate-500">影响等级</div>
            <strong className="mt-1 block text-xs text-slate-800 dark:text-slate-100">{tone.label}</strong>
          </div>
          <div className="rounded bg-white/80 px-3 py-2 dark:bg-slate-950/35">
            <div className="text-[11px] text-slate-400 dark:text-slate-500">建议动作</div>
            <strong className="mt-1 block text-xs text-slate-800 dark:text-slate-100">{tone.action}</strong>
          </div>
          <div className="rounded bg-white/80 px-3 py-2 dark:bg-slate-950/35">
            <div className="text-[11px] text-slate-400 dark:text-slate-500">来源校验</div>
            <strong className="mt-1 block text-xs text-slate-800 dark:text-slate-100">{briefing.sourceName}</strong>
          </div>
          <div className="rounded bg-white/80 px-3 py-2 dark:bg-slate-950/35">
            <div className="text-[11px] text-slate-400 dark:text-slate-500">处理状态</div>
            <strong className="mt-1 block text-xs text-slate-800 dark:text-slate-100">{briefing.isRead ? '已处理' : '待验证'}</strong>
          </div>
        </div>
      </section>

      <section className="mb-3 rounded-md border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900/80">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-white">正文摘要</h3>
        <p className="mt-1 text-sm leading-relaxed text-slate-700 dark:text-slate-300">{briefing.summary}</p>
      </section>

      {detailError && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/20 p-3 text-xs text-amber-700 dark:text-amber-200">
          <div className="font-medium">正文抓取提示：</div>
          <div className="mt-1">
            {detailError.status === 'NO_DETAIL_SELECTOR' && '该来源未配置 detailSelector，已回退显示摘要。'}
            {detailError.status === 'NO_MATCH' && '已抓取正文页面，但未能匹配到选择器内容，已回退显示摘要。'}
            {detailError.status === 'FETCH_ERROR' && '正文抓取失败，已回退显示摘要。'}
            {detailError.status === 'PARSER_ERROR' && '正文解析失败，已回退显示摘要。'}
          </div>
          {detailError.error && <div className="mt-2 text-ellipsis text-[11px] text-amber-900 dark:text-amber-100">{detailError.error}</div>}
        </div>
      )}

      {/* Detail content (on-demand fetched) */}
      {isLoadingDetail && (
        <div className="py-2 text-xs text-slate-400 dark:text-slate-500">正在加载正文…</div>
      )}

      {!isLoadingDetail && safeDetail && (
        <div
          className="prose prose-sm max-w-none text-sm leading-relaxed text-slate-700 dark:text-slate-300 [&_.detail-video-reference]:my-4 [&_.detail-video-reference]:overflow-hidden [&_.detail-video-reference]:rounded-md [&_.detail-video-reference]:border [&_.detail-video-reference]:border-slate-200 [&_.detail-video-reference]:bg-slate-950 [&_.detail-video-reference_video]:mx-auto [&_.detail-video-reference_video]:block [&_.detail-video-reference_video]:max-h-[560px] [&_.detail-video-reference_video]:w-full [&_.detail-video-reference_figcaption]:m-0 [&_.detail-video-reference_figcaption]:bg-white [&_.detail-video-reference_figcaption]:px-3 [&_.detail-video-reference_figcaption]:py-2 [&_.detail-video-reference_figcaption]:text-xs dark:[&_.detail-video-reference]:border-slate-700 dark:[&_.detail-video-reference_figcaption]:bg-slate-900"
          dangerouslySetInnerHTML={{ __html: safeDetail }}
        />
      )}

      {/* Fallback: fullContent from DB when no detailSelector or fetch failed */}
      {!isLoadingDetail && !safeDetail && briefing.fullContent && (
        <div className="prose prose-sm max-w-none whitespace-pre-wrap text-sm leading-relaxed text-slate-700 dark:text-slate-300">
          {briefing.fullContent.replace(/<[^>]*>/g, '')}
        </div>
      )}

      {/* Link */}
      <div className="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800">
        <a
          href={briefing.originalUrl}
          onClick={(e) => {
            e.preventDefault()
            window.open(briefing.originalUrl)
          }}
          className="break-all text-xs font-medium text-cyan-600 hover:underline dark:text-cyan-300"
        >
          {briefing.originalUrl}
        </a>
      </div>
    </div>
  )
}
