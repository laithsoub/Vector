// ─── Mantine theme, expressed entirely in Vector's v2 tokens ─────────────────
// Split out from the provider component on purpose: React Fast Refresh only
// hot-updates a module whose exports are all components, so keeping the theme
// and the resolver here means editing either one no longer forces a full page
// reload. See src/lib/mantine.tsx for the provider itself.
//
// The scales below are the canvas's own rhythm, not Mantine's defaults (which
// run 2-3px larger everywhere — the thing that made bolted-on components look
// foreign in the first place).
import { createTheme, type CSSVariablesResolver } from '@mantine/core';

export const vectorTheme = createTheme({
  fontFamily:          'var(--font-sans)',
  fontFamilyMonospace: 'var(--font-mono)',
  headings: { fontFamily: 'var(--font-sans)', fontWeight: '600' },

  // The canvas marks focus with a border colour, never an offset ring.
  focusRing:     'never',
  cursorType:    'pointer',
  defaultRadius: 'sm',

  radius:  { xs: 'var(--r-xs)', sm: 'var(--r-sm)', md: 'var(--r-md)', lg: 'var(--r-lg)', xl: 'var(--r-xl)' },
  // v2 spacing steps — the point of a scale is that a padding can no longer be
  // invented per component.
  spacing: { xs: '6px', sm: '9px', md: '14px', lg: '18px', xl: '22px' },
  // v2 type ramp: the design tops out at 13.5px for body copy.
  fontSizes:   { xs: '10.5px', sm: '11px', md: '12px', lg: '13.5px', xl: '15px' },
  lineHeights: { xs: '1.35', sm: '1.4', md: '1.45', lg: '1.5', xl: '1.5' },
  shadows: {
    xs: 'var(--card-sh)', sm: 'var(--card-sh)', md: 'var(--pop-sh)',
    lg: 'var(--pop-sh)',  xl: 'var(--pop-sh)',
  },

  components: {
    Modal: {
      defaultProps: {
        centered: true,
        radius: 'xl',
        shadow: 'md',
        overlayProps: { backgroundOpacity: 0.5, blur: 3 },
        transitionProps: { transition: 'pop', duration: 160 },
      },
    },
    Notification: { defaultProps: { radius: 'md', withBorder: true } },
    Button:       { defaultProps: { radius: 'sm' } },
    TextInput:    { defaultProps: { radius: 'sm' } },
    Select:       { defaultProps: { radius: 'sm' } },
  },
});

// Our tokens already flip between light and dark on the `.dark` class, so the
// same mapping serves both schemes.
//
// It has to be emitted into BOTH `light` and `dark`, not into `variables`:
// `variables` lands on plain `:root`, while Mantine emits its own
// `--mantine-color-default` (and friends) under
// `:root[data-mantine-color-scheme="dark"]`, which beats `:root` on
// specificity. Put these only in `variables` and every control silently falls
// back to Mantine's stock #2e2e2e — which is exactly what happened first time.
//
// Note this covers the SEMANTIC vars only. Mantine's inputs read the raw
// palette (--mantine-color-dark-6 / dark-4) directly, so the input surface is
// pinned in index.css instead of hijacking the whole dark palette here.
const TOKEN_MAP = {
  '--mantine-color-body':            'var(--s1)',
  '--mantine-color-text':            'var(--t1)',
  '--mantine-color-bright':          'var(--t1)',
  '--mantine-color-dimmed':          'var(--t3)',
  '--mantine-color-default':         'var(--s2)',
  '--mantine-color-default-hover':   'var(--s-hover)',
  '--mantine-color-default-border':  'var(--line-2)',
  '--mantine-color-default-color':   'var(--t1)',
  '--mantine-color-placeholder':     'var(--t4)',
  '--mantine-color-anchor':          'var(--accent)',
  '--mantine-color-error':           'var(--err)',
  '--mantine-color-success':         'var(--ok)',
  '--mantine-color-disabled':        'var(--s3)',
  '--mantine-color-disabled-color':  'var(--t4)',
  '--mantine-color-disabled-border': 'var(--line)',

  '--mantine-primary-color-filled':       'var(--accent)',
  '--mantine-primary-color-filled-hover': 'var(--accent-hover)',
  '--mantine-primary-color-contrast':     'var(--accent-ink)',
  '--mantine-primary-color-light':        'var(--accent-soft)',
  '--mantine-primary-color-light-hover':  'var(--accent-soft)',
  '--mantine-primary-color-light-color':  'var(--accent-text)',
};

export const vectorCssVariables: CSSVariablesResolver = () => ({
  variables: TOKEN_MAP,
  light:     TOKEN_MAP,
  dark:      TOKEN_MAP,
});
