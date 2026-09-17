// ─── Mantine theme: v3 "precision instrument" ────────────────────────────────
// Every value is a token from src/index.css. Mantine derives its variants
// (light tints, hover shades) from the palette tuples, and its colour
// functions accept `var(...)` — they emit color-mix() — so the palette itself
// can live in CSS and follow the scheme.
//
// Kept out of the provider component on purpose: React Fast Refresh only
// hot-swaps a module whose exports are all components.
import {
  ActionIcon, Anchor, Autocomplete, Badge, Button, Checkbox, Combobox, Divider,
  HoverCard, Input, InputWrapper, Kbd, Loader, Menu, Modal, MultiSelect,
  NativeSelect, Notification, NumberInput, Paper, PasswordInput, Popover,
  Progress, Radio, ScrollArea, SegmentedControl, Select, Skeleton, Switch,
  Table, Tabs, TagsInput, Textarea, TextInput, Tooltip,
  createTheme, type CSSVariablesResolver, type MantineColorsTuple,
} from '@mantine/core';

import c from './theme.module.css';

const tuple = (...names: string[]) =>
  names.map(n => `var(--${n})`) as unknown as MantineColorsTuple;
const flat = (name: string) => tuple(...Array(10).fill(name));

/** Ink blue, 10 shades; shade 6 is the brand #1f4fd1. */
const ink = tuple('ink-0', 'ink-1', 'ink-2', 'ink-3', 'ink-4', 'ink-5', 'ink-6', 'ink-7', 'ink-8', 'ink-9');

// Mantine's neutrals, re-pointed at the stone scale. `gray` is read in light,
// `dark` in dark — and our tokens already hold the right value for whichever
// scheme is active, so each tuple only has to name tokens in order.
const gray = tuple('s1', 's3', 'line', 'line-2', 'line-3', 't4', 't3', 't2', 't1', 't1');
const dark = tuple('t1', 't2', 't3', 't4', 'line-3', 'line-2', 's3', 's2', 's1', 'bg');

const inputStyles = {
  wrapper: c.inputWrapper, input: c.input, section: c.inputSection,
  label: c.inputLabel, required: c.inputRequired,
  description: c.inputDescription, error: c.inputError,
};
const comboStyles = {
  ...inputStyles,
  dropdown: c.dropdown, option: c.option,
  groupLabel: c.optionsGroupLabel, empty: c.comboboxEmpty,
};
const floating = { duration: 120, transition: 'fade' as const, timingFunction: 'var(--ease)' };
const comboboxProps = { shadow: 'md', offset: 4, transitionProps: floating };

