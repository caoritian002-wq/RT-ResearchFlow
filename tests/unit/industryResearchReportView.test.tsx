import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ReportView } from '../../src/components/IndustryResearch/ResearchWorkspace'

describe('IndustryResearch ReportView', () => {
  it('uses the full Markdown report as the primary content without the redundant findings block', () => {
    const output = renderToStaticMarkup(createElement(ReportView, {
      report: null,
      partitions: {
        supportedFindings: [{ text: '浅层重复结论', candidateIds: ['candidate-1'] }],
        modelOnlyFindings: [],
        pendingSources: [],
        evidenceInsufficient: false,
      },
      generated: {
        title: '光通信产业研究报告',
        summary: '摘要',
        markdown: '# 光通信产业研究报告\n\n## 一、核心结论\n\n完整正文结论。',
        missingSections: [],
        conflicts: [],
      },
      onGoReview: vi.fn(),
    }))

    expect(output).toContain('完整正文结论')
    expect(output).toContain('industry-research-report-document')
    expect(output).toContain('来源与审计')
    expect(output).not.toContain('关键结论与代表性来源')
    expect(output).not.toContain('industry-research-report-findings')
    expect(output.indexOf('完整正文结论')).toBeLessThan(output.indexOf('证据分区（可选）'))
  })
})
