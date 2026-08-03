import { useState } from 'react'
import { useAppStore } from '../../../store/appStore'
import type { ConditionBlock, ConditionBlockType, ConditionGroup } from '../../../../electron/main/services/conditionBlocks/types'
import type { StrategyLabMatchRow, StrategyLabView } from './strategyLabModel'
import { buildInsightItems } from './strategyLabModel'
import { summarizeConditionBlock, summarizeConditionGroup } from './strategyRuleModel'

type InsightTab = 'evidence' | 'rule' | 'gaps'

const INSIGHT_TABS: Array<{ id: InsightTab; label: string }> = [
  { id: 'evidence', label: '证据链' },
  { id: 'rule', label: '规则解释' },
  { id: 'gaps', label: '验证缺口' },
]

interface StrategyInsightPanelProps {
  activeView: StrategyLabView
  match?: StrategyLabMatchRow | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map(item => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)
}

function formatNumber(value: number, digits = 2): string {
  return value.toFixed(digits).replace(/\.00$/, '')
}

function formatPct(value: number | null): string | null {
  if (value === null) return null
  return `${value >= 0 ? '上涨' : '下跌'} ${formatNumber(Math.abs(value))}%`
}

function formatPrimitiveValue(value: unknown): string {
  if (typeof value === 'number') return formatNumber(value)
  if (typeof value === 'boolean') return value ? '是' : '否'
  return String(value)
}

function formatTradeDate(tradeDate: string): string {
  if (/^\d{8}$/.test(tradeDate)) {
    return `${tradeDate.slice(0, 4)}-${tradeDate.slice(4, 6)}-${tradeDate.slice(6, 8)}`
  }
  return tradeDate
}

function formatMatchedSource(match: StrategyLabMatchRow): string {
  if (match.matchedFrom === 'screener' || match.source === 'screener') return '个性选股白盒'
  if (match.matchedFrom === 'conditionBlock.intraday_amount_surge_hold') return '条件积木 · 盘中放量拉升后站稳'
  if (match.matchedFrom.startsWith('conditionBlock.') || match.source === 'conditionBlocks') return '条件积木 · 分钟形态验证'
  return '策略命中证据'
}

function buildMatchSubtitle(match: StrategyLabMatchRow): string {
  return `${formatMatchedSource(match)} · 交易日 ${formatTradeDate(match.tradeDate)}`
}

function tabButtonClass(active: boolean): string {
  if (active) return 'min-h-8 rounded-md bg-teal-700 px-3 font-semibold text-white hover:bg-teal-800 focus:outline-none focus:ring-2 focus:ring-teal-500/30'
  return 'min-h-8 rounded-md border border-slate-200 px-3 font-medium text-slate-600 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-teal-500/30 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
}

