import { createHash } from 'node:crypto'
import type { AIWebSearchTrace } from './aiProvider'
import type {
  ResearchFactToolDataMap,
  ResearchFactToolEnvelope,
  ResearchFactToolId,
  StockAnnouncementsData,
  StockFundamentalsData,
  StockPriceHistoryData,
  StockTrendSnapshotData,
} from './researchFactToolRegistry'

const MAX_SUBJECTS = 8
const MAX_ITEMS_PER_CATEGORY = 8
const MAX_DETAIL_CHARS = 240
const MAX_CONTRAST_MARKDOWN_CHARS = 8_000
const MAX_AUDIT_EXCERPTS = 5
const MAX_AUDIT_CHECKS = 20
const EVIDENCE_REFERENCE_PATTERN = /\bE-[A-F0-9]{10}\b/gi

type ToolEnvelope<K extends ResearchFactToolId> = ResearchFactToolEnvelope<K, ResearchFactToolDataMap[K]>

export type ResearchEvidenceSubjectKind = 'stock' | 'judgment' | 'industry_project'

export interface ResearchEvidenceItem {
  referenceId?: string
  code: string
  toolId: string
  label: string
  detail: string
  factDate: string | null
  sourceIds: string[]
}

export interface ResearchEvidenceSubject {
  subjectKind: ResearchEvidenceSubjectKind
  subjectId: string
  label: string
  supporting: ResearchEvidenceItem[]
  challenging: ResearchEvidenceItem[]
  unknowns: ResearchEvidenceItem[]
}

export interface ResearchEvidenceContrast {
  schemaVersion: 1
  generatedAt: number
  asOf: string | null
  subjects: ResearchEvidenceSubject[]
  warnings: string[]
  markdown: string
}

export interface StockResearchEvidenceInput {
  stockCode: string
  priceHistory?: ResearchFactToolEnvelope<'stock.price_history', StockPriceHistoryData> | null
  trend: ResearchFactToolEnvelope<'stock.trend_snapshot', StockTrendSnapshotData>
  fundamentals: ResearchFactToolEnvelope<'stock.fundamentals', StockFundamentalsData>
  announcements: ResearchFactToolEnvelope<'stock.announcements', StockAnnouncementsData>
}

export interface ResearchTextAuditCheck {
  code: string
  status: 'passed' | 'warning' | 'blocked'
  message: string
  excerpts: string[]
}

export interface ResearchTextAudit {
  schemaVersion: 1
  documentKind: 'discussion' | 'industry_report'
  status: 'passed' | 'warning' | 'blocked'
  generatedAt: number
  asOf: string | null
  originalTextSha256: string
  checkedCharacters: number
  evidenceSummary: {
    subjectCount: number
    supporting: number
    challenging: number
    unknowns: number
  }
  citationSummary?: ResearchCitationSummary
  checks: ResearchTextAuditCheck[]
}

export interface ResearchCitationSummary {
  evidenceSnapshotSha256: string | null
  availableReferences: number
  referencedIds: string[]
  unresolvedIds: string[]
}

export interface ResearchAuditTraceEvidenceItem {
  referenceId: string
  category: 'supporting' | 'challenging' | 'unknowns'
  toolId: string
  label: string
  detail: string
  factDate: string | null
  sourceIds: string[]
  referenced: boolean
}

export interface ResearchAuditTraceView {
  schemaVersion: 1
  status: ResearchTextAudit['status']
  replayStatus: 'ready' | 'legacy' | 'document_mismatch' | 'snapshot_mismatch' | 'evidence_unavailable'
  generatedAt: number
  asOf: string | null
  originalTextSha256: string
  checkedCharacters: number
  evidenceSnapshotSha256: string | null
  evidenceSummary: ResearchTextAudit['evidenceSummary']
  citationSummary: {
    availableReferences: number
    referencedReferences: number
    unresolvedReferences: number
  }
  checkSummary: {
    passed: number
    warning: number
    blocked: number
  }
  findings: ResearchTextAuditCheck[]
  warnings: string[]
  subjects: Array<{
    subjectKind: ResearchEvidenceSubjectKind
    subjectId: string
    label: string
    items: ResearchAuditTraceEvidenceItem[]
  }>
}

export interface AuditResearchTextInput {
  text: string
  documentKind: ResearchTextAudit['documentKind']
  evidenceContrast?: ResearchEvidenceContrast | null
  asOf?: string | null
  excludedUrls?: string[]
  webSearchTrace?: AIWebSearchTrace
  allowedFactTexts?: string[]
  now?: number
}

export function buildStockResearchEvidenceContrast(
  inputs: StockResearchEvidenceInput[],
  options: { generatedAt: number; asOf: string | null },
): ResearchEvidenceContrast {
  const subjects = inputs.slice(0, MAX_SUBJECTS).map((input) => {
    const subject = createSubject('stock', input.stockCode, stockLabel(input))
    appendEnvelopeGap(subject, input.trend)
    appendEnvelopeGap(subject, input.fundamentals)
    appendEnvelopeGap(subject, input.announcements)
    if (input.priceHistory) appendEnvelopeGap(subject, input.priceHistory)
    appendTrendEvidence(subject, input.trend)
    appendFundamentalEvidence(subject, input.fundamentals)
    appendAnnouncementEvidence(subject, input.announcements)
    return subject
  })
  return finalizeContrast(subjects, collectEnvelopeWarnings(inputs.flatMap((input) => [
    input.trend,
    input.fundamentals,
    input.announcements,
    ...(input.priceHistory ? [input.priceHistory] : []),
  ])), options)
}

export function buildContextResearchEvidenceContrast(
  subjectKind: 'judgment' | 'industry_project',
  subjectId: string,
  envelope: ToolEnvelope<'decision.judgment_history'> | ToolEnvelope<'industry.project_snapshot'>,
  options: { generatedAt: number; asOf: string | null },
): ResearchEvidenceContrast {
  const subject = createSubject(
    subjectKind,
    subjectId,
    contextSubjectLabel(subjectKind, envelope),
  )
  appendEnvelopeGap(subject, envelope)
  if (envelope.toolId === 'decision.judgment_history') {
    appendJudgmentEvidence(subject, envelope)
  } else {
    appendIndustryProjectEvidence(subject, envelope)
  }
  return finalizeContrast([subject], collectEnvelopeWarnings([envelope]), options)
}

export function emptyResearchEvidenceContrast(
  generatedAt: number,
  asOf: string | null,
  warning?: string,
): ResearchEvidenceContrast {
  return finalizeContrast([], warning ? [warning] : [], { generatedAt, asOf })
}

