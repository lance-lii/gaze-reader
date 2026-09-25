// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvents, EyeFeatures, FeatureFrame, FeatureSource, GazeModel, LightingSignature, LightingStats, Point, Unsubscribe } from '../types';
import { createEventBus } from '../core/events';
import { evaluateModel, measureOffset, refineGazeModel, trainGazeModel } from '../gaze/calibrationModel';
import { buildLightingSignature } from '../gaze/lighting';
import { accuracyCheckView } from '../app/logic';
import {
  CHECK_TARGETS,
  CalibrationOverlay,
  DEFAULT_POSITION_THRESHOLDS,
  QUICK_TARGETS,
  STANDARD_TARGETS,
  VALIDATION_TARGETS,
  assessPosition,
  describeLightingChange,
  describeOffset,
  offsetVerdict,
  type CalibrationOverlayOptions,
  type PositionMetrics,
} from './calibrationOverlay';

type CalEvent = AppEvents['calibration'];
type CheckEvent = AppEvents['accuracy-check'];

/**
 * A well-lit scene as the camera side measures it (src/gaze/lighting.ts): sclera ≈ 0.4 linear,
 * background a little darker, no clipping, the normal corneal glint. Raises no LightingMonitor flag.
 */
function light(over: Partial<LightingStats> = {}): LightingStats {
  return {
    faceLuma: 0.45,
    faceLin: 0.18,
    faceRange: 1.4,
    faceClip: 0,
    frameLin: 0.2,
    bgLin: 0.15,
    bgClip: 0,
    scleraR: 0.4,
    scleraL: 0.4,
    backlight: Math.log2(0.4 / 0.15),
    side: 0.1,
    shade: -0.3,
    glareR: 0.004,
    glareL: 0.004,
    irisGlintR: 0.02,
    irisGlintL: 0.02,
    facePx: 6000,
    ...over,
  };
}

function signatureOf(stats: LightingStats, n = 30): LightingSignature {
  const sig = buildLightingSignature(Array.from({ length: n }, () => ({ stats, yaw: 0.02, pitch: -0.05 })));
  if (!sig) throw new Error('no signature');
  return sig;
}

const VW = 1024; // jsdom's default window.innerWidth
const VH = 768;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** A synthetic eye: nonlinear gaze features plus a few irrelevant ones. */
function eyeFeatures(gaze: Point, r: () => number, shift: readonly number[] = [], noise = 1): EyeFeatures {
  const nx = gaze.x / VW - 0.5;
  const ny = gaze.y / VH - 0.5;
  const vector = [
    0.3 + 0.2 * nx + 0.05 * nx * nx + 0.003 * noise * gaussian(r),
    0.7 - 0.18 * nx + 0.003 * noise * gaussian(r),
    0.05 * ny + 0.02 * ny * ny + 0.002 * noise * gaussian(r),
    1 / (1 + Math.exp(-4 * ny)) + 0.01 * noise * gaussian(r),
    0.28 - 0.06 * ny + 0.003 * noise * gaussian(r),
    0.01 * gaussian(r),
    55 + 0.3 * gaussian(r),
    gaussian(r),
  ].map((v, i) => v + (shift[i] ?? 0));
  return {
    vector,
    headPose: { yaw: 0.02, pitch: -0.05, roll: 0, tx: 0, ty: 0, tz: 55 },
    blink: 0.05,
    openness: 0.3,
    faceScale: 0.12,
    faceCenter: { x: 0.5, y: 0.45 },
  };
}

class FakeSource implements FeatureSource {
  running = true;
  private readonly listeners = new Set<(frame: FeatureFrame) => void>();
  async start(): Promise<void> {
    this.running = true;
  }
  stop(): void {
    this.running = false;
  }
  onFrame(cb: (frame: FeatureFrame) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
  push(frame: FeatureFrame): void {
    for (const cb of [...this.listeners]) cb(frame);
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
}

interface Reader {
  faceFound: boolean;
  faceScale: number;
  faceCenter: Point;
  shift: number[];
  /** Close the eyes while the ring shrinks on this (0-based) target index / attempt. */
  closeEyes: ((index: number, attempt: number) => boolean) | null;
  /**
   * Lids that droop while looking at this point: MediaPipe's blink score rises
   * to a sustained ~0.65 and the tracker's quality score drops with it.
   */
  lidsLowered: ((gaze: Point) => boolean) | null;
  /** Lighting measurement attached to every 5th frame (≈ 6 Hz, like the camera side), or none. */
  lighting: LightingStats | null;
  /** EyeFeatures.squint, when the blendshapes provide one. */
  squint: number | undefined;
  /** Page zoom relative to the calibration: the eyes look at CSS px / zoom in calibration-time px. */
  zoom: number;
  pointIndex: number;
  attempt: number;
}

/** A simulated reader who dutifully looks at whatever dot is on screen. */
function simulateReader(src: FakeSource, scope: ParentNode, bus: ReturnType<typeof createEventBus>, periodMs = 33, seed = 7) {
  const r = rng(seed);
  const reader: Reader = {
    faceFound: true,
    faceScale: 0.12,
    faceCenter: { x: 0.5, y: 0.45 },
    shift: [],
    closeEyes: null,
    lidsLowered: null,
    lighting: null,
    squint: undefined,
    zoom: 1,
    pointIndex: -1,
    attempt: 0,
  };
  let frameNo = 0;
  bus.on('calibration', (e) => {
    if ((e.phase === 'point' || e.phase === 'validating') && e.index !== undefined && e.message !== 'resumed' && e.message !== 'paused' && e.message !== 'face-lost') {
      reader.attempt = e.message === 'retry' ? reader.attempt + 1 : 0;
      reader.pointIndex = e.index;
    }
  });
  const id = setInterval(() => {
    const target = scope.querySelector<HTMLElement>('.gr-cal-target');
    const phase = scope.querySelector<HTMLElement>('.gr-cal')?.dataset.phase;
    let gaze: Point = { x: VW / 2, y: VH / 2 };
    if ((phase === 'targets' || phase === 'validating') && target?.dataset.x && target.dataset.y) {
      gaze = { x: Number(target.dataset.x), y: Number(target.dataset.y) };
    }
    if (!reader.faceFound) {
      src.push({ t: performance.now(), faceFound: false, features: null, quality: 0 });
      return;
    }
    const features = eyeFeatures({ x: gaze.x / reader.zoom, y: gaze.y / reader.zoom }, r, reader.shift);
    features.faceScale = reader.faceScale;
    features.faceCenter = { ...reader.faceCenter };
    if (reader.squint !== undefined) features.squint = reader.squint;
    let quality = 0.9;
    if (reader.lidsLowered?.(gaze)) {
      features.blink = 0.65;
      features.openness = 0.16;
      quality = 0.1;
    }
    const shrinking = target?.classList.contains('is-shrinking') ?? false;
    if (shrinking && reader.closeEyes?.(reader.pointIndex, reader.attempt)) features.blink = 0.9;
    const lighting = reader.lighting && frameNo++ % 5 === 0 ? { ...reader.lighting } : undefined;
    src.push({ t: performance.now(), faceFound: true, features, quality, ...(lighting ? { lighting } : {}) });
  }, periodMs);
  return { reader, stop: () => clearInterval(id) };
}

function setup(opts: Partial<CalibrationOverlayOptions> = {}, readerPeriodMs = 33) {
  const bus = createEventBus();
  const events: CalEvent[] = [];
  bus.on('calibration', (e) => events.push(e));
  const checks: CheckEvent[] = [];
  /** Both event kinds in the order they were emitted. */
  const log: string[] = [];
  bus.on('accuracy-check', (e) => {
    checks.push(e);
    log.push(`accuracy-check:${e.applied}`);
  });
  bus.on('calibration', (e) => log.push(e.phase));
  const src = new FakeSource();
  const host = document.createElement('div');
  document.body.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const overlay = new CalibrationOverlay({ features: src, bus, random: rng(3), ...opts });
  overlay.mount(shadow);
  const sim = simulateReader(src, shadow, bus, readerPeriodMs);
  const q = <T extends Element = HTMLElement>(sel: string): T => {
    const found = shadow.querySelector<T>(sel);
    if (!found) throw new Error(`missing ${sel}`);
    return found;
  };
  const root = q<HTMLDivElement>('.gr-cal');
  return { bus, events, checks, log, src, host, shadow, overlay, sim, q, root };
}

/** Yesterday's full calibration of the synthetic eye (optionally with the light it was made in). */
function baseModel(seed: number, lighting: LightingSignature | null = null) {
  const r = rng(seed);
  const samples = STANDARD_TARGETS.flatMap((f) =>
    Array.from({ length: 30 }, (_, i) => {
      const target = { x: f.x * VW, y: f.y * VH };
      return { target, features: eyeFeatures(target, r), t: i };
    }),
  );
  return trainGazeModel(samples, { viewport: { width: VW, height: VH }, environment: { lighting } }).model;
}

/** Fresh synthetic samples at these viewport fractions (independent of the overlay's run). */
function samplesAt(fractions: readonly Point[], shift: readonly number[], seed: number, perTarget = 40) {
  const r = rng(seed);
  return fractions.flatMap((f) =>
    Array.from({ length: perTarget }, (_, i) => {
      // The overlay keeps a 40 px margin; these fractions are all inside it at 1024 × 768.
      const target = { x: f.x * VW, y: f.y * VH };
      return { target, features: eyeFeatures(target, r, shift), t: i };
    }),
  );
}

/**
 * Eyes that read low: the vertical features move as if the reader looked ~0.07 of the screen
 * lower (feature 2 ≈ 0.05·ny, 3 ≈ sigmoid(4ny), 4 ≈ −0.06·ny near the centre).
 */
const READS_LOW = [0, 0, 0.0035, 0.07, -0.0042];

const visibleButton = (scope: ParentNode, action: string): HTMLButtonElement | null =>
  scope.querySelector<HTMLButtonElement>(`.gr-cal-center:not([hidden]) [data-action="${action}"]:not([hidden])`);

async function advanceUntil(pred: () => boolean, maxMs = 120_000, stepMs = 100): Promise<void> {
  for (let t = 0; t <= maxMs; t += stepMs) {
    if (pred()) return;
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  throw new Error(`condition not met within ${maxMs} ms`);
}

function key(k: string, target: EventTarget = window, code = k === ' ' ? 'Space' : k): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, code, bubbles: true, cancelable: true, composed: true });
  target.dispatchEvent(e);
  return e;
}

