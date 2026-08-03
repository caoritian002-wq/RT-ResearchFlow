import type { ConversationTurn } from './aiProvider'

export const MULTI_PERSPECTIVE_PROTOCOL_VERSION = 'multi-perspective.v1'
export const MULTI_PERSPECTIVE_PROMPT_RULE_VERSION = 'multi-perspective.v1-evidence-bound.v1'
export const MULTI_PERSPECTIVE_TOOL_REGISTRY_VERSION = 'evidence-snapshot-only.v1'
export const MULTI_PERSPECTIVE_UNRESTRICTED_PROTOCOL_VERSION = 'multi-perspective.v2'
export const MULTI_PERSPECTIVE_PREVIOUS_UNRESTRICTED_PROMPT_RULE_VERSION = 'multi-perspective.v2-convergent.v1'
export const MULTI_PERSPECTIVE_UNRESTRICTED_PROMPT_RULE_VERSION = 'multi-perspective.v2-convergent.v2'
export const MULTI_PERSPECTIVE_UNRESTRICTED_TOOL_REGISTRY_VERSION = 'evidence-snapshot-only.v2'

export type MultiPerspectiveRole = 'bull' | 'bear'
export type MultiPerspectiveConfidence = 'high' | 'medium' | 'low'

export interface MultiPerspectiveClaim {
  id: string
  statement: string
  evidenceRefs: string[]
  confidence: MultiPerspectiveConfidence
}

export interface MultiPerspectiveCounterpoint {
  statement: string
  evidenceRefs: string[]
}

export interface MultiPerspectiveRoleAction {
  protocolVersion: typeof MULTI_PERSPECTIVE_PROTOCOL_VERSION
  action: 'position'
  role: MultiPerspectiveRole
  thesis: string
  claims: MultiPerspectiveClaim[]
  counterpoints: MultiPerspectiveCounterpoint[]
  unknowns: string[]
  verificationItems: string[]
  rationale: string
}

export interface MultiPerspectiveUnrestrictedRoleAction {
  protocolVersion: typeof MULTI_PERSPECTIVE_UNRESTRICTED_PROTOCOL_VERSION
  action: 'position'
  role: MultiPerspectiveRole
  thesis: string
  claims: MultiPerspectiveClaim[]
  counterpoints: MultiPerspectiveCounterpoint[]
  unknowns: string[]
  verificationItems: string[]
  rationale: string
}

export interface MultiPerspectiveConsensusItem {
  statement: string
  evidenceRefs: string[]
}

export interface MultiPerspectiveDisagreementItem {
  topic: string
  bullPosition: string
  bearPosition: string
  materiality: 'high' | 'medium' | 'low'
  evidenceRefs: string[]
}

export interface MultiPerspectiveVerificationItem {
  question: string
  reason: string
  preferredSource: string
}

export interface MultiPerspectiveModeratorAction {
  protocolVersion: typeof MULTI_PERSPECTIVE_PROTOCOL_VERSION
  action: 'moderate'
  outcome: 'complete' | 'partial'
  conclusion: {
    statement: string
    evidenceRefs: string[]
  }
  consensus: MultiPerspectiveConsensusItem[]
  disagreements: MultiPerspectiveDisagreementItem[]
  unknowns: string[]
  verificationChecklist: MultiPerspectiveVerificationItem[]
  rationale: string
}

export interface MultiPerspectiveUnrestrictedModeratorAction {
  protocolVersion: typeof MULTI_PERSPECTIVE_UNRESTRICTED_PROTOCOL_VERSION
  action: 'moderate'
  outcome: 'complete' | 'partial'
  conclusion: {
    statement: string
    evidenceRefs: string[]
  }
  consensus: MultiPerspectiveConsensusItem[]
  disagreements: MultiPerspectiveDisagreementItem[]
  unknowns: string[]
  verificationChecklist: MultiPerspectiveVerificationItem[]
  rationale: string
}

export interface MultiPerspectiveConvergenceAction {
  protocolVersion: typeof MULTI_PERSPECTIVE_UNRESTRICTED_PROTOCOL_VERSION
  action: 'assess_convergence'
  decision: 'continue' | 'finish'
  substantiveChanges: string[]
  resolvedIssues: string[]
  unresolvedIssues: string[]
  focusAreas: string[]
  rationale: string
}

export interface MultiPerspectiveQualitySummary {
  schemaVersion: 1
  sourceReportValidReferenceCount: number
  roleClaimCount: number
  roleCounterpointCount: number
  roleUniqueReferenceCount: number
  consensusCount: number
  disagreementCount: number
  unknownCount: number
  verificationCount: number
  invalidReferenceCount: 0
  note: string
}

