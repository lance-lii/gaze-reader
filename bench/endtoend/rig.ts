/**
 * The end-to-end rig: World frames through the app's real gaze and decision code, wired the way
 * src/app/controller.ts wires it (without the DOM), and scored against the world's ground truth.
 *
 *   World frame → extractEyeFeatures/frameQuality (as faceTracker.processFrame does)
 *     → AppearanceMonitor (eyelids) → AppearanceChangeFilter → LineTracker.appearanceChangedAt
 *     → WebcamGazeSource (blink gate, plausibility, One Euro) → FixationDetector → LineTracker
 *     → PageEndDetector → page turn (anchor line to the top, resume line, 650-ms scroll during which
 *       the pipeline is blocked, and the cooldown from the end of the scroll, as ScrollController and
 *       afterJump do)
 *   A reopened book starts the reading layer over (startSession's resetPipeline('auto')); the reader
 *   may first glance at the phone or keyboard (World.arrive), also after a calibration refresh.
 *   DriftWatch + GuidanceGate → a 5-dot refresh offer at a pause; the simulated reader accepts it
 *   (refineGazeModel on 5 dots at today's posture; the reading layer re-learns its offset).
 *   A reader who has finished the page and waited 8 s without a turn turns it by hand: a miss.
 *
 * Scoring (truth from the World):
 *   intended turn  — the reader had finished the page's last line (lingering), or was on it (or the
 *                    line above, kept on screen): "early" then, scored apart.
 *   premature turn — anything else: an unintended turn. "Unsafe" when the line being read
 *                    scrolls out of view (the reader loses their place).
 *   latency        — finished the last line → turn (time spent looking away excluded).
 *   gaze error     — smoothed gaze vs where the eyes really look, valid samples while reading.
 *   CPU            — wall time per frame in the app's code (features → decision); MediaPipe's own
 *                    inference isn't simulated and isn't included.
 */
import type { FeatureFrame, FeatureSource, GazeModel, GazeSample, LineEstimate, LineLayout, PageEndDecision, Sensitivity, Unsubscribe } from '../../src/types';
import { FEATURE_NAMES, frameQuality } from '../../src/gaze/features';
import { refineGazeModel, trainGazeModel } from '../../src/gaze/calibrationModel';
import { WebcamGazeSource } from '../../src/gaze/webcamGazeSource';
import { AppearanceMonitor } from '../../src/gaze/appearance';
import { FixationDetector } from '../../src/signal/fixations';
import { LineTracker, isTrackedLineEstimate } from '../../src/reading/lineTracker';
import { PageEndDetector, type PageEndInput } from '../../src/reading/pageEndDetector';
import {
  AppearanceChangeFilter,
  DriftWatch,
  GuidanceGate,
  PINNED_MAX_DRIFT_SD_LINES,
  PINNED_MIN_PROBABILITY,
  lastFullyVisibleIndex,
  resumeLineIndex,
} from '../../src/app/logic';
import { frameFeatures, VIEW } from '../lighting/faceSim';
import { HARNESS_VERSION, PITCH, World, type Scenario, type Truth } from './world';

const SCROLL_MS = 650; // AppSettings.scrollDurationMs default
const MISS_AFTER_MS = 8000;
const HEARTBEAT_MS = 250;
const OFFER_TTL_MS = 120_000;
const REFRESH_MS = 10_000;
const CAL_MAX_BLINK = 0.85; // the calibration overlay's SAMPLE_MAX_BLINK