async function startCalibration(ctx: ReturnType<typeof setup>): Promise<void> {
  const start = ctx.q<HTMLButtonElement>('[data-action="start"]');
  await advanceUntil(() => !start.disabled, 5000);
  start.click();
  // The accuracy check's dots are 'validating' ones.
  await advanceUntil(() => ctx.root.dataset.phase === 'targets' || ctx.root.dataset.phase === 'validating', 2000, 20);
}

/** The visible results card's pieces. */
function resultsCard(ctx: ReturnType<typeof setup>) {
  const card = ctx.shadow.querySelector<HTMLElement>('.gr-cal-center:not([hidden]) .gr-cal-card');
  if (!card) throw new Error('no visible card');
  const text = (sel: string): string => card.querySelector(sel)?.textContent ?? '';
  return {
    title: text('.gr-cal-title'),
    badge: text('.gr-cal-badge'),
    stats: [...card.querySelectorAll('.gr-cal-stat')].map((s) => s.textContent ?? ''),
    note: text('.gr-cal-note'),
    advice: text('.gr-cal-lede'),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('CalibrationOverlay — standard flow', () => {
  it('runs positioning → 13 targets → training → 4 checks → results, then resolves on "Use it"', async () => {
    const ctx = setup({ linePitchPx: 20 });
    const { events, root, q, shadow, src, overlay } = ctx;
    const done = overlay.run();

    expect(root.hidden).toBe(false);
    expect(root.hasAttribute('data-gr-ignore')).toBe(true);
    expect(root.getAttribute('role')).toBe('dialog');
    expect(shadow.querySelector('style')?.textContent).toContain('.gr-cal-target');
    expect(root.dataset.phase).toBe('positioning');
    expect(q<HTMLButtonElement>('[data-action="start"]').disabled).toBe(true);

    await advanceUntil(() => !q<HTMLButtonElement>('[data-action="start"]').disabled, 5000);
    expect(q('.gr-cal-status-text').textContent).toMatch(/all set/);
    expect(q('.gr-cal-preview').dataset.state).toBe('good');
    expect([...shadow.querySelectorAll<HTMLElement>('.gr-cal-check')].map((c) => c.dataset.state)).toEqual(['ok', 'ok', 'ok', 'ok']);

    q<HTMLButtonElement>('[data-action="start"]').click();
    await advanceUntil(() => root.dataset.phase === 'targets', 2000, 20);
    expect(q('.gr-cal-count').textContent).toBe(`1 / ${STANDARD_TARGETS.length}`);

    await advanceUntil(() => root.dataset.phase === 'results', 120_000, 250);

    const phases = events.map((e) => e.phase);
    expect(phases.slice(0, 2)).toEqual(['start', 'positioning']);
    const points = events.filter((e) => e.phase === 'point');
    expect(points.map((e) => e.index)).toEqual([...STANDARD_TARGETS.keys()]);
    expect(points.every((e) => e.total === STANDARD_TARGETS.length && e.message === undefined)).toBe(true);
    const checks = events.filter((e) => e.phase === 'validating');
    expect(checks.map((e) => e.index)).toEqual([...VALIDATION_TARGETS.keys()]);
    expect(phases.indexOf('training')).toBeGreaterThan(phases.lastIndexOf('point'));
    expect(phases.indexOf('validating')).toBeGreaterThan(phases.indexOf('training'));
    expect(phases).not.toContain('done');

    // Results screen.
    expect(q('.gr-cal-badge').dataset.quality).toBe('excellent');
    expect(q('.gr-cal-stat-value').textContent).toMatch(/^±\d+$/);
    expect(shadow.querySelectorAll('.gr-cal-map-gaze')).toHaveLength(VALIDATION_TARGETS.length);
    const use = q<HTMLButtonElement>('[data-action="use"]');
    expect(shadow.activeElement).toBe(use);
    // The live gaze dot follows the new model.
    await vi.advanceTimersByTimeAsync(200);
    expect(q('.gr-cal-live').classList.contains('is-on')).toBe(true);

    use.click();
    const result = await done;
    expect(result).not.toBeNull();
    const { model, report } = result!;
    expect(report.perPoint).toHaveLength(VALIDATION_TARGETS.length);
    expect(report.quality).toBe('excellent');
    expect(shadow.querySelectorAll('.gr-cal-stat-value')[1].textContent).toBe(`≈ ${(report.meanErrorYPx / 20).toFixed(1)}`);
    expect(events.at(-1)).toEqual({ phase: 'done', report });
    expect(model.viewport).toEqual({ width: VW, height: VH });
    // No lighting numbers from this camera: no lighting signature, but the eyelid baseline is there.
    expect(model.environment?.lighting).toBeNull();
    expect(model.environment?.appearance?.opennessAt0).toBeCloseTo(0.3, 6);
    expect(ctx.checks).toEqual([]); // a full calibration isn't an accuracy check
    expect(result!.check).toBeUndefined();

    const p = model.predict(eyeFeatures({ x: 300, y: 500 }, rng(99), [], 0));
    expect(p).not.toBeNull();
    expect(Math.hypot(p!.x - 300, p!.y - 500)).toBeLessThan(25);

    // Hidden, unsubscribed, keyboard released.
    expect(root.hidden).toBe(true);
    expect(src.listenerCount).toBe(0);
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    key(' ');
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', seen);
    ctx.sim.stop();
    overlay.destroy();
  });

  it('stores the light and the eyelids of the calibration with the model', async () => {
    const ctx = setup();
    ctx.sim.reader.lighting = light({ side: 0.3 });
    ctx.sim.reader.squint = 0.12;
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await advanceUntil(() => ctx.root.dataset.phase === 'results', 120_000, 250);
    ctx.q<HTMLButtonElement>('[data-action="use"]').click();
    const result = await done;
    const env = result!.model.environment;
    // Built from the dots phase only: ~13 × 2.2 s at ~6 measurements a second.
    expect(env?.lighting?.n).toBeGreaterThanOrEqual(120);
    expect(env?.lighting?.n).toBeLessThanOrEqual(260);
    expect(env?.lighting?.c.sclera).toBeCloseTo(Math.log2(0.4), 2);
    expect(env?.lighting?.c.side).toBeCloseTo(0.3, 6);
    expect(env?.lighting?.yaw).toBeCloseTo(0.02, 6);
    expect(env?.lighting?.pitch).toBeCloseTo(-0.05, 6);
    // The squint score survives into the samples, so the eyelid baseline knows it.
    expect(env?.appearance?.squintMedian).toBeCloseTo(0.12, 6);
    // It survives a save and load.
    expect(JSON.parse(JSON.stringify(result!.model.toJSON())).environment.lighting.c.side).toBeCloseTo(0.3, 6);
    ctx.sim.stop();
  });

  it('Esc cancels: resolves null and emits cancelled', async () => {
    const ctx = setup();
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await vi.advanceTimersByTimeAsync(3000);
    const e = key('Escape');
    expect(e.defaultPrevented).toBe(true);
    await expect(done).resolves.toBeNull();
    expect(ctx.events.at(-1)).toEqual({ phase: 'cancelled' });
    expect(ctx.events.some((ev) => ev.phase === 'done')).toBe(false);
    expect(ctx.root.hidden).toBe(true);
    expect(ctx.src.listenerCount).toBe(0);
    ctx.sim.stop();
  });

  it('is modal: keys never reach the page behind it', async () => {
    const ctx = setup();
    const pageShortcut = vi.fn();
    window.addEventListener('keydown', pageShortcut);
    document.body.addEventListener('keydown', pageShortcut);
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    key(' ', document.body);
    key('d', document.body);
    key('PageDown', window);
    expect(pageShortcut).not.toHaveBeenCalled();
    ctx.overlay.cancel();
    await done;
    window.removeEventListener('keydown', pageShortcut);
    ctx.sim.stop();
  });

  it('Space pauses and resumes; nothing progresses while paused', async () => {
    const ctx = setup();
    const { events, q, root } = ctx;
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await vi.advanceTimersByTimeAsync(2500);

    const e = key(' ');
    expect(e.defaultPrevented).toBe(true);
    const paused = events.at(-1)!;
    expect(paused).toMatchObject({ phase: 'point', message: 'paused' });
    expect(q('.gr-cal-pause').closest('[hidden]')).toBeNull();
    expect(root.dataset.paused).toBe('user');

    const before = events.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(events.length).toBe(before); // a deliberate pause never auto-resumes

    key(' ');
    expect(events.at(-1)).toMatchObject({ phase: 'point', index: paused.index, message: 'resumed' });
    expect(q('.gr-cal-pause').hidden).toBe(true);

    await advanceUntil(() => root.dataset.phase === 'results', 120_000, 250);
    const indices = events.filter((ev) => ev.phase === 'point' && ev.message === undefined).map((ev) => ev.index);
    expect(indices).toEqual([...STANDARD_TARGETS.keys()]); // the interrupted target was shown again, not skipped
    ctx.overlay.cancel();
    await expect(done).resolves.toBeNull();
    ctx.sim.stop();
  });

  it('a tap on the screen pauses too (no keyboard on a tablet), and the pause card resumes or cancels', async () => {
    const ctx = setup();
    const { events, q, root } = ctx;
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await vi.advanceTimersByTimeAsync(1200);
    q('.gr-cal-stage').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, button: 0 }));
    expect(root.dataset.paused).toBe('user');
    expect(events.at(-1)).toMatchObject({ phase: 'point', message: 'paused' });
    q<HTMLButtonElement>('.gr-cal-pause [data-action="continue"]').click();
    expect(root.dataset.paused).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ phase: 'point', message: 'resumed' });

    q('.gr-cal-stage').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, button: 2 }));
    expect(root.dataset.paused).toBeUndefined(); // a right-click is not a tap

    q('.gr-cal-stage').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, button: 0 }));
    q<HTMLButtonElement>('.gr-cal-pause [data-action="cancel"]').click();
    await expect(done).resolves.toBeNull();
    expect(events.at(-1)).toEqual({ phase: 'cancelled' });
    ctx.sim.stop();
  });

  it('repeats a target that collected too few samples', async () => {
    const ctx = setup();
    ctx.sim.reader.closeEyes = (index, attempt) => index === 2 && attempt === 0;
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await advanceUntil(() => ctx.root.dataset.phase === 'results', 120_000, 250);
    const third = ctx.events.filter((e) => e.phase === 'point' && e.index === 2);
    expect(third.map((e) => e.message)).toEqual([undefined, 'retry']);
    expect(ctx.events.some((e) => e.message === 'face-lost')).toBe(false);
    ctx.q<HTMLButtonElement>('[data-action="use"]').click();
    const result = await done;
    expect(result?.report.quality).toBe('excellent');
    ctx.sim.stop();
  });

  it('keeps lowered lids on the low targets (same blink rule as the live gaze source) instead of retrying or pausing', async () => {
    const ctx = setup();
    ctx.sim.reader.lidsLowered = (gaze) => gaze.y > VH * 0.6;
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await advanceUntil(() => ctx.root.dataset.phase === 'results', 120_000, 250);
    expect(ctx.events.filter((e) => e.message !== undefined)).toEqual([]);
    ctx.q<HTMLButtonElement>('[data-action="use"]').click();
    const result = await done;
    expect(result?.report.quality).toBe('excellent');
    // The low check points were measured too.
    expect(result!.report.perPoint.filter((p) => p.target.y > VH * 0.6)).toHaveLength(2);
    ctx.sim.stop();
  });

  it('still treats a real blink as a blink', async () => {
    const ctx = setup();
    // Eyes shut for a whole target, but with a moderate score: the collapsed lid aperture gives it away.
    ctx.sim.reader.closeEyes = (index, attempt) => index === 1 && attempt === 0;
    const push = ctx.src.push.bind(ctx.src);
    ctx.src.push = (frame) => {
      const f = frame.features;
      if (f && f.blink >= 0.9) push({ ...frame, features: { ...f, blink: 0.7, openness: 0.03 } });
      else push(frame);
    };
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await advanceUntil(() => ctx.events.filter((e) => e.phase === 'point').length >= 3, 30_000, 100);
    expect(ctx.events.filter((e) => e.phase === 'point' && e.index === 1).map((e) => e.message)).toEqual([undefined, 'retry']);
    ctx.overlay.cancel();
    await done;
    ctx.sim.stop();
  });

  it('auto-pauses when the face disappears and picks up when it returns', async () => {
    const ctx = setup();
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await vi.advanceTimersByTimeAsync(3000);
    ctx.sim.reader.faceFound = false;
    await vi.advanceTimersByTimeAsync(2600);
    expect(ctx.events.at(-1)).toMatchObject({ message: 'face-lost' });
    expect(ctx.root.dataset.paused).toBe('face');
    expect(ctx.q('.gr-cal-pause').textContent).toMatch(/lost sight/);

    ctx.sim.reader.faceFound = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.events.at(-1)).toMatchObject({ message: 'resumed' });
    await advanceUntil(() => ctx.root.dataset.phase === 'results', 120_000, 250);
    ctx.q<HTMLButtonElement>('[data-action="use"]').click();
    expect(await done).not.toBeNull();
    ctx.sim.stop();
  });

  it('fails gracefully when too few targets succeed, and can be cancelled from there', async () => {
    // 4 Hz frames → ~4 samples per target, below the minimum of 8.
    const ctx = setup({ timing: { maxAttempts: 1 } }, 250);
    const done = ctx.overlay.run();
    const start = ctx.q<HTMLButtonElement>('[data-action="start"]');
    await advanceUntil(() => !start.disabled, 5000);
    start.click();
    await advanceUntil(() => ctx.root.dataset.phase === 'failed', 60_000, 250);
    const failed = ctx.events.find((e) => e.phase === 'failed');
    expect(failed?.message).toMatch(/steady look/);
    expect(ctx.shadow.activeElement).toBe(ctx.q('[data-action="retry"]'));
    expect(ctx.events.some((e) => e.phase === 'training')).toBe(false);

    ctx.shadow.querySelector<HTMLButtonElement>('.gr-cal-center:not([hidden]) [data-action="cancel"]')!.click();
    await expect(done).resolves.toBeNull();
    expect(ctx.events.at(-1)).toEqual({ phase: 'cancelled' });
    ctx.sim.stop();
  });

  it('"Try again" after a failure goes back to positioning', async () => {
    const ctx = setup({ timing: { maxAttempts: 1 } }, 250);
    const done = ctx.overlay.run();
    const start = ctx.q<HTMLButtonElement>('[data-action="start"]');
    await advanceUntil(() => !start.disabled, 5000);
    start.click();
    await advanceUntil(() => ctx.root.dataset.phase === 'failed', 60_000, 250);
    ctx.q<HTMLButtonElement>('[data-action="retry"]').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.root.dataset.phase).toBe('positioning');
    expect(ctx.events.filter((e) => e.phase === 'positioning')).toHaveLength(2);
    ctx.overlay.cancel();
    await done;
    ctx.sim.stop();
  });
});

