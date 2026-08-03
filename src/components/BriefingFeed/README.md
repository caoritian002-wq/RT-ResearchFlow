# BriefingFeed 组件维护说明

## 模块功能

`BriefingFeed` 展示资讯情报台的中部资讯队列, 直接呈现当前筛选结果中的资讯卡片流, 并将高影响、未读和发布时间转化为队列优先级。组件支持分页、全部标为已读和单条资讯的产业链分析入口。

## 实现思路

组件从 `useAppStore` 读取当前资讯列表、分页、来源筛选和选中项。渲染前按影响等级、未读状态、AI 影响评分和发布时间排序, 中部只输出连续资讯卡片, 不再按来源渲染折叠组; 来源统计与筛选入口统一放在左侧 `DateArchive`。来源筛选生效时标题栏显示可清除的来源标签。当当前筛选结果有资讯但没有有效选中项时, 自动选中优先级最高的一条, 让右侧详情研判区同步切换到该来源文章。

## 主要 props/state/事件流

- `briefings`: 当前筛选后的资讯列表。
- `highImpactCount/queueUnreadCount`: 当前页高影响与待读统计, 展示在队列标题栏。
- `totalCount/currentPage`: 分页信息。
- `selectedBriefingId`: 当前详情区选中的资讯。
- `selectedSourceId/selectedSource`: 当前来源筛选及其稳定名称, 用于标题栏反馈与一键清除。
- `sortedBriefings`: 当前队列按影响力和时效排序后的资讯流。
- 点击资讯卡片调用 `selectBriefing(id)`。
- 点击“全部标为已读”调用 `markAllRead(selectedDate)`。
- 点击产业链分析按钮打开 `IndustryAnalysisDrawer`。

## 特殊逻辑备忘

分页按钮只在 `totalPages > 1` 时展示。产业链抽屉复用统一的 `IndustryAnalysisDrawer`, 不新增 IPC。中部队列只负责比较和选取资讯, 详情解读、正文和长动作应放在右侧 `BriefingDetail`; 不要在中部重新引入来源折叠组, 否则会削弱 Demo 中“直接情报流”的首屏效率。