/** Feeds FeatureFrames to WebcamGazeSource the way CameraFeatureSource does. */
class PushSource implements FeatureSource {
  running = true;
  private readonly listeners = new Set<(f: FeatureFrame) => void>();
  start(): Promise<void> {
    return Promise.resolve();
  }
  stop(): void {
    this.running = false;
  }
  onFrame(cb: (f: FeatureFrame) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
  push(f: FeatureFrame): void {
    for (const cb of [...this.listeners]) cb(f);
  }
}

export interface TurnRecord {
  t: number;
  reason: string;
  /**
   * intended: the reader was on the last fully visible line (or the one above it, kept on screen)
   * or had finished it. false: two or more lines above it, or the line being read scrolled away.
   * missed: finished, waited 8 s, turned by hand.
   */
  kind: 'intended' | 'false' | 'missed';
  /** The line being read scrolled out of view. */
  unsafe: boolean;
  /** An intended turn made before the reader had finished the last line (on it, or the line above it). */
  early: boolean;
  /** Reader's line − the last fully visible line (0 = on it). */
  readerVsL: number;
  /** Finished the last line → turn, ms (0 when it turned while the reader was still on it). */
  latencyMs: number;
  /** Return sweeps the tracker saw on this page, and how many reaching the last line takes from where it started. */
  sweeps: number;
  sweepsNeeded: number;
  /** The tracker's line probability and drift SD (lines) when it fired. */
  probability: number;
  driftSdLines: number;
  /** What the reader and the camera were doing when it fired. */
  active: string[];
  otherFace: boolean;
}

export interface SessionMetrics {
  scenario: string;
  seed: number;
  sensitivity: Sensitivity;
  minutes: number;
  frames: number;
  turns: TurnRecord[];
  /** |smoothed gaze − truth|, px, valid samples while reading; and |Δy| in lines. */
  gazeErrPx: Float64Array;
  vErrLines: Float64Array;
  /** Calibration accuracy (validation report), px. */
  calibrationErrPx: number;
  fixations: number;
  onLine: number;
  prompts: number;
  /** Valid gaze samples produced while the tracker followed someone else's face. */
  otherFaceValid: number;
  cpuUs: Float64Array;
  /** Median gaze error and mean CPU in the first and last 15 minutes (drift and slow-down over a session). */
  errFirst15: number;
  errLast15: number;
  cpuFirst15: number;
  cpuLast15: number;
  /** JS heap in use, MB (Node only, else NaN): lowest reading around minute 15 and over the last 15 minutes (lowest = after a collection). */
  heapMB15: number;
  heapMBEnd: number;
}

// The project has no Node type definitions; the heap reading goes through a narrow shape.
const heapUsedMB = (): number => {
  const p = (globalThis as { process?: { memoryUsage?: () => { heapUsed: number } } }).process;
  const m = p?.memoryUsage?.();
  return m ? m.heapUsed / 2 ** 20 : NaN;
};

/** One gaze sample through the decision layer, for probes that look inside a session. */
export interface RigStep {
  sample: GazeSample;
  estimate: LineEstimate | null;
  decision: PageEndDecision;
  truth: Truth;
  layout: LineLayout;
  /** Every turn so far (a new one is pushed on the step that made it). */
  turns: readonly TurnRecord[];
}

/** What the rig needs of a page-end detector: the working tree's, or the deployed one (deployedPageEndDetector.ts). */
export interface PageEndDetectorLike {
  update(input: PageEndInput): PageEndDecision;
  notifyScrolled(t: number): void;
  reset(): void;
}

/** Ways the rig can be varied (A/B of a candidate change without editing the app), and looked into. */
export interface RigOptions {
  /** The preset the reader chose (default 'balanced'). */
  sensitivity?: Sensitivity;
  detector?: (sensitivity: Sensitivity) => PageEndDetectorLike;
  onStep?: (step: RigStep) => void;
}

export function runSession(scenario: Scenario, seed: number, opts: { minutes?: number } & RigOptions = {}): SessionMetrics {
  const sensitivity = opts.sensitivity ?? 'balanced';
  const world = new World({ seed, scenario, ...(opts.minutes !== undefined ? { minutes: opts.minutes } : {}) });
  const viewport = { width: VIEW.width, height: VIEW.height };

  // Calibration: 13 dots in today's light (the overlay's grid), trained like the overlay does.
  const trained = trainGazeModel(world.calibrationSamples(seed * 31 + 3), { viewport, maxBlink: CAL_MAX_BLINK, featureNames: FEATURE_NAMES });
  let model: GazeModel = trained.model;

  const camera = new PushSource();
  let clock = 0;
  const gazeSource = new WebcamGazeSource({ features: camera, getModel: () => model, now: () => clock });
  const fixations = new FixationDetector();
  const tracker = new LineTracker();
  tracker.reset({ calibrated: true });
  tracker.setLayout(world.layout, 'initial');
  const detector: PageEndDetectorLike = opts.detector ? opts.detector(sensitivity) : new PageEndDetector({ sensitivity });
  const appearance = new AppearanceMonitor(null);
  appearance.setBaseline(model.environment?.appearance ?? null, null);
  const changes = new AppearanceChangeFilter();
  const driftWatch = new DriftWatch();
  const guidance = new GuidanceGate();
  guidance.startSession(0);

  const maxScroll = world.doc.scrollHeight - (world.layout.viewport.bottom - world.layout.viewport.top);
  const turns: TurnRecord[] = [];
  const gazeErr: number[] = [];
  const gazeErrT: number[] = [];
  const vErr: number[] = [];
  const cpu: number[] = [];
  const cpuT: number[] = [];
  let truth: Truth | null = null;
  let blockedUntil = -Infinity;
  let wasBlocked = false;
  let done = false;
  let fixCount = 0;
  let onLine = 0;
  let prompts = 0;
  let otherFaceValid = 0;
  let nextHeartbeat = HEARTBEAT_MS;
  // Diagnostics: return sweeps on this page, and the line the tracker started the page on.
  let pageSweeps = 0;
  let pageStartDocTop: number | null = null;
  // An object, so the closure that sets the offer and the loop that delivers it share one binding.
  const offer: { pending: { since: number } | null } = { pending: null };
  // Truth history for scoring fixations against the line read at their midpoint.
  const histT: number[] = [];
  const histLine: (number | null)[] = [];
  const histMode: Truth['mode'][] = [];
  const lineAt = (t: number): { line: number | null; mode: Truth['mode'] } => {
    let lo = 0;
    let hi = histT.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (histT[mid]! <= t) lo = mid;
      else hi = mid - 1;
    }
    return { line: histLine[lo] ?? null, mode: histMode[lo] ?? 'idle' };
  };

