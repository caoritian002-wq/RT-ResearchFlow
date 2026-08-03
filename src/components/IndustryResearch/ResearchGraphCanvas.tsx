import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  NodeToolbar,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  type Viewport,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './ResearchGraphCanvas.css'
import { useAppStore } from '../../store/appStore'
import {
  buildFocusedResearchGraphViewModel,
  buildResearchGraphViewModel,
  RESEARCH_GRAPH_FOCUS_LIMIT,
  resolveResearchNodeDetailPlacement,
  selectResearchGraphFocusNode,
  type ResearchGraphEdgeView,
  type ResearchGraphNodeView,
  type ResearchGraphTone,
  type ResearchNodeDetailPlacement,
} from './industryResearchGraphModel'
import type { ResearchGraph, ResearchStatementKind } from './industryResearchTypes'

interface Props {
  graph: ResearchGraph | null
  onEdit: () => void
}

type ResearchGraphMode = 'focus' | 'all'

interface ResearchFlowNodeData extends Record<string, unknown> {
  node: ResearchGraphNodeView
  toneLabel: string
  toneColor: string
  statementLabel: string
  statusLabel: string
  incomingCount: number
  outgoingCount: number
  incomingRelations: string[]
  outgoingRelations: string[]
  detailPlacement: ResearchNodeDetailPlacement
  detailWidth: number
  detailMaxHeight: number
  detailVisible: boolean
  onCloseDetail: () => void
  dimmed: boolean
  active: boolean
}

type ResearchFlowNode = Node<ResearchFlowNodeData, 'research'>
type ResearchFlowEdge = Edge<Record<string, unknown>, 'smoothstep'>

const FULL_NODE_WIDTH = 176
const FULL_NODE_HEIGHT = 96
const FOCUS_NODE_WIDTH = 184
const FOCUS_NODE_HEIGHT = 96
const MIN_ZOOM = 0.12
const MAX_ZOOM = 4

const toolbarPositions: Record<ResearchNodeDetailPlacement, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
}

const toneLabels: Record<ResearchGraphTone, string> = {
  upstream: '上游供给',
  midstream: '中游制造',
  downstream: '下游需求',
  support: '设备与支撑',
  neutral: '关联节点',
}

const toneColors: Record<ResearchGraphTone, { light: string; dark: string }> = {
  upstream: { light: '#2563eb', dark: '#60a5fa' },
  midstream: { light: '#0891b2', dark: '#22d3ee' },
  downstream: { light: '#059669', dark: '#34d399' },
  support: { light: '#d97706', dark: '#fbbf24' },
  neutral: { light: '#64748b', dark: '#94a3b8' },
}

function statementLabel(value: ResearchStatementKind): string {
  return { fact: '事实', estimate: '估算', hypothesis: '假设' }[value]
}

function statusLabel(value: string | null): string {
  if (!value) return '未标状态'
  const labels: Record<string, string> = {
    active: '有效',
    draft: '草稿',
    no_evidence_support: '缺少证据',
    blocked: '阻断',
    archived: '已归档',
  }
  return labels[value] ?? value
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(media.matches)
    update()
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [])
  return reduced
}

