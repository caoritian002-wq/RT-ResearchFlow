import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import { upsertDailyClose } from '../../electron/main/database/dailyCloseCacheRepository'
import { savePremarketAIExplanation } from '../../electron/main/database/premarketAIExplanationRepository'
import { getPremarketNotificationDelivery } from '../../electron/main/database/premarketNotificationRepository'
import {
  explainCurrentPremarketScenario,
  validatePremarketAIExplanation,
} from '../../electron/main/services/premarketAIExplanationService'
import {
  deliverPremarketScenarioNotification,
  type PremarketNotificationAdapter,
} from '../../electron/main/services/premarketNotificationService'
import {
  buildPremarketCalibration,
  runPremarketOutcomeValidation,
} from '../../electron/main/services/premarketOutcomeService'
import { runPremarketScenarioStage } from '../../electron/main/services/premarketRehearsalService'
import type { AIProviderRequest, AIProviderResponse } from '../../electron/main/services/aiProvider'

const TRADE_DATE = '20260731'
const PREVIOUS_TRADE_DATE = '20260730'
const INITIAL_AT = Date.parse('2026-07-31T08:45:10+08:00')
const AUCTION_AT = Date.parse('2026-07-31T09:28:10+08:00')

function aiResponse(value: unknown): AIProviderResponse {
  return {
    text: JSON.stringify(value),
    responseId: 'premarket-response-1',
    finishReason: 'stop',
    usage: { inputTokens: 120, outputTokens: 60, totalTokens: 180 },
  }
}

