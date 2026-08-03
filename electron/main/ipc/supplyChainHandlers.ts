/**
 * FR-171: 产业链传导分析 IPC 处理器
 *
 * 注册 5 个 IPC：
 *   supplyChain:analyze      分析文本，返回传导图谱
 *   supplyChain:getEdges     获取所有边（含禁用）
 *   supplyChain:saveEdge     写入或更新一条边
 *   supplyChain:deleteEdge   删除一条边
 *   supplyChain:getChainGroups 获取所有产业链组名
 */

import { ipcMain } from 'electron'
import { getDb } from '../database/db'
import { analyzeText } from '../services/supplyChainService'
import {
  getAllEdges,
  upsertEdge,
  deleteEdge,
  getChainGroups,
} from '../database/supplyChainRepository'

export function registerSupplyChainHandlers(): void {
  // ── supplyChain:analyze ───────────────────────────────────────────────────
  ipcMain.handle('supplyChain:analyze', async (_, payload: { text?: string }) => {
    const text = payload?.text?.trim()
    if (!text) return { ok: false, code: 'INVALID_PARAM', message: 'text 不能为空' }
    try {
      const db = getDb()
      const result = await analyzeText(db, text)
      if (result.matchedBy === 'none') {
        return { ok: false, code: 'NO_MATCH', message: '未找到相关产业链节点' }
      }
      // 将 Map<string, MemberStock[]> 转为普通 Record 供 IPC 序列化
      const stocksRecord: Record<string, typeof result.nodes[0]['stocks']> = {}
      for (const node of result.nodes) {
        stocksRecord[node.concept] = node.stocks
      }
      return {
        ok: true,
        data: {
          hitConcepts: result.hitConcepts,
          chainGroup: result.chainGroup,
          matchedBy: result.matchedBy,
          attribution: result.attribution,
          recommendedStocks: result.recommendedStocks ?? [],
          nodes: result.nodes,
          edges: result.edges,
          stocks: stocksRecord,
        },
      }
    } catch (err) {
      console.error('[supplyChain:analyze]', err)
      return { ok: false, code: 'UPSTREAM_ERROR', message: String(err) }
    }
  })

  // ── supplyChain:getEdges ──────────────────────────────────────────────────
  ipcMain.handle('supplyChain:getEdges', async () => {
    try {
      const edges = getAllEdges(getDb())
      return { ok: true, data: edges }
    } catch (err) {
      return { ok: false, code: 'DB_ERROR', message: String(err) }
    }
  })

  // ── supplyChain:saveEdge ──────────────────────────────────────────────────
  ipcMain.handle('supplyChain:saveEdge', async (_, payload: { edge?: Record<string, unknown> }) => {
    const edge = payload?.edge
    if (!edge?.upstreamConcept || !edge?.downstreamConcept) {
      return { ok: false, code: 'INVALID_PARAM', message: '上下游概念名不能为空' }
    }
    try {
      const id = upsertEdge(getDb(), {
        id: typeof edge.id === 'number' ? edge.id : 0,
        upstreamConcept: String(edge.upstreamConcept),
        downstreamConcept: String(edge.downstreamConcept),
        relationLabel: String(edge.relationLabel ?? '传导至'),
        chainGroup: String(edge.chainGroup ?? '通用'),
        sortOrder: typeof edge.sortOrder === 'number' ? edge.sortOrder : 0,
        isEnabled: edge.isEnabled === false || edge.isEnabled === 0 ? 0 : 1,
      })
      return { ok: true, data: { id } }
    } catch (err) {
      return { ok: false, code: 'DB_ERROR', message: String(err) }
    }
  })

  // ── supplyChain:deleteEdge ────────────────────────────────────────────────
  ipcMain.handle('supplyChain:deleteEdge', async (_, payload: { id?: unknown }) => {
    const id = typeof payload?.id === 'number' ? payload.id : 0
    if (!id) return { ok: false, code: 'INVALID_PARAM', message: 'id 不能为空' }
    try {
      deleteEdge(getDb(), id)
      return { ok: true }
    } catch (err) {
      return { ok: false, code: 'DB_ERROR', message: String(err) }
    }
  })

  // ── supplyChain:getChainGroups ────────────────────────────────────────────
  ipcMain.handle('supplyChain:getChainGroups', async () => {
    try {
      const groups = getChainGroups(getDb())
      return { ok: true, data: groups }
    } catch (err) {
      return { ok: false, code: 'DB_ERROR', message: String(err) }
    }
  })
}