function buildRuleRows(match: StrategyLabMatchRow | null | undefined, activeView: StrategyLabView): Array<[string, string]> {
  if (!match) return buildInsightItems(activeView).map(item => [item.title, item.body])
  if (match.source === 'conditionBlocks') {
    try {
      const evidence = JSON.parse(match.evidenceJson) as Record<string, unknown>
      const snapshot = isRecord(evidence.templateSnapshot) ? evidence.templateSnapshot : null
      const root = snapshot && isRecord(snapshot.root) ? snapshot.root as unknown as ConditionGroup : null
      const version = asNumber(evidence.templateVersion)
      if (root) {
        return [
          ['执行规则', summarizeConditionGroup(root)],
          ['执行模式', `${evidence.executionMode === 'score' ? '评分模式' : '严格模式'}${version !== null ? `，模板版本 v${version}` : ''}。本次结果使用运行时保存的规则快照，不读取后来修改的阈值。`],
          ['分数含义', `统一得分为 ${formatNumber(match.score)}。严格模式以组合逻辑为准；评分模式还要求总分达到配置阈值，硬门槛失败时不会命中。`],
        ]
      }
    } catch {
      // Older runs fall back to the compatibility explanation below.
    }
    return [
      ['策略来源', '这条命中来自条件积木分钟模板。系统先用日线条件缩小股票池, 再检查分钟数据是否完整, 最后用盘中形态条件判断是否入选。'],
      ['核心规则', '当前模板重点看盘中是否出现放量拉升, 以及拉升后价格能否保持住, 避免只因为一瞬间冲高就被误判为有效机会。'],
      ['分数含义', `统一得分为 ${formatNumber(match.score)}。分数越高, 说明分钟形态、数据完整度和站稳表现越接近当前模板要求。`],
    ]
  }
  if (match.source === 'screener') {
    return [
      ['策略来源', '这条命中来自个性选股白盒模板。系统按日线趋势、量能、MACD、换手和资金等维度逐项打分, 再把候选股排进统一命中表。'],
      ['核心规则', '白盒模板不是黑箱推荐, 它更像一组可解释的筛选条件: 命中条件越多、综合排名越靠前, 说明它越符合当前短线扫描口径。'],
      ['分数含义', `统一得分为 ${formatNumber(match.score)}。它用于在本次候选股之间排序, 不是买卖评级, 还需要结合走势图和后续验证。`],
    ]
  }
  return [
    ['策略来源', '这条命中来自自定义策略或草稿复制后的规则。系统只展示当前已落库的命中证据, 不额外推断未配置的条件。'],
    ['分数含义', `统一得分为 ${formatNumber(match.score)}。它用于比较同一轮策略命中的相对强弱, 需要结合具体证据继续判断。`],
  ]
}

function buildGapRows(match: StrategyLabMatchRow | null | undefined): Array<[string, string]> {
  if (!match) {
    return [
      ['等待命中', '先运行策略并在统一命中表点击“证据”, 这里会列出还需要补看的验证点。'],
      ['验证方向', '通常需要继续确认走势、成交量、题材持续性和数据完整度。'],
    ]
  }
  if (match.source === 'conditionBlocks') {
    return [
      ['分钟覆盖', '先确认命中日的分钟数据是否完整。分钟数据缺口会影响盘中放量、回撤和站稳比例等判断。'],
      ['量能持续性', '继续观察拉升后的成交量是否保持, 如果只是单根分钟线突然放大, 需要谨慎看待。'],
      ['形态验证', '打开走势图复核拉升后是否横住、回撤是否可控, 不要只看统一分数。'],
      ['回测确认', '加入回测后看类似条件在历史区间里的胜率、平均收益和回撤, 再决定是否纳入常用策略。'],
    ]
  }
  return [
    ['走势确认', '打开走势图检查日线位置、当日涨跌和量能变化, 避免只依据排名分判断。'],
    ['题材延续', '查看相关题材是否仍有市场关注, 以及同题材个股是否形成联动。'],
    ['风险排查', '结合筹码、换手和近期涨幅判断是否存在追高风险。'],
    ['回测确认', '加入回测后看当前白盒条件在历史样本中的表现, 用数据验证策略是否稳定。'],
  ]
}

interface ConditionEvidenceRecord {
  blockId?: string
  type?: ConditionBlockType
  name?: string
  passed?: boolean
  weight?: number
  contribution?: number
  params?: Record<string, number | string | boolean>
  hardRequired?: boolean
  dataStatus?: string
  message?: string
  evidence?: Record<string, unknown>
}

