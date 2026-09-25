/**
 * Calibrated gaze model: EyeFeatures → viewport CSS px.
 *
 * Pipeline (all fitted on the calibration samples, nothing hard-coded about
 * which features exist — the feature vector is treated as opaque):
 *
 *  1. Drop blinks (blink > maxBlink, default 0.5) and non-finite rows.
 *  2. z-score every feature (constant features are neutralized, not divided by ~0).
 *  3. Pick the "dominant" gaze features: the ones most correlated with the
 *     target x or y, taken alternately per axis so the hard vertical axis gets
 *     its share, skipping near-duplicates of features already picked.
 *  4. Per target, reject samples > 2.5 robust SDs (MAD) from the target's
 *     median in any dominant feature (glances away, half-blinks, tracker
 *     glitches); then redo 2–3 on the clean data.
 *  5. Design = every feature linearly + squares and pairwise products of the
 *     dominant features, re-standardized so one ridge penalty fits all.
 *  6. Two ridge regressions (x, y) sharing one factorization; λ chosen by
 *     leave-one-target-out cross-validation on mean Euclidean error.
 *
 * Predictions are computed in absolute screen coordinates (viewport px + the
 * window's screen position at calibration time) and converted back using the
 * *current* window position, so dragging the browser window doesn't break the
 * calibration. Quick recalibration stacks a per-axis affine correction in the
 * same screen space, so it also survives window moves.
 */
import type {
  CalibrationQuality,
  CalibrationReport,
  CalibrationSample,
  EyeFeatures,
  GazeModel,
  Point,
  SerializedGazeModel,
} from '../types';
import { readJSON, removeKey, writeJSON } from '../core/storage';
import type { FeatureName } from './features';
import { RidgeNormalEquations, dot, ridgeFit } from './ridge';

export const GAZE_MODEL_VERSION = 1;
export const GAZE_MODEL_KIND = 'gr-ridge-poly2';
export const CALIBRATION_STORAGE_KEY = 'calibration.v1';
export const DEFAULT_LAMBDAS: readonly number[] = Object.freeze([1e-3, 1e-2, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100]);
/** App default text: 22 px × 1.9 line height. */
export const DEFAULT_LINE_PITCH_PX = 22 * 1.9;
/**
 * Default cutoff: samples with a blink score above this are dropped. Callers
 * that already gate blinks over time (the calibration overlay uses the
 * runtime gaze source's BlinkGate) pass a higher `maxBlink`, because a
 * sustained moderate score is lowered lids — the reader looking at the bottom
 * of the screen — and the model must learn those frames, not extrapolate them.
 */
export const MAX_BLINK = 0.5;

const DEFAULT_QUADRATIC_FEATURES = 6;
const MIN_TARGETS = 3;
const MIN_SAMPLES = 6;
/** Standardized inputs are clamped before expansion so squares can't explode on wild frames. */
const Z_CLAMP = 6;
/** A dominant gaze feature this many calibration SDs out means a tracking glitch, not gaze. */
const Z_REJECT = 10;
/**
 * Head pose and distance. The head barely moves during calibration, so its SDs are tiny, and
 * a reader who leans back or slouches later is legitimately "10 SDs out". These features are
 * never grounds for rejecting a prediction (Z_CLAMP bounds their influence instead);
 * otherwise a head feature picked as dominant would silence the tracker for the rest of the
 * session, reading as "can't see you" with the face in plain view.
 */
const POSTURE_FEATURES: ReadonlySet<string> = new Set<FeatureName>(['yaw', 'pitch', 'roll', 'tx', 'ty', 'tz', 'faceScale']);
const MAD_TO_SD = 1.4826;
/** Leys et al. (2013) call 2.5 robust SDs "moderately conservative" — our default. */
const MAD_THRESHOLD = 2.5;
/** Floor for the per-target spread, in global SD units, so near-identical samples aren't flagged. */
const FEATURE_MAD_FLOOR = 0.05;
/** Same idea for predictions, in px. */
const PREDICTION_MAD_FLOOR_PX = 2;
const MAX_REJECT_FRACTION = 1 / 3;
/**
 * |r| a feature needs with target x or y to count as a gaze feature. A pure
 * noise feature's correlation has SD ≈ 1/√n (≈ 0.05 for a typical 13 × 30
 * calibration), so 0.25 is ~5σ — while any real gaze cue clears it easily.
 */
const MIN_DOMINANT_CORR = 0.25;
const REDUNDANT_CORR = 0.95;
/** Prefer the smoother model when a larger λ is within 2 % of the best CV error. */
const LAMBDA_TIE_TOLERANCE = 0.02;

/** Quick mode: per-axis scale is shrunk towards 1 (λ = κ·spread) and clamped. */
const DEFAULT_SCALE_SHRINKAGE = 2;
const SCALE_MIN = 0.85;
const SCALE_MAX = 1.2;
/** Minimum RMS spread of the quick targets (px) before a scale is estimated at all. */
const MIN_SCALE_SPREAD_PX = 40;

// ────────────────────────────────── Types ────────────────────────────────────

export interface TrainOptions {
  /** Viewport size at calibration (CSS px). Default: window.inner*, else inferred from the targets. */
  viewport?: { width: number; height: number };
  /** Ridge λ grid for cross-validation. Default {@link DEFAULT_LAMBDAS}. */
  lambdas?: number[];
  /** How many dominant features get squares and pairwise products (default 6; fewer with few targets). */
  quadraticFeatures?: number;
  /** Per-target MAD outlier rejection (default true). */
  rejectOutliers?: boolean;
  /**
   * FEATURE_NAMES of the running build. Stored as a signature so a model from
   * a build whose features were reordered (same length!) is rejected on load.
   * Must have one name per vector entry.
   */
  featureNames?: readonly string[];
  /** Drop samples whose blink score exceeds this (default {@link MAX_BLINK}). */
  maxBlink?: number;
}

