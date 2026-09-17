// ─── To-Do page — what the shared mailbox still owes ─────────────────────────
// Triages every UNANSWERED thread in the UKQuoteFactoryEL box into three buckets:
// doable here (direct), blocked on a missing fact (needs_info), or somebody else's
// to act on (needs_team). Each item can carry a delegation message with the source
// email's attachments — but nothing is ever mailed until Send is pressed here.
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  ListTodo, Loader2, Play, Search, Plus, X, Trash2, CheckCircle2, Clock,
  Mail, Paperclip, Sparkles, Send, FileEdit, AlertCircle, HelpCircle, Users,
  RefreshCw, CalendarDays, ChevronRight, Inbox as InboxIcon, GripVertical,
} from 'lucide-react';

import { cn } from '../lib/cn';
import { Card, CardTitle, Pill, Field, TextInput, relTime } from '../lib/ui';
import { Button, EmptyState, Input, Section, Segmented, Select, Stat, StatRow, Toolbar, Button as UiButton, IconButton as UiIconButton } from '../ui';
import { api } from '../lib/api';
import { failed, plural } from '../lib/errors';
import { runTask, isCancel } from '../lib/tasks';
import type {
  TodoItem, TodoBucket, TodoStatus, TodoScanStatus, TodoRecipientOption, TodoRecipient,
} from '../types';
import type { ToastFn } from '../App';

// ─── Bucket presentation ─────────────────────────────────────────────────────
const BUCKETS: Array<{
  id: TodoBucket; label: string; sub: string;
  icon: typeof ListTodo; tone: 'ok' | 'warn' | 'violet'; color: string;
}> = [
  { id: 'direct',     label: 'I can do this',  sub: 'Everything needed is already in the email',
    icon: CheckCircle2, tone: 'ok',     color: 'var(--ok)' },
  { id: 'needs_info', label: 'Needs more info', sub: 'Blocked until someone supplies a missing fact',
    icon: HelpCircle,   tone: 'warn',   color: 'var(--warn)' },
  { id: 'needs_team', label: 'Needs the team',  sub: 'Sales, customer service or technical must act',
    icon: Users,        tone: 'violet', color: 'var(--violet)' },
];

const bucketMeta = (b: TodoBucket) => BUCKETS.find(x => x.id === b) || BUCKETS[0];

const today = () => new Date().toISOString().slice(0, 10);
const isOverdue = (t: TodoItem) => !!t.due && t.due < today() && t.status !== 'done';

const fmtDue = (d: string) => {
  if (!d) return 'No date';
  const days = Math.round((new Date(d + 'T00:00:00').getTime() - new Date(today() + 'T00:00:00').getTime()) / 864e5);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days < 0) return `${-days} days late`;
  return `In ${days} days`;
};

const waitingDays = (iso: string) => {
  if (!iso) return 0;
  const ms = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 864e5)) : 0;
};

