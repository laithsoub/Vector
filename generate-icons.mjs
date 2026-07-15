/**
 * Generates valid PNG + ICO icon files using only Node.js built-ins.
 * No dependencies. Run: node generate-icons.mjs
 */
import { deflateSync }                            from 'zlib';
import { writeFileSync, mkdirSync }               from 'fs';
import path                                        from 'path';
import { fileURLToPath }                           from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICON_DIR  = path.join(__dirname, 'src-tauri', 'icons');
mkdirSync(ICON_DIR, { recursive: true });

// Eaton dark-blue background, white "V"
const BG = [0x00, 0x2B, 0x5C];   // #002B5C
const FG = [0xFF, 0xFF, 0xFF];   // white

// ── CRC32 ─────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const tb  = Buffer.from(type, 'ascii');
  const crc = uint32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([uint32BE(data.length), tb, data, crc]);
}

function uint32BE(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }

// ── Draw a "V" glyph into a size×size RGBA pixel array ───────────────────────
function makePixels(size) {
  const px = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      px.push(...BG);
    }
  }

  // Simple V stroke: two diagonal lines from top to bottom-centre
  const stroke = Math.max(1, Math.round(size / 12));
  const pad    = Math.round(size * 0.15);
  const cx     = size / 2;
  const top    = pad;
  const bottom = size - pad;

  function dot(px2, py2) {
    for (let dy = -stroke; dy <= stroke; dy++) {
      for (let dx = -stroke; dx <= stroke; dx++) {
        const nx = Math.round(px2 + dx);
        const ny = Math.round(py2 + dy);
        if (nx >= 0 && nx < size && ny >= 0 && ny < size) {
          const idx = (ny * size + nx) * 3;
          px[idx] = FG[0]; px[idx + 1] = FG[1]; px[idx + 2] = FG[2];
        }
      }
    }
  }

  const steps = size * 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // left arm: (pad, top) → (cx, bottom)
    dot(pad + (cx - pad) * t, top + (bottom - top) * t);
    // right arm: (size-pad, top) → (cx, bottom)
    dot((size - pad) + (cx - (size - pad)) * t, top + (bottom - top) * t);
  }

  return px;
}

// ── Build a PNG buffer ────────────────────────────────────────────────────────
function makePng(size) {
  const pixels = makePixels(size);
  const sig    = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  // Raw scanlines: filter byte (0) + RGBA row
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const off = y * (1 + size * 4);
    raw[off] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const pi = (y * size + x) * 3;
      raw[off + 1 + x * 4]     = pixels[pi];
      raw[off + 1 + x * 4 + 1] = pixels[pi + 1];
      raw[off + 1 + x * 4 + 2] = pixels[pi + 2];
      raw[off + 1 + x * 4 + 3] = 0xFF; // fully opaque
    }
  }

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Build an ICO with embedded PNGs ──────────────────────────────────────────
function makeIco(sizes) {
  const pngs   = sizes.map(makePng);
  const header = Buffer.from([0, 0, 1, 0, sizes.length & 0xFF, 0]);
  let   offset = 6 + sizes.length * 16;
  const dirs   = pngs.map((png, i) => {
    const sz  = sizes[i];
    const e   = Buffer.alloc(16);
    e[0] = sz >= 256 ? 0 : sz;
    e[1] = sz >= 256 ? 0 : sz;
    e.writeUInt16LE(1,  4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset,     12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([header, ...dirs, ...pngs]);
}

// ── Write files ───────────────────────────────────────────────────────────────
writeFileSync(path.join(ICON_DIR, '32x32.png'),       makePng(32));
writeFileSync(path.join(ICON_DIR, '128x128.png'),     makePng(128));
writeFileSync(path.join(ICON_DIR, '128x128@2x.png'),  makePng(256));
writeFileSync(path.join(ICON_DIR, 'icon.ico'),        makeIco([16, 24, 32, 48, 64, 128, 256]));

console.log('✓ icons written to src-tauri/icons/');
