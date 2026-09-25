import type {
  Fixation,
  GazeSample,
  LayoutChangeReason,
  LineEstimate,
  LineLayout,
  SaccadeKind,
  TextLine,
} from '../types';
import { classifySaccade } from '../signal/fixations';

/**
 * Which line is the reader on?
 *
 * A hidden Markov model (forward filter) over the readable lines of the
 * current layout. Webcam gaze is decent horizontally but noisy and drifty
 * vertically, so the model leans on the structure of reading: fixations march
 * rightwards along a line and a return sweep moves to the next one. Vertical
 * position only has to keep that count honest.
 *
 * The vertical bias of the gaze signal (drift) is part of the hidden state:
 * the state is (line, drift) with drift on a grid of ±maxDriftLines. That is
 * what lets it learn drift without first being sure of the line (and be sure
 * of the line without first knowing the drift): "line 7 with +0.5 lines of
 * drift" and "line 8 with −0.5" stay separate hypotheses until the page
 * itself tells them apart — the top of the page, a paragraph gap, a short
 * line, a return sweep — instead of an early guess locking in.
 *
 * - Emission: N(y − drift; line.centerY, σ_y²) (+ a small floor so one wild
 *   fixation can't wipe out the posterior), times a horizontal plausibility
 *   factor that penalizes x far outside the line (short paragraph-final lines).
 * - Line transitions by saccade kind: forward → stay .85 / next .07 / prev .03;
 *   regression → stay .85 / prev .08 / next .03; return sweep → next .75 /
 *   next+1 .08 / stay .07 / prev .03; jump → 60 % uniform + 40 % where dy
 *   points. The remaining mass is spread uniformly.
 * - Drift transitions: a slow Gaussian random walk (driftRate × 0.5 lines per
 *   fixation) plus a small chance of a sudden shift (the head moved).
 * - σ_y adapts from the residuals of confident fixations (0.4–3 lines).
 */

export interface LineTrackerOptions {
  /** Initial vertical emission σ, in lines (adapted online, clamped 0.4–3). */
  sigmaYLines: number;
  /** How fast the drift may wander: the random-walk step is driftRate × 0.5 lines per fixation. */
  driftRate: number;
  /** Drift range modeled, ± lines. */
  maxDriftLines: number;
}

export const DEFAULT_LINE_TRACKER_OPTIONS: Readonly<LineTrackerOptions> = Object.freeze({
  sigmaYLines: 0.9,
  driftRate: 0.15,
  maxDriftLines: 1.5,
});

/** A LineEstimate that also reports the tracker's current vertical σ (for the debug overlay). */
export interface TrackedLineEstimate extends LineEstimate {
  sigmaYPx: number;
}

export function isTrackedLineEstimate(e: LineEstimate | null | undefined): e is TrackedLineEstimate {
  return !!e && typeof (e as Partial<TrackedLineEstimate>).sigmaYPx === 'number';
}

interface TransitionRow {
  stay: number;
  next: number;
  next2: number;
  prev: number;
}

/** Line transition probabilities by saccade kind; the remainder is spread uniformly over all lines. */
export const LINE_TRANSITIONS: Readonly<Record<Exclude<SaccadeKind, 'jump'>, Readonly<TransitionRow>>> = Object.freeze({
  forward: Object.freeze({ stay: 0.85, next: 0.07, next2: 0, prev: 0.03 }),
  regression: Object.freeze({ stay: 0.85, next: 0.03, next2: 0, prev: 0.08 }),
  'return-sweep': Object.freeze({ stay: 0.07, next: 0.75, next2: 0.08, prev: 0.03 }),
});

/** After a jump: 60 % uniform, 40 % where the vertical displacement points (σ = 1 line). */
const JUMP_UNIFORM = 0.6;
const JUMP_KERNEL_SIGMA_LINES = 1;

/** Drift grid resolution, lines; the grid never exceeds MAX_DRIFT_BINS. */
const DRIFT_STEP_LINES = 0.1;
const MAX_DRIFT_BINS = 81;
/** Random-walk step per fixation = driftRate × this, in lines. */
const DRIFT_WALK_PER_RATE = 0.8;
/** Per-fixation probability that the drift jumps anywhere on the grid (head movement). */
const DRIFT_JUMP = 0.004;
/** Drift prior on a fresh start: N(0, σ) in lines (calibration is decent but rarely perfect). */
const DRIFT_PRIOR_SIGMA_LINES = 0.5;

