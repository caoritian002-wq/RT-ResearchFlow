import { expect, test, _electron as electron } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

async function launchApp(userDataDir: string) {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  return electron.launch({
    args: [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })
}

function seedGraphFixture(dbPath: string): void {
  const electronExecutable = require('electron') as string
  const seedScript = String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    db.pragma('foreign_keys = ON')
    const now = Date.now()
    const projectId = 'e2e-graph-project'
    db.prepare(
      'INSERT INTO industry_research_projects (id, title, industry_name, product_scope, region_scope, time_scope, purpose, depth, status, data_as_of, source_type, source_ref, source_text_summary, skill_id, skill_content_hash, skill_rule_version, generation_model, graph_updated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(projectId, '光通信产业传导图验收', '光通信', '光纤光缆与承载网络', '中国', '近三年', 'investment', 'standard', 'active', '2026-07-18', 'manual', null, 'E2E graph fixture', 'builtin:industry-chain-research', 'a'.repeat(64), 'sha256:aaaaaaaaaaaa', 'e2e-model', now, now, now)
    db.prepare(
      'INSERT INTO industry_research_generation_runs (id, project_id, research_question, status, current_stage, last_successful_stage, progress_current, progress_total, progress_message, cancel_requested, skill_id, skill_content_hash, skill_rule_version, provider, model, error_code, error_message, retryable, stage_artifacts_json, scope_json, enable_web_retrieval, created_at, started_at, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'e2e-company-coverage-run', projectId, '验证公司生态位覆盖补全入口。', 'succeeded', 'report', 'report',
      7, 7, '研究报告已生成', 0, 'builtin:industry-chain-research', 'a'.repeat(64), 'sha256:aaaaaaaaaaaa',
      'e2e-provider', 'e2e-model', null, null, 0,
      JSON.stringify({ scope: { purpose: 'investment' }, map: { nodes: [], edges: [] }, companies: { items: [] } }),
      JSON.stringify({ purpose: 'investment' }), 1, now, now, now, now,
    )

    const layerSizes = [5, 4, 8, 13, 6, 3, 3, 3, 3]
    const layerNames = layerSizes.map((size, layer) => Array.from({ length: size }, (_, index) => (
      layer === 3 && index === 0
        ? '深南电路'
        : layer === 3 && index === 1
          ? '高速交换机与网络设备订单持续性验证'
        : layer === 4 && index === 0
          ? '常规电子电路铜箔'
          : '产业节点 ' + layer + '-' + index
    )))
    const layerTypes = ['material', 'equipment', 'product', 'company', 'material', 'product', 'demand', 'demand', 'demand']
    const layerStages = ['上游', '设备与支撑', '中游', '下游公司', '上游材料', '中游', '下游', '终端需求', '终端需求']
    const nodes = layerNames.flatMap((names, layer) => names.map((name, index) => [
      'node:l' + layer + '-' + index,
      name,
      layerTypes[layer],
      layerStages[layer],
      index % 3 === 0 ? 'fact' : 'estimate',
      index === 12 && layer === 3 ? 'no_evidence_support' : 'active',
      index === 0 && layer === 2 ? '[{"name":"利用率","value":82,"unit":"%"}]' : '[]',
      index === 0 ? '["evidence:official-0"]' : '[]',
    ]))
    const insertNode = db.prepare('INSERT INTO industry_research_nodes (id, project_id, type, name, stage, statement_kind, status, metrics_json, evidence_ids_json, last_updated, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const [id, name, type, stage, kind, status, metrics, evidenceIds] of nodes) {
      insertNode.run(id, projectId, type, name, stage, kind, status, metrics, evidenceIds, '2026-07-18', now, now)
    }

    const edges = []
    const relations = ['原料供给', '产能转化', '产品交付', '业务暴露', '加工为', '需求传导', '需求传导', '需求传导']
    for (let layer = 0; layer < layerSizes.length - 1; layer += 1) {
      for (let index = 0; index < layerSizes[layer + 1]; index += 1) {
        edges.push(['main-' + layer + '-' + index, 'l' + layer + '-' + (index % layerSizes[layer]), 'l' + (layer + 1) + '-' + index, relations[layer], index === 0 && layer === 1 ? 1 : 0])
      }
    }
    for (let index = 0; index < 12; index += 1) {
      const layer = index % (layerSizes.length - 1)
      edges.push(['cross-' + index, 'l' + layer + '-' + (index % layerSizes[layer]), 'l' + (layer + 1) + '-' + ((index + 2) % layerSizes[layer + 1]), '交叉传导 ' + (index + 1), index % 7 === 0 ? 1 : 0])
    }
    const insertEdge = db.prepare('INSERT INTO industry_research_edges (id, project_id, source_node_id, target_node_id, relation, statement_kind, strength, bottleneck, exposure_pct, evidence_ids_json, last_updated, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const [id, source, target, relation, bottleneck] of edges) {
      insertEdge.run('edge:' + id, projectId, 'node:' + source, 'node:' + target, relation, bottleneck ? 'fact' : 'estimate', bottleneck ? 0.9 : 0.7, bottleneck, null, bottleneck ? '["evidence:official"]' : '[]', '2026-07-18', now, now)
    }

    const insertEvidence = db.prepare('INSERT INTO industry_research_evidence (id, project_id, title, source_type, source_name, source_url, source_ref, published_date, fact_date, collected_at, metric_name, metric_value, unit, region, product_spec, methodology, statement_kind, direction, reliability, created_by, primary_source_confirmed, conflict_note, excerpt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (let index = 0; index < 18; index += 1) {
      insertEvidence.run('evidence:official-' + index, projectId, '运营商光缆集采结果 ' + (index + 1), 'official', '运营商公告', 'https://example.com/procurement/' + index, null, '2026-07-18', '2026-07-18', now, null, null, null, '中国', '普通单模光纤', null, 'fact', 'support', 'primary', 'human', 1, null, '集采数量与中标份额用于验证下游需求。', now, now)
    }
    const insertHypothesis = db.prepare('INSERT INTO industry_research_hypotheses (id, project_id, statement, importance, status, cheapest_disproof, verification_metric, threshold, due_at, evidence_ids_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const insertHypothesisEvent = db.prepare('INSERT INTO industry_research_hypothesis_events (id, project_id, hypothesis_id, from_status, to_status, reason, evidence_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    for (let index = 0; index < 2; index += 1) {
      const hypothesisId = 'hypothesis:demand-' + index
      insertHypothesis.run(hypothesisId, projectId, '运营商集采需求将持续改善 ' + (index + 1), index + 1, 'open', '下一轮集采量价同时下降。', '集采数量与中标价', '同比下降', null, '[]', now, now)
      insertHypothesisEvent.run('event:hypothesis-demand-' + index, projectId, hypothesisId, null, 'open', 'E2E initial hypothesis', '[]', now)
    }

    const companyFixtures = [
      ['company:score-low', '低分光通信', '600001.SH', 35],
      ['company:score-unknown', '待评分光通信', '600002.SH', null],
      ['company:score-high', '高分光通信', '600003.SH', 82],
    ]
    const insertCompany = db.prepare('INSERT INTO industry_research_companies (id, legal_name, short_name, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    const insertSecurity = db.prepare('INSERT INTO industry_research_securities (id, company_id, ts_code, symbol, exchange, security_type, list_status, mapping_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const insertProjectCompany = db.prepare('INSERT INTO industry_research_project_companies (project_id, company_id, status, evidence_ids_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    const insertTrendScore = db.prepare('INSERT INTO trend_scores (ts_code, trade_date, ma_score, ma_above_60, alpha_score, drawdown, turnover_ratio, macd_above_zero, boll_above_mid, total_score, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const [companyId, companyName, tsCode, totalScore] of companyFixtures) {
      insertCompany.run(companyId, companyName, companyName, 'manual', now, now)
      insertSecurity.run('security:' + companyId, companyId, tsCode, tsCode.slice(0, 6), 'SSE', 'stock', 'L', 'manual', now, now)
      insertProjectCompany.run(projectId, companyId, 'candidate', '[]', now, now)
      if (totalScore != null) insertTrendScore.run(tsCode, '20260717', 50, 1, 50, 5, 1.2, 1, 1, totalScore, now)
    }
    db.close()
  `
  execFileSync(electronExecutable, ['-e', seedScript], {
    cwd: join(__dirname, '../..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TRADE_WATCH_SEED_DB: dbPath },
    stdio: 'pipe',
  })
}

test('产业研究使用真实关系图并按需打开研究账本', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-research-graph-'))
  let app = await launchApp(userDataDir)

  try {
    let window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await app.close()
    seedGraphFixture(join(`${userDataDir}-dev`, 'trade-watch.db'))

    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    const guide = window.locator('[data-testid="cold-start-guide"]')
    if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()

    await window.getByTestId('nav-tab-ai-analysis').click()
    await window.getByTestId('secondary-nav-ai-analysis-industryResearch').click()
    await expect(window.getByTestId('industry-research-page')).toBeVisible({ timeout: 15000 })
    await expect(window.getByRole('heading', { name: '光通信产业传导图验收' })).toBeVisible()

    const rail = window.getByTestId('industry-research-ledger-rail')
    const drawer = window.getByTestId('industry-research-ledger-drawer')
    await expect(rail).toBeVisible()
    await expect(drawer).toHaveCount(0)
    expect(Math.round((await rail.boundingBox())?.width ?? 0)).toBeLessThanOrEqual(44)

    await window.getByTestId('industry-research-view-graph').click()
    const graphCanvas = window.getByTestId('industry-research-graph-canvas')
    const graphChart = window.getByTestId('industry-research-graph-chart')
    await expect(graphCanvas).toBeVisible()
    await expect(window.getByTestId('industry-research-graph-mode-focus')).toHaveAttribute('aria-pressed', 'true')
    await expect(window.getByTestId('industry-research-graph-visible-count')).toContainText('/ 48 节点')
    await expect(window.getByTestId('industry-research-graph-visible-count')).not.toContainText('48 / 48 节点')
    await expect(graphCanvas).toContainText('产业传导图')
    const renderedNodes = graphChart.getByTestId('industry-research-flow-node')
    await expect(renderedNodes.first()).toBeVisible()

    const countNodeOverlaps = async () => renderedNodes.evaluateAll((elements) => {
      const boxes = elements.map((element) => element.getBoundingClientRect())
      let overlaps = 0
      for (let left = 0; left < boxes.length; left += 1) {
        for (let right = left + 1; right < boxes.length; right += 1) {
          const intersectionWidth = Math.min(boxes[left].right, boxes[right].right) - Math.max(boxes[left].left, boxes[right].left)
          const intersectionHeight = Math.min(boxes[left].bottom, boxes[right].bottom) - Math.max(boxes[left].top, boxes[right].top)
          if (intersectionWidth > 1 && intersectionHeight > 1) overlaps += 1
        }
      }
      return overlaps
    })
    const countNodesOutsideChart = async () => graphChart.evaluate((chart) => {
      const chartBox = chart.getBoundingClientRect()
      return Array.from(chart.querySelectorAll<HTMLElement>('[data-testid="industry-research-flow-node"]')).filter((node) => {
        const box = node.getBoundingClientRect()
        return box.left < chartBox.left - 1 || box.right > chartBox.right + 1 || box.top < chartBox.top - 1 || box.bottom > chartBox.bottom + 1
      }).length
    })
    const nodeOpacity = async (nodeName: string) => Number(await graphChart.locator(`[data-node-name="${nodeName}"]`).evaluate((node) => getComputedStyle(node).opacity))

    const graphWidthBeforeDrawer = (await graphCanvas.boundingBox())?.width ?? 0
    await rail.getByRole('button', { name: /证据账本/ }).click()
    await expect(drawer).toBeVisible()
    await expect(drawer).toHaveAttribute('data-section', 'evidence')
    await expect(drawer).toContainText('运营商光缆集采结果 1')
    const graphWidthWithDrawer = (await graphCanvas.boundingBox())?.width ?? 0
    expect(Math.abs(graphWidthWithDrawer - graphWidthBeforeDrawer)).toBeLessThanOrEqual(1)
    const railBox = await rail.boundingBox()
    const drawerBox = await drawer.boundingBox()
    expect(Math.abs((drawerBox?.x ?? 0) + (drawerBox?.width ?? 0) - (railBox?.x ?? 0))).toBeLessThanOrEqual(2)
    expect(drawerBox?.width ?? 0).toBeGreaterThanOrEqual(320)

    await rail.getByRole('button', { name: /待证伪假设/ }).click()
    await expect(drawer).toHaveAttribute('data-section', 'hypotheses')
    await expect(drawer).toContainText('运营商集采需求将持续改善 1')
    await window.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)

    for (const viewport of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
      await window.setViewportSize(viewport)
      await window.waitForTimeout(180)
      const chartBox = await graphChart.boundingBox()
      expect(chartBox?.width ?? 0).toBeGreaterThan(400)
      expect(chartBox?.height ?? 0).toBeGreaterThan(260)
      await expect(renderedNodes.first()).toBeVisible()
      await renderedNodes.first().click()
      const viewportDetail = graphChart.getByTestId('industry-research-node-detail')
      await expect(viewportDetail).toBeVisible()
      await expect(viewportDetail.getByTestId('industry-research-node-detail-title')).not.toBeEmpty()
      await window.waitForTimeout(220)
      await expect.poll(() => viewportDetail.evaluate((element) => Number(getComputedStyle(element).opacity))).toBe(1)
      const viewportDetailBox = await viewportDetail.boundingBox()
      expect(viewportDetailBox?.width ?? 0).toBeGreaterThan(230)
      expect(viewportDetailBox?.x ?? -1).toBeGreaterThanOrEqual((chartBox?.x ?? 0) - 1)
      expect((viewportDetailBox?.x ?? 0) + (viewportDetailBox?.width ?? Number.MAX_SAFE_INTEGER)).toBeLessThanOrEqual((chartBox?.x ?? 0) + (chartBox?.width ?? 0) + 1)
      expect(viewportDetailBox?.y ?? -1).toBeGreaterThanOrEqual((chartBox?.y ?? 0) - 1)
      expect((viewportDetailBox?.y ?? 0) + (viewportDetailBox?.height ?? Number.MAX_SAFE_INTEGER)).toBeLessThanOrEqual((chartBox?.y ?? 0) + (chartBox?.height ?? 0) + 1)
      if (process.env.FR230_GRAPH_SCREENSHOT_DIR) {
        await window.screenshot({ path: join(process.env.FR230_GRAPH_SCREENSHOT_DIR, `industry-research-graph-node-detail-${viewport.width}x${viewport.height}.png`) })
      }
      await window.keyboard.press('Escape')
      await expect(viewportDetail).toHaveCount(0)
      await expect(graphChart).toHaveAttribute('data-graph-selected-node', '')
      const overflow = await window.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }))
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)
      if (process.env.FR230_GRAPH_SCREENSHOT_DIR) {
        mkdirSync(process.env.FR230_GRAPH_SCREENSHOT_DIR, { recursive: true })
        await window.screenshot({ path: join(process.env.FR230_GRAPH_SCREENSHOT_DIR, `industry-research-graph-${viewport.width}x${viewport.height}.png`) })
        if (viewport.width === 1440) {
          await window.getByTestId('industry-research-graph-mode-all').click()
          await expect(window.getByTestId('industry-research-graph-visible-count')).toContainText('48 / 48 节点 · 55 / 55 关系')
          await expect(renderedNodes).toHaveCount(48)
          const fullCanvas = await graphChart.evaluate((element) => ({
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
          }))
          expect(fullCanvas.scrollWidth).toBeLessThanOrEqual(fullCanvas.clientWidth + 1)
          expect(fullCanvas.scrollHeight).toBeLessThanOrEqual(fullCanvas.clientHeight + 1)
          await expect(graphChart).toHaveAttribute('data-graph-engine', 'xyflow-react-dom-svg')
          await expect(graphChart).toHaveAttribute('data-graph-coordinate-space', 'workflow')
          await expect(graphChart).toHaveAttribute('data-graph-roam', 'enabled')
          await expect(graphChart).toHaveAttribute('data-graph-wheel-zoom', 'enabled')
          await expect.poll(countNodeOverlaps).toBe(0)
          await window.waitForTimeout(260)
          await window.screenshot({ path: join(process.env.FR230_GRAPH_SCREENSHOT_DIR, 'industry-research-graph-workflow-readable-1440x900.png') })
          await graphChart.locator('.react-flow__controls-fitview').click()
          await expect.poll(countNodesOutsideChart).toBe(0)
          const fullGraphBox = await graphChart.boundingBox()
          const shennanNode = graphChart.locator('[data-node-name="深南电路"]')
          const copperFoilNode = graphChart.locator('[data-node-name="常规电子电路铜箔"]')
          const longTitleNode = graphChart.locator('[data-node-name="高速交换机与网络设备订单持续性验证"]')
          const unrelatedNode = graphChart.locator('[data-node-name="产业节点 0-4"]')
          await expect(shennanNode).toBeVisible()
          await expect(copperFoilNode).toBeVisible()
          const titleGeometry = await longTitleNode.locator('.research-flow-node__name').evaluate((element) => {
            const box = element.getBoundingClientRect()
            const range = document.createRange()
            range.selectNodeContents(element)
            const textBoxes = Array.from(range.getClientRects())
            return {
              clientHeight: (element as HTMLElement).clientHeight,
              scrollHeight: (element as HTMLElement).scrollHeight,
              textTop: Math.min(...textBoxes.map((rect) => rect.top)),
              textBottom: Math.max(...textBoxes.map((rect) => rect.bottom)),
              boxTop: box.top,
              boxBottom: box.bottom,
            }
          })
          expect(titleGeometry.clientHeight).toBeGreaterThanOrEqual(42)
          expect(titleGeometry.scrollHeight).toBeLessThanOrEqual(titleGeometry.clientHeight)
          expect(titleGeometry.textTop).toBeGreaterThanOrEqual(titleGeometry.boxTop - 1)
          expect(titleGeometry.textBottom).toBeLessThanOrEqual(titleGeometry.boxBottom + 1)

          for (const node of [unrelatedNode, copperFoilNode, shennanNode]) {
            await node.hover()
            await window.waitForTimeout(30)
          }
          await expect(graphChart).toHaveAttribute('data-graph-hover-node', '')
          await expect.poll(() => graphChart.getAttribute('data-graph-hover-node')).not.toBe('')
          await expect.poll(() => nodeOpacity('常规电子电路铜箔')).toBeGreaterThan(0.8)
          await expect.poll(() => nodeOpacity('产业节点 0-4')).toBeLessThan(0.3)
          await expect.poll(countNodeOverlaps).toBe(0)
          await window.screenshot({ path: join(process.env.FR230_GRAPH_SCREENSHOT_DIR, 'industry-research-graph-hover-active-1440x900.png') })

          if (fullGraphBox) await window.mouse.move(fullGraphBox.x + 8, fullGraphBox.y + 8)
          await expect(graphChart).toHaveAttribute('data-graph-hover-node', '')
          await expect.poll(() => nodeOpacity('产业节点 0-4')).toBeGreaterThan(0.8)

          await longTitleNode.click()
          const detailCard = graphChart.getByTestId('industry-research-node-detail')
          await expect(detailCard).toBeVisible()
          await expect(detailCard.getByTestId('industry-research-node-detail-title')).toHaveText('高速交换机与网络设备订单持续性验证')
          await expect(detailCard).toContainText('研究判断')
          await expect(detailCard).toContainText('传导关系')
          await expect(detailCard).toHaveAttribute('data-placement', /^(top|right|bottom|left)$/)
          await window.waitForTimeout(220)
          await expect.poll(() => detailCard.evaluate((element) => Number(getComputedStyle(element).opacity))).toBe(1)
          const detailBox = await detailCard.boundingBox()
          expect(detailBox?.x ?? -1).toBeGreaterThanOrEqual((fullGraphBox?.x ?? 0) - 1)
          expect((detailBox?.x ?? 0) + (detailBox?.width ?? Number.MAX_SAFE_INTEGER)).toBeLessThanOrEqual((fullGraphBox?.x ?? 0) + (fullGraphBox?.width ?? 0) + 1)
          expect(detailBox?.y ?? -1).toBeGreaterThanOrEqual((fullGraphBox?.y ?? 0) - 1)
          expect((detailBox?.y ?? 0) + (detailBox?.height ?? Number.MAX_SAFE_INTEGER)).toBeLessThanOrEqual((fullGraphBox?.y ?? 0) + (fullGraphBox?.height ?? 0) + 1)
          await window.screenshot({ path: join(process.env.FR230_GRAPH_SCREENSHOT_DIR, 'industry-research-graph-node-detail-full-title-1440x900.png') })
          await window.keyboard.press('Escape')
          await expect(detailCard).toHaveCount(0)
          await expect(graphChart).toHaveAttribute('data-graph-selected-node', '')

          await shennanNode.click()
          await expect(graphChart).not.toHaveAttribute('data-graph-selected-node', '')
          await expect(detailCard).toBeVisible()
          await detailCard.getByRole('button', { name: '关闭深南电路详情' }).click()
          await expect(detailCard).toHaveCount(0)
          await expect(graphChart).toHaveAttribute('data-graph-selected-node', '')
          await shennanNode.click()
          await expect(detailCard).toBeVisible()
          await shennanNode.click()
          await expect(detailCard).toHaveCount(0)
          await expect(graphChart).toHaveAttribute('data-graph-selected-node', '')
          await shennanNode.click()
          await expect(detailCard).toBeVisible()
          await graphChart.locator('.react-flow__pane').click({ position: { x: 8, y: 8 } })
          await expect(detailCard).toHaveCount(0)
          await expect(graphChart).toHaveAttribute('data-graph-selected-node', '')
          await window.screenshot({ path: join(process.env.FR230_GRAPH_SCREENSHOT_DIR, 'industry-research-graph-hover-stable-1440x900.png') })
          await window.screenshot({ path: join(process.env.FR230_GRAPH_SCREENSHOT_DIR, 'industry-research-graph-all-initial-1440x900.png') })
          const zoomBefore = Number((await window.getByTestId('industry-research-graph-zoom-value').textContent())?.replace('%', ''))
          const targetBox = await shennanNode.boundingBox()
          if (targetBox) {
            await window.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2)
            for (let index = 0; index < 30; index += 1) {
              const zoom = Number((await window.getByTestId('industry-research-graph-zoom-value').textContent())?.replace('%', ''))
              if (zoom >= 260) break
              await window.mouse.wheel(0, -40)
              await window.waitForTimeout(30)
            }
          }
          await expect.poll(async () => Number((await window.getByTestId('industry-research-graph-zoom-value').textContent())?.replace('%', ''))).toBeGreaterThan(zoomBefore)
          await expect.poll(async () => Number((await window.getByTestId('industry-research-graph-zoom-value').textContent())?.replace('%', ''))).toBeGreaterThanOrEqual(260)
          await expect.poll(countNodeOverlaps).toBe(0)
          await window.screenshot({ path: join(process.env.FR230_GRAPH_SCREENSHOT_DIR, 'industry-research-graph-pcb-density-269-1440x900.png') })
          await graphChart.locator('.react-flow__controls-fitview').click()
          await expect.poll(countNodesOutsideChart).toBe(0)
          await expect.poll(countNodeOverlaps).toBe(0)
          await window.screenshot({ path: join(process.env.FR230_GRAPH_SCREENSHOT_DIR, 'industry-research-graph-all-1440x900.png') })
          await window.getByTestId('industry-research-graph-mode-focus').click()
          await expect(window.getByTestId('industry-research-graph-visible-count')).not.toContainText('48 / 48 节点')
          await rail.getByRole('button', { name: /证据账本/ }).click()
          await expect(drawer).toBeVisible()
          await window.screenshot({ path: join(process.env.FR230_GRAPH_SCREENSHOT_DIR, 'industry-research-ledger-1440x900.png') })
          await rail.getByRole('button', { name: /待证伪假设/ }).click()
          await expect(drawer).toHaveAttribute('data-section', 'hypotheses')
          await window.screenshot({ path: join(process.env.FR230_GRAPH_SCREENSHOT_DIR, 'industry-research-hypotheses-1440x900.png') })
          await window.keyboard.press('Escape')
          await expect(drawer).toHaveCount(0)
        }
      }
    }

    await window.emulateMedia({ reducedMotion: 'reduce' })
    await window.getByRole('button', { name: '打开配置中心' }).click()
    await window.getByTestId('config-tab-appearance').click()
    await window.getByRole('button', { name: '暗色模式' }).click()
    await window.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(window.locator('html')).toHaveClass(/dark/)
    await expect(renderedNodes.first()).toBeVisible()
    await expect.poll(countNodeOverlaps).toBe(0)
    if (process.env.FR230_GRAPH_SCREENSHOT_DIR) {
      await window.screenshot({ path: join(process.env.FR230_GRAPH_SCREENSHOT_DIR, 'industry-research-graph-dark-1440x900.png') })
    }
    await renderedNodes.first().click()
    const darkDetail = graphChart.getByTestId('industry-research-node-detail')
    await expect(darkDetail).toBeVisible()
    await expect.poll(() => darkDetail.evaluate((element) => getComputedStyle(element).animationName)).toBe('none')
    if (process.env.FR230_GRAPH_SCREENSHOT_DIR) {
      await window.screenshot({ path: join(process.env.FR230_GRAPH_SCREENSHOT_DIR, 'industry-research-graph-node-detail-dark-1440x900.png') })
    }
    await window.keyboard.press('Escape')
    await expect(darkDetail).toHaveCount(0)

    await window.setViewportSize({ width: 1680, height: 960 })
    await window.getByTestId('industry-research-view-companies').click()
    const companyFinancial = window.getByTestId('industry-research-company-financial')
    await expect(companyFinancial).toBeVisible()
    const expandCompanies = window.getByTestId('industry-research-expand-companies')
    await expect(expandCompanies).toBeVisible()
    await expect(expandCompanies).toBeEnabled()
    const [viewport, companyListBox, expandBox] = await Promise.all([
      window.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
      window.getByTestId('industry-research-company-list').boundingBox(),
      expandCompanies.boundingBox(),
    ])
    expect(viewport.width).toBeGreaterThanOrEqual(1600)
    expect(viewport.height).toBeGreaterThanOrEqual(880)
    expect(Math.round(expandBox?.height ?? 0)).toBe(32)
    expect((expandBox?.x ?? 0) + (expandBox?.width ?? 0)).toBeLessThanOrEqual((companyListBox?.x ?? 0) + (companyListBox?.width ?? 0))
    const highScoreCompany = window.getByTestId('industry-research-company-company:score-high')
    const lowScoreCompany = window.getByTestId('industry-research-company-company:score-low')
    const unknownScoreCompany = window.getByTestId('industry-research-company-company:score-unknown')
    await expect(highScoreCompany).toHaveAttribute('aria-pressed', 'true')
    await expect(highScoreCompany).toContainText('综合分 82')
    await expect(lowScoreCompany).toContainText('综合分 35')
    const companyPositions = await Promise.all([highScoreCompany, lowScoreCompany, unknownScoreCompany].map(async (company) => (await company.boundingBox())?.y ?? 0))
    expect(companyPositions[0]).toBeLessThan(companyPositions[1])
    expect(companyPositions[1]).toBeLessThan(companyPositions[2])
    await expect(companyFinancial.getByRole('heading', { name: '高分光通信' })).toBeVisible()
    if (process.env.FR230_GRAPH_SCREENSHOT_DIR) {
      await window.screenshot({ path: join(process.env.FR230_GRAPH_SCREENSHOT_DIR, 'industry-research-company-score-order-1440x900.png') })
    }

    await window.getByTestId('industry-research-view-decision').click()
    const decisionWorkbench = window.getByTestId('industry-research-decision-workbench')
    await expect(decisionWorkbench).toBeVisible()
    await expect(window.getByTestId('industry-research-decision-company')).toHaveValue('company:score-high')
    const companyTrigger = window.getByTestId('industry-research-decision-company-trigger')
    await expect(companyTrigger).toContainText('高分光通信')
    await expect(companyTrigger).toContainText('综合分 82')
    await companyTrigger.click()
    const companyOptions = decisionWorkbench.getByRole('option')
    await expect(companyOptions).toHaveCount(3)
    await expect(companyOptions.nth(0)).toContainText('高分光通信')
    await expect(companyOptions.nth(0)).toContainText('综合分 82')
    await expect(companyOptions.nth(1)).toContainText('低分光通信')
    await expect(companyOptions.nth(1)).toContainText('综合分 35')
    await expect(companyOptions.nth(2)).toContainText('待评分光通信')
    if (process.env.FR230_GRAPH_SCREENSHOT_DIR) {
      await window.screenshot({ path: join(process.env.FR230_GRAPH_SCREENSHOT_DIR, 'industry-research-decision-company-score-order-1440x900.png') })
    }
  } finally {
    await app.close().catch(() => {})
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