describe('CalibrationOverlay — quick mode', () => {
  it('refines a saved model from 5 points without a validation pass', async () => {
    // Yesterday's full calibration, in yesterday's light…
    const base = baseModel(5, signatureOf(light()));

    // …and today the reader sits a little differently, with a brighter lamp.
    const shift = [0.015, -0.012, 0.004, 0.04, -0.006];
    const ctx = setup({ mode: 'quick', baseModel: base });
    ctx.sim.reader.shift = shift;
    ctx.sim.reader.lighting = light({ scleraR: 0.8, scleraL: 0.8 });
    const done = ctx.overlay.run();
    expect(ctx.q('.gr-cal-next').textContent).toMatch(/5 dots/);
    await startCalibration(ctx);
    await advanceUntil(() => ctx.root.dataset.phase === 'results', 60_000, 250);

    const points = ctx.events.filter((e) => e.phase === 'point');
    expect(points.map((e) => e.index)).toEqual([...QUICK_TARGETS.keys()]);
    expect(points.every((e) => e.total === QUICK_TARGETS.length)).toBe(true);
    expect(ctx.events.some((e) => e.phase === 'validating')).toBe(false);

    // The results say how far off the old model was on these dots, what the tune-up leaves, and why.
    const truth = measureOffset(base, samplesAt(QUICK_TARGETS, shift, 61));
    const card = resultsCard(ctx);
    expect(card.note).toBe(
      'Before this refresh, tracking read about 1 line low and a bit to the right. Now: within half a line. ' +
        'The light has changed since you calibrated: your eyes are more brightly lit now.',
    );
    expect(visibleButton(ctx.shadow, 'done')).toBeNull();
    expect(ctx.checks).toEqual([]); // reported once the reader decides

    ctx.q<HTMLButtonElement>('[data-action="use"]').click();
    const result = await done;
    expect(result).not.toBeNull();
    const r2 = rng(6);
    const today = [
      { x: 256, y: 170 },
      { x: 768, y: 600 },
      { x: 512, y: 384 },
    ].flatMap((target) => Array.from({ length: 20 }, (_, i) => ({ target, features: eyeFeatures(target, r2, shift), t: i })));
    const before = evaluateModel(base, today).meanErrorPx;
    const after = evaluateModel(result!.model, today).meanErrorPx;
    expect(after).toBeLessThan(before / 2);
    expect(result!.model.toJSON()).toMatchObject({ version: 1 });

    // Before/after, in the result and on the bus.
    const check = result!.check!;
    expect(check).toMatchObject({ mode: 'quick', applied: true, lightingChange: { changed: true, dominant: 'sclera' } });
    expect(Math.abs(check.before.offsetYPx - truth.offsetYPx)).toBeLessThan(6);
    expect(Math.abs(check.before.offsetXPx - truth.offsetXPx)).toBeLessThan(6);
    expect(check.before.offsetYLines).toBeCloseTo(check.before.offsetYPx / (22 * 1.9), 9);
    expect(Math.abs(check.after!.offsetYPx)).toBeLessThan(Math.abs(check.before.offsetYPx) / 3);
    expect(check.before.offsetXFrac).toBeCloseTo(check.before.offsetXPx / VW, 9);
    expect(check.before.maxDotYLines).toBeGreaterThanOrEqual(Math.abs(check.before.offsetYLines));
    expect(ctx.checks).toEqual([
      {
        meanErrorPx: check.before.meanErrorPx,
        offsetXPx: check.before.offsetXPx,
        offsetYPx: check.before.offsetYPx,
        offsetYLines: check.before.offsetYLines,
        offsetXFrac: check.before.offsetXFrac,
        maxDotYLines: check.before.maxDotYLines,
        applied: true,
      },
    ]);
    expect(ctx.log.slice(-2)).toEqual(['accuracy-check:true', 'done']);
    expect(ctx.overlay.lastAccuracyCheck).toEqual(check);
    // Today's light is the new reference.
    expect(result!.model.environment?.lighting?.c.sclera).toBeCloseTo(Math.log2(0.8), 2);
    ctx.sim.stop();
  });

  it('a redo reports the measurement as not applied, and the next one counts', async () => {
    const base = baseModel(5);
    const ctx = setup({ mode: 'quick', baseModel: base });
    ctx.sim.reader.shift = READS_LOW;
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await advanceUntil(() => ctx.root.dataset.phase === 'results', 60_000, 250);
    visibleButton(ctx.shadow, 'redo')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.root.dataset.phase).toBe('positioning');
    expect(ctx.checks.map((c) => c.applied)).toEqual([false]);
    await startCalibration(ctx);
    await advanceUntil(() => ctx.root.dataset.phase === 'results', 60_000, 250);
    // Esc on the results: that measurement isn't applied either.
    key('Escape');
    await expect(done).resolves.toBeNull();
    expect(ctx.checks.map((c) => c.applied)).toEqual([false, false]);
    expect(ctx.log.slice(-2)).toEqual(['accuracy-check:false', 'cancelled']);
    ctx.sim.stop();
  });

  it('offers a full calibration when the saved model cannot be tuned up', async () => {
    const r = rng(8);
    const baseSamples = STANDARD_TARGETS.flatMap((f) =>
      Array.from({ length: 30 }, (_, i) => {
        const target = { x: f.x * VW, y: f.y * VH };
        return { target, features: eyeFeatures(target, r), t: i };
      }),
    );
    const base = trainGazeModel(baseSamples, { viewport: { width: VW, height: VH } }).model;
    const ctx = setup({ mode: 'quick', baseModel: base });
    ctx.sim.reader.shift = [1, 1, 1, 1, 1]; // eyes nothing like the saved calibration: every prediction is rejected
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await advanceUntil(() => ctx.root.dataset.phase === 'failed', 60_000, 250);
    const retry = ctx.q<HTMLButtonElement>('[data-action="retry"]');
    expect(retry.textContent).toBe('Full calibration');
    expect(ctx.q('.gr-cal-failed-text').textContent).toMatch(/full calibration/);

    ctx.sim.reader.shift = [];
    retry.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.q('.gr-cal-next').textContent).toMatch(/13 dots/);
    const before = ctx.events.length;
    await startCalibration(ctx);
    expect(ctx.events.slice(before).find((e) => e.phase === 'point')?.total).toBe(STANDARD_TARGETS.length);
    ctx.overlay.cancel();
    await done;
    ctx.sim.stop();
  });

  it('falls back to the full grid without a usable base model', async () => {
    const ctx = setup({ mode: 'quick', baseModel: null });
    const done = ctx.overlay.run();
    expect(ctx.q('.gr-cal-next').textContent).toMatch(/13 dots/);
    await startCalibration(ctx);
    expect(ctx.events.find((e) => e.phase === 'point')?.total).toBe(STANDARD_TARGETS.length);
    ctx.overlay.cancel();
    await done;
    ctx.sim.stop();
  });
});

