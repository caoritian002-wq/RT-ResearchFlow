# Settings 组件

## 模块功能

`Settings` 组件负责应用级偏好设置展示与修改, 包括扫描频率、数据保留、启动补漏、资讯分组、扫描后 AI 分析、行业动量窗口、今日看板系统通知、详情缓存管理和受控本机研究访问。

## 实现思路

组件从 Zustand `useAppStore()` 读取 `settings` 与 `updateSettings`。大部分设置通过 `settings:update` 通用 IPC 写入 `app_settings`, 返回最新配置后同步更新前端状态。

今日看板系统通知使用 `decision_notify_windows_enabled` 控制 Windows 原生通知开关, 使用 `decision_notify_min_priority` 控制最低通知优先级。通知实际弹出逻辑在主进程 `decisionNotificationService.ts`, 设置页只负责持久化用户偏好。

`ResearchAccessSettings` 通过 `window.api.researchAccess` 的六个窄方法管理访问配置和读取最近50条有界审计。创建配置至少选择一个权限，`market.read` 默认选中；创建或轮换后的明文凭据及MCP配置只显示一次，以“我已保存”结束交付。权限清空会停用配置，轮换与撤销使用应用内确认区；renderer不获得事实工具执行入口。

## 主要 props/state/事件流

- props：无。
- store state：`settings`。
- store action：`updateSettings(data)`。
- 本地 state：
  - `saving/saved`：扫描频率保存反馈。
  - `cacheStats/selectedRange/clearing/clearResult`：详情缓存管理状态。
  - `ResearchAccessSettings` 自主管理端点状态、配置创建权限、一次性凭据、操作确认和审计反馈。
- 事件流：用户点击按钮或输入框失焦 -> `updateSettings` / `cache.clear` -> 主进程更新 SQLite -> 前端刷新展示。

## 特殊逻辑备忘

- Windows 系统通知只对新增决策信号生效, 同一 `dedup_key` 的信号更新不会重复弹出。
- 最低通知优先级目前限定为 P3+ / P4+ / P5+, 默认 P4+。
- Electron 开发模式下是否展示 Windows 通知受系统通知权限、专注助手和 AppUserModelId 影响；打包后更稳定。
