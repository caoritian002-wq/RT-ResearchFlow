# Onboarding 组件说明

## 模块功能

`ColdStartGuide` 提供首次启动与冷启动引导, 帮助新用户按顺序完成 Tushare、股票基础数据、题材成分、AI 模型和今日看板初始化。

## 实现思路

引导不新增 IPC, 复用 `window.api.diagnostics.getHealth()` 获取诊断快照, 由 `onboardingModel.ts` 派生步骤、进度和下一步动作。`initializationModel.ts` 进一步派生最低可用条件和初始化闭环状态, 用于引导面板和今日看板空态保持一致。同步类动作复用 `window.api.diagnostics.runCheck()`, 配置类动作通知 `App` 打开配置中心对应页签。

FR-195 起, `initializationTaskModel.ts` 定义一键初始化任务队列, 由 `App` 在渲染进程内按顺序编排刷新诊断、同步股票基础数据、同步题材成分、补种今日看板和再次刷新诊断。FR-214 起, 队列在股票基础数据之后插入“同步全市场历史日线”, 为条件积木全市场扫描和策略回测准备近 2 年本地日线底座。任务历史只在当前渲染会话内保留, 首版不新增主进程任务队列或数据库表。

## 主要 props/state/事件流

- `snapshot`: 当前诊断快照, 由 `App` 统一加载。
- `onRefresh`: 重新拉取诊断快照。
- `onOpenConfig`: 打开配置抽屉并切到数据源或 AI 配置页。
- `onNavigate`: 完成后进入今日看板等主业务页面；导航成功触发后同步调用 `onClose`, 确保步骤内入口和底部主入口都会退出引导。
- `runningAction/message/error`: 组件内部记录当前同步动作和反馈。
- `initializationModel`: 派生 `blocked/actionRequired/syncing/usable/complete` 状态, 不要求所有缓存健康才算可用。
- `flow`: App 传入的一键初始化任务状态, 包含每个任务的状态、耗时、消息和失败原因。
- `onStartInitialization/onRetryTask`: 触发完整初始化流程或单项重试。
- `sync-historical-daily`: 全市场历史日线任务, 执行期间 App 会接收主进程进度事件并更新任务消息。

## 特殊逻辑备忘

- 引导关闭状态存储在 `localStorage` 的 `trade-watch:onboarding:v1:dismissed`, 版本号变化时可重新提示。
- 引导只展示配置状态和同步进度, 不展示 Token、API Key 或 Base URL 等敏感凭据。
- 诊断页可手动重新打开引导, 便于用户后续补齐缺失数据。
- 同步动作失败后保留最近一次错误, 并将按钮状态标记为可重试。
- 一键初始化跳过判断读取 `freshness.*` 数据项, 不使用 `sync.*` 可执行任务项作为完成依据; 股票基础数据需要达到全市场规模, 历史日线需要按交易日历计算的近 2 年目标交易日覆盖达标后才跳过。
- 关闭引导不取消当前会话中的一键初始化流程; 用户可从顶部引导入口、今日看板空态或诊断页重新查看进度。
- “进入今日看板”的步骤按钮和底部主按钮复用同一导航处理分支, 点击任一入口都会进入今日看板并持久化关闭引导。
- 历史日线初始化只补 `daily_close_cache`, 不表示全市场分钟线已存在；依赖分钟线的策略仍需在扫描摘要中查看可评估样本数量。