/** Additive floor on the vertical likelihood: one wild fixation can shift the odds by at most ~1/floor. */
const EMISSION_FLOOR = 0.01;
/** Minimum horizontal plausibility (x far outside a line's extent). */
const HORIZONTAL_FLOOR = 0.05;

/** σ_y learns only from fixations the tracker is sure about... */
const LEARN_CONFIDENCE = 0.8;
/** ...whose drift-corrected residual is plausible (not a glance off the text), in lines... */
const LEARN_MAX_RESIDUAL_LINES = 0.75;
/** ...slowly, inflated to offset the selection bias of learning only when confident. */
const SIGMA_RATE = 0.04;
const SIGMA_INFLATE = 1.6;
const SIGMA_MIN_LINES = 0.4;
const SIGMA_MAX_LINES = 3;

/** A line counts as readable (a state) when at least this much of its height is inside the viewport. */
const READABLE_FRACTION = 0.6;
/** Line-probability mass kept uniform when carrying the posterior across a layout change. */
const REMAP_UNIFORM = 0.02;
/**
 * On a fresh layout people usually start at the top of the page: a gentle
 * top bias (the first line is 3× as likely as one far down).
 */
const TOP_PRIOR_BOOST = 2;
const TOP_PRIOR_DECAY_LINES = 3;

/** Prior after a page turn, relative to the resume line. */
const PAGE_TURN_PRIOR: ReadonlyArray<readonly [offset: number, weight: number]> = [
  [-1, 0.03],
  [0, 0.7],
  [1, 0.14],
  [2, 0.06],
  [3, 0.03],
];
const PAGE_TURN_UNIFORM = 0.04;

const FALLBACK_PITCH_PX = 40;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);

export class LineTracker {
  private readonly opts: LineTrackerOptions;
  /** Drift grid (lines), symmetric around 0. */
  private readonly grid: Float64Array;
  /** Random-walk kernel over drift bins (odd length, centered). */
  private readonly walk: Float64Array;

  private layout: LineLayout | null = null;
  /** Indices (into layout.lines) of the readable lines, top to bottom. */
  private states: number[] = [];
  /** Joint posterior, row k (state) × column b (drift bin). */
  private joint = new Float64Array(0);
  /** Drift belief independent of the layout; seeds new layouts. */
  private driftBelief: Float64Array;
  /** Line posterior per layout line (0 for unreadable lines); published as-is, never mutated. */
  private post: number[] = [];
  private prevFix: Fixation | null = null;
  private driftY = 0;
  private sigmaLines: number;
  /** EMA of squared drift-corrected residuals, lines². */
  private residVar: number;
  private fixCount = 0;
  private lastSaccade: SaccadeKind | null = null;
  private progressX = 0;
  private est: TrackedLineEstimate | null = null;

  constructor(opts: Partial<LineTrackerOptions> = {}) {
    const d = DEFAULT_LINE_TRACKER_OPTIONS;
    const num = (v: number | undefined, fallback: number, lo: number, hi: number): number =>
      v !== undefined && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
    this.opts = {
      sigmaYLines: num(opts.sigmaYLines, d.sigmaYLines, SIGMA_MIN_LINES, SIGMA_MAX_LINES),
      driftRate: num(opts.driftRate, d.driftRate, 0, 1),
      maxDriftLines: num(opts.maxDriftLines, d.maxDriftLines, 0, 10),
    };
    this.sigmaLines = this.opts.sigmaYLines;
    this.residVar = (this.sigmaLines / SIGMA_INFLATE) ** 2;

    const half = Math.min(Math.round(this.opts.maxDriftLines / DRIFT_STEP_LINES), (MAX_DRIFT_BINS - 1) / 2);
    const step = half > 0 ? this.opts.maxDriftLines / half : 0;
    this.grid = new Float64Array(2 * half + 1);
    for (let b = 0; b < this.grid.length; b++) this.grid[b] = (b - half) * step;
    this.walk = gaussianKernel(step > 0 ? (this.opts.driftRate * DRIFT_WALK_PER_RATE) / step : 0);
    this.driftBelief = this.driftPrior();
  }

