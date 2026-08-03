# SupplyChain 模块

## 功能说明

FR-171/FR-173「产业链传导分析与资讯归因」—— 在资讯浏览、AI 分析、今日看板等场景中，用户点击「⛓ 传导分析」按钮后弹出右侧抽屉，系统先将文本归因到本地产业链和受影响环节，再推荐该方向的核心候选股票，最后用 Mermaid 图谱解释上下游传导路径。

## 组件列表

### SupplyChainModal.tsx

主抽屉组件（`fixed inset-0 z-[9999]`，`slideInFromRight` 动画）。

**Props**

| 名称 | 类型 | 说明 |
|------|------|------|
| open | boolean | 是否显示 |
| text | string | 待分析文本（资讯标题+摘要或 AI 回复片段） |
| onClose | () => void | 关闭回调 |

**主要逻辑**

- mount/text 变化时调 `window.api.supplyChain.analyze(text)` 获取分析结果
- 顶部优先展示 FR-173 归因摘要：产业链、事件类型、影响方向、置信度和归因理由
- 推荐关注股票 Top 8 来自后端 `recommendedStocks`，可直接点击跳转走势图
- “建立研究”只把当前链组、命中概念、节点和关系导入产业研究，统一标记为估算种子；推荐股票不会导入为事实节点
- `buildMermaidCode()` 将结果转为 `flowchart LR` Mermaid 图（classDef: hit/upstream/downstream 着色）
- Mermaid 渲染后事件委托，解析 `g.node[id]` 的 `flowchart-{nodeId}-{n}` 格式实现节点点击
- 左侧 Mermaid 图 + 右侧 `SupplyChainNodeList`（w-80）

### SupplyChainNodeList.tsx

节点列表组件，展示命中节点和上/下游节点及其代表个股。

**Props**

| 名称 | 类型 | 说明 |
|------|------|------|
| nodes | SupplyChainNode[] | 分析结果节点数组 |
| hitConcepts | string[] | 命中的概念名称列表 |
| pendingConcept | { name: string; seq: number } \| null | 当前图中点击的节点名称和点击序号 |
| onNavigate | (code, name) => void | 点击个股时跳转走势图 |

### SupplyChainSettingsPanel.tsx

设置面板，嵌入 Settings.tsx 底部。

**功能**

- LLM 兜底开关（读写 `supply_chain_llm_fallback` 设置项）
- 分组折叠展示内置传导边列表
- 统计启用/总条数

## 主要 state / 事件流

1. 用户在 BriefingFeed / AIAnalysis / DecisionCenter 中点击「⛓ 传导分析」按钮
2. 父组件设置 `chainText` + `showChain=true` → `<SupplyChainModal>` 打开
3. Modal 调 IPC `supplyChain:analyze` → 后端 `supplyChainService.analyzeText(db, text)` 返回 `SupplyChainAnalysisResult`
4. 后端返回的 `attribution` 负责解释“消息指向哪条产业链/哪些环节”，`recommendedStocks` 负责给出龙头候选排序
5. 前端顶部展示归因摘要和推荐股票，随后生成 Mermaid 代码并渲染，用户点击节点 → 右侧列表高亮展开对应节点的代表个股
6. 用户点击个股按钮 → `navigateToStock(code, name)` 跳转走势图 + `onClose()`
7. 用户点击“建立研究” → 创建 `sourceType='supply_chain'` 的快速研究草稿 → 跳转 AI 分析下的产业研究工作台

## 特殊逻辑备忘

- Mermaid 使用 `securityLevel:'strict'`，节点点击通过事件委托解析 SVG `g.node[id]` 的 `flowchart-{nodeId}-{n}` 格式，不依赖 `loose` 模式
- 传导分析 30s TTL 缓存会包含归因版本和 LLM 开关状态，`matchedBy='none'` 的空结果不缓存
- 「传导」按钮仅在 sourceModule=news 且 priority>=4 时显示（SignalCard 中）
- LLM 兜底仅在本地节点/别名召回不足且设置开关为 1 时触发，并且只能从后端传入的本地候选链组/节点中选择
- 内置代表股数据用于“少而准”的核心标的推荐，KPL/THS/DC 题材成分作为覆盖补充
- 快速传导结果不是事实源；导入研究时严禁把 `recommendedStocks` 自动转换为公司或证券事实节点
