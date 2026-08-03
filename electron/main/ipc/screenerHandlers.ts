/**
 * FR-151b: 个性选股 IPC 处理器
 *
 * shortTerm:screener:get              — DB-first，缓存命中直接返回，否则调 runScreener
 * shortTerm:screener:run              — 强制重算（忽略缓存）
 * shortTerm:initDailyData             — 串行补齐历史日线数据（480个交易日），推送进度事件
 * shortTerm:screener:syncAllConcepts  — 全量补查题材（按股票代码并发查 kpl_concept_cons）
 */

import { ipcMain } from 'electron'
import { getDb } from '../database/db'
import { getByDate, deleteByDate } from '../database/stockScreenerResultsRepository'
import { runScreener, type ScreenerSnapshot } from '../services/stockScreenerService'
import { runDailyOHLCVSyncJob, runInitialDailyDataSync } from '../services/schedulerService'
import { queryAllActive } from '../database/stockBasicCacheRepository'
import { insertConceptMembersIfAbsent } from '../database/kplConceptMembersRepository'
import { fetchKplConceptConsByStock } from '../services/tushareService'
import { getDataSourceConfig } from '../database/dataSourceRepository'
import { decryptApiKey } from '../utils/apiKeyEncryption'
import { getScreenerInsight } from '../services/screenerInsightService'
import { fetchMoneyFlow } from '../services/tushareService'
import { countMoneyFlowByDate, upsertMoneyFlowRows } from '../database/moneyFlowRepository'
import {
  getScreenerRankConfig,
  resetScreenerRankConfig,
  updateScreenerRankConfig,
  type ScreenerRankConfig,
} from '../database/screenerRankConfigRepository'

// singleflight：防止并发重算
let _screenerInflight: Promise<ScreenerSnapshot> | null = null

// 防重入：初始化历史日线数据同一时间只允许一个进行
let _initDailyDataInFlight = false

// 防重入：全量题材同步同一时间只允许一个进行
let _syncConceptsInFlight = false

// 防重入：批量 AI 解读同一时间只允许一个进行
let _insightBatchInFlight = false

/**
 * 获取最新北京时间日期（YYYYMMDD）
 */
