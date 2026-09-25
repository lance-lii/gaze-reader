import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CalibrationSample, EyeFeatures, LightingSignature, Point } from '../types';
import {
  CALIBRATION_STORAGE_KEY,
  DEFAULT_LAMBDAS,
  GAZE_EXCLUDED_FEATURES,
  GAZE_MODEL_KIND,
  RidgeGazeModel,
  asRidgeGazeModel,
  calibrationUpgradeNeeded,
  clearCalibration,
  computeAppearanceBaseline,
  deserializeGazeModel,
  evaluateModel,
  featureSignature,
  loadCalibration,
  measureOffset,
  modelChromeTop,
  qualityFromError,
  refineGazeModel,
  saveCalibration,
  savedCalibrationNeedsUpgrade,
  trainGazeModel,
} from './calibrationModel';
import { FEATURE_NAMES } from './features';

const VIEWPORT = { width: 1280, height: 800 };
const FEATURE_COUNT = 13;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

interface EyeOptions {
  /** Per-feature measurement noise multiplier. */
  noise?: number;
  /** Additive shift of the gaze features (simulates sitting differently). */
  shift?: number[];
  /** Replace the gaze signal with pure noise. */
  noSignal?: boolean;
}

/**
 * A synthetic eye: 5 gaze-carrying features that are *nonlinear* functions of
 * where the user looks, one head feature that barely moves, 6 irrelevant
 * features at wildly different scales and one constant (e.g. a missing
 * blendshape). The model must not be told which is which.
 */
function eyeFeatures(target: Point, r: () => number, opts: EyeOptions = {}): EyeFeatures {
  const k = opts.noise ?? 1;
  const nx = target.x / VIEWPORT.width - 0.5;
  const ny = target.y / VIEWPORT.height - 0.5;
  const sx = opts.noSignal ? 0 : 1;
  const shift = opts.shift ?? [];
  const v = [
    0.3 + sx * (0.2 * nx + 0.08 * nx * nx) + 0.004 * k * gaussian(r), // iris u (left)
    0.7 - sx * (0.18 * nx - 0.06 * nx * ny) + 0.004 * k * gaussian(r), // iris u (right)
    sx * (0.05 * ny + 0.03 * ny * ny) + 0.003 * k * gaussian(r), // iris v
    1 / (1 + Math.exp(-4 * sx * ny)) + 0.02 * k * gaussian(r), // lookDown-ish blendshape
    0.28 - sx * 0.06 * ny + 0.004 * k * gaussian(r), // lid aperture
    0.01 * gaussian(r), // head yaw (still head)
    55 + 0.3 * gaussian(r), // head tz (cm)
    1e-3 * gaussian(r),
    1e3 * gaussian(r),
    gaussian(r),
    5 + 0.1 * gaussian(r),
    -200 + 20 * gaussian(r),
    0, // constant
  ].map((value, i) => value + (shift[i] ?? 0));
  return {
    vector: v,
    headPose: { yaw: 0, pitch: 0, roll: 0, tx: 0, ty: 0, tz: 55 },
    blink: 0.05,
    openness: 0.3,
    faceScale: 0.1,
    faceCenter: { x: 0.5, y: 0.5 },
  };
}

const GRID: Point[] = [];
for (const fy of [0.08, 0.36, 0.64, 0.92]) for (const fx of [0.1, 0.5, 0.9]) GRID.push({ x: fx * VIEWPORT.width, y: fy * VIEWPORT.height });
GRID.push({ x: 0.5 * VIEWPORT.width, y: 0.5 * VIEWPORT.height });

const VALIDATION: Point[] = [
  { x: 0.25 * VIEWPORT.width, y: 0.22 * VIEWPORT.height },
  { x: 0.75 * VIEWPORT.width, y: 0.22 * VIEWPORT.height },
  { x: 0.25 * VIEWPORT.width, y: 0.78 * VIEWPORT.height },
  { x: 0.75 * VIEWPORT.width, y: 0.78 * VIEWPORT.height },
];