export interface EvaluateOptions {
  /** Ignore samples whose blink score exceeds this (default {@link MAX_BLINK}). */
  maxBlink?: number;
}

export interface TrainDiagnostics {
  /** Leave-one-target-out mean per-sample Euclidean error for every λ tried. */
  cv: { lambda: number; errorPx: number }[];
  /** Samples dropped for blinks or non-finite values. */
  droppedInvalid: number;
  /** Samples dropped by the per-target MAD rule. */
  rejectedOutliers: number;
  /** Indices (into EyeFeatures.vector) that received quadratic terms. */
  dominantFeatures: number[];
  /** Columns in the expanded design. */
  expandedDim: number;
  targets: number;
}

export interface TrainResult {
  model: RidgeGazeModel;
  /** Cross-validated: each target's predictions come from a model that never saw it. */
  report: CalibrationReport;
  diagnostics: TrainDiagnostics;
}

export interface RefineOptions {
  viewport?: { width: number; height: number };
  /** Also fit a (strongly shrunk) per-axis scale, not just an offset. Default true. */
  fitScale?: boolean;
  /** κ in λ = κ·Σ(p − p̄)²; the OLS scale correction is divided by (1 + κ). Default 2. */
  scaleShrinkage?: number;
  /** Drop samples whose blink score exceeds this (default {@link MAX_BLINK}). */
  maxBlink?: number;
}

/** What the running build expects of a stored model. */
export interface ModelCompatibility {
  featureLength?: number;
  featureNames?: readonly string[];
}

/** x' = sx·x + ox, y' = sy·y + oy, in absolute screen CSS px. */
export interface AxisAffine {
  sx: number;
  ox: number;
  sy: number;
  oy: number;
}

export interface GazeModelParams {
  featureLength: number;
  featureSignature: string | null;
  mean: Float64Array;
  std: Float64Array;
  /** Dominant feature indices, expanded as z_a·z_b for a ≤ b. */
  quad: readonly number[];
  /** The dominant features a Z_REJECT outlier on means a tracking glitch (no posture features). Default: quad. */
  glitchCheck?: readonly number[];
  expMean: Float64Array;
  expStd: Float64Array;
  wx: Float64Array;
  bx: number;
  wy: Float64Array;
  by: number;
  lambda: number;
  viewport: { width: number; height: number };
  /** window.screenX/Y at calibration time. */
  origin: Point;
  adjust: AxisAffine;
  /** Epoch ms (Date.now()) — persisted across sessions, so not performance.now(). */
  trainedAt: number;
}

const IDENTITY: Readonly<AxisAffine> = Object.freeze({ sx: 1, ox: 0, sy: 1, oy: 0 });

// ─────────────────────────────── The model ───────────────────────────────────

export class RidgeGazeModel implements GazeModel {
  readonly viewport: { width: number; height: number };
  readonly trainedAt: number;
  readonly lambda: number;
  readonly featureLength: number;
  readonly featureSignature: string | null;
  readonly dominantFeatures: readonly number[];
  private readonly params: GazeModelParams;
  private readonly glitchCheck: readonly number[];
  // Scratch buffers: predict runs at camera rate, so avoid per-call allocation.
  private readonly zBuf: Float64Array;
  private readonly phiBuf: Float64Array;

  constructor(params: GazeModelParams) {
    this.params = params;
    this.viewport = { width: params.viewport.width, height: params.viewport.height };
    this.trainedAt = params.trainedAt;
    this.lambda = params.lambda;
    this.featureLength = params.featureLength;
    this.featureSignature = params.featureSignature;
    this.dominantFeatures = Object.freeze([...params.quad]);
    this.glitchCheck = Object.freeze([...(params.glitchCheck ?? params.quad)]);
    this.zBuf = new Float64Array(params.featureLength);
    this.phiBuf = new Float64Array(params.expMean.length);
  }

  /** The screen-space correction stacked on top of the ridge maps (identity unless quick-refined). */
  get adjustment(): AxisAffine {
    return { ...this.params.adjust };
  }

  predict(features: EyeFeatures): Point | null {
    const s = this.predictScreen(features);
    if (!s) return null;
    const o = currentScreenOrigin();
    return { x: s.x - o.x, y: s.y - o.y };
  }

  /** Gaze in absolute screen CSS px (viewport px + window origin), or null. */
  predictScreen(features: EyeFeatures | null | undefined): Point | null {
    const v = features?.vector;
    return Array.isArray(v) ? this.predictScreenFromVector(v) : null;
  }

  predictScreenFromVector(v: ArrayLike<number>): Point | null {
    const P = this.params;
    if (v.length !== P.featureLength) return null;
    const z = this.zBuf;
    for (let j = 0; j < P.featureLength; j++) {
      const x = v[j];
      if (!Number.isFinite(x)) return null;
      z[j] = (x - P.mean[j]) / P.std[j];
    }
    for (const q of this.glitchCheck) if (Math.abs(z[q]) > Z_REJECT) return null;
    for (let j = 0; j < P.featureLength; j++) z[j] = clamp(z[j], -Z_CLAMP, Z_CLAMP);

    const phi = this.phiBuf;
    expandInto(z, P.quad, phi);
    for (let k = 0; k < phi.length; k++) phi[k] = (phi[k] - P.expMean[k]) / P.expStd[k];

    const sx = P.bx + dot(P.wx, phi) + P.origin.x;
    const sy = P.by + dot(P.wy, phi) + P.origin.y;
    const x = P.adjust.sx * sx + P.adjust.ox;
    const y = P.adjust.sy * sy + P.adjust.oy;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }

