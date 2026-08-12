import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const providerMocks = vi.hoisted(() => ({
  fetchFlows: vi.fn(),
  fetchMembers: vi.fn(),
  emitSignals: vi.fn(),
}))

vi.mock('../../electron/main/services/eastmoneySectorFlowProvider', () => ({
  fetchEastmoneySectorFlows: providerMocks.fetchFlows,
  fetchEastmoneySectorMembers: providerMocks.fetchMembers,
}))
vi.mock('../../electron/main/services/decisionSignalService', () => ({
  emitDecisionSignals: providerMocks.emitSignals,
}))

import { runMigrations } from '../../electron/main/database/db'
import { upsertSectorFlowObservations } from '../../electron/main/database/sectorFlowObservationRepository'
import { getSectorFlowWorkbenchSnapshot } from '../../electron/main/services/sectorFlowService'
import type { SectorFlowItem, SectorFlowScope } from '../../electron/main/services/sectorFlowTypes'

function flowItem(
  scope: SectorFlowScope,
  boardCode: string,
  boardName: string,
  flow: number,
  sourceUpdatedAt: number,
): SectorFlowItem {
  return {
    boardCode,
    boardName,
    scope,
    metricMode: 'verified_flow',
    totalAmount: 10_000_000_000,
    turnoverDirectionStrength: null,
    mainNetInflow: flow,
    mainNetInflowRate: flow / 10_000_000_000 * 100,
    superLargeNetInflow: flow / 2,
    superLargeNetInflowRate: 2,
    largeNetInflow: flow / 2,
    largeNetInflowRate: 2,
    mediumNetInflow: -10,
    mediumNetInflowRate: -1,
    smallNetInflow: -20,
    smallNetInflowRate: -2,
    weightedChange: 2,
    totalMarketCap: 100_000_000_000,
    memberCount: 10,
    upCount: 8,
    downCount: 2,
    flatCount: 0,
    previousMainNetInflow: null,
    leader: {
      tsCode: '000001.SZ',
      name: '平安银行',
      change: 3,
      totalAmount: 100,
      mainNetInflow: 50,
      mainNetInflowRate: 5,
    },
    coreStocks: [],
    relatedThemes: [],
    sourceUpdatedAt,
  }
}

function seedDate(db: Database.Database, tradeDate: string, flow: number, capturedAt: number): void {
  upsertSectorFlowObservations(db, tradeDate, 'eastmoney', [
    flowItem('concept', 'BK1000', '算力', flow, capturedAt - 1_000),
    flowItem('industry', 'BK2000', '电子', flow / 2, capturedAt - 1_000),
  ], capturedAt)
}

describe('FR-265 板块资金历史本地投影', () => {
  beforeEach(() => {
    providerMocks.fetchFlows.mockReset()
    providerMocks.fetchMembers.mockReset()
    providerMocks.emitSignals.mockReset()
  })

  it('按显式交易日读取同日本地存档并返回真实存档导航', async () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      seedDate(db, '20260807', 100_000_000, 1_786_118_400_000)
      seedDate(db, '20260810', 200_000_000, 1_786_377_600_000)
      seedDate(db, '20260811', 300_000_000, 1_786_464_000_000)

      const snapshot = await getSectorFlowWorkbenchSnapshot(db, {
        tradeDate: '20260810',
        forceRefresh: true,
      })

      expect(snapshot).toMatchObject({
        tradeDate: '20260810',
        capturedAt: 1_786_377_600_000,
        dataMode: 'archive',
        metricMode: 'verified_flow',
        provider: 'eastmoney',
        navigation: {
          selectedTradeDate: '20260810',
          previousTradeDate: '20260807',
          nextTradeDate: '20260811',
          latestTradeDate: '20260811',
        },
      })
      expect(snapshot.sourceLabel).toContain('本地历史存档')
      expect(snapshot.quality.message).toContain('2026-08-10')
      expect(snapshot.items.find((item) => item.boardCode === 'BK1000')).toMatchObject({
        mainNetInflow: 200_000_000,
        previousMainNetInflow: 100_000_000,
      })
      expect(providerMocks.fetchFlows).not.toHaveBeenCalled()
      expect(providerMocks.fetchMembers).not.toHaveBeenCalled()
      expect(providerMocks.emitSignals).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('目标日期无真实存档时稳定失败且不读取当前接口', async () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      seedDate(db, '20260810', 200_000_000, 1_786_377_600_000)

      await expect(getSectorFlowWorkbenchSnapshot(db, {
        tradeDate: '20260809',
        forceRefresh: true,
      })).rejects.toThrow('SECTOR_FLOW_HISTORY_UNAVAILABLE')
      expect(providerMocks.fetchFlows).not.toHaveBeenCalled()
      expect(providerMocks.fetchMembers).not.toHaveBeenCalled()
      expect(providerMocks.emitSignals).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })
})
