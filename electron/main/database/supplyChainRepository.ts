/**
 * FR-171: 产业链传导分析 — supply_chain_edges 表 CRUD
 */

import type Database from 'better-sqlite3'
import type { SupplyChainEdgeRow } from './types'
import { DEFAULT_SUPPLY_CHAIN_EDGES } from './defaultSupplyChainEdges'

// ──── 行映射辅助 ────────────────────────────────────────────────────────────

interface RawRow {
  id: number
  upstream_concept: string
  downstream_concept: string
  relation_label: string
  chain_group: string
  sort_order: number
  is_enabled: number
}

function toRow(r: RawRow): SupplyChainEdgeRow {
  return {
    id: r.id,
    upstreamConcept: r.upstream_concept,
    downstreamConcept: r.downstream_concept,
    relationLabel: r.relation_label,
    chainGroup: r.chain_group,
    sortOrder: r.sort_order,
    isEnabled: r.is_enabled,
  }
}

// ──── 初始化默认数据 ────────────────────────────────────────────────────────

/**
 * 若 supply_chain_edges 表为空，则写入内置默认边数据。
 * 在主进程启动时调用，幂等（已有数据时不重复写）。
 */
export function initDefaultEdgesIfEmpty(db: Database.Database): void {
  const count = (db.prepare('SELECT COUNT(*) AS cnt FROM supply_chain_edges').get() as { cnt: number }).cnt
  if (count > 0) return

  const insert = db.prepare(`
    INSERT OR IGNORE INTO supply_chain_edges
      (upstream_concept, downstream_concept, relation_label, chain_group, sort_order, is_enabled)
    VALUES (?, ?, ?, ?, ?, 1)
  `)

  const insertMany = db.transaction(() => {
    for (const edge of DEFAULT_SUPPLY_CHAIN_EDGES) {
      insert.run(
        edge.upstreamConcept,
        edge.downstreamConcept,
        edge.relationLabel,
        edge.chainGroup,
        edge.sortOrder,
      )
    }
  })
  insertMany()
}

// ──── 查询函数 ──────────────────────────────────────────────────────────────

/** 查询所有启用的边（用于传导分析） */
export function getEnabledEdges(db: Database.Database): SupplyChainEdgeRow[] {
  const rows = db
    .prepare('SELECT * FROM supply_chain_edges WHERE is_enabled = 1 ORDER BY chain_group, sort_order')
    .all() as RawRow[]
  return rows.map(toRow)
}

/** 查询所有边（含禁用，用于管理界面） */
export function getAllEdges(db: Database.Database): SupplyChainEdgeRow[] {
  const rows = db
    .prepare('SELECT * FROM supply_chain_edges ORDER BY chain_group, sort_order')
    .all() as RawRow[]
  return rows.map(toRow)
}

/** 按产业链组查询所有边 */
export function getEdgesByGroup(db: Database.Database, chainGroup: string): SupplyChainEdgeRow[] {
  const rows = db
    .prepare('SELECT * FROM supply_chain_edges WHERE chain_group = ? ORDER BY sort_order')
    .all(chainGroup) as RawRow[]
  return rows.map(toRow)
}

/** 查询所有产业链组名（去重） */
export function getChainGroups(db: Database.Database): string[] {
  const rows = db
    .prepare('SELECT DISTINCT chain_group FROM supply_chain_edges ORDER BY chain_group')
    .all() as { chain_group: string }[]
  return rows.map((r) => r.chain_group)
}

// ──── 写入函数 ──────────────────────────────────────────────────────────────

/** 写入或更新一条边（按 id 判断：id=0/undefined 时新建，否则更新） */
export function upsertEdge(
  db: Database.Database,
  edge: Omit<SupplyChainEdgeRow, 'id'> & { id?: number }
): number {
  if (edge.id && edge.id > 0) {
    db.prepare(`
      UPDATE supply_chain_edges
      SET upstream_concept = ?, downstream_concept = ?, relation_label = ?,
          chain_group = ?, sort_order = ?, is_enabled = ?
      WHERE id = ?
    `).run(
      edge.upstreamConcept,
      edge.downstreamConcept,
      edge.relationLabel,
      edge.chainGroup,
      edge.sortOrder,
      edge.isEnabled,
      edge.id,
    )
    return edge.id
  } else {
    const result = db.prepare(`
      INSERT INTO supply_chain_edges
        (upstream_concept, downstream_concept, relation_label, chain_group, sort_order, is_enabled)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      edge.upstreamConcept,
      edge.downstreamConcept,
      edge.relationLabel,
      edge.chainGroup,
      edge.sortOrder,
      edge.isEnabled,
    )
    return result.lastInsertRowid as number
  }
}

/** 删除一条边 */
export function deleteEdge(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM supply_chain_edges WHERE id = ?').run(id)
}

/** 切换边的启用/禁用状态 */
export function setEdgeEnabled(db: Database.Database, id: number, enabled: boolean): void {
  db.prepare('UPDATE supply_chain_edges SET is_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
}

/** 批量导入边（全量替换，谨慎使用） */
export function replaceAllEdges(db: Database.Database, edges: Omit<SupplyChainEdgeRow, 'id'>[]): void {
  const clear = db.prepare('DELETE FROM supply_chain_edges')
  const insert = db.prepare(`
    INSERT OR IGNORE INTO supply_chain_edges
      (upstream_concept, downstream_concept, relation_label, chain_group, sort_order, is_enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  db.transaction(() => {
    clear.run()
    for (const e of edges) {
      insert.run(e.upstreamConcept, e.downstreamConcept, e.relationLabel, e.chainGroup, e.sortOrder, e.isEnabled)
    }
  })()
}
