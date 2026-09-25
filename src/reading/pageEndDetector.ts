import type {
  GazeSample,
  LineEstimate,
  LineLayout,
  PageEndDecision,
  PageEndReason,
  Sensitivity,
  TextLine,
} from '../types';

/**
 * Decides when the reader has reached the end of the visible page. Pure logic:
 * time comes in with every input, nothing here reads a clock or the DOM.
 *
 * Rules (L = last fully visible line; any rule fires once every guard passes):
 *  1. line-tracker — the tracker puts ≥ θp on L (or below it) and gaze progress
 *     along L ≥ θx for `dwell`; or, once that has been true, a return-sweep-like
 *     jump back to the left margin (the reader looking for a next line that
 *     isn't there) fires immediately.
 *  2. bottom-dwell — drift-corrected gaze at/below L.top − 0.25 pitch in the
 *     right half of L for `Tzone` (fallback while the tracker is unsure).
 *  3. glance-down — gaze at/below the bottom edge for `Tglance` (opt-in gesture).
 *
 * Dwell times are leaky accumulators: time in the condition counts up, time
 * out of it drains 3× as fast, and brief tracking dropouts (blinks) freeze the
 * count. One noisy sample doesn't restart a dwell; a sustained exit does.
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
  /** Bottom-dwell zone: y ≥ zoneTop and zoneLeft ≤ x ≤ zoneRight. */
  zoneTop: number;
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
/** Bottom-dwell is vetoed when the tracker is this sure the reader is above the last two lines. */
const ZONE_VETO_CONFIDENCE = 0.8;
/** Glance-down re-arms once the gaze has come back this far above the glance threshold. */
const GLANCE_REARM_LINES = 1;

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
  private armY = NaN;
  private sweepRun = 0;
  private lastFixCount = -1;
  private glanceArmed = true;

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
    this.armedUntil = -Infinity;
    this.armMaxX = -Infinity;
    this.armY = NaN;
    this.sweepRun = 0;
    this.lastFixCount = -1;
    this.glanceArmed = true;
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
    const drift = est && Number.isFinite(est.driftY) ? est.driftY : 0;
    let pEnd = 0;
    if (est) for (let j = L; j < est.posterior.length; j++) pEnd += est.posterior[j]!;
    const x = valid ? g!.x : NaN;
    const yc = valid ? g!.y - drift : NaN;
    const lineW = Lline.right - Lline.left;
    const progress = valid ? (lineW > 0 ? clamp01((x - Lline.left) / lineW) : x >= Lline.right ? 1 : 0) : NaN;

    // Rule 1: on the last line, far enough along it.
    const onLastLine = est !== null && pEnd >= th.minPosterior;
    const c1: Tri = valid ? onLastLine && progress >= th.minProgress : est ? null : false;
    this.lineDwell.step(c1, dt);

    // Rule 1b: return sweep after having been at the end of the last line.
    let sweep = false;
    if (c1 === true) {
      this.armedUntil = t + SWEEP_ARM_MS;
      this.armMaxX = Math.max(this.armMaxX, x);
      this.armY = yc;
    }
    if (t > this.armedUntil) this.disarmSweep();
    if (valid && t <= this.armedUntil) {
      const leftward = this.armMaxX - x >= SWEEP_MIN_DX_COL * zones.columnWidth;
      const landed = x <= zones.columnLeft + SWEEP_LAND_COL * zones.columnWidth;
      const notUp = !(yc < this.armY - SWEEP_MAX_RISE_LINES * pitch);
      this.sweepRun = leftward && landed && notUp ? this.sweepRun + 1 : 0;
      if (this.sweepRun >= SWEEP_CONFIRM_SAMPLES) sweep = true;
    }
    if (est && est.fixationsOnPage !== this.lastFixCount) {
      if (est.lastSaccade === 'return-sweep' && t <= this.armedUntil && this.lastFixCount >= 0) sweep = true;
      this.lastFixCount = est.fixationsOnPage;
    }

    // Rule 2: parked at the bottom right, and the tracker isn't confidently elsewhere.
    const vetoed = est !== null && est.probability >= ZONE_VETO_CONFIDENCE && est.lineIndex >= 0 && est.lineIndex < L - 1;
    const c2: Tri = valid ? !vetoed && yc >= zones.zoneTop && x >= zones.zoneLeft && x <= zones.zoneRight : null;
    this.zoneDwell.step(c2, dt);

    // Rule 3: deliberate glance below the page; must come back up before it can fire again.
    if (valid && yc < zones.glanceTop - GLANCE_REARM_LINES * pitch) this.glanceArmed = true;
    const c3: Tri = !this.opts.glanceDownToTurn ? false : valid ? this.glanceArmed && yc >= zones.glanceTop : null;
    this.glanceDwell.step(c3, dt);

    const lineReady = sweep || this.lineDwell.held >= th.dwellMs;
    const glanceReady = this.glanceDwell.held >= th.glanceMs;
    const zoneReady = this.zoneDwell.held >= th.zoneMs;

    const targetLineIndex =
      est && est.lineIndex >= L - 1 && est.lineIndex >= 0 ? Math.min(est.lineIndex, L) : L;
    const closeness = Math.max(
      onLastLine ? clamp01(this.lineDwell.held / th.dwellMs) * pEnd : 0,
      clamp01(this.zoneDwell.held / th.zoneMs) * 0.6,
      clamp01(this.glanceDwell.held / th.glanceMs) * 0.9,
    );
    const status = (): string =>
      `L=${L} p(L+)=${fmtP(pEnd)} x=${Number.isFinite(progress) ? fmtP(progress) : '–'} · ` +
      `dwell ${fmtMs(this.lineDwell.held)}/${th.dwellMs} · zone ${fmtMs(this.zoneDwell.held)}/${th.zoneMs}` +
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
      const waiting =
        (lineReady || zoneReady) && !readEnough
          ? `waiting: ${fixations}/${PAGE_END_GUARDS.minFixationsOnPage} fixations, ${fmtMs(sinceTurn)}/${PAGE_END_GUARDS.minMsSinceTurn} ms on page · `
          : '';
      return idle(targetLineIndex, waiting + status(), closeness);
    }

    this.lastFireAt = t;
    this.disarm();
    return { trigger: true, reason, confidence, targetLineIndex, detail };
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

  private disarmSweep(): void {
    this.armedUntil = -Infinity;
    this.armMaxX = -Infinity;
    this.armY = NaN;
    this.sweepRun = 0;
  }

  private disarm(): void {
    this.lineDwell.reset();
    this.zoneDwell.reset();
    this.glanceDwell.reset();
    this.disarmSweep();
    this.glanceArmed = false;
  }
}

function idle(targetLineIndex: number, detail: string, confidence = 0): PageEndDecision {
  return { trigger: false, reason: 'none', confidence, targetLineIndex, detail };
}
