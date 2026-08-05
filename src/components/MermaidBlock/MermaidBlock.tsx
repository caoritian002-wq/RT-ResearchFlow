import { Children, createElement, Fragment, isValidElement, useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react'
import mermaid from 'mermaid'
import { useAppStore } from '../../store/appStore'

let mermaidIdCounter = 0

export function isMermaidErrorSvg(svg: string): boolean {
  // Mermaid includes `.error-icon` and `.error-text` in every flowchart's
  // stylesheet. Only an actual error diagram contains an error text element.
  return /<text\b[^>]*class=["'][^"']*\berror-text\b[^"']*["'][^>]*>/i.test(svg)
}

export function MermaidAwarePre({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  const childNodes = Children.toArray(children)
  const child = childNodes[0]
  const isMermaidCode = childNodes.length === 1
    && isValidElement<{ className?: string }>(child)
    && child.props.className?.includes('language-mermaid') === true

  if (isMermaidCode) return createElement(Fragment, null, children)
  return createElement('pre', props, children)
}

export default function MermaidBlock({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [svg, setSvg] = useState<string>('')
  const [error, setError] = useState(false)
  const theme = useAppStore((s) => s.theme)

  useEffect(() => {
    const isDark = theme === 'dark'
    mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? 'dark' : 'default',
      themeVariables: isDark
        ? {
            lineColor: '#93c5fd',
            arrowheadColor: '#93c5fd',
            edgeLabelBackground: '#1e293b',
            primaryTextColor: '#e2e8f0',
            primaryColor: '#334155',
            primaryBorderColor: '#60a5fa'
          }
        : {
            lineColor: '#334155',
            arrowheadColor: '#334155',
            edgeLabelBackground: '#ffffff',
            primaryTextColor: '#1e293b',
            primaryBorderColor: '#475569'
          },
      securityLevel: 'strict',
      flowchart: { curve: 'basis', padding: 15 },
      arrowMarkerAbsolute: true
    })

    const id = `mermaid-${++mermaidIdCounter}`
    let cancelled = false
    const source = code.trim()

    setSvg('')
    setError(false)

    void (async () => {
      try {
        if (!source) throw new Error('MERMAID_EMPTY')
        await mermaid.parse(source)
        const { svg: rendered } = await mermaid.render(id, source)
        if (isMermaidErrorSvg(rendered)) throw new Error('MERMAID_RENDER_ERROR')
        if (!cancelled) {
          setSvg(rendered)
          setError(false)
        }
      } catch {
        if (!cancelled) setError(true)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [code, theme])

  if (error || !svg) return null

  return (
    <div
      ref={containerRef}
      className="my-2 flex justify-center overflow-x-auto"
      role="img"
      aria-label="研判逻辑传导图"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
