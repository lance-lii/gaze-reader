import type { EyeFeatures, HeadPose, Point } from '../types';
import { NEUTRAL_HEAD_POSE, tryHeadPoseFromMatrix } from './headPose';

/**
 * Eye features for the calibration model, from MediaPipe's 478-point face mesh.
 *
 * Everything is measured in a face-aligned frame, so it does not depend on
 * whether the image is mirrored and is only mildly affected by head roll:
 *  - per eye, `u` runs along the corner axis (0 = inner corner … 1 = outer),
 *  - `v` and the lid measures run along that axis' normal, oriented toward
 *    the chin (positive = down),
 *  - everything is normalized by that eye's width.
 * "Left"/"right" are the subject's anatomical sides throughout.
 */

export interface LandmarkLike {
  x: number;
  y: number;
  z: number;
}

export interface BlendshapeLike {
  categoryName: string;
  score: number;
}

/** Face mesh (468) + iris refinement (10). */
export const LANDMARK_COUNT = 478;
const MESH_POINT_COUNT = 468;

/** Face-mesh indices used here, exported for preview overlays. */
export const EYE_LANDMARKS = Object.freeze({
  right: Object.freeze({ iris: 468, inner: 133, outer: 33, upper: 159, lower: 145 }),
  left: Object.freeze({ iris: 473, inner: 362, outer: 263, upper: 386, lower: 374 }),
  chin: 152,
});

/** MediaPipe blendshape categories copied into the vector (0 when absent). */
const BLENDSHAPE_FEATURES = [
  'eyeLookUpLeft',
  'eyeLookUpRight',
  'eyeLookDownLeft',
  'eyeLookDownRight',
  'eyeLookInLeft',
  'eyeLookInRight',
  'eyeLookOutLeft',
  'eyeLookOutRight',
  'eyeBlinkLeft',
  'eyeBlinkRight',
] as const;

/**
 * Layout of `EyeFeatures.vector`. Append-only: the calibration model rejects
 * saved models whose feature length differs.
 */
export const FEATURE_NAMES = [
  'rightU', //       iris along the corner axis, 0 = inner … 1 = outer
  'rightV', //       iris offset from the lid midpoint along the down-normal, / eye width
  'rightOpen', //    lid aperture / eye width
  'leftU',
  'leftV',
  'leftOpen',
  // Per-eye u runs inner→outer, which points opposite ways for the two eyes, so
  // a plain average would cancel conjugate gaze. meanU re-orients the right eye
  // (1 − rightU) first: it is the iris position along the subject's right→left
  // axis, and it grows as the reader looks toward their left (image-right).
  'meanU',
  'meanV', //        (rightV + leftV) / 2
  'rightLidY', //    lid midpoint below the corner line, / eye width (lids follow vertical gaze)
  'leftLidY',
  'yaw', //          radians, see headPose.ts
  'pitch',
  'roll',
  'tx', //           MediaPipe metric units (~cm)
  'ty',
  'tz',
  'faceScale', //    interocular distance, in image widths
  ...BLENDSHAPE_FEATURES,
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

export const FEATURE_COUNT: number = FEATURE_NAMES.length;

/** Index of each named feature in `EyeFeatures.vector`. */
export const FEATURE_INDEX: Readonly<Record<FeatureName, number>> = Object.freeze(
  Object.fromEntries(FEATURE_NAMES.map((name, i) => [name, i])) as Record<FeatureName, number>,
);

export interface ExtractOptions {
  /**
   * Source image width / height. Landmark x and y are normalized by different
   * lengths, so without it angles and lengths are slightly distorted (fine for
   * an upright face; it matters when the head rolls). Default 1.
   */
  aspectRatio?: number;
}

interface Vec {
  x: number;
  y: number;
}

interface EyeMeasures {
  u: number;
  v: number;
  open: number;
  lidY: number;
}

const MIN_LENGTH = 1e-6;

const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const mid = (a: Vec, b: Vec): Vec => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const clamp01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x);

