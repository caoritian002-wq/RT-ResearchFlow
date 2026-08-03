import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StockKlineChipDrawer } from '../shared/StockMiniChart'
import { useAppStore } from '../../store/appStore'
import {
  OptionMenu,
  TrendPageHeader,
  TrendStateBadge,
  WorkbenchError,
  formatTrendDate,
} from './TrendWorkbenchUi'
import { TrendConfirmDialog } from './TrendConfirmDialog'
import type { TrendWorkbenchItem, TrendWorkbenchPageProps } from './trendWorkbenchTypes'

const CATEGORY_TREE: Record<string, string[]> = {
  AI算力: ['AI服务器'],
  半导体设备: ['刻蚀设备', '薄膜沉积设备', '清洗设备', '离子注入'],
  半导体材料: ['光刻胶（KrF/ArF高端）', '光刻胶（G/I线成熟）', '半导体硅片', '溅射靶材', 'CMP抛光材料', 'EDA软件', '先进封装（封测）', '测试板'],
  CPO: ['光模块', '光器件', 'CPO交换机', '封装/耦合设备'],
  PCB: ['消费电子/FPC', '通信/服务器PCB', '汽车电子PCB', 'IC封装基板', '覆铜板（CCL）', '显卡/新能源PCB'],
  锂电池: ['磷酸铁锂正极', '三元材料正极', '负极材料', '电解液', '隔膜', '结构件', '锂电设备'],
  固态电池: ['固态电池（整体）', '硫化物电解质', '氧化物电解质', '固态电池隔膜'],
  '绿色能源（风电）': ['风电整机', '风电叶片'],
  储能: ['储能系统集成商', '储能电池'],
  能源金属: ['锂矿', '钴', '镍'],
}

interface WatchItem {
  tsCode: string
  stockName: string
  groupTag: string
  addedAt: number
  category: string
  subCategory: string
  notes: string
}

interface SearchResult {
  tsCode: string
  name: string
}

interface ProgressState {
  current: number
  total: number
  detail: string
}

