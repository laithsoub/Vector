// ─── Restart server — header button ──────────────────────────────────────────
// Asks the server to respawn itself (POST /api/server/restart), waits for a
// /api/ping answering with a NEW boot id, then reloads this page in place.
// The thin bar under the label is the progress: stopping → starting → reload.
import React, { useEffect, useRef, useState } from 'react';
import { RotateCw } from 'lucide-react';

import { Button, notify } from '../ui';

type Phase = 'idle' | 'stopping' | 'starting' | 'reloading';

const LABEL: Record<Phase, string> = {
  idle: 'Restart', stopping: 'Stopping…', starting: 'Starting…', reloading: 'Reloading…',
};
// A cold dev start (tsx + Vite) is ~6–10 s; the bar eases toward 95% over this
// and only fills when the new server actually answers.
const EXPECTED_MS = 9000;
const GIVE_UP_MS  = 60_000;

async function ping(): Promise<string | null> {
  try {
    const r = await fetch('/api/ping', { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json()).boot ?? null;
  } catch { return null; }
}

export function RestartButton() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [pct, setPct] = useState(0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const run = async () => {
    setPhase('stopping'); setPct(4);
    let oldBoot: string | null = null;
    try {
      const r = await fetch('/api/server/restart', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      oldBoot = j.boot ?? null;
    } catch (e: any) {
      notify.error('Restart failed', e);
      setPhase('idle'); setPct(0);
      return;
    }

    const t0 = Date.now();
    while (alive.current && Date.now() - t0 < GIVE_UP_MS) {
      await new Promise(r => setTimeout(r, 400));
      const elapsed = Date.now() - t0;
      setPct(4 + 91 * (1 - Math.exp(-elapsed / (EXPECTED_MS / 2.5))));
      const boot = await ping();
      if (boot === null) { setPhase('starting'); continue; }
      if (boot !== oldBoot) {
        setPhase('reloading'); setPct(100);
        setTimeout(() => window.location.reload(), 250);
        return;
      }
    }
    if (!alive.current) return;
    notify.error('The server did not come back within a minute — check vector-err.log or run start-app.ps1.');
    setPhase('idle'); setPct(0);
  };

  const busy = phase !== 'idle';
  return (
    <Button tone="secondary" className="shrink-0" onClick={run} disabled={busy}
      hint={busy ? undefined : 'Restart the Vector server and reload this page'}
      icon={<RotateCw className={busy ? 'animate-spin' : undefined} />}
      style={{ position: 'relative', overflow: 'hidden' }}>
      {LABEL[phase]}
      {busy && (
        <span aria-hidden className="absolute left-0 bottom-0 h-0.5 bg-accent transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%` }} />
      )}
    </Button>
  );
}