function measureEye(inner: Vec, outer: Vec, upper: Vec, lower: Vec, iris: Vec, down: Vec): EyeMeasures | null {
  const axis = sub(outer, inner);
  const width = Math.hypot(axis.x, axis.y);
  if (!(width > MIN_LENGTH)) return null;
  const ux: Vec = { x: axis.x / width, y: axis.y / width };
  let n: Vec = { x: -ux.y, y: ux.x };
  // Orient the normal by the face (toward the chin), not by the lids, so it
  // stays well defined when the eye is closed.
  if (dot(n, down) < 0) n = { x: -n.x, y: -n.y };

  const lidMid = mid(upper, lower);
  return {
    u: dot(sub(iris, inner), ux) / width,
    v: dot(sub(iris, lidMid), n) / width,
    open: Math.max(0, dot(sub(lower, upper), n)) / width,
    lidY: dot(sub(lidMid, mid(inner, outer)), n) / width,
  };
}

const normalizeBlendshapeName = (name: string): string => name.replace(/[^a-z]/gi, '').toLowerCase();

/** Name → score (clamped to 0..1; non-finite → 0), tolerant of `eyeBlink_Left`-style names. */
function readBlendshapes(blendshapes: readonly BlendshapeLike[] | null): Map<string, number> | null {
  if (!blendshapes || blendshapes.length === 0) return null;
  const scores = new Map<string, number>();
  for (const b of blendshapes) {
    if (!b || typeof b.categoryName !== 'string') continue;
    scores.set(normalizeBlendshapeName(b.categoryName), Number.isFinite(b.score) ? clamp01(b.score) : 0);
  }
  return scores;
}

const BLENDSHAPE_KEYS = BLENDSHAPE_FEATURES.map(normalizeBlendshapeName);
const BLINK_LEFT_KEY = normalizeBlendshapeName('eyeBlinkLeft');
const BLINK_RIGHT_KEY = normalizeBlendshapeName('eyeBlinkRight');

/**
 * Blink estimate from lid aperture, used only when blendshapes are missing.
 * An open eye measures ≈ 0.25–0.35 with these landmarks, ≈ 0.15–0.2 when
 * looking down, and < 0.08 when closed.
 */
function blinkFromAperture(open: number): number {
  const OPEN = 0.16;
  const CLOSED = 0.06;
  return clamp01((OPEN - open) / (OPEN - CLOSED));
}

/**
 * Builds the calibration-model input for one frame. Returns null for unusable
 * input: fewer than 478 landmarks, non-finite coordinates, or a collapsed eye
 * or face geometry. Missing blendshapes or matrix are filled with zeros / the
 * neutral pose so the vector length never changes.
 */
