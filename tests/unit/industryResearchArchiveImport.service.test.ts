import { resolve } from 'path'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import { listChangeCandidates } from '../../electron/main/database/industryResearchChangeRepository'
import {
  importIndustryResearchArchive,
  SUPPORTED_RESEARCH_ARCHIVE_TYPE,
} from '../../electron/main/services/industryResearchArchiveImportService'

describe('产业研究五文件档案导入', () => {
  let db: Database.Database
  const archiveDir = resolve(__dirname, '../fixtures/industry-research-archive')
  const filePaths = ['README.md', 'conversation-digest.md', 'evidence-register.md', 'hypothesis-ledger.md', 'import-mapping.md']
    .map((name) => resolve(archiveDir, name))

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  it('校验五文件并聚合为四个语义变更包', () => {
    const result = importIndustryResearchArchive(db, {
      requestId: '00000000-0000-4000-8000-000000000020', archiveType: SUPPORTED_RESEARCH_ARCHIVE_TYPE,
      projectId: null, dryRun: false, filePaths,
    })

    expect(result.archive.files).toHaveLength(5)
    expect(result.changeSets).toHaveLength(4)
    expect(result.candidateCount).toBeGreaterThan(20)
    expect(result.changeSets.every((item) => item.candidateCount > 0)).toBe(true)
  })

  it('正确读取三级假设和最低成本反证，不回退为默认文本', () => {
    const result = importIndustryResearchArchive(db, {
      requestId: '00000000-0000-4000-8000-000000000021', archiveType: SUPPORTED_RESEARCH_ARCHIVE_TYPE,
      projectId: null, dryRun: false, filePaths,
    })
    const hypothesisSet = result.changeSets.find((item) => item.title.includes('核心假设'))!
    const candidates = listChangeCandidates(db, { changeSetId: hypothesisSet.id, kind: 'hypothesis', limit: 100 }).items
    const payloads = candidates.map((item) => JSON.parse(item.payload_json) as { statement: string; cheapestDisproof: string })

    expect(payloads).toHaveLength(4)
    expect(payloads.every((item) => item.statement && !item.statement.startsWith('|'))).toBe(true)
    expect(payloads.every((item) => item.cheapestDisproof && item.cheapestDisproof !== '寻找能够直接推翻该假设的一级来源。')).toBe(true)
  })

  it('同一档案和目标项目使用哈希幂等复用批次', () => {
    const first = importIndustryResearchArchive(db, {
      requestId: '00000000-0000-4000-8000-000000000022', archiveType: SUPPORTED_RESEARCH_ARCHIVE_TYPE, projectId: null, filePaths,
    })
    const second = importIndustryResearchArchive(db, {
      requestId: '00000000-0000-4000-8000-000000000023', archiveType: SUPPORTED_RESEARCH_ARCHIVE_TYPE, projectId: null, filePaths,
    })
    expect(second.batch?.id).toBe(first.batch?.id)
  })
})
