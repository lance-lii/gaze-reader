import { describe, expect, it } from 'vitest';
import type { EyeFeatures } from '../types';
import {
  EYE_LANDMARKS,
  extractEyeFeatures,
  FEATURE_COUNT,
  FEATURE_INDEX,
  FEATURE_NAMES,
  frameQuality,
  LANDMARK_COUNT,
  type BlendshapeLike,
  type FeatureName,
  type LandmarkLike,
} from './features';

interface FaceSpec {
  /** Iris offset from each eye's center, in eye widths, in image axes (+x right, +y down). */
  iris?: { dx: number; dy: number };
  /** Lid aperture / eye width. */
  aperture?: number;
  /** Whole-face rotation in the image, radians (counter-clockwise on screen). */
  roll?: number;
  /** Flip horizontally, as a mirrored camera image would. */
  mirror?: boolean;
  /** Face size multiplier (1 → interocular 0.12). */
  scale?: number;
  center?: { x: number; y: number };
  /** Image width / height: x is squashed into normalized width units. */
  aspect?: number;
}

const EYE_W = 0.06;

/**
 * A plausible 478-point face in isotropic units (image heights). Subject's
 * right eye sits at image-left, as in an unmirrored webcam frame.
 */
function makeFace(spec: FaceSpec = {}): LandmarkLike[] {
  const { iris = { dx: 0, dy: 0 }, aperture = 0.3, roll = 0, mirror = false, scale = 1, center = { x: 0.5, y: 0.5 }, aspect = 1 } = spec;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const a = (i / LANDMARK_COUNT) * 2 * Math.PI;
    pts.push({ x: 0.14 * Math.cos(a), y: 0.02 + 0.2 * Math.sin(a) });
  }
  const eye = (e: typeof EYE_LANDMARKS.right, cx: number, innerSign: number) => {
    const cy = -0.05;
    pts[e.inner] = { x: cx + innerSign * (EYE_W / 2), y: cy };
    pts[e.outer] = { x: cx - innerSign * (EYE_W / 2), y: cy };
    pts[e.upper] = { x: cx, y: cy - (aperture * EYE_W) / 2 };
    pts[e.lower] = { x: cx, y: cy + (aperture * EYE_W) / 2 };
    pts[e.iris] = { x: cx + iris.dx * EYE_W, y: cy + iris.dy * EYE_W };
  };
  eye(EYE_LANDMARKS.right, -0.06, +1); // inner corner toward the nose (+x)
  eye(EYE_LANDMARKS.left, 0.06, -1);
  pts[EYE_LANDMARKS.chin] = { x: 0, y: 0.2 };

  const c = Math.cos(-roll); // screen CCW with y pointing down
  const s = Math.sin(-roll);
  return pts.map((p) => {
    let x = p.x * scale;
    let y = p.y * scale;
    [x, y] = [x * c - y * s, x * s + y * c];
    if (mirror) x = -x;
    return { x: (center.x * aspect + x) / aspect, y: center.y + y, z: 0 };
  });
}

const blendshapes = (scores: Record<string, number>): BlendshapeLike[] =>
  Object.entries(scores).map(([categoryName, score]) => ({ categoryName, score }));

/** Column-major pose matrix with a pure yaw, like MediaPipe emits. */
function yawMatrix(yaw: number, tz = -45): number[] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0.5, -1, tz, 1];
}

function extract(spec: FaceSpec = {}, bs: BlendshapeLike[] | null = null, matrix: number[] | null = null): EyeFeatures {
  const f = extractEyeFeatures(makeFace(spec), bs, matrix, { aspectRatio: spec.aspect ?? 1 });
  if (!f) throw new Error('expected features');
  return f;
}

const get = (f: EyeFeatures, name: FeatureName): number => f.vector[FEATURE_INDEX[name]];

const expectStrictlyIncreasing = (xs: number[]): void => {
  for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
};
const expectStrictlyDecreasing = (xs: number[]): void => expectStrictlyIncreasing(xs.map((x) => -x));

