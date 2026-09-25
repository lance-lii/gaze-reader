/**
 * Test support for appearance.ts (not part of the app): a simulated reader's
 * eyelids, head and lid-free gaze prediction, frame by frame.
 *
 * Model (all "true" quantities; the monitor never sees them):
 *  - eye-in-head downward position u = gaze y − (head pitch − rest pitch) / Θ,
 *    in viewport heights, where Θ is the viewport's angular height;
 *  - openness = (top − slope·u − curve·u²) − dip·(2x − 1)² at the line ends,
 *    × the light factor (0.9 = a 10 % squint), ÷ cos(yaw)^0.9 (foreshortening),
 *    plus AR(1) frame noise and a slow wander;
 *  - blinks close the lids for ≈ 250 ms, and raise the blink score;
 *  - MediaPipe-like eyeSquint rises a little toward the bottom and with squinting;
 *  - the lid-free gaze model predicts y with AR(1) noise and a small bias.
 * The reader reads pages of 18 lines (fixations, regressions, return sweeps,
 * page turns), nods now and then, shifts posture, and glances at the keyboard.
 * Facial expressions (smiles, frowns, yawns: `expressions`) move eyeSquint and
 * the lids without any change of light or gaze bias, so every report they cause
 * is a false alarm.
 */
import type { EyeFeatures } from '../types';
import type { AppearanceInput, AppearanceSample } from './appearance';

/**
 * A facial expression: eyeSquint and the lid aperture move, the light and the
 * gaze bias do not. It ramps in over `rampMs`, holds, and ramps out so that it
 * is over at `at + durationMs`.
 */
export interface ExpressionEpisode {
  at: number;
  durationMs: number;
  /** eyeSquint added at full strength (a Duchenne smile ≈ +0.2, a frown ≈ +0.1). */
  squint: number;
  /** Openness factor at full strength (0.95 = lids 5 % narrower, a yawn ≈ 0.65). */
  lidFactor: number;
  /** Default 300 ms. */
  rampMs?: number;
}

export interface ReaderSimOptions {
  seed: number;
  durationMs: number;
  fps: number;
  openTop: number;
  openSlope: number;
  openCurve: number;
  horizontalDip: number;
  /** Per-frame openness noise SD and its frame-to-frame correlation. */
  noiseSd: number;
  noiseRho: number;
  /** Slow openness wander (OU): SD and time constant. */
  wanderSd: number;
  wanderTauMs: number;
  /** True angular height of the viewport, radians. */
  viewportAngleRad: number;
  /** Rest head pitch, radians (chin down positive). */
  pitch0: number;
  pitchWanderDeg: number;
  /** Mean time between nods (0 = none), their size and length. */
  nodEveryMs: number;
  nodDeg: number;
  nodMs: number;
  /** Mean time between posture shifts (0 = none; each takes 4 s) and the SD of the posture around the usual one, degrees. */
  postureEveryMs: number;
  postureDeg: number;
  yawWanderDeg: number;
  blinkPerMin: number;
  /** Mean time between bursts of 5 quick blinks (0 = none). */
  blinkBurstEveryMs: number;
  /** Lid-free gaze prediction: per-frame noise SD (viewport heights), correlation, and bias. */
  gazeNoise: number;
  gazeRho: number;
  gazeBias: number;
  /** Whether frames carry `EyeFeatures.squint`. */
  squint: boolean;
  squintBase: number;
  squintGaze: number;
  squintNoise: number;
  /** eyeSquint rise per unit of light-driven narrowing (0.1 narrowing → +0.1·gain). */
  squintGain: number;
  /** Light-driven lid changes: the openness factor from `at` on (ramped). */
  lidChanges: { at: number; factor: number; rampMs?: number }[];
  /** Facial expressions (see `expressionSchedule`); they never change the gaze bias. */
  expressions: ExpressionEpisode[];
  /** Mean time between 3-s glances at the keyboard (0 = none). */
  lookAwayEveryMs: number;
}

