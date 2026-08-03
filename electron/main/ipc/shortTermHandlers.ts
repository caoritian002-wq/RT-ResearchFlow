import { ipcMain } from 'electron'
import { getDb } from '../database/db'
import {
  getShortTermActiveSubTab,
  setShortTermActiveSubTab,
  getConceptSource,
  setConceptSource
} from '../database/settingsRepository'
import { getDataSourceConfig } from '../database/dataSourceRepository'
import { decryptApiKey } from '../utils/apiKeyEncryption'
import {
  runAfterCloseDailySyncJob,
  runTopListSyncJob,
  runConceptMembersSyncJob,
  runConceptMembersSyncForSource,
  runDailyOHLCVSyncJob,
  runStockBasicSyncJob
} from '../services/schedulerService'
import { clearConceptHeatCache } from '../services/marketOverviewService'
import {
  getCachedMorningAuctionSnapshot,
  getOrCreateMorningAuctionSnapshot,
  refreshMorningAuctionSnapshot,
  resolveMorningAuctionTradeDateStatus
} from '../services/morningAuctionService'
import {
  getOrCreateClosingHalfHourSnapshot,
  refreshClosingHalfHourSnapshot
} from '../services/closingHalfHourService'
import {
  getOrCreateLimitBoardSnapshot,
  refreshLimitBoardSnapshot
} from '../services/limitBoardMonitorService'
import {
  getOrCreateSecondBoardSnapshot,
  refreshSecondBoardSnapshot
} from '../services/secondBoardLeaderService'
import {
  getOrCreateFirstYinSnapshot,
  refreshFirstYinSnapshot
} from '../services/firstYinDipService'
import {
  getOrCreateDipBuyRadarSnapshot,
  refreshDipBuyRadarSnapshot
} from '../services/dipBuyRadarService'
import {
  fetchDailyForCandidates,
  fetchStockMinuteDaily,
  fetchStkFactorPro,
  fetchStkFactorProHistory
} from '../services/tushareService'
import { fetchCyqChipsSingleflight } from '../services/cyqChipsFetchService'
import {
  getLatestDailyCloseTradeDate,
  queryStockOHLCV,
  upsertDailyClose,
} from '../database/dailyCloseCacheRepository'
import { upsertChips, queryChips, queryLatestChips } from '../database/cyqChipsCacheRepository'
import {
  upsertFactor,
  queryFactor,
  queryLatestFactor,
  queryFactorHistory,
  upsertFactorBatch
} from '../database/stkFactorCacheRepository'
import { countThsMembers, getThsSyncedAt, getThsConceptsByStock } from '../database/thsConceptMembersRepository'
import { hasDcDataForDate } from '../database/dcConceptMembersRepository'
import { getConceptsByStockRouted } from '../services/conceptRouter'
import { refreshRtKCache, isRtKStale, getRtKCache } from '../services/sharedRtKCache'
import { runChipMonitorJob, isChipMonitorJobRunning, recomputeChipMonitorResults } from '../services/chipMonitorService'
import {
  getMonitorStocks,
  replaceMonitorStocksBySource,
  getLatestMonitorResults,
} from '../database/chipMonitorRepository'
import { listPortfolioStocks } from '../database/portfolioRepository'
import { BrowserWindow } from 'electron'
import type { ShortTermSubTab } from '../database/types'
import {
  isBacktestRunning,
  repairBacktestDetailsFromLocalDaily,
  runBacktestSync,
} from '../services/backtestAuctionService'
import { queryDetails, getComputedDates } from '../database/backtestDetailRepository'
import { getAvailableDates } from '../database/stkAuctionCacheRepository'
import { listMorningAuctionInsightStatus } from '../database/morningAuctionInsightRepository'
import {
  countMorningAuctionCandidates,
  generateMorningAuctionInsights,
  getMorningAuctionStructuredInsight,
  MORNING_AUCTION_INSIGHT_SCHEMA_VERSION,
  updateMorningAuctionVerification
} from '../services/morningAuctionInsightService'
import type { MorningAuctionVerificationStatus } from '../database/types'

const ALLOWED_SUB_TABS: ShortTermSubTab[] = [
  'morningAuction',
  'closingHalfHour',
  'limitBoardMonitor',
  'secondBoardLeader',
  'firstYinDip',
  'dipBuyRadar',
  'strategyLab',
  'personalScreener',
  'chipMonitor',
  'conditionBlocks',
  'strategyBacktest'
]

const ALLOWED_TASKS = ['afterCloseDaily', 'topList', 'conceptMembers', 'dailyOHLCV', 'stockBasic'] as const
type SyncTask = (typeof ALLOWED_TASKS)[number]

/**
 * FR-124: 短线策略基础 IPC
 *  - shortTerm:getActiveSubTab  / shortTerm:setActiveSubTab  子页签持久化
 *  - shortTerm:syncDataNow      手动触发对应 cron job（异步执行，立即返回）
 */
