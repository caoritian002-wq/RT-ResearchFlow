import { ipcMain } from 'electron'
import { getDb } from '../database/db'
import { addPortfolioStock, removePortfolioStock, listPortfolioStocks, updatePortfolioCostPrice } from '../database/portfolioRepository'
import { getPortfolioDashboard } from '../services/portfolioDashboardService'
import { isPortfolioForecastRunning, runPortfolioForecastJob } from '../services/portfolioForecastService'

/** portfolio:list / add / remove / forecastNow IPC 处理器 */
export function registerPortfolioHandlers(getWindow: () => Electron.BrowserWindow | null): void {
  // 获取全部持仓股票列表
  ipcMain.handle('portfolio:list', (_e) => {
    try {
      const db = getDb()
      const rows = listPortfolioStocks(db)
      return { ok: true, data: rows.map(r => ({ tsCode: r.tsCode, stockName: r.stockName, addedAt: r.addedAt, costPrice: r.costPrice })) }
    } catch (err) {
      return { ok: false, code: 'DB_ERROR', message: err instanceof Error ? err.message : '查询失败' }
    }
  })

  // 添加股票到持仓
  ipcMain.handle('portfolio:add', (_e, { tsCode, stockName }: { tsCode: string; stockName: string }) => {
    if (!tsCode || typeof tsCode !== 'string') {
      return { ok: false, code: 'INVALID_PARAM', message: 'tsCode 无效' }
    }
    try {
      addPortfolioStock(getDb(), tsCode.trim(), (stockName ?? '').trim())
      return { ok: true }
    } catch (err) {
      return { ok: false, code: 'DB_ERROR', message: err instanceof Error ? err.message : '写入失败' }
    }
  })

  // 从持仓移除股票
  ipcMain.handle('portfolio:remove', (_e, { tsCode }: { tsCode: string }) => {
    if (!tsCode || typeof tsCode !== 'string') {
      return { ok: false, code: 'INVALID_PARAM', message: 'tsCode 无效' }
    }
    try {
      removePortfolioStock(getDb(), tsCode.trim())
      return { ok: true }
    } catch (err) {
      return { ok: false, code: 'DB_ERROR', message: err instanceof Error ? err.message : '删除失败' }
    }
  })

  // 更新用户手填成本价
  ipcMain.handle('portfolio:updateCostPrice', (_e, { tsCode, costPrice }: { tsCode: string; costPrice: number | null }) => {
    if (!tsCode || typeof tsCode !== 'string') {
      return { ok: false, code: 'INVALID_PARAM', message: 'tsCode 无效' }
    }
    if (costPrice != null && (!Number.isFinite(costPrice) || costPrice <= 0)) {
      return { ok: false, code: 'INVALID_PARAM', message: 'costPrice 必须为正数' }
    }
    try {
      const updated = updatePortfolioCostPrice(getDb(), tsCode.trim(), costPrice)
      return updated ? { ok: true } : { ok: false, code: 'NOT_FOUND', message: '持仓股票不存在' }
    } catch (err) {
      return { ok: false, code: 'DB_ERROR', message: err instanceof Error ? err.message : '写入失败' }
    }
  })

  // 获取持仓综合仪表盘数据
  ipcMain.handle('portfolio:getDashboard', async (_e, payload: { limit?: number; offset?: number } = {}) => {
    try {
      const db = getDb()
      const result = await getPortfolioDashboard(db, {
        limit: payload.limit,
        offset: payload.offset,
      })
      return { ok: true, data: result.items, total: result.total }
    } catch (err) {
      return { ok: false, code: 'DB_ERROR', message: err instanceof Error ? err.message : '查询失败' }
    }
  })

  // 手动触发批量预测（防重入）
  ipcMain.handle('portfolio:forecastNow', async (_e) => {
    if (isPortfolioForecastRunning()) {
      return { ok: false, code: 'ALREADY_RUNNING' }
    }
    const db = getDb()
    const stocks = listPortfolioStocks(db)
    if (stocks.length === 0) {
      return { ok: false, code: 'NO_STOCKS' }
    }
    // fire-and-forget，进度通过 portfolio:forecastProgress 事件推送
    void runPortfolioForecastJob(db, getWindow()).catch(err => {
      console.warn('[Portfolio] forecastNow 任务异常:', err)
    })
    return { ok: true }
  })
}
