// ─── Failure text for toasts ─────────────────────────────────────────────────
// Every failure toast reads "Couldn't <action> — <reason>".
//
// The action is written by the call site, because that is the only place that
// knows what the user was actually doing: axios only ever says "Network Error"
// or "Request failed with status code 500", which tells the user nothing about
// which of the twelve things on screen just broke.
//
// The reason is dug out of whatever came back — an Express { error } body, a
// Python __ERROR__ line relayed by the server, or a plain Error — and axios's
// own boilerplate is dropped rather than shown.

// Axios boilerplate: true of every failed request, so it never explains one.
const NOISE = /^(request failed with status code \d+|network error|internal server error|error|forbidden|unauthorized|not found|bad request)$/i;

function clean(s: string): string {
  return s
    .replace(/^__ERROR__:\s*/, '')     // a python marker that escaped the server
    .replace(/^Error:\s*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')            // toasts carry no full stop
    .trim();
}

/** The "why" half of a failure message. Empty when there is nothing honest to say. */
export function reason(e: any): string {
  if (!e) return '';
  if (typeof e === 'string') return NOISE.test(e.trim()) ? '' : clean(e);

  // 1. An error the server explained itself — always the most useful.
  const body = e.response?.data;
  const said = typeof body === 'string' ? body : body?.error || body?.message;
  if (typeof said === 'string' && said.trim() && !NOISE.test(said.trim())) return clean(said);

  // 2. The request never got an answer.
  if (e.code === 'ECONNABORTED' || /timeout/i.test(e.message || '')) return 'it timed out';
  if (e.request && !e.response) return 'the Vector server is not responding';

  // 3. An answer with no explanation in it — fall back to what the status means.
  const status = e.response?.status;
  if (status === 401 || status === 403) return 'this build is not allowed to do that';
  if (status === 404) return 'the server has no such endpoint (restart Vector)';
  if (status && status >= 500) return 'the server hit an internal error (see vector.log)';
  if (status) return `the server rejected it (HTTP ${status})`;

  const msg = typeof e.message === 'string' ? e.message.trim() : '';
  return msg && !NOISE.test(msg) ? clean(msg) : '';
}

/**
 * Build a failure message. `action` is an infinitive phrase naming what the
 * user was doing, e.g. failed('send the reply', e) → "Couldn't send the reply
 * — Outlook is not responding".
 */
export function failed(action: string, e?: any): string {
  const why = reason(e);
  return why ? `Couldn't ${action} — ${why}` : `Couldn't ${action}`;
}

/** Pluralise a count: plural(1,'email') → "1 email", plural(0,'email') → "0 emails". */
export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}
