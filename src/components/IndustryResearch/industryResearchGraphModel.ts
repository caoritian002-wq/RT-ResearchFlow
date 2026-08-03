import type {
  ResearchGraph,
  ResearchNode,
  ResearchStatementKind,
} from './industryResearchTypes'

export type ResearchGraphTone = 'upstream' | 'midstream' | 'downstream' | 'support' | 'neutral'

export interface ResearchGraphMetricView {
  label: string
  value: string
  unit: string | null
}

export interface ResearchGraphNodeView {
  id: string
  name: string
  type: string
  stage: string | null
  tone: ResearchGraphTone
  statementKind: ResearchStatementKind
  status: string | null
  evidenceCount: number
  metrics: ResearchGraphMetricView[]
  x: number
  y: number
  layer: number
}

export interface ResearchGraphEdgeView {
  id: string
  source: string
  target: string
  relation: string
  statementKind: ResearchStatementKind
  strength: number | null
  bottleneck: boolean
  exposurePct: number | null
  evidenceCount: number
}

export interface ResearchGraphLayerView {
  index: number
  label: string
  nodeCount: number
}

export interface ResearchGraphViewModel {
  nodes: ResearchGraphNodeView[]
  edges: ResearchGraphEdgeView[]
  layers: ResearchGraphLayerView[]
  canvasWidth: number
  canvasHeight: number
}

export type ResearchNodeDetailPlacement = 'top' | 'right' | 'bottom' | 'left'

export interface ResearchNodeDetailPlacementInput {
  nodeX: number
  nodeY: number
  nodeWidth: number
  nodeHeight: number
  viewportX: number
  viewportY: number
  zoom: number
  canvasWidth: number
  canvasHeight: number
  cardWidth: number
  cardHeight: number
  offset?: number
  margin?: number
}

export const RESEARCH_GRAPH_FOCUS_LIMIT = 16
export const RESEARCH_GRAPH_COLUMN_SPACING = 260
export const RESEARCH_GRAPH_ROW_SPACING = 120

export function resolveResearchNodeDetailPlacement(input: ResearchNodeDetailPlacementInput): ResearchNodeDetailPlacement {
  const zoom = Number.isFinite(input.zoom) && input.zoom > 0 ? input.zoom : 1
  const offset = input.offset ?? 14
  const margin = input.margin ?? 16
  const left = input.viewportX + (input.nodeX - input.nodeWidth / 2) * zoom
  const right = input.viewportX + (input.nodeX + input.nodeWidth / 2) * zoom
  const top = input.viewportY + (input.nodeY - input.nodeHeight / 2) * zoom
  const bottom = input.viewportY + (input.nodeY + input.nodeHeight / 2) * zoom
  const available: Record<ResearchNodeDetailPlacement, number> = {
    right: input.canvasWidth - margin - right,
    left: left - margin,
    bottom: input.canvasHeight - margin - bottom,
    top: top - margin,
  }
  const required: Record<ResearchNodeDetailPlacement, number> = {
    right: input.cardWidth + offset,
    left: input.cardWidth + offset,
    bottom: input.cardHeight + offset,
    top: input.cardHeight + offset,
  }
  const preference: ResearchNodeDetailPlacement[] = ['right', 'left', 'bottom', 'top']
  const fitting = preference.find((placement) => available[placement] >= required[placement])
  if (fitting) return fitting
  return [...preference].sort((a, b) =>
    available[b] / Math.max(1, required[b]) - available[a] / Math.max(1, required[a])
    || preference.indexOf(a) - preference.indexOf(b)
  )[0]
}

function parseArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function valueText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? '是' : '否'
  return null
}

export function parseResearchNodeMetrics(value: string): ResearchGraphMetricView[] {
  return parseArray(value).flatMap((item, index) => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const label = valueText(record.name) ?? valueText(record.label) ?? valueText(record.metric) ?? `指标 ${index + 1}`
    const metricValue = valueText(record.value) ?? valueText(record.text_value) ?? valueText(record.textValue)
    if (!metricValue) return []
    return [{ label, value: metricValue, unit: valueText(record.unit) }]
  }).slice(0, 4)
}

