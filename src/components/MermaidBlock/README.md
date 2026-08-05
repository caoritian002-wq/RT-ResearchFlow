# MermaidBlock 组件说明

## 模块功能

`MermaidBlock` 负责将 Markdown 中的 Mermaid 代码块渲染为 SVG 图表, 用于 AI 分析和预测理由中的流程图展示。

## 实现思路

组件根据当前主题初始化 Mermaid, 渲染前先调用 `mermaid.parse()` 校验语法。Mermaid 会在所有正常流程图的 CSS 中预置 `.error-icon` 与 `.error-text`, 因此不能仅凭样式名判断失败; 只有渲染结果真实包含 `text.error-text` 节点时才视为错误。校验或渲染失败时不输出错误图、提示文案或原始代码块, 避免技术语法和大面积代码底色干扰研判正文。

`MermaidAwarePre` 用于 React Markdown 的 `pre` 组件映射。它只解包 `language-mermaid` 代码块, 避免有效图表被普通代码块的深色背景包裹, 也确保失败时不留下空白黑框; 其他代码块保持原有 `pre` 语义和样式。

## 主要 props/state/事件流

- `code`: Mermaid 原始代码文本。
- `svg`: 成功渲染后的 SVG 字符串。
- `error`: 语法校验或渲染失败时置为 `true`, UI 直接省略该图表块。
- `theme`: 从全局 store 读取, 主题变化时重新初始化并重新渲染。
- `MermaidAwarePre`: 在 Markdown 渲染器中解包 Mermaid, 其他代码块保留 `pre`。

## 特殊逻辑备忘

- 正常 SVG 样式中的 `.error-icon` 不得被误判为语法错误。
- Mermaid 有时不会抛出异常, 而是返回真实包含 `text.error-text` 的错误 SVG, 因此仍保留结果检测。
- 失败降级只省略当前图表代码块, 不影响同一页面其他 Markdown 内容继续渲染。