describe('CalibrationOverlay — accuracy check', () => {
  it('measures the model without training, says the offset in plain words, and "Correct it" applies a quick refresh', async () => {
    const base = baseModel(5, signatureOf(light()));
    const baseJson = JSON.stringify(base.toJSON());
    const ctx = setup({ mode: 'check', baseModel: base, linePitchPx: 20 });
    ctx.sim.reader.shift = READS_LOW; // the lamp went on: gaze now reads low
    ctx.sim.reader.lighting = light({ scleraR: 0.8, scleraL: 0.8 });
    const done = ctx.overlay.run();
    expect(ctx.q('.gr-cal-next').textContent).toMatch(/^Accuracy check: 5 dots, .* nothing changes unless you ask\.$/);
    await startCalibration(ctx);
    expect(ctx.root.dataset.phase).toBe('validating');
    expect(ctx.q('.gr-cal-hud-label').textContent).toBe('Accuracy check');
    await advanceUntil(() => ctx.root.dataset.phase === 'results', 60_000, 250);

    // Five dots, as 'validating' events; nothing was trained.
    expect(ctx.events.filter((e) => e.phase === 'validating').map((e) => e.index)).toEqual([...CHECK_TARGETS.keys()]);
    expect(ctx.events.some((e) => e.phase === 'point' || e.phase === 'training')).toBe(false);

    // The measurement matches what the model does on these eyes, measured independently.
    const truth = measureOffset(base, samplesAt(CHECK_TARGETS, READS_LOW, 77));
    const check = ctx.overlay.lastAccuracyCheck!;
    expect(check.applied).toBe(false);
    expect(Math.abs(check.before.offsetYPx - truth.offsetYPx)).toBeLessThan(6);
    expect(Math.abs(check.before.offsetXPx)).toBeLessThan(8);
    expect(check.before.offsetYLines).toBeCloseTo(check.before.offsetYPx / 20, 9);
    expect(check.before.targets).toBe(CHECK_TARGETS.length);
    expect(ctx.checks).toEqual([]); // reported once the reader decides

    const card = resultsCard(ctx);
    expect(card.title).toBe('Tracking reads about 3 lines low');
    expect(card.badge).toBe('Drifted');
    expect(card.stats[1]).toBe(`${check.before.offsetYLines.toFixed(1)}lines lowvertical offset at your text size`);
    expect(card.note).toBe(
      'The light has changed since you calibrated: your eyes are more brightly lit now. “Correct it” should bring it to within half a line.',
    );
    expect(card.advice).toMatch(/“Correct it” re-centers it/);
    // "Correct it" is the suggestion; "Done" leaves things as they are; no full calibration needed.
    const correct = visibleButton(ctx.shadow, 'use')!;
    expect(correct.textContent).toBe('Correct it');
    expect(correct.classList.contains('gr-cal-btn-primary')).toBe(true);
    expect(ctx.shadow.activeElement).toBe(correct);
    expect(visibleButton(ctx.shadow, 'done')?.classList.contains('gr-cal-btn-primary')).toBe(false);
    expect(visibleButton(ctx.shadow, 'redo')).toBeNull();
    const row = [...ctx.shadow.querySelectorAll<HTMLButtonElement>('.gr-cal-center:not([hidden]) .gr-cal-actions button:not([hidden])')];
    expect(row.map((b) => b.textContent)).toEqual(['Done', 'Correct it']);
    expect(ctx.q('.gr-cal-sr').textContent).toMatch(/^Drifted\. Tracking reads about 3 lines low\./);
    // The live dot follows the model in use, so the offset can be seen: the reader looks at the centre.
    await vi.advanceTimersByTimeAsync(300);
    const live = ctx.q('.gr-cal-live');
    expect(live.classList.contains('is-on')).toBe(true);
    const liveY = Number(/translate3d\([-\d.]+px, ([-\d.]+)px/.exec(live.style.transform)?.[1]);
    expect(liveY - VH / 2).toBeGreaterThan(30);

    correct.click();
    const result = await done;
    expect(result).not.toBeNull();
    expect(result!.check).toMatchObject({ mode: 'check', applied: true, before: check.before });
    expect(Math.abs(result!.check!.after!.offsetYLines)).toBeLessThan(0.5);
    expect(ctx.checks).toEqual([
      {
        meanErrorPx: check.before.meanErrorPx,
        offsetXPx: check.before.offsetXPx,
        offsetYPx: check.before.offsetYPx,
        offsetYLines: check.before.offsetYLines,
        offsetXFrac: check.before.offsetXFrac,
        maxDotYLines: check.before.maxDotYLines,
        applied: true,
      },
    ]);
    expect(ctx.log.slice(-2)).toEqual(['accuracy-check:true', 'done']);
    expect(ctx.events.at(-1)).toEqual({ phase: 'done', report: result!.report });

    // The corrected model reads today's eyes right, elsewhere on the screen too.
    const today = samplesAt(VALIDATION_TARGETS, READS_LOW, 78);
    const errBefore = evaluateModel(base, today).meanErrorPx;
    const errAfter = evaluateModel(result!.model, today).meanErrorPx;
    expect(errAfter).toBeLessThan(errBefore / 3);
    expect(Math.abs(measureOffset(result!.model, today).offsetYPx)).toBeLessThan(10);
    // Today's light is the new reference; the checked model itself was never touched.
    expect(result!.model.environment?.lighting?.c.sclera).toBeCloseTo(Math.log2(0.8), 2);
    expect(JSON.stringify(base.toJSON())).toBe(baseJson);
    ctx.sim.stop();
  });

  it('"Done" keeps the model: run() resolves null, and the measurement is still reported', async () => {
    const base = baseModel(8);
    const baseJson = JSON.stringify(base.toJSON());
    const ctx = setup({ mode: 'check', baseModel: base, linePitchPx: 20 });
    ctx.sim.reader.shift = [0, 0, 0.002, 0.04, -0.0024]; // ≈ 1.6 lines low
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await advanceUntil(() => ctx.root.dataset.phase === 'results', 60_000, 250);
    const card = resultsCard(ctx);
    expect(card.title).toBe('Tracking reads about 2 lines low');
    expect(card.badge).toBe('Slightly off');
    // No lighting numbers from this camera: nothing to compare, and nothing claimed.
    expect(ctx.overlay.lastAccuracyCheck).toMatchObject({ lighting: null, lightingChange: null });
    expect(card.note).not.toMatch(/light/);

    visibleButton(ctx.shadow, 'done')!.click();
    await expect(done).resolves.toBeNull();
    expect(ctx.checks).toHaveLength(1);
    expect(ctx.checks[0].applied).toBe(false);
    expect(ctx.checks[0].offsetYLines).toBeGreaterThan(1.2);
    expect(ctx.overlay.lastAccuracyCheck).toMatchObject({ mode: 'check', applied: false });
    expect(ctx.log.slice(-2)).toEqual(['accuracy-check:false', 'done']);
    expect(ctx.events.some((e) => e.phase === 'training')).toBe(false);
    expect(JSON.stringify(base.toJSON())).toBe(baseJson);
    expect(ctx.root.hidden).toBe(true);
    expect(ctx.src.listenerCount).toBe(0);
    ctx.sim.stop();
  });

  it('on target it says so and suggests "Done"; Esc reports the measurement as not applied', async () => {
    const ctx = setup({ mode: 'check', baseModel: baseModel(11), linePitchPx: 20 });
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await advanceUntil(() => ctx.root.dataset.phase === 'results', 60_000, 250);
    const card = resultsCard(ctx);
    expect(card.title).toBe('Right on target');
    expect(card.badge).toBe('On target');
    expect(card.advice).toMatch(/still fits — nothing needs changing/);
    expect(card.note).toBe('');
    const doneButton = visibleButton(ctx.shadow, 'done')!;
    expect(ctx.shadow.activeElement).toBe(doneButton);
    expect(doneButton.classList.contains('gr-cal-btn-primary')).toBe(true);
    expect(visibleButton(ctx.shadow, 'use')?.classList.contains('gr-cal-btn-primary')).toBe(false);
    // The suggestion sits last, in the DOM too, so Tab follows what the eye sees.
    const row = (): (string | null)[] =>
      [...ctx.shadow.querySelectorAll<HTMLButtonElement>('.gr-cal-center:not([hidden]) .gr-cal-actions button:not([hidden])')].map((b) => b.textContent);
    expect(row()).toEqual(['Correct it', 'Done']);
    key('Tab');
    expect(ctx.shadow.activeElement?.textContent).toBe('Correct it'); // wraps from the last button to the first

    key('Escape');
    await expect(done).resolves.toBeNull();
    expect(ctx.checks.map((c) => c.applied)).toEqual([false]);
    expect(Math.abs(ctx.checks[0].offsetYLines)).toBeLessThan(0.5);
    expect(ctx.log.slice(-2)).toEqual(['accuracy-check:false', 'cancelled']);
    ctx.sim.stop();
  });

  it('a scale error is not "On target": the worst dot counts, and a full calibration is suggested (regression)', async () => {
    // Sitting further back than at calibration: the top reads high and the bottom low, 20 % of the
    // distance from the centre. The check's dots are symmetric, so the mean offset is ~0.
    const core = baseModel(5);
    const c = VH / 2;
    const stretched: GazeModel = {
      predict: (f) => {
        const p = core.predict(f);
        return p ? { x: p.x, y: c + 1.2 * (p.y - c) } : null;
      },
      viewport: core.viewport,
      trainedAt: core.trainedAt,
      toJSON: () => core.toJSON(),
    };
    const ctx = setup({ mode: 'check', baseModel: stretched, linePitchPx: 30 });
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await advanceUntil(() => ctx.root.dataset.phase === 'results', 60_000, 250);
    const check = ctx.overlay.lastAccuracyCheck!;
    expect(Math.abs(check.before.offsetYLines)).toBeLessThan(0.5); // the mean hides it…
    expect(check.before.maxDotYLines).toBeGreaterThan(1.6); // …the dots don't (±1.79 lines by construction)
    const card = resultsCard(ctx);
    expect(card.badge).not.toBe('On target');
    expect(card.badge).toBe('Slightly off');
    expect(card.title).toBe('Tracking reads up to 2 lines off near the top and bottom');
    expect(card.advice).not.toMatch(/nothing needs changing/);
    // "Correct it" re-centres; it takes out only part of a scale error, so it isn't the suggestion.
    expect(check.after!.maxDotYLines).toBeGreaterThanOrEqual(1);
    const full = visibleButton(ctx.shadow, 'redo')!;
    expect(full.textContent).toBe('Full calibration');
    expect(full.classList.contains('gr-cal-btn-primary')).toBe(true);
    expect(ctx.shadow.activeElement).toBe(full);
    expect(visibleButton(ctx.shadow, 'use')?.classList.contains('gr-cal-btn-primary')).toBe(false);
    expect(card.advice).toMatch(/can’t take all of it out/);

    visibleButton(ctx.shadow, 'done')!.click();
    await expect(done).resolves.toBeNull();
    // The toast and Dewey after "Done" agree: not "on target", and a full calibration is offered.
    const view = accuracyCheckView(ctx.checks[0]!);
    expect(view.quip).not.toBe('accuracyGood');
    expect(view).toMatchObject({ badge: 'Slightly off', title: 'Tracking is slightly off', offerRecalibrate: true, offerTouchUp: false });
    ctx.sim.stop();
  });

  it('announces a check as a check: the first event is {phase: "start", message: "check"}', async () => {
    const first = async (opts: Partial<CalibrationOverlayOptions>) => {
      const ctx = setup(opts);
      const done = ctx.overlay.run();
      await vi.advanceTimersByTimeAsync(0);
      const event = ctx.events[0];
      ctx.overlay.cancel();
      await done;
      ctx.sim.stop();
      return event;
    };
    expect(await first({ mode: 'check', baseModel: baseModel(5) })).toEqual({ phase: 'start', message: 'check' });
    expect(await first({ mode: 'quick', baseModel: baseModel(5) })).toEqual({ phase: 'start' });
    expect(await first({ mode: 'standard' })).toEqual({ phase: 'start' });
    expect(await first({ mode: 'check', baseModel: null })).toEqual({ phase: 'start' }); // no model: a calibration
  });

  it('corrects a wrapped model (the extension’s zoom-aware one) without losing the wrapper’s scale', async () => {
    const core = baseModel(5);
    const zoom = 1.25; // this page is zoomed differently from the one calibrated on
    const wrapped: GazeModel = {
      predict: (f) => {
        const p = core.predict(f);
        return p ? { x: p.x * zoom, y: p.y * zoom } : null;
      },
      viewport: core.viewport,
      trainedAt: core.trainedAt,
      toJSON: () => ({ ...core.toJSON(), calibrationDpr: 2 }),
    };
    const ctx = setup({ mode: 'check', baseModel: wrapped, linePitchPx: 20 });
    ctx.sim.reader.zoom = zoom;
    ctx.sim.reader.shift = READS_LOW;
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await advanceUntil(() => ctx.root.dataset.phase === 'results', 60_000, 250);
    // Measured through the wrapper: 57 calibration px low is ~71 px on this page.
    expect(resultsCard(ctx).title).toBe('Tracking reads about 4 lines low');
    visibleButton(ctx.shadow, 'use')!.click();
    const result = await done;

    // Today's eyes on this page: dots in this page's px, eyes pointed at the same physical spots.
    const r = rng(79);
    const today = VALIDATION_TARGETS.flatMap((f) =>
      Array.from({ length: 40 }, (_, i) => {
        const target = { x: f.x * VW, y: f.y * VH };
        return { target, features: eyeFeatures({ x: target.x / zoom, y: target.y / zoom }, r, READS_LOW), t: i };
      }),
    );
    const errWrapped = evaluateModel(wrapped, today).meanErrorPx;
    const errCorrected = evaluateModel(result!.model, today).meanErrorPx;
    expect(errWrapped).toBeGreaterThan(60);
    expect(errCorrected).toBeLessThan(15);
    // Refining the bare core instead has to learn the 1.25× scale from 5 dots, and can't.
    const collected = CHECK_TARGETS.flatMap((f) =>
      Array.from({ length: 35 }, (_, i) => {
        const target = { x: f.x * VW, y: f.y * VH };
        return { target, features: eyeFeatures({ x: target.x / zoom, y: target.y / zoom }, r, READS_LOW), t: i };
      }),
    );
    const naive = refineGazeModel(core, collected, { viewport: { width: VW, height: VH } }).model;
    expect(evaluateModel(naive, today).meanErrorPx).toBeGreaterThan(3 * errCorrected);
    ctx.sim.stop();
  });

  it('cancelling during the dots reports nothing', async () => {
    const ctx = setup({ mode: 'check', baseModel: baseModel(5) });
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await vi.advanceTimersByTimeAsync(3000);
    key('Escape');
    await expect(done).resolves.toBeNull();
    expect(ctx.checks).toEqual([]);
    expect(ctx.overlay.lastAccuracyCheck).toBeNull();
    ctx.sim.stop();
  });

  it('offers a full calibration when the saved model can’t read these eyes', async () => {
    const ctx = setup({ mode: 'check', baseModel: baseModel(8) });
    ctx.sim.reader.shift = [1, 1, 1, 1, 1]; // every prediction is rejected
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    await advanceUntil(() => ctx.root.dataset.phase === 'failed', 60_000, 250);
    expect(ctx.q('#' + ctx.q('.gr-cal-center:not([hidden]) [role="alert"]').getAttribute('aria-labelledby')).textContent).toBe(
      'The accuracy check didn’t work',
    );
    expect(ctx.q('.gr-cal-failed-text').textContent).toMatch(/couldn’t compare/);
    const retry = ctx.q<HTMLButtonElement>('[data-action="retry"]');
    expect(retry.textContent).toBe('Full calibration');
    expect(ctx.checks).toEqual([]);

    ctx.sim.reader.shift = [];
    retry.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.q('.gr-cal-next').textContent).toMatch(/13 dots/);
    const before = ctx.events.length;
    await startCalibration(ctx);
    expect(ctx.events.slice(before).find((e) => e.phase === 'point')?.total).toBe(STANDARD_TARGETS.length);
    ctx.overlay.cancel();
    await done;
    ctx.sim.stop();
  });

  it('falls back to a full calibration without a model to check', async () => {
    const ctx = setup({ mode: 'check', baseModel: null });
    const done = ctx.overlay.run();
    expect(ctx.q('.gr-cal-next').textContent).toMatch(/13 dots/);
    await startCalibration(ctx);
    expect(ctx.events.find((e) => e.phase === 'point')?.total).toBe(STANDARD_TARGETS.length);
    ctx.overlay.cancel();
    await done;
    ctx.sim.stop();
  });
});

