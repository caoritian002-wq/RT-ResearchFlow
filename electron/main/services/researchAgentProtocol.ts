import type { ConversationTurn } from './aiProvider'
import type { ResearchAgentEvidenceGateResult } from './researchAgentEvidenceGate'
import type { ResearchAgentToolDefinition } from './researchAgentNetworkTools'

export const RESEARCH_AGENT_PROTOCOL_VERSION = 'single-agent.v1'
export const RESEARCH_AGENT_PREVIOUS_PROMPT_RULE_VERSION = 'single-agent.v1-controlled-network.v4'
export const RESEARCH_AGENT_PROMPT_RULE_VERSION = 'single-agent.v1-controlled-network.v5'

export interface ResearchAgentPlanAction {
  protocolVersion: typeof RESEARCH_AGENT_PROTOCOL_VERSION
  action: 'plan'
  questions: string[]
  candidateTools: string[]
  stopConditions: string[]
  rationale: string
}

export interface ResearchAgentToolBatchAction {
  protocolVersion: typeof RESEARCH_AGENT_PROTOCOL_VERSION
  action: 'tool_batch'
  calls: Array<{ toolId: string; input: Record<string, unknown> }>
  rationale: string
}

export interface ResearchAgentEarlyFinishAction {
  protocolVersion: typeof RESEARCH_AGENT_PROTOCOL_VERSION
  action: 'finish'
  rationale: string
}

export interface ResearchAgentFinalAction {
  protocolVersion: typeof RESEARCH_AGENT_PROTOCOL_VERSION
  action: 'finish'
  outcome: 'complete' | 'partial' | 'blocked'
  reportMarkdown: string
  rationale: string
}

export class ResearchAgentProtocolError extends Error {
  constructor(public readonly code: 'ACTION_SCHEMA_INVALID', message: string) {
    super(message)
    this.name = 'ResearchAgentProtocolError'
  }
}

export function parseResearchAgentPlanAction(text: string): ResearchAgentPlanAction {
  const value = parseActionJson(text)
  assertExactKeys(value, ['protocolVersion', 'action', 'questions', 'candidateTools', 'stopConditions', 'rationale'])
  if (value.protocolVersion !== RESEARCH_AGENT_PROTOCOL_VERSION || value.action !== 'plan') invalid('计划动作协议或类型无效')
  const questions = stringArray(value.questions, 1, 6, 500, 'questions')
  const candidateTools = stringArray(value.candidateTools, 0, 8, 120, 'candidateTools')
  const stopConditions = stringArray(value.stopConditions, 1, 6, 500, 'stopConditions')
  const rationale = boundedString(value.rationale, 1, 2_000, 'rationale')
  if (new Set(candidateTools).size !== candidateTools.length) invalid('candidateTools不得重复')
  return {
    protocolVersion: RESEARCH_AGENT_PROTOCOL_VERSION,
    action: 'plan',
    questions,
    candidateTools,
    stopConditions,
    rationale,
  }
}

export function parseResearchAgentToolDecisionAction(
  text: string,
): ResearchAgentToolBatchAction | ResearchAgentEarlyFinishAction {
  const value = parseActionJson(text)
  if (value.protocolVersion !== RESEARCH_AGENT_PROTOCOL_VERSION) invalid('工具决策协议版本无效')
  if (value.action === 'finish') {
    assertExactKeys(value, ['protocolVersion', 'action', 'rationale'])
    return {
      protocolVersion: RESEARCH_AGENT_PROTOCOL_VERSION,
      action: 'finish',
      rationale: boundedString(value.rationale, 1, 2_000, 'rationale'),
    }
  }
  if (value.action !== 'tool_batch') invalid('工具决策动作类型无效')
  assertExactKeys(value, ['protocolVersion', 'action', 'calls', 'rationale'])
  if (!Array.isArray(value.calls) || value.calls.length < 1 || value.calls.length > 2) {
    invalid('tool_batch必须包含1至2个调用')
  }
  const calls = value.calls.map((item, index) => {
    if (!isRecord(item)) invalid(`calls[${index}]必须是对象`)
    assertExactKeys(item, ['toolId', 'input'])
    const toolId = boundedString(item.toolId, 1, 120, `calls[${index}].toolId`)
    if (!isRecord(item.input)) invalid(`calls[${index}].input必须是对象`)
    return { toolId, input: item.input }
  })
  return {
    protocolVersion: RESEARCH_AGENT_PROTOCOL_VERSION,
    action: 'tool_batch',
    calls,
    rationale: boundedString(value.rationale, 1, 2_000, 'rationale'),
  }
}

