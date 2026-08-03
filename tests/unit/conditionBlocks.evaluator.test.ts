import { describe, expect, it } from 'vitest'
import type { BlockStrategyTemplate, ConditionBlock, MinuteBarForCondition } from '../../electron/main/services/conditionBlocks/types'
import { evaluateConditionTemplate } from '../../electron/main/services/conditionBlocks/blockEvaluator'

function bar(minute: string, close: number, amount = 100, vol = 10): MinuteBarForCondition {
  return {
    tsCode: '000001.SZ',
    tradeDate: '20260616',
    tsMinute: minute,
    open: close,
    high: close,
    low: close,
    close,
    amount,
    vol,
  }
}

function template(mode: 'strict' | 'score' = 'strict'): BlockStrategyTemplate {
  return {
    key: 'test',
    name: '测试模板',
    description: '测试模板',
    version: 1,
    enabled: true,
    executionMode: mode,
    scoreThreshold: 50,
    scope: {
      dateStart: '20260616',
      dateEnd: '20260616',
      lookbackDays: 1,
      stockPoolSources: ['manual'],
      manualStocks: [{ tsCode: '000001.SZ', stockName: '平安银行' }],
      excludeST: true,
      excludeBJ: false,
      minDailyAmount: null,
    },
    root: {
      id: 'root',
      operator: 'AND',
      enabled: true,
      children: [
        {
          id: 'gain',
          type: 'minute_window_gain',
          name: '涨幅',
          description: '涨幅',
          enabled: true,
          weight: 60,
          hardRequired: true,
          params: { windowMinutes: 3, minGainPct: 3 },
        },
        {
          id: 'retention',
          type: 'close_retention',
          name: '保持度',
          description: '保持度',
          enabled: true,
          weight: 40,
          params: { minRetentionPct: 60 },
        },
      ],
    },
  }
}

function gainBlock(id: string, minGainPct: number, weight = 50, hardRequired = false): ConditionBlock {
  return {
    id,
    type: 'minute_window_gain',
    name: '窗口涨幅',
    description: '测试窗口涨幅',
    enabled: true,
    weight,
    hardRequired,
    params: { windowMinutes: 3, minGainPct },
  }
}

function retentionBlock(id: string, minRetentionPct: number, weight = 50, hardRequired = false): ConditionBlock {
  return {
    id,
    type: 'close_retention',
    name: '收盘保持度',
    description: '测试收盘保持度',
    enabled: true,
    weight,
    hardRequired,
    params: { minRetentionPct },
  }
}

describe('condition block evaluator', () => {
  it('strict 模式要求所有 AND 子条件通过', () => {
    const rows = [bar('09:30', 10), bar('09:31', 10.2), bar('09:32', 10.5), bar('14:57', 10.45)]
    const result = evaluateConditionTemplate(template(), rows)

    expect(result.passed).toBe(true)
    expect(result.flatConditions).toHaveLength(2)
    expect(result.totalScore).toBeGreaterThan(90)
    expect(result.flatConditions[0].params).toEqual({ windowMinutes: 3, minGainPct: 3 })
    expect(result.flatConditions[0].hardRequired).toBe(true)
  })

  it('hardRequired 条件失败时 score 模式也不通过', () => {
    const rows = [bar('09:30', 10), bar('09:31', 10.05), bar('09:32', 10.1), bar('14:57', 10.1)]
    const result = evaluateConditionTemplate(template('score'), rows)

    expect(result.passed).toBe(false)
    expect(result.flatConditions.find(item => item.blockId === 'gain')?.passed).toBe(false)
  })

  it('缺少分钟数据时返回 data_insufficient', () => {
    const result = evaluateConditionTemplate(template(), [bar('09:30', 10)])

    expect(result.passed).toBe(false)
    expect(result.dataStatus).toBe('data_insufficient')
  })

  it('严格模式确定性执行嵌套 AND、OR 和 NOT', () => {
    const candidate = template('strict')
    candidate.root = {
      id: 'root',
      operator: 'AND',
      enabled: true,
      children: [
        gainBlock('gain-pass', 3),
        {
          id: 'or-group',
          operator: 'OR',
          enabled: true,
          children: [gainBlock('gain-fail', 20), retentionBlock('retention-pass', 60)],
        },
        {
          id: 'not-group',
          operator: 'NOT',
          enabled: true,
          children: [gainBlock('gain-not', 20)],
        },
      ],
    }
    const rows = [bar('09:30', 10), bar('09:31', 10.2), bar('09:32', 10.5), bar('14:57', 10.45)]

    expect(evaluateConditionTemplate(candidate, rows).passed).toBe(true)
    candidate.root.children[2] = {
      id: 'not-group',
      operator: 'NOT',
      enabled: true,
      children: [gainBlock('gain-not', 3)],
    }
    expect(evaluateConditionTemplate(candidate, rows).passed).toBe(false)
  })

  it('评分模式保留 NOT 方向并且不把缺数据当成反证', () => {
    const candidate = template('score')
    candidate.root = {
      id: 'root',
      operator: 'NOT',
      enabled: true,
      children: [gainBlock('gain-not', 20, 100)],
    }
    const rows = [bar('09:30', 10), bar('09:31', 10.2), bar('09:32', 10.5), bar('14:57', 10.45)]

    const notMatched = evaluateConditionTemplate(candidate, rows)
    expect(notMatched.passed).toBe(true)
    expect(notMatched.totalScore).toBe(100)
    expect(evaluateConditionTemplate(candidate, [bar('09:30', 10)]).passed).toBe(false)

    candidate.root.children = [gainBlock('gain-not', 3, 100)]
    const childMatched = evaluateConditionTemplate(candidate, rows)
    expect(childMatched.passed).toBe(false)
    expect(childMatched.totalScore).toBe(0)
  })

  it('评分模式的嵌套硬门槛失败不会被父组高分绕过', () => {
    const candidate = template('score')
    candidate.scoreThreshold = 50
    candidate.root = {
      id: 'root',
      operator: 'AND',
      enabled: true,
      children: [
        gainBlock('gain-pass', 3, 90),
        {
          id: 'hard-group',
          operator: 'AND',
          enabled: true,
          children: [retentionBlock('retention-hard', 95, 10, true)],
        },
      ],
    }
    const rows = [bar('09:30', 10), bar('09:31', 10.2), bar('09:32', 10.5), bar('14:57', 10.45)]

    const result = evaluateConditionTemplate(candidate, rows)
    expect(result.totalScore).toBeGreaterThan(50)
    expect(result.passed).toBe(false)
  })

  it('停用条件不进入证据也不贡献评分', () => {
    const candidate = template('score')
    candidate.scoreThreshold = 50
    const disabledGain = gainBlock('gain-disabled', 3, 100)
    disabledGain.enabled = false
    candidate.root.children = [gainBlock('gain-active', 20, 100), disabledGain]
    const rows = [bar('09:30', 10), bar('09:31', 10.2), bar('09:32', 10.5), bar('14:57', 10.45)]

    const result = evaluateConditionTemplate(candidate, rows)
    expect(result.passed).toBe(false)
    expect(result.totalScore).toBe(0)
    expect(result.flatConditions.map(item => item.blockId)).toEqual(['gain-active'])
  })
})
