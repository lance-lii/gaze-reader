import type {
  AppEvents,
  EyeFeatures,
  FeatureFrame,
  LightingComponent,
  LightingFlag,
  LightingSignature,
  LightingStats,
} from '../types';

/**
 * Lighting measured from the camera frame.
 *
 * A few regions are defined by the face landmarks (face oval, cheeks, the lid
 * apertures, the iris disks, a box around each eye, the background). Each
 * measurement reduces their pixels to the 17 numbers of `LightingStats`:
 * exposure of the whites of the eyes (skin-tone independent), back-light,
 * side light, eye-socket shading, glare on glasses or the eye, clipping.
 *
 * Privacy: pixels are read into private, reused buffers (or one small canvas
 * that is never attached to the page), reduced to those numbers, and dropped.
 * Nothing here stores, emits, draws or posts pixels.
 *
 *  1. Regions (pure): landmark indices → polygons in video pixels.
 *  2. Statistics (pure): pixel views → LightingStats; one formula set for both backends.
 *  3. LightingProbe: when and how to measure a live frame. Fast path:
 *     `VideoFrame.copyTo` of a few rectangles (≈ 0.3 ms synchronous). Fallback:
 *     one 160×128 `willReadFrequently` atlas canvas and one `getImageData` (≈ 1 ms).
 *  4. LightingMonitor: smoothed stats and hysteretic coaching flags.
 *  5. Signature: a 6-number, skin-tone independent description stored with the
 *     calibration, and a distance that says whether the lighting has changed.
 *  6. LightingWatch: rolling signature vs the calibration's (and, once changed,
 *     vs the last report's), with hold times; a change that the screen's own
 *     brightness accounts for (a dark page in a dim room) is not reported.
 *
 * Thresholds come from physics and a synthetic renderer (see the lighting
 * spec in the project notes); they still need checking on real cameras.
 * "Right"/"left" are the subject's anatomical sides, as in features.ts.
 */

// ───────────────────────────────── 1. Regions ─────────────────────────────────

export interface Pt {
  x: number;
  y: number;
}

/** Integer pixel rectangle. */
export interface IRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LandmarkPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Closed lid contours, outer corner → upper lid → inner corner → lower lid.
 * Verified against @mediapipe/tasks-vision 1.0.1 FACE_LANDMARKS_{RIGHT,LEFT}_EYE.
 */
export const RIGHT_EYE_CONTOUR: readonly number[] = Object.freeze([
  33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7,
]);
export const LEFT_EYE_CONTOUR: readonly number[] = Object.freeze([
  263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249,
]);
export const RIGHT_IRIS: Readonly<{ center: number; ring: readonly number[] }> = Object.freeze({
  center: 468,
  ring: Object.freeze([469, 470, 471, 472]),
});
export const LEFT_IRIS: Readonly<{ center: number; ring: readonly number[] }> = Object.freeze({
  center: 473,
  ring: Object.freeze([474, 475, 476, 477]),
});
/** FACE_LANDMARKS_FACE_OVAL, starting at the top of the forehead (10); 152 is the chin. */
export const FACE_OVAL: readonly number[] = Object.freeze([
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
  172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
]);
const R_OUTER = 33;
const R_INNER = 133;
const L_OUTER = 263;
const L_INNER = 362;
const CHIN = 152;
const LANDMARKS_NEEDED = 478;

const REQUIRED_LANDMARKS: readonly number[] = Object.freeze([
  ...RIGHT_EYE_CONTOUR,
  ...LEFT_EYE_CONTOUR,
  ...FACE_OVAL,
  RIGHT_IRIS.center,
  ...RIGHT_IRIS.ring,
  LEFT_IRIS.center,
  ...LEFT_IRIS.ring,
]);

/** Faces whose eye centres are closer than this (video px) are too small to measure. */
export const MIN_INTEROCULAR_PX = 24;

export interface EyeRegions {
  /** Lid aperture, shrunk 12 % toward its centroid (drops lash and lid-margin pixels). */
  aperture: Pt[];
  /** Iris disk (16-gon at 0.9 × the ring radius). */
  iris: Pt[];
  /** Rotated box around the eye where glasses reflections show: ±0.9 W along the corner axis, −0.6 W…+0.5 W across. */
  glareBox: Pt[];
  /** Bounding rectangle of the glare box (video px, clamped to the frame). */
  src: IRect;
}

export interface LightingGeometry {
  frameW: number;
  frameH: number;
  /** Distance between the eye-corner midpoints, video px. */
  D: number;
  faceOval: Pt[];
  /** [right, left] malar cheek patches. */
  cheeks: [Pt[], Pt[]];
  /** [right, left]. */
  eyes: [EyeRegions, EyeRegions];
  /** Face oval bounding box plus 4 %, clamped to the frame. */
  faceSrc: IRect;
  /** Background = frame minus this rectangle (face widened 30 % each side, from 20 % above it to the bottom edge: neck and torso are not background). */
  bgExclude: IRect;
}

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const len = (a: Pt): number => Math.hypot(a.x, a.y);
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

