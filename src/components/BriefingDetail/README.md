# BriefingDetail 组件维护说明

## 模块功能

`BriefingDetail` 是资讯情报台右侧详情研判区, 用于展示单条资讯的元信息、摘要、研判线索、按需抓取的正文内容、原文链接、一键 AI 分析入口和产业链分析入口。

## 实现思路

组件先根据 `briefingId` 读取简报元数据, 再通过 `window.api.detail.getContent()` 获取正文 HTML。正文渲染前使用 DOMPurify 清洗, 仅保留安全 HTML 与图片展示所需属性。详情区顶部按研判面板组织元信息、标题、关联方向和主要动作, 中段根据当前资讯的影响等级、影响评分、来源、发布时间和已读状态动态生成“为什么值得先看”线索, 操作区复用既有 AI 分析和统一产业分析抽屉。

## 主要 props/state/事件流

- `briefingId`: 当前选中的资讯 ID, 为空时展示选择提示。
- `briefing`: 当前资讯元数据。
- `detailContent`: 正文抓取结果, 包含状态和错误信息。
- `isLoadingDetail`: 正文加载状态。
- `isAnalyzing`: AI 分析按钮的执行状态。
- `tone`: 由 `impactRating` 与 `impactRatingScore` 派生的优先级说明和下一步动作建议。
- `chainText/showChain`: 产业链分析抽屉的输入文本与开关状态。
- 点击“一键AI分析”后调用 `window.api.ai.analyze()`, 成功后刷新 AI 会话列表。
- 点击“产业链分析”后打开 `IndustryAnalysisDrawer`, 输入为当前资讯标题与摘要。

## 特殊逻辑备忘

正文图片由主进程详情抓取链路统一补充 `referrerpolicy="no-referrer"`, 用于规避部分新闻站图片 CDN 对应用内 Referer 的防盗链拦截。前端 DOMPurify 需要保留该属性, 否则图片可能在详情页显示为破图。产业链分析入口只在非一般影响资讯中展示, 避免普通资讯详情区动作过载。原文链接在顶部动作区保留, 底部只作为长 URL 兜底展示。