import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  return electron.launch({
    args: [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })
}

function bjYmd(date = new Date()): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '')
}

function previousDay(ymd: string): string {
  const date = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))))
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10).replace(/-/g, '')
}

function nextWeekday(ymd: string): string {
  const date = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))))
  do date.setUTCDate(date.getUTCDate() + 1)
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6)
  return date.toISOString().slice(0, 10).replace(/-/g, '')
}

function seedScenarioFixture(
  dbPath: string,
  requestedDate: string,
  tradeDate: string,
  previousTradeDate: string,
  nextTradeDate: string,
): void {
  const electronExecutable = require('electron') as string
  const script = String.raw`
    const Database = require('better-sqlite3')
    const { createHash } = require('crypto')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    const requestedDate = process.env.TRADE_WATCH_REQUESTED_DATE
    const tradeDate = process.env.TRADE_WATCH_TRADE_DATE
    const previousTradeDate = process.env.TRADE_WATCH_PREVIOUS_TRADE_DATE
    const nextTradeDate = process.env.TRADE_WATCH_NEXT_TRADE_DATE
    const dashed = tradeDate.slice(0, 4) + '-' + tradeDate.slice(4, 6) + '-' + tradeDate.slice(6, 8)
    const legacyCutoffAt = Date.parse(dashed + 'T09:25:00+08:00')
    const confirmationAt = Date.parse(dashed + 'T09:28:00+08:00')
    const factCutoffAt = Date.parse(dashed + 'T09:30:00+08:00')
    const generatedAt = confirmationAt + 10 * 60 * 60 * 1000
    const backfillAt = generatedAt + 60 * 1000
    const evidence = {
      schemaVersion: 1,
      tradeDate,
      stage: 'auction_confirmed',
      cutoffAt: legacyCutoffAt,
      previousTradeDate,
      holdingsCapturedAt: generatedAt,
      portfolioSnapshotKind: 'current-only',
      market: {
        baseFactSnapshotId: null,
        snapshotStatus: 'missing',
        externalRiskTone: 'insufficient',
        confidence: 'low',
        eligibleAssetCount: 0,
        regionCount: 0,
        medianChangePercent: null,
        observations: [],
        briefings: [],
        referenceIds: ['PM-MARKET-EXTERNAL']
      },
      sectors: [
        { key: 'industry:通信设备', kind: 'industry', name: '通信设备', holdingCodes: ['600487.SH'], flowTradeDate: previousTradeDate, mainNetInflow: 186000000, mainNetInflowRate: 2.4, weightedChange: 1.35, referenceId: 'PM-SECTOR-001' },
        { key: 'concept:光通信', kind: 'concept', name: '光通信', holdingCodes: ['600487.SH'], flowTradeDate: previousTradeDate, mainNetInflow: -42000000, mainNetInflowRate: -0.7, weightedChange: -0.35, referenceId: 'PM-SECTOR-002' }
      ],
      holdings: [{
        tsCode: '600487.SH', stockName: '亨通光电', industry: '通信设备', concepts: [{ code: 'C1', name: '光通信' }],
        trend: { status: 'ready', tradeDate: previousTradeDate, bars: 120, totalScore: 72, validWeight: 1, trendState: 'strong', stockReturn20d: 7.2, excessReturn20d: 2.1, maxDrawdown20d: -5.4 },
        chip: { status: 'partial', tradeDate: previousTradeDate, winnerRate: 54.3, trappedPct: 31.2, concentration: 12.4, costDeviationPct: 1.3, loosening1d: 0.8, missingReasons: ['INSTITUTION_EVIDENCE_MISSING'] },
        announcements: [], briefings: [],
        auction: null,
        referenceIds: ['PM-HOLDING-001-TREND', 'PM-HOLDING-001-CHIP', 'PM-HOLDING-001-AUCTION'], warnings: ['CHIP_INCOMPLETE', 'AUCTION_NOT_MATCHED']
      }],
      auctionMatchedCount: 0,
      references: [],
      warnings: ['ASIA_OPEN_FACT_SNAPSHOT_MISSING', '600487.SH:CHIP_INCOMPLETE', '600487.SH:AUCTION_NOT_MATCHED', 'PORTFOLIO_AUCTION_NOT_MATCHED']
    }
    const branches = [
      { key: 'base', label: '基准情景', support: 'supported', confidence: 'medium', summary: '外部环境偏积极，组合仍以逐股确认而非外盘直接映射为主', supportingReferenceIds: ['PM-MARKET-EXTERNAL'], counterReferenceIds: ['PM-SECTOR-002'], confirmConditions: ['开盘后持仓未快速跌破竞价参考价'], invalidationConditions: ['持仓开盘路径与外部风险证据明显反向'], unknowns: [] },
      { key: 'reinforced', label: '强化情景', support: 'watching', confidence: 'low', summary: '尚未形成外部、行业和持仓三层同向证据', supportingReferenceIds: ['PM-SECTOR-001'], counterReferenceIds: ['PM-SECTOR-002'], confirmConditions: ['同向持仓获得行业或题材共振'], invalidationConditions: ['竞价高开后迅速失去承接'], unknowns: ['筹码结构部分可用'] },
      { key: 'risk', label: '风险情景', support: 'watching', confidence: 'low', summary: '当前反向证据未形成组合层共振', supportingReferenceIds: ['PM-SECTOR-002'], counterReferenceIds: ['PM-SECTOR-001'], confirmConditions: ['持仓继续弱于竞价参考价'], invalidationConditions: ['持仓收复竞价参考价且行业同步修复'], unknowns: [] }
    ]
    const scenario = {
      schemaVersion: 1, ruleVersion: 'premarket-scenario-v1', tradeDate, stage: 'auction_confirmed', status: 'blocked', marketState: 'insufficient', confidence: 'low',
      headline: '盘前关键证据不足，暂不形成方向性推演', branches,
      holdings: [{ tsCode: '600487.SH', stockName: '亨通光电', state: 'aligned', summary: '本地趋势与当前可见竞价未形成明显冲突', referenceIds: ['PM-HOLDING-001-TREND', 'PM-HOLDING-001-AUCTION'] }],
      warnings: evidence.warnings
    }
    const evidenceJson = JSON.stringify(evidence)
    const scenarioJson = JSON.stringify(scenario)
    const recoveredObservations = [
      { assetId: 'asia.nikkei225', providerSecurityId: '100.N225', name: '日经225', region: 'asia', role: 'risk_asset', latest: 41200, open: 41000, previousClose: 40800, changePercent: 0.98, observedAt: Date.parse(dashed + 'T08:45:00+08:00') },
      { assetId: 'asia.kospi', providerSecurityId: '100.KS11', name: '韩国KOSPI', region: 'asia', role: 'risk_asset', latest: 3290, open: 3270, previousClose: 3260, changePercent: 0.92, observedAt: Date.parse(dashed + 'T08:45:00+08:00') },
    ]
    const recoveredSourceStates = [
      { sourceId: 'tushare-index-global-v1', status: 'blocked', attemptedAt: backfillAt, completedAt: backfillAt, observationCount: 0, expectedCount: 3, errorCode: 'TUSHARE_NOT_CONFIGURED' },
      { sourceId: 'eastmoney-global-history-v1', status: 'partial', attemptedAt: backfillAt, completedAt: backfillAt, observationCount: 2, expectedCount: 7, errorCode: null },
    ]
    const recoveredExternalRisk = {
      ruleVersion: 'external-risk-breadth-v1', tone: 'insufficient', confidence: 'low',
      eligibleAssetCount: 2, regionCount: 1, positiveCount: 2, negativeCount: 0,
      medianChangePercent: 0.95, supportingAssetIds: ['asia.kospi', 'asia.nikkei225'], counterAssetIds: [],
      warnings: ['EXTERNAL_EVIDENCE_NOT_A_SHARE_DIRECTION', 'EXTERNAL_RISK_COVERAGE_INSUFFICIENT'],
    }
    const backfillEvidence = {
      ...evidence,
      cutoffAt: factCutoffAt,
      market: {
        ...evidence.market,
        baseFactSnapshotId: '00000000-0000-4000-8000-000000000089',
        snapshotStatus: 'partial',
        snapshotRevision: 2,
        snapshotRevisionKind: 'manual_backfill',
        snapshotCapturedAt: backfillAt,
        providerId: 'premarket-global-recovery-v1',
        sourceStates: recoveredSourceStates.map(({ attemptedAt: _attemptedAt, completedAt: _completedAt, ...source }) => source),
        externalRiskTone: 'insufficient',
        eligibleAssetCount: 2,
        regionCount: 1,
        medianChangePercent: 0.95,
        observations: recoveredObservations.map(({ providerSecurityId: _providerSecurityId, region: _region, latest: _latest, open: _open, previousClose: _previousClose, ...item }) => item),
      },
      auctionMatchedCount: 1,
      holdings: evidence.holdings.map((holding) => ({
        ...holding,
        auction: {
          tradeDate,
          price: 17.08,
          preClose: 16.88,
          gapPercent: 1.1848,
          amount: 17080000,
          turnoverRate: 0.12,
          volumeRatio: 1.05,
          factAt: Date.parse(dashed + 'T09:25:00+08:00'),
          fetchedAt: Date.parse(dashed + 'T09:40:00+08:00'),
        },
        warnings: holding.warnings.filter((warning) => warning !== 'AUCTION_NOT_MATCHED'),
      })),
      warnings: evidence.warnings.filter((warning) => !warning.includes('AUCTION_NOT_MATCHED')),
    }
    const backfillScenario = {
      ...scenario,
      headline: '补采竞价已进入09:30事实边界，外盘证据仍不足',
      warnings: backfillEvidence.warnings,
    }
    const backfillEvidenceJson = JSON.stringify(backfillEvidence)
    const backfillScenarioJson = JSON.stringify(backfillScenario)
    const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
    const initialFacts = {
      schemaVersion: 1, tradeDate, stage: 'asia_open', cutoffAt: Date.parse(dashed + 'T08:45:00+08:00'),
      observations: [],
      externalRisk: { ...recoveredExternalRisk, eligibleAssetCount: 0, regionCount: 0, positiveCount: 0, medianChangePercent: null, supportingAssetIds: [] },
    }
    const recoveredFacts = {
      schemaVersion: 1, tradeDate, stage: 'asia_open', cutoffAt: Date.parse(dashed + 'T08:45:00+08:00'),
      observations: recoveredObservations,
      externalRisk: recoveredExternalRisk,
    }
    const initialFactsJson = JSON.stringify(initialFacts)
    const recoveredFactsJson = JSON.stringify(recoveredFacts)
    db.exec('DROP TRIGGER IF EXISTS premarket_scenario_versions_no_update; DROP TRIGGER IF EXISTS premarket_scenario_versions_no_delete; DELETE FROM premarket_scenario_versions;')
    db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 1, ?)').run(tradeDate, previousTradeDate)
    db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 0, ?)').run(requestedDate, tradeDate)
    db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 1, ?)').run(nextTradeDate, tradeDate)
    const dailyInsert = db.prepare(
      'INSERT OR REPLACE INTO daily_close_cache (ts_code, trade_date, close, pct_chg, open, high, low, vol, turnover_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    dailyInsert.run('600487.SH', previousTradeDate, 16.88, 0.4, 16.75, 16.95, 16.62, 1200000, 0.8)
    dailyInsert.run('600487.SH', tradeDate, 16.92, 0.237, 17.08, 17.42, 16.7, 1600000, 1.1)
    db.prepare(
      'INSERT INTO premarket_fact_snapshots (id, trade_date, stage, status, schema_version, rule_version, previous_revision_id, revision, revision_kind, requested_at, cutoff_at, captured_at, provider_id, facts_json, facts_sha256, sources_json, warnings_json, created_at) VALUES (?, ?, ?, ?, 1, ?, NULL, 1, \'scheduled\', ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('00000000-0000-4000-8000-000000000088', tradeDate, 'asia_open', 'blocked', 'premarket-facts-v1', generatedAt, initialFacts.cutoffAt, initialFacts.cutoffAt, 'eastmoney-global-public-v1', initialFactsJson, hash(initialFactsJson), '[]', JSON.stringify(['ASIA_OPEN_FACT_SNAPSHOT_MISSING']), generatedAt)
    db.prepare(
      'INSERT INTO premarket_fact_snapshots (id, trade_date, stage, status, schema_version, rule_version, previous_revision_id, revision, revision_kind, requested_at, cutoff_at, captured_at, provider_id, facts_json, facts_sha256, sources_json, warnings_json, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, 2, \'manual_backfill\', ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('00000000-0000-4000-8000-000000000089', tradeDate, 'asia_open', 'partial', 'premarket-facts-v1', '00000000-0000-4000-8000-000000000088', backfillAt, recoveredFacts.cutoffAt, backfillAt, 'premarket-global-recovery-v1', recoveredFactsJson, hash(recoveredFactsJson), JSON.stringify(recoveredSourceStates), JSON.stringify(['EXTERNAL_RISK_COVERAGE_INSUFFICIENT']), backfillAt)
    db.prepare(
      'INSERT INTO premarket_scenario_versions (id, trade_date, stage, status, schema_version, rule_version, base_fact_snapshot_id, parent_version_id, previous_revision_id, revision, revision_kind, requested_at, cutoff_at, fact_cutoff_at, generated_at, evidence_json, evidence_sha256, scenario_json, scenario_sha256, warnings_json, created_at) VALUES (?, ?, ?, ?, 1, ?, NULL, NULL, NULL, 1, \'scheduled\', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('00000000-0000-4000-8000-000000000090', tradeDate, 'auction_confirmed', 'blocked', 'premarket-scenario-v1', generatedAt, legacyCutoffAt, legacyCutoffAt, generatedAt, evidenceJson, hash(evidenceJson), scenarioJson, hash(scenarioJson), JSON.stringify(evidence.warnings), generatedAt)
    db.prepare(
      'INSERT INTO premarket_scenario_versions (id, trade_date, stage, status, schema_version, rule_version, base_fact_snapshot_id, parent_version_id, previous_revision_id, revision, revision_kind, requested_at, cutoff_at, fact_cutoff_at, generated_at, evidence_json, evidence_sha256, scenario_json, scenario_sha256, warnings_json, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, NULL, ?, 2, \'manual_backfill\', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('00000000-0000-4000-8000-000000000092', tradeDate, 'auction_confirmed', 'blocked', 'premarket-scenario-v1', '00000000-0000-4000-8000-000000000089', '00000000-0000-4000-8000-000000000090', backfillAt, confirmationAt, factCutoffAt, backfillAt, backfillEvidenceJson, hash(backfillEvidenceJson), backfillScenarioJson, hash(backfillScenarioJson), JSON.stringify(backfillEvidence.warnings), backfillAt)
    const outcome = {
      schemaVersion: 1,
      ruleVersion: 'premarket-validation-v1',
      tradeDate,
      scenarioVersionId: '00000000-0000-4000-8000-000000000092',
      scenarioRuleVersion: 'premarket-scenario-v1',
      marketState: 'constructive',
      status: 'matured',
      validatedAt: generatedAt + 8 * 60 * 60 * 1000,
      items: [{
        tsCode: '600487.SH', stockName: '亨通光电', premarketState: 'aligned', status: 'matured', previousTradeDate,
        source: 'daily_close_cache',
        input: { previousClose: 16.88, open: 17.08, high: 17.42, low: 16.7, close: 16.92 },
        outcome: { ruleVersion: 'premarket-outcome-v1', label: 'gap_up_fade', gapPercent: 1.1848, highChangePercent: 3.1991, closeChangePercent: 0.237, highGivebackRatio: 0.9259, warnings: [] },
        warnings: []
      }],
      counts: { total: 1, matured: 1, missing: 0 },
      coverageRate: 1,
      outcomeCounts: { gap_up_fade: 1, gap_up_hold: 0, low_or_flat_rebound: 0, weak_all_day: 0, mixed: 0, insufficient: 0 },
      warnings: []
    }
    const outcomeJson = JSON.stringify(outcome)
    db.prepare(
      'INSERT INTO premarket_outcome_validations (id, trade_date, scenario_version_id, status, schema_version, rule_version, source_fingerprint, validation_json, validation_sha256, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)'
    ).run('00000000-0000-4000-8000-000000000093', tradeDate, '00000000-0000-4000-8000-000000000092', 'matured', 'premarket-validation-v1', hash('e2e-outcome-source'), outcomeJson, hash(outcomeJson), outcome.validatedAt)
    db.exec("CREATE TRIGGER premarket_scenario_versions_no_update BEFORE UPDATE ON premarket_scenario_versions BEGIN SELECT RAISE(ABORT, 'PREMARKET_SCENARIO_VERSION_IMMUTABLE'); END; CREATE TRIGGER premarket_scenario_versions_no_delete BEFORE DELETE ON premarket_scenario_versions BEGIN SELECT RAISE(ABORT, 'PREMARKET_SCENARIO_VERSION_IMMUTABLE'); END;")
    db.close()
  `
  execFileSync(electronExecutable, ['-e', script], {
    cwd: join(__dirname, '../..'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      TRADE_WATCH_SEED_DB: dbPath,
      TRADE_WATCH_REQUESTED_DATE: requestedDate,
      TRADE_WATCH_TRADE_DATE: tradeDate,
      TRADE_WATCH_PREVIOUS_TRADE_DATE: previousTradeDate,
      TRADE_WATCH_NEXT_TRADE_DATE: nextTradeDate,
    },
    stdio: 'pipe',
  })
}