  /** A copy with a different screen-space correction (quick recalibration). */
  withAdjustment(adjust: AxisAffine, meta: { viewport: { width: number; height: number }; trainedAt: number }): RidgeGazeModel {
    return new RidgeGazeModel({
      ...this.params,
      adjust: { ...adjust },
      viewport: { ...meta.viewport },
      trainedAt: meta.trainedAt,
    });
  }

  toJSON(): SerializedGazeModel {
    const P = this.params;
    return {
      version: GAZE_MODEL_VERSION,
      kind: GAZE_MODEL_KIND,
      featureLength: P.featureLength,
      featureSignature: P.featureSignature,
      mean: Array.from(P.mean),
      std: Array.from(P.std),
      quad: [...P.quad],
      glitchCheck: [...this.glitchCheck],
      expMean: Array.from(P.expMean),
      expStd: Array.from(P.expStd),
      wx: Array.from(P.wx),
      bx: P.bx,
      wy: Array.from(P.wy),
      by: P.by,
      lambda: P.lambda,
      viewport: { width: P.viewport.width, height: P.viewport.height },
      origin: { x: P.origin.x, y: P.origin.y },
      adjust: { ...P.adjust },
      trainedAt: P.trainedAt,
    };
  }
}

// ──────────────────────────────── Training ───────────────────────────────────

interface Row {
  target: Point;
  x: Float64Array;
  key: string;
}

interface Group {
  target: Point;
  /** Indices into the row array the group was built from. */
  rows: number[];
}

interface ColumnStats {
  mean: Float64Array;
  std: Float64Array;
  constant: Uint8Array;
}

export function trainGazeModel(samples: CalibrationSample[], opts: TrainOptions = {}): TrainResult {
  const prepared = prepareRows(samples, undefined, opts.maxBlink);
  const p = prepared.featureLength;
  // A signature over the wrong number of names would make every reload reject the model.
  if (opts.featureNames && opts.featureNames.length !== p) {
    throw new RangeError(`featureNames lists ${opts.featureNames.length} features but the vectors have ${p}.`);
  }
  let rows = prepared.rows;
  const initialGroups = groupRows(rows);
  if (initialGroups.length < MIN_TARGETS) {
    throw new Error(`Need at least ${MIN_TARGETS} calibration points with usable samples (got ${initialGroups.length}).`);
  }
  const qWanted = Math.max(0, Math.floor(opts.quadraticFeatures ?? DEFAULT_QUADRATIC_FEATURES));
  // Quadratic terms need several distinct targets to be identifiable at all.
  const qMax = Math.min(qWanted, Math.max(0, initialGroups.length - 3));

  let stats = columnStats(rows, p);
  let dominant = selectDominant(rows, stats, qMax);
  let rejected = 0;
  if (opts.rejectOutliers !== false && dominant.length > 0) {
    const keep = rejectOutliers(rows, initialGroups, stats, dominant);
    rejected = rows.length - keep.length;
    if (rejected > 0) {
      rows = keep.map((i) => rows[i]);
      stats = columnStats(rows, p);
      dominant = selectDominant(rows, stats, qMax);
    }
  }
  const groups = groupRows(rows);
  if (groups.length < MIN_TARGETS || rows.length < MIN_SAMPLES) {
    throw new Error('Not enough usable calibration samples — keep your eyes on the dots and try again.');
  }

  // Expanded, standardized design matrix (row-major n × D).
  const n = rows.length;
  const D = p + (dominant.length * (dominant.length + 1)) / 2;
  const design = new Float64Array(n * D);
  const z = new Float64Array(p);
  for (let i = 0; i < n; i++) {
    standardizeInto(rows[i].x, stats, z);
    expandInto(z, dominant, design.subarray(i * D, (i + 1) * D));
  }
  const exp = standardizeColumns(design, n, D);

  const groupEqs = groups.map((g) => {
    const eq = new RidgeNormalEquations(D, 2);
    const y = new Float64Array(2);
    for (const i of g.rows) {
      y[0] = rows[i].target.x;
      y[1] = rows[i].target.y;
      eq.add(design.subarray(i * D, (i + 1) * D), y);
    }
    return eq;
  });
  const total = new RidgeNormalEquations(D, 2);
  for (const eq of groupEqs) total.merge(eq);
  const folds = groupEqs.map((eq) => total.clone().merge(eq, -1));

  const lambdas = sanitizeLambdas(opts.lambdas);
  const cv = lambdas.map((lambda) => {
    let sum = 0;
    for (let g = 0; g < groups.length; g++) {
      const sol = folds[g].solve(lambda);
      let err = 0;
      for (const i of groups[g].rows) {
        const off = i * D;
        const px = sol.bias[0] + dotAt(sol.weights[0], design, off, D);
        const py = sol.bias[1] + dotAt(sol.weights[1], design, off, D);
        err += Math.hypot(px - rows[i].target.x, py - rows[i].target.y);
      }
      sum += err / groups[g].rows.length;
    }
    return { lambda, errorPx: sum / groups.length };
  });
  const lambda = chooseLambda(cv);

  const final = total.solve(lambda);
  const viewport = resolveViewport(opts.viewport, rows);
  const model = new RidgeGazeModel({
    featureLength: p,
    featureSignature: opts.featureNames ? featureSignature(opts.featureNames) : null,
    mean: stats.mean,
    std: stats.std,
    quad: dominant,
    glitchCheck: glitchCheckFor(dominant, opts.featureNames),
    expMean: exp.mean,
    expStd: exp.std,
    wx: final.weights[0],
    bx: final.bias[0],
    wy: final.weights[1],
    by: final.bias[1],
    lambda,
    viewport,
    origin: currentScreenOrigin(),
    adjust: { ...IDENTITY },
    trainedAt: Date.now(),
  });

  // Honest report: every target predicted by the fold that held it out.
  const points = groups.map((g, gi) => {
    const sol = folds[gi].solve(lambda);
    const preds = g.rows.map((i) => {
      const off = i * D;
      return {
        x: sol.bias[0] + dotAt(sol.weights[0], design, off, D),
        y: sol.bias[1] + dotAt(sol.weights[1], design, off, D),
      };
    });
    return { target: g.target, preds };
  });
  const report = buildReport(points, lambda, viewport.height, false);

  return {
    model,
    report,
    diagnostics: {
      cv,
      droppedInvalid: prepared.dropped,
      rejectedOutliers: rejected,
      dominantFeatures: [...dominant],
      expandedDim: D,
      targets: groups.length,
    },
  };
}

