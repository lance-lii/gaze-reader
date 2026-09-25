import type {
  GazeSample,
  LineEstimate,
  LineLayout,
  PageEndDecision,
  PageEndReason,
  Sensitivity,
  TextLine,
} from '../types';
import { isTrackedLineEstimate } from './lineTracker';

/**
 * Decides when the reader has reached the end of the visible page. Pure logic:
 * time comes in with every input, nothing here reads a clock or the DOM.
 *
 * Rules (L = last fully visible line; any rule fires once every guard passes):
 *  1. line-tracker — the tracker puts ≥ θp on L (or below it) and gaze progress
 *     along L ≥ θx (with the gaze still within reach of L) for `dwell`; or, once
 *     that has been true, a return-sweep-like jump back to the left margin (the
 *     reader looking for a next line that isn't there) fires immediately.
 *  2. bottom-dwell — drift-corrected gaze at/below L.top − 0.25 pitch in the
 *     right half of L, but still on the page, for `Tzone` (fallback while the
 *     tracker is unsure).
 *  3. glance-down — gaze at/below the bottom edge for `Tglance` (on by default; can be
 *     switched off). A tracker confident the reader is above the last two lines vetoes it,
 *     as for rule 2, so a look at the keyboard or a phone mid-page doesn't turn the page.
 *
 * Guards: cooldown after any scroll (and after firing); ≥ 60 % valid samples in
 * the last second; ≥ 4 fixations on the page or ≥ 2.5 s since the last turn
 * (glance-down exempt). It only ever fires on a valid sample: a rule that
 * becomes ready during a blink fires on the next valid one.
 *
 * Refinements measured on the simulator (see pipeline.test.ts):
 *  - Dwell times are leaky accumulators: time in the condition counts up, time
 *    out of it drains 3× as fast, and brief tracking dropouts (blinks) freeze
 *    the count. One noisy sample doesn't restart a dwell; a sustained exit does.
 *  - Rule 1 needs the tracker to have *entered* L: to have put the reader there
 *    right after a return sweep or on a fresh page, or been ≥ 90 % sure of it
 *    for 3 fixations. Vertical noise can slide the tracker onto L while the
 *    reader is still finishing L−1; this stops that from turning the page early.
 *    A jump onto L needs the 3 sure fixations too: a peek at the end of the
 *    page mid-page looks like one, and so does the gaze bias stepping down
 *    several lines (a light switched on) — the tracker then follows the "jump"
 *    and the sweep shortcut and the dwell would turn the page lines early. (At
 *    an 800 / 1200 ms peek the page turned in 13 / 39 of 48 simulated runs with
 *    the jump counting as an entry, 5 / 18 without; a reader who really skips
 *    to the last line and reads it still turns it.) The exception is a jump
 *    exactly one line down that lands at the start of the column: a return
 *    sweep across a scene break or a heading margin (> 2.5 pitches, so the
 *    tracker calls it a jump) enters the line like any other sweep (a short
 *    last line 2.8 pitches below the one before: turn latency p90 922 →
 *    256 ms, as in 1.0; peeks at the end of the page turn no more often).
 *    Any scroll forgets the entry: it belongs to the view it happened in.
 *  - Every zone test compares drift-corrected gaze (y − driftY) with the page.
 *    The tracker models drift up to ±5 lines (lighting can shift webcam gaze
 *    that far), so the zones follow a large learned offset rather than reading
 *    it as "below the page" — but only once the tracker has pinned it (≥ 60 %
 *    sure of the line, drift SD ≤ 0.5 pitch); an unpinned driftY is clamped to
 *    ±1.5 pitches. In steady light at high noise or on long gapless paragraphs
 *    the tracker can sit a few lines behind with a spurious 2–4-line drift, and
 *    zones that followed it in full missed turns and scrolled unread text away.
 *  - Doubt (≥ 10 % still on L−1) doubles rule 1's dwell and disables the sweep
 *    shortcut; ≥ 25 % at the moment of firing anchors the turn at L−1, so an
 *    early turn repeats a line rather than scrolling unread text away.
 *  - θx on a short paragraph-final last line is judged against the column
 *    width (see `endProgress`): "only a few words left" means the same on any line.
 *  - Glance-down re-arms only after the gaze has come back up onto the page, so
 *    looking at the keyboard turns one page, not one every cooldown.
 *  - After firing, rules 1 and 2 wait for the gaze to come back up the page.
 *    Gaze that stays parked at the bottom right (a resting mouse, eyes that
 *    didn't follow the turn) would otherwise "reach the end" of every new page
 *    within seconds and page through the book on its own.
 *  - Gaze clearly below the page doesn't count for bottom-dwell: that is
 *    glance-down's gesture, and with glance-down switched off, looking at the
 *    keyboard or a phone must not turn the page.
 */