function bbox(pts: readonly Pt[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

function clampRect(x0: number, y0: number, x1: number, y1: number, W: number, H: number): IRect | null {
  const a = Math.max(0, Math.floor(x0));
  const b = Math.max(0, Math.floor(y0));
  const c = Math.min(W, Math.ceil(x1));
  const d = Math.min(H, Math.ceil(y1));
  return c - a >= 4 && d - b >= 4 ? { x: a, y: b, w: c - a, h: d - b } : null;
}

function shrinkToCentroid(poly: Pt[], k: number): Pt[] {
  let cx = 0;
  let cy = 0;
  for (const p of poly) {
    cx += p.x;
    cy += p.y;
  }
  const c = { x: cx / poly.length, y: cy / poly.length };
  return poly.map((p) => lerp(c, p, 1 - k));
}

function ngon(c: Pt, r: number, n = 16): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    out.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  return out;
}

/**
 * Regions in video pixels from normalized landmarks (x, y in 0..1 of the frame
 * MediaPipe saw). Null when the face is too small or degenerate, or a needed
 * landmark is missing or non-finite.
 */
export function lightingGeometry(lm: readonly LandmarkPoint[] | null | undefined, frameW: number, frameH: number): LightingGeometry | null {
  if (!lm || lm.length < LANDMARKS_NEEDED || !(frameW > 0) || !(frameH > 0)) return null;
  for (const i of REQUIRED_LANDMARKS) {
    const p = lm[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  }
  const P = (i: number): Pt => ({ x: lm[i].x * frameW, y: lm[i].y * frameH });

  const eR = mid(P(R_OUTER), P(R_INNER));
  const eL = mid(P(L_OUTER), P(L_INNER));
  const D = len(sub(eL, eR));
  if (!(D >= MIN_INTEROCULAR_PX)) return null;
  const ex = mul(sub(eL, eR), 1 / D); // subject's right → left
  let ey: Pt = { x: -ex.y, y: ex.x };
  const m = mid(eR, eL);
  const toChin = sub(P(CHIN), m);
  if (ey.x * toChin.x + ey.y * toChin.y < 0) ey = mul(ey, -1); // toward the chin
  const F = (u: number, v: number): Pt => add(m, add(mul(ex, D * u), mul(ey, D * v)));
  const quad = (u0: number, u1: number, v0: number, v1: number): Pt[] => [F(u0, v0), F(u1, v0), F(u1, v1), F(u0, v1)];

  const faceOval = FACE_OVAL.map(P);
  // Malar cheek patches: 22–53 mm to the side, 22–47 mm below the eye line (D ≈ 62 mm):
  // clear of the nose, the lids and the mouth.
  const cheeks: [Pt[], Pt[]] = [quad(-0.85, -0.35, 0.35, 0.75), quad(0.35, 0.85, 0.35, 0.75)];

  const eye = (contour: readonly number[], outerI: number, innerI: number, iris: { center: number; ring: readonly number[] }): EyeRegions | null => {
    const O = P(outerI);
    const I = P(innerI);
    const W = len(sub(O, I));
    if (!(W > 4)) return null;
    const a = mul(sub(O, I), 1 / W);
    let n: Pt = { x: -a.y, y: a.x };
    if (n.x * ey.x + n.y * ey.y < 0) n = mul(n, -1);
    const c0 = mid(O, I);
    const G = (s: number, t: number): Pt => add(c0, add(mul(a, W * s), mul(n, W * t)));
    const glareBox = [G(-0.9, -0.6), G(0.9, -0.6), G(0.9, 0.5), G(-0.9, 0.5)];
    const ic = P(iris.center);
    let r = 0;
    for (const k of iris.ring) r += len(sub(P(k), ic));
    r /= iris.ring.length;
    const b = bbox(glareBox);
    const src = clampRect(b.x0, b.y0, b.x1, b.y1, frameW, frameH);
    if (!src || !(r > 0)) return null;
    return { aperture: shrinkToCentroid(contour.map(P), 0.12), iris: ngon(ic, 0.9 * r), glareBox, src };
  };
  const right = eye(RIGHT_EYE_CONTOUR, R_OUTER, R_INNER, RIGHT_IRIS);
  const left = eye(LEFT_EYE_CONTOUR, L_OUTER, L_INNER, LEFT_IRIS);
  if (!right || !left) return null;

  const fb = bbox(faceOval);
  const fw = fb.x1 - fb.x0;
  const fh = fb.y1 - fb.y0;
  const faceSrc = clampRect(fb.x0 - 0.04 * fw, fb.y0 - 0.04 * fh, fb.x1 + 0.04 * fw, fb.y1 + 0.04 * fh, frameW, frameH);
  if (!faceSrc) return null;
  const bgExclude: IRect = { x: fb.x0 - 0.3 * fw, y: fb.y0 - 0.2 * fh, w: 1.6 * fw, h: frameH - (fb.y0 - 0.2 * fh) };
  return { frameW, frameH, D, faceOval, cheeks, eyes: [right, left], faceSrc, bgExclude };
}

// ──────────────────────────────── 2. Statistics ────────────────────────────────

/** Luma (8-bit) at or above which a pixel counts as near-saturated (glints, glare). */
export const SAT_LUMA8 = 245;
/** Any channel at or above this is clipped (over-exposed skin shows up in red first). */
export const CLIP_CHANNEL8 = 250;
/** Keeps log ratios finite in black regions (≈ luma code 3 in linear light). */
const EPS = 1 / 1024;

/** sRGB decode table: 8-bit code → linear 0..1. */
export const SRGB_TO_LINEAR: Float32Array = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

/** Raw Y code → full-range 8-bit luma. */
function yTable(fullRange: boolean): Uint8Array {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) t[i] = fullRange ? i : Math.max(0, Math.min(255, Math.round(((i - 16) * 255) / 219)));
  return t;
}
export const Y_FULL_RANGE: Uint8Array = yTable(true);
/** Limited ("video") range 16–235 expanded to 0–255. */
export const Y_LIMITED_RANGE: Uint8Array = yTable(false);

/**
 * How to read luma out of a copied plane. Cameras usually deliver limited-range
 * YUV. When the frame doesn't say (`fullRange` null) we assume limited: read
 * as full range, limited data would never reach the saturation threshold and
 * glare could not be seen at all, while the opposite mistake only saturates a
 * little early.
 */
export function yTableFor(fullRange: boolean | null | undefined): Uint8Array {
  return fullRange === true ? Y_FULL_RANGE : Y_LIMITED_RANGE;
}

export type PixelKind = 'y' | 'rgba' | 'bgra';

/** VideoFrame.format → how its first plane reads; null when unsupported (use the canvas path). */
export function pixelKindOf(format: string | null | undefined): PixelKind | null {
  switch (format) {
    case 'I420':
    case 'I420A':
    case 'I422':
    case 'I422A':
    case 'I444':
    case 'I444A':
    case 'NV12':
      return 'y'; // plane 0 is 8-bit luma
    case 'RGBA':
    case 'RGBX':
      return 'rgba';
    case 'BGRA':
    case 'BGRX':
      return 'bgra';
    default:
      return null; // high bit depth (I420P10…) and anything new
  }
}

/** A rectangle of pixels. Pixel (i, j) covers region coordinates [x0 + i, x0 + i + 1) × [y0 + j, y0 + j + 1). */
export interface PixelView {
  readonly data: Uint8Array | Uint8ClampedArray;
  /** Byte offset of pixel (0, 0). */
  readonly offset: number;
  /** Bytes per row. */
  readonly stride: number;
  readonly w: number;
  readonly h: number;
  readonly x0: number;
  readonly y0: number;
  readonly kind: PixelKind;
  /**
   * 4:2:0 chroma of a 'y' view, for clipping only: skin clips in red at a luma
   * of ≈ 210, which luma alone can't see. Without it, a clipped luma is the proxy.
   */
  readonly chroma?: ChromaView;
}

/** Where the Cb/Cr samples of a 4:2:0 view are (Cb of pixel (x, y) at offset + (y >> 1)·stride + (x >> 1)·step + cb). */
export interface ChromaView {
  readonly offset: number;
  readonly stride: number;
  /** Bytes between horizontally adjacent chroma samples (2 for NV12's interleaved plane, 1 for I420). */
  readonly step: number;
  /** Byte offsets of Cb and Cr from the sample position (NV12: 0 and 1; I420: 0 and V-plane − U-plane). */
  readonly cb: number;
  readonly cr: number;
  readonly lut: ChromaLut;
}

/** BT.601 chroma-to-RGB terms, 8-bit (limited-range chroma is expanded by 255/224). */
export interface ChromaLut {
  readonly crR: Float32Array;
  readonly crG: Float32Array;
  readonly cbG: Float32Array;
  readonly cbB: Float32Array;
}

function chromaTable(fullRange: boolean): ChromaLut {
  const k = fullRange ? 1 : 255 / 224;
  const make = (f: number): Float32Array => Float32Array.from({ length: 256 }, (_, c) => f * k * (c - 128));
  return { crR: make(1.402), crG: make(0.714136), cbG: make(0.344136), cbB: make(1.772) };
}
const CHROMA_FULL = chromaTable(true);
const CHROMA_LIMITED = chromaTable(false);

/** Chroma terms matching `yTableFor` (limited range unless the frame says full). */
export function chromaTableFor(fullRange: boolean | null | undefined): ChromaLut {
  return fullRange === true ? CHROMA_FULL : CHROMA_LIMITED;
}

/** Only pixels at least this bright (8-bit luma) can have a clipped channel in practice; darker ones skip the chroma read. */
const CHROMA_CLIP_MIN_LUMA = 128;

/** Running sums for one region. */
export class RegionAcc {
  n = 0;
  sumLin = 0;
  /** Linear sum over non-saturated pixels only (glare must not inflate shading measures). */
  sumLinU = 0;
  sumLuma8 = 0;
  sat = 0;
  clip = 0;
  /** Per-code luma histogram (exact quantiles, even for dark regions). */
  readonly hist: Uint32Array | null;

  /** Count channel clipping from chroma too (only regions whose clip fraction is reported need it). */
  readonly clipFromChroma: boolean;

  constructor(withHistogram = false, clipFromChroma = false) {
    this.hist = withHistogram ? new Uint32Array(256) : null;
    this.clipFromChroma = clipFromChroma;
  }

  reset(): void {
    this.n = 0;
    this.sumLin = 0;
    this.sumLinU = 0;
    this.sumLuma8 = 0;
    this.sat = 0;
    this.clip = 0;
    this.hist?.fill(0);
  }

  get meanLin(): number {
    return this.n > 0 ? this.sumLin / this.n : NaN;
  }
  get meanLinUnsat(): number {
    const n = this.n - this.sat;
    return n > 0 ? this.sumLinU / n : NaN;
  }
  get meanLuma(): number {
    return this.n > 0 ? this.sumLuma8 / (255 * this.n) : NaN;
  }
  get satFrac(): number {
    return this.n > 0 ? this.sat / this.n : NaN;
  }
  get clipFrac(): number {
    return this.n > 0 ? this.clip / this.n : NaN;
  }

  /** Linear luminance at quantile q (0..1) over the codes below `maxCode`. NaN without data. */
  quantileLin(q: number, maxCode = 256): number {
    const h = this.hist;
    if (!h) return NaN;
    let n = 0;
    for (let c = 0; c < maxCode; c++) n += h[c];
    if (n === 0) return NaN;
    const target = q * n;
    let cum = 0;
    for (let c = 0; c < maxCode; c++) {
      cum += h[c];
      if (cum >= target) return SRGB_TO_LINEAR[c];
    }
    return SRGB_TO_LINEAR[maxCode - 1];
  }
}

/** Adds pixels xa, xa + step, … < xb of view row `row`. */
function accSpan(v: PixelView, row: number, xa: number, xb: number, step: number, acc: RegionAcc, yLut: Uint8Array): void {
  const lut = SRGB_TO_LINEAR;
  const hist = acc.hist;
  const d = v.data;
  let n = 0;
  let sumLin = 0;
  let sumLinU = 0;
  let sumL = 0;
  let sat = 0;
  let clip = 0;
  if (v.kind === 'y') {
    let i = v.offset + row * v.stride + xa;
    const ch = acc.clipFromChroma ? v.chroma : undefined;
    const cRow = ch ? ch.offset + (row >> 1) * ch.stride : 0;
    for (let x = xa; x < xb; x += step, i += step) {
      const l = yLut[d[i]];
      const lin = lut[l];
      n++;
      sumLin += lin;
      sumL += l;
      if (l >= SAT_LUMA8) sat++;
      else sumLinU += lin;
      if (l >= CLIP_CHANNEL8) clip++;
      else if (ch && l >= CHROMA_CLIP_MIN_LUMA) {
        const c = cRow + (x >> 1) * ch.step;
        const cb = d[c + ch.cb];
        const cr = d[c + ch.cr];
        const t = ch.lut;
        if (l + t.crR[cr] >= CLIP_CHANNEL8 || l + t.cbB[cb] >= CLIP_CHANNEL8 || l - t.cbG[cb] - t.crG[cr] >= CLIP_CHANNEL8) clip++;
      }
      if (hist) hist[l]++;
    }
  } else {
    const ri = v.kind === 'rgba' ? 0 : 2;
    const bi = 2 - ri;
    let i = v.offset + row * v.stride + xa * 4;
    const di = 4 * step;
    for (let x = xa; x < xb; x += step, i += di) {
      const r = d[i + ri];
      const g = d[i + 1];
      const b = d[i + bi];
      // Rec. 709 weights in 8-bit fixed point (54 + 183 + 19 = 256).
      const l = (54 * r + 183 * g + 19 * b + 128) >> 8;
      const lin = lut[l];
      n++;
      sumLin += lin;
      sumL += l;
      if (l >= SAT_LUMA8) sat++;
      else sumLinU += lin;
      if (r >= CLIP_CHANNEL8 || g >= CLIP_CHANNEL8 || b >= CLIP_CHANNEL8) clip++;
      if (hist) hist[l]++;
    }
  }
  acc.n += n;
  acc.sumLin += sumLin;
  acc.sumLinU += sumLinU;
  acc.sumLuma8 += sumL;
  acc.sat += sat;
  acc.clip += clip;
}

/** Pixel-index clip rectangle [x0, x1) × [y0, y1) inside a view. */
export interface PixelClip {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const xsScratch: number[] = [];

/**
 * Accumulates the view pixels whose centres fall inside `poly` (region
 * coordinates, even-odd rule), within `clip` (default: the whole view), on a
 * lattice of every `step`-th row and column.
 */
export function accPolygon(
  v: PixelView,
  poly: readonly Pt[],
  acc: RegionAcc,
  yLut: Uint8Array,
  step = 1,
  clip: PixelClip | null = null,
): void {
  if (poly.length < 3) return;
  const cx0 = Math.max(0, clip ? clip.x0 : 0);
  const cy0 = Math.max(0, clip ? clip.y0 : 0);
  const cx1 = Math.min(v.w, clip ? clip.x1 : v.w);
  const cy1 = Math.min(v.h, clip ? clip.y1 : v.h);
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  let ya = Math.max(cy0, Math.ceil(minY - v.y0 - 0.5));
  const yb = Math.min(cy1 - 1, Math.floor(maxY - v.y0 - 0.5));
  if (step > 1) ya += (step - (ya % step)) % step; // a fixed row lattice
  const xs = xsScratch;
  for (let row = ya; row <= yb; row += step) {
    const cy = row + v.y0 + 0.5;
    xs.length = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j];
      const b = poly[i];
      if (a.y <= cy !== b.y <= cy) xs.push(a.x + ((cy - a.y) / (b.y - a.y)) * (b.x - a.x) - v.x0);
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let xa = Math.max(cx0, Math.ceil(xs[k] - 0.5));
      const xb = Math.min(cx1, Math.ceil(xs[k + 1] - 0.5));
      if (step > 1) xa += (step - (xa % step)) % step; // a fixed column lattice
      if (xb > xa) accSpan(v, row, xa, xb, step, acc, yLut);
    }
  }
}