export function extractEyeFeatures(
  landmarks: readonly LandmarkLike[],
  blendshapes: readonly BlendshapeLike[] | null,
  transformMatrix: readonly number[] | null,
  opts: ExtractOptions = {},
): EyeFeatures | null {
  if (!landmarks || landmarks.length < LANDMARK_COUNT) return null;
  const aspect =
    opts.aspectRatio !== undefined && Number.isFinite(opts.aspectRatio) && opts.aspectRatio > 0 ? opts.aspectRatio : 1;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const p = landmarks[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    if (i < MESH_POINT_COUNT) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }

  // Isotropic coordinates (both axes in image heights) so angles are true.
  const P = (i: number): Vec => ({ x: landmarks[i].x * aspect, y: landmarks[i].y });
  const R = EYE_LANDMARKS.right;
  const L = EYE_LANDMARKS.left;

  const rightCenter = mid(P(R.inner), P(R.outer));
  const leftCenter = mid(P(L.inner), P(L.outer));
  const interocular = Math.hypot(leftCenter.x - rightCenter.x, leftCenter.y - rightCenter.y);
  if (!(interocular > MIN_LENGTH)) return null;

  let down = sub(P(EYE_LANDMARKS.chin), mid(rightCenter, leftCenter));
  if (!(Math.hypot(down.x, down.y) > MIN_LENGTH)) down = { x: 0, y: 1 };

  const right = measureEye(P(R.inner), P(R.outer), P(R.upper), P(R.lower), P(R.iris), down);
  const left = measureEye(P(L.inner), P(L.outer), P(L.upper), P(L.lower), P(L.iris), down);
  if (!right || !left) return null;

  const pose: HeadPose = (transformMatrix && tryHeadPoseFromMatrix(transformMatrix)) || { ...NEUTRAL_HEAD_POSE };
  const scores = readBlendshapes(blendshapes);
  const faceScale = interocular / aspect;

  const blinkL = scores?.get(BLINK_LEFT_KEY);
  const blinkR = scores?.get(BLINK_RIGHT_KEY);
  const blink =
    blinkL !== undefined || blinkR !== undefined
      ? Math.max(blinkL ?? 0, blinkR ?? 0)
      : Math.max(blinkFromAperture(right.open), blinkFromAperture(left.open));

  const vector: number[] = [
    right.u,
    right.v,
    right.open,
    left.u,
    left.v,
    left.open,
    (1 - right.u + left.u) / 2,
    (right.v + left.v) / 2,
    right.lidY,
    left.lidY,
    pose.yaw,
    pose.pitch,
    pose.roll,
    pose.tx,
    pose.ty,
    pose.tz,
    faceScale,
    ...BLENDSHAPE_KEYS.map((key) => scores?.get(key) ?? 0),
  ];
  for (const x of vector) if (!Number.isFinite(x)) return null;

  const faceCenter: Point = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  return {
    vector,
    headPose: pose,
    blink,
    openness: (right.open + left.open) / 2,
    faceScale,
    faceCenter,
  };
}

/** 1 up to `full`, 0 from `zero` on, smooth in between (either direction). */
function falloff(x: number, full: number, zero: number): number {
  const t = clamp01((x - full) / (zero - full));
  return 1 - t * t * (3 - 2 * t);
}

const DEG = 180 / Math.PI;

/**
 * Plausible `faceScale` band (interocular distance in image widths). With a
 * typical 60–70° webcam, ≈ 0.10 at 50 cm; 0.07–0.24 spans ~25–75 cm.
 */
export const FACE_SCALE_BAND = Object.freeze({ min: 0.035, idealMin: 0.07, idealMax: 0.24, max: 0.36 });

/**
 * 0..1 heuristic confidence for a frame: the face is a plausible size, roughly
 * frontal (|yaw|, |pitch| under ~30°), the eyes are open and the face is not
 * cut off by the image edge. Factors multiply, so any one bad condition
 * dominates.
 */
export function frameQuality(f: EyeFeatures | null): number {
  if (!f) return 0;
  const { faceScale, headPose, blink, faceCenter } = f;
  if (
    !Number.isFinite(faceScale) ||
    !Number.isFinite(blink) ||
    !Number.isFinite(headPose.yaw) ||
    !Number.isFinite(headPose.pitch) ||
    !Number.isFinite(headPose.roll) ||
    !Number.isFinite(faceCenter.x) ||
    !Number.isFinite(faceCenter.y)
  ) {
    return 0;
  }

  const b = FACE_SCALE_BAND;
  const size =
    faceScale < b.idealMin ? falloff(-faceScale, -b.idealMin, -b.min) : falloff(faceScale, b.idealMax, b.max);
  const pose =
    falloff(Math.abs(headPose.yaw) * DEG, 20, 35) *
    falloff(Math.abs(headPose.pitch) * DEG, 20, 35) *
    falloff(Math.abs(headPose.roll) * DEG, 25, 50);
  // Gentle: lids droop and blink scores rise when reading the bottom of the
  // screen, and that is still usable signal.
  const eyes = falloff(blink, 0.4, 0.8);
  const margin = Math.min(faceCenter.x, 1 - faceCenter.x, faceCenter.y, 1 - faceCenter.y);
  const framing = falloff(-margin, -0.15, -0.04);

  return clamp01(size * pose * eyes * framing);
}
