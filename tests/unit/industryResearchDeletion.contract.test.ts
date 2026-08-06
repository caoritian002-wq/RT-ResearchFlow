import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('FR-230产业研究永久删除契约', () => {
  it('单项目入口不再按不可变版本数量阻断永久删除', () => {
    const view = source('src/components/IndustryResearch/IndustryResearch.tsx')
    const workspace = source('src/components/IndustryResearch/ResearchWorkspace.tsx')
    const deleteFlow = view.slice(view.indexOf('const askDeleteCurrent'), view.indexOf('const executeConfirmAction'))

    expect(deleteFlow).toContain("setPendingConfirmAction('delete')")
    expect(deleteFlow).toContain('研究版本、决策账本')
    expect(deleteFlow).not.toContain('snapshotCount > 0')
    expect(deleteFlow).not.toContain('只能归档')
    expect(workspace).not.toContain('disabled={hasSnapshots}')
    expect(workspace).not.toContain('已有研究版本的项目只能归档')
  })

  it('主进程不再把研究快照存在解释成只能归档', () => {
    const handlers = source('electron/main/ipc/industryResearchHandlers.ts')
    const cleanup = source('src/components/IndustryResearch/ResearchCleanupDialog.tsx')

    expect(handlers).not.toContain('SNAPSHOT_PROTECTED')
    expect(handlers).not.toContain('已有不可变研究版本的项目只能归档')
    expect(cleanup).toContain('研究版本、决策账本')
    expect(cleanup).toContain('Skill快照和既有研究讨论会保留')
  })
})
