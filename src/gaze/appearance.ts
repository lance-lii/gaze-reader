import type { AppearanceBaseline, AppEvents, EyeFeatures } from '../types';

/**
 * Notices when the eyelids change for a reason other than where the reader is
 * looking: a light switched on (squinting), glare, a dimmer room (wider eyes).
 * No pixels: only the lid aperture (`EyeFeatures.openness`), MediaPipe's
 * eyeSquint score and the gaze position predicted by a lid-free model.
 *
 * Lids follow vertical gaze: they lower when the reader looks at the bottom
 * lines. The calibration's AppearanceBaseline models that as a line,
 * openness ≈ opennessAt0 + opennessSlope × (y / viewport height). The monitor
 * tracks the residual (observed − that line at the predicted gaze y) with
 * corrections for head pitch (chin down rotates the eyes up in the head, which
 * opens the lids) and yaw (foreshortens the eye width), plus a slow online
 * correction for what calibration got wrong. It reports a *step*: the 1-s
 * median residual moving ≥ 3.5 robust SDs away from where it was 2–6 s earlier
 * at a similar gaze height, and holding for about 2 s (a light switch or a
 * squint reflex takes about half a second; posture and model errors drift).
 * Blinks, invalid frames and gaze outside the calibrated range are ignored;
 * lid changes that coincide with a head-pitch change need more evidence.
 * After a change the level re-anchors, so a lasting squint is reported once,
 * and the return to normal once more. Slow drifts (fatigue, fading daylight)
 * are absorbed rather than reported; `levelVsCalibration` shows them.
 *
 * MediaPipe's eyeSquint also rises with smiles, laughs, frowns and
 * concentration, so it only counts when the lid aperture moves the same way
 * (≥ 1.5 SDs, `squintNeedsOpennessZ`). On a slow camera the 1-s median
 * stretches to 22 frame intervals, at most 1.5 s.
 *
 * Tuned on a simulated reader (appearanceSim.ts; `npm run bench`,
 * bench/lighting/appearance.bench.test.ts), 24 readers per figure:
 *  - false alarms in normal reading WITHOUT facial expressions: 0–0.5 per hour
 *    at 15–30 fps, ≈ 2 per hour at 10 fps;
 *  - facial expressions, one a minute: eyeSquint-only frowns ≈ 0.5/h (55/h
 *    before the gate), smiles that also narrow the lids 5 % ≈ 22/h (60/h);
 *    yawns and heavy lids move the openness itself and are reported (≈ 65/h);
 *  - a 10 % squint is confirmed in ≈ 2.3 s (24/24) only when eyeSquint rises
 *    with it. Light mostly lowers the upper lid, where eyeSquint stays flat;
 *    openness alone catches about 2/3 of those 10 % changes (16/24 at 30 fps,
 *    17/24 at 15 fps, 10/24 at 10 fps), a third at 7.5 %, and 14/24 of a 10 %
 *    widening in dim light (13/24 at 15 fps, 4/24 at 10 fps).
 * The line tracker absorbs the ±2–3-line steps these misses leave without the
 * event. Real cameras still need checking.
 */

// ───────────────────────────────── Baseline ─────────────────────────────────

/** One calibration frame. */
export interface AppearanceSample {
  /** Where the reader was looking: target y / viewport height (0 = top). */
  yNorm: number;
  openness: number;
  /** EyeFeatures.squint (omit when unknown). */
  squint?: number;
  /** EyeFeatures.blink: frames at or above `maxBlink` are skipped. */
  blink?: number;
}

export interface AppearanceBaselineOptions {
  /** Default 30 usable frames. */
  minSamples?: number;
  /** Minimum spread of the gaze targets, viewport heights (default 0.3): a line needs two heights. */
  minSpan?: number;
  /** Default 0.5. */
  maxBlink?: number;
}

const MAD_TO_SD = 1.4826;

function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const a = xs.slice().sort((p, q) => p - q);
  const n = a.length;
  return n % 2 ? a[(n - 1) / 2] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
}

function robustSd(xs: readonly number[], center: number): number {
  return MAD_TO_SD * median(xs.map((x) => Math.abs(x - center)));
}

/**
 * Fits the lid-aperture line on calibration frames: Theil–Sen over the
 * per-target medians (robust to blinks and glitches), intercept as the median
 * offset, and robust spreads. Null when there is too little or too narrow data.
 */
export function buildAppearanceBaseline(samples: readonly AppearanceSample[], opts: AppearanceBaselineOptions = {}): AppearanceBaseline | null {
  const minSamples = opts.minSamples ?? 30;
  const minSpan = opts.minSpan ?? 0.3;
  const maxBlink = opts.maxBlink ?? 0.5;
  const usable = samples.filter(
    (s) =>
      s &&
      Number.isFinite(s.yNorm) &&
      s.yNorm >= -0.5 &&
      s.yNorm <= 1.5 &&
      Number.isFinite(s.openness) &&
      s.openness > 0 &&
      s.openness < 2 &&
      !(Number.isFinite(s.blink) && (s.blink as number) >= maxBlink),
  );
  if (usable.length < minSamples) return null;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const s of usable) {
    yMin = Math.min(yMin, s.yNorm);
    yMax = Math.max(yMax, s.yNorm);
  }
  if (!(yMax - yMin >= minSpan)) return null;

  // Per-target medians (targets share a y), then Theil–Sen across targets.
  const groups = new Map<number, number[]>();
  for (const s of usable) {
    const key = Math.round(s.yNorm * 100);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(s.openness);
  }
  let points = [...groups.entries()].filter(([, g]) => g.length >= 3).map(([k, g]) => ({ y: k / 100, o: median(g) }));
  if (points.length < 2) {
    // Continuous targets (no repeats): Theil–Sen on a strided subset of the frames.
    const stride = Math.max(1, Math.floor(usable.length / 200));
    points = usable.filter((_, i) => i % stride === 0).map((s) => ({ y: s.yNorm, o: s.openness }));
  }
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dy = points[j].y - points[i].y;
      if (Math.abs(dy) >= 0.05) slopes.push((points[j].o - points[i].o) / dy);
    }
  }
  if (slopes.length === 0) return null;
  const slope = median(slopes);
  const offsets = usable.map((s) => s.openness - slope * s.yNorm);
  const at0 = median(offsets);
  const residuals = usable.map((s) => s.openness - (at0 + slope * s.yNorm));
  const squints = usable.map((s) => s.squint).filter((x): x is number => Number.isFinite(x));
  const squintMedian = squints.length > 0 ? median(squints) : 0;
  const out: AppearanceBaseline = {
    v: 1,
    n: usable.length,
    opennessAt0: at0,
    opennessSlope: slope,
    opennessResidualSd: robustSd(residuals, 0),
    squintMedian,
    squintSd: squints.length > 0 ? robustSd(squints, squintMedian) : 0,
  };
  return parseAppearanceBaseline(out);
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Validates a stored baseline; null (not an exception) when anything is off. */
export function parseAppearanceBaseline(x: unknown): AppearanceBaseline | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (o.v !== 1 || !isNum(o.n) || o.n < 1) return null;
  const { opennessAt0: a, opennessSlope: s, opennessResidualSd: r, squintMedian: m, squintSd: q } = o;
  if (!isNum(a) || a <= 0 || a >= 2) return null;
  if (!isNum(s) || Math.abs(s) >= 2) return null;
  if (!isNum(r) || r < 0 || r >= 1) return null;
  if (!isNum(m) || m < 0 || m > 1 || !isNum(q) || q < 0 || q > 1) return null;
  return { v: 1, n: o.n, opennessAt0: a, opennessSlope: s, opennessResidualSd: r, squintMedian: m, squintSd: q };
}