  const turn = (t: number, targetIndex: number, reason: string, manual: boolean): void => {
    const layout = world.layout;
    const lines = layout.lines;
    const target = targetIndex >= 0 && targetIndex < lines.length ? targetIndex : lastFullyVisibleIndex(lines);
    const anchor = lines[target];
    if (!anchor) return;
    const tr = truth!;
    const lingering = world.reader.mode === 'lingering';
    const readerDocTop = world.reader.lineDocTop;
    const L = lastFullyVisibleIndex(lines);
    const readerIdx = readerDocTop === null ? -1 : lines.findIndex((l) => Math.abs(l.docTop - readerDocTop) < 1);
    const readerVsL = readerIdx < 0 ? -lines.length : readerIdx - L;
    const unsafe = !manual && readerDocTop !== null && readerDocTop < anchor.docTop - 0.5 * PITCH;
    const start = pageStartDocTop;
    const needed = start === null || !lines[L] ? NaN : lines.filter((l) => l.docTop > start + 1 && l.docTop <= lines[L]!.docTop + 1).length;
    const kind = manual ? 'missed' : unsafe || readerVsL < -1 ? 'false' : 'intended';
    turns.push({
      t,
      reason,
      kind,
      unsafe,
      early: kind === 'intended' && !lingering,
      readerVsL,
      latencyMs: lingering && world.reader.lingerStartedAt !== null ? t - world.reader.lingerStartedAt : 0,
      active: [...tr.active],
      otherFace: tr.otherFace,
      sweeps: pageSweeps,
      sweepsNeeded: needed,
      probability: tracker.estimate?.probability ?? NaN,
      driftSdLines: (() => {
        const e = tracker.estimate;
        return isTrackedLineEstimate(e) && e.driftSdY !== undefined ? e.driftSdY / PITCH : NaN;
      })(),
    });
    pageSweeps = 0;
    pageStartDocTop = null;
    const next = Math.min(maxScroll, anchor.docTop - 0.35 * PITCH);
    if (next <= layout.scrollTop + 1) {
      done = true;
      return;
    }
    world.scrollTo(next);
    tracker.setLayout(world.layout, 'page-turn');
    tracker.afterPageTurn(resumeLineIndex(world.layout.lines, anchor.docTop, world.layout.linePitch));
    // The app starts the cooldown when the scroll animation ends (afterJump → notifyScrolled); nothing
    // reaches the detector in between, so telling it now with that time is the same.
    detector.notifyScrolled(t + SCROLL_MS);
    fixations.reset();
    blockedUntil = t + SCROLL_MS;
    guidance.notePageTurn(t);
  };

  const onReadingEstimate = (e: LineEstimate): void => {
    if (e.lineIndex < 0) return;
    guidance.noteReading(e.t);
    const sd = isTrackedLineEstimate(e) ? (e.driftSdY ?? NaN) : NaN;
    const pinned = e.probability >= PINNED_MIN_PROBABILITY && !(sd > PINNED_MAX_DRIFT_SD_LINES * PITCH);
    if (driftWatch.push(e.t, e.driftY, PITCH, pinned) && !offer.pending && guidance.mayOffer(e.t)) offer.pending = { since: e.t };
  };

