import { ipcMain } from 'electron'
import { listArchiveDates, getArchiveForDate } from '../database/archiveRepository'

export function registerArchiveHandlers(): void {
  ipcMain.handle('archive:listDates', (_e, limit?: number) => {
    return listArchiveDates(limit)
  })

  ipcMain.handle('archive:getDate', (_e, date: string) => {
    return getArchiveForDate(date)
  })
}