/** Baseline openness at gaze height `yNorm` (viewport heights). */
export function expectedOpenness(b: AppearanceBaseline, yNorm: number): number {
  return b.opennessAt0 + b.opennessSlope * yNorm;
}


// ───────────────────────────────── Monitor ─────────────────────────────────

/** One camera frame for the monitor. */
export interface AppearanceInput {
  t: number;
  features: EyeFeatures | null;
  quality: number;
  /**
   * Gaze y predicted by a model that does not read the lids, as a fraction of
   * the calibration viewport height (the baseline's x-axis); null when unknown.
   */
  gazeYNorm: number | null;
}

export type AppearanceDirection = 'narrower' | 'wider';

/** A change worth an 'appearance-changed' event (pass `t`, `reason`, `detail` on). */
export interface AppearanceChange {
  /** Estimated time the change began (the reading layer re-learns its offset from here). */
  t: number;
  reason: Extract<AppEvents['appearance-changed']['reason'], 'lids'>;
  detail: string;
  /** When the monitor was sure. */
  detectedAt: number;
  direction: AppearanceDirection;
  /** Which signal moved most when the shift started: the lid aperture, or MediaPipe's eyeSquint score. */
  channel: 'openness' | 'squint';
  /** Openness change in robust SDs (signed, negative = narrower) when it fired. */
  z: number;
  /** Squint change in robust SDs, when known. */
  squintZ: number | null;
  /** Openness change relative to the baseline openness at mid-screen (−0.1 = 10 % narrower). */
  relativeShift: number;
}

export interface AppearanceMonitorOptions {
  /** Median window of the residual, ms (default 1000); the shortest it gets… */
  windowMs?: number;
  /**
   * …it stretches to `windowFrames` (default 22) median frame intervals on a
   * slow camera (dim rooms often run at 15 fps), up to `maxWindowMs` (default
   * 1500). At 15 fps the longer median catches about twice as many
   * openness-only changes for +0.5 false alarms per hour (appearanceSim);
   * beyond 1.5 s the false alarms grow faster than the detections.
   */
  windowFrames?: number;
  maxWindowMs?: number;
  /** Valid frames needed in the window (default 8). */
  minWindowFrames?: number;
  /**
   * A shift is measured against the median of the smoothed residual over the
   * `preSpanMs` (default 4000) that end `preGapMs` (default 2000) earlier. A
   * light switch or a squint reflex is a step within about half a second;
   * posture changes and model errors drift over seconds and barely register.
   */
  preGapMs?: number;
  preSpanMs?: number;
  /**
   * …taking only moments when the reader looked within this many viewport
   * heights of where they look now (default 0.15), from the last 60 s: like is
   * compared with like, so what the lid model gets wrong about gaze height
   * (a page turn jumps from the bottom to the top) cancels out.
   */
  preYTolerance?: number;
  /**
   * A "before" level older than usual is trusted less: the unit grows by
   * √(1 + extra age / staleRefMs) (default 30 000 ms), for slow lid drift.
   */
  staleRefMs?: number;
  /**
   * Fraction of the pitch compensation treated as uncertain (default 0.3): when
   * the head pitch changed between "before" and now, the shift must also beat
   * that much of the lid change the pitch alone would cause. A lid change that
   * comes with a posture change is ambiguous.
   */
  pitchUncertainty?: number;
  /** A shift starts at this many robust SDs (default 3.5)… */
  zOn?: number;
  /** …and continues while it stays above this many against the level it started from (default 3). */
  zOff?: number;
  /** How long a shift must last, from its estimated onset (default 2000 ms). */
  sustainMs?: number;
  /** Dips below `zOff` shorter than this don't end a shift (default 300 ms). */
  graceMs?: number;
  /**
   * Evidence a shift needs besides its duration: the area of its score above
   * `zOff`, in z·seconds (default 0.75). Clear steps pass in about 2 s; marginal
   * wobbles of the noise do not.
   */
  evidence?: number;
  /** Minimum time between changes (default 10 000 ms). */
  cooldownMs?: number;
  /** After a change, the new level is the median residual over this long (default 3000 ms). */
  settleMs?: number;
  /**
   * Memory of the online correction (level, gaze slope and pitch gain learned
   * while reading), ms (default 180 000). Slow drifts (fatigue, daylight) are
   * absorbed at this pace; steps are what the monitor reports.
   */
  fitTauMs?: number;
  /** Lower bound of the robust SD of the shift statistic (default 0.004 openness units)… */
  opennessUnitFloor?: number;
  /** …and of its squint counterpart (default 0.02). */
  squintUnitFloor?: number;
  /**
   * The eyeSquint score only counts toward a shift when the lid aperture agrees
   * in direction by at least this many robust SDs (default 1.5). MediaPipe's
   * eyeSquint also rises with smiles, laughs, frowns and concentration while the
   * lids barely move; a light-driven squint narrows the lids too. `-Infinity`
   * lets eyeSquint count on its own (the 1.0 behaviour).
   */
  squintNeedsOpennessZ?: number;
  /** Prior on the shift statistic's SD as a fraction of the calibration residual SD (default 0.3). */
  calibrationFraction?: number;
  /** Blink score at or above which a frame is a blink (default 0.75)… */
  blinkThreshold?: number;
  /** …or openness below this fraction of the expected (default 0.5). */
  blinkOpennessRatio?: number;
  /** Frames this long before a blink (ms, default 100) and after it (default 150) are dropped too. */
  blinkLeadMs?: number;
  blinkGuardMs?: number;
  /** Minimum frame quality (default 0.3). */
  minQuality?: number;
  /** Gaze outside this range (viewport heights) is outside what calibration saw (default [−0.1, 1.1]). */
  yRange?: readonly [number, number];
  /** No valid frame for this long empties the median window (default 1500 ms). */
  gapMs?: number;
  /** Median head pitch at calibration (radians, e.g. from the lighting signature); null → learned from the first `learnPitchMs` of frames. */
  referencePitch?: number | null;
  /** Median head yaw at calibration (default 0). */
  referenceYaw?: number;
  /** Viewport height as an angle at the eye (default 0.35 rad ≈ 20°): turns the baseline slope into a prior pitch gain. */
  viewportAngleRad?: number;
  /** Prior openness per radian of chin-down pitch; overrides the derived one. */
  pitchGain?: number;
  /** Default 3000 ms. */
  learnPitchMs?: number;
}