function conditionActualText(type: ConditionBlockType | undefined, evidence: Record<string, unknown> | undefined): string {
  if (!evidence) return '没有可用实际值'
  const value = (key: string) => asNumber(evidence[key])
  const percent = (key: string) => value(key) === null ? null : `${formatNumber(value(key)!)}%`
  if (type === 'minute_window_gain') return percent('gainPct') ? `实际窗口涨幅 ${percent('gainPct')}` : '窗口涨幅不可用'
  if (type === 'minute_window_amount_ratio') return value('ratio') !== null ? `实际成交额放大 ${formatNumber(value('ratio')!)} 倍` : '成交额倍数不可用'
  if (type === 'minute_window_volume_ratio') return value('ratio') !== null ? `实际成交量放大 ${formatNumber(value('ratio')!)} 倍` : '成交量倍数不可用'
  if (type === 'pullback_after_high') return percent('maxPullbackPct') ? `实际最大回撤 ${percent('maxPullbackPct')}` : '回撤数据不可用'
  if (type === 'hold_above_gain_ratio') return percent('holdRatio') ? `实际站稳比例 ${percent('holdRatio')}` : '站稳比例不可用'
  if (type === 'close_retention') return percent('retentionPct') ? `实际收盘保持度 ${percent('retentionPct')}` : '收盘保持度不可用'
  return '实际指标已记录'
}

function conditionThresholdText(condition: ConditionEvidenceRecord): string {
  if (!condition.type || !condition.params) return condition.name ?? '分钟条件'
  const block: ConditionBlock = {
    id: condition.blockId ?? 'evidence',
    type: condition.type,
    name: condition.name ?? '分钟条件',
    description: '',
    enabled: true,
    weight: condition.weight ?? 0,
    hardRequired: condition.hardRequired === true,
    params: condition.params,
  }
  return summarizeConditionBlock(block)
}

function parseEvidence(match: StrategyLabMatchRow | null | undefined): Array<[string, string]> {
  if (!match) return []
  try {
    const evidence = JSON.parse(match.evidenceJson) as Record<string, unknown>
    const rows: Array<[string, string]> = []
    const conditionsMet = asStringArray(evidence.conditionsMet)
    const concepts = asStringArray(evidence.concepts)
    const signalScore = asNumber(evidence.rawSignalScore ?? evidence.signalScore)
    const rankScore = asNumber(evidence.rawRankScore ?? evidence.rankScore)
    const pctChgText = formatPct(asNumber(evidence.pctChg))
    const turnoverRate = asNumber(evidence.turnoverRate)
    const close = asNumber(evidence.close)

    const flatConditions = Array.isArray(evidence.flatConditions)
      ? evidence.flatConditions.filter(isRecord) as ConditionEvidenceRecord[]
      : []
    if (flatConditions.length > 0) {
      for (const condition of flatConditions) {
        const status = condition.passed ? '通过' : '未通过'
        const hard = condition.hardRequired ? '，硬门槛' : ''
        const contribution = condition.contribution == null ? '' : `，贡献 ${formatNumber(condition.contribution)} 分`
        const quality = condition.dataStatus === 'complete' ? '数据完整' : condition.dataStatus === 'data_insufficient' ? '数据不足' : '部分数据'
        rows.push([
          `${status} · ${condition.name ?? '分钟条件'}`,
          `配置：${conditionThresholdText(condition)}。${conditionActualText(condition.type, condition.evidence)}；权重 ${formatNumber(condition.weight ?? 0)}${contribution}${hard}；${quality}。${condition.message ?? ''}`,
        ])
      }
      return rows
    }

    if (conditionsMet.length > 0) {
      rows.push([
        '触发的白盒条件',
        `已命中 ${signalScore ?? conditionsMet.length} 项条件: ${conditionsMet.slice(0, 6).join('、')}。这说明它不是只靠单一指标入选, 而是同时满足了多条短线白盒规则。`,
      ])
    } else if (signalScore !== null) {
      rows.push([
        '条件命中数',
        `共命中 ${signalScore} 项白盒条件。命中数越多, 说明这只股票越符合当前模板的基础筛选口径。`,
      ])
    }

    if (rankScore !== null) {
      rows.push([
        '综合排名分',
        `综合排名分为 ${formatNumber(rankScore)}。这个分数来自趋势、量能、资金等白盒维度的加权排序, 分数越高表示在候选股里相对更靠前。`,
      ])
    }

    if (pctChgText) {
      rows.push([
        '当日涨跌幅',
        `当日股价${pctChgText}。这代表当天盘面有相应强弱表现, 用来辅助判断短线热度, 不等同于买卖建议。`,
      ])
    }

    if (turnoverRate !== null) {
      rows.push([
        '换手活跃度',
        `换手率约 ${formatNumber(turnoverRate)}%。换手越充分, 通常说明当天交易更活跃, 也更适合结合量能和题材继续验证。`,
      ])
    }

    if (concepts.length > 0) {
      rows.push([
        '相关题材',
        `关联题材包括 ${concepts.slice(0, 5).join('、')}。题材只说明市场关注方向, 需要再结合走势和成交量确认持续性。`,
      ])
    }

    if (close !== null) {
      rows.push([
        '当前参考价',
        `当前参考价格约 ${formatNumber(close)} 元。这个价格用于还原命中当时的行情背景。`,
      ])
    }

    if (rows.length === 0) {
      const fallback = Object.entries(evidence).find(([, value]) => value !== null && value !== undefined && !Array.isArray(value) && !isRecord(value))
      if (fallback) {
        rows.push(['补充证据', `系统记录了一项辅助指标, 当前值为 ${formatPrimitiveValue(fallback[1])}。这项信息用于还原命中背景, 但需要结合规则解释一起看。`])
      }
    }

    return rows
  } catch {
    return [['原始证据', match.evidenceJson.slice(0, 120)]]
  }
}

