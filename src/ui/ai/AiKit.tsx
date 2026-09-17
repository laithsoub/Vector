// ─── Ask Vector kit ──────────────────────────────────────────────────────────
// One conversation design for every AI surface: the Ask Vector page, the Inbox
// Vector AI panel, Ask Fenton and EL Info. Pages keep their own data flow and
// hand these components what to show.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Check, Copy, FileText, Image as ImageIcon, Sparkles, Square } from 'lucide-react';

import c from './ai.module.css';
import { IconButton } from '../Button';
import { Shortcut } from '../shortcuts';

const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ');

/** The Vector mark: wherever it appears, the AI is speaking. */
export function AiMark({ size = 'sm', className }: { size?: 'sm' | 'md' | 'lg'; className?: string }) {
  return (
    <span aria-hidden className={cx(c.mark, size === 'sm' ? c.markSm : size === 'md' ? c.markMd : c.markLg, className)}>
      <Sparkles strokeWidth={2} />
    </span>
  );
}

/** Working state: a moving hairline and what Vector is doing right now. */
export function AiThinking({ label = 'Thinking…' }: { label?: React.ReactNode }) {
  return (
    <div className={c.aiMsg} role="status" aria-live="polite">
      <AiMark />
      <div className={c.thinking} style={{ minHeight: 'var(--h-xs)' }}>
        <span className={c.shimmer} />
        <span>{label}</span>
      </div>
    </div>
  );
}

/** Cycles through step labels while a request runs. */
export function useThinkingSteps(steps: string[], active: boolean, everyMs = 1500) {
  const [i, setI] = useState(0);
  useEffect(() => {
    setI(0);
    if (!active) return;
    const t = setInterval(() => setI(p => Math.min(p + 1, steps.length - 1)), everyMs);
    return () => clearInterval(t);
  }, [active, steps, everyMs]);
  return steps[i] ?? steps[0];
}

export function CopyAction({ text, onCopied }: { text: string; onCopied?: () => void }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton size="xs" icon={done ? Check : Copy} label={done ? 'Copied' : 'Copy'}
      onClick={() => navigator.clipboard.writeText(text).then(() => {
        setDone(true); onCopied?.();
        setTimeout(() => setDone(false), 1500);
      })} />
  );
}

/** An answer: reads like a document, not a chat bubble. */
export function AiMessage({ children, name = 'Vector', time, actions, footer, badge }: {
  children: React.ReactNode;
  name?: string;
  time?: number | string;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  badge?: React.ReactNode;
}) {
  return (
    <article className={c.aiMsg}>
      <AiMark />
      <header className={c.aiHead}>
        <span className={c.aiName}>{name}</span>
        {badge}
        {time != null && <time className={c.aiTime}>{fmtTime(time)}</time>}
      </header>
      <div className={cx(c.aiBody, c.prose)}>{children}</div>
      {footer && <div className={c.aiFooter}>{footer}</div>}
      {actions && <div className={c.aiActions}>{actions}</div>}
    </article>
  );
}

export function UserMessage({ text, time, badge }: { text: React.ReactNode; time?: number | string; badge?: React.ReactNode }) {
  return (
    <div className={c.userMsg}>
      {badge}
      <div className={c.userBubble}>{text}</div>
      {time != null && <time className={c.aiTime}>{fmtTime(time)}</time>}
    </div>
  );
}

export function AiSuggestions({ items, onPick, disabled }: {
  items: string[]; onPick: (s: string) => void; disabled?: boolean;
}) {
  if (!items.length) return null;
  return (
    <div className={c.chips}>
      {items.map((s, i) => (
        <button key={i} type="button" className={c.chip} disabled={disabled} onClick={() => onPick(s)}>
          <Sparkles /> {s}
        </button>
      ))}
    </div>
  );
}

/** Scrollable conversation column that keeps itself pinned to the newest message. */
export function AiThread({ children, deps, className, width = 'var(--measure-chat)' }: {
  children: React.ReactNode;
  deps: unknown[];
  className?: string;
  width?: string;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={cx('flex flex-col gap-6 w-full mx-auto', className)} style={{ maxWidth: width }}>
      {children}
      <div ref={end} />
    </div>
  );
}

export interface AiComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  onStop?: () => void;
  /** Tools on the left of the bar: attach, quick actions, mode switches. */
  tools?: React.ReactNode;
  hint?: React.ReactNode;
  size?: 'md' | 'sm';
  maxRows?: number;
  autoFocus?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  onPaste?: React.ClipboardEventHandler<HTMLTextAreaElement>;
  className?: string;
}