function collect(targets: readonly Point[], perTarget: number, seed: number, opts: EyeOptions = {}): CalibrationSample[] {
  const r = rng(seed);
  const out: CalibrationSample[] = [];
  targets.forEach((target, ti) => {
    for (let i = 0; i < perTarget; i++) out.push({ target: { ...target }, features: eyeFeatures(target, r, opts), t: ti * 2000 + i * 33 });
  });
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('trainGazeModel', () => {
  it('learns a nonlinear mapping from noisy features and ignores irrelevant ones', () => {
    const { model, report, diagnostics } = trainGazeModel(collect(GRID, 30, 11), { viewport: VIEWPORT });
    expect(report.perPoint).toHaveLength(13);
    expect(report.sampleCount).toBeGreaterThan(13 * 25);
    // Cross-validated accuracy (each target held out): well under a line.
    expect(report.meanErrorPx).toBeLessThan(30);
    expect(['excellent', 'good']).toContain(report.quality);

    // Fresh points the model never saw.
    const val = evaluateModel(model, collect(VALIDATION, 30, 12));
    expect(val.meanErrorPx).toBeLessThan(25);
    expect(val.quality).toBe('excellent');

    // The chosen features must be the gaze-carrying ones (indices 0–4), never the noise.
    expect(diagnostics.dominantFeatures.length).toBeGreaterThan(0);
    for (const j of diagnostics.dominantFeatures) expect(j).toBeLessThan(5);
    expect(diagnostics.expandedDim).toBe(
      FEATURE_COUNT + (diagnostics.dominantFeatures.length * (diagnostics.dominantFeatures.length + 1)) / 2,
    );
  });

  it('picks λ by leave-one-target-out CV: small for signal, large for pure noise', () => {
    const signal = trainGazeModel(collect(GRID, 30, 21), { viewport: VIEWPORT });
    expect(signal.diagnostics.cv.map((c) => c.lambda)).toEqual([...DEFAULT_LAMBDAS]);
    expect(signal.report.lambda).toBe(signal.model.lambda);
    expect(signal.model.lambda).toBeLessThan(30);
    const best = Math.min(...signal.diagnostics.cv.map((c) => c.errorPx));
    const chosen = signal.diagnostics.cv.find((c) => c.lambda === signal.model.lambda);
    expect(chosen?.errorPx).toBeLessThanOrEqual(best * 1.02 + 1e-9);

    const noise = trainGazeModel(collect(GRID, 30, 22, { noSignal: true }), { viewport: VIEWPORT });
    expect(noise.model.lambda).toBeGreaterThanOrEqual(30);
    expect(noise.report.quality).toBe('poor');
  });

  it('beats a purely linear model on the nonlinear eye', () => {
    const samples = collect(GRID, 30, 31, { noise: 0.3 });
    const quad = trainGazeModel(samples, { viewport: VIEWPORT });
    const linear = trainGazeModel(samples, { viewport: VIEWPORT, quadraticFeatures: 0 });
    expect(linear.diagnostics.dominantFeatures).toEqual([]);
    expect(quad.report.meanErrorPx).toBeLessThan(linear.report.meanErrorPx);
  });

  it('drops blinks, and gross per-target outliers do not wreck the fit', () => {
    const r = rng(41);
    const clean = collect(GRID, 30, 42);
    const dirty = clean.map((s, i) => {
      // ~15 % of samples on four targets: the eyes were somewhere else entirely.
      const target = s.target;
      const onBadTarget = [0, 3, 7, 12].some((g) => GRID[g].x === target.x && GRID[g].y === target.y);
      if (onBadTarget && i % 7 === 0) {
        const elsewhere = { x: r() * VIEWPORT.width, y: r() * VIEWPORT.height };
        return { ...s, features: eyeFeatures(elsewhere, r, { noise: 4 }) };
      }
      return s;
    });
    const blinks = GRID.map((target) => ({
      target,
      features: { ...eyeFeatures({ x: 0, y: 0 }, r), blink: 0.9 },
      t: 0,
    }));
    const robust = trainGazeModel([...dirty, ...blinks], { viewport: VIEWPORT });
    const naive = trainGazeModel([...dirty, ...blinks], { viewport: VIEWPORT, rejectOutliers: false });
    const reference = trainGazeModel(clean, { viewport: VIEWPORT });
    const injected = dirty.filter((s, i) => s !== clean[i]).length;

    expect(robust.diagnostics.droppedInvalid).toBe(GRID.length);
    expect(robust.diagnostics.rejectedOutliers).toBeGreaterThanOrEqual(Math.floor(injected * 0.7));
    expect(naive.diagnostics.rejectedOutliers).toBe(0);

    // Judge on a dense fresh grid: four validation points are too few to rank two decent models.
    const dense: Point[] = [];
    for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) for (const fy of [0.1, 0.3, 0.5, 0.7, 0.9]) dense.push({ x: fx * VIEWPORT.width, y: fy * VIEWPORT.height });
    const held = collect(dense, 30, 43);
    const robustErr = evaluateModel(robust.model, held).meanErrorPx;
    const naiveErr = evaluateModel(naive.model, held).meanErrorPx;
    const referenceErr = evaluateModel(reference.model, held).meanErrorPx;
    expect(robustErr).toBeLessThan(referenceErr * 1.2 + 1);
    expect(naiveErr).toBeGreaterThan(robustErr * 1.5);
  });

  it('rejects inconsistent feature lengths and hopeless inputs', () => {
    const samples = collect(GRID, 10, 51);
    samples[5] = { ...samples[5], features: { ...samples[5].features, vector: samples[5].features.vector.slice(1) } };
    expect(() => trainGazeModel(samples)).toThrow(RangeError);
    expect(() => trainGazeModel([])).toThrow();
    expect(() => trainGazeModel(collect(GRID.slice(0, 2), 20, 52))).toThrow(/at least 3/);
  });

  it('refuses feature names that do not match the vector (every reload would reject the model)', () => {
    const samples = collect(GRID, 10, 53);
    const names = Array.from({ length: FEATURE_COUNT - 1 }, (_, i) => `f${i}`);
    expect(() => trainGazeModel(samples, { viewport: VIEWPORT, featureNames: names })).toThrow(RangeError);
    expect(() => trainGazeModel(samples, { viewport: VIEWPORT, featureNames: [...names, 'last'] })).not.toThrow();
  });

  it('keeps lowered-lid samples (looking low on the screen) when the caller raises maxBlink', () => {
    // Blink scores rise when the reader looks at the bottom row; the overlay's
    // blink gate has already told these apart from real blinks.
    const lowered = (s: CalibrationSample): CalibrationSample =>
      s.target.y > VIEWPORT.height * 0.8 ? { ...s, features: { ...s.features, blink: 0.65 } } : s;
    const samples = collect(GRID, 20, 54).map(lowered);

    const strict = trainGazeModel(samples, { viewport: VIEWPORT });
    expect(strict.diagnostics.droppedInvalid).toBe(3 * 20);
    expect(strict.diagnostics.targets).toBe(GRID.length - 3);

    const lenient = trainGazeModel(samples, { viewport: VIEWPORT, maxBlink: 0.85 });
    expect(lenient.diagnostics.droppedInvalid).toBe(0);
    expect(lenient.diagnostics.targets).toBe(GRID.length);
    // Real blinks stay out.
    const withBlink = [...samples, { ...samples[0], features: { ...samples[0].features, blink: 0.95 } }];
    expect(trainGazeModel(withBlink, { viewport: VIEWPORT, maxBlink: 0.85 }).diagnostics.droppedInvalid).toBe(1);

    const bottom = collect([{ x: 640, y: 760 }], 20, 55).map(lowered);
    expect(evaluateModel(lenient.model, bottom).sampleCount).toBe(0);
    expect(evaluateModel(lenient.model, bottom, { maxBlink: 0.85 }).sampleCount).toBeGreaterThan(15);
    expect(evaluateModel(lenient.model, bottom, { maxBlink: Number.NaN }).sampleCount).toBe(0); // NaN → default

    const quick = collect([{ x: 640, y: 400 }, { x: 192, y: 720 }, { x: 1088, y: 720 }], 20, 56).map(lowered);
    expect(refineGazeModel(lenient.model, quick, { viewport: VIEWPORT }).report.perPoint).toHaveLength(1);
    expect(refineGazeModel(lenient.model, quick, { viewport: VIEWPORT, maxBlink: 0.85 }).report.perPoint).toHaveLength(3);
  });

  it('skips non-finite feature rows instead of poisoning the fit', () => {
    const samples = collect(GRID, 20, 61);
    samples[0].features.vector[2] = Number.NaN;
    samples[1].features.vector[4] = Infinity;
    const { diagnostics, model } = trainGazeModel(samples, { viewport: VIEWPORT });
    expect(diagnostics.droppedInvalid).toBe(2);
    const p = model.predict(eyeFeatures(GRID[4], rng(62), { noise: 0 }));
    expect(p).not.toBeNull();
  });

  it('defaults the viewport to the window, else infers it from the target grid', () => {
    const inferred = trainGazeModel(collect(GRID, 10, 71));
    expect(inferred.model.viewport.width).toBeCloseTo(VIEWPORT.width, 6);
    expect(inferred.model.viewport.height).toBeCloseTo(VIEWPORT.height, 6);

    vi.stubGlobal('window', { screenX: 0, screenY: 0, innerWidth: 1440, innerHeight: 900 });
    expect(trainGazeModel(collect(GRID, 10, 72)).model.viewport).toEqual({ width: 1440, height: 900 });
  });
});