export function mergeResearchEvidenceContrasts(
  contrasts: Array<ResearchEvidenceContrast | null | undefined>,
  options: { generatedAt?: number; asOf?: string | null } = {},
): ResearchEvidenceContrast {
  const valid = contrasts.filter(isResearchEvidenceContrast)
  const generatedAt = options.generatedAt
    ?? (valid.length > 0 ? Math.max(...valid.map((item) => item.generatedAt)) : Date.now())
  const asOfValues = [...new Set(valid.map((item) => item.asOf).filter((value): value is string => Boolean(value)))]
  const asOf = options.asOf === undefined ? (asOfValues.length === 1 ? asOfValues[0] : null) : options.asOf
  const warnings = valid.flatMap((item) => item.warnings)
  if (asOfValues.length > 1) warnings.push('证据对照包含不同事实截点，最终文本不得合并冒充同一时点事实')
  return finalizeContrast(
    valid.flatMap((item) => item.subjects).slice(0, MAX_SUBJECTS).map(cloneSubject),
    warnings,
    { generatedAt, asOf },
  )
}

export function isResearchEvidenceContrast(value: unknown): value is ResearchEvidenceContrast {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const contrast = value as Partial<ResearchEvidenceContrast>
  return contrast.schemaVersion === 1
    && typeof contrast.generatedAt === 'number'
    && Number.isFinite(contrast.generatedAt)
    && (contrast.asOf == null || /^\d{8}$/.test(contrast.asOf))
    && Array.isArray(contrast.subjects)
    && contrast.subjects.length <= MAX_SUBJECTS
    && contrast.subjects.every(isEvidenceSubject)
    && Array.isArray(contrast.warnings)
    && contrast.warnings.length <= 20
    && contrast.warnings.every((warning) => typeof warning === 'string')
    && typeof contrast.markdown === 'string'
    && contrast.markdown.length <= MAX_CONTRAST_MARKDOWN_CHARS
}

export function getResearchEvidenceReferenceId(
  subject: Pick<ResearchEvidenceSubject, 'subjectKind' | 'subjectId'>,
  item: Pick<ResearchEvidenceItem, 'toolId' | 'code'>,
): string {
  const digest = createHash('sha256')
    .update(`${subject.subjectKind}\u0000${subject.subjectId}\u0000${item.toolId}\u0000${item.code}`)
    .digest('hex')
    .slice(0, 10)
    .toUpperCase()
  return `E-${digest}`
}

export function hashResearchEvidenceContrast(value: unknown): string | null {
  if (!isResearchEvidenceContrast(value)) return null
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: value.schemaVersion,
    asOf: value.asOf,
    subjects: value.subjects.map((subject) => ({
      subjectKind: subject.subjectKind,
      subjectId: subject.subjectId,
      label: subject.label,
      supporting: normalizeEvidenceItems(subject, subject.supporting),
      challenging: normalizeEvidenceItems(subject, subject.challenging),
      unknowns: normalizeEvidenceItems(subject, subject.unknowns),
    })),
    warnings: value.warnings,
  })).digest('hex')
}

export function validatedResearchEvidenceReferenceIds(value: unknown): string[] | null {
  if (!isResearchEvidenceContrast(value)) return null
  const referenceIds: string[] = []
  for (const subject of value.subjects) {
    for (const item of [...subject.supporting, ...subject.challenging, ...subject.unknowns]) {
      const expectedReferenceId = getResearchEvidenceReferenceId(subject, item)
      if (item.referenceId !== expectedReferenceId) return null
      referenceIds.push(expectedReferenceId)
    }
  }
  return [...new Set(referenceIds)]
}

export function isResearchTextAudit(value: unknown): value is ResearchTextAudit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const audit = value as Partial<ResearchTextAudit>
  return audit.schemaVersion === 1
    && (audit.documentKind === 'discussion' || audit.documentKind === 'industry_report')
    && (audit.status === 'passed' || audit.status === 'warning' || audit.status === 'blocked')
    && typeof audit.generatedAt === 'number'
    && Number.isFinite(audit.generatedAt)
    && (audit.asOf == null || /^\d{8}$/.test(audit.asOf))
    && typeof audit.originalTextSha256 === 'string'
    && /^[a-f0-9]{64}$/.test(audit.originalTextSha256)
    && typeof audit.checkedCharacters === 'number'
    && Number.isInteger(audit.checkedCharacters)
    && audit.checkedCharacters >= 0
    && isEvidenceSummary(audit.evidenceSummary)
    && (audit.citationSummary == null || isCitationSummary(audit.citationSummary))
    && Array.isArray(audit.checks)
    && audit.checks.length <= MAX_AUDIT_CHECKS
    && audit.checks.every(isAuditCheck)
}

export function buildResearchAuditTraceView(
  auditValue: unknown,
  evidenceValue: unknown,
  documentTextValue?: unknown,
): ResearchAuditTraceView | null {
  if (!isResearchTextAudit(auditValue)) return null
  const evidence = isResearchEvidenceContrast(evidenceValue) ? evidenceValue : null
  const actualSnapshotHash = hashResearchEvidenceContrast(evidence)
  const expectedSnapshotHash = auditValue.citationSummary?.evidenceSnapshotSha256 ?? null
  const documentText = typeof documentTextValue === 'string' ? documentTextValue.trim() : null
  const documentMismatch = auditValue.status !== 'blocked'
    && documentText != null
    && createHash('sha256').update(documentText).digest('hex') !== auditValue.originalTextSha256
  const snapshotMismatch = Boolean(expectedSnapshotHash && actualSnapshotHash !== expectedSnapshotHash)
  const summaryMatches = evidence ? evidenceSummaryEquals(auditValue.evidenceSummary, summarizeEvidence(evidence)) : false
  const canReplayEvidence = Boolean(evidence && !documentMismatch && !snapshotMismatch && summaryMatches)
  const replayStatus: ResearchAuditTraceView['replayStatus'] = documentMismatch
    ? 'document_mismatch'
    : snapshotMismatch || (evidence && !summaryMatches)
    ? 'snapshot_mismatch'
    : !evidence
      ? 'evidence_unavailable'
      : auditValue.citationSummary
        ? 'ready'
        : 'legacy'
  const referencedIds = new Set(auditValue.citationSummary?.referencedIds ?? [])
  const subjects = canReplayEvidence && evidence
    ? evidence.subjects.map((subject) => ({
        subjectKind: subject.subjectKind,
        subjectId: subject.subjectId,
        label: subject.label,
        items: ([
          ...subject.supporting.map((item) => traceEvidenceItem(subject, item, 'supporting', referencedIds)),
          ...subject.challenging.map((item) => traceEvidenceItem(subject, item, 'challenging', referencedIds)),
          ...subject.unknowns.map((item) => traceEvidenceItem(subject, item, 'unknowns', referencedIds)),
        ]).slice(0, MAX_ITEMS_PER_CATEGORY * 3),
      }))
    : []
  const findings = auditValue.checks.filter((item) => item.status !== 'passed')
  return {
    schemaVersion: 1,
    status: auditValue.status,
    replayStatus,
    generatedAt: auditValue.generatedAt,
    asOf: auditValue.asOf,
    originalTextSha256: auditValue.originalTextSha256,
    checkedCharacters: auditValue.checkedCharacters,
    evidenceSnapshotSha256: expectedSnapshotHash ?? actualSnapshotHash,
    evidenceSummary: { ...auditValue.evidenceSummary },
    citationSummary: {
      availableReferences: auditValue.citationSummary?.availableReferences
        ?? countEvidenceItems(evidence),
      referencedReferences: auditValue.citationSummary?.referencedIds.length ?? 0,
      unresolvedReferences: auditValue.citationSummary?.unresolvedIds.length ?? 0,
    },
    checkSummary: {
      passed: auditValue.checks.filter((item) => item.status === 'passed').length,
      warning: auditValue.checks.filter((item) => item.status === 'warning').length,
      blocked: auditValue.checks.filter((item) => item.status === 'blocked').length,
    },
    findings: findings.map((item) => ({ ...item, excerpts: [...item.excerpts] })),
    warnings: evidence?.warnings.slice(0, 20) ?? [],
    subjects,
  }
}