export class ResearchMultiPerspectiveProtocolError extends Error {
  constructor(public readonly code: 'ACTION_SCHEMA_INVALID' | 'EVIDENCE_REFERENCE_INVALID', message: string) {
    super(message)
    this.name = 'ResearchMultiPerspectiveProtocolError'
  }
}

export function buildMultiPerspectiveRoleMessages(input: {
  role: MultiPerspectiveRole
  question: string
  asOf: string
  evidenceSnapshotSha256: string
  persistedFacts: unknown
  allowedEvidenceReferences: readonly string[]
}): ConversationTurn[] {
  const roleInstruction = input.role === 'bull'
    ? '寻找证据支持的积极路径、成立条件和可能被低估的事实，但不得为了乐观而忽略反证。'
    : '寻找证据支持的风险、反证、脆弱条件和可能被高估的事实，但不得为了悲观而夸大未知。'
  return [{
    role: 'user',
    content: [
      `你是受控多视角研究中的${input.role === 'bull' ? '多方' : '空方'}。${roleInstruction}`,
      '你与另一角色共享同一份已经固化的证据快照。你不能联网、不能调用工具、不能使用模型记忆补齐事实，也不能引入快照之外的新数字或事件。',
      '必须只返回一个JSON对象，不要使用Markdown代码块，不得增加字段。',
      `协议版本：${MULTI_PERSPECTIVE_PROTOCOL_VERSION}。`,
      `role必须为${input.role}。claims为1至6项，counterpoints为0至4项，unknowns为0至6项，verificationItems为1至6项。`,
      '每项事实主张和反证回应必须引用1至4个allowedEvidenceReferences中的编号。禁止买卖指令、收益承诺、目标价和仓位建议。',
      '返回结构：{"protocolVersion":"multi-perspective.v1","action":"position","role":"bull|bear","thesis":"...","claims":[{"id":"P1","statement":"...","evidenceRefs":["E-XXXXXXXXXX"],"confidence":"high|medium|low"}],"counterpoints":[{"statement":"...","evidenceRefs":["E-XXXXXXXXXX"]}],"unknowns":["..."],"verificationItems":["..."],"rationale":"..."}',
      '',
      JSON.stringify({
        question: input.question,
        asOf: input.asOf,
        evidenceSnapshotSha256: input.evidenceSnapshotSha256,
        allowedEvidenceReferences: input.allowedEvidenceReferences,
        persistedFacts: input.persistedFacts,
      }),
    ].join('\n'),
  }]
}

export function buildMultiPerspectiveModeratorMessages(input: {
  question: string
  asOf: string
  evidenceSnapshotSha256: string
  persistedFacts: unknown
  allowedEvidenceReferences: readonly string[]
  bull: MultiPerspectiveRoleAction
  bear: MultiPerspectiveRoleAction
}): ConversationTurn[] {
  return [{
    role: 'user',
    content: [
      '你是受控多视角研究的中立主持。你的职责是识别共识、保留真实分歧并形成验证清单，不是选择赢家。',
      '你只能使用同一份固化证据快照和下方两份结构化角色产物；不能联网、不能调用工具、不能增加快照之外的新事实。',
      '必须只返回一个JSON对象，不要使用Markdown代码块，不得增加字段。',
      `协议版本：${MULTI_PERSPECTIVE_PROTOCOL_VERSION}。`,
      'outcome只能为complete或partial；consensus为0至6项；disagreements为1至6项；unknowns为0至8项；verificationChecklist为1至8项。',
      '结论、共识和分歧必须引用1至6个allowedEvidenceReferences中的编号。不得删除双方尚未解决的重要未知项，不得输出买卖、仓位、目标价或收益承诺。',
      '返回结构：{"protocolVersion":"multi-perspective.v1","action":"moderate","outcome":"complete|partial","conclusion":{"statement":"...","evidenceRefs":["E-XXXXXXXXXX"]},"consensus":[{"statement":"...","evidenceRefs":["E-XXXXXXXXXX"]}],"disagreements":[{"topic":"...","bullPosition":"...","bearPosition":"...","materiality":"high|medium|low","evidenceRefs":["E-XXXXXXXXXX"]}],"unknowns":["..."],"verificationChecklist":[{"question":"...","reason":"...","preferredSource":"..."}],"rationale":"..."}',
      '',
      JSON.stringify({
        question: input.question,
        asOf: input.asOf,
        evidenceSnapshotSha256: input.evidenceSnapshotSha256,
        allowedEvidenceReferences: input.allowedEvidenceReferences,
        persistedFacts: input.persistedFacts,
        bull: input.bull,
        bear: input.bear,
      }),
    ].join('\n'),
  }]
}

