/** @type {import('tailwindcss').Config} */
// Tailwind is layout plumbing only. Every colour, radius, font and type size
// below resolves to a token in src/index.css, so a utility can never introduce
// a value the design system does not own.
const v = name => `var(--${name})`;

export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [v('font-sans')],
        mono: [v('font-mono')],
      },
      borderColor: { DEFAULT: v('line') },
      ringColor:   { DEFAULT: v('focus') },
      boxShadow: {
        float: v('shadow-float'),
      },
      backgroundImage: {
        'ai-grad': v('ai-grad'),
        'ai-wash': v('ai-wash'),
      },
      spacing: {
        // Large steps on the same 4px grid, for fixed panel widths.
        104: '26rem', 112: '28rem', 120: '30rem', 128: '32rem', 140: '35rem',
        160: '40rem', 180: '45rem', 200: '50rem', 240: '60rem', 280: '70rem', 320: '80rem',
        header:  v('header-h'),
        sidebar: v('sidebar-w'),
        page:    v('pad-page'),
        gap:     v('gap-page'),
        'h-xs':  v('h-xs'),
        'h-sm':  v('h-sm'),
        'h-md':  v('h-md'),
        'h-lg':  v('h-lg'),
      },
      maxWidth: { measure: v('measure') },
      zIndex: {
        sticky: v('z-sticky'), rail: v('z-rail'), sidebar: v('z-sidebar'),
        overlay: v('z-overlay'), modal: v('z-modal'), toast: v('z-toast'),
      },
      transitionDuration: { DEFAULT: v('dur'), fast: v('dur-fast') },
      transitionTimingFunction: { DEFAULT: v('ease') },
      keyframes: {
        fadeIn:    { from: { opacity: '0' }, to: { opacity: '1' } },
        softPulse: { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.55' } },
      },
      animation: {
        'fade-in':    `fadeIn ${v('dur')} ${v('ease')} both`,
        'fade-up':    `fadeIn ${v('dur')} ${v('ease')} both`,
        'soft-pulse': 'softPulse 1.4s ease-in-out infinite',
      },
    },
    // Replaced, not extended: the only colours that exist are tokens.
    colors: {
      transparent: 'transparent',
      current:     'currentColor',
      inherit:     'inherit',
      page:     v('bg'),
      surface:  v('s1'),
      raised:   v('s2'),
      subtle:   v('s3'),
      hover:    v('s-hover'),
      sunk:     v('s-sunk'),
      fg:       { DEFAULT: v('t1'), 2: v('t2'), 3: v('t3'), 4: v('t4'), tab: v('t-tab') },
      line:     { DEFAULT: v('line'), 2: v('line-2'), 3: v('line-3') },
      accent:   { DEFAULT: v('accent'), hover: v('accent-hover'), ink: v('accent-ink'),
                  text: v('accent-text'), soft: v('accent-soft'), line: v('accent-line') },
      ok:       { DEFAULT: v('ok'),     soft: v('ok-soft'),     line: v('ok-line') },
      warn:     { DEFAULT: v('warn'),   soft: v('warn-soft'),   line: v('warn-line') },
      err:      { DEFAULT: v('err'),    soft: v('err-soft'),    line: v('err-line') },
      signal:   { DEFAULT: v('signal'), soft: v('signal-soft'), line: v('signal-line') },
      ai:       { DEFAULT: v('violet'), soft: v('violet-soft'), line: v('violet-line') },
      'on-status': v('on-status'),
      'on-accent': { DEFAULT: v('accent-ink'), soft: v('on-accent-soft') },
      overlay:  v('overlay'),
      term:     { DEFAULT: v('term'), fg: v('term-fg') },
    },
    // Replaced, not extended: v3 has two radii and one type ramp.
    borderRadius: {
      none: '0',
      sm: v('r-control'), DEFAULT: v('r-control'), md: v('r-control'),
      lg: v('r-panel'), xl: v('r-panel'), '2xl': v('r-panel'), '3xl': v('r-panel'),
      control: v('r-control'), panel: v('r-panel'),
      full: v('r-round'),
    },
    fontSize: {
      '2xs':  [v('fs-2xs'), { lineHeight: v('lh-snug') }],
      xs:     [v('fs-xs'),  { lineHeight: v('lh-snug') }],
      sm:     [v('fs-sm'),  { lineHeight: v('lh-body') }],
      base:   [v('fs-md'),  { lineHeight: v('lh-body') }],
      md:     [v('fs-md'),  { lineHeight: v('lh-body') }],
      lg:     [v('fs-lg'),  { lineHeight: v('lh-snug') }],
      xl:     [v('fs-xl'),  { lineHeight: v('lh-snug') }],
      '2xl':  [v('fs-2xl'), { lineHeight: v('lh-tight') }],
      '3xl':  [v('fs-3xl'), { lineHeight: v('lh-tight') }],
      '4xl':  [v('fs-4xl'), { lineHeight: v('lh-tight') }],
    },
  },
  plugins: [],
};
