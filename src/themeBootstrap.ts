try {
  const theme = localStorage.getItem('theme')
  if (theme === 'dark') document.documentElement.classList.add('dark')
} catch {
  // Storage can be unavailable in hardened or first-run profiles.
}
