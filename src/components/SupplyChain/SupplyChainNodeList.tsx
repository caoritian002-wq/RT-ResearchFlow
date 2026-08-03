/**
 * FR-171: 产业链传导图谱列表面板
 *
 * 展示 BFS 展开后各节点的成员股，命中节点默认展开，非命中节点折叠。
 * 每只股票可点击跳转走势图。
 */

import React, { useEffect, useRef, useState } from 'react'
import { StockKlineChipDrawer } from '../shared/StockMiniChart'

export interface MemberStock {
  stockCode: string
  stockName: string
  hotNum: number | null
  todayChange: number | null
}

export interface SupplyChainNodeData {
  concept: string
  chainGroup: string
  distance: number
  isHit: boolean
  stocks: MemberStock[]
}

interface Props {
  nodes: SupplyChainNodeData[]
  hitConcepts: string[]
  /** 来自图中节点点击，seq 变化表示新的点击（相同节点重复点击也会切换） */
  pendingConcept: { name: string; seq: number } | null
  onNavigate: (stockCode: string, stockName: string) => void
}

function changeColor(v: number | null): string {
  if (v === null) return 'text-gray-400'
  if (v > 0) return 'text-red-500'
  if (v < 0) return 'text-green-500'
  return 'text-gray-400'
}

function formatChange(v: number | null): string {
  if (v === null) return '--'
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toFixed(2)}%`
}

function distanceLabel(distance: number): string {
  if (distance === 0) return '命中'
  if (distance < 0) return `上游${Math.abs(distance)}层`
  return `下游${distance}层`
}

function distanceBadgeColor(distance: number): string {
  if (distance === 0) return 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
  if (distance < 0) return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
  return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
}

export function SupplyChainNodeList({ nodes, hitConcepts, pendingConcept, onNavigate }: Props): React.ReactElement {
  // 命中的概念默认展开
  const [openSet, setOpenSet] = useState<Set<string>>(() => new Set(hitConcepts))
  /** 每个节点对应的 DOM 元素，用于 scrollIntoView */
  const nodeRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  /** 当前打开的个股日K与筹码峰抽屉 */
  const [clickedStock, setClickedStock] = useState<{
    tsCode: string
    stockName: string
  } | null>(null)

  function toggle(concept: string): void {
    setOpenSet(prev => {
      const next = new Set(prev)
      if (next.has(concept)) next.delete(concept)
      else next.add(concept)
      return next
    })
  }

  // 图中节点点击：已展开则折叠，已折叠则展开并滚动到可视区
  useEffect(() => {
    if (!pendingConcept) return
    const { name } = pendingConcept
    setOpenSet(prev => {
      const next = new Set(prev)
      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
        // 展开后滚动到可视范围（等下一帧 DOM 更新后再滚）
        requestAnimationFrame(() => {
          nodeRefs.current.get(name)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        })
      }
      return next
    })
  }, [pendingConcept])

  // 排序：命中节点（distance=0）在前，上游越近越靠前，下游越近越靠前
  const sorted = [...nodes].sort((a, b) => {
    if (a.isHit !== b.isHit) return a.isHit ? -1 : 1
    return Math.abs(a.distance) - Math.abs(b.distance)
  })

  return (
    <>
    <div className="flex flex-col gap-2 overflow-y-auto">
      {sorted.map(node => {
        const isOpen = openSet.has(node.concept)
        const isSelected = pendingConcept?.name === node.concept

        return (
          <div
            key={node.concept}
            ref={el => { if (el) nodeRefs.current.set(node.concept, el); else nodeRefs.current.delete(node.concept) }}
            className={`rounded-lg border transition-colors ${
              isSelected
                ? 'border-orange-400 dark:border-orange-500'
                : 'border-gray-200 dark:border-gray-700'
            }`}
          >
            {/* 节点头部 */}
            <button
              type="button"
              onClick={() => toggle(node.concept)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg"
            >
              <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${distanceBadgeColor(node.distance)}`}>
                {distanceLabel(node.distance)}
              </span>
              <span className="flex-1 font-medium text-sm text-gray-800 dark:text-gray-200 truncate">
                {node.concept}
              </span>
              {node.stocks.length > 0 && (
                <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">
                  {node.stocks.length} 只
                </span>
              )}
              <span className="text-gray-400 dark:text-gray-500 text-xs shrink-0">
                {isOpen ? '▲' : '▼'}
              </span>
            </button>

            {/* 成员股列表 */}
            {isOpen && node.stocks.length > 0 && (
              <div className="px-3 pb-2 flex flex-col gap-1">
                {node.stocks.map(s => (
                  <div
                    key={s.stockCode}
                    className="flex items-center gap-2 py-1 border-t border-gray-100 dark:border-gray-700/50 cursor-pointer rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 px-1 -mx-1 transition-colors"
                    onClick={() => {
                      setClickedStock({
                        tsCode: s.stockCode,
                        stockName: s.stockName || s.stockCode,
                      })
                    }}
                  >
                    <span className="text-xs text-gray-500 dark:text-gray-400 w-16 shrink-0 font-mono">
                      {s.stockCode.replace(/\.(SH|SZ|BJ)$/i, '')}
                    </span>
                    <span className="flex-1 text-sm text-gray-700 dark:text-gray-300 truncate">
                      {s.stockName || s.stockCode}
                    </span>
                    <span className={`text-xs shrink-0 font-medium ${changeColor(s.todayChange)}`}>
                      {formatChange(s.todayChange)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {isOpen && node.stocks.length === 0 && (
              <div className="px-3 pb-2 text-xs text-gray-400 dark:text-gray-500">
                暂无成员股数据
              </div>
            )}
          </div>
        )
      })}
    </div>

      {/* 个股近期日K与筹码峰抽屉 */}
      {clickedStock && (
        <StockKlineChipDrawer
          tsCode={clickedStock.tsCode}
          stockName={clickedStock.stockName}
          zIndex={10020}
          onClose={() => setClickedStock(null)}
          onNavigate={() => {
            onNavigate(
              clickedStock.tsCode.replace(/\.(SH|SZ|BJ)$/i, ''),
              clickedStock.stockName,
            )
            setClickedStock(null)
          }}
        />
      )}
    </>
  )
}
