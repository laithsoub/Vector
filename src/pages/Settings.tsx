// ─── Settings ────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useRef } from 'react';
import {
  Check, Moon, Sun, RefreshCw, Trash2, RotateCcw, AlertCircle, Eye, EyeOff,
  Globe, Palette, ScrollText, SlidersHorizontal, Sparkles, Tags, type LucideIcon,
} from 'lucide-react';
import { Card, Button, Field, TextInput } from '../lib/ui';
import { Checkbox, Segmented, Switch, useFormHotkeys } from '../ui';
import { useLang, LANG_LABELS, type Lang, type Translations } from '../lib/i18n';
import { cn } from '../lib/cn';
import { api } from '../lib/api';
import type { Config } from '../types';

// ── Dark mode schedule ────────────────────────────────────────────────────────
interface DarkSched { enabled: boolean; darkFrom: string; lightFrom: string; }
const SCHED_KEY = 'vector_dark_sched';
function loadSched(): DarkSched {
  try { return JSON.parse(localStorage.getItem(SCHED_KEY) || 'null') || { enabled: false, darkFrom: '18:00', lightFrom: '07:00' }; }
  catch { return { enabled: false, darkFrom: '18:00', lightFrom: '07:00' }; }
}

// ── Log viewer ────────────────────────────────────────────────────────────────
function LogViewer() {
  const [lines, setLines]     = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.logs(150);
      setLines(r.lines);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  }

  useEffect(() => { refresh(); }, []);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [lines]);

  function lineColor(l: string): string {
    if (l.includes('[ERR]') || l.includes('[retry]')) return 'var(--err)';
    if (l.includes('[WARN]')) return 'var(--warn)';
    if (l.includes('✓') || l.includes('ok') || l.includes('Success')) return 'var(--ok)';
    return 'var(--t2)';
  }

  return (
    <Card padded={false}>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
        <span className="flex-1 text-xs text-fg-3">{lines.length} lines</span>
        <Button tone="outline" size="md" Icon={loading ? RefreshCw : RefreshCw} onClick={refresh}>Refresh</Button>
      </div>
      <div className="h-64 overflow-y-auto p-4 mono text-2xs leading-[1.7] rounded-b-panel vec-scroll" style={{ background: 'var(--term)' }}>
        {error && <p className="mb-2" style={{ color: 'var(--err)' }}>[Error loading log: {error}]</p>}
        {lines.length === 0 && !error && !loading && (
          <p className="text-fg-3">No log file yet — runs Step 1 or Step 2 to generate entries.</p>
        )}
        {lines.map((l, i) => (
          <div key={i} className="whitespace-pre-wrap break-all" style={{ color: lineColor(l) }}>{l}</div>
        ))}
        <div ref={bottomRef} />
      </div>
    </Card>
  );
}