describe('RidgeGazeModel.predict', () => {
  const { model } = trainGazeModel(collect(GRID, 25, 81), { viewport: VIEWPORT });

  it('returns null for unusable features', () => {
    const good = eyeFeatures(GRID[0], rng(82));
    expect(model.predict(good)).not.toBeNull();
    expect(model.predict({ ...good, vector: good.vector.slice(0, -1) })).toBeNull();
    expect(model.predict({ ...good, vector: [...good.vector, 0] })).toBeNull();
    expect(model.predict({ ...good, vector: good.vector.map((v, i) => (i === 3 ? Number.NaN : v)) })).toBeNull();
    // A tracker glitch: a dominant gaze feature a hundred calibration SDs out.
    const j = model.dominantFeatures[0];
    expect(model.predict({ ...good, vector: good.vector.map((v, i) => (i === j ? v + 100 : v)) })).toBeNull();
    expect(model.predictScreen(null)).toBeNull();
  });

  it('never rejects a prediction because the reader sits differently (posture features), only for eye glitches', () => {
    // The reader nodded slightly toward each dot, so head `ty` tracks the targets. Named as a posture
    // feature it enters linearly only: never squared, never a glitch check.
    const names = Array.from({ length: FEATURE_COUNT }, (_, i) => (i === 5 ? 'ty' : `f${i}`));
    const r = rng(86);
    const nod = (s: CalibrationSample): CalibrationSample => {
      const v = [...s.features.vector];
      v[5] = 0.8 * (s.target.y / VIEWPORT.height - 0.5) + 0.01 * gaussian(r);
      return { ...s, features: { ...s.features, vector: v } };
    };
    const nodding = collect(GRID, 25, 87).map(nod);
    const trained = trainGazeModel(nodding, { viewport: VIEWPORT, featureNames: names }).model;
    expect(trained.dominantFeatures).not.toContain(5);
    expect(trained.dominantFeatures.length).toBeGreaterThan(0);
    const f = nod({ target: GRID[12], features: eyeFeatures(GRID[12], rng(88), { noise: 0 }), t: 0 }).features;
    // Leaning back 20 cm later is hundreds of calibration SDs in `ty`: still a prediction.
    expect(trained.predict({ ...f, vector: f.vector.map((v, i) => (i === 5 ? v + 20 : v)) })).not.toBeNull();
    // An eye feature that far out is still a tracking glitch.
    const eye = trained.dominantFeatures.find((j) => j !== 5)!;
    expect(trained.predict({ ...f, vector: f.vector.map((v, i) => (i === eye ? v + 100 : v)) })).toBeNull();

    // Models saved before these rules could carry `ty` as a dominant feature (trained here without
    // names, so it is picked). They learn the glitch rule on load from the running build's names…
    const old = trainGazeModel(nodding, { viewport: VIEWPORT }).model;
    expect(old.dominantFeatures).toContain(5);
    const legacy = { ...old.toJSON() } as Record<string, unknown>;
    delete legacy.glitchCheck;
    delete legacy.featureSignature;
    const leaned = { ...f, vector: f.vector.map((v, i) => (i === 5 ? v + 20 : v)) };
    expect(deserializeGazeModel(legacy, { featureNames: names })!.predict(leaned)).not.toBeNull();
    // …and without names keep the old, all-dominant check.
    expect(deserializeGazeModel(legacy)!.predict(leaned)).toBeNull();
  });

  it('stays bounded when non-gaze features drift far from calibration', () => {
    const f = eyeFeatures(GRID[12], rng(83), { noise: 0 });
    const drifted = { ...f, vector: f.vector.map((v, i) => (i === 6 ? v + 50 : v)) }; // head moved 50 cm
    const p = model.predict(drifted);
    expect(p).not.toBeNull();
    expect(Number.isFinite(p?.x) && Number.isFinite(p?.y)).toBe(true);
  });

  it('compensates for window moves since calibration', () => {
    const win = { screenX: 200, screenY: 100, innerWidth: VIEWPORT.width, innerHeight: VIEWPORT.height };
    vi.stubGlobal('window', win);
    const trained = trainGazeModel(collect(GRID, 25, 84)).model;
    const f = eyeFeatures(GRID[12], rng(85), { noise: 0 });
    const before = trained.predict(f);
    win.screenX = 260; // window dragged 60 px right, 25 px up
    win.screenY = 75;
    const after = trained.predict(f);
    expect(before && after).toBeTruthy();
    expect(after!.x).toBeCloseTo(before!.x - 60, 9);
    expect(after!.y).toBeCloseTo(before!.y + 25, 9);
  });
});