export function registerShortTermHandlers(): void {
  ipcMain.handle('shortTerm:getActiveSubTab', () => {
    return { ok: true as const, subTab: getShortTermActiveSubTab() }
  })

  ipcMain.handle('shortTerm:setActiveSubTab', (_e, payload: { subTab: ShortTermSubTab }) => {
    if (!payload || !ALLOWED_SUB_TABS.includes(payload.subTab)) {
      return { ok: false as const, error: 'INVALID_PARAM' as const }
    }
    setShortTermActiveSubTab(payload.subTab)
    return { ok: true as const }
  })

  ipcMain.handle('shortTerm:syncDataNow', async (_e, payload: { task: SyncTask }) => {
    if (!payload || !(ALLOWED_TASKS as readonly string[]).includes(payload.task)) {
      return { ok: false as const, error: 'INVALID_PARAM' as const }
    }
    // Tushare 配置校验：未启用直接报错；cron job 内部也有同样校验
    const dsConfig = getDataSourceConfig(getDb())
    if (!dsConfig.tushareEnabled || !dsConfig.tushareTokenEncrypted) {
      return { ok: false as const, error: 'TUSHARE_DISABLED' as const }
    }
    // FR-176: 股票走势图冷启动同步需要等待 stock_basic 写库完成, 以便前端立即重试搜索。
    if (payload.task === 'stockBasic') {
      try {
        await runStockBasicSyncJob()
      } catch (err) {
        console.error('[shortTerm:syncDataNow] task=stockBasic error:', err)
        return { ok: false as const, error: 'SYNC_FAILED' as const }
      }
      return { ok: true as const }
    }
    // 异步触发，不阻塞 IPC 返回；错误在 cron job 内部记录日志
    void (async () => {
      try {
        switch (payload.task) {
          case 'afterCloseDaily':
            await runAfterCloseDailySyncJob()
            break
          case 'topList':
            await runTopListSyncJob()
            break
          case 'conceptMembers':
            await runConceptMembersSyncJob()
            break
          case 'dailyOHLCV': {
            const today = new Date(Date.now() + 8 * 60 * 60 * 1000)
              .toISOString()
              .slice(0, 10)
              .replace(/-/g, '')
            await runDailyOHLCVSyncJob(today)
            break
          }
        }
      } catch (err) {
        console.error(`[shortTerm:syncDataNow] task=${payload.task} error:`, err)
      }
    })()
    return { ok: true as const }
  })

  // 手动触发 rt_k 缓存刷新（前端进入短线策略 Tab 时调用；30s 防抖，缓存未过期则跳过）
  ipcMain.handle('shortTerm:refreshRtKNow', async () => {
    const db = getDb()
    const cfg = getDataSourceConfig(db)
    if (!cfg.tushareEnabled || !cfg.tushareTokenEncrypted) {
      return { ok: false as const, error: 'TUSHARE_DISABLED' as const }
    }
    // 30s 内缓存仍有效则跳过（前端可频繁进出 Tab）
    if (!isRtKStale(30_000)) {
      return { ok: true as const, skipped: true }
    }
    const token = decryptApiKey(cfg.tushareTokenEncrypted)
    if (!token) {
      return { ok: false as const, error: 'TUSHARE_DISABLED' as const }
    }
    try {
      await refreshRtKCache(token)
      return { ok: true as const, skipped: false }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false as const, error: msg }
    }
  })

  // FR-125: 晨间集合竞价快照（真实接口：前一日 limit_list_daily 分池 + stk_auction 竞价数据）
  ipcMain.handle('shortTerm:morningAuction:get', async (_e, payload?: { tradeDate?: string }) => {
    const tradeDate = payload?.tradeDate ?? getBjTodayYmd()
    const snapshot = await getOrCreateMorningAuctionSnapshot(tradeDate)
    const tradeDateStatus = resolveMorningAuctionTradeDateStatus(tradeDate)
    const insightStatus = listMorningAuctionInsightStatus(getDb(), tradeDate, countMorningAuctionCandidates(snapshot), MORNING_AUCTION_INSIGHT_SCHEMA_VERSION)
    return { ok: true as const, snapshot, tradeDateStatus, insightStatus }
  })

  ipcMain.handle('shortTerm:morningAuction:refresh', async (_e, payload?: { tradeDate?: string }) => {
    const tradeDate = payload?.tradeDate ?? getBjTodayYmd()
    const snapshot = await refreshMorningAuctionSnapshot(tradeDate)
    const tradeDateStatus = resolveMorningAuctionTradeDateStatus(tradeDate)
    if (tradeDateStatus.isTradeDay) {
      const snapshotCopy = structuredClone(snapshot)
      setImmediate(() => {
        try {
          generateMorningAuctionInsights(getDb(), snapshotCopy)
        } catch (error) {
          console.error('[shortTerm:morningAuction:refreshInsights] error:', error)
        }
      })
    }
    const insightStatus = listMorningAuctionInsightStatus(getDb(), tradeDate, countMorningAuctionCandidates(snapshot), MORNING_AUCTION_INSIGHT_SCHEMA_VERSION)
    return { ok: true as const, snapshot, tradeDateStatus, insightStatus }
  })

  ipcMain.handle('shortTerm:morningAuction:generateInsights', async (_e, payload?: {
    tradeDate?: string
    tsCode?: string
    poolKey?: string
    force?: boolean
  }) => {
    const input = payload ?? {}
    const tradeDate = input.tradeDate?.trim()
    if (!tradeDate || !/^\d{8}$/.test(tradeDate) || (input.tsCode && !/^\d{6}(?:\.(?:SH|SZ|BJ))?$/i.test(input.tsCode))) {
      return { ok: false as const, error: { code: 'INVALID_PARAM' as const, message: '竞价研判参数无效。' } }
    }
    try {
      const tradeDateStatus = resolveMorningAuctionTradeDateStatus(tradeDate)
      if (!tradeDateStatus.isTradeDay) {
        return {
          ok: false as const,
          error: {
            code: 'NON_TRADING_DAY' as const,
            message: '所选日期不是交易日, 无法生成竞价研判。',
            recommendedTradeDate: tradeDateStatus.recommendedTradeDate
          }
        }
      }
      const snapshot = getCachedMorningAuctionSnapshot(tradeDate)
      if (!snapshot) {
        return {
          ok: false as const,
          error: { code: 'SNAPSHOT_NOT_FOUND' as const, message: '当前交易日尚无可用竞价快照。' }
        }
      }
      if (!input.force && input.tsCode && input.poolKey) {
        const cached = getMorningAuctionStructuredInsight(getDb(), tradeDate, input.tsCode, input.poolKey)
        if (cached) {
          return { ok: true as const, tradeDate, generatedCount: 0, failedCount: 0, insights: [cached] }
        }
      }
      const result = generateMorningAuctionInsights(getDb(), snapshot, {
        tsCode: input.tsCode,
        poolKey: input.poolKey
      })
      return {
        ok: true as const,
        tradeDate,
        generatedCount: result.generatedCount,
        failedCount: result.failedCount,
        insights: result.insights
      }
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error)
      return {
        ok: false as const,
        error: { code: 'INSIGHT_GENERATION_FAILED' as const, message: '结构化竞价研判生成失败。', details }
      }
    }
  })

  ipcMain.handle('shortTerm:morningAuction:getInsight', (_e, payload?: {
    tradeDate?: string
    tsCode?: string
    poolKey?: string
  }) => {
    if (!payload?.tradeDate || !payload.tsCode || !payload.poolKey || !/^\d{8}$/.test(payload.tradeDate)) {
      return { ok: false as const, error: { code: 'INVALID_PARAM' as const, message: '竞价研判查询参数无效。' } }
    }
    const insight = getMorningAuctionStructuredInsight(getDb(), payload.tradeDate, payload.tsCode, payload.poolKey)
    return { ok: true as const, insight }
  })

  ipcMain.handle('shortTerm:morningAuction:updateVerification', (_e, payload?: {
    tradeDate?: string
    tsCode?: string
    poolKey?: string
    itemKey?: string
    status?: MorningAuctionVerificationStatus
    reason?: string
  }) => {
    const allowedStatuses: MorningAuctionVerificationStatus[] = ['pending', 'checked', 'blocked', 'not_applicable']
    if (!payload?.tradeDate || !payload.tsCode || !payload.poolKey || !payload.itemKey || !payload.status ||
      !/^\d{8}$/.test(payload.tradeDate) || !allowedStatuses.includes(payload.status)) {
      return { ok: false as const, error: { code: 'INVALID_PARAM' as const, message: '验证项参数无效。' } }
    }
    const insight = updateMorningAuctionVerification(getDb(), {
      tradeDate: payload.tradeDate,
      tsCode: payload.tsCode,
      poolKey: payload.poolKey,
      itemKey: payload.itemKey,
      status: payload.status,
      reason: payload.reason
    })
    if (!insight) {
      return { ok: false as const, error: { code: 'VERIFICATION_ITEM_NOT_FOUND' as const, message: '未找到对应研判或验证项。' } }
    }
    return { ok: true as const, insight }
  })

  // FR-126: 尾盘半小时 6 形态识别（真实接口：limit_list_daily 候选股 + stock_minute_cache 分钟数据）
  ipcMain.handle('shortTerm:closingHalfHour:get', async (_e, payload?: { tradeDate?: string }) => {
    const tradeDate = payload?.tradeDate ?? getBjTodayYmd()
    const snapshot = await getOrCreateClosingHalfHourSnapshot(tradeDate)
    return { ok: true as const, snapshot }
  })

  ipcMain.handle('shortTerm:closingHalfHour:refresh', async (_e, payload?: { tradeDate?: string }) => {
    const tradeDate = payload?.tradeDate ?? getBjTodayYmd()
    const snapshot = await refreshClosingHalfHourSnapshot(tradeDate)
    return { ok: true as const, snapshot }
  })

  // FR-127: 打板助手（双模式：盘中 rt_k 实时 / 盘后 EOD DB）
  ipcMain.handle('shortTerm:limitBoardMonitor:get', async (_e, payload?: { tradeDate?: string }) => {
    const tradeDate = payload?.tradeDate ?? getBjTodayYmd()
    const snapshot = await getOrCreateLimitBoardSnapshot(tradeDate)
    return { ok: true as const, snapshot }
  })

  ipcMain.handle('shortTerm:limitBoardMonitor:refresh', async (_e, payload?: { tradeDate?: string }) => {
    const tradeDate = payload?.tradeDate ?? getBjTodayYmd()
    const snapshot = await refreshLimitBoardSnapshot(tradeDate)
    return { ok: true as const, snapshot }
  })

  // FR-250: 连板梯队与题材竞争（复用既有连板 IPC）
  ipcMain.handle('shortTerm:secondBoardLeader:get', (_e, payload?: { tradeDate?: string }) => {
    const tradeDate = payload?.tradeDate ?? getBjTodayYmd()
    const snapshot = getOrCreateSecondBoardSnapshot(tradeDate)
    return { ok: true as const, snapshot }
  })

  ipcMain.handle('shortTerm:secondBoardLeader:refresh', (_e, payload?: { tradeDate?: string }) => {
    const tradeDate = payload?.tradeDate ?? getBjTodayYmd()
    const snapshot = refreshSecondBoardSnapshot(tradeDate)
    return { ok: true as const, snapshot }
  })

  // FR-250: 首阴回踩状态机（复用既有 IPC）
  ipcMain.handle('shortTerm:firstYinDip:get', (_e, payload?: { tradeDate?: string }) => {
    const tradeDate = payload?.tradeDate ?? getBjTodayYmd()
    const snapshot = getOrCreateFirstYinSnapshot(tradeDate)
    return { ok: true as const, snapshot }
  })

  ipcMain.handle('shortTerm:firstYinDip:refresh', (_e, payload?: { tradeDate?: string }) => {
    const tradeDate = payload?.tradeDate ?? getBjTodayYmd()
    const snapshot = refreshFirstYinSnapshot(tradeDate)
    return { ok: true as const, snapshot }
  })

  // FR-130 / FR-250: 低吸雷达三套独立前置条件
  ipcMain.handle('shortTerm:dipBuyRadar:get', async (_e, payload?: { tradeDate?: string }) => {
    const tradeDate = payload?.tradeDate ?? getBjTodayYmd()
    const snapshot = await getOrCreateDipBuyRadarSnapshot(tradeDate)
    return { ok: true as const, snapshot }
  })

  ipcMain.handle('shortTerm:dipBuyRadar:refresh', async (_e, payload?: { tradeDate?: string }) => {
    const tradeDate = payload?.tradeDate ?? getBjTodayYmd()
    const snapshot = await refreshDipBuyRadarSnapshot(tradeDate)
    return { ok: true as const, snapshot }
  })

  // ===== FR-139: hover 微缩 K 线 IPC =====

  // inflightMap 防止同一 tsCode 并发重复拉取
  const miniKlineInflight = new Map<string, Promise<unknown>>()
  // 分时数据 1 分钟 TTL 内存缓存（避免快速 hover 重复调用 Tushare rt_min_daily）
  type IntradayCacheRow = Awaited<ReturnType<typeof fetchStockMinuteDaily>>[number]
  const intradayCacheMap = new Map<string, { rows: IntradayCacheRow[]; cachedAt: number }>()
  const INTRADAY_TTL_MS = 60_000

  /**
   * 查 DB → 若 OHLCV 行数不足则单股补拉 Tushare daily → 等待完成后返回完整数据
   */
  ipcMain.handle('shortTerm:getStockMiniKline', async (_e, payload: { tsCode: string }) => {
    if (!payload?.tsCode) return { ok: false as const, error: 'INVALID_PARAM' as const }
    const { tsCode } = payload
    const db = getDb()
    // 270 日历日前起始日期（≈ 180 个交易日）
    const startDate = (() => {
      const d = new Date(Date.now() + 8 * 60 * 60 * 1000)
      d.setUTCDate(d.getUTCDate() - 270)
      return d.toISOString().slice(0, 10).replace(/-/g, '')
    })()
    const cached = queryStockOHLCV(db, tsCode, startDate)
    const ohlcvRows = cached.filter((r) => r.open != null)

    // 合并 stock_price_cache 中的成交额（千元），tsCode 如 "000001.SZ" → stockCode "000001"
    const stockCode = tsCode.split('.')[0]
    const withAmt = (rows: ReturnType<typeof queryStockOHLCV>) => {
      interface AR { tradeDate: string; amount: number | null }
      const amtRows = db.prepare(
        'SELECT tradeDate, amount FROM stock_price_cache WHERE stockCode = ? AND tradeDate >= ?'
      ).all(stockCode, startDate) as AR[]
      const map = new Map(amtRows.map((r) => [r.tradeDate, r.amount]))
      return rows.map((r) => ({ ...r, amount: map.get(r.tradeDate) ?? null }))
    }

    // 若 DB 历史数据不足，先补拉
    if (ohlcvRows.length < 20) {
      const existing = miniKlineInflight.get(tsCode)
      if (existing) {
        await existing
      } else {
        const dsConfig = getDataSourceConfig(db)
        if (dsConfig.tushareEnabled && dsConfig.tushareTokenEncrypted) {
          const token = decryptApiKey(dsConfig.tushareTokenEncrypted)
          if (token) {
            const fetchPromise = fetchDailyForCandidates(token, [tsCode], startDate)
              .then((rows) => {
                if (rows.length > 0) upsertDailyClose(db, rows)
              })
              .catch((err) => {
                console.warn(`[getStockMiniKline] fetch failed for ${tsCode}:`, err)
              })
              .finally(() => {
                miniKlineInflight.delete(tsCode)
              })
            miniKlineInflight.set(tsCode, fetchPromise)
            await fetchPromise
          }
        }
      }
    }

    // 从 DB 取最终 OHLCV 数据，并合并 stock_price_cache 中的成交额
    const finalRows = withAmt(queryStockOHLCV(db, tsCode, startDate))

    // 若 DB 最新交易日不是今日（日线接口尚未更新），尝试用 rt_k 缓存合成今日 bar
    const todayYmd = (() => {
      const d = new Date(Date.now() + 8 * 60 * 60 * 1000)
      return d.toISOString().slice(0, 10).replace(/-/g, '')
    })()
    const latestTradeDate = finalRows.length > 0 ? finalRows[finalRows.length - 1].tradeDate : null
    if (latestTradeDate !== todayYmd) {
      // rt_k tsCode 格式带后缀（如 000001.SZ），handler 入参可能已带，也可能没带
      const rtTsCode = tsCode.includes('.') ? tsCode : (() => {
        if (/^(43|83|87|88|430|831|832|835|836|837|838|839|870|871|872|873|874|875|876|877|878|879|880|881|882|883|884|885|886|887|888|889|890|891|892|893|894|895|896|897|898|899|900)/.test(tsCode)) return `${tsCode}.BJ`
        if (tsCode.startsWith('6') || tsCode.startsWith('5') || tsCode.startsWith('9')) return `${tsCode}.SH`
        return `${tsCode}.SZ`
      })()
      const rtEntry = getRtKCache()?.get(rtTsCode)
      if (rtEntry && rtEntry.preClose > 0 && rtEntry.price > 0) {
        // 用 preClose 近似 open，high/low 取 price 与 preClose 的极值，体现今日价格方向
        const open = rtEntry.preClose
        const close = rtEntry.price
        const high = Math.max(open, close)
        const low = Math.min(open, close)
        finalRows.push({
          tsCode,
          tradeDate: todayYmd,
          open,
          high,
          low,
          close,
          pctChg: rtEntry.change,
          vol: rtEntry.vol,
          turnoverRate: null,
          // 合成 bar 成交额单位与 stock_price_cache 保持一致（千元），rt_k amount 为元
          amount: rtEntry.amount > 0 ? rtEntry.amount / 1000 : null,
        })
      }
    }

    return { ok: true as const, rows: finalRows }
  })

  /**
   * 拉取今日 1 分钟 K 线；Tushare 未配置或失败均返回空数组
   */
  ipcMain.handle('shortTerm:getStockIntraday', async (_e, payload: { tsCode: string }) => {
    if (!payload?.tsCode) return { ok: false as const, error: 'INVALID_PARAM' as const }
    const { tsCode } = payload
    const db = getDb()
    const dsConfig = getDataSourceConfig(db)
    if (!dsConfig.tushareEnabled || !dsConfig.tushareTokenEncrypted) {
      return { ok: true as const, rows: [] }
    }
    // 命中 1 分钟缓存直接返回，避免快速 hover 重复调用 Tushare
    const cachedIntraday = intradayCacheMap.get(tsCode)
    if (cachedIntraday && Date.now() - cachedIntraday.cachedAt < INTRADAY_TTL_MS) {
      return { ok: true as const, rows: cachedIntraday.rows }
    }
    try {
      const token = decryptApiKey(dsConfig.tushareTokenEncrypted)
      if (!token) return { ok: true as const, rows: [] }
      const rows = await fetchStockMinuteDaily(token, tsCode, '1MIN')
      intradayCacheMap.set(tsCode, { rows, cachedAt: Date.now() })
      return { ok: true as const, rows }
    } catch (err) {
      console.warn(`[getStockIntraday] fetch failed for ${tsCode}:`, err)
      return { ok: true as const, rows: [] }
    }
  })

  // ── FR-142 筹码分布 ─────────────────────────────────────────────

  ipcMain.handle(
    'shortTerm:getStockChips',
    async (_e, payload: { tsCode: string; tradeDate?: string }) => {
      if (!payload?.tsCode) return { ok: false as const, code: 'INVALID_PARAM' as const }
      const { tsCode } = payload
      const isDefaultLoad = !payload.tradeDate
      const tradeDate = payload.tradeDate ?? getBjTodayYmd()
      const db = getDb()
      // 点击股票时诊断：仅 THS 模式下输出该股的原始题材行与去重结果
      const _srcRow = (db.prepare('SELECT concept_source FROM app_settings LIMIT 1').get() as { concept_source: string | null } | undefined)
      if (_srcRow?.concept_source === 'ths') {
        const _rawRows = getThsConceptsByStock(db, tsCode)
        const _seenNames = new Set<string>()
        const _deduped = _rawRows.filter(r => r.conName && !_seenNames.has(r.conName as string) && (_seenNames.add(r.conName as string), true))
        console.log(`[THS-CLICK] ${tsCode}: DB原始 ${_rawRows.length} 行 → 去重后 ${_deduped.length} 个; 前5原始: ${_rawRows.slice(0, 5).map(r => `${r.conCode}|${r.conName ?? ''}`).join(', ')}`)
      }

      // DB-first：精确日期命中直接返回
      const cached = queryChips(db, tsCode, tradeDate)
      if (cached.length > 0) return { ok: true as const, data: cached }

      // 默认加载（未指定交易日）时，回退到 DB 中最新一期缓存（盘中今日数据尚未发布）
      if (isDefaultLoad) {
        const latest = queryLatestChips(db, tsCode)
        if (latest && latest.chips.length > 0) {
          return { ok: true as const, data: latest.chips }
        }
      }

      // DB 完全无该股数据时，尝试从 Tushare API 拉取
      // isDefaultLoad 时用昨日日期：今日盘后数据在收盘后才发布，昨日数据必然存在
      const dsConfig = getDataSourceConfig(db)
      if (!dsConfig.tushareEnabled || !dsConfig.tushareTokenEncrypted) {
        return { ok: false as const, code: 'TUSHARE_DISABLED' as const }
      }

      const apiDate = isDefaultLoad ? getLatestTradeDateYmd(db) : tradeDate
      try {
        const token = decryptApiKey(dsConfig.tushareTokenEncrypted)
        if (!token) return { ok: false as const, code: 'TUSHARE_DISABLED' as const }
        const rows = await fetchCyqChipsSingleflight(token, tsCode, apiDate)
        if (rows.length > 0) upsertChips(db, rows)
        const data = rows.map(r => ({ price: r.price, percent: r.percent }))
        return { ok: true as const, data }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('TUSHARE_QUOTA_INSUFFICIENT')) {
          return { ok: false as const, code: 'TUSHARE_QUOTA_INSUFFICIENT' as const }
        }
        return { ok: false as const, code: 'UPSTREAM_ERROR' as const }
      }
    }
  )

  // ── FR-143 技术因子 ─────────────────────────────────────────────

  // singleflight map：key = tsCode+tradeDate
  const factorInflight = new Map<string, Promise<ReturnType<typeof queryFactor>>>()

  ipcMain.handle(
    'shortTerm:getStockFactor',
    async (_e, payload: { tsCode: string; tradeDate?: string }) => {
      if (!payload?.tsCode) return { ok: false as const, code: 'INVALID_PARAM' as const }
      const { tsCode } = payload
      const isDefaultLoad = !payload.tradeDate
      const tradeDate = payload.tradeDate ?? getBjTodayYmd()
      const db = getDb()

      // DB-first：精确日期命中直接返回
      const cached = queryFactor(db, tsCode, tradeDate)
      if (cached) return { ok: true as const, data: cached }

      // 默认加载（未指定交易日）时，回退到 DB 中最新一期缓存（盘中今日数据尚未发布）
      if (isDefaultLoad) {
        const latest = queryLatestFactor(db, tsCode)
        if (latest) return { ok: true as const, data: latest }
      }

      // DB 完全无该股数据时，尝试从 Tushare API 拉取
      // isDefaultLoad 时用昨日日期：今日盘后数据在收盘后才发布，昨日数据必然存在
      const dsConfig = getDataSourceConfig(db)
      if (!dsConfig.tushareEnabled || !dsConfig.tushareTokenEncrypted) {
        return { ok: false as const, code: 'TUSHARE_DISABLED' as const }
      }

      const apiDate = isDefaultLoad ? getLatestTradeDateYmd(db) : tradeDate
      // singleflight 合并同 tsCode+apiDate 并发请求
      const key = `${tsCode}|${apiDate}`
      const token = decryptApiKey(dsConfig.tushareTokenEncrypted)
      if (!token) return { ok: false as const, code: 'TUSHARE_DISABLED' as const }
      let promise = factorInflight.get(key)
      if (!promise) {
        promise = (async () => {
          const row = await fetchStkFactorPro(token, tsCode, apiDate)
          if (row) upsertFactor(db, row)
          return row
        })().finally(() => factorInflight.delete(key))
        factorInflight.set(key, promise)
      }

      try {
        const data = await promise
        if (!data) return { ok: false as const, code: 'UPSTREAM_ERROR' as const }
        return { ok: true as const, data }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('TUSHARE_QUOTA_INSUFFICIENT')) {
          return { ok: false as const, code: 'TUSHARE_QUOTA_INSUFFICIENT' as const }
        }
        return { ok: false as const, code: 'UPSTREAM_ERROR' as const }
      }
    }
  )

  // ── 技术因子历史（供日线 MA/BOLL 曲线绘制）──────────────────────────────

  // singleflight map：key = tsCode|startDate
  const factorHistoryInflight = new Map<string, Promise<ReturnType<typeof queryFactorHistory>>>()

  ipcMain.handle(
    'shortTerm:getStockFactorHistory',
    async (_e, payload: { tsCode: string; startDate: string; dbOnly?: boolean }) => {
      if (!payload?.tsCode || !payload?.startDate)
        return { ok: false as const, code: 'INVALID_PARAM' as const }
      const { tsCode, startDate } = payload
      const db = getDb()

      // DB-first：有足够历史直接返回（≥20 条）
      const cached = queryFactorHistory(db, tsCode, startDate)
      if (cached.length >= 20) return { ok: true as const, data: cached }
      if (payload.dbOnly) return { ok: true as const, data: cached }

      // 缓存不足时从 Tushare API 拉取
      const dsConfig = getDataSourceConfig(db)
      if (!dsConfig.tushareEnabled || !dsConfig.tushareTokenEncrypted)
        return { ok: false as const, code: 'TUSHARE_DISABLED' as const }

      const key = `${tsCode}|${startDate}`
      const token = decryptApiKey(dsConfig.tushareTokenEncrypted)
      if (!token) return { ok: false as const, code: 'TUSHARE_DISABLED' as const }
      let promise = factorHistoryInflight.get(key)
      if (!promise) {
        promise = (async () => {
          const rows = await fetchStkFactorProHistory(token, tsCode, startDate)
          if (rows.length > 0) upsertFactorBatch(db, rows)
          return rows
        })().finally(() => factorHistoryInflight.delete(key))
        factorHistoryInflight.set(key, promise)
      }

      try {
        const rows = await promise
        if (rows.length > 0) return { ok: true as const, data: rows }
        // API 返回空时以 DB 现有数据兜底
        if (cached.length > 0) return { ok: true as const, data: cached }
        return { ok: false as const, code: 'UPSTREAM_ERROR' as const }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('TUSHARE_QUOTA_INSUFFICIENT'))
          return { ok: false as const, code: 'TUSHARE_QUOTA_INSUFFICIENT' as const }
        if (cached.length > 0) return { ok: true as const, data: cached }
        return { ok: false as const, code: 'UPSTREAM_ERROR' as const }
      }
    }
  )

  // FR-153: 题材数据源切换
  ipcMain.handle('shortTerm:getConceptSource', () => {
    return { ok: true as const, source: getConceptSource() }
  })

  ipcMain.handle('shortTerm:setConceptSource', (_e, payload: { source: string }) => {
    if (!payload || !['kpl', 'ths', 'dc'].includes(payload.source)) {
      return { ok: false as const, error: 'INVALID_PARAM' as const }
    }
    setConceptSource(payload.source as 'kpl' | 'ths' | 'dc')
    clearConceptHeatCache()
    return { ok: true as const }
  })

  ipcMain.handle('shortTerm:syncConceptMembers', async (_e, payload: { source: string }) => {
    if (!payload || !['kpl', 'ths', 'dc'].includes(payload.source)) {
      return { ok: false as const, error: 'INVALID_PARAM' as const }
    }
    const db2 = getDb()
    const cfg = getDataSourceConfig(db2)
    if (!cfg.tushareEnabled || !cfg.tushareTokenEncrypted) {
      console.warn('[shortTerm:syncConceptMembers] Tushare 未配置，跳过同步')
      return { ok: false as const, error: 'TUSHARE_DISABLED' as const }
    }
    console.log(`[shortTerm:syncConceptMembers] 触发 source=${payload.source} 的题材成分同步`)
    void (async () => {
      try {
        await runConceptMembersSyncForSource(payload.source)
        console.log(`[shortTerm:syncConceptMembers] source=${payload.source} 同步完成`)
      } catch (err) {
        console.warn('[shortTerm:syncConceptMembers] error:', err)
      }
    })()
    return { ok: true as const }
  })

  // FR-153 临时诊断 IPC（排查 THS 数据写入问题，可在 DevTools console 调用）
  ipcMain.handle('shortTerm:diagnoseThs', (_e, payload?: { tsCode?: string }) => {
    const db2 = getDb()
    // 1. 行数
    const total = (db2.prepare('SELECT COUNT(*) as c FROM ths_concept_members').get() as { c: number }).c
    // 2. 前5条样本
    const samples = db2.prepare('SELECT ts_code, con_code, con_name FROM ths_concept_members LIMIT 5').all() as Array<{ ts_code: string; con_code: string; con_name: string | null }>
    // 3. ts_code 格式统计
    const stockFmt = (db2.prepare("SELECT COUNT(*) as c FROM ths_concept_members WHERE ts_code LIKE '%.SH' OR ts_code LIKE '%.SZ' OR ts_code LIKE '%.BJ'").get() as { c: number }).c
    const conceptFmt = (db2.prepare("SELECT COUNT(*) as c FROM ths_concept_members WHERE ts_code LIKE '%.TI'").get() as { c: number }).c
    // 4. concept_source 设置
    const srcRow = db2.prepare('SELECT concept_source FROM app_settings LIMIT 1').get() as { concept_source: string | null } | undefined
    const conceptSource = srcRow?.concept_source ?? 'unknown'
    // 5. 按指定 tsCode 查路由结果
    const testCode = payload?.tsCode ?? (samples[0]?.ts_code ?? '000001.SZ')
    const routedResult = getConceptsByStockRouted(db2, testCode, conceptSource as 'kpl' | 'ths' | 'dc')
    const result = { total, samples, stockFmt, conceptFmt, conceptSource, testCode, routedResult }
    console.log('[diagnoseThs]', JSON.stringify(result, null, 2))
    return { ok: true as const, ...result }
  })

  // FR-153: 查询各数据源的本地数据量（用于前端判断是否需要先同步）
  ipcMain.handle('shortTerm:getConceptDataStatus', () => {
    const db2 = getDb()
    const thsCount = countThsMembers(db2)
    const thsSyncedAt = getThsSyncedAt(db2)
    // DC 检查最近 7 天是否有数据
    let dcHasData = false
    const bj = new Date(Date.now() + 8 * 60 * 60 * 1000)
    for (let i = 0; i < 7; i++) {
      const d = new Date(bj.getTime() - i * 86400000)
      const ymd = d.toISOString().slice(0, 10).replace(/-/g, '')
      if (hasDcDataForDate(db2, ymd)) { dcHasData = true; break }
    }
    console.log(`[getConceptDataStatus] thsCount=${thsCount}, thsSyncedAt=${thsSyncedAt}, dcHasData=${dcHasData}`)
    return { ok: true as const, thsCount, thsSyncedAt, dcHasData }
  })

  // 查询单只股票所属题材列表（供走势图标题行展示）
  ipcMain.handle('shortTerm:getStockConcepts', (_e, payload: { tsCode: string }) => {
    if (!payload?.tsCode) return { ok: false as const, error: 'INVALID_PARAM' as const }
    const db2 = getDb()
    const conceptSource = getConceptSource()
    try {
      const entries = getConceptsByStockRouted(db2, payload.tsCode, conceptSource)
      const names = entries.slice(0, 8).map(e => e.conceptName)
      return { ok: true as const, names }
    } catch {
      return { ok: true as const, names: [] }
    }
  })

  // ── FR-156 筹码监控 ────────────────────────────────────────────────────────

  /**
   * shortTerm:chipMonitor:start — 启动筹码监控同步 job
   * fire-and-forget: IPC 立即返回，job 进度通过 push 事件推送
   */
  ipcMain.handle(
    'shortTerm:chipMonitor:start',
    async (
      _e,
      payload?: {
        stocks?: { tsCode: string; stockName: string | null; source: 'screener' | 'watchlist' | 'morningAuction' | 'portfolio' }[]
        mode?: 'relative' | 'absolute'
        source?: 'screener' | 'watchlist' | 'morningAuction' | 'portfolio'
      }
    ) => {
      const db2 = getDb()
      const dsConfig = getDataSourceConfig(db2)
      if (!dsConfig.tushareEnabled || !dsConfig.tushareTokenEncrypted) {
        return { ok: false as const, error: 'TUSHARE_DISABLED' }
      }
      if (isChipMonitorJobRunning()) {
        return { ok: false as const, error: 'JOB_RUNNING' }
      }
      const token = decryptApiKey(dsConfig.tushareTokenEncrypted)
      if (!token) {
        return { ok: false as const, error: 'TUSHARE_DISABLED' }
      }
      let runSource = payload?.source

      // 若传入了 stocks，按来源替换对应的监控股池（screener/morningAuction 分别独立）
      if (payload?.stocks && payload.stocks.length > 0) {
        const now = Date.now()
        // 以第一条的 source 作为本批次来源（同一批必须来源相同）
        const batchSource = payload.stocks[0].source ?? 'screener'
        runSource = batchSource
        replaceMonitorStocksBySource(
          db2,
          batchSource,
          payload.stocks.map((s) => ({ ...s, addedAt: now }))
        )
      }

      const win = BrowserWindow.getAllWindows()[0] ?? undefined
      // fire-and-forget
      void runChipMonitorJob(db2, token, win, payload?.mode ?? 'relative', runSource).catch((err) => {
        console.warn('[chipMonitor:start] job error:', err)
      })
      return { ok: true as const }
    }
  )

  /** shortTerm:chipMonitor:getStocks — 返回当前监控股池 */
  ipcMain.handle('shortTerm:chipMonitor:getStocks', () => {
    return { ok: true as const, stocks: getMonitorStocks(getDb()) }
  })

  /** shortTerm:chipMonitor:getResults — 返回各股最新筹码监控结果
   *  盘中用 sharedRtKCache.price 覆盖 currentPrice（60s 新鲜度），盘后 fallback DB close
   */
  ipcMain.handle('shortTerm:chipMonitor:getResults', (_e, payload?: { mode?: 'relative' | 'absolute' }) => {
    const mode = payload?.mode === 'absolute' ? 'absolute' : 'relative'
    const results = getLatestMonitorResults(getDb(), mode)
    const rtCache = getRtKCache()
    if (rtCache) {
      for (const r of results) {
        const entry = rtCache.get(r.tsCode)
        if (entry?.price != null) r.currentPrice = entry.price
      }
    }
    return { ok: true as const, results }
  })

  /** shortTerm:chipMonitor:syncWatchlist — 将关注节监投的股票全量同步到监控股池 */
  ipcMain.handle(
    'shortTerm:chipMonitor:syncWatchlist',
    (_e, payload: { stocks: { tsCode: string; stockName: string | null }[] }) => {
      if (!payload?.stocks) return { ok: false as const, error: 'INVALID_PARAM' }
      const now = Date.now()
      replaceMonitorStocksBySource(
        getDb(),
        'watchlist',
        payload.stocks.map((s) => ({ tsCode: s.tsCode, source: 'watchlist' as const, stockName: s.stockName, addedAt: now }))
      )
      return { ok: true as const }
    }
  )

  /** shortTerm:chipMonitor:syncPortfolio — 将持仓股票同步到监控股池 */
  ipcMain.handle('shortTerm:chipMonitor:syncPortfolio', () => {
    const db2 = getDb()
    const now = Date.now()
    const portfolioStocks = listPortfolioStocks(db2)
    replaceMonitorStocksBySource(
      db2,
      'portfolio',
      portfolioStocks.map((s) => ({
        tsCode: s.tsCode,
        source: 'portfolio' as const,
        stockName: s.stockName,
        addedAt: now,
      }))
    )
    return { ok: true as const, count: portfolioStocks.length }
  })

  /**
   * shortTerm:chipMonitor:recompute — 仅用 DB 现有数据重算底部筹码指标，不发起任何 API 请求。
   * 适用于用户切换「相对低位/绝对低位」模式时立即重算，无进度条。
   */
  ipcMain.handle(
    'shortTerm:chipMonitor:recompute',
    (_e, payload?: { mode?: 'relative' | 'absolute' }) => {
      const result = recomputeChipMonitorResults(getDb(), payload?.mode ?? 'relative')
      return { ok: true as const, ...result }
    }
  )

  // ─── FR-159 竞价回测 IPC ─────────────────────────────────────────────

  /** shortTerm:backtest:run — 触发回测同步（fire-and-forget，防重入） */
  ipcMain.handle('shortTerm:backtest:run', (_e, payload?: { days?: number; force?: boolean }) => {
    const db2 = getDb()
    const dsConfig = getDataSourceConfig(db2)
    if (!dsConfig.tushareEnabled || !dsConfig.tushareTokenEncrypted) {
      return { ok: false as const, error: 'TUSHARE_DISABLED' }
    }
    if (isBacktestRunning()) {
      return { ok: false as const, error: 'JOB_RUNNING' }
    }
    const token = decryptApiKey(dsConfig.tushareTokenEncrypted)
    if (!token) {
      return { ok: false as const, error: 'TUSHARE_DISABLED' }
    }
    const days = payload?.days ?? 90
    const force = payload?.force ?? false
    const win = BrowserWindow.getAllWindows()[0] ?? undefined
    void runBacktestSync(db2, token, days, win, force).catch((err) => {
      console.warn('[shortTerm:backtest:run] error:', err)
    })
    return { ok: true as const }
  })

  /** shortTerm:backtest:getStatus — 返回运行状态和已有回测日期 */
  ipcMain.handle('shortTerm:backtest:getStatus', () => {
    const db2 = getDb()
    const running = isBacktestRunning()
    const computedDates = getComputedDates(db2)
    const availableDates = getAvailableDates(db2, 90)
    const latestCloseTradeDate = getLatestDailyCloseTradeDate(db2)
    return { ok: true as const, running, computedDates, availableDates, latestCloseTradeDate }
  })

  /** shortTerm:backtest:getDetails — 按日期范围查明细 */
  ipcMain.handle(
    'shortTerm:backtest:getDetails',
    (_e, payload: { startDate: string; endDate: string }) => {
      if (!payload?.startDate || !payload?.endDate) {
        return { ok: false as const, error: 'INVALID_PARAM' }
      }
      const db2 = getDb()
      repairBacktestDetailsFromLocalDaily(db2, {
        startDate: payload.startDate,
        endDate: payload.endDate,
      })
      const details = queryDetails(db2, { startDate: payload.startDate, endDate: payload.endDate })
      return { ok: true as const, details }
    }
  )
}

