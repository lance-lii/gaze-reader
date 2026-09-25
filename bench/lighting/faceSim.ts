/**
 * Synthetic face and eye generator for the lighting benchmarks.
 *
 * It renders what MediaPipe's Face Landmarker would report for a reader looking
 * at a point on the screen: the 478 landmarks (the ones the gaze features read
 * are modelled physically, the rest sit on an ellipse), 12 eye blendshapes and
 * the head-pose matrix. Lighting effects are applied as perturbations of those
 * outputs (lids narrowing, iris landmarks biased by a reflection, jitter, …),
 * so the real `extractEyeFeatures` → `trainGazeModel` pipeline can be asked how
 * far each one moves the predicted gaze.
 *
 * Deterministic: every random number comes from a seeded generator, and each
 * frame draws the same count whatever the perturbation, so "paired" frames
 * (same seed, different perturbation) differ only by the perturbation.
 *
 * Geometry (units cm):
 *  - Camera frame = MediaPipe's metric space: +x image-right, +y up, camera at
 *    the origin looking down −z (the face sits at tz < 0).
 *  - Head frame: +x the subject's left (image right for a frontal face), +y up,
 *    +z out of the face. Head pose R = Ry(yaw)·Rx(pitch)·Rz(roll), exactly as
 *    src/gaze/headPose.ts decodes it.
 *  - Pinhole camera 640 × 480, 60° horizontal field of view (camera.ts asks for
 *    640 × 480). Viewport 1280 × 800 CSS px at 0.024 cm/px (a ~14" laptop),
 *    its top edge 2 cm below the camera. Eyes 60 cm away, 5 cm below the camera,
 *    head pitched 4° down (a reading posture).
 *  - Each eye rotates about a centre 1.05 cm behind the iris. The lid margins
 *    sit on a 1.25 cm arc around that centre, and follow vertical gaze with
 *    gains 0.85 (upper) and 0.3 (lower), so the aperture narrows as the reader
 *    looks down, as real lids do (≈ 9.7 → 6.4 mm over 40°, Read et al. 2006).
 *    Primary-gaze aperture ≈ 10 mm.
 *
 * Blendshapes are emulated as functions of the landmarks, because MediaPipe's
 * blendshape network reads landmarks, not pixels: eyeLook* follow the iris
 * relative to the corners plus a coupling to the upper lid's drop, eyeBlink
 * follows the lid aperture (≈ 0.1 at the top of the screen, ≈ 0.45 at the
 * bottom), eyeSquint follows the lower lid rising. How MediaPipe really maps
 * a squint to these scores is the main unknown, so five "worlds" bracket it
 * (WORLDS below).
 *
 * Ported from the lighting-sensitivity investigation (gen.ts); the random draw
 * order is unchanged, so its numbers reproduce.
 */
import { extractEyeFeatures, EYE_LANDMARKS, IRIS_CONTOUR, LANDMARK_COUNT, type BlendshapeLike, type LandmarkLike } from '../../src/gaze/features';
import type { CalibrationSample, EyeFeatures, Point } from '../../src/types';

export const DEG = Math.PI / 180;

// ─────────────────────────────── Randomness ──────────────────────────────────

/** mulberry32: a small, fast, seedable PRNG returning [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draw (Box–Muller; consumes two uniforms). */
export function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

// ───────────────────────────── Camera and screen ─────────────────────────────

export const IMG_W = 640;
export const IMG_H = 480;
export const ASPECT = IMG_W / IMG_H;
const HFOV_DEG = 60;
/** Focal length, px (≈ 554). */
export const F_PX = IMG_W / 2 / Math.tan((HFOV_DEG / 2) * DEG);
export const VIEW = Object.freeze({ width: 1280, height: 800 });
/** CSS px pitch, cm. */
const PX_CM = 0.024;
/** Viewport top edge below the camera, cm. */
const VIEW_TOP_CM = 2.0;

// ─────────────────────────── Eye geometry (head frame) ───────────────────────