type Tunables = Required<Omit<AppearanceMonitorOptions, 'referencePitch' | 'pitchGain'>>;

const DEFAULTS: Readonly<Tunables> = {
  windowMs: 1000,
  windowFrames: 22,
  maxWindowMs: 1500,
  minWindowFrames: 8,
  preGapMs: 2000,
  preSpanMs: 4000,
  preYTolerance: 0.15,
  staleRefMs: 30_000,
  pitchUncertainty: 0.3,
  zOn: 3.5,
  zOff: 3,
  sustainMs: 2000,
  graceMs: 300,
  evidence: 0.75,
  cooldownMs: 10_000,
  settleMs: 3000,
  fitTauMs: 180_000,
  opennessUnitFloor: 0.004,
  squintUnitFloor: 0.02,
  squintNeedsOpennessZ: 1.5,
  calibrationFraction: 0.3,
  blinkThreshold: 0.75,
  blinkOpennessRatio: 0.5,
  blinkLeadMs: 100,
  blinkGuardMs: 150,
  minQuality: 0.3,
  yRange: [-0.1, 1.1],
  gapMs: 1500,
  referenceYaw: 0,
  viewportAngleRad: 0.35,
  learnPitchMs: 3000,
};

/** Frames kept in the median window (≥ 1 s at up to 120 fps). */
const WINDOW_CAPACITY = 128;
/** Recent frame intervals kept for the camera's frame rate, and how often the window length follows it. */
const DT_CAPACITY = 32;
const WINDOW_REFRESH_MS = 1000;
/** Gaps longer than this are dropouts, not the frame rate. */
const MAX_FRAME_DT_MS = 400;
/** History of the smoothed residual: one sample per 100 ms, 60 s. */
const HISTORY_CAPACITY = 600;
const HISTORY_EVERY_MS = 100;
/** Fewest history samples for a "before" level (1 s). */
const MIN_PRE_SAMPLES = 10;
/** Frames that say where the reader looks now. */
const ANCHOR_FRAMES = 5;
/** Session scale: one sample every 250 ms for 60 s. */
const SCALE_CAPACITY = 240;
const SCALE_EVERY_MS = 250;
/** Samples before the session scale is trusted (20 s). */
const SCALE_MIN_SAMPLES = 80;
/** Until then the calibration prior is held this much more cautiously (the session may be noisier). */
const WARMUP_PRIOR_FACTOR = 1.5;
const MAX_YAW_CORRECTION = 0.6;
/** Priors of the online correction, in frames of evidence (≈ 1 s for the level, 10 s for the slopes). */
const PRIOR_LEVEL_FRAMES = 30;
const PRIOR_SLOPE_FRAMES = 300;
/** Typical spreads while reading (gaze y in viewport heights, pitch in radians): scale the slope priors. */
const TYPICAL_Y_VAR = 0.06;
const TYPICAL_PITCH_VAR = 0.035 ** 2;
/** Frames whose residual is further than this many calibration SDs from the fit get Huber weights. */
const HUBER_K = 2.5;

/** What the latest comparison looked like (NaN when there was none). */
export interface AppearanceDiagnostics {
  /** Smoothed residual now minus the "before" level, openness units. */
  shift: number;
  /** Robust SD of that shift before inflation. */
  unit: number;
  /** Inflation for a sparse window or an old reference (≥ 1). */
  inflate: number;
  /** Extra allowance for a head-pitch change, openness units. */
  pitchSlack: number;
  /** Age of the "before" level, ms. */
  referenceAgeMs: number;
  /** Head pitch now minus before, radians. */
  pitchChange: number;
  /** Median predicted gaze height in the window, viewport heights. */
  gazeY: number;
  /** Valid frames in the window. */
  frames: number;
}

export type AppearanceMonitorState = 'off' | 'learning' | 'unknown' | 'watching' | 'shifting' | 'settling';

interface Run {
  direction: AppearanceDirection;
  channel: 'openness' | 'squint';
  startedAt: number;
  lastAbove: number;
  /** Area of the score above zOff so far, z·seconds. */
  evidence: number;
  /** The levels before the shift, frozen when it started. */
  ref: number;
  refS: number;
  refPitch: number;
  refAge: number;
  /** Gaze height the levels were compared at. */
  refY: number;
}

/** In-place quickselect median of a[0..n). */
function medianInPlace(a: Float64Array, n: number): number {
  if (n <= 0) return NaN;
  const k = n >> 1;
  const hi = selectK(a, 0, n - 1, k);
  if (n % 2) return hi;
  let lo = -Infinity;
  for (let i = 0; i < k; i++) if (a[i] > lo) lo = a[i]; // after selection, a[0..k) ≤ a[k]
  return 0.5 * (lo + hi);
}

function selectK(a: Float64Array, left: number, right: number, k: number): number {
  let l = left;
  let r = right;
  while (l < r) {
    const pivot = a[(l + r) >> 1];
    let i = l;
    let j = r;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) r = j;
    else if (k >= i) l = i;
    else return a[k];
  }
  return a[k];
}

/**
 * Exponentially weighted ridge regression, r ≈ θ · x, with Huber weights.
 * Small (k ≤ 3) and allocation-free per update.
 */
export class EwRegression {
  private readonly S: Float64Array;
  private readonly b: Float64Array;
  private readonly theta: Float64Array;
  private readonly center: Float64Array;
  private readonly A: Float64Array;
  private readonly sol: Float64Array;
  private lastT: number | null = null;

  constructor(
    private readonly k: number,
    private readonly tauMs: number,
    private readonly prior: readonly number[],
  ) {
    this.S = new Float64Array(k * k);
    this.b = new Float64Array(k);
    this.theta = new Float64Array(k);
    this.center = new Float64Array(k);
    this.A = new Float64Array(k * (k + 1));
    this.sol = new Float64Array(k);
  }

  get coefficients(): Float64Array {
    return this.theta;
  }

  predict(x: ArrayLike<number>): number {
    let s = 0;
    for (let i = 0; i < this.k; i++) s += this.theta[i] * x[i];
    return s;
  }