const ResearchFlowNodeCard = memo(function ResearchFlowNodeCard({ data, selected }: NodeProps<ResearchFlowNode>): React.ReactElement {
  const { node } = data
  const detailTitleId = `industry-research-node-detail-title-${node.id}`
  return (
    <>
      <NodeToolbar
        nodeId={node.id}
        isVisible={data.detailVisible}
        position={toolbarPositions[data.detailPlacement]}
        offset={14}
        align="center"
        className="research-node-detail-toolbar nodrag nopan nowheel"
        data-placement={data.detailPlacement}
        style={{ '--research-node-tone': data.toneColor } as React.CSSProperties}
      >
        <aside
          data-testid="industry-research-node-detail"
          data-node-id={node.id}
          data-placement={data.detailPlacement}
          className="research-node-detail nodrag nopan nowheel"
          style={{
            '--research-node-tone': data.toneColor,
            '--research-detail-width': `${data.detailWidth}px`,
            '--research-detail-max-height': `${data.detailMaxHeight}px`,
          } as React.CSSProperties}
          role="dialog"
          aria-modal="false"
          aria-labelledby={detailTitleId}
          aria-live="polite"
          onClick={(event) => event.stopPropagation()}
        >
          <header className="research-node-detail__header">
            <div className="min-w-0">
              <div className="research-node-detail__eyebrow">
                <span>{data.toneLabel}</span>
                <span>{data.statementLabel}</span>
              </div>
              <h4 id={detailTitleId} data-testid="industry-research-node-detail-title" className="research-node-detail__title">{node.name}</h4>
              <p className="research-node-detail__context">{node.type} · {node.stage || '未分环节'}</p>
            </div>
            <button type="button" className="research-node-detail__close" aria-label={`关闭${node.name}详情`} title="关闭" onClick={(event) => {
              event.stopPropagation()
              data.onCloseDetail()
            }}>×</button>
          </header>
          <div className="research-node-detail__body nowheel">
            <section className="research-node-detail__section">
              <div className="research-node-detail__section-label">研究判断</div>
              <p className="research-node-detail__summary">{data.statusLabel}</p>
              <div className="research-node-detail__evidence"><span>证据</span><b className="tabular-nums">{node.evidenceCount}</b></div>
            </section>
            {node.metrics.length > 0 && (
              <section className="research-node-detail__section">
                <div className="research-node-detail__section-label">关键指标</div>
                <dl className="research-node-detail__metrics">
                  {node.metrics.map((metric) => (
                    <div key={`${metric.label}:${metric.value}`}>
                      <dt>{metric.label}</dt>
                      <dd>{metric.value}{metric.unit ? ` ${metric.unit}` : ''}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
            <section className="research-node-detail__section">
              <div className="research-node-detail__relation-heading">
                <span>传导关系</span>
                <span className="tabular-nums">{data.incomingCount} 入 · {data.outgoingCount} 出</span>
              </div>
              {data.incomingRelations.length === 0 && data.outgoingRelations.length === 0 ? (
                <p className="research-node-detail__empty">当前没有已记录的上下游关系。</p>
              ) : (
                <div className="research-node-detail__relations">
                  {data.incomingRelations.slice(0, 4).map((relation) => <div key={`in:${relation}`}><span>上游</span><p>{relation}</p></div>)}
                  {data.outgoingRelations.slice(0, 4).map((relation) => <div key={`out:${relation}`}><span>下游</span><p>{relation}</p></div>)}
                  {data.incomingRelations.length + data.outgoingRelations.length > 8 && <p className="research-node-detail__more">另有 {data.incomingRelations.length + data.outgoingRelations.length - 8} 条关系</p>}
                </div>
              )}
            </section>
          </div>
        </aside>
      </NodeToolbar>
      <article
        data-testid="industry-research-flow-node"
        data-node-id={node.id}
        data-node-name={node.name}
        data-node-tone={node.tone}
        className={`research-flow-node ${data.dimmed ? 'is-dimmed' : ''} ${data.active ? 'is-active' : ''} ${selected ? 'is-selected' : ''}`}
        style={{ '--research-node-tone': data.toneColor } as React.CSSProperties}
        aria-label={`${node.name}，${data.toneLabel}，${data.statementLabel}，证据 ${node.evidenceCount}`}
      >
        {data.incomingCount > 0 && <Handle type="target" position={Position.Left} isConnectable={false} className="research-flow-handle" />}
        <div className="research-flow-node__header">
          <span>{data.toneLabel}</span>
          <span className="research-flow-node__kind">{data.statementLabel}</span>
        </div>
        <div className="research-flow-node__name">{node.name}</div>
        <div className="research-flow-node__meta">
          <span>{data.statusLabel}</span>
          <span className="tabular-nums">证据 {node.evidenceCount}</span>
        </div>
        {data.outgoingCount > 0 && <Handle type="source" position={Position.Right} isConnectable={false} className="research-flow-handle" />}
      </article>
    </>
  )
})

const nodeTypes = { research: ResearchFlowNodeCard }

function connectedNodeIds(nodeId: string | null, edges: ResearchGraphEdgeView[]): Set<string> {
  if (!nodeId) return new Set()
  const ids = new Set<string>([nodeId])
  for (const edge of edges) {
    if (edge.source === nodeId) ids.add(edge.target)
    if (edge.target === nodeId) ids.add(edge.source)
  }
  return ids
}

export function ResearchGraphCanvas({ graph, onEdit }: Props): React.ReactElement {
  const isDark = useAppStore((state) => state.theme === 'dark')
  const reducedMotion = useReducedMotion()
  const flowRef = useRef<ReactFlowInstance<ResearchFlowNode, ResearchFlowEdge> | null>(null)
  const initialViewportFrameRef = useRef<number | null>(null)
  const hoverTimerRef = useRef<number | null>(null)
  const chartContainerRef = useRef<HTMLDivElement | null>(null)
  const [chartSize, setChartSize] = useState({ width: 0, height: 0 })
  const [zoomPercent, setZoomPercent] = useState(100)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const [detailPlacement, setDetailPlacement] = useState<ResearchNodeDetailPlacement>('right')
  const [graphMode, setGraphMode] = useState<ResearchGraphMode>('focus')
  const model = useMemo(() => graph ? buildResearchGraphViewModel(graph) : null, [graph])
  const compactCanvas = chartSize.width > 0 && chartSize.width < 760

  useEffect(() => {
    const element = chartContainerRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const next = entry.contentRect
      setChartSize({ width: Math.round(next.width), height: Math.round(next.height) })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current == null) return
    window.clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = null
  }, [])

  useEffect(() => () => clearHoverTimer(), [clearHoverTimer])

  useEffect(() => {
    if (!model?.nodes.length) {
      setSelectedNodeId(null)
      setHoveredNodeId(null)
      return
    }
    setSelectedNodeId((current) => current && model.nodes.some((node) => node.id === current) ? current : null)
    setHoveredNodeId(null)
  }, [model])

  useEffect(() => {
    clearHoverTimer()
    setHoveredNodeId(null)
  }, [clearHoverTimer, graphMode])

  const activeFocusNodeId = selectedNodeId ?? (model ? selectResearchGraphFocusNode(model) : null)
  const activeModel = useMemo(() => {
    if (!model || graphMode === 'all') return model
    return buildFocusedResearchGraphViewModel(model, activeFocusNodeId, compactCanvas ? 10 : RESEARCH_GRAPH_FOCUS_LIMIT)
  }, [activeFocusNodeId, compactCanvas, graphMode, model])

  const incoming = model?.edges.filter((edge) => edge.target === selectedNodeId) ?? []
  const outgoing = model?.edges.filter((edge) => edge.source === selectedNodeId) ?? []
  const incomingRelations = incoming.map((edge) => `${model?.nodes.find((node) => node.id === edge.source)?.name ?? '未知节点'} · ${edge.relation}`)
  const outgoingRelations = outgoing.map((edge) => `${model?.nodes.find((node) => node.id === edge.target)?.name ?? '未知节点'} · ${edge.relation}`)
  const interactionNodeId = hoveredNodeId ?? selectedNodeId
  const relatedNodeIds = useMemo(() => connectedNodeIds(interactionNodeId, activeModel?.edges ?? []), [activeModel?.edges, interactionNodeId])
  const detailWidth = Math.min(compactCanvas ? 296 : 340, Math.max(240, chartSize.width - 32))
  const detailMaxHeight = Math.min(compactCanvas ? 320 : 360, Math.max(220, chartSize.height - 32))

  const closeSelectedNode = useCallback(() => {
    clearHoverTimer()
    setHoveredNodeId(null)
    setSelectedNodeId(null)
  }, [clearHoverTimer])

  const placementForNode = useCallback((nodeId: string, viewport: Viewport): ResearchNodeDetailPlacement => {
    const node = activeModel?.nodes.find((item) => item.id === nodeId)
    if (!node) return 'right'
    return resolveResearchNodeDetailPlacement({
      nodeX: node.x,
      nodeY: node.y,
      nodeWidth: graphMode === 'all' ? FULL_NODE_WIDTH : FOCUS_NODE_WIDTH,
      nodeHeight: graphMode === 'all' ? FULL_NODE_HEIGHT : FOCUS_NODE_HEIGHT,
      viewportX: viewport.x,
      viewportY: viewport.y,
      zoom: viewport.zoom,
      canvasWidth: chartSize.width,
      canvasHeight: chartSize.height,
      cardWidth: detailWidth,
      cardHeight: detailMaxHeight,
    })
  }, [activeModel?.nodes, chartSize.height, chartSize.width, detailMaxHeight, detailWidth, graphMode])

  useEffect(() => {
    if (!selectedNodeId) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSelectedNode()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closeSelectedNode, selectedNodeId])

  const incomingCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const edge of activeModel?.edges ?? []) counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1)
    return counts
  }, [activeModel?.edges])
  const outgoingCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const edge of activeModel?.edges ?? []) counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1)
    return counts
  }, [activeModel?.edges])

  const flowNodes = useMemo<ResearchFlowNode[]>(() => {
    if (!activeModel) return []
    const width = graphMode === 'all' ? FULL_NODE_WIDTH : FOCUS_NODE_WIDTH
    const height = graphMode === 'all' ? FULL_NODE_HEIGHT : FOCUS_NODE_HEIGHT
    return activeModel.nodes.map((node) => ({
      id: node.id,
      type: 'research',
      position: { x: node.x - width / 2, y: node.y - height / 2 },
      draggable: false,
      selectable: true,
      selected: node.id === selectedNodeId,
      width,
      height,
      measured: { width, height },
      zIndex: interactionNodeId && relatedNodeIds.has(node.id) ? 3 : 1,
      style: { width, height },
      data: {
        node,
        toneLabel: toneLabels[node.tone],
        toneColor: toneColors[node.tone][isDark ? 'dark' : 'light'],
        statementLabel: statementLabel(node.statementKind),
        statusLabel: statusLabel(node.status),
        incomingCount: incomingCounts.get(node.id) ?? 0,
        outgoingCount: outgoingCounts.get(node.id) ?? 0,
        incomingRelations: node.id === selectedNodeId ? incomingRelations : [],
        outgoingRelations: node.id === selectedNodeId ? outgoingRelations : [],
        detailPlacement,
        detailWidth,
        detailMaxHeight,
        detailVisible: node.id === selectedNodeId,
        onCloseDetail: closeSelectedNode,
        dimmed: interactionNodeId != null && !relatedNodeIds.has(node.id),
        active: node.id === interactionNodeId,
      },
      ariaLabel: `${node.name}，${toneLabels[node.tone]}，证据 ${node.evidenceCount}`,
    }))
  }, [activeModel, closeSelectedNode, detailMaxHeight, detailPlacement, detailWidth, graphMode, incomingCounts, incomingRelations, interactionNodeId, isDark, outgoingCounts, outgoingRelations, relatedNodeIds, selectedNodeId])

  const flowEdges = useMemo<ResearchFlowEdge[]>(() => {
    if (!activeModel) return []
    return activeModel.edges.map((edge) => {
      const related = interactionNodeId != null && (edge.source === interactionNodeId || edge.target === interactionNodeId)
      const dimmed = interactionNodeId != null && !related
      const color = edge.bottleneck
        ? (isDark ? '#fb7185' : '#e11d48')
        : edge.statementKind === 'fact'
          ? (isDark ? '#67e8f9' : '#0e7490')
          : (isDark ? '#64748b' : '#94a3b8')
      return {
        id: edge.id,
        type: 'smoothstep',
        source: edge.source,
        target: edge.target,
        label: related ? edge.relation : undefined,
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        style: {
          stroke: color,
          strokeWidth: related ? 2.4 : edge.bottleneck ? 1.8 : 1.2,
          strokeDasharray: edge.statementKind === 'fact' ? undefined : '6 5',
          opacity: dimmed ? 0.08 : related ? 1 : edge.bottleneck ? 0.78 : 0.38,
          transition: reducedMotion ? undefined : 'opacity 180ms ease, stroke-width 180ms ease',
        },
        labelStyle: { fill: isDark ? '#e2e8f0' : '#334155', fontSize: 11, fontWeight: 600 },
        labelBgStyle: { fill: isDark ? '#0f172a' : '#ffffff', fillOpacity: 0.94 },
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 3,
        pathOptions: { borderRadius: 18, offset: 24 },
        zIndex: related ? 2 : 0,
      }
    })
  }, [activeModel, interactionNodeId, isDark, reducedMotion])

  const fittedViewport = useMemo(() => {
    const nodeWidth = graphMode === 'all' ? FULL_NODE_WIDTH : FOCUS_NODE_WIDTH
    const nodeHeight = graphMode === 'all' ? FULL_NODE_HEIGHT : FOCUS_NODE_HEIGHT
    if (!activeModel?.nodes.length || chartSize.width <= 0 || chartSize.height <= 0) return null
    const minX = Math.min(...activeModel.nodes.map((node) => node.x - nodeWidth / 2))
    const maxX = Math.max(...activeModel.nodes.map((node) => node.x + nodeWidth / 2))
    const minY = Math.min(...activeModel.nodes.map((node) => node.y - nodeHeight / 2))
    const maxY = Math.max(...activeModel.nodes.map((node) => node.y + nodeHeight / 2))
    const contentWidth = Math.max(1, maxX - minX)
    const contentHeight = Math.max(1, maxY - minY)
    const availableWidth = Math.max(1, chartSize.width - (compactCanvas ? 44 : 72))
    const availableHeight = Math.max(1, chartSize.height - 56)
    const zoom = Math.max(MIN_ZOOM, Math.min(1, availableWidth / contentWidth, availableHeight / contentHeight))
    return {
      x: chartSize.width / 2 - ((minX + maxX) / 2) * zoom,
      y: chartSize.height / 2 - ((minY + maxY) / 2) * zoom,
      zoom,
    }
  }, [activeModel, chartSize.height, chartSize.width, compactCanvas, graphMode])

  const applyFittedViewport = useCallback((duration: number) => {
    if (!flowRef.current || !fittedViewport) return
    void flowRef.current.setViewport(fittedViewport, { duration })
  }, [fittedViewport])

  const handleInit = useCallback((instance: ReactFlowInstance<ResearchFlowNode, ResearchFlowEdge>) => {
    flowRef.current = instance
    if (initialViewportFrameRef.current != null) {
      cancelAnimationFrame(initialViewportFrameRef.current)
    }
    initialViewportFrameRef.current = requestAnimationFrame(() => {
      initialViewportFrameRef.current = requestAnimationFrame(() => {
        initialViewportFrameRef.current = null
        if (flowRef.current !== instance) return
        if (graphMode === 'all' && activeModel) {
          void instance.setCenter(activeModel.canvasWidth / 2, activeModel.canvasHeight / 2, {
            zoom: compactCanvas ? 0.55 : 0.72,
            duration: reducedMotion ? 0 : 220,
          })
          return
        }
        applyFittedViewport(0)
      })
    })
  }, [activeModel, applyFittedViewport, compactCanvas, graphMode, reducedMotion])

  useEffect(() => () => {
    if (initialViewportFrameRef.current != null) {
      cancelAnimationFrame(initialViewportFrameRef.current)
    }
  }, [])

  useEffect(() => {
    if (graphMode !== 'focus') return
    const frame = requestAnimationFrame(() => applyFittedViewport(0))
    return () => cancelAnimationFrame(frame)
  }, [applyFittedViewport, graphMode])

  const handleNodeEnter = useCallback((_event: React.MouseEvent, node: ResearchFlowNode) => {
    clearHoverTimer()
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null
      setHoveredNodeId(node.id)
    }, graphMode === 'all' ? 180 : 140)
  }, [clearHoverTimer, graphMode])

  const handleNodeLeave = useCallback((_event: React.MouseEvent, node: ResearchFlowNode) => {
    clearHoverTimer()
    setHoveredNodeId((current) => current === node.id ? null : current)
  }, [clearHoverTimer])

  if (!graph) return <div className="border border-dashed border-slate-300 px-5 py-12 text-center text-sm text-slate-400 dark:border-slate-700">图谱尚未加载。</div>
  if (!model?.nodes.length || !activeModel) return <div className="border border-dashed border-slate-300 px-5 py-12 text-center text-sm text-slate-400 dark:border-slate-700">图谱尚无节点。快速传导种子只会作为估算导入。</div>

  return (
    <section data-testid="industry-research-graph-canvas" className="flex h-[calc(100vh-230px)] min-h-[520px] max-h-[760px] flex-col overflow-hidden border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">产业传导图</h3>
            <span data-testid="industry-research-graph-visible-count" className="text-[11px] tabular-nums text-slate-400">{activeModel.nodes.length} / {model.nodes.length} 节点 · {activeModel.edges.length} / {model.edges.length} 关系</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {(['upstream', 'midstream', 'downstream', 'support'] as ResearchGraphTone[]).map((tone) => (
              <span key={tone} className="inline-flex items-center gap-1.5 text-[10px] text-slate-500 dark:text-slate-400">
                <span className="h-2 w-2" style={{ backgroundColor: toneColors[tone][isDark ? 'dark' : 'light'] }} />
                {toneLabels[tone]}
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div role="group" aria-label="图谱显示范围" className="flex h-8 border border-slate-300 p-0.5 dark:border-slate-700">
            <button type="button" data-testid="industry-research-graph-mode-focus" aria-pressed={graphMode === 'focus'} onClick={() => setGraphMode('focus')} className={`cursor-pointer px-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-cyan-500 ${graphMode === 'focus' ? 'bg-slate-900 font-semibold text-white dark:bg-slate-100 dark:text-slate-900' : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'}`}>关联视图</button>
            <button type="button" data-testid="industry-research-graph-mode-all" aria-pressed={graphMode === 'all'} onClick={() => setGraphMode('all')} className={`cursor-pointer px-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-cyan-500 ${graphMode === 'all' ? 'bg-slate-900 font-semibold text-white dark:bg-slate-100 dark:text-slate-900' : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'}`}>完整图谱</button>
          </div>
          <button type="button" onClick={onEdit} className="h-8 bg-slate-900 px-3 text-xs font-semibold text-white dark:bg-slate-100 dark:text-slate-900">维护图谱</button>
        </div>
      </header>
      <div ref={chartContainerRef} data-testid="industry-research-graph-chart" data-graph-engine="xyflow-react-dom-svg" data-graph-coordinate-space="workflow" data-graph-mode={graphMode} data-graph-roam="enabled" data-graph-wheel-zoom="enabled" data-graph-hover-node={hoveredNodeId ?? ''} data-graph-selected-node={selectedNodeId ?? ''} className="research-flow-canvas relative min-h-0 flex-1 overflow-hidden">
        <ReactFlow<ResearchFlowNode, ResearchFlowEdge>
          key={`${graph.projectId}:${graph.graphUpdatedAt}:${graphMode}:${graphMode === 'focus' ? activeFocusNodeId : 'all'}`}
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          onInit={handleInit}
          onNodeClick={(_event, node) => {
            clearHoverTimer()
            setHoveredNodeId(null)
            if (selectedNodeId === node.id) {
              setSelectedNodeId(null)
              return
            }
            const viewport = flowRef.current?.getViewport() ?? { x: 0, y: 0, zoom: 1 }
            setDetailPlacement(placementForNode(node.id, viewport))
            setSelectedNodeId(node.id)
          }}
          onNodeMouseEnter={handleNodeEnter}
          onNodeMouseLeave={handleNodeLeave}
          onPaneClick={() => {
            clearHoverTimer()
            setHoveredNodeId(null)
            closeSelectedNode()
          }}
          onMove={(_event, viewport) => {
            setZoomPercent((current) => {
              const next = Math.round(viewport.zoom * 100)
              return current === next ? current : next
            })
            if (selectedNodeId) {
              const nextPlacement = placementForNode(selectedNodeId, viewport)
              setDetailPlacement((current) => current === nextPlacement ? current : nextPlacement)
            }
          }}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          panOnDrag
          zoomOnScroll
          zoomOnPinch
          zoomOnDoubleClick={false}
          preventScrolling
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          elementsSelectable
          selectNodesOnDrag={false}
          colorMode={isDark ? 'dark' : 'light'}
          proOptions={{ hideAttribution: true }}
          fitViewOptions={{ padding: graphMode === 'all' ? 0.1 : 0.18, minZoom: MIN_ZOOM, maxZoom: 1 }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color={isDark ? '#334155' : '#cbd5e1'} />
          <Controls position="bottom-left" showInteractive={false} fitViewOptions={{ padding: graphMode === 'all' ? 0.1 : 0.18 }} />
          {!compactCanvas && <MiniMap position="bottom-right" pannable zoomable nodeColor={(node) => toneColors[(node.data?.node as ResearchGraphNodeView | undefined)?.tone ?? 'neutral'][isDark ? 'dark' : 'light']} maskColor={isDark ? 'rgba(2,6,23,0.72)' : 'rgba(241,245,249,0.76)'} />}
        </ReactFlow>
        <div className="research-flow-zoom-readout" aria-live="polite">
          <output data-testid="industry-research-graph-zoom-value" aria-label="当前缩放比例">{zoomPercent}%</output>
        </div>
        {!model.edges.length && <div className="pointer-events-none absolute bottom-3 left-14 border border-amber-200 bg-amber-50/95 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/90 dark:text-amber-200">当前只有节点，尚未形成可验证的传导关系。</div>}
      </div>
    </section>
  )
}
