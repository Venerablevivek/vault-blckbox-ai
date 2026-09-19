import type { Config } from 'tailwindcss';

/** A theme colour: an RGB triple from a CSS variable, so opacity modifiers (bg-line/50) still work. */
const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

/**
 * A small, deliberate palette rather than a design system.
 *
 * One primary (indigo) carries every primary action; emerald, amber and rose are reserved
 * for state (active, warning, destructive) and never used decoratively. Every colour is a CSS
 * variable (see globals.css), defined once for the light theme and once for the dark one, so
 * components name what a colour is for (surface, ink, line) rather than what it looks like.
 */
export default {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        canvas: v('canvas'),
        surface: { DEFAULT: v('surface'), sunken: v('surface-sunken'), muted: v('surface-muted') },
        ink: { DEFAULT: v('ink'), muted: v('ink-muted'), subtle: v('ink-subtle') },
        line: { DEFAULT: v('line'), strong: v('line-strong') },
        brand: {
          50: v('brand-50'),
          100: v('brand-100'),
          200: v('brand-200'),
          400: v('brand-400'),
          500: v('brand-500'),
          600: v('brand-600'),
          700: v('brand-700'),
          800: v('brand-800'),
          900: v('brand-900'),
        },
        ok: { DEFAULT: v('ok'), soft: v('ok-soft') },
        warn: { DEFAULT: v('warn'), soft: v('warn-soft') },
        danger: { DEFAULT: v('danger'), soft: v('danger-soft') },
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
