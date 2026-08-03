/**
 * FR-171: 产业链传导分析抽屉
 *
 * 右侧滑入抽屉，与 IndustryChainDrawer 保持一致的交互范式。
 * 支持 light / dark 双主题。
 */

import React, { useEffect, useRef, useState, useCallback } from 'react'
import mermaid from 'mermaid'
import { useAppStore } from '../../store/appStore'
import { SupplyChainNodeList, type SupplyChainNodeData, type MemberStock } from './SupplyChainNodeList'

// ──── 类型 ──────────────────────────────────────────────────────────────────

interface AnalysisEdge {
  id: number
  upstreamConcept: string
  downstreamConcept: string
  relationLabel: string
  chainGroup: string
  sortOrder: number
  isEnabled: number
}

interface AnalysisData {
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
  nodes: SupplyChainNodeData[]
  edges: AnalysisEdge[]
  stocks: Record<string, MemberStock[]>
}

interface Props {
  open: boolean
  text: string
  onClose: () => void
}

// ──── 计数器（Mermaid 每次渲染需唯一 id） ─────────────────────────────────

let _scIdCounter = 0

function directionLabel(direction: 'positive' | 'negative' | 'neutral' | 'mixed'): string {
  if (direction === 'positive') return '偏利好'
  if (direction === 'negative') return '偏利空'
  if (direction === 'mixed') return '多空混合'
  return '中性'
}

function eventTypeLabel(eventType: NonNullable<AnalysisData['attribution']>['eventType']): string {
  const labels: Record<NonNullable<AnalysisData['attribution']>['eventType'], string> = {
    policy: '政策',
    price: '价格',
    supply_demand: '供需',
    order: '订单',
    tech: '技术',
    export_control: '出口管制',
    earnings: '业绩',
    market: '市场',
    other: '其他',
  }
  return labels[eventType]
}

function stockChangeColor(v: number | null): string {
  if (v === null) return 'text-gray-400 dark:text-gray-500'
  if (v > 0) return 'text-red-500'
  if (v < 0) return 'text-green-500'
  return 'text-gray-500 dark:text-gray-400'
}

function formatStockChange(v: number | null): string {
  if (v === null) return '--'
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    default: '内置',
    kpl: 'KPL',
    ths: 'THS',
    dc: 'DC',
    watchlist: '自选',
    trend: '趋势',
    portfolio: '持仓',
    decision: '看板',
  }
  return labels[source] ?? source
}

// ──── Mermaid 图谱生成 ──────────────────────────────────────────────────────

interface MermaidBuildResult {
  code: string
  /** 安全节点 ID（sc0/sc1…）→ 概念名，供点击事件反查 */
  idMap: Map<string, string>
}

