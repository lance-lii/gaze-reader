import { describe, expect, it } from 'vitest';
import type { CalibrationEnvironment, FeatureFrame, LightingStats } from '../../src/types';
import { buildLightingSignature } from '../../src/gaze/lighting';
import { buildAppearanceBaseline } from '../../src/gaze/appearance';
import { simulateCalibration, simulateReading, type ReaderSimOptions } from '../../src/gaze/appearanceSim';
import { ConditionsWatch, type ConditionsUpdate } from './conditions';
import { lightingAdvice, lightingTip } from './lightingTips';

/** Office light, evenly lit (the numbers the offscreen document's LightingProbe sends). */
const OFFICE: LightingStats = {
  faceLuma: 0.5,
  faceLin: 0.2,
  faceRange: 1.5,
  faceClip: 0,
  frameLin: 0.18,
  bgLin: 0.18,
  bgClip: 0,
  scleraR: 0.3,
  scleraL: 0.3,
  backlight: 1.2,
  side: 0.1,
  shade: -0.8,
  glareR: 0.001,
  glareL: 0.001,
  irisGlintR: 0,
  irisGlintL: 0,
  facePx: 5000,
};
/** A desk lamp to the reader's left: one cheek much brighter, harsher contrast. */
const LAMP: LightingStats = { ...OFFICE, side: 1.4, faceRange: 2.3 };

const WARM_UP = 60_000;

function environment(seed: number): CalibrationEnvironment {
  const cal = simulateCalibration({ seed });
  const lighting = buildLightingSignature(Array.from({ length: 40 }, () => ({ stats: OFFICE, yaw: 0, pitch: cal.pitch })));
  return { lighting, appearance: buildAppearanceBaseline(cal.samples), capturedAt: 0 };
}

interface Run {
  updates: (ConditionsUpdate & { at: number })[];
  watch: ConditionsWatch;
}

/**
 * A simulated reader (appearanceSim: lids that follow gaze, blinks, nods,
 * glances away) with lighting measured on every 5th frame (6 Hz at 30 fps),
 * the light switching as `light(t)` says.
 */
function run(
  sim: Partial<ReaderSimOptions> & { seed: number; durationMs: number },
  light: (t: number) => LightingStats,
  env: CalibrationEnvironment | null = environment(sim.seed),
): Run {
  const watch = new ConditionsWatch(env);
  const updates: Run['updates'] = [];
  let i = 0;
  for (const f of simulateReading(sim)) {
    const frame: FeatureFrame = {
      t: f.t,
      faceFound: f.features !== null,
      features: f.features,
      quality: f.quality,
      ...(i++ % 5 === 0 && f.features ? { lighting: light(f.t) } : {}),
    };
    const u = watch.onFrame(frame, f.gazeYNorm);
    if (u.lighting || u.appearance || u.lightingChanged || u.lids) updates.push({ ...u, at: f.t });
  }
  return { updates, watch };
}

const appearances = (r: Run) => r.updates.flatMap((u) => (u.appearance ? [{ ...u.appearance, at: u.at }] : []));