function isEvidenceSubject(value: unknown): value is ResearchEvidenceSubject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const subject = value as Partial<ResearchEvidenceSubject>
  return subject.subjectKind != null
    && ['stock', 'judgment', 'industry_project'].includes(subject.subjectKind)
    && typeof subject.subjectId === 'string'
    && typeof subject.label === 'string'
    && isEvidenceItems(subject.supporting)
    && isEvidenceItems(subject.challenging)
    && isEvidenceItems(subject.unknowns)
}

function isEvidenceItems(value: unknown): value is ResearchEvidenceItem[] {
  return Array.isArray(value)
    && value.length <= MAX_ITEMS_PER_CATEGORY
    && value.every((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false
      const evidence = item as Partial<ResearchEvidenceItem>
      return typeof evidence.code === 'string'
        && typeof evidence.toolId === 'string'
        && typeof evidence.label === 'string'
        && typeof evidence.detail === 'string'
        && (evidence.factDate == null || typeof evidence.factDate === 'string')
        && Array.isArray(evidence.sourceIds)
        && evidence.sourceIds.every((sourceId) => typeof sourceId === 'string')
    })
}

export function auditResearchText(input: AuditResearchTextInput): ResearchTextAudit {
  const text = input.text.trim()
  const evidence = isResearchEvidenceContrast(input.evidenceContrast) ? input.evidenceContrast : null
  const evidenceSummary = summarizeEvidence(evidence)
  const citationSummary = buildCitationSummary(text, evidence)
  const checks: ResearchTextAuditCheck[] = []

  const transactionExcerpts = collectAffirmativeProhibitedExcerpts(text)
  checks.push(check(
    'PROHIBITED_TRANSACTION_INSTRUCTION',
    transactionExcerpts.length > 0 ? 'blocked' : 'passed',
    transactionExcerpts.length > 0
      ? '检测到肯定式交易指令、收益承诺、具体目标价或仓位表达'
      : '未检测到肯定式交易指令、收益承诺、具体目标价或仓位表达',
    transactionExcerpts,
  ))

  const excludedSourceExcerpts = findExcludedSourceExcerpts(
    text,
    input.excludedUrls ?? [],
    input.webSearchTrace,
  )
  checks.push(check(
    'EXCLUDED_SOURCE_REFERENCE',
    excludedSourceExcerpts.length > 0 ? 'blocked' : 'passed',
    excludedSourceExcerpts.length > 0 ? '检测到用户明确排除的来源' : '未检测到用户明确排除的来源',
    excludedSourceExcerpts,
  ))

  const certaintyExcerpts = collectRegexExcerpts(
    text,
    /(?:必然(?:上涨|下跌|增长|下降|兑现|发生)|确定会|肯定会|毫无疑问|必将|已经完全证实|已被完全证实)/g,
  )
  checks.push(check(
    'EXCESSIVE_CERTAINTY',
    certaintyExcerpts.length > 0 ? 'warning' : 'passed',
    certaintyExcerpts.length > 0 ? '存在超过当前证据强度的确定性措辞' : '未检测到明显过度确定性措辞',
    certaintyExcerpts,
  ))

  const completenessExcerpts = evidenceSummary.unknowns > 0
    ? collectRegexExcerpts(text, /(?:数据|事实|证据|信息|来源).{0,10}(?:完整|全面覆盖|充分|全部(?:得到)?核验|均已核验)/g)
    : []
  checks.push(check(
    'EVIDENCE_COMPLETENESS_OVERCLAIM',
    completenessExcerpts.length > 0 ? 'warning' : 'passed',
    completenessExcerpts.length > 0 ? '事实底稿存在未知项，但最终文本声称完整或全面核验' : '未发现与事实底稿状态冲突的完整性宣称',
    completenessExcerpts,
  ))

  const announcementEvidencePresent = evidence?.subjects.some((subject) => [
    ...subject.supporting,
    ...subject.challenging,
    ...subject.unknowns,
  ].some((item) => item.toolId === 'stock.announcements')) ?? false
  const announcementExcerpts = announcementEvidencePresent
    ? collectAnnouncementOverclaimExcerpts(text)
    : []
  checks.push(check(
    'ANNOUNCEMENT_TITLE_OVERCLAIM',
    announcementExcerpts.length > 0 ? 'warning' : 'passed',
    announcementExcerpts.length > 0 ? '公告工具仅有标题索引，但最终文本将其升级为公告正文事实' : '未将公告标题索引升级为正文事实',
    announcementExcerpts,
  ))

  const futureFactExcerpts = collectFutureFactExcerpts(text, input.asOf ?? evidence?.asOf ?? null)
  checks.push(check(
    'FUTURE_FACT_AFTER_CUTOFF',
    futureFactExcerpts.length > 0 ? 'warning' : 'passed',
    futureFactExcerpts.length > 0 ? '检测到晚于事实截点且以已发生事实口径表述的日期' : '未检测到截点后的已发生事实表述',
    futureFactExcerpts,
  ))

  const hasRiskDisclosure = /风险|反证|失效|削弱|不利|下行|回撤|约束|瓶颈|冲突/.test(text)
  checks.push(check(
    'CHALLENGING_EVIDENCE_DISCLOSURE',
    evidenceSummary.challenging > 0 && !hasRiskDisclosure ? 'warning' : 'passed',
    evidenceSummary.challenging > 0 && !hasRiskDisclosure
      ? '证据对照包含反证或风险，但最终文本未披露'
      : '反证与风险披露满足当前证据对照要求',
    [],
  ))

  const hasUnknownDisclosure = /未知|缺失|待核验|待补|证据不足|不确定|未覆盖|不可用|尚无|未读取|未披露/.test(text)
  checks.push(check(
    'UNKNOWN_GAP_DISCLOSURE',
    evidenceSummary.unknowns > 0 && !hasUnknownDisclosure ? 'warning' : 'passed',
    evidenceSummary.unknowns > 0 && !hasUnknownDisclosure
      ? '证据对照包含未知项，但最终文本未说明证据缺口'
      : '未知项与证据缺口披露满足当前证据对照要求',
    [],
  ))

  const numericExcerpts = collectUntraceableNumericExcerpts(text, input.allowedFactTexts ?? [])
  checks.push(check(
    'PRECISE_NUMBER_TRACEABILITY',
    numericExcerpts.length > 0 ? 'warning' : 'passed',
    numericExcerpts.length > 0 ? '部分高精度数字未在允许的输入底稿中找到同值' : '未发现无法追溯的高精度数字',
    numericExcerpts,
  ))

  checks.push(check(
    'EVIDENCE_REFERENCE_REQUIRED',
    citationSummary.availableReferences > 0 && citationSummary.referencedIds.length === 0 ? 'warning' : 'passed',
    citationSummary.availableReferences > 0 && citationSummary.referencedIds.length === 0
      ? '最终文本没有引用本轮确定性证据编号，无法形成结论级定位'
      : '最终文本已保留可识别的确定性证据引用，或本轮没有可引用证据',
    [],
  ))

  checks.push(check(
    'EVIDENCE_REFERENCE_UNKNOWN',
    citationSummary.unresolvedIds.length > 0 ? 'warning' : 'passed',
    citationSummary.unresolvedIds.length > 0
      ? '最终文本包含不属于本轮证据快照的引用编号'
      : '未检测到本轮证据快照之外的引用编号',
    citationSummary.unresolvedIds,
  ))

  if (input.documentKind === 'industry_report') {
    const missingSections = missingIndustryReportSections(text)
    checks.push(check(
      'REQUIRED_REPORT_SECTIONS',
      missingSections.length > 0 ? 'warning' : 'passed',
      missingSections.length > 0 ? `产业报告缺少必需章节：${missingSections.join('、')}` : '产业报告包含全部必需章节',
      [],
    ))
  }

  const status = checks.some((item) => item.status === 'blocked')
    ? 'blocked'
    : checks.some((item) => item.status === 'warning')
      ? 'warning'
      : 'passed'
  return {
    schemaVersion: 1,
    documentKind: input.documentKind,
    status,
    generatedAt: input.now ?? Date.now(),
    asOf: normalizeAsOf(input.asOf ?? evidence?.asOf ?? null),
    originalTextSha256: createHash('sha256').update(text).digest('hex'),
    checkedCharacters: text.length,
    evidenceSummary,
    citationSummary,
    checks,
  }
}