describe('CalibrationOverlay — positioning coach', () => {
  it('coaches distance and direction from the live features', async () => {
    const ctx = setup();
    const { sim, q } = ctx;
    const done = ctx.overlay.run();
    const text = (): string => q('.gr-cal-status-text').textContent ?? '';
    const start = q<HTMLButtonElement>('[data-action="start"]');

    sim.reader.faceScale = 0.04;
    await vi.advanceTimersByTimeAsync(800);
    expect(text()).toMatch(/closer/);
    expect(start.disabled).toBe(true);
    expect(q('[data-state="bad"].gr-cal-check').textContent).toMatch(/Distance/);

    sim.reader.faceScale = 0.12;
    sim.reader.faceCenter = { x: 0.85, y: 0.45 }; // image-right = the reader's left
    await vi.advanceTimersByTimeAsync(800);
    expect(text()).toMatch(/to your right/);

    sim.reader.faceFound = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(text()).toMatch(/can’t see your face/);

    // With a face in view but an unresolved issue, "Start anyway" appears after a while.
    sim.reader.faceFound = true;
    await vi.advanceTimersByTimeAsync(8000);
    expect(start.disabled).toBe(false);
    expect(start.textContent).toBe('Start anyway');

    ctx.overlay.cancel();
    await done;
    ctx.sim.stop();
  });

  it('coaches the light from the camera side’s lighting numbers — no video element needed (the extension)', async () => {
    const ctx = setup(); // no `video`, like the extension: the camera lives in the offscreen document
    const { sim, q } = ctx;
    const done = ctx.overlay.run();
    const text = (): string => q('.gr-cal-status-text').textContent ?? '';
    const lightCheck = (): HTMLElement => ctx.shadow.querySelectorAll<HTMLElement>('.gr-cal-check')[3];
    const start = q<HTMLButtonElement>('[data-action="start"]');

    // Eyes ~2.5 stops under-exposed: judged from the whites of the eyes, not the skin.
    sim.reader.lighting = light({ scleraR: 0.07, scleraL: 0.075 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(text()).toMatch(/hard to see — more light on your face/);
    expect(lightCheck().dataset.state).toBe('bad');
    expect(lightCheck().textContent).toBe('!Light: needs attention');
    expect(start.disabled).toBe(true);

    sim.reader.lighting = light();
    await vi.advanceTimersByTimeAsync(2000);
    expect(text()).toMatch(/all set/);
    expect(lightCheck().dataset.state).toBe('ok');
    expect(lightCheck().textContent).toBe('✓Light: fine');
    expect(start.disabled).toBe(false);

    // A bright window behind the reader.
    sim.reader.lighting = light({ backlight: -1.6, bgLin: 0.9, bgClip: 0.4 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(text()).toMatch(/Bright light behind you puts your face in shadow/);
    expect(start.disabled).toBe(true);

    // Reflections on glasses: a tip, not a blocker.
    sim.reader.lighting = light({ glareR: 0.05, glareL: 0.03 });
    await vi.advanceTimersByTimeAsync(2500);
    expect(text()).toMatch(/^You’re all set\. One tip: .*reflections on your glasses/);
    expect(lightCheck().dataset.state).toBe('tip');
    expect(lightCheck().textContent).toBe('iLight: fine, with a tip');
    expect(start.disabled).toBe(false);
    expect(start.textContent).toBe('Start');
    expect(q('.gr-cal-preview').dataset.state).toBe('good');

    // A washed-out picture (clipped skin).
    sim.reader.lighting = light({ faceClip: 0.12 });
    await vi.advanceTimersByTimeAsync(2500);
    expect(text()).toMatch(/washed out/);

    // When the camera side stops measuring, there is no light advice without data.
    sim.reader.lighting = null;
    await vi.advanceTimersByTimeAsync(4000);
    expect(lightCheck().dataset.state).toBe('ok');
    expect(text()).toMatch(/all set/);

    ctx.overlay.cancel();
    await done;
    ctx.sim.stop();
  });

  it('asks for a moment while the light is changing (camera still adjusting)', async () => {
    const ctx = setup();
    const done = ctx.overlay.run();
    ctx.sim.reader.lighting = light();
    await vi.advanceTimersByTimeAsync(1200);
    // Exposure jumps by 1.5 stops: a lamp switched on, or auto-exposure hunting.
    ctx.sim.reader.lighting = light({ frameLin: 0.2 * 2 ** 1.5, faceLin: 0.18 * 2 ** 1.5 });
    await vi.advanceTimersByTimeAsync(800);
    expect(ctx.q('.gr-cal-status-text').textContent).toMatch(/light is changing/);
    expect(ctx.q<HTMLButtonElement>('[data-action="start"]').disabled).toBe(true);
    // Settled: the swing leaves the 3 s window.
    await vi.advanceTimersByTimeAsync(4000);
    expect(ctx.q('.gr-cal-status-text').textContent).toMatch(/all set/);
    ctx.overlay.cancel();
    await done;
    ctx.sim.stop();
  });

  it('waits patiently for a camera that sends nothing', async () => {
    const ctx = setup();
    ctx.sim.stop();
    const done = ctx.overlay.run();
    expect(ctx.q('.gr-cal-status-text').textContent).toMatch(/Waiting for the camera/);
    await vi.advanceTimersByTimeAsync(6000);
    expect(ctx.q('.gr-cal-status-text').textContent).toMatch(/another app/);
    expect(ctx.q<HTMLButtonElement>('[data-action="start"]').disabled).toBe(true);
    key('Escape');
    await expect(done).resolves.toBeNull();
  });
});

describe('CalibrationOverlay — lifecycle', () => {
  it('destroy() mid-run resolves null and removes every trace', async () => {
    const ctx = setup();
    const done = ctx.overlay.run();
    await startCalibration(ctx);
    ctx.overlay.destroy();
    expect(ctx.shadow.querySelector('.gr-cal')).toBeNull();
    expect(ctx.src.listenerCount).toBe(0);
    await expect(done).resolves.toBeNull();
    expect(ctx.events.at(-1)).toEqual({ phase: 'cancelled' });
    expect(vi.getTimerCount()).toBe(1); // only the simulated reader's interval is left
    ctx.sim.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => key('Escape')).not.toThrow();
    await expect(ctx.overlay.run()).resolves.toBeNull();
    ctx.overlay.destroy(); // idempotent
  });

  it('run() is idempotent while running and restartable after cancel', async () => {
    const ctx = setup();
    const a = ctx.overlay.run();
    expect(ctx.overlay.run()).toBe(a);
    expect(ctx.overlay.running).toBe(true);
    ctx.overlay.cancel();
    const b = ctx.overlay.run(); // requested while the first run is still unwinding
    await expect(a).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.root.hidden).toBe(false);
    expect(ctx.root.dataset.phase).toBe('positioning');
    expect(ctx.events.filter((e) => e.phase === 'start')).toHaveLength(2);
    ctx.overlay.cancel();
    await expect(b).resolves.toBeNull();
    expect(ctx.overlay.running).toBe(false);
    ctx.sim.stop();
  });

  it('a broken feature source fails the run cleanly instead of wedging it', async () => {
    const bus = createEventBus();
    const events: CalEvent[] = [];
    bus.on('calibration', (e) => events.push(e));
    const broken = new FakeSource();
    broken.onFrame = () => {
      throw new Error('port disconnected');
    };
    const overlay = new CalibrationOverlay({ features: broken, bus });
    overlay.mount(document.body);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(overlay.run()).resolves.toBeNull();
    errors.mockRestore();
    expect(events).toEqual([{ phase: 'failed', message: 'port disconnected' }]);
    expect(overlay.running).toBe(false);
    expect(document.querySelector<HTMLElement>('.gr-cal')?.hidden).toBe(true);
    overlay.destroy();
  });

  it('works mounted straight into the document and keeps focus inside', async () => {
    const bus = createEventBus();
    const src = new FakeSource();
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    const overlay = new CalibrationOverlay({ features: src, bus });
    overlay.mount(document.body);
    const sim = simulateReader(src, document, bus);
    const done = overlay.run();
    const root = document.querySelector<HTMLElement>('.gr-cal')!;
    expect(document.activeElement).toBe(root);

    await advanceUntil(() => !document.querySelector<HTMLButtonElement>('[data-action="start"]')!.disabled, 5000);
    // Tab cycles only through the overlay's visible buttons.
    const visible = [...root.querySelectorAll<HTMLButtonElement>('button')].filter((b) => !b.closest('[hidden]') && !b.disabled);
    expect(visible.map((b) => b.dataset.action)).toEqual(['cancel', 'start']);
    for (let i = 0; i < 4; i++) {
      key('Tab');
      expect(visible).toContain(document.activeElement);
    }
    key('Escape');
    await expect(done).resolves.toBeNull();
    expect(document.activeElement).toBe(outside); // focus handed back
    overlay.destroy();
    sim.stop();
  });
});

describe('CalibrationOverlay — keyboard', () => {
  it('inside a closed shadow root (the extension), Enter and Space on a focused button belong to the button', async () => {
    const bus = createEventBus();
    const events: CalEvent[] = [];
    bus.on('calibration', (e) => events.push(e));
    const src = new FakeSource();
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'closed' });
    const overlay = new CalibrationOverlay({ features: src, bus, random: rng(3) });
    overlay.mount(shadow);
    const sim = simulateReader(src, shadow, bus);
    const root = shadow.querySelector<HTMLElement>('.gr-cal')!;
    const visible = (action: string): HTMLButtonElement =>
      shadow.querySelector<HTMLButtonElement>(`.gr-cal-center:not([hidden]) [data-action="${action}"]`)!;
    const done = overlay.run();
    const start = shadow.querySelector<HTMLButtonElement>('[data-action="start"]')!;
    await advanceUntil(() => !start.disabled, 5000);

    // Enter on the focused Cancel button must activate Cancel, not start the calibration.
    const cancel = visible('cancel');
    cancel.focus();
    const enter = key('Enter', cancel);
    expect(enter.defaultPrevented).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(root.dataset.phase).toBe('positioning');

    // Enter anywhere else starts.
    root.focus();
    key('Enter', root);
    await advanceUntil(() => root.dataset.phase === 'targets', 2000, 20);

    // Pause, then Space on the pause card's Cancel button is that button's, not a resume.
    key(' ', root);
    expect(root.dataset.paused).toBe('user');
    const pauseCancel = shadow.querySelector<HTMLButtonElement>('.gr-cal-pause [data-action="cancel"]')!;
    pauseCancel.focus();
    const space = key(' ', pauseCancel);
    expect(space.defaultPrevented).toBe(false);
    expect(root.dataset.paused).toBe('user');
    expect(events.at(-1)?.message).toBe('paused');

    overlay.cancel();
    await expect(done).resolves.toBeNull();
    overlay.destroy();
    sim.stop();
  });

  it('keeps keyboard scrolling from moving the page behind it', async () => {
    const ctx = setup();
    const done = ctx.overlay.run();
    await vi.advanceTimersByTimeAsync(300);
    for (const k of ['PageDown', 'ArrowDown', 'End', ' ', 'Home']) expect(key(k, ctx.root).defaultPrevented).toBe(true);
    expect(key('x', ctx.root).defaultPrevented).toBe(false);

    // A card that overflows a short window may still scroll itself.
    const center = ctx.shadow.querySelector<HTMLElement>('.gr-cal-center:not([hidden])')!;
    Object.defineProperty(center, 'scrollHeight', { configurable: true, value: 900 });
    Object.defineProperty(center, 'clientHeight', { configurable: true, value: 400 });
    const cancel = center.querySelector<HTMLButtonElement>('[data-action="cancel"]')!;
    cancel.focus();
    expect(key('ArrowDown', cancel).defaultPrevented).toBe(false);
    expect(key('PageDown', cancel).defaultPrevented).toBe(false);

    ctx.overlay.cancel();
    await done;
    ctx.sim.stop();
  });

  it('scrolls an overflowing card so the focused button is on screen', async () => {
    const ctx = setup();
    const done = ctx.overlay.run();
    const start = ctx.q<HTMLButtonElement>('[data-action="start"]');
    const center = start.closest<HTMLElement>('.gr-cal-center')!;
    // A 400 px tall window: the card's action row sits below the fold.
    let scrollTop = 0;
    Object.defineProperty(center, 'scrollHeight', { configurable: true, value: 640 });
    Object.defineProperty(center, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(center, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });
    const rect = (top: number, height: number): DOMRect => DOMRect.fromRect({ x: 0, y: top, width: 100, height });
    center.getBoundingClientRect = () => rect(0, 400);
    start.getBoundingClientRect = () => rect(520 - scrollTop, 44);

    await advanceUntil(() => !start.disabled, 5000);
    expect(ctx.shadow.activeElement).toBe(start); // focus moves to Start once it lights up…
    expect(scrollTop).toBeGreaterThanOrEqual(564 - 400); // …and the card scrolls to show it
    expect(start.getBoundingClientRect().bottom).toBeLessThanOrEqual(400);

    ctx.overlay.cancel();
    await done;
    ctx.sim.stop();
  });
});

