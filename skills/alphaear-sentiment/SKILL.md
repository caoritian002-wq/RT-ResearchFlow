---
name: alphaear-sentiment
description: 分析金融文本情绪极性（正面/负面/中性）及评分。适用于需要判断金融新闻、公告等文本情绪方向和强度的场景。
---

# AlphaEar 情绪分析 Skill

## 概述

本 Skill 提供金融文本情绪分析能力，通过 LLM 对金融新闻、公告、研报等文本进行情绪判定和评分。

## 能力

### 情绪分析（LLM 驱动）

AI 直接根据以下提示词对金融文本进行情绪分析并输出结构化结果。

#### 情绪分析提示词

```markdown
请分析以下金融/新闻文本的情绪极性。
返回严格的 JSON 格式:
{"score": <float: -1.0到1.0>, "label": "<positive/negative/neutral>", "reason": "<简短理由>"}

文本: {text}
```

**评分标准：**
- **正面 (0.1 到 1.0)**：利好消息、盈利增长、政策支持、市场乐观等
- **负面 (-1.0 到 -0.1)**：亏损、制裁、价格下跌、市场悲观等
- **中性 (-0.1 到 0.1)**：事实性报道、横盘整理、影响模糊等

### 批量情绪分析

当需要对多条新闻进行情绪分析时，使用以下提示词：

```markdown
请对以下多条金融新闻逐一进行情绪分析。
对每条新闻返回严格的 JSON 数组格式:
[
  {"id": 1, "score": <float>, "label": "<positive/negative/neutral>", "reason": "<简短理由>"},
  ...
]

新闻列表:
{news_list}
```

### 情绪趋势总结

当需要总结多条新闻的整体情绪趋势时：

```markdown
请综合分析以下多条金融新闻的整体情绪趋势。
返回格式:
{
  "overall_score": <float: -1.0到1.0>,
  "overall_label": "<positive/negative/neutral>",
  "trend": "<improving/deteriorating/stable>",
  "summary": "<50字以内的趋势总结>"
}

新闻列表:
{news_list}
```