export function researchGraphTone(node: ResearchNode): ResearchGraphTone {
  const text = `${node.stage ?? ''} ${node.type}`.toLowerCase()
  if (/(支撑|设备|工艺|技术|指标|equipment|process|technology|metric)/.test(text)) return 'support'
  if (/(下游|需求|终端|应用|客户|demand|country|policy)/.test(text)) return 'downstream'
  if (/(上游|原料|材料|资源|material)/.test(text)) return 'upstream'
  if (/(中游|制造|加工|产品|产业|公司|证券|product|industry|company|stock)/.test(text)) return 'midstream'
  return 'neutral'
}

function toneRank(tone: ResearchGraphTone): number {
  return { upstream: 0, support: 1, midstream: 2, downstream: 3, neutral: 2 }[tone]
}

function layerLabel(nodes: ResearchGraphNodeView[]): string {
  const tones = new Set(nodes.map((node) => node.tone))
  const ordered: Array<[ResearchGraphTone, string]> = [
    ['upstream', '上游供给'],
    ['support', '设备与支撑'],
    ['midstream', '中游制造'],
    ['downstream', '下游需求'],
    ['neutral', '关联节点'],
  ]
  return ordered.filter(([tone]) => tones.has(tone)).map(([, label]) => label).join(' / ') || '关联节点'
}

function nodeDegree(edges: ResearchGraphEdgeView[]): Map<string, number> {
  const degree = new Map<string, number>()
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
  }
  return degree
}

export function selectResearchGraphFocusNode(model: ResearchGraphViewModel): string | null {
  const degree = nodeDegree(model.edges)
  const tonePriority: Record<ResearchGraphTone, number> = {
    midstream: 0,
    neutral: 1,
    downstream: 2,
    upstream: 3,
    support: 4,
  }
  return [...model.nodes].sort((a, b) =>
    (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)
    || b.evidenceCount - a.evidenceCount
    || tonePriority[a.tone] - tonePriority[b.tone]
    || a.name.localeCompare(b.name, 'zh-CN')
  )[0]?.id ?? null
}

