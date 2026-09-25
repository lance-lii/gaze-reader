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
 * Which line is the reader on? A hidden Markov model (forward filter) whose
 * hidden state is the visible line being read. Webcam gaze is decent
 * horizontally but noisy and drifty vertically, so the model leans on the
 * structure of reading: fixations march rightwards along a line and a return
 * sweep moves to the next one. The vertical position only has to be good
 * enough to keep that count honest, and its slow bias (drift) is learned.
 */

export interface LineTrackerOptions {
  /** Vertical emission σ in lines (adapted online, clamped 0.4–3). */
  sigmaYLines: number;
  /** EMA rate of the drift estimate per confident fixation. */
  driftRate: number;
  /** Drift clamp, in lines. */
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

/** Transition probabilities by saccade kind; the remainder is spread uniformly over all lines. */
export const LINE_TRANSITIONS: Readonly<Record<Exclude<SaccadeKind, 'jump'>, Readonly<TransitionRow>>> = Object.freeze({
  forward: Object.freeze({ stay: 0.85, next: 0.07, next2: 0, prev: 0.03 }),
  regression: Object.freeze({ stay: 0.85, next: 0.03, next2: 0, prev: 0.08 }),
  'return-sweep': Object.freeze({ stay: 0.07, next: 0.75, next2: 0.08, prev: 0.03 }),
});

/** After a jump: 60 % uniform, 40 % where the vertical displacement points (σ = 1 line). */
const JUMP_UNIFORM = 0.6;
const JUMP_KERNEL_SIGMA_LINES = 1;

/** Additive floor on the vertical likelihood: one wild fixation can shift the odds by at most ~1/floor. */
const EMISSION_FLOOR = 0.01;
/** Minimum horizontal plausibility (x far outside a line's extent). */
const HORIZONTAL_FLOOR = 0.05;

/** Drift and σ only learn from fixations the tracker is sure about... */
const LEARN_CONFIDENCE = 0.8;
/** ...and σ learns slowly, inflated to offset the selection bias of learning only when confident. */
const SIGMA_RATE = 0.04;
const SIGMA_INFLATE = 1.3;
const SIGMA_MIN_LINES = 0.4;
const SIGMA_MAX_LINES = 3;

/** A line counts as readable (a state) when at least this much of its height is inside the viewport. */
const READABLE_FRACTION = 0.6;
/** Probability mass kept uniform when carrying the posterior across a layout change. */
const REMAP_UNIFORM = 0.02;

/** Prior after a page turn, relative to the resume line. */
const PAGE_TURN_PRIOR: ReadonlyArray<readonly [offset: number, weight: number]> = [
  [-1, 0.03],
  [0, 0.7],
  [1, 0.14],
  [2, 0.06],
  [3, 0.03],
];
const PAGE_TURN_UNIFORM = 0.04;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);

