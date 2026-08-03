import { app } from 'electron'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { getAIConfig } from '../database/aiConfigRepository'
import { discoverSkills, loadSkillContent } from './skillService'

export function buildSkillsBlock(db: Database.Database, forTrend = false): string {
  const config = getAIConfig(db)
  if (forTrend && !config.skillsForTrend) return ''

  let selected: string[]
  try { selected = JSON.parse(config.selectedSkills || '[]') as string[] } catch { selected = [] }
  if (selected.length === 0) return ''

  let customDirs: string[]
  try { customDirs = JSON.parse(config.customSkillPaths || '[]') as string[] } catch { customDirs = [] }

  const builtinDir = app.isPackaged
    ? join(process.resourcesPath, 'skills')
    : join(app.getAppPath(), 'skills')
  const allSkills = discoverSkills(builtinDir, customDirs)
  const selectedSet = new Set(selected)
  const maxChars = config.maxSkillChars ?? 30000

  const parts: string[] = []
  let totalLen = 0
  for (const skill of allSkills) {
    if (!selectedSet.has(skill.skillId)) continue
    const content = loadSkillContent(skill.dirPath)
    if (!content) continue
    const header = `\n\n===== 分析框架：${skill.name} =====\n`
    const block = header + content
    if (totalLen + block.length > maxChars) {
      parts.push(header + content.slice(0, Math.max(0, maxChars - totalLen - header.length)) + '\n[…内容已截断，超出最大字符限制]')
      break
    }
    parts.push(block)
    totalLen += block.length
  }

  if (parts.length === 0) return ''
  return '\n\n请参考以下分析框架来组织你的思路和分析角度（注意：这些框架仅供内部参考，请直接输出面向用户的中文分析文本，不要输出 JSON、工作流中间步骤、结构化模板或任何非面向用户的格式化数据）：' + parts.join('')
}
