/** 判断当前时刻是否在 A 股交易时段（周一~周五 09:15–11:30、13:00–15:00 北京时间） */
export function isInTradingHours(): boolean {
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const day = bjNow.getUTCDay()
  if (day < 1 || day > 5) return false
  const totalMin = bjNow.getUTCHours() * 60 + bjNow.getUTCMinutes()
  return (totalMin >= 9 * 60 + 15 && totalMin < 11 * 60 + 30)
      || (totalMin >= 13 * 60 && totalMin < 15 * 60)
}