export function parseResearchAgentFinalAction(text: string): ResearchAgentFinalAction {
  const value = parseActionJson(text)
  assertExactKeys(value, ['protocolVersion', 'action', 'outcome', 'reportMarkdown', 'rationale'])
  if (value.protocolVersion !== RESEARCH_AGENT_PROTOCOL_VERSION || value.action !== 'finish') {
    invalid('最终综合动作协议或类型无效')
  }
  if (!['complete', 'partial', 'blocked'].includes(String(value.outcome))) invalid('最终报告outcome无效')
  return {
    protocolVersion: RESEARCH_AGENT_PROTOCOL_VERSION,
    action: 'finish',
    outcome: value.outcome as ResearchAgentFinalAction['outcome'],
    reportMarkdown: boundedString(value.reportMarkdown, 1, 60_000, 'reportMarkdown'),
    rationale: boundedString(value.rationale, 1, 2_000, 'rationale'),
  }
}

export function buildResearchAgentPlanningMessages(input: {
  question: string
  subjects: unknown
  asOf: string
  includePortfolio: boolean
  trustedContext: unknown
  tools: readonly ResearchAgentToolDefinition[]
}): ConversationTurn[] {
  return [{
    role: 'user',
    content: [
      '你是应用内部的受控单Agent研究规划器。模型本身不能联网、不能调用SQL/文件/Shell，也不能猜测新的证券、判断或项目ID。',
      '本轮只制定计划，不得输出研究结论。必须只返回一个JSON对象，不要使用Markdown代码块。',
      `协议版本：${RESEARCH_AGENT_PROTOCOL_VERSION}。`,
      '返回结构：{"protocolVersion":"single-agent.v1","action":"plan","questions":["..."],"candidateTools":["内部工具ID"],"stopConditions":["..."],"rationale":"..."}',
      'questions最多6项；candidateTools只能来自下方清单；不得增加字段。',
      '',
      JSON.stringify({
        question: input.question,
        subjects: input.subjects,
        asOf: input.asOf,
        includePortfolio: input.includePortfolio,
        trustedContext: input.trustedContext,
        tools: input.tools.map(toolPromptDefinition),
      }),
    ].join('\n'),
  }]
}

export function buildResearchAgentToolDecisionMessages(input: {
  question: string
  subjects: unknown
  trustedContext: unknown
  plan: ResearchAgentPlanAction
  asOf: string
  round: number
  maximumRounds: number | null
  budget: {
    maximumToolCalls: number | null
    usedToolCalls: number
    remainingToolCalls: number | null
    reservedRecoveryCalls: number | null
  }
  tools: readonly ResearchAgentToolDefinition[]
  persistedFacts: unknown
  evidenceGate?: ResearchAgentEvidenceGateResult | null
}): ConversationTurn[] {
  return [{
    role: 'user',
    content: [
      '你是应用内部的受控单Agent工具决策器。模型本身不能联网；你只能声明式选择清单中的受控工具，实际本地读取或联网由主进程校验、落账和执行。',
      `这是第${input.round}${input.maximumRounds == null ? '' : `/${input.maximumRounds}`}轮工具决策。每轮最多2个调用，事实截点固定为${input.asOf}。`,
      '必须只返回一个JSON对象，不要使用Markdown代码块。',
      '继续取数：{"protocolVersion":"single-agent.v1","action":"tool_batch","calls":[{"toolId":"...","input":{}}],"rationale":"..."}',
      '提前结束：{"protocolVersion":"single-agent.v1","action":"finish","rationale":"..."}',
      '不得提交SQL、URL、文件路径、Shell、IPC或额外字段。正文工具只能提交已落账搜索结果中的candidateId，相同工具与输入不要重复请求。',
      'persistedFacts.failures记录已失败的工具输入；terminal=true表示同一工具与输入不得再次尝试，必须改用其他候选或新的受控搜索。',
      'web.search与official.disclosure_search的标题、摘要和URL只是候选线索；只有正文工具成功保存的可引用摘录才能支持结论。',
      'subjects与trustedContext是本轮唯一受信身份边界；不得改写主体、猜测其他证券或使用上下文之外的ID。remainingToolCalls为null表示不按总调用次数截断，但仍须避免重复调用并在证据没有增量时结束。',
      '产业项目运行中，portfolio.holdings里的股票只用于组合暴露核对，不会自动升级为受信股票主体；official.disclosure_search必须围绕项目名称查询并省略stockCode。',
      '',
      JSON.stringify({
        question: input.question,
        subjects: input.subjects,
        trustedContext: input.trustedContext,
        plan: input.plan,
        budget: input.budget,
        availableTools: input.tools.map(toolPromptDefinition),
        persistedFacts: input.persistedFacts,
        evidenceGate: input.evidenceGate ?? null,
      }),
    ].join('\n'),
  }]
}