const HALF_IPD = 3.15;
/** Eye rotation centre, behind the corneal apex plane. */
const C_Z = -1.3;
/** Rotation centre → apparent iris centre. */
const R_IRIS = 1.05;
const IRIS_RADIUS = 0.585;
/** Lid margins lie on this radius around the rotation centre. */
const R_LID = 1.25;
/** Upper / lower lid margin angles above the rotation centre in primary gaze. */
const UP0 = 22 * DEG;
const LO0 = -26 * DEG;
/** Lid–eye coupling: how much of the eye's elevation each lid follows. */
const G_UP = 0.85;
const G_LO = 0.3;
/** Corner positions (the right eye; the left mirrors x). */
const INNER = { x: 1.7, y: -0.05, z: -1.1 };
const OUTER = { x: 4.6, y: 0.1, z: -2.0 };
/** Chin point (landmark 152), head frame. */
const CHIN = { x: 0, y: -11.5, z: -1.0 };

/** Lid aperture in primary gaze, mm (≈ 10.2). */
export const PRIMARY_APERTURE_MM = 10 * R_LID * (Math.sin(UP0) - Math.sin(LO0));

interface V3 {
  x: number;
  y: number;
  z: number;
}
const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
const add = (a: V3, b: V3): V3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub3 = (a: V3, b: V3): V3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const mul3 = (a: V3, s: number): V3 => v3(a.x * s, a.y * s, a.z * s);
const unit = (a: V3): V3 => mul3(a, 1 / Math.hypot(a.x, a.y, a.z));
const cross = (a: V3, b: V3): V3 => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

type M3 = number[][];
function matmul(a: M3, b: M3): M3 {
  const out = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[i][j] += a[i][k] * b[k][j];
  return out;
}

/** R = Ry(yaw)·Rx(pitch)·Rz(roll). */
function rotYXZ(yaw: number, pitch: number, roll: number): M3 {
  const [cy, sy, cp, sp, cr, sr] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch), Math.cos(roll), Math.sin(roll)];
  const Ry = [
    [cy, 0, sy],
    [0, 1, 0],
    [-sy, 0, cy],
  ];
  const Rx = [
    [1, 0, 0],
    [0, cp, -sp],
    [0, sp, cp],
  ];
  const Rz = [
    [cr, -sr, 0],
    [sr, cr, 0],
    [0, 0, 1],
  ];
  return matmul(matmul(Ry, Rx), Rz);
}
const apply = (R: M3, p: V3): V3 =>
  v3(R[0][0] * p.x + R[0][1] * p.y + R[0][2] * p.z, R[1][0] * p.x + R[1][1] * p.y + R[1][2] * p.z, R[2][0] * p.x + R[2][1] * p.y + R[2][2] * p.z);
const applyT = (R: M3, p: V3): V3 =>
  v3(R[0][0] * p.x + R[1][0] * p.y + R[2][0] * p.z, R[0][1] * p.x + R[1][1] * p.y + R[2][1] * p.z, R[0][2] * p.x + R[1][2] * p.y + R[2][2] * p.z);

/** Pinhole projection to image px (+y down). */
function project(p: V3): Point {
  return { x: IMG_W / 2 + (F_PX * p.x) / -p.z, y: IMG_H / 2 - (F_PX * p.y) / -p.z };
}

/** A viewport point (CSS px) in camera coordinates (cm). */
function screenPoint(X: number, Y: number): V3 {
  return v3(-(X - VIEW.width / 2) * PX_CM, -(VIEW_TOP_CM + Y * PX_CM), 0);
}

// ─────────────────────────────── Public types ────────────────────────────────

export interface Pose {
  yaw: number;
  pitch: number;
  roll: number;
  /** cm */
  tx: number;
  ty: number;
  tz: number;
}

/** Eyes 5 cm below the camera, 60 cm away, chin slightly down. */
export const BASE_POSE: Readonly<Pose> = Object.freeze({ yaw: 0, pitch: 4 * DEG, roll: 0, tx: 0, ty: -5, tz: -60 });

