import type { Config } from 'tailwindcss';

/**
 * A small, deliberate palette rather than a design system.
 *
 * One primary (indigo) carries every primary action; emerald, amber and rose are reserved
 * for state (active, warning, destructive) and never used decoratively. Light theme only:
 * one palette executed properly beats two executed at seventy percent.
 */
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#f7f8fc',
        ink: { DEFAULT: '#0f172a', muted: '#64748b', subtle: '#94a3b8' },
        line: { DEFAULT: '#e6e9f0', strong: '#d3d8e3' },
        brand: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          900: '#312e81',
        },
        ok: { DEFAULT: '#059669', soft: '#ecfdf5' },
        warn: { DEFAULT: '#b45309', soft: '#fffbeb' },
        danger: { DEFAULT: '#e11d48', soft: '#fff1f2' },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.04)',
        lift: '0 10px 30px -10px rgb(15 23 42 / 0.15), 0 2px 6px -2px rgb(15 23 42 / 0.06)',
      },
      keyframes: {
        rise: { '0%': { opacity: '0', transform: 'translateY(6px)' }, '100%': { opacity: '1', transform: 'none' } },
      },
      animation: { rise: 'rise 160ms ease-out both' },
    },
  },
  plugins: [],
} satisfies Config;
