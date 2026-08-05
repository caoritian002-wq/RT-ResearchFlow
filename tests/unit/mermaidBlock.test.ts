import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { isMermaidErrorSvg, MermaidAwarePre } from '../../src/components/MermaidBlock/MermaidBlock'

describe('MermaidBlock error detection', () => {
  it('does not treat Mermaid built-in error styles as a rendered error diagram', () => {
    const validSvg = `
      <svg role="graphics-document">
        <style>
          #chart .error-icon { fill: #552222; }
          #chart .error-text { fill: #552222; stroke: #552222; }
        </style>
        <g class="nodes"><text>DRAM价格传导</text></g>
      </svg>
    `

    expect(isMermaidErrorSvg(validSvg)).toBe(false)
  })

  it('detects an actual Mermaid error text element', () => {
    const errorSvg = `
      <svg>
        <style>#chart .error-text { fill: #552222; }</style>
        <text class="error-text">Syntax error in text</text>
      </svg>
    `

    expect(isMermaidErrorSvg(errorSvg)).toBe(true)
  })

  it('does not expose syntax errors or raw Mermaid source in the failure UI', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/MermaidBlock/MermaidBlock.tsx'),
      'utf8',
    )

    expect(source).toContain('if (error || !svg) return null')
    expect(source).not.toContain('Mermaid 语法错误')
    expect(source).not.toContain('<code>{code}</code>')
  })

  it('unwraps Mermaid without changing ordinary code blocks', () => {
    const mermaid = renderToStaticMarkup(createElement(
      MermaidAwarePre,
      {},
      createElement('code', { className: 'language-mermaid' }, 'graph TD'),
    ))
    const ordinary = renderToStaticMarkup(createElement(
      MermaidAwarePre,
      {},
      createElement('code', { className: 'language-typescript' }, 'const ok = true'),
    ))

    expect(mermaid).toBe('<code class="language-mermaid">graph TD</code>')
    expect(ordinary).toBe('<pre><code class="language-typescript">const ok = true</code></pre>')
  })
})