  /** Adds one observation; `huberScale` bounds its pull (0 = plain least squares). */
  add(t: number, x: ArrayLike<number>, r: number, huberScale: number): void {
    const k = this.k;
    if (this.lastT !== null && t > this.lastT) {
      const lambda = Math.exp(-(t - this.lastT) / this.tauMs);
      for (let i = 0; i < k * k; i++) this.S[i] *= lambda;
      for (let i = 0; i < k; i++) this.b[i] *= lambda;
    }
    this.lastT = t;
    let w = 1;
    if (huberScale > 0) {
      const e = Math.abs(r - this.predict(x));
      if (e > huberScale) w = huberScale / e;
    }
    for (let i = 0; i < k; i++) {
      this.b[i] += w * x[i] * r;
      for (let j = 0; j < k; j++) this.S[i * k + j] += w * x[i] * x[j];
    }
  }

  /** θ = (S + P)⁻¹ (b + P·center), by Gaussian elimination with partial pivoting. */
  solve(): void {
    const k = this.k;
    const n = k + 1;
    const A = this.A;
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) A[i * n + j] = this.S[i * k + j] + (i === j ? this.prior[i] : 0);
      A[i * n + k] = this.b[i] + this.prior[i] * this.center[i];
    }
    for (let c = 0; c < k; c++) {
      let p = c;
      for (let r = c + 1; r < k; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[p * n + c])) p = r;
      if (!(Math.abs(A[p * n + c]) > 1e-12)) return; // keep the previous θ
      if (p !== c) {
        for (let j = 0; j < n; j++) {
          const tmp = A[c * n + j];
          A[c * n + j] = A[p * n + j];
          A[p * n + j] = tmp;
        }
      }
      for (let r = c + 1; r < k; r++) {
        const f = A[r * n + c] / A[c * n + c];
        for (let j = c; j < n; j++) A[r * n + j] -= f * A[c * n + j];
      }
    }
    for (let i = k - 1; i >= 0; i--) {
      let s = A[i * n + k];
      for (let j = i + 1; j < k; j++) s -= A[i * n + j] * this.sol[j];
      this.sol[i] = s / A[i * n + i];
    }
    for (let i = 0; i < k; i++) if (!Number.isFinite(this.sol[i])) return;
    this.theta.set(this.sol);
  }

  /** Moves the intercept (x[0] ≡ 1) by d as if every past observation had been d higher. */
  shiftIntercept(d: number): void {
    const k = this.k;
    for (let i = 0; i < k; i++) this.b[i] += d * this.S[i * k];
    this.center[0] += d;
    this.theta[0] += d;
  }

  reset(): void {
    this.S.fill(0);
    this.b.fill(0);
    this.theta.fill(0);
    this.center.fill(0);
    this.lastT = null;
  }
}

/**
 * Tracks the lid residual frame by frame; `update` returns a change when one
 * is confirmed. Allocation-free per frame (fixed rings, in-place medians).
 *
 * Three layers:
 *  1. the calibration line plus a physical pitch prior explain most of the
 *     lid movement;
 *  2. a slow online correction (level, gaze slope, pitch gain), learned from
 *     quiet frames, absorbs what calibration got wrong (a slightly wrong slope
 *     would turn every page turn into a step) and slow drifts;
 *  3. what remains is smoothed over a second and compared with where it was
 *     2–6 s earlier: a step of ≥ 3.5 robust SDs that holds (≥ 3 SDs against the
 *     frozen earlier level) for about 2 s from its onset is a change.
 */
export class AppearanceMonitor {
  private baseline: AppearanceBaseline | null;
  private readonly o: Readonly<Tunables>;
  private readonly pitchGainOverride: number | null;
  /** Calibration pitch, when known; otherwise each session learns its own. */
  private referencePitch: number | null;

  // Online corrections: openness on [1, y − ½, Δpitch]; squint on [1, y − ½].
  private readonly fitR: EwRegression;
  private readonly fitS: EwRegression;
  private readonly x3 = new Float64Array(3);
  private lastSolveAt = -Infinity;

  // Median window (ring) of corrected residuals.
  private readonly wT = new Float64Array(WINDOW_CAPACITY);
  private readonly wR = new Float64Array(WINDOW_CAPACITY);
  private readonly wS = new Float64Array(WINDOW_CAPACITY);
  private readonly wY = new Float64Array(WINDOW_CAPACITY);
  private readonly wP = new Float64Array(WINDOW_CAPACITY);
  private readonly wOk = new Uint8Array(WINDOW_CAPACITY);
  private wStart = 0;
  private wLen = 0;
  private readonly scratch = new Float64Array(Math.max(WINDOW_CAPACITY, HISTORY_CAPACITY));
  /** Window length in use (follows the frame rate), and the frame intervals it follows. */
  private winMs: number;
  private readonly dts = new Float64Array(DT_CAPACITY);
  private dtLen = 0;
  private dtNext = 0;
  private lastWindowRefreshAt = -Infinity;

  // History of the smoothed residuals (ring), for the "before" level.
  private readonly hT = new Float64Array(HISTORY_CAPACITY);
  private readonly hM = new Float64Array(HISTORY_CAPACITY);
  private readonly hS = new Float64Array(HISTORY_CAPACITY);
  private readonly hY = new Float64Array(HISTORY_CAPACITY);
  private readonly hP = new Float64Array(HISTORY_CAPACITY);
  private readonly picked = new Int32Array(HISTORY_CAPACITY);
  private hStart = 0;
  private hLen = 0;
  private lastHistoryAt = -Infinity;
  /** History before this time (the onset of the last change) is not a valid "before". */
  private historyFloor = -Infinity;

  // Session scale (ring of shift statistics while quiet).
  private readonly sR = new Float64Array(SCALE_CAPACITY);
  private readonly sS = new Float64Array(SCALE_CAPACITY);
  private sLen = 0;
  private sNext = 0;
  private lastScaleSampleAt = -Infinity;
  private lastScaleComputeAt = -Infinity;
  private scaleR = 0;
  private scaleS = 0;
  private readonly scaleScratch = new Float64Array(SCALE_CAPACITY);

  // Pitch reference learning.
  private refPitch: number | null;
  private readonly pitchSamples = new Float64Array(WINDOW_CAPACITY);
  private pitchCount = 0;
  private learnStart: number | null = null;

  private lastT = -Infinity;
  private lastValidAt = -Infinity;
  private lastBlinkAt = -Infinity;

  private run: Run | null = null;
  private settling: { since: number; r: number[]; s: number[]; shift: number; shiftS: number } | null = null;
  private lastEventAt = -Infinity;
  private changes = 0;