export const DEFAULT_READER: Readonly<Omit<ReaderSimOptions, 'seed' | 'durationMs'>> = Object.freeze({
  fps: 30,
  openTop: 0.31,
  openSlope: 0.09,
  openCurve: 0.03,
  horizontalDip: 0.01,
  noiseSd: 0.012,
  noiseRho: 0.5,
  wanderSd: 0.004,
  wanderTauMs: 20_000,
  viewportAngleRad: 0.33,
  pitch0: 0.1,
  pitchWanderDeg: 2,
  nodEveryMs: 40_000,
  nodDeg: 10,
  nodMs: 800,
  postureEveryMs: 150_000,
  postureDeg: 5,
  yawWanderDeg: 3,
  blinkPerMin: 15,
  blinkBurstEveryMs: 0,
  gazeNoise: 0.045,
  gazeRho: 0.6,
  gazeBias: 0.02,
  squint: true,
  squintBase: 0.1,
  squintGaze: 0.04,
  squintNoise: 0.035,
  squintGain: 1.0,
  lidChanges: [],
  expressions: [],
  lookAwayEveryMs: 120_000,
});

/**
 * Episodes of one expression through a session: the first after `firstMs`,
 * then one every `everyMs` on average (exponential gaps, never overlapping).
 * Its own random stream, so the reading itself is the same with or without them.
 */
export function expressionSchedule(
  seed: number,
  durationMs: number,
  everyMs: number,
  shape: Omit<ExpressionEpisode, 'at'>,
  firstMs = 20_000,
): ExpressionEpisode[] {
  const rng = new Rng((seed ^ 0xe4e5510) >>> 0);
  const out: ExpressionEpisode[] = [];
  const gap = Math.max(1000, everyMs - shape.durationMs);
  for (let at = firstMs + rng.exp(gap); at + shape.durationMs < durationMs; at += shape.durationMs + rng.exp(gap)) {
    out.push({ ...shape, at });
  }
  return out;
}

/** Strength (0..1) of an expression at time t. */
function expressionLevel(e: ExpressionEpisode, t: number): number {
  const ramp = Math.max(1, e.rampMs ?? 300);
  return Math.max(0, Math.min(1, (t - e.at) / ramp, (e.at + e.durationMs - t) / ramp));
}

export interface SimFrame extends AppearanceInput {
  /** `factor`: the light's openness factor; `expression`: strength (0..1) of a facial expression. */
  truth: { y: number; x: number; factor: number; blinking: boolean; lookingAway: boolean; expression: number };
}

/** Deterministic PRNG (mulberry32) with a normal sampler. */
export class Rng {
  private s: number;
  private spare: number | null = null;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  normal(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = 2 * this.next() - 1;
      v = 2 * this.next() - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const k = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * k;
    return u * k;
  }
  exp(mean: number): number {
    return -mean * Math.log(1 - this.next());
  }
}

const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Where the reader looks over time: fixations along lines, return sweeps, page turns. */
function* gazePath(rng: Rng): Generator<{ x: number; y: number; ms: number }> {
  const LINES = 18;
  const top = 0.08;
  const bottom = 0.92;
  for (;;) {
    for (let line = 0; line < LINES; line++) {
      const y = top + (line * (bottom - top)) / (LINES - 1);
      const n = 8 + Math.floor(rng.next() * 4);
      let x = 0.12 + 0.03 * rng.normal();
      for (let k = 0; k < n; k++) {
        yield { x, y: y + 0.004 * rng.normal(), ms: clamp(230 + 60 * rng.normal(), 100, 500) };
        if (rng.next() < 0.1) x = Math.max(0.1, x - 0.1 * rng.next());
        else x = Math.min(0.9, x + 0.76 / n);
      }
    }
    yield { x: 0.8, y: bottom, ms: 400 }; // last glance, then the page turns
  }
}

