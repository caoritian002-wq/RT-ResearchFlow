import { createHash, randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import {
  getLatestResearchProfitBridge,
  listResearchProfitBridgeItems,
  saveResearchProfitBridgeVersion,
  type ResearchProfitBridgeItemInput,
} from '../database/industryResearchFinancialRepository'
import type {
  IndustryResearchProfitBridgeItemKey,
  IndustryResearchProfitBridgeStatus,
} from '../database/types'
import { IndustryResearchError } from './industryResearchService'

export interface ProfitBridgeItemInput {
  key: IndustryResearchProfitBridgeItemKey
  label: string
  amount?: number | null
  unit?: string | null
  methodology?: string | null
}

export interface SaveProfitBridgeInput {
  id?: string
  bridgeKey?: string
  basePeriod: string
  targetPeriod: string
  status: IndustryResearchProfitBridgeStatus
  items: ProfitBridgeItemInput[]
  formula?: string | null
  inputFactIds?: string[]
  evidenceIds?: string[]
  createdBy: 'human' | 'import'
}

function stableItemId(bridgeId: string, key: string): string {
  return `profit_bridge_item_${createHash('sha256').update(`${bridgeId}:${key}`).digest('hex').slice(0, 24)}`
}

function requireScope(db: Database.Database, projectId: string, companyId: string): void {
  const scope = db.prepare(`
    SELECT 1 FROM industry_research_project_companies
    WHERE project_id = ? AND company_id = ?
  `).get(projectId, companyId)
  if (!scope) throw new IndustryResearchError('NOT_FOUND', '项目公司不存在')
}

function validateReferences(
  db: Database.Database,
  projectId: string,
  companyId: string,
  inputFactIds: string[],
  evidenceIds: string[],
): void {
  if (inputFactIds.length > 0) {
    const placeholders = inputFactIds.map(() => '?').join(', ')
    const rows = db.prepare(`
      SELECT id FROM industry_research_financial_facts
      WHERE company_id = ? AND id IN (${placeholders})
    `).all(companyId, ...inputFactIds) as Array<{ id: string }>
    if (rows.length !== new Set(inputFactIds).size) {
      throw new IndustryResearchError('PROFIT_BRIDGE_INVALID', '利润桥输入事实必须属于同一公司')
    }
  }
  if (evidenceIds.length > 0) {
    const placeholders = evidenceIds.map(() => '?').join(', ')
    const rows = db.prepare(`
      SELECT id FROM industry_research_disclosure_evidence
      WHERE company_id = ? AND (project_id IS NULL OR project_id = ?) AND id IN (${placeholders})
    `).all(companyId, projectId, ...evidenceIds) as Array<{ id: string }>
    if (rows.length !== new Set(evidenceIds).size) {
      throw new IndustryResearchError('PROFIT_BRIDGE_INVALID', '利润桥证据不属于当前项目公司')
    }
  }
}

export function saveIndustryResearchProfitBridge(
  db: Database.Database,
  projectId: string,
  companyId: string,
  bridge: SaveProfitBridgeInput,
  expectedUpdatedAt: number | null,
  now = Date.now(),
) {
  requireScope(db, projectId, companyId)
  const bridgeKey = bridge.bridgeKey?.trim() || bridge.id?.trim() || randomUUID()
  const current = getLatestResearchProfitBridge(db, projectId, companyId, bridgeKey)
  if (!current && expectedUpdatedAt !== null) {
    throw new IndustryResearchError('VERSION_CONFLICT', '利润桥版本已变化')
  }
  if (current && current.updated_at !== expectedUpdatedAt) {
    throw new IndustryResearchError('VERSION_CONFLICT', '利润桥版本已变化')
  }

  const inputFactIds = Array.from(new Set(bridge.inputFactIds ?? []))
  const evidenceIds = Array.from(new Set(bridge.evidenceIds ?? []))
  const itemKeys = new Set(bridge.items.map((item) => item.key))
  if (itemKeys.size !== bridge.items.length) {
    throw new IndustryResearchError('PROFIT_BRIDGE_INVALID', '利润桥桥接项重复')
  }
  validateReferences(db, projectId, companyId, inputFactIds, evidenceIds)

  const canEstimate = Boolean(
    bridge.formula?.trim()
    && bridge.items.some((item) => item.amount != null && Number.isFinite(item.amount))
    && inputFactIds.length > 0,
  )
  if (bridge.status === 'estimate' && !canEstimate) {
    throw new IndustryResearchError('PROFIT_BRIDGE_INVALID', '估算利润桥缺少透明公式、非空桥接项或输入事实')
  }

  const id = randomUUID()
  const items: ResearchProfitBridgeItemInput[] = bridge.items.map((item, index) => ({
    id: stableItemId(id, item.key),
    key: item.key,
    label: item.label,
    amount: item.amount ?? null,
    unit: item.unit ?? null,
    methodology: item.methodology ?? null,
    sortOrder: index,
  }))
  const saved = saveResearchProfitBridgeVersion(db, {
    id,
    projectId,
    companyId,
    bridgeKey,
    basePeriod: bridge.basePeriod,
    targetPeriod: bridge.targetPeriod,
    status: canEstimate ? bridge.status : 'hypothesis',
    formula: bridge.formula?.trim() || null,
    inputFactIds,
    evidenceIds,
    createdBy: bridge.createdBy,
    version: (current?.version ?? 0) + 1,
    previousVersionId: current?.id ?? null,
    items,
  }, now)
  return {
    id: saved.id,
    bridgeKey: saved.bridge_key,
    projectId: saved.project_id,
    companyId: saved.company_id,
    basePeriod: saved.base_period,
    targetPeriod: saved.target_period,
    status: saved.status,
    items: listResearchProfitBridgeItems(db, saved.id).map((item) => ({
      key: item.item_key,
      label: item.label,
      amount: item.amount,
      unit: item.unit,
      methodology: item.methodology,
    })),
    formula: saved.formula,
    inputFactIds: JSON.parse(saved.input_fact_ids_json) as string[],
    evidenceIds: JSON.parse(saved.evidence_ids_json) as string[],
    createdBy: saved.created_by,
    version: saved.version,
    updatedAt: saved.updated_at,
  }
}
