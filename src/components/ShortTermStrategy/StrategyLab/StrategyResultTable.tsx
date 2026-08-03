import { useMemo, useState } from 'react'
import type { StrategyLabMatchRow } from './strategyLabModel'

interface StrategyResultTableProps {
  matches: StrategyLabMatchRow[]
  selectedMatchId: number | null
  onSelectMatch: (id: number) => void
  onOpenEvidence: (id: number) => void
  onCreateBacktest?: () => void | Promise<void>
}

function parseEvidenceLabels(match: StrategyLabMatchRow): string[] {
  try {
    const evidence = JSON.parse(match.evidenceJson) as Record<string, unknown>
    if (Array.isArray(evidence.conditionsMet)) return evidence.conditionsMet.slice(0, 4).map(String)
    if (Array.isArray(evidence.passedConditions)) return evidence.passedConditions.slice(0, 4).map(String)
    if (Array.isArray(evidence.flatConditions)) {
      const names = evidence.flatConditions
        .filter(item => item && typeof item === 'object' && (item as { passed?: unknown }).passed === true)
        .map(item => String((item as { name?: unknown }).name ?? '条件通过'))
        .slice(0, 4)
      if (names.length > 0) return names
    }
    if (typeof evidence.dataStatus === 'string') return [evidence.dataStatus]
  } catch {
    // ignore invalid evidence json
  }
  return [match.matchedFrom]
}

function sourceText(source: StrategyLabMatchRow['source']): string {
  if (source === 'screener') return '个性选股'
  if (source === 'conditionBlocks') return '条件积木'
  return '自定义'
}

function evidenceCompleteness(match: StrategyLabMatchRow): number {
  try {
    const evidence = JSON.parse(match.evidenceJson) as { dataStatus?: string; root?: { dataStatus?: string } }
    const status = evidence.dataStatus ?? evidence.root?.dataStatus
    return status === 'complete' ? 2 : status === 'partial' ? 1 : 0
  } catch {
    return 0
  }
}

export function StrategyResultTable({ matches, selectedMatchId, onSelectMatch, onOpenEvidence, onCreateBacktest }: StrategyResultTableProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<'all' | StrategyLabMatchRow['source']>('all')
  const [sortBy, setSortBy] = useState<'score' | 'date' | 'completeness'>('score')
  const rows = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const filtered = matches.filter(match => {
      if (source !== 'all' && match.source !== source) return false
      if (!keyword) return true
      return match.tsCode.toLowerCase().includes(keyword) || (match.stockName ?? '').toLowerCase().includes(keyword)
    })
    return [...filtered].sort((a, b) => {
      if (sortBy === 'date') return b.tradeDate.localeCompare(a.tradeDate) || b.score - a.score
      if (sortBy === 'completeness') return evidenceCompleteness(b) - evidenceCompleteness(a) || b.score - a.score
      return b.score - a.score || b.tradeDate.localeCompare(a.tradeDate)
    })
  }, [matches, query, sortBy, source])
  return (
    <section className="flex min-h-[390px] flex-1 flex-col rounded-md border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">统一命中结果</h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">按真实命中质量排序，再查看逐条件证据或进入回测</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="sr-only" htmlFor="strategy-lab-search">搜索命中股票</label>
          <input id="strategy-lab-search" value={query} onChange={(event) => setQuery(event.target.value)} className="h-8 w-44 rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-700 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" placeholder="搜索代码 / 名称" />
          <label className="sr-only" htmlFor="strategy-lab-source">来源筛选</label>
          <select id="strategy-lab-source" value={source} onChange={(event) => setSource(event.target.value as typeof source)} className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200">
            <option value="all">全部策略</option>
            <option value="screener">个性选股</option>
            <option value="conditionBlocks">条件积木</option>
            <option value="custom">自定义</option>
          </select>
          <label className="sr-only" htmlFor="strategy-lab-sort">排序方式</label>
          <select id="strategy-lab-sort" value={sortBy} onChange={event => setSortBy(event.target.value as typeof sortBy)} className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200">
            <option value="score">得分优先</option>
            <option value="date">日期优先</option>
            <option value="completeness">数据完整优先</option>
          </select>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-x-auto">
        <table className="min-w-full text-left text-xs">
          <thead className="bg-slate-50 text-slate-500 dark:bg-slate-950/60 dark:text-slate-400">
            <tr>
              <th className="px-4 py-2 font-medium">代码</th>
              <th className="px-4 py-2 font-medium">名称</th>
              <th className="px-4 py-2 font-medium">交易日</th>
              <th className="px-4 py-2 font-medium">分数</th>
              <th className="px-4 py-2 font-medium">来源</th>
              <th className="px-4 py-2 font-medium">命中条件</th>
              <th className="px-4 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {(rows.length > 0 ? rows : []).map((row) => {
              const labels = parseEvidenceLabels(row)
              const active = selectedMatchId === row.id
              return (
              <tr key={row.id} onClick={() => onSelectMatch(row.id)} className={(active ? 'bg-teal-50 dark:bg-teal-950/30 ' : '') + 'cursor-pointer text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-950/50'}>
                <td className="px-4 py-3 font-mono text-slate-500 dark:text-slate-400">{row.tsCode.replace(/\.(SH|SZ|BJ)$/i, '')}</td>
                <td className="px-4 py-3 font-semibold text-slate-900 dark:text-slate-100">{row.stockName ?? row.tsCode}</td>
                <td className="px-4 py-3 font-mono text-slate-400">{row.tradeDate}</td>
                <td className="px-4 py-3 font-mono font-bold text-rose-600 dark:text-rose-300">{row.score.toFixed(1)}</td>
                <td className="px-4 py-3">
                  <span className="rounded bg-cyan-50 px-1.5 py-0.5 text-[11px] font-medium text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-200">{sourceText(row.source)}</span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    {labels.map(item => (
                      <span key={item} className="rounded bg-orange-50 px-1.5 py-0.5 text-[11px] font-medium text-orange-700 dark:bg-orange-900/30 dark:text-orange-200">{item}</span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3 text-right">
                  <button type="button" onClick={(event) => { event.stopPropagation(); onOpenEvidence(row.id) }} className="min-h-8 rounded-md border border-slate-200 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-teal-500/30 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">
                    证据
                  </button>
                </td>
              </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-16 text-center text-xs text-slate-500 dark:text-slate-400">
                  暂无统一命中结果。选择左侧策略后点击“运行扫描”生成真实 run/match。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {onCreateBacktest && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-3 dark:border-slate-800">
          <span className="text-xs text-slate-500 dark:text-slate-400">回测使用当前完整 run 的命中结果，不受表格搜索和排序影响。</span>
          <button type="button" disabled={matches.length === 0} onClick={() => void onCreateBacktest()} className="min-h-9 rounded bg-slate-900 px-3 text-xs font-medium text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-500/30 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white">
            将本次运行加入回测
          </button>
        </div>
      )}
    </section>
  )
}
