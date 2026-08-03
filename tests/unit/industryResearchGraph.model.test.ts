import { describe, expect, it } from 'vitest'
import {
  buildFocusedResearchGraphViewModel,
  buildResearchGraphViewModel,
  parseResearchNodeMetrics,
  RESEARCH_GRAPH_COLUMN_SPACING,
  RESEARCH_GRAPH_ROW_SPACING,
  resolveResearchNodeDetailPlacement,
  selectResearchGraphFocusNode,
} from '../../src/components/IndustryResearch/industryResearchGraphModel'
import type { ResearchGraph, ResearchNode } from '../../src/components/IndustryResearch/industryResearchTypes'

function node(id: string, name: string, stage: string, type = 'product'): ResearchNode {
  return {
    id,
    name,
    stage,
    type,
    statement_kind: 'estimate',
    status: 'active',
    metrics_json: '[]',
    evidence_ids_json: '[]',
    last_updated: null,
  }
}

function graph(nodes: ResearchNode[], edges: ResearchGraph['edges']): ResearchGraph {
  return {
    projectId: 'project-graph',
    graphUpdatedAt: 7,
    nodes,
    edges,
    mermaid: 'flowchart LR',
    nodeNames: Object.fromEntries(nodes.map((item) => [item.id, item.name])),
  }
}