  private curResidual: number | null = null;
  private readonly diag: AppearanceDiagnostics = {
    shift: NaN,
    unit: NaN,
    inflate: NaN,
    pitchSlack: NaN,
    referenceAgeMs: NaN,
    pitchChange: NaN,
    gazeY: NaN,
    frames: 0,
  };
  /** Valid frames in the last window, and their usual number. */
  private lastCount = 0;
  private typicalFrames = 0;
  private curZ: number | null = null;
  private curSquintZ: number | null = null;

  constructor(baseline: AppearanceBaseline | null, opts: AppearanceMonitorOptions = {}) {
    const d = DEFAULTS;
    this.o = {
      windowMs: opts.windowMs ?? d.windowMs,
      windowFrames: opts.windowFrames ?? d.windowFrames,
      maxWindowMs: opts.maxWindowMs ?? d.maxWindowMs,
      minWindowFrames: opts.minWindowFrames ?? d.minWindowFrames,
      preGapMs: opts.preGapMs ?? d.preGapMs,
      preSpanMs: opts.preSpanMs ?? d.preSpanMs,
      preYTolerance: opts.preYTolerance ?? d.preYTolerance,
      staleRefMs: opts.staleRefMs ?? d.staleRefMs,
      pitchUncertainty: opts.pitchUncertainty ?? d.pitchUncertainty,
      zOn: opts.zOn ?? d.zOn,
      zOff: opts.zOff ?? d.zOff,
      sustainMs: opts.sustainMs ?? d.sustainMs,
      graceMs: opts.graceMs ?? d.graceMs,
      evidence: opts.evidence ?? d.evidence,
      cooldownMs: opts.cooldownMs ?? d.cooldownMs,
      settleMs: opts.settleMs ?? d.settleMs,
      fitTauMs: opts.fitTauMs ?? d.fitTauMs,
      opennessUnitFloor: opts.opennessUnitFloor ?? d.opennessUnitFloor,
      squintUnitFloor: opts.squintUnitFloor ?? d.squintUnitFloor,
      squintNeedsOpennessZ: opts.squintNeedsOpennessZ ?? d.squintNeedsOpennessZ,
      calibrationFraction: opts.calibrationFraction ?? d.calibrationFraction,
      blinkThreshold: opts.blinkThreshold ?? d.blinkThreshold,
      blinkOpennessRatio: opts.blinkOpennessRatio ?? d.blinkOpennessRatio,
      blinkLeadMs: opts.blinkLeadMs ?? d.blinkLeadMs,
      blinkGuardMs: opts.blinkGuardMs ?? d.blinkGuardMs,
      minQuality: opts.minQuality ?? d.minQuality,
      yRange: opts.yRange ?? d.yRange,
      gapMs: opts.gapMs ?? d.gapMs,
      referenceYaw: opts.referenceYaw ?? d.referenceYaw,
      viewportAngleRad: opts.viewportAngleRad ?? d.viewportAngleRad,
      learnPitchMs: opts.learnPitchMs ?? d.learnPitchMs,
    };
    this.winMs = this.o.windowMs;
    this.pitchGainOverride = Number.isFinite(opts.pitchGain) ? (opts.pitchGain as number) : null;
    this.referencePitch = Number.isFinite(opts.referencePitch) ? (opts.referencePitch as number) : null;
    this.refPitch = this.referencePitch;
    this.baseline = baseline ? parseAppearanceBaseline(baseline) : null;
    this.fitR = new EwRegression(3, this.o.fitTauMs, [PRIOR_LEVEL_FRAMES, PRIOR_SLOPE_FRAMES * TYPICAL_Y_VAR, PRIOR_SLOPE_FRAMES * TYPICAL_PITCH_VAR]);
    this.fitS = new EwRegression(2, this.o.fitTauMs, [PRIOR_LEVEL_FRAMES, PRIOR_SLOPE_FRAMES * TYPICAL_Y_VAR]);
  }

  /**
   * A new calibration (or none): everything starts over against it.
   * `referencePitch`: the median head pitch while calibrating (radians), when known.
   */
  setBaseline(baseline: AppearanceBaseline | null, referencePitch: number | null = null): void {
    this.baseline = baseline ? parseAppearanceBaseline(baseline) : null;
    this.referencePitch = Number.isFinite(referencePitch) ? referencePitch : null;
    this.reset();
  }

  /** Forgets the session (camera restarted): the correction returns to the calibration baseline. */
  reset(): void {
    this.fitR.reset();
    this.fitS.reset();
    this.lastSolveAt = -Infinity;
    this.wLen = 0;
    this.hLen = 0;
    this.lastHistoryAt = -Infinity;
    this.historyFloor = -Infinity;
    this.sLen = 0;
    this.sNext = 0;
    this.lastScaleSampleAt = -Infinity;
    this.lastScaleComputeAt = -Infinity;
    this.scaleR = 0;
    this.scaleS = 0;
    this.refPitch = this.referencePitch; // a learned pitch belongs to one session's posture
    this.pitchCount = 0;
    this.learnStart = null;
    this.lastT = -Infinity;
    this.winMs = this.o.windowMs;
    this.dtLen = 0;
    this.dtNext = 0;
    this.lastWindowRefreshAt = -Infinity;
    this.lastValidAt = -Infinity;
    this.lastBlinkAt = -Infinity;
    this.run = null;
    this.settling = null;
    this.lastEventAt = -Infinity;
    this.curResidual = null;
    this.curZ = null;
    this.curSquintZ = null;
    this.lastCount = 0;
    this.typicalFrames = 0;
  }

  // ── Debug overlay ──

  /** Current shift of the smoothed openness residual, in robust SDs (negative = narrower); null without data. */
  get residualZ(): number | null {
    return this.curZ;
  }

  /** Current shift of the smoothed squint score, in robust SDs; null when unknown. */
  get squintZ(): number | null {
    return this.curSquintZ;
  }

  /** Smoothed openness residual after the online correction, openness units. */
  get residual(): number | null {
    return this.curResidual;
  }

  /**
   * How far the learned level sits from the calibration baseline at mid-screen,
   * relative to the baseline openness (−0.1 = lids 10 % narrower than at
   * calibration). Slow changes and changes since calibration show up here.
   */
  get levelVsCalibration(): number {
    const b = this.baseline;
    if (!b) return 0;
    return this.fitR.coefficients[0] / Math.max(0.05, expectedOpenness(b, 0.5));
  }

  /** Current robust SD of the shift statistic (openness units). */
  get unit(): number {
    const b = this.baseline;
    if (!b) return this.o.opennessUnitFloor;
    const trusted = this.sLen >= SCALE_MIN_SAMPLES;
    const prior = this.o.calibrationFraction * b.opennessResidualSd * (trusted ? 1 : WARMUP_PRIOR_FACTOR);
    return Math.max(this.o.opennessUnitFloor, prior, trusted ? this.scaleR : 0);
  }

