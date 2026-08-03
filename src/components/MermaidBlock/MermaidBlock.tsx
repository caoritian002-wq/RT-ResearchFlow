import { useEffect, useRef, useState } from 'react'
import mermaid from 'mermaid'
import { useAppStore } from '../../store/appStore'

let mermaidIdCounter = 0

function isMermaidErrorSvg(svg: string): boolean {
  return /Syntax error in text|mermaid version|error-icon|errorText/i.test(svg)
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

  if (error) {
    return (
      <div className="my-2 rounded border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 p-3">
        <div className="mb-2 text-xs text-amber-700 dark:text-amber-300">Mermaid 语法错误, 已显示原文。</div>
        <pre className="text-xs overflow-x-auto text-gray-800 dark:text-gray-100">
          <code>{code}</code>
        </pre>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="my-2 flex justify-center overflow-x-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
