import { describe, expect, it } from 'vitest';
import type { CalibrationSample, EyeFeatures, Point } from '../types';
import { asRidgeGazeModel, deserializeGazeModel, fitPoseCompensation, refineGazeModel, trainGazeModel } from './calibrationModel';
import { FEATURE_NAMES } from './features';
import {
  REAL_FACE_PRIOR,
  applyGazePrior,
  priorDirection,
  resolveGazePrior,
  sanitizeGazePrior,
  serializeGazePrior,
  type GazePriorWeights,
} from './gazePrior';
import shipped from './realFaceWeights.json';

/** A small feature layout: two eye numbers, noise, then the head. */
const NAMES = ['eyeX', 'eyeY', 'junk', 'yaw', 'pitch', 'roll', 'tx', 'ty', 'tz', 'faceScale'];
const VIEW = { width: 1200, height: 800 };
/** Where the app assumes the camera without a window to ask: above the middle of the viewport. */
const CAMERA = { x: 600, y: -136 };
const DEG = Math.PI / 180;

/**
 * The toy world's shared model. Its eye turns its features with the head: a turned head moves
 * eyeX by 0.5 per radian with the gaze unchanged, a nod moves eyeY. The model knows, and takes
 * that back out; a personal calibration made with the head still cannot.
 */
const TOY: GazePriorWeights = {
  id: 'toy',
  names: ['eyeX', 'eyeY', 'yaw', 'pitch'],
  mean: [0, 0, 0, 0, 0, 0],
  sd: [1, 1, 1, 1, 1, 1],
  w: [
    [1, 0],
    [0, 1],
    [-0.5, 0],
    [0, -0.5],
    [0, 0],
    [0, 0],
    [0, 0],
  ],
};

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number): number => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

interface Head {
  yaw?: number;
  pitch?: number;
  faceScale?: number;
}

/** What the toy tracker reports for a reader looking at `gaze` (viewport px) with the head as given. */
function look(gaze: Point, r: () => number, head: Head = {}, noise = 1): EyeFeatures {
  const yaw = head.yaw ?? 0;
  const pitch = head.pitch ?? 0;
  const faceScale = head.faceScale ?? 0.2;
  // The direction from the camera, as tangents at the calibration distance (600 px ≙ 1).
  const dx = ((gaze.x - CAMERA.x) / 600) * (faceScale / 0.2);
  const dy = ((gaze.y - CAMERA.y) / 600) * (faceScale / 0.2);
  const vector = [
    dx + 0.5 * yaw + 0.004 * noise * gauss(r),
    dy + 0.5 * pitch + 0.004 * noise * gauss(r),
    gauss(r),
    yaw + 0.001 * noise * gauss(r),
    pitch + 0.001 * noise * gauss(r),
    0,
    0,
    -5,
    -60,
    // The face is narrower in the picture when it is turned; the app allows for that.
    faceScale * Math.cos(yaw),
  ];
  return { vector, headPose: { yaw, pitch, roll: 0, tx: 0, ty: -5, tz: -60 }, blink: 0.05, openness: 0.3, faceScale, faceCenter: { x: 0.5, y: 0.45 } };
}

const GRID: Point[] = [0.1, 0.5, 0.9].flatMap((fx) => [0.1, 0.5, 0.9].map((fy) => ({ x: fx * VIEW.width, y: fy * VIEW.height })));

function session(seed: number, head: Head = {}, targets: readonly Point[] = GRID, per = 20): CalibrationSample[] {
  const r = rng(seed);
  return targets.flatMap((target) => Array.from({ length: per }, (_, i) => ({ target, features: look(target, r, head), t: i })));
}

function meanError(model: { predict(f: EyeFeatures): Point | null }, head: Head, seed = 9): number {
  const r = rng(seed);
  let sum = 0;
  let n = 0;
  for (const target of [
    { x: 300, y: 200 },
    { x: 900, y: 600 },
    { x: 600, y: 400 },
    { x: 400, y: 700 },
  ]) {
    for (let i = 0; i < 20; i++) {
      const p = model.predict(look(target, r, head));
      if (!p) continue;
      sum += Math.hypot(p.x - target.x, p.y - target.y);
      n++;
    }
  }
  return n ? sum / n : NaN;
}

const train = (prior: GazePriorWeights | null, extra: Parameters<typeof trainGazeModel>[1] = {}) =>
  trainGazeModel(session(1), { viewport: VIEW, featureNames: NAMES, prior, ...extra });

