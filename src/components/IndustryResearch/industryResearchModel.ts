import type {
  ResearchEvidence,
  ResearchEvidenceDraft,
  ResearchGraph,
  ResearchHypothesis,
  ResearchHypothesisDraft,
  ResearchProject,
  ResearchReportFinding,
  ResearchReportFindingInput,
} from './industryResearchTypes'

export interface ResearchCounts {
  nodes: number
  edges: number
  facts: number
  estimates: number
  hypotheses: number
  openHypotheses: number
  conflicts: number
}

export function buildResearchCounts(
  graph: ResearchGraph | null,
  evidence: ResearchEvidence[],
  hypotheses: ResearchHypothesis[],
): ResearchCounts {
  return {
    nodes: graph?.nodes.length ?? 0,
    edges: graph?.edges.length ?? 0,
    facts: evidence.filter((item) => item.statement_kind === 'fact').length,
    estimates: evidence.filter((item) => item.statement_kind === 'estimate').length,
    hypotheses: hypotheses.length,
    openHypotheses: hypotheses.filter((item) => item.status === 'open' || item.status === 'reopened').length,
    conflicts: evidence.filter((item) => Boolean(item.conflict_note)).length,
  }
}

export function projectReviewReasons(project: ResearchProject, counts: ResearchCounts): string[] {
  const reasons: string[] = []
  if (project.status === 'review_due') reasons.push('研究边界已变化，需要重新核对事实和假设')
  if (!project.data_as_of) reasons.push('尚未登记数据截止日')
  if (!counts.facts) reasons.push('尚无经过来源确认的事实证据')
  if (counts.conflicts) reasons.push(`存在 ${counts.conflicts} 条来源冲突，正式采用前需要核对`)
  if (counts.openHypotheses) reasons.push(`仍有 ${counts.openHypotheses} 条开放假设待验证`)
  return reasons
}

export function validateEvidenceDraft(draft: ResearchEvidenceDraft): string | null {
  if (!draft.title.trim()) return '证据标题不能为空'
  if (!draft.sourceName.trim()) return '来源名称不能为空'
  if (draft.statementKind === 'fact') {
    if (!draft.sourceUrl.trim() && !draft.sourceRef.trim()) return '事实必须填写原始来源网址或来源编号'
    if (!draft.primarySourceConfirmed) return '事实必须由人工确认原始来源'
  }
  return null
}

export function validateHypothesisDraft(draft: ResearchHypothesisDraft): string | null {
  if (!draft.statement.trim()) return '假设陈述不能为空'
  if (!draft.cheapestDisproof.trim()) return '最低成本反证不能为空'
  if (!Number.isInteger(draft.importance) || draft.importance < 1 || draft.importance > 5) return '重要性必须为 1 至 5'
  return null
}

export function formatResearchDate(value: number | string | null | undefined): string {
  if (value == null || value === '') return '未设置'
  if (typeof value === 'string') {
    if (/^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    return value
  }
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

export function normalizeResearchReportFindings(
  findings: ResearchReportFindingInput[] | null | undefined,
): ResearchReportFinding[] {
  if (!Array.isArray(findings)) return []
  return findings.flatMap((finding) => {
    if (typeof finding === 'string') {
      const text = finding.trim()
      return text ? [{ text, candidateIds: [] }] : []
    }
    const text = typeof finding?.text === 'string' ? finding.text.trim() : ''
    if (!text) return []
    const candidateIds = Array.isArray(finding.candidateIds)
      ? [...new Set(finding.candidateIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))]
      : []
    return [{ text, candidateIds }]
  })
}
