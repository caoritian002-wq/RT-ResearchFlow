# AIConfig 组件说明

## 模块功能

`AIConfig` 负责应用内 AI 厂商、模型、API Key、Base URL、提示词、调用优先级、多模型预测和分析框架 Skills 的配置管理。自定义 Skill 路径既可以指向包含多个 Skill 的父目录, 也可以直接指向包含 `SKILL.md` 的单个 Skill 目录。

## 实现思路

组件通过 `window.api.ai.getConfig()` 加载主进程返回的配置, 将每个厂商拆成独立行表单。单行保存调用 `window.api.ai.saveConfig({ providerConfig })`, 全局设置保存调用 `window.api.ai.saveConfig()` 的全局字段。API Key 输入框只用于写入新密钥, 已配置状态由后端返回的 `hasApiKey` 控制, 不回显密钥明文。

## 主要 props/state/事件流

- 无外部 props, 通过 `window.api` 与主进程交互。
- `config`: 当前 AI 配置快照。
- `rowForms`: 每个厂商的模型、API Key、Base URL、最大输出 Tokens 和密钥显示状态。
- `priority`: AI 调用失败降级的厂商优先级。
- `multiModel`: 分时预测时参与并行预测的厂商列表。
- `selectedSkills` / `skillsForTrend` / `maxSkillChars`: 普通 AI 提示词的分析框架注入配置。
- `skills`: Skill 列表及其内容哈希、规则版本、完整性和冲突路径元数据。

## 特殊逻辑备忘

- ChatGPT 行支持填写 OpenAI-compatible Base URL, 可用于接入自定义 GPT 端点。
- `gpt-5.6-sol` 与 GPT 5.5 均作为 `chatgpt` 厂商下的模型选项展示，不新增独立厂商；`gpt-5.6-sol` 继续走现有 OpenAI-compatible Chat Completions，未附加未经核验的专属参数。
- 文章分析系统默认提示词以事实、推断、影响传导、风险反证和验证清单为主线，允许没有股票候选；厂商级自定义提示词仍优先于系统默认值。
- 最大输出 Tokens 是厂商级配置, 未配置时默认 `4096`, 会传入对应 AI 调用。
- API Key 留空保存时不会覆盖已加密存储的旧密钥。
- Skill 列表展示 SHA-256 短标识和完整性状态; 同一来源的重复 Skill ID 使用稳定的首次发现项, 并显示冲突路径。
- “完整纳入 / 部分截断 / 未参与”只描述普通 AI 提示词拼接状态, 不代表产业研究项目执行状态。