describe('assessPosition', () => {
  const good: PositionMetrics = {
    faceFound: true,
    faceScale: 0.12,
    faceCenter: { x: 0.5, y: 0.45 },
    yaw: 0,
    pitch: 0,
    quality: 0.9,
    lighting: [],
  };

  it('is happy with a well-placed face', () => {
    expect(assessPosition(good)).toEqual({ issue: null, tip: null, checks: { face: true, distance: true, center: true, light: true } });
    // Light that isn't measured (no lighting numbers from the camera side) is not a problem either.
    expect(assessPosition({ ...good, lighting: null })).toEqual(assessPosition(good));
  });

  it('turns lighting flags into issues and tips', () => {
    const issue = (lighting: PositionMetrics['lighting']) => assessPosition({ ...good, lighting });
    expect(issue(['dark']).issue).toBe('too-dark');
    expect(issue(['dark']).checks.light).toBe(false);
    expect(issue(['backlit']).issue).toBe('backlit');
    expect(issue(['overexposed']).issue).toBe('overexposed');
    expect(issue(['unstable']).issue).toBe('light-changing');
    // Backlight explains dark eyes (and what to do about it) better than "add light".
    expect(issue(['dark', 'backlit']).issue).toBe('backlit');
    // While the light is changing the other flags may be the camera still adjusting.
    expect(issue(['dark', 'unstable']).issue).toBe('light-changing');
    // Reflections and side light are advice: no issue, the light check still passes.
    expect(issue(['glare'])).toEqual({ issue: null, tip: 'glare', checks: { face: true, distance: true, center: true, light: true } });
    expect(issue(['side-lit'])).toMatchObject({ issue: null, tip: 'side-lit' });
    expect(issue(['glare', 'side-lit']).tip).toBe('glare');
    expect(issue(['side-lit', 'dark'])).toMatchObject({ issue: 'too-dark', tip: 'side-lit' });
  });

  it('gives directions from the reader’s point of view (the image is not mirrored)', () => {
    expect(assessPosition({ ...good, faceCenter: { x: 0.8, y: 0.45 } }).issue).toBe('move-right');
    expect(assessPosition({ ...good, faceCenter: { x: 0.2, y: 0.45 } }).issue).toBe('move-left');
    expect(assessPosition({ ...good, faceCenter: { x: 0.5, y: 0.1 } }).issue).toBe('move-down');
    expect(assessPosition({ ...good, faceCenter: { x: 0.5, y: 0.85 } }).issue).toBe('move-up');
  });

  it('prioritizes the most fundamental problem', () => {
    const t = DEFAULT_POSITION_THRESHOLDS;
    expect(assessPosition({ ...good, faceScale: t.minFaceScale / 2 }).issue).toBe('too-far');
    expect(assessPosition({ ...good, faceScale: t.maxFaceScale * 1.5 }).issue).toBe('too-close');
    expect(assessPosition({ ...good, yaw: 0.6, faceScale: 0.03 }).issue).toBe('not-facing');
    expect(assessPosition({ ...good, lighting: ['dark'] }).issue).toBe('too-dark');
    expect(assessPosition({ ...good, lighting: null, quality: 0.2 }).issue).toBe('unsteady');
    expect(assessPosition({ ...good, lighting: ['dark'], quality: 0.2 }).issue).toBe('too-dark');
    expect(assessPosition({ ...good, lighting: ['dark'], faceCenter: { x: 0.9, y: 0.45 } }).issue).toBe('move-right');
    const both = assessPosition({ ...good, faceScale: 0.03, lighting: ['dark'] });
    expect(both.checks).toEqual({ face: true, distance: false, center: true, light: false });
  });

  it('treats missing or non-finite data as no face', () => {
    expect(assessPosition({ ...good, faceFound: false }).issue).toBe('no-face');
    expect(assessPosition({ ...good, faceScale: Number.NaN }).issue).toBe('no-face');
    expect(assessPosition({ ...good, faceCenter: { x: Infinity, y: 0.5 } }).checks.face).toBe(false);
    expect(assessPosition({ ...good, faceFound: false, lighting: ['glare'] }).tip).toBeNull();
  });
});