export const vectorTheme = createTheme({
  primaryColor: 'ink',
  primaryShade: 6,
  autoContrast: false,
  colors: {
    ink, gray, dark,
    blue:   ink,
    ok:     flat('ok'),
    green:  flat('ok'),
    warn:   flat('warn'),
    yellow: flat('warn'),
    orange: flat('warn'),
    err:    flat('err'),
    red:    flat('err'),
    ai:     flat('violet'),
    violet: flat('violet'),
    grape:  flat('violet'),
  },

  fontFamily:          'var(--font-sans)',
  fontFamilyMonospace: 'var(--font-mono)',
  fontSmoothing: true,
  headings: {
    fontFamily: 'var(--font-sans)',
    fontWeight: 'var(--fw-semibold)',
    textWrap: 'balance',
    sizes: {
      h1: { fontSize: 'var(--fs-2xl)', lineHeight: 'var(--lh-tight)' },
      h2: { fontSize: 'var(--fs-xl)',  lineHeight: 'var(--lh-tight)' },
      h3: { fontSize: 'var(--fs-lg)',  lineHeight: 'var(--lh-snug)' },
      h4: { fontSize: 'var(--fs-md)',  lineHeight: 'var(--lh-snug)' },
      h5: { fontSize: 'var(--fs-sm)',  lineHeight: 'var(--lh-snug)' },
      h6: { fontSize: 'var(--fs-xs)',  lineHeight: 'var(--lh-snug)' },
    },
  },
  fontSizes:   { xs: 'var(--fs-xs)', sm: 'var(--fs-sm)', md: 'var(--fs-md)', lg: 'var(--fs-lg)', xl: 'var(--fs-xl)' },
  lineHeights: { xs: 'var(--lh-snug)', sm: 'var(--lh-snug)', md: 'var(--lh-body)', lg: 'var(--lh-body)', xl: 'var(--lh-loose)' },
  // Two radii: controls and panels.
  radius:  { xs: 'var(--r-control)', sm: 'var(--r-control)', md: 'var(--r-panel)', lg: 'var(--r-panel)', xl: 'var(--r-panel)' },
  defaultRadius: 'sm',
  spacing: { xs: 'var(--sp-1)', sm: 'var(--sp-2)', md: 'var(--sp-3)', lg: 'var(--sp-4)', xl: 'var(--sp-6)' },
  // One shadow, reserved for what floats.
  shadows: {
    xs: 'none', sm: 'none',
    md: 'var(--shadow-float)', lg: 'var(--shadow-float)', xl: 'var(--shadow-float)',
  },

  focusRing: 'auto',
  focusClassName: c.focus,
  activeClassName: '',
  cursorType: 'pointer',
  respectReducedMotion: true,
  defaultGradient: { from: 'ink', to: 'ink', deg: 0 },

  components: {
    Button: Button.extend({
      defaultProps: { size: 'sm', radius: 'sm', variant: 'filled' },
      classNames: { root: c.button, section: c.buttonSection, label: c.buttonLabel },
    }),
    ActionIcon: ActionIcon.extend({
      defaultProps: { size: 'md', variant: 'subtle', color: 'gray', radius: 'sm' },
      classNames: { root: c.actionIcon },
    }),
    Anchor: Anchor.extend({ classNames: { root: c.anchor } }),

    Input:         Input.extend({ defaultProps: { size: 'sm' }, classNames: { input: c.input, section: c.inputSection } }),
    InputWrapper:  InputWrapper.extend({ classNames: { label: c.inputLabel, required: c.inputRequired, description: c.inputDescription, error: c.inputError } }),
    TextInput:     TextInput.extend({ defaultProps: { size: 'sm' }, classNames: inputStyles }),
    PasswordInput: PasswordInput.extend({ defaultProps: { size: 'sm' }, classNames: inputStyles }),
    Textarea:      Textarea.extend({ defaultProps: { size: 'sm', autosize: true, minRows: 3 }, classNames: inputStyles }),
    NativeSelect:  NativeSelect.extend({ defaultProps: { size: 'sm' }, classNames: inputStyles }),
    NumberInput:   NumberInput.extend({
      defaultProps: { size: 'sm', hideControls: true, thousandSeparator: ',', decimalSeparator: '.' },
      classNames: { ...inputStyles, input: `${c.input} ${c.monoInput}` },
    }),
    Select: Select.extend({
      defaultProps: { size: 'sm', checkIconPosition: 'right', allowDeselect: false, comboboxProps, maxDropdownHeight: 280 },
      classNames: comboStyles,
    }),
    MultiSelect:  MultiSelect.extend({ defaultProps: { size: 'sm', comboboxProps }, classNames: comboStyles }),
    TagsInput:    TagsInput.extend({ defaultProps: { size: 'sm', comboboxProps }, classNames: comboStyles }),
    Autocomplete: Autocomplete.extend({ defaultProps: { size: 'sm', comboboxProps }, classNames: comboStyles }),
    Combobox: Combobox.extend({
      defaultProps: { shadow: 'md', offset: 4, transitionProps: floating },
      classNames: { dropdown: c.dropdown, option: c.option, groupLabel: c.optionsGroupLabel, empty: c.comboboxEmpty },
    }),

    Menu: Menu.extend({
      defaultProps: { shadow: 'md', radius: 'md', position: 'bottom-end', offset: 4, withinPortal: true, transitionProps: floating },
      classNames: {
        dropdown: c.menuDropdown, item: c.menuItem, itemSection: c.menuItemSection,
        label: c.menuLabel, divider: c.menuDivider,
      },
    }),
    Popover:   Popover.extend({ defaultProps: { shadow: 'md', radius: 'md', offset: 6, transitionProps: floating }, classNames: { dropdown: c.popover } }),
    HoverCard: HoverCard.extend({ defaultProps: { shadow: 'md', radius: 'md', openDelay: 250, transitionProps: floating }, classNames: { dropdown: c.popover } }),
    Tooltip: Tooltip.extend({
      defaultProps: { openDelay: 350, withArrow: false, radius: 'sm', offset: 6, transitionProps: floating, events: { hover: true, focus: true, touch: false } },
      classNames: { tooltip: c.tooltip },
    }),

    Modal: Modal.extend({
      defaultProps: {
        centered: true,
        radius: 'md',
        shadow: 'md',
        padding: 0,
        size: 'var(--modal-md)',
        overlayProps: { backgroundOpacity: 1, blur: 0 },
        transitionProps: { transition: 'fade', duration: 160, timingFunction: 'var(--ease)' },
      },
      classNames: {
        content: c.modalContent, header: c.modalHeader, title: c.modalTitle,
        body: c.modalBody, close: c.modalClose, overlay: c.overlay,
      },
    }),

    Notification: Notification.extend({
      defaultProps: { radius: 'md', withBorder: false },
      classNames: {
        root: c.notification, icon: c.notificationIcon, title: c.notificationTitle,
        description: c.notificationDescription, loader: c.notificationLoader,
        closeButton: c.notificationClose,
      },
    }),

    Table: Table.extend({
      defaultProps: {
        verticalSpacing: 'var(--sp-2)',
        horizontalSpacing: 'var(--sp-3)',
        highlightOnHover: true,
        stickyHeader: true,
        withRowBorders: true,
        layout: 'auto',
      },
      classNames: {
        table: c.table, thead: c.tableThead, th: c.tableTh, td: c.tableTd,
        tr: c.tableTr, tfoot: c.tableTfoot, caption: c.tableCaption,
      },
    }),

    Paper: Paper.extend({
      defaultProps: { shadow: 'none', radius: 'md', withBorder: true },
      classNames: { root: c.paper },
    }),

    Tabs: Tabs.extend({
      defaultProps: { variant: 'default', keepMounted: true },
      classNames: { list: c.tabsList, tab: c.tab, tabSection: c.tabSection, panel: c.tabsPanel },
    }),

    Checkbox: Checkbox.extend({
      defaultProps: { size: 'xs', radius: 'xs' },
      classNames: { input: c.checkboxInput, icon: c.checkboxIcon, label: c.choiceLabel, description: c.choiceDescription },
    }),
    Radio: Radio.extend({
      defaultProps: { size: 'xs' },
      classNames: { radio: c.checkboxInput, icon: c.radioIcon, label: c.choiceLabel, description: c.choiceDescription },
    }),
    Switch: Switch.extend({
      defaultProps: { size: 'sm', withThumbIndicator: false },
      classNames: { input: c.switchInput, track: c.switchTrack, thumb: c.switchThumb, label: c.choiceLabel, description: c.choiceDescription },
    }),

    Badge: Badge.extend({
      defaultProps: { variant: 'light', size: 'sm', radius: 'xs' },
      classNames: { root: c.badge },
    }),
    SegmentedControl: SegmentedControl.extend({
      defaultProps: { size: 'xs', radius: 'sm', withItemsBorders: false },
      classNames: { root: c.segRoot, indicator: c.segIndicator, label: c.segLabel },
    }),
    Kbd:      Kbd.extend({ defaultProps: { size: 'xs' }, classNames: { root: c.kbd } }),
    Loader:   Loader.extend({ defaultProps: { size: 'sm', type: 'oval' }, classNames: { root: c.loader } }),
    Divider:  Divider.extend({ classNames: { root: c.divider, label: c.dividerLabel } }),
    Skeleton: Skeleton.extend({ classNames: { root: c.skeleton } }),
    Progress: Progress.extend({ defaultProps: { size: 'xs', radius: 'xl' }, classNames: { root: c.progressRoot, section: c.progressSection } }),
    ScrollArea: ScrollArea.extend({ defaultProps: { scrollbarSize: 8, type: 'hover' } }),
  },
});