  get estimate(): LineEstimate | null {
    return this.est;
  }

  /** Current vertical emission σ, px. */
  get sigmaYPx(): number {
    return this.sigmaLines * this.pitch();
  }

  setLayout(layout: LineLayout, reason: LayoutChangeReason): void {
    const old = this.layout;
    const oldStates = this.states;
    const oldJoint = this.joint;
    this.layout = layout;
    this.states = readableStates(layout);
    const m = this.states.length;
    const D = this.grid.length;
    const joint = new Float64Array(m * D);

    let carried = 0;
    if (old && reason !== 'initial' && reason !== 'content') {
      const tol = 0.5 * this.pitch();
      const stateOf = new Map<number, number>();
      this.states.forEach((i, k) => stateOf.set(i, k));
      oldStates.forEach((oi, ok) => {
        const ol = old.lines[oi];
        if (!ol) return;
        const k = stateOf.get(findLineByDocTop(layout.lines, ol.docTop, tol));
        if (k === undefined) return;
        for (let b = 0; b < D; b++) {
          const v = oldJoint[ok * D + b]!;
          joint[k * D + b] = joint[k * D + b]! + v;
          carried += v;
        }
      });
    }
    if (carried > 1e-9) {
      for (let i = 0; i < joint.length; i++) joint[i] = (1 - REMAP_UNIFORM) * (joint[i]! / carried);
      for (let k = 0; k < m; k++) {
        for (let b = 0; b < D; b++) joint[k * D + b] = joint[k * D + b]! + (REMAP_UNIFORM / m) * this.driftBelief[b]!;
      }
      this.joint = joint;
    } else {
      this.joint = this.seed(this.topPrior());
    }

    const scrollDelta = old ? layout.scrollTop - old.scrollTop : 0;
    if (reason === 'scroll' && this.prevFix && Number.isFinite(scrollDelta)) {
      // The text moved up by scrollDelta; keep the last fixation comparable for the next saccade.
      this.prevFix = { ...this.prevFix, y: this.prevFix.y - scrollDelta };
    } else if (reason !== 'scroll') {
      this.prevFix = null;
    }
    if (
      reason === 'initial' ||
      reason === 'content' ||
      reason === 'page-turn' ||
      (reason === 'scroll' && Math.abs(scrollDelta) > 0.5 * layout.clientHeight)
    ) {
      this.fixCount = 0;
    }
    if (reason === 'page-turn') this.lastSaccade = null;
    this.summarize();
    if (this.est) this.publish(this.est.t);
  }

  onFixation(f: Fixation): LineEstimate {
    const layout = this.layout;
    const t = Number.isFinite(f.end) ? f.end : this.est?.t ?? 0;
    const m = this.states.length;
    if (!layout || m === 0 || !Number.isFinite(f.x) || !Number.isFinite(f.y)) {
      this.fixCount++;
      return this.publish(t);
    }
    const lines = layout.lines;
    const pitch = this.pitch();
    const D = this.grid.length;

    let kind: SaccadeKind | null = null;
    if (this.prevFix) {
      const bestPrev = argmax(this.post);
      const hint = bestPrev >= 0 && this.post[bestPrev]! >= 0.4 ? lines[bestPrev]! : null;
      kind = classifySaccade(this.prevFix, f, layout, hint);
      this.predict(kind, (f.y - this.prevFix.y) / pitch);
    }

    const sigma = this.sigmaLines;
    const yL = f.y / pitch;
    const colW = Math.max(layout.column.right - layout.column.left, pitch);
    const joint = this.joint;
    let total = 0;
    for (let k = 0; k < m; k++) {
      const line = lines[this.states[k]!]!;
      const base = yL - line.centerY / pitch;
      const h = horizontalPlausibility(f.x, line, colW, pitch);
      for (let b = 0; b < D; b++) {
        const z = (base - this.grid[b]!) / sigma;
        const v = joint[k * D + b]! * (Math.exp(-0.5 * z * z) + EMISSION_FLOOR) * h;
        joint[k * D + b] = v;
        total += v;
      }
    }
    if (!(total > 0) || !Number.isFinite(total)) this.joint = this.seed(this.topPrior());
    else for (let i = 0; i < joint.length; i++) joint[i] = joint[i]! / total;

    this.summarize();
    const best = argmax(this.post);
    const line = lines[best];
    if (line) {
      const e = (f.y - this.driftY - line.centerY) / pitch;
      if (this.post[best]! > LEARN_CONFIDENCE && kind !== 'return-sweep' && kind !== 'jump' && this.plausible(e, best)) {
        this.residVar += SIGMA_RATE * (e * e - this.residVar);
        this.sigmaLines = clamp(Math.sqrt(this.residVar) * SIGMA_INFLATE, SIGMA_MIN_LINES, SIGMA_MAX_LINES);
      }
      this.progressX = progressAlong(line, f.x);
    }
    this.lastSaccade = kind;
    this.prevFix = f;
    this.fixCount++;
    return this.publish(t);
  }

