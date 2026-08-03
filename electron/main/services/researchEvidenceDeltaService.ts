import type Database from 'better-sqlite3'
import {
  buildContextResearchEvidenceContrast,
  buildResearchAuditTraceView,
  buildStockResearchEvidenceContrast,
  getResearchEvidenceReferenceId,
  isResearchEvidenceContrast,
  mergeResearchEvidenceContrasts,
  type ResearchAuditTraceEvidenceItem,
  type ResearchEvidenceContrast,
  type ResearchEvidenceItem,
  type ResearchEvidenceSubject,
  type ResearchEvidenceSubjectKind,
} from './researchEvidenceAuditService'
import { executeResearchFactTool, type ResearchFactToolId } from './researchFactToolRegistry'

const MAX_DELTA_SUBJECTS = 8
const MAX_DELTA_ITEMS_PER_SUBJECT = 32
const MAX_DELTA_WARNINGS = 20

export type ResearchEvidenceDeltaChange = 'changed' | 'added' | 'removed' | 'unchanged'

export interface ResearchEvidenceDeltaItem {
  referenceId: string
  change: ResearchEvidenceDeltaChange
  historical: ResearchAuditTraceEvidenceItem | null
  current: ResearchAuditTraceEvidenceItem | null
}

export interface ResearchEvidenceDeltaView {
  schemaVersion: 1
  status: 'ready' | 'partial'
  generatedAt: number
  historicalAsOf: string | null
  currentAsOf: string
  summary: {
    changed: number
    added: number
    removed: number
    unchanged: number
  }
  warnings: string[]
  subjects: Array<{
    subjectKind: ResearchEvidenceSubjectKind
    subjectId: string
    label: string
    items: ResearchEvidenceDeltaItem[]
  }>
}

export interface ResearchEvidenceComparison {
  delta: ResearchEvidenceDeltaView
  historicalEvidence: ResearchEvidenceContrast
  currentEvidence: ResearchEvidenceContrast
}

export class ResearchEvidenceDeltaError extends Error {
  constructor(
    public readonly code: 'TRACE_UNAVAILABLE' | 'TRACE_MISMATCH',
    message: string,
  ) {
    super(message)
  }
}

export function compareResearchEvidenceSnapshot(
  db: Database.Database,
  input: {
    audit: unknown
    evidenceContrast: unknown
    documentText: unknown
  },
  options: { now?: number } = {},
): ResearchEvidenceDeltaView {
  return prepareResearchEvidenceComparison(db, input, options).delta
}

export function prepareResearchEvidenceComparison(
  db: Database.Database,
  input: {
    audit: unknown
    evidenceContrast: unknown
    documentText: unknown
  },
  options: { now?: number } = {},
): ResearchEvidenceComparison {
  const historical = isResearchEvidenceContrast(input.evidenceContrast)
    ? input.evidenceContrast
    : null
  const trace = buildResearchAuditTraceView(input.audit, historical, input.documentText)
  if (!trace || !historical || historical.subjects.length === 0) {
    throw new ResearchEvidenceDeltaError('TRACE_UNAVAILABLE', '该结果没有可用于当前事实对比的历史证据快照')
  }
  if (trace.replayStatus === 'document_mismatch' || trace.replayStatus === 'snapshot_mismatch') {
    throw new ResearchEvidenceDeltaError('TRACE_MISMATCH', '历史正文或证据快照校验不匹配，已阻断当前事实对比')
  }
  if (trace.replayStatus === 'evidence_unavailable') {
    throw new ResearchEvidenceDeltaError('TRACE_UNAVAILABLE', '该结果的历史证据快照不可回放')
  }

  const now = options.now ?? Date.now()
  const currentAsOf = beijingDateKey(now)
  const current = rebuildCurrentResearchEvidence(db, historical, { now, asOf: currentAsOf })
  const referencedIds = new Set(
    trace.subjects.flatMap((subject) => subject.items)
      .filter((item) => item.referenced)
      .map((item) => item.referenceId),
  )
  return {
    delta: buildResearchEvidenceDeltaView(historical, current, {
      generatedAt: now,
      currentAsOf,
      referencedIds,
    }),
    historicalEvidence: historical,
    currentEvidence: current,
  }
}