export type Eyes = 'both' | 'right' | 'left';

/**
 * A lighting effect, applied to the landmarks (and through them to the blendshapes). All
 * optional; `{}` is the calibration-time lighting.
 */
export interface Perturbation {
  /** Fractional lid-aperture reduction (a squint in bright light or glare; 0.1 ≈ 1 mm). */
  squint?: number;
  /** Aperture change in mm, + = wider (eyes open wider in dim light), − = narrower. */
  widenMm?: number;
  /** Share of an aperture change done by the lower lid (rest: the upper lid). Default 0.6. */
  lowerLidShare?: number;
  lidEyes?: Eyes;
  /** Top/bottom iris-contour points dragged along with the lids by this fraction (occlusion). */
  contourOcclusion?: number;
  /** Iris-centre bias from a reflection, eye widths, image axes (+x right, +y down). */
  irisBias?: { dx: number; dy: number };
  irisBiasEyes?: Eyes;
  /** Fraction of the iris bias that also hits the 4 contour points. Default 1. */
  contourBiasShare?: number;
  /** Bias of the lid landmarks alone (a lid-crease shadow), eye widths, +y down. */
  lidBias?: { upper: number; lower: number };
  /** Landmark, blendshape and pose noise multiplier (low light). */
  jitter?: number;
  /** Uniform landmark shift, normalized image units (seen as a head translation). */
  globalShift?: { dx: number; dy: number };
  /** Low-light prior dominance: iris and lid landmarks regress toward primary gaze by this fraction. */
  shrink?: number;
}

/** Tracker noise and blendshape behaviour: one "world". */
export interface NoiseSpec {
  /** Per-landmark noise SD, image px, by landmark kind. */
  irisPx: number;
  contourPx: number;
  lidPx: number;
  cornerPx: number;
  otherPx: number;
  /** Noise shared by every landmark (whole-mesh wobble), px. */
  commonPx: number;
  /** Blendshape score noise SD. */
  bs: number;
  /** Pose-matrix noise: rotation (deg) and translation (cm). */
  rotDeg: number;
  transCm: number;
  /** Blendshapes computed from the jittered landmarks (MediaPipe's network reads the same noisy points). */
  bsFromNoisy?: boolean;
  /** eyeBlink reads the whole aperture ('aperture', default) or only the upper lid's drop ('upper'). */
  blinkMode?: 'aperture' | 'upper';
  /** eyeLookDown/Up coupling to the upper lid's drop (default 1). */
  lookLidCoupling?: number;
}

export const NOMINAL_NOISE: Readonly<NoiseSpec> = Object.freeze({
  irisPx: 0.3,
  contourPx: 0.35,
  lidPx: 0.45,
  cornerPx: 0.35,
  otherPx: 0.5,
  commonPx: 0.6,
  bs: 0.02,
  rotDeg: 0.3,
  transCm: 0.1,
});

export type WorldName = 'W1' | 'W2' | 'W3' | 'W4' | 'W5';

/** Five brackets on how MediaPipe's blendshapes behave, which nobody outside Google knows exactly. */
export const WORLDS: Readonly<Record<WorldName, { label: string; noise: NoiseSpec }>> = Object.freeze({
  W1: { label: 'nominal', noise: { ...NOMINAL_NOISE } },
  W2: { label: 'noisy blendshapes (SD 0.05)', noise: { ...NOMINAL_NOISE, bs: 0.05 } },
  W3: { label: 'blendshapes from noisy landmarks', noise: { ...NOMINAL_NOISE, bs: 0.01, bsFromNoisy: true } },
  W4: { label: 'eyeBlink reads the upper lid only', noise: { ...NOMINAL_NOISE, blinkMode: 'upper' } },
  W5: { label: 'eyeLook 3x coupled to the lid', noise: { ...NOMINAL_NOISE, lookLidCoupling: 3 } },
});

