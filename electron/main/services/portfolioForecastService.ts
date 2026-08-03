import type Database from 'better-sqlite3'
import type { BrowserWindow } from 'electron'
import { listPortfolioStocks } from '../database/portfolioRepository'
import { getLatestForecasts } from '../database/trendForecastRepository'
import { performPredictTrendToday } from '../ipc/aiHandlers'

/** 获取当前北京时间的日期字符串 YYYY-MM-DD（用于判断当日去重） */
function getBjDateStr(): string {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** 判断某 UTC 毫秒时间戳是否属于今日（北京时间） */
function isTodayBj(createdAtMs: number): boolean {
  const d = new Date(createdAtMs + 8 * 60 * 60 * 1000)
  const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  return dateStr === getBjDateStr()
}

/** 防重入标志 */
let _running = false

/** 当前任务是否正在运行 */
export function isPortfolioForecastRunning(): boolean {
  return _running
}

/**
 * 持仓批量预测主任务.
 * 遍历 portfolio_stocks 中所有股票，跳过今日已有预测的，串行调用
 * performPredictTrendToday，每只间隔 500ms，单只超时 60s 则跳过并 warn.
 * 通过 win.webContents.send 向前端推送 portfolio:forecastProgress 事件.
 */
export async function runPortfolioForecastJob(
  db: Database.Database,
  win?: BrowserWindow | null
): Promise<void> {
  if (_running) {
    console.warn('[Portfolio] 批量预测任务已在运行，跳过本次触发')
    return
  }
  _running = true
  try {
    const stocks = listPortfolioStocks(db)
    if (stocks.length === 0) {
      console.log('[Portfolio] 持仓列表为空，跳过批量预测')
      return
    }

    // 过滤出今日尚未预测的股票
    const pending = stocks.filter(s => {
      try {
        const latest = getLatestForecasts(db, s.tsCode)
        if (latest.today && isTodayBj(latest.today.createdAt)) {
          console.log(`[Portfolio] ${s.tsCode} 今日已有预测，跳过`)
          return false
        }
      } catch {
        // 查询失败则继续尝试预测
      }
      return true
    })

    if (pending.length === 0) {
      console.log('[Portfolio] 所有持仓股票今日均已预测')
      return
    }

    console.log(`[Portfolio] 开始批量预测，共 ${pending.length} 只股票`)

    for (let i = 0; i < pending.length; i++) {
      const stock = pending[i]

      // 单只超时 60s 后跳过
      let ok = false
      let error: string | undefined
      try {
        const result = await Promise.race<{ ok: boolean; successCount: number; error?: { code: string; message: string } }>([
          performPredictTrendToday(db, stock.tsCode),
          new Promise<{ ok: boolean; successCount: number; error?: { code: string; message: string } }>(resolve =>
            setTimeout(() => resolve({ ok: false, successCount: 0, error: { code: 'TIMEOUT', message: '预测超时（60s）' } }), 60_000)
          ),
        ])
        ok = result.ok
        if (!result.ok && result.error) {
          error = `${result.error.code}: ${result.error.message}`
          console.warn(`[Portfolio] ${stock.tsCode} 预测失败: ${error}`)
        } else {
          console.log(`[Portfolio] ${stock.tsCode} 预测完成（successCount=${result.successCount}）`)
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
        console.warn(`[Portfolio] ${stock.tsCode} 预测异常: ${error}`)
      }

      // 推送进度事件
      if (win && !win.isDestroyed()) {
        win.webContents.send('portfolio:forecastProgress', {
          current: i + 1,
          total: pending.length,
          stockCode: stock.tsCode,
          ok,
          error,
        })
      }

      // 每只之间间隔 500ms（最后一只不等待）
      if (i < pending.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }

    console.log('[Portfolio] 批量预测任务完成')
  } finally {
    _running = false
  }
}
