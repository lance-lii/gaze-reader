/**
 * A small convolutional network that reads the direction of gaze from pictures of the two eyes:
 * an optional first stage of the calibration, like the shared linear model (gazePrior.ts), but
 * looking at the pixels instead of at the face tracker's landmarks.
 *
 * This file is the whole of it at run time: cutting the two eye pictures out of a camera frame,
 * and the forward pass. Both are plain arithmetic on typed arrays, so they run the same in a Web
 * Worker (eyeNetWorker.ts, where the app runs them), in Node (the scoreboards) and in tests.
 * Training is scripts/research/train_eye_cnn.py, which writes the weights this reads.
 *
 * No weights ship with the app. The only ones so far are fitted on the EOTT dataset, which is
 * GPLv3 (docs/REAL_DATA.md); a reader who has trained or been given a weights file loads it in
 * Settings.
 */
import type { Point } from '../types';

/** The weights file, as train_eye_cnn.py writes it. */
export interface EyeNetWeights {
  /** Names the fit: stored with a calibration made on it. */
  id: string;
  eye: { height: number; width: number; span: number; contrastFloor: number };
  /** What the network is given besides the pictures: 'eyes', 'eyes+head' or 'eyes+head+tracker'. */
  inputs: string;
  /** 3×3 convolutions (weights [out][in][3][3]), each followed by ReLU and, where `pool`, a 2×2 max. */
  convs: { in: number; out: number; pool: boolean; w: number[]; b: number[] }[];
  /** Fully connected layers (weights [out][in]); ReLU between them, none after the last. */
  dense: { in: number; out: number; w: number[]; b: number[] }[];
  extraMean: number[];
  extraSd: number[];
  labelMean: number[];
  labelSd: number[];
}

export interface EyeNet {
  id: string;
  height: number;
  width: number;
  /** An eye picture is this many times as wide as the eye is from corner to corner. */
  span: number;
  contrastFloor: number;
  /** How many numbers besides the pictures (0, 5: the head, or 7: the head and the linear model's answer). */
  extras: number;
  convs: { cin: number; cout: number; pool: boolean; w: Float32Array; b: Float32Array }[];
  dense: { nin: number; nout: number; w: Float32Array; b: Float32Array }[];
  extraMean: Float32Array;
  extraSd: Float32Array;
  labelMean: [number, number];
  labelSd: [number, number];
  /** Scratch for the forward pass: two buffers as large as the largest layer. */
  bufA: Float32Array;
  bufB: Float32Array;
  /** A layer's input with a border of zeros round every channel. */
  pad: Float32Array;
  feat: Float32Array;
}

/** Face-mesh landmarks of each eye's corners, as the camera sees them: (the one on the left, the one on the right, mirrored?). */
export const EYE_CORNERS: readonly (readonly [number, number, boolean])[] = [
  [33, 133, false],
  // The second eye is mirrored, so that in both pictures the nose is on the right.
  [362, 263, true],
];

const MAX_NUMBERS = 2_000_000;

const numbers = (x: unknown, length: number): Float32Array | null => {
  if (!Array.isArray(x) || x.length !== length) return null;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const v = x[i] as unknown;
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[i] = v;
  }
  return out;
};

