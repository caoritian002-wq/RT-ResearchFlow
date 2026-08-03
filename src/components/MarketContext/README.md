# MarketContext 组件说明

## 模块功能

`MarketContext` 承载 FR-221 的市场环境能力, 用于展示上证、深成、创业板等指数和行业强弱背景。指数行情获取已抽为共享 hook, 供 App 壳层状态栏和 `MarketContextWidget` 同时复用。

## 实现思路

`useMarketIndexQuotes` 通过 `datasource.getIntradayData` 拉取三大指数分时数据, 每 60 秒刷新一次, 并返回最新更新时间。`MarketContextWidget` 复用该 hook, 同时读取 Zustand 中已有的 `heatmapSnapshot` 计算行业上涨/下跌数量、最强和最弱行业。组件保留 `card`、`panel`、`floating` 三种形态, 但今日看板不再使用悬浮球, 指数摘要由 App 状态栏承载。

## 主要 props/state/事件流

- `variant='card'`: 保留给空间充足的局部摘要, 当前今日看板不使用。
- `variant='panel'`: 保留给未来独立详情页, 当前大盘云图不使用。
- `variant='floating'`: 大盘云图和其它需要不占画布空间的页面使用的悬浮球形态, 默认收起, 点击后展开指数信息浮层。
- `useMarketIndexQuotes`: 共享指数行情 hook, App 壳层状态栏和 `MarketContextWidget` 均应复用它, 不要在新组件里重复实现三大指数请求逻辑。
- `quotes`: 来自 `useMarketIndexQuotes`, 每 60 秒刷新一次三大指数。
- `heatmapSnapshot`: 来自 `useAppStore`, 用于派生行业热度背景。

## 视觉与交互规范

- 悬浮球采用“市场罗盘”形态: 右下角 56px 圆形入口, 内部使用趋势线 SVG, 不使用 emoji。
- 悬浮球外环颜色由三大指数平均涨跌派生: 上涨偏红, 下跌偏绿, 中性偏灰。
- 点击后以 180ms 左右的 `opacity + translate + scale` 展开指数浮层, 不改变页面布局。
- 展开浮层以三大指数为主, 行业上涨/下跌和强弱线索为辅助信息。
- 悬浮入口必须保留 `aria-label`、`aria-expanded` 和可见 focus ring。

## 特殊逻辑备忘

- 市场环境只解释背景, 不输出交易建议。
- 今日看板中的市场环境不能压过行动队列、处理工作区和精筛条件, 因此只使用 App 壳层状态栏中的指数胶囊, 不在页面内部渲染悬浮球。
- 大盘云图本身依赖大色块表达行业状态, 市场环境不能用顶部面板挤占云图画布, 因此也使用悬浮球。
- 组件会调用 `initHeatmapPolling()` 确保行业快照可用; 这复用现有云图状态, 不新增 IPC。