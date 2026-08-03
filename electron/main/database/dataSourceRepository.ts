import type Database from 'better-sqlite3'
import type { DataSourceConfigRow } from './types'

export function getDataSourceConfig(db: Database.Database): DataSourceConfigRow {
  const row = db.prepare('SELECT * FROM data_source_config WHERE id = 1').get() as DataSourceConfigRow | undefined
  if (!row) {
    db.prepare('INSERT OR IGNORE INTO data_source_config (id) VALUES (1)').run()
    return { id: 1, tushareTokenEncrypted: null, tushareEnabled: 0 }
  }
  return row
}

export function updateDataSourceConfig(
  db: Database.Database,
  update: Partial<Pick<DataSourceConfigRow, 'tushareTokenEncrypted' | 'tushareEnabled'>>
): void {
  const fields: string[] = []
  const values: unknown[] = []

  if (update.tushareTokenEncrypted !== undefined) {
    fields.push('tushareTokenEncrypted = ?')
    values.push(update.tushareTokenEncrypted)
  }
  if (update.tushareEnabled !== undefined) {
    fields.push('tushareEnabled = ?')
    values.push(update.tushareEnabled)
  }

  if (fields.length === 0) return
  values.push(1)
  db.prepare(`UPDATE data_source_config SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}
