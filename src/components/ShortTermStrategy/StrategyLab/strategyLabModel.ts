export type StrategyLabView = 'overview' | 'personalScreener' | 'conditionBlocks' | 'newRule'

export type StrategyTemplateSource = 'screener' | 'conditionBlocks' | 'custom' | 'builder'
export type StrategyLabStrategyStatus = 'draft' | 'ready' | 'disabled'
export type StrategyLabRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface StrategyTemplateCard {
  id: StrategyLabView
  strategyId?: number
  strategyKey?: string
  source: StrategyTemplateSource
  name: string
  subtitle: string
  description: string
  tags: string[]
  status: StrategyLabStrategyStatus | 'planned'
  enabled?: boolean
  isBuiltin?: boolean
  lastRunAt?: number | null
}

export interface StrategyLabStrategySummary {
  id: number
  strategyKey: string
  name: string
  description: string | null
  source: 'screener' | 'conditionBlocks' | 'custom'
  status: StrategyLabStrategyStatus
  enabled: boolean
  isBuiltin: boolean
  version: number
  lastRunAt: number | null
  updatedAt: number
}

export interface StrategyLabRunRow {
  id: number
  strategyId: number
  strategyKey: string
  strategyName: string
  source: 'screener' | 'conditionBlocks' | 'custom'
  status: StrategyLabRunStatus
  dateStart: string | null
  dateEnd: string | null
  runConfigJson: string
  summaryJson: string | null
  errorMessage: string | null
  backtestRunId: number | null
  createdAt: number
  startedAt: number | null
  completedAt: number | null
}

export interface StrategyLabMatchRow {
  id: number
  runId: number
  strategyId: number
  strategyKey: string
  source: 'screener' | 'conditionBlocks' | 'custom'
  tsCode: string
  stockName: string | null
  tradeDate: string
  score: number
  signalStrength: number | null
  matchedFrom: string
  evidenceJson: string
  actionJson: string | null
  createdAt: number
}

export interface StrategyLabRunSummary {
  totalStocks?: number
  matchedCount?: number
  dateStart?: string | null
  dateEnd?: string | null
  source?: string
  engine?: string
  coverage?: Record<string, unknown>
}

export interface StrategyRunPlanItem {
  label: string
  value: string
  tone?: 'default' | 'warning' | 'success'
}

export interface StrategyInsightItem {
  title: string
  body: string
}

export const STRATEGY_TEMPLATES: StrategyTemplateCard[] = [
  {
    id: 'personalScreener',
    source: 'screener',
    name: '个性选股白盒模板',
    subtitle: '日线 / 盘中截面',
    description: '沿用天使魔鬼金叉、量能、MACD、换手和资金维度, 适合快速扫描今日强势候选。',
    tags: ['排序分', '资金维度', 'AI 解读'],
    status: 'ready',
  },
  {
    id: 'conditionBlocks',
    source: 'conditionBlocks',
    name: '条件积木分钟模板',
    subtitle: '分钟形态 / 历史扫描',
    description: '沿用盘中放量拉升后站稳等模板, 通过日线预筛、分钟覆盖和条件证据验证形态。',
    tags: ['分钟覆盖', '扫描漏斗', '命中证据'],
    status: 'ready',
  },
  {
    id: 'newRule',
    source: 'builder',
    name: '新建规则',
    subtitle: '从空白或模板复制',
    description: '按股票池、截面条件、分钟条件、排序评分和执行计划分层搭建后续策略。',
    tags: ['规则草稿', '模板复制', '后续扩展'],
    status: 'draft',
  },
]

export function sourceLabel(source: StrategyTemplateSource): string {
  if (source === 'screener') return '个性选股'
  if (source === 'conditionBlocks') return '条件积木'
  if (source === 'custom') return '自定义规则'
  return '规则搭建'
}

export function strategyToTemplate(strategy: StrategyLabStrategySummary): StrategyTemplateCard {
  return {
    id: strategy.source === 'screener' ? 'personalScreener' : strategy.source === 'conditionBlocks' ? 'conditionBlocks' : 'newRule',
    strategyId: strategy.id,
    strategyKey: strategy.strategyKey,
    source: strategy.source,
    name: strategy.name,
    subtitle: `${sourceLabel(strategy.source)} / v${strategy.version}`,
    description: strategy.description ?? '暂无策略说明。',
    tags: [strategy.isBuiltin ? '内置模板' : '用户策略', strategy.enabled ? '已启用' : '已停用', strategy.lastRunAt ? '有运行记录' : '未运行'],
    status: strategy.status,
    enabled: strategy.enabled,
    isBuiltin: strategy.isBuiltin,
    lastRunAt: strategy.lastRunAt,
  }
}