export interface Frame {
  landmarks: LandmarkLike[];
  blendshapes: BlendshapeLike[];
  /** Column-major 4 × 4 pose matrix, like MediaPipe's. */
  matrix: number[];
}

// ─────────────────────────────── Landmarks ───────────────────────────────────

const R_IDX = EYE_LANDMARKS.right;
const L_IDX = EYE_LANDMARKS.left;
const MODELLED = new Set<number>([
  R_IDX.iris, R_IDX.inner, R_IDX.outer, R_IDX.upper, R_IDX.lower,
  L_IDX.iris, L_IDX.inner, L_IDX.outer, L_IDX.upper, L_IDX.lower,
  EYE_LANDMARKS.chin, ...IRIS_CONTOUR.right, ...IRIS_CONTOUR.left,
]);

type Kind = 'iris' | 'contour' | 'lid' | 'corner' | 'other';
const KIND: readonly Kind[] = Array.from({ length: LANDMARK_COUNT }, (_, i): Kind => {
  if (i === R_IDX.iris || i === L_IDX.iris) return 'iris';
  if (IRIS_CONTOUR.right.includes(i) || IRIS_CONTOUR.left.includes(i)) return 'contour';
  if ([R_IDX.upper, R_IDX.lower, L_IDX.upper, L_IDX.lower].includes(i)) return 'lid';
  if ([R_IDX.inner, R_IDX.outer, L_IDX.inner, L_IDX.outer].includes(i)) return 'corner';
  return 'other';
});

const clamp01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x);
const includesEye = (which: Eyes | undefined, side: 'right' | 'left'): boolean => (which ?? 'both') === 'both' || which === side;

interface Eye2D {
  inner: Point;
  outer: Point;
  upper: Point;
  lower: Point;
  iris: Point;
  contour: Point[];
}

/** Eye measures in the image, in the same face-aligned frame as features.ts. */
function eyeMeasures2D(e: Eye2D): { uC: number; vC: number; upperY: number; lowerY: number; aperture: number } {
  const ax = e.outer.x - e.inner.x;
  const ay = e.outer.y - e.inner.y;
  const w = Math.hypot(ax, ay);
  const ux = { x: ax / w, y: ay / w };
  let n = { x: -ux.y, y: ux.x };
  if (n.y < 0) n = { x: -n.x, y: -n.y };
  const mid = { x: (e.inner.x + e.outer.x) / 2, y: (e.inner.y + e.outer.y) / 2 };
  const d = (p: Point, o: Point, v: Point): number => ((p.x - o.x) * v.x + (p.y - o.y) * v.y) / w;
  return {
    uC: d(e.iris, e.inner, ux),
    vC: d(e.iris, mid, n),
    upperY: d(e.upper, mid, n),
    lowerY: d(e.lower, mid, n),
    aperture: d(e.lower, e.inner, n) - d(e.upper, e.inner, n),
  };
}

/** Lid heights in primary gaze at the base pose, the blendshape emulator's neutral. */
function neutralLids(): { upperY: number; lowerY: number } {
  const R = rotYXZ(BASE_POSE.yaw, BASE_POSE.pitch, BASE_POSE.roll);
  const T = v3(BASE_POSE.tx, BASE_POSE.ty, BASE_POSE.tz);
  const P = (p: V3): Point => project(add(apply(R, p), T));
  const m = eyeMeasures2D({
    inner: P(v3(-INNER.x, INNER.y, INNER.z)),
    outer: P(v3(-OUTER.x, OUTER.y, OUTER.z)),
    upper: P(v3(-HALF_IPD, R_LID * Math.sin(UP0), C_Z + R_LID * Math.cos(UP0))),
    lower: P(v3(-HALF_IPD, R_LID * Math.sin(LO0), C_Z + R_LID * Math.cos(LO0))),
    iris: P(v3(-HALF_IPD, 0, C_Z + R_IRIS)),
    contour: [],
  });
  return { upperY: m.upperY, lowerY: m.lowerY };
}
const NEUTRAL = neutralLids();

