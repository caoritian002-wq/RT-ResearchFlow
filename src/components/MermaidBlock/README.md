# MermaidBlock 组件说明

## 模块功能

`MermaidBlock` 负责将 Markdown 中的 Mermaid 代码块渲染为 SVG 图表, 用于 AI 分析和预测理由中的流程图展示。

## 实现思路

组件根据当前主题初始化 Mermaid, 渲染前先调用 `mermaid.parse()` 校验语法。渲染结果若包含 Mermaid 默认错误 SVG 的特征文本, 会视为失败并回退显示原始代码块, 避免页面出现重复的错误图标。

## 主要 props/state/事件流

- `code`: Mermaid 原始代码文本。
- `svg`: 成功渲染后的 SVG 字符串。
- `error`: 语法校验或渲染失败时置为 `true`, UI 改为显示原始代码。
- `theme`: 从全局 store 读取, 主题变化时重新初始化并重新渲染。

## 特殊逻辑备忘

- Mermaid 有时不会抛出异常, 而是返回包含 `Syntax error in text` 的错误 SVG, 因此需要额外检测渲染结果。
- fallback 只影响当前图表代码块, 不影响同一页面其他 Markdown 内容继续渲染。