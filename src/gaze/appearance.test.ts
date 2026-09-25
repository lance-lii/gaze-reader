import { describe, expect, it } from 'vitest';
import type { AppearanceBaseline, EyeFeatures } from '../types';
import {
  AppearanceMonitor,
  EwRegression,
  buildAppearanceBaseline,
  expectedOpenness,
  parseAppearanceBaseline,
  type AppearanceChange,
  type AppearanceInput,
  type AppearanceMonitorOptions,
  type AppearanceSample,
} from './appearance';
import { Rng, expressionSchedule, simulateCalibration, simulateReading, type ReaderSimOptions, type SimFrame } from './appearanceSim';

// ─────────────────────────────── helpers ───────────────────────────────

const STEP = 300_000;

interface Outcome {
  changes: AppearanceChange[];
  monitor: AppearanceMonitor;
  frames: SimFrame[];
}

/** A simulated reader: calibrate, then read with the monitor watching. */
function read(
  sim: Partial<ReaderSimOptions> & { seed: number; durationMs: number },
  opts: AppearanceMonitorOptions = {},
  knownPitch = true,
  edit?: (f: SimFrame, monitor: AppearanceMonitor) => void,
): Outcome {
  const cal = simulateCalibration(sim);
  const baseline = buildAppearanceBaseline(cal.samples);
  if (!baseline) throw new Error('no baseline');
  const monitor = new AppearanceMonitor(baseline, knownPitch ? { referencePitch: cal.pitch, ...opts } : opts);
  const frames = simulateReading(sim);
  const changes: AppearanceChange[] = [];
  for (const f of frames) {
    edit?.(f, monitor);
    const c = monitor.update(f);
    if (c) changes.push(c);
  }
  return { changes, monitor, frames };
}

const SEEDS = [1, 2, 3, 4];

function features(openness: number, extra: Partial<EyeFeatures> = {}): EyeFeatures {
  return {
    vector: [],
    headPose: { yaw: 0, pitch: 0, roll: 0, tx: 0, ty: 0, tz: -60 },
    blink: 0.1,
    openness,
    faceScale: 0.11,
    faceCenter: { x: 0.5, y: 0.5 },
    ...extra,
  };
}

const BASE: AppearanceBaseline = {
  v: 1,
  n: 300,
  opennessAt0: 0.31,
  opennessSlope: -0.1,
  opennessResidualSd: 0.012,
  squintMedian: 0.1,
  squintSd: 0.03,
};

// ─────────────────────────────── baseline ───────────────────────────────

describe('buildAppearanceBaseline', () => {
  it('fits the lid line robustly (blinks and glitches barely move it)', () => {
    const rng = new Rng(3);
    const samples: AppearanceSample[] = [];
    for (const y of [0.05, 0.275, 0.5, 0.725, 0.95]) {
      for (let i = 0; i < 80; i++) {
        const glitch = rng.next() < 0.08; // half-blinks that passed the calibration filter
        samples.push({ yNorm: y, openness: glitch ? 0.05 : 0.31 - 0.1 * y + 0.012 * rng.normal(), squint: 0.1 + 0.03 * rng.normal(), blink: 0.1 });
      }
    }
    samples.push({ yNorm: 0.5, openness: 0.02, blink: 0.9 }); // a blink the filter drops
    const b = buildAppearanceBaseline(samples)!;
    expect(b.opennessAt0).toBeCloseTo(0.31, 2);
    expect(b.opennessSlope).toBeCloseTo(-0.1, 1);
    expect(Math.abs(b.opennessSlope + 0.1)).toBeLessThan(0.01);
    expect(b.opennessResidualSd).toBeGreaterThan(0.009);
    expect(b.opennessResidualSd).toBeLessThan(0.016);
    expect(b.squintMedian).toBeCloseTo(0.1, 1);
    expect(b.squintSd).toBeGreaterThan(0.02);
    expect(b.n).toBe(400);
    expect(expectedOpenness(b, 0.5)).toBeCloseTo(0.26, 2);
  });

  it('agrees with the simulated calibration and needs enough, spread-out data', () => {
    const cal = simulateCalibration({ seed: 5 });
    const b = buildAppearanceBaseline(cal.samples)!;
    expect(b.opennessSlope).toBeLessThan(-0.08); // lids lower toward the bottom
    expect(b.opennessAt0).toBeGreaterThan(0.28);
    const oneRow = cal.samples.filter((s) => s.yNorm === 0.5);
    expect(buildAppearanceBaseline(oneRow)).toBeNull();
    expect(buildAppearanceBaseline(cal.samples.slice(0, 10))).toBeNull();
    expect(buildAppearanceBaseline(cal.samples.map((s) => ({ ...s, openness: Number.NaN })))).toBeNull();
  });

  it('parses stored baselines and rejects damaged ones', () => {
    expect(parseAppearanceBaseline(JSON.parse(JSON.stringify(BASE)))).toEqual(BASE);
    expect(parseAppearanceBaseline(null)).toBeNull();
    expect(parseAppearanceBaseline({ ...BASE, v: 2 })).toBeNull();
    expect(parseAppearanceBaseline({ ...BASE, opennessAt0: -0.1 })).toBeNull();
    expect(parseAppearanceBaseline({ ...BASE, opennessResidualSd: Number.NaN })).toBeNull();
    expect(parseAppearanceBaseline({ ...BASE, squintSd: -1 })).toBeNull();
  });
});

