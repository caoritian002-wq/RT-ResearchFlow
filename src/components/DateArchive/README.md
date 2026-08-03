# DateArchive 组件维护说明

## 模块功能

`DateArchive` 是资讯情报台左侧辅助区, 提供真实“今日重点”、来源脉冲和资讯日期归档。归档按年、月、日组织本地简报统计, 支持点击任意层级筛选对应日期范围。

## 实现思路

组件从 `useAppStore` 读取 `archiveDates`、`briefings`、`briefingSourceStats`、`selectedBriefingId`、`selectedDate` 和 `selectedSourceId`, 在渲染前将扁平日期统计聚合为年/月/日树。左侧顶部从当前页资讯队列派生高影响资讯 Top3; 来源分组使用后端按日期、影响等级和搜索条件聚合的全量来源统计, 不受中部队列分页和当前来源筛选影响。点击来源后以稳定 `sourceId` 刷新中部队列, 点击已选来源或“全部来源”清除筛选。点击重点资讯会调用 `selectBriefing(id)` 切换右侧详情。下半区将“来源分组”和“时间归档”收敛为同一个 Tab 面板, 默认展示来源分组, 切到时间归档时复用原日期树。两个 Tab 共用剩余高度并各自独立滚动, 避免纵向堆叠挤压有效内容。

## 主要 props/state/事件流

- `expandedYears`: 已展开年份集合。
- `expandedMonths`: 已展开月份集合。
- `activePanelTab`: 左侧下半区当前 Tab, 可为来源分组或时间归档。
- `highImpactBriefings`: 从当前资讯队列按影响等级、未读和评分排序得到的重点资讯。
- `briefingSourceStats`: 后端按当前筛选条件聚合的全量来源总量、未读和高影响统计。
- `sourceStats`: 完整来源统计列表, 每项包含稳定 `sourceId`; 面板内部滚动, 不截断可筛选来源。
- `selectedSourceId`: 当前来源筛选; 来源按钮通过 `aria-pressed`、青色表面和“筛选中”文字共同表达状态。
- `selectedDate`: 当前筛选日期, 可为 `null`、`YYYY`、`YYYY-MM` 或 `YYYY-MM-DD`。
- `selectedBriefingId`: 当前详情区选中的资讯, 用于左侧重点项高亮。
- 年/月/日行点击后更新全局筛选, 展开按钮只改变本地展开状态。

## 特殊逻辑备忘

选中行统一使用蓝色浅底和蓝色文字, 暗色主题使用半透明蓝底和浅蓝文字。展开按钮使用 `aria-label` 替代原生 `title`, 避免和应用自定义提示体系产生双提示。左侧栏宽度固定, 内容应保持短文本和两行标题, 防止挤压中部资讯队列。下半区不要再改回“来源分组 + 时间归档”纵向堆叠, 需要新增侧栏辅助信息时优先放入现有 Tab 或另行评估信息架构。