/** Random draws per frame for the blendshapes (6 scores per eye). */
const BS_NOISE_COUNT = 12;

/** Emulated eye blendshapes (ARKit naming: the subject's left eye → *Left). */
function emulateBlendshapes(right: Eye2D, left: Eye2D, noise: readonly number[], sigma: number, spec: NoiseSpec): BlendshapeLike[] {
  const out: BlendshapeLike[] = [];
  const lidK = spec.lookLidCoupling ?? 1;
  let k = 0;
  const one = (e: Eye2D, suffix: 'Left' | 'Right'): void => {
    const m = eyeMeasures2D(e);
    const lidDrop = m.upperY - NEUTRAL.upperY;
    const lowerRise = NEUTRAL.lowerY - m.lowerY;
    const push = (name: string, v: number): void => {
      out.push({ categoryName: name + suffix, score: clamp01(v + sigma * noise[k++]) });
    };
    push('eyeLookDown', 0.12 + 2.0 * m.vC + lidK * lidDrop);
    push('eyeLookUp', 0.03 - 2.0 * m.vC - lidK * lidDrop);
    push('eyeLookOut', 0.03 + 2.5 * (m.uC - 0.5));
    push('eyeLookIn', 0.03 - 2.5 * (m.uC - 0.5));
    push('eyeBlink', spec.blinkMode === 'upper' ? 0.07 + 2.4 * lidDrop : (0.36 - m.aperture) / 0.2);
    push('eyeSquint', 0.05 + 3 * Math.max(0, lowerRise));
  };
  one(left, 'Left');
  one(right, 'Right');
  return out;
}

/**
 * One tracker frame of a reader at `pose` looking at viewport point `target` (CSS px), with
 * angular gaze noise `gazeNoise` (radians) and a lighting perturbation.
 */
