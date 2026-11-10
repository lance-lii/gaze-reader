import type { LineEstimate } from '../types';

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export interface LineConfidenceOptions {
  /** Weight of the newest fixation in the smoothed line probability (an EMA over reading fixations). */
  weight: number;
  /** The smoothed probability below this… */
  enter: number;
  /** …for this much reading time (ms) → unsure. */
  enterAfterMs: number;
  /** It clears once back at or above this… */
  exit: number;
  /** …for this much reading time (ms), and once it has been shown for at least `minShownMs`. */
  exitAfterMs: number;
  minShownMs: number;
  /** Reading time between two fixations counts as at most this (ms): a pause doesn't run the clocks. */
  maxStepMs: number;
}

export const DEFAULT_LINE_CONFIDENCE: Readonly<LineConfidenceOptions> = Object.freeze({
  weight: 0.1,
  enter: 0.45,
  enterAfterMs: 10_000,
  exit: 0.6,
  exitAfterMs: 5_000,
  minShownMs: 15_000,
  maxStepMs: 1_000,
});

/**
 * Whether the line tracker knows which line the reader is on, for the status pill: unsure once its
 * probability for its own line, smoothed over reading fixations, has stayed under 0.45 for about
 * 10 s of reading. Rule 1 of the page-end detector needs the tracker sure of the last line, so
 * while this is set pages turn mostly on the fallback rules (later), or by hand.
 *
 * The tracker's probability is honest: in the end-to-end simulator (bench/endtoend) fixations it
 * gives ≥ 0.8 are on the right line 94–97 % of the time in clean light and everyday reading, those
 * under 0.4 only 14–46 % of the time. A single unsure fixation means little (a page turn re-learns the offset, a return
 * sweep can land between lines), so it takes a stretch, and the state is sticky both ways: shown
 * for at least 15 s, cleared after 5 s back above 0.6. On seeds it wasn't tuned on (1–3, an hour
 * a scenario: bench/reading/lineTracker) that shows it 1 % of the time in clean light and in
 * everyday reading (about twice an hour), 88 % of the time with a noisy webcam (on the right line
 * there 19 %), 47 % in dim light; 93 % of the pages missed with the noisy webcam, and 56 % of all
 * missed pages, were missed while it was shown. Weight, thresholds and times were chosen on seeds 11–14.
 *
 * Only fixations that moved the tracker count (excursions, such as a look at the keyboard, leave
 * `fixationsOnPage` as it was), and the clocks run on reading time: a pause or a look away holds
 * the state rather than running it out.
 */
export class LineConfidenceWatch {
  private readonly o: LineConfidenceOptions;
  private smoothedP: number | null = null;
  private lastFixations = -1;
  private lastT: number | null = null;
  private shown = false;
  /** Reading time below `enter` (while not shown), at or above `exit` and shown (while shown). */
  private lowMs = 0;
  private highMs = 0;
  private shownMs = 0;

  constructor(opts: Partial<LineConfidenceOptions> = {}) {
    this.o = { ...DEFAULT_LINE_CONFIDENCE, ...opts };
  }

  /** Feeds the estimate of a completed fixation; returns whether the tracker is unsure now. */
  push(e: LineEstimate): boolean {
    if (!Number.isFinite(e.t) || !Number.isFinite(e.probability) || e.lineIndex < 0) return this.shown;
    // The tracker counts the fixations that moved it; an excursion leaves the count as it was.
    if (e.fixationsOnPage === this.lastFixations) return this.shown;
    this.lastFixations = e.fixationsOnPage;
    const step = this.lastT === null ? 0 : Math.min(this.o.maxStepMs, Math.max(0, e.t - this.lastT));
    this.lastT = e.t;
    const p = clamp01(e.probability);
    const s = this.smoothedP === null ? p : this.smoothedP + this.o.weight * (p - this.smoothedP);
    this.smoothedP = s;
    if (!this.shown) {
      this.lowMs = s < this.o.enter ? this.lowMs + step : 0;
      if (s < this.o.enter && this.lowMs >= this.o.enterAfterMs) {
        this.shown = true;
        this.shownMs = 0;
        this.highMs = 0;
      }
    } else {
      this.shownMs += step;
      this.highMs = s >= this.o.exit ? this.highMs + step : 0;
      if (s >= this.o.exit && this.highMs >= this.o.exitAfterMs && this.shownMs >= this.o.minShownMs) {
        this.shown = false;
        this.lowMs = 0;
      }
    }
    return this.shown;
  }

  get unsure(): boolean {
    return this.shown;
  }

  /** The smoothed line probability, or null before the first reading fixation. */
  get smoothed(): number | null {
    return this.smoothedP;
  }

  /** A new source, calibration or book: the confidence starts over (not unsure). */
  reset(): void {
    this.smoothedP = null;
    this.lastFixations = -1;
    this.lastT = null;
    this.shown = false;
    this.lowMs = 0;
    this.highMs = 0;
    this.shownMs = 0;
  }
}
