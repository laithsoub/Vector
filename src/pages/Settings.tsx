// ─── Settings ────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useRef } from 'react';
import { Check, Moon, Sun, RefreshCw, Trash2, RotateCcw, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { Card, CardTitle, Button, Field, TextInput } from '../lib/ui';
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

  function lineColor(l: string): string {
    if (l.includes('[ERR]') || l.includes('[retry]')) return 'var(--err)';
    if (l.includes('[WARN]')) return 'var(--warn)';
    if (l.includes('✓') || l.includes('ok') || l.includes('Success')) return 'var(--ok)';
    return 'var(--t2)';
  }

  return (
    <Card padded={false}>
      <div className="flex items-center gap-2 px-[18px] py-3 border-b border-[var(--line)]">
        <span className="flex-1 text-[13px] font-semibold">Server Log</span>
        <span className="text-[10.5px] text-[var(--t3)]">{lines.length} lines</span>
        <Button tone="outline" size="md" Icon={loading ? RefreshCw : RefreshCw} onClick={refresh}>Refresh</Button>
      </div>
      <div className="h-64 overflow-y-auto p-4 mono text-[10.5px] leading-[1.7] rounded-b-[16px] vec-scroll" style={{ background: 'var(--term)' }}>
        {error && <p className="mb-2" style={{ color: 'var(--err)' }}>[Error loading log: {error}]</p>}
        {lines.length === 0 && !error && !loading && (
          <p className="text-[var(--t3)]">No log file yet — runs Step 1 or Step 2 to generate entries.</p>
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
        <AlertCircle className="w-4 h-4 shrink-0" style={{ color: 'var(--warn)' }} />
        <span className="text-[13px] font-semibold flex-1">Pending Retries</span>
        <Button tone="primary" size="md" Icon={running ? RefreshCw : RotateCcw} onClick={retryNow} disabled={running}>
          {running ? 'Retrying…' : 'Retry Now'}
        </Button>
      </div>
      <div className="space-y-2">
        {items.map(item => (
          <div key={item.id} className="flex items-start gap-2 p-2.5 rounded-[11px]" style={{ background: 'var(--warn-soft)', border: '1px solid color-mix(in oklab, var(--warn) 35%, transparent)' }}>
            <div className="flex-1 min-w-0">
              <p className="text-[11.5px] font-medium" style={{ color: 'var(--warn)' }}>{item.script} — attempt {item.attempts}/{item.maxAttempts}</p>
              <p className="text-[10.5px] text-[var(--t2)] truncate mt-0.5">{item.lastError}</p>
              <p className="text-[10px] text-[var(--t3)] mt-0.5">{new Date(item.timestamp).toLocaleString()}</p>
            </div>
            <button aria-label="Dismiss" onClick={() => dismiss(item.id)} className="text-[var(--t3)] hover:text-[var(--warn)] mt-0.5">
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

  const inp = 'w-full h-16 px-2.5 py-1.5 rounded-[10px] text-[10.5px] mono break-all border border-[var(--line-2)] bg-[var(--s1)] text-[var(--t2)] focus:border-[var(--accent-line)] focus:outline-none resize-none';
  return (
    <Card>
      <CardTitle title="Connect to SharePoint (this session)"
        sub="For remote/web use — supply your own JOE cookies. They stay bound to your browser session only." />
      <div className="flex items-center gap-2 mb-3 text-[12px]">
        <span className="w-2 h-2 rounded-full" style={{ background: conn?.connected ? 'var(--ok)' : 'var(--t4)' }} />
        <span className="text-[var(--t2)]">
          {conn?.connected ? `Connected as ${conn.name}` : 'Not connected this session (using local fallback if available)'}
        </span>
        {conn?.connected && <button onClick={disconnect} disabled={busy} className="ml-2 text-[11px] text-[var(--t3)] hover:text-[var(--err)]">Disconnect</button>}
      </div>
      <details className="mb-3">
        <summary className="text-[11px] cursor-pointer" style={{ color: 'var(--accent-text)' }}>How to get your cookies</summary>
        <ol className="text-[11px] text-[var(--t3)] mt-1.5 ml-4 list-decimal space-y-0.5">
          <li>Sign in to JOE / eaton.sharepoint.com in your browser.</li>
          <li>Open DevTools (F12) → Application → Cookies → <span className="mono">eaton.sharepoint.com</span>.</li>
          <li>Copy the <span className="mono">FedAuth</span> and <span className="mono">rtFa</span> values, paste below, Connect.</li>
        </ol>
      </details>
      <div className="space-y-2">
        <textarea className={inp} placeholder="FedAuth=…" value={fed} onChange={e => setFed(e.target.value.replace(/^FedAuth=/, ''))} spellCheck={false} />
        <textarea className={inp} placeholder="rtFa=…" value={rt} onChange={e => setRt(e.target.value.replace(/^rtFa=/, ''))} spellCheck={false} />
      </div>
      {msg && <p className="text-[11px] mt-2" style={{ color: msg.ok ? 'var(--ok)' : 'var(--err)' }}>{msg.text}</p>}
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
      <label className="block text-[10.5px] font-semibold uppercase tracking-wider text-[var(--t3)] mb-2">{label}</label>
      <div className="relative">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={e => onChange(e.target.value)}
          className="w-full h-[34px] pl-2.5 pr-9 rounded-[9px] text-[11.5px] mono border border-[var(--line-2)] bg-[var(--s1)] text-[var(--t1)] focus:border-[var(--accent-line)] focus:outline-none" />
        <button
          type="button"
          onClick={onEye}
          aria-label={show ? 'Hide key' : 'Reveal key (requires code)'}
          title={show ? 'Hide' : 'Reveal (code required)'}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--t3)] hover:text-[var(--t1)]">
          {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
      </div>
      <p className="text-[10px] text-[var(--t4)] mt-2 leading-relaxed">{hint}</p>

      {mode && (
        <div className="mt-2 p-2.5 rounded-[10px] border border-[var(--line-2)] bg-[var(--s1)]">
          <p className="text-[10.5px] font-medium text-[var(--t2)] mb-1.5">{promptLabel}</p>
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
              className="w-28 h-[34px] px-2.5 rounded-[9px] text-[13px] tracking-[0.3em] text-center mono border border-[var(--line-3)] bg-[var(--s2)] text-[var(--t1)] focus:border-[var(--accent-line)] focus:outline-none" />
            <Button tone="primary" size="md" onClick={submit}>
              {mode === 'enter' ? 'Unlock' : mode === 'confirm' ? 'Confirm' : 'Next'}
            </Button>
            <button type="button" onClick={() => { setMode(null); setPin(''); setErr(''); }}
              className="text-[10.5px] text-[var(--t3)] hover:text-[var(--t1)]">Cancel</button>
          </div>
          {err && <p className="text-[10px] mt-1.5" style={{ color: 'var(--err)' }}>{err}</p>}
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
    <div className="mt-4 pt-4 border-t border-[var(--line)]">
      <label className="block text-[10.5px] font-semibold uppercase tracking-wider text-[var(--t3)] mb-2">Ask Vector AI model</label>
      <div className="flex items-center gap-2">
        <input
          list="ai-model-list"
          value={sel}
          spellCheck={false}
          autoComplete="off"
          placeholder={fallback || 'gemini-2.5-flash'}
          onChange={e => onChange(e.target.value.trim())}
          className="flex-1 h-[34px] px-2.5 rounded-[9px] text-[11.5px] mono border border-[var(--line-2)] bg-[var(--s1)] text-[var(--t1)] focus:border-[var(--accent-line)] focus:outline-none" />
        <datalist id="ai-model-list">
          {models.map(m => <option key={m.id} value={m.id}>{m.label !== m.id ? `${m.label} — ${m.id}` : m.id}</option>)}
        </datalist>
        <Button tone="outline" size="md" Icon={RefreshCw} onClick={load} disabled={loading}>
          {loading ? '…' : 'Refresh'}
        </Button>
      </div>
      {err
        ? <p className="text-[10px] mt-2 leading-relaxed" style={{ color: 'var(--warn)' }}>Couldn’t list models ({err}). You can still type an id — it’s used as-is. Current: <span className="mono">{sel || fallback}</span>.</p>
        : <p className="text-[10px] text-[var(--t4)] mt-2 leading-relaxed">{models.length} model(s) available on your key. Drives Ask Vector chat, Inbox summaries & follow-ups. Blank = server default (<span className="mono">{fallback || 'gemini-2.5-flash'}</span>).</p>}
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
    <div className="mt-4 pt-4 border-t border-[var(--line)]">
      <label className="block text-[10.5px] font-semibold uppercase tracking-wider text-[var(--t3)] mb-2">
        Job report categories
      </label>
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
        className="w-full px-2.5 py-2 rounded-[9px] text-[11.5px] leading-relaxed border border-[var(--line-2)] bg-[var(--s1)] text-[var(--t1)] focus:border-[var(--accent-line)] focus:outline-none resize-y"
      />
      <div className="flex items-center justify-between mt-2 gap-3">
        <p className="text-[10px] text-[var(--t4)] leading-relaxed">
          One category per line — the Report tab sorts every job into exactly one of these.
          The <b>last line is the catch-all</b> for anything that doesn’t fit.
          {usingDefaults && ' Currently using the defaults.'}
        </p>
        {!usingDefaults && (
          <button type="button" onClick={() => onChange([])}
            className="shrink-0 text-[10.5px] font-medium" style={{ color: 'var(--accent-text)' }}>
            Reset
          </button>
        )}
      </div>
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
      <Field key={key} label={label} hint={hint}>
        <TextInput value={(form![key] as string) ?? ''}
          onChange={e => setForm(f => f ? { ...f, [key]: e.target.value } : f)}
          className="mono" />
      </Field>
    );
  }

  return (
    <div className="space-y-[22px]">
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
            hint={form.gemini_key_set && !form.gemini_key
              ? "Key is configured — leave blank to keep it, or enter a new key to replace it"
              : "From console.google.com → API key — powers the Ask AI feature"}
            value={form.gemini_key ?? ''}
            onChange={v => setForm(f => f ? { ...f, gemini_key: v } : f)}
          />
          <AiModelField
            value={form.ai_model ?? ''}
            onChange={v => setForm(f => f ? { ...f, ai_model: v } : f)}
          />
          <JobCategoriesField
            value={form.job_categories ?? []}
            onChange={v => setForm(f => f ? { ...f, job_categories: v } : f)}
          />
        </div>

        {/* LSD Pricing. All three are optional — the tab falls back to the newest
            .xlsb in data/lsd, the Desktop case archive, and R2321. */}
        <div className="mt-5 pt-4 border-t border-[var(--line)] space-y-4">
          <label className="block text-[10.5px] font-semibold uppercase tracking-wider text-[var(--t3)]">LSD Pricing</label>
          {field('lsd_master_model', 'Master CPQ model',
                 'Full path to the "CPQ Pricing Model LSD … V2" .xlsb. Blank = newest .xlsb in data\\lsd')}
          {field('lsd_cases_root',   'Case folder root',
                 'Where generated case folders are written. Blank = Desktop\\LSD Pricing Doc')}
          {field('lsd_ledger',       'MV ledger code',
                 'Keys the prior-year country average. This master carries R2321 (UAE) only')}
          {field('lsd_cpq_port',     'CPQ debug port',
                 'Edge remote-debugging port for the Fetch-from-CPQ button. Blank = 9222')}
          {field('lsd_register',     'Daily register',
                 'Workbook every priced transaction is logged into — it stays on this machine. Blank = <case root>\\LSD Daily Work - Vector.xlsx. Point it at a copy of the real LSD Daily work sheet to write into its own columns')}
          {field('lsd_request_type', 'Request type',
                 'REQUEST TYPE written on every item posted to the Quotations List. Blank = Standard CTO')}
          {field('lsd_sales_name',   'Sales name',
                 'Fills the register’s Sales Name column. Blank = the Inside Sales name above')}
          {field('lsd_bu',           'Business unit',
                 'Fills the register’s BU column — EL, FIRE or CBS. Blank = guessed from the APRC toggle')}
          {field('lsd_approver',     'Approver',
                 'Who a sub-target margin is mailed to. A display name ("Poulose, Kiran") is resolved against the address book. The mail is always drafted, never sent')}
          {field('lsd_approver_cc',  'Approval cc',
                 'Copied on every approval mail — usually the pricing analyst')}
          <Field label="Keep tabs alive"
                 hint="One URL per line. Vector reloads each of these in a minimized debug-rail Edge on a timer, so CPQ and the OneDrive pages are still signed in when a fetch runs. Blank = eaton.bigmachines.com + the QuotationFactoryEMEA site.">
            <textarea rows={4} spellCheck={false}
              value={(form!.lsd_keepalive_urls as string) ?? ''}
              onChange={e => setForm(f => f ? { ...f, lsd_keepalive_urls: e.target.value } : f)}
              className="mono w-full px-[11px] py-2 rounded-[9px] text-[12px] bg-[var(--s1)] border border-[var(--line-2)] text-[var(--t1)] focus:border-[var(--accent-line)] focus:outline-none transition-colors" />
          </Field>
          {field('lsd_keepalive_min', 'Keep-alive every (min)',
                 'Minutes between background reloads. Blank = 10, minimum 2. Set the toggle below off to stop the sweeps entirely')}
          <Field label="Keep-alive timer"
                 hint="Off stops the background reloads; the tabs stay as they are and a fetch may hit an expired session.">
            <Button tone="outline" size="sm"
              onClick={() => setForm(f => f ? { ...f, lsd_keepalive: f.lsd_keepalive === false } : f)}>
              {form!.lsd_keepalive === false ? 'Off' : 'On'}
            </Button>
          </Field>
        </div>

        {/* Language. Scope is stated because it is real: the translations cover the
            navigation, the header and this screen. Page content is English only,
            and a picker that implies otherwise reads as a broken feature. */}
        <div className="mt-5 pt-4 border-t border-[var(--line)]">
          <label className="block text-[10.5px] font-semibold uppercase tracking-wider text-[var(--t3)] mb-1">{t.language}</label>
          <p className="text-[11.5px] text-[var(--t3)] mb-2">
            {t.language_scope}
          </p>
          <div className="flex gap-2">
            {(Object.keys(LANG_LABELS) as Lang[]).map(l => (
              <button key={l} onClick={() => setLang(l)}
                style={lang === l
                  ? { background: 'var(--t1)', color: 'var(--bg)', border: '1px solid transparent' }
                  : { background: 'var(--s1)', color: 'var(--t3)', border: '1px solid var(--line-2)' }}
                className="px-4 py-1.5 text-[11.5px] font-semibold rounded-[9px] transition-all">
                {LANG_LABELS[l]}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-2 mt-5 pt-4 border-t border-[var(--line)]">
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
            style={{ background: sched.enabled ? 'var(--accent)' : 'var(--line-3)' }}
            className="relative w-10 h-[22px] rounded-full transition-colors">
            <span className={cn(
              'absolute top-0.5 w-[18px] h-[18px] rounded-full bg-white shadow transition-transform',
              sched.enabled ? 'translate-x-5' : 'translate-x-0.5',
            )} />
          </button>
          <span className="text-[12px] text-[var(--t2)]">
            {sched.enabled ? 'Schedule active' : 'Manual control (current)'}
          </span>
        </div>
        <div className={cn('grid grid-cols-2 gap-4 transition-opacity', !sched.enabled && 'opacity-40 pointer-events-none')}>
          <div>
            <label className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[var(--t2)] mb-1.5">
              <Sun className="w-3.5 h-3.5" style={{ color: 'var(--warn)' }} /> Light mode from
            </label>
            <input type="time" value={sched.lightFrom}
              onChange={e => setSched(s => ({ ...s, lightFrom: e.target.value }))}
              className="w-full h-[34px] px-2.5 rounded-[9px] text-[11.5px] mono border border-[var(--line-2)] bg-[var(--s1)] text-[var(--t1)] focus:border-[var(--accent-line)] focus:outline-none" />
          </div>
          <div>
            <label className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[var(--t2)] mb-1.5">
              <Moon className="w-3.5 h-3.5" style={{ color: 'var(--violet)' }} /> Dark mode from
            </label>
            <input type="time" value={sched.darkFrom}
              onChange={e => setSched(s => ({ ...s, darkFrom: e.target.value }))}
              className="w-full h-[34px] px-2.5 rounded-[9px] text-[11.5px] mono border border-[var(--line-2)] bg-[var(--s1)] text-[var(--t1)] focus:border-[var(--accent-line)] focus:outline-none" />
          </div>
        </div>
      </Card>

      {/* Server log */}
      <LogViewer />
    </div>
  );
}