/** Class names for components that live outside @mantine/core (Spotlight,
 *  Dropzone). Their packages register under the same theme keys. */
export const extClasses = {
  spotlight: {
    content: c.spotlightContent, search: c.spotlightSearch,
    actionsList: c.spotlightList, actionsGroup: c.spotlightGroup,
    action: c.spotlightAction, actionSection: c.spotlightActionSection,
    actionLabel: c.spotlightActionLabel, actionDescription: c.spotlightActionDescription,
    empty: c.spotlightEmpty, footer: c.spotlightFooter,
    overlay: c.overlay,
  },
  dropzone: { root: c.dropzone },
  tableNum: c.num,
};

/** Variant variables for each colour name: filled = the token, light = its soft
 *  tint with the token as text. Status tints read as text on a soft ground. */
function variantVars(): Record<string, string> {
  const tones: [string[], string, string, string][] = [
    // names,                               fill,           hover,           text / soft
    [['ink', 'blue'],                       'accent',       'accent-hover',  'accent-text|accent-soft'],
    [['ok', 'green', 'teal'],               'ok',           'ok',            'ok|ok-soft'],
    [['warn', 'yellow', 'orange'],          'warn',         'warn',          'warn|warn-soft'],
    [['err', 'red', 'pink'],                'err',          'err',           'err|err-soft'],
    [['ai', 'violet', 'grape', 'indigo'],   'violet',       'violet',        'violet|violet-soft'],
  ];
  const out: Record<string, string> = {};
  for (const [names, fill, hover, pair] of tones) {
    const [text, soft] = pair.split('|');
    for (const n of names) {
      const v = `--mantine-color-${n}`;
      out[`${v}-filled`]        = `var(--${fill})`;
      out[`${v}-filled-hover`]  = `color-mix(in srgb, var(--${hover}) 88%, var(--t1))`;
      out[`${v}-light`]         = `var(--${soft})`;
      out[`${v}-light-hover`]   = `color-mix(in srgb, var(--${soft}), var(--${fill}) 8%)`;
      out[`${v}-light-color`]   = `var(--${text})`;
      out[`${v}-outline`]       = `var(--${text})`;
      out[`${v}-outline-hover`] = `var(--${soft})`;
      out[`${v}-text`]          = `var(--${text})`;
      out[`${v}-contrast`]      = fill === 'accent' ? 'var(--accent-ink)' : 'var(--on-status)';
    }
  }
  out['--mantine-color-ink-filled-hover'] = 'var(--accent-hover)';
  out['--mantine-color-blue-filled-hover'] = 'var(--accent-hover)';
  return out;
}