export function buildMultiPerspectiveUnrestrictedRoleMessages(input: {
  role: MultiPerspectiveRole
  round: number
  question: string
  asOf: string
  evidenceSnapshotSha256: string
  persistedFacts: unknown
  allowedEvidenceReferences: readonly string[]
  previousOwn: MultiPerspectiveUnrestrictedRoleAction | null
  previousOpponent: MultiPerspectiveUnrestrictedRoleAction | null
  convergence: MultiPerspectiveConvergenceAction | null
}): ConversationTurn[] {
  const roleInstruction = input.role === 'bull'
    ? '寻找证据支持的积极路径、成立条件和可能被低估的事实，但必须正面处理空方反证。'
    : '寻找证据支持的风险、反证、脆弱条件和可能被高估的事实，但必须正面处理多方证据。'
  const roundInstruction = input.round === 1
    ? '这是第一轮独立立论。请形成完整初始观点。'
    : [
        `这是第${input.round}轮交锋。请逐项回应上一轮对方的重要主张和收敛评估指出的焦点。`,
        '必须输出修订后的完整观点，而不是只输出增量；承认被证据推翻的部分，保留仍有依据的分歧，并避免只改写措辞。',
      ].join('')
  return [{
    role: 'user',
    content: [
      `你是深度多视角研究中的${input.role === 'bull' ? '多方' : '空方'}。${roleInstruction}`,
      roundInstruction,
      '你与另一角色共享同一份已经固化的证据快照。你不能联网、不能调用工具、不能使用模型记忆补齐事实，也不能引入快照之外的新数字或事件。',
      '必须只返回一个JSON对象，不要使用Markdown代码块，不得增加字段。',
      `协议版本：${MULTI_PERSPECTIVE_UNRESTRICTED_PROTOCOL_VERSION}。`,
      `round=${input.round}，role必须为${input.role}。claims为1至6项，counterpoints为0至6项，unknowns为0至8项，verificationItems为1至8项。`,
      '每项事实主张和反证回应必须引用1至6个allowedEvidenceReferences中的编号。禁止买卖指令、收益承诺、目标价和仓位建议。',
      '返回结构：{"protocolVersion":"multi-perspective.v2","action":"position","role":"bull|bear","thesis":"...","claims":[{"id":"P1","statement":"...","evidenceRefs":["E-XXXXXXXXXX"],"confidence":"high|medium|low"}],"counterpoints":[{"statement":"...","evidenceRefs":["E-XXXXXXXXXX"]}],"unknowns":["..."],"verificationItems":["..."],"rationale":"..."}',
      '',
      JSON.stringify({
        round: input.round,
        question: input.question,
        asOf: input.asOf,
        evidenceSnapshotSha256: input.evidenceSnapshotSha256,
        allowedEvidenceReferences: input.allowedEvidenceReferences,
        persistedFacts: input.persistedFacts,
        previousOwn: input.previousOwn,
        previousOpponent: input.previousOpponent,
        convergence: input.convergence == null ? null : {
          decision: input.convergence.decision,
          unresolvedIssues: input.convergence.unresolvedIssues,
          focusAreas: input.convergence.focusAreas,
        },
      }),
    ].join('\n'),
  }]
}

export function buildMultiPerspectiveConvergenceMessages(input: {
  round: number
  question: string
  allowedEvidenceReferences: readonly string[]
  bull: MultiPerspectiveUnrestrictedRoleAction
  bear: MultiPerspectiveUnrestrictedRoleAction
  previous: MultiPerspectiveConvergenceAction | null
}): ConversationTurn[] {
  return [{
    role: 'user',
    content: [
      '你是深度多视角研究的收敛评估器。你不裁决投资方向，只判断下一轮交锋是否还能产生实质增量。',
      '只有仍存在可由当前证据进一步澄清的重大矛盾、遗漏回应或逻辑断点时才返回continue。仅有立场不同、未知事实需要未来验证、措辞可优化或重复原论点时必须返回finish。',
      '必须只返回一个JSON对象，不要使用Markdown代码块，不得增加字段。不能联网、不能调用工具、不能引入证据快照外的事实。',
      'substantiveChanges列出相较上一轮真正新增或修正的内容；focusAreas只在continue时列出下一轮必须解决的具体焦点。',
      '返回结构：{"protocolVersion":"multi-perspective.v2","action":"assess_convergence","decision":"continue|finish","substantiveChanges":["..."],"resolvedIssues":["..."],"unresolvedIssues":["..."],"focusAreas":["..."],"rationale":"..."}',
      '',
      JSON.stringify({
        round: input.round,
        question: input.question,
        allowedEvidenceReferences: input.allowedEvidenceReferences,
        bull: input.bull,
        bear: input.bear,
        previous: input.previous,
      }),
    ].join('\n'),
  }]
}

