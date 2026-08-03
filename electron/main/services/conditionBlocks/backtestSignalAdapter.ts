import type { BacktestSignal } from '../backtest/types'
import type { ConditionBlockMatchRow } from '../../database/types'

export function conditionMatchToBacktestSignal(match: ConditionBlockMatchRow): BacktestSignal {
  return {
    strategyKey: `conditionBlock.${match.templateKey}`,
    tsCode: match.tsCode,
    tradeDate: match.tradeDate,
    strength: Math.max(0, Math.min(100, match.totalScore)),
    meta: {
      conditionTemplateKey: match.templateKey,
      templateVersion: match.templateVersion,
      matchId: match.id,
      windowStart: match.windowStart,
      windowEnd: match.windowEnd,
      dataStatus: match.dataStatus,
      evidence: match.evidenceJson,
    },
  }
}
