import React, { useState } from 'react'
import { DialogActions, DialogFrame, Field } from './ResearchProjectDialog'
import { ResearchWebSearchConfigPanel } from './ResearchWebSearchConfigPanel'

export interface ResearchGenerationDraft {
  researchQuestion: string
  title: string
  industryName: string
  productScope: string
  regionScope: string
  timeScope: string
  purpose: 'learning' | 'strategy' | 'investment'
  depth: 'quick' | 'standard' | 'deep'
  enableWebRetrieval: boolean
  stopCondition: string
}

interface Props {
  saving: boolean
  error: string | null
  onClose: () => void
  onSubmit: (draft: ResearchGenerationDraft) => void
  onOpenBlank: () => void
}

export function ResearchGenerationDialog({
  saving,
  error,
  onClose,
  onSubmit,
  onOpenBlank,
}: Props): React.ReactElement {
  const [draft, setDraft] = useState<ResearchGenerationDraft>({
    researchQuestion: '',
    title: '',
    industryName: '',
    productScope: '',
    regionScope: '中国',
    timeScope: '近三年',
    purpose: 'investment',
    depth: 'standard',
    enableWebRetrieval: true,
    stopCondition: '',
  })
  const [showAdvanced, setShowAdvanced] = useState(false)
  const valid = draft.researchQuestion.trim().length >= 10
  const set = <K extends keyof ResearchGenerationDraft>(key: K, value: ResearchGenerationDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  return (
    <DialogFrame title="新建产业研究" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (valid) onSubmit(draft)
        }}
        className="space-y-3"
      >
        <Field label="研究问题">
          <textarea
            value={draft.researchQuestion}
            onChange={(event) => set('researchQuestion', event.target.value)}
            className="research-input min-h-28 resize-y py-2"
            maxLength={4000}
            placeholder="例如：光纤板块近期的情况和产业链关系"
          />
        </Field>

        <div className="rounded-md border border-cyan-200 bg-cyan-50 px-3 py-2 text-xs leading-5 text-cyan-800 dark:border-cyan-900 dark:bg-cyan-950/20 dark:text-cyan-300">
          你只需提出研究问题。系统会先做受控检索（本地资讯 + 外网/官方源），再按已配置 AI 与内置研究框架生成草稿。
          AI API Key 负责生成；未配置增强搜索时仍可研究，但通常是弱检索。
        </div>

        <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={draft.enableWebRetrieval}
            onChange={(event) => set('enableWebRetrieval', event.target.checked)}
          />
          自动联网收集公开资料
        </label>

        {draft.enableWebRetrieval && (
          <ResearchWebSearchConfigPanel variant="compact" />
        )}

        <button
          type="button"
          onClick={() => setShowAdvanced((value) => !value)}
          className="text-xs text-cyan-700 hover:underline dark:text-cyan-300"
        >
          {showAdvanced ? '收起研究范围' : '补充研究范围（可选）'}
        </button>

        {showAdvanced && (
          <div className="space-y-3 rounded-md border border-slate-200 p-3 dark:border-slate-700">
            <p className="text-[11px] leading-5 text-slate-400">这些范围都可选。不填时，系统会根据研究问题自动推断。</p>
            <Field label="项目标题（可选）">
              <input value={draft.title} onChange={(event) => set('title', event.target.value)} className="research-input" maxLength={200} placeholder="不填则用研究问题生成标题" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="产业（可选）">
                <input value={draft.industryName} onChange={(event) => set('industryName', event.target.value)} className="research-input" maxLength={120} placeholder="如：光通信" />
              </Field>
              <Field label="产品范围（可选）">
                <input value={draft.productScope} onChange={(event) => set('productScope', event.target.value)} className="research-input" maxLength={500} placeholder="如：光纤光缆" />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="区域范围（可选）">
                <input value={draft.regionScope} onChange={(event) => set('regionScope', event.target.value)} className="research-input" maxLength={200} />
              </Field>
              <Field label="时间范围（可选）">
                <input value={draft.timeScope} onChange={(event) => set('timeScope', event.target.value)} className="research-input" maxLength={200} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="研究目的">
                <select value={draft.purpose} onChange={(event) => set('purpose', event.target.value as ResearchGenerationDraft['purpose'])} className="research-input">
                  <option value="investment">投资研究</option>
                  <option value="strategy">战略研究</option>
                  <option value="learning">知识学习</option>
                </select>
              </Field>
              <Field label="研究深度">
                <select value={draft.depth} onChange={(event) => set('depth', event.target.value as ResearchGenerationDraft['depth'])} className="research-input">
                  <option value="quick">快速</option>
                  <option value="standard">标准</option>
                  <option value="deep">深度</option>
                </select>
              </Field>
            </div>
            <Field label="停止条件（可选）">
              <textarea value={draft.stopCondition} onChange={(event) => set('stopCondition', event.target.value)} className="research-input min-h-16 resize-y py-2" maxLength={1000} placeholder="例如：关键成本与需求假设都有可反证指标" />
            </Field>
          </div>
        )}

        {error && <div className="text-xs text-red-600 dark:text-red-300">{error}</div>}
        <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-3 dark:border-slate-800">
          <button type="button" onClick={onOpenBlank} className="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-200">
            高级：创建空白项目
          </button>
          <DialogActions saving={saving} valid={valid} onClose={onClose} submitLabel={saving ? '启动中' : '开始研究'} />
        </div>
      </form>
    </DialogFrame>
  )
}