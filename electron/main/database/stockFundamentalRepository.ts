import type Database from 'better-sqlite3'

export type StockFundamentalDataset = 'profile' | 'financial' | 'announcement'
export type StockFundamentalSourceStatus = 'available' | 'missing' | 'failed'

export interface StockFundamentalProfile {
  tsCode: string
  stockCode: string
  shortName: string | null
  legalName: string | null
  securityType: string | null
  tradeMarket: string | null
  industry: string | null
  chairman: string | null
  legalRepresentative: string | null
  website: string | null
  officeAddress: string | null
  registeredCapitalWan: number | null
  employeeCount: number | null
  businessScope: string | null
  companyProfile: string | null
  source: 'eastmoney-company-survey'
  sourceFactDate: string | null
  fetchedAt: number
}

export interface StockFundamentalFinancial {
  tsCode: string
  stockCode: string
  shortName: string | null
  reportDate: string
  reportType: string | null
  noticeDate: string | null
  updateDate: string | null
  currency: string | null
  totalRevenue: number | null
  parentNetProfit: number | null
  deductedNetProfit: number | null
  revenueYoy: number | null
  parentNetProfitYoy: number | null
  deductedNetProfitYoy: number | null
  weightedRoe: number | null
  grossMargin: number | null
  netMargin: number | null
  debtRatio: number | null
  operatingCashFlow: number | null
  basicEps: number | null
  bookValuePerShare: number | null
  source: 'eastmoney-main-finance'
  sourceVersion: string
  fetchedAt: number
}

export interface StockFundamentalAnnouncementRecord {
  tsCode: string
  stockCode: string
  shortName: string | null
  articleCode: string
  title: string
  noticeDate: string
  displayAt: number | null
  categoryCodes: string[]
  categoryNames: string[]
  source: 'eastmoney-announcement-index'
  sourceUrl: string
  fetchedAt: number
}

export interface StockFundamentalSourceState {
  status: StockFundamentalSourceStatus
  lastAttemptAt: number | null
  lastSuccessAt: number | null
  factDate: string | null
  errorCode: string | null
  rowsWritten: number
}

interface ProfileDbRow {
  ts_code: string
  stock_code: string
  short_name: string | null
  legal_name: string | null
  security_type: string | null
  trade_market: string | null
  industry: string | null
  chairman: string | null
  legal_representative: string | null
  website: string | null
  office_address: string | null
  registered_capital_wan: number | null
  employee_count: number | null
  business_scope: string | null
  company_profile: string | null
  source: 'eastmoney-company-survey'
  source_fact_date: string | null
  fetched_at: number
}

interface FinancialDbRow {
  ts_code: string
  stock_code: string
  short_name: string | null
  report_date: string
  report_type: string | null
  notice_date: string | null
  update_date: string | null
  currency: string | null
  total_revenue: number | null
  parent_net_profit: number | null
  deducted_net_profit: number | null
  revenue_yoy: number | null
  parent_net_profit_yoy: number | null
  deducted_net_profit_yoy: number | null
  weighted_roe: number | null
  gross_margin: number | null
  net_margin: number | null
  debt_ratio: number | null
  operating_cash_flow: number | null
  basic_eps: number | null
  book_value_per_share: number | null
  source: 'eastmoney-main-finance'
  source_version: string
  fetched_at: number
}

interface SyncDbRow {
  status: 'available' | 'failed'
  last_attempt_at: number
  last_success_at: number | null
  fact_date: string | null
  last_error_code: string | null
  rows_written: number
}

