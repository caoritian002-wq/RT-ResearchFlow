import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'

// ──────────────────────────────────────────────────────────
// Skills discovery & loading service (FR-084)
// ──────────────────────────────────────────────────────────

export interface SkillMeta {
  skillId: string
  name: string
  description: string
  version: string
  source: 'builtin' | 'custom'
  dirPath: string
  contentLength: number
  contentHash: string
  ruleVersion: string
  integrity: 'complete' | 'invalid' | 'conflict'
  conflictPaths?: string[]
}

export interface VerifiedSkillBundle {
  meta: SkillMeta
  content: string
  contentHash: string
  contentBytes: number
  sourceDisplayName: string
}

/** Build a unique skill identifier */
export function buildSkillId(source: 'builtin' | 'custom', dirName: string): string {
  return `${source}:${dirName}`
}

/** Parse YAML front-matter from SKILL.md content.
 *  Supports `name`, `description`, `version` fields.
 *  Returns null values for missing fields. */
function parseFrontMatter(content: string): { name: string | null; description: string | null; version: string | null; body: string } {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fmMatch) return { name: null, description: null, version: null, body: content }

  const fmBlock = fmMatch[1]
  const body = content.slice(fmMatch[0].length).replace(/^\r?\n/, '')

  const extract = (key: string): string | null => {
    // Handle multi-line YAML values (e.g. description: |)
    const multiLineMatch = fmBlock.match(new RegExp(`^${key}:\\s*\\|\\s*\\r?\\n([\\s\\S]*?)(?=^\\w+:|$)`, 'm'))
    if (multiLineMatch) return multiLineMatch[1].trim()
    // Handle single-line values
    const singleMatch = fmBlock.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
    return singleMatch ? singleMatch[1].trim() : null
  }

  return {
    name: extract('name'),
    description: extract('description'),
    version: extract('version'),
    body
  }
}

/** Validate a path does not contain traversal sequences */
function isPathSafe(dirPath: string): boolean {
  const normalized = path.normalize(dirPath)
  // Reject paths containing .. anywhere after normalization
  return !normalized.includes('..')
}

/** Parse metadata for a single skill directory */
export function parseSkillMeta(skillDir: string, source: 'builtin' | 'custom'): SkillMeta | null {
  const skillFile = path.join(skillDir, 'SKILL.md')
  if (!fs.existsSync(skillFile)) return null

  try {
    const content = fs.readFileSync(skillFile, 'utf-8')
    const fm = parseFrontMatter(content)
    const dirName = path.basename(skillDir)
    const fullContent = loadSkillContent(skillDir)
    const contentHash = createHash('sha256').update(fullContent, 'utf8').digest('hex')

    return {
      skillId: buildSkillId(source, dirName),
      name: fm.name || dirName,
      description: fm.description || '',
      version: fm.version || '',
      source,
      dirPath: skillDir,
      contentLength: fullContent.length,
      contentHash,
      ruleVersion: fm.version || `sha256:${contentHash.slice(0, 12)}`,
      integrity: 'complete'
    }
  } catch {
    return null
  }
}

/** Load the full content of a skill: SKILL.md body + references/*.md */
export function loadSkillContent(skillDir: string): string {
  const skillFile = path.join(skillDir, 'SKILL.md')
  if (!fs.existsSync(skillFile)) return ''

  const raw = fs.readFileSync(skillFile, 'utf-8')
  const fm = parseFrontMatter(raw)
  let result = fm.body

  // Append references/*.md sorted by filename
  const refsDir = path.join(skillDir, 'references')
  if (fs.existsSync(refsDir) && fs.statSync(refsDir).isDirectory()) {
    const refFiles = fs.readdirSync(refsDir)
      .filter((f) => f.endsWith('.md'))
      .sort()

    for (const refFile of refFiles) {
      const refPath = path.join(refsDir, refFile)
      try {
        const refContent = fs.readFileSync(refPath, 'utf-8')
        result += `\n\n${refContent}`
      } catch {
        // Skip unreadable files
      }
    }
  }

  return result
}

/** Read a discovered Skill again and verify the bytes still match its metadata. */
export function loadVerifiedSkillBundle(skill: SkillMeta): VerifiedSkillBundle | null {
  if (skill.integrity !== 'complete') return null
  try {
    const content = loadSkillContent(skill.dirPath)
    if (!content) return null
    const contentHash = createHash('sha256').update(content, 'utf8').digest('hex')
    if (contentHash !== skill.contentHash) return null
    return {
      meta: skill,
      content,
      contentHash,
      contentBytes: Buffer.byteLength(content, 'utf8'),
      sourceDisplayName: path.basename(skill.dirPath),
    }
  } catch {
    return null
  }
}

/** Discover all skills in a single directory */
function discoverInDir(dir: string, source: 'builtin' | 'custom'): SkillMeta[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return []

  const results: SkillMeta[] = []
  const directMeta = parseSkillMeta(dir, source)
  if (directMeta) results.push(directMeta)

  const entries = fs.readdirSync(dir).sort((left, right) => left.localeCompare(right))

  for (const entry of entries) {
    const fullPath = path.join(dir, entry)
    try {
      if (!fs.statSync(fullPath).isDirectory()) continue
      const meta = parseSkillMeta(fullPath, source)
      if (meta) results.push(meta)
    } catch {
      // Skip inaccessible entries
    }
  }

  return results
}

/** Discover all skills across builtin and custom directories */
export function discoverSkills(builtinDir: string, customDirs: string[]): SkillMeta[] {
  const discovered: SkillMeta[] = []

  // Scan builtin directory
  discovered.push(...discoverInDir(builtinDir, 'builtin'))

  // Scan custom directories (with path safety check)
  for (const dir of customDirs) {
    if (!isPathSafe(dir)) continue
    discovered.push(...discoverInDir(dir, 'custom'))
  }

  const results: SkillMeta[] = []
  const byId = new Map<string, SkillMeta>()
  for (const skill of discovered) {
    const existing = byId.get(skill.skillId)
    if (!existing) {
      byId.set(skill.skillId, skill)
      results.push(skill)
      continue
    }

    const conflictPaths = Array.from(new Set([
      existing.dirPath,
      ...(existing.conflictPaths ?? []),
      skill.dirPath
    ]))
    existing.integrity = 'conflict'
    existing.conflictPaths = conflictPaths
  }

  return results
}

/** Validate a custom path for adding */
export function validateCustomPath(dirPath: string): { ok: true } | { ok: false; code: string; message: string } {
  if (!isPathSafe(dirPath)) {
    return { ok: false, code: 'PATH_TRAVERSAL', message: '路径包含非法字符（..），不允许路径穿越' }
  }
  if (!fs.existsSync(dirPath)) {
    return { ok: false, code: 'PATH_NOT_FOUND', message: '路径不存在' }
  }
  if (!fs.statSync(dirPath).isDirectory()) {
    return { ok: false, code: 'NOT_DIRECTORY', message: '路径不是目录' }
  }
  return { ok: true }
}