// Semantic variables. Emitted into BOTH `light` and `dark`: Mantine writes its
// own values under `:root[data-mantine-color-scheme=…]`, which outranks plain
// `:root`, so a mapping only in `variables` would silently lose.
export const TOKEN_MAP: Record<string, string> = {
  '--mantine-color-body':            'var(--s1)',
  '--mantine-color-text':            'var(--t1)',
  '--mantine-color-bright':          'var(--t1)',
  '--mantine-color-dimmed':          'var(--t3)',
  '--mantine-color-default':         'var(--s1)',
  '--mantine-color-default-hover':   'var(--s-hover)',
  '--mantine-color-default-border':  'var(--line-2)',
  '--mantine-color-default-color':   'var(--t1)',
  '--mantine-color-placeholder':     'var(--t4)',
  '--mantine-color-anchor':          'var(--accent-text)',
  '--mantine-color-error':           'var(--err)',
  '--mantine-color-success':         'var(--ok)',
  '--mantine-color-disabled':        'var(--s3)',
  '--mantine-color-disabled-color':  'var(--t4)',
  '--mantine-color-disabled-border': 'var(--line)',
  '--mantine-color-dark-light':      'var(--s3)',
  '--mantine-color-gray-light':      'var(--s3)',
  '--mantine-color-gray-light-hover':'var(--s-hover)',
  '--mantine-color-gray-light-color':'var(--t2)',
  '--mantine-color-gray-text':       'var(--t2)',

  '--mantine-primary-color-filled':       'var(--accent)',
  '--mantine-primary-color-filled-hover': 'var(--accent-hover)',
  '--mantine-primary-color-contrast':     'var(--accent-ink)',
  '--mantine-primary-color-light':        'var(--accent-soft)',
  '--mantine-primary-color-light-hover':  'var(--selection)',
  '--mantine-primary-color-light-color':  'var(--accent-text)',
  '--mantine-primary-color-outline':      'var(--accent-text)',
  '--mantine-primary-color-outline-hover':'var(--accent-soft)',

  // Every palette's variant variables, generated below so no colour name can
  // fall back to Mantine's stock values.
  ...variantVars(),
};

export const vectorCssVariables: CSSVariablesResolver = () => ({
  variables: {
    '--mantine-z-index-app':      'var(--z-sidebar)',
    '--mantine-z-index-modal':    'var(--z-modal)',
    '--mantine-z-index-popover':  'var(--z-modal)',
    '--mantine-z-index-overlay':  'var(--z-overlay)',
    '--mantine-z-index-max':      'var(--z-toast)',
    '--mantine-scale':            '1',
  },
  light: TOKEN_MAP,
  dark:  TOKEN_MAP,
});