interface AnnouncementDbRow {
  ts_code: string
  stock_code: string
  short_name: string | null
  article_code: string
  title: string
  notice_date: string
  display_at: number | null
  category_codes_json: string
  category_names_json: string
  source: 'eastmoney-announcement-index'
  source_url: string
  fetched_at: number
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function fromProfileRow(row: ProfileDbRow): StockFundamentalProfile {
  return {
    tsCode: row.ts_code,
    stockCode: row.stock_code,
    shortName: row.short_name,
    legalName: row.legal_name,
    securityType: row.security_type,
    tradeMarket: row.trade_market,
    industry: row.industry,
    chairman: row.chairman,
    legalRepresentative: row.legal_representative,
    website: row.website,
    officeAddress: row.office_address,
    registeredCapitalWan: row.registered_capital_wan,
    employeeCount: row.employee_count,
    businessScope: row.business_scope,
    companyProfile: row.company_profile,
    source: row.source,
    sourceFactDate: row.source_fact_date,
    fetchedAt: row.fetched_at,
  }
}

function fromFinancialRow(row: FinancialDbRow): StockFundamentalFinancial {
  return {
    tsCode: row.ts_code,
    stockCode: row.stock_code,
    shortName: row.short_name,
    reportDate: row.report_date,
    reportType: row.report_type,
    noticeDate: row.notice_date,
    updateDate: row.update_date,
    currency: row.currency,
    totalRevenue: row.total_revenue,
    parentNetProfit: row.parent_net_profit,
    deductedNetProfit: row.deducted_net_profit,
    revenueYoy: row.revenue_yoy,
    parentNetProfitYoy: row.parent_net_profit_yoy,
    deductedNetProfitYoy: row.deducted_net_profit_yoy,
    weightedRoe: row.weighted_roe,
    grossMargin: row.gross_margin,
    netMargin: row.net_margin,
    debtRatio: row.debt_ratio,
    operatingCashFlow: row.operating_cash_flow,
    basicEps: row.basic_eps,
    bookValuePerShare: row.book_value_per_share,
    source: row.source,
    sourceVersion: row.source_version,
    fetchedAt: row.fetched_at,
  }
}

function fromAnnouncementRow(row: AnnouncementDbRow): StockFundamentalAnnouncementRecord {
  return {
    tsCode: row.ts_code,
    stockCode: row.stock_code,
    shortName: row.short_name,
    articleCode: row.article_code,
    title: row.title,
    noticeDate: row.notice_date,
    displayAt: row.display_at,
    categoryCodes: parseStringArray(row.category_codes_json),
    categoryNames: parseStringArray(row.category_names_json),
    source: row.source,
    sourceUrl: row.source_url,
    fetchedAt: row.fetched_at,
  }
}

export function upsertStockFundamentalProfile(
  db: Database.Database,
  profile: StockFundamentalProfile,
): void {
  db.prepare(`
    INSERT INTO stock_fundamental_profiles (
      ts_code, stock_code, short_name, legal_name, security_type, trade_market,
      industry, chairman, legal_representative, website, office_address,
      registered_capital_wan, employee_count, business_scope, company_profile,
      source, source_fact_date, fetched_at
    ) VALUES (
      @tsCode, @stockCode, @shortName, @legalName, @securityType, @tradeMarket,
      @industry, @chairman, @legalRepresentative, @website, @officeAddress,
      @registeredCapitalWan, @employeeCount, @businessScope, @companyProfile,
      @source, @sourceFactDate, @fetchedAt
    )
    ON CONFLICT(ts_code) DO UPDATE SET
      stock_code = excluded.stock_code,
      short_name = excluded.short_name,
      legal_name = excluded.legal_name,
      security_type = excluded.security_type,
      trade_market = excluded.trade_market,
      industry = excluded.industry,
      chairman = excluded.chairman,
      legal_representative = excluded.legal_representative,
      website = excluded.website,
      office_address = excluded.office_address,
      registered_capital_wan = excluded.registered_capital_wan,
      employee_count = excluded.employee_count,
      business_scope = excluded.business_scope,
      company_profile = excluded.company_profile,
      source = excluded.source,
      source_fact_date = excluded.source_fact_date,
      fetched_at = excluded.fetched_at
  `).run(profile)
}

export function saveStockFundamentalFinancials(
  db: Database.Database,
  rows: StockFundamentalFinancial[],
): number {
  if (rows.length === 0) return 0
  const statement = db.prepare(`
    INSERT INTO stock_fundamental_financials (
      ts_code, stock_code, short_name, report_date, report_type, notice_date,
      update_date, currency, total_revenue, parent_net_profit, deducted_net_profit,
      revenue_yoy, parent_net_profit_yoy, deducted_net_profit_yoy, weighted_roe,
      gross_margin, net_margin, debt_ratio, operating_cash_flow, basic_eps,
      book_value_per_share, source, source_version, fetched_at
    ) VALUES (
      @tsCode, @stockCode, @shortName, @reportDate, @reportType, @noticeDate,
      @updateDate, @currency, @totalRevenue, @parentNetProfit, @deductedNetProfit,
      @revenueYoy, @parentNetProfitYoy, @deductedNetProfitYoy, @weightedRoe,
      @grossMargin, @netMargin, @debtRatio, @operatingCashFlow, @basicEps,
      @bookValuePerShare, @source, @sourceVersion, @fetchedAt
    )
    ON CONFLICT(ts_code, report_date, source_version) DO UPDATE SET
      fetched_at = excluded.fetched_at
  `)
  return db.transaction((items: StockFundamentalFinancial[]) => {
    let changed = 0
    for (const item of items) changed += statement.run(item).changes
    return changed
  })(rows)
}

export function getStockFundamentalProfile(
  db: Database.Database,
  tsCode: string,
): StockFundamentalProfile | null {
  const row = db.prepare('SELECT * FROM stock_fundamental_profiles WHERE ts_code = ?')
    .get(tsCode) as ProfileDbRow | undefined
  return row ? fromProfileRow(row) : null
}

export function listLatestStockFundamentalFinancials(
  db: Database.Database,
  tsCode: string,
  limit = 8,
): StockFundamentalFinancial[] {
  const rows = db.prepare(`
    SELECT * FROM stock_fundamental_financials
    WHERE ts_code = ?
    ORDER BY report_date DESC, COALESCE(update_date, '') DESC,
      COALESCE(notice_date, '') DESC, fetched_at DESC, source_version DESC
  `).all(tsCode) as FinancialDbRow[]
  const result: StockFundamentalFinancial[] = []
  const seenPeriods = new Set<string>()
  for (const row of rows) {
    if (seenPeriods.has(row.report_date)) continue
    seenPeriods.add(row.report_date)
    result.push(fromFinancialRow(row))
    if (result.length >= limit) break
  }
  return result
}

export function replaceStockFundamentalAnnouncements(
  db: Database.Database,
  tsCode: string,
  rows: StockFundamentalAnnouncementRecord[],
): number {
  const statement = db.prepare(`
    INSERT INTO stock_fundamental_announcements (
      ts_code, stock_code, short_name, article_code, title, notice_date,
      display_at, category_codes_json, category_names_json, source,
      source_url, fetched_at
    ) VALUES (
      @tsCode, @stockCode, @shortName, @articleCode, @title, @noticeDate,
      @displayAt, @categoryCodesJson, @categoryNamesJson, @source,
      @sourceUrl, @fetchedAt
    )
  `)
  return db.transaction((items: StockFundamentalAnnouncementRecord[]) => {
    db.prepare('DELETE FROM stock_fundamental_announcements WHERE ts_code = ?').run(tsCode)
    let changed = 0
    for (const item of items) {
      changed += statement.run({
        ...item,
        categoryCodesJson: JSON.stringify(item.categoryCodes),
        categoryNamesJson: JSON.stringify(item.categoryNames),
      }).changes
    }
    return changed
  })(rows)
}

export function listLatestStockFundamentalAnnouncements(
  db: Database.Database,
  tsCode: string,
  limit = 30,
): StockFundamentalAnnouncementRecord[] {
  const safeLimit = Math.max(1, Math.min(30, Math.trunc(limit)))
  return (db.prepare(`
    SELECT * FROM stock_fundamental_announcements
    WHERE ts_code = ?
    ORDER BY notice_date DESC, COALESCE(display_at, 0) DESC, article_code DESC
    LIMIT ?
  `).all(tsCode, safeLimit) as AnnouncementDbRow[]).map(fromAnnouncementRow)
}

export function recordStockFundamentalSyncSuccess(
  db: Database.Database,
  tsCode: string,
  dataset: StockFundamentalDataset,
  attemptedAt: number,
  factDate: string | null,
  rowsWritten: number,
): void {
  db.prepare(`
    INSERT INTO stock_fundamental_sync_state (
      ts_code, dataset, status, last_attempt_at, last_success_at,
      fact_date, last_error_code, rows_written
    ) VALUES (?, ?, 'available', ?, ?, ?, NULL, ?)
    ON CONFLICT(ts_code, dataset) DO UPDATE SET
      status = 'available',
      last_attempt_at = excluded.last_attempt_at,
      last_success_at = excluded.last_success_at,
      fact_date = excluded.fact_date,
      last_error_code = NULL,
      rows_written = excluded.rows_written
  `).run(tsCode, dataset, attemptedAt, attemptedAt, factDate, rowsWritten)
}

export function recordStockFundamentalSyncFailure(
  db: Database.Database,
  tsCode: string,
  dataset: StockFundamentalDataset,
  attemptedAt: number,
  errorCode: string,
): void {
  db.prepare(`
    INSERT INTO stock_fundamental_sync_state (
      ts_code, dataset, status, last_attempt_at, last_success_at,
      fact_date, last_error_code, rows_written
    ) VALUES (?, ?, 'failed', ?, NULL, NULL, ?, 0)
    ON CONFLICT(ts_code, dataset) DO UPDATE SET
      status = 'failed',
      last_attempt_at = excluded.last_attempt_at,
      last_error_code = excluded.last_error_code,
      rows_written = 0
  `).run(tsCode, dataset, attemptedAt, errorCode)
}

export function getStockFundamentalSourceState(
  db: Database.Database,
  tsCode: string,
  dataset: StockFundamentalDataset,
  hasFacts: boolean,
  factDate: string | null,
): StockFundamentalSourceState {
  const row = db.prepare(`
    SELECT status, last_attempt_at, last_success_at, fact_date,
      last_error_code, rows_written
    FROM stock_fundamental_sync_state
    WHERE ts_code = ? AND dataset = ?
  `).get(tsCode, dataset) as SyncDbRow | undefined
  return {
    status: row?.status === 'failed'
      ? 'failed'
      : hasFacts || row?.status === 'available'
        ? 'available'
        : 'missing',
    lastAttemptAt: row?.last_attempt_at ?? null,
    lastSuccessAt: row?.last_success_at ?? null,
    factDate: factDate ?? row?.fact_date ?? null,
    errorCode: row?.last_error_code ?? null,
    rowsWritten: row?.rows_written ?? 0,
  }
}