describe('serialization', () => {
  const { model } = trainGazeModel(collect(GRID, 25, 91), { viewport: VIEWPORT, featureNames: names() });

  function names(count = FEATURE_COUNT): string[] {
    return Array.from({ length: count }, (_, i) => `f${i}`);
  }

  it('records the browser chrome height for the window-layout check, and tolerates models without it', () => {
    const win = { screenX: 0, screenY: 0, innerWidth: VIEWPORT.width, innerHeight: 700, outerHeight: 810, devicePixelRatio: 1, top: null as unknown };
    win.top = win;
    vi.stubGlobal('window', win);
    const trained = trainGazeModel(collect(GRID, 25, 95), { viewport: VIEWPORT }).model;
    expect(trained.chromeTop).toBe(110);
    expect(modelChromeTop(trained)).toBe(110);
    const restored = deserializeGazeModel(JSON.parse(JSON.stringify(trained.toJSON())) as unknown)!;
    expect(restored.chromeTop).toBe(110);
    // A zoom change makes the heights incomparable (the size check covers that case).
    win.devicePixelRatio = 1.25;
    expect(modelChromeTop(restored)).toBeNull();
    // Models saved before the field existed: no check.
    const legacy = { ...trained.toJSON() } as Record<string, unknown>;
    delete legacy.chromeTop;
    delete legacy.dprAtCalibration;
    const old = deserializeGazeModel(legacy)!;
    expect(old).toBeInstanceOf(RidgeGazeModel);
    expect(old.chromeTop).toBeNull();
    expect(modelChromeTop(old)).toBeNull();
    // A quick refresh re-fits the offset in the current layout, so it becomes the new reference.
    win.devicePixelRatio = 1;
    win.outerHeight = 700; // fullscreen: no toolbar
    const refined = refineGazeModel(trained, collect(GRID.slice(0, 5), 20, 96)).model;
    expect(refined.chromeTop).toBe(0);
  });

  it('round-trips through JSON with bit-identical predictions', () => {
    const json = JSON.parse(JSON.stringify(model.toJSON())) as unknown;
    const restored = deserializeGazeModel(json, { featureLength: FEATURE_COUNT, featureNames: names() });
    expect(restored).toBeInstanceOf(RidgeGazeModel);
    expect(restored!.viewport).toEqual(model.viewport);
    expect(restored!.trainedAt).toBe(model.trainedAt);
    expect(restored!.lambda).toBe(model.lambda);
    const r = rng(92);
    for (const target of [...GRID, ...VALIDATION]) {
      const f = eyeFeatures(target, r);
      expect(restored!.predict(f)).toEqual(model.predict(f));
    }
    expect(restored!.toJSON()).toEqual(model.toJSON());
  });

  it('rejects models built for a different feature vector', () => {
    const json = model.toJSON();
    expect(deserializeGazeModel(json, { featureLength: FEATURE_COUNT + 1 })).toBeNull();
    expect(deserializeGazeModel(json, { featureNames: names(FEATURE_COUNT - 1) })).toBeNull();
    const reordered = names().reverse();
    expect(featureSignature(reordered)).not.toBe(featureSignature(names()));
    expect(deserializeGazeModel(json, { featureNames: reordered })).toBeNull();
  });

  it('rejects corrupt or foreign JSON', () => {
    const good = model.toJSON();
    const bad: unknown[] = [
      null,
      42,
      'model',
      [],
      { ...good, version: 2 },
      { ...good, kind: 'something-else' },
      { ...good, featureLength: 0 },
      { ...good, mean: good.mean instanceof Array ? good.mean.slice(1) : null },
      { ...good, std: (good.std as number[]).map((v, i) => (i === 0 ? 0 : v)) },
      { ...good, wx: (good.wx as number[]).map((v, i) => (i === 0 ? null : v)) },
      { ...good, quad: [0, 0] },
      { ...good, quad: [FEATURE_COUNT] },
      { ...good, viewport: { width: 0, height: 800 } },
      { ...good, origin: null },
      { ...good, adjust: { sx: -1, ox: 0, sy: 1, oy: 0 } },
      { ...good, lambda: -1 },
      { ...good, bx: 'NaN' },
      { ...good, excluded: [FEATURE_COUNT] },
      { ...good, excluded: 'lids' },
      // 1.0 models read gaze from the lids: recalibrate rather than load them.
      { ...good, kind: 'gr-ridge-poly2' },
    ];
    for (const b of bad) expect(deserializeGazeModel(b)).toBeNull();
  });

  it('persists through storage and clears', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    expect(loadCalibration()).toBeNull();
    saveCalibration(model);
    expect([...store.keys()]).toEqual([`gazeReader.${CALIBRATION_STORAGE_KEY}`]);
    const loaded = loadCalibration({ featureLength: FEATURE_COUNT });
    const f = eyeFeatures(GRID[2], rng(93));
    expect(loaded?.predict(f)).toEqual(model.predict(f));
    expect(loadCalibration({ featureLength: 3 })).toBeNull();
    clearCalibration();
    expect(loadCalibration()).toBeNull();

    store.set(`gazeReader.${CALIBRATION_STORAGE_KEY}`, '{not json');
    expect(loadCalibration()).toBeNull();
  });

  it('asRidgeGazeModel accepts any GazeModel that serializes to our format', () => {
    const wrapper = {
      viewport: model.viewport,
      trainedAt: model.trainedAt,
      predict: (f: EyeFeatures) => model.predict(f),
      toJSON: () => model.toJSON(),
    };
    expect(asRidgeGazeModel(model)).toBe(model);
    expect(asRidgeGazeModel(wrapper)).toBeInstanceOf(RidgeGazeModel);
    expect(asRidgeGazeModel({ ...wrapper, toJSON: () => ({ version: 1 }) })).toBeNull();
    expect(asRidgeGazeModel(null)).toBeNull();
  });
});

