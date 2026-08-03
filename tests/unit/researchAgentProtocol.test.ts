import { describe, expect, it } from 'vitest'
import {
  buildResearchAgentSynthesisMessages,
  RESEARCH_AGENT_PREVIOUS_PROMPT_RULE_VERSION,
  RESEARCH_AGENT_PROMPT_RULE_VERSION,
  type ResearchAgentPlanAction,
} from '../../electron/main/services/researchAgentProtocol'
import {
  buildMultiPerspectiveUnrestrictedModeratorMessages,
  MULTI_PERSPECTIVE_PREVIOUS_UNRESTRICTED_PROMPT_RULE_VERSION,
  MULTI_PERSPECTIVE_UNRESTRICTED_PROMPT_RULE_VERSION,
  type MultiPerspectiveConvergenceAction,
  type MultiPerspectiveUnrestrictedRoleAction,
} from '../../electron/main/services/researchMultiPerspectiveProtocol'

const PLAN: ResearchAgentPlanAction = {
  protocolVersion: 'single-agent.v1',
  action: 'plan',
  questions: ['核心问题是否已经得到回答？'],
  candidateTools: [],
  stopConditions: ['核心问题得到可追溯回答'],
  rationale: '测试综合语义。',
}

function singlePrompt(promptRuleVersion: string): string {
  return buildResearchAgentSynthesisMessages({
    question: '核心问题是否已经得到回答？',
    plan: PLAN,
    asOf: '20260802',
    persistedFacts: { evidenceDocuments: [], evidenceGate: { decision: 'local_sufficient' } },
    evidenceGate: { decision: 'local_sufficient' } as never,
    promptRuleVersion,
  })[0].content
}

function role(role: 'bull' | 'bear'): MultiPerspectiveUnrestrictedRoleAction {
  return {
    protocolVersion: 'multi-perspective.v2',
    action: 'position',
    role,
    thesis: '当前证据支持边界内结论。',
    claims: [{ id: 'P1', statement: '核心事实已确认。', evidenceRefs: ['E-1234567890'], confidence: 'medium' }],
    counterpoints: [],
    unknowns: ['未来正式披露仍未知。'],
    verificationItems: ['跟踪未来正式披露。'],
    rationale: '只使用父证据。',
  }
}

const CONVERGENCE: MultiPerspectiveConvergenceAction = {
  protocolVersion: 'multi-perspective.v2',
  action: 'assess_convergence',
  decision: 'finish',
  substantiveChanges: [],
  resolvedIssues: ['核心问题已经收敛。'],
  unresolvedIssues: ['未来事实尚未发生。'],
  focusAreas: [],
  rationale: '继续交锋不会增加事实。',
}

function moderatorPrompt(promptRuleVersion: string): string {
  return buildMultiPerspectiveUnrestrictedModeratorMessages({
    question: '核心问题是否已经得到回答？',
    asOf: '20260802',
    evidenceSnapshotSha256: 'a'.repeat(64),
    persistedFacts: { evidence: 'fixed' },
    allowedEvidenceReferences: ['E-1234567890'],
    roundCount: 2,
    convergence: CONVERGENCE,
    bull: role('bull'),
    bear: role('bear'),
    promptRuleVersion,
  })[0].content
}

describe('FR-256/257 conclusion coverage prompt semantics', () => {
  it('allows current single-agent runs to retain unknowns without automatically becoming partial', () => {
    const current = singlePrompt(RESEARCH_AGENT_PROMPT_RULE_VERSION)
    expect(current).toContain('outcome评价的是核心问题覆盖，不是未知项数量')
    expect(current).toContain('不得仅因存在未知项就降级')
    expect(current).toContain('partial仅用于一个或多个核心子问题仍无法回答')

    const previous = singlePrompt(RESEARCH_AGENT_PREVIOUS_PROMPT_RULE_VERSION)
    expect(previous).toContain('证据支持有限时返回partial')
    expect(previous).not.toContain('不得仅因存在未知项就降级')
  })

  it('uses the same core-question boundary for the current multi-perspective moderator', () => {
    const current = moderatorPrompt(MULTI_PERSPECTIVE_UNRESTRICTED_PROMPT_RULE_VERSION)
    expect(current).toContain('outcome评价的是核心问题覆盖，不是共识、分歧或未知项数量')
    expect(current).toContain('不得仅因存在未知项就降级')
    expect(current).toContain('只有父证据使一个或多个核心子问题仍无法回答时才返回partial')

    const previous = moderatorPrompt(MULTI_PERSPECTIVE_PREVIOUS_UNRESTRICTED_PROMPT_RULE_VERSION)
    expect(previous).not.toContain('不得仅因存在未知项就降级')
  })
})
