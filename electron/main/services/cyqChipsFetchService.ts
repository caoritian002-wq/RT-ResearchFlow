import { fetchCyqChips, type CyqChipsRow } from './tushareService'

const inFlight = new Map<string, Promise<CyqChipsRow[]>>()

export function fetchCyqChipsSingleflight(
  token: string,
  tsCode: string,
  tradeDate?: string,
): Promise<CyqChipsRow[]> {
  const key = `${tsCode.trim().toUpperCase()}|${tradeDate ?? '*'}`
  const existing = inFlight.get(key)
  if (existing) return existing

  const request = fetchCyqChips(token, tsCode, tradeDate).finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, request)
  return request
}