export function buildBlockedResearchText(audit: ResearchTextAudit): string {
  const blockedCodes = audit.checks.filter((item) => item.status === 'blocked').map((item) => item.code)
  if (audit.documentKind === 'discussion') {
    return [
      '本轮模型输出未通过确定性研究审计，原结论未写入讨论记录。',
      '',
      `审计状态：blocked；规则：${blockedCodes.join('、') || 'UNKNOWN'}`,
      `原始文本校验值：${audit.originalTextSha256}`,
      '请调整问题或证据后重新发起。本次不会把被阻断内容作为后续讨论事实。',
    ].join('\n')
  }
  return [
    '# 研究报告未通过确定性审计',
    '',
    '> 本次模型正文触发硬性研究边界，原结论未写入项目报告。以下仅保留审计状态，不构成研究结论。',
    '',
    '## 一、核心结论',
    '',
    `本次输出已阻断。规则：${blockedCodes.join('、') || 'UNKNOWN'}。`,
    '',
    '## 二、研究边界',
    '',
    `事实截点：${formatDate(audit.asOf)}；原始文本校验值：${audit.originalTextSha256}。`,
    '',
    '## 三、产业链全景',
    '',
    '原模型内容未通过审计，本节不保留其结论。',
    '',
    '## 四、供需、价格与景气判断',
    '',
    '原模型内容未通过审计，本节不保留其结论。',
    '',
    '## 五、利润池与瓶颈',
    '',
    '原模型内容未通过审计，本节不保留其结论。',
    '',
    '## 六、代表公司映射',
    '',
    '原模型内容未通过审计，本节不保留其结论。',
    '',
    '## 七、跟踪指标与证伪条件',
    '',
    '修订模型输出或补充可靠证据后重新生成。',
    '',
    '## 八、资料口径与缺口',
    '',
    '审计产物已随当前生成运行固化；被阻断原文不进入项目报告。',
  ].join('\n')
}

function appendTrendEvidence(
  subject: ResearchEvidenceSubject,
  envelope: ToolEnvelope<'stock.trend_snapshot'>,
): void {
  const data = envelope.data
  if (data.trendState === 'strengthening' || data.trendState === 'strong') {
    addItem(subject, 'supporting', evidenceItem(envelope, 'trend_state_positive', '趋势状态', `本地确定性趋势状态=${data.trendState}，综合分=${formatNumber(data.totalScore)}`))
  } else if (data.trendState === 'weakening' || data.trendState === 'broken') {
    addItem(subject, 'challenging', evidenceItem(envelope, 'trend_state_negative', '趋势状态', `本地确定性趋势状态=${data.trendState}，综合分=${formatNumber(data.totalScore)}`))
  } else if (data.trendState === 'stable') {
    addItem(subject, 'unknowns', evidenceItem(envelope, 'trend_state_neutral', '趋势状态', `趋势状态=stable，不能单独支持方向性结论`))
  }
  appendSignedMetric(subject, envelope, 'stock_return_20d', '个股20日收益', data.facts?.stockReturn20d)
  appendSignedMetric(subject, envelope, 'excess_return_20d', '相对沪深300超额', data.facts?.excessReturn20d)
  if (data.benchmark.status !== 'ready') {
    addItem(subject, 'unknowns', evidenceItem(envelope, 'benchmark_missing', '相对基准', '沪深300同期基准不足，相对结论不可用'))
  }
}

