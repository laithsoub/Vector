// ─── Command palette (Ctrl+K) ────────────────────────────────────────────────
// Actions arrive grouped by the four nav jobs; each row shows its own
// shortcut, so the palette doubles as the place people learn them.
import { useMemo, useState } from 'react';
import { Spotlight, spotlight } from '@mantine/spotlight';
import type { LucideIcon } from 'lucide-react';
import { Search } from 'lucide-react';

import { extClasses } from './theme';
import { SHORTCUTS, Shortcut, type ShortcutName } from './shortcuts';

export interface PaletteAction {
  id: string;
  label: string;
  description?: string;
  icon?: LucideIcon;
  shortcut?: ShortcutName | string;
  /** Extra words that should match (synonyms, old names). */
  keywords?: string[];
  disabled?: boolean;
  onRun: () => void;
}

export interface PaletteGroup {
  group: string;
  actions: PaletteAction[];
}

const iconStyle = { width: 'var(--icon-md)', height: 'var(--icon-md)' };

export function CommandPalette({ groups, placeholder = 'Jump to a screen or run an action…', empty = 'Nothing matches that' }: {
  groups: PaletteGroup[];
  placeholder?: string;
  empty?: string;
}) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups
      .map(g => ({
        ...g,
        actions: g.actions.filter(a => !q ||
          [a.label, a.description, ...(a.keywords ?? [])]
            .some(s => s?.toLowerCase().includes(q))),
      }))
      .filter(g => g.actions.length > 0);
  }, [groups, query]);

  return (
    <Spotlight.Root
      query={query}
      onQueryChange={setQuery}
      shortcut={SHORTCUTS.palette}
      classNames={extClasses.spotlight}
      scrollable
      maxHeight="min(60vh, calc(var(--sp-16) * 7))"
      size="var(--modal-md)"
      clearQueryOnClose
    >
      <Spotlight.Search placeholder={placeholder}
        leftSection={<Search strokeWidth={1.75} style={iconStyle} />}
        rightSection={<Shortcut keys="close" />}
        rightSectionWidth="var(--sp-10)" />
      <Spotlight.ActionsList>
        {filtered.length === 0 && <Spotlight.Empty>{empty}</Spotlight.Empty>}
        {filtered.map(g => (
          <Spotlight.ActionsGroup key={g.group} label={g.group}>
            {g.actions.map(a => {
              const I = a.icon;
              return (
                <Spotlight.Action key={a.id}
                  label={a.label}
                  description={a.description}
                  disabled={a.disabled}
                  highlightQuery
                  leftSection={I ? <I strokeWidth={1.75} style={iconStyle} /> : undefined}
                  rightSection={a.shortcut ? <Shortcut keys={a.shortcut} /> : undefined}
                  onClick={a.onRun} />
              );
            })}
          </Spotlight.ActionsGroup>
        ))}
      </Spotlight.ActionsList>
      <Spotlight.Footer>
        <span style={{ display: 'inline-flex', gap: 'var(--sp-3)', alignItems: 'center' }}>
          <span><Shortcut keys="arrowup" /> <Shortcut keys="arrowdown" /> move</span>
          <span><Shortcut keys="Enter" /> open</span>
          <span><Shortcut keys="help" /> all shortcuts</span>
        </span>
      </Spotlight.Footer>
    </Spotlight.Root>
  );
}

export const openPalette = () => spotlight.open();

