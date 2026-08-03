import type { StockDecisionContextModel } from './stockDecisionContextModel'

interface StockDecisionEvidenceProps {
  evidence: StockDecisionContextModel['evidence']
}

function evidenceClass(tone: StockDecisionContextModel['evidence'][number]['tone']): string {
  if (tone === 'good') return 'text-emerald-700 dark:text-emerald-300'
  if (tone === 'warn') return 'text-amber-700 dark:text-amber-300'
  return 'text-gray-700 dark:text-gray-200'
}

export function StockDecisionEvidence({ evidence }: StockDecisionEvidenceProps) {
  return (
    <div data-testid="stock-decision-evidence" className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
      {evidence.map((item) => (
        <div key={item.label} className="rounded border border-gray-100 px-2 py-1.5 text-xs dark:border-gray-800">
          <div className="text-[11px] text-gray-400 dark:text-gray-500">{item.label}</div>
          <div className={`mt-0.5 font-medium ${evidenceClass(item.tone)}`}>{item.value}</div>
        </div>
      ))}
    </div>
  )
}