export class LineTracker {
  private readonly opts: LineTrackerOptions;
  private layout: LineLayout | null = null;
  /** Indices (into layout.lines) of the readable lines, top to bottom. */
  private states: number[] = [];
  /** Posterior per layout line (0 for unreadable lines). */
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
  }

  get estimate(): LineEstimate | null {
    return this.est;
  }

  /** Current vertical emission σ, px (NaN without a layout). */
  get sigmaYPx(): number {
    return this.sigmaLines * this.pitch();
  }

  setLayout(layout: LineLayout, reason: LayoutChangeReason): void {
    const old = this.layout;
    const oldPost = this.post;
    this.layout = layout;
    this.states = readableStates(layout);
    const n = layout.lines.length;

    let post: number[] = new Array<number>(n).fill(0);
    if (old && reason !== 'initial' && reason !== 'content') {
      const pitch = this.pitch();
      for (let i = 0; i < oldPost.length; i++) {
        const p = oldPost[i]!;
        const ol = old.lines[i];
        if (!(p > 0) || !ol) continue;
        const j = findLineByDocTop(layout.lines, ol.docTop, 0.5 * pitch);
        if (j >= 0) post[j] = post[j]! + p;
      }
    }
    post = this.normalizeOverStates(post, REMAP_UNIFORM);

    const scrollDelta = old ? layout.scrollTop - old.scrollTop : 0;
    if (reason === 'scroll' && this.prevFix && Number.isFinite(scrollDelta)) {
      // Text moved up by scrollDelta; keep the last fixation comparable for the next saccade.
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

    this.post = post;
    if (this.est) this.publish(this.est.t);
  }

  onFixation(f: Fixation): LineEstimate {
    const layout = this.layout;
    const t = Number.isFinite(f.end) ? f.end : this.est?.t ?? 0;
    if (!layout || this.states.length === 0 || !Number.isFinite(f.x) || !Number.isFinite(f.y)) {
      this.fixCount++;
      return this.publish(t);
    }
    const lines = layout.lines;
    const pitch = this.pitch();
    const m = this.states.length;

    let prior = this.states.map((i) => this.post[i] ?? 0);
    if (!(sum(prior) > 0)) prior = new Array<number>(m).fill(1 / m);

    let kind: SaccadeKind | null = null;
    if (this.prevFix) {
      const bestPrev = argmax(this.post);
      const hint = bestPrev >= 0 && this.post[bestPrev]! >= 0.4 ? lines[bestPrev]! : null;
      kind = classifySaccade(this.prevFix, f, layout, hint);
      prior = transition(prior, kind, (f.y - this.prevFix.y) / pitch);
    }

    const sigma = this.sigmaLines * pitch;
    const yc = f.y - this.driftY;
    const colW = Math.max(layout.column.right - layout.column.left, pitch);
    const postStates = new Array<number>(m);
    let total = 0;
    for (let k = 0; k < m; k++) {
      const line = lines[this.states[k]!]!;
      const z = (yc - line.centerY) / sigma;
      const e = (Math.exp(-0.5 * z * z) + EMISSION_FLOOR) * horizontalPlausibility(f.x, line, colW, pitch);
      const v = prior[k]! * e;
      postStates[k] = v;
      total += v;
    }
    if (!(total > 0) || !Number.isFinite(total)) {
      postStates.fill(1 / m);
      total = 1;
    }
    const post = new Array<number>(lines.length).fill(0);
    for (let k = 0; k < m; k++) post[this.states[k]!] = postStates[k]! / total;
    this.post = post;

    const best = argmax(post);
    const p = post[best]!;
    const line = lines[best]!;
    if (p > LEARN_CONFIDENCE && kind !== 'return-sweep' && kind !== 'jump') this.learn(f.y - line.centerY, pitch);

    this.progressX = progressAlong(line, f.x);
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
    if (!layout || this.states.length === 0) return;
    const m = this.states.length;
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
    const z = sum(w);
    const post = new Array<number>(layout.lines.length).fill(0);
    for (let k = 0; k < m; k++) post[this.states[k]!] = w[k]! / z;
    this.post = post;
    this.prevFix = null;
    this.lastSaccade = null;
    this.fixCount = 0;
    this.progressX = 0;
    this.publish(this.est?.t ?? layout.measuredAt);
  }

  reset(): void {
    this.post = this.layout ? this.normalizeOverStates(new Array<number>(this.layout.lines.length).fill(0), 1) : [];
    this.prevFix = null;
    this.driftY = 0;
    this.sigmaLines = this.opts.sigmaYLines;
    this.residVar = (this.sigmaLines / SIGMA_INFLATE) ** 2;
    this.fixCount = 0;
    this.lastSaccade = null;
    this.progressX = 0;
    this.est = null;
  }

  private pitch(): number {
    const p = this.layout?.linePitch;
    return p !== undefined && Number.isFinite(p) && p > 0 ? p : 40;
  }

  private learn(residualPx: number, pitch: number): void {
    const e = (residualPx - this.driftY) / pitch;
    this.residVar += SIGMA_RATE * (e * e - this.residVar);
    this.sigmaLines = clamp(Math.sqrt(this.residVar) * SIGMA_INFLATE, SIGMA_MIN_LINES, SIGMA_MAX_LINES);
    const maxDrift = this.opts.maxDriftLines * pitch;
    this.driftY = clamp(this.driftY + this.opts.driftRate * (residualPx - this.driftY), -maxDrift, maxDrift);
  }

  /** Restricts `post` to readable lines, mixes in `uniform` mass and normalizes (uniform if empty). */
  private normalizeOverStates(post: number[], uniform: number): number[] {
    const m = this.states.length;
    const out = new Array<number>(post.length).fill(0);
    if (m === 0) return out;
    let z = 0;
    for (const i of this.states) z += post[i]! > 0 ? post[i]! : 0;
    const u = z > 0 ? uniform : 1;
    for (const i of this.states) {
      const p = post[i]! > 0 ? post[i]! : 0;
      out[i] = (z > 0 ? (1 - u) * (p / z) : 0) + u / m;
    }
    return out;
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

/** Index of the line whose docTop is nearest to `docTop` (within `tol`), or -1. */
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

function transition(a: number[], kind: SaccadeKind, dyLines: number): number[] {
  const m = a.length;
  const out = new Array<number>(m).fill(0);
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
    for (let j = 0; j < m; j++) out[j] = out[j]! + JUMP_UNIFORM / m;
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
  let bv = -Infinity;
  for (let i = 0; i < a.length; i++) {
    const v = a[i]!;
    if (v > bv) {
      bv = v;
      best = i;
    }
  }
  return bv > 0 ? best : -1;
}

function sum(a: readonly number[]): number {
  let s = 0;
  for (const v of a) s += v;
  return s;
}