describe('refineGazeModel (quick mode)', () => {
  const QUICK: Point[] = [
    { x: 640, y: 400 },
    { x: 192, y: 120 },
    { x: 1088, y: 120 },
    { x: 192, y: 680 },
    { x: 1088, y: 680 },
  ];
  // The user sits a little differently today: every gaze feature is offset.
  const SHIFT = [0.02, -0.015, 0.006, 0.05, -0.008];

  it('fixes a systematic offset from five points and still serializes', () => {
    const base = trainGazeModel(collect(GRID, 30, 101), { viewport: VIEWPORT }).model;
    const today = collect(VALIDATION, 30, 102, { shift: SHIFT });
    const before = evaluateModel(base, today);
    expect(before.meanErrorPx).toBeGreaterThan(60);

    const { model, report } = refineGazeModel(base, collect(QUICK, 30, 103, { shift: SHIFT }), { viewport: VIEWPORT });
    expect(report.perPoint).toHaveLength(5);
    expect(report.lambda).toBe(base.lambda);
    const after = evaluateModel(model, today);
    expect(after.meanErrorPx).toBeLessThan(before.meanErrorPx / 2);
    expect(after.meanErrorPx).toBeLessThan(45);

    const adj = model.adjustment;
    expect(adj.sx).toBeGreaterThanOrEqual(0.85);
    expect(adj.sx).toBeLessThanOrEqual(1.2);

    const restored = deserializeGazeModel(JSON.parse(JSON.stringify(model.toJSON())) as unknown);
    const f = today[17].features;
    expect(restored?.predict(f)).toEqual(model.predict(f));
    // The base model is untouched.
    expect(base.adjustment).toEqual({ sx: 1, ox: 0, sy: 1, oy: 0 });
  });

  it('bias-only refinement shifts predictions by a constant', () => {
    const base = trainGazeModel(collect(GRID, 20, 111), { viewport: VIEWPORT }).model;
    const { model } = refineGazeModel(base, collect(QUICK, 20, 112, { shift: SHIFT }), { fitScale: false, viewport: VIEWPORT });
    expect(model.adjustment.sx).toBe(1);
    expect(model.adjustment.sy).toBe(1);
    const r = rng(113);
    const a = eyeFeatures(GRID[0], r);
    const b = eyeFeatures(GRID[11], r);
    const da = { x: model.predict(a)!.x - base.predict(a)!.x, y: model.predict(a)!.y - base.predict(a)!.y };
    const db = { x: model.predict(b)!.x - base.predict(b)!.x, y: model.predict(b)!.y - base.predict(b)!.y };
    expect(da.x).toBeCloseTo(db.x, 6);
    expect(da.y).toBeCloseTo(db.y, 6);
  });

  it('stacks on a previously refined model', () => {
    const base = trainGazeModel(collect(GRID, 20, 121), { viewport: VIEWPORT }).model;
    const once = refineGazeModel(base, collect(QUICK, 20, 122, { shift: SHIFT }), { viewport: VIEWPORT }).model;
    const twice = refineGazeModel(once, collect(QUICK, 20, 123, { shift: SHIFT }), { viewport: VIEWPORT }).model;
    // Already corrected, so the second pass should change little.
    const f = eyeFeatures(GRID[4], rng(124), { shift: SHIFT, noise: 0 });
    const d = Math.hypot(twice.predict(f)!.x - once.predict(f)!.x, twice.predict(f)!.y - once.predict(f)!.y);
    expect(d).toBeLessThan(15);
  });

  it('rejects mismatched features and incompatible base models', () => {
    const base = trainGazeModel(collect(GRID, 10, 131), { viewport: VIEWPORT }).model;
    const short = collect(QUICK, 10, 132).map((s) => ({ ...s, features: { ...s.features, vector: s.features.vector.slice(2) } }));
    expect(() => refineGazeModel(base, short)).toThrow(RangeError);
    const alien = { viewport: VIEWPORT, trainedAt: 0, predict: () => ({ x: 0, y: 0 }), toJSON: () => ({ version: 99 }) };
    expect(() => refineGazeModel(alien, collect(QUICK, 10, 133))).toThrow(/full calibration/);
  });
});

describe('evaluateModel', () => {
  it('reports NaN errors and poor quality when nothing is evaluable', () => {
    const { model } = trainGazeModel(collect(GRID, 10, 141), { viewport: VIEWPORT });
    const blinking = collect(VALIDATION, 5, 142).map((s) => ({ ...s, features: { ...s.features, blink: 0.95 } }));
    const report = evaluateModel(model, blinking);
    expect(report.sampleCount).toBe(0);
    expect(report.perPoint).toEqual([]);
    expect(Number.isNaN(report.meanErrorPx)).toBe(true);
    expect(report.quality).toBe('poor');
  });

  it('ignores a few wild predictions per target', () => {
    const exact = {
      viewport: VIEWPORT,
      trainedAt: 0,
      toJSON: () => ({ version: 1 }),
      predict: (f: EyeFeatures): Point => ({ x: f.vector[0], y: f.vector[1] }),
    };
    const samples: CalibrationSample[] = [];
    const target = { x: 500, y: 300 };
    for (let i = 0; i < 20; i++) {
      const wild = i % 10 === 0;
      const vector = wild ? [1500, -400] : [500 + (i % 3) - 1, 300 + (i % 2)];
      samples.push({ target, t: i, features: { ...eyeFeatures(target, rng(i)), vector } });
    }
    const report = evaluateModel(exact, samples);
    expect(report.perPoint[0].samples).toBe(18);
    expect(report.meanErrorPx).toBeLessThan(2);
    expect(report.lambda).toBe(0);
  });
});

