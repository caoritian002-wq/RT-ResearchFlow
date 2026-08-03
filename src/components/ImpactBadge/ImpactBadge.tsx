import type { ImpactRating } from '../../../electron/main/database/types'

interface Props {
  rating: ImpactRating
}

const LABELS: Record<ImpactRating, string> = {
  CRITICAL: '重大',
  IMPORTANT: '重要',
  GENERAL: '一般'
}

export function ImpactBadge({ rating }: Props) {
  return (
    <span
      className={
        rating === 'CRITICAL'
          ? 'impact-badge-critical'
          : rating === 'IMPORTANT'
          ? 'impact-badge-important'
          : 'impact-badge-general'
      }
    >
      {LABELS[rating]}
    </span>
  )
}