  gazeSource.onSample((s: GazeSample) => {
    if (done || !truth) return;
    const tr = truth;
    if (s.valid && tr.otherFace) otherFaceValid++;
    const g = tr.gaze;
    if (s.valid && g && !tr.otherFace && (tr.mode === 'reading' || tr.mode === 'lingering') && g.x >= 0 && g.x <= VIEW.width && g.y >= 0 && g.y <= VIEW.height) {
      gazeErr.push(Math.hypot(s.x - g.x, s.y - g.y));
      gazeErrT.push(s.t);
      vErr.push(Math.abs(s.y - g.y) / PITCH);
    }
    if (s.t < blockedUntil) {
      wasBlocked = true;
      return;
    }
    if (wasBlocked) {
      wasBlocked = false;
      fixations.reset();
    }
    const { completed } = fixations.push(s);
    if (completed) {
      const est = tracker.onFixation(completed);
      if (est.lastSaccade === 'return-sweep') pageSweeps++;
      if (pageStartDocTop === null && est.lineIndex >= 0) pageStartDocTop = world.layout.lines[est.lineIndex]?.docTop ?? null;
      const mid = lineAt((completed.start + completed.end) / 2);
      if (mid.mode === 'reading' && mid.line !== null && est.lineIndex >= 0) {
        fixCount++;
        if (Math.abs(world.layout.lines[est.lineIndex]!.docTop - mid.line) < 1) onLine++;
      }
      onReadingEstimate(est);
    }
    tracker.onSample(s);
    const d = detector.update({ t: s.t, gaze: s, estimate: tracker.estimate, layout: world.layout });
    if (d.trigger) turn(s.t, d.targetLineIndex, d.detail.includes('return sweep') ? `${d.reason} (sweep)` : d.reason, false);
    opts.onStep?.({ sample: s, estimate: tracker.estimate, decision: d, truth: tr, layout: world.layout, turns });
  });
  void gazeSource.start();

  let frames = 0;
  const heap: { t: number; mb: number }[] = [];
  for (let wf = world.next(); wf && !done; wf = world.next()) {
    frames++;
    if (Math.floor(wf.t / 60_000) > Math.floor(clock / 60_000)) heap.push({ t: wf.t, mb: heapUsedMB() });
    clock = wf.t;
    truth = wf.truth;
    if (wf.event === 'reopen') {
      // The book was closed and opened again: the camera source starts afresh and startSession runs
      // resetPipeline('auto') (same source and calibration: the drift is kept) and measure('initial').
      gazeSource.stop();
      void gazeSource.start();
      fixations.reset();
      tracker.reset({ keepDrift: true });
      tracker.setLayout(world.layout, 'initial');
      detector.reset();
      driftWatch.reset();
      wasBlocked = false;
      pageSweeps = 0;
      pageStartDocTop = null;
    }
    histT.push(wf.t);
    histLine.push(wf.truth.lineDocTop);
    histMode.push(wf.truth.mode);
    if (histT.length > 4096) {
      histT.splice(0, 2048);
      histLine.splice(0, 2048);
      histMode.splice(0, 2048);
    }

    const c0 = performance.now();
    const features = wf.frame ? frameFeatures(wf.frame) : null;
    const frame: FeatureFrame = wf.frame
      ? { t: wf.t, faceFound: true, features, quality: frameQuality(features) }
      : { t: wf.t, faceFound: false, features: null, quality: 0 };
    // controller.onCameraFrame: the eyelid monitor, at the height the lid-free model says the eyes look.
    const f = frame.faceFound ? frame.features : null;
    const p = f ? model.predict(f) : null;
    const change = appearance.update({ t: frame.t, features: f, quality: frame.quality, gazeYNorm: p ? p.y / model.viewport.height : null });
    if (change && changes.accept('lids', change.t, frame.t)) {
      tracker.appearanceChangedAt(change.t);
      driftWatch.reset();
    }
    camera.push(frame);
    cpu.push(1000 * (performance.now() - c0));
    cpuT.push(wf.t);

    // Heartbeat: deliver a pending refresh offer at a pause (controller.pollGuidance).
    if (wf.t >= nextHeartbeat) {
      nextHeartbeat = wf.t + HEARTBEAT_MS;
      if (offer.pending) {
        if (wf.t - offer.pending.since > OFFER_TTL_MS || !guidance.mayOffer(wf.t)) offer.pending = null;
        else if (guidance.isPause(wf.t)) {
          offer.pending = null;
          prompts++;
          guidance.noteOffered(wf.t);
          // The reader takes the 5-dot refresh (afterCalibration 'refresh', in place).
          model = refineGazeModel(model, world.refreshSamples(), { viewport, maxBlink: CAL_MAX_BLINK }).model;
          appearance.setBaseline(model.environment?.appearance ?? null, null);
          world.hold(REFRESH_MS);
          world.arrive(world.t);
          fixations.reset();
          detector.reset();
          tracker.appearanceChangedAt(world.t);
          driftWatch.reset();
          guidance.noteFixed(world.t);
          continue;
        }
      }
    }
    // Missed: finished the page 8 s ago (away time excluded) and nothing happened.
    const since = world.reader.mode === 'lingering' ? world.reader.lingerStartedAt : null;
    if (since !== null && wf.t - since > MISS_AFTER_MS && wf.t >= blockedUntil) {
      turn(wf.t, lastFullyVisibleIndex(world.layout.lines), 'manual', true);
    }
  }
  gazeSource.stop();

