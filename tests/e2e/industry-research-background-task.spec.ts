import { expect, test, _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

test('产业研究切换 Tab 后显示全局进度并可返回项目', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-fr241-task-'))
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  const app = await electron.launch({
    args: [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await expect(window.getByTestId('nav-tab-feed')).toBeVisible()
    const coldStartGuide = window.getByTestId('cold-start-guide')
    if (await coldStartGuide.isVisible()) await coldStartGuide.getByLabel('关闭引导').click()

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('industryResearch:generationProgress', {
        projectId: 'e2e-project-background',
        runId: 'e2e-run-background',
        status: 'running',
        stage: 'companies',
        progressCurrent: 6,
        progressTotal: 7,
        message: '正在采集沪电股份（002463.SZ）的利润表',
        updatedAt: Date.now(),
        financialCollection: {
          status: 'running',
          totalCompanies: 2,
          completedCompanies: 1,
          totalDatasets: 18,
          coveredDatasets: 9,
          failedDatasets: 0,
          pendingDatasets: 9,
          attemptedDatasets: 10,
          skippedDatasets: 0,
          processedDatasets: 9,
          currentCompanyId: 'company-hudian',
          currentCompanyName: '沪电股份',
          currentTsCode: '002463.SZ',
          currentCompanyIndex: 2,
          currentDataset: 'income',
          currentDatasetIndex: 1,
          errorCode: null,
          message: '正在采集沪电股份（002463.SZ）的利润表',
          startedAt: Date.now() - 30_000,
          updatedAt: Date.now(),
          completedAt: null,
          companies: [],
        },
      })
    })

    const task = window.getByTestId('industry-research-background-task')
    await expect(task).toBeVisible()
    await expect(task).toContainText('产业研究后台')
    await expect(task).toContainText('公司业务与财务采集')
    await expect(task).toContainText('沪电股份')
    await expect(task).toContainText('利润表')
    await expect(task).toContainText('已处理 9/18')
    await expect(window.getByTestId('industry-research-background-progress')).toHaveAttribute('aria-valuenow', '9')
    await expect(window.getByTestId('industry-research-background-progress')).toHaveAttribute('aria-valuemax', '18')

    await window.getByTestId('nav-tab-stock-chart').click()
    await expect(window.getByTestId('stock-chart-page')).toBeVisible()
    await expect(task).toBeVisible()
    await expect(task).toContainText('已处理 9/18')

    for (const viewport of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
      await window.setViewportSize(viewport)
      const taskBox = await task.boundingBox()
      expect(taskBox?.height).toBeGreaterThanOrEqual(44)
      expect(taskBox?.height).toBeLessThanOrEqual(60)
      const pageLayout = await window.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }))
      expect(pageLayout.scrollWidth).toBeLessThanOrEqual(pageLayout.clientWidth)
      await expect(window.getByTestId('stock-chart-page')).toBeVisible()
      const screenshotDir = process.env.FR241_SCREENSHOT_DIR
      if (screenshotDir) {
        mkdirSync(screenshotDir, { recursive: true })
        await window.screenshot({
          path: join(screenshotDir, `industry-research-background-task-${viewport.width}x${viewport.height}.png`),
        })
      }
    }

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('industryResearch:generationProgress', {
        projectId: 'e2e-project-background',
        runId: 'e2e-run-background',
        status: 'running',
        stage: 'report',
        progressCurrent: 7,
        progressTotal: 7,
        message: '正在生成完整 Markdown 研究报告',
        updatedAt: Date.now(),
        financialCollection: {
          status: 'succeeded',
          totalCompanies: 2,
          totalDatasets: 18,
          coveredDatasets: 18,
          failedDatasets: 0,
          pendingDatasets: 0,
          attemptedDatasets: 9,
          skippedDatasets: 9,
          processedDatasets: 18,
        },
      })
    })
    await expect(task).toContainText('研究报告生成中（尚未完成）')
    await expect(task).toContainText('已完成 6/7 个阶段')
    await expect(task).not.toContainText('已处理 18/18')
    await expect(window.getByTestId('industry-research-background-progress')).toHaveAttribute('aria-valuenow', '86')
    await expect(window.getByTestId('industry-research-background-progress')).toHaveAttribute('aria-valuemax', '100')
    await expect(window.getByTestId('industry-research-background-progress')).toHaveAttribute(
      'aria-valuetext',
      '已完成 6/7 个阶段，研究报告生成中，尚未完成',
    )
    for (const viewport of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
      await window.setViewportSize(viewport)
      const taskBox = await task.boundingBox()
      expect(taskBox?.height).toBeGreaterThanOrEqual(44)
      expect(taskBox?.height).toBeLessThanOrEqual(60)
      const pageLayout = await window.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }))
      expect(pageLayout.scrollWidth).toBeLessThanOrEqual(pageLayout.clientWidth)
      const screenshotDir = process.env.FR241_SCREENSHOT_DIR
      if (screenshotDir) {
        mkdirSync(screenshotDir, { recursive: true })
        await window.screenshot({
          path: join(screenshotDir, `industry-research-report-task-${viewport.width}x${viewport.height}.png`),
        })
      }
    }

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('industryResearch:generationProgress', {
        projectId: 'e2e-project-background',
        runId: 'e2e-run-background',
        status: 'succeeded',
        stage: 'report',
        progressCurrent: 7,
        progressTotal: 7,
        message: '研究报告已生成',
        updatedAt: Date.now(),
      })
    })
    await expect(task).toContainText('产业研究已完成')

    await task.click()
    await expect(window.getByTestId('industry-research-page')).toBeVisible()
    await expect(task).toBeHidden()
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
