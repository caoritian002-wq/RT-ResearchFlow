import { describe, expect, it } from 'vitest'
import {
  buildMultiPerspectiveQualitySummary,
  parseMultiPerspectiveConvergenceAction,
  parseMultiPerspectiveModeratorAction,
  parseMultiPerspectiveRoleAction,
  parseMultiPerspectiveUnrestrictedModeratorAction,
  parseMultiPerspectiveUnrestrictedRoleAction,
  renderMultiPerspectiveReport,
} from '../../electron/main/services/researchMultiPerspectiveProtocol'

const REF_A = 'E-AAAAAAAAAA'
const REF_B = 'E-BBBBBBBBBB'
const ALLOWED = new Set([REF_A, REF_B])

function role(role: 'bull' | 'bear') {
  return {
    protocolVersion: 'multi-perspective.v1',
    action: 'position',
    role,
    thesis: role === 'bull' ? '证据支持积极路径仍成立。' : '证据显示结论仍有脆弱条件。',
    claims: [{ id: 'P1', statement: '已有事实可以追溯。', evidenceRefs: [REF_A], confidence: 'medium' }],
    counterpoints: [{ statement: '相反方向仍需额外验证。', evidenceRefs: [REF_B] }],
    unknowns: ['后续变化未知。'],
    verificationItems: ['核验下一期正式披露。'],
    rationale: '只使用固定证据。',
  }
}

function moderator() {
  return {
    protocolVersion: 'multi-perspective.v1',
    action: 'moderate',
    outcome: 'partial',
    conclusion: { statement: '当前证据支持有限共识，但核心条件仍有分歧。', evidenceRefs: [REF_A, REF_B] },
    consensus: [{ statement: '现有事实可以稳定追溯。', evidenceRefs: [REF_A] }],
    disagreements: [{
      topic: '事实外推范围',
      bullPosition: '积极路径仍可验证。',
      bearPosition: '当前覆盖不足以外推。',
      materiality: 'high',
      evidenceRefs: [REF_A, REF_B],
    }],
    unknowns: ['下一期正式披露尚未出现。'],
    verificationChecklist: [{ question: '正式披露是否确认趋势？', reason: '解决核心分歧', preferredSource: '交易所正式公告' }],
    rationale: '保留双方未解决分歧。',
  }
}

describe('FR-257 multi-perspective.v1 protocol', () => {
  it('accepts exact role and moderator schemas bound to allowed evidence references', () => {
    const bull = parseMultiPerspectiveRoleAction(JSON.stringify(role('bull')), 'bull', ALLOWED)
    const bear = parseMultiPerspectiveRoleAction(JSON.stringify(role('bear')), 'bear', ALLOWED)
    const moderated = parseMultiPerspectiveModeratorAction(JSON.stringify(moderator()), ALLOWED)
    expect(bull.role).toBe('bull')
    expect(bear.role).toBe('bear')
    expect(moderated.disagreements).toHaveLength(1)
  })

  it('blocks role mismatch, extra fields and references outside the immutable snapshot', () => {
    expect(() => parseMultiPerspectiveRoleAction(JSON.stringify(role('bear')), 'bull', ALLOWED))
      .toThrowError(expect.objectContaining({ code: 'ACTION_SCHEMA_INVALID' }))
    expect(() => parseMultiPerspectiveRoleAction(JSON.stringify({ ...role('bull'), extra: true }), 'bull', ALLOWED))
      .toThrowError(expect.objectContaining({ code: 'ACTION_SCHEMA_INVALID' }))
    const forged = role('bull')
    forged.claims[0].evidenceRefs = ['E-CCCCCCCCCC']
    expect(() => parseMultiPerspectiveRoleAction(JSON.stringify(forged), 'bull', ALLOWED))
      .toThrowError(expect.objectContaining({ code: 'EVIDENCE_REFERENCE_INVALID' }))
  })

  it('renders a deterministic report and a bounded structural quality comparison', () => {
    const bull = parseMultiPerspectiveRoleAction(JSON.stringify(role('bull')), 'bull', ALLOWED)
    const bear = parseMultiPerspectiveRoleAction(JSON.stringify(role('bear')), 'bear', ALLOWED)
    const moderated = parseMultiPerspectiveModeratorAction(JSON.stringify(moderator()), ALLOWED)
    const report = renderMultiPerspectiveReport({
      sourceRunId: '00000000-0000-4000-8000-000000000001',
      asOf: '20260730',
      evidenceSnapshotSha256: 'a'.repeat(64),
      bull,
      bear,
      moderator: moderated,
    })
    expect(report).toContain('## 已确认共识')
    expect(report).toContain('## 核心分歧')
    expect(report).toContain('## 验证清单')
    expect(report).toContain(`[${REF_A}]`)
    const quality = buildMultiPerspectiveQualitySummary({
      sourceReportMarkdown: `原报告 [${REF_A}] [E-CCCCCCCCCC]`,
      allowedEvidenceReferences: ALLOWED,
      bull,
      bear,
      moderator: moderated,
    })
    expect(quality).toMatchObject({
      sourceReportValidReferenceCount: 1,
      roleClaimCount: 2,
      roleCounterpointCount: 2,
      disagreementCount: 1,
      verificationCount: 1,
      invalidReferenceCount: 0,
    })
  })

  it('accepts v2 multi-round actions and requires a concrete focus before continuing', () => {
    const bull = parseMultiPerspectiveUnrestrictedRoleAction(JSON.stringify({
      ...role('bull'),
      protocolVersion: 'multi-perspective.v2',
    }), 'bull', ALLOWED)
    const moderated = parseMultiPerspectiveUnrestrictedModeratorAction(JSON.stringify({
      ...moderator(),
      protocolVersion: 'multi-perspective.v2',
    }), ALLOWED)
    const finished = parseMultiPerspectiveConvergenceAction(JSON.stringify({
      protocolVersion: 'multi-perspective.v2',
      action: 'assess_convergence',
      decision: 'finish',
      substantiveChanges: ['双方已回应核心反证。'],
      resolvedIssues: ['事实是否可追溯。'],
      unresolvedIssues: ['下一期披露尚未出现。'],
      focusAreas: [],
      rationale: '剩余问题依赖未来事实，继续交锋没有实质增量。',
    }))
    expect(bull.protocolVersion).toBe('multi-perspective.v2')
    expect(moderated.protocolVersion).toBe('multi-perspective.v2')
    expect(finished.decision).toBe('finish')
    expect(() => parseMultiPerspectiveConvergenceAction(JSON.stringify({
      ...finished,
      decision: 'continue',
      focusAreas: [],
    }))).toThrowError(expect.objectContaining({ code: 'ACTION_SCHEMA_INVALID' }))
  })
})