export function makeFrame(
  target: Point,
  pose: Pose,
  gazeNoise: { h: number; v: number },
  light: Perturbation,
  r: () => number,
  noise: NoiseSpec = NOMINAL_NOISE,
): Frame {
  // Every random number up front, so the count never depends on the perturbation.
  const lmNoise = new Float64Array(LANDMARK_COUNT * 2);
  for (let i = 0; i < lmNoise.length; i++) lmNoise[i] = gauss(r);
  const common = [gauss(r), gauss(r)];
  const bsNoise = Array.from({ length: BS_NOISE_COUNT }, () => gauss(r));
  const matNoise = Array.from({ length: 6 }, () => gauss(r));

  const jit = light.jitter ?? 1;
  const R = rotYXZ(pose.yaw, pose.pitch, pose.roll);
  const T = v3(pose.tx, pose.ty, pose.tz);
  const toCam = (p: V3): V3 => add(apply(R, p), T);
  const P = (p: V3): Point => project(toCam(p));
  const S = screenPoint(target.x, target.y);

  const px: Point[] = new Array<Point>(LANDMARK_COUNT);
  const eyes = {} as Record<'right' | 'left', Eye2D>;

  for (const side of ['right', 'left'] as const) {
    const sign = side === 'right' ? -1 : 1;
    const idx = side === 'right' ? R_IDX : L_IDX;
    const contourIdx = IRIS_CONTOUR[side];
    const ex = sign * HALF_IPD;
    const C = v3(ex, 0, C_Z);
    // Gaze direction in the head frame, plus fixation noise.
    const g0 = applyT(R, unit(sub3(S, toCam(C))));
    const th = Math.atan2(g0.x, g0.z) + gazeNoise.h;
    const tv = Math.asin(g0.y) + gazeNoise.v;
    const g = v3(Math.cos(tv) * Math.sin(th), Math.sin(tv), Math.cos(tv) * Math.cos(th));

    const iris = add(C, mul3(g, R_IRIS));
    const e1 = unit(cross(v3(0, 1, 0), g));
    const e2 = cross(g, e1);
    const contour = [0, 90, 180, 270].map((a) => add(iris, add(mul3(e1, IRIS_RADIUS * Math.cos(a * DEG)), mul3(e2, IRIS_RADIUS * Math.sin(a * DEG)))));
    const phU = UP0 + G_UP * tv;
    const phL = LO0 + G_LO * tv;
    const upper = v3(ex, R_LID * Math.sin(phU), C_Z + R_LID * Math.cos(phU));
    const lower = v3(ex, R_LID * Math.sin(phL), C_Z + R_LID * Math.cos(phL));
    const inner = v3(sign * INNER.x, INNER.y, INNER.z);
    const outer = v3(sign * OUTER.x, OUTER.y, OUTER.z);

    if (includesEye(light.lidEyes, side)) {
      // Narrowing (+) in cm: a fraction of today's aperture, and/or an absolute change.
      const delta = (light.squint ?? 0) * (upper.y - lower.y) - (light.widenMm ?? 0) / 10;
      if (delta !== 0) {
        const share = light.lowerLidShare ?? 0.6;
        upper.y -= (1 - share) * delta;
        lower.y += share * delta;
        const occ = light.contourOcclusion ?? 0;
        contour[1].y -= occ * (1 - share) * delta; // top contour point (e2 = up)
        contour[3].y += occ * share * delta; // bottom
      }
    }

    const e2d: Eye2D = { inner: P(inner), outer: P(outer), upper: P(upper), lower: P(lower), iris: P(iris), contour: contour.map(P) };
    if (light.shrink) {
      const k = light.shrink;
      const irisN = P(add(C, v3(0, 0, R_IRIS)));
      const upN = P(v3(ex, R_LID * Math.sin(UP0), C_Z + R_LID * Math.cos(UP0)));
      const loN = P(v3(ex, R_LID * Math.sin(LO0), C_Z + R_LID * Math.cos(LO0)));
      const toward = (p: Point, n: Point): Point => ({ x: n.x + (1 - k) * (p.x - n.x), y: n.y + (1 - k) * (p.y - n.y) });
      const before = e2d.iris;
      e2d.iris = toward(e2d.iris, irisN);
      e2d.contour = e2d.contour.map((c) => ({ x: c.x + e2d.iris.x - before.x, y: c.y + e2d.iris.y - before.y }));
      e2d.upper = toward(e2d.upper, upN);
      e2d.lower = toward(e2d.lower, loN);
    }
    const wPx = Math.hypot(e2d.outer.x - e2d.inner.x, e2d.outer.y - e2d.inner.y);
    if (light.irisBias && includesEye(light.irisBiasEyes, side)) {
      const bx = light.irisBias.dx * wPx;
      const by = light.irisBias.dy * wPx;
      const k = light.contourBiasShare ?? 1;
      e2d.iris = { x: e2d.iris.x + bx, y: e2d.iris.y + by };
      e2d.contour = e2d.contour.map((c) => ({ x: c.x + k * bx, y: c.y + k * by }));
    }
    if (light.lidBias) {
      e2d.upper = { x: e2d.upper.x, y: e2d.upper.y + light.lidBias.upper * wPx };
      e2d.lower = { x: e2d.lower.x, y: e2d.lower.y + light.lidBias.lower * wPx };
    }
    eyes[side] = e2d;
    px[idx.inner] = e2d.inner;
    px[idx.outer] = e2d.outer;
    px[idx.upper] = e2d.upper;
    px[idx.lower] = e2d.lower;
    px[idx.iris] = e2d.iris;
    contourIdx.forEach((i, k) => (px[i] = e2d.contour[k]));
  }

  px[EYE_LANDMARKS.chin] = P(v3(CHIN.x, CHIN.y, CHIN.z));
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    if (MODELLED.has(i)) continue;
    const a = (i / LANDMARK_COUNT) * 2 * Math.PI;
    px[i] = P(v3(7.0 * Math.cos(a), -2 + 9.5 * Math.sin(a), -3.0));
  }

  const shift = light.globalShift ?? { dx: 0, dy: 0 };
  const sigma: Record<Kind, number> = { iris: noise.irisPx, contour: noise.contourPx, lid: noise.lidPx, corner: noise.cornerPx, other: noise.otherPx };
  const noisy = px.map((p, i) => {
    const s = sigma[KIND[i]] * jit;
    return {
      x: p.x + shift.dx * IMG_W + s * lmNoise[2 * i] + noise.commonPx * jit * common[0],
      y: p.y + shift.dy * IMG_H + s * lmNoise[2 * i + 1] + noise.commonPx * jit * common[1],
    };
  });
  const landmarks: LandmarkLike[] = noisy.map((p) => ({ x: p.x / IMG_W, y: p.y / IMG_H, z: 0 }));

  const noisyEye = (idx: typeof R_IDX, contour: readonly number[]): Eye2D => ({
    inner: noisy[idx.inner],
    outer: noisy[idx.outer],
    upper: noisy[idx.upper],
    lower: noisy[idx.lower],
    iris: noisy[idx.iris],
    contour: contour.map((i) => noisy[i]),
  });
  const blendshapes = noise.bsFromNoisy
    ? emulateBlendshapes(noisyEye(R_IDX, IRIS_CONTOUR.right), noisyEye(L_IDX, IRIS_CONTOUR.left), bsNoise, noise.bs * jit, noise)
    : emulateBlendshapes(eyes.right, eyes.left, bsNoise, noise.bs * jit, noise);

  // A uniform landmark shift is what MediaPipe's geometry pipeline reads as a head translation.
  const rn = noise.rotDeg * DEG * jit;
  const Rm = rotYXZ(pose.yaw + rn * matNoise[0], pose.pitch + rn * matNoise[1], pose.roll + rn * matNoise[2]);
  const depth = -pose.tz;
  const tx = pose.tx + noise.transCm * jit * matNoise[3] + (shift.dx * IMG_W * depth) / F_PX;
  const ty = pose.ty + noise.transCm * jit * matNoise[4] - (shift.dy * IMG_H * depth) / F_PX;
  const tz = pose.tz + noise.transCm * jit * matNoise[5];
  const matrix = [Rm[0][0], Rm[1][0], Rm[2][0], 0, Rm[0][1], Rm[1][1], Rm[2][1], 0, Rm[0][2], Rm[1][2], Rm[2][2], 0, tx, ty, tz, 1];
  return { landmarks, blendshapes, matrix };
}