/** Accumulates a pixel rectangle of the view, minus an optional excluded rectangle (same pixel space, may be fractional). */
export function accRect(v: PixelView, r: PixelClip, exclude: PixelClip | null, acc: RegionAcc, yLut: Uint8Array, step = 1): void {
  const x0 = Math.max(0, r.x0);
  const y0 = Math.max(0, r.y0);
  const x1 = Math.min(v.w, r.x1);
  const y1 = Math.min(v.h, r.y1);
  for (let row = y0; row < y1; row += step) {
    const cy = row + 0.5;
    if (!exclude || cy < exclude.y0 || cy >= exclude.y1) {
      accSpan(v, row, x0, x1, step, acc, yLut);
      continue;
    }
    const xa = Math.max(x0, Math.min(x1, Math.ceil(exclude.x0 - 0.5)));
    let xb = Math.max(x0, Math.min(x1, Math.ceil(exclude.x1 - 0.5)));
    if (step > 1) xb += (step - ((xb - x0) % step)) % step; // keep the column lattice anchored at x0
    if (xa > x0) accSpan(v, row, x0, xa, step, acc, yLut);
    if (x1 > xb) accSpan(v, row, xb, x1, step, acc, yLut);
  }
}

interface EyeAccs {
  readonly ap: RegionAcc;
  readonly iris: RegionAcc;
  readonly box: RegionAcc;
}

/** Accumulators for one measurement, reused between measurements. */
export class MeasureScratch {
  readonly face = new RegionAcc(true, true);
  readonly cheekR = new RegionAcc();
  readonly cheekL = new RegionAcc();
  readonly frame = new RegionAcc();
  readonly bg = new RegionAcc(false, true);
  readonly eyes: readonly [EyeAccs, EyeAccs] = [
    { ap: new RegionAcc(true), iris: new RegionAcc(), box: new RegionAcc() },
    { ap: new RegionAcc(true), iris: new RegionAcc(), box: new RegionAcc() },
  ];

  reset(): void {
    this.face.reset();
    this.cheekR.reset();
    this.cheekL.reset();
    this.frame.reset();
    this.bg.reset();
    for (const e of this.eyes) {
      e.ap.reset();
      e.iris.reset();
      e.box.reset();
    }
  }
}

/** Minimum samples per region for a valid measurement. */
const MIN_FACE_SAMPLES = 200;
const MIN_CHEEK_SAMPLES = 12;
const MIN_APERTURE_SAMPLES = 8;
const MIN_BG_SAMPLES = 16;

const log2Ratio = (a: number, b: number): number => Math.log2((a + EPS) / (b + EPS));

/**
 * The shared formulas, whichever backend filled the accumulators. Null when a
 * region is too small (face at the edge, eyes nearly shut) or a value is not
 * finite. `pixelArea` = video pixels per face sample (so `facePx` is backend independent).
 */
export function statsFromAccs(a: MeasureScratch, pixelArea: number): LightingStats | null {
  const { face, cheekR, cheekL, frame, bg } = a;
  const [eR, eL] = a.eyes;
  if (face.n < MIN_FACE_SAMPLES || cheekR.n < MIN_CHEEK_SAMPLES || cheekL.n < MIN_CHEEK_SAMPLES) return null;
  for (const e of a.eyes) if (e.ap.n < MIN_APERTURE_SAMPLES || e.box.n < 4 * MIN_APERTURE_SAMPLES) return null;

  // Non-saturated means, so glare can't pass for light; a region that is entirely
  // saturated (a blown-out face) falls back to its plain mean rather than failing.
  const unsat = (r: RegionAcc): number => (r.n > r.sat ? r.meanLinUnsat : r.meanLin);
  const cR = unsat(cheekR);
  const cL = unsat(cheekL);
  const hasBg = bg.n >= MIN_BG_SAMPLES;
  const bgLin = hasBg ? bg.meanLin : frame.meanLin;
  // p85 of the non-saturated aperture pixels: the white of the eye, never a glint.
  const sclera = (r: RegionAcc): number => (r.n > r.sat ? r.quantileLin(0.85, SAT_LUMA8) : r.quantileLin(0.85));
  const scleraR = sclera(eR.ap);
  const scleraL = sclera(eL.ap);
  const out: LightingStats = {
    faceLuma: face.meanLuma,
    faceLin: face.meanLin,
    faceRange: log2Ratio(face.quantileLin(0.9), face.quantileLin(0.1)),
    faceClip: face.clipFrac,
    frameLin: frame.meanLin,
    bgLin,
    bgClip: hasBg ? bg.clipFrac : 0,
    scleraR,
    scleraL,
    backlight: log2Ratio(0.5 * (scleraR + scleraL), bgLin),
    side: log2Ratio(cL, cR),
    shade: 0.5 * (log2Ratio(unsat(eR.box), cR) + log2Ratio(unsat(eL.box), cL)),
    glareR: eR.box.satFrac,
    glareL: eL.box.satFrac,
    irisGlintR: eR.iris.n > 0 ? eR.iris.satFrac : 0,
    irisGlintL: eL.iris.n > 0 ? eL.iris.satFrac : 0,
    facePx: face.n * pixelArea,
  };
  for (const k of LIGHTING_STAT_KEYS) {
    const v = out[k];
    if (!Number.isFinite(v)) return null;
    // Four decimals: plenty for every threshold, and ≈ 350 bytes per frame on the extension's port.
    out[k] = k === 'facePx' ? Math.round(v) : Math.round(v * 1e4) / 1e4;
  }
  return out;
}

/** Every LightingStats field (the Record type makes the list exhaustive). */
const STAT_KEY_SET: Readonly<Record<keyof LightingStats, true>> = {
  faceLuma: true,
  faceLin: true,
  faceRange: true,
  faceClip: true,
  frameLin: true,
  bgLin: true,
  bgClip: true,
  scleraR: true,
  scleraL: true,
  backlight: true,
  side: true,
  shade: true,
  glareR: true,
  glareL: true,
  irisGlintR: true,
  irisGlintL: true,
  facePx: true,
};
export const LIGHTING_STAT_KEYS: readonly (keyof LightingStats)[] = Object.freeze(Object.keys(STAT_KEY_SET) as (keyof LightingStats)[]);

/** Rectangles to copy (video px, even-aligned for 4:2:0 chroma): face, eyes, background strips. */
export interface CopyPlan {
  face: IRect;
  eyes: [IRect, IRect];
  bg: IRect[];
}

export function planCopyRects(g: LightingGeometry): CopyPlan {
  const W = g.frameW;
  const H = g.frameH;
  const even = (r: IRect): IRect => {
    const x = Math.max(0, r.x & ~1);
    const y = Math.max(0, r.y & ~1);
    const x1 = Math.min(W & ~1, (r.x + r.w + 1) & ~1);
    const y1 = Math.min(H & ~1, (r.y + r.h + 1) & ~1);
    return { x, y, w: Math.max(0, x1 - x), h: Math.max(0, y1 - y) };
  };
  const ex = g.bgExclude;
  const ex0 = Math.max(0, Math.min(W, Math.round(ex.x)));
  const ex1 = Math.max(0, Math.min(W, Math.round(ex.x + ex.w)));
  const ey0 = Math.max(0, Math.min(H, Math.round(ex.y)));
  const bg = [
    { x: 0, y: 0, w: ex0, h: H },
    { x: ex1, y: 0, w: W - ex1, h: H },
    { x: ex0, y: 0, w: ex1 - ex0, h: ey0 },
  ]
    .map(even)
    .filter((r) => r.w >= 2 && r.h >= 2);
  return { face: even(g.faceSrc), eyes: [even(g.eyes[0].src), even(g.eyes[1].src)], bg };
}

export interface CopiedViews {
  face: PixelView;
  eyes: readonly [PixelView, PixelView];
  bg: readonly PixelView[];
}

/**
 * Stats from copied rectangles (region coordinates = video px). Large faces are
 * sampled every 2nd pixel (≲ 10k samples); the background every 4th.
 */
export function measureViews(g: LightingGeometry, views: CopiedViews, yLut: Uint8Array, scratch = new MeasureScratch()): LightingStats | null {
  scratch.reset();
  const fStep = g.D >= 80 ? 2 : 1;
  const fv = views.face;
  accPolygon(fv, g.faceOval, scratch.face, yLut, fStep);
  accPolygon(fv, g.cheeks[0], scratch.cheekR, yLut, fStep);
  accPolygon(fv, g.cheeks[1], scratch.cheekL, yLut, fStep);
  for (const v of views.bg) {
    const all = { x0: 0, y0: 0, x1: v.w, y1: v.h };
    accRect(v, all, null, scratch.bg, yLut, 4);
    accRect(v, all, null, scratch.frame, yLut, 4);
  }
  // "Frame" ≈ background strips + the face rectangle (only the exposure swing uses it).
  accRect(fv, { x0: 0, y0: 0, x1: fv.w, y1: fv.h }, null, scratch.frame, yLut, 4);
  for (let k = 0; k < 2; k++) {
    const v = views.eyes[k];
    const e = g.eyes[k];
    const accs = scratch.eyes[k];
    accPolygon(v, e.aperture, accs.ap, yLut);
    accPolygon(v, e.iris, accs.iris, yLut);
    accPolygon(v, e.glareBox, accs.box, yLut);
  }
  return statsFromAccs(scratch, fStep * fStep);
}

// Atlas (canvas fallback): one small canvas, 4 drawImage calls, 1 getImageData.

export const ATLAS_W = 160;
export const ATLAS_H = 128;
const FACE_CELL: IRect = { x: 0, y: 0, w: 96, h: 128 };
const THUMB_CELL: IRect = { x: 96, y: 0, w: 64, h: 48 };
const EYE_CELLS: readonly [IRect, IRect] = [
  { x: 96, y: 48, w: 64, h: 40 },
  { x: 96, y: 88, w: 64, h: 40 },
];

export interface CellMap {
  /** Source rectangle, video px. */
  src: IRect;
  /** Destination rectangle, atlas px. */
  dst: IRect;
}

export interface AtlasLayout {
  face: CellMap;
  thumb: CellMap;
  eyes: [CellMap, CellMap];
}

function fitCell(src: IRect, cell: IRect): CellMap {
  const s = Math.min(1, cell.w / src.w, cell.h / src.h); // never upscale
  const w = Math.max(1, Math.min(cell.w, Math.round(src.w * s)));
  const h = Math.max(1, Math.min(cell.h, Math.round(src.h * s)));
  return { src, dst: { x: cell.x, y: cell.y, w, h } };
}

