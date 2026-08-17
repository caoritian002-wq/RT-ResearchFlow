export interface MorningAuctionProjectedStock {
  tsCode: string
  currentPrice: number | null
  currentPctChg: number | null
  currentAmount: number | null
}

export interface MorningAuctionCloseFact {
  close: number | null
  pctChg: number | null
}

export function isCurrentMorningAuctionTradeDate(
  tradeDate: string,
  currentTradeDate: string,
): boolean {
  return tradeDate === currentTradeDate
}

export function applyMorningAuctionCloseProjection(
  stocks: MorningAuctionProjectedStock[],
  closeFacts: ReadonlyMap<string, MorningAuctionCloseFact>,
  options: { replaceExisting: boolean },
): void {
  for (const stock of stocks) {
    const fact = closeFacts.get(stock.tsCode)
    if (options.replaceExisting) {
      stock.currentPrice = fact?.close ?? null
      stock.currentPctChg = fact?.pctChg ?? null
      stock.currentAmount = null
      continue
    }
    if (stock.currentPrice != null || fact?.close == null) continue
    stock.currentPrice = fact.close
    stock.currentPctChg = fact.pctChg
  }
}