  private unitSquint(): number {
    const b = this.baseline;
    const trusted = this.sLen >= SCALE_MIN_SAMPLES;
    const prior = this.o.calibrationFraction * (b?.squintSd ?? 0) * (trusted ? 1 : WARMUP_PRIOR_FACTOR);
    return Math.max(this.o.squintUnitFloor, prior, trusted ? this.scaleS : 0);
  }

  /** Pitch gain in use: the prior plus the learned correction. */
  private pitchGainNow(): number {
    return Math.max(0, this.pitchGain + this.fitR.coefficients[2]);
  }

  /** Prior openness per radian of chin-down head pitch (the online fit corrects it). */
  get pitchGain(): number {
    if (this.pitchGainOverride !== null) return this.pitchGainOverride;
    const s = this.baseline?.opennessSlope ?? 0;
    return s < 0 ? Math.min(0.6, Math.max(0.05, -s / this.o.viewportAngleRad)) : 0.15;
  }

  /** Details of the latest comparison (for the debug overlay; the object is reused). */
  get diagnostics(): Readonly<AppearanceDiagnostics> {
    return this.diag;
  }

  /** Median window in use, ms (`windowMs`, longer on a slow camera). */
  get windowMs(): number {
    return this.winMs;
  }

  /**
   * Estimated onset of a shift that is being confirmed right now (null when
   * none). A change is reported about 2 s after its onset; a consumer that
   * can hold a decision (a page turn) may use this as an early warning.
   */
  get pendingShiftSince(): number | null {
    return this.run ? this.run.startedAt - this.winMs / 2 : null;
  }

  get changeCount(): number {
    return this.changes;
  }

  get state(): AppearanceMonitorState {
    if (!this.baseline) return 'off';
    if (this.refPitch === null) return 'learning';
    if (this.settling) return 'settling';
    if (this.curZ === null) return 'unknown';
    return this.run ? 'shifting' : 'watching';
  }

  update(input: AppearanceInput): AppearanceChange | null {
    const b = this.baseline;
    const t = input.t;
    if (!b || !Number.isFinite(t)) return null;
    if (t < this.lastT) this.wLen = 0; // the clock went backwards: start the window over
    else this.noteFrameInterval(t);
    this.lastT = t;
    const f = input.features;
    const o = this.o;
    const y = input.gazeYNorm;
    const yOk = y !== null && Number.isFinite(y) && y >= o.yRange[0] && y <= o.yRange[1];
    const valid = !!f && Number.isFinite(f.openness) && f.openness > 0 && Number.isFinite(input.quality) && input.quality >= o.minQuality;
    if (f && Number.isFinite(f.blink) && f.blink >= o.blinkThreshold) return this.markBlink(t);
    if (!valid || !yOk || !f) return this.evaluate(t);

    const pitch = f.headPose.pitch;
    const yaw = f.headPose.yaw;
    const yv = y as number;
    const learning = this.refPitch === null;
    const dPitch = !learning && Number.isFinite(pitch) ? pitch - (this.refPitch as number) : 0;
    const x = this.x3;
    x[0] = 1;
    x[1] = yv - 0.5;
    x[2] = dPitch;
    // What the lids should look like now: calibration line, pitch prior, learned correction.
    const expected = expectedOpenness(b, yv) + this.pitchGain * dPitch;
    const expectedNow = expected + (learning ? 0 : this.fitR.predict(x));
    if (f.openness < o.blinkOpennessRatio * expectedNow) return this.markBlink(t); // a partial blink
    if (t - this.lastBlinkAt < o.blinkGuardMs) return this.evaluate(t);

    if (learning) {
      // Learn the pitch the reader usually holds before judging anything.
      this.learnStart ??= t;
      if (Number.isFinite(pitch) && this.pitchCount < WINDOW_CAPACITY) this.pitchSamples[this.pitchCount++] = pitch;
      if (t - (this.learnStart as number) >= o.learnPitchMs && this.pitchCount >= o.minWindowFrames) {
        this.refPitch = medianInPlace(this.pitchSamples, this.pitchCount);
        this.learnStart = null;
      }
      return null;
    }
    const yawC = Number.isFinite(yaw) ? Math.max(-MAX_YAW_CORRECTION, Math.min(MAX_YAW_CORRECTION, yaw)) : 0;
    const yawRef = Math.max(-MAX_YAW_CORRECTION, Math.min(MAX_YAW_CORRECTION, o.referenceYaw));
    // Yaw foreshortens the eye width (the lid gap is vertical): openness reads 1/cos(yaw) too high.
    const open = (f.openness * Math.cos(yawC)) / Math.cos(yawRef);
    const r = open - expected;
    const sq = f.squint;
    const s = typeof sq === 'number' && Number.isFinite(sq) ? sq - b.squintMedian : NaN;

    // Raw residuals are kept; the online correction is applied at evaluation time with the
    // current coefficients, to the window and the history alike, so learning never makes a step.
    this.push(t, r, s, yv, dPitch);
    this.lastValidAt = t;
    const change = this.evaluate(t);
    // Learn from quiet frames only: never from a shift being confirmed, or while settling.
    if (!change && !this.run && !this.settling) {
      this.fitR.add(t, x, r, HUBER_K * Math.max(b.opennessResidualSd, o.opennessUnitFloor));
      if (Number.isFinite(s)) this.fitS.add(t, x, s, HUBER_K * Math.max(b.squintSd, o.squintUnitFloor));
      if (t - this.lastSolveAt >= SCALE_EVERY_MS) {
        this.lastSolveAt = t;
        this.fitR.solve();
        this.fitS.solve();
      }
    }
    return change;
  }

  /**
   * Follows the camera's frame rate: the median window spans at least
   * `windowFrames` frame intervals (between `windowMs` and `maxWindowMs`),
   * re-evaluated once a second from the last 32 intervals.
   */
  private noteFrameInterval(t: number): void {
    const dt = t - this.lastT;
    if (!(dt > 0 && dt <= MAX_FRAME_DT_MS)) return;
    this.dts[this.dtNext] = dt;
    this.dtNext = (this.dtNext + 1) % DT_CAPACITY;
    this.dtLen = Math.min(DT_CAPACITY, this.dtLen + 1);
    if (this.dtLen < 8 || t - this.lastWindowRefreshAt < WINDOW_REFRESH_MS) return;
    this.lastWindowRefreshAt = t;
    this.scratch.set(this.dts.subarray(0, this.dtLen));
    const frameMs = medianInPlace(this.scratch, this.dtLen);
    const o = this.o;
    this.winMs = Math.max(o.windowMs, Math.min(o.maxWindowMs, o.windowFrames * frameMs));
  }

