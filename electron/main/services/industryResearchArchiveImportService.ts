import { createHash, randomUUID } from 'crypto'
import { basename } from 'path'
import { readFileSync } from 'fs'
import type Database from 'better-sqlite3'
import {
  getCandidateBatchByIdempotencyKey,
  listChangeSets,
  savePreparedCandidateBatch,
  type PreparedChangeCandidateInput,
  type PreparedChangeSetInput,
} from '../database/industryResearchChangeRepository'
import { getResearchProject } from '../database/industryResearchRepository'
import { candidateBatchSummary, changeSetSummary } from './industryResearchChangeGenerationService'
import { ResearchDiscussionError } from './researchDiscussionContextService'

const ARCHIVE_TYPE = 'optical-fiber-research-v1'
const REQUIRED_FILES = [
  'README.md',
  'conversation-digest.md',
  'evidence-register.md',
  'hypothesis-ledger.md',
  'import-mapping.md',
] as const
const MAX_FILE_BYTES = 512 * 1024
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024

interface ArchiveFile {
  logicalName: string
  sha256: string
  size: number
  content: string
}

function cleanCell(value: string): string {
  return value.trim().replace(/^`|`$/g, '').replace(/^<|>$/g, '')
}

function section(markdown: string, headingFragment: string): string {
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex((line) => /^#{2,6}\s+/.test(line) && line.includes(headingFragment))
  if (start < 0) return ''
  const level = lines[start].match(/^(#{2,6})\s+/)?.[1].length ?? 2
  const end = lines.findIndex((line, index) => {
    if (index <= start) return false
    const match = line.match(/^(#{2,6})\s+/)
    return Boolean(match && match[1].length <= level)
  })
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n')
}

function tableRows(markdown: string): Record<string, string>[] {
  const lines = markdown.split(/\r?\n/).filter((line) => line.trim().startsWith('|'))
  if (lines.length < 2) return []
  const split = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(cleanCell)
  const headers = split(lines[0])
  return lines.slice(2).map(split).filter((cells) => cells.length >= headers.length).map((cells) =>
    Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])),
  )
}

function readArchiveFiles(paths: string[]): ArchiveFile[] {
  if (paths.length !== REQUIRED_FILES.length) throw new ResearchDiscussionError('ARCHIVE_FILE_MISSING', '请选择完整的五文件研究档案')
  const byName = new Map(paths.map((path) => [basename(path), path]))
  const missing = REQUIRED_FILES.filter((name) => !byName.has(name))
  if (missing.length) throw new ResearchDiscussionError('ARCHIVE_FILE_MISSING', `档案缺少文件：${missing.join('、')}`)
  let total = 0
  return REQUIRED_FILES.map((logicalName) => {
    const buffer = readFileSync(byName.get(logicalName)!)
    total += buffer.byteLength
    if (buffer.byteLength > MAX_FILE_BYTES || total > MAX_ARCHIVE_BYTES) {
      throw new ResearchDiscussionError('ARCHIVE_TOO_LARGE', '研究档案超过大小限制')
    }
    let content: string
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
    catch { throw new ResearchDiscussionError('UNSUPPORTED_ARCHIVE', `${logicalName} 不是有效 UTF-8 文件`) }
    return {
      logicalName,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      size: buffer.byteLength,
      content,
    }
  })
}

function nodeType(label: string): 'material' | 'product' | 'technology' | 'demand' {
  if (label.includes('原材料') || label.includes('中间品')) return 'material'
  if (label.includes('前沿')) return 'technology'
  if (label.includes('终端')) return 'demand'
  return 'product'
}

function structureChangeSet(mapping: string): PreparedChangeSetInput {
  const nodeRows = tableRows(section(mapping, '节点候选'))
  const relationRows = tableRows(section(mapping, '关系候选'))
  const candidates: PreparedChangeCandidateInput[] = nodeRows.map((row) => ({
    id: randomUUID(), kind: 'node', action: 'add', externalRef: row['候选 ID'],
    sourceLocator: 'import-mapping.md#节点候选', statementType: 'estimate',
    payload: { name: row['名称'], type: nodeType(row['类型']), stage: row['类型'], status: 'archive_candidate', evidenceRefs: row['初始证据'] },
    warnings: row['初始证据']?.includes('待补') ? ['缺少可确认的原始来源'] : [],
  }))
  if (!candidates.some((item) => item.externalRef === 'N-COMM-FIBER')) {
    candidates.push({
      id: randomUUID(), kind: 'node', action: 'add', externalRef: 'N-COMM-FIBER',
      sourceLocator: 'import-mapping.md#关系候选', statementType: 'estimate',
      payload: { name: '通信光纤节点组', type: 'product', status: 'archive_group' },
      warnings: ['由档案关系中的组合引用补建，待用户确认边界'],
    })
  }
  const normalizeRef = (value: string) => value.includes('通信光纤节点组') ? 'N-COMM-FIBER' : cleanCell(value)
  candidates.push(...relationRows.map((row) => ({
    id: randomUUID(), kind: 'edge' as const, action: 'add', externalRef: row['候选 ID'],
    sourceLocator: 'import-mapping.md#关系候选', statementType: 'estimate' as const,
    payload: {
      sourceRef: normalizeRef(row['上游节点']), targetRef: normalizeRef(row['下游节点']),
      relation: row['关系'], status: row['证据/状态'],
    },
    warnings: row['证据/状态']?.includes('待补') ? ['关系证据仍待补充'] : [],
  })))
  return {
    id: randomUUID(), title: '建立光纤产业结构基线',
    summary: `新增 ${nodeRows.length + 1} 个产业节点和 ${relationRows.length} 条关系候选。`,
    impact: '形成预制棒、通信光纤、光缆与终端需求的基础图谱；不把规划产能视为有效供给。',
    action: 'add', risk: 'medium',
    affectedObjects: [{ type: 'graph', id: null, label: '光纤产业链图谱' }],
    evidenceSummary: ['研究者建模与档案引用并存，全部先按估算写入。'],
    confidenceBoundary: '图谱来自人工迁移档案，未确认来源的节点和关系保持 estimate。',
    requiresExpandedReview: false, candidates,
  }
}

function companyChangeSet(mapping: string): PreparedChangeSetInput {
  const rows = tableRows(section(mapping, '公司候选'))
  const candidates = rows.map((row): PreparedChangeCandidateInput => ({
    id: randomUUID(), kind: 'company', action: 'add', externalRef: row['候选 ID'],
    sourceLocator: 'import-mapping.md#公司候选', statementType: 'candidate',
    payload: { legalName: row['公司'], shortName: row['公司'], securityCodes: row['证券代码'], role: row['当前角色'], status: 'candidate' },
    warnings: row['证据']?.includes('待补') ? ['公司角色仍待一级来源验证'] : [],
  }))
  return {
    id: randomUUID(), title: '补充公司与项目事件候选',
    summary: `整理 ${rows.length} 家产业公司，不自动确认业务暴露。`,
    impact: '建立后续财报验证和产能时钟的公司范围。', action: 'add', risk: 'medium',
    affectedObjects: [{ type: 'company', id: null, label: '光纤产业公司范围' }],
    evidenceSummary: ['重整意向、募投规划、股权收购与稳定达产保持不同状态。'],
    confidenceBoundary: '公司纳入仅代表研究候选，不代表证券推荐或业务暴露已确认。',
    requiresExpandedReview: false, candidates,
  }
}

function evidenceBlocks(markdown: string): PreparedChangeCandidateInput[] {
  const headings = [...markdown.matchAll(/^###\s+(E-[A-Z0-9-]+)\s*$/gm)]
  return headings.map((match, index) => {
    const start = match.index! + match[0].length
    const end = headings[index + 1]?.index ?? markdown.length
    const fields = tableRows(markdown.slice(start, end))
      .reduce<Record<string, string>>((result, row) => {
        if (row['字段']) result[row['字段']] = row['内容']
        return result
      }, {})
    const type = fields['类型/等级'] ?? ''
    return {
      id: randomUUID(), kind: 'evidence', action: 'add', externalRef: match[1],
      sourceLocator: `evidence-register.md#${match[1]}`, statementType: 'estimate', primarySource: false,
      payload: {
        title: fields['标题'] ?? match[1], sourceType: 'archive', sourceName: fields['发布主体'] ?? type,
        sourceUrl: fields['URL'] ?? null, publishedDate: fields['日期'] ?? null,
        excerpt: fields['关键摘录'] ?? null, methodology: fields['适用边界'] ?? null,
        conflictNote: fields['导入建议'] ?? null, reliability: type.includes('F-copy') ? 'secondary' : 'unknown',
      },
      warnings: type.includes('F-copy') ? ['公告副本不是已确认官方原文，不能直接升级为 fact'] : [],
    }
  })
}

function evidenceAndFollowUpChangeSet(mapping: string, evidence: string): PreparedChangeSetInput {
  const followRows = tableRows(section(mapping, '回访任务候选'))
  const evidenceCandidates = evidenceBlocks(evidence)
  const followCandidates = followRows.map((row): PreparedChangeCandidateInput => ({
    id: randomUUID(), kind: 'follow_up', action: 'add', externalRef: row['任务 ID'],
    sourceLocator: 'import-mapping.md#回访任务候选', statementType: 'hypothesis',
    payload: { label: row['跟踪对象'], trigger: row['触发条件'], frequency: row['建议频率'], dueAt: null },
  }))
  return {
    id: randomUUID(), title: '登记证据缺口与回访点',
    summary: `整理 ${evidenceCandidates.length} 条来源和 ${followCandidates.length} 个回访候选。`,
    impact: '保留价格口径、项目进度、财报和一致预期的后续验证路径。', action: 'follow_up', risk: 'medium',
    affectedObjects: [{ type: 'evidence', id: null, label: '证据与回访' }],
    evidenceSummary: ['东方财富公告页统一保留为 F-copy，不冒充官方原文。'],
    confidenceBoundary: '接受后证据默认仍为 estimate，回访项不形成全局强制待办。',
    requiresExpandedReview: false, candidates: [...evidenceCandidates, ...followCandidates],
  }
}

function hypothesisChangeSet(ledger: string): PreparedChangeSetInput {
  const rows = tableRows(section(ledger, '假设总览'))
  const candidates = rows.map((row): PreparedChangeCandidateInput => {
    const id = row['假设 ID']
    const detail = section(ledger, id)
    const hypothesisText = section(detail, '假设').split(/\r?\n/).find((line) => line.trim())?.trim() ?? row['假设']
    const disproofs = section(detail, '最低成本反证').split(/\r?\n/).filter((line) => /^-\s+/.test(line)).map((line) => line.replace(/^-\s+/, ''))
    return {
      id: randomUUID(), kind: 'hypothesis', action: 'add', externalRef: id,
      sourceLocator: `hypothesis-ledger.md#${id}`, statementType: 'hypothesis',
      payload: {
        statement: hypothesisText, status: 'open', importance: 4,
        cheapestDisproof: disproofs.join('；') || '寻找能够直接推翻该假设的一级来源。',
        verificationMetric: row['下一回访'], dueAt: null,
      },
    }
  })
  return {
    id: randomUUID(), title: '建立核心假设与反证路径',
    summary: `整理 ${rows.length} 条核心假设及最低成本反证。`,
    impact: '把观点演变转为可验证、可弱化和可证伪的研究对象。', action: 'add', risk: 'low',
    affectedObjects: [{ type: 'hypothesis', id: null, label: '光纤研究假设' }],
    evidenceSummary: ['假设状态统一从 open 开始，不继承为已验证事实。'],
    confidenceBoundary: '所有假设都需要后续价格、交期、项目和财报数据验证。',
    requiresExpandedReview: false, candidates,
  }
}

function previewChangeSet(item: PreparedChangeSetInput) {
  return {
    id: item.id, batchId: 'dry-run', title: item.title, summary: item.summary, impact: item.impact,
    action: item.action, status: 'pending', risk: item.risk, affectedObjects: item.affectedObjects,
    evidenceSummary: item.evidenceSummary, confidenceBoundary: item.confidenceBoundary,
    requiresExpandedReview: item.requiresExpandedReview, candidateCount: item.candidates.length,
    sourceSessionId: null, messageStartIndex: null, messageEndIndex: null,
  }
}

export function importIndustryResearchArchive(
  db: Database.Database,
  input: { requestId: string; archiveType: string; projectId?: string | null; dryRun?: boolean; filePaths: string[] },
) {
  if (input.archiveType !== ARCHIVE_TYPE) throw new ResearchDiscussionError('UNSUPPORTED_ARCHIVE', '暂不支持该研究档案类型')
  if (input.projectId && !getResearchProject(db, input.projectId)) throw new ResearchDiscussionError('NOT_FOUND', '目标研究项目不存在')
  const files = readArchiveFiles(input.filePaths)
  const byName = new Map(files.map((file) => [file.logicalName, file.content]))
  const changeSets = [
    structureChangeSet(byName.get('import-mapping.md')!),
    companyChangeSet(byName.get('import-mapping.md')!),
    hypothesisChangeSet(byName.get('hypothesis-ledger.md')!),
    evidenceAndFollowUpChangeSet(byName.get('import-mapping.md')!, byName.get('evidence-register.md')!),
  ]
  const archiveHash = createHash('sha256').update(files.map((file) => `${file.logicalName}:${file.sha256}`).join('|')).digest('hex')
  const warnings = changeSets.flatMap((item) => item.candidates.flatMap((candidate) => candidate.warnings ?? []))
  const unresolvedRefs: Array<{ sourceLocator: string; ref: string; reason: string }> = []
  const archive = {
    archiveType: ARCHIVE_TYPE,
    schemaVersion: 1,
    archiveVersion: archiveHash.slice(0, 12),
    files: files.map(({ logicalName, sha256, size }) => ({ logicalName, sha256, size })),
  }
  if (input.dryRun) {
    return {
      archive, batch: null, changeSets: changeSets.map(previewChangeSet),
      candidateCount: changeSets.reduce((sum, item) => sum + item.candidates.length, 0),
      warnings: [...new Set(warnings)], unresolvedRefs,
    }
  }
  const existing = getCandidateBatchByIdempotencyKey(db, `archive:${archiveHash}:${input.projectId ?? 'unassigned'}`)
  const batch = existing ?? savePreparedCandidateBatch(db, {
    id: randomUUID(), requestId: input.requestId,
    idempotencyKey: `archive:${archiveHash}:${input.projectId ?? 'unassigned'}`,
    sourceType: 'archive', sourceSessionId: null, projectId: input.projectId ?? null,
    baseSnapshotId: null, messageStartIndex: null, messageEndIndex: null,
    contextHash: archiveHash, provider: null, model: null, ruleVersion: 'fr239-archive-v1',
    archiveMeta: archive, changeSets,
  })
  const savedSets = listChangeSets(db, { batchId: batch.id, limit: 100 }).items
  return {
    archive, batch: candidateBatchSummary(batch), changeSets: savedSets.map(changeSetSummary),
    candidateCount: batch.candidate_count, warnings: [...new Set(warnings)], unresolvedRefs,
  }
}

export const SUPPORTED_RESEARCH_ARCHIVE_TYPE = ARCHIVE_TYPE