export interface PageEndInput {
  t: number;
  gaze: GazeSample | null;
  estimate: LineEstimate | null;
  layout: LineLayout | null;
}

export interface PageEndOptions {
  sensitivity: Sensitivity;
  glanceDownToTurn: boolean;
}

export const DEFAULT_PAGE_END_OPTIONS: Readonly<PageEndOptions> = Object.freeze({
  sensitivity: 'balanced',
  glanceDownToTurn: true,
});

export interface PageEndThresholds {
  /** θp — tracker probability that the reader is on the last fully visible line (or below). */
  minPosterior: number;
  /** θx — horizontal progress along that line, 0..1. */
  minProgress: number;
  /** Rule 1 dwell, ms. */
  dwellMs: number;
  /** Rule 2 (bottom-dwell) Tzone, ms. */
  zoneMs: number;
  /** Rule 3 (glance-down) Tglance, ms. */
  glanceMs: number;
  /** No trigger for this long after any scroll (or after a trigger), ms. */
  cooldownMs: number;
}

export const PAGE_END_PRESETS: Readonly<Record<Sensitivity, Readonly<PageEndThresholds>>> = Object.freeze({
  relaxed: Object.freeze({ minPosterior: 0.7, minProgress: 0.85, dwellMs: 600, zoneMs: 1800, glanceMs: 800, cooldownMs: 2200 }),
  balanced: Object.freeze({ minPosterior: 0.55, minProgress: 0.7, dwellMs: 350, zoneMs: 1200, glanceMs: 600, cooldownMs: 1800 }),
  eager: Object.freeze({ minPosterior: 0.45, minProgress: 0.55, dwellMs: 200, zoneMs: 800, glanceMs: 450, cooldownMs: 1400 }),
});

export const PAGE_END_GUARDS = Object.freeze({
  /** Rolling window for the validity guard, ms. */
  validityWindowMs: 1000,
  /** Minimum fraction of valid gaze samples in that window. */
  minValidFraction: 0.6,
  /** Enough reading on this page: this many fixations... */
  minFixationsOnPage: 4,
  /** ...or this long since the last turn (glance-down is exempt from both). */
  minMsSinceTurn: 2500,
});

/** Geometry of the page-end rules. Y values are in text coordinates: compare with `gaze.y − driftY`. */
export interface PageEndZones {
  lastIndex: number;
  lastLine: TextLine;
  pitch: number;
  /** Bottom-dwell zone: zoneTop ≤ y ≤ zoneBottom and zoneLeft ≤ x ≤ zoneRight. */
  zoneTop: number;
  /** Below this the reader is looking off the page, not dwelling on its last line. */
  zoneBottom: number;
  zoneLeft: number;
  zoneRight: number;
  /** Glance-down: y ≥ glanceTop. */
  glanceTop: number;
  columnLeft: number;
  columnWidth: number;
}

/** Index of the last fully visible line, or -1. */
export function lastFullyVisibleLine(layout: LineLayout): number {
  const lines = layout.lines;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.fullyVisible) return i;
  return -1;
}