export function buildResearchAgentSynthesisMessages(input: {
  question: string
  plan: ResearchAgentPlanAction
  asOf: string
  persistedFacts: unknown
  evidenceGate: ResearchAgentEvidenceGateResult
  promptRuleVersion: string
}): ConversationTurn[] {
  const outcomeRule = input.promptRuleVersion === RESEARCH_AGENT_PROMPT_RULE_VERSION
    ? '主进程已经完成证据评估。persistedFacts.evidenceGate.decision为local_sufficient时，evidenceDocuments与门禁采用的正文样本完全一致；为network_required时，evidenceDocuments是当前已取得但尚未达到数量、时效或来源等级门槛的可用样本。无论哪种情况都必须完成综合，不得返回blocked。outcome评价的是核心问题覆盖，不是未知项数量：complete表示核心问题已在当前证据边界内得到可追溯回答，可以同时保留未来未知项、验证清单和次要数据缺口；不得仅因存在未知项就降级。partial仅用于一个或多个核心子问题仍无法回答，rationale必须点明尚未回答的核心子问题。'
    : '主进程已经完成证据评估。persistedFacts.evidenceGate.decision为local_sufficient时，evidenceDocuments与门禁采用的正文样本完全一致；为network_required时，evidenceDocuments是当前已取得但尚未达到数量、时效或来源等级门槛的可用样本。无论哪种情况都必须完成综合，不得返回blocked；证据支持有限时返回partial，并把每项边界写入反证与风险、未知项。'
  return [{
    role: 'user',
    content: [
      '你是应用内部的受控单Agent研究综合器。只能使用下方已经持久化的本地与联网事实投影，不得自行联网、不得引用模型记忆补齐缺口。',
      '必须只返回一个JSON对象，不要使用Markdown代码块，也不得增加字段。',
      '返回结构：{"protocolVersion":"single-agent.v1","action":"finish","outcome":"complete|partial|blocked","reportMarkdown":"...","rationale":"..."}',
      'reportMarkdown必须包含：结论摘要、支持证据、反证与风险、未知项、资料截点、继续验证清单。',
      '涉及本地事实的重要句子必须原样引用persistedFacts中的[E-XXXXXXXXXX]编号。支持事实不等于买入，反证不等于卖出。',
      outcomeRule,
      '禁止肯定式买卖指令、收益承诺、具体目标价、仓位建议和晚于截点的已发生事实。',
      '',
      JSON.stringify({
        question: input.question,
        asOf: input.asOf,
        plan: input.plan,
        evidenceGate: input.evidenceGate,
        persistedFacts: input.persistedFacts,
      }),
    ].join('\n'),
  }]
}

function toolPromptDefinition(definition: ResearchAgentToolDefinition) {
  return {
    id: definition.id,
    description: definition.description,
    scope: definition.scope,
    asOf: definition.asOf,
    inputSchema: definition.inputSchema,
  }
}

function parseActionJson(text: string): Record<string, unknown> {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const candidate = fenced ? fenced[1].trim() : trimmed
  let value: unknown
  try { value = JSON.parse(candidate) } catch { invalid('模型动作不是有效JSON') }
  if (!isRecord(value)) invalid('模型动作必须是JSON对象')
  return value
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys)
  const extra = Object.keys(value).find((key) => !expected.has(key))
  const missing = keys.find((key) => !(key in value))
  if (extra) invalid(`模型动作包含额外字段：${extra}`)
  if (missing) invalid(`模型动作缺少字段：${missing}`)
}

function stringArray(value: unknown, minimum: number, maximum: number, maxText: number, field: string): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    invalid(`${field}数量必须为${minimum}至${maximum}`)
  }
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

function invalid(message: string): never {
  throw new ResearchAgentProtocolError('ACTION_SCHEMA_INVALID', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
