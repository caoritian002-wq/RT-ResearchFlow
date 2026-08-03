# 策略实验室组件

## 模块功能

策略实验室用于承接 FR-225 的融合工作台, 将个性选股白盒模板、条件积木分钟模板和新建规则草稿收敛到同一个策略搭建入口。当前版本已接入本地策略模板表、统一运行记录、统一命中表和回测联动入口, 并将主区域修正为统一策略控制台, 不再把旧的个性选股和条件积木页面整页嵌入。

## FR-225k 可执行规则编排器

- `StrategyRuleBuilder` 与 `ConditionRuleEditor` 支持分钟条件增删、复制、启停、排序、嵌套分组以及 `AND / OR / NOT`，所有参数控件直接读取 `CONDITION_BLOCK_PARAMETER_DEFS` 的标签、单位、范围、步长和默认值。
- 用户可配置股票池、手动代码、ST/北交所排除、严格/评分模式、权重、硬门槛、总分阈值、回看交易日、扫描模式和分钟补拉上限；保存草稿与保存并运行使用同一份强类型结构。
- 条件策略在 `conditionBlocksProfile.templateSnapshot` 保存完整规则快照。运行器消费保存版本，不再固定运行 `intraday_amount_surge_hold`；内置模板只作为复制起点，用户副本不会反向覆盖内置模板。
- 严格模式按布尔组求值；评分模式只允许 `AND` 使用加权阈值，`OR/NOT` 保持逻辑方向。停用节点不参与分数或证据，缺数据不构成 `NOT` 反证，嵌套硬门槛失败不能被父组分数绕过。
- 命中表支持本地搜索、来源筛选和得分/日期/完整性排序；证据展示配置阈值、实际值、通过状态、权重、贡献、硬门槛与数据状态。宽屏使用固定侧栏，1024 等窄屏使用可关闭的右侧证据抽屉。
- 手动代码只保存证券代码，扫描时优先从 `stock_basic_cache`、其次从 `stock_info` 补齐公司名称。页面刷新只读本地 run/match，只有“运行扫描”或“保存并运行”启动真实计算。
- `StrategyRuleBuilder` 通过通用 `RightDrawer` 以全窗口模态层覆盖在工作台右侧，打开配置不改变策略库、命中表、研判栏的宽度和滚动位置。抽屉占满视口高度、覆盖Electron标题栏并使用50%暗色蒙层隔离背景，支持焦点约束与恢复、背景滚动锁定、拖动调宽、Esc和减少动态效果；未保存修改与删除策略统一使用项目内 `StrategyConfirmDialog`，默认保留编辑并彻底移除原生确认框。
- 首批只交付分钟条件自由组合。通用日线 DSL 与真正“日线预筛 -> 分钟确认”两阶段组合仍属于后续批次，不在界面中伪装为已完成能力。

## 实现思路

`StrategyLab` 采用左中右三栏布局: 左侧 `StrategyTemplateLibrary` 读取 `strategyLab:listStrategies` 展示紧凑策略资产库, 中央固定为“顶部执行工具条 + KPI 指标带 + 可展开规则配置 + 统一命中表”的控制台结构, 其中统一命中表是主视觉; 右侧通过 `StrategySidePanel` 提供单一展示位, 内部用“运行计划 / 命中研判”两个 tab 承载运行路径、回测入口和选中命中的证据摘要。模板选择只改变当前策略上下文、运行口径和解释语义, 不再切换到旧子页签页面。

P2 新增 `strategy_lab_strategies` 保存内置模板和用户草稿, P3 新增 `strategy_lab_runs` 与 `strategy_lab_matches` 保存统一运行结果。统一运行只编排现有个性选股和条件积木能力, 不新增外部行情请求, 不调用 AI 自动生成规则, 不改变条件积木 DB-first 与补拉上限约束。回测联动通过写入 `short_term_signals` 的 `strategyLab.<strategyKey>` 策略键复用既有策略回测引擎。

## 主要 props/state/事件流

