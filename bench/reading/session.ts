import { vi } from 'vitest';
import type { GazeSample, LineEstimate, LineLayout } from '../../src/types';
import { FixationDetector } from '../../src/signal/fixations';
import { SimulatedReaderSource } from '../../src/reading/simulatedReader';
import { lastFullyVisibleIndex, makeDocument, type SyntheticDocOptions } from '../../src/reading/testLayouts';
import { resumeLineIndex } from '../../src/app/logic';
import { applyOffset, mean, noOffset, offsetLinesAt, quantile, type Pipeline, type Schedule } from './harness';

/**
 * A reading session over many pages, wired the way the app controller wires the
 * reading layer (src/app/controller.ts): SimulatedReaderSource (One Euro-smoothed
 * webcam-like gaze) → injected offset → FixationDetector → LineTracker →
 * PageEndDetector. A trigger scrolls the anchor line to the top (as
 * ScrollController.turnPage does), the tracker is told the resume line
 * (resumeLineIndex, as afterJump does), and the pipeline is blocked for the
 * scroll animation. A reader who has lingered on the last line for `missAfterMs`
 * without a turn turns the page by hand ("missed").
 */

export interface SessionConfig {
  seed: number;
  pipeline: Pipeline;
  /** Injected offset over time. Default none. */
  schedule?: Schedule;
  /** White noise σ, line pitches. Default 0.75. */
  noiseLines?: number;
  /** Correlated low-frequency noise σ, line pitches. Default 0. */
  wanderLines?: number;
  /** Default 10. */
  blinksPerMin?: number;
  /** Default 300. */
  wpm?: number;
  /** Times (ms since the start) at which the camera reports an appearance change. */
  appearanceEvents?: readonly number[];
  /** How long the report takes to reach the tracker, ms (it still carries the change's time). Default 100. */
  eventDelayMs?: number;
  /** Page turns to run. Default 7. */
  turns?: number;
  /** Default 8000. */
  missAfterMs?: number;
  /** Document length. Default 170 lines (enough for 7 turns). */
  docLines?: number;
  /**
   * Document geometry (makeDocument options). Default: 3–7-line paragraphs with 0.5-pitch gaps
   * between them, extension-like; the app's reader has no paragraph gaps (see APP_DOC in the bench).
   */
  doc?: SyntheticDocOptions;
  /**
   * Re-open the book on this page (the tracker is reset as the controller does on a book
   * open, optionally keeping the learned drift) — for the reset({ keepDrift }) benchmark.
   */
  reopenAtPage?: { page: number; keepDrift: boolean };
  /** Diagnostics: called for every reading fixation with whether the tracker put it on the true line. */
  onReadingFixation?: (onTrueLine: boolean, estimate: LineEstimate, page: number) => void;
}

export interface TurnLog {
  page: number;
  t: number;
  /** Rule that fired, with "(sweep)" for the return-sweep shortcut; "manual" for a missed turn. */
  reason: string;
  manual: boolean;
  /** Reader's line − last fully visible line at the trigger (0 = on it, −1 = one above…). */
  readerVsL: number;
  /** Reader's line − the anchor line (negative = the line being read scrolls away). */
  readerVsTarget: number;
  /** ms since the reader started lingering on the last line (NaN when the reader had not finished). */
  latency: number;
  /** |driftY − injected offset at the reader's line|, lines. */
  driftError: number;
}

export interface SessionResult {
  seed: number;
  turns: TurnLog[];
  /** Reading fixations, and those the tracker put on the reader's true line. */
  fixations: number;
  onLine: number;
  /** Same, for the first 8 fixations after each turn. */
  fixationsAfterTurn: number;
  onLineAfterTurn: number;
  /** Document lines up to the furthest one read that were never read to their end. */
  skipped: number;
  finished: boolean;
}

const VIEWPORT = Object.freeze({ left: 0, top: 0, right: 1024, bottom: 20.3 * 42 });
const AFTER_TURN_FIXATIONS = 8;
const SCROLL_ANIMATION_MS = 250;

export function runSession(cfg: SessionConfig): SessionResult {
  vi.useFakeTimers();
  try {
    return session(cfg);
  } finally {
    vi.useRealTimers();
  }
}

