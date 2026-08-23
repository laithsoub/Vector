// ─── Salesman roster ─────────────────────────────────────────────────────────
// Colleagues' names, work emails and personal mobile numbers. This used to be a
// hardcoded array in three separate source files, so it was committed to the
// repository — which was public for a while. It now lives in config.json, which
// is gitignored: entered once per install, never committed again.
//
// Fetched once per session and shared: the CBU sizer and the Inbox CBU generator
// both need it, and neither should trigger its own request.
import { api } from './api';
import { useEffect, useState } from 'react';

export interface Salesman { name: string; email: string; phone: string }

let _cache: Salesman[] | null = null;
let _inflight: Promise<Salesman[]> | null = null;

export function loadSalesmen(): Promise<Salesman[]> {
  if (_cache) return Promise.resolve(_cache);
  // Two components mounting together must not fire two requests.
  if (_inflight) return _inflight;
  _inflight = api.config()
    .then(cfg => {
      const raw = (cfg as any)?.cbu_salesmen;
      _cache = Array.isArray(raw)
        ? raw.filter((r: any) => r?.name).map((r: any) => ({
            name:  String(r.name).trim(),
            email: String(r.email || '').trim(),
            phone: String(r.phone || '').trim(),
          }))
        : [];
      return _cache;
    })
    .catch(() => {
      // Not cached on failure, so the next mount retries rather than being stuck
      // with an empty roster for the rest of the session.
      return [];
    })
    .finally(() => { _inflight = null; });
  return _inflight;
}

/** Empty until loaded — callers should handle the empty case, not assume a delay. */
export function useSalesmen(): Salesman[] {
  const [list, setList] = useState<Salesman[]>(() => _cache ?? []);
  useEffect(() => {
    let alive = true;
    void loadSalesmen().then(r => { if (alive) setList(r); });
    return () => { alive = false; };
  }, []);
  return list;
}
