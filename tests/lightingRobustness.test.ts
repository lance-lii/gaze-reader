/**
 * Fast regression guards for lighting robustness (the full scoreboard is
 * bench/lighting/features.bench.test.ts, `npm run bench`).
 *
 * The gaze model must not read vertical gaze from the eyelids: light changes them (squinting in
 * bright light or glare), and in 1.0 a 10 % squint moved the predicted gaze ~5 lines down, which
 * turns pages early. These tests train on the synthetic face in two of the simulated worlds and
 * check that the lid exclusion keeps working, without costing calibration accuracy, and that the
 * calibration environment survives storage.
 */
import { describe, expect, it } from 'vitest';
import {
  GAZE_EXCLUDED_FEATURES,
  GAZE_MODEL_KIND,
  calibrationUpgradeNeeded,
  deserializeGazeModel,
  fitPoseCompensation,
  measureOffset,
  refineGazeModel,
  trainGazeModel,
  type RidgeGazeModel,
} from '../src/gaze/calibrationModel';
import { FEATURE_NAMES } from '../src/gaze/features';
import type { LightingSignature } from '../src/types';
import {
  BASE_POSE,
  DEG,
  QUICK_TARGETS,
  READING_POINTS,
  VIEW,
  WORLDS,
  calibrationSession,
  frameFeatures,
  gauss,
  headFollow,
  headMovementSession,
  makeFrame,
  neckPose,
  pairedReadingFrames,
  rng,
  type MovementOptions,
  type Pose,
  type WorldName,
} from '../bench/lighting/faceSim';
import { LINE_PX, NEW_CONFIG, OLD_CONFIG, mean, measureShift, trainConfig } from '../bench/lighting/harness';

const SEEDS = [1, 2, 3];
/** Nominal, and the world where eyeLook* follows the lids most (the worst case for the new model). */
const GUARD_WORLDS: readonly WorldName[] = ['W1', 'W5'];

const LIGHTING: LightingSignature = {
  v: 1,
  n: 42,
  yaw: 0.01,
  pitch: 0.07,
  c: { sclera: -2.1, backlight: -0.4, side: 0.12, shade: -0.8, glare: 0.001, range: 1.9 },
  sd: { sclera: 0.05, backlight: 0.1, side: 0.03, shade: 0.04, glare: 0.0005, range: 0.08 },
};

describe('lighting robustness of the gaze model', () => {
  const results = GUARD_WORLDS.map((world) => {
    const noise = WORLDS[world].noise;
    const frames = pairedReadingFrames(1000, 6, [{}, { squint: 0.1 }], noise);
    const perSeed = SEEDS.map((seed) => {
      const cal = calibrationSession(seed, { noise, perTarget: 30 });
      const oldFit = trainConfig(OLD_CONFIG, cal);
      const newFit = trainConfig(NEW_CONFIG, cal);
      return {
        oldLoto: oldFit.report.meanErrorPx,
        newLoto: newFit.report.meanErrorPx,
        oldSquint: measureShift(oldFit.model, OLD_CONFIG, frames, 1).dy / LINE_PX,
        newSquint: measureShift(newFit.model, NEW_CONFIG, frames, 1).dy / LINE_PX,
        newDominant: newFit.diagnostics.dominantFeatures.map((j) => FEATURE_NAMES[j]),
        newExcluded: newFit.diagnostics.excludedFeatures.map((j) => FEATURE_NAMES[j]),
      };
    });
    return { world, perSeed };
  });

  it('a 10 % squint moves the predicted gaze at most 1.2 lines (1.0 moved it several)', () => {
    for (const { world, perSeed } of results) {
      // Averaged over calibrations, as the scoreboard reports it (W5 seeds span 0.95–1.25 lines).
      expect(Math.abs(mean(perSeed.map((s) => s.newSquint))), `${world} NEW`).toBeLessThanOrEqual(1.2);
      for (const s of perSeed) {
        expect(Math.abs(s.newSquint), `${world} NEW, one calibration`).toBeLessThanOrEqual(1.5);
        // The simulation still shows the problem the exclusion fixes.
        expect(s.oldSquint, `${world} OLD`).toBeGreaterThan(3);
      }
    }
  });

  it('never lets the model read gaze from the lids', () => {
    for (const { perSeed } of results) {
      for (const s of perSeed) {
        expect(s.newExcluded).toEqual(expect.arrayContaining(['eyeBlinkLeft', 'eyeBlinkRight', 'rightOpen', 'leftOpen', 'rightLidY', 'leftLidY', 'rightV', 'leftV', 'meanV']));
        for (const name of s.newDominant) expect(s.newExcluded).not.toContain(name);
      }
    }
  });

  it('calibration accuracy (leave-one-target-out) is no more than 5 % worse than 1.0', () => {
    for (const { world, perSeed } of results) {
      const oldLoto = mean(perSeed.map((s) => s.oldLoto));
      const newLoto = mean(perSeed.map((s) => s.newLoto));
      expect(newLoto, world).toBeLessThanOrEqual(oldLoto * 1.05);
    }
  });
});