  const endT = world.t;
  const window15 = (values: number[], times: number[], first: boolean): number[] =>
    values.filter((_, i) => (first ? times[i]! < 15 * 60_000 : times[i]! >= endT - 15 * 60_000));
  const meanOf = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const minOf = (a: number[]): number => (a.length ? Math.min(...a) : NaN);
  return {
    heapMB15: minOf(heap.filter((h) => h.t >= 10 * 60_000 && h.t <= 20 * 60_000).map((h) => h.mb)),
    heapMBEnd: minOf(heap.filter((h) => h.t >= endT - 15 * 60_000).map((h) => h.mb)),
    errFirst15: quantile(window15(gazeErr, gazeErrT, true), 0.5),
    errLast15: quantile(window15(gazeErr, gazeErrT, false), 0.5),
    cpuFirst15: meanOf(window15(cpu, cpuT, true)),
    cpuLast15: meanOf(window15(cpu, cpuT, false)),
    scenario: scenario.name,
    seed,
    sensitivity,
    minutes: world.t / 60_000,
    frames,
    turns,
    gazeErrPx: Float64Array.from(gazeErr),
    vErrLines: Float64Array.from(vErr),
    calibrationErrPx: trained.report.meanErrorPx,
    fixations: fixCount,
    onLine,
    prompts,
    otherFaceValid,
    cpuUs: Float64Array.from(cpu),
  };
}

// ───────────────────────────────── Records ─────────────────────────────────

/** A mergeable histogram (fixed bin width): quantiles of millions of values without keeping them. */
export interface Hist {
  step: number;
  n: number;
  counts: Record<string, number>;
}

export const newHist = (step: number): Hist => ({ step, n: 0, counts: {} });

export function histAdd(h: Hist, v: number): void {
  if (!Number.isFinite(v)) return;
  const b = String(Math.floor(v / h.step));
  h.counts[b] = (h.counts[b] ?? 0) + 1;
  h.n++;
}

export function histMerge(into: Hist, from: Hist): Hist {
  for (const [b, c] of Object.entries(from.counts)) into.counts[b] = (into.counts[b] ?? 0) + c;
  into.n += from.n;
  return into;
}

/** The q-quantile (as `quantile` picks it: the value at floor(q·(n − 1))), to the bin's middle. */
export function histQuantile(h: Hist, q: number): number {
  if (h.n === 0) return NaN;
  let k = Math.min(h.n - 1, Math.max(0, Math.floor(q * (h.n - 1))));
  const bins = Object.keys(h.counts).map(Number).sort((a, b) => a - b);
  for (const b of bins) {
    const c = h.counts[String(b)]!;
    if (k < c) return (b + 0.5) * h.step;
    k -= c;
  }
  return (bins[bins.length - 1]! + 0.5) * h.step;
}

const histOf = (a: ArrayLike<number>, step: number): Hist => {
  const h = newHist(step);
  for (let i = 0; i < a.length; i++) histAdd(h, a[i]!);
  return h;
};

/** One session, compact enough to write out and merge (the eval runs sessions in parallel shards). */
export interface SessionRecord {
  version: string;
  /** Scenario name, or a row label ("everyday, 2 h in one go"). */
  scenario: string;
  seed: number;
  sensitivity: Sensitivity;
  /** Which detector ran: 'current' (the working tree), 'deployed', or a baseline's label. */
  detector: string;
  minutes: number;
  frames: number;
  turns: TurnRecord[];
  calibrationErrPx: number;
  fixations: number;
  onLine: number;
  prompts: number;
  otherFaceValid: number;
  errFirst15: number;
  errLast15: number;
  cpuFirst15: number;
  cpuLast15: number;
  heapMB15: number;
  heapMBEnd: number;
  gazeErrPx: Hist;
  vErrLines: Hist;
  cpuUs: Hist;
}