function getBjTodayYmd(): string {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

/**
 * 从 limit_list_daily 查最新交易日，无数据时 fallback 到北京时间昨日
 */
function getLatestTradeDateYmd(db: ReturnType<typeof getDb>): string {
  try {
    const row = db
      .prepare('SELECT MAX(trade_date) AS d FROM limit_list_daily')
      .get() as { d: string | null } | undefined
    return row?.d ?? getBjTodayYmd()
  } catch {
    return getBjTodayYmd()
  }
}

function isInTradingHoursBj(): boolean {
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const day = bjNow.getUTCDay()
  if (day < 1 || day > 5) return false
  const totalMin = bjNow.getUTCHours() * 60 + bjNow.getUTCMinutes()
  return (totalMin >= 9 * 60 + 30 && totalMin < 11 * 60 + 30)
    || (totalMin >= 13 * 60 && totalMin < 15 * 60)
}

async function computeScreener(tradeDate: string): Promise<ScreenerSnapshot> {
  if (_screenerInflight) return _screenerInflight
  _screenerInflight = (async () => {
    const db = getDb()
    await maybeSyncMoneyFlow(tradeDate)
    return runScreener(db, tradeDate)
  })()
  try {
    return await _screenerInflight
  } finally {
    _screenerInflight = null
  }
}

async function maybeSyncMoneyFlow(tradeDate: string): Promise<void> {
  const db = getDb()
  if (countMoneyFlowByDate(db, tradeDate) > 0) return
  const cfg = getDataSourceConfig(db)
  if (!cfg.tushareEnabled || !cfg.tushareTokenEncrypted) return
  try {
    const token = decryptApiKey(cfg.tushareTokenEncrypted)
    if (!token) return
    const rows = await fetchMoneyFlow(token, undefined, tradeDate)
    if (rows.length > 0) {
      upsertMoneyFlowRows(db, rows)
      console.log(`[Screener] synced moneyflow ${rows.length} rows for ${tradeDate}`)
    }
  } catch (err) {
    console.warn('[Screener] moneyflow sync skipped:', err instanceof Error ? err.message : String(err))
  }
}

function isTradeDateTurnoverEmpty(db: ReturnType<typeof getDb>, tradeDate: string, inTrading: boolean): boolean {
  const row = db.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN turnover_rate IS NOT NULL THEN 1 ELSE 0 END) AS filled
     FROM daily_close_cache
     WHERE trade_date = ?`
  ).get(tradeDate) as { total: number; filled: number | null }
  const total = row?.total ?? 0
  const filled = row?.filled ?? 0
  // 盘中不触发补拉（今日收盘数据尚未写入，total=0 是正常的）
  // 盘后：完全没有数据（total=0）或有数据但换手率全为空，均需补拉
  if (inTrading) return total > 0 && filled === 0
  return total === 0 || (total > 0 && filled === 0)
}

async function maybeBackfillTurnover(tradeDate: string, inTrading: boolean): Promise<boolean> {
  const db = getDb()
  if (!isTradeDateTurnoverEmpty(db, tradeDate, inTrading)) return false
  console.warn('[Screener] turnover_rate missing for', tradeDate, ', backfilling via daily_basic...')
  try {
    await runDailyOHLCVSyncJob(tradeDate)
    // 旧 screener 缓存是在 turnover 为空时算出来的，必须清除强制重算
    deleteByDate(db, tradeDate)
    return true
  } catch (err) {
    console.warn('[Screener] turnover backfill failed:', err instanceof Error ? err.message : String(err))
    return false
  }
}

function dbRowsToSnapshot(
  rows: ReturnType<typeof getByDate>,
  tradeDate: string
): ScreenerSnapshot {
  return {
    tradeDate,
    calculatedAt: new Date().toISOString(),
    isCached: true,
    mode: 'eod',
    totalScanned: 0,
    stocks: rows.map(r => ({
      tsCode: r.tsCode,
      stockName: r.stockName ?? r.tsCode,
      close: r.close ?? 0,
      pctChg: r.pctChg ?? 0,
      turnoverRate: r.turnoverRate ?? null,
      vol: r.vol ?? 0,
      amount: r.amount ?? 0,
      signalScore: r.signalScore,
      conditionsMet: r.conditionsMet ? (JSON.parse(r.conditionsMet) as string[]) : [],
      concepts: r.concepts ? (JSON.parse(r.concepts) as string[]) : [],
      turnoverMissing: r.turnoverRate == null,
      rankScore: r.rankScore ?? r.signalScore,
      rankBreakdown: r.rankBreakdownJson ? JSON.parse(r.rankBreakdownJson) : [],
      signalStrength: r.signalStrengthJson ? JSON.parse(r.signalStrengthJson) : {},
      moneyFlow: r.moneyflowJson ? JSON.parse(r.moneyflowJson) : null,
    }))
  }
}

export function registerScreenerHandlers(): void {
  ipcMain.handle('shortTerm:screener:getRankConfig', async () => {
    try {
      return { ok: true, config: getScreenerRankConfig(getDb()) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: msg, code: 'SCREENER_RANK_CONFIG_ERROR' }
    }
  })

  ipcMain.handle('shortTerm:screener:saveRankConfig', async (_event, payload?: Partial<ScreenerRankConfig>) => {
    try {
      const config = updateScreenerRankConfig(getDb(), payload ?? {})
      return { ok: true, config }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: msg, code: 'INVALID_PARAM' }
    }
  })

  ipcMain.handle('shortTerm:screener:resetRankConfig', async () => {
    try {
      const config = resetScreenerRankConfig(getDb())
      return { ok: true, config }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: msg, code: 'SCREENER_RANK_CONFIG_ERROR' }
    }
  })

  /**
   * DB-first 查询：有缓存直接返回，否则计算并写入 DB
   * payload: { tradeDate?: string } — 不传则用最新交易日
   */
  ipcMain.handle(
    'shortTerm:screener:get',
    async (_event, payload?: { tradeDate?: string }) => {
      try {
        const db = getDb()
        const inTrading = isInTradingHoursBj()
        // 盘中 limit_list_daily 尚未同步当日数据，强制用今日日期；盘后从 limit_list_daily 取最新交易日
        const tradeDate = payload?.tradeDate?.trim() || (inTrading ? getBjTodayYmd() : getLatestTradeDateYmd(db))
        await maybeBackfillTurnover(tradeDate, inTrading)
        // 盘中强制走实时计算，不读取昨日缓存
        if (inTrading) {
          const snapshot = await computeScreener(tradeDate)
          return { ok: true, snapshot }
        }
        const cached = getByDate(db, tradeDate)
        if (cached.length > 0) {
          const snapshot = dbRowsToSnapshot(cached, tradeDate)
          return { ok: true, snapshot }
        }
        // 缓存未命中，执行计算
        const snapshot = await computeScreener(tradeDate)
        return { ok: true, snapshot }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const code = (err as { code?: string }).code ?? 'SCREENER_ERROR'
        console.error('[Screener] screener:get error:', msg)
        return { ok: false, error: msg, code }
      }
    }
  )

  /**
   * 强制重算，忽略缓存
   * payload: { tradeDate?: string }
   */
  ipcMain.handle(
    'shortTerm:screener:run',
    async (_event, payload?: { tradeDate?: string }) => {
      try {
        const db = getDb()
        const inTrading = isInTradingHoursBj()
        const tradeDate = payload?.tradeDate?.trim() || (inTrading ? getBjTodayYmd() : getLatestTradeDateYmd(db))
        await maybeBackfillTurnover(tradeDate, inTrading)
        const snapshot = await computeScreener(tradeDate)
        return { ok: true, snapshot }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const code = (err as { code?: string }).code ?? 'SCREENER_ERROR'
        console.error('[Screener] screener:run error:', msg)
        return { ok: false, error: msg, code }
      }
    }
  )

  /**
   * FR-207: 单只个性选股 AI 归因解读.
   * payload: { tradeDate?: string; tsCode: string; forceRefresh?: boolean }
   */
  ipcMain.handle('shortTerm:screener:getInsight', async (_event, payload?: { tradeDate?: string; tsCode?: string; forceRefresh?: boolean }) => {
    try {
      const db = getDb()
      const inTrading = isInTradingHoursBj()
      const tradeDate = payload?.tradeDate?.trim() || (inTrading ? getBjTodayYmd() : getLatestTradeDateYmd(db))
      const tsCode = payload?.tsCode?.trim()
      if (!tsCode) return { ok: false, error: '缺少股票代码', code: 'INVALID_PARAM' }

      if (getByDate(db, tradeDate).length === 0) {
        await computeScreener(tradeDate)
      }
      const insight = await getScreenerInsight(db, tradeDate, tsCode, { forceRefresh: payload?.forceRefresh === true })
      if (!insight) return { ok: false, error: '当前股票不在个性选股结果中', code: 'SCREENER_STOCK_NOT_FOUND' }
      return { ok: true, insight }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const code = (err as { code?: string }).code ?? 'SCREENER_INSIGHT_ERROR'
      console.error('[Screener] screener:getInsight error:', msg)
      return { ok: false, error: msg, code }
    }
  })

  /**
   * FR-207: 当前可见候选股 Top N 批量解读.
   * payload: { tradeDate?: string; tsCodes?: string[]; limit?: number; forceRefresh?: boolean }
   */
  ipcMain.handle('shortTerm:screener:batchInsight', async (event, payload?: { tradeDate?: string; tsCodes?: string[]; limit?: number; forceRefresh?: boolean }) => {
    if (_insightBatchInFlight) {
      return { ok: false, error: 'AI 解读批量任务正在进行中，请稍候', code: 'INSIGHT_BATCH_RUNNING' }
    }
    _insightBatchInFlight = true
    try {
      const db = getDb()
      const inTrading = isInTradingHoursBj()
      const tradeDate = payload?.tradeDate?.trim() || (inTrading ? getBjTodayYmd() : getLatestTradeDateYmd(db))
      if (getByDate(db, tradeDate).length === 0) {
        await computeScreener(tradeDate)
      }
      const rows = getByDate(db, tradeDate)
      const inputCodes = (payload?.tsCodes ?? []).map(code => code.trim()).filter(Boolean)
      const limit = Math.max(1, Math.min(10, Math.floor(payload?.limit ?? 6)))
      const tsCodes = inputCodes.length > 0 ? inputCodes.slice(0, limit) : rows.slice(0, limit).map(row => row.tsCode)
      const total = tsCodes.length
      const results: Array<Awaited<ReturnType<typeof getScreenerInsight>>> = []
      const errors: Array<{ tsCode: string; error: string }> = []

      for (let i = 0; i < tsCodes.length; i += 1) {
        const tsCode = tsCodes[i]
        if (!event.sender.isDestroyed()) {
          event.sender.send('shortTerm:screener:insightProgress', { current: i, total, tsCode, status: 'running' })
        }
        try {
          const insight = await getScreenerInsight(db, tradeDate, tsCode, { forceRefresh: payload?.forceRefresh === true })
          if (insight) results.push(insight)
          else errors.push({ tsCode, error: '当前股票不在个性选股结果中' })
          if (!event.sender.isDestroyed()) {
            event.sender.send('shortTerm:screener:insightProgress', { current: i + 1, total, tsCode, status: insight ? 'done' : 'failed' })
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          errors.push({ tsCode, error: msg })
          if (!event.sender.isDestroyed()) {
            event.sender.send('shortTerm:screener:insightProgress', { current: i + 1, total, tsCode, status: 'failed', error: msg })
          }
        }
      }

      return { ok: true, results, errors }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const code = (err as { code?: string }).code ?? 'SCREENER_INSIGHT_BATCH_ERROR'
      console.error('[Screener] screener:batchInsight error:', msg)
      return { ok: false, error: msg, code }
    } finally {
      _insightBatchInFlight = false
    }
  })

  /**
   * 初始化历史日线数据（480 个交易日，复用共享历史日线服务）
   * 每完成一天推送 shortTerm:initDailyData:progress 事件
   * 全部完成后推送 shortTerm:initDailyData:done 事件
   */
  ipcMain.handle('shortTerm:initDailyData', async event => {
    if (_initDailyDataInFlight) {
      return { ok: false, error: '初始化正在进行中，请稍候' }
    }
    _initDailyDataInFlight = true
    try {
      await runInitialDailyDataSync(p => {
        // 防止窗口已销毁（用户关闭窗口后 webContents 可能已不存在）
        if (!event.sender.isDestroyed()) {
          event.sender.send('shortTerm:initDailyData:progress', p)
        }
      })
      if (!event.sender.isDestroyed()) {
        event.sender.send('shortTerm:initDailyData:done')
      }
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const code = (err as { code?: string }).code ?? 'INIT_ERROR'
      console.error('[Screener] initDailyData error:', msg)
      return { ok: false, error: msg, code }
    } finally {
      _initDailyDataInFlight = false
    }
  })

  /**
   * 全量补查题材数据（按个股代码并发调 kpl_concept_cons）
   *
   * 流程：
   * 1. 从 stock_basic_cache 读全量上市股票（~4500 只）
   * 2. 从 kpl_concept_members 读已有 con_code 集合，过滤掉已有记录的股票
   * 3. 5 路并发调 fetchKplConceptConsByStock，批次间 200ms 限速
   * 4. 每完成 50 只推送一次 progress 事件；全部完成推送 done 事件
   */
  ipcMain.handle('shortTerm:screener:syncAllConcepts', async event => {
    if (_syncConceptsInFlight) {
      return { ok: false, error: '题材同步正在进行中，请稍候' }
    }
    _syncConceptsInFlight = true
    try {
      const db = getDb()
      const cfg = getDataSourceConfig(db)
      if (!cfg.tushareEnabled || !cfg.tushareTokenEncrypted) {
        return { ok: false, error: 'Tushare 未配置', code: 'TUSHARE_DISABLED' }
      }
      const token = decryptApiKey(cfg.tushareTokenEncrypted)
      if (!token) {
        return { ok: false, error: 'Tushare Token unavailable', code: 'TUSHARE_DISABLED' }
      }

      // 读全量上市股票
      const basicRows = queryAllActive(db)
      if (basicRows.length === 0) {
        return { ok: false, error: 'stock_basic 尚未初始化，请先同步盘后数据', code: 'STOCK_BASIC_NOT_READY' }
      }

      // 读已有有效题材记录的股票代码集合（name IS NOT NULL 才算有效，避免跳过脏记录）
      const existingSet = new Set<string>()
      const existingRows = db
        .prepare('SELECT DISTINCT con_code FROM kpl_concept_members WHERE name IS NOT NULL')
        .all() as { con_code: string }[]
      for (const r of existingRows) existingSet.add(r.con_code)

      // 过滤出尚无题材记录的股票
      const missing = basicRows.filter(r => !existingSet.has(r.tsCode))
      const total = missing.length

      if (total === 0) {
        if (!event.sender.isDestroyed()) {
          event.sender.send('shortTerm:screener:syncConcepts:done', { inserted: 0, total: 0 })
        }
        return { ok: true, inserted: 0, total: 0 }
      }

      console.log(`[SyncAllConcepts] 需补查 ${total} 只（已有记录 ${existingSet.size} 只，total ${basicRows.length} 只）`)

      const CONCURRENCY = 5
      const BATCH_DELAY_MS = 200
      let done = 0
      let inserted = 0

      // 分批并发处理
      for (let i = 0; i < missing.length; i += CONCURRENCY) {
        const batch = missing.slice(i, i + CONCURRENCY)
        const results = await Promise.allSettled(
          batch.map(stock => fetchKplConceptConsByStock(token, stock.tsCode))
        )
        for (const result of results) {
          if (result.status === 'fulfilled' && result.value.length > 0) {
            insertConceptMembersIfAbsent(db, result.value)
            inserted += result.value.length
          }
        }
        done += batch.length
        // 每完成 50 只或最后一批时推送进度
        if (done % 50 === 0 || done === total) {
          if (!event.sender.isDestroyed()) {
            event.sender.send('shortTerm:screener:syncConcepts:progress', { done, total })
          }
        }
        // 批次间限速，避免触发 Tushare 频率限制
        if (i + CONCURRENCY < missing.length) {
          await new Promise(res => setTimeout(res, BATCH_DELAY_MS))
        }
      }

      console.log(`[SyncAllConcepts] 完成，写入 ${inserted} 条记录，覆盖 ${done} 只股票`)
      if (!event.sender.isDestroyed()) {
        event.sender.send('shortTerm:screener:syncConcepts:done', { inserted, total })
      }
      return { ok: true, inserted, total }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[SyncAllConcepts] error:', msg)
      return { ok: false, error: msg }
    } finally {
      _syncConceptsInFlight = false
    }
  })
}
