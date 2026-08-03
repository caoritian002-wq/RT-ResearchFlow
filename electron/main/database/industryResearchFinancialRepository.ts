import type Database from 'better-sqlite3'
import type {
  IndustryResearchBusinessExposureRow,
  IndustryResearchCompanyStatus,
  IndustryResearchCompanyRow,
  IndustryResearchDerivationStatus,
  IndustryResearchDisclosureEvidenceRow,
  IndustryResearchExposureSource,
  IndustryResearchExposureStatus,
  IndustryResearchFinancialDataset,
  IndustryResearchFinancialFactKind,
  IndustryResearchFinancialFactRow,
  IndustryResearchFinancialSyncStateRow,
  IndustryResearchMainBusinessItemRow,
  IndustryResearchMasterDataSource,
  IndustryResearchProfitBridgeItemKey,
  IndustryResearchProfitBridgeItemRow,
  IndustryResearchProfitBridgeRow,
  IndustryResearchProfitBridgeStatus,
  IndustryResearchProjectCompanyRow,
  IndustryResearchSecurityRow,
} from './types'

export interface ResearchCompanyInput {
  id: string
  legalName: string
  shortName?: string | null
  unifiedCreditCode?: string | null
  registrationRegion?: string | null
  sourceType: IndustryResearchMasterDataSource
  sourceRef?: string | null
}

export interface ResearchSecurityInput {
  id: string
  companyId: string
  tsCode: string
  symbol?: string | null
  exchange: string
  securityType: string
  listStatus?: string | null
  listDate?: string | null
  delistDate?: string | null
  mappingSource: IndustryResearchMasterDataSource
  sourceRef?: string | null
}

export interface ResearchDisclosureEvidenceInput {
  id: string
  companyId: string
  projectId?: string | null
  title: string
  sourceUrl: string
  publishedDate?: string | null
  actualPublishedDate?: string | null
  excerpt?: string | null
  createdBy: 'human' | 'import'
  primarySourceConfirmed?: boolean
}

export interface ResearchMainBusinessItemInput {
  id: string
  companyId: string
  sourceApi: string
  sourceFactKey: string
  sourceVersion: string
  reportPeriod: string
  dimension: 'product' | 'region' | 'industry'
  itemCode?: string | null
  itemName: string
  revenue?: number | null
  cost?: number | null
  profit?: number | null
  currency?: string | null
  fetchedAt: number
}

export interface ResearchBusinessExposureInput {
  id: string
  projectId: string
  companyId: string
  researchNodeId?: string | null
  mainBusinessItemId?: string | null
  evidenceId?: string | null
  sourceKey: string
  sourceType: IndustryResearchExposureSource
  status: IndustryResearchExposureStatus
  exposurePct?: number | null
  basis: string
  createdBy: 'human' | 'import'
  factDate?: string | null
  evidenceIds?: string[]
  methodology?: string | null
}

export interface ResearchProjectCompanyInput {
  projectId: string
  companyId: string
  status: IndustryResearchCompanyStatus
  exclusionReason?: string | null
  evidenceIds?: string[]
}

export interface ResearchProfitBridgeItemInput {
  id: string
  key: IndustryResearchProfitBridgeItemKey
  label: string
  amount?: number | null
  unit?: string | null
  methodology?: string | null
  sortOrder: number
}

export interface ResearchProfitBridgeVersionInput {
  id: string
  projectId: string
  companyId: string
  bridgeKey: string
  basePeriod: string
  targetPeriod: string
  status: IndustryResearchProfitBridgeStatus
  formula?: string | null
  inputFactIds?: string[]
  evidenceIds?: string[]
  createdBy: 'human' | 'import'
  version: number
  previousVersionId?: string | null
  items: ResearchProfitBridgeItemInput[]
}

export interface ResearchFinancialFactInput {
  id: string
  companyId: string
  securityId?: string | null
  sourceApi: string
  sourceFactKey: string
  sourceVersion: string
  metricName: string
  metricValue?: number | null
  textValue?: string | null
  unit?: string | null
  currency?: string | null
  annDate?: string | null
  fAnnDate?: string | null
  reportPeriod: string
  statementType?: string | null
  companyType?: string | null
  updateFlag?: string | null
  factKind?: IndustryResearchFinancialFactKind
  derivationFormula?: string | null
  inputVersions?: string[]
  derivationStatus?: IndustryResearchDerivationStatus
  fetchedAt: number
}

