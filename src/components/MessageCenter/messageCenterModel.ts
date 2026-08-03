export type MessageTone = 'info' | 'success' | 'warning' | 'danger'

export interface MessageCenterItem {
  id: string
  title: string
  description: string
  source: string
  timeLabel?: string
  tone: MessageTone
  actionLabel?: string
  onAction?: () => void
}

export function formatBjTime(ms: number | null | undefined): string {
  if (!ms) return '暂无'
  const bjMs = ms + 8 * 60 * 60 * 1000
  const date = new Date(bjMs)
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const mm = String(date.getUTCMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}