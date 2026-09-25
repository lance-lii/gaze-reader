import type { GazeSample, LineLayout, Sensitivity } from '../../src/types';
import { FixationDetector } from '../../src/signal/fixations';
import { OneEuroFilter2D } from '../../src/signal/oneEuro';
import { gaussian, mulberry32, simulateReading } from '../../src/reading/simulatedReader';
import { lastFullyVisibleIndex, makeReadingPage, type ReadingPageOptions } from '../../src/reading/testLayouts';
import { applyOffset, quantile, truthAt, type Offset, type Pipeline, type TrackerLike } from './harness';

/**
 * One fresh page (a new tracker, as after opening a book) read in a scripted
 * order — straight through, starting mid-page, jumping back to re-read, or
 * skipping ahead — through FixationDetector → LineTracker → PageEndDetector,
 * until the first page-end trigger.
 */

export interface Segment {
  startLine: number;
  endLine: number;
}

export interface PageConfig {
  seed: number;
  pipeline: Pipeline;
  /** Reading order, given the page's last fully visible line L. Default: the whole page. */
  segments?: (L: number) => Segment[];
  offset?: Offset;
  noiseLines?: number;
  /** How long the reader lingers at the end, ms. Default 6000; no trigger by then is "missed". */
  lingerMs?: number;
  /** Page geometry (makeReadingPage options). Default: paragraphs with 0.5-pitch gaps (extension-like). */
  doc?: ReadingPageOptions;
  /** A page to read instead of makeReadingPage(seed, doc) (e.g. withBlockGap: a scene break before the last line). */
  layout?: LineLayout;
  /**
   * Runs on the new tracker before it is given the page (setLayout 'initial'): e.g. read another
   * page and reset({ keepDrift: true }), or reset({ calibrated: true }). Default: a fresh tracker.
   */
  prepare?: (tracker: TrackerLike, layout: LineLayout) => void;
}

export interface PageResult {
  onLine: number;
  fixations: number;
  fired: boolean;
  /** Reader more than a line above L at the trigger. */
  premature: boolean;
  /** Reader above the anchor line at the trigger. */
  unsafe: boolean;
  /** Trigger time − end of the reader's last fixation on L, ms. */
  latency: number;
  reason: string;
}

export function runPage(cfg: PageConfig): PageResult {
  const layout = cfg.layout ?? makeReadingPage(cfg.seed, cfg.doc);
  const pitch = layout.linePitch;
  const centerY = (layout.viewport.top + layout.viewport.bottom) / 2;
  const L = lastFullyVisibleIndex(layout);
  const segments = cfg.segments?.(L) ?? [{ startLine: 0, endLine: L }];
  const noisePx = (cfg.noiseLines ?? 0.75) * pitch;
  const samples: GazeSample[] = [];
  const truth: { t: number; lineIndex: number }[] = [];
  let t0 = 0;
  let lastLineEndT = 0;
  segments.forEach((sg, j) => {
    const last = j === segments.length - 1;
    const sim = simulateReading(layout, {
      seed: cfg.seed * 10 + j,
      noisePx,
      startLine: sg.startLine,
      endLine: sg.endLine,
      lingerMs: last ? (cfg.lingerMs ?? 6000) : 0,
      t0,
    });
    samples.push(...sim.samples);
    truth.push(...sim.truth);
    lastLineEndT = sim.lastLineEndT;
    t0 = (sim.samples.at(-1)?.t ?? t0) + 60;
  });

  const fixations = new FixationDetector();
  const tracker = cfg.pipeline.tracker();
  const detector = cfg.pipeline.detector();
  cfg.prepare?.(tracker, layout);
  tracker.setLayout(layout, 'initial');
  const offset = cfg.offset ?? { dy: 0 };
  let n = 0;
  let ok = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = applyOffset(samples[i]!, offset, pitch, centerY);
    const r = fixations.push(s);
    if (r.completed) {
      const est = tracker.onFixation(r.completed);
      const mid = (r.completed.start + r.completed.end) / 2;
      const tl = truthAt(truth, mid);
      if (mid < lastLineEndT && tl >= 0 && est.lineIndex >= 0) {
        n++;
        if (est.lineIndex === tl) ok++;
      }
    }
    tracker.onSample(s);
    const d = detector.update({ t: s.t, gaze: s, estimate: tracker.estimate, layout });
    if (d.trigger) {
      const trueLine = truth[i]!.lineIndex;
      return {
        onLine: ok,
        fixations: n,
        fired: true,
        premature: trueLine < L - 1,
        unsafe: trueLine < d.targetLineIndex,
        latency: s.t - lastLineEndT,
        reason: d.reason + (d.detail.includes('return sweep') ? ' (sweep)' : ''),
      };
    }
  }
  return { onLine: ok, fixations: n, fired: false, premature: false, unsafe: false, latency: NaN, reason: 'missed' };
}