  onSample(s: GazeSample): LineEstimate | null {
    const est = this.est;
    const layout = this.layout;
    if (!est || !layout || !s.valid || !Number.isFinite(s.x) || !Number.isFinite(s.t)) return null;
    const line = layout.lines[est.lineIndex];
    if (!line) return null;
    this.progressX = progressAlong(line, s.x);
    this.est = { ...est, t: s.t, progressX: this.progressX };
    return this.est;
  }

  afterPageTurn(resumeLineIndex: number): void {
    const layout = this.layout;
    const m = this.states.length;
    if (!layout || m === 0) return;
    let r: number;
    if (!Number.isFinite(resumeLineIndex) || resumeLineIndex < 0) {
      r = Math.max(0, this.states.findIndex((i) => layout.lines[i]!.fullyVisible));
    } else {
      r = this.states.findIndex((i) => i >= resumeLineIndex);
      if (r < 0) r = m - 1;
    }
    const w = new Array<number>(m).fill(PAGE_TURN_UNIFORM / m);
    for (const [off, weight] of PAGE_TURN_PRIOR) {
      const k = r + off;
      if (k >= 0 && k < m) w[k] = w[k]! + weight;
    }
    this.joint = this.seed(w);
    this.prevFix = null;
    this.lastSaccade = null;
    this.fixCount = 0;
    this.progressX = 0;
    this.summarize();
    this.publish(this.est?.t ?? layout.measuredAt);
  }

  reset(): void {
    this.driftBelief = this.driftPrior();
    this.joint = this.seed(this.topPrior());
    this.prevFix = null;
    this.sigmaLines = this.opts.sigmaYLines;
    this.residVar = (this.sigmaLines / SIGMA_INFLATE) ** 2;
    this.fixCount = 0;
    this.lastSaccade = null;
    this.progressX = 0;
    this.summarize();
    this.driftY = 0;
    this.est = null;
  }

  // ── internals ──

  private pitch(): number {
    const p = this.layout?.linePitch;
    return p !== undefined && Number.isFinite(p) && p > 0 ? p : FALLBACK_PITCH_PX;
  }

  /** Joint prior from line weights (any scale) × the current drift belief. */
  private seed(lineWeights: readonly number[]): Float64Array {
    const m = this.states.length;
    const D = this.grid.length;
    const joint = new Float64Array(m * D);
    let z = 0;
    for (const w of lineWeights) z += w > 0 ? w : 0;
    if (!(z > 0)) return joint;
    for (let k = 0; k < m; k++) {
      const w = (lineWeights[k]! > 0 ? lineWeights[k]! : 0) / z;
      for (let b = 0; b < D; b++) joint[k * D + b] = w * this.driftBelief[b]!;
    }
    return joint;
  }

  private topPrior(): number[] {
    return this.states.map((_, k) => 1 + TOP_PRIOR_BOOST * Math.exp(-k / TOP_PRIOR_DECAY_LINES));
  }

  private driftPrior(): Float64Array {
    const p = new Float64Array(this.grid.length);
    let z = 0;
    for (let b = 0; b < p.length; b++) {
      const u = this.grid[b]! / DRIFT_PRIOR_SIGMA_LINES;
      p[b] = Math.exp(-0.5 * u * u);
      z += p[b]!;
    }
    for (let b = 0; b < p.length; b++) p[b] = p[b]! / z;
    return p;
  }

  /** A confident fixation's residual is fit to learn σ from (not a glance past the first/last line). */
  private plausible(e: number, best: number): boolean {
    if (!(Math.abs(e) <= LEARN_MAX_RESIDUAL_LINES)) return false;
    if (best === this.states[this.states.length - 1] && e > 0.5) return false;
    if (best === this.states[0] && e < -0.5) return false;
    return true;
  }

