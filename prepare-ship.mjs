/**
 * Stages a sanitized copy of automation/ into ship-automation/ for the Tauri
 * installer. The bundle must NEVER contain:
 *   - secrets (Gemini/Azure keys, SharePoint cookies, Graph/Copilot tokens)
 *   - personal config (paths, machine-specific state, logs)
 *   - scripts/data for features that are gated off in the ship build
 *     (EL pricer, PMO, CBU, Commission, Docs — and their price lists/templates)
 *
 * Run automatically by `npm run build:tauri`. Output dir is gitignored.
 */
import { cpSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'automation');
const DST = path.join(__dirname, 'ship-automation');

// Exact file/dir names excluded anywhere in the tree.
const EXCLUDE_NAMES = new Set([
  // secrets / tokens / session state
  '.cookies.enc', '.copilot_cookies', '.graph_token', '.copilot_token',
  'graph_token_cache.json', 'overlay_state.json',
  // replaced with a sanitized template below
  'config.json',
  // gated-feature scripts (also blocked server-side in sidecar mode)
  'schematic_reader.py', 'pmo_raise.py', 'cbu_export.py', 'parse_cbu.py',
  'commission_export.py',
  // LSD pricing: the rule, the margin floors and the prior-year logic are
  // internal pricing policy, and the tab is locked in the ship anyway
  'lsd_pricing.py', 'cpq_fetch.py', 'lsd_register.py',
  // internal maintenance tooling — audits/rewrites the shared D&Q Store, must
  // never reach an installed copy on someone else's machine
  'dq_backfill_audit.py',
  // reads the internal LoadStar-PS calculator and emits its price table
  'cbu_data_gen.py',
  // gated-feature data (price lists, calculators, T&C documents)
  'el_pricelist.xlsx', 'cbu_calculator.xlsm', 'docs',
  // caches
  '__pycache__',
]);
const EXCLUDE_EXT = new Set(['.log', '.pyc', '.pyo', '.bak']);
// Name PATTERNS excluded anywhere in the tree. An exact-name list is not enough for
// audit output: every run can name its CSV differently (dq_audit.csv, dq_audit_3m.csv,
// dq_audit_2026-07-28.csv) and each one carries real customer quote references.
const EXCLUDE_PATTERNS = [/^dq_audit.*\.csv$/i];

function sensitive(name) {
  return EXCLUDE_NAMES.has(name)
      || EXCLUDE_PATTERNS.some(re => re.test(name))
      || EXCLUDE_EXT.has(path.extname(name).toLowerCase());
}

function excluded(src) {
  return sensitive(path.basename(src));
}

rmSync(DST, { recursive: true, force: true });
cpSync(SRC, DST, { recursive: true, filter: (src) => !excluded(src) });

// Sanitized config template — no keys, no personal paths. `base` is omitted on
// purpose: loadPyCfg() then falls back to its per-user default (DATA_DIR/data).
writeFileSync(path.join(DST, 'config.json'), JSON.stringify({
  initials:          '',
  inside_sales:      '',
  sp_site:           'https://eaton.sharepoint.com/sites/ELTechsupport',
  sp_list:           'https://eaton.sharepoint.com/sites/QuotationFactoryEMEA',
  dq_store:          'Shared Documents/D&Q Store',
  azure_di_endpoint: '',
  azure_di_key:      '',
  gemini_key:        '',
}, null, 2));

// Hard fail if anything secret-shaped slipped through.
const leaks = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    // config.json is exempt here: the sanitized template written above is allowed,
    // and the dedicated check below verifies it carries no key.
    if (/\.(enc|log|pyc)$/i.test(name) || (sensitive(name) && name !== 'config.json') || name === '.session_key') leaks.push(p);
    if (name === 'config.json') {
      const c = readFileSync(p, 'utf8');
      if (/AIza|"gemini_key":\s*"[^"]/.test(c) && !/"gemini_key":\s*""/.test(c)) leaks.push(p + ' (gemini key!)');
    }
  }
}
walk(DST);
if (leaks.length) {
  console.error('✗ prepare-ship: sensitive files in ship-automation/:\n  ' + leaks.join('\n  '));
  process.exit(1);
}
console.log('✓ ship-automation/ staged (sanitized) →', DST);