/** The one composer: grows with the text, Enter sends, Shift+Enter breaks a line. */
export function AiComposer({
  value, onChange, onSubmit, placeholder = 'Ask Vector…', disabled, loading, onStop,
  tools, hint, size = 'md', maxRows = 8, autoFocus, inputRef, onPaste, className,
}: AiComposerProps) {
  const local = useRef<HTMLTextAreaElement>(null);
  const ref = (inputRef ?? local) as React.RefObject<HTMLTextAreaElement>;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = `${Math.min(el.scrollHeight, line * maxRows + 16)}px`;
  }, [value, maxRows, ref]);

  const canSend = !!value.trim() && !disabled && !loading;
  return (
    <div className={cx(c.composer, size === 'sm' && c.composerSm, className)} data-disabled={disabled || undefined}>
      <textarea
        ref={ref}
        rows={1}
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder={placeholder}
        className={c.composerInput}
        onPaste={onPaste}
        onChange={e => onChange(e.currentTarget.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (canSend) onSubmit();
          }
        }}
      />
      <div className={c.composerBar}>
        <div className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto">{tools}</div>
        {size === 'md' && (
          <span className={c.composerHint}>
            {hint ?? <><Shortcut keys="Enter" /> send · <Shortcut keys="shift+Enter" /> new line</>}
          </span>
        )}
        {loading && onStop ? (
          <button type="button" className={c.send} onClick={onStop} aria-label="Stop">
            <Square fill="currentColor" />
          </button>
        ) : (
          <button type="button" className={c.send} onClick={onSubmit} disabled={!canSend} aria-label="Send">
            <ArrowUp strokeWidth={2.25} />
          </button>
        )}
      </div>
    </div>
  );
}

export interface AiPrompt {
  icon: React.ComponentType<{ strokeWidth?: number }>;
  label: string;
  sub?: string;
  onRun: () => void;
}

export function AiPromptGrid({ prompts, disabled }: { prompts: AiPrompt[]; disabled?: boolean }) {
  return (
    <div className={c.prompts}>
      {prompts.map(p => (
        <button key={p.label} type="button" className={c.prompt} disabled={disabled} onClick={p.onRun}>
          <p.icon strokeWidth={1.75} />
          <span className={c.promptTitle}>{p.label}</span>
          {p.sub && <span className={c.promptSub}>{p.sub}</span>}
        </button>
      ))}
    </div>
  );
}

export function AiWelcome({ title, sub, children }: { title: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className={c.welcome}>
      <AiMark size="lg" />
      <h2 className={c.welcomeTitle}>{title}</h2>
      {sub && <p className={c.welcomeSub}>{sub}</p>}
      {children && <div className="w-full mt-6">{children}</div>}
    </div>
  );
}

/** Header strip for AI side panels (Inbox, Fenton, EL Info). */
export function AiPanelHeader({ title, sub, actions }: { title: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className={c.panelHead}>
      <AiMark />
      <div className="min-w-0 flex-1 leading-tight">
        <div className={c.panelTitle}>{title}</div>
        {sub && <div className={c.panelSub}>{sub}</div>}
      </div>
      {actions}
    </div>
  );
}

/** Markdown styling for answer text rendered elsewhere. */
export const aiProse = c.prose;

function fmtTime(t: number | string) {
  const d = typeof t === 'number' ? new Date(t) : new Date(t);
  if (Number.isNaN(+d)) return String(t);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export interface AiSideMessage { role: 'user' | 'ai'; text: string }

/** A compact Vector conversation for side panels (Ask Fenton, EL Info, Inbox). */
export function AiSidePanel({
  title, sub, intro, messages, renderAnswer, loading, input, onInput, onSend,
  placeholder, maxHeight = '72vh', thinkingLabel = 'Reading the sources…', actions,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  intro?: React.ReactNode;
  messages: AiSideMessage[];
  renderAnswer?: (text: string) => React.ReactNode;
  loading?: boolean;
  input: string;
  onInput: (v: string) => void;
  onSend: () => void;
  placeholder?: string;
  maxHeight?: string;
  thinkingLabel?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [messages.length, loading]);
  return (
    <section className="flex flex-col rounded-panel border border-line bg-surface overflow-hidden" style={{ maxHeight }}>
      <AiPanelHeader title={title} sub={sub} actions={actions} />
      <div className="flex-1 min-h-40 overflow-y-auto px-3 py-4 flex flex-col gap-5">
        {messages.length === 0 && intro && (
          <p className="text-sm text-fg-3 leading-relaxed">{intro}</p>
        )}
        {messages.map((m, i) => m.role === 'user'
          ? <UserMessage key={i} text={m.text} />
          : <AiMessage key={i} actions={<CopyAction text={m.text} />}>{renderAnswer ? renderAnswer(m.text) : m.text}</AiMessage>)}
        {loading && <AiThinking label={thinkingLabel} />}
        <div ref={end} />
      </div>
      <div className="p-2 border-t border-line">
        <AiComposer size="sm" value={input} onChange={onInput} onSubmit={onSend} loading={loading}
          placeholder={placeholder} maxRows={5} />
      </div>
    </section>
  );
}

/** A file the AI may read: off by default, ticked when it should look at it. */
export function AiFileChip({ name, on, kind = 'file', onToggle, disabled }: {
  name: string;
  on: boolean;
  kind?: 'image' | 'file';
  onToggle: () => void;
  disabled?: boolean;
}) {
  const Icon = on ? Check : kind === 'image' ? ImageIcon : FileText;
  const tip = on ? `${name} — Vector reads this, click to exclude` : `Include ${name} — Vector will read it`;
  return (
    <button type="button" className={c.chip} data-on={on || undefined} disabled={disabled}
      aria-pressed={on} aria-label={tip} title={tip} onClick={onToggle}>
      <Icon /> <span className="truncate max-w-44">{name}</span>
    </button>
  );
}
