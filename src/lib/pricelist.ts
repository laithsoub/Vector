// ─── EL price list issue ─────────────────────────────────────────────────────
// Which issue of the EL global price list is on disk, and whether it is still
// the one this desk acknowledged.
//
// Every price the app quotes traces to one specific issue. That issue used to
// be a string typed into five places in Schematics.tsx — two of which end up in
// text sent to a customer — so replacing el_pricelist.xlsx left quotes citing an
// issue they were not priced against. The workbook states its own identity in
// its header row; this reads that, and nothing here hardcodes a date.
import { useEffect, useState } from 'react';
import { api, type PriceListVersion } from './api';

// One in-flight request and one cached answer for the whole app: several panels
// want this on mount and it costs a Python spawn that hashes an 800 KB file.
let cached: PriceListVersion | null = null;
let inflight: Promise<PriceListVersion> | null = null;
const listeners = new Set<(v: PriceListVersion) => void>();

export function getPricelistVersion(force = false): Promise<PriceListVersion> {
  if (!force && cached) return Promise.resolve(cached);
  if (!force && inflight) return inflight;
  inflight = api.pricelistVersion(force)
    .then(v => { cached = v; listeners.forEach(fn => fn(v)); return v; })
    .finally(() => { inflight = null; });
  return inflight;
}

export function usePricelistVersion(): PriceListVersion | null {
  const [v, setV] = useState<PriceListVersion | null>(cached);
  useEffect(() => {
    listeners.add(setV);
    void getPricelistVersion();
    return () => { listeners.delete(setV); };
  }, []);
  return v;
}

// Marks the sheet on disk as the one being worked to, clearing the change flag.
export async function acknowledgePricelist(): Promise<PriceListVersion> {
  await api.pricelistAcknowledge();
  return getPricelistVersion(true);
}

// ── Naming the issue in text ────────────────────────────────────────────────
// Both of these are used in customer-facing output, so they must never invent a
// date: with no version loaded they name the list without claiming an issue.

/** "Eaton EL Global Price List — July 2026" (or without the issue if unknown). */
export function pricelistName(v: PriceListVersion | null): string {
  const base = 'Eaton EL Global Price List';
  return v?.label ? `${base} — ${v.label.replace(/\s*price\s*list\s*$/i, '').trim()}` : base;
}

/** The line that goes at the foot of a quote. */
export function pricelistFooter(v: PriceListVersion | null): string {
  const from = v?.validFrom ? ` (valid from ${v.validFrom})` : '';
  return `Prices shown are Net Trade Price (NTP) from ${pricelistName(v)}${from}.`;
}