export function atlasLayout(g: LightingGeometry): AtlasLayout {
  return {
    face: fitCell(g.faceSrc, FACE_CELL),
    thumb: fitCell({ x: 0, y: 0, w: g.frameW, h: g.frameH }, THUMB_CELL),
    eyes: [fitCell(g.eyes[0].src, EYE_CELLS[0]), fitCell(g.eyes[1].src, EYE_CELLS[1])],
  };
}

function toCell(c: CellMap): (p: Pt) => Pt {
  const sx = c.dst.w / c.src.w;
  const sy = c.dst.h / c.src.h;
  return (p) => ({ x: c.dst.x + (p.x - c.src.x) * sx, y: c.dst.y + (p.y - c.src.y) * sy });
}

const cellClip = (r: IRect): PixelClip => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h });

/** Stats from the atlas pixels (RGBA, `ATLAS_W` wide). */
export function measureAtlas(px: Uint8ClampedArray, g: LightingGeometry, layout: AtlasLayout, scratch = new MeasureScratch()): LightingStats | null {
  scratch.reset();
  const v: PixelView = { data: px, offset: 0, stride: ATLAS_W * 4, w: ATLAS_W, h: Math.floor(px.length / (ATLAS_W * 4)), x0: 0, y0: 0, kind: 'rgba' };
  const lut = Y_FULL_RANGE; // unused for RGBA
  const fMap = toCell(layout.face);
  const fClip = cellClip(layout.face.dst);
  accPolygon(v, g.faceOval.map(fMap), scratch.face, lut, 1, fClip);
  accPolygon(v, g.cheeks[0].map(fMap), scratch.cheekR, lut, 1, fClip);
  accPolygon(v, g.cheeks[1].map(fMap), scratch.cheekL, lut, 1, fClip);

  const tMap = toCell(layout.thumb);
  const tClip = cellClip(layout.thumb.dst);
  accRect(v, tClip, null, scratch.frame, lut);
  const e0 = tMap({ x: g.bgExclude.x, y: g.bgExclude.y });
  const e1 = tMap({ x: g.bgExclude.x + g.bgExclude.w, y: g.bgExclude.y + g.bgExclude.h });
  accRect(v, tClip, { x0: e0.x, y0: e0.y, x1: e1.x, y1: e1.y }, scratch.bg, lut);

  for (let k = 0; k < 2; k++) {
    const cm = layout.eyes[k];
    const map = toCell(cm);
    const clip = cellClip(cm.dst);
    const e = g.eyes[k];
    const accs = scratch.eyes[k];
    accPolygon(v, e.aperture.map(map), accs.ap, lut, 1, clip);
    accPolygon(v, e.iris.map(map), accs.iris, lut, 1, clip);
    accPolygon(v, e.glareBox.map(map), accs.box, lut, 1, clip);
  }
  const f = layout.face;
  return statsFromAccs(scratch, (f.src.w / f.dst.w) * (f.src.h / f.dst.h));
}

// ─────────────────────────────── 3. LightingProbe ───────────────────────────────

export interface RectInit {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The part of WebCodecs' VideoFrame the probe uses (a real VideoFrame is assignable). */
export interface VideoFrameLike {
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly visibleRect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
  readonly format: string | null;
  readonly colorSpace: { readonly fullRange: boolean | null } | null;
  clone(): VideoFrameLike;
  close(): void;
  allocationSize(options: { rect: RectInit }): number;
  copyTo(destination: Uint8Array, options: { rect: RectInit }): Promise<readonly { offset: number; stride: number }[]>;
}

/** The part of a 2D canvas context the atlas fallback uses (an OffscreenCanvas context is assignable). */
export interface Canvas2DLike {
  readonly canvas: CanvasImageSource & { width: number; height: number };
  drawImage(image: CanvasImageSource, dx: number, dy: number): void;
  drawImage(image: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): { readonly data: Uint8ClampedArray };
}

/** What the probe can read: the extension's VideoFrames, or the web app's `<video>`. */
export type LightingSource = VideoFrameLike | HTMLVideoElement;

export type LightingBackend = 'copy' | 'canvas' | 'off';

/** What CameraFeatureSource needs from a probe (a seam for tests). */
export interface LightingProbeLike {
  /** Called once per processed frame with a face. Must be cheap when it doesn't measure, and must not throw. */
  maybeMeasure(
    source: LightingSource,
    landmarks: readonly LandmarkPoint[],
    features: EyeFeatures | null,
    quality: number,
    t: number,
  ): void;
  /** The latest measurement not yet handed out (at most about one frame old), or undefined. */
  take(): LightingStats | undefined;
  /** Drops pending work (closes any frame clone). */
  reset(): void;
  dispose(): void;
  readonly backend: LightingBackend;
}

export interface LightingProbeOptions {
  /**
   * 'auto' (default): `copyTo` where WebCodecs' VideoFrame exists, else the
   * canvas atlas (OffscreenCanvas), else off. The choice is made once per probe
   * and then kept (both backends agree only within tolerance, so a device keeps
   * measuring one way): copyTo stays unless it costs more than 1 ms per
   * measurement and the canvas proves cheaper over a few measurements, or it
   * fails, in which case the canvas takes over for good.
   */
  backend?: 'auto' | LightingBackend;
  /** Minimum time between measurements, ms (default 150 ≈ 6.7 Hz; the cost governor may lengthen it). */
  minIntervalMs?: number;
  /** Clock for cost measurement (default performance.now). */
  clock?: () => number;
  /** Wraps the current `<video>` frame for copyTo (default: `new VideoFrame(video, { timestamp })`); null = none. */
  frameFromVideo?: ((video: HTMLVideoElement, timestampUs: number) => VideoFrameLike) | null;
  /** Creates a `willReadFrequently` 2D context (default: OffscreenCanvas); null = no canvas fallback. */
  createCanvas?: ((width: number, height: number) => Canvas2DLike | null) | null;
}

/** Frames with a blink score at or above this are not measured (the sclera is hidden). */
export const PROBE_MAX_BLINK = 0.5;
/** Frames below this tracking quality are not measured. */
export const PROBE_MIN_QUALITY = 0.3;
/** A frame clone still being copied after this long is closed: never starve the camera's buffer pool. */
export const PROBE_SAFETY_CLOSE_MS = 100;
/** Measurements per backend in the one-time cost trial (the first is a warm-up). */
const TRIAL_MEASUREMENTS = 5;
/** copyTo costing more than this per measurement (ms of main thread) is compared with the canvas. */
const TRIAL_SWITCH_MS = 1.0;
/** Consecutive safety closes before copyTo is considered broken on this device. */
const MAX_COPY_TIMEOUTS = 3;
/** Governor: measurement cost EMA (ms) above which the interval grows. */
const GOVERNOR_STEPS: readonly (readonly [costMs: number, intervalMs: number])[] = [
  [1.5, 500],
  [1.0, 250],
];

function defaultFrameFromVideo(): LightingProbeOptions['frameFromVideo'] {
  if (typeof VideoFrame !== 'function') return null;
  return (video, timestampUs) => new VideoFrame(video, { timestamp: timestampUs });
}

function defaultCreateCanvas(): LightingProbeOptions['createCanvas'] {
  if (typeof OffscreenCanvas !== 'function') return null;
  return (w, h) => new OffscreenCanvas(w, h).getContext('2d', { alpha: false, willReadFrequently: true });
}

function isVideoFrameLike(x: LightingSource): x is VideoFrameLike {
  const f = x as Partial<VideoFrameLike>;
  return typeof f.clone === 'function' && typeof f.copyTo === 'function' && typeof f.allocationSize === 'function';
}

function isVideoElementLike(x: LightingSource): x is HTMLVideoElement {
  return typeof (x as Partial<HTMLVideoElement>).videoWidth === 'number';
}

/** Chroma placement of a copied 4:2:0 rectangle, from the plane layouts copyTo returned; null otherwise. */
function chromaOf(format: string | null, layout: readonly { offset: number; stride: number }[] | undefined, lut: ChromaLut): ChromaView | null {
  if (!layout) return null;
  if (format === 'NV12' && layout.length >= 2) return { offset: layout[1].offset, stride: layout[1].stride, step: 2, cb: 0, cr: 1, lut };
  if ((format === 'I420' || format === 'I420A') && layout.length >= 3 && layout[1].stride === layout[2].stride) {
    return { offset: layout[1].offset, stride: layout[1].stride, step: 1, cb: 0, cr: layout[2].offset - layout[1].offset, lut };
  }
  return null; // 4:2:2 / 4:4:4: luma proxy only
}

function closeQuietly(f: VideoFrameLike): void {
  try {
    f.close();
  } catch {
    /* already closed */
  }
}

interface PendingCopy {
  readonly gen: number;
  readonly frame: VideoFrameLike;
  readonly startedAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
  /** Synchronous part of the cost, ms (added to the statistics pass when the copy resolves). */
  syncMs: number;
}

/**
 * Measures lighting on live frames, a few times per second.
 *
 * `maybeMeasure` runs inside the camera frame callback: on the frames it skips
 * it does a few comparisons and allocates nothing. On a measuring frame the
 * fast path clones the frame, starts `copyTo` of ~6 rectangles and returns
 * (0.1–0.3 ms in Chrome 152 for a frame in memory); the statistics (≈ 0.2 ms)
 * run when the copy resolves and are handed out by `take()` with a following
 * frame. At most one copy is in flight, and a clone is closed after
 * `PROBE_SAFETY_CLOSE_MS` whatever happens. A cost governor stretches the
 * interval (250 / 500 ms) when measuring gets expensive.
 *
 * The probe never throws: an unexpected error turns it off.
 */
export class LightingProbe implements LightingProbeLike {
  private kind: LightingBackend;
  private readonly minIntervalMs: number;
  private readonly clock: () => number;
  private readonly frameFromVideo: ((video: HTMLVideoElement, timestampUs: number) => VideoFrameLike) | null;
  private readonly createCanvas: ((width: number, height: number) => Canvas2DLike | null) | null;

  private lastAt = -Infinity;
  private costEma = 0.5;
  private gen = 0;
  private pending: PendingCopy | null = null;
  private copyTimeouts = 0;
  private fresh: LightingStats | null = null;
  private bufs: Uint8Array[] = [];
  private atlas: Canvas2DLike | null = null;
  private full: Canvas2DLike | null = null;
  private readonly scratch = new MeasureScratch();
  private measured = 0;
  private trial: { backend: LightingBackend; n: number; sum: number } | null = null;
  private trialCopyMs: number | null = null;
  private trialDone = false;