/**
 * Quick recalibration: keeps the base model's ridge maps and fits only a
 * screen-space offset (plus, optionally, a heavily shrunk per-axis scale) from
 * a handful of targets — enough to absorb "I'm sitting a bit differently
 * today". The report is leave-one-target-out when there are ≥ 3 targets.
 */
export function refineGazeModel(
  base: GazeModel,
  samples: CalibrationSample[],
  opts: RefineOptions = {},
): { model: RidgeGazeModel; report: CalibrationReport } {
  const inner = asRidgeGazeModel(base);
  if (!inner) throw new Error('This calibration can’t be refined — please run a full calibration.');
  const { rows } = prepareRows(samples, inner.featureLength, opts.maxBlink);
  const origin = currentScreenOrigin();
  const fitScale = opts.fitScale ?? true;
  const kappa = Math.max(0, opts.scaleShrinkage ?? DEFAULT_SCALE_SHRINKAGE);

  const obs: RefinePoint[] = [];
  for (const g of groupRows(rows)) {
    const preds: Point[] = [];
    for (const i of g.rows) {
      const s = inner.predictScreenFromVector(rows[i].x);
      if (s) preds.push(s);
    }
    const kept = robustPoints(preds);
    if (kept.length === 0) continue;
    obs.push({
      target: g.target,
      targetScreen: { x: g.target.x + origin.x, y: g.target.y + origin.y },
      preds: kept,
      mean: meanPoint(kept),
    });
  }
  if (obs.length === 0) throw new Error('No usable samples for a quick calibration.');

  const fit = fitAffine(obs, fitScale, kappa);
  const old = inner.adjustment;
  const composed: AxisAffine = {
    sx: fit.sx * old.sx,
    ox: fit.sx * old.ox + fit.ox,
    sy: fit.sy * old.sy,
    oy: fit.sy * old.oy + fit.oy,
  };
  const viewport = resolveViewport(opts.viewport, rows);
  const model = inner.withAdjustment(composed, { viewport, trainedAt: Date.now() });

  const points = obs.map((o, h) => {
    const f = obs.length >= 3 ? fitAffine(obs.filter((_, k) => k !== h), fitScale, kappa) : fit;
    return {
      target: o.target,
      preds: o.preds.map((p) => ({ x: f.sx * p.x + f.ox - origin.x, y: f.sy * p.y + f.oy - origin.y })),
    };
  });
  return { model, report: buildReport(points, inner.lambda, viewport.height, false) };
}

/**
 * Accuracy of `model` on `samples` (e.g. validation targets it never saw).
 * Per target, predictions are robustly filtered (same 2.5-MAD rule) and
 * averaged; the error is the distance of that mean from the target — the
 * standard "accuracy" measure in eye tracking. With nothing evaluable the
 * errors are NaN, `sampleCount` is 0 and quality is 'poor'.
 */
export function evaluateModel(model: GazeModel, samples: CalibrationSample[], opts: EvaluateOptions = {}): CalibrationReport {
  const maxBlink = blinkCutoff(opts.maxBlink);
  const groups = new Map<string, { target: Point; preds: Point[] }>();
  for (const s of Array.isArray(samples) ? samples : []) {
    if (!s || !isFinitePoint(s.target) || !s.features) continue;
    if (s.features.blink > maxBlink) continue;
    let p: Point | null = null;
    try {
      p = model.predict(s.features);
    } catch {
      p = null;
    }
    if (!p || !isFinitePoint(p)) continue;
    const key = targetKey(s.target);
    let g = groups.get(key);
    if (!g) {
      g = { target: { x: s.target.x, y: s.target.y }, preds: [] };
      groups.set(key, g);
    }
    g.preds.push({ x: p.x, y: p.y });
  }
  const vh = model.viewport && Number.isFinite(model.viewport.height) ? model.viewport.height : 0;
  return buildReport([...groups.values()], modelLambda(model), vh, true);
}

/**
 * Maps a mean error to a quality badge.
 *
 * Two yardsticks, and the worse one wins:
 *
 * • Lines of text (typical pitch 22 px × 1.9 ≈ 42 px). At a normal laptop
 *   viewing distance one line is roughly 1° of visual angle, about the best a
 *   webcam tracker can do.
 *   – excellent ≤ 1.25 lines: raw gaze alone nearly pins the line.
 *   – good ≤ 2.25 lines: well inside the line tracker's comfort zone (its σ_y
 *     starts at 0.9 lines and adapts up to 3), return sweeps do the rest.
 *   – fair ≤ 3.5 lines: tracking leans on reading structure and the
 *     bottom-dwell / glance-down fallbacks; page turns work but may lag.
 *   – beyond that the HMM can no longer tell neighbouring lines apart: poor.
 *
 * • Fraction of the viewport height (7 % / 13 % / 22 %). Page-end detection
 *   must separate "the last lines" from "the middle of the page"; on a short
 *   window the same pixel error covers more of the page. The two scales agree
 *   near a 720 px viewport (~17 lines), so on bigger screens the line rule
 *   governs and on small windows the viewport rule does.
 */