describe('EwRegression', () => {
  it('recovers coefficients, forgets old data, and moves its intercept on request', () => {
    const rng = new Rng(9);
    const fit = new EwRegression(3, 60_000, [1e-3, 1e-3, 1e-3]);
    const x = new Float64Array(3);
    for (let i = 0; i < 6000; i++) {
      x[0] = 1;
      x[1] = rng.next() - 0.5;
      x[2] = 0.05 * rng.normal();
      fit.add(i * 33, x, 0.02 - 0.04 * x[1] + 0.3 * x[2] + 0.005 * rng.normal(), 0);
    }
    fit.solve();
    const [a, b, c] = fit.coefficients;
    expect(a).toBeCloseTo(0.02, 3);
    expect(b).toBeCloseTo(-0.04, 2);
    expect(c).toBeCloseTo(0.3, 1);
    fit.shiftIntercept(0.01);
    fit.solve();
    expect(fit.coefficients[0]).toBeCloseTo(0.03, 3);
    expect(fit.coefficients[1]).toBeCloseTo(-0.04, 2);
    // New data with another level wins over time (τ = 60 s).
    for (let i = 6000; i < 12_000; i++) {
      x[1] = rng.next() - 0.5;
      x[2] = 0;
      fit.add(i * 33, x, -0.05 - 0.04 * x[1], 0);
    }
    fit.solve();
    expect(fit.coefficients[0]).toBeCloseTo(-0.05, 2);
  });
});

// ─────────────────────────────── monitor ───────────────────────────────

