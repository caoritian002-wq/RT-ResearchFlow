import type Database from 'better-sqlite3'
import type {
  SectorFlowItem,
  SectorFlowMetricMode,
  SectorFlowProvider,
  SectorFlowScope,
  SectorFlowStock,
} from '../services/sectorFlowTypes'

interface ObservationRow {
  trade_date: string
  provider: SectorFlowProvider
  scope: SectorFlowScope
  board_code: string
  board_name: string
  metric_kind: SectorFlowMetricMode
  total_amount: number
  turnover_direction_strength: number | null
  main_net_inflow: number | null
  main_net_inflow_rate: number | null
  super_large_net_inflow: number | null
  super_large_net_inflow_rate: number | null
  large_net_inflow: number | null
  large_net_inflow_rate: number | null
  medium_net_inflow: number | null
  medium_net_inflow_rate: number | null
  small_net_inflow: number | null
  small_net_inflow_rate: number | null
  weighted_change: number
  total_market_cap: number | null
  member_count: number
  up_count: number
  down_count: number
  flat_count: number
  leader_json: string | null
  core_stocks_json: string
  related_themes_json: string
  source_updated_at: number | null
  captured_at: number
}

export function upsertSectorFlowObservations(
  db: Database.Database,
  tradeDate: string,
  provider: SectorFlowProvider,
  items: SectorFlowItem[],
  capturedAt: number,
): void {
  const statement = db.prepare(`
    INSERT INTO sector_flow_observations (
      trade_date, provider, scope, board_code, board_name, metric_kind,
      total_amount, main_net_inflow, main_net_inflow_rate,
      turnover_direction_strength,
      super_large_net_inflow, super_large_net_inflow_rate,
      large_net_inflow, large_net_inflow_rate,
      medium_net_inflow, medium_net_inflow_rate,
      small_net_inflow, small_net_inflow_rate,
      weighted_change, total_market_cap, member_count, up_count, down_count, flat_count,
      leader_json, core_stocks_json, related_themes_json,
      source_updated_at, captured_at, quality_json
    ) VALUES (
      @trade_date, @provider, @scope, @board_code, @board_name, @metric_kind,
      @total_amount, @main_net_inflow, @main_net_inflow_rate,
      @turnover_direction_strength,
      @super_large_net_inflow, @super_large_net_inflow_rate,
      @large_net_inflow, @large_net_inflow_rate,
      @medium_net_inflow, @medium_net_inflow_rate,
      @small_net_inflow, @small_net_inflow_rate,
      @weighted_change, @total_market_cap, @member_count, @up_count, @down_count, @flat_count,
      @leader_json, @core_stocks_json, @related_themes_json,
      @source_updated_at, @captured_at, @quality_json
    )
    ON CONFLICT(trade_date, provider, scope, board_code, metric_kind) DO UPDATE SET
      board_name = excluded.board_name,
      total_amount = excluded.total_amount,
      turnover_direction_strength = excluded.turnover_direction_strength,
      main_net_inflow = excluded.main_net_inflow,
      main_net_inflow_rate = excluded.main_net_inflow_rate,
      super_large_net_inflow = excluded.super_large_net_inflow,
      super_large_net_inflow_rate = excluded.super_large_net_inflow_rate,
      large_net_inflow = excluded.large_net_inflow,
      large_net_inflow_rate = excluded.large_net_inflow_rate,
      medium_net_inflow = excluded.medium_net_inflow,
      medium_net_inflow_rate = excluded.medium_net_inflow_rate,
      small_net_inflow = excluded.small_net_inflow,
      small_net_inflow_rate = excluded.small_net_inflow_rate,
      weighted_change = excluded.weighted_change,
      total_market_cap = excluded.total_market_cap,
      member_count = excluded.member_count,
      up_count = excluded.up_count,
      down_count = excluded.down_count,
      flat_count = excluded.flat_count,
      leader_json = excluded.leader_json,
      core_stocks_json = excluded.core_stocks_json,
      related_themes_json = excluded.related_themes_json,
      source_updated_at = excluded.source_updated_at,
      captured_at = excluded.captured_at,
      quality_json = excluded.quality_json
  `)

  db.transaction(() => {
    for (const item of items) {
      statement.run({
        trade_date: tradeDate,
        provider,
        scope: item.scope,
        board_code: item.boardCode,
        board_name: item.boardName,
        metric_kind: item.metricMode,
        total_amount: item.totalAmount,
        turnover_direction_strength: item.turnoverDirectionStrength,
        main_net_inflow: item.mainNetInflow,
        main_net_inflow_rate: item.mainNetInflowRate,
        super_large_net_inflow: item.superLargeNetInflow,
        super_large_net_inflow_rate: item.superLargeNetInflowRate,
        large_net_inflow: item.largeNetInflow,
        large_net_inflow_rate: item.largeNetInflowRate,
        medium_net_inflow: item.mediumNetInflow,
        medium_net_inflow_rate: item.mediumNetInflowRate,
        small_net_inflow: item.smallNetInflow,
        small_net_inflow_rate: item.smallNetInflowRate,
        weighted_change: item.weightedChange,
        total_market_cap: item.totalMarketCap,
        member_count: item.memberCount,
        up_count: item.upCount,
        down_count: item.downCount,
        flat_count: item.flatCount,
        leader_json: item.leader ? JSON.stringify(item.leader) : null,
        core_stocks_json: JSON.stringify(item.coreStocks),
        related_themes_json: JSON.stringify(item.relatedThemes),
        source_updated_at: item.sourceUpdatedAt,
        captured_at: capturedAt,
        quality_json: JSON.stringify({ verified: item.metricMode === 'verified_flow' }),
      })
    }
  })()
}

