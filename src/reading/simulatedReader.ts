import type { GazeSample, GazeSource, GazeSourceKind, LineLayout, TextLine, Unsubscribe } from '../types';
import { OneEuroFilter2D } from '../signal/oneEuro';

/**
 * A synthetic reader: realistic eye movements over a LineLayout, seen through
 * a webcam-like sensor (Gaussian noise, slow vertical drift, optional blinks,
 * One Euro smoothing). Drives demo mode (`SimulatedReaderSource`, which
 * follows the live layout across page turns) and the tests (`simulateReading`).
 *
 * Eye-movement model (typical adult reading figures): the first fixation of a
 * line lands 3–5 characters in; forward saccades ~N(7.5, 2) characters; ~10 %
 * short regressions; fixations ~N(225, 60) ms, scaled to the requested words
 * per minute (≈ 6 characters per word) and clamped to 100–500 ms; saccades
 * take 30–40 ms; return sweeps undershoot (land 5–9 characters in) and are
 * usually followed by a small corrective saccade to the left. At the end of the
 * last line the reader lingers (re-fixating the end, now and then glancing left
 * for a next line or down past the page) until the page turns.
 */

// ─────────────────────────────────── PRNG ───────────────────────────────────

/** mulberry32: tiny, fast, seedable PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal deviate (Box–Muller). */
export function gaussian(rng: () => number): number {
  let u = 0;
  while (u <= Number.EPSILON) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// ───────────────────────────────── Eye model ─────────────────────────────────

/**
 * Words per minute the model reads at with unscaled durations (measured on a
 * 62-character column, see simulatedReader.test.ts); durations scale by
 * NATURAL_WPM / wpm.
 */
export const NATURAL_WPM = 245;

type Anchor =
  | { kind: 'text'; docTop: number; char: number; dyPx: number }
  | { kind: 'screen'; x: number; y: number };

interface Segment {
  kind: 'fix' | 'sacc';
  t0: number;
  t1: number;
  from: Anchor;
  to: Anchor;
}

export type SimulatedReaderMode = 'idle' | 'reading' | 'lingering';

export interface SimulatedReaderState {
  mode: SimulatedReaderMode;
  /** docTop of the line being read (or lingered on); null when idle. */
  lineDocTop: number | null;
  /** docTop of the last line read to its end; null if none yet. */
  lastReadDocTop: number | null;
  /** Lines read to their end so far. */
  linesRead: number;
}

interface GazeTruth {
  x: number;
  y: number;
  /** Index (in the layout passed to `advance`) of the line being read; -1 if unknown. */
  lineIndex: number;
}

interface BrainOptions {
  wpm: () => number;
  /** Offline mode (static layout): first and last line indices to read. */
  startLine?: number;
  endLine?: number;
}

/** Plans eye movements segment by segment against whatever layout is current. */
class ReaderBrain {
  mode: SimulatedReaderMode = 'idle';
  lineDocTop: number | null = null;
  lastReadDocTop: number | null = null;
  linesRead = 0;
  /** End of the last reading fixation on the final line, i.e. when lingering began. */
  lingerStartedAt: number | null = null;

  private queue: Segment[] = [];
  private charPos = 0;
  private maxChar = 0;
  private pendingCorrective = false;
  private lingerSteps = 0;
  private lastGlance = false;
  private lastScrollTop: number | null = null;
  private lastPoint: { x: number; y: number } | null = null;
  private started = false;

  constructor(
    private readonly rng: () => number,
    private readonly opts: BrainOptions,
  ) {}

  get state(): SimulatedReaderState {
    return { mode: this.mode, lineDocTop: this.lineDocTop, lastReadDocTop: this.lastReadDocTop, linesRead: this.linesRead };
  }

  /** Pause the reader: the whole plan moves `ms` later (the timer was throttled). */
  shift(ms: number): void {
    if (!(ms > 0)) return;
    this.queue = this.queue.map((s) => ({ ...s, t0: s.t0 + ms, t1: s.t1 + ms }));
    if (this.lingerStartedAt !== null) this.lingerStartedAt += ms;
  }

  advance(t: number, layout: LineLayout | null): GazeTruth | null {
    if (!layout || layout.lines.length === 0) {
      this.mode = 'idle';
      this.queue = [];
      return null;
    }
    this.followScroll(t, layout);
    if (this.mode === 'idle' || this.queue.length === 0) this.resume(t, layout);
    for (let guard = 0; guard < 10_000 && this.queue.length > 0; guard++) {
      const head = this.queue[0]!;
      if (t < head.t1) break;
      this.queue.shift();
      if (this.queue.length === 0) this.plan(head.t1, layout, head.to);
    }
    const seg = this.queue[0];
    if (!seg) return null;
    const p = position(seg, t, layout);
    this.lastPoint = p;
    const idx = this.lineDocTop === null ? -1 : findLine(layout, this.lineDocTop);
    return { x: p.x, y: p.y, lineIndex: idx };
  }

  private followScroll(t: number, layout: LineLayout): void {
    const prev = this.lastScrollTop;
    this.lastScrollTop = layout.scrollTop;
    if (prev === null || Math.abs(layout.scrollTop - prev) < 1 || this.mode === 'idle') return;
    const idx = this.lineDocTop === null ? -1 : findLine(layout, this.lineDocTop);
    const stillReadable = idx >= 0 && layout.lines[idx]!.fullyVisible;
    if (this.mode === 'lingering' || !stillReadable) this.resume(t, layout);
  }

  /** Start reading at the first fully visible line below the last line read (else the top of the page). */
  private resume(t: number, layout: LineLayout): void {
    const lines = layout.lines;
    let target: TextLine | undefined;
    if (!this.started && this.opts.startLine !== undefined) {
      target = lines[Math.min(Math.max(0, Math.floor(this.opts.startLine)), lines.length - 1)];
    } else {
      const after = this.lastReadDocTop;
      target = lines.find((l) => l.fullyVisible && (after === null || l.docTop > after + 0.5));
      target ??= lines.find((l) => l.fullyVisible);
    }
    if (!target) {
      this.mode = 'idle';
      this.queue = [];
      return;
    }
    const first = !this.started || !this.lastPoint;
    this.started = true;
    this.mode = 'reading';
    this.lineDocTop = target.docTop;
    this.lingerStartedAt = null;
    this.pendingCorrective = false;
    const land = 3 + 2 * this.rng();
    this.charPos = land;
    this.maxChar = land;
    const to = textAnchor(target, land);
    if (first) {
      this.queue = [{ kind: 'fix', t0: t, t1: t + this.fixDuration(250, 60), from: to, to }];
    } else {
      this.queue = [];
      this.saccadeThenFix(t, { kind: 'screen', ...this.lastPoint! }, to, 55, this.fixDuration(250, 60));
    }
  }

  private plan(t: number, layout: LineLayout, here: Anchor): void {
    if (this.mode === 'lingering') {
      this.planLinger(t, layout, here);
      return;
    }
    const idx = this.lineDocTop === null ? -1 : findLine(layout, this.lineDocTop);
    if (idx < 0) {
      this.resume(t, layout);
      return;
    }
    const line = layout.lines[idx]!;
    const n = Math.max(1, line.charCount);

    if (this.pendingCorrective) {
      this.pendingCorrective = false;
      const target = Math.min(this.charPos, 1 + 2 * this.rng());
      this.charPos = target;
      this.saccadeThenFix(t, here, textAnchor(line, target), 30, this.fixDuration(200, 50));
      return;
    }
    if (this.rng() < 0.1 && this.charPos > 8 && this.charPos < n - 3) {
      const target = Math.max(0.5, this.charPos - Math.max(1.5, 4 + 1.5 * gaussian(this.rng)));
      this.charPos = target;
      this.saccadeThenFix(t, here, textAnchor(line, target), 30, this.fixDuration(225, 60));
      return;
    }
    let next = this.maxChar + Math.max(2, 7.5 + 2 * gaussian(this.rng));
    if (next > n - 1) {
      if (this.maxChar >= n - 5) {
        this.finishLine(t, layout, idx, here);
        return;
      }
      next = n - 1 - 2.5 * this.rng();
    }
    this.charPos = next;
    this.maxChar = Math.max(this.maxChar, next);
    this.saccadeThenFix(t, here, textAnchor(line, next), 30 + 10 * this.rng(), this.fixDuration(225, 60));
  }

  private finishLine(t: number, layout: LineLayout, idx: number, here: Anchor): void {
    const line = layout.lines[idx]!;
    this.lastReadDocTop = line.docTop;
    this.linesRead++;
    const nextLine = layout.lines[idx + 1];
    const endLine = this.opts.endLine;
    if (nextLine && nextLine.fullyVisible && (endLine === undefined || idx < endLine)) {
      const land = 5 + 4 * this.rng();
      this.lineDocTop = nextLine.docTop;
      this.charPos = land;
      this.maxChar = land;
      this.pendingCorrective = this.rng() < 0.75;
      this.saccadeThenFix(t, here, textAnchor(nextLine, land), 40 + 10 * this.rng(), this.fixDuration(180, 40));
      return;
    }
    this.mode = 'lingering';
    this.lingerStartedAt = t;
    this.lingerSteps = 0;
    this.lastGlance = false;
    this.planLinger(t, layout, here);
  }

  private planLinger(t: number, layout: LineLayout, here: Anchor): void {
    const idx = this.lineDocTop === null ? -1 : findLine(layout, this.lineDocTop);
    if (idx < 0) {
      this.resume(t, layout);
      return;
    }
    const line = layout.lines[idx]!;
    const n = Math.max(1, line.charCount);
    const pitch = layout.linePitch > 0 ? layout.linePitch : 40;
    const leftChance = this.lingerSteps === 0 ? 0.3 : 0.15;
    const downChance = 0.1;
    this.lingerSteps++;
    const r = this.rng();
    if (this.lastGlance || r >= leftChance + downChance) {
      this.lastGlance = false;
      const target = Math.max(0, n - 0.5 - 5.5 * this.rng());
      this.charPos = target;
      this.saccadeThenFix(t, here, textAnchor(line, target), 30 + 10 * this.rng(), this.fixDuration(320, 90));
    } else if (r < leftChance) {
      // Looking for the next line that isn't there: a return-sweep-like glance.
      this.lastGlance = true;
      const to: Anchor = { kind: 'text', docTop: line.docTop, char: 2 + 8 * this.rng(), dyPx: (0.4 + 0.7 * this.rng()) * pitch };
      this.saccadeThenFix(t, here, to, 45, this.fixDuration(260, 60));
    } else {
      this.lastGlance = true;
      const to: Anchor = { kind: 'text', docTop: line.docTop, char: n * (0.3 + 0.6 * this.rng()), dyPx: (1.6 + 1.9 * this.rng()) * pitch };
      this.saccadeThenFix(t, here, to, 45, 300 + 600 * this.rng());
    }
  }

  private saccadeThenFix(t: number, from: Anchor, to: Anchor, saccMs: number, fixMs: number): void {
    this.queue.push({ kind: 'sacc', t0: t, t1: t + saccMs, from, to }, { kind: 'fix', t0: t + saccMs, t1: t + saccMs + fixMs, from: to, to });
  }

  private fixDuration(mean: number, sd: number): number {
    const wpm = this.opts.wpm();
    const scale = Number.isFinite(wpm) && wpm > 0 ? NATURAL_WPM / wpm : 1;
    return Math.min(500, Math.max(100, (mean + sd * gaussian(this.rng)) * scale));
  }
}

function textAnchor(line: TextLine, char: number): Anchor {
  return { kind: 'text', docTop: line.docTop, char, dyPx: 0 };
}

function findLine(layout: LineLayout, docTop: number): number {
  const tol = 0.5 * (layout.linePitch > 0 ? layout.linePitch : 40);
  let best = -1;
  let bestD = tol;
  const lines = layout.lines;
  for (let i = 0; i < lines.length; i++) {
    const d = Math.abs(lines[i]!.docTop - docTop);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

function resolve(a: Anchor, layout: LineLayout): { x: number; y: number } {
  if (a.kind === 'screen') return { x: a.x, y: a.y };
  const idx = findLine(layout, a.docTop);
  if (idx >= 0) {
    const l = layout.lines[idx]!;
    const cw = (l.right - l.left) / Math.max(1, l.charCount);
    return { x: l.left + a.char * cw, y: l.centerY + a.dyPx };
  }
  // The line left the measured band: extrapolate from the scroll position.
  const colW = layout.column.right - layout.column.left;
  const pitch = layout.linePitch > 0 ? layout.linePitch : 40;
  return {
    x: layout.column.left + a.char * (colW > 0 ? colW / 62 : 11),
    y: a.docTop - layout.scrollTop + layout.viewport.top + 0.3 * pitch + a.dyPx,
  };
}

function position(seg: Segment, t: number, layout: LineLayout): { x: number; y: number } {
  const b = resolve(seg.to, layout);
  if (seg.kind === 'fix') return b;
  const a = resolve(seg.from, layout);
  const u = seg.t1 > seg.t0 ? Math.min(1, Math.max(0, (t - seg.t0) / (seg.t1 - seg.t0))) : 1;
  const s = u * u * (3 - 2 * u);
  return { x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s };
}

// ─────────────────────────────────── Sensor ───────────────────────────────────

export type DriftOnset = 'gradual' | 'immediate';

interface SensorOptions {
  noisePx: number;
  driftPx: number;
  driftOnset: DriftOnset;
  wanderPx: number;
  blinksPerMin: number;
  source: GazeSourceKind;
}

/** After this much invalid time the smoothing filter restarts (like the webcam source). */
const FILTER_RESET_MS = 300;
/** Correlation time of the low-frequency "wander" noise (head micro-motion, landmark jitter). */
const WANDER_TAU_MS = 500;

/**
 * Turns true gaze points into GazeSamples the way a webcam tracker would:
 * white Gaussian noise, optional correlated low-frequency noise ("wander"),
 * a slow vertical drift of about ±driftPx (growing from 0 as a head settles
 * after calibration, or present from the start as a calibration bias) that
 * wobbles, optional blinks (invalid samples) and One Euro smoothing.
 */
class GazeSensor {
  private readonly filter = new OneEuroFilter2D();
  private t0: number | null = null;
  private lastT: number | null = null;
  private readonly driftSign: number;
  private readonly driftTauMs: number;
  private readonly wobbleMs: number;
  private readonly wobblePhase: number;
  private wanderX = 0;
  private wanderY = 0;
  private nextBlinkAt = Infinity;
  private blinkUntil = -Infinity;
  private invalidSince: number | null = null;
  private last: { x: number; y: number; rawX: number; rawY: number } | null = null;

  constructor(
    private readonly rng: () => number,
    private readonly opts: SensorOptions,
  ) {
    this.driftSign = rng() < 0.5 ? -1 : 1;
    this.driftTauMs = 4000 + 6000 * rng();
    this.wobbleMs = 15000 + 15000 * rng();
    this.wobblePhase = 2 * Math.PI * rng();
    if (opts.wanderPx > 0) {
      this.wanderX = opts.wanderPx * gaussian(rng);
      this.wanderY = opts.wanderPx * gaussian(rng);
    }
  }

  driftAt(t: number): number {
    if (this.t0 === null || !(this.opts.driftPx > 0)) return 0;
    const dt = Math.max(0, t - this.t0);
    const grow = this.opts.driftOnset === 'immediate' ? 1 : 1 - Math.exp(-dt / this.driftTauMs);
    const wobble = 0.85 + 0.15 * Math.sin((2 * Math.PI * dt) / this.wobbleMs + this.wobblePhase);
    return this.opts.driftPx * this.driftSign * grow * wobble;
  }

  private stepWander(t: number): void {
    const w = this.opts.wanderPx;
    const prev = this.lastT;
    this.lastT = t;
    if (!(w > 0) || prev === null) return;
    const a = Math.exp(-Math.max(0, t - prev) / WANDER_TAU_MS);
    const s = w * Math.sqrt(1 - a * a);
    this.wanderX = a * this.wanderX + s * gaussian(this.rng);
    this.wanderY = a * this.wanderY + s * gaussian(this.rng);
  }

  resetFilter(): void {
    this.filter.reset();
  }

  sample(t: number, truth: { x: number; y: number } | null): GazeSample {
    if (this.t0 === null) {
      this.t0 = t;
      this.scheduleBlink(t);
    }
    this.stepWander(t);
    if (t >= this.nextBlinkAt) {
      this.blinkUntil = t + 100 + 150 * this.rng();
      this.scheduleBlink(this.blinkUntil);
    }
    if (!truth || t < this.blinkUntil) {
      this.invalidSince ??= t;
      if (t - this.invalidSince > FILTER_RESET_MS) this.filter.reset();
      const l = this.last;
      return {
        t,
        x: l?.x ?? NaN,
        y: l?.y ?? NaN,
        rawX: l?.rawX ?? NaN,
        rawY: l?.rawY ?? NaN,
        valid: false,
        confidence: 0,
        source: this.opts.source,
      };
    }
    this.invalidSince = null;
    const rawX = truth.x + this.wanderX + this.opts.noisePx * gaussian(this.rng);
    const rawY = truth.y + this.wanderY + this.driftAt(t) + this.opts.noisePx * gaussian(this.rng);
    const s = this.filter.filter(rawX, rawY, t);
    this.last = { x: s.x, y: s.y, rawX, rawY };
    return { t, x: s.x, y: s.y, rawX, rawY, valid: true, confidence: 0.85 + 0.1 * this.rng(), source: this.opts.source };
  }

  private scheduleBlink(from: number): void {
    const rate = this.opts.blinksPerMin;
    this.nextBlinkAt = rate > 0 ? from + (-Math.log(1 - this.rng()) * 60000) / rate : Infinity;
  }
}

// ──────────────────────────────── Offline run ────────────────────────────────

export interface SimulateReadingOptions {
  /** Words per minute. Default 250. */
  wpm?: number;
  /** σ of the Gaussian noise added to every sample (both axes), px. Default 0. */
  noisePx?: number;
  /** Magnitude of the slow vertical drift, px. Default 0. */
  driftPx?: number;
  /** 'gradual' (default): drift grows from 0 over ~5–10 s; 'immediate': a calibration bias from the start. */
  driftOnset?: DriftOnset;
  /** σ of correlated low-frequency noise (τ ≈ 500 ms) on both axes, px. Default 0. */
  wanderPx?: number;
  /** Sample rate. Default 30. */
  hz?: number;
  seed?: number;
  /** First line to read (layout index). Default: first fully visible line. */
  startLine?: number;
  /** Last line to read (layout index). Default: last fully visible line. */
  endLine?: number;
  /** How long to keep sampling after the last line has been read, ms. Default 2500. */
  lingerMs?: number;
  /** Timestamp of the first sample. Default 0. */
  t0?: number;
  /** Blinks per minute (each makes 100–250 ms of samples invalid). Default 0. */
  blinksPerMin?: number;
}

export interface SimulatedReading {
  samples: GazeSample[];
  /** One entry per sample: the line the reader was actually on (or heading to). */
  truth: { t: number; lineIndex: number }[];
  /** When the final fixation on the last line ended (the reader finished the page). */
  lastLineEndT: number;
}

/** Reads `layout` from `startLine` to `endLine`, then lingers for `lingerMs`. Deterministic per seed. */
export function simulateReading(layout: LineLayout, opts: SimulateReadingOptions = {}): SimulatedReading {
  const seed = opts.seed ?? 1;
  const hz = opts.hz !== undefined && opts.hz > 0 ? opts.hz : 30;
  const period = 1000 / hz;
  const t0 = opts.t0 ?? 0;
  const lingerMs = Math.max(0, opts.lingerMs ?? 2500);
  const firstFull = layout.lines.findIndex((l) => l.fullyVisible);
  let lastFull = -1;
  layout.lines.forEach((l, i) => {
    if (l.fullyVisible) lastFull = i;
  });
  const samples: GazeSample[] = [];
  const truth: { t: number; lineIndex: number }[] = [];
  if (firstFull < 0) return { samples, truth, lastLineEndT: t0 };

  const startLine = opts.startLine ?? firstFull;
  const endLine = opts.endLine ?? lastFull;
  const wpm = opts.wpm ?? 250;
  const brain = new ReaderBrain(mulberry32(seed), { wpm: () => wpm, startLine, endLine });
  const sensor = new GazeSensor(mulberry32(seed ^ 0x9e3779b9), {
    noisePx: Math.max(0, opts.noisePx ?? 0),
    driftPx: opts.driftPx ?? 0,
    driftOnset: opts.driftOnset ?? 'gradual',
    wanderPx: Math.max(0, opts.wanderPx ?? 0),
    blinksPerMin: Math.max(0, opts.blinksPerMin ?? 0),
    source: 'simulated',
  });
  const jitter = mulberry32(seed ^ 0x51ed27);
  // Generous cap so a pathological layout can never loop forever.
  const limit = t0 + (Math.max(1, endLine - startLine + 1) * 20_000 + lingerMs + 5_000) * Math.max(1, 250 / wpm);

  let t = t0;
  while (t <= limit) {
    const g = brain.advance(t, layout);
    samples.push(sensor.sample(t, g));
    truth.push({ t, lineIndex: g ? g.lineIndex : -1 });
    if (brain.lingerStartedAt !== null && t >= brain.lingerStartedAt + lingerMs) break;
    t += period + (jitter() - 0.5) * 2;
  }
  return { samples, truth, lastLineEndT: brain.lingerStartedAt ?? t };
}

// ──────────────────────────────── Live source ────────────────────────────────

export interface SimulatedReaderOptions {
  getLayout: () => LineLayout | null;
  /** Reading speed, read on every fixation (e.g. `() => settings.simulatedWpm`). Default 250. */
  wpm?: () => number;
  /** Gaussian noise σ, px. Default 14. */
  noisePx?: number;
  /** Slow vertical drift magnitude, px. Default 10. */
  driftPx?: number;
  /** σ of correlated low-frequency noise, px. Default 0. */
  wanderPx?: number;
  /** Samples per second. Default 30. */
  hz?: number;
  seed?: number;
  /** Blinks per minute (invalid samples). Default 0. */
  blinksPerMin?: number;
}

/** A timer tick later than this means the tab was throttled: the reader pauses instead of racing ahead. */
const MAX_TICK_GAP_MS = 500;

/**
 * Demo-mode gaze source: a simulated reader following the live layout. It
 * remembers the last line it read; when the layout's scrollTop changes it
 * resumes at the first fully visible line below that one, and at the last
 * fully visible line it lingers until the page turns.
 */
export class SimulatedReaderSource implements GazeSource {
  readonly kind = 'simulated' as const;
  private readonly getLayout: () => LineLayout | null;
  private readonly period: number;
  private readonly brain: ReaderBrain;
  private readonly sensor: GazeSensor;
  private readonly listeners = new Set<(s: GazeSample) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private isRunning = false;
  private nextTickAt = 0;
  private lastTickAt: number | null = null;

  constructor(opts: SimulatedReaderOptions) {
    const seed = opts.seed ?? 1;
    const hz = opts.hz !== undefined && Number.isFinite(opts.hz) && opts.hz > 0 ? Math.min(opts.hz, 240) : 30;
    this.period = 1000 / hz;
    this.getLayout = opts.getLayout;
    const wpm = opts.wpm ?? ((): number => 250);
    this.brain = new ReaderBrain(mulberry32(seed), { wpm });
    this.sensor = new GazeSensor(mulberry32(seed ^ 0x9e3779b9), {
      noisePx: Math.max(0, opts.noisePx ?? 14),
      driftPx: opts.driftPx ?? 10,
      driftOnset: 'gradual',
      wanderPx: Math.max(0, opts.wanderPx ?? 0),
      blinksPerMin: Math.max(0, opts.blinksPerMin ?? 0),
      source: 'simulated',
    });
  }

  get running(): boolean {
    return this.isRunning;
  }

  /** What the simulated reader is doing (for demos and tests). */
  get state(): SimulatedReaderState {
    return this.brain.state;
  }

  start(): Promise<void> {
    if (this.isRunning) return Promise.resolve();
    this.isRunning = true;
    this.lastTickAt = null;
    this.nextTickAt = performance.now();
    this.schedule(0);
    return Promise.resolve();
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  onSample(cb: (sample: GazeSample) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private schedule(delay: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(this.tick, Math.max(0, delay));
  }

  private readonly tick = (): void => {
    this.timer = null;
    if (!this.isRunning) return;
    const now = performance.now();
    if (this.lastTickAt !== null && now - this.lastTickAt > MAX_TICK_GAP_MS) {
      this.brain.shift(now - this.lastTickAt - this.period);
      this.sensor.resetFilter();
    }
    this.lastTickAt = now;

    let layout: LineLayout | null = null;
    try {
      layout = this.getLayout();
    } catch (err) {
      console.error('[simulated-reader] getLayout threw', err);
    }
    const sample = this.sensor.sample(now, this.brain.advance(now, layout));
    for (const cb of [...this.listeners]) {
      try {
        cb(sample);
      } catch (err) {
        console.error('[simulated-reader] listener threw', err);
      }
    }
    if (!this.isRunning || this.timer !== null) return;
    this.nextTickAt += this.period;
    if (this.nextTickAt < now) this.nextTickAt = now + this.period;
    this.schedule(this.nextTickAt - now);
  };
}