export function pageEndZones(layout: LineLayout | null): PageEndZones | null {
  if (!layout) return null;
  const lastIndex = lastFullyVisibleLine(layout);
  if (lastIndex < 0) return null;
  const L = layout.lines[lastIndex]!;
  const pitch = Number.isFinite(layout.linePitch) && layout.linePitch > 0 ? layout.linePitch : L.bottom - L.top || 40;
  const colLeft = Number.isFinite(layout.column.left) ? layout.column.left : L.left;
  const colRight = Number.isFinite(layout.column.right) ? layout.column.right : L.right;
  const columnWidth = Math.max(colRight - colLeft, L.right - L.left, 1);
  return {
    lastIndex,
    lastLine: L,
    pitch,
    zoneTop: L.top - 0.25 * pitch,
    zoneBottom: Math.max(layout.viewport.bottom, L.bottom) + ZONE_BELOW_PAGE_LINES * pitch,
    zoneLeft: L.left + 0.5 * (L.right - L.left),
    zoneRight: Math.max(colRight, L.right) + 0.1 * columnWidth,
    // Keep the glance threshold clear of the last line itself when it sits right at the edge.
    glanceTop: Math.max(layout.viewport.bottom - 0.2 * pitch, L.centerY + 0.6 * pitch),
    columnLeft: colLeft,
    columnWidth,
  };
}

/** Drain rate of a dwell accumulator while its condition is false (× elapsed time). */
const DWELL_DECAY = 3;
/** Tracking dropouts shorter than this freeze a dwell; longer ones reset it. */
const DROPOUT_GRACE_MS = 400;
/** Larger gaps between updates (the controller paused us) count as this much time. */
const MAX_STEP_MS = 100;
/** How long "confidently at the end of the last line" stays armed for the return-sweep shortcut. */
const SWEEP_ARM_MS = 1500;
/** Return-sweep shortcut: leftward extent (× column width), landing zone and confirmation samples. */
const SWEEP_MIN_DX_COL = 0.4;
const SWEEP_LAND_COL = 0.4;
const SWEEP_MAX_RISE_LINES = 0.5;
const SWEEP_CONFIRM_SAMPLES = 2;
/** Lines narrower than this (× column width) are "short" (paragraph-final) for the sweep shortcut. */
const SHORT_LINE_COL = 0.7;
const SHORT_SWEEP_MIN_DY_LINES = 0.3;
/** Bottom-dwell is vetoed when the tracker is this sure the reader is above the last two lines. */
const ZONE_VETO_CONFIDENCE = 0.8;
/** Fixations after a return sweep or a fresh page whose line counts as "the line entered". */
const ENTRY_FIXATIONS = 2;
/** The tracker being this sure of one line for this many fixations in a row also counts as entering it. */
const SETTLED_CONFIDENCE = 0.9;
const SETTLED_FIXATIONS = 3;
/**
 * Doubt: the tracker still gives the line above the last at least this much
 * probability. Then rule 1 waits twice as long and the sweep shortcut stays
 * off — if the reader is really finishing the line above, their return sweep
 * resets the dwell before it completes.
 */
const DOUBT = 0.1;
const DOUBT_DWELL_FACTOR = 2;
/**
 * Even more doubt at the moment of firing anchors the turn one line higher: a
 * turn that comes a line early then repeats a line instead of scrolling
 * unread text away.
 */
const ANCHOR_DOUBT = 0.25;
/** Glance-down re-arms once the gaze has come back this far above the glance threshold. */
const GLANCE_REARM_LINES = 1;
/**
 * Bottom-dwell only counts gaze down to this many pitches below the page (slack for
 * vertical noise while reading the last line); further down is a look off the page.
 */
const ZONE_BELOW_PAGE_LINES = 1;
/** After firing, rules 1 and 2 re-arm once the gaze has come back this far above the bottom-dwell zone. */
const LOOK_UP_LINES = 1;
/**
 * Rule 1 only counts live gaze (drift-corrected) no higher than this many pitches above the
 * last line's top. The tracker moves on completed fixations, so for a fixation's length after
 * the eyes leave L it still says L — and on a short last line θx is met almost anywhere in the
 * column. Without this, a peek at the last line mid-page turned the page once the eyes were back.
 */
const LAST_LINE_REACH_LINES = 1.5;
/**
 * The zones use the tracker's driftY in full only while it is pinned: the tracker at least this
 * sure of its line, with the drift that goes with that line known to within this SD (pitches).
 * Otherwise it is clamped to ± this many pitches. In steady light at high noise, or on long
 * gapless paragraphs, the ±5-line tracker sometimes sits a few lines behind with a matching 2–4-line
 * drift ("line k − 3, +3" explains unstructured text as well as "line k, 0"); 97 % of fixations
 * with |driftY| ≥ 1.5 lines are unpinned. Estimates without driftSdY (hand-made) are not clamped.
 */
