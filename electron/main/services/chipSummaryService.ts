import type Database from 'better-sqlite3'
import type { ChipMonitorResultRow, ChipStructureSummary } from '../database/types'
import {
  getLatestMonitorResults,
  getLatestMonitorResultsByTsCodes,
} from '../database/chipMonitorRepository'
import {
  getChipStructureSummaries,
  type ChipStructureSummarySelectionPolicy,
  type ChipStructureSummaryRequest,
} from './chipStructureService'

export interface ChipSummary {
  tradeDate: string
  bottomPct: number | null
  bottomAvgCost: number | null
  loosening1d: number | null
  loosening3d: number | null
  loosening5d: number | null
  pctChg: number | null
  turnoverRate: number | null
}

export function buildLatestChipSummaryMap(db: Database.Database): Map<string, ChipSummary> {
  const map = new Map<string, ChipSummary>()
  for (const row of getLatestMonitorResults(db)) {
    const summary = toChipSummary(row)
    for (const key of codeKeys(row.tsCode)) {
      map.set(key, summary)
    }
  }
  return map
}

export function buildCompatibleChipStructureSummaries(
  db: Database.Database,
  requests: ChipStructureSummaryRequest[],
  tradeDate?: string,
  referenceTradeDate?: string,
  mode: 'relative' | 'absolute' = 'relative',
  selectionPolicy: ChipStructureSummarySelectionPolicy = 'latest_fact',
): ChipStructureSummary[] {
  const structureSummaries = getChipStructureSummaries(
    db,
    requests,
    tradeDate,
    selectionPolicy,
    referenceTradeDate,
  )
  const legacyRows = getLatestMonitorResultsByTsCodes(
    db,
    structureSummaries.map((summary) => summary.tsCode),
    mode,
    tradeDate,
  )
  return mergeCompatibleChipStructureSummaries(structureSummaries, legacyRows, referenceTradeDate)
}

export function mergeCompatibleChipStructureSummaries(
  structureSummaries: ChipStructureSummary[],
  legacyRows: ChipMonitorResultRow[],
  referenceTradeDate?: string,
): ChipStructureSummary[] {
  const legacyByCode = new Map<string, ChipMonitorResultRow>()
  for (const row of legacyRows) {
    for (const key of codeKeys(row.tsCode)) legacyByCode.set(key, row)
  }

  return structureSummaries.map((summary) => {
    const legacy = codeKeys(summary.tsCode).map((key) => legacyByCode.get(key)).find(Boolean)
    const canMergeLegacy = legacy != null
      && (summary.tradeDate == null || legacy.tradeDate === summary.tradeDate)
    const factTradeDate = summary.tradeDate ?? (canMergeLegacy ? legacy.tradeDate : null)
    return {
      ...summary,
      stockName: summary.stockName ?? (canMergeLegacy ? legacy?.stockName ?? null : null),
      tradeDate: factTradeDate,
      dateRelation: getDateRelation(factTradeDate, referenceTradeDate),
      bottomPct: canMergeLegacy ? legacy.bottomPct : null,
      bottomAvgCost: canMergeLegacy ? legacy.bottomAvgCost : null,
      loosening1d: canMergeLegacy ? legacy.loosening1d : null,
      loosening3d: canMergeLegacy ? legacy.loosening3d : null,
      loosening5d: canMergeLegacy ? legacy.loosening5d : null,
      pctChg: canMergeLegacy ? legacy.pctChg : null,
      turnoverRate: canMergeLegacy ? legacy.turnoverRate : null,
      updatedAt: summary.updatedAt ?? (canMergeLegacy ? legacy.updatedAt : null),
    }
  })
}

function toChipSummary(row: ChipMonitorResultRow): ChipSummary {
  return {
    tradeDate: row.tradeDate,
    bottomPct: row.bottomPct,
    bottomAvgCost: row.bottomAvgCost,
    loosening1d: row.loosening1d,
    loosening3d: row.loosening3d,
    loosening5d: row.loosening5d,
    pctChg: row.pctChg,
    turnoverRate: row.turnoverRate,
  }
}

function codeKeys(tsCode: string): string[] {
  const clean = tsCode.trim().toUpperCase()
  const stripped = clean.replace(/\.(SH|SZ|BJ)$/i, '')
  return Array.from(new Set([clean, stripped]))
}

function getDateRelation(
  factTradeDate: string | null,
  referenceTradeDate?: string,
): ChipStructureSummary['dateRelation'] {
  if (!factTradeDate || !referenceTradeDate) return 'missing'
  return factTradeDate === referenceTradeDate ? 'same_day' : 'history'
}