describe('resolveGazePrior', () => {
  it('ties the weights to a feature layout', () => {
    const prior = resolveGazePrior(TOY, NAMES)!;
    expect(prior.id).toBe('toy');
    expect(prior.index).toEqual([0, 1, 3, 4]);
    expect(prior.place).toEqual([6, 7, 8]);
    expect(prior.slots).toEqual([6, 7]);
    expect([...prior.wx]).toEqual([1, 0, -0.5, 0, 0, 0]);
    expect([...prior.wy]).toEqual([0, 1, 0, -0.5, 0, 0]);
  });

  it('refuses weights that name a missing feature, or are malformed', () => {
    expect(resolveGazePrior(TOY, undefined)).toBeNull();
    expect(resolveGazePrior(null, NAMES)).toBeNull();
    expect(resolveGazePrior(TOY, ['eyeX', 'eyeY', 'yaw', 'pitch', 'tx', 'ty'])).toBeNull(); // no tz
    expect(resolveGazePrior({ ...TOY, names: ['eyeX', 'eyeY', 'yaw', 'nose'] }, NAMES)).toBeNull();
    expect(resolveGazePrior({ ...TOY, mean: [0, 0, 0] }, NAMES)).toBeNull();
    expect(resolveGazePrior({ ...TOY, sd: [1, 1, 0, 1, 1, 1] }, NAMES)).toBeNull();
    expect(resolveGazePrior({ ...TOY, w: TOY.w.slice(0, 6) }, NAMES)).toBeNull();
    expect(resolveGazePrior({ ...TOY, w: TOY.w.map((row) => [row[0], NaN]) }, NAMES)).toBeNull();
  });
});

describe('priorDirection', () => {
  const weights: GazePriorWeights = {
    id: 'w',
    names: ['eyeX', 'yaw'],
    mean: [1, 0.1, 0.5, -0.5],
    sd: [2, 0.1, 0.25, 0.5],
    w: [
      [3, 1],
      [0.5, -2],
      [4, 0],
      [0, 8],
      [10, 20],
    ],
  };
  const prior = resolveGazePrior(weights, NAMES)!;
  const v = [5, 9, 9, 0.3, 9, 9, 30, -15, -60, 9];

  it('standardizes every input, the head’s place in the picture included, and adds the constant', () => {
    // eyeX: (5 − 1) / 2 = 2; yaw: (0.3 − 0.1) / 0.1 = 2; tx ÷ tz: (−0.5 − 0.5) / 0.25 = −4; ty ÷ tz: (0.25 + 0.5) / 0.5 = 1.5.
    const d = priorDirection(prior, v)!;
    expect(d.x).toBeCloseTo(10 + 3 * 2 + 0.5 * 2 + 4 * -4, 10);
    expect(d.y).toBeCloseTo(20 + 1 * 2 - 2 * 2 + 8 * 1.5, 10);
  });

  it('has no answer without a usable input', () => {
    expect(priorDirection(prior, v.map((x, j) => (j === 8 ? 0 : x)))).toBeNull(); // no distance
    expect(priorDirection(prior, v.map((x, j) => (j === 0 ? NaN : x)))).toBeNull();
    expect(priorDirection(prior, [1, 2])).toBeNull();
  });

  it('applyGazePrior puts the two answers in their slots and copies the rest', () => {
    const out = new Float64Array(v.length);
    expect(applyGazePrior(prior, v, out)).toBe(true);
    const d = priorDirection(prior, v)!;
    expect([...out]).toEqual(v.map((x, j) => (j === 6 ? d.x : j === 7 ? d.y : x)));
    expect(applyGazePrior(prior, v.map((x, j) => (j === 3 ? Infinity : x)), out)).toBe(false);
  });
});