describe('qualityFromError', () => {
  it('grades by lines of text on a roomy viewport', () => {
    expect(qualityFromError(30, 1000)).toBe('excellent');
    expect(qualityFromError(52, 1000)).toBe('excellent');
    expect(qualityFromError(80, 1000)).toBe('good');
    expect(qualityFromError(130, 1000)).toBe('fair');
    expect(qualityFromError(200, 1000)).toBe('poor');
  });

  it('grades by lines at the reader’s own line pitch', () => {
    expect(qualityFromError(50, 1000, 18.2)).toBe('fair'); // small text: ≈ 2.7 lines
    expect(qualityFromError(50, 1000)).toBe('excellent'); // same error at the default pitch
    expect(qualityFromError(150, 1000, 93.6)).toBe('fair'); // large text: 1.6 lines, but 15 % of the page
    expect(qualityFromError(150, 1000)).toBe('poor'); // at the default pitch that is 3.6 lines
    expect(qualityFromError(100, 1000, 93.6)).toBe('good');
    for (const bad of [0, Number.NaN, -5, 4]) {
      expect(qualityFromError(80, 1000, bad)).toBe(qualityFromError(80, 1000));
    }
  });

  it('is stricter on short viewports', () => {
    expect(qualityFromError(45, 500)).toBe('good'); // 9 % of the page
    expect(qualityFromError(80, 500)).toBe('fair');
    expect(qualityFromError(120, 500)).toBe('poor');
  });

  it('is monotone in the error', () => {
    const rank = { excellent: 0, good: 1, fair: 2, poor: 3 } as const;
    let last = 0;
    for (let e = 0; e <= 400; e += 5) {
      const r = rank[qualityFromError(e, 720)];
      expect(r).toBeGreaterThanOrEqual(last);
      last = r;
    }
  });

  it('treats garbage as poor and ignores a missing viewport', () => {
    expect(qualityFromError(Number.NaN, 800)).toBe('poor');
    expect(qualityFromError(Infinity, 800)).toBe('poor');
    expect(qualityFromError(-1, 800)).toBe('poor');
    expect(qualityFromError(40, 0)).toBe('excellent');
    expect(qualityFromError(40, Number.NaN)).toBe('excellent');
  });
});

describe('gaze-excluded features (the lids)', () => {
  // The synthetic eye's feature 3 (a lookDown-like score) and 4 (lid aperture) carry vertical gaze.
  // Named as lid features, the model must not use them at all.
  const names = Array.from({ length: FEATURE_COUNT }, (_, i) => (i === 3 ? 'eyeBlinkLeft' : i === 4 ? 'rightOpen' : `f${i}`));

  it('neutralizes them: never dominant, zero effect on a prediction, recorded in the JSON', () => {
    const { model, report, diagnostics } = trainGazeModel(collect(GRID, 30, 151), { viewport: VIEWPORT, featureNames: names });
    expect(diagnostics.excludedFeatures).toEqual([3, 4]);
    expect(model.excludedFeatures).toEqual([3, 4]);
    expect(diagnostics.dominantFeatures.length).toBeGreaterThan(0);
    for (const j of diagnostics.dominantFeatures) expect([3, 4]).not.toContain(j);
    expect(report.meanErrorPx).toBeLessThan(60); // the iris features alone still track

    const f = eyeFeatures(GRID[5], rng(152), { noise: 0 });
    const squinting = { ...f, vector: f.vector.map((v, i) => (i === 3 ? v + 0.4 : i === 4 ? v - 0.05 : v)) };
    expect(model.predict(squinting)).toEqual(model.predict(f));
    // Even absurd values: never a glitch, never a shift.
    expect(model.predict({ ...f, vector: f.vector.map((v, i) => (i === 4 ? v + 1e3 : v)) })).toEqual(model.predict(f));

    const restored = deserializeGazeModel(JSON.parse(JSON.stringify(model.toJSON())) as unknown, { featureNames: names })!;
    expect(restored.excludedFeatures).toEqual([3, 4]);
    expect(restored.predict(squinting)).toEqual(model.predict(f));
  });

  it('can be switched off (the 1.0 behaviour), and needs feature names to apply', () => {
    const samples = collect(GRID, 30, 153);
    const all = trainGazeModel(samples, { viewport: VIEWPORT, featureNames: names, excludedFeatures: [] });
    expect(all.diagnostics.excludedFeatures).toEqual([]);
    expect(all.diagnostics.dominantFeatures.some((j) => j === 3 || j === 4)).toBe(true);
    const f = eyeFeatures(GRID[5], rng(154), { noise: 0 });
    const lidsMoved = { ...f, vector: f.vector.map((v, i) => (i === 4 ? v - 0.05 : v)) };
    expect(Math.abs(all.model.predict(lidsMoved)!.y - all.model.predict(f)!.y)).toBeGreaterThan(5);

    expect(trainGazeModel(samples, { viewport: VIEWPORT }).diagnostics.excludedFeatures).toEqual([]);
    const custom = trainGazeModel(samples, { viewport: VIEWPORT, featureNames: names, excludedFeatures: new Set(['f2']) });
    expect(custom.diagnostics.excludedFeatures).toEqual([2]);
  });

  it('covers exactly the lid-driven entries of FEATURE_NAMES, never the 5-point iris, eyeLook or posture', () => {
    const all: readonly string[] = FEATURE_NAMES;
    for (const name of GAZE_EXCLUDED_FEATURES) expect(all).toContain(name);
    expect([...GAZE_EXCLUDED_FEATURES].sort()).toEqual(
      ['eyeBlinkLeft', 'eyeBlinkRight', 'rightOpen', 'leftOpen', 'rightLidY', 'leftLidY', 'rightV', 'leftV', 'meanV', 'rightU', 'leftU', 'meanU'].sort(),
    );
    const used = FEATURE_NAMES.filter((n) => !GAZE_EXCLUDED_FEATURES.has(n));
    expect(used).toEqual(
      expect.arrayContaining(['rightU5', 'rightVc5', 'leftU5', 'leftVc5', 'meanU5', 'meanVc5', 'eyeLookUpLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookOutRight', 'yaw', 'pitch', 'ty', 'faceScale']),
    );
    expect(used).toHaveLength(21);
  });
});

/** A model with the running build's feature layout (x = 500 + 100·f0, y = 400 + 100·f1). */
function realLayoutModel(): RidgeGazeModel {
  const n = FEATURE_NAMES.length;
  const wx = new Float64Array(n);
  const wy = new Float64Array(n);
  wx[0] = 100;
  wy[1] = 100;
  return new RidgeGazeModel({
    featureLength: n,
    featureSignature: featureSignature(FEATURE_NAMES),
    mean: new Float64Array(n),
    std: new Float64Array(n).fill(1),
    quad: [],
    expMean: new Float64Array(n),
    expStd: new Float64Array(n).fill(1),
    wx,
    bx: 500,
    wy,
    by: 400,
    lambda: 1,
    viewport: VIEWPORT,
    origin: { x: 0, y: 0 },
    adjust: { sx: 1, ox: 0, sy: 1, oy: 0 },
    trainedAt: 1,
  });
}

