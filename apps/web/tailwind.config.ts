import type { Config } from 'tailwindcss';

/**
 * Design tokens.
 *
 * Deliberately restrained: one accent colour, a neutral scale, and semantic status colours.
 * The brief asks for a product that feels calm and professional rather than decorated, and the
 * fastest route to the opposite is a palette with six accents that every developer picks from
 * differently.
 *
 * The accent is a deep teal rather than the default blue — it reads as institutional without
 * looking like every other admin template, and it holds contrast against both white and the
 * dark surface.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Semantic names, not visual ones. `surface` can become dark without renaming.
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          muted: 'rgb(var(--surface-muted) / <alpha-value>)',
          raised: 'rgb(var(--surface-raised) / <alpha-value>)',
        },
        content: {
          DEFAULT: 'rgb(var(--content) / <alpha-value>)',
          muted: 'rgb(var(--content-muted) / <alpha-value>)',
          subtle: 'rgb(var(--content-subtle) / <alpha-value>)',
          inverted: 'rgb(var(--content-inverted) / <alpha-value>)',
        },
        line: {
          DEFAULT: 'rgb(var(--line) / <alpha-value>)',
          strong: 'rgb(var(--line-strong) / <alpha-value>)',
        },
        accent: {
          50: '#eefbf7',
          100: '#d5f5eb',
          200: '#aeead9',
          300: '#7ad8c1',
          400: '#45bea4',
          500: '#22a189',
          600: '#15816f',
          700: '#13675b',
          800: '#13524a',
          900: '#13453f',
          950: '#042722',
        },
        success: { DEFAULT: '#15803d', subtle: '#dcfce7' },
        warning: { DEFAULT: '#b45309', subtle: '#fef3c7' },
        danger: { DEFAULT: '#b91c1c', subtle: '#fee2e2' },
        info: { DEFAULT: '#1d4ed8', subtle: '#dbeafe' },
      },
      fontFamily: {
        // Hind Siliguri covers Bengali properly; the system stack handles Latin. Listing both
        // means a Bangla name and an English name on the same row have compatible metrics.
        sans: [
          'var(--font-sans)',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Noto Sans Bengali',
          'Hind Siliguri',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        // A tighter scale than Tailwind's default: an admin product needs fewer sizes, used
        // consistently, more than it needs a wide range.
        xs: ['0.75rem', { lineHeight: '1rem' }],
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
        base: ['0.875rem', { lineHeight: '1.375rem' }],
        lg: ['1rem', { lineHeight: '1.5rem' }],
        xl: ['1.125rem', { lineHeight: '1.625rem' }],
        '2xl': ['1.375rem', { lineHeight: '1.875rem' }],
        '3xl': ['1.75rem', { lineHeight: '2.25rem' }],
      },
      borderRadius: {
        sm: '0.25rem',
        DEFAULT: '0.375rem',
        md: '0.5rem',
        lg: '0.75rem',
      },
      boxShadow: {
        // Low-contrast shadows: elevation should be felt, not seen.
        card: '0 1px 2px rgb(15 23 42 / 0.04), 0 1px 3px rgb(15 23 42 / 0.06)',
        popover: '0 4px 6px -1px rgb(15 23 42 / 0.08), 0 2px 4px -2px rgb(15 23 42 / 0.06)',
      },
    },
  },
  plugins: [],
};

export default config;