export function toRecord(m: SessionMetrics, opts: { label?: string; detector?: string } = {}): SessionRecord {
  return {
    version: HARNESS_VERSION,
    scenario: opts.label ?? m.scenario,
    seed: m.seed,
    sensitivity: m.sensitivity,
    detector: opts.detector ?? 'current',
    minutes: m.minutes,
    frames: m.frames,
    turns: m.turns,
    calibrationErrPx: m.calibrationErrPx,
    fixations: m.fixations,
    onLine: m.onLine,
    prompts: m.prompts,
    otherFaceValid: m.otherFaceValid,
    errFirst15: m.errFirst15,
    errLast15: m.errLast15,
    cpuFirst15: m.cpuFirst15,
    cpuLast15: m.cpuLast15,
    heapMB15: m.heapMB15,
    heapMBEnd: m.heapMBEnd,
    gazeErrPx: histOf(m.gazeErrPx, 1),
    vErrLines: histOf(m.vErrLines, 0.01),
    cpuUs: histOf(m.cpuUs, 1),
  };
}

// ───────────────────────────────── Summaries ─────────────────────────────────

/** Per-seed tallies, for confidence intervals. */
export interface SeedTally {
  seed: number;
  hours: number;
  falses: number;
  pages: number;
  missed: number;
}

export interface Summary {
  scenario: string;
  sensitivity: Sensitivity | 'mixed';
  detector: string;
  hours: number;
  pages: number;
  autoTurns: number;
  /** Unintended turns per hour (± 95 % half-width), and those that lost the reader's place. */
  falsePerHour: number;
  falseCI: number;
  unsafePerHour: number;
  /** Missed turns, % of pages (± 95 % half-width, points). */
  missedPct: number;
  missedCI: number;
  /** Intended turns made before the reader had finished the last line, % of intended turns. */
  earlyPct: number;
  latencyP50: number;
  latencyP90: number;
  errP50: number;
  errP90: number;
  errP99: number;
  vErrP50: number;
  onLinePct: number;
  promptsPerHour: number;
  calibrationErrPx: number;
  cpuMeanUs: number;
  cpuP99Us: number;
  /** Mean over runs of the first/last 15-minute medians (error, px) and means (CPU, µs). */
  errFirst15: number;
  errLast15: number;
  cpuFirst15: number;
  cpuLast15: number;
  /** JS heap in use, MB, around minute 15 and at the end (mean over runs). */
  heapMB15: number;
  heapMBEnd: number;
  /** What was going on at the unintended turns. */
  falseCauses: Record<string, number>;
  seeds: SeedTally[];
}

export function quantile(a: ArrayLike<number>, q: number): number {
  const s = Float64Array.from(a).filter(Number.isFinite).sort();
  if (s.length === 0) return NaN;
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]!;
}

const isRecord = (r: SessionMetrics | SessionRecord): r is SessionRecord => 'version' in r;

/** Sample variance (k − 1), 0 for fewer than two values. */
function variance(v: readonly number[]): number {
  if (v.length < 2) return 0;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1);
}

/**
 * Standard errors of a rate (events per hour) and a proportion (missed pages), over seeds. The
 * larger of the counting error (Poisson, binomial) and the spread between seeds: decisions in one
 * session are not independent (one change sends the reader down another path), so neither alone is honest.
 */
export function rateSE(seeds: readonly SeedTally[], pick: (s: SeedTally) => number): number {
  const hours = seeds.reduce((a, s) => a + s.hours, 0);
  if (!(hours > 0)) return NaN;
  const events = seeds.reduce((a, s) => a + pick(s), 0);
  const poisson = Math.max(events, 1) / hours ** 2;
  const between = variance(seeds.filter((s) => s.hours > 0).map((s) => pick(s) / s.hours)) / seeds.length;
  return Math.sqrt(Math.max(poisson, between));
}

export function missedSE(seeds: readonly SeedTally[]): number {
  const pages = seeds.reduce((a, s) => a + s.pages, 0);
  if (!(pages > 0)) return NaN;
  const missed = seeds.reduce((a, s) => a + s.missed, 0);
  const q = (missed + 0.5) / (pages + 1);
  const binomial = (q * (1 - q)) / pages;
  const between = variance(seeds.filter((s) => s.pages > 0).map((s) => s.missed / s.pages)) / seeds.length;
  return Math.sqrt(Math.max(binomial, between));
}

