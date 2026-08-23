// ─── Visibility-aware polling ────────────────────────────────────────────────
// Vector is a desktop app that stays open all day, so a plain setInterval keeps
// hitting the server from a minimised window nobody is looking at. The Dashboard
// alone was four API calls every eight seconds, and several of those paths reach
// Outlook COM, which the mail sweeps are already queuing behind.
//
// This skips the tick while the window is hidden and fires once as soon as it
// comes back, so returning to the app still shows fresh data immediately rather
// than whatever was on screen when it was minimised.
import { useEffect, useRef } from 'react';

export function usePolling(fn: () => void, ms: number, enabled = true) {
  // Held in a ref so a caller passing an inline arrow does not restart the timer
  // on every render — only `ms` and `enabled` should do that.
  const saved = useRef(fn);
  useEffect(() => { saved.current = fn; }, [fn]);

  useEffect(() => {
    if (!enabled || ms <= 0) return;

    const tick = () => { if (!document.hidden) saved.current(); };
    const id = window.setInterval(tick, ms);

    // Coming back to a stale screen is the case this exists for.
    const onVisible = () => { if (!document.hidden) saved.current(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ms, enabled]);
}