export function rebuildCurrentResearchEvidence(
  db: Database.Database,
  historical: ResearchEvidenceContrast,
  options: { now: number; asOf: string },
): ResearchEvidenceContrast {
  const contrasts = historical.subjects.slice(0, MAX_DELTA_SUBJECTS).map((subject) => {
    if (subject.subjectKind === 'stock') {
      const includePriceHistory = allEvidenceItems(subject)
        .some((item) => item.toolId === 'stock.price_history')
      const trend = executeResearchFactTool(db, 'stock.trend_snapshot', {
        stockCode: subject.subjectId,
        asOf: options.asOf,
      }, { now: options.now })
      const fundamentals = executeResearchFactTool(db, 'stock.fundamentals', {
        stockCode: subject.subjectId,
        asOf: options.asOf,
        financialLimit: 4,
      }, { now: options.now })
      const announcements = executeResearchFactTool(db, 'stock.announcements', {
        stockCode: subject.subjectId,
        asOf: options.asOf,
        limit: 5,
      }, { now: options.now })
      const priceHistory = includePriceHistory
        ? executeResearchFactTool(db, 'stock.price_history', {
            stockCode: subject.subjectId,
            asOf: options.asOf,
            limit: 30,
            minBars: 10,
          }, { now: options.now })
        : null
      return buildStockResearchEvidenceContrast([{
        stockCode: subject.subjectId,
        trend,
        fundamentals,
        announcements,
        priceHistory,
      }], {
        generatedAt: options.now,
        asOf: options.asOf,
      })
    }
    if (subject.subjectKind === 'judgment') {
      const result = executeResearchFactTool(db, 'decision.judgment_history', {
        judgmentId: subject.subjectId,
        asOf: options.asOf,
        limit: 10,
      }, { now: options.now })
      return buildContextResearchEvidenceContrast('judgment', subject.subjectId, result, {
        generatedAt: options.now,
        asOf: options.asOf,
      })
    }
    const result = executeResearchFactTool(db, 'industry.project_snapshot', {
      projectId: subject.subjectId,
      asOf: options.asOf,
    }, { now: options.now })
    return buildContextResearchEvidenceContrast('industry_project', subject.subjectId, result, {
      generatedAt: options.now,
      asOf: options.asOf,
    })
  })
  return mergeResearchEvidenceContrasts(contrasts, {
    generatedAt: options.now,
    asOf: options.asOf,
  })
}

export function buildResearchEvidenceDeltaView(
  historical: ResearchEvidenceContrast,
  current: ResearchEvidenceContrast,
  options: {
    generatedAt: number
    currentAsOf: string
    referencedIds?: ReadonlySet<string>
  },
): ResearchEvidenceDeltaView {
  const historicalSubjects = new Map(historical.subjects.map((subject) => [subjectKey(subject), subject]))
  const currentSubjects = new Map(current.subjects.map((subject) => [subjectKey(subject), subject]))
  const keys = [...new Set([...historicalSubjects.keys(), ...currentSubjects.keys()])].slice(0, MAX_DELTA_SUBJECTS)
  const summary = { changed: 0, added: 0, removed: 0, unchanged: 0 }
  const warnings = [...current.warnings]
  const subjects = keys.map((key) => {
    const historicalSubject = historicalSubjects.get(key)
    const currentSubject = currentSubjects.get(key)
    const historicalItems = evidenceItemMap(historicalSubject, options.referencedIds)
    const currentItems = evidenceItemMap(currentSubject)
    const references = [...new Set([...historicalItems.keys(), ...currentItems.keys()])]
    const items = references.map((referenceId): ResearchEvidenceDeltaItem => {
      const historicalItem = historicalItems.get(referenceId) ?? null
      const currentItem = currentItems.get(referenceId) ?? null
      const change = !historicalItem
        ? 'added'
        : !currentItem
          ? 'removed'
          : evidenceItemsEqual(historicalItem, currentItem)
            ? 'unchanged'
            : 'changed'
      summary[change] += 1
      return { referenceId, change, historical: historicalItem, current: currentItem }
    }).sort(compareDeltaItems)
    if (items.length > MAX_DELTA_ITEMS_PER_SUBJECT) {
      warnings.push(`${historicalSubject?.label ?? currentSubject?.label ?? key}的差异项超过${MAX_DELTA_ITEMS_PER_SUBJECT}条，当前投影已截断`)
    }
    const identity = historicalSubject ?? currentSubject!
    return {
      subjectKind: identity.subjectKind,
      subjectId: identity.subjectId,
      label: historicalSubject?.label ?? currentSubject?.label ?? identity.subjectId,
      items: items.slice(0, MAX_DELTA_ITEMS_PER_SUBJECT),
    }
  })
  if (historical.subjects.length > MAX_DELTA_SUBJECTS || current.subjects.length > MAX_DELTA_SUBJECTS) {
    warnings.push(`证据主体超过${MAX_DELTA_SUBJECTS}个，当前投影已截断`)
  }
  const boundedWarnings = [...new Set(warnings.filter(Boolean))].slice(0, MAX_DELTA_WARNINGS)
  return {
    schemaVersion: 1,
    status: boundedWarnings.length > 0 ? 'partial' : 'ready',
    generatedAt: options.generatedAt,
    historicalAsOf: historical.asOf,
    currentAsOf: options.currentAsOf,
    summary,
    warnings: boundedWarnings,
    subjects,
  }
}

