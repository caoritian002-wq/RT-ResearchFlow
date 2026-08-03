import type Database from 'better-sqlite3'

export type PremarketNotificationDeliveryStatus = 'prepared' | 'shown' | 'unsupported' | 'failed'

export interface PremarketNotificationDelivery {
  tradeDate: string
  scenarioVersionId: string
  status: PremarketNotificationDeliveryStatus
  title: string
  body: string
  attemptedAt: number
  completedAt: number | null
  errorCode: string | null
}

interface DeliveryRow {
  trade_date: string
  scenario_version_id: string
  status: PremarketNotificationDeliveryStatus
  title: string
  body: string
  attempted_at: number
  completed_at: number | null
  error_code: string | null
}

function mapRow(row: DeliveryRow): PremarketNotificationDelivery {
  return {
    tradeDate: row.trade_date,
    scenarioVersionId: row.scenario_version_id,
    status: row.status,
    title: row.title,
    body: row.body,
    attemptedAt: row.attempted_at,
    completedAt: row.completed_at,
    errorCode: row.error_code,
  }
}

export function getPremarketNotificationDelivery(
  db: Database.Database,
  tradeDate: string,
): PremarketNotificationDelivery | null {
  const row = db.prepare('SELECT * FROM premarket_notification_deliveries WHERE trade_date = ?')
    .get(tradeDate) as DeliveryRow | undefined
  return row ? mapRow(row) : null
}

export function preparePremarketNotificationDelivery(
  db: Database.Database,
  input: {
    tradeDate: string
    scenarioVersionId: string
    title: string
    body: string
    attemptedAt: number
  },
): { delivery: PremarketNotificationDelivery; created: boolean } {
  const result = db.prepare(`
    INSERT OR IGNORE INTO premarket_notification_deliveries (
      trade_date, scenario_version_id, status, title, body, attempted_at, completed_at, error_code
    ) VALUES (?, ?, 'prepared', ?, ?, ?, NULL, NULL)
  `).run(input.tradeDate, input.scenarioVersionId, input.title, input.body, input.attemptedAt)
  const delivery = getPremarketNotificationDelivery(db, input.tradeDate)
  if (!delivery) throw new Error('PREMARKET_NOTIFICATION_NOT_PREPARED')
  return { delivery, created: result.changes === 1 }
}

export function completePremarketNotificationDelivery(
  db: Database.Database,
  tradeDate: string,
  status: Exclude<PremarketNotificationDeliveryStatus, 'prepared'>,
  errorCode: string | null,
  completedAt = Date.now(),
): PremarketNotificationDelivery {
  db.prepare(`
    UPDATE premarket_notification_deliveries
    SET status = ?, completed_at = ?, error_code = ?
    WHERE trade_date = ? AND status = 'prepared'
  `).run(status, completedAt, errorCode, tradeDate)
  const delivery = getPremarketNotificationDelivery(db, tradeDate)
  if (!delivery) throw new Error('PREMARKET_NOTIFICATION_NOT_FOUND')
  return delivery
}