/** Simulates `durationMs` of reading. */
export function simulateReading(partial: Partial<ReaderSimOptions> & { seed: number; durationMs: number }): SimFrame[] {
  const o: ReaderSimOptions = { ...DEFAULT_READER, ...partial };
  const rng = new Rng(o.seed);
  const dt = 1000 / o.fps;
  const frames: SimFrame[] = [];
  const path = gazePath(rng);
  let fix = path.next().value as { x: number; y: number; ms: number };
  let fixLeft = fix.ms;

  let noise = 0;
  let wander = 0;
  let gazeErr = 0;
  let pitchWander = 0;
  let yawWander = 0;
  let posture = 0;
  let postureFrom = 0;
  let postureTo = 0;
  let postureAt = -Infinity;
  let nextPosture = o.postureEveryMs > 0 ? rng.exp(o.postureEveryMs) : Infinity;
  let nextNod = o.nodEveryMs > 0 ? rng.exp(o.nodEveryMs) : Infinity;
  let nodAt = -Infinity;
  const blinkMean = 60_000 / Math.max(0.1, o.blinkPerMin);
  let nextBlink = rng.exp(blinkMean);
  const blinkTimes: number[] = [];
  let nextBurst = o.blinkBurstEveryMs > 0 ? rng.exp(o.blinkBurstEveryMs) : Infinity;
  let nextLookAway = o.lookAwayEveryMs > 0 ? rng.exp(o.lookAwayEveryMs) : Infinity;
  let lookAwayUntil = -Infinity;

  const lightFactor = (t: number): number => {
    let f = 1;
    for (const c of o.lidChanges) {
      const ramp = c.rampMs ?? 300;
      if (t >= c.at) f *= 1 + (c.factor - 1) * Math.min(1, (t - c.at) / ramp);
    }
    return f;
  };

  for (let t = 0; t < o.durationMs; t += dt) {
    // Gaze.
    fixLeft -= dt;
    while (fixLeft <= 0) {
      fix = path.next().value as { x: number; y: number; ms: number };
      fixLeft += fix.ms;
    }
    if (t >= nextLookAway) {
      lookAwayUntil = t + 3000;
      nextLookAway = t + 3000 + rng.exp(o.lookAwayEveryMs);
    }
    const lookingAway = t < lookAwayUntil;
    const gx = lookingAway ? 0.5 : fix.x;
    const gy = lookingAway ? 1.6 : fix.y;

    // Head.
    const a = dt / 15_000;
    pitchWander += -pitchWander * a + o.pitchWanderDeg * DEG * Math.sqrt(2 * a) * rng.normal();
    yawWander += -yawWander * a + o.yawWanderDeg * DEG * Math.sqrt(2 * a) * rng.normal();
    if (t >= nextPosture) {
      // A new posture around the usual one (not a random walk: readers come back to their habit).
      postureFrom = posture;
      postureTo = o.postureDeg * DEG * rng.normal();
      postureAt = t;
      nextPosture = t + rng.exp(o.postureEveryMs);
    }
    posture = t - postureAt < 4000 ? postureFrom + ((postureTo - postureFrom) * (t - postureAt)) / 4000 : postureTo;
    if (t >= nextNod) {
      nodAt = t;
      nextNod = t + o.nodMs + rng.exp(o.nodEveryMs);
    }
    const nod = t - nodAt < o.nodMs ? o.nodDeg * DEG * Math.sin((Math.PI * (t - nodAt)) / o.nodMs) : 0;
    const pitch = o.pitch0 + pitchWander + posture + nod + (lookingAway ? 12 * DEG : 0);
    const yaw = yawWander;

    // Blinks (single, and occasional bursts).
    if (t >= nextBlink) {
      blinkTimes.push(t);
      nextBlink = t + 300 + rng.exp(blinkMean);
    }
    if (t >= nextBurst) {
      for (let k = 0; k < 5; k++) blinkTimes.push(t + k * 600);
      nextBurst = t + 3000 + rng.exp(o.blinkBurstEveryMs);
    }
    while (blinkTimes.length > 0 && t - blinkTimes[0] > 300) blinkTimes.shift();
    let closure = 0;
    for (const bt of blinkTimes) {
      const s = t - bt;
      if (s >= 0 && s < 250) closure = Math.max(closure, s < 80 ? s / 80 : s < 140 ? 1 : 1 - (s - 140) / 110);
    }

    // Lids.
    const u = gy - (pitch - o.pitch0) / o.viewportAngleRad;
    const factor = lightFactor(t);
    let exprFactor = 1;
    let exprSquint = 0;
    let expression = 0;
    for (const e of o.expressions) {
      const k = expressionLevel(e, t);
      if (k <= 0) continue;
      exprFactor *= 1 + (e.lidFactor - 1) * k;
      exprSquint += e.squint * k;
      expression = Math.max(expression, k);
    }
    const open0 = (o.openTop - o.openSlope * u - o.openCurve * u * u - o.horizontalDip * (2 * gx - 1) ** 2) * factor * exprFactor;
    noise = o.noiseRho * noise + Math.sqrt(1 - o.noiseRho * o.noiseRho) * o.noiseSd * rng.normal();
    const wa = dt / o.wanderTauMs;
    wander += -wander * wa + o.wanderSd * Math.sqrt(2 * wa) * rng.normal();
    const openNoBlink = Math.max(0.02, open0 / Math.pow(Math.cos(yaw), 0.9) + noise + wander);
    const openness = Math.max(0.01, openNoBlink * (1 - 0.92 * closure));
    const blink = clamp(0.05 + 0.45 * (1 - openNoBlink / o.openTop) + 0.9 * closure + 0.03 * rng.normal(), 0, 1);
    const squint = clamp(o.squintBase + o.squintGaze * clamp(u, -0.5, 1.5) + o.squintGain * Math.max(0, 1 - factor) + exprSquint + o.squintNoise * rng.normal(), 0, 1);

    // The lid-free model's prediction.
    gazeErr = o.gazeRho * gazeErr + Math.sqrt(1 - o.gazeRho * o.gazeRho) * o.gazeNoise * rng.normal();
    const predicted = gy + o.gazeBias + gazeErr;

    const features: EyeFeatures = {
      vector: [],
      headPose: { yaw, pitch, roll: 0, tx: 0, ty: -5, tz: -60 },
      blink,
      openness,
      faceScale: 0.11,
      faceCenter: { x: 0.5, y: 0.45 },
      ...(o.squint ? { squint } : {}),
    };
    frames.push({
      t,
      features,
      quality: clamp((lookingAway ? 0.6 : 0.85) + 0.03 * rng.normal(), 0, 1),
      gazeYNorm: predicted,
      truth: { y: gy, x: gx, factor, blinking: closure > 0, lookingAway, expression },
    });
  }
  return frames;
}

