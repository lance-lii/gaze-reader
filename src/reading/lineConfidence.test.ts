import { describe, expect, it } from 'vitest';
import type { LineEstimate } from '../types';
import { DEFAULT_LINE_CONFIDENCE, LineConfidenceWatch } from './lineConfidence';

const FIX_MS = 300;

function estimate(t: number, probability: number, fixationsOnPage: number, lineIndex = 5): LineEstimate {
  return { t, lineIndex, probability, posterior: [], progressX: 0.5, lastSaccade: 'forward', driftY: 0, fixationsOnPage };
}

/** A reader whose fixations come every FIX_MS; `p` gives the tracker's probability at each one. */
class Reader {
  t = 0;
  fixations = 0;
  constructor(readonly w: LineConfidenceWatch) {}

  read(ms: number, p: number | ((t: number) => number)): boolean {
    const until = this.t + ms;
    let unsure = this.w.unsure;
    while (this.t + FIX_MS <= until) {
      this.t += FIX_MS;
      this.fixations++;
      unsure = this.w.push(estimate(this.t, typeof p === 'number' ? p : p(this.t), this.fixations));
    }
    return unsure;
  }

  /** Reading until the watch's answer changes (or `limit` ms): how long that took. */
  until(want: boolean, p: number, limit = 120_000): number {
    const from = this.t;
    while (this.w.unsure !== want && this.t - from < limit) this.read(FIX_MS, p);
    return this.t - from;
  }
}

describe('LineConfidenceWatch', () => {
  it('stays quiet while the tracker is sure of its line', () => {
    const r = new Reader(new LineConfidenceWatch());
    expect(r.read(120_000, 0.95)).toBe(false);
    expect(r.w.smoothed).toBeCloseTo(0.95, 5);
  });

  it('turns unsure after about 10 s of reading below 0.45', () => {
    const r = new Reader(new LineConfidenceWatch());
    r.read(20_000, 0.95);
    const took = r.until(true, 0.2);
    // The smoothing takes 11 fixations (3.3 s) to come down from 0.95, then the 10-s clock runs.
    expect(took).toBeGreaterThanOrEqual(DEFAULT_LINE_CONFIDENCE.enterAfterMs);
    expect(took).toBeLessThanOrEqual(DEFAULT_LINE_CONFIDENCE.enterAfterMs + 4_000);
  });

  it('rides out a few unsure seconds, such as the fixations after a page turn', () => {
    const r = new Reader(new LineConfidenceWatch());
    r.read(20_000, 0.95);
    for (let i = 0; i < 20; i++) {
      expect(r.read(5_000, 0.15)).toBe(false);
      expect(r.read(25_000, 0.95)).toBe(false);
    }
  });

  it('holds between the thresholds: neither sure enough to clear nor unsure enough to set', () => {
    const r = new Reader(new LineConfidenceWatch());
    expect(r.read(60_000, 0.5)).toBe(false);
    r.read(20_000, 0.2);
    expect(r.w.unsure).toBe(true);
    expect(r.read(120_000, 0.55)).toBe(true);
  });

  it('stays shown at least 15 s, and clears after 5 s back above 0.6', () => {
    const r = new Reader(new LineConfidenceWatch());
    r.until(true, 0.2);
    // Recovered at once (a calibration-like jump): the smoothing climbs past 0.6 within 3 fixations.
    const took = r.until(false, 0.99);
    expect(took).toBeGreaterThanOrEqual(DEFAULT_LINE_CONFIDENCE.minShownMs);
    expect(took).toBeLessThanOrEqual(DEFAULT_LINE_CONFIDENCE.minShownMs + 1_000);
    // After a long stretch shown, the 5 s back above 0.6 decide.
    r.until(true, 0.2);
    r.read(60_000, 0.2);
    const after = r.until(false, 0.99);
    expect(after).toBeGreaterThanOrEqual(DEFAULT_LINE_CONFIDENCE.exitAfterMs);
    expect(after).toBeLessThanOrEqual(DEFAULT_LINE_CONFIDENCE.exitAfterMs + 2_000);
  });

  it('runs its clocks on reading time: a pause or a look away holds the state', () => {
    const w = new LineConfidenceWatch();
    const r = new Reader(w);
    r.read(8_000, 0.2); // 7.7 s of it below 0.45: not yet
    expect(w.unsure).toBe(false);
    r.t += 60_000; // away, no fixations
    // The step across the pause counts as 1 s at most: 8.7 s so far, a fixation or a few still short of 10.
    expect(r.read(FIX_MS, 0.2)).toBe(false);
    expect(r.until(true, 0.2)).toBeLessThanOrEqual(2_000);
    // Shown, then away for a minute: still shown, and the minimum time shown isn't used up by the pause.
    r.t += 60_000;
    expect(r.read(FIX_MS, 0.99)).toBe(true);
    expect(r.until(false, 0.99)).toBeGreaterThanOrEqual(DEFAULT_LINE_CONFIDENCE.minShownMs - 2_000);
  });

  it('ignores excursions (the fixation count stays put) and estimates without a line', () => {
    const w = new LineConfidenceWatch();
    const r = new Reader(w);
    r.read(20_000, 0.95);
    // Looks at the keyboard: the tracker publishes the same count, with whatever probability.
    for (let i = 0; i < 200; i++) w.push(estimate(r.t + 300 * i, 0.01, r.fixations));
    expect(w.smoothed).toBeCloseTo(0.95, 5);
    for (let i = 1; i <= 200; i++) w.push(estimate(r.t + 300 * i, 0.01, r.fixations + i, -1));
    w.push(estimate(Number.NaN, 0.01, r.fixations + 500));
    w.push(estimate(r.t + 1, Number.NaN, r.fixations + 501));
    expect(w.smoothed).toBeCloseTo(0.95, 5);
    expect(w.unsure).toBe(false);
  });

  it('counts the first fixation of a new page (its count starts over)', () => {
    const w = new LineConfidenceWatch();
    w.push(estimate(0, 0.9, 40));
    w.push(estimate(300, 0.1, 1));
    expect(w.smoothed).toBeCloseTo(0.9 + 0.1 * (0.1 - 0.9), 5);
  });

  it('starts over on reset', () => {
    const r = new Reader(new LineConfidenceWatch());
    r.until(true, 0.2);
    r.w.reset();
    expect(r.w.unsure).toBe(false);
    expect(r.w.smoothed).toBeNull();
    expect(r.read(5_000, 0.2)).toBe(false);
  });
});