  constructor(opts: LightingProbeOptions = {}) {
    this.minIntervalMs = Number.isFinite(opts.minIntervalMs) && (opts.minIntervalMs ?? 0) > 0 ? (opts.minIntervalMs as number) : 150;
    this.clock = opts.clock ?? (() => performance.now());
    this.frameFromVideo = opts.frameFromVideo !== undefined ? opts.frameFromVideo : defaultFrameFromVideo() ?? null;
    this.createCanvas = opts.createCanvas !== undefined ? opts.createCanvas : defaultCreateCanvas() ?? null;
    const want = opts.backend ?? 'auto';
    if (want === 'auto') this.kind = typeof VideoFrame === 'function' ? 'copy' : this.createCanvas ? 'canvas' : 'off';
    else this.kind = want === 'canvas' && !this.createCanvas ? 'off' : want;
  }

  get backend(): LightingBackend {
    return this.kind;
  }

  /** EMA of the main-thread cost of one measurement, ms. */
  get costMs(): number {
    return this.costEma;
  }

  /** Current minimum time between measurements (the governor lengthens it when measuring is slow). */
  get intervalMs(): number {
    for (const [cost, interval] of GOVERNOR_STEPS) if (this.costEma > cost) return Math.max(interval, this.minIntervalMs);
    return this.minIntervalMs;
  }

  /** Whether the one-time backend choice is settled. */
  get backendSettled(): boolean {
    return this.trialDone || this.kind === 'off';
  }

  /** Measurements completed so far (for diagnostics). */
  get measurements(): number {
    return this.measured;
  }

  maybeMeasure(
    source: LightingSource,
    landmarks: readonly LandmarkPoint[],
    features: EyeFeatures | null,
    quality: number,
    t: number,
  ): void {
    if (this.kind === 'off') return;
    if (this.pending) {
      // Frame-driven safety net (timers are throttled in hidden documents).
      if (t - this.pending.startedAt >= PROBE_SAFETY_CLOSE_MS) this.abandon(this.pending.gen);
      return;
    }
    if (t - this.lastAt < this.intervalMs) return;
    if (!features || !(features.blink < PROBE_MAX_BLINK) || !(quality >= PROBE_MIN_QUALITY)) return;
    try {
      this.measure(source, landmarks, t);
    } catch (err) {
      this.turnOff(err);
    }
  }

  take(): LightingStats | undefined {
    const s = this.fresh;
    if (!s) return undefined;
    this.fresh = null;
    return s;
  }

  reset(): void {
    if (this.pending) this.abandon(this.pending.gen, false);
    this.fresh = null;
    this.lastAt = -Infinity;
  }

  dispose(): void {
    this.reset();
    this.kind = 'off';
    this.bufs = [];
    this.atlas = null;
    this.full = null;
  }

  private measure(source: LightingSource, landmarks: readonly LandmarkPoint[], t: number): void {
    const isFrame = isVideoFrameLike(source);
    let w: number;
    let h: number;
    if (isFrame) {
      const vr = source.visibleRect;
      w = vr ? vr.width : source.displayWidth;
      h = vr ? vr.height : source.displayHeight;
    } else if (isVideoElementLike(source)) {
      w = source.videoWidth;
      h = source.videoHeight;
    } else {
      return; // neither: nothing we can read
    }
    this.lastAt = t; // also rate-limits attempts on faces too small to measure
    const g = lightingGeometry(landmarks, w, h);
    if (!g) return;
    const t0 = this.clock();
    if (this.kind === 'copy' && this.startCopy(source, isFrame, landmarks, g, t, t0)) return;
    if (this.kind === 'canvas') {
      const stats = this.measureCanvas(source, isFrame, g);
      if (stats) this.deliver(stats);
      this.noteCost(this.clock() - t0, 'canvas');
    }
  }

  /**
   * Starts a copy. Returns false when this backend can't handle the source
   * (the probe has then switched to the canvas, which measures this frame).
   */
  private startCopy(source: LightingSource, isFrame: boolean, landmarks: readonly LandmarkPoint[], g0: LightingGeometry, t: number, t0: number): boolean {
    let vf: VideoFrameLike | null = null;
    try {
      if (isFrame) vf = (source as VideoFrameLike).clone();
      else if (this.frameFromVideo) vf = this.frameFromVideo(source as HTMLVideoElement, Math.round(t * 1000));
    } catch {
      vf = null;
    }
    if (!vf) return this.fallBack();
    const frame = vf;
    const kind = pixelKindOf(frame.format);
    const vr = frame.visibleRect ?? { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
    if (!kind || (vr.x & 1) !== 0 || (vr.y & 1) !== 0) {
      closeQuietly(frame);
      return this.fallBack(); // unsupported format, or a crop we can't align for 4:2:0
    }
    const geometry = vr.width === g0.frameW && vr.height === g0.frameH ? g0 : lightingGeometry(landmarks, vr.width, vr.height);
    const plan = geometry ? planCopyRects(geometry) : null;
    if (!geometry || !plan || [plan.face, ...plan.eyes].some((r) => r.w < 2 || r.h < 2)) {
      closeQuietly(frame);
      return true; // face at the very edge: skip this measurement, keep the backend
    }
    const rects = [plan.face, plan.eyes[0], plan.eyes[1], ...plan.bg];
    const inits: RectInit[] = rects.map((r) => ({ x: vr.x + r.x, y: vr.y + r.y, width: r.w, height: r.h }));
    let bufs: Uint8Array[];
    try {
      bufs = inits.map((rect, i) => this.buffer(i, frame.allocationSize({ rect })));
    } catch {
      closeQuietly(frame);
      return this.fallBack();
    }
    const gen = ++this.gen;
    const timer = setTimeout(() => this.abandon(gen), PROBE_SAFETY_CLOSE_MS);
    const pending: PendingCopy = { gen, frame, startedAt: t, timer, syncMs: 0 };
    this.pending = pending;
    let copies: Promise<readonly { offset: number; stride: number }[]>[];
    try {
      copies = inits.map((rect, i) => frame.copyTo(bufs[i], { rect }));
    } catch {
      this.abandon(gen, false);
      return this.fallBack();
    }
    // Read everything we need from the frame now: a closed VideoFrame reports format null.
    const fullRange = frame.colorSpace?.fullRange;
    const format = frame.format;
    const yLut = yTableFor(fullRange);
    const cLut = chromaTableFor(fullRange);
    Promise.all(copies).then(
      (layouts) => {
        if (this.pending !== pending) return; // abandoned: the clone is closed and the buffers are no longer ours
        this.finishPending(gen);
        const c0 = this.clock();
        const view = (i: number): PixelView => {
          const r = rects[i];
          const pl = layouts[i]?.[0];
          const base = { data: bufs[i], offset: pl?.offset ?? 0, stride: pl?.stride ?? (kind === 'y' ? r.w : 4 * r.w), w: r.w, h: r.h, x0: r.x, y0: r.y, kind };
          const chroma = kind === 'y' ? chromaOf(format, layouts[i], cLut) : null;
          return chroma ? { ...base, chroma } : base;
        };
        let stats: LightingStats | null;
        try {
          stats = measureViews(geometry, { face: view(0), eyes: [view(1), view(2)], bg: rects.slice(3).map((_, j) => view(3 + j)) }, yLut, this.scratch);
        } catch (err) {
          this.turnOff(err);
          return;
        }
        this.copyTimeouts = 0;
        if (stats) this.deliver(stats);
        this.noteCost(pending.syncMs + (this.clock() - c0), 'copy');
      },
      () => {
        if (this.pending !== pending) return;
        this.finishPending(gen);
        this.noteCost(pending.syncMs, null);
        this.fallBack(); // the format or this kind of frame isn't copyable here
      },
    );
    pending.syncMs = this.clock() - t0;
    return true;
  }

  /** Closes the in-flight clone (idempotent per generation). */
  private finishPending(gen: number): void {
    const p = this.pending;
    if (!p || p.gen !== gen) return;
    clearTimeout(p.timer);
    this.pending = null;
    closeQuietly(p.frame);
  }

  /** Gives up on an in-flight copy: closes the clone, ignores its result, and never reuses its buffers. */
  private abandon(gen: number, countTimeout = true): void {
    const p = this.pending;
    if (!p || p.gen !== gen) return;
    this.finishPending(gen);
    this.noteCost(p.syncMs, null);
    this.gen++;
    this.bufs = []; // the late copy may still write into the old ones
    if (countTimeout && ++this.copyTimeouts >= MAX_COPY_TIMEOUTS) this.fallBack();
  }

  private fallBack(): false {
    this.kind = this.createCanvas ? 'canvas' : 'off';
    this.trial = null; // a broken fast path is never tried again
    this.trialDone = true;
    return false;
  }

  private turnOff(err: unknown): void {
    if (this.kind !== 'off') console.warn('[gaze] Lighting measurement failed; turning it off.', err);
    if (this.pending) this.abandon(this.pending.gen, false);
    this.kind = 'off';
    this.fresh = null;
  }

  private buffer(i: number, size: number): Uint8Array {
    if (!(size > 0) || !Number.isFinite(size)) throw new RangeError('bad allocation size');
    let b = this.bufs[i];
    if (!b || b.length < size) {
      b = new Uint8Array(Math.ceil(size * 1.25)); // headroom: the face rectangle changes size a little every time
      this.bufs[i] = b;
    }
    return b;
  }

  private measureCanvas(source: LightingSource, isFrame: boolean, g: LightingGeometry): LightingStats | null {
    const make = this.createCanvas;
    if (!make) {
      this.kind = 'off';
      return null;
    }
    this.atlas ??= make(ATLAS_W, ATLAS_H);
    const atlas = this.atlas;
    if (!atlas) {
      this.kind = 'off';
      return null;
    }
    let src: CanvasImageSource;
    if (isFrame) {
      // Never draw a VideoFrame several times (no conversion cache: 7–9 ms). Draw it
      // once 1:1, then build the atlas from that canvas.
      const W = g.frameW;
      const H = g.frameH;
      if (!this.full || this.full.canvas.width !== W || this.full.canvas.height !== H) this.full = make(W, H);
      const full = this.full;
      if (!full) {
        this.kind = 'off';
        return null;
      }
      // A real VideoFrame is a CanvasImageSource; VideoFrameLike only names what copyTo needs.
      full.drawImage(source as unknown as CanvasImageSource, 0, 0);
      src = full.canvas;
    } else {
      src = source as HTMLVideoElement;
    }
    const layout = atlasLayout(g);
    for (const c of [layout.face, layout.thumb, layout.eyes[0], layout.eyes[1]]) {
      atlas.drawImage(src, c.src.x, c.src.y, c.src.w, c.src.h, c.dst.x, c.dst.y, c.dst.w, c.dst.h);
    }
    return measureAtlas(atlas.getImageData(0, 0, ATLAS_W, ATLAS_H).data, g, layout, this.scratch);
  }

  private deliver(stats: LightingStats): void {
    this.fresh = stats;
    this.measured++;
  }

  /** Main-thread cost of one measurement; `backend` null for aborted ones (not representative). */
  private noteCost(ms: number, backend: LightingBackend | null): void {
    if (!(Number.isFinite(ms) && ms >= 0)) return;
    this.costEma += 0.2 * (ms - this.costEma);
    if (backend && !this.trialDone && backend === this.kind) this.trialStep(ms, backend);
  }

  /**
   * The one-time backend choice. copyTo is usually far cheaper (0.1–0.3 ms: the
   * frame is already in memory), but a GPU-backed frame makes it read back
   * synchronously (≈ 5 ms measured in Chrome 152), where the canvas atlas costs
   * less. So when copyTo costs more than TRIAL_SWITCH_MS, the canvas gets a few
   * measurements too, and the cheaper one stays for good.
   */
  private trialStep(ms: number, backend: LightingBackend): void {
    let t = this.trial;
    if (!t || t.backend !== backend) t = this.trial = { backend, n: 0, sum: 0 };
    t.n++;
    if (t.n === 1) return; // warm-up: first draws and allocations
    t.sum += ms;
    if (t.n < TRIAL_MEASUREMENTS) return;
    const mean = t.sum / (t.n - 1);
    if (backend === 'copy' && mean > TRIAL_SWITCH_MS && this.createCanvas) {
      this.trialCopyMs = mean;
      this.kind = 'canvas';
      this.trial = { backend: 'canvas', n: 0, sum: 0 };
      return;
    }
    if (backend === 'canvas' && this.trialCopyMs !== null && this.trialCopyMs < mean) this.kind = 'copy';
    this.trial = null;
    this.trialDone = true;
  }
}

// ────────────────────────────── 4. LightingMonitor ──────────────────────────────

export const LIGHTING_THRESHOLDS = Object.freeze({
  /** Sclera p85 (linear) below this: the eyes are ≥ ~2 stops under-exposed (normally 0.3–0.5). Skin-tone independent. */
  darkSclera: 0.08,
  /** Fraction of face pixels with a clipped channel. */
  overexposedClip: 0.05,
  /** log2(sclera / background): no passive background outshines the sclera 2× under the same light. */
  backlit: -1.0,
  /** …or a clipped background (a window or lamp in view) at least as bright as the sclera. */
  backlitWithClip: 0,
  bgClipForBacklit: 0.15,
  /** |log2(cheek L / cheek R)|: head pose alone stays under ~0.3. */
  sideLit: 0.75,
  /** Near-saturated fraction of either eye box: ≥ 10× a normal corneal glint. */
  glare: 0.02,
  /** Near-saturated fraction of either iris disk. */
  irisGlint: 0.15,
  /** Peak-to-peak swing (stops) of log2(frameLin) or log2(faceLin) within the window: auto-exposure hunting or light changing now. */
  unstable: 0.5,
  unstableWindowMs: 3000,
  /** Hysteresis: a flag clears only once the value is this fraction back inside its threshold. */
  release: 0.8,
  /** Smoothing time constant, ms; the average restarts after a gap of 5 of these. */
  tauMs: 1000,
});

/** Fixed display order. */
export const LIGHTING_FLAGS: readonly LightingFlag[] = Object.freeze(['dark', 'overexposed', 'glare', 'backlit', 'side-lit', 'unstable'] satisfies LightingFlag[]);

export interface LightingAssessment {
  smoothed: LightingStats;
  /** Exposure swing over the window, stops. */
  swing: number;
  flags: LightingFlag[];
}

type FlagState = Record<LightingFlag, boolean>;
const noFlags = (): FlagState => ({ dark: false, overexposed: false, glare: false, backlit: false, 'side-lit': false, unstable: false });

const SWING_CAPACITY = 64;

/** Time-based smoothing of LightingStats, an exposure-swing window, and hysteretic coaching flags. */
export class LightingMonitor {
  private ema: LightingStats | null = null;
  private lastT = 0;
  private flagState: FlagState = noFlags();
  // Exposure-swing window as a ring (no allocation per update).
  private readonly winT = new Float64Array(SWING_CAPACITY);
  private readonly winFrame = new Float64Array(SWING_CAPACITY);
  private readonly winFace = new Float64Array(SWING_CAPACITY);
  private winStart = 0;
  private winLen = 0;