describe('FEATURE_NAMES', () => {
  it('is a unique, index-consistent layout that includes every documented signal', () => {
    expect(new Set(FEATURE_NAMES).size).toBe(FEATURE_NAMES.length);
    expect(FEATURE_COUNT).toBe(FEATURE_NAMES.length);
    FEATURE_NAMES.forEach((name, i) => expect(FEATURE_INDEX[name]).toBe(i));
    for (const name of [
      'rightU', 'rightV', 'rightOpen', 'leftU', 'leftV', 'leftOpen', 'meanU', 'meanV',
      'yaw', 'pitch', 'roll', 'tx', 'ty', 'tz', 'faceScale',
      'eyeLookUpLeft', 'eyeLookUpRight', 'eyeLookDownLeft', 'eyeLookDownRight',
      'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight',
      'eyeBlinkLeft', 'eyeBlinkRight',
    ]) {
      expect(FEATURE_NAMES).toContain(name);
    }
  });
});

describe('extractEyeFeatures', () => {
  it('measures a centered gaze on a frontal face', () => {
    const f = extract();
    expect(f.vector).toHaveLength(FEATURE_COUNT);
    expect(f.vector.every(Number.isFinite)).toBe(true);
    expect(get(f, 'rightU')).toBeCloseTo(0.5, 9);
    expect(get(f, 'leftU')).toBeCloseTo(0.5, 9);
    expect(get(f, 'meanU')).toBeCloseTo(0.5, 9);
    expect(get(f, 'meanV')).toBeCloseTo(0, 9);
    expect(get(f, 'rightOpen')).toBeCloseTo(0.3, 9);
    expect(f.openness).toBeCloseTo(0.3, 9);
    expect(f.faceScale).toBeCloseTo(0.12, 9);
    expect(f.faceCenter.x).toBeCloseTo(0.5, 2);
    expect(f.faceCenter.y).toBeCloseTo(0.52, 2);
    expect(f.headPose).toEqual({ yaw: 0, pitch: 0, roll: 0, tx: 0, ty: 0, tz: 0 });
  });

  it('moves u monotonically with horizontal iris position (and meanU does not cancel out)', () => {
    const sweep = [-0.3, -0.15, 0, 0.15, 0.3].map((dx) => extract({ iris: { dx, dy: 0 } }));
    // Iris moving image-right: toward the right eye's inner corner and the left eye's outer corner.
    expectStrictlyDecreasing(sweep.map((f) => get(f, 'rightU')));
    expectStrictlyIncreasing(sweep.map((f) => get(f, 'leftU')));
    expectStrictlyIncreasing(sweep.map((f) => get(f, 'meanU')));
    expect(get(sweep[4], 'meanU') - get(sweep[0], 'meanU')).toBeCloseTo(0.6, 9);
    for (const f of sweep) expect(get(f, 'meanV')).toBeCloseTo(0, 9);
  });

  it('moves v monotonically with vertical iris position (positive = down)', () => {
    const sweep = [-0.2, -0.1, 0, 0.1, 0.2].map((dy) => extract({ iris: { dx: 0, dy } }));
    expectStrictlyIncreasing(sweep.map((f) => get(f, 'rightV')));
    expectStrictlyIncreasing(sweep.map((f) => get(f, 'leftV')));
    expectStrictlyIncreasing(sweep.map((f) => get(f, 'meanV')));
    for (const f of sweep) expect(get(f, 'meanU')).toBeCloseTo(0.5, 9);
  });

  // makeFace applies the iris offset in the face's own frame, before rolling and
  // mirroring, so the same `iris` means the same eye pose in every variant.
  const EYE_MEASURES = ['rightU', 'rightV', 'rightOpen', 'leftU', 'leftV', 'leftOpen', 'meanU', 'meanV', 'rightLidY', 'leftLidY'] as const;

  it('is invariant to mirroring and to head roll', () => {
    const pose = { iris: { dx: 0.12, dy: 0.07 }, aperture: 0.26 };
    const base = extract(pose);
    const variants = [extract({ ...pose, mirror: true }), extract({ ...pose, roll: 0.35 }), extract({ ...pose, roll: -0.6, mirror: true })];
    for (const f of variants) {
      for (const name of EYE_MEASURES) expect(get(f, name)).toBeCloseTo(get(base, name), 9);
      expect(f.faceScale).toBeCloseTo(base.faceScale, 9);
    }
    expect(get(base, 'meanU')).toBeGreaterThan(0.5); // sanity: the pose is not trivially symmetric
  });

  it('corrects for non-square images when given the aspect ratio', () => {
    const pose = { iris: { dx: 0.1, dy: 0.08 }, roll: 0.5 };
    const square = extract(pose);
    const wide = extract({ ...pose, aspect: 16 / 9 });
    for (const name of EYE_MEASURES) expect(get(wide, name)).toBeCloseTo(get(square, name), 9);
    // faceScale is reported in image widths.
    expect(wide.faceScale).toBeCloseTo(square.faceScale / (16 / 9), 9);

    // Ignoring the aspect ratio distorts a rolled face.
    const naive = extractEyeFeatures(makeFace({ ...pose, aspect: 16 / 9 }), null, null);
    expect(naive).not.toBeNull();
    expect(Math.abs((naive?.vector[FEATURE_INDEX.rightV] ?? 0) - get(square, 'rightV'))).toBeGreaterThan(0.01);
  });

  it('shrinks the lid aperture as the lids close', () => {
    const open = extract({ aperture: 0.32 });
    const droopy = extract({ aperture: 0.18 });
    expect(get(droopy, 'rightOpen')).toBeLessThan(get(open, 'rightOpen'));
    expect(droopy.openness).toBeLessThan(open.openness);
  });

  it('keeps the vector length when blendshapes are missing, filling zeros', () => {
    const f = extract({}, null);
    expect(f.vector).toHaveLength(FEATURE_COUNT);
    for (const name of FEATURE_NAMES.filter((n) => n.startsWith('eye'))) expect(get(f, name)).toBe(0);
    expect(extract({}, []).vector).toHaveLength(FEATURE_COUNT);
  });

  it('copies blendshapes into their slots and takes blink as the max of both eyes', () => {
    const f = extract(
      {},
      blendshapes({
        _neutral: 0.9,
        eyeLookDownLeft: 0.42,
        eyeLookDownRight: 0.4,
        eyeLookInLeft: 0.1,
        eyeLookOutRight: 0.12,
        eyeBlinkLeft: 0.2,
        eyeBlinkRight: 0.35,
        jawOpen: 0.5,
      }),
    );
    expect(f.vector).toHaveLength(FEATURE_COUNT);
    expect(get(f, 'eyeLookDownLeft')).toBe(0.42);
    expect(get(f, 'eyeLookDownRight')).toBe(0.4);
    expect(get(f, 'eyeLookInLeft')).toBe(0.1);
    expect(get(f, 'eyeLookOutRight')).toBe(0.12);
    expect(get(f, 'eyeLookUpLeft')).toBe(0);
    expect(f.blink).toBe(0.35);
  });

  it('accepts underscore-style names and sanitizes bad scores', () => {
    const f = extract({}, blendshapes({ eyeBlink_Left: 1.7, eyeBlink_Right: Number.NaN, eyeLookUp_Left: -0.2 }));
    expect(get(f, 'eyeBlinkLeft')).toBe(1);
    expect(get(f, 'eyeBlinkRight')).toBe(0);
    expect(get(f, 'eyeLookUpLeft')).toBe(0);
    expect(f.blink).toBe(1);
  });

  it('estimates blink from the lid aperture when blendshapes are missing', () => {
    expect(extract({ aperture: 0.3 }).blink).toBe(0);
    expect(extract({ aperture: 0 }).blink).toBe(1);
    const half = extract({ aperture: 0.11 }).blink;
    expect(half).toBeGreaterThan(0.3);
    expect(half).toBeLessThan(0.7);
  });

  it('puts head pose from the matrix into the vector, and ignores a broken matrix', () => {
    const f = extract({}, null, yawMatrix(0.3));
    expect(f.headPose.yaw).toBeCloseTo(0.3, 9);
    expect(get(f, 'yaw')).toBeCloseTo(0.3, 9);
    expect(get(f, 'tz')).toBe(-45);

    const broken = yawMatrix(0.3);
    broken[0] = Number.POSITIVE_INFINITY;
    const g = extract({}, null, broken);
    expect(g.headPose.yaw).toBe(0);
    expect(g.vector.every(Number.isFinite)).toBe(true);
  });

  it('returns null for degenerate input', () => {
    expect(extractEyeFeatures([], null, null)).toBeNull();
    expect(extractEyeFeatures(makeFace().slice(0, 477), null, null)).toBeNull();

    const nan = makeFace();
    nan[200] = { x: Number.NaN, y: 0.5, z: 0 };
    expect(extractEyeFeatures(nan, null, null)).toBeNull();

    const collapsedEye = makeFace();
    collapsedEye[EYE_LANDMARKS.left.outer] = { ...collapsedEye[EYE_LANDMARKS.left.inner] };
    expect(extractEyeFeatures(collapsedEye, null, null)).toBeNull();

    const collapsedFace = makeFace({ scale: 0 });
    expect(extractEyeFeatures(collapsedFace, null, null)).toBeNull();

    expect(extractEyeFeatures(makeFace(), null, null, { aspectRatio: Number.NaN })).not.toBeNull();
  });
});

