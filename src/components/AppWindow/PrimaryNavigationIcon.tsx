import * as React from 'react'

export type PrimaryNavigationIconName =
  | 'dashboard'
  | 'stock'
  | 'trend'
  | 'heatmap'
  | 'strategy'
  | 'news'
  | 'ai'
  | 'messages'
  | 'settings'

interface PrimaryNavigationIconProps {
  name: PrimaryNavigationIconName
}

const iconProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.55,
  strokeLinecap: 'square' as const,
  strokeLinejoin: 'miter' as const,
  'aria-hidden': true,
}

export function PrimaryNavigationIcon({ name }: PrimaryNavigationIconProps) {
  if (name === 'dashboard') {
    return (
      <svg {...iconProps} data-nav-icon={name} className="nav-tech-icon nav-tech-icon-dashboard">
        <path className="nav-tech-telemetry" d="M3.5 8V3.5H8M16 3.5h4.5V8M20.5 16v4.5H16M8 20.5H3.5V16" />
        <rect x="6" y="6" width="5" height="5" />
        <rect className="nav-tech-dashboard-module" x="13" y="6" width="5" height="8" />
        <rect x="6" y="13" width="5" height="5" />
        <path d="M13 17h5" />
        <circle className="nav-tech-node" cx="15.5" cy="17" r="1.1" />
      </svg>
    )
  }

  if (name === 'stock') {
    return (
      <svg {...iconProps} data-nav-icon={name} className="nav-tech-icon nav-tech-icon-stock">
        <path className="nav-tech-telemetry" d="M4 4v16h16M7 6v9M12 4v12M17 8v10" />
        <rect x="5.7" y="8" width="2.6" height="4.5" />
        <rect x="10.7" y="6" width="2.6" height="6.5" />
        <rect x="15.7" y="11" width="2.6" height="4.5" />
        <path className="nav-tech-stock-scanner" d="M5 18.3 9 15l4 1.6 6-8" />
        <circle className="nav-tech-node" cx="19" cy="8.6" r="1.1" />
      </svg>
    )
  }

  if (name === 'trend') {
    return (
      <svg {...iconProps} data-nav-icon={name} className="nav-tech-icon nav-tech-icon-trend">
        <path className="nav-tech-telemetry" d="M4 18.5h16M5 14.7l4-3.8 4 1.8 6-6" />
        <path className="nav-tech-trend-channel" d="M5 18l4-3.8 4 1.8 6-6" />
        <path d="M16 6.7h3v3M4 5.5h4M4 8h2" />
        <circle className="nav-tech-node" cx="13" cy="16" r="1.1" />
      </svg>
    )
  }

  if (name === 'heatmap') {
    return (
      <svg {...iconProps} data-nav-icon={name} className="nav-tech-icon nav-tech-icon-heatmap">
        <path className="nav-tech-telemetry" d="M3.5 7.5v-3h3M20.5 16.5v3h-3" />
        <path className="nav-tech-heatmap-field" d="m4.5 12 2.8-5 5-2.2 4.5 2.6 2.7 4.8-2.6 4.7-5 2.3-4.7-2.1z" />
        <path className="nav-tech-heatmap-core" d="m8 12 2-2.8 3-.7 2.8 1.8.8 2.9-2.4 2.3-3 .4-2.4-1.7z" />
        <circle className="nav-tech-node" cx="13.1" cy="12.5" r="1.1" />
      </svg>
    )
  }

  if (name === 'strategy') {
    return (
      <svg {...iconProps} data-nav-icon={name} className="nav-tech-icon nav-tech-icon-strategy">
        <path className="nav-tech-telemetry" d="M12 3v3M12 18v3M3 12h3M18 12h3" />
        <circle cx="12" cy="12" r="6" />
        <path className="nav-tech-strategy-sweep" d="M12 12 17 8M12 12l2 5" />
        <path d="m9 14 2-5 4 2" />
        <circle className="nav-tech-node" cx="12" cy="12" r="1.2" />
      </svg>
    )
  }

  if (name === 'news') {
    return (
      <svg {...iconProps} data-nav-icon={name} className="nav-tech-icon nav-tech-icon-news">
        <path d="M5 3.5h10l4 4v13H5zM15 3.5v4h4" />
        <path d="M8 11h8M8 14h8M8 17h5" />
        <path className="nav-tech-telemetry nav-tech-news-packet" d="M3 8h4M3 11h2" />
        <circle className="nav-tech-node" cx="8" cy="7" r="1.1" />
      </svg>
    )
  }

  if (name === 'ai') {
    return (
      <svg {...iconProps} data-nav-icon={name} className="nav-tech-icon nav-tech-icon-ai">
        <path className="nav-tech-telemetry nav-tech-ai-circuit-a" d="M3 7h4l2 2M3 17h4l2-2" />
        <path className="nav-tech-telemetry nav-tech-ai-circuit-b" d="M21 7h-4l-2 2M21 17h-4l-2-2" />
        <path d="m12 5 5 3v8l-5 3-5-3V8z" />
        <path d="m12 8 2.7 1.6v4.8L12 16l-2.7-1.6V9.6z" />
        <circle className="nav-tech-node" cx="12" cy="12" r="1.2" />
        <path className="nav-tech-telemetry" d="M12 2.5V5M12 19v2.5" />
      </svg>
    )
  }

  if (name === 'messages') {
    return (
      <svg {...iconProps} data-nav-icon={name} className="nav-tech-icon nav-tech-icon-messages">
        <path d="M4 5h16v12H10l-4 3v-3H4z" />
        <path className="nav-tech-telemetry" d="M7 8h10" />
        <path className="nav-tech-message-bar-a" d="M8 13v1" />
        <path className="nav-tech-message-bar-b" d="M12 11v3" />
        <path className="nav-tech-message-bar-c" d="M16 9v5" />
        <circle className="nav-tech-node" cx="18.5" cy="5" r="1" />
      </svg>
    )
  }

  if (name === 'settings') {
    return (
      <svg {...iconProps} data-nav-icon={name} className="nav-tech-icon nav-tech-icon-settings">
        <path className="nav-tech-telemetry" d="M4 6h3M11 6h9M4 12h9M17 12h3M4 18h5M13 18h7" />
        <g className="nav-tech-settings-control-a">
          <rect x="7.25" y="4.25" width="3.5" height="3.5" />
          <circle className="nav-tech-node" cx="9" cy="6" r="0.8" />
        </g>
        <g className="nav-tech-settings-control-b">
          <rect x="13.25" y="10.25" width="3.5" height="3.5" />
          <circle className="nav-tech-node" cx="15" cy="12" r="0.8" />
        </g>
        <g className="nav-tech-settings-control-c">
          <rect x="9.25" y="16.25" width="3.5" height="3.5" />
          <circle className="nav-tech-node" cx="11" cy="18" r="0.8" />
        </g>
      </svg>
    )
  }

  return null
}