function session(cfg: SessionConfig): SessionResult {
  const doc = makeDocument({ lines: cfg.docLines ?? 170, seed: 100 + cfg.seed, ...cfg.doc });
  const viewport = { ...VIEWPORT };
  const centerY = (viewport.top + viewport.bottom) / 2;
  const maxScroll = doc.scrollHeight - (viewport.bottom - viewport.top);
  let layout: LineLayout = doc.layoutAt(0, { viewport, measuredAt: performance.now() });
  const pitch = layout.linePitch;
  const docIndex = new Map<number, number>();
  doc.lines.forEach((l, i) => docIndex.set(Math.round(l.docTop), i));
  const di = (docTop: number | null | undefined): number => (docTop == null ? -1 : docIndex.get(Math.round(docTop)) ?? -1);
  const schedule = cfg.schedule ?? noOffset;

  const source = new SimulatedReaderSource({
    getLayout: () => layout,
    wpm: () => cfg.wpm ?? 300,
    noisePx: (cfg.noiseLines ?? 0.75) * pitch,
    driftPx: 0,
    wanderPx: (cfg.wanderLines ?? 0) * pitch,
    seed: cfg.seed,
    blinksPerMin: cfg.blinksPerMin ?? 10,
  });
  const fixations = new FixationDetector();
  let tracker = cfg.pipeline.tracker();
  const detector = cfg.pipeline.detector();
  tracker.setLayout(layout, 'initial');

  const truthT: number[] = [];
  const truthLine: number[] = [];
  const truthAt = (t: number): number => {
    let lo = 0;
    let hi = truthT.length - 1;
    if (hi < 0) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (truthT[mid]! <= t) lo = mid;
      else hi = mid - 1;
    }
    return truthLine[lo]!;
  };

  const turns: TurnLog[] = [];
  const read = new Set<number>();
  const events = [...(cfg.appearanceEvents ?? [])].sort((a, b) => a - b);
  const eventDelay = cfg.eventDelayMs ?? 100;
  let nextEvent = 0;
  let page = 0;
  let t0: number | null = null;
  let blockedUntil = -Infinity;
  let lingerSince: number | null = null;
  let finished = false;
  let fixCount = 0;
  let onLine = 0;
  let fixAfter = 0;
  let onLineAfter = 0;
  let sinceTurn = 0;

  const turn = (t: number, target: number, reason: string, manual: boolean, off: ReturnType<Schedule>): void => {
    const L = lastFullyVisibleIndex(layout);
    const readerIdx = di(source.state.lineDocTop);
    const readerLine = layout.lines.find((l) => di(l.docTop) === readerIdx);
    const est = tracker.estimate;
    const expected = offsetLinesAt(off, readerLine ? readerLine.centerY : centerY, pitch, centerY);
    turns.push({
      page,
      t,
      reason,
      manual,
      readerVsL: readerIdx - di(layout.lines[L]!.docTop),
      readerVsTarget: readerIdx - di(layout.lines[target]!.docTop),
      latency: lingerSince !== null ? t - lingerSince : NaN,
      driftError: est ? Math.abs(est.driftY / pitch - expected) : NaN,
    });
    const anchor = layout.lines[target]!;
    const next = Math.min(maxScroll, anchor.docTop - 0.35 * pitch);
    if (next <= layout.scrollTop + 1) {
      finished = true;
      return;
    }
    page++;
    layout = doc.layoutAt(next, { viewport, measuredAt: t });
    if (cfg.reopenAtPage && cfg.reopenAtPage.page === page) {
      // The book is closed and opened again at this position: the controller resets the pipeline
      // and measures afresh ('initial'); the new tracker may keep the drift it had learned.
      if (tracker.reset) tracker.reset({ keepDrift: cfg.reopenAtPage.keepDrift });
      else tracker = cfg.pipeline.tracker();
      tracker.setLayout(layout, 'initial');
    } else {
      tracker.setLayout(layout, 'page-turn');
      tracker.afterPageTurn(resumeLineIndex(layout.lines, anchor.docTop, layout.linePitch));
    }
    detector.notifyScrolled(t);
    fixations.reset();
    blockedUntil = t + SCROLL_ANIMATION_MS;
    lingerSince = null;
    sinceTurn = 0;
    if (page >= (cfg.turns ?? 7)) finished = true;
  };

  source.onSample((raw: GazeSample) => {
    if (finished) return;
    const t = raw.t;
    t0 ??= t;
    const tRel = t - t0;
    const st = source.state;
    truthT.push(t);
    truthLine.push(di(st.lineDocTop));
    if (st.lastReadDocTop !== null) read.add(di(st.lastReadDocTop));
    if (st.mode === 'lingering') lingerSince ??= t;
    const off = schedule(tRel, page);
    const s = applyOffset(raw, off, pitch, centerY);
    while (nextEvent < events.length && tRel >= events[nextEvent]! + eventDelay) {
      tracker.appearanceChangedAt?.(t0 + events[nextEvent]!);
      nextEvent++;
    }
    if (t < blockedUntil) return;
    const r = fixations.push(s);
    if (r.completed) {
      const est = tracker.onFixation(r.completed);
      const tl = truthAt((r.completed.start + r.completed.end) / 2);
      const el = est.lineIndex >= 0 ? di(layout.lines[est.lineIndex]?.docTop) : -1;
      if (tl >= 0 && el >= 0 && st.mode === 'reading') {
        const good = tl === el;
        cfg.onReadingFixation?.(good, est, page);
        fixCount++;
        if (good) onLine++;
        if (sinceTurn < AFTER_TURN_FIXATIONS && page > 0) {
          fixAfter++;
          if (good) onLineAfter++;
        }
      }
      sinceTurn++;
    }
    tracker.onSample(s);
    const d = detector.update({ t, gaze: s, estimate: tracker.estimate, layout });
    if (d.trigger) {
      const target = d.targetLineIndex >= 0 && d.targetLineIndex < layout.lines.length ? d.targetLineIndex : lastFullyVisibleIndex(layout);
      turn(t, target, d.reason + (d.detail.includes('return sweep') ? ' (sweep)' : ''), false, off);
      return;
    }
    if (lingerSince !== null && t - lingerSince > (cfg.missAfterMs ?? 8000)) {
      turn(t, lastFullyVisibleIndex(layout), 'manual', true, off);
    }
  });

  void source.start();
  for (let k = 0; k < 60 && !finished; k++) vi.advanceTimersByTime(30_000);
  source.stop();

  const maxRead = read.size ? Math.max(...read) : -1;
  let skipped = 0;
  for (let i = 0; i <= maxRead; i++) if (!read.has(i)) skipped++;
  return {
    seed: cfg.seed,
    turns,
    fixations: fixCount,
    onLine,
    fixationsAfterTurn: fixAfter,
    onLineAfterTurn: onLineAfter,
    skipped,
    finished,
  };
}

