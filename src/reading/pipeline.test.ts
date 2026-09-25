import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GazeSample, LineLayout, PageEndDecision, Sensitivity } from '../types';
import { FixationDetector } from '../signal/fixations';
import { OneEuroFilter2D } from '../signal/oneEuro';
import { LineTracker } from './lineTracker';
import { PageEndDetector } from './pageEndDetector';
import { SimulatedReaderSource, gaussian, mulberry32, simulateReading, type SimulateReadingOptions } from './simulatedReader';
import { lastFullyVisibleIndex, makeDocument, makeReadingPage } from './testLayouts';

/**
 * End to end: simulateReading → FixationDetector → LineTracker → PageEndDetector,
 * wired the way the app controller wires them.
 */

interface PageRun {
  /** First trigger, or null. */
  fire: { t: number; decision: PageEndDecision; trueLine: number } | null;
  /** When the reader first reached one of the last two lines. */
  reachedT: number;
  lastLineEndT: number;
  L: number;
  /** Fraction of reading fixations the tracker put on the true line. */
  accuracy: number;
}

const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);
/** The spec's noise range: σ 0.5–1.0 line pitch, slow drift up to 0.5 pitch. */
const specScenario = (seed: number) => ({ noise: [0.5, 0.75, 1.0][seed % 3]!, drift: [0, 0.25, 0.5][Math.floor(seed / 3) % 3]! });

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

function runPage(
  seed: number,
  o: { noise: number; drift: number; sensitivity?: Sensitivity; sim?: SimulateReadingOptions; mutate?: (s: GazeSample, reachedT: number) => GazeSample },
): PageRun {
  const layout = makeReadingPage(seed);
  const pitch = layout.linePitch;
  const L = lastFullyVisibleIndex(layout);
  const sim = simulateReading(layout, { seed, noisePx: o.noise * pitch, driftPx: o.drift * pitch, lingerMs: 4000, ...o.sim });
  const reachedT = sim.truth.find((x) => x.lineIndex >= L - 1)?.t ?? Infinity;
  const fixations = new FixationDetector();
  const tracker = new LineTracker();
  const detector = new PageEndDetector({ sensitivity: o.sensitivity ?? 'balanced' });
  tracker.setLayout(layout, 'initial');
  let ok = 0;
  let n = 0;
  for (let i = 0; i < sim.samples.length; i++) {
    const s = o.mutate ? o.mutate(sim.samples[i]!, reachedT) : sim.samples[i]!;
    const r = fixations.push(s);
    if (r.completed) {
      const est = tracker.onFixation(r.completed);
      const mid = (r.completed.start + r.completed.end) / 2;
      if (mid < sim.lastLineEndT) {
        n++;
        if (est.lineIndex === truthAt(sim.truth, mid)) ok++;
      }
    }
    tracker.onSample(s);
    const decision = detector.update({ t: s.t, gaze: s, estimate: tracker.estimate, layout });
    if (decision.trigger) {
      return { fire: { t: s.t, decision, trueLine: sim.truth[i]!.lineIndex }, reachedT, lastLineEndT: sim.lastLineEndT, L, accuracy: ok / Math.max(1, n) };
    }
  }
  return { fire: null, reachedT, lastLineEndT: sim.lastLineEndT, L, accuracy: ok / Math.max(1, n) };
}

const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1]!;
};

