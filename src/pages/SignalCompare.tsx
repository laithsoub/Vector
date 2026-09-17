// ─── Signal colour comparison (ui-sample only) ───────────────────────────────
// Candidate trademark colours shown on the same mini shell, in both themes.
// Each option only sets --signal and --signal-soft on its cell.
import type React from 'react';
import { Inbox, LayoutDashboard, Search, Sparkles, Tags } from 'lucide-react';

import { SchemeScope } from '../ui';

interface Option {
  id: string;
  name: string;
  note: string;
  light: string;
  dark: string;
}

const OPTIONS: Option[] = [
  { id: 'today',  name: 'Before',         note: 'Every mark is the blue accent.', light: 'var(--accent)', dark: 'var(--accent)' },
  { id: 'signal', name: 'Tinted orange',  note: 'Chosen: the signal token, redder and softer than the amber warning.', light: 'var(--signal)', dark: 'var(--signal)' },
];

function vars(color: string, scheme: 'light' | 'dark'): React.CSSProperties {
  return {
    '--signal': color,
    '--signal-soft': `color-mix(in srgb, ${color} ${scheme === 'dark' ? 16 : 12}%, transparent)`,
  } as React.CSSProperties;
}

const NAV = [
  { icon: Inbox, label: 'Inbox', count: 3, active: true },
  { icon: Sparkles, label: 'Ask Vector' },
  { icon: LayoutDashboard, label: 'Dashboard' },
  { icon: Tags, label: 'LSD Pricing' },
];

function Cell({ opt, scheme }: { opt: Option; scheme: 'light' | 'dark' }) {
  const signal = 'var(--signal)';
  return (
    <SchemeScope scheme={scheme} className="sig-cell min-w-0 rounded-panel border border-line overflow-hidden">
      <div style={vars(scheme === 'dark' ? opt.dark : opt.light, scheme)} className="flex h-full">
        {/* sidebar */}
        <aside className="w-32 shrink-0 border-r border-line bg-surface p-2 flex flex-col gap-1">
          <div className="flex items-center gap-2 px-1.5 pb-2">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-control bg-accent text-sm font-semibold"
              style={{ color: 'var(--accent-ink)', boxShadow: `0 0 0 1.5px var(--s1), 0 0 0 3px ${signal}` }}>V</span>
            <span className="text-sm font-semibold text-fg">Vector</span>
          </div>
          {NAV.map(n => (
            <div key={n.label} className={`relative flex items-center gap-2 h-7 px-2 rounded-control text-sm ${n.active ? 'bg-subtle text-fg font-medium' : 'text-fg-2'}`}>
              {n.active && <span className="absolute left-0 top-1.5 bottom-1.5 rounded-full" style={{ width: 2, background: signal }} />}
              <n.icon className="w-3.5 h-3.5" strokeWidth={1.75} />
              <span className="flex-1">{n.label}</span>
              {n.count != null && (
                <span className="inline-flex items-center gap-1 text-2xs font-mono text-fg-2">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: signal }} />{n.count}
                </span>
              )}
            </div>
          ))}
        </aside>

        {/* content */}
        <div className="flex-1 min-w-0 bg-page flex flex-col">
          <div className="flex items-center gap-2 h-10 px-3 border-b border-line">
            <span className="text-sm font-semibold text-fg">Inbox</span>
            <div className="flex-1" />
            <span className="inline-flex items-center gap-1.5 h-6 px-2 rounded-full border border-line text-2xs text-fg-2">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: signal, boxShadow: `0 0 0 3px var(--signal-soft)` }} />Al-Soub
            </span>
          </div>
          <div className="flex gap-4 px-3 border-b border-line text-sm">
            {['Home', 'Vector AI', 'Tools'].map((t, i) => (
              <span key={t} className={`py-2 ${i === 1 ? 'text-fg font-medium' : 'text-fg-3'}`}
                style={i === 1 ? { boxShadow: `inset 0 -2px 0 ${signal}` } : undefined}>{t}</span>
            ))}
          </div>

          <div className="p-3 flex flex-col gap-3">
            <div className="flex items-center gap-2 h-8 px-2.5 rounded-control bg-surface border border-line text-sm text-fg-3"
              style={{ outline: `2px solid ${signal}`, outlineOffset: 1 }}>
              <Search className="w-3.5 h-3.5" />
              <span className="flex-1">Jump to…</span>
              <kbd className="font-mono text-2xs px-1.5 rounded-control"
                style={{ border: `1px solid ${signal}`, color: 'var(--t1)', background: 'var(--signal-soft)' }}>Ctrl K</kbd>
            </div>

            <p className="text-sm text-fg-2 leading-relaxed m-0">
              Quote <mark className="text-fg rounded-control px-0.5" style={{ background: 'var(--signal-soft)', boxShadow: `inset 0 -1.5px 0 ${signal}` }}>W262224492E</mark> is
              waiting on a price. Select this text to see the highlight.
            </p>

            <div className="flex flex-wrap items-center gap-1.5">
              <button type="button" className="h-7 px-3 rounded-control bg-accent text-sm font-medium" style={{ color: 'var(--accent-ink)' }}>Primary action</button>
              <span className="inline-flex items-center h-6 px-2 rounded-full text-2xs font-medium bg-warn-soft text-warn">Needs review</span>
              <span className="inline-flex items-center h-6 px-2 rounded-full text-2xs font-medium bg-ok-soft text-ok">Approved</span>
            </div>
          </div>
        </div>
      </div>
    </SchemeScope>
  );
}

export function SignalCompare() {
  return (
    <section className="px-page py-6 hairline-b">
      <style>{'.sig-cell ::selection { background: var(--signal-soft); color: var(--t1); }'}</style>
      <div className="eyebrow mb-1">Trademark colour</div>
      <p className="text-sm text-fg-3 mb-4 mt-0">
        Same screen before and after. Look at the active nav bar, the unread dot, the status dot, the tab underline,
        the focus ring, the Ctrl K chip, the highlighted quote number and the edge of the V logo.
      </p>
      <div className="grid gap-4 grid-cols-1 xl:grid-cols-2">
        {OPTIONS.map(o => (
          <div key={o.id} className="min-w-0 flex flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <span className="text-base font-semibold text-fg">{o.name}</span>
              {o.id !== 'today' && <span className="font-mono text-2xs text-fg-3">#c2602f / #e98a5c</span>}
            </div>
            <p className="text-xs text-fg-3 m-0">{o.note}</p>
            <Cell opt={o} scheme="light" />
            <Cell opt={o} scheme="dark" />
          </div>
        ))}
      </div>
    </section>
  );
}
