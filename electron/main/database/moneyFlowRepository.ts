import type Database from 'better-sqlite3'
import type { MoneyFlowDailyRow } from './types'

interface DbMoneyFlowRow {
  ts_code: string
  trade_date: string
  buy_sm_vol: number | null
  buy_sm_amount: number | null
  sell_sm_vol: number | null
  sell_sm_amount: number | null
  buy_md_vol: number | null
  buy_md_amount: number | null
  sell_md_vol: number | null
  sell_md_amount: number | null
  buy_lg_vol: number | null
  buy_lg_amount: number | null
  sell_lg_vol: number | null
  sell_lg_amount: number | null
  buy_elg_vol: number | null
  buy_elg_amount: number | null
  sell_elg_vol: number | null
  sell_elg_amount: number | null
  net_mf_vol: number | null
  net_mf_amount: number | null
  fetched_at: number
}

export interface MoneyFlowSummary {
  source: 'real' | 'estimated' | 'none'
  mainNetInflow: number | null
  mainNetInflowRatio: number | null
  netMfAmount: number | null
  detail?: {
    small: { buy: number | null; sell: number | null }
    medium: { buy: number | null; sell: number | null }
    large: { buy: number | null; sell: number | null }
    extraLarge: { buy: number | null; sell: number | null }
  }
}

function toYuan(value: number | null | undefined): number | null {
  return value == null ? null : value * 10000
}

function fromYuan(value: number | null | undefined): number | null {
  return value == null ? null : value / 10000
}

function toDbRow(row: MoneyFlowDailyRow): DbMoneyFlowRow {
  return {
    ts_code: row.tsCode,
    trade_date: row.tradeDate,
    buy_sm_vol: row.buySmVol,
    buy_sm_amount: toYuan(row.buySmAmount),
    sell_sm_vol: row.sellSmVol,
    sell_sm_amount: toYuan(row.sellSmAmount),
    buy_md_vol: row.buyMdVol,
    buy_md_amount: toYuan(row.buyMdAmount),
    sell_md_vol: row.sellMdVol,
    sell_md_amount: toYuan(row.sellMdAmount),
    buy_lg_vol: row.buyLgVol,
    buy_lg_amount: toYuan(row.buyLgAmount),
    sell_lg_vol: row.sellLgVol,
    sell_lg_amount: toYuan(row.sellLgAmount),
    buy_elg_vol: row.buyElgVol,
    buy_elg_amount: toYuan(row.buyElgAmount),
    sell_elg_vol: row.sellElgVol,
    sell_elg_amount: toYuan(row.sellElgAmount),
    net_mf_vol: row.netMfVol,
    net_mf_amount: toYuan(row.netMfAmount),
    fetched_at: row.fetchedAt,
  }
}

function fromDbRow(row: DbMoneyFlowRow): MoneyFlowDailyRow {
  return {
    tsCode: row.ts_code,
    tradeDate: row.trade_date,
    buySmVol: row.buy_sm_vol,
    buySmAmount: fromYuan(row.buy_sm_amount),
    sellSmVol: row.sell_sm_vol,
    sellSmAmount: fromYuan(row.sell_sm_amount),
    buyMdVol: row.buy_md_vol,
    buyMdAmount: fromYuan(row.buy_md_amount),
    sellMdVol: row.sell_md_vol,
    sellMdAmount: fromYuan(row.sell_md_amount),
    buyLgVol: row.buy_lg_vol,
    buyLgAmount: fromYuan(row.buy_lg_amount),
    sellLgVol: row.sell_lg_vol,
    sellLgAmount: fromYuan(row.sell_lg_amount),
    buyElgVol: row.buy_elg_vol,
    buyElgAmount: fromYuan(row.buy_elg_amount),
    sellElgVol: row.sell_elg_vol,
    sellElgAmount: fromYuan(row.sell_elg_amount),
    netMfVol: row.net_mf_vol,
    netMfAmount: fromYuan(row.net_mf_amount),
    fetchedAt: row.fetched_at,
  }
}

function normalizeTsCode(tsCode: string): string {
  const trimmed = tsCode.trim().toUpperCase()
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(trimmed)) return trimmed
  const code = trimmed.replace(/\.(SH|SZ|BJ)$/i, '')
  if (code.startsWith('6') || code.startsWith('9')) return `${code}.SH`
  if (code.startsWith('8') || code.startsWith('4')) return `${code}.BJ`
  return `${code}.SZ`
}