// ─── Recipient picker ────────────────────────────────────────────────────────
// The list is everyone this desk actually corresponds with (harvested from
// Outlook) merged with the CRM's contacts. A free-typed address is allowed too —
// the picker must never be a reason not to file a to-do.
function RecipientPicker({
  value, onChange, options, loading, onRefresh, refreshing,
}: {
  value: TodoRecipient[];
  onChange: (v: TodoRecipient[]) => void;
  options: TodoRecipientOption[];
  loading: boolean;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);

  const chosen = new Set(value.map(v => v.email.toLowerCase()));
  const hits = useMemo(() => {
    const term = q.trim().toLowerCase();
    return options
      .filter(o => !chosen.has(o.email.toLowerCase()))
      .filter(o => !term || o.name.toLowerCase().includes(term) || o.email.toLowerCase().includes(term))
      .slice(0, 40);
  }, [q, options, value]);

  const add = (r: TodoRecipient) => {
    if (chosen.has(r.email.toLowerCase())) return;
    onChange([...value, r]);
    setQ('');
  };

  const typedIsEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q.trim());

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {value.map(r => (
          <span key={r.email}
            className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full text-xs bg-accent-soft text-accent-text border border-accent-line">
            <span className="truncate max-w-56" title={r.email}>{r.name || r.email}</span>
            <UiIconButton icon={X} label="Remove" onClick={() => onChange(value.filter(v => v.email !== r.email))} />
          </span>
        ))}
        {!value.length && <span className="text-xs text-fg-4">Nobody yet — this stays with you.</span>}
      </div>

      <div className="relative">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-fg-4" />
            <TextInput
              value={q}
              onChange={e => { setQ(e.target.value); setOpen(true); }}
              onFocus={() => setOpen(true)}
              onBlur={() => window.setTimeout(() => setOpen(false), 150)}
              onKeyDown={e => {
                if (e.key === 'Enter' && typedIsEmail) { add({ name: q.trim(), email: q.trim() }); e.preventDefault(); }
              }}
              placeholder="Search the people you email, or type an address"
              className="pl-8"
            />
          </div>
          <UiButton tone="secondary" size="md" aria-label="Re-read who you correspond with from Outlook" onClick={onRefresh} disabled={refreshing} hint="Re-read who you correspond with from Outlook">
            {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Refresh
          </UiButton>
        </div>

        {open && (
          <div className="absolute z-30 left-0 right-0 mt-1 max-h-64 overflow-y-auto vec-scroll rounded-panel border border-line-2 bg-surface shadow-float">
            {loading && <p className="px-3 py-2.5 text-xs text-fg-3">Loading people…</p>}
            {!loading && typedIsEmail && (
              <button onMouseDown={() => add({ name: q.trim(), email: q.trim() })}
                className="w-full text-left px-3 py-2 text-xs hover:bg-raised transition-colors border-b border-line">
                <span className="text-accent-text font-semibold">Use “{q.trim()}”</span>
              </button>
            )}
            {!loading && !hits.length && !typedIsEmail && (
              <p className="px-3 py-2.5 text-xs text-fg-3">
                {options.length ? 'No match.' : 'No people harvested yet — hit Refresh.'}
              </p>
            )}
            {hits.map(o => (
              <button key={o.email} onMouseDown={() => add({ name: o.name, email: o.email })}
                className="w-full text-left px-3 py-2 hover:bg-raised transition-colors flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="block text-xs text-fg truncate">{o.name || o.email}</span>
                  <span className="block text-2xs text-fg-4 truncate">{o.email}</span>
                </span>
                <span className="shrink-0 text-2xs text-fg-4">
                  {o.source === 'crm' ? 'CRM' : `${o.count} mails`}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Item detail / editor ────────────────────────────────────────────────────
function TodoDetail({
  item, onClose, onSaved, onDeleted, toast, options, optionsLoading, onRefreshOptions, refreshingOptions,
}: {
  item: TodoItem;
  onClose: () => void;
  onSaved: (t: TodoItem) => void;
  onDeleted: (id: number) => void;
  toast: ToastFn;
  options: TodoRecipientOption[];
  optionsLoading: boolean;
  onRefreshOptions: () => void;
  refreshingOptions: boolean;
}) {
  const [draft, setDraft]   = useState<TodoItem>(item);
  const [saving, setSaving] = useState(false);
  const [writing, setWriting] = useState(false);
  const [sending, setSending] = useState<'draft' | 'send' | null>(null);
  const [confirmSend, setConfirmSend] = useState(false);

  useEffect(() => { setDraft(item); setConfirmSend(false); }, [item.id]);

  const set = <K extends keyof TodoItem>(k: K, v: TodoItem[K]) => setDraft(d => ({ ...d, [k]: v }));

  async function save(extra: Partial<TodoItem> = {}, quiet = false) {
    setSaving(true);
    try {
      const r = await api.todoSave({ ...draft, ...extra, id: draft.id });
      if (r.item) { setDraft(r.item); onSaved(r.item); }
      if (!quiet) toast('ok', 'To-Do item saved');
      return r.item;
    } catch (e: any) { toast('err', failed('save the To-Do item', e)); }
    finally { setSaving(false); }
  }

  async function writeDraft() {
    if (!draft.recipients.length) { toast('warn', 'Pick at least one recipient before writing the message'); return; }
    setWriting(true);
    try {
      // Persist first — the server writes the message from the stored row.
      await save({}, true);
      const r = await runTask('Writing the message…', s => api.todoWriteDraft(draft.id, s));
      if (r.error) { toast('err', failed('write the draft message', r.error)); return; }
      setDraft(d => ({ ...d, draftSubject: r.subject || d.draftSubject, draftBody: r.body || d.draftBody }));
      toast('ok', 'Draft written — read it before you send it');
    } catch (e: any) { if (!isCancel(e)) toast('err', failed('write the draft message', e)); }
    finally { setWriting(false); }
  }

  async function send(asDraft: boolean) {
    if (!draft.recipients.length) { toast('warn', 'Pick at least one recipient before sending'); return; }
    if (!draft.draftBody.trim())  { toast('warn', 'The message is empty — write it before sending'); return; }
    setSending(asDraft ? 'draft' : 'send');
    const who = draft.recipients.map(r => r.email).join(', ');
    try {
      await save({}, true);
      const r = await api.todoSend(draft.id, asDraft);
      if (!r.ok) { toast('err', failed(asDraft ? 'save the message to Outlook drafts' : `send the message to ${who}`, r.error)); return; }
      if (r.item) { setDraft(r.item); onSaved(r.item); }
      toast('ok', asDraft ? 'Message saved in your Outlook drafts — nothing was sent' : `Message sent to ${who} — item moved to Waiting`);
      setConfirmSend(false);
      if (!asDraft) onClose();
    } catch (e: any) { toast('err', failed(asDraft ? 'save the message to Outlook drafts' : `send the message to ${who}`, e)); }
    finally { setSending(null); }
  }

  async function remove() {
    try {
      await api.todoDelete(draft.id);
      onDeleted(draft.id);
      toast('ok', 'Item removed from the To-Do board');
      onClose();
    } catch (e: any) { toast('err', failed('remove the To-Do item', e)); }
  }

  const meta = bucketMeta(draft.bucket);

  return (
    <div className="fixed inset-0 z-40 flex items-stretch justify-end bg-overlay "
      onClick={onClose}>
      <div className="w-full max-w-180 h-full overflow-y-auto vec-scroll bg-page border-l border-line "
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="sticky top-0 z-10 px-5 py-4 bg-page border-b border-line flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1.5">
              <Pill tone={meta.tone} dot>{meta.label}</Pill>
              {draft.status === 'waiting' && <Pill tone="brand">Waiting on a reply</Pill>}
              {draft.status === 'done'    && <Pill tone="ok">Done</Pill>}
              {isOverdue(draft) && <Pill tone="err">{fmtDue(draft.due)}</Pill>}
            </div>
            <input value={draft.title} onChange={e => set('title', e.target.value)}
              className="w-full bg-transparent text-lg font-semibold text-fg outline-none border-b border-transparent focus:border-accent-line transition-colors" />
            {draft.sender && (
              <p className="text-xs text-fg-3 mt-1.5 truncate">
                From {draft.sender} &lt;{draft.senderEmail}&gt; · {relTime(draft.received)}
                {draft.received && ` · waiting ${waitingDays(draft.received)}d`}
              </p>
            )}
          </div>
          <UiIconButton icon={X} label="Close" onClick={onClose} />
        </div>

        <div className="p-5 space-y-4">
          {/* What it is */}
          <Card>
            <CardTitle title="The job" sub="What the AI read out of the thread — edit anything that's off" />
            <div className="space-y-3">
              <Field label="Next step">
                <textarea value={draft.action} onChange={e => set('action', e.target.value)} rows={2}
                  className="w-full px-3 py-2 rounded-panel text-sm bg-surface border border-line-2 text-fg focus:border-accent-line focus:outline-none resize-y" />
              </Field>
              {draft.bucket !== 'direct' && (
                <Field label={draft.bucket === 'needs_info' ? "What's missing" : 'Who must act'}>
                  <textarea value={draft.blocker} onChange={e => set('blocker', e.target.value)} rows={2}
                    className="w-full px-3 py-2 rounded-panel text-sm bg-surface border border-line-2 text-fg focus:border-accent-line focus:outline-none resize-y" />
                </Field>
              )}
              <Field label="My notes">
                <textarea value={draft.notes} onChange={e => set('notes', e.target.value)} rows={2}
                  placeholder="Anything you want to remember about this one"
                  className="w-full px-3 py-2 rounded-panel text-sm bg-surface border border-line-2 text-fg focus:border-accent-line focus:outline-none resize-y" />
              </Field>

              <div className="grid grid-cols-3 gap-3">
                <Field label="Bucket">
                  <select value={draft.bucket} onChange={e => set('bucket', e.target.value as TodoBucket)}
                    className="w-full h-8 px-2 rounded-panel text-sm bg-surface border border-line-2 text-fg focus:border-accent-line focus:outline-none">
                    {BUCKETS.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
                  </select>
                </Field>
                <Field label="Due">
                  <TextInput type="date" value={draft.due} onChange={e => set('due', e.target.value)} />
                </Field>
                <Field label="Priority">
                  <select value={draft.priority} onChange={e => set('priority', e.target.value as 'high' | 'normal')}
                    className="w-full h-8 px-2 rounded-panel text-sm bg-surface border border-line-2 text-fg focus:border-accent-line focus:outline-none">
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                  </select>
                </Field>
              </div>

              {draft.summary && (
                <Field label="From the email">
                  <p className="text-xs text-fg-2 leading-relaxed whitespace-pre-wrap max-h-40 overflow-y-auto vec-scroll p-3 rounded-panel bg-surface border border-line">
                    {draft.summary}
                  </p>
                </Field>
              )}
            </div>
          </Card>

          {/* Hand-off */}
          <Card>
            <CardTitle
              title="Hand-off"
              sub="Nothing leaves Outlook until you press Send here"
              right={draft.sentAt ? <Pill tone="brand">Sent {relTime(draft.sentAt)}</Pill> : undefined}
            />
            <div className="space-y-3">
              <Field label="To">
                <RecipientPicker
                  value={draft.recipients}
                  onChange={v => set('recipients', v)}
                  options={options}
                  loading={optionsLoading}
                  onRefresh={onRefreshOptions}
                  refreshing={refreshingOptions}
                />
              </Field>

              {!!draft.attachments.length && (
                <Field label="Attachments carried from the email" hint="Pulled live off the original message when you send">
                  <div className="flex flex-wrap gap-1.5">
                    {draft.attachments.map(a => (
                      <span key={a.index}
                        className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full text-xs bg-raised border border-line-2 text-fg-2">
                        <Paperclip className="w-3 h-3 text-fg-4" />
                        <span className="truncate max-w-48" title={a.name}>{a.name}</span>
                        <UiIconButton icon={X} label="Don't attach this" onClick={() => set('attachments', draft.attachments.filter(x => x.index !== a.index))} />
                      </span>
                    ))}
                  </div>
                </Field>
              )}

              <Field label="Subject">
                <TextInput value={draft.draftSubject}
                  placeholder={draft.subject ? `FW: ${draft.subject}` : draft.title}
                  onChange={e => set('draftSubject', e.target.value)} />
              </Field>

              <Field label="Message">
                <textarea value={draft.draftBody} onChange={e => set('draftBody', e.target.value)} rows={9}
                  placeholder="Write it yourself, or let Vector draft it from the item above."
                  className="w-full px-3 py-2 rounded-panel text-sm leading-relaxed bg-surface border border-line-2 text-fg focus:border-accent-line focus:outline-none resize-y mono" />
              </Field>

              <div className="flex flex-wrap items-center gap-2">
                <button onClick={writeDraft} disabled={writing}
                  className="h-8 px-3 rounded-panel text-xs font-semibold bg-ai-soft text-ai hover:opacity-80 transition-opacity disabled:opacity-50 flex items-center gap-1.5">
                  {writing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  Write it for me
                </button>
                <UiButton tone="secondary" size="md" onClick={() => send(true)} disabled={!!sending}>
                  {sending === 'draft' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileEdit className="w-3.5 h-3.5" />}
                  Open in Outlook
                </UiButton>

                {!confirmSend ? (
                  <UiButton tone="primary" size="md" onClick={() => setConfirmSend(true)} disabled={!!sending}>
                    <Send className="w-3.5 h-3.5" /> Send now
                  </UiButton>
                ) : (
                  <span className="flex items-center gap-2 pl-3 pr-1 h-8 rounded-panel bg-err-soft border border-transparent">
                    <span className="text-xs text-err font-semibold">
                      Send to {draft.recipients.map(r => r.email).join(', ')}?
                    </span>
                    <UiButton tone="danger" size="xs" onClick={() => send(false)} disabled={!!sending}>
                      {sending === 'send' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                      Yes, send
                    </UiButton>
                    <button onClick={() => setConfirmSend(false)}
                      className="h-6 px-2 rounded-panel text-xs text-fg-3 hover:text-fg transition-colors">
                      Cancel
                    </button>
                  </span>
                )}
              </div>
            </div>
          </Card>

          {/* Footer actions */}
          <div className="flex items-center justify-between gap-2 pb-2">
            <UiButton tone="quiet-danger" size="md" onClick={remove}>
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </UiButton>
            <div className="flex items-center gap-2">
              {draft.entryId && (
                <UiButton tone="secondary" size="md" onClick={() => api.outlookOpenInOutlook(draft.entryId).catch(() => {})}>
                  <Mail className="w-3.5 h-3.5" /> Open email
                </UiButton>
              )}
              <button onClick={() => save({ status: draft.status === 'done' ? 'open' : 'done' })}
                className="h-8 px-3 rounded-panel text-xs font-semibold bg-ok-soft text-ok hover:opacity-80 transition-opacity flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" /> {draft.status === 'done' ? 'Reopen' : 'Mark done'}
              </button>
              <UiButton tone="primary" size="md" onClick={() => save()} disabled={saving}>
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Save
              </UiButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── One card on the board ───────────────────────────────────────────────────
// Draggable between columns: dropping it on another bucket is the fastest way to
// correct the AI's verdict, which is the edit the user makes most often.
function TodoCard({
  item, onOpen, onDone, onDragStart, onDragEnd, dragging,
}: {
  item: TodoItem;
  onOpen: () => void;
  onDone: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  dragging: boolean;
}) {
  const overdue = isOverdue(item);
  return (
    <div onClick={onOpen}
      draggable
      onDragStart={e => {
        e.dataTransfer.setData('text/plain', String(item.id));
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={cn(
        'group cursor-pointer rounded-panel border border-line bg-surface p-3 transition-colors hover:border-line-3 active:cursor-grabbing',
        item.status === 'done' && 'opacity-55',
        dragging && 'opacity-40 ring-1 ring-accent-line',
      )}>
      <div className="flex items-start gap-2">
        <GripVertical className="w-3 h-3 mt-0.5 shrink-0 text-fg-4 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab" />
        <p className={cn('flex-1 text-md font-medium text-fg leading-snug',
          item.status === 'done' && 'line-through')}>
          {item.title}
        </p>
        <UiIconButton icon={CheckCircle2} label={item.status === 'done' ? 'Reopen' : 'Mark done'} className="shrink-0 opacity-0 group-hover:opacity-100" onClick={e => { e.stopPropagation(); onDone(); }} />
      </div>

      {item.action && <p className="text-xs text-fg-3 mt-1.5 leading-relaxed line-clamp-2">{item.action}</p>}

      <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
        {item.priority === 'high' && <Pill tone="err">High</Pill>}
        <span className={cn('inline-flex items-center gap-1 mono text-2xs',
          overdue ? 'text-err' : 'text-fg-3')}>
          <CalendarDays className="w-3 h-3" /> {fmtDue(item.due)}
        </span>
        {!!item.attachments.length && (
          <span className="inline-flex items-center gap-1 text-2xs text-fg-4">
            <Paperclip className="w-3 h-3" /> {item.attachments.length}
          </span>
        )}
        {item.status === 'waiting' && <Pill tone="brand">Waiting</Pill>}
        {!!item.recipients.length && (
          <span className="inline-flex items-center gap-1 text-2xs text-fg-4 truncate max-w-36"
            title={item.recipients.map(r => r.email).join(', ')}>
            <ChevronRight className="w-3 h-3" /> {item.recipients[0].name || item.recipients[0].email}
            {item.recipients.length > 1 && ` +${item.recipients.length - 1}`}
          </span>
        )}
      </div>

      {item.sender && (
        <p className="text-2xs text-fg-4 mt-2 truncate border-t border-line pt-2">
          {item.sender} · waiting {waitingDays(item.received)}d
        </p>
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────
export function TodoPage({ toast, onOpenCount }: { toast: ToastFn; onOpenCount?: (n: number) => void }) {
  const [items, setItems]     = useState<TodoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus]   = useState<TodoScanStatus | null>(null);
  const [lastScanAt, setLastScanAt] = useState<string | null>(null);
  const [mailbox, setMailbox] = useState('');
  const [days, setDays]       = useState(30);
  const [view, setView]       = useState<'open' | 'done' | 'all'>('open');
  const [filter, setFilter]   = useState('');
  const [openItem, setOpenItem] = useState<TodoItem | null>(null);
  // Drag state: which card is in flight, and which column it is hovering over.
  const [dragId, setDragId]         = useState<number | null>(null);
  const [dragOver, setDragOver]     = useState<TodoBucket | null>(null);

  const [options, setOptions]     = useState<TodoRecipientOption[]>([]);
  const [optLoading, setOptLoading]   = useState(true);
  const [optRefreshing, setOptRefreshing] = useState(false);

  const pollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.todoList('all');
      setItems(r.items);
      setLastScanAt(r.lastScanAt);
      setMailbox(r.mailbox);
    } catch (e: any) { toast('err', failed('load the To-Do board', e)); }
    setLoading(false);
  }, [toast]);

  const loadOptions = useCallback(async () => {
    try {
      const r = await api.todoRecipients();
      setOptions(r.recipients);
    } catch { /* picker still works with a typed address */ }
    setOptLoading(false);
  }, []);

  useEffect(() => { load(); loadOptions(); }, [load, loadOptions]);

  const poll = useCallback(async () => {
    try {
      const s = await api.todoScanStatus();
      setStatus(s);
      if (!s.running) {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        if (s.phase === 'done')  { await load(); toast('ok', s.message || 'Triage finished — the board is up to date'); }
        if (s.phase === 'error') toast('err', failed('finish the mailbox triage', s.error));
      }
    } catch { /* transient — keep polling */ }
  }, [load, toast]);

  useEffect(() => {
    // Resume polling if a scan was already running when the tab opened.
    api.todoScanStatus().then(s => {
      setStatus(s);
      if (s.running && !pollRef.current) pollRef.current = window.setInterval(poll, 2000);
    }).catch(() => {});
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [poll]);

  async function runScan() {
    try {
      const s = await api.todoScan(days);
      setStatus(s);
      if ((s as any).error) { toast('err', failed('start the mailbox triage', (s as any).error)); return; }
      toast('info', `Triaging the last ${days} days of the shared mailbox — this takes a few minutes`);
      if (!pollRef.current) pollRef.current = window.setInterval(poll, 2000);
    } catch (e: any) { toast('err', failed('start the mailbox triage', e)); }
  }

  async function refreshOptions() {
    setOptRefreshing(true);
    try {
      const r = await api.todoRefreshRecipients(365);
      if (!r.ok) { toast('err', failed('refresh the recipient list', r.error)); return; }
      await loadOptions();
      toast('ok', `Recipient list refreshed — ${plural(r.count, 'person', 'people')} from the last year of mail`);
    } catch (e: any) { toast('err', failed('refresh the recipient list', e)); }
    finally { setOptRefreshing(false); }
  }

  const upsert = (t: TodoItem) => {
    setItems(prev => prev.some(p => p.id === t.id) ? prev.map(p => p.id === t.id ? t : p) : [t, ...prev]);
    setOpenItem(prev => prev && prev.id === t.id ? t : prev);
  };

  async function toggleDone(t: TodoItem) {
    try {
      const r = await api.todoSave({ id: t.id, status: t.status === 'done' ? 'open' : 'done' as TodoStatus });
      if (r.item) upsert(r.item);
    } catch (e: any) { toast('err', failed(t.status === 'done' ? 'reopen the item' : 'tick the item off', e)); }
  }

  // Dropped on another column → re-bucket it. Optimistic, because the card has
  // to land where it was dropped; a failed save puts it back where it came from.
  async function moveBucket(id: number, bucket: TodoBucket) {
    const prev = items.find(t => t.id === id);
    if (!prev || prev.bucket === bucket) return;
    setItems(cur => cur.map(t => t.id === id ? { ...t, bucket } : t));
    try {
      const r = await api.todoSave({ id, bucket });
      if (r.item) upsert(r.item);
    } catch (e: any) {
      setItems(cur => cur.map(t => t.id === id ? prev : t));
      toast('err', failed(`move the card to ${bucket}`, e));
    }
  }

  async function addManual() {
    try {
      const r = await api.todoSave({ title: 'New to-do', bucket: 'direct', due: today(), source: 'manual' });
      if (r.item) { upsert(r.item); setOpenItem(r.item); }
    } catch (e: any) { toast('err', failed('add a new To-Do item', e)); }
  }

  const shown = useMemo(() => {
    const term = filter.trim().toLowerCase();
    return items
      .filter(t => view === 'all' ? true : view === 'open' ? t.status !== 'done' : t.status === 'done')
      .filter(t => !term
        || t.title.toLowerCase().includes(term)
        || t.subject.toLowerCase().includes(term)
        || t.sender.toLowerCase().includes(term)
        || t.action.toLowerCase().includes(term));
  }, [items, view, filter]);

  const openItems = items.filter(t => t.status !== 'done');
  const counts = {
    open:    openItems.length,
    overdue: openItems.filter(isOverdue).length,
    waiting: items.filter(t => t.status === 'waiting').length,
    done:    items.filter(t => t.status === 'done').length,
  };

  // The sidebar badge shows what is still owed, so keep it in step with the board.
  useEffect(() => { onOpenCount?.(counts.open); }, [counts.open, onOpenCount]);

  const running = !!status?.running;
  // Both endpoints carry it; whichever answered most recently wins.
  const scannedAt = status?.lastScanAt || lastScanAt;

  return (
    <div className="flex flex-col gap-6">
      {/* ── Scan ─────────────────────────────────────────────────────────── */}
      <Section
        title="Triage the shared mailbox"
        description={`Every unanswered thread in ${mailbox || 'the quote factory box'} — sorted into what you can finish, what's blocked, and what belongs to someone else.`}
        actions={<>
          <Button icon={Plus} onClick={addManual}>New</Button>
          <Select value={String(days)} onChange={v => v && setDays(Number(v))} disabled={running}
            w="calc(var(--sp-16) * 2)"
            data={[7, 14, 30, 60, 90].map(d => ({ value: String(d), label: `Last ${d} days` }))} />
          <Button tone="primary" icon={Play} onClick={runScan} loading={running}>
            {running ? 'Scanning…' : 'Full scan'}
          </Button>
        </>}>
        <div className="flex flex-col gap-4">
          {running && (
            <div className="flex items-center gap-2 text-sm text-fg-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-accent-text" />
              <span>{status?.message || 'Working…'}</span>
              {!!status?.threads && (
                <span className="mono text-xs text-fg-3">· {status.threads} found · {status.triaged} triaged</span>
              )}
            </div>
          )}
          {!running && status?.phase === 'error' && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-control bg-err-soft border border-err-line">
              <AlertCircle className="w-4 h-4 text-err shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm text-err">{status.error}</p>
                {status.startedAt && <p className="text-xs text-fg-3 mt-0.5">Last attempted {relTime(status.startedAt)}</p>}
              </div>
            </div>
          )}
          {/* The last completed run, restored from the database — survives a page
              refresh and a server restart, so the panel is never blank. */}
          {!running && status?.phase === 'done' && status.message && (
            <div className="flex items-start gap-2 text-sm">
              <CheckCircle2 className="w-4 h-4 text-ok shrink-0 mt-0.5" />
              <p className="text-fg-2">
                {status.message}
                <span className="text-fg-3"> · last {status.days}-day scan of {status.mailbox || mailbox}
                  {scannedAt ? ` · ${relTime(scannedAt)}` : ''}</span>
              </p>
            </div>
          )}

          <StatRow>
            <Stat size="sm" label="Still owed" value={counts.open} icon={ListTodo} tone="accent" />
            <Stat size="sm" label="Overdue" value={counts.overdue} icon={Clock} tone={counts.overdue ? 'err' : undefined} />
            <Stat size="sm" label="Waiting on others" value={counts.waiting} icon={Send} />
            <Stat size="sm" label="Done" value={counts.done} icon={CheckCircle2} tone="ok"
              sub={scannedAt ? `Last full scan ${relTime(scannedAt)}` : 'Never scanned — run one to fill the board.'} />
          </StatRow>
        </div>
      </Section>

      {/* ── Filters ──────────────────────────────────────────────────────── */}
      <Toolbar>
        <Segmented value={view} onChange={setView}
          data={[{ value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }, { value: 'all', label: 'All' }]} />
        <Input icon={Search} value={filter} onChange={e => setFilter(e.currentTarget.value)}
          placeholder="Filter by customer, subject, sender…" className="flex-1 min-w-56 max-w-104" />
        {!!items.length && (
          <span className="text-xs text-fg-4 hidden md:inline-flex items-center gap-1">
            <GripVertical className="w-3 h-3" /> Drag a card to re-file it
          </span>
        )}
      </Toolbar>

      {/* ── Board ────────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-fg-3 py-8"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      ) : !items.length ? (
        <div className="rounded-panel border border-dashed border-line-2">
          <EmptyState icon={InboxIcon} title="Nothing on the list yet"
            description="Run a full scan to sweep every unanswered thread out of the shared mailbox, or add something by hand — or send one over from the Inbox after summarising it." />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          {BUCKETS.map(b => {
            const col     = shown.filter(t => t.bucket === b.id);
            const isOver  = dragOver === b.id;
            const dragged = dragId != null ? items.find(t => t.id === dragId) : null;
            // Only light up a column the card could actually move to.
            const canDrop = !!dragged && dragged.bucket !== b.id;
            return (
              <div key={b.id}
                onDragOver={e => {
                  if (!dragId) return;
                  e.preventDefault();                       // required to allow a drop
                  e.dataTransfer.dropEffect = 'move';
                  if (dragOver !== b.id) setDragOver(b.id);
                }}
                onDragLeave={e => {
                  // Ignore the events fired while crossing child elements.
                  if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                  setDragOver(cur => cur === b.id ? null : cur);
                }}
                onDrop={e => {
                  e.preventDefault();
                  const id = Number(e.dataTransfer.getData('text/plain'));
                  setDragOver(null); setDragId(null);
                  if (Number.isFinite(id)) moveBucket(id, b.id);
                }}
                className={cn('min-w-0 rounded-panel transition-colors',
                  isOver && canDrop && 'bg-accent-soft outline outline-1 outline-dashed outline-accent')}>
                <div className="flex items-start gap-2 pb-2 mb-3 border-b border-line">
                  <b.icon className="w-4 h-4 mt-0.5 shrink-0" style={{ color: b.color }} />
                  <div className="min-w-0 flex-1">
                    <p className="text-lg font-semibold text-fg leading-tight">{b.label}</p>
                    <p className="text-xs text-fg-3 mt-0.5 leading-snug">{b.sub}</p>
                  </div>
                  <span className="mono text-sm text-fg-3">{col.length}</span>
                </div>
                <div className="flex flex-col gap-2 min-h-14">
                  {col.map(t => (
                    <TodoCard key={t.id} item={t}
                      onOpen={() => setOpenItem(t)}
                      onDone={() => toggleDone(t)}
                      onDragStart={() => setDragId(t.id)}
                      onDragEnd={() => { setDragId(null); setDragOver(null); }}
                      dragging={dragId === t.id} />
                  ))}
                  {!col.length && (
                    <p className="text-sm text-fg-4 py-6 text-center">
                      {canDrop && isOver ? 'Drop to move it here' : 'Nothing here.'}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {openItem && (
        <TodoDetail
          item={openItem}
          onClose={() => setOpenItem(null)}
          onSaved={upsert}
          onDeleted={id => setItems(prev => prev.filter(p => p.id !== id))}
          toast={toast}
          options={options}
          optionsLoading={optLoading}
          onRefreshOptions={refreshOptions}
          refreshingOptions={optRefreshing}
        />
      )}
    </div>
  );
}
