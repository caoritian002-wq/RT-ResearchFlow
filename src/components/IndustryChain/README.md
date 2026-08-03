# IndustryChain 产业链图谱模块

## 模块功能

在「AI 分析」Tab 中提供右侧抽屉形式的产业链可视化，支持：
- 8 条核心 A 股产业链的 Mermaid 流程图渲染
- 点击 Mermaid 节点展示层级信息和代表个股
- 点击个股一键跳转走势图
- AI 分析文本自动关键词匹配，智能预选最相关产业链

## 文件说明

| 文件 | 说明 |
|------|------|
| `IndustryChainDrawer.tsx` | 右侧抽屉组件（主入口） |
| `../../utils/industryChainData.ts` | 8 条链的静态数据 + `chainToMermaid()` |

## 主要 Props

### IndustryChainDrawer

| Prop | 类型 | 说明 |
|------|------|------|
| `open` | `boolean` | 控制抽屉显隐 |
| `onClose` | `() => void` | 关闭回调 |
| `defaultChainId?` | `string` | 默认选中的链 id（如 `'lithium_battery'`） |

## 主要 State

| 变量 | 说明 |
|------|------|
| `selectedChainId` | 当前选中的产业链 id |
| `selectedNode` | 当前点击的节点（`ChainNode | null`） |
| `svg` | Mermaid 渲染后的 SVG 字符串 |

## 事件流

1. 用户在 AI 分析详情点击「产业链」按钮
2. `findBestMatchChain(text)` 按 keywords 命中数自动匹配最相关链 id
3. `IndustryChainDrawer` 以该链 id 为默认值打开
4. Mermaid useEffect 渲染 `flowchart LR` 图（含 7 层 classDef 着色）
5. 用户点击图中节点 → `g.node` 事件委托解析 `flowchart-{nodeId}-{n}` → 展示右侧面板
6. 用户点击个股 → `navigateToStock(code, name)` + `onClose()`

## 特殊逻辑备忘

- **节点点击**：用事件委托监听 `g.node` 的 click，不依赖 `securityLevel:'loose'`，兼容 Electron 安全策略
- **mermaid.initialize**：每次渲染前重新调用，确保主题切换（暗色/亮色）即时生效
- **个股代码转换**：`tsCode`（如 `002466.SZ`）需去掉后缀才能传入 `navigateToStock`
- **keywords 匹配阈值**：至少命中 2 个关键词才返回匹配链，避免误匹配
- **8 条产业链**：锂电、光伏、半导体、AI 算力、消费电子、储能、医药 CXO、军工电子
