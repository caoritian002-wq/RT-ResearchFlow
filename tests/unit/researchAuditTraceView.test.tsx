import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ResearchAuditTrace,
  ResearchEvidenceDelta,
  type ResearchEvidenceDeltaView,
  type ResearchAuditTraceView,
} from '../../src/components/shared/ResearchAuditTrace'
import { ReportView } from '../../src/components/IndustryResearch/ResearchWorkspace'

const trace: ResearchAuditTraceView = {
  schemaVersion: 1,
  status: 'warning',
  replayStatus: 'ready',
  generatedAt: 1,
  asOf: '20260728',
  originalTextSha256: 'a'.repeat(64),
  checkedCharacters: 128,
  evidenceSnapshotSha256: 'b'.repeat(64),
  evidenceSummary: { subjectCount: 1, supporting: 1, challenging: 1, unknowns: 1 },
  citationSummary: { availableReferences: 3, referencedReferences: 1, unresolvedReferences: 0 },
  checkSummary: { passed: 10, warning: 1, blocked: 0 },
  findings: [{
    code: 'UNKNOWN_GAP_DISCLOSURE',
    status: 'warning',
    message: '证据对照包含未知项，但最终文本未说明证据缺口',
    excerpts: [],
  }],
  warnings: ['stock.fundamentals: 公司概况不可历史还原'],
  subjects: [{
    subjectKind: 'stock',
    subjectId: '600000',
    label: '浦发银行',
    items: [{
      referenceId: 'E-0123456789',
      category: 'supporting',
      toolId: 'stock.trend_snapshot',
      label: '趋势状态',
      detail: '趋势状态=strong；评分=72',
      factDate: '20260728',
      sourceIds: ['local.trend_score_history'],
      referenced: true,
    }],
  }],
}

const delta: ResearchEvidenceDeltaView = {
  schemaVersion: 1,
  status: 'partial',
  generatedAt: Date.parse('2026-07-30T02:00:00.000Z'),
  historicalAsOf: '20260728',
  currentAsOf: '20260730',
  summary: { changed: 1, added: 1, removed: 1, unchanged: 0 },
  warnings: ['当前趋势事实存在缺口'],
  subjects: [{
    subjectKind: 'stock',
    subjectId: '600000',
    label: '浦发银行',
    items: [
      {
        referenceId: 'E-0123456789',
        change: 'changed',
        historical: trace.subjects[0].items[0],
        current: {
          ...trace.subjects[0].items[0],
          category: 'challenging',
          detail: '趋势状态=weak；评分=41',
          factDate: '20260730',
          referenced: false,
        },
      },
      {
        referenceId: 'E-1111111111',
        change: 'added',
        historical: null,
        current: {
          ...trace.subjects[0].items[0],
          referenceId: 'E-1111111111',
          label: '公告线索',
          detail: '新增公告标题线索',
          factDate: '20260730',
          referenced: false,
        },
      },
      {
        referenceId: 'E-2222222222',
        change: 'removed',
        historical: {
          ...trace.subjects[0].items[0],
          referenceId: 'E-2222222222',
          label: '历史趋势线索',
        },
        current: null,
      },
    ],
  }],
}

describe('ResearchAuditTrace', () => {
  it('用渐进披露展示状态、引用、证据来源与双哈希', () => {
    const output = renderToStaticMarkup(createElement(ResearchAuditTrace, { trace }))

    expect(output).toContain('research-audit-trace')
    expect(output).toContain('存在审计警告')
    expect(output).toContain('已定位 1/3 项证据')
    expect(output).toContain('E-0123456789')
    expect(output).toContain('已引用')
    expect(output).toContain('local.trend_score_history')
    expect(output).toContain('正文 SHA-256')
    expect(output).toContain('证据 SHA-256')
  })

  it('仅在可回放审计且提供显式动作时展示当前事实对比入口', () => {
    const ready = renderToStaticMarkup(createElement(ResearchAuditTrace, {
      trace,
      onCompareCurrent: async () => ({ ok: true as const, data: delta }),
    }))
    const mismatched = renderToStaticMarkup(createElement(ResearchAuditTrace, {
      trace: { ...trace, replayStatus: 'snapshot_mismatch', subjects: [] },
      onCompareCurrent: async () => ({ ok: true as const, data: delta }),
    }))

    expect(ready).toContain('对比当前事实')
    expect(ready).toContain('min-h-11')
    expect(mismatched).not.toContain('对比当前事实')
  })

  it('并列展示历史与当前事实，并用文字呈现四类变化口径', () => {
    const output = renderToStaticMarkup(createElement(ResearchEvidenceDelta, {
      delta,
      filter: 'changes',
      onFilterChange: () => undefined,
      onDiscussChanges: () => undefined,
    }))

    expect(output).toContain('全部变化 3')
    expect(output).toContain('已变化 1')
    expect(output).toContain('新增 1')
    expect(output).toContain('不再出现 1')
    expect(output).toContain('未变化 0')
    expect(output).toContain('历史快照')
    expect(output).toContain('当前本地')
    expect(output).toContain('不等于历史事实已被证伪')
    expect(output).toContain('当前趋势事实存在缺口')
    expect(output).toContain('基于变化继续讨论')
    expect(output).toContain('将由主进程重新校验这些变化')
    expect(output).toContain('min-h-11')
  })

  it('没有事实变化时不提供专项讨论动作', () => {
    const output = renderToStaticMarkup(createElement(ResearchEvidenceDelta, {
      delta: {
        ...delta,
        summary: { changed: 0, added: 0, removed: 0, unchanged: 0 },
        subjects: [],
      },
      filter: 'changes',
      onFilterChange: () => undefined,
      onDiscussChanges: () => undefined,
    }))

    expect(output).toContain('当前本地证据与历史快照一致')
    expect(output).not.toContain('基于变化继续讨论')
  })

  it('报告页直接消费运行中保存的同一审计回放视图', () => {
    const output = renderToStaticMarkup(createElement(ReportView, {
      report: null,
      generated: {
        title: '光通信产业研究报告',
        summary: '摘要',
        markdown: '# 光通信产业研究报告\n\n## 一、核心结论\n\n阶段性结论。[E-0123456789]',
        missingSections: [],
        conflicts: [],
        researchTrace: trace,
      },
      onDiscussChanges: async () => ({ ok: true as const }),
    }))

    expect(output).toContain('industry-research-report-document')
    expect(output).toContain('research-audit-trace')
    expect(output.indexOf('research-audit-trace')).toBeLessThan(output.indexOf('industry-research-report-document'))
  })

  it('快照不匹配时明确停止具体证据关联', () => {
    const output = renderToStaticMarkup(createElement(ResearchAuditTrace, {
      trace: { ...trace, replayStatus: 'snapshot_mismatch', subjects: [] },
      variant: 'compact',
    }))

    expect(output).toContain('证据快照不匹配')
    expect(output).toContain('系统已停止关联具体证据')
    expect(output).not.toContain('E-0123456789')
  })

  it('正文校验不一致时不使用旧审计解释新文本', () => {
    const output = renderToStaticMarkup(createElement(ResearchAuditTrace, {
      trace: { ...trace, replayStatus: 'document_mismatch', subjects: [] },
    }))

    expect(output).toContain('正文校验不匹配')
    expect(output).toContain('避免用旧审计解释被改写的文本')
  })
})
