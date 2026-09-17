// ─── Keyboard shortcuts: one registry, one way to show them ──────────────────
// Every shortcut the app answers to is named here, so a tooltip, a palette row
// and the "?" sheet all print the same keys the handler listens for.
import React, { createContext, useContext } from 'react';
import { Kbd as MKbd } from '@mantine/core';
import { useHotkeys, type HotkeyItem } from '@mantine/hooks';

export const SHORTCUTS = {
  palette:  'mod+K',
  save:     'mod+S',
  submit:   'mod+Enter',
  close:    'Escape',
  help:     'shift+/',
  theme:    'mod+shift+L',
  goDashboard: 'alt+1',
  goAssistant: 'alt+2',
  goInbox:     'alt+3',
  goHistory:   'alt+4',
  goAnalytics: 'alt+5',
  goReport:    'alt+6',
} as const;
export type ShortcutName = keyof typeof SHORTCUTS;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const KEY_LABEL: Record<string, string> = {
  mod: isMac ? '⌘' : 'Ctrl', ctrl: 'Ctrl', alt: isMac ? '⌥' : 'Alt', shift: 'Shift',
  enter: 'Enter', escape: 'Esc', '/': '?', arrowup: '↑', arrowdown: '↓',
};

/** 'mod+shift+/' → ['Ctrl', '?'] (shift is implied by the glyph it produces). */
export function shortcutKeys(combo: string): string[] {
  const parts = combo.split('+');
  const keys = parts.map(p => KEY_LABEL[p.toLowerCase()] ?? p.toUpperCase());
  if (parts.includes('/') && parts.includes('shift')) return keys.filter(k => k !== 'Shift');
  return keys;
}

/** Keycap row for a shortcut name or a raw combo. */
export function Shortcut({ keys, className }: { keys: ShortcutName | string; className?: string }) {
  const combo = (SHORTCUTS as Record<string, string>)[keys] ?? keys;
  return (
    <span className={className} style={{ display: 'inline-flex', gap: 'var(--sp-0-5)', alignItems: 'center' }}>
      {shortcutKeys(combo).map((k, i) => <MKbd key={i}>{k}</MKbd>)}
    </span>
  );
}

// ─── Screen scope ────────────────────────────────────────────────────────────
// Visited tabs stay mounted (hidden with display:none), so a page-level Ctrl+S
// would fire on every page ever opened. App wraps each tab in a ScreenScope and
// the hooks below stay silent unless their screen is the one on show.
const ScreenActive = createContext(true);
export function ScreenScope({ active, children }: { active: boolean; children: React.ReactNode }) {
  return <ScreenActive.Provider value={active}>{children}</ScreenActive.Provider>;
}
export const useScreenActive = () => useContext(ScreenActive);

type Handler = (() => void) | undefined | false;

/** Ctrl+S saves, Ctrl+Enter submits, Esc closes — for the active screen or
 *  dialog. These fire from inside fields too: that is where people press them. */
export function useFormHotkeys({ onSave, onSubmit, onClose, enabled = true }: {
  onSave?: Handler; onSubmit?: Handler; onClose?: Handler; enabled?: boolean;
}) {
  const active = useScreenActive() && enabled;
  const items: HotkeyItem[] = [];
  const wrap = (fn: Handler) => (e: KeyboardEvent) => {
    if (!active || !fn) return;
    e.preventDefault();
    fn();
  };
  if (onSave)   items.push([SHORTCUTS.save,   wrap(onSave),   { preventDefault: false }]);
  if (onSubmit) items.push([SHORTCUTS.submit, wrap(onSubmit), { preventDefault: false }]);
  if (onClose)  items.push([SHORTCUTS.close,  wrap(onClose),  { preventDefault: false }]);
  useHotkeys(items, []);
}

/** App-level shortcuts (palette, navigation). Ignored while typing in a field. */
export function useAppHotkeys(map: Partial<Record<ShortcutName, () => void>>) {
  useHotkeys(
    (Object.entries(map) as [ShortcutName, () => void][])
      .map(([name, fn]) => [SHORTCUTS[name], fn] as HotkeyItem),
  );
}