const PIN_CONFIDENCE = 0.6;
const PIN_MAX_DRIFT_SD_LINES = 0.5;
const UNPINNED_MAX_DRIFT_LINES = 1.5;

type Tri = boolean | null;

class Dwell {
  held = 0;
  private dropout = 0;

  step(state: Tri, dt: number): void {
    if (state === null) {
      this.dropout += dt;
      if (this.dropout > DROPOUT_GRACE_MS) this.held = 0;
      return;
    }
    this.dropout = 0;
    this.held = state ? this.held + dt : Math.max(0, this.held - DWELL_DECAY * dt);
  }

  reset(): void {
    this.held = 0;
    this.dropout = 0;
  }
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const fmtP = (p: number): string => p.toFixed(2);
const fmtMs = (ms: number): string => `${Math.round(ms)}`;

export class PageEndDetector {
  private opts: PageEndOptions;
  private th: Readonly<PageEndThresholds>;

  private readonly lineDwell = new Dwell();
  private readonly zoneDwell = new Dwell();
  private readonly glanceDwell = new Dwell();

  private startedAt: number | null = null;
  private lastT: number | null = null;
  private lastScrollAt: number | null = null;
  private lastFireAt: number | null = null;

  /** Validity window (ring of recent samples). */
  private vT: number[] = [];
  private vOk: boolean[] = [];
  private vHead = 0;
  private vValid = 0;

  private armedUntil = -Infinity;
  private armMaxX = -Infinity;
  /** Highest drift-corrected gaze while armed (min y). With the rightmost x, an episode extreme: see isSweep. */
  private armTopY = Infinity;
  private sweepRun = 0;
  /** A return sweep off the armed last line was seen; it fires on the next valid sample while armed. */
  private sweepSeen = false;
  private lastFixCount = -1;
  /** docTop of the line the tracker put the reader on when they last entered a line. */
  private enteredDocTop: number | null = null;
  private entryLeft = 0;
  /** The tracker's line at the previous fixation (-1: none yet in this view). */
  private prevLineIndex = -1;
  private settledDocTop: number | null = null;
  private settledRun = 0;
  private glanceArmed = true;
  /** The gaze has been up the page since the last trigger (rules 1 and 2 wait for it). */
  private lookedUp = true;

  constructor(opts: Partial<PageEndOptions> = {}) {
    this.opts = { ...DEFAULT_PAGE_END_OPTIONS };
    this.th = PAGE_END_PRESETS[this.opts.sensitivity];
    this.configure(opts);
  }

  get options(): Readonly<PageEndOptions> {
    return this.opts;
  }

  get thresholds(): Readonly<PageEndThresholds> {
    return this.th;
  }

  configure(opts: Partial<PageEndOptions>): void {
    const next = { ...this.opts };
    if (opts.sensitivity && opts.sensitivity in PAGE_END_PRESETS) next.sensitivity = opts.sensitivity;
    if (typeof opts.glanceDownToTurn === 'boolean') next.glanceDownToTurn = opts.glanceDownToTurn;
    this.opts = next;
    this.th = PAGE_END_PRESETS[next.sensitivity];
    if (!next.glanceDownToTurn) this.glanceDwell.reset();
  }

  notifyScrolled(t: number): void {
    if (!Number.isFinite(t)) return;
    this.lastScrollAt = this.lastScrollAt === null ? t : Math.max(this.lastScrollAt, t);
    this.disarm();
    // Which line the reader entered belongs to the view they entered it in. After a page back
    // (or undo) the line entered on the later page sits at or below this page's last line, and
    // would wave rule 1 through without the reader ever getting there.
    this.clearEntry();
  }

  reset(): void {
    this.lineDwell.reset();
    this.zoneDwell.reset();
    this.glanceDwell.reset();
    this.startedAt = null;
    this.lastT = null;
    this.lastScrollAt = null;
    this.lastFireAt = null;
    this.vT = [];
    this.vOk = [];
    this.vHead = 0;
    this.vValid = 0;
    this.disarmSweep();
    this.clearEntry();
    this.glanceArmed = true;
    this.lookedUp = true;
  }

