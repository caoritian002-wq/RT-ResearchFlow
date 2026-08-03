# ConfigDrawer 组件说明

## 模块功能

`ConfigDrawer` 负责承载低频配置入口, 将监控源、设置、AI 配置、数据源和诊断中心从顶部主导航收纳到右侧抽屉中。开发环境下还会显示“用户层级”页签, 用于模拟免费用户和付费用户的分钟数据路由。
配置抽屉作为 RT-ResearchFlow 的低频辅助入口，支撑今日看板主工作台恢复数据源、AI 配置、诊断和初始化状态，不重新回到主导航。
FR-220 起, 主题切换和首次启动引导也收纳到配置中心: 主题进入“外观”页签, 新用户引导固定在抽屉右上角作为醒目的恢复入口。

## 实现思路

组件由遮罩层和右侧 `aside` 抽屉组成。抽屉顶部提供配置页签和“新用户引导”动作, 内容区复用现有 `SourceManager`、`Settings`、`AIConfig`、`DataSource` 组件, 并接入 `DiagnosticsPanel` 展示数据健康状态, 不改变配置模块自身业务逻辑。“外观”页签只消费 App 传入的 `theme` 与 `onToggleTheme`, 复用既有主题持久化能力。`UserTierDevPanel` 只在 `import.meta.env.DEV` 为真时挂载, 通过 localStorage 保存本地模拟层级。

## 主要 props/state/事件流

- `open`: 控制抽屉是否显示。
- `activeTab`: 当前配置页签, 可为 `sources`、`settings`、`appearance`、`ai-config`、`datasource`、`diagnostics`; 开发环境额外支持 `user-tier-dev`。
- `onTabChange`: 切换配置页签。
- `onClose`: 点击遮罩、关闭按钮或按 Esc 时触发关闭。
- `onOpenGuide`: 从配置中心右上角或诊断页重新打开首次启动引导。
- `theme`: 当前全局主题, 可为 `light` 或 `dark`。
- `onToggleTheme`: 切换全局主题, 由“外观”页签调用。

## 特殊逻辑备忘

- 配置中心按全视口抽屉处理, 外层使用 `fixed inset-0`, 遮罩和右侧面板需要覆盖标题栏与主工作区, 展示逻辑对齐历史回测等全屏抽屉。
- 因应用使用自定义 Electron 标题栏, 抽屉外层、遮罩、面板和顶部页签区都必须显式标记 `electron-no-drag`, 避免标题栏拖拽区域影响 Tab 和按钮点击命中。
- 抽屉宽度使用 `min(920px,92vw)`, 给 AI 配置表格保留横向空间, 同时兼容窄屏。
- 抽屉关闭不会修改主业务 `activeTab`, 用户回到原工作流上下文。
- 诊断页中的跳转动作会复用 `onTabChange`, 在抽屉内部切到数据源或 AI 配置页, 不额外改变主导航。
- 诊断页和抽屉右上角的引导入口通过 `onOpenGuide` 交给 App 控制, 抽屉本身不保存引导状态。
- 打开首次启动引导时, App 会先关闭配置抽屉再展示引导, 避免两个全局辅助层同时存在而造成遮挡或焦点竞争。
- “外观”页签不直接调用设置 IPC, 只复用 App/Zustand 已有主题切换路径, 避免出现两个主题状态来源。
- 历史 `sources/settings/ai-config/datasource` 主导航状态会自动打开抽屉并回到今日看板, 避免低频入口造成空白页面。
- FR-220 后, 左侧一级导航底部只保留配置中心入口; 主题和引导不再作为左侧栏独立按钮出现。
- “用户层级”页签仅用于开发验证免费/付费数据路由, 不代表真实登录、会员状态或计费结果。
