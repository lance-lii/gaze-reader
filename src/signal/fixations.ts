import type { Fixation, GazeSample, LineLayout, SaccadeKind, TextLine } from '../types';

/**
 * Online dispersion-threshold (I-DT) fixation detection, tuned for smoothed
 * webcam gaze at 30–60 Hz, plus reading-aware saccade classification.
 */

export interface FixationOptions {
  /** Max extent of a fixation, px: max(x range, y range) over its samples. */
  maxDispersionPx: number;
  /** A window must span at least this long (first → last sample) to count as a fixation. */
  minDurationMs: number;
  /** Tracking gaps (invalid samples / missing frames) longer than this end the current fixation. */
  maxGapMs: number;
}

export const DEFAULT_FIXATION_OPTIONS: Readonly<FixationOptions> = Object.freeze({
  maxDispersionPx: 72,
  minDurationMs: 80,
  maxGapMs: 150,
});

export interface FixationUpdate {
  /** A fixation that ended with this sample (emitted exactly once), else null. */
  completed: Fixation | null;
  /** The fixation in progress (id stays stable until it completes), else null. */
  current: Fixation | null;
}

interface Pt {
  t: number;
  x: number;
  y: number;
}

const finite = (v: number): boolean => Number.isFinite(v);

export class FixationDetector {
  private readonly opts: FixationOptions;
  /**
   * Candidate samples, kept only until the window qualifies as a fixation (the
   * I-DT start slides forward over them). A qualified fixation is summarized
   * by running aggregates, so memory stays bounded however long the reader stares.
   */
  private pts: Pt[] = [];
  private n = 0;
  private sumX = 0;
  private sumY = 0;
  private minX = Infinity;
  private maxX = -Infinity;
  private minY = Infinity;
  private maxY = -Infinity;
  private startT = 0;
  private endT = 0;
  /** Assigned once the window qualifies; stable through to completion. */
  private id: number | null = null;
  /**
   * First sample that left a qualified fixation. It only ends the fixation if
   * the next sample confirms the move; a lone outlier is dropped instead of
   * splitting one fixation in two.
   */
  private pending: Pt | null = null;
  private lastValidT = -Infinity;
  private lastT = -Infinity;
  private nextId = 1;

  constructor(opts: Partial<FixationOptions> = {}) {
    const d = DEFAULT_FIXATION_OPTIONS;
    const pick = (v: number | undefined, fallback: number, min: number): number =>
      v !== undefined && Number.isFinite(v) && v >= min ? v : fallback;
    this.opts = {
      maxDispersionPx: pick(opts.maxDispersionPx, d.maxDispersionPx, 1),
      minDurationMs: pick(opts.minDurationMs, d.minDurationMs, 0),
      maxGapMs: pick(opts.maxGapMs, d.maxGapMs, 0),
    };
  }

  get options(): Readonly<FixationOptions> {
    return this.opts;
  }

  push(s: GazeSample): FixationUpdate {
    const t = s.t;
    if (!finite(t)) return { completed: null, current: this.current() };
    // A clock that runs backwards means a new stream; don't stitch across it.
    if (t < this.lastT) this.clearWindow();
    this.lastT = t;

    let completed: Fixation | null = null;
    if ((this.n > 0 || this.pending) && t - this.lastValidT > this.opts.maxGapMs) {
      completed = this.finish();
    }

    const usable = s.valid && finite(s.x) && finite(s.y);
    if (!usable) return { completed, current: this.current() };
    this.lastValidT = t;
    const p: Pt = { t, x: s.x, y: s.y };

    if (this.id === null) {
      this.addCandidate(p);
    } else if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      if (this.fits(p)) {
        this.add(p); // `pending` was a lone outlier
      } else {
        completed = this.finish();
        this.addCandidate(pending);
        this.addCandidate(p);
      }
    } else if (this.fits(p)) {
      this.add(p);
    } else {
      this.pending = p;
    }

    if (this.id === null && this.n > 0 && this.endT - this.startT >= this.opts.minDurationMs) {
      this.id = this.nextId++;
      this.pts = [];
    }
    return { completed, current: this.current() };
  }

  /** Drops the window in progress (nothing is emitted). Fixation ids keep increasing. */
  reset(): void {
    this.clearWindow();
    this.lastValidT = -Infinity;
    this.lastT = -Infinity;
  }

  private current(): Fixation | null {
    return this.id === null ? null : this.snapshot(this.id);
  }

  private snapshot(id: number): Fixation {
    return {
      id,
      start: this.startT,
      end: this.endT,
      x: this.sumX / this.n,
      y: this.sumY / this.n,
      sampleCount: this.n,
    };
  }

  /** Ends the window; returns it if it had qualified as a fixation. */
  private finish(): Fixation | null {
    const fix = this.id !== null && this.n > 0 ? this.snapshot(this.id) : null;
    this.clearWindow();
    return fix;
  }

  private clearWindow(): void {
    this.pts = [];
    this.n = 0;
    this.sumX = 0;
    this.sumY = 0;
    this.minX = Infinity;
    this.maxX = -Infinity;
    this.minY = Infinity;
    this.maxY = -Infinity;
    this.id = null;
    this.pending = null;
  }

  private fits(p: Pt): boolean {
    const rx = Math.max(this.maxX, p.x) - Math.min(this.minX, p.x);
    const ry = Math.max(this.maxY, p.y) - Math.min(this.minY, p.y);
    return Math.max(rx, ry) <= this.opts.maxDispersionPx;
  }

  private add(p: Pt): void {
    if (this.n === 0) this.startT = p.t;
    this.endT = p.t;
    this.n++;
    this.sumX += p.x;
    this.sumY += p.y;
    if (p.x < this.minX) this.minX = p.x;
    if (p.x > this.maxX) this.maxX = p.x;
    if (p.y < this.minY) this.minY = p.y;
    if (p.y > this.maxY) this.maxY = p.y;
  }

  /** Classic I-DT growth for an unqualified window: slide its start until the dispersion fits. */
  private addCandidate(p: Pt): void {
    this.pts.push(p);
    this.add(p);
    if (this.dispersion() <= this.opts.maxDispersionPx) return;
    let drop = 0;
    while (this.pts.length - drop > 1 && this.rangeOf(drop) > this.opts.maxDispersionPx) drop++;
    this.pts = this.pts.slice(drop);
    this.rebuild();
  }

  private dispersion(): number {
    return Math.max(this.maxX - this.minX, this.maxY - this.minY);
  }

  private rangeOf(from: number): number {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = from; i < this.pts.length; i++) {
      const q = this.pts[i]!;
      if (q.x < x0) x0 = q.x;
      if (q.x > x1) x1 = q.x;
      if (q.y < y0) y0 = q.y;
      if (q.y > y1) y1 = q.y;
    }
    return Math.max(x1 - x0, y1 - y0);
  }

  private rebuild(): void {
    const pts = this.pts;
    this.n = 0;
    this.sumX = 0;
    this.sumY = 0;
    this.minX = Infinity;
    this.maxX = -Infinity;
    this.minY = Infinity;
    this.maxY = -Infinity;
    for (const q of pts) this.add(q);
  }
}

