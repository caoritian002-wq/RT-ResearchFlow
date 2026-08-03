import type Database from 'better-sqlite3'
import type {
  ChipInstitutionEvidence,
  ChipInstitutionRecord,
  TopInstDailyRow,
  TopInstSyncCoverageRow,
} from '../database/types'
import {
  getTopInstByStockAndDate,
  getTopInstCoverage,
  recordTopInstSyncFailure,
  replaceTopInstForTradeDate,
} from '../database/topInstDailyRepository'
import { fetchTopInst } from './tushareService'

const EVIDENCE_LIMITATION = '机构席位记录来自龙虎榜公开披露，仅代表上榜席位行为，不代表全部机构交易，也不参与筹码身份比例计算。'

function finiteOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null
}

function normalizeText(value: string | null | undefined): string {
  return value?.trim().replace(/\s+/g, ' ') ?? ''
}

function numberKey(value: number | null | undefined): string {
  const normalized = finiteOrNull(value)
  return normalized == null ? '' : String(normalized)
}

function recordKey(row: TopInstDailyRow): string {
  return [
    normalizeText(row.exalter),
    normalizeText(row.reason),
    numberKey(row.buy),
    numberKey(row.sell),
    numberKey(row.netBuy),
    numberKey(row.buyRate),
    numberKey(row.sellRate),
  ].join('\u0000')
}

function toRecord(row: TopInstDailyRow): ChipInstitutionRecord {
  return {
    institutionName: normalizeText(row.exalter),
    buyAmount: finiteOrNull(row.buy),
    sellAmount: finiteOrNull(row.sell),
    netAmount: finiteOrNull(row.netBuy),
    buyRate: finiteOrNull(row.buyRate),
    sellRate: finiteOrNull(row.sellRate),
    reason: normalizeText(row.reason) || null,
  }
}

function sumNullable(
  records: ChipInstitutionRecord[],
  selector: (record: ChipInstitutionRecord) => number | null,
): number | null {
  const values = records.map(selector).filter((value): value is number => value != null)
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null
}

export function buildChipInstitutionEvidence(
  tradeDate: string | null,
  rows: TopInstDailyRow[],
  coverage: TopInstSyncCoverageRow | null,
): ChipInstitutionEvidence {
  const uniqueRows = new Map<string, TopInstDailyRow>()
  for (const row of rows) {
    const key = recordKey(row)
    if (!uniqueRows.has(key)) uniqueRows.set(key, row)
  }
  const records = [...uniqueRows.values()].map(toRecord)
  const coverageStatus = records.length > 0
    ? 'available'
    : coverage?.status === 'success'
      ? 'no_record'
      : coverage?.status === 'failed'
        ? 'failed'
        : 'not_synced'
  const institutionCount = new Set(
    records.map((record) => record.institutionName).filter(Boolean),
  ).size
  const fetchedAt = rows.reduce<number | null>((latest, row) => (
    latest == null || row.fetchedAt > latest ? row.fetchedAt : latest
  ), null)

  return {
    tradeDate,
    coverageStatus,
    buyAmount: records.length > 0 ? sumNullable(records, (record) => record.buyAmount) : null,
    sellAmount: records.length > 0 ? sumNullable(records, (record) => record.sellAmount) : null,
    netAmount: records.length > 0 ? sumNullable(records, (record) => record.netAmount) : null,
    institutionCount,
    records,
    limitation: EVIDENCE_LIMITATION,
    updatedAt: fetchedAt ?? coverage?.completedAt ?? coverage?.attemptedAt ?? null,
  }
}

export function getChipInstitutionEvidence(
  db: Database.Database,
  tsCode: string,
  tradeDate: string | null,
): ChipInstitutionEvidence {
  if (!tradeDate) return buildChipInstitutionEvidence(null, [], null)
  return buildChipInstitutionEvidence(
    tradeDate,
    getTopInstByStockAndDate(db, tsCode, tradeDate),
    getTopInstCoverage(db, tradeDate),
  )
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  return normalized.slice(0, 80) || 'TOP_INST_FAILED'
}

export interface ChipInstitutionTradeDateSyncResult {
  tradeDate: string
  status: 'success' | 'failed'
  rowCount: number
  requested: boolean
  errorCode: string | null
}

export async function syncChipInstitutionEvidenceTradeDate(
  db: Database.Database,
  token: string,
  tradeDate: string,
  force = false,
): Promise<ChipInstitutionTradeDateSyncResult> {
  const cachedCoverage = getTopInstCoverage(db, tradeDate)
  if (!force && cachedCoverage?.status === 'success') {
    return {
      tradeDate,
      status: 'success',
      rowCount: cachedCoverage.rowCount,
      requested: false,
      errorCode: null,
    }
  }
  try {
    const rows = await fetchTopInst(token, tradeDate)
    const rowCount = replaceTopInstForTradeDate(db, tradeDate, rows)
    return { tradeDate, status: 'success', rowCount, requested: true, errorCode: null }
  } catch (error) {
    const code = errorCode(error)
    recordTopInstSyncFailure(db, tradeDate, code)
    console.warn(`[ChipInstitutionEvidence] top_inst refresh failed for ${tradeDate}:`, error)
    return { tradeDate, status: 'failed', rowCount: 0, requested: true, errorCode: code }
  }
}