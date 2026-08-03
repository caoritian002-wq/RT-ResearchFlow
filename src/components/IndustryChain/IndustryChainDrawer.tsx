// src/components/IndustryChain/IndustryChainDrawer.tsx
// FR-170 产业链图谱右侧抽屉组件
// 复用 BacktestModal 抽屉范式 + Mermaid.js 渲染产业链流程图

import { useEffect, useRef, useState, type MouseEvent, type WheelEvent } from 'react'
import mermaid from 'mermaid'
import { useAppStore } from '../../store/appStore'
import {
  INDUSTRY_CHAINS,
  ChainNode,
  IndustryChain,
  chainToMermaid,
} from '../../utils/industryChainData'

export interface IndustryChainDrawerProps {
  open: boolean
  onClose: () => void
  /** 打开时默认选中的链 id */
  defaultChainId?: string
}

// 层级描述标签（对应 level 0~6）
const LEVEL_LABELS = [
  '上游资源',
  '基础材料',
  '中间材料',
  '核心材料',
  '制造组件',
  '系统应用',
  '终端场景',
]

// 层级徽章配色（Tailwind 类）
const LEVEL_BADGE_COLORS = [
  'bg-gray-600 text-gray-100',
  'bg-blue-800 text-blue-100',
  'bg-emerald-800 text-emerald-100',
  'bg-amber-800 text-amber-100',
  'bg-purple-800 text-purple-100',
  'bg-pink-800 text-pink-100',
  'bg-red-800 text-red-100',
]

// 每层 Mermaid classDef（暗色友好）
const MERMAID_CLASS_DEFS = [
  'classDef level0 fill:#374151,stroke:#9CA3AF,color:#F9FAFB',
  'classDef level1 fill:#1e3a5f,stroke:#60A5FA,color:#eff6ff',
  'classDef level2 fill:#064e3b,stroke:#34D399,color:#ecfdf5',
  'classDef level3 fill:#78350f,stroke:#FCD34D,color:#fffbeb',
  'classDef level4 fill:#4c1d95,stroke:#A78BFA,color:#f5f3ff',
  'classDef level5 fill:#831843,stroke:#F472B6,color:#fdf2f8',
  'classDef level6 fill:#881337,stroke:#FB7185,color:#fff1f2',
]

/** 构建带 classDef 着色的 Mermaid 图表字符串 */
function buildMermaidDiagram(chain: IndustryChain): string {
  const base = chainToMermaid(chain)
  const lines: string[] = [base]

  // 按层分组节点 id
  const levelNodes = new Map<number, string[]>()
  chain.nodes.forEach((n) => {
    const arr = levelNodes.get(n.level) ?? []
    arr.push(n.id)
    levelNodes.set(n.level, arr)
  })

  // 追加 classDef 声明与 class 分配
  MERMAID_CLASS_DEFS.forEach((def, idx) => {
    const nodes = levelNodes.get(idx)
    if (nodes && nodes.length > 0) {
      lines.push(`  ${def}`)
      lines.push(`  class ${nodes.join(',')} level${idx}`)
    }
  })

  return lines.join('\n')
}

let _drawerIdCounter = 0

// ──── 内容区（供 IndustryAnalysisDrawer 的 Tab 内嵌使用）──────────────────

export interface IndustryChainContentProps {
  defaultChainId?: string
  onClose: () => void
}