- `StrategyLab.initialView` 支持 `overview`、`personalScreener`、`conditionBlocks` 和 `newRule`, 用于兼容历史子页签入口。
- `activeView` 仅用于兼容历史入口和右侧语义, 不再决定中央主区域渲染旧整页组件; `selectedStrategyId` 记录当前真实策略模板。
- `StrategyLab` 启动时先读取 `strategyLab:listStrategies/listRuns`, 再按最新 `runId` 调用 `strategyLab:listMatches`; 统一命中表只展示当前 run 的结果, 避免个性选股和条件积木等不同策略运行结果混在一起。
- 中央控制台展示真实 KPI、运行按钮和统一命中表。点击“运行扫描”调用 `strategyLab:runStrategy`, 进度通过 `strategyLab:runProgress` 推送。
- 策略运行、复制、删除和回测创建等反馈统一使用右下角 toast, 不在中央结果区插入单独提示行, 避免挤占统一命中表布局。
- `StrategyTemplateLibrary` 支持复制、启停和删除用户策略。内置模板可复制和停用, 不可物理删除。
- `StrategyRuleBuilder` 支持完整分钟规则草稿，包含策略信息、股票池、条件树、参数、权重、硬门槛、扫描模式、日期范围、日线预筛上限和分钟补拉上限。
- `StrategyResultTable` 读取真实 `StrategyLabMatchRow`, 支持代码/名称搜索、来源筛选与三种真实排序; 点击行只更新当前选中命中, 点击“证据”会选中该命中并把宽屏 `StrategySidePanel` 或窄屏证据抽屉切换到“命中研判”, 由 `StrategyInsightPanel` 将对应 `evidence_json` 翻译成中文证据摘要。
- `StrategyInsightPanel` 内部的“证据链 / 规则解释 / 验证缺口”必须是真实可点击切换的内容 tab: 证据链展示命中证据, 规则解释说明当前策略如何判断, 验证缺口提示下一步需要补看的数据和风险点。
- `StrategySidePanel` 复用今日看板“复盘与持仓风险”的侧栏 tab 展示逻辑, 将 `StrategyRunPlan` 和 `StrategyInsightPanel` 收敛为同一个右侧展示位。
- `StrategyRunPlan` 以紧凑 2x2 信息块展示最近 run 的状态、日期范围、股票池和补拉预算, 并通过 `strategyLab:createBacktestFromRun` 创建回测。
- 个性选股和条件积木在策略实验室内表现为策略来源和执行引擎, 不再直接作为中央整页视图出现。
- 新建和编辑规则通过右侧配置抽屉完成；草稿状态不会被误当成可运行策略，关闭抽屉后中央命中结果保持原位。

## 特殊逻辑备忘

- 不把个性选股规则强行转换为 `ConditionBlockType`, 避免误导为已有统一 DSL。
- `personalScreener` 和 `conditionBlocks` 仍保留为历史 `shortTermActiveSubTab` 合法值, 但界面会映射为对应策略上下文, 不再显示旧整页入口。
- `custom` 或 `draft` 策略只允许保存、复制、启停和继续编辑; 后端运行服务要求 `status === 'ready'`, 防止草稿误跑到个性选股或条件积木路径。
- 条件积木策略运行复用既有 `runConditionBlockScan`, 因此完整/快速扫描、免费 5 分钟近似、取消和 DB-first 语义都由原引擎保证。
- 个性选股策略运行复用 `runScreener`, 白盒引擎原始 `signalScore` 是命中条件数量、`rankScore` 是权重累加值, 不是百分制; 策略实验室按 `signalScore` 做最低命中过滤, 再把 `rankScore` 归一成统一命中表的百分制展示分, 不改变白盒规则和排序口径。
- 个性选股运行入口会再次兜底迁移内置模板, 并将旧草稿中误用的百分制 `minScore > 6` 按白盒条件数量口径降级为 `1`; 主进程会输出 `[StrategyLab:ScreenerRun]` 诊断日志, 用于核对扫描样本数、白盒候选数、最高信号分和最终命中数。
- `StrategyInsightPanel` 不允许直接把 `rawRankScore`、`rawSignalScore`、`pctChg` 等开发字段名暴露给用户, 也不能展示 `conditionBlock.*` 这类内部策略键; 展示层需要翻译为“综合排名分”“条件命中数”“盘中放量拉升后站稳”等中文解释, 并说明这些证据如何支持命中判断。
- 回测联动不新增 `StrategyBacktestSignalSource`, 而是把统一命中写入 `short_term_signals` 后使用 `shortTerm` 信号源回测, 避免扩大回测引擎枚举和撮合边界。
- 顶部二级 Flyout 使用 `SHORT_TERM_SUB_TABS`, 因此策略实验室入口和旧值兼容逻辑需要同时维护。
