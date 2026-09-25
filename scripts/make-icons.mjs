// Draws the Gaze Reader icon (round nerd glasses on a warm tile) and writes
// extension/icons/icon-{16,32,48,128}.png. Only node:zlib, no image libraries.
//
// Shapes are signed distance fields in a 128-unit design space; each pixel's
// coverage is clamp(0.5 − distance/pixelSize), which gives clean analytic
// anti-aliasing at every size. Strokes get a minimum width in *pixels* so the
// glasses stay legible at 16 px. Output is deterministic.
//
// Usage: node scripts/make-icons.mjs [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(process.argv[2] ?? join(here, '..', 'extension', 'icons'));
const SIZES = [16, 32, 48, 128];

const INK = [43, 29, 20];
const LENS = [255, 246, 230];
const GLINT = [255, 255, 255];
const TILE_TOP = [255, 190, 92];
const TILE_BOTTOM = [239, 125, 45];

// ────────────────────────────── distance fields ──────────────────────────────

const len = (x, y) => Math.hypot(x, y);

function sdRoundedBox(px, py, cx, cy, half, r) {
  const qx = Math.abs(px - cx) - (half - r);
  const qy = Math.abs(py - cy) - (half - r);
  return len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

const sdCircle = (px, py, cx, cy, r) => len(px - cx, py - cy) - r;

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return len(pax - bax * h, pay - bay * h);
}

/** Distance to a quadratic Bézier, via a fine polyline (plenty for a 12-unit curve). */
function sdQuad(px, py, a, c, b, steps = 24) {
  let best = Infinity;
  let prev = a;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const pt = [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
    best = Math.min(best, sdSegment(px, py, prev[0], prev[1], pt[0], pt[1]));
    prev = pt;
  }
  return best;
}

/** Distance to a circular arc from angle a0 to a1 (radians, y down). */
function sdArc(px, py, cx, cy, r, a0, a1) {
  const ang = Math.atan2(py - cy, px - cx);
  if (ang >= a0 && ang <= a1) return Math.abs(len(px - cx, py - cy) - r);
  const e0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)];
  const e1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
  return Math.min(len(px - e0[0], py - e0[1]), len(px - e1[0], py - e1[1]));
}

// ───────────────────────────────── drawing ───────────────────────────────────

function render(size) {
  const unitsPerPx = 128 / size;
  const cover = (d) => Math.max(0, Math.min(1, 0.5 - d / unitsPerPx));
  const stroke = (units, minPx) => Math.max(units, minPx * unitsPerPx);

  const ring = stroke(9, 1.5);
  const thin = stroke(8, 1.3);
  const lensR = 22;
  const lenses = [
    [40, 68],
    [88, 68],
  ];
  const pupilR = stroke(6.4, 1.2);
  const showGlints = size >= 32;

  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) * unitsPerPx;
      const py = (y + 0.5) * unitsPerPx;

      const tileA = cover(sdRoundedBox(px, py, 64, 64, 64, 28));
      if (tileA <= 0) continue;
      const g = py / 128;
      let col = TILE_TOP.map((c, i) => c + (TILE_BOTTOM[i] - c) * g);
      const paint = (color, a) => {
        if (a > 0) col = col.map((c, i) => c + (color[i] - c) * a);
      };

      for (const [cx, cy] of lenses) paint(LENS, cover(sdCircle(px, py, cx, cy, lensR)));
      for (const [cx, cy] of lenses) {
        paint(INK, cover(Math.abs(sdCircle(px, py, cx, cy, lensR)) - ring / 2));
        paint(INK, cover(sdCircle(px, py, cx + 6, cy + 6, pupilR)));
      }
      paint(INK, cover(sdQuad(px, py, [57, 63], [64, 55], [71, 63]) - thin / 2));
      paint(INK, cover(sdSegment(px, py, 18, 64, 10, 58) - thin / 2));
      paint(INK, cover(sdSegment(px, py, 110, 64, 118, 58) - thin / 2));
      if (showGlints) {
        for (const [cx, cy] of lenses) {
          paint(GLINT, 0.95 * cover(sdArc(px, py, cx, cy, 14, (-148 * Math.PI) / 180, (-102 * Math.PI) / 180) - 2.2));
        }
      }

      const o = (y * size + x) * 4;
      rgba[o] = Math.round(col[0]);
      rgba[o + 1] = Math.round(col[1]);
      rgba[o + 2] = Math.round(col[2]);
      rgba[o + 3] = Math.round(tileA * 255);
    }
  }
  return rgba;
}

// ─────────────────────────────────── PNG ─────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  const file = join(outDir, `icon-${size}.png`);
  const png = encodePng(size, render(size));
  writeFileSync(file, png);
  console.log(`[icons] ${file} (${png.length} bytes)`);
}