const count = (x: unknown, max: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= max;

/** Untrusted JSON (a file the reader chose) → a network ready to run, or null when anything about it is off. */
export function resolveEyeNet(json: unknown): EyeNet | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const r = json as Partial<EyeNetWeights>;
  const eye = r.eye;
  if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > 80 || !eye || typeof eye !== 'object') return null;
  if (!count(eye.height, 128) || !count(eye.width, 128)) return null;
  if (typeof eye.span !== 'number' || !(eye.span > 0.5 && eye.span < 5)) return null;
  if (typeof eye.contrastFloor !== 'number' || !(eye.contrastFloor >= 0 && eye.contrastFloor < 256)) return null;
  if (!Array.isArray(r.convs) || r.convs.length === 0 || r.convs.length > 8 || !Array.isArray(r.dense) || r.dense.length === 0 || r.dense.length > 4) return null;

  let total = 0;
  let c = 1;
  let h = eye.height;
  let w = eye.width;
  let largest = h * w;
  const convs: EyeNet['convs'] = [];
  for (const layer of r.convs) {
    if (!layer || typeof layer !== 'object' || layer.in !== c || !count(layer.out, 256)) return null;
    total += layer.out * c * 9;
    if (total > MAX_NUMBERS) return null;
    const weights = numbers(layer.w, layer.out * c * 9);
    const bias = numbers(layer.b, layer.out);
    if (!weights || !bias) return null;
    largest = Math.max(largest, layer.out * h * w);
    convs.push({ cin: c, cout: layer.out, pool: layer.pool === true, w: weights, b: bias });
    c = layer.out;
    if (layer.pool === true) {
      h = Math.floor(h / 2);
      w = Math.floor(w / 2);
      if (h < 1 || w < 1) return null;
    }
  }
  const extraMean = Array.isArray(r.extraMean) ? numbers(r.extraMean, r.extraMean.length) : null;
  const extraSd = extraMean ? numbers(r.extraSd, extraMean.length) : null;
  if (!extraMean || !extraSd || extraMean.length > 16 || extraSd.some((s) => !(s > 0))) return null;
  let n = 2 * c + extraMean.length;
  const dense: EyeNet['dense'] = [];
  for (const layer of r.dense) {
    if (!layer || typeof layer !== 'object' || layer.in !== n || !count(layer.out, 1024)) return null;
    total += layer.out * n;
    if (total > MAX_NUMBERS) return null;
    const weights = numbers(layer.w, layer.out * n);
    const bias = numbers(layer.b, layer.out);
    if (!weights || !bias) return null;
    dense.push({ nin: n, nout: layer.out, w: weights, b: bias });
    n = layer.out;
  }
  const labelMean = numbers(r.labelMean, 2);
  const labelSd = numbers(r.labelSd, 2);
  if (n !== 2 || !labelMean || !labelSd || !(labelSd[0] > 0) || !(labelSd[1] > 0)) return null;
  const widest = Math.max(2 * c + extraMean.length, ...dense.map((d) => d.nout));
  return {
    id: r.id,
    height: eye.height,
    width: eye.width,
    span: eye.span,
    contrastFloor: eye.contrastFloor,
    extras: extraMean.length,
    convs,
    dense,
    extraMean,
    extraSd,
    labelMean: [labelMean[0], labelMean[1]],
    labelSd: [labelSd[0], labelSd[1]],
    bufA: new Float32Array(largest),
    bufB: new Float32Array(largest),
    pad: new Float32Array(paddedSize(eye.height, eye.width, convs)),
    feat: new Float32Array(2 * widest),
  };
}

/**
 * A picture of one eye out of a grey frame: turned so the eye's corners are level, scaled so the
 * eye fills the same share of it whatever the distance, in the frame's own brightness. Written to
 * `out` at `offset` (width × height bytes, rows first). The same picture extract_eott.py cuts for
 * training: any change here has to be made there.
 *
 * @param ax,ay,bx,by the eye's two corners in frame pixels. The picture's rows run from the first
 *   towards the second, or the other way when `mirror` is set; up stays up either way.
 *   Pixel (i, j) of the picture is the frame at centre + s·((i − W/2)·u + (j − H/2)·v).
 */
export function cropEye(
  gray: ArrayLike<number>,
  frameWidth: number,
  frameHeight: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  mirror: boolean,
  net: Pick<EyeNet, 'width' | 'height' | 'span'>,
  out: Uint8Array,
  offset = 0,
): boolean {
  const W = net.width;
  const H = net.height;
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy);
  if (!(length > 1e-6) || !Number.isFinite(length) || frameWidth < 2 || frameHeight < 2) return false;
  const s = (net.span * length) / W; // frame px per picture px
  let ux = dx / length; // the picture's x axis in the frame
  let uy = dy / length;
  const vx = -uy; // and its y axis: down
  const vy = ux;
  if (mirror) {
    ux = -ux;
    uy = -uy;
  }
  const cx = (ax + bx) / 2;
  const cy = (ay + by) / 2;
  const x0 = cx - s * ((ux * W) / 2 + (vx * H) / 2);
  const y0 = cy - s * ((uy * W) / 2 + (vy * H) / 2);
  const maxX = frameWidth - 1;
  const maxY = frameHeight - 1;
  let o = offset;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      // Past the frame's edge the edge repeats.
      const x = Math.min(maxX, Math.max(0, x0 + s * (ux * i + vx * j)));
      const y = Math.min(maxY, Math.max(0, y0 + s * (uy * i + vy * j)));
      const xi = Math.min(maxX - 1, Math.floor(x));
      const yi = Math.min(maxY - 1, Math.floor(y));
      const fx = x - xi;
      const fy = y - yi;
      const p = yi * frameWidth + xi;
      const top = gray[p] + (gray[p + 1] - gray[p]) * fx;
      const bottom = gray[p + frameWidth] + (gray[p + frameWidth + 1] - gray[p + frameWidth]) * fx;
      out[o++] = Math.round(top + (bottom - top) * fy);
    }
  }
  return true;
}