export function parseRunSummary(run?: StrategyLabRunRow | null): StrategyLabRunSummary | null {
  if (!run?.summaryJson) return null
  try {
    return JSON.parse(run.summaryJson) as StrategyLabRunSummary
  } catch {
    return null
  }
}

export function viewTitle(view: StrategyLabView): string {
  if (view === 'personalScreener') return '个性选股白盒扫描'
  if (view === 'conditionBlocks') return '条件积木分钟扫描'
  if (view === 'newRule') return '新建规则草稿'
  return '策略实验室总览'
}

export function buildRunPlan(view: StrategyLabView): StrategyRunPlanItem[] {
  if (view === 'personalScreener') {
    return [
      { label: '策略角色', value: '日线白盒预筛引擎', tone: 'success' },
      { label: '数据路径', value: '日线缓存 + 盘中 rt_k 注入' },
      { label: '评分方式', value: 'rankScore / signalScore / tieBreaker 汇总' },
      { label: '结果去向', value: '统一命中表 -> 证据研判 -> 回测信号' },
    ]
  }
  if (view === 'conditionBlocks') {
    return [
      { label: '策略角色', value: '分钟条件确认引擎', tone: 'success' },
      { label: '数据路径', value: '日线候选 -> 分钟覆盖 -> 条件求值' },
      { label: '扫描语义', value: '完整扫描区分未评估与无命中' },
      { label: '结果去向', value: '命中证据 -> short_term_signals -> 回测' },
    ]
  }
  if (view === 'newRule') {
    return [
      { label: '策略角色', value: '草稿策略搭建器', tone: 'warning' },
      { label: '可选起点', value: '空白策略 / 白盒预筛 / 分钟模板复制' },
      { label: '可配置层级', value: '股票池 / 截面 / 分钟 / 排序 / 执行' },
      { label: '运行边界', value: '草稿不可运行, 保存后再复制为可用模板', tone: 'warning' },
    ]
  }
  return [
    { label: '融合对象', value: '个性选股 + 条件积木', tone: 'success' },
    { label: '搭建路径', value: '选模板 -> 新建规则 -> 运行 -> 研判 -> 回测' },
    { label: 'P1 边界', value: '前端聚合, 不新增 IPC / DB / 依赖' },
    { label: '目标参考', value: 'strategy-lab-fusion-demo.png' },
  ]
}

export function buildInsightItems(view: StrategyLabView): StrategyInsightItem[] {
  if (view === 'personalScreener') {
    return [
      { title: '当前解释重点', body: '它是策略实验室里的日线预筛层, 负责把全市场压缩成可研判候选, 不再作为独立页面存在。' },
      { title: '命中先看什么', body: '先看排序分、信号强度、资金净流入和条件贡献, 再决定是否用分钟形态或走势图验证。' },
      { title: '组合方式', body: '白盒预筛可以作为两阶段策略的第一步, 后面接条件积木的分钟确认。' },
    ]
  }
  if (view === 'conditionBlocks') {
    return [
      { title: '当前解释重点', body: '它是策略实验室里的分钟确认层, 用窗口证据验证候选是否真的形成盘中形态。' },
      { title: '命中先看什么', body: '先看命中窗口、条件得分、分钟覆盖和失败条件, 再决定是否沉淀为回测信号。' },
      { title: '组合方式', body: '分钟确认可以单独运行, 也可以接在白盒预筛之后形成两阶段策略。' },
    ]
  }
  if (view === 'newRule') {
    return [
      { title: '搭建重点', body: '规则从股票池、截面条件、分钟条件、排序评分和结果动作逐层形成, 避免回到旧 Tab 心智。' },
      { title: '运行边界', body: '草稿策略只保存配置, 不直接运行; 需要复制或补齐后成为 ready 策略。' },
      { title: '后续沉淀', body: '保存后的策略进入同一模板库, 运行结果仍进入统一命中表。' },
    ]
  }
  return [
    { title: '融合判断', body: '个性选股是固定白盒策略模板, 条件积木是可配置分钟模板, 两者在策略实验室中共享运行、结果和研判路径。' },
    { title: '主工作流', body: '先选模板或新建规则, 再运行扫描, 中央看命中, 右侧看计划和证据, 最后进入回测或沉淀策略。' },
    { title: '实现边界', body: 'P1 聚合现有能力并明确搭建路径, 后端统一策略引擎留给后续阶段。' },
  ]
}