function buildMermaidCode(data: AnalysisData, isDark: boolean): MermaidBuildResult {
  const lines: string[] = ['flowchart LR']
  const idMap = new Map<string, string>()

  // classDef
  if (isDark) {
    lines.push('  classDef hit fill:#15803d,stroke:#16a34a,color:#fff')
    lines.push('  classDef upstream fill:#1e40af,stroke:#3b82f6,color:#fff')
    lines.push('  classDef downstream fill:#6b21a8,stroke:#a855f7,color:#fff')
  } else {
    lines.push('  classDef hit fill:#dcfce7,stroke:#16a34a,color:#14532d')
    lines.push('  classDef upstream fill:#dbeafe,stroke:#3b82f6,color:#1e3a8a')
    lines.push('  classDef downstream fill:#f3e8ff,stroke:#a855f7,color:#581c87')
  }

  // 节点定义：用安全字母数字 ID，概念名仅作标签（避免引号嵌套导致的解析错误）
  data.nodes.forEach((node, i) => {
    const id = `sc${i}`
    idMap.set(id, node.concept)
    lines.push(`  ${id}["${node.concept.replace(/"/g, '&quot;')}"]`)
  })

  // 概念名 → ID 反查表（生成边时使用）
  const conceptToId = new Map<string, string>()
  idMap.forEach((concept, id) => conceptToId.set(concept, id))

  // 边
  for (const edge of data.edges) {
    const from = conceptToId.get(edge.upstreamConcept)
    const to = conceptToId.get(edge.downstreamConcept)
    if (!from || !to) continue
    const label = (edge.relationLabel || '传导至').replace(/"/g, '&quot;')
    lines.push(`  ${from} -->|${label}| ${to}`)
  }

  // class 逐节点指定（避免多个带特殊字符 ID 的逗号拼接语法问题）
  idMap.forEach((concept, id) => {
    const node = data.nodes.find(n => n.concept === concept)
    if (!node) return
    if (node.isHit) lines.push(`  class ${id} hit`)
    else if (node.distance < 0) lines.push(`  class ${id} upstream`)
    else if (node.distance > 0) lines.push(`  class ${id} downstream`)
  })

  return { code: lines.join('\n'), idMap }
}

// ──── 内容区（供 IndustryAnalysisDrawer 的 Tab 内嵌使用）──────────────────

export interface SupplyChainContentProps {
  text: string
  onClose: () => void
}

export function SupplyChainContent({ text, onClose }: SupplyChainContentProps): React.ReactElement {
  const theme = useAppStore(s => s.theme)
  const navigateToStock = useAppStore(s => s.navigateToStock)
  const navigateToIndustryResearch = useAppStore(s => s.navigateToIndustryResearch)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<AnalysisData | null>(null)
  const [svg, setSvg] = useState('')
  const [svgError, setSvgError] = useState(false)
  const [svgLoading, setSvgLoading] = useState(false)
  const [pendingConcept, setPendingConcept] = useState<{ name: string; seq: number } | null>(null)
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 })
  const [creatingResearch, setCreatingResearch] = useState(false)
  const [researchError, setResearchError] = useState<string | null>(null)

  const svgContainerRef = useRef<HTMLDivElement>(null)
  const svgInnerRef = useRef<HTMLDivElement>(null)
  const isPanningRef = useRef(false)
  const panStartRef = useRef({ x: 0, y: 0 })
  const transformRef = useRef(transform)
  /** 当前 data 对应的节点 ID → 概念名映射，供点击事件委托反查 */
  const idMapRef = useRef<Map<string, string>>(new Map())

  // 分析（组件挂载或 text 变化时触发，无需 open 依赖）
  useEffect(() => {
    if (!text) return
    setLoading(true)
    setError(null)
    setData(null)
    setSvg('')
    setPendingConcept(null)

    if (!window.api?.supplyChain) {
      setError('产业链分析服务不可用，请重启应用后重试')
      setLoading(false)
      return
    }

    console.log('[SupplyChainContent] analyze called, text length =', text.length, ', text前100 =', text.slice(0, 100).replace(/\n/g, ' '))

    window.api.supplyChain.analyze(text).then(res => {
      console.log('[SupplyChainContent] analyze response =', JSON.stringify({ ok: res.ok, code: (res as Record<string, unknown>).code, message: (res as Record<string, unknown>).message, matchedBy: res.data?.matchedBy, hitConcepts: res.data?.hitConcepts, nodesLen: res.data?.nodes?.length }))
      if (!res.ok || !res.data) {
        setError(res.message ?? '未识别到相关产业链概念')
      } else {
        setData(res.data as AnalysisData)
      }
    }).catch(err => {
      console.error('[SupplyChainContent] analyze error =', err)
      setError(String(err))
    }).finally(() => {
      setLoading(false)
    })
  }, [text])

  // 渲染 Mermaid（依赖 data + theme）
  useEffect(() => {
    if (!data) return
    let cancelled = false
    setSvgLoading(true)
    setSvgError(false)
    setTransform({ x: 0, y: 0, scale: 1 })

    const isDark = theme === 'dark'
    mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? 'dark' : 'default',
      themeVariables: isDark
        ? {
            lineColor: '#93c5fd',
            arrowheadColor: '#93c5fd',
            edgeLabelBackground: '#1e293b',
            primaryTextColor: '#e2e8f0',
            primaryColor: '#334155',
            primaryBorderColor: '#60a5fa',
          }
        : {
            lineColor: '#334155',
            arrowheadColor: '#334155',
            edgeLabelBackground: '#ffffff',
            primaryTextColor: '#1e293b',
            primaryBorderColor: '#475569',
          },
      securityLevel: 'strict',
      flowchart: { curve: 'basis', padding: 10 },
    })

    const id = `sc-drawer-${++_scIdCounter}`
    const { code, idMap } = buildMermaidCode(data, isDark)
    idMapRef.current = idMap

    mermaid.render(id, code).then(({ svg: rendered }) => {
      if (!cancelled) {
        setSvg(rendered)
        setSvgLoading(false)
      }
    }).catch(() => {
      if (!cancelled) {
        setSvgError(true)
        setSvgLoading(false)
      }
    })

    return () => { cancelled = true }
  }, [data, theme])

  useEffect(() => {
    transformRef.current = transform
    if (svgInnerRef.current) {
      svgInnerRef.current.style.transform =
        `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`
    }
  }, [transform])

  const clampScale = (scale: number) => Math.min(4, Math.max(0.25, scale))

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!svgInnerRef.current) return
    event.preventDefault()

    const delta = event.deltaY < 0 ? 1.15 : 0.87
    const nextScale = clampScale(transformRef.current.scale * delta)
    const rect = svgInnerRef.current.getBoundingClientRect()
    const offsetX = event.clientX - rect.left
    const offsetY = event.clientY - rect.top

    const scaleRatio = nextScale / transformRef.current.scale
    const nextX = transformRef.current.x - (scaleRatio - 1) * offsetX
    const nextY = transformRef.current.y - (scaleRatio - 1) * offsetY

    setTransform({ x: nextX, y: nextY, scale: nextScale })
  }

  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    isPanningRef.current = true
    panStartRef.current = { x: event.clientX, y: event.clientY }
    event.currentTarget.style.cursor = 'grabbing'
  }

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isPanningRef.current) return
    const start = panStartRef.current
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    panStartRef.current = { x: event.clientX, y: event.clientY }
    setTransform((prev) => ({ x: prev.x + dx, y: prev.y + dy, scale: prev.scale }))
  }

  const stopPanning = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isPanningRef.current) return
    isPanningRef.current = false
    event.currentTarget.style.cursor = 'grab'
  }

  // SVG 渲染后：指针样式 + 节点点击事件委托
  useEffect(() => {
    const el = svgContainerRef.current
    if (!el || !svg || !data) return

    // Mermaid v11 strict 模式下 SVG 根元素带 pointer-events:none，必须显式覆盖
    const svgRoot = el.querySelector<SVGSVGElement>('svg')
    if (svgRoot) svgRoot.style.pointerEvents = 'all'

    // 为节点 g 元素设置指针样式
    // 实际 id 格式：{renderId}-flowchart-sc{n}-{counter}，用 contains 选择器
    el.querySelectorAll<SVGGElement>('g[id*="flowchart-sc"]').forEach(g => {
      g.style.cursor = 'pointer'
      g.style.pointerEvents = 'all'
    })

    const handler = (e: MouseEvent): void => {
      // closest() 无法穿越 foreignObject/SVG namespace 边界
      // 改用 composedPath() 遍历完整冒泡路径来定位目标 <g> 节点
      // 实际 id 格式：{renderId}-flowchart-sc{n}-{counter}，去掉 ^ 锚点用尾部匹配
      let nodeEl: Element | undefined
      for (const t of e.composedPath()) {
        if (t instanceof Element && /flowchart-sc\d+-\d+$/.test(t.id)) {
          nodeEl = t
          break
        }
      }
      if (!nodeEl) return
      const match = /flowchart-(sc\d+)-\d+$/.exec(nodeEl.id)
      if (!match) return
      const concept = idMapRef.current.get(match[1])
      if (concept) setPendingConcept(prev => ({ name: concept, seq: (prev?.seq ?? 0) + 1 }))
    }

    el.addEventListener('click', handler)
    return () => el.removeEventListener('click', handler)
  }, [svg, data])

  const handleNavigate = useCallback((stockCode: string, stockName: string) => {
    navigateToStock(stockCode, stockName)
    onClose()
  }, [navigateToStock, onClose])

  const handleCreateResearch = useCallback(async () => {
    if (!data || creatingResearch) return
    setCreatingResearch(true)
    setResearchError(null)
    const chainGroup = data.attribution?.chainGroups[0]?.chainGroup || data.chainGroup || '产业链'
    const response = await window.api.industryResearch.createProject({
      title: `${chainGroup}产业研究`, industryName: chainGroup,
      productScope: data.hitConcepts.join('、') || chainGroup, regionScope: '中国', timeScope: '当前事件及近三年',
      purpose: 'investment', depth: 'quick', dataAsOf: null, valuationDate: null,
      sourceType: 'supply_chain', sourceRef: `supply-chain:${chainGroup}`, sourceText: text.slice(0, 5000),
      seedSupplyChain: {
        chainGroup, hitConcepts: data.hitConcepts,
        nodes: data.nodes.map(node => ({ concept: node.concept, distance: node.distance, isHit: node.isHit })),
        edges: data.edges.map(edge => ({ upstreamConcept: edge.upstreamConcept, downstreamConcept: edge.downstreamConcept, relationLabel: edge.relationLabel })),
      },
    }) as { ok: boolean; data?: { id: string }; message?: string; code?: string }
    setCreatingResearch(false)
    if (!response.ok || !response.data) { setResearchError(response.message || response.code || '建立研究失败'); return }
    navigateToIndustryResearch(response.data.id)
    onClose()
  }, [creatingResearch, data, navigateToIndustryResearch, onClose, text])

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* 归因摘要与龙头候选（仅数据加载完成后显示）*/}
      {data && !loading && (
        <div className="border-b border-gray-200 dark:border-gray-700 shrink-0 bg-white dark:bg-gray-900">
          <div className="px-4 py-3 space-y-3">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs px-2 py-0.5 rounded bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300 font-medium">
                    {data.attribution?.chainGroups[0]?.chainGroup || data.chainGroup || '通用'}
                  </span>
                  {data.attribution && (
                    <>
                      <span className="text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                        {eventTypeLabel(data.attribution.eventType)}事件
                      </span>
                      <span className="text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                        {directionLabel(data.attribution.chainGroups[0]?.direction ?? 'mixed')}
                      </span>
                      <span className="text-xs text-gray-400 dark:text-gray-500">
                        置信度 {data.attribution.chainGroups[0]?.confidence ?? 0}
                      </span>
                    </>
                  )}
                  <span className="text-xs text-gray-400 dark:text-gray-500">
                    命中 {data.hitConcepts.length} 个环节
                    {data.matchedBy === 'llm' && ' · AI 归因'}
                    {data.matchedBy === 'alias' && ' · 别名归因'}
                    {data.matchedBy === 'mixed' && ' · 混合归因'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 line-clamp-2">
                  {data.attribution?.chainGroups[0]?.reason || '已根据本地产业链图谱和代表股数据完成归因。'}
                </p>
              </div>
              <button type="button" onClick={() => void handleCreateResearch()} disabled={creatingResearch} className="shrink-0 rounded-md bg-teal-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{creatingResearch ? '建立中' : '建立研究'}</button>
            </div>
            {researchError && <div className="text-xs text-red-600 dark:text-red-300">{researchError}</div>}

            {(data.recommendedStocks?.length ?? 0) > 0 && (
              <div>
                <div className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-1.5">推荐关注股票</div>
                <div className="grid grid-cols-2 xl:grid-cols-4 gap-2">
                  {data.recommendedStocks!.slice(0, 8).map(stock => (
                    <button
                      key={stock.tsCode}
                      type="button"
                      onClick={() => handleNavigate(stock.tsCode.replace(/\.(SH|SZ|BJ)$/i, ''), stock.stockName)}
                      className="text-left rounded-md border border-gray-200 dark:border-gray-700 hover:border-teal-400 dark:hover:border-teal-500 px-2.5 py-2 bg-gray-50 dark:bg-gray-800 transition-colors"
                      title={stock.reasons.join('；')}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-medium text-sm text-gray-800 dark:text-gray-100 truncate">{stock.stockName}</span>
                        <span className="text-[11px] text-gray-400 font-mono shrink-0">{stock.tsCode.replace(/\.(SH|SZ|BJ)$/i, '')}</span>
                        <span className={`ml-auto text-xs font-medium shrink-0 ${stockChangeColor(stock.todayChange)}`}>
                          {formatStockChange(stock.todayChange)}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-1 flex-wrap">
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300">
                          {stock.rankScore}分
                        </span>
                        {stock.concepts.slice(0, 2).map(concept => (
                          <span key={concept} className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
                            {concept}
                          </span>
                        ))}
                        {stock.source.slice(0, 2).map(src => (
                          <span key={src} className="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300">
                            {sourceLabel(src)}
                          </span>
                        ))}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 主体区域 */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* 左侧 Mermaid 图 */}
        <div
          className="flex-1 min-w-0 overflow-hidden p-4 bg-gray-50 dark:bg-gray-800"
          ref={svgContainerRef}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={stopPanning}
          onMouseLeave={stopPanning}
          style={{ cursor: 'grab', userSelect: 'none' }}
        >
          {/* 加载状态 */}
          {(loading || svgLoading) && (
            <div className="flex flex-col items-center gap-3 text-gray-400 dark:text-gray-500">
              <div className="w-8 h-8 border-2 border-gray-300 dark:border-gray-500 border-t-blue-500 rounded-full animate-spin" />
              <span className="text-sm">
                {loading ? '正在分析产业链传导关系…' : '渲染图表中…'}
              </span>
            </div>
          )}
          {/* 错误状态 */}
          {error && !loading && (
            <div className="text-center">
              <div className="text-4xl mb-3">⛓</div>
              <p className="text-gray-500 dark:text-gray-400 text-sm">{error}</p>
            </div>
          )}
          {svgError && !svgLoading && !error && (
            <div className="text-center text-gray-500 dark:text-gray-400 text-sm">
              图表渲染失败，请稍后重试
            </div>
          )}
          {/* SVG 图 */}
          {!loading && !svgLoading && !error && !svgError && svg && (
            <div
              ref={svgInnerRef}
              className="w-full h-full origin-top-left [&_svg]:pointer-events-auto"
              style={{
                transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
                transformOrigin: '0 0',
              }}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          )}
        </div>

        {/* 右侧节点列表 */}
        {data && !loading && (
          <div className="w-80 shrink-0 border-l border-gray-200 dark:border-gray-700 flex flex-col">
            <div className="px-4 py-2.5 border-b border-gray-200 dark:border-gray-700 shrink-0">
              <span className="text-xs text-gray-500 dark:text-gray-400">
                点击图中节点展开成员股
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <SupplyChainNodeList
                nodes={data.nodes}
                hitConcepts={data.hitConcepts}
                pendingConcept={pendingConcept}
                onNavigate={handleNavigate}
              />
            </div>
          </div>
        )}
      </div>

      {/* 图例 */}
      {data && !loading && (
        <div className="flex items-center gap-4 px-4 py-2 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 shrink-0">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded border border-green-500 bg-green-100 dark:bg-green-900" />
            命中节点
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded border border-blue-400 bg-blue-100 dark:bg-blue-900" />
            上游环节
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded border border-purple-400 bg-purple-100 dark:bg-purple-900" />
            下游环节
          </span>
          <span className="ml-auto text-gray-400 dark:text-gray-500">点击节点查看成员股</span>
        </div>
      )}
    </div>
  )
}

// ──── 带外壳的独立抽屉（向后兼容）────────────────────────────────────────

export function SupplyChainModal({ open, text, onClose }: Props): React.ReactElement | null {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-[9999]">
      {/* 半透明遮罩 */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* 抽屉主体 */}
      <div
        className="absolute right-0 top-0 bottom-0 w-[85vw] max-w-[1400px] min-w-[700px] bg-white dark:bg-gray-900 flex flex-col shadow-2xl"
        style={{ animation: 'slideInFromRight 0.25s cubic-bezier(0.4,0,0.2,1)' }}
      >
        {/* 顶部工具栏 */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <span className="text-sm font-semibold text-gray-700 dark:text-gray-200 whitespace-nowrap">
            ⛓ 产业链传导分析
          </span>
          <button
            type="button"
            className="ml-auto text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none shrink-0 px-1"
            onClick={onClose}
            title="关闭"
          >
            ×
          </button>
        </div>
        <SupplyChainContent text={text} onClose={onClose} />
      </div>
    </div>
  )
}