describe('describeOffset', () => {
  it('puts a vertical offset in plain words (positive = gaze reads low)', () => {
    expect(describeOffset(2.1)).toEqual({
      text: 'about 2 lines low',
      onTarget: false,
      worthCorrecting: true,
      big: true,
      vertical: 'low',
      horizontal: null,
      spread: false,
    });
    expect(describeOffset(-1.2).text).toBe('about 1 line high');
    expect(describeOffset(2.85).text).toBe('about 3 lines low');
    expect(describeOffset(0.6)).toMatchObject({ text: 'about half a line low', onTarget: false, worthCorrecting: false });
    expect(describeOffset(0.8)).toMatchObject({ text: 'about 1 line low', worthCorrecting: true });
    expect(describeOffset(-0.3)).toMatchObject({ text: 'within half a line', onTarget: true, worthCorrecting: false });
  });

  it('mentions a horizontal offset as a fraction of the screen width', () => {
    expect(describeOffset(0.2, 0.1)).toMatchObject({ text: 'a bit to the right', onTarget: false, worthCorrecting: true, horizontal: 'right' });
    expect(describeOffset(-3.4, -0.2).text).toBe('about 3 lines high and to the left');
    expect(describeOffset(0, 0.03)).toMatchObject({ onTarget: true, horizontal: null });
  });

  it('is honest about garbage', () => {
    expect(describeOffset(Number.NaN)).toMatchObject({ text: 'unknown', onTarget: false, worthCorrecting: false });
    expect(describeOffset(1.6, Number.NaN).text).toBe('about 2 lines low');
    expect(describeOffset(0.2, 0, Number.NaN)).toMatchObject({ onTarget: true, spread: false }); // worst dot unknown: the mean decides
  });

  it('judges the worst dot too: a scale error cancels in the mean (regression: "On target" at ±2 lines)', () => {
    // Dots ±0.93 lines off (a 10 % gain at 30 px lines): still on target.
    expect(describeOffset(0, 0, 0.93)).toMatchObject({ onTarget: true, text: 'within half a line' });
    // ±1.2 lines: not on target, but not worth correcting either ("Close enough").
    expect(describeOffset(0.05, 0, 1.2)).toMatchObject({
      onTarget: false,
      worthCorrecting: false,
      spread: true,
      text: 'up to 1 line off near the top and bottom',
    });
    expect(describeOffset(0, 0, 1.87)).toMatchObject({ worthCorrecting: true, big: false, text: 'up to 2 lines off near the top and bottom' });
    expect(describeOffset(0, 0, 2.8)).toMatchObject({ worthCorrecting: true, big: true, text: 'up to 3 lines off near the top and bottom' });
    // A shared offset with dots close to it is worded by the offset alone…
    expect(describeOffset(2.1, 0, 2.4)).toMatchObject({ text: 'about 2 lines low', spread: false });
    // …but dots a line or more beyond it are mentioned.
    expect(describeOffset(0.6, 0, 2.5).text).toBe('about half a line low, and up to 3 lines off near the top and bottom');
  });
});

