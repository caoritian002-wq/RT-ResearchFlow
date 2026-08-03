import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  PrimaryNavigationIcon,
  type PrimaryNavigationIconName,
} from '../../src/components/AppWindow/PrimaryNavigationIcon'

const iconNames: PrimaryNavigationIconName[] = [
  'dashboard',
  'stock',
  'trend',
  'heatmap',
  'strategy',
  'news',
  'ai',
  'messages',
  'settings',
]

describe('PrimaryNavigationIcon', () => {
  it.each(iconNames)('renders the approved telemetry SVG for %s', (name) => {
    const markup = renderToStaticMarkup(createElement(PrimaryNavigationIcon, { name }))

    expect(markup).toContain(`data-nav-icon="${name}"`)
    expect(markup).toContain('nav-tech-icon')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('stroke-width="1.55"')
  })

  it('uses distinct primary silhouettes for dashboard and heatmap', () => {
    const dashboard = renderToStaticMarkup(createElement(PrimaryNavigationIcon, { name: 'dashboard' }))
    const heatmap = renderToStaticMarkup(createElement(PrimaryNavigationIcon, { name: 'heatmap' }))
    const dashboardTelemetryFrame = 'M3.5 8V3.5H8M16 3.5h4.5V8M20.5 16v4.5H16M8 20.5H3.5V16'

    expect(dashboard).toContain(dashboardTelemetryFrame)
    expect(heatmap).not.toContain(dashboardTelemetryFrame)
    expect(heatmap).toContain('nav-tech-heatmap-field')
    expect(heatmap).toContain('nav-tech-heatmap-core')
  })

  it('uses slider controls for settings instead of the dashboard frame', () => {
    const settings = renderToStaticMarkup(createElement(PrimaryNavigationIcon, { name: 'settings' }))
    const dashboardTelemetryFrame = 'M3.5 8V3.5H8M16 3.5h4.5V8M20.5 16v4.5H16M8 20.5H3.5V16'

    expect(settings).not.toContain(dashboardTelemetryFrame)
    expect(settings).toContain('M4 6h3M11 6h9M4 12h9M17 12h3M4 18h5M13 18h7')
    expect(settings).toContain('nav-tech-settings-control-a')
    expect(settings).toContain('nav-tech-settings-control-b')
    expect(settings).toContain('nav-tech-settings-control-c')
  })
})