describe('reading pipeline (simulated reader → fixations → lines → page end)', () => {
  it('balanced turns the page within 1500 ms of the true end of the last line, on every seed', () => {
    const latencies = SEEDS.map((seed) => {
      const run = runPage(seed, specScenario(seed));
      expect(run.fire, `seed ${seed} never fired`).not.toBeNull();
      return run.fire!.t - run.lastLineEndT;
    });
    expect(Math.max(...latencies)).toBeLessThanOrEqual(1500);
    // Typically it starts turning as the last words are read.
    expect(median(latencies)).toBeLessThan(300);
    expect(median(latencies)).toBeGreaterThan(-700);
  });

  it('never turns before the reader reaches the last two lines (every preset)', () => {
    for (const sensitivity of ['relaxed', 'balanced', 'eager'] as const) {
      for (const seed of SEEDS) {
        const run = runPage(seed, { ...specScenario(seed), sensitivity });
        if (run.fire) expect(run.fire.t, `${sensitivity} seed ${seed}`).toBeGreaterThanOrEqual(run.reachedT);
      }
    }
  });

  it('never scrolls unread text away: the reader is at or below the anchored line when it turns', () => {
    for (const seed of SEEDS) {
      const run = runPage(seed, specScenario(seed));
      expect(run.fire!.trueLine).toBeGreaterThanOrEqual(run.fire!.decision.targetLineIndex);
      expect(run.fire!.decision.targetLineIndex).toBeGreaterThanOrEqual(run.L - 1);
      expect(run.fire!.decision.targetLineIndex).toBeLessThanOrEqual(run.L);
    }
  });

  it('never turns on invalid (face-lost) samples', () => {
    for (const seed of SEEDS.slice(0, 12)) {
      const scenario = specScenario(seed);
      const lostAll = runPage(seed, { ...scenario, mutate: (s) => ({ ...s, valid: false, confidence: 0 }) });
      expect(lostAll.fire).toBeNull();
      // The face is lost just as the reader gets to the end of the page: no turn while it stays lost.
      const lostAtEnd = runPage(seed, { ...scenario, mutate: (s, reachedT) => (s.t >= reachedT ? { ...s, valid: false, confidence: 0 } : s) });
      if (lostAtEnd.fire) expect(lostAtEnd.fire.t).toBeLessThan(lostAtEnd.reachedT);
    }
  });

  it('relaxed never turns earlier than eager on the same reading', () => {
    for (const seed of SEEDS) {
      const scenario = specScenario(seed);
      const relaxed = runPage(seed, { ...scenario, sensitivity: 'relaxed' }).fire?.t ?? Infinity;
      const balanced = runPage(seed, { ...scenario, sensitivity: 'balanced' }).fire?.t ?? Infinity;
      const eager = runPage(seed, { ...scenario, sensitivity: 'eager' }).fire?.t ?? Infinity;
      expect(relaxed, `seed ${seed}`).toBeGreaterThanOrEqual(eager);
      expect(relaxed).toBeGreaterThanOrEqual(balanced);
      expect(balanced).toBeGreaterThanOrEqual(eager);
    }
  });

  it('keeps the line estimate on the true line for ≥ 80 % of fixations', () => {
    const accs = SEEDS.map((seed) => runPage(seed, specScenario(seed)).accuracy);
    expect(Math.min(...accs)).toBeGreaterThanOrEqual(0.8);
    expect(accs.reduce((a, b) => a + b, 0) / accs.length).toBeGreaterThan(0.95);
  });

  it('does not turn when the reader peeks at the end of the page mid-page and reads on', () => {
    // Reads lines 0–8, looks at the end of the last line for a moment, then reads lines 9–12.
    const peekRun = (seed: number, sensitivity: Sensitivity, peekMs: number): PageEndDecision | null => {
      const layout = makeReadingPage(seed);
      const pitch = layout.linePitch;
      const noisePx = [0.5, 0.75][seed % 2]! * pitch;
      const last = layout.lines[lastFullyVisibleIndex(layout)]!;
      const before = simulateReading(layout, { seed, noisePx, endLine: 8, lingerMs: 0 });
      const rng = mulberry32(seed + 999);
      const smooth = new OneEuroFilter2D();
      for (const s of before.samples.slice(-5)) smooth.filter(s.x, s.y, s.t);
      const peek: GazeSample[] = [];
      let t = before.samples.at(-1)!.t + 33;
      for (; peek.length * 33 < peekMs + 60; t += 33) {
        const rawX = last.left + 0.85 * (last.right - last.left) + noisePx * gaussian(rng);
        const rawY = last.centerY + noisePx * gaussian(rng);
        const p = smooth.filter(rawX, rawY, t);
        peek.push({ t, x: p.x, y: p.y, rawX, rawY, valid: true, confidence: 1, source: 'simulated' });
      }
      const after = simulateReading(layout, { seed: seed + 1, noisePx, startLine: 9, endLine: 12, lingerMs: 0, t0: t + 40 });
      const fixations = new FixationDetector();
      const tracker = new LineTracker();
      const detector = new PageEndDetector({ sensitivity });
      tracker.setLayout(layout, 'initial');
      for (const s of [...before.samples, ...peek, ...after.samples]) {
        const r = fixations.push(s);
        if (r.completed) tracker.onFixation(r.completed);
        tracker.onSample(s);
        const d = detector.update({ t: s.t, gaze: s, estimate: tracker.estimate, layout });
        if (d.trigger) return d;
      }
      return null;
    };
    for (const sensitivity of ['balanced', 'eager'] as const) {
      for (const seed of SEEDS) {
        // Before the tracker had caught up with the eyes leaving a short last line, 2–5 of these turned the page.
        expect(peekRun(seed, sensitivity, 400), `${sensitivity} seed ${seed}`).toBeNull();
      }
    }
  });

  it('stays safe under harsher, webcam-like conditions (correlated noise, blinks, calibration bias)', () => {
    let fired = 0;
    for (const seed of SEEDS) {
      const run = runPage(seed, {
        noise: 0.75,
        drift: 0.5,
        sim: { wanderPx: 0.3 * 42, blinksPerMin: 15, driftOnset: 'immediate' },
      });
      if (!run.fire) continue;
      fired++;
      expect(run.fire.t).toBeGreaterThanOrEqual(run.reachedT);
      expect(run.fire.trueLine).toBeGreaterThanOrEqual(run.fire.decision.targetLineIndex);
      expect(run.fire.t - run.lastLineEndT).toBeLessThan(3000);
    }
    expect(fired).toBeGreaterThanOrEqual(SEEDS.length - 1);
  });
});