function nowOr(value?: number): number {
  return value ?? Date.now()
}

export function saveResearchCompany(
  db: Database.Database,
  input: ResearchCompanyInput,
  now?: number,
): IndustryResearchCompanyRow {
  const timestamp = nowOr(now)
  db.prepare(`
    INSERT INTO industry_research_companies (
      id, legal_name, short_name, unified_credit_code, registration_region,
      source_type, source_ref, created_at, updated_at
    ) VALUES (
      @id, @legalName, @shortName, @unifiedCreditCode, @registrationRegion,
      @sourceType, @sourceRef, @createdAt, @updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      legal_name = excluded.legal_name,
      short_name = excluded.short_name,
      unified_credit_code = excluded.unified_credit_code,
      registration_region = excluded.registration_region,
      source_type = excluded.source_type,
      source_ref = excluded.source_ref,
      updated_at = excluded.updated_at
  `).run({
    ...input,
    shortName: input.shortName ?? null,
    unifiedCreditCode: input.unifiedCreditCode ?? null,
    registrationRegion: input.registrationRegion ?? null,
    sourceRef: input.sourceRef ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  return db.prepare('SELECT * FROM industry_research_companies WHERE id = ?')
    .get(input.id) as IndustryResearchCompanyRow
}

export function saveResearchSecurity(
  db: Database.Database,
  input: ResearchSecurityInput,
  now?: number,
): IndustryResearchSecurityRow {
  const timestamp = nowOr(now)
  db.prepare(`
    INSERT INTO industry_research_securities (
      id, company_id, ts_code, symbol, exchange, security_type, list_status,
      list_date, delist_date, mapping_source, source_ref, created_at, updated_at
    ) VALUES (
      @id, @companyId, @tsCode, @symbol, @exchange, @securityType, @listStatus,
      @listDate, @delistDate, @mappingSource, @sourceRef, @createdAt, @updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      company_id = excluded.company_id,
      ts_code = excluded.ts_code,
      symbol = excluded.symbol,
      exchange = excluded.exchange,
      security_type = excluded.security_type,
      list_status = excluded.list_status,
      list_date = excluded.list_date,
      delist_date = excluded.delist_date,
      mapping_source = excluded.mapping_source,
      source_ref = excluded.source_ref,
      updated_at = excluded.updated_at
  `).run({
    ...input,
    tsCode: input.tsCode.trim().toUpperCase(),
    symbol: input.symbol ?? null,
    listStatus: input.listStatus ?? null,
    listDate: input.listDate ?? null,
    delistDate: input.delistDate ?? null,
    sourceRef: input.sourceRef ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  return db.prepare('SELECT * FROM industry_research_securities WHERE id = ?')
    .get(input.id) as IndustryResearchSecurityRow
}

export function getResearchSecurityByTsCode(
  db: Database.Database,
  tsCode: string,
): IndustryResearchSecurityRow | null {
  return db.prepare(`
    SELECT * FROM industry_research_securities WHERE ts_code = ?
  `).get(tsCode.trim().toUpperCase()) as IndustryResearchSecurityRow | null
}

export function listResearchSecurities(
  db: Database.Database,
  companyId: string,
): IndustryResearchSecurityRow[] {
  return db.prepare(`
    SELECT * FROM industry_research_securities
    WHERE company_id = ? ORDER BY ts_code
  `).all(companyId) as IndustryResearchSecurityRow[]
}

export function saveResearchProjectCompany(
  db: Database.Database,
  input: ResearchProjectCompanyInput,
  now?: number,
): IndustryResearchProjectCompanyRow {
  const timestamp = nowOr(now)
  db.prepare(`
    INSERT INTO industry_research_project_companies (
      project_id, company_id, status, exclusion_reason, evidence_ids_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, company_id) DO UPDATE SET
      status = excluded.status,
      exclusion_reason = excluded.exclusion_reason,
      evidence_ids_json = excluded.evidence_ids_json,
      updated_at = excluded.updated_at
  `).run(
    input.projectId,
    input.companyId,
    input.status,
    input.exclusionReason ?? null,
    JSON.stringify(input.evidenceIds ?? []),
    timestamp,
    timestamp,
  )
  return db.prepare(`
    SELECT * FROM industry_research_project_companies WHERE project_id = ? AND company_id = ?
  `).get(input.projectId, input.companyId) as IndustryResearchProjectCompanyRow
}

export function getResearchProjectCompany(
  db: Database.Database,
  projectId: string,
  companyId: string,
): IndustryResearchProjectCompanyRow | null {
  return db.prepare(`
    SELECT * FROM industry_research_project_companies WHERE project_id = ? AND company_id = ?
  `).get(projectId, companyId) as IndustryResearchProjectCompanyRow | null
}

export function listResearchProjectCompanies(
  db: Database.Database,
  projectId: string,
): Array<IndustryResearchProjectCompanyRow & IndustryResearchCompanyRow> {
  return db.prepare(`
    SELECT pc.*, c.legal_name, c.short_name, c.unified_credit_code, c.registration_region,
      c.source_type, c.source_ref
    FROM industry_research_project_companies pc
    JOIN industry_research_companies c ON c.id = pc.company_id
    WHERE pc.project_id = ?
    ORDER BY pc.updated_at DESC, c.legal_name
  `).all(projectId) as Array<IndustryResearchProjectCompanyRow & IndustryResearchCompanyRow>
}

export function listResearchProjectStockCodes(
  db: Database.Database,
  projectId: string,
  limit = 5,
): string[] {
  const boundedLimit = Number.isInteger(limit) ? Math.min(20, Math.max(1, limit)) : 5
  const rows = db.prepare(`
    SELECT s.ts_code
    FROM industry_research_project_companies pc
    JOIN industry_research_securities s ON s.company_id = pc.company_id
    WHERE pc.project_id = ?
      AND pc.status <> 'excluded'
      AND s.security_type IN ('stock', 'A_SHARE')
    ORDER BY
      CASE pc.status WHEN 'core' THEN 0 WHEN 'watching' THEN 1 ELSE 2 END,
      s.ts_code
    LIMIT ?
  `).all(projectId, boundedLimit) as Array<{ ts_code: string }>
  return rows.map((row) => row.ts_code)
}

export function saveResearchDisclosureEvidence(
  db: Database.Database,
  input: ResearchDisclosureEvidenceInput,
  now?: number,
): IndustryResearchDisclosureEvidenceRow {
  const timestamp = nowOr(now)
  db.prepare(`
    INSERT INTO industry_research_disclosure_evidence (
      id, company_id, project_id, title, source_url, published_date,
      actual_published_date, excerpt, created_by, primary_source_confirmed,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.companyId,
    input.projectId ?? null,
    input.title,
    input.sourceUrl,
    input.publishedDate ?? null,
    input.actualPublishedDate ?? null,
    input.excerpt ?? null,
    input.createdBy,
    input.primarySourceConfirmed ? 1 : 0,
    timestamp,
    timestamp,
  )
  return db.prepare('SELECT * FROM industry_research_disclosure_evidence WHERE id = ?')
    .get(input.id) as IndustryResearchDisclosureEvidenceRow
}

export function listResearchDisclosureEvidence(
  db: Database.Database,
  projectId: string,
  companyId: string,
): IndustryResearchDisclosureEvidenceRow[] {
  return db.prepare(`
    SELECT * FROM industry_research_disclosure_evidence
    WHERE company_id = ? AND (project_id IS NULL OR project_id = ?)
    ORDER BY actual_published_date DESC, published_date DESC, updated_at DESC
  `).all(companyId, projectId) as IndustryResearchDisclosureEvidenceRow[]
}

export function saveResearchMainBusinessItem(
  db: Database.Database,
  input: ResearchMainBusinessItemInput,
  now?: number,
): IndustryResearchMainBusinessItemRow {
  const timestamp = nowOr(now)
  db.prepare(`
    INSERT INTO industry_research_main_business_items (
      id, company_id, source_api, source_fact_key, source_version, report_period,
      dimension, item_code, item_name, revenue, cost, profit, currency, fetched_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_api, source_fact_key, source_version) DO NOTHING
  `).run(
    input.id,
    input.companyId,
    input.sourceApi,
    input.sourceFactKey,
    input.sourceVersion,
    input.reportPeriod,
    input.dimension,
    input.itemCode ?? null,
    input.itemName,
    input.revenue ?? null,
    input.cost ?? null,
    input.profit ?? null,
    input.currency ?? null,
    input.fetchedAt,
    timestamp,
  )
  return db.prepare(`
    SELECT * FROM industry_research_main_business_items
    WHERE source_api = ? AND source_fact_key = ? AND source_version = ?
  `).get(input.sourceApi, input.sourceFactKey, input.sourceVersion) as IndustryResearchMainBusinessItemRow
}

export function saveResearchBusinessExposure(
  db: Database.Database,
  input: ResearchBusinessExposureInput,
  now?: number,
): IndustryResearchBusinessExposureRow {
  const existing = db.prepare(`
    SELECT * FROM industry_research_business_exposures
    WHERE project_id = ? AND source_type = ? AND source_key = ?
  `).get(input.projectId, input.sourceType, input.sourceKey) as IndustryResearchBusinessExposureRow | undefined
  const isProtected = existing && existing.created_by === 'human'
    && existing.status !== 'candidate'
  if (isProtected && input.createdBy !== 'human') throw new Error('MANUAL_EXPOSURE_PROTECTED')
  if (input.sourceType === 'fina_mainbz' && input.status !== 'candidate') {
    throw new Error('AUTO_EXPOSURE_MUST_BE_CANDIDATE')
  }
  if (input.status === 'confirmed') {
    if (!input.evidenceId) throw new Error('CONFIRMED_EXPOSURE_REQUIRES_EVIDENCE')
    const evidence = db.prepare(`
      SELECT company_id, created_by, primary_source_confirmed
      FROM industry_research_disclosure_evidence WHERE id = ?
    `).get(input.evidenceId) as {
      company_id: string
      created_by: 'human' | 'import'
      primary_source_confirmed: number
    } | undefined
    if (!evidence || evidence.company_id !== input.companyId
      || evidence.created_by !== 'human' || evidence.primary_source_confirmed !== 1) {
      throw new Error('CONFIRMED_EXPOSURE_REQUIRES_PRIMARY_SOURCE')
    }
  }
  const timestamp = nowOr(now)
  db.prepare(`
    INSERT INTO industry_research_business_exposures (
      id, project_id, company_id, research_node_id, main_business_item_id,
      evidence_id, source_key, source_type, status, exposure_pct, basis,
      created_by, fact_date, evidence_ids_json, methodology, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, source_type, source_key) DO UPDATE SET
      company_id = excluded.company_id,
      research_node_id = excluded.research_node_id,
      main_business_item_id = excluded.main_business_item_id,
      evidence_id = excluded.evidence_id,
      status = excluded.status,
      exposure_pct = excluded.exposure_pct,
      basis = excluded.basis,
      created_by = excluded.created_by,
      fact_date = excluded.fact_date,
      evidence_ids_json = excluded.evidence_ids_json,
      methodology = excluded.methodology,
      updated_at = excluded.updated_at
  `).run(
    input.id,
    input.projectId,
    input.companyId,
    input.researchNodeId ?? null,
    input.mainBusinessItemId ?? null,
    input.evidenceId ?? null,
    input.sourceKey,
    input.sourceType,
    input.status,
    input.exposurePct ?? null,
    input.basis,
    input.createdBy,
    input.factDate ?? null,
    JSON.stringify(input.evidenceIds ?? (input.evidenceId ? [input.evidenceId] : [])),
    input.methodology ?? null,
    timestamp,
    timestamp,
  )
  return db.prepare(`
    SELECT * FROM industry_research_business_exposures
    WHERE project_id = ? AND source_type = ? AND source_key = ?
  `).get(input.projectId, input.sourceType, input.sourceKey) as IndustryResearchBusinessExposureRow
}

export function listResearchBusinessExposures(
  db: Database.Database,
  projectId: string,
  companyId?: string,
): Array<IndustryResearchBusinessExposureRow & {
  main_business_item_name: string | null
  main_business_report_period: string | null
  main_business_revenue: number | null
  main_business_cost: number | null
  main_business_profit: number | null
  main_business_currency: string | null
  main_business_source_api: string | null
}> {
  return db.prepare(`
    SELECT
      exposure.*,
      item.item_name AS main_business_item_name,
      item.report_period AS main_business_report_period,
      item.revenue AS main_business_revenue,
      item.cost AS main_business_cost,
      item.profit AS main_business_profit,
      item.currency AS main_business_currency,
      item.source_api AS main_business_source_api
    FROM industry_research_business_exposures exposure
    LEFT JOIN industry_research_main_business_items item
      ON item.id = exposure.main_business_item_id
    WHERE exposure.project_id = @projectId
      AND (@companyId IS NULL OR exposure.company_id = @companyId)
    ORDER BY exposure.updated_at DESC, exposure.id
  `).all({ projectId, companyId: companyId ?? null }) as Array<IndustryResearchBusinessExposureRow & {
    main_business_item_name: string | null
    main_business_report_period: string | null
    main_business_revenue: number | null
    main_business_cost: number | null
    main_business_profit: number | null
    main_business_currency: string | null
    main_business_source_api: string | null
  }>
}

export function saveResearchFinancialFacts(
  db: Database.Database,
  inputs: ResearchFinancialFactInput[],
  now?: number,
): IndustryResearchFinancialFactRow[] {
  const timestamp = nowOr(now)
  const insert = db.prepare(`
    INSERT INTO industry_research_financial_facts (
      id, company_id, security_id, source_api, source_fact_key, source_version,
      metric_name, metric_value, text_value, unit, currency, ann_date, f_ann_date,
      report_period, statement_type, company_type, update_flag, fact_kind,
      derivation_formula, input_versions_json, derivation_status, fetched_at, created_at
    ) VALUES (
      @id, @companyId, @securityId, @sourceApi, @sourceFactKey, @sourceVersion,
      @metricName, @metricValue, @textValue, @unit, @currency, @annDate, @fAnnDate,
      @reportPeriod, @statementType, @companyType, @updateFlag, @factKind,
      @derivationFormula, @inputVersionsJson, @derivationStatus, @fetchedAt, @createdAt
    )
    ON CONFLICT(source_api, source_fact_key, source_version, metric_name) DO NOTHING
  `)
  const saveAll = db.transaction(() => {
    for (const input of inputs) {
      const factKind = input.factKind ?? 'reported'
      const derivationStatus = input.derivationStatus
        ?? (factKind === 'reported' ? 'not_applicable' : 'blocked')
      if (factKind === 'derived' && (!input.derivationFormula || !input.inputVersions?.length)) {
        throw new Error('DERIVED_FACT_REQUIRES_PROVENANCE')
      }
      insert.run({
        ...input,
        securityId: input.securityId ?? null,
        metricValue: input.metricValue ?? null,
        textValue: input.textValue ?? null,
        unit: input.unit ?? null,
        currency: input.currency ?? null,
        annDate: input.annDate ?? null,
        fAnnDate: input.fAnnDate ?? null,
        statementType: input.statementType ?? null,
        companyType: input.companyType ?? null,
        updateFlag: input.updateFlag ?? null,
        factKind,
        derivationFormula: input.derivationFormula ?? null,
        inputVersionsJson: JSON.stringify(input.inputVersions ?? []),
        derivationStatus,
        createdAt: timestamp,
      })
    }
  })
  saveAll()
  return inputs.map((input) => db.prepare(`
    SELECT * FROM industry_research_financial_facts
    WHERE source_api = ? AND source_fact_key = ? AND source_version = ? AND metric_name = ?
  `).get(input.sourceApi, input.sourceFactKey, input.sourceVersion, input.metricName) as IndustryResearchFinancialFactRow)
}

export function listResearchFinancialFacts(
  db: Database.Database,
  companyId: string,
): IndustryResearchFinancialFactRow[] {
  return db.prepare(`
    SELECT * FROM industry_research_financial_facts
    WHERE company_id = ?
    ORDER BY COALESCE(f_ann_date, ann_date, report_period) DESC, source_api, source_version, metric_name
  `).all(companyId) as IndustryResearchFinancialFactRow[]
}

export function listResearchFinancialTimelineFacts(
  db: Database.Database,
  input: {
    companyId: string
    securityId?: string
    datasets?: IndustryResearchFinancialDataset[]
    fromAnnouncementDate?: string
    toAnnouncementDate?: string
  },
): Array<IndustryResearchFinancialFactRow & { ts_code: string | null }> {
  const datasets = input.datasets ?? []
  const placeholders = datasets.map(() => '?').join(', ')
  const params: unknown[] = [input.companyId, input.securityId ?? null]
  let datasetFilter = ''
  if (datasets.length > 0) {
    datasetFilter = `AND f.source_api IN (${placeholders})`
    params.push(...datasets)
  }
  params.push(input.fromAnnouncementDate ?? null, input.toAnnouncementDate ?? null)
  return db.prepare(`
    SELECT f.*, s.ts_code
    FROM industry_research_financial_facts f
    LEFT JOIN industry_research_securities s ON s.id = f.security_id
    WHERE f.company_id = ?
      AND (? IS NULL OR f.security_id = ?)
      ${datasetFilter}
      AND (? IS NULL OR COALESCE(f.f_ann_date, f.ann_date) >= ?)
      AND (? IS NULL OR COALESCE(f.f_ann_date, f.ann_date) <= ?)
    ORDER BY COALESCE(f.f_ann_date, f.ann_date, f.report_period) DESC,
      f.report_period DESC, f.source_api, f.source_version, f.metric_name
  `).all([
    params[0], params[1], params[1],
    ...params.slice(2, 2 + datasets.length),
    params[2 + datasets.length], params[2 + datasets.length],
    params[3 + datasets.length], params[3 + datasets.length],
  ]) as Array<IndustryResearchFinancialFactRow & { ts_code: string | null }>
}

export function listResearchFinancialSyncStates(
  db: Database.Database,
  companyId: string,
): IndustryResearchFinancialSyncStateRow[] {
  return db.prepare(`
    SELECT * FROM industry_research_financial_sync_state
    WHERE company_id = ? ORDER BY dataset
  `).all(companyId) as IndustryResearchFinancialSyncStateRow[]
}

export function recordResearchFinancialSyncStarted(
  db: Database.Database,
  companyId: string,
  dataset: IndustryResearchFinancialDataset,
  attemptedAt = Date.now(),
): IndustryResearchFinancialSyncStateRow {
  db.prepare(`
    INSERT INTO industry_research_financial_sync_state (
      company_id, dataset, status, last_attempt_at, last_success_at, last_error_code,
      last_success_fact_date, last_success_row_count, updated_at
    ) VALUES (?, ?, 'running', ?, NULL, NULL, NULL, NULL, ?)
    ON CONFLICT(company_id, dataset) DO UPDATE SET
      status = 'running',
      last_attempt_at = excluded.last_attempt_at,
      last_error_code = NULL,
      updated_at = excluded.updated_at
  `).run(companyId, dataset, attemptedAt, attemptedAt)
  return getResearchFinancialSyncState(db, companyId, dataset)!
}

export function getLatestResearchProfitBridge(
  db: Database.Database,
  projectId: string,
  companyId: string,
  bridgeKey: string,
): IndustryResearchProfitBridgeRow | null {
  return (db.prepare(`
    SELECT * FROM industry_research_profit_bridges
    WHERE project_id = ? AND company_id = ? AND bridge_key = ?
    ORDER BY version DESC LIMIT 1
  `).get(projectId, companyId, bridgeKey) as IndustryResearchProfitBridgeRow | undefined) ?? null
}

export function listResearchProfitBridgeItems(
  db: Database.Database,
  profitBridgeId: string,
): IndustryResearchProfitBridgeItemRow[] {
  return db.prepare(`
    SELECT * FROM industry_research_profit_bridge_items
    WHERE profit_bridge_id = ? ORDER BY sort_order, item_key
  `).all(profitBridgeId) as IndustryResearchProfitBridgeItemRow[]
}

export function saveResearchProfitBridgeVersion(
  db: Database.Database,
  input: ResearchProfitBridgeVersionInput,
  now?: number,
): IndustryResearchProfitBridgeRow {
  const timestamp = nowOr(now)
  const save = db.transaction(() => {
    db.prepare(`
      INSERT INTO industry_research_profit_bridges (
        id, project_id, company_id, bridge_key, base_period, target_period, status,
        formula, input_fact_ids_json, evidence_ids_json, created_by, version,
        previous_version_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.projectId, input.companyId, input.bridgeKey, input.basePeriod,
      input.targetPeriod, input.status, input.formula ?? null,
      JSON.stringify(input.inputFactIds ?? []), JSON.stringify(input.evidenceIds ?? []),
      input.createdBy, input.version, input.previousVersionId ?? null, timestamp, timestamp,
    )
    const insertItem = db.prepare(`
      INSERT INTO industry_research_profit_bridge_items (
        id, profit_bridge_id, item_key, label, amount, unit, methodology, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const item of input.items) {
      insertItem.run(
        item.id, input.id, item.key, item.label, item.amount ?? null,
        item.unit ?? null, item.methodology ?? null, item.sortOrder,
      )
    }
  })
  save()
  return db.prepare('SELECT * FROM industry_research_profit_bridges WHERE id = ?')
    .get(input.id) as IndustryResearchProfitBridgeRow
}

export function recordResearchFinancialSyncSuccess(
  db: Database.Database,
  companyId: string,
  dataset: IndustryResearchFinancialDataset,
  factDate: string | null,
  rowCount: number,
  completedAt = Date.now(),
): IndustryResearchFinancialSyncStateRow {
  db.prepare(`
    INSERT INTO industry_research_financial_sync_state (
      company_id, dataset, status, last_attempt_at, last_success_at, last_error_code,
      last_success_fact_date, last_success_row_count, updated_at
    ) VALUES (?, ?, 'success', ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(company_id, dataset) DO UPDATE SET
      status = 'success',
      last_attempt_at = excluded.last_attempt_at,
      last_success_at = excluded.last_success_at,
      last_error_code = NULL,
      last_success_fact_date = excluded.last_success_fact_date,
      last_success_row_count = excluded.last_success_row_count,
      updated_at = excluded.updated_at
  `).run(companyId, dataset, completedAt, completedAt, factDate, rowCount, completedAt)
  return getResearchFinancialSyncState(db, companyId, dataset)!
}

export function recordResearchFinancialSyncFailure(
  db: Database.Database,
  companyId: string,
  dataset: IndustryResearchFinancialDataset,
  errorCode: string,
  attemptedAt = Date.now(),
): IndustryResearchFinancialSyncStateRow {
  db.prepare(`
    INSERT INTO industry_research_financial_sync_state (
      company_id, dataset, status, last_attempt_at, last_success_at, last_error_code,
      last_success_fact_date, last_success_row_count, updated_at
    ) VALUES (?, ?, 'failed', ?, NULL, ?, NULL, NULL, ?)
    ON CONFLICT(company_id, dataset) DO UPDATE SET
      status = 'failed',
      last_attempt_at = excluded.last_attempt_at,
      last_error_code = excluded.last_error_code,
      updated_at = excluded.updated_at
  `).run(companyId, dataset, attemptedAt, errorCode, attemptedAt)
  return getResearchFinancialSyncState(db, companyId, dataset)!
}

export function getResearchFinancialSyncState(
  db: Database.Database,
  companyId: string,
  dataset: IndustryResearchFinancialDataset,
): IndustryResearchFinancialSyncStateRow | null {
  return (db.prepare(`
    SELECT * FROM industry_research_financial_sync_state
    WHERE company_id = ? AND dataset = ?
  `).get(companyId, dataset) as IndustryResearchFinancialSyncStateRow | undefined) ?? null
}
