// ─── Notifications ───────────────────────────────────────────────────────────
//   notify.success('Saved')              notify.error('Upload failed', err)
//   notify.info('3 new quotes')          notify.warn('Price book is stale')
//   await notify.promise(send(), { loading: 'Sending…', success: 'Sent', error: e => failed('send', e) })
//
// `notify(type, msg)` stays callable for the App-level ToastFn, whose tones are
// the old 'ok' | 'err' | 'warn' | 'info'.
import React from 'react';
import { notifications } from '@mantine/notifications';
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react';

type Tone = 'ok' | 'err' | 'warn' | 'info';
const TONE: Record<Tone, { color: string; icon: React.ReactNode; autoClose: number }> = {
  ok:   { color: 'var(--ok)',     icon: <CheckCircle2 />,  autoClose: 4000 },
  err:  { color: 'var(--err)',    icon: <AlertCircle />,   autoClose: 8000 },
  warn: { color: 'var(--warn)',   icon: <AlertTriangle />, autoClose: 6000 },
  info: { color: 'var(--accent)', icon: <Info />,          autoClose: 5000 },
};
export type ToastType = Tone;

type Content = React.ReactNode;
interface Opts { title?: Content; id?: string; autoClose?: number | false }

function show(tone: Tone, message: Content, opts: Opts = {}) {
  const t = TONE[tone] ?? TONE.info;
  return notifications.show({
    id: opts.id,
    title: opts.title,
    message,
    color: t.color,
    icon: t.icon,
    autoClose: opts.autoClose ?? t.autoClose,
  });
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

let seq = 0;

interface PromiseMsgs<T> {
  loading: Content;
  success: Content | ((v: T) => Content);
  error:   Content | ((e: unknown) => Content);
  title?:  Content;
}

/** Spinner toast that resolves in place — uploads, email sends, long jobs.
 *  Returns the promise's own value, and rethrows so callers keep control flow. */
async function promise<T>(work: Promise<T> | (() => Promise<T>), msgs: PromiseMsgs<T>): Promise<T> {
  const id = `vec-${++seq}`;
  notifications.show({ id, title: msgs.title, message: msgs.loading, loading: true, autoClose: false, withCloseButton: false });
  const settle = (tone: Tone, message: Content) => notifications.update({
    id, title: msgs.title, message, loading: false, withCloseButton: true,
    color: TONE[tone].color, icon: TONE[tone].icon, autoClose: TONE[tone].autoClose,
  });
  try {
    const v = await (typeof work === 'function' ? work() : work);
    settle('ok', typeof msgs.success === 'function' ? (msgs.success as (v: T) => Content)(v) : msgs.success);
    return v;
  } catch (e) {
    settle('err', typeof msgs.error === 'function'
      ? (msgs.error as (e: unknown) => Content)(e)
      : msgs.error ?? errorText(e));
    throw e;
  }
}

/** Manual version of `promise` for work with several steps. */
function progress(message: Content, title?: Content) {
  const id = `vec-${++seq}`;
  notifications.show({ id, title, message, loading: true, autoClose: false, withCloseButton: false });
  const settle = (tone: Tone, m: Content) => notifications.update({
    id, title, message: m, loading: false, withCloseButton: true,
    color: TONE[tone].color, icon: TONE[tone].icon, autoClose: TONE[tone].autoClose,
  });
  return {
    step: (m: Content) => notifications.update({ id, title, message: m, loading: true, autoClose: false }),
    done: (m: Content) => settle('ok', m),
    fail: (m: Content) => settle('err', m),
    warn: (m: Content) => settle('warn', m),
  };
}

type NotifyFn = ((type: Tone, message: Content, opts?: Opts) => string) & {
  success: (message: Content, opts?: Opts) => string;
  error:   (message: Content, opts?: Opts) => string;
  warn:    (message: Content, opts?: Opts) => string;
  info:    (message: Content, opts?: Opts) => string;
  promise: typeof promise;
  progress: typeof progress;
  hide:    (id: string) => void;
  clear:   () => void;
};

export const notify: NotifyFn = Object.assign(
  (type: Tone, message: Content, opts?: Opts) => show(type, message, opts),
  {
    success: (m: Content, o?: Opts) => show('ok', m, o),
    error:   (m: Content, o?: Opts) => show('err', m, o),
    warn:    (m: Content, o?: Opts) => show('warn', m, o),
    info:    (m: Content, o?: Opts) => show('info', m, o),
    promise,
    progress,
    hide:  (id: string) => notifications.hide(id),
    clear: () => notifications.clean(),
  },
);

/** @deprecated use notify.progress */
export const notifyProgress = progress;
