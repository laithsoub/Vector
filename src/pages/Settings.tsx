// ─── Settings ────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useRef } from 'react';
import { Check, Moon, Sun, RefreshCw, Trash2, RotateCcw, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { Card, CardTitle, Button } from '../lib/ui';
import { useLang, LANG_LABELS, type Lang } from '../lib/i18n';
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

  function lineColor(l: string) {
    if (l.includes('[ERR]') || l.includes('[retry]')) return 'text-red-500 dark:text-red-400';
    if (l.includes('[WARN]')) return 'text-amber-500 dark:text-amber-400';
    if (l.includes('✓') || l.includes('ok') || l.includes('Success')) return 'text-emerald-600 dark:text-emerald-400';
    return 'text-ink-600 dark:text-ink-300';
  }

  return (
    <Card padded={false}>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-ink-200/70 dark:border-ink-800">
        <span className="flex-1 text-[13px] font-semibold">Server Log</span>
        <span className="text-[10.5px] text-ink-400">{lines.length} lines</span>
        <Button tone="outline" size="md" Icon={loading ? RefreshCw : RefreshCw} onClick={refresh}>Refresh</Button>
      </div>
      <div className="h-64 overflow-y-auto bg-ink-950 dark:bg-ink-950 p-3 font-mono text-[10.5px] leading-relaxed rounded-b-xl">
        {error && <p className="text-red-400 mb-2">[Error loading log: {error}]</p>}
        {lines.length === 0 && !error && !loading && (
          <p className="text-ink-500">No log file yet — runs Step 1 or Step 2 to generate entries.</p>
        )}
        {lines.map((l, i) => (
          <div key={i} className={cn('whitespace-pre-wrap break-all', lineColor(l))}>{l}</div>
        ))}
        <div ref={bottomRef} />
      </div>
    </Card>
  );
}