export interface PageSummary {
  pages: number;
  onLine: number;
  onLineMin: number;
  premature: number;
  unsafe: number;
  missed: number;
  latencyMedian: number;
  latencyP90: number;
  rules: Record<string, number>;
}

export function summarizePages(runs: readonly PageResult[]): PageSummary {
  const rules: Record<string, number> = {};
  for (const r of runs) rules[r.reason] = (rules[r.reason] ?? 0) + 1;
  const lat = runs.filter((r) => r.fired).map((r) => r.latency);
  const fix = runs.reduce((a, r) => a + r.fixations, 0);
  return {
    pages: runs.length,
    onLine: runs.reduce((a, r) => a + r.onLine, 0) / Math.max(1, fix),
    onLineMin: Math.min(...runs.map((r) => r.onLine / Math.max(1, r.fixations))),
    premature: runs.filter((r) => r.premature).length,
    unsafe: runs.filter((r) => r.unsafe).length,
    missed: runs.filter((r) => !r.fired).length,
    latencyMedian: quantile(lat, 0.5),
    latencyP90: quantile(lat, 0.9),
    rules,
  };
}

/**
 * A `prepare` for runPage: the tracker first reads another page of the same geometry (lines
 * 0–`endLine`, no offset; the whole page by default) and is then reset with `resetOpts` — a book
 * closed and opened again (reset({ keepDrift: true })), or a new calibration ({ calibrated: true }).
 */
export function afterReading(
  seed: number,
  resetOpts: { keepDrift?: boolean; calibrated?: boolean },
  o: { doc?: ReadingPageOptions; endLine?: number; noiseLines?: number } = {},
): (tracker: TrackerLike) => void {
  return (tracker) => {
    const layout = makeReadingPage(seed + 500, o.doc);
    const sim = simulateReading(layout, { seed: seed + 500, noisePx: (o.noiseLines ?? 0.75) * layout.linePitch, endLine: o.endLine, lingerMs: 0 });
    const fixations = new FixationDetector();
    tracker.setLayout(layout, 'initial');
    for (const s of sim.samples) {
      const r = fixations.push(s);
      if (r.completed) tracker.onFixation(r.completed);
      tracker.onSample(s);
    }
    tracker.reset?.(resetOpts);
  };
}

/** The scripted reading orders of the benchmark. */
export const READING_ORDERS: ReadonlyArray<readonly [label: string, segments: (L: number) => Segment[]]> = [
  ['reader starts mid-page (line 8)', (L) => [{ startLine: 8, endLine: L }]],
  ['re-read jump (0–10, back to 6–7, 11–L)', (L) => [{ startLine: 0, endLine: 10 }, { startLine: 6, endLine: 7 }, { startLine: 11, endLine: L }]],
  ['skip ahead (0–8, then 12–L)', (L) => [{ startLine: 0, endLine: 8 }, { startLine: 12, endLine: L }]],
  ['skip to the last line (0–8, then L)', (L) => [{ startLine: 0, endLine: 8 }, { startLine: L, endLine: L }]],
];

// ───────────────────────── interrupted reading (glances, peeks) ─────────────────────────

export interface InterruptConfig {
  seed: number;
  pipeline: Pipeline;
  /** Where the eyes go from the end of line 8, and for how long. */
  look: { kind: 'glance'; dyLines: number } | { kind: 'peek' };
  lookMs: number;
  sensitivity?: Sensitivity;
  offset?: Offset;
  /** Page geometry (makeReadingPage options). Default: paragraphs with 0.5-pitch gaps. */
  doc?: ReadingPageOptions;
}

