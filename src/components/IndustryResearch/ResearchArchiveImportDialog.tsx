import { useEffect, useState } from 'react'
import type { IndustryResearchResponse, ResearchArchiveImportResult } from './industryResearchTypes'

const ARCHIVE_TYPE = 'optical-fiber-research-v1'

interface Props {
  open: boolean
  projectId: string
  onClose: () => void
  onImported: (result: ResearchArchiveImportResult) => void
}

export function ResearchArchiveImportDialog({ open, projectId, onClose, onImported }: Props): React.ReactElement | null {
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ResearchArchiveImportResult | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setResult(null)
  }, [open])

  if (!open) return null

  const runImport = async () => {
    setImporting(true)
    setError(null)
    const response = await window.api.industryResearch.importCandidateArchive({
      requestId: crypto.randomUUID(),
      projectId,
      archiveType: ARCHIVE_TYPE,
      dryRun: false,
    }) as IndustryResearchResponse<ResearchArchiveImportResult>
    setImporting(false)
    if (!response.ok || !response.data) {
      if (response.code !== 'CANCELLED') setError(response.message || '导入研究档案失败')
      return
    }
    setResult(response.data)
    onImported(response.data)
  }

  return (
    <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-slate-950/55 p-4" role="dialog" aria-modal="true" aria-labelledby="archive-import-title">
      <div className="flex max-h-[86vh] w-full max-w-xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl dark:bg-slate-950">
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div>
            <div className="text-[11px] font-semibold text-slate-500">高级入口</div>
            <h2 id="archive-import-title" className="mt-1 text-lg font-semibold">导入受支持研究档案</h2>
          </div>
          <button type="button" onClick={onClose} disabled={importing} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs disabled:opacity-40 dark:border-slate-700">关闭</button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-sm">
          <div className="border-y border-slate-200 py-3 text-slate-600 dark:border-slate-800 dark:text-slate-300">
            <p className="font-medium text-slate-900 dark:text-slate-100">光纤产业链五文件档案</p>
            <p className="mt-1 text-xs leading-5">选择规定的五个 UTF-8 Markdown 文件。系统校验文件名、大小和 SHA-256 后，只生成可处理的语义变更包，不直接改写当前研究。</p>
          </div>
          {error && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{error}</div>}
          {result && (
            <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-3 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-300">
              <p className="font-semibold">档案已整理为 {result.changeSets.length} 个变更包、{result.candidateCount} 项底层候选</p>
              <p className="mt-1">档案版本：{result.archive.archiveVersion}</p>
              {result.warnings.length > 0 && <p className="mt-2 text-amber-700 dark:text-amber-300">注意：{result.warnings.join('；')}</p>}
              {result.unresolvedRefs.length > 0 && <p className="mt-1 text-amber-700 dark:text-amber-300">未解析引用：{result.unresolvedRefs.length} 项</p>}
            </div>
          )}
        </div>
        <footer className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4 dark:border-slate-800">
          <button type="button" onClick={onClose} disabled={importing} className="rounded-md border border-slate-300 px-4 py-2 text-sm disabled:opacity-40 dark:border-slate-700">{result ? '完成' : '取消'}</button>
          {!result && <button type="button" data-testid="research-archive-import-submit" onClick={() => { void runImport() }} disabled={importing} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900">{importing ? '校验并整理中…' : '选择五个文件'}</button>}
        </footer>
      </div>
    </div>
  )
}