describe('offsetVerdict', () => {
  it('orders the badges: on target, close enough, drifted, slightly off', () => {
    expect(offsetVerdict(0.2)).toMatchObject({ badge: 'On target', quality: 'excellent' });
    expect(offsetVerdict(0.6)).toMatchObject({ badge: 'Close enough', quality: 'good' });
    expect(offsetVerdict(1.4)).toMatchObject({ badge: 'Slightly off', quality: 'fair' });
    expect(offsetVerdict(2.2)).toMatchObject({ badge: 'Drifted', quality: 'poor' });
    expect(offsetVerdict(0.2, 0.15)).toMatchObject({ badge: 'Drifted' });
    expect(offsetVerdict(0.2, 0.08)).toMatchObject({ badge: 'Slightly off' });
    expect(offsetVerdict(0, 0, 1.87)).toMatchObject({ badge: 'Slightly off' });
    expect(offsetVerdict(0, 0, 2.8)).toMatchObject({ badge: 'Drifted' });
  });
});

describe('describeLightingChange', () => {
  const ref = signatureOf(light());

  it('stays quiet when the light is the same', () => {
    const same = describeLightingChange(ref, signatureOf(light()));
    expect(same.changed).toBe(false);
    expect(same.text).toBeNull();
    expect(same.distance).toBeCloseTo(0, 6);
  });

  it('names what changed, in words the reader can act on', () => {
    // The whole room brighter or dimmer: the eyes change, the ratio to the background doesn't.
    const brighter = describeLightingChange(ref, signatureOf(light({ scleraR: 0.8, scleraL: 0.8 })));
    expect(brighter).toMatchObject({ changed: true, dominant: 'sclera', text: 'your eyes are more brightly lit now' });
    expect(brighter.distance).toBeCloseTo(1 / 0.75, 2); // one stop, tolerance 0.75 stop
    expect(describeLightingChange(ref, signatureOf(light({ scleraR: 0.15, scleraL: 0.15 }))).text).toBe('your eyes are more dimly lit now');
    const window = describeLightingChange(ref, signatureOf(light({ backlight: -1.5, bgLin: 1, bgClip: 0.3 })));
    expect(window).toMatchObject({ changed: true, dominant: 'backlight', text: 'there’s more light behind you now' });
    expect(describeLightingChange(ref, signatureOf(light({ side: 1.3 }))).text).toBe('more of the light comes from one side now');
    expect(describeLightingChange(ref, signatureOf(light({ glareR: 0.06 }))).text).toBe('there are more reflections on your glasses or eyes now');
  });
});
