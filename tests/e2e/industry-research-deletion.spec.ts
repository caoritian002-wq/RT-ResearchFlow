import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROJECT_ID = 'e2e-immutable-archived-project'
const SKILL_SNAPSHOT_ID = 'e2e-shared-skill-snapshot'

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  return electron.launch({
    args: [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })
}

async function openWindow(app: ElectronApplication): Promise<Page> {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await expect(window.getByTestId('app-navigation-shell')).toBeVisible({ timeout: 15_000 })
  const guide = window.getByTestId('cold-start-guide')
  if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
  return window
}

function runDatabaseScript(dbPath: string, script: string): string {
  const electronExecutable = require('electron') as string
  return execFileSync(electronExecutable, ['-e', script], {
    cwd: join(__dirname, '../..'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      TRADE_WATCH_SEED_DB: dbPath,
    },
  }).toString()
}

function seedArchivedProject(dbPath: string): void {
  runDatabaseScript(dbPath, String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    db.pragma('foreign_keys = ON')
    const now = Date.now()
    db.prepare(
      'INSERT INTO industry_research_skill_snapshots (id, skill_id, content_hash, rule_version, content, source_type, source_locator, content_bytes, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('${SKILL_SNAPSHOT_ID}', 'builtin:industry-chain-research', 'a'.repeat(64), 'e2e-v1', '# E2E shared skill', 'builtin', 'e2e', 18, now)
    db.prepare(
      'INSERT INTO industry_research_projects (id, title, industry_name, product_scope, region_scope, time_scope, purpose, depth, status, data_as_of, source_type, source_ref, source_text_summary, skill_id, skill_content_hash, skill_rule_version, generation_model, graph_updated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('${PROJECT_ID}', '已有版本的归档产业研究', '光通信', '光纤光缆', '中国', '近三年', 'investment', 'standard', 'archived', '2026-08-06', 'manual', null, 'E2E deletion fixture', 'builtin:industry-chain-research', 'a'.repeat(64), 'e2e-v1', 'e2e-model', now, now, now)
    db.prepare(
      "INSERT INTO industry_research_snapshots (id, project_id, previous_snapshot_id, snapshot_reason, request_id, trigger_batch_id, skill_snapshot_id, source_session_id, source_origin_type, source_origin_id, source_return_target_json, schema_version, graph_updated_at, title, accepted_change_set_count, snapshot_json, created_at) VALUES (?, ?, NULL, 'project_baseline', ?, NULL, ?, NULL, 'manual', ?, NULL, 1, ?, ?, 0, ?, ?)"
    ).run('e2e-immutable-snapshot', '${PROJECT_ID}', 'e2e-delete-request', '${SKILL_SNAPSHOT_ID}', '${PROJECT_ID}', now, '归档研究基线', JSON.stringify({ projectId: '${PROJECT_ID}' }), now)
    db.close()
  `)
}

function readDeletionResult(dbPath: string): { projects: number; snapshots: number; skillSnapshots: number } {
  return JSON.parse(runDatabaseScript(dbPath, String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB, { readonly: true })
    const count = (table, column, value) => db.prepare('SELECT COUNT(*) AS count FROM ' + table + ' WHERE ' + column + ' = ?').get(value).count
    process.stdout.write(JSON.stringify({
      projects: count('industry_research_projects', 'id', '${PROJECT_ID}'),
      snapshots: count('industry_research_snapshots', 'project_id', '${PROJECT_ID}'),
      skillSnapshots: count('industry_research_skill_snapshots', 'id', '${SKILL_SNAPSHOT_ID}'),
    }))
    db.close()
  `)) as { projects: number; snapshots: number; skillSnapshots: number }
}

test('已有不可变版本的归档产业研究仍可从项目菜单永久删除', async () => {
  test.setTimeout(120_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-industry-delete-'))
  const dbPath = join(`${userDataDir}-dev`, 'trade-watch.db')
  let app = await launchApp(userDataDir)

  try {
    await openWindow(app)
    await app.close()
    seedArchivedProject(dbPath)

    app = await launchApp(userDataDir)
    const window = await openWindow(app)
    const windowContract = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getSize() ?? [])
    expect(windowContract).toEqual([1680, 960])

    await window.getByTestId('nav-tab-ai-analysis').click()
    await window.getByTestId('secondary-nav-ai-analysis-industryResearch').click()
    await expect(window.getByTestId('industry-research-page')).toBeVisible({ timeout: 15_000 })
    await window.getByLabel('显示已归档').check()
    await expect(window.getByRole('heading', { name: '已有版本的归档产业研究' })).toBeVisible()

    await window.getByRole('button', { name: '项目操作' }).click()
    const deleteItem = window.getByRole('menuitem', { name: '删除项目' })
    await expect(deleteItem).toBeEnabled()
    await deleteItem.click()
    await expect(window.getByText('确认永久删除「已有版本的归档产业研究」？')).toBeVisible()
    await expect(window.getByText('共享公司、证券、财务事实、Skill快照和既有研究讨论会保留')).toBeVisible()
    await window.getByRole('button', { name: '永久删除' }).click()

    await expect(window.getByRole('heading', { name: '已有版本的归档产业研究' })).toHaveCount(0)
    await expect(window.getByText('从研究问题开始')).toBeVisible()
    await app.close()

    expect(readDeletionResult(dbPath)).toEqual({ projects: 0, snapshots: 0, skillSnapshots: 1 })
  } finally {
    await app.close().catch(() => undefined)
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