  /** Records a blink at t and drops the frames just before it (the lid was already moving). */
  private markBlink(t: number): AppearanceChange | null {
    this.lastBlinkAt = t;
    const cutoff = t - this.o.blinkLeadMs;
    for (let i = 0; i < this.wLen; i++) {
      const j = (this.wStart + i) % WINDOW_CAPACITY;
      if (this.wT[j] >= cutoff) this.wOk[j] = 0;
    }
    return this.evaluate(t);
  }

  private push(t: number, r: number, s: number, y: number, pitch: number): void {
    if (this.wLen === WINDOW_CAPACITY) {
      this.wStart = (this.wStart + 1) % WINDOW_CAPACITY;
      this.wLen--;
    }
    const j = (this.wStart + this.wLen) % WINDOW_CAPACITY;
    this.wT[j] = t;
    this.wR[j] = r;
    this.wS[j] = s;
    this.wY[j] = y;
    this.wP[j] = pitch;
    this.wOk[j] = 1;
    this.wLen++;
  }

  /**
   * Levels before now: medians over the newest `preSpan` worth of history
   * samples that are at least `preGap` old and were taken with the gaze near
   * `y`, corrected with the current coefficients. Null when there are too few.
   */
  private preLevels(t: number, y: number): { m: number; s: number; pitch: number; age: number } | null {
    const o = this.o;
    const want = Math.max(MIN_PRE_SAMPLES, Math.round(o.preSpanMs / HISTORY_EVERY_MS));
    let k = 0;
    for (let i = this.hLen - 1; i >= 0 && k < want; i--) {
      const j = (this.hStart + i) % HISTORY_CAPACITY;
      if (this.hT[j] < this.historyFloor) break; // before the last change: another regime
      if (t - this.hT[j] < o.preGapMs || !(Math.abs(this.hY[j] - y) <= o.preYTolerance)) continue;
      this.picked[k++] = j;
    }
    if (k < MIN_PRE_SAMPLES) return null;
    const med = (src: Float64Array, fit: EwRegression | null): number => {
      let n = 0;
      for (let i = 0; i < k; i++) {
        const j = this.picked[i];
        const v = src[j];
        if (!Number.isFinite(v)) continue;
        this.scratch[n++] = fit ? v - this.predictAt(fit, this.hY[j], this.hP[j]) : v;
      }
      return n >= MIN_PRE_SAMPLES ? medianInPlace(this.scratch, n) : NaN;
    };
    // Picked newest first, so the middle one dates the level.
    return { m: med(this.hM, this.fitR), s: med(this.hS, this.fitS), pitch: med(this.hP, null), age: t - this.hT[this.picked[k >> 1]] };
  }

  private predictAt(fit: EwRegression, y: number, pitch: number): number {
    const x = this.x3;
    x[0] = 1;
    x[1] = y - 0.5;
    x[2] = pitch;
    return fit.predict(x);
  }

  /** Where the reader looks now: median predicted y of the newest few valid frames. */
  private anchorY(): number {
    let n = 0;
    for (let i = this.wLen - 1; i >= 0 && n < ANCHOR_FRAMES; i--) {
      const j = (this.wStart + i) % WINDOW_CAPACITY;
      if (this.wOk[j]) this.scratch[n++] = this.wY[j];
    }
    return medianInPlace(this.scratch, n);
  }

  /**
   * Median over the window's valid frames of src − fit (current coefficients), or
   * of src alone, using only frames taken near `anchorY`: a window that straddles
   * a page turn must not mix the bottom of one page with the top of the next.
   */
  private windowMedian(src: Float64Array, fit: EwRegression | null, anchorY: number): number {
    const tol = this.o.preYTolerance;
    let n = 0;
    for (let i = 0; i < this.wLen; i++) {
      const j = (this.wStart + i) % WINDOW_CAPACITY;
      const v = src[j];
      if (!this.wOk[j] || !Number.isFinite(v) || !(Math.abs(this.wY[j] - anchorY) <= tol)) continue;
      this.scratch[n++] = fit ? v - this.predictAt(fit, this.wY[j], this.wP[j]) : v;
    }
    this.lastCount = n;
    return n >= this.o.minWindowFrames ? medianInPlace(this.scratch, n) : NaN;
  }

