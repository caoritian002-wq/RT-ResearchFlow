interface AppLogoProps {
  size?: number
  className?: string
}

export function AppLogo({ size = 20, className = '' }: AppLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label="RT-ResearchFlow"
      className={className}
    >
      <defs>
        <linearGradient id="rt-ai-logo-surface" x1="8" y1="6" x2="40" y2="42" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0F766E" />
          <stop offset="0.58" stopColor="#0EA5E9" />
          <stop offset="1" stopColor="#1D4ED8" />
        </linearGradient>
        <linearGradient id="rt-ai-logo-line" x1="11" y1="30" x2="38" y2="15" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ECFEFF" />
          <stop offset="1" stopColor="#BAE6FD" />
        </linearGradient>
      </defs>
      <rect x="3" y="3" width="42" height="42" rx="12" fill="url(#rt-ai-logo-surface)" />
      <path d="M12 32.5L19 25.5L25 28.5L36 16" fill="none" stroke="url(#rt-ai-logo-line)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 16.5H16.5M12 22.5H16.5M12 28.5H16.5" stroke="#DFFBFF" strokeWidth="2" strokeLinecap="round" opacity="0.72" />
      <circle cx="36" cy="16" r="4.5" fill="#ECFEFF" />
      <circle cx="36" cy="16" r="2" fill="#0284C7" />
      <path d="M31.5 33.5H37" stroke="#E0F2FE" strokeWidth="2.4" strokeLinecap="round" opacity="0.9" />
      <path d="M33 37.5H39" stroke="#E0F2FE" strokeWidth="2.4" strokeLinecap="round" opacity="0.62" />
    </svg>
  )
}