describe('AppearanceMonitor', () => {
  it('does nothing without a baseline', () => {
    const m = new AppearanceMonitor(null);
    expect(m.state).toBe('off');
    for (let t = 0; t < 5000; t += 33) expect(m.update({ t, features: features(0.1), quality: 0.9, gazeYNorm: 0.5 })).toBeNull();
    expect(m.residualZ).toBeNull();
  });

  it('stays quiet through 10 minutes of normal reading (page turns, return sweeps, blinks, posture, glances away)', () => {
    let total = 0;
    for (const seed of [1, 2, 3]) {
      const { changes, monitor } = read({ seed, durationMs: 600_000 });
      total += changes.length;
      expect(monitor.state).toBe('watching');
      expect(Math.abs(monitor.levelVsCalibration)).toBeLessThan(0.1);
    }
    expect(total).toBe(0);
  });

  it('reports a 10 % squint (bright light) within about 2 s, dated to its onset', () => {
    for (const seed of SEEDS) {
      const { changes } = read({ seed, durationMs: STEP + 20_000, lidChanges: [{ at: STEP, factor: 0.9 }] });
      expect(changes, `seed ${seed}`).toHaveLength(1);
      const c = changes[0];
      expect(c.reason).toBe('lids');
      expect(c.direction).toBe('narrower');
      expect(c.detectedAt - STEP).toBeGreaterThanOrEqual(1500);
      expect(c.detectedAt - STEP).toBeLessThanOrEqual(2600);
      expect(Math.abs(c.t - STEP)).toBeLessThanOrEqual(600);
      expect(c.relativeShift).toBeLessThan(-0.05);
      expect(c.relativeShift).toBeGreaterThan(-0.2);
      expect(c.detail).toMatch(/^Eyes narrower: openness -\d+%/);
    }
  });

  it('reports dim light: a light-driven squint relaxing widens the eyes', () => {
    for (const seed of SEEDS) {
      let before = Number.NaN;
      const { changes, monitor } = read(
        { seed, durationMs: STEP + 20_000, lidChanges: [{ at: 0, factor: 0.9, rampMs: 1 }, { at: STEP, factor: 1 / 0.9 }] },
        {},
        true,
        (f, m) => {
          if (Number.isNaN(before) && f.t >= STEP) before = m.levelVsCalibration;
        },
      );
      expect(changes, `seed ${seed}`).toHaveLength(1);
      expect(changes[0].direction).toBe('wider');
      expect(changes[0].detectedAt - STEP).toBeLessThanOrEqual(3500);
      expect(before).toBeLessThan(-0.06); // squinting since the session started: learned, not reported
      expect(monitor.levelVsCalibration - before).toBeGreaterThan(0.02); // re-anchored upward after the release
    }
  });

  it('reports a lasting squint once, and its end once', () => {
    for (const seed of SEEDS) {
      const { changes } = read({ seed, durationMs: 480_000, lidChanges: [{ at: 120_000, factor: 0.9 }, { at: 400_000, factor: 1 / 0.9 }] });
      expect(changes.map((c) => c.direction), `seed ${seed}`).toEqual(['narrower', 'wider']);
      expect(changes[0].detectedAt).toBeLessThan(127_000);
      expect(changes[1].detectedAt).toBeLessThan(407_000);
    }
  });

  it('ignores head nods, posture shifts, blink bursts and glances at the keyboard', () => {
    const stress: Partial<ReaderSimOptions>[] = [
      { nodEveryMs: 10_000 },
      { postureEveryMs: 30_000 },
      { blinkBurstEveryMs: 20_000 },
      { lookAwayEveryMs: 30_000 },
    ];
    for (const extra of stress) {
      for (const seed of [1, 2, 3]) {
        const { changes } = read({ seed, durationMs: 600_000, ...extra });
        expect(changes, `${JSON.stringify(extra)} seed ${seed}`).toEqual([]);
      }
    }
  });

  it('works without the eyeSquint blendshape and with the calibration pitch unknown', () => {
    const noSquint = read({ seed: 2, durationMs: STEP + 20_000, squint: false, lidChanges: [{ at: STEP, factor: 0.88 }] });
    expect(noSquint.changes.map((c) => c.channel)).toEqual(['openness']);
    expect(noSquint.monitor.squintZ).toBeNull();
    const learned = read({ seed: 1, durationMs: STEP + 20_000, lidChanges: [{ at: STEP, factor: 0.9 }] }, {}, false);
    expect(learned.changes).toHaveLength(1);
    const early = new AppearanceMonitor(BASE);
    early.update({ t: 0, features: features(0.26), quality: 0.9, gazeYNorm: 0.5 });
    expect(early.state).toBe('learning');
  });

  it('has no opinion while the face is lost, and reports a change that happened meanwhile on return', () => {
    const lost = (f: SimFrame): void => {
      if (f.t >= STEP && f.t < STEP + 5000) {
        f.features = null;
        f.quality = 0;
      }
    };
    // Seeds 2–4: after the gap the "before" level is old, so the openness evidence is weaker; with
    // seed 1 it stays under 1.5 SDs and the eyeSquint rise alone no longer counts (see the next test).
    for (const seed of [2, 3, 4]) {
      const { changes, monitor } = read({ seed, durationMs: STEP + 20_000, lidChanges: [{ at: STEP + 1000, factor: 0.9 }] }, {}, true, lost);
      expect(changes, `seed ${seed}`).toHaveLength(1);
      expect(changes[0].detectedAt).toBeGreaterThan(STEP + 5000);
      expect(changes[0].detectedAt).toBeLessThan(STEP + 8000);
      expect(['watching', 'unknown'], `seed ${seed}`).toContain(monitor.state); // unknown: no earlier level at this gaze height since the change
    }
  });

  it('does not take smiles, frowns or concentration (eyeSquint rising while the lids barely move) for light', () => {
    let frownEvents = 0;
    let frownEventsUngated = 0;
    let smileEvents = 0;
    let smileEventsUngated = 0;
    for (const seed of SEEDS) {
      const frowns = expressionSchedule(seed, 600_000, 60_000, { durationMs: 3000, squint: 0.1, lidFactor: 1 });
      const smiles = expressionSchedule(seed, 600_000, 60_000, { durationMs: 2500, squint: 0.2, lidFactor: 0.95 });
      expect(frowns.length).toBeGreaterThan(4);
      frownEvents += read({ seed, durationMs: 600_000, expressions: frowns }).changes.length;
      frownEventsUngated += read({ seed, durationMs: 600_000, expressions: frowns }, { squintNeedsOpennessZ: -Infinity }).changes.length;
      smileEvents += read({ seed, durationMs: 600_000, expressions: smiles }).changes.length;
      smileEventsUngated += read({ seed, durationMs: 600_000, expressions: smiles }, { squintNeedsOpennessZ: -Infinity }).changes.length;
    }
    // eyeSquint counts only when the lid aperture agrees by ≥ 1.5 SDs.
    expect(frownEvents).toBe(0);
    expect(frownEventsUngated).toBeGreaterThan(20); // without that gate nearly every frown was a "light change"
    expect(smileEvents).toBeLessThan(0.5 * smileEventsUngated); // a smile also narrows the lids a little: fewer, not none
  });

  it('stretches its median window on a slow camera (up to 1.5 s), without false alarms', () => {
    const at = (fps: number): number => read({ seed: 1, durationMs: 20_000, fps }).monitor.windowMs;
    expect(at(30)).toBe(1000);
    expect(at(15)).toBeCloseTo(22 * (1000 / 15), 0);
    expect(at(10)).toBe(1500);
    expect(read({ seed: 1, durationMs: 20_000, fps: 15 }, { maxWindowMs: 1000 }).monitor.windowMs).toBe(1000);
    for (const seed of [1, 2, 3]) expect(read({ seed, durationMs: 600_000, fps: 15 }).changes, `seed ${seed}`).toEqual([]);
  });

  it('ignores blinks, low-quality frames and gaze outside the calibrated range', () => {
    const m = new AppearanceMonitor(BASE, { referencePitch: 0 });
    const rng = new Rng(4);
    let t = 0;
    const step = (input: Omit<AppearanceInput, 't'>): AppearanceChange | null => m.update({ t: (t += 33), ...input });
    const open = (y: number): number => BASE.opennessAt0 + BASE.opennessSlope * y + 0.01 * rng.normal();
    for (let i = 0; i < 1800; i++) {
      const y = 0.1 + 0.8 * ((i % 600) / 600);
      let change: AppearanceChange | null;
      if (i % 40 < 6) change = step({ features: features(0.02, { blink: 0.95 }), quality: 0.9, gazeYNorm: y }); // blinks
      else if (i % 97 < 10) change = step({ features: features(0.05), quality: 0.1, gazeYNorm: y }); // bad frames
      else if (i % 300 > 280) change = step({ features: features(0.1), quality: 0.9, gazeYNorm: 1.6 }); // keyboard
      else change = step({ features: features(open(y), { squint: 0.1 }), quality: 0.9, gazeYNorm: y });
      expect(change).toBeNull();
    }
    expect(m.residualZ).not.toBeNull();
    expect(Math.abs(m.residualZ!)).toBeLessThan(3);
  });

  it('exposes an early warning while a shift is being confirmed', () => {
    const cal = simulateCalibration({ seed: 3 });
    const m = new AppearanceMonitor(buildAppearanceBaseline(cal.samples), { referencePitch: cal.pitch });
    let pending: number | null = null;
    for (const f of simulateReading({ seed: 3, durationMs: STEP + 5000, lidChanges: [{ at: STEP, factor: 0.85 }] })) {
      const c = m.update(f);
      if (c) break;
      if (m.pendingShiftSince !== null && f.t > STEP) pending ??= m.pendingShiftSince;
    }
    expect(pending).not.toBeNull();
    expect(Math.abs((pending as number) - STEP)).toBeLessThan(800);
    expect(m.state).toBe('settling');
    expect(m.diagnostics.frames).toBeGreaterThan(10);
  });

  it('starts over on reset() and setBaseline()', () => {
    const { monitor } = read({ seed: 1, durationMs: 60_000 });
    expect(monitor.residualZ).not.toBeNull();
    monitor.reset();
    expect(monitor.residualZ).toBeNull();
    expect(monitor.levelVsCalibration).toBe(0);
    monitor.setBaseline(null);
    expect(monitor.state).toBe('off');
    monitor.setBaseline(BASE, 0.1);
    expect(monitor.state).toBe('unknown');
  });

  it('is cheap per frame', () => {
    const frames = simulateReading({ seed: 7, durationMs: 600_000 });
    const cal = simulateCalibration({ seed: 7 });
    const m = new AppearanceMonitor(buildAppearanceBaseline(cal.samples), { referencePitch: cal.pitch });
    for (const f of frames.slice(0, 3000)) m.update(f); // warm up
    const t0 = performance.now();
    for (const f of frames.slice(3000)) m.update(f);
    const us = ((performance.now() - t0) / (frames.length - 3000)) * 1000;
    console.info(`[appearance cost] ${us.toFixed(2)} µs per frame`);
    expect(us).toBeLessThan(50);
  });
});