  constructor(private readonly tauMs: number = LIGHTING_THRESHOLDS.tauMs) {}

  get smoothed(): Readonly<LightingStats> | null {
    return this.ema;
  }

  get flags(): LightingFlag[] {
    return LIGHTING_FLAGS.filter((f) => this.flagState[f]);
  }

  reset(): void {
    this.ema = null;
    this.winStart = 0;
    this.winLen = 0;
    this.flagState = noFlags();
  }

  update(t: number, s: LightingStats): LightingAssessment {
    if (!this.ema || !(t >= this.lastT) || t - this.lastT > 5 * this.tauMs) {
      this.ema = { ...s };
      this.winLen = 0;
    } else {
      const a = 1 - Math.exp(-(t - this.lastT) / this.tauMs);
      const e = this.ema;
      for (const k of LIGHTING_STAT_KEYS) e[k] += a * (s[k] - e[k]);
    }
    this.lastT = t;

    const T = LIGHTING_THRESHOLDS;
    // Swing window.
    while (this.winLen > 0 && t - this.winT[this.winStart] > T.unstableWindowMs) {
      this.winStart = (this.winStart + 1) % SWING_CAPACITY;
      this.winLen--;
    }
    if (this.winLen === SWING_CAPACITY) {
      this.winStart = (this.winStart + 1) % SWING_CAPACITY;
      this.winLen--;
    }
    const at = (this.winStart + this.winLen) % SWING_CAPACITY;
    this.winT[at] = t;
    this.winFrame[at] = Math.log2(s.frameLin + EPS);
    this.winFace[at] = Math.log2(s.faceLin + EPS);
    this.winLen++;
    let fMin = Infinity;
    let fMax = -Infinity;
    let cMin = Infinity;
    let cMax = -Infinity;
    for (let i = 0; i < this.winLen; i++) {
      const j = (this.winStart + i) % SWING_CAPACITY;
      fMin = Math.min(fMin, this.winFrame[j]);
      fMax = Math.max(fMax, this.winFrame[j]);
      cMin = Math.min(cMin, this.winFace[j]);
      cMax = Math.max(cMax, this.winFace[j]);
    }
    const swing = this.winLen >= 3 ? Math.max(fMax - fMin, cMax - cMin) : 0;

    const e = this.ema;
    const r = T.release;
    const f = this.flagState;
    // above: on when v > thr, held while v > thr·r.   below (thr > 0): on when v < thr, held while v < thr / r.
    const above = (on: boolean, v: number, thr: number): boolean => (on ? v > thr * r : v > thr);
    const below = (on: boolean, v: number, thr: number): boolean => (on ? v < thr / r : v < thr);
    const overexposed = above(f.overexposed, e.faceClip, T.overexposedClip);
    const backlitNow = e.backlight < T.backlit || (e.bgClip > T.bgClipForBacklit && e.backlight < T.backlitWithClip);
    const backlitHeld = e.backlight < T.backlit * r || (e.bgClip > T.bgClipForBacklit * r && e.backlight < T.backlitWithClip);
    const glareNow =
      above(f.glare, Math.max(e.glareR, e.glareL), T.glare) || above(f.glare, Math.max(e.irisGlintR, e.irisGlintL), T.irisGlint);
    this.flagState = {
      dark: below(f.dark, Math.min(e.scleraR, e.scleraL), T.darkSclera),
      overexposed,
      // An over-exposed face saturates the sclera too: that is exposure, not glare.
      glare: glareNow && !overexposed,
      backlit: f.backlit ? backlitHeld : backlitNow,
      'side-lit': above(f['side-lit'], Math.abs(e.side), T.sideLit),
      unstable: above(f.unstable, swing, T.unstable),
    };
    return { smoothed: { ...e }, swing, flags: this.flags };
  }
}

// ──────────────────────────────── 5. Signature ────────────────────────────────

export const LIGHTING_COMPONENTS: readonly LightingComponent[] = Object.freeze([
  'sclera',
  'backlight',
  'side',
  'shade',
  'glare',
  'range',
] satisfies LightingComponent[]);

/** A meaningful change per component, in its own units (stops, or glare doublings). */
export const LIGHTING_TOLERANCE: Readonly<Record<LightingComponent, number>> = Object.freeze({
  sclera: 0.75,
  backlight: 0.75,
  side: 0.5,
  shade: 0.5,
  glare: 1.0,
  range: 0.75,
});

/** Extra tolerance per degree of head-pose difference: Lambertian shading moves with the head even when the light doesn't (measured ≤ 0.027 stop/°). */
export const LIGHTING_POSE_SLACK_PER_DEG = Object.freeze({ side: 0.03, shade: 0.03 });

/** A glint of ~0.5 % of the eye box is normal (the corneal reflection); glare counts doublings beyond it. */
const GLARE_REF = 0.005;
const DEG = 180 / Math.PI;

/** The six signature components of one measurement. All ratios: no absolute face level (skin tone) is used. */
export function lightingSignatureVector(s: LightingStats): Record<LightingComponent, number> {
  return {
    sclera: Math.log2(0.5 * (s.scleraR + s.scleraL) + EPS),
    backlight: s.backlight,
    side: s.side,
    shade: s.shade,
    glare: Math.log2(1 + Math.max(s.glareR, s.glareL) / GLARE_REF),
    range: s.faceRange,
  };
}

export interface LightingSample {
  stats: LightingStats;
  /** Head pose (radians) when it was measured. */
  yaw: number;
  pitch: number;
}

function medianOf(xs: number[]): number {
  const a = xs.slice().sort((p, q) => p - q);
  const n = a.length;
  return n === 0 ? NaN : n % 2 ? a[(n - 1) / 2] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
}

/** Minimum samples for a signature (≈ 3 s of measurements). */
export const MIN_SIGNATURE_SAMPLES = 20;

/** Medians and robust spreads (1.4826 × MAD) of the components, plus the median head pose. Null with too few usable samples. */
export function buildLightingSignature(samples: readonly LightingSample[], minSamples = MIN_SIGNATURE_SAMPLES): LightingSignature | null {
  const usable = samples.filter((s) => s && s.stats && Number.isFinite(s.yaw) && Number.isFinite(s.pitch));
  if (usable.length < Math.max(1, minSamples)) return null;
  const vecs = usable.map((s) => lightingSignatureVector(s.stats));
  const c = {} as Record<LightingComponent, number>;
  const sd = {} as Record<LightingComponent, number>;
  for (const k of LIGHTING_COMPONENTS) {
    const xs = vecs.map((v) => v[k]).filter(Number.isFinite);
    if (xs.length < Math.max(1, minSamples)) return null;
    const m = medianOf(xs);
    c[k] = m;
    sd[k] = 1.4826 * medianOf(xs.map((x) => Math.abs(x - m)));
  }
  return {
    v: 1,
    n: usable.length,
    yaw: medianOf(usable.map((s) => s.yaw)),
    pitch: medianOf(usable.map((s) => s.pitch)),
    c,
    sd,
  };
}

export interface LightingComparison {
  /** sqrt(Σ z²); ≥ 1 means the lighting has changed meaningfully. */
  distance: number;
  /** The component that moved most (what to tell the reader). */
  dominant: LightingComponent;
  /** Per-component change in tolerance units (signed: current − reference). */
  z: Record<LightingComponent, number>;
}

function componentScale(k: LightingComponent, sdRef: number, sdCur: number, dYawDeg: number, dPitchDeg: number): number {
  let tau = Math.max(LIGHTING_TOLERANCE[k], 3 * Math.max(sdRef, sdCur));
  if (k === 'side') tau += LIGHTING_POSE_SLACK_PER_DEG.side * dYawDeg;
  if (k === 'shade') tau += LIGHTING_POSE_SLACK_PER_DEG.shade * dPitchDeg;
  return tau;
}

/**
 * Normalized distance between a reference (calibration) and a current
 * signature. Each component's scale is max(tolerance, 3 × the larger robust
 * spread), so a component that is naturally noisy for this reader can't trigger
 * alone; `side` and `shade` get extra slack for head-pose differences.
 */
export function compareLightingSignatures(ref: LightingSignature, cur: LightingSignature): LightingComparison {
  const dYaw = Math.abs(cur.yaw - ref.yaw) * DEG;
  const dPitch = Math.abs(cur.pitch - ref.pitch) * DEG;
  const z = {} as Record<LightingComponent, number>;
  let sum = 0;
  let dominant: LightingComponent = LIGHTING_COMPONENTS[0];
  let best = -1;
  for (const k of LIGHTING_COMPONENTS) {
    const zk = (cur.c[k] - ref.c[k]) / componentScale(k, ref.sd[k], cur.sd[k], dYaw, dPitch);
    z[k] = zk;
    sum += zk * zk;
    if (Math.abs(zk) > best) {
      best = Math.abs(zk);
      dominant = k;
    }
  }
  return { distance: Math.sqrt(sum), dominant, z };
}

/** Distance of a single measurement from a reference signature (for finding when a change began). */
export function lightingSampleDistance(ref: LightingSignature, sample: LightingSample): number {
  const v = lightingSignatureVector(sample.stats);
  const dYaw = Math.abs(sample.yaw - ref.yaw) * DEG;
  const dPitch = Math.abs(sample.pitch - ref.pitch) * DEG;
  let sum = 0;
  for (const k of LIGHTING_COMPONENTS) {
    const zk = (v[k] - ref.c[k]) / componentScale(k, ref.sd[k], 0, dYaw, dPitch);
    sum += zk * zk;
  }
  return Math.sqrt(sum);
}

const isFiniteNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Validates a stored signature; null (not an exception) when anything is off. */
export function parseLightingSignature(x: unknown): LightingSignature | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (o.v !== 1 || !isFiniteNumber(o.n) || o.n < 1 || !isFiniteNumber(o.yaw) || !isFiniteNumber(o.pitch)) return null;
  const c = o.c;
  const sd = o.sd;
  if (typeof c !== 'object' || c === null || typeof sd !== 'object' || sd === null) return null;
  const cr = c as Record<string, unknown>;
  const sr = sd as Record<string, unknown>;
  const outC = {} as Record<LightingComponent, number>;
  const outSd = {} as Record<LightingComponent, number>;
  for (const k of LIGHTING_COMPONENTS) {
    const ck = cr[k];
    const sk = sr[k];
    if (!isFiniteNumber(ck) || Math.abs(ck) > 64 || !isFiniteNumber(sk) || sk < 0 || sk > 64) return null;
    outC[k] = ck;
    outSd[k] = sk;
  }
  return { v: 1, n: o.n, yaw: o.yaw, pitch: o.pitch, c: outC, sd: outSd };
}

// ─────────────────────────────── 6. LightingWatch ───────────────────────────────

/** Screen luminances are floored here (WCAG relative luminance): even a black page lights the face a little. */
export const SCREEN_LUM_FLOOR = 0.005;

/** WCAG 2 relative luminance of an 8-bit sRGB colour: 0 (black) … 1 (white). */
export function relativeLuminance(r: number, g: number, b: number): number {
  const c = (v: number): number => SRGB_TO_LINEAR[Math.max(0, Math.min(255, Math.round(Number.isFinite(v) ? v : 0)))];
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

/** log2(current / reference) of two screen luminances (floored at SCREEN_LUM_FLOOR); 0 when either is unknown. */
export function screenStops(current: number | null | undefined, reference: number | null | undefined): number {
  if (!isFiniteNumber(current) || !isFiniteNumber(reference)) return 0;
  return Math.log2(Math.max(SCREEN_LUM_FLOOR, current) / Math.max(SCREEN_LUM_FLOOR, reference));
}

/**
 * In a lamp-lit or dim room the screen is a large share of the light on the
 * face but not on the background. A much darker or brighter page (a dark
 * theme, a dark site) then moves the sclera and back-light components (the
 * camera's auto-exposure holds the frame, so both move by the face-light ratio)
 * and the glasses' reflections, without moving the lids or the gaze bias. Such
 * a change is not reported as a lighting change on its own.
 */
export const SCREEN_EXPLAINS = Object.freeze({
  /** Screen luminance change (stops) from which the screen can explain a change: the page is 2× brighter or darker. */
  minStops: 1,
  /** Components a screen change moves; the dominant one must be among them, and move the same way as the screen. */
  components: Object.freeze(['backlight', 'sclera', 'glare']) as readonly LightingComponent[],
  /** The light's geometry must not have moved: |z| of `side` and `shade` below this. */
  maxGeometryZ: 0.5,
});

/** Whether a screen-brightness change of `stops` (current vs reference) accounts for the comparison. */
export function screenExplainsChange(cmp: LightingComparison, stops: number): boolean {
  if (!(Math.abs(stops) >= SCREEN_EXPLAINS.minStops)) return false;
  if (!SCREEN_EXPLAINS.components.includes(cmp.dominant)) return false;
  if (!(Math.abs(cmp.z.side) < SCREEN_EXPLAINS.maxGeometryZ) || !(Math.abs(cmp.z.shade) < SCREEN_EXPLAINS.maxGeometryZ)) return false;
  return Math.sign(cmp.z[cmp.dominant]) === Math.sign(stops);
}

export interface LightingWatchOptions {
  /** Rolling window of the current signature, ms (default 10 000). */
  windowMs?: number;
  /** How often the signature is recomputed, ms (default 1000). */
  tickMs?: number;
  /** Distance at which the lighting counts as changed (default 1.0)… */
  changeAt?: number;
  /** …and at or below which it counts as back to normal (default 0.7). */
  clearAt?: number;
  /** Both need to hold this long, ms (default 5000). */
  holdMs?: number;
  /**
   * Samples a current signature needs (default 20, as many as a calibration's).
   * When measurements arrive more slowly (the probe's cost governor measures
   * every 500 ms on devices where measuring is expensive), the need follows the
   * rate: 60 % of what the window holds at the median interval, but never fewer
   * than `minSamplesFloor`.
   */
  minSamples?: number;
  /** Default 12 (≈ 6 s of 2-Hz measurements): medians and MADs are still robust. */
  minSamplesFloor?: number;
  /** Flags are dropped when no measurement arrived for this long, ms (default 3000). */
  staleMs?: number;
}

export type LightingState = AppEvents['lighting-state'];

export interface LightingWatchUpdate {
  state: LightingState;
  comparison: LightingComparison | null;
  /**
   * 'changed' on the tick the lighting is judged changed since calibration,
   * 'restored' when that clears. 'changed-again': it was already changed, and
   * has now changed as much again from how it was at the last report (a lamp,
   * then the overhead light off); treat it like 'changed'.
   */
  transition: 'changed' | 'changed-again' | 'restored' | null;
  /** For 'changed' and 'changed-again': best estimate of when the change began (for the 'appearance-changed' event). */
  changedAt: number | null;
  /** While changed: the comparison with the lighting at the last report (null otherwise). */
  sinceLastChange?: LightingComparison | null;
  /** The comparison says changed, but a change of the screen's brightness accounts for it, so nothing is reported. */
  screenExplained?: boolean;
}

interface WatchSample extends LightingSample {
  t: number;
}

interface OnsetPoint {
  t: number;
  /** Distance of one measurement from the reference it is dated against. */
  d: number;
}

/** Per-measurement distances kept for dating a change. */
const ONSET_HISTORY_MS = 30_000;
const MAX_ONSET_POINTS = 400;
/** Bound on the rolling window (≈ 10 s at 25 Hz), whatever the caller's tick rate. */
const MAX_WATCH_SAMPLES = 256;
/** Fewest samples for the rolling signature at a slow measurement rate. */
export const WATCH_MIN_SAMPLES = 12;
/** Share of the window's expected samples the rolling signature needs (blinks and poor frames are skipped). */
const WATCH_SAMPLE_SHARE = 0.6;
/** A pending hold is dropped when its last evidence is older than this many windows (a long absence). */
const STALE_EVIDENCE_WINDOWS = 3;

/** Earliest time from which ≥ 70 % of measurements are "changed" (distance ≥ changeAt), within the history. */
function estimateOnset(h: readonly OnsetPoint[], now: number, changeAt: number): number {
  let far = 0;
  let onset = now;
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i].d >= changeAt) far++;
    const n = h.length - i;
    if (far / n >= 0.7 && h[i].d >= changeAt) onset = h[i].t;
    else if (n >= 10 && far / n < 0.5) break;
  }
  return onset;
}

