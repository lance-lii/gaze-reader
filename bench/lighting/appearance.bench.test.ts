/**
 * Scoreboard for the eyelid-appearance monitor (src/gaze/appearance.ts) on the
 * simulated reader (src/gaze/appearanceSim.ts): false alarms per hour of normal
 * reading under several conditions, false alarms from facial expressions
 * (smiles, frowns, yawns: the gaze bias never changes, so every report is
 * false), and detection rate / latency for light-driven lid changes, including
 * the ones eyeSquint does not see (light mostly lowers the upper lid) at the
 * frame rates of dim rooms. Prints a table; asserts only loose sanity bounds.
 * Run with `npm run bench`.
 */
import { expect, it } from 'vitest';
import { AppearanceMonitor, buildAppearanceBaseline, type AppearanceChange, type AppearanceMonitorOptions } from '../../src/gaze/appearance';
import { expressionSchedule, simulateCalibration, simulateReading, type ExpressionEpisode, type ReaderSimOptions } from '../../src/gaze/appearanceSim';

const SEEDS = 24;
const NORMAL_MS = 600_000;
const STEP_AT = 300_000;
/** eyeSquint counts on its own, as in 1.0 (before the openness gate). */
const UNGATED: AppearanceMonitorOptions = { squintNeedsOpennessZ: -Infinity };
/** The median window never stretches on a slow camera, as in 1.0. */
const FIXED_WINDOW: AppearanceMonitorOptions = { maxWindowMs: 1000 };

function monitorFor(sim: Partial<ReaderSimOptions> & { seed: number }, mon: AppearanceMonitorOptions, usePitch = true): AppearanceMonitor {
  const cal = simulateCalibration(sim);
  const b = buildAppearanceBaseline(cal.samples);
  if (!b) throw new Error('no baseline');
  return new AppearanceMonitor(b, usePitch ? { referencePitch: cal.pitch, ...mon } : mon);
}

function falseAlarms(sim: Partial<ReaderSimOptions>, mon: AppearanceMonitorOptions = {}, usePitch = true): { perHour: number; events: number; minutes: number; usPerFrame: number } {
  let events = 0;
  let frames = 0;
  let ms = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const o = { seed, durationMs: NORMAL_MS, ...sim };
    const m = monitorFor(o, mon, usePitch);
    const fr = simulateReading(o);
    const t0 = performance.now();
    for (const f of fr) if (m.update(f)) events++;
    ms += performance.now() - t0;
    frames += fr.length;
  }
  const minutes = (SEEDS * NORMAL_MS) / 60_000;
  return { perHour: (events * 60) / minutes, events, minutes, usPerFrame: (ms / frames) * 1000 };
}

interface ExpressionScore {
  perHour: number;
  episodes: number;
  /** Episodes with a report during them or within 1 s after. */
  fired: number;
  wider: number;
}

/** One expression a minute (on average) through 10 minutes of reading, per simulated reader. */
function expressionAlarms(shape: Omit<ExpressionEpisode, 'at'>, mon: AppearanceMonitorOptions = {}, sim: Partial<ReaderSimOptions> = {}): ExpressionScore {
  let events = 0;
  let episodes = 0;
  let fired = 0;
  let wider = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const expressions = expressionSchedule(seed, NORMAL_MS, 60_000, shape);
    const o = { seed, durationMs: NORMAL_MS, expressions, ...sim };
    const m = monitorFor(o, mon);
    const got: AppearanceChange[] = [];
    for (const f of simulateReading(o)) {
      const e = m.update(f);
      if (e) got.push(e);
    }
    events += got.length;
    wider += got.filter((e) => e.direction === 'wider').length;
    episodes += expressions.length;
    for (const x of expressions) if (got.some((e) => e.detectedAt >= x.at && e.t <= x.at + x.durationMs + 1000)) fired++;
  }
  return { perHour: (events * 60) / ((SEEDS * NORMAL_MS) / 60_000), episodes, fired, wider };
}

interface Detection {
  hits: number;
  latencyMedian: number;
  latencyP90: number;
  onsetErrMedian: number;
}

function detection(lidChanges: ReaderSimOptions['lidChanges'], sim: Partial<ReaderSimOptions> = {}, mon: AppearanceMonitorOptions = {}): Detection {
  const lat: number[] = [];
  const onset: number[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const o = { seed, durationMs: STEP_AT + 30_000, lidChanges, ...sim };
    const m = monitorFor(o, mon);
    for (const f of simulateReading(o)) {
      const e = m.update(f);
      if (e && e.detectedAt >= STEP_AT && e.detectedAt - STEP_AT <= 10_000) {
        lat.push(e.detectedAt - STEP_AT);
        onset.push(Math.abs(e.t - STEP_AT));
        break;
      }
    }
  }
  const q = (xs: number[], p: number): number => {
    const a = [...xs].sort((x, y) => x - y);
    return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : NaN;
  };
  return { hits: lat.length, latencyMedian: q(lat, 0.5), latencyP90: q(lat, 0.9), onsetErrMedian: q(onset, 0.5) };
}