describe('a saved prior', () => {
  const prior = resolveGazePrior(TOY, NAMES)!;
  const json = (): Record<string, unknown> => JSON.parse(JSON.stringify(serializeGazePrior(prior))) as Record<string, unknown>;

  it('comes back as it was', () => {
    const back = sanitizeGazePrior(json(), NAMES.length)!;
    expect(back).toEqual(prior);
    const v = look({ x: 200, y: 300 }, rng(2), { yaw: 0.1 }).vector;
    expect(priorDirection(back, v)).toEqual(priorDirection(prior, v));
  });

  it('is refused when anything about it is off', () => {
    const bad = (patch: Record<string, unknown>): unknown => sanitizeGazePrior({ ...json(), ...patch }, NAMES.length);
    expect(sanitizeGazePrior(null, NAMES.length)).toBeNull();
    expect(sanitizeGazePrior([], NAMES.length)).toBeNull();
    expect(bad({ id: 7 })).toBeNull();
    expect(bad({ index: [0, 1, 3, 99] })).toBeNull();
    expect(bad({ index: [] })).toBeNull();
    expect(bad({ place: [6, 7] })).toBeNull();
    expect(bad({ slots: [6, 6] })).toBeNull();
    expect(bad({ slots: [6, -1] })).toBeNull();
    expect(bad({ mean: [0, 0, 0] })).toBeNull();
    expect(bad({ sd: [1, 1, 1, 1, 1, 0] })).toBeNull();
    expect(bad({ wx: [1, 0, 'x', 0, 0, 0] })).toBeNull();
    expect(bad({ by: null })).toBeNull();
    // A layout with fewer features than the prior reads.
    expect(sanitizeGazePrior(json(), 5)).toBeNull();
  });
});