describe('calibration environment', () => {
  const noise = WORLDS.W1.noise;
  const cal = calibrationSession(7, { noise, perTarget: 20 });
  const trained = trainConfig(NEW_CONFIG, cal);
  const withLight = trainConfig(NEW_CONFIG, cal, { environment: { lighting: LIGHTING } }).model;

  it('records the eyelid baseline of the calibration: lids narrow as the reader looks lower', () => {
    const env = trained.model.environment;
    expect(env).not.toBeNull();
    expect(env!.lighting).toBeNull();
    const a = env!.appearance!;
    expect(a.v).toBe(1);
    expect(a.n).toBeGreaterThan(200);
    expect(a.opennessSlope).toBeLessThan(-0.03);
    expect(a.opennessAt0).toBeGreaterThan(0.25);
    expect(a.opennessResidualSd).toBeGreaterThan(0);
    expect(env!.capturedAt).toBe(trained.model.trainedAt);
  });

  it('round-trips through JSON with the lighting signature, and a damaged environment never costs the model', () => {
    const json = JSON.parse(JSON.stringify(withLight.toJSON())) as Record<string, unknown>;
    expect(json.kind).toBe(GAZE_MODEL_KIND);
    const restored = deserializeGazeModel(json, { featureNames: FEATURE_NAMES });
    expect(restored).not.toBeNull();
    expect(restored!.environment).toEqual(withLight.environment);
    expect(restored!.environment!.lighting).toEqual(LIGHTING);
    expect(restored!.toJSON()).toEqual(withLight.toJSON());

    const damaged = deserializeGazeModel({ ...json, environment: { ...(json.environment as object), lighting: { v: 1, n: 3 } } }, { featureNames: FEATURE_NAMES });
    expect(damaged).not.toBeNull();
    expect(damaged!.environment!.lighting).toBeNull();
    expect(damaged!.environment!.appearance).toEqual(withLight.environment!.appearance);
    const missing = { ...json };
    delete missing.environment;
    expect(deserializeGazeModel(missing, { featureNames: FEATURE_NAMES })!.environment).toBeNull();
    expect(deserializeGazeModel({ ...json, environment: 'bright' }, { featureNames: FEATURE_NAMES })!.environment).toBeNull();
    expect(calibrationUpgradeNeeded(json)).toBe(false);
  });

  it('asks for one recalibration when a 1.0 model is stored', () => {
    const legacy = trainConfig(OLD_CONFIG, cal).model.toJSON();
    const stored = { ...legacy, kind: 'gr-ridge-poly2' };
    expect(deserializeGazeModel(stored, { featureNames: FEATURE_NAMES })).toBeNull();
    expect(calibrationUpgradeNeeded(stored)).toBe(true);
    expect(calibrationUpgradeNeeded({ ...stored, extDevicePixelRatio: 2 })).toBe(true);
  });

  it('measures the offset a squint leaves, and a quick refresh under the new light removes it', () => {
    // Squinting 20 % in the new light, looking at the quick-refresh dots.
    const quick = calibrationSession(8, { noise, targets: QUICK_TARGETS, perTarget: 20, light: { squint: 0.2 } });
    const before = measureOffset(trained.model, quick, { maxBlink: 0.85 });
    expect(before.targets).toBe(QUICK_TARGETS.length);
    expect(before.n).toBeGreaterThan(60);
    const refreshed = refineGazeModel(trained.model, quick, { viewport: { ...VIEW }, maxBlink: 0.85, environment: { lighting: LIGHTING } }).model;
    expect(refreshed.environment!.lighting).toEqual(LIGHTING);
    // The refresh's own eyelid baseline sees the narrower lids.
    expect(refreshed.environment!.appearance!.opennessAt0).toBeLessThan(trained.model.environment!.appearance!.opennessAt0);
    const reading = calibrationSession(9, { noise, targets: READING_POINTS.map((p) => ({ x: p.x / VIEW.width, y: p.y / VIEW.height })), perTarget: 4, light: { squint: 0.2 } });
    const after = measureOffset(refreshed, reading, { maxBlink: 0.85 });
    expect(Math.abs(after.offsetYPx)).toBeLessThan(Math.max(10, Math.abs(before.offsetYPx)));
    expect(Math.abs(after.offsetYPx) / LINE_PX).toBeLessThan(0.75);
  });
});

