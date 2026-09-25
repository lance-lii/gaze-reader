import { describe, expect, it } from 'vitest';
import type { Fixation, GazeSample, LineEstimate, LineLayout } from '../types';
import { FixationDetector } from '../signal/fixations';
import {
  DEFAULT_LINE_TRACKER_OPTIONS,
  LINE_TRANSITIONS,
  LineTracker,
  isTrackedLineEstimate,
  type TrackedLineEstimate,
} from './lineTracker';
import { gaussian, mulberry32, simulateReading } from './simulatedReader';
import { lastFullyVisibleIndex, makeDocument, makeReadingPage } from './testLayouts';

let fixId = 0;
function fix(t: number, x: number, y: number): Fixation {
  return { id: ++fixId, start: t, end: t + 220, x, y, sampleCount: 7 };
}

/**
 * Idealized reading fixations over lines [from, to]: 8 per line, then a return sweep.
 * `offsetPx`/`dxPx`: a constant gaze bias; `step`: the vertical bias changes by `px` from the
 * `after`-th fixation on (mid-line, like a light switched on). `t` is when the next fixation would start.
 */
function readLines(
  layout: LineLayout,
  from: number,
  to: number,
  opts: { offsetPx?: number; dxPx?: number; jitterPx?: number; seed?: number; t0?: number; step?: { after: number; px: number } } = {},
): { fixations: Fixation[]; truth: number[]; t: number } {
  const rng = mulberry32(opts.seed ?? 1);
  const fixations: Fixation[] = [];
  const truth: number[] = [];
  let t = opts.t0 ?? 0;
  for (let i = from; i <= to; i++) {
    const l = layout.lines[i]!;
    const n = Math.max(2, Math.round(((l.right - l.left) / 700) * 8));
    for (let k = 0; k < n; k++) {
      const x = l.left + ((k + 0.4) / n) * (l.right - l.left) + (opts.dxPx ?? 0);
      const stepPx = opts.step && fixations.length >= opts.step.after ? opts.step.px : 0;
      const y = l.centerY + (opts.offsetPx ?? 0) + stepPx + (opts.jitterPx ?? 0) * gaussian(rng);
      fixations.push(fix(t, x, y));
      truth.push(i);
      t += 260;
    }
  }
  return { fixations, truth, t };
}

function accuracy(tracker: LineTracker, fixations: Fixation[], truth: number[]): number {
  let ok = 0;
  fixations.forEach((f, i) => {
    if (tracker.onFixation(f).lineIndex === truth[i]) ok++;
  });
  return ok / fixations.length;
}