/** 复用：北京时间今日 YYYYMMDD */
function getBjTodayYmd(): string {
  const bj = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const y = bj.getUTCFullYear()
  const m = String(bj.getUTCMonth() + 1).padStart(2, '0')
  const d = String(bj.getUTCDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

/** 北京时间昨日 YYYYMMDD（用于 API 冷启动：今日盘后数据收盘前无法获取） */
function getBjYesterdayYmd(): string {
  const bj = new Date(Date.now() + 8 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000)
  const y = bj.getUTCFullYear()
  const m = String(bj.getUTCMonth() + 1).padStart(2, '0')
  const d = String(bj.getUTCDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

/**
 * 查 limit_list_daily 中最新一个交易日，作为筹码/因子 API 请求日期。
 * 比 getBjYesterdayYmd() 更可靠：周末/节假日 getBjYesterdayYmd() 返回非交易日，
 * Tushare 对非交易日返回空数组，导致数据永远拉不到。
 * fallback：limit_list_daily 无数据时退化为日历昨日。
 */
function getLatestTradeDateYmd(db: ReturnType<typeof getDb>): string {
  const row = db
    .prepare('SELECT MAX(trade_date) AS d FROM limit_list_daily')
    .get() as { d: string | null } | undefined
  return row?.d ?? getBjYesterdayYmd()
}
