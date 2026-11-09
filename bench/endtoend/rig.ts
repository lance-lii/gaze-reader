/**
 * The end-to-end rig: World frames through the app's real gaze and decision code, wired the way
 * src/app/controller.ts wires it (without the DOM), and scored against the world's ground truth.
 *
 *   World frame → extractEyeFeatures/frameQuality (as faceTracker.processFrame does)
 *     → AppearanceMonitor (eyelids) → AppearanceChangeFilter → LineTracker.appearanceChangedAt
 *     → WebcamGazeSource (blink gate, plausibility, One Euro) → FixationDetector → LineTracker
 *     → PageEndDetector → page turn (anchor line to the top, resume line, cooldown, 650-ms scroll
 *       during which the pipeline is blocked, as ScrollController/afterJump do)
 *   DriftWatch + GuidanceGate → a 5-dot refresh offer at a pause; the simulated reader accepts it
 *   (refineGazeModel on 5 dots at today's posture; the reading layer re-learns its offset).
 *   A reader who has finished the page and waited 8 s without a turn turns it by hand: a miss.
 *
 * Scoring (truth from the World):
 *   intended turn  — the reader had finished the page's last line (lingering).
 *   premature turn — anything else: an unintended turn. "Unsafe" when the line being read
 *                    scrolls out of view (the reader loses their place).
 *   latency        — finished the last line → turn (time spent looking away excluded).
 *   gaze error     — smoothed gaze vs where the eyes really look, valid samples while reading.
 *   CPU            — wall time per frame in the app's code (features → decision); MediaPipe's own
 *                    inference isn't simulated and isn't included.
 */
import type { FeatureFrame, FeatureSource, GazeModel, GazeSample, LineEstimate, Unsubscribe } from '../../src/types';
import { FEATURE_NAMES, frameQuality } from '../../src/gaze/features';
import { refineGazeModel, trainGazeModel } from '../../src/gaze/calibrationModel';
import { WebcamGazeSource } from '../../src/gaze/webcamGazeSource';
import { AppearanceMonitor } from '../../src/gaze/appearance';
import { FixationDetector } from '../../src/signal/fixations';
import { LineTracker, isTrackedLineEstimate } from '../../src/reading/lineTracker';
import { PageEndDetector } from '../../src/reading/pageEndDetector';
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
import { PITCH, World, type Scenario, type Truth } from './world';

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
}

/** Ways the rig can be varied (A/B of a candidate change without editing the app). */
export interface RigOptions {
  detector?: () => PageEndDetector;
}