function pushOnset(h: OnsetPoint[], p: OnsetPoint): void {
  h.push(p);
  if (h.length > MAX_ONSET_POINTS) h.splice(0, h.length - MAX_ONSET_POINTS);
}

function dropOnsetBefore(h: OnsetPoint[], cutoff: number): void {
  let k = 0;
  while (k < h.length && h[k].t < cutoff) k++;
  if (k > 0) h.splice(0, k);
}

/**
 * Compares the rolling lighting signature with the calibration's. "Changed"
 * once the distance stays ≥ 1.0 for 5 s; "restored" once it stays ≤ 0.7 for
 * 5 s. While changed it also compares with the lighting at the last report, so
 * a second change (lamp on, then the overhead light off) is reported too
 * ('changed-again'). A change the screen's brightness accounts for (see
 * SCREEN_EXPLAINS; needs `setReference(…, screenLuminance)` and
 * `setScreenLuminance`) is not reported. Also runs a LightingMonitor so one
 * object yields the whole 'lighting-state' event. Feed it every FeatureFrame;
 * call `tick` often (it recomputes at most once per `tickMs`).
 */
export class LightingWatch {
  private ref: LightingSignature | null;
  /** Page luminance at calibration, and now (null = unknown). */
  private refScreen: number | null = null;
  private screen: number | null = null;
  private readonly o: Required<LightingWatchOptions>;
  private readonly monitor = new LightingMonitor();
  private win: WatchSample[] = [];
  private onsetHistory: OnsetPoint[] = [];
  private lastTick = -Infinity;
  private lastSampleAt = -Infinity;
  private changed = false;
  private since: number | null = null;
  /** Last tick whose comparison could move the state (not screen-explained). */
  private lastEvidenceAt = -Infinity;
  /** The lighting at the last 'changed' / 'changed-again' report, while changed. */
  private trail: LightingSignature | null = null;
  private trailScreen: number | null = null;
  private trailSince: number | null = null;
  private trailEvidenceAt = -Infinity;
  private trailHistory: OnsetPoint[] = [];
  private current: LightingState = { flags: [], distance: null, changedSinceCalibration: false, dominant: null };
  private lastCmp: LightingComparison | null = null;
  private lastTrailCmp: LightingComparison | null = null;