function appendSignedMetric(
  subject: ResearchEvidenceSubject,
  envelope: ToolEnvelope<'stock.trend_snapshot'>,
  code: string,
  label: string,
  value: number | null | undefined,
): void {
  if (value == null || !Number.isFinite(value)) return
  const category = value > 0 ? 'supporting' : value < 0 ? 'challenging' : 'unknowns'
  addItem(subject, category, evidenceItem(envelope, code, label, `${label}=${formatPercent(value)}`))
}

function appendFundamentalEvidence(
  subject: ResearchEvidenceSubject,
  envelope: ToolEnvelope<'stock.fundamentals'>,
): void {
  const financial = envelope.data.latestFinancial
  if (!financial) {
    addItem(subject, 'unknowns', evidenceItem(envelope, 'financial_missing', '核心财务', '截点内没有可用核心财务事实'))
    return
  }
  appendFundamentalMetric(subject, envelope, 'revenue_yoy', '营收同比', financial.revenueYoy)
  appendFundamentalMetric(subject, envelope, 'profit_yoy', '归母净利同比', financial.parentNetProfitYoy)
}

function appendFundamentalMetric(
  subject: ResearchEvidenceSubject,
  envelope: ToolEnvelope<'stock.fundamentals'>,
  code: string,
  label: string,
  value: number | null | undefined,
): void {
  if (value == null || !Number.isFinite(value)) {
    addItem(subject, 'unknowns', evidenceItem(envelope, `${code}_missing`, label, `${label}=未知`))
    return
  }
  const category = value > 0 ? 'supporting' : value < 0 ? 'challenging' : 'unknowns'
  addItem(subject, category, evidenceItem(envelope, code, label, `${label}=${formatPercent(value)}，报告期=${formatDate(envelope.data.latestFinancial?.reportDate)}`))
}

function appendAnnouncementEvidence(
  subject: ResearchEvidenceSubject,
  envelope: ToolEnvelope<'stock.announcements'>,
): void {
  if (envelope.data.announcements.length === 0) {
    addItem(subject, 'unknowns', evidenceItem(envelope, 'announcement_index_empty', '公告正文', '没有可用公告标题索引，且工具未读取公告正文'))
    return
  }
  const titles = envelope.data.announcements.slice(0, 3).map((item) => `${formatDate(item.noticeDate)} ${clip(item.title, 80)}`)
  addItem(subject, 'unknowns', evidenceItem(
    envelope,
    'announcement_title_only',
    '公告正文',
    `仅有${envelope.data.announcements.length}条标题索引，未核验正文：${titles.join('；')}`,
  ))
}

function appendJudgmentEvidence(
  subject: ResearchEvidenceSubject,
  envelope: ToolEnvelope<'decision.judgment_history'>,
): void {
  const latest = envelope.data.versions[0]
  if (!latest) {
    addItem(subject, 'unknowns', evidenceItem(envelope, 'judgment_version_missing', '判断版本', '事实截点内没有可用判断版本'))
    return
  }
  const tagCategory = latest.tag === 'watch'
    ? 'supporting'
    : latest.tag === 'risk_off'
      ? 'challenging'
      : 'unknowns'
  addItem(subject, tagCategory, evidenceItem(envelope, `judgment_tag_${latest.tag}`, '最新判断标签', `v${latest.versionNumber}=${latest.tag}；${clip(latest.note || '无备注', 160)}`))
  for (const evidence of latest.evidence.slice(0, 6)) {
    const category = evidence.status === 'ready'
      ? 'supporting'
      : evidence.status === 'blocked'
        ? 'challenging'
        : 'unknowns'
    addItem(subject, category, evidenceItem(envelope, `judgment_evidence_${evidence.key}`, evidence.label, `${evidence.status}：${clip(evidence.detail, 180)}`))
  }
}

function appendIndustryProjectEvidence(
  subject: ResearchEvidenceSubject,
  envelope: ToolEnvelope<'industry.project_snapshot'>,
): void {
  const data = envelope.data
  if (!data.snapshot) {
    addItem(subject, 'unknowns', evidenceItem(envelope, 'industry_snapshot_missing', '产业项目快照', '事实截点内没有不可变产业项目快照'))
    return
  }
  if (data.evidenceRefs.length === 0) {
    addItem(subject, 'unknowns', evidenceItem(envelope, 'industry_evidence_missing', '产业证据', '快照内没有可用证据引用'))
  }
  for (const item of data.evidenceRefs.slice(0, 5)) {
    addItem(
      subject,
      item.primarySourceConfirmed ? 'supporting' : 'unknowns',
      evidenceItem(envelope, `industry_evidence_${item.id}`, '产业证据引用', `${clip(item.title, 150)}；${item.primarySourceConfirmed ? '一手来源已确认' : '一手来源未确认'}`),
    )
  }
  for (const hypothesis of data.hypotheses.slice(0, 5)) {
    const normalized = hypothesis.status.toLowerCase()
    const category = /supported|confirmed|validated|获得支持|已验证/.test(normalized)
      ? 'supporting'
      : /rejected|falsified|invalid|weakened|已推翻|被削弱/.test(normalized)
        ? 'challenging'
        : 'unknowns'
    addItem(subject, category, evidenceItem(
      envelope,
      `industry_hypothesis_${hypothesis.id}`,
      '产业假设',
      `${clip(hypothesis.statement, 150)}；状态=${hypothesis.status}；最低成本反证=${clip(hypothesis.cheapestDisproof || '未知', 100)}`,
    ))
  }
  const bottlenecks = data.graph.edges.filter((edge) => edge.bottleneck).slice(0, 3)
  for (const edge of bottlenecks) {
    addItem(subject, 'challenging', evidenceItem(envelope, `industry_bottleneck_${edge.sourceNodeId}_${edge.targetNodeId}`, '产业瓶颈', `${edge.sourceNodeId} -> ${edge.targetNodeId}；关系=${edge.relation}`))
  }
}

function appendEnvelopeGap(
  subject: ResearchEvidenceSubject,
  envelope: ResearchFactToolEnvelope<ResearchFactToolId, unknown>,
): void {
  if (envelope.status === 'ready') return
  addItem(subject, 'unknowns', evidenceItem(
    envelope,
    `tool_status_${envelope.toolId.replace(/\W/g, '_')}`,
    '工具覆盖',
    `${envelope.toolId}=${envelope.status}；覆盖=${envelope.coverage.available}/${envelope.coverage.required ?? '--'} ${envelope.coverage.unit}`,
  ))
}