  /** HMM prediction: line transition for this saccade kind, then the drift random walk. */
  private predict(kind: SaccadeKind, dyLines: number): void {
    const m = this.states.length;
    const D = this.grid.length;
    const src = this.joint;
    const out = new Float64Array(m * D);
    const col = new Array<number>(m);
    for (let b = 0; b < D; b++) {
      for (let k = 0; k < m; k++) col[k] = src[k * D + b]!;
      const next = transitionLines(col, kind, dyLines);
      for (let k = 0; k < m; k++) out[k * D + b] = next[k]!;
    }
    // Drift random walk (+ a small chance of a sudden shift), row by row.
    const walk = this.walk;
    const r = (walk.length - 1) / 2;
    const row = new Float64Array(D);
    for (let k = 0; k < m; k++) {
      let mass = 0;
      for (let b = 0; b < D; b++) mass += out[k * D + b]!;
      if (!(mass > 0)) continue;
      row.fill(0);
      for (let b = 0; b < D; b++) {
        const v = out[k * D + b]!;
        if (v === 0) continue;
        for (let j = -r; j <= r; j++) {
          const c = b + j;
          if (c >= 0 && c < D) row[c] = row[c]! + v * walk[j + r]!;
        }
      }
      let kept = 0;
      for (let b = 0; b < D; b++) kept += row[b]!;
      const scale = kept > 0 ? ((1 - DRIFT_JUMP) * mass) / kept : 0;
      for (let b = 0; b < D; b++) out[k * D + b] = row[b]! * scale + (DRIFT_JUMP * mass) / D;
    }
    this.joint = out;
  }

  /** Recomputes the line marginal, the drift belief and driftY from the joint. */
  private summarize(): void {
    const layout = this.layout;
    const m = this.states.length;
    const D = this.grid.length;
    const post = new Array<number>(layout?.lines.length ?? 0).fill(0);
    const belief = new Float64Array(D);
    let total = 0;
    for (let k = 0; k < m; k++) {
      let s = 0;
      for (let b = 0; b < D; b++) {
        const v = this.joint[k * D + b]!;
        s += v;
        belief[b] = belief[b]! + v;
      }
      post[this.states[k]!] = s;
      total += s;
    }
    if (total > 0) {
      for (let i = 0; i < post.length; i++) post[i] = post[i]! / total;
      for (let b = 0; b < D; b++) belief[b] = belief[b]! / total;
      this.driftBelief = belief;
    }
    this.post = post;
    // Report the drift that goes with the most likely line (the overall mean would blur competing hypotheses).
    const best = argmax(post);
    const k = best >= 0 ? this.states.indexOf(best) : -1;
    if (k >= 0) {
      let s = 0;
      let w = 0;
      for (let b = 0; b < D; b++) {
        const v = this.joint[k * D + b]!;
        s += v * this.grid[b]!;
        w += v;
      }
      if (w > 0) this.driftY = (s / w) * this.pitch();
    }
  }

  private publish(t: number): TrackedLineEstimate {
    const best = argmax(this.post);
    this.est = {
      t,
      lineIndex: best,
      probability: best >= 0 ? this.post[best]! : 0,
      posterior: this.post,
      progressX: this.progressX,
      lastSaccade: this.lastSaccade,
      driftY: this.driftY,
      fixationsOnPage: this.fixCount,
      sigmaYPx: this.sigmaYPx,
    };
    return this.est;
  }
}

// ─────────────────────────────────── helpers ───────────────────────────────────

function readableStates(layout: LineLayout): number[] {
  const { top, bottom } = layout.viewport;
  const out: number[] = [];
  layout.lines.forEach((l, i) => {
    if (l.fullyVisible) {
      out.push(i);
      return;
    }
    const h = l.bottom - l.top;
    if (!(h > 0)) return;
    const visible = Math.min(l.bottom, bottom) - Math.max(l.top, top);
    if (visible / h >= READABLE_FRACTION) out.push(i);
  });
  return out;
}