  update(input: PageEndInput): PageEndDecision {
    const t = input.t;
    if (!Number.isFinite(t)) return idle(-1, 'no clock (t is not finite)');
    if (this.startedAt === null) this.startedAt = t;
    const dt = this.lastT === null ? 0 : Math.min(MAX_STEP_MS, Math.max(0, t - this.lastT));
    this.lastT = Math.max(t, this.lastT ?? t);

    const g = input.gaze;
    const valid = !!g && g.valid && Number.isFinite(g.x) && Number.isFinite(g.y);
    const validFraction = this.recordValidity(t, valid);

    const layout = input.layout;
    const zones = pageEndZones(layout);
    if (!layout || !zones) {
      this.lineDwell.reset();
      this.zoneDwell.reset();
      this.glanceDwell.reset();
      this.disarmSweep();
      return idle(-1, layout ? 'no fully visible line' : 'no layout');
    }
    const L = zones.lastIndex;
    const Lline = zones.lastLine;
    const pitch = zones.pitch;
    const th = this.th;

    const est = input.estimate && input.estimate.posterior.length === layout.lines.length ? input.estimate : null;
    let drift = est && Number.isFinite(est.driftY) ? est.driftY : 0;
    if (est && isTrackedLineEstimate(est)) {
      // A large drift the tracker hasn't pinned (unsure of the line, or of the drift that goes
      // with it) is as often a spurious (line k − 3, +3) reading of unstructured text as a real
      // offset: the zones follow only as much of it as the old tracker modelled.
      const sd = est.driftSdY ?? NaN;
      const pinned = est.probability >= PIN_CONFIDENCE && sd <= PIN_MAX_DRIFT_SD_LINES * pitch; // NaN: unpinned
      if (!pinned) drift = Math.min(UNPINNED_MAX_DRIFT_LINES * pitch, Math.max(-UNPINNED_MAX_DRIFT_LINES * pitch, drift));
    }
    let pEnd = 0;
    if (est) for (let j = L; j < est.posterior.length; j++) pEnd += est.posterior[j]!;
    const x = valid ? g!.x : NaN;
    const yc = valid ? g!.y - drift : NaN;
    const progress = valid ? endProgress(Lline, x, zones.columnWidth) : NaN;

    // Which line did the tracker say the reader entered (right after a return sweep or on a fresh
    // page — or by being very sure of it for a while)? A tracker that slides onto the last line
    // mid-line on vertical evidence alone hasn't seen the reader get there; the sweep into it (or
    // a glance back from its end) will show it. Nor has a tracker that followed a jump there (a
    // peek at the end of the page, the gaze bias stepping down): that takes the sure fixations.
    if (est && est.fixationsOnPage !== this.lastFixCount) {
      if (est.lastSaccade === 'return-sweep' && t <= this.armedUntil && this.lastFixCount >= 0) this.sweepSeen = true;
      const fresh = est.lastSaccade === 'return-sweep' || est.lastSaccade === null;
      if (fresh) this.entryLeft = ENTRY_FIXATIONS;
      const line = layout.lines[est.lineIndex];
      if (line) {
        // A jump that moves the tracker exactly one line down and lands at the start of the column
        // is a return sweep across a block gap (an hr scene break spans ≈ 2.8 pitches, an h2 ≈ 2.6,
        // so the sweep is classified as a jump): it enters the line like any return sweep.
        const gapSweep =
          est.lastSaccade === 'jump' &&
          this.prevLineIndex >= 0 &&
          est.lineIndex === this.prevLineIndex + 1 &&
          valid &&
          x <= zones.columnLeft + SWEEP_LAND_COL * zones.columnWidth;
        if (gapSweep) {
          this.enteredDocTop = line.docTop;
          this.entryLeft = ENTRY_FIXATIONS - 1;
        } else if (est.lastSaccade === 'jump') {
          // A jump up (back to re-read) leaves the line entered; a jump down doesn't enter one.
          this.entryLeft = 0;
          if (this.enteredDocTop !== null && line.docTop < this.enteredDocTop) this.enteredDocTop = line.docTop;
        } else if (this.entryLeft > 0) {
          // The furthest line placed during the entry: a wobble on the corrective saccade doesn't undo an arrival.
          this.enteredDocTop = fresh || this.enteredDocTop === null ? line.docTop : Math.max(this.enteredDocTop, line.docTop);
          this.entryLeft--;
        }
        const same = this.settledDocTop !== null && Math.abs(this.settledDocTop - line.docTop) < 0.5 * pitch;
        this.settledRun = est.probability >= SETTLED_CONFIDENCE ? (same ? this.settledRun + 1 : 1) : 0;
        this.settledDocTop = line.docTop;
        if (this.settledRun >= SETTLED_FIXATIONS) this.enteredDocTop = line.docTop;
      }
      this.lastFixCount = est.fixationsOnPage;
      this.prevLineIndex = est.lineIndex;
    }
    const entered = this.enteredDocTop !== null && this.enteredDocTop >= Lline.docTop - 0.5 * pitch;

    // After a trigger, rules 1 and 2 wait until the gaze has been back up the page (and their
    // dwells don't build up meanwhile, or they would fire the moment it leaves).
    if (valid && yc < zones.zoneTop - LOOK_UP_LINES * pitch) this.lookedUp = true;
    const armed = this.lookedUp;

    // Rule 1: on the last line, far enough along it.
    const pAbove = est && L > 0 ? est.posterior[L - 1]! : 0;
    const doubt = pAbove >= DOUBT;
    const dwellMs = doubt ? th.dwellMs * DOUBT_DWELL_FACTOR : th.dwellMs;
    const onLastLine = est !== null && entered && pEnd >= th.minPosterior;
    const withinReach = yc >= Lline.top - LAST_LINE_REACH_LINES * pitch;
    const c1: Tri = valid ? armed && onLastLine && withinReach && progress >= th.minProgress : est ? null : false;
    this.lineDwell.step(c1, dt);

    // Rule 1b: return sweep after having been (confidently) at the end of the last line.
    if (c1 === true && !doubt) {
      this.armedUntil = t + SWEEP_ARM_MS;
      this.armMaxX = Math.max(this.armMaxX, x);
      this.armTopY = Math.min(this.armTopY, yc);
    }
    if (t > this.armedUntil) this.disarmSweep();
    if (valid && t <= this.armedUntil) {
      this.sweepRun = this.isSweep(x, yc, Lline, zones) ? this.sweepRun + 1 : 0;
      if (this.sweepRun >= SWEEP_CONFIRM_SAMPLES) this.sweepSeen = true;
    }
    const sweep = this.sweepSeen;

    // Rule 2: parked at the bottom right, and the tracker isn't confidently elsewhere. A look
    // below the page tells it nothing (null: a brief noisy dip is ridden out, a sustained look
    // away clears it).
    const vetoed = est !== null && est.probability >= ZONE_VETO_CONFIDENCE && est.lineIndex >= 0 && est.lineIndex < L - 1;
    const c2: Tri =
      !valid || yc > zones.zoneBottom
        ? null
        : armed && !vetoed && yc >= zones.zoneTop && x >= zones.zoneLeft && x <= zones.zoneRight;
    this.zoneDwell.step(c2, dt);

    // Rule 3: deliberate glance below the page; must come back up before it can fire again.
    if (valid && yc < zones.glanceTop - GLANCE_REARM_LINES * pitch) this.glanceArmed = true;
    // A look at the keyboard or a phone mid-page is an excursion for the line tracker (it keeps its
    // line), so a tracker sure the reader is above the last two lines vetoes the gesture, as for rule 2.
    const c3: Tri = !this.opts.glanceDownToTurn ? false : valid ? this.glanceArmed && !vetoed && yc >= zones.glanceTop : null;
    this.glanceDwell.step(c3, dt);

    const lineReady = sweep || this.lineDwell.held >= dwellMs;
    const glanceReady = this.glanceDwell.held >= th.glanceMs;
    const zoneReady = this.zoneDwell.held >= th.zoneMs;

    const targetLineIndex =
      est && est.lineIndex >= L - 1 && est.lineIndex >= 0 ? Math.min(est.lineIndex, L) : L;
    const cautiousTarget =
      targetLineIndex === L && L > 0 && est && pAbove >= ANCHOR_DOUBT ? L - 1 : targetLineIndex;
    const closeness = Math.max(
      onLastLine ? clamp01(this.lineDwell.held / dwellMs) * pEnd : 0,
      clamp01(this.zoneDwell.held / th.zoneMs) * 0.6,
      clamp01(this.glanceDwell.held / th.glanceMs) * 0.9,
    );
    // The entry gate is invisible otherwise: a tracker sure of L with no dwell needs explaining.
    const notEntered = est !== null && !entered && pEnd >= th.minPosterior ? ' (not entered)' : '';
    const status = (): string =>
      `L=${L} p(L+)=${fmtP(pEnd)}${notEntered} x=${Number.isFinite(progress) ? fmtP(progress) : '–'} · ` +
      `dwell ${fmtMs(this.lineDwell.held)}/${dwellMs}${doubt ? ' (doubt)' : ''} · zone ${fmtMs(this.zoneDwell.held)}/${th.zoneMs}` +
      (this.opts.glanceDownToTurn ? ` · glance ${fmtMs(this.glanceDwell.held)}/${th.glanceMs}` : '');

    // Guards.
    const coolFrom = Math.max(this.lastScrollAt ?? -Infinity, this.lastFireAt ?? -Infinity);
    const coolLeft = coolFrom + th.cooldownMs - t;
    if (coolLeft > 0) return idle(targetLineIndex, `cooldown ${fmtMs(coolLeft)} ms · ${status()}`, closeness);
    if (validFraction < PAGE_END_GUARDS.minValidFraction) {
      return idle(
        targetLineIndex,
        `tracking lost: ${Math.round(validFraction * 100)}% valid in last ${PAGE_END_GUARDS.validityWindowMs} ms (need ${Math.round(PAGE_END_GUARDS.minValidFraction * 100)}%)`,
      );
    }
    const fixations = est?.fixationsOnPage ?? 0;
    const sinceTurn = t - (this.lastScrollAt ?? this.startedAt);
    const readEnough = fixations >= PAGE_END_GUARDS.minFixationsOnPage || sinceTurn >= PAGE_END_GUARDS.minMsSinceTurn;

    let reason: PageEndReason = 'none';
    let detail = '';
    let confidence = 0;
    if (lineReady && readEnough) {
      reason = 'line-tracker';
      confidence = clamp01(Math.max(pEnd, th.minPosterior));
      detail = sweep
        ? `line-tracker: return sweep off the last line (L=${L}, p=${fmtP(pEnd)})`
        : `line-tracker: on last line L=${L} p=${fmtP(pEnd)} x=${fmtP(progress)} for ${fmtMs(this.lineDwell.held)} ms`;
    } else if (glanceReady) {
      reason = 'glance-down';
      confidence = 0.9;
      detail = `glance-down: looked below the page for ${fmtMs(this.glanceDwell.held)} ms`;
    } else if (zoneReady && readEnough) {
      reason = 'bottom-dwell';
      confidence = clamp01(0.5 + 0.4 * pEnd);
      detail = `bottom-dwell: gaze in the bottom-right zone for ${fmtMs(this.zoneDwell.held)} ms`;
    }

    if (reason === 'none') {
      const waiting = !armed
        ? 'waiting: gaze has not left the bottom since the last trigger · '
        : (lineReady || zoneReady) && !readEnough
          ? `waiting: ${fixations}/${PAGE_END_GUARDS.minFixationsOnPage} fixations, ${fmtMs(sinceTurn)}/${PAGE_END_GUARDS.minMsSinceTurn} ms on page · `
          : '';
      return idle(targetLineIndex, waiting + status(), closeness);
    }
    // Every rule is ready, but this sample is a blink or a dropout: turn on the next valid one.
    // Nothing is consumed, so the dwells (frozen while invalid) and a seen sweep carry over.
    if (!valid) return idle(targetLineIndex, `holding: gaze invalid (${reason} ready) · ${status()}`, closeness);

    this.lastFireAt = t;
    this.lookedUp = false;
    this.disarm();
    // A deliberate glance means "next page"; the other rules hedge when the tracker isn't sure.
    const target = reason === 'glance-down' ? targetLineIndex : cautiousTarget;
    if (target !== targetLineIndex) detail += ` · anchored at L−1 (p=${fmtP(pAbove)})`;
    return { trigger: true, reason, confidence, targetLineIndex: target, detail };
  }