export function buildMultiPerspectiveUnrestrictedModeratorMessages(input: {
  question: string
  asOf: string
  evidenceSnapshotSha256: string
  persistedFacts: unknown
  allowedEvidenceReferences: readonly string[]
  roundCount: number
  convergence: MultiPerspectiveConvergenceAction
  bull: MultiPerspectiveUnrestrictedRoleAction
  bear: MultiPerspectiveUnrestrictedRoleAction
  promptRuleVersion: string
}): ConversationTurn[] {
  const outcomeRule = input.promptRuleVersion === MULTI_PERSPECTIVE_UNRESTRICTED_PROMPT_RULE_VERSION
    ? 'outcome评价的是核心问题覆盖，不是共识、分歧或未知项数量：核心问题已在当前父证据边界内形成可追溯结论时返回complete，即使仍有真实分歧、未来未知项或验证清单；不得仅因存在未知项就降级。只有父证据使一个或多个核心子问题仍无法回答时才返回partial，rationale必须点明这些核心子问题。'
    : null
  return [{
    role: 'user',
    content: [
      '你是深度多视角研究的中立主持。多方和空方已经完成多轮交锋；你的职责是识别共识、保留真实分歧并形成验证清单，不是选择赢家。',
      '你只能使用同一份固化证据快照、最终角色产物和收敛评估；不能联网、不能调用工具、不能增加快照之外的新事实。',
      '必须只返回一个JSON对象，不要使用Markdown代码块，不得增加字段。',
      `协议版本：${MULTI_PERSPECTIVE_UNRESTRICTED_PROTOCOL_VERSION}。`,
      'outcome只能为complete或partial；consensus为0至8项；disagreements为1至8项；unknowns为0至10项；verificationChecklist为1至10项。',
      ...(outcomeRule ? [outcomeRule] : []),
      '结论、共识和分歧必须引用1至8个allowedEvidenceReferences中的编号。不得删除双方尚未解决的重要未知项，不得输出买卖、仓位、目标价或收益承诺。',
      '返回结构：{"protocolVersion":"multi-perspective.v2","action":"moderate","outcome":"complete|partial","conclusion":{"statement":"...","evidenceRefs":["E-XXXXXXXXXX"]},"consensus":[{"statement":"...","evidenceRefs":["E-XXXXXXXXXX"]}],"disagreements":[{"topic":"...","bullPosition":"...","bearPosition":"...","materiality":"high|medium|low","evidenceRefs":["E-XXXXXXXXXX"]}],"unknowns":["..."],"verificationChecklist":[{"question":"...","reason":"...","preferredSource":"..."}],"rationale":"..."}',
      '',
      JSON.stringify({
        question: input.question,
        asOf: input.asOf,
        roundCount: input.roundCount,
        evidenceSnapshotSha256: input.evidenceSnapshotSha256,
        allowedEvidenceReferences: input.allowedEvidenceReferences,
        persistedFacts: input.persistedFacts,
        convergence: input.convergence,
        bull: input.bull,
        bear: input.bear,
      }),
    ].join('\n'),
  }]
}

export function parseMultiPerspectiveRoleAction(
  text: string,
  expectedRole: MultiPerspectiveRole,
  allowedEvidenceReferences: ReadonlySet<string>,
): MultiPerspectiveRoleAction {
  const value = parseActionJson(text)
  assertExactKeys(value, [
    'protocolVersion', 'action', 'role', 'thesis', 'claims', 'counterpoints',
    'unknowns', 'verificationItems', 'rationale',
  ])
  if (value.protocolVersion !== MULTI_PERSPECTIVE_PROTOCOL_VERSION || value.action !== 'position') {
    invalid('角色动作协议或类型无效')
  }
  if (value.role !== expectedRole) invalid(`角色必须为${expectedRole}`)
  const claims = recordArray(value.claims, 1, 6, 'claims').map((claim, index) => {
    assertExactKeys(claim, ['id', 'statement', 'evidenceRefs', 'confidence'])
    const id = boundedString(claim.id, 1, 16, `claims[${index}].id`)
    if (!/^[A-Z][A-Z0-9_-]{0,15}$/.test(id)) invalid(`claims[${index}].id格式无效`)
    const confidence = enumValue(claim.confidence, ['high', 'medium', 'low'] as const, `claims[${index}].confidence`)
    return {
      id,
      statement: boundedString(claim.statement, 1, 1_000, `claims[${index}].statement`),
      evidenceRefs: evidenceReferences(claim.evidenceRefs, 1, 4, allowedEvidenceReferences, `claims[${index}].evidenceRefs`),
      confidence,
    }
  })
  if (new Set(claims.map((claim) => claim.id)).size !== claims.length) invalid('claims.id不得重复')
  const counterpoints = recordArray(value.counterpoints, 0, 4, 'counterpoints').map((item, index) => {
    assertExactKeys(item, ['statement', 'evidenceRefs'])
    return {
      statement: boundedString(item.statement, 1, 1_000, `counterpoints[${index}].statement`),
      evidenceRefs: evidenceReferences(item.evidenceRefs, 1, 4, allowedEvidenceReferences, `counterpoints[${index}].evidenceRefs`),
    }
  })
  return {
    protocolVersion: MULTI_PERSPECTIVE_PROTOCOL_VERSION,
    action: 'position',
    role: expectedRole,
    thesis: boundedString(value.thesis, 1, 2_000, 'thesis'),
    claims,
    counterpoints,
    unknowns: stringArray(value.unknowns, 0, 6, 500, 'unknowns'),
    verificationItems: stringArray(value.verificationItems, 1, 6, 500, 'verificationItems'),
    rationale: boundedString(value.rationale, 1, 2_000, 'rationale'),
  }
}