export function runSession(scenario: Scenario, seed: number, opts: { minutes?: number } & RigOptions = {}): SessionMetrics {
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
  const detector = opts.detector ? opts.detector() : new PageEndDetector();
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
    turns.push({
      t,
      reason,
      kind: manual ? 'missed' : unsafe || readerVsL < -1 ? 'false' : 'intended',
      unsafe,
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
    detector.notifyScrolled(t);
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
  });
  void gazeSource.start();

  let frames = 0;
  for (let wf = world.next(); wf && !done; wf = world.next()) {
    frames++;
    clock = wf.t;
    truth = wf.truth;
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
  return {
    errFirst15: quantile(window15(gazeErr, gazeErrT, true), 0.5),
    errLast15: quantile(window15(gazeErr, gazeErrT, false), 0.5),
    cpuFirst15: meanOf(window15(cpu, cpuT, true)),
    cpuLast15: meanOf(window15(cpu, cpuT, false)),
    scenario: scenario.name,
    seed,
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

// ───────────────────────────────── Summaries ─────────────────────────────────

export interface Summary {
  scenario: string;
  hours: number;
  pages: number;
  autoTurns: number;
  /** Unintended turns per hour, and those that lost the reader's place. */
  falsePerHour: number;
  unsafePerHour: number;
  /** Missed turns, % of pages. */
  missedPct: number;
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
  /** What was going on at the unintended turns. */
  falseCauses: Record<string, number>;
}

export function quantile(a: ArrayLike<number>, q: number): number {
  const s = Float64Array.from(a).filter(Number.isFinite).sort();
  if (s.length === 0) return NaN;
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]!;
}

function concat(parts: readonly Float64Array[]): Float64Array {
  const out = new Float64Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function summarize(runs: readonly SessionMetrics[]): Summary {
  const hours = runs.reduce((a, r) => a + r.minutes, 0) / 60;
  const turns = runs.flatMap((r) => r.turns);
  const premature = turns.filter((t) => t.kind === 'false');
  const intended = turns.filter((t) => t.kind === 'intended');
  const missed = turns.filter((t) => t.kind === 'missed');
  const pages = intended.length + missed.length;
  const err = concat(runs.map((r) => r.gazeErrPx));
  const verr = concat(runs.map((r) => r.vErrLines));
  const cpu = concat(runs.map((r) => r.cpuUs));
  const causes: Record<string, number> = {};
  for (const t of premature) {
    const key = t.otherFace ? 'second-face' : t.active.filter((a) => a !== 'blink').join('+') || 'reading';
    causes[`${key} (${t.reason})`] = (causes[`${key} (${t.reason})`] ?? 0) + 1;
  }
  const fixations = runs.reduce((a, r) => a + r.fixations, 0);
  return {
    scenario: runs[0]?.scenario ?? '',
    hours,
    pages,
    autoTurns: intended.length + premature.length,
    falsePerHour: premature.length / hours,
    unsafePerHour: premature.filter((t) => t.unsafe).length / hours,
    missedPct: pages ? (100 * missed.length) / pages : NaN,
    latencyP50: quantile(intended.map((t) => t.latencyMs), 0.5),
    latencyP90: quantile(intended.map((t) => t.latencyMs), 0.9),
    errP50: quantile(err, 0.5),
    errP90: quantile(err, 0.9),
    errP99: quantile(err, 0.99),
    vErrP50: quantile(verr, 0.5),
    onLinePct: fixations ? (100 * runs.reduce((a, r) => a + r.onLine, 0)) / fixations : NaN,
    promptsPerHour: runs.reduce((a, r) => a + r.prompts, 0) / hours,
    calibrationErrPx: runs.reduce((a, r) => a + r.calibrationErrPx, 0) / runs.length,
    cpuMeanUs: cpu.reduce((a, v) => a + v, 0) / Math.max(1, cpu.length),
    cpuP99Us: quantile(cpu, 0.99),
    errFirst15: avg(runs.map((r) => r.errFirst15)),
    errLast15: avg(runs.map((r) => r.errLast15)),
    cpuFirst15: avg(runs.map((r) => r.cpuFirst15)),
    cpuLast15: avg(runs.map((r) => r.cpuLast15)),
    falseCauses: causes,
  };
}

function avg(a: readonly number[]): number {
  const v = a.filter(Number.isFinite);
  return v.length ? v.reduce((x, y) => x + y, 0) / v.length : NaN;
}

const f1 = (v: number, d = 1): string => (Number.isFinite(v) ? v.toFixed(d) : '–');

export function summaryTable(rows: readonly Summary[]): string {
  const head = [
    'scenario',
    'hours',
    'pages',
    'false/h',
    'unsafe/h',
    'missed %',
    'latency p50/p90 ms',
    'gaze err p50/p90/p99 px',
    'err first/last 15 min',
    'on line %',
    'prompts/h',
    'CPU µs/frame (mean/p99)',
  ];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const s of rows) {
    lines.push(
      `| ${[
        s.scenario,
        f1(s.hours),
        String(s.pages),
        f1(s.falsePerHour, 2),
        f1(s.unsafePerHour, 2),
        f1(s.missedPct),
        `${f1(s.latencyP50, 0)} / ${f1(s.latencyP90, 0)}`,
        `${f1(s.errP50, 0)} / ${f1(s.errP90, 0)} / ${f1(s.errP99, 0)}`,
        `${f1(s.errFirst15, 0)} / ${f1(s.errLast15, 0)}`,
        f1(s.onLinePct),
        f1(s.promptsPerHour, 2),
        `${f1(s.cpuMeanUs, 0)} / ${f1(s.cpuP99Us, 0)}`,
      ].join(' | ')} |`,
    );
  }
  return lines.join('\n');
}