export function summarize(runs: readonly (SessionMetrics | SessionRecord)[]): Summary {
  const recs = runs.map((r) => (isRecord(r) ? r : toRecord(r)));
  const hours = recs.reduce((a, r) => a + r.minutes, 0) / 60;
  const turns = recs.flatMap((r) => r.turns);
  const premature = turns.filter((t) => t.kind === 'false');
  const intended = turns.filter((t) => t.kind === 'intended');
  const missed = turns.filter((t) => t.kind === 'missed');
  const pages = intended.length + missed.length;
  const err = recs.reduce((h, r) => histMerge(h, r.gazeErrPx), newHist(1));
  const verr = recs.reduce((h, r) => histMerge(h, r.vErrLines), newHist(0.01));
  const cpu = recs.reduce((h, r) => histMerge(h, r.cpuUs), newHist(1));
  const cpuMean = Object.entries(cpu.counts).reduce((a, [b, c]) => a + (Number(b) + 0.5) * c, 0) / Math.max(1, cpu.n);
  const causes: Record<string, number> = {};
  for (const t of premature) {
    const key = t.otherFace ? 'second-face' : t.active.filter((a) => a !== 'blink').join('+') || 'reading';
    causes[`${key} (${t.reason})`] = (causes[`${key} (${t.reason})`] ?? 0) + 1;
  }
  const fixations = recs.reduce((a, r) => a + r.fixations, 0);
  const bySeed = new Map<number, SeedTally>();
  for (const r of recs) {
    const s = bySeed.get(r.seed) ?? { seed: r.seed, hours: 0, falses: 0, pages: 0, missed: 0 };
    s.hours += r.minutes / 60;
    s.falses += r.turns.filter((t) => t.kind === 'false').length;
    s.missed += r.turns.filter((t) => t.kind === 'missed').length;
    s.pages += r.turns.filter((t) => t.kind !== 'false').length;
    bySeed.set(r.seed, s);
  }
  const seeds = [...bySeed.values()].sort((a, b) => a.seed - b.seed);
  const sens = new Set(recs.map((r) => r.sensitivity));
  return {
    scenario: recs[0]?.scenario ?? '',
    sensitivity: sens.size === 1 ? [...sens][0]! : 'mixed',
    detector: recs[0]?.detector ?? '',
    hours,
    pages,
    autoTurns: intended.length + premature.length,
    falsePerHour: premature.length / hours,
    falseCI: 1.96 * rateSE(seeds, (s) => s.falses),
    unsafePerHour: premature.filter((t) => t.unsafe).length / hours,
    missedPct: pages ? (100 * missed.length) / pages : NaN,
    missedCI: 100 * 1.96 * missedSE(seeds),
    earlyPct: intended.length ? (100 * intended.filter((t) => t.early).length) / intended.length : NaN,
    latencyP50: quantile(intended.map((t) => t.latencyMs), 0.5),
    latencyP90: quantile(intended.map((t) => t.latencyMs), 0.9),
    errP50: histQuantile(err, 0.5),
    errP90: histQuantile(err, 0.9),
    errP99: histQuantile(err, 0.99),
    vErrP50: histQuantile(verr, 0.5),
    onLinePct: fixations ? (100 * recs.reduce((a, r) => a + r.onLine, 0)) / fixations : NaN,
    promptsPerHour: recs.reduce((a, r) => a + r.prompts, 0) / hours,
    calibrationErrPx: recs.reduce((a, r) => a + r.calibrationErrPx, 0) / recs.length,
    cpuMeanUs: cpuMean,
    cpuP99Us: histQuantile(cpu, 0.99),
    errFirst15: avg(recs.map((r) => r.errFirst15)),
    errLast15: avg(recs.map((r) => r.errLast15)),
    cpuFirst15: avg(recs.map((r) => r.cpuFirst15)),
    cpuLast15: avg(recs.map((r) => r.cpuLast15)),
    heapMB15: avg(recs.map((r) => r.heapMB15)),
    heapMBEnd: avg(recs.map((r) => r.heapMBEnd)),
    falseCauses: causes,
    seeds,
  };
}

function avg(a: readonly number[]): number {
  const v = a.filter(Number.isFinite);
  return v.length ? v.reduce((x, y) => x + y, 0) / v.length : NaN;
}