export function parseMultiPerspectiveModeratorAction(
  text: string,
  allowedEvidenceReferences: ReadonlySet<string>,
): MultiPerspectiveModeratorAction {
  const value = parseActionJson(text)
  assertExactKeys(value, [
    'protocolVersion', 'action', 'outcome', 'conclusion', 'consensus',
    'disagreements', 'unknowns', 'verificationChecklist', 'rationale',
  ])
  if (value.protocolVersion !== MULTI_PERSPECTIVE_PROTOCOL_VERSION || value.action !== 'moderate') {
    invalid('主持动作协议或类型无效')
  }
  const conclusion = recordValue(value.conclusion, 'conclusion')
  assertExactKeys(conclusion, ['statement', 'evidenceRefs'])
  const consensus = recordArray(value.consensus, 0, 6, 'consensus').map((item, index) => {
    assertExactKeys(item, ['statement', 'evidenceRefs'])
    return {
      statement: boundedString(item.statement, 1, 1_000, `consensus[${index}].statement`),
      evidenceRefs: evidenceReferences(item.evidenceRefs, 1, 6, allowedEvidenceReferences, `consensus[${index}].evidenceRefs`),
    }
  })
  const disagreements = recordArray(value.disagreements, 1, 6, 'disagreements').map((item, index) => {
    assertExactKeys(item, ['topic', 'bullPosition', 'bearPosition', 'materiality', 'evidenceRefs'])
    return {
      topic: boundedString(item.topic, 1, 300, `disagreements[${index}].topic`),
      bullPosition: boundedString(item.bullPosition, 1, 1_000, `disagreements[${index}].bullPosition`),
      bearPosition: boundedString(item.bearPosition, 1, 1_000, `disagreements[${index}].bearPosition`),
      materiality: enumValue(item.materiality, ['high', 'medium', 'low'] as const, `disagreements[${index}].materiality`),
      evidenceRefs: evidenceReferences(item.evidenceRefs, 1, 6, allowedEvidenceReferences, `disagreements[${index}].evidenceRefs`),
    }
  })
  const verificationChecklist = recordArray(value.verificationChecklist, 1, 8, 'verificationChecklist').map((item, index) => {
    assertExactKeys(item, ['question', 'reason', 'preferredSource'])
    return {
      question: boundedString(item.question, 1, 500, `verificationChecklist[${index}].question`),
      reason: boundedString(item.reason, 1, 500, `verificationChecklist[${index}].reason`),
      preferredSource: boundedString(item.preferredSource, 1, 200, `verificationChecklist[${index}].preferredSource`),
    }
  })
  return {
    protocolVersion: MULTI_PERSPECTIVE_PROTOCOL_VERSION,
    action: 'moderate',
    outcome: enumValue(value.outcome, ['complete', 'partial'] as const, 'outcome'),
    conclusion: {
      statement: boundedString(conclusion.statement, 1, 2_000, 'conclusion.statement'),
      evidenceRefs: evidenceReferences(conclusion.evidenceRefs, 1, 6, allowedEvidenceReferences, 'conclusion.evidenceRefs'),
    },
    consensus,
    disagreements,
    unknowns: stringArray(value.unknowns, 0, 8, 500, 'unknowns'),
    verificationChecklist,
    rationale: boundedString(value.rationale, 1, 2_000, 'rationale'),
  }
}

