// ─── Local cache — last good answers, kept on this device ────────────────────
// Every page used to open blank and wait for its first fetch, and every reload
// threw away what the session had already read (the Inbox list is a COM sweep
// that takes seconds). Now each tracked read leaves its last good answer here,
// and the page paints that at once, then swaps in the fresh one when it lands
// (stale-while-revalidate).
//
// Storage: IndexedDB ("vector-cache"), not localStorage — localStorage is ~5 MB
// for the whole origin and the Assistant's conversations already live there.
// The whole store is read into memory once before the first render
// (hydrateLocalCache in main.tsx), so peek() is synchronous and a page can use
// it straight in a useState initialiser.
//
// Traceable on purpose:
//   • every key belongs to a family declared in CACHE_FAMILIES below — the one
//     list of what is cached, where it comes from and how long it is shown;
//   • each entry carries savedAt, its source endpoint and its size;
//   • Settings → Local cache lists every entry and can clear one or all;
//   • in DevTools: `vectorCache.list()`, `vectorCache.get(key)`, `vectorCache.clear()`,
//     and `localStorage.vector_cache_debug = '1'` logs every save/serve.
//
// A cached answer is only ever a first paint — the live fetch always follows,
// and nothing here is sent anywhere. /api/config is deliberately NOT cached: it
// can carry keys, and those stay on the server side only. Writes are skipped when the answer has not
// changed, so a page polling every few seconds does not rewrite the disk.
import { useEffect, useState } from 'react';

export interface CacheFamily {
  label: string;      // what the user sees in Settings
  source: string;     // the endpoint the data comes from
  maxAgeH: number;    // older than this is not shown at all (and gets pruned)
  v: number;          // response shape version — BUMP when the endpoint's shape
                      // changes, so old copies are dropped instead of crashing a page
}

// The ONE list of what is cached locally. A key is `family` or `family:detail`.
export const CACHE_FAMILIES = {
  'dashboard.stats':   { label: 'Dashboard counters',          source: '/api/stats',            maxAgeH: 24,     v: 1 },
  'jobs':              { label: 'Run history',                 source: '/api/jobs',             maxAgeH: 24 * 7, v: 1 },
  'archive':           { label: 'Archive days',                source: '/api/archive',          maxAgeH: 24 * 7, v: 1 },
  'inbox.list':        { label: 'Inbox email list',            source: '/api/outlook/emails',   maxAgeH: 24 * 3, v: 1 },
  'todo.list':         { label: 'To-Do board',                 source: '/api/todo',             maxAgeH: 24 * 3, v: 1 },
  'crm.companies':     { label: 'CRM accounts',                source: '/api/crm/companies',    maxAgeH: 24 * 7, v: 1 },
  'analytics':         { label: 'Analytics',                   source: '/api/analytics',        maxAgeH: 24 * 7, v: 1 },
  'lsd.queue':         { label: "LSD queue (Dalia's sheet)",   source: '/api/lsd/queue',        maxAgeH: 24 * 2, v: 1 },
  'lsd.updates':       { label: 'LSD Dalia & Kiran feed',      source: '/api/lsd/updates',      maxAgeH: 24 * 2, v: 1 },
  'lsd.cases':         { label: 'LSD case archive',            source: '/api/lsd/cases',        maxAgeH: 24 * 7, v: 1 },
  'lsd.register':      { label: 'LSD daily register',          source: '/api/lsd/register',     maxAgeH: 24 * 2, v: 1 },
} satisfies Record<string, CacheFamily>;

export type CacheFamilyId = keyof typeof CACHE_FAMILIES;
export type CacheKey = CacheFamilyId | `${CacheFamilyId}:${string}`;

export interface CacheEntry<T = unknown> {
  key: string;
  data: T;
  savedAt: number;    // ms epoch
  source: string;
  bytes: number;      // size of the JSON, for the Settings list
  hash: number;       // of the JSON — an unchanged answer is not rewritten
  v: number;          // the family's shape version it was saved under
}

const DB_NAME = 'vector-cache';
const STORE = 'entries';
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;   // one answer bigger than this is not kept

const mem = new Map<string, CacheEntry>();
const diskAt = new Map<string, number>();   // when each entry last hit IndexedDB
const listeners = new Set<() => void>();
let dbp: Promise<IDBDatabase | null> | null = null;

const debugOn = () => { try { return localStorage.getItem('vector_cache_debug') === '1'; } catch { return false; } };
const log = (...a: unknown[]) => { if (debugOn()) console.debug('[cache]', ...a); };
const notify = () => listeners.forEach(fn => fn());

export function familyOf(key: string): CacheFamily | undefined {
  return (CACHE_FAMILIES as Record<string, CacheFamily>)[key.split(':')[0]];
}

// FNV-1a — cheap, and only used to spot "same answer as last time".
function hashOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise(resolve => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'key' }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);          // private window / blocked storage
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}

function tx(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => void): void {
  void openDb().then(db => {
    if (!db) return;
    try { fn(db.transaction(STORE, mode).objectStore(STORE)); } catch (e) { log('write failed', e); }
  });
}