export function qualityFromError(errorPx: number, viewportHeight: number): CalibrationQuality {
  if (!Number.isFinite(errorPx) || errorPx < 0) return 'poor';
  const lines = errorPx / DEFAULT_LINE_PITCH_PX;
  let rank = lines <= 1.25 ? 0 : lines <= 2.25 ? 1 : lines <= 3.5 ? 2 : 3;
  if (Number.isFinite(viewportHeight) && viewportHeight > 0) {
    const frac = errorPx / viewportHeight;
    rank = Math.max(rank, frac <= 0.07 ? 0 : frac <= 0.13 ? 1 : frac <= 0.22 ? 2 : 3);
  }
  return QUALITY_BY_RANK[rank];
}

const QUALITY_BY_RANK: readonly CalibrationQuality[] = ['excellent', 'good', 'fair', 'poor'];

// ───────────────────────────── Persistence ───────────────────────────────────

/** Validates untrusted JSON (storage, extension messages). Null if invalid or incompatible. */
export function deserializeGazeModel(json: unknown, expect: ModelCompatibility = {}): RidgeGazeModel | null {
  try {
    if (!isRecord(json) || json.version !== GAZE_MODEL_VERSION || json.kind !== GAZE_MODEL_KIND) return null;
    const featureLength = json.featureLength;
    if (typeof featureLength !== 'number' || !Number.isInteger(featureLength) || featureLength < 1) return null;
    if (expect.featureLength !== undefined && expect.featureLength !== featureLength) return null;

    const sig = json.featureSignature;
    if (sig !== undefined && sig !== null && typeof sig !== 'string') return null;
    if (expect.featureNames) {
      if (expect.featureNames.length !== featureLength) return null;
      if (typeof sig === 'string' && sig !== featureSignature(expect.featureNames)) return null;
    }

    const mean = finiteVector(json.mean, featureLength);
    const std = finiteVector(json.std, featureLength, true);
    const quad = indexList(json.quad, featureLength);
    if (!mean || !std || !quad) return null;
    // Models saved before the field existed: derive it from the running build's feature names.
    const glitchCheck = json.glitchCheck === undefined ? glitchCheckFor(quad, expect.featureNames) : indexList(json.glitchCheck, featureLength);
    if (!glitchCheck) return null;
    const D = featureLength + (quad.length * (quad.length + 1)) / 2;
    const expMean = finiteVector(json.expMean, D);
    const expStd = finiteVector(json.expStd, D, true);
    const wx = finiteVector(json.wx, D);
    const wy = finiteVector(json.wy, D);
    if (!expMean || !expStd || !wx || !wy) return null;

    const bx = json.bx;
    const by = json.by;
    const lambda = json.lambda;
    const trainedAt = json.trainedAt;
    if (!isFiniteNumber(bx) || !isFiniteNumber(by) || !isFiniteNumber(trainedAt)) return null;
    if (!isFiniteNumber(lambda) || lambda < 0) return null;

    const vp = json.viewport;
    if (!isRecord(vp) || !isPositive(vp.width) || !isPositive(vp.height)) return null;
    const origin = json.origin;
    if (!isRecord(origin) || !isFiniteNumber(origin.x) || !isFiniteNumber(origin.y)) return null;

    let adjust: AxisAffine = { ...IDENTITY };
    if (json.adjust !== undefined) {
      const a = json.adjust;
      if (!isRecord(a) || !isPositive(a.sx) || !isPositive(a.sy) || !isFiniteNumber(a.ox) || !isFiniteNumber(a.oy)) {
        return null;
      }
      adjust = { sx: a.sx, ox: a.ox, sy: a.sy, oy: a.oy };
    }

    return new RidgeGazeModel({
      featureLength,
      featureSignature: typeof sig === 'string' ? sig : null,
      mean,
      std,
      quad,
      glitchCheck,
      expMean,
      expStd,
      wx,
      bx,
      wy,
      by,
      lambda,
      viewport: { width: vp.width, height: vp.height },
      origin: { x: origin.x, y: origin.y },
      adjust,
      trainedAt,
    });
  } catch {
    return null;
  }
}

export function saveCalibration(model: GazeModel): void {
  writeJSON(CALIBRATION_STORAGE_KEY, model.toJSON());
}

/** Loads the saved model; null when missing, corrupt or built for different features. */
export function loadCalibration(expect: ModelCompatibility = {}): RidgeGazeModel | null {
  return deserializeGazeModel(readJSON<unknown>(CALIBRATION_STORAGE_KEY, null), expect);
}

export function clearCalibration(): void {
  removeKey(CALIBRATION_STORAGE_KEY);
}

/** The model as our concrete class (directly or via a JSON round trip), or null. */
export function asRidgeGazeModel(model: GazeModel | null | undefined): RidgeGazeModel | null {
  if (!model) return null;
  if (model instanceof RidgeGazeModel) return model;
  try {
    return deserializeGazeModel(model.toJSON());
  } catch {
    return null;
  }
}