// ── Retry queue viewer ────────────────────────────────────────────────────────
function RetryQueue({ onCount }: { onCount?: (n: number) => void }) {
  const [items,   setItems]   = useState<any[]>([]);
  const [running, setRunning] = useState(false);

  async function load() {
    try { const r = await api.retryQueue(); setItems(r); onCount?.(r.length); } catch {}
  }
  useEffect(() => { load(); }, []);

  async function retryNow() {
    setRunning(true);
    await api.retryNow();
    await load();
    setRunning(false);
  }
  async function dismiss(id: string) {
    await api.retryDismiss(id);
    setItems(p => { const n = p.filter(x => x.id !== id); onCount?.(n.length); return n; });
  }

  if (items.length === 0) return <p className="m-0 text-sm text-fg-3">Nothing waiting to retry.</p>;

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <AlertCircle className="w-4 h-4 shrink-0" style={{ color: 'var(--warn)' }} />
        <span className="text-sm text-fg-2 flex-1">{items.length} waiting</span>
        <Button tone="primary" size="md" Icon={running ? RefreshCw : RotateCcw} onClick={retryNow} disabled={running}>
          {running ? 'Retrying…' : 'Retry Now'}
        </Button>
      </div>
      <div className="space-y-2">
        {items.map(item => (
          <div key={item.id} className="flex items-start gap-2 p-2.5 rounded-panel" style={{ background: 'var(--warn-soft)', border: 'var(--hairline) solid color-mix(in oklab, var(--warn) 35%, transparent)' }}>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium" style={{ color: 'var(--warn)' }}>{item.script} — attempt {item.attempts}/{item.maxAttempts}</p>
              <p className="text-2xs text-fg-2 truncate mt-0.5">{item.lastError}</p>
              <p className="text-2xs text-fg-3 mt-0.5">{new Date(item.timestamp).toLocaleString()}</p>
            </div>
            <button aria-label="Dismiss" onClick={() => dismiss(item.id)} className="text-fg-3 hover:text-warn mt-0.5">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Remote connect: paste your own JOE/SharePoint cookies into this session ─────
function RemoteConnect() {
  const [conn, setConn]   = useState<{ connected: boolean; name: string | null } | null>(null);
  const [fed, setFed]     = useState('');
  const [rt, setRt]       = useState('');
  const [busy, setBusy]   = useState(false);
  const [msg, setMsg]     = useState<{ ok: boolean; text: string } | null>(null);

  async function check() { try { setConn(await api.connection()); } catch { setConn(null); } }
  useEffect(() => { check(); }, []);

  async function connect() {
    if (!fed.trim() || !rt.trim()) { setMsg({ ok: false, text: 'Paste both FedAuth and rtFa.' }); return; }
    setBusy(true); setMsg(null);
    try {
      await api.sessionSetCookies(fed.trim(), rt.trim());
      const c = await api.connection(); setConn(c);
      if (c.connected) { setMsg({ ok: true, text: `Connected as ${c.name}.` }); setFed(''); setRt(''); }
      else setMsg({ ok: false, text: 'Cookies rejected by SharePoint — check they are current.' });
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
    setBusy(false);
  }
  async function disconnect() {
    setBusy(true); await api.sessionClearCookies(); await check(); setMsg(null); setBusy(false);
  }

  const inp = 'w-full h-16 px-2.5 py-1.5 rounded-panel text-2xs mono break-all border border-line-2 bg-surface text-fg-2 focus:border-accent-line focus:outline-none resize-none';
  return (
    <div>
      <div className="flex items-center gap-2 mb-3 text-sm">
        <span className="w-2 h-2 rounded-full" style={{ background: conn?.connected ? 'var(--ok)' : 'var(--t4)' }} />
        <span className="text-fg-2">
          {conn?.connected ? `Connected as ${conn.name}` : 'Not connected this session (using local fallback if available)'}
        </span>
        {conn?.connected && <button onClick={disconnect} disabled={busy} className="ml-2 text-xs text-fg-3 hover:text-err">Disconnect</button>}
      </div>
      <details className="mb-3">
        <summary className="text-xs cursor-pointer" style={{ color: 'var(--accent-text)' }}>How to get your cookies</summary>
        <ol className="text-xs text-fg-3 mt-1.5 ml-4 list-decimal space-y-0.5">
          <li>Sign in to JOE / eaton.sharepoint.com in your browser.</li>
          <li>Open DevTools (F12) → Application → Cookies → <span className="mono">eaton.sharepoint.com</span>.</li>
          <li>Copy the <span className="mono">FedAuth</span> and <span className="mono">rtFa</span> values, paste below, Connect.</li>
        </ol>
      </details>
      <div className="space-y-2">
        <textarea className={inp} placeholder="FedAuth=…" value={fed} onChange={e => setFed(e.target.value.replace(/^FedAuth=/, ''))} spellCheck={false} />
        <textarea className={inp} placeholder="rtFa=…" value={rt} onChange={e => setRt(e.target.value.replace(/^rtFa=/, ''))} spellCheck={false} />
      </div>
      {msg && <p className="text-xs mt-2" style={{ color: msg.ok ? 'var(--ok)' : 'var(--err)' }}>{msg.text}</p>}
      <div className="mt-3">
        <Button tone="primary" size="md" Icon={Check} onClick={connect} disabled={busy}>{busy ? 'Connecting…' : 'Connect this session'}</Button>
      </div>
    </div>
  );
}

// ── Secret field (masked, reveal gated by a 6-digit code) ───────────────────────
const PIN_KEY = 'vector_gemini_pin_hash';

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function SecretField({ label, hint, value, onChange }: {
  label: string; hint: string; value: string; onChange: (v: string) => void;
}) {
  const [show, setShow]   = useState(false);
  // null = no prompt; 'set' = create code; 'confirm' = re-enter new code; 'enter' = unlock
  const [mode, setMode]   = useState<null | 'set' | 'confirm' | 'enter'>(null);
  const [pin, setPin]     = useState('');
  const [pin1, setPin1]   = useState('');   // first entry while setting a new code
  const [err, setErr]     = useState('');

  function onEye() {
    if (show) { setShow(false); return; }   // hiding never needs the code
    setErr(''); setPin(''); setPin1('');
    setMode(localStorage.getItem(PIN_KEY) ? 'enter' : 'set');
  }

  async function submit() {
    if (!/^\d{6}$/.test(pin)) { setErr('Enter a 6-digit code'); return; }
    if (mode === 'set') {
      setPin1(pin); setPin(''); setErr(''); setMode('confirm'); return;
    }
    if (mode === 'confirm') {
      if (pin !== pin1) { setErr('Codes do not match — start again'); setPin(''); setPin1(''); setMode('set'); return; }
      localStorage.setItem(PIN_KEY, await sha256Hex(pin));
      setShow(true); setMode(null); setPin(''); setPin1(''); setErr('');
      return;
    }
    // 'enter'
    const ok = (await sha256Hex(pin)) === localStorage.getItem(PIN_KEY);
    if (ok) { setShow(true); setMode(null); setPin(''); setErr(''); }
    else    { setErr('Wrong code'); setPin(''); }
  }

  const promptLabel =
    mode === 'set'     ? 'Create a 6-digit code to protect the key' :
    mode === 'confirm' ? 'Re-enter the 6-digit code' :
    mode === 'enter'   ? 'Enter your 6-digit code to reveal' : '';

  return (
    <div>
      <label className="block text-xs font-medium text-fg-2 mb-1">{label}</label>
      <div className="relative">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={e => onChange(e.target.value)}
          className="w-full h-8 pl-2.5 pr-9 rounded-panel text-xs mono border border-line-2 bg-surface text-fg focus:border-accent-line focus:outline-none" />
        <button
          type="button"
          onClick={onEye}
          aria-label={show ? 'Hide key' : 'Reveal key (requires code)'}
          title={show ? 'Hide' : 'Reveal (code required)'}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-3 hover:text-fg">
          {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
      </div>
      <p className="text-xs text-fg-3 mt-1 leading-snug">{hint}</p>

      {mode && (
        <div className="mt-2 p-2.5 rounded-panel border border-line-2 bg-surface">
          <p className="text-2xs font-medium text-fg-2 mb-1.5">{promptLabel}</p>
          <div className="flex items-center gap-2">
            <input
              type="password"
              inputMode="numeric"
              autoFocus
              maxLength={6}
              value={pin}
              onChange={e => { setPin(e.target.value.replace(/\D/g, '').slice(0, 6)); setErr(''); }}
              onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { setMode(null); setPin(''); setErr(''); } }}
              placeholder="••••••"
              className="w-28 h-8 px-2.5 rounded-panel text-base tracking-[0.3em] text-center mono border border-line-3 bg-raised text-fg focus:border-accent-line focus:outline-none" />
            <Button tone="primary" size="md" onClick={submit}>
              {mode === 'enter' ? 'Unlock' : mode === 'confirm' ? 'Confirm' : 'Next'}
            </Button>
            <button type="button" onClick={() => { setMode(null); setPin(''); setErr(''); }}
              className="text-2xs text-fg-3 hover:text-fg">Cancel</button>
          </div>
          {err && <p className="text-2xs mt-1.5" style={{ color: 'var(--err)' }}>{err}</p>}
        </div>
      )}
    </div>
  );
}

// ── AI model picker (Ask Vector "smart" model) ─────────────────────────────────
// Lists the models THIS key actually exposes (server → Google ListModels) as a
// datalist, but stays an editable combobox so a brand-new id (e.g. a gemini-3 tier)
// can be typed even if the live listing is unavailable. Blank = server default.
function AiModelField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [models, setModels]   = useState<Array<{ id: string; label: string }>>([]);
  const [current, setCurrent] = useState('');
  const [fallback, setFallback] = useState('');
  const [err, setErr]         = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await api.aiModels();
      setModels(r.models || []);
      setCurrent(r.current || '');
      setFallback(r.fallback || '');
      setErr(r.error || null);
    } catch (e: any) { setErr(e.message); }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const sel = value || current;

  return (
    <div>
      <label className="block text-xs font-medium text-fg-2 mb-1">Model id</label>
      <div className="flex items-center gap-2">
        <input
          list="ai-model-list"
          value={sel}
          spellCheck={false}
          autoComplete="off"
          placeholder={fallback || 'gemini-2.5-flash'}
          onChange={e => onChange(e.target.value.trim())}
          className="flex-1 h-8 px-2.5 rounded-panel text-xs mono border border-line-2 bg-surface text-fg focus:border-accent-line focus:outline-none" />
        <datalist id="ai-model-list">
          {models.map(m => <option key={m.id} value={m.id}>{m.label !== m.id ? `${m.label} — ${m.id}` : m.id}</option>)}
        </datalist>
        <Button tone="outline" size="md" Icon={RefreshCw} onClick={load} disabled={loading}>
          {loading ? '…' : 'Refresh'}
        </Button>
      </div>
      {err
        ? <p className="text-xs mt-1 leading-snug" style={{ color: 'var(--warn)' }}>Couldn’t list models ({err}). You can still type an id — it’s used as-is. Current: <span className="mono">{sel || fallback}</span>.</p>
        : <p className="text-xs text-fg-3 mt-1 leading-snug">{models.length} model(s) available on your key. Drives Ask Vector chat, Inbox summaries & follow-ups. Blank = server default (<span className="mono">{fallback || 'gemini-2.5-flash'}</span>).</p>}
    </div>
  );
}

// ── Job report categories ─────────────────────────────────────────────────────
// The buckets the Report tab sorts your work into. One per line, order preserved.
// Keep the LAST entry as a catch-all — anything the AI can't place lands there.
// Blank = the server's default list. Editing the list re-classifies on next scan.
const DEFAULT_JOB_CATEGORIES = [
  'Technical response',
  'Pricing / quotation',
  'PMO',
  'Forwarding / routing',
  'Quote upload / SharePoint',
  'D&Q filing',
  'Meetings / internal',
  'Admin / other',
];

function JobCategoriesField({
  value, onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const usingDefaults = !value.length;
  const text = (usingDefaults ? DEFAULT_JOB_CATEGORIES : value).join('\n');

  return (
    <div>
      <textarea
        value={text}
        rows={8}
        spellCheck={false}
        onChange={e => {
          const lines = e.target.value.split('\n').map(s => s.replace(/^\s+/, ''));
          // Keep raw lines while typing; strip empties only on the saved value.
          const clean = lines.map(s => s.trim()).filter(Boolean);
          onChange(clean.length ? lines.filter((_, i) => i < 20) : []);
        }}
        className="w-full px-2.5 py-2 rounded-panel text-xs leading-relaxed border border-line-2 bg-surface text-fg focus:border-accent-line focus:outline-none resize-y"
      />
      <div className="flex items-center justify-between mt-2 gap-3">
        <p className="m-0 text-xs text-fg-3 leading-snug">
          One category per line — the Report tab sorts every job into exactly one of these.
          The <b>last line is the catch-all</b> for anything that doesn’t fit.
          {usingDefaults && ' Currently using the defaults.'}
        </p>
        {!usingDefaults && (
          <button type="button" onClick={() => onChange([])}
            className="shrink-0 text-2xs font-medium" style={{ color: 'var(--accent-text)' }}>
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main Settings page ────────────────────────────────────────────────────────
// A section list on the left (a tab strip on narrow windows) and one section at
// a time on the right, like claude.ai's settings. Every config field still
// lives in one form: the save bar under the form sections writes all of it.
type SectionId = 'general' | 'appearance' | 'sharepoint' | 'ai' | 'lsd' | 'system';
type TKey = keyof Translations;

const SECTIONS: Array<{ id: SectionId; Icon: LucideIcon; label: TKey; sub: TKey; form: boolean }> = [
  { id: 'general',    Icon: SlidersHorizontal, label: 'settings_sec_general',    sub: 'settings_sec_general_sub',    form: true },
  { id: 'appearance', Icon: Palette,           label: 'settings_sec_appearance', sub: 'settings_sec_appearance_sub', form: false },
  { id: 'sharepoint', Icon: Globe,             label: 'settings_sec_sharepoint', sub: 'settings_sec_sharepoint_sub', form: true },
  { id: 'ai',         Icon: Sparkles,          label: 'settings_sec_ai',         sub: 'settings_sec_ai_sub',         form: true },
  { id: 'lsd',        Icon: Tags,              label: 'settings_sec_lsd',        sub: 'settings_sec_lsd_sub',        form: true },
  { id: 'system',     Icon: ScrollText,        label: 'settings_sec_system',     sub: 'settings_sec_system_sub',     form: false },
];
const SECTION_KEY = 'vector_settings_section';

function loadSection(): SectionId {
  try {
    const v = localStorage.getItem(SECTION_KEY);
    return SECTIONS.some(s => s.id === v) ? v as SectionId : 'general';
  } catch { return 'general'; }
}

function Group({ title, sub, children }: { title: React.ReactNode; sub?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="py-6 border-t border-line first:border-t-0 first:pt-0">
      <div className="mb-4">
        <h3 className="m-0 text-base font-semibold text-fg">{title}</h3>
        {sub && <p className="mt-0.5 mb-0 text-xs text-fg-3 leading-snug">{sub}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export function SettingsPage({
  config, onSave,
}: {
  config: Config | null;
  onSave: (c: Config) => Promise<void>;
}) {
  const [form, setForm]     = useState<Config | null>(config);
  const [saved, setSaved]   = useState(false);
  const [saving, setSaving] = useState(false);
  const [sched, setSched]   = useState<DarkSched>(loadSched);
  const [sec, setSec]       = useState<SectionId>(loadSection);
  const [retries, setRetries] = useState(0);
  const { lang, t, setLang } = useLang();

  useEffect(() => { setForm(config); }, [config]);

  // Persist schedule whenever it changes
  useEffect(() => {
    localStorage.setItem(SCHED_KEY, JSON.stringify(sched));
  }, [sched]);

  useEffect(() => { api.retryQueue().then(r => setRetries(r.length)).catch(() => {}); }, []);

  const dirty = !!form && !!config && JSON.stringify(form) !== JSON.stringify(config);
  const cur = SECTIONS.find(s => s.id === sec) ?? SECTIONS[0];

  useFormHotkeys({ onSave: () => { if (dirty) void save(); }, enabled: cur.form });

  if (!form) return <Card className="max-w-md">Loading settings…</Card>;

  function pick(id: SectionId) {
    setSec(id);
    try { localStorage.setItem(SECTION_KEY, id); } catch { /* per-viewer convenience only */ }
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    await onSave(form);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function field(key: keyof Config, label: string, hint: string) {
    return (
      <Field key={key} label={label} hint={hint}>
        <TextInput value={(form![key] as string) ?? ''}
          onChange={e => setForm(f => f ? { ...f, [key]: e.target.value } : f)}
          className="mono" />
      </Field>
    );
  }

  return (
    <div className="flex flex-col md:flex-row md:items-start gap-6 md:gap-10">
      <nav aria-label={t.settings_nav}
        className="shrink-0 w-full md:w-48 md:sticky md:top-0 flex md:flex-col gap-1 md:gap-px overflow-x-auto border-b border-line md:border-b-0"
        style={{ scrollbarWidth: 'none' }}>
        {SECTIONS.map(s => {
          const on = s.id === sec;
          return (
            <button key={s.id} type="button" aria-current={on ? 'page' : undefined} onClick={() => pick(s.id)}
              className={cn('relative shrink-0 flex items-center gap-2.5 h-h-sm px-2 md:rounded-control text-sm whitespace-nowrap transition-colors duration-fast',
                on ? 'text-fg font-semibold md:bg-subtle' : 'font-medium text-fg-tab hover:text-fg md:hover:bg-hover')}>
              {on && <span aria-hidden className="absolute rounded-full bg-signal left-2 right-2 bottom-0 h-0.5 md:left-0 md:right-auto md:top-1.5 md:bottom-1.5 md:h-auto md:w-0.5" />}
              <s.Icon className={cn('w-4 h-4 shrink-0', on ? 'text-accent-text' : 'text-fg-3')} strokeWidth={1.75} />
              <span className="flex-1 text-left">{t[s.label]}</span>
              {s.id === 'system' && retries > 0 && <span className="mono text-2xs text-warn">{retries}</span>}
            </button>
          );
        })}
      </nav>

      <div className="flex-1 min-w-0" style={{ maxWidth: 'calc(var(--sp-4) * 42)' }}>
        <header className="mb-6">
          <h2 className="m-0 text-xl font-semibold tracking-tight text-fg">{t[cur.label]}</h2>
          <p className="mt-1 mb-0 text-sm text-fg-3">{t[cur.sub]}</p>
        </header>

        {sec === 'general' && (<>
          <Group title="You">
            {field('base',     'Base folder',   'Root containing PDF Quotes, Archive, Email Drop')}
            {field('initials', 'Your initials', 'Used in folder names (e.g. LS → "SUBMITTED BY - 12-03-2025 LS")')}
          </Group>
          {/* Language. Scope is stated because it is real: the translations cover the
              navigation, the header and this screen. Page content is English only,
              and a picker that implies otherwise reads as a broken feature. */}
          <Group title={t.language} sub={t.language_scope}>
            <Segmented value={lang} onChange={l => setLang(l)}
              data={(Object.keys(LANG_LABELS) as Lang[]).map(l => ({ value: l, label: LANG_LABELS[l] }))} />
          </Group>
          <Group title="Job report categories" sub="How the Report tab sorts your work">
            <JobCategoriesField
              value={form.job_categories ?? []}
              onChange={v => setForm(f => f ? { ...f, job_categories: v } : f)}
            />
          </Group>
        </>)}

        {sec === 'appearance' && (
          <Group title="Dark mode schedule" sub="Auto-switch between light and dark based on time of day">
            <Switch checked={sched.enabled} onChange={() => setSched(s => ({ ...s, enabled: !s.enabled }))}
              label={sched.enabled ? 'Schedule active' : 'Manual control (current)'} />
            <div className={cn('grid grid-cols-2 gap-4 transition-opacity', !sched.enabled && 'opacity-40 pointer-events-none')}>
              <Field label="Light mode from">
                <div className="relative">
                  <Sun className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none" style={{ color: 'var(--warn)' }} />
                  <TextInput type="time" value={sched.lightFrom} className="mono pl-8"
                    onChange={e => setSched(s => ({ ...s, lightFrom: e.target.value }))} />
                </div>
              </Field>
              <Field label="Dark mode from">
                <div className="relative">
                  <Moon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none" style={{ color: 'var(--violet)' }} />
                  <TextInput type="time" value={sched.darkFrom} className="mono pl-8"
                    onChange={e => setSched(s => ({ ...s, darkFrom: e.target.value }))} />
                </div>
              </Field>
            </div>
          </Group>
        )}

        {sec === 'sharepoint' && (<>
          <Group title="Sites" sub="Where uploads, searches and D&Q filing go">
            {field('sp_site',  'ELTechsupport site',   'D&Q Store script site')}
            {field('sp_list',  'QuotationFactoryEMEA', 'Step 1 upload and Search site')}
            {field('dq_store', 'D&Q Store path',       'Server-relative library path')}
          </Group>
          <Group title="Connect this session"
            sub="For remote/web use — supply your own JOE cookies. They stay bound to your browser session only.">
            <RemoteConnect />
          </Group>
        </>)}

        {sec === 'ai' && (<>
          <Group title="Gemini">
            <SecretField
              label="API key"
              hint={form.gemini_key_set && !form.gemini_key
                ? "Key is configured — leave blank to keep it, or enter a new key to replace it"
                : "From console.google.com → API key — powers the Ask AI feature"}
              value={form.gemini_key ?? ''}
              onChange={v => setForm(f => f ? { ...f, gemini_key: v } : f)}
            />
          </Group>
          <Group title="Ask Vector model">
            <AiModelField
              value={form.ai_model ?? ''}
              onChange={v => setForm(f => f ? { ...f, ai_model: v } : f)}
            />
          </Group>
        </>)}

        {/* LSD Pricing. The file fields are optional — the tab falls back to the
            newest .xlsb in data/lsd, the Desktop case archive, and R2321. */}
        {sec === 'lsd' && (<>
          <Group title="Files" sub="All optional — blank uses the defaults">
            {field('lsd_master_model', 'Master CPQ model',
                   'Full path to the "CPQ Pricing Model LSD … V2" .xlsb. Blank = newest .xlsb in data\\lsd')}
            {field('lsd_cases_root',   'Case folder root',
                   'Where generated case folders are written. Blank = Desktop\\LSD Pricing Doc')}
            {field('lsd_ledger',       'MV ledger code',
                   'Keys the prior-year country average. This master carries R2321 (UAE) only')}
          </Group>
          <Group title="Daily register and Quotations List">
            {field('lsd_register',     'Daily register',
                   'Workbook every priced transaction is logged into — it stays on this machine. Blank = <case root>\\LSD Daily Work - Vector.xlsx. Point it at a copy of the real LSD Daily work sheet to write into its own columns')}
            {field('lsd_request_type', 'Request type',
                   'REQUEST TYPE written on every item posted to the Quotations List. Blank = Standard CTO')}
            {field('lsd_sales_name',   'Sales name',
                   'Fills the register’s Sales Name column. Blank = the Inside Sales name above')}
            {field('lsd_bu',           'Business unit',
                   'Fills the register’s BU column — EL, FIRE or CBS. Blank = guessed from the APRC toggle')}
          </Group>
          <Group title="Approvals" sub="Approval mails are always drafted, never sent">
            {field('lsd_approver',     'Approver',
                   'Who a sub-target margin is mailed to. A display name ("Poulose, Kiran") is resolved against the address book. The mail is always drafted, never sent')}
            {field('lsd_approver_cc',  'Approval cc',
                   'Copied on every approval mail — usually the pricing analyst')}
          </Group>
          <Group title="CPQ connection" sub="Fetch from CPQ drives the debug-rail Edge">
            {field('lsd_cpq_port',     'CPQ debug port',
                   'Edge remote-debugging port for the Fetch-from-CPQ button. Blank = 9222')}
            <Field label="Keep tabs alive"
                   hint="One URL per line. Vector reloads each of these in a minimized debug-rail Edge on a timer, so CPQ and the OneDrive pages are still signed in when a fetch runs. Blank = eaton.bigmachines.com + the QuotationFactoryEMEA site.">
              <textarea rows={4} spellCheck={false}
                value={(form.lsd_keepalive_urls as string) ?? ''}
                onChange={e => setForm(f => f ? { ...f, lsd_keepalive_urls: e.target.value } : f)}
                className="mono w-full px-2.5 py-2 rounded-control text-sm bg-surface border border-line-2 text-fg focus:border-accent-line focus:outline-none transition-colors" />
            </Field>
            {field('lsd_keepalive_min', 'Keep-alive every (min)',
                   'Minutes between background reloads. Blank = 10, minimum 2. Untick the timer below to stop the sweeps entirely')}
            <Field hint="Off stops the background reloads; the tabs stay as they are and a fetch may hit an expired session.">
              <Checkbox label="Keep-alive timer"
                checked={form.lsd_keepalive !== false}
                onChange={e => { const on = e.currentTarget.checked; setForm(f => f ? { ...f, lsd_keepalive: on } : f); }} />
            </Field>
          </Group>
        </>)}

        {sec === 'system' && (<>
          <Group title="Pending retries">
            <RetryQueue onCount={setRetries} />
          </Group>
          <Group title="Server log">
            <LogViewer />
          </Group>
        </>)}

        {cur.form && (
          <div className="sticky bottom-0 z-sticky mt-6 -mx-2 px-2 py-3 flex items-center gap-2 border-t border-line bg-page">
            <p className={cn('flex-1 min-w-0 m-0 text-xs truncate', dirty ? 'text-fg font-medium' : 'text-fg-3')}>
              {dirty ? <><span className="inline-block w-1.5 h-1.5 mr-1.5 rounded-full bg-signal align-middle" />{t.settings_unsaved}</> : t.settings_paths_sub}
            </p>
            <Button tone="ghost" size="lg" onClick={() => setForm(config)} disabled={!dirty}>{t.settings_revert}</Button>
            <Button tone="primary" Icon={Check} size="lg" onClick={save} disabled={saving || (!dirty && !saved)}>
              {saving ? t.settings_saving : saved ? t.settings_saved : t.settings_save}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