/** The app's feature extraction on a synthetic frame. */
export function frameFeatures(frame: Frame): EyeFeatures | null {
  return extractEyeFeatures(frame.landmarks, frame.blendshapes, frame.matrix, { aspectRatio: ASPECT });
}

// ───────────────────────────────── Sessions ──────────────────────────────────

/** The calibration overlay's 13-point grid, viewport fractions. */
export const STANDARD_TARGETS: readonly Point[] = Object.freeze([
  ...[0.08, 0.36, 0.64, 0.92].flatMap((y) => [0.1, 0.5, 0.9].map((x) => ({ x, y }))),
  { x: 0.5, y: 0.5 },
]);

/** The quick refresh's 5 targets, viewport fractions. */
export const QUICK_TARGETS: readonly Point[] = Object.freeze([
  { x: 0.5, y: 0.5 },
  { x: 0.15, y: 0.15 },
  { x: 0.85, y: 0.15 },
  { x: 0.15, y: 0.85 },
  { x: 0.85, y: 0.85 },
]);

/** The head turns a little toward what the eyes look at (≈ 5 % of the gaze shift). */
export function headFollow(target: Point, base: Pose = BASE_POSE, k = 0.05): Pose {
  const E = v3(base.tx, base.ty, base.tz);
  const angles = (p: V3): { yaw: number; pitch: number } => {
    const d = sub3(p, E);
    return { yaw: Math.atan2(d.x, d.z), pitch: Math.atan2(-d.y, d.z) };
  };
  const a = angles(screenPoint(target.x, target.y));
  const c = angles(screenPoint(VIEW.width / 2, VIEW.height / 2));
  return { ...base, yaw: base.yaw + k * (a.yaw - c.yaw), pitch: base.pitch + k * (a.pitch - c.pitch) };
}

