# ForecastPanel 组件

## 模块功能

`ForecastPanel` 是股票走势图中的 AI 预测记录面板, 负责展示单只股票的历史预测, 多模型对比曲线, AI 预测理由, 回测摘要, 误差归因, 样本标注和统计信息。自 FR-174 起, 面板从居中弹窗改为右侧抽屉, 以减少对走势图上下文的遮挡。

## 实现思路

组件打开时通过 `window.api.ai.listForecasts(stockCode)` 获取历史记录, 再按用户勾选的记录调用 `window.api.ai.getForecast(id)` 加载预测点详情。左侧列表按 `targetDate` 分组展示, 分组内保留原有记录标题。图表区域使用 Recharts 绘制多条预测线, 已回测记录会通过 `window.api.backtest.getIntradayCache` 叠加实际分时线。

右侧抽屉外壳只负责展示形态和关闭交互, 内部仍保留原有的历史列表, 图表, AI 理由折叠项和统计 Tab。AI 理由区新增用户反馈输入框, 提交后调用 `window.api.ai.reviseTrendForecast`, 后端会基于来源预测和用户补充信息生成新的预测记录。FR-188 起, 每条记录可展示 `inputSnapshot` 输入快照摘要和 `errorAnalysis` 回测误差归因, 并允许用户通过 `window.api.backtest.updateForecastOutcome` 保存样本标签。

## 主要 props/state/事件流

- `stockCode/stockName`: 当前股票标识和展示名。
- `isOpen/onClose`: 控制抽屉显示和关闭。
- `records`: `ai:listForecasts` 返回的预测记录列表, 包含 `targetDate` 目标预测日期。
- `selectedIds`: 当前勾选参与图表对比的预测记录 id 集合。
- `details`: 已加载的预测详情缓存, key 为 forecast id。
- `openPanels`: AI 理由折叠项展开状态。
- `expandedTargetDates`: 左侧目标日期分组展开状态。
- `feedbackDrafts`: 每条预测记录的用户补充信息草稿。
- `revisionLoading/revisionErrors`: 再次预测的局部提交状态和错误提示。
- `outcomeDrafts`: 每条预测记录的样本标签和备注草稿。
- `outcomeSaving/outcomeMessages`: 样本标签保存状态和局部提示。
- `statsTypeFilter/statsPortfolioOnly`: 统计 Tab 的预测类型和仅持仓筛选。

事件流:

1. 打开抽屉后加载配置和预测列表, 按目标日期分组, 默认展开最新分组并选中最新记录。
2. 勾选记录时加载详情并更新多线图。
3. 删除记录或全部删除后同步更新列表、选中项和详情缓存。
4. 在 AI 理由区输入补充信息并点击「再次预测」后, 调用 `ai:reviseTrendForecast`。
5. 再次预测成功后刷新列表, 默认选中新生成的记录, 并展开对应 AI 理由项。
6. 回测完成的记录展示误差归因标签; 用户可为任意记录保存有效样本、无效样本或待复盘标签。

## 特殊逻辑备忘

- `ai:listForecasts` 返回的 `points` 是 JSON 字符串, `ai:getForecast` 返回的 `points` 是已解析数组。
- `targetDate` 是预测目标交易日, 用于分组和读取实际分时回测数据; 旧记录缺失时前端会按 `type + createdAt` 兜底推导。
- `parentForecastId` 非空的记录会显示「修正」标签, `userFeedback` 会在 AI 理由区域单独展示。
- `inputSnapshot` 只展示非敏感输入摘要, 包括数据来源、分时点数、日线点数、上下文字数和预测点数; 不展示 API Key 或 Base URL。
- `errorAnalysis` 是回测服务写入的 JSON 字符串, 标签映射在组件内维护, 未识别标签按原始字符串展示。
- 样本标签保存后会同步更新本地 `records/details`, 不强制重新拉取列表。
- 统计 Tab 支持当前股票、预测类型和仅持仓筛选, 样本条数少于 5 条时提示“样本偏少”。
- 再次预测不会覆盖来源记录, 只生成新记录; 清理数量仍受 `maxForecastsPerStock` 控制。
- 该抽屉同时由股票走势图和持仓仪表盘复用, 因此组件内部不依赖具体父页面路由。
- 抽屉遮罩点击关闭, 主体区域点击不会冒泡关闭。