describe('FR-259 phase 267 outcome, notification, and AI ledgers', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, DATABASE_MIGRATIONS)
    db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 1, ?)')
      .run(TRADE_DATE, PREVIOUS_TRADE_DATE)
  })

  afterEach(() => db?.close())

  async function createScenario(codes = ['600487.SH']) {
    const insert = db.prepare('INSERT INTO portfolio_stocks (ts_code, stock_name, added_at) VALUES (?, ?, ?)')
    codes.forEach((code, index) => insert.run(code, index === 0 ? '亨通光电' : '贵州茅台', INITIAL_AT - index - 1))
    await runPremarketScenarioStage(db, { tradeDate: TRADE_DATE, stage: 'asia_open', now: INITIAL_AT })
    return (await runPremarketScenarioStage(db, {
      tradeDate: TRADE_DATE,
      stage: 'auction_confirmed',
      now: AUCTION_AT,
    })).version
  }

  it('Migration 128 creates immutable ledgers and deduplicates explanations with a null outcome id', async () => {
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'premarket_%'
      ORDER BY name
    `).all() as Array<{ name: string }>
    expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
      'premarket_outcome_validations',
      'premarket_notification_deliveries',
      'premarket_ai_explanations',
    ]))
    const index = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_premarket_ai_explanations_identity'
    `).get() as { sql: string }
    expect(index.sql).toContain("COALESCE(outcome_validation_id, '')")

    const version = await createScenario()
    const input = {
      scenarioVersionId: version.id,
      outcomeValidationId: null,
      provider: 'chatgpt',
      model: 'gpt-test',
      modelConfigFingerprint: '1'.repeat(64),
      sourceFingerprint: '2'.repeat(64),
      promptSha256: '3'.repeat(64),
      explanation: {
        schemaVersion: 1 as const,
        summary: '只解释冻结证据。',
        observations: [{ text: '本地证据存在缺口。', referenceIds: ['PM-HOLDING-001-TREND'] }],
        uncertainties: ['盘中路径未知。'],
        watchItems: ['观察确认条件是否满足。'],
      },
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      createdAt: AUCTION_AT + 1,
    }
    const first = savePremarketAIExplanation(db, {
      ...input,
      id: '00000000-0000-4000-8000-000000000267',
    })
    const repeated = savePremarketAIExplanation(db, {
      ...input,
      id: '00000000-0000-4000-8000-000000000268',
      createdAt: AUCTION_AT + 2,
    })
    expect(first.reused).toBe(false)
    expect(repeated.reused).toBe(true)
    expect(repeated.explanation.id).toBe(first.explanation.id)
    expect(db.prepare('SELECT COUNT(*) AS count FROM premarket_ai_explanations').get()).toEqual({ count: 1 })
    expect(() => db.prepare("UPDATE premarket_ai_explanations SET model = 'changed'").run())
      .toThrow('PREMARKET_AI_EXPLANATION_IMMUTABLE')
  })

  it('keeps missing facts, appends revisions after daily data arrives, and calibrates only latest revisions', async () => {
    const version = await createScenario(['600487.SH', '600519.SH'])
    const missing = runPremarketOutcomeValidation(db, TRADE_DATE, AUCTION_AT + 10)
    const repeated = runPremarketOutcomeValidation(db, TRADE_DATE, AUCTION_AT + 11)
    expect(missing?.record.status).toBe('missing')
    expect(repeated?.reused).toBe(true)
    expect(repeated?.record.id).toBe(missing?.record.id)

    upsertDailyClose(db, [
      { tsCode: '600487.SH', tradeDate: PREVIOUS_TRADE_DATE, open: 9.8, high: 10.1, low: 9.7, close: 10, pctChg: 1, vol: 1000, turnoverRate: 1 },
      { tsCode: '600487.SH', tradeDate: TRADE_DATE, open: 10.5, high: 11, low: 9.9, close: 10.1, pctChg: 1, vol: 1200, turnoverRate: 1.2 },
    ])
    const partial = runPremarketOutcomeValidation(db, TRADE_DATE, AUCTION_AT + 20)
    expect(partial?.reused).toBe(false)
    expect(partial?.record.status).toBe('partial')
    expect(partial?.record.validation.counts).toEqual({ total: 2, matured: 1, missing: 1 })
    expect(partial?.record.validation.items[0]?.outcome.label).toBe('gap_up_fade')

    const calibration = buildPremarketCalibration(db, AUCTION_AT + 21)
    expect(calibration).toMatchObject({
      versionCount: 1,
      totalSamples: 2,
      maturedSamples: 1,
      missingSamples: 1,
      coverageRate: 0.5,
      probabilityGate: {
        enabled: false,
        reason: 'NO_PROBABILITY_MODEL',
        brierScore: null,
        reliabilityBins: [],
      },
    })
    expect(calibration.confusion).toHaveLength(1)
    expect(calibration.marketGroups).toHaveLength(1)

    upsertDailyClose(db, [
      { tsCode: '600519.SH', tradeDate: PREVIOUS_TRADE_DATE, open: 1500, high: 1510, low: 1490, close: 1500, pctChg: 0, vol: 1000, turnoverRate: 0.3 },
      { tsCode: '600519.SH', tradeDate: TRADE_DATE, open: 1490, high: 1530, low: 1480, close: 1520, pctChg: 1.33, vol: 1100, turnoverRate: 0.4 },
    ])
    const matured = runPremarketOutcomeValidation(db, TRADE_DATE, AUCTION_AT + 30)
    expect(matured?.record.status).toBe('matured')
    expect(matured?.record.validation.counts).toEqual({ total: 2, matured: 2, missing: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM premarket_outcome_validations WHERE scenario_version_id = ?')
      .get(version.id)).toEqual({ count: 3 })
    expect(() => db.prepare("UPDATE premarket_outcome_validations SET status = 'missing'").run())
      .toThrow('PREMARKET_OUTCOME_VALIDATION_IMMUTABLE')
  })

  it('respects the existing notification setting and delivers at most once per trade date', async () => {
    await createScenario()
    const adapter: PremarketNotificationAdapter = {
      isSupported: vi.fn(() => true),
      show: vi.fn(),
    }
    expect(deliverPremarketScenarioNotification(db, TRADE_DATE, undefined, AUCTION_AT + 1, adapter)).toBe('disabled')
    expect(adapter.show).not.toHaveBeenCalled()
    expect(getPremarketNotificationDelivery(db, TRADE_DATE)).toBeNull()

    db.prepare('UPDATE app_settings SET decision_notify_windows_enabled = 1 WHERE id = 1').run()
    expect(deliverPremarketScenarioNotification(db, TRADE_DATE, undefined, AUCTION_AT + 2, adapter)).toBe('shown')
    expect(deliverPremarketScenarioNotification(db, TRADE_DATE, undefined, AUCTION_AT + 3, adapter)).toBe('already_delivered')
    expect(adapter.show).toHaveBeenCalledTimes(1)
    expect(adapter.show).toHaveBeenCalledWith(expect.objectContaining({
      title: '盘前推演 · 09:28确认',
    }))
    expect(getPremarketNotificationDelivery(db, TRADE_DATE)).toMatchObject({ status: 'shown' })
  })

  it('runs AI only on explicit calls, disables native search, reuses valid output, and rejects fake references or probabilities', async () => {
    const version = await createScenario()
    const referenceId = version.scenario.holdings[0]?.referenceIds[0]
    expect(referenceId).toBeTruthy()
    const config = {
      provider: 'chatgpt' as const,
      model: 'gpt-test',
      apiKey: 'secret',
      baseUrl: null,
      maxTokens: 600,
      fingerprint: 'a'.repeat(64),
    }
    const callModel = vi.fn(async (request: AIProviderRequest) => {
      expect(request).toMatchObject({ maxTokens: 600, disableNativeSearch: true })
      return aiResponse({
        schemaVersion: 1,
        summary: '当前冻结证据只支持条件式解释。',
        observations: [{ text: '本地趋势事实已进入盘前版本。', referenceIds: [referenceId] }],
        uncertainties: ['盘中路径尚未发生。'],
        watchItems: ['观察已列明的确认与失效条件。'],
      })
    })
    const first = await explainCurrentPremarketScenario(db, {
      now: AUCTION_AT + 1,
      resolveModelConfig: () => config,
      callModel,
    })
    const repeated = await explainCurrentPremarketScenario(db, {
      now: AUCTION_AT + 2,
      resolveModelConfig: () => config,
      callModel,
    })
    expect(first.ok && first.reused).toBe(false)
    expect(repeated.ok && repeated.reused).toBe(true)
    expect(callModel).toHaveBeenCalledTimes(1)

    const invalidReference = await explainCurrentPremarketScenario(db, {
      now: AUCTION_AT + 3,
      resolveModelConfig: () => ({ ...config, fingerprint: 'b'.repeat(64) }),
      callModel: vi.fn(async () => aiResponse({
        schemaVersion: 1,
        summary: '引用不属于冻结投影。',
        observations: [{ text: '伪造引用。', referenceIds: ['PM-FAKE-001'] }],
        uncertainties: [],
        watchItems: [],
      })),
    })
    expect(invalidReference).toMatchObject({ ok: false, code: 'AI_EXPLANATION_INVALID' })

    expect(() => validatePremarketAIExplanation({
      schemaVersion: 1,
      summary: '该路径胜率为80%。',
      observations: [{ text: '仍引用冻结事实。', referenceIds: [referenceId] }],
      uncertainties: [],
      watchItems: [],
    }, [referenceId!])).toThrow('AI_EXPLANATION_POLICY_VIOLATION')
    expect(db.prepare('SELECT COUNT(*) AS count FROM premarket_ai_explanations').get()).toEqual({ count: 1 })
  })

  it('休市日AI解释绑定最近交易日的同一个冻结版本', async () => {
    const version = await createScenario()
    db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 0, ?)')
      .run('20260801', TRADE_DATE)
    const referenceId = version.scenario.holdings[0]?.referenceIds[0]
    const callModel = vi.fn(async () => aiResponse({
      schemaVersion: 1,
      summary: '解释最近交易日冻结证据。',
      observations: [{ text: '引用仍来自冻结版本。', referenceIds: [referenceId] }],
      uncertainties: [],
      watchItems: [],
    }))
    const result = await explainCurrentPremarketScenario(db, {
      now: Date.parse('2026-08-01T12:00:00+08:00'),
      resolveModelConfig: () => ({
        provider: 'chatgpt',
        model: 'gpt-test',
        apiKey: 'secret',
        baseUrl: null,
        maxTokens: 600,
        fingerprint: 'c'.repeat(64),
      }),
      callModel,
    })

    expect(result.ok && result.explanation.scenarioVersionId).toBe(version.id)
    expect(callModel).toHaveBeenCalledTimes(1)
  })
})