const expired = (e: CacheEntry) => {
  const f = familyOf(e.key);
  return !f || Date.now() - e.savedAt > f.maxAgeH * 3_600_000;
};

/** Read the whole store into memory. Called once in main.tsx before render;
 *  never throws, and gives up after `timeoutMs` so a slow disk cannot hold the
 *  app back — pages then simply start empty, as before. */
export function hydrateLocalCache(timeoutMs = 400): Promise<void> {
  const load = openDb().then(db => new Promise<void>(resolve => {
    if (!db) return resolve();
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => {
        const drop: string[] = [];
        for (const e of req.result as CacheEntry[]) {
          // Unknown family, past its age, or saved under an older response
          // shape (v) → prune. A live save that beat a slow hydrate wins.
          if (expired(e) || e.v !== familyOf(e.key)?.v) drop.push(e.key);
          else if (!mem.has(e.key)) { mem.set(e.key, e); diskAt.set(e.key, e.savedAt); }
        }
        if (drop.length) { tx('readwrite', s => drop.forEach(k => s.delete(k))); log('pruned', drop); }
        log(`hydrated ${mem.size} entries`);
        resolve();
      };
      req.onerror = () => resolve();
    } catch { resolve(); }
  }));
  return Promise.race([load, new Promise<void>(r => setTimeout(r, timeoutMs))]);
}

/** Last good answer for `key`, or undefined. Synchronous. */
export function peek<T>(key: CacheKey): T | undefined {
  const e = mem.get(key);
  if (!e || expired(e)) return undefined;
  log('serve', key, `${Math.round((Date.now() - e.savedAt) / 1000)}s old`);
  return e.data as T;
}

/** When `key` was last saved (ms epoch), or undefined. */
export function savedAt(key: CacheKey): number | undefined {
  const e = mem.get(key);
  return e && !expired(e) ? e.savedAt : undefined;
}

/** Keep `data` as the last good answer for `key`. */
export function save<T>(key: CacheKey, data: T): void {
  const f = familyOf(key);
  if (!f) return;
  let json: string;
  try { json = JSON.stringify(data); } catch { return; }
  if (json === undefined) return;
  const hash = hashOf(json);
  const prev = mem.get(key);
  if (prev && prev.hash === hash) {
    // Same answer: refresh the timestamp, but touch the disk at most every
    // 10 min so the age shown after a reload stays roughly right.
    prev.savedAt = Date.now();
    if (Date.now() - (diskAt.get(key) ?? 0) > 10 * 60_000) {
      diskAt.set(key, Date.now());
      tx('readwrite', s => s.put(prev));
    }
    return;
  }
  if (json.length > MAX_ENTRY_BYTES) { log('too big, not kept', key, json.length); return; }
  const entry: CacheEntry<T> = { key, data, savedAt: Date.now(), source: f.source, bytes: json.length, hash, v: f.v };
  mem.set(key, entry);
  diskAt.set(key, entry.savedAt);
  tx('readwrite', s => s.put(entry));
  log('save', key, `${(json.length / 1024).toFixed(1)} KB`);
  notify();
}

/** Pass a fetch through: its answer is saved under `key` when it succeeds. */
export function remember<T>(key: CacheKey, p: Promise<T>): Promise<T> {
  return p.then(d => {
    // A 200 that carries a failure ({ ok: false } / { error }) must not
    // overwrite the last good copy — the next reload would paint the failure.
    const f = d as { ok?: unknown; error?: unknown } | null;
    if (f && typeof f === 'object' && !Array.isArray(f) && (f.ok === false || f.error)) log('failure not kept', key);
    else save(key, d);
    return d;
  });
}

export function forget(key: string): void {
  mem.delete(key);
  tx('readwrite', s => s.delete(key));
  log('forget', key);
  notify();
}

export function clearLocalCache(): void {
  mem.clear();
  tx('readwrite', s => s.clear());
  log('cleared');
  notify();
}

export function listLocalCache(): Array<Omit<CacheEntry, 'data' | 'hash'> & { label: string }> {
  return [...mem.values()]
    .map(({ key, savedAt, source, bytes, v }) => ({ key, savedAt, source, bytes, v, label: familyOf(key)?.label ?? key }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Live list of entries, for the Settings panel. */
export function useLocalCacheEntries() {
  const [list, setList] = useState(listLocalCache);
  useEffect(() => {
    const fn = () => setList(listLocalCache());
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return list;
}

// DevTools handle — the "easily traceable" part when something looks stale.
(window as any).vectorCache = {
  families: CACHE_FAMILIES,
  list: () => { console.table(listLocalCache().map(e => ({ ...e, savedAt: new Date(e.savedAt).toLocaleString() }))); },
  get: (key: string) => mem.get(key),
  forget,
  clear: clearLocalCache,
  debug: (on = true) => { try { localStorage.setItem('vector_cache_debug', on ? '1' : '0'); } catch { /* private */ } },
};