function scalar(value: number | null | undefined): number {
  return Number.isFinite(value) ? value as number : 0
}

export function upsertMoneyFlowRows(db: Database.Database, rows: MoneyFlowDailyRow[]): void {
  if (rows.length === 0) return
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO stock_moneyflow_daily (
      ts_code, trade_date,
      buy_sm_vol, buy_sm_amount, sell_sm_vol, sell_sm_amount,
      buy_md_vol, buy_md_amount, sell_md_vol, sell_md_amount,
      buy_lg_vol, buy_lg_amount, sell_lg_vol, sell_lg_amount,
      buy_elg_vol, buy_elg_amount, sell_elg_vol, sell_elg_amount,
      net_mf_vol, net_mf_amount, fetched_at
    ) VALUES (
      @ts_code, @trade_date,
      @buy_sm_vol, @buy_sm_amount, @sell_sm_vol, @sell_sm_amount,
      @buy_md_vol, @buy_md_amount, @sell_md_vol, @sell_md_amount,
      @buy_lg_vol, @buy_lg_amount, @sell_lg_vol, @sell_lg_amount,
      @buy_elg_vol, @buy_elg_amount, @sell_elg_vol, @sell_elg_amount,
      @net_mf_vol, @net_mf_amount, @fetched_at
    )`
  )
  const runAll = db.transaction((items: DbMoneyFlowRow[]) => {
    for (const item of items) stmt.run(item)
  })
  runAll(rows.map(toDbRow))
}

export function getMoneyFlowByDate(db: Database.Database, tradeDate: string, tsCode: string): MoneyFlowDailyRow | null {
  const row = db.prepare(
    `SELECT * FROM stock_moneyflow_daily WHERE trade_date = ? AND ts_code = ?`
  ).get(tradeDate, normalizeTsCode(tsCode)) as DbMoneyFlowRow | undefined
  return row ? fromDbRow(row) : null
}

export function getMoneyFlowMapByDate(db: Database.Database, tradeDate: string): Map<string, MoneyFlowDailyRow> {
  const rows = db.prepare(
    `SELECT * FROM stock_moneyflow_daily WHERE trade_date = ?`
  ).all(tradeDate) as DbMoneyFlowRow[]
  const map = new Map<string, MoneyFlowDailyRow>()
  for (const row of rows) {
    const parsed = fromDbRow(row)
    map.set(parsed.tsCode, parsed)
    map.set(parsed.tsCode.split('.')[0], parsed)
  }
  return map
}

export function countMoneyFlowByDate(db: Database.Database, tradeDate: string): number {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM stock_moneyflow_daily WHERE trade_date = ?').get(tradeDate) as { cnt: number } | undefined
  return row?.cnt ?? 0
}

export function buildMoneyFlowSummary(row: MoneyFlowDailyRow | null, amountYuan: number | null): MoneyFlowSummary | null {
  if (!row) return null
  const buyLg = toYuan(row.buyLgAmount)
  const buyElg = toYuan(row.buyElgAmount)
  const sellLg = toYuan(row.sellLgAmount)
  const sellElg = toYuan(row.sellElgAmount)
  const mainNetInflow = scalar(buyLg) + scalar(buyElg) - scalar(sellLg) - scalar(sellElg)
  const ratio = amountYuan != null && amountYuan > 0 ? (mainNetInflow / amountYuan) * 100 : null
  return {
    source: 'real',
    mainNetInflow,
    mainNetInflowRatio: ratio,
    netMfAmount: toYuan(row.netMfAmount),
    detail: {
      small: { buy: toYuan(row.buySmAmount), sell: toYuan(row.sellSmAmount) },
      medium: { buy: toYuan(row.buyMdAmount), sell: toYuan(row.sellMdAmount) },
      large: { buy: buyLg, sell: sellLg },
      extraLarge: { buy: buyElg, sell: sellElg },
    },
  }
}

/**
 * 估算占位：无真实 moneyflow（盘中未发布 / 无 Tushare 权限）时使用。
 * 保守口径——不编造主力净流入数值（全 null），仅标记 source='estimated'，
 * 由前端结合真实成交额与涨跌方向展示参考，且不触发资金信号命中。
 */
export function buildEstimatedMoneyFlowSummary(): MoneyFlowSummary {
  return {
    source: 'estimated',
    mainNetInflow: null,
    mainNetInflowRatio: null,
    netMfAmount: null,
  }
}