export interface InterruptResult {
  /** Reading fixations after the look on the true line / all of them. */
  onLine: number;
  fixations: number;
  /** A page turn while the reader was more than a line above the last line. */
  premature: boolean;
  unsafe: boolean;
  fired: boolean;
}

/**
 * Reads lines 0–8 and then looks away from the end of line 8 — a `glance` straight down (or up)
 * by dyLines, then straight back for 300 ms; or a `peek` at the end of the page's last line — and
 * reads on from line 9: to the end of the page (glance, which then lingers 6 s), or to line 12
 * (peek: any turn is premature). The look is smoothed like webcam gaze (One Euro).
 */
export function runInterrupted(cfg: InterruptConfig): InterruptResult {
  const layout = makeReadingPage(cfg.seed, cfg.doc);
  const pitch = layout.linePitch;
  const centerY = (layout.viewport.top + layout.viewport.bottom) / 2;
  const L = lastFullyVisibleIndex(layout);
  const noisePx = [0.5, 0.75][cfg.seed % 2]! * pitch;
  const before = simulateReading(layout, { seed: cfg.seed, noisePx, endLine: 8, lingerMs: 0 });
  const rng = mulberry32(cfg.seed + 999);
  const smooth = new OneEuroFilter2D();
  for (const s of before.samples.slice(-5)) if (s.valid) smooth.filter(s.x, s.y, s.t);
  const truth: { t: number; lineIndex: number }[] = [...before.truth];
  const look: GazeSample[] = [];
  let t = (before.samples.at(-1)?.t ?? 0) + 33;
  const hold = (x: number, y: number, ms: number): void => {
    for (const end = t + ms; t < end; t += 33) {
      const rawX = x + noisePx * gaussian(rng);
      const rawY = y + noisePx * gaussian(rng);
      const p = smooth.filter(rawX, rawY, t);
      look.push({ t, x: p.x, y: p.y, rawX, rawY, valid: true, confidence: 1, source: 'simulated' });
      truth.push({ t, lineIndex: 8 });
    }
  };
  const l8 = layout.lines[8]!;
  if (cfg.look.kind === 'glance') {
    hold(l8.right - 10, l8.centerY + cfg.look.dyLines * pitch, cfg.lookMs);
    hold(l8.right - 20, l8.centerY, 300);
  } else {
    const last = layout.lines[L]!;
    hold(last.left + 0.85 * (last.right - last.left), last.centerY, cfg.lookMs);
  }
  const after = simulateReading(layout, {
    seed: cfg.seed + 1,
    noisePx,
    startLine: 9,
    endLine: cfg.look.kind === 'peek' ? 12 : L,
    lingerMs: cfg.look.kind === 'peek' ? 0 : 6000,
    t0: t + 40,
  });
  truth.push(...after.truth);

  const fixations = new FixationDetector();
  const tracker = cfg.pipeline.tracker();
  const detector = cfg.pipeline.detector(cfg.sensitivity);
  tracker.setLayout(layout, 'initial');
  const offset = cfg.offset ?? { dy: 0 };
  const tAfter = after.samples[0]?.t ?? Infinity;
  let n = 0;
  let ok = 0;
  for (const raw of [...before.samples, ...look, ...after.samples]) {
    const s = applyOffset(raw, offset, pitch, centerY);
    const r = fixations.push(s);
    if (r.completed) {
      const est = tracker.onFixation(r.completed);
      const mid = (r.completed.start + r.completed.end) / 2;
      if (mid >= tAfter && mid < after.lastLineEndT && est.lineIndex >= 0) {
        n++;
        if (est.lineIndex === truthAt(after.truth, mid)) ok++;
      }
    }
    tracker.onSample(s);
    const d = detector.update({ t: s.t, gaze: s, estimate: tracker.estimate, layout });
    if (d.trigger) {
      const trueLine = truthAt(truth, s.t);
      return { onLine: ok, fixations: n, fired: true, premature: trueLine < L - 1, unsafe: trueLine < d.targetLineIndex };
    }
  }
  return { onLine: ok, fixations: n, fired: false, premature: false, unsafe: false };
}
