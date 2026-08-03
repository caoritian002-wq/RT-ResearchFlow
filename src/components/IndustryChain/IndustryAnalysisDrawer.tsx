/**
 * FR-172: 统一产业分析抽屉
 *
 * 整合 FR-170（产业链图谱）与 FR-171（产业链传导分析）两个功能，
 * 以双 Tab 右侧抽屉形式呈现，默认展示"传导分析" Tab。
 *
 * 两个 Tab 内容同时挂载（CSS display:none 切换），保留各自内部 React 状态。
 */

import { useState } from 'react'
import { SupplyChainContent } from '../SupplyChain/SupplyChainModal'
import { IndustryChainContent } from './IndustryChainDrawer'

export interface IndustryAnalysisDrawerProps {
  open: boolean
  onClose: () => void
  /** 传导分析文本（传入后立即触发分析） */
  text: string
  /** 产业链 Tab 默认选中的链 id（AI 文本匹配结果） */
  defaultChainId?: string
}

export default function IndustryAnalysisDrawer({
  open,
  onClose,
  text,
  defaultChainId,
}: IndustryAnalysisDrawerProps) {
  const [activeTab, setActiveTab] = useState<'supply' | 'chain'>('supply')

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[9999]">
      {/* 半透明遮罩 */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* 抽屉主体 */}
      <div
        className="absolute right-0 top-0 bottom-0 w-[85vw] max-w-[1400px] min-w-[700px] bg-white dark:bg-gray-900 flex flex-col shadow-2xl"
        style={{ animation: 'slideInFromRight 0.25s cubic-bezier(0.4,0,0.2,1)' }}
      >
        {/* 顶部工具栏 */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <span className="text-sm font-semibold text-gray-700 dark:text-gray-200 whitespace-nowrap">
            🔗 产业分析
          </span>

          {/* Tab 切换 */}
          <div className="flex gap-1 ml-1">
            <button
              type="button"
              className={`text-xs px-3 py-1 rounded-full transition-colors whitespace-nowrap ${
                activeTab === 'supply'
                  ? 'bg-teal-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
              }`}
              onClick={() => setActiveTab('supply')}
            >
              传导分析
            </button>
            <button
              type="button"
              className={`text-xs px-3 py-1 rounded-full transition-colors whitespace-nowrap ${
                activeTab === 'chain'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
              }`}
              onClick={() => setActiveTab('chain')}
            >
              产业链
            </button>
          </div>

          <button
            type="button"
            className="ml-auto text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none shrink-0 px-1"
            onClick={onClose}
            title="关闭"
          >
            ×
          </button>
        </div>

        {/* 内容区：两个 Tab 同时挂载，CSS 控制显隐（保留各自内部状态）*/}
        <div className={activeTab === 'supply' ? 'flex flex-1 flex-col min-h-0' : 'hidden'}>
          <SupplyChainContent text={text} onClose={onClose} />
        </div>
        <div className={activeTab === 'chain' ? 'flex flex-1 flex-col min-h-0' : 'hidden'}>
          <IndustryChainContent defaultChainId={defaultChainId} onClose={onClose} />
        </div>
      </div>
    </div>
  )
}
