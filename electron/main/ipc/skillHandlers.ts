import { ipcMain, app } from 'electron'
import * as path from 'path'
import { getDb } from '../database/db'
import { getAIConfig, updateAIConfig } from '../database/aiConfigRepository'
import {
  discoverSkills,
  loadSkillContent,
  validateCustomPath
} from '../services/skillService'

// ──────────────────────────────────────────────────────────
// Skills IPC handlers (FR-084/085)
// ──────────────────────────────────────────────────────────

/** Resolve the builtin skills directory based on packaging status */
function getBuiltinSkillsDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'skills')
  }
  // In dev mode, skills/ is at the project root (trade-watch/skills)
  return path.join(app.getAppPath(), 'skills')
}

/** Parse a JSON array string safely, returning empty array on failure */
function safeJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function registerSkillHandlers(): void {
  const builtinDir = getBuiltinSkillsDir()

  // ── skill:list ──────────────────────────────────────────
  ipcMain.handle('skill:list', async () => {
    const db = getDb()
    const config = getAIConfig(db)
    const customDirs = safeJsonArray(config.customSkillPaths)
    return discoverSkills(builtinDir, customDirs)
  })

  // ── skill:getContent ────────────────────────────────────
  ipcMain.handle('skill:getContent', async (_e, data: { skillId: string }) => {
    const db = getDb()
    const config = getAIConfig(db)
    const customDirs = safeJsonArray(config.customSkillPaths)
    const allSkills = discoverSkills(builtinDir, customDirs)
    const skill = allSkills.find((s) => s.skillId === data.skillId)
    if (!skill) return { content: '' }
    return { content: loadSkillContent(skill.dirPath) }
  })

  // ── skill:addCustomPath ─────────────────────────────────
  ipcMain.handle('skill:addCustomPath', async (_e, data: { dirPath: string }) => {
    const validation = validateCustomPath(data.dirPath)
    if (!validation.ok) {
      return { error: { code: (validation as { code: string }).code, message: (validation as { message: string }).message } }
    }

    const db = getDb()
    const config = getAIConfig(db)
    const customDirs = safeJsonArray(config.customSkillPaths)

    // Check duplicate
    if (customDirs.includes(data.dirPath)) {
      return { error: { code: 'DUPLICATE_PATH', message: '该目录已添加' } }
    }

    const newSkills = discoverSkills('', [data.dirPath])
    if (newSkills.length === 0) {
      return { error: { code: 'NO_SKILLS_FOUND', message: '目录中未发现有效的 SKILL.md' } }
    }

    // Add and persist
    customDirs.push(data.dirPath)
    updateAIConfig(db, { customSkillPaths: JSON.stringify(customDirs) })

    return { skills: newSkills }
  })

  // ── skill:removeCustomPath ──────────────────────────────
  ipcMain.handle('skill:removeCustomPath', async (_e, data: { dirPath: string }) => {
    const db = getDb()
    const config = getAIConfig(db)
    const customDirs = safeJsonArray(config.customSkillPaths).filter((d) => d !== data.dirPath)
    updateAIConfig(db, { customSkillPaths: JSON.stringify(customDirs) })

    // Remove selected skills belonging to this directory
    const selectedSkills = safeJsonArray(config.selectedSkills)
    // Discover skills under the removed path to know which IDs to clear
    const removedSkills = discoverSkills('', [data.dirPath])
    const removedIds = new Set(removedSkills.map((s) => s.skillId))
    const remaining = selectedSkills.filter((id) => !removedIds.has(id))
    if (remaining.length !== selectedSkills.length) {
      updateAIConfig(db, { selectedSkills: JSON.stringify(remaining) })
    }

    return { ok: true }
  })

  // ── skill:reload ────────────────────────────────────────
  ipcMain.handle('skill:reload', async () => {
    const db = getDb()
    const config = getAIConfig(db)
    const customDirs = safeJsonArray(config.customSkillPaths)
    return discoverSkills(builtinDir, customDirs)
  })
}