describe('industry research graph view model', () => {
  it('lays directed transmission paths out from left to right', () => {
    const model = buildResearchGraphViewModel(graph([
      node('material', 'Raw material', 'upstream', 'material'),
      node('product', 'Core product', 'midstream'),
      node('demand', 'Terminal demand', 'downstream', 'demand'),
    ], [
      { id: 'edge-1', source_node_id: 'material', target_node_id: 'product', relation: 'supply', statement_kind: 'fact', strength: 0.8, bottleneck: 0, exposure_pct: null, evidence_ids_json: '[]', last_updated: null },
      { id: 'edge-2', source_node_id: 'product', target_node_id: 'demand', relation: 'delivery', statement_kind: 'estimate', strength: 0.6, bottleneck: 1, exposure_pct: 45, evidence_ids_json: '["evidence-1"]', last_updated: null },
    ]))

    const positions = Object.fromEntries(model.nodes.map((item) => [item.id, item.x]))
    expect(positions.material).toBeLessThan(positions.product)
    expect(positions.product).toBeLessThan(positions.demand)
    expect(model.edges).toHaveLength(2)
    expect(model.edges[1]).toMatchObject({ bottleneck: true, evidenceCount: 1 })
    expect(model.layers.map((item) => item.label).join(' ')).toContain('上游供给')
  })

  it('uses stage semantics for disconnected nodes and keeps cycle coordinates finite', () => {
    const model = buildResearchGraphViewModel(graph([
      node('support', 'Equipment', 'support', 'equipment'),
      node('a', 'Cycle A', 'midstream'),
      node('b', 'Cycle B', 'downstream', 'demand'),
    ], [
      { id: 'cycle-a', source_node_id: 'a', target_node_id: 'b', relation: 'influence', statement_kind: 'hypothesis', strength: null, bottleneck: 0, exposure_pct: null, evidence_ids_json: 'invalid', last_updated: null },
      { id: 'cycle-b', source_node_id: 'b', target_node_id: 'a', relation: 'feedback', statement_kind: 'hypothesis', strength: null, bottleneck: 0, exposure_pct: null, evidence_ids_json: '[]', last_updated: null },
    ]))

    expect(model.nodes.every((item) => Number.isFinite(item.x) && Number.isFinite(item.y))).toBe(true)
    expect(model.nodes.find((item) => item.id === 'support')?.tone).toBe('support')
    expect(model.edges[0].evidenceCount).toBe(0)
  })

  it('isolates malformed metrics and preserves readable values', () => {
    expect(parseResearchNodeMetrics('not-json')).toEqual([])
    expect(parseResearchNodeMetrics('[{"name":"capacity","value":12.5,"unit":"kt"},{"label":"status","textValue":"ready"}]')).toEqual([
      { label: 'capacity', value: '12.5', unit: 'kt' },
      { label: 'status', value: 'ready', unit: null },
    ])
  })

  it('keeps a 48-node graph readable through a bounded focus subgraph', () => {
    const nodes = Array.from({ length: 6 }, (_, layer) => Array.from({ length: 8 }, (_, index) =>
      node(`layer-${layer}-${index}`, `Layer ${layer} Node ${index}`, layer < 2 ? 'upstream' : layer < 4 ? 'midstream' : 'downstream')
    )).flat()
    const edges: ResearchGraph['edges'] = []
    for (let layer = 0; layer < 5; layer += 1) {
      for (let index = 0; index < 8; index += 1) {
        edges.push({
          id: `edge-main-${layer}-${index}`,
          source_node_id: `layer-${layer}-${index}`,
          target_node_id: `layer-${layer + 1}-${index}`,
          relation: 'transmission',
          statement_kind: 'estimate',
          strength: 0.7,
          bottleneck: 0,
          exposure_pct: null,
          evidence_ids_json: '[]',
          last_updated: null,
        })
      }
    }
    for (let index = 0; index < 15; index += 1) {
      const layer = index % 5
      edges.push({
        id: `edge-cross-${index}`,
        source_node_id: `layer-${layer}-${index % 8}`,
        target_node_id: `layer-${layer + 1}-${(index + 2) % 8}`,
        relation: 'cross transmission',
        statement_kind: 'fact',
        strength: 0.9,
        bottleneck: index % 4 === 0 ? 1 : 0,
        exposure_pct: null,
        evidence_ids_json: '["evidence"]',
        last_updated: null,
      })
    }

    const full = buildResearchGraphViewModel(graph(nodes, edges))
    const focusId = selectResearchGraphFocusNode(full)
    const focused = buildFocusedResearchGraphViewModel(full, focusId)
    expect(full.nodes).toHaveLength(48)
    expect(full.edges).toHaveLength(55)
    expect(full.canvasWidth).toBeGreaterThanOrEqual(1800)
    expect(full.canvasHeight).toBeGreaterThanOrEqual(800)
    expect(focusId).toBeTruthy()
    expect(focused.nodes.length).toBeGreaterThan(1)
    expect(focused.nodes.length).toBeLessThanOrEqual(16)
    expect(focused.nodes.some((item) => item.id === focusId)).toBe(true)
    const visibleIds = new Set(focused.nodes.map((item) => item.id))
    expect(focused.edges.every((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))).toBe(true)

    const layers = new Map<number, number[]>()
    for (const item of focused.nodes) layers.set(item.layer, [...(layers.get(item.layer) ?? []), item.y])
    for (const positions of layers.values()) {
      positions.sort((a, b) => a - b)
      for (let index = 1; index < positions.length; index += 1) {
        expect(positions[index] - positions[index - 1]).toBeGreaterThanOrEqual(RESEARCH_GRAPH_ROW_SPACING)
      }
    }
  })

  it('keeps adjacent PCB layers farther apart than two full-graph node widths', () => {
    const layerSizes = [5, 4, 8, 13, 6, 3, 3, 2, 3]
    const nodes = layerSizes.flatMap((size, layer) => Array.from({ length: size }, (_, index) => node(
      `pcb-${layer}-${index}`,
      layer === 3 && index === 0 ? '深南电路' : layer === 4 && index === 0 ? '常规电子电路铜箔' : `PCB ${layer}-${index}`,
      layer === 0 ? '上游' : layer < 3 ? '中游' : layer < 5 ? '下游' : '终端需求',
      layer === 0 ? 'material' : layer === 3 ? 'company' : 'product',
    )))
    const edges: ResearchGraph['edges'] = []
    for (let layer = 1; layer < layerSizes.length; layer += 1) {
      for (let index = 0; index < layerSizes[layer]; index += 1) {
        edges.push({
          id: `pcb-edge-${layer}-${index}`,
          source_node_id: `pcb-${layer - 1}-0`,
          target_node_id: `pcb-${layer}-${index}`,
          relation: 'transmission',
          statement_kind: 'estimate',
          strength: 0.7,
          bottleneck: 0,
          exposure_pct: null,
          evidence_ids_json: '[]',
          last_updated: null,
        })
      }
    }

    const model = buildResearchGraphViewModel(graph(nodes, edges))
    const shennan = model.nodes.find((item) => item.name === '深南电路')!
    const copperFoil = model.nodes.find((item) => item.name === '常规电子电路铜箔')!

    expect(model.nodes).toHaveLength(47)
    expect(model.layers).toHaveLength(9)
    expect(copperFoil.layer - shennan.layer).toBe(1)
    expect(copperFoil.x - shennan.x).toBe(RESEARCH_GRAPH_COLUMN_SPACING)
    expect(copperFoil.x - shennan.x).toBeGreaterThan(106 + 32)
  })

  it('places node details on a visible side of the current viewport', () => {
    const placement = (overrides: Partial<Parameters<typeof resolveResearchNodeDetailPlacement>[0]> = {}) => resolveResearchNodeDetailPlacement({
      nodeX: 200,
      nodeY: 300,
      nodeWidth: 176,
      nodeHeight: 96,
      viewportX: 0,
      viewportY: 0,
      zoom: 1,
      canvasWidth: 1000,
      canvasHeight: 600,
      cardWidth: 300,
      cardHeight: 260,
      ...overrides,
    })

    expect(placement()).toBe('right')
    expect(placement({ nodeX: 850 })).toBe('left')
    expect(placement({ nodeX: 300, nodeY: 100, canvasWidth: 600 })).toBe('bottom')
    expect(placement({ nodeX: 300, nodeY: 500, canvasWidth: 600 })).toBe('top')
  })
})