async function openDecisionCenter(window: Page): Promise<void> {
  await window.waitForLoadState('domcontentloaded')
  const guide = window.getByTestId('cold-start-guide')
  if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
  await window.getByTestId('nav-tab-decision-center').click()
  await expect(window.getByTestId('decision-center-root')).toBeVisible({ timeout: 15_000 })
}

test('盘前推演从今日看板与通知定位进入，并在默认窗口和最大化状态完成验证闭环', async () => {
  test.setTimeout(90_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-premarket-scenario-'))
  const screenshotDir = join(process.cwd(), 'test-results', 'premarket-scenario-drawer')
  mkdirSync(screenshotDir, { recursive: true })
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await app.close()

    const today = bjYmd()
    const scenarioDate = previousDay(today)
    seedScenarioFixture(
      join(`${userDataDir}-dev`, 'trade-watch.db'),
      today,
      scenarioDate,
      previousDay(scenarioDate),
      nextWeekday(today),
    )
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await openDecisionCenter(window)

    const windowContract = await app.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]
      return mainWindow ? {
        size: mainWindow.getSize(),
        maximizable: mainWindow.isMaximizable(),
        manualResizeGuardCount: mainWindow.listenerCount('will-resize'),
      } : null
    })
    expect(windowContract).toEqual({
      size: [1680, 960],
      maximizable: true,
      manualResizeGuardCount: 1,
    })

    const trigger = window.getByTestId('decision-open-premarket-scenario')
    const triggerBox = await trigger.boundingBox()
    const footerBox = await window.getByTestId('decision-command-footer').boundingBox()
    expect(triggerBox?.height).toBeGreaterThanOrEqual(30)
    expect(triggerBox?.height).toBeLessThanOrEqual(34)
    expect(triggerBox && footerBox && triggerBox.y + triggerBox.height < footerBox.y).toBe(true)
    await expect(window.getByTestId('decision-command-footer').getByTestId('decision-open-premarket-scenario')).toHaveCount(0)
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('premarket:openScenario')
    })
    const drawer = window.getByTestId('premarket-scenario-drawer')
    const drawerBody = window.getByTestId('premarket-scenario-drawer-body')
    await expect(drawer).toBeVisible()
    await expect(drawer).toContainText('09:28确认版')
    await expect(drawer).toContainText('修订 R2')
    await expect(drawer).toContainText('亨通光电')
    await expect(drawer.getByTestId('premarket-scenario-fallback')).toContainText(`今日休市 · 当前展示最近交易日 ${scenarioDate.slice(0, 4)}-${scenarioDate.slice(4, 6)}-${scenarioDate.slice(6, 8)}`)
    await expect(drawer.getByTestId('premarket-scenario-fallback')).toContainText('盘前推演、盘后验证与AI解释均绑定该冻结版本')
    const conclusion = drawer.getByTestId('premarket-user-conclusion')
    await expect(conclusion).toContainText('盘前结论')
    await expect(conclusion).toContainText('暂不判断')
    await expect(conclusion).toContainText('关键盘前事实仍不完整，当前不能判断方向')
    await expect(conclusion).toContainText('开盘如何确认')
    await expect(conclusion).toContainText('什么情况下判断失效')
    await expect(drawer.getByTestId('premarket-preparation')).toContainText('下一交易日准备')
    await expect(drawer.getByTestId('premarket-preparation')).toContainText(`${nextWeekday(today).slice(0, 4)}-${nextWeekday(today).slice(4, 6)}-${nextWeekday(today).slice(6, 8)}`)
    await expect(drawer.getByTestId('premarket-preparation')).toContainText('联网采集未开启')
    await expect(drawer.getByTestId('premarket-evidence-diagnosis')).toContainText('本次历史补采后仅取得 2 项风险资产、1 个地区')
    await expect(drawer.getByTestId('premarket-evidence-diagnosis')).toContainText('“重新补采”只会读取可按交易日或发布时间还原的事实，并追加新修订')
    await expect(drawer.getByTestId('premarket-evidence-diagnosis')).toContainText('趋势 1/1 只')
    await expect(drawer.getByTestId('premarket-market-snapshot-meta')).toContainText('快照 R2')
    await expect(drawer.getByTestId('premarket-market-snapshot-meta')).toContainText('Tushare未配置')
    await expect(drawer.getByTestId('premarket-market-snapshot-meta')).toContainText('东方财富历史 2/7')
    await expect(drawer.getByText('09:25定稿 · 采集', { exact: false })).toContainText('09:40')
    const compactActionGeometry = await Promise.all([
      drawer.getByTestId('premarket-scenario-retry'),
      drawer.getByTestId('premarket-scenario-reload'),
      drawer.getByTestId('premarket-open-capture-settings'),
      drawer.getByTestId('premarket-refresh-preparation'),
    ].map(async (button) => ({
      box: await button.boundingBox(),
      style: await button.evaluate((element) => {
        const computed = window.getComputedStyle(element)
        return { fontSize: computed.fontSize, borderRadius: computed.borderRadius }
      }),
    })))
    expect(compactActionGeometry.every(({ box }) => box && box.height >= 30 && box.height <= 34)).toBe(true)
    expect(compactActionGeometry.map(({ box }) => box?.height)).toEqual([32, 32, 32, 32])
    expect(compactActionGeometry.map(({ style }) => style.fontSize)).toEqual(['12px', '12px', '12px', '12px'])
    expect(compactActionGeometry.map(({ style }) => style.borderRadius)).toEqual(['6px', '6px', '6px', '6px'])
    await expect(drawer.getByTestId('premarket-scenario-retry')).toHaveText('重新补采')
    await expect(drawer.getByTestId('premarket-open-capture-settings')).toHaveText('采集设置')
    await expect(drawer.getByTestId('premarket-revision-history')).toContainText('每次补采都追加新修订')
    await expect(drawer.getByTestId('premarket-revision-2')).toHaveAttribute('aria-pressed', 'true')
    await expect(drawer.getByTestId('premarket-revision-1')).toHaveAttribute('aria-pressed', 'false')
    await drawer.getByTestId('premarket-revision-1').click()
    await expect(drawer).toContainText('09:25确认版')
    await expect(drawer).toContainText('修订 R1')
    await expect(drawer.getByTestId('premarket-revision-1')).toHaveAttribute('aria-pressed', 'true')
    await expect(drawer.getByTestId('premarket-evidence-diagnosis')).toContainText('09:25 持仓竞价未命中（亨通光电）')
    await expect(drawer.getByTestId('premarket-evidence-diagnosis')).toContainText('可显式重新补采历史竞价后生成新修订')
    await drawer.getByTestId('premarket-revision-2').click()
    await expect(drawer).toContainText('09:28确认版')
    await expect(drawer.getByTestId('premarket-revision-2')).toHaveAttribute('aria-pressed', 'true')
    expect(await drawerBody.evaluate((element) => {
      const conclusionNode = element.querySelector('[data-testid="premarket-user-conclusion"]')
      const preparationNode = element.querySelector('[data-testid="premarket-preparation"]')
      return Boolean(conclusionNode && preparationNode && (conclusionNode.compareDocumentPosition(preparationNode) & Node.DOCUMENT_POSITION_FOLLOWING))
    })).toBe(true)
    await expect(drawer.getByTestId('premarket-scenario-branch-base')).toBeVisible()
    await expect(drawer.getByTestId('premarket-scenario-branch-reinforced')).toBeVisible()
    await expect(drawer.getByTestId('premarket-scenario-branch-risk')).toBeVisible()
    const apiResult = await window.evaluate(() => window.api.premarket.getScenario())
    expect(apiResult.ok && apiResult.version.stage).toBe('auction_confirmed')
    expect(apiResult.ok && apiResult.version.revision).toBe(2)
    expect(apiResult.ok && apiResult.displayContext).toMatchObject({
      requestedTradeDate: today,
      displayTradeDate: scenarioDate,
      isFallback: true,
      fallbackReason: 'non_trading_day',
    })
    expect(apiResult.ok && 'evidenceSha256' in apiResult.version).toBe(false)
    expect(await drawerBody.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    const branchGeometry = await drawerBody.getByTestId('premarket-scenario-branches').evaluate((grid) => {
      const container = grid.getBoundingClientRect()
      return Array.from(grid.children).map((child) => {
        const bounds = child.getBoundingClientRect()
        return {
          left: bounds.left,
          right: bounds.right,
          containerLeft: container.left,
          containerRight: container.right,
        }
      })
    })
    expect(branchGeometry).toHaveLength(3)
    expect(branchGeometry.every((item) => item.left >= item.containerLeft - 1 && item.right <= item.containerRight + 1)).toBe(true)
    const aiButton = drawer.getByRole('button', { name: '生成AI解释' })
    expect((await aiButton.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    await window.screenshot({ path: join(screenshotDir, 'scenario-default-1680x960-light.png') })

    await app.evaluate(({ ipcMain }, targetTradeDate) => {
      ipcMain.removeHandler('premarket:retryScenario')
      ipcMain.handle('premarket:retryScenario', async (event) => {
        event.sender.send('premarket:retryProgress', {
          phase: 'external',
          message: '正在恢复08:45外盘历史事实',
          current: null,
          total: null,
        })
        await new Promise((resolve) => setTimeout(resolve, 250))
        return {
          ok: true,
          tradeDate: targetTradeDate,
          revision: { revision: 2 },
          sources: [{ source: 'external', status: 'partial', itemCount: 2, errorCode: 'EXTERNAL_RECOVERY_INSUFFICIENT' }],
        }
      })
    }, scenarioDate)
    await drawer.getByTestId('premarket-scenario-retry').click()
    await expect(drawer.getByTestId('premarket-retry-feedback')).toContainText('正在恢复08:45外盘历史事实')
    await expect(drawer.getByTestId('premarket-retry-feedback')).toContainText('已生成不可变修订 R2，事实边界保持在09:30。')
    await expect(drawer.getByTestId('premarket-retry-feedback')).toContainText('外盘历史恢复 2 项')

    await drawer.getByTestId('premarket-refresh-preparation').click()
    await expect(drawer.getByTestId('premarket-preparation')).toContainText('盘前联网采集尚未开启')
    const preparationCount = await window.evaluate(async () => {
      const response = await window.api.premarket.getPreparation()
      return response.preparation ? 1 : 0
    })
    expect(preparationCount).toBe(0)

    await drawer.getByTestId('premarket-open-capture-settings').click()
    const configDrawer = window.getByTestId('config-drawer')
    await expect(configDrawer).toBeVisible()
    await expect(configDrawer.getByTestId('premarket-capture-settings')).toBeInViewport()
    await expect(configDrawer.locator('#premarket-capture-title')).toBeFocused()
    await configDrawer.getByLabel('关闭', { exact: true }).click()
    await trigger.click()
    await expect(drawer).toBeVisible()

    await drawer.getByTestId('premarket-view-outcome').click()
    await expect(drawer.getByTestId('premarket-outcome-content')).toContainText('高开回落')
    await expect(drawer.getByTestId('premarket-outcome-content')).toContainText('覆盖率 100.0%')
    expect(await drawerBody.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await drawer.getByTestId('premarket-view-calibration').click()
    await expect(drawer.getByTestId('premarket-calibration-content')).toContainText('盘前状态 × 实际路径')
    await expect(drawer.getByTestId('premarket-calibration-content')).toContainText('数字概率尚未开放')
    expect(await drawerBody.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)

    await window.evaluate(() => window.api.windowControls.toggleMaximize())
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false)).toBe(true)
    await window.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    await expect(drawer).toBeVisible()
    expect(await window.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    expect(await drawerBody.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await window.screenshot({ path: join(screenshotDir, 'calibration-maximized-dark-reduced-motion.png') })
  } finally {
    await app.close().catch(() => undefined)
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
