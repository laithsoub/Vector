// ─── LSD pricing rules — the rule table and its approval queue ───────────────
// The numbers the engine prices by (RPI gates, concession band, customer
// exceptions) with who set each one, where it came from and the dates it holds
// for. A change is proposed here, waits in the queue, and only prices anything
// once someone approves it. Nothing is edited in place: approving a change
// closes out the rule it replaces, so the history of every number stays.
//
// The engine owns what a key means — lsd_pricing.py vets a value before the
// server takes the proposal — so this page only formats and collects.
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ChevronRight, Scale, Plus, Check, X, Archive, Pencil, History, MailSearch } from 'lucide-react';

import { Select } from '../ui';
import { cn } from '../lib/cn';
import { Card, Pill, Field, TextInput, Button, relTime } from '../lib/ui';
import { api } from '../lib/api';
import type { Rule, RuleProposal } from '../lib/api';
import { failed, plural } from '../lib/errors';
import type { ToastFn } from '../App';

const EXC = 'rpi_exception.';
// The single-number keys and the band. Exceptions are a family, one per customer.
const KEYS: { key: string; label: string; list?: boolean }[] = [
  { key: 'rpi_rate.H1',       label: 'RPI gate, H1' },
  { key: 'rpi_rate.H2',       label: 'RPI gate, H2' },
  { key: 'rpi_working_level', label: 'RPI working level' },
  { key: 'add_disc_cap',      label: 'Add. Discount cap' },
  { key: 'std_discount',      label: 'Default customer condition' },
  { key: 'e2e_concession',    label: 'E2E concession band', list: true },
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pctOf = (n: unknown) =>
  typeof n === 'number' ? `${+(n * 100).toFixed(3)}%` : '—';

// "6", "6%", "6,5" → 0.06 / 0.065. Blank or junk → NaN, which the engine refuses.
const fromPct = (s: string) => {
  const t = s.replace('%', '').replace(',', '.').trim();
  return t === '' ? NaN : Number(t) / 100;
};
const splitList = (s: string) => s.split(/[,;\n]/).map(x => x.trim()).filter(Boolean);

function showValue(key: string, v: any): string {
  if (key.startsWith('guideline.') && v && typeof v === 'object') return String(v.text || '');
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (key.startsWith(EXC) && v && typeof v === 'object') {
    const who = [...(v.customers || []), ...(v.names || []).map((n: string) => `"${n}"`)].join(', ');
    return `${pctOf(v.rate)} from ${MONTHS[(v.from_month || 1) - 1]} · ${who}`;
  }
  if (Array.isArray(v)) return v.map(pctOf).join(' → ');
  return pctOf(v);
}

const span = (r: Rule) =>
  !r.validFrom && !r.validTo ? 'always'
    : `${r.validFrom || '…'} → ${r.validTo ? r.validTo : 'open'}`;

const STATUS_TONE = { proposed: 'warn', approved: 'ok', rejected: 'err', retired: 'neutral' } as const;

// ─── the proposal form ───────────────────────────────────────────────────────
type Draft = {
  key: string; newExc: boolean; supersedes?: number;
  value: string;                                   // number / list keys, in %
  label: string; customers: string; names: string; fromMonth: string; rate: string; book: string;
  title: string; why: string; source: string; sourceRef: string; validFrom: string; validTo: string;
};

function draftFrom(r?: Rule): Draft {
  const v = r?.value;
  const exc = !!r && r.key.startsWith(EXC);
  return {
    key: r?.key || 'rpi_rate.H2', newExc: false, supersedes: r?.id,
    value: !r || exc ? '' : Array.isArray(v) ? v.map(x => +(x * 100).toFixed(3)).join(', ') : String(+(v * 100).toFixed(3)),
    label: exc ? v.label || '' : '', customers: exc ? (v.customers || []).join(', ') : '',
    names: exc ? (v.names || []).join(', ') : '', fromMonth: String(exc ? v.from_month || 1 : 1),
    rate: exc ? String(+(v.rate * 100).toFixed(3)) : '', book: exc ? v.book || '' : '',
    title: r?.title || '', why: r?.why || '', source: '', sourceRef: '', validFrom: '', validTo: '',
  };
}

function ProposeForm({ from, onDone, onCancel, toast }: {
  from?: Rule; onDone: () => void; onCancel: () => void; toast: ToastFn;
}) {
  const [d, setD] = useState<Draft>(() => draftFrom(from));
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setD(x => ({ ...x, [k]: e.target.value }));
  const isExc = d.newExc || d.key.startsWith(EXC);
  const list = KEYS.find(k => k.key === d.key)?.list;

  const submit = async () => {
    const value = isExc
      ? { label: d.label.trim(), customers: splitList(d.customers), names: splitList(d.names).map(n => n.toLowerCase()),
          from_month: Number(d.fromMonth), rate: fromPct(d.rate), why: d.why.trim(), book: d.book.trim() || null }
      : list ? splitList(d.value).map(fromPct) : fromPct(d.value);
    const key = d.newExc
      ? EXC + d.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      : d.key;
    const p: RuleProposal = {
      key, value, title: d.title.trim() || (isExc ? `RPI exception: ${d.label.trim()}` : KEYS.find(k => k.key === key)?.label),
      why: d.why.trim() || undefined, source: d.source.trim(), sourceRef: d.sourceRef.trim() || undefined,
      validFrom: d.validFrom || undefined, validTo: d.validTo || undefined, supersedes: d.supersedes,
    };
    setBusy(true);
    try {
      const r = await api.rulePropose(p);
      if (r.ok) { toast('ok', 'Proposed — it prices nothing until it is approved.'); onDone(); }
      else toast('err', r.error || 'The rule was refused.');
    } catch (e) { toast('err', failed('propose the rule', e)); }
    setBusy(false);
  };

  return (
    <div className="rounded-control border border-line-2 p-3 flex flex-col gap-3">
      <div className="text-xs font-semibold text-fg">
        {from ? `Change #${from.id} — ${from.title || from.key}` : 'Propose a rule'}
      </div>
      {!from && (
        <Field label="Rule">
          <Select value={d.newExc ? '__exc' : d.key}
            onChange={v => setD(x => ({ ...x, newExc: v === '__exc', key: v === '__exc' ? x.key : (v || x.key) }))}
            data={[...KEYS.map(k => ({ value: k.key, label: k.label })),
                   { value: '__exc', label: 'New customer RPI exception…' }]} />
        </Field>
      )}
      {isExc ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Customer label" required><TextInput value={d.label} onChange={set('label')} disabled={!d.newExc} /></Field>
          <Field label="RPI rate (%)" required><TextInput value={d.rate} onChange={set('rate')} placeholder="2.5" /></Field>
          <Field label="Customer numbers" hint="Comma-separated"><TextInput value={d.customers} onChange={set('customers')} /></Field>
          <Field label="Name matches" hint="Whole words, comma-separated"><TextInput value={d.names} onChange={set('names')} /></Field>
          <Field label="From month (each year)">
            <Select value={d.fromMonth} onChange={v => setD(x => ({ ...x, fromMonth: v || '1' }))}
              data={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} />
          </Field>
          <Field label="Fixed-price book" hint="Filename pattern, optional"><TextInput value={d.book} onChange={set('book')} /></Field>
        </div>
      ) : (
        <Field label={list ? 'Rungs (%)' : 'Value (%)'} required hint={list ? 'Comma-separated, e.g. 37, 35' : 'e.g. 6 for 6%'}>
          <TextInput value={d.value} onChange={set('value')} />
        </Field>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Holds from" hint="Transaction date; blank = always"><TextInput type="date" value={d.validFrom} onChange={set('validFrom')} /></Field>
        <Field label="Until (exclusive)" hint="Blank = open-ended"><TextInput type="date" value={d.validTo} onChange={set('validTo')} /></Field>
      </div>
      <Field label="Source" required hint="Who said it, where — a mail, a call, a case number">
        <TextInput value={d.source} onChange={set('source')} placeholder="Dalia, review call 2026-09-15, W262223256E" />
      </Field>
      <Field label="Link or file" hint="Optional"><TextInput value={d.sourceRef} onChange={set('sourceRef')} /></Field>
      <Field label="Why">
        <textarea value={d.why} onChange={set('why')} rows={2}
          className="w-full px-2.5 py-1.5 rounded-control text-sm bg-surface border border-line-2 text-fg focus:outline-none focus:border-accent" />
      </Field>
      <div className="flex gap-2 justify-end">
        <Button tone="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button size="sm" Icon={Plus} onClick={submit} disabled={busy || !d.source.trim()}>Send for approval</Button>
      </div>
    </div>
  );
}

// ─── one rule ────────────────────────────────────────────────────────────────
function RuleItem({ r, current, onAct, onChange, busy }: {
  r: Rule; current?: Rule; busy: boolean;
  onAct: (r: Rule, a: 'approve' | 'reject' | 'retire') => void; onChange?: (r: Rule) => void;
}) {
  return (
    <div className="py-2 border-t border-line first:border-t-0 flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm font-medium text-fg truncate">{r.title || r.key}</span>
        <Pill tone={STATUS_TONE[r.status]}>{r.status}</Pill>
        <span className="text-2xs text-fg-3 shrink-0">#{r.id}</span>
        <div className="ml-auto flex gap-1.5 shrink-0">
          {r.status === 'proposed' && <>
            <Button size="sm" tone="success" Icon={Check} disabled={busy} onClick={() => onAct(r, 'approve')}>Approve</Button>
            <Button size="sm" tone="ghost" Icon={X} disabled={busy} onClick={() => onAct(r, 'reject')}>Reject</Button>
          </>}
          {r.status === 'approved' && onChange && <>
            <Button size="sm" tone="ghost" Icon={Pencil} disabled={busy} onClick={() => onChange(r)}>Change</Button>
            <Button size="sm" tone="ghost" Icon={Archive} disabled={busy} onClick={() => onAct(r, 'retire')}>Retire</Button>
          </>}
        </div>
      </div>
      <div className="mono text-sm">
        {current && r.status === 'proposed' && (
          <span className="text-fg-3 line-through mr-2">{showValue(current.key, current.value)}</span>
        )}
        <span className="text-fg">{showValue(r.key, r.value)}</span>
        <span className="text-2xs text-fg-3 ml-2">{span(r)}</span>
      </div>
      {r.why && <div className="text-xs text-fg-2 leading-snug">{r.why}</div>}
      <div className="text-2xs text-fg-3">
        {r.source}
        {r.sourceRef && <> · <span className="mono">{r.sourceRef}</span></>}
        {' · '}proposed by {r.proposedBy || '?'} {relTime(r.proposedAt)}
        {r.decidedAt && <> · {r.status} by {r.decidedBy} {relTime(r.decidedAt)}</>}
        {r.decisionNote && <> — {r.decisionNote}</>}
      </div>
    </div>
  );
}

// ─── the panel ───────────────────────────────────────────────────────────────
export function RulesPanel({ toast }: { toast: ToastFn }) {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState(false);
  const [form, setForm] = useState<{ from?: Rule } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.rules('lsd');
      if (r.ok) { setRules(r.rules || []); setError(null); } else setError(r.error || 'Could not read the rules.');
    } catch (e) { setError(failed('read the pricing rules', e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const { waiting, inForce, past } = useMemo(() => {
    const all = rules || [];
    return {
      waiting: all.filter(r => r.status === 'proposed'),
      inForce: all.filter(r => r.status === 'approved').sort((a, b) => a.key.localeCompare(b.key) || a.id - b.id),
      past:    all.filter(r => r.status === 'rejected' || r.status === 'retired'),
    };
  }, [rules]);

  // What a proposal would replace, for the was → now line.
  const currentFor = (r: Rule) =>
    inForce.find(o => o.id === r.supersedes) || inForce.filter(o => o.key === r.key && !o.validTo).pop();

  const act = async (r: Rule, a: 'approve' | 'reject' | 'retire') => {
    setBusy(true);
    try {
      const res = await api.ruleDecide(r.id, a);
      if (res.ok) toast('ok', a === 'approve' ? `#${r.id} approved — the next run prices by it.` : `#${r.id} ${a}ed.`);
      else toast('err', res.error || `Could not ${a} #${r.id}.`);
      await load();
    } catch (e) { toast('err', failed(`${a} the rule`, e)); }
    setBusy(false);
  };

  // Sweep Dalia's and Kiran's mail and let the model propose what it finds.
  const [mining, setMining] = useState(false);
  const mine = async () => {
    setMining(true);
    try {
      const before = waiting.length;
      const r = await api.rulesMine(true);
      if (!r.ok) toast('err', r.error || 'Could not read the mail for rules.');
      else {
        const n = (r.waiting || 0) - before;
        toast('ok', n > 0 ? `${plural(n, 'new rule')} from the mail — waiting your approval.`
                          : 'Mail read — nothing new that changes a rule.');
      }
      await load(); setOpen(true);
    } catch (e) { toast('err', failed('read the mail for rules', e)); }
    setMining(false);
  };

  if (!rules && !error) return null;

  return (
    <Card className="order-1">
      <div className="flex items-center gap-2 min-w-0">
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 min-w-0 text-left">
          <ChevronRight className={cn('w-3.5 h-3.5 shrink-0 text-fg-3 transition-transform', open && 'rotate-90')} />
          <Scale className="w-4 h-4 shrink-0 text-fg-2" />
          <span className="text-sm font-semibold text-fg truncate">Pricing rules</span>
        </button>
        <span className="text-xs tabular-nums px-1.5 py-px rounded-md shrink-0"
              style={waiting.length ? { color: 'var(--accent)', background: 'var(--s3)' } : { color: 'var(--t3)' }}>
          {waiting.length ? `${waiting.length} waiting approval` : `${inForce.length} in force`}
        </span>
        {error && <span className="ml-auto text-2xs truncate" style={{ color: 'var(--err)' }}>{error}</span>}
        <Button size="sm" tone="ghost" Icon={MailSearch} className="ml-auto shrink-0" disabled={mining}
                onClick={mine} title="Read Dalia's and Kiran's mail for pricing rules">
          {mining ? 'Reading mail…' : 'Rules from mail'}
        </Button>
        {open && !form && (
          <Button size="sm" tone="ghost" Icon={Plus} className="shrink-0" onClick={() => setForm({})}>Propose</Button>
        )}
      </div>

      {open && (
        <div className="mt-2.5 flex flex-col gap-3">
          {form && (
            <ProposeForm from={form.from} toast={toast}
              onCancel={() => setForm(null)} onDone={() => { setForm(null); load(); }} />
          )}
          {waiting.length > 0 && (
            <div>
              <div className="eyebrow mb-1">Waiting approval</div>
              {waiting.map(r => <RuleItem key={r.id} r={r} current={currentFor(r)} onAct={act} busy={busy} />)}
            </div>
          )}
          <div>
            <div className="eyebrow mb-1">In force</div>
            {inForce.map(r => <RuleItem key={r.id} r={r} onAct={act} busy={busy}
                                        onChange={x => { setForm({ from: x }); }} />)}
          </div>
          {past.length > 0 && (
            <>
              <button onClick={() => setHistory(h => !h)}
                      className="self-start flex items-center gap-1 text-xs text-fg-3 hover:text-fg">
                <History className="w-3 h-3" />
                {history ? 'Hide' : 'Show'} {plural(past.length, 'retired or rejected rule')}
              </button>
              {history && <div>{past.map(r => <RuleItem key={r.id} r={r} onAct={act} busy={busy} />)}</div>}
            </>
          )}
        </div>
      )}
    </Card>
  );
}