describe('the shipped weights', () => {
  it('fit the features this build produces', () => {
    const prior = resolveGazePrior(REAL_FACE_PRIOR, FEATURE_NAMES)!;
    expect(prior).not.toBeNull();
    expect(prior.id).toBe('mpiifacegaze-linear-1');
    expect(prior.index).toHaveLength(REAL_FACE_PRIOR.names.length);
    expect(new Set(prior.index).size).toBe(prior.index.length);
    // The slots hold the head's place in the picture, which the personal regression never reads.
    expect(prior.slots.map((j) => FEATURE_NAMES[j])).toEqual(['tx', 'ty']);
  });

  it('say where they come from and what licence they carry', () => {
    expect(shipped.source).toMatch(/MPIIFaceGaze/);
    expect(shipped.source).toMatch(/doi\.org\/10\.18419\/darus-3240/);
    expect(shipped.license).toMatch(/CC BY-NC-SA 4\.0/);
    expect(shipped.license).toMatch(/not covered by the repository's MIT/);
  });
});

describe('a calibration on a prior', () => {
  it('fits a straight line from the prior’s two answers to the screen, and nothing else', () => {
    const { model, diagnostics } = train(TOY);
    expect(model.prior?.id).toBe('toy');
    expect(model.dominantFeatures).toEqual([]);
    expect(diagnostics.expandedDim).toBe(NAMES.length);
    // Every feature but the two slots is neutralized.
    expect(model.excludedFeatures).toEqual([0, 1, 2, 3, 4, 5, 8, 9]);
    expect(meanError(model, {})).toBeLessThan(6);
  });

  it('holds when the head turns after calibrating, where the plain calibration is thrown', () => {
    const onPrior = train(TOY, { poseCompensation: false }).model;
    const plain = train(null, { poseCompensation: false }).model;
    expect(plain.prior).toBeNull();
    expect(meanError(plain, {})).toBeLessThan(6);
    const turned = { yaw: 8 * DEG, pitch: -6 * DEG };
    // 0.5 per radian at 600 px per unit: 8° is 42 px across, 6° 31 px down.
    expect(meanError(plain, turned)).toBeGreaterThan(40);
    expect(meanError(onPrior, turned)).toBeLessThan(6);
  });

  it('still scales about the camera when the reader leans in', () => {
    const { model } = train(TOY);
    expect(model.depthCompensation).not.toBeNull();
    expect(meanError(model, { faceScale: 0.25 })).toBeLessThan(8);
    const without = train(TOY, { depthCompensation: false }).model;
    expect(meanError(without, { faceScale: 0.25 })).toBeGreaterThan(60);
  });

  it('drops glances away at a dot by the prior’s answers', () => {
    const samples = session(1);
    // Four frames of the first dot spent looking at the far corner.
    const r = rng(4);
    for (let i = 0; i < 4; i++) samples[i] = { ...samples[i], features: look({ x: 1150, y: 760 }, r) };
    const { model, diagnostics } = trainGazeModel(samples, { viewport: VIEW, featureNames: NAMES, prior: TOY });
    expect(diagnostics.rejectedOutliers).toBeGreaterThanOrEqual(4);
    expect(meanError(model, {})).toBeLessThan(6);
  });

  it('treats a wild answer as a tracking glitch', () => {
    const { model } = train(TOY);
    const f = look({ x: 600, y: 400 }, rng(3));
    f.vector[0] += 50;
    expect(model.predict(f)).toBeNull();
    const noDistance = look({ x: 600, y: 400 }, rng(3));
    noDistance.vector[8] = 0;
    expect(model.predict(noDistance)).toBeNull();
  });

  it('is saved with its prior and reads the same afterwards', () => {
    const { model } = train(TOY);
    const json = JSON.parse(JSON.stringify(model.toJSON())) as Record<string, unknown>;
    expect((json.prior as { id: string }).id).toBe('toy');
    const back = deserializeGazeModel(json, { featureLength: NAMES.length, featureNames: NAMES })!;
    expect(back.prior).toEqual(model.prior);
    const f = look({ x: 333, y: 555 }, rng(5), { yaw: 0.05 });
    expect(back.predict(f)).toEqual(model.predict(f));
  });

  it('is void when its saved prior is damaged: the ridge maps mean nothing without it', () => {
    const json = JSON.parse(JSON.stringify(train(TOY).model.toJSON())) as Record<string, unknown>;
    const prior = json.prior as Record<string, unknown>;
    expect(deserializeGazeModel({ ...json, prior: { ...prior, index: [0, 1, 3, 400] } }, { featureLength: NAMES.length })).toBeNull();
    expect(deserializeGazeModel({ ...json, prior: 'toy' }, { featureLength: NAMES.length })).toBeNull();
    expect(deserializeGazeModel({ ...json, prior: null }, { featureLength: NAMES.length })?.prior).toBeNull();
  });

  it('leaves a calibration without one exactly as it was', () => {
    const { model } = train(null);
    expect('prior' in model.toJSON()).toBe(false);
    expect(model.prior).toBeNull();
  });

  it('survives a quick refresh', () => {
    const { model } = train(TOY);
    // The reader sits 30 px lower than the model says: five dots take that out.
    const r = rng(6);
    const five = [GRID[0], GRID[2], GRID[4], GRID[6], GRID[8]];
    const samples = five.flatMap((target) => Array.from({ length: 20 }, (_, i) => ({ target, features: look({ x: target.x, y: target.y - 30 }, r), t: i })));
    const refined = refineGazeModel(model, samples, { viewport: VIEW }).model;
    expect(refined.prior?.id).toBe('toy');
    const p = refined.predict(look({ x: 600, y: 370 }, rng(8)))!;
    expect(p.y).toBeGreaterThan(385);
    expect(p.y).toBeLessThan(415);
  });

  it('keeps the head-movement step: what the prior leaves of a head movement can still be learned', () => {
    // This reader's eye turns its features 0.8 per radian of nod: the prior takes out 0.5.
    const { model } = train(TOY);
    expect(model.poseCompensation).not.toBeNull();
    const r = rng(12);
    const dot = { x: 600, y: 400 };
    const moving: CalibrationSample[] = Array.from({ length: 150 }, (_, i) => {
      const pitch = 7 * DEG * Math.sin(i / 8);
      const f = look(dot, r, { pitch });
      f.vector[1] += 0.3 * pitch;
      return { target: dot, features: f, t: i * 33 };
    });
    const fitted = fitPoseCompensation(model, moving);
    expect(fitted.ok).toBe(true);
    if (!fitted.ok) return;
    expect(asRidgeGazeModel(fitted.model)!.prior?.id).toBe('toy');
    const nodded = (m: { predict(f: EyeFeatures): Point | null }): number => {
      const f = look(dot, rng(13), { pitch: 6 * DEG }, 0);
      f.vector[1] += 0.3 * 6 * DEG;
      return m.predict(f)!.y - dot.y;
    };
    expect(Math.abs(nodded(model))).toBeGreaterThan(12);
    expect(Math.abs(nodded(fitted.model))).toBeLessThan(5);
  });

  it('refuses weights that do not fit the features, instead of fitting on nothing', () => {
    expect(() => trainGazeModel(session(1), { viewport: VIEW, prior: TOY })).toThrow(/shared gaze model/);
    expect(() => trainGazeModel(session(1), { viewport: VIEW, featureNames: NAMES, prior: { ...TOY, names: ['nose'] } })).toThrow(/shared gaze model/);
  });
});
