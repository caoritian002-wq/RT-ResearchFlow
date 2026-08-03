import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  return electron.launch({
    args: [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })
}

function seedAiEvaluationFixture(dbPath: string): void {
  const electronExecutable = require('electron') as string
  const seedScript = String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    const now = Date.now()
    const insertRun = db.prepare(
      "INSERT INTO ai_evaluation_runs (suite_id, suite_version, suite_fingerprint, provider, model, business_prompt_fingerprint, evaluation_prompt_fingerprint, status, progress_current, progress_total, current_case_id, total_score, conclusion, dimension_scores_json, input_tokens, output_tokens, total_tokens, error_message, started_at, completed_at, created_at) VALUES (?, '1.0.0', 'suite-fixture', 'chatgpt', 'gpt-5.6-sol', 'business-fixture', 'evaluation-fixture', 'completed', 4, 4, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)"
    )
    const previous = insertRun.run(
      'news-analysis-core', 70, 'warning',
      JSON.stringify({ candidateMapping: 90, directionAccuracy: 65, evidenceDiscipline: 70, marketGrounding: 60, compliance: 100 }),
      3200, 1300, 4500, now - 120000, now - 90000, now - 120000,
    )
    const current = insertRun.run(
      'news-analysis-core', 76, 'failed',
      JSON.stringify({ candidateMapping: 100, directionAccuracy: 55, evidenceDiscipline: 80, marketGrounding: 75, compliance: 100 }),
      3600, 1450, 5050, now - 60000, now - 30000, now - 60000,
    )
    const currentId = Number(current.lastInsertRowid)
    const insertCase = db.prepare(
      "INSERT INTO ai_evaluation_case_results (run_id, case_id, title, kind, status, score, rules_json, response_text, input_tokens, output_tokens, total_tokens, error_message, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)"
    )
    const passRule = (id, title, dimension) => ({ id, title, dimension, passed: true, blocking: false, weight: 1, detail: '输出满足公开规则。' })
    insertCase.run(
      currentId, 'direct-positive-mapping', '直接利好与公司映射', 'round1', 'passed', 100,
      JSON.stringify([
        passRule('candidate-footer', '候选尾部可读取', 'candidateMapping'),
        passRule('positive-direction', '公司级方向为正面', 'directionAccuracy'),
      ]),
      '事实：[1]沪电股份认证通过，构成直接正面线索；订单和财务影响待验证。\\nSTOCK_CODES: 002463|沪电股份',
      900, 350, 1250, now - 55000,
    )
    insertCase.run(
      currentId, 'portfolio-negative-risk', '公司级利空与风险识别', 'round1', 'failed', 58,
      JSON.stringify([
        passRule('expected-600183', '命中直接公司600183', 'candidateMapping'),
        { id: 'negative-direction', title: '公司级方向为负面', dimension: 'directionAccuracy', passed: false, blocking: true, weight: 3, detail: '成本上升且售价未变，应识别为潜在负面线索。' },
        passRule('no-trading-instruction', '不输出交易指令或收益承诺', 'compliance'),
      ]),
      '生益科技原材料价格上涨，但公司长期竞争力较强，因此影响偏正面。\\nSTOCK_CODES: 600183|生益科技',
      900, 400, 1300, now - 50000,
    )
    insertCase.run(
      currentId, 'irrelevant-no-mapping', '无关信息拒绝强行映射', 'round1', 'passed', 100,
      JSON.stringify([
        passRule('none-footer', '明确输出STOCK_CODES: NONE', 'candidateMapping'),
        passRule('no-candidate-code', '不制造A股候选', 'candidateMapping'),
      ]),
      '该信息与A股及产业供需无关，没有可解释的映射。\\nSTOCK_CODES: NONE',
      850, 250, 1100, now - 45000,
    )
    insertCase.run(
      currentId, 'round2-market-grounding', '第二轮真实行情约束', 'round2', 'warning', 78,
      JSON.stringify([
        passRule('market-cutoff', '使用给定数据截止日', 'marketGrounding'),
        { id: 'market-sample', title: '披露30个交易日样本', dimension: 'marketGrounding', passed: false, blocking: false, weight: 1, detail: '必须披露最近30个OHLC完整交易日的样本口径。' },
        passRule('no-unsupported-key-level', '不发明关键价位', 'marketGrounding'),
      ]),
      '维持沪电股份观察。数据截止2026-07-18，MA5为49.20，MA20为47.30，支撑46.80和43.20，压力51.60和54.80。',
      950, 450, 1400, now - 40000,
    )
    db.close()
  `
  execFileSync(electronExecutable, ['-e', seedScript], {
    cwd: join(__dirname, '../..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TRADE_WATCH_SEED_DB: dbPath },
    stdio: 'pipe',
  })
}

test('AI研判评测展示五维结果、失败定位和双视口终态', async ({}, testInfo) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-ai-evaluation-'))
  let app = await launchApp(userDataDir)
  try {
    await app.firstWindow()
    await app.close()
    seedAiEvaluationFixture(join(`${userDataDir}-dev`, 'trade-watch.db'))

    app = await launchApp(userDataDir)
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.setViewportSize({ width: 1440, height: 900 })
    const guide = window.getByTestId('cold-start-guide')
    if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()

    await window.getByTestId('open-config-drawer-btn').click()
    await window.getByTestId('config-tab-diagnostics').click()
    const workbench = window.getByTestId('diagnostics-ai-evaluation')
    await expect(workbench).toBeVisible({ timeout: 15_000 })
    await expect(workbench).toContainText('news-analysis-core@1.0.0')
    await expect(workbench).toContainText('每次 4 次模型调用')
    await expect(window.getByTestId('ai-evaluation-total-score')).toHaveText('76')
    await expect(window.locator('[data-testid^="ai-evaluation-dimension-"]')).toHaveCount(5)
    await expect(window.getByTestId('ai-evaluation-comparison')).toContainText('+6')
    await expect(window.locator('[data-testid^="ai-evaluation-case-"]')).toHaveCount(4)
    await expect(workbench.getByText('人工通过')).toHaveCount(0)

    await window.getByTestId('ai-evaluation-run-trigger').click()
    await expect(workbench.getByRole('option')).toHaveCount(2)
    await window.keyboard.press('Escape')
    await expect(workbench.getByRole('option')).toHaveCount(0)

    const failedCase = window.getByTestId('ai-evaluation-case-portfolio-negative-risk')
    await failedCase.scrollIntoViewIfNeeded()
    await failedCase.locator('summary').click()
    await expect(failedCase).toContainText('公司级方向为负面（阻断）')
    await expect(failedCase).toContainText('生益科技原材料价格上涨')

    const desktopGeometry = await window.evaluate(() => ({
      innerWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      workbenchWidth: document.querySelector('[data-testid="diagnostics-ai-evaluation"]')?.getBoundingClientRect().width ?? 0,
      startButtonRightSpacing: (() => {
        const section = document.querySelector('[data-testid="diagnostics-ai-evaluation"]')?.getBoundingClientRect()
        const button = document.querySelector('[data-testid="ai-evaluation-start"]')?.getBoundingClientRect()
        return section && button ? section.right - button.right : 0
      })(),
    }))
    expect(desktopGeometry.documentWidth).toBeLessThanOrEqual(desktopGeometry.innerWidth)
    expect(desktopGeometry.workbenchWidth).toBeLessThanOrEqual(desktopGeometry.innerWidth)
    expect(desktopGeometry.startButtonRightSpacing).toBeGreaterThanOrEqual(24)
    await workbench.scrollIntoViewIfNeeded()
    await window.screenshot({ path: testInfo.outputPath('ai-evaluation-1440-light.png') })

    await window.getByTestId('config-tab-appearance').click()
    await window.getByRole('button', { name: '暗色模式' }).click()
    await window.getByTestId('config-tab-diagnostics').click()
    await window.emulateMedia({ reducedMotion: 'reduce' })
    await window.setViewportSize({ width: 1024, height: 768 })
    await expect(workbench).toBeVisible()
    await workbench.scrollIntoViewIfNeeded()
    const compactGeometry = await window.evaluate(() => ({
      innerWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      panelWidth: document.querySelector('[data-testid="diagnostics-panel"]')?.getBoundingClientRect().width ?? 0,
    }))
    expect(compactGeometry.documentWidth).toBeLessThanOrEqual(compactGeometry.innerWidth)
    expect(compactGeometry.panelWidth).toBeLessThanOrEqual(compactGeometry.innerWidth)
    await window.screenshot({ path: testInfo.outputPath('ai-evaluation-1024-dark-reduced-motion.png') })
  } finally {
    await app.close().catch(() => {})
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