  constructor(reference: LightingSignature | null = null, opts: LightingWatchOptions = {}) {
    this.ref = reference;
    this.o = {
      windowMs: opts.windowMs ?? 10_000,
      tickMs: opts.tickMs ?? 1000,
      changeAt: opts.changeAt ?? 1.0,
      clearAt: opts.clearAt ?? 0.7,
      holdMs: opts.holdMs ?? 5000,
      minSamples: opts.minSamples ?? MIN_SIGNATURE_SAMPLES,
      minSamplesFloor: opts.minSamplesFloor ?? WATCH_MIN_SAMPLES,
      staleMs: opts.staleMs ?? 3000,
    };
  }

  get reference(): LightingSignature | null {
    return this.ref;
  }

  /**
   * A new calibration (or none): the comparison starts over. `screenLuminance`:
   * relative luminance of the page background while calibrating, when known.
   */
  setReference(ref: LightingSignature | null, screenLuminance: number | null = null): void {
    this.ref = ref;
    this.refScreen = isFiniteNumber(screenLuminance) ? screenLuminance : null;
    this.changed = false;
    this.since = null;
    this.lastEvidenceAt = -Infinity;
    this.clearTrail();
    this.onsetHistory = [];
    this.lastTick = -Infinity;
    this.lastCmp = null;
    this.current = { ...this.current, distance: null, changedSinceCalibration: false, dominant: null };
  }

  /**
   * Relative luminance (WCAG, 0..1) of the page background on screen now; null
   * when unknown. Call it on start and whenever the page or the theme changes.
   */
  setScreenLuminance(luminance: number | null): void {
    this.screen = isFiniteNumber(luminance) ? luminance : null;
  }

  /** Screen brightness now vs at calibration, stops (0 when either is unknown). */
  get screenChangeStops(): number {
    return screenStops(this.screen, this.refScreen);
  }

  get state(): LightingState {
    return this.current;
  }

  get lastComparison(): LightingComparison | null {
    return this.lastCmp;
  }

  /** While changed: the latest comparison with the lighting at the last report. */
  get lastComparisonSinceChange(): LightingComparison | null {
    return this.lastTrailCmp;
  }

  /** The current rolling signature (null until enough samples). */
  currentSignature(): LightingSignature | null {
    return buildLightingSignature(this.win, this.samplesNeeded());
  }

  onFrame(frame: FeatureFrame): void {
    const s = frame.lighting;
    const f = frame.features;
    if (!s || !f || !Number.isFinite(frame.t)) return;
    const sample: WatchSample = { t: frame.t, stats: s, yaw: f.headPose.yaw, pitch: f.headPose.pitch };
    this.win.push(sample);
    if (this.win.length > MAX_WATCH_SAMPLES) this.win.splice(0, this.win.length - MAX_WATCH_SAMPLES); // tick() not called for a while
    this.lastSampleAt = frame.t;
    this.monitor.update(frame.t, s);
    if (this.ref) pushOnset(this.onsetHistory, { t: frame.t, d: lightingSampleDistance(this.ref, sample) });
    if (this.trail) pushOnset(this.trailHistory, { t: frame.t, d: lightingSampleDistance(this.trail, sample) });
  }

  reset(): void {
    this.win = [];
    this.onsetHistory = [];
    this.monitor.reset();
    this.changed = false;
    this.since = null;
    this.lastEvidenceAt = -Infinity;
    this.clearTrail();
    this.lastTick = -Infinity;
    this.lastSampleAt = -Infinity;
    this.lastCmp = null;
    this.current = { flags: [], distance: null, changedSinceCalibration: false, dominant: null };
  }

  tick(now: number): LightingWatchUpdate | null {
    if (now - this.lastTick < this.o.tickMs) return null;
    this.lastTick = now;
    const o = this.o;
    const cutoff = now - o.windowMs;
    let drop = 0;
    while (drop < this.win.length && this.win[drop].t < cutoff) drop++;
    if (drop > 0) this.win.splice(0, drop);
    dropOnsetBefore(this.onsetHistory, now - ONSET_HISTORY_MS);
    dropOnsetBefore(this.trailHistory, now - ONSET_HISTORY_MS);

    const cur = this.ref ? buildLightingSignature(this.win, this.samplesNeeded()) : null;
    const cmp = this.ref && cur ? compareLightingSignatures(this.ref, cur) : null;
    this.lastCmp = cmp;
    // A change the page's brightness accounts for is no evidence either way: the state holds.
    const explained = cmp !== null && cmp.distance >= o.changeAt && screenExplainsChange(cmp, this.screenChangeStops);
    let transition: LightingWatchUpdate['transition'] = null;
    let changedAt: number | null = null;
    if (cmp && cur && !explained) {
      this.lastEvidenceAt = now;
      const wantChanged = this.changed ? cmp.distance > o.clearAt : cmp.distance >= o.changeAt;
      if (wantChanged !== this.changed) {
        this.since ??= now;
        if (now - this.since >= o.holdMs) {
          this.changed = wantChanged;
          this.since = null;
          if (wantChanged) {
            transition = 'changed';
            changedAt = estimateOnset(this.onsetHistory, now, o.changeAt);
            // The window now holds the new light only (≈ 5 s for the rolling median to cross, + 5 s of hold).
            this.freezeTrail(cur);
          } else {
            transition = 'restored';
            this.clearTrail();
          }
        }
      } else {
        this.since = null; // contrary evidence
      }
    }
    // Without a comparison (too few samples) the pending hold is kept, unless its evidence is long gone.
    if (this.since !== null && now - this.lastEvidenceAt > STALE_EVIDENCE_WINDOWS * o.windowMs) this.since = null;

    let sinceLast: LightingComparison | null = null;
    if (this.changed && this.trail && cur && cmp && transition === null) {
      sinceLast = compareLightingSignatures(this.trail, cur);
      const trailExplained = sinceLast.distance >= o.changeAt && screenExplainsChange(sinceLast, screenStops(this.screen, this.trailScreen));
      if (!trailExplained) {
        this.trailEvidenceAt = now;
        // Changed again: far from the last report's light, and still not back to the calibration's.
        if (sinceLast.distance >= o.changeAt && cmp.distance > o.clearAt) {
          this.trailSince ??= now;
          if (now - this.trailSince >= o.holdMs) {
            transition = 'changed-again';
            changedAt = estimateOnset(this.trailHistory, now, o.changeAt);
            this.freezeTrail(cur);
          }
        } else {
          this.trailSince = null;
        }
      }
      if (this.trailSince !== null && now - this.trailEvidenceAt > STALE_EVIDENCE_WINDOWS * o.windowMs) this.trailSince = null;
    }
    this.lastTrailCmp = this.changed ? sinceLast : null;

    const fresh = now - this.lastSampleAt <= o.staleMs;
    this.current = {
      flags: fresh ? this.monitor.flags : [],
      distance: cmp ? Math.round(cmp.distance * 1000) / 1000 : null,
      changedSinceCalibration: this.changed,
      dominant: this.changed && cmp ? cmp.dominant : null,
    };
    return { state: this.current, comparison: cmp, transition, changedAt, sinceLastChange: this.lastTrailCmp, screenExplained: explained };
  }

  /**
   * Samples the rolling signature needs: `minSamples` at the usual rate, fewer
   * when the probe measures less often (60 % of what the window holds at the
   * median interval, at least `minSamplesFloor`).
   */
  private samplesNeeded(): number {
    const o = this.o;
    const w = this.win;
    if (w.length < 3) return o.minSamples;
    const gaps: number[] = [];
    for (let i = 1; i < w.length; i++) gaps.push(w[i].t - w[i - 1].t);
    const gap = Math.max(1, medianOf(gaps));
    return Math.min(o.minSamples, Math.max(o.minSamplesFloor, Math.floor((WATCH_SAMPLE_SHARE * o.windowMs) / gap)));
  }

  private freezeTrail(sig: LightingSignature): void {
    this.trail = sig;
    this.trailScreen = this.screen;
    this.trailSince = null;
    this.trailEvidenceAt = -Infinity;
    this.trailHistory = [];
  }

  private clearTrail(): void {
    this.trail = null;
    this.trailScreen = null;
    this.trailSince = null;
    this.trailEvidenceAt = -Infinity;
    this.trailHistory = [];
    this.lastTrailCmp = null;
  }
}