export function getPreviousVerifiedFlowMap(
  db: Database.Database,
  beforeTradeDate: string,
): Map<string, number> {
  const previousDate = db.prepare(`
    SELECT MAX(trade_date) AS trade_date
    FROM sector_flow_observations
    WHERE provider = 'eastmoney'
      AND metric_kind = 'verified_flow'
      AND trade_date < ?
  `).get(beforeTradeDate) as { trade_date: string | null } | undefined
  if (!previousDate?.trade_date) return new Map()

  const rows = db.prepare(`
    SELECT scope, board_code, main_net_inflow
    FROM sector_flow_observations
    WHERE provider = 'eastmoney'
      AND metric_kind = 'verified_flow'
      AND trade_date = ?
      AND main_net_inflow IS NOT NULL
  `).all(previousDate.trade_date) as Array<{
    scope: SectorFlowScope
    board_code: string
    main_net_inflow: number
  }>
  return new Map(rows.map((row) => [`${row.scope}:${row.board_code}`, row.main_net_inflow]))
}

export function getLatestVerifiedObservationDate(db: Database.Database): string | null {
  const row = db.prepare(`
    SELECT MAX(trade_date) AS trade_date
    FROM sector_flow_observations
    WHERE provider = 'eastmoney' AND metric_kind = 'verified_flow'
  `).get() as { trade_date: string | null } | undefined
  return row?.trade_date ?? null
}

export function getLatestVerifiedObservationDateBefore(
  db: Database.Database,
  beforeTradeDate: string,
): string | null {
  const row = db.prepare(`
    SELECT MAX(trade_date) AS trade_date
    FROM sector_flow_observations
    WHERE provider = 'eastmoney'
      AND metric_kind = 'verified_flow'
      AND trade_date < ?
  `).get(beforeTradeDate) as { trade_date: string | null } | undefined
  return row?.trade_date ?? null
}

export function listSectorFlowObservations(
  db: Database.Database,
  tradeDate: string,
  provider: SectorFlowProvider = 'eastmoney',
): SectorFlowItem[] {
  const rows = db.prepare(`
    SELECT * FROM sector_flow_observations
    WHERE trade_date = ? AND provider = ?
    ORDER BY main_net_inflow DESC, total_amount DESC
  `).all(tradeDate, provider) as ObservationRow[]
  return rows.map(mapObservationRow)
}

export function getVerifiedFlowsByBoardNames(
  db: Database.Database,
  boardNames: string[],
): Array<{ boardName: string; mainNetInflow: number; mainNetInflowRate: number | null; tradeDate: string }> {
  if (boardNames.length === 0) return []
  const latestDate = getLatestVerifiedObservationDate(db)
  if (!latestDate) return []
  const wanted = new Set(boardNames)
  const rows = db.prepare(`
    SELECT board_name, main_net_inflow, main_net_inflow_rate, trade_date
    FROM sector_flow_observations
    WHERE trade_date = ? AND provider = 'eastmoney' AND metric_kind = 'verified_flow'
      AND main_net_inflow IS NOT NULL
    ORDER BY ABS(main_net_inflow) DESC
  `).all(latestDate) as Array<{
    board_name: string
    main_net_inflow: number
    main_net_inflow_rate: number | null
    trade_date: string
  }>
  return rows
    .filter((row) => wanted.has(row.board_name))
    .map((row) => ({
      boardName: row.board_name,
      mainNetInflow: row.main_net_inflow,
      mainNetInflowRate: row.main_net_inflow_rate,
      tradeDate: row.trade_date,
    }))
}

function mapObservationRow(row: ObservationRow): SectorFlowItem {
  return {
    boardCode: row.board_code,
    boardName: row.board_name,
    scope: row.scope,
    metricMode: row.metric_kind,
    totalAmount: row.total_amount,
    turnoverDirectionStrength: row.turnover_direction_strength,
    mainNetInflow: row.main_net_inflow,
    mainNetInflowRate: row.main_net_inflow_rate,
    superLargeNetInflow: row.super_large_net_inflow,
    superLargeNetInflowRate: row.super_large_net_inflow_rate,
    largeNetInflow: row.large_net_inflow,
    largeNetInflowRate: row.large_net_inflow_rate,
    mediumNetInflow: row.medium_net_inflow,
    mediumNetInflowRate: row.medium_net_inflow_rate,
    smallNetInflow: row.small_net_inflow,
    smallNetInflowRate: row.small_net_inflow_rate,
    weightedChange: row.weighted_change,
    totalMarketCap: row.total_market_cap,
    memberCount: row.member_count,
    upCount: row.up_count,
    downCount: row.down_count,
    flatCount: row.flat_count,
    previousMainNetInflow: null,
    leader: parseJson<SectorFlowStock | null>(row.leader_json, null),
    coreStocks: parseJson<SectorFlowStock[]>(row.core_stocks_json, []),
    relatedThemes: parseJson<Array<{ boardCode: string; boardName: string }>>(row.related_themes_json, []),
    sourceUpdatedAt: row.source_updated_at,
  }
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