// ───────────────────────────── Saccade classification ─────────────────────────────

/** Used when no layout is known: typical desktop reading metrics. */
export const SACCADE_FALLBACK = Object.freeze({ linePitchPx: 40, columnWidthPx: 640 });

/** Thresholds, as fractions of the column width or multiples of the line pitch. */
const JUMP_DY_LINES = 2.5;
const MAX_FORWARD_COL = 0.6;
const MAX_REGRESSION_COL = 1.0;
const SWEEP_MIN_DX_COL = 0.4;
const SWEEP_START_COL = 0.5;
const SWEEP_LAND_COL = 0.4;
const SWEEP_MAX_RISE_LINES = 0.5;
/** Short-line (paragraph-final) return sweeps: see `isReturnSweep`. */
const SHORT_LINE_COL = 0.7;
const SHORT_SWEEP_START_LINE = 0.6;
const SHORT_SWEEP_LAND_COL = 0.35;
const SHORT_SWEEP_MIN_DY_LINES = 0.3;

interface SaccadeGeometry {
  pitch: number;
  colLeft: number;
  colWidth: number;
  hasColumn: boolean;
}

function geometry(layout: LineLayout | null): SaccadeGeometry {
  const lp = layout?.linePitch;
  const pitch = lp !== undefined && finite(lp) && lp > 0 ? lp : SACCADE_FALLBACK.linePitchPx;
  const c = layout?.column;
  if (c && finite(c.left) && finite(c.right) && c.right - c.left > pitch) {
    return { pitch, colLeft: c.left, colWidth: c.right - c.left, hasColumn: true };
  }
  return { pitch, colLeft: 0, colWidth: SACCADE_FALLBACK.columnWidthPx, hasColumn: false };
}

/**
 * Classifies the saccade between two consecutive fixations.
 *
 * - `return-sweep`: a long leftward move from the right part of the column to
 *   its left part, not strongly upward (the eyes going to the next line).
 * - `regression`: any other leftward move (re-reading).
 * - `forward`: a rightward move of reading size.
 * - `jump`: |dy| > 2.5 lines, or a displacement too large for reading.
 *
 * `line` (optional) is the line the reader is believed to be on. It lets short
 * paragraph-final lines produce return sweeps: from the end of a line that is
 * only a few words long the sweep back is short, so it is recognized by
 * "started near the end of that line, landed at the column start, moved down".
 */
export function classifySaccade(
  prev: Fixation,
  next: Fixation,
  layout: LineLayout | null,
  line?: TextLine | null,
): SaccadeKind {
  const dx = next.x - prev.x;
  const dy = next.y - prev.y;
  if (!finite(dx) || !finite(dy)) return 'jump';
  const g = geometry(layout);
  if (Math.abs(dy) > JUMP_DY_LINES * g.pitch) return 'jump';
  if (dx >= 0) return dx <= MAX_FORWARD_COL * g.colWidth ? 'forward' : 'jump';
  if (isReturnSweep(prev, next, dx, dy, g, line ?? null)) return 'return-sweep';
  return -dx <= MAX_REGRESSION_COL * g.colWidth ? 'regression' : 'jump';
}

function isReturnSweep(
  prev: Fixation,
  next: Fixation,
  dx: number,
  dy: number,
  g: SaccadeGeometry,
  line: TextLine | null,
): boolean {
  if (dy < -SWEEP_MAX_RISE_LINES * g.pitch) return false;
  if (-dx >= SWEEP_MIN_DX_COL * g.colWidth) {
    if (!g.hasColumn) return true;
    if (prev.x >= g.colLeft + SWEEP_START_COL * g.colWidth && next.x <= g.colLeft + SWEEP_LAND_COL * g.colWidth) {
      return true;
    }
  }
  if (!line || !g.hasColumn) return false;
  const w = line.right - line.left;
  if (!(w > 0) || w >= SHORT_LINE_COL * g.colWidth) return false;
  return (
    prev.x >= line.left + SHORT_SWEEP_START_LINE * w &&
    next.x <= g.colLeft + SHORT_SWEEP_LAND_COL * g.colWidth &&
    dy >= SHORT_SWEEP_MIN_DY_LINES * g.pitch
  );
}