export function parseMultiPerspectiveUnrestrictedRoleAction(
  text: string,
  expectedRole: MultiPerspectiveRole,
  allowedEvidenceReferences: ReadonlySet<string>,
): MultiPerspectiveUnrestrictedRoleAction {
  const value = parseActionJson(text)
  assertExactKeys(value, [
    'protocolVersion', 'action', 'role', 'thesis', 'claims', 'counterpoints',
    'unknowns', 'verificationItems', 'rationale',
  ])
  if (value.protocolVersion !== MULTI_PERSPECTIVE_UNRESTRICTED_PROTOCOL_VERSION || value.action !== 'position') {
    invalid('角色动作协议或类型无效')
  }
  if (value.role !== expectedRole) invalid(`角色必须为${expectedRole}`)
  const claims = recordArray(value.claims, 1, 6, 'claims').map((claim, index) => {
    assertExactKeys(claim, ['id', 'statement', 'evidenceRefs', 'confidence'])
    const id = boundedString(claim.id, 1, 16, `claims[${index}].id`)
    if (!/^[A-Z][A-Z0-9_-]{0,15}$/.test(id)) invalid(`claims[${index}].id格式无效`)
    return {
      id,
      statement: boundedString(claim.statement, 1, 1_000, `claims[${index}].statement`),
      evidenceRefs: evidenceReferences(claim.evidenceRefs, 1, 6, allowedEvidenceReferences, `claims[${index}].evidenceRefs`),
      confidence: enumValue(claim.confidence, ['high', 'medium', 'low'] as const, `claims[${index}].confidence`),
    }
  })
  if (new Set(claims.map((claim) => claim.id)).size !== claims.length) invalid('claims.id不得重复')
  const counterpoints = recordArray(value.counterpoints, 0, 6, 'counterpoints').map((item, index) => {
    assertExactKeys(item, ['statement', 'evidenceRefs'])
    return {
      statement: boundedString(item.statement, 1, 1_000, `counterpoints[${index}].statement`),
      evidenceRefs: evidenceReferences(item.evidenceRefs, 1, 6, allowedEvidenceReferences, `counterpoints[${index}].evidenceRefs`),
    }
  })
  return {
    protocolVersion: MULTI_PERSPECTIVE_UNRESTRICTED_PROTOCOL_VERSION,
    action: 'position',
    role: expectedRole,
    thesis: boundedString(value.thesis, 1, 2_000, 'thesis'),
    claims,
    counterpoints,
    unknowns: stringArray(value.unknowns, 0, 8, 500, 'unknowns'),
    verificationItems: stringArray(value.verificationItems, 1, 8, 500, 'verificationItems'),
    rationale: boundedString(value.rationale, 1, 2_000, 'rationale'),
  }
}

export function parseMultiPerspectiveConvergenceAction(text: string): MultiPerspectiveConvergenceAction {
  const value = parseActionJson(text)
  assertExactKeys(value, [
    'protocolVersion', 'action', 'decision', 'substantiveChanges', 'resolvedIssues',
    'unresolvedIssues', 'focusAreas', 'rationale',
  ])
  if (value.protocolVersion !== MULTI_PERSPECTIVE_UNRESTRICTED_PROTOCOL_VERSION || value.action !== 'assess_convergence') {
    invalid('收敛动作协议或类型无效')
  }
  const decision = enumValue(value.decision, ['continue', 'finish'] as const, 'decision')
  const focusAreas = stringArray(value.focusAreas, 0, 6, 500, 'focusAreas')
  const unresolvedIssues = stringArray(value.unresolvedIssues, 0, 8, 500, 'unresolvedIssues')
  if (decision === 'continue' && (focusAreas.length === 0 || unresolvedIssues.length === 0)) {
    invalid('继续交锋必须给出未解决问题和下一轮焦点')
  }
  return {
    protocolVersion: MULTI_PERSPECTIVE_UNRESTRICTED_PROTOCOL_VERSION,
    action: 'assess_convergence',
    decision,
    substantiveChanges: stringArray(value.substantiveChanges, 0, 8, 500, 'substantiveChanges'),
    resolvedIssues: stringArray(value.resolvedIssues, 0, 8, 500, 'resolvedIssues'),
    unresolvedIssues,
    focusAreas,
    rationale: boundedString(value.rationale, 1, 2_000, 'rationale'),
  }
}