  /** Fraction of valid samples in the rolling window, including this one. */
  private recordValidity(t: number, valid: boolean): number {
    this.vT.push(t);
    this.vOk.push(valid);
    if (valid) this.vValid++;
    const from = t - PAGE_END_GUARDS.validityWindowMs;
    while (this.vHead < this.vT.length && this.vT[this.vHead]! < from) {
      if (this.vOk[this.vHead]) this.vValid--;
      this.vHead++;
    }
    if (this.vHead > 256 && this.vHead * 2 > this.vT.length) {
      this.vT = this.vT.slice(this.vHead);
      this.vOk = this.vOk.slice(this.vHead);
      this.vHead = 0;
    }
    const n = this.vT.length - this.vHead;
    return n > 0 ? this.vValid / n : 0;
  }

  /**
   * Gaze now looks like a return sweep off the (armed) last line: a long jump
   * back to the left margin that doesn't go up. From a short paragraph-final
   * line the jump back is short, so there it's "back over half the line and
   * down a bit" — the eyes looking for the next line.
   *
   * Movement is measured from the extremes of the arming episode (rightmost x,
   * highest y). A stricter preset arms on a subset of the samples a looser one
   * does, so this keeps "relaxed never fires before eager" true by construction.
   */
  private isSweep(x: number, yc: number, L: TextLine, z: PageEndZones): boolean {
    const back = this.armMaxX - x;
    const dy = yc - this.armTopY;
    if (dy < -SWEEP_MAX_RISE_LINES * z.pitch) return false;
    const w = L.right - L.left;
    if (w < SHORT_LINE_COL * z.columnWidth) {
      return back >= 0.5 * w && x <= z.columnLeft + SWEEP_LAND_COL * z.columnWidth && dy >= SHORT_SWEEP_MIN_DY_LINES * z.pitch;
    }
    return back >= SWEEP_MIN_DX_COL * z.columnWidth && x <= z.columnLeft + SWEEP_LAND_COL * z.columnWidth;
  }