function evidenceItem(
  envelope: ResearchFactToolEnvelope<ResearchFactToolId, unknown>,
  code: string,
  label: string,
  detail: string,
): ResearchEvidenceItem {
  const sources = envelope.sources.filter((source) => source.status === 'ready')
  return {
    code,
    toolId: envelope.toolId,
    label: clip(label, 80),
    detail: clip(detail, MAX_DETAIL_CHARS),
    factDate: sources.find((source) => source.factDate)?.factDate ?? null,
    sourceIds: sources.map((source) => source.id).slice(0, 4),
  }
}

function addItem(
  subject: ResearchEvidenceSubject,
  category: 'supporting' | 'challenging' | 'unknowns',
  item: ResearchEvidenceItem,
): void {
  const target = subject[category]
  if (target.length >= MAX_ITEMS_PER_CATEGORY || target.some((existing) => existing.code === item.code)) return
  target.push(item)
}

function createSubject(
  subjectKind: ResearchEvidenceSubjectKind,
  subjectId: string,
  label: string,
): ResearchEvidenceSubject {
  return { subjectKind, subjectId, label, supporting: [], challenging: [], unknowns: [] }
}

function stockLabel(input: StockResearchEvidenceInput): string {
  return input.fundamentals.data.profile?.shortName
    ?? input.fundamentals.data.latestFinancial?.shortName
    ?? input.trend.data.stockName
    ?? input.stockCode
}

function contextSubjectLabel(
  subjectKind: 'judgment' | 'industry_project',
  envelope: ToolEnvelope<'decision.judgment_history'> | ToolEnvelope<'industry.project_snapshot'>,
): string {
  if (subjectKind === 'judgment' && envelope.toolId === 'decision.judgment_history') {
    return envelope.data.stockName ?? envelope.data.tsCode ?? '判断历史'
  }
  if (envelope.toolId === 'industry.project_snapshot') return envelope.data.project?.title ?? '产业项目'
  return subjectKind
}

function finalizeContrast(
  subjects: ResearchEvidenceSubject[],
  warnings: string[],
  options: { generatedAt: number; asOf: string | null },
): ResearchEvidenceContrast {
  const boundedSubjects = subjects.slice(0, MAX_SUBJECTS).map((subject) => ({
    ...subject,
    supporting: normalizeEvidenceItems(subject, subject.supporting.slice(0, MAX_ITEMS_PER_CATEGORY)),
    challenging: normalizeEvidenceItems(subject, subject.challenging.slice(0, MAX_ITEMS_PER_CATEGORY)),
    unknowns: normalizeEvidenceItems(subject, subject.unknowns.slice(0, MAX_ITEMS_PER_CATEGORY)),
  }))
  const uniqueWarnings = [...new Set(warnings.map((warning) => clip(warning, 200)).filter(Boolean))].slice(0, 20)
  const contrast: ResearchEvidenceContrast = {
    schemaVersion: 1,
    generatedAt: options.generatedAt,
    asOf: normalizeAsOf(options.asOf),
    subjects: boundedSubjects,
    warnings: uniqueWarnings,
    markdown: '',
  }
  contrast.markdown = renderEvidenceContrastMarkdown(contrast).slice(0, MAX_CONTRAST_MARKDOWN_CHARS)
  return contrast
}

function renderEvidenceContrastMarkdown(contrast: ResearchEvidenceContrast): string {
  const sections = contrast.subjects.map((subject) => [
    `### ${subject.label}｜${subject.subjectKind}:${subject.subjectId}`,
    renderEvidenceCategory('支持证据', subject.supporting, '当前没有结构化支持项'),
    renderEvidenceCategory('反证与风险', subject.challenging, '当前没有结构化反证项，不等于风险不存在'),
    renderEvidenceCategory('未知与待核验', subject.unknowns, '当前没有额外未知项'),
  ].join('\n'))
  return [
    '## 确定性证据对照',
    '- 口径：由统一工具结构化结果生成，不解析或反推模型文本；支持项不等于买入结论，反证项不等于卖出结论。',
    `- 事实截点：${formatDate(contrast.asOf)}；支持/反证/未知必须并列进入最终结论校验。`,
    '- 引用规则：涉及下列本地事实的重要结论，必须在对应句末原样保留一个或多个证据编号，例如 [E-0123456789]；不得编造、改写或复用其他运行的编号。',
    ...(contrast.warnings.length > 0 ? [`- 工具警告：${contrast.warnings.join('；')}`] : []),
    '',
    ...(sections.length > 0 ? sections : ['- 当前没有可靠实体，未生成方向性证据对照。']),
  ].join('\n')
}

function renderEvidenceCategory(label: string, items: ResearchEvidenceItem[], fallback: string): string {
  if (items.length === 0) return `- ${label}：${fallback}`
  return `- ${label}：${items.map((item) => `[${item.referenceId}] ${item.label}=${item.detail}（${item.toolId}@${formatDate(item.factDate)}）`).join('；')}`
}

function collectEnvelopeWarnings(envelopes: Array<ResearchFactToolEnvelope<ResearchFactToolId, unknown>>): string[] {
  return envelopes.flatMap((envelope) => envelope.warnings.map((warning) => `${envelope.toolId}: ${warning}`))
}

function cloneSubject(subject: ResearchEvidenceSubject): ResearchEvidenceSubject {
  const cloneItems = (items: ResearchEvidenceItem[]) => items.map((item) => ({
    ...item,
    sourceIds: [...item.sourceIds],
  }))
  return {
    ...subject,
    supporting: cloneItems(subject.supporting),
    challenging: cloneItems(subject.challenging),
    unknowns: cloneItems(subject.unknowns),
  }
}

function normalizeEvidenceItems(
  subject: Pick<ResearchEvidenceSubject, 'subjectKind' | 'subjectId'>,
  items: ResearchEvidenceItem[],
): ResearchEvidenceItem[] {
  return items.map((item) => ({
    referenceId: getResearchEvidenceReferenceId(subject, item),
    code: item.code,
    toolId: item.toolId,
    label: item.label,
    detail: item.detail,
    factDate: item.factDate,
    sourceIds: [...item.sourceIds],
  }))
}

