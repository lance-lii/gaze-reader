import { describe, expect, it } from 'vitest';
import type { Fixation, GazeSample, LineLayout } from '../types';
import { FixationDetector } from '../signal/fixations';
import { DEFAULT_LINE_TRACKER_OPTIONS, LineTracker, isTrackedLineEstimate } from './lineTracker';
import { gaussian, mulberry32, simulateReading } from './simulatedReader';
import { lastFullyVisibleIndex, makeDocument, makeReadingPage } from './testLayouts';

let fixId = 0;
function fix(t: number, x: number, y: number): Fixation {
  return { id: ++fixId, start: t, end: t + 220, x, y, sampleCount: 7 };
}

/** Idealized reading fixations over lines [from, to]: 8 per line, then a return sweep. */
function readLines(
  layout: LineLayout,
  from: number,
  to: number,
  opts: { offsetPx?: number; jitterPx?: number; seed?: number; t0?: number } = {},
): { fixations: Fixation[]; truth: number[] } {
  const rng = mulberry32(opts.seed ?? 1);
  const fixations: Fixation[] = [];
  const truth: number[] = [];
  let t = opts.t0 ?? 0;
  for (let i = from; i <= to; i++) {
    const l = layout.lines[i]!;
    const n = Math.max(2, Math.round(((l.right - l.left) / 700) * 8));
    for (let k = 0; k < n; k++) {
      const x = l.left + ((k + 0.4) / n) * (l.right - l.left);
      const y = l.centerY + (opts.offsetPx ?? 0) + (opts.jitterPx ?? 0) * gaussian(rng);
      fixations.push(fix(t, x, y));
      truth.push(i);
      t += 260;
    }
  }
  return { fixations, truth };
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
