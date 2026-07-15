/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Geist', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono"', '"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        brand: {
          50:  '#eef4ff',
          100: '#dbe7ff',
          200: '#bdd1ff',
          300: '#92b1ff',
          400: '#6489fb',
          500: '#3f63f0',
          600: '#0044a7',  // Eaton blue
          700: '#063b8a',
          800: '#0c326f',
          900: '#0f2b58',
        },
        ink: {
          50:  '#f7f7f8',
          100: '#ececef',
          200: '#dcdce0',
          300: '#bababf',
          400: '#8b8b92',
          500: '#65656c',
          600: '#46464c',
          700: '#34343a',
          800: '#1f1f24',
          900: '#111114',
          950: '#08080a',
        },
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to:   { opacity: '1', transform: 'none' },
        },
        fadeUp: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to:   { opacity: '1', transform: 'none' },
        },
        // Low-key breathing glow for the row currently being read.
        softPulse: {
          '0%, 100%': { opacity: '1' },
          '50%':      { opacity: '0.55' },
        },
      },
      animation: {
        'fade-in':    'fadeIn 0.18s ease-out both',
        'fade-up':    'fadeUp 0.28s cubic-bezier(0.16,1,0.3,1) both',
        'soft-pulse': 'softPulse 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