export function parseMultiPerspectiveUnrestrictedModeratorAction(
  text: string,
  allowedEvidenceReferences: ReadonlySet<string>,
): MultiPerspectiveUnrestrictedModeratorAction {
  const value = parseActionJson(text)
  assertExactKeys(value, [
    'protocolVersion', 'action', 'outcome', 'conclusion', 'consensus',
    'disagreements', 'unknowns', 'verificationChecklist', 'rationale',
  ])
  if (value.protocolVersion !== MULTI_PERSPECTIVE_UNRESTRICTED_PROTOCOL_VERSION || value.action !== 'moderate') {
    invalid('主持动作协议或类型无效')
  }
  const conclusion = recordValue(value.conclusion, 'conclusion')
  assertExactKeys(conclusion, ['statement', 'evidenceRefs'])
  const consensus = recordArray(value.consensus, 0, 8, 'consensus').map((item, index) => {
    assertExactKeys(item, ['statement', 'evidenceRefs'])
    return {
      statement: boundedString(item.statement, 1, 1_000, `consensus[${index}].statement`),
      evidenceRefs: evidenceReferences(item.evidenceRefs, 1, 8, allowedEvidenceReferences, `consensus[${index}].evidenceRefs`),
    }
  })
  const disagreements = recordArray(value.disagreements, 1, 8, 'disagreements').map((item, index) => {
    assertExactKeys(item, ['topic', 'bullPosition', 'bearPosition', 'materiality', 'evidenceRefs'])
    return {
      topic: boundedString(item.topic, 1, 300, `disagreements[${index}].topic`),
      bullPosition: boundedString(item.bullPosition, 1, 1_000, `disagreements[${index}].bullPosition`),
      bearPosition: boundedString(item.bearPosition, 1, 1_000, `disagreements[${index}].bearPosition`),
      materiality: enumValue(item.materiality, ['high', 'medium', 'low'] as const, `disagreements[${index}].materiality`),
      evidenceRefs: evidenceReferences(item.evidenceRefs, 1, 8, allowedEvidenceReferences, `disagreements[${index}].evidenceRefs`),
    }
  })
  const verificationChecklist = recordArray(value.verificationChecklist, 1, 10, 'verificationChecklist').map((item, index) => {
    assertExactKeys(item, ['question', 'reason', 'preferredSource'])
    return {
      question: boundedString(item.question, 1, 500, `verificationChecklist[${index}].question`),
      reason: boundedString(item.reason, 1, 500, `verificationChecklist[${index}].reason`),
      preferredSource: boundedString(item.preferredSource, 1, 200, `verificationChecklist[${index}].preferredSource`),
    }
  })
  return {
    protocolVersion: MULTI_PERSPECTIVE_UNRESTRICTED_PROTOCOL_VERSION,
    action: 'moderate',
    outcome: enumValue(value.outcome, ['complete', 'partial'] as const, 'outcome'),
    conclusion: {
      statement: boundedString(conclusion.statement, 1, 2_000, 'conclusion.statement'),
      evidenceRefs: evidenceReferences(conclusion.evidenceRefs, 1, 8, allowedEvidenceReferences, 'conclusion.evidenceRefs'),
    },
    consensus,
    disagreements,
    unknowns: stringArray(value.unknowns, 0, 10, 500, 'unknowns'),
    verificationChecklist,
    rationale: boundedString(value.rationale, 1, 2_000, 'rationale'),
  }
}

export function buildMultiPerspectiveQualitySummary(input: {
  sourceReportMarkdown: string
  allowedEvidenceReferences: ReadonlySet<string>
  bull: MultiPerspectiveRoleAction | MultiPerspectiveUnrestrictedRoleAction
  bear: MultiPerspectiveRoleAction | MultiPerspectiveUnrestrictedRoleAction
  moderator: MultiPerspectiveModeratorAction | MultiPerspectiveUnrestrictedModeratorAction
}): MultiPerspectiveQualitySummary {
  const sourceRefs = new Set(input.sourceReportMarkdown.match(/E-[A-F0-9]{10}/g) ?? [])
  const roleRefs = new Set([
    ...input.bull.claims.flatMap((item) => item.evidenceRefs),
    ...input.bear.claims.flatMap((item) => item.evidenceRefs),
    ...input.bull.counterpoints.flatMap((item) => item.evidenceRefs),
    ...input.bear.counterpoints.flatMap((item) => item.evidenceRefs),
  ])
  return {
    schemaVersion: 1,
    sourceReportValidReferenceCount: [...sourceRefs].filter((reference) => input.allowedEvidenceReferences.has(reference)).length,
    roleClaimCount: input.bull.claims.length + input.bear.claims.length,
    roleCounterpointCount: input.bull.counterpoints.length + input.bear.counterpoints.length,
    roleUniqueReferenceCount: roleRefs.size,
    consensusCount: input.moderator.consensus.length,
    disagreementCount: input.moderator.disagreements.length,
    unknownCount: input.moderator.unknowns.length,
    verificationCount: input.moderator.verificationChecklist.length,
    invalidReferenceCount: 0,
    note: '结构覆盖对比不评价投资结论是否正确，也不把更多文本或更多角色等同于更高质量。',
  }
}