export function beijingDateKey(now: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now))
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}${values.month}${values.day}`
}

function evidenceItemMap(
  subject: ResearchEvidenceSubject | undefined,
  referencedIds: ReadonlySet<string> = new Set(),
): Map<string, ResearchAuditTraceEvidenceItem> {
  if (!subject) return new Map()
  const entries = ([
    ...subject.supporting.map((item) => deltaEvidenceItem(subject, item, 'supporting', referencedIds)),
    ...subject.challenging.map((item) => deltaEvidenceItem(subject, item, 'challenging', referencedIds)),
    ...subject.unknowns.map((item) => deltaEvidenceItem(subject, item, 'unknowns', referencedIds)),
  ]).map((item) => [item.referenceId, item] as const)
  return new Map(entries)
}

function deltaEvidenceItem(
  subject: ResearchEvidenceSubject,
  item: ResearchEvidenceItem,
  category: ResearchAuditTraceEvidenceItem['category'],
  referencedIds: ReadonlySet<string>,
): ResearchAuditTraceEvidenceItem {
  const referenceId = item.referenceId ?? getResearchEvidenceReferenceId(subject, item)
  return {
    referenceId,
    category,
    toolId: item.toolId as ResearchFactToolId,
    label: item.label,
    detail: item.detail,
    factDate: item.factDate,
    sourceIds: [...item.sourceIds],
    referenced: referencedIds.has(referenceId),
  }
}

function evidenceItemsEqual(
  historical: ResearchAuditTraceEvidenceItem,
  current: ResearchAuditTraceEvidenceItem,
): boolean {
  return historical.category === current.category
    && historical.toolId === current.toolId
    && historical.label === current.label
    && historical.detail === current.detail
    && historical.factDate === current.factDate
    && JSON.stringify([...historical.sourceIds].sort()) === JSON.stringify([...current.sourceIds].sort())
}

function compareDeltaItems(left: ResearchEvidenceDeltaItem, right: ResearchEvidenceDeltaItem): number {
  const rank: Record<ResearchEvidenceDeltaChange, number> = {
    changed: 0,
    added: 1,
    removed: 2,
    unchanged: 3,
  }
  return rank[left.change] - rank[right.change] || left.referenceId.localeCompare(right.referenceId)
}

function subjectKey(subject: Pick<ResearchEvidenceSubject, 'subjectKind' | 'subjectId'>): string {
  return `${subject.subjectKind}\u0000${subject.subjectId}`
}

function allEvidenceItems(subject: ResearchEvidenceSubject): ResearchEvidenceItem[] {
  return [...subject.supporting, ...subject.challenging, ...subject.unknowns]
}