/** Index of the line whose docTop is nearest to `docTop` (within `tol`), or -1. Lines must be sorted by top. */
export function findLineByDocTop(lines: readonly TextLine[], docTop: number, tol: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.docTop < docTop) lo = mid + 1;
    else hi = mid;
  }
  let best = -1;
  let bestD = tol;
  for (const i of [lo - 1, lo, lo + 1]) {
    const l = lines[i];
    if (!l) continue;
    const d = Math.abs(l.docTop - docTop);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

/** Normalized Gaussian kernel with σ in bins (a delta for σ ≈ 0), truncated at 3σ. */
function gaussianKernel(sigmaBins: number): Float64Array {
  if (!(sigmaBins > 0.05)) return Float64Array.of(1);
  const r = Math.max(1, Math.ceil(3 * sigmaBins));
  const k = new Float64Array(2 * r + 1);
  let z = 0;
  for (let j = -r; j <= r; j++) {
    k[j + r] = Math.exp(-0.5 * (j / sigmaBins) ** 2);
    z += k[j + r]!;
  }
  for (let j = 0; j < k.length; j++) k[j] = k[j]! / z;
  return k;
}

/** Line transition of one probability vector (over readable states, top to bottom). */
function transitionLines(a: readonly number[], kind: SaccadeKind, dyLines: number): number[] {
  const m = a.length;
  const out = new Array<number>(m).fill(0);
  let mass = 0;
  for (const v of a) mass += v;
  if (!(mass > 0)) return out;
  if (kind === 'jump') {
    const shift = Number.isFinite(dyLines) ? dyLines : 0;
    const kernel = new Array<number>(m);
    for (let i = 0; i < m; i++) {
      const ai = a[i]!;
      if (!(ai > 0)) continue;
      let z = 0;
      for (let j = 0; j < m; j++) {
        const d = (j - i - shift) / JUMP_KERNEL_SIGMA_LINES;
        kernel[j] = Math.exp(-0.5 * d * d);
        z += kernel[j]!;
      }
      if (!(z > 0)) continue;
      for (let j = 0; j < m; j++) out[j] = out[j]! + ((1 - JUMP_UNIFORM) * ai * kernel[j]!) / z;
    }
    for (let j = 0; j < m; j++) out[j] = out[j]! + (JUMP_UNIFORM * mass) / m;
    return out;
  }
  const T = LINE_TRANSITIONS[kind];
  const rem = Math.max(0, 1 - (T.stay + T.next + T.next2 + T.prev));
  let uniformMass = 0;
  for (let i = 0; i < m; i++) {
    const ai = a[i]!;
    if (!(ai > 0)) continue;
    const hasNext = i + 1 < m;
    const hasNext2 = i + 2 < m;
    const hasPrev = i > 0;
    const z = T.stay + (hasNext ? T.next : 0) + (hasNext2 ? T.next2 : 0) + (hasPrev ? T.prev : 0) + rem;
    const w = ai / z;
    out[i] = out[i]! + w * T.stay;
    if (hasNext) out[i + 1] = out[i + 1]! + w * T.next;
    if (hasNext2) out[i + 2] = out[i + 2]! + w * T.next2;
    if (hasPrev) out[i - 1] = out[i - 1]! + w * T.prev;
    uniformMass += w * rem;
  }
  for (let j = 0; j < m; j++) out[j] = out[j]! + uniformMass / m;
  return out;
}

/**
 * 1 while x is within the line's extent (plus a tolerance), falling off as a
 * Gaussian outside it. Mostly matters for short paragraph-final lines: a
 * fixation far to the right of where a line ends can't be on that line.
 */
function horizontalPlausibility(x: number, line: TextLine, colW: number, pitch: number): number {
  const tol = 0.03 * colW + 8;
  const d = Math.max(line.left - tol - x, x - (line.right + tol), 0);
  if (d === 0) return 1;
  const s = Math.max(0.06 * colW, 0.5 * pitch);
  return Math.max(HORIZONTAL_FLOOR, Math.exp(-0.5 * (d / s) ** 2));
}

function progressAlong(line: TextLine, x: number): number {
  const w = line.right - line.left;
  if (!(w > 0) || !Number.isFinite(x)) return x >= line.right ? 1 : 0;
  return clamp01((x - line.left) / w);
}

function argmax(a: readonly number[]): number {
  let best = -1;
  let bv = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i]!;
    if (v > bv) {
      bv = v;
      best = i;
    }
  }
  return best;
}