export function renderMultiPerspectiveReport(input: {
  sourceRunId: string
  asOf: string
  evidenceSnapshotSha256: string
  bull: MultiPerspectiveRoleAction | MultiPerspectiveUnrestrictedRoleAction
  bear: MultiPerspectiveRoleAction | MultiPerspectiveUnrestrictedRoleAction
  moderator: MultiPerspectiveModeratorAction | MultiPerspectiveUnrestrictedModeratorAction
  roundCount?: number
}): string {
  const refs = (values: readonly string[]) => values.map((value) => `[${value}]`).join(' ')
  const lines = [
    '# 多视角研究复核',
    '',
    '## 中立结论',
    `${input.moderator.conclusion.statement} ${refs(input.moderator.conclusion.evidenceRefs)}`,
    '',
    '## 已确认共识',
    ...(input.moderator.consensus.length > 0
      ? input.moderator.consensus.map((item) => `- ${item.statement} ${refs(item.evidenceRefs)}`)
      : ['- 当前没有足以形成共识的事项。']),
    '',
    '## 核心分歧',
    ...input.moderator.disagreements.flatMap((item) => [
      `### ${item.topic}（${materialityLabel(item.materiality)}）`,
      `- 多方：${item.bullPosition}`,
      `- 空方：${item.bearPosition}`,
      `- 共同证据：${refs(item.evidenceRefs)}`,
    ]),
    '',
    '## 多方观点',
    input.bull.thesis,
    ...input.bull.claims.map((item) => `- ${item.statement} ${refs(item.evidenceRefs)}（置信度：${confidenceLabel(item.confidence)}）`),
    '',
    '## 空方观点',
    input.bear.thesis,
    ...input.bear.claims.map((item) => `- ${item.statement} ${refs(item.evidenceRefs)}（置信度：${confidenceLabel(item.confidence)}）`),
    '',
    '## 剩余未知',
    ...(input.moderator.unknowns.length > 0 ? input.moderator.unknowns.map((item) => `- ${item}`) : ['- 未识别到额外未知项。']),
    '',
    '## 验证清单',
    ...input.moderator.verificationChecklist.map((item) => `- ${item.question}；原因：${item.reason}；优先来源：${item.preferredSource}`),
    '',
    '## 证据与成本边界',
    `- 资料截点：${input.asOf}`,
    `- 来源运行：${input.sourceRunId}`,
    `- 不可变证据：${input.evidenceSnapshotSha256}`,
    ...(input.roundCount == null ? [] : [`- 多空交锋：${input.roundCount} 轮，按实质分歧收敛，不设模型调用次数上限。`]),
    '- 多方、空方和主持人只读取同一份已固化证据，本次复核未再次调用事实工具或联网。',
    '- 本报告用于呈现论证结构，不构成买卖、仓位、目标价或收益承诺。',
  ]
  return lines.join('\n').trim()
}

function evidenceReferences(
  value: unknown,
  minimum: number,
  maximum: number,
  allowed: ReadonlySet<string>,
  field: string,
): string[] {
  const references = stringArray(value, minimum, maximum, 12, field)
  const invalidReference = references.find((reference) => !/^E-[A-F0-9]{10}$/.test(reference) || !allowed.has(reference))
  if (invalidReference) {
    throw new ResearchMultiPerspectiveProtocolError('EVIDENCE_REFERENCE_INVALID', `${field}包含不存在的证据引用：${invalidReference}`)
  }
  return references
}

function parseActionJson(text: string): Record<string, unknown> {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const candidate = fenced ? fenced[1].trim() : trimmed
  let value: unknown
  try { value = JSON.parse(candidate) as unknown } catch { invalid('模型动作不是有效JSON') }
  if (!isRecord(value)) invalid('模型动作必须是JSON对象')
  return value
}

function recordArray(value: unknown, minimum: number, maximum: number, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum || value.some((item) => !isRecord(item))) {
    invalid(`${field}数量或类型无效`)
  }
  return value as Record<string, unknown>[]
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${field}必须是对象`)
  return value
}

function stringArray(value: unknown, minimum: number, maximum: number, maxText: number, field: string): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalid(`${field}数量无效`)
  const result = value.map((item, index) => boundedString(item, 1, maxText, `${field}[${index}]`))
  if (new Set(result).size !== result.length) invalid(`${field}不得重复`)
  return result
}

function boundedString(value: unknown, minimum: number, maximum: number, field: string): string {
  if (typeof value !== 'string') invalid(`${field}必须是字符串`)
  const text = value.trim()
  if (text.length < minimum || text.length > maximum) invalid(`${field}长度无效`)
  return text
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) invalid(`${field}枚举值无效`)
  return value as T[number]
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys)
  const extra = Object.keys(value).find((key) => !expected.has(key))
  const missing = keys.find((key) => !(key in value))
  if (extra) invalid(`模型动作包含额外字段：${extra}`)
  if (missing) invalid(`模型动作缺少字段：${missing}`)
}

function invalid(message: string): never {
  throw new ResearchMultiPerspectiveProtocolError('ACTION_SCHEMA_INVALID', message)
}

function confidenceLabel(value: MultiPerspectiveConfidence): string {
  return { high: '高', medium: '中', low: '低' }[value]
}

function materialityLabel(value: MultiPerspectiveDisagreementItem['materiality']): string {
  return { high: '高重要性', medium: '中重要性', low: '低重要性' }[value]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
