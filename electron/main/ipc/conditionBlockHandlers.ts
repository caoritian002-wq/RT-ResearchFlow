import { ipcMain } from 'electron'
import { getDb } from '../database/db'
import {
  ensureDefaultConditionTemplates,
  getConditionMatch,
  getConditionTemplate,
  latestConditionRunStats,
  listConditionMatches,
  listConditionTemplates,
  saveConditionTemplate,
} from '../database/conditionBlockRepository'
import { runConditionBlockScan } from '../services/conditionBlocks/blockScanEngine'
import type { ConditionBlockScanMode, ConditionBlockScanProgress, ConditionBlockScanScopeOverride } from '../services/conditionBlocks/blockScanEngine'
import type { BlockStrategyTemplate } from '../services/conditionBlocks/types'
import { resolveMinuteUserTier } from '../services/minuteData/minuteDataProviderRegistry'
import type { MinuteUserTier } from '../services/minuteData/minuteDataTypes'

let runningScanController: AbortController | null = null

function parsePositiveInt(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(num) && num > 0 ? num : null
}

export function registerConditionBlockHandlers(): void {
  ipcMain.handle('conditionBlocks:listTemplates', () => {
    try {
      const db = getDb()
      ensureDefaultConditionTemplates(db)
      const templates = listConditionTemplates(db).map((row) => {
        const stats = latestConditionRunStats(db, row.templateKey)
        return {
          id: row.id,
          templateKey: row.templateKey,
          name: row.name,
          description: row.description,
          version: row.version,
          enabled: row.enabled === 1,
          updatedAt: row.updatedAt,
          lastRunAt: stats.lastRunAt,
          lastMatchCount: stats.lastMatchCount,
        }
      })
      return { ok: true, templates }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), code: 'QUERY_FAILED' }
    }
  })

  ipcMain.handle('conditionBlocks:getTemplate', (_event, payload: { id?: number }) => {
    try {
      const id = parsePositiveInt(payload?.id)
      if (!id) return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM' }
      const row = getConditionTemplate(getDb(), id)
      if (!row) return { ok: false, error: 'CONDITION_TEMPLATE_NOT_FOUND', code: 'NOT_FOUND' }
      return { ok: true, template: JSON.parse(row.templateJson) as BlockStrategyTemplate, row }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), code: 'QUERY_FAILED' }
    }
  })

  ipcMain.handle('conditionBlocks:saveTemplate', (_event, payload: { id?: number; template?: BlockStrategyTemplate }) => {
    try {
      if (!payload?.template?.key || !payload.template.name) return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM' }
      const saved = saveConditionTemplate(getDb(), payload.template, payload.id)
      return { ok: true, template: JSON.parse(saved.templateJson) as BlockStrategyTemplate, row: saved }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), code: 'SAVE_FAILED' }
    }
  })

  ipcMain.handle('conditionBlocks:runScan', async (event, payload: { templateId?: number; force?: boolean; scanMode?: ConditionBlockScanMode; scopeOverride?: ConditionBlockScanScopeOverride; userTier?: MinuteUserTier }) => {
    if (runningScanController) return { ok: false, error: '已有条件积木扫描正在运行', code: 'SCAN_ALREADY_RUNNING' }
    const controller = new AbortController()
    runningScanController = controller
    try {
      const templateId = parsePositiveInt(payload?.templateId)
      if (!templateId) return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM' }
      const result = await runConditionBlockScan(getDb(), templateId, payload?.force === true, (progress: ConditionBlockScanProgress) => {
        event.sender.send('conditionBlocks:progress', progress)
      }, payload?.scopeOverride, payload?.scanMode, resolveMinuteUserTier(payload?.userTier), controller.signal)
      return { ok: true, ...result }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), code: 'SCAN_FAILED' }
    } finally {
      if (runningScanController === controller) runningScanController = null
    }
  })

  ipcMain.handle('conditionBlocks:cancelScan', () => {
    if (!runningScanController) return { ok: false, error: '当前没有正在运行的条件积木扫描', code: 'NO_RUNNING_SCAN' }
    runningScanController.abort()
    return { ok: true, cancelled: true }
  })

  ipcMain.handle('conditionBlocks:listMatches', (_event, payload?: { templateKey?: string; runId?: number; limit?: number; offset?: number }) => {
    try {
      const matches = listConditionMatches(getDb(), payload ?? {})
      return { ok: true, matches }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), code: 'QUERY_FAILED' }
    }
  })

  ipcMain.handle('conditionBlocks:getMatchEvidence', (_event, payload: { id?: number }) => {
    try {
      const id = parsePositiveInt(payload?.id)
      if (!id) return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM' }
      const match = getConditionMatch(getDb(), id)
      if (!match) return { ok: false, error: 'CONDITION_MATCH_NOT_FOUND', code: 'NOT_FOUND' }
      return { ok: true, match, evidence: JSON.parse(match.evidenceJson) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), code: 'QUERY_FAILED' }
    }
  })
}