const fmt = (d: Detection): string =>
  `${String(d.hits).padStart(2)}/${SEEDS} detected, latency median ${(d.latencyMedian / 1000).toFixed(2)} s, p90 ${(d.latencyP90 / 1000).toFixed(2)} s, onset error median ${(d.onsetErrMedian / 1000).toFixed(2)} s`;

it('appearance monitor scoreboard', () => {
  const lines: string[] = [`Appearance monitor scoreboard (${SEEDS} simulated readers per row)`, '', 'False alarms, normal reading (10 min each):'];
  const fa: [string, Partial<ReaderSimOptions>, AppearanceMonitorOptions, boolean][] = [
    ['default reader', {}, {}, true],
    ['no eyeSquint blendshape', { squint: false }, {}, true],
    ['calibration pitch unknown (learned)', {}, {}, false],
    ['frame noise ×1.5', { noiseSd: 0.018 }, {}, true],
    ['viewport 14° (true Θ 0.25 rad)', { viewportAngleRad: 0.25 }, {}, true],
    ['viewport 26° (true Θ 0.45 rad)', { viewportAngleRad: 0.45 }, {}, true],
    ['nods every 10 s', { nodEveryMs: 10_000 }, {}, true],
    ['posture shifts every 30 s', { postureEveryMs: 30_000 }, {}, true],
    ['blink bursts every 30 s', { blinkBurstEveryMs: 30_000 }, {}, true],
    ['20 fps', { fps: 20 }, {}, true],
    ['15 fps', { fps: 15 }, {}, true],
    ['15 fps, 1-s window (1.0)', { fps: 15 }, FIXED_WINDOW, true],
    ['10 fps', { fps: 10 }, {}, true],
    ['10 fps, 1-s window (1.0)', { fps: 10 }, FIXED_WINDOW, true],
    ['no head motion', { nodEveryMs: 0, postureEveryMs: 0, pitchWanderDeg: 0, yawWanderDeg: 0 }, {}, true],
    ['default reader, zOn 3 / zOff 2', {}, { zOn: 3, zOff: 2 }, true],
    ['default reader, no pitch uncertainty', {}, { pitchUncertainty: 0 }, true],
  ];
  let defaultRate = NaN;
  let rate15 = NaN;
  let cost = 0;
  for (const [name, sim, mon, usePitch] of fa) {
    const r = falseAlarms(sim, mon, usePitch);
    if (name === 'default reader') {
      defaultRate = r.perHour;
      cost = r.usPerFrame;
    }
    if (name === '15 fps') rate15 = r.perHour;
    lines.push(`  ${name.padEnd(40)} ${String(r.events).padStart(3)} in ${r.minutes} min = ${r.perHour.toFixed(2)}/h`);
  }
  lines.push('', `update() cost: ${cost.toFixed(2)} µs per frame (node)`, '');

  // Facial expressions: eyeSquint (and the lids) move, the light and the gaze bias do not.
  lines.push('False alarms from facial expressions, one a minute (every report is false; "1.0" = eyeSquint counts alone):');
  const expressions: [string, Omit<ExpressionEpisode, 'at'>][] = [
    ['frown / concentration: eyeSquint +0.1, 3 s', { durationMs: 3000, squint: 0.1, lidFactor: 1 }],
    ['frown: eyeSquint +0.1, 5 s', { durationMs: 5000, squint: 0.1, lidFactor: 1 }],
    ['smile: eyeSquint +0.2, lids −5 %, 2.5 s', { durationMs: 2500, squint: 0.2, lidFactor: 0.95 }],
    ['smile: eyeSquint +0.2, lids −5 %, 5 s', { durationMs: 5000, squint: 0.2, lidFactor: 0.95 }],
    ['laugh: eyeSquint +0.35, lids −12 %, 3 s', { durationMs: 3000, squint: 0.35, lidFactor: 0.88 }],
    ['yawn: lids −35 %, 4 s', { durationMs: 4000, squint: 0, lidFactor: 0.65 }],
    ['drowsy heavy lids: −12 %, 20 s', { durationMs: 20_000, squint: 0, lidFactor: 0.88 }],
  ];
  const expressionRate: Record<string, number> = {};
  for (const [name, shape] of expressions) {
    const now = expressionAlarms(shape);
    const old = expressionAlarms(shape, UNGATED);
    expressionRate[name] = now.perHour;
    lines.push(
      `  ${name.padEnd(42)} ${now.perHour.toFixed(1).padStart(5)}/h (1.0: ${old.perHour.toFixed(1).padStart(5)}/h), ` +
        `episodes reported ${now.fired}/${now.episodes} (1.0: ${old.fired}), 'wider' reports ${now.wider} (1.0: ${old.wider})`,
    );
  }

  lines.push('', 'Detection (step at 5 min, counted if confirmed within 10 s):');
  const relax = (factor: number): ReaderSimOptions['lidChanges'] => [{ at: 0, factor, rampMs: 1 }, { at: STEP_AT, factor: 1 / factor }];
  const det: [string, ReaderSimOptions['lidChanges'], Partial<ReaderSimOptions>, AppearanceMonitorOptions][] = [
    ['squint 5 %', [{ at: STEP_AT, factor: 0.95 }], {}, {}],
    ['squint 7.5 %', [{ at: STEP_AT, factor: 0.925 }], {}, {}],
    ['squint 10 %', [{ at: STEP_AT, factor: 0.9 }], {}, {}],
    ['squint 15 %', [{ at: STEP_AT, factor: 0.85 }], {}, {}],
    ['squint 10 %, 1.0 (eyeSquint alone counts)', [{ at: STEP_AT, factor: 0.9 }], {}, UNGATED],
    ['squint 7.5 %, 1.0 (eyeSquint alone counts)', [{ at: STEP_AT, factor: 0.925 }], {}, UNGATED],
    ['squint 10 %, no eyeSquint blendshape', [{ at: STEP_AT, factor: 0.9 }], { squint: false }, {}],
    ['light dims: a 10 % squint relaxes', relax(0.9), {}, {}],
    ['pure widening 8 %', [{ at: STEP_AT, factor: 1.08 }], {}, {}],
    ['pure widening 10 %', [{ at: STEP_AT, factor: 1.1 }], {}, {}],
    ['pure widening 15 %', [{ at: STEP_AT, factor: 1.15 }], {}, {}],
    // Light mostly lowers the upper lid, where eyeSquint stays flat: openness alone must see it.
    ['upper lid only 7.5 %', [{ at: STEP_AT, factor: 0.925 }], { squintGain: 0 }, {}],
    ['upper lid only 10 %', [{ at: STEP_AT, factor: 0.9 }], { squintGain: 0 }, {}],
    ['upper lid only: a 10 % squint relaxes', relax(0.9), { squintGain: 0 }, {}],
    ['15 fps: squint 10 %', [{ at: STEP_AT, factor: 0.9 }], { fps: 15 }, {}],
    ['15 fps: upper lid only 7.5 %', [{ at: STEP_AT, factor: 0.925 }], { fps: 15, squintGain: 0 }, {}],
    ['15 fps: upper lid only 10 %', [{ at: STEP_AT, factor: 0.9 }], { fps: 15, squintGain: 0 }, {}],
    ['15 fps: upper lid only 10 %, 1-s window', [{ at: STEP_AT, factor: 0.9 }], { fps: 15, squintGain: 0 }, FIXED_WINDOW],
    ['15 fps: upper lid only, 10 % relaxes', relax(0.9), { fps: 15, squintGain: 0 }, {}],
    ['15 fps: pure widening 10 %', [{ at: STEP_AT, factor: 1.1 }], { fps: 15 }, {}],
    ['15 fps: pure widening 10 %, 1-s window', [{ at: STEP_AT, factor: 1.1 }], { fps: 15 }, FIXED_WINDOW],
    ['10 fps: upper lid only 10 %', [{ at: STEP_AT, factor: 0.9 }], { fps: 10, squintGain: 0 }, {}],
    ['10 fps: pure widening 10 %', [{ at: STEP_AT, factor: 1.1 }], { fps: 10 }, {}],
  ];
  let squint10 = 0;
  let upper10at15 = 0;
  for (const [name, changes, sim, mon] of det) {
    const d = detection(changes, sim, mon);
    if (name === 'squint 10 %') squint10 = d.hits;
    if (name === '15 fps: upper lid only 10 %') upper10at15 = d.hits;
    lines.push(`  ${name.padEnd(44)} ${fmt(d)}`);
  }
  console.info(lines.join('\n'));
  expect(defaultRate).toBeLessThan(3);
  expect(rate15).toBeLessThan(3);
  expect(squint10).toBeGreaterThanOrEqual(SEEDS - 3);
  expect(upper10at15).toBeGreaterThanOrEqual(SEEDS / 2);
  // Budget for facial expressions, one a minute: eyeSquint alone must not report.
  expect(expressionRate['frown / concentration: eyeSquint +0.1, 3 s']).toBeLessThan(2);
  expect(expressionRate['smile: eyeSquint +0.2, lids −5 %, 2.5 s']).toBeLessThan(35);
});
