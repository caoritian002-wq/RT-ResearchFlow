/**
 * FR-171: 产业链传导分析设置面板
 *
 * 功能：
 *   - LLM 兜底开关（supply_chain_llm_fallback）
 *   - 分组展示内置产业链传导边列表（只读，无删除，仅展示总边数）
 */

import React, { useEffect, useState } from 'react'
import type { AppSettingsRow } from '../../../electron/main/database/types'

interface SupplyChainEdge {
  id: number
  upstreamConcept: string
  downstreamConcept: string
  relationLabel: string
  chainGroup: string
  sortOrder: number
  isEnabled: number
}

interface GroupedEdges {
  group: string
  edges: SupplyChainEdge[]
}

export function SupplyChainSettingsPanel(): React.ReactElement {
  const [settings, setSettings] = useState<AppSettingsRow | null>(null)
  const [edges, setEdges] = useState<SupplyChainEdge[]>([])
  const [groups, setGroups] = useState<string[]>([])
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      window.api.settings.get(),
      window.api.supplyChain.getEdges(),
      window.api.supplyChain.getChainGroups(),
    ]).then(([settingsRes, edgesRes, groupsRes]) => {
      if (settingsRes) setSettings(settingsRes as AppSettingsRow)
      if (edgesRes?.ok) setEdges((edgesRes.data ?? []) as SupplyChainEdge[])
      if (groupsRes?.ok) setGroups((groupsRes.data ?? []) as string[])
    }).catch(err => {
      setError(String(err))
    }).finally(() => {
      setLoading(false)
    })
  }, [])

  const handleToggleLlm = async (enabled: boolean): Promise<void> => {
    setSaving(true)
    try {
      await window.api.settings.update({ supply_chain_llm_fallback: enabled ? 1 : 0 })
      setSettings(prev => prev ? { ...prev, supply_chain_llm_fallback: enabled ? 1 : 0 } : prev)
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  const toggleGroup = (group: string): void => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }

  const grouped: GroupedEdges[] = groups.map(g => ({
    group: g,
    edges: edges.filter(e => e.chainGroup === g),
  }))

  const enabledCount = edges.filter(e => e.isEnabled === 1).length

  if (loading) {
    return <p className="text-sm text-gray-500 dark:text-gray-400 py-2">加载中…</p>
  }

  if (error) {
    return <p className="text-sm text-red-500 py-2">{error}</p>
  }

  return (
    <div className="space-y-5">
      {/* LLM 兜底开关 */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-gray-800 dark:text-gray-200">启用 LLM 兜底匹配</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            本地关键词未命中时，调用 AI 大模型识别文本涉及的产业链概念（消耗 AI 积分）
          </p>
        </div>
        <button
          type="button"
          disabled={saving}
          onClick={() => void handleToggleLlm(!(settings?.supply_chain_llm_fallback === 1))}
          className={[
            'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent',
            'transition-colors duration-200 focus:outline-none disabled:opacity-50',
            settings?.supply_chain_llm_fallback === 1
              ? 'bg-teal-600'
              : 'bg-gray-300 dark:bg-gray-600'
          ].join(' ')}
          aria-label="LLM 兜底开关"
        >
          <span
            className={[
              'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow',
              'transition duration-200 ease-in-out',
              settings?.supply_chain_llm_fallback === 1 ? 'translate-x-5' : 'translate-x-0'
            ].join(' ')}
          />
        </button>
      </div>

      {/* 传导边统计 */}
      <div className="text-sm text-gray-500 dark:text-gray-400">
        内置传导关系：共 <span className="font-medium text-gray-800 dark:text-gray-200">{edges.length}</span> 条，
        启用 <span className="font-medium text-teal-600 dark:text-teal-400">{enabledCount}</span> 条，
        覆盖 {groups.length} 个产业链组
      </div>

      {/* 分组边列表（可折叠）*/}
      <div className="space-y-2">
        {grouped.map(({ group, edges: grpEdges }) => (
          <div key={group} className="border border-gray-200 dark:border-gray-700 rounded-md overflow-hidden">
            <button
              type="button"
              className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 text-left"
              onClick={() => toggleGroup(group)}
            >
              <span>{group}</span>
              <span className="text-xs text-gray-400 flex items-center gap-2">
                {grpEdges.length} 条边
                <span>{expandedGroups.has(group) ? '▾' : '▸'}</span>
              </span>
            </button>
            {expandedGroups.has(group) && (
              <ul className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {grpEdges.map(edge => (
                  <li
                    key={edge.id}
                    className={[
                      'flex items-center gap-2 px-3 py-1.5 text-xs',
                      edge.isEnabled === 1
                        ? 'text-gray-700 dark:text-gray-300'
                        : 'text-gray-400 dark:text-gray-500 line-through'
                    ].join(' ')}
                  >
                    <span className="font-medium">{edge.upstreamConcept}</span>
                    <span className="text-gray-400 dark:text-gray-500">—{edge.relationLabel}→</span>
                    <span className="font-medium">{edge.downstreamConcept}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
