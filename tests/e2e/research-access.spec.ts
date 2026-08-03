import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  const packagedExecutable = process.env.TRADE_WATCH_E2E_EXECUTABLE
  return electron.launch({
    ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
    args: packagedExecutable
      ? [`--user-data-dir=${userDataDir}`]
      : [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })
}

async function openResearchAccessSettings(window: Page): Promise<void> {
  await window.getByTestId('open-config-drawer-btn').click()
  await window.getByTestId('config-tab-settings').click()
  await window.getByTestId('research-access-settings').scrollIntoViewIfNeeded()
  await expect(window.getByTestId('research-access-settings')).toBeVisible()
}

async function captureMcpConfig(window: Page): Promise<{
  command: string
  args: string[]
  env: Record<string, string>
}> {
  await window.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          ;(window as Window & { __researchAccessCopy?: string }).__researchAccessCopy = value
        },
      },
    })
  })
  await window.getByRole('button', { name: '复制 MCP 配置' }).click()
  const raw = await window.evaluate(() => (window as Window & { __researchAccessCopy?: string }).__researchAccessCopy ?? '')
  const parsed = JSON.parse(raw) as {
    mcpServers: { 'trade-watching': { command: string; args: string[]; env: Record<string, string> } }
  }
  return parsed.mcpServers['trade-watching']
}

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

async function connectMcp(config: { command: string; args: string[]; env: Record<string, string> }) {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...processEnvironment(), ...config.env },
    stderr: 'pipe',
    maxBufferSize: 512 * 1024,
  })
  const client = new Client({ name: 'trade-watch-e2e', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return client
}

test('受控本机研究访问可配置、可跨重启、可审计且撤销即时生效', async () => {
  test.setTimeout(120_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-research-access-e2e-'))
  const screenshotDir = join(process.cwd(), 'test-results', 'research-access')
  mkdirSync(screenshotDir, { recursive: true })
  let app = await launchApp(userDataDir)
  let client: Client | null = null

  try {
    let window = await app.firstWindow()
    await window.setViewportSize({ width: 1440, height: 900 })
    await openResearchAccessSettings(window)
    await expect(window.getByText(/服务可用 · v1\.0\.0/)).toBeVisible()
    await window.locator('#research-access-name').fill('E2E MCP 研究访问')
    await window.getByTestId('research-access-create').click()
    await expect(window.getByTestId('research-access-credential-delivery')).toBeVisible()
    await expect(window.getByRole('button', { name: '我已保存' })).toBeVisible()
    await expect(window.getByTestId('research-access-profile')).toHaveCount(1)

    const config = await captureMcpConfig(window)
    expect(config.env.TRADE_WATCH_CREDENTIAL).toMatch(/^twr_[A-Za-z0-9_-]{40,}$/)
    expect(config.args[0]).toContain('research-mcp.cjs')

    client = await connectMcp(config)
    const firstTools = await client.listTools()
    expect(firstTools.tools.map((tool) => tool.name)).toEqual([
      'stock_price_history',
      'stock_trend_snapshot',
      'stock_fundamentals',
      'stock_announcements',
      'news_recent_briefings',
    ])
    const called = await client.callTool({
      name: 'stock_price_history',
      arguments: { stockCode: '600519', limit: 10 },
    })
    expect(called.isError).not.toBe(true)
    expect(called.structuredContent).toMatchObject({ toolId: 'stock.price_history', status: 'missing' })

    await window.getByRole('button', { name: '刷新状态' }).click()
    await expect(window.getByTestId('research-access-audit')).toHaveCount(1)
    await expect(window.getByTestId('research-access-audit')).toContainText('截点 未指定')
    await expect(window.getByTestId('research-access-audit')).toContainText(/耗时 \d+ ms/)
    await expect(window.getByTestId('research-access-audit')).toContainText(/结果 \d+ B/)
    await window.screenshot({ path: join(screenshotDir, 'settings-1440-light.png'), fullPage: false })
    expect(await window.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)

    await client.close()
    client = null
    await app.close()

    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.setViewportSize({ width: 1024, height: 768 })
    await window.emulateMedia({ reducedMotion: 'reduce' })
    await window.getByTestId('open-config-drawer-btn').click()
    await window.getByTestId('config-tab-appearance').click()
    await window.getByRole('button', { name: '暗色模式' }).click()
    await window.getByTestId('config-tab-settings').click()
    await window.getByTestId('research-access-settings').scrollIntoViewIfNeeded()
    await expect(window.getByTestId('research-access-profile')).toHaveCount(1)
    await expect(window.getByTestId('research-access-credential-delivery')).toHaveCount(0)

    client = await connectMcp(config)
    await expect(client.listTools()).resolves.toMatchObject({ tools: expect.any(Array) })

    await window.getByTestId('research-access-profile').getByRole('button', { name: '撤销' }).click()
    await expect(window.getByRole('alertdialog')).toContainText('撤销“E2E MCP 研究访问”？')
    await window.getByRole('alertdialog').getByRole('button', { name: '确认撤销' }).click()
    await expect(window.getByText('已撤销')).toBeVisible()
    await expect(client.listTools()).rejects.toThrow()
    await window.screenshot({ path: join(screenshotDir, 'settings-1024-dark.png'), fullPage: false })
    expect(await window.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  } finally {
    if (client) await client.close().catch(() => undefined)
    await app.close().catch(() => undefined)
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