/**
 * A 13-target calibration by the same reader (1.5 s per target, the first
 * 300 ms of each dropped): samples for buildAppearanceBaseline, plus the
 * median head pitch.
 */
export function simulateCalibration(partial: Partial<ReaderSimOptions> & { seed: number }): { samples: AppearanceSample[]; pitch: number } {
  const o: ReaderSimOptions = { ...DEFAULT_READER, durationMs: 0, ...partial };
  const rng = new Rng(o.seed ^ 0x5eed);
  const targets: [number, number][] = [
    [0.05, 0.05], [0.5, 0.05], [0.95, 0.05],
    [0.275, 0.275], [0.725, 0.275],
    [0.05, 0.5], [0.5, 0.5], [0.95, 0.5],
    [0.275, 0.725], [0.725, 0.725],
    [0.05, 0.95], [0.5, 0.95], [0.95, 0.95],
  ];
  const samples: AppearanceSample[] = [];
  const pitches: number[] = [];
  const dt = 1000 / o.fps;
  let noise = 0;
  let wander = 0;
  let pitchWander = 0;
  for (const [tx, ty] of targets) {
    const fx = tx + 0.01 * rng.normal();
    const fy = ty + 0.01 * rng.normal();
    for (let s = 0; s < 1500; s += dt) {
      const a = dt / 15_000;
      pitchWander += -pitchWander * a + 0.5 * DEG * Math.sqrt(2 * a) * rng.normal();
      const pitch = o.pitch0 + pitchWander;
      noise = o.noiseRho * noise + Math.sqrt(1 - o.noiseRho * o.noiseRho) * o.noiseSd * rng.normal();
      const wa = dt / o.wanderTauMs;
      wander += -wander * wa + o.wanderSd * Math.sqrt(2 * wa) * rng.normal();
      if (s < 300) continue;
      const u = fy - (pitch - o.pitch0) / o.viewportAngleRad;
      const open = o.openTop - o.openSlope * u - o.openCurve * u * u - o.horizontalDip * (2 * fx - 1) ** 2 + noise + wander;
      const squint = clamp(o.squintBase + o.squintGaze * u + o.squintNoise * rng.normal(), 0, 1);
      const blink = clamp(0.05 + 0.45 * (1 - open / o.openTop) + 0.03 * rng.normal(), 0, 1);
      samples.push({ yNorm: ty, openness: open, blink, ...(o.squint ? { squint } : {}) });
      pitches.push(pitch);
    }
  }
  pitches.sort((p, q) => p - q);
  return { samples, pitch: pitches[pitches.length >> 1] };
}