  private evaluate(t: number): AppearanceChange | null {
    const o = this.o;
    // Expire old frames.
    while (this.wLen > 0 && t - this.wT[this.wStart] > this.winMs) {
      this.wStart = (this.wStart + 1) % WINDOW_CAPACITY;
      this.wLen--;
    }
    if (t - this.lastValidAt > o.gapMs) {
      // Face lost, reader away: no opinion. The history stays, so a change while away shows on return.
      this.wLen = 0;
      this.run = null;
      this.curZ = null;
      this.curSquintZ = null;
      this.curResidual = null;
      return null;
    }
    const anchor = this.anchorY();
    const m = Number.isFinite(anchor) ? this.windowMedian(this.wR, this.fitR, anchor) : NaN;
    const frames = this.lastCount;
    if (!Number.isFinite(m)) {
      this.curZ = null;
      this.curSquintZ = null;
      this.curResidual = null;
      return null;
    }
    const ms = this.windowMedian(this.wS, this.fitS, anchor);
    const my = this.windowMedian(this.wY, null, anchor);
    const mp = this.windowMedian(this.wP, null, anchor);
    this.curResidual = m;
    if (t - this.lastHistoryAt >= HISTORY_EVERY_MS) {
      // Stored uncorrected (median + the correction at the window's centre), so later
      // comparisons can apply whatever the coefficients are then.
      this.lastHistoryAt = t;
      if (this.hLen === HISTORY_CAPACITY) {
        this.hStart = (this.hStart + 1) % HISTORY_CAPACITY;
        this.hLen--;
      }
      const j = (this.hStart + this.hLen) % HISTORY_CAPACITY;
      this.hT[j] = t;
      this.hM[j] = m + this.predictAt(this.fitR, my, mp);
      this.hS[j] = Number.isFinite(ms) ? ms + this.predictAt(this.fitS, my, mp) : NaN;
      this.hY[j] = my;
      this.hP[j] = mp;
      this.hLen++;
    }
    this.updateScale(t);

    const unit = this.unit;
    const unitS = this.unitSquint();

    if (this.settling) {
      this.curZ = 0;
      this.curSquintZ = Number.isFinite(ms) ? 0 : null;
      this.settling.r.push(m);
      if (Number.isFinite(ms)) this.settling.s.push(ms);
      if (t - this.settling.since >= o.settleMs) {
        // Re-anchor: the new level is the reference from now on. The history is raw, so the
        // moments before the change now read as a shift the other way, as they should.
        const st = this.settling;
        this.fitR.shiftIntercept(st.r.length > 0 ? median(st.r) : st.shift);
        this.fitS.shiftIntercept(st.s.length > 0 ? median(st.s) : st.shiftS);
        this.settling = null;
      }
      return null;
    }

    // Shift statistics: against the frozen level of a shift in progress, else against 2–6 s ago.
    const run = this.run;
    const levels = run ? null : this.preLevels(t, my);
    const pre = run ? run.ref : (levels?.m ?? NaN);
    const preS = run ? run.refS : (levels?.s ?? NaN);
    const prePitch = run ? run.refPitch : (levels?.pitch ?? NaN);
    const preAge = run ? run.refAge : (levels?.age ?? NaN);
    if (!Number.isFinite(pre)) {
      this.curZ = null;
      this.curSquintZ = null;
      return null; // no "before" yet
    }
    // A pitch change since "before" makes the pitch compensation part of the question.
    const pitchSlack = Number.isFinite(prePitch) ? o.pitchUncertainty * this.pitchGainNow() * Math.abs(mp - prePitch) : 0;
    // A median of fewer frames than usual (blinks, a slow camera) is noisier, and an older
    // "before" (the previous page's top, after a page turn) has had more time to drift.
    if (!run && this.settling === null) this.typicalFrames = this.typicalFrames > 0 ? this.typicalFrames + 0.02 * (frames - this.typicalFrames) : frames;
    const sparse = Math.sqrt(Math.max(1, (0.75 * this.typicalFrames) / Math.max(1, frames)));
    const stale = Math.sqrt(1 + Math.max(0, preAge - (o.preGapMs + o.preSpanMs)) / o.staleRefMs);
    const inflate = sparse * (Number.isFinite(stale) ? stale : 1);
    const z = (m - pre) / Math.hypot(unit * inflate, pitchSlack);
    const zs = Number.isFinite(ms) && Number.isFinite(preS) ? (ms - preS) / (unitS * inflate) : null;
    this.curZ = z;
    this.curSquintZ = zs;
    const dg = this.diag;
    dg.shift = m - pre;
    dg.unit = unit;
    dg.inflate = inflate;
    dg.pitchSlack = pitchSlack;
    dg.referenceAgeMs = preAge;
    dg.pitchChange = mp - prePitch;
    dg.gazeY = my;
    dg.frames = frames;

    // Direction-aware score: narrower = openness down or squint up. eyeSquint only counts
    // when the lids agree in direction: smiles, frowns and concentration raise it on their own.
    const gate = o.squintNeedsOpennessZ;
    const squintNarrow = zs !== null && -z >= gate ? zs : -Infinity;
    const squintWide = zs !== null && z >= gate ? -zs : -Infinity;
    const narrow = Math.max(-z, squintNarrow);
    const wide = Math.max(z, squintWide);
    const direction: AppearanceDirection = narrow >= wide ? 'narrower' : 'wider';
    const score = Math.max(narrow, wide);

    if (run && !(Math.abs(my - run.refY) <= o.preYTolerance)) {
      // The gaze moved on (a page turn): the frozen level no longer compares like with like.
      this.run = null;
      return null;
    }
    if (run) {
      if (run.direction === direction && score >= o.zOff) {
        // Evidence: area of the score above zOff, in z·seconds (a CUSUM-like sum over time).
        run.evidence += (score - o.zOff) * Math.max(0, t - run.lastAbove) / 1000;
        run.lastAbove = t;
      } else if (t - run.lastAbove > o.graceMs) {
        this.run = null;
      }
    } else if (score >= o.zOn) {
      const channel: Run['channel'] = direction === 'narrower' ? (squintNarrow > -z ? 'squint' : 'openness') : squintWide > z ? 'squint' : 'openness';
      this.run = { direction, channel, startedAt: t, lastAbove: t, evidence: 0, ref: pre, refS: preS, refPitch: prePitch, refAge: preAge, refY: my };
    }

    const cur = this.run;
    if (cur) {
      // The median lags a step by about half a window: count the shift from its estimated onset.
      const onset = cur.startedAt - this.winMs / 2;
      const holding = cur.lastAbove === t && cur.evidence >= o.evidence;
      if (holding && t - onset >= o.sustainMs && t - this.lastEventAt >= o.cooldownMs) return this.fire(t, onset, cur, z, zs, m - cur.ref);
      return null;
    }

    if (t - this.lastScaleSampleAt >= SCALE_EVERY_MS) {
      // Learn how much the shift statistic wanders for this reader, while quiet.
      this.lastScaleSampleAt = t;
      this.sR[this.sNext] = m - pre;
      this.sS[this.sNext] = zs === null ? NaN : ms - preS;
      this.sNext = (this.sNext + 1) % SCALE_CAPACITY;
      this.sLen = Math.min(SCALE_CAPACITY, this.sLen + 1);
    }
    return null;
  }

  /** Robust spread (1.4826 × MAD about the median) of the recent shift statistics, once a second. */
  private updateScale(t: number): void {
    if (t - this.lastScaleComputeAt < 1000 || this.sLen < SCALE_MIN_SAMPLES) return;
    this.lastScaleComputeAt = t;
    this.scaleR = this.madOf(this.sR);
    this.scaleS = this.madOf(this.sS);
  }

  private madOf(src: Float64Array): number {
    const a = this.scaleScratch;
    let n = 0;
    for (let i = 0; i < this.sLen; i++) if (Number.isFinite(src[i])) a[n++] = src[i];
    if (n < SCALE_MIN_SAMPLES) return 0;
    const med = medianInPlace(a, n);
    n = 0;
    for (let i = 0; i < this.sLen; i++) if (Number.isFinite(src[i])) a[n++] = Math.abs(src[i] - med);
    return MAD_TO_SD * medianInPlace(a, n);
  }

  private fire(t: number, onset: number, run: Run, z: number, zs: number | null, shift: number): AppearanceChange {
    const b = this.baseline as AppearanceBaseline;
    const relativeShift = shift / Math.max(0.05, expectedOpenness(b, 0.5));
    const pct = Math.round(relativeShift * 100);
    const parts = [`openness ${pct >= 0 ? '+' : ''}${pct}% (z ${z.toFixed(1)})`];
    if (zs !== null) parts.push(`squint z ${zs.toFixed(1)}`);
    const detail = `Eyes ${run.direction}: ${parts.join(', ')}`;
    this.changes++;
    this.lastEventAt = t;
    this.historyFloor = onset;
    this.run = null;
    this.settling = { since: t, r: [], s: [], shift, shiftS: zs === null ? 0 : zs * this.unitSquint() };
    return {
      t: onset,
      reason: 'lids',
      detail,
      detectedAt: t,
      direction: run.direction,
      channel: run.channel,
      z,
      squintZ: zs,
      relativeShift,
    };
  }
}
