# AppWindow 组件说明

## 模块功能

`AppWindow` 承载无边框 Electron 窗口的自定义标题栏。它替代 Windows 原生标题栏和菜单栏, 提供极简系统区、可拖拽区域以及最小化、最大化/还原、关闭三个窗口控制按钮。
`AppLogo` 是项目唯一品牌标识组件, 图形以趋势线和信号点表达金融投研、行情跟踪和本地决策辅助。
`PrimaryNavigationIcon` 承载九枚一级导航科技终端 SVG, 以业务主符号、蓝色遥测层和青色状态节点统一今日看板、走势图、趋势、云图、短线、资讯、AI、消息与配置入口。
FR-224 后, 标题栏同时承载业务壳层状态, 展示产品名、本地工作台说明、上证/深成/创业板三大指数胶囊和行情更新时间, 避免在窗口标题栏下方再叠一条状态栏。高优先级未读等提醒类信息统一收敛到消息中心。

## 实现思路

主进程在创建 `BrowserWindow` 时使用 `frame: false`, 并通过 `window:*` IPC 暴露窗口控制能力。preload 将这些能力挂到 `window.api.windowControls`, 渲染进程只调用受控方法, 不直接访问 Electron 或 Node API。

标题栏高度由全局 CSS 变量 `--app-titlebar-height` 控制。标题栏根节点使用 `.electron-drag` 作为拖拽区域, 右侧按钮区使用 `.electron-no-drag` 避免点击被拖拽吞掉。最大化状态由主进程 `maximize/unmaximize` 事件推送给渲染进程, 用于切换按钮图标和无障碍标签。

## 主要 props/state/事件流

- `AppTitleBar`: 内部维护 `isMaximized` 状态, 首次挂载时调用 `windowControls.isMaximized()` 初始化, 并复用 `useMarketIndexQuotes` 展示上证、深成和创业板指数。
- `windowControls.minimize`: 最小化当前主窗口。
- `windowControls.toggleMaximize`: 在最大化和还原之间切换。
- `windowControls.close`: 关闭当前主窗口。
- `windowControls.onMaximizedChanged`: 监听主进程推送的最大化状态变化。

## 特殊逻辑备忘

- 标题栏同时是系统区和业务壳层状态区; 右侧窗口控制按钮必须保留 `electron-no-drag`, 左侧品牌和中间空白区域仍保持 `electron-drag`。
- 标题栏必须跟随全局亮暗主题, 不允许硬编码为单一深色或单一浅色。
- 项目 logo 只在标题栏左上角出现, 一级导航栏不重复放置品牌块, 避免系统区和业务导航争抢视觉焦点。
- 消息中心等只承担通知查看的辅助浮层可从标题栏下方开始, 外层 fixed 容器使用 `.app-overlay-below-titlebar`; 配置中心属于整页抽屉, 需要覆盖标题栏与主工作区。
- 一级导航的 icon-only 按钮不得使用原生 `title` 作为可见提示, 必须通过 `aria-label` 提供可访问名称, 并使用自定义 Tooltip 作为唯一可见提示来源。
- 一级导航固定使用 44px 点击热区和 23px 图标。选中态由边框、仪器角标和状态像素共同表达; Hover 扫描只执行一次, 内部动效必须对应图标语义, 不得循环播放或引起布局变化。不同入口的主轮廓不得复用到缩略尺寸下无法区分；今日看板使用模块面板，大盘云图使用双层不规则热场，设置使用三轨调节控制器且不得复用今日看板四角框。
- 所有导航图标动效集中在 `.app-primary-nav-button` / `.nav-tech-*` 作用域；`prefers-reduced-motion: reduce` 下关闭扫描、缩放和内部位移。消息中心与配置抽屉打开时对应入口同步 `is-active` 和 `aria-expanded`。
- 具备二级页签的一级模块由 App 壳层的二级 Flyout 承接快速跳转。Flyout 使用 `transform` 与 `opacity` 动画, 打开时会隐藏侧栏 Tooltip, 避免两个提示浮层重叠。
- Flyout 打开期间，导航壳层临时提升到页面局部页签、吸顶标题和筛选浮层之上；关闭后恢复基础层级。不要给主内容容器增加隔离堆叠上下文，也不要永久置顶导航，否则会破坏既有全屏模态和抽屉的遮罩覆盖。
- Flyout 只同步页面内已有二级状态, 不新增 IPC 或数据库字段。短线策略复用 Zustand 的 `shortTermActiveSubTab`, 大盘云图和长线趋势通过受控 props 同步。
- 关闭按钮使用独立红色 hover 状态, 最小化和最大化按钮保持低干扰深色工作台风格。
- 新增窗口控制行为时必须先经 preload 暴露, 不要在 React 组件中直接依赖 Electron 主进程 API。