const f1 = (v: number, d = 1): string => (Number.isFinite(v) ? v.toFixed(d) : '–');
const pm = (v: number, ci: number, d = 1): string => (Number.isFinite(ci) ? `${f1(v, d)} ± ${f1(ci, d)}` : f1(v, d));

export function summaryTable(rows: readonly Summary[]): string {
  const head = [
    'scenario',
    'hours',
    'pages',
    'false/h (± 95 %)',
    'unsafe/h',
    'missed % (± 95 %)',
    'early %',
    'latency p50/p90 ms',
    'gaze err p50/p90/p99 px',
    'err first/last 15 min',
    'on line %',
    'prompts/h',
    'CPU µs/frame (mean/p99)',
    'heap MB 15 min / end',
  ];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const s of rows) {
    lines.push(
      `| ${[
        s.scenario,
        f1(s.hours),
        String(s.pages),
        pm(s.falsePerHour, s.falseCI, 2),
        f1(s.unsafePerHour, 2),
        pm(s.missedPct, s.missedCI),
        f1(s.earlyPct, 0),
        `${f1(s.latencyP50, 0)} / ${f1(s.latencyP90, 0)}`,
        `${f1(s.errP50, 0)} / ${f1(s.errP90, 0)} / ${f1(s.errP99, 0)}`,
        `${f1(s.errFirst15, 0)} / ${f1(s.errLast15, 0)}`,
        f1(s.onLinePct),
        f1(s.promptsPerHour, 2),
        `${f1(s.cpuMeanUs, 0)} / ${f1(s.cpuP99Us, 0)}`,
        `${f1(s.heapMB15, 0)} / ${f1(s.heapMBEnd, 0)}`,
      ].join(' | ')} |`,
    );
  }
  return lines.join('\n');
}

/** Before → after for one row: differences with 95 % intervals, and what the change trades. */
export interface Delta {
  scenario: string;
  hours: number;
  falseBefore: number;
  falseAfter: number;
  /** after − before, unintended turns per hour, and its 95 % half-width. */
  dFalse: number;
  dFalseCI: number;
  missedBefore: number;
  missedAfter: number;
  /** after − before, points of pages missed, and its 95 % half-width. */
  dMissed: number;
  dMissedCI: number;
  /** Extra missed pages per hour for each unintended turn per hour prevented (NaN unless it prevents some). */
  missedPerPrevented: number;
}

export function delta(before: Summary, after: Summary): Delta {
  const missedPerHour = (s: Summary): number => s.seeds.reduce((a, x) => a + x.missed, 0) / s.hours;
  const se = (a: number, b: number): number => Math.sqrt(a * a + b * b);
  const dFalse = after.falsePerHour - before.falsePerHour;
  return {
    scenario: after.scenario,
    hours: after.hours,
    falseBefore: before.falsePerHour,
    falseAfter: after.falsePerHour,
    dFalse,
    dFalseCI: 1.96 * se(rateSE(before.seeds, (s) => s.falses), rateSE(after.seeds, (s) => s.falses)),
    missedBefore: before.missedPct,
    missedAfter: after.missedPct,
    dMissed: after.missedPct - before.missedPct,
    dMissedCI: 100 * 1.96 * se(missedSE(before.seeds), missedSE(after.seeds)),
    missedPerPrevented: dFalse < 0 ? (missedPerHour(after) - missedPerHour(before)) / -dFalse : NaN,
  };
}

const signed = (v: number, d = 1): string => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(d)}` : '–');

export function deltaTable(rows: readonly Delta[]): string {
  const head = ['scenario', 'hours', 'false/h before → after', 'Δ false/h (95 % CI)', 'missed % before → after', 'Δ missed points (95 % CI)', 'missed pages per unintended turn prevented'];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const d of rows) {
    lines.push(
      `| ${[
        d.scenario,
        f1(d.hours),
        `${f1(d.falseBefore, 2)} → ${f1(d.falseAfter, 2)}`,
        `${signed(d.dFalse, 2)} (${signed(d.dFalse - d.dFalseCI, 2)} … ${signed(d.dFalse + d.dFalseCI, 2)})`,
        `${f1(d.missedBefore)} → ${f1(d.missedAfter)}`,
        `${signed(d.dMissed)} (${signed(d.dMissed - d.dMissedCI)} … ${signed(d.dMissed + d.dMissedCI)})`,
        Number.isFinite(d.missedPerPrevented) ? d.missedPerPrevented.toFixed(2) : '–',
      ].join(' | ')} |`,
    );
  }
  return lines.join('\n');
}