export function TrendManager({ snapshot, loading, errorMessage, onRefresh }: TrendWorkbenchPageProps) {
  const [watchRows, setWatchRows] = useState<WatchItem[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [selectedStocks, setSelectedStocks] = useState<Map<string, SearchResult>>(new Map())
  const [showSearchResults, setShowSearchResults] = useState(false)
  const [inputGroup, setInputGroup] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('')
  const [selectedSubCategory, setSelectedSubCategory] = useState('')
  const [listCategory, setListCategory] = useState('')
  const [listSubCategory, setListSubCategory] = useState('')
  const [adding, setAdding] = useState(false)
  const [actionMessage, setActionMessage] = useState<{ tone: 'info' | 'error' | 'success'; text: string } | null>(null)
  const [editingGroupCode, setEditingGroupCode] = useState<string | null>(null)
  const [editingGroupValue, setEditingGroupValue] = useState('')
  const [removeTarget, setRemoveTarget] = useState<TrendWorkbenchItem | null>(null)
  const [removing, setRemoving] = useState(false)
  const [selectedDetail, setSelectedDetail] = useState<TrendWorkbenchItem | null>(null)
  const [backfillRunning, setBackfillRunning] = useState(false)
  const [backfillProgress, setBackfillProgress] = useState<ProgressState | null>(null)
  const [syncRunning, setSyncRunning] = useState(false)
  const [syncProgress, setSyncProgress] = useState<ProgressState | null>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchRootRef = useRef<HTMLDivElement>(null)
  const navigateToStock = useAppStore((state) => state.navigateToStock)

  const loadWatchRows = useCallback(async () => {
    setListLoading(true)
    try {
      const response = await window.api.trend.getWatchList()
      if (response.ok && response.data) setWatchRows(response.data as WatchItem[])
    } finally {
      setListLoading(false)
    }
  }, [])

  useEffect(() => { void loadWatchRows() }, [loadWatchRows])

  useEffect(() => {
    const closeSearch = (event: MouseEvent) => {
      if (!searchRootRef.current?.contains(event.target as Node)) setShowSearchResults(false)
    }
    document.addEventListener('mousedown', closeSearch)
    return () => document.removeEventListener('mousedown', closeSearch)
  }, [])

  useEffect(() => {
    const offBackfillProgress = window.api.trend.onBackfillProgress((progress) => {
      setBackfillRunning(true)
      setBackfillProgress({ current: progress.current, total: progress.total, detail: `${stripCode(progress.tsCode)} · ${backfillStatusLabel(progress.status)}` })
    })
    const offBackfillDone = window.api.trend.onBackfillDone((result) => {
      setBackfillRunning(false)
      setBackfillProgress({ current: result.requested, total: result.requested, detail: `补齐 ${result.synced}，复用 ${result.skipped}，失败 ${result.failed}` })
      void loadWatchRows()
      onRefresh()
    })
    const offSyncProgress = window.api.trend.onSyncProgress((progress) => {
      setSyncRunning(true)
      setSyncProgress({ current: progress.current, total: progress.total, detail: formatTrendDate(progress.tradeDate) })
    })
    const offSyncDone = window.api.trend.onSyncDone((result) => {
      setSyncRunning(false)
      setSyncProgress({ current: result.synced + result.skipped + result.failed, total: result.synced + result.skipped + result.failed, detail: `同步 ${result.synced}，跳过 ${result.skipped}，失败 ${result.failed}` })
      onRefresh()
    })
    return () => {
      offBackfillProgress()
      offBackfillDone()
      offSyncProgress()
      offSyncDone()
    }
  }, [loadWatchRows, onRefresh])

  useEffect(() => () => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
  }, [])

  const allItems = useMemo(() => {
    const watchCodes = new Set(watchRows.map((row) => normalizeCode(row.tsCode)))
    return [...(snapshot?.items ?? [])]
      .filter((item) => watchCodes.has(normalizeCode(item.tsCode)))
      .sort((left, right) => {
        const coverageOrder = coveragePriority(left) - coveragePriority(right)
        if (coverageOrder !== 0) return coverageOrder
        return left.stockCode.localeCompare(right.stockCode)
      })
  }, [snapshot?.items, watchRows])

  const items = useMemo(() => {
    if (!listCategory && !listSubCategory) return allItems
    const visibleCodes = new Set(
      watchRows
        .filter((row) => (!listCategory || row.category === listCategory)
          && (!listSubCategory || row.subCategory === listSubCategory))
        .map((row) => normalizeCode(row.tsCode)),
    )
    return allItems.filter((item) => visibleCodes.has(normalizeCode(item.tsCode)))
  }, [allItems, listCategory, listSubCategory, watchRows])

  const missingCodes = useMemo(() => allItems.filter((item) => item.dataCoverage.state !== 'ready').map((item) => item.tsCode), [allItems])
  const categoryOptions = useMemo(() => [
    { value: '', label: '暂不分类' },
    ...Object.keys(CATEGORY_TREE).map((value) => ({ value, label: value })),
  ], [])
  const subCategoryOptions = useMemo(() => [
    { value: '', label: selectedCategory ? '暂不选择赛道' : '请先选择分类' },
    ...(CATEGORY_TREE[selectedCategory] ?? []).map((value) => ({ value, label: value })),
  ], [selectedCategory])
  const listCategoryOptions = useMemo(() => buildFilterOptions(
    watchRows,
    'category',
    `全部分类 (${allItems.length})`,
  ), [allItems.length, watchRows])
  const listSubCategoryOptions = useMemo(() => buildFilterOptions(
    listCategory ? watchRows.filter((row) => row.category === listCategory) : watchRows,
    'subCategory',
    listCategory ? '全部细分赛道' : '全部赛道',
  ), [listCategory, watchRows])

  const handleSearch = (value: string) => {
    setSearchQuery(value)
    setActionMessage(null)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    if (!value.trim()) {
      setSearchResults([])
      setShowSearchResults(false)
      return
    }
    searchTimerRef.current = setTimeout(async () => {
      setSearchLoading(true)
      try {
        const response = await window.api.trend.searchStocks(value.trim())
        if (response.ok && response.data) {
          setSearchResults(response.data)
          setShowSearchResults(true)
        } else {
          setActionMessage({ tone: 'error', text: response.error ?? '股票搜索失败' })
        }
      } finally {
        setSearchLoading(false)
      }
    }, 240)
  }

  const toggleSearchResult = (result: SearchResult) => {
    setSelectedStocks((current) => {
      const next = new Map(current)
      if (next.has(result.tsCode)) next.delete(result.tsCode)
      else next.set(result.tsCode, result)
      return next
    })
  }

  const runBackfill = useCallback(async (codes: string[]) => {
    if (codes.length === 0 || backfillRunning) return
    setBackfillRunning(true)
    setBackfillProgress({ current: 0, total: codes.length, detail: '准备请求日线数据' })
    const response = await window.api.trend.backfillStocks(codes)
    if (!response.ok) {
      setBackfillRunning(false)
      setActionMessage({ tone: 'error', text: response.message ?? response.error ?? '日线补齐失败，可稍后重试' })
      return
    }
    const result = response.data
    if (result) {
      setBackfillProgress({ current: result.requested, total: result.requested, detail: `补齐 ${result.synced}，复用 ${result.skipped}，失败 ${result.failed}` })
      setActionMessage({ tone: result.failed > 0 ? 'info' : 'success', text: `日线补齐完成：${result.synced}只更新，${result.skipped}只已具备数据，${result.failed}只未完成` })
    }
    setBackfillRunning(false)
    void loadWatchRows()
    onRefresh()
  }, [backfillRunning, loadWatchRows, onRefresh])

  const handleAdd = async () => {
    const stocks = [...selectedStocks.values()]
    if (stocks.length === 0) {
      setActionMessage({ tone: 'error', text: '请至少选择一只股票' })
      return
    }
    setAdding(true)
    try {
      const response = await window.api.trend.addStocks(stocks.map((stock) => ({
        tsCode: stock.tsCode,
        stockName: stock.name,
        groupTag: inputGroup.trim() || '自定义',
        category: selectedCategory,
        subCategory: selectedSubCategory,
      })))
      if (!response.ok) {
        setActionMessage({ tone: 'error', text: response.message ?? response.error ?? '添加失败' })
        return
      }
      setActionMessage({ tone: 'success', text: `已将 ${stocks.length} 只股票加入观察池，正在检查日线覆盖` })
      setSelectedStocks(new Map())
      setSearchQuery('')
      setSearchResults([])
      setShowSearchResults(false)
      await loadWatchRows()
      onRefresh()
      void runBackfill(stocks.map((stock) => stock.tsCode))
    } finally {
      setAdding(false)
    }
  }

  const saveGroup = async (tsCode: string) => {
    if (editingGroupCode !== tsCode) return
    const value = editingGroupValue.trim()
    setEditingGroupCode(null)
    const response = await window.api.trend.updateGroupTag(tsCode, value)
    if (!response.ok) setActionMessage({ tone: 'error', text: response.error ?? '分组更新失败' })
    else {
      setActionMessage({ tone: 'success', text: `${stripCode(tsCode)} 的分组已更新` })
      await loadWatchRows()
      onRefresh()
    }
  }

  const confirmRemove = async () => {
    if (!removeTarget || removing) return
    setRemoving(true)
    const response = await window.api.trend.removeStock({ tsCode: removeTarget.tsCode })
    if (!response.ok) {
      setActionMessage({ tone: 'error', text: response.error ?? '移除失败' })
      setRemoving(false)
      return
    }
    setActionMessage({ tone: 'success', text: `${removeTarget.stockName}已移出观察池` })
    setRemoveTarget(null)
    setRemoving(false)
    await loadWatchRows()
    onRefresh()
  }

  const handleFullSync = async () => {
    if (syncRunning) return
    setSyncRunning(true)
    setSyncProgress({ current: 0, total: 90, detail: '准备同步最近90个交易日' })
    const response = await window.api.trend.syncNow(90)
    if (!response.ok) {
      setSyncRunning(false)
      setActionMessage({ tone: 'error', text: localizeSyncError(response.error, response.message) })
    }
  }

  return (
    <div data-testid="trend-watchlist" className="flex h-full min-h-0 flex-col overflow-y-auto">
      <TrendPageHeader
        title="观察池"
        subtitle="维护需要长期跟踪的股票、赛道和本地日线覆盖"
        loading={loading || listLoading}
        onRefresh={() => { void loadWatchRows(); onRefresh() }}
        meta={<span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">{allItems.length}只 · {missingCodes.length}只待补数据</span>}
        actions={missingCodes.length > 0 && <button type="button" disabled={backfillRunning} onClick={() => void runBackfill(missingCodes)} className="min-h-11 rounded-md bg-cyan-700 px-3 text-sm font-semibold text-white hover:bg-cyan-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:cursor-wait disabled:opacity-50 dark:bg-cyan-600 dark:hover:bg-cyan-500">{backfillRunning ? '补齐进行中' : `补齐缺口 ${missingCodes.length}`}</button>}
      />

      {errorMessage && <WorkbenchError message={errorMessage} onRetry={onRefresh} />}

      <section className="border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-950 sm:px-5" aria-labelledby="trend-add-title">
        <div className="flex flex-wrap items-end gap-2">
          <div ref={searchRootRef} className="relative min-w-[260px] flex-1">
            <label id="trend-add-title" className="mb-1 block text-[11px] font-medium text-slate-500 dark:text-slate-400">搜索并批量选择股票</label>
            <div className="flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-3 focus-within:border-cyan-500 focus-within:ring-2 focus-within:ring-cyan-500/20 dark:border-slate-700 dark:bg-slate-900">
              <input value={searchQuery} onChange={(event) => handleSearch(event.target.value)} onFocus={() => searchResults.length > 0 && setShowSearchResults(true)} placeholder="输入名称或代码" className="w-full bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100" />
              {searchLoading && <span className="shrink-0 text-[11px] text-slate-400">搜索中</span>}
              {selectedStocks.size > 0 && <span className="ml-2 shrink-0 rounded bg-cyan-50 px-2 py-1 text-[11px] font-medium text-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-300">已选 {selectedStocks.size}</span>}
            </div>
            {showSearchResults && (
              <div role="listbox" aria-multiselectable="true" aria-label="股票搜索结果" className="absolute left-0 right-0 z-40 mt-1 max-h-64 overflow-y-auto rounded-md border border-slate-200 bg-white py-1 shadow-xl dark:border-slate-700 dark:bg-slate-900">
                {searchResults.length === 0 ? <div className="px-3 py-4 text-center text-xs text-slate-400">没有匹配股票</div> : searchResults.map((result) => {
                  const checked = selectedStocks.has(result.tsCode)
                  return <button key={result.tsCode} type="button" role="option" aria-selected={checked} onClick={() => toggleSearchResult(result)} className="flex min-h-11 w-full items-center gap-3 px-3 text-left hover:bg-cyan-50 focus:outline-none focus-visible:bg-cyan-50 dark:hover:bg-cyan-950/30 dark:focus-visible:bg-cyan-950/30"><span aria-hidden="true" className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${checked ? 'border-cyan-600 bg-cyan-600 text-white' : 'border-slate-300 dark:border-slate-600'}`}>{checked ? '✓' : ''}</span><span className="w-24 shrink-0 font-mono text-xs text-slate-500">{result.tsCode}</span><span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{result.name}</span></button>
                })}
              </div>
            )}
          </div>
          <OptionMenu label="分类" value={selectedCategory} options={categoryOptions} onChange={(value) => { setSelectedCategory(value); setSelectedSubCategory('') }} className="w-40" />
          <OptionMenu label="细分赛道" value={selectedSubCategory} options={subCategoryOptions} onChange={setSelectedSubCategory} disabled={!selectedCategory} className="w-48" />
          <label className="w-36"><span className="mb-1 block text-[11px] font-medium text-slate-500 dark:text-slate-400">自定义分组</span><input value={inputGroup} onChange={(event) => setInputGroup(event.target.value)} placeholder="例如：重点跟踪" className="min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100" /></label>
          <button type="button" onClick={() => void handleAdd()} disabled={adding || selectedStocks.size === 0} className="min-h-11 rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:cursor-not-allowed disabled:opacity-45 dark:bg-cyan-500 dark:text-slate-950 dark:hover:bg-cyan-400">{adding ? '正在加入' : `加入观察池${selectedStocks.size > 0 ? ` (${selectedStocks.size})` : ''}`}</button>
        </div>
        {actionMessage && <div role="status" className={`mt-2 text-xs ${actionMessage.tone === 'error' ? 'text-rose-700 dark:text-rose-300' : actionMessage.tone === 'success' ? 'text-cyan-700 dark:text-cyan-300' : 'text-amber-700 dark:text-amber-300'}`}>{actionMessage.text}</div>}
      </section>

      {(backfillProgress || syncProgress) && (
        <div data-testid="trend-progress-area" className={`grid gap-px border-b border-slate-200 bg-slate-200 dark:border-slate-800 dark:bg-slate-800 ${backfillProgress && syncProgress ? 'sm:grid-cols-2' : 'grid-cols-1'}`}>
          {backfillProgress && <ProgressStrip label="观察池日线补齐" progress={backfillProgress} running={backfillRunning} />}
          {syncProgress && <ProgressStrip label="全市场日线维护" progress={syncProgress} running={syncRunning} />}
        </div>
      )}

      <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs dark:border-slate-800 dark:bg-slate-900/60 sm:px-5">
        <span className="font-medium text-slate-700 dark:text-slate-200">数据维护</span>
        <span className="text-slate-500 dark:text-slate-400">全市场最近90个交易日</span>
        <button type="button" disabled={syncRunning} onClick={() => void handleFullSync()} className="ml-auto min-h-10 rounded-md border border-slate-300 bg-white px-3 font-medium text-slate-700 hover:border-cyan-400 hover:text-cyan-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:cursor-wait disabled:opacity-45 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">{syncRunning ? '同步进行中' : '执行全市场同步'}</button>
      </div>

      {allItems.length > 0 && (
        <div data-testid="trend-watchlist-filters" className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-950 sm:px-5">
          <div className="mr-auto min-w-36">
            <div className="text-xs font-medium text-slate-700 dark:text-slate-200">观察池列表</div>
            <div className="mt-0.5 text-[11px] tabular-nums text-slate-400">显示 {items.length} / {allItems.length} 只</div>
          </div>
          <OptionMenu label="列表分类" value={listCategory} options={listCategoryOptions} onChange={(value) => { setListCategory(value); setListSubCategory('') }} className="w-44" />
          <OptionMenu label="列表赛道" value={listSubCategory} options={listSubCategoryOptions} onChange={setListSubCategory} className="w-52" />
          {(listCategory || listSubCategory) && <button type="button" onClick={() => { setListCategory(''); setListSubCategory('') }} className="min-h-11 rounded-md px-3 text-xs font-medium text-cyan-700 hover:bg-cyan-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:text-cyan-300 dark:hover:bg-cyan-950/30">清除筛选</button>}
        </div>
      )}

      {allItems.length === 0 && !loading && !listLoading ? (
        <div className="flex min-h-64 flex-1 flex-col items-center justify-center gap-2 px-6 text-center"><div className="text-sm font-medium text-slate-700 dark:text-slate-200">观察池为空</div><div className="text-xs text-slate-500 dark:text-slate-400">搜索股票并加入后，系统会立即检查本地日线是否足够计算趋势</div></div>
      ) : items.length === 0 ? (
        <div className="flex min-h-64 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"><div><div className="text-sm font-medium text-slate-700 dark:text-slate-200">当前分类和赛道下没有股票</div><div className="mt-1 text-xs text-slate-500 dark:text-slate-400">可以切换筛选条件查看其他观察对象</div></div><button type="button" onClick={() => { setListCategory(''); setListSubCategory('') }} className="min-h-11 rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:border-cyan-400 hover:text-cyan-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:border-slate-700 dark:text-slate-200">查看全部股票</button></div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[940px] border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-slate-100/95 text-slate-500 backdrop-blur dark:bg-slate-900/95 dark:text-slate-400"><tr className="border-b border-slate-200 dark:border-slate-800"><th className="px-4 py-2 text-left font-medium">股票</th><th className="px-3 py-2 text-left font-medium">分类与赛道</th><th className="px-3 py-2 text-left font-medium">自定义分组</th><th className="px-3 py-2 text-left font-medium">趋势状态</th><th className="px-3 py-2 text-left font-medium">日线覆盖</th><th className="px-3 py-2 text-left font-medium">评分时点</th><th className="px-4 py-2 text-right font-medium">操作</th></tr></thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.tsCode} tabIndex={0} onClick={() => setSelectedDetail(item)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelectedDetail(item) }} className="cursor-pointer border-b border-slate-100 bg-white transition-colors motion-reduce:transition-none hover:bg-cyan-50/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500 dark:border-slate-900 dark:bg-slate-950 dark:hover:bg-cyan-950/20">
                  <td className="px-4 py-2.5"><div className="font-medium text-slate-900 dark:text-slate-100">{item.stockName}</div><div className="mt-0.5 font-mono text-[11px] text-slate-500">{item.stockCode}</div></td>
                  <td className="px-3 py-2.5"><div className="max-w-56 truncate text-slate-700 dark:text-slate-200">{item.categories.join(' / ') || '未分类'}</div><div className="mt-0.5 max-w-56 truncate text-[11px] text-slate-400">{item.subCategories.join(' / ') || '未设置细分赛道'}</div></td>
                  <td className="px-3 py-2.5" onClick={(event) => event.stopPropagation()}>
                    {editingGroupCode === item.tsCode ? <input autoFocus value={editingGroupValue} onChange={(event) => setEditingGroupValue(event.target.value)} onBlur={() => void saveGroup(item.tsCode)} onKeyDown={(event) => { if (event.key === 'Enter') void saveGroup(item.tsCode); if (event.key === 'Escape') setEditingGroupCode(null) }} className="min-h-10 w-36 rounded-md border border-cyan-500 bg-white px-2 text-xs outline-none ring-2 ring-cyan-500/20 dark:bg-slate-900" /> : <button type="button" onClick={() => { setEditingGroupCode(item.tsCode); setEditingGroupValue(item.groupTags.join(' / ')) }} className="min-h-10 max-w-40 rounded px-2 text-left text-slate-600 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:text-slate-300 dark:hover:bg-slate-800">{item.groupTags.join(' / ') || '设置分组'}</button>}
                  </td>
                  <td className="px-3 py-2.5"><TrendStateBadge state={item.trendState} /></td>
                  <td className="px-3 py-2.5"><div className={item.dataCoverage.state === 'ready' ? 'font-medium text-cyan-700 dark:text-cyan-300' : 'font-medium text-amber-700 dark:text-amber-300'}>{coverageLabel(item)}</div><div className="mt-0.5 text-[11px] text-slate-400">至 {formatTrendDate(item.dataCoverage.latestTradeDate)}</div></td>
                  <td className="px-3 py-2.5"><div className="text-slate-700 dark:text-slate-200">{formatTrendDate(item.scoreDate)}</div><div className="mt-0.5 text-[11px] text-slate-400">{item.scoreSource === 'realtime' ? '盘中评分' : '日终评分'} · V2有效权重 {item.validWeight == null ? '—' : `${Math.round(item.validWeight * 100)}%`}</div></td>
                  <td className="px-4 py-2.5 text-right" onClick={(event) => event.stopPropagation()}><div className="flex justify-end gap-1"><button type="button" disabled={backfillRunning || item.dataCoverage.state === 'ready'} onClick={() => void runBackfill([item.tsCode])} className="min-h-10 rounded px-2 text-cyan-700 hover:bg-cyan-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:cursor-not-allowed disabled:text-slate-300 dark:text-cyan-300 dark:hover:bg-cyan-950/30 dark:disabled:text-slate-700">补齐</button><button type="button" onClick={() => setRemoveTarget(item)} className="min-h-10 rounded px-2 text-rose-700 hover:bg-rose-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 dark:text-rose-300 dark:hover:bg-rose-950/30">移除</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {removeTarget && <TrendConfirmDialog title="移出观察池" description="这只股票的全部分类和赛道登记都会从观察池中移除。" subject={`${removeTarget.stockName} · ${removeTarget.stockCode}`} busy={removing} onCancel={() => setRemoveTarget(null)} onConfirm={() => void confirmRemove()} />}
      {selectedDetail && <StockKlineChipDrawer tsCode={selectedDetail.tsCode} stockName={selectedDetail.stockName} onClose={() => setSelectedDetail(null)} onNavigate={() => { navigateToStock(selectedDetail.stockCode, selectedDetail.stockName); setSelectedDetail(null) }} />}
    </div>
  )
}

function ProgressStrip({ label, progress, running }: { label: string; progress: ProgressState; running: boolean }) {
  const percent = progress.total > 0 ? Math.min(100, Math.round(progress.current / progress.total * 100)) : 0
  return <div data-testid="trend-progress-strip" className="w-full bg-white px-4 py-2 dark:bg-slate-950 sm:px-5"><div className="flex items-center justify-between gap-3 text-[11px]"><span className="font-medium text-slate-700 dark:text-slate-200">{label}</span><span className="truncate text-slate-500 dark:text-slate-400">{progress.detail} · {progress.current}/{progress.total}</span></div><div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"><div className={`h-full rounded-full bg-cyan-600 transition-[width] duration-200 motion-reduce:transition-none ${running && progress.current === 0 ? 'animate-pulse motion-reduce:animate-none' : ''}`} style={{ width: `${Math.max(running ? 2 : 0, percent)}%` }} /></div></div>
}

function buildFilterOptions(
  rows: WatchItem[],
  field: 'category' | 'subCategory',
  allLabel: string,
): Array<{ value: string; label: string }> {
  const codesByValue = new Map<string, Set<string>>()
  for (const row of rows) {
    const value = row[field].trim()
    if (!value) continue
    const codes = codesByValue.get(value) ?? new Set<string>()
    codes.add(normalizeCode(row.tsCode))
    codesByValue.set(value, codes)
  }
  return [
    { value: '', label: allLabel },
    ...[...codesByValue.entries()]
      .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
      .map(([value, codes]) => ({ value, label: `${value} (${codes.size})` })),
  ]
}

function coveragePriority(item: TrendWorkbenchItem): number {
  return item.dataCoverage.state === 'missing' ? 0 : item.dataCoverage.state === 'partial' ? 1 : 2
}

function coverageLabel(item: TrendWorkbenchItem): string {
  if (item.dataCoverage.state === 'ready') return `${item.dataCoverage.bars}根 · 可评分`
  if (item.dataCoverage.state === 'partial') return `${item.dataCoverage.bars}/${item.dataCoverage.requiredBars}根 · 待补齐`
  return `${item.dataCoverage.bars}/${item.dataCoverage.requiredBars}根 · 无法评分`
}

function backfillStatusLabel(status: 'synced' | 'skipped' | 'failed'): string {
  return status === 'synced' ? '已更新' : status === 'skipped' ? '本地已具备' : '未完成'
}

function localizeSyncError(error: string | undefined, message: string | undefined): string {
  if (error === 'TUSHARE_DISABLED') return '未启用可用的 Tushare 数据源，请先在设置中完成配置'
  if (error === 'ALREADY_RUNNING') return '已有日线同步任务正在运行'
  if (error === 'NO_TRADE_DATES') return '本地交易日历为空，暂时无法同步'
  return message ?? error ?? '全市场日线同步失败'
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase()
}

function stripCode(value: string): string {
  return value.replace(/\.(SH|SZ|BJ)$/i, '')
}