export interface SessionSummary {
  sessions: number;
  turns: number;
  /** Fraction of reading fixations on the true line (pooled). */
  onLine: number;
  /** Worst session. */
  onLineMin: number;
  onLineAfterTurn: number;
  /** Reader more than one line above the last line when the page turned. */
  premature: number;
  /** Reader above the anchor line: the line being read scrolled away. */
  unsafe: number;
  missed: number;
  skippedLines: number;
  latencyMedian: number;
  latencyP90: number;
  driftError: number;
  rules: Record<string, number>;
  unfinished: number;
}

export function summarizeSessions(runs: readonly SessionResult[]): SessionSummary {
  const all = runs.flatMap((r) => r.turns);
  const auto = all.filter((t) => !t.manual);
  const rules: Record<string, number> = {};
  for (const t of all) rules[t.reason] = (rules[t.reason] ?? 0) + 1;
  const lat = auto.map((t) => t.latency).filter(Number.isFinite);
  const sum = (f: (r: SessionResult) => number): number => runs.reduce((a, r) => a + f(r), 0);
  return {
    sessions: runs.length,
    turns: all.length,
    onLine: sum((r) => r.onLine) / Math.max(1, sum((r) => r.fixations)),
    onLineMin: Math.min(...runs.map((r) => r.onLine / Math.max(1, r.fixations))),
    onLineAfterTurn: sum((r) => r.onLineAfterTurn) / Math.max(1, sum((r) => r.fixationsAfterTurn)),
    premature: auto.filter((t) => t.readerVsL < -1).length,
    unsafe: auto.filter((t) => t.readerVsTarget < 0).length,
    missed: all.filter((t) => t.manual).length,
    skippedLines: sum((r) => r.skipped),
    latencyMedian: quantile(lat, 0.5),
    latencyP90: quantile(lat, 0.9),
    driftError: mean(all.map((t) => t.driftError).filter(Number.isFinite)),
    rules,
    unfinished: runs.filter((r) => !r.finished).length,
  };
}
