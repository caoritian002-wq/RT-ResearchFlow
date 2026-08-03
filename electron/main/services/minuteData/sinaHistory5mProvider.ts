import type { MinuteBarForCondition } from '../conditionBlocks/types'
import { getFreeMinuteCacheByDate, upsertFreeMinuteCache } from '../../database/freeMinuteCacheRepository'
import type { FreeMinuteCacheRow } from '../../database/types'
import type { MinuteDataProvider, MinuteDataRequest, MinuteDataResult } from './minuteDataTypes'

interface SinaKlineRow {
  day?: string
  open?: string | number
  high?: string | number
  low?: string | number
  close?: string | number
  volume?: string | number
}

function toSinaSymbol(tsCode: string): string {
  const pure = tsCode.replace(/\.(SH|SZ|BJ)$/i, '')
  if (pure.startsWith('6') || pure.startsWith('9')) return `sh${pure}`
  return `sz${pure}`
}

function toNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

function normalizeTradeDate(day: string | undefined): string | null {
  if (!day) return null
  const datePart = day.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null
  return datePart.replace(/-/g, '')
}

function normalizeMinute(day: string | undefined): string | null {
  if (!day) return null
  const match = day.match(/\s(\d{2}:\d{2})/)
  return match?.[1] ?? null
}

function mapRows(tsCode: string, tradeDate: string, rows: SinaKlineRow[]): MinuteBarForCondition[] {
  const bars: MinuteBarForCondition[] = []
  for (const row of rows) {
    if (normalizeTradeDate(row.day) !== tradeDate) continue
    const tsMinute = normalizeMinute(row.day)
    const close = toNum(row.close)
    if (!tsMinute || close == null) continue
    bars.push({
      tsCode,
      tradeDate,
      tsMinute,
      open: toNum(row.open),
      high: toNum(row.high),
      low: toNum(row.low),
      close,
      vol: toNum(row.volume),
      amount: null,
    })
  }
  return bars.sort((a, b) => a.tsMinute.localeCompare(b.tsMinute))
}

const sinaHistory5mCapability = {
  providerId: 'sinaHistory5m',
  label: '新浪历史5分钟',
  source: 'localFree' as const,
  granularity: '5m' as const,
  historyDepthDays: 120,
  coverage: 'allMarket' as const,
  reliability: 'approximate' as const,
  isApproximate: true,
  requiresCredential: false,
  isCloud: false,
  enabled: true,
  note: '免费历史分钟近似能力, 不等同于1分钟精确扫描',
}

function fromCacheRows(rows: ReturnType<typeof getFreeMinuteCacheByDate>): MinuteBarForCondition[] {
  return rows.map(row => ({
    tsCode: row.tsCode,
    tradeDate: row.tradeDate,
    tsMinute: row.tsMinute,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    vol: row.vol,
    amount: row.amount,
  }))
}

function toCacheRows(bars: MinuteBarForCondition[], fetchedAt: number): FreeMinuteCacheRow[] {
  const rows: FreeMinuteCacheRow[] = []
  for (const bar of bars) {
    if (bar.close == null) continue
    rows.push({
      providerId: sinaHistory5mCapability.providerId,
      tsCode: bar.tsCode,
      tradeDate: bar.tradeDate,
      granularity: sinaHistory5mCapability.granularity,
      tsMinute: bar.tsMinute,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      vol: bar.vol,
      amount: bar.amount,
      fetchedAt,
    })
  }
  return rows
}

export const sinaHistory5mProvider: MinuteDataProvider = {
  capability: sinaHistory5mCapability,
  async fetchBars(request: MinuteDataRequest): Promise<MinuteDataResult> {
    const cached = getFreeMinuteCacheByDate(request.db, sinaHistory5mCapability.providerId, request.tsCode, request.tradeDate, sinaHistory5mCapability.granularity)
    if (cached.length > 0) {
      return { status: 'success', bars: fromCacheRows(cached), capability: sinaHistory5mCapability, message: '命中本地5分钟基础缓存' }
    }
    const url = new URL('https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData')
    url.searchParams.set('symbol', toSinaSymbol(request.tsCode))
    url.searchParams.set('scale', '5')
    url.searchParams.set('ma', 'no')
    url.searchParams.set('datalen', '3000')
    try {
      const res = await fetch(url.toString(), {
        headers: {
          Referer: 'https://finance.sina.com.cn/',
          'User-Agent': 'Mozilla/5.0',
        },
      })
      if (!res.ok) {
        return { status: 'failed', bars: [], capability: sinaHistory5mCapability, message: `HTTP ${res.status}` }
      }
      const text = await res.text()
      if (!text.trim() || text.trim() === 'null') {
        return { status: 'empty', bars: [], capability: sinaHistory5mCapability, message: '新浪5分钟接口返回空数据' }
      }
      const parsed = JSON.parse(text) as SinaKlineRow[]
      const bars = Array.isArray(parsed) ? mapRows(request.tsCode, request.tradeDate, parsed) : []
      if (bars.length > 0) upsertFreeMinuteCache(request.db, toCacheRows(bars, Date.now()))
      return {
        status: bars.length > 0 ? 'success' : 'empty',
        bars,
        capability: sinaHistory5mCapability,
        message: bars.length > 0 ? undefined : '新浪5分钟接口未返回目标交易日数据',
      }
    } catch (err) {
      return { status: 'failed', bars: [], capability: sinaHistory5mCapability, message: err instanceof Error ? err.message : String(err) }
    }
  },
}

export const __privateForMinuteDataTests = {
  mapRows,
  toSinaSymbol,
}