/** Both eye pictures of a frame, one after the other, from face-mesh landmarks (normalized 0..1). False when an eye has no corners. */
export function cropEyes(
  gray: ArrayLike<number>,
  frameWidth: number,
  frameHeight: number,
  landmarks: ArrayLike<{ x: number; y: number }>,
  net: Pick<EyeNet, 'width' | 'height' | 'span'>,
  out: Uint8Array,
): boolean {
  const size = net.width * net.height;
  if (out.length < 2 * size) return false;
  for (let e = 0; e < 2; e++) {
    const [a, b, mirror] = EYE_CORNERS[e];
    const pa = landmarks[a];
    const pb = landmarks[b];
    if (!pa || !pb) return false;
    if (!cropEye(gray, frameWidth, frameHeight, pa.x * frameWidth, pa.y * frameHeight, pb.x * frameWidth, pb.y * frameHeight, mirror, net, out, e * size)) return false;
  }
  return true;
}

/** RGBA pixels (a canvas's ImageData) → grey, with the weights video uses (BT.601). */
export function toGray(rgba: ArrayLike<number>, out: Uint8Array): Uint8Array {
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = (0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2] + 0.5) | 0;
  return out;
}

/** Room for the largest layer input once each channel has a one-pixel border. */
function paddedSize(height: number, width: number, convs: readonly { cin: number; pool: boolean }[]): number {
  let h = height;
  let w = width;
  let most = 0;
  for (const layer of convs) {
    most = Math.max(most, layer.cin * (h + 2) * (w + 2));
    if (layer.pool) {
      h = Math.floor(h / 2);
      w = Math.floor(w / 2);
    }
  }
  return most;
}