function buildCitationSummary(
  text: string,
  evidence: ResearchEvidenceContrast | null,
): ResearchCitationSummary {
  const referenceMap = new Map<string, ResearchEvidenceItem>()
  for (const subject of evidence?.subjects ?? []) {
    for (const item of [...subject.supporting, ...subject.challenging, ...subject.unknowns]) {
      referenceMap.set(getResearchEvidenceReferenceId(subject, item), item)
    }
  }
  const mentionedIds = [...new Set((text.match(EVIDENCE_REFERENCE_PATTERN) ?? []).map((item) => item.toUpperCase()))]
  return {
    evidenceSnapshotSha256: hashResearchEvidenceContrast(evidence),
    availableReferences: referenceMap.size,
    referencedIds: mentionedIds.filter((referenceId) => referenceMap.has(referenceId)).slice(0, 64),
    unresolvedIds: mentionedIds.filter((referenceId) => !referenceMap.has(referenceId)).slice(0, 20),
  }
}

function countEvidenceItems(evidence: ResearchEvidenceContrast | null): number {
  return (evidence?.subjects ?? []).reduce(
    (total, subject) => total + subject.supporting.length + subject.challenging.length + subject.unknowns.length,
    0,
  )
}

function traceEvidenceItem(
  subject: ResearchEvidenceSubject,
  item: ResearchEvidenceItem,
  category: ResearchAuditTraceEvidenceItem['category'],
  referencedIds: Set<string>,
): ResearchAuditTraceEvidenceItem {
  const referenceId = getResearchEvidenceReferenceId(subject, item)
  return {
    referenceId,
    category,
    toolId: item.toolId,
    label: item.label,
    detail: item.detail,
    factDate: item.factDate,
    sourceIds: [...item.sourceIds],
    referenced: referencedIds.has(referenceId),
  }
}

function isEvidenceSummary(value: unknown): value is ResearchTextAudit['evidenceSummary'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const summary = value as Partial<ResearchTextAudit['evidenceSummary']>
  return ['subjectCount', 'supporting', 'challenging', 'unknowns'].every((key) => {
    const number = summary[key as keyof ResearchTextAudit['evidenceSummary']]
    return typeof number === 'number' && Number.isInteger(number) && number >= 0 && number <= 1_000
  })
}

function isCitationSummary(value: unknown): value is ResearchCitationSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const summary = value as Partial<ResearchCitationSummary>
  return (summary.evidenceSnapshotSha256 == null || /^[a-f0-9]{64}$/.test(summary.evidenceSnapshotSha256))
    && typeof summary.availableReferences === 'number'
    && Number.isInteger(summary.availableReferences)
    && summary.availableReferences >= 0
    && summary.availableReferences <= 1_000
    && isReferenceIdList(summary.referencedIds, 64)
    && isReferenceIdList(summary.unresolvedIds, 20)
}

function isReferenceIdList(value: unknown, max: number): value is string[] {
  return Array.isArray(value)
    && value.length <= max
    && value.every((item) => typeof item === 'string' && /^E-[A-F0-9]{10}$/.test(item))
}

function isAuditCheck(value: unknown): value is ResearchTextAuditCheck {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<ResearchTextAuditCheck>
  return typeof item.code === 'string'
    && item.code.length > 0
    && item.code.length <= 80
    && (item.status === 'passed' || item.status === 'warning' || item.status === 'blocked')
    && typeof item.message === 'string'
    && item.message.length <= 500
    && Array.isArray(item.excerpts)
    && item.excerpts.length <= MAX_AUDIT_EXCERPTS
    && item.excerpts.every((excerpt) => typeof excerpt === 'string' && excerpt.length <= 500)
}

function evidenceSummaryEquals(
  left: ResearchTextAudit['evidenceSummary'],
  right: ResearchTextAudit['evidenceSummary'],
): boolean {
  return left.subjectCount === right.subjectCount
    && left.supporting === right.supporting
    && left.challenging === right.challenging
    && left.unknowns === right.unknowns
}

function summarizeEvidence(contrast: ResearchEvidenceContrast | null): ResearchTextAudit['evidenceSummary'] {
  const subjects = contrast?.subjects ?? []
  return {
    subjectCount: subjects.length,
    supporting: subjects.reduce((sum, subject) => sum + subject.supporting.length, 0),
    challenging: subjects.reduce((sum, subject) => sum + subject.challenging.length, 0),
    unknowns: subjects.reduce((sum, subject) => sum + subject.unknowns.length, 0),
  }
}

function check(
  code: string,
  status: ResearchTextAuditCheck['status'],
  message: string,
  excerpts: string[],
): ResearchTextAuditCheck {
  return { code, status, message, excerpts: [...new Set(excerpts)].slice(0, MAX_AUDIT_EXCERPTS) }
}

function collectAffirmativeProhibitedExcerpts(text: string): string[] {
  const excerpts = collectAffirmativeActionExcerpts(text)
  const patterns = [
    /(?:目标价|目标价格|止盈价|止损价)\s*(?:为|是|：|:|可设为|设在)?\s*[¥￥]?\d+(?:\.\d+)?/g,
    /(?:仓位|配置比例)\s*(?:为|控制在|设为|建议)?\s*\d+(?:\.\d+)?%/g,
    /(?:保证|确保).{0,10}(?:收益|盈利)|(?:稳赚|必涨|必跌|无风险收益)|(?:收益率).{0,10}(?:至少|不低于)\s*\d+(?:\.\d+)?%/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0
      if (isNegated(text, index)) continue
      excerpts.push(excerptAt(text, index, match[0].length))
    }
  }
  return [...new Set(excerpts)].slice(0, MAX_AUDIT_EXCERPTS)
}

function collectAffirmativeActionExcerpts(text: string): string[] {
  const excerpts: string[] = []
  for (const match of text.matchAll(/(?:买入|卖出|加仓|减仓|清仓|建仓|满仓|抄底)/g)) {
    const index = match.index ?? 0
    if (isResearchActionMention(text, index + match[0].length)) continue
    if (isNegated(text, index)) continue
    if (!hasAffirmativeInstructionContext(text, index)) continue
    excerpts.push(excerptAt(text, index, match[0].length))
  }
  return excerpts
}

