/**
 * Downloads portable MinGW-w64 (winlibs build) and configures Rust GNU toolchain.
 * Uses rejectUnauthorized:false — same pattern as the rest of this project — to
 * handle the corporate SSL inspection proxy.
 *
 * Run: node install-mingw.mjs
 */
import https  from 'https';
import fs     from 'fs';
import path   from 'path';
import os     from 'os';
import { execSync } from 'child_process';

function httpsGet(url, redirects = 8) {
  return new Promise((resolve, reject) => {
    if (redirects === 0) return reject(new Error('Too many redirects'));
    const opts = new URL(url);
    https.get({ hostname: opts.hostname, path: opts.pathname + opts.search, headers: { 'User-Agent': 'vector-setup/1.0', 'Accept': 'application/vnd.github+json' }, rejectUnauthorized: false }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        res.resume();
        return httpsGet(res.headers.location, redirects - 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function download(url, dest, redirects = 8) {
  return new Promise((resolve, reject) => {
    if (redirects === 0) return reject(new Error('Too many redirects'));
    const file = fs.createWriteStream(dest);
    https.get(url, { rejectUnauthorized: false }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        file.close(); fs.unlinkSync(dest);
        return download(res.headers.location, dest, redirects - 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      let bytes = 0;
      res.on('data', c => { bytes += c.length; process.stdout.write(`\r  ${(bytes/1024/1024).toFixed(1)} MB...`); });
      res.pipe(file);
      file.on('finish', () => { file.close(); console.log(); resolve(); });
    }).on('error', reject);
  });
}

async function main() {
  // Find the latest winlibs x86_64 posix zip release via GitHub API
  console.log('▸  Fetching latest winlibs release info...');
  const rel = await httpsGet('https://api.github.com/repos/brechtsanders/winlibs_mingw/releases/latest');
  if (rel.status !== 200) throw new Error(`GitHub API: HTTP ${rel.status}`);

  const release = JSON.parse(rel.body);
  console.log('   Latest release:', release.tag_name);

  // Find the x86_64 posix zip (not 7z, not arm, not i686)
  const asset = release.assets.find(a =>
    a.name.includes('x86_64') &&
    a.name.includes('posix') &&
    a.name.endsWith('.zip') &&
    !a.name.includes('i686')
  );

  if (!asset) {
    console.log('Available assets:', release.assets.map(a => a.name).join('\n  '));
    throw new Error('No matching x86_64 posix .zip found in release');
  }

  const zipUrl  = asset.browser_download_url;
  const zipPath = path.join(os.tmpdir(), asset.name);
  const destDir = os.homedir();

  console.log(`▸  Downloading ${asset.name} (${(asset.size/1024/1024).toFixed(0)} MB)...`);
  await download(zipUrl, zipPath);
  console.log(`✓  Saved to ${zipPath}`);

  console.log('▸  Extracting to', destDir, '...');
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`,
    { stdio: 'inherit' }
  );

  // winlibs extracts as "mingw64/" inside destDir
  const gccPath = path.join(destDir, 'mingw64', 'bin', 'gcc.exe');
  if (!fs.existsSync(gccPath)) {
    // Try to find it
    const found = fs.readdirSync(destDir).filter(d => d.toLowerCase().includes('mingw'));
    throw new Error(`gcc.exe not found. Extracted dirs: ${found.join(', ')}`);
  }

  const ver = execSync(`"${gccPath}" --version`, { encoding: 'utf8' }).split('\n')[0];
  console.log(`✓  ${ver}`);

  // Add GNU Rust target + set as default host
  const rustup = path.join(os.homedir(), '.cargo', 'bin', 'rustup.exe');
  console.log('▸  Configuring Rust GNU toolchain...');
  execSync(`"${rustup}" target add x86_64-pc-windows-gnu`, { stdio: 'inherit' });
  execSync(`"${rustup}" set default-host x86_64-pc-windows-gnu`, { stdio: 'inherit' });

  // Write ~/.cargo/config.toml linker entry
  const cfgPath = path.join(os.homedir(), '.cargo', 'config.toml');
  const linker  = path.join(destDir, 'mingw64', 'bin', 'x86_64-w64-mingw32-gcc.exe').replace(/\\/g, '/');
  const entry   = `\n[target.x86_64-pc-windows-gnu]\nlinker = "${linker}"\n`;
  const existing = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '';
  if (!existing.includes('x86_64-pc-windows-gnu')) {
    fs.appendFileSync(cfgPath, entry);
    console.log('✓  ~/.cargo/config.toml updated with linker path');
  }

  console.log(`
✓  Done.  Run in a NEW terminal (so PATH refreshes):

    node build-server.mjs   ← compile server sidecar
    npm run build:tauri      ← build Tauri installer
`);
}

main().catch(e => { console.error('\n✗', e.message); process.exit(1); });