  private disarmSweep(): void {
    this.armedUntil = -Infinity;
    this.armMaxX = -Infinity;
    this.armTopY = Infinity;
    this.sweepRun = 0;
    this.sweepSeen = false;
  }

  private clearEntry(): void {
    // -1: the next estimate is examined afresh, but can't count as a sweep across the scroll.
    this.lastFixCount = -1;
    this.enteredDocTop = null;
    this.entryLeft = 0;
    this.prevLineIndex = -1;
    this.settledDocTop = null;
    this.settledRun = 0;
  }

  private disarm(): void {
    this.lineDwell.reset();
    this.zoneDwell.reset();
    this.glanceDwell.reset();
    this.disarmSweep();
    this.glanceArmed = false;
  }
}

/**
 * How far along the last line the gaze is, 0..1, for the θx test. On a full
 * line this is plain progress. On a short paragraph-final line the distance
 * still to read is measured against the column width, so θx means the same
 * "only a few words left" everywhere: a 12-character last line is nearly done
 * as soon as it's reached.
 */
export function endProgress(line: TextLine, x: number, columnWidth: number): number {
  if (!Number.isFinite(x)) return NaN;
  const w = line.right - line.left;
  const along = w > 0 ? clamp01((x - line.left) / w) : x >= line.right ? 1 : 0;
  const remaining = Math.max(0, line.right - x);
  const byColumn = columnWidth > 0 ? clamp01(1 - remaining / columnWidth) : along;
  return Math.max(along, byColumn);
}

function idle(targetLineIndex: number, detail: string, confidence = 0): PageEndDecision {
  return { trigger: false, reason: 'none', confidence, targetLineIndex, detail };
}
