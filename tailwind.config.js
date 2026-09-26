/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['IBM Plex Sans', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'monospace'],
      },
      colors: {
        brand: {
          50: '#ecfeff',
          100: '#cffafe',
          200: '#a5f3fc',
          300: '#67e8f9',
          400: '#22d3ee',
          500: '#06b6d4',
          600: '#0891b2',
          700: '#0e7490',
          800: '#155e75',
          900: '#164e63',
        },
        teal: {
          50: '#E0F7F7',
          100: '#B3ECEC',
          200: '#80DFDF',
          300: '#4DD2D2',
          400: '#26C8C8',
          500: '#00A3A1',
          600: '#008381',
          700: '#006261',
          800: '#004140',
          900: '#002120',
        },
        dark: '#111827',
        darker: '#0a0f1a',
        card: '#1a2332',
        'card-border': '#2a3444',
      },
    },
  },
  plugins: [],
}
