// ─── Keep awake — header toggle ──────────────────────────────────────────────
// On: the PC never sleeps or blanks, and Teams stays "Available" while nobody
// touches it (automation/keep_awake.py presses F15 only after a minute idle).
// Stays on until clicked off, across server restarts. Must be on BEFORE the
// session locks — Windows drops injected input on the lock screen.
import React, { useEffect, useState } from 'react';
import { ActionIcon } from '@mantine/core';

import { Tooltip, notify } from '../ui';

type State = { on: boolean; since: string | null };

export function KeepAwakeButton() {
  const [st, setSt] = useState<State>({ on: false, since: null });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => fetch('/api/keepawake', { cache: 'no-store' })
      .then(r => r.json()).then(j => { if (alive) setSt(j); }).catch(() => {});
    load();
    const t = setInterval(load, 60_000);   // reflects a helper that died
    return () => { alive = false; clearInterval(t); };
  }, []);

  const toggle = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/keepawake', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: !st.on }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setSt(j);
      notify.success(j.on
        ? 'Keep awake on — PC will not sleep, Teams stays Available. Leave it unlocked.'
        : 'Keep awake off');
    } catch (e: any) {
      notify.error('Keep awake failed', e);
    } finally { setBusy(false); }
  };

  const since = st.since ? new Date(st.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const label = st.on
    ? `Keeping the PC and Teams awake since ${since} — click to stop`
    : 'Keep the PC awake and Teams Available while you are away (switch on before locking)';
  return (
    <Tooltip label={label}>
      <ActionIcon variant="subtle" color="gray" size="md" className="shrink-0"
        onClick={toggle} disabled={busy} aria-pressed={st.on} aria-label={label}>
        <CoffeeCup on={st.on} />
      </ActionIcon>
    </Tooltip>
  );
}

// Grey, still cup when off; a full black cup with rising steam when on.
// Colours come from the text tiers, so "black" turns light in dark theme.
function CoffeeCup({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor"
      strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"
      className={on ? 'text-fg' : 'text-fg-4'} aria-hidden>
      <style>{`
        @keyframes vk-steam {
          0%   { opacity: 0; transform: translateY(2px); }
          35%  { opacity: 1; }
          100% { opacity: 0; transform: translateY(-3px); }
        }
        .vk-steam { animation: vk-steam 1.8s ease-out infinite; }
        @media (prefers-reduced-motion: reduce) { .vk-steam { animation: none; opacity: .8; } }
      `}</style>
      {on && (
        <g>
          <path className="vk-steam" d="M8 2.5c-.6.8.6 1.7 0 2.5" />
          <path className="vk-steam" d="M11.5 2.5c-.6.8.6 1.7 0 2.5" style={{ animationDelay: '.6s' }} />
          <path className="vk-steam" d="M15 2.5c-.6.8.6 1.7 0 2.5" style={{ animationDelay: '1.2s' }} />
        </g>
      )}
      <path d="M17 8h1a3 3 0 0 1 0 6h-1" />
      <path d="M4 8h13v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8z" fill={on ? 'currentColor' : 'none'} />
    </svg>
  );
}
