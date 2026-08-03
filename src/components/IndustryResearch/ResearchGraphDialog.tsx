import React, { useState } from 'react'
import type { ResearchGraph } from './industryResearchTypes'
import { DialogActions, DialogFrame } from './ResearchProjectDialog'

export interface ResearchGraphSaveDraft {
  nodes: Array<Record<string, unknown>>
  edges: Array<Record<string, unknown>>
  expectedUpdatedAt: number
}

function parseArray(value: string, field: string): unknown[] {
  const parsed = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new Error(`${field}必须为 JSON 数组`)
  return parsed
}

export function graphDraft(graph: ResearchGraph): ResearchGraphSaveDraft {
  return {
    expectedUpdatedAt: graph.graphUpdatedAt,
    nodes: graph.nodes.map(node => ({
      id: node.id, type: node.type, name: node.name, stage: node.stage, statementKind: node.statement_kind,
      status: node.status, metrics: parseArray(node.metrics_json, '节点指标'), evidenceIds: parseArray(node.evidence_ids_json, '节点证据'), lastUpdated: node.last_updated,
    })),
    edges: graph.edges.map(edge => ({
      id: edge.id, source: edge.source_node_id, target: edge.target_node_id, relation: edge.relation,
      statementKind: edge.statement_kind, strength: edge.strength, bottleneck: edge.bottleneck === 1,
      exposurePct: edge.exposure_pct, evidenceIds: parseArray(edge.evidence_ids_json, '关系证据'), lastUpdated: edge.last_updated,
    })),
  }
}

interface Props {
  graph: ResearchGraph
  saving: boolean
  error: string | null
  onClose: () => void
  onSubmit: (draft: ResearchGraphSaveDraft) => void
}

export function ResearchGraphDialog({ graph, saving, error, onClose, onSubmit }: Props): React.ReactElement {
  const initial = graphDraft(graph)
  const [nodesText, setNodesText] = useState(JSON.stringify(initial.nodes, null, 2))
  const [edgesText, setEdgesText] = useState(JSON.stringify(initial.edges, null, 2))
  const [localError, setLocalError] = useState<string | null>(null)
  return <DialogFrame title="维护结构化图谱" onClose={onClose}><form onSubmit={event => {
    event.preventDefault()
    try {
      const nodes = parseArray(nodesText, '节点') as Array<Record<string, unknown>>
      const edges = parseArray(edgesText, '关系') as Array<Record<string, unknown>>
      setLocalError(null)
      onSubmit({ nodes, edges, expectedUpdatedAt: graph.graphUpdatedAt })
    } catch (cause) { setLocalError(cause instanceof Error ? cause.message : '图谱 JSON 无效') }
  }} className="space-y-3">
    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300">结构化图谱是事实源。事实节点和关系必须绑定已确认的证据 ID；快速传导种子应保持 estimate。</div>
    <label className="block"><span className="mb-1 block text-xs font-medium">节点 JSON</span><textarea value={nodesText} onChange={event => setNodesText(event.target.value)} className="research-input min-h-44 resize-y py-2 font-mono text-[11px]" /></label>
    <label className="block"><span className="mb-1 block text-xs font-medium">关系 JSON</span><textarea value={edgesText} onChange={event => setEdgesText(event.target.value)} className="research-input min-h-36 resize-y py-2 font-mono text-[11px]" /></label>
    {(localError || error) && <div className="text-xs text-red-600 dark:text-red-300">{localError || error}</div>}
    <DialogActions saving={saving} valid onClose={onClose} submitLabel="保存图谱" />
  </form></DialogFrame>
}