describe('frameQuality', () => {
  const withPose = (yawDeg: number): EyeFeatures => extract({}, null, yawMatrix((yawDeg * Math.PI) / 180));

  it('is high for a well-framed, frontal, open-eyed face and 0 without one', () => {
    expect(frameQuality(null)).toBe(0);
    expect(frameQuality(extract())).toBeGreaterThan(0.95);
  });

  it('falls off with head rotation beyond ~20°', () => {
    const q = [0, 10, 20, 25, 30, 35, 45].map((d) => frameQuality(withPose(d)));
    expect(q[0]).toBeGreaterThan(0.95);
    expect(q[2]).toBeGreaterThan(0.95);
    expect(q[3]).toBeLessThan(q[2]);
    expect(q[4]).toBeLessThan(q[3]);
    expect(q[4]).toBeGreaterThan(0);
    expect(q[5]).toBe(0);
    expect(frameQuality(withPose(-30))).toBeCloseTo(q[4], 9);
  });

  it('penalizes faces that are too small or too close', () => {
    expect(frameQuality(extract({ scale: 0.25 }))).toBeLessThan(0.05); // faceScale 0.03
    expect(frameQuality(extract({ scale: 0.5 }))).toBeLessThan(0.9); // 0.06
    expect(frameQuality(extract({ scale: 3.5 }))).toBeLessThan(0.05); // 0.42
  });

  it('drops while the eyes close', () => {
    const q = (b: number) => frameQuality(extract({}, blendshapes({ eyeBlinkLeft: b, eyeBlinkRight: b })));
    expect(q(0.1)).toBeGreaterThan(0.95);
    expect(q(0.6)).toBeLessThan(q(0.45));
    expect(q(0.9)).toBe(0);
  });

  it('penalizes a face at the edge of the frame', () => {
    expect(frameQuality(extract({ center: { x: 0.03, y: 0.5 } }))).toBeLessThan(0.05);
  });

  it('returns 0 for non-finite fields', () => {
    const f = extract();
    expect(frameQuality({ ...f, faceScale: Number.NaN })).toBe(0);
    expect(frameQuality({ ...f, headPose: { ...f.headPose, pitch: Number.NaN } })).toBe(0);
  });
});