describe('demo mode across many pages (live SimulatedReaderSource + controller-like page turns)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads a whole document page by page without skipping a line', async () => {
    const doc = makeDocument({ lines: 120, seed: 21 });
    const viewport = { left: 0, top: 0, right: 1024, bottom: 20.3 * 42 };
    const maxScroll = doc.scrollHeight - (viewport.bottom - viewport.top);
    let layout: LineLayout = doc.layoutAt(0, { viewport, measuredAt: performance.now() });
    const pitch = layout.linePitch;

    const source = new SimulatedReaderSource({ getLayout: () => layout, wpm: () => 450, noisePx: 0.6 * pitch, driftPx: 0.35 * pitch, seed: 8, blinksPerMin: 10 });
    const fixations = new FixationDetector();
    const tracker = new LineTracker();
    const detector = new PageEndDetector();
    tracker.setLayout(layout, 'initial');

    const turns: { readerDocTop: number; anchorDocTop: number; lastVisibleDocTop: number }[] = [];
    let finished = false;
    source.onSample((s) => {
      const r = fixations.push(s);
      if (r.completed) tracker.onFixation(r.completed);
      tracker.onSample(s);
      const d = detector.update({ t: s.t, gaze: s, estimate: tracker.estimate, layout });
      if (!d.trigger || finished) return;
      // What ScrollController.turnPage does with overlapLines = 1: the anchor line goes to the top.
      const anchor = layout.lines[d.targetLineIndex]!;
      const next = Math.min(maxScroll, anchor.docTop - 0.35 * pitch);
      if (next <= layout.scrollTop + 1) {
        finished = true; // end of the document
        return;
      }
      turns.push({
        readerDocTop: source.state.lineDocTop!,
        anchorDocTop: anchor.docTop,
        lastVisibleDocTop: layout.lines[lastFullyVisibleIndex(layout)]!.docTop,
      });
      layout = doc.layoutAt(next, { viewport, measuredAt: s.t });
      tracker.setLayout(layout, 'page-turn');
      tracker.afterPageTurn(layout.lines.findIndex((l) => l.docTop > anchor.docTop + 1));
      detector.notifyScrolled(s.t);
    });

    await source.start();
    for (let minute = 0; minute < 8 && !finished; minute++) vi.advanceTimersByTime(60_000);
    source.stop();

    const lastLine = doc.lines[doc.lines.length - 1]!;
    expect(finished).toBe(true);
    expect(source.state.lastReadDocTop).toBe(lastLine.docTop);
    expect(turns.length).toBeGreaterThanOrEqual(5);
    for (const turn of turns) {
      // Turned only once the reader was on the page's last line or the one before it...
      expect(turn.readerDocTop).toBeGreaterThanOrEqual(turn.lastVisibleDocTop - 1.5 * pitch);
      // ...and never scrolled the line being read out of view.
      expect(turn.readerDocTop).toBeGreaterThanOrEqual(turn.anchorDocTop);
    }
    // Every line of the document was read (a repeated overlap line is fine).
    expect(source.state.linesRead).toBeGreaterThanOrEqual(doc.lines.length);
  });
});
