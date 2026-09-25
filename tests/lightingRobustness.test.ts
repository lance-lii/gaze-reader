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
  GAZE_MODEL_KIND,
  calibrationUpgradeNeeded,
  deserializeGazeModel,
  measureOffset,
  refineGazeModel,
} from '../src/gaze/calibrationModel';
import { FEATURE_NAMES } from '../src/gaze/features';
import type { LightingSignature } from '../src/types';
import { QUICK_TARGETS, READING_POINTS, VIEW, WORLDS, calibrationSession, pairedReadingFrames, type WorldName } from '../bench/lighting/faceSim';
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
