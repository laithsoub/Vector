// ─── Inbox → EL Pricer hand-off ─────────────────────────────────────────────
// "Open in EL Pricer" used to call openExternal('/schematics'), which does not
// work: the app has no URL routing — the tab is React state restored from
// localStorage — so the popup opened whatever tab was last used, usually the
// Inbox again. It now switches the app's own tab instead, and this module is
// what the email carries across with it.
//
// The payload is deliberately plain FILES rather than Outlook attachment refs.
// The Inbox already has a URL that serves an attachment's bytes, so fetching
// them here means the EL Pricer needs no Outlook code path at all: it receives
// the same File objects it would have got from a drop, and its existing pricing
// run handles several at once. One shape, one code path, no second endpoint.
//
// In memory on purpose, never localStorage: a File cannot be serialised, and a
// hand-off is only meaningful inside the session that made it. Stale state after
// a reload would be worse than none.

export interface PricerHandoff {
  /** Material lines detected in the email body — prefills the pricer's textarea. */
  text: string;
  /** Attachments already downloaded from Outlook, ready to price. */
  files: File[];
  /** Where it came from, shown so the pricer can say what it is working on. */
  source?: string;
  /**
   * The email it came out of. The EL Pricer uses this to find the REST of the
   * enquiry — an enquiry arrives in chunks ('Bristol Hippodrome 2 of 2', '3 of
   * 3') and choosing among them needs the room the inline panel does not have.
   *
   * `storeId` is not decoration: the quotes live in the SHARED UKQuoteFactoryEL
   * mailbox, and looking the siblings up in the default store finds nothing at
   * all — which is exactly what happened the first time this was pointed at the
   * real Bristol email.
   */
  origin?: { entryId: string; subject: string; storeId: string };
}

let pending: PricerHandoff | null = null;
const listeners = new Set<(h: PricerHandoff) => void>();

/** Hand an email's list and attachments to the EL Pricer tab. */
export function sendToPricer(h: PricerHandoff) {
  // If the pricer is already mounted (App keeps visited tabs alive) it takes the
  // hand-off now and nothing is left queued — parking a copy as well would make
  // the same email re-apply itself the next time the tab remounts.
  if (listeners.size) {
    for (const fn of listeners) fn(h);
    pending = null;
    return;
  }
  pending = h;
}

/**
 * Claim a waiting hand-off, once. Returns null when there is nothing pending,
 * so a re-render or a revisit to the tab cannot re-apply the same email.
 */
export function takePricerHandoff(): PricerHandoff | null {
  const h = pending;
  pending = null;
  return h;
}

/** Listen for hand-offs arriving while the pricer is already open. */
export function onPricerHandoff(fn: (h: PricerHandoff) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