describe('calibrationUpgradeNeeded', () => {
  const current = realLayoutModel().toJSON();

  it('is false for current models, nothing, garbage and foreign JSON', () => {
    expect(current.kind).toBe(GAZE_MODEL_KIND);
    expect(calibrationUpgradeNeeded(current)).toBe(false);
    expect(calibrationUpgradeNeeded({ ...current, extDevicePixelRatio: 1.25 })).toBe(false); // the extension's copy
    for (const other of [null, undefined, 42, 'model', [], {}, { version: 1 }, { version: 1, kind: 'webgazer' }, { kind: GAZE_MODEL_KIND }]) {
      expect(calibrationUpgradeNeeded(other)).toBe(false);
    }
  });

  it('is true for a model an older build saved: older kind, version or feature layout', () => {
    const legacy1 = { ...current, kind: 'gr-ridge-poly2', featureLength: 27, featureSignature: featureSignature(FEATURE_NAMES.slice(0, 27)) };
    expect(calibrationUpgradeNeeded(legacy1)).toBe(true);
    expect(calibrationUpgradeNeeded({ ...legacy1, extDevicePixelRatio: 2 })).toBe(true);
    expect(calibrationUpgradeNeeded({ ...current, version: 2 })).toBe(true);
    expect(calibrationUpgradeNeeded({ ...current, featureSignature: featureSignature([...FEATURE_NAMES].reverse()) })).toBe(true);
    expect(calibrationUpgradeNeeded({ ...current, featureLength: 27 })).toBe(true);
    // Such models don't load, which is what makes the explanation necessary.
    expect(deserializeGazeModel(legacy1, { featureNames: FEATURE_NAMES })).toBeNull();
  });

  it('reads the saved calibration', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    expect(savedCalibrationNeedsUpgrade()).toBe(false);
    store.set(`gazeReader.${CALIBRATION_STORAGE_KEY}`, JSON.stringify({ ...current, kind: 'gr-ridge-poly2' }));
    expect(savedCalibrationNeedsUpgrade()).toBe(true);
    saveCalibration(realLayoutModel());
    expect(savedCalibrationNeedsUpgrade()).toBe(false);
  });
});

const LIGHT: LightingSignature = {
  v: 1,
  n: 40,
  yaw: 0.02,
  pitch: 0.06,
  c: { sclera: -2, backlight: -0.3, side: 0.1, shade: -0.7, glare: 0, range: 2 },
  sd: { sclera: 0.05, backlight: 0.1, side: 0.02, shade: 0.03, glare: 0, range: 0.1 },
};

/** Lids that narrow as the reader looks lower (openness = at0 + slope·y/H), with some squint. */
function withLids(samples: CalibrationSample[], seed: number, at0 = 0.34, slope = -0.1, squint = 0.1): CalibrationSample[] {
  const r = rng(seed);
  return samples.map((s) => ({
    ...s,
    features: {
      ...s.features,
      openness: at0 + slope * (s.target.y / VIEWPORT.height) + 0.01 * gaussian(r),
      squint: squint + 0.02 * gaussian(r),
    },
  }));
}

describe('calibration environment', () => {
  it('stores the caller’s lighting and the eyelid baseline of the samples, and round-trips', () => {
    const light = structuredClone(LIGHT);
    const { model } = trainGazeModel(withLids(collect(GRID, 25, 161), 162), { viewport: VIEWPORT, environment: { lighting: light } });
    light.c.sclera = 99; // the model keeps its own copy
    const env = model.environment!;
    expect(env.lighting).toEqual(LIGHT);
    expect(env.capturedAt).toBe(model.trainedAt);
    const a = env.appearance!;
    expect(a.opennessAt0).toBeCloseTo(0.34, 2);
    expect(a.opennessSlope).toBeCloseTo(-0.1, 1);
    expect(a.opennessResidualSd).toBeGreaterThan(0.007);
    expect(a.opennessResidualSd).toBeLessThan(0.013);
    expect(a.squintMedian).toBeCloseTo(0.1, 2);
    expect(a.squintSd).toBeGreaterThan(0.014);
    expect(a.squintSd).toBeLessThan(0.026);

    const json = JSON.parse(JSON.stringify(model.toJSON())) as Record<string, unknown>;
    const restored = deserializeGazeModel(json)!;
    expect(restored.environment).toEqual(env);
    expect(restored.toJSON()).toEqual(model.toJSON());
    // Samples with constant openness and no squint (older sources): a flat baseline, no lighting.
    expect(trainGazeModel(collect(GRID, 10, 163), { viewport: VIEWPORT }).model.environment).toMatchObject({
      lighting: null,
      appearance: { opennessSlope: 0, squintMedian: 0, squintSd: 0 },
    });
  });

  it('never rejects a model over its environment: malformed parts become null', () => {
    const bad = { v: 1, n: 3, yaw: 0, pitch: 0, c: { sclera: 1 }, sd: {} } as unknown as LightingSignature;
    const { model } = trainGazeModel(withLids(collect(GRID, 15, 164), 165), { viewport: VIEWPORT, environment: { lighting: bad } });
    expect(model.environment!.lighting).toBeNull();
    expect(model.environment!.appearance).not.toBeNull();

    const good = trainGazeModel(withLids(collect(GRID, 15, 166), 167), { viewport: VIEWPORT, environment: { lighting: LIGHT } }).model.toJSON();
    const env = good.environment as Record<string, unknown>;
    const variants: [unknown, 'none' | 'lighting' | 'appearance'][] = [
      [undefined, 'none'],
      [null, 'none'],
      ['sunny', 'none'],
      [{ ...env, capturedAt: 'now' }, 'none'],
      [{ ...env, lighting: { ...LIGHT, v: 2 } }, 'appearance'],
      [{ ...env, lighting: { ...LIGHT, sd: { ...LIGHT.sd, glare: -1 } } }, 'appearance'],
      [{ ...env, appearance: { ...(env.appearance as object), opennessSlope: null } }, 'lighting'],
    ];
    for (const [environment, kept] of variants) {
      const m = deserializeGazeModel({ ...good, environment });
      expect(m).not.toBeNull();
      if (kept === 'none') expect(m!.environment).toBeNull();
      if (kept === 'lighting') expect(m!.environment).toMatchObject({ lighting: LIGHT, appearance: null });
      if (kept === 'appearance') {
        expect(m!.environment!.lighting).toBeNull();
        expect(m!.environment!.appearance).toEqual(env.appearance);
      }
    }
  });

  it('a quick refresh replaces it: today’s light and lids become the reference', () => {
    const base = trainGazeModel(withLids(collect(GRID, 20, 171), 172), { viewport: VIEWPORT, environment: { lighting: LIGHT } }).model;
    const QUICK: Point[] = [{ x: 640, y: 400 }, { x: 192, y: 120 }, { x: 1088, y: 120 }, { x: 192, y: 680 }, { x: 1088, y: 680 }];
    const squinting = withLids(collect(QUICK, 20, 173), 174, 0.3, -0.1, 0.3);
    const bright: LightingSignature = { ...LIGHT, c: { ...LIGHT.c, sclera: -1 } };
    const refreshed = refineGazeModel(base, squinting, { viewport: VIEWPORT, environment: { lighting: bright } }).model;
    expect(refreshed.environment!.lighting).toEqual(bright);
    expect(refreshed.environment!.capturedAt).toBe(refreshed.trainedAt);
    expect(refreshed.environment!.appearance!.opennessAt0).toBeCloseTo(0.3, 2);
    expect(refreshed.environment!.appearance!.squintMedian).toBeCloseTo(0.3, 1);
    // Unknown light today: the old signature no longer describes the reference.
    expect(refineGazeModel(base, squinting, { viewport: VIEWPORT }).model.environment!.lighting).toBeNull();
    // Other copies keep theirs.
    expect(base.withAdjustment({ sx: 1, ox: 5, sy: 1, oy: 0 }, { viewport: VIEWPORT, trainedAt: 2 }).environment).toEqual(base.environment);
  });
});

