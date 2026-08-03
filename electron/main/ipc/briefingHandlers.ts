import { ipcMain } from 'electron'
import {
  listBriefings,
  getBriefingById,
  markAsRead,
  markAllAsRead
} from '../database/briefingRepository'
import { refreshArchiveForAffectedDates, refreshDailyArchive } from '../database/archiveRepository'
import type { BriefingListOptions } from '../database/types'

export function registerBriefingHandlers(): void {
  ipcMain.handle('briefings:list', (_e, options: BriefingListOptions) => {
    return listBriefings(options)
  })

  ipcMain.handle('briefings:getById', (_e, id: number) => {
    return getBriefingById(id)
  })

  ipcMain.handle('briefings:markRead', (_e, id: number) => {
    const changed = markAsRead(id)
    if (changed) {
      // Refresh archive for the briefing's date
      const briefing = getBriefingById(id)
      if (briefing) refreshDailyArchive(briefing.publishedDateBJ)
    }
    return changed
  })

  ipcMain.handle('briefings:markAllRead', (_e, options?: BriefingListOptions) => {
    const result = markAllAsRead(options ?? {})
    refreshArchiveForAffectedDates(result.dates)
    return result.count
  })
}