// ── Retry queue viewer ────────────────────────────────────────────────────────
function RetryQueue() {
  const [items,   setItems]   = useState<any[]>([]);
  const [running, setRunning] = useState(false);

  async function load() {
    try { setItems(await api.retryQueue()); } catch {}
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
    setItems(p => p.filter(x => x.id !== id));
  }

  if (items.length === 0) return null;

  return (
    <Card>
      <div className="flex items-center gap-2 mb-3">
        <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
        <span className="text-[13px] font-semibold flex-1">Pending Retries</span>
        <Button tone="primary" size="md" Icon={running ? RefreshCw : RotateCcw} onClick={retryNow} disabled={running}>
          {running ? 'Retrying…' : 'Retry Now'}
        </Button>
      </div>
      <div className="space-y-2">
        {items.map(item => (
          <div key={item.id} className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-900/20 ring-1 ring-amber-200 dark:ring-amber-800/40">
            <div className="flex-1 min-w-0">
              <p className="text-[11.5px] font-medium text-amber-800 dark:text-amber-200">{item.script} — attempt {item.attempts}/{item.maxAttempts}</p>
              <p className="text-[10.5px] text-amber-600 dark:text-amber-400 truncate mt-0.5">{item.lastError}</p>
              <p className="text-[10px] text-amber-500 mt-0.5">{new Date(item.timestamp).toLocaleString()}</p>
            </div>
            <button onClick={() => dismiss(item.id)} className="text-amber-400 hover:text-amber-600 mt-0.5">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </Card>
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

  const inp = 'w-full h-16 px-2.5 py-1.5 rounded-md text-[10.5px] mono break-all ring-1 ring-inset ring-ink-200 dark:ring-ink-700 bg-ink-50 dark:bg-ink-800 focus:ring-brand-400 focus:outline-none resize-none';
  return (
    <Card>
      <CardTitle title="Connect to SharePoint (this session)"
        sub="For remote/web use — supply your own JOE cookies. They stay bound to your browser session only." />
      <div className="flex items-center gap-2 mb-3 text-[12px]">
        <span className={cn('w-2 h-2 rounded-full', conn?.connected ? 'bg-emerald-500' : 'bg-ink-300 dark:bg-ink-600')} />
        <span className="text-ink-700 dark:text-ink-200">
          {conn?.connected ? `Connected as ${conn.name}` : 'Not connected this session (using local fallback if available)'}
        </span>
        {conn?.connected && <button onClick={disconnect} disabled={busy} className="ml-2 text-[11px] text-ink-400 hover:text-red-500">Disconnect</button>}
      </div>
      <details className="mb-3">
        <summary className="text-[11px] text-brand-600 dark:text-brand-300 cursor-pointer">How to get your cookies</summary>
        <ol className="text-[11px] text-ink-500 dark:text-ink-400 mt-1.5 ml-4 list-decimal space-y-0.5">
          <li>Sign in to JOE / eaton.sharepoint.com in your browser.</li>
          <li>Open DevTools (F12) → Application → Cookies → <span className="mono">eaton.sharepoint.com</span>.</li>
          <li>Copy the <span className="mono">FedAuth</span> and <span className="mono">rtFa</span> values, paste below, Connect.</li>
        </ol>
      </details>
      <div className="space-y-2">
        <textarea className={inp} placeholder="FedAuth=…" value={fed} onChange={e => setFed(e.target.value.replace(/^FedAuth=/, ''))} spellCheck={false} />
        <textarea className={inp} placeholder="rtFa=…" value={rt} onChange={e => setRt(e.target.value.replace(/^rtFa=/, ''))} spellCheck={false} />
      </div>
      {msg && <p className={cn('text-[11px] mt-2', msg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500')}>{msg.text}</p>}
      <div className="mt-3">
        <Button tone="primary" size="md" Icon={Check} onClick={connect} disabled={busy}>{busy ? 'Connecting…' : 'Connect this session'}</Button>
      </div>
    </Card>
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
      <label className="block text-[11.5px] font-semibold text-ink-800 dark:text-ink-100">{label}</label>
      <p className="text-[10.5px] text-ink-500 dark:text-ink-400 mb-1.5">{hint}</p>
      <div className="relative">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={e => onChange(e.target.value)}
          className="w-full h-8 pl-2.5 pr-9 rounded-md text-[11.5px] mono ring-1 ring-inset ring-ink-200 dark:ring-ink-700 bg-ink-50 dark:bg-ink-800 focus:ring-brand-400 focus:outline-none" />
        <button
          type="button"
          onClick={onEye}
          aria-label={show ? 'Hide key' : 'Reveal key (requires code)'}
          title={show ? 'Hide' : 'Reveal (code required)'}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-600 dark:hover:text-ink-200">
          {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
      </div>

      {mode && (
        <div className="mt-2 p-2.5 rounded-md ring-1 ring-inset ring-ink-200 dark:ring-ink-700 bg-ink-50 dark:bg-ink-800/60">
          <p className="text-[10.5px] font-medium text-ink-700 dark:text-ink-200 mb-1.5">{promptLabel}</p>
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
              className="w-28 h-8 px-2.5 rounded-md text-[13px] tracking-[0.3em] text-center mono ring-1 ring-inset ring-ink-300 dark:ring-ink-600 bg-white dark:bg-ink-900 focus:ring-brand-400 focus:outline-none" />
            <Button tone="primary" size="md" onClick={submit}>
              {mode === 'enter' ? 'Unlock' : mode === 'confirm' ? 'Confirm' : 'Next'}
            </Button>
            <button type="button" onClick={() => { setMode(null); setPin(''); setErr(''); }}
              className="text-[10.5px] text-ink-400 hover:text-ink-600 dark:hover:text-ink-200">Cancel</button>
          </div>
          {err && <p className="text-[10px] text-red-500 mt-1.5">{err}</p>}
        </div>
      )}
    </div>
  );
}

// ── Main Settings page ────────────────────────────────────────────────────────
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
  const { lang, t, setLang } = useLang();

  useEffect(() => { setForm(config); }, [config]);

  // Persist schedule whenever it changes
  useEffect(() => {
    localStorage.setItem(SCHED_KEY, JSON.stringify(sched));
  }, [sched]);

  if (!form) return <Card className="max-w-md">Loading settings…</Card>;

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
      <div key={key}>
        <label className="block text-[11.5px] font-semibold text-ink-800 dark:text-ink-100">{label}</label>
        <p className="text-[10.5px] text-ink-500 dark:text-ink-400 mb-1.5">{hint}</p>
        <input value={form![key]}
          onChange={e => setForm(f => f ? { ...f, [key]: e.target.value } : f)}
          className="w-full h-8 px-2.5 rounded-md text-[11.5px] mono ring-1 ring-inset ring-ink-200 dark:ring-ink-700 bg-ink-50 dark:bg-ink-800 focus:ring-brand-400 focus:outline-none" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-5">
      {/* Pending retries banner */}
      <RetryQueue />

      {/* Remote connection (per-session cookies) */}
      <RemoteConnect />

      {/* Paths & keys */}
      <Card>
        <CardTitle title={t.settings_paths_title} sub={t.settings_paths_sub} />
        <div className="space-y-4">
          {field('base',       'Base folder',           'Root containing PDF Quotes, Archive, Email Drop')}
          {field('initials',   'Your initials',          'Used in folder names (e.g. LS → "SUBMITTED BY - 12-03-2025 LS")')}
          {field('sp_site',    'ELTechsupport site',     'D&Q Store script site')}
          {field('sp_list',    'QuotationFactoryEMEA',   'Step 1 upload and Search site')}
          {field('dq_store',   'D&Q Store path',         'Server-relative library path')}
          <SecretField
            label="Gemini API key"
            hint="From console.google.com → API key — powers the Ask AI feature"
            value={form.gemini_key ?? ''}
            onChange={v => setForm(f => f ? { ...f, gemini_key: v } : f)}
          />
        </div>

        {/* Language */}
        <div className="mt-5 pt-4 border-t border-ink-200/70 dark:border-ink-800">
          <label className="block text-[11.5px] font-semibold text-ink-800 dark:text-ink-100 mb-2">{t.language}</label>
          <div className="flex gap-2">
            {(Object.keys(LANG_LABELS) as Lang[]).map(l => (
              <button key={l} onClick={() => setLang(l)}
                className={cn(
                  'px-4 py-1.5 text-[11.5px] font-semibold rounded-lg ring-1 ring-inset transition-all',
                  lang === l
                    ? 'bg-ink-900 dark:bg-white text-white dark:text-ink-900 ring-transparent'
                    : 'bg-white dark:bg-ink-800 text-ink-500 dark:text-ink-300 ring-ink-200 dark:ring-ink-700 hover:ring-ink-400 dark:hover:ring-ink-500',
                )}>
                {LANG_LABELS[l]}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-2 mt-5 pt-4 border-t border-ink-200/70 dark:border-ink-800">
          <Button tone="primary" Icon={Check} size="lg" onClick={save} disabled={saving}>
            {saving ? t.settings_saving : saved ? t.settings_saved : t.settings_save}
          </Button>
          <Button tone="ghost" size="lg" onClick={() => setForm(config)}>{t.settings_revert}</Button>
        </div>
      </Card>

      {/* Dark mode schedule */}
      <Card>
        <CardTitle title="Dark Mode Schedule" sub="Auto-switch between light and dark based on time of day" />
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={() => setSched(s => ({ ...s, enabled: !s.enabled }))}
            className={cn(
              'relative w-10 h-5 rounded-full transition-colors',
              sched.enabled ? 'bg-brand-600' : 'bg-ink-200 dark:bg-ink-700',
            )}>
            <span className={cn(
              'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform',
              sched.enabled ? 'translate-x-5' : 'translate-x-0.5',
            )} />
          </button>
          <span className="text-[12px] text-ink-700 dark:text-ink-200">
            {sched.enabled ? 'Schedule active' : 'Manual control (current)'}
          </span>
        </div>
        <div className={cn('grid grid-cols-2 gap-4 transition-opacity', !sched.enabled && 'opacity-40 pointer-events-none')}>
          <div>
            <label className="flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-700 dark:text-ink-200 mb-1.5">
              <Sun className="w-3.5 h-3.5 text-amber-500" /> Light mode from
            </label>
            <input type="time" value={sched.lightFrom}
              onChange={e => setSched(s => ({ ...s, lightFrom: e.target.value }))}
              className="w-full h-8 px-2.5 rounded-md text-[11.5px] mono ring-1 ring-inset ring-ink-200 dark:ring-ink-700 bg-ink-50 dark:bg-ink-800 focus:ring-brand-400 focus:outline-none" />
          </div>
          <div>
            <label className="flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-700 dark:text-ink-200 mb-1.5">
              <Moon className="w-3.5 h-3.5 text-indigo-400" /> Dark mode from
            </label>
            <input type="time" value={sched.darkFrom}
              onChange={e => setSched(s => ({ ...s, darkFrom: e.target.value }))}
              className="w-full h-8 px-2.5 rounded-md text-[11.5px] mono ring-1 ring-inset ring-ink-200 dark:ring-ink-700 bg-ink-50 dark:bg-ink-800 focus:ring-brand-400 focus:outline-none" />
          </div>
        </div>
      </Card>

      {/* Server log */}
      <LogViewer />
    </div>
  );
}