/**
 * Posture after calibration (the scoreboard is bench/lighting/posture.bench.test.ts). The head's
 * pose is not a set of gaze features: the corner-referenced iris already measures gaze relative to
 * the camera, and weights fitted to calibration's tiny head movements turned a reader's 4° chin
 * drop into 1.6–2.3 lines of offset and 3 cm to one side into 0.9. A change of distance is
 * corrected geometrically instead (DepthCompensation in calibrationModel.ts).
 */
describe('posture robustness of the gaze model', { timeout: 60_000 }, () => {
  // Calibrations vary a lot here (with yaw/pitch, 4 of 24 W1 calibrations happen to compensate a
  // chin drop better), so the guard averages over 8.
  const POSTURE_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
  /** One calibration per (feature set, world, seed), shared by the postures it is tried in. */
  const models = new Map<string, RidgeGazeModel>();
  const calibrated = (excluded: readonly string[], world: WorldName, seed: number): RidgeGazeModel => {
    const key = `${excluded.join(',')}|${world}|${seed}`;
    let model = models.get(key);
    if (!model) {
      model = trainGazeModel(calibrationSession(seed, { noise: WORLDS[world].noise }), {
        viewport: { ...VIEW },
        maxBlink: 0.85,
        featureNames: FEATURE_NAMES,
        excludedFeatures: excluded,
      }).model;
      models.set(key, model);
    }
    return model;
  };
  /** Mean over calibrations of |that calibration's mean shift| on the reading grid (each reader has one calibration). */
  const shift = (excluded: readonly string[], world: WorldName, delta: Partial<Pose>): { dx: number; dy: number } => {
    const noise = WORLDS[world].noise;
    const dx: number[] = [];
    const dy: number[] = [];
    for (const seed of POSTURE_SEEDS) {
      const model = calibrated(excluded, world, seed);
      const r = rng(seed * 101);
      const sx: number[] = [];
      const sy: number[] = [];
      for (const target of READING_POINTS) {
        for (let i = 0; i < 2; i++) {
          const f = frameFeatures(makeFrame(target, headFollow(target, { ...BASE_POSE, ...delta }), { h: 0.1 * DEG * gauss(r), v: 0.1 * DEG * gauss(r) }, {}, r, noise));
          const p = f && model.predictScreenFromVector(f.vector);
          if (!p) continue;
          sx.push(p.x - target.x);
          sy.push(p.y - target.y);
        }
      }
      dx.push(Math.abs(mean(sx)));
      dy.push(Math.abs(mean(sy)) / LINE_PX);
    }
    return { dx: mean(dx), dy: mean(dy) };
  };
  const withHeadRotation = [...GAZE_EXCLUDED_FEATURES].filter((n) => n !== 'yaw' && n !== 'pitch');
  /** Roll and head position fitted as features, no distance compensation (as before it existed). */
  const withHeadPosition = [...GAZE_EXCLUDED_FEATURES].filter((n) => !['roll', 'tx', 'ty', 'tz', 'faceScale'].includes(n));

  it('excludes the whole head pose from the gaze', () => {
    for (const name of ['yaw', 'pitch', 'roll', 'tx', 'ty', 'tz', 'faceScale']) expect(GAZE_EXCLUDED_FEATURES.has(name), name).toBe(true);
  });

  it('leaning 6 or 10 cm in or back moves the gaze at most 0.45 lines (0.6–2.3 with head position as features)', () => {
    for (const world of ['W1', 'W3'] as const) {
      for (const tz of [-66, -54, -50]) {
        const now = shift([...GAZE_EXCLUDED_FEATURES], world, { tz });
        const before = shift(withHeadPosition, world, { tz });
        expect(now.dy, `${world} tz ${tz}`).toBeLessThanOrEqual(0.45);
        expect(before.dy, `${world} tz ${tz} with head position`).toBeGreaterThan(now.dy + 0.25);
      }
    }
  });

  it('sitting 3 cm to one side moves the gaze at most 0.4 lines (0.8+ with head position as features)', () => {
    for (const world of ['W1', 'W3'] as const) {
      const now = shift([...GAZE_EXCLUDED_FEATURES], world, { tx: 3 });
      const before = shift(withHeadPosition, world, { tx: 3 });
      expect(now.dy, world).toBeLessThanOrEqual(0.4);
      expect(before.dy, `${world} with head position`).toBeGreaterThan(now.dy + 0.3);
    }
  });

  it('a 4° chin drop after calibration moves the gaze at most 1.35 lines (1.6+ with yaw/pitch as features)', () => {
    for (const world of ['W1', 'W3'] as const) {
      const now = shift([...GAZE_EXCLUDED_FEATURES], world, { pitch: 8 * DEG });
      const before = shift(withHeadRotation, world, { pitch: 8 * DEG });
      expect(now.dy, world).toBeLessThanOrEqual(1.35);
      expect(before.dy, `${world} with yaw/pitch`).toBeGreaterThan(now.dy + 0.3);
    }
  });

  // ── with the calibration's head-movement step (PoseCompensation) ──
  const stepped = new Map<string, RidgeGazeModel>();
  /** The same calibrations after a head-movement step of the given size (default: nod 6°, turn 7°, tilt 5°). */
  const withStep = (world: WorldName, seed: number, step: MovementOptions = {}, label = 'full'): RidgeGazeModel => {
    const key = `${label}|${world}|${seed}`;
    let model = stepped.get(key);
    if (!model) {
      const base = calibrated([...GAZE_EXCLUDED_FEATURES], world, seed);
      const fitted = fitPoseCompensation(base, headMovementSession(seed, { noise: WORLDS[world].noise, ...step }), { maxBlink: 0.85 });
      model = fitted.ok ? fitted.model : base;
      stepped.set(key, model);
    }
    return model;
  };
  /** As `shift`, for any model per (world, seed). */
  const shiftOf = (modelOf: (seed: number) => RidgeGazeModel, world: WorldName, pose: Pose): { dx: number; dy: number } => {
    const noise = WORLDS[world].noise;
    const dx: number[] = [];
    const dy: number[] = [];
    for (const seed of POSTURE_SEEDS) {
      const model = modelOf(seed);
      const r = rng(seed * 101);
      const sx: number[] = [];
      const sy: number[] = [];
      for (const target of READING_POINTS) {
        for (let i = 0; i < 2; i++) {
          const f = frameFeatures(makeFrame(target, headFollow(target, pose), { h: 0.1 * DEG * gauss(r), v: 0.1 * DEG * gauss(r) }, {}, r, noise));
          const p = f && model.predictScreenFromVector(f.vector);
          if (!p) continue;
          sx.push(p.x - target.x);
          sy.push(p.y - target.y);
        }
      }
      dx.push(Math.abs(mean(sx)));
      dy.push(Math.abs(mean(sy)) / LINE_PX);
    }
    return { dx: mean(dx), dy: mean(dy) };
  };
  const plain = (world: WorldName) => (seed: number) => calibrated([...GAZE_EXCLUDED_FEATURES], world, seed);
  const SLOUCHED: Pose = { ...neckPose(BASE_POSE, 0, 6 * DEG, 0), ty: BASE_POSE.ty - 3, tz: BASE_POSE.tz - 3 };
  const HEAD_ON_HAND: Pose = neckPose(BASE_POSE, 3 * DEG, 2 * DEG, 8 * DEG);

  it('with the head-movement step, a chin 4° or 8° lower, a head 2 cm lower and a slouch move the gaze at most 0.6 lines (1–3 without)', () => {
    for (const world of ['W1', 'W3'] as const) {
      const cases: [string, Pose, number][] = [
        ['chin −4°', { ...BASE_POSE, pitch: 8 * DEG }, 0.9],
        ['chin +4°', { ...BASE_POSE, pitch: 0 }, 0.9],
        ['chin −8°', { ...BASE_POSE, pitch: 12 * DEG }, 1.7],
        ['down 2 cm', { ...BASE_POSE, ty: -7 }, 0.45],
        ['slouched', SLOUCHED, 2],
      ];
      for (const [label, pose, without] of cases) {
        const now = shiftOf((seed) => withStep(world, seed), world, pose);
        const before = shiftOf(plain(world), world, pose);
        expect(now.dy, `${world} ${label}`).toBeLessThanOrEqual(0.6);
        expect(before.dy, `${world} ${label} without the step`).toBeGreaterThan(without);
      }
    }
  });

  it('with the step, a 4° turn or tilt and a head resting on a hand move the gaze at most 30 px sideways (35–70 without)', () => {
    for (const world of ['W1', 'W3'] as const) {
      for (const [label, pose] of [['turn', { ...BASE_POSE, yaw: 4 * DEG }], ['tilt', { ...BASE_POSE, roll: 4 * DEG }], ['head on hand', HEAD_ON_HAND]] as [string, Pose][]) {
        const now = shiftOf((seed) => withStep(world, seed), world, pose);
        const before = shiftOf(plain(world), world, pose);
        expect(now.dx, `${world} ${label}`).toBeLessThanOrEqual(30);
        expect(before.dx, `${world} ${label} without the step`).toBeGreaterThan(34);
        expect(now.dy, `${world} ${label} vertical`).toBeLessThanOrEqual(0.45);
      }
    }
  });

  it('the step costs nothing in the calibration posture, and leaning in or back is corrected as before', () => {
    for (const world of ['W1', 'W3'] as const) {
      const still = shiftOf((seed) => withStep(world, seed), world, { ...BASE_POSE });
      const stillBefore = shiftOf(plain(world), world, { ...BASE_POSE });
      expect(still.dy, world).toBeLessThanOrEqual(stillBefore.dy + 0.08);
      for (const tz of [-66, -54]) expect(shiftOf((seed) => withStep(world, seed), world, { ...BASE_POSE, tz }).dy, `${world} tz ${tz}`).toBeLessThanOrEqual(0.5);
    }
  });

  it('a step of nods only teaches nodding: a chin drop is corrected, a turn is left as it was', () => {
    const nods = { turnDeg: 0, tiltDeg: 0 };
    const fitted = fitPoseCompensation(calibrated([...GAZE_EXCLUDED_FEATURES], 'W1', 1), headMovementSession(1, { noise: WORLDS.W1.noise, ...nods }), { maxBlink: 0.85 });
    expect(fitted.ok && fitted.fit.learned).toEqual({ a: false, b: true, roll: false });
    const chin = shiftOf((seed) => withStep('W1', seed, nods, 'nods'), 'W1', { ...BASE_POSE, pitch: 8 * DEG });
    expect(chin.dy).toBeLessThanOrEqual(0.5);
    const turn = shiftOf((seed) => withStep('W1', seed, nods, 'nods'), 'W1', { ...BASE_POSE, yaw: 4 * DEG });
    const turnBefore = shiftOf(plain('W1'), 'W1', { ...BASE_POSE, yaw: 4 * DEG });
    expect(Math.abs(turn.dx - turnBefore.dx)).toBeLessThan(8);
  });

  it('a head that hardly moves teaches nothing, and small nods (3°) still do', () => {
    const base = calibrated([...GAZE_EXCLUDED_FEATURES], 'W1', 2);
    const still = fitPoseCompensation(base, headMovementSession(2, { noise: WORLDS.W1.noise, nodDeg: 0.5, turnDeg: 0.5, tiltDeg: 0.3 }), { maxBlink: 0.85 });
    expect(still).toEqual({ ok: false, reason: 'still' });
    expect(fitPoseCompensation(base, headMovementSession(2, { noise: WORLDS.W1.noise }).slice(0, 12), { maxBlink: 0.85 })).toEqual({ ok: false, reason: 'too-few' });
    const small = shiftOf((seed) => withStep('W1', seed, { nodDeg: 3, turnDeg: 3.5, tiltDeg: 3 }, 'small'), 'W1', { ...BASE_POSE, pitch: 8 * DEG });
    expect(small.dy).toBeLessThanOrEqual(0.7);
  });

  it('holds the correction beyond the movement it was fitted on instead of extrapolating', () => {
    const model = withStep('W1', 1);
    const pose = model.poseCompensation!;
    expect(pose.maxAngle).toBeGreaterThan(5 * DEG);
    expect(pose.maxAngle).toBeLessThanOrEqual(20 * DEG);
    const at = (pitchDeg: number): number => {
      const r = rng(77);
      const ys: number[] = [];
      for (let i = 0; i < 30; i++) {
        const f = frameFeatures(makeFrame({ x: VIEW.width / 2, y: VIEW.height / 2 }, { ...BASE_POSE, pitch: BASE_POSE.pitch + pitchDeg * DEG }, { h: 0, v: 0 }, {}, r, WORLDS.W1.noise));
        const withPose = f && model.predictScreenFromVector(f.vector);
        const without = f && calibrated([...GAZE_EXCLUDED_FEATURES], 'W1', 1).predictScreenFromVector(f.vector);
        if (withPose && without) ys.push(withPose.y - without.y);
      }
      return mean(ys);
    };
    // The correction applied at 25° and at 30° of pitch is the same: it stopped growing at the limit.
    expect(Math.abs(at(30) - at(25))).toBeLessThan(6);
    expect(Math.abs(at(25))).toBeGreaterThan(Math.abs(at(4)) * 1.5);
  });

  it('a model saved before this, or with the step skipped, predicts exactly as it did', () => {
    const base = calibrated([...GAZE_EXCLUDED_FEATURES], 'W1', 3);
    expect(base.poseCompensation?.gain).toEqual([0, 0, 0, 0]);
    const json = JSON.parse(JSON.stringify(base.toJSON())) as Record<string, unknown>;
    delete json.pose;
    const old = deserializeGazeModel(json, { featureLength: FEATURE_NAMES.length })!;
    expect(old.poseCompensation).toBeNull();
    const r = rng(5);
    for (const pitch of [0, 8 * DEG]) {
      const f = frameFeatures(makeFrame({ x: 400, y: 300 }, { ...BASE_POSE, pitch }, { h: 0, v: 0 }, {}, r, WORLDS.W1.noise))!;
      expect(old.predictScreenFromVector(f.vector)).toEqual(base.predictScreenFromVector(f.vector));
    }
    // A stored correction comes back as it was; a damaged one is dropped, not the model.
    const fitted = withStep('W1', 3);
    const back = deserializeGazeModel(JSON.parse(JSON.stringify(fitted.toJSON())), { featureLength: FEATURE_NAMES.length })!;
    expect(back.poseCompensation).toEqual(fitted.poseCompensation);
    const damaged = JSON.parse(JSON.stringify(fitted.toJSON())) as { pose: { gain: unknown } };
    damaged.pose.gain = [1e9, 0, 0, 0];
    expect(deserializeGazeModel(damaged, { featureLength: FEATURE_NAMES.length })?.poseCompensation).toBeNull();
    // And a quick refresh keeps it.
    const refreshed = refineGazeModel(fitted, calibrationSession(9, { noise: WORLDS.W1.noise, targets: [{ x: 0.5, y: 0.5 }, { x: 0.15, y: 0.15 }, { x: 0.85, y: 0.15 }, { x: 0.15, y: 0.85 }, { x: 0.85, y: 0.85 }] }), { viewport: { ...VIEW }, maxBlink: 0.85 }).model;
    expect(refreshed.poseCompensation?.gain).toEqual(fitted.poseCompensation?.gain);
  });

  it('a 4° head turn moves the gaze at most 60 px sideways (70+ with yaw/pitch as features)', () => {
    for (const world of ['W1', 'W3'] as const) {
      const now = shift([...GAZE_EXCLUDED_FEATURES], world, { yaw: 4 * DEG });
      const before = shift(withHeadRotation, world, { yaw: 4 * DEG });
      expect(now.dx, world).toBeLessThanOrEqual(60);
      expect(before.dx, `${world} with yaw/pitch`).toBeGreaterThan(now.dx + 15);
    }
  });
});