export function IndustryChainContent({ defaultChainId, onClose }: IndustryChainContentProps) {
  const [selectedChainId, setSelectedChainId] = useState(
    defaultChainId ?? INDUSTRY_CHAINS[0]?.id ?? ''
  )
  const [selectedNode, setSelectedNode] = useState<ChainNode | null>(null)
  const [svg, setSvg] = useState('')
  const [svgError, setSvgError] = useState(false)
  const [svgLoading, setSvgLoading] = useState(false)
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 })

  const svgContainerRef = useRef<HTMLDivElement>(null)
  const svgInnerRef = useRef<HTMLDivElement>(null)
  const isPanningRef = useRef(false)
  const panStartRef = useRef({ x: 0, y: 0 })
  const transformRef = useRef(transform)
  const theme = useAppStore((s) => s.theme)
  const navigateToStock = useAppStore((s) => s.navigateToStock)

  const chain = INDUSTRY_CHAINS.find((c) => c.id === selectedChainId) ?? INDUSTRY_CHAINS[0]

  // defaultChainId 从外部变化时同步（如 AI 文本匹配结果）
  useEffect(() => {
    if (defaultChainId) setSelectedChainId(defaultChainId)
  }, [defaultChainId])

  // 切换链时清空节点面板
  useEffect(() => {
    setSelectedNode(null)
  }, [selectedChainId])

  // Mermaid 渲染（依赖链 id 与主题）
  useEffect(() => {
    if (!chain) return
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

    const id = `chain-drawer-${++_drawerIdCounter}`
    const diagram = buildMermaidDiagram(chain)

    mermaid
      .render(id, diagram)
      .then(({ svg: rendered }) => {
        if (!cancelled) {
          setSvg(rendered)
          setSvgLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSvgError(true)
          setSvgLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [selectedChainId, theme, chain])

  useEffect(() => {
    transformRef.current = transform
    if (svgInnerRef.current) {
      svgInnerRef.current.style.transform =
        `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`
    }
  }, [transform])

  const clampScale = (scale: number) => Math.min(4, Math.max(0.25, scale))

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
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

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    isPanningRef.current = true
    panStartRef.current = { x: event.clientX, y: event.clientY }
    event.currentTarget.style.cursor = 'grabbing'
  }

  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    if (!isPanningRef.current) return
    const start = panStartRef.current
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    panStartRef.current = { x: event.clientX, y: event.clientY }
    setTransform((prev) => ({ x: prev.x + dx, y: prev.y + dy, scale: prev.scale }))
  }

  const stopPanning = (event: MouseEvent<HTMLDivElement>) => {
    if (!isPanningRef.current) return
    isPanningRef.current = false
    event.currentTarget.style.cursor = 'grab'
  }

  // SVG 渲染完成后：添加鼠标样式 + 事件委托处理节点点击
  useEffect(() => {
    const el = svgContainerRef.current
    if (!el || !svg) return

    // 为所有 g.node 元素设置指针样式
    el.querySelectorAll<SVGGElement>('g.node').forEach((g) => {
      g.style.cursor = 'pointer'
    })

    const handler = (e: globalThis.MouseEvent) => {
      const nodeEl = (e.target as Element).closest('g.node')
      if (!nodeEl) return
      // mermaid flowchart 生成的 id 格式：flowchart-{nodeId}-{counter}
      const rawId = nodeEl.id
      const match = rawId.match(/^flowchart-(.+)-\d+$/)
      if (!match) return
      const nodeId = match[1]
      const found = chain?.nodes.find((n) => n.id === nodeId) ?? null
      setSelectedNode(found)
    }

    el.addEventListener('click', handler)
    return () => el.removeEventListener('click', handler)
  }, [svg, chain])

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* 链选择器子工具栏 */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <select
          className="text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100"
          value={selectedChainId}
          onChange={(e) => setSelectedChainId(e.target.value)}
        >
          {INDUSTRY_CHAINS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <span className="text-xs text-gray-400 dark:text-gray-500 truncate hidden sm:block">
          {chain?.description}
        </span>
      </div>

      {/* 主体区域：Mermaid 图 + 右侧节点面板 */}
      <div className="flex flex-1 overflow-hidden">
        {/* Mermaid 图区域 */}
        <div
          className="flex-1 overflow-hidden p-4"
          ref={svgContainerRef}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={stopPanning}
          onMouseLeave={stopPanning}
          style={{ cursor: 'grab' }}
        >
          {svgLoading && (
            <div className="flex items-center justify-center h-full text-gray-400 dark:text-gray-500 text-sm">
              <span className="animate-spin mr-2">⟳</span>渲染中…
            </div>
          )}
          {svgError && !svgLoading && (
            <div className="flex items-center justify-center h-full text-red-400 text-sm">
              图表渲染失败，请重新选择产业链
            </div>
          )}
          {!svgLoading && !svgError && svg && (
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

        {/* 右侧节点详情面板（选中节点后展开） */}
        {selectedNode && (
          <div className="w-64 border-l border-gray-200 dark:border-gray-700 flex flex-col p-4 bg-gray-50 dark:bg-gray-800 flex-shrink-0 overflow-y-auto">
            {/* 节点标题 */}
            <div className="flex items-start justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 leading-snug pr-2">
                {selectedNode.label}
              </h3>
              <button
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm flex-shrink-0"
                onClick={() => setSelectedNode(null)}
                title="关闭面板"
              >
                ×
              </button>
            </div>

            {/* 层级徽章 */}
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium mb-4 self-start ${
                LEVEL_BADGE_COLORS[selectedNode.level] ?? 'bg-gray-600 text-gray-100'
              }`}
            >
              层{selectedNode.level} · {LEVEL_LABELS[selectedNode.level] ?? '其他'}
            </span>

            {/* 代表个股列表 */}
            {selectedNode.stocks && selectedNode.stocks.length > 0 ? (
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">代表个股</p>
                <div className="flex flex-col gap-1.5">
                  {selectedNode.stocks.map((s) => (
                    <button
                      key={s.tsCode}
                      className="flex items-center justify-between px-3 py-1.5 rounded bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 hover:border-blue-400 dark:hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/30 text-left transition-colors"
                      onClick={() => {
                        // 去掉交易所后缀（如 002466.SZ → 002466）
                        const code = s.tsCode.replace(/\.(SH|SZ|BJ)$/i, '')
                        navigateToStock(code, s.name)
                        onClose()
                      }}
                    >
                      <span className="text-xs font-medium text-gray-700 dark:text-gray-200">
                        {s.name}
                      </span>
                      <span className="text-xs text-gray-400 dark:text-gray-500 ml-2 whitespace-nowrap">
                        {s.tsCode}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-xs text-gray-400 dark:text-gray-500">暂无关联个股</p>
            )}
          </div>
        )}
      </div>

      {/* 底部提示栏 */}
      <div className="px-4 py-2 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-400 dark:text-gray-500 flex-shrink-0">
        点击节点查看代表个股 · 点击个股跳转走势图 · 颜色区分层级
      </div>
    </div>
  )
}

// ──── 带外壳的独立抽屉（向后兼容）────────────────────────────────────────

export default function IndustryChainDrawer({
  open,
  onClose,
  defaultChainId,
}: IndustryChainDrawerProps) {
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
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <span className="text-sm font-semibold text-gray-700 dark:text-gray-200 whitespace-nowrap">
            产业链图谱
          </span>
          <button
            className="ml-auto text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none flex-shrink-0 px-1"
            onClick={onClose}
            title="关闭"
          >
            ×
          </button>
        </div>
        <IndustryChainContent defaultChainId={defaultChainId} onClose={onClose} />
      </div>
    </div>
  )
}