export interface SessionOptions {
  /** Frames per target (default 34, about what the overlay keeps). */
  perTarget?: number;
  light?: Perturbation;
  noise?: NoiseSpec;
  /** Per-target fixation error SD, deg (default 0.4). */
  fixSdDeg?: number;
  /** Per-frame fixational jitter SD, deg (default 0.1). */
  jitterDeg?: number;
  /** Per-target head pose SD: deg and cm (defaults 0.3, 0.2). */
  headSdDeg?: number;
  headSdCm?: number;
  /** Viewport-fraction targets (default STANDARD_TARGETS). */
  targets?: readonly Point[];
}

/** A calibration run: frames at each target, as the overlay would collect them. */
export function calibrationSession(seed: number, o: SessionOptions = {}): CalibrationSample[] {
  const r = rng(seed);
  const out: CalibrationSample[] = [];
  const per = o.perTarget ?? 34;
  let t = 0;
  for (const tf of o.targets ?? STANDARD_TARGETS) {
    const target = { x: tf.x * VIEW.width, y: tf.y * VIEW.height };
    const fixSd = (o.fixSdDeg ?? 0.4) * DEG;
    const fix = { h: gauss(r) * fixSd, v: gauss(r) * fixSd };
    const hp = headFollow(target);
    const hd = (o.headSdDeg ?? 0.3) * DEG;
    const hc = o.headSdCm ?? 0.2;
    const head: Pose = {
      yaw: hp.yaw + hd * gauss(r),
      pitch: hp.pitch + hd * gauss(r),
      roll: hp.roll + hd * gauss(r),
      tx: hp.tx + hc * gauss(r),
      ty: hp.ty + hc * gauss(r),
      tz: hp.tz + hc * gauss(r),
    };
    for (let i = 0; i < per; i++) {
      const jd = (o.jitterDeg ?? 0.1) * DEG;
      const gn = { h: fix.h + jd * gauss(r), v: fix.v + jd * gauss(r) };
      const pose: Pose = { ...head, yaw: head.yaw + 0.05 * DEG * gauss(r), pitch: head.pitch + 0.05 * DEG * gauss(r), ty: head.ty + 0.03 * gauss(r) };
      const f = frameFeatures(makeFrame(target, pose, gn, o.light ?? {}, r, o.noise ?? NOMINAL_NOISE));
      if (f) out.push({ target, features: f, t: (t += 33) });
    }
  }
  return out;
}

/** Where a centred text column is read: 5 columns × 9 rows, viewport px. */
export const READING_POINTS: readonly Point[] = Object.freeze(
  [0.3, 0.4, 0.5, 0.6, 0.7].flatMap((fx) => [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((fy) => ({ x: fx * VIEW.width, y: fy * VIEW.height }))),
);

export interface PairedFrame {
  target: Point;
  /** Features of the same frame under each perturbation (null when extraction failed). */
  byLight: (EyeFeatures | null)[];
}

/** Reading frames rendered under every perturbation with identical random draws. */
export function pairedReadingFrames(seed: number, perPoint: number, lights: readonly Perturbation[], noise: NoiseSpec = NOMINAL_NOISE): PairedFrame[] {
  const out: PairedFrame[] = [];
  let s = seed;
  for (const target of READING_POINTS) {
    const pose = headFollow(target);
    for (let i = 0; i < perPoint; i++) {
      s++;
      const byLight = lights.map((light) => {
        const r = rng(s * 7919);
        const gn = { h: 0.1 * DEG * gauss(r), v: 0.1 * DEG * gauss(r) };
        return frameFeatures(makeFrame(target, pose, gn, light, r, noise));
      });
      out.push({ target, byLight });
    }
  }
  return out;
}