export function StrategyInsightPanel({ activeView, match }: StrategyInsightPanelProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<InsightTab>('evidence')
  const navigateToStock = useAppStore(state => state.navigateToStock)
  const items = buildInsightItems(activeView)
  const evidenceRows = parseEvidence(match)
  const visibleRows = activeTab === 'evidence'
    ? (evidenceRows.length > 0 ? evidenceRows : items.map(item => [item.title, item.body] as [string, string]))
    : activeTab === 'rule'
      ? buildRuleRows(match, activeView)
      : buildGapRows(match)
  return (
    <div className="flex min-h-0 flex-col">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-rose-600 dark:text-rose-300">命中研判</p>
      <div className="mt-3 flex items-start justify-between gap-3 rounded-md border border-rose-100 bg-rose-50 px-3 py-3 dark:border-rose-900/40 dark:bg-rose-950/30">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{match ? `${match.stockName ?? match.tsCode} · ${match.tsCode.replace(/\.(SH|SZ|BJ)$/i, '')}` : '等待选择命中股票'}</h3>
          <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-300">{match ? buildMatchSubtitle(match) : '运行策略后点击命中表行查看证据链。'}</p>
        </div>
        <span className="font-mono text-2xl font-bold text-rose-600 dark:text-rose-300">{match ? match.score.toFixed(0) : '--'}</span>
      </div>
      <div className="mt-3 flex gap-2 text-xs">
        {INSIGHT_TABS.map(tab => (
          <button key={tab.id} type="button" onClick={() => setActiveTab(tab.id)} className={tabButtonClass(activeTab === tab.id)}>{tab.label}</button>
        ))}
      </div>
      <div className="mt-3 space-y-2">
        {visibleRows.slice(0, 8).map(([title, body], idx) => (
          <article key={title} className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/50">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-[11px] font-bold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200">{idx + 1}</span>
              <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100">{title}</h4>
            </div>
            <p className="mt-1 pl-7 text-xs leading-5 text-slate-600 dark:text-slate-300">{body}</p>
          </article>
        ))}
      </div>
      {match && <button type="button" onClick={() => navigateToStock(match.tsCode, match.stockName ?? undefined)} className="mt-3 min-h-10 w-full rounded-md bg-teal-700 px-3 text-xs font-semibold text-white hover:bg-teal-800 focus:outline-none focus:ring-2 focus:ring-teal-500/30">打开走势图</button>}
    </div>
  )
}