describe('computeAppearanceBaseline', () => {
  it('fits openness against gaze height robustly (blinks and glances away do not move it)', () => {
    const r = rng(181);
    const samples = withLids(collect(GRID, 30, 182), 183, 0.33, -0.09).map((s, i) =>
      i % 10 === 0
        ? { ...s, features: { ...s.features, openness: 0.02 } }
        : i % 17 === 0
          ? { ...s, features: { ...s.features, openness: 0.33 + 0.2 * r() } }
          : s,
    );
    const b = computeAppearanceBaseline(samples, VIEWPORT.height)!;
    expect(b.v).toBe(1);
    expect(b.n).toBe(samples.length);
    expect(b.opennessAt0).toBeCloseTo(0.33, 2);
    expect(Math.abs(b.opennessSlope + 0.09)).toBeLessThan(0.01);
    expect(b.opennessResidualSd).toBeGreaterThan(0.008);
    expect(b.opennessResidualSd).toBeLessThan(0.014);
  });

  it('returns null without enough usable samples, and a flat line with a single row of targets', () => {
    const samples = withLids(collect(GRID, 5, 184), 185);
    expect(computeAppearanceBaseline(samples.slice(0, 9), VIEWPORT.height)).toBeNull();
    expect(computeAppearanceBaseline(samples, 0)).toBeNull();
    expect(computeAppearanceBaseline(samples, Number.NaN)).toBeNull();
    expect(computeAppearanceBaseline(null as unknown as CalibrationSample[], VIEWPORT.height)).toBeNull();
    const nan = samples.map((s) => ({ ...s, features: { ...s.features, openness: Number.NaN } }));
    expect(computeAppearanceBaseline(nan, VIEWPORT.height)).toBeNull();

    const row = withLids(collect([{ x: 200, y: 400 }, { x: 640, y: 400 }, { x: 1000, y: 400 }], 10, 186), 187);
    const flat = computeAppearanceBaseline(row, VIEWPORT.height)!;
    expect(flat.opennessSlope).toBe(0);
    expect(flat.opennessAt0).toBeCloseTo(0.34 - 0.05, 2);
  });
});

describe('measureOffset', () => {
  const exact = {
    viewport: VIEWPORT,
    trainedAt: 0,
    toJSON: () => ({ version: 1 }),
    predict: (f: EyeFeatures): Point => ({ x: f.vector[0], y: f.vector[1] }),
  };

  it('measures the mean signed offset over targets, ignoring wild samples and blinks', () => {
    const targets: Point[] = [{ x: 640, y: 400 }, { x: 200, y: 150 }, { x: 1080, y: 650 }];
    const r = rng(191);
    const samples: CalibrationSample[] = [];
    targets.forEach((target, ti) => {
      for (let i = 0; i < 20; i++) {
        const wild = i % 9 === 4;
        const vector = wild ? [target.x - 600, target.y + 500] : [target.x + 12 + 3 * gaussian(r), target.y - 30 + 3 * gaussian(r)];
        samples.push({ target, t: ti * 1000 + i, features: { ...eyeFeatures(target, r), vector } });
      }
    });
    samples.push({ target: targets[0], t: 0, features: { ...eyeFeatures(targets[0], r), vector: [0, 0], blink: 0.95 } });
    const m = measureOffset(exact, samples);
    expect(m.targets).toBe(3);
    // The 6 wild samples and the blink are out (the MAD rule also trims a few Gaussian tails).
    expect(m.n).toBeLessThanOrEqual(3 * 18);
    expect(m.n).toBeGreaterThan(3 * 15);
    // 3 px noise over ~50 samples: the means are within ~1 px; the wild ones would move them 200+ px.
    expect(Math.abs(m.offsetXPx - 12)).toBeLessThan(1.5);
    expect(Math.abs(m.offsetYPx + 30)).toBeLessThan(1.5);
    expect(Math.abs(m.meanErrorPx - Math.hypot(12, 30))).toBeLessThan(1.5);
  });

  it('is NaN with n 0 when nothing is evaluable', () => {
    const m = measureOffset(exact, []);
    expect(m.n).toBe(0);
    expect(m.targets).toBe(0);
    expect(Number.isNaN(m.offsetXPx) && Number.isNaN(m.offsetYPx) && Number.isNaN(m.meanErrorPx)).toBe(true);
  });
});
