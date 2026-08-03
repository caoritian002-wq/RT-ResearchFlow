import { useCallback, useEffect, useState } from 'react'

export interface IndexQuote {
  code: string
  name: string
  price: number
  change: number
}

const INDEX_CONFIG = [
  { code: '000001.SH', name: '上证' },
  { code: '399001.SZ', name: '深成' },
  { code: '399006.SZ', name: '创业板' }
]

export function useMarketIndexQuotes() {
  const [quotes, setQuotes] = useState<IndexQuote[]>([])
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)

  const refreshQuotes = useCallback(async () => {
    const results = await Promise.allSettled(
      INDEX_CONFIG.map(async (idx) => {
        const resp = (await window.api.datasource.getIntradayData(idx.code)) as { items?: { time: string; price: number }[] }
        const items = resp?.items
        if (!items || items.length < 2) return null
        const firstPrice = items[0].price
        const lastPrice = items[items.length - 1].price
        if (!firstPrice || !lastPrice) return null
        return {
          code: idx.code,
          name: idx.name,
          price: lastPrice,
          change: ((lastPrice - firstPrice) / firstPrice) * 100
        } satisfies IndexQuote
      })
    )
    const nextQuotes = results
      .filter((result): result is PromiseFulfilledResult<IndexQuote | null> => result.status === 'fulfilled')
      .map(result => result.value)
      .filter((quote): quote is IndexQuote => quote !== null)
    if (nextQuotes.length > 0) {
      setQuotes(nextQuotes)
      setUpdatedAt(Date.now())
    }
  }, [])

  useEffect(() => {
    void refreshQuotes()
    const timer = setInterval(() => { void refreshQuotes() }, 60_000)
    return () => clearInterval(timer)
  }, [refreshQuotes])

  return { quotes, updatedAt, refreshQuotes }
}

export function quoteColor(change: number): string {
  if (change > 0) return 'text-red-500'
  if (change < 0) return 'text-green-500'
  return 'text-slate-500 dark:text-slate-400'
}