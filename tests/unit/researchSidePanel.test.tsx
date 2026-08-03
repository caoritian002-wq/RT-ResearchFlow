import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ResearchSidePanel } from '../../src/components/IndustryResearch/ResearchSidePanel'
import type { ResearchEvidence, ResearchHypothesis } from '../../src/components/IndustryResearch/industryResearchTypes'

const evidence = [{
  id: 'evidence-1',
  title: 'Primary source evidence',
  source_type: 'official',
  source_name: 'Official source',
  source_url: 'https://example.com/source',
  source_ref: null,
  fact_date: '2026-07-18',
  statement_kind: 'fact',
  direction: 'support',
  reliability: 'primary',
  primary_source_confirmed: 1,
  conflict_note: null,
  excerpt: 'Verified source excerpt.',
  updated_at: 1,
}] as ResearchEvidence[]

const hypotheses = [{
  id: 'hypothesis-1',
  statement: 'Demand remains strong',
  importance: 2,
  status: 'open',
  cheapest_disproof: 'Check the next procurement result.',
  verification_metric: null,
  threshold: null,
  due_at: null,
  evidence_ids_json: '[]',
  events: [],
  updated_at: 1,
}] as ResearchHypothesis[]

function markup(open: boolean): string {
  return renderToStaticMarkup(createElement(ResearchSidePanel, {
    evidence,
    hypotheses,
    open,
    onOpenChange: vi.fn(),
    onAddEvidence: vi.fn(),
    onAddHypothesis: vi.fn(),
    onChangeHypothesisStatus: vi.fn(),
  }))
}

describe('ResearchSidePanel', () => {
  it('keeps only the compact ledger rail visible by default', () => {
    const output = markup(false)
    expect(output).toContain('data-testid="industry-research-ledger-rail"')
    expect(output).not.toContain('data-testid="industry-research-ledger-drawer"')
    expect(output).toContain('aria-expanded="false"')
  })

  it('opens an overlay drawer without rendering both ledger lists', () => {
    const output = markup(true)
    expect(output).toContain('data-testid="industry-research-ledger-drawer"')
    expect(output).toContain('class="fixed z-[120]')
    expect(output).toContain('data-section="evidence"')
    expect(output).toContain('aria-controls="industry-research-ledger-drawer"')
    expect(output).toContain('Primary source evidence')
    expect(output).not.toContain('Demand remains strong')
  })
})