/** One eye picture through the convolutions: `net.convs.at(-1).cout` numbers written to `net.feat` at `at`. */
function eyeFeatures(net: EyeNet, eyes: ArrayLike<number>, offset: number, at: number): void {
  let h = net.height;
  let w = net.width;
  const n = h * w;
  let a = net.bufA;
  let b = net.bufB;
  // The picture at zero mean and unit contrast: a brighter or dimmer room is the same input.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += eyes[offset + i];
  mean /= n;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (eyes[offset + i] - mean) ** 2;
  const scale = 1 / (Math.sqrt(ss / (n - 1)) + net.contrastFloor);
  for (let i = 0; i < n; i++) a[i] = (eyes[offset + i] - mean) * scale;

  const pad = net.pad;
  for (const layer of net.convs) {
    const size = h * w;
    // The input with zeros round it, so that the nine taps of every pixel are read without asking where the edge is.
    const pw = w + 2;
    const psize = (h + 2) * pw;
    pad.fill(0, 0, layer.cin * psize);
    for (let c = 0; c < layer.cin; c++) {
      for (let y = 0; y < h; y++) pad.set(a.subarray(c * size + y * w, c * size + y * w + w), c * psize + (y + 1) * pw + 1);
    }
    const lw = layer.w;
    for (let o = 0; o < layer.cout; o++) {
      const dst = o * size;
      b.fill(layer.b[o], dst, dst + size);
      for (let c = 0; c < layer.cin; c++) {
        const k = (o * layer.cin + c) * 9;
        const w0 = lw[k];
        const w1 = lw[k + 1];
        const w2 = lw[k + 2];
        const w3 = lw[k + 3];
        const w4 = lw[k + 4];
        const w5 = lw[k + 5];
        const w6 = lw[k + 6];
        const w7 = lw[k + 7];
        const w8 = lw[k + 8];
        for (let y = 0; y < h; y++) {
          const d = dst + y * w;
          const r0 = c * psize + y * pw;
          const r1 = r0 + pw;
          const r2 = r1 + pw;
          // The window's left two columns are carried over from the pixel before: three reads a
          // pixel instead of nine. The sum is added up in the same order as with nine reads.
          let a0 = pad[r0], a1 = pad[r0 + 1];
          let b0 = pad[r1], b1 = pad[r1 + 1];
          let c0 = pad[r2], c1 = pad[r2 + 1];
          for (let x = 0; x < w; x++) {
            const a2 = pad[r0 + x + 2];
            const b2 = pad[r1 + x + 2];
            const c2 = pad[r2 + x + 2];
            b[d + x] +=
              w0 * a0 + w1 * a1 + w2 * a2 +
              w3 * b0 + w4 * b1 + w5 * b2 +
              w6 * c0 + w7 * c1 + w8 * c2;
            a0 = a1;
            a1 = a2;
            b0 = b1;
            b1 = b2;
            c0 = c1;
            c1 = c2;
          }
        }
      }
    }
    const total = layer.cout * size;
    for (let i = 0; i < total; i++) if (b[i] < 0) b[i] = 0;
    [a, b] = [b, a];
    if (layer.pool) {
      const h2 = Math.floor(h / 2);
      const w2 = Math.floor(w / 2);
      for (let c = 0; c < layer.cout; c++) {
        for (let y = 0; y < h2; y++) {
          const s = c * size + 2 * y * w;
          const d = c * h2 * w2 + y * w2;
          for (let x = 0; x < w2; x++) {
            const p = s + 2 * x;
            b[d + x] = Math.max(a[p], a[p + 1], a[p + w], a[p + w + 1]);
          }
        }
      }
      [a, b] = [b, a];
      h = h2;
      w = w2;
    }
  }
  const last = net.convs[net.convs.length - 1].cout;
  const size = h * w;
  for (let c = 0; c < last; c++) {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += a[c * size + i];
    net.feat[at + c] = sum / size;
  }
}

/**
 * The network's answer for one frame: which way the eyes point as seen from the camera, as
 * (how far across, how far down) ÷ distance. Not yet a place on anyone's screen: a reader's own
 * calibration turns it into one.
 *
 * @param eyes the two eye pictures, one after the other ({@link cropEyes})
 * @param extra the other inputs ({@link eyeNetExtras}); ignored by a network that takes none
 */
export function runEyeNet(net: EyeNet, eyes: ArrayLike<number>, extra: ArrayLike<number> | null): Point | null {
  const n = net.width * net.height;
  if (eyes.length < 2 * n) return null;
  const c = net.convs[net.convs.length - 1].cout;
  eyeFeatures(net, eyes, 0, 0);
  eyeFeatures(net, eyes, n, c);
  let length = 2 * c;
  if (net.extras > 0) {
    if (!extra || extra.length < net.extras) return null;
    for (let i = 0; i < net.extras; i++) {
      const v = extra[i];
      if (!Number.isFinite(v)) return null;
      net.feat[length + i] = (v - net.extraMean[i]) / net.extraSd[i];
    }
    length += net.extras;
  }
  let x: Float32Array = net.feat.subarray(0, length);
  let y: Float32Array = net.bufA;
  for (let l = 0; l < net.dense.length; l++) {
    const layer = net.dense[l];
    const lastLayer = l === net.dense.length - 1;
    for (let o = 0; o < layer.nout; o++) {
      let sum = layer.b[o];
      const k = o * layer.nin;
      for (let i = 0; i < layer.nin; i++) sum += layer.w[k + i] * x[i];
      y[o] = lastLayer || sum > 0 ? sum : 0;
    }
    x = y.subarray(0, layer.nout);
    y = y === net.bufA ? net.bufB : net.bufA;
  }
  const gx = x[0] * net.labelSd[0] + net.labelMean[0];
  const gy = x[1] * net.labelSd[1] + net.labelMean[1];
  return Number.isFinite(gx) && Number.isFinite(gy) ? { x: gx, y: gy } : null;
}

