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
 * The range is wide (±5 lines) because lighting moves webcam gaze a lot: a
 * squint in bright light or glare reads several lines low, wide eyes in dim
 * light read high. A range narrower than the bias forces the tracker onto the
 * wrong line, where it then "learns" a drift that fits that line.
 *
 * - Emission: N(y − drift; line.centerY, σ_y²) (+ a small floor so one wild
 *   fixation can't wipe out the posterior), times a horizontal plausibility
 *   factor that penalizes x far outside the line (short paragraph-final lines).
 * - Line transitions by saccade kind (LINE_TRANSITIONS): forward → mostly
 *   stay; regression → stay or back one; return sweep → next line; jump → 60 %
 *   uniform + 40 % where dy points. The remaining mass is spread uniformly; it
 *   is small (1 %) for forward saccades and regressions, so a sudden vertical
 *   step mid-line is not cheaply explained as the reader skipping lines.
 *   Two ambiguous cases are split: a jump *down* while the eyes keep moving
 *   along the line is partly the gaze bias stepping (the drift shifts, the
 *   line stays), and a long leftward saccade out of the right half that lands
 *   too far right for a return sweep (a horizontal gaze offset) is partly one.
 * - Drift transitions: a slow Gaussian random walk (driftRate × 0.8 lines per
 *   fixation) plus a small chance of a sudden shift (the head moved). On a
 *   fresh start the drift prior is N(0, 0.5 lines) with 30 % spread uniformly:
 *   calibration is usually right, but light can differ from calibration. Right
 *   after a new calibration (reset({ calibrated: true })) the light is the
 *   calibration's: the prior is the Gaussian alone.
 * - Page turns re-anchor the drift: the line the reader resumes on is known,
 *   so half of the drift belief is reset to uniform and the first fixations on
 *   the new page pin it again. A drift learned on a wrong line can't survive
 *   every turn.
 * - The camera side can report that the eyes' appearance changed (a light was
 *   switched on, squinting, glare; `appearanceChangedAt`): the tracker keeps
 *   the line and re-learns the drift from there. Reports come seconds late
 *   (the lid monitor ≈ 2.3 s, LightingWatch 6–11 s), carrying the change's
 *   time: the tracker keeps its state before each fixation of the last 15 s on
 *   the current layout, rewinds to the change and replays the fixations since.
 * - σ_y adapts from the residuals of confident fixations (0.4–3 lines), only
 *   while the drift belief is concentrated: a line that is "sure" only through
 *   a prior (after a page turn or an appearance change) says nothing yet about
 *   the noise.
 * - The page edges absorb: "moved on" from the last readable line (looking for
 *   a next line that isn't there) keeps the reader at the bottom.
 * - Fixations well off the text (the keyboard, Dewey, the top bar) are
 *   excursions: they don't move the reading state, and the next saccade is
 *   measured from the last fixation on the text. "Well off" holds for every
 *   drift the belief still allows, so reading under a large, not yet learned
 *   offset isn't thrown away as looking elsewhere.
 *
 * Measured on the simulator (pipeline.test.ts, offsets.test.ts, and the
 * scoreboard in bench/reading/offsets.bench.test.ts, 168 page turns per row),
 * on a document with 0.5-pitch paragraph gaps (web articles, the extension):
 * ≥ 99 % of fixations on the true line at σ = 0.5–1 line of noise with half a
 * line of drift; ~95 % with correlated noise and blinks; constant offsets of
 * ±4 lines and steps of ±4 lines with the appearance event (reported 2.3 or
 * 8 s late) without an early page turn, and without a missed one when the
 * report takes 2.3 s (1.0: every turn early or missed from ±2 lines on).
 * Without the event, downward steps of 2–3 lines still turn on time; upward
 * steps can miss a turn or two (the safe direction).
 * The app's reader has no paragraph gaps (less to pin the drift with): with
 * 3–9-line paragraphs, constant ±2 / ±3 lines cost at most 1 / 2 / 0 early /
 * unsafe / missed turns; an unreported step of +3 costs 3 / 10 / 0, one of −3
 * 23 missed turns (0 with the event). With 12–30-line paragraphs a constant +3
 * keeps 63 % on the line and turns 47 of 168 pages early or unsafe.
 * Known limits: a horizontal offset of ≥ 200 px defeats return-sweep detection
 * and misses ~1 turn in 8; in steady light at high noise on long gapless or
 * single paragraphs, the tracker sometimes learns a spurious 1–4-line drift
 * (a line or more away from the reader; one ¶, noise 1.2: 5 of 168 turns
 * unsafe against 1.0's 0). The drift's random walk also has to follow the
 * y-dependent drift of a gain error, so it can't be slowed down until the
 * gain is modelled separately.
 */

export interface LineTrackerOptions {
  /** Initial vertical emission σ, in lines (adapted online, clamped 0.4–3). */
  sigmaYLines: number;
  /** How fast the drift may wander: the random-walk step is driftRate × 0.8 lines per fixation (σ; 0.12 lines at the default). */
  driftRate: number;
  /** Drift range modeled, ± lines (0–10; the grid has at most 81 bins, 0.125 lines apart at the default). */
  maxDriftLines: number;
}

export const DEFAULT_LINE_TRACKER_OPTIONS: Readonly<LineTrackerOptions> = Object.freeze({
  sigmaYLines: 0.9,
  driftRate: 0.15,
  maxDriftLines: 5,
});

/** A LineEstimate that also reports the tracker's internals (for the debug overlay and diagnostics). */
export interface TrackedLineEstimate extends LineEstimate {
  /** Current vertical emission σ, px. */
  sigmaYPx: number;
  /** Fixations judged to be looks away from the text since the last reset. */
  excursions: number;
  /**
   * The 2 % and 98 % quantiles of the drift belief, px (same sign convention as
   * driftY). Wide right after a page turn or an appearance change, narrow once
   * the drift is learned. Always set by LineTracker (optional for hand-made estimates).
   */
  driftLowY?: number;
  driftHighY?: number;
  /** SD of the drift that goes with the most likely line, px (NaN when unknown): how well driftY is pinned. */
  driftSdY?: number;
}

export function isTrackedLineEstimate(e: LineEstimate | null | undefined): e is TrackedLineEstimate {
  return !!e && typeof (e as Partial<TrackedLineEstimate>).sigmaYPx === 'number';
}

export interface LineTrackerResetOptions {
  /**
   * Keep what was learned about the drift, e.g. when a book is opened again
   * with the same calibration: the drift that goes with the most likely line
   * (what driftY reports), softened — half of it reset to the fresh prior. The
   * default starts over from "calibration is about right".
   */
  keepDrift?: boolean;
  /**
   * A calibration just ran under this light: start from the Gaussian drift
   * prior only, without the uniform share a start with a stored calibration
   * keeps for "the light may differ from calibration" (ignored with keepDrift).
   */
  calibrated?: boolean;
}

interface TransitionRow {
  stay: number;
  next: number;
  next2: number;
  prev: number;
}

/** Line transition probabilities by saccade kind; the remainder is spread uniformly over all lines. */
export const LINE_TRANSITIONS: Readonly<Record<Exclude<SaccadeKind, 'jump'>, Readonly<TransitionRow>>> = Object.freeze({
  forward: Object.freeze({ stay: 0.886, next: 0.073, next2: 0, prev: 0.031 }),
  regression: Object.freeze({ stay: 0.877, next: 0.031, next2: 0, prev: 0.082 }),
  'return-sweep': Object.freeze({ stay: 0.07, next: 0.75, next2: 0.08, prev: 0.03 }),
});

/** After a jump: 60 % uniform, 40 % where the vertical displacement points (σ = 1 line). */
const JUMP_UNIFORM = 0.6;
const JUMP_KERNEL_SIGMA_LINES = 1;
/**
 * A jump *down* (> 2.5 lines) while the eyes keep moving along the line (dx within a forward
 * reading saccade, as a share of the column width) is as often the gaze bias stepping — a light
 * switched on, squinting reads lower — as a reader skipping lines mid-line. This share of it
 * keeps the line and shifts the drift by dy instead; the next fixations decide. Not for upward
 * jumps: a jump back from the end of a short paragraph-final line to an earlier line's start
 * also has little horizontal movement, and re-reading is common.
 */
const SENSOR_STEP_SHARE = 0.3;
const SENSOR_STEP_MIN_DX_COL = -0.05;
const SENSOR_STEP_MAX_DX_COL = 0.35;
/**
 * A long leftward saccade out of the right half of the column (sweep-sized, ≥ 0.4 column widths)
 * that doesn't land in the left part, so it isn't classified as a return sweep, is ambiguous: a
 * long regression, or a return sweep seen through a horizontal gaze offset (at +200 px most sweeps
 * land too far right). This share of its transition is the return sweep's; the vertical evidence
 * decides. Without it the wide drift range explains the missed line advances as drift and the
 * tracker falls behind the reader.
 */
const LONG_REGRESSION_SWEEP_SHARE = 0.5;
const LONG_REGRESSION_MIN_DX_COL = 0.4;
const LONG_REGRESSION_START_COL = 0.5;
/**
 * A look away and straight back is an excursion too, even when the look landed on the text (a
 * glance a few lines down, below the page while waiting for the turn): when the fixation after a
 * jump lands back where the eyes left — within this many lines vertically (or this share of the
 * glance's own height: smoothed gaze lags on the way back from a long one), this share of the
 * column horizontally (left / right), this soon after the glance — the jump and its fixation are
 * undone. Otherwise a glance down and back reads as the gaze bias stepping, and repeated glances
 * pull the drift towards explaining them (a 3–5-line glance cost 10–18 % of the page's accuracy).
 */
const GLANCE_BACK_LINES = 0.75;
const GLANCE_BACK_SHARE = 0.25;
const GLANCE_BACK_MIN_DX_COL = -0.15;
const GLANCE_BACK_MAX_DX_COL = 0.25;
const GLANCE_BACK_MS = 1000;
/** Fixations after the jump that may still bring the eyes back (smoothed gaze can stop halfway). */
const GLANCE_BACK_FIXATIONS = 2;

/** Drift grid resolution, lines; the grid never exceeds MAX_DRIFT_BINS (coarser steps for wider ranges). */
const DRIFT_STEP_LINES = 0.125;
const MAX_DRIFT_BINS = 81;
/** Random-walk step per fixation = driftRate × this, in lines. */
const DRIFT_WALK_PER_RATE = 0.8;
/** Per-fixation probability that the drift jumps anywhere on the grid (head movement). */
const DRIFT_JUMP = 0.004;
/** Drift prior on a fresh start: N(0, σ) in lines (calibration is decent but rarely perfect)... */
const DRIFT_PRIOR_SIGMA_LINES = 0.5;
/**
 * ...with this share spread uniformly over the grid, on starts that don't follow a new
 * calibration (a stored calibration, a new book): reading under light that differs from
 * calibration can start several lines off, and on a fresh page nothing but the bottom of the
 * page shows that gaze reads low: under a pure Gaussian "line k + 3, no drift" outweighs "line k,
 * 3 lines of drift" by e^18, and the page turned 3 lines early. Right after a calibration
 * (reset({ calibrated: true })) the light is the calibration's, and the uniform share only costs:
 * re-reading long gapless paragraphs could then turn the first page early (3–5 of 96 pages).
 */
const DRIFT_PRIOR_UNIFORM = 0.3;
/** Quantile that bounds the drifts still "believed possible" (excursion test, σ-learning gate, diagnostics). */
const DRIFT_TAIL = 0.02;

/** Additive floor on the vertical likelihood: one wild fixation can shift the odds by at most ~1/floor. */
const EMISSION_FLOOR = 0.01;
/** Minimum horizontal plausibility (x far outside a line's extent). */
const HORIZONTAL_FLOOR = 0.05;

/** σ_y learns only from fixations the tracker is sure about... */
const LEARN_CONFIDENCE = 0.8;
/**
 * ...while the drift that goes with that line is pinned by data: its SD at most this many lines, or
 * this share of σ (one fixation on a uniform drift leaves SD ≈ σ, n of them ≈ σ/√n; the random walk
 * keeps it near √(0.12 σ) in steady state, so a fixed threshold alone would never let a large σ
 * learn). Right after a page turn or an appearance change a line can be "sure" through its prior
 * alone, and the residual against a drift that isn't known yet says nothing about the noise...
 */
const LEARN_MAX_DRIFT_SD_LINES = 0.35;
const LEARN_MAX_DRIFT_SD_SIGMA = 0.6;
/** ...whose drift-corrected residual is plausible (not a glance off the text), in lines... */
const LEARN_MAX_RESIDUAL_LINES = 0.75;
/** ...slowly, inflated to offset the selection bias of learning only when confident. */
const SIGMA_RATE = 0.04;
const SIGMA_INFLATE = 1.6;
const SIGMA_MIN_LINES = 0.4;
const SIGMA_MAX_LINES = 3;

/**
 * Fixations further than this (in lines, for every plausible drift) above the first or below the
 * last readable line, or this far (× column width) beside the column, are looks away from the text.
 */
const EXCURSION_LINES = 2;
const EXCURSION_COLUMN = 0.2;

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

/**
 * Prior after a page turn, relative to the resume line. −1 is the line that
 * anchored the turn, now at the top of the page: after a turn that came a
 * little early the reader is still finishing it. It only counts when that line
 * is fully visible (it is after a forward turn; after a page back the line
 * above the first fully visible one is cut off).
 */
const PAGE_TURN_PRIOR: ReadonlyArray<readonly [offset: number, weight: number]> = [
  [-1, 0.25],
  [0, 0.65],
  [1, 0.07],
  [2, 0.01],
];
const PAGE_TURN_UNIFORM = 0.02;
/**
 * Share of the drift belief kept at a page turn (the rest is uniform). The line
 * is known then, so the first fixations re-pin the drift; keeping all of it
 * would let a drift learned on a wrong line outvote the known line forever.
 */
const PAGE_TURN_KEEP_DRIFT = 0.5;
/** Share kept when the camera reports an appearance change (the gaze bias itself changed). */
const APPEARANCE_KEEP_DRIFT = 0.1;
/**
 * Share of the most likely line's drift kept by reset({ keepDrift: true }); the rest is the fresh
 * prior. (Not the marginal drift belief: after a normal page it still spans −1.6…+2.1 lines
 * through the drift hypotheses of the less likely lines, and mixed with uniform it started a
 * reopened book weaker than a fresh start — early and unsafe turns on long gapless paragraphs.)
 */
const RESET_KEEP_DRIFT = 0.5;
/** At most this many appearance changes wait for their fixation (older ones are merged). */
const MAX_PENDING_CHANGES = 8;
/**
 * How far back an appearance report can reach: the tracker keeps its state before every fixation
 * of the last this-many ms (on the current layout), so a report that arrives late (the lid monitor
 * needs ≈ 2.3 s, p90 2.8 s; LightingWatch 6–11 s) is applied at the fixation it belongs to and the
 * fixations since are replayed. ≈ 26 KB per fixation at 40 lines × 81 drift bins, ≈ 1.5 MB at most.
 */
const HISTORY_MS = 15_000;

const FALLBACK_PITCH_PX = 40;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);

/** The tracker's state just before a jump, kept for a fixation or two in case the eyes come straight back. */
interface GlanceSnapshot {
  /** The fixation the eyes jumped away from, and the one they jumped to. */
  from: Fixation;
  to: Fixation;
  /** The return must start by then... */
  until: number;
  /** ...and within this many more fixations on the text. */
  left: number;
  joint: Float64Array;
  driftBelief: Float64Array;
  post: number[];
  driftY: number;
  driftLo: number;
  driftHi: number;
  driftSdLines: number;
  lastSaccade: SaccadeKind | null;
  progressX: number;
}

/** The tracker's mutable state just before a fixation was processed (for rewinding to it). */
interface TrackerSnapshot {
  joint: Float64Array;
  driftBelief: Float64Array;
  post: number[];
  prevFix: Fixation | null;
  dyUntrusted: boolean;
  glance: GlanceSnapshot | null;
  driftY: number;
  driftLo: number;
  driftHi: number;
  driftSdLines: number;
  sigmaLines: number;
  residVar: number;
  fixCount: number;
  excursions: number;
  lastSaccade: SaccadeKind | null;
  progressX: number;
}

interface HistoryEntry {
  f: Fixation;
  snap: TrackerSnapshot;
  /** Appearance changes applied at this fixation (they are re-queued when replaying from before it). */
  applied: number[];
}

export class LineTracker {
  private readonly opts: LineTrackerOptions;
  /** Drift grid (lines), symmetric around 0. */
  private readonly grid: Float64Array;
  /** Random-walk kernel over drift bins (odd length, centered). */
  private readonly walk: Float64Array;

  private layout: LineLayout | null = null;
  /** Indices (into layout.lines) of the readable lines, top to bottom. */
  private states: number[] = [];
  /** Horizontal extent of the text (layout.column, or the readable lines' union if that is unusable). */
  private column: { left: number; right: number } = { left: 0, right: 0 };
  /** Joint posterior, row k (state) × column b (drift bin). */
  private joint: Float64Array = new Float64Array(0);
  /** Drift belief independent of the layout; seeds new layouts. */
  private driftBelief: Float64Array;
  /** Line posterior per layout line (0 for unreadable lines); published as-is, never mutated. */
  private post: number[] = [];
  private prevFix: Fixation | null = null;
  private driftY = 0;
  /** 2 % / 98 % quantiles of the drift belief, lines. */
  private driftLo = 0;
  private driftHi = 0;
  /** SD of the drift given the most likely line, lines (how well the data pin the drift for it). */
  private driftSdLines = Infinity;
  private sigmaLines: number;
  /** EMA of squared drift-corrected residuals, lines². */
  private residVar: number;
  private fixCount = 0;
  /** Fixations off the text since the last reset (diagnostics). */
  private excursions = 0;
  private lastSaccade: SaccadeKind | null = null;
  private progressX = 0;
  private est: TrackedLineEstimate | null = null;
  /** Appearance changes waiting for the first fixation that starts at or after them (ascending). */
  private pendingChanges: number[] = [];
  /** The gaze bias changed since prevFix: the next saccade's vertical displacement belongs to the sensor. */
  private dyUntrusted = false;
  /** Set by a jump; undone if the next fixation lands back where the eyes left (see GLANCE_BACK_*). */
  private glance: GlanceSnapshot | null = null;
  /** The state before each fixation of the last HISTORY_MS on this layout (oldest first). */
  private history: HistoryEntry[] = [];
  /** Estimate time of the last page turn; reports of changes before it are moot once the new page has fixations. */
  private turnedAt = -Infinity;
  /** The latest live sample (onSample), to restore progressX after a replay. */
  private lastSampleX = NaN;
  private lastSampleT = NaN;

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
    this.updateDriftRange();
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
    this.column = textColumn(layout, this.states);
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
      this.clearPrevFix();
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
    // A glance in flight, and the saved states, belong to the old layout's states.
    this.glance = null;
    this.history = [];
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

    // Keep the state before this fixation, so a late appearance report can be applied here.
    const entry = this.remember(f);

    // The camera saw the gaze bias change before this fixation began: keep the line, re-learn the drift.
    // Applied before the excursion test, so reading under the new offset isn't mistaken for looking away.
    const changed = this.applyPendingChanges(f.start, entry.applied);

    // A look away from the text (the keyboard, Dewey, the top bar) doesn't move the reading
    // state; the next saccade is measured from the last fixation on the text.
    if (this.isExcursion(f, lines, pitch)) {
      this.excursions++;
      return this.publish(t);
    }

    const columnWidth = Math.max(this.column.right - this.column.left, pitch);
    // Back where the eyes were before the last jump: that jump was a glance, an excursion after all.
    // (fixationsOnPage still counts it: it only ever grows, so consumers can tell estimates apart.)
    const glance = this.glance;
    if (glance) {
      glance.left--;
      if (changed || f.start > glance.until || glance.left < 0) this.glance = null;
    }
    if (glance && this.glance && isStraightBack(glance, f, pitch, columnWidth)) {
      this.glance = null;
      // A copy: the emission below updates the joint in place, and saved states still hold this one.
      this.joint = glance.joint.slice();
      this.driftBelief = glance.driftBelief;
      this.post = glance.post;
      this.driftY = glance.driftY;
      this.driftLo = glance.driftLo;
      this.driftHi = glance.driftHi;
      this.driftSdLines = glance.driftSdLines;
      this.lastSaccade = glance.lastSaccade;
      this.progressX = glance.progressX;
      this.prevFix = glance.from;
      this.dyUntrusted = false;
      this.excursions++;
    }

    let kind: SaccadeKind | null = null;
    if (this.prevFix) {
      const bestPrev = argmax(this.post);
      const hint = bestPrev >= 0 && this.post[bestPrev]! >= 0.4 ? lines[bestPrev]! : null;
      // After an appearance change the vertical part of this saccade is the sensor's step, not the eyes'.
      const ignoreDy = this.dyUntrusted;
      kind = classifySaccade(this.prevFix, f, layout, hint, { ignoreDy });
      // Keep the state before a jump in case the eyes come straight back (not over one in flight:
      // the way back from a glance can be a jump too).
      if (kind === 'jump' && !changed && !this.glance) {
        this.glance = {
          from: this.prevFix,
          to: f,
          until: (Number.isFinite(f.end) ? f.end : f.start) + GLANCE_BACK_MS,
          left: GLANCE_BACK_FIXATIONS,
          joint: this.joint,
          driftBelief: this.driftBelief,
          post: this.post,
          driftY: this.driftY,
          driftLo: this.driftLo,
          driftHi: this.driftHi,
          driftSdLines: this.driftSdLines,
          lastSaccade: this.lastSaccade,
          progressX: this.progressX,
        };
      }
      const dxCol = (f.x - this.prevFix.x) / columnWidth;
      const sweepLike =
        kind === 'regression' &&
        -dxCol >= LONG_REGRESSION_MIN_DX_COL &&
        this.prevFix.x >= this.column.left + LONG_REGRESSION_START_COL * columnWidth;
      this.predict(kind, ignoreDy ? 0 : (f.y - this.prevFix.y) / pitch, dxCol, sweepLike);
    }
    this.dyUntrusted = false;

    const sigma = this.sigmaLines;
    const yL = f.y / pitch;
    const joint = this.joint;
    let total = 0;
    for (let k = 0; k < m; k++) {
      const line = lines[this.states[k]!]!;
      const base = yL - line.centerY / pitch;
      const h = horizontalPlausibility(f.x, line, columnWidth, pitch);
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
      if (
        this.post[best]! > LEARN_CONFIDENCE &&
        this.driftSdLines <= Math.max(LEARN_MAX_DRIFT_SD_LINES, LEARN_MAX_DRIFT_SD_SIGMA * sigma) &&
        kind !== 'return-sweep' &&
        kind !== 'jump' &&
        this.plausible(e, best)
      ) {
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
    this.lastSampleX = s.x;
    this.lastSampleT = s.t;
    this.progressX = progressAlong(line, s.x);
    this.est = { ...est, t: s.t, progressX: this.progressX };
    return this.est;
  }

  /**
   * The page was turned (call after setLayout(..., 'page-turn')): reading resumes at
   * `resumeLineIndex` (the first line below the one that anchored the turn), or at the first
   * fully visible line when it is negative or not a number.
   */
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
      if (k < 0 || k >= m) continue;
      if (off < 0 && !layout.lines[this.states[k]!]!.fullyVisible) continue;
      w[k] = w[k]! + weight;
    }
    // A known line and a drift that is only roughly known: the first fixations on the new page
    // re-pin it. Keeping the whole old belief would let a drift learned on a wrong line outvote
    // the known line, turn after turn.
    this.driftBelief = mixWithUniform(this.driftBelief, PAGE_TURN_KEEP_DRIFT);
    this.joint = this.seed(w);
    this.clearPrevFix();
    this.history = [];
    this.lastSaccade = null;
    this.fixCount = 0;
    this.progressX = 0;
    this.summarize();
    this.turnedAt = this.est?.t ?? layout.measuredAt;
    this.publish(this.turnedAt);
  }

  /**
   * The camera saw the eyes' appearance change at time `t` (a light switched on or off,
   * squinting, glare): the gaze bias may have jumped. At the first fixation that starts at or
   * after `t` the tracker keeps which line the reader is on, resets the drift belief to mostly
   * uniform and classifies that saccade on its horizontal movement alone (its vertical step is
   * the sensor's). A spurious call costs little: the drift is re-learned within a few fixations.
   *
   * Retroactive within the history window (HISTORY_MS, on the current layout, since the last page
   * turn): a report that arrives after that fixation rewinds the tracker to it, applies the change
   * there and replays the fixations since — as if the report had come on time. Older onsets (and
   * a non-finite `t`) apply at the next fixation. A change from before the last page turn is
   * dropped once the new page has fixations: the turn re-anchored the drift already.
   */
  appearanceChangedAt(t: number): void {
    const at = Number.isFinite(t) ? t : -Infinity;
    if (Number.isFinite(at) && at < this.turnedAt && this.fixCount > 0) return;
    const h = this.history;
    const i = Number.isFinite(at) ? h.findIndex((e) => e.f.start >= at) : -1;
    if (i < 0) {
      this.queueChange(at);
      return;
    }
    // Rewind to the state before the first fixation that starts at or after the change, re-queue
    // the changes applied since (and the new one), and replay.
    const replay = h.slice(i);
    const before = this.est;
    const fixCount = this.fixCount;
    const requeue = replay.flatMap((e) => e.applied);
    this.restore(replay[0]!.snap);
    this.history = h.slice(0, i);
    for (const c of requeue) this.queueChange(c);
    this.queueChange(at);
    for (const e of replay) this.onFixation(e.f);
    // Fixations without a position were counted but not saved: the count stands as it was.
    this.fixCount = fixCount;
    const est = this.est;
    const line = est && this.layout ? this.layout.lines[est.lineIndex] : undefined;
    // The latest live sample was newer than the last fixation: progress along the (new) line from it.
    if (before && line && this.lastSampleT === before.t && Number.isFinite(this.lastSampleX)) {
      this.progressX = progressAlong(line, this.lastSampleX);
    }
    const now = Math.max(before?.t ?? -Infinity, est?.t ?? -Infinity);
    this.publish(Number.isFinite(now) ? now : 0);
  }

  private queueChange(at: number): void {
    const p = this.pendingChanges;
    let i = p.length;
    while (i > 0 && p[i - 1]! > at) i--;
    p.splice(i, 0, at);
    if (p.length > MAX_PENDING_CHANGES) p.splice(0, p.length - MAX_PENDING_CHANGES);
  }

  /**
   * Starts over (a new book, a new calibration). With `keepDrift` the drift learned so far (the
   * one that goes with the most likely line) is kept, softened (half of it reset to the fresh
   * prior): opening another book with the same calibration then starts from the offset it
   * already knows. With `calibrated` (a calibration just ran) the drift prior has no uniform share.
   */
  reset(opts: LineTrackerResetOptions = {}): void {
    this.driftBelief = opts.keepDrift ? this.keptDrift() : this.driftPrior(opts.calibrated ? 0 : DRIFT_PRIOR_UNIFORM);
    this.joint = this.seed(this.topPrior());
    this.clearPrevFix();
    this.history = [];
    this.turnedAt = -Infinity;
    this.lastSampleX = NaN;
    this.lastSampleT = NaN;
    // A kept drift may predate a reported appearance change, so that still applies (at the next
    // fixation); a full reset (a new calibration) starts from "calibration is about right" and forgets it.
    if (!opts.keepDrift) this.pendingChanges = [];
    this.sigmaLines = this.opts.sigmaYLines;
    this.residVar = (this.sigmaLines / SIGMA_INFLATE) ** 2;
    this.fixCount = 0;
    this.excursions = 0;
    this.lastSaccade = null;
    this.progressX = 0;
    this.summarize();
    if (!opts.keepDrift) this.driftY = 0;
    this.est = null;
  }

  // ── internals ──

  private pitch(): number {
    const p = this.layout?.linePitch;
    return p !== undefined && Number.isFinite(p) && p > 0 ? p : FALLBACK_PITCH_PX;
  }

  private clearPrevFix(): void {
    this.prevFix = null;
    this.dyUntrusted = false;
    this.glance = null;
  }

  /** Saves the state before fixation `f` (dropping states older than HISTORY_MS); returns its entry. */
  private remember(f: Fixation): HistoryEntry {
    const h = this.history;
    let drop = 0;
    while (drop < h.length && !(h[drop]!.f.start >= f.start - HISTORY_MS)) drop++;
    if (drop > 0) h.splice(0, drop);
    const entry: HistoryEntry = { f, snap: this.snapshot(), applied: [] };
    h.push(entry);
    return entry;
  }

  private snapshot(): TrackerSnapshot {
    return {
      // The emission updates the joint in place: copy it (the rest is replaced, never mutated).
      joint: this.joint.slice(),
      driftBelief: this.driftBelief.slice(),
      post: this.post,
      prevFix: this.prevFix,
      dyUntrusted: this.dyUntrusted,
      // glance.left counts down in place.
      glance: this.glance ? { ...this.glance } : null,
      driftY: this.driftY,
      driftLo: this.driftLo,
      driftHi: this.driftHi,
      driftSdLines: this.driftSdLines,
      sigmaLines: this.sigmaLines,
      residVar: this.residVar,
      fixCount: this.fixCount,
      excursions: this.excursions,
      lastSaccade: this.lastSaccade,
      progressX: this.progressX,
    };
  }

  private restore(s: TrackerSnapshot): void {
    this.joint = s.joint;
    this.driftBelief = s.driftBelief;
    this.post = s.post;
    this.prevFix = s.prevFix;
    this.dyUntrusted = s.dyUntrusted;
    this.glance = s.glance;
    this.driftY = s.driftY;
    this.driftLo = s.driftLo;
    this.driftHi = s.driftHi;
    this.driftSdLines = s.driftSdLines;
    this.sigmaLines = s.sigmaLines;
    this.residVar = s.residVar;
    this.fixCount = s.fixCount;
    this.excursions = s.excursions;
    this.lastSaccade = s.lastSaccade;
    this.progressX = s.progressX;
  }

  /**
   * Applies the appearance changes that happened before a fixation starting at `start`; true if any
   * did. Their times are added to `applied` (the fixation's history entry).
   */
  private applyPendingChanges(start: number, applied: number[]): boolean {
    const p = this.pendingChanges;
    if (p.length === 0 || !(p[0]! <= start)) return false;
    let n = 0;
    while (n < p.length && p[n]! <= start) n++;
    applied.push(...p.splice(0, n));
    const m = this.states.length;
    const D = this.grid.length;
    if (m === 0 || D === 0) return false;
    // Keep the line marginal; forget most of the drift (it is what changed). A glance in flight is
    // no longer undone: the state before it belongs to the old bias.
    const lineW = new Array<number>(m);
    for (let k = 0; k < m; k++) {
      let s = 0;
      for (let b = 0; b < D; b++) s += this.joint[k * D + b]!;
      lineW[k] = s;
    }
    this.driftBelief = mixWithUniform(this.driftBelief, APPEARANCE_KEEP_DRIFT);
    this.joint = this.seed(lineW);
    if (this.prevFix) this.dyUntrusted = true;
    this.glance = null;
    this.summarize();
    return true;
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

  /** The fresh drift prior: N(0, DRIFT_PRIOR_SIGMA_LINES) with `uniform` of it spread over the grid. */
  private driftPrior(uniform = DRIFT_PRIOR_UNIFORM): Float64Array {
    const p = new Float64Array(this.grid.length);
    let z = 0;
    for (let b = 0; b < p.length; b++) {
      const u = this.grid[b]! / DRIFT_PRIOR_SIGMA_LINES;
      p[b] = Math.exp(-0.5 * u * u);
      z += p[b]!;
    }
    for (let b = 0; b < p.length; b++) p[b] = ((1 - uniform) * p[b]!) / z + uniform / p.length;
    return p;
  }

  /**
   * The drift that goes with the most likely line (what driftY reports), blended with the fresh
   * prior (RESET_KEEP_DRIFT). Without a line (no layout yet), the drift belief itself.
   */
  private keptDrift(): Float64Array {
    const D = this.grid.length;
    const prior = this.driftPrior();
    const k = this.states.indexOf(argmax(this.post));
    const joint = this.joint;
    const row = (b: number): number => (k >= 0 && joint.length >= (k + 1) * D ? joint[k * D + b]! : this.driftBelief[b]!);
    let z = 0;
    for (let b = 0; b < D; b++) z += row(b);
    if (!(z > 0) || !Number.isFinite(z)) return prior;
    const out = new Float64Array(D);
    for (let b = 0; b < D; b++) out[b] = (RESET_KEEP_DRIFT * row(b)) / z + (1 - RESET_KEEP_DRIFT) * prior[b]!;
    return out;
  }

  private isExcursion(f: Fixation, lines: readonly TextLine[], pitch: number): boolean {
    const first = lines[this.states[0]!]!;
    const last = lines[this.states[this.states.length - 1]!]!;
    // Off the text for every drift still believed possible: above the text even with the lowest
    // plausible drift, or below it even with the highest.
    if (f.y - this.driftLo * pitch < first.centerY - EXCURSION_LINES * pitch) return true;
    if (f.y - this.driftHi * pitch > last.centerY + EXCURSION_LINES * pitch) return true;
    const c = this.column;
    const margin = EXCURSION_COLUMN * Math.max(c.right - c.left, pitch);
    return f.x < c.left - margin || f.x > c.right + margin;
  }

  /** A confident fixation's residual is fit to learn σ from (not a glance past the first/last line). */
  private plausible(e: number, best: number): boolean {
    if (!(Math.abs(e) <= LEARN_MAX_RESIDUAL_LINES)) return false;
    if (best === this.states[this.states.length - 1] && e > 0.5) return false;
    if (best === this.states[0] && e < -0.5) return false;
    return true;
  }

  /**
   * HMM prediction: line transition for this saccade kind (a downward mid-line jump partly as a
   * step of the gaze bias; a sweep-like long regression partly as a return sweep), then the drift
   * random walk. dxCol is the horizontal displacement as a share of the column width.
   */
  private predict(kind: SaccadeKind, dyLines: number, dxCol: number, sweepLike = false): void {
    const m = this.states.length;
    const D = this.grid.length;
    const out = new Float64Array(m * D);
    // A downward mid-line jump: from each line whose jump would land on the text, a share stays on
    // the line with the drift shifted by dy. A jump down past the last line is a look below the
    // page (lingering at the end, the glance-down gesture), not the bias stepping.
    const stepRows =
      kind === 'jump' && dyLines > 0 && dxCol >= SENSOR_STEP_MIN_DX_COL && dxCol <= SENSOR_STEP_MAX_DX_COL && D > 1
        ? Math.max(0, Math.min(m, Math.floor(m - 0.5 - dyLines) + 1))
        : 0;
    let src = this.joint;
    if (stepRows > 0) {
      const shift = Math.round(dyLines / (this.grid[1]! - this.grid[0]!));
      const rest = src.slice();
      for (let k = 0; k < stepRows; k++) {
        for (let b = 0; b < D; b++) rest[k * D + b] = rest[k * D + b]! * (1 - SENSOR_STEP_SHARE);
        // Mass shifted past the modelled range is dropped (the next emission renormalizes).
        for (let b = Math.max(0, -shift); b < D && b + shift < D; b++) out[k * D + b + shift] = SENSOR_STEP_SHARE * src[k * D + b]!;
      }
      src = rest;
    }
    const col = new Array<number>(m);
    // The jump kernel depends on the lines and dy only, not on the drift bin: build it once.
    const jk = kind === 'jump' ? jumpKernel(m, dyLines) : undefined;
    for (let b = 0; b < D; b++) {
      for (let k = 0; k < m; k++) col[k] = src[k * D + b]!;
      const next = transitionLines(col, kind, dyLines, jk);
      if (sweepLike) {
        const sweep = transitionLines(col, 'return-sweep', dyLines);
        for (let k = 0; k < m; k++) {
          next[k] = (1 - LONG_REGRESSION_SWEEP_SHARE) * next[k]! + LONG_REGRESSION_SWEEP_SHARE * sweep[k]!;
        }
      }
      for (let k = 0; k < m; k++) out[k * D + b] = out[k * D + b]! + next[k]!;
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

  /** Recomputes the line marginal, the drift belief (and its range) and driftY from the joint. */
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
    this.updateDriftRange();
    // Report the drift that goes with the most likely line (the overall mean would blur competing hypotheses).
    const best = argmax(post);
    const k = best >= 0 ? this.states.indexOf(best) : -1;
    this.driftSdLines = Infinity;
    if (k >= 0) {
      let s = 0;
      let s2 = 0;
      let w = 0;
      for (let b = 0; b < D; b++) {
        const v = this.joint[k * D + b]!;
        const g = this.grid[b]!;
        s += v * g;
        s2 += v * g * g;
        w += v;
      }
      if (w > 0) {
        const mu = s / w;
        this.driftY = mu * this.pitch();
        this.driftSdLines = Math.sqrt(Math.max(0, s2 / w - mu * mu));
      }
    }
  }

  /** Drift-belief quantiles (DRIFT_TAIL, 1 − DRIFT_TAIL), lines. */
  private updateDriftRange(): void {
    const p = this.driftBelief;
    const g = this.grid;
    const n = g.length;
    if (n === 0) {
      this.driftLo = 0;
      this.driftHi = 0;
      return;
    }
    let lo = g[0]!;
    let hi = g[n - 1]!;
    let c = 0;
    let loSet = false;
    for (let b = 0; b < n; b++) {
      c += p[b]!;
      if (!loSet && c >= DRIFT_TAIL) {
        lo = g[b]!;
        loSet = true;
      }
      if (c >= 1 - DRIFT_TAIL) {
        hi = g[b]!;
        break;
      }
    }
    this.driftLo = lo;
    this.driftHi = Math.max(lo, hi);
  }

  private publish(t: number): TrackedLineEstimate {
    const best = argmax(this.post);
    const pitch = this.pitch();
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
      excursions: this.excursions,
      driftLowY: this.driftLo * pitch,
      driftHighY: this.driftHi * pitch,
      driftSdY: Number.isFinite(this.driftSdLines) ? this.driftSdLines * pitch : NaN,
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

/** layout.column when it is a real box, else the union of the readable lines (else the viewport). */
function textColumn(layout: LineLayout, states: readonly number[]): { left: number; right: number } {
  const c = layout.column;
  if (Number.isFinite(c.left) && Number.isFinite(c.right) && c.right > c.left) return { left: c.left, right: c.right };
  let left = Infinity;
  let right = -Infinity;
  for (const i of states) {
    const l = layout.lines[i]!;
    if (Number.isFinite(l.left)) left = Math.min(left, l.left);
    if (Number.isFinite(l.right)) right = Math.max(right, l.right);
  }
  if (right > left) return { left, right };
  const v = layout.viewport;
  return Number.isFinite(v.left) && Number.isFinite(v.right) && v.right > v.left ? { left: v.left, right: v.right } : { left: 0, right: 0 };
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

/** `f` lands back where the eyes were before the glance (or a word or so further on). */
function isStraightBack(g: { from: Fixation; to: Fixation }, f: Fixation, pitch: number, columnWidth: number): boolean {
  const dx = (f.x - g.from.x) / columnWidth;
  const tolY = Math.max(GLANCE_BACK_LINES * pitch, GLANCE_BACK_SHARE * Math.abs(g.to.y - g.from.y));
  return Math.abs(f.y - g.from.y) <= tolY && dx >= GLANCE_BACK_MIN_DX_COL && dx <= GLANCE_BACK_MAX_DX_COL;
}

/** keep × belief + (1 − keep) × uniform, as a new normalized array. */
function mixWithUniform(belief: Float64Array, keep: number): Float64Array {
  const D = belief.length;
  const out = new Float64Array(D);
  if (D === 0) return out;
  let z = 0;
  for (let b = 0; b < D; b++) z += belief[b]! > 0 ? belief[b]! : 0;
  const k = z > 0 ? clamp01(keep) : 0;
  for (let b = 0; b < D; b++) out[b] = (z > 0 ? (k * Math.max(0, belief[b]!)) / z : 0) + (1 - k) / D;
  return out;
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

/** A jump's directed part: K[i·m + j] ∝ N(j − i − dy; 0, σ), Z[i] = Σ_j K[i·m + j] (the row's normalizer). */
interface JumpKernel {
  K: Float64Array;
  Z: Float64Array;
}

function jumpKernel(m: number, dyLines: number): JumpKernel {
  const shift = Number.isFinite(dyLines) ? dyLines : 0;
  const K = new Float64Array(m * m);
  const Z = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let z = 0;
    for (let j = 0; j < m; j++) {
      const d = (j - i - shift) / JUMP_KERNEL_SIGMA_LINES;
      const v = Math.exp(-0.5 * d * d);
      K[i * m + j] = v;
      z += v;
    }
    Z[i] = z;
  }
  return { K, Z };
}

/**
 * Line transition of one probability vector (over readable states, top to bottom). `jk`: the jump
 * kernel for this m and dy, when the caller transitions many vectors with it (built here otherwise).
 */
function transitionLines(a: readonly number[], kind: SaccadeKind, dyLines: number, jk?: JumpKernel): number[] {
  const m = a.length;
  const out = new Array<number>(m).fill(0);
  let mass = 0;
  for (const v of a) mass += v;
  if (!(mass > 0)) return out;
  if (kind === 'jump') {
    const { K, Z } = jk ?? jumpKernel(m, dyLines);
    for (let i = 0; i < m; i++) {
      const ai = a[i]!;
      if (!(ai > 0)) continue;
      const z = Z[i]!;
      if (!(z > 0)) continue;
      for (let j = 0; j < m; j++) out[j] = out[j]! + ((1 - JUMP_UNIFORM) * ai * K[i * m + j]!) / z;
    }
    for (let j = 0; j < m; j++) out[j] = out[j]! + (JUMP_UNIFORM * mass) / m;
    return out;
  }
  // Absorbing edges: moving on from the last readable line (looking for a next line
  // that isn't there) keeps the reader at the bottom rather than scattering them over
  // the page; likewise moving back from the first line keeps them at the top.
  const T = LINE_TRANSITIONS[kind];
  const rem = Math.max(0, 1 - (T.stay + T.next + T.next2 + T.prev));
  let uniformMass = 0;
  for (let i = 0; i < m; i++) {
    const ai = a[i]!;
    if (!(ai > 0)) continue;
    const down1 = Math.min(i + 1, m - 1);
    const down2 = Math.min(i + 2, m - 1);
    const up1 = Math.max(i - 1, 0);
    out[i] = out[i]! + ai * T.stay;
    out[down1] = out[down1]! + ai * T.next;
    out[down2] = out[down2]! + ai * T.next2;
    out[up1] = out[up1]! + ai * T.prev;
    uniformMass += ai * rem;
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
