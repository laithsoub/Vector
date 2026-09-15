// ─── LoadStar inverter modules — the ship-as-is systems ──────────────────────
// Standalone inverter modules quoted as a part code and a price, not configured:
// there is no cabinet build, no battery sizing and no Tech Brief behind them,
// which is why they are their own view rather than entries in the sizer's
// system list.
//
// HAND-MAINTAINED. Unlike src/lib/cbuData.ts — which cbu_data_gen.py regenerates
// from the sizing calculator — nothing generates this file. When the price list
// is reissued these figures have to be retyped and the `priced` date moved.
//
// The prices are **Nett Trade**, which is NOT the basis the sizer works in: the
// LoadStar-PS BoM in cbuData.ts is Sell Out at a 1.0 multiplier. Mixing the two
// on one quote line is the mistake this comment exists to prevent, and the tab
// says so on screen for the same reason.

export interface InverterModule {
  code:  string;
  desc:  string;
  price: number;                 // £, Nett Trade
  kva:   number;
  phase: '1PH' | '3PH';
  role:  'standalone' | 'master' | 'slave';
}

// The date these figures were taken from the price list. Shown in the tab so a
// stale table is visible rather than silently trusted.
export const MODULES_PRICED = '2026-09-10';

export const INVERTER_MODULES: InverterModule[] = [
  { code: '7IN110125KVA',    desc: '1.25KVA Inverter Module (Loadstar)',              price: 1769.23, kva: 1.25, phase: '1PH', role: 'standalone' },
  { code: '7IN110125KVA-3P', desc: '1.25KVA Inverter Module 3 Phase (Loadstar)',      price: 1823.03, kva: 1.25, phase: '3PH', role: 'standalone' },
  { code: '7IN1102K5M',      desc: '2.5KVA Master Inverter Module (Loadstar)',        price: 2055.70, kva: 2.5,  phase: '1PH', role: 'master' },
  { code: '7IN1102K5S',      desc: '2.5KVA Slave Inverter Module (Loadstar)',         price: 1858.90, kva: 2.5,  phase: '1PH', role: 'slave' },
  { code: '7IN1104KM',       desc: '4KVA Master Inverter Module (Loadstar)',          price: 2510.82, kva: 4,    phase: '1PH', role: 'master' },
  { code: '7IN1104KS',       desc: '4KVA Slave Inverter Module (Loadstar)',           price: 2282.08, kva: 4,    phase: '1PH', role: 'slave' },
  { code: '7IN1102K5M-3P',   desc: '2.5KVA Master Inverter Module 3 Phase (Loadstar)', price: 2109.63, kva: 2.5, phase: '3PH', role: 'master' },
  { code: '7IN1104KM-3P',    desc: '4KVA Master Inverter Module 3 Phase (Loadstar)',   price: 2530.15, kva: 4,   phase: '3PH', role: 'master' },
];
