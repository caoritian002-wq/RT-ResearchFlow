import type Database from 'better-sqlite3'
import type { WebContents } from 'electron'
import { getMonitorStocks } from '../database/chipMonitorRepository'
import { getCyqPerf, listCyqPerfHistory, upsertCyqPerf } from '../database/cyqPerfCacheRepository'
import { listChipTradeDates, queryChips, upsertChips } from '../database/cyqChipsCacheRepository'
import { upsertDailyClose } from '../database/dailyCloseCacheRepository'
import {
  fetchCyqPerf,
  fetchDailyForCandidates,
} from './tushareService'
import { getChipStructureSummaries, normalizeChipStructureTsCode } from './chipStructureService'
import { fetchCyqChipsSingleflight } from './cyqChipsFetchService'
import {
  getChipInstitutionEvidence,
  syncChipInstitutionEvidenceTradeDate,
} from './chipInstitutionEvidenceService'

export type ChipStructureSyncState = 'idle' | 'running' | 'completed' | 'partial' | 'failed'
export type ChipStructureSyncScope = 'structure' | 'institution' | 'all'
export type ChipStructureSyncStage = 'structure' | 'institution'

export interface ChipStructureSyncStatus {
  taskId: string
  scope: ChipStructureSyncScope
  stage: ChipStructureSyncStage | null
  state: ChipStructureSyncState
  done: number
  total: number
  success: number
  noRecord: number
  partial: number
  failed: number
  currentStock: string | null
  startedAt: number | null
  completedAt: number | null
  failureReasons: Array<{ code: string; count: number }>
}

export interface StartChipStructureSyncOptions {
  tsCodes?: string[]
  tradeDate?: string
  scope?: ChipStructureSyncScope
  force?: boolean
  webContents?: WebContents
}

export type ChipStructureStockSyncResult = 'success' | 'partial' | 'failed'

const HISTORY_POINT_COUNT = 13
let currentStatus: ChipStructureSyncStatus = createIdleStatus()

function createIdleStatus(): ChipStructureSyncStatus {
  return {
    taskId: '',
    scope: 'structure',
    stage: null,
    state: 'idle',
    done: 0,
    total: 0,
    success: 0,
    noRecord: 0,
    partial: 0,
    failed: 0,
    currentStock: null,
    startedAt: null,
    completedAt: null,
    failureReasons: [],
  }
}

export function classifyChipStructureSyncResult(
  perfAvailable: boolean,
  chipsAvailable: boolean,
): ChipStructureStockSyncResult {
  if (perfAvailable && chipsAvailable) return 'success'
  if (perfAvailable || chipsAvailable) return 'partial'
  return 'failed'
}

function offsetDate(ymd: string, days: number): string {
  const date = new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10).replace(/-/g, '')
}

function getBjTodayYmd(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '')
}

function addFailureReason(reasons: Map<string, number>, code: string): void {
  reasons.set(code, (reasons.get(code) ?? 0) + 1)
}

function snapshotStatus(): ChipStructureSyncStatus {
  return {
    ...currentStatus,
    failureReasons: currentStatus.failureReasons.map((item) => ({ ...item })),
  }
}

export function getChipStructureSyncStatus(): ChipStructureSyncStatus {
  return snapshotStatus()
}

function resolveStockCodes(db: Database.Database, requested?: string[]): string[] {
  const sourceCodes = requested?.length
    ? requested
    : getMonitorStocks(db).map((stock) => stock.tsCode)
  const normalized = sourceCodes
    .map(normalizeChipStructureTsCode)
    .filter((code): code is string => code != null)
  return [...new Set(normalized)]
}

async function refreshDailyClose(
  db: Database.Database,
  token: string,
  tsCodes: string[],
  endDate: string,
  failureReasons: Map<string, number>,
): Promise<void> {
  try {
    const rows = await fetchDailyForCandidates(token, tsCodes, offsetDate(endDate, -45))
    if (rows.length > 0) upsertDailyClose(db, rows)
    else addFailureReason(failureReasons, 'DAILY_CLOSE_EMPTY')
  } catch (error) {
    console.warn('[ChipStructure] Daily close refresh failed:', error instanceof Error ? error.message : String(error))
    addFailureReason(failureReasons, 'DAILY_CLOSE_FAILED')
  }
}

