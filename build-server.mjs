/**
 * Builds the Express server into a standalone Windows executable for the Tauri sidecar.
 * Uses Node.js SEA (Single Executable Application) — no pkg/download of Node runtime needed.
 * Output: src-tauri/binaries/server-x86_64-pc-windows-msvc.exe
 *
 * Run: node build-server.mjs
 */
import { execSync }                                      from 'child_process';
import { copyFileSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'fs';
import path                                              from 'path';
import { fileURLToPath }                                 from 'url';
import * as esbuild                                      from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR   = path.join(__dirname, 'dist-server');
const BIN_DIR   = path.join(__dirname, 'src-tauri', 'binaries');
const TRIPLE    = 'x86_64-pc-windows-gnu';
const BIN_OUT   = path.join(BIN_DIR, `server-${TRIPLE}.exe`);
const BUNDLE    = path.join(OUT_DIR, 'server.cjs');
const BLOB      = path.join(OUT_DIR, 'sea-prep.blob');

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(BIN_DIR, { recursive: true });

// ── 1. Bundle server.ts → single CJS file ────────────────────────────────────
console.log('▸  Bundling server.ts → CJS...');
await esbuild.build({
  entryPoints: [path.join(__dirname, 'server.ts')],
  bundle:      true,
  platform:    'node',
  target:      'node20',
  format:      'cjs',
  outfile:     BUNDLE,
  external:    ['vite'],
  minify:      true,            // obfuscate shipped logic (no plaintext source in the exe)
  legalComments: 'none',
  // Fix import.meta.url — CJS has __filename so reconstruct the URL from it
  banner: { js: 'const __importMetaUrl=require("url").pathToFileURL(__filename).href;' },
  define: { 'import.meta.url': '__importMetaUrl' },
  logLevel:    'warning',
});

// ── 1b. Obfuscate the bundle ──────────────────────────────────────────────────
// Minification alone leaves every string literal (URLs, prompts, SQL, route
// names) readable with `strings server.exe`. The string-array transform encodes
// them; hexadecimal identifiers + light settings keep startup cost negligible.
// (This raises the reverse-engineering bar — it cannot make the exe uncrackable.)
console.log('▸  Obfuscating bundle (javascript-obfuscator)...');
{
  const { default: JavaScriptObfuscator } = await import('javascript-obfuscator');
  const code = readFileSync(BUNDLE, 'utf8');
  const obfuscated = JavaScriptObfuscator.obfuscate(code, {
    target:                   'node',
    compact:                  true,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals:            false,
    stringArray:              true,
    stringArrayEncoding:      ['base64'],
    stringArrayThreshold:     1,
    stringArrayRotate:        true,
    stringArrayShuffle:       true,
    splitStrings:             false,
    // Heavy transforms (controlFlowFlattening, deadCodeInjection, selfDefending)
    // are off: on a ~3 MB server bundle they multiply size and slow every request.
    controlFlowFlattening:    false,
    deadCodeInjection:        false,
    selfDefending:            false,
    disableConsoleOutput:     false,
  }).getObfuscatedCode();
  writeFileSync(BUNDLE, obfuscated);
  console.log(`▸  Obfuscated: ${(obfuscated.length / 1024 / 1024).toFixed(1)} MB`);
}

// ── 2. Copy sql.js WASM next to the bundle (for locateFile in dev) ────────────
const wasmSrc  = path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const wasmDest = path.join(OUT_DIR, 'sql-wasm.wasm');
if (existsSync(wasmSrc)) {
  copyFileSync(wasmSrc, wasmDest);
  console.log('▸  Copied sql-wasm.wasm →', wasmDest);
} else {
  console.warn('⚠  sql-wasm.wasm not found in node_modules/sql.js/dist/');
}

// ── 3. Create SEA config ──────────────────────────────────────────────────────
const seaConfig = {
  main:                          BUNDLE,
  output:                        BLOB,
  disableExperimentalSEAWarning: true,
  useSnapshot:                   false,
};
writeFileSync(path.join(OUT_DIR, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));

// ── 4. Generate SEA blob ──────────────────────────────────────────────────────
console.log('▸  Generating SEA blob...');
execSync(
  `node --experimental-sea-config ${path.join(OUT_DIR, 'sea-config.json')}`,
  { stdio: 'inherit' }
);

// ── 5. Copy node.exe as the base binary ───────────────────────────────────────
console.log('▸  Copying node.exe as base binary...');
const nodePath = process.execPath;   // the currently-running node.exe
copyFileSync(nodePath, BIN_OUT);

// ── 6. Inject SEA blob into the binary via postject ───────────────────────────
console.log('▸  Injecting SEA blob with postject...');
execSync(
  [
    'npx postject',
    `"${BIN_OUT}"`,
    'NODE_SEA_BLOB',
    `"${BLOB}"`,
    '--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    '--overwrite',
  ].join(' '),
  { stdio: 'inherit', cwd: __dirname },
);

console.log(`\n✓  Sidecar built  →  ${BIN_OUT}`);
console.log(`   Size: ${(readFileSync(BIN_OUT).length / 1024 / 1024).toFixed(1)} MB\n`);