export function buildFocusedResearchGraphViewModel(
  model: ResearchGraphViewModel,
  requestedFocusNodeId: string | null,
  limit = RESEARCH_GRAPH_FOCUS_LIMIT,
): ResearchGraphViewModel {
  if (!model.nodes.length) return model
  const focusNodeId = model.nodes.some((node) => node.id === requestedFocusNodeId)
    ? requestedFocusNodeId!
    : selectResearchGraphFocusNode(model)!
  const maxNodes = Math.max(1, Math.floor(limit))
  const degree = nodeDegree(model.edges)
  const edgesByNode = new Map(model.nodes.map((node) => [node.id, [] as ResearchGraphEdgeView[]]))
  for (const edge of model.edges) {
    edgesByNode.get(edge.source)?.push(edge)
    edgesByNode.get(edge.target)?.push(edge)
  }

  const selected = new Set<string>([focusNodeId])
  const queue = [focusNodeId]
  while (queue.length && selected.size < maxNodes) {
    const currentId = queue.shift()!
    const candidates = (edgesByNode.get(currentId) ?? []).map((edge) => ({
      edge,
      nodeId: edge.source === currentId ? edge.target : edge.source,
    })).sort((a, b) =>
      Number(b.edge.bottleneck) - Number(a.edge.bottleneck)
      || b.edge.evidenceCount - a.edge.evidenceCount
      || (b.edge.strength ?? 0) - (a.edge.strength ?? 0)
      || (degree.get(b.nodeId) ?? 0) - (degree.get(a.nodeId) ?? 0)
      || a.nodeId.localeCompare(b.nodeId)
    )
    for (const candidate of candidates) {
      if (selected.has(candidate.nodeId)) continue
      selected.add(candidate.nodeId)
      queue.push(candidate.nodeId)
      if (selected.size >= maxNodes) break
    }
  }

  if (selected.size === 1 && maxNodes > 1) {
    const focusNode = model.nodes.find((node) => node.id === focusNodeId)!
    for (const peer of model.nodes.filter((node) => node.layer === focusNode.layer && node.id !== focusNodeId).slice(0, maxNodes - 1)) {
      selected.add(peer.id)
    }
  }

  const sourceNodes = model.nodes.filter((node) => selected.has(node.id))
  const sourceLayers = Array.from(new Set(sourceNodes.map((node) => node.layer))).sort((a, b) => a - b)
  const compressedLayer = new Map(sourceLayers.map((layer, index) => [layer, index]))
  const nodesByLayer = new Map<number, ResearchGraphNodeView[]>()
  for (const node of sourceNodes) {
    const items = nodesByLayer.get(node.layer) ?? []
    items.push(node)
    nodesByLayer.set(node.layer, items)
  }
  const maxLayerSize = Math.max(1, ...Array.from(nodesByLayer.values()).map((nodes) => nodes.length))
  const canvasHeight = Math.max(560, (maxLayerSize + 1) * RESEARCH_GRAPH_ROW_SPACING)
  const canvasWidth = Math.max(900, (sourceLayers.length + 1) * RESEARCH_GRAPH_COLUMN_SPACING)
  const nodes: ResearchGraphNodeView[] = []
  for (const layer of sourceLayers) {
    const sorted = [...(nodesByLayer.get(layer) ?? [])].sort((a, b) => a.y - b.y || a.name.localeCompare(b.name, 'zh-CN'))
    sorted.forEach((node, index) => {
      nodes.push({
        ...node,
        x: RESEARCH_GRAPH_COLUMN_SPACING / 2 + (compressedLayer.get(layer) ?? 0) * RESEARCH_GRAPH_COLUMN_SPACING,
        y: ((index + 1) * canvasHeight) / (sorted.length + 1),
      })
    })
  }

  return {
    nodes,
    edges: model.edges.filter((edge) => selected.has(edge.source) && selected.has(edge.target)),
    layers: sourceLayers.map((layer) => {
      const sourceLayer = model.layers.find((item) => item.index === layer)
      return {
        index: layer,
        label: sourceLayer?.label ?? layerLabel(nodes.filter((node) => node.layer === layer)),
        nodeCount: nodes.filter((node) => node.layer === layer).length,
      }
    }),
    canvasWidth,
    canvasHeight,
  }
}