async function syncOneStock(
  db: Database.Database,
  token: string,
  tsCode: string,
  endDate: string,
  targetDate: string | undefined,
  force: boolean,
  failureReasons: Map<string, number>,
): Promise<ChipStructureStockSyncResult> {
  const cachedTargetPerf = targetDate ? getCyqPerf(db, tsCode, targetDate) : null
  const cachedHistory = listCyqPerfHistory(db, tsCode, HISTORY_POINT_COUNT)
  const shouldFetchPerf = force || (targetDate ? cachedTargetPerf == null : cachedHistory.length < HISTORY_POINT_COUNT)
  let perfAvailable = !shouldFetchPerf && (targetDate ? cachedTargetPerf != null : cachedHistory.length > 0)
  if (shouldFetchPerf) {
    try {
      const rows = await fetchCyqPerf(
        token,
        tsCode,
        targetDate,
        targetDate ? undefined : offsetDate(endDate, -45),
        targetDate ? undefined : endDate,
      )
      if (rows.length > 0) {
        upsertCyqPerf(db, rows)
        perfAvailable = true
      } else {
        addFailureReason(failureReasons, 'CYQ_PERF_EMPTY')
      }
    } catch (error) {
      console.warn(`[ChipStructure] cyq_perf refresh failed for ${tsCode}:`, error instanceof Error ? error.message : String(error))
      addFailureReason(failureReasons, 'CYQ_PERF_FAILED')
    }
  }

  const cachedChipDates = targetDate
    ? (queryChips(db, tsCode, targetDate).length > 0 ? [targetDate] : [])
    : listChipTradeDates(db, tsCode, HISTORY_POINT_COUNT)
  const shouldFetchChips = force || (targetDate
    ? cachedChipDates.length === 0
    : cachedChipDates.length < HISTORY_POINT_COUNT)
  let chipsAvailable = !shouldFetchChips && cachedChipDates.length > 0
  if (shouldFetchChips) {
    try {
      const rows = await fetchCyqChipsSingleflight(token, tsCode, targetDate)
      if (rows.length > 0) {
        upsertChips(db, rows)
        chipsAvailable = true
      } else {
        addFailureReason(failureReasons, 'CYQ_CHIPS_EMPTY')
      }
    } catch (error) {
      const targetLabel = targetDate ?? 'latest-history'
      console.warn(`[ChipStructure] cyq_chips refresh failed for ${tsCode} ${targetLabel}:`, error instanceof Error ? error.message : String(error))
      addFailureReason(failureReasons, 'CYQ_CHIPS_FAILED')
    }
  }
  return classifyChipStructureSyncResult(perfAvailable, chipsAvailable)
}

function emitProgress(options: StartChipStructureSyncOptions, currentStock: string): void {
  options.webContents?.send('chipStructure:progress', {
    taskId: currentStatus.taskId,
    scope: currentStatus.scope,
    stage: currentStatus.stage,
    done: currentStatus.done,
    total: currentStatus.total,
    currentStock,
    success: currentStatus.success,
    noRecord: currentStatus.noRecord,
    partial: currentStatus.partial,
    failed: currentStatus.failed,
  })
}

async function runStructureStage(
  db: Database.Database,
  token: string,
  tsCodes: string[],
  options: StartChipStructureSyncOptions,
): Promise<void> {
  currentStatus.stage = 'structure'
  const failureReasons = new Map<string, number>()
  const endDate = options.tradeDate ?? getBjTodayYmd()
  await refreshDailyClose(db, token, tsCodes, endDate, failureReasons)

  for (const tsCode of tsCodes) {
    currentStatus.currentStock = tsCode
    const result = await syncOneStock(
      db,
      token,
      tsCode,
      endDate,
      options.tradeDate,
      options.force === true,
      failureReasons,
    )
    currentStatus[result]++
    currentStatus.done++
    currentStatus.failureReasons = [...failureReasons.entries()].map(([code, count]) => ({ code, count }))
    emitProgress(options, tsCode)
  }
}