function truthAt(truth: { t: number; lineIndex: number }[], t: number): number {
  let lo = 0;
  let hi = truth.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (truth[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  return truth[lo]!.lineIndex;
}

/** Line accuracy of FixationDetector → LineTracker over one simulated page. */
function simulatedAccuracy(seed: number, noiseLines: number, driftLines: number, onset: 'gradual' | 'immediate'): number {
  const layout = makeReadingPage(seed);
  const pitch = layout.linePitch;
  const sim = simulateReading(layout, { seed, noisePx: noiseLines * pitch, driftPx: driftLines * pitch, driftOnset: onset, lingerMs: 0 });
  const det = new FixationDetector();
  const tracker = new LineTracker();
  tracker.setLayout(layout, 'initial');
  let ok = 0;
  let n = 0;
  for (const s of sim.samples) {
    const r = det.push(s);
    if (r.completed) {
      const est = tracker.onFixation(r.completed);
      n++;
      if (est.lineIndex === truthAt(sim.truth, (r.completed.start + r.completed.end) / 2)) ok++;
    }
    tracker.onSample(s);
  }
  return ok / n;
}

describe('LineTracker', () => {
  const doc = makeDocument({ lines: 60, seed: 4 });
  const viewport = { left: 0, top: 0, right: 1024, bottom: 20.5 * 42 };
  const page = doc.layoutAt(0, { viewport });
  const pitch = page.linePitch;
  const L = lastFullyVisibleIndex(page);

  it('tracks clean reading line by line', () => {
    const tracker = new LineTracker();
    tracker.setLayout(page, 'initial');
    const { fixations, truth } = readLines(page, 0, L);
    expect(accuracy(tracker, fixations, truth)).toBeGreaterThan(0.98);
    const est = tracker.estimate!;
    expect(est.lineIndex).toBe(L);
    expect(est.fixationsOnPage).toBe(fixations.length);
    expect(est.progressX).toBeGreaterThan(0.8);
  });

  it('keeps ≥ 80 % of fixations on the true line with σ = 0.75 pitch noise and 0.5-pitch drift (required)', () => {
    const accs = Array.from({ length: 20 }, (_, i) => simulatedAccuracy(i + 1, 0.75, 0.5, 'gradual'));
    const mean = accs.reduce((a, b) => a + b, 0) / accs.length;
    expect(Math.min(...accs)).toBeGreaterThanOrEqual(0.8);
    expect(mean).toBeGreaterThan(0.95);
  });

  it('copes with a half-line calibration bias present from the first fixation', () => {
    const accs = Array.from({ length: 20 }, (_, i) => simulatedAccuracy(i + 1, 0.75, 0.5, 'immediate'));
    expect(accs.reduce((a, b) => a + b, 0) / accs.length).toBeGreaterThan(0.9);
  });

  it('learns a vertical drift and reports it without touching the gaze', () => {
    const tracker = new LineTracker();
    tracker.setLayout(page, 'initial');
    const offset = 0.45 * pitch;
    const { fixations, truth } = readLines(page, 0, 12, { offsetPx: offset, jitterPx: 0.15 * pitch, seed: 3 });
    const acc = accuracy(tracker, fixations, truth);
    expect(acc).toBeGreaterThan(0.9);
    expect(tracker.estimate!.driftY).toBeGreaterThan(offset - 0.15 * pitch);
    expect(tracker.estimate!.driftY).toBeLessThan(offset + 0.15 * pitch);
  });

  it('adapts σ_y to the residuals and reports it', () => {
    const tracker = new LineTracker();
    tracker.setLayout(page, 'initial');
    const e0 = tracker.onFixation(fix(0, 250, page.lines[0]!.centerY));
    expect(isTrackedLineEstimate(e0)).toBe(true);
    if (!isTrackedLineEstimate(e0)) return;
    expect(e0.sigmaYPx).toBeCloseTo(DEFAULT_LINE_TRACKER_OPTIONS.sigmaYLines * pitch, 0);
    // Precise vertical gaze: σ shrinks steadily (conservatively, from 0.9 lines) towards the 0.4-line floor.
    const sigmas: number[] = [];
    for (let pass = 0; pass < 3; pass++) {
      tracker.setLayout(page, 'content');
      readLines(page, 0, L, { jitterPx: 0.05 * pitch, seed: pass + 1, t0: pass * 1e6 }).fixations.forEach((f) => tracker.onFixation(f));
      const e = tracker.estimate;
      if (isTrackedLineEstimate(e)) sigmas.push(e.sigmaYPx / pitch);
    }
    expect(sigmas[0]!).toBeLessThan(0.75);
    expect(sigmas[1]!).toBeLessThanOrEqual(sigmas[0]!);
    expect(sigmas[2]!).toBeLessThan(0.5);
    expect(sigmas[2]!).toBeGreaterThanOrEqual(0.4 - 1e-9);
  });

  it('publishes a normalized posterior over the whole layout, zero on unreadable lines', () => {
    const layout = makeReadingPage(5);
    const tracker = new LineTracker();
    tracker.setLayout(layout, 'initial');
    const est = tracker.onFixation(fix(0, 300, layout.lines[2]!.centerY));
    expect(est.posterior).toHaveLength(layout.lines.length);
    expect(est.posterior.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    const cut = lastFullyVisibleIndex(layout) + 1;
    expect(layout.lines[cut]!.fullyVisible).toBe(false);
    expect(est.posterior[cut]).toBe(0);
    expect(est.lineIndex).toBe(2);
  });

  it('carries the posterior across a scroll by matching docTop', () => {
    const tracker = new LineTracker();
    tracker.setLayout(page, 'initial');
    const { fixations } = readLines(page, 0, 8);
    fixations.forEach((f) => tracker.onFixation(f));
    const before = tracker.estimate!;
    const docTop = page.lines[before.lineIndex]!.docTop;
    const scrolled = doc.layoutAt(3 * pitch, { viewport });
    tracker.setLayout(scrolled, 'scroll');
    const after = tracker.estimate!;
    expect(after.posterior).toHaveLength(scrolled.lines.length);
    expect(scrolled.lines[after.lineIndex]!.docTop).toBe(docTop);
    expect(after.probability).toBeGreaterThan(0.8 * before.probability);
    // The last fixation was shifted with the text, so the next one reads as "forward", not a jump.
    const line = scrolled.lines[after.lineIndex]!;
    const next = tracker.onFixation(fix(9000, line.right - 40, line.centerY));
    expect(next.lastSaccade).toBe('forward');
    expect(next.lineIndex).toBe(after.lineIndex);
  });

  it('concentrates the prior on the resume line after a page turn', () => {
    const tracker = new LineTracker();
    tracker.setLayout(page, 'initial');
    readLines(page, 0, L).fixations.forEach((f) => tracker.onFixation(f));
    const next = doc.layoutAt(page.lines[L]!.docTop - 0.35 * pitch, { viewport });
    tracker.setLayout(next, 'page-turn');
    // Like the controller: resume at the first line below the one anchored at the top.
    const resume = next.lines.findIndex((l) => l.docTop > page.lines[L]!.docTop);
    expect(next.lines[resume]!.fullyVisible).toBe(true);
    tracker.afterPageTurn(resume);
    const est = tracker.estimate!;
    expect(est.lineIndex).toBe(resume);
    expect(est.probability).toBeGreaterThan(0.65);
    expect(est.posterior[resume + 1]!).toBeGreaterThan(est.posterior[resume + 3]!);
    expect(est.fixationsOnPage).toBe(0);
    expect(est.lastSaccade).toBeNull();
    // Reading resumes there.
    const { fixations, truth } = readLines(next, resume, resume + 6, { t0: 100_000 });
    expect(accuracy(tracker, fixations, truth)).toBeGreaterThan(0.95);
  });

  it('ignores looks away from the text and resumes where the reader was', () => {
    const tracker = new LineTracker();
    tracker.setLayout(page, 'initial');
    readLines(page, 0, 5).fixations.forEach((f) => tracker.onFixation(f));
    const before = tracker.estimate!;
    const away = tracker.onFixation(fix(50_000, 500, page.lines[L]!.centerY + 6 * pitch));
    expect(away.posterior).toBe(before.posterior);
    expect(away.fixationsOnPage).toBe(before.fixationsOnPage);
    expect(isTrackedLineEstimate(away) && away.excursions).toBe(1);
    const sideways = tracker.onFixation(fix(50_300, 1020, page.lines[5]!.centerY));
    expect(sideways.posterior).toBe(before.posterior);
    const back = tracker.onFixation(fix(50_600, 700, page.lines[5]!.centerY));
    expect(back.lineIndex).toBe(5);
    expect(back.lastSaccade).not.toBe('jump');
  });

  it('keeps the reader on the last line when they look for a next line that is not there', () => {
    const tracker = new LineTracker();
    tracker.setLayout(page, 'initial');
    readLines(page, 0, L).fixations.forEach((f) => tracker.onFixation(f));
    const last = page.lines[L]!;
    const glance = tracker.onFixation(fix(90_000, 200, last.centerY + 0.8 * pitch));
    expect(glance.lastSaccade).toBe('return-sweep');
    expect(glance.lineIndex).toBe(L);
    expect(glance.probability).toBeGreaterThan(0.6);
  });

  it('uses horizontal extent to tell a short paragraph-final line from the next one', () => {
    const d = makeDocument({ lines: 10, paragraphLines: [3, 3], paragraphGap: 0, shortLineFraction: [0.25, 0.25], seed: 2 });
    const layout = d.layoutAt(0);
    const short = layout.lines[2]!;
    expect(short.right - short.left).toBeLessThan(200);
    const tracker = new LineTracker();
    tracker.setLayout(layout, 'initial');
    const between = (short.centerY + layout.lines[3]!.centerY) / 2;
    const est = tracker.onFixation(fix(0, 780, between));
    expect(est.posterior[3]!).toBeGreaterThan(3 * est.posterior[2]!);
  });

  it('updates progressX from live samples', () => {
    const tracker = new LineTracker();
    tracker.setLayout(page, 'initial');
    const sample = (x: number, valid = true): GazeSample => ({ t: 5, x, y: 20, rawX: x, rawY: 20, valid, confidence: 1, source: 'mouse' });
    expect(tracker.onSample(sample(400))).toBeNull(); // nothing to update before the first fixation
    tracker.onFixation(fix(0, 250, page.lines[0]!.centerY));
    const line = page.lines[0]!;
    expect(tracker.onSample(sample(line.left + 0.5 * (line.right - line.left)))!.progressX).toBeCloseTo(0.5, 6);
    expect(tracker.onSample(sample(5000))!.progressX).toBe(1);
    expect(tracker.onSample(sample(-50))!.progressX).toBe(0);
    expect(tracker.onSample(sample(400, false))).toBeNull();
    expect(tracker.onSample(sample(NaN))).toBeNull();
  });

  it('degrades gracefully without a usable layout or with bad input', () => {
    const tracker = new LineTracker();
    const e1 = tracker.onFixation(fix(0, 100, 100));
    expect(e1.lineIndex).toBe(-1);
    expect(e1.posterior).toEqual([]);
    tracker.afterPageTurn(3);
    const empty = makeDocument({ lines: 0 }).layoutAt(0);
    tracker.setLayout(empty, 'initial');
    expect(tracker.onFixation(fix(1, 100, 100)).lineIndex).toBe(-1);
    tracker.setLayout(page, 'content');
    const e2 = tracker.onFixation(fix(2, NaN, 100));
    expect(e2.lineIndex).toBeGreaterThanOrEqual(-1);
    expect(tracker.onFixation(fix(3, 300, page.lines[4]!.centerY)).lineIndex).toBe(4);
    tracker.reset();
    expect(tracker.estimate).toBeNull();
    const e3 = tracker.onFixation(fix(4, 300, page.lines[0]!.centerY));
    expect(e3.driftY).toBeCloseTo(0, 0);
    expect(e3.fixationsOnPage).toBe(1);
  });

  it('never leaks NaN from degenerate layouts (zero-height viewport, missing pitch)', () => {
    const tracker = new LineTracker();
    tracker.setLayout(doc.layoutAt(0, { viewport: { left: 0, top: 0, right: 1024, bottom: 0 } }), 'initial');
    expect(tracker.onFixation(fix(0, 300, 100)).lineIndex).toBe(-1);
    const noPitch: LineLayout = { ...page, linePitch: NaN };
    tracker.setLayout(noPitch, 'content');
    const est = tracker.onFixation(fix(1, 300, page.lines[2]!.centerY));
    expect(est.lineIndex).toBe(2);
    expect(Number.isFinite(est.driftY)).toBe(true);
    expect(est.posterior.every(Number.isFinite)).toBe(true);
    expect(isTrackedLineEstimate(est) && Number.isFinite(est.sigmaYPx)).toBe(true);
  });

  it('still tracks when the layout has no usable column box', () => {
    const tracker = new LineTracker();
    const nan = { left: NaN, top: NaN, right: NaN, bottom: NaN };
    tracker.setLayout({ ...page, column: nan }, 'initial');
    const { fixations, truth } = readLines(page, 0, L);
    // Before: every update produced NaN, re-seeded the prior and reported line 0 forever.
    expect(accuracy(tracker, fixations, truth)).toBeGreaterThan(0.95);
    // Looks far beside the text are still recognized as excursions.
    const before = tracker.estimate!;
    const away = tracker.onFixation(fix(9e5, 5000, page.lines[L]!.centerY));
    expect(away.posterior).toBe(before.posterior);
  });

  it('clamps options to sane ranges', () => {
    const tracker = new LineTracker({ sigmaYLines: 50, driftRate: -1, maxDriftLines: NaN });
    tracker.setLayout(page, 'initial');
    expect(tracker.sigmaYPx).toBeCloseTo(3 * pitch, 6);
    const est = tracker.onFixation(fix(0, 300, page.lines[3]!.centerY));
    expect(est.lineIndex).toBeGreaterThanOrEqual(0);
    expect(isTrackedLineEstimate(est) && est.sigmaYPx).toBeLessThanOrEqual(3 * pitch);
  });
});

/**
 * Light moves webcam gaze by several lines (a squint in bright light reads low, wide eyes in
 * dim light read high). Gaze Reader 1.0 modelled ±1.5 lines and locked onto the wrong line
 * beyond that; bench/reading/offsets.bench.test.ts has the full scoreboard.
 */
describe('LineTracker under large gaze offsets (lighting)', () => {
  const doc = makeDocument({ lines: 60, seed: 4 });
  const viewport = { left: 0, top: 0, right: 1024, bottom: 20.5 * 42 };
  const page = doc.layoutAt(0, { viewport });
  const pitch = page.linePitch;
  const L = lastFullyVisibleIndex(page);
  const lines = (e: { driftY: number }): number => e.driftY / pitch;
  /** The next page, as the controller turns it: the last line read goes to the top. */
  const turn = (tracker: LineTracker): { next: LineLayout; resume: number } => {
    const next = doc.layoutAt(page.lines[L]!.docTop - 0.35 * pitch, { viewport });
    tracker.setLayout(next, 'page-turn');
    const resume = next.lines.findIndex((l) => l.docTop > page.lines[L]!.docTop);
    tracker.afterPageTurn(resume);
    return { next, resume };
  };

  it('models ±5 lines of drift, on a grid of at most 81 bins', () => {
    expect(DEFAULT_LINE_TRACKER_OPTIONS.maxDriftLines).toBe(5);
    for (const offset of [-4, 4]) {
      const tracker = new LineTracker();
      tracker.setLayout(page, 'initial');
      const { fixations, truth } = readLines(page, 0, L, { offsetPx: offset * pitch, jitterPx: 0.15 * pitch, seed: 3 });
      const acc = accuracy(tracker, fixations, truth);
      // Gaze reading high is anchored by the top of the page at once; gaze reading low only shows
      // at the bottom of a fresh page (1.0: 6 % and 5 %, locked 2–3 lines off with drift ≈ ±1.3).
      expect(acc, `offset ${offset}`).toBeGreaterThan(offset < 0 ? 0.95 : 0.6);
      expect(lines(tracker.estimate!)).toBeCloseTo(offset, 0);
      expect(tracker.estimate!.lineIndex).toBe(L);
    }
  });

  it('re-anchors the drift at a page turn: a bias that changed between pages is learned on the resume line', () => {
    const tracker = new LineTracker();
    tracker.setLayout(page, 'initial');
    readLines(page, 0, L, { jitterPx: 0.1 * pitch }).fixations.forEach((f) => tracker.onFixation(f));
    expect(Math.abs(lines(tracker.estimate!))).toBeLessThan(0.2);
    const { next, resume } = turn(tracker);
    // The turn itself widens the drift belief (half of it uniform) around a known line.
    const e0 = tracker.estimate;
    expect(isTrackedLineEstimate(e0) && (e0.driftHighY! - e0.driftLowY!) / pitch).toBeGreaterThan(6);
    const { fixations, truth } = readLines(next, resume, resume + 6, { offsetPx: 2 * pitch, jitterPx: 0.1 * pitch, t0: 100_000 });
    // 1.0 kept the old drift belief: every one of these fixations landed 2 lines low.
    expect(accuracy(tracker, fixations.slice(0, 8), truth.slice(0, 8))).toBeGreaterThanOrEqual(0.875);
    expect(accuracy(tracker, fixations.slice(8), truth.slice(8))).toBe(1);
    expect(lines(tracker.estimate!)).toBeCloseTo(2, 0);
  });

  it('keeps the line and re-learns the drift when the camera reports an appearance change', () => {
    const run = (report: boolean): { first: ReturnType<LineTracker['onFixation']>; rest: number; drift: number } => {
      const tracker = new LineTracker();
      tracker.setLayout(page, 'initial');
      const before = readLines(page, 0, 8, { jitterPx: 0.1 * pitch });
      before.fixations.forEach((f) => tracker.onFixation(f));
      // A light is switched on as the reader sweeps to line 9: gaze now reads 3 lines low.
      if (report) tracker.appearanceChangedAt(before.t);
      const after = readLines(page, 9, L - 2, { offsetPx: 3 * pitch, jitterPx: 0.1 * pitch, t0: before.t });
      const first = tracker.onFixation(after.fixations[0]!);
      const rest = accuracy(tracker, after.fixations.slice(1), after.truth.slice(1));
      return { first, rest, drift: lines(tracker.estimate!) };
    };
    const reported = run(true);
    expect(reported.first.lineIndex).toBe(9);
    // The vertical step belongs to the sensor: the saccade is judged on dx (a sweep, not a jump).
    expect(reported.first.lastSaccade).toBe('return-sweep');
    expect(reported.rest).toBeGreaterThan(0.95);
    expect(reported.drift).toBeCloseTo(3, 0);
    // Unreported, the same change reads as a jump 3 lines down (the page would turn 3 lines early).
    const unreported = run(false);
    expect(unreported.first.lineIndex).toBe(12);
    expect(unreported.rest).toBeLessThan(0.5);
  });

  it('applies an appearance change from the first fixation that starts at or after its time', () => {
    const tracker = new LineTracker();
    tracker.setLayout(page, 'initial');
    const { fixations, t } = readLines(page, 0, 4, { jitterPx: 0.05 * pitch });
    fixations.forEach((f) => tracker.onFixation(f));
    const x = page.lines[5]!.left + 100;
    tracker.onFixation(fix(t, x, page.lines[5]!.centerY));
    tracker.appearanceChangedAt(t + 1000);
    // Starts before the change: its 3-line drop is the eyes' (a jump).
    const early = tracker.onFixation({ ...fix(t + 900, x + 80, page.lines[5]!.centerY + 3 * pitch) });
    expect(early.lastSaccade).toBe('jump');
    // Starts after it: judged on dx alone, and the drift belief is mostly uniform again.
    const late = tracker.onFixation(fix(t + 1200, x + 160, page.lines[5]!.centerY + 3 * pitch));
    expect(late.lastSaccade).toBe('forward');
    expect(isTrackedLineEstimate(late) && isTrackedLineEstimate(early) && late.driftSdY! > early.driftSdY!).toBe(true);
    // Applied once: the next 3-line drop is the eyes' again.
    expect(tracker.onFixation(fix(t + 1500, x + 240, page.lines[5]!.centerY + 6 * pitch)).lastSaccade).toBe('jump');
  });

  it('shrugs off a spurious appearance change', () => {
    const tracker = new LineTracker();
    tracker.setLayout(page, 'initial');
    const before = readLines(page, 0, 8, { jitterPx: 0.1 * pitch });
    before.fixations.forEach((f) => tracker.onFixation(f));
    tracker.appearanceChangedAt(before.t);
    const { fixations, truth } = readLines(page, 9, L, { jitterPx: 0.1 * pitch, t0: before.t });
    expect(accuracy(tracker, fixations, truth)).toBeGreaterThan(0.97);
    expect(Math.abs(lines(tracker.estimate!))).toBeLessThan(0.2);
  });

  it('keeps the learned drift across reset({ keepDrift: true }) (another book, same calibration)', () => {
    const run = (keepDrift: boolean): { first: number; truth: number; rest: number } => {
      const tracker = new LineTracker();
      tracker.setLayout(page, 'initial');
      readLines(page, 0, L, { offsetPx: 3 * pitch, jitterPx: 0.1 * pitch }).fixations.forEach((f) => tracker.onFixation(f));
      expect(lines(tracker.estimate!)).toBeCloseTo(3, 0);
      tracker.reset({ keepDrift });
      expect(tracker.estimate).toBeNull();
      const other = doc.layoutAt(20 * pitch, { viewport });
      tracker.setLayout(other, 'initial');
      const top = other.lines.findIndex((l) => l.fullyVisible);
      const { fixations, truth } = readLines(other, top, top + 5, { offsetPx: 3 * pitch, jitterPx: 0.1 * pitch, t0: 1e6 });
      const first = tracker.onFixation(fixations[0]!).lineIndex;
      return { first, truth: truth[0]!, rest: accuracy(tracker, fixations.slice(1), truth.slice(1)) };
    };
    const kept = run(true);
    expect(kept.first).toBe(kept.truth);
    expect(kept.rest).toBeGreaterThan(0.95);
    // A full reset starts from "calibration is about right": the same page starts 3 lines off.
    const fresh = run(false);
    expect(fresh.first).toBe(fresh.truth + 3);
  });

  it('reads a mid-line downward step of the gaze bias partly as the sensor, even unreported', () => {
    const tracker = new LineTracker();
    tracker.setLayout(page, 'initial');
    const before = readLines(page, 0, 10, { jitterPx: 0.1 * pitch });
    before.fixations.forEach((f) => tracker.onFixation(f));
    // 3 lines down after the 4th fixation of line 11, the eyes still moving along it.
    const { fixations, truth } = readLines(page, 11, 15, { jitterPx: 0.1 * pitch, t0: before.t, step: { after: 4, px: 3 * pitch } });
    expect(accuracy(tracker, fixations, truth)).toBeGreaterThan(0.9); // 1.0: 11 %
    expect(lines(tracker.estimate!)).toBeCloseTo(3, 0);
  });

  it('takes a downward jump for a possible bias step only when it would land on the text', () => {
    const glanceFrom = (row: number): { glance: ReturnType<LineTracker['onFixation']>; back: ReturnType<LineTracker['onFixation']> } => {
      const tracker = new LineTracker();
      tracker.setLayout(page, 'initial');
      const { fixations, t } = readLines(page, 0, row, { jitterPx: 0.05 * pitch });
      fixations.forEach((f) => tracker.onFixation(f));
      const l = page.lines[row]!;
      const before = isTrackedLineEstimate(tracker.estimate) ? tracker.estimate.excursions : NaN;
      // 2.6 lines straight down (little dx), then straight back.
      const glance = tracker.onFixation(fix(t, l.right - 40, l.centerY + 2.6 * pitch));
      expect(glance.lastSaccade).toBe('jump');
      expect(isTrackedLineEstimate(glance) && glance.excursions).toBe(before); // judged, not an excursion
      let back = glance;
      for (let k = 0; k < 4; k++) back = tracker.onFixation(fix(t + 300 * (k + 1), l.right - 30 + 5 * k, l.centerY));
      return { glance, back };
    };
    // Mid-page, the jump lands on text: it may be the bias stepping (a light switched on)...
    const mid = glanceFrom(5);
    expect(mid.glance.lineIndex).toBe(5);
    expect(lines(mid.glance)).toBeCloseTo(2.6, 0);
    // ...and the look back shows it wasn't.
    expect(mid.back.lineIndex).toBe(5);
    expect(Math.abs(lines(mid.back))).toBeLessThan(0.3);
    // From the second-last line it would land past the last line: a look below the page (lingering,
    // the glance-down gesture), never a bias step — or the looks back at the last line would read
    // as the reader 2.6 lines higher, and the page would never turn.
    const low = glanceFrom(L - 1);
    expect(Math.abs(lines(low.glance))).toBeLessThan(1);
    expect(low.glance.posterior[L - 1]!).toBeLessThan(0.5);
    expect(low.back.lineIndex).toBe(L - 1);
  });

  it('takes a look away and straight back for an excursion, even when the look landed on the text', () => {
    const tracker = new LineTracker();
    tracker.setLayout(page, 'initial');
    const { fixations, t } = readLines(page, 0, L - 1, { jitterPx: 0.05 * pitch });
    fixations.forEach((f) => tracker.onFixation(f));
    const l = page.lines[L - 1]!;
    const excursions = (): number => (isTrackedLineEstimate(tracker.estimate) ? tracker.estimate.excursions : NaN);
    const before = excursions();
    // Near the end of the page the reader keeps glancing below it and back. Each glance alone is
    // "on the text" for the tracker; repeated, they used to pull the drift towards explaining them
    // (1.0 ended a line off with 1.1 lines of drift, the ±5-line range 3 lines off).
    let e = tracker.estimate!;
    for (let k = 0; k < 4; k++) {
      expect(tracker.onFixation(fix(t + 600 * k, l.right - 40 - 5 * k, l.centerY + 2.6 * pitch)).lastSaccade).toBe('jump');
      e = tracker.onFixation(fix(t + 600 * k + 300, l.right - 30, l.centerY));
      expect(e.lastSaccade).not.toBe('jump'); // measured from where the eyes left
    }
    expect(excursions()).toBe(before + 4);
    expect(e.lineIndex).toBe(L - 1);
    expect(Math.abs(lines(e))).toBeLessThan(0.3);
    // Not coming back (reading on down there) is not a glance.
    const r = readLines(page, L, L, { t0: t + 3000 });
    const after = r.fixations.map((f) => tracker.onFixation(f)).at(-1)!;
    expect(after.lineIndex).toBe(L);
    expect(excursions()).toBe(before + 4);
  });

  it('does not count reading under a large, not yet learned offset as looking away', () => {
    const tracker = new LineTracker();
    tracker.setLayout(page, 'initial');
    // Gaze 3 lines high: the first lines read land above the text. 1.0 dropped them as excursions
    // (its test used the single current drift estimate), and with them the evidence that fixes it.
    const { fixations, truth } = readLines(page, 0, 5, { offsetPx: -3 * pitch, jitterPx: 0.05 * pitch });
    const acc = accuracy(tracker, fixations, truth);
    const e = tracker.estimate;
    expect(isTrackedLineEstimate(e) && e.excursions).toBe(0);
    // The page top pins the drift at once; "line k, −3" vs "line k + 1, −4" stays open until a
    // paragraph gap settles it.
    expect(acc).toBeGreaterThan(0.45); // 1.0: 17 %, two lines behind
    expect(e!.lineIndex).toBe(5);
    expect(lines(e!)).toBeCloseTo(-3, 0);
    // A look far above the text is still one.
    const away = tracker.onFixation(fix(1e5, 400, page.lines[0]!.centerY - 12 * pitch));
    expect(isTrackedLineEstimate(away) && away.excursions).toBe(1);
  });

  it('keeps counting lines when a horizontal offset makes return sweeps land too far right', () => {
    const tracker = new LineTracker();
    tracker.setLayout(page, 'initial');
    // +260 px: the sweeps land past the left 40 % of the column and are classified as regressions.
    // (1.0: 44–53 %; without treating them partly as sweeps: 21–31 %.)
    const { fixations, truth } = readLines(page, 0, L, { dxPx: 260, jitterPx: 0.2 * pitch, seed: 5 });
    expect(accuracy(tracker, fixations, truth)).toBeGreaterThan(0.8);
  });

  it('learns σ only once the drift that goes with the line is pinned by data', () => {
    const tracker = new LineTracker();
    tracker.setLayout(page, 'initial');
    const sigma = (): number => (isTrackedLineEstimate(tracker.estimate) ? tracker.estimate.sigmaYPx / pitch : NaN);
    readLines(page, 0, L, { jitterPx: 0.3 * pitch, seed: 2 }).fixations.forEach((f) => tracker.onFixation(f));
    const s0 = sigma();
    expect(s0).toBeLessThan(0.8); // σ has been learning from 0.9...
    expect(s0).toBeGreaterThan(0.42); // ...and is not at its floor
    // After a page turn the resume line is sure through its prior, but half of the drift belief is
    // uniform: the first fixation's residual against a drift that isn't known yet says nothing
    // about the noise (here it would pull σ down, the fixation being dead on the line).
    const { next, resume } = turn(tracker);
    const l = next.lines[resume]!;
    const e = tracker.onFixation(fix(1e5, l.left + 40, l.centerY));
    expect(e.lineIndex).toBe(resume);
    expect(e.probability).toBeGreaterThan(0.8);
    expect(sigma()).toBe(s0);
    // Once the drift is pinned again, learning resumes.
    for (let k = 1; k <= 6; k++) tracker.onFixation(fix(1e5 + 260 * k, l.left + 40 + 90 * k, l.centerY));
    expect(sigma()).toBeLessThan(s0);
  });

  it('spreads only 1 % uniformly after forward saccades and regressions', () => {
    for (const kind of ['forward', 'regression'] as const) {
      const T = LINE_TRANSITIONS[kind];
      expect(T.stay + T.next + T.next2 + T.prev).toBeCloseTo(0.99, 9);
    }
  });

  it('applies a late appearance report retroactively: rewinds to the change and replays the fixations since', () => {
    // A light is switched on as the reader sweeps to line 9 (gaze reads 3 lines low from then on);
    // the camera's report arrives `late` fixations later (the lid monitor needs ≈ 2.3 s).
    const run = (late: number | null): { at9: TrackedLineEstimate; rest: number; truth9: number } => {
      const tracker = new LineTracker();
      tracker.setLayout(page, 'initial');
      const before = readLines(page, 0, 8, { jitterPx: 0.1 * pitch });
      before.fixations.forEach((f) => tracker.onFixation(f));
      const after = readLines(page, 9, L - 2, { offsetPx: 3 * pitch, jitterPx: 0.1 * pitch, t0: before.t });
      after.fixations.slice(0, 9).forEach((f, i) => {
        if (i === late) tracker.appearanceChangedAt(before.t);
        tracker.onFixation(f);
      });
      if (late !== null && late >= 9) tracker.appearanceChangedAt(before.t);
      const at9 = tracker.estimate;
      if (!isTrackedLineEstimate(at9)) throw new Error('no estimate');
      const rest = accuracy(tracker, after.fixations.slice(9), after.truth.slice(9));
      return { at9, rest, truth9: after.truth[8]! };
    };
    const onTime = run(0);
    const late = run(9); // the first fixation after the change and 8 more
    expect(onTime.at9.lineIndex).toBe(onTime.truth9);
    // Exactly as if it had come on time: the same line, drift, posterior and fixation count.
    expect(late.at9.lineIndex).toBe(late.truth9);
    expect(late.at9.posterior).toEqual(onTime.at9.posterior);
    expect(late.at9.driftY).toBe(onTime.at9.driftY);
    expect(late.at9.fixationsOnPage).toBe(onTime.at9.fixationsOnPage);
    expect(late.rest).toBeGreaterThan(0.95);
    // Before, the tracker applied it at the next fixation, 3 lines off by then, and kept that line.
    const never = run(null);
    expect(never.at9.lineIndex).toBe(never.truth9 + 3);
  });

  it('drops a late report of a change from before the last page turn once the new page has fixations', () => {
    const run = (report: boolean): TrackedLineEstimate => {
      const tracker = new LineTracker();
      tracker.setLayout(page, 'initial');
      const { fixations, t } = readLines(page, 0, L, { jitterPx: 0.1 * pitch });
      fixations.forEach((f) => tracker.onFixation(f));
      const { next, resume } = turn(tracker);
      // The turn re-anchored the drift; the new page's first fixations learn the new bias (+2).
      const after = readLines(next, resume, resume + 1, { offsetPx: 2 * pitch, jitterPx: 0.1 * pitch, t0: t + 1000 }).fixations;
      after.slice(0, -1).forEach((f) => tracker.onFixation(f));
      // A report of a change before the turn arrives now: resetting the drift would only throw away
      // what the new page taught (1.0 applied it at the next fixation).
      if (report) tracker.appearanceChangedAt(t - 500);
      const e = tracker.onFixation(after.at(-1)!);
      if (!isTrackedLineEstimate(e)) throw new Error('no estimate');
      return e;
    };
    const reported = run(true);
    const unreported = run(false);
    expect(reported.posterior).toEqual(unreported.posterior);
    expect(reported.driftSdY).toBe(unreported.driftSdY);
    expect(lines(reported)).toBeCloseTo(2, 0);
  });
});

/** Simulated reading of `layout` (FixationDetector → tracker); on-line counts and the first estimate. */
function readSimulated(
  tracker: LineTracker,
  layout: LineLayout,
  seed: number,
  o: { noiseLines?: number; startLine?: number; endLine?: number } = {},
): { ok: number; n: number; first: LineEstimate | null } {
  const sim = simulateReading(layout, { seed, noisePx: (o.noiseLines ?? 0.75) * layout.linePitch, startLine: o.startLine, endLine: o.endLine, lingerMs: 0 });
  const det = new FixationDetector();
  let ok = 0;
  let n = 0;
  let first: LineEstimate | null = null;
  for (const s of sim.samples) {
    const r = det.push(s);
    if (r.completed) {
      const est = tracker.onFixation(r.completed);
      first ??= est;
      n++;
      if (est.lineIndex === truthAt(sim.truth, (r.completed.start + r.completed.end) / 2)) ok++;
    }
    tracker.onSample(s);
  }
  return { ok, n, first };
}

describe('LineTracker resets', () => {
  // The app's layout (no paragraph gaps, 1.5em indent) with long paragraphs: little structure to pin the drift.
  const APP_LONG = { paragraphGap: 0, indentPx: 33, paragraphLines: [12, 30] as const };
  const width = (e: LineEstimate | null): number =>
    isTrackedLineEstimate(e) ? (e.driftHighY! - e.driftLowY!) / e.sigmaYPx : NaN; // σ is the same (reset) for both

  it('keeps the drift of the most likely line across reset({ keepDrift: true }): never a weaker start than a fresh one', () => {
    // A book closed mid-page (lines 0–10 read, no offset) and opened again. Keeping the whole
    // marginal drift belief, half of it uniform, started weaker than a fresh tracker (it still
    // held the drift hypotheses of the less likely lines): 47 % of fixations on the true line
    // here against 93 % fresh (and 8/15 early/unsafe turns in 96 pages on the scoreboard).
    let kept = { ok: 0, n: 0 };
    let fresh = { ok: 0, n: 0 };
    for (let seed = 1; seed <= 24; seed++) {
      const closed = makeReadingPage(seed + 500, APP_LONG);
      const tracker = new LineTracker();
      tracker.setLayout(closed, 'initial');
      readSimulated(tracker, closed, seed + 500, { endLine: 10 });
      tracker.reset({ keepDrift: true });
      const page = makeReadingPage(seed, APP_LONG);
      tracker.setLayout(page, 'initial');
      const k = readSimulated(tracker, page, seed);
      const other = new LineTracker();
      other.reset();
      other.setLayout(page, 'initial');
      const f = readSimulated(other, page, seed);
      expect(width(k.first), `seed ${seed}`).toBeLessThanOrEqual(width(f.first));
      kept = { ok: kept.ok + k.ok, n: kept.n + k.n };
      fresh = { ok: fresh.ok + f.ok, n: fresh.n + f.n };
    }
    expect(kept.ok / kept.n).toBeGreaterThanOrEqual(fresh.ok / fresh.n);
  });

  it('starts from the Gaussian drift prior right after a calibration, and keeps the uniform share otherwise', () => {
    const doc = makeDocument({ lines: 60, seed: 4 });
    const page = doc.layoutAt(0, { viewport: { left: 0, top: 0, right: 1024, bottom: 20.5 * 42 } });
    const pitch = page.linePitch;
    const L = lastFullyVisibleIndex(page);
    const first = fix(0, page.lines[0]!.left + 50, page.lines[0]!.centerY);
    const calibrated = new LineTracker();
    calibrated.reset({ calibrated: true });
    calibrated.setLayout(page, 'initial');
    const c = calibrated.onFixation(first);
    const stored = new LineTracker();
    stored.reset();
    stored.setLayout(page, 'initial');
    const s = stored.onFixation(first);
    // After one fixation on the first line: Gaussian only, the 2–98 % drift range is about ±1 line;
    // with 30 % uniform it still spans several lines (the first line only rules out negative drifts).
    expect(isTrackedLineEstimate(c) && (c.driftHighY! - c.driftLowY!) / pitch).toBeLessThan(2.5);
    expect(isTrackedLineEstimate(s) && (s.driftHighY! - s.driftLowY!) / pitch).toBeGreaterThan(4);
    // The uniform share is what lets a start under different light (a stored calibration) learn a
    // large offset on its first page (as a new tracker does; see 'models ±5 lines of drift').
    const light = new LineTracker();
    light.reset();
    light.setLayout(page, 'initial');
    const { fixations, truth } = readLines(page, 0, L, { offsetPx: 3 * pitch, jitterPx: 0.15 * pitch, seed: 3 });
    expect(accuracy(light, fixations, truth)).toBeGreaterThan(0.6);
    expect(light.estimate!.driftY / pitch).toBeCloseTo(3, 0);
  });
});
