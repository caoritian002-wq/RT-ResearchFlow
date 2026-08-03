# MessageCenter 组件说明

## 模块功能

`MessageCenter` 承载 FR-221 的全局消息中心。它不是新的业务工作台, 而是把资讯扫描、初始化、数据源、AI、条件积木、回测和今日看板高优先级提醒等“需要知道”的消息收敛到左侧栏底部的独立入口中。

## 实现思路

首版不新增 IPC 和数据库表, 由 App 基于现有前端状态派生 `MessageCenterItem[]`, 再交给 `MessageCenterDrawer` 展示。消息中心只负责告知、解释和跳转来源, 不承接今日看板的处置和复盘语义。

## 主要 props/state/事件流

- `MessageCenterDrawer.open`: 控制抽屉是否显示。
- `MessageCenterDrawer.messages`: 当前消息列表。
- `MessageCenterDrawer.onClose`: 关闭抽屉。
- `MessageCenterItem.onAction`: 可选跳转动作, 由 App 注入, 通常切换到资讯、今日看板或打开初始化引导。

## 特殊逻辑备忘

- 消息中心入口位于左侧栏配置中心上方, 与配置中心同属全局辅助入口。
- 今日看板高优先级信号只在消息中心提示, 具体研判仍回到今日看板完成。
- 若后续需要跨会话消息历史, 必须另行规划 DB Migration, 不应把持久化逻辑塞进当前前端派生模型。