export function resolveInstitutionTradeDates(
  db: Database.Database,
  tsCodes: string[],
  requestedTradeDate?: string,
): Map<string, string> {
  if (requestedTradeDate) {
    return new Map(tsCodes.map((tsCode) => [tsCode, requestedTradeDate]))
  }
  const result = new Map(
    getChipStructureSummaries(db, tsCodes.map((tsCode) => ({ tsCode })))
      .filter((summary) => summary.tradeDate != null)
      .map((summary) => [summary.tsCode, summary.tradeDate!]),
  )
  const missingCodes = tsCodes.filter((tsCode) => !result.has(tsCode))
  if (missingCodes.length === 0) return result

  const aliases = [...new Set(missingCodes.flatMap((tsCode) => [tsCode, tsCode.slice(0, 6)]))]
  const placeholders = aliases.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT ts_code, MAX(trade_date) AS trade_date
    FROM daily_close_cache
    WHERE ts_code IN (${placeholders})
    GROUP BY ts_code
  `).all(...aliases) as Array<{ ts_code: string; trade_date: string }>
  const latestByStoredCode = new Map(rows.map((row) => [row.ts_code, row.trade_date]))
  for (const tsCode of missingCodes) {
    const dates = [latestByStoredCode.get(tsCode), latestByStoredCode.get(tsCode.slice(0, 6))]
      .filter((date): date is string => date != null)
      .sort()
    const latestDate = dates.at(-1)
    if (latestDate) result.set(tsCode, latestDate)
  }
  return result
}

function addCurrentFailureReason(code: string): void {
  const reasons = new Map(currentStatus.failureReasons.map((item) => [item.code, item.count]))
  addFailureReason(reasons, code)
  currentStatus.failureReasons = [...reasons.entries()].map(([reasonCode, count]) => ({
    code: reasonCode,
    count,
  }))
}

async function runInstitutionStage(
  db: Database.Database,
  token: string,
  tsCodes: string[],
  options: StartChipStructureSyncOptions,
): Promise<void> {
  currentStatus.stage = 'institution'
  const targetsByDate = new Map<string, string[]>()
  const tradeDates = resolveInstitutionTradeDates(db, tsCodes, options.tradeDate)
  for (const tsCode of tsCodes) {
    const tradeDate = tradeDates.get(tsCode)
    if (!tradeDate) {
      currentStatus.currentStock = tsCode
      currentStatus.failed++
      currentStatus.done++
      addCurrentFailureReason('TRADE_DATE_MISSING')
      emitProgress(options, tsCode)
      continue
    }
    const targets = targetsByDate.get(tradeDate) ?? []
    targets.push(tsCode)
    targetsByDate.set(tradeDate, targets)
  }

  for (const [tradeDate, targetCodes] of targetsByDate) {
    const syncResult = await syncChipInstitutionEvidenceTradeDate(
      db,
      token,
      tradeDate,
      options.force === true,
    )
    for (const tsCode of targetCodes) {
      currentStatus.currentStock = tsCode
      if (syncResult.status === 'failed') {
        currentStatus.failed++
        addCurrentFailureReason(syncResult.errorCode ?? 'TOP_INST_FAILED')
      } else {
        const evidence = getChipInstitutionEvidence(db, tsCode, tradeDate)
        if (evidence.coverageStatus === 'available') currentStatus.success++
        else if (evidence.coverageStatus === 'no_record') currentStatus.noRecord++
        else {
          currentStatus.failed++
          addCurrentFailureReason('TOP_INST_COVERAGE_INVALID')
        }
      }
      currentStatus.done++
      emitProgress(options, tsCode)
    }
  }
}

function completeSync(options: StartChipStructureSyncOptions): void {
  currentStatus.currentStock = null
  currentStatus.stage = null
  currentStatus.completedAt = Date.now()
  currentStatus.state = currentStatus.failed === currentStatus.total
    ? 'failed'
    : currentStatus.partial > 0 || currentStatus.failed > 0
      ? 'partial'
      : 'completed'
  options.webContents?.send('chipStructure:done', {
    taskId: currentStatus.taskId,
    scope: currentStatus.scope,
    stage: currentStatus.stage,
    state: currentStatus.state,
    success: currentStatus.success,
    noRecord: currentStatus.noRecord,
    partial: currentStatus.partial,
    failed: currentStatus.failed,
    failureReasons: currentStatus.failureReasons,
    completedAt: currentStatus.completedAt,
  })
}

async function runSync(
  db: Database.Database,
  token: string,
  tsCodes: string[],
  options: StartChipStructureSyncOptions,
): Promise<void> {
  const scope = options.scope ?? 'structure'
  if (scope === 'structure' || scope === 'all') {
    await runStructureStage(db, token, tsCodes, options)
  }
  if (scope === 'institution' || scope === 'all') {
    await runInstitutionStage(db, token, tsCodes, options)
  }
  completeSync(options)
}

function launchChipStructureSync(
  db: Database.Database,
  token: string,
  options: StartChipStructureSyncOptions = {},
): { taskId: string; total: number; completion: Promise<ChipStructureSyncStatus> } {
  if (currentStatus.state === 'running') throw new Error('JOB_RUNNING')
  const tsCodes = resolveStockCodes(db, options.tsCodes)
  if (tsCodes.length === 0) throw new Error('EMPTY_STOCK_POOL')
  const scope = options.scope ?? 'structure'
  const taskId = `chip-structure-${Date.now()}`
  currentStatus = {
    ...createIdleStatus(),
    taskId,
    scope,
    state: 'running',
    total: tsCodes.length * (scope === 'all' ? 2 : 1),
    startedAt: Date.now(),
  }
  const completion = runSync(db, token, tsCodes, options)
    .catch((error) => {
      console.error('[ChipStructure] Sync job failed:', error)
      currentStatus.state = 'failed'
      currentStatus.stage = null
      currentStatus.currentStock = null
      currentStatus.completedAt = Date.now()
      currentStatus.failed += currentStatus.total - currentStatus.done
      currentStatus.done = currentStatus.total
      currentStatus.failureReasons = [{ code: 'JOB_FAILED', count: 1 }]
      options.webContents?.send('chipStructure:done', {
        taskId,
        scope: currentStatus.scope,
        stage: currentStatus.stage,
        state: 'failed',
        success: currentStatus.success,
        noRecord: currentStatus.noRecord,
        partial: currentStatus.partial,
        failed: currentStatus.failed,
        failureReasons: currentStatus.failureReasons,
        completedAt: currentStatus.completedAt,
      })
    })
    .then(() => snapshotStatus())
  return { taskId, total: currentStatus.total, completion }
}

export function startChipStructureSync(
  db: Database.Database,
  token: string,
  options: StartChipStructureSyncOptions = {},
): { taskId: string; total: number } {
  const launched = launchChipStructureSync(db, token, options)
  return { taskId: launched.taskId, total: launched.total }
}

export function runChipStructureSync(
  db: Database.Database,
  token: string,
  options: StartChipStructureSyncOptions = {},
): Promise<ChipStructureSyncStatus> {
  return launchChipStructureSync(db, token, options).completion
}