/**
 * The inputs besides the pictures, from the app's feature vector: the head's three angles and
 * where the face is in the camera's view (and, for a network trained with it, the linear model's
 * answer, which the caller appends).
 */
export function eyeNetExtras(vector: ArrayLike<number>, index: Readonly<Record<'yaw' | 'pitch' | 'roll' | 'tx' | 'ty' | 'tz', number>>): number[] {
  const tz = vector[index.tz];
  return [vector[index.yaw], vector[index.pitch], vector[index.roll], vector[index.tx] / tz, vector[index.ty] / tz];
}

/** A rectangle of whole frame pixels. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The four corners of each eye, in frame pixels: (ax, ay, bx, by) for the first eye, then the second. Null when a landmark is missing. */
export function eyeCorners(landmarks: ArrayLike<{ x: number; y: number }>, frameWidth: number, frameHeight: number): number[] | null {
  const out: number[] = [];
  for (const [a, b] of EYE_CORNERS) {
    const pa = landmarks[a];
    const pb = landmarks[b];
    if (!pa || !pb) return null;
    out.push(pa.x * frameWidth, pa.y * frameHeight, pb.x * frameWidth, pb.y * frameHeight);
  }
  return out.every(Number.isFinite) ? out : null;
}

/**
 * The part of the frame both eye pictures are cut from, so that only it has to leave the main
 * thread. Cutting from it gives the same pictures as cutting from the whole frame: it covers both
 * with room to spare, and where the frame's edge cuts it short the edge repeats either way.
 * Null when the eyes are not in the frame at all.
 */
export function eyeRegion(corners: ArrayLike<number>, frameWidth: number, frameHeight: number, net: Pick<EyeNet, 'width' | 'height' | 'span'>): PixelRect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let e = 0; e < 2; e++) {
    const ax = corners[4 * e];
    const ay = corners[4 * e + 1];
    const bx = corners[4 * e + 2];
    const by = corners[4 * e + 3];
    const length = Math.hypot(bx - ax, by - ay);
    if (!(length > 1e-6) || !Number.isFinite(length)) return null;
    // Half the picture's diagonal, in frame pixels: enough whichever way the eye is turned.
    const s = (net.span * length) / net.width;
    const reach = (s * Math.hypot(net.width, net.height)) / 2 + 2;
    const cx = (ax + bx) / 2;
    const cy = (ay + by) / 2;
    x0 = Math.min(x0, cx - reach);
    y0 = Math.min(y0, cy - reach);
    x1 = Math.max(x1, cx + reach);
    y1 = Math.max(y1, cy + reach);
  }
  const x = Math.max(0, Math.floor(x0));
  const y = Math.max(0, Math.floor(y0));
  const width = Math.min(frameWidth, Math.ceil(x1)) - x;
  const height = Math.min(frameHeight, Math.ceil(y1)) - y;
  return width >= 2 && height >= 2 ? { x, y, width, height } : null;
}

/**
 * From the pixels of an {@link eyeRegion} to the network's answer: what the worker does with each
 * frame. `corners` are in the region's own pixels (the frame's, less the region's corner).
 *
 * @param scratch at least `width × height` bytes for the grey picture, then two eye pictures
 */
export function answerForRegion(
  net: EyeNet,
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  corners: ArrayLike<number>,
  extra: ArrayLike<number> | null,
  scratch?: { gray: Uint8Array; eyes: Uint8Array },
): Point | null {
  const size = net.width * net.height;
  if (!(width >= 2 && height >= 2) || rgba.length < 4 * width * height || corners.length < 8) return null;
  const gray = scratch && scratch.gray.length >= width * height ? scratch.gray.subarray(0, width * height) : new Uint8Array(width * height);
  const eyes = scratch && scratch.eyes.length >= 2 * size ? scratch.eyes : new Uint8Array(2 * size);
  toGray(rgba, gray);
  for (let e = 0; e < 2; e++) {
    const ok = cropEye(gray, width, height, corners[4 * e], corners[4 * e + 1], corners[4 * e + 2], corners[4 * e + 3], EYE_CORNERS[e][2], net, eyes, e * size);
    if (!ok) return null;
  }
  return runEyeNet(net, eyes, extra);
}