describe('ConditionsWatch', () => {
  it('reports the lighting about once a second and stays quiet while nothing changes', () => {
    const r = run({ seed: 1, durationMs: 30_000 }, () => OFFICE);
    const states = r.updates.filter((u) => u.lighting);
    expect(states.length).toBeGreaterThanOrEqual(28);
    expect(states.length).toBeLessThanOrEqual(31);
    expect(appearances(r)).toEqual([]);
    expect(r.updates.some((u) => u.lightingChanged)).toBe(false);
    expect(r.watch.lightingState).toMatchObject({ flags: [], changedSinceCalibration: false });
    expect(r.watch.lightingState.distance).toBeLessThan(0.2);
    expect(r.watch.watching).toEqual({ lighting: true, lids: true });
  });

  it('turns a lighting change into one appearance change dated to its onset, plus what changed', () => {
    const r = run({ seed: 2, durationMs: WARM_UP + 20_000 }, (t) => (t < WARM_UP ? OFFICE : LAMP));
    const events = appearances(r);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: 'lighting' });
    expect(Math.abs(events[0].t - WARM_UP)).toBeLessThanOrEqual(500);
    // The watch holds a change for 5 s over a 10-s rolling signature before believing it.
    expect(events[0].at - WARM_UP).toBeGreaterThanOrEqual(5_000);
    expect(events[0].at - WARM_UP).toBeLessThanOrEqual(11_000);
    const changed = r.updates.filter((u) => u.lightingChanged).map((u) => u.lightingChanged);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ dominant: 'side' });
    expect(changed[0]!.z).toBeGreaterThan(1);
    expect(r.watch.lightingState).toMatchObject({ changedSinceCalibration: true, dominant: 'side' });
  });

  it('reports a second change while already changed (lamp on, then the overhead light off), in the same offer episode', () => {
    const OVERHEAD_OFF: LightingStats = { ...LAMP, scleraR: LAMP.scleraR * 2 ** -1.5, scleraL: LAMP.scleraL * 2 ** -1.5, backlight: LAMP.backlight + 1 };
    const AGAIN = WARM_UP + 30_000;
    const r = run({ seed: 2, durationMs: AGAIN + 20_000 }, (t) => (t < WARM_UP ? OFFICE : t < AGAIN ? LAMP : OVERHEAD_OFF));
    const events = appearances(r);
    expect(events.map((e) => e.reason)).toEqual(['lighting', 'lighting']);
    expect(events[1]!.detail).toMatch(/again/);
    expect(Math.abs(events[1]!.t - AGAIN)).toBeLessThanOrEqual(2_000);
    expect(events[1]!.at - AGAIN).toBeLessThanOrEqual(12_000);
    // One episode for the touch-up offer: still changed since calibration, not a new first change.
    expect(r.updates.filter((u) => u.lightingChanged)).toHaveLength(1);
    expect(r.watch.lightingState.changedSinceCalibration).toBe(true);
  });

  it('reports a lamp that makes the reader squint once: the eyelids see it first', () => {
    for (const seed of [1, 3]) {
      const r = run(
        { seed, durationMs: WARM_UP + 20_000, lidChanges: [{ at: WARM_UP, factor: 0.9 }] },
        (t) => (t < WARM_UP ? OFFICE : LAMP),
      );
      const events = appearances(r);
      expect(events.map((e) => e.reason), `seed ${seed}`).toEqual(['lids']);
      expect(Math.abs(events[0]!.t - WARM_UP)).toBeLessThanOrEqual(700);
      expect(events[0]!.at - WARM_UP).toBeLessThanOrEqual(3_000);
      // The touch-up offer still hears that the light is different from calibration.
      expect(r.updates.filter((u) => u.lightingChanged)).toHaveLength(1);
    }
  });

  it('reports the light going back to how it was at calibration, unless the eyelids just did', () => {
    const back = run({ seed: 2, durationMs: 130_000 }, (t) => (t < WARM_UP || t >= 100_000 ? OFFICE : LAMP));
    const events = appearances(back);
    expect(events.map((e) => e.reason)).toEqual(['lighting', 'lighting']);
    expect(events[1]!.detail).toMatch(/back/);
    expect(events[1]!.at).toBeGreaterThan(100_000);
    expect(events[1]!.t).toBeLessThan(events[1]!.at);
    expect(back.watch.lightingState.changedSinceCalibration).toBe(false);

    // Squinting at a lamp from the start (learned, not reported), then lamp off and eyes relax together.
    const relax = run(
      { seed: 1, durationMs: 130_000, lidChanges: [{ at: 0, factor: 0.9, rampMs: 1 }, { at: 100_000, factor: 1 / 0.9 }] },
      (t) => (t < 100_000 ? LAMP : OFFICE),
    );
    const reasons = appearances(relax).map((e) => [e.reason, e.at >= 100_000] as const);
    expect(reasons).toEqual([
      ['lighting', false], // the lamp, once the watch had enough samples
      ['lids', true], // lamp off: the eyes widen within ~2 s; the lighting's own 'restored' is the same change
    ]);
  });

  it('without a calibration to compare with: flags for coaching, but no changes', () => {
    const glare = { ...OFFICE, glareR: 0.06 };
    const r = run({ seed: 1, durationMs: 40_000, lidChanges: [{ at: 25_000, factor: 0.85 }] }, () => glare, null);
    expect(appearances(r)).toEqual([]);
    expect(r.watch.lightingState).toMatchObject({ flags: ['glare'], distance: null, changedSinceCalibration: false });
    expect(r.watch.watching).toEqual({ lighting: false, lids: false });
  });

  it('starts over against a new calibration, and after a camera restart', () => {
    const r = run({ seed: 2, durationMs: WARM_UP + 20_000 }, (t) => (t < WARM_UP ? OFFICE : LAMP));
    expect(r.watch.lightingState.changedSinceCalibration).toBe(true);
    const cal = simulateCalibration({ seed: 2 });
    const lampSig = buildLightingSignature(Array.from({ length: 40 }, () => ({ stats: LAMP, yaw: 0, pitch: cal.pitch })));
    r.watch.setEnvironment({ lighting: lampSig, appearance: buildAppearanceBaseline(cal.samples), capturedAt: 1 });
    expect(r.watch.lightingState.changedSinceCalibration).toBe(false);
    r.watch.reset();
    expect(r.watch.lightingState).toEqual({ flags: [], distance: null, changedSinceCalibration: false, dominant: null });
    expect(r.watch.watching).toEqual({ lighting: true, lids: true });
    r.watch.setEnvironment(null);
    expect(r.watch.watching).toEqual({ lighting: false, lids: false });
  });

  it('ignores frames without a usable time, and lets flags go stale on its own tick', () => {
    const w = new ConditionsWatch(null);
    const frame = (t: number): FeatureFrame => ({ t, faceFound: false, features: null, quality: 0, lighting: { ...OFFICE, scleraR: 0.02, scleraL: 0.02 } });
    expect(w.onFrame(frame(Number.NaN), null).lighting).toBeNull();
    w.onFrame(frame(0), null); // no features: the lighting watch needs head pose, so nothing is learned
    expect(w.tick(1_000).lighting).toMatchObject({ flags: [] });
    expect(w.tick(1_500).lighting).toBeNull(); // at most once a second
  });
});

describe('lighting tips', () => {
  it('words the most important flag, briefly for a status line and fully for advice', () => {
    expect(lightingTip([])).toBeNull();
    expect(lightingAdvice([])).toBeNull();
    expect(lightingTip(['side-lit', 'backlit'])).toBe('bright light behind you');
    expect(lightingTip(['glare', 'dark'])).toBe('too dark');
    expect(lightingAdvice(['glare'])).toMatch(/reflections on your glasses/);
    for (const flag of ['dark', 'overexposed', 'glare', 'backlit', 'side-lit', 'unstable'] as const) {
      expect(`Shaky: ${lightingTip([flag])!}`.length, flag).toBeLessThanOrEqual(32); // fits the pill's label
    }
  });
});
