import Database from 'better-sqlite3'
interface LegacySectorFlowItem {
  conceptCode: string
  conceptName: string
  totalAmount: number
  netInflow: number
  netInflowRate: number
  weightedChange: number
  memberCount: number
  upCount: number
  downCount: number
}

// ——————————————————————————————————————————————————————————————
// FR-158: sector_flow_daily 表仓库
// 存储每个交易日盘后的板块资金流向快照，用于相邻交易日对比
// ——————————————————————————————————————————————————————————————

/**
 * 批量写入板块资金流向存档（同 trade_date + source 覆盖旧记录）
 */
export function upsertSectorFlowDaily(
  db: Database.Database,
  tradeDate: string,
  source: string,
  items: LegacySectorFlowItem[]
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO sector_flow_daily
      (trade_date, source, concept_code, concept_name,
       total_amount, net_inflow, net_inflow_rate, weighted_change,
       member_count, up_count, down_count)
    VALUES
      (@trade_date, @source, @concept_code, @concept_name,
       @total_amount, @net_inflow, @net_inflow_rate, @weighted_change,
       @member_count, @up_count, @down_count)
  `)

  const upsertMany = db.transaction((rows: LegacySectorFlowItem[]) => {
    for (const item of rows) {
      stmt.run({
        trade_date: tradeDate,
        source,
        concept_code: item.conceptCode,
        concept_name: item.conceptName,
        total_amount: item.totalAmount,
        net_inflow: item.netInflow,
        net_inflow_rate: item.netInflowRate,
        weighted_change: item.weightedChange,
        member_count: item.memberCount,
        up_count: item.upCount,
        down_count: item.downCount
      })
    }
  })

  upsertMany(items)
}

/**
 * 查询指定 source 下最近两个不同的 trade_date（降序，最新在前）
 */
export function getLatestTwoDates(
  db: Database.Database,
  source: string
): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT trade_date
       FROM sector_flow_daily
       WHERE source = ?
       ORDER BY trade_date DESC
       LIMIT 2`
    )
    .all(source) as { trade_date: string }[]

  return rows.map((r) => r.trade_date)
}

/**
 * 查询指定 trade_date + source 下的 concept_code → net_inflow 映射
 */
export function getNetInflowMap(
  db: Database.Database,
  tradeDate: string,
  source: string
): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT concept_code, net_inflow
       FROM sector_flow_daily
       WHERE trade_date = ? AND source = ?`
    )
    .all(tradeDate, source) as { concept_code: string; net_inflow: number }[]

  const map = new Map<string, number>()
  for (const row of rows) {
    map.set(row.concept_code, row.net_inflow)
  }
  return map
}

/**
 * 清理超过 N 个交易日的旧存档（按 trade_date 字符串排序）
 */
export function cleanupSectorFlowDaily(
  db: Database.Database,
  keepTradeDays: number
): number {
  // 取最近 keepTradeDays 个不同日期
  const rows = db
    .prepare(
      `SELECT DISTINCT trade_date
       FROM sector_flow_daily
       ORDER BY trade_date DESC
       LIMIT ?`
    )
    .all(keepTradeDays) as { trade_date: string }[]

  if (rows.length === 0) return 0

  const cutoffDate = rows[rows.length - 1].trade_date
  const result = db
    .prepare(`DELETE FROM sector_flow_daily WHERE trade_date < ?`)
    .run(cutoffDate)

  return result.changes
}
