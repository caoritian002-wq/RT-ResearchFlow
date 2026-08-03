/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/**/*.{js,ts,jsx,tsx,html}'],
  theme: {
    extend: {
      colors: {
        critical: {
          DEFAULT: '#dc2626',
          light: '#fef2f2',
          border: '#fca5a5'
        },
        important: {
          DEFAULT: '#d97706',
          light: '#fffbeb',
          border: '#fcd34d'
        },
        general: {
          DEFAULT: '#2563eb',
          light: '#eff6ff',
          border: '#93c5fd'
        }
      }
    }
  },
  plugins: [require('@tailwindcss/typography')]
}