/** Stable signature of a feature-name list (FNV-1a over the names, plus the count). */
export function featureSignature(names: readonly string[]): string {
  let h = 0x811c9dc5;
  const text = names.join('\u001f');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16).padStart(8, '0')}:${names.length}`;
}

/** window.screenX/Y (CSS px), or 0,0 when there is no window (tests, workers). */
export function currentScreenOrigin(): Point {
  if (typeof window === 'undefined' || !window) return { x: 0, y: 0 };
  const w: Partial<Pick<Window, 'screenX' | 'screenY' | 'screenLeft' | 'screenTop'>> = window;
  return { x: firstFinite(w.screenX, w.screenLeft), y: firstFinite(w.screenY, w.screenTop) };
}

// ─────────────────────────────── Internals ───────────────────────────────────

function prepareRows(
  samples: readonly CalibrationSample[],
  expectedLength?: number,
  maxBlinkOption?: number,
): { rows: Row[]; featureLength: number; dropped: number } {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error('No calibration samples.');
  const maxBlink = blinkCutoff(maxBlinkOption);
  let len = expectedLength ?? -1;
  const rows: Row[] = [];
  let dropped = 0;
  for (const s of samples) {
    const v: unknown = s?.features?.vector;
    if (!Array.isArray(v)) {
      dropped++;
      continue;
    }
    if (len < 0) len = v.length;
    if (v.length !== len) {
      throw new RangeError(
        expectedLength !== undefined
          ? `Feature vector has ${v.length} entries but the model expects ${expectedLength}.`
          : `Calibration samples have inconsistent feature lengths (${v.length} vs ${len}).`,
      );
    }
    // A missing (NaN) blink score compares false and keeps the sample.
    if (!isFinitePoint(s.target) || s.features.blink > maxBlink) {
      dropped++;
      continue;
    }
    const x = new Float64Array(len);
    let ok = true;
    for (let j = 0; j < len; j++) {
      const value: unknown = v[j];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        ok = false;
        break;
      }
      x[j] = value;
    }
    if (!ok) {
      dropped++;
      continue;
    }
    rows.push({ target: { x: s.target.x, y: s.target.y }, x, key: targetKey(s.target) });
  }
  if (len <= 0) throw new Error('Calibration samples carry no features.');
  return { rows, featureLength: len, dropped };
}

/** A caller's blink cutoff, or MAX_BLINK when absent/NaN (Infinity keeps everything). */
function blinkCutoff(v: number | undefined): number {
  return typeof v === 'number' && !Number.isNaN(v) ? v : MAX_BLINK;
}

function targetKey(t: Point): string {
  return `${Math.round(t.x)},${Math.round(t.y)}`;
}

function groupRows(rows: readonly Row[]): Group[] {
  const map = new Map<string, Group>();
  rows.forEach((r, i) => {
    let g = map.get(r.key);
    if (!g) {
      g = { target: { x: r.target.x, y: r.target.y }, rows: [] };
      map.set(r.key, g);
    }
    g.rows.push(i);
  });
  return [...map.values()];
}

function columnStats(rows: readonly Row[], p: number): ColumnStats {
  const n = rows.length;
  const mean = new Float64Array(p);
  const std = new Float64Array(p);
  const constant = new Uint8Array(p);
  for (const r of rows) for (let j = 0; j < p; j++) mean[j] += r.x[j];
  for (let j = 0; j < p; j++) mean[j] /= Math.max(n, 1);
  for (const r of rows) {
    for (let j = 0; j < p; j++) {
      const d = r.x[j] - mean[j];
      std[j] += d * d;
    }
  }
  for (let j = 0; j < p; j++) {
    const sd = Math.sqrt(std[j] / Math.max(n, 1));
    // A (numerically) constant feature carries no information; dividing by
    // its ~0 SD would turn rounding noise into huge z-scores.
    if (!(sd > 1e-9 * Math.max(1, Math.abs(mean[j])))) {
      std[j] = 1;
      constant[j] = 1;
    } else {
      std[j] = sd;
    }
  }
  return { mean, std, constant };
}

function standardizeInto(x: ArrayLike<number>, stats: ColumnStats, out: Float64Array): void {
  for (let j = 0; j < out.length; j++) out[j] = clamp((x[j] - stats.mean[j]) / stats.std[j], -Z_CLAMP, Z_CLAMP);
}

/** [z, z_a·z_b for a ≤ b over the dominant features] → out (length p + q(q+1)/2). */
function expandInto(z: Float64Array, quad: readonly number[], out: Float64Array): void {
  out.set(z);
  let k = z.length;
  for (let a = 0; a < quad.length; a++) {
    const za = z[quad[a]];
    for (let b = a; b < quad.length; b++) out[k++] = za * z[quad[b]];
  }
}

/** Standardizes the columns of a row-major n × D matrix in place; returns the column stats. */
function standardizeColumns(m: Float64Array, n: number, D: number): { mean: Float64Array; std: Float64Array } {
  const mean = new Float64Array(D);
  const std = new Float64Array(D);
  for (let i = 0; i < n; i++) for (let k = 0; k < D; k++) mean[k] += m[i * D + k];
  for (let k = 0; k < D; k++) mean[k] /= n;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < D; k++) {
      const d = m[i * D + k] - mean[k];
      std[k] += d * d;
    }
  }
  for (let k = 0; k < D; k++) {
    const sd = Math.sqrt(std[k] / n);
    std[k] = sd > 1e-9 * Math.max(1, Math.abs(mean[k])) ? sd : 1;
  }
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < D; k++) m[i * D + k] = (m[i * D + k] - mean[k]) / std[k];
  }
  return { mean, std };
}

/**
 * Chooses up to `q` features for quadratic terms: alternately the strongest
 * remaining correlate of target x and of target y (so the vertical axis —
 * the hard one for webcams — always gets its share), skipping features that
 * are near-duplicates (|r| > 0.95) of one already chosen.
 */
function selectDominant(rows: readonly Row[], stats: ColumnStats, q: number): number[] {
  const n = rows.length;
  const p = stats.mean.length;
  if (q <= 0 || n < 2) return [];
  const z = rows.map((r) => {
    const out = new Float64Array(p);
    standardizeInto(r.x, stats, out);
    return out;
  });
  const corrWithTarget = (axis: 'x' | 'y'): Float64Array => {
    const t = rows.map((r) => r.target[axis]);
    const tm = t.reduce((a, b) => a + b, 0) / n;
    const ts = Math.sqrt(t.reduce((a, b) => a + (b - tm) ** 2, 0) / n);
    const r = new Float64Array(p);
    if (!(ts > 0)) return r;
    for (let i = 0; i < n; i++) {
      const tc = (t[i] - tm) / ts;
      for (let j = 0; j < p; j++) r[j] += z[i][j] * tc;
    }
    for (let j = 0; j < p; j++) r[j] = stats.constant[j] ? 0 : Math.abs(r[j] / n);
    return r;
  };
  const score = { x: corrWithTarget('x'), y: corrWithTarget('y') };
  const order = {
    x: [...Array(p).keys()].sort((a, b) => score.x[b] - score.x[a]),
    y: [...Array(p).keys()].sort((a, b) => score.y[b] - score.y[a]),
  };
  const featureCorr = (a: number, b: number): number => {
    let s = 0;
    for (let i = 0; i < n; i++) s += z[i][a] * z[i][b];
    return Math.abs(s / n);
  };

  const chosen: number[] = [];
  const cursor = { x: 0, y: 0 };
  const exhausted = { x: false, y: false };
  let axis: 'x' | 'y' = 'x';
  while (chosen.length < q && !(exhausted.x && exhausted.y)) {
    if (!exhausted[axis]) {
      let picked = false;
      while (cursor[axis] < p) {
        const j = order[axis][cursor[axis]++];
        if (score[axis][j] < MIN_DOMINANT_CORR) {
          cursor[axis] = p;
          break;
        }
        if (chosen.includes(j) || chosen.some((c) => featureCorr(c, j) > REDUNDANT_CORR)) continue;
        chosen.push(j);
        picked = true;
        break;
      }
      if (!picked) exhausted[axis] = true;
    }
    axis = axis === 'x' ? 'y' : 'x';
  }
  return chosen;
}

/** Row indices that survive the per-target MAD rule on the dominant features. */
function rejectOutliers(rows: readonly Row[], groups: readonly Group[], stats: ColumnStats, dominant: readonly number[]): number[] {
  const keep: number[] = [];
  for (const g of groups) {
    const cols = dominant.map((j) =>
      Float64Array.from(g.rows, (i) => clamp((rows[i].x[j] - stats.mean[j]) / stats.std[j], -Z_CLAMP * 4, Z_CLAMP * 4)),
    );
    for (const k of robustKeep(cols, g.rows.length, FEATURE_MAD_FLOOR)) keep.push(g.rows[k]);
  }
  return keep.sort((a, b) => a - b);
}

/**
 * Indices (ascending) of the points to keep: a point is an outlier when, in
 * any dimension, it lies more than MAD_THRESHOLD robust SDs from the median.
 * Needs ≥ 5 points to say anything; never drops more than a third (the most
 * extreme first), because a target that is mostly "outliers" is really a
 * target whose median we don't trust either.
 *
 * With 6 dominant features the per-feature rule also trims ~5–9 % of clean
 * Gaussian samples. That is deliberate and cheap: symmetric tail trimming
 * doesn't bias the per-target mean, and on synthetic data the robust fit
 * matched a fit on uncontaminated samples to within 0.2 px.
 */
function robustKeep(columns: readonly ArrayLike<number>[], m: number, floor: number): number[] {
  const all = [...Array(m).keys()];
  if (m < 5 || columns.length === 0) return all;
  const dist = new Float64Array(m);
  for (const col of columns) {
    const values = Array.from({ length: m }, (_, i) => col[i]);
    const med = median(values);
    const scale = Math.max(MAD_TO_SD * median(values.map((v) => Math.abs(v - med))), floor);
    for (let i = 0; i < m; i++) dist[i] = Math.max(dist[i], Math.abs(values[i] - med) / scale);
  }
  const flagged = all.filter((i) => dist[i] > MAD_THRESHOLD).sort((a, b) => dist[b] - dist[a]);
  const drop = new Set(flagged.slice(0, Math.floor(m * MAX_REJECT_FRACTION)));
  return all.filter((i) => !drop.has(i));
}

function robustPoints(preds: readonly Point[]): Point[] {
  const keep = robustKeep(
    [preds.map((p) => p.x), preds.map((p) => p.y)],
    preds.length,
    PREDICTION_MAD_FLOOR_PX,
  );
  return keep.map((i) => preds[i]);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function sanitizeLambdas(input: readonly number[] | undefined): number[] {
  const clean = (input ?? DEFAULT_LAMBDAS).filter((l) => Number.isFinite(l) && l >= 0);
  const unique = [...new Set(clean)].sort((a, b) => a - b);
  return unique.length > 0 ? unique : [...DEFAULT_LAMBDAS];
}

/** Largest λ whose CV error is within LAMBDA_TIE_TOLERANCE of the best (a light one-SE rule). */
function chooseLambda(cv: readonly { lambda: number; errorPx: number }[]): number {
  const finite = cv.filter((c) => Number.isFinite(c.errorPx));
  if (finite.length === 0) return 1;
  const best = Math.min(...finite.map((c) => c.errorPx));
  let chosen = finite[0].lambda;
  for (const c of finite) if (c.errorPx <= best * (1 + LAMBDA_TIE_TOLERANCE) + 1e-9) chosen = Math.max(chosen, c.lambda);
  return chosen;
}

function dotAt(w: Float64Array, m: Float64Array, offset: number, D: number): number {
  let s = 0;
  for (let k = 0; k < D; k++) s += w[k] * m[offset + k];
  return s;
}

interface RefinePoint {
  target: Point;
  targetScreen: Point;
  preds: Point[];
  mean: Point;
}

function fitAffine(obs: readonly RefinePoint[], fitScale: boolean, kappa: number): AxisAffine {
  const x = fitAxis(obs.map((o) => o.mean.x), obs.map((o) => o.targetScreen.x), fitScale, kappa);
  const y = fitAxis(obs.map((o) => o.mean.y), obs.map((o) => o.targetScreen.y), fitScale, kappa);
  return { sx: x.s, ox: x.o, sy: y.s, oy: y.o };
}

/** t ≈ s·p + o with s shrunk towards 1. */
function fitAxis(p: readonly number[], t: readonly number[], fitScale: boolean, kappa: number): { s: number; o: number } {
  const n = p.length;
  const pm = p.reduce((a, b) => a + b, 0) / n;
  const spread = p.reduce((a, b) => a + (b - pm) ** 2, 0);
  let s = 1;
  if (fitScale && n >= 3 && spread > n * MIN_SCALE_SPREAD_PX ** 2) {
    // Regress the residual (t − p) on p: its slope is (s − 1), and ridge
    // shrinks exactly that slope while leaving the offset unpenalized.
    const { weights } = ridgeFit(
      p.map((v) => [v]),
      t.map((v, i) => v - p[i]),
      kappa * spread,
    );
    s = clamp(1 + weights[0], SCALE_MIN, SCALE_MAX);
  }
  const o = t.reduce((acc, v, i) => acc + (v - s * p[i]), 0) / n;
  return { s, o };
}

function buildReport(
  points: readonly { target: Point; preds: readonly Point[] }[],
  lambda: number,
  viewportHeight: number,
  robust: boolean,
): CalibrationReport {
  const perPoint: CalibrationReport['perPoint'] = [];
  let sampleCount = 0;
  for (const pt of points) {
    const preds = robust ? robustPoints(pt.preds) : pt.preds;
    if (preds.length === 0) continue;
    const m = meanPoint(preds);
    perPoint.push({
      target: { x: pt.target.x, y: pt.target.y },
      meanPrediction: m,
      errorPx: Math.hypot(m.x - pt.target.x, m.y - pt.target.y),
      samples: preds.length,
    });
    sampleCount += preds.length;
  }
  if (perPoint.length === 0) {
    return { meanErrorPx: NaN, meanErrorXPx: NaN, meanErrorYPx: NaN, perPoint, lambda, sampleCount: 0, quality: 'poor' };
  }
  const k = perPoint.length;
  const meanErrorPx = perPoint.reduce((a, p) => a + p.errorPx, 0) / k;
  const meanErrorXPx = perPoint.reduce((a, p) => a + Math.abs(p.meanPrediction.x - p.target.x), 0) / k;
  const meanErrorYPx = perPoint.reduce((a, p) => a + Math.abs(p.meanPrediction.y - p.target.y), 0) / k;
  return {
    meanErrorPx,
    meanErrorXPx,
    meanErrorYPx,
    perPoint,
    lambda,
    sampleCount,
    quality: qualityFromError(meanErrorPx, viewportHeight),
  };
}

function meanPoint(ps: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of ps) {
    x += p.x;
    y += p.y;
  }
  return { x: x / ps.length, y: y / ps.length };
}

function modelLambda(model: GazeModel): number {
  if (model instanceof RidgeGazeModel) return model.lambda;
  try {
    const l = model.toJSON().lambda;
    return isFiniteNumber(l) ? l : 0;
  } catch {
    return 0;
  }
}

function resolveViewport(v: { width: number; height: number } | undefined, rows: readonly Row[]): { width: number; height: number } {
  if (v && isPositive(v.width) && isPositive(v.height)) return { width: v.width, height: v.height };
  if (typeof window !== 'undefined' && window && isPositive(window.innerWidth) && isPositive(window.innerHeight)) {
    return { width: window.innerWidth, height: window.innerHeight };
  }
  // Calibration grids are symmetric (e.g. 10 %…90 %), so min + max ≈ the extent.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const r of rows) {
    minX = Math.min(minX, r.target.x);
    maxX = Math.max(maxX, r.target.x);
    minY = Math.min(minY, r.target.y);
    maxY = Math.max(maxY, r.target.y);
  }
  const width = Math.max(1, maxX + Math.max(0, minX));
  const height = Math.max(1, maxY + Math.max(0, minY));
  return { width: Number.isFinite(width) ? width : 1, height: Number.isFinite(height) ? height : 1 };
}

function finiteVector(v: unknown, length: number, positive = false): Float64Array | null {
  if (!Array.isArray(v) || v.length !== length) return null;
  const out = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    const x: unknown = v[i];
    if (!isFiniteNumber(x) || (positive && !(x > 0))) return null;
    out[i] = x;
  }
  return out;
}

/** The dominant features whose wild values mean a tracking glitch: all of them, minus posture when the names are known. */
function glitchCheckFor(quad: readonly number[], names: readonly string[] | undefined): number[] {
  return names && names.length > 0 ? quad.filter((j) => !POSTURE_FEATURES.has(names[j] ?? '')) : [...quad];
}

function indexList(v: unknown, bound: number): number[] | null {
  if (!Array.isArray(v) || v.length > bound) return null;
  const seen = new Set<number>();
  for (const x of v) {
    if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x >= bound || seen.has(x)) return null;
    seen.add(x);
  }
  return [...seen];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPositive(v: unknown): v is number {
  return isFiniteNumber(v) && v > 0;
}

function isFinitePoint(p: unknown): p is Point {
  return isRecord(p) && isFiniteNumber(p.x) && isFiniteNumber(p.y);
}

function firstFinite(...values: (number | undefined)[]): number {
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