function isResearchActionMention(text: string, actionEnd: number): boolean {
  const suffix = text.slice(actionEnd, actionEnd + 20).replace(/^[\s*_`]+/, '')
  return /^(?:结论|信号|条件|逻辑|依据|理由|行为|记录|历史|价格|成本|时点|口径|建议|指令|动作|风险|压力|意愿)/.test(suffix)
}

function hasAffirmativeInstructionContext(text: string, index: number): boolean {
  const prefix = scopedClausePrefix(text, index, 64)
  const normalized = prefix.replace(/[\s*_`]+/g, '')
  if (/(?<![不无未])(?:建议|应当|应该|应|可以|可考虑|宜|需要|务必|立即|直接|请|须|必须)[^。！？；;，,\n]{0,16}$/.test(normalized)) {
    return true
  }

  const commandLead = normalized
    .replace(/^[>#-]+/, '')
    .replace(/^\d+[.、)]/, '')
  return /^(?:随后|然后|再|先|择机|逢高|逢低|立即|直接|请)?$/.test(commandLead)
}

function isNegated(text: string, index: number): boolean {
  const prefix = scopedClausePrefix(text, index, 64).replace(/[\s*_`]+/g, '')
  if (/(?:不能|无法|不足以|尚不能|未能)(?:单独|直接)?(?:证明|说明|支持|得出|确认|推导|判断|认定|作为)[^。！？；;，,\n]{0,32}$/.test(prefix)) {
    return true
  }
  return /(?:不建议|不应该|不应当|不应|不宜|不必|不要|不得|不能|不可|禁止|避免|无需|无须|未建议|未要求|并非|而非|不是|切勿|不构成|别)[^。！？；;，,\n]{0,16}$/.test(prefix)
}

function scopedClausePrefix(text: string, index: number, limit: number): string {
  const prefix = text.slice(Math.max(0, index - limit), index)
  const boundary = Math.max(
    prefix.lastIndexOf('。'),
    prefix.lastIndexOf('！'),
    prefix.lastIndexOf('？'),
    prefix.lastIndexOf('；'),
    prefix.lastIndexOf(';'),
    prefix.lastIndexOf('，'),
    prefix.lastIndexOf(','),
    prefix.lastIndexOf('\n'),
  )
  return prefix.slice(boundary + 1)
}

function collectRegexExcerpts(text: string, pattern: RegExp): string[] {
  const excerpts: string[] = []
  for (const match of text.matchAll(pattern)) {
    excerpts.push(excerptAt(text, match.index ?? 0, match[0].length))
  }
  return [...new Set(excerpts)].slice(0, MAX_AUDIT_EXCERPTS)
}

function collectAnnouncementOverclaimExcerpts(text: string): string[] {
  const excerpts: string[] = []
  for (const match of text.matchAll(/公告.{0,8}(?:显示|证实|确认|披露|表明)/g)) {
    const excerpt = excerptAt(text, match.index ?? 0, match[0].length)
    if (/标题|索引|正文(?:尚未|未)(?:读取|核验)/.test(excerpt)) continue
    excerpts.push(excerpt)
  }
  return [...new Set(excerpts)].slice(0, MAX_AUDIT_EXCERPTS)
}

function collectFutureFactExcerpts(text: string, asOf: string | null): string[] {
  const cutoff = normalizeAsOf(asOf)
  if (!cutoff) return []
  const excerpts: string[] = []
  const datePattern = /(20\d{2})[-年/](\d{1,2})[-月/](\d{1,2})日?/g
  for (const match of text.matchAll(datePattern)) {
    const compact = `${match[1]}${match[2].padStart(2, '0')}${match[3].padStart(2, '0')}`
    if (compact <= cutoff) continue
    const excerpt = excerptAt(text, match.index ?? 0, match[0].length)
    if (/预计|计划|目标|到期|将|待|跟踪|验证|展望|假设|情景|未来|截止日之后/.test(excerpt)) continue
    if (!/截至|已经|已实现|实现了|录得|达到|公告|披露|显示|证实|确认/.test(excerpt)) continue
    excerpts.push(excerpt)
  }
  return [...new Set(excerpts)].slice(0, MAX_AUDIT_EXCERPTS)
}

function collectUntraceableNumericExcerpts(text: string, allowedFactTexts: string[]): string[] {
  if (allowedFactTexts.length === 0) return []
  const allowed = allowedFactTexts.map((item) => item.slice(0, 500_000)).join('\n').replace(/,/g, '')
  const excerpts: string[] = []
  const precisePattern = /(?<![\w])\d{1,9}(?:,\d{3})*(?:\.\d{2,})\s*(?:%|亿元|万元|元|倍)/g
  for (const match of text.matchAll(precisePattern)) {
    const numeric = match[0].match(/\d{1,9}(?:,\d{3})*(?:\.\d{2,})/)?.[0]?.replace(/,/g, '')
    if (!numeric || allowed.includes(numeric)) continue
    excerpts.push(excerptAt(text, match.index ?? 0, match[0].length))
  }
  return [...new Set(excerpts)].slice(0, MAX_AUDIT_EXCERPTS)
}

function missingIndustryReportSections(text: string): string[] {
  const required = [
    '核心结论',
    '研究边界',
    '产业链全景',
    '供需、价格与景气判断',
    '利润池与瓶颈',
    '代表公司映射',
    '跟踪指标与证伪条件',
    '资料口径与缺口',
  ]
  const headings = text.split(/\r?\n/).filter((line) => /^##\s+/.test(line)).join('\n')
  return required.filter((label) => !headings.includes(label))
}

function findExcludedSourceExcerpts(
  text: string,
  excludedUrls: string[],
  trace?: AIWebSearchTrace,
): string[] {
  const excluded = new Set(excludedUrls.map(canonicalUrl).filter((value): value is string => Boolean(value)))
  if (excluded.size === 0) return []
  const observed = new Set<string>()
  for (const match of text.matchAll(/https?:\/\/[^\s)\]}>"']+/g)) observed.add(match[0])
  for (const citation of trace?.citations ?? []) observed.add(citation.url)
  for (const source of trace?.sources ?? []) observed.add(source.url)
  for (const call of trace?.calls ?? []) {
    if (call.action.url) observed.add(call.action.url)
    for (const source of call.action.sources) observed.add(source)
  }
  return [...observed]
    .filter((value) => {
      const normalized = canonicalUrl(value)
      return normalized != null && excluded.has(normalized)
    })
    .map((value) => clip(value, 180))
    .slice(0, MAX_AUDIT_EXCERPTS)
}

function canonicalUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : '/'
    return `${url.protocol}//${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}${pathname}`
  } catch {
    return null
  }
}

function excerptAt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 70)
  const end = Math.min(text.length, index + length + 70)
  return clip(text.slice(start, end), 180)
}

function normalizeAsOf(value: string | null | undefined): string | null {
  if (!value) return null
  const compact = value.replace(/-/g, '')
  return /^\d{8}$/.test(compact) ? compact : null
}

function formatNumber(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '未知' : Number(value.toFixed(2)).toString()
}

function formatPercent(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '未知'
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value
}

function clip(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized
}
