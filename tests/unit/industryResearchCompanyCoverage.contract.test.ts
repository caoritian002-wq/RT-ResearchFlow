import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('产业研究公司覆盖交互契约', () => {
  it('通过窄IPC把用户显式补全动作送到主进程', () => {
    const preload = source('electron/preload/index.ts')
    const handlers = source('electron/main/ipc/industryResearchHandlers.ts')

    expect(preload).toContain('expandCompanyCandidates: (projectId: string, runId: string)')
    expect(preload).toContain("ipcRenderer.invoke('industryResearch:expandCompanyCandidates', { projectId, runId })")
    expect(handlers).toContain("ipcMain.handle('industryResearch:expandCompanyCandidates'")
    expect(handlers).toContain('expandIndustryResearchCompanyCandidates(')
  })

  it('公司页提供紧凑全链路补全入口并呈现启动状态', () => {
    const view = source('src/components/IndustryResearch/ResearchCompanyFinancialView.tsx')
    const workspace = source('src/components/IndustryResearch/ResearchWorkspace.tsx')

    expect(view).toContain('data-testid="industry-research-expand-companies"')
    expect(view).toContain("expandingCompanies ? '启动中' : '补全链路'")
    expect(view).toContain('disabled={!onExpandCompanies || expandingCompanies}')
    expect(workspace).toContain('onExpandCompanies={onExpandCompanies}')
    expect(workspace).toContain('dataRevision={companyDataRevision}')
  })

  it('仅在已有可复用公司阶段且没有活动生成时开放入口', () => {
    const workbench = source('src/components/IndustryResearch/IndustryResearch.tsx')

    expect(workbench).toContain("!['queued', 'running'].includes(generationRun.status)")
    expect(workbench).toContain("['companies', 'report'].includes(generationRun.lastSuccessfulStage || '')")
    expect(workbench).toContain('? expandCompanyCandidates')
  })

  it('补全结果切换到派生运行而不是改写来源运行', () => {
    const service = source('electron/main/services/industryResearchGenerationService.ts')
    const status = source('src/components/IndustryResearch/ResearchGenerationStatus.tsx')

    expect(service).toContain("source: 'user_explicit'")
    expect(service).toContain('sourceRunId: evidenceRunId')
    expect(service).toContain('lastSuccessfulStage: \'companies\'')
    expect(service).toContain('launchGenerationPipeline(')
    expect(service).toContain('researchNodeIdsByTsCode: roleNodeIdsByTsCode')
    expect(status).toContain("isCompanyExpansion ? '链路补全' : 'AI 研究'")
  })
})