export function buildResearchGraphViewModel(graph: ResearchGraph): ResearchGraphViewModel {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const validEdges = graph.edges.filter((edge) => nodeById.has(edge.source_node_id) && nodeById.has(edge.target_node_id))
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]))
  const outgoing = new Map(graph.nodes.map((node) => [node.id, [] as string[]]))
  const depth = new Map(graph.nodes.map((node) => [node.id, toneRank(researchGraphTone(node))]))

  for (const edge of validEdges) {
    indegree.set(edge.target_node_id, (indegree.get(edge.target_node_id) ?? 0) + 1)
    outgoing.get(edge.source_node_id)?.push(edge.target_node_id)
  }

  const queue = graph.nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) || a.name.localeCompare(b.name, 'zh-CN'))
    .map((node) => node.id)
  const processed = new Set<string>()

  while (queue.length) {
    const sourceId = queue.shift()!
    processed.add(sourceId)
    for (const targetId of outgoing.get(sourceId) ?? []) {
      depth.set(targetId, Math.max(depth.get(targetId) ?? 0, (depth.get(sourceId) ?? 0) + 1))
      const nextIndegree = (indegree.get(targetId) ?? 1) - 1
      indegree.set(targetId, nextIndegree)
      if (nextIndegree === 0) queue.push(targetId)
    }
  }

  for (const node of graph.nodes) {
    if (!processed.has(node.id)) depth.set(node.id, toneRank(researchGraphTone(node)))
  }

  const rawDepths = Array.from(new Set(graph.nodes.map((node) => depth.get(node.id) ?? 0))).sort((a, b) => a - b)
  const compressedDepth = new Map(rawDepths.map((value, index) => [value, index]))
  const nodesByLayer = new Map<number, ResearchNode[]>()
  for (const node of graph.nodes) {
    const layer = compressedDepth.get(depth.get(node.id) ?? 0) ?? 0
    const items = nodesByLayer.get(layer) ?? []
    items.push(node)
    nodesByLayer.set(layer, items)
  }

  const orderedLayers = Array.from(nodesByLayer.keys()).sort((a, b) => a - b)
  const orderedNodes = new Map(orderedLayers.map((layer) => [layer, [...(nodesByLayer.get(layer) ?? [])].sort((a, b) =>
    toneRank(researchGraphTone(a)) - toneRank(researchGraphTone(b)) || a.name.localeCompare(b.name, 'zh-CN')
  )]))
  const incomingNeighbors = new Map(graph.nodes.map((node) => [node.id, [] as string[]]))
  for (const edge of validEdges) incomingNeighbors.get(edge.target_node_id)?.push(edge.source_node_id)

  const reorder = (layers: number[], neighbors: Map<string, string[]>) => {
    const positions = new Map<string, number>()
    for (const layer of orderedLayers) (orderedNodes.get(layer) ?? []).forEach((node, index) => positions.set(node.id, index))
    for (const layer of layers) {
      const current = orderedNodes.get(layer) ?? []
      const currentPosition = new Map(current.map((node, index) => [node.id, index]))
      current.sort((a, b) => {
        const score = (node: ResearchNode) => {
          const values = (neighbors.get(node.id) ?? []).map((id) => positions.get(id)).filter((value): value is number => value != null)
          return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : (currentPosition.get(node.id) ?? 0)
        }
        return score(a) - score(b) || (currentPosition.get(a.id) ?? 0) - (currentPosition.get(b.id) ?? 0)
      })
      current.forEach((node, index) => positions.set(node.id, index))
    }
  }
  for (let pass = 0; pass < 3; pass += 1) {
    reorder(orderedLayers.slice(1), incomingNeighbors)
    reorder([...orderedLayers].reverse().slice(1), outgoing)
  }

  const maxLayerSize = Math.max(1, ...Array.from(orderedNodes.values()).map((nodes) => nodes.length))
  const canvasHeight = Math.max(560, (maxLayerSize + 1) * RESEARCH_GRAPH_ROW_SPACING)
  const canvasWidth = Math.max(900, (Math.max(1, orderedNodes.size) + 1) * RESEARCH_GRAPH_COLUMN_SPACING)
  const nodes: ResearchGraphNodeView[] = []

  for (const layer of orderedLayers) {
    const sorted = orderedNodes.get(layer) ?? []
    sorted.forEach((node, index) => {
      nodes.push({
        id: node.id,
        name: node.name,
        type: node.type,
        stage: node.stage,
        tone: researchGraphTone(node),
        statementKind: node.statement_kind,
        status: node.status,
        evidenceCount: parseArray(node.evidence_ids_json).length,
        metrics: parseResearchNodeMetrics(node.metrics_json),
        x: RESEARCH_GRAPH_COLUMN_SPACING / 2 + layer * RESEARCH_GRAPH_COLUMN_SPACING,
        y: ((index + 1) * canvasHeight) / (sorted.length + 1),
        layer,
      })
    })
  }

  const layers = Array.from(nodesByLayer.keys()).sort((a, b) => a - b).map((index) => {
    const layerNodes = nodes.filter((node) => node.layer === index)
    return { index, label: layerLabel(layerNodes), nodeCount: layerNodes.length }
  })

  return {
    nodes,
    edges: validEdges.map((edge) => ({
      id: edge.id,
      source: edge.source_node_id,
      target: edge.target_node_id,
      relation: edge.relation,
      statementKind: edge.statement_kind,
      strength: edge.strength,
      bottleneck: edge.bottleneck === 1,
      exposurePct: edge.exposure_pct,
      evidenceCount: parseArray(edge.evidence_ids_json).length,
    })),
    layers,
    canvasWidth,
    canvasHeight,
  }
}
